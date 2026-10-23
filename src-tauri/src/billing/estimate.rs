//! usage 本地估算:tiktoken cl100k 计数;上游不返回 usage 时的兜底(日志标记 estimated)。

use crate::billing::Usage;
use crate::billing::pricing::estimate_tokens;
use crate::transform::ir::CanonicalRequest;

pub fn estimate_usage(ir: &CanonicalRequest, output: &str) -> Usage {
    Usage {
        prompt: estimate_tokens(&ir.collect_text()),
        completion: estimate_tokens(output),
        cache_read: 0,
        cache_write: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transform::openai_chat::parse_request;

    #[test]
    fn estimate_basic() {
        let body: serde_json::Value = serde_json::from_str(
            r#"{"model":"m","messages":[{"role":"user","content":"hello world, this is a test"}]}"#,
        )
        .unwrap();
        let ir = parse_request(&body).unwrap();
        let u = estimate_usage(&ir, "an output message");
        assert!(u.prompt > 0 && u.completion > 0);
    }
}
