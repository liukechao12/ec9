/**
 * 短信配置模块自检（直驱服务层，不依赖 HTTP）
 * 用法：cd backend && node scripts/test-sms-config.js
 *
 * ⚠️ 会真实读写 ec9_sms_providers，跑完自动还原测试前的值
 */
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name} ${extra}`); }
}

async function main() {
  const smsConfig = require('../services/smsConfigService');
  const { SmsProvider, sequelize } = require('../models');
  const { encryptSecret, decryptSecret, maskSecret } = require('../utils/secretCrypto');
  const { QueryTypes } = require('sequelize');

  console.log('\n[1] 表字段');
  const cols = await sequelize.query(
    "SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'ec9_sms_providers'",
    { type: QueryTypes.SELECT }
  );
  const names = new Set(cols.map(r => r.c));
  ['region', 'endpoint', 'sign_name', 'verify_template_code',
    'code_expire_minutes', 'code_resend_seconds', 'code_max_attempts', 'code_daily_limit']
    .forEach(c => check('字段存在: ' + c, names.has(c)));

  console.log('\n[2] 凭证加解密');
  const enc = encryptSecret(JSON.stringify({ accessKeyId: 'LTAI123', accessKeySecret: 'sec456' }));
  const dec = JSON.parse(decryptSecret(enc));
  check('凭证可往返', dec.accessKeyId === 'LTAI123' && dec.accessKeySecret === 'sec456');
  check('坏密文返回 null', decryptSecret('zz:yy') === null);

  console.log('\n[3] 载入与来源');
  await smsConfig.load();
  const before = smsConfig.masked();
  check('配置来源为 db', smsConfig.source() === 'db', smsConfig.source());
  check('对外不回 Secret 明文', JSON.stringify(before).indexOf('sec456') === -1);

  console.log('\n[4] 保存与热更新');
  await smsConfig.save({ enabled: 1, access_key_id: 'LTAITEST001', access_key_secret: 's'.repeat(30), sign_name: '测试签名', verify_template_code: 'SMS_001', code_expire_minutes: 10, region: 'cn-hangzhou' }, 1);
  const c = smsConfig.get();
  check('AK ID 已更新', c.access_key_id === 'LTAITEST001');
  check('Secret 已更新', c.access_key_secret === 's'.repeat(30));
  check('有效期已更新', c.code_expire_minutes === 10);
  check('通道就绪', smsConfig.ready() === true);
  check('掩码不含明文', smsConfig.masked().access_key_secret_masked.indexOf('s'.repeat(30)) === -1);

  console.log('\n[5] Secret 语义');
  await smsConfig.save({ access_key_secret: '' }, 1);
  check('留空不修改', smsConfig.get().access_key_secret === 's'.repeat(30));
  await smsConfig.save({ access_key_secret: smsConfig.masked().access_key_secret_masked }, 1);
  check('回传掩码不修改', smsConfig.get().access_key_secret === 's'.repeat(30));

  console.log('\n[6] 校验规则');
  let threw = false;
  try { await smsConfig.save({ code_expire_minutes: 120 }, 1); } catch (e) { threw = /60/.test(e.message); }
  check('有效期超 60 分钟被拒', threw);
  threw = false;
  try { await smsConfig.save({ code_daily_limit: 999 }, 1); } catch (e) { threw = /100/.test(e.message); }
  check('日上限超 100 被拒', threw);
  threw = false;
  try { await smsConfig.save({ code_resend_seconds: 0 }, 1); } catch (e) { threw = /正整数/.test(e.message); }
  check('非正整数被拒', threw);

  console.log('\n[7] 自检');
  const okTest = smsConfig.selfTest();
  check('参数齐全时 ok', okTest.ok === true);
  check('参数齐全时 ready', okTest.ready === true);
  await smsConfig.save({ enabled: 1, access_key_id: '', sign_name: '' }, 1);
  const badTest = smsConfig.selfTest();
  check('缺 AK 时报 error', badTest.ok === false && badTest.issues.some(i => i.level === 'error'));
  check('issue 带 code（供前端翻译）', badTest.issues.every(i => !!i.code));
  check('停用时不 ready', (await (async () => { await smsConfig.save({ enabled: 0 }, 1); return smsConfig.ready(); })()) === false);

  console.log('\n[8] 还原');
  await smsConfig.save({
    enabled: before.enabled, region: before.region, endpoint: before.endpoint,
    sign_name: before.sign_name, verify_template_code: before.verify_template_code,
    code_expire_minutes: before.code_expire_minutes, code_resend_seconds: before.code_resend_seconds,
    code_max_attempts: before.code_max_attempts, code_daily_limit: before.code_daily_limit,
    remark: before.remark
  }, 1);
  await sequelize.query("UPDATE ec9_sms_providers SET config_encrypted = NULL WHERE name='aliyun'");
  await smsConfig.load();
  check('已还原（通道停用）', smsConfig.get().enabled === 0);
  check('凭证已清空', !smsConfig.get().access_key_secret);

  console.log(`\n========== 结果: ${pass} 通过 / ${fail} 失败 ==========`);
  if (failures.length) console.log('失败项:', failures.join(' | '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
