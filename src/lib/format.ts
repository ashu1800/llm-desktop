// 展示格式化:费用(¥,6 位小数)、token 千分位 K 缩写、时长等(PRD §3.7)

/** 人民币微元(1e-6 元)→ ¥ 元,保留 6 位小数 */
export function fmtYuan(fen: number | null | undefined): string {
  if (fen == null) return "—";
  return `¥${(fen / 1_000_000).toFixed(6)}`;
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

/**
 * 耗时分档着色:绿=快 → 蓝=正常 → 橙=偏慢 → 红=慢。
 * thresholds 传三档上限(毫秒),如首字 [1000, 3000, 8000]。
 *
 * 阈值依据(2026-10 查证):
 * - 首字:信通院 2025 年度监测国内大模型 TTFT 中位数 0.58s、76% <1s
 *   (hs.china.com.cn/2026-02/11/content_43355245.html),GPT/Claude <0.5s;
 *   AI Economics 旗舰 API 约 1.0~1.3s,聊天界面 P95 应 <2s。
 *   → 绿 <1s = 优于行业中位;蓝 1~3s = 可接受(含中转/长上下文预填开销);
 *     红 ≥8s = 明显异常。
 * - 生成耗时(总耗时−首字):旗舰 API 输出速度 40~60 t/s、轻量 100+
 *   (arXiv 2504.17999:GPT-4o ≈60 t/s)。5/15/60s 分档 ≈ 250/750/3000
 *   token 输出;红 ≥60s 意味有效速度 <10 t/s——即 ITL >100ms 的明显卡顿区。
 */
export function latencyColor(
  ms: number | null | undefined,
  thresholds: [number, number, number],
): string {
  if (ms == null) return "";
  if (ms < thresholds[0]) return "text-emerald-500";
  if (ms < thresholds[1]) return "text-sky-500";
  if (ms < thresholds[2]) return "text-amber-500";
  return "text-red-500";
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
