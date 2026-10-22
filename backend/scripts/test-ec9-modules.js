/**
 * EC9 新增四模块的前端冒烟测试
 *
 * 用 jsdom 加载真实 index.html + i18n.js + ec9-modules.js，
 * 注入假的 apiRequest / fetch，然后走「登录 → 切页 → 渲染表格」全流程，
 * 验证：导航有入口、页面容器存在、表格真渲染出行、状态文案跟随语言切换。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const PUB = path.join(__dirname, '..', 'public');
let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

function mkRows(n, fields) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const r = {};
    fields.forEach(f => { r[f] = f + '-' + i; });
    out.push(r);
  }
  return out;
}

/** 假的接口返回，覆盖前端会读到的所有字段 */
function fakeApi(pathname) {
  // 前端 apiRequest 传进来的已是去掉 API_BASE 的相对路径（/sessions、/orders…）
  const p = String(pathname).replace(/^\/api/, '').replace(/\?.*$/, '');
  if (p === '/sessions') {
    return { code: 0, data: { list: [
      { id: 1, name: '上午场', start_time: '2026-11-01T01:00:00.000Z', end_time: '2026-11-01T04:00:00.000Z',
        location: '深圳', capacity: 100, stock_sold: 10, stock_locked: 2, sort: 1, status: 1 },
      { id: 2, name: '下午场', start_time: '2026-11-01T06:00:00.000Z', end_time: '2026-11-01T09:00:00.000Z',
        location: '上海', capacity: 0, stock_sold: 5, stock_locked: 0, sort: 2, status: 0 }
    ], total: 2 } };
  }
  if (p === '/sessions/1') {
    return { code: 0, data: { id: 1, name: '上午场', start_time: '2026-11-01T01:00:00.000Z',
      end_time: '2026-11-01T04:00:00.000Z', location: '深圳', capacity: 100, sort: 1, status: 1 } };
  }
  if (p === '/ticket-types') {
    return { code: 0, data: { list: [
      { id: 1, name: '早鸟票', price: 199.00, stock_total: 500, stock_locked: 3, stock_sold: 20,
        stock_available: 477, session_id: 0, session_name: '全部场次', sale_end: '2026-10-30T15:59:00.000Z',
        sort: 1, on_shelf: 1 },
      { id: 2, name: '全程票', price: 399.00, stock_total: 300, stock_locked: 0, stock_sold: 8,
        stock_available: 292, session_id: 1, session_name: '上午场', sale_end: '2026-11-01T15:59:00.000Z',
        sort: 2, on_shelf: 0 }
    ], total: 2 } };
  }
  if (p === '/ticket-types/1') {
    return { code: 0, data: { id: 1, name: '早鸟票', price: 199.00, stock_total: 500, sort: 1, on_shelf: 1,
      description: '早鸟优惠', i18n: { name: { en: 'Early Bird', 'zh-TW': '早鳥票' } } } };
  }
  if (p === '/orders') {
    return { code: 0, data: { list: [
      { id: 11, order_no: 'EC9-20261101-0001', status: 'paid', quantity: 2, final_amount: 398.00,
        ticket_type_name: '早鸟票', session_name: '上午场', created_at: '2026-10-20T03:00:00.000Z',
        guest_info: { name: '张三', phone_masked: '138****8000' } },
      { id: 12, order_no: 'EC9-20261101-0002', status: 'pending_payment', quantity: 1, final_amount: 199.00,
        ticket_type_name: '全程票', session_name: '全部场次', created_at: '2026-10-21T03:00:00.000Z',
        guest_info: { name: '李四', phone_masked: '139****9000' } }
    ], total: 2 },
      summary: { total: 2, paid_count: 1, pending_count: 1, sum_amount: 398.00 } };
  }
  if (p === '/orders/11') {
    return { code: 0, data: { id: 11, order_no: 'EC9-20261101-0001', status: 'paid', quantity: 2,
      final_amount: 398.00, ticket_type_name: '早鸟票', session_name: '上午场',
      created_at: '2026-10-20T03:00:00.000Z', paid_at: '2026-10-20T03:05:00.000Z', remark: 'VIP',
      guest: { name: '张三', company: '某公司', phone_masked: '138****8000' },
      payment: { transaction_id: 'WX1234567890' },
      checkin_code: { code: 'CHK-001', status: 0 } } };
  }
  if (p === '/payments') {
    return { code: 0, data: { list: [
      { id: 21, out_trade_no: 'EC9-20261101-0001', amount: 398.00, channel: 'wechat', status: 'success',
        transaction_id: 'WX1234567890', paid_at: '2026-10-20T03:05:00.000Z', created_at: '2026-10-20T03:04:00.000Z',
        order_id: 11, guest_name: '张三', guest_phone_masked: '138****8000' },
      { id: 22, out_trade_no: 'EC9-20261101-0002', amount: 199.00, channel: 'wechat', status: 'created',
        transaction_id: null, created_at: '2026-10-21T03:00:00.000Z', order_id: 12,
        guest_name: '李四', guest_phone_masked: '139****9000' }
    ], total: 2 },
      summary: { total: 2, success_count: 1, success_amount: 398.00 } };
  }
  if (p === '/payments/21') {
    return { code: 0, data: { id: 21, out_trade_no: 'EC9-20261101-0001', amount: 398.00, channel: 'wechat',
      status: 'success', transaction_id: 'WX1234567890', created_at: '2026-10-20T03:04:00.000Z',
      paid_at: '2026-10-20T03:05:00.000Z', order_id: 11, guest_name: '张三',
      guest_phone_masked: '138****8000', notify_raw: { return_code: 'SUCCESS', result_code: 'SUCCESS' } } };
  }
  if (p === '/payments/reconcile') {
    return { code: 0, data: { checked: 2, issue_count: 1, error_count: 1, warn_count: 0,
      issues: [{ type: 'amount_mismatch', level: 'error', payment_id: 22, message: '流水金额与订单实付不一致' }] } };
  }
  if (p === '/events') {
    return { code: 0, data: { list: [{ id: 1, name: 'EC9 大会' }] } };
  }
  return { code: 0, data: { list: [] } };
}

async function run() {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const i18nSrc = fs.readFileSync(path.join(PUB, 'i18n.js'), 'utf8');
  const modSrc = fs.readFileSync(path.join(PUB, 'ec9-modules.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
  const packs = {
    'zh-CN': JSON.parse(fs.readFileSync(path.join(PUB, 'i18n/zh-CN.json'), 'utf8')),
    en: JSON.parse(fs.readFileSync(path.join(PUB, 'i18n/en.json'), 'utf8')),
    'zh-TW': JSON.parse(fs.readFileSync(path.join(PUB, 'i18n/zh-TW.json'), 'utf8'))
  };

  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:7098/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    // ⚠️ jsdom 默认 navigator.language = 'en-US'，
    //    i18n 的 detect() 会据此判定英文环境 —— 这是**正确行为**，
    //    但会让「初始应为中文」的断言失真。这里显式钉成中文，
    //    想要测默认英文态就把它改成 en-US。
    ...{}
  });
  Object.defineProperty(dom.window.navigator, 'language', { value: 'zh-CN', configurable: true });
  const win = dom.window;
  const doc = win.document;
  // called 必须在页面上下文里建，apiRequest 桩才能访问到
  win.__called = [];
  const called = win.__called;

  // 只注入本测试需要的依赖，不执行整个 app.js（它有大量无关副作用）
  win.fetch = (url) => {
    const m = /\/i18n\/([^?]+)\.json/.exec(String(url));
    if (m && packs[m[1]]) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(packs[m[1]]) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ code: 0, data: {} }) });
  };
  win.eval(i18nSrc);

  // app.js 依赖的最小桩
  win.eval(`
    var API_BASE = '';
    var currentToken = 'test-token';
    var currentUser = { role: 'admin', username: 'admin', name: '管理员' };
    function formatDateTime(d){ if(!d) return '-'; var x=new Date(d);
      var p=function(n){return n<10?'0'+n:n;};
      return x.getFullYear()+'-'+p(x.getMonth()+1)+'-'+p(x.getDate())+' '+p(x.getHours())+':'+p(x.getMinutes()); }
    function formatDate(d){ return formatDateTime(d); }
    function formatDateShort(d){ return formatDateTime(d); }
    function apiRequest(url){ window.__called.push(url); return Promise.resolve(window.__fakeApi(url)); }
    window.__fakeApi = null;
    function handleLogout(){}
    window.confirm = function(){ return true; };
    window.alert = function(m){ window.__alerts = window.__alerts || []; window.__alerts.push(m); };
    window.prompt = function(){ return '10'; };
  `);
  win.__fakeApi = fakeApi;
  win.eval(modSrc);
  // 让 apiRequest 能读到桩（modSrc 里的模块函数在页面全局作用域）

  const $ = (id) => doc.getElementById(id);
  const txt = (id) => ($(id) ? $(id).textContent.replace(/\s+/g, ' ').trim() : '');
  const rows = (id) => ($(id) ? $(id).querySelectorAll('tr') : []);

  console.log('\n[1] 导航与页面容器');
  ['sessions', 'ticket-types', 'orders', 'payments'].forEach(p => {
    check(`导航有「${p}」入口`, !!doc.querySelector(`.nav-item[data-page="${p}"]`));
    check(`页面容器 #${p} 存在`, !!$(p) && $(p).classList.contains('content-page'));
  });
  check('pageTitles 含四个新页面',
    ['sessions', 'ticket-types', 'orders', 'payments'].every(p => {
      const m = appSrc.match(/const pageTitles = \{([\s\S]*?)\};/);
      return m && m[1].includes(`${p === 'ticket-types' ? "'ticket-types'" : p}:`);
    }));
  check('switchPage 有四个新分支',
    ["case 'sessions'", "case 'ticket-types'", "case 'orders'", "case 'payments'"]
      .every(c => appSrc.includes(c)));
  check('index.html 引入了 ec9-modules.js', html.includes('ec9-modules.js'));
  check('ec9-modules.js 排在 app.js 之后',
    html.indexOf('ec9-modules.js') > html.indexOf('app.js'));

  console.log('\n[2] 场次页渲染');
  await win.loadSessions();
  await new Promise(r => setTimeout(r, 40));
  check('场次表渲染出 2 行', rows('sessionTableBody').length === 2, String(rows('sessionTableBody').length));
  check('场次名显示', txt('sessionTableBody').includes('上午场'));
  check('不限容量显示「不限」', txt('sessionTableBody').includes('不限'), txt('sessionTableBody'));
  check('调了 /sessions 接口', called.some(u => u.startsWith('/sessions')));

  console.log('\n[3] 票种页渲染');
  await win.loadTicketTypes();
  await new Promise(r => setTimeout(r, 40));
  check('票种表渲染出 2 行', rows('ticketTypeTableBody').length === 2, String(rows('ticketTypeTableBody').length));
  check('票种名显示', txt('ticketTypeTableBody').includes('早鸟票'));
  check('价格格式化含 ¥', txt('ticketTypeTableBody').includes('¥'));
  check('使用后端给的 stock_available', txt('ticketTypeTableBody').includes('477'));
  check('票种状态显示正确',
    txt('ticketTypeTableBody').includes('上架') && txt('ticketTypeTableBody').includes('下架'),
    txt('ticketTypeTableBody'));

  console.log('\n[4] 订单页渲染');
  await win.loadOrders(1, 20);
  await new Promise(r => setTimeout(r, 40));
  check('订单表渲染出 2 行', rows('orderTableBody').length === 2, String(rows('orderTableBody').length));
  check('订单号显示', txt('orderTableBody').includes('EC9-20261101-0001'));
  check('参会人显示', txt('orderTableBody').includes('张三'));
  check('手机号脱敏显示', txt('orderTableBody').includes('138****8000'));
  check('不泄漏明文手机号', !txt('orderTableBody').includes('13812348000'));
  check('统计卡：已支付金额', txt('orderStatAmount').includes('398'));
  check('统计卡：订单总数', txt('orderStatTotal') === '2', txt('orderStatTotal'));
  check('分页已渲染', !!$('orderPagination') && $('orderPagination').innerHTML.includes('条记录'));

  console.log('\n[5] 支付页渲染');
  await win.loadPayments(1, 20);
  await new Promise(r => setTimeout(r, 40));
  check('支付表渲染出 2 行', rows('paymentTableBody').length === 2, String(rows('paymentTableBody').length));
  check('商户订单号显示', txt('paymentTableBody').includes('EC9-20261101-0001'));
  check('微信交易号显示', txt('paymentTableBody').includes('WX1234567890'));
  check('统计卡：成功金额', txt('payStatAmount').includes('398'));

  console.log('\n[6] 切英文后表格文案跟随（关键：状态映射必须惰性求值）');
  await win.I18N.setLang('en');
  await new Promise(r => setTimeout(r, 60));
  await win.loadOrders(1, 20);
  await new Promise(r => setTimeout(r, 40));
  const enOrders = txt('orderTableBody');
  check('订单状态变英文 Paid', enOrders.includes('Paid'), enOrders.substring(0, 200));
  check('订单状态变英文 Awaiting Payment', enOrders.includes('Awaiting Payment'));
  check('无残留中文状态', !enOrders.includes('待付款') && !enOrders.includes('已支付'), enOrders);
  check('页面表头变英文', txt('orderStatAmount') !== '' && $('orderStatTotal').closest('.stat-mini-card')
    .querySelector('[data-i18n]').textContent === 'Total Orders');

  await win.loadTicketTypes();
  await new Promise(r => setTimeout(r, 40));
  check('票种状态变英文 Listed', txt('ticketTypeTableBody').includes('Listed'));
  const ttHead = $('ticket-types').querySelectorAll('thead')[0];
  check('票种表头变英文', ttHead && ttHead.textContent.includes('Ticket Type Name'),
    ttHead ? ttHead.textContent.replace(/\s+/g, ' ').trim() : 'no thead');

  console.log('\n[7] 切回中文（回归：不能只切一次）');
  await win.I18N.setLang('zh-CN');
  await new Promise(r => setTimeout(r, 60));
  await win.loadOrders(1, 20);
  await new Promise(r => setTimeout(r, 40));
  check('★ 订单状态回到中文 已支付', txt('orderTableBody').includes('已支付'));
  check('★ 票种状态前一次英文现回中文', (await (async () => {
    await win.loadTicketTypes(); await new Promise(r => setTimeout(r, 40));
    return txt('ticketTypeTableBody').includes('上架');
  })()) === true);
  check('★ 表头回到中文 订单号', txt('orderTableBody').includes('EC9-20261101-0001'));

  console.log('\n[8] 对账');
  await win.runReconcile();
  await new Promise(r => setTimeout(r, 60));
  check('对账后差异数 > 0', txt('payStatDiff') !== '0', txt('payStatDiff'));
  check('对账结果标注到表格', txt('paymentTableBody').includes('流水金额与订单实付不一致'));

  console.log('\n[9] XSS 防护');
  const xss = fakeApi('/api/orders');
  xss.data.list[0].guest_info.name = '<img src=x onerror=alert(1)>';
  win.__fakeApi = (p) => (p.startsWith('/orders?') || p === '/orders') ? xss : fakeApi(p);
  await win.loadOrders(1, 20);
  await new Promise(r => setTimeout(r, 40));
  check('恶意昵称被转义（未注入 img 标签）',
    !$('orderTableBody').querySelector('img') && txt('orderTableBody').includes('<img src=x'));

  console.log('\n[10] ec9T 兜底：i18n 不可用时不崩表');
  // 模拟 i18n.js 挂了 / t 未定义
  win.eval('window.__t_backup = window.t; window.t = undefined;');
  await win.loadTicketTypes();
  await new Promise(r => setTimeout(r, 40));
  check('t 不可用时票种表仍渲染出行', rows('ticketTypeTableBody').length === 2, String(rows('ticketTypeTableBody').length));
  check('★ t 不可用时回退中文「票种名称」等表头',
    $('ticketTypeTableBody').textContent.includes('早鸟票'));
  check('★ 表头回退中文（不显示 ec9.xxx key）',
    !doc.body.textContent.includes('ec9.tt.title'), '页面漏出了 key');
  win.eval('window.t = window.__t_backup;');
  await win.loadTicketTypes();
  await new Promise(r => setTimeout(r, 40));
  check('恢复 t 后渲染正常', rows('ticketTypeTableBody').length === 2);

  console.log('\n========================================');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('   - ' + f)); }
  console.log('========================================');
  process.exit(fail ? 1 : 0);
}

run().catch(e => { console.error('测试异常:', e && e.stack || e); process.exit(2); });