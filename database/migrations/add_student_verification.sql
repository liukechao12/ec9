-- ============================================================
-- 增量迁移：学生票学籍核验（天远 API IVYZX7J9）—— 幂等，可重复执行
-- 用法：psql -h <host> -U ec9 -d ec9 -f database/migrations/add_student_verification.sql
-- ============================================================

-- updated_at 自动更新函数（老库可能没建过，这里补上；已存在则覆盖为同一实现）
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------
-- 1. 学籍核验通道配置（单行 name='tianyuan'，后台可改，热更新）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ec9_student_verify_configs (
  id SERIAL PRIMARY KEY,
  name VARCHAR(30) NOT NULL DEFAULT 'tianyuan',
  provider VARCHAR(30) NOT NULL DEFAULT 'tianyuan',
  product_code VARCHAR(40) NOT NULL DEFAULT 'IVYZX7J9',
  endpoint VARCHAR(200) NOT NULL DEFAULT 'https://api.tianyuanapi.com',
  access_id VARCHAR(120) NOT NULL DEFAULT '',
  config_encrypted TEXT NULL,
  enabled SMALLINT NOT NULL DEFAULT 0,
  reuse_days INT NOT NULL DEFAULT 30,
  timeout_ms INT NOT NULL DEFAULT 8000,
  on_not_enrolled VARCHAR(20) NOT NULL DEFAULT 'reject',
  on_unknown VARCHAR(20) NOT NULL DEFAULT 'manual',
  remark VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE ec9_student_verify_configs IS '学生票学籍核验通道配置（后台可改，改完热更新，凭证加密存储）';
COMMENT ON COLUMN ec9_student_verify_configs.config_encrypted IS '凭证 JSON（access_key，AES 加密），对外只回掩码';
COMMENT ON COLUMN ec9_student_verify_configs.enabled IS '1=启用核验，0=不核验（学生票维持现场核验）';
COMMENT ON COLUMN ec9_student_verify_configs.reuse_days IS '同一人核验结果的复用天数（期内不再调 API，省钱）';
COMMENT ON COLUMN ec9_student_verify_configs.on_not_enrolled IS '不在籍处置：reject 直接不允许买学生票 / manual 转人工';
COMMENT ON COLUMN ec9_student_verify_configs.on_unknown IS '接口异常或无法判断时的处置：manual 转人工 / reject 拒绝';
CREATE UNIQUE INDEX IF NOT EXISTS uk_ec9_svc_name ON ec9_student_verify_configs (name);
DROP TRIGGER IF EXISTS trg_ec9_svc_updated ON ec9_student_verify_configs;
CREATE TRIGGER trg_ec9_svc_updated BEFORE UPDATE ON ec9_student_verify_configs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- 2. 学籍核验流水（每次真实调用一行；命中的复用不新增行）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ec9_student_verifications (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL DEFAULT '',
  id_card_hmac VARCHAR(64) NOT NULL DEFAULT '',
  id_card_encrypted TEXT NULL,
  id_card_mask VARCHAR(30) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'unknown',
  api_code VARCHAR(60) NULL,
  api_message VARCHAR(500) NULL,
  transaction_id VARCHAR(80) NULL,
  provider VARCHAR(30) NOT NULL DEFAULT 'tianyuan',
  product_code VARCHAR(40) NULL,
  raw_response JSONB NULL,
  guest_id INT NULL,
  event_id INT NULL,
  registration_id INT NULL,
  group_no VARCHAR(40) NULL,
  verified_at TIMESTAMP NULL,
  expires_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE ec9_student_verifications IS '学生票学籍核验流水（身份证加密存储，姓名+证件号 HMAC 索引用于复用）';
COMMENT ON COLUMN ec9_student_verifications.status IS 'enrolled 在籍 / not_enrolled 不在籍 / unknown 无法判断 / error 接口异常';
COMMENT ON COLUMN ec9_student_verifications.id_card_hmac IS 'HMAC-SHA256(name|id_card)，仅用于查重与复用，不可逆';
COMMENT ON COLUMN ec9_student_verifications.id_card_encrypted IS 'AES-256-CBC 密文（iv:cipher）';
COMMENT ON COLUMN ec9_student_verifications.expires_at IS '复用截止：过期后同一人重新调 API';
CREATE INDEX IF NOT EXISTS idx_ec9_sv_hmac ON ec9_student_verifications (id_card_hmac);
CREATE INDEX IF NOT EXISTS idx_ec9_sv_status ON ec9_student_verifications (status);
CREATE INDEX IF NOT EXISTS idx_ec9_sv_verified ON ec9_student_verifications (verified_at);
CREATE INDEX IF NOT EXISTS idx_ec9_sv_reg ON ec9_student_verifications (registration_id);
DROP TRIGGER IF EXISTS trg_ec9_sv_updated ON ec9_student_verifications;
CREATE TRIGGER trg_ec9_sv_updated BEFORE UPDATE ON ec9_student_verifications FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 老库补列（幂等）
ALTER TABLE ec9_student_verify_configs ADD COLUMN IF NOT EXISTS on_unknown VARCHAR(20) NOT NULL DEFAULT 'manual';
ALTER TABLE ec9_student_verify_configs ADD COLUMN IF NOT EXISTS timeout_ms INT NOT NULL DEFAULT 8000;
