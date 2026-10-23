import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Cable,
  Loader2,
  Pencil,
  Plus,
  Power,
  RotateCcw,
  Trash2,
  Zap,
} from "lucide-react";
import { api, maskKey } from "@/lib/api";
import { useBreakerStates, useChannels } from "@/hooks/use-gateway";
import type { Channel, UpstreamProto } from "@/lib/types";
import {
  Card,
  CardContent,
  CardDescription,
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
              <Input
                value={form.name}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder="例如:主力中转站"
              />
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
                value={form.proxy === null ? "system" : form.proxy === "" ? "direct" : "custom"}
                onValueChange={(v) =>
                  patch({
                    proxy: v === "system" ? null : v === "direct" ? "" : form.proxy || "http://",
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">跟随系统</SelectItem>
                  <SelectItem value="direct">直连</SelectItem>
                  <SelectItem value="custom">自定义</SelectItem>
                </SelectContent>
              </Select>
              {form.proxy !== null && form.proxy !== "" && (
                <Input
                  value={form.proxy}
                  onChange={(e) => patch({ proxy: e.target.value })}
                  placeholder="http://127.0.0.1:7890"
                  className="font-mono"
                />
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
                      value={
                        (form.breakerOverride?.[k] ?? "") as unknown as number
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

  const breakerOf = (id: number) =>
    breakers?.find((b) => b.channelId === id);

  const testMutation = useMutation({
    mutationFn: (id: number) => api.testChannel(id),
    onMutate: (id) => setTesting(id),
    onSettled: () => setTesting(null),
    onSuccess: (r) =>
      r.ok ? toast.success(r.message) : toast.error(r.message),
    onError: (e) => toast.error(String(e)),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["channels"] });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-4">
          <div>
            <CardTitle className="text-base">渠道管理</CardTitle>
            <CardDescription>
              上游渠道按密钥内配置的顺序做故障转移;熔断后自动跳过,冷却后半开探测
            </CardDescription>
          </div>
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
                  <tr key={ch.id} className="border-b last:border-0">
                    <td className="py-2.5 pr-3 font-medium">{ch.name}</td>
                    <td className="py-2.5 pr-3">
                      <Badge variant="secondary">{ch.protocol}</Badge>
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
                            await api.setChannelEnabled(ch.id, !ch.enabled);
                            refresh();
                          }}
                        >
                          <Power className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="手动恢复熔断"
                          onClick={async () => {
                            await api.recoverChannel(ch.id);
                            toast.success("已手动恢复");
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
                            await api.deleteChannel(ch.id);
                            refresh();
                            toast.success("已删除");
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
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
