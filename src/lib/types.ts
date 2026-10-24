// 与 Rust 端一一对应(serde camelCase)

export interface BreakerDefaults {
  windowSecs: number;
  consecutiveFailures: number;
  sampleMin: number;
  failureRate: number;
  cooldownSecs: number;
  backoffMaxSecs: number;
}

export interface TimeoutDefaults {
  connectSecs: number;
  ttftSecs: number;
  streamIdleSecs: number;
  nonStreamTotalSecs: number;
}

export type ThemeMode = "system" | "light" | "dark";

export interface AppSettings {
  port: number;
  listenAddr: string;
  autostart: boolean;
  silentStart: boolean;
  closeToTray: boolean;
  logRetentionDays: number;
  saveFullBody: boolean;
  theme: ThemeMode;
  language: string;
  breaker: BreakerDefaults;
  timeouts: TimeoutDefaults;
}

export interface ServiceStatus {
  running: boolean;
  addr: string | null;
}

export type GatewayEvent =
  | { type: "serviceStatus"; running: boolean; addr: string | null }
  | { type: "settingsChanged" }
  | { type: "breakerChanged"; channelId: number; state: string };

export type PageKey =
  | "dashboard"
  | "logs"
  | "channels"
  | "keys"
  | "pricing"
  | "settings";

// ---------- 渠道 / 密钥(M3) ----------

export type UpstreamProto = "openai" | "anthropic" | "gemini";

export interface TimeoutOverride {
  connectSecs?: number | null;
  ttftSecs?: number | null;
  streamIdleSecs?: number | null;
  nonStreamTotalSecs?: number | null;
}

export interface BreakerOverride {
  windowSecs?: number | null;
  consecutiveFailures?: number | null;
  sampleMin?: number | null;
  failureRate?: number | null;
  cooldownSecs?: number | null;
  backoffMaxSecs?: number | null;
}

export interface Channel {
  id: number;
  name: string;
  protocol: UpstreamProto;
  baseUrl: string;
  apiKeys: string[];
  enabled: boolean;
  /** null=跟随系统;""=直连;其他=代理 URL */
  proxy: string | null;
  models: string[];
  modelMap: Record<string, string>;
  timeoutOverride: TimeoutOverride | null;
  breakerOverride: BreakerOverride | null;
  remark: string;
  createdAt: number;
  updatedAt: number;
}

export interface ApiKey {
  id: number;
  name: string;
  key: string;
  enabled: boolean;
  channels: number[];
  remark: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface TestChannelResult {
  ok: boolean;
  latencyMs: number;
  message: string;
}

export interface BreakerStatus {
  channelId: number;
  state: "closed" | "open" | "half_open";
  remainingSecs: number;
}

export interface PriceEntry {
  pattern: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface UnpricedModel {
  model: string;
  firstSeen: number;
}

// ---------- 日志与统计(M7) ----------

export interface LogFilter {
  fromTs?: number | null;
  toTs?: number | null;
  keyId?: number | null;
  channelId?: number | null;
  model?: string;
  keyword?: string;
  statusClass?: "success" | "error" | null;
  offset: number;
  limit: number;
}

export interface LogItem {
  id: number;
  ts: number;
  keyId: number | null;
  keyName: string | null;
  channelId: number | null;
  channelName: string | null;
  model: string;
  mappedModel: string | null;
  tag: string | null;
  protocolIn: string;
  protocolUp: string | null;
  status: number;
  isStream: boolean;
  /** attempts JSON 字符串:每次尝试的渠道/耗时/错误/丢弃字段 */
  attempts: string;
  error: string | null;
  promptTokens: number;
  completionTokens: number;
  cacheRead: number;
  cacheWrite: number;
  estimated: boolean;
  ttftMs: number | null;
  totalMs: number | null;
  speed: number | null;
  cost: number | null;
  client: string | null;
}

export interface LogDetail extends LogItem {
  reqSnapshot: string | null;
  respSnapshot: string | null;
}

export interface StatsSummary {
  count: number;
  /** 人民币分 */
  totalCost: number;
  avgTtftMs: number | null;
  avgSpeed: number | null;
  errorCount: number;
  promptTokens: number;
  completionTokens: number;
  cacheRead: number;
}

/** 后端元组序列化为 JSON 数组 */
export type TrendPoint = [ts: number, count: number, costFen: number];
export type NameCount = [name: string, count: number];

/** 导入配置预览(二次确认用) */
export interface ImportPreview {
  channels: number;
  keys: number;
  prices: number;
}

/** 日志 attempts 数组条目 */
export interface AttemptEntry {
  channel?: string;
  status?: number | null;
  durationMs?: number | null;
  error?: string | null;
  droppedFields?: string[];
}
