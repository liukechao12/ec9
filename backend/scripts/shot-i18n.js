/**
 * 登录后三语切换截图（audit-ui.js 巡检点完「退出登录」会落回登录页，截不到主界面）
 * 顺带验证：繁体 / 英文下侧边栏与页面标题是否真的换了
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const OUT = 'D:/temp/ec9-shots';
const BASE = 'http://localhost:7098';

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

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const exe = findChromium();
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--disable-gpu'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await page.evaluate(async () => {
    const r = await fetch('/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });
    const j = await r.json();
    const tok = (j.data && j.data.token) || j.token;
    localStorage.setItem('token', tok);
    if (j.data && j.data.admin) localStorage.setItem('user', JSON.stringify(j.data.admin));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  // 找到语言切换按钮的真实结构
  const langBar = await page.evaluate(() => {
    const cands = [...document.querySelectorAll('button, a, span, select')]
      .filter(e => /简|繁|EN|中文|English|简体|繁體/i.test(e.textContent || '') && (e.textContent || '').trim().length <= 4);
    return cands.map(e => ({ tag: e.tagName, text: e.textContent.trim(), id: e.id, cls: e.className }))
      .slice(0, 12);
  });
  console.log('语言切换控件:', JSON.stringify(langBar, null, 1));

  for (const [name, label] of [['繁體', '繁'], ['English', 'EN'], ['简体中文', '简']]) {
    // ⚠️ 顶部切换器在 #langSwitcher（由 i18n.js 动态生成分段按钮）。
    //    页面上还有一堆 .i18n-badge（活动编辑表单里的「繁」「EN」标签），尺寸为 0 且不可点，
    //    只按 .i18n-badge 找会抓到假目标 → 必须限定在 #langSwitcher 内，
    //    并且用真实鼠标点击（JS .click() 落不到委托监听上）。
    const box = await page.evaluate(l => {
      const els = [...document.querySelectorAll('#langSwitcher button, #langSwitcher span, #langSwitcher a')]
        .filter(e => (e.textContent || '').trim() === l)
        .filter(e => e.getBoundingClientRect().width > 0);
      if (!els.length) return null;
      const r = els[0].getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
    }, label);
    if (box) await page.mouse.click(box.x, box.y);
    else console.log('  (切换器里找不到可点的「' + label + '」)');

    await page.waitForTimeout(1800);
    const info = await page.evaluate(() => {
      const nav = [...document.querySelectorAll('.nav-item, .sidebar a, .sidebar li')]
        .map(e => (e.textContent || '').trim()).filter(Boolean).slice(0, 8);
      const h = document.querySelector('.page-title, .module-title, header h1, h2');
      const cur = [...document.querySelectorAll('#langSwitcher button, #langSwitcher span')]
        .filter(e => /active|on|selected/.test(e.className))
        .map(e => (e.textContent || '').trim());
      const htmlLang = document.documentElement.lang;
      return { nav, title: h ? (h.textContent || '').trim() : '', cur, htmlLang };
    });
    console.log('\n' + name + ' (btn=' + (box ? Math.round(box.w) + 'x' + Math.round(box.h) : 'null') + ')');
    console.log('  html lang: ' + info.htmlLang + '  当前选中: ' + (info.cur.join(',') || '(未识别)'));
    console.log('  页面标题: ' + info.title);
    console.log('  侧边栏: ' + info.nav.join(' / '));
    await page.screenshot({ path: path.join(OUT, 'i18n-' + name + '.png') });
  }

  console.log('\nJS 错误: ' + errs.length);
  await browser.close();
})().catch(e => { console.error('ERR', e.stack); process.exit(1); });