/**
 * 业务数据的多语处理。
 *
 * 存储格式（events.i18n 字段，一个 JSON 列搞定）：
 *   {
 *     "name":        { "zh-CN": "2025年度VIP客户答谢会", "zh-TW": "…", "en": "…" },
 *     "description": { "zh-CN": "…", "zh-TW": "…", "en": "…" },
 *     "location":    { "zh-CN": "…", "zh-TW": "…", "en": "…" }
 *   }
 *
 * 为什么用 JSON 而不是加 _tw/_en 列：
 *   - 加语种不用改表结构，改 JSON 里的 key 即可
 *   - 表结构干净，不会出现「加语种加出一堆 _xx 列」
 *   - 扩展字段（extra_fields）也是 JSON，两边一致
 *
 * 回退规则：目标语种 → 简体 → 英文。宁可显示简体，也不显示空白。
 */

const LANGS = ['zh-CN', 'zh-TW', 'en'];
const DEFAULT_LANG = 'zh-CN';

/** 需要多语的字段 */
const I18N_FIELDS = ['name', 'description', 'location'];

/** 判断对象是否是多语结构（值里有语种 key） */
function isI18nNode(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return LANGS.some(l => Object.prototype.hasOwnProperty.call(v, l));
}

/** 兼容 MySQL 驱动：JSON 列有时返回字符串 */
function parseI18n(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch (e) { return null; }
  }
  return (raw && typeof raw === 'object') ? raw : null;
}

/**
 * 取某个字段在指定语言下的值。
 * @param {object} i18n  整棵 i18n 树
 * @param {string} field 字段名，如 'name'
 * @param {string} lang  目标语种
 * @param {string} fallback 兜底（通常传简体原字段值）
 */
function pick(i18n, field, lang, fallback) {
  const tree = parseI18n(i18n);
  const node = tree && tree[field];
  if (isI18nNode(node)) {
    const order = [lang, DEFAULT_LANG, 'en'];
    for (const l of order) {
      const v = node[l];
      if (v != null && String(v).trim() !== '') return v;
    }
  }
  // i18n 里没有 → 用传入的兜底（数据库的简体原字段）
  if (fallback != null && String(fallback).trim() !== '') return fallback;
  // 最后兜底：i18n 里的英文
  if (node && node.en) return node.en;
  return '';
}

/**
 * 把一条记录按语种解析成「展示值」。
 * @param {object} row  数据库行（含 i18n + 简体列）
 * @param {string} lang
 * @param {string[]} fields 需要解析的字段名
 */
function localize(row, lang, fields) {
  if (!row) return null;
  const list = fields || I18N_FIELDS;
  // ⚠️ Sequelize 实例不能直接 Object.assign —— 会把内部 dataValues 一并拷出来，
  //    返回结构变成 { dataValues: {...} }，前端取不到字段。
  //    统一先拍平成普通对象再解析。
  const src = toPlain(row);
  const out = Object.assign({}, src);
  const i18n = parseI18n(src.i18n);
  list.forEach(f => {
    out[f] = pick(i18n, f, lang, src[f]);
  });
  // 带上完整的 i18n 树，前端可自行取任意语种
  out.i18n = i18n || {};
  out._lang = lang;
  return out;
}

/**
 * Sequelize 实例 / JSONB 字符串 / 普通对象 → 普通对象。
 */
function toPlain(row) {
  if (!row || typeof row !== 'object') return {};
  if (typeof row.get === 'function') return row.get({ plain: true });
  if (row.dataValues && typeof row.dataValues === 'object') return Object.assign({}, row.dataValues);
  return row;
}

function localizeList(rows, lang, fields) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(r => localize(r, lang, fields));
}

/**
 * 从「简体列 + 各语种输入框」组装成 i18n 树。
 *
 * @param {string} field   字段名
 * @param {string} zh      简体（必填）
 * @param {object} variants { 'zh-TW': '…', en: '…' }  各语种内容，空值会剔除
 * @param {object} acc     累积对象
 */
function setI18nField(acc, field, zh, variants) {
  const node = {};
  if (zh != null && String(zh).trim() !== '') node[DEFAULT_LANG] = String(zh).trim();
  if (variants) {
    LANGS.forEach(l => {
      if (l === DEFAULT_LANG) return;
      const v = variants[l];
      if (v != null && String(v).trim() !== '') node[l] = String(v).trim();
    });
  }
  if (Object.keys(node).length === 0) {
    delete acc[field];
  } else {
    acc[field] = node;
  }
  return acc;
}

/** 判断某字段是否已有非简体的译文（前端用来提示「已填写」） */
function hasVariant(i18n, field, lang) {
  const tree = parseI18n(i18n);
  const node = tree && tree[field];
  if (!isI18nNode(node)) return false;
  const v = node[lang];
  return v != null && String(v).trim() !== '';
}

module.exports = {
  LANGS, DEFAULT_LANG, I18N_FIELDS,
  parseI18n, isI18nNode, pick, localize, localizeList, toPlain,
  setI18nField, hasVariant
};