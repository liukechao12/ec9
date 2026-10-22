/**
 * H5 接口契约对比：EC8（H5 期望）vs EC9（实际返回）
 * 目的：H5 从 EC8 搬过来后，逐个接口确认字段名/结构一致，
 *避免真机点下去才发现「字段对不上」这种静默失败。
 */
const http = require('http');

const BASE = { host: '127.0.0.1', port: 7098 };

function rq(path, opt = {}, token) {
  return new Promise((resolve) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['x-verify-token'] = token;
    const q = http.request({ ...BASE, path, method: opt.method || 'GET', headers }, (s) => {
      let d = '';
      s.on('data', c => (d += c));
      s.on('end', () => {
        let j = null;
        try { j = JSON.parse(d); } catch (e) { /* 非 JSON */ }
        resolve({ http: s.statusCode, j, raw: d.slice(0, 200) });
      });
    });
    q.on('error', e => resolve({ http: 'ERR', j: null, raw: e.message }));
    if (opt.body) q.write(JSON.stringify(opt.body));
    q.end();
  });
}

function shape(o, depth = 0) {
  if (o === null || o === undefined) return String(o);
  if (Array.isArray(o)) return o.length ? '[' + shape(o[0], depth + 1) + ']' : '[]';
  if (typeof o !== 'object') return typeof o;
  if (depth > 1) return '{...}';
  return '{' + Object.keys(o).join(',') + '}';
}

(async () => {
  const out = {};

  // 1. 公开会议数据
  const pub = await rq('/api/public/events');
  out['GET /api/public/events'] = {
    http: pub.http,
    top: pub.j ? Object.keys(pub.j) : null,
    code: pub.j ? pub.j.code : null,
    data: pub.j ? shape(pub.j.data) : pub.raw
  };
  if (pub.j && pub.j.data && pub.j.data.list && pub.j.data.list.length) {
    const evId = pub.j.data.list[0].id;
    const det = await rq(`/api/public/events/${evId}`);
    out[`GET /api/public/events/${evId}`] = {
      http: det.http,
      data: det.j ? shape(det.j.data) : det.raw
    };
  }

  // 2. 邀约码
  const { sequelize } = require('../config/database');
  const inv = await sequelize.query(
    "SELECT invite_code FROM ec9_invitations WHERE status='valid' ORDER BY id LIMIT 1"
  ).catch(() => [[]]);
  const code = inv[0] && inv[0][0] ? inv[0][0].invite_code : null;
  out['_测试用邀约码'] = code;
  if (code) {
    const ic = await rq(`/api/invitations/code/${code}`);
    out['GET /api/invitations/code/:code'] = {
      http: ic.http, code: ic.j ? ic.j.code : null,
      data: ic.j ? shape(ic.j.data) : ic.raw
    };
    const pf = await rq('/api/invitations/verify-phone', { method: 'POST', body: { invite_code: code, phone: '13800000000' } });
    out['POST /api/invitations/verify-phone'] = { http: pf.http, code: pf.j ? pf.j.code : null, msg: pf.j ? pf.j.message : pf.raw };
  }

  // 3. 验证码
  const sc = await rq('/api/verification/send-code', { method: 'POST', body: { phone: '13900000001' } });
  out['POST /api/verification/send-code'] = { http: sc.http, body: sc.j };
  const vc = await rq('/api/verification/verify-code', { method: 'POST', body: { phone: '13900000001', code: '000000' } });
  out['POST /api/verification/verify-code (故意错码)'] = { http: vc.http, body: vc.j };

  // 4. EC8 H5 用的旧接口是否还在
  const legacy = [
    '/api/checkin-codes',
    '/api/events/1',
    '/api/checkins/by-phone',
    '/api/checkins/event-checkin',
    '/api/registrations/by-phone',
    '/api/registrations/submit',
    '/api/registrations/submit-performance'
  ];
  out['_旧接口存在性(401/404 区分)'] = {};
  for (const p of legacy) {
    const r = await rq(p, p.includes('by-phone') || p.includes('submit') || p.includes('event-checkin')
      ? { method: 'POST', body: {} } : {});
    out['_旧接口存在性(401/404 区分)'][p] = r.http + (r.j ? ' code=' + r.j.code : '');
  }

  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})();