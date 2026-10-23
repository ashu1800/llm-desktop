//! 配置导入导出(PRD §3.8:JSON 含渠道+密钥+定价+设置;日志不导出;导入为整表替换)。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::autostart;
use crate::billing::pricing::PriceEntry;
use crate::events::{self, GatewayEvent};
use crate::server::manager;
use crate::settings::AppSettings;
use crate::state::AppState;
use crate::store::api_keys::ApiKey;
use crate::store::channels::Channel;
use crate::store::{self, prices};
use crate::tray;
use crate::util::now_ms;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportConfig {
    pub version: u32,
    pub exported_at: i64,
    pub settings: AppSettings,
    pub channels: Vec<Channel>,
    pub keys: Vec<ApiKey>,
    pub prices: Vec<PriceEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub channels: usize,
    pub keys: usize,
    pub prices: usize,
}

async fn build_export(state: &AppState) -> Result<String, String> {
    let cfg = ExportConfig {
        version: 1,
        exported_at: now_ms(),
        settings: state.current_settings(),
        channels: store::channels::list(&state.db).await?,
        keys: store::api_keys::list(&state.db).await?,
        prices: state.prices.read().unwrap().rows.clone(),
    };
    serde_json::to_string_pretty(&cfg).map_err(|e| format!("序列化配置失败: {e}"))
}

/// 弹出保存对话框导出配置;返回写入路径,取消返回 None
#[tauri::command]
pub async fn export_config(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let json = build_export(&state).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let name = format!("llm-gateway-config-{}.json", now_ms());
        let picked = app
            .dialog()
            .file()
            .add_filter("JSON 配置", &["json"])
            .set_file_name(&name)
            .blocking_save_file();
        let Some(path) = picked else {
            return Ok(None);
        };
        let p = path
            .into_path()
            .map_err(|e| format!("目标路径无效: {e}"))?;
        std::fs::write(&p, json).map_err(|e| format!("写入文件失败: {e}"))?;
        Ok(Some(p.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| format!("导出任务失败: {e}"))?
}

/// 弹出选择对话框并解析配置,返回预览计数(供导入前二次确认);取消返回 None
#[tauri::command]
pub async fn import_config_preview(app: AppHandle) -> Result<Option<(String, ImportPreview)>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .add_filter("JSON 配置", &["json"])
            .blocking_pick_file();
        let Some(path) = picked else {
            return Ok(None);
        };
        let p = path.into_path().map_err(|e| format!("路径无效: {e}"))?;
        let text = std::fs::read_to_string(&p).map_err(|e| format!("读取文件失败: {e}"))?;
        let cfg = parse_config(&text)?;
        Ok(Some((
            p.to_string_lossy().into_owned(),
            ImportPreview {
                channels: cfg.channels.len(),
                keys: cfg.keys.len(),
                prices: cfg.prices.len(),
            },
        )))
    })
    .await
    .map_err(|e| format!("导入任务失败: {e}"))?
}

fn parse_config(text: &str) -> Result<ExportConfig, String> {
    let cfg: ExportConfig =
        serde_json::from_str(text).map_err(|e| format!("配置文件格式不正确: {e}"))?;
    if cfg.version != 1 {
        return Err(format!("不支持的配置版本: {}", cfg.version));
    }
    Ok(cfg)
}

/// 应用导入(整表替换渠道/密钥/定价 + 覆盖设置),并热生效
#[tauri::command]
pub async fn import_config_apply(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let text =
        std::fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {e}"))?;
    let cfg = parse_config(&text)?;

    // 整表替换在单个事务内完成,失败即整体回滚
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| format!("开启事务失败: {e}"))?;
    sqlx::query("DELETE FROM api_keys")
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("清空密钥失败: {e}"))?;
    sqlx::query("DELETE FROM channels")
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("清空渠道失败: {e}"))?;
    sqlx::query("DELETE FROM model_prices")
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("清空定价失败: {e}"))?;

    // 渠道重插并建立 旧id→新id 映射(密钥的可用渠道列表需要重映射)
    let mut id_map: HashMap<i64, i64> = HashMap::new();
    for mut ch in cfg.channels {
        let old_id = ch.id;
        ch.id = 0;
        let new_id = store::channels::insert(&mut *tx, &ch).await?;
        id_map.insert(old_id, new_id);
    }
    for mut k in cfg.keys {
        k.id = 0;
        k.channels = k
            .channels
            .iter()
            .filter_map(|id| id_map.get(id).copied())
            .collect();
        k.last_used_at = None;
        store::api_keys::insert(&mut *tx, &k).await?;
    }
    for p in &cfg.prices {
        prices::upsert(&mut *tx, p).await?;
    }
    tx.commit()
        .await
        .map_err(|e| format!("提交导入事务失败: {e}"))?;

    // 设置覆盖 + 热生效(与 update_settings 一致:监听变更平滑切换、自启同步注册表)
    let new_settings = cfg.settings.normalized();
    let old = state.current_settings();
    let addr_changed =
        old.port != new_settings.port || old.listen_addr != new_settings.listen_addr;
    if addr_changed {
        let target = manager::parse_listen(&new_settings.listen_addr, new_settings.port)?;
        manager::apply_listen_change(&state, target).await?;
    }
    if old.autostart != new_settings.autostart {
        autostart::set_enabled(&app, new_settings.autostart)?;
    }
    store::settings::save(&state.db, &new_settings).await?;
    *state.settings.write().unwrap() = new_settings;
    state.reload_channels().await?;
    state.reload_keys().await?;
    state.reload_prices().await?;
    // 渠道 id 全部重排:清空按旧 id 记账的熔断状态与密钥轮询起点
    state.breakers.clear_all();
    state.key_counters.lock().unwrap().clear();

    events::emit(&app, GatewayEvent::SettingsChanged);
    tray::refresh(&app);
    Ok(())
}
