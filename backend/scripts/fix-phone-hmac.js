/**
 * 一致性修复脚本：把 ec9_guests.phone_hmac 全量重算为 HMAC-SHA256。
 *
 * 为什么需要：
 *   EC8 的 phoneEncrypt.js 用的是「无盐 sha256」，EC9 换成了
 *   「HMAC-SHA256 + PHONE_HMAC_KEY」。历史上若有代码用错实现写库，
 *   phone_hmac 里存的就是裸 sha256 值，届时手机号校验 / 签到 / 邀约验证
 *   会全线「查不到人」。本脚本幂等，可反复跑。
 *
 * 用法：node scripts/fix-phone-hmac.js [--dry]
 */
const { Client } = require('pg');
const crypto = require('crypto');
const config = require('../config');

const DRY = process.argv.includes('--dry');

function main() {
  const c = new Client(config.database);
  const keyBuf = Buffer.from(config.encryption.getKey(), 'utf8');

  const hmac = (phone) =>
    crypto.createHmac('sha256', config.phoneHmac.key).update(String(phone), 'utf8').digest('hex');

  function decrypt(enc) {
    const parts = String(enc).split(':');
    if (parts.length !== 2) return null;
    try {
      const d = crypto.createDecipheriv('aes-256-cbc', keyBuf, Buffer.from(parts[0], 'hex'));
      let out = d.update(parts[1], 'hex', 'utf8');
      out += d.final('utf8');
      return /^1[3-9]\d{9}$/.test(out) ? out : null;
    } catch (e) {
      return null;
    }
  }

  c.connect()
    .then(async () => {
      const { rows } = await c.query(
        'SELECT id, phone, phone_hmac FROM ec9_guests WHERE phone IS NOT NULL'
      );
      let fixed = 0, ok = 0, skipped = 0;
      const skippedIds = [];

      for (const g of rows) {
        const plain = decrypt(g.phone);
        if (!plain) { skipped++; skippedIds.push(g.id); continue; }
        const want = hmac(plain);
        if (g.phone_hmac === want) { ok++; continue; }
        if (!DRY) {
          await c.query('UPDATE ec9_guests SET phone_hmac = $1 WHERE id = $2', [want, g.id]);
        }
        fixed++;
      }

      console.log(`\n嘉宾总数：${rows.length}`);
      console.log(`HMAC 已正确：${ok}`);
      console.log(`${DRY ? '[试运行] 将修正' : '已修正'}：${fixed}`);
      console.log(`无法解密跳过：${skipped}${skippedIds.length ? '（ID: ' + skippedIds.join(',') + '）' : ''}`);

      // 验证抽样：能否用 HMAC 反查回嘉宾
      if (!DRY && rows.length) {
        const sample = rows[0];
        const plain = decrypt(sample.phone);
        if (plain) {
          const { rowCount } = await c.query(
            'SELECT id FROM ec9_guests WHERE phone_hmac = $1 LIMIT 1', [hmac(plain)]
          );
          console.log(`\n反查校验：${rowCount > 0 ? '通过（HMAC 可正常检索）' : '失败'}`);
        }
      }
      await c.end();
    })
    .catch((e) => {
      console.error('执行失败:', e.message);
      process.exit(1);
    });
}

main();
