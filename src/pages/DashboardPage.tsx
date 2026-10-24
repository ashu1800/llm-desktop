import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleDollarSign,
  Coins,
  Database,
  Link2,
  Loader2,
  RefreshCw,
  ScrollText,
} from "lucide-react";
import { api } from "@/lib/api";
import {
  useApiKeys,
  useBreakerStates,
  useChannels,
  useLogs,
  useLogModels,
  useStats,
  useUnpricedModels,
} from "@/hooks/use-gateway";
import {
  cacheHitRate,
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
  TIME_RANGE_LABELS,
  type TimeRange,
} from "@/lib/format";
import type {
  AttemptEntry,
  LogDetail,
  LogFilter,
  LogItem,
} from "@/lib/types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useAppStore } from "@/stores/app-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
    <Card className="py-4">
      <CardContent className="flex items-center gap-3 px-4 py-0">
        <div
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
            tile,
          )}
        >
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">{label}</div>
          <div
            className={cn(
              "truncate text-xl font-semibold tabular-nums leading-tight",
              valueClass,
            )}
          >
            {value}
          </div>
          <div className="truncate text-xs text-muted-foreground">{hint}</div>
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

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2">
      <span className="shrink-0 text-muted-foreground">{k}</span>
      <span className="break-all text-right">{v}</span>
    </div>
  );
}

function KvBox({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-md border bg-muted/40 px-3 py-2">
      <div className="text-xs text-muted-foreground">{k}</div>
      <div className="font-mono text-sm font-medium">{v}</div>
    </div>
  );
}

function PreBlock({ text }: { text: string }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap break-all">
      {text}
    </pre>
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

  return (
    <Dialog open={id != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-4xl overflow-auto">
        <DialogHeader>
          <DialogTitle>请求详情</DialogTitle>
          <DialogDescription>
            {detail
              ? `#${detail.id} · ${fmtFullTime(detail.ts)} · ${detail.model}`
              : "加载中…"}
          </DialogDescription>
        </DialogHeader>
        {detail && (
          <div className="grid gap-5">
            <div className="space-y-2">
              <h4 className="text-sm font-semibold">基本信息</h4>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
                <Kv k="入口协议 → 上游协议" v={`${detail.protocolIn} → ${detail.protocolUp ?? "—"}`} />
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
                  <div>
                    输入{" "}
                    {fmtK(
                      Math.max(
                        0,
                        detail.promptTokens - detail.cacheRead - detail.cacheWrite,
                      ),
                    )}{" "}
                    × {price.input} {unit}
                  </div>
                  <div>
                    缓存读 {fmtK(detail.cacheRead)} × {price.cacheRead} {unit} + 缓存写{" "}
                    {fmtK(detail.cacheWrite)} × {price.cacheWrite} {unit}
                  </div>
                  <div>
                    输出 {fmtK(detail.completionTokens)} × {price.output} {unit}
                  </div>
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

            <div className="space-y-2">
              <h4 className="text-sm font-semibold">
                重试链({attempts.length} 次尝试)
              </h4>
              <div className="space-y-1.5">
                {attempts.map((a, i) => (
                  <div
                    key={i}
                    className="rounded-md border px-3 py-2 text-xs leading-5"
                  >
                    <span className="font-medium">#{i + 1} {a.channel ?? "—"}</span>
                    <span className="ml-2 text-muted-foreground">
                      {a.status != null ? `HTTP ${a.status}` : "无响应"} · {fmtMs(a.durationMs ?? null)}
                    </span>
                    {a.error && <div className="text-destructive">{a.error}</div>}
                    {a.droppedFields?.length ? (
                      <div className="text-muted-foreground">
                        丢弃字段:{a.droppedFields.join(", ")}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <h4 className="text-sm font-semibold">请求体快照</h4>
              <PreBlock text={prettyBody(detail.reqSnapshot)} />
            </div>
            <div className="space-y-2">
              <h4 className="text-sm font-semibold">响应体快照</h4>
              <PreBlock text={prettyBody(detail.respSnapshot)} />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------- 状态点 ----------

function StatusCell({ status }: { status: number }) {
  const color =
    status >= 500
      ? "text-destructive"
      : status >= 400
        ? "text-warning"
        : "text-success";
  return (
    <span className={cn("font-mono text-xs font-medium", color)}>
      ● {status}
    </span>
  );
}

// ---------- 日志行 ----------

function LogRow({ log: l, onDetail }: { log: LogItem; onDetail: () => void }) {
  const attemptCount = parseAttempts(l.attempts).length;
  // 客户端映射:设置里配置的别名与 emoji 图标;未配置走原名
  const clientAlias = useAppStore(
    (s) => (l.client && s.clientAliases[l.client]) || null,
  );
  const clientIcon = useAppStore(
    (s) => (l.client && s.clientIcons[l.client]) || null,
  );
  const clientDisplay = clientAlias ?? l.client;
  return (
    <tr className="border-b text-center last:border-0 hover:bg-accent/30">
      <td className="py-1.5 pr-2 font-mono text-xs" title={fmtFullTime(l.ts)}>
        {fmtTime(l.ts)}
      </td>
      <td className="py-1.5 pr-2">
        <div className="inline-flex items-center gap-1.5">
          <Badge variant="secondary" className="max-w-[180px] truncate px-1.5 font-mono">
            {l.model}
          </Badge>
          {l.tag && <Badge variant="outline" className="px-1.5">{l.tag}</Badge>}
        </div>
      </td>
      <td className="py-1.5 pr-2 text-sm">
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-primary/60" />
          {l.channelName ?? "—"}
          {attemptCount > 1 && (
            <Badge variant="warning" className="px-1 text-[10px]">
              ×{attemptCount}
            </Badge>
          )}
        </span>
      </td>
      <td className="py-1.5 pr-2 font-mono text-xs leading-5">
        <div className="flex items-center justify-center gap-2.5">
          <span
            className="text-orange-500"
            title={`总输入 ${fmtK(l.promptTokens)}(含缓存)`}
          >
            {/* 差值夹 0:上游 usage 可能出现 prompt < cache_read+write 的异常数据 */}
            ↑{fmtK(Math.max(0, l.promptTokens - l.cacheRead - l.cacheWrite))}
          </span>
          <span className="text-violet-500" title={`总输出 ${fmtK(l.completionTokens)}`}>
            ↓{fmtK(l.completionTokens)}
          </span>
        </div>
        <div className="flex items-center justify-center gap-1 text-muted-foreground">
          <Database className="h-3 w-3" />
          <span className="text-emerald-500" title="缓存命中词元">
            {fmtK(l.cacheRead)}
          </span>
          <span className="text-sky-500">
            {cacheHitRate(l.cacheRead, l.promptTokens)}
          </span>
        </div>
      </td>
      {/* 任务耗时:单元格保持左对齐;首字/生成耗时按快慢分档着色;非流式整块淡色 */}
      <td className={cn("py-1.5 pr-2 text-left font-mono text-xs leading-4", !l.isStream && "text-muted-foreground")}>
        <div>
          <div className="flex items-center gap-1.5">
            <span className="h-3 w-0.5 shrink-0 rounded-full bg-zinc-400" />
            <span className="text-muted-foreground">首字</span>
            <span className={latencyColor(l.ttftMs, [1000, 3000, 8000])}>
              {l.isStream ? fmtMs(l.ttftMs) : "—"}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-3 w-0.5 shrink-0 rounded-full bg-sky-500" />
            <span className="text-muted-foreground">耗时</span>
            {/* 评估生成耗时 = 总耗时 − 首字(流式,夹 0);非流式无首字概念,直接评总耗时 */}
            <span
              className={latencyColor(
                l.isStream && l.ttftMs != null
                  ? Math.max(0, (l.totalMs ?? 0) - l.ttftMs)
                  : l.totalMs,
                [5000, 15000, 60000],
              )}
            >
              {fmtMs(l.totalMs)}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-3 w-0.5 shrink-0 rounded-full bg-violet-500" />
            <span className="text-muted-foreground">速度</span>
            <span>
              {l.isStream && l.speed != null ? l.speed.toFixed(1) : "—"}
            </span>
          </div>
        </div>
      </td>
      <td className="py-1.5 pr-2 font-mono text-xs">
        {l.cost != null && (
          <span title={l.estimated ? "usage 为本地估算" : undefined}>
            {l.estimated ? "~" : ""}
            {l.currency === "usd" ? fmtUsd(l.cost) : fmtYuan(l.cost)}
          </span>
        )}
        {l.cost == null && <span className="text-muted-foreground">—</span>}
      </td>
      <td className="py-1.5 pr-2">
        <StatusCell status={l.status} />
      </td>
      <td className="py-1.5 pr-2">
        {l.keyName ? (
          <Badge variant="outline" className="px-1.5">
            {l.keyName}
          </Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td
        className="max-w-[110px] truncate py-1.5 pr-2 text-xs text-muted-foreground"
        title={l.client ?? undefined}
      >
        {clientDisplay ? (
          <span className="inline-flex items-center gap-1">
            {clientIcon && clientIcon.startsWith("data:image/") ? (
              <img src={clientIcon} alt="" className="h-4 w-4 object-contain" />
            ) : (
              clientIcon && <span className="text-sm leading-none">{clientIcon}</span>
            )}
            <span className="truncate">{clientDisplay}</span>
          </span>
        ) : (
          "—"
        )}
      </td>
      <td className="py-1.5">
        <Button variant="ghost" size="sm" onClick={onDetail}>
          详情
        </Button>
      </td>
    </tr>  );
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
  const [page, setPage] = useState(0);
  const [detailId, setDetailId] = useState<number | null>(null);

  const filter = useMemo<LogFilter>(
    () => ({
      fromTs: rangeFromTs(range),
      channelId: channelFilter === "all" ? null : Number(channelFilter),
      keyId: keyFilter === "all" ? null : Number(keyFilter),
      model: modelFilter === "all" ? undefined : modelFilter,
      offset: page * PAGE_SIZE,
      limit: PAGE_SIZE,
    }),
    [range, channelFilter, keyFilter, modelFilter, page],
  );

  const { data: stats } = useStats(filter);
  const { data, isLoading, isFetching } = useLogs(filter);
  const [items, total] = data ?? [[], 0];
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 日志清理/筛选结果变少后 total 缩水:把当前页收敛进有效范围,避免空页/越界页码
  const safePage = Math.min(page, pageCount - 1);

  const openBreakers = (breakers ?? []).filter((b) => b.state !== "closed");
  const successRate =
    stats && stats.count > 0
      ? `${(((stats.count - stats.errorCount) / stats.count) * 100).toFixed(1)}%`
      : "—";

  const resetPage = () => setPage(0);

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
          <div className="flex items-center rounded-lg border bg-card p-0.5">
            {DASH_RANGES.map((r) => (
              <button
                key={r}
                onClick={() => {
                  setRange(r);
                  resetPage();
                }}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs transition-colors",
                  range === r
                    ? "bg-primary font-medium text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {TIME_RANGE_LABELS[r]}
              </button>
            ))}
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
      </div>

      {/* 汇总卡片:图标色块风,与筛选联动 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={Link2}
          tile="bg-[#8B7BE8]/15 text-[#8B7BE8]"
          valueClass="text-[#6D5BD0] dark:text-[#A18FF0]"
          label="请求数量"
          value={stats ? String(stats.count) : "—"}
          hint={`失败 ${stats?.errorCount ?? 0} 次`}
        />
        <StatCard
          icon={CircleDollarSign}
          tile="bg-[#D9A514]/15 text-[#D9A514]"
          valueClass="text-[#A87E0B] dark:text-[#E0B33C]"
          label="消耗金额"
          value={stats ? fmtYuan(stats.totalCost) : "—"}
          // 有美元定价消耗时在副行分列展示;两种币种互不换算
          hint={
            stats && stats.totalCostUsd > 0
              ? `美元消耗 ${fmtUsd(stats.totalCostUsd)} · 按定价表计`
              : "按定价表计,含缓存"
          }
        />
        <StatCard
          icon={ScrollText}
          tile="bg-[#5FA8E8]/15 text-[#5FA8E8]"
          valueClass="text-[#3E87C9] dark:text-[#7FBBF0]"
          label="词元数量"
          value={stats ? fmtK(stats.promptTokens + stats.completionTokens) : "—"}
          hint={`缓存命中率 ${stats ? cacheHitRate(stats.cacheRead, stats.promptTokens) : "—"}`}
        />
        <StatCard
          icon={CircleCheck}
          tile="bg-[#5BAF6E]/15 text-[#5BAF6E]"
          valueClass="text-[#3F9354] dark:text-[#7CC48D]"
          label="成功率"
          value={successRate}
          hint={`平均首字 ${stats?.avgTtftMs != null ? fmtMs(stats.avgTtftMs) : "—"}`}
        />
      </div>

      {/* 请求日志表(原"请求日志"页并入);min-h-0 允许 flex 收缩,内滚容器占满剩余高度 */}
      <Card className="flex min-h-0 flex-1 flex-col">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <div>
            <CardTitle className="text-base">请求日志</CardTitle>
            <CardDescription>共 {total} 条</CardDescription>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Button
              variant="ghost"
              size="icon"
              title="手动刷新"
              onClick={() => qc.invalidateQueries({ queryKey: ["logs"] })}
            >
              <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={safePage === 0}
              onClick={() => setPage(Math.min(page, pageCount - 1) - 1)}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            {safePage + 1} / {pageCount}
            <Button
              variant="outline"
              size="sm"
              disabled={safePage + 1 >= pageCount}
              onClick={() => setPage(Math.min(page, pageCount - 1) + 1)}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </CardHeader>
        {/* 内滚容器撑满卡片剩余空间:表头 sticky 钉住,底部与卡片边缘贴合 */}
        <CardContent className="min-h-0 flex-1 overflow-auto">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载中…
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <ScrollText className="h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                当前筛选条件下暂无请求
              </p>
            </div>
          ) : (
            <table className="w-full min-w-[1100px] text-sm">
              <thead className="sticky top-0 z-10 bg-card">
                {/* 任务耗时列特殊:内容与表头均左对齐(竖条锚点行),其余列居中 */}
                <tr className="border-b text-center text-xs text-muted-foreground">
                  <th className="py-2 pr-2 font-medium">时间</th>
                  <th className="py-2 pr-2 font-medium">模型</th>
                  <th className="py-2 pr-2 font-medium">渠道</th>
                  <th className="py-2 pr-2 font-medium">词元</th>
                  <th className="py-2 pr-2 text-left font-medium">任务耗时</th>
                  <th className="py-2 pr-2 font-medium">费用</th>
                  <th className="py-2 pr-2 font-medium">状态</th>
                  <th className="py-2 pr-2 font-medium">密钥</th>
                  <th className="py-2 pr-2 font-medium">客户端</th>
                  <th className="py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((l) => (
                  <LogRow key={l.id} log={l} onDetail={() => setDetailId(l.id)} />
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
