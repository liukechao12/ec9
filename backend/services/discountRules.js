/**
 * EC9 多人折扣阶梯（后台可配）
 * ------------------------------------------------------------
 * 迁移前（<=2026-10-28）折扣是写死的「>=3 张 9 折、>=5 张 8 折」，现在档位落在
 * ec9_discount_rules，运营在后台「折扣规则」页随时改、即时生效。
 *
 * 口径（2026-10-29 昊哥拍板，三条）：
 *   ① 张数只数「付费的标准票」：ticket_type.is_standard=1 且排除学生票 / 邀约免票；
 *   ② 折扣只乘在标准票金额上，其它票种（尊享票等）一律原价；
 *   ③ 命中取「就高」：min_qty <= 张数 里 min_qty 最大的那条启用规则。
 *      e.g. 配了 3张9折 / 5张8折 / 10张7折，买 7 张 → 命中 5张8折。
 *
 * 落点：后端算钱靠 groupOrderService.applyDiscount，H5 页面展示靠
 * public-data 把同一份档位下发出去。两边都用这里的 pickTier / calcDiscount，
 * 保证「页面显示的优惠」和「真正扣的钱」永远一致。
 *
 * 这个模块刻意保持零业务依赖（只 require model），好让 public-data 这种
 * 高频接口引它时不会顺带拖进短信、支付等重量级依赖。
 */
const DiscountRule = require('../models/DiscountRule');

/**
 * 兜底档位：与迁移前的硬编码口径一致。
 * ⚠️ 只有在「该活动的规则表一条都没有」时才用；只要配了行就完全听表里的。
 *   想彻底取消折扣 → 把行全设 enabled=0，不要删空表（删空会回退到这里）。
 */
const DEFAULT_TIERS = [
  { min_qty: 5, rate: 0.8, enabled: 1 },
  { min_qty: 3, rate: 0.9, enabled: 1 }
];

/** 0.9 → "9"、0.85 → "8.5"、1 → "10"：用来拼中文「X折」标签 */
function rateToZhe(rate) {
  const d = Math.round(Number(rate) * 1000) / 100;
  return String(d).replace(/\.?0+$/, '');
}

/**
 * 就高命中
 * @param {Array<{min_qty:number,rate:number,enabled?:number}>} rules 档位表
 * @param {number} qty 付费标准票张数
 * @returns {{min_qty:number,rate:number}|null}
 */
function pickTier(rules, qty) {
  let hit = null;
  for (const r of (Array.isArray(rules) ? rules : [])) {
    if (!r) continue;
    // enabled 缺失视为启用（兼容默认档位与老数据）
    if (r.enabled !== undefined && r.enabled !== null && Number(r.enabled) !== 1) continue;
    const mq = Number(r.min_qty), ra = Number(r.rate);
    if (!Number.isFinite(mq) || !Number.isFinite(ra) || ra <= 0 || ra > 1) continue;
    if (qty >= mq && (!hit || mq > hit.min_qty)) hit = { min_qty: mq, rate: ra };
  }
  return hit;
}

/**
 * 付费标准票张数 → 折扣结果
 * @param {number} stdCount
 * @param {Array} [rules] 不传则用 DEFAULT_TIERS
 * @returns {{rate:number,label:string,min_qty:number,source:string}}
 */
function calcDiscount(stdCount, rules) {
  const src = (Array.isArray(rules) && rules.length) ? rules : DEFAULT_TIERS;
  const hit = pickTier(src, Number(stdCount) || 0);
  if (!hit) return { rate: 1.0, label: '', min_qty: 0, source: 'none' };
  return {
    rate: hit.rate,
    label: `标准票满${hit.min_qty}张${rateToZhe(hit.rate)}折`,
    min_qty: hit.min_qty,
    source: 'rule'
  };
}

/**
 * 读某活动的折扣档位。
 * 不缓存：规则表就几行，且运营改完要立刻生效；真到了要缓存那天再说。
 * @returns {Promise<Array<{min_qty:number,rate:number,enabled:number}>>}
 */
async function fetchDiscountRules(eventId) {
  try {
    const rows = await DiscountRule.findAll({
      where: { event_id: Number(eventId) || 1 },
      order: [['min_qty', 'ASC'], ['id', 'ASC']]
    });
    const list = rows
      .map(r => ({ min_qty: Number(r.min_qty), rate: Number(r.rate), enabled: Number(r.enabled) }))
      .filter(r => Number.isFinite(r.min_qty) && Number.isFinite(r.rate));
    return list.length ? list : DEFAULT_TIERS;
  } catch (e) {
    console.error('[discount] 读取折扣规则失败，回退内置默认：', e.message);
    return DEFAULT_TIERS;
  }
}

module.exports = {
  DEFAULT_TIERS, rateToZhe, pickTier, calcDiscount, fetchDiscountRules
};
