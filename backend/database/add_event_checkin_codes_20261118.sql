-- EC9 现场活动级签到码表（对齐 EC8 的 checkin_codes）
-- EC9 原有的 ec9_checkin_codes 是「每人一个出票码」(registration_id NOT NULL)，
-- 不能混用；本表专供 /checkin/<码> 现场统一签到入口。
CREATE TABLE IF NOT EXISTS ec9_event_checkin_codes (
  id            SERIAL PRIMARY KEY,
  event_id      INTEGER NOT NULL,
  code          VARCHAR(64) NOT NULL UNIQUE,
  code_type     SMALLINT NOT NULL DEFAULT 1,   -- 1 深圳专用 / 2 深圳+香港通用
  is_active     SMALLINT NOT NULL DEFAULT 1,
  created_by    VARCHAR(100),
  qr_code_url   VARCHAR(255),
  qr_code_data  TEXT,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ec9_event_checkin_codes_code ON ec9_event_checkin_codes (code);
