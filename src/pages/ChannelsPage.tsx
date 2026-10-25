import { Fragment, useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Cable,
  ImagePlus,
  Loader2,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
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
  if (!enabled) return <Badge variant="muted">已禁用</Badge>;
  if (!breaker || breaker.state === "closed")
    return <Badge variant="success">正常</Badge>;
  if (breaker.state === "open")
    return (
      <Badge variant="destructive">熔断中 {breaker.remainingSecs}s</Badge>
    );
  return <Badge variant="warning">冷却探测中</Badge>;
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
  const fmtRule = (r: RateRule) => {
    const model = r.model.trim() || "全部模型";
    const day = DAY_TYPE_OPTIONS.find((d) => d.value === r.dayType)?.label ?? r.dayType;
    const time = r.timeRange.trim() ? ` ${r.timeRange}` : "";
    return `${model} · ${day}${time} · ×${r.rate}`;
  };

  return (
    <div className="space-y-1.5">
      {rules.map((r, i) => (
        <div key={i} className="space-y-1 rounded-lg border bg-muted/30 px-2.5 py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              value={r.model}
              onChange={(e) => patch(i, { model: e.target.value })}
              placeholder="模型(gpt* 通配,空=全部)"
              className="h-7 w-40 font-mono text-xs"
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
              className="h-7 w-16 text-xs"
            />
            <Select value={r.dayType || "all"} onValueChange={(v) => patch(i, { dayType: v })}>
              <SelectTrigger className="h-7 w-28 text-xs">
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
              className="h-7 w-32 font-mono text-xs"
            />
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto h-7 w-7 text-muted-foreground hover:text-destructive"
              title="删除规则"
              onClick={() => onChange(rules.filter((_, j) => j !== i))}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
          <Input
            value={r.remark}
            onChange={(e) => patch(i, { remark: e.target.value })}
            placeholder="备注,如:春节 5 折"
            className="h-6 w-full border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
            maxLength={30}
          />
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
      {rules.length > 0 && (
        <p className="text-xs text-muted-foreground">
          请求按规则从上到下匹配,命中多条时以最后一条为准;费用 = 定价 × 倍率。
          已配置:{rules.map(fmtRule).join(" / ")}
        </p>
      )}
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
    up: modelMap[m] && modelMap[m] !== m ? modelMap[m] : "",
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
    // 上游名与对外名相同则不必存映射(等价于透传)
    if (up && up !== out) modelMap[out] = up;
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
  const rows = toRows(models, modelMap);
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

  const commit = (next: ModelRow[]) => onChange(fromRows(next));

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
          支持的模型
          <span className="ml-1 text-muted-foreground">
            (留空 = 不限制;上游模型名留空 = 同名透传)
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
            共 {rows.length} 条
          </span>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        {rows.length === 0
          ? "留空 = 不限制,任何模型都路由到此渠道"
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
  // 命名代理池(设置-代理管理):下拉引用,存 proxy:<name> 形式
  const { data: settings } = useSettings();
  const namedProxies = settings?.proxies ?? [];
  const namedByCaseUrl = (url: string) =>
    namedProxies.find((p) => p.url === url);
  useEffect(() => setForm(editing), [editing]);

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
  const valid = form.name.trim() && form.baseUrl.trim();
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
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-auto">
        <DialogHeader>
          <DialogTitle>{form.id === 0 ? "新建渠道" : "编辑渠道"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-4">
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
              <Label>协议类型</Label>
              <Select
                value={form.protocol}
                onValueChange={(v) => patch({ protocol: v as UpstreamProto })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI 兼容</SelectItem>
                  <SelectItem value="anthropic">Anthropic 原生</SelectItem>
                  <SelectItem value="gemini">Gemini 原生</SelectItem>
                </SelectContent>
              </Select>
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
                  <Input
                    type="password"
                    value={k}
                    placeholder="sk-..."
                    className="font-mono"
                    onChange={(e) => {
                      const keys = [...form.apiKeys];
                      keys[i] = e.target.value;
                      patch({ apiKeys: keys });
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
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
        <DialogFooter>
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
}: {
  channel: Channel | null;
  onClose: () => void;
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
    onSuccess: (r) => setResult(r),
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

        {result && (
          <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/20 p-2.5">
            {result.ok ? (
              <div className="space-y-1.5 text-xs">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="font-medium text-emerald-600 dark:text-emerald-400">
                    ✓ 测试成功
                  </span>
                  <span className="text-muted-foreground">
                    首字 <span className="font-mono">{result.ttftMs}ms</span>
                  </span>
                  <span className="text-muted-foreground">
                    总耗时 <span className="font-mono">{result.latencyMs}ms</span>
                  </span>
                  {result.completionTokens != null && (
                    <span className="text-muted-foreground">
                      输出{" "}
                      <span className="font-mono">
                        {result.completionTokens} tok
                      </span>
                    </span>
                  )}
                  {result.model && (
                    <span className="font-mono text-muted-foreground">
                      {result.model}
                    </span>
                  )}
                </div>
                {result.reply && (
                  <div className="whitespace-pre-wrap break-words rounded-md border bg-background px-2.5 py-1.5 font-mono leading-5">
                    {result.reply}
                  </div>
                )}
              </div>
            ) : (
              <span className="text-xs text-destructive">
                ✗ {result.message}
              </span>
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

// ---------- 渠道页 ----------

export function ChannelsPage() {
  const { data: channels, isLoading } = useChannels();
  const { data: breakers } = useBreakerStates();
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Channel | null>(null);
  // 连通性测试弹窗:目标渠道(null = 关闭)
  const [testTarget, setTestTarget] = useState<Channel | null>(null);

  const breakerOf = (id: number) =>
    breakers?.find((b) => b.channelId === id);

  const refresh = () => qc.invalidateQueries({ queryKey: ["channels"] });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-4">
          <CardTitle className="text-base">渠道管理</CardTitle>
          <Button
            size="sm"
            onClick={() => {
              setEditing(emptyChannel());
              setDialogOpen(true);
            }}
          >
            <Plus className="h-4 w-4" /> 新建渠道
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              加载中…
            </div>
          ) : !channels?.length ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <Cable className="h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                还没有渠道,点击"新建渠道"添加上游
              </p>
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
                    <tr className="border-b last:border-0">
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
                      <Badge variant="secondary">{ch.protocol}</Badge>
                      {ch.priceCurrency === "usd" && (
                        <Badge variant="secondary" className="px-1.5" title="该渠道按美元价格计费">
                          $
                        </Badge>
                      )}
                    </td>
                    <td className="max-w-[220px] truncate py-2.5 pr-3 font-mono text-xs text-muted-foreground">
                      {ch.baseUrl}
                    </td>
                    <td className="py-2.5 pr-3 text-xs text-muted-foreground">
                      {ch.apiKeys.length} 个
                      {ch.apiKeys[0] && (
                        <span className="ml-1 font-mono">
                          ({maskKey(ch.apiKeys[0])})
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-xs text-muted-foreground">
                      {ch.models.length === 0
                        ? "不限"
                        : `${ch.models.length} 个`}
                      {Object.keys(ch.modelMap).length > 0 && (
                        <span> · 映射 {Object.keys(ch.modelMap).length}</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3">
                      {breakerBadge(ch.enabled, breakerOf(ch.id))}
                    </td>
                    <td className="py-2.5">
                      <div className="flex items-center gap-0.5">
                        <Button
                          variant="ghost"
                          size="icon"
                          title="测试连通性"
                          onClick={() => setTestTarget(ch)}
                        >
                          <Zap className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title={ch.enabled ? "停用" : "启用"}
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
                          onClick={async () => {
                            // 删除渠道连带其配置,不可恢复:二次确认
                            if (
                              !window.confirm(
                                `确认删除渠道「${ch.name}」?其上游密钥与映射将一并移除,且不可恢复。`,
                              )
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
      />
      <div className={cn("h-2")} />
    </div>
  );
}
