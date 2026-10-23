use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

/// 启用/禁用开机自启(Windows 写 HKCU\...\CurrentVersion\Run,值附带 --silent)
pub fn set_enabled(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let auto = app.autolaunch();
    if enabled {
        auto.enable()
            .map_err(|e| format!("设置开机自启失败: {e}"))
    } else {
        auto.disable()
            .map_err(|e| format!("关闭开机自启失败: {e}"))
    }
}

pub fn is_enabled(app: &AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// 启动时校正:注册表状态与设置项保持一致
pub fn sync_with_settings(app: &AppHandle, want: bool) {
    let cur = is_enabled(app);
    if cur != want {
        if let Err(e) = set_enabled(app, want) {
            log::warn!("开机自启状态同步失败: {e}");
        }
    }
}
