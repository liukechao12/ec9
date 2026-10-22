/**
 * EC9 报名系统 · 入口
 * 已接入：/api/health、/api/verification（强制手机号验证）、/api/payment（微信支付）
 * 待接入：events / registrations / tickets / admin ...
 */
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const config = require('./config');
const { testConnection } = require('./config/database');

const app = express();
const PORT = config.server.port;

app.use(cors({ origin: config.server.corsOrigin, credentials: true }));

// 微信支付回调：必须用原始报文验签，先于 JSON parser 挂 raw
app.use('/api/payment/notify', bodyParser.raw({ type: () => true, limit: '1mb' }), (req, res, next) => {
  req.rawBody = req.body; // Buffer
  next();
});

app.use(bodyParser.json({ charset: 'utf-8' }));
app.use(bodyParser.urlencoded({ extended: true, charset: 'utf-8' }));

// API 响应统一 UTF-8
app.use('/api', (req, res, next) => {
  res.charset = 'utf-8';
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

// 上传文件（二维码等）
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// 多语言语言包：一个语种一个文件，禁用缓存（覆盖语言文件后立即生效）
app.use('/i18n', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
}, express.static(path.join(__dirname, 'public', 'i18n'), {
  setHeaders(res) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
  }
}));

// ========== H5 嘉宾端页面路由（2026-10-15 从 EC8 搬入）============
// ⚠️ 必须排在通用静态路由**之前**，否则 /invite/xxx 会被静态目录吃掉。
// 这几套页面是 EC9 报名的实际入口：短信里的链接、后台「发送邀约」生成的链接都指到这里。
const H5 = path.join(__dirname, 'public', 'h5');

function sendH5(res, file, extraHeaders) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  if (extraHeaders) Object.keys(extraHeaders).forEach(k => res.setHeader(k, extraHeaders[k]));
  res.sendFile(path.join(H5, file), err => {
    if (err && !res.headersSent) {
      res.status(500).send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>错误</title></head><body><h1>页面文件读取失败</h1></body></html>');
    }
  });
}

// H5 静态资源（css/js/images）
// ⚠️ 必须排在 /invite/:code、/checkin/:code **之前**。
//    否则 /invite/h5/invite.js 会被 '/invite/:code' 匹配掉（:code 能吃掉 "h5/invite.js"），
//    返回 invite.html —— 浏览器按 text/html 解析 JS 抛
//    "Refused to execute script ... MIME type 'text/html'"。
//    这个坑 2026-10-15 踩过一次。
app.use('/h5', express.static(H5, {
  setHeaders(res) { res.setHeader('Cache-Control', 'no-cache'); }
}));

// 邀约页：/invite/<邀约码>
app.get('/invite/:code', (req, res) => sendH5(res, 'invite.html'));

// 自助签到页：/checkin/<签到码>
app.get('/checkin/:code', (req, res) => sendH5(res, 'checkin.html'));

// 业绩说明会页（开放报名，无需邀请码）
app.get('/pages/performance', (req, res) => sendH5(res, 'performance.html'));

// 会议主页（设计图页）：/pages?code=xxx
app.get('/pages', (req, res) => sendH5(res, 'pages.html'));
app.get('/pages/ec8', (req, res) => sendH5(res, 'pages.html'));

// 购票页：短信「支付成功」通知里的链接（orderService 发出）
// ⚠️ EC8 没有这个页面（EC8 无购票），EC9 新增。
app.get('/ticket.html', (req, res) => sendH5(res, 'ticket.html'));

// 协议与隐私政策（H5 内链）
['/user-agreement', '/privacy-policy'].forEach(function (p) {
  app.get(p, (req, res) => sendH5(res, p.slice(1) + '.html'));
});

// i18n.js 运行时本身也禁缓存。
// ⚠️ 必须排在通用静态路由**之前**：i18n.js 一旦被浏览器缓存住，
// 后面改的切换逻辑全部不生效，而语言包照常刷新 —— 表现就是
// 「文案能翻译，但切换行为还是旧的」，极难排查。
// （2026-10-14 踩过：改了 i18n.js 的还原逻辑，HTML 里的 ?v= 没同步，
//  浏览器继续用旧文件，开发机怎么测都复现不出来。）
// ⚠️ 以下前端脚本与 i18n.js 同理：改了必须立刻生效，不能只靠 HTML 里的 ?v=。
//   2026-10-14 两次踩坑都是「文件改了但浏览器用旧缓存」，
//   表现是「文案翻了一半 / 切换后回退」，jsdom 与 Playwright 全测都发现不了
//   （只有真浏览器带缓存才复现）。
['/i18n.js', '/ec9-modules.js'].forEach(function (p) {
  app.get(p, function (req, res) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.type('application/javascript; charset=utf-8');
    res.sendFile(path.join(__dirname, 'public', p.replace(/^\//, '')));
  });
});

// 静态资源（后台 / H5）
app.use(express.static(path.join(__dirname, 'public')));

// 路由
app.use('/api/verification', require('./routes/verification'));
app.use('/api/payment', require('./routes/payment'));

// H5 公开数据（会议 / 场次 / 票种，无需登录）
app.use('/api/public', require('./routes/public-data'));

// 后台管理（沿用 EC8 框架，模型/表已切 EC9 PG 库）
app.use('/api/admin', require('./routes/admin'));
app.use('/api/admins', require('./routes/admins'));
app.use('/api/events', require('./routes/events'));
app.use('/api/sessions', require('./routes/sessions'));
app.use('/api/ticket-types', require('./routes/ticket-types'));
app.use('/api/guests', require('./routes/guests'));
app.use('/api/invitations', require('./routes/invitations'));
app.use('/api/registrations', require('./routes/registrations'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/pay-config', require('./routes/pay-config'));
app.use('/api/checkins', require('./routes/checkins'));
app.use('/api/checkin-codes', require('./routes/checkin-codes'));
app.use('/api/statistics', require('./routes/statistics'));
app.use('/api/sms', require('./routes/sms'));
app.use('/api/sms-config', require('./routes/sms-config'));
app.use('/api/operation-logs', require('./routes/operation-logs'));
app.use('/api/legal', require('./routes/legal'));

app.get('/api/health', (req, res) => {
  res.json({ code: 0, message: 'ok', data: { version: '0.2.0', env: config.server.env, payMode: require('./services/payConfigService').get().mode } });
});

// 404
app.use('/api', (req, res) => {
  res.status(404).json({ code: 404, message: '接口不存在' });
});

// 错误处理
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    code: err.status || 500,
    message: err.message || '服务器错误',
    error: config.server.env === 'development' ? err.stack : undefined
  });
});

async function startServer() {
  try {
    await testConnection();
    // 支付/短信配置入内存（后台可改，改完热更新，不需要重启）
    await require('./services/payConfigService').load();
    await require('./services/smsConfigService').load();
    // 订单超时关单扫描器（60s 间隔）
    require('./services/orderService').startExpireScanner();
    app.listen(PORT, config.server.host, () => {
      console.log(`EC9 服务器运行在端口 ${PORT}`);
      console.log(`API: http://localhost:${PORT}/api/health`);
      console.log(`支付模式: ${require('./services/payConfigService').get().mode}（来源 ${require('./services/payConfigService').source()}）`);
    });
  } catch (error) {
    console.error('启动服务器失败:', error.message);
    process.exit(1);
  }
}

startServer();

module.exports = app;
