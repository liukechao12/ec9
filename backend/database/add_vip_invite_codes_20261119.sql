-- EC9 老板特邀邀约码（2026-11-19）
-- 两个通用码，一个绑定标准票、一个绑定尊享票；扫码报名免费 + 免审核 + 直接出票。
-- 与个人出票码 ec9_checkin_codes、活动签到码 ec9_event_checkin_codes 并存，互不影响。
CREATE TABLE IF NOT EXISTS ec9_vip_invite_codes (
  id             SERIAL PRIMARY KEY,
  code           VARCHAR(32)  NOT NULL UNIQUE,
  name           VARCHAR(100) NOT NULL,
  ticket_type_id INTEGER      NOT NULL,
  is_active      SMALLINT     NOT NULL DEFAULT 1,
  use_count      INTEGER      NOT NULL DEFAULT 0,
  remark         VARCHAR(255),
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE ec9_vip_invite_codes IS '老板特邀邀约二维码：一码锁定一种票，扫码报名免费免审直接出票';
COMMENT ON COLUMN ec9_vip_invite_codes.ticket_type_id IS '锁定票种 id，后端强制覆盖前端传值';
COMMENT ON COLUMN ec9_vip_invite_codes.use_count IS '成功出票次数（仅成功时递增）';
