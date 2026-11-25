/* 存量补登记短信统一发送（2026-11-26 09:00 CST，crontab 一次性）
 * 只发 status='pending'；发前二次查 ec9_sms_logs 防重复；1 条/秒限速；
 * 断点续发：可重复执行，只处理未发成功的行。发完自动摘除自己的 crontab 行（保留其它行）。
 *
 * 用法：cd /opt/ec9/backend && node scripts/send_backfill_sms_20261126.js
 *      紧急叫停：touch <EC9_BAK>/STOP_SMS
 * 本地回归：EC9_BACKEND / EC9_BAK 可覆盖路径；非 Linux 不碰 crontab。
 */
const BACKEND = process.env.EC9_BACKEND || '/opt/ec9/backend';
process.chdir(BACKEND);
const fs = require('fs');
const cp = require('child_process');
const { sequelize } = require(BACKEND + '/models');
const { SmsService, MESSAGE_TYPES } = require(BACKEND + '/services/SmsService');

const BACKUP = process.env.EC9_BAK || '/opt/ec9/_bak/manualfix_20261125';
const STOP = BACKUP + '/STOP_SMS';
const MARK = 'ec9_backfill_sms_20261126';
const STUB = process.env.EC9_SMS_STUB === '1';
const FAST = process.env.EC9_FAST === '1';
const q = async (s, r) => await sequelize.query(s, Object.assign({ type: sequelize.QueryTypes.SELECT }, r ? { replacements: r } : {}));
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 本地回归：打桩短信通道，绝不真发；生产不设置 EC9_SMS_STUB，行为不变
if (STUB) SmsService.sendByBusinessType = async () => ({ success: true, status: 1, stub: true });

(async () => {
  fs.mkdirSync(BACKUP, { recursive: true });
  if (fs.existsSync(STOP)) {
    console.log('STOPPED_BY_FLAG 存在 STOP_SMS，本轮不发送任何短信');
    await sequelize.close(); return;
  }
  const pending = await q("SELECT id,invitation_id,guest_id,registration_id,phone,name FROM ec9_backfill_sms_queue WHERE status='pending' ORDER BY id");
  console.log('PENDING', pending.length);
  const receipt = { at: new Date().toISOString(), total: pending.length, sent: 0, failed: 0, skippedDuplicate: 0, details: [] };

  for (let i = 0; i < pending.length; i++) {
    const row = pending[i];
    if (fs.existsSync(STOP)) { console.log('STOPPED_MIDWAY'); break; }
    // 二次防重：已经成功发过 REG_SUCCESS 就不再发
    const dup = await q("SELECT id FROM ec9_sms_logs WHERE phone=:p AND message_type='REG_SUCCESS' AND status='1' LIMIT 1", { p: row.phone });
    if (dup.length) {
      await q("UPDATE ec9_backfill_sms_queue SET status='skipped_duplicate', updated_at=CURRENT_TIMESTAMP WHERE id=:id", { id: row.id });
      receipt.skippedDuplicate++;
      continue;
    }
    try {
      const r = await SmsService.sendByBusinessType(MESSAGE_TYPES.REG_SUCCESS, {
        guestId: row.guest_id, eventId: 1, lang: 'zh-CN'
      });
      if (r && r.success) {
        await q("UPDATE ec9_backfill_sms_queue SET status='sent', sent_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=:id", { id: row.id });
        receipt.sent++;
      } else {
        const err = String((r && (r.error || r.errorMessage)) || 'unknown').slice(0, 900);
        await q("UPDATE ec9_backfill_sms_queue SET status='failed', error=:e, updated_at=CURRENT_TIMESTAMP WHERE id=:id", { id: row.id, e: err });
        receipt.failed++;
        receipt.details.push({ phone: row.phone, error: err });
      }
    } catch (e) {
      await q("UPDATE ec9_backfill_sms_queue SET status='failed', error=:e, updated_at=CURRENT_TIMESTAMP WHERE id=:id", { id: row.id, e: String(e.message).slice(0, 900) });
      receipt.failed++;
      receipt.details.push({ phone: row.phone, error: e.message });
    }
    if (i < pending.length - 1) await sleep(FAST ? 5 : 1000);
  }

  const summary = await q('SELECT status, COUNT(*)::int AS n FROM ec9_backfill_sms_queue GROUP BY status ORDER BY status');
  receipt.queueSummary = summary;
  fs.writeFileSync(BACKUP + '/sms_receipt.json', JSON.stringify(receipt, null, 2));
  console.log('SMS_RECEIPT', JSON.stringify(receipt));

  // 只在全部处理完（无 pending 残留）时摘除自己的 crontab 行，保留 acme.sh 等其它行
  const left = (summary.find(x => x.status === 'pending') || { n: 0 }).n;
  if (left === 0 && !fs.existsSync(STOP) && process.platform === 'linux' && !process.env.EC9_SKIP_CRONTAB) {
    try {
      const cur = cp.execSync('crontab -l 2>/dev/null || true').toString();
      const NL = String.fromCharCode(10);
      const kept = cur.split(NL).filter(l => l.indexOf(MARK) < 0 && l.trim()).join(NL) + NL;
      cp.execSync('crontab -', { input: kept });
      console.log('CRONTAB_CLEANED kept_lines=' + kept.trim().split(NL).filter(Boolean).length);
    } catch (e) { console.error('CRONTAB_CLEAN_FAILED', e.message); }
  }
  await sequelize.close();
})().catch(e => { console.error('SEND_FAILED', e.stack || e.message); process.exit(1); });
