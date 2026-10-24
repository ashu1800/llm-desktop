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

/** 五档色阶:0=深绿(快) → 1=浅绿 → 2=橙黄 → 3=浅红 → 4=深红(慢/异常) */
const LADDER = [
  "text-emerald-600 dark:text-emerald-400",
  "text-emerald-500/70 dark:text-emerald-400/60",
  "text-amber-500",
  "text-red-400",
  "text-red-600 dark:text-red-400",
];

/**
 * 耗时分档着色:深绿=快 → 浅绿=可接受 → 橙黄=偏慢 → 浅红=慢 → 深红=异常。
 * thresholds 传四档上限(毫秒)。
 *
 * 阈值依据(2026-10 拍板,按"慢 LLM/长上下文/中转"实际体验定档):
 * - 首字 [5000, 10000, 20000, 40000]:≤5s 正常(深绿);5~10s 浅绿;
 *   10~20s 橙黄;20~40s 浅红;≥40s 深红(明显异常)。
 * - 生成耗时(总耗时−首字,流式):同比例阶梯,长输出场景放宽。
 */
export function latencyColor(
  ms: number | null | undefined,
  thresholds: [number, number, number, number],
): string {
  if (ms == null) return "";
  return LADDER[durationSeverity(ms, thresholds)];
}

// 时长档位:低于第几档阈值(越快越靠前)
function durationSeverity(
  ms: number,
  thresholds: [number, number, number, number],
): number {
  if (ms < thresholds[0]) return 0;
  if (ms < thresholds[1]) return 1;
  if (ms < thresholds[2]) return 2;
  if (ms < thresholds[3]) return 3;
  return 4;
}

/**
 * 生成速度分档着色(t/s):与耗时色阶语义对齐,方向相反——快=绿,慢=红。
 * thresholds 传四档下限:≥[0] 深绿 → ≥[1] 浅绿 → ≥[2] 橙黄 → ≥[3] 浅红,< [3] 深红。
 * 阈值依据(2026-10 拍板):≥50 t/s 旗舰水准(深绿);20~50 良好(浅绿);
 * 10~20 偏慢(橙黄,长上下文/推理模型常见);5~10 慢(浅红);<5 明显异常(深红,
 * 多为超长上下文预填或上游限流)。
 */
export function speedColor(tps: number | null | undefined): string {
  if (tps == null) return "";
  if (tps >= 50) return LADDER[0];
  if (tps >= 20) return LADDER[1];
  if (tps >= 10) return LADDER[2];
  if (tps >= 5) return LADDER[3];
  return LADDER[4];
}

/**
 * 耗时着色(流式结合速度):纯时长会把"120s 出 12K 词元"的大输出请求误判为红——
 * 实际是健康的高速长生成。取「时长档位」与「速度档位」中**较轻**的一档:
 * 长耗时 + 大输出(高 t/s)→ 绿;长耗时 + 小输出(低 t/s)→ 红(真卡)。
 * 输出过少(<50 tok)时速度无统计意义,按时长单独评;非流式无速度概念同。
 */
export function durationColor(
  genMs: number | null | undefined,
  thresholds: [number, number, number, number],
  opts?: { isStream?: boolean; completionTokens?: number },
): string {
  const { isStream, completionTokens } = opts ?? {};
  if (!isStream || genMs == null || genMs <= 0 || !completionTokens) {
    return latencyColor(genMs, thresholds);
  }
  // 速度档位取"低于第几档下限"的倒数(越快严重度越低),与时长档取较轻者
  const tps = (completionTokens * 1000) / genMs;
  const speedSeverity = tps >= 50 ? 0 : tps >= 20 ? 1 : tps >= 10 ? 2 : tps >= 5 ? 3 : 4;
  const sev = Math.min(durationSeverity(genMs, thresholds), speedSeverity);
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
