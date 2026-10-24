//! Gemini 原生协议适配器:"协议 ↔ IR"。
//! URL 构建:POST {base}/v1beta/models/{model}:generateContent(流式 :streamGenerateContent?alt=sse),
//! 模型映射重写路径中的模型名;鉴权用 x-goog-api-key 请求头。

use serde_json::{json, Map, Value};

use super::ir::{
    Block, CanonicalRequest, Message, Reasoning, Role, StopReason, StreamEvent, Tool, ToolChoice,
};
use crate::billing::Usage;
use crate::transform::sse::data_line;

/// reasoning_effort → Gemini thinkingConfig.thinkingBudget(取最接近档位)
pub fn effort_to_thinking_budget(e: super::ir::Effort) -> i64 {
    match e {
        super::ir::Effort::Minimal => 0,
        super::ir::Effort::Low => 1024,
        super::ir::Effort::Medium => 8192,
        super::ir::Effort::High => 24576,
    }
}

// ---------------------------------------------------------------------------
// OpenAPI JSON Schema → Gemini Schema(type 大写;剥离不支持的关键字)
// ---------------------------------------------------------------------------

pub fn convert_schema(v: &Value) -> Value {
    match v {
        Value::Object(o) => {
            let mut out = Map::new();
            if let Some(t) = o.get("type").and_then(Value::as_str) {
                out.insert("type".into(), json!(t.to_uppercase()));
            }
            for k in ["format", "description", "enum", "minimum", "maximum", "nullable"] {
                if let Some(x) = o.get(k) {
                    out.insert(k.into(), x.clone());
                }
            }
            if let Some(items) = o.get("items") {
                out.insert("items".into(), convert_schema(items));
            }
            if let Some(props) = o.get("properties").and_then(Value::as_object) {
                let mut p = Map::new();
                for (k, val) in props {
                    p.insert(k.clone(), convert_schema(val));
                }
                out.insert("properties".into(), Value::Object(p));
            }
            if let Some(req) = o.get("required") {
                out.insert("required".into(), req.clone());
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

fn tool_use_name_index(ir: &CanonicalRequest) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    for m in &ir.messages {
        for b in &m.blocks {
            if let Block::ToolUse { id, name, .. } = b {
                map.insert(id.clone(), name.clone());
            }
        }
    }
    map
}

// ---------------------------------------------------------------------------
// 入口请求解析:Gemini JSON → IR(M4 实现;路由 M5 接入)
// ---------------------------------------------------------------------------

pub fn parse_request(v: &Value, model_from_path: Option<&str>) -> Result<CanonicalRequest, String> {
    let obj = v
        .as_object()
        .ok_or_else(|| "请求体必须是 JSON 对象".to_string())?;
    let model = match model_from_path {
        Some(m) if !m.is_empty() => m.to_string(),
        _ => obj
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    };
    if model.is_empty() {
        return Err("缺少模型名(Gemini 入口模型名在 URL 路径中)".to_string());
    }
    let mut ir = CanonicalRequest {
        model,
        stream: false, // 流式由 URL action 决定,调用方覆写
        ..Default::default()
    };

    // systemInstruction: {parts:[{text}]}
    if let Some(sys) = obj.get("systemInstruction") {
        let text: String = sys
            .get("parts")
            .and_then(Value::as_array)
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|p| p.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        if !text.is_empty() {
            ir.system.push(Block::Text {
                text,
                cache_control: None,
            });
        }
    }

    // functionCall/functionResponse 的 id 合成:Gemini 原生无 call id
    let mut call_seq: u32 = 0;
    let mut last_call_id_of_name: std::collections::HashMap<String, String> = Default::default();

    if let Some(contents) = obj.get("contents").and_then(Value::as_array) {
        for c in contents {
            let role = match c.get("role").and_then(Value::as_str) {
                Some("model") => Role::Assistant,
                _ => Role::User,
            };
            let mut blocks = Vec::new();
            if let Some(parts) = c.get("parts").and_then(Value::as_array) {
                for p in parts {
                    if let Some(text) = p.get("text").and_then(Value::as_str) {
                        blocks.push(Block::Text {
                            text: text.to_string(),
                            cache_control: None,
                        });
                    } else if let Some(img) = p.get("inlineData") {
                        blocks.push(Block::Image {
                            media_type: img
                                .get("mimeType")
                                .and_then(Value::as_str)
                                .unwrap_or("image/png")
                                .to_string(),
                            data_b64: img
                                .get("data")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                            cache_control: None,
                        });
                    } else if let Some(fc) = p.get("functionCall") {
                        call_seq += 1;
                        let id = format!("gc_{call_seq}");
                        let name = fc
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        last_call_id_of_name.insert(name.clone(), id.clone());
                        blocks.push(Block::ToolUse {
                            id,
                            name,
                            input: fc.get("args").cloned().unwrap_or_else(|| json!({})),
                        });
                    } else if let Some(fr) = p.get("functionResponse") {
                        let name = fr
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let tool_use_id = last_call_id_of_name
                            .get(&name)
                            .cloned()
                            .unwrap_or_else(|| name.clone());
                        let response = fr.get("response").cloned().unwrap_or(Value::Null);
                        let content = match response {
                            Value::String(s) => s,
                            other => other.to_string(),
                        };
                        blocks.push(Block::ToolResult {
                            tool_use_id,
                            content,
                            is_error: fr.get("isError").and_then(Value::as_bool).unwrap_or(false),
                            cache_control: None,
                        });
                    } else {
                        ir.push_dropped("part");
                    }
                }
            }
            ir.messages.push(Message { role, blocks });
        }
    }

    if let Some(tools) = obj.get("tools").and_then(Value::as_array) {
        for t in tools {
            if let Some(decls) = t.get("functionDeclarations").and_then(Value::as_array) {
                for d in decls {
                    ir.tools.push(Tool {
                        name: d
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        description: d
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        input_schema: convert_schema_back(d.get("parameters")),
                    });
                }
            } else {
                ir.push_dropped("tools[type!=function]");
            }
        }
    }

    if let Some(cfg) = obj
        .get("toolConfig")
        .and_then(|t| t.get("functionCallingConfig"))
    {
        ir.tool_choice = match cfg.get("mode").and_then(Value::as_str) {
            Some("ANY") => match cfg.pointer("/allowedFunctionNames/0").and_then(Value::as_str) {
                Some(n) => Some(ToolChoice::Tool(n.to_string())),
                None => Some(ToolChoice::Any),
            },
            Some("NONE") => Some(ToolChoice::None),
            _ => Some(ToolChoice::Auto),
        };
    }

    let gc = obj.get("generationConfig").cloned().unwrap_or(Value::Null);
    ir.max_tokens = gc.get("maxOutputTokens").and_then(Value::as_i64);
    ir.temperature = gc.get("temperature").and_then(Value::as_f64);
    ir.top_p = gc.get("topP").and_then(Value::as_f64);
    if let Some(stops) = gc.get("stopSequences").and_then(Value::as_array) {
        for st in stops.iter().filter_map(Value::as_str) {
            ir.stop.push(st.to_string());
        }
    }
    if let Some(budget) = gc
        .pointer("/thinkingConfig/thinkingBudget")
        .and_then(Value::as_u64)
    {
        if budget > 0 {
            // 饱和转换,防 u64 超大值静默回绕
            ir.reasoning = Some(Reasoning::Budget(u32::try_from(budget).unwrap_or(u32::MAX)));
        }
    }

    for f in ["safetySettings", "responseSchema", "responseMimeType", "toolChoice"] {
        if obj.contains_key(f) {
            ir.push_dropped(f);
        }
    }
    Ok(ir)
}

/// Gemini Schema → 近似 OpenAI JSON Schema(小写 type;供 IR 内部统一表示)
fn convert_schema_back(v: Option<&Value>) -> Value {
    let Some(v) = v else {
        return json!({});
    };
    match v {
        Value::Object(o) => {
            let mut out = Map::new();
            if let Some(t) = o.get("type").and_then(Value::as_str) {
                out.insert("type".into(), json!(t.to_lowercase()));
            }
            for k in ["format", "description", "enum", "minimum", "maximum", "nullable"] {
                if let Some(x) = o.get(k) {
                    out.insert(k.into(), x.clone());
                }
            }
            if let Some(items) = o.get("items") {
                out.insert("items".into(), convert_schema_back(Some(items)));
            }
            if let Some(props) = o.get("properties").and_then(Value::as_object) {
                let mut p = Map::new();
                for (k, val) in props {
                    p.insert(k.clone(), convert_schema_back(Some(val)));
                }
                out.insert("properties".into(), Value::Object(p));
            }
            if let Some(req) = o.get("required") {
                out.insert("required".into(), req.clone());
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}


// ---------------------------------------------------------------------------
// 上游请求渲染:IR → Gemini JSON(M4:供三入口转 Gemini 上游)
// ---------------------------------------------------------------------------

pub fn render_request(ir: &CanonicalRequest) -> (Value, Vec<String>) {
    let mut dropped: Vec<String> = Vec::new();
    let mut obj = Map::new();

    let sys_texts: Vec<&str> = ir
        .system
        .iter()
        .filter_map(|b| match b {
            Block::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    if ir.system.iter().any(|b| !matches!(b, Block::Text { .. })) {
        dropped.push("system(cache_control/image)".into());
    }
    if !sys_texts.is_empty() {
        obj.insert(
            "systemInstruction".into(),
            json!({"parts": [{"text": sys_texts.join("\n\n")}]}),
        );
    }

    let names = tool_use_name_index(ir);
    let mut contents: Vec<Value> = Vec::new();
    for m in &ir.messages {
        let role = if matches!(m.role, Role::User) { "user" } else { "model" };
        let mut parts: Vec<Value> = Vec::new();
        for b in &m.blocks {
            match b {
                Block::Text { text, .. } => parts.push(json!({"text": text})),
                Block::Image {
                    media_type,
                    data_b64,
                    ..
                } => parts.push(json!({
                    "inlineData": {"mimeType": media_type, "data": data_b64},
                })),
                Block::ToolUse { id, name, input } => parts.push(json!({
                    "functionCall": {"name": name, "args": input},
                    // 部分客户端实现依赖 call id 关联;Gemini 原生无此概念,附加进 args 之外忽略
                    "_id": id,
                })),
                Block::ToolResult {
                    tool_use_id,
                    content,
                    is_error,
                    ..
                } => {
                    let name = names.get(tool_use_id).cloned().unwrap_or_else(|| tool_use_id.clone());
                    let response = serde_json::from_str::<Value>(content)
                        .ok()
                        .filter(Value::is_object)
                        .unwrap_or_else(|| json!({"result": content}));
                    let mut fr = json!({"functionResponse": {"name": name, "response": response}});
                    if *is_error {
                        fr["functionResponse"]["isError"] = json!(true);
                    }
                    parts.push(fr);
                }
                Block::Thinking { .. } => {
                    dropped.push("thinking".into());
                }
            }
        }
        // 剥离调试字段 _id
        for p in parts.iter_mut() {
            if let Some(o) = p.as_object_mut() {
                o.remove("_id");
            }
        }
        if !parts.is_empty() {
            contents.push(json!({"role": role, "parts": parts}));
        }
    }
    obj.insert("contents".into(), Value::Array(contents));

    if !ir.tools.is_empty() {
        obj.insert(
            "tools".into(),
            json!([{
                "functionDeclarations": ir.tools.iter().map(|t: &Tool| json!({
                    "name": t.name,
                    "description": t.description,
                    "parameters": convert_schema(&t.input_schema),
                })).collect::<Vec<_>>(),
            }]),
        );
    }
    if let Some(tc) = &ir.tool_choice {
        let cfg = match tc {
            ToolChoice::Auto => json!({"mode": "AUTO"}),
            ToolChoice::None => json!({"mode": "NONE"}),
            ToolChoice::Any => json!({"mode": "ANY"}),
            ToolChoice::Tool(n) => {
                json!({"mode": "ANY", "allowedFunctionNames": [n]})
            }
        };
        obj.insert("toolConfig".into(), json!({"functionCallingConfig": cfg}));
    }

    let mut gc = Map::new();
    if let Some(mt) = ir.max_tokens {
        gc.insert("maxOutputTokens".into(), json!(mt));
    }
    if let Some(t) = ir.temperature {
        gc.insert("temperature".into(), json!(t));
    }
    if let Some(t) = ir.top_p {
        gc.insert("topP".into(), json!(t));
    }
    if !ir.stop.is_empty() {
        gc.insert("stopSequences".into(), json!(ir.stop));
    }
    match ir.reasoning {
        Some(Reasoning::Budget(b)) => {
            gc.insert(
                "thinkingConfig".into(),
                json!({"thinkingBudget": b, "includeThoughts": true}),
            );
        }
        Some(Reasoning::Effort(e)) => {
            gc.insert(
                "thinkingConfig".into(),
                json!({"thinkingBudget": effort_to_thinking_budget(e)}),
            );
        }
        None => {}
    }
    if !gc.is_empty() {
        obj.insert("generationConfig".into(), Value::Object(gc));
    }
    dropped.extend(ir.dropped_fields.iter().cloned());
    (Value::Object(obj), dropped)
}

// ---------------------------------------------------------------------------
// 响应解析:Gemini JSON → IR(非流式;流式逐 chunk 复用同一解析)
// ---------------------------------------------------------------------------

pub fn parse_usage(u: &Value) -> Usage {
    Usage {
        prompt: u.get("promptTokenCount").and_then(Value::as_i64).unwrap_or(0),
        completion: u
            .get("candidatesTokenCount")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            + u.get("thoughtsTokenCount")
                .and_then(Value::as_i64)
                .unwrap_or(0),
        cache_read: u
            .get("cachedContentTokenCount")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        cache_write: 0,
    }
}

pub fn parse_finish(s: &str) -> StopReason {
    match s {
        "MAX_TOKENS" => StopReason::MaxTokens,
        "STOP" => StopReason::EndTurn,
        _ => StopReason::Other,
    }
}

pub fn render_finish(sr: StopReason) -> &'static str {
    match sr {
        StopReason::MaxTokens => "MAX_TOKENS",
        // Gemini 语义:正常结束(含工具调用轮)都是 STOP;"OTHER" 会被
        // gemini-sdk 类客户端视为异常中断,破坏 agent 循环
        StopReason::EndTurn | StopReason::ToolUse | StopReason::StopSequence => "STOP",
        StopReason::Other => "OTHER",
    }
}

pub struct GeminiChunk {
    pub events: Vec<StreamEvent>,
    pub usage: Option<Usage>,
    pub finish: Option<StopReason>,
    pub error: Option<String>,
}

/// 解析一个 GenerateContentResponse(流式/非流式同一结构)。
/// call_counter 用于为 functionCall 合成稳定 id(Gemini 原生无 call id)。
pub fn parse_chunk(v: &Value, call_counter: &mut u32) -> GeminiChunk {
    if let Some(err) = v.get("error") {
        let msg = err
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("gemini error")
            .to_string();
        return GeminiChunk {
            events: vec![],
            usage: None,
            finish: None,
            error: Some(msg),
        };
    }
    let mut events = Vec::new();
    if let Some(candidates) = v.get("candidates").and_then(Value::as_array) {
        if let Some(c) = candidates.first() {
            if let Some(parts) = c.pointer("/content/parts").and_then(Value::as_array) {
                for p in parts {
                    if let Some(text) = p.get("text").and_then(Value::as_str) {
                        if !text.is_empty() {
                            // thought 标志 = 思考摘要,不得混入正文
                            if p.get("thought").and_then(Value::as_bool).unwrap_or(false) {
                                events.push(StreamEvent::ReasoningDelta { text: text.to_string() });
                            } else {
                                events.push(StreamEvent::TextDelta { block: 0, text: text.to_string() });
                            }
                        }
                    } else if let Some(fc) = p.get("functionCall") {
                        // call_counter 由 UpstreamSse 持有,跨 chunk 单调递增;
                        // 局部变量会每 chunk 重置,并行调用全部撞同一 block 号
                        *call_counter += 1;
                        let block = *call_counter as usize;
                        let id = format!("call_{call_counter}");
                        let name = fc
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let args = fc.get("args").cloned().unwrap_or_else(|| json!({}));
                        let args_str = args.to_string();
                        events.push(StreamEvent::ToolStart {
                            block,
                            id,
                            name,
                        });
                        events.push(StreamEvent::ToolDelta {
                            block,
                            json: args_str,
                        });
                        events.push(StreamEvent::BlockStop { block });
                    }
                }
            }
        }
    }
    let usage = v.get("usageMetadata").map(parse_usage);
    let finish = v
        .pointer("/candidates/0/finishReason")
        .and_then(Value::as_str)
        .map(parse_finish);
    GeminiChunk {
        events,
        usage,
        finish,
        error: None,
    }
}

/// 非流式响应整体解析
/// 外层 Err = 结构解析失败;内层 Err = 上游业务错误
pub type GeminiParsed = Result<(Vec<Block>, Option<StopReason>, Usage), String>;

pub fn parse_response_json(v: &Value) -> Result<GeminiParsed, String> {
    let mut counter = 0u32;
    let chunk = parse_chunk(v, &mut counter);
    if let Some(e) = chunk.error {
        return Ok(Err(e));
    }
    let mut blocks: Vec<Block> = Vec::new();
    for ev in &chunk.events {
        match ev {
            StreamEvent::TextDelta { text, .. } => {
                if let Some(Block::Text { text: t, .. }) = blocks.last_mut() {
                    t.push_str(text);
                } else {
                    blocks.push(Block::Text {
                        text: text.clone(),
                        cache_control: None,
                    });
                }
            }
            StreamEvent::ReasoningDelta { text } => {
                if let Some(Block::Thinking { text: t, .. }) = blocks.last_mut() {
                    t.push_str(text);
                } else {
                    blocks.push(Block::Thinking {
                        text: text.clone(),
                        signature: None,
                    });
                }
            }
            StreamEvent::ToolStart { id, name, .. } => blocks.push(Block::ToolUse {
                id: id.clone(),
                name: name.clone(),
                input: json!({}),
            }),
            StreamEvent::ToolDelta { json, .. } => {
                if let Some(Block::ToolUse { input, .. }) = blocks.last_mut() {
                    *input = serde_json::from_str(json).unwrap_or_else(|_| json!({}));
                }
            }
            _ => {}
        }
    }
    Ok(Ok((blocks, chunk.finish, chunk.usage.unwrap_or_default())))
}

// ---------------------------------------------------------------------------
// 流式:Gemini 上游 SSE → IR 事件
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct UpstreamSse {
    call_counter: u32,
    started: bool,
    usage: Option<Usage>,
    finish: Option<StopReason>,
    finished: bool,
}

impl UpstreamSse {
    pub fn feed(&mut self, data: &str, out: &mut Vec<StreamEvent>) {
        if self.finished {
            return;
        }
        let Ok(v) = serde_json::from_str::<Value>(data.trim()) else {
            return;
        };
        if !self.started {
            self.started = true;
            out.push(StreamEvent::Start { model: String::new() });
        }
        let chunk = parse_chunk(&v, &mut self.call_counter);
        if let Some(e) = chunk.error {
            self.finished = true;
            out.push(StreamEvent::UpstreamError { message: e });
            return;
        }
        if chunk.usage.is_some() {
            self.usage = chunk.usage;
        }
        if chunk.finish.is_some() {
            self.finish = chunk.finish;
        }
        out.extend(chunk.events);
    }

    pub fn is_finished(&self) -> bool {
        self.finished
    }

    pub fn force_finish(&mut self, out: &mut Vec<StreamEvent>) {
        if self.finished {
            return;
        }
        self.finished = true;
        out.push(StreamEvent::Finish {
            stop_reason: self.finish,
            usage: self.usage,
        });
    }
}

// ---------------------------------------------------------------------------
// 流式:IR 事件 → Gemini 入口 SSE(M5 接入 /v1beta/models/{m}:streamGenerateContent)
// ---------------------------------------------------------------------------

pub struct EntrySse {
    model: String,
    finished: bool,
    /// 按 block 累积工具调用 (name, args 缓冲):上游 arguments 分多片 delta 到达,
    /// 必须攒齐后在 BlockStop/Finish 一次解析发射,否则产生空函数名/坏参数分片;
    /// HashMap 支持并行多调用交错
    pending_tools: std::collections::HashMap<usize, (String, String)>,
}

impl EntrySse {
    pub fn new(model: &str) -> Self {
        Self {
            model: model.to_string(),
            finished: false,
            pending_tools: Default::default(),
        }
    }

    /// 把累积完的工具调用一次性发射(Gemini 语义:一条 functionCall = 完整 args)
    fn flush_tool(&mut self, block: usize, out: &mut Vec<String>) {
        if let Some((name, args_buf)) = self.pending_tools.remove(&block) {
            let args: Value = serde_json::from_str(&args_buf).unwrap_or_else(|_| json!({}));
            out.push(data_line(
                &json!({
                    "candidates": [
                        {"content": {"role": "model", "parts": [
                            {"functionCall": {"name": name, "args": args}},
                        ]}},
                    ],
                })
                .to_string(),
            ));
        }
    }

    pub fn render(&mut self, ev: &StreamEvent, out: &mut Vec<String>) {
        if self.finished {
            return;
        }
        let _ = &self.model;
        match ev {
            StreamEvent::Start { .. } => {}
            StreamEvent::TextDelta { text, .. } => {
                out.push(data_line(&json!({
                    "candidates": [{"content": {"role": "model", "parts": [{"text": text}]}}],
                }).to_string()));
            }
            StreamEvent::ReasoningDelta { text } => {
                // Gemini 协议:thought 是 text part 自身字段,不能拆成独立 part
                out.push(data_line(&json!({
                    "candidates": [{"content": {"role": "model", "parts": [{"text": text, "thought": true}]}}],
                }).to_string()));
            }
            StreamEvent::ToolStart { block, name, .. } => {
                self.pending_tools
                    .entry(*block)
                    .or_insert_with(|| (name.clone(), String::new()));
            }
            StreamEvent::ToolDelta { block, json } => {
                self.pending_tools
                    .entry(*block)
                    .or_insert_with(|| (String::new(), String::new()))
                    .1
                    .push_str(json);
            }
            StreamEvent::BlockStop { block } => {
                self.flush_tool(*block, out);
            }
            StreamEvent::Finish { stop_reason, usage } => {
                // 兜底:上游未发 BlockStop 的遗留调用全部冲刷
                let blocks: Vec<usize> = self.pending_tools.keys().copied().collect();
                for b in blocks {
                    self.flush_tool(b, out);
                }
                let mut body = json!({
                    "candidates": [{
                        "content": {"role": "model", "parts": []},
                        "finishReason": stop_reason.map(render_finish),
                    }],
                });
                if let Some(u) = usage {
                    body["usageMetadata"] = json!({
                        "promptTokenCount": u.prompt,
                        "candidatesTokenCount": u.completion,
                        "cachedContentTokenCount": u.cache_read,
                    });
                }
                out.push(data_line(&body.to_string()));
                self.finished = true;
            }
            StreamEvent::UpstreamError { .. } => {}
        }
    }
}
