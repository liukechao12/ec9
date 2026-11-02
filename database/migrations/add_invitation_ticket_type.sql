-- ============================================================
-- 增量迁移：邀约管理「赠票票种」（ec9_invitations.ticket_type_id）—— 幂等
-- 语义：管理员在邀约管理里指定「给这个人哪张票」。
--   · 有值  → 该人报名时**选这张票就免费**（应付 ¥0），选别的票照价付费
--   · NULL  → 未指定，按所选票种实际收费
-- 用法：psql -h <host> -U ec9 -d ec9 -f database/migrations/add_invitation_ticket_type.sql
-- ============================================================

ALTER TABLE ec9_invitations ADD COLUMN IF NOT EXISTS ticket_type_id INT NULL;
COMMENT ON COLUMN ec9_invitations.ticket_type_id IS '赠票票种 id：该邀约人选择此票种时免费（NULL=未指定，照所选票种收费）';
CREATE INDEX IF NOT EXISTS idx_ec9_inv_ticket ON ec9_invitations (ticket_type_id);

-- 说明（不自动改数据）：
-- 老邀约的 need_pay 默认 0（免票）。新口径「只有指定票种才免费」下，
-- 需要把真邀约（非报名自动生成的）的 need_pay 刷成 1，否则老邀约仍全免。
-- 这一步由部署时单独执行（会先备份 ec9_invitations），脚本见部署记录。
