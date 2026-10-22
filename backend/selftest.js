/**
 * EC9 冒烟自检（直驱服务层，不依赖 HTTP 回环）
 * 用法：cd backend && node selftest.js
 */
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name} ${extra}`); }
}

async function main() {
  // ===== 1. 配置 =====
  console.log('\n[1] 配置加载');
  const config = require('./config');
  check('JWT_SECRET 已设置', !!config.jwt.secret && config.jwt.secret.length >= 32);
  check('ENCRYPTION_KEY 32 字符', config.encryption.getKey().length === 32);
  check('PHONE_HMAC_KEY 已设置', !!config.phoneHmac.key);
  check('数据库配置完整', !!config.database.name && !!config.database.user);

  // ===== 2. 数据库 + 20 张表 =====
  console.log('\n[2] 数据库连接与表结构');
  const { testConnection, sequelize } = require('./config/database');
  const { QueryTypes } = require('sequelize');
  await testConnection();
  const tables = await sequelize.query(
    "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = current_schema()",
    { type: QueryTypes.SELECT }
  );
  const expected = [
    'ec9_admins', 'ec9_events', 'ec9_sessions', 'ec9_ticket_types', 'ec9_guests',
    'ec9_invitations', 'ec9_registrations', 'ec9_orders', 'ec9_payments', 'ec9_approvals',
    'ec9_auto_audit_rules', 'ec9_checkin_codes', 'ec9_checkins', 'ec9_sms_providers',
    'ec9_sms_templates', 'ec9_sms_logs', 'ec9_verification_codes', 'ec9_verification_tokens',
    'ec9_operation_logs', 'ec9_legal_docs'
  ];
  const existing = new Set(tables.map(r => r.t));
  const missing = expected.filter(t => !existing.has(t));
  check('20 张 EC9 表全部就位', missing.length === 0, missing.join(','));

  // ===== 3. 模型加载 =====
  console.log('\n[3] 模型加载');
  const models = require('./models');
  const modelClasses = Object.values(models).filter(v => typeof v === 'function' && v.prototype && v.prototype.sequelize !== undefined || (v && v.tableName));
  check('20 个模型导出', modelClasses.length >= 20, `实际 ${modelClasses.length}`);
  check('状态机常量齐全', models.REG_STATUS && models.ORDER_STATUS && models.REG_STATUS.APPROVED === 'approved');

  // ===== 4. i18n 三语包 =====
  console.log('\n[4] 多语言包');
  const i18nDir = path.join(__dirname, 'public', 'i18n');
  const langs = {};
  for (const lang of ['zh-CN', 'en', 'zh-TW']) {
    langs[lang] = JSON.parse(fs.readFileSync(path.join(i18nDir, `${lang}.json`), 'utf8'));
  }
  const flat = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null ? flat(v, prefix + k + '.') : [prefix + k]
  );
  const keysCN = new Set(flat(langs['zh-CN']));
  const keysEN = new Set(flat(langs['en']));
  const keysTW = new Set(flat(langs['zh-TW']));
  check('zh-CN/en 键位一致', keysCN.size === keysEN.size && [...keysCN].every(k => keysEN.has(k)),
    `zh-CN=${keysCN.size} en=${keysEN.size}`);
  check('zh-CN/zh-TW 键位一致', keysCN.size === keysTW.size && [...keysCN].every(k => keysTW.has(k)),
    `zh-CN=${keysCN.size} zh-TW=${keysTW.size}`);
  check('词条库非空（>900 条）', keysCN.size > 900, `实际 ${keysCN.size}`);

  // ===== 5. 手机号加密工具 =====
  console.log('\n[5] 手机号加密/HMAC');
  const { encryptPhone, decryptPhone, hmacPhone, hashCode } = require('./utils/phoneCrypto');
  const phone = '13800138000';
  const enc = encryptPhone(phone);
  check('AES 加解密往返', decryptPhone(enc) === phone);
  check('HMAC 确定性', hmacPhone(phone) === hmacPhone(phone));
  check('HMAC 区分不同号码', hmacPhone(phone) !== hmacPhone('13900139000'));
  check('HMAC 长度 64 hex', /^[0-9a-f]{64}$/.test(hmacPhone(phone)));
  check('验证码哈希不存明文', hashCode('123456') !== '123456');

  // ===== 6. 验证闭环（mock 通道） =====
  console.log('\n[6] 强制手机号验证闭环');
  const verification = require('./services/verificationService');
  const sms = require('./services/verificationSmsService');
  // ⚠️ 用随机手机号，不要写死 13800138000：
  //   sendCode 有「同号 60s 频率限制 + 每日上限」，写死的号跑过一次之后
  //   再跑就会被限流，表现为 devOutbox 取不到码 → 后面 r3.token 崩。
  const testPhone = '139' + String(Date.now()).slice(-8);

  const r1 = await verification.sendCode(testPhone, 'register', '127.0.0.1');
  check('发送验证码成功（mock）', r1.ok === true, JSON.stringify(r1));
  const devCode = sms.devOutbox.get(hmacPhone(testPhone));
  check('mock 码登记在进程内（不回前端）', !!devCode && /^\d{6}$/.test(devCode.code));

  const r2 = await verification.verifyCode(testPhone, '000000', 'register');
  check('错误验证码被拒', r2.ok === false);
  const r3 = await verification.verifyCode(testPhone, devCode.code, 'register');
  check('正确验证码通过并签发 token', r3.ok === true && typeof r3.token === 'string');

  const c1 = await verification.consumeToken(r3.token, 'register');
  check('凭证首次消费成功', c1.ok === true && c1.phoneHmac === hmacPhone(testPhone));
  const c2 = await verification.consumeToken(r3.token, 'register');
  check('凭证不可重复消费', c2.ok === false);

  const c3 = await verification.consumeToken(r3.token, 'register', '13900139000');
  check('凭证与手机号不匹配被拒', c3.ok === false);

  // 频率限制（同样用随机号：写死的号第二次跑时 f1 就会被上一轮限流，
  // 断言要求 f1.ok===true，于是变成偶发 FAIL。
  // 刻意用 138 号段，与上面 testPhone 的 139 号段错开，避免同毫秒撞号）
  const ratePhone = '138' + String(Date.now()).slice(-8);
  const f1 = await verification.sendCode(ratePhone, 'register', '127.0.0.1');
  const f2 = await verification.sendCode(ratePhone, 'register', '127.0.0.1');
  check('60 秒频率限制生效', f1.ok === true && f2.ok === false && f2.retryAfter > 0, JSON.stringify({ f1: f1.ok, f2: f2.error }));

  // 格式校验
  const bad1 = await verification.sendCode('12345', 'register', '');
  check('非法手机号被拒', bad1.ok === false);

  // 过期逻辑（构造一条已过期记录）
  const { VerificationCode } = models;
  await VerificationCode.create({
    phone_hmac: hmacPhone(testPhone),
    code_hash: hashCode('654321'),
    purpose: 'login',
    expires_at: new Date(Date.now() - 60000)
  });
  const exp = await verification.verifyCode(testPhone, '654321', 'login');
  check('过期验证码被拒', exp.ok === false && /过期/.test(exp.error));

  // 尝试次数逻辑
  await VerificationCode.create({
    phone_hmac: hmacPhone(testPhone),
    code_hash: hashCode('111111'),
    purpose: 'register',
    max_attempts: 2,
    expires_at: new Date(Date.now() + 300000)
  });
  await verification.verifyCode(testPhone, '000000', 'register'); // 错 1
  await verification.verifyCode(testPhone, '000000', 'register'); // 错 2 → 达上限
  const att = await verification.verifyCode(testPhone, '111111', 'register');
  check('超过尝试次数后即使码正确也拒', att.ok === false);

  // ===== 7. 自动审核规则结构 =====
  console.log('\n[7] 自动审核规则模型');
  const rule = await models.AutoAuditRule.create({
    event_id: 0,
    name: '自检规则',
    conditions: { all: [{ field: 'paid', op: 'eq', value: false }] }
  });
  check('规则可创建且 conditions 为 JSON', !!rule.id && rule.conditions.all.length === 1);
  await rule.destroy();

  // ===== 汇总 =====
  console.log(`\n========== 结果: ${pass} 通过 / ${fail} 失败 ==========`);
  if (failures.length) console.log('失败项:', failures.join(' | '));
  await sequelize.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('自检异常:', e); process.exit(1); });
