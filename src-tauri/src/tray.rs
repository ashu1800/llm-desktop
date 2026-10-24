use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::{autostart, state::AppState};

const TRAY_ID: &str = "main-tray";

/// 托盘图标状态:绿=服务运行、灰=服务停止(红=全渠道熔断,M3 接入)
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(current_icon(app))
        .tooltip("LLM Gateway")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| on_menu_event(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn is_running(app: &AppHandle) -> bool {
    crate::util::lock_ok(&app.state::<AppState>().server).is_some()
}

fn current_icon(app: &AppHandle) -> tauri::image::Image<'static> {
    // include_image! 相对 Cargo manifest 目录(src-tauri)解析
    if !is_running(app) {
        tauri::include_image!("icons/tray-gray.png")
    } else if is_degraded(app) {
        // 服务运行但所有启用渠道均熔断
        tauri::include_image!("icons/tray-red.png")
    } else {
        tauri::include_image!("icons/tray-green.png")
    }
}

fn is_degraded(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    let channels = crate::util::read_ok(&state.channels);
    let enabled: Vec<_> = channels.iter().filter(|c| c.enabled).collect();
    !enabled.is_empty()
        && enabled
            .iter()
            .all(|c| state.breakers.status(c.id).state != crate::breaker::State::Closed)
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let running = is_running(app);
    let open = MenuItem::with_id(app, "open", "打开主界面", true, None::<&str>)?;
    let toggle = MenuItem::with_id(
        app,
        "toggle",
        if running {
            "停止代理服务"
        } else {
            "启动代理服务"
        },
        true,
        None::<&str>,
    )?;
    let autostart_item = CheckMenuItem::with_id(
        app,
        "autostart",
        "开机自启",
        true,
        autostart::is_enabled(app),
        None::<&str>,
    )?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    Menu::with_items(app, &[&open, &toggle, &sep1, &autostart_item, &sep2, &quit])
}

fn on_menu_event(app: &AppHandle, id: &str) {
    match id {
        "open" => crate::show_main_window(app),
        "toggle" => {
            let state = app.state::<AppState>().inner().clone();
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let running = crate::util::lock_ok(&state.server).is_some();
                let result = if running {
                    crate::server::manager::stop(&state, &handle).await.map(|_| ())
                } else {
                    crate::server::manager::start(&state, &handle).await.map(|_| ())
                };
                if let Err(e) = result {
                    log::error!("托盘切换代理服务失败: {e}");
                }
            });
        }
        "autostart" => {
            let want = !autostart::is_enabled(app);
            if let Err(e) = autostart::set_enabled(app, want) {
                log::error!("{e}");
                refresh(app);
                return;
            }
            let snapshot = {
                let state = app.state::<AppState>();
                let mut s = crate::util::write_ok(&state.settings);
                s.autostart = want;
                s.clone()
            };
            let db = app.state::<AppState>().db.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = crate::store::settings::save(&db, &snapshot).await {
                    log::error!("保存设置失败: {e}");
                }
            });
            refresh(app);
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

/// 状态变化后重建菜单与图标(不持有菜单句柄,整体替换最简单)
pub fn refresh(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_icon(Some(current_icon(app)));
        if let Ok(menu) = build_menu(app) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}
