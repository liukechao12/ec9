/**
 * H5 三语切换防回归测试（真实浏览器 + 真实点击）
 *
 * 为什么必须真浏览器：EC8 搬来的 H5 页面 data-i18n 是我批量补的，
 * 一旦 HTML 结构被误改、或某个元素没被 i18n.js 扫到，
 * jsdom 测不出来（它不看 CSS 可见性、不做真实事件派发）。
 */
const { chromium } = require('playwright-core');
const fs = require('fs');

function findChromium() {
  const base = 'C:/Users/cloud_user/AppData/Local/ms-playwright';
  if (!fs.existsSync(base)) return null;
  for (const d of fs.readdirSync(base)) {
    if (!d.startsWith('chromium')) continue;
    for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']) {
      const p = base + '/' + d + '/' + rel;
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

const BASE = 'http://localhost:7098';
const INVITE = process.env.H5_INVITE_CODE || 'DEMO-NEW-95873';
const TICKET = process.env.H5_TICKET_CODE || 'DEMO-TICKET-604444';

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}

/** 取页面上所有 data-i18n 元素的文本 */
const READ = () => {
  const out = {};
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const k = el.getAttribute('data-i18n');
    out[k] = (el.textContent || '').trim();
  });
  return out;
};

async function clickLang(page, label) {
  // ⚠️ 切换器按钮的类是 .i18n-seg-btn（分段式），不是 .i18n-badge。
  //    早先误用 .i18n-badge 导致选择器匹配到 0 个元素，
  //    clickLang 恒返回 false，测试报「点 EN 没响应」——是测试自己的 bug，不是页面的。
  const box = await page.evaluate(l => {
    const els = [...document.querySelectorAll('.i18n-seg-btn, .i18n-badge')]
      .filter(e => (e.textContent || '').trim() === l);
    if (!els.length) return null;
    const r = els[0].getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width };
  }, label);
  if (!box || box.w === 0) return false;
  await page.mouse.click(box.x, box.y);
  await page.waitForTimeout(1200);
  return true;
}

/** 判断文本里是否残留简体（英文态下不该有中文） */
function hasChinese(s) { return /[一-龥]/.test(s); }

(async () => {
  const exe = findChromium();
  if (!exe) { console.log('✗ 找不到 chromium'); process.exit(2); }
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--disable-gpu'] });

  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    isMobile: true, hasTouch: true,
    extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9' }
  });
  const page = await ctx.newPage();

  const PAGES = [
    { name: '邀约页', url: '/invite/' + INVITE },
    { name: '会议主页', url: '/pages?code=' + INVITE },
    { name: '业绩说明会', url: '/pages/performance' },
    { name: '购票页', url: '/ticket.html?code=' + TICKET }
  ];

  for (const p of PAGES) {
    console.log('\n[' + p.name + '] ' + p.url);
    await page.goto(BASE + p.url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1800);

    const tagged = await page.evaluate(() => document.querySelectorAll('[data-i18n]').length);
    check('页面有 data-i18n 元素', tagged > 0, '共 ' + tagged + ' 个');

    // 英文态
    const clickedEn = await clickLang(page, 'EN');
    check('点 EN 有响应', clickedEn);
    const en = await page.evaluate(READ);
    // ⚠️ 必须按 key 比对，不能按 Object.values 的下标比 ——
    //    不同语言下 DOM 遍历顺序不保证一致，用下标会假阴性（2026-10-15 踩过）。
    const enVals = Object.values(en).filter(Boolean);
    check('英文态取到文案', enVals.length > 0, enVals.length + ' 条');
    const cnLeak = Object.keys(en).filter(k => en[k] && hasChinese(en[k]));
    check('英文态无中文残留', cnLeak.length === 0,
      cnLeak.length ? JSON.stringify(cnLeak.slice(0, 4).map(k => k + '=' + en[k])) : '');

    // 繁体态
    await clickLang(page, '繁');
    const tw = await page.evaluate(READ);
    // 「真的翻了」= 与英文**逐 key** 不同
    const twChanged = Object.keys(tw).filter(k => tw[k] && en[k] && tw[k] !== en[k]);
    check('繁体与英文有差异（真的翻了）', twChanged.length > 0, twChanged.length + ' 条不同');

    // 简体态：每个 key 都应是中文
    await clickLang(page, '简');
    const cn = await page.evaluate(READ);
    const notCn = Object.keys(cn).filter(k => cn[k] && !hasChinese(cn[k]));
    check('简体态全部为中文', notCn.length === 0,
      notCn.length ? JSON.stringify(notCn.slice(0, 4).map(k => k + '=' + cn[k])) : '');
    // 三态逐 key 互不相同（证明不是卡在某种语言）
    const stuck = Object.keys(cn).filter(k => cn[k] && cn[k] === en[k] && hasChinese(cn[k]));
    check('切回简体不回退成外文', stuck.length === 0,
      stuck.length ? JSON.stringify(stuck.slice(0, 4)) : '');
  }

  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();