use serde::Serialize;
use tauri::State;

use crate::billing::pricing::PriceEntry;
use crate::state::AppState;
use crate::store::{logs, prices};

#[tauri::command]
pub async fn list_model_prices(state: State<'_, AppState>) -> Result<Vec<PriceEntry>, String> {
    Ok(state.prices.read().unwrap().rows.clone())
}

#[tauri::command]
pub async fn upsert_model_price(
    state: State<'_, AppState>,
    price: PriceEntry,
) -> Result<(), String> {
    if price.pattern.trim().is_empty() {
        return Err("模型名不能为空".into());
    }
    prices::upsert(&state.db, &price).await?;
    state.reload_prices().await?;
    Ok(())
}

#[tauri::command]
pub async fn delete_model_price(state: State<'_, AppState>, pattern: String) -> Result<(), String> {
    prices::delete(&state.db, &pattern).await?;
    state.reload_prices().await?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnpricedModel {
    pub model: String,
    pub first_seen: i64,
}

#[tauri::command]
pub async fn list_unpriced_models(
    state: State<'_, AppState>,
) -> Result<Vec<UnpricedModel>, String> {
    Ok(prices::list_unpriced(&state.db)
        .await?
        .into_iter()
        .map(|(model, first_seen)| UnpricedModel { model, first_seen })
        .collect())
}

#[tauri::command]
pub async fn dismiss_unpriced_model(
    state: State<'_, AppState>,
    model: String,
) -> Result<(), String> {
    prices::delete_unpriced(&state.db, &model).await
}

/// 对 cost 为空的历史日志按当前定价表回填费用,返回回填条数
#[tauri::command]
pub async fn backfill_costs(state: State<'_, AppState>) -> Result<u64, String> {
    let table = state.prices.read().unwrap().clone();
    logs::backfill_costs(&state.db, &table).await
}

/// 快捷补录:保存定价 → 回填历史费用 → 清理对应未定价记录,返回回填条数
#[tauri::command]
pub async fn quick_price_and_backfill(
    state: State<'_, AppState>,
    price: PriceEntry,
) -> Result<u64, String> {
    if price.pattern.trim().is_empty() {
        return Err("模型名不能为空".into());
    }
    prices::upsert(&state.db, &price).await?;
    state.reload_prices().await?;
    let table = state.prices.read().unwrap().clone();
    let n = logs::backfill_costs(&state.db, &table).await?;
    prices::clear_unpriced_matching(&state.db, price.pattern.trim()).await?;
    Ok(n)
}
