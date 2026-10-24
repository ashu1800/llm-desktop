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
  openai: "https://api.openai.com 或中转站地址(不带 /v1)",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
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

// ---------- 模型映射键值对编辑器 ----------

function ModelMapEditor({
  value,
  onChange,
}: {
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
}) {
  const entries = Object.entries(value);
  return (
    <div className="space-y-1.5">
      {entries.map(([k, v], i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            value={k}
            placeholder="入站模型名"
            className="flex-1"
            onChange={(e) => {
              const next = { ...value };
              delete next[k];
              next[e.target.value] = v;
              onChange(next);
            }}
          />
          <span className="text-xs text-muted-foreground">→</span>
          <Input
            value={v}
            placeholder="上游模型名"
            className="flex-1"
            onChange={(e) => onChange({ ...value, [k]: e.target.value })}
          />
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              const next = { ...value };
              delete next[k];
              onChange(next);
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        onClick={() => onChange({ ...value, "": "" })}
      >
        <Plus className="h-3.5 w-3.5" /> 添加映射
      </Button>
      <p className="text-xs text-muted-foreground">
        入站模型名 → 上游模型名,精确匹配;未命中则原样透传
      </p>
    </div>
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
          <DialogDescription>
            上游中转站配置;API Key 本地明文存储,列表中掩码显示
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>名称</Label>
              <div className="flex items-center gap-2">
                {/* 图标预览:emoji/图片渲染,空显示首字符占位 */}
                <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted/40 text-lg leading-none">
                  {form.icon ? (
                    isImageIcon ? (
                      <img src={form.icon} alt="" className="h-full w-full object-contain" />
                    ) : (
                      <span>{form.icon}</span>
                    )
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {form.name.trim().charAt(0).toUpperCase() || "?"}
                    </span>
                  )}
                </div>
                <Input
                  value={form.name}
                  onChange={(e) => patch({ name: e.target.value })}
                  placeholder="例如:主力中转站"
                />
              </div>
              {/* 图标设置:emoji 输入与图片选择互斥,图片优先 */}
              <div className="flex items-center gap-2">
                {isImageIcon ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs"
                    onClick={() => patch({ icon: "" })}
                  >
                    移除图片图标
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1 px-2 text-xs"
                      disabled={pickingIcon}
                      onClick={pickIcon}
                    >
                      {pickingIcon ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <ImagePlus className="h-3 w-3" />
                      )}
                      图片
                    </Button>
                    <Input
                      value={form.icon}
                      onChange={(e) => patch({ icon: e.target.value })}
                      placeholder="或输入 emoji"
                      // 粘贴的 dataURL 通常超 4 字符:图片态放开限制整体接纳,
                      // emoji 态维持 4 字符
                      maxLength={form.icon.startsWith("data:image/") ? 100_000 : 4}
                    />
                  </>
                )}
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
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>代理设置</Label>
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
                  <SelectItem value="direct">直连</SelectItem>
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
              <Label>支持的模型(留空 = 不限制,每行一个)</Label>
              <textarea
                className="flex min-h-[72px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={form.models.join("\n")}
                onChange={(e) =>
                  patch({
                    models: e.target.value
                      .split("\n")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
                placeholder={"gpt-4o\nclaude-sonnet-4"}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>模型映射</Label>
            <ModelMapEditor
              value={form.modelMap}
              onChange={(v) => patch({ modelMap: v })}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>熔断参数覆盖(留空跟随全局)</Label>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ["windowSecs", "窗口秒"],
                    ["consecutiveFailures", "连败阈值"],
                    ["sampleMin", "最小样本"],
                    ["failureRate", "失败率%"],
                    ["cooldownSecs", "冷却秒"],
                    ["backoffMaxSecs", "退避上限秒"],
                  ] as const
                ).map(([k, label]) => (
                  <div key={k} className="flex items-center gap-1">
                    <span className="w-16 shrink-0 text-xs text-muted-foreground">
                      {label}
                    </span>
                    <Input
                      type="number"
                      className="h-8"
                      // failureRate 存 0~1 小数,显示与输入按百分比刻度(与全局设置页一致):
                      // 显示 ×100,回写 /100;否则 0.5 会显示成"0.5"被按 0.5% 误读
                      value={
                        k === "failureRate"
                          ? form.breakerOverride?.[k] != null
                            ? Math.round((form.breakerOverride[k] as number) * 100)
                            : ""
                          : ((form.breakerOverride?.[k] ?? "") as unknown as number)
                      }
                      onChange={(e) => {
                        const raw = e.target.value;
                        const ov = { ...(form.breakerOverride ?? {}) };
                        if (raw === "") delete ov[k];
                        else
                          ov[k] = k === "failureRate"
                            ? Number(raw) / 100
                            : Number(raw);
                        patch({
                          breakerOverride:
                            Object.keys(ov).length === 0 ? null : ov,
                        });
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>超时覆盖(秒,留空跟随全局)</Label>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ["connectSecs", "连接"],
                    ["ttftSecs", "首字"],
                    ["streamIdleSecs", "流空闲"],
                    ["nonStreamTotalSecs", "非流总时长"],
                  ] as const
                ).map(([k, label]) => (
                  <div key={k} className="flex items-center gap-1">
                    <span className="w-16 shrink-0 text-xs text-muted-foreground">
                      {label}
                    </span>
                    <Input
                      type="number"
                      className="h-8"
                      value={
                        form.timeoutOverride?.[k] ??
                        ("" as unknown as number)
                      }
                      onChange={(e) => {
                        const raw = e.target.value;
                        const ov = { ...(form.timeoutOverride ?? {}) };
                        if (raw === "") delete ov[k];
                        else ov[k] = Number(raw);
                        patch({
                          timeoutOverride:
                            Object.keys(ov).length === 0 ? null : ov,
                        });
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>备注</Label>
              <Input
                value={form.remark}
                onChange={(e) => patch({ remark: e.target.value })}
              />
              <div className="pt-2">
                <div className="flex items-center justify-between">
                  <Label>启用渠道</Label>
                  <Switch
                    checked={form.enabled}
                    onCheckedChange={(v) => patch({ enabled: v })}
                  />
                </div>
              </div>
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

// ---------- 渠道页 ----------

export function ChannelsPage() {
  const { data: channels, isLoading } = useChannels();
  const { data: breakers } = useBreakerStates();
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Channel | null>(null);
  const [testing, setTesting] = useState<number | null>(null);
  // 对话测试结果:渠道 id → 最近一次结果(列表行内展开显示)
  const [testResult, setTestResult] = useState<Record<number, TestChannelResult>>({});

  const breakerOf = (id: number) =>
    breakers?.find((b) => b.channelId === id);

  const testMutation = useMutation({
    mutationFn: (id: number) => api.testChannel(id),
    onMutate: (id) => setTesting(id),
    onSettled: () => setTesting(null),
    onSuccess: (r, id) => {
      setTestResult((m) => ({ ...m, [id]: r }));
      if (r.ok) toast.success(r.message);
    },
    onError: (e) => toast.error(String(e)),
  });

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
                          disabled={testing === ch.id}
                          onClick={() => testMutation.mutate(ch.id)}
                        >
                          {testing === ch.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Zap className="h-3.5 w-3.5" />
                          )}
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
                  {/* 对话测试结果:测试后展开在渠道行下方,显示回复内容与性能参数 */}
                  {testResult[ch.id] && (
                    <tr className="border-b last:border-0">
                      <td colSpan={7} className="bg-muted/20 px-3 py-2.5">
                        {(() => {
                          const r = testResult[ch.id];
                          return r.ok ? (
                            <div className="space-y-1.5 text-xs">
                              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                                <span className="font-medium text-emerald-600 dark:text-emerald-400">
                                  ✓ 测试成功
                                </span>
                                <span className="text-muted-foreground">
                                  首字 <span className="font-mono">{r.ttftMs}ms</span>
                                </span>
                                <span className="text-muted-foreground">
                                  总耗时 <span className="font-mono">{r.latencyMs}ms</span>
                                </span>
                                {r.completionTokens != null && (
                                  <span className="text-muted-foreground">
                                    输出 <span className="font-mono">{r.completionTokens} tok</span>
                                  </span>
                                )}
                                {r.model && (
                                  <span className="font-mono text-muted-foreground">
                                    {r.model}
                                  </span>
                                )}
                              </div>
                              {r.reply && (
                                <div className="whitespace-pre-wrap rounded-md border bg-background px-2.5 py-1.5 font-mono leading-5">
                                  {r.reply}
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-destructive">✗ {r.message}</span>
                          );
                        })()}
                      </td>
                    </tr>
                  )}
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
      <div className={cn("h-2")} />
    </div>
  );
}
