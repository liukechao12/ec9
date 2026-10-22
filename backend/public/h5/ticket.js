/**
 * EC9 H5 · 购票 / 查票页
 * 数据源：GET /api/public/tickets/my?code=<签到码>&lang=<语种>
 *
 * 为什么单独写而不用 EC8 的那套：EC8 没有购票概念，
 * 短信里的 ticket.html 链接在 EC8 是死链（我确认过 EC8 全库无此页面）。
 * EC9 建单支付成功后才生成签到码，短信通知指向本页。
 */
(function () {
  'use strict';

  function qs(name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(window.location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  }

  function setState(which) {
    ['loading', 'error', 'ticket'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.style.display = id === which ? '' : 'none';
    });
  }

  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // 语种跟着 i18n 走；i18n 未就绪时退简体
  function curLang() {
    try {
      if (window.i18n && typeof window.i18n.getLang === 'function') {
        return window.i18n.getLang() || 'zh-CN';
      }
      if (window.i18n && window.i18n.lang) return window.i18n.lang;
    } catch (e) { /* ignore */ }
    return 'zh-CN';
  }

  function render(t) {
    document.getElementById('guestName').textContent = t.guest_name || '-';
    document.getElementById('company').textContent = t.company || '-';
    document.getElementById('position').textContent = t.position || '-';
    document.getElementById('eventName').textContent = (t.event && t.event.name) || '-';
    document.getElementById('code').textContent = t.code || '-';

    if (t.session_name) {
      document.getElementById('sessionRow').style.display = '';
      document.getElementById('sessionName').textContent = t.session_name;
    }
    if (t.ticket_name) {
      document.getElementById('ticketTypeRow').style.display = '';
      document.getElementById('ticketName').textContent = t.ticket_name;
    }
    var time = fmtTime(t.event && t.event.start_time);
    if (time) {
      document.getElementById('timeRow').style.display = '';
      document.getElementById('eventTime').textContent = time;
    }
    var loc = t.event && t.event.location;
    if (loc) {
      document.getElementById('locationRow').style.display = '';
      document.getElementById('eventLocation').textContent = loc;
    }

    var badge = document.getElementById('codeStatus');
    if (t.code_status === 'used') {
      badge.className = 'badge used';
      badge.textContent = (window.t && window.t('h5.ticket.used')) || '已签到';
    } else {
      badge.className = 'badge active';
      badge.textContent = (window.t && window.t('h5.ticket.valid')) || '有效';
    }
  }

  async function load() {
    var code = qs('code');
    if (!code) {
      setState('error');
      return;
    }
    setState('loading');
    try {
      var res = await fetch('/api/public/tickets/my?code=' + encodeURIComponent(code) + '&lang=' + encodeURIComponent(curLang()));
      var j = await res.json();
      if ((j.code === 0 || j.code === 200) && j.data && j.data.ticket) {
        render(j.data.ticket);
        setState('ticket');
      } else {
        var msg = document.getElementById('errorMsg');
        if (msg && j.message) msg.textContent = j.message;
        setState('error');
      }
    } catch (e) {
      setState('error');
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (window.i18n && typeof window.i18n.init === 'function') {
      window.i18n.init().then(function () { return load(); }).catch(function () { return load(); });
    } else {
      load();
    }
  });
})();