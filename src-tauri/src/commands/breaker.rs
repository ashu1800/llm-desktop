use serde::Serialize;
use tauri::State;

use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakerStatus {
    pub channel_id: i64,
    /// closed | open | half_open
    pub state: String,
    /// Open 状态剩余冷却秒数
    pub remaining_secs: u64,
}

#[tauri::command]
pub async fn get_breaker_states(state: State<'_, AppState>) -> Result<Vec<BreakerStatus>, String> {
    let channels = state.channels.read().unwrap();
    Ok(channels
        .iter()
        .map(|c| {
            let t = state.breakers.status(c.id);
            BreakerStatus {
                channel_id: c.id,
                state: t.state.as_str().to_string(),
                remaining_secs: t.remaining_secs,
            }
        })
        .collect())
}

/// 手动恢复:强制关闭熔断并清空统计(事件触发前端与托盘刷新)
#[tauri::command]
pub async fn recover_channel(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    if let Some(tr) = state.breakers.reset(id) {
        let _ = state.event_tx.try_send(crate::events::GatewayEvent::BreakerChanged {
            channel_id: id,
            state: tr.state.as_str().to_string(),
        });
    }
    Ok(())
}
