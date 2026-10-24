use tauri::{AppHandle, State};

use crate::events::{self, GatewayEvent};
use crate::server::{self, manager};
use crate::settings::AppSettings;
use crate::state::AppState;
use crate::{autostart, store, tray};

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    Ok(state.current_settings())
}

/// 保存设置并应用热生效:
/// - 端口/监听地址变更 → 探测占用并平滑重启监听(失败则不落盘)
/// - 开机自启变更 → 同步注册表
#[tauri::command]
pub async fn update_settings(
    state: State<'_, AppState>,
    app: AppHandle,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    let new_settings = settings.normalized();
    let old = state.current_settings();

    let addr_changed = old.port != new_settings.port || old.listen_addr != new_settings.listen_addr;
    if addr_changed {
        let target = manager::parse_listen(&new_settings.listen_addr, new_settings.port)?;
        manager::apply_listen_change(&state, target).await?;
    }

    if old.autostart != new_settings.autostart {
        autostart::set_enabled(&app, new_settings.autostart)?;
    }

    store::settings::save(&state.db, &new_settings).await?;
    *crate::util::write_ok(&state.settings) = new_settings.clone();

    events::emit(&app, GatewayEvent::SettingsChanged);
    // 自启勾选态可能变化,同步托盘菜单
    tray::refresh(&app);
    Ok(new_settings)
}

/// 保存前端口占用检测
#[tauri::command]
pub async fn is_port_available(listen_addr: String, port: u16) -> Result<bool, String> {
    let target = manager::parse_listen(&listen_addr, port)?;
    Ok(server::check_bind(target).await.is_ok())
}
