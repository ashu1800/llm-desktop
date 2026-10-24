use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// 前端约定的事件频道
pub const CHANNEL: &str = "gateway://events";

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum GatewayEvent {
    ServiceStatus {
        running: bool,
        addr: Option<String>,
    },
    SettingsChanged,
    /// 熔断状态变化推送
    BreakerChanged {
        channel_id: i64,
        state: String,
    },
    /// 一批请求日志已落库,前端据此实时刷新日志表与统计卡片
    RequestLogged,
}

pub fn emit(app: &AppHandle, event: GatewayEvent) {
    if let Err(e) = app.emit(CHANNEL, event) {
        log::warn!("事件推送失败: {e}");
    }
}
