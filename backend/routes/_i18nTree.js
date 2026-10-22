/**
 * 把「前端传入的各语种输入框」组装成存库的 i18n 树。
 *
 * 入参形态（前端传的）：
 *   i18n: {
 *     name: { 'zh-TW': '…', en: '…' },        // 简体不用放这里
 *     description: { 'zh-TW': '…', en: '…' }
 *   }
 * 出参（存库的）：
 *   { name: { 'zh-CN': '…', 'zh-TW': '…', en: '…' }, … }
 *
 * 简体从原字段取（name/description/location 本来就是简体基准列），
 * 这样即使 i18n 整棵树丢了，简体也不会丢。
 *
 * events.js 里已有同名实现，此处抽出供 sessions / ticket-types 等模块复用。
 */
const { setI18nField, I18N_FIELDS } = require('../utils/i18nData');

function buildI18nTree(i18nIn, base, fields) {
  const tree = {};
  const src = (i18nIn && typeof i18nIn === 'object') ? i18nIn : {};
  const list = fields || I18N_FIELDS;
  list.forEach(f => {
    const node = src[f] && typeof src[f] === 'object' ? src[f] : {};
    setI18nField(tree, f, base ? base[f] : '', node);
  });
  return Object.keys(tree).length ? tree : null;
}

module.exports = { buildI18nTree };
