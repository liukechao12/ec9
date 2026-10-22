/**
 * 增量补词条：只往 zh-CN 包里加词条，en 单独维护，zh-TW 由 build-zh-tw.js 生成。
 *
 * 用法：node scripts/add-entries.js <条目json文件>
 * 例：  node scripts/add-entries.js scripts/entries-20261014.json
 *
 * 条目格式（路径除最后一段外均为对象，与 i18n 包结构一致）：
 * {
 *   "ec9.order.totalRecords": { "zh-CN": "共 {0} 条记录", "en": "{0} records" },
 *   "ec9.filter.startDate":   { "zh-CN": "开始日期",      "en": "Start date" }
 * }
 */
const fs = require('fs');
const path = require('path');

const I18N_DIR = path.join(__dirname, '..', 'public', 'i18n');
const file = process.argv[2];
if (!file) {
  console.error('用法: node scripts/add-entries.js <条目json文件>');
  process.exit(1);
}

const entries = JSON.parse(fs.readFileSync(file, 'utf8'));

/** 把 'a.b.c' 逐层建出来 */
function setPath(obj, dotted, value) {
  const parts = dotted.split('.');
  let node = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}

let added = 0, skipped = 0;
for (const lang of ['zh-CN', 'en']) {
  const p = path.join(I18N_DIR, lang + '.json');
  const pack = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const key in entries) {
    const v = entries[key][lang];
    if (v == null) continue;
    const parts = key.split('.');
    let cur = pack, exists = true;
    for (const seg of parts) {
      if (cur && Object.prototype.hasOwnProperty.call(cur, seg)) cur = cur[seg];
      else { exists = false; break; }
    }
    if (exists && cur) { skipped++; continue; }
    setPath(pack, key, v);
    added++;
  }
  fs.writeFileSync(p, JSON.stringify(pack, null, 1), 'utf8');
  console.log(lang + '.json 已更新');
}
console.log('新增 ' + (added / 2) + ' 组词条，跳过已存在 ' + skipped / 2 + ' 组');