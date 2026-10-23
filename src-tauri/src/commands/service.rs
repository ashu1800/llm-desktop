use serde::Serialize;
use tauri::{AppHandle, State};

use crate::server::manager;
use crate::state::AppState;

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
