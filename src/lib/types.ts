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

/** 命名代理条目:渠道按 url 引用,更新器按名字引用 */
export interface ProxyEntry {
  name: string;
  url: string;
}

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
  /** 客户端显示名映射:键 = 识别出的原名,值 = 自定义显示名 */
  clientAliases: Record<string, string>;
  /** 客户端图标映射:键 = 原名,值 = emoji */
  clientIcons: Record<string, string>;
  /** 命名代理池 */
  proxies: ProxyEntry[];
  /** GitHub 更新检查/下载使用的代理名;空 = 直连 */
  updaterProxy: string;
  breaker: BreakerDefaults;
  timeouts: TimeoutDefaults;
}

export interface ServiceStatus {
  running: boolean;
  addr: string | null;
}

/** 渠道对话测试结果 */
export interface TestChannelResult {
  ok: boolean;
  latencyMs: number;
  message: string;
  /** 首字延迟(响应头到达) */
  ttftMs: number | null;
  /** 模型返回文本 */
  reply: string | null;
  /** 实际使用的模型名 */
  model: string | null;
  completionTokens: number | null;
}

export type GatewayEvent =
  | { type: "serviceStatus"; running: boolean; addr: string | null }
  | { type: "settingsChanged" }
  | { type: "breakerChanged"; channelId: number; state: string }
  | { type: "requestLogged" };

export type PageKey =
  | "dashboard"
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

/** 渠道模型计费倍率规则:命中请求 cost × rate(默认 1) */
export interface RateRule {
  /** 模型名或 prefix* 通配;空串 = 全部模型 */
  model: string;
  /** 倍率(0~100);1 = 不变 */
  rate: number;
  /** all=不限 | workday=工作日 | weekend=周末 | holiday=法定节假日 */
  dayType: string;
  /** 生效时段 "HH:MM-HH:MM"(本地时区,支持跨午夜);空 = 全天 */
  timeRange: string;
  remark: string;
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
  /** 渠道级并发上限(null = 不限);0 亦视为不限 */
  maxConcurrency: number | null;
  models: string[];
  modelMap: Record<string, string>;
  timeoutOverride: TimeoutOverride | null;
  breakerOverride: BreakerOverride | null;
  remark: string;
  /** 渠道图标:emoji 或图片 dataURL;空 = 不显示 */
  icon: string;
  /** 计费币种:"cny"(默认)|"usd";按此取定价表对应价格组 */
  priceCurrency: string;
  /** 模型计费倍率规则;空 = 全部按 1.0 */
  rateRules: RateRule[];
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

export interface BreakerStatus {
  channelId: number;
  state: "closed" | "open" | "half_open";
  remainingSecs: number;
}

export interface PriceEntry {
  pattern: string;
  /** 人民币价格(元/百万 token) */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 美元价格($/百万 token),null = 未配;部分配置合法,未配侧按 0 计 */
  inputUsd: number | null;
  outputUsd: number | null;
  cacheReadUsd: number | null;
  cacheWriteUsd: number | null;
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
  /** 人民币微元(1e-6 元);usd 行为微美元(1e-6 $) */
  cost: number | null;
  /** 计费币种:"cny"(默认)|"usd" */
  currency: string;
  /** 命中的计费倍率(null = 未启用/1.0) */
  rate: number | null;
  client: string | null;
}

export interface LogDetail extends LogItem {
  reqSnapshot: string | null;
  respSnapshot: string | null;
}

export interface StatsSummary {
  count: number;
  /** 人民币微元(1e-6 元) */
  totalCost: number;
  /** 美元微(1e-6 $):美元定价条目单独记账 */
  totalCostUsd: number;
  avgTtftMs: number | null;
  avgSpeed: number | null;
  errorCount: number;
  promptTokens: number;
  completionTokens: number;
  cacheRead: number;
}

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
