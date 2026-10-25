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
    /// 首字延迟(从发请求到收到响应首个字节)
    pub ttft_ms: Option<i64>,
    /// 模型返回的文本内容
    pub reply: Option<String>,
    /// 实际使用的模型名
    pub model: Option<String>,
    /// 输出 token 数(usage 可得时)
    pub completion_tokens: Option<i64>,
}

impl TestChannelResult {
    /// 失败结果:仅状态/耗时/消息,其余字段空(结构体默认语义,减少重复 None)
    fn fail(latency_ms: i64, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            latency_ms,
            message: message.into(),
            ttft_ms: None,
            reply: None,
            model: None,
            completion_tokens: None,
        }
    }
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

/// 连通性测试:向渠道发一条真实对话("hi" 或自定义内容),非流式。
/// 返回首字延迟、总耗时、模型回复与 token 用量——比拉模型列表更能反映真实可用性
#[tauri::command]
pub async fn test_channel(
    state: State<'_, AppState>,
    id: i64,
    // 测试内容;空 = 默认 "hi"
    prompt: Option<String>,
    // 测试模型;空 = 渠道模型列表第一个,再退 "gpt-4o-mini"(仅作请求字段,渠道侧实际路由)
    model: Option<String>,
) -> Result<TestChannelResult, String> {
    let ch = state
        .channels
        .read()
        .unwrap()
        .iter()
        .find(|c| c.id == id)
        .cloned()
        .ok_or_else(|| "渠道不存在".to_string())?;
    let Some(key) = ch.api_keys.first().cloned() else {
        return Ok(TestChannelResult::fail(0, "渠道未配置 API Key"));
    };
    let content = prompt
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "hi".to_string());
    // 对外名:用户测试时选的/渠道白名单首个。发上游前必须过映射——
    // 否则配了「对外名 → 上游名」的渠道会拿对外名去打上游,必然 404,
    // 而真实数据面请求是通的,测试结果会误导用户以为渠道坏了
    let model_in = model
        .filter(|s| !s.trim().is_empty())
        .or_else(|| ch.models.first().cloned())
        .unwrap_or_else(|| "gpt-4o-mini".to_string());
    let model_name = ch
        .model_map
        .get(&model_in)
        .cloned()
        .unwrap_or_else(|| model_in.clone());

    // 按协议构造非流式对话请求(非流式解析简单,兼容性最好)
    let (url, body) = match ch.protocol {
        crate::proto::UpstreamProto::OpenAi => (
            crate::util::join_base(&ch.base_url, "/v1/chat/completions"),
            serde_json::json!({
                "model": model_name,
                "messages": [{"role": "user", "content": content}],
                "max_tokens": 100,
                "stream": false,
            }),
        ),
        crate::proto::UpstreamProto::Anthropic => (
            crate::util::join_base(&ch.base_url, "/v1/messages"),
            serde_json::json!({
                "model": model_name,
                "messages": [{"role": "user", "content": content}],
                "max_tokens": 100,
                "stream": false,
            }),
        ),
        crate::proto::UpstreamProto::Gemini => (
            crate::util::join_base(
                &ch.base_url,
                &format!("/v1beta/models/{model_name}:generateContent"),
            ),
            serde_json::json!({
                "contents": [{"role": "user", "parts": [{"text": content}]}],
                "generationConfig": {"maxOutputTokens": 100},
            }),
        ),
    };

    let client = test_client(&state, &ch)?;
    let mut req = client.post(&url).json(&body);
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

    let t = std::time::Instant::now();
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            return Ok(TestChannelResult::fail(
                t.elapsed().as_millis() as i64,
                format!("请求失败: {e}"),
            ));
        }
    };
    // 首字:响应头到达即计(非流式对话的首包近似;流式 TTFT 语义见请求日志)
    let ttft = t.elapsed().as_millis() as i64;
    let status = resp.status().as_u16();
    let resp_body = resp.text().await.unwrap_or_default();
    let total = t.elapsed().as_millis() as i64;

    if !(200..300).contains(&status) {
        return Ok(TestChannelResult {
            ok: false,
            latency_ms: total,
            message: format!("HTTP {status}: {}", crate::util::truncate_utf8(&resp_body, 200)),
            ttft_ms: Some(ttft),
            reply: None,
            model: Some(model_in),
            completion_tokens: None,
        });
    }

    // 按协议解析回复文本与 usage;解析失败但 HTTP 200 也算通(展示原文片段)
    let v: serde_json::Value = serde_json::from_str(&resp_body)
        .unwrap_or_else(|_| serde_json::Value::String(resp_body.clone()));
    let (reply, completion_tokens) = match ch.protocol {
        crate::proto::UpstreamProto::OpenAi => (
            v["choices"][0]["message"]["content"]
                .as_str()
                .map(str::to_string),
            v["usage"]["completion_tokens"].as_i64(),
        ),
        crate::proto::UpstreamProto::Anthropic => (
            // content 是块数组,拼接 text 块
            v["content"]
                .as_array()
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter_map(|b| b["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("")
                })
                .filter(|s| !s.is_empty()),
            v["usage"]["output_tokens"].as_i64(),
        ),
        crate::proto::UpstreamProto::Gemini => (
            v["candidates"][0]["content"]["parts"]
                .as_array()
                .map(|parts| {
                    parts
                        .iter()
                        .filter_map(|p| p["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("")
                })
                .filter(|s| !s.is_empty()),
            v["usageMetadata"]["candidatesTokenCount"].as_i64(),
        ),
    };
    let reply = reply.or_else(|| {
        Some(crate::util::truncate_utf8(&resp_body, 300)).filter(|s| !s.is_empty())
    });

    Ok(TestChannelResult {
        ok: true,
        latency_ms: total,
        message: format!("对话测试成功({total}ms)"),
        ttft_ms: Some(ttft),
        reply,
        // 回显对外名(用户选的):上游回包里的 model 是映射后的名字,
        // 展示它会让用户困惑"我测的不是这个模型"
        model: Some(model_in),
        completion_tokens,
    })
}

/// 解析渠道/命令的代理配置为实际代理 URL。
///
/// 三态语义(与数据面 http_client 一致,靠 Option 的两层区分):
/// - `None`   = 跟随系统代理
/// - `Some("")` = 强制直连(no_proxy)
/// - `Some(url)` = 用该 URL
///
/// `proxy:<name>` 形式引用设置页「代理管理」里的命名代理,发请求时才解析成 URL
/// (改名/改地址即时生效,不必改渠道)。引用不到时回退 None(跟随系统),
/// 而不是当作直连——那样用户以为在用代理、实际裸连,更危险。
fn resolve_channel_proxy(state: &AppState, proxy: Option<&str>) -> Option<String> {
    match proxy {
        Some(p) if p.starts_with("proxy:") => {
            let name = &p[6..];
            state
                .current_settings()
                .proxies
                .iter()
                .find(|e| e.name == name)
                .map(|e| e.url.clone())
        }
        other => other.map(str::to_string),
    }
}

/// 拉取上游支持的模型列表(渠道编辑"获取模型"按钮)。
/// 三协议:openai GET /v1/models;anthropic GET /v1/models(x-api-key);
/// gemini GET /v1beta/models(x-goog-api-key)。返回排序去重的模型 id
#[tauri::command]
pub async fn fetch_upstream_models(
    state: State<'_, AppState>,
    base_url: String,
    protocol: crate::proto::UpstreamProto,
    api_key: String,
    proxy: Option<String>,
) -> Result<Vec<String>, String> {
    let base = base_url.trim();
    if base.is_empty() {
        return Err("请先填写 Base URL".into());
    }
    if api_key.trim().is_empty() {
        return Err("请先填写至少一个 API Key".into());
    }
    let url = match protocol {
        crate::proto::UpstreamProto::OpenAi | crate::proto::UpstreamProto::Anthropic => {
            crate::util::join_base(base, "/v1/models")
        }
        crate::proto::UpstreamProto::Gemini => crate::util::join_base(base, "/v1beta/models"),
    };
    let resolved = resolve_channel_proxy(&state, proxy.as_deref());
    let mut builder = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(15))
        .user_agent(concat!("LLM-Gateway/", env!("CARGO_PKG_VERSION")));
    builder = match resolved.as_deref() {
        None => builder,
        Some("") => builder.no_proxy(),
        Some(url) => builder.proxy(reqwest::Proxy::all(url).map_err(|e| e.to_string())?),
    };
    let client = builder.build().map_err(|e| e.to_string())?;

    let mut req = client.get(&url);
    match protocol {
        crate::proto::UpstreamProto::OpenAi => req = req.bearer_auth(api_key.trim()),
        crate::proto::UpstreamProto::Anthropic => {
            req = req
                .header("x-api-key", api_key.trim())
                .header("anthropic-version", "2023-06-01");
        }
        crate::proto::UpstreamProto::Gemini => {
            req = req.header("x-goog-api-key", api_key.trim());
        }
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(format!(
            "HTTP {status}: {}",
            crate::util::truncate_utf8(&body, 200)
        ));
    }
    let v: serde_json::Value = serde_json::from_str(&body)
        .map_err(|_| "响应不是合法 JSON".to_string())?;
    // openai/anthropic:{data:[{id}]};gemini:{models:[{name:"models/<id>"}]}
    let mut models: Vec<String> = match protocol {
        crate::proto::UpstreamProto::Gemini => v["models"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|m| m["name"].as_str())
                    .filter_map(|n| n.rsplit('/').next())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        _ => v["data"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|m| m["id"].as_str())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
    };
    if models.is_empty() {
        return Err("上游返回空模型列表".into());
    }
    models.sort();
    models.dedup();
    Ok(models)
}

fn test_client(state: &State<'_, AppState>, ch: &Channel) -> Result<reqwest::Client, String> {
    // 与数据面 http_client 同规则:命名代理引用在发请求时解析
    let resolved = resolve_channel_proxy(state, ch.proxy.as_deref());
    // 哨兵区分 None(跟随系统)与 Some("")(直连),与 http_client 同规则
    let cache_key = format!(
        "{}|test",
        match resolved.as_deref() {
            None => "\u{0}system",
            Some("") => "\u{0}direct",
            Some(url) => url,
        }
    );
    if let Some(c) = crate::util::lock_ok(&state.http).get(&cache_key) {
        return Ok(c.clone());
    }
    let mut builder = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(15))
        .user_agent(concat!("LLM-Gateway/", env!("CARGO_PKG_VERSION")));
    builder = match resolved.as_deref() {
        None => builder,
        Some("") => builder.no_proxy(),
        Some(url) => builder.proxy(reqwest::Proxy::all(url).map_err(|e| e.to_string())?),
    };
    let c = builder.build().map_err(|e| e.to_string())?;
    crate::util::lock_ok(&state.http).insert(cache_key, c.clone());
    Ok(c)
}
