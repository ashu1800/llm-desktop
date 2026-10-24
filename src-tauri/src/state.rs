use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};

use sqlx::SqlitePool;
use tokio::sync::mpsc::Sender;

use crate::billing::pricing::PriceTable;
use crate::breaker::BreakerTable;
use crate::transform::responses::ResponseStore;
use crate::events::GatewayEvent;
use crate::server::ServerHandle;
use crate::settings::AppSettings;
use crate::store::api_keys::ApiKey;
use crate::store::channels::Channel;
use crate::store::logs::RequestLog;

/// 进程级共享状态:配置变更只更新缓存,数据面每请求读取,热生效
#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub settings: Arc<RwLock<AppSettings>>,
    /// 当前代理监听句柄;None = 服务已停止
    pub server: Arc<Mutex<Option<ServerHandle>>>,
    pub channels: Arc<RwLock<Vec<Channel>>>,
    pub keys: Arc<RwLock<Vec<ApiKey>>>,
    pub prices: Arc<RwLock<PriceTable>>,
    /// 熔断状态机(进程内存态)
    pub breakers: Arc<BreakerTable>,
    /// Responses API previous_response_id 的进程内 LRU
    pub resp_store: Arc<ResponseStore>,
    /// 请求日志队列发送端(满时丢弃,不阻塞响应)
    pub log_tx: Sender<RequestLog>,
    /// 网关事件通道(proxy 内无 AppHandle,经此转发到前端 + 托盘)
    pub event_tx: Sender<GatewayEvent>,
    /// reqwest 客户端按 (代理, 连接超时) 缓存,复用连接池
    pub http: Arc<Mutex<HashMap<String, reqwest::Client>>>,
    /// 渠道密钥池轮询起点
    pub key_counters: Arc<Mutex<HashMap<i64, usize>>>,
    /// 监听生命周期互斥:start/stop/端口切换串行化,避免并发更新句柄丢失
    pub listen_lock: Arc<tokio::sync::Mutex<()>>,
}

impl AppState {
    pub fn new(
        db: SqlitePool,
        settings: AppSettings,
        log_tx: Sender<RequestLog>,
        event_tx: Sender<GatewayEvent>,
    ) -> Self {
        Self {
            db,
            settings: Arc::new(RwLock::new(settings)),
            server: Arc::new(Mutex::new(None)),
            channels: Arc::new(RwLock::new(Vec::new())),
            keys: Arc::new(RwLock::new(Vec::new())),
            prices: Arc::new(RwLock::new(PriceTable::default())),
            breakers: Arc::new(BreakerTable::default()),
            resp_store: Arc::new(ResponseStore::default()),
            log_tx,
            event_tx,
            http: Arc::new(Mutex::new(HashMap::new())),
            key_counters: Arc::new(Mutex::new(HashMap::new())),
            listen_lock: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    pub fn current_settings(&self) -> AppSettings {
        crate::util::read_ok(&self.settings).clone()
    }

    pub async fn reload_channels(&self) -> Result<(), String> {
        let v = crate::store::channels::list(&self.db).await?;
        *crate::util::write_ok(&self.channels) = v;
        Ok(())
    }

    pub async fn reload_keys(&self) -> Result<(), String> {
        let v = crate::store::api_keys::list(&self.db).await?;
        *crate::util::write_ok(&self.keys) = v;
        Ok(())
    }

    pub async fn reload_prices(&self) -> Result<(), String> {
        let rows = crate::store::prices::list(&self.db).await?;
        *crate::util::write_ok(&self.prices) = PriceTable { rows };
        Ok(())
    }
}
