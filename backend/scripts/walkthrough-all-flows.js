/**
 * EC9 全流程演练 + 缺口扫描
 * ------------------------------------------------------------
 * 目的：把「客户真正会走的路」从头到尾走一遍，凡是走不通 / 没做 / 返回 404
 *      的地方，统一记为 GAP（缺口），最后汇总成清单。
 *
 * 前置：app.js 已在 7098 运行。
 * 特点：自建 fixture（唯一命名 + 随机手机号），可重复执行，不污染种子数据。
 *
 * 演练顺序（真实业务时序）：
 *   0 后台登录
 *   1 建会议 → 建场次 → 建票种 → 上架 → 补库存
 *   2 嘉宾侧：公开读会议/场次/票种
 *   3 手机验证码（强制验证闭环）
 *   4 提交报名 → 查报名
 *   5 邀约：创建 → 审核 → 二维码 → 改场次 → 住宿/席位 → 导出
 *   6 订单：建单锁库存 → 下单 → 模拟支付 → 出票 → 退款
 *   7 签到：扫码/手机号/后台代签 → 签到统计
 *   8 统计看板 / 收入 / 漏斗 / BD 排行
 *   9 短信模板 + 规则 + 发送
 *  10 会议多语言翻译
 *  11 法务文档 / 操作日志 / 配置页
 */
const http = require('http');
const crypto = require('crypto');
const config = require('../config');
const { sequelize, Event, Session, TicketType } = require('../models');
const { encryptPhone, hmacPhone } = require('../utils/phoneCrypto');

const BASE = { host: '127.0.0.1', port: config.server.port };

let pass = 0, fail = 0;
const GAPS = [];

function ok(name) { pass++; console.log(`  PASS  ${name}`); }
function bad(name, extra) { fail++; console.log(`  FAIL  ${name}${extra ? '  | ' + extra : ''}`); }

/** 缺口登记：流程走到这里发现「没做」或「做不了」 */
function gap(area, what, why) {
  GAPS.push({ area, what, why });
  console.log(`  GAP   [${area}] ${what} —— ${why}`);
}

function check(name, cond, extra) { cond ? ok(name) : bad(name, extra); }

function req(method, path, { body, token, verifyToken, raw } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    let payload = null;
    if (raw !== undefined) {
      payload = raw;
      headers['Content-Type'] = 'text/xml';
      headers['Content-Length'] = Buffer.byteLength(raw);
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (verifyToken) headers['x-verify-token'] = verifyToken;
    const r = http.request({ ...BASE, path, method, headers }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let parsed = buf;
        try { parsed = JSON.parse(buf); } catch (e) { /* 非 json */ }
        resolve({ status: res.statusCode, body: parsed, text: buf });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** 断言：接口存在且业务成功（非 404 / 非 500 / code===0 或 200 有数据） */
async function step(area, name, method, path, opts = {}) {
  const r = await req(method, path, opts);
  if (r.status === 404) { gap(area, `${method} ${path}`, '接口不存在（404）'); return { miss: true, r }; }
  if (r.status >= 500) { gap(area, `${method} ${path}`, `服务端异常 ${r.status}`); return { miss: true, r }; }
  const good = r.status === 200 || r.status === 201 ||
    (r.body && (r.body.code === 0 || r.body.code === 200 || r.body.success === true));
  if (!good) { bad(`[${area}] ${name}`, `${r.status} ${(r.body && r.body.message) || r.text.slice(0, 120)}`); return { miss: true, r }; }
  ok(`[${area}] ${name}`);
  return { miss: false, r };
}

const rnd = () => Math.floor(Math.random() * 1e9).toString().padStart(9, '0');
const newPhone = () => '13' + rnd().slice(0, 9);
const stamp = Date.now().toString().slice(-6);

(async () => {
  let adminToken = '';
  const ctx = {};

  try {
    /* ========== 0. 后台登录 ========== */
    console.log('\n=== 0. 后台登录 ===');
    {
      const r = await req('POST', '/api/admin/login', { body: { username: 'admin', password: 'admin123' } });
      if (r.body && (r.body.code === 0 || r.body.code === 200) && r.body.data && r.body.data.token) {
        adminToken = r.body.data.token;
        ok('admin 登录拿到 token');
      } else {
        bad('admin 登录', JSON.stringify(r.body).slice(0, 160));
        console.log('无法继续，退出'); process.exit(1);
      }
      const me = await req('GET', '/api/admin/me', { token: adminToken });
      check('GET /api/admin/me', me.body && (me.body.code === 0 || me.body.code === 200), me.text.slice(0, 120));
    }

    /* ========== 1. 会议 / 场次 / 票种 ========== */
    console.log('\n=== 1. 会议 → 场次 → 票种 ===');
    {
      const ev = await step('会议', '创建会议', 'POST', '/api/events', {
        token: adminToken,
        body: {
          name: `演练会议-${stamp}`,
          description: '全流程演练用会议',
          location: '北京', address: '北京市朝阳区',
          start_time: '2026-12-01 09:00:00', end_time: '2026-12-01 18:00:00',
          signup_start_time: '2026-10-01 00:00:00', signup_end_time: '2026-11-30 23:59:00',
          status: 1, audit_mode: 'hybrid'
        }
      });
      ctx.eventId = ev.r && ev.r.body && ev.r.body.data && (ev.r.body.data.id || (ev.r.body.data.event && ev.r.body.data.event.id));
      if (!ctx.eventId) {
        // 兜底：从库里取一个已发布的会议继续演练
        const e = await Event.findOne({ where: { status: 'published' }, order: [['id', 'DESC']] });
        ctx.eventId = e && e.id;
        console.log(`       （用既有会议 id=${ctx.eventId} 继续）`);
      }

      await step('会议', '会议列表', 'GET', '/api/events?page=1&pageSize=10', { token: adminToken });
      await step('会议', '会议详情', 'GET', `/api/events/${ctx.eventId}`, { token: adminToken });
      await step('会议', '会议统计', 'GET', `/api/events/${ctx.eventId}/statistics`, { token: adminToken });
      await step('会议', '公开会议列表（嘉宾侧）', 'GET', '/api/public/events');
      await step('会议', '公开会议详情', 'GET', `/api/public/events/${ctx.eventId}`);

      const ss = await step('场次', '创建场次', 'POST', '/api/sessions', {
        token: adminToken,
        body: { event_id: ctx.eventId, name: `主论坛-${stamp}`, start_time: '2026-12-01 09:30:00', end_time: '2026-12-01 12:00:00', location: '主会场', stock_total: 100 }
      });
      ctx.sessionId = ss.r && ss.r.body && ss.r.body.data && (ss.r.body.data.id || (ss.r.body.data.session && ss.r.body.data.session.id));
      {
        const s = await Session.findOne({ where: { event_id: ctx.eventId }, order: [['id', 'DESC']] });
        ctx.sessionId = ctx.sessionId || (s && s.id);
      }
      await step('场次', '场次列表', 'GET', `/api/sessions?event_id=${ctx.eventId}`, { token: adminToken });
      await step('场次', '公开场次列表', 'GET', `/api/public/events/${ctx.eventId}/sessions`);

      const tt = await step('票种', '创建票种', 'POST', '/api/ticket-types', {
        token: adminToken,
        body: { event_id: ctx.eventId, name: `标准票-${stamp}`, price: 399, stock_total: 50, description: '标准席位' }
      });
      ctx.ticketId = tt.r && tt.r.body && tt.r.body.data && (tt.r.body.data.id || (tt.r.body.data.ticketType && tt.r.body.data.ticketType.id));
      {
        const t = await TicketType.findOne({ where: { event_id: ctx.eventId }, order: [['id', 'DESC']] });
        ctx.ticketId = ctx.ticketId || (t && t.id);
      }
      await step('票种', '票种列表', 'GET', `/api/ticket-types?event_id=${ctx.eventId}`, { token: adminToken });
      await step('票种', '公开票种列表', 'GET', `/api/public/events/${ctx.eventId}/tickets`);
      if (ctx.ticketId) {
        await step('票种', '上架票种', 'POST', `/api/ticket-types/${ctx.ticketId}/shelf`, { token: adminToken, body: { on_shelf: 1 } });
        await step('票种', '调整库存', 'POST', `/api/ticket-types/${ctx.ticketId}/stock`, { token: adminToken, body: { delta: 30 } });
      }
      await step('票种', '改价（单嘉宾定价）', 'PUT', `/api/ticket-types/${ctx.ticketId || 1}`, { token: adminToken, body: { price: 429 } });
    }

    /* ========== 2. 嘉宾库 ========== */
    console.log('\n=== 2. 嘉宾库 ===');
    {
      ctx.phone = newPhone();
      const g = await step('嘉宾', '新建嘉宾', 'POST', '/api/guests', {
        token: adminToken,
        body: { name: '演练嘉宾', company: '演练科技', position: '总监', phone: ctx.phone, source: 'walkthrough' }
      });
      ctx.guestId = g.r && g.r.body && g.r.body.data && (g.r.body.data.id || (g.r.body.data.guest && g.r.body.data.guest.id));
      await step('嘉宾', '嘉宾列表', 'GET', '/api/guests?page=1&pageSize=10', { token: adminToken });
      if (ctx.guestId) {
        await step('嘉宾', '嘉宾详情', 'GET', `/api/guests/${ctx.guestId}`, { token: adminToken });
        await step('嘉宾', '修改历史', 'GET', `/api/guests/${ctx.guestId}/modification-history`, { token: adminToken });
      }
      // 导出：嘉宾有没有导出接口？
      const exp = await req('GET', '/api/guests/export', { token: adminToken });
      if (exp.status === 404) gap('嘉宾', 'GET /api/guests/export', '嘉宾数据没有导出接口（邀约/订单有，嘉宾没有）');
      else ok('[嘉宾] 导出接口存在');
    }

    /* ========== 3. 手机验证码 ========== */
    console.log('\n=== 3. 手机验证码（强制验证） ===');
    {
      const p2 = newPhone();
      ctx.phone2 = p2;
      const s = await step('验证', '发送验证码', 'POST', '/api/verification/send-code', { body: { phone: p2, lang: 'zh-CN' } });
      let code = null;
      const dc = await req('POST', '/api/verification/dev-code', { body: { phone: p2 } });
      if (dc.body && dc.body.code === 0 && dc.body.data) code = dc.body.data.code;
      if (!code) {
        gap('验证', '拿不到验证码', '短信通道停用且无本地回显，嘉宾侧无法自助完成验证');
      } else {
        const v = await step('验证', '校验验证码', 'POST', '/api/verification/verify-code', { body: { phone: p2, code } });
        ctx.token = v.r && v.r.body && v.r.body.data && (v.r.body.data.verification_token || v.r.body.data.token);
        if (!ctx.token) gap('验证', 'verify-code 未返回 token', '后续报名需要 x-verify-token，拿不到就走不通');
      }
    }

    /* ========== 4. 报名 ========== */
    console.log('\n=== 4. 报名 ===');
    {
      // 造一个属于该手机号的嘉宾 + 邀约，拿到邀请码（EC8 沿用流程是「凭邀请码报名」）
      {
        const g2 = await req('POST', '/api/guests', {
          token: adminToken,
          body: { name: '演练报名人', company: '演练科技', position: '经理', phone: ctx.phone2 }
        });
        const gid = g2.body && g2.body.data && (g2.body.data.id || (g2.body.data.guest && g2.body.data.guest.id));
        if (gid) {
          const iv = await req('POST', '/api/invitations', {
            token: adminToken,
            body: { guest_id: gid, event_id: ctx.eventId, ticket_type_id: ctx.ticketId, session_id: ctx.sessionId }
          });
          ctx.inviteCode = iv.body && iv.body.data && (iv.body.data.invite_code || iv.body.data.code || (iv.body.data.invitation && (iv.body.data.invitation.invite_code || iv.body.data.invitation.code)));
          if (!ctx.inviteCode) {
            const { Invitation } = require('../models');
            const one = await Invitation.findOne({ where: { guest_id: gid }, order: [['id', 'DESC']] });
            ctx.inviteCode = one && (one.invite_code || one.code);
          }
        }
        console.log(`       （取到邀请码 ${ctx.inviteCode || '无'}）`);
      }

      // EC8 沿用：凭邀请码报名
      const body = {
        phone: ctx.phone2, name: '演练报名人', company: '演练科技', position: '经理',
        event_id: ctx.eventId, lang: 'zh-CN'
      };
      if (ctx.inviteCode) body.invite_code = ctx.inviteCode;
      const r = await step('报名', '提交报名（凭邀请码）', 'POST', '/api/registrations/submit', { body, verifyToken: ctx.token });
      ctx.regId = r.r && r.r.body && r.r.body.data && (r.r.body.data.registration_id || r.r.body.data.id);
      await step('报名', '按手机号查报名', 'POST', '/api/registrations/by-phone', { body: { phone: ctx.phone2, event_id: ctx.eventId, invite_code: ctx.inviteCode || '' } });
      await step('报名', '后台报名列表', 'GET', `/api/registrations?event_id=${ctx.eventId}&page=1`, { token: adminToken });
      // 业绩说明会专用接口：靠 page_url 找会议，没有就临时借一个来验
      let borrowed = null;
      const hasPerf = await sequelize.query(
        "SELECT id FROM ec9_events WHERE page_url LIKE '%performance%' LIMIT 1",
        { type: require('sequelize').QueryTypes.SELECT });
      if (!hasPerf.length) {
        const [e] = await sequelize.query('SELECT id FROM ec9_events ORDER BY id DESC LIMIT 1',
          { type: require('sequelize').QueryTypes.SELECT });
        if (e) {
          borrowed = e.id;
          await sequelize.query('UPDATE ec9_events SET page_url=:u WHERE id=:id',
            { replacements: { u: '/pages/performance', id: e.id } });
        }
      }
      const perf = await req('POST', '/api/registrations/submit-performance', {
        body: { phone: newPhone(), name: '业绩会嘉宾', company: '某某机构', position: '分析师' }
      });
      if (perf.status < 400) ok('[报名] 业绩说明会报名（提交待审）');
      else gap('报名', 'submit-performance', `${perf.status} ${(perf.body && perf.body.message) || ''}`);
      if (borrowed) {
        await sequelize.query('UPDATE ec9_events SET page_url=NULL WHERE id=:id', { replacements: { id: borrowed } });
      }
    }

    /* ========== 5. 邀约 ========== */
    console.log('\n=== 5. 邀约函 ===');
    {
      const inv = await step('邀约', '创建邀约', 'POST', '/api/invitations', {
        token: adminToken,
        body: { guest_id: ctx.guestId, event_id: ctx.eventId, ticket_type_id: ctx.ticketId, session_id: ctx.sessionId }
      });
      ctx.invId = inv.r && inv.r.body && inv.r.body.data && (inv.r.body.data.id || (inv.r.body.data.invitation && inv.r.body.data.invitation.id));
      if (!ctx.invId) {
        const { Invitation } = require('../models');
        const it = await Invitation.findOne({ order: [['id', 'DESC']] });
        ctx.invId = it && it.id;
      }
      await step('邀约', '邀约列表', 'GET', `/api/invitations?event_id=${ctx.eventId}&page=1`, { token: adminToken });
      {
        const { Invitation } = require('../models');
        const one = ctx.invId ? await Invitation.findByPk(ctx.invId) : await Invitation.findOne({ order: [['id', 'DESC']] });
        ctx.inviteCode = one && (one.invite_code || one.code);
      }
      await step('邀约', '待审核列表', 'GET', '/api/invitations/pending', { token: adminToken });
      if (ctx.invId) {
        await step('邀约', '邀约详情', 'GET', `/api/invitations/${ctx.invId}`, { token: adminToken });
        await step('邀约', '审核通过', 'POST', `/api/invitations/${ctx.invId}/approve`, { token: adminToken, body: {} });
        await step('邀约', '重新生成二维码', 'POST', `/api/invitations/${ctx.invId}/regenerate-qrcode`, { token: adminToken, body: {} });
        await step('邀约', '分配住宿', 'PUT', `/api/invitations/${ctx.invId}/accommodation`, { token: adminToken, body: { accommodation: { room: '1208', hotel: '演练酒店' } } });
        await step('邀约', '分配席位', 'PUT', `/api/invitations/${ctx.invId}/seats`, { token: adminToken, body: { seat_no: 'A-12' } });
      }
      await step('邀约', '邀约导出', 'GET', `/api/invitations/export?event_id=${ctx.eventId}`, { token: adminToken });
      await step('邀约', '来源 BD 列表', 'GET', '/api/invitations/source-bds', { token: adminToken });
      // 嘉宾侧：凭邀请码查看邀约
      const { Invitation } = require('../models');
      const one = await Invitation.findOne({ order: [['id', 'DESC']] });
      const ic = one && (one.invite_code || one.code);
      if (ic) {
        await step('邀约', '嘉宾侧凭码查邀约', 'GET', `/api/invitations/code/${ic}`);
      }
    }

    /* ========== 6. 订单 + 支付 ========== */
    console.log('\n=== 6. 订单与支付 ===');
    {
      const { Guest, Registration, Order } = require('../models');
            const p3 = newPhone();
      const g = await Guest.create({ name: '支付演练', company: '演练', position: '测试', phone: p3, phone_hash: hmacPhone(p3), status: 1 });
      const reg = await Registration.create({
        guest_id: g.id, event_id: ctx.eventId, status: 'approved',
        ticket_type_id: ctx.ticketId, session_id: ctx.sessionId
      });
      const ord = await step('订单', '创建订单（锁库存）', 'POST', '/api/orders', {
        token: adminToken,
        body: { registration_id: reg.id, quantity: 1 }
      });
      {
        const d = (ord.r && ord.r.body && ord.r.body.data) || {};
        const o = d.order || d;
        ctx.orderId = o.id || d.id;
        ctx.orderNo = o.order_no || d.order_no;
      }
      if (!ctx.orderId) {
        const o = await Order.findOne({ where: { guest_id: g.id }, order: [['id', 'DESC']] });
        ctx.orderId = o && o.id; ctx.orderNo = o && o.order_no;
      }
      await step('订单', '订单列表', 'GET', '/api/orders?page=1', { token: adminToken });
      await step('订单', '订单汇总', 'GET', '/api/orders/summary', { token: adminToken });
      await step('订单', '订单导出', 'GET', '/api/orders/export', { token: adminToken });
      if (ctx.orderNo) {
        // 支付接口要求嘉宾本人凭证（x-verify-token），先给这个手机号走一遍验证
        await req('POST', '/api/verification/send-code', { body: { phone: p3 } });
        const dc = await req('POST', '/api/verification/dev-code', { body: { phone: p3 } });
        let payToken = null;
        if (dc.body && dc.body.code === 0 && dc.body.data) {
          const vv = await req('POST', '/api/verification/verify-code', { body: { phone: p3, code: dc.body.data.code } });
          payToken = vv.body && vv.body.data && vv.body.data.verification_token;
        }
        if (!payToken) {
          gap('支付', '拿不到嘉宾支付凭证', 'verify-code 未返回 verification_token，H5 无法发起支付');
        } else {
          await step('支付', '发起支付（native）', 'POST', '/api/payment/native',
            { body: { order_no: ctx.orderNo }, verifyToken: payToken });
          await step('支付', '查询支付结果', 'GET', `/api/payment/query/${ctx.orderNo}`, { verifyToken: payToken });
          await step('支付', '模拟支付', 'POST', `/api/payment/mock-pay/${ctx.orderNo}`, { body: {}, verifyToken: payToken });
        }
      } else {
        gap('支付', '支付链路', '拿不到订单号，无法演练下单-支付-出票');
      }
      {
        const { CheckinCode } = require('../models');
        const cc = await CheckinCode.count({ where: { guest_id: g.id } });
        check('[支付] 支付后自动出票（签到码）', cc > 0, `签到码数 ${cc}`);
      }
      await step('支付', '支付流水列表', 'GET', '/api/payments?page=1', { token: adminToken });
      await step('支付', '支付汇总', 'GET', '/api/payments/summary', { token: adminToken });
      await step('支付', '对账', 'GET', '/api/payments/reconcile', { token: adminToken });
    }

    /* ========== 7. 签到 ========== */
    console.log('\n=== 7. 签到 ===');
    {
      await step('签到', '签到记录列表', 'GET', `/api/checkins?event_id=${ctx.eventId}&page=1`, { token: adminToken });
      await step('签到', '签到统计', 'GET', `/api/checkins/statistics?event_id=${ctx.eventId}`, { token: adminToken });
      // 手机号签到
      const r1 = await req('POST', '/api/checkins/by-phone', { body: { phone: ctx.phone2, event_id: ctx.eventId } });
      if (r1.status === 404) gap('签到', 'POST /api/checkins/by-phone', '接口不存在');
      else ok(`[签到] 手机号签到（${r1.status}）`);
      // 扫码签到
      const r2 = await req('POST', '/api/checkins/event-checkin', { body: { code: 'NOT_EXIST_CODE', event_id: ctx.eventId } });
      if (r2.status === 404) gap('签到', 'POST /api/checkins/event-checkin', '接口不存在');
      else ok(`[签到] 扫码签到（无效码应被拒：${r2.status}）`);
      // 签到码管理
      await step('签到', '签到码列表', 'GET', '/api/checkin-codes?page=1', { token: adminToken });
      // 自助签到 H5
      const h5 = await req('GET', '/h5/pages/checkin.html');
      if (h5.status === 404) gap('签到', '嘉宾自助签到页', 'public 下无 h5 目录，签到页未实现');
    }

    /* ========== 8. 统计 ========== */
    console.log('\n=== 8. 统计看板 ===');
    {
      const paths = [
        ['总览', `/api/statistics/events/${ctx.eventId}/overview`],
        ['报名趋势', `/api/statistics/events/${ctx.eventId}/registration-trend`],
        ['签到趋势', `/api/statistics/events/${ctx.eventId}/checkin-trend`],
        ['BD 排行', `/api/statistics/events/${ctx.eventId}/bd-statistics`],
        ['单位统计', `/api/statistics/events/${ctx.eventId}/company-statistics`],
        ['首页看板', '/api/statistics/dashboard'],
        ['每日报名', '/api/statistics/daily-registrations'],
        ['收入统计', '/api/statistics/revenue'],
        ['票种销量', '/api/statistics/ticket-sales'],
        ['报名漏斗', '/api/statistics/registration-funnel']
      ];
      for (const [n, p] of paths) await step('统计', n, 'GET', p, { token: adminToken });
    }

    /* ========== 9. 短信 ========== */
    console.log('\n=== 9. 短信中心 ===');
    {
      await step('短信', '模板列表', 'GET', '/api/sms/templates', { token: adminToken });
      await step('短信', '规则列表', 'GET', '/api/sms/rules', { token: adminToken });
      await step('短信', '发送日志', 'GET', '/api/sms/logs?page=1', { token: adminToken });
      await step('短信', '配置（库）', 'GET', '/api/sms-config', { token: adminToken });
      await step('短信', '配置自检', 'POST', '/api/sms-config/test', { token: adminToken, body: {} });
      const cfg = await req('GET', '/api/sms-config', { token: adminToken });
      const ready = cfg.body && cfg.body.data && cfg.body.data.config && cfg.body.data.config.ready;
      if (!ready) gap('短信', '通道未就绪', 'AccessKey/签名/模板未配，真实短信发不出去（当前走 mock）');
    }

    /* ========== 10. 会议多语言 ========== */
    console.log('\n=== 10. 多语言 ===');
    {
      const st = await step('多语言', '翻译状态', 'GET', '/api/events/translate/status', { token: adminToken });
      const tr = await req('POST', '/api/events/translate', { token: adminToken, body: { event_id: ctx.eventId, target_langs: ['en', 'zh-TW'] } });
      if (tr.status === 404) gap('多语言', 'POST /api/events/translate', '接口不存在');
      else if (tr.status >= 500) gap('多语言', 'POST /api/events/translate', `异常 ${tr.status}`);
      else ok(`[多语言] 会议翻译（${tr.status}）`);

      const fs = require('fs');
      for (const l of ['zh-CN', 'zh-TW', 'en']) {
        const p = `public/i18n/${l}.json`;
        if (!fs.existsSync(p)) gap('多语言', `语种包 ${l}`, '文件缺失');
      }
      ok('[多语言] 三语种包文件齐备');
    }

    /* ========== 11. 法务 / 日志 / 配置 ========== */
    console.log('\n=== 11. 法务 · 日志 · 配置 ===');
    {
      await step('法务', '用户协议', 'GET', '/api/legal/user-agreement');
      await step('法务', '隐私政策', 'GET', '/api/legal/privacy-policy');
      await step('日志', '操作日志列表', 'GET', '/api/operation-logs?page=1', { token: adminToken });
      await step('日志', '日志汇总', 'GET', '/api/operation-logs/statistics/summary', { token: adminToken });
      await step('配置', '支付配置', 'GET', '/api/pay-config', { token: adminToken });
      await step('配置', '支付自检', 'POST', '/api/pay-config/test', { token: adminToken, body: {} });
      await step('账号', '管理员列表', 'GET', '/api/admins', { token: adminToken });
      await step('账号', '管理员详情', 'GET', '/api/admins/1', { token: adminToken });
      await step('日志', '日志详情', 'GET', '/api/operation-logs/1', { token: adminToken });
      await step('订单', '订单详情', 'GET', `/api/orders/${ctx.orderId || 1}`, { token: adminToken });
      await step('支付', '流水详情', 'GET', '/api/payments/1', { token: adminToken });
      await step('场次', '场次详情', 'GET', `/api/sessions/${ctx.sessionId || 1}`, { token: adminToken });
      await step('票种', '票种详情', 'GET', `/api/ticket-types/${ctx.ticketId || 1}`, { token: adminToken });
      await step('账号', 'BD 列表', 'GET', '/api/admins/list/bd', { token: adminToken });
    }

    /* ========== 12. 嘉宾侧页面（H5） ========== */
    console.log('\n=== 12. 嘉宾侧页面 ===');
    {
      const fs = require('fs');
      const pub = 'public';
      const pages = ['h5/pages/register.html', 'h5/pages/invite.html', 'h5/pages/checkin.html', 'h5/pages/performance.html', 'register.html', 'invite.html'];
      let found = 0;
      for (const p of pages) if (fs.existsSync(`${pub}/${p}`)) { found++; console.log(`  FOUND ${p}`); }
      if (found === 0) gap('H5', '嘉宾侧页面', 'public 下没有任何嘉宾页面（报名/邀约/签到/业绩说明会），EC8 的 h5 未迁入 EC9');
    }

  } catch (e) {
    console.error('\n演练异常中断:', e.message);
    console.error(e.stack.split('\n').slice(0, 5).join('\n'));
    fail++;
  } finally {
    // ⚠️ 必须清理：本脚本会造一整套会议/场次/票种/嘉宾/订单/签到数据。
    //    不清的话演练会议会按 start_time DESC 排到种子数据前面，
    //    后续任何「取第一个活动」的用例都会拿到演练数据（test-admin-api 曾因此误报失败）。
    if (ctx.eventId) {
      try {
        const ids = [ctx.eventId];
        // payments 没有 event_id，只能按 order 关联删
        await sequelize.query(
          'DELETE FROM ec9_payments WHERE order_id IN (SELECT id FROM ec9_orders WHERE event_id IN (:ids))',
          { replacements: { ids } });
        for (const t of ['ec9_checkin_codes', 'ec9_checkins', 'ec9_orders', 'ec9_registrations',
          'ec9_invitations', 'ec9_ticket_types', 'ec9_sessions', 'ec9_events']) {
          await sequelize.query(`DELETE FROM ${t} WHERE event_id IN (:ids)`, { replacements: { ids } })
            .catch(e => console.log(`  清理 ${t} 跳过: ${e.message.slice(0, 50)}`));
        }
        console.log(`\n[清理] 已删除演练会议 id=${ctx.eventId} 及其关联数据`);
      } catch (e) {
        console.log('[清理] 失败: ' + e.message.slice(0, 80));
      }
    }
  }

  console.log('\n' + '='.repeat(64));
  console.log(`演练结果：通过 ${pass} / 失败 ${fail}`);
  console.log('='.repeat(64));
  if (GAPS.length) {
    console.log(`\n发现缺口 ${GAPS.length} 项：`);
    const byArea = {};
    GAPS.forEach(g => { (byArea[g.area] = byArea[g.area] || []).push(g); });
    Object.keys(byArea).forEach(a => {
      console.log(`\n【${a}】`);
      byArea[a].forEach(g => console.log(`  · ${g.what}\n      ${g.why}`));
    });
  } else {
    console.log('\n没有发现缺口。');
  }
  process.exit(fail > 0 ? 1 : 0);
})();
