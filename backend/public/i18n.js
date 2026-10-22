/*!
 * EC9 多语言运行时 (i18n)
 * ------------------------------------------------------------------
 * 设计原则：
 *   1. 一个语种一个独立文件：/i18n/<lang>.json，切换语言 = 切换文件
 *   2. 改文案只需覆盖对应的语言文件，不需要改动任何业务 JS
 *   3. 缓存三招：请求串带版本号 / no-store / 加载失败回退 zh-CN
 *   4. 后端不改：接口返回的中文提示语通过「中文 -> 词条」反查表本地化
 * ------------------------------------------------------------------
 * 用法：
 *   HTML : <span data-i18n="admin.guestName">姓名</span>
 *          <input data-i18n-ph="admin.phone">
 *          <div data-i18n-html="..."> / data-i18n-title / data-i18n-aria
 *   JS   : t('admin.guestName')            // 按 key 取
 *          t('报名成功')                    // 直接传中文原文也能翻（反查）
 *          msg(res.message)                // 本地化接口返回文案
 *   切换 : I18N.setLang('en')
 * ------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  /* ============ 配置（改文案后把 VERSION +1 即可强制刷新缓存） ============ */
  var VERSION = '20261014.3';
  var BASE = '/i18n/';
  var DEFAULT_LANG = 'zh-CN';
  var STORE_KEY = 'ec9.lang';
  var SUPPORTED = [
    { code: 'zh-CN', label: '简体中文', short: '简' },
    { code: 'zh-TW', label: '繁體中文', short: '繁' },
    { code: 'en', label: 'English', short: 'EN' }
  ];

  var current = DEFAULT_LANG;
  var packs = {};        // lang -> 词条对象
  var zhIndex = null;    // 中文原文 -> key（由 zh-CN 包反查生成）
  var pending = null;
  var started = false;

  /* 调试模式：URL 带 ?i18n=debug 时，把「有中文但没找到词条」的元素标黄，便于查漏 */
  var DEBUG = false;
  var missing = [];
  try {
    DEBUG = /[?&]i18n=debug/.test(location.search);
  } catch (e) {}
  if (DEBUG) {
    try {
      var st = document.createElement('style');
      st.textContent = '.i18n-missing{outline:2px dashed #F59E0B !important;background:#FEF3C7 !important;}';
      (document.head || document.documentElement).appendChild(st);
    } catch (e) {}
  }

  /** 运行时补充词条：I18N.add('en', { admin: { foo: 'Bar' } }) */
  function add(lang, obj) {
    if (!lang || !isObj(obj)) return;
    packs[lang] = packs[lang] || {};
    for (var g in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, g)) continue;
      if (isObj(obj[g])) {
        packs[lang][g] = packs[lang][g] || {};
        for (var k in obj[g]) packs[lang][g][k] = obj[g][k];
      } else packs[lang][g] = obj[g];
    }
    if (lang === DEFAULT_LANG) { buildIndex(); buildDynIndex(); }
  }

  /** 导出「有中文但没翻」的清单（调试模式用） */
  function reportMissing() {
    console.group('[i18n] 未翻译清单（' + missing.length + '）');
    console.log(missing.slice(0, 200));
    console.log('提示：把这些中文加进 public/i18n/<lang>.json 即可');
    console.groupEnd();
    return missing.slice();
  }

  /* ===================== 工具 ===================== */

  function isObj(o) { return o && typeof o === 'object'; }

  function getByPath(pack, path) {
    if (!isObj(pack) || !path) return undefined;
    var parts = String(path).split('.');
    var node = pack;
    for (var i = 0; i < parts.length; i++) {
      if (!isObj(node)) return undefined;
      node = node[parts[i]];
    }
    return typeof node === 'string' ? node : undefined;
  }

  function eachKey(pack, prefix, out) {
    for (var k in pack) {
      if (!Object.prototype.hasOwnProperty.call(pack, k)) continue;
      var v = pack[k];
      var key = prefix ? prefix + '.' + k : k;
      if (isObj(v)) eachKey(v, key, out);
      else if (typeof v === 'string' && v) out[key] = v;
    }
    return out;
  }

  /**
   * 由 zh-CN 包反查：「中文原文」->「词条 key」
   * 同时登记变体（去掉尾部冒号等），让页面里的「手机号：」也能命中词条「手机号」
   */
  function buildIndex() {
    var flat = eachKey(packs[DEFAULT_LANG] || {}, '', {});
    var idx = Object.create(null);
    for (var key in flat) {
      var zh = flat[key];
      var variants = [zh, zh.trim(), zh.replace(/[：:\s]+$/, '')];
      for (var i = 0; i < variants.length; i++) {
        var v = variants[i];
        if (v && !(v in idx)) idx[v] = key;   // 首次出现的优先
      }
    }
    zhIndex = idx;
  }

  /** 占位符替换：{0} {1} 或 {name} */
  function format(str, params) {
    if (params == null) return str;
    var arr = Array.isArray(params) ? params : [params];
    return str.replace(/\{(\w+)\}/g, function (m, g1) {
      var i = parseInt(g1, 10);
      if (!isNaN(i) && i < arr.length) return String(arr[i]);
      if (isObj(arr[0]) && arr[0][g1] != null) return String(arr[0][g1]);
      return m;
    });
  }

  /* ===================== 加载 ===================== */

  function fetchJSON(url) {
    return new Promise(function (resolve, reject) {
      if (typeof global.fetch === 'function') {
        global.fetch(url, { cache: 'no-store', headers: { 'Accept': 'application/json' } })
          .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
          .then(resolve, reject);
        return;
      }
      // 老浏览器（微信内置 / 低版本 Android）回退 XHR
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch (e) { reject(e); }
        } else reject(new Error('HTTP ' + xhr.status));
      };
      xhr.send();
    });
  }

  function load(lang) {
    if (packs[lang]) return Promise.resolve(packs[lang]);
    return fetchJSON(BASE + lang + '.json?v=' + VERSION).then(function (json) {
      packs[lang] = json || {};
      if (lang === DEFAULT_LANG) buildIndex();
      return packs[lang];
    }).catch(function (err) {
      if (lang !== DEFAULT_LANG) {
        // 回退：改回中文，保证页面永远可用
        console.warn('[i18n] 语言包加载失败，回退 ' + DEFAULT_LANG + '：', err);
        return load(DEFAULT_LANG).then(function () { throw err; });
      }
      packs[lang] = packs[lang] || {};
      buildIndex();
      buildDynIndex();
      return packs[lang];
    });
  }

  /* ===================== 取词 ===================== */

  function lookup(path) {
    var v = getByPath(packs[current], path);
    if (v == null || v === '') v = getByPath(packs[DEFAULT_LANG], path);
    return v;
  }

  /**
   * 翻译。既接受词条 key，也接受中文原文。
   * 取不到时原样返回（页面不会变成空白）。
   */
  function t(key, params, fallback) {
    if (key == null || key === '') return '';
    var val = lookup(key);
    if (val == null && zhIndex) {
      var k = zhIndex[key];
      if (k) val = lookup(k);
    }
    if (val == null) return fallback != null ? fallback : key;
    return format(val, params);
  }

  /** 本地化接口返回的提示语（后端不改，前端反查） */
  function msg(text, params) { return t(text, params); }

  /* ===================== DOM 应用 ===================== */

  var ATTRS = [
    ['data-i18n', 'textContent'],
    ['data-i18n-html', 'innerHTML'],
    ['data-i18n-ph', 'placeholder'],
    ['data-i18n-title', 'title'],
    ['data-i18n-aria', 'ariaLabel']
  ];

  function applyNode(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      var attr = ATTRS[i][0], prop = ATTRS[i][1];
      var key = el.getAttribute(attr);
      if (key == null) continue;
      var val = t(key);
      if (val == null) continue;
      if (prop === 'placeholder') el.placeholder = val;
      else if (prop === 'title') el.title = val;
      else if (prop === 'ariaLabel') el.setAttribute('aria-label', val);
      else el[prop] = val;
    }
  }

  function apply(root) {
    root = root || document;
    if (!root.querySelectorAll) return;
    for (var i = 0; i < ATTRS.length; i++) {
      var nodes = root.querySelectorAll('[' + ATTRS[i][0] + ']');
      for (var j = 0; j < nodes.length; j++) applyNode(nodes[j]);
    }
    autoTranslate(root === document ? document.body : root);
  }

  /* ---------- 动态文案：把「共 3 条」抽象成「共 {0} 条」再查词条 ---------- */

  var dynIndex = null;   // [{re, key, zh}]

  /**
   * 建立「含数字 / 变量文案」的匹配表。
   *
   * ⚠️ 关键坑：多个词条归一化后可能得到**完全相同的模式**——例如「共 {0} 条」
   * 与「{0} 条」归一化后都是「{0} 条」。若不处理，会命中列表里第一个词条，
   * 译出完全错误的内容。因此这里做**歧义检测**：同一模式命中多个词条时
   * 整组丢弃 —— 宁可不翻译，也不翻错。
   */
  function buildDynIndex() {
    var flat = eachKey(packs[DEFAULT_LANG] || {}, '', {});
    var seen = Object.create(null);       // 归一化模式 -> [{key, zh}]
    var order = [];
    for (var key in flat) {
      var zh = flat[key];
      if (typeof zh !== 'string' || !zh) continue;
      if (zh.length > 80) continue;                     // 太长的不做动态匹配
      if (!/\{[^}]+\}/.test(zh) && !/\d/.test(zh)) continue;
      // 把 {xxx} 与数字统一换成占位标记 {0}
      var norm = zh.replace(/\{[^}]*\}/g, '{0}').replace(/\d+/g, '{0}');
      if (!seen[norm]) { seen[norm] = []; order.push(norm); }
      seen[norm].push({ key: key, zh: zh });
    }
    var list = [];
    for (var i = 0; i < order.length; i++) {
      var norm = order[i];
      var cands = seen[norm];
      if (cands.length > 1) {
        if (DEBUG) {
          console.warn('[i18n] 动态文案模式歧义，已跳过：' + norm + ' <- ' +
            cands.map(function (c) { return c.key; }).join(', '));
        }
        continue;
      }
      var re = new RegExp('^' + norm
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\\\{0\\\}/g, '([\\s\\S]+?)') + '$');
      list.push({ re: re, key: cands[0].key, zh: cands[0].zh });
    }
    dynIndex = list;
  }

  /**
   * 尝试翻译含动态内容的文本。
   * @return {string|null} 翻译结果；无匹配返回 null
   */
  function translateDynamic(text) {
    if (!dynIndex || current === DEFAULT_LANG) return null;
    if (!/[\u4e00-\u9fff]/.test(text)) return null;
    if (text.length > 80) return null;
    for (var i = 0; i < dynIndex.length; i++) {
      var m = dynIndex[i].re.exec(text);
      if (!m) continue;
      var val = lookup(dynIndex[i].key);
      if (val == null || val === dynIndex[i].zh) return null;
      // 把目标语言词条里的占位符，依次替换成实际捕获到的参数
      var params = Array.prototype.slice.call(m, 1);
      var idx = 0;
      return val.replace(/\{[^}]*\}/g, function () {
        return idx < params.length ? params[idx++] : '';
      });
    }
    return null;
  }

  /* ---------- 自动翻译：整段文本完全命中词条的才替换（不做部分替换） ---------- */

  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, CODE: 1, PRE: 1 };

  function translatable(el) {
    if (!el || !el.tagName) return false;
    if (SKIP_TAGS[el.tagName]) return false;
    if (el.getAttribute && el.getAttribute('data-i18n-off') != null) return false;
    if (el.closest && el.closest('[data-i18n-off]')) return false;
    if (el.isContentEditable) return false;
    return true;
  }

  /**
   * 元素是否由 data-i18n / data-i18n-html **按 key 权威托管**。
   *
   * ⚠️ 这类元素的内容必须跳过 autoTranslate，否则会被「中文原文反查」串到
   * 另一条同字词条上：例如 `<div data-i18n="admin.guestName">姓名</div>`，
   * 原文「姓名」在 zhIndex 里另有 admin.name / h5Invite.name 等同字条目，
   * 一旦被反查处理，就会显示成别的意思（而不是「嘉宾姓名」）。
   * applyNode() 已按 key 写入正确译文，这里只需跳过，不要参与还原。
   */
  function hasI18nOwner(el) {
    if (!el || !el.closest) return false;
    return !!el.closest('[data-i18n],[data-i18n-html]');
  }

  /* ============================================================
   * 文本节点原文备份表
   * ------------------------------------------------------------
   * ⚠️ 这是「只能切一次、不能来回切」的根因修复。
   *
   * autoTranslate() 会把中文文本节点**直接覆盖**成外文。切回中文时，
   * 元素上的 data-i18n 能靠词条 key 自动还原，但**没有 data-i18n 的
   * 动态文本**（列表表头、统计数字、拼接出来的提示语）原文已被覆盖，
   * 无从查回 —— 于是页面卡在外文，再也切不回来。
   *
   * 这里按「文本节点对象」记住中文原文，切回中文时遍历还原。
   * 用数组而非 WeakMap：本文件要兼容很老的浏览器（已有 XHR 回退），
   * 每次 apply 时顺带清理已脱离文档的节点，避免无限堆积。
   * ============================================================ */
  var srcStore = [];   // [{node: TextNode, src: '中文原文'}]

  /** 记住一个文本节点的原文；已经切过语言时不覆盖最初的中文 */
  function rememberSrc(node, raw) {
    for (var i = 0; i < srcStore.length; i++) {
      if (srcStore[i].node === node) return;
    }
    srcStore.push({ node: node, src: raw });
  }

  /** 节点是否在 root 之内（含 root 自身） */
  function withinRoot(node, root) {
    if (!node) return false;
    if (node === root) return true;
    if (!root || !root.contains) return true;   // root 是 document 等对象时视为全包含
    return root.contains(node);
  }

  /**
   * 把被覆盖过的文本节点**还原成中文原文**。
   *
   * ⚠️ 关键 1：还原不以「目标是中文」为前提，而是一律先还原。
   * 因为 zhIndex 是拿**简体原文**反查建的 —— 若节点里存着上一种外语
   * （切到 zh-TW 后是「嘉賓管理」，切到 en 后是 "Guest Management"），
   * 反查一律落空，文案就会卡死在上一语言：
   *     zh-CN → zh-TW → en   最后停在繁体
   *     zh-CN → en  → zh-TW 最后停在英文
   * 统一「先还原到中文基准 → 再按目标语言翻译」后，语言之间才能任意直切。
   *
   * ⚠️ 关键 2（曾导致「切换后大面积变回简体」）：**只还原 root 范围内的节点。**
   *   autoTranslate(root) 之后只会重译 root 范围，若这里把全文档都还原，
   *   范围外的节点就被永久留在中文。典型触发路径：
   *     MutationObserver 回调 apply(某个新增节点)
   *     → autoTranslate(那个节点) → 先把**整个页面**还原成中文 → 只翻那一小块
   *     → header、侧边栏、表格里已翻好的文案集体回退成简体。
   *   实测 setLang('en') 后 350ms 就会这样：apply 已翻好，Observer 一跑就全退回。
   *
   * 只还原 srcStore 里记过的节点（即本机制自己覆盖过的），
   * 业务在切换后新写入的内容不受影响。
   * 顺手清掉已脱离文档的节点，防止 srcStore 无限增长。
   */
  function restoreTextSrc(root) {
    var keep = [];
    for (var i = 0; i < srcStore.length; i++) {
      var item = srcStore[i];
      // 节点已被业务重新渲染掉 → 丢弃记录
      if (!item.node.parentNode) continue;
      // 不在本次处理范围内 → 保持它当前的语言，记录留着以后再用
      if (!withinRoot(item.node, root)) {
        keep.push(item);
        continue;
      }
      var el = item.node.parentNode;
      if (translatable(el) && !hasI18nOwner(el)) item.node.nodeValue = item.src;
      // 始终保留：切到任何语言（含另一种外语）都要能还原
      keep.push(item);
    }
    srcStore = keep;
  }

  function autoTranslate(root) {
    if (!root || !zhIndex) return;

    // ★ 无条件先还原成中文基准（文本节点 + 属性）。
    //   旧实现把还原放在「目标是中文」分支里，于是 zh-TW ↔ en 这类
    //   不经中文中转的切换会失败。详见 restoreTextSrc 的注释。
    restoreTextSrc(root);
    translateAttrs(root);
    if (current === DEFAULT_LANG) return;

    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    var node, todo = [];
    while ((node = walker.nextNode())) {
      var raw = node.nodeValue;
      if (!raw || !raw.trim()) continue;
      if (!translatable(node.parentNode)) continue;
      // data-i18n 托管的文本由 applyNode 按 key 写入，autoTranslate 不碰
      if (hasI18nOwner(node.parentNode)) continue;
      var text = raw.replace(/\s+/g, ' ').trim();
      if (text.length < 2 || text.length > 80) continue;   // 太短/太长的多半是数据
      var key = zhIndex[text];
      if (!key) key = zhIndex[text.replace(/[：:\s]+$/, '')];   // 去掉尾部冒号再试
      var val = null;
      if (key) {
        val = lookup(key);
      } else {
        // 整段没命中 → 试动态文案（如「已删除 3 条」）
        val = translateDynamic(text);
      }
      if (val == null) {
        if (DEBUG && /[\u4e00-\u9fff]/.test(text)) {
          missing.push(text);
          if (node.parentNode && node.parentNode.classList) node.parentNode.classList.add('i18n-missing');
        }
        continue;
      }
      if (val === text) continue;
      // 覆盖之前先记住中文原文，供切回中文时还原
      rememberSrc(node, raw);
      todo.push([node, /^\s|\s$/.test(raw) ? raw.replace(text, val) : val]);
    }
    for (var i = 0; i < todo.length; i++) todo[i][0].nodeValue = todo[i][1];
    translateAttrs(root);
  }

  /**
   * 翻译元素**属性**里的中文：placeholder / title / aria-label / value(按钮)。
   *
   * ⚠️ autoTranslate 只处理文本节点，placeholder 这类属性不会被翻译 ——
   * 实测会导致英文环境下「请输入用户名」这类提示仍是中文。
   * 需要在 apply() 时主动扫一遍；切换语言时再扫回中文。
   */
  var ATTR_KEYS = [
    ['placeholder', 'placeholder'],
    ['title', 'title'],
    ['aria-label', 'ariaLabel'],
    ['data-i18n-ph-src', 'placeholder'],
    ['data-i18n-title-src', 'title']
  ];

  function translateAttrs(root) {
    if (!root || !zhIndex) return;
    var back = (current === DEFAULT_LANG);
    var all = (root.querySelectorAll ? root.querySelectorAll('*') : []);
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!translatable(el)) continue;
      // data-i18n-ph / data-i18n-title 由 applyNode 按 key 写入，不走反查
      if (el.hasAttribute('data-i18n-ph') || el.hasAttribute('data-i18n-title') ||
          el.hasAttribute('data-i18n-aria')) continue;
      for (var j = 0; j < ATTR_KEYS.length; j++) {
        var attr = ATTR_KEYS[j][0], prop = ATTR_KEYS[j][1];
        var srcAttr = 'data-i18n-src-' + attr;
        // ① 先还原成中文基准（不论目标语言是不是中文）——
        //    否则 zh-TW → en 时属性里存的是「請輸入手機號」，简体反查表查不到，
        //    会卡在繁体。与 restoreTextSrc 同理。
        var saved = el.getAttribute(srcAttr);
        if (saved != null) {
          try { el[prop] = saved; } catch (e) {}
        }
        // ② 目标是中文：还原完即可返回
        if (back) continue;
        var cur = el.getAttribute(attr);
        if (!cur || !/[\u4e00-\u9fff]/.test(cur)) continue;
        var key = zhIndex[cur] || zhIndex[cur.replace(/[：:\s]+$/, '')];
        var val = key ? lookup(key) : translateDynamic(cur);
        if (val == null || val === cur) continue;
        // 存中文原文，供下一次切换时还原基准
        if (saved == null) el.setAttribute(srcAttr, cur);
        try { el[prop] = val; } catch (e) {}
      }
    }
  }

  var obsTimer = null;
  function observe() {
    if (typeof MutationObserver === 'undefined') return;
    var mo = new MutationObserver(function (muts) {
      if (current === DEFAULT_LANG) return;
      var targets = [];
      for (var i = 0; i < muts.length && targets.length < 40; i++) {
        var m = muts[i];
        for (var j = 0; j < m.addedNodes.length; j++) {
          var n = m.addedNodes[j];
          if (n.nodeType === 1 && translatable(n)) targets.push(n);
        }
      }
      if (!targets.length) return;
      clearTimeout(obsTimer);
      obsTimer = setTimeout(function () {
        for (var k = 0; k < targets.length; k++) {
          if (!targets[k].parentNode) continue;
          apply(targets[k]);
        }
      }, 60);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  /* ===================== 语言切换 ===================== */

  function detect() {
    var q = null;
    try {
      q = new URLSearchParams(location.search).get('lang');
    } catch (e) {
      var m = /[?&]lang=([^&]+)/.exec(location.search);
      q = m ? decodeURIComponent(m[1]) : null;
    }
    if (q && isValid(q)) return q;
    var saved = null;
    try { saved = localStorage.getItem(STORE_KEY); } catch (e) {}
    if (saved && isValid(saved)) return saved;
    var nav = (navigator.language || navigator.browserLanguage || '').toLowerCase();
    if (nav.indexOf('zh-tw') === 0 || nav.indexOf('zh-hk') === 0 || nav.indexOf('zh-hant') === 0) return 'zh-TW';
    if (nav.indexOf('zh') === 0) return 'zh-CN';
    if (nav.indexOf('en') === 0) return 'en';
    return DEFAULT_LANG;
  }

  function isValid(code) {
    for (var i = 0; i < SUPPORTED.length; i++) if (SUPPORTED[i].code === code) return true;
    return false;
  }

  function setLang(lang, silent) {
    if (!isValid(lang)) lang = DEFAULT_LANG;
    var prev = current;
    current = lang;
    try { localStorage.setItem(STORE_KEY, lang); } catch (e) {}
    if (document.documentElement) {
      document.documentElement.lang = lang;
      document.documentElement.setAttribute('data-lang', lang);
    }
    pending = load(lang).then(function () {
      if (current !== lang) return;      // 期间又被切走，丢弃
      apply(document);
      if (!silent) {
        try {
          global.dispatchEvent(new CustomEvent('i18n:changed', { detail: { lang: lang, prev: prev } }));
        } catch (e) {}
      }
    }).catch(function () { /* 已回退中文，不抛 */ });
    return pending;
  }

  function getLang() { return current; }
  function langs() { return SUPPORTED.slice(); }

  /* ===================== 语言切换控件 ===================== */

  function mountSwitcher(el, opt) {
    el = typeof el === 'string' ? document.getElementById(el) : el;
    if (!el) return null;
    ensureStyle();
    opt = opt || {};
    var style = opt.style || 'seg';   // seg(分段按钮) | select | buttons

    /**
     * 分段按钮组：三个语种平铺，当前项高亮。
     * 比原生 select 好看，且一眼能看到有哪几种语言。
     */
    function renderSeg() {
      el.innerHTML = '';
      var wrap = document.createElement('div');
      wrap.className = 'i18n-seg';
      wrap.setAttribute('role', 'group');
      wrap.setAttribute('aria-label', t('common.switchLanguage'));

      SUPPORTED.forEach(function (l) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'i18n-seg-btn' + (l.code === current ? ' active' : '');
        b.setAttribute('aria-pressed', l.code === current ? 'true' : 'false');
        b.title = l.label;
        b.setAttribute('data-lang', l.code);
        // 用 short 做按钮文字（简 / 繁 / EN），短才不会挤
        b.textContent = l.short || l.label;
        b.onclick = function () { setLang(l.code); };
        wrap.appendChild(b);
      });
      el.appendChild(wrap);
    }

    function render() {
      if (style === 'seg') return renderSeg();
      if (style === 'buttons') {
        el.innerHTML = '';
        SUPPORTED.forEach(function (l) {
          var b = document.createElement('button');
          b.type = 'button';
          b.textContent = l.label;
          b.className = 'i18n-btn' + (l.code === current ? ' active' : '');
          b.onclick = function () { setLang(l.code); };
          el.appendChild(b);
        });
        return;
      }
      var sel = document.createElement('select');
      sel.className = 'i18n-select';
      sel.setAttribute('aria-label', t('common.switchLanguage'));
      SUPPORTED.forEach(function (l) {
        var o = document.createElement('option');
        o.value = l.code;
        o.textContent = l.label;
        if (l.code === current) o.selected = true;
        sel.appendChild(o);
      });
      sel.onchange = function () { setLang(sel.value); };
      el.innerHTML = '';
      el.appendChild(sel);
    }

    render();
    global.addEventListener('i18n:changed', render);
    return el;
  }

  /**
   * 注入切换器样式。
   * i18n.js 是共享库，H5 各页面不共用后台的 CSS，
   * 所以这里按需注入一次，避免每个页面各写一份。
   */
  var STYLE_ID = 'i18n-seg-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css =
      '#langSwitcher{display:flex;align-items:center;}' +
      '.i18n-seg{display:inline-flex;background:rgba(243,244,246,.92);' +
      'border:1px solid rgba(229,231,235,.9);border-radius:999px;padding:3px;gap:2px;' +
      'backdrop-filter:saturate(180%) blur(8px);box-shadow:0 2px 10px rgba(16,24,40,.10);}' +
      '.i18n-seg-btn{appearance:none;border:none;background:transparent;color:#6B7280;' +
      'font-size:12px;font-weight:500;line-height:1;padding:7px 12px;border-radius:999px;' +
      'cursor:pointer;transition:background .15s,color .15s,box-shadow .15s;min-width:36px;' +
      'font-family:inherit;}' +
      '.i18n-seg-btn:hover{color:#111827;background:rgba(255,255,255,.75);}' +
      '.i18n-seg-btn:focus-visible{outline:2px solid #155DFC;outline-offset:1px;}' +
      '.i18n-seg-btn.active{background:#155DFC;color:#fff;font-weight:600;' +
      'box-shadow:0 1px 3px rgba(21,93,252,.35);}' +
      '.i18n-seg-btn.active:hover{background:#0B4FD1;color:#fff;}';
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.type = 'text/css';
    // createTextNode 在精简 DOM 实现里可能不存在，退回innerHTML
    if (document.createTextNode) {
      el.appendChild(document.createTextNode(css));
    } else {
      el.innerHTML = css;
    }
    var host = document.head || document.documentElement;
    if (host && host.appendChild) host.appendChild(el);
  }

  /** 页面里没有挂载点时，自动插一个悬浮切换器（H5 走这条） */
  function autoMount(opt) {
    opt = opt || {};
    ensureStyle();
    if (document.getElementById('langSwitcher')) { mountSwitcher('langSwitcher', opt); return; }
    if (opt.auto !== true && !document.body) return;
    var box = document.createElement('div');
    box.id = 'langSwitcher';
    box.style.cssText = 'position:fixed;right:14px;bottom:18px;z-index:99999;';
    document.body.appendChild(box);
    mountSwitcher(box, { style: 'seg' });
  }

  /* ===================== 格式本地化 ===================== */

  function fmtDate(d, withTime) {
    if (d == null) return '';
    var date = (d instanceof Date) ? d : new Date(d);
    if (isNaN(date.getTime())) return String(d);
    var y = date.getFullYear(), m = date.getMonth() + 1, day = date.getDate();
    var hh = date.getHours(), mm = date.getMinutes();
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    if (current === 'en') {
      var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      var base = MON[m - 1] + ' ' + day + ', ' + y;
      return withTime ? base + ' ' + p(hh) + ':' + p(mm) : base;
    }
    var zh = y + '年' + m + '月' + day + '日';
    return withTime === false ? zh : zh + ' ' + p(hh) + ':' + p(mm);
  }

  function fmtMoney(amount, currency) {
    var n = Number(amount);
    if (isNaN(n)) return String(amount);
    currency = currency || 'CNY';
    var sym = { CNY: '¥', USD: '$', EUR: '€', HKD: 'HK$' }[currency] || '';
    return sym + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /* ===================== 弹窗文案本地化 ===================== */
  /* 业务代码里 alert('报名成功') 这类提示无需逐处改动，
     统一在这里过一遍反查表即可本地化（可通过 opt.hookAlerts=false 关闭） */
  function hookDialogs() {
    if (global.__i18nDialogHooked) return;
    global.__i18nDialogHooked = true;
    var _alert = global.alert, _confirm = global.confirm;
    global.alert = function (m) {
      return _alert.call(global, typeof m === 'string' ? msg(m) : m);
    };
    global.confirm = function (m) {
      return _confirm.call(global, typeof m === 'string' ? msg(m) : m);
    };
  }

  /* ===================== 启动 ===================== */

  function init(opt) {
    opt = opt || {};
    if (opt.hookAlerts !== false) hookDialogs();
    if (started) return pending;
    started = true;
    var lang = opt.lang || detect();
    current = lang;
    if (document.documentElement) {
      document.documentElement.lang = lang;
      document.documentElement.setAttribute('data-lang', lang);
    }
    // 先垫一张 zh-CN 底包：这样在目标语言包到位前，t() 至少能返回中文，
    // 页面不会露出 admin.xxx 这样的 key
    var base = (lang === DEFAULT_LANG)
      ? Promise.resolve()
      : load(DEFAULT_LANG).catch(function () {});

    pending = base.then(function () { return load(lang); })
      .catch(function () { current = DEFAULT_LANG; })
      .then(function () {
        apply(document);
        if (opt.observe !== false) observe();
        if (opt.switcher !== false) autoMount(opt);
        try {
          global.dispatchEvent(new CustomEvent('i18n:ready', { detail: { lang: current } }));
        } catch (e) {}
      });
    return pending;
  }

  var I18N = {
    init: init,
    t: t,
    msg: msg,
    apply: apply,
    setLang: setLang,
    getLang: getLang,
    langs: langs,
    mountSwitcher: mountSwitcher,
    fmtDate: fmtDate,
    fmtMoney: fmtMoney,
    add: add,
    reportMissing: reportMissing,
    debug: DEBUG,
    version: VERSION,
    DEFAULT_LANG: DEFAULT_LANG,
    _packs: packs
  };

  global.I18N = I18N;
  global.t = t;        // 便捷全局，业务 JS 可直接 t('xxx')
  global.msg = msg;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { init(); });
  } else {
    init();
  }
})(window);
