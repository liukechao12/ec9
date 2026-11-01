-- 增量迁移：报名「全部论坛」标记（幂等）
--
-- 背景：H5 报名页的「论坛」下拉里，「全部论坛」和「未选」提交给后端都是 session_id=0，
--       库里没法区分。论坛是必填项所以流程不受影响，但导出名单时选了「全部论坛」
--       的人会显示成「未选」，名单就废了一半。
-- 方案：单独加 session_all 承载这个选择，session_id=0 的语义从此变成「未选」。
--       session_all=1 → 全部论坛；session_all=0 且 session_id>0 → 具体论坛；
--       两者皆为 0 → 未选（理论上只有接口直接提交才会出现）。
ALTER TABLE ec9_registrations ADD COLUMN IF NOT EXISTS session_all INT2 NOT NULL DEFAULT 0;
COMMENT ON COLUMN ec9_registrations.session_all IS '1=报名时选了「全部论坛」；0=未选或已选具体论坛（看 session_id）';

-- 历史数据补标：老报名没有这个标记，线上论坛是必填项，session_id=0 的人
-- 当时其实就是选的「全部论坛」，统一刷成 1（昊哥 2026-11-01 拍板）。
-- 用 created_at 卡住时点，保证这条 UPDATE 重复执行也只吃老数据，不会误刷新报名。
UPDATE ec9_registrations
   SET session_all = 1
 WHERE COALESCE(session_id, 0) = 0
   AND COALESCE(session_all, 0) = 0
   -- 只补 H5 多人代报产生的记录（group_no 非空）：老接口（业绩说明会等）
   -- 压根没有论坛这一步，它们保持 0 = 未选，别被误标成「全部论坛」
   AND group_no IS NOT NULL
   AND group_no <> ''
   AND created_at < '2026-11-01 20:00:00'::timestamp;
