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
    /// 支持的模型列表;空 = 不限制
    pub models: Vec<String>,
    /// 入站模型名 → 上游模型名,精确匹配,未命中原样透传
    pub model_map: std::collections::HashMap<String, String>,
    pub timeout_override: Option<TimeoutOverride>,
    pub breaker_override: Option<BreakerOverride>,
    pub remark: String,
    pub created_at: i64,
    pub updated_at: i64,
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
    models: String,
    model_map: String,
    timeout_override: Option<String>,
    breaker_override: Option<String>,
    remark: String,
    created_at: i64,
    updated_at: i64,
}

fn parse_json<T: serde::de::DeserializeOwned>(s: &str, default: T) -> T {
    serde_json::from_str(s).unwrap_or(default)
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
            api_keys: parse_json(&self.api_keys, Vec::new()),
            enabled: self.enabled,
            proxy: self.proxy,
            models: parse_json(&self.models, Vec::new()),
            model_map: parse_json(&self.model_map, Default::default()),
            timeout_override: self
                .timeout_override
                .and_then(|s| serde_json::from_str(&s).ok()),
            breaker_override: self
                .breaker_override
                .and_then(|s| serde_json::from_str(&s).ok()),
            remark: self.remark,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<Channel>, String> {
    let rows: Vec<ChannelRow> = sqlx::query_as(
        "SELECT id, name, protocol, base_url, api_keys, enabled, proxy, models, model_map,
                timeout_override, breaker_override, remark, created_at, updated_at
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
        "INSERT INTO channels (name, protocol, base_url, api_keys, enabled, proxy, models,
             model_map, timeout_override, breaker_override, remark, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(&c.name)
    .bind(c.protocol.as_str())
    .bind(&c.base_url)
    .bind(serde_json::to_string(&c.api_keys).map_err(|e| e.to_string())?)
    .bind(c.enabled)
    .bind(&c.proxy)
    .bind(serde_json::to_string(&c.models).map_err(|e| e.to_string())?)
    .bind(serde_json::to_string(&c.model_map).map_err(|e| e.to_string())?)
    .bind(opt_json(&c.timeout_override)?)
    .bind(opt_json(&c.breaker_override)?)
    .bind(&c.remark)
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
             models=?, model_map=?, timeout_override=?, breaker_override=?, remark=?, updated_at=?
         WHERE id=?",
    )
    .bind(&c.name)
    .bind(c.protocol.as_str())
    .bind(&c.base_url)
    .bind(serde_json::to_string(&c.api_keys).map_err(|e| e.to_string())?)
    .bind(c.enabled)
    .bind(&c.proxy)
    .bind(serde_json::to_string(&c.models).map_err(|e| e.to_string())?)
    .bind(serde_json::to_string(&c.model_map).map_err(|e| e.to_string())?)
    .bind(opt_json(&c.timeout_override)?)
    .bind(opt_json(&c.breaker_override)?)
    .bind(&c.remark)
    .bind(now_ms())
    .bind(c.id)
    .execute(pool)
    .await
    .map_err(|e| format!("更新渠道失败: {e}"))?;
    Ok(())
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
