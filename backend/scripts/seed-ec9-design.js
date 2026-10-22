/**
 * 按 MasterGo 设计稿「EC9-外部」录入模拟数据
 *  - 会议：地球克隆计划9 / 2026-12-04 / 深圳·前海国际会议中心（三语）
 *  - 票种：标准票 ¥2510、尊享票 ¥5100（三语），免费票下架
 * 幂等：按 name 定位，重复执行只更新。
 */
const { Event, TicketType, Session } = require('../models');

const EVENT_I18N = {
  name: {
    'zh-CN': '地球克隆计划9',
    'zh-TW': '地球克隆計劃9',
    en: 'Earth Cloning Plan 9'
  },
  description: {
    'zh-CN': 'Join Physical AI，Here and Now',
    'zh-TW': 'Join Physical AI，Here and Now',
    en: 'Join Physical AI, Here and Now'
  },
  location: {
    'zh-CN': '中国·深圳',
    'zh-TW': '中國·深圳',
    en: 'Shenzhen, China'
  }
};

const TICKETS = [
  {
    match: ['标准票'],
    name: '标准票',
    en: 'Standard Ticket',
    tw: '標準票',
    desc: '含主论坛与全部平行论坛入场资格、会议资料包、茶歇与午餐',
    descEn: 'Access to the keynote and all parallel forums, conference kit, coffee breaks & lunch',
    descTw: '含主論壇與全部平行論壇入場資格、會議資料包、茶歇與午餐',
    price: 2510,
    original_price: 2999,
    stock_total: 500,
    per_order_limit: 3,
    on_shelf: 1,
    sort: 1
  },
  {
    match: ['VIP 票', 'VIP票', '尊享票'],
    name: '尊享票',
    en: 'Premium Ticket',
    tw: '尊享票',
    desc: '前排席位 + 闭门圆桌 + 晚宴交流 + 专属通道',
    descEn: 'Front-row seating, closed-door roundtable, networking dinner & priority access',
    descTw: '前排席位 + 閉門圓桌 + 晚宴交流 + 專屬通道',
    price: 5100,
    original_price: 5999,
    stock_total: 100,
    per_order_limit: 2,
    on_shelf: 1,
    sort: 2
  }
];

(async () => {
  try {
    // 1. 会议
    const ev = await Event.findByPk(1);
    if (ev) {
      await ev.update({
        name: '地球克隆计划9',
        description: 'Join Physical AI，Here and Now',
        location: '中国·深圳',
        address: '深圳市南山区前海国际会议中心',
        start_time: new Date('2026-12-04T01:30:00.000Z'), // 北京时间 09:30
        end_time: new Date('2026-12-04T10:00:00.000Z'),
        signup_start_time: new Date('2026-10-01T16:00:00.000Z'),
        signup_end_time: new Date('2026-12-03T15:59:00.000Z'),
        i18n: EVENT_I18N
      });
      console.log('[seed] 会议已更新: 地球克隆计划9 / 2026-12-04 / 中国·深圳');
    }

    // 2. 票种
    for (const spec of TICKETS) {
      const rows = await TicketType.findAll({ where: { event_id: 1 } });
      const hit = rows.find(r => spec.match.indexOf(r.name) >= 0);
      const patch = {
        name: spec.name,
        description: spec.desc,
        price: spec.price,
        original_price: spec.original_price,
        stock_total: spec.stock_total,
        per_order_limit: spec.per_order_limit,
        on_shelf: spec.on_shelf,
        sort: spec.sort,
        i18n: {
          name: { 'zh-CN': spec.name, 'zh-TW': spec.tw, en: spec.en },
          description: { 'zh-CN': spec.desc, 'zh-TW': spec.descTw, en: spec.descEn }
        }
      };
      if (hit) {
        await hit.update(patch);
        console.log(`[seed] 票种更新: ${hit.name} → ${spec.name} ¥${spec.price}`);
      } else {
        await TicketType.create(Object.assign({ event_id: 1, session_id: 0 }, patch));
        console.log(`[seed] 票种新建: ${spec.name} ¥${spec.price}`);
      }
    }

    // 3. 免费票下架（模拟数据只保留设计稿里的两种票）
    const all = await TicketType.findAll({ where: { event_id: 1 } });
    for (const t of all) {
      const keep = TICKETS.some(s => s.match.indexOf(t.name) >= 0 || s.name === t.name);
      if (!keep && t.on_shelf === 1) {
        await t.update({ on_shelf: 0 });
        console.log(`[seed] 票种下架: ${t.name}`);
      }
    }

    // 4. 场次（论坛）校验
    const sessions = await Session.findAll({ where: { event_id: 1 } });
    console.log('[seed] 场次: ' + (sessions.map(s => s.name).join(' / ') || '无'));

    process.exit(0);
  } catch (e) {
    console.error('[seed] 失败:', e.message);
    process.exit(1);
  }
})();
