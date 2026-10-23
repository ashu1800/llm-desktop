-- 未定价模型清单:请求成功但价格表无匹配时收集,供统计页徽标与一键补录回填
CREATE TABLE unpriced_models (
  model TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL
);
