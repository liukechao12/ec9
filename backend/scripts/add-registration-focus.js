/**
 * 给 ec9_registrations 增加 focus（关注方向）字段
 * H5 报名表单新增「关注方向」，与后台/导出对齐。
 * 幂等：列已存在则跳过。
 */
const { sequelize } = require('../config/database');

(async () => {
  try {
    await sequelize.authenticate();
    const [rows] = await sequelize.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'ec9_registrations' AND column_name = 'focus'
    `);
    if (rows && rows.length) {
      console.log('[迁移] focus 字段已存在，跳过');
    } else {
      await sequelize.query(`ALTER TABLE ec9_registrations ADD COLUMN focus VARCHAR(200)`);
      console.log('[迁移] ec9_registrations.focus 已添加');
    }
    process.exit(0);
  } catch (e) {
    console.error('[迁移] 失败:', e.message);
    process.exit(1);
  }
})();
