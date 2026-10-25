import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Copy,
  GripVertical,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  Power,
  RotateCcw,
  Route,
  Trash2,
} from "lucide-react";
import {
  DndContext,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { api, maskKey } from "@/lib/api";
import {
  useApiKeys,
  useChannels,
  useSettings,
} from "@/hooks/use-gateway";
import type { ApiKey, Channel } from "@/lib/types";
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
import { cn } from "@/lib/utils";

function formatTs(ts: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString("zh-CN", { hour12: false });
}

// ---------- 可排序渠道项 ----------

function SortableChannel({
  id,
  name,
  onRemove,
}: {
  id: number;
  name: string;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className="flex items-center gap-2 rounded-md border bg-background px-2 py-1.5"
    >
      <button
        className="cursor-grab touch-none text-muted-foreground"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <Badge variant="secondary" className="px-1.5">
        {name}
      </Badge>
      <div className="flex-1" />
      <Button variant="ghost" size="icon" onClick={onRemove}>
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

// ---------- 模型白名单与模型级路由编辑器 ----------

/**
 * 从所选渠道聚合"该密钥可用的模型"全集:
 * 渠道白名单(models 非空)取其对外名;渠道不限模型的贡献定价表模型。
 * 仅列仍被勾选的渠道——取消勾选渠道后,只属于它的模型自动从候选消失
 * (已保存的 modelChannels 里指向它的条目仍保留,不静默篡改用户配置)
 */
function useModelCandidates(
  channels: Channel[] | undefined,
  selectedIds: number[],
): string[] {
  return useMemo(() => {
    const selected = new Set(selectedIds);
    const out: string[] = [];
    for (const ch of channels ?? []) {
      if (!selected.has(ch.id) || !ch.enabled) continue;
      for (const m of ch.models) {
        if (!out.includes(m)) out.push(m);
      }
    }
    out.sort();
    return out;
  }, [channels, selectedIds]);
}

function ModelRoutingEditor({
  candidates,
  models,
  modelChannels,
  channelName,
  channelsGlobalOrder,
  onModelsChange,
  onModelChannelsChange,
}: {
  /** 该密钥可用模型全集(来自所选渠道) */
  candidates: string[];
  /** 白名单草稿;空 = 不限制 */
  models: string[];
  modelChannels: Record<string, number[]>;
  channelName: (id: number) => string;
  channelsGlobalOrder: number[];
  onModelsChange: (v: string[]) => void;
  onModelChannelsChange: (v: Record<string, number[]>) => void;
}) {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const limited = models.length > 0;
  const visible = candidates.filter((m) =>
    m.toLowerCase().includes(filter.toLowerCase()),
  );
  const inSet = new Set(models);

  const toggleModel = (m: string) => {
    if (inSet.has(m)) {
      // 取消勾选的同时清掉它的路由定制,避免留脏数据;收起面板
      const nextMc = { ...modelChannels };
      delete nextMc[m];
      onModelsChange(models.filter((x) => x !== m));
      onModelChannelsChange(nextMc);
      if (expanded === m) setExpanded(null);
    } else {
      onModelsChange([...models, m]);
      // 勾选即展开该模型的渠道顺序面板:功能入口不藏按钮后面,
      // 用户勾选的下一个动作大概率就是想配顺序(可发现性)
      setExpanded(m);
    }
  };

  const setModelOrder = (m: string, order: number[]) => {
    onModelChannelsChange({ ...modelChannels, [m]: order });
  };

  const clearModelOrder = (m: string) => {
    const nextMc = { ...modelChannels };
    delete nextMc[m];
    onModelChannelsChange(nextMc);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label>
          可用模型<span className="ml-0.5 text-destructive">*</span>
          <span className="ml-1 text-muted-foreground">
            (来自所选渠道的支持列表;必须至少勾选一个)
          </span>
        </Label>
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="筛选模型…"
          className="h-7 w-36 font-mono text-xs"
        />
      </div>

      {candidates.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          所选渠道未声明支持的模型(渠道"支持的模型"为空时无法枚举),
          请先到渠道管理为渠道配置支持的模型
        </p>
      ) : (
        <div className="max-h-52 space-y-0.5 overflow-auto rounded-md border p-2">
          {visible.map((m) => (
            <div key={m} className="space-y-1">
              <div className="flex items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-accent/50">
                <input
                  type="checkbox"
                  checked={inSet.has(m)}
                  onChange={() => toggleModel(m)}
                  className="h-3.5 w-3.5 accent-primary"
                />
                <span className="flex-1 truncate font-mono">{m}</span>
                {inSet.has(m) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 gap-1 px-1.5 text-[11px] text-muted-foreground"
                    title="为该模型设置渠道调用顺序"
                    onClick={() => setExpanded(expanded === m ? null : m)}
                  >
                    <Route className="h-3 w-3" />
                    {modelChannels[m]?.length
                      ? `${modelChannels[m].length} 渠道`
                      : "按全局"}
                  </Button>
                )}
              </div>
              {inSet.has(m) && expanded === m && (
                <div className="ml-6 rounded-md border bg-muted/30 p-2">
                  <ModelChannelOrder
                    model={m}
                    order={modelChannels[m] ?? []}
                    candidates={channelsGlobalOrder}
                    channelName={channelName}
                    onChange={setModelOrder}
                    onClear={clearModelOrder}
                  />
                </div>
              )}
            </div>
          ))}
          {visible.length === 0 && (
            <p className="px-1 py-2 text-center text-xs text-muted-foreground">
              无匹配模型
            </p>
          )}
        </div>
      )}
      <p className={cn("text-xs", limited ? "text-muted-foreground" : "text-destructive")}>
        {limited
          ? `仅勾选的 ${models.length} 个模型可经此密钥调用;每个模型可单独设置渠道优先顺序,未设置的按全局顺序`
          : "请至少勾选一个可用模型后保存"}
      </p>
    </div>
  );
}

/** 单个模型的渠道路由顺序编辑:勾选定制 + 拖拽排序;清空 = 跟随全局 */
function ModelChannelOrder({
  model,
  order,
  candidates,
  channelName,
  onChange,
  onClear,
}: {
  model: string;
  /** 当前模型的渠道顺序;空 = 跟随全局 */
  order: number[];
  /** 密钥勾选的全部渠道(按全局顺序) */
  candidates: number[];
  channelName: (id: number) => string;
  onChange: (model: string, order: number[]) => void;
  onClear: (model: string) => void;
}) {
  const ordered = order
    .filter((id) => candidates.includes(id))
    .concat(candidates.filter((id) => !order.includes(id)));
  const custom = order.length > 0;

  const toggle = (id: number) => {
    onChange(model, ordered.filter((x) => x !== id));
  };

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = ordered.indexOf(active.id as number);
    const newIdx = ordered.indexOf(over.id as number);
    onChange(model, arrayMove(ordered, oldIdx, newIdx));
  };

  return (
    <div className="space-y-1.5">
      <p className="text-[11px] text-muted-foreground">
        {model} 的渠道调用顺序:
        {custom ? "已定制,从上到下依次尝试" : "当前按全局顺序"}
      </p>
      {custom ? (
        <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext
            items={ordered.map((id) => id)}
            strategy={verticalListSortingStrategy}
          >
            {ordered.map((id, i) => (
              <SortableChannel
                key={id}
                id={id}
                name={`${i + 1}. ${channelName(id)}`}
                onRemove={() => toggle(id)}
              />
            ))}
          </SortableContext>
        </DndContext>
      ) : (
        <div className="flex flex-wrap gap-1">
          {ordered.map((id) => (
            <button
              key={id}
              title="点击此渠道,开始为该模型定制调用顺序(之后可拖拽排序)"
              className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => onChange(model, [id])}
            >
              {channelName(id)}
            </button>
          ))}
        </div>
      )}
      {custom && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"
          onClick={() => onClear(model)}
        >
          <RotateCcw className="h-3 w-3" /> 恢复按全局顺序
        </Button>
      )}
    </div>
  );
}

// ---------- 编辑 Dialog ----------

function KeyDialog({
  open,
  editing,
  onClose,
}: {
  open: boolean;
  editing: ApiKey | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: channels } = useChannels();
  const [form, setForm] = useState<ApiKey | null>(editing);
  const [creating, setCreating] = useState(false);
  const [plaintext, setPlaintext] = useState(false);
  useEffect(() => {
    setForm(editing);
    setCreating(editing?.id === 0);
    // 必须随 editing 重置:否则创建成功(plaintext=true)后,再打开任何对话框
    // 都会以"明文屏"渲染出密钥完整明文(敏感信息泄露)
    setPlaintext(false);
  }, [editing]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const f = form!;
      if (creating) {
        return api.createApiKey(
          f.name,
          f.remark,
          f.channels,
          f.models,
          f.modelChannels,
        );
      }
      await api.updateApiKey(f);
      return null;
    },
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ["keys"] });
      if (created) {
        // 创建:一次性展示明文
        setForm(created);
        setCreating(false);
        setPlaintext(true);
        toast.success("密钥已创建,请立即复制保存明文");
      } else {
        toast.success("密钥已保存");
        onClose();
      }
    },
    onError: (e) => toast.error(String(e)),
  });

  // Hook 必须在所有提前返回之前调用(React Hooks 规则):form 为 null 时不调、
  // 非空时才调,前后两次渲染 Hook 数量不一致会直接抛错白屏(实测翻车)
  const modelCandidates = useModelCandidates(channels, form?.channels ?? []);

  if (!form) return null;
  const patch = (p: Partial<ApiKey>) => setForm({ ...form, ...p });
  // 必填:名称、可用渠道、可用模型(至少各一项;模型不勾选则密钥无法调用任何模型)
  const valid =
    form.name.trim() !== "" &&
    form.channels.length > 0 &&
    form.models.length > 0;
  const selected = new Set(form.channels);
  const channelName = (id: number) =>
    channels?.find((c) => c.id === id)?.name ?? `#${id}`;
  const orderedSelected = form.channels
    .map((id) => ({ id, name: channelName(id) }))
    .filter((c) => selected.has(c.id));

  const toggleChannel = (id: number) => {
    if (selected.has(id)) {
      patch({ channels: form.channels.filter((c) => c !== id) });
    } else {
      patch({ channels: [...form.channels, id] });
    }
  };

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = form.channels.indexOf(active.id as number);
    const newIdx = form.channels.indexOf(over.id as number);
    patch({ channels: arrayMove(form.channels, oldIdx, newIdx) });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {/* flex 列布局 + 高度上限:滚动发生在中间内容区,Footer 常驻弹窗底部
          (固定悬浮,不随内容滚走);overflow-hidden 由内容区负责滚动 */}
      <DialogContent className="flex max-h-[85vh] max-w-xl flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            {plaintext ? "请立即保存密钥明文" : creating ? "创建密钥" : "编辑密钥"}
          </DialogTitle>
          {/* Radix Dialog 要求 Description 存在(无障碍警告),用 sr-only 空描述占位 */}
          <DialogDescription className="sr-only">
            密钥配置
          </DialogDescription>
        </DialogHeader>
        <div className="-mr-2 grid min-h-0 flex-1 gap-4 overflow-y-auto pr-2">
          {plaintext ? (
            <div className="space-y-2">
              <div className="rounded-md border bg-muted/40 p-3 text-center">
                <code className="break-all font-mono text-sm">{form.key}</code>
              </div>
              <Button
                variant="outline"
                className="w-full"
                onClick={async () => {
                  await navigator.clipboard.writeText(form.key);
                  toast.success("已复制到剪贴板");
                }}
              >
                <Copy className="h-4 w-4" /> 复制密钥
              </Button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>名称</Label>
                  <Input
                    value={form.name}
                    onChange={(e) => patch({ name: e.target.value })}
                    placeholder="例如:Claude Code"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>备注</Label>
                  <Input
                    value={form.remark}
                    onChange={(e) => patch({ remark: e.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>可用渠道(勾选后可拖拽排序)</Label>
                <div className="grid grid-cols-2 gap-1.5">
                  {(channels ?? []).map((ch) => (
                    <label
                      key={ch.id}
                      className="flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm hover:bg-accent/50"
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(ch.id)}
                        onChange={() => toggleChannel(ch.id)}
                        className="accent-primary"
                      />
                      <span className="truncate">{ch.name}</span>
                      {!ch.enabled && (
                        <Badge variant="muted" className="ml-auto px-1">
                          已停用
                        </Badge>
                      )}
                    </label>
                  ))}
                </div>
                {orderedSelected.length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    <p className="text-xs text-muted-foreground">
                      故障转移顺序(从上到下):
                    </p>
                    <DndContext
                      collisionDetection={closestCenter}
                      onDragEnd={onDragEnd}
                    >
                      <SortableContext
                        items={orderedSelected.map((c) => c.id)}
                        strategy={verticalListSortingStrategy}
                      >
                        {orderedSelected.map((c, i) => (
                          <SortableChannel
                            key={c.id}
                            id={c.id}
                            name={`${i + 1}. ${c.name}`}
                            onRemove={() => toggleChannel(c.id)}
                          />
                        ))}
                      </SortableContext>
                    </DndContext>
                  </div>
                )}
              </div>
              {/* 模型白名单 + 模型级渠道路由:
                  候选 = 所选渠道"支持的模型"并集;不勾选 = 不限制 */}
              <ModelRoutingEditor
                candidates={modelCandidates}
                models={form.models}
                modelChannels={form.modelChannels}
                channelName={channelName}
                channelsGlobalOrder={form.channels}
                onModelsChange={(v) => patch({ models: v })}
                onModelChannelsChange={(v) => patch({ modelChannels: v })}
              />
              <div className="flex items-center justify-between">
                <Label>启用</Label>
                <Switch
                  checked={form.enabled}
                  onCheckedChange={(v) => patch({ enabled: v })}
                />
              </div>
            </>
          )}
        </div>
        {/* Footer 常驻底部:上缘渐变遮罩暗示下方还有内容,滚动内容从其下穿过 */}
        <DialogFooter className="relative shrink-0 items-center gap-2 pt-1">
          <div className="pointer-events-none absolute -top-4 right-0 h-4 w-full bg-gradient-to-t from-background to-transparent" />
          {plaintext ? (
            <Button onClick={onClose}>我已保存,关闭</Button>
          ) : (
            <>
              {!valid && (
                <span className="mr-auto text-xs text-muted-foreground">
                  {!form.name.trim() && "请填写名称;"}
                  {form.channels.length === 0 && "请勾选可用渠道;"}
                  {form.models.length === 0 && "请至少勾选一个可用模型"}
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
                {creating ? "创建并生成密钥" : "保存"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- 密钥页 ----------

export function KeysPage() {
  const { data: keys, isLoading } = useApiKeys();
  const { data: settings } = useSettings();
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ApiKey | null>(null);

  const emptyKey = useMemo(
    () => () =>
      ({
        id: 0,
        name: "",
        key: "",
        enabled: true,
        channels: [],
        models: [],
        modelChannels: {},
        remark: "",
        createdAt: 0,
        lastUsedAt: null,
      }) as ApiKey,
    [],
  );

  const refresh = () => qc.invalidateQueries({ queryKey: ["keys"] });

  // 客户端接入地址:监听地址+端口+/v1,复制后贴给任意 OpenAI 兼容客户端即可用
  const baseURL = `http://${settings?.listenAddr ?? "127.0.0.1"}:${settings?.port ?? 8787}/v1`;
  const copyBaseURL = async () => {
    try {
      await navigator.clipboard.writeText(baseURL);
      toast.success("BaseURL 已复制");
    } catch {
      toast.error("复制失败,请手动复制: " + baseURL);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-4">
          <CardTitle className="text-base">密钥管理</CardTitle>
          <div className="flex items-center gap-2">
            {/* BaseURL 一键复制:客户端接入网关的入口地址 */}
            <button
              onClick={copyBaseURL}
              title="点击复制客户端接入地址"
              className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 py-1.5 text-xs transition-colors hover:bg-accent"
            >
              <span className="text-muted-foreground">BaseURL</span>
              <span className="font-mono text-muted-foreground">{baseURL}</span>
              <Copy className="h-3 w-3" />
            </button>
            <Button
              size="sm"
              onClick={() => {
                setEditing(emptyKey());
                setDialogOpen(true);
              }}
            >
              <Plus className="h-4 w-4" /> 创建密钥
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              加载中…
            </div>
          ) : !keys?.length ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <KeyRound className="h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                还没有密钥,创建后分发给客户端使用
              </p>
            </div>
          ) : (
            <table className="w-full table-fixed text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  {/* 列宽:名称/密钥/渠道自适应,状态定宽,操作列固定最右带分隔线
                      (与定价页同款布局) */}
                  <th className="py-2 pr-3 font-medium">名称</th>
                  <th className="py-2 pr-3 font-medium">密钥</th>
                  <th className="w-36 py-2 pr-3 font-medium">可用渠道</th>
                  <th className="w-40 py-2 pr-3 font-medium">最近使用</th>
                  <th className="w-20 py-2 pr-3 font-medium">状态</th>
                  <th className="w-28 border-l py-2 text-center font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id} className="border-b last:border-0">
                    <td className="py-2.5 pr-3 font-medium">{k.name}</td>
                    <td className="py-2.5 pr-3">
                      <button
                        className="flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground"
                        title="复制完整密钥"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(k.key);
                            toast.success("完整密钥已复制");
                          } catch {
                            toast.error("复制失败,请手动选择复制");
                          }
                        }}
                      >
                        {maskKey(k.key)}
                        <Copy className="h-3 w-3" />
                      </button>
                    </td>
                    <td className="max-w-[260px] py-2.5 pr-3 text-xs text-muted-foreground">
                      {k.channels.length === 0
                        ? "—"
                        : k.channels
                            .map((id) => `#${id}`)
                            .join(" → ")}
                      {k.models.length > 0 && (
                        <span
                          title={k.models.join(", ")}
                          className="ml-1 inline-block"
                        >
                          · {k.models.length} 模型
                        </span>
                      )}
                      {Object.keys(k.modelChannels ?? {}).length > 0 && (
                        <span title="存在模型级渠道路由定制" className="ml-1">
                          · <Route className="inline h-3 w-3" />
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-xs text-muted-foreground">
                      {formatTs(k.lastUsedAt)}
                    </td>
                    <td className="py-2.5 pr-3">
                      {k.enabled ? (
                        <Badge variant="success">启用</Badge>
                      ) : (
                        <Badge variant="muted">禁用</Badge>
                      )}
                    </td>
                    <td className="border-l py-2.5">
                      <div className="flex items-center justify-end gap-0.5">
                        <Button
                          variant="ghost"
                          size="icon"
                          title={k.enabled ? "禁用" : "启用"}
                          onClick={async () => {
                            try {
                              await api.setApiKeyEnabled(k.id, !k.enabled);
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
                          title="编辑"
                          onClick={() => {
                            setEditing(structuredClone(k));
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
                            if (
                              !window.confirm(
                                `确认删除密钥「${k.name}」?使用该密钥的客户端将立即无法访问,且不可恢复。`,
                              )
                            )
                              return;
                            try {
                              await api.deleteApiKey(k.id);
                              refresh();
                              toast.success("已删除(历史日志保留)");
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
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
      <KeyDialog
        open={dialogOpen}
        editing={editing}
        onClose={() => setDialogOpen(false)}
      />
      <div className={cn("h-2")} />
    </div>
  );
}
