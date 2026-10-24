//! Anthropic Messages 协议适配器:"协议 ↔ IR"。
//! 重点:cache_control 透传(Anthropic→Anthropic 直通时由原始字节保留;经 IR 转换时保留在 system/文本块上)、
//! thinking 块、tool_use/tool_result 双向映射。

use serde_json::{json, Map, Value};

use super::ir::{
    Block, CanonicalRequest, Message, Reasoning, Role, StopReason, StreamEvent, Tool, ToolChoice,
};
use crate::billing::Usage;
use crate::transform::sse::event_line;

/// Anthropic thinking.budget_tokens 与 OpenAI reasoning_effort 的尽力映射
pub const EFFORT_BUDGET: [(super::ir::Effort, u32); 3] = [
    (super::ir::Effort::Low, 4096),
    (super::ir::Effort::Medium, 8192),
    (super::ir::Effort::High, 16384),
];

/// max_tokens 缺省值(Anthropic 上游必填)
pub const DEFAULT_MAX_TOKENS: i64 = 8192;

// ---------------------------------------------------------------------------
// 入口请求解析:Anthropic JSON → IR
// ---------------------------------------------------------------------------

pub fn parse_request(v: &Value) -> Result<CanonicalRequest, String> {
    let obj = v
        .as_object()
        .ok_or_else(|| "请求体必须是 JSON 对象".to_string())?;
    let model = obj
        .get("model")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "缺少 model 字段".to_string())?
        .to_string();
    let stream = obj.get("stream").and_then(Value::as_bool).unwrap_or(false);

    let mut ir = CanonicalRequest {
        model,
        stream,
        ..Default::default()
    };

    // system: string | [{type:text, text, cache_control}]
    match obj.get("system") {
        Some(Value::String(s)) => ir.system.push(Block::Text {
            text: s.clone(),
            cache_control: None,
        }),
        Some(Value::Array(blocks)) => {
            for b in blocks {
                if b.get("type").and_then(Value::as_str) == Some("text") {
                    ir.system.push(Block::Text {
                        text: b
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        cache_control: b.get("cache_control").cloned(),
                    });
                }
            }
        }
        _ => {}
    }

    let messages = obj
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "缺少 messages 数组".to_string())?;
    for m in messages {
        let role = match m.get("role").and_then(Value::as_str) {
            Some("user") => Role::User,
            Some("assistant") => Role::Assistant,
            _ => {
                ir.push_dropped("message.role");
                continue;
            }
        };
        let blocks = parse_blocks(m.get("content"), &mut ir)?;
        ir.messages.push(Message { role, blocks });
    }

    if let Some(tools) = obj.get("tools").and_then(Value::as_array) {
        for t in tools {
            if t.get("type").and_then(Value::as_str).is_some_and(|t| t != "custom") {
                ir.push_dropped("tools[type]");
                continue;
            }
            ir.tools.push(Tool {
                name: t
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                description: t
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                input_schema: t.get("input_schema").cloned().unwrap_or_else(|| json!({})),
            });
        }
    }

    if let Some(tc) = obj.get("tool_choice") {
        ir.tool_choice = match tc.get("type").and_then(Value::as_str) {
            Some("auto") => Some(ToolChoice::Auto),
            Some("any") => Some(ToolChoice::Any),
            Some("none") => Some(ToolChoice::None),
            Some("tool") => tc
                .get("name")
                .and_then(Value::as_str)
                .map(|n| ToolChoice::Tool(n.to_string())),
            _ => None,
        };
    }

    ir.max_tokens = obj.get("max_tokens").and_then(Value::as_i64);
    ir.temperature = obj.get("temperature").and_then(Value::as_f64);
    ir.top_p = obj.get("top_p").and_then(Value::as_f64);
    if let Some(stops) = obj.get("stop_sequences").and_then(Value::as_array) {
        for s in stops.iter().filter_map(Value::as_str) {
            ir.stop.push(s.to_string());
        }
    }
    match obj.get("thinking") {
        Some(t) if t.get("type").and_then(Value::as_str) == Some("enabled") => {
            if let Some(b) = t.get("budget_tokens").and_then(Value::as_u64) {
                // u64→u32 饱和转换:超大值(恶意/异常客户端)钳到 u32::MAX 而非静默回绕
                ir.reasoning = Some(Reasoning::Budget(u32::try_from(b).unwrap_or(u32::MAX)));
            }
        }
        _ => {}
    }

    for f in ["metadata", "top_k", "service_tier", "stop_sequences"] {
        if obj.contains_key(f) && f != "stop_sequences" {
            ir.push_dropped(f);
        }
    }
    Ok(ir)
}

fn parse_blocks(v: Option<&Value>, ir: &mut CanonicalRequest) -> Result<Vec<Block>, String> {
    let Some(v) = v else {
        return Ok(vec![]);
    };
    match v {
        Value::String(s) => Ok(vec![Block::Text {
            text: s.clone(),
            cache_control: None,
        }]),
        Value::Array(parts) => {
            let mut blocks = Vec::new();
            for p in parts {
                let ty = p.get("type").and_then(Value::as_str);
                match ty {
                    Some("text") => blocks.push(Block::Text {
                        text: p
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        cache_control: p.get("cache_control").cloned(),
                    }),
                    Some("image") => {
                        let source = p.get("source").cloned().unwrap_or(Value::Null);
                        if source.get("type").and_then(Value::as_str) == Some("base64") {
                            blocks.push(Block::Image {
                                media_type: source
                                    .get("media_type")
                                    .and_then(Value::as_str)
                                    .unwrap_or("image/png")
                                    .to_string(),
                                data_b64: source
                                    .get("data")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string(),
                                cache_control: p.get("cache_control").cloned(),
                            });
                        } else {
                            ir.push_dropped("image(url)");
                        }
                    }
                    Some("tool_use") => blocks.push(Block::ToolUse {
                        id: p
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        name: p
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        input: p.get("input").cloned().unwrap_or_else(|| json!({})),
                    }),
                    Some("tool_result") => {
                        let content = match p.get("content") {
                            Some(Value::String(s)) => s.clone(),
                            Some(Value::Array(parts)) => parts
                                .iter()
                                .filter_map(|b| b.get("text").and_then(Value::as_str))
                                .collect::<Vec<_>>()
                                .join("\n"),
                            _ => String::new(),
                        };
                        blocks.push(Block::ToolResult {
                            tool_use_id: p
                                .get("tool_use_id")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                            content,
                            is_error: p
                                .get("is_error")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                            cache_control: p.get("cache_control").cloned(),
                        });
                    }
                    Some("thinking") => blocks.push(Block::Thinking {
                        text: p
                            .get("thinking")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        signature: p
                            .get("signature")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    }),
                    _ => ir.push_dropped("content block"),
                }
            }
            Ok(blocks)
        }
        _ => Err("content 字段类型无效".to_string()),
    }
}

// ---------------------------------------------------------------------------
// 上游请求渲染:IR → Anthropic JSON(cache_control 尽量保留)
// ---------------------------------------------------------------------------

pub fn render_request(ir: &CanonicalRequest) -> (Value, Vec<String>) {
    let mut dropped: Vec<String> = Vec::new();
    let mut obj = Map::new();
    obj.insert("model".into(), json!(ir.model));
    obj.insert(
        "max_tokens".into(),
        json!(ir.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS)),
    );

    // system:带 cache_control 时用块数组(缓存写 token 的唯一来源)
    let has_cc = ir.system.iter().any(block_has_cache);
    if !ir.system.is_empty() {
        let texts: Vec<&str> = ir
            .system
            .iter()
            .filter_map(|b| match b {
                Block::Text { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        if has_cc {
            if ir.system.iter().any(|b| matches!(b, Block::Image { .. })) {
                push_drop(&mut dropped, "system(image)");
            }
            let blocks: Vec<Value> = ir
                .system
                .iter()
                .filter_map(|b| match b {
                    Block::Text { text, cache_control } => {
                        let mut m = json!({"type": "text", "text": text});
                        if let Some(cc) = cache_control {
                            m["cache_control"] = cc.clone();
                        }
                        Some(m)
                    }
                    _ => None,
                })
                .collect();
            obj.insert("system".into(), Value::Array(blocks));
        } else {
            obj.insert("system".into(), json!(texts.join("\n\n")));
        }
    }

    let mut messages: Vec<Value> = Vec::new();
    for m in &ir.messages {
        let mut blocks: Vec<Value> = Vec::new();
        for b in &m.blocks {
            match b {
                Block::Text { text, cache_control } => {
                    let mut blk = json!({"type": "text", "text": text});
                    if let Some(cc) = cache_control {
                        blk["cache_control"] = cc.clone();
                    }
                    blocks.push(blk);
                }
                Block::Image {
                    media_type,
                    data_b64,
                    cache_control,
                } => {
                    let mut blk = json!({
                        "type": "image",
                        "source": {"type": "base64", "media_type": media_type, "data": data_b64},
                    });
                    if let Some(cc) = cache_control {
                        blk["cache_control"] = cc.clone();
                    }
                    blocks.push(blk);
                }
                Block::ToolUse { id, name, input } => {
                    blocks.push(json!({"type": "tool_use", "id": id, "name": name, "input": input}));
                }
                Block::ToolResult {
                    tool_use_id,
                    content,
                    is_error,
                    cache_control,
                } => {
                    let mut blk = json!({
                        "type": "tool_result",
                        "tool_use_id": tool_use_id,
                        "content": [{"type": "text", "text": content}],
                    });
                    if *is_error {
                        blk["is_error"] = json!(true);
                    }
                    if let Some(cc) = cache_control {
                        blk["cache_control"] = cc.clone();
                    }
                    blocks.push(blk);
                }
                Block::Thinking { text, signature } => {
                    // 无签名的 thinking 块无法通过上游校验,丢弃
                    if let Some(sig) = signature {
                        blocks.push(json!({
                            "type": "thinking", "thinking": text, "signature": sig,
                        }));
                    } else {
                        push_drop(&mut dropped, "thinking(no signature)");
                    }
                }
            }
        }
        if !blocks.is_empty() {
            messages.push(json!({
                "role": if matches!(m.role, Role::User) { "user" } else { "assistant" },
                "content": blocks,
            }));
        }
    }
    obj.insert("messages".into(), Value::Array(messages));

    if !ir.tools.is_empty() {
        obj.insert(
            "tools".into(),
            Value::Array(
                ir.tools
                    .iter()
                    .map(|t| {
                        json!({
                            "name": t.name,
                            "description": t.description,
                            "input_schema": t.input_schema,
                        })
                    })
                    .collect(),
            ),
        );
    }
    if let Some(tc) = &ir.tool_choice {
        obj.insert(
            "tool_choice".into(),
            match tc {
                ToolChoice::Auto => json!({"type": "auto"}),
                ToolChoice::None => json!({"type": "none"}),
                ToolChoice::Any => json!({"type": "any"}),
                ToolChoice::Tool(n) => json!({"type": "tool", "name": n}),
            },
        );
    }

    // budget_tokens 必须 < max_tokens 且 ≥1024:effort 映射的固定预算(如 high=16384)
    // 可能超过客户端的 max_tokens,超限 Anthropic 直接 400。钳到 max_tokens 的一半
    // (至少 1024),保证合法;thinking 关闭时同样处理
    let clamped_budget = |b: u32| -> u32 {
        let max_t = ir.max_tokens.unwrap_or(i64::MAX) as u32;
        if b < max_t {
            b
        } else {
            (max_t / 2).max(1024)
        }
    };
    match ir.reasoning {
        Some(Reasoning::Budget(b)) => {
            obj.insert(
                "thinking".into(),
                json!({"type": "enabled", "budget_tokens": clamped_budget(b)}),
            );
            // Anthropic thinking 模式要求 temperature=1 且不能带 top_p
            if ir.temperature.is_some() {
                push_drop(&mut dropped, "temperature(thinking)");
            }
            if ir.top_p.is_some() {
                push_drop(&mut dropped, "top_p(thinking)");
            }
        }
        Some(Reasoning::Effort(e)) => {
            if let Some((_, budget)) = EFFORT_BUDGET
                .iter()
                .rev()
                .find(|(eff, _)| *eff <= e)
            {
                obj.insert(
                    "thinking".into(),
                    json!({"type": "enabled", "budget_tokens": clamped_budget(*budget)}),
                );
                if ir.temperature.is_some() {
                    push_drop(&mut dropped, "temperature(thinking)");
                }
                if ir.top_p.is_some() {
                    push_drop(&mut dropped, "top_p(thinking)");
                }
            }
        }
        None => {}
    }
    if ir.reasoning.is_none() {
        if let Some(t) = ir.temperature {
            obj.insert("temperature".into(), json!(t));
        }
        if let Some(t) = ir.top_p {
            obj.insert("top_p".into(), json!(t));
        }
    }
    if !ir.stop.is_empty() {
        obj.insert("stop_sequences".into(), json!(ir.stop));
    }
    if ir.stream {
        obj.insert("stream".into(), json!(true));
    }
    dropped.extend(ir.dropped_fields.iter().cloned());
    (Value::Object(obj), dropped)
}

fn block_has_cache(b: &Block) -> bool {
    matches!(b, Block::Text { cache_control: Some(_), .. })
        || matches!(b, Block::Image { cache_control: Some(_), .. })
        || matches!(b, Block::ToolResult { cache_control: Some(_), .. })
}

fn push_drop(dropped: &mut Vec<String>, field: &str) {
    if !dropped.iter().any(|d| d == field) {
        dropped.push(field.to_string());
    }
}

// ---------------------------------------------------------------------------
// 非流式响应:Anthropic JSON ↔ IR
// ---------------------------------------------------------------------------

pub struct ParsedResponse {
    pub blocks: Vec<Block>,
    pub stop: Option<StopReason>,
    pub usage: Usage,
}

pub enum UpstreamBody {
    Ok(ParsedResponse),
    Err(String),
}

/// Anthropic usage 归一化:input_tokens **不含** cache_read/cache_write(三者互斥),
/// 而 Usage.prompt 全协议统一为"含缓存的总输入"语义(OpenAI prompt_tokens、
/// Gemini promptTokenCount 均如此),计费公式按总量扣缓存。若不归一化,
/// 非缓存输入会被公式二次扣减而免计,费用系统性偏低。
pub fn parse_usage(u: &Value) -> Usage {
    // 负值钳 0:异常/恶意上游回负 token 会让 i64 相加回绕、计费出负费用,
    // 且与回填口径(backfill .max(0))保持一致
    let clamp = |v: Option<i64>| v.unwrap_or(0).max(0);
    let input = clamp(u.get("input_tokens").and_then(Value::as_i64));
    let cache_read = clamp(u.get("cache_read_input_tokens").and_then(Value::as_i64));
    let cache_write = clamp(u.get("cache_creation_input_tokens").and_then(Value::as_i64));
    Usage {
        prompt: input + cache_read + cache_write,
        completion: clamp(u.get("output_tokens").and_then(Value::as_i64)),
        cache_read,
        cache_write,
    }
}

pub fn parse_finish(s: &str) -> StopReason {
    match s {
        "max_tokens" => StopReason::MaxTokens,
        "stop_sequence" => StopReason::StopSequence,
        "tool_use" => StopReason::ToolUse,
        "end_turn" | "stop" => StopReason::EndTurn,
        _ => StopReason::Other,
    }
}

pub fn render_finish(sr: StopReason) -> &'static str {
    match sr {
        StopReason::MaxTokens => "max_tokens",
        StopReason::StopSequence => "stop_sequence",
        StopReason::ToolUse => "tool_use",
        StopReason::EndTurn | StopReason::Other => "end_turn",
    }
}

pub fn parse_response_json(v: &Value) -> Result<UpstreamBody, String> {
    if v.get("type").and_then(Value::as_str) == Some("error") {
        let msg = v
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        return Ok(UpstreamBody::Err(msg.to_string()));
    }
    let mut blocks = Vec::new();
    if let Some(content) = v.get("content").and_then(Value::as_array) {
        for b in content {
            match b.get("type").and_then(Value::as_str) {
                Some("text") => blocks.push(Block::Text {
                    text: b
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    cache_control: None,
                }),
                Some("tool_use") => blocks.push(Block::ToolUse {
                    id: b
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    name: b
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    input: b.get("input").cloned().unwrap_or_else(|| json!({})),
                }),
                Some("thinking") => blocks.push(Block::Thinking {
                    text: b
                        .get("thinking")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    signature: b.get("signature").and_then(Value::as_str).map(str::to_string),
                }),
                _ => {}
            }
        }
    }
    let stop = v
        .get("stop_reason")
        .and_then(Value::as_str)
        .map(parse_finish);
    let usage = v.get("usage").map(parse_usage).unwrap_or_default();
    Ok(UpstreamBody::Ok(ParsedResponse {
        blocks,
        stop,
        usage,
    }))
}

pub fn render_response_json(
    model: &str,
    blocks: &[Block],
    stop: Option<StopReason>,
    usage: &Usage,
) -> Value {
    let content: Vec<Value> = blocks
        .iter()
        .filter_map(|b| match b {
            Block::Text { text, .. } => Some(json!({"type": "text", "text": text})),
            Block::ToolUse { id, name, input } => {
                Some(json!({"type": "tool_use", "id": id, "name": name, "input": input}))
            }
            Block::Thinking { text, signature } => Some(json!({
                "type": "thinking", "thinking": text, "signature": signature,
            })),
            _ => None,
        })
        .collect();
    json!({
        "id": format!("msg_gw{}", crate::util::rand_hex(20)),
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": content,
        "stop_reason": stop.map(render_finish),
        "stop_sequence": Value::Null,
        // Usage.prompt 为"含缓存总输入"(内部统一口径);Anthropic 协议要求
        // input_tokens 不含缓存项(三者互斥),出站需反向拆分
        "usage": {
            "input_tokens": (usage.prompt - usage.cache_read - usage.cache_write).max(0),
            "output_tokens": usage.completion,
            "cache_read_input_tokens": usage.cache_read,
            "cache_creation_input_tokens": usage.cache_write,
        },
    })
}

// ---------------------------------------------------------------------------
// 流式:Anthropic 上游 SSE → IR 事件
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct UpstreamSse {
    input_usage: Usage,
    stop: Option<StopReason>,
    output_tokens: i64,
    started: bool,
    finished: bool,
}

impl UpstreamSse {
    pub fn feed(&mut self, event: &str, data: &str, out: &mut Vec<StreamEvent>) {
        if self.finished {
            return;
        }
        let Ok(v) = serde_json::from_str::<Value>(data) else {
            return;
        };
        match event {
            "message_start" => {
                self.started = true;
                if let Some(u) = v.pointer("/message/usage") {
                    self.input_usage = parse_usage(u);
                }
                let model = v
                    .pointer("/message/model")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                out.push(StreamEvent::Start { model });
            }
            "content_block_start" => {
                let index = v.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let cb = v.get("content_block").cloned().unwrap_or(Value::Null);
                if cb.get("type").and_then(Value::as_str) == Some("tool_use") {
                    out.push(StreamEvent::ToolStart {
                        block: index,
                        id: cb
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        name: cb
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    });
                } // text/thinking 由 delta 驱动
            }
            "content_block_delta" => {
                let index = v.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let delta = v.get("delta").cloned().unwrap_or(Value::Null);
                match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => out.push(StreamEvent::TextDelta {
                        block: index,
                        text: delta
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    }),
                    Some("input_json_delta") => out.push(StreamEvent::ToolDelta {
                        block: index,
                        json: delta
                            .get("partial_json")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    }),
                    Some("thinking_delta") => out.push(StreamEvent::ReasoningDelta {
                        text: delta
                            .get("thinking")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    }),
                    _ => {} // signature_delta 等
                }
            }
            "content_block_stop" => {
                let index = v.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                out.push(StreamEvent::BlockStop { block: index });
            }
            "message_delta" => {
                if let Some(sr) = v
                    .pointer("/delta/stop_reason")
                    .and_then(Value::as_str)
                {
                    self.stop = Some(parse_finish(sr));
                }
                if let Some(o) = v.pointer("/usage/output_tokens").and_then(Value::as_i64) {
                    self.output_tokens = o;
                }
            }
            "message_stop" => {
                self.finished = true;
                let mut usage = self.input_usage;
                usage.completion = self.output_tokens;
                out.push(StreamEvent::Finish {
                    stop_reason: self.stop,
                    usage: Some(usage),
                });
            }
            "error" => {
                self.finished = true;
                let msg = v
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("upstream stream error");
                out.push(StreamEvent::UpstreamError {
                    message: msg.to_string(),
                });
            }
            _ => {} // ping 等
        }
    }

    pub fn is_finished(&self) -> bool {
        self.finished
    }

    pub fn force_finish(&mut self, out: &mut Vec<StreamEvent>) {
        if self.finished {
            return;
        }
        self.finished = true;
        let _ = self.started;
        let mut usage = self.input_usage;
        usage.completion = self.output_tokens;
        out.push(StreamEvent::Finish {
            stop_reason: self.stop,
            usage: Some(usage),
        });
    }
}

// ---------------------------------------------------------------------------
// 流式:IR 事件 → Anthropic 入口 SSE(合成官方事件序列)
// ---------------------------------------------------------------------------

/// IR block 号 → 出站 content_block index(递增分配,避免上游序号重用违规)
pub struct EntrySse {
    id: String,
    model: String,
    started: bool,
    open_block: Option<(usize, &'static str)>,
    index_of: std::collections::HashMap<usize, usize>,
    /// 每个 block 的 content_block_start 载荷:并行工具调用 delta 交错到达时,
    /// 关闭当前块重开另一块需要真实 id/name——不能发空载荷产出非法 tool_use
    start_payloads: std::collections::HashMap<usize, Value>,
    next_index: usize,
    finished: bool,
}

impl EntrySse {
    pub fn new(model: &str) -> Self {
        Self {
            id: format!("msg_gw{}", crate::util::rand_hex(20)),
            model: model.to_string(),
            started: false,
            open_block: None,
            index_of: Default::default(),
            start_payloads: Default::default(),
            next_index: 0,
            finished: false,
        }
    }

    fn out_index(&mut self, block: usize) -> usize {
        *self
            .index_of
            .entry(block)
            .or_insert_with(|| {
                let i = self.next_index;
                self.next_index += 1;
                i
            })
    }

    fn close_open(&mut self, out: &mut Vec<String>) {
        if let Some((idx, _)) = self.open_block.take() {
            out.push(event_line(
                "content_block_stop",
                &json!({"type": "content_block_stop", "index": idx}).to_string(),
            ));
        }
    }

    fn start_message(&mut self, out: &mut Vec<String>) {
        if self.started {
            return;
        }
        self.started = true;
        out.push(event_line(
            "message_start",
            &json!({
                "type": "message_start",
                "message": {
                    "id": self.id,
                    "type": "message",
                    "role": "assistant",
                    "model": self.model,
                    "content": [],
                    "stop_reason": Value::Null,
                    "usage": {"input_tokens": 0, "output_tokens": 0},
                },
            })
            .to_string(),
        ));
    }

    fn open_block_of(
        &mut self,
        block: usize,
        ty: &'static str,
        start_payload: Value,
        out: &mut Vec<String>,
    ) -> usize {
        let idx = self.out_index(block);
        // 记录/更新该块的 start 载荷(ToolStart 首次带真实 id/name,后续重开取用)
        self.start_payloads.insert(block, start_payload.clone());
        if self.open_block != Some((idx, ty)) {
            self.close_open(out);
            out.push(event_line(
                "content_block_start",
                &json!({
                    "type": "content_block_start",
                    "index": idx,
                    "content_block": start_payload,
                })
                .to_string(),
            ));
            self.open_block = Some((idx, ty));
        }
        idx
    }

    pub fn render(&mut self, ev: &StreamEvent, out: &mut Vec<String>) {
        if self.finished {
            return;
        }
        match ev {
            StreamEvent::Start { model } => {
                if !model.is_empty() {
                    self.model = model.clone();
                }
                self.start_message(out);
            }
            StreamEvent::TextDelta { block, text } => {
                self.start_message(out);
                let idx = self.open_block_of(
                    *block,
                    "text",
                    json!({"type": "text", "text": ""}),
                    out,
                );
                out.push(event_line(
                    "content_block_delta",
                    &json!({
                        "type": "content_block_delta",
                        "index": idx,
                        "delta": {"type": "text_delta", "text": text},
                    })
                    .to_string(),
                ));
            }
            StreamEvent::ReasoningDelta { text } => {
                self.start_message(out);
                let idx = self.open_block_of(
                    usize::MAX,
                    "thinking",
                    json!({"type": "thinking", "thinking": ""}),
                    out,
                );
                out.push(event_line(
                    "content_block_delta",
                    &json!({
                        "type": "content_block_delta",
                        "index": idx,
                        "delta": {"type": "thinking_delta", "thinking": text},
                    })
                    .to_string(),
                ));
            }
            StreamEvent::ToolStart { block, id, name } => {
                self.start_message(out);
                // 与文本块交错时 anthropic 要求先关闭前面的块
                self.open_block_of(
                    *block,
                    "tool_use",
                    json!({"type": "tool_use", "id": id, "name": name, "input": {}}),
                    out,
                );
            }
            StreamEvent::ToolDelta { block, json } => {
                // 交错场景:该块此前已 start 过,用缓存的原始载荷重开(含真实 id/name),
                // 绝不发空 id/name 的非法 tool_use
                let payload = self
                    .start_payloads
                    .get(block)
                    .cloned()
                    .unwrap_or_else(|| json!({"type": "tool_use", "id": "", "name": "", "input": {}}));
                let idx = self.open_block_of(*block, "tool_use", payload, out);
                out.push(event_line(
                    "content_block_delta",
                    &json!({
                        "type": "content_block_delta",
                        "index": idx,
                        "delta": {"type": "input_json_delta", "partial_json": json},
                    })
                    .to_string(),
                ));
            }
            StreamEvent::BlockStop { block } => {
                if self
                    .open_block
                    .is_some_and(|(idx, _)| Some(idx) == self.index_of.get(block).copied())
                {
                    self.close_open(out);
                }
            }
            StreamEvent::Finish { stop_reason, usage } => {
                self.start_message(out);
                self.close_open(out);
                let completion = usage.map(|u| u.completion).unwrap_or(0);
                out.push(event_line(
                    "message_delta",
                    &json!({
                        "type": "message_delta",
                        "delta": {"stop_reason": stop_reason.map(render_finish), "stop_sequence": Value::Null},
                        "usage": {"output_tokens": completion},
                    })
                    .to_string(),
                ));
                out.push(event_line(
                    "message_stop",
                    &json!({"type": "message_stop"}).to_string(),
                ));
                self.finished = true;
            }
            StreamEvent::UpstreamError { .. } => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_request_with_cache_control() {
        let body: Value = serde_json::from_str(
            r#"{
            "model":"claude-sonnet-4","max_tokens":2048,"stream":true,
            "system":[{"type":"text","text":"sys","cache_control":{"type":"ephemeral"}}],
            "thinking":{"type":"enabled","budget_tokens":1024},
            "tool_choice":{"type":"any"},
            "tools":[{"name":"f","description":"d","input_schema":{"type":"object"}}],
            "messages":[
                {"role":"user","content":"你好"},
                {"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"f","input":{"a":1}}]},
                {"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}
            ]}"#,
        )
        .unwrap();
        let ir = parse_request(&body).unwrap();
        assert_eq!(ir.max_tokens, Some(2048));
        assert!(matches!(
            ir.system[0],
            Block::Text { cache_control: Some(_), .. }
        ));
        assert_eq!(ir.reasoning, Some(Reasoning::Budget(1024)));
        assert!(matches!(ir.tool_choice, Some(ToolChoice::Any)));
        assert_eq!(ir.messages.len(), 3);
        assert!(matches!(ir.messages[2].blocks[0], Block::ToolResult { .. }));
    }

    #[test]
    fn render_request_preserves_cache_control() {
        let body: Value = serde_json::from_str(
            r#"{"model":"m","max_tokens":100,
            "system":[{"type":"text","text":"sys","cache_control":{"type":"ephemeral"}}],
            "messages":[{"role":"user","content":"hi"}]}"#,
        )
        .unwrap();
        let ir = parse_request(&body).unwrap();
        let (rendered, _) = render_request(&ir);
        assert_eq!(
            rendered["system"][0]["cache_control"]["type"],
            "ephemeral"
        );
        assert_eq!(rendered["max_tokens"], 100);
    }

    #[test]
    fn effort_maps_to_thinking_budget() {
        // effort=high 映射 16384,但 max_tokens=4096:钳位到 max_tokens/2=2048,
        // 否则 budget >= max_tokens 被 Anthropic 拒绝(400)
        let ir = CanonicalRequest {
            model: "claude".into(),
            max_tokens: Some(4096),
            reasoning: Some(Reasoning::Effort(super::super::ir::Effort::High)),
            ..Default::default()
        };
        let (rendered, _) = render_request(&ir);
        assert_eq!(rendered["thinking"]["budget_tokens"], 2048);
        assert_eq!(rendered["max_tokens"], 4096);

        // max_tokens 足够大时保持原预算
        let ir = CanonicalRequest {
            model: "claude".into(),
            max_tokens: Some(32768),
            reasoning: Some(Reasoning::Effort(super::super::ir::Effort::High)),
            ..Default::default()
        };
        let (rendered, _) = render_request(&ir);
        assert_eq!(rendered["thinking"]["budget_tokens"], 16384);
    }

    #[test]
    fn upstream_sse_full_sequence() {
        let mut sse = UpstreamSse::default();
        let mut out = Vec::new();
        sse.feed("message_start", r#"{"type":"message_start","message":{"model":"claude","usage":{"input_tokens":10,"cache_read_input_tokens":4}}}"#, &mut out);
        sse.feed("content_block_start", r#"{"index":0,"content_block":{"type":"text","text":""}}"#, &mut out);
        sse.feed("content_block_delta", r#"{"index":0,"delta":{"type":"text_delta","text":"hi"}}"#, &mut out);
        sse.feed("content_block_start", r#"{"index":1,"content_block":{"type":"tool_use","id":"t1","name":"f"}}"#, &mut out);
        sse.feed("content_block_delta", r#"{"index":1,"delta":{"type":"input_json_delta","partial_json":"{\"a\"}"}}"#, &mut out);
        sse.feed("content_block_stop", r#"{"index":1}"#, &mut out);
        sse.feed("message_delta", r#"{"delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}"#, &mut out);
        sse.feed("message_stop", r#"{"type":"message_stop"}"#, &mut out);
        assert_eq!(out.len(), 6);
        assert!(matches!(out[0], StreamEvent::Start { .. }));
        assert!(matches!(out[1], StreamEvent::TextDelta { block: 0, .. }));
        assert!(matches!(out[2], StreamEvent::ToolStart { block: 1, .. }));
        assert!(matches!(out[3], StreamEvent::ToolDelta { block: 1, .. }));
        assert!(matches!(out[4], StreamEvent::BlockStop { block: 1 }));
        match &out[5] {
            StreamEvent::Finish { stop_reason, usage } => {
                assert_eq!(*stop_reason, Some(StopReason::ToolUse));
                let u = usage.unwrap();
                // 归一化语义:prompt = input(10) + cache_read(4) = 14(含缓存总输入)
                assert_eq!(u.prompt, 14);
                assert_eq!(u.cache_read, 4);
                assert_eq!(u.completion, 7);
            }
            other => panic!("期望 Finish,实际 {other:?}"),
        }
    }

    #[test]
    fn entry_sse_renders_official_sequence() {
        let mut r = EntrySse::new("claude-sonnet-4");
        let mut out = Vec::new();
        r.render(&StreamEvent::Start { model: String::new() }, &mut out);
        r.render(&StreamEvent::TextDelta { block: 0, text: "h".into() }, &mut out);
        r.render(&StreamEvent::TextDelta { block: 0, text: "i".into() }, &mut out);
        r.render(&StreamEvent::ToolStart { block: 1, id: "t1".into(), name: "f".into() }, &mut out);
        r.render(&StreamEvent::ToolDelta { block: 1, json: "{}".into() }, &mut out);
        r.render(
            &StreamEvent::Finish {
                stop_reason: Some(StopReason::ToolUse),
                usage: Some(Usage { prompt: 5, completion: 9, ..Default::default() }),
            },
            &mut out,
        );
        // message_start, text start, 2 deltas, text stop, tool start, tool delta, tool stop, message_delta, message_stop
        assert_eq!(out.len(), 10);
        assert!(out[0].starts_with("event: message_start"));
        assert!(out[1].contains("\"type\":\"text\""));
        assert!(out[4].contains("content_block_stop"));
        assert!(out[5].contains("\"type\":\"tool_use\""));
        assert!(out[7].contains("content_block_stop"));
        assert!(out[8].contains("\"output_tokens\":9"));
        assert!(out[9].starts_with("event: message_stop"));
    }

    #[test]
    fn response_json_roundtrip() {
        let raw: Value = serde_json::from_str(
            r#"{"id":"msg_1","type":"message","role":"assistant","model":"m",
            "content":[{"type":"text","text":"答"}],
            "stop_reason":"end_turn",
            "usage":{"input_tokens":8,"output_tokens":2,"cache_read_input_tokens":3}}"#,
        )
        .unwrap();
        let parsed = match parse_response_json(&raw).unwrap() {
            UpstreamBody::Ok(p) => p,
            _ => panic!("应为 Ok"),
        };
        assert_eq!(parsed.usage.cache_read, 3);
        assert_eq!(parsed.stop, Some(StopReason::EndTurn));
        let rendered = render_response_json("m", &parsed.blocks, parsed.stop, &parsed.usage);
        assert_eq!(rendered["usage"]["cache_read_input_tokens"], 3);
        assert_eq!(rendered["content"][0]["text"], "答");
    }
}
