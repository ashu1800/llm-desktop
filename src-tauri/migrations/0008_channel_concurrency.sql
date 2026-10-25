-- 渠道级并发上限:限制该渠道同时在途的请求数;NULL = 不限
ALTER TABLE channels ADD COLUMN max_concurrency INTEGER;
