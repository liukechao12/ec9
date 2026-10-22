/**
 * 补词条：把 EC9 新增四个模块（场次/票种/订单/支付流水）的界面文案
 * 写进三语词条库。
 *
 * 幂等：已存在的 key 不覆盖，直接退出。
 * 用法：node scripts/add-ec9-terms.js [--dry]
 */
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public', 'i18n');
const DRY = process.argv.includes('--dry');

/**
 * 每个 key：{ zh-CN, en, 'zh-TW' }
 * ⚠️ 必须三语齐全，且中英繁互不相同（否则会被 autoTranslate 判为「无需翻译」）。
 */
const TERMS = {
  // ---------- 导航与页签 ----------
  'ec9.nav.sessions':        { 'zh-CN': '场次管理', en: 'Sessions',          'zh-TW': '場次管理' },
  'ec9.nav.ticketTypes':    { 'zh-CN': '票种管理', en: 'Ticket Types',      'zh-TW': '票種管理' },
  'ec9.nav.orders':         { 'zh-CN': '订单管理', en: 'Orders',            'zh-TW': '訂單管理' },
  'ec9.nav.payments':       { 'zh-CN': '支付流水', en: 'Payments',          'zh-TW': '支付記錄' },

  // ---------- 通用操作 ----------
  'ec9.action.refresh':     { 'zh-CN': '刷新',   en: 'Refresh',           'zh-TW': '刷新' },
  'ec9.action.query':       { 'zh-CN': '查询',   en: 'Search',            'zh-TW': '查詢' },
  'ec9.action.reset':       { 'zh-CN': '重置',   en: 'Reset',             'zh-TW': '重設' },
  'ec9.action.edit':        { 'zh-CN': '编辑',   en: 'Edit',              'zh-TW': '編輯' },
  'ec9.action.detail':      { 'zh-CN': '详情',   en: 'Details',           'zh-TW': '詳情' },
  'ec9.action.delete':      { 'zh-CN': '删除',   en: 'Delete',            'zh-TW': '刪除' },
  'ec9.action.close':       { 'zh-CN': '关闭',   en: 'Close',             'zh-TW': '關閉' },
  'ec9.action.save':        { 'zh-CN': '保存',   en: 'Save',              'zh-TW': '儲存' },
  'ec9.action.cancel':      { 'zh-CN': '取消',   en: 'Cancel',            'zh-TW': '取消' },
  'ec9.action.export':      { 'zh-CN': '导出 CSV', en: 'Export CSV',       'zh-TW': '匯出 CSV' },

  // ---------- 通用字段名 ----------
  'ec9.field.status':       { 'zh-CN': '状态',   en: 'Status',            'zh-TW': '狀態' },
  'ec9.field.action':       { 'zh-CN': '操作',   en: 'Actions',           'zh-TW': '操作' },
  'ec9.field.sort':         { 'zh-CN': '排序',   en: 'Sort',              'zh-TW': '排序' },
  'ec9.field.amount':       { 'zh-CN': '金额',   en: 'Amount',            'zh-TW': '金額' },
  'ec9.field.quantity':     { 'zh-CN': '数量',   en: 'Quantity',          'zh-TW': '數量' },
  'ec9.field.locked':       { 'zh-CN': '锁定',   en: 'Locked',            'zh-TW': '鎖定' },
  'ec9.field.sold':         { 'zh-CN': '已售',   en: 'Sold',              'zh-TW': '已售' },
  'ec9.field.remaining':    { 'zh-CN': '剩余',   en: 'Available',         'zh-TW': '剩餘' },
  'ec9.field.allSessions':  { 'zh-CN': '全部场次', en: 'All Sessions',     'zh-TW': '全部場次' },
  'ec9.field.unlimited':    { 'zh-CN': '不限',   en: 'Unlimited',         'zh-TW': '不限' },
  'ec9.field.notSet':       { 'zh-CN': '未设置', en: 'Not set',           'zh-TW': '未設定' },
  'ec9.field.loadFail':     { 'zh-CN': '加载失败', en: 'Failed to load',  'zh-TW': '載入失敗' },
  'ec9.field.loading':      { 'zh-CN': '加载中', en: 'Loading...',        'zh-TW': '載入中' },
  'ec9.field.empty':        { 'zh-CN': '暂无数据', en: 'No data',         'zh-TW': '暫無資料' },
  'ec9.field.saveFail':     { 'zh-CN': '保存失败', en: 'Failed to save',  'zh-TW': '儲存失敗' },

  // ---------- 场次 ----------
  'ec9.session.title':      { 'zh-CN': '场次名称', en: 'Session Name',    'zh-TW': '場次名稱' },
  'ec9.session.create':     { 'zh-CN': '新增场次', en: 'New Session',     'zh-TW': '新增場次' },
  'ec9.session.editTitle':  { 'zh-CN': '编辑场次', en: 'Edit Session',    'zh-TW': '編輯場次' },
  'ec9.session.start':      { 'zh-CN': '开始时间', en: 'Start Time',      'zh-TW': '開始時間' },
  'ec9.session.end':        { 'zh-CN': '结束时间', en: 'End Time',        'zh-TW': '結束時間' },
  'ec9.session.location':   { 'zh-CN': '地点',   en: 'Location',          'zh-TW': '地點' },
  'ec9.session.capacity':   { 'zh-CN': '容量',   en: 'Capacity',          'zh-TW': '容量' },
  'ec9.session.enabled':    { 'zh-CN': '启用',   en: 'Enabled',           'zh-TW': '啟用' },
  'ec9.session.disabled':   { 'zh-CN': '停用',   en: 'Disabled',          'zh-TW': '停用' },
  'ec9.session.phName':     { 'zh-CN': '请输入场次名称', en: 'Enter session name', 'zh-TW': '請輸入場次名稱' },
  'ec9.session.phLocation': { 'zh-CN': '如：深圳国际会展中心', en: 'e.g. Shenzhen Convention Center', 'zh-TW': '如：深圳國際會展中心' },

  // ---------- 票种 ----------
  'ec9.tt.title':           { 'zh-CN': '票种名称', en: 'Ticket Type Name', 'zh-TW': '票種名稱' },
  'ec9.tt.create':          { 'zh-CN': '新增票种', en: 'New Ticket Type', 'zh-TW': '新增票種' },
  'ec9.tt.editTitle':       { 'zh-CN': '编辑票种', en: 'Edit Ticket Type', 'zh-TW': '編輯票種' },
  'ec9.tt.price':           { 'zh-CN': '价格（元）', en: 'Price (CNY)',   'zh-TW': '價格（元）' },
  'ec9.tt.priceShort':     { 'zh-CN': '价格',   en: 'Price',            'zh-TW': '價格' },
  'ec9.tt.stockTotal':      { 'zh-CN': '总库存', en: 'Total Stock',       'zh-TW': '總庫存' },
  'ec9.tt.saleEnd':         { 'zh-CN': '售卖截止', en: 'Sale Ends',      'zh-TW': '銷售截止' },
  'ec9.tt.onShelf':         { 'zh-CN': '上架',   en: 'Listed',            'zh-TW': '上架' },
  'ec9.tt.offShelf':        { 'zh-CN': '下架',   en: 'Delisted',          'zh-TW': '下架' },
  'ec9.tt.adjustStock':     { 'zh-CN': '调整库存', en: 'Adjust Stock',    'zh-TW': '調整庫存' },
  'ec9.tt.description':     { 'zh-CN': '描述',   en: 'Description',       'zh-TW': '描述' },
  'ec9.tt.i18nName':        { 'zh-CN': '多语言名称（选填，留空则与上方一致）', en: 'Localized name (optional; defaults to the above)', 'zh-TW': '多語言名稱（選填，預設與上方一致）' },
  'ec9.tt.phName':          { 'zh-CN': '如：早鸟票', en: 'e.g. Early Bird', 'zh-TW': '如：早鳥票' },
  'ec9.tt.phTw':            { 'zh-CN': '繁体中文名称', en: 'Traditional Chinese name', 'zh-TW': '繁體中文名稱' },
  'ec9.tt.phEn':            { 'zh-CN': '英文名称', en: 'English name',   'zh-TW': '英文名稱' },
  'ec9.tt.phDesc':          { 'zh-CN': '票种说明（选填）', en: 'Ticket description (optional)', 'zh-TW': '票種說明（選填）' },
  'ec9.tt.phStock':         { 'zh-CN': '0 表示不限', en: '0 means unlimited', 'zh-TW': '0 表示不限' },
  'ec9.tt.phCapacity':      { 'zh-CN': '0 表示不限', en: '0 means unlimited', 'zh-TW': '0 表示不限' },

  // ---------- 订单 ----------
  'ec9.order.total':        { 'zh-CN': '订单总数', en: 'Total Orders',   'zh-TW': '訂單總數' },
  'ec9.order.paid':         { 'zh-CN': '已支付',   en: 'Paid',           'zh-TW': '已支付' },
  'ec9.order.paidAmount':   { 'zh-CN': '已支付金额', en: 'Paid Amount',  'zh-TW': '已支付金額' },
  'ec9.order.no':           { 'zh-CN': '订单号',   en: 'Order No.',       'zh-TW': '訂單號' },
  'ec9.order.allStatus':    { 'zh-CN': '全部状态', en: 'All Statuses',    'zh-TW': '全部狀態' },
  'ec9.order.pending':      { 'zh-CN': '待支付',   en: 'Pending',         'zh-TW': '待支付' },
  'ec9.order.pendingPay':   { 'zh-CN': '待付款',   en: 'Awaiting Payment','zh-TW': '待付款' },
  'ec9.order.closed':       { 'zh-CN': '已关闭',   en: 'Closed',          'zh-TW': '已關閉' },
  'ec9.order.refunded':     { 'zh-CN': '已退款',   en: 'Refunded',        'zh-TW': '已退款' },
  'ec9.order.guest':        { 'zh-CN': '参会人',   en: 'Attendee',        'zh-TW': '參會人' },
  'ec9.order.tt':           { 'zh-CN': '票种',     en: 'Ticket Type',     'zh-TW': '票種' },
  'ec9.order.session':      { 'zh-CN': '场次',     en: 'Session',         'zh-TW': '場次' },
  'ec9.order.qtyAmount':    { 'zh-CN': '数量 / 金额', en: 'Qty / Amount', 'zh-TW': '數量 / 金額' },
  'ec9.order.createdAt':    { 'zh-CN': '下单时间', en: 'Placed At',       'zh-TW': '下單時間' },
  'ec9.order.paidAt':       { 'zh-CN': '支付时间', en: 'Paid At',         'zh-TW': '支付時間' },
  'ec9.order.wxTrans':      { 'zh-CN': '微信交易号', en: 'Transaction ID', 'zh-TW': '微信交易號' },
  'ec9.order.checkinCode':  { 'zh-CN': '签到码',   en: 'Check-in Code',   'zh-TW': '簽到碼' },
  'ec9.order.closeReason':  { 'zh-CN': '关闭原因', en: 'Close Reason',    'zh-TW': '關閉原因' },
  'ec9.order.remark':       { 'zh-CN': '后台备注', en: 'Internal Note',   'zh-TW': '後台備註' },
  'ec9.order.phRemark':     { 'zh-CN': '仅后台可见，参会人看不到', en: 'Visible to staff only', 'zh-TW': '僅後台可見，參會人看不到' },
  'ec9.order.phKeyword':    { 'zh-CN': '订单号 / 参会人', en: 'Order no. / attendee', 'zh-TW': '訂單號 / 參會人' },
  'ec9.order.detail':       { 'zh-CN': '订单详情', en: 'Order Details',   'zh-TW': '訂單詳情' },
  'ec9.order.saved':        { 'zh-CN': '备注已保存', en: 'Note saved',    'zh-TW': '備註已儲存' },
  'ec9.order.syncFail':     { 'zh-CN': '查单失败', en: 'Query failed',    'zh-TW': '查單失敗' },
  'ec9.order.synced':       { 'zh-CN': '已同步',   en: 'Synced',          'zh-TW': '已同步' },
  'ec9.order.saveRemark':  { 'zh-CN': '保存备注', en: 'Save Note',       'zh-TW': '儲存備註' },
  'ec9.order.wxQuery':     { 'zh-CN': '微信查单', en: 'Query WeChat',    'zh-TW': '微信查單' },
  'ec9.order.phWxQuery':   { 'zh-CN': '向微信支付查询该订单的真实状态', en: 'Query the real payment status from WeChat Pay', 'zh-TW': '向微信支付查詢該訂單的真實狀態' },
  'ec9.order.enable':      { 'zh-CN': '启用',   en: 'Enable',           'zh-TW': '啟用' },
  'ec9.order.saveOk':      { 'zh-CN': '保存成功', en: 'Saved',          'zh-TW': '儲存成功' },
  'ec9.order.exportFail':   { 'zh-CN': '导出失败', en: 'Export failed',   'zh-TW': '匯出失敗' },

  // ---------- 支付 ----------
  'ec9.pay.total':          { 'zh-CN': '流水总数', en: 'Total Records',   'zh-TW': '流水總數' },
  'ec9.pay.success':        { 'zh-CN': '成功',     en: 'Success',         'zh-TW': '成功' },
  'ec9.pay.successAmount':  { 'zh-CN': '成功金额', en: 'Success Amount',  'zh-TW': '成功金額' },
  'ec9.pay.diff':           { 'zh-CN': '对账差异', en: 'Reconciliation Issues', 'zh-TW': '對帳差異' },
  'ec9.pay.reconcile':      { 'zh-CN': '对账',     en: 'Reconcile',       'zh-TW': '對帳' },
  'ec9.pay.outTradeNo':     { 'zh-CN': '商户订单号', en: 'Merchant Order No.', 'zh-TW': '商戶訂單號' },
  'ec9.pay.channel':        { 'zh-CN': '渠道',     en: 'Channel',         'zh-TW': '支付管道' },
  'ec9.pay.detail':         { 'zh-CN': '支付详情', en: 'Payment Details', 'zh-TW': '支付詳情' },
  'ec9.pay.createdAt':      { 'zh-CN': '创建时间', en: 'Created At',      'zh-TW': '建立時間' },
  'ec9.pay.refundedAt':     { 'zh-CN': '退款时间', en: 'Refunded At',     'zh-TW': '退款時間' },
  'ec9.pay.relatedOrder':   { 'zh-CN': '关联订单', en: 'Related Order',   'zh-TW': '關聯訂單' },
  'ec9.pay.failReason':     { 'zh-CN': '失败原因', en: 'Failure Reason',  'zh-TW': '失敗原因' },
  'ec9.pay.rawCallback':    { 'zh-CN': '微信原始回调', en: 'Raw WeChat Callback', 'zh-TW': '微信原始回調' },
  'ec9.pay.processing':     { 'zh-CN': '处理中',   en: 'Processing',      'zh-TW': '處理中' },
  'ec9.pay.failed':         { 'zh-CN': '失败',     en: 'Failed',          'zh-TW': '失敗' },
  'ec9.pay.consistent':     { 'zh-CN': '一致',     en: 'Matched',         'zh-TW': '一致' },
  'ec9.pay.phKeyword':      { 'zh-CN': '商户订单号', en: 'Merchant order no.', 'zh-TW': '商戶訂單號' },
  'ec9.pay.detailTitle':    { 'zh-CN': '支付详情', en: 'Payment Details', 'zh-TW': '支付詳情' },

  // ---------- 对账差异类型（与后端 issue.type 对应） ----------
  'ec9.issue.orphan_payment':           { 'zh-CN': '流水指向的订单不存在', en: 'Payment has no matching order', 'zh-TW': '流水指向的訂單不存在' },
  'ec9.issue.order_paid_no_payment':    { 'zh-CN': '订单已支付但无成功流水', en: 'Order paid but no successful payment', 'zh-TW': '訂單已支付但無成功流水' },
  'ec9.issue.payment_success_order_not_paid': { 'zh-CN': '流水成功但订单未标记已支付', en: 'Payment succeeded but order not marked paid', 'zh-TW': '流水成功但訂單未標記已支付' },
  'ec9.issue.amount_mismatch':         { 'zh-CN': '流水金额与订单实付不一致', en: 'Payment amount does not match order', 'zh-TW': '流水金額與訂單實付不一致' }
};

/**
 * 递归写入到指定语言包的命名空间下。
 *
 * key 形如 'ec9.order.paid' → 包里是 { ec9: { order: { paid: '已支付' } } }
 * ⚠️ 去掉 'ec9' 前缀后，剩下的段要**全部**作为路径，只有最后一段是叶节点。
 */
function writeTerms(pack, lang) {
  if (!pack.ec9) pack.ec9 = {};
  let added = 0;
  for (const key of Object.keys(TERMS)) {
    const parts = key.split('.');          // ['ec9','order','paid']
    const path = parts.slice(1);           // ['order','paid']
    const leaf = path[path.length - 1];
    let node = pack.ec9;
    // 逐层下钻到父节点
    for (let i = 0; i < path.length - 1; i++) {
      if (!node[path[i]] || typeof node[path[i]] !== 'object') node[path[i]] = {};
      node = node[path[i]];
    }
    if (node[leaf] !== undefined) continue;   // 已存在，不覆盖
    node[leaf] = TERMS[key][lang];
    added++;
  }
  return added;
}

const LANGS = ['zh-CN', 'en', 'zh-TW'];
let totalAdded = 0;

for (const lang of LANGS) {
  const f = path.join(PUB, lang + '.json');
  const pack = JSON.parse(fs.readFileSync(f, 'utf8'));
  const n = writeTerms(pack, lang);
  totalAdded += n;
  console.log(`  ${lang}: 新增 ${n} 条`);
  if (!DRY) {
    fs.writeFileSync(f, JSON.stringify(pack, null, 2) + '\n', 'utf8');
  }
}

console.log(`\n共新增 ${totalAdded} 条（${Object.keys(TERMS).length} 个 key × ${LANGS.length} 语种）`);
console.log(DRY ? '[dry-run] 未写入文件' : '已写入 ' + PUB);

// 自检：
//  1) 三语齐全（缺值会让 t() 回落成 key，页面露出 "ec9.xxx"）
//  2) 英文必须与中文不同（否则切英文时该词不动，看着像没生效）
//  3) 繁中与简体同形是**正常**的（如「刷新」「取消」「操作」繁简写法一致），
//     不算问题；只有本该不同却写成一样时才提示，避免噪音淹没真问题。
let bad = 0;
const sameZhTw = [];
for (const key of Object.keys(TERMS)) {
  const v = TERMS[key];
  if (!v['zh-CN'] || !v.en || !v['zh-TW']) { console.log(`  ! ${key} 有空值`); bad++; }
  if (v['zh-CN'] === v.en) { console.log(`  ! ${key} 中英相同，切英文不会变化`); bad++; }
  if (v['zh-CN'] === v['zh-TW']) sameZhTw.push(v['zh-CN']);
}
console.log(bad
  ? `\n⚠️ ${bad} 个 key 需要修正`
  : `\n✅ 自检通过：${Object.keys(TERMS).length} 个 key 三语齐全，中英均有差异`);
if (sameZhTw.length) {
  console.log(`ℹ️ 其中 ${sameZhTw.length} 个词繁简同形（属正常，转繁不产生变化）：`);
  console.log('   ' + sameZhTw.join('、'));
}