/**
 * 复现：不经中文中转的三语直切
 *   zh-CN → zh-TW → en   /   zh-CN → en → zh-TW
 * 根因：autoTranslate 只在「切回中文」时还原原文，
 *       节点里存着上一种外语 → zhIndex(简体原文反查) 查不到 → 文案卡死在上一语言。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const PUB = 'D:/ec9/backend/public';

function buildPage() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"></head><body>
  <div id="langSwitcher"></div>
  <div data-i18n="admin.guestName">姓名</div>
  <div id="dyn1">嘉宾管理</div>
  <div id="dyn2">切换语言</div>
  <table><thead><tr><th id="th1">手机号</th></tr></thead></table>
  <input id="ph" placeholder="请输入手机号">
  <button id="btn" title="切换语言">切换语言</button>
  </body></html>`;
}

async function run() {
  const i18nSrc = fs.readFileSync(path.join(PUB, 'i18n.js'), 'utf8');
  const map = {
    'zh-CN': JSON.parse(fs.readFileSync(path.join(PUB, 'i18n/zh-CN.json'), 'utf8')),
    en: JSON.parse(fs.readFileSync(path.join(PUB, 'i18n/en.json'), 'utf8')),
    'zh-TW': JSON.parse(fs.readFileSync(path.join(PUB, 'i18n/zh-TW.json'), 'utf8'))
  };

  let pass = 0, fail = 0;
  const failures = [];
  function check(name, cond, detail) {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
  }

  const dom = new JSDOM(buildPage(), { url: 'http://127.0.0.1:7098/', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.fetch = function (url) {
    const m = /\/i18n\/([^?]+)\.json/.exec(String(url));
    const lang = m ? m[1] : '';
    if (!map[lang]) return Promise.reject(new Error('no pack ' + lang));
    return Promise.resolve({ ok: true, json: () => Promise.resolve(map[lang]) });
  };
  win.eval(i18nSrc);
  const I18N = win.I18N;
  const $ = (id) => win.document.getElementById(id);
  const txt = (id) => ($(id) ? $(id).textContent.trim() : '<missing>');
  const snap = () => ({
    dyn1: txt('dyn1'), dyn2: txt('dyn2'), th1: txt('th1'),
    staticName: win.document.querySelector('[data-i18n="admin.guestName"]').textContent.trim(),
    ph: $('ph').placeholder, btnTitle: $('btn').title
  });
  const sw = (lang) => I18N.setLang(lang).then(() => new Promise(r => setTimeout(r, 30)));

  win.localStorage.setItem('ec9.lang', 'zh-CN');

  console.log('\n[A] zh-CN → zh-TW → en（不经中文中转）');
  await sw('zh-CN');
  await sw('zh-TW');
  const twS = snap();
  console.log('     zh-TW: ' + JSON.stringify(twS));
  check('zh-TW 嘉宾管理=嘉賓管理', twS.dyn1 === '嘉賓管理', twS.dyn1);
  check('zh-TW 姓名属性=嘉賓姓名', twS.staticName === '嘉賓姓名', twS.staticName);
  await sw('en');
  const enS = snap();
  console.log('     en   : ' + JSON.stringify(enS));
  check('★ zh-TW 直切 en：dyn1 已变英文', enS.dyn1 === 'Guest Management', enS.dyn1);
  check('★ zh-TW 直切 en：dyn2 已变英文', /^[A-Za-z]/.test(enS.dyn2), enS.dyn2);
  check('★ zh-TW 直切 en：th1 已变英文', enS.th1 === 'Mobile Number', enS.th1);
  check('★ zh-TW 直切 en：ph 已变英文', enS.ph === 'Please enter the mobile number', enS.ph);
  check('★ zh-TW 直切 en：btn title 已变英文', enS.btnTitle === 'Switch language', enS.btnTitle);

  console.log('\n[B] zh-CN → en → zh-TW（不经中文中转）');
  await sw('zh-CN');
  await sw('en');
  await sw('zh-TW');
  const tw2 = snap();
  console.log('     zh-TW: ' + JSON.stringify(tw2));
  check('★ en 直切 zh-TW：dyn1=嘉賓管理', tw2.dyn1 === '嘉賓管理', tw2.dyn1);
  check('★ en 直切 zh-TW：staticName=嘉賓姓名', tw2.staticName === '嘉賓姓名', tw2.staticName);
  check('★ en 直切 zh-TW：ph 已变繁体', tw2.ph !== 'Please enter the mobile number' && !/^[A-Za-z]/.test(tw2.ph), tw2.ph);

  console.log('\n[C] en → zh-TW → zh-CN 收尾');
  await sw('en');
  await sw('zh-TW');
  await sw('zh-CN');
  const back = snap();
  console.log('     zh-CN: ' + JSON.stringify(back));
  check('★ 最终回中文 dyn1', back.dyn1 === '嘉宾管理', back.dyn1);
  check('★ 最终回中文 ph', back.ph === '请输入手机号', back.ph);

  console.log('\n========================================');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('   - ' + f)); }
  console.log('========================================');
  process.exit(fail ? 1 : 0);
}

run().catch(e => { console.error('测试异常:', e && e.stack || e); process.exit(2); });
