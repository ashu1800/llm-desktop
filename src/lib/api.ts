import { invoke } from "@tauri-apps/api/core";
import type {
  ApiKey,
  AppSettings,
  BreakerStatus,
  Channel,
  DatabaseStats,
  PriceEntry,
  ServiceStatus,
  TestChannelResult,
  UnpricedModel,
  UpstreamProto,
  LogDetail,
  LogFilter,
  LogItem,
  StatsSummary,
  ImportPreview,
} from "./types";

// 管理面一律走 Tauri IPC,不直连 HTTP 端口(架构约束)
export const api = {
  // 设置 / 服务
  getSettings: () => invoke<AppSettings>("get_settings"),
  updateSettings: (settings: AppSettings) =>
    invoke<AppSettings>("update_settings", { settings }),
  isPortAvailable: (listenAddr: string, port: number) =>
    invoke<boolean>("is_port_available", { listenAddr, port }),
  getServiceStatus: () => invoke<ServiceStatus>("get_service_status"),
  getLanIp: () => invoke<string | null>("get_lan_ip"),
  startService: () => invoke<ServiceStatus>("start_service"),
  stopService: () => invoke<ServiceStatus>("stop_service"),

  // 渠道
  listChannels: () => invoke<Channel[]>("list_channels"),
  createChannel: (channel: Channel) => invoke<Channel>("create_channel", { channel }),
  updateChannel: (channel: Channel) => invoke<void>("update_channel", { channel }),
  deleteChannel: (id: number) => invoke<void>("delete_channel", { id }),
  setChannelEnabled: (id: number, enabled: boolean) =>
    invoke<void>("set_channel_enabled", { id, enabled }),
  /** 渠道对话测试:发真实消息,返回回复/首字/总耗时 */
  testChannel: (id: number, prompt?: string, model?: string) =>
    invoke<TestChannelResult>("test_channel", { id, prompt, model }),
  /** 拉取上游支持的模型列表(渠道编辑"获取模型"用) */
  fetchUpstreamModels: (args: {
    baseUrl: string;
    protocol: UpstreamProto;
    apiKey: string;
    proxy?: string | null;
  }) => invoke<string[]>("fetch_upstream_models", args),

  // 密钥
  listApiKeys: () => invoke<ApiKey[]>("list_api_keys"),
  createApiKey: (
    name: string,
    remark: string,
    channels: number[],
    models: string[],
    modelChannels: Record<string, number[]>,
  ) =>
    invoke<ApiKey>("create_api_key", {
      name,
      remark,
      channels,
      models,
      modelChannels,
    }),
  updateApiKey: (key: ApiKey) => invoke<void>("update_api_key", { key }),
  setApiKeyEnabled: (id: number, enabled: boolean) =>
    invoke<void>("set_api_key_enabled", { id, enabled }),
  deleteApiKey: (id: number) => invoke<void>("delete_api_key", { id }),

  // 定价
  listModelPrices: () => invoke<PriceEntry[]>("list_model_prices"),
  upsertModelPrice: (price: PriceEntry) =>
    invoke<void>("upsert_model_price", { price }),
  deleteModelPrice: (pattern: string) => invoke<void>("delete_model_price", { pattern }),
  listUnpricedModels: () => invoke<UnpricedModel[]>("list_unpriced_models"),
  dismissUnpricedModel: (model: string) =>
    invoke<void>("dismiss_unpriced_model", { model }),
  backfillCosts: () => invoke<number>("backfill_costs"),
  quickPriceAndBackfill: (price: PriceEntry) =>
    invoke<number>("quick_price_and_backfill", { price }),

  // 日志与统计
  queryLogs: (filter: LogFilter) =>
    invoke<[LogItem[], number]>("query_logs", { filter }),
  getRequestLog: (id: number) =>
    invoke<LogDetail | null>("get_request_log", { id }),
  getStats: (filter: LogFilter) => invoke<StatsSummary>("get_stats", { filter }),
  clearLogs: () => invoke<void>("clear_logs"),
  getDatabaseStats: () => invoke<DatabaseStats>("get_database_stats"),
  vacuumDatabase: () => invoke<DatabaseStats>("vacuum_database"),
  listClients: () => invoke<string[]>("list_clients"),
  listLogModels: () => invoke<string[]>("list_models"),
  /** 弹图片选择框,规范化为 64px PNG dataURL;取消返回 null */
  pickClientIcon: () => invoke<string | null>("pick_client_icon"),
  /** 经指定代理测 GitHub 延迟(ms);失败抛错 */
  testProxyLatency: (url: string) => invoke<number>("test_proxy_latency", { url }),
  /** 更新器应使用的代理 url(按设置 updaterProxy 名解析);null = 直连 */
  getUpdaterProxy: () => invoke<string | null>("get_updater_proxy"),

  // 配置导入导出
  exportConfig: () => invoke<string | null>("export_config"),
  importConfigPreview: () =>
    invoke<[string, ImportPreview] | null>("import_config_preview"),
  importConfigApply: (path: string) =>
    invoke<void>("import_config_apply", { path }),

  // 熔断
  getBreakerStates: () => invoke<BreakerStatus[]>("get_breaker_states"),
  recoverChannel: (id: number) => invoke<void>("recover_channel", { id }),
};

/** 掩码显示 API Key:sk-abc***xyz;短串全掩码,防止 slice 泄露过半明文 */
export function maskKey(key: string): string {
  if (key.length <= 12) return "***";
  return `${key.slice(0, 8)}***${key.slice(-4)}`;
}
