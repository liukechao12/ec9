/**
 * 后台管理「物理删除」统一服务（2026-11-04）
 *
 * 口径（昊哥确认）：
 *   - 物理删除，删前把完整行写 JSON 到 /opt/ec9/_bak/deletes/，可人工恢复
 *   - 按业务链路级联，不留孤儿数据
 *   - 仅 admin（由路由层 authenticate + authorize('admin') 保证）
 *   - 日志类表（operation_logs / sms_logs / verification_*）与 guest / invitation 一律不动
 *
 * 三个入口：
 *   deleteOrderCascade(orderId)     订单 + 该订单的支付流水
 *   deletePayment(paymentId)        单条支付流水
 *   deleteGroupCascade(groupNo)     整单报名全链路
 */
const fs = require('fs');
const path = require('path');
const { sequelize } = require('../models');
const { QueryTypes } = require('sequelize');

// /opt/ec9/backend/services -> /opt/ec9/_bak/deletes
const BACKUP_ROOT = path.resolve(__dirname, '../../_bak/deletes');
// 学籍报告私有目录（与 routes/student-reports.js 保持一致）
const PRIVATE_ROOT = path.resolve(__dirname, '../private/student_reports');

function writeBackup(kind, payload) {
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const safe = String(kind).replace(/[^a-zA-Z0-9_-]/g, '_');
  const file = path.join(BACKUP_ROOT, `${safe}_${ts}_${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  return file;
}

const rows = (sql, bind, tx) => sequelize.query(sql, {
  type: QueryTypes.SELECT, bind: bind || [], transaction: tx
});

async function del(table, idList, tx) {
  if (!idList || !idList.length) return 0;
  const [, meta] = await sequelize.query(
    `DELETE FROM ${table} WHERE id = ANY($1::int[])`,
    { bind: [idList], transaction: tx }
  );
  return meta && meta.rowCount != null ? meta.rowCount : idList.length;
}

const idsOf = (list) => [...new Set((list || []).map(r => Number(r.id)).filter(Number.isFinite))];

/**
 * 在单事务内按依赖顺序删除，并统一提交/回滚
 */
async function runInTx(steps) {
  const tx = await sequelize.transaction();
  try {
    const deleted = {};
    for (const s of steps) deleted[s.table] = await del(s.table, s.ids, tx);
    await tx.commit();
    return deleted;
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* 订单管理：删订单 + 该订单的支付流水                                   */
/* ------------------------------------------------------------------ */
async function deleteOrderCascade(orderId, operator) {
  const oid = Number(orderId);
  if (!Number.isFinite(oid)) throw new Error('订单 id 无效');

  const orders = await rows(`SELECT * FROM ec9_orders WHERE id = $1`, [oid]);
  if (!orders.length) return { notFound: true };
  const order = orders[0];

  const payments = await rows(
    `SELECT * FROM ec9_payments WHERE order_id = $1 OR out_trade_no = $2 ORDER BY id`,
    [oid, order.order_no]
  );

  const backupFile = writeBackup(`order_${oid}`, {
    kind: 'order', at: new Date().toISOString(), operator,
    order, payments
  });

  const deleted = await runInTx([
    { table: 'ec9_payments', ids: idsOf(payments) },
    { table: 'ec9_orders', ids: [oid] }
  ]);

  return { deleted, backup_file: backupFile, order_no: order.order_no };
}

/* ------------------------------------------------------------------ */
/* 支付流水：只删本条                                                   */
/* ------------------------------------------------------------------ */
async function deletePayment(paymentId, operator) {
  const pid = Number(paymentId);
  if (!Number.isFinite(pid)) throw new Error('流水 id 无效');

  const pays = await rows(`SELECT * FROM ec9_payments WHERE id = $1`, [pid]);
  if (!pays.length) return { notFound: true };

  const backupFile = writeBackup(`payment_${pid}`, {
    kind: 'payment', at: new Date().toISOString(), operator, payment: pays[0]
  });

  const deleted = await runInTx([{ table: 'ec9_payments', ids: [pid] }]);
  return { deleted, backup_file: backupFile, out_trade_no: pays[0].out_trade_no };
}

/* ------------------------------------------------------------------ */
/* 报名审核：按 group_no 删整单全链路                                   */
/* ------------------------------------------------------------------ */
async function deleteGroupCascade(groupNo, operator) {
  const g = String(groupNo || '').trim();
  if (!g) throw new Error('缺少 group_no');

  const regs = await rows(
    `SELECT * FROM ec9_registrations WHERE group_no = $1 ORDER BY id`, [g]
  );
  if (!regs.length) return { notFound: true };
  const regIds = idsOf(regs);

  const orders = await rows(
    `SELECT * FROM ec9_orders WHERE group_no = $1 OR registration_id = ANY($2::int[]) ORDER BY id`,
    [g, regIds]
  );
  const orderIds = idsOf(orders);
  const orderNos = [...new Set(orders.map(o => o.order_no).filter(Boolean))];

  const payments = await rows(
    `SELECT * FROM ec9_payments WHERE order_id = ANY($1::int[]) OR out_trade_no = ANY($2::text[]) ORDER BY id`,
    [orderIds, orderNos.length ? orderNos : ['']]
  );
  const codes = await rows(
    `SELECT * FROM ec9_checkin_codes WHERE registration_id = ANY($1::int[]) ORDER BY id`, [regIds]
  );
  const codeIds = idsOf(codes);
  const checkins = await rows(
    `SELECT * FROM ec9_checkins WHERE registration_id = ANY($1::int[]) OR checkin_code_id = ANY($2::int[]) ORDER BY id`,
    [regIds, codeIds]
  );
  const sessions = await rows(
    `SELECT * FROM ec9_registration_sessions WHERE registration_id = ANY($1::int[]) ORDER BY id`, [regIds]
  );
  let reports = [];
  try {
    reports = await rows(
      `SELECT * FROM ec9_student_reports WHERE group_no = $1 OR registration_id = ANY($2::int[]) ORDER BY id`,
      [g, regIds]
    );
  } catch (e) {
    // 老库可能还没建这张表，按 0 行处理
    reports = [];
  }

  const backupFile = writeBackup(`group_${g}`, {
    kind: 'group', at: new Date().toISOString(), operator, group_no: g,
    registrations: regs, orders, payments,
    checkin_codes: codes, checkins, registration_sessions: sessions,
    student_reports: reports
  });

  const deleted = await runInTx([
    { table: 'ec9_payments', ids: idsOf(payments) },
    { table: 'ec9_orders', ids: orderIds },
    { table: 'ec9_checkins', ids: idsOf(checkins) },
    { table: 'ec9_checkin_codes', ids: codeIds },
    { table: 'ec9_registration_sessions', ids: idsOf(sessions) },
    { table: 'ec9_student_reports', ids: idsOf(reports) },
    { table: 'ec9_registrations', ids: regIds }
  ]);

  // 事务提交后再删学籍报告物理文件；路径必须落在私有目录内，防目录穿越
  const removed_files = [];
  for (const r of reports) {
    const rel = String(r.file_path || '');
    if (!rel) continue;
    const abs = path.resolve(__dirname, '..', rel);
    if (!abs.startsWith(PRIVATE_ROOT + path.sep)) continue;
    try { fs.unlinkSync(abs); removed_files.push(rel); } catch (e) { /* 文件已不存在则忽略 */ }
  }

  return {
    deleted, backup_file: backupFile, group_no: g,
    member_count: regs.length, removed_files
  };
}

module.exports = {
  BACKUP_ROOT,
  deleteOrderCascade,
  deletePayment,
  deleteGroupCascade
};
