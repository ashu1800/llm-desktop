use serde::{Deserialize, Serialize};
use sqlx::{QueryBuilder, Sqlite, SqlitePool};
use tokio::sync::mpsc::Receiver;


/// 请求日志(冗余 key_name/channel_name,删除密钥/渠道不影响历史)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestLog {
    pub ts: i64,
    pub key_id: Option<i64>,
    pub key_name: Option<String>,
    pub channel_id: Option<i64>,
    pub channel_name: Option<String>,
    pub model: String,
    pub mapped_model: Option<String>,
    pub tag: Option<String>,
    pub protocol_in: String,
    pub protocol_up: Option<String>,
    pub status: i64,
    pub is_stream: bool,
    pub attempts: serde_json::Value,
    pub error: Option<String>,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub estimated: bool,
    pub ttft_ms: Option<i64>,
    pub total_ms: Option<i64>,
    pub speed: Option<f64>,
    pub cost: Option<i64>,
    pub client: Option<String>,
    pub req_snapshot: Option<String>,
    pub resp_snapshot: Option<String>,
}

/// 日志写入队列容量:满时丢弃日志,绝不阻塞响应(硬性架构约束)
pub const QUEUE_SIZE: usize = 4096;
/// 单事务批量行数
const BATCH: usize = 50;
/// 批量缓冲窗口
const FLUSH_INTERVAL_MS: u64 = 200;

pub fn spawn_writer(pool: SqlitePool, mut rx: Receiver<RequestLog>) {
    tauri::async_runtime::spawn(async move {
        let mut buf: Vec<RequestLog> = Vec::with_capacity(BATCH);
        loop {
            let first = match rx.recv().await {
                Some(item) => item,
                None => break, // 队列关闭
            };
            buf.push(first);
            let deadline =
                tokio::time::Instant::now() + std::time::Duration::from_millis(FLUSH_INTERVAL_MS);
            while buf.len() < BATCH {
                match tokio::time::timeout_at(deadline, rx.recv()).await {
                    Ok(Some(item)) => buf.push(item),
                    Ok(None) => break,
                    Err(_) => break, // 到达 flush 窗口
                }
            }
            if let Err(e) = insert_batch(&pool, &buf).await {
                log::warn!("日志批量写入失败({} 条): {e}", buf.len());
            }
            buf.clear();
            if rx.is_closed() && buf.is_empty() {
                break;
            }
        }
    });
}

async fn insert_batch(pool: &SqlitePool, logs: &[RequestLog]) -> Result<(), String> {
    if logs.is_empty() {
        return Ok(());
    }
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("开启事务失败: {e}"))?;
    for l in logs {
        sqlx::query(
            "INSERT INTO request_logs (ts, key_id, key_name, channel_id, channel_name, model,
                 mapped_model, tag, protocol_in, protocol_up, status, is_stream, attempts, error,
                 prompt_tokens, completion_tokens, cache_read, cache_write, estimated, ttft_ms,
                 total_ms, speed, cost, client, req_snapshot, resp_snapshot)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(l.ts)
        .bind(l.key_id)
        .bind(&l.key_name)
        .bind(l.channel_id)
        .bind(&l.channel_name)
        .bind(&l.model)
        .bind(&l.mapped_model)
        .bind(&l.tag)
        .bind(&l.protocol_in)
        .bind(&l.protocol_up)
        .bind(l.status)
        .bind(l.is_stream)
        .bind(serde_json::to_string(&l.attempts).map_err(|e| e.to_string())?)
        .bind(&l.error)
        .bind(l.prompt_tokens)
        .bind(l.completion_tokens)
        .bind(l.cache_read)
        .bind(l.cache_write)
        .bind(l.estimated)
        .bind(l.ttft_ms)
        .bind(l.total_ms)
        .bind(l.speed)
        .bind(l.cost)
        .bind(&l.client)
        .bind(&l.req_snapshot)
        .bind(&l.resp_snapshot)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("写入日志失败: {e}"))?;
    }
    tx.commit()
        .await
        .map_err(|e| format!("提交日志事务失败: {e}"))?;
    Ok(())
}

/// 日志保留天数清理(每小时任务调用)
pub async fn delete_older_than(pool: &SqlitePool, before_ts: i64) -> Result<u64, String> {
    let r = sqlx::query("DELETE FROM request_logs WHERE ts < ?")
        .bind(before_ts)
        .execute(pool)
        .await
        .map_err(|e| format!("清理日志失败: {e}"))?;
    Ok(r.rows_affected())
}

/// 设置页一键清空
pub async fn clear_all(pool: &SqlitePool) -> Result<(), String> {
    sqlx::query("DELETE FROM request_logs")
        .execute(pool)
        .await
        .map_err(|e| format!("清空日志失败: {e}"))?;
    Ok(())
}

/// 对 cost 为空的历史日志按当前定价表回填费用,返回回填条数。
/// 探测顺序与实时计费一致:入口模型名优先,无匹配回退映射名。
/// 待回填行:(id, 入口模型, 映射模型, prompt, completion, cache_read, cache_write)
type BackfillRow = (i64, String, Option<String>, i64, i64, i64, i64);

pub async fn backfill_costs(
    pool: &SqlitePool,
    prices: &crate::billing::pricing::PriceTable,
) -> Result<u64, String> {
    let rows: Vec<BackfillRow> = sqlx::query_as(
        "SELECT id, model, mapped_model, prompt_tokens, completion_tokens, cache_read, cache_write
         FROM request_logs WHERE cost IS NULL",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("读取待回填日志失败: {e}"))?;
    let mut updated = 0u64;
    for (id, model, mapped, prompt, completion, cache_read, cache_write) in rows {
        let price = prices
            .match_for(&model)
            .or_else(|| mapped.as_deref().and_then(|m| prices.match_for(m)));
        let Some(p) = price else {
            continue;
        };
        let usage = crate::billing::Usage {
            prompt: prompt.max(0),
            completion: completion.max(0),
            cache_read: cache_read.max(0),
            cache_write: cache_write.max(0),
        };
        let cost = crate::billing::compute_cost_fen(p, &usage);
        let r = sqlx::query("UPDATE request_logs SET cost=? WHERE id=? AND cost IS NULL")
            .bind(cost)
            .bind(id)
            .execute(pool)
            .await
            .map_err(|e| format!("回填费用失败: {e}"))?;
        updated += r.rows_affected();
    }
    Ok(updated)
}

// ---------------------------------------------------------------------------
// 查询与统计(M7:日志页 + 仪表盘)
// ---------------------------------------------------------------------------

/// 日志筛选(全部条件可选,组合生效)
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFilter {
    pub from_ts: Option<i64>,
    pub to_ts: Option<i64>,
    pub key_id: Option<i64>,
    pub channel_id: Option<i64>,
    /// 模型名模糊匹配
    pub model: Option<String>,
    /// 模型名 / 错误信息模糊匹配
    pub keyword: Option<String>,
    /// "success" | "error" | None=全部
    pub status_class: Option<String>,
    pub offset: i64,
    pub limit: i64,
}

/// 日志列表行(不含请求/响应体快照;快照走 get_request_log 详情)
#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct LogItem {
    pub id: i64,
    pub ts: i64,
    pub key_id: Option<i64>,
    pub key_name: Option<String>,
    pub channel_id: Option<i64>,
    pub channel_name: Option<String>,
    pub model: String,
    pub mapped_model: Option<String>,
    pub tag: Option<String>,
    pub protocol_in: String,
    pub protocol_up: Option<String>,
    pub status: i64,
    pub is_stream: bool,
    /// attempts JSON(每次尝试的渠道/耗时/错误/丢弃字段)
    pub attempts: String,
    pub error: Option<String>,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub estimated: bool,
    pub ttft_ms: Option<i64>,
    pub total_ms: Option<i64>,
    pub speed: Option<f64>,
    pub cost: Option<i64>,
    pub client: Option<String>,
}

const LIST_COLS: &str = "id, ts, key_id, key_name, channel_id, channel_name, model, mapped_model, \
     tag, protocol_in, protocol_up, status, is_stream, attempts, error, prompt_tokens, \
     completion_tokens, cache_read, cache_write, estimated, ttft_ms, total_ms, speed, cost, client";

fn push_filters<'a>(qb: &mut QueryBuilder<'a, Sqlite>, f: &'a LogFilter) {
    qb.push(" WHERE 1=1");
    if let Some(v) = f.from_ts {
        qb.push(" AND ts >= ").push_bind(v);
    }
    if let Some(v) = f.to_ts {
        qb.push(" AND ts <= ").push_bind(v);
    }
    if let Some(v) = f.key_id {
        qb.push(" AND key_id = ").push_bind(v);
    }
    if let Some(v) = f.channel_id {
        qb.push(" AND channel_id = ").push_bind(v);
    }
    if let Some(m) = f.model.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND model LIKE ").push_bind(format!("%{m}%"));
    }
    if let Some(k) = f.keyword.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND (model LIKE ")
            .push_bind(format!("%{k}%"))
            .push(" OR error LIKE ")
            .push_bind(format!("%{k}%"))
            .push(")");
    }
    match f.status_class.as_deref() {
        Some("success") => {
            qb.push(" AND status BETWEEN 200 AND 299 AND error IS NULL");
        }
        Some("error") => {
            qb.push(" AND (status NOT BETWEEN 200 AND 299 OR error IS NOT NULL)");
        }
        _ => {}
    }
}

/// 分页查询日志(时间倒序),返回 (行, 总数)
pub async fn query_logs(
    pool: &SqlitePool,
    f: &LogFilter,
) -> Result<(Vec<LogItem>, i64), String> {
    let mut count_qb: QueryBuilder<Sqlite> =
        QueryBuilder::new("SELECT COUNT(*) FROM request_logs");
    push_filters(&mut count_qb, f);
    let (total,): (i64,) = count_qb
        .build_query_as()
        .fetch_one(pool)
        .await
        .map_err(|e| format!("统计日志数失败: {e}"))?;

    let mut qb: QueryBuilder<Sqlite> =
        QueryBuilder::new(format!("SELECT {LIST_COLS} FROM request_logs"));
    push_filters(&mut qb, f);
    qb.push(" ORDER BY ts DESC, id DESC LIMIT ")
        .push_bind(f.limit.clamp(1, 200))
        .push(" OFFSET ")
        .push_bind(f.offset.max(0));
    let items = qb
        .build_query_as::<LogItem>()
        .fetch_all(pool)
        .await
        .map_err(|e| format!("查询日志失败: {e}"))?;
    Ok((items, total))
}

/// 单条日志完整详情(含请求/响应体快照)
#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct LogDetail {
    #[sqlx(flatten)]
    #[serde(flatten)]
    pub item: LogItem,
    pub req_snapshot: Option<String>,
    pub resp_snapshot: Option<String>,
}

pub async fn get_request_log(pool: &SqlitePool, id: i64) -> Result<Option<LogDetail>, String> {
    let sql = format!(
        "SELECT {LIST_COLS}, req_snapshot, resp_snapshot FROM request_logs WHERE id = ?"
    );
    sqlx::query_as::<_, LogDetail>(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("查询日志详情失败: {e}"))
}

/// 汇总卡片(与日志筛选联动)
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsSummary {
    pub count: i64,
    /// 人民币分
    pub total_cost: i64,
    pub avg_ttft_ms: Option<f64>,
    pub avg_speed: Option<f64>,
    pub error_count: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cache_read: i64,
}

/// 汇总查询行:(总数, 总费用分, 平均首字, 平均速度, 错误数, 输入词元, 输出词元, 缓存读)
type SummaryRow = (i64, i64, Option<f64>, Option<f64>, i64, i64, i64, i64);

pub async fn stats_summary(pool: &SqlitePool, f: &LogFilter) -> Result<StatsSummary, String> {
    let mut qb: QueryBuilder<Sqlite> = QueryBuilder::new(
        "SELECT COUNT(*), COALESCE(SUM(cost),0), AVG(ttft_ms), AVG(speed),
             COALESCE(SUM(status NOT BETWEEN 200 AND 299 OR error IS NOT NULL),0),
             COALESCE(SUM(prompt_tokens),0), COALESCE(SUM(completion_tokens),0),
             COALESCE(SUM(cache_read),0)
         FROM request_logs",
    );
    push_filters(&mut qb, f);
    let (count, total_cost, avg_ttft, avg_speed, error_count, prompt, completion, cache_read): SummaryRow =
        qb.build_query_as()
            .fetch_one(pool)
            .await
            .map_err(|e| format!("统计汇总失败: {e}"))?;
    Ok(StatsSummary {
        count,
        total_cost,
        avg_ttft_ms: avg_ttft,
        avg_speed,
        error_count,
        prompt_tokens: prompt,
        completion_tokens: completion,
        cache_read: cache_read,
    })
}

/// 调用量与费用趋势:bucket_ms 为 3600000(小时)或 86400000(日)。
/// 占位符按 SQL 文本顺序绑定:桶宽两个 ? 在 WHERE 条件之前。
pub async fn stats_trend(
    pool: &SqlitePool,
    f: &LogFilter,
    bucket_ms: i64,
) -> Result<Vec<(i64, i64, i64)>, String> {
    let mut qb: QueryBuilder<Sqlite> = QueryBuilder::new("SELECT (ts / ");
    qb.push_bind(bucket_ms);
    qb.push(") * ");
    qb.push_bind(bucket_ms);
    qb.push(" AS b, COUNT(*), COALESCE(SUM(cost),0) FROM request_logs");
    push_filters(&mut qb, f);
    qb.push(" GROUP BY 1 ORDER BY 1");
    let rows: Vec<(i64, i64, i64)> = qb
        .build_query_as()
        .fetch_all(pool)
        .await
        .map_err(|e| format!("统计趋势失败: {e}"))?;
    Ok(rows)
}

/// 渠道请求占比:(渠道名, 请求数)
pub async fn stats_by_channel(
    pool: &SqlitePool,
    f: &LogFilter,
) -> Result<Vec<(String, i64)>, String> {
    let mut qb: QueryBuilder<Sqlite> = QueryBuilder::new(
        "SELECT COALESCE(channel_name, '(无渠道)'), COUNT(*) FROM request_logs",
    );
    push_filters(&mut qb, f);
    qb.push(" GROUP BY channel_name ORDER BY 2 DESC");
    let rows: Vec<(String, i64)> = qb
        .build_query_as()
        .fetch_all(pool)
        .await
        .map_err(|e| format!("统计渠道占比失败: {e}"))?;
    Ok(rows)
}

/// 模型 Top N:(模型名, 请求数)
pub async fn stats_top_models(
    pool: &SqlitePool,
    f: &LogFilter,
    limit: i64,
) -> Result<Vec<(String, i64)>, String> {
    let mut qb: QueryBuilder<Sqlite> =
        QueryBuilder::new("SELECT model, COUNT(*) FROM request_logs");
    push_filters(&mut qb, f);
    qb.push(" GROUP BY model ORDER BY 2 DESC LIMIT ").push_bind(limit.clamp(1, 50));
    let rows: Vec<(String, i64)> = qb
        .build_query_as()
        .fetch_all(pool)
        .await
        .map_err(|e| format!("统计模型 Top 失败: {e}"))?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::billing::pricing::{PriceEntry, PriceTable};

    async fn test_pool(tag: &str) -> (SqlitePool, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("llm-desktop-logs-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pool = crate::store::init_pool(&dir.join("t.db")).await.unwrap();
        (pool, dir)
    }

    fn entry(pattern: &str, input: f64, output: f64) -> PriceEntry {
        PriceEntry {
            pattern: pattern.into(),
            input,
            output,
            cache_read: 0.0,
            cache_write: 0.0,
        }
    }

    async fn insert_log(pool: &SqlitePool, model: &str, mapped: Option<&str>, cost: Option<i64>) {
        sqlx::query(
            "INSERT INTO request_logs (ts, model, mapped_model, protocol_in, status, is_stream,
                 prompt_tokens, completion_tokens, cost)
             VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .bind(1i64)
        .bind(model)
        .bind(mapped)
        .bind("openai")
        .bind(200i64)
        .bind(false)
        .bind(1_000_000i64)
        .bind(500_000i64)
        .bind(cost)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn backfill_only_fills_priced_rows() {
        let (pool, dir) = test_pool("bf").await;
        insert_log(&pool, "gpt-x", None, None).await; // 有通配定价 → 回填
        insert_log(&pool, "mapped-only", Some("mapped-name"), None).await; // 入口名无价,回退映射名 → 回填
        insert_log(&pool, "unknown", None, None).await; // 无定价 → 保持 NULL
        insert_log(&pool, "gpt-x", None, Some(7)).await; // 已有费用 → 不动
        let table = PriceTable {
            rows: vec![
                entry("gpt*", 1.0, 2.0),
                entry("mapped-name", 3.0, 4.0),
            ],
        };
        let n = backfill_costs(&pool, &table).await.unwrap();
        assert_eq!(n, 2);
        let costs: Vec<(String, Option<i64>)> =
            sqlx::query_as("SELECT model, cost FROM request_logs ORDER BY id")
                .fetch_all(&pool)
                .await
                .unwrap();
        // 1 元/1M 输入 + 2 元/1M 输出 → 100 + 100 = 200 分
        assert_eq!(costs[0], ("gpt-x".into(), Some(200)));
        // 3 元/1M + 4 元/1M → 300 + 200 = 500 分
        assert_eq!(costs[1], ("mapped-only".into(), Some(500)));
        assert_eq!(costs[2].1, None);
        assert_eq!(costs[3].1, Some(7));
        drop(pool);
        std::fs::remove_dir_all(&dir).ok();
    }

    async fn seed_query_logs(pool: &SqlitePool) {
        // (model, channel, status, error, ts, cost)
        type SeedRow = (&'static str, Option<&'static str>, i64, Option<&'static str>, i64, Option<i64>);
        let rows: [SeedRow; 4] = [
            ("gpt-a", Some("A"), 200, None, 1_700_000_000_000, Some(10)),
            ("gpt-b", Some("A"), 200, None, 1_700_000_100_000, Some(20)),
            ("gpt-a", Some("B"), 503, Some("渠道故障"), 1_700_000_200_000, None),
            ("claude-x", Some("B"), 200, None, 1_700_000_300_000, Some(5)),
        ];
        for (model, ch, status, err, ts, cost) in rows {
            sqlx::query(
                "INSERT INTO request_logs (ts, channel_name, model, protocol_in, status, is_stream, error, cost)
                 VALUES (?,?,?,?,?,?,?,?)",
            )
            .bind(ts)
            .bind(ch)
            .bind(model)
            .bind("openai")
            .bind(status)
            .bind(false)
            .bind(err)
            .bind(cost)
            .execute(pool)
            .await
            .unwrap();
        }
    }

    #[tokio::test]
    async fn query_filters_and_pagination() {
        let (pool, dir) = test_pool("q").await;
        seed_query_logs(&pool).await;

        let all = query_logs(&pool, &LogFilter::default()).await.unwrap();
        assert_eq!(all.1, 4);
        // 时间倒序
        assert_eq!(all.0[0].model, "claude-x");

        let f = LogFilter { status_class: Some("error".into()), ..Default::default() };
        let errs = query_logs(&pool, &f).await.unwrap();
        assert_eq!(errs.1, 1);
        assert_eq!(errs.0[0].status, 503);

        let f = LogFilter { model: Some("gpt".into()), ..Default::default() };
        assert_eq!(query_logs(&pool, &f).await.unwrap().1, 3);

        let f = LogFilter { keyword: Some("故障".into()), ..Default::default() };
        assert_eq!(query_logs(&pool, &f).await.unwrap().1, 1);

        let f = LogFilter { from_ts: Some(1_700_000_150_000), ..Default::default() };
        assert_eq!(query_logs(&pool, &f).await.unwrap().1, 2);

        // 分页
        let f = LogFilter { limit: 2, offset: 0, ..Default::default() };
        let page = query_logs(&pool, &f).await.unwrap();
        assert_eq!(page.0.len(), 2);
        assert_eq!(page.1, 4);

        // 详情含快照字段
        let d = get_request_log(&pool, page.0[0].id).await.unwrap().unwrap();
        assert_eq!(d.item.model, page.0[0].model);
        drop(pool);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn stats_summary_trend_and_groups() {
        let (pool, dir) = test_pool("s").await;
        seed_query_logs(&pool).await;

        let s = stats_summary(&pool, &LogFilter::default()).await.unwrap();
        assert_eq!(s.count, 4);
        assert_eq!(s.total_cost, 35);
        assert_eq!(s.error_count, 1);

        // 成功筛选联动
        let f = LogFilter { status_class: Some("success".into()), ..Default::default() };
        let s = stats_summary(&pool, &f).await.unwrap();
        assert_eq!(s.count, 3);
        assert_eq!(s.total_cost, 35);

        // 按小时分桶(4 条时间戳跨 5 分钟,应同桶)
        let t = stats_trend(&pool, &LogFilter::default(), 3_600_000).await.unwrap();
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].1, 4);
        assert_eq!(t[0].2, 35);

        let ch = stats_by_channel(&pool, &LogFilter::default()).await.unwrap();
        assert_eq!(ch.len(), 2);
        assert!(ch.contains(&("A".into(), 2)) && ch.contains(&("B".into(), 2)));

        let m = stats_top_models(&pool, &LogFilter::default(), 10).await.unwrap();
        assert_eq!(m.len(), 3); // gpt-a / gpt-b / claude-x
        assert_eq!(m[0].1, 2); // gpt-a 出现两次
        drop(pool);
        std::fs::remove_dir_all(&dir).ok();
    }
}

