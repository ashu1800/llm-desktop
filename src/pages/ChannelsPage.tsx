import { Fragment, useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Cable,
  Check,
  Copy,
  Eye,
  EyeOff,
  ImagePlus,
  LayoutGrid,
  LayoutList,
  Loader2,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  Zap,
} from "lucide-react";
import { api, maskKey } from "@/lib/api";
import {
  useBreakerStates,
  useChannels,
  useSettings,
} from "@/hooks/use-gateway";
import type { Channel, RateRule, TestChannelResult, UpstreamProto } from "@/lib/types";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ProtocolBadge } from "@/components/ProtocolBadge";
import { useConfirm } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

const PROTOCOL_PLACEHOLDER: Record<UpstreamProto, string> = {
  // /v1、/v1beta 版本前缀带不带都行,网关按协议自动补全去重
  openai: "https://api.openai.com 或中转站地址(/v1 可带可不带)",
  anthropic: "https://api.anthropic.com(/v1 可带可不带)",
  gemini: "https://generativelanguage.googleapis.com(/v1beta 可带可不带)",
};

function emptyChannel(): Channel {
  return {
    id: 0,
    name: "",
    protocol: "openai",
    baseUrl: "",
    apiKeys: [""],
    enabled: true,
    proxy: null,
    maxConcurrency: null,
    models: [],
    modelMap: {},
    timeoutOverride: null,
    breakerOverride: null,
    remark: "",
    icon: "",
    priceCurrency: "cny",
    rateRules: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

function breakerBadge(
  enabled: boolean,
  breaker?: { state: string; remainingSecs: number },
) {
  if (!enabled)
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/60 px-2.5 py-0.5 text-xs font-medium text-muted-foreground shadow-2xs">
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
        已禁用
      </span>
    );
  if (!breaker || breaker.state === "closed")
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2.5 py-0.5 text-xs font-semibold text-success shadow-2xs">
        <span className="h-1.5 w-1.5 rounded-full bg-success shadow-[0_0_6px_hsl(var(--success))]" />
        正常
      </span>
    );
  if (breaker.state === "open")
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-2.5 py-0.5 text-xs font-semibold text-destructive shadow-2xs">
        <span className="relative flex h-2 w-2 items-center justify-center">
          <span className="absolute h-full w-full animate-ping rounded-full bg-destructive/50" />
          <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
        </span>
        <span className="tabular-nums">熔断冷却 {breaker.remainingSecs}s</span>
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/35 bg-warning/10 px-2.5 py-0.5 text-xs font-semibold text-warning shadow-2xs">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
      半开探测中
    </span>
  );
}

// ---------- 计费倍率规则编辑器 ----------

const DAY_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "每天" },
  { value: "workday", label: "工作日" },
  { value: "weekend", label: "周末" },
  { value: "holiday", label: "法定节假日" },
];

function RateRuleEditor({
  value,
  onChange,
}: {
  value: RateRule[];
  onChange: (v: RateRule[]) => void;
}) {
  const rules = value ?? [];
  const patch = (i: number, p: Partial<RateRule>) => {
    const next = [...rules];
    next[i] = { ...next[i], ...p };
    onChange(next);
  };

  return (
    <div className="space-y-1.5">
      {rules.map((r, i) => (
        <div key={i} className="rounded-lg border bg-muted/30 px-2.5 py-2">
          {/* 单行铺满容器:模型名吃掉全部剩余宽度(min-w-0 防长名撑破),
              倍率/日类型/时段按内容定宽 */}
          <div className="flex items-center gap-1.5">
            <Input
              value={r.model}
              onChange={(e) => patch(i, { model: e.target.value })}
              placeholder="模型(gpt* 通配,空=全部)"
              className="h-7 min-w-0 flex-1 font-mono text-xs"
            />
            <span className="text-xs text-muted-foreground">×</span>
            <Input
              type="number"
              min="0"
              max="100"
              step="0.1"
              value={r.rate}
              // 可完整解析才写回:"0." 等中间态若回写 Number() 会折叠成 0,
              // 受控 value 重置吞掉小数点,继续输入变 "05"→5(计费放大 10 倍)
              onChange={(e) => {
                const v = e.target.value;
                if (v !== "" && Number.isFinite(Number(v))) patch(i, { rate: Number(v) });
              }}
              onBlur={(e) => {
                // 失焦归一:清空/非法回 1(与后端钳制一致)
                const n = Number(e.target.value);
                if (e.target.value === "" || !Number.isFinite(n)) patch(i, { rate: 1 });
              }}
              className="h-7 w-16 shrink-0 text-xs"
            />
            <Select value={r.dayType || "all"} onValueChange={(v) => patch(i, { dayType: v })}>
              <SelectTrigger className="h-7 w-24 shrink-0 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DAY_TYPE_OPTIONS.map((d) => (
                  <SelectItem key={d.value} value={d.value}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={r.timeRange}
              onChange={(e) => patch(i, { timeRange: e.target.value })}
              placeholder="HH:MM-HH:MM(可选)"
              className="h-7 w-36 shrink-0 font-mono text-xs"
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
              title="删除规则"
              onClick={() => onChange(rules.filter((_, j) => j !== i))}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1 px-2 text-xs"
        onClick={() =>
          onChange([...rules, { model: "", rate: 1, dayType: "all", timeRange: "", remark: "" }])
        }
      >
        <Plus className="h-3 w-3" /> 添加倍率规则
      </Button>
    </div>
  );
}

// ---------- 支持的模型(白名单 + 映射合一) ----------
//
// 语义上"支持的模型"与"模型白名单"是同一份数据:前者是模型名集合,
// 后者在集合基础上加了「对外名 → 上游名」的可选映射。故合并成一张表,
// 对外模型名即白名单条目,上游模型名留空 = 同名透传。
// 存储仍分离(models / modelMap),避免破坏后端与历史数据。

/** 行模型:对外名 + 可选上游名 */
type ModelRow = { out: string; up: string };

/** models + modelMap → 表格行 */
function toRows(models: string[], modelMap: Record<string, string>): ModelRow[] {
  const rows: ModelRow[] = models.map((m) => ({
    out: m,
    // 同名映射(值 === 键)也要回显:用户显式填了同名上游名,不能显示成没填
    up: modelMap[m] ?? "",
  }));
  // modelMap 里有但 models 漏了的条目(历史数据/导入)也要显示,否则会静默丢失
  for (const [k, v] of Object.entries(modelMap)) {
    if (!models.includes(k) && k !== "") rows.push({ out: k, up: v });
  }
  return rows;
}

/** 表格行 → models + modelMap(对外名空的行丢弃) */
function fromRows(rows: ModelRow[]): {
  models: string[];
  modelMap: Record<string, string>;
} {
  const models: string[] = [];
  const modelMap: Record<string, string> = {};
  for (const r of rows) {
    const out = r.out.trim();
    if (!out || models.includes(out)) continue;
    models.push(out);
    const up = r.up.trim();
    // 同名也保存(用户显式填写,回显才不失真):数据面上 值===键 的映射
    // 与透传完全等价(mapped_model 命中后取到的还是同名),纯冗余无害
    if (up) modelMap[out] = up;
  }
  return { models, modelMap };
}

function ModelsField({
  models,
  modelMap,
  onChange,
  baseUrl,
  protocol,
  apiKey,
  proxy,
}: {
  models: string[];
  modelMap: Record<string, string>;
  onChange: (v: { models: string[]; modelMap: Record<string, string> }) => void;
  baseUrl: string;
  protocol: UpstreamProto;
  apiKey: string;
  proxy: string | null;
}) {
  // 行状态是本地草稿:空行(刚"添加一行"、正在输入对外名之前)必须能存活。
  // 之前直接 commit 到父层,fromRows 会把对外名为空的行丢弃——"添加一行"
  // 瞬间被规整掉,按钮看起来完全无效
  const [rows, setRows] = useState<ModelRow[]>(() => toRows(models, modelMap));
  // 上一次 commit 写回父层的规整结果(序列化比较):props 变化时区分两种情况——
  // 与上次写回一致 = 自己 commit 的回声,不能重同步(否则空行又被规整掉);
  // 不一致 = 外部真实变化(换渠道编辑/其他路径写回),才把 props 重同步进草稿
  const lastPushedRef = useRef(
    JSON.stringify(fromRows(toRows(models, modelMap))),
  );
  useEffect(() => {
    const incoming = JSON.stringify({ models, modelMap });
    if (incoming !== lastPushedRef.current) {
      lastPushedRef.current = incoming;
      setRows(toRows(models, modelMap));
    }
  }, [models, modelMap]);

  // 上游拉到的全量候选(勾选来源)
  const [candidates, setCandidates] = useState<string[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [fetching, setFetching] = useState(false);
  // 弹窗内勾选草稿:确认才写回,取消丢弃
  const [draft, setDraft] = useState<string[]>([]);
  const [filter, setFilter] = useState("");

  // 已覆盖的模型名(对外名与上游名都算命中,避免重复添加同义条目)
  const known = new Set<string>([
    ...models,
    ...Object.values(modelMap).filter(Boolean),
  ]);

  // 草稿 → 父层:写回规整结果并记录指纹,草稿本身保留空行
  const commit = (next: ModelRow[]) => {
    setRows(next);
    const normalized = fromRows(next);
    lastPushedRef.current = JSON.stringify(normalized);
    onChange(normalized);
  };

  const patchRow = (i: number, patch: Partial<ModelRow>) => {
    commit(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };

  const removeRow = (i: number) => commit(rows.filter((_, j) => j !== i));

  const fetchModels = async () => {
    setFetching(true);
    try {
      const list = await api.fetchUpstreamModels({
        baseUrl,
        protocol,
        apiKey,
        proxy,
      });
      setCandidates(list);
      setDraft(list.filter((m) => known.has(m)));
      setPickerOpen(true);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setFetching(false);
    }
  };

  const openPicker = () => {
    if (candidates) {
      // 已拉取过:直接开弹窗(候选已含上次结果)
      setDraft(candidates.filter((m) => known.has(m)));
      setPickerOpen(true);
    } else {
      fetchModels();
    }
  };

  const confirmPick = () => {
    // 保留未勾选的既有条目(手填的、上游已下线的),只按勾选增删候选部分
    const cand = candidates ?? [];
    const extras = rows.filter((r) => !cand.includes(r.out) && !cand.includes(r.up));
    // 勾选顺序即行序;上游名留空由用户后续按需填
    const picked: ModelRow[] = draft.map((m) => {
      const hit = rows.find((r) => r.out === m || r.up === m);
      return hit ?? { out: m, up: "" };
    });
    commit([...picked, ...extras]);
    setPickerOpen(false);
  };

  const toggleDraft = (m: string) => {
    setDraft((d) => (d.includes(m) ? d.filter((x) => x !== m) : [...d, m]));
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label>
          支持的模型<span className="ml-0.5 text-destructive">*</span>
          <span className="ml-1 text-muted-foreground">
            (至少一条;上游模型名留空 = 同名透传)
          </span>
        </Label>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          disabled={fetching || !baseUrl.trim() || !apiKey.trim()}
          title={
            !baseUrl.trim() || !apiKey.trim()
              ? "需先填写 Base URL 和 API Key"
              : undefined
          }
          onClick={openPicker}
        >
          {fetching ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          从上游获取
        </Button>
      </div>

      {rows.length > 0 && (
        <>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="flex-1">对外模型名</span>
            <span className="w-4" />
            <span className="flex-1">上游模型名</span>
            <span className="w-9" />
          </div>
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={r.out}
                placeholder="对外模型名"
                className="flex-1 font-mono"
                onChange={(e) => patchRow(i, { out: e.target.value })}
              />
              <span className="w-4 text-center text-xs text-muted-foreground">
                →
              </span>
              <Input
                value={r.up}
                placeholder="留空 = 同名透传"
                className="flex-1 font-mono"
                onChange={(e) => patchRow(i, { up: e.target.value })}
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive"
                title="删除此模型"
                onClick={() => removeRow(i)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </>
      )}

      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => commit([...rows, { out: "", up: "" }])}
        >
          <Plus className="h-3.5 w-3.5" /> 添加一行
        </Button>
        {rows.length > 0 && (
          <span className="text-xs text-muted-foreground">
            共 {rows.filter((r) => r.out.trim()).length} 条
          </span>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        {rows.length === 0
          ? "至少添加一条模型,渠道才会参与路由"
          : "仅列表内模型命中;上游模型名留空则按同名转发到上游"}
      </p>

      {/* 模型选择弹窗:全量候选滚动勾选,含全选/反选与筛选 */}
      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="flex max-h-[70vh] flex-col">
          <DialogHeader>
            <DialogTitle>选择支持的模型</DialogTitle>
            <DialogDescription>
              共 {candidates?.length ?? 0} 个,已选 {draft.length} 个;确认后写入上表
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() =>
                setDraft(
                  draft.length === candidates?.length
                    ? []
                    : [...(candidates ?? [])],
                )
              }
            >
              {draft.length === candidates?.length ? "取消全选" : "全选"}
            </Button>
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="筛选模型名…"
              className="h-7 flex-1 font-mono text-xs"
            />
          </div>
          <div className="min-h-0 flex-1 space-y-0.5 overflow-auto rounded-md border p-2">
            {(candidates ?? [])
              .filter((m) => m.toLowerCase().includes(filter.toLowerCase()))
              .map((m) => (
                <label
                  key={m}
                  className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-accent/50"
                >
                  <input
                    type="checkbox"
                    checked={draft.includes(m)}
                    onChange={() => toggleDraft(m)}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  <span className="font-mono">{m}</span>
                </label>
              ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPickerOpen(false)}>
              取消
            </Button>
            <Button onClick={confirmPick}>确定</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------- 渠道编辑 Dialog ----------

const CHANNEL_PRESETS: Array<{
  label: string;
  dot: string;
  preset: Partial<Channel>;
}> = [
  {
    label: "DeepSeek 官方",
    dot: "bg-cyan-500",
    preset: {
      name: "DeepSeek 官方",
      protocol: "openai",
      baseUrl: "https://api.deepseek.com",
      models: ["deepseek-chat", "deepseek-reasoner"],
      priceCurrency: "cny",
    },
  },
  {
    label: "Anthropic 官方",
    dot: "bg-primary",
    preset: {
      name: "Anthropic 官方",
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.com",
      models: [
        "claude-3-7-sonnet-20250219",
        "claude-3-5-sonnet-20241022",
        "claude-3-5-haiku-20241022",
      ],
      priceCurrency: "usd",
    },
  },
  {
    label: "OpenAI 官方",
    dot: "bg-emerald-500",
    preset: {
      name: "OpenAI 官方",
      protocol: "openai",
      baseUrl: "https://api.openai.com",
      models: ["gpt-4o", "gpt-4o-mini", "o1", "o3-mini"],
      priceCurrency: "usd",
    },
  },
  {
    label: "Google Gemini",
    dot: "bg-indigo-500",
    preset: {
      name: "Google Gemini 官方",
      protocol: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com",
      models: ["gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash"],
      priceCurrency: "usd",
    },
  },
];

function ChannelDialog({
  open,
  editing,
  onClose,
}: {
  open: boolean;
  editing: Channel | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<Channel | null>(editing);
  const [pickingIcon, setPickingIcon] = useState(false);
  // 已揭示明文的 Key 行下标集合:每行独立切换;换编辑对象时整体重置回隐藏
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  // 命名代理池(设置-代理管理):下拉引用,存 proxy:<name> 形式
  const { data: settings } = useSettings();
  const namedProxies = settings?.proxies ?? [];
  const namedByCaseUrl = (url: string) =>
    namedProxies.find((p) => p.url === url);
  useEffect(() => {
    setForm(editing);
    setRevealed(new Set());
  }, [editing]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const f = form!;
      if (f.id === 0) return api.createChannel(f);
      await api.updateChannel(f);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["channels"] });
      toast.success("渠道已保存");
      onClose();
    },
    onError: (e) => toast.error(String(e)),
  });

  if (!form) return null;
  const patch = (p: Partial<Channel>) => setForm({ ...form, ...p });
  // 必填:名称、Base URL、支持的模型(至少一条有效对外模型名)
  // models 里有条目但对外名全是空白(草稿未填完)同样视为未填
  const hasModel = form.models.some((m) => m.trim() !== "");
  const valid = form.name.trim() && form.baseUrl.trim() && hasModel;
  const isImageIcon = form.icon.startsWith("data:image/");

  const pickIcon = async () => {
    setPickingIcon(true);
    try {
      const dataUrl = await api.pickClientIcon();
      if (dataUrl) patch({ icon: dataUrl });
    } catch (e) {
      toast.error(String(e));
    } finally {
      setPickingIcon(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {/* flex 列布局 + 高度上限:滚动发生在中间内容区,Footer 常驻弹窗底部
          (固定悬浮,不随内容滚走)——与密钥编辑弹窗同款三段式 */}
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>{form.id === 0 ? "新建渠道" : "编辑渠道"}</DialogTitle>
        </DialogHeader>
        <div className="-mr-2 grid min-h-0 flex-1 gap-4 overflow-y-auto pr-2">
          {/* 新建渠道时的主流厂商一键模版 */}
          {form.id === 0 && (
            <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-border/80 bg-muted/30 p-2.5 shadow-2xs">
              <span className="mr-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                快速填入预设:
              </span>
              {CHANNEL_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => {
                    patch(p.preset);
                    toast.success(`已载入「${p.label}」模版参数`);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border/80 bg-background/80 px-2 py-1 text-xs font-medium shadow-2xs transition-all hover:border-primary/50 hover:bg-background hover:text-foreground active:scale-95"
                >
                  <span className={cn("h-1.5 w-1.5 rounded-full", p.dot)} />
                  {p.label}
                </button>
              ))}
            </div>
          )}

          {/* 第一行: 名称 + 计费币种 */}
          <div className="grid grid-cols-[minmax(0,1fr)_130px] items-end gap-4">
            <div className="space-y-1.5">
              <Label>名称</Label>
              <div className="flex items-center gap-2">
                {/* 图标按钮:三态——图片(dataURL 预览,点击移除)/存量 emoji(字面显示,
                    点选图覆盖)/空(ImagePlus 占位,点击选图) */}
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9 shrink-0 overflow-hidden p-0 text-base leading-none"
                  title={
                    isImageIcon
                      ? "移除图片图标"
                      : form.icon
                        ? "当前为 emoji 图标,选图将覆盖"
                        : "选择图片图标"
                  }
                  disabled={pickingIcon}
                  onClick={() => {
                    if (isImageIcon) {
                      patch({ icon: "" });
                    } else {
                      pickIcon();
                    }
                  }}
                >
                  {pickingIcon ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : isImageIcon ? (
                    <img src={form.icon} alt="" className="h-full w-full object-contain" />
                  ) : form.icon ? (
                    form.icon
                  ) : (
                    <ImagePlus className="h-4 w-4 text-muted-foreground" />
                  )}
                </Button>
                <Input
                  value={form.name}
                  onChange={(e) => patch({ name: e.target.value })}
                  placeholder="例如:主力中转站(可点左侧按钮选图片图标)"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              {/* 计费币种:该渠道的请求按哪套价格记账(usd 模型未配美元价时回退人民币) */}
              <Label>计费币种</Label>
              <Select
                value={form.priceCurrency || "cny"}
                onValueChange={(v) => patch({ priceCurrency: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cny">人民币 ¥</SelectItem>
                  <SelectItem value="usd">美元 $</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* 第二行: 协议类型独立整行展示 */}
          <div className="space-y-2">
            <Label className="text-xs font-medium">协议类型</Label>
            <div className="grid grid-cols-3 gap-3">
              {[
                {
                  key: "openai" as UpstreamProto,
                  name: "OpenAI 兼容",
                  desc: "/v1/chat/completions",
                  dot: "bg-emerald-500",
                  activeRing: "border-emerald-500/50 ring-2 ring-emerald-500/20 bg-emerald-500/5",
                },
                {
                  key: "anthropic" as UpstreamProto,
                  name: "Anthropic 原生",
                  desc: "/v1/messages",
                  dot: "bg-primary",
                  activeRing: "border-primary/50 ring-2 ring-primary/20 bg-primary/5",
                },
                {
                  key: "gemini" as UpstreamProto,
                  name: "Gemini 原生",
                  desc: "/v1beta/models",
                  dot: "bg-indigo-500",
                  activeRing: "border-indigo-500/50 ring-2 ring-indigo-500/20 bg-indigo-500/5",
                },
              ].map((item) => {
                const active = form.protocol === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => patch({ protocol: item.key })}
                    className={cn(
                      "flex flex-col items-start rounded-xl border p-3 text-left transition-all duration-150 select-none shadow-2xs",
                      active
                        ? item.activeRing
                        : "border-border/80 bg-background/60 hover:bg-muted/40",
                    )}
                  >
                    <div className="flex w-full items-center justify-between">
                      <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                        <span className={cn("h-2 w-2 rounded-full", item.dot)} />
                        {item.name}
                      </span>
                      {active && (
                        <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                      )}
                    </div>
                    <span className="mt-1 font-mono text-[10px] text-muted-foreground/80">
                      {item.desc}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>计费倍率(默认 1;可按模型/节假日/工作日/时段设置)</Label>
            <RateRuleEditor
              value={form.rateRules ?? []}
              onChange={(v) => patch({ rateRules: v })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Base URL</Label>
            <Input
              value={form.baseUrl}
              onChange={(e) => patch({ baseUrl: e.target.value })}
              placeholder={PROTOCOL_PLACEHOLDER[form.protocol]}
              className="font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label>API Key 池(请求时轮询;401/403/429 时自动轮换重试)</Label>
            <div className="space-y-1.5">
              {form.apiKeys.map((k, i) => (
                <div key={i} className="flex items-center gap-2">
                  {/* 相对定位容器:眼睛按钮绝对定位在输入框内右缘,不占输入框宽度。
                      min-w-0 防 flex 溢出,输入框完整显示四边边框(此前被挤裁) */}
                  <div className="relative min-w-0 flex-1">
                    <Input
                      type={revealed.has(i) ? "text" : "password"}
                      value={k}
                      placeholder="sk-..."
                      className="font-mono pr-9"
                      onChange={(e) => {
                        const keys = [...form.apiKeys];
                        keys[i] = e.target.value;
                        patch({ apiKeys: keys });
                      }}
                    />
                    <button
                      type="button"
                      title={revealed.has(i) ? "隐藏明文" : "查看明文"}
                      className="absolute inset-y-0 right-2 my-auto flex h-6 w-6 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                      onClick={() =>
                        setRevealed((prev) => {
                          const next = new Set(prev);
                          if (next.has(i)) next.delete(i);
                          else next.add(i);
                          return next;
                        })
                      }
                    >
                      {revealed.has(i) ? (
                        <EyeOff className="h-3.5 w-3.5" />
                      ) : (
                        <Eye className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    disabled={form.apiKeys.length <= 1}
                    onClick={() =>
                      patch({
                        apiKeys: form.apiKeys.filter((_, j) => j !== i),
                      })
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => patch({ apiKeys: [...form.apiKeys, ""] })}
            >
              <Plus className="h-3.5 w-3.5" /> 添加 Key
            </Button>
          </div>
          {/* 出站代理 + 并发上限:与截图参考一致的两列布局 */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>出站代理</Label>
              <Select
                value={
                  form.proxy === null
                    ? "system"
                    : form.proxy === ""
                      ? "direct"
                      : form.proxy.startsWith("proxy:")
                        ? `named:${form.proxy.slice(6)}`
                        // 旧数据(直接存命名代理 url)按 url 反查名字,避免升级后
                        // 下拉跳"自定义"或映射成 named:<整个URL> 无对应项
                        : namedByCaseUrl(form.proxy)
                          ? `named:${namedByCaseUrl(form.proxy)!.name}`
                          : "custom"
                }
                onValueChange={(v) =>
                  patch({
                    proxy:
                      v === "system"
                        ? null
                        : v === "direct"
                          ? ""
                          // 自定义:清掉引用串给空模板,否则用户面对的是上一次的
                          // proxy:<name>,且下拉值匹配 named 档无法进入编辑
                          : v === "custom"
                            ? "socks5://"
                            : `proxy:${v.slice(6)}`,
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">跟随系统</SelectItem>
                  <SelectItem value="direct">直连(不使用代理)</SelectItem>
                  {namedProxies.map((p) => (
                    <SelectItem key={p.name} value={`named:${p.name}`}>
                      {p.name}
                    </SelectItem>
                  ))}
                  <SelectItem value="custom">自定义</SelectItem>
                </SelectContent>
              </Select>
              {/* 自定义输入框:仅 custom 态显示。proxy:<name> 引用态显示说明文字,
                  误编辑会把引用串覆写成裸字符串,数据面解析直接报错 */}
              {form.proxy !== null &&
                form.proxy !== "" &&
                !namedByCaseUrl(form.proxy) &&
                !form.proxy.startsWith("proxy:") && (
                  <Input
                    value={form.proxy}
                    onChange={(e) => patch({ proxy: e.target.value })}
                    placeholder="socks5://127.0.0.1:7890 或 http://…(可在设置-代理管理添加命名代理)"
                    className="font-mono"
                  />
                )}
              {form.proxy?.startsWith("proxy:") && (
                <p className="text-xs text-muted-foreground">
                  使用命名代理「{form.proxy.slice(6)}」,在 设置-代理管理 中维护地址
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>并发上限</Label>
              <Input
                type="number"
                min="1"
                value={form.maxConcurrency ?? ""}
                placeholder="不限"
                onChange={(e) =>
                  patch({
                    maxConcurrency:
                      e.target.value === ""
                        ? null
                        : Math.max(1, Number(e.target.value) || 1),
                  })
                }
              />
            </div>
          </div>
          <ModelsField
            models={form.models}
            modelMap={form.modelMap}
            onChange={(v) => patch({ models: v.models, modelMap: v.modelMap })}
            baseUrl={form.baseUrl}
            protocol={form.protocol}
            apiKey={form.apiKeys.find((k) => k.trim()) ?? ""}
            proxy={form.proxy}
          />
          <div className="space-y-1.5">
            <Label>备注</Label>
            <Input
              value={form.remark}
              onChange={(e) => patch({ remark: e.target.value })}
            />
            <div className="flex items-center justify-between pt-2">
              <Label>启用渠道</Label>
              <Switch
                checked={form.enabled}
                onCheckedChange={(v) => patch({ enabled: v })}
              />
            </div>
          </div>
        </div>
        {/* Footer 常驻底部:上缘渐变遮罩暗示下方还有内容,滚动内容从其下穿过 */}
        <DialogFooter className="relative shrink-0 items-center gap-2 pt-1">
          <div className="pointer-events-none absolute -top-4 right-0 h-4 w-full bg-gradient-to-t from-background to-transparent" />
          {!valid && (
            <span className="mr-auto text-xs text-muted-foreground">
              {!form.name.trim() && "请填写名称;"}
              {!form.baseUrl.trim() && "请填写 Base URL;"}
              {!hasModel && "至少添加一条支持的模型"}
            </span>
          )}
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={!valid || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            {saveMutation.isPending && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- 连通性测试弹窗 ----------

function TestChannelDialog({
  channel,
  onClose,
  onTested,
}: {
  channel: Channel | null;
  onClose: () => void;
  onTested?: (channelId: number, result: TestChannelResult) => void;
}) {
  const open = channel !== null;
  // 只列当前渠道的对外模型名(白名单):发给上游的是对外名,由网关做映射,
  // 放开自定义会让人误以为要填上游名,与渠道路由语义冲突
  const modelOptions = channel ? channel.models : [];
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("hi");
  const [result, setResult] = useState<TestChannelResult | null>(null);

  // 换渠道时重置表单(避免上次的模型/结果串到别的渠道)
  useEffect(() => {
    if (channel) {
      setModel(channel.models[0] ?? "");
      setPrompt("hi");
      setResult(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel?.id]);

  const mutation = useMutation({
    mutationFn: () =>
      api.testChannel(
        channel!.id,
        prompt.trim() || undefined,
        model || undefined,
      ),
    onSuccess: (r) => {
      setResult(r);
      if (channel) onTested?.(channel.id, r);
    },
    onError: (e) => toast.error(String(e)),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col">
        <DialogHeader>
          <DialogTitle>测试连通性 · {channel?.name}</DialogTitle>
          <DialogDescription>
            发一条真实对话请求到该渠道上游,校验密钥与链路是否可用
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="space-y-1.5">
            <Label>测试模型</Label>
            {modelOptions.length > 0 ? (
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger>
                  <SelectValue placeholder="选择模型" />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                该渠道未配置「支持的模型」,无可选测试模型——请先在渠道编辑中添加
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>测试内容</Label>
            <textarea
              className="flex min-h-[64px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="hi"
            />
            <p className="text-xs text-muted-foreground">
              留空默认发送「hi」;回答越长耗时越久,建议短内容
            </p>
          </div>
        </div>

        {mutation.isPending && (
          <div className="flex flex-col items-center justify-center gap-2.5 py-6 text-center text-xs text-muted-foreground">
            <div className="relative flex h-10 w-10 items-center justify-center">
              <span className="absolute h-10 w-10 animate-ping rounded-full bg-primary/20" />
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            </div>
            <span>正在向上游发送探测并等待握手…</span>
          </div>
        )}

        {result && !mutation.isPending && (
          <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-border/80 bg-muted/15 p-3.5 shadow-2xs">
            {result.ok ? (
              <div className="space-y-3 text-xs">
                {/* 性能指标胶囊阵列 */}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    测试成功
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-md border bg-background/80 px-2 py-0.5 text-muted-foreground shadow-2xs">
                    首字 <span className="font-mono font-medium text-foreground">{result.ttftMs}ms</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-md border bg-background/80 px-2 py-0.5 text-muted-foreground shadow-2xs">
                    总耗时 <span className="font-mono font-medium text-foreground">{result.latencyMs}ms</span>
                  </span>
                  {result.completionTokens != null && (
                    <span className="inline-flex items-center gap-1.5 rounded-md border bg-background/80 px-2 py-0.5 text-muted-foreground shadow-2xs">
                      输出 <span className="font-mono font-medium text-foreground">{result.completionTokens} tok</span>
                    </span>
                  )}
                  {result.model && (
                    <span className="rounded-md border bg-muted/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                      {result.model}
                    </span>
                  )}
                </div>

                {/* 终端回复气泡 */}
                {result.reply && (
                  <div className="relative rounded-xl border border-border/80 bg-background/90 p-3 shadow-2xs">
                    <div className="mb-2 flex items-center justify-between border-b border-border/40 pb-1.5 text-[11px] text-muted-foreground">
                      <span className="flex items-center gap-1.5 font-medium text-foreground/80">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        模型实时回复
                      </span>
                    </div>
                    <div className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground/90">
                      {result.reply}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-start gap-2.5 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="break-words font-medium">{result.message}</span>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
          <Button
            disabled={mutation.isPending || !model}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            开始测试
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LatencyBadge({
  result,
  onRetest,
}: {
  result?: TestChannelResult;
  onRetest: () => void;
}) {
  if (!result) return null;
  if (!result.ok) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRetest();
        }}
        className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-destructive shadow-2xs transition-all hover:bg-destructive/20 active:scale-95 select-none"
        title={`测试失败: ${result.message} (点击重试)`}
      >
        <Zap className="h-2.5 w-2.5" />
        超时失败
      </button>
    );
  }
  const isFast = result.latencyMs < 300;
  const isModerate = result.latencyMs < 1000;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onRetest();
      }}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold shadow-2xs transition-all active:scale-95 select-none",
        isFast
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20"
          : isModerate
            ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20"
            : "border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/20",
      )}
      title={`总耗时: ${result.latencyMs}ms${result.ttftMs != null ? ` · 首字: ${result.ttftMs}ms` : ""} (点击重试)`}
    >
      <Zap className="h-2.5 w-2.5 shrink-0" />
      <span>{result.latencyMs}ms</span>
      {result.ttftMs != null && (
        <span className="opacity-75 font-normal">· {result.ttftMs}ms</span>
      )}
    </button>
  );
}

// ---------- 渠道页 ----------

export function ChannelsPage() {
  const { data: channels, isLoading } = useChannels();
  const { data: breakers } = useBreakerStates();
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Channel | null>(null);
  // 连通性测试弹窗:目标渠道(null = 关闭)
  const [testTarget, setTestTarget] = useState<Channel | null>(null);
  const [copiedUrlId, setCopiedUrlId] = useState<number | null>(null);
  const [batchTesting, setBatchTesting] = useState(false);
  const [latencyMap, setLatencyMap] = useState<Record<number, TestChannelResult>>({});
  const [viewMode, setViewMode] = useState<"table" | "grid">("table");
  // 删除二次确认:主题化弹窗(取代 window.confirm)
  const confirm = useConfirm();

  const breakerOf = (id: number) =>
    breakers?.find((b) => b.channelId === id);

  const refresh = () => qc.invalidateQueries({ queryKey: ["channels"] });

  const runBatchTest = async () => {
    const targets = (channels ?? []).filter((c) => c.enabled);
    if (targets.length === 0) {
      toast.info("暂无启用的渠道可供测试");
      return;
    }
    setBatchTesting(true);
    toast.info(`开始并行测试 ${targets.length} 个渠道…`);
    try {
      const results = await Promise.allSettled(
        targets.map((c) => api.testChannel(c.id, "hi", c.models[0] || undefined)),
      );
      let okCount = 0;
      let failCount = 0;
      const nextMap = { ...latencyMap };
      results.forEach((r, idx) => {
        const c = targets[idx];
        if (r.status === "fulfilled") {
          nextMap[c.id] = r.value;
          if (r.value.ok) okCount++;
          else failCount++;
        } else {
          failCount++;
        }
      });
      setLatencyMap(nextMap);
      refresh();
      qc.invalidateQueries({ queryKey: ["breakers"] });
      if (failCount === 0) {
        toast.success(`全测完成：全部 ${okCount} 个渠道握手成功`);
      } else {
        toast.warning(`全测完成：${okCount} 个成功，${failCount} 个失败`);
      }
    } catch (e) {
      toast.error(`批量测试异常: ${e}`);
    } finally {
      setBatchTesting(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <span>渠道管理</span>
            <span className="font-mono text-xs font-normal text-muted-foreground">
              ({channels?.length ?? 0} 个渠道)
            </span>
          </CardTitle>
          <div className="flex items-center gap-2">
            {/* 表格 / 卡片展台视图切换 */}
            <div className="flex items-center rounded-lg border border-border/80 bg-muted/60 p-0.5 shadow-2xs">
              <button
                type="button"
                onClick={() => setViewMode("table")}
                className={cn(
                  "rounded-md p-1 transition-colors select-none",
                  viewMode === "table"
                    ? "bg-background text-foreground shadow-2xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
                title="紧凑表格视图"
              >
                <LayoutList className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setViewMode("grid")}
                className={cn(
                  "rounded-md p-1 transition-colors select-none",
                  viewMode === "grid"
                    ? "bg-background text-foreground shadow-2xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
                title="立体卡片展台视图"
              >
                <LayoutGrid className="h-3.5 w-3.5" />
              </button>
            </div>

            <Button
              variant="outline"
              size="sm"
              disabled={batchTesting || !channels?.some((c) => c.enabled)}
              onClick={runBatchTest}
              className="gap-1.5 text-xs shadow-2xs"
            >
              <Zap
                className={cn(
                  "h-3.5 w-3.5",
                  batchTesting
                    ? "animate-spin text-amber-500"
                    : "text-amber-500",
                )}
              />
              {batchTesting ? "正在探测…" : "测试全部渠道"}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setEditing(emptyChannel());
                setDialogOpen(true);
              }}
              className="gap-1.5 shadow-2xs"
            >
              <Plus className="h-4 w-4" /> 新建渠道
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              加载中…
            </div>
          ) : !channels?.length ? (
            <div className="py-6">
              <EmptyState
                icon={Cable}
                title="暂无大模型上游渠道"
                description="添加您的第一个大模型 API 渠道（支持 DeepSeek、Anthropic、OpenAI、Gemini 等各大主流厂商）"
              >
                <Button
                  size="sm"
                  onClick={() => {
                    setEditing(emptyChannel());
                    setDialogOpen(true);
                  }}
                  className="gap-1.5 shadow-2xs"
                >
                  <Plus className="h-4 w-4" /> 添加第一个渠道
                </Button>
              </EmptyState>
            </div>
          ) : viewMode === "grid" ? (
            <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2 lg:grid-cols-3">
              {channels.map((ch) => (
                <div
                  key={ch.id}
                  className="card-elevated flex flex-col justify-between rounded-2xl border border-border/80 bg-card p-4 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
                >
                  {/* 顶部: 图标 + 渠道名称 + 协议微标 + 启停开关 */}
                  <div className="flex items-start justify-between gap-2 border-b border-border/40 pb-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border/80 bg-muted/40 text-lg shadow-2xs">
                        {ch.icon ? (
                          ch.icon.startsWith("data:image/") ? (
                            <img src={ch.icon} alt="" className="h-full w-full object-contain" />
                          ) : (
                            <span>{ch.icon}</span>
                          )
                        ) : (
                          <Cable className="h-5 w-5 text-muted-foreground" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <h4 className="truncate text-sm font-semibold text-foreground">
                          {ch.name}
                        </h4>
                        <div className="mt-0.5 flex items-center gap-1.5">
                          <ProtocolBadge protocol={ch.protocol} />
                          {ch.priceCurrency === "usd" && (
                            <span className="rounded border px-1 font-mono text-[10px] text-muted-foreground">
                              USD
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <Switch
                      checked={ch.enabled}
                      onCheckedChange={async () => {
                        try {
                          await api.setChannelEnabled(ch.id, !ch.enabled);
                          refresh();
                        } catch (e) {
                          toast.error(String(e));
                        }
                      }}
                    />
                  </div>

                  {/* 中间: BaseURL + 熔断状态 + 测速 */}
                  <div className="my-3 space-y-2">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span className="max-w-[200px] truncate font-mono text-[11px]" title={ch.baseUrl}>
                        {ch.baseUrl}
                      </span>
                      <button
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(ch.baseUrl);
                            setCopiedUrlId(ch.id);
                            toast.success("BaseURL 已复制");
                            setTimeout(() => setCopiedUrlId(null), 1500);
                          } catch {
                            toast.error("复制失败");
                          }
                        }}
                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        title="复制 BaseURL"
                      >
                        {copiedUrlId === ch.id ? (
                          <Check className="h-3 w-3 text-success" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </button>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      {breakerBadge(ch.enabled, breakerOf(ch.id))}
                      <LatencyBadge
                        result={latencyMap[ch.id]}
                        onRetest={() => setTestTarget(ch)}
                      />
                    </div>
                  </div>

                  {/* 底部: 模型概要 + 动作工具栏 */}
                  <div className="flex items-center justify-between border-t border-border/40 pt-3">
                    <div className="truncate font-mono text-xs text-muted-foreground">
                      {ch.models.length === 0 ? "不限模型" : `${ch.models.length} 个模型`}
                      {Object.keys(ch.modelMap).length > 0 && ` · 映射 ${Object.keys(ch.modelMap).length}`}
                    </div>
                    <div className="flex items-center gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon"
                        title="测试连通性"
                        className="h-7 w-7 text-muted-foreground hover:bg-amber-500/15 hover:text-amber-600 dark:hover:text-amber-400"
                        onClick={() => setTestTarget(ch)}
                      >
                        <Zap className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="手动恢复熔断"
                        className="h-7 w-7 text-muted-foreground hover:bg-sky-500/15 hover:text-sky-600 dark:hover:text-sky-400"
                        onClick={async () => {
                          try {
                            await api.recoverChannel(ch.id);
                            toast.success("已手动恢复");
                          } catch (e) {
                            toast.error(String(e));
                          }
                        }}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="编辑"
                        className="h-7 w-7 text-muted-foreground hover:bg-accent hover:text-foreground"
                        onClick={() => {
                          setEditing(structuredClone(ch));
                          setDialogOpen(true);
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="删除"
                        className="h-7 w-7 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                        onClick={async () => {
                          if (
                            !(await confirm({
                              title: "删除渠道",
                              message: `确认删除渠道「${ch.name}」?其上游密钥与映射将一并移除,且不可恢复。`,
                            }))
                          )
                            return;
                          try {
                            await api.deleteChannel(ch.id);
                            refresh();
                            toast.success("已删除");
                          } catch (e) {
                            toast.error(String(e));
                          }
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">名称</th>
                  <th className="py-2 pr-3 font-medium">协议</th>
                  <th className="py-2 pr-3 font-medium">Base URL</th>
                  <th className="py-2 pr-3 font-medium">密钥</th>
                  <th className="py-2 pr-3 font-medium">模型</th>
                  <th className="py-2 pr-3 font-medium">状态</th>
                  <th className="py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((ch) => (
                  <Fragment key={ch.id}>
                    <tr className="border-b transition-colors duration-150 hover:bg-accent/40 even:bg-muted/15 last:border-0">
                    <td className="py-2.5 pr-3 font-medium">
                      <span className="inline-flex items-center gap-2">
                        {ch.icon && (
                          ch.icon.startsWith("data:image/") ? (
                            <img src={ch.icon} alt="" className="h-5 w-5 object-contain" />
                          ) : (
                            <span className="text-base leading-none">{ch.icon}</span>
                          )
                        )}
                        {ch.name}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3">
                      <div className="flex items-center gap-1.5">
                        <ProtocolBadge protocol={ch.protocol} />
                        {ch.priceCurrency === "usd" && (
                          <Badge variant="secondary" className="px-1.5 text-[10px] font-mono" title="该渠道按美元价格计费">
                            $
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="max-w-[220px] py-2.5 pr-3 font-mono text-xs">
                      <div className="group/url flex items-center justify-between gap-1.5">
                        <span className="truncate text-muted-foreground" title={ch.baseUrl}>
                          {ch.baseUrl}
                        </span>
                        <button
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(ch.baseUrl);
                              setCopiedUrlId(ch.id);
                              toast.success("BaseURL 已复制");
                              setTimeout(() => setCopiedUrlId(null), 1500);
                            } catch {
                              toast.error("复制失败");
                            }
                          }}
                          className="rounded p-0.5 text-muted-foreground/50 opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover/url:opacity-100"
                          title="复制 BaseURL"
                        >
                          {copiedUrlId === ch.id ? (
                            <Check className="h-3 w-3 text-success" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </button>
                      </div>
                    </td>
                    <td className="py-2.5 pr-3 text-xs text-muted-foreground">
                      {ch.apiKeys.length} 个
                      {ch.apiKeys[0] && (
                        <span className="ml-1 font-mono">
                          ({maskKey(ch.apiKeys[0])})
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-xs">
                      <div className="flex flex-wrap items-center gap-1">
                        {ch.models.length === 0 ? (
                          <span className="inline-flex items-center rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                            不限模型
                          </span>
                        ) : (
                          <span
                            className="inline-flex items-center rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-primary shadow-2xs"
                            title={ch.models.join("\n")}
                          >
                            {ch.models.length} 个模型
                          </span>
                        )}
                        {Object.keys(ch.modelMap).length > 0 && (
                          <span
                            className="inline-flex items-center rounded-md border border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-indigo-600 shadow-2xs dark:text-indigo-400"
                            title={Object.entries(ch.modelMap)
                              .map(([from, to]) => `${from} → ${to}`)
                              .join("\n")}
                          >
                            映射 {Object.keys(ch.modelMap).length}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 pr-3">
                      <div className="flex flex-col items-start gap-1">
                        {breakerBadge(ch.enabled, breakerOf(ch.id))}
                        <LatencyBadge
                          result={latencyMap[ch.id]}
                          onRetest={() => setTestTarget(ch)}
                        />
                      </div>
                    </td>
                    <td className="py-2.5">
                      <div className="flex items-center gap-0.5">
                        <Button
                          variant="ghost"
                          size="icon"
                          title="测试连通性"
                          className="h-8 w-8 text-muted-foreground transition-colors hover:bg-amber-500/15 hover:text-amber-600 dark:hover:text-amber-400"
                          onClick={() => setTestTarget(ch)}
                        >
                          <Zap className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title={ch.enabled ? "停用" : "启用"}
                          className={cn(
                            "h-8 w-8 transition-colors",
                            ch.enabled
                              ? "text-muted-foreground hover:bg-muted hover:text-foreground"
                              : "text-muted-foreground/60 hover:bg-emerald-500/15 hover:text-emerald-600 dark:hover:text-emerald-400"
                          )}
                          onClick={async () => {
                            try {
                              await api.setChannelEnabled(ch.id, !ch.enabled);
                              refresh();
                            } catch (e) {
                              toast.error(String(e));
                            }
                          }}
                        >
                          <Power className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="手动恢复熔断"
                          className="h-8 w-8 text-muted-foreground transition-colors hover:bg-sky-500/15 hover:text-sky-600 dark:hover:text-sky-400"
                          onClick={async () => {
                            try {
                              await api.recoverChannel(ch.id);
                              toast.success("已手动恢复");
                            } catch (e) {
                              toast.error(String(e));
                            }
                          }}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="编辑"
                          className="h-8 w-8 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                          onClick={() => {
                            setEditing(structuredClone(ch));
                            setDialogOpen(true);
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="删除"
                          className="h-8 w-8 text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
                          onClick={async () => {
                            // 删除渠道连带其配置,不可恢复:二次确认
                            if (
                              !(await confirm({
                                title: "删除渠道",
                                message: `确认删除渠道「${ch.name}」?其上游密钥与映射将一并移除,且不可恢复。`,
                              }))
                            )
                              return;
                            try {
                              await api.deleteChannel(ch.id);
                              refresh();
                              toast.success("已删除");
                            } catch (e) {
                              toast.error(String(e));
                            }
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <ChannelDialog
        open={dialogOpen}
        editing={editing}
        onClose={() => setDialogOpen(false)}
      />
      <TestChannelDialog
        channel={testTarget}
        onClose={() => setTestTarget(null)}
        onTested={(id, r) => setLatencyMap((prev) => ({ ...prev, [id]: r }))}
      />
      <div className={cn("h-2")} />
    </div>
  );
}
