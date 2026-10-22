-- 增量迁移：短信通道配置后台化（幂等）
-- 用法：node backend/scripts/init-sms-config.js
-- ============================================================
-- 22. 短信通道配置后台化（原 ALIYUN_* / SMS_* 环境变量迁入库）
-- ============================================================
ALTER TABLE ec9_sms_providers ADD COLUMN IF NOT EXISTS region VARCHAR(30) NOT NULL DEFAULT 'cn-hangzhou';
ALTER TABLE ec9_sms_providers ADD COLUMN IF NOT EXISTS endpoint VARCHAR(120) NULL;
ALTER TABLE ec9_sms_providers ADD COLUMN IF NOT EXISTS sign_name VARCHAR(60) NULL;
ALTER TABLE ec9_sms_providers ADD COLUMN IF NOT EXISTS verify_template_code VARCHAR(60) NULL;
ALTER TABLE ec9_sms_providers ADD COLUMN IF NOT EXISTS code_expire_minutes INTEGER NOT NULL DEFAULT 5;
ALTER TABLE ec9_sms_providers ADD COLUMN IF NOT EXISTS code_resend_seconds INTEGER NOT NULL DEFAULT 60;
ALTER TABLE ec9_sms_providers ADD COLUMN IF NOT EXISTS code_max_attempts INTEGER NOT NULL DEFAULT 5;
ALTER TABLE ec9_sms_providers ADD COLUMN IF NOT EXISTS code_daily_limit INTEGER NOT NULL DEFAULT 10;
COMMENT ON COLUMN ec9_sms_providers.config_encrypted IS '通道凭证 JSON（accessKeyId/accessKeySecret，AES 加密，对外只回掩码）';
COMMENT ON COLUMN ec9_sms_providers.sign_name IS '短信签名（阿里云审核通过的签名）';
COMMENT ON COLUMN ec9_sms_providers.verify_template_code IS '验证码短信模板 CODE';
