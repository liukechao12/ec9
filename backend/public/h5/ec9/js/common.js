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
    get lang() { return localStorage.getItem("ec9_lang") || "zh-CN"; },
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
  function applyLang() {
    document.documentElement.lang = S.lang === "zh-Hant" ? "zh-Hant" : (S.lang === "en" ? "en" : "zh-CN");
    var nodes = document.querySelectorAll("[data-i18n]");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var key = el.getAttribute("data-i18n");
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") el.placeholder = t(key);
      else el.textContent = t(key);
    }
  }

  /* ---------- 请求 ---------- */
  function request(path, opts) {
    opts = opts || {};
    var headers = { "Content-Type": "application/json" };
    // 后端中间件读的是小写 x-verify-token（见 middleware/requireVerified.js）
    if (S.token) headers["x-verify-token"] = S.token;
    return fetch(API + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
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
    var el = document.createElement("div");
    el.className = "ec9-toast";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.classList.add("show"); }, 10);
    setTimeout(function () { el.classList.remove("show"); setTimeout(function () { el.remove(); }, 300); }, 2400);
  }
  function errPill(msg) {
    var p = document.getElementById("errPill");
    if (!p) { toast(msg); return; }
    p.textContent = msg; p.classList.remove("hidden");
  }

  /* ---------- 品牌头 + 语言切换 ---------- */
  function header(tall) {
    var langs = ["zh-CN", "en", "zh-Hant"];
    var labels = { "zh-CN": "简体", "en": "English", "zh-Hant": "繁體" };
    return '<div class="brand' + (tall ? " brand--tall" : "") + '">' +
      '<img src="assets/logo.png" alt="Earth Cloning Plan 9"></div>' +
      '<div class="lang-switch" id="langBtn">' +
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6">' +
      '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.8 2.6 4 5.6 4 9s-1.2 6.4-4 9c-2.8-2.6-4-5.6-4-9s1.2-6.4 4-9z"/></svg>' +
      '<span>' + labels[S.lang] + '</span></div>' +
      '<div class="lang-menu hidden" id="langMenu">' +
      langs.map(function (l) { return '<div data-lang="' + l + '">' + labels[l] + '</div>'; }).join("") +
      '</div>';
  }

  function mountHeader(container, tall) {
    container.innerHTML = header(tall);
    var btn = document.getElementById("langBtn");
    var menu = document.getElementById("langMenu");
    btn.addEventListener("click", function (e) { e.stopPropagation(); menu.classList.toggle("hidden"); });
    menu.querySelectorAll("[data-lang]").forEach(function (el) {
      el.addEventListener("click", function () { S.lang = el.dataset.lang; location.reload(); });
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
    S: S, t: t, esc: esc, applyLang: applyLang, Api: Api,
    toast: toast, errPill: errPill, header: header, mountHeader: mountHeader,
    param: param, go: go, codeCountdown: codeCountdown,
    DEFAULT_EVENT_ID: DEFAULT_EVENT_ID
  };

  document.addEventListener("DOMContentLoaded", function () { applyLang(); });
})(window);
