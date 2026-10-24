pub mod estimate;
pub mod holiday;
pub mod pricing;
pub mod rate;

use serde::{Deserialize, Serialize};

/// 四类 token 用量(缓存缺失记 0)
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    pub prompt: i64,
    pub completion: i64,
    pub cache_read: i64,
    pub cache_write: i64,
}

impl Usage {
    // 缓存命中率等派生值由前端按 prompt/cache_read 计算
}

/// 计费币种:定价条目可按人民币或美元标价,日志与统计按条目实际币种记账
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Currency {
    #[default]
    Cny,
    Usd,
}

impl Currency {
    /// 日志列存储值
    pub fn as_str(self) -> &'static str {
        match self {
            Currency::Cny => "cny",
            Currency::Usd => "usd",
        }
    }

    /// 日志列值解析(未知值回退人民币:历史行兼容)
    pub fn parse(s: &str) -> Self {
        match s {
            "usd" => Currency::Usd,
            _ => Currency::Cny,
        }
    }
}

/// 费用公式(PRD §3.6):
/// cost = (prompt − cache_read − cache_write) × 输入价 + cache_read × 缓存读价
///        + cache_write × 缓存写价 + completion × 输出价   (单价均 /1M token)
///
/// 返回值单位为**微**(1e-6):人民币 = 微元(1e-6 元),美元 = 微美元(1e-6 $),
/// 与 UI 的 6 位小数显示精确对齐;两种币种互不换算、分列统计。
///
/// 计算顺序:先在 token 量级聚合各项乘积、最后一步才除 1e6——每项
/// (token × 单价) 量级 ≤ 1e12,f64 精度足够;若先除再乘,大数值会引入 ±1 微元漂移。
pub fn compute_cost(prices: (f64, f64, f64, f64), usage: &Usage) -> i64 {
    let (p_in, p_out, p_cr, p_cw) = prices;
    let plain_input = (usage.prompt - usage.cache_read - usage.cache_write).max(0) as f64;
    let micro = plain_input * p_in
        + usage.cache_read as f64 * p_cr
        + usage.cache_write as f64 * p_cw
        + usage.completion as f64 * p_out;
    micro.round() as i64
}

/// 定价条目 + 渠道币种 → 实际计费(价格组, 币种)。
/// 双向回退,保持"宁可低估不报错中断请求":
/// - usd 请求但模型未配美元价 → 回退人民币
/// - cny 请求但人民币组全零(0006 迁移把旧 usd 条目的人民币列清零)且美元组有价
///   → 回退美元。否则这些模型在默认 cny 渠道被静默记 0 费用
pub fn resolve_pricing(
    price: &pricing::PriceEntry,
    currency: Currency,
) -> ((f64, f64, f64, f64), Currency) {
    if let Some(p) = price.prices_for(currency) {
        // 目标币种有价组;但人民币组"全零"可能是迁移清零而非真实定价:
        // 此时若美元组有价,按美元计(与该条目的历史语义一致)
        if currency == Currency::Cny && p.0 == 0.0 && p.1 == 0.0 && price.has_usd() {
            if let Some(usd) = price.prices_for(Currency::Usd) {
                if usd.0 != 0.0 || usd.1 != 0.0 {
                    return (usd, Currency::Usd);
                }
            }
        }
        return (p, currency);
    }
    (
        price
            .prices_for(Currency::Cny)
            .unwrap_or((0.0, 0.0, 0.0, 0.0)),
        Currency::Cny,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(input: f64, output: f64, cr: f64, cw: f64) -> pricing::PriceEntry {
        pricing::PriceEntry {
            pattern: "m".into(),
            input,
            output,
            cache_read: cr,
            cache_write: cw,
            input_usd: None,
            output_usd: None,
            cache_read_usd: None,
            cache_write_usd: None,
        }
    }

    #[test]
    fn cost_formula() {
        // 输入 1 元/1M,输出 2 元/1M,缓存读 0.1 元/1M,缓存写 1.25 元/1M
        let u = Usage {
            prompt: 1_000_000,
            completion: 500_000,
            cache_read: 200_000,
            cache_write: 100_000,
        };
        // (700_000*1 + 200_000*0.1 + 100_000*1.25 + 500_000*2)/1M = 1.845 元 = 1_845_000 微元
        assert_eq!(compute_cost((1.0, 2.0, 0.1, 1.25), &u), 1_845_000);
    }

    #[test]
    fn small_amount_keeps_precision() {
        // 缓存长上下文小额场景:0.0157 元,分粒度会被抹成 2 分(虚高 27%)
        let u = Usage {
            prompt: 67_066,
            completion: 88,
            cache_read: 66_944,
            cache_write: 0,
        };
        // (122*0.8 + 66944*0.23 + 88*2.8)/1M = 0.01574112 元 → 15741 微元
        assert_eq!(compute_cost((0.8, 2.8, 0.23, 0.0), &u), 15_741);
    }

    #[test]
    fn zero_usage_zero_cost() {
        assert_eq!(compute_cost((1.0, 2.0, 0.0, 0.0), &Usage::default()), 0);
    }

    #[test]
    fn dual_currency_resolution() {
        // 双币种条目:渠道币种决定取哪组价
        let mut p = entry(1.0, 2.0, 0.1, 0.2);
        p.input_usd = Some(0.1);
        p.output_usd = Some(0.3);
        p.cache_read_usd = Some(0.01);
        p.cache_write_usd = None;
        let (cny_prices, cur) = resolve_pricing(&p, Currency::Cny);
        assert_eq!(cur, Currency::Cny);
        assert_eq!(cny_prices, (1.0, 2.0, 0.1, 0.2));
        let (usd_prices, cur) = resolve_pricing(&p, Currency::Usd);
        assert_eq!(cur, Currency::Usd);
        assert_eq!(usd_prices, (0.1, 0.3, 0.01, 0.0));
        assert!(p.has_usd());

        // 未配美元:美元请求回退人民币
        let plain = entry(1.0, 2.0, 0.1, 0.2);
        let (fb_prices, cur) = resolve_pricing(&plain, Currency::Usd);
        assert_eq!(cur, Currency::Cny);
        assert_eq!(fb_prices, (1.0, 2.0, 0.1, 0.2));
    }
}
