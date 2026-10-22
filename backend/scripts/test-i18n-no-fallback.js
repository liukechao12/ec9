/**
 * 回归测试：切换后**不能大面积回退成简体**。
 *
 * ⚠️ 这条测试是为了固化一个真实踩过的坑（2026-10-14）：
 *
 *   现象：setLang('en') 后 apply() 确实把页面翻成了英文，
 *        但约 350ms 后又集体退回简体。
 *
 *   根因：i18n.js 自己的 MutationObserver 回调 apply(某个新增节点)
 *        → autoTranslate(那个节点) → restoreTextSrc() 无视 root 参数，
 *          把**整个页面**都还原成中文基准 → 接着只重译 root 那一小块
 *        → 范围外的节点被永久留在中文。
 *
 *   为什么之前没测出来：所有既有测试都是「切语言 → 立刻断言」，
 *   而这个 bug 要等 Observer 的 60ms 延迟之后才发作。
 *   **断言前必须等 > 200ms。**
 *
 * 用法：node scripts/test-i18n-no-fallback.js
 */
const fs = require('fs');
const { chromium } = require('playwright-core');

const BASE = 'C:/Users/cloud_user/AppData/Local/ms-playwright';
function findChromium() {
  if (!fs.existsSync(BASE)) return null;
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
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}

// 与 scan-untranslated.js 同一套判定口径
const CJK = /[\u4e00-\u9fff]/;
const SCAN = (page) => page.evaluate(() => {
  const SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, CODE: 1, PRE: 1 };
  const out = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
  let n;
  while ((n = w.nextNode())) {
    const raw = n.nodeValue;
    if (!raw || !raw.trim() || !/[\u4e00-\u9fff]/.test(raw)) continue;
    const el = n.parentElement;
    if (!el || SKIP[el.tagName]) continue;
    if (el.closest && el.closest('[data-i18n-off]')) continue;
    if (el.classList && el.classList.contains('i18n-seg-btn')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    out.push({ where: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''), text: raw.trim().slice(0, 40) });
  }
  return out;
});

(async () => {
  const exe = findChromium();
  if (!exe) { console.log('找不到 chromium，跳过'); process.exit(0); }

  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--disable-gpu'] });
  const ctx = await browser.newContext({ locale: 'zh-CN' });
  const page = await ctx.newPage();

  await page.goto('http://127.0.0.1:7098/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
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
  await page.waitForTimeout(1500);

  // 关键探针：静态 UI 区域（不含数据库业务数据，业务数据本就不该被前端词条翻）
  const PROBES = ['.logo-text', '#pageTitle', '.nav-item span'];

  async function probeTargets() {
    return await page.evaluate((sels) => {
      const out = {};
      for (const sel of sels) {
        document.querySelectorAll(sel).forEach((el, i) => {
          const t = el.textContent.trim();
          if (t && t.length > 1 && /[\u4e00-\u9fff]/.test(t)) out[sel + '#' + i] = t;
        });
      }
      return out;
    }, PROBES);
  }

  // 基线：中文态下有多少中文探针
  const baseline = await probeTargets();
  const baseCount = Object.keys(baseline).length;
  console.log('\n中文态下 UI 探针: ' + baseCount + ' 个');

  // ① 切 en，等 400ms（> Observer 的 60ms 延迟）再断言
  console.log('\n[1] zh-CN → en，等待 400ms（跨过 Observer 延迟窗口）');
  await page.click('.i18n-seg-btn[data-lang="en"]');
  await page.waitForTimeout(400);

  let stillCn = await probeTargets();
  let enCn = Object.keys(stillCn).filter(k => /[\u4e00-\u9fff]/.test(stillCn[k]));
  check('en 态下静态 UI 无中文残留（等 400ms 后）', enCn.length === 0,
    enCn.length + ' 处仍中文: ' + enCn.slice(0, 5).map(k => k + '="' + stillCn[k] + '"').join(' | '));

  const logo = await page.evaluate(() => (document.querySelector('.logo-text') || {}).textContent);
  check('logo 已译成英文', !CJK.test(logo || ''), 'logo=' + logo);

  // ② 再等 1s，确认不会继续回退
  console.log('\n[2] 再等 1000ms，确认不会继续回退');
  await page.waitForTimeout(1000);
  stillCn = await probeTargets();
  enCn = Object.keys(stillCn).filter(k => /[\u4e00-\u9fff]/.test(stillCn[k]));
  check('1s 后仍无中文残留', enCn.length === 0,
    enCn.length + ' 处仍中文: ' + enCn.slice(0, 5).map(k => k + '="' + stillCn[k] + '"').join(' | '));

  // ③ en → zh-TW 直切（不经中文中转）
  console.log('\n[3] en → zh-TW 直切，等 400ms');
  await page.click('.i18n-seg-btn[data-lang="zh-TW"]');
  await page.waitForTimeout(400);
  const logoTw = await page.evaluate(() => (document.querySelector('.logo-text') || {}).textContent);
  check('logo 已译成繁体', logoTw === '簽到系統', 'logo=' + logoTw);

  // ④ 回到中文，UI 应完整还原（不能丢字）
  console.log('\n[4] zh-TW → zh-CN 回切，等 400ms');
  await page.click('.i18n-seg-btn[data-lang="zh-CN"]');
  await page.waitForTimeout(400);
  const back = await probeTargets();
  const backKeys = Object.keys(back);
  check('回中文后 UI 探针数量与基线一致', backKeys.length === baseCount,
    '基线 ' + baseCount + ' → 现在 ' + backKeys.length);
  const logoCn = await page.evaluate(() => (document.querySelector('.logo-text') || {}).textContent);
  check('logo 还原为简体', logoCn === '签到系统', 'logo=' + logoCn);

  // ⑤ 全页面扫描（允许数据库业务数据残留，只看数量级）
  console.log('\n[5] 全页面中文节点数（仅作参考，业务数据会残留）');
  await page.click('.i18n-seg-btn[data-lang="en"]');
  await page.waitForTimeout(600);
  const all = await SCAN(page);
  console.log('  en 态全页面中文节点: ' + all.length + ' 个（数据库里的会议名/票种名等属正常）');

  console.log('\n结果: 通过 ' + pass + ' / 失败 ' + fail);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();