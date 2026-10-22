-- ============================================================
-- EC9 报名系统建表脚本（PostgreSQL）
-- 由 scripts/export-schema.js 从运行库反向生成，幂等，可重复执行
-- 生成时间：2026-10-21T22:34:20.317Z
-- 用法：psql -h $DB_HOST -U $DB_USER -d $DB_NAME -f database/ec9_schema.sql
-- ============================================================

-- ---------- ec9_admins ----------
CREATE SEQUENCE IF NOT EXISTS ec9_admins_id_seq;
CREATE TABLE IF NOT EXISTS ec9_admins (
  id INT4 NOT NULL DEFAULT nextval('ec9_admins_id_seq'::regclass),
  username VARCHAR(50) NOT NULL,
  password VARCHAR(255) NOT NULL,
  name VARCHAR(50),
  role VARCHAR(20) NOT NULL DEFAULT 'bd'::character varying,
  contact VARCHAR(100),
  lang VARCHAR(10) NOT NULL DEFAULT 'zh-CN'::character varying,
  token_version INT4 NOT NULL DEFAULT 0,
  status INT2 NOT NULL DEFAULT 1,
  last_login_at TIMESTAMP,
  last_login_ip VARCHAR(45),
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  last_login_time TIMESTAMP,
  PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_ec9_admin_username ON public.ec9_admins USING btree (username);

-- ---------- ec9_approvals ----------
CREATE SEQUENCE IF NOT EXISTS ec9_approvals_id_seq;
CREATE TABLE IF NOT EXISTS ec9_approvals (
  id INT4 NOT NULL DEFAULT nextval('ec9_approvals_id_seq'::regclass),
  target_type VARCHAR(20) NOT NULL,
  target_id INT4 NOT NULL,
  event_id INT4,
  action VARCHAR(20) NOT NULL,
  operator_id INT4,
  operator_name VARCHAR(100),
  reason VARCHAR(500),
  price_before NUMERIC(10,2),
  price_after NUMERIC(10,2),
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_ec9_appr_target ON public.ec9_approvals USING btree (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_ec9_appr_event ON public.ec9_approvals USING btree (event_id);

-- ---------- ec9_auto_audit_rules ----------
CREATE SEQUENCE IF NOT EXISTS ec9_auto_audit_rules_id_seq;
CREATE TABLE IF NOT EXISTS ec9_auto_audit_rules (
  id INT4 NOT NULL DEFAULT nextval('ec9_auto_audit_rules_id_seq'::regclass),
  event_id INT4 NOT NULL,
  name VARCHAR(200) NOT NULL,
  conditions JSONB NOT NULL,
  enabled INT2 NOT NULL DEFAULT 1,
  priority INT4 NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_ec9_rule_event ON public.ec9_auto_audit_rules USING btree (event_id, enabled);

-- ---------- ec9_checkin_codes ----------
CREATE SEQUENCE IF NOT EXISTS ec9_checkin_codes_id_seq;
CREATE TABLE IF NOT EXISTS ec9_checkin_codes (
  id INT4 NOT NULL DEFAULT nextval('ec9_checkin_codes_id_seq'::regclass),
  registration_id INT4 NOT NULL,
  guest_id INT4 NOT NULL,
  event_id INT4 NOT NULL,
  code VARCHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active'::character varying,
  generated_at TIMESTAMP,
  used_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_ec9_checkin_code ON public.ec9_checkin_codes USING btree (code);
CREATE INDEX IF NOT EXISTS idx_ec9_cc_reg ON public.ec9_checkin_codes USING btree (registration_id);
CREATE INDEX IF NOT EXISTS idx_ec9_cc_event ON public.ec9_checkin_codes USING btree (event_id);

-- ---------- ec9_checkins ----------
CREATE SEQUENCE IF NOT EXISTS ec9_checkins_id_seq;
CREATE TABLE IF NOT EXISTS ec9_checkins (
  id INT4 NOT NULL DEFAULT nextval('ec9_checkins_id_seq'::regclass),
  checkin_code_id INT4 NOT NULL,
  registration_id INT4 NOT NULL,
  guest_id INT4 NOT NULL,
  event_id INT4 NOT NULL,
  operator_id INT4,
  operator_name VARCHAR(100),
  checkin_time TIMESTAMP NOT NULL DEFAULT now(),
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  location_type INT2,
  location VARCHAR(255),
  invitation_id INT4,
  device_info VARCHAR(255),
  user_agent VARCHAR(500),
  ip_address VARCHAR(45),
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_ec9_checkin_event ON public.ec9_checkins USING btree (event_id);
CREATE INDEX IF NOT EXISTS idx_ec9_checkin_guest ON public.ec9_checkins USING btree (guest_id);

-- ---------- ec9_events ----------
CREATE SEQUENCE IF NOT EXISTS ec9_events_id_seq;
CREATE TABLE IF NOT EXISTS ec9_events (
  id INT4 NOT NULL DEFAULT nextval('ec9_events_id_seq'::regclass),
  name VARCHAR(200) NOT NULL,
  description TEXT,
  i18n JSONB,
  cover_image VARCHAR(500),
  location VARCHAR(200),
  address VARCHAR(500),
  start_time TIMESTAMP,
  end_time TIMESTAMP,
  signup_start_time TIMESTAMP,
  signup_end_time TIMESTAMP,
  status INT2 NOT NULL DEFAULT 1,
  audit_mode VARCHAR(20) NOT NULL DEFAULT 'manual'::character varying,
  pay_expire_hours INT4 NOT NULL DEFAULT 48,
  extra_fields JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  page_url VARCHAR(120),
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_ec9_event_status ON public.ec9_events USING btree (status);
CREATE INDEX IF NOT EXISTS idx_ec9_events_page_url ON public.ec9_events USING btree (page_url);

-- ---------- ec9_guests ----------
CREATE SEQUENCE IF NOT EXISTS ec9_guests_id_seq;
CREATE TABLE IF NOT EXISTS ec9_guests (
  id INT4 NOT NULL DEFAULT nextval('ec9_guests_id_seq'::regclass),
  name VARCHAR(100) NOT NULL,
  phone VARCHAR(255),
  phone_hmac VARCHAR(64),
  company VARCHAR(200),
  position VARCHAR(100),
  email VARCHAR(200),
  tags JSONB,
  source VARCHAR(50),
  bd_id VARCHAR(100),
  remark VARCHAR(500),
  modification_history JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  status INT2 NOT NULL DEFAULT 1,
  extra_fields JSONB,
  PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_ec9_guest_phone_hmac ON public.ec9_guests USING btree (phone_hmac);
CREATE INDEX IF NOT EXISTS idx_ec9_guest_bd ON public.ec9_guests USING btree (bd_id);

-- ---------- ec9_invitations ----------
CREATE SEQUENCE IF NOT EXISTS ec9_invitations_id_seq;
CREATE TABLE IF NOT EXISTS ec9_invitations (
  id INT4 NOT NULL DEFAULT nextval('ec9_invitations_id_seq'::regclass),
  event_id INT4 NOT NULL,
  guest_id INT4 NOT NULL,
  invite_code VARCHAR(32) NOT NULL,
  source_bd VARCHAR(100),
  approval_status INT2 NOT NULL DEFAULT 0,
  approval_time TIMESTAMP,
  approval_by VARCHAR(100),
  approval_remark TEXT,
  registration_status INT2 NOT NULL DEFAULT 0,
  is_valid INT2 NOT NULL DEFAULT 1,
  extra_fields JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  registration_time TIMESTAMP,
  PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_ec9_invite_code ON public.ec9_invitations USING btree (invite_code);
CREATE INDEX IF NOT EXISTS idx_ec9_inv_event ON public.ec9_invitations USING btree (event_id);
CREATE INDEX IF NOT EXISTS idx_ec9_inv_guest ON public.ec9_invitations USING btree (guest_id);
CREATE INDEX IF NOT EXISTS idx_ec9_inv_approval ON public.ec9_invitations USING btree (approval_status);

-- ---------- ec9_legal_docs ----------
CREATE SEQUENCE IF NOT EXISTS ec9_legal_docs_id_seq;
CREATE TABLE IF NOT EXISTS ec9_legal_docs (
  id INT4 NOT NULL DEFAULT nextval('ec9_legal_docs_id_seq'::regclass),
  doc_type VARCHAR(30) NOT NULL,
  lang VARCHAR(10) NOT NULL DEFAULT 'zh-CN'::character varying,
  title VARCHAR(200) NOT NULL,
  content TEXT,
  version VARCHAR(20) NOT NULL DEFAULT '1.0'::character varying,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_ec9_legal_doc ON public.ec9_legal_docs USING btree (doc_type, lang, version);

-- ---------- ec9_operation_logs ----------
CREATE SEQUENCE IF NOT EXISTS ec9_operation_logs_id_seq;
CREATE TABLE IF NOT EXISTS ec9_operation_logs (
  id INT4 NOT NULL DEFAULT nextval('ec9_operation_logs_id_seq'::regclass),
  admin_id INT4,
  admin_name VARCHAR(100),
  role VARCHAR(20),
  action VARCHAR(100) NOT NULL,
  module VARCHAR(50),
  target_type VARCHAR(50),
  target_id VARCHAR(100),
  detail TEXT,
  ip VARCHAR(45),
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_ec9_oplog_operator ON public.ec9_operation_logs USING btree (admin_id);
CREATE INDEX IF NOT EXISTS idx_ec9_oplog_module ON public.ec9_operation_logs USING btree (module);
CREATE INDEX IF NOT EXISTS idx_ec9_oplog_time ON public.ec9_operation_logs USING btree (created_at);

-- ---------- ec9_orders ----------
CREATE SEQUENCE IF NOT EXISTS ec9_orders_id_seq;
CREATE TABLE IF NOT EXISTS ec9_orders (
  id INT4 NOT NULL DEFAULT nextval('ec9_orders_id_seq'::regclass),
  order_no VARCHAR(64) NOT NULL,
  registration_id INT4 NOT NULL,
  guest_id INT4 NOT NULL,
  event_id INT4 NOT NULL,
  session_id INT4 NOT NULL DEFAULT 0,
  ticket_type_id INT4 NOT NULL DEFAULT 0,
  quantity INT4 NOT NULL DEFAULT 1,
  unit_price NUMERIC(10,2) NOT NULL,
  total_amount NUMERIC(10,2) NOT NULL,
  coupon_id INT4,
  discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  final_amount NUMERIC(10,2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending_payment'::character varying,
  expire_at TIMESTAMP,
  paid_at TIMESTAMP,
  closed_at TIMESTAMP,
  refunded_at TIMESTAMP,
  remark VARCHAR(500),
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  group_no VARCHAR(40),
  price_detail JSON,
  discount_rate NUMERIC(4,2) DEFAULT 1.00,
  pay_token VARCHAR(64),
  PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_ec9_order_no ON public.ec9_orders USING btree (order_no);
CREATE INDEX IF NOT EXISTS idx_ec9_order_reg ON public.ec9_orders USING btree (registration_id);
CREATE INDEX IF NOT EXISTS idx_ec9_order_status ON public.ec9_orders USING btree (status);
CREATE INDEX IF NOT EXISTS idx_ec9_order_expire ON public.ec9_orders USING btree (status, expire_at);
CREATE INDEX IF NOT EXISTS idx_order_group_no ON public.ec9_orders USING btree (group_no);
CREATE INDEX IF NOT EXISTS idx_order_pay_token ON public.ec9_orders USING btree (pay_token);

-- ---------- ec9_payment_configs ----------
CREATE SEQUENCE IF NOT EXISTS ec9_payment_configs_id_seq;
CREATE TABLE IF NOT EXISTS ec9_payment_configs (
  id INT4 NOT NULL DEFAULT nextval('ec9_payment_configs_id_seq'::regclass),
  channel VARCHAR(20) NOT NULL DEFAULT 'wechat'::character varying,
  mode VARCHAR(20) NOT NULL DEFAULT 'mock'::character varying,
  enabled INT2 NOT NULL DEFAULT 1,
  app_id VARCHAR(64),
  mch_id VARCHAR(32),
  sub_app_id VARCHAR(64),
  sub_mch_id VARCHAR(32),
  api_key_enc TEXT,
  api_v3_key_enc TEXT,
  sign_type VARCHAR(10) NOT NULL DEFAULT 'MD5'::character varying,
  cert_path VARCHAR(255),
  cert_serial_no VARCHAR(64),
  notify_url VARCHAR(255),
  refund_notify_url VARCHAR(255),
  order_expire_minutes INT4 NOT NULL DEFAULT 30,
  remark VARCHAR(500),
  updated_by INT4,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_ec9_pay_config_channel ON public.ec9_payment_configs USING btree (channel);

-- ---------- ec9_payments ----------
CREATE SEQUENCE IF NOT EXISTS ec9_payments_id_seq;
CREATE TABLE IF NOT EXISTS ec9_payments (
  id INT4 NOT NULL DEFAULT nextval('ec9_payments_id_seq'::regclass),
  order_id INT4 NOT NULL,
  channel VARCHAR(20) NOT NULL DEFAULT 'wechat'::character varying,
  out_trade_no VARCHAR(64) NOT NULL,
  transaction_id VARCHAR(64),
  prepay_id VARCHAR(128),
  amount NUMERIC(10,2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'created'::character varying,
  notify_raw JSONB,
  paid_at TIMESTAMP,
  refunded_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_ec9_pay_out_trade_no ON public.ec9_payments USING btree (out_trade_no);
CREATE INDEX IF NOT EXISTS idx_ec9_pay_order ON public.ec9_payments USING btree (order_id);
CREATE INDEX IF NOT EXISTS idx_ec9_pay_txn ON public.ec9_payments USING btree (transaction_id);

-- ---------- ec9_registrations ----------
CREATE SEQUENCE IF NOT EXISTS ec9_registrations_id_seq;
CREATE TABLE IF NOT EXISTS ec9_registrations (
  id INT4 NOT NULL DEFAULT nextval('ec9_registrations_id_seq'::regclass),
  event_id INT4 NOT NULL,
  session_id INT4 NOT NULL DEFAULT 0,
  ticket_type_id INT4 NOT NULL DEFAULT 0,
  guest_id INT4 NOT NULL,
  invitation_id INT4,
  form_data JSONB,
  status VARCHAR(20) NOT NULL DEFAULT 'submitted'::character varying,
  reject_reason VARCHAR(500),
  submitted_at TIMESTAMP,
  audited_at TIMESTAMP,
  source_bd VARCHAR(100),
  extra_fields JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  registration_time TIMESTAMP,
  focus VARCHAR(200),
  group_no VARCHAR(40),
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_ec9_reg_event ON public.ec9_registrations USING btree (event_id);
CREATE INDEX IF NOT EXISTS idx_ec9_reg_guest ON public.ec9_registrations USING btree (guest_id);
CREATE INDEX IF NOT EXISTS idx_ec9_reg_status ON public.ec9_registrations USING btree (status);
CREATE INDEX IF NOT EXISTS idx_ec9_reg_session ON public.ec9_registrations USING btree (session_id);
CREATE INDEX IF NOT EXISTS idx_reg_group_no ON public.ec9_registrations USING btree (group_no);

-- ---------- ec9_sessions ----------
CREATE SEQUENCE IF NOT EXISTS ec9_sessions_id_seq;
CREATE TABLE IF NOT EXISTS ec9_sessions (
  id INT4 NOT NULL DEFAULT nextval('ec9_sessions_id_seq'::regclass),
  event_id INT4 NOT NULL,
  name VARCHAR(200) NOT NULL,
  i18n JSONB,
  start_time TIMESTAMP,
  end_time TIMESTAMP,
  location VARCHAR(200),
  stock_total INT4 NOT NULL DEFAULT 0,
  stock_locked INT4 NOT NULL DEFAULT 0,
  stock_sold INT4 NOT NULL DEFAULT 0,
  status INT2 NOT NULL DEFAULT 1,
  sort INT4 NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_ec9_session_event ON public.ec9_sessions USING btree (event_id);

-- ---------- ec9_sms_logs ----------
CREATE SEQUENCE IF NOT EXISTS ec9_sms_logs_id_seq;
CREATE TABLE IF NOT EXISTS ec9_sms_logs (
  id INT4 NOT NULL DEFAULT nextval('ec9_sms_logs_id_seq'::regclass),
  provider_id INT4,
  phone VARCHAR(255),
  template_id INT4,
  message_type VARCHAR(50),
  scene VARCHAR(50),
  lang VARCHAR(10) NOT NULL DEFAULT 'zh-CN'::character varying,
  content TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'::character varying,
  error VARCHAR(500),
  retry_count INT4 NOT NULL DEFAULT 0,
  sent_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_ec9_smslog_type ON public.ec9_sms_logs USING btree (message_type, scene);

-- ---------- ec9_sms_providers ----------
CREATE SEQUENCE IF NOT EXISTS ec9_sms_providers_id_seq;
CREATE TABLE IF NOT EXISTS ec9_sms_providers (
  id INT4 NOT NULL DEFAULT nextval('ec9_sms_providers_id_seq'::regclass),
  name VARCHAR(50) NOT NULL,
  config_encrypted TEXT,
  enabled INT2 NOT NULL DEFAULT 0,
  is_default INT2 NOT NULL DEFAULT 0,
  remark VARCHAR(500),
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  region VARCHAR(30) NOT NULL DEFAULT 'cn-hangzhou'::character varying,
  endpoint VARCHAR(120),
  sign_name VARCHAR(60),
  verify_template_code VARCHAR(60),
  code_expire_minutes INT4 NOT NULL DEFAULT 5,
  code_resend_seconds INT4 NOT NULL DEFAULT 60,
  code_max_attempts INT4 NOT NULL DEFAULT 5,
  code_daily_limit INT4 NOT NULL DEFAULT 10,
  PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_ec9_provider_name ON public.ec9_sms_providers USING btree (name);

-- ---------- ec9_sms_templates ----------
CREATE SEQUENCE IF NOT EXISTS ec9_sms_templates_id_seq;
CREATE TABLE IF NOT EXISTS ec9_sms_templates (
  id INT4 NOT NULL DEFAULT nextval('ec9_sms_templates_id_seq'::regclass),
  provider_id INT4,
  message_type VARCHAR(50) NOT NULL,
  scene VARCHAR(50) NOT NULL DEFAULT 'default'::character varying,
  template_code VARCHAR(128),
  lang VARCHAR(10) NOT NULL DEFAULT 'zh-CN'::character varying,
  content TEXT,
  enabled INT2 NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_ec9_sms_tpl_lang ON public.ec9_sms_templates USING btree (message_type, scene, lang);

-- ---------- ec9_ticket_types ----------
CREATE SEQUENCE IF NOT EXISTS ec9_ticket_types_id_seq;
CREATE TABLE IF NOT EXISTS ec9_ticket_types (
  id INT4 NOT NULL DEFAULT nextval('ec9_ticket_types_id_seq'::regclass),
  event_id INT4 NOT NULL,
  session_id INT4 NOT NULL DEFAULT 0,
  name VARCHAR(200) NOT NULL,
  i18n JSONB,
  description VARCHAR(500),
  price NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  original_price NUMERIC(10,2),
  stock_total INT4 NOT NULL DEFAULT 0,
  stock_locked INT4 NOT NULL DEFAULT 0,
  stock_sold INT4 NOT NULL DEFAULT 0,
  per_order_limit INT4 NOT NULL DEFAULT 1,
  on_shelf INT2 NOT NULL DEFAULT 1,
  product_type VARCHAR(20) NOT NULL DEFAULT 'ticket'::character varying,
  coupon_enabled INT2 NOT NULL DEFAULT 0,
  sort INT4 NOT NULL DEFAULT 0,
  status INT2 NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  is_student INT2 DEFAULT 0,
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_ec9_tt_event ON public.ec9_ticket_types USING btree (event_id);
CREATE INDEX IF NOT EXISTS idx_ec9_tt_session ON public.ec9_ticket_types USING btree (session_id);

-- ---------- ec9_verification_codes ----------
CREATE SEQUENCE IF NOT EXISTS ec9_verification_codes_id_seq;
CREATE TABLE IF NOT EXISTS ec9_verification_codes (
  id INT4 NOT NULL DEFAULT nextval('ec9_verification_codes_id_seq'::regclass),
  phone_hmac VARCHAR(64) NOT NULL,
  code_hash VARCHAR(64) NOT NULL,
  purpose VARCHAR(20) NOT NULL DEFAULT 'register'::character varying,
  ip VARCHAR(45),
  attempts INT4 NOT NULL DEFAULT 0,
  max_attempts INT4 NOT NULL DEFAULT 5,
  expires_at TIMESTAMP NOT NULL,
  consumed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_ec9_vcode_phone ON public.ec9_verification_codes USING btree (phone_hmac, purpose);
CREATE INDEX IF NOT EXISTS idx_ec9_vcode_expire ON public.ec9_verification_codes USING btree (expires_at);

-- ---------- ec9_verification_tokens ----------
CREATE SEQUENCE IF NOT EXISTS ec9_verification_tokens_id_seq;
CREATE TABLE IF NOT EXISTS ec9_verification_tokens (
  id INT4 NOT NULL DEFAULT nextval('ec9_verification_tokens_id_seq'::regclass),
  token VARCHAR(128) NOT NULL,
  phone_hmac VARCHAR(64) NOT NULL,
  purpose VARCHAR(20) NOT NULL DEFAULT 'register'::character varying,
  used INT2 NOT NULL DEFAULT 0,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_ec9_vtoken ON public.ec9_verification_tokens USING btree (token);
CREATE INDEX IF NOT EXISTS idx_ec9_vtoken_phone ON public.ec9_verification_tokens USING btree (phone_hmac);

