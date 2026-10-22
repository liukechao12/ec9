/**
 * EC9 后台真实浏览器巡检：登录后逐个模块点开，截图 + 收集控制台报错
 * 目的：给昊哥一份「现在到底能干什么」的可信清单
 *
 * 用 playwright-core + 本地已下载的 chromium（不联网下载），
 * 登录走 fetch + localStorage（与 verify-i18n-playwright.js 同一套，稳定）。
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const OUT = 'D:/temp/ec9-shots';
const BASE = 'http://localhost:7098';

/** 找本地已下载的 chromium */
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
  if (!exe) { console.log('✗ 找不到本地 chromium'); process.exit(2); }
  console.log('浏览器: ' + exe + '\n');

  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--disable-gpu'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const page = await ctx.newPage();

  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text().slice(0, 200)); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message.slice(0, 200)));

  // 登录（fetch + localStorage，比填表稳定）
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1200);
  const login = await page.evaluate(async () => {
    const r = await fetch('/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });
    const j = await r.json();
    const tok = (j.data && j.data.token) || j.token;
    if (tok) {
      localStorage.setItem('token', tok);
      if (j.data && j.data.admin) localStorage.setItem('user', JSON.stringify(j.data.admin));
    }
    return { code: j.code, hasToken: !!tok };
  });
  console.log('登录: code=' + login.code + ' token=' + (login.hasToken ? '有' : '无'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, '01-控制台.png') });

  // 找侧边栏所有菜单项
  const menu = await page.evaluate(() => {
    const sels = ['.nav-item', '.sidebar a', '.sidebar li', '.menu-item', '[data-module]', '.nav a'];
    for (const s of sels) {
      const els = [...document.querySelectorAll(s)];
      if (els.length >= 3) {
        return els.map(e => ({
          text: (e.textContent || '').trim().slice(0, 20),
          id: e.id || '',
          cls: e.className,
          dataModule: e.getAttribute('data-module') || ''
        })).filter(x => x.text);
      }
    }
    return [];
  });
  console.log('\n侧边栏菜单项 (' + menu.length + '):');
  menu.forEach(m => console.log('  - [' + m.text + ']' + (m.dataModule ? ' module=' + m.dataModule : '')));

  // 逐个点开
  const results = [];
  for (let i = 0; i < menu.length; i++) {
    const m = menu[i];
    const before = errors.length;
    try {
      await page.evaluate(idx => {
        const sels = ['.nav-item', '.sidebar a', '.sidebar li', '.menu-item', '[data-module]', '.nav a'];
        for (const s of sels) {
          const els = [...document.querySelectorAll(s)].filter(e => (e.textContent || '').trim());
          if (els.length >= 3) { if (els[idx]) els[idx].click(); return; }
        }
      }, i);
      await page.waitForTimeout(1800);

      // 该页有没有报错 / 有没有内容
      const info = await page.evaluate(() => {
        const body = document.body.innerText || '';
        const active = document.querySelector('.nav-item.active, .sidebar .active, [data-module].active');
        return {
          activeText: active ? (active.textContent || '').trim() : '',
          bodyLen: body.length,
          errText: /错误|失败|Error|500|undefined is not/.test(body) ? body.slice(0, 150) : '',
          tableRows: document.querySelectorAll('table tbody tr').length,
          cards: document.querySelectorAll('.card, .stat-card, .panel').length
        };
      });
      const newErr = errors.length - before;
      const name = (m.text || ('菜单' + i)).replace(/[^\w一-龥]/g, '') || ('menu' + i);
      await page.screenshot({ path: path.join(OUT, String(i + 2).padStart(2, '0') + '-' + name + '.png') });
      results.push({
        menu: m.text, active: info.activeText, bodyLen: info.bodyLen,
        tableRows: info.tableRows, cards: info.cards,
        newErrors: newErr, errText: info.errText.slice(0, 80)
      });
      console.log('  [' + (i + 2) + '] ' + m.text + ' → 内容' + info.bodyLen + '字 表格' + info.tableRows + '行 新报错' + newErr);
    } catch (e) {
      console.log('  [' + (i + 2) + '] ' + m.text + ' → 点击异常: ' + e.message.slice(0, 80));
      results.push({ menu: m.text, error: e.message.slice(0, 100) });
    }
  }

  // 语言切换抽检
  console.log('\n[语言切换抽检]');
  for (const lang of ['繁體中文', 'English', '简体中文']) {
    try {
      await page.evaluate(l => {
        const els = [...document.querySelectorAll('select, [data-lang-switch], .lang-switch *')];
        for (const el of els) {
          if (el.tagName === 'SELECT') {
            const opt = [...el.options].find(o => o.text.includes(l));
            if (opt) { el.value = opt.value; el.dispatchEvent(new Event('change', { bubbles: true })); return true; }
          } else if ((el.textContent || '').trim() === l) { el.click(); return true; }
        }
        return false;
      }, lang);
      await page.waitForTimeout(1500);
      const sample = await page.evaluate(() => {
        const h = document.querySelector('.page-title, h2, .module-title, header h1');
        return h ? (h.textContent || '').trim() : (document.body.innerText || '').slice(0, 40);
      });
      console.log('  ' + lang + ' → 标题显示: ' + sample.slice(0, 30));
      await page.screenshot({ path: path.join(OUT, 'lang-' + lang.replace(/[^\w]/g, '') + '.png') });
    } catch (e) { console.log('  ' + lang + ' → ' + e.message.slice(0, 60)); }
  }

  // H5 页面探测
  console.log('\n[H5 页面探测]');
  for (const p of ['/h5/pages.html', '/h5/invite.html', '/h5/checkin.html', '/h5/performance.html',
                   '/h5/ticket.html', '/ticket.html', '/pages.html', '/invite.html', '/checkin.html']) {
    const r = await page.evaluate(u => fetch(u, { method: 'GET' }).then(x => x.status).catch(() => 'ERR'), BASE + p);
    console.log('  ' + p + ' → ' + r);
  }

  console.log('\n控制台错误合计: ' + errors.length);
  errors.slice(0, 10).forEach(e => console.log('  ' + e));

  fs.writeFileSync('D:/temp/ec9-ui-audit.json', JSON.stringify({ menu, results, errors }, null, 2));
  await browser.close();
  console.log('\n截图目录: ' + OUT);
})().catch(e => { console.error('ERR', e.stack); process.exit(1); });