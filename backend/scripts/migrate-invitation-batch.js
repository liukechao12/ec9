/**
 * 迁移：ec9_invitations 增加 batch_no（批次号）
 *
 * 用途：一次添加多人 / 一次提交多人 = 同一批，后台可以整批审核（一起通过或一起驳回）。
 *
 * - 幂等：列已存在则跳过加列；每次执行都会重新回填「本该有批次号却为空」的行。
 * - 回填规则：
 *     1) 报名自动生成的待审批邀约（extra_fields.auto_created = true）→ 取该嘉宾报名记录的 group_no
 *        一次团单提交多人 ⇒ 这些人的 group_no 相同 ⇒ 天然就是一批
 *     2) 其余历史行保持 NULL（不属于任何批次），不影响现有功能
 *
 * 运行：node scripts/migrate-invitation-batch.js
 */
const { sequelize } = require('../config/database');

(async () => {
  try {
    await sequelize.authenticate();

    const [cols] = await sequelize.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'ec9_invitations' AND column_name = 'batch_no'
    `);
    if (!cols.length) {
      await sequelize.query(`ALTER TABLE ec9_invitations ADD COLUMN batch_no VARCHAR(64)`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_ec9_invitations_batch_no ON ec9_invitations(batch_no)`);
      console.log('✅ 已添加列 ec9_invitations.batch_no（并建索引）');
    } else {
      console.log('ℹ️  batch_no 列已存在，跳过加列');
    }

    // 回填：报名自动生成的待审批邀约 → 用其报名记录的 group_no 当批次号
    const [res] = await sequelize.query(`
      UPDATE ec9_invitations i
      SET batch_no = r.group_no
      FROM (
        SELECT invitation_id, MIN(group_no) AS group_no
        FROM ec9_registrations
        WHERE invitation_id IS NOT NULL AND group_no IS NOT NULL
        GROUP BY invitation_id
      ) r
      WHERE i.id = r.invitation_id
        AND (i.batch_no IS NULL OR i.batch_no = '')
        AND COALESCE(i.extra_fields->>'auto_created', '') = 'true'
    `);
    console.log(`✅ 回填批次号：${res.rowCount || 0} 行（来自团单报名自动生成）`);

    const [rows] = await sequelize.query(`
      SELECT batch_no, count(*) AS n,
             count(*) FILTER (WHERE registration_status = 1) AS pending,
             count(*) FILTER (WHERE registration_status = 2) AS approved,
             count(*) FILTER (WHERE registration_status = 3) AS rejected
      FROM ec9_invitations
      WHERE batch_no IS NOT NULL AND batch_no <> ''
      GROUP BY batch_no ORDER BY batch_no
    `);
    console.log('\n当前批次：');
    if (!rows.length) console.log('  （暂无批次数据）');
    rows.forEach(r => console.log(`  ${r.batch_no}  共${r.n}人  待审${r.pending} 已过${r.approved} 已拒${r.rejected}`));

    await sequelize.close();
    process.exit(0);
  } catch (e) {
    console.error('❌ 迁移失败:', e.message);
    try { await sequelize.close(); } catch (_) {}
    process.exit(1);
  }
})();
