import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { toast } from "sonner";
import {
  currentMonitor,
  getCurrentWindow,
  LogicalSize,
} from "@tauri-apps/api/window";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleDollarSign,
  Coins,
  Copy,
  Database,
  Link2,
  Loader2,
  Percent,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Search,
  Terminal,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { EmptyState } from "@/components/EmptyState";
import {
  useApiKeys,
  useBreakerStates,
  useChannels,
  useLogs,
  useLogModels,
  useStats,
  useSettings,
  useUnpricedModels,
} from "@/hooks/use-gateway";
import {
  cacheHitRate,
  durationColor,
  fmtFullTime,
  fmtK,
  fmtMs,
  fmtTime,
  fmtUsd,
  fmtYuan,
  latencyColor,
  matchPrice,
  parseAttempts,
  rangeFromTs,
  speedColor,
  TIME_RANGE_LABELS,
  type TimeRange,
} from "@/lib/format";
import type {
  AttemptEntry,
  Channel,
  LogDetail,
  LogFilter,
  LogItem,
} from "@/lib/types";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useAppStore } from "@/stores/app-store";
import { ProtocolBadge } from "@/components/ProtocolBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 50;
// 时间分段(无"全部":总览默认今天起)
const DASH_RANGES: TimeRange[] = ["today", "3d", "7d", "30d"];
// 纵向滚动条宽度(与 index.css 的 ::-webkit-scrollbar width 一致)
const SCROLLBAR_WIDTH = 10;
// 窗口最小宽度的下限:窗口配置里 minWidth 的初始值,实测值只在其上抬高
const BASELINE_MIN_WIDTH = 1000;
// setMinSize 需要同时给高度:与 tauri.conf.json 的 minHeight 保持一致,
// 传 0 会把配置的最小高度覆盖丢失
const WINDOW_MIN_HEIGHT = 680;
// minWidth 抖动消除:需求宽度变化小于该值时不重设 minWidth(见 apply 注释)。
// 取滚动条宽度的 2 倍:滚动条出现/消失正好造成 ±10px 抖动,必须完全吸收
const NEED_HYSTERESIS = SCROLLBAR_WIDTH * 2;
// 拖拽中不服坐标:用户正在拖窗口边缘时不下发 setSize(与手互相拉扯 = 闪烁),
// 松手后由 RO/MO/兜底定时器触发重算补齐。窗口卡在 minWidth 时 WM 仍会派发
// WM_SIZING(Windows),Rust 侧无法区分,只能由前端用时间阈值启发式判定
const RESIZE_QUIET_MS = 150;

/**
 * 按内容实测宽度动态设置窗口最小宽度,保证横向滚动条不出现、统计卡不换行。
 *
 * 为什么不能写死常量:表格内容宽度由数据决定(模型名/渠道名/密钥名长度、
 * 是否带重试角标、客户端 UA 长短都随数据变化),加上系统缩放与字体渲染
 * 差异,同一份数据在不同机器上的像素宽度并不相同。写死值必然在某台机器
 * 上偏差——之前手工累加各列 min-w 就是这么翻车的。统计卡同理:数值/提示
 * 文案宽度随数据变,换行临界点也是实测出来的。
 *
 * 为什么不只量一个东西:表格是 w-max + min-w-full——窗口宽时表格被 min-w-full
 * 撑到容器宽,offsetWidth/scrollWidth 都等于容器宽,量不出"内容到底需要多宽",
 * 此时需要离屏克隆(width:max-content)量出真实内容宽;窗口窄时表格已经溢出,
 * container.scrollWidth 就是精确所需(真字体、真缩放、真渲染,克隆量小的场景
 * ——异步字体未就绪按回退字体度量、亚像素舍入——它统统免疫)。两者取大。
 *
 * 算法:
 *  1. 表格内容宽度 = max(离屏克隆实测, 溢出时的 container.scrollWidth 实时值);
 *     统计卡内容宽度 = 克隆按"每列 max-content"模板量出的四卡一行自然宽度;
 *  2. 界面开销 = 窗口内宽 − 各自容器 clientWidth(侧栏 + 各层 padding +
 *     卡片边框 + 纵向滚动条),实测而非硬编码,布局改了自动跟随;
 *  3. 纵向滚动条按"始终存在"计入:列表短时没滚动条会少算约 10px,等翻页
 *     内容变多滚动条一出现就正好溢出——最容易漏的边界;
 *  4. 屏幕(逻辑宽)放得下的约束才参与取大:最终 minWidth =
 *     max(配置下限, 表格需求, 统计卡需求)。放不下(小屏/高缩放)的约束
 *     不抬高 minWidth——把最小宽度夹到屏幕宽会让窗口铺满整屏且拖不小
 *     (实测翻车),此时溢出交给横向滚动条(表格 w-max 保证列不被压缩);
 *  5. 若当前窗口已比所需窄且放得下(滚动条已出现),顺手撑到刚好够,
 *     消除滚动条;放不下时不动窗口。
 *
 * 双保险(纯 CSS,不依赖 JS 链路成功):表格 w-max min-w-full 保证列永不被
 * 压缩重叠;统计卡固定 grid-cols-4 保证四卡永不换行(窄时 truncate 收缩)。
 * JS 实测的 minWidth 只是让它们"显示得舒展",失败也不破坏布局约束。
 */
function useMinWindowWidthForContent(
  tableRef: React.RefObject<HTMLTableElement | null>,
  statsRef: React.RefObject<HTMLDivElement | null>,
  /** 表格是否已渲染:加载中/空态时表格不在 DOM,无法测量与观察 */
  enabled: boolean,
) {
  // 注意依赖数组:必须包含 enabled。组件首次挂载时日志还在加载,<table> 尚未
  // 渲染(tableRef.current 为 null);若只依赖 tableRef,effect 不会重跑,测量与
  // ResizeObserver/MutationObserver 永远不会注册,动态 minWidth 从冷启动起就
  // 失效(窗口停在配置最小宽,列内容被挤压重叠)。数据到达表格挂载、或翻页后
  // 空态导致表格卸载时,都会重建/清理整套观察逻辑。
  useEffect(() => {
    const table = tableRef.current;
    const stats = statsRef.current;
    if (!enabled || !table) return;
    let timer: number | undefined;
    let disposed = false;
    // 上次已下发的值:内容没变时不重复 IPC(ResizeObserver 会频繁触发)
    let lastApplied = 0;
    // 最近一次收到窗口 resize 事件的时间:判断用户是否正在拖拽(见 apply)。
    // 事件来自 Tauri onResized,拖拽过程中会连续派发
    let lastWinResizeAt = 0;
    // 拖拽落定:最后一次 resize 事件后静默期结束,补跑一次 apply——
    // 拖拽中被静默期跳过的"撑窗口"必须在松手后有人接手,否则漏掉
    let dragSettleTimer: number | undefined;
    const unlistenResize = getCurrentWindow().onResized(() => {
      lastWinResizeAt = Date.now();
      if (dragSettleTimer) window.clearTimeout(dragSettleTimer);
      dragSettleTimer = window.setTimeout(schedule, RESIZE_QUIET_MS + 50);
    });

    /** 离屏测量:克隆 el,在 width:max-content + extraCss 下量自然内容宽度 */
    const measureCloneWidth = (el: HTMLElement, extraCss: string): number => {
      const clone = el.cloneNode(true) as HTMLElement;
      // 绝对定位 + 不可见:参与布局(能算出宽度)但不显示、不占位、不触发滚动
      // min-width:0 必须保留:表格克隆会继承 min-w-full,在宽窗口下被撑到容器宽
      // → 量出的"内容宽"随窗口变宽而变大,与 min-w-full 相互抬升形成反馈循环
      // (窗口每测一次就被撑大一次)。归零后量到的才是纯内容宽
      clone.style.cssText = `position:absolute;top:0;left:-99999px;width:max-content;min-width:0;visibility:hidden;pointer-events:none;${extraCss}`;
      // 挂在原节点父级上,继承同一套字体与字号,测量结果才准确
      const host = el.parentElement ?? document.body;
      host.appendChild(clone);
      const width = clone.offsetWidth;
      clone.remove();
      return width;
    };

    /** 内容所需宽度:克隆测量与实时溢出值取大(后者免疫字体/舍入误差) */
    const measureContentWidth = (container: HTMLElement): number => {
      // 表格已溢出时 scrollWidth 就是精确所需;未溢出时等于容器宽(不可用)
      const overflowWidth =
        container.scrollWidth > container.clientWidth + 1
          ? container.scrollWidth
          : 0;
      return Math.max(measureCloneWidth(table, ""), overflowWidth);
    };

    /** 统计卡"四卡一行不截断"的自然宽度:1fr 列改按 max-content 参与测量 */
    const measureStatsWidth = (): number => {
      if (!stats || !stats.isConnected) return 0;
      // 列数从计算样式读,不写死 4:将来调整列数,测量自动跟随
      const cols =
        getComputedStyle(stats).gridTemplateColumns.split(" ").length || 4;
      return measureCloneWidth(
        stats,
        `grid-template-columns:repeat(${cols},max-content);`,
      );
    };

    const apply = async () => {
      if (disposed) return;
      const container = table.parentElement;
      if (!container) return;
      const contentWidth = measureContentWidth(container);
      if (!contentWidth) return;

      const win = getCurrentWindow();
      const scaleFactor = await win.scaleFactor();
      const innerWidth = (await win.innerSize()).toLogical(scaleFactor).width;
      if (!innerWidth) return;

      // 表格内容一行完整显示所需的宽度。纵向滚动条按"始终存在"计入
      // (列表通常有滚动条;没有时这 10px 只是小余量),不读实时滚动条状态——
      // 正是"滚动条出现 → 重算 → minWidth 变化 → 滚动条消失 → 再重算"的
      // 翻转反馈造成了拖拽时的 minWidth 抖动,必须与滚动条状态解耦
      const overhead = Math.max(0, innerWidth - container.clientWidth);
      const tableNeed =
        Math.ceil(contentWidth + overhead) + SCROLLBAR_WIDTH + 1;

      // 统计卡四卡一行不截断(换行已由固定 4 列 CSS 禁掉,这是"不挤压")
      let statsNeed = 0;
      if (stats?.isConnected) {
        const statsOverhead = Math.max(0, innerWidth - stats.clientWidth);
        statsNeed = Math.ceil(measureStatsWidth() + statsOverhead) + 1;
      }

      // 屏幕可用宽度(留 16px 边框余量)。currentMonitor 是模块级函数
      // (非 Window 实例方法),探测失败时按"放得下"处理
      const monitor = await currentMonitor().catch(() => null);
      const screenCap = monitor
        ? Math.floor(monitor.size.width / monitor.scaleFactor) - 16
        : 0;
      // 各约束独立判断"屏幕放得下":放得下才参与抬高 minWidth,取最大者;
      // 放不下(小屏/高缩放)的约束放弃——千万不能把 minWidth 顶到屏幕宽,
      // 那会让窗口铺满整屏且拖不小(实测翻车)。放不下的后果:表格出横向
      // 滚动条(w-max 保证列不压缩)、统计卡等比收缩(truncate 截断),
      // 物理放不下时"保完整"只能让位给"保可用"
      const candidates = [BASELINE_MIN_WIDTH];
      for (const need of [tableNeed, statsNeed]) {
        if (need > 0 && (screenCap <= 0 || need <= screenCap)) {
          candidates.push(need);
        }
      }
      const rawNeed = Math.max(...candidates);

      // 抖动消除(迟滞):需求宽度小幅波动(±10px 量级,典型来源是测量与
      // 布局的亚像素舍入)时不重设 minWidth。只允许"明显变宽"或"明显变窄"
      // 才下发,窗口边界保持静止,拖到最小宽度时就不会再有宽度来回跳
      let need = lastApplied;
      if (
        lastApplied === 0 ||
        rawNeed > lastApplied ||
        lastApplied - rawNeed > NEED_HYSTERESIS
      ) {
        need = rawNeed;
      }

      if (need !== lastApplied) {
        lastApplied = need;
        try {
          // 高度传 minHeight(680)而不是 0:setMinSize 整组覆盖,传 0 会把
          // tauri.conf.json 里的 minHeight 丢掉,窗口可被拖到任意矮
          await win.setMinSize(new LogicalSize(need, WINDOW_MIN_HEIGHT));
        } catch {
          // 权限缺失或窗口已销毁:忽略,不影响页面其余功能
          return;
        }
      }
      // 已经比所需窄:撑到刚好够,把已经出现的横向滚动条消掉。
      // 静默期不服坐标:用户正在拖窗口边缘时 setSize 会与手互相拉扯(闪烁),
      // 松手后由 RO/MO 触发重算补齐;窗口已达到 minWidth 时也无须再撑
      if (innerWidth < need && need - innerWidth > 2) {
        if (Date.now() - lastWinResizeAt < RESIZE_QUIET_MS) return;
        try {
          const h = (await win.innerSize()).toLogical(await win.scaleFactor()).height;
          await win.setSize(new LogicalSize(need, h));
        } catch {
          // 同上
        }
      }
    };

    // 内容变化(翻页/筛选/行内数据变化)后重算;50ms 抖动合并避免频繁 IPC
    const schedule = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => void apply(), 50);
    };

    schedule();
    const ro = new ResizeObserver(schedule);
    ro.observe(table);
    if (stats) ro.observe(stats);
    // 行内文字变化也要重算(例如重试角标、模型名/统计数值变化),ResizeObserver 捕捉不到
    const mo = new MutationObserver(schedule);
    mo.observe(table, { childList: true, subtree: true, characterData: true });
    if (stats) {
      mo.observe(stats, { childList: true, subtree: true, characterData: true });
    }
    // 异步字体加载完成后用真字体重测:字体未就绪时克隆按回退字体度量,宽度偏小,
    // 而 RO/MO 都感知不到"字体度量变化"——首轮 minWidth 偏低的主要来源
    document.fonts?.ready.then(() => schedule());
    // 兜底二次校准:首测可能仍早于布局最终稳定(图片图标加载、滚动条出现等),
    // 350ms 后经同一抖动链再测一遍;apply 内 lastApplied 去重,值没变不会重复 IPC
    const secondPass = window.setTimeout(schedule, 350);

    return () => {
      disposed = true;
      if (timer) window.clearTimeout(timer);
      window.clearTimeout(secondPass);
      if (dragSettleTimer) window.clearTimeout(dragSettleTimer);
      ro.disconnect();
      mo.disconnect();
      unlistenResize
        .then((f) => f())
        .catch(() => {});
    };
  }, [tableRef, statsRef, enabled]);
}

// ---------- 汇总卡:左图标色块 + 右标签/数值(同色)/小字提示 ----------

function StatCard({
  icon: Icon,
  tile,
  valueClass,
  label,
  value,
  hint,
}: {
  icon: typeof Link2;
  tile: string;
  valueClass: string;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <Card className="py-4 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md">
      <CardContent className="flex items-center gap-3 px-4 py-0">
        <div
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg shadow-2xs",
            tile,
          )}
        >
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-xs text-muted-foreground">{label}</div>
          <div
            className={cn(
              "truncate text-xl font-semibold tabular-nums leading-tight tracking-tight",
              valueClass,
            )}
          >
            <motion.span
              key={value}
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="inline-block"
            >
              {value}
            </motion.span>
          </div>
          <div className="truncate text-xs text-muted-foreground/80">{hint}</div>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- 详情弹窗 ----------

function prettyBody(raw: string | null): string {
  if (!raw) return "(未保存)";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function Kv({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="shrink-0 text-muted-foreground">{k}</span>
      <span className="break-all text-right font-medium">{v}</span>
    </div>
  );
}

function KvBox({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2 shadow-2xs">
      <div className="text-xs text-muted-foreground">{k}</div>
      <div className="font-mono text-sm font-semibold tabular-nums text-foreground">{v}</div>
    </div>
  );
}

function highlightJson(json: string): React.ReactNode {
  const tokenRegex =
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|[{}[\],:])/g;

  let lastIndex = 0;
  const elements: React.ReactNode[] = [];
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(json)) !== null) {
    if (match.index > lastIndex) {
      elements.push(json.slice(lastIndex, match.index));
    }
    const token = match[0];
    const key = match.index;

    if (token.endsWith(":")) {
      const colonIdx = token.lastIndexOf(":");
      const keyStr = token.slice(0, colonIdx);
      elements.push(
        <span key={key} className="font-semibold text-sky-600 dark:text-sky-400">
          {keyStr}
        </span>,
      );
      elements.push(
        <span key={`${key}-colon`} className="text-muted-foreground/60">
          :
        </span>,
      );
    } else if (token.startsWith('"')) {
      elements.push(
        <span key={key} className="text-emerald-600 dark:text-emerald-400">
          {token}
        </span>,
      );
    } else if (token === "true" || token === "false") {
      elements.push(
        <span
          key={key}
          className="font-semibold text-violet-600 dark:text-violet-400"
        >
          {token}
        </span>,
      );
    } else if (token === "null") {
      elements.push(
        <span key={key} className="font-mono text-rose-500/90 dark:text-rose-400">
          {token}
        </span>,
      );
    } else if (/^-?\d/.test(token)) {
      elements.push(
        <span key={key} className="font-mono text-amber-600 dark:text-amber-400">
          {token}
        </span>,
      );
    } else {
      elements.push(
        <span key={key} className="font-medium text-muted-foreground/60">
          {token}
        </span>,
      );
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < json.length) {
    elements.push(json.slice(lastIndex));
  }

  return elements.length > 0 ? elements : json;
}

function PreBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success("已复制到剪贴板");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("复制失败");
    }
  };

  const highlighted = useMemo(() => {
    if (!text || text === "—") return text;
    // 超长报文(长上下文可达数百 KB)高亮会生成数万 span 拖慢弹窗渲染:超限退纯文本
    if (text.length > 200_000) return text;
    try {
      return highlightJson(text);
    } catch {
      return text;
    }
  }, [text]);

  return (
    <div className="group relative rounded-xl border border-border/80 bg-muted/30 transition-all focus-within:border-primary/40">
      <div className="absolute right-2.5 top-2.5 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          onClick={handleCopy}
          className="inline-flex items-center gap-1 rounded-md border bg-background/90 px-2 py-1 text-[11px] font-medium text-muted-foreground shadow-2xs backdrop-blur-xs transition-colors hover:bg-accent hover:text-foreground active:scale-95"
          title="复制内容"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-success" />
              <span className="text-success">已复制</span>
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              <span>复制</span>
            </>
          )}
        </button>
      </div>
      <pre className="max-h-64 overflow-auto p-3.5 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all select-text text-foreground/90">
        {highlighted}
      </pre>
    </div>
  );
}

function LogDetailDialog({
  id,
  onClose,
}: {
  id: number | null;
  onClose: () => void;
}) {
  const { data: d } = useQuery({
    queryKey: ["logDetail", id],
    queryFn: () => api.getRequestLog(id!),
    enabled: id != null,
  });
  const { data: prices } = useQuery({
    queryKey: ["prices"],
    queryFn: api.listModelPrices,
  });
  const { data: settings } = useSettings();
  const [copiedCurl, setCopiedCurl] = useState(false);

  const detail: LogDetail | null | undefined = d;
  const attempts: AttemptEntry[] =
    detail ? (parseAttempts(detail.attempts) as AttemptEntry[]) : [];
  const price =
    detail && prices
      ? matchPrice(prices, detail.model) ??
        (detail.mappedModel ? matchPrice(prices, detail.mappedModel) : undefined)
      : undefined;
  // 行内币种决定单位与符号:美元定价条目按微美元展示,不与人民币换算
  const isUsd = detail?.currency === "usd";
  const unit = isUsd ? "$/M" : "元/M";
  const fmtCost = isUsd ? fmtUsd : fmtYuan;
  // 计费明细乘数:按行内币种取对应价格组(与后端 resolve_pricing 一致)
  const priceOf = (k: "input" | "output" | "cacheRead" | "cacheWrite"): number =>
    isUsd ? (price?.[`${k}Usd` as const] ?? 0) : (price?.[k] ?? 0);

  return (
    <Dialog open={id != null} onOpenChange={(o) => !o && onClose()}>
      {/* flex 列布局 + overflow-hidden:标题/右上角关闭按钮固定于弹窗顶部,
          仅下方内容区滚动(与 KeyDialog 同一滚动态势范式) */}
      <DialogContent className="flex max-h-[85vh] max-w-4xl flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>请求详情</DialogTitle>
          <DialogDescription>
            {detail
              ? `#${detail.id} · ${fmtFullTime(detail.ts)} · ${detail.model}`
              : "加载中…"}
          </DialogDescription>
        </DialogHeader>
        {/* 滚动容器:min-h-0 允许在 flex 列中收缩,滚动条用 -mr-2/pr-2 贴弹窗内缘 */}
        <div className="-mr-2 min-h-0 flex-1 overflow-y-auto pr-2">
        {detail && (
          <div className="grid gap-5">
            <div className="space-y-2">
              <h4 className="text-sm font-semibold">基本信息</h4>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
                <Kv
                  k="协议流向"
                  v={
                    <span className="inline-flex items-center gap-1.5">
                      <ProtocolBadge protocol={detail.protocolIn} />
                      <span className="text-muted-foreground/60">→</span>
                      {detail.protocolUp ? (
                        <ProtocolBadge protocol={detail.protocolUp} />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </span>
                  }
                />
                <Kv k="模型映射" v={detail.mappedModel ? `${detail.model} → ${detail.mappedModel}` : "无"} />
                <Kv k="渠道" v={detail.channelName ?? "—"} />
                <Kv k="密钥" v={detail.keyName ?? "—"} />
                <Kv k="客户端" v={detail.client ?? "—"} />
                <Kv k="流式" v={detail.isStream ? "是" : "否"} />
                <Kv k="首字延迟" v={detail.isStream ? fmtMs(detail.ttftMs) : "—"} />
                <Kv k="总耗时" v={fmtMs(detail.totalMs)} />
                {detail.error && <Kv k="错误" v={detail.error} />}
              </div>
            </div>

            <div className="space-y-2">
              <h4 className="text-sm font-semibold">Token 用量</h4>
              <div className="grid grid-cols-4 gap-3 text-sm">
                <KvBox k="输入" v={fmtK(detail.promptTokens)} />
                <KvBox k="输出" v={fmtK(detail.completionTokens)} />
                <KvBox k="缓存读" v={fmtK(detail.cacheRead)} />
                <KvBox k="缓存写" v={fmtK(detail.cacheWrite)} />
              </div>
              {detail.estimated && (
                <p className="text-xs text-warning">
                  usage 为本地估算(cl100k),计费结果以 ~ 前缀标识
                </p>
              )}
            </div>

            <div className="space-y-2">
              <h4 className="text-sm font-semibold">计费明细</h4>
              {detail.cost != null && price ? (
                <div className="rounded-md border bg-muted/40 p-3 font-mono text-xs leading-6">
                  {/* 按行内币种取对应价格组:与实际计费口径一致 */}
                  <div>
                    输入{" "}
                    {fmtK(
                      Math.max(
                        0,
                        detail.promptTokens - detail.cacheRead - detail.cacheWrite,
                      ),
                    )}{" "}
                    × {priceOf("input")} {unit}
                  </div>
                  <div>
                    缓存读 {fmtK(detail.cacheRead)} × {priceOf("cacheRead")} {unit} + 缓存写{" "}
                    {fmtK(detail.cacheWrite)} × {priceOf("cacheWrite")} {unit}
                  </div>
                  <div>
                    输出 {fmtK(detail.completionTokens)} × {priceOf("output")} {unit}
                  </div>
                  {detail.rate != null && detail.rate !== 1 && (
                    <div className="text-amber-600 dark:text-amber-400">
                      渠道倍率 × {detail.rate}
                    </div>
                  )}
                  <div className="font-semibold">
                    = {fmtCost(detail.cost)}(命中定价 {price.pattern})
                  </div>
                </div>
              ) : detail.cost != null ? (
                <p className="text-sm">{fmtCost(detail.cost)}(定价条目已删除)</p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  未计费:定价表无该模型(可在"模型定价"页补录并回填)
                </p>
              )}
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-foreground">
                  故障转移与链路追踪
                </h4>
                <span className="font-mono text-xs text-muted-foreground">
                  共 {attempts.length} 次尝试
                </span>
              </div>
              <div className="relative space-y-3 pl-5 before:absolute before:bottom-2 before:left-2 before:top-2 before:w-0.5 before:bg-border/80">
                {attempts.map((a, i) => {
                  const isSuccess =
                    !a.error &&
                    (a.status == null || (a.status >= 200 && a.status < 400));
                  const isLast = i === attempts.length - 1;
                  return (
                    <div key={i} className="relative">
                      {/* 时间轴节点光点 */}
                      <span
                        className={cn(
                          "absolute -left-[17px] top-2 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-background ring-2",
                          isSuccess
                            ? "ring-success/70"
                            : "ring-destructive/70",
                        )}
                      >
                        <span
                          className={cn(
                            "h-1.5 w-1.5 rounded-full",
                            isSuccess ? "bg-success" : "bg-destructive",
                          )}
                        />
                      </span>

                      {/* 追踪卡片 */}
                      <div
                        className={cn(
                          "rounded-xl border p-2.5 text-xs shadow-2xs transition-all",
                          isSuccess
                            ? "border-success/30 bg-success/5"
                            : "border-destructive/25 bg-destructive/5",
                        )}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-[11px] text-muted-foreground/70">
                              #{i + 1}
                            </span>
                            <span className="font-medium text-foreground">
                              {a.channel ?? "未指定渠道"}
                            </span>
                            <span
                              className={cn(
                                "rounded-md px-1.5 py-0.5 font-mono text-[10px] font-semibold",
                                isSuccess
                                  ? "bg-success/15 text-success"
                                  : "bg-destructive/15 text-destructive",
                              )}
                            >
                              {a.status != null ? `HTTP ${a.status}` : "无响应"}
                            </span>
                          </div>
                          <span className="font-mono text-xs tabular-nums text-muted-foreground">
                            {fmtMs(a.durationMs ?? null)}
                          </span>
                        </div>

                        {a.error && (
                          <div className="mt-1.5 rounded-lg border border-destructive/20 bg-background/80 p-2 font-mono text-[11px] leading-relaxed text-destructive">
                            {a.error}
                          </div>
                        )}

                        {a.droppedFields?.length ? (
                          <div className="mt-1 text-[11px] text-muted-foreground/80">
                            协议转换已丢弃非标准字段: {a.droppedFields.join(", ")}
                          </div>
                        ) : null}

                        {!isSuccess && !isLast && (
                          <div className="mt-1.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                            ↳ 自动转移到下一优先级渠道
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold">请求体快照</h4>
                {detail.reqSnapshot && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 px-2 text-xs shadow-2xs"
                    onClick={async () => {
                      const host = `http://${settings?.listenAddr ?? "127.0.0.1"}:${settings?.port ?? 8787}/v1/chat/completions`;
                      const body = prettyBody(detail.reqSnapshot);
                      const authHeader = detail.keyName
                        ? `  -H "Authorization: Bearer <YOUR_API_KEY>" \\\n`
                        : "";
                      const curl = `curl -X POST "${host}" \\\n  -H "Content-Type: application/json" \\\n${authHeader}  -d '${body.replace(/'/g, "'\\''")}'`;
                      try {
                        await navigator.clipboard.writeText(curl);
                        setCopiedCurl(true);
                        toast.success("已复制为可执行的 cURL 复现命令");
                        setTimeout(() => setCopiedCurl(false), 2000);
                      } catch {
                        toast.error("复制失败");
                      }
                    }}
                  >
                    {copiedCurl ? (
                      <Check className="h-3.5 w-3.5 text-success" />
                    ) : (
                      <Terminal className="h-3.5 w-3.5 text-primary" />
                    )}
                    {copiedCurl ? "cURL 已复制" : "复制为 cURL"}
                  </Button>
                )}
              </div>
              <PreBlock text={prettyBody(detail.reqSnapshot)} />
            </div>
            <div className="space-y-2">
              <h4 className="text-sm font-semibold">响应体快照</h4>
              <PreBlock text={prettyBody(detail.respSnapshot)} />
            </div>
          </div>
        )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------- 状态点 ----------

function StatusCell({ status }: { status: number }) {
  const isErr = status >= 500;
  const isWarn = status >= 400 && status < 500;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-xs font-semibold tabular-nums border",
        isErr
          ? "border-destructive/30 bg-destructive/10 text-destructive shadow-2xs"
          : isWarn
            ? "border-warning/35 bg-warning/10 text-warning shadow-2xs"
            : "border-success/30 bg-success/10 text-success shadow-2xs"
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full shrink-0",
          isErr ? "bg-destructive animate-pulse" : isWarn ? "bg-warning" : "bg-success"
        )}
      />
      {status}
    </span>
  );
}

// ---------- 智能品牌模型微标 ----------

function ModelBadge({ model }: { model: string }) {
  const m = model.toLowerCase();
  let style = "border-border/80 bg-secondary/80 text-secondary-foreground";
  let dotColor = "";

  if (m.startsWith("claude") || m.includes("anthropic")) {
    style = "border-primary/30 bg-primary/10 text-primary";
    dotColor = "bg-primary";
  } else if (
    m.startsWith("gpt") ||
    m.startsWith("o1") ||
    m.startsWith("o3") ||
    m.startsWith("chatgpt") ||
    m.includes("openai")
  ) {
    style = "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
    dotColor = "bg-emerald-500";
  } else if (m.startsWith("gemini")) {
    style = "border-indigo-500/30 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400";
    dotColor = "bg-indigo-500";
  } else if (m.startsWith("deepseek")) {
    style = "border-cyan-500/30 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400";
    dotColor = "bg-cyan-500";
  } else if (m.startsWith("qwen")) {
    style = "border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400";
    dotColor = "bg-violet-500";
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 font-mono text-xs font-medium whitespace-nowrap shadow-2xs select-none",
        style
      )}
    >
      {dotColor && <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", dotColor)} />}
      {model}
    </span>
  );
}

// ---------- 日志行 ----------

function LogRow({
  log: l,
  channels,
  isNew,
  onDetail,
}: {
  log: LogItem;
  channels: Channel[] | undefined;
  isNew?: boolean;
  onDetail: () => void;
}) {
  const attemptCount = parseAttempts(l.attempts).length;
  // 渠道图标:渠道配置的 emoji/图片,按 channelName 匹配(日志冗余存名,按名查当前配置)
  const channelIcon = channels?.find((c) => c.name === l.channelName)?.icon || null;
  // 客户端映射:设置里配置的别名与 emoji 图标;未配置走原名
  const clientAlias = useAppStore(
    (s) => (l.client && s.clientAliases[l.client]) || null,
  );
  const clientIcon = useAppStore(
    (s) => (l.client && s.clientIcons[l.client]) || null,
  );
  const clientDisplay = clientAlias ?? l.client;
  const isErr = l.status >= 400 || !!l.error;

  return (
    <motion.tr
      layout
      initial={isNew ? { opacity: 0, y: -16, scale: 0.99 } : false}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      onClick={onDetail}
      className={cn(
        "group/row relative cursor-pointer border-b text-center transition-colors duration-150 hover:bg-accent/60 even:bg-muted/15 last:border-0",
        isNew && (isErr ? "animate-log-flash-error z-10" : "animate-log-flash-success z-10"),
      )}
    >
      <td
        className="w-20 whitespace-nowrap py-1.5 pr-1 font-mono text-xs"
        title={fmtFullTime(l.ts)}
      >
        {fmtTime(l.ts)}
      </td>
      <td className="py-1.5 pr-1">
        <ModelBadge model={l.model} />
      </td>
      {/* 推理等级:请求携带的 reasoning_effort(minimal/low/medium/high);无则占位 */}
      <td className="whitespace-nowrap py-1.5 pr-1">
        {l.tag ? (
          <Badge variant="outline" className="px-1.5">
            {l.tag}
          </Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="py-1.5 pr-1 text-sm">
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          {channelIcon &&
            (channelIcon.startsWith("data:image/") ? (
              <img src={channelIcon} alt="" className="h-4 w-4 object-contain" />
            ) : (
              <span className="text-sm leading-none">{channelIcon}</span>
            ))}
          {l.channelName ?? "—"}
          {attemptCount > 1 && (
            <Badge variant="warning" className="px-1 text-[10px]">
              ×{attemptCount}
            </Badge>
          )}
        </span>
      </td>
      <td className="whitespace-nowrap py-1.5 pr-1 font-mono text-xs leading-5">
        {/* 第一行:输入/输出;第二行:缓存命中/命中率。图标统一 h-3 w-3 与
            Database 同尺寸,输入↔命中、输出↔命中率左右对齐(两组各占同宽列);
            gap-x-2.5:输入列与输出列之间一档间隔(10px) */}
        <div className="mx-auto grid w-fit grid-cols-[auto_auto] gap-x-2.5 gap-y-0.5">
          <span className="flex items-center gap-0.5" title={`总输入 ${fmtK(l.promptTokens)}(含缓存)`}>
            {/* 差值夹 0:上游 usage 可能出现 prompt < cache_read+write 的异常数据 */}
            <ArrowUp className="h-3 w-3 shrink-0 text-orange-500" />
            <span className="text-orange-500">
              {fmtK(Math.max(0, l.promptTokens - l.cacheRead - l.cacheWrite))}
            </span>
          </span>
          <span className="flex items-center gap-0.5" title={`总输出 ${fmtK(l.completionTokens)}`}>
            <ArrowDown className="h-3 w-3 shrink-0 text-violet-500" />
            <span className="text-violet-500">{fmtK(l.completionTokens)}</span>
          </span>
          <span className="flex items-center gap-0.5" title="缓存命中词元">
            <Database className="h-3 w-3 shrink-0 text-emerald-500" />
            <span className="text-emerald-500">{fmtK(l.cacheRead)}</span>
          </span>
          {/* 命中率与命中量同色:同一语义(缓存命中)保持视觉一致 */}
          <span className="flex items-center gap-0.5">
            <Percent className="h-3 w-3 shrink-0 text-emerald-500" />
            <span className="text-emerald-500">
              {cacheHitRate(l.cacheRead, l.promptTokens)}
            </span>
          </span>
        </div>
      </td>
      {/* 任务耗时:单元格保持左对齐;首字/生成耗时按快慢分档着色;非流式整块淡色 */}
      <td className={cn("whitespace-nowrap py-1.5 pr-1 text-left font-mono text-xs leading-4", !l.isStream && "text-muted-foreground")}>
        <div>
          <div className="flex items-center gap-1.5">
            <span className="h-3 w-0.5 shrink-0 rounded-full bg-zinc-400" />
            <span className="text-muted-foreground">首字</span>
            <span className={latencyColor(l.ttftMs, [5000, 15000])}>
              {l.isStream ? fmtMs(l.ttftMs) : "—"}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-3 w-0.5 shrink-0 rounded-full bg-sky-500" />
            <span className="text-muted-foreground">耗时</span>
            {/* 生成耗时 = 总耗时 − 首字(流式,夹 0);非流式直接评总耗时。
                流式结合输出速度取较轻档:120s 出 12K 词元是健康长生成,
                不应仅因时长被判红。
                阈值:20s 内绿;20~60s 橙;≥60s 红 */}
            <span
              className={durationColor(
                l.isStream && l.ttftMs != null
                  ? Math.max(0, (l.totalMs ?? 0) - l.ttftMs)
                  : l.totalMs,
                [20000, 60000],
                { isStream: l.isStream, completionTokens: l.completionTokens },
              )}
            >
              {fmtMs(l.totalMs)}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-3 w-0.5 shrink-0 rounded-full bg-violet-500" />
            <span className="text-muted-foreground">速度</span>
            {/* 无速度(非流式/异常置空)保持默认色 */}
            <span className={speedColor(l.speed)}>
              {l.isStream && l.speed != null ? l.speed.toFixed(1) : "—"}
            </span>
          </div>
        </div>
      </td>
      <td className="whitespace-nowrap py-1.5 pr-1 font-mono text-xs">
        {l.cost != null && (
          <span title={l.estimated ? "usage 为本地估算" : undefined}>
            {l.estimated ? "~" : ""}
            {l.currency === "usd" ? fmtUsd(l.cost) : fmtYuan(l.cost)}
          </span>
        )}
        {l.cost == null && <span className="text-muted-foreground">—</span>}
      </td>
      <td className="whitespace-nowrap py-1.5 pr-1">
        <StatusCell status={l.status} />
      </td>
      <td className="whitespace-nowrap py-1.5 pr-1">
        {l.keyName ? (
          <Badge variant="outline" className="px-1.5">
            {l.keyName}
          </Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td
        className="whitespace-nowrap py-1.5 pr-1 text-xs text-muted-foreground"
        title={l.client ?? undefined}
      >
        {clientDisplay ? (
          <span className="inline-flex items-center gap-1">
            {clientIcon && clientIcon.startsWith("data:image/") ? (
              <img src={clientIcon} alt="" className="h-4 w-4 object-contain" />
            ) : (
              clientIcon && <span className="text-sm leading-none">{clientIcon}</span>
            )}
            <span>{clientDisplay}</span>
          </span>
        ) : (
          "—"
        )}
      </td>
      {/* 操作列:表格宽度由内容决定(w-max)后,它天然是最右一列,不需要 sticky。
          之前的 sticky right-0 在表格比容器宽时会把本列左移、盖住左侧
          「客户端」列的文字(截图里 deepseek-harness 被裁成 deepseek-harnes)。
          保留 border-l 做常驻分隔即可 */}
      <td className="whitespace-nowrap border-l py-1.5 pl-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-muted-foreground transition-colors group-hover/row:text-primary"
          onClick={(e) => {
            e.stopPropagation();
            onDetail();
          }}
        >
          详情
        </Button>
      </td>
    </motion.tr>
  );
}

// ---------- 数据总览页 ----------

export function DashboardPage() {
  const { data: breakers } = useBreakerStates();
  const { data: unpriced } = useUnpricedModels();
  const { data: channels } = useChannels();
  const { data: keys } = useApiKeys();
  const { data: logModels } = useLogModels();
  const qc = useQueryClient();
  const [range, setRange] = useState<TimeRange>("today");
  const [channelFilter, setChannelFilter] = useState("all");
  const [keyFilter, setKeyFilter] = useState("all");
  // 模型筛选(精确匹配),all = 全部模型
  const [modelFilter, setModelFilter] = useState("all");
  const [statusClass, setStatusClass] = useState<"all" | "success" | "error">("all");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(0);
  const [detailId, setDetailId] = useState<number | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  // 统计卡栅格:四卡一行所需宽度也参与窗口 minWidth 约束(见 useMinWindowWidthForContent)
  const statsRef = useRef<HTMLDivElement>(null);

  const filter = useMemo<LogFilter>(
    () => ({
      fromTs: rangeFromTs(range),
      channelId: channelFilter === "all" ? null : Number(channelFilter),
      keyId: keyFilter === "all" ? null : Number(keyFilter),
      model: modelFilter === "all" ? undefined : modelFilter,
      statusClass: statusClass === "all" ? undefined : statusClass,
      keyword: keyword.trim() || undefined,
      offset: page * PAGE_SIZE,
      limit: PAGE_SIZE,
    }),
    [range, channelFilter, keyFilter, modelFilter, statusClass, keyword, page],
  );

  const { data: stats } = useStats(filter);
  const { data, isLoading, isFetching } = useLogs(filter);
  const [items, total] = data ?? [[], 0];

  // 跟踪新入列的日志:首次加载记录基线;之后仅"时间晚于已知最新记录"的行标记为
  // isNew(入场流光)。翻页/切筛选时旧记录的 ID 同样"未见过",若只按 ID 判定会整页
  // 全部误闪,必须叠加时间戳条件
  const knownIdsRef = useRef<Set<number>>(new Set());
  const maxTsRef = useRef<number>(0);
  const isFirstLoadRef = useRef(true);
  const [newLogIds, setNewLogIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (items.length === 0) return;
    if (isFirstLoadRef.current) {
      isFirstLoadRef.current = false;
      knownIdsRef.current = new Set(items.map((it) => it.id));
      maxTsRef.current = Math.max(...items.map((it) => it.ts));
      return;
    }

    const brandNew = items
      .filter(
        (it) => !knownIdsRef.current.has(it.id) && it.ts > maxTsRef.current,
      )
      .map((it) => it.id);

    if (brandNew.length > 0) {
      brandNew.forEach((id) => knownIdsRef.current.add(id));
      maxTsRef.current = Math.max(
        maxTsRef.current,
        ...items.map((it) => it.ts),
      );
      setNewLogIds((prev) => new Set([...prev, ...brandNew]));
      // 2.2 秒后移除发光高亮标记，平滑恢复常态
      const t = setTimeout(() => {
        setNewLogIds((prev) => {
          const next = new Set(prev);
          brandNew.forEach((id) => next.delete(id));
          return next;
        });
      }, 2200);
      return () => clearTimeout(t);
    }
  }, [items]);

  // 表格 + 统计卡内容真实宽度 → 反推窗口最小宽度(见 useMinWindowWidthForContent)。
  // enabled 必须放这:数据到位后 <table> 才会渲染,冷启动首帧表格还不存在
  const tableMounted = !isLoading && items.length > 0;
  useMinWindowWidthForContent(tableRef, statsRef, tableMounted);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 日志清理/筛选结果变少后 total 缩水:把当前页收敛进有效范围,避免空页/越界页码
  const safePage = Math.min(page, pageCount - 1);

  const openBreakers = (breakers ?? []).filter((b) => b.state !== "closed");
  const successRate =
    stats && stats.count > 0
      ? `${(((stats.count - stats.errorCount) / stats.count) * 100).toFixed(1)}%`
      : "—";

  const resetPage = () => setPage(0);
  const activeFilterCount =
    (channelFilter !== "all" ? 1 : 0) +
    (keyFilter !== "all" ? 1 : 0) +
    (modelFilter !== "all" ? 1 : 0) +
    (statusClass !== "all" ? 1 : 0) +
    (keyword.trim() !== "" ? 1 : 0);

  return (
    // flex 列布局:日志卡片 flex-1 弹性占满剩余视口高度,底部不留空白
    <div className="flex h-full flex-col gap-4">
      {/* 告警条 */}
      {(openBreakers.length > 0 || (unpriced?.length ?? 0) > 0) && (
        <div className="space-y-2">
          {openBreakers.length > 0 && (
            <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
              <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
              <span>
                {openBreakers.length} 个渠道熔断中:
                {openBreakers
                  .map(
                    (b) =>
                      `#${b.channelId}(${
                        b.state === "open" ? "冷却" : "半开探测"
                      })`,
                  )
                  .join("、")}
                ;请求会跳过这些渠道
              </span>
            </div>
          )}
          {(unpriced?.length ?? 0) > 0 && (
            <div className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
              <Coins className="h-4 w-4 shrink-0 text-warning" />
              <span>
                {unpriced!.length} 个模型未定价,相关请求未计入费用
                (到"模型定价"页一键补录并回填)
              </span>
            </div>
          )}
        </div>
      )}

      {/* 筛选:时间分段 + 渠道/密钥/状态/模型/关键字,联动卡片与日志表 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">时间范围</span>
          <div className="relative flex items-center rounded-lg border border-border/80 bg-muted/60 p-0.5 shadow-2xs">
            {DASH_RANGES.map((r) => {
              const isActive = range === r;
              return (
                <button
                  key={r}
                  onClick={() => {
                    setRange(r);
                    resetPage();
                  }}
                  className={cn(
                    "relative rounded-md px-2.5 py-1 text-xs font-medium transition-colors select-none",
                    isActive
                      ? "text-foreground font-semibold"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {isActive && (
                    <motion.span
                      layoutId="active-dash-range"
                      className="absolute inset-0 rounded-md bg-background shadow-xs ring-1 ring-border/80"
                      transition={{ type: "spring", stiffness: 450, damping: 35 }}
                    />
                  )}
                  <span className="relative z-10">{TIME_RANGE_LABELS[r]}</span>
                </button>
              );
            })}
          </div>
        </div>
        <Select
          value={channelFilter}
          onValueChange={(v) => {
            setChannelFilter(v);
            resetPage();
          }}
        >
          <SelectTrigger className="h-8 w-[130px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部渠道</SelectItem>
            {(channels ?? []).map((c) => (
              <SelectItem key={c.id} value={String(c.id)}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={keyFilter}
          onValueChange={(v) => {
            setKeyFilter(v);
            resetPage();
          }}
        >
          <SelectTrigger className="h-8 w-[130px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部密钥</SelectItem>
            {(keys ?? []).map((k) => (
              <SelectItem key={k.id} value={String(k.id)}>
                {k.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={modelFilter}
          onValueChange={(v) => {
            setModelFilter(v);
            resetPage();
          }}
        >
          <SelectTrigger className="h-8 w-[150px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部模型</SelectItem>
            {(logModels ?? []).map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* 状态快筛: 全部 / 仅成功 / 仅异常 */}
        <div className="flex items-center rounded-lg border border-border/80 bg-muted/60 p-0.5 shadow-2xs">
          <button
            type="button"
            onClick={() => {
              setStatusClass("all");
              resetPage();
            }}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors select-none",
              statusClass === "all"
                ? "bg-background text-foreground font-semibold shadow-2xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            全部
          </button>
          <button
            type="button"
            onClick={() => {
              setStatusClass("success");
              resetPage();
            }}
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors select-none",
              statusClass === "success"
                ? "bg-background text-emerald-600 dark:text-emerald-400 font-semibold shadow-2xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            仅成功
          </button>
          <button
            type="button"
            onClick={() => {
              setStatusClass("error");
              resetPage();
            }}
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors select-none",
              statusClass === "error"
                ? "bg-background text-destructive font-semibold shadow-2xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-destructive animate-pulse" />
            仅异常
          </button>
        </div>

        {/* 关键词/报错实时搜索 */}
        <div className="relative w-40 sm:w-52">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground/60" />
          <Input
            value={keyword}
            onChange={(e) => {
              setKeyword(e.target.value);
              resetPage();
            }}
            placeholder="搜索模型 / 报错信息…"
            className="h-8 bg-background/60 pl-8 pr-7 text-xs shadow-2xs"
          />
          {keyword && (
            <button
              onClick={() => {
                setKeyword("");
                resetPage();
              }}
              className="absolute right-2 top-2 text-muted-foreground/60 hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {activeFilterCount > 0 && (
          <button
            onClick={() => {
              setChannelFilter("all");
              setKeyFilter("all");
              setModelFilter("all");
              setStatusClass("all");
              setKeyword("");
              resetPage();
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary shadow-2xs transition-all hover:bg-primary/20 active:scale-95"
            title="清空当前所有过滤条件"
          >
            <RotateCcw className="h-3 w-3" />
            <span>重置筛选</span>
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
              {activeFilterCount}
            </span>
          </button>
        )}
      </div>

      {/* 汇总卡片:图标色块风,与筛选联动。
          固定 grid-cols-4:四卡一行是硬约束,不允许响应式断点把它折成两行
          (sm:grid-cols-2 xl:grid-cols-4 会在 ~1280 触发换行,实测翻车)。
          窗口不够宽时 minWidth 会顶住(见 useMinWindowWidthForContent);
          小屏放不下时卡片按 min-w-0/truncate 收缩,也绝不换行 */}
      <div ref={statsRef} className="grid grid-cols-4 gap-3">
        <StatCard
          icon={Link2}
          tile="bg-gradient-to-br from-indigo-500/20 to-indigo-500/5 text-indigo-500 ring-1 ring-inset ring-indigo-500/25 shadow-2xs"
          valueClass="text-indigo-600 dark:text-indigo-400"
          label="请求数量"
          value={stats ? String(stats.count) : "—"}
          hint={`失败 ${stats?.errorCount ?? 0} 次`}
        />
        <StatCard
          icon={CircleDollarSign}
          tile="bg-gradient-to-br from-amber-500/20 to-amber-500/5 text-amber-500 ring-1 ring-inset ring-amber-500/25 shadow-2xs"
          valueClass="text-amber-600 dark:text-amber-400"
          label="消耗金额"
          value={stats ? fmtYuan(stats.totalCost) : "—"}
          // 有美元定价消耗时在副行分列展示;两种币种互不换算
          hint={
            stats && stats.totalCostUsd > 0
              ? fmtUsd(stats.totalCostUsd)
              : "按定价表计,含缓存"
          }
        />
        <StatCard
          icon={ScrollText}
          tile="bg-gradient-to-br from-sky-500/20 to-sky-500/5 text-sky-500 ring-1 ring-inset ring-sky-500/25 shadow-2xs"
          valueClass="text-sky-600 dark:text-sky-400"
          label="词元数量"
          value={stats ? fmtK(stats.promptTokens + stats.completionTokens) : "—"}
          hint={`缓存命中率 ${stats ? cacheHitRate(stats.cacheRead, stats.promptTokens) : "—"}`}
        />
        <StatCard
          icon={CircleCheck}
          tile="bg-gradient-to-br from-emerald-500/20 to-emerald-500/5 text-emerald-500 ring-1 ring-inset ring-emerald-500/25 shadow-2xs"
          valueClass="text-emerald-600 dark:text-emerald-400"
          label="成功率"
          value={successRate}
          hint={`平均首字 ${stats?.avgTtftMs != null ? fmtMs(stats.avgTtftMs) : "—"}`}
        />
      </div>

      {/* 请求日志表(原"请求日志"页并入);min-h-0 允许 flex 收缩,内滚容器占满剩余高度 */}
      <Card className="flex min-h-0 flex-1 flex-col">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <span>请求日志</span>
            <span className="font-mono text-xs font-normal text-muted-foreground">
              (共 {total.toLocaleString()} 条)
            </span>
          </CardTitle>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Button
              variant="ghost"
              size="icon"
              title="手动刷新"
              className="h-8 w-8 text-muted-foreground transition-all hover:text-foreground active:scale-95"
              onClick={() => qc.invalidateQueries({ queryKey: ["logs"] })}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
            </Button>
            <div className="flex items-center gap-1 rounded-lg border border-border/80 bg-muted/40 p-0.5 shadow-2xs">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-md"
                disabled={safePage === 0}
                onClick={() => setPage(Math.min(page, pageCount - 1) - 1)}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <span className="px-2 font-mono text-xs font-medium tabular-nums text-foreground">
                {safePage + 1} <span className="text-muted-foreground/50">/</span> {pageCount}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-md"
                disabled={safePage + 1 >= pageCount}
                onClick={() => setPage(Math.min(page, pageCount - 1) + 1)}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </CardHeader>
        {/* 内滚容器撑满卡片剩余空间:表头 sticky 钉住,底部与卡片边缘贴合 */}
        <CardContent className="min-h-0 flex-1 overflow-auto">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载中…
            </div>
          ) : items.length === 0 ? (
            <div className="flex h-full items-center justify-center p-6">
              <EmptyState
                icon={ScrollText}
                title={
                  activeFilterCount > 0
                    ? "未找到匹配当前筛选条件的请求"
                    : "网关服务已就绪，等待首次请求"
                }
                description={
                  activeFilterCount > 0
                    ? "当前时间范围或渠道/密钥/模型筛选下暂无记录，您可以尝试重置筛选条件"
                    : "请在第三方客户端（Claude Code / Cursor / Cherry Studio）中配置网关地址发起调用"
                }
              >
                {activeFilterCount > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 text-xs shadow-2xs"
                    onClick={() => {
                      setChannelFilter("all");
                      setKeyFilter("all");
                      setModelFilter("all");
                      resetPage();
                    }}
                  >
                    <RotateCcw className="h-3.5 w-3.5" /> 清空筛选条件
                  </Button>
                )}
              </EmptyState>
            </div>
          ) : (
            <table ref={tableRef} className="w-max min-w-full text-sm">
              <thead className="sticky top-0 z-10 bg-card">
                {/* 列宽策略:w-max 让表格按内容取宽(硬保底,列永不被压缩重叠),
                    min-w-full 在窗口更宽时把表格撑满容器——多余空间按各列内容
                    比例分配,列均匀舒展,不会缩在左边留一片空白。
                    窄窗口的体验由"测量 + 窗口最小宽度"负责(见 useMinWindow
                    WidthForTable):内容一行完整显示所需的宽度是运行时实测的,
                    实测结果用于设置窗口 minWidth,让用户拖不到会溢出的宽度。
                    双保险:minWidth 因任何原因(权限/时序/测量偏差)没生效时,
                    表格只是溢出出横向滚动条,列内容依然完整可读。
                    任务耗时列内容与表头均左对齐(竖条锚点行),其余居中。 */}
                <tr className="border-b text-center text-xs text-muted-foreground">
                  <th className="w-20 whitespace-nowrap py-2 pr-1 font-medium">时间</th>
                  <th className="whitespace-nowrap py-2 pr-1 font-medium">模型</th>
                  <th className="whitespace-nowrap py-2 pr-1 font-medium">推理</th>
                  <th className="whitespace-nowrap py-2 pr-1 font-medium">渠道</th>
                  <th className="whitespace-nowrap py-2 pr-1 font-medium">词元</th>
                  <th className="whitespace-nowrap py-2 pr-1 text-left font-medium">任务耗时</th>
                  <th className="whitespace-nowrap py-2 pr-1 font-medium">费用</th>
                  <th className="whitespace-nowrap py-2 pr-1 font-medium">状态</th>
                  <th className="whitespace-nowrap py-2 pr-1 font-medium">密钥</th>
                  <th className="whitespace-nowrap py-2 pr-1 font-medium">客户端</th>
                  <th className="whitespace-nowrap py-2 pl-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((l) => (
                  <LogRow
                    key={l.id}
                    log={l}
                    channels={channels}
                    isNew={newLogIds.has(l.id)}
                    onDetail={() => setDetailId(l.id)}
                  />
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <LogDetailDialog id={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}
