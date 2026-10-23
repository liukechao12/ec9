/**
 * EC9 统一配置 —— 全部走环境变量，无任何硬编码密钥
 * 配置来源：backend/.env（开发）/ 部署机 .env.production.local（生产）
 */
require('dotenv').config();

const config = {
  // ==================== 服务器 ====================
  server: {
    port: parseInt(process.env.PORT) || 7098,
    host: process.env.HOST || '0.0.0.0',
    env: process.env.NODE_ENV || 'development',
    corsOrigin: process.env.CORS_ORIGIN || '*'
  },

  // ==================== 数据库 ====================
  // 开发期：本机 PostgreSQL（localhost:5432/ec9，ec9_ 前缀表）
  // 客户独立库账号到位后：改 DB_HOST / DB_NAME / DB_USER / DB_PASSWORD 即切换
  database: {
    name: process.env.DB_NAME || 'ec9',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432
  },

  // ==================== JWT ====================
  jwt: {
    secret: process.env.JWT_SECRET || '',
    expiresIn: parseInt(process.env.JWT_EXPIRES_IN) || 604800
  },

  // ==================== 加密（手机号 AES） ====================
  encryption: {
    key: process.env.ENCRYPTION_KEY || '',
    getKey() {
      let key = this.key;
      if (key.length < 32) key = key.padEnd(32, '!');
      else if (key.length > 32) key = key.substring(0, 32);
      return key;
    }
  },

  // ==================== 手机号索引 HMAC 密钥 ====================
  // EC9 专用：替代 EC8 的无盐裸 SHA256，过程密钥独立管理
  phoneHmac: {
    key: process.env.PHONE_HMAC_KEY || ''
  },

  // ==================== 短信 ====================
  sms: {
    accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID || '',
    accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET || '',
    region: process.env.ALIYUN_SMS_REGION || 'cn-hangzhou',
    verificationCodeTemplate: process.env.SMS_VERIFICATION_CODE_TEMPLATE || '',
    verificationCodeSign: process.env.SMS_VERIFICATION_CODE_SIGN || '',   // 云玺为作废主体，不再作为默认值
    codeExpireMinutes: parseInt(process.env.SMS_CODE_EXPIRE_MINUTES) || 5,
    codeResendSeconds: parseInt(process.env.SMS_CODE_RESEND_SECONDS) || 60,
    codeMaxAttempts: parseInt(process.env.SMS_CODE_MAX_ATTEMPTS) || 5,
    codeDailyLimit: parseInt(process.env.SMS_CODE_DAILY_LIMIT) || 10,
    // 联调开关：设置后不发短信，验证码固定为该值（默认留空=关闭）
    // 例：SMS_FIXED_CODE=123456 —— 仅用于跑通流程，上线前必须删掉
    fixedCode: (process.env.SMS_FIXED_CODE || '').trim()
  },

  // ==================== 微信支付 ====================
  // mode: mock 本地模拟（无资质开发期，全链路可跑）
  //       sandbox 微信沙箱（需 mchId + apiKey）
  //       real 生产（需完整资质 + API 证书）
  wechatPay: {
    mode: process.env.WXPAY_MODE || 'mock',
    appId: process.env.WXPAY_APP_ID || '',
    mchId: process.env.WXPAY_MCH_ID || '',
    apiKey: process.env.WXPAY_API_KEY || '',
    notifyUrl: process.env.WXPAY_NOTIFY_URL || '/api/payment/notify',
    certPath: process.env.WXPAY_CERT_PATH || '',   // apiclient_cert.p12
    refundNotifyUrl: process.env.WXPAY_REFUND_NOTIFY_URL || '',
    signType: process.env.WXPAY_SIGN_TYPE || 'MD5'
  },

  // ==================== 前端 ====================
  frontend: {
    baseUrl: process.env.FRONTEND_URL || 'http://localhost:7098'
  },

  // ==================== 业务 ====================
  business: {
    inviteCodeLength: 16,
    checkinCodeLength: 16,
    tokenExpireHours: parseInt(process.env.VERIFICATION_TOKEN_EXPIRE_HOURS) || 2
  }
};

// ==================== 启动自检：缺密钥直接报错，不带病运行 ====================
function validateConfig() {
  const errors = [];
  if (!config.database.password) errors.push('缺少 DB_PASSWORD');
  if (!config.jwt.secret || config.jwt.secret.length < 32) errors.push('JWT_SECRET 未设置或过短（至少 32 字符）');
  if (!config.encryption.key) errors.push('缺少 ENCRYPTION_KEY（32 字符）');
  if (!config.phoneHmac.key) errors.push('缺少 PHONE_HMAC_KEY（手机号索引密钥）');
  // 短信付款链接 / 电子票链接都基于它，生产环境必须是真实域名，否则发出去的是 localhost
  if (process.env.NODE_ENV === 'production' || process.env.FORCE_PROD_CHECK === '1') {
    const url = config.frontend.baseUrl || '';
    if (!url) errors.push('缺少 FRONTEND_URL（短信付款链接的域名前缀）');
    else if (url.indexOf('localhost') > -1 || url.indexOf('127.0.0.1') > -1) {
      errors.push(`FRONTEND_URL 指向本机（${url}），生产环境必须配置真实域名，否则短信付款链接无法打开`);
    } else if (!/^https:\/\//.test(url)) {
      errors.push(`FRONTEND_URL 必须为 https 地址（当前：${url}）`);
    }
  }
  if (errors.length) {
    console.error('\n=== EC9 配置错误（拒绝启动）===');
    errors.forEach(e => console.error(' - ' + e));
    console.error('请检查 backend/.env\n');
    process.exit(1);
  }
}

validateConfig();

module.exports = config;
