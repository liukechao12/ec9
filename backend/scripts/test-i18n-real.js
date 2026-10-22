/**
 * 用**真实的 index.html** 测语言切换（不是简化页面）
 *
 * 起因：简化的 test-i18n-zhtw.js 12 项全绿，但真实页面上昊哥说切换不了。
 *       简化页面只有 5 个元素，真实页面 124KB / 60 处 data-i18n + 大量动态节点。
 *
 * 用法：node scripts/test-i18n-real.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const PUB = path.join(__dirname, '..', 'public');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else {
    fail++; failures.push(name + (detail ? ' :: ' + detail : ''));
    console.log('  FAIL ' + name + (detail ? ' :: ' + detail : ''));
  }
}

async function run() {
  const i18nSrc = fs.readFileSync(path.join(PUB, 'i18n.js'), 'utf8');
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const map = {
    'zh-CN': JSON.parse(fs.readFileSync(path.join(PUB, 'i18n/zh-CN.json'), 'utf8')),
    en: JSON.parse(fs.readFileSync(path.join(PUB, 'i18n/en.json'), 'utf8')),
    'zh-TW': JSON.parse(fs.readFileSync(path.join(PUB, 'i18n/zh-TW.json'), 'utf8'))
  };

  console.log('加载真实 index.html（' + html.length + ' 字节）…');
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:7098/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const win = dom.window;
  // jsdom 默认 navigator.language = 'en-US'，固定成中文避免初始化就跳英文
  Object.defineProperty(win.navigator, 'language', { value: 'zh-CN', configurable: true });
  Object.defineProperty(win.navigator, 'browserLanguage', { value: 'zh-CN', configurable: true });

  win.fetch = function (url) {
    const m = /\/i18n\/([^?]+)\.json/.exec(String(url));
    const lang = m ? m[1] : '';
    if (!map[lang]) return Promise.reject(new Error('no pack ' + lang));
    return Promise.resolve({ ok: true, json: () => Promise.resolve(map[lang]) });
  };
  win.localStorage.setItem('ec9.lang', 'zh-CN');

  const errs = [];
  win.addEventListener('error', (e) => errs.push('window.error: ' + (e.error && e.error.stack || e.message)));
  const origErr = win.console.error;
  win.console.error = function () { errs.push('console.error: ' + Array.from(arguments).join(' ')); };

  console.log('注入 i18n.js…');
  try {
    win.eval(i18nSrc);
  } catch (e) {
    console.log('\n✗ i18n.js 执行抛异常：\n' + (e.stack || e));
    process.exit(2);
  }

  const I18N = win.I18N;
  check('I18N 全局已挂载', !!I18N);
  if (!I18N) { console.log('脚本没跑起来，后续无从测'); process.exit(2); }

  const doc = win.document;
  const $ = (id) => doc.getElementById(id);
  const txt = (id) => ($(id) ? $(id).textContent.replace(/\s+/g, ' ').trim() : '<missing>');

  // 等 init 完成
  await new Promise(r => setTimeout(r, 200));

  console.log('\n[1] 初始化');
  check('无 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));
  check('当前语言 = zh-CN', I18N.getLang() === 'zh-CN', I18N.getLang());
  const sw = $('langSwitcher');
  check('#langSwitcher 存在', !!sw);
  const segBtns = doc.querySelectorAll('.i18n-seg-btn');
  check('切换器渲染出按钮', segBtns.length > 0, '找到 ' + segBtns.length + ' 个');
  const langs = Array.from(segBtns).map(b => b.getAttribute('data-lang'));
  check('三语按钮齐全', ['zh-CN', 'zh-TW', 'en'].every(l => langs.includes(l)), langs.join(','));

  // 抓一批有 data-i18n 的元素作为观察点
  const owned = Array.from(doc.querySelectorAll('[data-i18n]')).slice(0, 40);
  check('页面存在 data-i18n 元素', owned.length > 0, String(owned.length));
  const snapOwned = () => owned.map(el => el.textContent.replace(/\s+/g, ' ').trim());

  const base = snapOwned();

  const switchTo = (lang) => I18N.setLang(lang).then(() => new Promise(r => setTimeout(r, 80)));
  const isAscii = (arr) => arr.filter(s => s && /[A-Za-z]/.test(s) && !/[\u4e00-\u9fff]/.test(s)).length;

  console.log('\n[2] zh-CN → en');
  await switchTo('en');
  check('当前语言 = en', I18N.getLang() === 'en', I18N.getLang());
  let s = snapOwned();
  const enSnap = s.slice();
  console.log('     样例: ' + s.slice(0, 4).map((v, i) => base[i] + '→' + v).join(' | '));
  check('★ data-i18n 元素已变英文', isAscii(s) > s.length * 0.5, '英文占比 ' + isAscii(s) + '/' + s.length);
  check('★ 无脚本异常', errs.length === 0, errs.slice(0, 2).join(' | '));

  console.log('\n[3] en → zh-TW（直切，问题路径）');
  await switchTo('zh-TW');
  check('当前语言 = zh-TW', I18N.getLang() === 'zh-TW', I18N.getLang());
  s = snapOwned();
  console.log('     样例: ' + s.slice(0, 4).join(' | '));
  check('★ data-i18n 元素未卡在英文', isAscii(s) < s.length * 0.4, '仍英文 ' + isAscii(s) + '/' + s.length);
  check('★ 无脚本异常', errs.length === 0, errs.slice(0, 2).join(' | '));
  const twSnap = s.slice();

  console.log('\n[4] zh-TW → zh-CN');
  await switchTo('zh-CN');
  s = snapOwned();
  let mismatch = 0; const mm = [];
  for (let i = 0; i < base.length; i++) if (s[i] !== base[i]) { mismatch++; if (mm.length < 3) mm.push(base[i] + '→' + s[i]); }
  check('★ 全部回到初始中文', mismatch === 0, mismatch + ' 处不一致: ' + mm.join(' ; '));
  check('★ 无脚本异常', errs.length === 0, errs.slice(0, 2).join(' | '));

  console.log('\n[5] 三语连续快速切换 6 次（模拟连点）');
  const seq = ['en', 'zh-TW', 'en', 'zh-CN', 'zh-TW', 'zh-CN'];
  for (const l of seq) { await switchTo(l); }
  s = snapOwned();
  check('★ 连点后最终停在中文', I18N.getLang() === 'zh-CN', I18N.getLang());
  mismatch = 0;
  for (let i = 0; i < base.length; i++) if (s[i] !== base[i]) mismatch++;
  check('★ 连点后文案与初始一致', mismatch === 0, mismatch + ' 处不一致');
  check('★ 连点无脚本异常', errs.length === 0, errs.slice(0, 2).join(' | '));

  console.log('\n[6] 重复切换同一语言（幂等）');
  await switchTo('en');
  await switchTo('en');
  s = snapOwned();
  check('★ 重复切 en 结果稳定', isAscii(s) > s.length * 0.5, '英文占比 ' + isAscii(s) + '/' + s.length);
  await switchTo('zh-TW');
  s = snapOwned();
  check('★ 重复路径 zh-TW 结果稳定', JSON.stringify(s) === JSON.stringify(twSnap),
    '与首次 zh-TW 快照不同');

  console.log('\n[7] 切换器高亮跟随');
  const active = Array.from(doc.querySelectorAll('.i18n-seg-btn')).filter(b => b.classList.contains('active'));
  check('仅一个高亮', active.length === 1, String(active.length));
  check('高亮为 zh-TW', active.length === 1 && active[0].getAttribute('data-lang') === 'zh-TW',
    active.map(a => a.getAttribute('data-lang')).join(','));

  console.log('\n[8] 切走后再切回（最后一轮）');
  await switchTo('zh-CN');
  s = snapOwned();
  mismatch = 0;
  for (let i = 0; i < base.length; i++) if (s[i] !== base[i]) mismatch++;
  check('★ 收尾回到中文', mismatch === 0, mismatch + ' 处不一致');

  win.console.error = origErr;
  if (errs.length) {
    console.log('\n捕获到的异常：');
    errs.slice(0, 8).forEach(e => console.log('   ! ' + e));
  }

  console.log('\n========================================');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('   - ' + f)); }
  console.log('========================================');
  process.exit(fail ? 1 : 0);
}

run().catch(e => { console.error('测试异常:', e && e.stack || e); process.exit(2); });
