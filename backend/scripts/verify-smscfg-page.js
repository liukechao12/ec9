/**
 * 短信配置页 UI 验证（Playwright 真浏览器）
 * 用法：cd backend && node scripts/verify-paycfg-page.js（需 7098 服务在跑）
 *
 * 验证点：
 *   1. 菜单里有「支付配置」，点击能进页面
 *   2. 表单能载入真实配置（商户号/回调地址/有效期）
 *   3. 切 en / zh-TW 后页面无简体残留（排除测试数据）
 *   4. 自检按钮出结果
 */
const fs = require('fs');
const { chromium } = require('playwright-core');

const BASE = 'C:/Users/cloud_user/AppData/Local/ms-playwright';
function findChromium() {
  for (const d of fs.readdirSync(BASE)) {
    if (!d.startsWith('chromium')) continue;
    for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-win/headless_shell.exe']) {
      const p = BASE + '/' + d + '/' + rel;
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name} ${extra}`); }
}

(async () => {
  const exe = findChromium();
  if (!exe) { console.log('找不到 chromium'); process.exit(2); }

  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--disable-gpu'] });
  const ctx = await browser.newContext({ locale: 'zh-CN' });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('  [页面报错]', e.message));

  await page.goto('http://127.0.0.1:7098/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.evaluate(async () => {
    const r = await fetch('/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });
    const j = await r.json();
    localStorage.setItem('token', j.data.token);
    localStorage.setItem('user', JSON.stringify(j.data.admin));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.I18N && typeof window.I18N.setLang === "function"', { timeout: 15000 });
  await page.waitForTimeout(1200);

  console.log('\n[1] 菜单与页面');
  const navExists = await page.evaluate(() => !!document.querySelector('.nav-item[data-page="sms-config"]'));
  check('侧边栏有「短信配置」入口', navExists);
  await page.evaluate(() => document.querySelector('.nav-item[data-page="sms-config"]').click());
  await page.waitForTimeout(1500);
  const visible = await page.evaluate(() => {
    const el = document.getElementById('sms-config');
    return !!el && !el.classList.contains('hidden');
  });
  check('页面容器可见', visible);

  console.log('\n[2] 配置载入');
  const form = await page.evaluate(() => ({
    enabled: (document.getElementById('scEnabled') || {}).value,
    region: (document.getElementById('scRegion') || {}).value,
    expire: (document.getElementById('scExpire') || {}).value,
    statusText: (document.getElementById('scStatusText') || {}).textContent,
    sourceText: (document.getElementById('scSourceText') || {}).textContent,
    secretMask: (document.getElementById('scAkSecretMask') || {}).textContent,
    optCount: (document.getElementById('scEnabled') || {}).options.length
  }));
  console.log('       ', JSON.stringify(form));
  check('启停下拉已填充 2 项', form.optCount === 2);
  check('地域已载入', !!form.region);
  check('验证码有效期已载入', String(form.expire) === '5');
  check('来源显示为数据库', /数据库/.test(form.sourceText || ''));

  console.log('\n[3] 自检按钮');
  await page.evaluate(() => document.querySelector('button[onclick="testSmsConfig()"]').click());
  await page.waitForTimeout(1200);
  const testHtml = await page.evaluate(() => (document.getElementById('scTestResult') || {}).innerHTML || '');
  check('自检有输出', testHtml.length > 20);
  // error 级 issue 用红色是正常设计；这里只判断是否抛了异常文本
  check('自检未抛错', !/加载失败|FAILED/.test(testHtml));

  console.log('\n[4] 多语言');
  for (const lang of ['en', 'zh-TW']) {
    await page.click('.i18n-seg-btn[data-lang="' + lang + '"]');
    await page.waitForTimeout(1500);
    const hits = await page.evaluate(() => {
      const out = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      let n;
      while ((n = walker.nextNode())) {
        const raw = (n.nodeValue || '').trim();
        if (!raw || !/[\u4e00-\u9fff]/.test(raw)) continue;
        const el = n.parentElement;
        if (!el) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        out.push(raw.slice(0, 40));
      }
      return out;
    });
    // 简繁同形字不算残留；这里只统计整段仍是简体高频词的情况
    // en：出现中文即为残留；zh-TW：只认简体特有字（时/讯/发/实/简/号…），
    // 同形字（停用/地域/缺少/配置）在繁体里本来就长这样，不算残留
    // 语言切换按钮上的「简 / 繁 / 系」是全站固定 UI，不算本页残留
    const WHITE = new Set(['简', '繁', '系']);
    const rules = lang === 'en'
      ? (t) => /[\u4e00-\u9fff]/.test(t) && !WHITE.has(t)
      : (t) => /[时讯发实简号当将须码区验证开关动务数错]/.test(t) && !WHITE.has(t);
    const suspicious = hits.filter(t => rules(t));
    console.log(`       ${lang}: 中文节点 ${hits.length}，可疑残留 ${suspicious.length}`, suspicious.slice(0, 5));
    check(`${lang} 下短信配置页无简体残留`, suspicious.length === 0, suspicious.join(' / '));
  }

  // 回到简体，确认英文模式下关键文案已切换
  await page.click('.i18n-seg-btn[data-lang="en"]');
  await page.waitForTimeout(1200);
  const enText = await page.evaluate(() => (document.getElementById('scStatusText') || {}).textContent || '');
  console.log('       en 通道状态文案:', enText);

  await browser.close();
  console.log(`\n========== 结果: ${pass} 通过 / ${fail} 失败 ==========`);
  if (failures.length) console.log('失败项:', failures.join(' | '));
  process.exit(fail ? 1 : 0);
})();
