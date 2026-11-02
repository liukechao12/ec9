-- 增量迁移：报名可选多个论坛（幂等，可重复执行）
--
-- 背景：论坛从「单选」改成「多选」——可以只去上午，也可以上午 + 两个下午，
--       全勾就是「全部论坛」。原来一个人的选择只能落在
--       ec9_registrations.session_id 这一个字段里，装不下多个。
--
-- 方案：加关联表 ec9_registration_sessions，一人对多行。
--       口径（改这块代码前必读）：
--         session_all = 1                    → 全部论坛（展示时直接写「全部论坛」，
--                                              不逐条枚举，这样以后加论坛也不会露出老数据）
--         session_all = 0 + 关联表有行        → 选了若干个具体论坛
--         session_all = 0 + 关联表无行        → 未选（或选的论坛已被删，待业务确认）
--       ⚠️ ec9_registrations.session_id 从此只作兼容回退（新提交写所选第一个，
--          全选时写 0），**真正的口径以关联表 + session_all 为准**，
--          任何展示/统计/导出都不要只读 session_id。

CREATE TABLE IF NOT EXISTS ec9_registration_sessions (
  id SERIAL PRIMARY KEY,
  registration_id INT NOT NULL,
  session_id INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE ec9_registration_sessions IS '报名选择的论坛（多选，一人可多行）';
COMMENT ON COLUMN ec9_registration_sessions.registration_id IS 'ec9_registrations.id';
COMMENT ON COLUMN ec9_registration_sessions.session_id IS 'ec9_sessions.id';

-- 一人对同一论坛只能有一行；重复跑迁移靠它去重
CREATE UNIQUE INDEX IF NOT EXISTS ux_ec9_reg_sess
  ON ec9_registration_sessions (registration_id, session_id);
-- 按论坛统计人数用
CREATE INDEX IF NOT EXISTS idx_ec9_reg_sess_session
  ON ec9_registration_sessions (session_id);

-- ---------------------------------------------------------------------------
-- 历史数据回填：把现有的单选结果展开进关联表
-- 只吃「关联表里还没有记录」的报名，重复执行不会翻倍
-- ---------------------------------------------------------------------------

-- 1) 选过「全部论坛」的人：展开成该活动下所有启用中的场次
INSERT INTO ec9_registration_sessions (registration_id, session_id)
SELECT r.id, s.id
  FROM ec9_registrations r
  JOIN ec9_sessions s
    ON s.event_id = r.event_id
   AND COALESCE(s.status, 1) = 1
 WHERE COALESCE(r.session_all, 0) = 1
   AND NOT EXISTS (SELECT 1 FROM ec9_registration_sessions x WHERE x.registration_id = r.id)
ON CONFLICT (registration_id, session_id) DO NOTHING;

-- 2) 选了具体论坛的人：原样搬一行
--    注意 session_id 指向的场次若已被删（如旧的下午分论坛），这里不插，
--    保持「未选」待业务线下确认，不替用户猜
INSERT INTO ec9_registration_sessions (registration_id, session_id)
SELECT r.id, r.session_id
  FROM ec9_registrations r
 WHERE COALESCE(r.session_all, 0) = 0
   AND COALESCE(r.session_id, 0) > 0
   AND EXISTS (SELECT 1 FROM ec9_sessions s WHERE s.id = r.session_id)
   AND NOT EXISTS (SELECT 1 FROM ec9_registration_sessions x WHERE x.registration_id = r.id)
ON CONFLICT (registration_id, session_id) DO NOTHING;

-- 校验：
--   SELECT r.id, r.session_all,
--          COALESCE(array_agg(rs.session_id ORDER BY rs.session_id) FILTER (WHERE rs.session_id IS NOT NULL), '{}') AS sids
--     FROM ec9_registrations r
--     LEFT JOIN ec9_registration_sessions rs ON rs.registration_id = r.id
--    WHERE r.event_id = 1
--    GROUP BY r.id, r.session_all ORDER BY r.id;
