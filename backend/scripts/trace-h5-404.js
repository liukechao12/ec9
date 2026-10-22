/**
 * 定位 H5 页面的 404 /「Unexpected token '<'」
 * 手段：真浏览器 + 全量响应监听，把失败 URL 逐条打出来
 */
const { chromium } = require('playwright-core');
const fs = require('fs');

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

const BASE = 'http://localhost:7098';
const CODE = 'DEMO-INV-A1';

(async () => {
  const exe = findChromium();
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--disable-gpu'] });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
    isMobile: true, hasTouch: true
  });
  const page = await ctx.newPage();

  const all = [];
  page.on('response', async r => {
    all.push({ status: r.status(), url: r.url().replace(BASE, ''), ct: r.headers()['content-type'] || '' });
  });
  page.on('pageerror', e => console.log('PAGEERROR: ' + e.message.slice(0, 120)));

  for (const p of ['/pages?code=' + CODE, '/invite/' + CODE, '/ticket.html?code=' + CODE]) {
    all.length = 0;
    console.log('\n===== ' + p + ' =====');
    await page.goto(BASE + p, { waitUntil: 'networkidle', timeout: 30000 }).catch(e => console.log('goto: ' + e.message.slice(0, 80)));
    await page.waitForTimeout(2000);
    all.filter(x => x.status >= 400 || x.ct.includes('text/html'))
      .forEach(x => console.log('  ' + x.status + ' ' + x.ct.slice(0, 24) + '  ' + x.url.slice(0, 90)));
    console.log('  共 ' + all.length + ' 个请求，异常 ' +
      all.filter(x => x.status >= 400 || x.ct.includes('text/html')).length + ' 个');
  }

  await browser.close();
})();