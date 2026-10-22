/**
 * EC9 支付链路单元测试（不依赖数据库，验证纯逻辑层）
 * 用法：cd backend && node test-payment.js
 * 覆盖：XML 解析/构建、V2 签名、mock 下单/回调验签、金额换算、订单号格式
 */
const config = require('./config');
const xml = require('./utils/xml');
const wechat = require('./services/wechatPayService');
const orderService = require('./services/orderService');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}

console.log('[1] XML 工具');
const notifyXml = '<xml><appid><![CDATA[wx123]]></appid><bank_type>CFT</bank_type><total_fee>39900</total_fee><out_trade_no><![CDATA[EC920261014120000123456]]></out_trade_no><transaction_id><![CDATA[42000]]></transaction_id><return_code><![CDATA[SUCCESS]]></return_code></xml>';
const parsed = xml.parse(notifyXml);
check('XML 解析 appid', parsed.appid === 'wx123', JSON.stringify(parsed.appid));
check('XML 解析普通节点', parsed.bank_type === 'CFT' && parsed.total_fee === '39900');
check('XML 解析订单号', parsed.out_trade_no === 'EC920261014120000123456');
const rebuilt = xml.build({ return_code: 'SUCCESS', return_msg: '含<特殊>字符&符号' });
check('XML 构建 CDATA 转义', rebuilt.includes('<![CDATA[含<特殊>字符&符号]]>'), rebuilt);
check('XML 构建根节点', rebuilt.startsWith('<xml>') && rebuilt.endsWith('</xml>'));

console.log('\n[2] V2 签名');
const signParams = { appid: 'wx123', mch_id: '1600000000', nonce_str: 'abc', body: 'test', out_trade_no: 'EC9X', total_fee: '100' };
const s1 = wechat.sign(signParams, 'KEY19200525abcXYZ1234567890abcdef');
const s2 = wechat.sign({ ...signParams }, 'KEY19200525abcXYZ1234567890abcdef');
check('签名确定性（排序+MD5 大写）', s1 === s2 && /^[0-9A-F]{32}$/.test(s1), s1);
const s3 = wechat.sign(signParams, 'differentkey1234567890abcdefgh');
check('不同密钥签名不同', s1 !== s3);

console.log('\n[3] mock 模式全链路');
(async () => {
  check('当前为 mock 模式', config.wechatPay.mode === 'mock', config.wechatPay.mode);

  const orderNo = orderService.genOrderNo();
  check('订单号格式 EC9+14位+6位', /^EC9\d{20}$/.test(orderNo), orderNo);

  const up = await wechat.unifiedOrder({
    orderNo, body: 'EC9测试订单', totalFeeFen: 39900, ip: '127.0.0.1'
  });
  check('mock 统一下单成功', up.ok === true && up.mock === true && up.codeUrl.startsWith('weixin://'), JSON.stringify(up));
  check('mock prepay_id 生成', !!up.prepayId);

  const notifyBody = xml.build({
    return_code: 'SUCCESS',
    result_code: 'SUCCESS',
    out_trade_no: orderNo,
    total_fee: '39900',
    transaction_id: 'MOCKTXN001'
  });
  const verified = await wechat.verifyNotify(notifyBody);
  check('mock 回调验签通过', verified.ok === true, JSON.stringify(verified));
  check('回调数据完整', verified.data && verified.data.out_trade_no === orderNo);

  const badNotify = xml.build({ return_code: 'FAIL', out_trade_no: orderNo });
  const badVerified = await wechat.verifyNotify(badNotify);
  check('FAIL 报文被拒绝', badVerified.ok === false, JSON.stringify(badVerified));

  const q = await wechat.queryOrder(orderNo);
  check('mock 订单查询', q.ok === true && q.mock === true);

  const rf = await wechat.refund({ outTradeNo: orderNo, totalFeeFen: 39900, refundFeeFen: 39900, refundNo: 'RF' + orderNo + '01' });
  check('mock 退款直接成功', rf.ok === true && rf.mock === true);

  console.log('\n[4] 金额换算');
  check('元转分 399.00 → 39900', orderService.yuanToFen('399.00') === 39900);
  check('分转元 39900 → 399.00', orderService.fenToYuan(39900) === '399.00');
  check('元转分 0.01 → 1（防浮点）', orderService.yuanToFen('0.01') === 1);
  check('元转分 1299.99 → 129999', orderService.yuanToFen('1299.99') === 129999);

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('运行异常:', e); process.exit(1); });
