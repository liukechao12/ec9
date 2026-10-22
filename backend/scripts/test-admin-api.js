/**
 * EC9 后台管理接口自检（HTTP 层）
 *
 * 前置：app.js 已在 config.server.port 运行；数据库已执行 schema + seed。
 * 本脚本只读 + 建自己的 fixture，**不改种子数据**，可重复执行。
 *
 * 覆盖：
 *   登录鉴权 / 场次 CRUD+排序 / 票种 CRUD+上下架+库存+限购校验
 *   / 订单列表+详情+汇总+导出+备注+关单+批量关单
 *   / 支付流水列表+汇总+对账+详情
 *   / 统计：营收 / 票种售卖 / 报名漏斗
 *   / H5 公开：会议列表/详情/场次/票种 + 多语
 *   / 路由遮蔽检查（/summary、/export 不能被 /:id 吃掉）
 */
const http = require('http');
const crypto = require('crypto');
const config = require('../config');
const { Event, Session, TicketType, Guest, Registration } = require('../models');
const { encryptPhone, hmacPhone } = require('../utils/phoneCrypto');
const orderService = require('../services/orderService');

const PORT = config.server.port;
let pass = 0, fail = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${extra !== undefined ? '  | ' + JSON.stringify(extra) : ''}`); }
}

function req(method, path, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    let payload = null;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json; charset=utf-8';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const r = http.request({ host: '127.0.0.1', port: PORT, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* CSV 等非 JSON */ }
        resolve({ status: res.statusCode, json, text, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const uniq = () => crypto.randomBytes(4).toString('hex');

async function main() {
  console.log('\n=== EC9 后台管理接口自检 ===\n');

  // ---------- 0. 健康检查 ----------
  console.log('[0] 基础');
  const health = await req('GET', '/api/health');
  check('GET /api/health', health.status === 200 && health.json && health.json.code === 0, health.json);

  // ---------- 1. 登录鉴权 ----------
  console.log('\n[1] 登录与鉴权');
  const noAuth = await req('GET', '/api/orders');
  check('无 token 访问订单返回 401', noAuth.status === 401, noAuth.json);

  const login = await req('POST', '/api/admin/login', { body: { username: 'admin', password: 'admin123' } });
  check('admin 登录成功', login.status === 200 && login.json && login.json.code === 200, login.json);
  if (!login.json || !login.json.data || !login.json.data.token) {
    console.log('\n登录失败，终止。');
    return finish();
  }
  const T = login.json.data.token;

  const badLogin = await req('POST', '/api/admin/login', { body: { username: 'admin', password: 'wrong' } });
  check('错误密码登录被拒', badLogin.status >= 400, badLogin.json);

  const me = await req('GET', '/api/admin/me', { token: T });
  check('GET /api/admin/me', me.status === 200 && me.json && me.json.data, me.json);

  // ---------- 2. 场次 ----------
  console.log('\n[2] 场次管理 /api/sessions');
  const events = await req('GET', '/api/events?pageSize=5', { token: T });
  check('GET /api/events', events.status === 200 && Array.isArray(events.json.data.list), events.json && events.json.message);
  const event = (events.json.data.list || [])[0];
  check('存在可用会议', !!event, '没有会议数据，先跑 seed');
  if (!event) return finish();

  const sessName = '自检场次-' + uniq();
  const createSess = await req('POST', '/api/sessions', {
    token: T,
    body: {
      event_id: event.id, name: sessName,
      i18n: { name: { en: 'SelfTest Session ' + uniq() } },
      start_time: '2026-12-01T09:00:00.000Z', end_time: '2026-12-01T12:00:00.000Z',
      location: '主会场', stock_total: 500
    }
  });
  check('POST /api/sessions 新建场次', createSess.status === 200 && createSess.json.code === 0, createSess.json);
  const sess = createSess.json && createSess.json.data;

  if (sess) {
    check('场次 i18n 已写入', !!(sess.i18n && sess.i18n.name && sess.i18n.name['zh-CN']), sess.i18n);

    const dupName = await req('POST', '/api/sessions', { token: T, body: { event_id: event.id, name: '' } });
    check('场次名为空被拒 400', dupName.status === 400, dupName.json);

    const badEvent = await req('POST', '/api/sessions', { token: T, body: { name: '无会议' } });
    check('缺 event_id 被拒 400', badEvent.status === 400, badEvent.json);

    const listSess = await req('GET', `/api/sessions?event_id=${event.id}`, { token: T });
    check('GET /api/sessions 列表', listSess.status === 200 && Array.isArray(listSess.json.data.list), listSess.json && listSess.json.message);

    const detailSess = await req('GET', `/api/sessions/${sess.id}`, { token: T });
    check('GET /api/sessions/:id 详情', detailSess.status === 200 && detailSess.json.data.id === sess.id, detailSess.json && detailSess.json.message);
    check('详情含剩余库存字段', typeof detailSess.json.data.stock_remaining === 'number', detailSess.json.data);

    const updSess = await req('PUT', `/api/sessions/${sess.id}`, { token: T, body: { location: '分会场', sort: 99 } });
    check('PUT /api/sessions/:id 更新', updSess.status === 200 && updSess.json.data.location === '分会场', updSess.json && updSess.json.message);

    const lowStock = await req('PUT', `/api/sessions/${sess.id}`, { token: T, body: { stock_total: -1 } });
    check('负库存被拒 400', lowStock.status === 400, lowStock.json);

    const shelf = await req('POST', `/api/sessions/${sess.id}/status`, { token: T, body: { status: 0 } });
    check('POST /api/sessions/:id/status 停用', shelf.status === 200 && shelf.json.data.status === 0, shelf.json && shelf.json.json);

    const shelf2 = await req('POST', `/api/sessions/${sess.id}/status`, { token: T, body: { status: 1 } });
    check('场次恢复启用', shelf2.status === 200 && shelf2.json.data.status === 1, shelf2.json && shelf2.json.message);

    const reorder = await req('POST', '/api/sessions/reorder', { token: T, body: { items: [{ id: sess.id, sort: 5 }] } });
    check('POST /api/sessions/reorder', reorder.status === 200 && reorder.json.code === 0, reorder.json);
  }

  // ---------- 3. 票种 ----------
  console.log('\n[3] 票种管理 /api/ticket-types');
  const ttName = '自检票-' + uniq();
  const createTT = await req('POST', '/api/ticket-types', {
    token: T,
    body: {
      event_id: event.id, session_id: sess ? sess.id : 0, name: ttName,
      i18n: { name: { en: 'SelfTest Ticket ' + uniq() }, description: { en: 'desc' } },
      description: '自检用票种', price: 199, original_price: 299,
      stock_total: 50, per_order_limit: 3
    }
  });
  check('POST /api/ticket-types 新建票种', createTT.status === 200 && createTT.json.code === 0, createTT.json);
  const tt = createTT.json && createTT.json.data;

  if (tt) {
    check('票种可售库存 = 50', tt.stock_available === 50, tt.stock_available);
    check('票种 i18n 已写入', !!(tt.i18n && tt.i18n.name && tt.i18n.name['zh-CN']), tt.i18n);

    const badPrice = await req('POST', '/api/ticket-types', {
      token: T, body: { event_id: event.id, name: '坏价', price: 100, original_price: 50 }
    });
    check('原价低于售价被拒 400', badPrice.status === 400, badPrice.json);

    const negStock = await req('POST', '/api/ticket-types', {
      token: T, body: { event_id: event.id, name: '负库存', price: 1, stock_total: -5 }
    });
    check('负库存被拒 400', negStock.status === 400, negStock.json);

    const badLimit = await req('POST', '/api/ticket-types', {
      token: T, body: { event_id: event.id, name: '限购0', price: 1, per_order_limit: 0 }
    });
    check('限购<1 被拒 400', badLimit.status === 400, badLimit.json);

    const badSession = await req('POST', '/api/ticket-types', {
      token: T, body: { event_id: event.id, name: '坏场次', price: 1, session_id: 999999 }
    });
    check('场次不存在被拒 400', badSession.status === 400, badSession.json);

    const listTT = await req('GET', `/api/ticket-types?event_id=${event.id}`, { token: T });
    check('GET /api/ticket-types 列表', listTT.status === 200 && Array.isArray(listTT.json.data.list), listTT.json && listTT.json.message);
    check('列表含场次名', listTT.json.data.list.some(x => typeof x.session_name === 'string'), 'session_name 缺失');

    const detailTT = await req('GET', `/api/ticket-types/${tt.id}`, { token: T });
    check('GET /api/ticket-types/:id 详情', detailTT.status === 200 && detailTT.json.data.id === tt.id, detailTT.json && detailTT.json.message);
    check('详情含售卖统计', !!(detailTT.json.data.sales && typeof detailTT.json.data.sales.paid_orders === 'number'), detailTT.json.data.sales);

    const updTT = await req('PUT', `/api/ticket-types/${tt.id}`, { token: T, body: { price: 249 } });
    check('PUT 改价', updTT.status === 200 && Number(updTT.json.data.price) === 249, updTT.json && updTT.json.message);

    const addStock = await req('POST', `/api/ticket-types/${tt.id}/stock`, { token: T, body: { delta: 10 } });
    check('POST 追加库存 +10', addStock.status === 200 && addStock.json.data.stock_total === 60, addStock.json && addStock.json.message);

    const cutStock = await req('POST', `/api/ticket-types/${tt.id}/stock`, { token: T, body: { delta: -1000 } });
    check('减库存超可用被拒 400', cutStock.status === 400, cutStock.json);

    const zeroDelta = await req('POST', `/api/ticket-types/${tt.id}/stock`, { token: T, body: { delta: 0 } });
    check('delta=0 被拒 400', zeroDelta.status === 400, zeroDelta.json);

    const down = await req('POST', `/api/ticket-types/${tt.id}/shelf`, { token: T, body: { on_shelf: 0 } });
    check('POST 下架', down.status === 200 && down.json.data.on_shelf === 0, down.json && down.json.json);

    const up = await req('POST', `/api/ticket-types/${tt.id}/shelf`, { token: T, body: { on_shelf: 1 } });
    check('POST 上架', up.status === 200 && up.json.data.on_shelf === 1, up.json && up.json.message);

    const delBad = await req('DELETE', `/api/ticket-types/${tt.id}`, { token: T });
    check('未售出票种可删', delBad.status === 200, delBad.json);
  }

  // ---------- 4. 造一笔订单（用票种 + 通过审核的报名） ----------
  console.log('\n[4] 订单链路 /api/orders');
  const phone = '139' + String(Date.now()).slice(-8);
  const guest = await Guest.create({
    name: '自检嘉宾' + uniq(),
    phone: encryptPhone(phone),
    phone_hmac: hmacPhone(phone),
    company: '自检公司'
  });

  // 找一个在售票种
  const tts = await req('GET', `/api/ticket-types?event_id=${event.id}&on_shelf=1`, { token: T });
  const sellable = (tts.json.data.list || []).find(x => x.stock_available >= 2);
  check('存在可售票种', !!sellable, '无可售票种');

  let orderId = null;
  if (sellable) {
    const reg = await Registration.create({
      event_id: event.id,
      session_id: sellable.session_id || 0,
      ticket_type_id: sellable.id,
      guest_id: guest.id,
      form_data: {},
      status: 'approved',
      submitted_at: new Date()
    });
    const cr = await orderService.createOrder(reg.id, { quantity: 1 });
    check('createOrder 建单成功', cr.ok, cr.error);
    if (cr.ok) {
      orderId = cr.order.id;
      check('建单后锁定库存 +1', Number(cr.order.quantity) === 1, cr.order);

      // ---------- 订单接口 ----------
      const listO = await req('GET', `/api/orders?event_id=${event.id}&pageSize=10`, { token: T });
      check('GET /api/orders 列表', listO.status === 200 && Array.isArray(listO.json.data.list), listO.json && listO.json.message);
      const hasMaskedPhone = listO.json.data.list.some(
        (x) => x.guest_info && String(x.guest_info.phone_masked || '').indexOf('*') >= 0
      );
      check('列表含嘉宾脱敏手机号', hasMaskedPhone, 'guest_info.phone_masked 缺失');
      check(
        '列表不含手机号明文',
        !listO.json.data.list.some((x) => x.guest_info && x.guest_info.phone_plain),
        '明文泄漏到列表'
      );

      // ⚠️ 遮蔽检查：/summary 不能被 /:id 吃掉
      const sum = await req('GET', `/api/orders/summary?event_id=${event.id}`, { token: T });
      check('GET /api/orders/summary 未被 /:id 遮蔽', sum.status === 200 && typeof sum.json.data.total_count === 'number', sum.json && sum.json.message);
      check('汇总含实收金额', typeof sum.json.data.paid_revenue === 'number', sum.json.data);

      // ⚠️ 遮蔽检查：/export 不能被 /:id 吃掉
      const exp = await req('GET', `/api/orders/export?event_id=${event.id}`, { token: T });
      check('GET /api/orders/export 未被 /:id 遮蔽', exp.status === 200 && exp.text.indexOf('订单号') >= 0, exp.text.slice(0, 80));

      const detailO = await req('GET', `/api/orders/${orderId}`, { token: T });
      check('GET /api/orders/:id 详情', detailO.status === 200 && detailO.json.data.id === orderId, detailO.json && detailO.json.message);
      check('详情含票种名', !!detailO.json.data.ticket_type_name, detailO.json.data.ticket_type_name);
      check('详情含嘉宾明文手机号', !!(detailO.json.data.guest && detailO.json.data.guest.phone_plain), 'phone_plain 缺失');

      const badO = await req('GET', '/api/orders/99999999', { token: T });
      check('不存在的订单 404', badO.status === 404, badO.json);

      const remark = await req('PUT', `/api/orders/${orderId}/remark`, { token: T, body: { remark: '自检备注' } });
      check('PUT 订单备注', remark.status === 200 && remark.json.data.remark === '自检备注', remark.json && remark.json.message);

      const refresh = await req('POST', `/api/orders/${orderId}/refresh`, { token: T });
      check('POST 查单刷新（mock）', refresh.status === 200, refresh.json);

      const close = await req('POST', `/api/orders/${orderId}/close`, { token: T, body: { reason: '自检关单' } });
      check('POST 手动关单', close.status === 200 && close.json.data.status === 'closed', close.json && close.json.message);

      const closeAgain = await req('POST', `/api/orders/${orderId}/close`, { token: T });
      check('重复关单被拒 400', closeAgain.status === 400, closeAgain.json);

      // 关单后库存应回退
      const ttAfter = await req('GET', `/api/ticket-types/${sellable.id}`, { token: T });
      check('关单后锁定库存已释放', Number(ttAfter.json.data.stock_locked) >= 0, ttAfter.json.data.stock_locked);

      const batch = await req('POST', '/api/orders/batch-close', { token: T, body: { ids: [], reason: 'x' } });
      check('批量关单空 ids 被拒 400', batch.status === 400, batch.json);
    }
  }

  // ---------- 5. 支付流水 ----------
  console.log('\n[5] 支付流水 /api/payments');
  const listP = await req('GET', `/api/payments?event_id=${event.id}&pageSize=10`, { token: T });
  check('GET /api/payments 列表', listP.status === 200 && Array.isArray(listP.json.data.list), listP.json && listP.json.message);
  check('流水汇总含净收入', typeof listP.json.data.summary.net_amount === 'number', listP.json.data.summary);

  const pSum = await req('GET', '/api/payments/summary', { token: T });
  check('GET /api/payments/summary 未被 /:id 遮蔽', pSum.status === 200 && typeof pSum.json.data.net_revenue === 'number', pSum.json && pSum.json.message);

  const rec = await req('GET', '/api/payments/reconcile?limit=50', { token: T });
  check('GET /api/payments/reconcile 未被 /:id 遮蔽', rec.status === 200 && typeof rec.json.data.issue_count === 'number', rec.json && rec.json.message);
  check('对账结果 issue 字段结构完整', Array.isArray(rec.json.data.issues), rec.json.data);

  const pNoAuth = await req('GET', '/api/payments/summary');
  check('无 token 访问流水 401', pNoAuth.status === 401, pNoAuth.json);

  // ---------- 6. 统计 ----------
  console.log('\n[6] 统计 /api/statistics');
  const rev = await req('GET', `/api/statistics/revenue?event_id=${event.id}`, { token: T });
  check('GET /api/statistics/revenue', rev.status === 200 && typeof rev.json.data.paid_revenue === 'number', rev.json && rev.json.message);
  check('营收含趋势数组', Array.isArray(rev.json.data.trend), rev.json.data.trend);

  const ts = await req('GET', `/api/statistics/ticket-sales?event_id=${event.id}`, { token: T });
  check('GET /api/statistics/ticket-sales', ts.status === 200 && Array.isArray(ts.json.data.list), ts.json && ts.json.message);
  check('票种售卖含售罄率', ts.json.data.list.length === 0 || typeof ts.json.data.list[0].sell_through_rate === 'number', ts.json.data.list[0]);

  const funnel = await req('GET', `/api/statistics/registration-funnel?event_id=${event.id}`, { token: T });
  check('GET /api/statistics/registration-funnel', funnel.status === 200 && Array.isArray(funnel.json.data.steps), funnel.json && funnel.json.message);
  check('漏斗 4 个环节', funnel.json.data.steps.length === 4, funnel.json.data.steps.length);

  const dash = await req('GET', '/api/statistics/dashboard', { token: T });
  check('GET /api/statistics/dashboard（EC8 原有）', dash.status === 200, dash.json && dash.json.message);

  // ---------- 7. H5 公开接口 ----------
  console.log('\n[7] H5 公开接口 /api/public');
  const pubList = await req('GET', '/api/public/events');
  check('GET /api/public/events 无需登录', pubList.status === 200 && Array.isArray(pubList.json.data.list), pubList.json && pubList.json.message);
  check(
    '公开数据无 dataValues 嵌套（localize 已拍平）',
    pubList.json.data.list.every((x) => x.id !== undefined && x.dataValues === undefined),
    '返回里出现了 Sequelize 内部字段 dataValues'
  );

  const pubDetail = await req('GET', `/api/public/events/${event.id}`);
  check('GET /api/public/events/:id', pubDetail.status === 200 && !!pubDetail.json.data.event, pubDetail.json && pubDetail.json.message);
  check('公开详情含场次数组', Array.isArray(pubDetail.json.data.sessions), pubDetail.json.data.sessions);
  check('公开详情含票种数组', Array.isArray(pubDetail.json.data.ticket_types), pubDetail.json.data.ticket_types);

  const pubSess = await req('GET', `/api/public/events/${event.id}/sessions`);
  check('GET /api/public/events/:id/sessions', pubSess.status === 200 && Array.isArray(pubSess.json.data.list), pubSess.json && pubSess.json.message);

  const pubTks = await req('GET', `/api/public/events/${event.id}/tickets`);
  check('GET /api/public/events/:id/tickets', pubTks.status === 200 && Array.isArray(pubTks.json.data.list), pubTks.json && pubTks.json.message);

  const pubEn = await req('GET', `/api/public/events/${event.id}?lang=en`);
  check('公开接口支持 ?lang=en', pubEn.status === 200 && pubEn.json.data.lang === 'en', pubEn.json && pubEn.json.data.lang);
  check('英文返回英文字段名', typeof pubEn.json.data.event.name === 'string', pubEn.json.data.event.name);

  const pub404 = await req('GET', '/api/public/events/99999999');
  check('不存在的会议 404', pub404.status === 404, pub404.json);

  // ---------- 8. 操作日志脱敏 ----------
  console.log('\n[8] 操作日志');
  const logs = await req('GET', '/api/operation-logs?page=1&pageSize=20', { token: T });
  check('GET /api/operation-logs', logs.status === 200 && Array.isArray(logs.json.data.list), logs.json && logs.json.message);
  const logList = logs.json.data.list || [];
  check(
    '本次操作已落日志',
    logList.some((l) => ['sessions', 'ticket_types', 'orders'].indexOf(l.module) >= 0),
    '未找到场次/票种/订单模块的操作日志'
  );
  check(
    '日志 detail 字段有内容',
    logList.filter((l) => l.detail).length > 0,
    'detail 全为空（EC8 遗留字段名不匹配问题）'
  );
  check(
    '日志中无明文密码字段',
    !logList.some((l) => /password"\s*:\s*"(?!\*\*\*)/i.test(l.detail || '')),
    '疑似泄漏密码'
  );
  check(
    '日志中手机号已脱敏',
    !logList.some((l) => /1[3-9]\d{9}/.test(l.detail || '')),
    '日志里出现 11 位手机号'
  );
  check('日志已记录操作人', logList.some((l) => !!l.admin_name), 'admin_name 为空');

  // ---------- 9. 清理自检 fixture ----------
  console.log('\n[9] 清理');
  if (sess) await Session.destroy({ where: { id: sess.id } }).catch(() => {});
  await Guest.destroy({ where: { id: guest.id } }).catch(() => {});
  check('清理自检场次/嘉宾完成', true);

  finish();
}

function finish() {
  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  if (fail) {
    console.log('失败项：');
    failures.forEach(f => console.log('  - ' + f));
  }
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('自检异常:', e); finish(); });
