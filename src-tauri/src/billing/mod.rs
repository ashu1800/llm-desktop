pub mod estimate;
pub mod pricing;

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

/// 费用公式(PRD §3.6):
/// cost = (prompt − cache_read − cache_write) × 输入价 + cache_read × 缓存读价
///        + cache_write × 缓存写价 + completion × 输出价   (单价均 元/1M token)
///
/// 返回值单位为**微元**(1e-6 元,整数):旧「分」粒度下小额请求(如缓存长上下文
/// 0.0157 元)被四舍五入到 2 分,虚高近 30%;微元与 UI 的 6 位小数显示精确对齐。
///
/// 计算顺序:先在 token 量级聚合各项乘积、最后一步才除 1e6——每项
/// (token × 单价) 量级 ≤ 1e12,f64 精度足够;若先除再乘,大数值会引入 ±1 微元漂移。
pub fn compute_cost(price: &pricing::PriceEntry, usage: &Usage) -> i64 {
    let plain_input = (usage.prompt - usage.cache_read - usage.cache_write).max(0) as f64;
    let micro_yuan = plain_input * price.input
        + usage.cache_read as f64 * price.cache_read
        + usage.cache_write as f64 * price.cache_write
        + usage.completion as f64 * price.output;
    micro_yuan.round() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cost_formula() {
        // 输入 1 元/1M,输出 2 元/1M,缓存读 0.1 元/1M,缓存写 1.25 元/1M
        let p = pricing::PriceEntry {
            pattern: "m".into(),
            input: 1.0,
            output: 2.0,
            cache_read: 0.1,
            cache_write: 1.25,
        };
        // prompt=1_000_000(其中 cache_read=200_000, cache_write=100_000), completion=500_000
        let u = Usage {
            prompt: 1_000_000,
            completion: 500_000,
            cache_read: 200_000,
            cache_write: 100_000,
        };
        // (700_000*1 + 200_000*0.1 + 100_000*1.25 + 500_000*2)/1M = 1.845 元 = 1_845_000 微元
        assert_eq!(compute_cost(&p, &u), 1_845_000);
    }

    #[test]
    fn small_amount_keeps_precision() {
        // 缓存长上下文小额场景:0.0157 元,分粒度会被抹成 2 分(虚高 27%)
        let p = pricing::PriceEntry {
            pattern: "m".into(),
            input: 0.8,
            output: 2.8,
            cache_read: 0.23,
            cache_write: 0.0,
        };
        let u = Usage {
            prompt: 67_066,
            completion: 88,
            cache_read: 66_944,
            cache_write: 0,
        };
        // (122*0.8 + 66944*0.23 + 88*2.8)/1M = 0.01574112 元 → 15741 微元
        assert_eq!(compute_cost(&p, &u), 15_741);
    }

    #[test]
    fn zero_usage_zero_cost() {
        let p = pricing::PriceEntry {
            pattern: "m".into(),
            input: 1.0,
            output: 2.0,
            cache_read: 0.0,
            cache_write: 0.0,
        };
        assert_eq!(compute_cost(&p, &Usage::default()), 0);
    }
}
