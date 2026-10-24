use serde::Serialize;
use tauri::State;

use crate::state::AppState;
use crate::store::channels::{self, Channel};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestChannelResult {
    pub ok: bool,
    pub latency_ms: i64,
    pub message: String,
}

#[tauri::command]
pub async fn list_channels(state: State<'_, AppState>) -> Result<Vec<Channel>, String> {
    Ok(crate::util::read_ok(&state.channels).clone())
}

#[tauri::command]
pub async fn create_channel(
    state: State<'_, AppState>,
    mut channel: Channel,
) -> Result<Channel, String> {
    channel.id = channels::insert(&state.db, &channel).await?;
    state.reload_channels().await?;
    Ok(channel)
}

#[tauri::command]
pub async fn update_channel(
    state: State<'_, AppState>,
    channel: Channel,
) -> Result<(), String> {
    channels::update(&state.db, &channel).await?;
    state.reload_channels().await?;
    Ok(())
}

#[tauri::command]
pub async fn delete_channel(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    channels::delete(&state.db, id).await?;
    state.reload_channels().await?;
    Ok(())
}

#[tauri::command]
pub async fn set_channel_enabled(
    state: State<'_, AppState>,
    id: i64,
    enabled: bool,
) -> Result<(), String> {
    channels::set_enabled(&state.db, id, enabled).await?;
    state.reload_channels().await?;
    Ok(())
}

/// 连通性测试:拉取模型列表,展示成功/失败与耗时
#[tauri::command]
pub async fn test_channel(state: State<'_, AppState>, id: i64) -> Result<TestChannelResult, String> {
    let ch = state
        .channels
        .read()
        .unwrap()
        .iter()
        .find(|c| c.id == id)
        .cloned()
        .ok_or_else(|| "渠道不存在".to_string())?;
    let Some(key) = ch.api_keys.first().cloned() else {
        return Ok(TestChannelResult {
            ok: false,
            latency_ms: 0,
            message: "渠道未配置 API Key".into(),
        });
    };
    let url = match ch.protocol {
        crate::proto::UpstreamProto::OpenAi | crate::proto::UpstreamProto::Anthropic => {
            crate::util::join_base(&ch.base_url, "/v1/models")
        }
        crate::proto::UpstreamProto::Gemini => {
            crate::util::join_base(&ch.base_url, "/v1beta/models")
        }
    };
    let client = test_client(&state, &ch)?;
    let t = std::time::Instant::now();
    let mut req = client.get(&url);
    match ch.protocol {
        crate::proto::UpstreamProto::OpenAi => req = req.bearer_auth(&key),
        crate::proto::UpstreamProto::Anthropic => {
            req = req
                .header("x-api-key", &key)
                .header("anthropic-version", "2023-06-01");
        }
        crate::proto::UpstreamProto::Gemini => {
            req = req.header("x-goog-api-key", &key);
        }
    }
    match req.send().await {
        Ok(r) => {
            let latency = t.elapsed().as_millis() as i64;
            let status = r.status().as_u16();
            let body = r.text().await.unwrap_or_default();
            if (200..300).contains(&status) {
                let count = count_models(&body, ch.protocol);
                Ok(TestChannelResult {
                    ok: true,
                    latency_ms: latency,
                    message: format!("连接成功({latency}ms),模型 {count} 个"),
                })
            } else {
                Ok(TestChannelResult {
                    ok: false,
                    latency_ms: latency,
                    message: format!("HTTP {status}: {}", crate::util::truncate_utf8(&body, 200)),
                })
            }
        }
        Err(e) => Ok(TestChannelResult {
            ok: false,
            latency_ms: t.elapsed().as_millis() as i64,
            message: format!("请求失败: {e}"),
        }),
    }
}

fn count_models(body: &str, proto: crate::proto::UpstreamProto) -> usize {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else {
        return 0;
    };
    match proto {
        crate::proto::UpstreamProto::Gemini => v["models"].as_array().map(|a| a.len()).unwrap_or(0),
        _ => v["data"].as_array().map(|a| a.len()).unwrap_or(0),
    }
}

fn test_client(state: &State<'_, AppState>, ch: &Channel) -> Result<reqwest::Client, String> {
    let cache_key = format!("{}|test", ch.proxy.clone().unwrap_or_default());
    if let Some(c) = crate::util::lock_ok(&state.http).get(&cache_key) {
        return Ok(c.clone());
    }
    let mut builder = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(15))
        .user_agent(concat!("LLM-Gateway/", env!("CARGO_PKG_VERSION")));
    builder = match ch.proxy.as_deref() {
        None => builder,
        Some("") => builder.no_proxy(),
        Some(url) => builder.proxy(reqwest::Proxy::all(url).map_err(|e| e.to_string())?),
    };
    let c = builder.build().map_err(|e| e.to_string())?;
    crate::util::lock_ok(&state.http).insert(cache_key, c.clone());
    Ok(c)
}
