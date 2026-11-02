#!/usr/bin/env node
/**
 * 从「姓名清单」Excel 批量创建 EC9 的 BD 后台账号，并导出账号/初始密码表。
 *
 * 用法（必须在 backend 目录下运行，否则读不到 .env）：
 *   cd D:/ec9/backend
 *   node scripts/import-bd-from-xlsx.js <名单.xlsx> [--password Pwd@2026] [--role bd] [--dry-run] [--out 账号表.xlsx]
 *
 * 设计要点：
 *   1) 名单只有姓名一列（没有手机号），所以登录账号直接取姓名：
 *      - 去掉「(2)」「(4)」这类人工加的重名后缀，重名时自动追加数字（张三 / 张三2）
 *      - 英文/外文名去掉空格并转小写
 *   2) 密码统一为 --password 指定的初始口令（默认 Ec9@2026），落库前由 Admin 模型 hook 做 bcrypt 加密
 *   3) 幂等：已存在的同名账号直接跳过，不会重建、不会改密码（除非加 --reset-password）
 *   4) 输出账号表 Excel：序号 / 姓名 / 登录账号 / 初始密码 / 角色
 */
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { Admin, sequelize } = require('../models');

// ---------------- 参数 ----------------
function parseArgs(argv) {
  const a = { file: null, password: 'Ec9@2026', role: 'bd', dryRun: false, resetPassword: false, out: null };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--dry-run') a.dryRun = true;
    else if (v === '--reset-password') a.resetPassword = true;
    else if (v === '--password') a.password = argv[++i];
    else if (v === '--role') a.role = argv[++i];
    else if (v === '--out') a.out = argv[++i];
    else if (!a.file) a.file = v;
  }
  return a;
}

const HEADER_WORDS = new Set(['姓名', '名字', 'name', '用户名', 'username', 'bd姓名', 'bd']);

/** 取一行里第一个非空单元格作为姓名 */
function rowName(row) {
  for (const cell of row) {
    if (cell === null || cell === undefined) continue;
    const s = String(cell).trim();
    if (!s) continue;
    return s;
  }
  return '';
}

/** 姓名 -> 登录账号（清洗 + 去人工重名后缀） */
function toUsername(raw) {
  let s = String(raw || '').trim().replace(/\s+/g, (m, i) => (i === 0 ? '' : ' '));
  s = s.replace(/[（(]\s*\d+\s*[)）]\s*$/, ''); // 去掉 "(2)" "(4)"
  if (!/[\u4e00-\u9fa5]/.test(s)) {
    // 外文名：去空格、转小写
    s = s.replace(/\s+/g, '').toLowerCase();
  } else {
    s = s.replace(/\s+/g, '');
  }
  return s;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.file) {
    console.error('用法: node scripts/import-bd-from-xlsx.js <名单.xlsx> [--password Pwd] [--dry-run]');
    process.exit(1);
  }
  const src = path.resolve(args.file);
  if (!fs.existsSync(src)) {
    console.error('找不到名单文件: ' + src);
    process.exit(1);
  }

  // ---------------- 读名单 ----------------
  const wb = XLSX.read(fs.readFileSync(src), { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false });

  const names = [];
  const seenRaw = new Set();
  for (const row of rows) {
    const raw = rowName(row);
    if (!raw) continue;
    if (HEADER_WORDS.has(raw.toLowerCase())) continue; // 表头
    if (seenRaw.has(raw)) continue;                    // 名单内部完全重名（含后缀）只取一条
    seenRaw.add(raw);
    names.push(raw);
  }
  console.log(`名单解析完成：${names.length} 个姓名（原始行 ${rows.length}）`);

  // ---------------- 生成账号 ----------------
  const existing = new Set(
    (await Admin.findAll({ attributes: ['username'] })).map((r) => String(r.username || '').trim())
  );
  console.log(`库中已有账号 ${existing.size} 个，将跳过重名`);

  const plan = [];
  const used = new Set(existing);
  for (const raw of names) {
    let u = toUsername(raw);
    if (!u) continue;
    const existed = existing.has(u); // 必须在追加数字后缀之前判断，否则重跑会误判为“新增”
    if (!existed && used.has(u)) {
      // 只有“准备新建”的才需要规避重名；库里已存在的账号必须沿用原账号名，
      // 否则重跑会多造一个「张三2」，且重置密码时按新名查不到记录。
      let k = 2;
      while (used.has(`${u}${k}`)) k++;
      u = `${u}${k}`;
    }
    used.add(u);
    plan.push({ name: raw, username: u, exists: existed });
  }

  const toCreate = plan.filter((p) => !p.exists);
  const toSkip = plan.filter((p) => p.exists);
  const toReset = args.resetPassword ? plan.filter((p) => p.exists) : [];

  console.log(`计划新建 ${toCreate.length} 个，跳过（已存在）${toSkip.length} 个` +
    (toReset.length ? `，重置密码 ${toReset.length} 个` : ''));
  if (args.dryRun) {
    console.log('\n[dry-run] 前 15 条预览：');
    plan.slice(0, 15).forEach((p, i) =>
      console.log(`  ${i + 1}. ${p.name}  ->  ${p.username}${p.exists ? '  (已存在，跳过)' : ''}`)
    );
    process.exit(0);
  }

  // ---------------- 落库 ----------------
  let created = 0, failed = 0, skipped = 0, reseted = 0;
  const failures = [];
  for (const p of toCreate) {
    try {
      await Admin.create({
        username: p.username,
        password: args.password,   // 明文传入，由模型 beforeCreate hook 做 bcrypt 加密
        name: p.name,
        role: args.role,
        status: 1,
        lang: 'zh-CN'
      });
      created++;
    } catch (e) {
      failed++;
      failures.push(`${p.username}: ${e.message}`);
    }
  }
  for (const p of toReset) {
    const row = await Admin.findOne({ where: { username: p.username } });
    if (row) { await row.update({ password: args.password }); reseted++; }
  }
  skipped = toSkip.length;
  console.log(`\n执行结果：新建 ${created}，失败 ${failed}，跳过 ${skipped}，重置 ${reseted}`);
  if (failures.length) {
    console.log('失败明细（前 10 条）：');
    failures.slice(0, 10).forEach((f) => console.log('  ' + f));
  }

  // ---------------- 导出账号表 ----------------
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const outPath = args.out
    ? path.resolve(args.out)
    : path.join('D:/temp', `EC9_BD账号_${plan.length}人_${stamp}.xlsx`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // 账号名以库里的真实值为准（重名会自动加数字后缀，plan 里推的名字可能与库中不一致）
  const dbRows = await Admin.findAll({
    where: { name: names, role: args.role },
    attributes: ['id', 'username', 'name']
  });
  const byName = new Map(dbRows.map((r) => [String(r.name), r.username]));

  const data = [['序号', '姓名', '登录账号', '初始密码', '角色', '备注']];
  plan.forEach((p, i) => {
    // 已存在的账号本次没动过密码，不能把初始口令写进去误导人
    const pwd = (p.exists && !args.resetPassword) ? '（已存在，未重置）' : args.password;
    const note = p.exists ? (args.resetPassword ? '本次重置密码' : '本次跳过') : '本次新建';
    const uname = byName.get(p.name) || p.username;
    data.push([i + 1, p.name, uname, pwd, args.role, note]);
  });
  const unmapped = plan.filter((p) => !byName.has(p.name)).length;
  if (unmapped) console.log(`\n⚠ 有 ${unmapped} 人在库中未匹配到账号，表里沿用推算账号名，请手工核对`);
  const nwb = XLSX.utils.book_new();
  const nws = XLSX.utils.aoa_to_sheet(data);
  nws['!cols'] = [{ wch: 6 }, { wch: 16 }, { wch: 22 }, { wch: 18 }, { wch: 8 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(nwb, nws, 'BD账号');
  XLSX.writeFile(nwb, outPath);
  console.log(`\n账号表已导出：${outPath}`);
  console.log(`初始密码：${args.password}`);

  await sequelize.close();
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
