/* 回滚脚本：撤销 2026-11-25 存量补登记（默认 dry-run，加 --apply 才真删）
 * 只删本次批次新建的行（按 before.json 里的 MAX(id) 基线 + manual_backfill 留痕双重限定），
 * 恢复库存三个数字与标准票 stock_total，清空队列。绝不触碰任何已有业务数据。
 */
const BACKEND = process.env.EC9_BACKEND || '/opt/ec9/backend';
process.chdir(BACKEND);
const fs = require('fs');
const { sequelize } = require(BACKEND + '/models');
const BACKUP = process.env.EC9_BAK || '/opt/ec9/_bak/manualfix_20261125';
const APPLY = process.argv.includes('--apply');
const q = async (s, r) => await sequelize.query(s, Object.assign({ type: sequelize.QueryTypes.SELECT }, r ? { replacements: r } : {}));

(async () => {
  const before = JSON.parse(fs.readFileSync(BACKUP + '/before.json', 'utf8'));
  const b = before.counts;
  const ids = await q("SELECT id FROM ec9_registrations WHERE extra_fields->>'manual_backfill'='20261125' ORDER BY id");
  const plan = {
    registrations: ids.map(x => x.id),
    regMax: b.ec9_registrations && b.ec9_registrations.m,
    orderMax: b.ec9_orders && b.ec9_orders.m,
    codeMax: b.ec9_checkin_codes && b.ec9_checkin_codes.m,
    restoreTickets: before.tickets
  };
  console.log('ROLLBACK_PLAN', JSON.stringify({ ...plan, registrations: plan.registrations.length }));
  if (!APPLY) { console.log('DRY_RUN_ONLY (加 --apply 执行)'); await sequelize.close(); return; }
  if (ids.length) {
    const inList = ids.map(x => x.id).join(',');
    await q('DELETE FROM ec9_checkin_codes WHERE registration_id IN (' + inList + ')');
  }
  await q("DELETE FROM ec9_orders WHERE remark LIKE '%后台手动报名成功补登记 20261125%'");
  await q("DELETE FROM ec9_registrations WHERE extra_fields->>'manual_backfill'='20261125'");
  await q("DELETE FROM ec9_backfill_sms_queue WHERE batch='20261125'");
  for (const t of plan.restoreTickets) {
    await q('UPDATE ec9_ticket_types SET stock_total=:st, stock_locked=:sl, stock_sold=:ss WHERE id=:id',
      { id: t.id, st: t.stock_total, sl: t.stock_locked, ss: t.stock_sold });
  }
  console.log('ROLLBACK_APPLIED');
  await sequelize.close();
})().catch(e => { console.error('ROLLBACK_FAILED', e.stack || e.message); process.exit(1); });
