use std::net::SocketAddr;

use tauri::AppHandle;

use crate::commands::service::ServiceStatus;
use crate::events::{self, GatewayEvent};
use crate::state::AppState;
use crate::tray;

/// "127.0.0.1" + 8787 → SocketAddr
pub fn parse_listen(listen_addr: &str, port: u16) -> Result<SocketAddr, String> {
    format!("{listen_addr}:{port}")
        .parse::<SocketAddr>()
        .map_err(|_| format!("无效的监听地址 {listen_addr}:{port}"))
}

pub fn status_of(state: &AppState) -> ServiceStatus {
    let guard = state.server.lock().unwrap();
    match guard.as_ref() {
        Some(h) => ServiceStatus {
            running: true,
            addr: Some(h.addr.to_string()),
        },
        None => ServiceStatus {
            running: false,
            addr: None,
        },
    }
}

/// 启动代理监听(幂等:已运行时直接返回当前地址)
pub async fn start(state: &AppState, app: &AppHandle) -> Result<SocketAddr, String> {
    {
        let guard = state.server.lock().unwrap();
        if let Some(h) = guard.as_ref() {
            return Ok(h.addr);
        }
    }
    let s = state.current_settings();
    let target = parse_listen(&s.listen_addr, s.port)?;
    let handle = super::spawn(state.clone(), target)
        .await
        .map_err(|e| format!("无法监听 {target}(端口可能被占用): {e}"))?;
    let addr = handle.addr;
    *state.server.lock().unwrap() = Some(handle);
    publish_status(state, app);
    Ok(addr)
}

/// 停止代理监听(幂等)
pub async fn stop(state: &AppState, app: &AppHandle) -> Result<(), String> {
    let old = state.server.lock().unwrap().take();
    if let Some(h) = old {
        h.stop().await;
    }
    publish_status(state, app);
    Ok(())
}

/// 应用新的监听地址:运行中 → 平滑重启;未运行 → 仅探测端口可用性。
/// 绑定失败(如端口被占用)时保持原监听不变并返回错误。
pub async fn apply_listen_change(state: &AppState, target: SocketAddr) -> Result<(), String> {
    let running = state.server.lock().unwrap().is_some();
    if running {
        let new_handle = super::spawn(state.clone(), target)
            .await
            .map_err(|e| format!("端口切换失败,{target} 无法监听(可能被占用): {e}"))?;
        let old = state.server.lock().unwrap().replace(new_handle);
        if let Some(old) = old {
            old.stop().await;
        }
    } else {
        super::check_bind(target)
            .await
            .map_err(|e| format!("{target} 当前不可用: {e}"))?;
    }
    Ok(())
}

/// 推送服务状态到前端事件频道,并同步托盘图标/菜单
pub fn publish_status(state: &AppState, app: &AppHandle) {
    let status = status_of(state);
    events::emit(
        app,
        GatewayEvent::ServiceStatus {
            running: status.running,
            addr: status.addr.clone(),
        },
    );
    tray::refresh(app);
}
