//! OpenAI chat/completions 协议适配器:"协议 ↔ IR" 纯函数 + 流式状态机。
//! 覆盖:入口请求解析 / 上游请求渲染 / 非流式响应双向 / 上游 SSE→IR / IR→入口 SSE。

use serde_json::{json, Map, Value};

use super::ir::{
    Block, CanonicalRequest, Effort, Message, Reasoning, Role, StopReason, StreamEvent, Tool,
    ToolChoice,
};
use crate::billing::Usage;
use crate::transform::sse::{data_line, done_line};

// ---------------------------------------------------------------------------
// 入口请求解析:OpenAI chat JSON → IR
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

    let messages = obj
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "缺少 messages 数组".to_string())?;
    for m in messages {
        let role = m.get("role").and_then(Value::as_str).unwrap_or("user");
        match role {
            "system" | "developer" => {
                let blocks = parse_content(m.get("content"), &mut ir)?;
                ir.system.extend(blocks);
            }
            "user" => {
                let blocks = parse_content(m.get("content"), &mut ir)?;
                ir.messages.push(Message {
                    role: Role::User,
                    blocks,
                });
            }
            "assistant" => {
                let mut blocks = parse_content(m.get("content"), &mut ir)?;
                if let Some(tcs) = m.get("tool_calls").and_then(Value::as_array) {
                    for tc in tcs {
                        let (Some(id), Some(func)) = (
                            tc.get("id").and_then(Value::as_str),
                            tc.get("function"),
                        ) else {
                            continue;
                        };
                        let name = func.get("name").and_then(Value::as_str).unwrap_or_default();
                        let args_raw = func
                            .get("arguments")
                            .and_then(Value::as_str)
                            .unwrap_or("{}");
                        let input: Value = serde_json::from_str(args_raw)
                            .unwrap_or_else(|_| Value::String(args_raw.to_string()));
                        blocks.push(Block::ToolUse {
                            id: id.to_string(),
                            name: name.to_string(),
                            input,
                        });
                    }
                }
                ir.messages.push(Message {
                    role: Role::Assistant,
                    blocks,
                });
            }
            "tool" => {
                let content = m.get("content").map(stringify_value).unwrap_or_default();
                ir.messages.push(Message {
                    role: Role::User,
                    blocks: vec![Block::ToolResult {
                        tool_use_id: m
                            .get("tool_call_id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        content,
                        is_error: false,
                        cache_control: None,
                    }],
                });
            }
            _ => ir.push_dropped(&format!("message.role:{role}")),
        }
    }

    if let Some(tools) = obj.get("tools").and_then(Value::as_array) {
        for t in tools {
            let func = match t.get("function") {
                Some(f) => f,
                None => {
                    ir.push_dropped("tools[type!=function]");
                    continue;
                }
            };
            ir.tools.push(Tool {
                name: func
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                description: func
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                input_schema: func.get("parameters").cloned().unwrap_or_else(|| json!({})),
            });
        }
    }

    ir.tool_choice = parse_tool_choice(obj.get("tool_choice"), &mut ir);
    ir.max_tokens = obj
        .get("max_tokens")
        .and_then(Value::as_i64)
        .or_else(|| obj.get("max_completion_tokens").and_then(Value::as_i64));
    ir.temperature = obj.get("temperature").and_then(Value::as_f64);
    ir.top_p = obj.get("top_p").and_then(Value::as_f64);
    if let Some(stop) = obj.get("stop") {
        match stop {
            Value::String(s) => ir.stop.push(s.clone()),
            Value::Array(a) => {
                for s in a.iter().filter_map(Value::as_str) {
                    ir.stop.push(s.to_string());
                }
            }
            _ => {}
        }
    }
    if let Some(effort) = obj
        .get("reasoning_effort")
        .and_then(Value::as_str)
        .and_then(CanonicalRequest::effort_of)
    {
        ir.reasoning = Some(Reasoning::Effort(effort));
    }

    // 跨协议转换无法表达的字段:安全丢弃并记录
    for f in [
        "frequency_penalty",
        "presence_penalty",
        "logit_bias",
        "logprobs",
        "top_logprobs",
        "response_format",
        "seed",
        "n",
        "parallel_tool_calls",
        "stream_options",
        "service_tier",
        "user",
        "metadata",
    ] {
        if obj.contains_key(f) {
            ir.push_dropped(f);
        }
    }
    Ok(ir)
}

fn parse_tool_choice(v: Option<&Value>, ir: &mut CanonicalRequest) -> Option<ToolChoice> {
    match v? {
        Value::String(s) => match s.as_str() {
            "auto" => Some(ToolChoice::Auto),
            "none" => Some(ToolChoice::None),
            "required" => Some(ToolChoice::Any),
            other => {
                ir.push_dropped("tool_choice");
                let _ = other;
                None
            }
        },
        Value::Object(o) => {
            let name = o
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(Value::as_str);
            name.map(|n| ToolChoice::Tool(n.to_string()))
        }
        _ => None,
    }
}

/// content 字段:string | parts 数组;图片仅支持 data URI(base64)
fn parse_content(v: Option<&Value>, ir: &mut CanonicalRequest) -> Result<Vec<Block>, String> {
    let Some(v) = v else {
        return Ok(vec![]);
    };
    match v {
        Value::Null => Ok(vec![]),
        Value::String(s) => Ok(vec![Block::Text {
            text: s.clone(),
            cache_control: None,
        }]),
        Value::Array(parts) => {
            let mut blocks = Vec::new();
            for p in parts {
                match p.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        blocks.push(Block::Text {
                            text: p
                                .get("text")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                            cache_control: None,
                        });
                    }
                    Some("image_url") => {
                        let url = p
                            .get("image_url")
                            .and_then(|i| i.get("url"))
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        match parse_data_uri(url) {
                            Some((mime, data)) => blocks.push(Block::Image {
                                media_type: mime,
                                data_b64: data,
                                cache_control: None,
                            }),
                            None => ir.push_dropped("image_url(http)"),
                        }
                    }
                    _ => ir.push_dropped("content part"),
                }
            }
            Ok(blocks)
        }
        _ => Err("content 字段类型无效".to_string()),
    }
}

pub fn parse_data_uri(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    let mime = meta.strip_suffix(";base64")?;
    Some((mime.to_string(), data.to_string()))
}

fn stringify_value(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

// ---------------------------------------------------------------------------
// 上游请求渲染:IR → OpenAI chat JSON(给 OpenAI 兼容上游)
// ---------------------------------------------------------------------------

fn push_drop(dropped: &mut Vec<String>, field: &str) {
    if !dropped.iter().any(|d| d == field) {
        dropped.push(field.to_string());
    }
}

pub fn render_request(ir: &CanonicalRequest) -> (Value, Vec<String>) {
    let mut dropped: Vec<String> = Vec::new();
    let mut messages: Vec<Value> = Vec::new();

    // system(仅文本;图片/缓存控制无法表达)
    let sys_text: Vec<&str> = ir
        .system
        .iter()
        .filter_map(|b| match b {
            Block::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    if ir.system.iter().any(|b| !matches!(b, Block::Text { .. })) {
        push_drop(&mut dropped, "system(cache_control/image)");
    }
    if !sys_text.is_empty() {
        messages.push(json!({"role": "system", "content": sys_text.join("\n\n")}));
    }

    for m in &ir.messages {
        match m.role {
            Role::User => {
                // 保持块原顺序:ToolResult 就地输出为 tool 消息,其余聚合为 user 消息
                let mut others: Vec<Block> = Vec::new();
                for b in &m.blocks {
                    if let Block::ToolResult { tool_use_id, content, .. } = b {
                        if !others.is_empty() {
                            messages.push(json!({
                                "role": "user",
                                "content": render_openai_content(&others, &mut dropped),
                            }));
                            others.clear();
                        }
                        messages.push(json!({
                            "role": "tool",
                            "tool_call_id": tool_use_id,
                            "content": content,
                        }));
                    } else {
                        others.push(b.clone());
                    }
                }
                if !others.is_empty() {
                    messages.push(json!({
                        "role": "user",
                        "content": render_openai_content(&others, &mut dropped),
                    }));
                }
            }
            Role::Assistant => {
                let text: Vec<String> = m
                    .blocks
                    .iter()
                    .filter_map(|b| match b {
                        Block::Text { text, .. } => Some(text.clone()),
                        Block::Thinking { .. } => None,
                        _ => None,
                    })
                    .collect();
                let tool_calls: Vec<Value> = m
                    .blocks
                    .iter()
                    .filter_map(|b| match b {
                        Block::ToolUse { id, name, input } => Some(json!({
                            "id": id,
                            "type": "function",
                            "function": {"name": name, "arguments": input.to_string()},
                        })),
                        _ => None,
                    })
                    .collect();
                let has_thinking = m
                    .blocks
                    .iter()
                    .any(|b| matches!(b, Block::Thinking { .. }));
                if has_thinking {
                    push_drop(&mut dropped, "thinking");
                }
                let content = if text.is_empty() {
                    Value::Null
                } else {
                    Value::String(text.join("\n"))
                };
                if tool_calls.is_empty() {
                    messages.push(json!({"role": "assistant", "content": content}));
                } else {
                    messages.push(json!({
                        "role": "assistant",
                        "content": content,
                        "tool_calls": tool_calls,
                    }));
                }
            }
        }
    }

    let mut obj = Map::new();
    obj.insert("model".into(), json!(ir.model));
    obj.insert("messages".into(), Value::Array(messages));
    if !ir.tools.is_empty() {
        obj.insert(
            "tools".into(),
            Value::Array(
                ir.tools
                    .iter()
                    .map(|t| {
                        json!({
                            "type": "function",
                            "function": {
                                "name": t.name,
                                "description": t.description,
                                "parameters": t.input_schema,
                            },
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
                ToolChoice::Auto => json!("auto"),
                ToolChoice::None => json!("none"),
                ToolChoice::Any => json!("required"),
                ToolChoice::Tool(n) => json!({"type": "function", "function": {"name": n}}),
            },
        );
    }
    if let Some(mt) = ir.max_tokens {
        obj.insert("max_tokens".into(), json!(mt));
    }
    if let Some(t) = ir.temperature {
        obj.insert("temperature".into(), json!(t));
    }
    if let Some(t) = ir.top_p {
        obj.insert("top_p".into(), json!(t));
    }
    if ir.stream {
        obj.insert("stream".into(), json!(true));
    }
    match ir.stop.len() {
        0 => {}
        1 => {
            obj.insert("stop".into(), json!(ir.stop[0]));
        }
        _ => {
            obj.insert("stop".into(), json!(ir.stop));
        }
    };
    if let Some(Reasoning::Effort(e)) = ir.reasoning {
        if e != Effort::Minimal {
            obj.insert("reasoning_effort".into(), json!(ir.effort_str().unwrap()));
        }
    }
    if matches!(ir.reasoning, Some(Reasoning::Budget(_))) {
        push_drop(&mut dropped, "thinking.budget_tokens");
    }
    dropped.extend(ir.dropped_fields.iter().cloned());
    (Value::Object(obj), dropped)
}

fn render_openai_content(blocks: &[Block], dropped: &mut Vec<String>) -> Value {
    let mut texts = Vec::new();
    let mut images = Vec::new();
    for b in blocks {
        match b {
            Block::Text { text, .. } => texts.push(text.clone()),
            Block::Image {
                media_type,
                data_b64,
                ..
            } => images.push(json!({
                "type": "image_url",
                "image_url": {"url": format!("data:{media_type};base64,{data_b64}")},
            })),
            _ => {}
        }
    }
    if blocks.iter().any(|b| matches!(b, Block::ToolResult { .. })) {
        push_drop(dropped, "tool_result");
    }
    if images.is_empty() {
        Value::String(texts.join("\n"))
    } else {
        let mut parts: Vec<Value> = texts
            .into_iter()
            .map(|t| json!({"type": "text", "text": t}))
            .collect();
        parts.extend(images);
        Value::Array(parts)
    }
}

// ---------------------------------------------------------------------------
// 非流式响应:OpenAI JSON ↔ IR
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

pub fn parse_response_json(v: &Value) -> Result<UpstreamBody, String> {
    if let Some(err) = v.get("error") {
        let msg = err
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| err.to_string());
        return Ok(UpstreamBody::Err(msg));
    }
    let choice = v
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .ok_or_else(|| "响应缺少 choices".to_string())?;
    let message = choice.get("message").cloned().unwrap_or(Value::Null);

    let mut blocks = Vec::new();
    if let Some(text) = message.get("content").and_then(Value::as_str) {
        if !text.is_empty() {
            blocks.push(Block::Text {
                text: text.to_string(),
                cache_control: None,
            });
        }
    }
    if let Some(rc) = message.get("reasoning_content").and_then(Value::as_str) {
        if !rc.is_empty() {
            blocks.push(Block::Thinking {
                text: rc.to_string(),
                signature: None,
            });
        }
    }
    if let Some(tcs) = message.get("tool_calls").and_then(Value::as_array) {
        for tc in tcs {
            let func = tc.get("function").cloned().unwrap_or(Value::Null);
            let args_raw = func
                .get("arguments")
                .and_then(Value::as_str)
                .unwrap_or("{}");
            blocks.push(Block::ToolUse {
                id: tc
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                name: func
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                input: serde_json::from_str(args_raw)
                    .unwrap_or_else(|_| Value::String(args_raw.to_string())),
            });
        }
    }
    let stop = choice
        .get("finish_reason")
        .and_then(Value::as_str)
        .map(parse_finish);
    let usage = v
        .get("usage")
        .map(parse_usage)
        .unwrap_or_default();
    Ok(UpstreamBody::Ok(ParsedResponse {
        blocks,
        stop,
        usage,
    }))
}

pub fn render_response_json(model: &str, blocks: &[Block], stop: Option<StopReason>, usage: &Usage) -> Value {
    let mut text_parts = Vec::new();
    let mut tool_calls = Vec::new();
    let mut reasoning = String::new();
    for b in blocks {
        match b {
            Block::Text { text, .. } => text_parts.push(text.clone()),
            Block::ToolUse { id, name, input } => tool_calls.push(json!({
                "id": id, "type": "function",
                "function": {"name": name, "arguments": input.to_string()},
            })),
            Block::Thinking { text, .. } => reasoning.push_str(text),
            _ => {}
        }
    }
    let mut message = Map::new();
    message.insert("role".into(), json!("assistant"));
    message.insert(
        "content".into(),
        if text_parts.is_empty() {
            Value::Null
        } else {
            json!(text_parts.join(""))
        },
    );
    if !reasoning.is_empty() {
        message.insert("reasoning_content".into(), json!(reasoning));
    }
    if !tool_calls.is_empty() {
        message.insert("tool_calls".into(), Value::Array(tool_calls));
    }
    json!({
        "id": format!("chatcmpl-gw{}", crate::util::rand_hex(24)),
        "object": "chat.completion",
        "created": crate::util::now_ms() / 1000,
        "model": model,
        "choices": [{
            "index": 0,
            "message": Value::Object(message),
            "finish_reason": stop.map(render_finish),
        }],
        "usage": {
            "prompt_tokens": usage.prompt,
            "completion_tokens": usage.completion,
            "total_tokens": usage.prompt + usage.completion,
        },
    })
}

pub fn parse_finish(s: &str) -> StopReason {
    match s {
        "length" => StopReason::MaxTokens,
        "tool_calls" | "function" => StopReason::ToolUse,
        "stop_sequence" => StopReason::StopSequence,
        "stop" | "end_turn" => StopReason::EndTurn,
        _ => StopReason::Other,
    }
}

pub fn render_finish(sr: StopReason) -> &'static str {
    match sr {
        StopReason::MaxTokens => "length",
        StopReason::ToolUse => "tool_calls",
        StopReason::StopSequence => "stop_sequence",
        StopReason::EndTurn | StopReason::Other => "stop",
    }
}

pub fn parse_usage(u: &Value) -> Usage {
    Usage {
        prompt: u.get("prompt_tokens").and_then(Value::as_i64).unwrap_or(0),
        completion: u.get("completion_tokens").and_then(Value::as_i64).unwrap_or(0),
        cache_read: u
            .get("prompt_tokens_details")
            .and_then(|d| d.get("cached_tokens"))
            .and_then(Value::as_i64)
            .unwrap_or(0),
        cache_write: 0,
    }
}

// ---------------------------------------------------------------------------
// 流式:OpenAI 兼容上游 SSE → IR 事件
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct UpstreamSse {
    tool_block_of_index: std::collections::HashMap<i64, usize>,
    started_tools: std::collections::HashSet<usize>,
    next_block: usize,
    started: bool,
    stop: Option<StopReason>,
    usage: Option<Usage>,
    saw_finish: bool,
    finished: bool,
}

impl UpstreamSse {
    pub fn feed(&mut self, data: &str, out: &mut Vec<StreamEvent>) {
        if self.finished {
            return;
        }
        let t = data.trim();
        if t == "[DONE]" {
            self.force_finish(out);
            return;
        }
        let Ok(v) = serde_json::from_str::<Value>(t) else {
            return;
        };
        if !self.started {
            self.started = true;
            out.push(StreamEvent::Start {
                model: v.get("model").and_then(Value::as_str).unwrap_or_default().to_string(),
            });
        }
        if let Some(u) = v.get("usage").filter(|u| !u.is_null()) {
            self.usage = Some(parse_usage(u));
        }
        let Some(choice) = v
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
        else {
            // 流内错误对象(部分上游以 data: {"error":...} 推送)
            if let Some(e) = v.get("error") {
                self.finished = true;
                out.push(StreamEvent::UpstreamError {
                    message: e
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("上游返回错误")
                        .to_string(),
                });
                return;
            }
            // 纯 usage 尾块:若 finish_reason 已见过则收尾
            if self.saw_finish {
                self.force_finish(out);
            }
            return;
        };
        if let Some(fr) = choice.get("finish_reason") {
            if !fr.is_null() {
                self.stop = Some(parse_finish(fr.as_str().unwrap_or_default()));
                self.saw_finish = true;
            }
        }
        if let Some(delta) = choice.get("delta") {
            if let Some(text) = delta.get("content").and_then(Value::as_str) {
                if !text.is_empty() {
                    out.push(StreamEvent::TextDelta { block: 0, text: text.to_string() });
                }
            }
            if let Some(rc) = delta.get("reasoning_content").and_then(Value::as_str) {
                if !rc.is_empty() {
                    out.push(StreamEvent::ReasoningDelta { text: rc.to_string() });
                }
            }
            if let Some(tcs) = delta.get("tool_calls").and_then(Value::as_array) {
                for tc in tcs {
                    let idx = tc.get("index").and_then(Value::as_i64).unwrap_or(0);
                    let block = match self.tool_block_of_index.get(&idx) {
                        Some(b) => *b,
                        None => {
                            let b = self.next_block.max(1);
                            self.next_block = b + 1;
                            self.tool_block_of_index.insert(idx, b);
                            b
                        }
                    };
                    let func = tc.get("function").cloned().unwrap_or(Value::Null);
                    if !self.started_tools.contains(&block) {
                        self.started_tools.insert(block);
                        out.push(StreamEvent::ToolStart {
                            block,
                            id: tc
                                .get("id")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                            name: func
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                        });
                    }
                    if let Some(args) = func.get("arguments").and_then(Value::as_str) {
                        if !args.is_empty() {
                            out.push(StreamEvent::ToolDelta {
                                block,
                                json: args.to_string(),
                            });
                        }
                    }
                }
            }
        }
        // finish_reason + usage 都已到达即可收尾(不等 [DONE],部分上游不发)
        if self.saw_finish && self.usage.is_some() {
            self.force_finish(out);
        }
    }

    pub fn is_finished(&self) -> bool {
        self.finished
    }

    /// 上游未发 [DONE] 即断流时,用已收集的 stop/usage 合成收尾事件
    pub fn force_finish(&mut self, out: &mut Vec<StreamEvent>) {
        if self.finished {
            return;
        }
        self.finished = true;
        out.push(StreamEvent::Finish {
            stop_reason: self.stop,
            usage: self.usage.take(),
        });
    }
}

// ---------------------------------------------------------------------------
// 流式:IR 事件 → OpenAI 入口 SSE
// ---------------------------------------------------------------------------

pub struct EntrySse {
    id: String,
    created: i64,
    model: String,
    finished: bool,
}

impl EntrySse {
    pub fn new(model: &str) -> Self {
        Self {
            id: format!("chatcmpl-gw{}", crate::util::rand_hex(24)),
            created: crate::util::now_ms() / 1000,
            model: model.to_string(),
            finished: false,
        }
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
                out.push(data_line(
                    &self.chunk(json!({"role": "assistant", "content": ""}), Value::Null),
                ));
            }
            StreamEvent::TextDelta { text, .. } => {
                out.push(data_line(
                    &self.chunk(json!({"content": text}), Value::Null),
                ));
            }
            StreamEvent::ReasoningDelta { text } => {
                out.push(data_line(
                    &self.chunk(json!({"reasoning_content": text}), Value::Null),
                ));
            }
            StreamEvent::ToolStart { block, id, name } => {
                out.push(data_line(&self.chunk(
                    json!({"tool_calls": [{"index": block.saturating_sub(1), "id": id, "type": "function", "function": {"name": name, "arguments": ""}}]}),
                    Value::Null,
                )));
            }
            StreamEvent::ToolDelta { block, json } => {
                out.push(data_line(&self.chunk(
                    json!({"tool_calls": [{"index": block.saturating_sub(1), "function": {"arguments": json}}]}),
                    Value::Null,
                )));
            }
            StreamEvent::BlockStop { .. } => {}
            StreamEvent::Finish { stop_reason, usage } => {
                let mut usage_json = Value::Null;
                if let Some(u) = usage {
                    usage_json = json!({
                        "prompt_tokens": u.prompt,
                        "completion_tokens": u.completion,
                        "total_tokens": u.prompt + u.completion,
                    });
                }
                out.push(data_line(&self.chunk(
                    json!({}),
                    json!(stop_reason.map(render_finish)),
                )));
                // 官方实现把 usage 放在带 finish_reason 的最后一块;一并补发 usage 块增强兼容
                if !usage_json.is_null() {
                    let mut c: Value =
                        serde_json::from_str(&self.chunk(json!({}), json!("stop"))).unwrap();
                    c["usage"] = usage_json;
                    c["choices"] = json!([]);
                    out.push(data_line(&c.to_string()));
                }
                out.push(done_line());
                self.finished = true;
            }
            StreamEvent::UpstreamError { .. } => {}
        }
    }

    fn chunk(&self, delta: Value, finish_reason: Value) -> String {
        json!({
            "id": self.id,
            "object": "chat.completion.chunk",
            "created": self.created,
            "model": self.model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
        })
        .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transform::sse::SseParser;

    #[test]
    fn parse_request_full() {
        let body: Value = serde_json::from_str(
            r#"{
            "model": "gpt-4o", "stream": true, "temperature": 0.7, "top_p": 0.9,
            "max_tokens": 1024, "stop": ["END"], "reasoning_effort": "high",
            "frequency_penalty": 0.5,
            "tool_choice": "auto",
            "tools": [{"type":"function","function":{"name":"get_weather","description":"查天气","parameters":{"type":"object","properties":{"city":{"type":"string"}}}}}],
            "messages": [
                {"role":"system","content":"你是助手"},
                {"role":"user","content":"北京天气如何"},
                {"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"北京\"}"}}]},
                {"role":"tool","tool_call_id":"call_1","content":"晴 25 度"}
            ]
        }"#,
        )
        .unwrap();
        let ir = parse_request(&body).unwrap();
        assert_eq!(ir.model, "gpt-4o");
        assert!(ir.stream);
        assert_eq!(ir.max_tokens, Some(1024));
        assert_eq!(ir.temperature, Some(0.7));
        assert_eq!(ir.stop, vec!["END".to_string()]);
        assert_eq!(
            ir.reasoning,
            Some(Reasoning::Effort(Effort::High))
        );
        assert_eq!(ir.tools.len(), 1);
        assert_eq!(ir.tools[0].name, "get_weather");
        assert!(matches!(ir.tool_choice, Some(ToolChoice::Auto)));
        assert_eq!(ir.system.len(), 1);
        assert_eq!(ir.messages.len(), 3);
        assert!(matches!(ir.messages[0].blocks[0], Block::Text { .. }));
        assert!(matches!(ir.messages[1].blocks[0], Block::ToolUse { .. }));
        assert!(matches!(ir.messages[2].blocks[0], Block::ToolResult { .. }));
        assert!(ir.dropped_fields.iter().any(|f| f == "frequency_penalty"));
    }

    #[test]
    fn parse_request_image_data_uri() {
        let body: Value = serde_json::from_str(
            r#"{"model":"m","messages":[{"role":"user","content":[
            {"type":"text","text":"看图"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}}]}]}"#,
        )
        .unwrap();
        let ir = parse_request(&body).unwrap();
        assert!(matches!(ir.messages[0].blocks[1], Block::Image { .. }));
    }

    #[test]
    fn render_request_roundtrip() {
        let body: Value = serde_json::from_str(
            r#"{"model":"m","messages":[
            {"role":"system","content":"s"},
            {"role":"user","content":"u"},
            {"role":"assistant","tool_calls":[{"id":"c1","type":"function","function":{"name":"f","arguments":"{\"a\":1}"}}]},
            {"role":"tool","tool_call_id":"c1","content":"r"}]}"#,
        )
        .unwrap();
        let ir = parse_request(&body).unwrap();
        let (rendered, dropped) = render_request(&ir);
        let msgs = rendered["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[1]["role"], "user");
        assert_eq!(msgs[2]["tool_calls"][0]["id"], "c1");
        assert_eq!(msgs[3]["tool_call_id"], "c1");
        assert!(dropped.is_empty());
    }

    #[test]
    fn upstream_sse_to_ir_events() {
        let mut sse = UpstreamSse::default();
        let mut out = Vec::new();
        sse.feed(r#"{"choices":[{"delta":{"role":"assistant","content":"你"}}]}"#, &mut out);
        sse.feed(r#"{"choices":[{"delta":{"content":"好"}}]}"#, &mut out);
        sse.feed(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"f","arguments":"{\"a"}}]}}]}"#,
            &mut out,
        );
        sse.feed(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]}}]}"#,
            &mut out,
        );
        sse.feed(r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#, &mut out);
        sse.feed(r#"{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":3}}}"#, &mut out);
        assert_eq!(out.len(), 7);
        assert!(matches!(out[0], StreamEvent::Start { .. }));
        assert!(matches!(out[1], StreamEvent::TextDelta { block: 0, .. }));
        assert!(matches!(
            out[3],
            StreamEvent::ToolStart { block: 1, .. }
        ));
        assert!(matches!(out[4], StreamEvent::ToolDelta { block: 1, .. }));
        match &out[6] {
            StreamEvent::Finish { stop_reason, usage } => {
                assert_eq!(*stop_reason, Some(StopReason::ToolUse));
                let u = usage.unwrap();
                assert_eq!(u.prompt, 10);
                assert_eq!(u.completion, 5);
                assert_eq!(u.cache_read, 3);
            }
            other => panic!("期望 Finish,实际 {other:?}"),
        }
        assert!(sse.is_finished());
    }

    #[test]
    fn upstream_sse_done_without_usage() {
        let mut sse = UpstreamSse::default();
        let mut out = Vec::new();
        sse.feed(r#"{"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}"#, &mut out);
        sse.feed("[DONE]", &mut out);
        assert!(matches!(out.last(), Some(StreamEvent::Finish { stop_reason: Some(StopReason::EndTurn), usage: None })));
    }

    #[test]
    fn entry_sse_sequence() {
        let mut r = EntrySse::new("gpt-4o");
        let mut out = Vec::new();
        r.render(&StreamEvent::Start { model: String::new() }, &mut out);
        r.render(&StreamEvent::TextDelta { block: 0, text: "hi".into() }, &mut out);
        r.render(
            &StreamEvent::Finish {
                stop_reason: Some(StopReason::EndTurn),
                usage: Some(Usage { prompt: 3, completion: 1, ..Default::default() }),
            },
            &mut out,
        );
        // 官方收尾序列:finish_reason 块 → 独立 usage 块(choices 为空)→ [DONE]
        assert_eq!(out.len(), 5);
        assert!(out[0].starts_with("data: {"));
        assert!(out[2].contains("\"finish_reason\":\"stop\""));
        assert!(out[3].contains("\"prompt_tokens\":3") && out[3].contains("\"choices\":[]"));
    }

    #[test]
    fn response_json_roundtrip() {
        let raw: Value = serde_json::from_str(
            r#"{"id":"x","choices":[{"index":0,"message":{"role":"assistant","content":"答案","tool_calls":[{"id":"c1","type":"function","function":{"name":"f","arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":7,"completion_tokens":4}}"#,
        )
        .unwrap();
        let parsed = match parse_response_json(&raw).unwrap() {
            UpstreamBody::Ok(p) => p,
            _ => panic!("应为 Ok"),
        };
        assert_eq!(parsed.blocks.len(), 2);
        assert_eq!(parsed.stop, Some(StopReason::ToolUse));
        assert_eq!(parsed.usage.prompt, 7);
        let rendered = render_response_json("m", &parsed.blocks, parsed.stop, &parsed.usage);
        assert_eq!(rendered["choices"][0]["finish_reason"], "tool_calls");
        assert_eq!(rendered["choices"][0]["message"]["content"], "答案");
        assert_eq!(rendered["usage"]["prompt_tokens"], 7);
    }

    #[test]
    fn upstream_error_body_detected() {
        let raw: Value =
            serde_json::from_str(r#"{"error":{"message":"余额不足","type":"insufficient_quota"}}"#)
                .unwrap();
        match parse_response_json(&raw).unwrap() {
            UpstreamBody::Err(msg) => assert_eq!(msg, "余额不足"),
            _ => panic!("应为 Err"),
        }
    }

    #[test]
    fn sse_parser_feeds_upstream_state_machine() {
        let mut parser = SseParser::default();
        let mut sse = UpstreamSse::default();
        let mut events = Vec::new();
        let mut sse_out = Vec::new();
        parser.feed(
            b"data: {\"choices\":[{\"delta\":{\"content\":\"A\"}}]}\n\ndata: [DONE]\n\n",
            &mut sse_out,
        );
        for ev in sse_out {
            sse.feed(&ev.data, &mut events);
        }
        assert_eq!(events.len(), 3);
        assert!(matches!(events[0], StreamEvent::Start { .. }));
        assert!(matches!(events[2], StreamEvent::Finish { .. }));
    }
}
