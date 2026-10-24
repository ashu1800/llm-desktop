use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::server::manager;
use crate::state::AppState;
use crate::update_flag;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    pub running: bool,
    pub addr: Option<String>,
}

#[tauri::command]
pub async fn get_service_status(state: State<'_, AppState>) -> Result<ServiceStatus, String> {
    Ok(manager::status_of(&state))
}

#[tauri::command]
pub async fn start_service(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ServiceStatus, String> {
    manager::start(&state, &app).await?;
    Ok(manager::status_of(&state))
}

#[tauri::command]
pub async fn stop_service(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ServiceStatus, String> {
    manager::stop(&state, &app).await?;
    Ok(manager::status_of(&state))
}

/// 更新下载安装前落盘「更新后重启」标记:新实例启动时据此强制显示主窗口,
/// 避免静默启动设置吞掉更新拉起的新实例界面(详见 update_flag 模块注释)。
#[tauri::command]
pub async fn mark_update_restart(app: AppHandle) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("解析数据目录失败: {e}"))?;
    update_flag::mark(&data_dir);
    Ok(())
}
