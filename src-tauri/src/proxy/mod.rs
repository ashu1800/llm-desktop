//! 代理请求主流程:认证 → 解析入口协议 → IR → 渠道选择(含熔断)→ 协议转换 → 上游请求 → 流式互转回写 → 计量入日志。
//! 四入口(chat/completions、responses、messages、gemini)× 三上游(openai/anthropic/gemini)经 IR 互转;
//! 同协议走原始字节直通优化(不做无谓序列化)。

pub mod auth;
pub mod relay;

use std::collections::HashMap;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};
use tokio_stream::StreamExt;

use crate::billing::{self, Usage};
use crate::breaker::{self, BreakerParams};
use crate::proto::{EntryProto, UpstreamProto};
use crate::server::error::GatewayError;
use crate::state::AppState;
use crate::store::api_keys;
use crate::store::channels::Channel;
use crate::store::logs::RequestLog;
use crate::transform::{
    anthropic, gemini, ir::CanonicalRequest, openai_chat, responses,
};
use crate::transform::ir::{Block, Message, Role};
use crate::util;

use relay::StreamOutcome;

// ---------------------------------------------------------------------------
// 入口路由
// ---------------------------------------------------------------------------

pub async fn chat_completions(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    gateway(state, EntryProto::OpenAi, q, headers, body).await
}

pub async fn messages(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    gateway(state, EntryProto::Anthropic, q, headers, body).await
}

/// count_tokens:本地估算返回,不转发上游
pub async fn messages_count_tokens(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let entry = EntryProto::Anthropic;
    let key = match auth::authenticate(&state, &headers, q.get("key").map(String::as_str)) {
        Ok(k) => k,
        Err(e) => return e.render(entry),
    };
    let _ = key;
    let raw: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return GatewayError::bad_request(format!("请求体不是合法 JSON: {e}")).render(entry),
    };
    let ir = match anthropic::parse_request(&raw) {
        Ok(ir) => ir,
        Err(e) => return GatewayError::bad_request(e).render(entry),
    };
    let tokens = billing::pricing::estimate_tokens(&ir.collect_text());
    (StatusCode::OK, axum::Json(json!({ "input_tokens": tokens }))).into_response()
}

/// M5:Responses / Gemini 入口在此接入
pub async fn responses_entry(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    gateway(state, EntryProto::Responses, q, headers, body).await
}

pub async fn gemini_generate(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    gateway(state, EntryProto::Gemini, q, headers, body).await
}

/// Gemini 入口 URL 中的模型名:{model}:generateContent / :streamGenerateContent
pub async fn gemini_dispatch(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    axum::extract::Path(model_seg): axum::extract::Path<String>,
    body: Bytes,
) -> Response {
    let (model, action) = match model_seg.rsplit_once(':') {
        Some((m, a)) => (m.to_string(), a.to_string()),
        None => (model_seg.clone(), String::new()),
    };
    // :countTokens 本地估算返回,不转发
    if action == "countTokens" {
        let key = match auth::authenticate(&state, &headers, q.get("key").map(String::as_str)) {
            Ok(k) => k,
            Err(e) => return e.render(EntryProto::Gemini),
        };
        let _ = key;
        let Ok(raw) = serde_json::from_slice::<Value>(&body) else {
            return GatewayError::bad_request("请求体不是合法 JSON")
                .render(EntryProto::Gemini);
        };
        let n = gemini::parse_request(&raw, Some(&model))
            .map(|ir| crate::billing::pricing::estimate_tokens(&ir.collect_text()))
            .unwrap_or(0);
        return (
            StatusCode::OK,
            axum::Json(json!({"totalTokens": n, "usage": {"totalTokens": n}})),
        )
            .into_response();
    }
    let stream = action == "streamGenerateContent";
    gateway_inner(state, EntryProto::Gemini, q, headers, body, Some((model, stream))).await
}

/// GET /v1beta/models:Gemini 列表格式,按该密钥可用渠道聚合去重
pub async fn gemini_models(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let key = match auth::authenticate(&state, &headers, q.get("key").map(String::as_str)) {
        Ok(k) => k,
        Err(e) => return e.render(EntryProto::Gemini),
    };
    let all = state.channels.read().unwrap().clone();
    let mut models: Vec<String> = Vec::new();
    for cid in &key.channels {
        if let Some(ch) = all.iter().find(|c| &c.id == cid) {
            if ch.enabled && !ch.models.is_empty() {
                for m in &ch.models {
                    if !models.contains(m) {
                        models.push(m.clone());
                    }
                }
            }
        }
    }
    models.sort();
    (StatusCode::OK, axum::Json(list_models_gemini_body(&models))).into_response()
}

async fn gateway(
    state: AppState,
    entry: EntryProto,
    q: HashMap<String, String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    gateway_inner(state, entry, q, headers, body, None).await
}

/// Responses 入口解析 + previous_response_id 进程内 LRU 拼接;
/// 未命中(网关重启/超出容量)返回 400 并提示携带完整 input 重试(PRD 决策 14)
fn parse_responses(state: &AppState, raw_body: &Value) -> Result<CanonicalRequest, String> {
    let (mut ir, prev) = responses::parse_request(raw_body)?;
    if let Some(pid) = prev {
        let Some(stored) = state.resp_store.get(&pid) else {
            return Err(
                "previous_response_id 未命中(网关重启或超出缓存),请携带完整 input 重试"
                    .to_string(),
            );
        };
        let mut msgs = stored.context;
        if !stored.output_blocks.is_empty() {
            msgs.push(Message {
                role: Role::Assistant,
                blocks: stored.output_blocks,
            });
        }
        msgs.extend(ir.messages);
        ir.messages = msgs;
    }
    Ok(ir)
}

async fn gateway_inner(
    state: AppState,
    entry: EntryProto,
    q: HashMap<String, String>,
    headers: HeaderMap,
    body: Bytes,
    gemini_inline: Option<(String, bool)>,
) -> Response {
    let started = Instant::now();

    let key = match auth::authenticate(&state, &headers, q.get("key").map(String::as_str)) {
        Ok(k) => k,
        Err(e) => return e.render(entry),
    };
    spawn_touch_key(&state, key.id);
    let client_ua = headers
        .get("user-agent")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();

    let raw_body: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return GatewayError::bad_request(format!("请求体不是合法 JSON: {e}")).render(entry),
    };

    // 入口解析 → IR
    let parse_result: Result<CanonicalRequest, String> = match entry {
        EntryProto::OpenAi => openai_chat::parse_request(&raw_body),
        EntryProto::Anthropic => anthropic::parse_request(&raw_body),
        EntryProto::Responses => parse_responses(&state, &raw_body),
        EntryProto::Gemini => {
            // Gemini 入口:模型名在 URL 路径中;请求体不含 model 字段
            gemini::parse_request(&raw_body, gemini_inline.as_ref().map(|(m, _)| m.as_str()))
        }
    };
    let mut ir = match parse_result {
        Ok(ir) => ir,
        Err(e) => return GatewayError::bad_request(e).render(entry),
    };
    if let Some((model, stream)) = &gemini_inline {
        ir.model = model.clone();
        ir.stream |= *stream;
    }
    let tag = ir.effort_str().map(str::to_string);
    let is_stream = ir.stream;
    let model_in = ir.model.clone();
    let req_snapshot = snapshot(&state, &raw_body);
    // Responses 入口:统一生成 response id(非流式回包、流式事件、LRU 存储共用)
    let resp_id = if entry == EntryProto::Responses {
        Some(format!("resp_gw{}", util::rand_hex(24)))
    } else {
        None
    };
    // Responses 响应完成后写入 LRU(供后续 previous_response_id 引用)
    let completion = resp_id
        .as_ref()
        .map(|id| (id.clone(), ir.messages.clone()));

    let all_channels = state.channels.read().unwrap().clone();
    let mut attempts: Vec<Value> = Vec::new();
    let mut last_error = String::from("无可用渠道");

    for ch in key
        .channels
        .iter()
        .filter_map(|id| all_channels.iter().find(|c| &c.id == id))
    {
        if !ch.enabled {
            continue;
        }
        // 熔断跳过;HalfOpen 时放行 1 个探测请求
        let bparams = effective_breaker_params(&state, ch);
        if !state.breakers.allow(ch.id, &bparams) {
            continue;
        }
        let mapped = mapped_model(ch, &model_in);
        if !channel_supports(ch, &mapped) {
            continue;
        }
        let timeouts = effective_timeouts(&state, ch);
        let mut retry_after: Option<Duration> = None;

        let mut allow_inject = true;
        let keys_order = rotate_keys(&state, ch);
        if keys_order.is_empty() {
            attempts.push(attempt_json(ch, 0, 0, "渠道未配置上游密钥"));
            last_error = format!("渠道 {} 未配置上游密钥", ch.name);
            continue;
        }
        let mut key_pos = 0;
        let mut channel_failed = false;

        while key_pos < keys_order.len() {
            let up_key = &keys_order[key_pos];
            let prep = match prepare_upstream(entry, ch, &ir, &raw_body, is_stream, allow_inject) {
                Ok(p) => p,
                Err(e) => {
                    attempts.push(attempt_json(ch, 0, 0, &e));
                    last_error = e;
                    channel_failed = true;
                    break;
                }
            };
            let last_dropped = prep.dropped.clone();
            let t_try = Instant::now();            let send_res = send_upstream(&state, ch, &prep, up_key, &headers).await;
            let resp = match send_res {
                Ok(r) => r,
                Err(e) => {
                    attempts.push(attempt_json(ch, 0, t_try.elapsed().as_millis() as i64, &e));
                    last_error = e;
                    channel_failed = true;
                    break;
                }
            };
            let status = resp.status().as_u16();

            if status == 200 {
                if is_stream {
                    match start_stream(
                        &state, resp, ch, &ir, entry, started, t_try, &key, tag.clone(), &model_in,
                        &mapped, &client_ua, &mut attempts, req_snapshot.clone(),
                        last_dropped.clone(), resp_id.clone(), completion.clone(),
                    )
                    .await
                    {
                        Ok(response) => return response,
                        Err(f) => {
                            attempts.push(attempt_json(ch, 200, f.elapsed_ms, &f.reason));
                            last_error = f.reason;
                            // 未写回任何字节,切下一渠道;上游故障(TTFT 超时/空流)计入熔断
                            channel_failed = true;
                            break;
                        }
                    }
                }
                match handle_non_stream(
                    &state, resp, ch, &ir, entry, started, &key, tag.clone(), &model_in,
                    &mapped, &client_ua, &mut attempts, req_snapshot.clone(),
                    timeouts.non_stream_total, last_dropped.clone(), resp_id.clone(),
                    completion.clone(),
                )
                .await
                {
                    Ok(response) => return response,
                    Err(f) => {
                        attempts.push(attempt_json(
                            ch,
                            f.status.unwrap_or(200),
                            f.elapsed_ms,
                            &f.reason,
                        ));
                        last_error = f.reason;
                        // 上游故障(总时长超时/非法 JSON/error body)计入熔断
                        channel_failed = true;
                        break;
                    }
                }
            }

            // 非 200:先读头(429 Retry-After)再消费错误体
            let retry_after_hdr = if status == 429 {
                resp.headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(parse_retry_after)
            } else {
                None
            };
            if retry_after_hdr.is_some() {
                retry_after = retry_after_hdr;
            }
            let up_content_type = resp
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/json")
                .to_string();
            let err_body = match tokio::time::timeout(Duration::from_secs(5), resp.text()).await {
                Ok(Ok(s)) => s,
                _ => String::new(),
            };
            if status == 400 && prep.injected_stream_options && err_body.contains("stream_options")
            {
                // 上游不认识 stream_options:同 key 去掉该字段重发一次
                attempts.push(attempt_json(ch, status, t_try.elapsed().as_millis() as i64, "上游拒绝 stream_options,降级重试"));
                allow_inject = false;
                continue;
            }
            if status == 401 || status == 403 || status == 429 {
                attempts.push(attempt_json(
                    ch,
                    status,
                    t_try.elapsed().as_millis() as i64,
                    &err_body_excerpt(&err_body),
                ));
                last_error = format!("HTTP {status}: {}", err_body_excerpt(&err_body));
                if key_pos + 1 < keys_order.len() {
                    key_pos += 1;
                    continue; // 渠道内轮换密钥重试
                }
                channel_failed = true;
                break;
            }
            if status >= 500 {
                attempts.push(attempt_json(
                    ch,
                    status,
                    t_try.elapsed().as_millis() as i64,
                    &err_body_excerpt(&err_body),
                ));
                last_error = format!("HTTP {status}: {}", err_body_excerpt(&err_body));
                channel_failed = true;
                break;
            }
            // 其他 4xx:客户端问题,按原始错误体透传(状态码原样;非渠道故障,不 failover)
            finalize_log(FinalizeInput {
                state: &state,
                key: Some(&key),
                channel: Some(ch),
                model_in: &model_in,
                mapped: Some(&mapped),
                tag: tag.clone(),
                protocol_in: entry,
                protocol_up: Some(ch.protocol),
                status: status as i64,
                is_stream,
                attempts: attempts.clone(),
                error: None,
                usage: Usage::default(),
                estimated: false,
                ttft_ms: None,
                started,
                client: &client_ua,
                req_snapshot,
                resp_snapshot: Some(truncate_snapshot(&state, &err_body)),
            });
            let mut r = passthrough_error_response(status, &err_body, &up_content_type);
            add_gw_headers(&mut r, &ch.name, attempts.len());
            return r;
        }
        if channel_failed {
            // 熔断器记账(429 时参考 Retry-After 调整冷却)
            if let Some(tr) = state.breakers.record_failure(ch.id, &bparams, retry_after) {
                emit_breaker(&state, ch.id, tr);
            }
            continue;
        }
    }

    // 全部渠道失败
    let summary = if attempts.is_empty() {
        "该密钥没有匹配此模型的可用渠道".to_string()
    } else {
        format!("所有渠道均失败: {last_error}")
    };
    finalize_log(FinalizeInput {
        state: &state,
        key: Some(&key),
        channel: None,
        model_in: &model_in,
        mapped: None,
        tag,
        protocol_in: entry,
        protocol_up: None,
        status: 503,
        is_stream,
        attempts: attempts.clone(),
        error: Some(last_error.clone()),
        usage: Usage::default(),
        estimated: false,
        ttft_ms: None,
        started,
        client: &client_ua,
        req_snapshot,
        resp_snapshot: None,
    });
    GatewayError::service_unavailable(summary).render(entry)
}

// ---------------------------------------------------------------------------
// 上游请求构建
// ---------------------------------------------------------------------------

struct Prepared {
    url: String,
    body: Bytes,
    injected_stream_options: bool,
    /// anthropic 上游附加头(anthropic-version)
    extra_headers: Vec<(String, String)>,
    dropped: Vec<String>,
}

/// 同协议直通判定(原始字节透传;不做无谓序列化)
fn is_passthrough(entry: EntryProto, upstream: UpstreamProto) -> bool {
    matches!(
        (entry, upstream),
        (EntryProto::OpenAi, UpstreamProto::OpenAi)
            | (EntryProto::Anthropic, UpstreamProto::Anthropic)
            | (EntryProto::Gemini, UpstreamProto::Gemini)
    )
}

fn prepare_upstream(
    entry: EntryProto,
    ch: &Channel,
    ir: &CanonicalRequest,
    raw_body: &Value,
    is_stream: bool,
    allow_inject: bool,
) -> Result<Prepared, String> {
    let mapped = mapped_model(ch, &ir.model);
    let extra_headers: Vec<(String, String)> = if ch.protocol == UpstreamProto::Anthropic {
        vec![("anthropic-version".to_string(), "2023-06-01".to_string())]
    } else {
        Vec::new()
    };
    let mut dropped = ir.dropped_fields.clone();

    if is_passthrough(entry, ch.protocol) {
        // 直通:原始字节仅改写模型名(映射命中时);openai 流式注入 stream_options 拿 usage
        let mut obj = raw_body.clone();
        if obj.get("model").is_some() {
            obj["model"] = json!(mapped);
        }
        let mut injected = false;
        if ch.protocol == UpstreamProto::OpenAi
            && is_stream
            && allow_inject
            && obj.get("stream_options").is_none()
        {
            obj["stream_options"] = json!({"include_usage": true});
            injected = true;
        }
        let bytes = serde_json::to_vec(&obj).map_err(|e| format!("序列化上游请求失败: {e}"))?;
        let url = upstream_url(ch, &mapped, is_stream)?;
        return Ok(Prepared {
            url,
            body: bytes.into(),
            injected_stream_options: injected,
            extra_headers,
            dropped,
        });
    }

    // 跨协议:IR → 上游 JSON(协议适配器负责 cache_control 等字段的保留/丢弃)
    let (body_json, render_dropped) = match ch.protocol {
        UpstreamProto::OpenAi => openai_chat::render_request(ir),
        UpstreamProto::Anthropic => anthropic::render_request(ir),
        UpstreamProto::Gemini => gemini::render_request(ir),
    };
    for d in render_dropped {
        if !dropped.contains(&d) {
            dropped.push(d);
        }
    }
    let bytes = serde_json::to_vec(&body_json).map_err(|e| format!("序列化上游请求失败: {e}"))?;
    let url = upstream_url(ch, &mapped, is_stream)?;
    Ok(Prepared {
        url,
        body: bytes.into(),
        injected_stream_options: false,
        extra_headers,
        dropped,
    })
}

/// 上游 URL:openai /v1/chat/completions;anthropic /v1/messages;
/// gemini 模型名拼在路径(流式 :streamGenerateContent?alt=sse)
fn upstream_url(ch: &Channel, mapped: &str, is_stream: bool) -> Result<String, String> {
    match ch.protocol {
        UpstreamProto::OpenAi => Ok(util::join_base(&ch.base_url, "/v1/chat/completions")),
        UpstreamProto::Anthropic => Ok(util::join_base(&ch.base_url, "/v1/messages")),
        UpstreamProto::Gemini => {
            let action = if is_stream {
                "streamGenerateContent?alt=sse"
            } else {
                "generateContent"
            };
            Ok(format!(
                "{}/v1beta/models/{}:{action}",
                ch.base_url.trim_end_matches('/'),
                mapped
            ))
        }
    }
}

async fn send_upstream(
    state: &AppState,
    ch: &Channel,
    prep: &Prepared,
    key: &str,
    entry_headers: &HeaderMap,
) -> Result<reqwest::Response, String> {
    let timeouts = effective_timeouts(state, ch);
    let client = http_client(state, &ch.proxy, timeouts.connect.as_secs())?;
    let mut req = client.post(&prep.url).header("content-type", "application/json");
    match ch.protocol {
        UpstreamProto::OpenAi => req = req.bearer_auth(key),
        UpstreamProto::Anthropic => {
            req = req.header("x-api-key", key);
            // anthropic 入口 → anthropic 上游:透传 anthropic-beta(缓存统计的必要头)
            if let Some(v) = entry_headers.get("anthropic-beta").and_then(|v| v.to_str().ok()) {
                req = req.header("anthropic-beta", v);
            }
            for (k, v) in &prep.extra_headers {
                req = req.header(k.as_str(), v.as_str());
            }
        }
        UpstreamProto::Gemini => {
            req = req.header("x-goog-api-key", key);
        }
    }
    let resp = req
        .body(prep.body.clone())
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "上游请求超时".to_string()
            } else if e.is_connect() {
                format!("上游连接失败: {e}")
            } else {
                format!("上游请求失败: {e}")
            }
        })?;
    Ok(resp)
}

/// HTTP 客户端按 (代理配置, 连接超时) 缓存复用连接池
fn http_client(
    state: &AppState,
    proxy: &Option<String>,
    connect_secs: u64,
) -> Result<reqwest::Client, String> {
    let cache_key = format!("{}|{connect_secs}", proxy.clone().unwrap_or_default());
    if let Some(c) = state.http.lock().unwrap().get(&cache_key) {
        return Ok(c.clone());
    }
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(connect_secs))
        .user_agent(concat!("LLM-Gateway/", env!("CARGO_PKG_VERSION")));
    builder = match proxy.as_deref() {
        None => builder, // 默认:跟随系统代理(reqwest 自动读取环境变量)
        Some("") => builder.no_proxy(),
        Some(url) => builder.proxy(
            reqwest::Proxy::all(url).map_err(|e| format!("代理配置无效: {e}"))?,
        ),
    };
    let client = builder.build().map_err(|e| format!("构建 HTTP 客户端失败: {e}"))?;
    state
        .http
        .lock()
        .unwrap()
        .insert(cache_key, client.clone());
    Ok(client)
}

// ---------------------------------------------------------------------------
// 非流式处理
// ---------------------------------------------------------------------------

struct FailReason {
    reason: String,
    status: Option<u16>,
    elapsed_ms: i64,
}

fn fail(reason: String, status: Option<u16>, started_try: Instant) -> FailReason {
    FailReason {
        reason,
        status,
        elapsed_ms: started_try.elapsed().as_millis() as i64,
    }
}

enum UpstreamParsed {
    Ok {
        blocks: Vec<crate::transform::ir::Block>,
        stop: Option<crate::transform::ir::StopReason>,
        usage: Usage,
    },
    Err(String),
}

fn parse_upstream_response(proto: UpstreamProto, v: &Value) -> Result<UpstreamParsed, String> {
    match proto {
        UpstreamProto::OpenAi => match openai_chat::parse_response_json(v)? {
            openai_chat::UpstreamBody::Err(m) => Ok(UpstreamParsed::Err(m)),
            openai_chat::UpstreamBody::Ok(p) => Ok(UpstreamParsed::Ok {
                blocks: p.blocks,
                stop: p.stop,
                usage: p.usage,
            }),
        },
        UpstreamProto::Anthropic => match anthropic::parse_response_json(v)? {
            anthropic::UpstreamBody::Err(m) => Ok(UpstreamParsed::Err(m)),
            anthropic::UpstreamBody::Ok(p) => Ok(UpstreamParsed::Ok {
                blocks: p.blocks,
                stop: p.stop,
                usage: p.usage,
            }),
        },
        UpstreamProto::Gemini => match gemini::parse_response_json(v)? {
            Err(m) => Ok(UpstreamParsed::Err(m)),
            Ok((blocks, stop, usage)) => Ok(UpstreamParsed::Ok { blocks, stop, usage }),
        },
    }
}

fn render_entry_response(
    entry: EntryProto,
    model: &str,
    blocks: &[Block],
    stop: Option<crate::transform::ir::StopReason>,
    usage: &Usage,
    resp_id: Option<&str>,
) -> Value {
    match entry {
        EntryProto::OpenAi => openai_chat::render_response_json(model, blocks, stop, usage),
        EntryProto::Responses => responses::render_response_json(
            resp_id.unwrap_or("resp_gw_unknown"),
            model,
            blocks,
            usage,
        ),
        EntryProto::Anthropic => anthropic::render_response_json(model, blocks, stop, usage),
        EntryProto::Gemini => {
            let mut parts: Vec<Value> = Vec::new();
            for b in blocks {
                match b {
                    crate::transform::ir::Block::Text { text, .. } => {
                        parts.push(json!({"text": text}));
                    }
                    crate::transform::ir::Block::ToolUse { name, input, .. } => {
                        parts.push(json!({"functionCall": {"name": name, "args": input}}));
                    }
                    _ => {}
                }
            }
            let mut body = json!({
                "candidates": [{
                    "content": {"role": "model", "parts": parts},
                    "finishReason": stop.map(gemini::render_finish),
                }],
            });
            body["usageMetadata"] = json!({
                "promptTokenCount": usage.prompt,
                "candidatesTokenCount": usage.completion,
                "cachedContentTokenCount": usage.cache_read,
            });
            body
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_non_stream(
    state: &AppState,
    resp: reqwest::Response,
    ch: &Channel,
    ir: &CanonicalRequest,
    entry: EntryProto,
    started: Instant,
    key: &auth::AuthedKey,
    tag: Option<String>,
    model_in: &str,
    mapped: &str,
    client_ua: &str,
    attempts: &mut Vec<Value>,
    req_snapshot: Option<String>,
    total_timeout: Duration,
    dropped: Vec<String>,
    resp_id: Option<String>,
    completion: Option<(String, Vec<Message>)>,
) -> Result<Response, FailReason> {
    let t = Instant::now();
    let bytes = tokio::time::timeout(total_timeout, resp.bytes())
        .await
        .map_err(|_| fail("非流式总时长超时".into(), Some(200), t))?
        .map_err(|e| fail(format!("读取响应失败: {e}"), Some(200), t))?;

    let v: Value = serde_json::from_slice(&bytes)
        .map_err(|e| fail(format!("响应不是合法 JSON: {e}"), Some(200), t))?;
    let parsed = match parse_upstream_response(ch.protocol, &v) {
        Err(e) => return Err(fail(format!("响应结构异常: {e}"), Some(200), t)),
        Ok(UpstreamParsed::Err(msg)) => {
            // 200 但 body 为 error 对象:视为渠道故障,可 failover
            return Err(fail(format!("上游错误: {msg}"), Some(200), t));
        }
        Ok(UpstreamParsed::Ok {
            blocks,
            stop,
            usage,
        }) => (blocks, stop, usage),
    };
    let (blocks, stop, mut usage) = parsed;

    // usage 缺失时本地估算
    let estimated = usage.prompt == 0 && usage.completion == 0;
    if estimated {
        usage = billing::estimate::estimate_usage(ir, &text_of_blocks(&blocks));
    }

    attempts.push(json!({
        "channel": ch.name, "status": 200,
        "durationMs": t.elapsed().as_millis() as i64, "error": Value::Null,
        "droppedFields": dropped,
    }));
    // 熔断器记成功(HalfOpen 探测成功 → 关闭)
    if let Some(tr) = state.breakers.record_success(ch.id, &effective_breaker_params(state, ch)) {
        emit_breaker(state, ch.id, tr);
    }
    // Responses:写 LRU(供 previous_response_id)
    if let Some((rid, context)) = completion {
        state.resp_store.put(
            &rid,
            responses::StoredResponse {
                context,
                output_blocks: blocks.clone(),
            },
        );
    }
    let rendered =
        render_entry_response(entry, model_in, &blocks, stop, &usage, resp_id.as_deref());
    finalize_log(FinalizeInput {
        state,
        key: Some(key),
        channel: Some(ch),
        model_in,
        mapped: Some(mapped),
        tag,
        protocol_in: entry,
        protocol_up: Some(ch.protocol),
        status: 200,
        is_stream: false,
        attempts: attempts.clone(),
        error: None,
        usage,
        estimated,
        ttft_ms: None,
        started,
        client: client_ua,
        req_snapshot,
        resp_snapshot: Some(truncate_snapshot(state, rendered.to_string().as_str())),
    });

    let mut response = (StatusCode::OK, axum::Json(rendered)).into_response();
    add_gw_headers(&mut response, &ch.name, attempts.len());
    Ok(response)
}

fn text_of_blocks(blocks: &[crate::transform::ir::Block]) -> String {
    let mut s = String::new();
    for b in blocks {
        match b {
            crate::transform::ir::Block::Text { text, .. } => s.push_str(text),
            crate::transform::ir::Block::Thinking { text, .. } => s.push_str(text),
            crate::transform::ir::Block::ToolUse { name, input, .. } => {
                s.push_str(name);
                s.push_str(&input.to_string());
            }
            _ => {}
        }
    }
    s
}

// ---------------------------------------------------------------------------
// 流式处理
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
async fn start_stream(
    state: &AppState,
    resp: reqwest::Response,
    ch: &Channel,
    ir: &CanonicalRequest,
    entry: EntryProto,
    started: Instant,
    // TTFT 计时起点 = 发出上游请求时(t_try),而非拿到响应头之后:
    // 首字应覆盖建连 + 上游排队 + 提示词处理的完整等待
    ttft_start: Instant,
    key: &auth::AuthedKey,
    tag: Option<String>,
    model_in: &str,
    mapped: &str,
    client_ua: &str,
    attempts: &mut Vec<Value>,
    req_snapshot: Option<String>,
    dropped: Vec<String>,
    resp_id: Option<String>,
    completion: Option<(String, Vec<Message>)>,
) -> Result<Response, FailReason> {
    let timeouts = effective_timeouts(state, ch);
    // TTFT 超时:等待首个字节;此时还未向客户端写任何字节,可安全 failover
    let mut bstream = resp.bytes_stream();
    let first = tokio::time::timeout(timeouts.ttft, bstream.next()).await;
    let first_chunk = match first {
        Err(_) => {
            return Err(fail(
                format!("首字超时({}s):上游未产生任何输出", timeouts.ttft.as_secs()),
                Some(200),
                ttft_start,
            ))
        }
        Ok(None) => return Err(fail("上游流为空".into(), Some(200), ttft_start)),
        Ok(Some(Err(e))) => {
            return Err(fail(format!("上游流读取失败: {e}"), Some(200), ttft_start))
        }
        Ok(Some(Ok(bytes))) => bytes,
    };
    // 首字耗时 = 发出上游请求 → 收到首个输出字节
    let ttft_ms = ttft_start.elapsed().as_millis() as i64;

    let passthrough = is_passthrough(entry, ch.protocol);
    // 成功尝试计入 attempts;流已开始即视为上游受理成功(开始后的中断不记账、不重试)
    attempts.push(json!({
        "channel": ch.name, "status": 200,
        "durationMs": ttft_ms, "error": Value::Null,
        "droppedFields": dropped,
    }));
    if let Some(tr) = state.breakers.record_success(ch.id, &effective_breaker_params(state, ch)) {
        emit_breaker(state, ch.id, tr);
    }

    let state2 = state.clone();
    let key2 = auth::AuthedKey {
        id: key.id,
        name: key.name.clone(),
        channels: key.channels.clone(),
    };
    let ch2 = ch.clone();
    let model_in2 = model_in.to_string();
    let mapped2 = mapped.to_string();
    let client2 = client_ua.to_string();
    let attempts2 = attempts.clone();
    let req_snap2 = req_snapshot.clone();
    let tag2 = tag;
    let started2 = started;
    let ir2 = ir.clone();
    let entry2 = entry;

    let on_done = Box::new(move |o: StreamOutcome| {
        let usage = match o.usage {
            Some(u) => u,
            None => {
                let mut text = o.output_text.clone();
                for (_, name, args) in &o.tool_calls {
                    text.push_str(name);
                    text.push_str(args);
                }
                billing::estimate::estimate_usage(&ir2, &text)
            }
        };
        // Responses:从结构化输出重建 blocks 写 LRU
        if let Some((rid, context)) = completion {
            let mut out_blocks: Vec<Block> = Vec::new();
            if !o.output_text.is_empty() {
                out_blocks.push(Block::Text {
                    text: o.output_text.clone(),
                    cache_control: None,
                });
            }
            for (id, name, args) in &o.tool_calls {
                out_blocks.push(Block::ToolUse {
                    id: id.clone(),
                    name: name.clone(),
                    input: serde_json::from_str(args).unwrap_or(json!({})),
                });
            }
            state2.resp_store.put(
                &rid,
                responses::StoredResponse {
                    context,
                    output_blocks: out_blocks,
                },
            );
        }
        let mut resp_text = o.output_text.clone();
        if !o.tool_calls.is_empty() {
            let joined: Vec<String> = o
                .tool_calls
                .iter()
                .map(|(id, name, args)| format!("{name}({args}) [id={id}]"))
                .collect();
            resp_text.push_str(&format!("\n[tool_calls] {}", joined.join(", ")));
        }
        finalize_log(FinalizeInput {
            state: &state2,
            key: Some(&key2),
            channel: Some(&ch2),
            model_in: &model_in2,
            mapped: Some(&mapped2),
            tag: tag2,
            protocol_in: entry2,
            protocol_up: Some(ch2.protocol),
            status: 200,
            is_stream: true,
            attempts: attempts2.clone(),
            error: o.error,
            usage,
            estimated: o.usage.is_none(),
            ttft_ms: Some(o.ttft_ms),
            started: started2,
            client: &client2,
            req_snapshot: req_snap2,
            resp_snapshot: Some(truncate_snapshot(&state2, &resp_text)),
        });
    });

    let body = relay::start_relay(
        bstream,
        first_chunk,
        passthrough,
        ch.protocol,
        entry,
        model_in.to_string(),
        timeouts.stream_idle,
        ttft_ms,
        resp_id,
        on_done,
    );

    let builder = Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-cache");
    let mut response = builder.body(body).unwrap();
    add_gw_headers(&mut response, &ch.name, attempts.len());
    Ok(response)
}

// ---------------------------------------------------------------------------
// 模型列表(双格式自适应)与工具函数
// ---------------------------------------------------------------------------

pub async fn list_models(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let key = match auth::authenticate(&state, &headers, q.get("key").map(String::as_str)) {
        Ok(k) => k,
        Err(e) => {
            let entry = if headers.contains_key("x-api-key") {
                EntryProto::Anthropic
            } else {
                EntryProto::OpenAi
            };
            return e.render(entry);
        }
    };
    let all = state.channels.read().unwrap().clone();
    let mut models: Vec<String> = Vec::new();
    for cid in &key.channels {
        if let Some(ch) = all.iter().find(|c| &c.id == cid) {
            if ch.enabled && !ch.models.is_empty() {
                for m in &ch.models {
                    if !models.contains(m) {
                        models.push(m.clone());
                    }
                }
            }
        }
    }
    models.sort();

    // x-api-key 头(无 Bearer)→ Anthropic list_models 格式;否则 OpenAI 格式
    let has_bearer = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_lowercase().starts_with("bearer "))
        .unwrap_or(false);
    let anthropic_style = headers.contains_key("x-api-key") && !has_bearer;

    if anthropic_style {
        let data: Vec<Value> = models
            .iter()
            .map(|m| {
                json!({
                    "type": "model",
                    "id": m,
                    "display_name": m,
                    "created_at": "2025-01-01T00:00:00Z",
                })
            })
            .collect();
        let body = json!({
            "data": data,
            "has_more": false,
            "first_id": models.first(),
            "last_id": models.last(),
        });
        (StatusCode::OK, axum::Json(body)).into_response()
    } else {
        let now = util::now_ms() / 1000;
        let data: Vec<Value> = models
            .iter()
            .map(|m| json!({"id": m, "object": "model", "created": now, "owned_by": "llm-gateway"}))
            .collect();
        (StatusCode::OK, axum::Json(json!({"object": "list", "data": data}))).into_response()
    }
}

/// Gemini 入口模型列表:{models:[{name:"models/<id>", ...}]}(M5 接入路由)
pub fn list_models_gemini_body(models: &[String]) -> Value {
    json!({
        "models": models.iter().map(|m| json!({
            "name": format!("models/{m}"),
            "displayName": m,
            "supportedGenerationMethods": ["generateContent", "streamGenerateContent", "countTokens"],
        })).collect::<Vec<_>>(),
    })
}

fn mapped_model(ch: &Channel, model_in: &str) -> String {
    ch.model_map
        .get(model_in)
        .cloned()
        .unwrap_or_else(|| model_in.to_string())
}

/// 支持列表判定用映射后的名字;空 = 不限制
fn channel_supports(ch: &Channel, mapped: &str) -> bool {
    ch.models.is_empty() || ch.models.iter().any(|m| m == mapped)
}

/// 渠道内密钥轮询起点(全局递增),401/403/429 时按序轮换
fn rotate_keys(state: &AppState, ch: &Channel) -> Vec<String> {
    let n = ch.api_keys.len();
    if n == 0 {
        return vec![];
    }
    let start = {
        let mut counters = state.key_counters.lock().unwrap();
        let e = counters.entry(ch.id).or_insert(0);
        *e = (*e + 1) % n;
        *e
    };
    (0..n)
        .map(|i| ch.api_keys[(start + i) % n].clone())
        .collect()
}

pub struct EffectiveTimeouts {
    pub connect: Duration,
    pub ttft: Duration,
    pub stream_idle: Duration,
    pub non_stream_total: Duration,
}

/// 渠道覆盖 > 全局默认
fn effective_timeouts(state: &AppState, ch: &Channel) -> EffectiveTimeouts {
    let s = state.current_settings();
    let o = ch.timeout_override.as_ref();
    EffectiveTimeouts {
        connect: Duration::from_secs(
            o.and_then(|o| o.connect_secs)
                .unwrap_or(s.timeouts.connect_secs),
        ),
        ttft: Duration::from_secs(o.and_then(|o| o.ttft_secs).unwrap_or(s.timeouts.ttft_secs)),
        stream_idle: Duration::from_secs(
            o.and_then(|o| o.stream_idle_secs)
                .unwrap_or(s.timeouts.stream_idle_secs),
        ),
        non_stream_total: Duration::from_secs(
            o.and_then(|o| o.non_stream_total_secs)
                .unwrap_or(s.timeouts.non_stream_total_secs),
        ),
    }
}

/// 渠道熔断参数覆盖 > 全局默认
fn effective_breaker_params(state: &AppState, ch: &Channel) -> BreakerParams {
    let s = state.current_settings();
    let mut p = BreakerParams::from_settings(&s.breaker);
    if let Some(o) = &ch.breaker_override {
        if let Some(v) = o.window_secs {
            p.window = Duration::from_secs(v);
        }
        if let Some(v) = o.consecutive_failures {
            p.consecutive_failures = v;
        }
        if let Some(v) = o.sample_min {
            p.sample_min = v;
        }
        if let Some(v) = o.failure_rate {
            p.failure_rate = v;
        }
        if let Some(v) = o.cooldown_secs {
            p.cooldown = Duration::from_secs(v);
        }
        if let Some(v) = o.backoff_max_secs {
            p.backoff_max = Duration::from_secs(v);
        }
    }
    p
}

fn spawn_touch_key(state: &AppState, key_id: i64) {
    let db = state.db.clone();
    tauri::async_runtime::spawn(async move {
        api_keys::touch_last_used(&db, key_id).await;
    });
}

fn emit_breaker(state: &AppState, channel_id: i64, tr: breaker::Transition) {
    let _ = state
        .event_tx
        .try_send(crate::events::GatewayEvent::BreakerChanged {
            channel_id,
            state: tr.state.as_str().to_string(),
        });
}

/// Retry-After:仅支持秒数形式;HTTP 日期形式罕见,忽略
fn parse_retry_after(v: &str) -> Option<Duration> {
    v.trim()
        .parse::<u64>()
        .ok()
        .filter(|s| *s > 0)
        .map(Duration::from_secs)
}

fn attempt_json(ch: &Channel, status: u16, elapsed_ms: i64, error: &str) -> Value {
    json!({
        "channel": ch.name,
        "status": status,
        "durationMs": elapsed_ms,
        "error": util::truncate_utf8(error, 2000),
    })
}

fn err_body_excerpt(body: &str) -> String {
    // 尝试提取 error.message,失败则原样截断
    if let Ok(v) = serde_json::from_str::<Value>(body) {
        if let Some(msg) = v.pointer("/error/message").and_then(Value::as_str) {
            return msg.to_string();
        }
    }
    util::truncate_utf8(body, 500)
}

/// 其他 4xx:原始错误体透传(状态码原样)
fn passthrough_error_response(status: u16, body: &str, content_type: &str) -> Response {
    let code = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
    Response::builder()
        .status(code)
        .header("content-type", content_type)
        .body(axum::body::Body::from(body.to_string()))
        .unwrap()
}

fn add_gw_headers(resp: &mut Response, channel: &str, attempts: usize) {
    // 渠道名可能含中文,HTTP header 仅允许 ASCII → 百分号编码
    if let Ok(v) = util::header_encode(channel).parse() {
        resp.headers_mut().insert("x-gw-channel", v);
    }
    if let Ok(v) = attempts.to_string().parse() {
        resp.headers_mut().insert("x-gw-attempts", v);
    }
}

fn snapshot(state: &AppState, body: &Value) -> Option<String> {
    let full = state.current_settings().save_full_body;
    let s = serde_json::to_string(body).ok()?;
    Some(if full {
        s
    } else {
        util::truncate_utf8(&s, 32 * 1024)
    })
}

fn truncate_snapshot(state: &AppState, s: &str) -> String {
    if state.current_settings().save_full_body {
        s.to_string()
    } else {
        util::truncate_utf8(s, 32 * 1024)
    }
}

// ---------------------------------------------------------------------------
// 计量与日志
// ---------------------------------------------------------------------------

pub struct FinalizeInput<'a> {
    pub state: &'a AppState,
    pub key: Option<&'a auth::AuthedKey>,
    pub channel: Option<&'a Channel>,
    pub model_in: &'a str,
    pub mapped: Option<&'a str>,
    pub tag: Option<String>,
    pub protocol_in: EntryProto,
    pub protocol_up: Option<UpstreamProto>,
    pub status: i64,
    pub is_stream: bool,
    pub attempts: Vec<Value>,
    pub error: Option<String>,
    pub usage: Usage,
    pub estimated: bool,
    pub ttft_ms: Option<i64>,
    pub started: Instant,
    pub client: &'a str,
    pub req_snapshot: Option<String>,
    pub resp_snapshot: Option<String>,
}

fn finalize_log(input: FinalizeInput) {
    let FinalizeInput {
        state,
        key,
        channel,
        model_in,
        mapped,
        tag,
        protocol_in,
        protocol_up,
        status,
        is_stream,
        attempts,
        error,
        usage,
        estimated,
        ttft_ms,
        started,
        client,
        req_snapshot,
        resp_snapshot,
    } = input;

    let total_ms = started.elapsed().as_millis() as i64;
    let speed = if is_stream && total_ms > 0 {
        Some(usage.completion as f64 * 1000.0 / total_ms as f64)
    } else {
        None
    };

    // 计价:入口模型名优先,无匹配回退映射名
    let prices = state.prices.read().unwrap();
    let price = prices
        .match_for(model_in)
        .or_else(|| mapped.and_then(|m| prices.match_for(m)))
        .cloned();
    drop(prices);
    let success = (200..300).contains(&status) && error.is_none();
    let cost = price.as_ref().map(|p| billing::compute_cost(p, &usage));
    let unpriced = success && cost.is_none();

    let entry = RequestLog {
        ts: util::now_ms(),
        key_id: key.map(|k| k.id),
        key_name: key.map(|k| k.name.clone()),
        channel_id: channel.map(|c| c.id),
        channel_name: channel.map(|c| c.name.clone()),
        model: model_in.to_string(),
        mapped_model: mapped.map(str::to_string),
        tag,
        protocol_in: protocol_in.as_str().to_string(),
        protocol_up: protocol_up.map(|p| p.as_str().to_string()),
        status,
        is_stream,
        attempts: json!(attempts),
        error,
        prompt_tokens: usage.prompt,
        completion_tokens: usage.completion,
        cache_read: usage.cache_read,
        cache_write: usage.cache_write,
        estimated,
        ttft_ms,
        total_ms: Some(total_ms),
        speed,
        cost,
        client: Some(util::ua_to_client(client)),
        req_snapshot,
        resp_snapshot,
    };

    if unpriced {
        let db = state.db.clone();
        let m = model_in.to_string();
        tauri::async_runtime::spawn(async move {
            crate::store::prices::record_unpriced(&db, &m).await;
        });
    }
    if let Err(_e) = state.log_tx.try_send(entry) {
        // 队列满:丢弃日志,绝不阻塞响应
    }
}
