/**
 * 从运行库反向导出建表 SQL → database/ec9_schema.sql
 *
 * 为什么需要它：新环境（生产库）首次部署时没有任何 ec9_ 表，
 * 而项目里原本只有「迁移类」脚本（加列），没有从零建库的 DDL。
 * 本机没有 pg_dump，所以用 pg 客户端读 information_schema 生成。
 *
 * 用法：node scripts/export-schema.js
 * 产物：database/ec9_schema.sql（幂等：CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS）
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const PREFIX = 'ec9_';

(async () => {
  const client = new Client({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD
  });
  await client.connect();

  // 1. 列
  const cols = await client.query(`
    SELECT table_name, column_name, data_type, udt_name, character_maximum_length,
           numeric_precision, numeric_scale, is_nullable, column_default, ordinal_position
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name LIKE '${PREFIX}%'
    ORDER BY table_name, ordinal_position`);

  // 2. 主键
  const pks = await client.query(`
    SELECT tc.table_name, kcu.column_name, kcu.ordinal_position
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = current_schema()
      AND tc.table_name LIKE '${PREFIX}%'
    ORDER BY tc.table_name, kcu.ordinal_position`);

  // 3. 唯一约束
  const uqs = await client.query(`
    SELECT tc.table_name, tc.constraint_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'UNIQUE' AND tc.table_schema = current_schema()
      AND tc.table_name LIKE '${PREFIX}%'`);

  // 4. 索引（排除主键/唯一约束自动建的）
  const idx = await client.query(`
    SELECT tablename AS table_name, indexname AS index_name, indexdef AS index_def
    FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename LIKE '${PREFIX}%'
      AND indexname NOT IN (SELECT constraint_name FROM information_schema.table_constraints WHERE table_schema = current_schema())`);

  await client.end();

  // 组装
  const byTable = {};
  for (const c of cols.rows) {
    (byTable[c.table_name] = byTable[c.table_name] || { cols: [], pk: [], uq: {}, idx: [] }).cols.push(c);
  }
  for (const p of pks.rows) if (byTable[p.table_name]) byTable[p.table_name].pk.push(p.column_name);
  for (const u of uqs.rows) {
    if (!byTable[u.table_name]) continue;
    (byTable[u.table_name].uq[u.constraint_name] = byTable[u.table_name].uq[u.constraint_name] || []).push(u.column_name);
  }
  for (const i of idx.rows) if (byTable[i.table_name]) byTable[i.table_name].idx.push(i);

  function typeOf(c) {
    if (c.data_type === 'character varying') return c.character_maximum_length ? `VARCHAR(${c.character_maximum_length})` : 'TEXT';
    if (c.data_type === 'character') return `CHAR(${c.character_maximum_length})`;
    if (c.data_type === 'numeric') return `NUMERIC(${c.numeric_precision},${c.numeric_scale})`;
    if (c.data_type === 'timestamp with time zone') return 'TIMESTAMPTZ';
    if (c.data_type === 'timestamp without time zone') return 'TIMESTAMP';
    if (c.data_type === 'json' || c.data_type === 'jsonb') return c.udt_name.toUpperCase();
    return c.udt_name.toUpperCase();
  }

  let sql = `-- ============================================================
-- EC9 报名系统建表脚本（PostgreSQL）
-- 由 scripts/export-schema.js 从运行库反向生成，幂等，可重复执行
-- 生成时间：${new Date().toISOString()}
-- 用法：psql -h $DB_HOST -U $DB_USER -d $DB_NAME -f database/ec9_schema.sql
-- ============================================================

`;

  for (const t of Object.keys(byTable).sort()) {
    const { cols: cs, pk, uq, idx: ix } = byTable[t];
    sql += `-- ---------- ${t} ----------\n`;
    // 自增主键依赖序列：新库没有序列会导致 CREATE TABLE 报错，先建序列（幂等）
    const seqs = new Set();
    cs.forEach(c => {
      if (c.column_default) {
        const m = /nextval\('([^']+)'/.exec(String(c.column_default));
        if (m) seqs.add(m[1]);
      }
    });
    for (const s of seqs) sql += `CREATE SEQUENCE IF NOT EXISTS ${s};\n`;
    sql += `CREATE TABLE IF NOT EXISTS ${t} (\n`;
    const parts = cs.map(c => {
      let s = `  ${c.column_name} ${typeOf(c)}`;
      if (c.is_nullable === 'NO') s += ' NOT NULL';
      if (c.column_default != null) {
        let d = String(c.column_default);
        // 去掉 PG 自动加的类型后缀（nextval 保留完整写法）
        s += ` DEFAULT ${d}`;
      }
      return s;
    });
    if (pk.length) parts.push(`  PRIMARY KEY (${pk.join(', ')})`);
    for (const k of Object.keys(uq)) parts.push(`  CONSTRAINT ${k} UNIQUE (${uq[k].join(', ')})`);
    sql += parts.join(',\n') + '\n);\n';
    for (const i of ix) {
      const def = i.index_def.replace(/^CREATE INDEX /, 'CREATE INDEX IF NOT EXISTS ')
        .replace(/^CREATE UNIQUE INDEX /, 'CREATE UNIQUE INDEX IF NOT EXISTS ');
      sql += def + ';\n';
    }
    sql += '\n';
  }

  const outDir = path.join(__dirname, '..', 'database');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'ec9_schema.sql');
  fs.writeFileSync(out, sql, 'utf8');
  console.log(`已导出 ${Object.keys(byTable).length} 张表 → ${out}`);
  console.log(`  大小 ${(sql.length / 1024).toFixed(1)} KB`);
})().catch(e => { console.error('导出失败:', e.message); process.exit(1); });
