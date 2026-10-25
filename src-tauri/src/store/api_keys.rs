use serde::{Deserialize, Serialize};
use sqlx::{Executor, SqlitePool};

use crate::util::{now_ms, rand_hex};

/// 模型级路由:该模型按序优先调用哪些渠道(渠道 id 有序,顺序即优先级)。
/// 反序列化容忍旧数据里的非数组值(直接丢弃该模型的定制)
pub type ModelChannels = std::collections::HashMap<String, Vec<i64>>;

/// 自建访问密钥;channels 为有序渠道 id 列表(顺序即故障转移顺序)。
/// models 为模型白名单(空 = 不限制);model_channels 为模型 → 渠道优先级
/// (缺省模型跟随 channels 的全局顺序)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKey {
    pub id: i64,
    pub name: String,
    pub key: String,
    pub enabled: bool,
    pub channels: Vec<i64>,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub model_channels: ModelChannels,
    pub remark: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
}

pub fn generate_key() -> String {
    format!("sk-gw-{}", rand_hex(32))
}

#[derive(sqlx::FromRow)]
struct ApiKeyRow {
    id: i64,
    name: String,
    key: String,
    enabled: bool,
    channels: String,
    models: String,
    model_channels: String,
    remark: String,
    created_at: i64,
    last_used_at: Option<i64>,
}

impl ApiKeyRow {
    fn into_key(self) -> ApiKey {
        ApiKey {
            id: self.id,
            name: self.name,
            key: self.key,
            enabled: self.enabled,
            channels: serde_json::from_str(&self.channels).unwrap_or_default(),
            models: serde_json::from_str(&self.models).unwrap_or_default(),
            model_channels: serde_json::from_str(&self.model_channels).unwrap_or_default(),
            remark: self.remark,
            created_at: self.created_at,
            last_used_at: self.last_used_at,
        }
    }
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<ApiKey>, String> {
    let rows: Vec<ApiKeyRow> = sqlx::query_as(
        "SELECT id, name, key, enabled, channels, models, model_channels, remark, created_at, last_used_at
         FROM api_keys ORDER BY id",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("读取密钥失败: {e}"))?;
    Ok(rows.into_iter().map(ApiKeyRow::into_key).collect())
}

pub async fn insert(pool: impl Executor<'_, Database = sqlx::Sqlite>, k: &ApiKey) -> Result<i64, String> {
    let row: (i64,) = sqlx::query_as(
        "INSERT INTO api_keys (name, key, enabled, channels, models, model_channels, remark, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(&k.name)
    .bind(&k.key)
    .bind(k.enabled)
    .bind(serde_json::to_string(&k.channels).map_err(|e| e.to_string())?)
    .bind(serde_json::to_string(&k.models).map_err(|e| e.to_string())?)
    .bind(serde_json::to_string(&k.model_channels).map_err(|e| e.to_string())?)
    .bind(&k.remark)
    .bind(now_ms())
    .fetch_one(pool)
    .await
    .map_err(|e| format!("创建密钥失败: {e}"))?;
    Ok(row.0)
}

pub async fn update(pool: &SqlitePool, k: &ApiKey) -> Result<(), String> {
    sqlx::query("UPDATE api_keys SET name=?, enabled=?, channels=?, models=?, model_channels=?, remark=? WHERE id=?")
        .bind(&k.name)
        .bind(k.enabled)
        .bind(serde_json::to_string(&k.channels).map_err(|e| e.to_string())?)
        .bind(serde_json::to_string(&k.models).map_err(|e| e.to_string())?)
        .bind(serde_json::to_string(&k.model_channels).map_err(|e| e.to_string())?)
        .bind(&k.remark)
        .bind(k.id)
        .execute(pool)
        .await
        .map_err(|e| format!("更新密钥失败: {e}"))?;
    Ok(())
}

/// 密钥明文不可改,单独更新开关
pub async fn set_enabled(pool: &SqlitePool, id: i64, enabled: bool) -> Result<(), String> {
    sqlx::query("UPDATE api_keys SET enabled=? WHERE id=?")
        .bind(enabled)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("更新密钥失败: {e}"))?;
    Ok(())
}

pub async fn delete(pool: &SqlitePool, id: i64) -> Result<(), String> {
    // 日志冗余存 key_name,删密钥不删历史日志
    sqlx::query("DELETE FROM api_keys WHERE id=?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("删除密钥失败: {e}"))?;
    Ok(())
}

pub async fn touch_last_used(pool: &SqlitePool, id: i64) {
    let _ = sqlx::query("UPDATE api_keys SET last_used_at=? WHERE id=?")
        .bind(now_ms())
        .bind(id)
        .execute(pool)
        .await;
}
