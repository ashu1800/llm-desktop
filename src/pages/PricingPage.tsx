import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Calculator, Coins, History, Pencil, Plus, Search, Sparkles, Trash2, Wand2, X } from "lucide-react";
import { api } from "@/lib/api";
import { matchPrice } from "@/lib/format";
import { usePrices, useUnpricedModels } from "@/hooks/use-gateway";
import type { PriceEntry } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { useConfirm } from "@/components/ConfirmDialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function formatTs(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

function fmtPrice(n: number): string {
  return n.toLocaleString("zh-CN", { maximumFractionDigits: 4 });
}

/** 价格单元格:双币种条目显示 ¥X/$Y 两行;单币种也带 ¥ 前缀——单位显式化,
    与双币种行对齐(全部带符号,扫读时不需猜币种) */
function PriceCell({
  cny,
  usd,
}: {
  cny: number;
  usd: number | null;
}) {
  if (usd == null) return <>¥{fmtPrice(cny)}</>;
  return (
    <span className="inline-flex flex-col items-end leading-4">
      <span>¥{fmtPrice(cny)}</span>
      <span className="text-muted-foreground">${fmtPrice(usd)}</span>
    </span>
  );
}

const ZERO_PRICE: PriceEntry = {
  pattern: "",
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  inputUsd: null,
  outputUsd: null,
  cacheReadUsd: null,
  cacheWriteUsd: null,
};

// ---------- 定价编辑 Dialog(quick=从未定价清单补录,保存即回填) ----------

function PriceDialog({
  open,
  editing,
  quick,
  onClose,
}: {
  open: boolean;
  editing: PriceEntry | null;
  quick: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<PriceEntry>(editing ?? ZERO_PRICE);
  const [usdEnabled, setUsdEnabled] = useState(false);

  useEffect(() => {
    setForm(editing ?? ZERO_PRICE);
    setUsdEnabled(editing?.inputUsd != null);
  }, [editing, open]);

  const save = useMutation({
    mutationFn: async () => {
      const payload = { ...form };
      if (!usdEnabled) {
        payload.inputUsd = null;
        payload.outputUsd = null;
        payload.cacheReadUsd = null;
        payload.cacheWriteUsd = null;
      } else {
        payload.inputUsd = payload.inputUsd ?? 0;
      }
      if (quick) {
        return api.quickPriceAndBackfill(payload);
      }
      await api.upsertModelPrice(payload);
      return null;
    },
    onSuccess: (filled) => {
      qc.invalidateQueries({ queryKey: ["prices"] });
      qc.invalidateQueries({ queryKey: ["unpriced"] });
      qc.invalidateQueries({ queryKey: ["logs"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
      toast.success(
        filled != null ? `定价已保存,回填 ${filled} 条历史费用` : "定价已保存",
      );
      onClose();
    },
    onError: (e) => toast.error(String(e)),
  });

  if (!open) return null;
  const patch = (p: Partial<PriceEntry>) => setForm({ ...form, ...p });

  // 人民币字段(必填,元/M);仅完整数值回写,"0." 中间态不 patch 防吞小数点
  const cnyField = (
    label: string,
    key: "input" | "output" | "cacheRead" | "cacheWrite",
  ) => (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input
        type="number"
        min="0"
        step="0.01"
        value={form[key]}
        onChange={(e) => {
          const v = e.target.value;
          if (v !== "" && Number.isFinite(Number(v))) patch({ [key]: Number(v) });
        }}
        onBlur={(e) => {
          // 失焦归一:清空/非法回 0
          const n = Number(e.target.value);
          if (e.target.value === "" || !Number.isFinite(n)) patch({ [key]: 0 });
        }}
      />
    </div>
  );

  // 美元字段(可选,$/M);空 = 未定价该侧。勾选启用后以输入价为首(其余空)
  const usdField = (
    label: string,
    key: "inputUsd" | "outputUsd" | "cacheReadUsd" | "cacheWriteUsd",
  ) => {
    const v = form[key];
    return (
      <div className="space-y-1.5">
        <Label>{label}</Label>
        <Input
          type="number"
          min="0"
          step="0.01"
          placeholder="未定价"
          value={v ?? ""}
          onChange={(e) => {
            const raw = e.target.value;
            // 空串=取消该侧定价;完整数值才回写,防 "0." 中间态被吞
            if (raw === "") patch({ [key]: null });
            else if (Number.isFinite(Number(raw))) patch({ [key]: Number(raw) });
          }}
        />
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{quick ? "快捷补录定价" : editing ? "编辑定价" : "新增定价"}</DialogTitle>
          <DialogDescription>
            同一模型可同时配置人民币与美元两套价格,渠道侧选择计费币种;模型名支持
            prefix* 通配(如 gpt-4o*),精确名优先匹配
            {quick && ";保存后自动回填该模型的历史费用"}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="space-y-1.5">
            <Label>模型名 / 通配模式</Label>
            <Input
              value={form.pattern}
              onChange={(e) => patch({ pattern: e.target.value })}
              placeholder="例如:claude-sonnet-4-5 或 gemini-2.5*"
              className="font-mono"
            />
          </div>
          {/* 人民币组(默认) */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">人民币价格(元/百万 token)</Label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {cnyField("输入", "input")}
              {cnyField("输出", "output")}
              {cnyField("缓存读", "cacheRead")}
              {cnyField("缓存写", "cacheWrite")}
            </div>
          </div>
          {/* 美元组(可选):勾选后展开;部分配置合法,未配侧按 0 计;
              输入价清空 = 整组取消且同步清空其余三价(后端 has_usd 只看输入价,
              残留三价会静默落库不生效且不可见) */}
          <div className="space-y-2">
            <label className="flex w-fit cursor-pointer items-center gap-2 text-sm select-none">
              <input
                type="checkbox"
                checked={usdEnabled}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setUsdEnabled(checked);
                  if (checked) {
                    patch({ inputUsd: form.inputUsd ?? 0 });
                  } else {
                    patch({
                      inputUsd: null,
                      outputUsd: null,
                      cacheReadUsd: null,
                      cacheWriteUsd: null,
                    });
                  }
                }}
                className="h-4 w-4 accent-primary"
              />
              美元价格($/百万 token,可选)
            </label>
            {usdEnabled && (
              <div className="grid grid-cols-2 gap-3">
                {usdField("输入", "inputUsd")}
                {usdField("输出", "outputUsd")}
                {usdField("缓存读", "cacheReadUsd")}
                {usdField("缓存写", "cacheWriteUsd")}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={!form.pattern.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            {quick ? "保存并回填" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- 定价页 ----------

export function PricingPage() {
  const { data: prices, isLoading } = usePrices();
  const { data: unpriced } = useUnpricedModels();
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PriceEntry | null>(null);
  const [quick, setQuick] = useState(false);
  const [search, setSearch] = useState("");
  const [calcOpen, setCalcOpen] = useState(false);
  const [calcModel, setCalcModel] = useState("claude-3-5-sonnet");
  const [calcPrompt, setCalcPrompt] = useState(10000);
  const [calcCompletion, setCalcCompletion] = useState(2000);
  const [calcCacheRead, setCalcCacheRead] = useState(0);
  // 删除二次确认:主题化弹窗(取代 window.confirm)
  const confirm = useConfirm();

  const calcMatched = useMemo(() => {
    if (!prices || !calcModel.trim()) return null;
    return matchPrice(prices, calcModel.trim());
  }, [prices, calcModel]);

  const calcEstimatedCost = useMemo(() => {
    if (!calcMatched) return null;
    const netPrompt = Math.max(0, calcPrompt - calcCacheRead);
    const cny =
      (netPrompt / 1_000_000) * calcMatched.input +
      (calcCompletion / 1_000_000) * calcMatched.output +
      (calcCacheRead / 1_000_000) * calcMatched.cacheRead;
    const usd =
      calcMatched.inputUsd != null
        ? (netPrompt / 1_000_000) * (calcMatched.inputUsd ?? 0) +
          (calcCompletion / 1_000_000) * (calcMatched.outputUsd ?? 0) +
          (calcCacheRead / 1_000_000) * (calcMatched.cacheReadUsd ?? 0)
        : null;
    return { cny, usd };
  }, [calcMatched, calcPrompt, calcCompletion, calcCacheRead]);

  const filteredPrices = useMemo(() => {
    if (!prices) return [];
    if (!search.trim()) return prices;
    const q = search.trim().toLowerCase();
    return prices.filter((p) => p.pattern.toLowerCase().includes(q));
  }, [prices, search]);

  const openNew = () => {
    setEditing(null);
    setQuick(false);
    setDialogOpen(true);
  };
  const openEdit = (p: PriceEntry) => {
    setEditing(structuredClone(p));
    setQuick(false);
    setDialogOpen(true);
  };
  const openQuick = (model: string) => {
    setEditing({ ...ZERO_PRICE, pattern: model });
    setQuick(true);
    setDialogOpen(true);
  };

  const backfill = useMutation({
    mutationFn: api.backfillCosts,
    onSuccess: (n) => {
      qc.invalidateQueries({ queryKey: ["logs"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
      toast.success(
        n > 0 ? `已回填 ${n} 条历史费用` : "没有需要回填的记录",
      );
    },
    onError: (e) => toast.error(String(e)),
  });

  const dismiss = useMutation({
    mutationFn: api.dismissUnpricedModel,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["unpriced"] }),
    onError: (e) => toast.error(String(e)),
  });

  const unpricedCount = unpriced?.length ?? 0;

  return (
    <div className="space-y-4">
      {unpricedCount > 0 && (
        <Card className="border border-amber-500/35 bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent shadow-xs">
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600 ring-1 ring-inset ring-amber-500/30 dark:text-amber-400">
                <Coins className="h-5 w-5" />
              </div>
              <div>
                <CardTitle className="flex items-center gap-2 text-base text-amber-950 dark:text-amber-100">
                  发现未定价模型
                  <span className="rounded-full border border-amber-500/30 bg-amber-500/20 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
                    {unpricedCount}
                  </span>
                </CardTitle>
                <CardDescription className="text-amber-800/80 dark:text-amber-200/70">
                  以下模型已有成功请求但定价表未覆盖，费用暂未计入；补录后自动回填历史费用
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">模型</th>
                  <th className="py-2 pr-3 font-medium">首次出现</th>
                  <th className="py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {unpriced!.map((u) => (
                  <tr key={u.model} className="border-b transition-colors duration-150 hover:bg-accent/40 even:bg-muted/15 last:border-0">
                    <td className="py-2.5 pr-3 font-mono text-xs">{u.model}</td>
                    <td className="py-2.5 pr-3 text-xs text-muted-foreground">
                      {formatTs(u.firstSeen)}
                    </td>
                    <td className="py-2.5">
                      <div className="flex items-center gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          className="border-amber-500/30 bg-background/80 hover:bg-amber-500/15 hover:text-amber-700 dark:hover:text-amber-300 gap-1.5 shadow-2xs text-xs"
                          onClick={() => openQuick(u.model)}
                        >
                          <Wand2 className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" /> 补录
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="忽略(不再提示)"
                          onClick={() => dismiss.mutate(u.model)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <span>模型定价</span>
            <span className="font-mono text-xs font-normal text-muted-foreground">
              ({filteredPrices.length}
              {prices && filteredPrices.length !== prices.length
                ? ` / ${prices.length}`
                : ""}
              )
            </span>
          </CardTitle>
          <div className="flex items-center gap-2.5">
            <div className="relative w-40 sm:w-52">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground/70" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索模型规则…"
                className="h-8 bg-background/60 pl-8 pr-7 text-xs shadow-2xs"
              />
              {search && (
                <button
                  onClick={() => setSearch("")}
                  className="absolute right-2 top-2 text-muted-foreground/60 hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setCalcOpen(!calcOpen)}
              className={cn("gap-1.5 shadow-2xs text-xs", calcOpen && "bg-accent text-accent-foreground")}
              title="测算预估费用"
            >
              <Calculator className="h-3.5 w-3.5 text-primary" /> 费用测算
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={backfill.isPending}
              onClick={() => backfill.mutate()}
            >
              <History className="h-4 w-4" /> 回填历史费用
            </Button>
            <Button size="sm" onClick={openNew}>
              <Plus className="h-4 w-4" /> 新增定价
            </Button>
          </div>
        </CardHeader>

        {/* 费用测算器展开面板 */}
        {calcOpen && (
          <div className="mx-6 mb-4 space-y-3 rounded-xl border border-border/80 bg-muted/20 p-4 shadow-inner">
            <div className="flex items-center justify-between border-b border-border/50 pb-2">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <Calculator className="h-4 w-4 text-primary" />
                单次请求费用测算器
              </span>
              <span className="text-[11px] text-muted-foreground">
                基于当前定价规则实时模拟计算
              </span>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">目标模型</Label>
                <Input
                  value={calcModel}
                  onChange={(e) => setCalcModel(e.target.value)}
                  placeholder="例如: gpt-4o"
                  className="h-8 bg-background/80 font-mono text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">输入 Tokens (Prompt)</Label>
                <Input
                  type="number"
                  min="0"
                  step="1000"
                  value={calcPrompt}
                  onChange={(e) => setCalcPrompt(Number(e.target.value) || 0)}
                  className="h-8 bg-background/80 font-mono text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">输出 Tokens (Output)</Label>
                <Input
                  type="number"
                  min="0"
                  step="500"
                  value={calcCompletion}
                  onChange={(e) => setCalcCompletion(Number(e.target.value) || 0)}
                  className="h-8 bg-background/80 font-mono text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">缓存命中 Tokens</Label>
                <Input
                  type="number"
                  min="0"
                  step="1000"
                  value={calcCacheRead}
                  onChange={(e) => setCalcCacheRead(Number(e.target.value) || 0)}
                  className="h-8 bg-background/80 font-mono text-xs"
                />
              </div>
            </div>

            {/* 测算结果条 */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/80 bg-background/90 p-3 shadow-2xs">
              <div className="flex items-center gap-2 text-xs">
                {calcMatched ? (
                  <>
                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                      ✓ 命中规则: {calcMatched.pattern}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      (输入 ¥{calcMatched.input}/M · 输出 ¥{calcMatched.output}/M)
                    </span>
                  </>
                ) : (
                  <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
                    ⚠️ 未在定价表中匹配到规则，若产生请求将无法计入费用
                  </span>
                )}
              </div>
              {calcEstimatedCost && (
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">预估费用:</span>
                  <span className="font-mono text-base font-bold text-foreground">
                    ¥{calcEstimatedCost.cny.toFixed(5)}
                  </span>
                  {calcEstimatedCost.usd != null && (
                    <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                      ${calcEstimatedCost.usd.toFixed(5)}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
        <CardContent>
          {isLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              加载中…
            </div>
          ) : !prices?.length ? (
            <div className="py-6">
              <EmptyState
                icon={Coins}
                title="定价规则表为空"
                description="添加模型价格规则后，网关在处理请求时将自动折算并回填每笔请求的 Token 费用"
              >
                <Button size="sm" onClick={openNew} className="gap-1.5 shadow-2xs">
                  <Plus className="h-4 w-4" /> 新增第一条定价
                </Button>
              </EmptyState>
            </div>
          ) : !filteredPrices.length ? (
            <div className="py-6">
              <EmptyState
                icon={Search}
                title={`未找到匹配「${search}」的定价规则`}
                description="请检查搜索关键字或通配符规则，您可以清空搜索框以查看全部定价"
              >
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSearch("")}
                  className="gap-1.5 shadow-2xs"
                >
                  <X className="h-3.5 w-3.5" /> 清空搜索条件
                </Button>
              </EmptyState>
            </div>
          ) : (
            <table className="w-full table-fixed text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  {/* 列宽:模型列自适应撑满,四个价格列等宽,操作列定宽右贴边——
                      默认 auto 布局下模型列被内容撑得极宽,价格列挤成团。
                      操作列带左边框:数据区与动作区分隔 */}
                  <th className="py-2 pr-3 font-medium">模型</th>
                  <th className="w-28 py-2 pr-3 text-right font-medium">输入</th>
                  <th className="w-28 py-2 pr-3 text-right font-medium">输出</th>
                  <th className="w-28 py-2 pr-3 text-right font-medium">缓存读</th>
                  <th className="w-28 py-2 pr-3 text-right font-medium">缓存写</th>
                  <th className="w-28 border-l py-2 text-center font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredPrices.map((p) => (
                  <tr key={p.pattern} className="border-b transition-colors duration-150 hover:bg-accent/40 even:bg-muted/15 last:border-0">
                    <td className="py-2.5 pr-3 font-mono text-xs">
                      <span className="font-semibold text-foreground">{p.pattern}</span>
                      {p.pattern.endsWith("*") && (
                        <span className="ml-2 inline-flex items-center gap-0.5 rounded-full border border-amber-500/35 bg-amber-500/15 px-2 py-0.5 font-sans text-[10px] font-semibold text-amber-700 shadow-2xs dark:text-amber-300">
                          <Sparkles className="h-2.5 w-2.5 text-amber-500" />
                          通配
                        </span>
                      )}
                      {p.inputUsd != null && (
                        <span className="ml-1.5 inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] font-bold text-emerald-600 shadow-2xs dark:text-emerald-400">
                          USD
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-right font-mono text-xs">
                      <PriceCell cny={p.input} usd={p.inputUsd} />
                    </td>
                    <td className="py-2.5 pr-3 text-right font-mono text-xs">
                      <PriceCell cny={p.output} usd={p.outputUsd} />
                    </td>
                    <td className="py-2.5 pr-3 text-right font-mono text-xs">
                      <PriceCell cny={p.cacheRead} usd={p.cacheReadUsd} />
                    </td>
                    <td className="py-2.5 pr-3 text-right font-mono text-xs">
                      <PriceCell cny={p.cacheWrite} usd={p.cacheWriteUsd} />
                    </td>
                    <td className="border-l py-2.5">
                      <div className="flex items-center justify-end gap-0.5">
                        <Button
                          variant="ghost"
                          size="icon"
                          title="编辑"
                          onClick={() => openEdit(p)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="删除"
                          onClick={async () => {
                            // 删除后相关模型请求不再计费:二次确认
                            if (
                              !(await confirm({
                                title: "删除定价",
                                message: `确认删除定价「${p.pattern}」?相关请求将不再计入费用。`,
                              }))
                            )
                              return;
                            try {
                              await api.deleteModelPrice(p.pattern);
                              qc.invalidateQueries({ queryKey: ["prices"] });
                              toast.success("已删除定价");
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

      <PriceDialog
        open={dialogOpen}
        editing={editing}
        quick={quick}
        onClose={() => setDialogOpen(false)}
      />
    </div>
  );
}
