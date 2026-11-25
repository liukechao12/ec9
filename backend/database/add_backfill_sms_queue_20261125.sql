-- 2026-11-25 后台「手动设置报名成功」修复：存量补登记短信发送队列
-- 幂等键 invitation_id；status: pending / skipped_intl / skipped_duplicate / sent / failed
CREATE TABLE IF NOT EXISTS ec9_backfill_sms_queue (
  id              SERIAL PRIMARY KEY,
  invitation_id   INTEGER      NOT NULL UNIQUE,
  guest_id        INTEGER      NOT NULL,
  registration_id INTEGER,
  phone           VARCHAR(32)  NOT NULL DEFAULT '',
  name            VARCHAR(100) NOT NULL DEFAULT '',
  status          VARCHAR(24)  NOT NULL DEFAULT 'pending',
  error           TEXT,
  batch           VARCHAR(32)  NOT NULL DEFAULT '20261125',
  sent_at         TIMESTAMP,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ec9_backfill_sms_queue_status ON ec9_backfill_sms_queue(status);
