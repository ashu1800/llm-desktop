-- 同一模型支持双币种定价:人民币 4 价(原有列)+ 美元 4 价(可选);
-- 渠道选择计费币种(默认 cny)。旧 usd 标记行的价格迁移到 *_usd 列后删除标记列
ALTER TABLE model_prices ADD COLUMN input_usd REAL;
ALTER TABLE model_prices ADD COLUMN output_usd REAL;
ALTER TABLE model_prices ADD COLUMN cache_read_usd REAL;
ALTER TABLE model_prices ADD COLUMN cache_write_usd REAL;
ALTER TABLE channels ADD COLUMN price_currency TEXT NOT NULL DEFAULT 'cny';
UPDATE model_prices
  SET input_usd = input, output_usd = output, cache_read_usd = cache_read, cache_write_usd = cache_write,
      input = 0, output = 0, cache_read = 0, cache_write = 0
  WHERE usd = 1;
ALTER TABLE model_prices DROP COLUMN usd;
