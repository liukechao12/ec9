const express = require('express');
const router = express.Router();
const mammoth = require('mammoth');
const fs = require('fs');
const path = require('path');

/* ============================================================
   法务文档（用户协议 / 隐私政策）
   ------------------------------------------------------------
   源文件是主办方给的 docx。目前只有简体版本，原来无论 H5 切到哪种语言
   都返回中文正文，用户会以为「语言没切成功」。
   这里改成：
     1. 按 ?lang= 找对应语言的 docx（命名规则：<文件名>.<lang>.docx，
        例：用户协议-20260312更新.en.docx）；
     2. 找不到就回退简体原文，但通过响应头 X-Legal-Lang 告诉前端
        实际返回的是哪种语言，前端据此挂一句「暂无该语言版本」的说明。
   运营只要往本目录丢对应语言的 docx，前端无需再改。
   ============================================================ */

const BASE_DIR = path.join(__dirname, '..');
const SUPPORTED = ['zh-CN', 'zh-Hant', 'en'];

// 每种文档：依次找，命中第一个存在的文件即生效。
// ⚠️ 新增版本请插到数组**最前面**——这里是「优先新版，其次旧版」的顺序，
//    放在后面就永远不会被选中（只有前面的文件都不存在才会轮到它）。
// 英文/繁体版本不需要在这里登记：文件名加了语言后缀（见 fileCandidates）会自动被识别，
// 例：EC9-用户协议-20261029终稿.en.docx 会被 lang=en 命中。
const DOC_FILES = {
    user: ['EC9-用户协议-20261029终稿.docx', '用户协议-20260312更新.docx', 'EC8-用户协议-20251216更新.docx'],
    privacy: ['EC9-隐私政策-20261029终稿.docx', '隐私政策-20260312更新.docx', 'EC8-隐私政策-20251216更新.docx']
};

const TITLES = {
    user: { 'zh-CN': '用户协议', 'zh-Hant': '用戶協議', 'en': 'User Agreement' },
    privacy: { 'zh-CN': '隐私政策', 'zh-Hant': '隱私政策', 'en': 'Privacy Policy' }
};

const cache = {};   // key: kind|lang -> { html, lang }

function fileCandidates(kind, lang) {
    const bases = DOC_FILES[kind] || [];
    const suffix = lang === 'zh-CN' ? '' : '.' + lang;
    const out = [];
    bases.forEach(function (b) {
        const dot = b.lastIndexOf('.');
        const stem = dot > -1 ? b.slice(0, dot) : b;
        out.push(path.join(BASE_DIR, stem + suffix + '.docx'));
    });
    // 简体原文兜底
    if (suffix) bases.forEach(function (b) { out.push(path.join(BASE_DIR, b)); });
    return out;
}

async function loadDoc(kind, lang) {
    const key = kind + '|' + lang;
    if (cache[key]) return cache[key];

    const files = fileCandidates(kind, lang);
    const hit = files.find(function (f) { return fs.existsSync(f); });
    if (!hit) throw new Error('legal doc not found: ' + kind);

    const result = await mammoth.convertToHtml({ path: hit }, {
        includeDefaultStyleMap: true,
        convertImage: mammoth.images.imgElement(function (image) {
            return image.read("base64").then(function (imageBuffer) {
                return {
                    src: "data:" + image.contentType + ";base64," + imageBuffer
                };
            });
        })
    });

    // 命中的是`<stem>.<lang>.docx`才算真正拿到该语言，否则说明走的是简体兜底
    const isLocalized = lang !== 'zh-CN' && hit.indexOf('.' + lang + '.docx') > -1;
    const entry = { html: result.value, lang: isLocalized ? lang : 'zh-CN' };
    cache[key] = entry;
    return entry;
}

function pageHtml(title, bodyHtml, lang) {
    return `
<!DOCTYPE html>
<html lang="${lang || 'zh-CN'}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>${title}</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: 'HONOR Sans CN', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: #fff;
            color: #333;
            line-height: 1.6;
            padding: 20px;
            padding-bottom: 40px;
        }
        .container {
            max-width: 100%;
            margin: 0 auto;
        }
        h1 {
            font-size: 24px;
            font-weight: bold;
            margin-bottom: 20px;
            text-align: center;
            color: #000;
        }
        h2 {
            font-size: 20px;
            font-weight: bold;
            margin-top: 24px;
            margin-bottom: 12px;
            color: #000;
        }
        h3 {
            font-size: 18px;
            font-weight: bold;
            margin-top: 20px;
            margin-bottom: 10px;
            color: #333;
        }
        p {
            font-size: 16px;
            margin-bottom: 12px;
            color: #333;
            text-align: justify;
        }
        /* 确保加粗样式正确显示 */
        strong, b {
            font-weight: 700 !important;
            font-weight: bold !important;
            color: #000 !important;
        }
        p strong, p b {
            font-weight: 700 !important;
            font-weight: bold !important;
            color: #000 !important;
        }
        /* 无序列表：去掉前面的黑点（只影响 ul 自己，不影响内部的有序列表） */
        ul {
            margin-left: 20px;
            margin-bottom: 12px;
            padding-left: 0;
            list-style-type: none;
        }
        /* 有序列表：保留数字序号 1. 2. 3. */
        ol {
            margin-left: 20px;
            margin-bottom: 12px;
            padding-left: 20px;
            list-style-type: decimal;
        }
        li {
            font-size: 16px;
            margin-bottom: 8px;
            color: #333;
        }
        li strong, li b {
            font-weight: 700 !important;
            font-weight: bold !important;
            color: #000 !important;
        }
        ol strong, ol b, ul strong, ul b {
            font-weight: 700 !important;
            font-weight: bold !important;
            color: #000 !important;
        }
        .close-btn {
            position: fixed;
            top: 20px;
            right: 20px;
            width: 40px;
            height: 40px;
            background: rgba(0, 0, 0, 0.5);
            color: #fff;
            border: none;
            border-radius: 50%;
            font-size: 24px;
            cursor: pointer;
            z-index: 1000;
            display: flex;
            align-items: center;
            justify-content: center;
            line-height: 1;
        }
        .close-btn:active {
            background: rgba(0, 0, 0, 0.7);
        }
    </style>
</head>
<body>
    <button class="close-btn">×</button>
    <div class="container">
        <h1>${title}</h1>
        ${bodyHtml}
    </div>
    <script>
        // 关闭按钮处理
        document.querySelector('.close-btn').addEventListener('click', function() {
            // 尝试关闭窗口
            if (window.opener) {
                window.close();
            } else {
                // 如果无法关闭（非脚本打开的窗口），则返回上一页
                window.history.back();
            }
        });
    </script>
</body>
</html>`;
}

function serve(kind) {
    return async function (req, res) {
        const lang = SUPPORTED.indexOf(req.query.lang) > -1 ? req.query.lang : 'zh-CN';
        try {
            const doc = await loadDoc(kind, lang);
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            // 前端靠这个头判断要不要挂「暂无该语言版本」说明
            res.setHeader('X-Legal-Lang', doc.lang);
            // lang 要传实际返回的语言（英文页面若仍写 zh-CN，浏览器会按中文字体渲染）
            res.send(pageHtml(TITLES[kind][lang] || TITLES[kind]['zh-CN'], doc.html, doc.lang));
        } catch (error) {
            console.error('Error serving legal doc:', kind, error && error.message);
            res.status(500).json({ error: 'Failed to load ' + kind });
        }
    };
}

router.get('/user-agreement', serve('user'));
router.get('/privacy-policy', serve('privacy'));

module.exports = router;
