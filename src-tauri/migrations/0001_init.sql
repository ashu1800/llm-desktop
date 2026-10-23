-- 初始 schema:渠道 / 自建密钥 / 全局定价表 / 请求日志 / 设置
-- 所有时间戳存 UTC epoch 毫秒;JSON 字段以 TEXT 存储

CREATE TABLE channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('openai', 'anthropic', 'gemini')),
  base_url TEXT NOT NULL,
  api_keys TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  proxy TEXT,
  models TEXT NOT NULL DEFAULT '[]',
  model_map TEXT NOT NULL DEFAULT '{}',
  timeout_override TEXT,
  breaker_override TEXT,
  remark TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  channels TEXT NOT NULL DEFAULT '[]',
  remark TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE model_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern TEXT NOT NULL UNIQUE,
  input REAL NOT NULL DEFAULT 0,
  output REAL NOT NULL DEFAULT 0,
  cache_read REAL NOT NULL DEFAULT 0,
  cache_write REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  key_id INTEGER,
  key_name TEXT,
  channel_id INTEGER,
  channel_name TEXT,
  model TEXT NOT NULL,
  mapped_model TEXT,
  tag TEXT,
  protocol_in TEXT,
  protocol_up TEXT,
  status INTEGER NOT NULL,
  is_stream INTEGER NOT NULL DEFAULT 0,
  attempts TEXT,
  error TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  estimated INTEGER NOT NULL DEFAULT 0,
  ttft_ms INTEGER,
  total_ms INTEGER,
  speed REAL,
  cost INTEGER,
  client TEXT,
  req_snapshot TEXT,
  resp_snapshot TEXT
);

CREATE INDEX idx_request_logs_ts ON request_logs (ts DESC);
CREATE INDEX idx_request_logs_key_ts ON request_logs (key_id, ts);
CREATE INDEX idx_request_logs_channel_ts ON request_logs (channel_id, ts);
CREATE INDEX idx_request_logs_model_ts ON request_logs (model, ts);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
