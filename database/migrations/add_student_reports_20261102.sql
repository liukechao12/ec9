-- ============================================================
-- 增量迁移：学生票改为「上传《教育部学籍在线验证报告》+ 人工复核」
-- 幂等，可重复执行
-- 用法：psql -h <host> -U ec9 -d ec9 -f database/migrations/add_student_reports_20261102.sql
-- ============================================================

-- updated_at 自动更新函数（老库可能没建过，这里补上；已存在则覆盖为同一实现）
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------
-- 1. 学生票学籍报告（一人一份，报名时随单上传，后台人工复核）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ec9_student_reports (
  id SERIAL PRIMARY KEY,
  registration_id INT NULL,
  group_no VARCHAR(40) NULL,
  guest_id INT NULL,
  event_id INT NULL,
  name VARCHAR(100) NOT NULL DEFAULT '',
  phone_masked VARCHAR(30) NULL,
  file_path VARCHAR(300) NOT NULL,
  file_name VARCHAR(255) NOT NULL DEFAULT '',
  mime VARCHAR(80) NOT NULL DEFAULT '',
  file_size INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  verify_code VARCHAR(80) NULL,
  review_note VARCHAR(500) NULL,
  reviewed_by VARCHAR(80) NULL,
  reviewed_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE ec9_student_reports IS '学生票《教育部学籍在线验证报告》上传与人工复核记录';
COMMENT ON COLUMN ec9_student_reports.file_path IS '相对 backend 根目录的私有路径，不在 public/uploads 下，须经鉴权接口读取';
COMMENT ON COLUMN ec9_student_reports.status IS 'pending=待复核 / approved=符合 / rejected=不符合';
COMMENT ON COLUMN ec9_student_reports.verify_code IS '管理员按报告人工复核时记录的在线验证码（选填，便于复查/导出）';
COMMENT ON COLUMN ec9_student_reports.review_note IS '人工复核备注（不符合原因等）';
CREATE INDEX IF NOT EXISTS idx_ec9_sr_group ON ec9_student_reports (group_no);
CREATE INDEX IF NOT EXISTS idx_ec9_sr_reg ON ec9_student_reports (registration_id);
CREATE INDEX IF NOT EXISTS idx_ec9_sr_status ON ec9_student_reports (status);
DROP TRIGGER IF EXISTS trg_ec9_sr_updated ON ec9_student_reports;
CREATE TRIGGER trg_ec9_sr_updated BEFORE UPDATE ON ec9_student_reports
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- 2. 停用所有学籍核验 API 通道（天远 / 聚美智数均不可用）
--    保留配置与历史流水供查询，只是不再发起任何外部调用
-- ------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.ec9_student_verify_configs') IS NOT NULL THEN
    UPDATE ec9_student_verify_configs SET enabled = 0 WHERE enabled <> 0;
  END IF;
END $$;
