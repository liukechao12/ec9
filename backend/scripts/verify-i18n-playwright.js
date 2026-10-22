/**
 * 真实 Chromium 点击验证语言切换（playwright-core + 本地已装浏览器）
 *
 * 为什么非做不可：jsdom 每次重读文件，**不复现浏览器缓存**；
 * 2026-10-14「改了 i18n.js 但切换行为还是旧的」就是纯缓存问题，jsdom 全绿。
 * 这一层用真实点击（button.click() 走浏览器事件系统）+ 真实 fetch + 真实缓存。
 *
 * 用法：node scripts/verify-i18n-playwright.js
 */
const fs = require('fs');
const { chromium } = require('playwright-core');

const URL = 'http://127.0.0.1:7098/';
const OUT = 'D:/temp/i18n-playwright-report.json';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

(async () => {
  // 优先用本地已下载的 chromium（不联网下载）
  const base = 'C:/Users/cloud_user/AppData/Local/ms-playwright';
  let exe = null;
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base)) {
      if (!d.startsWith('chromium')) continue;
      // 不同 Playwright 版本目录名不同：chrome-win / chrome-win64 / chrome-headless-shell-win64
      for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe',
        'chrome-headless-shell-win64/chrome-headless-shell.exe']) {
        const p = base + '/' + d + '/' + rel;
        if (fs.existsSync(p)) { exe = p; break; }
      }
      if (exe) break;
    }
  }
  if (!exe) { console.log('✗ 找不到本地 chromium（目录: ' + base + '）'); process.exit(2); }
  console.log('浏览器: ' + exe + '\n');

  const browser = await chromium.launch({
    executablePath: exe,
    args: ['--no-sandbox', '--disable-gpu']
  });
  // 用一个全新 profile：确保不残留任何旧缓存，模拟「第一次访问」
  const ctx = await browser.newContext({ locale: 'zh-CN' });
  const page = await ctx.newPage();

  const consoleErrs = [], pageErrs = [], reqFailed = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrs.push(m.text()); });
  page.on('pageerror', e => pageErrs.push(e.message));
  page.on('requestfailed', r => reqFailed.push(r.url() + ' :: ' + (r.failure() || {}).errorText));

  console.log('打开 ' + URL);
  const resp = await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('HTTP ' + resp.status());
  await page.waitForTimeout(1200);

  // ⚠️ 必须先登录：语言切换器在 #mainPage 的 header 里，
  // 未登录时 #mainPage 是隐藏的（size=0x0），按钮点不到 —— 不是 bug，是没登录。
  console.log('登录 admin/admin123 …');
  const loginRes = await page.evaluate(async () => {
    const r = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });
    const j = await r.json();
    const tok = (j.data && j.data.token) || j.token;
    if (tok) {
      localStorage.setItem('token', tok);
      if (j.data && j.data.admin) localStorage.setItem('user', JSON.stringify(j.data.admin));
    }
    return { code: j.code, hasToken: !!tok, keys: Object.keys(j.data || {}).join(',') };
  });
  console.log('  登录 code=' + loginRes.code + ' token=' + (loginRes.hasToken ? '已拿到' : '失败'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.I18N && typeof window.I18N.setLang === "function"', { timeout: 15000 })
    .catch(() => console.log('  ⚠️ I18N 未就绪'));
  await page.waitForTimeout(2500);

  // ---- 关键：确认浏览器真正加载的是新版 i18n.js ----
  const loaded = await page.evaluate(() => ({
    version: (typeof I18N !== 'undefined' && I18N.version) || null,
    lang: typeof I18N !== 'undefined' ? I18N.getLang() : null,
    // 直接问服务端要当前 i18n.js 里的标记
    hasFix: true
  }));
  const srcHasFix = await page.evaluate(async () => {
    const r = await fetch('/i18n.js?probe=' + Date.now());
    const t = await r.text();
    return { hasFix: t.includes('无条件先还原成中文基准'), ver: (t.match(/var VERSION = '([^']+)'/) || [])[1] };
  });
  console.log('  I18N.version = ' + loaded.version + ' | 当前语言 = ' + loaded.lang);
  console.log('  服务端 i18n.js: VERSION=' + srcHasFix.ver + ' 含修复=' + srcHasFix.hasFix);
  check('★ 浏览器环境可用 I18N', loaded.lang !== null, String(loaded.lang));

  // 观察点
  const setup = await page.evaluate(() => {
    window.__obs = Array.from(document.querySelectorAll('[data-i18n]')).slice(0, 40);
    window.__snap = () => window.__obs.map(e => e.textContent.replace(/\s+/g, ' ').trim());
    window.__base = window.__snap();
    return { count: window.__obs.length, base: window.__base.slice(0, 5) };
  });
  console.log('  观察点 ' + setup.count + ' 个');
  console.log('  初始: ' + setup.base.join(' | ') + '\n');
  check('页面存在 data-i18n 观察点', setup.count > 0, String(setup.count));

  // 切换器按钮
  const btns = await page.$$eval('.i18n-seg-btn', els => els.map(e => e.getAttribute('data-lang')));
  check('三语切换按钮齐全', ['zh-CN', 'zh-TW', 'en'].every(l => btns.includes(l)), btns.join(','));

  // ★ 按钮必须真的可见可点：DOM 里存在 ≠ 用户点得到。
  //   （未登录时 #mainPage 隐藏，header 是 0x0，按钮存在但点不动）
  const vis = await page.evaluate(() => {
    const b = document.querySelector('.i18n-seg-btn[data-lang="zh-TW"]');
    if (!b) return { ok: false, why: '按钮不存在' };
    const r = b.getBoundingClientRect();
    const cs = getComputedStyle(b);
    let top = b, hidden = false;
    while (top && top !== document.body) {
      const s = getComputedStyle(top);
      if (s.display === 'none' || s.visibility === 'hidden') { hidden = true; break; }
      top = top.parentElement;
    }
    return {
      ok: !hidden && r.width > 0 && r.height > 0 && cs.visibility !== 'hidden',
      why: hidden ? '祖先容器隐藏' : ('size=' + Math.round(r.width) + 'x' + Math.round(r.height)),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    };
  });
  check('★ 切换按钮可见且有尺寸（可点击）', vis.ok, vis.why);

  // ★ 真实点击（走浏览器事件系统，不是 eval 调 API）
  const clickLang = async (lang) => {
    const sel = `.i18n-seg-btn[data-lang="${lang}"]`;
    const el = await page.$(sel);
    if (!el) return 'no-button';
    await el.click();               // Playwright 真实鼠标点击
    await page.waitForTimeout(1100);
    return 'clicked';
  };
  const snap = () => page.evaluate(() => window.__snap());
  const getLang = () => page.evaluate(() => I18N.getLang());
  const isAscii = a => a.filter(s => s && /[A-Za-z]/.test(s) && !/[\u4e00-\u9fff]/.test(s)).length;
  const baseNow = () => page.evaluate(() => window.__base);

  console.log('[1] 真实点击「繁體中文」');
  let r = await clickLang('zh-TW');
  let s = await snap();
  console.log('    ' + r + ' → 语言=' + await getLang() + ' | ' + s.slice(0, 4).join(' | '));
  check('★ 点击繁体生效', await getLang() === 'zh-TW', await getLang());
  check('★ 文案非英文残留', isAscii(s) < s.length * 0.4, '英文 ' + isAscii(s) + '/' + s.length);
  const twSnap = s.slice();

  console.log('\n[2] 真实点击「English」');
  r = await clickLang('en');
  s = await snap();
  console.log('    ' + r + ' → 语言=' + await getLang() + ' | ' + s.slice(0, 4).join(' | '));
  check('★ 点击英文生效', await getLang() === 'en', await getLang());
  check('★ 文案已变英文', isAscii(s) > s.length * 0.5, '英文 ' + isAscii(s) + '/' + s.length);

  console.log('\n[3] 真实点击「简体中文」');
  r = await clickLang('zh-CN');
  s = await snap();
  let b = await baseNow();
  check('★ 回到初始中文', JSON.stringify(s) === JSON.stringify(b),
    s.slice(0, 3).join('|') + ' vs ' + b.slice(0, 3).join('|'));

  console.log('\n[4] 连点 8 次（竞态）');
  const seq = ['en', 'zh-TW', 'en', 'zh-CN', 'zh-TW', 'zh-CN', 'en', 'zh-CN'];
  for (const l of seq) {
    const el = await page.$(`.i18n-seg-btn[data-lang="${l}"]`);
    if (el) { await el.click(); await page.waitForTimeout(130); }
  }
  await page.waitForTimeout(1800);
  s = await snap(); b = await baseNow();
  check('★ 连点后停在中文', await getLang() === 'zh-CN', await getLang());
  check('★ 连点后文案与初始一致', JSON.stringify(s) === JSON.stringify(b));

  console.log('\n[5] 重复点击同一语言（幂等）');
  for (const l of ['zh-TW', 'zh-TW', 'zh-TW']) {
    const el = await page.$(`.i18n-seg-btn[data-lang="${l}"]`);
    if (el) { await el.click(); await page.waitForTimeout(900); }
  }
  s = await snap();
  check('★ 重复点繁体结果稳定', JSON.stringify(s) === JSON.stringify(twSnap),
    '与首次不一致：' + s.slice(0, 3).join('|'));

  console.log('\n[6] placeholder 属性三语');
  const phs = {};
  for (const l of ['zh-CN', 'zh-TW', 'en']) {
    const el = await page.$(`.i18n-seg-btn[data-lang="${l}"]`);
    if (el) { await el.click(); await page.waitForTimeout(950); }
    phs[l] = await page.evaluate(() => {
      const e = document.querySelector('input[placeholder]');
      return e ? e.placeholder : '(无)';
    });
  }
  console.log('    ' + JSON.stringify(phs));
  check('★ placeholder 三语互不相同', new Set(Object.values(phs)).size === 3, JSON.stringify(phs));

  // 回到中文
  const elCn = await page.$('.i18n-seg-btn[data-lang="zh-CN"]');
  if (elCn) { await elCn.click(); await page.waitForTimeout(900); }

  console.log('\n[7] 高亮状态');
  const active = await page.$$eval('.i18n-seg-btn.active', els => els.map(e => e.getAttribute('data-lang')));
  check('仅一个高亮且为 zh-CN', active.length === 1 && active[0] === 'zh-CN', active.join(','));

  console.log('\n[8] 控制台 / 网络');
  check('无页面 JS 异常', pageErrs.length === 0, pageErrs.slice(0, 3).join(' | '));
  check('无资源加载失败', reqFailed.length === 0, reqFailed.slice(0, 3).join(' | '));
  if (consoleErrs.length) console.log('  控制台 error（可能有影响）: ' + consoleErrs.slice(0, 3).join(' | '));

  fs.writeFileSync(OUT, JSON.stringify({
    url: URL, loaded, srcHasFix, setupCount: setup.count, btns,
    consoleErrs, pageErrs, reqFailed, phs
  }, null, 2));

  await browser.close();
  console.log('\n========================================');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('   - ' + f)); }
  console.log('  报告: ' + OUT);
  console.log('========================================');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('验证异常:', e && e.stack || e); process.exit(2); });
