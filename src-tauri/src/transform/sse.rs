/// SSE(text/event-stream)增量解析与写出工具。
/// 只需支持数据面用到的子集:event / data 字段与 ":" 注释行。
#[derive(Debug, Clone, Default)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
}

#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
    cur_event: String,
    cur_data: String,
}

impl SseParser {
    pub fn feed(&mut self, bytes: &[u8], out: &mut Vec<SseEvent>) {
        self.buf.extend_from_slice(bytes);
        let mut pos = 0;
        let buf = &self.buf;
        while let Some(nl) = buf[pos..].iter().position(|&b| b == b'\n') {
            let line_end = pos + nl;
            let mut line = &buf[pos..line_end];
            if line.last() == Some(&b'\r') {
                line = &line[..line.len() - 1];
            }
            Self::handle_line(line, &mut self.cur_event, &mut self.cur_data, out);
            pos = line_end + 1;
        }
        self.buf.drain(..pos);
    }

    fn handle_line(line: &[u8], cur_event: &mut String, cur_data: &mut String, out: &mut Vec<SseEvent>) {
        // 空行 = 事件边界
        if line.is_empty() {
            if !cur_data.is_empty() {
                let data = cur_data.trim_end_matches('\n').to_string();
                out.push(SseEvent {
                    event: std::mem::take(cur_event),
                    data,
                });
                cur_data.clear();
            }
            return;
        }
        // 注释行(keep-alive):": keep-alive"
        if line[0] == b':' {
            return;
        }
        let (field, value) = match line.iter().position(|&b| b == b':') {
            Some(i) => (&line[..i], &line[i + 1..]),
            None => (line, &b""[..]),
        };
        let value = if value.first() == Some(&b' ') {
            &value[1..]
        } else {
            value
        };
        match field {
            b"event" => *cur_event = String::from_utf8_lossy(value).into_owned(),
            b"data" => {
                cur_data.push_str(&String::from_utf8_lossy(value));
                cur_data.push('\n');
            }
            _ => {} // id / retry 等数据面用不到
        }
    }
}

pub fn data_line(json: &str) -> String {
    format!("data: {json}\n\n")
}

pub fn done_line() -> String {
    "data: [DONE]\n\n".to_string()
}

pub fn event_line(event: &str, json: &str) -> String {
    format!("event: {event}\ndata: {json}\n\n")
}

/// SSE 注释行 keep-alive(跨协议转换时按 15s 间隔自行发送)
pub fn keepalive_line() -> String {
    ":\n\n".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_all(parser: &mut SseParser, s: &str) -> Vec<SseEvent> {
        let mut out = Vec::new();
        parser.feed(s.as_bytes(), &mut out);
        out
    }

    #[test]
    fn parses_basic_events() {
        let mut p = SseParser::default();
        let ev = feed_all(&mut p, "data: {\"a\":1}\n\ndata: [DONE]\n\n");
        assert_eq!(ev.len(), 2);
        assert_eq!(ev[0].data, "{\"a\":1}");
        assert_eq!(ev[1].data, "[DONE]");
    }

    #[test]
    fn parses_named_event_and_comments() {
        let mut p = SseParser::default();
        let ev = feed_all(
            &mut p,
            ": keep-alive\nevent: content_block_delta\ndata: {\"x\":true}\n\n",
        );
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0].event, "content_block_delta");
        assert_eq!(ev[0].data, "{\"x\":true}");
    }

    #[test]
    fn splits_across_chunks_and_crlf() {
        let mut p = SseParser::default();
        let mut out = Vec::new();
        p.feed(b"data: {\"a\"", &mut out);
        assert!(out.is_empty());
        p.feed(b":1}\r\n\r\ndata: two\r\n\r\n", &mut out);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].data, "{\"a\":1}");
        assert_eq!(out[1].data, "two");
    }

    #[test]
    fn multiline_data_joins_newline() {
        let mut p = SseParser::default();
        let ev = feed_all(&mut p, "data: l1\ndata: l2\n\n");
        assert_eq!(ev[0].data, "l1\nl2");
    }
}
