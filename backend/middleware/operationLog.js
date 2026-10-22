const { OperationLog } = require('../models');

/**
 * 敏感字段脱敏：操作日志里绝不能落明文密码 / 手机号 / 密钥
 * （EC8 遗留缺陷：日志里记录了密码与手机号明文）
 */
const SENSITIVE_KEYS = new Set([
  'password', 'old_password', 'new_password', 'confirm_password',
  'phone', 'mobile', 'phone_number', 'id_card', 'idcard', 'id_card_number',
  'token', 'access_token', 'refresh_token', 'authorization',
  'jwt_secret', 'encryption_key', 'api_key', 'apiKey', 'app_secret', 'appSecret',
  'secret', 'key', 'code', 'verification_code'
]);

function sanitize(obj, depth = 0) {
  if (obj === null || obj === undefined) return obj;
  if (depth > 3) return '[deep]';
  if (Array.isArray(obj)) return obj.slice(0, 20).map((v) => sanitize(v, depth + 1));
  if (typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(String(k).toLowerCase())) {
      out[k] = v === null || v === undefined || v === '' ? v : '***';
    } else {
      out[k] = sanitize(v, depth + 1);
    }
  }
  return out;
}

/**
 * 操作日志中间件
 */
const operationLog = (module, action) => {
  return async (req, res, next) => {
    // 保存原始res.json方法
    const originalJson = res.json.bind(res);
    
    // 重写res.json以记录日志
    res.json = function(data) {
      // 异步记录日志，不阻塞响应
      setImmediate(async () => {
        try {
          const adminId = req.user?.id || null;
          const adminName = req.user?.name || null;

          // 获取目标ID（从params或body；body 可能没有，如无 body 的请求）
          const targetId = req.params.id || (req.body && req.body.id) || null;

          // 确定目标类型
          let targetType = null;
          if (req.path.includes('/events')) targetType = 'event';
          else if (req.path.includes('/sessions')) targetType = 'session';
          else if (req.path.includes('/ticket-types')) targetType = 'ticket_type';
          else if (req.path.includes('/orders')) targetType = 'order';
          else if (req.path.includes('/payments')) targetType = 'payment';
          else if (req.path.includes('/guests')) targetType = 'guest';
          else if (req.path.includes('/invitations')) targetType = 'invitation';
          else if (req.path.includes('/registrations')) targetType = 'registration';
          else if (req.path.includes('/checkins')) targetType = 'checkin';
          else if (req.path.includes('/checkin-codes')) targetType = 'checkin_code';
          else if (req.path.includes('/tickets')) targetType = 'ticket';

          // 构建操作详情（存 detail 列）
          let detail = `${action}`;
          if (targetId) detail += ` (ID: ${targetId})`;
          if (req.body && Object.keys(req.body).length > 0) {
            detail += ` - 数据: ${JSON.stringify(sanitize(req.body)).substring(0, 500)}`;
          }
          const ua = req.headers['user-agent'];
          if (ua) detail += ` - UA: ${String(ua).substring(0, 120)}`;

          // ⚠️ 字段名必须与 ec9_operation_logs 表一致：detail / ip
          //    （EC8 原代码写的是 description / ip_address / user_agent，
          //     在 EC9 表上会静默丢字段，日志只剩 action 一句话）
          await OperationLog.create({
            admin_id: adminId,
            admin_name: adminName,
            role: req.user?.role || null,
            action: String(action || req.method).substring(0, 100),
            module: module || req.path.split('/')[2],
            target_type: targetType,
            target_id: targetId ? String(targetId).substring(0, 100) : null,
            detail: detail.substring(0, 2000),
            ip: (req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '').toString().substring(0, 45)
          });
        } catch (error) {
          console.error('记录操作日志失败:', error);
        }
      });

      // 调用原始的json方法
      return originalJson(data);
    };
    
    next();
  };
};

module.exports = operationLog;
module.exports.sanitize = sanitize;

