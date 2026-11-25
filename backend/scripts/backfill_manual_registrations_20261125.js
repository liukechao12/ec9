/* 存量补登记：一次性脚本（2026-11-25）
 * 把「管理员手动设置报名成功但没有任何报名记录」的邀约补成完整报名。
 * 静默：绝不发送任何短信，只把待发人写入 ec9_backfill_sms_queue。
 *
 * 用法：cd /opt/ec9/backend && node scripts/backfill_manual_registrations_20261125.js
 *      （可重复执行，幂等；--dry-run 只出快照不写库）
 * 本地回归：EC9_BACKEND / EC9_BAK 可覆盖路径。
 */
const BACKEND = process.env.EC9_BACKEND || '/opt/ec9/backend';
process.chdir(BACKEND);
const fs = require('fs');
const { sequelize } = require(BACKEND + '/models');
const svc = require(BACKEND + '/services/groupOrderService');
const { Invitation } = require(BACKEND + '/models');

const BACKUP = process.env.EC9_BAK || '/opt/ec9/_bak/manualfix_20261125';
const BATCH = '20261125';
const DRY = process.argv.includes('--dry-run');
const q = async (s, r) => await sequelize.query(s, Object.assign({ type: sequelize.QueryTypes.SELECT }, r ? { replacements: r } : {}));

const ORPHAN = `i.registration_status=2 AND i.is_valid=1
  AND NOT EXISTS (SELECT 1 FROM ec9_registrations r WHERE r.guest_id=i.guest_id AND r.event_id=i.event_id)
  AND NOT EXISTS (SELECT 1 FROM ec9_registrations r2 WHERE r2.invitation_id=i.id)`;

(async () => {
  fs.mkdirSync(BACKUP, { recursive: true });
  const before = {
    at: new Date().toISOString(),
    tickets: await q('SELECT id,name,stock_total,stock_locked,stock_sold FROM ec9_ticket_types ORDER BY id'),
    counts: {},
    orphans: await q(`SELECT i.id, i.guest_id, i.ticket_type_id, i.need_pay, g.name
       FROM ec9_invitations i JOIN ec9_guests g ON g.id=i.guest_id WHERE ${ORPHAN} ORDER BY i.id`)
  };
  for (const t of ['ec9_registrations', 'ec9_orders', 'ec9_checkin_codes', 'ec9_sms_logs', 'ec9_backfill_sms_queue', 'ec9_invitations', 'ec9_guests']) {
    try { before.counts[t] = (await q('SELECT COUNT(*)::int AS n, COALESCE(MAX(id),0)::int AS m FROM ' + t))[0]; }
    catch (e) { before.counts[t] = { error: e.message }; }
  }
  console.log('BEFORE', JSON.stringify({ tickets: before.tickets, counts: before.counts, orphanCount: before.orphans.length }));
  if (DRY) { fs.writeFileSync(BACKUP + '/dryrun.json', JSON.stringify(before, null, 2)); console.log('DRY_RUN_OK'); await sequelize.close(); return; }

  fs.writeFileSync(BACKUP + '/before.json', JSON.stringify(before, null, 2));

  // 1) 扩容标准票 100 -> 150（幂等：仅当仍为 100 时改）
  const std = await q("SELECT id,stock_total FROM ec9_ticket_types WHERE name LIKE '%标准%' AND on_shelf=1 ORDER BY id LIMIT 1");
  let expanded = null;
  if (std.length && Number(std[0].stock_total) === 100) {
    await q('UPDATE ec9_ticket_types SET stock_total=150, updated_at=CURRENT_TIMESTAMP WHERE id=:id', { id: std[0].id });
    expanded = { id: std[0].id, from: 100, to: 150 };
  }
  console.log('EXPAND', JSON.stringify(expanded));

  // 2) 逐条补登记（执行时重新取快照，管理员可能还在点按钮）
  // EC9_ONLY_IDS：本地回归限定范围（逗号分隔的邀约 id），生产不设置＝全量
  const onlyIds = (process.env.EC9_ONLY_IDS || '').split(',').map(x => Number(x)).filter(Boolean);
  const onlySql = onlyIds.length ? ' AND i.id IN (' + onlyIds.join(',') + ')' : '';
  const list = await q(`SELECT i.id FROM ec9_invitations i JOIN ec9_guests g ON g.id=i.guest_id WHERE ${ORPHAN}${onlySql} ORDER BY i.id`);
  const results = [];
  for (const row of list) {
    const inv = await Invitation.findByPk(row.id);
    if (!inv) { results.push({ id: row.id, ok: false, error: '邀约消失' }); continue; }
    try {
      const r = await svc.backfillManualRegistration(inv, {
        sendSms: false, enqueue: true, occupyStock: true,
        defaultTicketTypeId: Number(process.env.EC9_DEFAULT_TICKET_ID || 2), batch: BATCH, operator: 'backfill_script'
      });
      results.push(r);
    } catch (e) {
      results.push({ invitation_id: row.id, ok: false, error: e.message });
      console.error('BACKFILL_ITEM_FAILED', row.id, e.message);
    }
  }

  const after = {
    at: new Date().toISOString(),
    tickets: await q('SELECT id,name,stock_total,stock_locked,stock_sold FROM ec9_ticket_types ORDER BY id'),
    counts: {},
    queue: await q('SELECT status, COUNT(*)::int AS n FROM ec9_backfill_sms_queue GROUP BY status ORDER BY status'),
    results
  };
  for (const t of ['ec9_registrations', 'ec9_orders', 'ec9_checkin_codes', 'ec9_sms_logs', 'ec9_backfill_sms_queue', 'ec9_invitations', 'ec9_guests']) {
    try { after.counts[t] = (await q('SELECT COUNT(*)::int AS n, COALESCE(MAX(id),0)::int AS m FROM ' + t))[0]; }
    catch (e) { after.counts[t] = { error: e.message }; }
  }
  fs.writeFileSync(BACKUP + '/after.json', JSON.stringify(after, null, 2));

  // 3) 校验
  const created = results.filter(r => r && r.ok && !r.skipped);
  const failed = results.filter(r => !r || !r.ok);
  const skipped = results.filter(r => r && r.ok && r.skipped);
  const smsLogsDelta = (after.counts.ec9_sms_logs.n || 0) - (before.counts.ec9_sms_logs.n || 0);
  const checks = {
    totalOrphans: list.length,
    created: created.length,
    skipped: skipped.length,
    failed: failed.length,
    smsLogsDelta,
    noSmsSent: smsLogsDelta === 0,
    allPaidReg: created.every(r => !!r.registration_id),
    allCheckinCode: created.every(r => !!r.checkin_code),
    queue: after.queue,
    tickets: after.tickets
  };
  console.log('AFTER', JSON.stringify(checks));
  console.log('BACKFILL_OK', checks.failed === 0 && checks.noSmsSent && checks.allPaidReg && checks.allCheckinCode);
  await sequelize.close();
})().catch(e => { console.error('BACKFILL_FAILED', e.stack || e.message); process.exit(1); });
