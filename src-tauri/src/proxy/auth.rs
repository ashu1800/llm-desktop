use axum::http::HeaderMap;

use crate::server::error::GatewayError;
use crate::state::AppState;
use crate::store::api_keys::ApiKey;
use crate::util::{ct_eq, read_ok};

pub struct AuthedKey {
    pub id: i64,
    pub name: String,
    /// 有序渠道 id(顺序即故障转移顺序)
    pub channels: Vec<i64>,
    /// 模型白名单;空 = 不限制(该密钥可用渠道的所有模型都放行)
    pub models: Vec<String>,
    /// 模型 → 有序渠道 id:该模型的渠道路由优先级;缺省模型跟随 channels 全局顺序
    pub model_channels: crate::store::api_keys::ModelChannels,
}

/// 自建密钥认证:接受 Bearer / x-api-key / x-goog-api-key / ?key=,常量时间比较
pub fn authenticate(
    state: &AppState,
    headers: &HeaderMap,
    query_key: Option<&str>,
) -> Result<AuthedKey, GatewayError> {
    let mut candidates: Vec<&str> = Vec::with_capacity(4);
    if let Some(v) = header_str(headers, "authorization") {
        if let Some(t) = v
            .strip_prefix("Bearer ")
            .or_else(|| v.strip_prefix("bearer "))
        {
            candidates.push(t.trim());
        }
    }
    for h in ["x-api-key", "x-goog-api-key"] {
        if let Some(v) = header_str(headers, h) {
            candidates.push(v.trim());
        }
    }
    if let Some(k) = query_key {
        if !k.trim().is_empty() {
            candidates.push(k.trim());
        }
    }
    if candidates.is_empty() {
        return Err(GatewayError::unauthorized("缺少 API 密钥"));
    }

    let keys = read_ok(&state.keys);
    let found: Option<&ApiKey> = keys.iter().find(|k| {
        k.key.starts_with("sk-gw-")
            && candidates
                .iter()
                .any(|c| c.len() == k.key.len() && ct_eq(c, &k.key))
    });
    let Some(k) = found else {
        return Err(GatewayError::unauthorized("无效的 API 密钥"));
    };
    if !k.enabled {
        return Err(GatewayError::unauthorized("密钥已禁用"));
    }
    Ok(AuthedKey {
        id: k.id,
        name: k.name.clone(),
        channels: k.channels.clone(),
        models: k.models.clone(),
        model_channels: k.model_channels.clone(),
    })
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}
