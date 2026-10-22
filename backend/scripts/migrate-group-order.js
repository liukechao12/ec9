/**
 * EC9 多人代报 + group 订单 改造迁移
 *  1. ec9_registrations  加 group_no（同一次代报共享，索引）
 *  2. ec9_orders         加 group_no / price_detail(JSON 明细) / discount_rate / pay_token
 *  3. ec9_ticket_types   加 is_student（学生票现场核验标记）
 * 幂等：全部查 information_schema，列已存在则跳过。
 */
const { sequelize } = require('../config/database');

const PLAN = [
  {
    table: 'ec9_registrations',
    cols: [
      { name: 'group_no', ddl: "ADD COLUMN IF NOT EXISTS group_no VARCHAR(40)", idx: 'CREATE INDEX IF NOT EXISTS idx_reg_group_no ON ec9_registrations (group_no)' }
    ]
  },
  {
    table: 'ec9_orders',
    cols: [
      { name: 'group_no', ddl: "ADD COLUMN IF NOT EXISTS group_no VARCHAR(40)", idx: 'CREATE INDEX IF NOT EXISTS idx_order_group_no ON ec9_orders (group_no)' },
      { name: 'price_detail', ddl: "ADD COLUMN IF NOT EXISTS price_detail JSON" },
      { name: 'discount_rate', ddl: "ADD COLUMN IF NOT EXISTS discount_rate DECIMAL(4,2) DEFAULT 1.00" },
      { name: 'pay_token', ddl: "ADD COLUMN IF NOT EXISTS pay_token VARCHAR(64)" , idx: 'CREATE INDEX IF NOT EXISTS idx_order_pay_token ON ec9_orders (pay_token)' }
    ]
  },
  {
    table: 'ec9_ticket_types',
    cols: [
      { name: 'is_student', ddl: "ADD COLUMN IF NOT EXISTS is_student SMALLINT DEFAULT 0" }
    ]
  }
];

(async () => {
  try {
    for (const t of PLAN) {
      for (const c of t.cols) {
        const [ex] = await sequelize.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name = :t AND column_name = :c",
          { replacements: { t: t.table, c: c.name } });
        if (ex.length) { console.log(`SKIP ${t.table}.${c.name} 已存在`); continue; }
        await sequelize.query(`ALTER TABLE ${t.table} ${c.ddl}`);
        console.log(`OK   ${t.table}.${c.name}`);
      }
      for (const idx of t.cols.map(x => x.idx).filter(Boolean)) {
        try { await sequelize.query(idx); console.log(`IDX  ${idx.slice(0, 60)}...`); }
        catch (e) { console.log(`IDX-SKIP ${e.message.slice(0, 80)}`); }
      }
    }
    console.log('迁移完成');
    await sequelize.close();
  } catch (e) { console.error('FAIL', e.message); process.exit(1); }
})();
