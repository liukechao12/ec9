/**
 * 法务文档 docx -> HTML（保留 Word 的多级自动编号）
 * ------------------------------------------------------------------
 * 为什么不用 mammoth：
 *   mammoth 不解析 word/numbering.xml，它把编号交给浏览器的 <ol> 自动数。
 *   只要中间夹了一个无编号段落，列表就会断开重排，于是：
 *     - 一级标题每段都重新从 1. 开始（正确应是 1.~17. 连续）
 *     - 二级/三级丢掉父级前缀（正确应是 2.1. / 2.1.1.）
 *   这正是线上「编号错误」的根因。
 *
 * 这里按 ECMA-376 的计数器语义自己算：
 *   - 每个 numId 独立维护 9 级计数器
 *   - 遇到 ilvl=L 的段落：c[L] 递增（首次取 start），并把 L 之后的级别清零
 *   - 用该级 lvlText（如 "%1.%2."）做占位符替换得到编号文本
 *
 * 注意：H5 端 sanitizeLegalHtml() 会剥掉 <style> 标签，
 *       所以段落与编号的排版样式必须写成内联 style，不能只靠 <style> 块。
 */
const fs = require('fs');
const JSZip = require('jszip');
const { DOMParser } = require('@xmldom/xmldom');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function nodeName(el) {
    return el.localName || String(el.nodeName || '').replace(/^.*:/, '');
}
function kids(el, name) {
    const out = [];
    for (let n = el && el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 1 && (!name || nodeName(n) === name)) out.push(n);
    }
    return out;
}
function valOf(el) {
    if (!el) return null;
    return el.getAttribute('w:val') || el.getAttributeNS(W, 'val') || el.getAttribute('val');
}
function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/* ---------- numbering.xml ---------- */
function parseNumbering(xml) {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const root = doc.documentElement;
    const abs = {};
    kids(root, 'abstractNum').forEach(function (an) {
        const id = an.getAttribute('w:abstractNumId') || an.getAttributeNS(W, 'abstractNumId');
        const levels = {};
        kids(an, 'lvl').forEach(function (lv) {
            const il = Number(lv.getAttribute('w:ilvl') || lv.getAttributeNS(W, 'ilvl') || 0);
            levels[il] = {
                start: Number(valOf(kids(lv, 'start')[0]) || 1),
                fmt: valOf(kids(lv, 'numFmt')[0]) || 'decimal',
                text: valOf(kids(lv, 'lvlText')[0]) || ('%' + (il + 1)),
                restart: valOf(kids(lv, 'lvlRestart')[0])
            };
        });
        abs[id] = levels;
    });

    const nums = {};
    kids(root, 'num').forEach(function (n) {
        const numId = n.getAttribute('w:numId') || n.getAttributeNS(W, 'numId');
        const def = { absId: valOf(kids(n, 'abstractNumId')[0]), overrides: {} };
        kids(n, 'lvlOverride').forEach(function (ov) {
            const il = Number(ov.getAttribute('w:ilvl') || ov.getAttributeNS(W, 'ilvl') || 0);
            def.overrides[il] = {
                start: valOf(kids(ov, 'startOverride')[0]),
                lvl: kids(ov, 'lvl')[0] || null
            };
        });
        nums[numId] = def;
    });
    return { abs: abs, nums: nums };
}

/* ---------- 编号格式化 ---------- */
function fmtNum(n, kind) {
    n = Number(n) || 0;
    switch (kind) {
        case 'lowerLetter': return toAlpha(n).toLowerCase();
        case 'upperLetter': return toAlpha(n).toUpperCase();
        case 'lowerRoman': return toRoman(n).toLowerCase();
        case 'upperRoman': return toRoman(n).toUpperCase();
        case 'chineseCounting': return toChinese(n);
        case 'none': return '';
        case 'decimal':
        default: return String(n);
    }
}
function toAlpha(n) {
    let s = '';
    while (n > 0) { n--; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); }
    return s || 'a';
}
function toRoman(n) {
    const map = [[1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],
                 [50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']];
    let s = '';
    for (const [v, c] of map) { while (n >= v) { s += c; n -= v; } }
    return s || 'i';
}
function toChinese(n) {
    const d = '零一二三四五六七八九';
    if (n < 10) return d[n];
    if (n < 20) return '十' + (n % 10 ? d[n % 10] : '');
    if (n < 100) return d[Math.floor(n / 10)] + '十' + (n % 10 ? d[n % 10] : '');
    return String(n);
}

/* ---------- 富文本：w:r / w:t / w:b / w:br / w:tab / w:hyperlink ---------- */
function runsHtml(p) {
    let out = '';
    function emitRun(r) {
        const rPr = kids(r, 'rPr')[0];
        const bEl = rPr ? kids(rPr, 'b')[0] : null;
        const bold = !!bEl && valOf(bEl) !== '0' && valOf(bEl) !== 'false';
        let t = '';
        kids(r).forEach(function (c) {
            const nm = nodeName(c);
            if (nm === 't') t += c.textContent || '';
            else if (nm === 'br') t += '<br>';
            else if (nm === 'tab') t += '&nbsp;&nbsp;';
            else if (nm === 'noBreakHyphen') t += '-';
        });
        if (!t) return;
        out += bold ? '<strong>' + t + '</strong>' : t;
    }
    kids(p).forEach(function (n) {
        const nm = nodeName(n);
        if (nm === 'r') emitRun(n);
        else if (nm === 'hyperlink') kids(n, 'r').forEach(emitRun);
        else if (nm === 'smartTag') kids(n, 'r').forEach(emitRun);
    });
    return out;
}

/* ---------- 主流程 ---------- */
async function renderDocx(filePath) {
    let zip;
    try {
        zip = await JSZip.loadAsync(fs.readFileSync(filePath));
    } catch (e) {
        return null;                        // 打不开就交回 mammoth
    }
    const numFile = zip.file('word/numbering.xml');
    const docFile = zip.file('word/document.xml');
    if (!numFile || !docFile) return null;  // 没有自动编号定义 -> 交回 mammoth

    // 表格 / 图片 / 文本框：mammoth 处理得更好，遇到就整体交回，
    // 避免把结构化内容压成占位文字。目前用户协议均无这些元素。
    const docProbe = await docFile.async('string');
    if (/<w:tbl[\s>]/.test(docProbe) || /<w:drawing[\s>]/.test(docProbe) ||
        /<w:pict[\s>]/.test(docProbe)) return null;

    let numbering;
    try {
        numbering = parseNumbering(await numFile.async('string'));
    } catch (e) {
        return null;
    }
    const doc = new DOMParser().parseFromString(docProbe, 'text/xml');
    const body = kids(doc.documentElement, 'body')[0];
    if (!body) return null;

    const counters = {};      // numId -> [c0..c8]
    let lastTop = 0;          // 最近一次 ilvl=0 的计数值
    const blocks = [];

    kids(body).forEach(function (el) {
        if (nodeName(el) !== 'p' && nodeName(el) !== 'tbl') return;
        if (nodeName(el) === 'tbl') { blocks.push('<p style="margin:0 0 10px;">[表格]</p>'); return; }

        const pPr = kids(el, 'pPr')[0];
        const numPr = pPr ? kids(pPr, 'numPr')[0] : null;
        let label = '';
        let level = null;

        if (numPr) {
            const ilvl = Number(valOf(kids(numPr, 'ilvl')[0]) || 0);
            const numId = valOf(kids(numPr, 'numId')[0]) || '0';
            if (numId !== '0' && ilvl >= 0 && ilvl <= 8) {
                const def = numbering.nums[numId] || { absId: null, overrides: {} };
                const levels = numbering.abs[def.absId] || {};
                const ld = levels[ilvl] || { start: 1, fmt: 'decimal', text: '%' + (ilvl + 1) };
                const ov = def.overrides[ilvl];
                const start = Number((ov && ov.start) || ld.start || 1);

                const c = counters[numId] || (counters[numId] = new Array(9).fill(0));
                c[ilvl] = c[ilvl] === 0 ? start : c[ilvl] + 1;
                for (let j = ilvl + 1; j < 9; j++) c[j] = 0;   // 子级归零
                if (ilvl === 0) lastTop = c[0];

                // 孤立子列表归父：某个 numId 第一次出现就是 ilvl>=1，
                // 且其父级从未出现（c[ilvl-1]===0）——Word 的 numId=2 就是这种情况。
                // 让它挂到紧邻的上一个一级标题下，避免出现 0.1. 这种悬空编号。
                const disp = c.slice();
                if (ilvl > 0 && disp[ilvl - 1] === 0) disp[ilvl - 1] = lastTop;

                label = String(ld.text).replace(/%(\d)/g, function (_, d) {
                    const idx = Number(d) - 1;
                    const lv = levels[idx] || { fmt: 'decimal' };
                    return fmtNum(disp[idx] == null ? 0 : disp[idx], lv.fmt);
                });
                level = ilvl;
            }
        }

        const inner = runsHtml(el);
        if (!inner.trim() && !label) { blocks.push('<p style="margin:0 0 6px;">&nbsp;</p>'); return; }

        // 内联样式：H5 会剥 <style>，只能靠 inline style 保证两端一致。
        // 悬挂缩进（padding-left + 等量负 text-indent）：编号悬浮在左，
        // 正文首行与换行行都对齐到同一列——这才是 Word 列表的观感。
        // padding-left 递进体现层级（1.8em -> 2.8em -> 4.0em）。
        let pStyle;
        let numStyle;
        if (level === 0) {
            pStyle = 'margin:20px 0 10px;font-size:15px;line-height:1.7;' +
                     'padding-left:1.8em;text-indent:-1.8em;';
            numStyle = 'display:inline-block;min-width:1.8em;font-weight:600;color:#1D2129;white-space:nowrap;';
        } else if (level === 1) {
            pStyle = 'margin:0 0 9px;line-height:1.9;text-align:justify;' +
                     'padding-left:2.8em;text-indent:-2.8em;';
            numStyle = 'display:inline-block;min-width:2.8em;color:#1D2129;white-space:nowrap;';
        } else if (level >= 2) {
            pStyle = 'margin:0 0 9px;line-height:1.9;text-align:justify;' +
                     'padding-left:4.0em;text-indent:-4.0em;';
            numStyle = 'display:inline-block;min-width:4.0em;color:#1D2129;white-space:nowrap;';
        } else {
            pStyle = 'margin:0 0 11px;line-height:1.9;text-align:justify;';
            numStyle = '';
        }
        blocks.push('<p style="' + pStyle + '">' +
            (label ? '<span style="' + numStyle + '">' + esc(label) + '</span>' : '') +
            inner + '</p>');
    });

    const html = blocks.join('\n');
    return html.trim() ? html : null;
}

module.exports = { renderDocx: renderDocx };
