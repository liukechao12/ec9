/**
 * EC8 → EC9 字段差异扫描器
 * 扫描 EC8 搬来的路由里引用的字段，找出在 EC9 PG 库中不存在的列。
 * 目的：一次性发现「EC8 字段名 vs EC9 字段名」的语义偏差，避免逐个撞 500。
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

(async () => {
  const c = new Client({
    host: process.env.DB_HOST, port: 5432,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });
  await c.connect();
  const r = await c.query(
    "SELECT table_name, array_agg(column_name ORDER BY ordinal_position) cols " +
    "FROM information_schema.columns WHERE table_name LIKE 'ec9_%' GROUP BY table_name"
  );
  const allCols = new Set();
  r.rows.forEach(x => {
    // pg 把 text[] 作为 '{a,b,c}' 字符串返回，手动解析
    const raw = x.cols;
    const list = Array.isArray(raw) ? raw : String(raw).replace(/[{}]/g, '').split(',');
    list.forEach(cc => allCols.add(cc.trim()));
  });
  console.log('EC9 表数:', r.rows.length, '总列数:', allCols.size);

  const routeDir = path.join(__dirname, '..', 'routes');
  const files = fs.readdirSync(routeDir).filter(f => f.endsWith('.js'));
  let totalIssues = 0;

  files.forEach(f => {
    const src = fs.readFileSync(path.join(routeDir, f), 'utf8');
    // 抓所有单引号包裹的 snake_case 标识符（EC8 字段风格）
    const identifiers = [...src.matchAll(/'([a-z][a-z0-9_]{2,})'/g)].map(x => x[1]);
    // 只保留「像数据库字段」的：出现在 attributes/where/order 里
    const inQueryContext = [...src.matchAll(/(?:attributes|where|order|group)\s*:\s*(\[[^\]]{1,3000}\]|\{[^}]{1,2000}\})/g)]
      .flatMap(m => [...m[1].matchAll(/'([a-z][a-z0-9_]{2,})'/g)].map(x => x[1]));
    const candidates = new Set(inQueryContext);

    const missing = [...candidates].filter(col => !allCols.has(col));
    if (missing.length) {
      console.log('\n=== ' + f + ' ===');
      missing.forEach(m => console.log('  缺失: ' + m));
      totalIssues += missing.length;
    }
  });

  console.log('\nTOTAL_MISSING_FIELDS:', totalIssues);
  await c.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });