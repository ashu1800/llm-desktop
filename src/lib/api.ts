import { invoke } from "@tauri-apps/api/core";
import type {
  ApiKey,
  AppSettings,
  BreakerStatus,
  Channel,
  PriceEntry,
  ServiceStatus,
  TestChannelResult,
  UnpricedModel,
  LogDetail,
  LogFilter,
  LogItem,
  NameCount,
  StatsSummary,
  TrendPoint,
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
  startService: () => invoke<ServiceStatus>("start_service"),
  stopService: () => invoke<ServiceStatus>("stop_service"),

  // 渠道
  listChannels: () => invoke<Channel[]>("list_channels"),
  createChannel: (channel: Channel) => invoke<Channel>("create_channel", { channel }),
  updateChannel: (channel: Channel) => invoke<void>("update_channel", { channel }),
  deleteChannel: (id: number) => invoke<void>("delete_channel", { id }),
  setChannelEnabled: (id: number, enabled: boolean) =>
    invoke<void>("set_channel_enabled", { id, enabled }),
  testChannel: (id: number) => invoke<TestChannelResult>("test_channel", { id }),

  // 密钥
  listApiKeys: () => invoke<ApiKey[]>("list_api_keys"),
  createApiKey: (name: string, remark: string, channels: number[]) =>
    invoke<ApiKey>("create_api_key", { name, remark, channels }),
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
  getTrend: (filter: LogFilter, bucket: "hour" | "day") =>
    invoke<TrendPoint[]>("get_trend", { filter, bucket }),
  getChannelStats: (filter: LogFilter) =>
    invoke<NameCount[]>("get_channel_stats", { filter }),
  getModelStats: (filter: LogFilter) =>
    invoke<NameCount[]>("get_model_stats", { filter }),
  clearLogs: () => invoke<void>("clear_logs"),

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

/** 掩码显示 API Key:sk-abc***xyz */
export function maskKey(key: string): string {
  if (key.length <= 12) return key.slice(0, 4) + "***";
  return `${key.slice(0, 8)}***${key.slice(-4)}`;
}
