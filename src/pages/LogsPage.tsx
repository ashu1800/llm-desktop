import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  ScrollText,
} from "lucide-react";
import { api } from "@/lib/api";
import { useApiKeys, useChannels, useLogs } from "@/hooks/use-gateway";
import {
  cacheHitRate,
  fmtFullTime,
  fmtK,
  fmtMs,
  fmtTime,
  fmtYuan,
  matchPrice,
  parseAttempts,
  TIME_RANGE_LABELS,
  type TimeRange,
} from "@/lib/format";
import type { AttemptEntry, LogDetail, LogFilter, LogItem } from "@/lib/types";
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

// ---------- 详情抽屉 ----------

function prettyBody(raw: string | null): string {
  if (!raw) return "(未保存)";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold">{title}</h4>
      {children}
    </div>
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
            <Section title="基本信息">
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
            </Section>

            <Section title="Token 用量">
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
            </Section>

            <Section title="计费明细">
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
            </Section>

            <Section title={`重试链(${attempts.length} 次尝试)`}>
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
            </Section>

            <Section title="请求体快照">
              <PreBlock text={prettyBody(detail.reqSnapshot)} />
            </Section>
            <Section title="响应体快照">
              <PreBlock text={prettyBody(detail.respSnapshot)} />
            </Section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
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

function rangeFromTsOrNull(range: TimeRange): number | null {
  const now = new Date();
  switch (range) {
    case "today":
      return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    case "7d":
      return now.getTime() - 7 * 86_400_000;
    case "30d":
      return now.getTime() - 30 * 86_400_000;
    default:
      return null;
  }
}

/** yyyy-mm-dd → 当地 0:00 时间戳;空串返回 null */
function dateInputToTs(s: string, endOfDay = false): number | null {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(y, m - 1, d).getTime();
  return endOfDay ? t + 86_399_999 : t;
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
        <div>
          ↑{fmtK(l.promptTokens)} ↓{fmtK(l.completionTokens)}
          {l.cacheWrite > 0 && (
            <span className="text-blue-500"> ⟳{fmtK(l.cacheWrite)}</span>
          )}
        </div>
        <div className="text-muted-foreground">
          命中 {cacheHitRate(l.cacheRead, l.promptTokens)}
        </div>
      </td>
      <td className="py-2.5 pr-3 font-mono text-xs leading-5">
        <div>{l.isStream ? `首字 ${fmtMs(l.ttftMs)}` : "首字 —"}</div>
        <div className="text-muted-foreground">耗时 {fmtMs(l.totalMs)}</div>
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
      <td className="py-2.5 pr-3 text-xs">
        <div className="flex items-center gap-1">
          <Badge variant={l.isStream ? "success" : "muted"} className="px-1">
            {l.isStream ? "流" : "非流"}
          </Badge>
          {l.isStream && l.speed != null && (
            <span className="font-mono">{l.speed.toFixed(1)} tok/s</span>
          )}
        </div>
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

// ---------- 日志页 ----------

export function LogsPage() {
  const [range, setRange] = useState<TimeRange | "custom">("7d");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [keyId, setKeyId] = useState<string>("all");
  const [channelId, setChannelId] = useState<string>("all");
  const [statusClass, setStatusClass] = useState<string>("all");
  const [model, setModel] = useState("");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(0);
  const [live, setLive] = useState(true);
  const [detailId, setDetailId] = useState<number | null>(null);

  const { data: keys } = useApiKeys();
  const { data: channels } = useChannels();
  const qc = useQueryClient();

  const filter = useMemo<LogFilter>(
    () => ({
      fromTs:
        range === "custom"
          ? dateInputToTs(customFrom)
          : rangeFromTsOrNull(range),
      toTs: range === "custom" ? dateInputToTs(customTo, true) : null,
      keyId: keyId === "all" ? null : Number(keyId),
      channelId: channelId === "all" ? null : Number(channelId),
      statusClass:
        statusClass === "all" ? null : (statusClass as "success" | "error"),
      model: model || undefined,
      keyword: keyword || undefined,
      offset: page * PAGE_SIZE,
      limit: PAGE_SIZE,
    }),
    [range, customFrom, customTo, keyId, channelId, statusClass, model, keyword, page],
  );

  const { data, isLoading, isFetching } = useLogs(filter, live);
  const [items, total] = data ?? [[], 0];
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      {/* 筛选器 */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-2 pt-4">
          <Select
            value={range}
            onValueChange={(v) => {
              setRange(v as TimeRange | "custom");
              setPage(0);
            }}
          >
            <SelectTrigger className="w-[110px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(TIME_RANGE_LABELS) as TimeRange[]).map((r) => (
                <SelectItem key={r} value={r}>
                  {TIME_RANGE_LABELS[r]}
                </SelectItem>
              ))}
              <SelectItem value="custom">自定义</SelectItem>
            </SelectContent>
          </Select>
          {range === "custom" && (
            <>
              <Input
                type="date"
                value={customFrom}
                onChange={(e) => {
                  setCustomFrom(e.target.value);
                  setPage(0);
                }}
                className="w-[140px]"
              />
              <span className="text-xs text-muted-foreground">至</span>
              <Input
                type="date"
                value={customTo}
                onChange={(e) => {
                  setCustomTo(e.target.value);
                  setPage(0);
                }}
                className="w-[140px]"
              />
            </>
          )}
          <Select
            value={keyId}
            onValueChange={(v) => {
              setKeyId(v);
              setPage(0);
            }}
          >
            <SelectTrigger className="w-[130px]">
              <SelectValue placeholder="密钥" />
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
            value={channelId}
            onValueChange={(v) => {
              setChannelId(v);
              setPage(0);
            }}
          >
            <SelectTrigger className="w-[130px]">
              <SelectValue placeholder="渠道" />
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
            value={statusClass}
            onValueChange={(v) => {
              setStatusClass(v);
              setPage(0);
            }}
          >
            <SelectTrigger className="w-[100px]">
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
              setPage(0);
            }}
            placeholder="模型名"
            className="w-[150px]"
          />
          <Input
            value={keyword}
            onChange={(e) => {
              setKeyword(e.target.value);
              setPage(0);
            }}
            placeholder="关键字(模型/错误)"
            className="w-[170px]"
          />
          <div className="ml-auto flex items-center gap-1.5">
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
          </div>
        </CardContent>
      </Card>

      {/* 日志表格 */}
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
                  <th className="py-2 pr-3 font-medium">耗时</th>
                  <th className="py-2 pr-3 text-right font-medium">费用</th>
                  <th className="py-2 pr-3 font-medium">速度</th>
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
