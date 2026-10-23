//! OpenAI Responses API 适配器(Codex CLI 默认线协议)。
//! 无状态实现:store 恒按 false 处理;previous_response_id 依赖进程内 LRU(PRD 决策 14)。
//! 出站 SSE 合成完整官方事件序列(sequence_number 严格递增)。

use serde_json::{json, Value};

use super::ir::{
    Block, CanonicalRequest, Message, Reasoning, Role, StreamEvent, Tool, ToolChoice,
};
use crate::billing::Usage;
use crate::transform::sse::data_line;

// ---------------------------------------------------------------------------
// previous_response_id 进程内 LRU(容量 500,重启清空 → 400 提示携带完整 input)
// ---------------------------------------------------------------------------

pub struct StoredResponse {
    /// 本次请求的完整输入消息(含此前拼接)
    pub context: Vec<Message>,
    /// 本次输出的内容块
    pub output_blocks: Vec<Block>,
}

pub struct ResponseStore {
    inner: std::sync::Mutex<(
        std::collections::HashMap<String, StoredResponse>,
        std::collections::VecDeque<String>,
    )>,
}

impl Default for ResponseStore {
    fn default() -> Self {
        Self {
            inner: std::sync::Mutex::new((Default::default(), Default::default())),
        }
    }
}

impl ResponseStore {
    pub fn get(&self, id: &str) -> Option<StoredResponse> {
        let mut g = self.inner.lock().unwrap();
        let (map, order) = &mut *g;
        let stored = map.remove(id)?;
        if let Some(pos) = order.iter().position(|x| x == id) {
            order.remove(pos);
        }
        order.push_back(id.to_string());
        Some(stored)
    }

    pub fn put(&self, id: &str, stored: StoredResponse) {
        let mut g = self.inner.lock().unwrap();
        let (map, order) = &mut *g;
        if map.insert(id.to_string(), stored).is_none() {
            order.push_back(id.to_string());
        }
        const CAP: usize = 500;
        while order.len() > CAP {
            if let Some(old) = order.pop_front() {
                map.remove(&old);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 入口请求解析:Responses JSON → IR
// ---------------------------------------------------------------------------

/// 返回 (IR, previous_response_id)
pub fn parse_request(v: &Value) -> Result<(CanonicalRequest, Option<String>), String> {
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
    let previous_response_id = obj
        .get("previous_response_id")
        .and_then(Value::as_str)
        .map(str::to_string);

    let mut ir = CanonicalRequest {
        model,
        stream,
        ..Default::default()
    };

    if let Some(instr) = obj.get("instructions").and_then(Value::as_str) {
        if !instr.is_empty() {
            ir.system.push(Block::Text {
                text: instr.to_string(),
                cache_control: None,
            });
        }
    }

    match obj.get("input") {
        Some(Value::String(s)) => ir.messages.push(Message {
            role: Role::User,
            blocks: vec![Block::Text {
                text: s.clone(),
                cache_control: None,
            }],
        }),
        Some(Value::Array(items)) => {
            for item in items {
                parse_input_item(item, &mut ir)?;
            }
        }
        _ => return Err("缺少 input 字段".to_string()),
    }

    if let Some(tools) = obj.get("tools").and_then(Value::as_array) {
        for t in tools {
            if t.get("type").and_then(Value::as_str) != Some("function") {
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
                input_schema: t.get("parameters").cloned().unwrap_or_else(|| json!({})),
            });
        }
    }
    if let Some(tc) = obj.get("tool_choice") {
        ir.tool_choice = match tc {
            Value::String(s) => match s.as_str() {
                "auto" => Some(ToolChoice::Auto),
                "none" => Some(ToolChoice::None),
                "required" => Some(ToolChoice::Any),
                _ => None,
            },
            Value::Object(o) => o
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(Value::as_str)
                .map(|n| ToolChoice::Tool(n.to_string())),
            _ => None,
        };
    }

    ir.max_tokens = obj.get("max_output_tokens").and_then(Value::as_i64);
    ir.temperature = obj.get("temperature").and_then(Value::as_f64);
    ir.top_p = obj.get("top_p").and_then(Value::as_f64);
    if let Some(effort) = obj
        .get("reasoning")
        .and_then(|r| r.get("effort"))
        .and_then(Value::as_str)
        .and_then(CanonicalRequest::effort_of)
    {
        ir.reasoning = Some(Reasoning::Effort(effort));
    }

    for f in [
        "store",
        "include",
        "parallel_tool_calls",
        "metadata",
        "text",
        "truncation",
        "prompt_cache_key",
        "service_tier",
        "background",
    ] {
        if obj.contains_key(f) {
            ir.push_dropped(f);
        }
    }
    Ok((ir, previous_response_id))
}

fn parse_input_item(item: &Value, ir: &mut CanonicalRequest) -> Result<(), String> {
    let ty = item.get("type").and_then(Value::as_str);
    match ty {
        // message / 缺省 type 均按 message 处理(官方 SDK 有时不带 type)
        Some("message") | None => {
            let role = item.get("role").and_then(Value::as_str).unwrap_or("user");
            let mut blocks = Vec::new();
            match item.get("content") {
                Some(Value::String(s)) => blocks.push(Block::Text {
                    text: s.clone(),
                    cache_control: None,
                }),
                Some(Value::Array(parts)) => {
                    for p in parts {
                        match p.get("type").and_then(Value::as_str) {
                            Some("input_text") | Some("output_text") => {
                                blocks.push(Block::Text {
                                    text: p
                                        .get("text")
                                        .and_then(Value::as_str)
                                        .unwrap_or_default()
                                        .to_string(),
                                    cache_control: None,
                                });
                            }
                            Some("input_image") => {
                                let url = p
                                    .get("image_url")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default();
                                match super::openai_chat::parse_data_uri(url) {
                                    Some((mime, data)) => blocks.push(Block::Image {
                                        media_type: mime,
                                        data_b64: data,
                                        cache_control: None,
                                    }),
                                    None => ir.push_dropped("input_image(url)"),
                                }
                            }
                            Some("refusal") | Some("input_audio") => ir.push_dropped("content part"),
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
            match role {
                "system" | "developer" => {
                    let mut moved = Message {
                        role: Role::User,
                        blocks,
                    };
                    ir.system.append(&mut moved.blocks);
                }
                "assistant" => ir.messages.push(Message {
                    role: Role::Assistant,
                    blocks,
                }),
                _ => ir.messages.push(Message {
                    role: Role::User,
                    blocks,
                }),
            }
        }
        Some("function_call") => {
            let call_id = item
                .get("call_id")
                .or_else(|| item.get("id"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let args_raw = item.get("arguments").and_then(Value::as_str).unwrap_or("{}");
            ir.messages.push(Message {
                role: Role::Assistant,
                blocks: vec![Block::ToolUse {
                    id: call_id,
                    name: item
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    input: serde_json::from_str(args_raw)
                        .unwrap_or_else(|_| Value::String(args_raw.to_string())),
                }],
            });
        }
        Some("function_call_output") => {
            let output = match item.get("output") {
                Some(Value::String(s)) => s.clone(),
                Some(other) => other.to_string(),
                None => String::new(),
            };
            ir.messages.push(Message {
                role: Role::User,
                blocks: vec![Block::ToolResult {
                    tool_use_id: item
                        .get("call_id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    content: output,
                    is_error: false,
                    cache_control: None,
                }],
            });
        }
        // 历史 reasoning(含 encrypted_content):跨协议转发无法使用,丢弃并记录
        Some("reasoning") => ir.push_dropped("input.reasoning"),
        Some("item_reference") => ir.push_dropped("input.item_reference"),
        Some(other) => ir.push_dropped(&format!("input.{other}")),
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 非流式响应:IR → Responses 对象
// ---------------------------------------------------------------------------

pub fn render_response_json(
    response_id: &str,
    model: &str,
    blocks: &[Block],
    usage: &Usage,
) -> Value {
    let output = blocks_to_output_items(response_id, blocks);
    json!({
        "id": response_id,
        "object": "response",
        "created_at": crate::util::now_ms() / 1000,
        "status": "completed",
        "model": model,
        "output": output,
        "usage": {
            "input_tokens": usage.prompt,
            "output_tokens": usage.completion,
            "total_tokens": usage.prompt + usage.completion,
            "input_tokens_details": {"cached_tokens": usage.cache_read},
        },
        "parallel_tool_calls": true,
    })
}

pub fn blocks_to_output_items(id_seed: &str, blocks: &[Block]) -> Vec<Value> {
    let mut output: Vec<Value> = Vec::new();
    let mut text_acc = String::new();
    let mut text_open = false;
    for b in blocks {
        match b {
            Block::Text { text, .. } => {
                text_acc.push_str(text);
                text_open = true;
            }
            Block::ToolUse { id, name, input } => {
                if text_open {
                    output.push(json!({
                        "id": format!("msg_{id_seed}_{}", output.len()),
                        "type": "message",
                        "status": "completed",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": text_acc.clone(), "annotations": []}],
                    }));
                    text_acc.clear();
                    text_open = false;
                }
                output.push(json!({
                    "id": format!("fc_{id_seed}_{}", output.len()),
                    "type": "function_call",
                    "status": "completed",
                    "call_id": id,
                    "name": name,
                    "arguments": input.to_string(),
                }));
            }
            _ => {} // 历史 reasoning 不回放
        }
    }
    if text_open {
        output.push(json!({
            "id": format!("msg_{id_seed}_{}", output.len()),
            "type": "message",
            "status": "completed",
            "role": "assistant",
            "content": [{"type": "output_text", "text": text_acc, "annotations": []}],
        }));
    }
    output
}

// ---------------------------------------------------------------------------
// 流式:IR 事件 → Responses 官方 SSE 事件序列
// ---------------------------------------------------------------------------

enum CurrentItem {
    None,
    Message {
        item_id: String,
        output_index: usize,
        text: String,
        part_open: bool,
    },
    FunctionCall {
        item_id: String,
        output_index: usize,
        call_id: String,
        name: String,
        args: String,
    },
}

pub struct EntrySse {
    response_id: String,
    model: String,
    seq: u64,
    output_index: usize,
    current: CurrentItem,
    items: Vec<Value>,
    finished: bool,
}

impl EntrySse {
    pub fn new(model: &str) -> Self {
        Self::with_id(format!("resp_gw{}", crate::util::rand_hex(24)), model)
    }

    /// 流式场景由 relay 层统一生成 response id(供 previous_response_id 链)
    pub fn with_id(response_id: String, model: &str) -> Self {
        Self {
            response_id,
            model: model.to_string(),
            seq: 0,
            output_index: 0,
            current: CurrentItem::None,
            items: Vec::new(),
            finished: false,
        }
    }

    pub fn response_id(&self) -> &str {
        &self.response_id
    }

    fn next_seq(&mut self) -> u64 {
        self.seq += 1;
        self.seq
    }

    fn event(&mut self, name: &str, mut body: Value) -> String {
        if let Some(o) = body.as_object_mut() {
            o.insert("type".into(), json!(name));
            o.insert("sequence_number".into(), json!(self.next_seq()));
        }
        data_line(&body.to_string())
    }

    fn response_shell(&self, status: &str, usage: Option<&Usage>) -> Value {
        let mut shell = json!({
            "id": self.response_id,
            "object": "response",
            "created_at": crate::util::now_ms() / 1000,
            "status": status,
            "model": self.model,
            "output": self.items,
        });
        if let Some(u) = usage {
            shell["usage"] = json!({
                "input_tokens": u.prompt,
                "output_tokens": u.completion,
                "total_tokens": u.prompt + u.completion,
                "input_tokens_details": {"cached_tokens": u.cache_read},
            });
        } else {
            shell["usage"] = Value::Null;
        }
        shell
    }

    fn close_current(&mut self, out: &mut Vec<String>) {
        match std::mem::replace(&mut self.current, CurrentItem::None) {
            CurrentItem::None => {}
            CurrentItem::Message {
                item_id,
                output_index,
                text,
                part_open,
            } => {
                if part_open {
                    out.push(self.event(
                        "response.content_part.done",
                        json!({
                            "item_id": item_id,
                            "output_index": output_index,
                            "content_index": 0,
                            "part": {"type": "output_text", "text": text.clone(), "annotations": []},
                        }),
                    ));
                }
                let item = json!({
                    "id": item_id,
                    "type": "message",
                    "status": "completed",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": text, "annotations": []}],
                });
                self.items.push(item.clone());
                out.push(self.event(
                    "response.output_item.done",
                    json!({"output_index": output_index, "item": item}),
                ));
            }
            CurrentItem::FunctionCall {
                item_id,
                output_index,
                call_id,
                name,
                args,
            } => {
                let item = json!({
                    "id": item_id,
                    "type": "function_call",
                    "status": "completed",
                    "call_id": call_id,
                    "name": name,
                    "arguments": args,
                });
                self.items.push(item.clone());
                out.push(self.event(
                    "response.output_item.done",
                    json!({"output_index": output_index, "item": item}),
                ));
            }
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
                out.push(self.event(
                    "response.created",
                    json!({"response": self.response_shell("in_progress", None)}),
                ));
                out.push(self.event(
                    "response.in_progress",
                    json!({"response": self.response_shell("in_progress", None)}),
                ));
            }
            StreamEvent::TextDelta { text, .. } => {
                let item_ctx = match &mut self.current {
                    CurrentItem::Message {
                        item_id,
                        output_index,
                        text: acc,
                        ..
                    } => {
                        acc.push_str(text);
                        Some((item_id.clone(), *output_index))
                    }
                    _ => None,
                };
                let (item_id, output_index) = match item_ctx {
                    Some(x) => x,
                    None => {
                        self.close_current(out);
                        let output_index = self.output_index;
                        self.output_index += 1;
                        let item_id = format!("msg_gw{}", crate::util::rand_hex(16));
                        out.push(self.event(
                            "response.output_item.added",
                            json!({
                                "output_index": output_index,
                                "item": {
                                    "id": item_id,
                                    "type": "message",
                                    "status": "in_progress",
                                    "role": "assistant",
                                    "content": [],
                                },
                            }),
                        ));
                        out.push(self.event(
                            "response.content_part.added",
                            json!({
                                "item_id": item_id,
                                "output_index": output_index,
                                "content_index": 0,
                                "part": {"type": "output_text", "text": "", "annotations": []},
                            }),
                        ));
                        self.current = CurrentItem::Message {
                            item_id: item_id.clone(),
                            output_index,
                            text: text.clone(),
                            part_open: true,
                        };
                        (item_id, output_index)
                    }
                };
                out.push(self.event(
                    "response.output_text.delta",
                    json!({
                        "item_id": item_id,
                        "output_index": output_index,
                        "content_index": 0,
                        "delta": text,
                    }),
                ));
            }
            StreamEvent::ReasoningDelta { text } => {
                // 上游 reasoning_content → reasoning summary(PRD §3.5)
                out.push(self.event(
                    "response.reasoning_summary_text.delta",
                    json!({"delta": text}),
                ));
            }
            StreamEvent::ToolStart { id, name, .. } => {
                self.close_current(out);
                let output_index = self.output_index;
                self.output_index += 1;
                let item_id = format!("fc_gw{}", crate::util::rand_hex(16));
                out.push(self.event(
                    "response.output_item.added",
                    json!({
                        "output_index": output_index,
                        "item": {
                            "id": item_id,
                            "type": "function_call",
                            "status": "in_progress",
                            "call_id": id,
                            "name": name,
                            "arguments": "",
                        },
                    }),
                ));
                self.current = CurrentItem::FunctionCall {
                    item_id,
                    output_index,
                    call_id: id.clone(),
                    name: name.clone(),
                    args: String::new(),
                };
            }
            StreamEvent::ToolDelta { json, .. } => {
                // 先取值再调用 &mut self.event,避免同时借用 self
                let payload = match &mut self.current {
                    CurrentItem::FunctionCall {
                        item_id,
                        output_index,
                        args,
                        ..
                    } => {
                        args.push_str(json);
                        Some((item_id.clone(), *output_index))
                    }
                    _ => None,
                };
                if let Some((item_id, output_index)) = payload {
                    out.push(self.event(
                        "response.function_call_arguments.delta",
                        json!({
                            "item_id": item_id,
                            "output_index": output_index,
                            "delta": json,
                        }),
                    ));
                }
            }
            StreamEvent::BlockStop { .. } => {}
            StreamEvent::Finish { usage, .. } => {
                self.close_current(out);
                out.push(self.event(
                    "response.completed",
                    json!({"response": self.response_shell("completed", usage.as_ref())}),
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
    fn lru_evicts_oldest() {
        let s = ResponseStore::default();
        for i in 0..500 {
            s.put(
                &format!("r{i}"),
                StoredResponse {
                    context: vec![],
                    output_blocks: vec![],
                },
            );
        }
        assert!(s.get("r0").is_some()); // 刚访问 → 提升
        s.put(
            "r500",
            StoredResponse {
                context: vec![],
                output_blocks: vec![],
            },
        );
        // r1(最旧且未被访问)被淘汰
        assert!(s.get("r1").is_none());
        assert!(s.get("r2").is_some());
    }

    #[test]
    fn parse_request_full() {
        let body: Value = serde_json::from_str(
            r#"{
            "model":"gpt-5","stream":true,"store":false,
            "instructions":"be brief",
            "max_output_tokens": 512,
            "reasoning":{"effort":"high"},
            "previous_response_id":"resp_old",
            "tools":[{"type":"function","name":"f","description":"d","parameters":{"type":"object"}}],
            "input":[
                {"type":"message","role":"user","content":"hi"},
                {"type":"function_call","call_id":"c1","name":"f","arguments":"{\"a\":1}"},
                {"type":"function_call_output","call_id":"c1","output":"result"},
                {"type":"reasoning","encrypted_content":"x"},
                {"role":"developer","content":"dev rule"}
            ]}"#,
        )
        .unwrap();
        let (ir, prev) = parse_request(&body).unwrap();
        assert_eq!(prev.as_deref(), Some("resp_old"));
        assert_eq!(ir.max_tokens, Some(512));
        assert_eq!(
            ir.reasoning,
            Some(Reasoning::Effort(crate::transform::ir::Effort::High))
        );
        assert_eq!(ir.tools.len(), 1);
        assert_eq!(ir.system.len(), 2); // instructions + developer
        assert_eq!(ir.messages.len(), 3); // user + assistant tool_use + tool_result
        assert!(ir.dropped_fields.iter().any(|f| f == "input.reasoning"));
        assert!(ir.dropped_fields.iter().any(|f| f == "store"));
    }

    #[test]
    fn entry_sse_official_sequence() {
        let mut r = EntrySse::new("gpt-5");
        let mut out = Vec::new();
        r.render(&StreamEvent::Start { model: String::new() }, &mut out);
        r.render(&StreamEvent::TextDelta { block: 0, text: "he".into() }, &mut out);
        r.render(&StreamEvent::TextDelta { block: 0, text: "y".into() }, &mut out);
        r.render(&StreamEvent::ToolStart { block: 1, id: "c1".into(), name: "f".into() }, &mut out);
        r.render(&StreamEvent::ToolDelta { block: 1, json: "{}".into() }, &mut out);
        r.render(
            &StreamEvent::Finish {
                stop_reason: None,
                usage: Some(Usage {
                    prompt: 4,
                    completion: 2,
                    ..Default::default()
                }),
            },
            &mut out,
        );
        let names: Vec<String> = out
            .iter()
            .filter_map(|l| {
                let json_str = l.strip_prefix("data: ")?.trim_end();
                serde_json::from_str::<Value>(json_str)
                    .ok()?
                    .get("type")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect();
        assert_eq!(
            names,
            vec![
                "response.created",
                "response.in_progress",
                "response.output_item.added",
                "response.content_part.added",
                "response.output_text.delta",
                "response.output_text.delta",
                "response.content_part.done",
                "response.output_item.done",
                "response.output_item.added",
                "response.function_call_arguments.delta",
                "response.output_item.done",
                "response.completed",
            ]
        );
        // sequence_number 严格递增
        let seqs: Vec<u64> = out
            .iter()
            .filter_map(|l| {
                serde_json::from_str::<Value>(l.strip_prefix("data: ")?.trim_end())
                    .ok()?
                    .get("sequence_number")
                    .and_then(Value::as_u64)
            })
            .collect();
        let mut sorted = seqs.clone();
        sorted.sort();
        assert_eq!(seqs, sorted);
        // completed 事件带 usage 与 output items
        let completed: Value = serde_json::from_str(
            out.last()
                .unwrap()
                .strip_prefix("data: ")
                .unwrap()
                .trim_end(),
        )
        .unwrap();
        assert_eq!(completed["response"]["status"], "completed");
        assert_eq!(completed["response"]["usage"]["input_tokens"], 4);
        assert_eq!(completed["response"]["output"].as_array().unwrap().len(), 2);
    }
}
