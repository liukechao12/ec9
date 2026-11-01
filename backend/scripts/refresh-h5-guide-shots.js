#!/usr/bin/env node
/**
 * 刷新 docs/h5-guide/ 下的 H5 操作指南截图
 *
 * 用法：
 *   1) 先启动本地前端：cd backend && node dev-h5.js
 *   2) 运行：npx -y -p puppeteer-core node scripts/refresh-h5-guide-shots.js
 *
 * 说明：
 *   - 截图基于本地当前前端代码，接口走 dev-h5.js 代理到线上后端
 *   - 少数状态页（个人信息 / 支付 / 电子票）为了稳定出图，会注入演示态本地存储
 */
const fs = require('fs');
const path = require('path');

let puppeteer;
try {
  puppeteer = require('puppeteer-core');
} catch (err) {
  console.error('缺少 puppeteer-core，请用：npx -y -p puppeteer-core node scripts/refresh-h5-guide-shots.js');
  process.exit(1);
}

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = (process.env.H5_BASE || 'http://127.0.0.1:5180/h5/ec9').replace(/\/+$/, '');
const OUT = path.resolve(__dirname, '../../docs/h5-guide/images');
const VIEWPORT = { width: 375, height: 836, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

if (!fs.existsSync(CHROME)) {
  console.error('未找到 Chrome：' + CHROME);
  process.exit(1);
}
if (!fs.existsSync(OUT)) {
  console.error('截图目录不存在：' + OUT);
  process.exit(1);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function clearAndSeed(page, state) {
  await page.goto(BASE + '/index.html?event_id=1&_seed=' + Date.now(), { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (seed) {
    sessionStorage.clear();
    localStorage.removeItem('ec9_data');
    localStorage.removeItem('ec9_lang');
    if (seed && seed.phone) sessionStorage.setItem('ec9_phone', seed.phone);
    if (seed && seed.token) sessionStorage.setItem('ec9_vtoken', seed.token);
    if (seed && seed.lang) localStorage.setItem('ec9_lang', seed.lang);
    if (seed && seed.data) localStorage.setItem('ec9_data', JSON.stringify(seed.data));
  }, state || {});
}

async function goto(page, relativeUrl, opts) {
  const url = BASE + '/' + relativeUrl.replace(/^\//, '');
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  if (opts && opts.waitSelector) await page.waitForSelector(opts.waitSelector, { timeout: 30000 });
  await sleep((opts && opts.waitMs) || 900);
}

async function applyMocks(page, mocks) {
  const list = Array.isArray(mocks) ? mocks : [];
  await page.setRequestInterception(list.length > 0);
  page.removeAllListeners('request');
  if (!list.length) {
    page.on('request', req => req.continue().catch(function () {}));
    return;
  }
  page.on('request', function (req) {
    const hit = list.find(function (m) {
      return req.url().indexOf(m.urlPart) > -1 && (!m.method || req.method() === m.method);
    });
    if (!hit) return req.continue().catch(function () {});
    req.respond({
      status: hit.status || 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(hit.body || { code: 0, message: 'ok', data: {} })
    }).catch(function () {});
  });
}

async function shot(page, fileName, relativeUrl, opts) {
  await applyMocks(page, opts && opts.mocks);
  if (opts && opts.seed) await clearAndSeed(page, opts.seed);
  await goto(page, relativeUrl, opts);
  if (opts && opts.afterLoad) await opts.afterLoad(page);
  await sleep((opts && opts.afterWaitMs) || 400);
  const target = path.join(OUT, fileName);
  await page.screenshot({ path: target, fullPage: opts && opts.fullPage !== false });
  console.log('已生成：' + target);
}

async function fill(page, selector, value) {
  await page.waitForSelector(selector, { timeout: 10000 });
  await page.click(selector, { clickCount: 3 });
  await page.type(selector, value);
}

async function run() {
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: CHROME,
    defaultViewport: VIEWPORT,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-features=Translate']
  });
  const page = await browser.newPage();

  try {
    await shot(page, '01_home.png', 'index.html?event_id=1', {
      waitSelector: '#btnRegister',
      afterLoad: async function (p) {
        await p.evaluate(function () {
          var ck = document.getElementById('agreeCk');
          if (ck && !ck.classList.contains('checked')) ck.classList.add('checked');
        });
      }
    });

    await shot(page, '02_signup.png', 'signup.html?event_id=1', { waitSelector: '#btnNext' });

    await shot(page, '03_profile.png', 'profile.html?event_id=1', {
      seed: {
        phone: '18600028184',
        token: 'doc-token',
        data: { name: '测试', company: '123', position: '132', focus: '13' }
      },
      mocks: [{
        method: 'POST',
        urlPart: '/api/registrations/check-invited',
        body: { code: 0, message: 'ok', data: { invited: {}, need_pay: {} } }
      }],
      waitSelector: '.member-card',
      afterLoad: async function (p) {
        await p.click('#btnAddMember');
        await p.waitForSelector('#memberList .member-card:nth-child(2)', { timeout: 10000 });
        await fill(p, '#memberList .member-card:nth-child(1) .f-name', '测试');
        await fill(p, '#memberList .member-card:nth-child(1) .f-company', '123');
        await fill(p, '#memberList .member-card:nth-child(1) .f-position', '132');
        await fill(p, '#memberList .member-card:nth-child(1) .f-focus', '13');
        await p.select('#memberList .member-card:nth-child(1) .f-session', '0');

        await fill(p, '#memberList .member-card:nth-child(2) .f-name', '张三');
        await fill(p, '#memberList .member-card:nth-child(2) .f-phone', '18600028185');
        await fill(p, '#memberList .member-card:nth-child(2) .f-company', '51WORLD');
        await fill(p, '#memberList .member-card:nth-child(2) .f-position', '产品经理');
        await fill(p, '#memberList .member-card:nth-child(2) .f-focus', '具身智能');
        await p.select('#memberList .member-card:nth-child(2) .f-session', '0');
      },
      afterWaitMs: 1200
    });

    await shot(page, '04_ticket.png', 'ticket.html?event_id=1', {
      seed: {
        phone: '18600028184',
        token: 'doc-token',
        data: {
          draft_members: [
            { id: 1, name: '测试', phone: '18600028184', company: '123', position: '132', inviter: '', focus: '13', session_id: 0, session_all: true },
            { id: 2, name: '张三', phone: '18600028185', company: '51WORLD', position: '产品经理', inviter: '', focus: '具身智能', session_id: 0, session_all: true }
          ]
        }
      },
      waitSelector: '#btnSubmit',
      afterWaitMs: 1500
    });

    await shot(page, '05_result.png', 'result.html?event_id=1&status=pending', {
      waitSelector: '#btnMain'
    });

    await shot(page, '06_pay.png', 'pay.html?event_id=1&reg_id=1', {
      seed: {
        phone: '18600028184',
        token: 'doc-token',
        data: {
          ticket: { name: '标准票', price: 510 },
          order_no: 'EC9179350378676600'
        }
      },
      waitSelector: '#btnPay'
    });

    await shot(page, '07_eticket.png', 'eticket.html?event_id=1', {
      seed: {
        phone: '18600028184',
        data: {
          name: '测试',
          company: '123',
          focus: '13',
          ticket: { name: '标准票' },
          reg_time: '2026-11-01 10:30:00',
          checkin_code: 'EC9-123456',
          status: 'paid',
          paid: true
        }
      },
      waitSelector: '#btnCheckin'
    });

    await shot(page, '08_checkin_ok.png', 'result.html?event_id=1&type=checkin&status=success', {
      waitSelector: '#btnMain'
    });

    await shot(page, '09_lang.png', 'index.html?event_id=1', {
      waitSelector: '#langBtn',
      afterLoad: async function (p) {
        await p.click('#langBtn');
      }
    });

    await shot(page, '10_agreement_user.png', 'agreement.html?tab=user&event_id=1', {
      waitSelector: '.agree-card',
      afterWaitMs: 1800
    });

    await shot(page, '11_agreement_contact.png', 'agreement.html?tab=contact&event_id=1', {
      waitSelector: '.agree-contact',
      afterWaitMs: 1000
    });

    await shot(page, '12_agreement_privacy.png', 'agreement.html?tab=privacy&event_id=1', {
      waitSelector: '.agree-card',
      afterWaitMs: 1800
    });

    await shot(page, '13_invoice.png', 'invoice.html', {
      waitSelector: '#app',
      afterWaitMs: 1000
    });

    await shot(page, '14_home_en.png', 'index.html?event_id=1&lang=en', {
      waitSelector: '#btnRegister',
      afterWaitMs: 1000
    });
  } finally {
    await browser.close();
  }
}

run().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
