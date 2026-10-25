use serde::{Deserialize, Serialize};
use sqlx::{Executor, SqlitePool};

use crate::proto::UpstreamProto;
use crate::util::now_ms;

/// 渠道级超时覆盖(None 字段 = 跟随全局)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeoutOverride {
    #[serde(default)]
    pub connect_secs: Option<u64>,
    #[serde(default)]
    pub ttft_secs: Option<u64>,
    #[serde(default)]
    pub stream_idle_secs: Option<u64>,
    #[serde(default)]
    pub non_stream_total_secs: Option<u64>,
}

/// 渠道级熔断参数覆盖(None 字段 = 跟随全局)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakerOverride {
    #[serde(default)]
    pub window_secs: Option<u64>,
    #[serde(default)]
    pub consecutive_failures: Option<u32>,
    #[serde(default)]
    pub sample_min: Option<u32>,
    #[serde(default)]
    pub failure_rate: Option<f64>,
    #[serde(default)]
    pub cooldown_secs: Option<u64>,
    #[serde(default)]
    pub backoff_max_secs: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub id: i64,
    pub name: String,
    pub protocol: UpstreamProto,
    pub base_url: String,
    /// 上游密钥池,请求时轮询
    pub api_keys: Vec<String>,
    pub enabled: bool,
    /// None=跟随系统代理;Some("")=强制直连;Some(url)=自定义代理
    pub proxy: Option<String>,
    /// 渠道级并发上限;None/0 = 不限。调度侧据此限制同时在途请求数
    #[serde(default)]
    pub max_concurrency: Option<i64>,
    /// 支持的模型列表;空 = 不限制
    pub models: Vec<String>,
    /// 入站模型名 → 上游模型名,精确匹配,未命中原样透传
    pub model_map: std::collections::HashMap<String, String>,
    pub timeout_override: Option<TimeoutOverride>,
    pub breaker_override: Option<BreakerOverride>,
    pub remark: String,
    /// 渠道图标:emoji(≤8 字符)或图片 dataURL(png/svg 等,64KB 上限);
    /// 空 = 不显示。仅前端展示,不参与路由
    #[serde(default)]
    pub icon: String,
    /// 计费币种:"cny"(默认)|"usd"。请求走此渠道时按该币种取定价表对应价格组;
    /// 选 usd 但模型未配美元价时回退人民币
    #[serde(default)]
    pub price_currency: String,
    /// 模型计费倍率规则:按条件命中后 cost × 倍率(默认 1.0)。
    /// 空数组 = 全部按 1.0。条件支持通配模型、节假日/工作日/星期、时间段
    #[serde(default)]
    pub rate_rules: Vec<RateRule>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 单条倍率规则:命中的请求按 rate 乘算费用。
/// model 为空或 " *" = 全部模型;pattern 支持 prefix* 通配
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateRule {
    /// 模型名或 prefix* 通配;空串 = 全部模型
    #[serde(default)]
    pub model: String,
    /// 倍率(0.0~100);1 = 不变
    pub rate: f64,
    /// 生效日类型:all=不限 | workday=工作日(周一~五) | weekend=周末 | holiday=法定节假日
    #[serde(default)]
    pub day_type: String,
    /// 生效时间段 "HH:MM-HH:MM"(本地时区);空 = 全天
    #[serde(default)]
    pub time_range: String,
    /// 备注(如"春节 5 折")
    #[serde(default)]
    pub remark: String,
}

#[derive(sqlx::FromRow)]
struct ChannelRow {
    id: i64,
    name: String,
    protocol: String,
    base_url: String,
    api_keys: String,
    enabled: bool,
    proxy: Option<String>,
    #[sqlx(default)]
    max_concurrency: Option<i64>,
    models: String,
    model_map: String,
    timeout_override: Option<String>,
    breaker_override: Option<String>,
    remark: String,
    #[sqlx(default)]
    icon: String,
    #[sqlx(default)]
    price_currency: String,
    rate_rules: String,
    created_at: i64,
    updated_at: i64,
}

/// JSON 字段解析:损坏时回退默认值但必须告警——渠道密钥池静默清空会让
/// 渠道变成"未配置上游密钥"而失效,用户需知道数据已损坏
fn parse_json<T: serde::de::DeserializeOwned>(field: &str, s: &str, default: T) -> T {
    match serde_json::from_str(s) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("渠道字段 {field} JSON 损坏,已回退为默认值: {e}");
            default
        }
    }
}

impl ChannelRow {
    fn into_channel(self) -> Channel {
        let protocol = match self.protocol.as_str() {
            "anthropic" => UpstreamProto::Anthropic,
            "gemini" => UpstreamProto::Gemini,
            _ => UpstreamProto::OpenAi,
        };
        Channel {
            id: self.id,
            name: self.name,
            protocol,
            base_url: self.base_url,
            api_keys: parse_json("api_keys", &self.api_keys, Vec::new()),
            enabled: self.enabled,
            proxy: self.proxy,
            // 负值/0 归一为不限(None)
            max_concurrency: self.max_concurrency.filter(|v| *v > 0),
            models: parse_json("models", &self.models, Vec::new()),
            model_map: parse_json("model_map", &self.model_map, Default::default()),
            timeout_override: self
                .timeout_override
                .and_then(|s| serde_json::from_str(&s).ok()),
            breaker_override: self
                .breaker_override
                .and_then(|s| serde_json::from_str(&s).ok()),
            remark: self.remark,
            icon: self.icon,
            // 空值归一到 cny(旧行/异常值兜底)
            price_currency: match self.price_currency.as_str() {
                "usd" => "usd".into(),
                _ => "cny".into(),
            },
            rate_rules: sanitize_rules(parse_json(
                "rate_rules",
                &self.rate_rules,
                Vec::new(),
            )),
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

/// 倍率规则清洗:倍率钳 0~100(非有限值回 1)、day_type 白名单(非法回 all,
/// 拼错值静默不命中比报错更难排查);model/时段/备注去空白
fn sanitize_rules(rules: Vec<RateRule>) -> Vec<RateRule> {
    rules
        .into_iter()
        .map(|mut r| {
            r.rate = if (0.0..=100.0).contains(&r.rate) && r.rate.is_finite() {
                r.rate
            } else {
                1.0
            };
            r.day_type = match r.day_type.trim() {
                "workday" | "weekend" | "holiday" => r.day_type.trim().to_string(),
                _ => "all".to_string(),
            };
            r.model = r.model.trim().to_string();
            r.time_range = r.time_range.trim().to_string();
            r.remark = r.remark.trim().to_string();
            r
        })
        .collect()
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<Channel>, String> {
    let rows: Vec<ChannelRow> = sqlx::query_as(
        "SELECT id, name, protocol, base_url, api_keys, enabled, proxy, max_concurrency, models, model_map,
                timeout_override, breaker_override, remark, icon, price_currency, rate_rules,
                created_at, updated_at
         FROM channels ORDER BY id",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("读取渠道失败: {e}"))?;
    Ok(rows.into_iter().map(ChannelRow::into_channel).collect())
}

pub async fn insert(pool: impl Executor<'_, Database = sqlx::Sqlite>, c: &Channel) -> Result<i64, String> {
    let ts = now_ms();
    let id: (i64,) = sqlx::query_as(
        "INSERT INTO channels (name, protocol, base_url, api_keys, enabled, proxy, max_concurrency, models,
             model_map, timeout_override, breaker_override, remark, icon, price_currency,
             rate_rules, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(&c.name)
    .bind(c.protocol.as_str())
    .bind(&c.base_url)
    .bind(serde_json::to_string(&c.api_keys).map_err(|e| e.to_string())?)
    .bind(c.enabled)
    .bind(&c.proxy)
    .bind(c.max_concurrency)
    .bind(serde_json::to_string(&c.models).map_err(|e| e.to_string())?)
    .bind(serde_json::to_string(&c.model_map).map_err(|e| e.to_string())?)
    .bind(opt_json(&c.timeout_override)?)
    .bind(opt_json(&c.breaker_override)?)
    .bind(&c.remark)
    .bind(icon_clamped(&c.icon))
    .bind(currency_clamped(&c.price_currency))
    .bind(
        serde_json::to_string(&sanitize_rules(c.rate_rules.clone()))
            .map_err(|e| e.to_string())?,
    )
    .bind(ts)
    .bind(ts)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("创建渠道失败: {e}"))?;
    Ok(id.0)
}

pub async fn update(pool: &SqlitePool, c: &Channel) -> Result<(), String> {
    sqlx::query(
        "UPDATE channels SET name=?, protocol=?, base_url=?, api_keys=?, enabled=?, proxy=?,
             max_concurrency=?, models=?, model_map=?, timeout_override=?, breaker_override=?, remark=?, icon=?,
             price_currency=?, rate_rules=?, updated_at=?
         WHERE id=?",
    )
    .bind(&c.name)
    .bind(c.protocol.as_str())
    .bind(&c.base_url)
    .bind(serde_json::to_string(&c.api_keys).map_err(|e| e.to_string())?)
    .bind(c.enabled)
    .bind(&c.proxy)
    .bind(c.max_concurrency)
    .bind(serde_json::to_string(&c.models).map_err(|e| e.to_string())?)
    .bind(serde_json::to_string(&c.model_map).map_err(|e| e.to_string())?)
    .bind(opt_json(&c.timeout_override)?)
    .bind(opt_json(&c.breaker_override)?)
    .bind(&c.remark)
    .bind(icon_clamped(&c.icon))
    .bind(currency_clamped(&c.price_currency))
    .bind(
        serde_json::to_string(&sanitize_rules(c.rate_rules.clone()))
            .map_err(|e| e.to_string())?,
    )
    .bind(now_ms())
    .bind(c.id)
    .execute(pool)
    .await
    .map_err(|e| format!("更新渠道失败: {e}"))?;
    Ok(())
}

/// 计费币种入库钳制:仅接受 "usd",其余一律归 "cny"
fn currency_clamped(v: &str) -> String {
    if v.trim() == "usd" { "usd".into() } else { "cny".into() }
}

/// 图标值入库钳制:emoji ≤8 字符;dataURL ≤64KB;非法(既非 data:image/ 又超长)置空。
/// 与客户端图标(settings.rs)同口径
fn icon_clamped(v: &str) -> String {
    let v = v.trim();
    if v.is_empty() {
        return String::new();
    }
    if v.starts_with("data:image/") {
        if v.len() <= 64 * 1024 {
            v.to_string()
        } else {
            String::new()
        }
    } else if v.chars().count() <= 8 {
        v.chars().take(8).collect()
    } else {
        String::new()
    }
}

pub async fn set_enabled(pool: &SqlitePool, id: i64, enabled: bool) -> Result<(), String> {
    sqlx::query("UPDATE channels SET enabled=?, updated_at=? WHERE id=?")
        .bind(enabled)
        .bind(now_ms())
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("更新渠道失败: {e}"))?;
    Ok(())
}

pub async fn delete(pool: &SqlitePool, id: i64) -> Result<(), String> {
    sqlx::query("DELETE FROM channels WHERE id=?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("删除渠道失败: {e}"))?;
    Ok(())
}

fn opt_json<T: Serialize>(v: &Option<T>) -> Result<Option<String>, String> {
    match v {
        None => Ok(None),
        Some(v) => serde_json::to_string(v).map(Some).map_err(|e| e.to_string()),
    }
}
