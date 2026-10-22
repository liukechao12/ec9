/**
 * EC9 schema 执行脚本（PostgreSQL）
 * 用法：node run-schema.js [--check]
 *   不带参数：执行 database/ec9_schema.sql（幂等，可重复执行）
 *   --check：只检查表是否齐全，不执行
 * 开发期连本机 PG（localhost:5432/ec9）；客户独立库账号到位后改 .env 三项即可。
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const EXPECTED_TABLES = [
  'ec9_admins', 'ec9_events', 'ec9_sessions', 'ec9_ticket_types', 'ec9_guests',
  'ec9_invitations', 'ec9_registrations', 'ec9_orders', 'ec9_payments', 'ec9_approvals',
  'ec9_auto_audit_rules', 'ec9_checkin_codes', 'ec9_checkins', 'ec9_sms_providers',
  'ec9_sms_templates', 'ec9_sms_logs', 'ec9_verification_codes', 'ec9_verification_tokens',
  'ec9_operation_logs', 'ec9_legal_docs',
  // 支付配置表（由 scripts/init-payment-config.js 建，首次部署若只跑 schema.sql 也会带上）
  'ec9_payment_configs'
];

async function listTables(client) {
  const res = await client.query(
    `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = current_schema()`
  );
  return new Set(res.rows.map(r => r.t));
}

async function main() {
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

  if (process.argv.includes('--check')) {
    const existing = await listTables(client);
    const missing = EXPECTED_TABLES.filter(t => !existing.has(t));
    console.log(`已存在 ${EXPECTED_TABLES.filter(t => existing.has(t)).length}/${EXPECTED_TABLES.length} 张 EC9 表`);
    if (missing.length) {
      console.log('缺失:', missing.join(', '));
      process.exitCode = 1;
    } else {
      console.log('CHECK_OK: 表全部就位');
    }
    await client.end();
    return;
  }

  const sql = fs.readFileSync(path.join(__dirname, '..', 'database', 'ec9_schema.sql'), 'utf8');
  console.log('执行 ec9_schema.sql ...');
  await client.query(sql);
  console.log('SCHEMA_DONE');

  const existing = await listTables(client);
  const missing = EXPECTED_TABLES.filter(t => !existing.has(t));
  if (missing.length) {
    console.log('缺失表:', missing.join(', '));
    process.exitCode = 1;
  } else {
    console.log('CHECK_OK: 表全部就位');
  }
  await client.end();
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
