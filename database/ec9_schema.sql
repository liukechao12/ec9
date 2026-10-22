-- ============================================================
-- EC9 报名系统 · 全量数据库结构（PostgreSQL 版 v1.1）
-- 2026-10-14 起 EC9 主库从 MySQL 迁至 PostgreSQL
--   表名统一 ec9_ 前缀（与 EC8 业务隔离，即使同实例也不冲突）
--   开发期建于本机 PostgreSQL（localhost:5432/ec9）
--   客户独立库账号到位后，同一份脚本在新库直接执行，代码只改 .env 三项
-- 方言要点：SERIAL 自增 / JSONB 结构化多语 / TIMESTAMP / NUMERIC
--   updated_at 由触发器自动维护（替代 MySQL ON UPDATE CURRENT_TIMESTAMP）
-- ============================================================

-- 通用更新时间触发器
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------
-- 1. 管理员与 BD 账号
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ec9_admins (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) NOT NULL,
  password VARCHAR(255) NOT NULL,
  name VARCHAR(50) NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'bd',
  contact VARCHAR(100) NULL,
  lang VARCHAR(10) NOT NULL DEFAULT 'zh-CN',
  token_version INT NOT NULL DEFAULT 0,
  status SMALLINT NOT NULL DEFAULT 1,
last_login_at TIMESTAMP NULL,
  last_login_time TIMESTAMP NULL,
  last_login_ip VARCHAR(45) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE ec9_admins IS 'EC9 管理员与 BD 账号';
COMMENT ON COLUMN ec9_admins.username IS '登录名';
COMMENT ON COLUMN ec9_admins.role IS '角色：admin 管理员 / bd 商务负责人';
COMMENT ON COLUMN ec9_admins.token_version IS 'Token 版本号（单点登录控制）';
CREATE UNIQUE INDEX IF NOT EXISTS uk_ec9_admin_username ON ec9_admins (username);
DROP TRIGGER IF EXISTS trg_ec9_admins_updated ON ec9_admins;
CREATE TRIGGER trg_ec9_admins_updated BEFORE UPDATE ON ec9_admins FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- 2. 活动 / 会议
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ec9_events (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  description TEXT NULL,
  i18n JSONB NULL,
  cover_image VARCHAR(500) NULL,
  location VARCHAR(200) NULL,
  address VARCHAR(500) NULL,
  start_time TIMESTAMP NULL,
  end_time TIMESTAMP NULL,
  signup_start_time TIMESTAMP NULL,
  signup_end_time TIMESTAMP NULL,
  status SMALLINT NOT NULL DEFAULT 1,
  audit_mode VARCHAR(20) NOT NULL DEFAULT 'manual',
  pay_expire_hours INT NOT NULL DEFAULT 48,
  extra_fields JSONB NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE ec9_events IS 'EC9 活动/会议';
COMMENT ON COLUMN ec9_events.i18n IS '多语结构化存储：{name:{zh-CN,zh-TW,en},description:{...},location:{...}}，加语种不改表结构';
COMMENT ON COLUMN ec9_events.status IS '状态：0-已取消，1-进行中/进行，2-已结束（与 EC8 后台数字语义一致）';
COMMENT ON COLUMN ec9_events.audit_mode IS '审核方式：auto 全自动 / manual 人工 / hybrid 自动+人工';
COMMENT ON COLUMN ec9_events.pay_expire_hours IS '付款有效期（小时），超时自动关单';
CREATE INDEX IF NOT EXISTS idx_ec9_event_status ON ec9_events (status);
DROP TRIGGER IF EXISTS trg_ec9_events_updated ON ec9_events;
CREATE TRIGGER trg_ec9_events_updated BEFORE UPDATE ON ec9_events FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- 3. 场次（归属活动，独立库存）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ec9_sessions (
  id SERIAL PRIMARY KEY,
  event_id INT NOT NULL,
  name VARCHAR(200) NOT NULL,
  i18n JSONB NULL,
  start_time TIMESTAMP NULL,
  end_time TIMESTAMP NULL,
  location VARCHAR(200) NULL,
  stock_total INT NOT NULL DEFAULT 0,
  stock_locked INT NOT NULL DEFAULT 0,
  stock_sold INT NOT NULL DEFAULT 0,
  status SMALLINT NOT NULL DEFAULT 1,
  sort INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE ec9_sessions IS 'EC9 场次';
COMMENT ON COLUMN ec9_sessions.stock_locked IS '已锁定（审核通过未付款）';
CREATE INDEX IF NOT EXISTS idx_ec9_session_event ON ec9_sessions (event_id);
DROP TRIGGER IF EXISTS trg_ec9_sessions_updated ON ec9_sessions;
CREATE TRIGGER trg_ec9_sessions_updated BEFORE UPDATE ON ec9_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- 4. 票种（关联场次；预留优惠券/周边字段）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ec9_ticket_types (
  id SERIAL PRIMARY KEY,
  event_id INT NOT NULL,
  session_id INT NOT NULL DEFAULT 0,
  name VARCHAR(200) NOT NULL,
  i18n JSONB NULL,
  description VARCHAR(500) NULL,
  price NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  original_price NUMERIC(10,2) NULL,
  stock_total INT NOT NULL DEFAULT 0,
  stock_locked INT NOT NULL DEFAULT 0,
  stock_sold INT NOT NULL DEFAULT 0,
  per_order_limit INT NOT NULL DEFAULT 1,
  on_shelf SMALLINT NOT NULL DEFAULT 1,
  product_type VARCHAR(20) NOT NULL DEFAULT 'ticket',
  coupon_enabled SMALLINT NOT NULL DEFAULT 0,
  sort INT NOT NULL DEFAULT 0,
  status SMALLINT NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE ec9_ticket_types IS 'EC9 票种';
COMMENT ON COLUMN ec9_ticket_types.session_id IS '关联场次，0=全部场次通用';
COMMENT ON COLUMN ec9_ticket_types.product_type IS '商品类型（预留）：ticket 票 / merch 周边';
COMMENT ON COLUMN ec9_ticket_types.coupon_enabled IS '是否可用券（预留）';
CREATE INDEX IF NOT EXISTS idx_ec9_tt_event ON ec9_ticket_types (event_id);
CREATE INDEX IF NOT EXISTS idx_ec9_tt_session ON ec9_ticket_types (session_id);
DROP TRIGGER IF EXISTS trg_ec9_ticket_types_updated ON ec9_ticket_types;
CREATE TRIGGER trg_ec9_ticket_types_updated BEFORE UPDATE ON ec9_ticket_types FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- 5. 嘉宾（手机号加密存储 + HMAC 索引）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ec9_guests (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  phone VARCHAR(255) NULL,
  phone_hmac VARCHAR(64) NULL,
  company VARCHAR(200) NULL,
  position VARCHAR(100) NULL,
  email VARCHAR(200) NULL,
  tags JSONB NULL,
  source VARCHAR(50) NULL,
  bd_id VARCHAR(100) NULL,
  remark VARCHAR(500) NULL,
  status SMALLINT NOT NULL DEFAULT 1,
  extra_fields JSONB NULL,
  modification_history JSONB NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE ec9_guests IS 'EC9 嘉宾';
COMMENT ON COLUMN ec9_guests.phone IS '手机号（AES 加密）';
COMMENT ON COLUMN ec9_guests.phone_hmac IS '手机号 HMAC-SHA256（检索索引，不可逆）';
COMMENT ON COLUMN ec9_guests.source IS '来源：web / bd_invite / performance';
COMMENT ON COLUMN ec9_guests.status IS '状态：0-已删除/无效，1-有效（与 EC8 数字语义一致）';
COMMENT ON COLUMN ec9_guests.extra_fields IS '自定义扩展字段（后台可配置字段）';
CREATE UNIQUE INDEX IF NOT EXISTS uk_ec9_guest_phone_hmac ON ec9_guests (phone_hmac);
CREATE INDEX IF NOT EXISTS idx_ec9_guest_bd ON ec9_guests (bd_id);
DROP TRIGGER IF EXISTS trg_ec9_guests_updated ON ec9_guests;
CREATE TRIGGER trg_ec9_guests_updated BEFORE UPDATE ON ec9_guests FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- 6. 邀约（BD 定向邀约；审批字段真实读写）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ec9_invitations (
  id SERIAL PRIMARY KEY,
  event_id INT NOT NULL,
  guest_id INT NOT NULL,
  invite_code VARCHAR(32) NOT NULL,
  source_bd VARCHAR(100) NULL,
  approval_status SMALLINT NOT NULL DEFAULT 0,
  approval_time TIMESTAMP NULL,
  approval_by VARCHAR(100) NULL,
  approval_remark TEXT NULL,
  registration_status SMALLINT NOT NULL DEFAULT 0,
  registration_time TIMESTAMP NULL,
  is_valid SMALLINT NOT NULL DEFAULT 1,
  extra_fields JSONB NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE ec9_invitations IS 'EC9 邀约';
COMMENT ON COLUMN ec9_invitations.approval_status IS '0 无需审批 1 待审批 2 已通过 3 已拒绝';
COMMENT ON COLUMN ec9_invitations.registration_status IS '0 未报名 1 待审批 2 已报名 3 已拒绝';
CREATE UNIQUE INDEX IF NOT EXISTS uk_ec9_invite_code ON ec9_invitations (invite_code);
CREATE INDEX IF NOT EXISTS idx_ec9_inv_event ON ec9_invitations (event_id);
CREATE INDEX IF NOT EXISTS idx_ec9_inv_guest ON ec9_invitations (guest_id);
CREATE INDEX IF NOT EXISTS idx_ec9_inv_approval ON ec9_invitations (approval_status);
DROP TRIGGER IF EXISTS trg_ec9_invitations_updated ON ec9_invitations;
CREATE TRIGGER trg_ec9_invitations_updated BEFORE UPDATE ON ec9_invitations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- 7. 报名记录（核心状态机载体）
--    submitted 已提交 → pending_audit 待审核 → approved 审核通过
--    → paid 已付款（付费票）/ rejected 已驳回 / closed 已关闭 / cancelled 已取消
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ec9_registrations (
  id SERIAL PRIMARY KEY,
  event_id INT NOT NULL,
  session_id INT NOT NULL DEFAULT 0,
  ticket_type_id INT NOT NULL DEFAULT 0,
  guest_id INT NOT NULL,
  invitation_id INT NULL,
  form_data JSONB NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'submitted',
  reject_reason VARCHAR(500) NULL,
  submitted_at TIMESTAMP NULL,
  registration_time TIMESTAMP NULL,
  audited_at TIMESTAMP NULL,
  source_bd VARCHAR(100) NULL,
  extra_fields JSONB NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE ec9_registrations IS 'EC9 报名记录';
COMMENT ON COLUMN ec9_registrations.status IS 'submitted/pending_audit/approved/rejected/paid/closed/cancelled';
CREATE INDEX IF NOT EXISTS idx_ec9_reg_event ON ec9_registrations (event_id);
CREATE INDEX IF NOT EXISTS idx_ec9_reg_guest ON ec9_registrations (guest_id);
CREATE INDEX IF NOT EXISTS idx_ec9_reg_status ON ec9_registrations (status);
CREATE INDEX IF NOT EXISTS idx_ec9_reg_session ON ec9_registrations (session_id);
DROP TRIGGER IF EXISTS trg_ec9_registrations_updated ON ec9_registrations;
CREATE TRIGGER trg_ec9_registrations_updated BEFORE UPDATE ON ec9_registrations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- 8. 订单（锁价 + 状态机；预留优惠券字段）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ec9_orders (
  id SERIAL PRIMARY KEY,
  order_no VARCHAR(64) NOT NULL,
  registration_id INT NOT NULL,
  guest_id INT NOT NULL,
  event_id INT NOT NULL,
  session_id INT NOT NULL DEFAULT 0,
  ticket_type_id INT NOT NULL DEFAULT 0,
  quantity INT NOT NULL DEFAULT 1,
  unit_price NUMERIC(10,2) NOT NULL,
  total_amount NUMERIC(10,2) NOT NULL,
  coupon_id INT NULL,
  discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  final_amount NUMERIC(10,2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending_payment',
  expire_at TIMESTAMP NULL,
  paid_at TIMESTAMP NULL,
  closed_at TIMESTAMP NULL,
  refunded_at TIMESTAMP NULL,
  remark VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE ec9_orders IS 'EC9 订单';
COMMENT ON COLUMN ec9_orders.unit_price IS '锁定的成交单价（指定价格>票种价>原价）';
COMMENT ON COLUMN ec9_orders.status IS 'pending_payment/paid/closed/refunded';
COMMENT ON COLUMN ec9_orders.coupon_id IS '优惠券 ID（预留）';
COMMENT ON COLUMN ec9_orders.discount_amount IS '优惠金额（预留）';
CREATE UNIQUE INDEX IF NOT EXISTS uk_ec9_order_no ON ec9_orders (order_no);
CREATE INDEX IF NOT EXISTS idx_ec9_order_reg ON ec9_orders (registration_id);
CREATE INDEX IF NOT EXISTS idx_ec9_order_status ON ec9_orders (status);
CREATE INDEX IF NOT EXISTS idx_ec9_order_expire ON ec9_orders (status, expire_at);
DROP TRIGGER IF EXISTS trg_ec9_orders_updated ON ec9_orders;
CREATE TRIGGER trg_ec9_orders_updated BEFORE UPDATE ON ec9_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- 9. 支付流水（微信；验签与幂等依据）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ec9_payments (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL,
  channel VARCHAR(20) NOT NULL DEFAULT 'wechat',
  out_trade_no VARCHAR(64) NOT NULL,
  transaction_id VARCHAR(64) NULL,
  prepay_id VARCHAR(128) NULL,
  amount NUMERIC(10,2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'created',
  notify_raw JSONB NULL,
  paid_at TIMESTAMP NULL,
  refunded_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE ec9_payments IS 'EC9 支付流水';
COMMENT ON COLUMN ec9_payments.status IS 'created/success/refunding/refunded/closed';
COMMENT ON COLUMN ec9_payments.notify_raw IS '回调报文原文（对账用）';
CREATE UNIQUE INDEX IF NOT EXISTS uk_ec9_pay_out_trade_no ON ec9_payments (out_trade_no);
CREATE INDEX IF NOT EXISTS idx_ec9_pay_order ON ec9_payments (order_id);
CREATE INDEX IF NOT EXISTS idx_ec9_pay_txn ON ec9_payments (transaction_id);
DROP TRIGGER IF EXISTS trg_ec9_payments_updated ON ec9_payments;
CREATE TRIGGER trg_ec9_payments_updated BEFORE UPDATE ON ec9_payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- 10. 审核记录（全流程留痕，含改价前后值）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ec9_approvals (
  id SERIAL PRIMARY KEY,
  target_type VARCHAR(20) NOT NULL,
  target_id INT NOT NULL,
  event_id INT NULL,
  action VARCHAR(20) NOT NULL,
  operator_id INT NULL,
  operator_name VARCHAR(100) NULL,
  reason VARCHAR(500) NULL,
  price_before NUMERIC(10,2) NULL,
  price_after NUMERIC(10,2) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE ec9_approvals IS 'EC9 审核记录';
COMMENT ON COLUMN ec9_approvals.target_type IS '审核对象：registration / invitation';
COMMENT ON COLUMN ec9_approvals.action IS 'approve 通过 / reject 驳回 / auto_approve 自动通过 / price_override 改价';
CREATE INDEX IF NOT EXISTS idx_ec9_appr_target ON ec9_approvals (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_ec9_appr_event ON ec9_approvals (event_id);

-- ------------------------------------------------------------
-- 11. 自动审核规则（条件配置化，不写死）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ec9_auto_audit_rules (
  id SERIAL PRIMARY KEY,
  event_id INT NOT NULL,
  name VARCHAR(200) NOT NULL,
  conditions JSONB NOT NULL,
  enabled SMALLINT NOT NULL DEFAULT 1,
  priority INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE ec9_auto_audit_rules IS 'EC9 自动审核规则';
COMMENT ON COLUMN ec9_auto_audit_rules.conditions IS '条件组合：{all:[{field,op,value}...]}，field 如 source/paid/ticket_type_id/session_id/bd_whitelist/invite_code';
CREATE INDEX IF NOT EXISTS idx_ec9_rule_event ON ec9_auto_audit_rules (event_id, enabled);
DROP TRIGGER IF EXISTS trg_ec9_auto_audit_rules_updated ON ec9_auto_audit_rules;
CREATE TRIGGER trg_ec9_auto_audit_rules_updated BEFORE UPDATE ON ec9_auto_audit_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- 12. 签到码（审核通过才生成；付费票需付款成功）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ec9_checkin_codes (
  id SERIAL PRIMARY KEY,
  registration_id INT NOT NULL,
  guest_id INT NOT NULL,
  event_id INT NOT NULL,
  code VARCHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  generated_at TIMESTAMP NULL,
  used_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE ec9_checkin_codes IS 'EC9 签到码';
COMMENT ON COLUMN ec9_checkin_codes.status IS 'active 有效 / used 已使用 / revoked 已撤销';
CREATE UNIQUE INDEX IF NOT EXISTS uk_ec9_checkin_code ON ec9_checkin_codes (code);
CREATE INDEX IF NOT EXISTS idx_ec9_cc_reg ON ec9_checkin_codes (registration_id);
CREATE INDEX IF NOT EXISTS idx_ec9_cc_event ON ec9_checkin_codes (event_id);

-- ------------------------------------------------------------
-- 13. 签到记录
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ec9_checkins (
  id SERIAL PRIMARY KEY,
  checkin_code_id INT NOT NULL,
  registration_id INT NOT NULL,
  guest_id INT NOT NULL,
  event_id INT NOT NULL,
  invitation_id INT NULL,
  operator_id INT NULL,
  operator_name VARCHAR(100) NULL,
  checkin_time TIMESTAMP NOT NULL DEFAULT NOW(),
  location_type SMALLINT NULL,
  location VARCHAR(255) NULL,
  device_info VARCHAR(255) NULL,
  user_agent VARCHAR(500) NULL,
  ip_address VARCHAR(45) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE ec9_checkins IS 'EC9 签到记录';
COMMENT ON COLUMN ec9_checkins.location_type IS '签到地点类型：1-深圳，2-深圳+香港';
CREATE INDEX IF NOT EXISTS idx_ec9_checkin_event ON ec9_checkins (event_id);
CREATE INDEX IF NOT EXISTS idx_ec9_checkin_guest ON ec9_checkins (guest_id);

-- ------------------------------------------------------------
-- 14. 短信通道（可插拔；凭证加密存储）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ec9_sms_providers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  config_encrypted TEXT NULL,
  enabled SMALLINT NOT NULL DEFAULT 0,
  is_default SMALLINT NOT NULL DEFAULT 0,
  remark VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE ec9_sms_providers IS 'EC9 短信通道';
COMMENT ON COLUMN ec9_sms_providers.name IS 'aliyun 阿里云 / qiniu 七牛云 / tencent 腾讯云';
COMMENT ON COLUMN ec9_sms_providers.config_encrypted IS '服务商凭证（AES 加密 JSON）';
CREATE UNIQUE INDEX IF NOT EXISTS uk_ec9_provider_name ON ec9_sms_providers (name);
DROP TRIGGER IF EXISTS trg_ec9_sms_providers_updated ON ec9_sms_providers;
CREATE TRIGGER trg_ec9_sms_providers_updated BEFORE UPDATE ON ec9_sms_providers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- 15. 短信模板（一语种一条）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ec9_sms_templates (
  id SERIAL PRIMARY KEY,
  provider_id INT NULL,
  message_type VARCHAR(50) NOT NULL,
  scene VARCHAR(50) NOT NULL DEFAULT 'default',
  template_code VARCHAR(128) NULL,
  lang VARCHAR(10) NOT NULL DEFAULT 'zh-CN',
  content TEXT NULL,
  enabled SMALLINT NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE ec9_sms_templates IS 'EC9 短信模板';
COMMENT ON COLUMN ec9_sms_templates.message_type IS '业务类型：verification / audit_result / payment_link / payment_success / checkin_reminder';
COMMENT ON COLUMN ec9_sms_templates.lang IS '语种：zh-CN / en / zh-TW';
CREATE UNIQUE INDEX IF NOT EXISTS uk_ec9_sms_tpl_lang ON ec9_sms_templates (message_type, scene, lang);
DROP TRIGGER IF EXISTS trg_ec9_sms_templates_updated ON ec9_sms_templates;
CREATE TRIGGER trg_ec9_sms_templates_updated BEFORE UPDATE ON ec9_sms_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- 16. 短信发送日志
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ec9_sms_logs (
  id SERIAL PRIMARY KEY,
  provider_id INT NULL,
  phone VARCHAR(255) NULL,
  template_id INT NULL,
  message_type VARCHAR(50) NULL,
  scene VARCHAR(50) NULL,
  lang VARCHAR(10) NOT NULL DEFAULT 'zh-CN',
  content TEXT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  error VARCHAR(500) NULL,
  retry_count INT NOT NULL DEFAULT 0,
  sent_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE ec9_sms_logs IS 'EC9 短信发送日志';
COMMENT ON COLUMN ec9_sms_logs.status IS 'pending/sent/failed';
CREATE INDEX IF NOT EXISTS idx_ec9_smslog_type ON ec9_sms_logs (message_type, scene);

-- ------------------------------------------------------------
-- 17. 验证码（服务端强制校验；哈希存储，不存明文）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ec9_verification_codes (
  id SERIAL PRIMARY KEY,
  phone_hmac VARCHAR(64) NOT NULL,
  code_hash VARCHAR(64) NOT NULL,
  purpose VARCHAR(20) NOT NULL DEFAULT 'register',
  ip VARCHAR(45) NULL,
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  expires_at TIMESTAMP NOT NULL,
  consumed_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE ec9_verification_codes IS 'EC9 短信验证码';
COMMENT ON COLUMN ec9_verification_codes.code_hash IS '验证码哈希（HMAC-SHA256）';
COMMENT ON COLUMN ec9_verification_codes.expires_at IS '过期时间（5 分钟）';
CREATE INDEX IF NOT EXISTS idx_ec9_vcode_phone ON ec9_verification_codes (phone_hmac, purpose);
CREATE INDEX IF NOT EXISTS idx_ec9_vcode_expire ON ec9_verification_codes (expires_at);

-- ------------------------------------------------------------
-- 18. 验证凭证（校验通过签发，提交接口强制验票）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ec9_verification_tokens (
  id SERIAL PRIMARY KEY,
  token VARCHAR(128) NOT NULL,
  phone_hmac VARCHAR(64) NOT NULL,
  purpose VARCHAR(20) NOT NULL DEFAULT 'register',
  used SMALLINT NOT NULL DEFAULT 0,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE ec9_verification_tokens IS 'EC9 验证凭证';
COMMENT ON COLUMN ec9_verification_tokens.expires_at IS '有效期（2 小时）';
CREATE UNIQUE INDEX IF NOT EXISTS uk_ec9_vtoken ON ec9_verification_tokens (token);
CREATE INDEX IF NOT EXISTS idx_ec9_vtoken_phone ON ec9_verification_tokens (phone_hmac);

-- ------------------------------------------------------------
-- 19. 操作日志（敏感字段脱敏后落库）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ec9_operation_logs (
  id SERIAL PRIMARY KEY,
  admin_id INT NULL,
  admin_name VARCHAR(100) NULL,
  role VARCHAR(20) NULL,
  action VARCHAR(100) NOT NULL,
  module VARCHAR(50) NULL,
  target_type VARCHAR(50) NULL,
  target_id VARCHAR(100) NULL,
  detail TEXT NULL,
  ip VARCHAR(45) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE ec9_operation_logs IS 'EC9 操作日志';
COMMENT ON COLUMN ec9_operation_logs.detail IS '详情（已脱敏）';
CREATE INDEX IF NOT EXISTS idx_ec9_oplog_operator ON ec9_operation_logs (operator_id);
CREATE INDEX IF NOT EXISTS idx_ec9_oplog_module ON ec9_operation_logs (module);
CREATE INDEX IF NOT EXISTS idx_ec9_oplog_time ON ec9_operation_logs (created_at);

-- ------------------------------------------------------------
-- 20. 用户协议 / 隐私政策（多语言）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ec9_legal_docs (
  id SERIAL PRIMARY KEY,
  doc_type VARCHAR(30) NOT NULL,
  lang VARCHAR(10) NOT NULL DEFAULT 'zh-CN',
  title VARCHAR(200) NOT NULL,
  content TEXT NULL,
  version VARCHAR(20) NOT NULL DEFAULT '1.0',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE ec9_legal_docs IS 'EC9 法律文档（多语言）';
COMMENT ON COLUMN ec9_legal_docs.doc_type IS 'user_agreement 用户协议 / privacy_policy 隐私政策';
CREATE UNIQUE INDEX IF NOT EXISTS uk_ec9_legal_doc ON ec9_legal_docs (doc_type, lang, version);
DROP TRIGGER IF EXISTS trg_ec9_legal_docs_updated ON ec9_legal_docs;
CREATE TRIGGER trg_ec9_legal_docs_updated BEFORE UPDATE ON ec9_legal_docs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

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
-- 增量迁移：会议绑定 H5 页面（幂等）
-- 业绩说明会报名 /api/registrations/submit-performance 靠 page_url 找会议，
-- 缺这个列时接口永远返回「未找到活动」，是死功能。
ALTER TABLE ec9_events ADD COLUMN IF NOT EXISTS page_url VARCHAR(120) NULL;
COMMENT ON COLUMN ec9_events.page_url IS '绑定的嘉宾侧页面：/pages/register /pages/invite /pages/checkin /pages/performance';
CREATE INDEX IF NOT EXISTS idx_ec9_events_page_url ON ec9_events (page_url);
