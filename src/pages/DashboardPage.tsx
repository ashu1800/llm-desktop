import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CircleCheck,
  CircleDollarSign,
  Coins,
  Link2,
  Zap,
  type LucideIcon,
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
import {
  useApiKeys,
  useBreakerStates,
  useChannelStats,
  useChannels,
  useModelStats,
  useStats,
  useTrend,
  useUnpricedModels,
} from "@/hooks/use-gateway";
import {
  cacheHitRate,
  fmtK,
  fmtMs,
  fmtYuan,
  rangeFromTs,
  TIME_RANGE_LABELS,
  type TimeRange,
} from "@/lib/format";
import type { LogFilter } from "@/lib/types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

// Claude 暖色系:陶土橘 + 橄榄绿 + 沙棕等(与主题主色一致)
const PIE_COLORS = [
  "#D97757",
  "#8A9A5B",
  "#D4A27F",
  "#6A9BCC",
  "#C2A878",
  "#7D8A5C",
  "#B5654A",
  "#94A187",
  "#D9B48F",
  "#8B8B83",
];

function trendLabel(ts: number, bucket: "hour" | "day"): string {
  const d = new Date(ts);
  return bucket === "day"
    ? `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, "0")}`
    : `${String(d.getHours()).padStart(2, "0")}:00`;
}

// 汇总卡:左图标色块 + 右标签/数值(数值同色)/小字提示
function StatCard({
  icon: Icon,
  tile,
  valueClass,
  label,
  value,
  hint,
}: {
  icon: LucideIcon;
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

// 仪表盘时间分段(截图样式:今天/近3天/近7天/近30天,无"全部")
const DASH_RANGES: TimeRange[] = ["today", "3d", "7d", "30d"];

export function DashboardPage() {
  const { data: breakers } = useBreakerStates();
  const { data: unpriced } = useUnpricedModels();
  const { data: channels } = useChannels();
  const { data: keys } = useApiKeys();
  const [range, setRange] = useState<TimeRange>("today");
  const [channelFilter, setChannelFilter] = useState("all");
  const [keyFilter, setKeyFilter] = useState("all");
  const [bucket, setBucket] = useState<"hour" | "day">("hour");

  const filter = useMemo<LogFilter>(
    () => ({
      fromTs: rangeFromTs(range),
      channelId: channelFilter === "all" ? null : Number(channelFilter),
      keyId: keyFilter === "all" ? null : Number(keyFilter),
      offset: 0,
      limit: 1,
    }),
    [range, channelFilter, keyFilter],
  );

  const { data: stats } = useStats(filter);
  const { data: trend } = useTrend(filter, bucket);
  const { data: byChannel } = useChannelStats(filter);
  const { data: topModels } = useModelStats(filter);

  const openBreakers = (breakers ?? []).filter((b) => b.state !== "closed");
  const successRate =
    stats && stats.count > 0
      ? `${(((stats.count - stats.errorCount) / stats.count) * 100).toFixed(1)}%`
      : "—";
  const trendData = (trend ?? []).map(([ts, count, cost]) => ({
    ts,
    label: trendLabel(ts, bucket),
    count,
    costYuan: cost / 100,
  }));

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

      {/* 筛选:时间分段 + 渠道/密钥,联动下方卡片与图表 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">时间范围</span>
          <div className="flex items-center rounded-lg border bg-card p-0.5">
            {DASH_RANGES.map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
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
          onValueChange={setChannelFilter}
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
        <Select value={keyFilter} onValueChange={setKeyFilter}>
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
          icon={Zap}
          tile="bg-[#5FA8E8]/15 text-[#5FA8E8]"
          valueClass="text-[#3E87C9] dark:text-[#7FBBF0]"
          label="词元数量"
          value={
            stats
              ? fmtK(stats.promptTokens + stats.completionTokens)
              : "—"
          }
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
                      fill="#D97757"
                      radius={[3, 3, 0, 0]}
                      maxBarSize={28}
                    />
                    <Line
                      yAxisId="cost"
                      type="monotone"
                      dataKey="costYuan"
                      name="费用"
                      stroke="#8A9A5B"
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
                    <Bar dataKey="count" name="请求数" fill="#D97757" radius={[0, 3, 3, 0]} maxBarSize={18} />
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
