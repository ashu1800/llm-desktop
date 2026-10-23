use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use tiktoken_rs::CoreBPE;

/// 全局定价表条目:精确名或 prefix* 通配;价格单位 元/百万 token
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceEntry {
    pub pattern: String,
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

#[derive(Debug, Clone, Default)]
pub struct PriceTable {
    pub rows: Vec<PriceEntry>,
}

impl PriceTable {
    /// 精确优先;通配取最后一条命中(按表序)
    pub fn match_for(&self, model: &str) -> Option<&PriceEntry> {
        if let Some(exact) = self.rows.iter().find(|r| r.pattern == model) {
            return Some(exact);
        }
        // 通配取最后一条命中:反向找第一条
        self.rows.iter().rev().find(|r| {
            r.pattern.ends_with('*') && model.starts_with(r.pattern.trim_end_matches('*'))
        })
    }
}

fn bpe() -> &'static CoreBPE {
    static BPE: OnceLock<CoreBPE> = OnceLock::new();
    BPE.get_or_init(|| tiktoken_rs::cl100k_base().expect("cl100k_base 初始化失败"))
}

/// 本地 token 估算:cl100k_base;BPE 无法编码时退化为 UTF-8 字节 ÷ 3.75
pub fn estimate_tokens(text: &str) -> i64 {
    if text.is_empty() {
        return 0;
    }
    match bpe().encode_ordinary(text).len() {
        0 => (text.len() as f64 / 3.75).ceil() as i64,
        n => n as i64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> PriceTable {
        PriceTable {
            rows: vec![
                PriceEntry {
                    pattern: "gpt*".into(),
                    input: 1.0,
                    output: 2.0,
                    cache_read: 0.0,
                    cache_write: 0.0,
                },
                PriceEntry {
                    pattern: "gpt-4o".into(),
                    input: 5.0,
                    output: 15.0,
                    cache_read: 0.0,
                    cache_write: 0.0,
                },
                PriceEntry {
                    pattern: "gpt-4o-mini*".into(),
                    input: 0.3,
                    output: 0.6,
                    cache_read: 0.0,
                    cache_write: 0.0,
                },
            ],
        }
    }

    #[test]
    fn exact_beats_wildcard() {
        let t = table();
        let m = t.match_for("gpt-4o").unwrap();
        assert_eq!(m.input, 5.0);
    }

    #[test]
    fn wildcard_last_match_wins() {
        let t = PriceTable {
            rows: vec![
                PriceEntry {
                    pattern: "*".into(),
                    input: 9.0,
                    output: 9.0,
                    cache_read: 0.0,
                    cache_write: 0.0,
                },
                PriceEntry {
                    pattern: "gpt*".into(),
                    input: 1.0,
                    output: 1.0,
                    cache_read: 0.0,
                    cache_write: 0.0,
                },
            ],
        };
        assert_eq!(t.match_for("gpt-4o").unwrap().input, 1.0);
        assert_eq!(t.match_for("claude-3").unwrap().input, 9.0);
    }

    #[test]
    fn no_match_none() {
        assert!(table().match_for("claude-3-5").is_none());
    }

    #[test]
    fn estimate_basic() {
        assert_eq!(estimate_tokens(""), 0);
        assert!(estimate_tokens("hello world") > 0);
        // 中文在 cl100k 下约 1 字 1~2 token,不精确断言
        assert!(estimate_tokens("你好世界") > 0);
    }
}
