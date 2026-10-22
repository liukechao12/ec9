/**
 * EC9 模型关联定义（在 models/index.js 末尾加载）
 * 别名约定与 service 层的 include as 一致：
 *   Registration → event / session / ticketType / guest
 *   Order → event / session / ticketType / guest / registration
 * 注意：只从各模块文件 require，不要 require('./index')（循环依赖）
 */
const AdminM = require('./Admin');
const EventM = require('./Event');
const SessionM = require('./Session');
const TicketTypeM = require('./TicketType');
const GuestM = require('./Guest');
const InvitationM = require('./Invitation');
const RegistrationM = require('./Registration').Registration;
const OrderM = require('./Order').Order;
const PaymentM = require('./Payment');
const CheckinCodeM = require('./CheckinCode');
const CheckinM = require('./Checkin');
const SmsProviderM = require('./SmsProvider');
const SmsTemplateM = require('./SmsTemplate');
const AutoAuditRuleM = require('./AutoAuditRule');

// ---- 活动 ----
EventM.hasMany(SessionM, { as: 'sessions', foreignKey: 'event_id' });
EventM.hasMany(TicketTypeM, { as: 'ticketTypes', foreignKey: 'event_id' });
EventM.hasMany(RegistrationM, { as: 'registrations', foreignKey: 'event_id' });
EventM.hasMany(OrderM, { as: 'orders', foreignKey: 'event_id' });
EventM.hasMany(InvitationM, { as: 'invitations', foreignKey: 'event_id' });
EventM.hasMany(CheckinCodeM, { as: 'checkinCodes', foreignKey: 'event_id' });

// ---- 场次 ----
SessionM.belongsTo(EventM, { as: 'event', foreignKey: 'event_id' });
SessionM.hasMany(TicketTypeM, { as: 'ticketTypes', foreignKey: 'session_id' });
SessionM.hasMany(RegistrationM, { as: 'registrations', foreignKey: 'session_id' });

// ---- 票种 ----
TicketTypeM.belongsTo(EventM, { as: 'event', foreignKey: 'event_id' });
TicketTypeM.belongsTo(SessionM, { as: 'session', foreignKey: 'session_id' });
TicketTypeM.hasMany(RegistrationM, { as: 'registrations', foreignKey: 'ticket_type_id' });
TicketTypeM.hasMany(OrderM, { as: 'orders', foreignKey: 'ticket_type_id' });

// ---- 嘉宾 ----
GuestM.hasMany(RegistrationM, { as: 'registrations', foreignKey: 'guest_id' });
GuestM.hasMany(OrderM, { as: 'orders', foreignKey: 'guest_id' });
GuestM.hasMany(CheckinCodeM, { as: 'checkinCodes', foreignKey: 'guest_id' });
GuestM.hasMany(InvitationM, { as: 'invitations', foreignKey: 'guest_id' });

// ---- 邀约 ----
InvitationM.belongsTo(EventM, { as: 'event', foreignKey: 'event_id' });
InvitationM.belongsTo(GuestM, { as: 'guest', foreignKey: 'guest_id' });

// ---- 报名 ----
RegistrationM.belongsTo(EventM, { as: 'event', foreignKey: 'event_id' });
RegistrationM.belongsTo(SessionM, { as: 'session', foreignKey: 'session_id' });
RegistrationM.belongsTo(TicketTypeM, { as: 'ticketType', foreignKey: 'ticket_type_id' });
RegistrationM.belongsTo(GuestM, { as: 'guest', foreignKey: 'guest_id' });
RegistrationM.hasOne(OrderM, { as: 'order', foreignKey: 'registration_id' });
RegistrationM.hasOne(CheckinCodeM, { as: 'checkinCode', foreignKey: 'registration_id' });

// ---- 订单 ----
OrderM.belongsTo(RegistrationM, { as: 'registration', foreignKey: 'registration_id' });
OrderM.belongsTo(EventM, { as: 'event', foreignKey: 'event_id' });
OrderM.belongsTo(SessionM, { as: 'session', foreignKey: 'session_id' });
OrderM.belongsTo(TicketTypeM, { as: 'ticketType', foreignKey: 'ticket_type_id' });
OrderM.belongsTo(GuestM, { as: 'guest', foreignKey: 'guest_id' });
OrderM.hasOne(PaymentM, { as: 'payment', foreignKey: 'order_id' });

// ---- 支付 ----
PaymentM.belongsTo(OrderM, { as: 'order', foreignKey: 'order_id' });

// ---- 签到 ----
CheckinCodeM.belongsTo(RegistrationM, { as: 'registration', foreignKey: 'registration_id' });
CheckinCodeM.belongsTo(GuestM, { as: 'guest', foreignKey: 'guest_id' });
CheckinCodeM.belongsTo(EventM, { as: 'event', foreignKey: 'event_id' });
CheckinCodeM.hasOne(CheckinM, { as: 'checkin', foreignKey: 'checkin_code_id' });

CheckinM.belongsTo(CheckinCodeM, { as: 'checkinCode', foreignKey: 'checkin_code_id' });
CheckinM.belongsTo(RegistrationM, { as: 'registration', foreignKey: 'registration_id' });
CheckinM.belongsTo(GuestM, { as: 'guest', foreignKey: 'guest_id' });
CheckinM.belongsTo(EventM, { as: 'event', foreignKey: 'event_id' });

// ---- 短信 ----
SmsProviderM.hasMany(SmsTemplateM, { as: 'templates', foreignKey: 'provider_id' });
SmsTemplateM.belongsTo(SmsProviderM, { as: 'provider', foreignKey: 'provider_id' });

// ==================== EC8 后台兼容别名 ====================
// EC8 后台（app.js / routes/*）按 EC8 的别名做 include 查询，
// EC9 表结构已升级，这里补齐别名，使 EC8 搬来的查询代码原样可用。
// ⚠️ 语义映射：EC8 Ticket（门票实体）→ EC9 TicketType（票种）；EC9 订单锁定在 Order。
// ⚠️ BD 关联：bd_id / source_bd 存的是Admin.username（不是 id），故用 targetKey。

const OperationLogM = require('./OperationLog');

// ---- 邀约 → 报名/签到（EC8 语义：签到挂在邀约上） ----
InvitationM.hasOne(RegistrationM, { as: 'registration', foreignKey: 'invitation_id' });
RegistrationM.belongsTo(InvitationM, { as: 'invitation', foreignKey: 'invitation_id' });
InvitationM.hasOne(CheckinM, { as: 'checkin', foreignKey: 'invitation_id' });
CheckinM.belongsTo(InvitationM, { as: 'invitation', foreignKey: 'invitation_id' });

// ---- 嘉宾 → 签到 ----
GuestM.hasMany(CheckinM, { as: 'checkins', foreignKey: 'guest_id' });
EventM.hasMany(CheckinM, { as: 'checkins', foreignKey: 'event_id' });

// ---- 报名 → 票种（EC8 叫 ticket） ----
RegistrationM.belongsTo(TicketTypeM, { as: 'ticket', foreignKey: 'ticket_type_id' });
EventM.hasMany(TicketTypeM, { as: 'tickets', foreignKey: 'event_id' });
GuestM.hasMany(TicketTypeM, { as: 'tickets', foreignKey: 'event_id' });

// ---- 管理员 → 操作日志 ----
AdminM.hasMany(OperationLogM, { as: 'logs', foreignKey: 'admin_id' });
OperationLogM.belongsTo(AdminM, { as: 'admin', foreignKey: 'admin_id' });

// ---- 嘉宾/邀约 → BD（经username，constraints:false 不建外键） ----
GuestM.belongsTo(AdminM, { foreignKey: 'bd_id', targetKey: 'username', as: 'bd', constraints: false });
AdminM.hasMany(GuestM, { foreignKey: 'bd_id', sourceKey: 'username', as: 'guests', constraints: false });
InvitationM.belongsTo(AdminM, { foreignKey: 'source_bd', targetKey: 'username', as: 'bd', constraints: false });
AdminM.hasMany(InvitationM, { foreignKey: 'source_bd', sourceKey: 'username', as: 'invitations', constraints: false });

// ---- 短信（EC8 的 SmsTemplate↔SmsRule 在 EC9 已取消：短信规则并入 AutoAuditRule） ----

module.exports = {};
