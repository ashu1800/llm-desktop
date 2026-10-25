-- 密钥级模型白名单与模型级渠道路由顺序
-- models: 允许该密钥使用的模型白名单(JSON 数组;空 = 不限制)
-- model_channels: 模型 → 有序渠道 id(JSON 对象;缺省/空 = 跟随密钥的渠道顺序)
ALTER TABLE api_keys ADD COLUMN models TEXT NOT NULL DEFAULT '[]';
ALTER TABLE api_keys ADD COLUMN model_channels TEXT NOT NULL DEFAULT '{}';
