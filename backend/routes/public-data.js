/**
 * EC9 H5 公开数据接口（无需登录）
 *
 *   GET /api/public/events              会议列表（按语言）
 *   GET /api/public/events/:id          会议详情 + 场次 + 在售票种
 *   GET /api/public/events/:id/sessions 该会议场次
 *   GET /api/public/events/:id/tickets  该会议在售票种
 *   GET /api/public/tickets/my?code=xxx 凭签到码查自己的票（购票页/查票页用）
 *
 * 为什么单独开一个 /api/public 而不是复用后台的 events？
 *   - 公开接口不返回成本/内部字段（如 bd、审核规则）
 *   - 公开接口按语言解析多语（后台要原字段才能编辑）
 *   - 公开接口只出「上架 + 启用」的数据
 *
 * 语言来源优先级：?lang= > Accept-Language > 简体（与 events.js 的 resolveLang 同规则）
 */
const express = require('express');
const router = express.Router();
const { Op, Event, Session, TicketType, sequelize } = require('../models');
const { localize, parseI18n, normalizeLang } = require('../utils/i18nData');

const SESSION_FIELDS = ['name', 'location'];
const TICKET_FIELDS = ['name', 'description'];

/**
 * 从 i18n JSON 列里取指定语言的文案，取不到回退简体。
 * parseI18n 可能返回 null（字段为空 / 非法 JSON），所以每处都要兜底。
 */
function pickLang(i18nJson, field, lang) {
  try {
    const obj = typeof i18nJson === 'string' ? parseI18n(i18nJson) : i18nJson;
    if (!obj || typeof obj !== 'object') return '';
    return obj[field] && (obj[field][lang] || obj[field]['zh-CN']) || '';
  } catch (e) {
    return '';
  }
}

function resolveLang(req) {
  const q = req.query && req.query.lang;
  // H5 前端传的是 zh-Hant，库里存的是 zh-TW：先归一化再判定，
  // 否则繁体参数会被当成无效值丢掉，一路回退成简体。
  if (q) {
    const n = normalizeLang(q);
    if (['zh-CN', 'zh-TW', 'en'].indexOf(n) >= 0) return n;
  }
  const h = (req.headers && req.headers['accept-language']) || '';
  const nav = String(h).toLowerCase();
  if (nav.indexOf('zh-tw') === 0 || nav.indexOf('zh-hk') === 0 || nav.indexOf('zh-hant') === 0) return 'zh-TW';
  if (nav.indexOf('en') === 0) return 'en';
  return 'zh-CN';
}

function available(row) {
  return Number(row.stock_total || 0) - Number(row.stock_locked || 0) - Number(row.stock_sold || 0);
}

/** 票种 → 公开结构（不暴露库存明细，只给可售数） */
function publicTicket(t, lang, sessionName) {
  const loc = localize(t, lang, TICKET_FIELDS);
  return {
    id: t.id,
    session_id: t.session_id,
    session_name: sessionName || '',
    name: loc.name,
    description: loc.description,
    price: Number(t.price),
    original_price: t.original_price === null ? null : Number(t.original_price),
    per_order_limit: t.per_order_limit,
    stock_available: Math.max(0, available(t)),
    product_type: t.product_type
  };
}

// ========== 会议列表 ==========
router.get('/events', async (req, res) => {
  try {
    const lang = resolveLang(req);
    const where = { status: 1 };
    if (req.query.status !== undefined) where.status = req.query.status;

    const events = await Event.findAll({ where, order: [['start_time', 'DESC'], ['id', 'DESC']] });
    res.json({
      code: 0, message: 'ok',
      data: { lang, list: events.map(e => localize(e, lang, ['name', 'description', 'location'])) }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ========== 某会议的场次 ==========
async function listSessions(eventId, lang) {
  const rows = await Session.findAll({
    where: { event_id: eventId, status: 1 },
    order: [['sort', 'ASC'], ['id', 'ASC']]
  });
  return rows.map(s => {
    const loc = localize(s, lang, SESSION_FIELDS);
    return {
      id: s.id,
      name: loc.name,
      location: loc.location,
      start_time: s.start_time,
      end_time: s.end_time,
      stock_available: Math.max(0, available(s))
    };
  });
}

/** 某会议在售票种（附场次名） */
async function listTickets(eventId, lang) {
  const rows = await TicketType.findAll({
    where: { event_id: eventId, status: 1, on_shelf: 1 },
    order: [['sort', 'ASC'], ['id', 'ASC']]
  });
  const sids = [...new Set(rows.map(r => r.session_id).filter(x => Number(x) > 0))];
  const sessions = sids.length
    ? await Session.findAll({ where: { id: { [Op.in]: sids } }, attributes: ['id', 'name', 'i18n'] })
    : [];
  const sMap = {};
  sessions.forEach(s => { sMap[s.id] = localize(s, lang, ['name']).name; });

  return rows.map(t => publicTicket(t, lang, Number(t.session_id) > 0 ? sMap[t.session_id] : '全部场次'));
}

// ========== 会议详情（场次 + 票种） ==========
router.get('/events/:id', async (req, res) => {
  try {
    const lang = resolveLang(req);
    const event = await Event.findByPk(req.params.id);
    if (!event || event.status !== 1) {
      return res.status(404).json({ code: 404, message: '会议不存在或未发布' });
    }

    const [sessions, tickets] = await Promise.all([
      listSessions(event.id, lang),
      listTickets(event.id, lang)
    ]);

    res.json({
      code: 0, message: 'ok',
      data: {
        lang,
        event: localize(event, lang, ['name', 'description', 'location']),
        sessions,
        ticket_types: tickets
      }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ========== 场次 ==========
router.get('/events/:id/sessions', async (req, res) => {
  try {
    const lang = resolveLang(req);
    const event = await Event.findByPk(req.params.id);
    if (!event || event.status !== 1) {
      return res.status(404).json({ code: 404, message: '会议不存在或未发布' });
    }
    const sessions = await listSessions(event.id, lang);
    res.json({ code: 0, message: 'ok', data: { lang, list: sessions } });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ========== 票种 ==========
router.get('/events/:id/tickets', async (req, res) => {
  try {
    const lang = resolveLang(req);
    const event = await Event.findByPk(req.params.id);
    if (!event || event.status !== 1) {
      return res.status(404).json({ code: 404, message: '会议不存在或未发布' });
    }
    const tickets = await listTickets(event.id, lang);
    res.json({ code: 0, message: 'ok', data: { lang, list: tickets } });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ========== 凭票码查自己的票（购票页 / 查票页）============
// 短信「支付成功」通知里的链接是 ${baseUrl}/ticket.html?code=<签到码>，
// 这个接口就是那个页面的数据源。EC8 无购票，因此 EC8 没有对应实现。
//
// 只回「本人可见」的字段：姓名/单位/职务/会议/场次/票种/签到码状态。
// ⚠️ 不返回手机号、不返回订单金额、不返回任何后台内部字段。
// ⚠️ ec9_checkin_codes 本身没有 session_id / ticket_type_id，
//    这两列在 ec9_registrations 上，必须经报名表关联，不能直接 JOIN 签到码表。
router.get('/tickets/my', async (req, res) => {
  try {
    const lang = resolveLang(req);
    const raw = String(req.query.code || '').trim();
    if (!raw) return res.status(400).json({ code: 400, message: '缺少票码' });

    const row = await sequelize.query(
      `SELECT cc.id AS code_id, cc.code, cc.status AS code_status, cc.used_at,
              g.name AS guest_name, g.company, g.position,
              e.id AS event_id, e.name AS event_name, e.start_time, e.end_time, e.location, e.i18n AS event_i18n,
              reg.session_id, reg.ticket_type_id,
              s.name AS session_name, s.i18n AS session_i18n,
              t.name AS ticket_name, t.i18n AS ticket_i18n,
              o.order_no, o.status AS order_status, o.quantity, o.final_amount, o.paid_at
         FROM ec9_checkin_codes cc
         JOIN ec9_guests g      ON g.id = cc.guest_id
         JOIN ec9_events e      ON e.id = cc.event_id
         JOIN ec9_registrations reg ON reg.id = cc.registration_id
    LEFT JOIN ec9_sessions s      ON s.id = reg.session_id AND reg.session_id > 0
    LEFT JOIN ec9_ticket_types t  ON t.id = reg.ticket_type_id AND reg.ticket_type_id > 0
    LEFT JOIN ec9_orders o        ON o.registration_id = reg.id
        WHERE cc.code = :code
        LIMIT 1`,
      { replacements: { code: raw } }
    );

    if (!row[0].length) {
      return res.status(404).json({ code: 404, message: '票码无效或已失效' });
    }
    const r = row[0][0];

    res.json({
      code: 0,
      message: 'ok',
      data: {
        lang,
        ticket: {
          code: r.code,
          code_status: r.code_status,
          used_at: r.used_at,
          guest_name: r.guest_name,
          company: r.company,
          position: r.position,
          event: {
            id: r.event_id,
            name: pickLang(r.event_i18n, 'name', lang) || r.event_name,
            start_time: r.start_time,
            end_time: r.end_time,
            location: r.location
          },
          session_name: r.session_i18n
            ? (pickLang(r.session_i18n, 'name', lang) || r.session_name)
            : (r.session_name || ''),
          ticket_name: r.ticket_i18n
            ? (pickLang(r.ticket_i18n, 'name', lang) || r.ticket_name)
            : (r.ticket_name || ''),
          order_no: r.order_no || '',
          order_status: r.order_status || '',
          quantity: Number(r.quantity || 1),
          paid_at: r.paid_at
        }
      }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

module.exports = router;
