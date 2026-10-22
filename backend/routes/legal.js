const express = require('express');
const router = express.Router();
const mammoth = require('mammoth');
const fs = require('fs');
const path = require('path');

// 缓存解析后的HTML内容
let userAgreementHtml = null;
let privacyPolicyHtml = null;

// 解析docx文件并转换为HTML（优先使用20260312版本）
async function loadLegalDocuments() {
    const userAgreementPath = path.join(__dirname, '../用户协议-20260312更新.docx');
    const privacyPolicyPath = path.join(__dirname, '../隐私政策-20260312更新.docx');
    const userAgreementPathFallback = path.join(__dirname, '../EC8-用户协议-20251216更新.docx');
    const privacyPolicyPathFallback = path.join(__dirname, '../EC8-隐私政策-20251216更新.docx');
    
    try {
        if (!userAgreementHtml) {
            const uaPath = fs.existsSync(userAgreementPath) ? userAgreementPath : userAgreementPathFallback;
            const userAgreementResult = await mammoth.convertToHtml({ 
                path: uaPath 
            }, {
                includeDefaultStyleMap: true,
                convertImage: mammoth.images.imgElement(function(image) {
                    return image.read("base64").then(function(imageBuffer) {
                        return {
                            src: "data:" + image.contentType + ";base64," + imageBuffer
                        };
                    });
                })
            });
            userAgreementHtml = userAgreementResult.value;
            // 输出转换消息（用于调试）
            if (userAgreementResult.messages && userAgreementResult.messages.length > 0) {
                console.log('User Agreement conversion messages:', userAgreementResult.messages);
            }
        }
        
        if (!privacyPolicyHtml) {
            const ppPath = fs.existsSync(privacyPolicyPath) ? privacyPolicyPath : privacyPolicyPathFallback;
            const privacyPolicyResult = await mammoth.convertToHtml({ 
                path: ppPath 
            }, {
                includeDefaultStyleMap: true,
                convertImage: mammoth.images.imgElement(function(image) {
                    return image.read("base64").then(function(imageBuffer) {
                        return {
                            src: "data:" + image.contentType + ";base64," + imageBuffer
                        };
                    });
                })
            });
            privacyPolicyHtml = privacyPolicyResult.value;
            // 输出转换消息（用于调试）
            if (privacyPolicyResult.messages && privacyPolicyResult.messages.length > 0) {
                console.log('Privacy Policy conversion messages:', privacyPolicyResult.messages);
            }
        }
    } catch (error) {
        console.error('Error loading legal documents:', error);
        throw error;
    }
}

// 初始化加载文档
loadLegalDocuments().catch(err => {
    console.error('Failed to load legal documents on startup:', err);
});

// 获取用户协议
router.get('/user-agreement', async (req, res) => {
    try {
        if (!userAgreementHtml) {
            await loadLegalDocuments();
        }
        
        // 返回格式化的HTML页面
        const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>用户协议</title>
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
        <h1>用户协议</h1>
        ${userAgreementHtml}
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
        
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    } catch (error) {
        console.error('Error serving user agreement:', error);
        res.status(500).json({ error: 'Failed to load user agreement' });
    }
});

// 获取隐私政策
router.get('/privacy-policy', async (req, res) => {
    try {
        if (!privacyPolicyHtml) {
            await loadLegalDocuments();
        }
        
        // 返回格式化的HTML页面
        const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>隐私政策</title>
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
        <h1>隐私政策</h1>
        ${privacyPolicyHtml}
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
        
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    } catch (error) {
        console.error('Error serving privacy policy:', error);
        res.status(500).json({ error: 'Failed to load privacy policy' });
    }
});

module.exports = router;
