use tauri::State;

use crate::state::AppState;
use crate::store::logs::{self, LogDetail, LogFilter, LogItem, StatsSummary};

#[tauri::command]
pub async fn query_logs(
    state: State<'_, AppState>,
    filter: LogFilter,
) -> Result<(Vec<LogItem>, i64), String> {
    logs::query_logs(&state.db, &filter).await
}

#[tauri::command]
pub async fn get_request_log(
    state: State<'_, AppState>,
    id: i64,
) -> Result<Option<LogDetail>, String> {
    logs::get_request_log(&state.db, id).await
}

#[tauri::command]
pub async fn get_stats(
    state: State<'_, AppState>,
    filter: LogFilter,
) -> Result<StatsSummary, String> {
    logs::stats_summary(&state.db, &filter).await
}

/// 设置页一键清空日志(前端二次确认后调用)
#[tauri::command]
pub async fn clear_logs(state: State<'_, AppState>) -> Result<(), String> {
    logs::clear_all(&state.db).await
}

/// 历史日志中出现过的客户端名(去重):客户端映射页的条目来源
#[tauri::command]
pub async fn list_clients(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    logs::list_clients(&state.db).await
}
