// 集成测试(tests/)需要直接驱动 handler,故模块对 crate 外可见
pub mod autostart;
pub mod billing;
pub mod breaker;
pub mod commands;
pub mod events;
pub mod proto;
pub mod proxy;
pub mod server;
pub mod settings;
pub mod state;
pub mod store;
pub mod transform;
pub mod tray;
pub mod util;

use tauri::Manager;
use state::AppState;
use tokio::sync::mpsc;

pub fn run() {
    tauri::Builder::default()
        // 单实例必须最先注册,二次启动时唤起已有窗口
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("llm-desktop".into()),
                    }),
                ])
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            // 自启动时附带 --silent,保证开机后静默进托盘
            Some(vec!["--silent"]),
        ))
        // 自动更新:检查 GitHub Releases 的 latest.json,下载后校验 minisign 签名安装
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let state = tauri::async_runtime::block_on(init_state(&handle))?;
            app.manage(state.clone());

            // 随应用启动代理监听;端口被占用等异常只记日志,不阻断应用
            if let Err(e) = tauri::async_runtime::block_on(server::manager::start(&state, &handle)) {
                log::warn!("代理服务未能随应用启动: {e}");
            }

            // 校正注册表自启状态与设置一致
            autostart::sync_with_settings(&handle, state.current_settings().autostart);
            tray::create(&handle)?;

            // --silent 参数或设置项 → 静默启动,仅托盘运行
            let silent =
                std::env::args().any(|a| a == "--silent") || state.current_settings().silent_start;
            if !silent {
                show_main_window(&handle);
            }

            // 日志保留清理:每小时幂等删除超过保留期的记录(等效每日清理,结果一致)
            {
                let state = state.clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
                        let days = state.current_settings().log_retention_days;
                        if days == 0 {
                            continue;
                        }
                        let before = crate::util::now_ms() - (days as i64) * 86_400_000;
                        match store::logs::delete_older_than(&state.db, before).await {
                            Ok(0) => {}
                            Ok(n) => log::info!("日志清理:删除 {n} 条超过 {days} 天的记录"),
                            Err(e) => log::warn!("日志清理失败: {e}"),
                        }
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // 关闭窗口 = 隐藏到托盘并保持代理运行;设置项可改为真正退出
                let app = window.app_handle();
                let close_to_tray = app.state::<AppState>().current_settings().close_to_tray;
                if close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings::get_settings,
            commands::settings::update_settings,
            commands::settings::is_port_available,
            commands::service::get_service_status,
            commands::service::start_service,
            commands::service::stop_service,
            commands::channels::list_channels,
            commands::channels::create_channel,
            commands::channels::update_channel,
            commands::channels::delete_channel,
            commands::channels::set_channel_enabled,
            commands::channels::test_channel,
            commands::keys::list_api_keys,
            commands::keys::create_api_key,
            commands::keys::update_api_key,
            commands::keys::set_api_key_enabled,
            commands::keys::delete_api_key,
            commands::prices::list_model_prices,
            commands::prices::upsert_model_price,
            commands::prices::delete_model_price,
            commands::prices::list_unpriced_models,
            commands::prices::dismiss_unpriced_model,
            commands::prices::backfill_costs,
            commands::prices::quick_price_and_backfill,
            commands::logs::query_logs,
            commands::logs::get_request_log,
            commands::logs::get_stats,
            commands::logs::get_trend,
            commands::logs::get_channel_stats,
            commands::logs::get_model_stats,
            commands::logs::clear_logs,
            commands::config::export_config,
            commands::config::import_config_preview,
            commands::config::import_config_apply,
            commands::breaker::get_breaker_states,
            commands::breaker::recover_channel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

async fn init_state(handle: &tauri::AppHandle) -> Result<AppState, Box<dyn std::error::Error>> {
    let data_dir = handle.path().app_data_dir()?;
    std::fs::create_dir_all(&data_dir)?;
    let db = store::init_pool(&data_dir.join("gateway.db")).await?;
    let settings = store::settings::load(&db).await?;

    // 日志批量写入任务:mpsc 队列满时丢弃,不阻塞响应
    let (log_tx, log_rx) = mpsc::channel(store::logs::QUEUE_SIZE);
    store::logs::spawn_writer(db.clone(), log_rx);

    // 网关事件转发任务:proxy 在 axum handler 内发事件,这里转发到前端 + 同步托盘
    let (event_tx, mut event_rx) = mpsc::channel::<events::GatewayEvent>(256);
    {
        let handle = handle.clone();
        tauri::async_runtime::spawn(async move {
            use tauri::Emitter;
            while let Some(ev) = event_rx.recv().await {
                if matches!(ev, events::GatewayEvent::BreakerChanged { .. }) {
                    tray::refresh(&handle);
                }
                let _ = handle.emit(events::CHANNEL, ev);
            }
        });
    }

    let state = AppState::new(db, settings, log_tx, event_tx);
    state.reload_channels().await?;
    state.reload_keys().await?;
    state.reload_prices().await?;
    log::info!(
        "状态初始化完成: db={}, channels={}, keys={}, prices={}",
        data_dir.join("gateway.db").display(),
        state.channels.read().unwrap().len(),
        state.keys.read().unwrap().len(),
        state.prices.read().unwrap().rows.len(),
    );
    Ok(state)
}

pub fn show_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}
