use serde::{Deserialize, Serialize};

/// 上游渠道协议(三种)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpstreamProto {
    OpenAi,
    Anthropic,
    Gemini,
}

impl UpstreamProto {
    pub fn as_str(&self) -> &'static str {
        match self {
            UpstreamProto::OpenAi => "openai",
            UpstreamProto::Anthropic => "anthropic",
            UpstreamProto::Gemini => "gemini",
        }
    }
}

/// 入口协议(四种入口;上游只有上面三种)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryProto {
    OpenAi,
    Responses,
    Anthropic,
    Gemini,
}

impl EntryProto {
    pub fn as_str(&self) -> &'static str {
        match self {
            EntryProto::OpenAi => "openai",
            EntryProto::Responses => "responses",
            EntryProto::Anthropic => "anthropic",
            EntryProto::Gemini => "gemini",
        }
    }
}
