use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::state::AppState;
use crate::store::logs::{self, LogDetail, LogFilter, LogItem, StatsSummary};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStats {
    pub db_size_bytes: u64,
    pub wal_size_bytes: u64,
    pub log_count: i64,
}

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

/// 读取 SQLite 数据库实际磁盘大小与日志记录总数
#[tauri::command]
pub async fn get_database_stats(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<DatabaseStats, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("解析数据目录失败: {e}"))?;
    let db_path = data_dir.join("gateway.db");
    let wal_path = data_dir.join("gateway.db-wal");

    let db_size_bytes = std::fs::metadata(&db_path).map(|m| m.len()).unwrap_or(0);
    let wal_size_bytes = std::fs::metadata(&wal_path).map(|m| m.len()).unwrap_or(0);

    let (log_count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM request_logs")
        .fetch_one(&state.db)
        .await
        .map_err(|e| format!("统计日志数失败: {e}"))?;

    Ok(DatabaseStats {
        db_size_bytes,
        wal_size_bytes,
        log_count,
    })
}

/// 整理并压缩数据库(回收被删除日志占用的磁盘空闲页)
#[tauri::command]
pub async fn vacuum_database(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<DatabaseStats, String> {
    sqlx::query("VACUUM")
        .execute(&state.db)
        .await
        .map_err(|e| format!("VACUUM 整理失败: {e}"))?;

    get_database_stats(state, app).await
}

/// 历史日志中出现过的客户端名(去重):客户端映射页的条目来源
#[tauri::command]
pub async fn list_clients(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    logs::list_clients(&state.db).await
}

/// 历史日志中出现过的模型名(去重):日志筛选下拉的选项来源
#[tauri::command]
pub async fn list_models(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    logs::list_models(&state.db).await
}
