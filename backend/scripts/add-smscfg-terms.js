/**
 * 补「短信配置」词条（zh-CN / en），随后用 build-zh-tw.js 生成 zh-TW
 * 用法：cd backend && node scripts/add-smscfg-terms.js
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'public', 'i18n');

const ZH = {
  nav: { smsConfig: '短信配置' },
  smsCfg: {
    channelStatus: '通道状态',
    source: '配置来源',
    signName: '短信签名',
    enabled: '通道状态',
    enabledHint: '停用时不发真实短信，走本地 mock（开发期可先停用）',
    region: '地域',
    regionPh: 'cn-hangzhou',
    akId: 'AccessKey ID',
    akIdPh: 'LTAI 开头',
    akSecret: 'AccessKey Secret',
    signPh: '需在服务商后台报备通过',
    verifyTpl: '验证码模板 CODE',
    verifyTplPh: 'SMS_ 开头',
    expire: '验证码有效期（分钟）',
    resend: '重发间隔（秒）',
    dailyLimit: '单号码每日上限',
    maxAttempts: '验证码最大尝试次数',
    endpoint: 'Endpoint（可留空）',
    endpointPh: 'dysmsapi.aliyuncs.com',
    ready: '可用',
    notReady: '缺参数',
    saved: '短信配置已保存并生效，无需重启',
    testReady: '通道可用，可发起真实发送',
    testFail: '通道暂不可用，请补全参数',
    issue: {
      disabled: '短信通道当前为停用状态，不会真正发送（开发期可忽略）',
      missingAkId: '缺少 AccessKey ID',
      missingAkSecret: '缺少 AccessKey Secret',
      missingSign: '未配置短信签名，发送会被服务商拒绝',
      missingVerifyTpl: '未配置验证码模板 CODE，手机号验证短信无法发送',
      akIdFormat: 'AccessKey ID 通常以 LTAI 开头，当前值看起来不像：{0}',
      staleSign: '签名仍是旧主体「云玺科技」，客户侧需换成实际报备的签名',
      allGood: '通道参数齐全，可发起真实发送'
    }
  }
};

const EN = {
  nav: { smsConfig: 'SMS Settings' },
  smsCfg: {
    channelStatus: 'Channel Status',
    source: 'Config Source',
    signName: 'SMS Signature',
    enabled: 'Channel Status',
    enabledHint: 'When disabled no real SMS is sent — a local mock is used (fine for development)',
    region: 'Region',
    regionPh: 'cn-hangzhou',
    akId: 'AccessKey ID',
    akIdPh: 'Starts with LTAI',
    akSecret: 'AccessKey Secret',
    signPh: 'Must be approved by the provider first',
    verifyTpl: 'Verification Code Template CODE',
    verifyTplPh: 'Starts with SMS_',
    expire: 'Code Validity (minutes)',
    resend: 'Resend Interval (seconds)',
    dailyLimit: 'Daily Limit per Number',
    maxAttempts: 'Max Attempts per Code',
    endpoint: 'Endpoint (optional)',
    endpointPh: 'dysmsapi.aliyuncs.com',
    ready: 'Ready',
    notReady: 'Incomplete',
    saved: 'SMS settings saved and applied — no restart needed',
    testReady: 'Channel is ready — real messages can be sent',
    testFail: 'Channel not usable yet — complete the required fields',
    issue: {
      disabled: 'SMS channel is disabled: no real message will be sent (fine during development)',
      missingAkId: 'Missing AccessKey ID',
      missingAkSecret: 'Missing AccessKey Secret',
      missingSign: 'No SMS signature configured — the provider will reject sends',
      missingVerifyTpl: 'No verification code template configured — phone verification SMS cannot be sent',
      akIdFormat: 'AccessKey ID usually starts with LTAI; the current value looks wrong: {0}',
      staleSign: 'Signature still belongs to the old entity (Yunxi) — replace it with the customer’s approved signature',
      allGood: 'Channel parameters are complete — real sends are possible'
    }
  }
};

function mergeInto(file, obj) {
  const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  let added = 0, changed = 0;
  pack.ec9 = pack.ec9 || {};
  for (const [group, items] of Object.entries(obj)) {
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
