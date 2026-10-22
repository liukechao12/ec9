/**
 * 初始化支付配置表：建表 + 从 .env 播种首条微信支付配置
 *
 * 用法：cd backend && node scripts/init-payment-config.js [--force]
 *   --force  已存在配置时也用 .env 覆盖（一般不用，后台改过之后别覆盖）
 *
 * 幂等：表用 CREATE TABLE IF NOT EXISTS；配置行已存在则跳过（除非 --force）
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const MIGRATION = path.join(__dirname, '..', '..', 'database', 'migrations', 'add_payment_configs.sql');

async function main() {
  const force = process.argv.includes('--force');
  const dbConfig = {
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  };
  console.log(`目标库: ${dbConfig.user}@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);

  const client = new Client(dbConfig);
  await client.connect();

  console.log('执行迁移 add_payment_configs.sql ...');
  await client.query(fs.readFileSync(MIGRATION, 'utf8'));
  console.log('表 ec9_payment_configs 已就位');

  const exist = await client.query(
    `SELECT id, mode, mch_id FROM ec9_payment_configs WHERE channel = 'wechat'`
  );

  if (exist.rows.length && !force) {
    const r = exist.rows[0];
    console.log(`配置已存在（id=${r.id}, mode=${r.mode}, mch_id=${r.mch_id || '-'}），跳过播种`);
    console.log('如需用 .env 覆盖，加 --force');
    await client.end();
    return;
  }

  // 播种：把 .env 里的 WXPAY_* 原样搬进库（密钥明文在库里仍是加密的，由 service 层加密）
  const { encryptSecret } = require('../utils/secretCrypto');
  const mode = process.env.WXPAY_MODE || 'mock';
  const row = {
    channel: 'wechat',
    mode,
    enabled: 1,
    app_id: process.env.WXPAY_APP_ID || null,
    mch_id: process.env.WXPAY_MCH_ID || null,
    api_key_enc: encryptSecret(process.env.WXPAY_API_KEY || ''),
    api_v3_key_enc: encryptSecret(''),
    sign_type: process.env.WXPAY_SIGN_TYPE || 'MD5',
    cert_path: process.env.WXPAY_CERT_PATH || null,
    notify_url: process.env.WXPAY_NOTIFY_URL || '/api/payment/notify',
    refund_notify_url: process.env.WXPAY_REFUND_NOTIFY_URL || null,
    order_expire_minutes: 30
  };

  if (exist.rows.length && force) {
    await client.query(
      `UPDATE ec9_payment_configs SET mode=$1, enabled=$2, app_id=$3, mch_id=$4,
        api_key_enc=$5, sign_type=$6, cert_path=$7, notify_url=$8, refund_notify_url=$9,
        updated_at = NOW() WHERE channel='wechat'`,
      [row.mode, row.enabled, row.app_id, row.mch_id, row.api_key_enc, row.sign_type,
        row.cert_path, row.notify_url, row.refund_notify_url]
    );
    console.log('已用 .env 覆盖现有配置');
  } else {
    await client.query(
      `INSERT INTO ec9_payment_configs
        (channel, mode, enabled, app_id, mch_id, api_key_enc, api_v3_key_enc, sign_type,
         cert_path, notify_url, refund_notify_url, order_expire_minutes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [row.channel, row.mode, row.enabled, row.app_id, row.mch_id, row.api_key_enc,
        row.api_v3_key_enc, row.sign_type, row.cert_path, row.notify_url,
        row.refund_notify_url, row.order_expire_minutes]
    );
    console.log(`已播种配置（mode=${mode}）`);
  }

  await client.end();
  console.log('DONE');
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
