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

#[tauri::command]
pub async fn get_trend(
    state: State<'_, AppState>,
    filter: LogFilter,
    // "hour" | "day"
    bucket: String,
) -> Result<Vec<(i64, i64, i64)>, String> {
    let bucket_ms = match bucket.as_str() {
        "day" => 86_400_000,
        _ => 3_600_000,
    };
    logs::stats_trend(&state.db, &filter, bucket_ms).await
}

#[tauri::command]
pub async fn get_channel_stats(
    state: State<'_, AppState>,
    filter: LogFilter,
) -> Result<Vec<(String, i64)>, String> {
    logs::stats_by_channel(&state.db, &filter).await
}

#[tauri::command]
pub async fn get_model_stats(
    state: State<'_, AppState>,
    filter: LogFilter,
) -> Result<Vec<(String, i64)>, String> {
    logs::stats_top_models(&state.db, &filter, 10).await
}

/// 设置页一键清空日志(前端二次确认后调用)
#[tauri::command]
pub async fn clear_logs(state: State<'_, AppState>) -> Result<(), String> {
    logs::clear_all(&state.db).await
}
