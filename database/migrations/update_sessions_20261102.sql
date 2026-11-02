-- 论坛内容更新（2026-11-02）
--
-- 旧版只有两个笼统的时段选项：「上午主论坛」「下午分论坛」。
-- 新版论坛议程明确为 1 个上午 + 3 个并行的下午论坛：
--   上午 · 主题演讲
--   下午 · 具身智能数据•模型•仿真闭环论坛
--   下午 · 智驾安全与全球准入论坛
--   下午 · Physical AI 产业创新与资本赋能论坛
--
-- 处理原则：
--   1. 旧的两条（id=1/2）只停用、不改名、不删除 —— 已报名记录仍引用它们，
--      保留原名才能让历史名单读得懂「他当初选的是什么」。
--   2. 新建 4 条，按 name 判重，可重复执行。
--   3. ⚠️ 已报名的 13 条记录不会自动迁移，需业务侧逐个确认后手工改 session_id。
--      （上午的 6 人可对齐到新「上午 · 主题演讲」；选旧「下午分论坛」的 1 人
--        必须线下问本人要去哪个下午论坛；6 个「全部论坛」的不受影响。）

BEGIN;

-- 1) 停用旧论坛（保留记录，仅置 status=0，H5 下拉不再出现）
UPDATE ec9_sessions
   SET status = 0, updated_at = NOW()
 WHERE event_id = 1
   AND name IN ('上午主论坛', '下午分论坛')
   AND status = 1;

-- 2) 新建 4 条新论坛（按 name 判重，幂等）
INSERT INTO ec9_sessions
  (event_id, name, i18n, start_time, end_time, location, stock_total, stock_locked, stock_sold, status, sort, created_at, updated_at)
SELECT v.event_id, v.name, v.i18n::jsonb, v.start_time::timestamptz, v.end_time::timestamptz,
       v.location, v.stock_total, 0, 0, 1, v.sort, NOW(), NOW()
FROM (VALUES
  (1,
   '上午 · 主题演讲',
   '{"name":{"zh-TW":"上午 · 主題演講","en":"Morning · Keynote Sessions"},"location":{"zh-TW":"一層宴會廳 A","en":"Banquet Hall A (1F)"}}',
   '2026-11-06 09:30:00+08', '2026-11-06 12:00:00+08',
   '一层宴会厅 A', 300, 10),
  (1,
   '下午 · 具身智能数据•模型•仿真闭环论坛',
   '{"name":{"zh-TW":"下午 · 具身智能數據•模型•仿真閉環論壇","en":"Afternoon · Embodied AI: Data, Model & Simulation Closed-Loop Forum"}}',
   '2026-11-06 14:00:00+08', '2026-11-06 17:30:00+08',
   NULL, 300, 20),
  (1,
   '下午 · 智驾安全与全球准入论坛',
   '{"name":{"zh-TW":"下午 · 智駕安全與全球准入論壇","en":"Afternoon · Intelligent Driving Safety & Global Access Forum"}}',
   '2026-11-06 14:00:00+08', '2026-11-06 17:30:00+08',
   NULL, 300, 30),
  (1,
   '下午 · Physical AI 产业创新与资本赋能论坛',
   '{"name":{"zh-TW":"下午 · Physical AI 產業創新與資本賦能論壇","en":"Afternoon · Physical AI: Industrial Innovation & Capital Empowerment Forum"}}',
   '2026-11-06 14:00:00+08', '2026-11-06 17:30:00+08',
   NULL, 300, 40)
) AS v(event_id, name, i18n, start_time, end_time, location, stock_total, sort)
WHERE NOT EXISTS (
  SELECT 1 FROM ec9_sessions s WHERE s.event_id = v.event_id AND s.name = v.name
);

-- 3) 已报名对齐：旧「上午主论坛」(id=1) → 新「上午 · 主题演讲」
--    上午只有主题演讲一场，映射唯一，无需问本人。
--    「全部论坛」(session_all=1) 不受影响；选旧「下午分论坛」的 1 人
--    因下午已拆成 3 个并行论坛，映射不唯一，保持原值待线下确认。
UPDATE ec9_registrations r
   SET session_id = (SELECT s.id FROM ec9_sessions s
                      WHERE s.event_id = 1 AND s.name = '上午 · 主题演讲' AND s.status = 1
                      ORDER BY s.id LIMIT 1),
       updated_at = NOW()
 WHERE r.event_id = 1
   AND r.session_id = 1
   AND COALESCE(r.session_all, 0) = 0;

COMMIT;

-- 校验：
--   SELECT id, name, status, sort, start_time, location FROM ec9_sessions ORDER BY sort, id;
-- 预期：id=1/2 为 status=0；新增 4 条 status=1（上午 1 条 + 下午 3 条）
