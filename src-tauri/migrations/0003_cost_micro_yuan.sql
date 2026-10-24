-- 费用单位从「分」改为「微元」(1e-6 元):
-- 旧分粒度下小额请求(缓存长上下文常 < 0.02 元)四舍五入虚高近 30%,
-- 微元与 UI 6 位小数显示精确对齐。1 分 = 10_000 微元。
UPDATE request_logs SET cost = cost * 10000 WHERE cost IS NOT NULL;
