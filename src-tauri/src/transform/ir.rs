use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::billing::Usage;

/// 统一中间表示(IR):每个协议只实现"协议 ↔ IR"一对纯函数适配器,
/// 入口→上游 = 适配器串联,禁止点对点转换路径(PRD §3.5 硬性要求)
pub type CacheControl = Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone)]
pub enum Block {
    Text {
        text: String,
        cache_control: Option<CacheControl>,
    },
    Image {
        media_type: String,
        data_b64: String,
        cache_control: Option<CacheControl>,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        tool_use_id: String,
        content: String,
        is_error: bool,
        cache_control: Option<CacheControl>,
    },
    /// 推理内容(OpenAI reasoning_content / Anthropic thinking)
    Thinking {
        text: String,
        signature: Option<String>,
    },
}

impl Block {
    /// 近似字节量(内存上限估算用;图片按 b64 长度计,工具入参按 JSON 序列化后计)
    pub fn text_len(&self) -> usize {
        match self {
            Block::Text { text, .. } | Block::Thinking { text, .. } => text.len(),
            Block::Image { data_b64, .. } => data_b64.len(),
            Block::ToolUse { input, .. } => input.to_string().len(),
            Block::ToolResult { content, .. } => content.len(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Message {
    pub role: Role,
    pub blocks: Vec<Block>,
}

#[derive(Debug, Clone)]
pub struct Tool {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Value,
}

#[derive(Debug, Clone)]
pub enum ToolChoice {
    Auto,
    None,
    Any,
    Tool(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Effort {
    Minimal,
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reasoning {
    Effort(Effort),
    /// Anthropic thinking.budget_tokens
    Budget(u32),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    EndTurn,
    MaxTokens,
    StopSequence,
    ToolUse,
    Other,
}

#[derive(Debug, Clone, Default)]
pub struct CanonicalRequest {
    pub model: String,
    pub system: Vec<Block>,
    pub messages: Vec<Message>,
    pub tools: Vec<Tool>,
    pub tool_choice: Option<ToolChoice>,
    pub max_tokens: Option<i64>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub stop: Vec<String>,
    pub stream: bool,
    pub reasoning: Option<Reasoning>,
    /// 客户端传入的推理强度**原值**(reasoning_effort/reasoning.effort 原样字符串;
    /// thinkingBudget 原始数值格式化)。归一化会丢掉 max/x-tier 等非标档位,
    /// 日志展示按原值,转发映射照旧走 Reasoning 枚举
    pub reasoning_raw: Option<String>,
    /// 转换中安全丢弃的字段名(去重),随日志记录
    pub dropped_fields: Vec<String>,
}

impl CanonicalRequest {
    pub fn push_dropped(&mut self, field: &str) {
        if !self.dropped_fields.iter().any(|f| f == field) {
            self.dropped_fields.push(field.to_string());
        }
    }

    pub fn effort_str(&self) -> Option<&'static str> {
        match self.reasoning {
            Some(Reasoning::Effort(e)) => Some(match e {
                Effort::Minimal => "minimal",
                Effort::Low => "low",
                Effort::Medium => "medium",
                Effort::High => "high",
            }),
            _ => None,
        }
    }

    pub fn effort_of(s: &str) -> Option<Effort> {
        // 兼容非标准取值:多家客户端用 "max"(如 DSH/glm),按 high 处理;
        // "none" 视为关闭(minimal)。"gpt-5" 系还出现过 "medium-high" 混合档,
        // 取保守下界 medium
        match s.trim().to_lowercase().as_str() {
            "minimal" | "none" | "off" => Some(Effort::Minimal),
            "low" => Some(Effort::Low),
            "medium" | "medium-high" | "medium_plus" => Some(Effort::Medium),
            "high" | "max" | "maximum" | "ultra" => Some(Effort::High),
            _ => None,
        }
    }

    /// 全部文本内容拼接(token 估算用)
    pub fn collect_text(&self) -> String {
        let mut s = String::new();
        for b in &self.system {
            if let Block::Text { text, .. } = b {
                s.push_str(text);
                s.push('\n');
            }
        }
        for m in &self.messages {
            for b in &m.blocks {
                match b {
                    Block::Text { text, .. } => {
                        s.push_str(text);
                        s.push('\n');
                    }
                    Block::ToolUse { name, input, .. } => {
                        s.push_str(name);
                        s.push(' ');
                        s.push_str(&input.to_string());
                        s.push('\n');
                    }
                    Block::ToolResult { content, .. } => {
                        s.push_str(content);
                        s.push('\n');
                    }
                    Block::Thinking { text, .. } => {
                        s.push_str(text);
                        s.push('\n');
                    }
                    Block::Image { .. } => s.push_str("[image]\n"),
                }
            }
        }
        for t in &self.tools {
            s.push_str(&t.name);
            s.push(' ');
            if let Some(d) = &t.description {
                s.push_str(d);
                s.push(' ');
            }
            s.push_str(&t.input_schema.to_string());
            s.push('\n');
        }
        s
    }
}

/// 流式事件(IR):各上游适配器产出,各入口渲染器消费
#[derive(Debug, Clone)]
pub enum StreamEvent {
    Start {
        model: String,
    },
    TextDelta {
        block: usize,
        text: String,
    },
    ReasoningDelta {
        text: String,
    },
    ToolStart {
        block: usize,
        id: String,
        name: String,
    },
    ToolDelta {
        block: usize,
        json: String,
    },
    BlockStop {
        block: usize,
    },
    Finish {
        stop_reason: Option<StopReason>,
        usage: Option<Usage>,
    },
    /// 上游在流内报告错误(如 Anthropic event:error)
    UpstreamError {
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effort_of_accepts_non_standard_values() {
        // 标准四档
        assert_eq!(CanonicalRequest::effort_of("low"), Some(Effort::Low));
        assert_eq!(CanonicalRequest::effort_of("high"), Some(Effort::High));
        // 非标准取值(实际客户端在用):DSH 发 "max"
        assert_eq!(CanonicalRequest::effort_of("max"), Some(Effort::High));
        assert_eq!(CanonicalRequest::effort_of("none"), Some(Effort::Minimal));
        assert_eq!(
            CanonicalRequest::effort_of("medium-high"),
            Some(Effort::Medium)
        );
        // 大小写与空白容错
        assert_eq!(CanonicalRequest::effort_of(" High "), Some(Effort::High));
        // 未知值不猜
        assert_eq!(CanonicalRequest::effort_of("turbo"), None);
    }
}
