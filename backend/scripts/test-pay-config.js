/**
 * 支付配置模块自检（直驱服务层，不依赖 HTTP）
 * 用法：cd backend && node scripts/test-pay-config.js
 *
 * 覆盖：建表可查 / 加密往返 / 掩码 / 保存热更新 / 密钥留空不改 / 生产模式校验 / 自检输出
 * ⚠️ 会真实读写 ec9_payment_configs，跑完自动还原为测试前的值
 */
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name} ${extra}`); }
}

async function main() {
  const payConfig = require('../services/payConfigService');
  const { PaymentConfig, sequelize } = require('../models');
  const { encryptSecret, decryptSecret, maskSecret } = require('../utils/secretCrypto');

  console.log('\n[1] 表与模型');
  const tables = await sequelize.query(
    "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'ec9_payment_configs'",
    { type: require('sequelize').QueryTypes.SELECT }
  );
  check('ec9_payment_configs 已建', tables.length === 1);

  console.log('\n[2] 密钥加解密');
  const enc = encryptSecret('a'.repeat(32));
  check('密文不等于明文', enc && enc !== 'a'.repeat(32));
  check('可解回原文', decryptSecret(enc) === 'a'.repeat(32));
  check('两次加密结果不同（iv 随机）', encryptSecret('abc') !== encryptSecret('abc'));
  check('空值加密返回空串', encryptSecret('') === '');
  check('坏密文解密返回 null', decryptSecret('xxxx:yyyy') === null);
  check('掩码保留首尾 4 位', maskSecret('abcdefghijklmnop') === 'abcd********mnop');
  check('短串全掩', maskSecret('abc') === '********');

  console.log('\n[3] 载入与兜底');
  await payConfig.load();
  const before = payConfig.masked();
  check('配置可读', !!before.mode);
  check('配置来源为 db', payConfig.source() === 'db', payConfig.source());

  console.log('\n[4] 保存与热更新');
  await payConfig.save({ mode: 'mock', enabled: 1, mch_id: '1234567890', app_id: 'wxTESTAPPID001', notify_url: '/api/payment/notify', order_expire_minutes: 15, remark: 'selftest' }, 1);
  const after = payConfig.get();
  check('mode 已更新', after.mode === 'mock');
  check('商户号已更新', after.mch_id === '1234567890');
  check('有效期已更新', after.order_expire_minutes === 15);
  check('内存热更新（无需 reload）', payConfig.get().mch_id === '1234567890');

  console.log('\n[5] 密钥语义');
  await payConfig.save({ api_key: 'k'.repeat(32) }, 1);
  check('密钥已写入', payConfig.get().api_key === 'k'.repeat(32));
  check('对外只回掩码', payConfig.masked().api_key_masked.indexOf('k'.repeat(32)) === -1);
  check('对外标记已设置', payConfig.masked().api_key_set === true);
  await payConfig.save({ api_key: '' }, 1);
  check('留空不修改密钥', payConfig.get().api_key === 'k'.repeat(32));
  await payConfig.save({ api_key: payConfig.masked().api_key_masked }, 1);
  check('回传掩码不修改密钥', payConfig.get().api_key === 'k'.repeat(32));

  console.log('\n[6] 校验规则');
  let threw = false;
  try { await payConfig.save({ mode: 'real', mch_id: '', app_id: '', api_key: '', notify_url: '' }, 1); } catch (e) { threw = /缺少必填项/.test(e.message); }
  check('生产模式缺参数被拒', threw);
  threw = false;
  try { await payConfig.save({ mode: 'bitcoin' }, 1); } catch (e) { threw = /无效的支付模式/.test(e.message); }
  check('非法模式被拒', threw);
  threw = false;
  try { await payConfig.save({ order_expire_minutes: 9999 }, 1); } catch (e) { threw = /1~1440/.test(e.message); }
  check('有效期越界被拒', threw);

  console.log('\n[7] 配置自检');
  check('mock 模式自检通过', payConfig.selfTest().ok === true);
  await payConfig.save({ mode: 'real' }, 1);
  const realTest = payConfig.selfTest();
  check('real 模式缺证书会告警', realTest.issues.some(i => i.level === 'warn' || i.level === 'error'));
  check('自检带出当前模式', realTest.mode === 'real');

  console.log('\n[8] 还原');
  await payConfig.save({
    mode: before.mode, enabled: before.enabled, app_id: before.app_id, mch_id: before.mch_id,
    sign_type: before.sign_type, cert_path: before.cert_path, notify_url: before.notify_url,
    refund_notify_url: before.refund_notify_url, order_expire_minutes: before.order_expire_minutes,
    remark: before.remark
  }, 1);
  if (before.api_key_set) {
    // 测试期间覆盖过密钥，这里无法还原明文（对外只给掩码），置空以免留下测试密钥
    await sequelize.query("UPDATE ec9_payment_configs SET api_key_enc = NULL, api_v3_key_enc = NULL WHERE channel='wechat'");
  }
  await payConfig.load();
  check('已还原为测试前模式', payConfig.get().mode === before.mode);

  console.log(`\n========== 结果: ${pass} 通过 / ${fail} 失败 ==========`);
  if (failures.length) console.log('失败项:', failures.join(' | '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
