use serde::{Deserialize, Serialize};

/// 应用设置(全局唯一,settings 表 key = "app")
/// 字段默认值均为拍板决策,见 PRD §3.8 / §11
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppSettings {
    pub port: u16,
    pub listen_addr: String,
    pub autostart: bool,
    pub silent_start: bool,
    /// true = 关闭窗口隐藏到托盘;false = 真正退出
    pub close_to_tray: bool,
    pub log_retention_days: u32,
    pub save_full_body: bool,
    /// light | dark | system
    pub theme: String,
    pub language: String,
    pub breaker: BreakerDefaults,
    pub timeouts: TimeoutDefaults,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BreakerDefaults {
    /// 滑动窗口秒数
    pub window_secs: u64,
    /// 连续失败阈值
    pub consecutive_failures: u32,
    /// 窗口内最小样本数
    pub sample_min: u32,
    /// 失败率阈值(0-1)
    pub failure_rate: f64,
    /// 冷却期秒数
    pub cooldown_secs: u64,
    /// 指数退避上限秒数
    pub backoff_max_secs: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TimeoutDefaults {
    pub connect_secs: u64,
    /// 首字超时(从发起上游请求到第一个 SSE data 字节)
    pub ttft_secs: u64,
    /// 流式空闲超时(相邻两次上游数据最大间隔;流式无总时长硬顶)
    pub stream_idle_secs: u64,
    /// 非流式请求总时长
    pub non_stream_total_secs: u64,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            port: 8787,
            listen_addr: "127.0.0.1".into(),
            autostart: false,
            silent_start: false,
            close_to_tray: true,
            log_retention_days: 90,
            save_full_body: false,
            theme: "system".into(),
            language: "zh-CN".into(),
            breaker: BreakerDefaults::default(),
            timeouts: TimeoutDefaults::default(),
        }
    }
}

impl Default for BreakerDefaults {
    fn default() -> Self {
        Self {
            window_secs: 60,
            consecutive_failures: 5,
            sample_min: 10,
            failure_rate: 0.5,
            cooldown_secs: 60,
            backoff_max_secs: 600,
        }
    }
}

impl Default for TimeoutDefaults {
    fn default() -> Self {
        Self {
            connect_secs: 10,
            ttft_secs: 120,
            stream_idle_secs: 120,
            non_stream_total_secs: 600,
        }
    }
}

impl AppSettings {
    /// 对外部输入做钳制,保证存储值始终合法
    pub fn normalized(mut self) -> Self {
        if self.port == 0 {
            self.port = 8787;
        }
        if self.listen_addr.trim().is_empty() {
            self.listen_addr = "127.0.0.1".into();
        }
        if !matches!(self.theme.as_str(), "light" | "dark" | "system") {
            self.theme = "system".into();
        }
        if self.language.trim().is_empty() {
            self.language = "zh-CN".into();
        }
        self.log_retention_days = self.log_retention_days.clamp(1, 3650);
        self.breaker.window_secs = self.breaker.window_secs.clamp(10, 3600);
        self.breaker.consecutive_failures = self.breaker.consecutive_failures.clamp(1, 100);
        self.breaker.sample_min = self.breaker.sample_min.clamp(1, 1000);
        if !(0.0..=1.0).contains(&self.breaker.failure_rate) {
            self.breaker.failure_rate = 0.5;
        }
        self.breaker.cooldown_secs = self.breaker.cooldown_secs.clamp(5, 3600);
        self.breaker.backoff_max_secs = self
            .breaker
            .backoff_max_secs
            .clamp(self.breaker.cooldown_secs.max(5), 7200);
        self.timeouts.connect_secs = self.timeouts.connect_secs.clamp(1, 300);
        self.timeouts.ttft_secs = self.timeouts.ttft_secs.clamp(5, 3600);
        self.timeouts.stream_idle_secs = self.timeouts.stream_idle_secs.clamp(5, 3600);
        self.timeouts.non_stream_total_secs = self.timeouts.non_stream_total_secs.clamp(5, 7200);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_values_match_prd() {
        let s = AppSettings::default();
        assert_eq!(s.port, 8787);
        assert_eq!(s.listen_addr, "127.0.0.1");
        assert!(s.close_to_tray);
        assert_eq!(s.log_retention_days, 90);
        assert_eq!(s.timeouts.ttft_secs, 120);
        assert_eq!(s.timeouts.stream_idle_secs, 120);
        assert_eq!(s.breaker.cooldown_secs, 60);
        assert_eq!(s.breaker.backoff_max_secs, 600);
    }

    #[test]
    fn partial_json_fills_defaults() {
        let s: AppSettings = serde_json::from_str(r#"{"port": 9000}"#).unwrap();
        assert_eq!(s.port, 9000);
        assert_eq!(s.listen_addr, "127.0.0.1");
        assert_eq!(s.breaker.consecutive_failures, 5);
    }

    #[test]
    fn normalized_clamps() {
        let s = AppSettings {
            port: 0,
            log_retention_days: 99999,
            timeouts: TimeoutDefaults {
                ttft_secs: 1,
                ..Default::default()
            },
            ..Default::default()
        };
        let n = s.normalized();
        assert_eq!(n.port, 8787);
        assert_eq!(n.log_retention_days, 3650);
        assert_eq!(n.timeouts.ttft_secs, 5);
    }
}
