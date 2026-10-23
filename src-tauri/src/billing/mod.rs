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
pub fn compute_cost_fen(price: &pricing::PriceEntry, usage: &Usage) -> i64 {
    let plain_input = (usage.prompt - usage.cache_read - usage.cache_write).max(0) as f64;
    let yuan = (plain_input * price.input
        + usage.cache_read as f64 * price.cache_read
        + usage.cache_write as f64 * price.cache_write
        + usage.completion as f64 * price.output)
        / 1_000_000.0;
    (yuan * 100.0).round() as i64
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
        // (700_000*1 + 200_000*0.1 + 100_000*1.25 + 500_000*2)/1M = 0.7+0.02+0.125+1.0 = 1.845 元 = 184.5 分 → 185(四舍五入)
        assert_eq!(compute_cost_fen(&p, &u), 185);
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
        assert_eq!(compute_cost_fen(&p, &Usage::default()), 0);
    }
}
