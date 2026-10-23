//! 流式中继:上游 SSE → IR 事件 → 入口 SSE,逐 chunk 处理(禁止整体缓冲)。
//! 同协议直通时原始字节透传(仍并行解析一份用于计量 usage/TTFT);
//! 跨协议转换时吞掉上游 keep-alive,按 15s 间隔自行发送注释行。

use std::time::Duration;

use axum::body::Body;
use tokio::time::MissedTickBehavior;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;

use crate::billing::Usage;
use crate::proto::{EntryProto, UpstreamProto};
use crate::transform::{anthropic, gemini, ir::StreamEvent, openai_chat, responses};
use crate::transform::sse::{keepalive_line, SseEvent, SseParser};

type Chunk = axum::body::Bytes;

/// 上游 SSE → IR 的适配器
pub enum UpstreamAdapter {
    OpenAi(openai_chat::UpstreamSse),
    Anthropic(anthropic::UpstreamSse),
    Gemini(gemini::UpstreamSse),
}

impl UpstreamAdapter {
    pub fn new(proto: UpstreamProto) -> Self {
        match proto {
            UpstreamProto::OpenAi => UpstreamAdapter::OpenAi(openai_chat::UpstreamSse::default()),
            UpstreamProto::Anthropic => {
                UpstreamAdapter::Anthropic(anthropic::UpstreamSse::default())
            }
            UpstreamProto::Gemini => UpstreamAdapter::Gemini(gemini::UpstreamSse::default()),
        }
    }

    fn feed(&mut self, ev: &SseEvent, out: &mut Vec<StreamEvent>) {
        match self {
            UpstreamAdapter::OpenAi(s) => s.feed(&ev.data, out),
            UpstreamAdapter::Anthropic(s) => s.feed(&ev.event, &ev.data, out),
            UpstreamAdapter::Gemini(s) => s.feed(&ev.data, out),
        }
    }

    fn is_finished(&self) -> bool {
        match self {
            UpstreamAdapter::OpenAi(s) => s.is_finished(),
            UpstreamAdapter::Anthropic(s) => s.is_finished(),
            UpstreamAdapter::Gemini(s) => s.is_finished(),
        }
    }

    fn force_finish(&mut self, out: &mut Vec<StreamEvent>) {
        match self {
            UpstreamAdapter::OpenAi(s) => s.force_finish(out),
            UpstreamAdapter::Anthropic(s) => s.force_finish(out),
            UpstreamAdapter::Gemini(s) => s.force_finish(out),
        }
    }
}

/// IR → 入口 SSE 渲染器
pub enum EntryRenderer {
    OpenAi(openai_chat::EntrySse),
    Responses(Box<responses::EntrySse>),
    Anthropic(anthropic::EntrySse),
    Gemini(gemini::EntrySse),
}

impl EntryRenderer {
    /// response_id:Responses 入口由外部生成并透传(供 previous_response_id 链)
    pub fn new(entry: EntryProto, model: &str, response_id: Option<String>) -> Self {
        match entry {
            EntryProto::OpenAi => EntryRenderer::OpenAi(openai_chat::EntrySse::new(model)),
            EntryProto::Responses => EntryRenderer::Responses(Box::new(match response_id {
                Some(id) => responses::EntrySse::with_id(id, model),
                None => responses::EntrySse::new(model),
            })),
            EntryProto::Anthropic => EntryRenderer::Anthropic(anthropic::EntrySse::new(model)),
            EntryProto::Gemini => EntryRenderer::Gemini(gemini::EntrySse::new(model)),
        }
    }

    fn render(&mut self, ev: &StreamEvent, out: &mut Vec<String>) {
        match self {
            EntryRenderer::OpenAi(r) => r.render(ev, out),
            EntryRenderer::Responses(r) => r.render(ev, out),
            EntryRenderer::Anthropic(r) => r.render(ev, out),
            EntryRenderer::Gemini(r) => r.render(ev, out),
        }
    }
}

pub struct StreamOutcome {
    pub ttft_ms: i64,
    pub usage: Option<Usage>,
    pub output_text: String,
    /// (call_id, name, arguments_json)
    pub tool_calls: Vec<(String, String, String)>,
    pub error: Option<String>,
}

/// 启动流式中继并返回响应 Body。
/// 调用方已用 TTFT 超时读到 first_chunk(此时还未向客户端写回任何字节)。
#[allow(clippy::too_many_arguments)]
pub fn start_relay(
    bstream: impl tokio_stream::Stream<Item = Result<axum::body::Bytes, reqwest::Error>> + Send + Unpin + 'static,
    first_chunk: axum::body::Bytes,
    passthrough: bool,
    upstream_proto: UpstreamProto,
    entry: EntryProto,
    display_model: String,
    idle_timeout: Duration,
    ttft_ms: i64,
    response_id: Option<String>,
    on_done: Box<dyn FnOnce(StreamOutcome) + Send>,
) -> Body {
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<axum::body::Bytes, std::io::Error>>(64);
    tauri::async_runtime::spawn(async move {
        let mut bstream = bstream;
        let mut parser = SseParser::default();
        let mut adapter = UpstreamAdapter::new(upstream_proto);
        let mut renderer = EntryRenderer::new(entry, &display_model, response_id);

        let mut usage: Option<Usage> = None;
        let mut output_text = String::new();
        let mut tool_calls: Vec<(String, String, String)> = Vec::new();
        let mut error: Option<String> = None;

        let mut sse_events: Vec<SseEvent> = Vec::new();
        let mut ir_events: Vec<StreamEvent> = Vec::new();
        let mut rendered: Vec<String> = Vec::new();

        // 首个 chunk 处理时立即覆盖(loop 内读取前必有赋值)
        #[allow(unused_assignments)]
        let mut last_activity = tokio::time::Instant::now();
        // 跨协议模式:15s 空闲自行发注释行,防客户端/中间层断连
        // interval_at 让首个 tick 在 15s 后(默认 interval 首 tick 立即完成)
        let mut keepalive = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_secs(15),
            Duration::from_secs(15),
        );
        keepalive.set_missed_tick_behavior(MissedTickBehavior::Delay);

        macro_rules! handle_chunk {
            ($chunk:expr) => {{
                last_activity = tokio::time::Instant::now();
                let chunk: Chunk = $chunk;
                if passthrough {
                    if tx.send(Ok(chunk.clone())).await.is_err() {
                        error = Some("客户端已断开".into());
                        return finish(
                            tx,
                            on_done,
                            ttft_ms,
                            usage,
                            output_text,
                            tool_calls,
                            error,
                        );
                    }
                }
                parser.feed(&chunk, &mut sse_events);
                for ev in sse_events.drain(..) {
                    adapter.feed(&ev, &mut ir_events);
                }
                for ev in ir_events.drain(..) {
                    match &ev {
                        StreamEvent::TextDelta { text, .. } => output_text.push_str(text),
                        StreamEvent::ToolStart { id, name, .. } => {
                            tool_calls.push((id.clone(), name.clone(), String::new()));
                        }
                        StreamEvent::ToolDelta { json, .. } => {
                            if let Some(last) = tool_calls.last_mut() {
                                last.2.push_str(json);
                            }
                        }
                        StreamEvent::Finish { usage: u, .. } => usage = *u,
                        StreamEvent::UpstreamError { message } => {
                            error = Some(format!("上游流内错误: {message}"));
                        }
                        _ => {}
                    }
                    if !passthrough && error.is_none() {
                        renderer.render(&ev, &mut rendered);
                        for s in rendered.drain(..) {
                            let bytes: Chunk = s.into_bytes().into();
                            if tx.send(Ok(bytes)).await.is_err() {
                                error = Some("客户端已断开".into());
                                break;
                            }
                        }
                    }
                    if error.is_some() {
                        return finish(
                            tx,
                            on_done,
                            ttft_ms,
                            usage,
                            output_text,
                            tool_calls,
                            error,
                        );
                    }
                }
            }};
        }

        handle_chunk!(first_chunk);
        loop {
            let idle_deadline = last_activity + idle_timeout;
            tokio::select! {
                biased;
                c = bstream.next() => match c {
                    None => break,
                    Some(Err(e)) => {
                        error = Some(format!("上游流中断: {e}"));
                        break;
                    }
                    Some(Ok(chunk)) => {
                        handle_chunk!(chunk);
                        if adapter.is_finished() {
                            // 收到完整结束(如 [DONE])后停止读取,剩余尾包忽略
                            break;
                        }
                    }
                },
                _ = tokio::time::sleep_until(idle_deadline) => {
                    error = Some(format!("流式空闲超时({}s)", idle_timeout.as_secs()));
                    break;
                }
                _ = keepalive.tick(), if !passthrough => {
                    if tx.send(Ok(keepalive_line().into_bytes().into())).await.is_err() {
                        error = Some("客户端已断开".into());
                        break;
                    }
                }
            }
        }
        // 上游未发完整结束事件时合成收尾,保证客户端拿到合法事件序列
        if !adapter.is_finished() {
            adapter.force_finish(&mut ir_events);
            for ev in ir_events.drain(..) {
                if let StreamEvent::Finish { usage: u, .. } = &ev {
                    usage = *u;
                }
                if !passthrough && error.is_none() {
                    renderer.render(&ev, &mut rendered);
                    for s in rendered.drain(..) {
                        let _ = tx.send(Ok(s.into_bytes().into())).await;
                    }
                }
            }
        }
        finish(
            tx,
            on_done,
            ttft_ms,
            usage,
            output_text,
            tool_calls,
            error,
        )
    });
    Body::from_stream(ReceiverStream::new(rx))
}

#[allow(clippy::too_many_arguments)]
fn finish(
    tx: tokio::sync::mpsc::Sender<Result<axum::body::Bytes, std::io::Error>>,
    on_done: Box<dyn FnOnce(StreamOutcome) + Send>,
    ttft_ms: i64,
    usage: Option<Usage>,
    output_text: String,
    tool_calls: Vec<(String, String, String)>,
    error: Option<String>,
) {
    drop(tx);
    on_done(StreamOutcome {
        ttft_ms,
        usage,
        output_text,
        tool_calls,
        error,
    });
}
