/**
 * 校验 database/ec9_schema.sql 是否能在空库上跑通
 *
 * 做法：把整份建表 SQL 包进一个事务执行后回滚（PG 支持事务性 DDL），
 * 既能验证语法与依赖（序列、外键、索引），又不会在库里留下任何痕迹。
 *
 * 用法：node scripts/verify-schema-sql.js
 * 通过：输出「✅ schema 可执行」并以 0 退出
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'database', 'ec9_schema.sql'), 'utf8');
  const client = new Client({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    const r = await client.query(
      `SELECT count(*)::int AS n FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name LIKE 'ec9_%'`);
    console.log(`✅ schema 可执行（事务内建出 ${r.rows[0].n} 张 ec9_ 表，已回滚）`);
    console.log(`   SQL 体积 ${(sql.length / 1024).toFixed(1)} KB，表/索引语句 ${(sql.match(/;/g) || []).length} 条`);
    await client.query('ROLLBACK');
    await client.end();
    process.exit(0);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
    console.error('❌ schema 执行失败:', e.message);
    console.error('   位置:', e.position ? `第 ${e.position} 字符附近` : '未知');
    process.exit(1);
  }
})();
