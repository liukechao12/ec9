/* ============================================================
   EC9 H5 公共层：接口封装 / 三语 / 状态 / 跳转 / 品牌头
   挂在 /h5/ec9/ 下，接口用同源绝对地址 /api
   ============================================================ */
(function (w) {
  "use strict";

  var API = "/api";
  var DEFAULT_EVENT_ID = 1; // 会议 ID：上线前改为真实 ID 或用 ?event_id= 指定

  /* ---------- 存储 ---------- */
  var S = {
    /* 语言：设计稿页面内没有切换入口，改用链接参数 ?lang=en / ?lang=zh-Hant，命中即写入本地 */
    get lang() {
      var m = /[?&]lang=([^&#]+)/.exec(location.search);
      var q = m ? decodeURIComponent(m[1]) : "";
      if (q === "en" || q === "zh-Hant" || q === "zh-CN") { localStorage.setItem("ec9_lang", q); return q; }
      return localStorage.getItem("ec9_lang") || "zh-CN";
    },
    set lang(v) { localStorage.setItem("ec9_lang", v); },
    get token() { return sessionStorage.getItem("ec9_vtoken") || ""; },
    set token(v) { sessionStorage.setItem("ec9_vtoken", v); },
    get phone() { return sessionStorage.getItem("ec9_phone") || ""; },
    set phone(v) { sessionStorage.setItem("ec9_phone", v); },
    get data() { try { return JSON.parse(localStorage.getItem("ec9_data") || "{}"); } catch (e) { return {}; } },
    set data(v) { localStorage.setItem("ec9_data", JSON.stringify(v)); },
    patch(obj) { var d = this.data; for (var k in obj) d[k] = obj[k]; this.data = d; },
    clear() { sessionStorage.removeItem("ec9_vtoken"); sessionStorage.removeItem("ec9_phone"); localStorage.removeItem("ec9_data"); }
  };

  /* ---------- 等比适配 ----------
     设计稿是 375px 宽：#app 永远按 375 布局，再整体缩放到屏幕宽度，
     保证任何机型（360/375/390/414/430...）版式比例完全一致，不会错位或留白。
     zoom 会被算进布局（浏览器原生缩放）；不支持的旧 WebView 退化为 transform scale + 占位补偿。 */
  var DESIGN_W = 375;
  var MAX_SCALE = 1.6;              // 宽屏（含桌面预览）上限，避免字被拉得过大
  var isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var zoomSupported = (w.CSS && CSS.supports) ? CSS.supports("zoom", "1.5") : false;

  /* 微信（iOS/Android）里 100vh 是「含浏览器 UI 与底部安全区」的大视口高度，
     比真正能看见的区域高一截（iOS 微信约高 80~130px），直接拿它做 min-height
     会把页面底部按钮顶到微信工具栏/小黑条底下，用户以为「按钮没了」。
     这里用 window.innerHeight（真实可视高度）写一份 --vh 给 CSS 用。 */
  function isTyping() {
    var a = document.activeElement;
    return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable);
  }

  function fitViewport() {
    var app = document.getElementById("app");
    if (!app) return;
    var vw = document.documentElement.clientWidth || w.innerWidth || DESIGN_W;
    if (!vw) return;
    var s = Math.min(vw / DESIGN_W, MAX_SCALE);
    document.documentElement.style.setProperty("--z", s);
    // 键盘弹起时 innerHeight 会缩水，此时不要改 --vh（否则页面上跳）
    var vh = w.innerHeight;
    if (vh && !isTyping()) document.documentElement.style.setProperty("--vh", vh + "px");
    if (zoomSupported) {
      app.style.zoom = s;
    } else {
      app.style.transform = "scale(" + s + ")";
      /* 必须用 top left，不能用 top center：#app 的布局盒是死的 375px，
         在窄屏（360/320）上盒比视口宽，再以盒中心为原点缩放，视觉上会右移
         (375 - 375*s)/2 ≈ 8px —— 页面右边多出一截，微信里能左右拖动。
         改 top left 后再用 marginLeft 抵消宽屏时的居中需求（s 被 MAX_SCALE 卡住时）。 */
      app.style.transformOrigin = "top left";
      var occupied = DESIGN_W * s;
      app.style.marginLeft = Math.max(0, (vw - occupied) / 2) + "px";
      /* 布局盒仍是死的 375px，窄屏（360/320）上它比视口宽 → 页面能左右拖。
         用负的 marginRight 把多出来的那截吃掉，body 就不会出现横向滚动。
         （不能用 html/body{overflow-x:hidden}，那会把滚动容器挪到 body，见 style.css） */
      app.style.marginRight = Math.min(0, vw - DESIGN_W) + "px";
      // transform 不占布局空间，用外边距把被缩掉的高度补回来
      app.style.marginBottom = ((s - 1) * app.offsetHeight) + "px";
    }
    // 回弹露白：iOS 微信上下橡皮筋会露出 html/body 的底色（默认白），
    // 在蓝底页面（协议/结果/电子票）上就是两条白边。让 body 跟着页面底色走。
    try {
      var bg = w.getComputedStyle(app).backgroundColor;
      if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
        document.documentElement.style.backgroundColor = bg;
        document.body.style.backgroundColor = bg;
      }
    } catch (e) {}
  }

  var fitPending = false;
  function fitViewportSoon() {
    if (fitPending) return;
    fitPending = true;
    (w.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); })(function () {
      fitPending = false;
      fitViewport();
    });
  }

  fitViewport();
  w.addEventListener("resize", fitViewport);
  w.addEventListener("orientationchange", function () { setTimeout(fitViewport, 120); });
  w.addEventListener("load", fitViewport);
  // 微信 iOS 走 bfcache 返回时不会触发 load，页面尺寸可能已经变了
  w.addEventListener("pageshow", function (e) { if (e.persisted) fitViewport(); });
  document.addEventListener("DOMContentLoaded", fitViewport);
  // 字体/图片到位后高度会变，再补一次
  setTimeout(fitViewport, 300);
  setTimeout(fitViewport, 1200);

  /* 内容异步到位后高度会变（法务文档是 fetch 回来的、图片解码、列表渲染）。
     transform 分支的 marginBottom 补偿如果不跟着重算，页面底部就有一截滚不到
     —— Android 微信（X5 内核不支持 zoom）上协议页「看不完全文」就是这个原因，
     弱网时 fetch 晚于上面的 1200ms 兜底必踩。用 ResizeObserver 兜住所有情况。 */
  if (w.ResizeObserver) {
    var roTick = null;
    try {
      var ro = new w.ResizeObserver(function () { fitViewportSoon(); });
      var appEl = document.getElementById("app");
      if (appEl) ro.observe(appEl);
      // 观察不到就等 DOM 就绪再挂一次（脚本可能在 #app 之前执行）
      if (!appEl) document.addEventListener("DOMContentLoaded", function () {
        var a = document.getElementById("app");
        if (a) ro.observe(a);
      });
    } catch (e) { /* 老 WebView 没有就算了，上面的定时器兜底 */ }
  }

  /* iOS 微信：软键盘弹起会把页面上顶，收起后 WKWebView 不自动复位，
     页面底部留一条空白、fixed 元素（toast）错位。
     这里在输入框失焦后把滚动位置还原，并重新算一次适配。 */
  var kbScrollY = 0;
  document.addEventListener("focusin", function (e) {
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) kbScrollY = w.scrollY || 0;
  }, true);
  document.addEventListener("focusout", function (e) {
    var t = e.target;
    if (!t || (t.tagName !== "INPUT" && t.tagName !== "TEXTAREA")) return;
    setTimeout(function () {
      if (isIOS) { try { w.scrollTo(0, kbScrollY); } catch (err) {} }
      fitViewport();
    }, 150);
  }, true);

  /* ---------- 三语 ---------- */
  function t(k) {
    var dict = I18N[S.lang] || I18N["zh-CN"];
    return dict[k] != null ? dict[k] : (I18N["zh-CN"][k] != null ? I18N["zh-CN"][k] : k);
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* 后端返回的错误文案是中文（message 字段），逐条改后端成本太高。
     这里做反向映射：字典里 zh-CN 值与后端原文完全一致的 key（server_* 系列），
     显示时自动换成当前语言。以后后端新增文案，只要在字典里加同名 key 即可。 */
  var MSG_REV = {};
  (function buildRev() {
    var d = (typeof I18N !== "undefined") ? I18N["zh-CN"] : {};
    for (var k in d) {
      if (d[k] == null) continue;
      var v = String(d[k]).trim();
      if (v.length >= 2 && v.length <= 40 && MSG_REV[v] === undefined) MSG_REV[v] = k;
    }
  })();
  function localizeMsg(msg) {
    if (!msg) return msg;
    var key = MSG_REV[String(msg).trim()];
    return key ? t(key) : msg;
  }
  /* 写前先比较：值相同就不动 DOM。
     两个用途：① 避免无意义重排；② MutationObserver 自动翻译时靠它收敛，
     否则「改文本 → 触发 mutation → 再改文本」会形成死循环。 */
  function setValue(el, val) {
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      if (el.placeholder !== val) el.placeholder = val;
      return;
    }
    if (el.textContent !== val) el.textContent = val;
    // 某语言刻意留空（如英文界面不需要中文标语）就把整块收起来，别留空行
    if (val === "") { if (el.style.display !== "none") el.style.display = "none"; }
    else if (el.style.display === "none") el.style.display = "";
  }
  /* ---------- 论坛议程卡片（2026-11-02 新稿）----------
     票选择页 / 电子票页共用：三列 上午·下午·晚间，胶囊块横跨整行表示全天时段。
     文案全部走字典，语言切换走 reload，页面初始化时按当前语言取词即可。 */
  function agendaHtml() {
    var pill = function (key, cls) {
      return '<span class="agenda-pill ' + cls + '">' + esc(t(key)) + '</span>';
    };
    return '<div class="agenda-card">' +
      '<div class="agenda-heads">' +
        '<div>' + esc(t("ag_am")) + '</div>' +
        '<div>' + esc(t("ag_pm")) + '</div>' +
        '<div>' + esc(t("ag_eve")) + '</div>' +
      '</div>' +
      '<div class="agenda-grid">' +
        '<div class="agenda-row">' +
          '<div class="agenda-cell">' + pill("ag_keynote", "ag-blue") + '</div>' +
          '<div class="agenda-cell">' + pill("ag_forums", "ag-violet") + '</div>' +
          '<div class="agenda-cell"></div>' +
        '</div>' +
        '<div class="agenda-row agenda-row--full">' +
          '<div class="agenda-full">' + pill("ag_open", "ag-sky") + '</div>' +
        '</div>' +
        '<div class="agenda-row agenda-row--full">' +
          '<div class="agenda-full">' + pill("ag_expo", "ag-sky") + '</div>' +
        '</div>' +
        '<div class="agenda-row">' +
          '<div class="agenda-cell"></div>' +
          '<div class="agenda-cell"></div>' +
          '<div class="agenda-cell">' + pill("ag_night", "ag-night") + '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function applyLang(root) {
    document.documentElement.lang = S.lang === "zh-Hant" ? "zh-Hant" : (S.lang === "en" ? "en" : "zh-CN");
    var scope = root || document;
    var nodes = scope.querySelectorAll("[data-i18n]");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      setValue(el, t(el.getAttribute("data-i18n")));
    }
    if (scope.querySelectorAll && scope.nodeType === 1 && scope.hasAttribute("data-i18n")) {
      setValue(scope, t(scope.getAttribute("data-i18n")));
    }
  }

  /* 动态渲染（innerHTML 拼出来的卡片、价格行、状态卡）发生时，
     DOMContentLoaded 那一次 applyLang 早就跑完了，新节点的 data-i18n 没人管。
     这里统一兜底：只要 DOM 里插入了新节点就补扫一遍。 */
  (function watchDynamic() {
    if (!w.MutationObserver) return;
    var pending = false;
    var run = function () { pending = false; applyLang(); };
    var ob = new MutationObserver(function (muts) {
      var hit = false;
      for (var i = 0; i < muts.length; i++) {
        if (muts[i].addedNodes.length) { hit = true; break; }
      }
      if (!hit || pending) return;
      pending = true;
      setTimeout(run, 0);
    });
    var start = function () { ob.observe(document.body, { childList: true, subtree: true }); };
    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", start);
  })();

  /* ---------- 本地化格式 ---------- */
  // 日期：中文「2026年12月4日」，英文「December 4, 2026」
  function fmtDate(d) {
    if (!d) return "";
    var dt = (d instanceof Date) ? d : new Date(d);
    if (isNaN(dt.getTime())) return "";
    var y = dt.getFullYear(), m = dt.getMonth() + 1, day = dt.getDate();
    var fmt = t("date_fmt");
    if (fmt.indexOf("{month}") > -1) {
      var names = String(t("months")).split(",");
      fmt = fmt.replace("{month}", names[dt.getMonth()] || m);
    }
    return fmt.replace("{y}", y).replace("{m}", m).replace("{d}", day);
  }
  // 折扣：中文按「9折」说，英文习惯是「10% off」，同一个 rate 两种算法
  function discountText(rate) {
    rate = Number(rate) || 0;
    if (!rate || rate >= 1) return "";
    if (S.lang === "en") return t("discount_badge").replace("{n}", Math.round((1 - rate) * 100));
    return t("discount_badge").replace("{n}", Math.round(rate * 10));
  }

  /* ---------- 请求 ---------- */
  function request(path, opts) {
    opts = opts || {};
    // 传 FormData 时不能设 Content-Type（浏览器要自动生成 multipart boundary），
    // 也不能 JSON.stringify —— 学生票的《教育部学籍在线验证报告》走这条通道。
    var isForm = (typeof FormData !== "undefined") && opts.body instanceof FormData;
    var headers = isForm ? {} : { "Content-Type": "application/json" };
    // 后端中间件读的是小写 x-verify-token（见 middleware/requireVerified.js）
    if (S.token) headers["x-verify-token"] = S.token;
    return fetch(API + path, {
      method: opts.method || "GET",
      headers: headers,
      body: isForm ? opts.body : (opts.body ? JSON.stringify(opts.body) : undefined)
    }).then(function (r) {
      return r.json().catch(function () { return { code: r.status, message: "响应解析失败" }; });
    }).then(function (j) {
      // EC8 迁移接口成功返回 200，EC9 新增返回 0
      if (j.code === 0 || j.code === 200) return j.data != null ? j.data : {};
      var err = new Error(j.message || "请求失败");
      err.code = j.code; err.errorCode = j.errorCode;
      // 凭证失效（一次性 token 已消耗 / 过期）：回到验证页重取，回来后继续
      if (j.code === 401) {
        S.token = "";
        var back = location.pathname.split("/").pop();
        w.EC9.go("signup.html", {
          event_id: param("event_id", DEFAULT_EVENT_ID),
          redirect: back,
          reg_id: param("reg_id", "")
        });
      }
      throw err;
    });
  }

  var Api = {
    // 公开数据
    event: function (id, lang) {
      return request("/public/events/" + (id || DEFAULT_EVENT_ID) + "?lang=" + (lang || S.lang));
    },
    tickets: function (id, lang) {
      return request("/public/events/" + (id || DEFAULT_EVENT_ID) + "/tickets?lang=" + (lang || S.lang));
    },
    // 验证码
    sendCode: function (phone) { return request("/verification/send-code", { method: "POST", body: { phone: phone } }); },
    verifyCode: function (phone, code) {
      return request("/verification/verify-code", { method: "POST", body: { phone: phone, code: code } });
    },
    // 报名
    submitByPhone: function (body) { return request("/registrations/submit-by-phone", { method: "POST", body: body }); },
    mine: function (eventId) {
      return request("/registrations/mine" + (eventId ? "?event_id=" + eventId : ""));
    },
    // 多人代报
    submitGroup: function (body) { return request("/registrations/submit-group", { method: "POST", body: body }); },
    groupQuote: function (eventId, members) {
      return request("/registrations/group/quote", { method: "POST", body: { event_id: eventId, members: members } });
    },
    checkInvited: function (phones, eventId) {
      return request("/registrations/check-invited", { method: "POST", body: { phones: phones, event_id: eventId } });
    },
    groupInfo: function (groupNo, payToken) {
      return request("/registrations/group/" + groupNo + (payToken ? "?pay_token=" + encodeURIComponent(payToken) : ""));
    },
    // 短信付款链接（免登录，pay_token 鉴权）
    groupPayInfo: function (orderNo, payToken) {
      return fetch(API + "/payment/group/" + orderNo + "?pay_token=" + encodeURIComponent(payToken))
        .then(function (r) { return r.json(); })
        .then(function (j) { if (j.code === 0 || j.code === 200) return j.data; throw new Error(j.message || "请求失败"); });
    },
    groupPay: function (orderNo, payToken, openid) {
      return fetch(API + "/payment/group/" + orderNo + "/pay", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pay_token: payToken, openid: openid || null })
      }).then(function (r) { return r.json(); })
        .then(function (j) { if (j.code === 0 || j.code === 200) return j.data; throw new Error(j.message || "请求失败"); });
    },
    groupMockPay: function (orderNo, payToken) {
      return fetch(API + "/payment/group/" + orderNo + "/mock-pay", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pay_token: payToken })
      }).then(function (r) { return r.json(); })
        .then(function (j) { if (j.code === 0 || j.code === 200) return j.data; throw new Error(j.message || "请求失败"); });
    },
    // 订单
    createOrder: function (registrationId, quantity, unitPrice) {
      return request("/orders", { method: "POST", body: { registration_id: registrationId, quantity: quantity, unit_price: unitPrice } });
    },
    // 支付
    payNative: function (orderNo) { return request("/payment/native", { method: "POST", body: { order_no: orderNo } }); },
    payJsapi: function (orderNo) { return request("/payment/jsapi", { method: "POST", body: { order_no: orderNo } }); },
    queryPay: function (orderNo) { return request("/payment/query/" + orderNo); },
    mockPay: function (orderNo) { return request("/payment/mock-pay/" + orderNo, { method: "POST" }); },
    // 签到
    checkin: function (phone, eventId) { return request("/checkins/event-checkin", { method: "POST", body: { phone: phone, event_id: eventId } }); }
  };

  /* ---------- UI 小工具 ---------- */
  function toast(msg) {
    msg = localizeMsg(msg);
    var el = document.createElement("div");
    el.className = "ec9-toast";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.classList.add("show"); }, 10);
    setTimeout(function () { el.classList.remove("show"); setTimeout(function () { el.remove(); }, 300); }, 2400);
  }
  function errPill(msg) {
    if (msg) msg = localizeMsg(msg);
    var p = document.getElementById("errPill");
    if (!p) { toast(msg); return; }
    p.textContent = msg; p.classList.remove("hidden");
  }

  /* ---------- 品牌头 ----------
     banner 内的主标题 / 英文标语 / 中文标语在设计稿里是「转曲的艺术字」，
     真字体无法复现字形，已随 img/signup_bg.png 切片输出，这里不再渲染文字；
     语言切换器不属于设计稿 1:1 还原范围，但属于产品功能入口，予以保留。 */
  var LANGS = ["zh-CN", "en", "zh-Hant"];
  var LANG_LABELS = { "zh-CN": "简体", "en": "English", "zh-Hant": "繁體" };

  function header(tall) {
    return '<div class="brand' + (tall ? " brand--tall" : "") + '"></div>' +
      '<div class="lang-switch" id="langBtn">' +
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6">' +
      '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.8 2.6 4 5.6 4 9s-1.2 6.4-4 9c-2.8-2.6-4-5.6-4-9s1.2-6.4 4-9z"/></svg>' +
      '<span>' + LANG_LABELS[S.lang] + '</span></div>' +
      '<div class="lang-menu hidden" id="langMenu">' +
      LANGS.map(function (l) { return '<div data-lang="' + l + '">' + LANG_LABELS[l] + '</div>'; }).join("") +
      '</div>';
  }

  function mountHeader(container, tall) {
    container.innerHTML = header(tall);
    var btn = document.getElementById("langBtn");
    var menu = document.getElementById("langMenu");
    if (!btn || !menu) return;
    btn.addEventListener("click", function (e) { e.stopPropagation(); menu.classList.toggle("hidden"); });
    menu.querySelectorAll("[data-lang]").forEach(function (el) {
      el.addEventListener("click", function () {
        S.lang = el.dataset.lang;
        // S.lang 的 getter 里 URL 上的 ?lang= 优先级高于 localStorage，
        // 不清掉的话 reload 后会被 URL 参数打回切换前的语言（表现为「切不动」）。
        if (w.URL && w.history && w.history.replaceState) {
          try {
            var u = new w.URL(location.href);
            if (u.searchParams.has("lang")) {
              u.searchParams.delete("lang");
              history.replaceState(null, "", u.toString());
            }
          } catch (e) { /* 老浏览器不支持 URL，忽略 */ }
        }
        location.reload();
      });
    });
    document.addEventListener("click", function () { menu.classList.add("hidden"); }, { once: true });
  }

  /* ---------- URL ---------- */
  function param(name, dflt) {
    var m = new RegExp("[?&]" + name + "=([^&#]*)").exec(location.search);
    return m ? decodeURIComponent(m[1]) : (dflt === undefined ? "" : dflt);
  }
  function go(page, params) {
    var q = [];
    for (var k in (params || {})) if (params[k] !== "" && params[k] != null) q.push(k + "=" + encodeURIComponent(params[k]));
    location.href = page + (q.length ? "?" + q.join("&") : "");
  }

  /* ---------- 验证码倒计时 ---------- */
  function codeCountdown(btn) {
    var left = 60;
    btn.disabled = true;
    var orig = btn.dataset.orig || btn.textContent;
    btn.dataset.orig = orig;
    var tick = function () {
      if (left <= 0) { btn.textContent = orig; btn.disabled = false; clearInterval(timer); return; }
      btn.textContent = left + "s"; left--;
    };
    tick();
    var timer = setInterval(tick, 1000);
  }

  w.EC9 = {
    S: S, t: t, esc: esc, applyLang: applyLang, Api: Api, agendaHtml: agendaHtml,
    toast: toast, errPill: errPill, header: header, mountHeader: mountHeader,
    param: param, go: go, codeCountdown: codeCountdown,
    fmtDate: fmtDate, discountText: discountText, localizeMsg: localizeMsg,
    DEFAULT_EVENT_ID: DEFAULT_EVENT_ID
  };

  document.addEventListener("DOMContentLoaded", function () { applyLang(); });
})(window);
