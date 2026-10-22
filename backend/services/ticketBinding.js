/**
 * EC9 票种 / 场次 / 活动 三方绑定校验（规则 A）
 *
 * ── 业务语义 ────────────────────────────────────────
 * 门票（票种）有两种粒度：
 *   1. 场次票  ticket_type.session_id > 0  → 只对某一个具体场次生效
 *   2. 活动票  ticket_type.session_id = 0  → 对该活动全部场次生效
 *
 * 规则 A（已确认）：**限场次票种必须同时选择对应场次，否则拒绝。**
 *   - 报名选了场次票 → 必须把报名记录指向该场次（缺省即 0 → 拒绝）
 *   - 报名选了场次票但指向了别的场次 → 拒绝（脏数据防线）
 *   - 报名选了活动票 → 场次可填该活动下任意场次，也可不选（0）
 *
 * 附加守卫：场次与票种必须同属一个活动，禁止跨活动绑定。
 *
 * ── 为什么独立成文件 ────────────────────────────────
 * 建单（orderService）、报名（registrations）、票种管理（ticket-types）
 * 三处都要同一口径，散着写必然漂。改规则只改这一处。
 */
const { TicketType, Session, Event } = require('../models');

/** 把 undefined/null/'' 归一成数字，非法值回落到 def */
function toSid(v, def = 0) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

/**
 * 校验一个「报名 / 建单」场景下的票种-场次组合
 *
 * @param {object}  p
 * @param {number}  p.ticketTypeId  票种 ID（0 或空 = 不限票种，跳过票种校验）
 * @param {number}  p.sessionId     报名/订单选择的场次 ID（0 = 未选场次）
 * @param {number}  p.eventId       所属活动 ID（用于跨活动校验；可不传则跳过）
 * @param {boolean} p.requireTicket 是否必须给出票种
 * @returns {Promise<{ok:boolean, error?:string, code?:string, ticketType?:object, sessionId:number}>}
 *          error 已按「简体中文 + 英文」拼好，供三语接口直接选用
 */
async function validateSelection({ ticketTypeId, sessionId, eventId, requireTicket = false }) {
  const ttId = toSid(ticketTypeId, 0);
  const wantSid = toSid(sessionId, 0);

  if (!ttId) {
    if (requireTicket) {
      return { ok: false, code: 'TICKET_REQUIRED', error: '请选择门票（票种）/ Please select a ticket type' };
    }
    // 不限票种时，场次仍要保证存在且属于该活动
    return { ok: true, sessionId: wantSid, ticketType: null };
  }

  const tt = await TicketType.findByPk(ttId);
  if (!tt || Number(tt.status) !== 1) {
    return { ok: false, code: 'TICKET_NOT_FOUND', error: '门票不存在或已停用 / Ticket type not found' };
  }

  // 票种与活动一致性（防止前端串活动）
  if (eventId && toSid(tt.event_id, 0) !== toSid(eventId, 0)) {
    return {
      ok: false, code: 'TICKET_EVENT_MISMATCH',
      error: '所选门票不属于该活动 / The selected ticket does not belong to this event'
    };
  }

  const ttSid = toSid(tt.session_id, 0);

  // ── 规则 A 主体：场次票必须选对应场次 ──
  if (ttSid > 0) {
    if (wantSid <= 0) {
      return {
        ok: false, code: 'SESSION_REQUIRED',
        error: `该门票限「${tt.name}」场次使用，请先选择场次 / This ticket is only valid for session "${tt.name}", please select a session first`
      };
    }
    if (wantSid !== ttSid) {
      const s = await Session.findByPk(wantSid);
      return {
        ok: false, code: 'SESSION_MISMATCH',
        error: `该门票限「${tt.name}」场次使用，不能用于「${s ? s.name : wantSid}」场次 / This ticket is only valid for session "${tt.name}"`
      };
    }
  }

  // 活动票：场次可填可不填，但填了必须属于本活动
  if (wantSid > 0) {
    const s = await Session.findByPk(wantSid);
    if (!s || Number(s.status) !== 1) {
      return { ok: false, code: 'SESSION_NOT_FOUND', error: '场次不存在 / Session not found' };
    }
    if (toSid(s.event_id, 0) !== toSid(tt.event_id, 0)) {
      return {
        ok: false, code: 'SESSION_EVENT_MISMATCH',
        error: '所选场次不属于该活动 / The selected session does not belong to this event'
      };
    }
  }

  return { ok: true, sessionId: wantSid, ticketType: tt };
}

/**
 * 票种管理侧的守卫：票种要绑的场次必须存在且同属该活动
 * 供 ticket-types 的 POST / PUT 复用
 */
async function validateTicketSession(eventId, sessionId) {
  const sid = toSid(sessionId, 0);
  if (sid <= 0) return { ok: true, sessionId: 0 };

  const s = await Session.findByPk(sid);
  if (!s) return { ok: false, code: 'SESSION_NOT_FOUND', error: '场次不存在 / Session not found' };
  if (eventId && toSid(s.event_id, 0) !== toSid(eventId, 0)) {
    return {
      ok: false, code: 'SESSION_EVENT_MISMATCH',
      error: '场次不属于该活动，不能作为票种适用场次 / The session does not belong to this event'
    };
  }
  return { ok: true, sessionId: sid };
}

/**
 * 从一条报名记录反推「应当写入的场次」，供建单时使用。
 * 规则 A 下报名的 session_id 一定已经过校验，这里做兜底再确认一次。
 */
async function resolveSessionForRegistration(registration) {
  const tt = await TicketType.findByPk(toSid(registration.ticket_type_id, 0));
  const ttSid = toSid(tt && tt.session_id, 0);
  const regSid = toSid(registration.session_id, 0);

  if (tt && ttSid > 0 && regSid !== ttSid) {
    return {
      ok: false, code: 'SESSION_MISMATCH',
      error: `报名记录场次与门票不匹配（报名=${regSid}，票种=${ttSid}）/ Registration session does not match the ticket type`
    };
  }
  if (regSid > 0) {
    const s = await Session.findByPk(regSid);
    if (!s) return { ok: false, code: 'SESSION_NOT_FOUND', error: '报名记录的场次不存在 / Session not found' };
    if (toSid(s.event_id, 0) !== toSid(registration.event_id, 0)) {
      return {
        ok: false, code: 'SESSION_EVENT_MISMATCH',
        error: '报名记录的场次不属于该活动 / The registration session does not belong to this event'
      };
    }
  }
  return { ok: true, sessionId: regSid };
}

/** 从错误对象里挑出当前语种对应的文案（错误串是「中文 / English」双写） */
function pickLang(msg, lang) {
  if (!msg) return '';
  if (!lang || lang === 'zh-CN') return String(msg).split(' / ')[0];
  if (lang === 'en') {
    const parts = String(msg).split(' / ');
    return parts[parts.length - 1];
  }
  return String(msg).split(' / ')[0];
}

module.exports = {
  toSid,
  validateSelection,
  validateTicketSession,
  resolveSessionForRegistration,
  pickLang,
  _Event: Event
};