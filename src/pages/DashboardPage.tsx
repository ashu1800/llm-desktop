import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Coins,
  Loader2,
  Play,
  Square,
  Zap,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";
import { api } from "@/lib/api";
import {
  useBreakerStates,
  useChannelStats,
  useModelStats,
  useServiceStatus,
  useStats,
  useTrend,
  useUnpricedModels,
} from "@/hooks/use-gateway";
import { fmtMs, fmtYuan, rangeFromTs, TIME_RANGE_LABELS, type TimeRange } from "@/lib/format";
import type { LogFilter } from "@/lib/types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

const PIE_COLORS = [
  "#6366f1",
  "#22c55e",
  "#f59e0b",
  "#06b6d4",
  "#ec4899",
  "#8b5cf6",
  "#14b8a6",
  "#ef4444",
  "#84cc16",
  "#64748b",
];

function trendLabel(ts: number, bucket: "hour" | "day"): string {
  const d = new Date(ts);
  return bucket === "day"
    ? `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, "0")}`
    : `${String(d.getHours()).padStart(2, "0")}:00`;
}

function StatCard({
  title,
  value,
  hint,
}: {
  title: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{title}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

export function DashboardPage() {
  const { data: status } = useServiceStatus();
  const { data: breakers } = useBreakerStates();
  const { data: unpriced } = useUnpricedModels();
  const qc = useQueryClient();
  const [range, setRange] = useState<TimeRange>("today");
  const [bucket, setBucket] = useState<"hour" | "day">("hour");

  const filter = useMemo<LogFilter>(
    () => ({ fromTs: rangeFromTs(range), offset: 0, limit: 1 }),
    [range],
  );

  const { data: stats } = useStats(filter);
  const { data: trend } = useTrend(filter, bucket);
  const { data: byChannel } = useChannelStats(filter);
  const { data: topModels } = useModelStats(filter);

  const openBreakers = (breakers ?? []).filter((b) => b.state !== "closed");
  const errorRate =
    stats && stats.count > 0
      ? `${((stats.errorCount / stats.count) * 100).toFixed(1)}%`
      : "—";
  const trendData = (trend ?? []).map(([ts, count, cost]) => ({
    ts,
    label: trendLabel(ts, bucket),
    count,
    costYuan: cost / 100,
  }));

  const toggleMutation = useMutation({
    mutationFn: () => (status?.running ? api.stopService() : api.startService()),
    onSuccess: (s) => {
      qc.setQueryData(["service"], s);
      toast.success(s.running ? "代理服务已启动" : "代理服务已停止");
    },
    onError: (e) => toast.error(String(e)),
  });

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

      {/* 服务 + 汇总卡片 */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>代理服务</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "h-2.5 w-2.5 rounded-full",
                  status?.running ? "bg-success" : "bg-muted-foreground/40",
                )}
              />
              <span className="text-lg font-semibold">
                {status?.running ? "运行中" : "已停止"}
              </span>
            </div>
            <div className="mt-1 font-mono text-xs text-muted-foreground">
              {status?.addr ?? "未监听"}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              disabled={toggleMutation.isPending}
              onClick={() => toggleMutation.mutate()}
            >
              {toggleMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : status?.running ? (
                <Square className="h-3.5 w-3.5" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              {status?.running ? "停止服务" : "启动服务"}
            </Button>
          </CardContent>
        </Card>
        <StatCard
          title={`请求数(${TIME_RANGE_LABELS[range]})`}
          value={stats ? String(stats.count) : "—"}
        />
        <StatCard
          title={`总费用(${TIME_RANGE_LABELS[range]})`}
          value={stats ? fmtYuan(stats.totalCost) : "—"}
        />
        <StatCard
          title="平均首字 / 输出速度"
          value={
            stats
              ? `${stats.avgTtftMs != null ? fmtMs(stats.avgTtftMs) : "—"} · ${
                  stats.avgSpeed != null ? `${stats.avgSpeed.toFixed(1)} tok/s` : "—"
                }`
              : "—"
          }
          hint="仅流式请求计入"
        />
        <StatCard
          title={`错误率(${TIME_RANGE_LABELS[range]})`}
          value={errorRate}
          hint={stats ? `${stats.errorCount} 次失败` : undefined}
        />
        <StatCard
          title="熔断中的渠道"
          value={String(openBreakers.length)}
          hint={openBreakers.length > 0 ? "存在渠道故障,注意上游可用性" : "全部正常"}
        />
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>统计范围</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-2">
              <Select
                value={range}
                onValueChange={(v) => setRange(v as TimeRange)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(TIME_RANGE_LABELS) as TimeRange[]).map((r) => (
                    <SelectItem key={r} value={r}>
                      {TIME_RANGE_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                联动下方图表与汇总卡片
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 图表 */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="xl:col-span-2">
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
            <div>
              <CardTitle className="text-base">调用量与费用趋势</CardTitle>
              <CardDescription>柱:请求数;线:费用(元)</CardDescription>
            </div>
            <div className="flex items-center gap-1 rounded-md border p-0.5 text-xs">
              {(["hour", "day"] as const).map((b) => (
                <button
                  key={b}
                  className={cn(
                    "rounded px-2 py-1",
                    bucket === b
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent",
                  )}
                  onClick={() => setBucket(b)}
                >
                  {b === "hour" ? "按小时" : "按日"}
                </button>
              ))}
            </div>
          </CardHeader>
          <CardContent>
            {trendData.length === 0 ? (
              <EmptyChart />
            ) : (
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={trendData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.1} />
                    <XAxis dataKey="label" fontSize={11} tickLine={false} />
                    <YAxis yAxisId="count" fontSize={11} tickLine={false} allowDecimals={false} />
                    <YAxis
                      yAxisId="cost"
                      orientation="right"
                      fontSize={11}
                      tickLine={false}
                      unit="元"
                    />
                    <Tooltip
                      formatter={(v, name) =>
                        name === "请求数" ? [v, name] : [`¥${Number(v).toFixed(4)}`, "费用"]
                      }
                    />
                    <Legend />
                    <Bar
                      yAxisId="count"
                      dataKey="count"
                      name="请求数"
                      fill="#6366f1"
                      radius={[3, 3, 0, 0]}
                      maxBarSize={28}
                    />
                    <Line
                      yAxisId="cost"
                      type="monotone"
                      dataKey="costYuan"
                      name="费用"
                      stroke="#22c55e"
                      strokeWidth={2}
                      dot={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">渠道请求占比</CardTitle>
            <CardDescription>按命中渠道统计</CardDescription>
          </CardHeader>
          <CardContent>
            {!byChannel?.length ? (
              <EmptyChart />
            ) : (
              <div className="flex h-64 items-center">
                <ResponsiveContainer width="55%" height="100%">
                  <PieChart>
                    <Pie
                      data={byChannel.map(([name, count]) => ({ name, value: count }))}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={40}
                      outerRadius={80}
                      paddingAngle={2}
                    >
                      {byChannel.map((_, i) => (
                        <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
                <ul className="flex-1 space-y-1.5 text-xs">
                  {byChannel.map(([name, count], i) => (
                    <li key={name} className="flex items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-sm"
                        style={{ background: PIE_COLORS[i % PIE_COLORS.length] }}
                      />
                      <span className="truncate">{name}</span>
                      <span className="ml-auto font-mono text-muted-foreground">
                        {count}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-1.5 text-base">
              <Zap className="h-4 w-4" /> 模型 Top 10
            </CardTitle>
            <CardDescription>按请求数排序</CardDescription>
          </CardHeader>
          <CardContent>
            {!topModels?.length ? (
              <EmptyChart />
            ) : (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={topModels.map(([model, count]) => ({ model, count }))}
                    layout="vertical"
                    margin={{ left: 8 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.1} />
                    <XAxis type="number" fontSize={11} tickLine={false} allowDecimals={false} />
                    <YAxis
                      type="category"
                      dataKey="model"
                      width={130}
                      fontSize={10}
                      tickLine={false}
                    />
                    <Tooltip />
                    <Bar dataKey="count" name="请求数" fill="#6366f1" radius={[0, 3, 3, 0]} maxBarSize={18} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function EmptyChart() {
  return (
    <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
      当前范围内暂无数据
    </div>
  );
}
