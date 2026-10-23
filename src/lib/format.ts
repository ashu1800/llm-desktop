// 展示格式化:费用(¥,6 位小数)、token 千分位 K 缩写、时长等(PRD §3.7)

/** 人民币分 → ¥ 元,保留 6 位小数 */
export function fmtYuan(fen: number | null | undefined): string {
  if (fen == null) return "—";
  return `¥${(fen / 100).toFixed(6)}`;
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

/** 时间戳 → HH:mm:ss(title 用完整日期) */
export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

export function fmtFullTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

/** 缓存命中率:cache_read / 总输入(prompt) */
export function cacheHitRate(cacheRead: number, prompt: number): string {
  if (prompt <= 0) return "—";
  return `${Math.round((cacheRead / prompt) * 100)}%`;
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

export type TimeRange = "today" | "7d" | "30d" | "all";

/** 时间范围 → fromTs(全部返回 null) */
export function rangeFromTs(range: TimeRange): number | null {
  const now = new Date();
  switch (range) {
    case "today": {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return d.getTime();
    }
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
  "7d": "近 7 天",
  "30d": "近 30 天",
  all: "全部",
};
