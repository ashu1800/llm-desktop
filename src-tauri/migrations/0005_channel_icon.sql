-- 渠道图标:emoji 或图片 dataURL(与客户端图标同规格,64KB 上限)
ALTER TABLE channels ADD COLUMN icon TEXT NOT NULL DEFAULT '';
