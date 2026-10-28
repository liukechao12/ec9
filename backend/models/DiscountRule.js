const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/**
 * 多人折扣阶梯规则（后台可配，不再写死「3张9折 / 5张8折」）
 *
 * 语义（2026-10-29 定口径）：
 *   - 张数只数「付费的标准票」ticket_type.is_standard=1，且排除学生票/邀约免票；
 *   - 折扣只作用在标准票金额上，其它票种（尊享票等）一律原价；
 *   - 命中规则 = 在 enabled=1 的规则里，取 min_qty <= 张数 中 min_qty 最大的那条（就高不就低）；
 *     e.g. 配了 3张9折 / 5张8折 / 10张7折，买 7 张 → 取 5张8折。
 *   - 没配任何规则 / 都没命中 → 原价 rate=1。
 *
 * rate 存小数折扣率：0.90=9折、0.80=8折、1.00=原价。
 */
const DiscountRule = sequelize.define('DiscountRule', {
  event_id: { type: DataTypes.INTEGER, allowNull: false, comment: '活动 id（规则按活动隔离）' },
  min_qty: { type: DataTypes.INTEGER, allowNull: false, comment: '达到该付费标准票张数即命中' },
  rate: { type: DataTypes.DECIMAL(5, 2), allowNull: false, comment: '折扣率小数：0.90=9折、0.80=8折' },
  remark: { type: DataTypes.STRING(200), allowNull: true, comment: '备注（后台自己看，不对外展示）' },
  enabled: { type: DataTypes.TINYINT, defaultValue: 1, comment: '1=启用；0=停用（不参与命中）' },
  sort: { type: DataTypes.INTEGER, defaultValue: 0, comment: '升序，仅用于后台列表排序展示' }
}, {
  tableName: 'ec9_discount_rules',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { fields: ['event_id', 'enabled'] }
  ]
});

module.exports = DiscountRule;
