-- 定价表支持美元计价:条目标记计价币种;请求日志记录实际计费币种
-- 价格单位语义:usd=0 时为 元/百万 token(不变),usd=1 时为 美元/百万 token
ALTER TABLE model_prices ADD COLUMN usd INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN currency TEXT NOT NULL DEFAULT 'cny';
