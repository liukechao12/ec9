/**
 * EC9 票务方案更新（2026-10-21 昊哥拍板）：
 *   学生票  ¥0    在校学生，凭有效学生证或学籍证明入场（现场核验，不线上上传）
 *   标准票  ¥510  主论坛+分论坛+展区+资料+简餐茶歇+科技之夜；3张9折 5张8折
 *   尊享票  ¥1510 标准票全部权益 + 闭门交流(VIP核心圈层午饭) + 专属参观 + EC9礼盒
 *   嘉宾票  -     定向邀请，非公开售卖（不单独设立，on_shelf=0 仅占位）
 * 幂等：按名称 upsert。
 */
const { sequelize } = require('../config/database');
const { TicketType, Event } = require('../models');

const EVENT_ID = 1;

const TICKETS = [
  { name: '学生票', price: 0, is_student: 1, on_shelf: 1, sort: 1,
    description: '在校学生专享，同标准票权益。凭有效学生证或学籍证明现场核验入场。' },
  { name: '标准票', price: 510, is_student: 0, on_shelf: 1, sort: 2,
    description: '主论坛、对本票种开放的分论坛及展区、会议资料、简餐与茶歇、科技之夜入场。买的多打折：三张9折，五张8折。' },
  { name: '尊享票', price: 1510, is_student: 0, on_shelf: 1, sort: 3,
    description: '标准票全部权益 + 指定闭门交流活动（VIP核心圈层午饭）+ 专属参观安排 + EC9礼盒一套。' },
  { name: '嘉宾票', price: 0, is_student: 0, on_shelf: 0, sort: 4,
    description: '定向邀请，非公开售卖。经审核的重点客户、合作伙伴、演讲嘉宾等，由内部推荐、审批后发放。' }
];

(async () => {
  try {
    const event = await Event.findByPk(EVENT_ID);
    if (!event) throw new Error('活动不存在，请先跑 seed.js');

    for (const t of TICKETS) {
      let tt = await TicketType.findOne({ where: { event_id: EVENT_ID, name: t.name } });
      if (tt) {
        await tt.update({
          price: t.price, is_student: t.is_student, on_shelf: t.on_shelf,
          sort: t.sort, description: t.description
        });
        console.log(`UPDATE ${t.name} ¥${t.price} on_shelf=${t.on_shelf}`);
      } else {
        await TicketType.create({
          event_id: EVENT_ID, session_id: 0,
          name: t.name, price: t.price, is_student: t.is_student,
          on_shelf: t.on_shelf, sort: t.sort, description: t.description,
          stock_total: 500, per_order_limit: 10, status: 1
        });
        console.log(`CREATE ${t.name} ¥${t.price}`);
      }
    }
    // 旧设计稿价格票种（标准票¥2510/尊享票¥5100 等）下架处理：不在清单内的上架票全部下架
    const all = await TicketType.findAll({ where: { event_id: EVENT_ID } });
    for (const tt of all) {
      if (!TICKETS.some(t => t.name === tt.name) && tt.on_shelf == 1) {
        await tt.update({ on_shelf: 0 });
        console.log(`OFF-SHELF 旧票种 ${tt.name} ¥${tt.price}`);
      }
    }
    console.log('票种更新完成');
    await sequelize.close();
  } catch (e) { console.error('FAIL', e.message); process.exit(1); }
})();
