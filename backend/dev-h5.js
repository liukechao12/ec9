#!/usr/bin/env node
/**
 * EC9 前台 H5 —— 本地开发服务器（只起前端，后端直接用线上）
 *
 * 为什么需要它：
 *   线上 backend/app.js 是一个进程同时提供 后台 SPA + 前台 H5 + API，
 *   本地想只调前端页面就必须把后端也跑起来（还得连 PostgreSQL）。
 *   本脚本只做两件事，零依赖、零数据库：
 *     1) 静态托管 backend/public/h5（保持与线上一致的 URL：/h5/ec9/...）
 *     2) 把 /api、/uploads 反向代理到线上后端，浏览器视角始终是同源，不需要改 CORS
 *
 * 用法：
 *   node dev-h5.js                  # 默认代理 https://ec9.51world.com.cn
 *   node dev-h5.js --port 6000      # 换端口
 *   H5_PORT=6000 EC9_REMOTE=http://101.96.212.13:7098 node dev-h5.js
 *   或：npm run dev:h5
 *
 * ⚠️ 注意：接口是打真库的，验证码会发真短信、报名会写生产数据。
 *    只用于「页面改完看效果」，不要拿它跑压测或造脏数据。
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

/* ---------------- 配置 ---------------- */
function argValue(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : '';
}

const PORT = parseInt(argValue('--port') || process.env.H5_PORT, 10) || 5180;
const HOST = argValue('--host') || process.env.H5_HOST || '127.0.0.1';
// 线上后端地址：末尾斜杠统一去掉，避免拼出 //api
const REMOTE = (argValue('--remote') || process.env.EC9_REMOTE || 'https://ec9.51world.com.cn').replace(/\/+$/, '');
const remoteUrl = new URL(REMOTE);

const H5_ROOT = path.join(__dirname, 'public', 'h5'); // 与线上 app.js 里的 H5 目录一致
const H5_HOME = '/h5/ec9/index.html';                 // 本地首页直达地址

// 需要反代到线上后端的路径前缀（对应线上 Nginx 的 /api、/uploads）
const PROXY_PREFIXES = ['/api', '/uploads'];

// 与线上 backend/app.js 完全一致的 H5 友好路由（短信 / 后台生成的链接都指到这里）
const FRIENDLY_ROUTES = [
  { re: /^\/invite\/[^/]+$/, file: 'invite.html' },
  { re: /^\/checkin\/[^/]+$/, file: 'checkin.html' },
  { re: /^\/pages\/performance$/, file: 'performance.html' },
  { re: /^\/pages(?:\/ec8)?$/, file: 'pages.html' },
  { re: /^\/ticket\.html$/, file: 'ticket.html' },
  { re: /^\/user-agreement$/, file: 'user-agreement.html' },
  { re: /^\/privacy-policy$/, file: 'privacy-policy.html' }
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

/* ---------------- 工具 ---------------- */
function notFound(res, msg) {
  if (res.headersSent) return res.end();
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>404</title></head><body>' +
    '<h1>404</h1><p>' + (msg || '文件不存在') + '</p>' +
    '<p><a href="' + H5_HOME + '">回到 H5 首页</a></p></body></html>');
}

// 把 URL 路径安全地拼到根目录下（防目录穿越）
function safeJoin(root, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch (e) { return null; }
  const abs = path.normalize(path.join(root, rel));
  return abs === root || abs.startsWith(root + path.sep) ? abs : null;
}

// 静态文件响应：一律 no-cache，改完刷新即可生效（与线上 /h5 策略一致）
function sendFile(req, res, absPath) {
  fs.stat(absPath, function (err, st) {
    if (err || !st.isFile()) return notFound(res);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(absPath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Content-Length': st.size
    });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(absPath);
    stream.on('error', function () { !res.headersSent && notFound(res); res.end(); });
    stream.pipe(res);
  });
}

/* ---------------- 反向代理 ---------------- */
function proxy(req, res) {
  const headers = Object.assign({}, req.headers, {
    host: remoteUrl.host,
    'x-forwarded-host': req.headers.host || HOST + ':' + PORT,
    'x-forwarded-proto': 'http'
  });
  // 交给 Node 自己管理连接与压缩，避免透传后响应头与实体不一致
  delete headers['connection'];
  delete headers['accept-encoding'];

  const mod = remoteUrl.protocol === 'https:' ? https : http;
  const opts = {
    protocol: remoteUrl.protocol,
    hostname: remoteUrl.hostname,
    port: remoteUrl.port || (remoteUrl.protocol === 'https:' ? 443 : 80),
    method: req.method,
    path: req.url, // 含 query，原样转发
    headers: headers
  };

  console.log('[proxy] ' + req.method + ' ' + req.url + ' -> ' + REMOTE + req.url);

  const preq = mod.request(opts, function (pres) {
    res.writeHead(pres.statusCode, pres.headers);
    pres.pipe(res);
  });
  preq.setTimeout(30000, function () { preq.destroy(new Error('请求线上后端超时（30s）')); });
  preq.on('error', function (err) {
    console.error('[proxy 失败] ' + req.method + ' ' + req.url + ' : ' + err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ code: 502, message: '代理到线上后端失败：' + err.message }));
  });
  req.pipe(preq);
}

/* ---------------- 请求处理 ---------------- */
function handle(req, res) {
  const pathname = new URL(req.url, 'http://' + (req.headers.host || 'localhost')).pathname;

  // 1) 接口 / 上传文件 → 转发线上
  for (let i = 0; i < PROXY_PREFIXES.length; i++) {
    const p = PROXY_PREFIXES[i];
    if (pathname === p || pathname.indexOf(p + '/') === 0) return proxy(req, res);
  }

  // 2) 根路径 → 跳到 H5 首页（与线上 /h5/ec9/ 一致）
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(302, { Location: H5_HOME });
    return res.end();
  }

  // 3) 线上那些友好路由（短信链接 / 后台生成链接用）
  for (let i = 0; i < FRIENDLY_ROUTES.length; i++) {
    if (FRIENDLY_ROUTES[i].re.test(pathname)) {
      return sendFile(req, res, path.join(H5_ROOT, FRIENDLY_ROUTES[i].file));
    }
  }

  // 4) /h5/** → public/h5/**（与线上挂载点一致）
  if (pathname.indexOf('/h5/') === 0) {
    const abs = safeJoin(H5_ROOT, pathname.slice('/h5'.length));
    return abs ? sendFile(req, res, abs) : notFound(res);
  }

  // 5) /ec9/** → public/h5/ec9/**（本地调试省掉 /h5 前缀）
  if (pathname.indexOf('/ec9/') === 0) {
    const abs = safeJoin(path.join(H5_ROOT, 'ec9'), pathname.slice('/ec9'.length));
    return abs ? sendFile(req, res, abs) : notFound(res);
  }

  notFound(res);
}

/* ---------------- 启动 ---------------- */
const server = http.createServer(handle);
server.listen(PORT, HOST, function () {
  const bar = '='.repeat(56);
  console.log('\n' + bar);
  console.log('  EC9 前台 H5 本地开发服务器（前端本地 / 后端线上）');
  console.log(bar);
  console.log('  本机地址   http://' + HOST + ':' + PORT + H5_HOME);
  console.log('  接口代理   /api、/uploads  ->  ' + REMOTE);
  console.log('  静态目录   ' + H5_ROOT);
  console.log('  提示       Ctrl+C 停止；页面已 no-cache，改完直接刷新');
  console.log(bar + '\n');
});
server.on('error', function (err) {
  if (err.code === 'EADDRINUSE') {
    console.error('端口 ' + PORT + ' 已被占用，换一个：node dev-h5.js --port 5181');
  } else {
    console.error('启动失败：' + err.message);
  }
  process.exit(1);
});
