/**
 * 邀约「是否需要付款」迁移
 *  ec9_invitations 加 need_pay SMALLINT DEFAULT 1（1 需付款 / 0 免票），历史行回填 1
 * 幂等：查 information_schema，列已存在则只做回填。
 */
const { sequelize } = require('../config/database');

(async () => {
  try {
    const [ex] = await sequelize.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'ec9_invitations' AND column_name = 'need_pay'"
    );
    if (!ex.length) {
      await sequelize.query('ALTER TABLE ec9_invitations ADD COLUMN need_pay SMALLINT DEFAULT 1');
      console.log('OK   ec9_invitations.need_pay 已添加');
    } else {
      console.log('SKIP ec9_invitations.need_pay 已存在');
    }
    const [r] = await sequelize.query('UPDATE ec9_invitations SET need_pay = 1 WHERE need_pay IS NULL');
    console.log(`回填 need_pay=1：${(r && r.rowCount) || 0} 行`);
    const [rows] = await sequelize.query(
      'SELECT need_pay, COUNT(*)::int AS n FROM ec9_invitations GROUP BY need_pay ORDER BY need_pay'
    );
    console.log('当前分布：', rows);
    console.log('迁移完成');
    await sequelize.close();
  } catch (e) {
    console.error('FAIL', e.message);
    process.exit(1);
  }
})();
