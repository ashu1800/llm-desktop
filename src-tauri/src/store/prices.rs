use sqlx::{Executor, SqlitePool};

use crate::billing::pricing::PriceEntry;
use crate::util::now_ms;

type PriceRow = (
    String, f64, f64, f64, f64,
    Option<f64>, Option<f64>, Option<f64>, Option<f64>,
);

pub async fn list(pool: &SqlitePool) -> Result<Vec<PriceEntry>, String> {
    let rows: Vec<PriceRow> = sqlx::query_as(
        "SELECT pattern, input, output, cache_read, cache_write,
                input_usd, output_usd, cache_read_usd, cache_write_usd
         FROM model_prices ORDER BY id",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("读取定价失败: {e}"))?;
    Ok(rows
        .into_iter()
        .map(
            |(pattern, input, output, cache_read, cache_write, iu, ou, cu, cwi)| PriceEntry {
                pattern,
                input,
                output,
                cache_read,
                cache_write,
                input_usd: iu,
                output_usd: ou,
                cache_read_usd: cu,
                cache_write_usd: cwi,
            },
        )
        .collect())
}

pub async fn upsert(pool: impl Executor<'_, Database = sqlx::Sqlite>, p: &PriceEntry) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO model_prices (pattern, input, output, cache_read, cache_write,
             input_usd, output_usd, cache_read_usd, cache_write_usd, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(pattern) DO UPDATE SET
           input=excluded.input, output=excluded.output,
           cache_read=excluded.cache_read, cache_write=excluded.cache_write,
           input_usd=excluded.input_usd, output_usd=excluded.output_usd,
           cache_read_usd=excluded.cache_read_usd, cache_write_usd=excluded.cache_write_usd,
           updated_at=excluded.updated_at",
    )
    .bind(&p.pattern)
    .bind(p.input)
    .bind(p.output)
    .bind(p.cache_read)
    .bind(p.cache_write)
    .bind(p.input_usd)
    .bind(p.output_usd)
    .bind(p.cache_read_usd)
    .bind(p.cache_write_usd)
    .bind(now_ms())
    .execute(pool)
    .await
    .map_err(|e| format!("保存定价失败: {e}"))?;
    Ok(())
}

pub async fn delete(pool: &SqlitePool, pattern: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM model_prices WHERE pattern=?")
        .bind(pattern)
        .execute(pool)
        .await
        .map_err(|e| format!("删除定价失败: {e}"))?;
    Ok(())
}

/// 未定价模型收集(请求成功但无匹配价格)
pub async fn record_unpriced(pool: &SqlitePool, model: &str) {
    let _ = sqlx::query("INSERT OR IGNORE INTO unpriced_models (model, first_seen) VALUES (?, ?)")
        .bind(model)
        .bind(now_ms())
        .execute(pool)
        .await;
}

pub async fn list_unpriced(pool: &SqlitePool) -> Result<Vec<(String, i64)>, String> {
    let rows: Vec<(String, i64)> =
        sqlx::query_as("SELECT model, first_seen FROM unpriced_models ORDER BY first_seen DESC")
            .fetch_all(pool)
            .await
            .map_err(|e| format!("读取未定价模型失败: {e}"))?;
    Ok(rows)
}

/// 清除能被新定价条目匹配到的未定价记录(精确名或 prefix* 通配;Rust 侧过滤避免 LIKE 转义)
pub async fn clear_unpriced_matching(pool: &SqlitePool, pattern: &str) -> Result<(), String> {
    let models: Vec<String> = list_unpriced(pool)
        .await?
        .into_iter()
        .map(|(m, _)| m)
        .collect();
    let prefix = pattern.strip_suffix('*');
    for m in models {
        let hit = match prefix {
            Some(p) => m.starts_with(p),
            None => m == pattern,
        };
        if hit {
            delete_unpriced(pool, &m).await?;
        }
    }
    Ok(())
}

pub async fn delete_unpriced(pool: &SqlitePool, model: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM unpriced_models WHERE model=?")
        .bind(model)
        .execute(pool)
        .await
        .map_err(|e| format!("删除未定价记录失败: {e}"))?;
    Ok(())
}
