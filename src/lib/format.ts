// 展示格式化:费用(¥,6 位小数)、token 千分位 K 缩写、时长等(PRD §3.7)

/** 人民币微元(1e-6 元)→ ¥ 元,保留 6 位小数 */
export function fmtYuan(fen: number | null | undefined): string {
  if (fen == null) return "—";
  return `¥${(fen / 1_000_000).toFixed(6)}`;
}

/** 美元微(1e-6 $)→ $ 元,保留 6 位小数;与人民币互不换算、分列展示 */
export function fmtUsd(microUsd: number | null | undefined): string {
  if (microUsd == null) return "—";
  return `$${(microUsd / 1_000_000).toFixed(6)}`;
}

/** 千分位 K 缩写:940 → 940,12345 → 12.3K,1234567 → 1.2M */
export function fmtK(n: number | null | undefined): string {
  if (n == null) return "—";
  if (Math.abs(n) < 1000) return String(n);
  if (Math.abs(n) < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** 毫秒 → "1.2s" / "350ms" */
export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 三档色阶:0=绿(正常) → 1=橙(偏慢) → 2=红(异常) */
const LADDER = [
  "text-emerald-600 dark:text-emerald-400",
  "text-amber-500",
  "text-red-600 dark:text-red-400",
];

/** 两档阈值:[绿上限, 橙上限];超过橙上限即红 */
export type PairThresholds = [number, number];

/**
 * 耗时分档着色:绿=正常 → 橙=偏慢 → 红=异常。
 * thresholds 传两档上限(毫秒),低于第一档绿、低于第二档橙、其余红。
 *
 * 首字阈值(用户指定):0~5s 绿;5~15s 橙;≥15s 红。
 * 生成耗时阈值:长输出场景,20s 内绿;20~60s 橙;≥60s 红(再结合速度取较轻档)。
 */
export function latencyColor(
  ms: number | null | undefined,
  thresholds: PairThresholds,
): string {
  if (ms == null) return "";
  return LADDER[durationSeverity(ms, thresholds)];
}

// 时长档位:低于第一档 0(绿)、低于第二档 1(橙)、其余 2(红)
function durationSeverity(ms: number, thresholds: PairThresholds): number {
  if (ms < thresholds[0]) return 0;
  if (ms < thresholds[1]) return 1;
  return 2;
}

/**
 * 生成速度分档着色(t/s):与耗时色阶语义对齐,方向相反——快=绿,慢=红。
 * ≥150 彩虹渐变(极速档,视觉上"超出档位");80~150 绿;40~80 橙;≤40 红(用户指定)。
 */
export function speedColor(tps: number | null | undefined): string {
  if (tps == null) return "";
  if (tps >= 150) return "rainbow-text";
  return LADDER[speedSeverity(tps)];
}

// 速度档位:快=0(绿)、中=1(橙)、慢=2(红)。
// 极速档(≥150)与绿同严重度(都是"很好"),差异只在 speedColor 的颜色表现,
// 故这里不单独设档——否则两处各写一遍阈值,改一处忘另一处会让「速度」列
// 与「耗时」列(经 durationColor 取较轻档)对同一条日志给出不一致的判定
function speedSeverity(tps: number): number {
  if (tps >= 80) return 0;
  if (tps > 40) return 1;
  return 2;
}

/**
 * 耗时着色(流式结合速度):纯时长会把"120s 出 12K 词元"的大输出请求误判为红——
 * 实际是健康的高速长生成。取「时长档位」与「速度档位」中**较轻**的一档:
 * 长耗时 + 大输出(高 t/s)→ 绿;长耗时 + 小输出(低 t/s)→ 红(真卡)。
 * 输出过少(<50 tok)时速度无统计意义,按时长单独评;非流式无速度概念同。
 */
export function durationColor(
  genMs: number | null | undefined,
  thresholds: PairThresholds,
  opts?: { isStream?: boolean; completionTokens?: number },
): string {
  const { isStream, completionTokens } = opts ?? {};
  if (!isStream || genMs == null || genMs <= 0 || !completionTokens) {
    return latencyColor(genMs, thresholds);
  }
  const tps = (completionTokens * 1000) / genMs;
  const sev = Math.min(durationSeverity(genMs, thresholds), speedSeverity(tps));
  return LADDER[sev];
}

/** 时间戳 → HH:mm:ss(title 用完整日期) */
export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

export function fmtFullTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

/** 缓存命中率:cache_read / 总输入(prompt),保留两位小数 */
export function cacheHitRate(cacheRead: number, prompt: number): string {
  if (prompt <= 0) return "—";
  return `${((cacheRead / prompt) * 100).toFixed(2)}%`;
}

/** 与 Rust PriceTable::match_for 一致:精确优先,通配取最后一条命中 */
export function matchPrice<T extends { pattern: string }>(
  rows: T[],
  model: string,
): T | undefined {
  const exact = rows.find((r) => r.pattern === model);
  if (exact) return exact;
  return [...rows]
    .reverse()
    .find(
      (r) =>
        r.pattern.endsWith("*") &&
        model.startsWith(r.pattern.slice(0, -1)),
    );
}

/** attempts JSON 安全解析 */
export function parseAttempts(attemptsJson: string): unknown[] {
  try {
    const v = JSON.parse(attemptsJson);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export type TimeRange = "today" | "3d" | "7d" | "30d" | "all";

/** 时间范围 → fromTs(全部返回 null) */
export function rangeFromTs(range: TimeRange): number | null {
  const now = new Date();
  switch (range) {
    case "today": {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return d.getTime();
    }
    case "3d":
      return now.getTime() - 3 * 86_400_000;
    case "7d":
      return now.getTime() - 7 * 86_400_000;
    case "30d":
      return now.getTime() - 30 * 86_400_000;
    default:
      return null;
  }
}

export const TIME_RANGE_LABELS: Record<TimeRange, string> = {
  today: "今天",
  "3d": "近 3 天",
  "7d": "近 7 天",
  "30d": "近 30 天",
  all: "全部",
};
