/**
 * 补「支付配置」词条（zh-CN / en），随后用 build-zh-tw.js 生成 zh-TW
 * 用法：cd backend && node scripts/add-paycfg-terms.js
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'public', 'i18n');

const ZH = {
  nav: { payConfig: '支付配置' },
  field: { enabled: '启用', disabled: '停用', remark: '备注' },
  payCfg: {
    currentMode: '当前模式',
    source: '配置来源',
    channelStatus: '渠道状态',
    updatedAt: '最近更新',
    mode: '运行模式',
    modeMock: 'mock · 模拟（无资质开发）',
    modeSandbox: 'sandbox · 微信沙箱',
    modeReal: 'real · 生产',
    modeHint: 'mock 不产生真实交易；客户资质到位后切 real 并填写商户参数',
    enabled: '渠道状态',
    appId: '公众号 AppID',
    appIdPh: 'wx 开头的 AppID',
    appIdHint: 'Native 扫码支付填公众号或小程序的 AppID',
    mchId: '商户号',
    mchIdPh: '微信支付商户号',
    apiKey: 'API v2 密钥',
    apiKeyPh: '留空表示不修改',
    apiV3Key: 'API v3 密钥（预留）',
    keySet: '已设置',
    keyUnset: '未设置',
    keyKeepHint: '留空则不修改',
    signType: '签名类型',
    certPath: 'API 证书路径（退款用）',
    certPathPh: 'apiclient_cert.p12 绝对路径',
    certHint: '仅退款需要，下单不受影响；留空则退款不可用',
    notifyUrl: '支付回调地址',
    notifyUrlPh: '/api/payment/notify',
    notifyHint: '填相对路径会自动拼接站点域名；生产环境必须是 https 且外网可访问',
    refundNotifyUrl: '退款回调地址',
    refundNotifyUrlPh: '可留空',
    expire: '订单有效期（分钟）',
    expireHint: '超时未支付自动关单并释放库存',
    remarkPh: '选填',
    save: '保存并生效',
    test: '配置自检',
    reload: '重新载入',
    saved: '支付配置已保存并生效，无需重启',
    saveFailed: '保存失败',
    needMchId: '生产模式必须填写商户号',
    testPass: '配置检查通过',
    testFail: '配置存在问题，请修正后再启用生产模式',
    noIssue: '没有需要提示的项',
    sourceDb: '数据库',
    sourceEnv: '环境变量',
    issue: {
    modeMock: '当前为模拟模式：下单返回假 code_url，不产生真实交易，适合开发联调',
    missingAppId: '缺少 appid',
    missingMchId: '缺少商户号',
    missingApiKey: '缺少 API 密钥',
    missingNotifyUrl: '缺少支付回调地址',
    appIdFormat: 'appid 格式看起来不像微信 appid（通常以 wx 开头）',
    mchIdFormat: '商户号应为 6~12 位数字，当前为：{0}',
    apiKeyLength: 'API v2 密钥一般为 {0} 位，当前 {1} 位',
    notifyRelative: '回调地址是相对路径，下单时会自动拼接站点域名：{0}',
    notifyNotHttps: '回调地址不是 https，微信生产环境要求 https',
    certMissing: '证书文件不存在，退款将不可用：{0}',
    certOk: 'API 证书文件可读',
    certUnset: '未配置 API 证书，退款功能不可用（下单不受影响）',
    disabled: '支付渠道当前为停用状态'
  }
}
};

const EN = {
  nav: { payConfig: 'Payment Settings' },
  field: { enabled: 'Enabled', disabled: 'Disabled', remark: 'Remark' },
  payCfg: {
    currentMode: 'Current Mode',
    source: 'Config Source',
    channelStatus: 'Channel Status',
    updatedAt: 'Last Updated',
    mode: 'Run Mode',
    modeMock: 'mock · Simulation (no credentials needed)',
    modeSandbox: 'sandbox · WeChat Sandbox',
    modeReal: 'real · Production',
    modeHint: 'mock creates no real transactions; switch to real once the merchant credentials are ready',
    enabled: 'Channel Status',
    appId: 'Official Account AppID',
    appIdPh: 'AppID starting with wx',
    appIdHint: 'For Native QR payment, use the AppID of the official account or mini program',
    mchId: 'Merchant ID',
    mchIdPh: 'WeChat Pay merchant ID',
    apiKey: 'API v2 Key',
    apiKeyPh: 'Leave blank to keep unchanged',
    apiV3Key: 'API v3 Key (reserved)',
    keySet: 'Set',
    keyUnset: 'Not set',
    keyKeepHint: 'leave blank to keep unchanged',
    signType: 'Signature Type',
    certPath: 'API Certificate Path (for refunds)',
    certPathPh: 'Absolute path to apiclient_cert.p12',
    certHint: 'Only needed for refunds; leaving it blank disables refunds',
    notifyUrl: 'Payment Notify URL',
    notifyUrlPh: '/api/payment/notify',
    notifyHint: 'Relative paths are prefixed with the site domain; production requires https and public access',
    refundNotifyUrl: 'Refund Notify URL',
    refundNotifyUrlPh: 'Optional',
    expire: 'Order Validity (minutes)',
    expireHint: 'Unpaid orders are closed automatically and stock is released',
    remarkPh: 'Optional',
    save: 'Save & Apply',
    test: 'Self-check',
    reload: 'Reload',
    saved: 'Payment settings saved and applied — no restart needed',
    saveFailed: 'Failed to save',
    needMchId: 'Merchant ID is required in production mode',
    testPass: 'Configuration check passed',
    testFail: 'Configuration has issues — fix them before enabling production mode',
    noIssue: 'Nothing to report',
    sourceDb: 'Database',
    sourceEnv: 'Environment variables'
  ,
  issue: {
    modeMock: 'Running in mock mode: orders return a fake code_url and no real transaction is created (for local dev)',
    missingAppId: 'Missing AppID',
    missingMchId: 'Missing merchant ID',
    missingApiKey: 'Missing API key',
    missingNotifyUrl: 'Missing payment notify URL',
    appIdFormat: 'The AppID does not look like a WeChat AppID (usually starts with wx)',
    mchIdFormat: 'Merchant ID should be 6–12 digits, current value: {0}',
    apiKeyLength: 'API v2 key is usually {0} characters, current: {1}',
    notifyRelative: 'The notify URL is a relative path; the site domain will be prepended automatically: {0}',
    notifyNotHttps: 'The notify URL is not https — WeChat production requires https',
    certMissing: 'Certificate file not found, refunds will be unavailable: {0}',
    certOk: 'API certificate file is readable',
    certUnset: 'No API certificate configured — refunds unavailable (payments still work)',
    disabled: 'The payment channel is currently disabled'
  }
}
};

function mergeInto(file, obj) {
  const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  let added = 0, changed = 0;
  for (const [group, items] of Object.entries(obj)) {
    pack.ec9 = pack.ec9 || {};
    pack.ec9[group] = pack.ec9[group] || {};
    for (const [k, v] of Object.entries(items)) {
      if (pack.ec9[group][k] === v) continue;
      if (pack.ec9[group][k] === undefined) added++; else changed++;
      pack.ec9[group][k] = v;
    }
  }
  fs.writeFileSync(file, JSON.stringify(pack, null, 2) + '\n', 'utf8');
  console.log(`${path.basename(file)}: 新增 ${added} / 覆盖 ${changed}`);
}

mergeInto(path.join(DIR, 'zh-CN.json'), ZH);
mergeInto(path.join(DIR, 'en.json'), EN);
console.log('下一步：node scripts/build-zh-tw.js');
