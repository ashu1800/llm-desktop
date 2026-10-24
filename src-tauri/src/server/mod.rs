pub mod error;
pub mod manager;

use std::net::SocketAddr;

use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use tauri::async_runtime::JoinHandle;
use tower_http::cors::{Any, CorsLayer};

use crate::proxy;
use crate::state::AppState;

/// axum 监听句柄:drop 前必须调用 stop 以优雅关闭
pub struct ServerHandle {
    pub addr: SocketAddr,
    shutdown_tx: tokio::sync::watch::Sender<bool>,
    join: JoinHandle<()>,
}

impl ServerHandle {
    pub async fn stop(self) {
        // 发送关闭信号;即便发送失败(接收端已退出)也等待任务收尾。
        // 宽限 15s:graceful shutdown 会等全部 in-flight 请求完成,一个挂起的
        // 慢流(或极端情况下失联客户端)不应让停止/端口切换永久卡死 listen_lock
        let _ = self.shutdown_tx.send(true);
        let _ = tokio::time::timeout(std::time::Duration::from_secs(15), self.join).await;
    }
}

async fn healthz() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

async fn fallback_404() -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({
            "error": {
                "message": "not found",
                "type": "gateway_error",
                "code": "not_found"
            }
        })),
    )
}

/// 数据面路由。所有路由容忍并忽略未知 query 参数(如 Claude Code 的 ?beta=true);
/// M4/M5 陆续挂载 /v1/messages、/v1/responses、/v1beta/* 入口。
pub fn build_router(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any)
        .expose_headers(Any);
    Router::new()
        .route("/healthz", get(healthz))
        .route("/v1/chat/completions", post(proxy::chat_completions))
        .route("/v1/messages", post(proxy::messages))
        .route("/v1/messages/count_tokens", post(proxy::messages_count_tokens))
        .route("/v1/models", get(proxy::list_models))
        .route("/v1/responses", post(proxy::responses_entry))
        // 主流客户端均使用流式,不轮询;查询历史响应直接 404(PRD §3.5)
        .route(
            "/v1/responses/{id}",
            get(|| async {
                (
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({
                        "error": {"message": "response not found (stateless gateway)",
                                 "type": "invalid_request_error", "code": "not_found"}
                    })),
                )
            }),
        )
        .route("/v1beta/models", get(proxy::gemini_models))
        .route("/v1beta/models/{model_seg}", post(proxy::gemini_dispatch))
        .fallback(fallback_404)
        .layer(cors)
        // 默认 2MB 会静默拒绝 200K token 级长上下文请求(表现为 413),调大到 100MB
        .layer(axum::extract::DefaultBodyLimit::max(100 * 1024 * 1024))
        .with_state(state)
}

/// 仅探测端口可绑定(探测后立即释放)
pub async fn check_bind(addr: SocketAddr) -> std::io::Result<()> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    drop(listener);
    Ok(())
}

/// 在指定地址启动 axum 监听(不检测是否已在运行,由 manager 负责状态互斥)
pub async fn spawn(state: AppState, addr: SocketAddr) -> std::io::Result<ServerHandle> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let bound = listener.local_addr()?;
    let app = build_router(state);
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);
    let join = tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.changed().await;
            })
            .await;
        log::info!("监听已停止: {bound}");
    });
    log::info!("代理服务开始监听: {bound}");
    Ok(ServerHandle {
        addr: bound,
        shutdown_tx,
        join,
    })
}
