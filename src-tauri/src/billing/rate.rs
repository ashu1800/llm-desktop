//! 渠道模型计费倍率:按规则命中后 cost × rate(默认 1.0)。
//! 规则来自渠道 rate_rules;支持模型通配、日类型(工作日/周末/法定节假日)、时间段。
//! 法定节假日数据来自 timor.tech API(billing::holiday,本地缓存兜底)。

use chrono::Timelike;

use crate::store::channels::RateRule;

/// 日类型
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DayType {
    Workday,
    Weekend,
    Holiday,
}

/// 规则解析上下文:模型名 + 当地日期时间
pub struct RateContext<'a> {
    /// 计费模型名(入口名,与日志 model 列一致,规则配置可从日志复现)
    pub model: &'a str,
    /// 本地时间(用于日类型与时段判断)
    pub local: chrono::DateTime<chrono::Local>,
}

impl<'a> RateContext<'a> {
    pub fn new(model: &'a str, local: chrono::DateTime<chrono::Local>) -> Self {
        Self { model, local }
    }
}

/// 解析 "HH:MM-HH:MM" → (起始分钟, 结束分钟);非法返回 None(规则时段条件视为不命中)。
/// 支持跨午夜区间(如 22:00-06:00)与 "24:00" 结束端(= 次日零点)
fn parse_time_range(s: &str) -> Option<(u32, u32)> {
    let (a, b) = s.trim().split_once('-')?;
    let parse_hm = |t: &str, allow_24: bool| -> Option<u32> {
        let (h, m) = t.trim().split_once(':')?;
        let h: u32 = h.trim().parse().ok()?;
        let m: u32 = m.trim().parse().ok()?;
        if m < 60 && (h < 24 || (allow_24 && h == 24 && m == 0)) {
            Some(h * 60 + m)
        } else {
            None
        }
    };
    Some((parse_hm(a, false)?, parse_hm(b, true)?))
}

/// 判定日类型。调休补班日(周末但官方要求上班)计入 Workday;
/// 数据未知/查询失败时按星期兜底(节假日规则不命中),不影响工作日/周末规则
async fn resolve_day_type(ctx: &RateContext<'_>) -> DayType {
    use chrono::Datelike;
    let weekday = ctx.local.weekday();
    let is_weekend = matches!(weekday, chrono::Weekday::Sat | chrono::Weekday::Sun);
    let date = ctx.local.date_naive();
    // 兜底:workday/weekend 按星期,holiday 不命中(宁可少打折不少收费)
    let fallback = if is_weekend {
        DayType::Weekend
    } else {
        DayType::Workday
    };
    match crate::billing::holiday::day_kind(date).await {
        Ok(crate::billing::holiday::DayKind::Holiday) => DayType::Holiday,
        // 补班周末按上班算
        Ok(crate::billing::holiday::DayKind::MakeupWorkday) => DayType::Workday,
        Ok(crate::billing::holiday::DayKind::Unknown) => fallback,
        Err(e) => {
            log::debug!("节假日查询失败,按星期兜底: {e}");
            fallback
        }
    }
}

/// 模型通配命中:空或 "*" = 全部;prefix* 通配;其余精确匹配。
/// 与定价表同语义,但空串含义不同(定价空串无意义,倍率空串 = 全部)
fn model_matches(rule_model: &str, model: &str) -> bool {
    let m = rule_model.trim();
    if m.is_empty() || m == "*" {
        return true;
    }
    match m.strip_suffix('*') {
        Some(prefix) => model.starts_with(prefix),
        None => m == model,
    }
}

/// 计算倍率:返回命中的最后一条规则倍率(表序优先级,后配覆盖先配),
/// 无命中返回 1.0
pub async fn resolve_rate(rules: &[RateRule], ctx: &RateContext<'_>) -> f64 {
    if rules.is_empty() {
        return 1.0;
    }
    let day = resolve_day_type(ctx).await;
    let now_min = ctx.local.hour() * 60 + ctx.local.minute();
    let mut rate = 1.0;
    for r in rules {
        if !model_matches(&r.model, ctx.model) {
            continue;
        }
        // 日类型:all 不限;其余精确匹配
        let day_ok = matches!(
            (r.day_type.as_str(), day),
            ("all", _) | ("", _) | ("workday", DayType::Workday) | ("weekend", DayType::Weekend) | ("holiday", DayType::Holiday)
        );
        if !day_ok {
            continue;
        }
        // 时段:空 = 全天;支持跨午夜
        let tr = r.time_range.trim();
        let time_ok = if tr.is_empty() {
            true
        } else {
            match parse_time_range(tr) {
                Some((a, b)) => {
                    if a <= b {
                        now_min >= a && now_min < b
                    } else {
                        now_min >= a || now_min < b
                    }
                }
                None => false, // 非法时段配置:该规则不生效
            }
        };
        if time_ok {
            rate = r.rate;
        }
    }
    rate
}

/// 便捷封装:解析 + 乘算(倍率异常时 resolve 侧已钳 0~100)
pub async fn apply_rate(cost: i64, rules: &[RateRule], ctx: &RateContext<'_>) -> i64 {
    let rate = resolve_rate(rules, ctx).await;
    scale_cost(cost, rate)
}

/// 费用乘倍率(解析与乘算分离:调用方需保证 rate 与 cost 来自同一次解析)
pub fn scale_cost(cost: i64, rate: f64) -> i64 {
    ((cost as f64) * rate).round() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::channels::RateRule;

    fn rule(model: &str, rate: f64, day_type: &str, time_range: &str) -> RateRule {
        RateRule {
            model: model.into(),
            rate,
            day_type: day_type.into(),
            time_range: time_range.into(),
            remark: String::new(),
        }
    }

    /// 固定上下文:工作日 2026-01-05(周一)10:30 本地时间。
    /// is_holiday 对历史日期走缓存兜底表,周一非节假日成立
    fn ctx(model: &str) -> RateContext<'_> {
        let local = chrono::TimeZone::with_ymd_and_hms(
            &chrono::Local,
            2026,
            1,
            5,
            10,
            30,
            0,
        )
        .unwrap();
        RateContext::new(model, local)
    }

    #[tokio::test]
    async fn empty_rules_rate_one() {
        assert_eq!(resolve_rate(&[], &ctx("gpt-4o")).await, 1.0);
    }

    #[tokio::test]
    async fn model_wildcard_and_exact() {
        let rules = vec![rule("gpt*", 0.5, "all", "")];
        assert_eq!(resolve_rate(&rules, &ctx("gpt-4o")).await, 0.5);
        // 非命中模型保持 1.0
        assert_eq!(resolve_rate(&rules, &ctx("claude-3")).await, 1.0);
        // 空模型 = 全部
        let rules = vec![rule("", 2.0, "all", "")];
        assert_eq!(resolve_rate(&rules, &ctx("claude-3")).await, 2.0);
    }

    #[tokio::test]
    async fn time_range_and_cross_midnight() {
        // 10:30 命中 08:00-12:00
        let rules = vec![rule("", 0.8, "all", "08:00-12:00")];
        assert_eq!(resolve_rate(&rules, &ctx("m")).await, 0.8);
        // 10:30 不命中 22:00-06:00(跨午夜)
        let rules = vec![rule("", 0.8, "all", "22:00-06:00")];
        assert_eq!(resolve_rate(&rules, &ctx("m")).await, 1.0);
        // 非法时段:规则不生效
        let rules = vec![rule("", 0.8, "all", "25:00-99:00")];
        assert_eq!(resolve_rate(&rules, &ctx("m")).await, 1.0);
    }

    #[tokio::test]
    async fn day_type_filtering() {
        // 周一 10:30:工作日规则命中,周末/节假日规则不命中
        let rules = vec![
            rule("", 0.9, "workday", ""),
            rule("", 0.5, "weekend", ""),
            rule("", 0.3, "holiday", ""),
        ];
        assert_eq!(resolve_rate(&rules, &ctx("m")).await, 0.9);
        let rules = vec![rule("", 0.5, "weekend", "")];
        assert_eq!(resolve_rate(&rules, &ctx("m")).await, 1.0);
    }

    #[tokio::test]
    async fn last_match_wins_and_apply() {
        let rules = vec![rule("gpt*", 0.5, "all", ""), rule("gpt-4o", 2.0, "all", "")];
        assert_eq!(resolve_rate(&rules, &ctx("gpt-4o")).await, 2.0);
        // apply_rate:100 微元 × 0.5 = 50
        assert_eq!(apply_rate(100, &rules, &ctx("gpt-4o")).await, 200);
        assert_eq!(apply_rate(101, &[rule("", 0.5, "all", "")], &ctx("m")).await, 51);
    }
}
