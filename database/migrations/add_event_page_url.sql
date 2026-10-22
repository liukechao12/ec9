-- 增量迁移：会议绑定 H5 页面（幂等）
-- 业绩说明会报名 /api/registrations/submit-performance 靠 page_url 找会议，
-- 缺这个列时接口永远返回「未找到活动」，是死功能。
ALTER TABLE ec9_events ADD COLUMN IF NOT EXISTS page_url VARCHAR(120) NULL;
COMMENT ON COLUMN ec9_events.page_url IS '绑定的嘉宾侧页面：/pages/register /pages/invite /pages/checkin /pages/performance';
CREATE INDEX IF NOT EXISTS idx_ec9_events_page_url ON ec9_events (page_url);
