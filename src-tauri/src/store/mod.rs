pub mod api_keys;
pub mod channels;
pub mod logs;
pub mod prices;
pub mod settings;

use std::path::Path;
use std::time::Duration;

use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous,
};
use sqlx::SqlitePool;

/// 打开(必要时创建)SQLite 连接池并执行迁移
/// WAL + NORMAL + busy_timeout:代理转发与日志批量写入并发访问的前提
pub async fn init_pool(path: &Path) -> Result<SqlitePool, String> {
    let opts = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_millis(5000))
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(opts)
        .await
        .map_err(|e| format!("打开数据库失败: {e}"))?;
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .map_err(|e| format!("数据库迁移失败: {e}"))?;
    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn migrations_apply_and_settings_roundtrip() {
        let dir = std::env::temp_dir().join(format!("llm-desktop-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("test.db");
        let pool = init_pool(&db_path).await.unwrap();

        let s = crate::settings::AppSettings::default();
        crate::store::settings::save(&pool, &s).await.unwrap();
        let loaded = crate::store::settings::load(&pool).await.unwrap();
        assert_eq!(loaded.port, 8787);
        assert_eq!(loaded.breaker.consecutive_failures, 5);

        drop(pool);
        // 二次打开验证迁移幂等
        let pool2 = init_pool(&db_path).await.unwrap();
        let loaded2 = crate::store::settings::load(&pool2).await.unwrap();
        assert_eq!(loaded2, s);
        drop(pool2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn channel_and_key_crud() {
        let dir = std::env::temp_dir().join(format!("llm-desktop-crud-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pool = init_pool(&dir.join("t.db")).await.unwrap();

        let mut ch = crate::store::channels::Channel {
            id: 0,
            name: "测试渠道".into(),
            protocol: crate::proto::UpstreamProto::OpenAi,
            base_url: "https://api.example.com".into(),
            api_keys: vec!["sk-up-1".into(), "sk-up-2".into()],
            enabled: true,
            proxy: None,
            models: vec!["gpt-4o".into()],
            model_map: [("gpt".into(), "gpt-4o".into())].into_iter().collect(),
            timeout_override: None,
            breaker_override: None,
            remark: "r".into(),
            created_at: 0,
            updated_at: 0,
        };
        ch.id = crate::store::channels::insert(&pool, &ch).await.unwrap();
        let listed = crate::store::channels::list(&pool).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].api_keys.len(), 2);
        assert_eq!(listed[0].model_map.get("gpt").unwrap(), "gpt-4o");

        ch.name = "改名".into();
        crate::store::channels::update(&pool, &ch).await.unwrap();
        assert_eq!(crate::store::channels::list(&pool).await.unwrap()[0].name, "改名");
        crate::store::channels::delete(&pool, ch.id).await.unwrap();
        assert!(crate::store::channels::list(&pool).await.unwrap().is_empty());

        let key = crate::store::api_keys::ApiKey {
            id: 0,
            name: "k".into(),
            key: crate::store::api_keys::generate_key(),
            enabled: true,
            channels: vec![1, 2, 3],
            remark: String::new(),
            created_at: 0,
            last_used_at: None,
        };
        let kid = crate::store::api_keys::insert(&pool, &key).await.unwrap();
        let keys = crate::store::api_keys::list(&pool).await.unwrap();
        assert_eq!(keys[0].channels, vec![1, 2, 3]);
        assert!(keys[0].key.starts_with("sk-gw-") && keys[0].key.len() == 32 + 6);
        crate::store::api_keys::delete(&pool, kid).await.unwrap();

        let price = crate::billing::pricing::PriceEntry {
            pattern: "gpt*".into(),
            input: 1.0,
            output: 2.0,
            cache_read: 0.1,
            cache_write: 0.2,
        };
        crate::store::prices::upsert(&pool, &price).await.unwrap();
        crate::store::prices::upsert(&pool, &price).await.unwrap(); // upsert 幂等
        assert_eq!(crate::store::prices::list(&pool).await.unwrap().len(), 1);

        std::fs::remove_dir_all(&dir).ok();
    }
}
