//! 中国法定节假日判定:chnholiday 公共 API + 本地 JSON 缓存。
//! 用于计费倍率的"节假日"条件;查询失败不影响主流程(按星期兜底)。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;

use tokio::sync::RwLock;

/// API 端点(返回全年节假日+调休数据,包含 holiday 与补班工作日)
const API_URL: &str = "https://timor.tech/api/holiday/year/{year}";
/// 缓存有效期:节假日数据按年发布,缓存 7 天足够;失效重拉一次
const CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 3600);

#[derive(Default)]
struct HolidayCache {
    /// "YYYY-MM-DD" → true=休(holiday) false=班(调休补班工作日)
    map: HashMap<String, bool>,
    /// 已尝试拉取失败的年份(进程内不重复打,避免每请求一次外呼)
    failed_years: Vec<i32>,
    /// 正在拉取的年份(in-flight 标记):拉取在锁外进行,其余请求据此立即兜底
    in_flight: std::collections::HashSet<i32>,
}

static CACHE: OnceLock<RwLock<HolidayCache>> = OnceLock::new();

fn cache() -> &'static RwLock<HolidayCache> {
    CACHE.get_or_init(|| RwLock::new(HolidayCache::default()))
}

/// 缓存文件:app 数据目录由调用方传入;独立进程(如 dev)共享同一路径
fn cache_file(dir: &std::path::Path) -> PathBuf {
    dir.join("holidays.json")
}

/// 日类型判定结果:节假日 / 调休补班工作日 / 未知(普通日期或数据不可用)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DayKind {
    Holiday,
    MakeupWorkday,
    Unknown,
}

/// 判定日期类型。
/// Holiday=法定休;MakeupWorkday=调休补班(周末但需上班,计费应视作工作日);
/// Unknown=普通日期或数据不可用(调用方按星期兜底)
///
/// 网络拉取在**锁外**进行:写锁内 await 外呼会让并发判定全部排队(响应关键路径
/// 最坏被拖 10s)。用 in-flight 标记保证同一年只拉一次,其余请求直接按星期兜底
/// 返回(下次请求命中缓存)。
pub async fn day_kind(date: chrono::NaiveDate) -> Result<DayKind, String> {
    let year = date.year();
    let key = date.format("%Y-%m-%d").to_string();
    let cache = cache();
    // 1) 快路径:命中缓存直接返回
    {
        let c = cache.read().await;
        if let Some(v) = c.map.get(&key) {
            return Ok(kind_of(*v));
        }
    }
    // 2) 慢路径准备:短写锁内做不 await 的操作(文件加载 + in-flight 登记)。
    //    返回 NeedFetch(year) 表示需要锁外拉取;AlreadyFetching 表示另一任务在拉,
    //    本次直接按星期兜底(避免排队)
    enum Action {
        Ready(DayKind),
        NeedFetch(i32),
        Busy,
    }
    let action = {
        let mut c = cache.write().await;
        if let Some(v) = c.map.get(&key) {
            Action::Ready(kind_of(*v))
        } else if c.in_flight.contains(&year) {
            Action::Busy
        } else {
            // 文件兜底(同步 IO,不 await,允许在写锁内);
            // 快照超 7 天视为过期不加载(节假日数据按年发布,过期数据可能错判)
            let dir = cache_dir();
            let path = cache_file(&dir);
            let expired = std::fs::metadata(&path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > CACHE_TTL);
            if !expired {
                let _ = load_cache_file(&mut c, &dir);
            }
            if let Some(v) = c.map.get(&key) {
                Action::Ready(kind_of(*v))
            } else {
                c.in_flight.insert(year);
                Action::NeedFetch(year)
            }
        }
    };
    match action {
        Action::Ready(kind) => Ok(kind),
        Action::Busy => Err(format!("节假日数据拉取中({year}),本次按星期兜底")),
        Action::NeedFetch(y) => {
            // 锁外网络拉取:并发请求不等此结果,各自按星期兜底
            let result = fetch_year(y).await;
            // 短写锁回填
            let ret = {
                let mut c = cache.write().await;
                c.in_flight.remove(&y);
                match &result {
                    Ok(entries) => {
                        for (k, v) in entries {
                            c.map.insert(k.clone(), *v);
                        }
                        // 原子写:临时文件 + rename,避免崩溃留截断文件
                        let dir = cache_dir();
                        let tmp = cache_file(&dir).with_extension("json.tmp");
                        if std::fs::write(
                            &tmp,
                            serde_json::to_string(&c.map).unwrap_or_default(),
                        )
                        .is_ok()
                        {
                            let _ = std::fs::rename(&tmp, cache_file(&dir));
                        }
                        c.map.get(&key).map(|v| kind_of(*v)).ok_or_else(|| {
                            format!("节假日数据无该日期({key})")
                        })
                    }
                    Err(e) => {
                        c.failed_years.push(y);
                        Err(format!("节假日拉取失败({y}): {e}"))
                    }
                }
            };
            ret
        }
    }
}

fn kind_of(is_off: bool) -> DayKind {
    if is_off {
        DayKind::Holiday
    } else {
        DayKind::MakeupWorkday
    }
}

use chrono::Datelike;

/// 缓存目录:应用数据目录由入口(set_data_dir)注入一次;
/// 未注入时退回系统临时目录(只影响缓存命中,不影响正确性)
fn cache_dir() -> PathBuf {
    DATA_DIR
        .get()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(std::env::temp_dir)
}

static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 入口注入应用数据目录(main/init_state 调用一次)
pub fn set_data_dir(dir: PathBuf) {
    let _ = DATA_DIR.set(dir);
}

/// 拉取一年数据:timor.tech 返回 {"holiday": {"01-01": {"holiday": true,...},...}}
async fn fetch_year(year: i32) -> Result<HashMap<String, bool>, String> {
    let url = API_URL.replace("{year}", &year.to_string());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .header("user-agent", concat!("LLM-Gateway/", env!("CARGO_PKG_VERSION")))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let holidays = v
        .get("holiday")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| "响应缺少 holiday 字段".to_string())?;
    let mut out = HashMap::new();
    for (k, item) in holidays {
        // key 形如 "01-01",补全年份;"holiday": true=休,false=调休补班
        let is_off = item.get("holiday").and_then(serde_json::Value::as_bool);
        let Some(is_off) = is_off else { continue };
        out.insert(format!("{year}-{k}"), is_off);
    }
    Ok(out)
}

/// 从缓存文件装载(覆盖式合并,文件是上次全量快照)
fn load_cache_file(c: &mut HolidayCache, dir: &std::path::Path) -> Result<(), String> {
    let text = std::fs::read_to_string(cache_file(dir)).map_err(|e| e.to_string())?;
    let map: HashMap<String, bool> =
        serde_json::from_str(&text).map_err(|e| e.to_string())?;
    c.map.extend(map);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn known_dates() {
        // 2026 春节法定假期首日(2026-02-15 除夕起休,以 API 返回为准:
        // 这里只断言函数不 panic 且返回结果;具体值依赖外部 API,离线时 Err 也接受)
        let d = chrono::NaiveDate::from_ymd_opt(2026, 2, 16).unwrap();
        let _ = day_kind(d).await;
        // 周一非节假日:数据可用时必非 Holiday(普通日期 = Unknown 或 MakeupWorkday
        // 以 API 数据为准,只有数据明确说"休"才是 Holiday)
        let monday = chrono::NaiveDate::from_ymd_opt(2026, 1, 5).unwrap();
        if let Ok(kind) = day_kind(monday).await {
            assert_ne!(kind, DayKind::Holiday, "2026-01-05 普通周一不应为节假日");
        } // 离线环境:Err 合法,rate.rs 有星期兜底
    }
}
