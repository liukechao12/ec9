/**
 * i18n 语言来回切换回归测试（jsdom）
 * 覆盖：zh→en→zh→en→zh、zh↔zh-TW、属性还原、动态新增内容
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const PUB = 'D:/ec9/backend/public';

function buildPage() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"></head><body>
  <div id="langSwitcher"></div>

  <!-- 有 data-i18n 的静态文案 -->
  <div data-i18n="admin.guestName">姓名</div>
  <div data-i18n="common.switchLanguage">切换语言</div>

  <!-- 无 data-i18n 的动态文案（只能靠 autoTranslate 反查） -->
  <div id="dyn1">嘉宾管理</div>
  <div id="dyn2">报名信息</div>
  <table><thead><tr><th id="th1">手机号</th><th id="th2">操作</th></tr></thead></table>

  <!-- 属性里的中文 -->
  <input id="ph" placeholder="请输入手机号">
  <button id="btn" title="切换语言">切换语言</button>

  <!-- 业务后续写入的内容（不应被还原逻辑破坏） -->
  <div id="live">占位</div>
  </body></html>`;
}

async function run() {
  const i18nSrc = fs.readFileSync(path.join(PUB, 'i18n.js'), 'utf8');
  const zh = JSON.parse(fs.readFileSync(path.join(PUB, 'i18n/zh-CN.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(PUB, 'i18n/en.json'), 'utf8'));
  const tw = JSON.parse(fs.readFileSync(path.join(PUB, 'i18n/zh-TW.json'), 'utf8'));

  let pass = 0, fail = 0;
  const failures = [];
  function check(name, cond, detail) {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
  }

  const dom = new JSDOM(buildPage(), {
    url: 'http://127.0.0.1:7098/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const win = dom.window;

  // 让 fetch 直接读本地语言包，模拟真实加载
  win.fetch = function (url) {
    const m = /\/i18n\/([^?]+)\.json/.exec(String(url));
    const lang = m ? m[1] : '';
    const map = { 'zh-CN': zh, en: en, 'zh-TW': tw };
    if (!map[lang]) return Promise.reject(new Error('no pack ' + lang));
    return Promise.resolve({ ok: true, json: () => Promise.resolve(map[lang]) });
  };

  // 在页面上下文里执行 i18n.js
  win.eval(i18nSrc);

  const I18N = win.I18N;
  const $ = (id) => win.document.getElementById(id);
  const txt = (id) => ($(id) ? $(id).textContent.trim() : '<missing>');

  function snap() {
    return {
      dyn1: txt('dyn1'), dyn2: txt('dyn2'), th1: txt('th1'), th2: txt('th2'),
      staticName: txt('langSwitcher') && win.document.querySelector('[data-i18n="admin.guestName"]').textContent,
      ph: $('ph').placeholder,
      btnTitle: $('btn').title,
      live: txt('live')
    };
  }

  function switchTo(lang) {
    return I18N.setLang(lang).then(() => new Promise(r => setTimeout(r, 30)));
  }

  // 初始：强制从中文开始
  win.localStorage.setItem('ec9.lang', 'zh-CN');

  console.log('\n[1] 初始化到 zh-CN');
  return I18N.setLang('zh-CN').then(() => new Promise(r => setTimeout(r, 60))).then(() => {
    const s = snap();
    check('初始 dyn1 是中文', s.dyn1 === '嘉宾管理', s.dyn1);
    check('初始 ph 是中文', s.ph === '请输入手机号', s.ph);

    console.log('\n[2] 切到 en');
    return switchTo('en').then(() => {
      const s = snap();
      console.log('     ' + JSON.stringify(s));
      const enDyn1 = s.dyn1;
      check('dyn1 已变英文（≠中文）', enDyn1 !== '嘉宾管理', enDyn1);
      check('dyn2 动态文案已变英文', s.dyn2 === 'Registration Information', s.dyn2);
      check('th1 已变英文', s.th1 !== '手机号', s.th1);
      check('ph 已变英文', s.ph !== '请输入手机号', s.ph);
      check('btn title 已变英文', s.btnTitle === 'Switch language', s.btnTitle);

      console.log('\n[3] 切回 zh-CN（这是原来失败的步骤）');
      return switchTo('zh-CN').then(() => {
        const s2 = snap();
        console.log('     ' + JSON.stringify(s2));
        check('★ dyn1 回到中文', s2.dyn1 === '嘉宾管理', s2.dyn1);
        check('★ dyn2 回到中文', s2.dyn2 === '报名信息', s2.dyn2);
        check('★ th1 回到中文', s2.th1 === '手机号', s2.th1);
        check('★ th2 回到中文', s2.th2 === '操作', s2.th2);
        check('★ ph 回到中文', s2.ph === '请输入手机号', s2.ph);
        check('★ btn title 回到中文', s2.btnTitle === '切换语言', s2.btnTitle);
        check('★ 有 data-i18n 的静态文案正确', s2.staticName === '嘉宾姓名', s2.staticName);

        console.log('\n[4] 再切 en，再切回（验证可反复）');
        return switchTo('en').then(() => {
          const s3 = snap();
          check('第二次切 en 生效', s3.dyn1 !== '嘉宾管理', s3.dyn1);
          check('★ 第二次切 en 内容与第一次一致', s3.dyn1 === enDyn1, s3.dyn1 + ' vs ' + enDyn1);
          return switchTo('zh-CN');
        }).then(() => {
          const s4 = snap();
          check('★ 第二次切回中文成功', s4.dyn1 === '嘉宾管理', s4.dyn1);
          check('★ 第二次切回 dyn2 正确', s4.dyn2 === '报名信息', s4.dyn2);

          console.log('\n[5] 三语来回：zh-CN → zh-TW → zh-CN → en');
          return switchTo('zh-TW').then(() => {
            const s5 = snap();
            check('zh-TW 下文本已变化', s5.dyn1 !== '嘉宾管理' && s5.dyn1 !== enDyn1, s5.dyn1);
            return switchTo('zh-CN');
          }).then(() => {
            const s6 = snap();
            check('★ zh-TW 切回中文成功', s6.dyn1 === '嘉宾管理', s6.dyn1);
            check('★ zh-TW 切回 dyn2 成功', s6.dyn2 === '报名信息', s6.dyn2);
            return switchTo('en');
          }).then(() => {
            const s7 = snap();
            check('切回 en 成功', s7.dyn1 === enDyn1, s7.dyn1);
            return switchTo('zh-CN');
          }).then(() => {
            const s8 = snap();
            check('★ 最终回到中文成功', s8.dyn1 === '嘉宾管理', s8.dyn1);
            check('★ 最终 dyn2 中文', s8.dyn2 === '报名信息', s8.dyn2);
            check('★ 最终 ph 中文', s8.ph === '请输入手机号', s8.ph);

            console.log('\n[6] 业务在切换后写入新内容，不应被还原逻辑破坏');
            $('live').textContent = '嘉宾管理';
            return switchTo('en').then(() => {
              const s9 = snap();
              check('切换后新写入的中文被翻译', s9.live !== '嘉宾管理', s9.live);
              return switchTo('zh-CN');
            }).then(() => {
              const s10 = snap();
              check('★ 新写入内容切回后还原', s10.live === '嘉宾管理', s10.live);

              console.log('\n[7] 切换器按钮高亮跟随');
              const btns = win.document.querySelectorAll('.i18n-seg-btn');
              check('切换器渲染了 3 个按钮', btns.length === 3, String(btns.length));
              const active = Array.prototype.filter.call(btns, b => b.classList.contains('active'));
              check('当前仅一个高亮且为 zh-CN', active.length === 1 && active[0].getAttribute('data-lang') === 'zh-CN',
                active.map(a => a.getAttribute('data-lang')).join(','));

              console.log('\n========================================');
              console.log('  通过 ' + pass + ' / 失败 ' + fail);
              if (fail) {
                console.log('  失败项：');
                failures.forEach(f => console.log('   - ' + f));
              }
              console.log('========================================');
              process.exit(fail ? 1 : 0);
            });
          });
        });
      });
    });
  }).catch(e => {
    console.error('测试异常:', e && e.stack || e);
    process.exit(2);
  });
}

run();