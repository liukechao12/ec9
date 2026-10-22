/**
 * 初始化短信配置：加列 + 从 .env 播种首条阿里云通道配置
 *
 * 用法：cd backend && node scripts/init-sms-config.js [--force]
 *   --force  已存在配置时也用 .env 覆盖（后台改过之后别用）
 *
 * 幂等：ALTER TABLE ... IF NOT EXISTS；配置行已存在则跳过（除非 --force）
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const MIGRATION = path.join(__dirname, '..', '..', 'database', 'migrations', 'add_sms_provider_columns.sql');

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

  console.log('执行迁移 add_sms_provider_columns.sql ...');
  await client.query(fs.readFileSync(MIGRATION, 'utf8'));
  console.log('ec9_sms_providers 字段已补齐');

  const exist = await client.query(
    `SELECT id, name, enabled, sign_name FROM ec9_sms_providers WHERE name = 'aliyun'`
  );
  if (exist.rows.length && !force) {
    const r = exist.rows[0];
    console.log(`配置已存在（id=${r.id}, enabled=${r.enabled}, sign=${r.sign_name || '-'}），跳过播种`);
    console.log('如需用 .env 覆盖，加 --force');
    await client.end();
    return;
  }

  const { encryptSecret } = require('../utils/secretCrypto');
  const akId = process.env.ALIYUN_ACCESS_KEY_ID || '';
  const akSecret = process.env.ALIYUN_ACCESS_KEY_SECRET || '';
  const cred = encryptSecret(JSON.stringify({ accessKeyId: akId, accessKeySecret: akSecret }));
  const enabled = akId && akSecret ? 1 : 0;
  const row = {
    name: 'aliyun',
    enabled,
    is_default: 1,
    region: process.env.ALIYUN_SMS_REGION || 'cn-hangzhou',
    endpoint: null,
    sign_name: process.env.SMS_VERIFICATION_CODE_SIGN || null,
    verify_template_code: process.env.SMS_VERIFICATION_CODE_TEMPLATE || null,
    cred,
    code_expire_minutes: parseInt(process.env.SMS_CODE_EXPIRE_MINUTES) || 5,
    code_resend_seconds: parseInt(process.env.SMS_CODE_RESEND_SECONDS) || 60,
    code_max_attempts: parseInt(process.env.SMS_CODE_MAX_ATTEMPTS) || 5,
    code_daily_limit: parseInt(process.env.SMS_CODE_DAILY_LIMIT) || 10
  };

  if (exist.rows.length && force) {
    await client.query(
      `UPDATE ec9_sms_providers SET enabled=$1, region=$2, sign_name=$3, verify_template_code=$4,
        config_encrypted=$5, code_expire_minutes=$6, code_resend_seconds=$7,
        code_max_attempts=$8, code_daily_limit=$9, updated_at=NOW() WHERE name='aliyun'`,
      [row.enabled, row.region, row.sign_name, row.verify_template_code, row.cred,
        row.code_expire_minutes, row.code_resend_seconds, row.code_max_attempts, row.code_daily_limit]
    );
    console.log('已用 .env 覆盖现有配置');
  } else {
    await client.query(
      `INSERT INTO ec9_sms_providers
        (name, enabled, is_default, region, endpoint, sign_name, verify_template_code,
         config_encrypted, code_expire_minutes, code_resend_seconds, code_max_attempts, code_daily_limit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [row.name, row.enabled, row.is_default, row.region, row.endpoint, row.sign_name,
        row.verify_template_code, row.cred, row.code_expire_minutes, row.code_resend_seconds,
        row.code_max_attempts, row.code_daily_limit]
    );
    console.log(`已播种配置（enabled=${enabled}${enabled ? '' : '，凭证待后台填写'}）`);
  }

  await client.end();
  console.log('DONE');
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
