/**
 * 扫描：切到 en / zh-TW 后，页面上仍残留简体文案的位置。
 * 目的：找出「兜底失效 / key 找不到 / 反查失败」的具体节点。
 *
 * 用法：node scripts/scan-untranslated.js
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

const HAS_CJK = /[\u4e00-\u9fff]/;

// 简繁同形字集合里，这些字在繁体里也是这个形，不算「残留简体」
const SAME = new Set('公司下一名片单信息操作取消刷新排序描述停止启动签到审核备注异常账户业务转换选择填写删除保存语言后台页面'.split(''));

/** 在浏览器里跑：抓残留中文节点 */
const SCAN = (page) => page.evaluate(() => {
    const SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, CODE: 1, PRE: 1 };
    const hits = [];

    function describe(el) {
      let s = el.tagName.toLowerCase();
      if (el.id) s += '#' + el.id;
      if (el.className && typeof el.className === 'string') {
        s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
      }
      return s;
    }

    // 1) 可见文本节点
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    let n;
    while ((n = walker.nextNode())) {
      const raw = n.nodeValue;
      if (!raw || !raw.trim()) continue;
      if (!/[\u4e00-\u9fff]/.test(raw)) continue;
      const el = n.parentElement;
      if (!el || SKIP[el.tagName]) continue;
      if (el.closest && el.closest('[data-i18n-off]')) continue;
      if (el.classList && el.classList.contains('i18n-seg-btn')) continue;
      // 不可见
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      hits.push({
        kind: 'text',
        where: describe(el),
        text: raw.trim().slice(0, 60),
        hasDataI18n: el.hasAttribute('data-i18n') ? el.getAttribute('data-i18n') : null
      });
    }

    // 2) 属性（placeholder / title）
    const all = document.querySelectorAll('[placeholder],[title]');
    for (const el of all) {
      for (const a of ['placeholder', 'title']) {
        const v = el.getAttribute(a);
        if (!v || !/[\u4e00-\u9fff]/.test(v)) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        hits.push({ kind: 'attr:' + a, where: describe(el), text: v.slice(0, 60), hasDataI18n: null });
      }
    }
    return hits;
});

(async () => {
  const exe = findChromium();
  if (!exe) { console.log('找不到 chromium'); process.exit(2); }

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

  // 切到「订单管理」页，动态渲染的内容最容易暴露问题
  await page.click('.i18n-seg-btn[data-lang="en"]');
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const el = document.querySelector('[data-page="orders"], #page-orders, [data-nav="orders"]');
    if (el) el.click();
  });
  await page.waitForTimeout(1800);

  for (const lang of ['en', 'zh-TW']) {
    await page.click('.i18n-seg-btn[data-lang="' + lang + '"]');
    await page.waitForTimeout(1500);
    const hits = await SCAN(page);
    console.log('\n================ 当前语言: ' + lang + ' ================');
    console.log('残留中文节点数: ' + hits.length);
    // 去重（同一文本只列一次）
    const seen = new Set();
    const uniq = hits.filter(h => {
      const k = h.kind + '|' + h.text;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    console.log('去重后: ' + uniq.length);
    uniq.slice(0, 60).forEach(h => {
      console.log('  [' + h.kind + '] ' + h.where + (h.hasDataI18n ? '  data-i18n=' + h.hasDataI18n : ''));
      console.log('      "' + h.text + '"');
    });
    if (uniq.length > 60) console.log('  ... 另有 ' + (uniq.length - 60) + ' 条');
  }

  await browser.close();
})();