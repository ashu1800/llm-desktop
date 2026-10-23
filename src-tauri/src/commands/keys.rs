use tauri::State;

use crate::state::AppState;
use crate::store::api_keys::{self, ApiKey};

#[tauri::command]
pub async fn list_api_keys(state: State<'_, AppState>) -> Result<Vec<ApiKey>, String> {
    Ok(state.keys.read().unwrap().clone())
}

/// 创建密钥:生成 sk-gw- + 32 位 hex,明文仅创建时返回一次
#[tauri::command]
pub async fn create_api_key(
    state: State<'_, AppState>,
    name: String,
    remark: String,
    channels: Vec<i64>,
) -> Result<ApiKey, String> {
    let key = ApiKey {
        id: 0,
        name: if name.trim().is_empty() { "未命名密钥".into() } else { name },
        key: api_keys::generate_key(),
        enabled: true,
        channels,
        remark,
        created_at: 0,
        last_used_at: None,
    };
    let id = api_keys::insert(&state.db, &key).await?;
    state.reload_keys().await?;
    Ok(ApiKey { id, ..key })
}

#[tauri::command]
pub async fn update_api_key(state: State<'_, AppState>, key: ApiKey) -> Result<(), String> {
    // name/enabled/channels/remark 可改;密钥明文不可改
    api_keys::update(&state.db, &key).await?;
    state.reload_keys().await?;
    Ok(())
}

#[tauri::command]
pub async fn set_api_key_enabled(
    state: State<'_, AppState>,
    id: i64,
    enabled: bool,
) -> Result<(), String> {
    api_keys::set_enabled(&state.db, id, enabled).await?;
    state.reload_keys().await?;
    Ok(())
}

#[tauri::command]
pub async fn delete_api_key(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    api_keys::delete(&state.db, id).await?;
    state.reload_keys().await?;
    Ok(())
}
