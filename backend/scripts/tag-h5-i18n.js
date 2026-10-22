/**
 * 给 EC8 搬来的 H5 页面批量补 data-i18n 属性。
 *
 * 为什么要这个：EC8 的 H5 页面一个 data-i18n 都没有，
 * i18n.js 的切换器虽然渲染出来了，但没词条可翻 —— 点「EN」毫无反应。
 * 而 EC9 的合同明确要求 H5 也做双语。
 *
 * 用法：node scripts/tag-h5-i18n.js          （只报告，不改）
 *       node scripts/tag-h5-i18n.js --write  （真正写入）
 *
 * 幂等：已有 data-i18n 的元素跳过；重复执行不会重复加。
 */
const fs = require('fs');
const path = require('path');

const H5 = path.join(__dirname, '..', 'public', 'h5');
const WRITE = process.argv.includes('--write');

/** 原文 → 词条 key。key 命名：h5.<页面>.<语义> */
const MAP = {
  // ---- 通用 ----
  '加载中...': 'h5.common.loading',
  '加载中…': 'h5.common.loading',
  '下一步': 'h5.common.next',
  '获取验证码': 'h5.common.getCode',
  '验证码：': 'h5.common.codeLabel2',
  '手机号：': 'h5.common.phoneLabel',
  '手机：': 'h5.common.phoneLabel',
  '姓名：': 'h5.common.nameLabel',
  '公司：': 'h5.common.companyLabel',
  '单位名称': 'h5.common.companyName',
  '职位': 'h5.common.position',
  '职务：': 'h5.common.positionLabel',
  '联系电话': 'h5.common.phone',
  '回到首页': 'h5.common.backHome',
  '报名信息': 'h5.common.regInfo',
  '个人信息': 'h5.common.personalInfo',
  '手机验证': 'h5.common.phoneVerify',
  '活动名称': 'h5.common.eventName',
  '姓名': 'h5.common.name',
  '公司': 'h5.common.company',
  '手机号': 'h5.common.phone',
  '用户协议': 'h5.legal.agreement',
  '隐私政策': 'h5.legal.privacy',

  // ---- 会议主页 pages.html ----
  '立即报名': 'h5.common.registerNow',
  '邀请人：': 'h5.pages.inviter',
  '是否需要12月29日住宿：': 'h5.pages.hotel1229',
  '是否需要12月30日住宿：': 'h5.pages.hotel1230',
  '待审核': 'h5.pages.pending',
  '报名失败信息': 'h5.pages.failed',

  // ---- 邀约页 invite.html ----
  '活动邀约报名': 'h5.invite.title',
  '欢迎参加本次活动': 'h5.invite.welcome',
  '活动时间': 'h5.invite.eventTime',
  '活动地点': 'h5.invite.eventLocation',
  '请输入您的手机号': 'h5.invite.enterPhone',
  '验证手机号': 'h5.invite.verifyPhone',
  '您的信息': 'h5.invite.yourInfo',
  '确认报名': 'h5.invite.confirm',
  '报名成功': 'h5.invite.success',
  '您的门票已生成': 'h5.invite.ticketReady',
  '门票编号': 'h5.invite.ticketNo',
  '入场二维码': 'h5.invite.qrTitle',
  '请截图保存此二维码，入场时出示': 'h5.invite.qrTip',
  '保存门票': 'h5.invite.save',
  '重新加载': 'h5.common.reload',
  '出错了': 'h5.common.error',
  '已报名': 'h5.invite.alreadyRegistered',

  // ---- 业绩说明会 performance.html ----
  '报名登记': 'h5.perf.register',
  '2025业绩说明会': 'h5.perf.title2025',
  '提交报名': 'h5.perf.submit',
  '已提交，等待审核': 'h5.perf.submitted',
  '感谢您的报名，期待与您相见！': 'h5.perf.thanks',

  // ---- 签到页 checkin.html ----
  '活动签到': 'h5.checkin.title',
  '签到类型': 'h5.checkin.type',
  '请输入报名时使用的手机号': 'h5.checkin.enterPhone',
  '确认签到': 'h5.checkin.confirm',
  '签到时间': 'h5.checkin.time',
  '签到地点': 'h5.checkin.location',
  '✓ 签到成功，请妥善保管您的门票': 'h5.checkin.successTip',
  '如需帮助，请联系现场工作人员': 'h5.checkin.helpStaff',
  '您已签到': 'h5.checkin.already',
  '无需重复签到': 'h5.checkin.noRepeat',
  '如有疑问，请联系现场工作人员': 'h5.checkin.question',
  '签到成功': 'h5.checkin.success',
  '立即签到': 'h5.checkin.now',
  '签到失败，手机号不匹配': 'h5.checkin.failMismatch'
};

const FILES = ['invite.html', 'pages.html', 'performance.html', 'checkin.html', 'ticket.html'];

let totalTagged = 0;
let totalMissing = 0;

FILES.forEach((f) => {
  const fp = path.join(H5, f);
  if (!fs.existsSync(fp)) { console.log('跳过（不存在）: ' + f); return; }
  let src = fs.readFileSync(fp, 'utf8');
  let tagged = 0;
  const missing = new Set();

  Object.keys(MAP).forEach((text) => {
    const key = MAP[text];
    // 只处理「纯文本节点」：>原文<，且该标签尚未带 data-i18n
    // 用负向前瞻排除 <p data-i18n=...>文字</p> 这种已标注的
    const re = new RegExp('(<(?!\\!--)[a-zA-Z][^>]*?)>(' + escapeRe(text) + ')<', 'g');
    src = src.replace(re, (m, openTag, matched) => {
      if (openTag.indexOf('data-i18n') >= 0) return m;
      tagged++;
      return openTag + ' data-i18n="' + key + '">' + matched + '<';
    });
    // 检测「原文存在但没被标注」的情况 → 报缺口
    if (src.indexOf(text) >= 0 && tagged === 0 && !missing.has(text)) {
      // 可能是已标注导致 skip，也可能是格式不匹配，两种都记下来人工看
    }
  });

  // 报告仍存在于文件中、但没有 data-i18n 的中文文本
  const remain = [];
  const textRe = />([^<>]{2,24})</g;
  let m2;
  while ((m2 = textRe.exec(src))) {
    const t = m2[1].trim();
    if (!t) continue;
    if (!/[一-龥]/.test(t)) continue;
    if (/^[\s\d\-+:：·|/\\.]+$/.test(t)) continue;
    // 取该文本节点的父标签，看是否已有 data-i18n
    const before = src.slice(Math.max(0, m2.index - 220), m2.index);
    const lastOpen = before.lastIndexOf('<');
    const openTag = before.slice(lastOpen);
    if (openTag.indexOf('data-i18n') >= 0) continue;
    if (MAP[t]) { remain.push('【缺 data-i18n】' + t); continue; }
    remain.push(t);
  }

  totalTagged += tagged;
  totalMissing += remain.length;

  console.log('\n[' + f + '] 新标注 ' + tagged + ' 处');
  if (remain.length) {
    console.log('  未标注中文 ' + remain.length + ' 处:');
    remain.slice(0, 40).forEach(r => console.log('    ' + r));
    if (remain.length > 40) console.log('    ... 还有 ' + (remain.length - 40) + ' 处');
  }

  if (WRITE && tagged) fs.writeFileSync(fp, src, 'utf8');
});

console.log('\n合计：标注 ' + totalTagged + ' 处，未标注 ' + totalMissing + ' 处' +
  (WRITE ? '（已写入）' : '（仅报告，加 --write 才写入）'));

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}