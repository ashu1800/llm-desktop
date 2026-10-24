-- 渠道模型计费倍率规则(JSON 数组,空 = 全部 1.0)
ALTER TABLE channels ADD COLUMN rate_rules TEXT NOT NULL DEFAULT '[]';
-- 日志记录命中倍率(None = 未启用/1.0;仅展示用)
ALTER TABLE request_logs ADD COLUMN rate REAL;
