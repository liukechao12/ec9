/**
 * 短信配置 HTTP 冒烟（临时端口 7099，不动正在跑的 7098 服务）
 * 用法：cd backend && node scripts/smoke-pay-config-http.js
 *
 * 覆盖：登录 → 读取配置（密钥应只回掩码）→ 自检 → 非管理员应 403
 */
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name} ${extra}`); }
}

const PORT = 7099;

async function main() {
  // 先改端口再 require app（app.js 顶部会读 config.server.port）
  const config = require('../config');
  config.server.port = PORT;
  require('../app');

  const base = `http://127.0.0.1:${PORT}/api`;
  // 等服务起来
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) break; } catch (e) { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 250));
  }

  console.log('\n[1] 健康检查');
  const health = await (await fetch(`${base}/health`)).json();
  check('health 可用', health.code === 0);
  check('health 带出支付模式', !!health.data.payMode, JSON.stringify(health.data));

  console.log('\n[2] 登录');
  const login = await (await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  })).json();
  check('管理员登录成功', login.code === 200 || login.code === 0, JSON.stringify(login).slice(0, 120));
  const token = login.data && login.data.token;
  check('拿到 token', !!token);

  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  console.log('\n[3] 读取支付配置');
  const res = await (await fetch(`${base}/sms-config`, { headers: auth })).json();
  check('接口返回 0', res.code === 0, JSON.stringify(res).slice(0, 200));
  const c = res.data && res.data.config;
  check('返回配置对象', !!c);
  
  check('不返回 Secret 明文', JSON.stringify(res).indexOf('access_key_secret\":') === -1);
  check('返回 Secret 掩码字段', typeof c.access_key_secret_masked === 'string');
  check('带出通道就绪标记', typeof c.ready === 'boolean');
  check('返回来源标记', c.source === 'db' || c.source === 'env');

  console.log('\n[4] 配置自检');
  const t = await (await fetch(`${base}/sms-config/test`, { method: 'POST', headers: auth, body: JSON.stringify({}) })).json();
  check('自检接口可用', t.code === 0);
  check('自检返回结果数组', Array.isArray(t.data.issues));
  console.log('       通道就绪:', t.data.ready, '｜来源:', t.data.source, '｜issues:', t.data.issues.length);

  console.log('\n[5] 权限');
  const noAuth = await (await fetch(`${base}/sms-config`)).status;
  check('未登录访问被拒 401', noAuth === 401, String(noAuth));

  console.log(`\n========== 结果: ${pass} 通过 / ${fail} 失败 ==========`);
  if (failures.length) console.log('失败项:', failures.join(' | '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
