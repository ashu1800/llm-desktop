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
  Pause,
  Play,
  RefreshCw,
  ScrollText,
} from "lucide-react";
import { api } from "@/lib/api";
import {
  useApiKeys,
  useBreakerStates,
  useChannels,
  useLogs,
  useStats,
  useUnpricedModels,
} from "@/hooks/use-gateway";
import {
  cacheHitRate,
  fmtFullTime,
  fmtK,
  fmtMs,
  fmtTime,
  fmtYuan,
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
                    输入 {fmtK(detail.promptTokens - detail.cacheRead - detail.cacheWrite)} ×{" "}
                    {price.input} 元/M
                  </div>
                  <div>
                    缓存读 {fmtK(detail.cacheRead)} × {price.cacheRead} 元/M + 缓存写{" "}
                    {fmtK(detail.cacheWrite)} × {price.cacheWrite} 元/M
                  </div>
                  <div>
                    输出 {fmtK(detail.completionTokens)} × {price.output} 元/M
                  </div>
                  <div className="font-semibold">
                    = {fmtYuan(detail.cost)}(命中定价 {price.pattern})
                  </div>
                </div>
              ) : detail.cost != null ? (
                <p className="text-sm">{fmtYuan(detail.cost)}(定价条目已删除)</p>
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
  return (
    <tr className="border-b last:border-0 hover:bg-accent/30">
      <td className="py-2.5 pr-3 font-mono text-xs" title={fmtFullTime(l.ts)}>
        {fmtTime(l.ts)}
      </td>
      <td className="py-2.5 pr-3">
        <div className="flex items-center gap-1.5">
          <Badge variant="secondary" className="max-w-[180px] truncate px-1.5 font-mono">
            {l.model}
          </Badge>
          {l.tag && <Badge variant="outline" className="px-1.5">{l.tag}</Badge>}
        </div>
      </td>
      <td className="py-2.5 pr-3 text-xs">
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
      <td className="py-2.5 pr-3 font-mono text-xs leading-5">
        <div className="flex items-center gap-2.5">
          <span className="text-orange-500" title={`总输入 ${fmtK(l.promptTokens)}(含缓存)`}>
            ↑{fmtK(l.promptTokens - l.cacheRead - l.cacheWrite)}
          </span>
          <span className="text-violet-500" title={`总输出 ${fmtK(l.completionTokens)}`}>
            ↓{fmtK(l.completionTokens)}
          </span>
        </div>
        <div className="flex items-center gap-1 text-muted-foreground">
          <Database className="h-3 w-3" />
          <span className="text-emerald-500" title="缓存命中词元">
            {fmtK(l.cacheRead)}
          </span>
          <span className="text-violet-500">
            {cacheHitRate(l.cacheRead, l.promptTokens)}
          </span>
        </div>
      </td>
      {/* 流式正常色,非流式整块淡色以字体颜色区分 */}
      <td className={cn("py-2.5 pr-3 font-mono text-xs leading-5", !l.isStream && "text-muted-foreground")}>
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5">
            <span className="h-3 w-0.5 shrink-0 rounded-full bg-zinc-400" />
            <span className="text-muted-foreground">首字</span>
            <span>{l.isStream ? fmtMs(l.ttftMs) : "—"}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-3 w-0.5 shrink-0 rounded-full bg-sky-500" />
            <span className="text-muted-foreground">耗时</span>
            <span>{fmtMs(l.totalMs)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-3 w-0.5 shrink-0 rounded-full bg-violet-500" />
            <span className="text-muted-foreground">速度</span>
            <span>
              {l.isStream && l.speed != null ? `${l.speed.toFixed(1)} tok/s` : "—"}
            </span>
          </div>
        </div>
      </td>
      <td className="py-2.5 pr-3 text-right font-mono text-xs">
        {l.cost != null && (
          <span title={l.estimated ? "usage 为本地估算" : undefined}>
            {l.estimated ? "~" : ""}
            {fmtYuan(l.cost)}
          </span>
        )}
        {l.cost == null && <span className="text-muted-foreground">—</span>}
      </td>
      <td className="py-2.5 pr-3">
        <StatusCell status={l.status} />
      </td>
      <td className="py-2.5 pr-3">
        {l.keyName ? (
          <Badge variant="outline" className="px-1.5">
            {l.keyName}
          </Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="max-w-[110px] truncate py-2.5 pr-3 text-xs text-muted-foreground">
        {l.client ?? "—"}
      </td>
      <td className="py-2.5">
        <Button variant="ghost" size="sm" onClick={onDetail}>
          详情
        </Button>
      </td>
    </tr>
  );
}

// ---------- 数据总览页 ----------

export function DashboardPage() {
  const { data: breakers } = useBreakerStates();
  const { data: unpriced } = useUnpricedModels();
  const { data: channels } = useChannels();
  const { data: keys } = useApiKeys();
  const qc = useQueryClient();
  const [range, setRange] = useState<TimeRange>("today");
  const [channelFilter, setChannelFilter] = useState("all");
  const [keyFilter, setKeyFilter] = useState("all");
  const [statusClass, setStatusClass] = useState("all");
  const [model, setModel] = useState("");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(0);
  const [live, setLive] = useState(true);
  const [detailId, setDetailId] = useState<number | null>(null);

  const filter = useMemo<LogFilter>(
    () => ({
      fromTs: rangeFromTs(range),
      channelId: channelFilter === "all" ? null : Number(channelFilter),
      keyId: keyFilter === "all" ? null : Number(keyFilter),
      statusClass:
        statusClass === "all" ? null : (statusClass as "success" | "error"),
      model: model || undefined,
      keyword: keyword || undefined,
      offset: page * PAGE_SIZE,
      limit: PAGE_SIZE,
    }),
    [range, channelFilter, keyFilter, statusClass, model, keyword, page],
  );

  const { data: stats } = useStats(filter);
  const { data, isLoading, isFetching } = useLogs(filter, live);
  const [items, total] = data ?? [[], 0];
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const openBreakers = (breakers ?? []).filter((b) => b.state !== "closed");
  const successRate =
    stats && stats.count > 0
      ? `${(((stats.count - stats.errorCount) / stats.count) * 100).toFixed(1)}%`
      : "—";

  const resetPage = () => setPage(0);

  return (
    <div className="space-y-4">
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
          value={statusClass}
          onValueChange={(v) => {
            setStatusClass(v);
            resetPage();
          }}
        >
          <SelectTrigger className="h-8 w-[100px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="success">成功</SelectItem>
            <SelectItem value="error">失败</SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
            resetPage();
          }}
          placeholder="模型名"
          className="h-8 w-[150px] text-xs"
        />
        <Input
          value={keyword}
          onChange={(e) => {
            setKeyword(e.target.value);
            resetPage();
          }}
          placeholder="关键字(模型/错误)"
          className="h-8 w-[170px] text-xs"
        />
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
          hint="按定价表计,含缓存"
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

      {/* 请求日志表(原"请求日志"页并入) */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <div>
            <CardTitle className="text-base">请求日志</CardTitle>
            <CardDescription>
              共 {total} 条{live && " · 10s 自动刷新"}
            </CardDescription>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Button
              variant="ghost"
              size="icon"
              title={live ? "暂停自动刷新" : "开启自动刷新(10s)"}
              onClick={() => setLive(!live)}
            >
              {live ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </Button>
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
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            {page + 1} / {pageCount}
            <Button
              variant="outline"
              size="sm"
              disabled={page + 1 >= pageCount}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> 加载中…
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
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">时间</th>
                  <th className="py-2 pr-3 font-medium">模型</th>
                  <th className="py-2 pr-3 font-medium">渠道</th>
                  <th className="py-2 pr-3 font-medium">词元</th>
                  <th className="py-2 pr-3 font-medium">任务耗时</th>
                  <th className="py-2 pr-3 text-right font-medium">费用</th>
                  <th className="py-2 pr-3 font-medium">状态</th>
                  <th className="py-2 pr-3 font-medium">密钥</th>
                  <th className="py-2 pr-3 font-medium">客户端</th>
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
