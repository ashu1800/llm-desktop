//! 熔断器:渠道维度全局共享状态机(Closed / Open / HalfOpen)。
//! - 打开条件:连续失败 ≥ 阈值,或窗口样本 ≥ sample_min 且失败率 ≥ 阈值
//! - 冷却:指数退避 60→120→240…上限 backoff_max;429 Retry-After 可覆盖单次冷却(上限 10 分钟)
//! - 半开:冷却结束放行 1 个探测请求;成功关闭,失败翻倍重新打开
//!
//! 状态为进程内存态,重启重置(PRD §8)。

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Closed,
    Open,
    HalfOpen,
}

impl State {
    pub fn as_str(&self) -> &'static str {
        match self {
            State::Closed => "closed",
            State::Open => "open",
            State::HalfOpen => "half_open",
        }
    }
}

#[derive(Debug, Clone)]
pub struct BreakerParams {
    pub window: Duration,
    pub consecutive_failures: u32,
    pub sample_min: u32,
    pub failure_rate: f64,
    pub cooldown: Duration,
    pub backoff_max: Duration,
}

impl BreakerParams {
    pub fn from_settings(b: &crate::settings::BreakerDefaults) -> Self {
        Self {
            window: Duration::from_secs(b.window_secs),
            consecutive_failures: b.consecutive_failures,
            sample_min: b.sample_min,
            failure_rate: b.failure_rate,
            cooldown: Duration::from_secs(b.cooldown_secs),
            backoff_max: Duration::from_secs(b.backoff_max_secs),
        }
    }
}

struct ChannelBreaker {
    state: State,
    consecutive_failures: u32,
    window: VecDeque<(Instant, bool)>,
    open_until: Instant,
    current_cooldown: Duration,
    half_open_inflight: bool,
}

impl Default for ChannelBreaker {
    fn default() -> Self {
        Self::new()
    }
}

impl ChannelBreaker {
    fn new() -> Self {
        Self {
            state: State::Closed,
            consecutive_failures: 0,
            window: VecDeque::new(),
            open_until: Instant::now(),
            current_cooldown: Duration::ZERO,
            half_open_inflight: false,
        }
    }

    fn prune_window(&mut self, window: Duration) {
        let cutoff = Instant::now() - window;
        while let Some(&(t, _)) = self.window.front() {
            if t < cutoff {
                self.window.pop_front();
            } else {
                break;
            }
        }
    }
}

/// 状态迁移结果:供上层发事件 / 刷新托盘
#[derive(Debug, Clone, Copy)]
pub struct Transition {
    pub state: State,
    /// Open 状态剩余冷却秒数(其余状态为 0)
    pub remaining_secs: u64,
}

#[derive(Default)]
pub struct BreakerTable {
    inner: Mutex<HashMap<i64, ChannelBreaker>>,
}

impl BreakerTable {
    /// 是否放行请求;Open 到期自动转 HalfOpen 并放行 1 个探测
    pub fn allow(&self, channel_id: i64, _params: &BreakerParams) -> bool {
        let mut map = self.inner.lock().unwrap();
        let b = map.entry(channel_id).or_default();
        match b.state {
            State::Closed => true,
            State::Open => {
                if Instant::now() >= b.open_until {
                    b.state = State::HalfOpen;
                    b.half_open_inflight = true;
                    true
                } else {
                    false
                }
            }
            State::HalfOpen => !b.half_open_inflight,
        }
    }

    pub fn record_success(&self, channel_id: i64, params: &BreakerParams) -> Option<Transition> {
        let mut map = self.inner.lock().unwrap();
        let b = map.entry(channel_id).or_default();
        let before = b.state;
        match b.state {
            State::HalfOpen => {
                // 成功关闭:计数与窗口清零,冷却恢复默认
                *b = ChannelBreaker::new();
                b.state = State::Closed;
                b.current_cooldown = params.cooldown;
                Some(Transition { state: State::Closed, remaining_secs: 0 })
            }
            State::Closed => {
                b.consecutive_failures = 0;
                b.prune_window(params.window);
                b.window.push_back((Instant::now(), true));
                if before != State::Closed {
                    Some(Transition { state: State::Closed, remaining_secs: 0 })
                } else {
                    None
                }
            }
            State::Open => None, // 不应发生(Open 时被拒)
        }
    }

    /// 记失败;返回 Some(Transition) 表示状态迁移(→ Open 或冷却变化)
    pub fn record_failure(
        &self,
        channel_id: i64,
        params: &BreakerParams,
        retry_after: Option<Duration>,
    ) -> Option<Transition> {
        let mut map = self.inner.lock().unwrap();
        let b = map.entry(channel_id).or_default();
        b.consecutive_failures += 1;
        match b.state {
            State::HalfOpen => {
                // 探测失败:重新打开,冷却翻倍
                b.current_cooldown = if b.current_cooldown.is_zero() {
                    params.cooldown
                } else {
                    (b.current_cooldown * 2).min(params.backoff_max)
                };
                if let Some(ra) = retry_after {
                    b.current_cooldown = b.current_cooldown.max(ra.min(Duration::from_secs(600)));
                }
                b.current_cooldown = b.current_cooldown.min(params.backoff_max.max(Duration::from_secs(600)));
                b.state = State::Open;
                b.half_open_inflight = false;
                b.open_until = Instant::now() + b.current_cooldown;
                Some(Transition {
                    state: State::Open,
                    remaining_secs: b.current_cooldown.as_secs(),
                })
            }
            State::Closed => {
                b.prune_window(params.window);
                b.window.push_back((Instant::now(), false));
                let samples = b.window.len() as u32;
                let failures = b.window.iter().filter(|(_, ok)| !ok).count() as u32;
                let failure_rate = if samples > 0 {
                    failures as f64 / samples as f64
                } else {
                    0.0
                };
                let should_open = b.consecutive_failures >= params.consecutive_failures
                    || (samples >= params.sample_min && failure_rate >= params.failure_rate);
                if should_open {
                    b.current_cooldown = params.cooldown;
                    if let Some(ra) = retry_after {
                        b.current_cooldown = b.current_cooldown.max(ra.min(Duration::from_secs(600)));
                    }
                    b.state = State::Open;
                    b.open_until = Instant::now() + b.current_cooldown;
                    Some(Transition {
                        state: State::Open,
                        remaining_secs: b.current_cooldown.as_secs(),
                    })
                } else {
                    None
                }
            }
            State::Open => None,
        }
    }

    /// 手动恢复:强制关闭并清空统计
    pub fn reset(&self, channel_id: i64) -> Option<Transition> {
        let mut map = self.inner.lock().unwrap();
        let b = map.entry(channel_id).or_default();
        if b.state == State::Closed {
            b.consecutive_failures = 0;
            b.window.clear();
            return None;
        }
        *b = ChannelBreaker::new();
        Some(Transition { state: State::Closed, remaining_secs: 0 })
    }

    pub fn status(&self, channel_id: i64) -> Transition {
        let map = self.inner.lock().unwrap();
        match map.get(&channel_id) {
            Some(b) => {
                let remaining = b
                    .open_until
                    .checked_duration_since(Instant::now())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                Transition { state: b.state, remaining_secs: if b.state == State::Open { remaining } else { 0 } }
            }
            None => Transition { state: State::Closed, remaining_secs: 0 },
        }
    }

    /// 清空全部渠道状态(配置导入后渠道 id 全部重排时调用)
    pub fn clear_all(&self) {
        self.inner.lock().unwrap().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> BreakerParams {
        BreakerParams {
            window: Duration::from_secs(60),
            consecutive_failures: 3,
            sample_min: 5,
            failure_rate: 0.5,
            cooldown: Duration::from_secs(60),
            backoff_max: Duration::from_secs(600),
        }
    }

    #[test]
    fn opens_on_consecutive_failures_and_half_open_recovers() {
        let t = BreakerTable::default();
        let p = params();
        assert!(t.allow(1, &p));
        t.record_success(1, &p);
        assert!(t.allow(1, &p));
        t.record_failure(1, &p, None);
        assert_eq!(t.status(1).state, State::Closed);
        t.record_failure(1, &p, None);
        t.record_failure(1, &p, None);
        // 连续失败 3 次 → Open
        assert_eq!(t.status(1).state, State::Open);
        assert!(!t.allow(1, &p));

        // 冷却期人为过期 → HalfOpen 放行 1 个
        {
            let mut map = t.inner.lock().unwrap();
            map.get_mut(&1).unwrap().open_until = Instant::now() - Duration::from_secs(1);
        }
        assert!(t.allow(1, &p));
        assert!(!t.allow(1, &p)); // 探测名额被占
        assert_eq!(t.record_success(1, &p).unwrap().state, State::Closed);
        assert!(t.allow(1, &p));
    }

    #[test]
    fn half_open_failure_doubles_cooldown() {
        let t = BreakerTable::default();
        let p = params();
        for _ in 0..3 {
            t.record_failure(2, &p, None);
        }
        assert_eq!(t.status(2).state, State::Open);
        {
            let mut map = t.inner.lock().unwrap();
            map.get_mut(&2).unwrap().open_until = Instant::now() - Duration::from_secs(1);
            map.get_mut(&2).unwrap().current_cooldown = p.cooldown;
        }
        assert!(t.allow(2, &p)); // half-open
        let tr = t.record_failure(2, &p, None).unwrap();
        assert_eq!(tr.state, State::Open);
        assert_eq!(tr.remaining_secs, 120); // 60 × 2
        // 再失败翻倍
        {
            let mut map = t.inner.lock().unwrap();
            map.get_mut(&2).unwrap().open_until = Instant::now() - Duration::from_secs(1);
        }
        assert!(t.allow(2, &p));
        let tr = t.record_failure(2, &p, None).unwrap();
        assert_eq!(tr.remaining_secs, 240);
    }

    #[test]
    fn failure_rate_rule() {
        let t = BreakerTable::default();
        let p = params(); // sample_min=5, rate=0.5
        // 2 失败 4 成功(33%)不触发(穿插保证连续失败 < 3)
        t.record_failure(3, &p, None);
        t.record_success(3, &p);
        t.record_success(3, &p);
        t.record_failure(3, &p, None);
        t.record_success(3, &p);
        t.record_success(3, &p);
        assert_eq!(t.status(3).state, State::Closed);
        // 8 样本 4 失败(50%)→ Open
        t.record_failure(3, &p, None);
        t.record_failure(3, &p, None);
        assert_eq!(t.status(3).state, State::Open);
    }

    #[test]
    fn retry_after_extends_cooldown() {
        let t = BreakerTable::default();
        let p = params();
        t.record_failure(4, &p, None);
        t.record_failure(4, &p, None);
        // 第 3 次连续失败触发打开,Retry-After=300s 覆盖默认 60s 冷却
        let tr = t
            .record_failure(4, &p, Some(Duration::from_secs(300)))
            .unwrap();
        assert_eq!(tr.state, State::Open);
        assert_eq!(tr.remaining_secs, 300);
        // Retry-After 上限 10 分钟(独立渠道,同样凑足 3 连败)
        t.record_failure(5, &p, None);
        t.record_failure(5, &p, None);
        let tr = t
            .record_failure(5, &p, Some(Duration::from_secs(3600)))
            .unwrap();
        assert_eq!(tr.remaining_secs, 600);
    }

    #[test]
    fn reset_forces_closed() {
        let t = BreakerTable::default();
        let p = params();
        for _ in 0..3 {
            t.record_failure(5, &p, None);
        }
        assert_eq!(t.status(5).state, State::Open);
        assert_eq!(t.reset(5).unwrap().state, State::Closed);
        assert_eq!(t.status(5).state, State::Closed);
        assert!(t.allow(5, &p));
    }

    #[test]
    fn window_expiry_forgets_old_failures() {
        let t = BreakerTable::default();
        let p = BreakerParams {
            window: Duration::from_millis(50),
            // 连续阈值调大,隔离窗口判定维度(连续计数无时间衰减,符合 PRD 语义)
            consecutive_failures: 10,
            sample_min: 5,
            failure_rate: 0.5,
            cooldown: Duration::from_secs(60),
            backoff_max: Duration::from_secs(600),
        };
        t.record_failure(6, &p, None);
        t.record_failure(6, &p, None);
        std::thread::sleep(Duration::from_millis(80));
        t.record_failure(6, &p, None);
        t.record_failure(6, &p, None);
        // 窗口内只有 2 个样本(< sample_min)→ 不开
        assert_eq!(t.status(6).state, State::Closed);
    }
}
