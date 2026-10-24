//! failover / 熔断 / 密钥轮换 集成测试(wiremock 模拟上游)。
//! 直接驱动 axum handler,覆盖 PRD §3.4 路由与容错核心行为。

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use llm_desktop_lib::events::GatewayEvent;
use llm_desktop_lib::proto::UpstreamProto;
use llm_desktop_lib::proxy;
use llm_desktop_lib::settings::AppSettings;
use llm_desktop_lib::state::AppState;
use llm_desktop_lib::store::{self, api_keys::ApiKey, channels::Channel};
use tokio::sync::mpsc;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const SSE_BODY: &str = "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"hi\"}}]}\n\n\
        data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
        data: {\"choices\":[],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":3}}\n\n\
        data: [DONE]\n\n";

fn ok_json() -> ResponseTemplate {
    ResponseTemplate::new(200).insert_header("content-type", "application/json").set_body_string(
        r#"{"id":"x","choices":[{"index":0,"message":{"role":"assistant","content":"好的"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}"#,
    )
}

struct TestEnv {
    state: AppState,
    _guard: String,
}

async fn make_state() -> TestEnv {
    let dir = std::env::temp_dir().join(format!(
        "gw-it-{}-{}",
        std::process::id(),
        llm_desktop_lib::util::rand_hex(8)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let pool = store::init_pool(&dir.join("t.db")).await.unwrap();
    let (log_tx, _log_rx) = mpsc::channel(store::logs::QUEUE_SIZE);
    let (event_tx, _event_rx) = mpsc::channel::<GatewayEvent>(64);
    let mut settings = AppSettings::default();
    // 加速熔断与超时判定
    settings.breaker.consecutive_failures = 3;
    settings.breaker.cooldown_secs = 60;
    settings.timeouts.connect_secs = 3;
    settings.timeouts.ttft_secs = 5;
    let state = AppState::new(pool, settings, log_tx, event_tx);
    TestEnv { state, _guard: dir.to_string_lossy().to_string() }
}

async fn add_channel(env: &TestEnv, name: &str, base_url: &str, keys: &[&str]) -> i64 {
    add_channel_proto(env, name, UpstreamProto::OpenAi, base_url, keys).await
}

async fn add_channel_proto(
    env: &TestEnv,
    name: &str,
    protocol: UpstreamProto,
    base_url: &str,
    keys: &[&str],
) -> i64 {
    let ch = Channel {
        id: 0,
        name: name.to_string(),
        protocol,
        base_url: base_url.to_string(),
        api_keys: keys.iter().map(|s| s.to_string()).collect(),
        enabled: true,
        proxy: None,
        models: vec![],
        model_map: Default::default(),
        timeout_override: None,
        breaker_override: None,
        remark: String::new(),
        icon: String::new(),
        price_currency: String::new(),
        rate_rules: Vec::new(),
        created_at: 0,
        updated_at: 0,
    };
    let id = store::channels::insert(&env.state.db, &ch).await.unwrap();
    env.state.reload_channels().await.unwrap();
    id
}

async fn add_key(env: &TestEnv, channels: &[i64]) -> String {
    let key = ApiKey {
        id: 0,
        name: "test".into(),
        key: store::api_keys::generate_key(),
        enabled: true,
        channels: channels.to_vec(),
        remark: String::new(),
        created_at: 0,
        last_used_at: None,
    };
    let plain = key.key.clone();
    store::api_keys::insert(&env.state.db, &key).await.unwrap();
    env.state.reload_keys().await.unwrap();
    plain
}

async fn call(env: &TestEnv, key: &str, body: &str) -> axum::response::Response {
    let mut headers = HeaderMap::new();
    headers.insert(
        "authorization",
        format!("Bearer {key}").parse().unwrap(),
    );
    let mut q = HashMap::new();
    q.insert("beta".to_string(), "true".to_string()); // 未知 query 参数应被容忍
    proxy::chat_completions(
        State(env.state.clone()),
        Query(q),
        headers,
        Bytes::from(body.to_string()),
    )
    .await
}

fn non_stream_body() -> String {
    r#"{"model":"gpt-test","messages":[{"role":"user","content":"你好"}]}"#.to_string()
}

#[tokio::test]
async fn failover_to_second_channel() {
    let env = make_state().await;
    let bad = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(500).set_body_string(r#"{"error":{"message":"boom"}}"#))
        .mount(&bad)
        .await;
    let good = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ok_json())
        .mount(&good)
        .await;

    let c1 = add_channel(&env, "坏渠道", &bad.uri(), &["sk-up-1"]).await;
    let c2 = add_channel(&env, "好渠道", &good.uri(), &["sk-up-2"]).await;
    let gw_key = add_key(&env, &[c1, c2]).await;

    let resp = call(&env, &gw_key, &non_stream_body()).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let chan = llm_desktop_lib::util::header_decode(
        resp.headers().get("x-gw-channel").unwrap().to_str().unwrap(),
    );
    assert_eq!(chan, "好渠道");
    assert_eq!(resp.headers().get("x-gw-attempts").unwrap(), "2");

    // 坏渠道被熔断记账:3 次连续失败后(本测试只失败 1 次,仍 Closed)
    assert_eq!(
        env.state.breakers.status(c1).state,
        llm_desktop_lib::breaker::State::Closed
    );
}

#[tokio::test]
async fn breaker_opens_after_repeated_failures_and_recovers_manually() {
    let env = make_state().await;
    let bad = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(500).set_body_string("{}"))
        .mount(&bad)
        .await;
    let c1 = add_channel(&env, "故障渠道", &bad.uri(), &["sk-up"]).await;
    let gw_key = add_key(&env, &[c1]).await;

    for _ in 0..3 {
        let resp = call(&env, &gw_key, &non_stream_body()).await;
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        // 503 为 OpenAI error 格式
        let body = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(v["error"]["message"].is_string());
    }
    // 第 4 次:熔断打开,直接 503 且不再打到上游
    let resp = call(&env, &gw_key, &non_stream_body()).await;
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        env.state.breakers.status(c1).state,
        llm_desktop_lib::breaker::State::Open
    );
    // 上游应恰好收到 3 次请求(熔断后跳过)
    let reqs = bad.received_requests().await.unwrap_or_default();
    assert_eq!(reqs.len(), 3);

    // 手动恢复后可再次到达上游
    env.state.breakers.reset(c1);
    let good = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ok_json())
        .mount(&good)
        .await;
    // 更新渠道指向 good(base_url 改写)
    let mut ch = env.state.channels.read().unwrap().iter().find(|c| c.id == c1).cloned().unwrap();
    ch.base_url = good.uri();
    store::channels::update(&env.state.db, &ch).await.unwrap();
    env.state.reload_channels().await.unwrap();
    let resp = call(&env, &gw_key, &non_stream_body()).await;
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn upstream_key_rotation_on_401() {
    let env = make_state().await;
    let server = MockServer::start().await;
    // 第一把 key 401,第二把 key 200
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(header("authorization", "Bearer sk-up-bad"))
        .respond_with(ResponseTemplate::new(401).set_body_string(r#"{"error":{"message":"bad key"}}"#))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ok_json())
        .mount(&server)
        .await;

    let c1 = add_channel(&env, "轮换渠道", &server.uri(), &["sk-up-bad", "sk-up-good"]).await;
    let gw_key = add_key(&env, &[c1]).await;

    // 密钥池轮询起点递增:首次请求直接命中第二把 key(good),1 次尝试
    let resp = call(&env, &gw_key, &non_stream_body()).await;
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(resp.headers().get("x-gw-attempts").unwrap(), "1");

    // 第二次请求从 bad key 开始:401 → 轮换到 good,共 2 次尝试且渠道不熔断
    let resp = call(&env, &gw_key, &non_stream_body()).await;
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(resp.headers().get("x-gw-attempts").unwrap(), "2");
    // 渠道最终成功,不计渠道失败
    assert_eq!(
        env.state.breakers.status(c1).state,
        llm_desktop_lib::breaker::State::Closed
    );
}

#[tokio::test]
async fn stream_passthrough_relays_sse() {
    let env = make_state().await;
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(SSE_BODY),
        )
        .mount(&server)
        .await;
    let c1 = add_channel(&env, "流式渠道", &server.uri(), &["sk-up"]).await;
    let gw_key = add_key(&env, &[c1]).await;

    let body = r#"{"model":"gpt-test","stream":true,"messages":[{"role":"user","content":"hi"}]}"#;
    let resp = call(&env, &gw_key, body).await;
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(
        resp.headers().get("content-type").unwrap().to_str().unwrap(),
        "text/event-stream"
    );
    let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    let text = String::from_utf8(bytes.to_vec()).unwrap();
    assert!(text.contains("\"content\":\"hi\""));
    assert!(text.trim_end().ends_with("data: [DONE]"));
}

#[tokio::test]
async fn unauthorized_key_rejected() {
    let env = make_state().await;
    let resp = call(&env, "sk-gw-does-not-exist", &non_stream_body()).await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    let body = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(v["error"]["message"].is_string());
}

#[tokio::test]
async fn models_endpoint_dual_format() {
    let env = make_state().await;
    let c1 = add_channel(&env, "渠道A", "http://127.0.0.1:1", &["sk"]).await;
    // 给渠道配置可枚举模型
    let mut ch = env.state.channels.read().unwrap()[0].clone();
    ch.models = vec!["gpt-4o".into(), "gpt-4o-mini".into()];
    store::channels::update(&env.state.db, &ch).await.unwrap();
    env.state.reload_channels().await.unwrap();
    let _ = c1;
    let gw_key = add_key(&env, &[ch.id]).await;

    // Bearer → OpenAI 格式
    let mut headers = HeaderMap::new();
    headers.insert("authorization", format!("Bearer {gw_key}").parse().unwrap());
    let q = HashMap::new();
    let resp = proxy::list_models(State(env.state.clone()), Query(q.clone()), headers).await;
    let body = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["object"], "list");
    assert_eq!(v["data"].as_array().unwrap().len(), 2);

    // x-api-key → Anthropic 格式
    let mut headers = HeaderMap::new();
    headers.insert("x-api-key", gw_key.parse().unwrap());
    let resp = proxy::list_models(State(env.state.clone()), Query(q), headers).await;
    let body = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["has_more"], false);
    assert_eq!(v["data"][0]["type"], "model");
}

// ---------------------------------------------------------------------------
// M4:Anthropic 入口
// ---------------------------------------------------------------------------

async fn call_messages(env: &TestEnv, key: &str, body: &str, extra: &[(&str, &str)]) -> axum::response::Response {
    let mut headers = HeaderMap::new();
    headers.insert("x-api-key", key.parse().unwrap());
    for (k, v) in extra {
        headers.insert(
            axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
            (*v).parse().unwrap(),
        );
    }
    let mut q = HashMap::new();
    q.insert("beta".to_string(), "true".to_string());
    proxy::messages(
        State(env.state.clone()),
        Query(q),
        headers,
        Bytes::from(body.to_string()),
    )
    .await
}

#[tokio::test]
async fn anthropic_entry_converts_to_openai_upstream() {
    let env = make_state().await;
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ok_json())
        .mount(&server)
        .await;
    let c1 = add_channel(&env, "openai上游", &server.uri(), &["sk-up"]).await;
    let gw_key = add_key(&env, &[c1]).await;

    let body = r#"{"model":"claude-sonnet-4","max_tokens":1024,"messages":[{"role":"user","content":"你好"}]}"#;
    let resp = call_messages(&env, &gw_key, body, &[]).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    // 入口协议格式:anthropic message
    assert_eq!(v["type"], "message");
    assert_eq!(v["role"], "assistant");
    assert_eq!(v["content"][0]["type"], "text");
    assert_eq!(v["content"][0]["text"], "好的");
    assert_eq!(v["usage"]["input_tokens"], 10);
    assert_eq!(v["stop_reason"], "end_turn");

    // 上游收到 openai 格式(max_tokens 透传)
    let reqs = server.received_requests().await.unwrap();
    let up: serde_json::Value =
        serde_json::from_slice(&reqs[0].body).unwrap();
    assert_eq!(up["model"], "claude-sonnet-4");
    assert_eq!(up["max_tokens"], 1024);
    assert_eq!(up["messages"][0]["role"], "user");
    assert_eq!(up["messages"][0]["content"], "你好");
    assert!(reqs[0].url.path().ends_with("/v1/chat/completions"));
}

#[tokio::test]
async fn anthropic_passthrough_preserves_cache_control_and_beta_header() {
    let env = make_state().await;
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/json")
                .set_body_string(
                    r#"{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":100,"output_tokens":5,"cache_read_input_tokens":40,"cache_creation_input_tokens":60}}"#,
                ),
        )
        .mount(&server)
        .await;
    let c1 = add_channel_proto(&env, "anthropic上游", UpstreamProto::Anthropic, &server.uri(), &["sk-anthropic-up"]).await;
    let gw_key = add_key(&env, &[c1]).await;

    let body = r#"{"model":"claude-sonnet-4","max_tokens":128,
        "system":[{"type":"text","text":"sys","cache_control":{"type":"ephemeral"}}],
        "messages":[{"role":"user","content":[{"type":"text","text":"hi","cache_control":{"type":"ephemeral"}}]}]}"#;
    let resp = call_messages(
        &env,
        &gw_key,
        body,
        &[("anthropic-version", "2023-06-01"), ("anthropic-beta", "prompt-caching-2024-07-31")],
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["type"], "message");
    assert_eq!(v["usage"]["cache_read_input_tokens"], 40);

    // 直通:cache_control 原样、anthropic-beta 透传、上游密钥为渠道 Key
    let reqs = server.received_requests().await.unwrap();
    let up: serde_json::Value = serde_json::from_slice(&reqs[0].body).unwrap();
    assert_eq!(up["system"][0]["cache_control"]["type"], "ephemeral");
    assert_eq!(
        up["messages"][0]["content"][0]["cache_control"]["type"],
        "ephemeral"
    );
    let auth = String::from_utf8(reqs[0].headers.get("x-api-key").unwrap().as_bytes().to_vec()).unwrap();
    assert_eq!(auth, "sk-anthropic-up");
    let beta = String::from_utf8(reqs[0].headers.get("anthropic-beta").unwrap().as_bytes().to_vec()).unwrap();
    assert_eq!(beta, "prompt-caching-2024-07-31");
}

#[tokio::test]
async fn anthropic_count_tokens_local_estimate() {
    let env = make_state().await;
    let gw_key = add_key(&env, &[]).await; // 无渠道也应可用(不转发)
    let mut headers = HeaderMap::new();
    headers.insert("x-api-key", gw_key.parse().unwrap());
    let body = r#"{"model":"claude-sonnet-4","messages":[{"role":"user","content":"hello world, count me"}]}"#;
    let resp = proxy::messages_count_tokens(
        State(env.state.clone()),
        Query(HashMap::new()),
        headers,
        Bytes::from(body.to_string()),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(v["input_tokens"].as_i64().unwrap() > 0);
}

#[tokio::test]
async fn anthropic_stream_from_openai_upstream() {
    let env = make_state().await;
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(SSE_BODY),
        )
        .mount(&server)
        .await;
    let c1 = add_channel(&env, "openai流式", &server.uri(), &["sk-up"]).await;
    let gw_key = add_key(&env, &[c1]).await;

    let body = r#"{"model":"m","max_tokens":100,"stream":true,"messages":[{"role":"user","content":"hi"}]}"#;
    let resp = call_messages(&env, &gw_key, body, &[]).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    let text = String::from_utf8(bytes.to_vec()).unwrap();
    // 官方 anthropic 事件序列
    assert!(text.starts_with("event: message_start"));
    assert!(text.contains("\"type\":\"content_block_start\""));
    assert!(text.contains("text_delta"));
    assert!(text.contains("\"stop_reason\":\"end_turn\""));
    assert!(text.contains("\"output_tokens\":3"));
    // message_stop 事件带 data 体,位于流末尾
    assert!(text.contains("event: message_stop
data:"));
    let tail = text.trim_end();
    assert!(tail.rfind("event: message_stop").unwrap_or(0) > tail.rfind("message_delta").unwrap_or(0));
    // 跨协议转换不应把 openai 的 data: [DONE] 原样透出
    assert!(!text.contains("[DONE]"));
}

// ---------------------------------------------------------------------------
// M5:Responses / Gemini 原生入口
// ---------------------------------------------------------------------------

async fn call_responses(env: &TestEnv, key: &str, body: &str) -> axum::response::Response {
    let mut headers = HeaderMap::new();
    headers.insert("authorization", format!("Bearer {key}").parse().unwrap());
    proxy::responses_entry(
        State(env.state.clone()),
        Query(HashMap::new()),
        headers,
        Bytes::from(body.to_string()),
    )
    .await
}

#[tokio::test]
async fn responses_entry_to_openai_upstream() {
    let env = make_state().await;
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ok_json())
        .mount(&server)
        .await;
    let c1 = add_channel(&env, "up", &server.uri(), &["sk-up"]).await;
    let gw_key = add_key(&env, &[c1]).await;

    let body = r#"{"model":"gpt-5","input":[{"type":"message","role":"user","content":"hi"}],"max_output_tokens":256,"instructions":"be brief"}"#;
    let resp = call_responses(&env, &gw_key, body).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["object"], "response");
    assert!(v["id"].as_str().unwrap().starts_with("resp_gw"));
    assert_eq!(v["status"], "completed");
    assert_eq!(v["output"][0]["type"], "message");
    assert_eq!(v["output"][0]["content"][0]["type"], "output_text");
    assert_eq!(v["usage"]["input_tokens"], 10);

    // 上游收到 openai chat 格式:instructions → system
    let reqs = server.received_requests().await.unwrap();
    let up: serde_json::Value = serde_json::from_slice(&reqs[0].body).unwrap();
    assert_eq!(up["messages"][0]["role"], "system");
    assert_eq!(up["messages"][0]["content"], "be brief");
    assert_eq!(up["messages"][1]["role"], "user");
}

#[tokio::test]
async fn responses_stream_official_sequence() {
    let env = make_state().await;
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(SSE_BODY),
        )
        .mount(&server)
        .await;
    let c1 = add_channel(&env, "up", &server.uri(), &["sk-up"]).await;
    let gw_key = add_key(&env, &[c1]).await;

    let body = r#"{"model":"gpt-5","stream":true,"input":"hi"}"#;
    let resp = call_responses(&env, &gw_key, body).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    let text = String::from_utf8(bytes.to_vec()).unwrap();

    // 官方事件序列 + sequence_number 严格递增
    let mut events: Vec<(String, u64, serde_json::Value)> = Vec::new();
    for line in text.lines() {
        if let Some(data) = line.strip_prefix("data: ") {
            let v: serde_json::Value = serde_json::from_str(data).unwrap();
            events.push((
                v["type"].as_str().unwrap_or_default().to_string(),
                v["sequence_number"].as_u64().unwrap_or(0),
                v,
            ));
        }
    }
    let names: Vec<&str> = events.iter().map(|(t, _, _)| t.as_str()).collect();
    assert_eq!(
        names,
        vec![
            "response.created",
            "response.in_progress",
            "response.output_item.added",
            "response.content_part.added",
            "response.output_text.delta",
            "response.content_part.done",
            "response.output_item.done",
            "response.completed",
        ]
    );
    let seqs: Vec<u64> = events.iter().map(|(_, s, _)| *s).collect();
    let mut sorted = seqs.clone();
    sorted.sort();
    assert_eq!(seqs, sorted);
    // completed 带 usage 与 output(Responses 官方 usage 字段为 input/output_tokens)
    let completed = &events.last().unwrap().2;
    assert_eq!(completed["response"]["status"], "completed");
    assert_eq!(completed["response"]["usage"]["output_tokens"], 3);
    assert!(!completed["response"]["output"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn responses_previous_response_id_chain() {
    let env = make_state().await;
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ok_json())
        .mount(&server)
        .await;
    let c1 = add_channel(&env, "up", &server.uri(), &["sk-up"]).await;
    let gw_key = add_key(&env, &[c1]).await;

    let first = r#"{"model":"gpt-5","input":[{"type":"message","role":"user","content":"第一问"}]}"#;
    let resp = call_responses(&env, &gw_key, first).await;
    let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let rid = v["id"].as_str().unwrap().to_string();

    // 未命中(乱编 id)→ 400 明确提示
    let bad = r#"{"model":"gpt-5","previous_response_id":"resp_missing","input":"x"}"#;
    let resp = call_responses(&env, &gw_key, bad).await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(v["error"]["message"]
        .as_str()
        .unwrap()
        .contains("携带完整 input"));

    // 命中:第二轮上游应收到完整上下文(第一轮 user + assistant 输出 + 第二轮 user)
    let second = format!(
        r#"{{"model":"gpt-5","previous_response_id":"{rid}","input":[{{"type":"message","role":"user","content":"第二问"}}]}}"#
    );
    let resp = call_responses(&env, &gw_key, &second).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let reqs = server.received_requests().await.unwrap();
    let up: serde_json::Value = serde_json::from_slice(&reqs.last().unwrap().body).unwrap();
    let msgs = up["messages"].as_array().unwrap();
    assert_eq!(msgs.len(), 3);
    assert_eq!(msgs[0]["content"], "第一问");
    assert_eq!(msgs[1]["role"], "assistant");
    assert_eq!(msgs[1]["content"], "好的");
    assert_eq!(msgs[2]["content"], "第二问");
}

async fn call_gemini(
    env: &TestEnv,
    key: &str,
    model_seg: &str,
    body: &str,
) -> axum::response::Response {
    let mut headers = HeaderMap::new();
    headers.insert("x-goog-api-key", key.parse().unwrap());
    proxy::gemini_dispatch(
        State(env.state.clone()),
        Query(HashMap::new()),
        headers,
        axum::extract::Path(model_seg.to_string()),
        Bytes::from(body.to_string()),
    )
    .await
}

#[tokio::test]
async fn gemini_models_endpoint() {
    let env = make_state().await;
    let mut ch = Channel {
        id: 0,
        name: "g".into(),
        protocol: UpstreamProto::Gemini,
        base_url: "http://127.0.0.1:1".into(),
        api_keys: vec!["sk".into()],
        enabled: true,
        proxy: None,
        models: vec!["gemini-2.5-pro".into()],
        model_map: Default::default(),
        timeout_override: None,
        breaker_override: None,
        remark: String::new(),
        icon: String::new(),
        price_currency: String::new(),
        rate_rules: Vec::new(),
        created_at: 0,
        updated_at: 0,
    };
    ch.id = store::channels::insert(&env.state.db, &ch).await.unwrap();
    env.state.reload_channels().await.unwrap();
    let gw_key = add_key(&env, &[ch.id]).await;

    let mut headers = HeaderMap::new();
    headers.insert("x-goog-api-key", gw_key.parse().unwrap());
    let resp = proxy::gemini_models(
        State(env.state.clone()),
        Query(HashMap::new()),
        headers,
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["models"][0]["name"], "models/gemini-2.5-pro");
}

#[tokio::test]
async fn gemini_generate_and_stream() {
    let env = make_state().await;
    // 跨协议:gemini 入口 → openai 上游
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ok_json())
        .mount(&server)
        .await;
    let c1 = add_channel(&env, "up", &server.uri(), &["sk-up"]).await;
    let gw_key = add_key(&env, &[c1]).await;

    let body = r#"{"contents":[{"role":"user","parts":[{"text":"你好"}]}]}"#;
    let resp = call_gemini(&env, &gw_key, "gemini-test:generateContent", body).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["candidates"][0]["content"]["role"], "model");
    assert_eq!(v["candidates"][0]["content"]["parts"][0]["text"], "好的");
    assert_eq!(v["usageMetadata"]["promptTokenCount"], 10);

    // 上游 URL:模型名拼在路径
    let reqs = server.received_requests().await.unwrap();
    assert!(reqs[0].url.path().contains("/v1/chat/completions"));
    let up: serde_json::Value = serde_json::from_slice(&reqs[0].body).unwrap();
    assert_eq!(up["messages"][0]["content"], "你好");

    // 流式:gemini 上游返回 SSE,入口也应得到 data: {GenerateContentResponse}
    let gserver = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(concat!(
                    "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"早\"}],\"role\":\"model\"}}]}\n\n",
                    "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"上\"}],\"role\":\"model\"},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":5,\"candidatesTokenCount\":2}}\n\n",
                )),
        )
        .mount(&gserver)
        .await;
    let c2 = add_channel_proto(&env, "gemini上游", UpstreamProto::Gemini, &gserver.uri(), &["sk-g"]).await;
    let gw_key2 = add_key(&env, &[c2]).await;
    let resp = call_gemini(
        &env,
        &gw_key2,
        "gemini-test:streamGenerateContent",
        body,
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    let text = String::from_utf8(bytes.to_vec()).unwrap();
    assert!(text.contains(r#""text":"早""#));
    assert!(text.contains(r#""finishReason":"STOP""#));
    assert!(text.contains(r#""candidatesTokenCount":2"#));
}

#[tokio::test]
async fn gemini_count_tokens_local() {
    let env = make_state().await;
    let gw_key = add_key(&env, &[]).await;
    let body = r#"{"contents":[{"role":"user","parts":[{"text":"hello gemini counting"}]}]}"#;
    let resp = call_gemini(&env, &gw_key, "m:countTokens", body).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(v["totalTokens"].as_i64().unwrap() > 0);
}
