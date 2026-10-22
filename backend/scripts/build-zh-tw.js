/**
 * 用 OpenCC（正规简繁转换引擎）重建 zh-TW.json
 *
 * 用法：
 *   node scripts/build-zh-tw.js              # 处理 EC9（默认）
 *   node scripts/build-zh-tw.js D:/ec8/backend # 处理 EC8
 *
 * ⚠️ 为什么要重建而不是继续打补丁：
 *   build-zh-TW.py 的映射表按「每 2 字符一对」解析，但表里有 5 行是**奇数长度**
 *   （PAIRS 第21行、EXTRA 第1行、EXTRA3 第2行、EXTRA5 第5/6行）。
 *   某行奇数会让该行之后所有配对整体错位一格，产生大量错字：
 *       除→詳  示→隐  準→檢  試→备  選→请 …
 *   表现为「删除→刪詳」「显示→顯隐」「提示→提隐」这类一眼可见的错译。
 *   FORCE 表只能补回它恰好列到的字，补不全这批错位产生的错误映射。
 *   改用 OpenCC 词库转换，不存在手写映射错位的可能。
 */
const fs = require('fs');
const path = require('path');
const OpenCC = require('opencc-js');

// 可传项目根目录（默认 EC9），EC8 = EC9 的子集，两个项目共用同一套转换规则
const PROJECT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..');

const I18N_DIR = path.join(PROJECT, 'public', 'i18n');
const SRC = path.join(I18N_DIR, 'zh-CN.json');
const DST = path.join(I18N_DIR, 'zh-TW.json');

// 简 -> 台湾正体（字形 + 基础用词）
const conv = OpenCC.Converter({ from: 'cn', to: 'tw' });

// OpenCC 主要做字形与常用词转换；下面这层是「大陆惯用词 -> 台湾惯用词」的编辑决策，
// 顺序敏感：长的必须排在前面，否则「资料库」会先被「资料」替换掉。
const WORD_FIX = [
  ['数据库', '資料庫'],
  ['二维码', 'QR Code'],
  ['软件', '軟體'],
  ['网络', '網路'],
  ['默认', '預設'],
  ['数据', '資料'],
  ['文件', '檔案'],
  ['信息', '資訊'],
  ['短信', '簡訊'],
  ['视频', '影片'],
  ['联系', '聯繫'],
  ['导出', '匯出'],
  ['导入', '匯入'],
  ['设置', '設定'],
  ['库存', '庫存'],
  ['账户', '帳戶'],
  ['账号', '帳號'],
  ['点击', '點擊'],
  ['打印', '列印'],
  ['屏幕', '螢幕'],
  ['菜单', '選單'],
  ['用户', '使用者'],
  ['密码', '密碼'],
  ['缓存', '快取'],
  ['接口', '介面'],
  ['数组', '陣列'],
  ['字符串', '字串'],
  ['参数', '參數'],
  ['变量', '變數'],
  ['加载', '載入'],
  ['备注', '備註'],
  ['搜索', '搜尋'],
  ['筛选', '篩選'],
  ['登陆', '登入'],
  // —— 后台/表单高频词 ——
  ['重置', '重設'],       // 大陆「重置」；台湾习惯「重設」
  ['默认', '預設'],        // （与上面重复的保留一条即可，此处显式列出便于检索）
  ['提交', '送出'],
  ['保存', '儲存'],
  ['删除', '刪除'],
  ['上传', '上傳'],
  ['下载', '下載'],
  ['登录', '登入'],
  ['用户名', '使用者名稱'],
  ['备注', '備註'],
  ['发票', '發票'],
  ['邮箱', '信箱'],
  ['地址', '地址'],
];

function fixWords(s) {
  let out = s;
  for (const [a, b] of WORD_FIX) out = out.split(a).join(b);
  return out;
}

const HOLE_OPEN = '\u0001';
const HOLE_CLOSE = '\u0002';

function convStr(s) {
  // 占位符 {0} {name} 先摘出来放哨兵位，转换完再放回。
  // 哨兵用控制字符 —— 不可能出现在正常文案里；用字母 H 拼序号的话，
  // 原文若本身含 "H1" 就会被误还原。
  const holes = [];
  let t = s.replace(/\{[^}]*\}/g, (m) => {
    holes.push(m);
    return HOLE_OPEN + (holes.length - 1) + HOLE_CLOSE;
  });
  t = conv(t);
  t = fixWords(t);
  return t.replace(
    new RegExp(HOLE_OPEN + '(\\d+)' + HOLE_CLOSE, 'g'),
    (m, i) => holes[Number(i)]
  );
}

function convObj(o) {
  if (Array.isArray(o)) return o.map(convObj);
  if (o && typeof o === 'object') {
    const out = {};
    for (const k in o) out[k] = convObj(o[k]);
    return out;
  }
  if (typeof o === 'string') return convStr(o);
  return o;
}

function countLeaves(o) {
  if (o && typeof o === 'object') {
    let n = 0;
    for (const k in o) n += countLeaves(o[k]);
    return n;
  }
  return 1;
}

function main() {
  const zh = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const tw = convObj(zh);

  // 保底校验：这些字若仍出现在繁体包里，说明转换没生效
  const twStr = JSON.stringify(tw);
  const suspicious = [];
  for (const ch of ['详', '隐', '术', '网', '软', '码', '签', '录']) {
    const n = (twStr.split(ch).length - 1);
    if (n) suspicious.push(ch + '×' + n);
  }

  fs.writeFileSync(DST, JSON.stringify(tw, null, 1), 'utf8');
  console.log('[' + PROJECT + '] zh-TW.json 已重建：分组 ' + Object.keys(tw).length + '，词条 ' + countLeaves(tw));
  if (suspicious.length) console.log('⚠️ 仍含高频简体残留：' + suspicious.join(' '));
  else console.log('✓ 未发现高频简体残留');

  console.log('\n抽样：');
  const sample = ['admin.delete', 'admin.name', 'admin.smsSent', 'common.switchLanguage',
    'admin.eventName', 'admin.guestName', 'admin.checkIn', 'admin.export', 'admin.paginationInfo',
    'ec9.nav.orders', 'admin.theExcelFileShouldContain'];
  for (const path2 of sample) {
    const idx = path2.indexOf('.');
    const g = path2.slice(0, idx);
    const kk = path2.slice(idx + 1);
    if (tw[g] && tw[g][kk] !== undefined) console.log('  ' + path2.padEnd(30) + tw[g][kk]);
  }
}

main();
