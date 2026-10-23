use sqlx::SqlitePool;

use crate::settings::AppSettings;

const KEY: &str = "app";

pub async fn load(pool: &SqlitePool) -> Result<AppSettings, String> {
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM settings WHERE key = ?")
        .bind(KEY)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("读取设置失败: {e}"))?;
    match row {
        Some((v,)) => serde_json::from_str::<AppSettings>(&v)
            .map(|s| s.normalized())
            .map_err(|e| format!("设置解析失败: {e}")),
        None => Ok(AppSettings::default()),
    }
}

pub async fn save(pool: &SqlitePool, value: &AppSettings) -> Result<(), String> {
    let v = serde_json::to_string(value).map_err(|e| format!("设置序列化失败: {e}"))?;
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(KEY)
    .bind(v)
    .execute(pool)
    .await
    .map_err(|e| format!("保存设置失败: {e}"))?;
    Ok(())
}
