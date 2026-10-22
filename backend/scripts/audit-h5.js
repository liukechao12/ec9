/**
 * EC9 H5 真实浏览器巡检
 * 逐个打开 H5 页面，截图 + 收集控制台报错 + 抓失败请求
 * 目的：确认从 EC8 搬来的 H5 在 EC9 上真的能跑
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

/** 找本地已下载的 chromium（不联网下载，和 audit-ui.js 同一套逻辑） */
function findChromium() {
  const base = 'C:/Users/cloud_user/AppData/Local/ms-playwright';
  if (!fs.existsSync(base)) return null;
  for (const d of fs.readdirSync(base)) {
    if (!d.startsWith('chromium')) continue;
    for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe',
      'chrome-headless-shell-win64/chrome-headless-shell.exe']) {
      const p = base + '/' + d + '/' + rel;
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

const OUT = 'D:/temp/ec9-h5-shots';
const BASE = 'http://localhost:7098';
// ⚠️ 邀约码（DEMO-INV-*）与票码（DEMO-TICKET-*）是两套码，不能混用：
//    /pages 与 /invite 只认邀约码，/ticket.html 只认票码。
const INVITE_CODE = process.env.H5_INVITE_CODE || 'DEMO-INV-A1';
const TICKET_CODE = process.env.H5_TICKET_CODE || 'DEMO-TICKET-604444';

const PAGES = [
  { name: '会议主页', url: '/pages?code=' + INVITE_CODE, file: 'h1-会议主页' },
  { name: '邀约页', url: '/invite/' + INVITE_CODE, file: 'h2-邀约页' },
  { name: '业绩说明会', url: '/pages/performance', file: 'h3-业绩说明会' },
  { name: '用户协议', url: '/user-agreement', file: 'h4-用户协议' },
  { name: '隐私政策', url: '/privacy-policy', file: 'h5-隐私政策' },
  { name: '购票页', url: '/ticket.html?code=' + TICKET_CODE, file: 'h6-购票页' }
];

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const exe = findChromium();
  if (!exe) { console.log('✗ 找不到本地 chromium'); process.exit(2); }
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--disable-gpu'] });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
    isMobile: true, hasTouch: true
  });
  const page = await ctx.newPage();

  const errors = [];
  const badReq = [];
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text().slice(0, 160)); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message.slice(0, 160)));
  page.on('response', r => {
    if (r.status() >= 400) badReq.push(r.status() + ' ' + r.url().replace(BASE, ''));
  });

  const results = [];
  for (const p of PAGES) {
    const before = errors.length;
    const beforeBad = badReq.length;
    try {
      await page.goto(BASE + p.url, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(1800);
      const info = await page.evaluate(() => ({
        title: document.title,
        text: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 90),
        visible: document.querySelectorAll('div,section,form').length
      }));
      await page.screenshot({ path: path.join(OUT, p.file + '.png'), fullPage: false });
      results.push({
        page: p.name, url: p.url, ok: true,
        title: info.title, text: info.text,
        jsErr: errors.length - before,
        badReq: badReq.slice(beforeBad)
      });
    } catch (e) {
      await page.screenshot({ path: path.join(OUT, p.file + '-失败.png') }).catch(() => {});
      results.push({ page: p.name, url: p.url, ok: false, err: e.message.slice(0, 120) });
    }
  }

  // 三语切换（在会议主页上验）
  const i18nRes = {};
  await page.goto(BASE + '/pages?code=' + INVITE_CODE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  for (const [name, label] of [['繁體', '繁'], ['English', 'EN'], ['简体中文', '简']]) {
    const box = await page.evaluate(l => {
      const els = [...document.querySelectorAll('.i18n-badge')].filter(e => (e.textContent || '').trim() === l);
      if (!els.length) return null;
      const r = els[0].getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width };
    }, label);
    if (box && box.w > 0) await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(1200);
    i18nRes[name] = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 70));
    await page.screenshot({ path: path.join(OUT, 'lang-' + name + '.png') });
  }

  console.log('\n===== H5 巡检结果 =====');
  results.forEach(r => {
    if (!r.ok) { console.log('  ✗ ' + r.page.padEnd(8) + r.err); return; }
    console.log('  ✓ ' + r.page.padEnd(8) + ' JS错误' + r.jsErr + '  坏请求' + r.badReq.length +
      '  | ' + (r.text || '').slice(0, 50));
    r.badReq.forEach(b => console.log('       ' + b));
  });
  console.log('\n===== 三语切换 =====');
  Object.keys(i18nRes).forEach(k => console.log('  ' + k.padEnd(8) + ' ' + i18nRes[k]));
  console.log('\n错误合计: ' + errors.length);
  errors.slice(0, 12).forEach(e => console.log('  ! ' + e));

  fs.writeFileSync('D:/temp/ec9-h5-audit.json', JSON.stringify({ results, i18nRes, errors }, null, 2));
  await browser.close();
})();