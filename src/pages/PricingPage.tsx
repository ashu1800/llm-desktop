import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Coins, History, Pencil, Plus, Trash2, Wand2, X } from "lucide-react";
import { api } from "@/lib/api";
import { usePrices, useUnpricedModels } from "@/hooks/use-gateway";
import type { PriceEntry } from "@/lib/types";
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

const ZERO_PRICE: PriceEntry = {
  pattern: "",
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
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
  useMemo(() => setForm(editing ?? ZERO_PRICE), [editing]);

  const save = useMutation({
    mutationFn: async () => {
      if (quick) {
        return api.quickPriceAndBackfill(form);
      }
      await api.upsertModelPrice(form);
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

  const numField = (
    label: string,
    key: "input" | "output" | "cacheRead" | "cacheWrite",
    hint?: string,
  ) => (
    <div className="space-y-1.5">
      <Label>
        {label}
        {hint && (
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            {hint}
          </span>
        )}
      </Label>
      <Input
        type="number"
        min="0"
        step="0.01"
        value={form[key]}
        onChange={(e) => patch({ [key]: Number(e.target.value) || 0 })}
      />
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{quick ? "快捷补录定价" : editing ? "编辑定价" : "新增定价"}</DialogTitle>
          <DialogDescription>
            单位:元/百万 token;模型名支持 prefix* 通配(如 gpt-4o*),精确名优先匹配
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
          <div className="grid grid-cols-2 gap-3">
            {numField("输入", "input")}
            {numField("输出", "output")}
            {numField("缓存读", "cacheRead")}
            {numField("缓存写", "cacheWrite")}
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
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-4">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                未定价模型
                <Badge variant="warning">{unpricedCount}</Badge>
              </CardTitle>
              <CardDescription>
                以下模型已有成功请求但定价表未覆盖,费用未计入;补录后自动回填
              </CardDescription>
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
                  <tr key={u.model} className="border-b last:border-0">
                    <td className="py-2.5 pr-3 font-mono text-xs">{u.model}</td>
                    <td className="py-2.5 pr-3 text-xs text-muted-foreground">
                      {formatTs(u.firstSeen)}
                    </td>
                    <td className="py-2.5">
                      <div className="flex items-center gap-0.5">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openQuick(u.model)}
                        >
                          <Wand2 className="h-3.5 w-3.5" /> 补录
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
          <div>
            <CardTitle className="text-base">模型定价</CardTitle>
            <CardDescription>
              全局定价表,单位 元/百万 token;精确名优先,通配取最后一条命中
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
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
        <CardContent>
          {isLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              加载中…
            </div>
          ) : !prices?.length ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <Coins className="h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                定价表为空,费用暂不计入;新增条目后可一键回填历史费用
              </p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">模型</th>
                  <th className="py-2 pr-3 text-right font-medium">输入</th>
                  <th className="py-2 pr-3 text-right font-medium">输出</th>
                  <th className="py-2 pr-3 text-right font-medium">缓存读</th>
                  <th className="py-2 pr-3 text-right font-medium">缓存写</th>
                  <th className="py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {prices.map((p) => (
                  <tr key={p.pattern} className="border-b last:border-0">
                    <td className="py-2.5 pr-3 font-mono text-xs">
                      {p.pattern}
                      {p.pattern.endsWith("*") && (
                        <Badge variant="secondary" className="ml-2 px-1.5">
                          通配
                        </Badge>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-right font-mono text-xs">
                      {fmtPrice(p.input)}
                    </td>
                    <td className="py-2.5 pr-3 text-right font-mono text-xs">
                      {fmtPrice(p.output)}
                    </td>
                    <td className="py-2.5 pr-3 text-right font-mono text-xs">
                      {fmtPrice(p.cacheRead)}
                    </td>
                    <td className="py-2.5 pr-3 text-right font-mono text-xs">
                      {fmtPrice(p.cacheWrite)}
                    </td>
                    <td className="py-2.5">
                      <div className="flex items-center gap-0.5">
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
                            await api.deleteModelPrice(p.pattern);
                            qc.invalidateQueries({ queryKey: ["prices"] });
                            toast.success("已删除定价");
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
