use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// n 位随机小写 hex(用于密钥与 id 生成)
pub fn rand_hex(n: usize) -> String {
    use rand::Rng;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut rng = rand::rng();
    (0..n).map(|_| HEX[rng.random_range(0..16)] as char).collect()
}

/// 常量时间字符串比较(自建密钥校验)
pub fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// 按 UTF-8 字符边界截断,超长时追加省略标记(日志快照 32KB 上限用)
pub fn truncate_utf8(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n…[已截断]", &s[..end])
}

/// HTTP header 值只允许 ASCII:非可见字节(如中文渠道名)做百分号编码
pub fn header_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        if b.is_ascii_graphic() && b != b'%' {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn header_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if let (Some(h), Some(l)) = (
                bytes.get(i + 1).and_then(|c| (*c as char).to_digit(16)),
                bytes.get(i + 2).and_then(|c| (*c as char).to_digit(16)),
            ) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// User-Agent → 客户端识别;未知显示原始 UA 前 20 字符
pub fn ua_to_client(ua: &str) -> String {
    let l = ua.to_lowercase();
    let hit = |k: &str| l.contains(k);
    let name = if hit("claude-cli") {
        "Claude Code"
    } else if hit("codex_cli") || hit("codex-cli") || l.starts_with("codex/") {
        "Codex CLI"
    } else if hit("gemini-cli") || hit("gemini_cli") {
        "Gemini CLI"
    } else if hit("cherrystudio") {
        "Cherry Studio"
    } else if hit("chatbox") {
        "ChatBox"
    } else if hit("lobechat") {
        "LobeChat"
    } else if hit("openwebui") {
        "OpenWebUI"
    } else if hit("roo-code") || hit("roo code") {
        "Roo Code"
    } else if hit("cline") {
        "Cline"
    } else if hit("dify") {
        "Dify"
    } else if ua.trim().is_empty() {
        "未知"
    } else {
        return ua.chars().take(20).collect();
    };
    name.to_string()
}

/// Base URL 拼接:兼容 base 以 "/" 或 "/v1" 结尾的中转站写法
/// suffix 传入带版本前缀的完整路径,如 "/v1/chat/completions"
pub fn join_base(base: &str, suffix: &str) -> String {
    let mut b = base.trim().trim_end_matches('/').to_string();
    let first_seg = suffix.trim_start_matches('/');
    // base 已含 "/v1" 且 suffix 以 "/v1/..." 开头时避免出现 /v1/v1
    if b.ends_with("/v1") && first_seg.starts_with("v1/") {
        b.push_str(&suffix[3..]);
    } else {
        b.push('/');
        b.push_str(first_seg);
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ct_eq_basic() {
        assert!(ct_eq("sk-gw-abc", "sk-gw-abc"));
        assert!(!ct_eq("sk-gw-abc", "sk-gw-abd"));
        assert!(!ct_eq("sk-gw-abc", "sk-gw-ab"));
    }

    #[test]
    fn truncate_respects_char_boundary() {
        let s = "中文".repeat(100);
        let t = truncate_utf8(&s, 10);
        assert!(t.contains("已截断"));
        assert!(t.is_char_boundary(t.len() - "…\n[已截断]".len()));
    }

    #[test]
    fn join_base_variants() {
        assert_eq!(
            join_base("https://api.example.com", "/v1/chat/completions"),
            "https://api.example.com/v1/chat/completions"
        );
        assert_eq!(
            join_base("https://api.example.com/", "/v1/chat/completions"),
            "https://api.example.com/v1/chat/completions"
        );
        assert_eq!(
            join_base("https://relay.example.com/v1", "/v1/chat/completions"),
            "https://relay.example.com/v1/chat/completions"
        );
        assert_eq!(
            join_base("https://api.anthropic.com", "/v1/messages"),
            "https://api.anthropic.com/v1/messages"
        );
    }

    #[test]
    fn ua_identification() {
        assert_eq!(ua_to_client("claude-cli/1.0.0 (external)"), "Claude Code");
        assert_eq!(ua_to_client("codex_cli_rs/0.1.0"), "Codex CLI");
        assert_eq!(ua_to_client("CherryStudio/1.0"), "Cherry Studio");
        assert_eq!(ua_to_client("weird-agent/9"), "weird-agent/9");
        assert_eq!(ua_to_client(""), "未知");
    }

    #[test]
    fn header_encode_roundtrip() {
        let name = "好渠道-1";
        let enc = header_encode(name);
        assert!(enc.is_ascii());
        assert_eq!(header_decode(&enc), name);
        assert_eq!(header_decode(&header_encode("plain-key")), "plain-key");
    }

    #[test]
    fn rand_hex_len() {
        assert_eq!(rand_hex(32).len(), 32);
        assert!(rand_hex(32).chars().all(|c| c.is_ascii_hexdigit()));
    }
}
