//! 代理管理命令:测延迟。代理池本体存 settings.proxies,
//! 渠道按 url 引用、更新器按名字引用,此处只做连通性/延迟探测。

use std::time::{Duration, Instant};

use tauri::State;

use crate::state::AppState;

/// 单次探测上限:超过即视为不可用,不无限等
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// 经指定代理请求 GitHub(HEAD,小响应)测延迟;失败返回 Err(错误文本)。
/// 代理 url 需带 scheme:socks5://host:port 或 http(s)://host:port
#[tauri::command]
pub async fn test_proxy_latency(url: String) -> Result<u64, String> {
    let url_checked = if url.starts_with("socks5://")
        || url.starts_with("http://")
        || url.starts_with("https://")
    {
        url
    } else {
        return Err("代理地址需以 socks5:// 或 http(s):// 开头".into());
    };
    // 探测客户端独立构建,不缓存:代理可能刚改,且测延迟非热路径
    let builder = reqwest::Client::builder()
        .connect_timeout(PROBE_TIMEOUT)
        .timeout(PROBE_TIMEOUT);
    let builder = builder.proxy(
        reqwest::Proxy::all(&url_checked).map_err(|e| format!("代理地址无效: {e}"))?,
    );
    let client = builder
        .build()
        .map_err(|e| format!("构建客户端失败: {e}"))?;

    let start = Instant::now();
    let resp = client
        .head("https://api.github.com")
        .header("user-agent", "llm-gateway-probe")
        .send()
        .await
        .map_err(|e| format!("连接失败: {e}"))?;
    let elapsed = start.elapsed().as_millis() as u64;
    // 非 2xx/3xx 也算通(能拿到响应 = 链路通)
    let _ = resp.status();
    Ok(elapsed)
}

/// 按设置里的 updater_proxy 名返回实际代理 url;空/不存在返回 None(直连)。
/// 供前端更新器调用前查询,避免前端解析 settings
#[tauri::command]
pub async fn get_updater_proxy(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let settings = state.current_settings();
    if settings.updater_proxy.is_empty() {
        return Ok(None);
    }
    Ok(settings
        .proxies
        .iter()
        .find(|p| p.name == settings.updater_proxy)
        .map(|p| p.url.clone()))
}
