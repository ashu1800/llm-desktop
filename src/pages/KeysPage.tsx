import { Fragment, useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Copy,
  GripVertical,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  Power,
  RotateCcw,
  Route,
  Smartphone,
  Trash2,
  Zap,
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
  useLanIp,
  useSettings,
} from "@/hooks/use-gateway";
import type { ApiKey, Channel } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { useConfirm } from "@/components/ConfirmDialog";
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

function formatTs(ts: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString("zh-CN", { hour12: false });
}

function formatRelativeTime(ts: number | null): string {
  if (!ts) return "从未调用";
  const diffSecs = Math.floor((Date.now() - ts) / 1000);
  if (diffSecs < 60) return "刚刚";
  if (diffSecs < 3600) return `${Math.floor(diffSecs / 60)} 分钟前`;
  if (diffSecs < 86400) return `${Math.floor(diffSecs / 3600)} 小时前`;
  if (diffSecs < 86400 * 7) return `${Math.floor(diffSecs / 86400)} 天前`;
  return formatTs(ts);
}

// ---------- 可排序渠道项 ----------

function SortableChannel({
  id,
  name,
  orderIndex,
  onRemove,
}: {
  id: number;
  name: string;
  orderIndex?: number;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex items-center gap-2 rounded-xl border px-2.5 py-1.5 transition-all select-none",
        isDragging
          ? "scale-[1.02] border-primary/60 bg-background/95 shadow-lg ring-2 ring-primary/20 z-30"
          : "border-border/80 bg-background/80 shadow-2xs hover:border-border hover:bg-background"
      )}
    >
      <button
        className="cursor-grab active:cursor-grabbing touch-none rounded p-1 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
        {...attributes}
        {...listeners}
        title="拖拽调整优先级"
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      {orderIndex != null && (
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary ring-1 ring-inset ring-primary/25">
          {orderIndex}
        </span>
      )}
      <span className="text-xs font-medium text-foreground">
        {name}
      </span>
      <div className="flex-1" />
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
        onClick={onRemove}
        title="移除渠道"
      >
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

/** 渠道能否服务该对外模型名——与后端 channel_supports 判定完全一致:
 *  白名单为空 = 不限模型;白名单同时接受对外名与映射后的上游名(旧数据可能存的是上游名) */
function channelSupportsModel(ch: Channel, m: string): boolean {
  if (ch.models.length === 0) return true;
  const mapped = ch.modelMap[m] ?? m;
  return ch.models.includes(m) || ch.models.includes(mapped);
}

function ModelRoutingEditor({
  candidates,
  models,
  modelChannels,
  channelName,
  selectedChannels,
  onModelsChange,
  onModelChannelsChange,
}: {
  /** 该密钥可用模型全集(来自所选渠道) */
  candidates: string[];
  /** 白名单草稿;空 = 不限制 */
  models: string[];
  modelChannels: Record<string, number[]>;
  channelName: (id: number) => string;
  /** 密钥勾选且启用的渠道(按全局顺序) */
  selectedChannels: Channel[];
  onModelsChange: (v: string[]) => void;
  onModelChannelsChange: (v: Record<string, number[]>) => void;
}) {
  // 模型级路由候选:只有"支持该模型"的渠道才进排序列表。
  // 不支持的渠道在后端请求循环会被 channel_supports 跳过、永远分不到流量,
  // 列进 UI 只会误导用户以为它在参与故障转移
  const routingCandidates = (m: string) =>
    selectedChannels
      .filter((ch) => channelSupportsModel(ch, m))
      .map((ch) => ch.id);
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
          <span className="ml-1 text-muted-foreground text-xs font-normal">
            (勾选后生效)
          </span>
        </Label>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => onModelsChange(Array.from(new Set([...models, ...visible])))}
          >
            全选
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-destructive"
            onClick={() => onModelsChange([])}
          >
            清空
          </Button>
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="筛选模型…"
            className="h-7 w-28 font-mono text-xs"
          />
        </div>
      </div>

      {candidates.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          所选渠道未声明支持的模型(渠道"支持的模型"为空时无法枚举),
          请先到渠道管理为渠道配置支持的模型
        </p>
      ) : (
        <div className="max-h-52 space-y-1 overflow-auto rounded-xl border border-border/80 bg-background/50 p-2 shadow-2xs">
          {visible.map((m) => (
            <div key={m} className="space-y-1">
              <div
                className={cn(
                  "flex items-center gap-2 rounded-lg px-2 py-1 text-xs transition-colors",
                  inSet.has(m)
                    ? "border border-primary/30 bg-primary/5 text-foreground font-medium"
                    : "hover:bg-accent/50 text-muted-foreground",
                )}
              >
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
                    {(() => {
                      // 只统计仍支持该模型的条目,与展开面板列出的渠道一致
                      const cands = routingCandidates(m);
                      const n = (modelChannels[m] ?? []).filter((id) =>
                        cands.includes(id),
                      ).length;
                      return n ? `${n} 渠道` : "按全局";
                    })()}
                  </Button>
                )}
              </div>
              {inSet.has(m) && expanded === m && (
                <div className="ml-6 rounded-md border bg-muted/30 p-2">
                  <ModelChannelOrder
                    model={m}
                    order={modelChannels[m] ?? []}
                    candidates={routingCandidates(m)}
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
  /** 支持该模型的勾选渠道(按密钥全局顺序) */
  candidates: number[];
  channelName: (id: number) => string;
  onChange: (model: string, order: number[]) => void;
  onClear: (model: string) => void;
}) {
  const ordered = order
    .filter((id) => candidates.includes(id))
    .concat(candidates.filter((id) => !order.includes(id)));
  // 已存顺序里没有任何仍支持该模型的渠道时,视同"跟随全局"(与行内徽标口径一致)
  const custom = order.some((id) => candidates.includes(id));

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
                orderIndex={i + 1}
                name={channelName(id)}
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
  const [copiedNewKey, setCopiedNewKey] = useState(false);
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
  // 模型级路由候选渠道:按密钥全局顺序,只取启用中的渠道
  // (停用渠道后端请求循环直接跳过,与上方 useModelCandidates 的口径一致)
  const selectedChannels = (channels ?? []).filter(
    (ch) => selected.has(ch.id) && ch.enabled,
  );

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
            <div className="space-y-4 py-2">
              <div className="flex flex-col items-center text-center">
                <div className="relative mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-600 ring-1 ring-inset ring-emerald-500/30 dark:text-emerald-400 shadow-2xs">
                  <KeyRound className="h-6 w-6" />
                </div>
                <h3 className="text-base font-semibold text-foreground">
                  API 访问凭据已安全生成
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  用于第三方客户端与应用通过网关调用大模型的专属认证密钥
                </p>
              </div>

              {/* 明文金库代码舱 */}
              <div className="relative rounded-xl border border-primary/30 bg-primary/5 p-4 shadow-2xs">
                <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span className="font-medium text-foreground/80">密钥明文 (Secret Key)</span>
                  <span className="text-[11px] font-mono">{form.name}</span>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border/80 bg-background/90 p-2.5 shadow-inner">
                  <code className="select-all break-all font-mono text-xs font-semibold text-foreground">
                    {form.key}
                  </code>
                  <Button
                    size="sm"
                    className="shrink-0 gap-1.5 shadow-2xs text-xs"
                    onClick={async () => {
                      await navigator.clipboard.writeText(form.key);
                      setCopiedNewKey(true);
                      toast.success("密钥明文已复制");
                      setTimeout(() => setCopiedNewKey(false), 2000);
                    }}
                  >
                    {copiedNewKey ? (
                      <Check className="h-3.5 w-3.5 text-success" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    {copiedNewKey ? "已复制" : "复制"}
                  </Button>
                </div>
              </div>

              {/* 安全防泄密/防丢失警示 */}
              <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <span className="leading-relaxed">
                  <strong>安全提示：</strong>这是您唯一一次查看完整密钥明文的机会。关闭此弹窗后，网关将对其执行脱敏保护，不可再次反查明文。请务必立即复制并保存至您的客户端或密码管理器。
                </span>
              </div>
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
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-all shadow-2xs select-none",
                        selected.has(ch.id)
                          ? "border-primary/50 bg-primary/5 font-medium text-foreground"
                          : "border-border/80 bg-background/60 text-muted-foreground hover:bg-muted/40",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(ch.id)}
                        onChange={() => toggleChannel(ch.id)}
                        className="h-3.5 w-3.5 accent-primary"
                      />
                      <span className="truncate">{ch.name}</span>
                      {!ch.enabled && (
                        <Badge variant="muted" className="ml-auto px-1 text-[10px]">
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
                            orderIndex={i + 1}
                            name={c.name}
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
                selectedChannels={selectedChannels}
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
            <Button
              className="w-full gap-2 shadow-xs"
              onClick={async () => {
                await navigator.clipboard.writeText(form.key);
                toast.success("已复制并安全退出");
                onClose();
              }}
            >
              <Check className="h-4 w-4" /> 一键复制密钥并完成
            </Button>
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

interface TestKeyResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  model: string;
  reply?: string;
  tokens?: { prompt: number; completion: number };
  error?: string;
}

function TestKeyDialog({
  apiKey,
  onClose,
}: {
  apiKey: ApiKey | null;
  onClose: () => void;
}) {
  const { data: settings } = useSettings();
  const open = apiKey !== null;
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("hi");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestKeyResult | null>(null);

  useEffect(() => {
    if (apiKey) {
      setModel(apiKey.models[0] ?? "");
      setPrompt("hi");
      setResult(null);
    }
  }, [apiKey?.id]);

  const runTest = async () => {
    if (!apiKey || !settings) return;
    setTesting(true);
    setResult(null);
    const host = `http://${settings.listenAddr === "0.0.0.0" ? "127.0.0.1" : settings.listenAddr}:${settings.port}/v1/chat/completions`;
    const t0 = performance.now();
    try {
      const resp = await fetch(host, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey.key}`,
        },
        body: JSON.stringify({
          model: model || undefined,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 40,
        }),
      });
      const latencyMs = Math.round(performance.now() - t0);
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setResult({
          ok: false,
          status: resp.status,
          latencyMs,
          model,
          error: data?.error?.message || `HTTP ${resp.status} ${resp.statusText}`,
        });
      } else {
        const reply = data?.choices?.[0]?.message?.content || "";
        setResult({
          ok: true,
          status: resp.status,
          latencyMs,
          model: data?.model || model,
          reply,
          tokens: data?.usage
            ? {
                prompt: data.usage.prompt_tokens,
                completion: data.usage.completion_tokens,
              }
            : undefined,
        });
        toast.success(`自检成功 (${latencyMs}ms)`);
      }
    } catch (e) {
      const latencyMs = Math.round(performance.now() - t0);
      setResult({
        ok: false,
        status: 0,
        latencyMs,
        model,
        error: String(e),
      });
      toast.error(`自检失败: ${e}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-amber-500" />
            <span>密钥端到端自检诊断</span>
          </DialogTitle>
          <DialogDescription>
            以密钥「{apiKey?.name}」身份向网关发送真实调用，检验鉴权、模型匹配与路由
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">测试模型</Label>
              {apiKey && apiKey.models.length > 0 ? (
                <Select value={model} onValueChange={setModel}>
                  <SelectTrigger className="h-8 font-mono text-xs">
                    <SelectValue placeholder="选择模型" />
                  </SelectTrigger>
                  <SelectContent>
                    {apiKey.models.map((m) => (
                      <SelectItem
                        key={m}
                        value={m}
                        className="font-mono text-xs"
                      >
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="输入任意模型名"
                  className="h-8 font-mono text-xs"
                />
              )}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">测试消息</Label>
              <Input
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Prompt"
                className="h-8 text-xs"
              />
            </div>
          </div>

          {result && (
            <div className="space-y-3 rounded-xl border border-border/80 bg-muted/20 p-3.5 shadow-2xs">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-2">
                <div className="flex items-center gap-2 text-xs">
                  {result.ok ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                      ✓ 认证与路由成功 ({result.status})
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold text-destructive">
                      ✗ 调用失败 ({result.status})
                    </span>
                  )}
                  <span className="font-mono text-[11px] text-muted-foreground">
                    ⚡ {result.latencyMs}ms
                  </span>
                </div>
                {result.tokens && (
                  <span className="font-mono text-[11px] text-muted-foreground">
                    Token: {result.tokens.prompt} 入 · {result.tokens.completion} 出
                  </span>
                )}
              </div>

              {result.ok ? (
                <div className="space-y-1">
                  <span className="text-[11px] text-muted-foreground">回复内容:</span>
                  <div className="max-h-36 overflow-y-auto rounded-lg border border-border/70 bg-background/80 p-2.5 font-mono text-xs leading-relaxed text-foreground select-text">
                    {result.reply || "(无文本输出)"}
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="break-all font-mono leading-relaxed">
                    {result.error}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            关闭
          </Button>
          <Button
            size="sm"
            disabled={testing || !model.trim()}
            onClick={runTest}
            className="gap-1.5 shadow-2xs"
          >
            {testing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Zap className="h-3.5 w-3.5 text-amber-500" />
            )}
            {testing ? "正在调用网关…" : "开始自检"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- 密钥页 ----------

export function KeysPage() {
  const { data: keys, isLoading } = useApiKeys();
  const { data: channels } = useChannels();
  const { data: settings } = useSettings();
  const { data: lanIp } = useLanIp();
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ApiKey | null>(null);
  const [testTargetKey, setTestTargetKey] = useState<ApiKey | null>(null);
  // 删除二次确认:主题化弹窗(取代 window.confirm)
  const confirm = useConfirm();

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
  const [copiedBase, setCopiedBase] = useState(false);
  const [copiedLan, setCopiedLan] = useState(false);
  const [copiedKeyId, setCopiedKeyId] = useState<number | null>(null);
  const baseURL = `http://${settings?.listenAddr ?? "127.0.0.1"}:${settings?.port ?? 8787}/v1`;
  const isLan = settings?.listenAddr === "0.0.0.0";
  const lanURL = lanIp ? `http://${lanIp}:${settings?.port ?? 8787}/v1` : null;

  const copyBaseURL = async () => {
    try {
      await navigator.clipboard.writeText(baseURL);
      setCopiedBase(true);
      toast.success("BaseURL 已复制");
      setTimeout(() => setCopiedBase(false), 1500);
    } catch {
      toast.error("复制失败,请手动复制: " + baseURL);
    }
  };

  const copyLanURL = async () => {
    if (!lanURL) return;
    try {
      await navigator.clipboard.writeText(lanURL);
      setCopiedLan(true);
      toast.success(`局域网接入地址已复制: ${lanURL}`);
      setTimeout(() => setCopiedLan(false), 1500);
    } catch {
      toast.error("复制失败");
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
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/80 bg-muted/40 px-2.5 py-1.5 text-xs transition-all hover:bg-accent hover:border-border active:scale-95 shadow-2xs"
            >
              <span className="text-muted-foreground">BaseURL</span>
              <span className="font-mono text-foreground font-medium">{baseURL}</span>
              {copiedBase ? (
                <Check className="h-3 w-3 text-success" />
              ) : (
                <Copy className="h-3 w-3 text-muted-foreground/70" />
              )}
            </button>
            {isLan && lanURL && (
              <button
                onClick={copyLanURL}
                title="同 Wi-Fi 局域网设备(手机/iPad)接入地址，点击一键复制"
                className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/35 bg-indigo-500/10 px-2.5 py-1.5 text-xs font-medium text-indigo-600 dark:text-indigo-400 transition-all hover:bg-indigo-500/20 active:scale-95 shadow-2xs"
              >
                <Smartphone className="h-3.5 w-3.5" />
                <span className="text-muted-foreground">局域网</span>
                <span className="font-mono font-medium text-foreground">{lanURL}</span>
                {copiedLan ? (
                  <Check className="h-3 w-3 text-success" />
                ) : (
                  <Copy className="h-3 w-3 text-muted-foreground/70" />
                )}
              </button>
            )}
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
            <div className="py-6">
              <EmptyState
                icon={KeyRound}
                title="暂无客户端调用密钥"
                description="创建您的第一个 API 认证密钥，分发给 Claude Code、Cursor、Cherry Studio 等客户端接入"
              >
                <Button
                  size="sm"
                  onClick={() => {
                    setEditing(emptyKey());
                    setDialogOpen(true);
                  }}
                  className="gap-1.5 shadow-2xs"
                >
                  <Plus className="h-4 w-4" /> 创建第一个密钥
                </Button>
              </EmptyState>
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
                  <tr key={k.id} className="border-b transition-colors duration-150 hover:bg-accent/40 even:bg-muted/15 last:border-0">
                    <td className="py-2.5 pr-3 font-medium">{k.name}</td>
                    <td className="py-2.5 pr-3">
                      <button
                        className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-xs text-muted-foreground transition-all hover:bg-accent hover:text-foreground active:scale-95"
                        title="复制完整密钥"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(k.key);
                            setCopiedKeyId(k.id);
                            toast.success("完整密钥已复制");
                            setTimeout(() => setCopiedKeyId(null), 1500);
                          } catch {
                            toast.error("复制失败,请手动选择复制");
                          }
                        }}
                      >
                        <span>{maskKey(k.key)}</span>
                        {copiedKeyId === k.id ? (
                          <Check className="h-3 w-3 text-success" />
                        ) : (
                          <Copy className="h-3 w-3 text-muted-foreground/60" />
                        )}
                      </button>
                    </td>
                    <td className="max-w-[260px] py-2.5 pr-3 text-xs">
                      {k.channels.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <div className="flex flex-wrap items-center gap-1">
                          {k.channels.slice(0, 3).map((id, idx) => {
                            const chName = channels?.find((c) => c.id === id)?.name ?? `#${id}`;
                            return (
                              <Fragment key={id}>
                                {idx > 0 && (
                                  <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/40" />
                                )}
                                <span
                                  className="inline-flex items-center rounded-md border border-border/80 bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-foreground/80 shadow-2xs"
                                  title={chName}
                                >
                                  #{id}
                                </span>
                              </Fragment>
                            );
                          })}
                          {k.channels.length > 3 && (
                            <span
                              className="rounded-md border border-border/80 bg-muted/40 px-1 py-0.5 font-mono text-[10px] text-muted-foreground"
                              title={k.channels
                                .slice(3)
                                .map(
                                  (id) =>
                                    `#${id} ${channels?.find((c) => c.id === id)?.name ?? ""}`,
                                )
                                .join("\n")}
                            >
                              +{k.channels.length - 3}
                            </span>
                          )}
                          {k.models.length > 0 && (
                            <span
                              title={k.models.join(", ")}
                              className="ml-1 text-[11px] text-muted-foreground"
                            >
                              · {k.models.length} 模型
                            </span>
                          )}
                          {Object.keys(k.modelChannels ?? {}).length > 0 && (
                            <span title="存在模型级渠道路由定制" className="ml-1 text-primary">
                              · <Route className="inline h-3 w-3" />
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-xs">
                      {(() => {
                        if (!k.lastUsedAt) {
                          return (
                            <span className="rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground/70">
                              从未使用
                            </span>
                          );
                        }
                        const diffMs = Date.now() - k.lastUsedAt;
                        const isRecent = diffMs > 0 && diffMs < 15 * 60 * 1000; // 15分钟内
                        return (
                          <div
                            className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground"
                            title={formatTs(k.lastUsedAt)}
                          >
                            {isRecent && (
                              <span className="relative flex h-2 w-2 shrink-0">
                                <span className="absolute h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" />
                                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                              </span>
                            )}
                            <span
                              className={cn(
                                isRecent &&
                                  "font-medium text-emerald-600 dark:text-emerald-400",
                              )}
                            >
                              {formatRelativeTime(k.lastUsedAt)}
                            </span>
                          </div>
                        );
                      })()}
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
                          title="端到端路由自检诊断"
                          className="hover:bg-amber-500/15 hover:text-amber-600 dark:hover:text-amber-400"
                          onClick={() => setTestTargetKey(k)}
                        >
                          <Zap className="h-3.5 w-3.5 text-amber-500" />
                        </Button>
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
                              !(await confirm({
                                title: "删除密钥",
                                message: `确认删除密钥「${k.name}」?使用该密钥的客户端将立即无法访问,且不可恢复。`,
                              }))
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
      <TestKeyDialog
        apiKey={testTargetKey}
        onClose={() => setTestTargetKey(null)}
      />
      <div className={cn("h-2")} />
    </div>
  );
}
