/**
 * 邀约口径调整（2026-10-23）：「在邀约名单内 = 免票」
 *   真邀约（非报名自动生成）            → need_pay = 0（免票，报名即成功）
 *   报名时自动生成的待审批记录（非邀约人）→ need_pay = 1（需付款购票）
 * 幂等：可反复执行。
 */
const { sequelize } = require('../config/database');

(async () => {
  try {
    const [ex] = await sequelize.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'ec9_invitations' AND column_name = 'need_pay'"
    );
    if (!ex.length) {
      await sequelize.query('ALTER TABLE ec9_invitations ADD COLUMN need_pay SMALLINT DEFAULT 0');
      console.log('OK   ec9_invitations.need_pay 已添加（默认 0 免票）');
    } else {
      console.log('SKIP ec9_invitations.need_pay 已存在');
    }

    // 真邀约 → 免票
    const [a] = await sequelize.query(
      "UPDATE ec9_invitations SET need_pay = 0 " +
      "WHERE COALESCE(extra_fields->>'auto_created', 'false') <> 'true'"
    );
    console.log(`真邀约 → 免票(0)：${(a && a.rowCount) || 0} 行`);

    // 报名自动生成的（非邀约人）→ 需付款
    const [b] = await sequelize.query(
      "UPDATE ec9_invitations SET need_pay = 1 " +
      "WHERE COALESCE(extra_fields->>'auto_created', 'false') = 'true'"
    );
    console.log(`自动生成记录 → 需付款(1)：${(b && b.rowCount) || 0} 行`);

    const [rows] = await sequelize.query(
      "SELECT need_pay, COUNT(*)::int AS n FROM ec9_invitations GROUP BY need_pay ORDER BY need_pay"
    );
    console.log('当前分布（need_pay, 行数）：', rows);
    console.log('迁移完成');
    await sequelize.close();
  } catch (e) {
    console.error('FAIL', e.message);
    process.exit(1);
  }
})();
