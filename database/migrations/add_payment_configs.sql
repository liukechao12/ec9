-- 增量迁移：新增支付渠道配置表（幂等，可重复执行）
-- 用法：node backend/scripts/run-sql.js database/migrations/add_payment_configs.sql

-- ============================================================
-- 21. 支付渠道配置（后台可改，热更新）
-- ============================================================
CREATE TABLE IF NOT EXISTS ec9_payment_configs (
  id SERIAL PRIMARY KEY,
  channel VARCHAR(20) NOT NULL DEFAULT 'wechat',
  mode VARCHAR(20) NOT NULL DEFAULT 'mock',
  enabled SMALLINT NOT NULL DEFAULT 1,
  app_id VARCHAR(64) NULL,
  mch_id VARCHAR(32) NULL,
  sub_app_id VARCHAR(64) NULL,
  sub_mch_id VARCHAR(32) NULL,
  api_key_enc TEXT NULL,
  api_v3_key_enc TEXT NULL,
  sign_type VARCHAR(10) NOT NULL DEFAULT 'MD5',
  cert_path VARCHAR(255) NULL,
  cert_serial_no VARCHAR(64) NULL,
  notify_url VARCHAR(255) NULL,
  refund_notify_url VARCHAR(255) NULL,
  order_expire_minutes INTEGER NOT NULL DEFAULT 30,
  remark VARCHAR(500) NULL,
  updated_by INTEGER NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE ec9_payment_configs IS 'EC9 支付渠道配置（微信支付资质，后台可改）';
COMMENT ON COLUMN ec9_payment_configs.channel IS 'wechat 微信支付 / alipay 支付宝（二期预留）';
COMMENT ON COLUMN ec9_payment_configs.mode IS 'mock 模拟 / sandbox 沙箱 / real 生产';
COMMENT ON COLUMN ec9_payment_configs.api_key_enc IS 'API v2 密钥（AES 加密，对外只回掩码）';
COMMENT ON COLUMN ec9_payment_configs.api_v3_key_enc IS 'API v3 密钥（AES 加密，V3 接口预留）';
COMMENT ON COLUMN ec9_payment_configs.cert_path IS '退款用 API 证书 apiclient_cert.p12 绝对路径';
CREATE UNIQUE INDEX IF NOT EXISTS uk_ec9_pay_config_channel ON ec9_payment_configs (channel);
DROP TRIGGER IF EXISTS trg_ec9_payment_configs_updated ON ec9_payment_configs;
CREATE TRIGGER trg_ec9_payment_configs_updated BEFORE UPDATE ON ec9_payment_configs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
