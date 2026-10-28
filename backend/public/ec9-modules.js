/* ============================================================
 * EC9 新增模块前端逻辑
 * ------------------------------------------------------------
 * 场次管理 / 票种管理 / 订单管理 / 支付流水
 *
 * 这些模块后端接口在上一轮已开发完（/api/sessions、/api/ticket-types、
 * /api/orders、/api/payments），但 EC8 沿用过来的后台前端里没有对应页面，
 * 所以接口调不到、界面上也看不到入口。本文件补齐这部分。
 * ============================================================ */

/**
 * 翻译兜底。
 *
 * ⚠️ 本文件所有文案都走 ec9T()，不要直接调全局 t()：
 *    app.js 里有个 `const pageTitles`、`.map(t => …)` 之类的写法会遮蔽全局 t，
 *    一旦 t 不可用，渲染函数就会抛错把**整张表格**打成空白，
 *    而不是「某几个词没翻译」。这里兜住，缺失时原样返回 key。
 */
function ec9T(key, fallback) {
  try {
    if (typeof window !== 'undefined' && typeof window.t === 'function') {
      var v = window.t(key);
      // t() 取不到会原样返回 key —— 那就退回兜底文案
      if (v && v !== key) return v;
    }
  } catch (e) { /* 翻译不可用不应影响业务 */ }
  return fallback != null ? fallback : key;
}

/* ---------- 通用小工具 ---------- */

/**
 * 取业务数据的多语字段（活动名 / 场次名 / 票种名 …）。
 *
 * 后台列表过去只显示简体 name，切到英文界面时表格里仍是中文 ——
 * 因为那是**数据**不是文案，i18n 的 DOM 扫描管不到。
 * 这里按当前界面语言从 i18n 树里取，取不到再回退简体基准字段。
 *
 * @param {object} row  含 i18n 的行数据
 * @param {string} field 'name' | 'description' | 'location'
 */
function ec9I18n(row, field) {
    field = field || 'name';
    if (!row) return '';
    var lang = 'zh-CN';
    try {
        if (typeof window !== 'undefined' && window.I18N && typeof window.I18N.getLang === 'function') {
            lang = window.I18N.getLang() || 'zh-CN';
        }
    } catch (e) {}
    var tree = row.i18n || {};
    if (typeof tree === 'string') { try { tree = JSON.parse(tree); } catch (e) { tree = {}; } }
    var f = tree[field] || {};
    // 界面语言 key（zh-Hant）与库里存的 key（zh-TW）不是一回事，先归一化再取，
    // 否则繁体界面一律取不到、静默回退简体。
    var ALIAS = { 'zh-Hant': 'zh-TW', 'zh-HK': 'zh-TW', 'zh-TW': 'zh-TW', 'zh-CN': 'zh-CN', 'en': 'en', 'zh': 'zh-CN' };
    var want = ALIAS[lang] || lang;
    // 顺序：目标语种 → 简体基准字段 → 英文。
    // 英文必须排最后：i18n 树里通常没有 zh-CN（buildI18nTree 会剔除与简体列重复的），
    // 若把 en 排在 row[field] 前面，取不到目标语种时会跳去显示英文而不是简体。
    var order = [want, lang, 'zh-CN'];
    for (var i = 0; i < order.length; i++) {
        var v = f[order[i]];
        if (v != null && String(v).trim() !== '') return v;
    }
    return row[field] || f.en || '';
}

/** HTML 转义：所有拼进 innerHTML 的动态文本都要过这里，防 XSS */
function ec9Esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** 金额格式化：优先用 i18n 的 fmtMoney，切英文时符号与分隔符自动跟着变 */
function ec9Money(v) {
    const n = Number(v || 0);
    if (typeof t === 'function' && window.I18N) return window.I18N.fmtMoney(n, 'CNY');
    return '¥' + n.toFixed(2);
}

/** 状态徽章 */
function ec9Badge(text, cls) {
    return `<span class="status-badge ${cls || 'status-inactive'}">${ec9Esc(text)}</span>`;
}

/**
 * 通用分页渲染。
 * loadFn 必须是全局函数名（拼进 onclick，故只能传字符串名）。
 */
function ec9RenderPagination(containerId, total, page, pageSize, loadFnName) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (total === 0) { el.innerHTML = ''; return; }

    const go = (p) => `${loadFnName}(${p}, ${pageSize})`;

    // ⚠️ 分页文案必须走词条拼接，不能靠 autoTranslate 反查：
    //   「共 / 第 / 页」都是**单字**文本节点（夹在 <strong> 数字两侧），
    //   而 autoTranslate 有 text.length < 2 的限制，单字一律不翻 → 英文环境漏中文。
    const totalTxt = ec9T('ec9.order.totalRecords', '共 {0} 条记录')
        .replace('{0}', '<strong style="color:#101828;">' + total + '</strong>');
    const pageTxt = ec9T('ec9.order.pageIndicator', '第 {0} / {1} 页')
        .replace('{0}', '<strong style="color:#101828;">' + page + '</strong>')
        .replace('{1}', '<strong style="color:#101828;">' + totalPages + '</strong>');

    let html = '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:16px;padding:20px 0;">';
    html += `<div style="display:flex;align-items:center;gap:16px;color:#6B7280;font-size:14px;">
        <span>${totalTxt}</span>
        <span>${pageTxt}</span>
    </div>`;
    html += '<div style="display:flex;align-items:center;gap:8px;">';

    const prevTxt = ec9T('admin.previous', '上一页');
    const nextTxt = ec9T('admin.next', '下一页');

    html += page > 1
        ? `<button class="btn btn-sm btn-outline" onclick="${go(page - 1)}" style="min-width:80px;">${prevTxt}</button>`
        : `<button class="btn btn-sm btn-outline" disabled style="min-width:80px;opacity:.5;">${prevTxt}</button>`;

    const start = Math.max(1, page - 2);
    const end = Math.min(totalPages, page + 2);
    if (start > 1) {
        html += `<button class="btn btn-sm btn-outline" onclick="${go(1)}" style="min-width:36px;">1</button>`;
        if (start > 2) html += '<span style="padding:0 4px;color:#9CA3AF;">...</span>';
    }
    for (let i = start; i <= end; i++) {
        html += i === page
            ? `<button class="btn btn-sm btn-primary" style="min-width:36px;">${i}</button>`
            : `<button class="btn btn-sm btn-outline" onclick="${go(i)}" style="min-width:36px;">${i}</button>`;
    }
    if (end < totalPages) {
        if (end < totalPages - 1) html += '<span style="padding:0 4px;color:#9CA3AF;">...</span>';
        html += `<button class="btn btn-sm btn-outline" onclick="${go(totalPages)}" style="min-width:36px;">${totalPages}</button>`;
    }

    html += page < totalPages
        ? `<button class="btn btn-sm btn-outline" onclick="${go(page + 1)}" style="min-width:80px;">${nextTxt}</button>`
        : `<button class="btn btn-sm btn-outline" disabled style="min-width:80px;opacity:.5;">${nextTxt}</button>`;

    html += '</div></div>';
    el.innerHTML = html;
}

/** datetime-local 需要 'YYYY-MM-DDTHH:mm'，而库里给的是 ISO 串 */
function ec9ToLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** datetime-local 的值转 ISO 交给后端 */
function ec9FromLocalInput(v) {
    if (!v) return null;
    const d = new Date(v);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
}

/* ============================================================
 * 一、场次管理
 * ============================================================ */

const EC9_SESSION_STATUS = {
    1: [() => ec9T('ec9.session.enabled', '启用'), 'status-active'],
    0: [() => ec9T('ec9.session.disabled', '停用'), 'status-inactive']
};

async function loadSessions(eventId) {
    const tbody = document.getElementById('sessionTableBody');
    if (!tbody) return;
    // 未指定会议时，取第一个会议（EC9 一场会议对应一批场次）
    let eid = eventId;
    if (!eid) {
        try {
            const ev = await apiRequest('/events');
            const list = (ev && ev.data && (ev.data.list || ev.data)) || [];
            eid = list[0] && list[0].id;
        } catch (e) { /* 取不到就查全部 */ }
    }
    try {
        const qs = eid ? `?event_id=${eid}&pageSize=200` : '?pageSize=200';
        const res = await apiRequest('/sessions' + qs);
        if (res.code !== 0) throw new Error(res.message || '加载失败');
        ec9RenderSessions(res.data.list || []);
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="12" style="text-align:center;padding:32px;color:#EF4444;">加载失败：${ec9Esc(e.message)}</td></tr>`;
    }
}

function ec9RenderSessions(list) {
    const tbody = document.getElementById('sessionTableBody');
    if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;padding:32px;color:#9CA3AF;">暂无场次</td></tr>';
        return;
    }
    tbody.innerHTML = list.map((s) => {
        const total = Number(s.capacity || 0);
        const used = Number(s.stock_sold || 0) + Number(s.stock_locked || 0);
        // capacity = 0 表示不限，此时剩余显示「不限」
        const remain = total > 0 ? Math.max(0, total - used) : null;
        const st = EC9_SESSION_STATUS[Number(s.status)] || [null, 'status-inactive'];
        return `<tr>
            <td>${ec9Esc(s.id)}</td>
            <td>${ec9Esc(ec9I18n(s, 'name'))}</td>
            <td>${ec9Esc(formatDateTime(s.start_time))}</td>
            <td>${ec9Esc(formatDateTime(s.end_time))}</td>
            <td>${ec9Esc(ec9I18n(s, 'location') || '-')}</td>
            <td>${total > 0 ? total : ec9T('ec9.field.unlimited', '不限')}</td>
            <td>${ec9Esc(s.stock_sold || 0)}</td>
            <td>${ec9Esc(s.stock_locked || 0)}</td>
            <td>${remain === null ? ec9T('ec9.field.unlimited', '不限') : remain}</td>
            <td>${ec9Badge(ec9StatusText(st, '—'), st[1])}</td>
            <td>${ec9Esc(s.sort || 0)}</td>
            <td>
                <button class="btn btn-sm btn-outline" onclick="openSessionModal(${s.id})">编辑</button>
                <button class="btn btn-sm btn-outline" onclick="toggleSessionStatus(${s.id}, ${Number(s.status)})">
                    ${Number(s.status) === 1 ? '停用' : '启用'}
                </button>
                <button class="btn btn-sm btn-outline" onclick="deleteSession(${s.id}, '${ec9Esc(s.name)}')">删除</button>
            </td>
        </tr>`;
    }).join('');
}

function openSessionModal(id) {
    const modal = document.getElementById('sessionModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    document.getElementById('sessionForm').reset();
    document.getElementById('sessionModalTitle').textContent = id ? '编辑场次' : '新增场次';

    if (!id) {
        document.getElementById('sessionStatus').value = '1';
        return;
    }
    // 详情异步取，避免列表里字段不全
    apiRequest('/sessions/' + id).then((res) => {
        if (res.code !== 0) return;
        const s = res.data.session || res.data;
        document.getElementById('sessionName').value = s.name || '';
        document.getElementById('sessionStartTime').value = ec9ToLocalInput(s.start_time);
        document.getElementById('sessionEndTime').value = ec9ToLocalInput(s.end_time);
        document.getElementById('sessionLocation').value = s.location || '';
        document.getElementById('sessionCapacity').value = s.capacity || 0;
        document.getElementById('sessionSortOrder').value = s.sort || 0;
        document.getElementById('sessionStatus').value = String(Number(s.status));
        // 多语字段从 i18n 树里回填
        var si = s.i18n || {};
        document.getElementById('sessionNameTw').value = (si.name && si.name['zh-TW']) || '';
        document.getElementById('sessionNameEn').value = (si.name && si.name.en) || '';
        document.getElementById('sessionLocationTw').value = (si.location && si.location['zh-TW']) || '';
        document.getElementById('sessionLocationEn').value = (si.location && si.location.en) || '';
    }).catch((e) => alert('加载场次失败：' + e.message));
}

function closeSessionModal() {
    const m = document.getElementById('sessionModal');
    if (m) m.classList.add('hidden');
}

async function handleSessionSubmit(e) {
    e.preventDefault();
    const name = document.getElementById('sessionName').value.trim();
    const start = ec9FromLocalInput(document.getElementById('sessionStartTime').value);
    if (!name || !start) { alert('请填写场次名称和开始时间'); return; }

    // 多语：只有填了才带上。注意后端 buildI18nTree 是**整树重建**不是增量合并，
    // 所以这里必须覆盖 name/location 全部字段——否则未提交的字段其繁英会被清空。
    // 依赖 openSessionModal 的回填保证已有值不被冲掉。
    const sI18n = { name: {}, location: {} };
    const val = (id) => (document.getElementById(id) || {}).value || '';
    if (val('sessionNameTw').trim()) sI18n.name['zh-TW'] = val('sessionNameTw').trim();
    if (val('sessionNameEn').trim()) sI18n.name.en = val('sessionNameEn').trim();
    if (val('sessionLocationTw').trim()) sI18n.location['zh-TW'] = val('sessionLocationTw').trim();
    if (val('sessionLocationEn').trim()) sI18n.location.en = val('sessionLocationEn').trim();

    const payload = {
        name,
        start_time: start,
        end_time: ec9FromLocalInput(document.getElementById('sessionEndTime').value),
        location: document.getElementById('sessionLocation').value.trim(),
        capacity: Number(document.getElementById('sessionCapacity').value) || 0,
        sort: Number(document.getElementById('sessionSortOrder').value) || 0,
        status: Number(document.getElementById('sessionStatus').value),
        i18n: sI18n
    };

    // 表单里没有会议选择器，编辑时带上原会议，新建时取第一个
    const editingId = document.getElementById('sessionModal').dataset.editId;
    if (editingId) payload.event_id = Number(document.getElementById('sessionModal').dataset.eventId) || undefined;
    else {
        const ev = await apiRequest('/events');
        const list = (ev && ev.data && (ev.data.list || ev.data)) || [];
        if (!list[0]) { alert('请先创建会议'); return; }
        payload.event_id = list[0].id;
    }

    try {
        const res = editingId
            ? await apiRequest('/sessions/' + editingId, { method: 'PUT', body: JSON.stringify(payload) })
            : await apiRequest('/sessions', { method: 'POST', body: JSON.stringify(payload) });
        if (res.code !== 0) throw new Error(res.message);
        closeSessionModal();
        loadSessions(payload.event_id);
        alert(res.message || '保存成功');
    } catch (err) {
        alert('保存失败：' + err.message);
    }
}

async function toggleSessionStatus(id, cur) {
    const next = cur === 1 ? 0 : 1;
    try {
        const res = await apiRequest(`/sessions/${id}/status`, {
            method: 'POST', body: JSON.stringify({ status: next })
        });
        if (res.code !== 0) throw new Error(res.message);
        loadSessions();
    } catch (e) { alert('操作失败：' + e.message); }
}

async function deleteSession(id, name) {
    if (!confirm(`确定删除场次「${name}」？\n已产生售出记录的场次无法删除。`)) return;
    try {
        const res = await apiRequest('/sessions/' + id, { method: 'DELETE' });
        if (res.code !== 0) throw new Error(res.message);
        loadSessions();
        alert(res.message || '已删除');
    } catch (e) { alert('删除失败：' + e.message); }
}

/* ============================================================
 * 二、票种管理
 * ============================================================ */

async function loadTicketTypes(eventId) {
    const tbody = document.getElementById('ticketTypeTableBody');
    if (!tbody) return;
    let eid = eventId;
    if (!eid) {
        try {
            const ev = await apiRequest('/events');
            const list = (ev && ev.data && (ev.data.list || ev.data)) || [];
            eid = list[0] && list[0].id;
        } catch (e) { /* 忽略 */ }
    }
    try {
        const qs = eid ? `?event_id=${eid}&pageSize=200` : '?pageSize=200';
        const res = await apiRequest('/ticket-types' + qs);
        if (res.code !== 0) throw new Error(res.message || '加载失败');
        ec9RenderTicketTypes(res.data.list || []);
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="12" style="text-align:center;padding:32px;color:#EF4444;">加载失败：${ec9Esc(e.message)}</td></tr>`;
    }
}

function ec9RenderTicketTypes(list) {
    const tbody = document.getElementById('ticketTypeTableBody');
    if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;padding:32px;color:#9CA3AF;">暂无票种</td></tr>';
        return;
    }
    tbody.innerHTML = list.map((t) => {
        const total = Number(t.stock_total || 0);
        // 后端已算好 stock_available，这里直接用，避免前端重复扣减口径不一致
        const remain = t.stock_available != null ? Number(t.stock_available)
            : (total > 0 ? Math.max(0, total - Number(t.stock_sold || 0) - Number(t.stock_locked || 0)) : null);
        // on_shelf = 上下架（是否对外售卖），status = 启用/停用，两个独立字段
        const on = Number(t.on_shelf) === 1;
        return `<tr>
            <td>${ec9Esc(t.id)}</td>
            <td>${ec9Esc(ec9I18n(t, 'name'))}${t.session_name ? `<div style="font-size:12px;color:#9CA3AF;">${ec9Esc(t.session_name)}</div>` : ''}</td>
            <td>${ec9Money(t.price)}</td>
            <td>${total > 0 ? total : ec9T('ec9.field.unlimited', '不限')}</td>
            <td>${ec9Esc(t.stock_locked || 0)}</td>
            <td>${ec9Esc(t.stock_sold || 0)}</td>
            <td>${remain === null ? ec9T('ec9.field.unlimited', '不限') : remain}</td>
            <td>${ec9Esc(formatDateTime(t.sale_end))}</td>
            <td>${ec9Badge(on ? ec9T('ec9.tt.onShelf', '上架') : ec9T('ec9.tt.offShelf', '下架'), on ? 'status-active' : 'status-inactive')}</td>
            <td>${Number(t.is_standard) === 1
                ? ec9Badge('9折/8折', 'status-active')
                : `<span style="color:#9CA3AF;">${ec9T('ec9.field.none', '不参与')}</span>`}</td>
            <td>${ec9Esc(t.sort || 0)}</td>
            <td>
                <button class="btn btn-sm btn-outline" onclick="openTicketTypeModal(${t.id})">编辑</button>
                <button class="btn btn-sm btn-outline" onclick="toggleTicketTypeShelf(${t.id}, ${Number(t.on_shelf)})">
                    ${on ? ec9T('ec9.tt.offShelf', '下架') : ec9T('ec9.tt.onShelf', '上架')}
                </button>
                <button class="btn btn-sm btn-outline" onclick="adjustTicketStock(${t.id}, '${ec9Esc(t.name)}', ${total})">调整库存</button>
                <button class="btn btn-sm btn-outline" onclick="deleteTicketType(${t.id}, '${ec9Esc(t.name)}')">删除</button>
            </td>
        </tr>`;
    }).join('');
}

function openTicketTypeModal(id) {
    const modal = document.getElementById('ticketTypeModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    document.getElementById('ticketTypeForm').reset();
    document.getElementById('ticketTypeModalTitle').textContent = id ? '编辑票种' : '新增票种';
    document.getElementById('ttStatus').value = '1';
    document.getElementById('ttIsStandard').checked = false;

    if (!id) { delete modal.dataset.editId; return; }
    modal.dataset.editId = id;
    apiRequest('/ticket-types/' + id).then((res) => {
        if (res.code !== 0) return;
        const t = res.data.ticket_type || res.data.ticketType || res.data;
        document.getElementById('ttName').value = t.name || '';
        document.getElementById('ttPrice').value = t.price || 0;
        document.getElementById('ttStockTotal').value = t.stock_total || 0;
        document.getElementById('ttSaleStart').value = ec9ToLocalInput(t.sale_start);
        document.getElementById('ttSaleEnd').value = ec9ToLocalInput(t.sale_end);
        document.getElementById('ttSortOrder').value = t.sort || 0;
        document.getElementById('ttStatus').value = String(Number(t.on_shelf));
        document.getElementById('ttDescription').value = t.description || '';
        // 折扣口径由属性决定（后端 judge 也以此为准），名称只是老数据兜底
        document.getElementById('ttIsStandard').checked = Number(t.is_standard) === 1;
        // 多语字段从 i18n 树里取
        const i18n = t.i18n || {};
        document.getElementById('ttNameTw').value = (i18n.name && i18n.name['zh-TW']) || '';
        document.getElementById('ttNameEn').value = (i18n.name && i18n.name.en) || '';
        document.getElementById('ttDescTw').value = (i18n.description && i18n.description['zh-TW']) || '';
        document.getElementById('ttDescEn').value = (i18n.description && i18n.description.en) || '';
    }).catch((e) => alert('加载票种失败：' + e.message));
}

function closeTicketTypeModal() {
    const m = document.getElementById('ticketTypeModal');
    if (m) { m.classList.add('hidden'); delete m.dataset.editId; }
}

async function handleTicketTypeSubmit(e) {
    e.preventDefault();
    const name = document.getElementById('ttName').value.trim();
    if (!name) { alert('请填写票种名称'); return; }

    // 多语：只有填了才带上，后端会与基准字段合并
    const i18n = { name: {}, description: {} };
    const tw = document.getElementById('ttNameTw').value.trim();
    const en = document.getElementById('ttNameEn').value.trim();
    const dtw = document.getElementById('ttDescTw').value.trim();
    const den = document.getElementById('ttDescEn').value.trim();
    if (tw) i18n.name['zh-TW'] = tw;
    if (en) i18n.name.en = en;
    if (dtw) i18n.description['zh-TW'] = dtw;
    if (den) i18n.description.en = den;

    const payload = {
        name,
        price: Number(document.getElementById('ttPrice').value) || 0,
        stock_total: Number(document.getElementById('ttStockTotal').value) || 0,
        sale_start: ec9FromLocalInput(document.getElementById('ttSaleStart').value),
        sale_end: ec9FromLocalInput(document.getElementById('ttSaleEnd').value),
        sort: Number(document.getElementById('ttSortOrder').value) || 0,
        on_shelf: Number(document.getElementById('ttStatus').value),
        is_standard: document.getElementById('ttIsStandard').checked ? 1 : 0,
        description: document.getElementById('ttDescription').value.trim(),
        i18n
    };

    const modal = document.getElementById('ticketTypeModal');
    const editingId = modal.dataset.editId;
    if (editingId) {
        const ev = await apiRequest('/events');
        const list = (ev && ev.data && (ev.data.list || ev.data)) || [];
        payload.event_id = list[0] && list[0].id;
    } else {
        const ev = await apiRequest('/events');
        const list = (ev && ev.data && (ev.data.list || ev.data)) || [];
        if (!list[0]) { alert('请先创建会议'); return; }
        payload.event_id = list[0].id;
    }

    try {
        const res = editingId
            ? await apiRequest('/ticket-types/' + editingId, { method: 'PUT', body: JSON.stringify(payload) })
            : await apiRequest('/ticket-types', { method: 'POST', body: JSON.stringify(payload) });
        if (res.code !== 0) throw new Error(res.message);
        closeTicketTypeModal();
        loadTicketTypes(payload.event_id);
        alert(res.message || '保存成功');
    } catch (err) { alert('保存失败：' + err.message); }
}

async function toggleTicketTypeShelf(id, cur) {
    const next = cur === 1 ? 0 : 1;
    try {
        const res = await apiRequest(`/ticket-types/${id}/shelf`, {
            method: 'POST', body: JSON.stringify({ on_shelf: next })
        });
        if (res.code !== 0) throw new Error(res.message);
        loadTicketTypes();
    } catch (e) { alert('操作失败：' + e.message); }
}

/** 调整库存用 delta（增量），不是直接设总量 —— 与后端 /stock 接口语义一致 */
function adjustTicketStock(id, name, curTotal) {
    const v = prompt(
        `调整票种「${name}」的库存\n当前总量：${curTotal || 0}\n` +
        '请输入增量（正数增加，负数减少，0 表示不限）：',
        '0'
    );
    if (v === null) return;
    const delta = Number(v);
    if (Number.isNaN(delta) || delta === 0) { alert('请输入非零数字'); return; }
    apiRequest(`/ticket-types/${id}/stock`, {
        method: 'POST', body: JSON.stringify({ delta: delta })
    }).then((res) => {
        if (res.code !== 0) throw new Error(res.message);
        loadTicketTypes();
        alert(res.message || '已调整');
    }).catch((e) => alert('调整失败：' + e.message));
}

async function deleteTicketType(id, name) {
    if (!confirm(`确定删除票种「${name}」？\n已有售出记录的票种无法删除。`)) return;
    try {
        const res = await apiRequest('/ticket-types/' + id, { method: 'DELETE' });
        if (res.code !== 0) throw new Error(res.message);
        loadTicketTypes();
        alert(res.message || '已删除');
    } catch (e) { alert('删除失败：' + e.message); }
}

/* ============================================================
 * 三、订单管理
 * ============================================================ */

/**
 * 订单状态 → [显示文案, 徽章样式]
 *
 * ⚠️ 这里存的是**函数**而不是已翻译的字符串：
 *    若写成 const M = { paid: [ec9T('ec9.order.paid', '已支付'), ...] }，t() 只在脚本加载时
 *    执行一次，之后切换语言映射表不会更新，表格就永远停在第一种语言。
 *    惰性求值（每次渲染时调用）才能跟随语言切换。
 */
const EC9_ORDER_STATUS = {
    pending_payment: [() => ec9T('ec9.order.pendingPay', '待付款'), 'status-pending'],
    paid: [() => ec9T('ec9.order.paid', '已支付'), 'status-active'],
    closed: [() => ec9T('ec9.order.closed', '已关闭'), 'status-inactive'],
    refunded: [() => ec9T('ec9.order.refunded', '已退款'), 'status-warning'],
    created: [() => ec9T('ec9.order.pending', '待支付'), 'status-pending']
};

/** 取状态显示文案（兼容函数与字符串两种写法） */
function ec9StatusText(st, fallback) {
    if (!st) return fallback || '';
    return typeof st[0] === 'function' ? st[0]() : st[0];
}

let ec9OrderPage = 1;
let ec9OrderPageSize = 20;

async function loadOrders(page, pageSize) {
    const tbody = document.getElementById('orderTableBody');
    if (!tbody) return;
    ec9OrderPage = page || 1;
    ec9OrderPageSize = pageSize || ec9OrderPageSize;

    const status = (document.getElementById('orderFilterStatus') || {}).value || '';
    const keyword = (document.getElementById('orderFilterKeyword') || {}).value || '';
    const start = (document.getElementById('orderFilterStart') || {}).value || '';
    const end = (document.getElementById('orderFilterEnd') || {}).value || '';

    const qs = new URLSearchParams({ page: ec9OrderPage, pageSize: ec9OrderPageSize });
    if (status) qs.set('status', status);
    if (keyword) qs.set('keyword', keyword);
    if (start) qs.set('start', start);
    if (end) qs.set('end', end);

    try {
        const res = await apiRequest('/orders?' + qs.toString());
        if (res.code !== 0) throw new Error(res.message || '加载失败');
        const d = res.data || {};
        ec9RenderOrders(d.list || []);
        ec9RenderPagination('orderPagination', d.total || 0, ec9OrderPage, ec9OrderPageSize, 'loadOrders');
        ec9FillOrderStats(res.summary || d.summary || {});
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:32px;color:#EF4444;">加载失败：${ec9Esc(e.message)}</td></tr>`;
    }
}

function ec9FillOrderStats(sum) {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('orderStatTotal', sum.total != null ? sum.total : 0);
    set('orderStatPaid', sum.paid_count != null ? sum.paid_count : 0);
    set('orderStatPending', sum.pending_count != null ? sum.pending_count : 0);
    set('orderStatAmount', ec9Money(sum.sum_amount || 0));
}

function ec9RenderOrders(list) {
    const tbody = document.getElementById('orderTableBody');
    if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:32px;color:#9CA3AF;">暂无订单</td></tr>';
        return;
    }
    tbody.innerHTML = list.map((o) => {
        const st = EC9_ORDER_STATUS[o.status] || [null, 'status-inactive'];
        const g = o.guest_info || {};
        return `<tr>
            <td style="font-family:monospace;font-size:12px;">${ec9Esc(o.order_no || '-')}</td>
            <td>${ec9Esc(g.name || '-')}${g.phone_masked ? `<div style="font-size:12px;color:#9CA3AF;">${ec9Esc(g.phone_masked)}</div>` : ''}</td>
            <td>${ec9Esc(o.ticket_type_name || '-')}</td>
            <td>${ec9Esc(o.session_name || ec9T('ec9.field.allSessions', '全部场次'))}</td>
            <td>${ec9Esc(o.quantity || 0)}</td>
            <td>${ec9Money(o.final_amount)}</td>
            <td>${ec9Badge(ec9StatusText(st, '—'), st[1])}</td>
            <td style="font-size:12px;color:#6B7280;">${ec9Esc(formatDateTime(o.created_at))}</td>
            <td>
                <button class="btn btn-sm btn-outline" onclick="openOrderModal(${o.id})">详情</button>
                ${o.status === 'pending_payment'
                    ? `<button class="btn btn-sm btn-outline" onclick="closeOrder(${o.id})">关闭</button>` : ''}
            </td>
        </tr>`;
    }).join('');
}

function resetOrderFilter() {
    ['orderFilterStatus', 'orderFilterKeyword', 'orderFilterStart', 'orderFilterEnd']
        .forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
    loadOrders(1, ec9OrderPageSize);
}

async function openOrderModal(id) {
    ec9CurrentOrderId = id;
    const modal = document.getElementById('orderModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    document.getElementById('orderRemark').value = '';
    document.getElementById('orderDetailBody').innerHTML =
        '<div style="text-align:center;padding:24px;color:#9CA3AF;">加载中...</div>';

    try {
        const res = await apiRequest('/orders/' + id);
        if (res.code !== 0) throw new Error(res.message);
        const o = res.data || {};
        const st = EC9_ORDER_STATUS[o.status] || [null, 'status-inactive'];
        const g = o.guest || {};
        const pay = o.payment || {};

        const row = (label, val) =>
            `<tr><td style="padding:8px 12px;color:#6B7280;width:140px;border-bottom:1px solid #F3F4F6;">${ec9Esc(label)}</td>
             <td style="padding:8px 12px;border-bottom:1px solid #F3F4F6;">${val}</td></tr>`;

        let html = '<table style="width:100%;border-collapse:collapse;">';
        html += row(ec9T('ec9.order.no', '订单号'), `<code>${ec9Esc(o.order_no || '-')}</code>`);
        html += row(ec9T('ec9.field.status', '状态'), ec9Badge(ec9StatusText(st, '—'), st[1]));
        html += row(ec9T('ec9.order.guest', '参会人'), `${ec9Esc(g.name || '-')}${g.company ? '（' + ec9Esc(g.company) + '）' : ''}`);
        html += row(ec9T('ec9.order.guest', '参会人'), ec9Esc(g.phone_masked || '-'));
        html += row(ec9T('ec9.order.tt', '票种'), ec9Esc(o.ticket_type_name || '-'));
        html += row(ec9T('ec9.order.session', '场次'), ec9Esc(o.session_name || ec9T('ec9.field.allSessions', '全部场次')));
        html += row(ec9T('ec9.order.qtyAmount', '数量 / 金额'), `${ec9Esc(o.quantity || 0)} 张 / ${ec9Money(o.final_amount)}`);
        html += row(ec9T('ec9.order.createdAt', '下单时间'), ec9Esc(formatDateTime(o.created_at)));
        if (o.paid_at) html += row(ec9T('ec9.order.paidAt', '支付时间'), ec9Esc(formatDateTime(o.paid_at)));
        if (pay.transaction_id) html += row(ec9T('ec9.order.wxTrans', '微信交易号'), `<code>${ec9Esc(pay.transaction_id)}</code>`);
        if (o.checkin_code && o.checkin_code.code) html += row(ec9T('ec9.order.checkinCode', '签到码'), `<code>${ec9Esc(o.checkin_code.code)}</code>`);
        if (o.close_reason) html += row(ec9T('ec9.order.closeReason', '关闭原因'), ec9Esc(o.close_reason));
        html += '</table>';

        document.getElementById('orderDetailBody').innerHTML = html;
        document.getElementById('orderRemark').value = o.remark || '';
    } catch (e) {
        document.getElementById('orderDetailBody').innerHTML =
            `<div style="text-align:center;padding:24px;color:#EF4444;">加载失败：${ec9Esc(e.message)}</div>`;
    }
}

function closeOrderModal() {
    const m = document.getElementById('orderModal');
    if (m) m.classList.add('hidden');
}

let ec9CurrentOrderId = null;

async function saveOrderRemark() {
    if (!ec9CurrentOrderId) return;
    const remark = document.getElementById('orderRemark').value;
    try {
        const res = await apiRequest(`/orders/${ec9CurrentOrderId}/remark`, {
            method: 'PUT', body: JSON.stringify({ remark: remark })
        });
        if (res.code !== 0) throw new Error(res.message);
        alert(res.message || '已保存');
    } catch (e) { alert('保存失败：' + e.message); }
}

async function closeOrder(id) {
    if (!confirm('确定关闭该订单？\n关闭后会释放占用的库存，用户不能再支付。')) return;
    try {
        const res = await apiRequest(`/orders/${id}/close`, { method: 'POST' });
        if (res.code !== 0) throw new Error(res.message);
        loadOrders(ec9OrderPage, ec9OrderPageSize);
        alert(res.message || ec9T('ec9.order.closed', '已关闭'));
    } catch (e) { alert('关闭失败：' + e.message); }
}

async function refreshOrderFromWechat() {
    if (!ec9CurrentOrderId) return;
    try {
        const res = await apiRequest(`/orders/${ec9CurrentOrderId}/refresh`, { method: 'POST' });
        if (res.code !== 0) throw new Error(res.message);
        alert(res.message || '已同步');
        openOrderModal(ec9CurrentOrderId);
        loadOrders(ec9OrderPage, ec9OrderPageSize);
    } catch (e) { alert('查单失败：' + e.message); }
}

async function exportOrdersCsv() {
    const status = (document.getElementById('orderFilterStatus') || {}).value || '';
    const keyword = (document.getElementById('orderFilterKeyword') || {}).value || '';
    const start = (document.getElementById('orderFilterStart') || {}).value || '';
    const end = (document.getElementById('orderFilterEnd') || {}).value || '';
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    if (keyword) qs.set('keyword', keyword);
    if (start) qs.set('start', start);
    if (end) qs.set('end', end);

    try {
        // 用 fetch 拿 blob，交给浏览器下载（apiRequest 只吃 JSON）
        const resp = await fetch(`${API_BASE}/orders/export?${qs.toString()}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `orders_${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    } catch (e) { alert('导出失败：' + e.message); }
}

/* ============================================================
 * 四、支付流水
 * ============================================================ */

const EC9_PAY_STATUS = {
    success: [() => ec9T('ec9.pay.success', '成功'), 'status-active'],
    failed: [() => ec9T('ec9.pay.failed', '失败'), 'status-danger'],
    pending: [() => ec9T('ec9.pay.processing', '处理中'), 'status-pending'],
    refunded: [() => ec9T('ec9.order.refunded', '已退款'), 'status-warning']
};

let ec9PayPage = 1;
let ec9PayPageSize = 20;
let ec9ReconcileMap = {};      // payment_id -> {level, message}
let ec9ReconcileDone = false;   // 是否已跑过一次对账

async function loadPayments(page, pageSize) {
    const tbody = document.getElementById('paymentTableBody');
    if (!tbody) return;
    ec9PayPage = page || 1;
    ec9PayPageSize = pageSize || ec9PayPageSize;

    const status = (document.getElementById('payFilterStatus') || {}).value || '';
    const keyword = (document.getElementById('payFilterKeyword') || {}).value || '';
    const start = (document.getElementById('payFilterStart') || {}).value || '';
    const end = (document.getElementById('payFilterEnd') || {}).value || '';

    const qs = new URLSearchParams({ page: ec9PayPage, pageSize: ec9PayPageSize });
    if (status) qs.set('status', status);
    if (keyword) qs.set('keyword', keyword);
    if (start) qs.set('start', start);
    if (end) qs.set('end', end);

    try {
        const res = await apiRequest('/payments?' + qs.toString());
        if (res.code !== 0) throw new Error(res.message || '加载失败');
        const d = res.data || {};
        ec9RenderPayments(d.list || []);
        ec9RenderPagination('paymentPagination', d.total || 0, ec9PayPage, ec9PayPageSize, 'loadPayments');
        ec9FillPayStats(res.summary || d.summary || {});
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:32px;color:#EF4444;">加载失败：${ec9Esc(e.message)}</td></tr>`;
    }
}

function ec9FillPayStats(sum) {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('payStatTotal', sum.total != null ? sum.total : 0);
    set('payStatSuccess', sum.success_count != null ? sum.success_count : 0);
    // 后端给 success_amount（成功额）与 net_amount（成功额 - 退款额）
    set('payStatAmount', ec9Money(sum.success_amount || 0));
    const diff = ec9ReconcileDone ? Object.keys(ec9ReconcileMap).length : 0;
    set('payStatDiff', diff);
    const diffEl = document.getElementById('payStatDiff');
    if (diffEl) diffEl.style.color = diff > 0 ? '#EF4444' : '#101828';
}

function ec9RenderPayments(list) {
    const tbody = document.getElementById('paymentTableBody');
    if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:32px;color:#9CA3AF;">暂无支付记录</td></tr>';
        return;
    }
    // 对账结果由后端在「对账」时现算、不落库，这里存内存里按 payment_id 映射
    const recMap = ec9ReconcileMap || (ec9ReconcileMap = {});

    tbody.innerHTML = list.map((p) => {
        const st = EC9_PAY_STATUS[p.status] || [null, 'status-inactive'];
        const issue = recMap[p.id];
        let recHtml = '<span style="color:#9CA3AF;">-</span>';
        if (issue) {
            recHtml = issue.level === 'error'
                ? ec9Badge(issue.message || '异常', 'status-danger')
                : ec9Badge(issue.message || '注意', 'status-warning');
        } else if (ec9ReconcileDone && p.status === 'success') {
            recHtml = ec9Badge(ec9T('ec9.pay.consistent', '一致'), 'status-active');
        }
        return `<tr>
            <td style="font-family:monospace;font-size:12px;">${ec9Esc(p.out_trade_no || '-')}</td>
            <td>${ec9Esc(p.guest_name || '-')}</td>
            <td>${ec9Money(p.amount)}</td>
            <td>${ec9Esc(p.channel || 'wechat')}</td>
            <td>${ec9Badge(ec9StatusText(st, '—'), st[1])}</td>
            <td style="font-family:monospace;font-size:12px;">${ec9Esc(p.transaction_id || '-')}</td>
            <td style="font-size:12px;color:#6B7280;">${ec9Esc(formatDateTime(p.paid_at || p.created_at))}</td>
            <td>${recHtml}</td>
            <td><button class="btn btn-sm btn-outline" onclick="openPaymentModal(${p.id})">详情</button></td>
        </tr>`;
    }).join('');
}

function resetPayFilter() {
    ['payFilterStatus', 'payFilterKeyword', 'payFilterStart', 'payFilterEnd']
        .forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
    loadPayments(1, ec9PayPageSize);
}

async function openPaymentModal(id) {
    const modal = document.getElementById('paymentModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    document.getElementById('paymentDetailBody').innerHTML =
        '<div style="text-align:center;padding:24px;color:#9CA3AF;">加载中...</div>';

    try {
        const res = await apiRequest('/payments/' + id);
        if (res.code !== 0) throw new Error(res.message);
        const p = res.data || {};
        const st = EC9_PAY_STATUS[p.status] || [null, 'status-inactive'];
        const row = (label, val) =>
            `<tr><td style="padding:8px 12px;color:#6B7280;width:140px;border-bottom:1px solid #F3F4F6;">${ec9Esc(label)}</td>
             <td style="padding:8px 12px;border-bottom:1px solid #F3F4F6;">${val}</td></tr>`;

        let html = '<table style="width:100%;border-collapse:collapse;">';
        html += row(ec9T('ec9.pay.outTradeNo', '商户订单号'), `<code>${ec9Esc(p.out_trade_no || '-')}</code>`);
        html += row(ec9T('ec9.field.status', '状态'), ec9Badge(ec9StatusText(st, '—'), st[1]));
        html += row('金额', ec9Money(p.amount));
        html += row(ec9T('ec9.pay.channel', '渠道'), ec9Esc(p.channel || 'wechat'));
        if (p.transaction_id) html += row(ec9T('ec9.order.wxTrans', '微信交易号'), `<code>${ec9Esc(p.transaction_id)}</code>`);
        if (p.guest_name) html += row(ec9T('ec9.order.guest', '参会人'), `${ec9Esc(p.guest_name)}${p.guest_phone_masked ? '（' + ec9Esc(p.guest_phone_masked) + '）' : ''}`);
        html += row(ec9T('ec9.pay.createdAt', '创建时间'), ec9Esc(formatDateTime(p.created_at)));
        if (p.paid_at) html += row(ec9T('ec9.order.paidAt', '支付时间'), ec9Esc(formatDateTime(p.paid_at)));
        if (p.refunded_at) html += row(ec9T('ec9.pay.refundedAt', '退款时间'), ec9Esc(formatDateTime(p.refunded_at)));
        html += row(ec9T('ec9.pay.relatedOrder', '关联订单'), `<a href="#" onclick="closePaymentModal(); openOrderModal(${p.order_id}); return false;">#${ec9Esc(p.order_id)}</a>`);
        if (p.failure_reason) html += row(ec9T('ec9.pay.failReason', '失败原因'), ec9Esc(p.failure_reason));
        html += '</table>';

        // 微信原始回调报文：排查问题时最有用（模型字段是 notify_raw，JSON）
        const raw = p.notify_raw;
        if (raw) {
            const rawText = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
            html += `<div style="margin-top:16px;"><div style="font-weight:600;margin-bottom:8px;">微信原始回调</div>
                <pre style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:6px;padding:12px;font-size:12px;overflow:auto;max-height:240px;">${ec9Esc(rawText)}</pre></div>`;
        }
        document.getElementById('paymentDetailBody').innerHTML = html;
    } catch (e) {
        document.getElementById('paymentDetailBody').innerHTML =
            `<div style="text-align:center;padding:24px;color:#EF4444;">加载失败：${ec9Esc(e.message)}</div>`;
    }
}

function closePaymentModal() {
    const m = document.getElementById('paymentModal');
    if (m) m.classList.add('hidden');
}

async function runReconcile() {
    if (!confirm('开始对账？\n将逐笔核对本地支付流水与订单状态，标出金额/状态不一致的记录。')) return;
    try {
        // 对账是 GET：后端现算一遍并返回差异清单，不落库
        const res = await apiRequest('/payments/reconcile');
        if (res.code !== 0) throw new Error(res.message);
        const d = res.data || {};
        const issues = d.issues || [];

        ec9ReconcileMap = {};
        issues.forEach((it) => {
            if (it.payment_id) ec9ReconcileMap[it.payment_id] = it;
        });
        ec9ReconcileDone = true;

        const checked = d.checked != null ? d.checked : 0;
        const errCnt = d.error_count != null ? d.error_count : 0;
        alert(errCnt > 0
            ? `对账完成：核对 ${checked} 笔，发现 ${d.issue_count} 笔问题（其中 ${errCnt} 笔需处理）。\n列表「对账」列已标注。`
            : `对账完成：核对 ${checked} 笔，未发现异常。`);
        loadPayments(ec9PayPage, ec9PayPageSize);
    } catch (e) { alert('对账失败：' + e.message); }
}
/* ============================================================
 * 支付配置（微信支付资质）
 * ------------------------------------------------------------
 * 过去支付参数只能写在服务器 .env 里，改一次要重启、客户自己也改不了。
 * 现在落库 + 后台可改：GET/PUT /api/pay-config，密钥对外只回掩码。
 * ============================================================ */

/** 运行模式选项：value / 词条 key / 兜底中文（option 由 JS 填充，避免 HTML 写死中文） */
const PC_MODES = [
    ['mock', 'ec9.payCfg.modeMock', 'mock · 模拟（无资质开发）'],
    ['sandbox', 'ec9.payCfg.modeSandbox', 'sandbox · 微信沙箱'],
    ['real', 'ec9.payCfg.modeReal', 'real · 生产']
];

/** 状态卡文案 */
function pcSetText(id, v) {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
}

/** 加载并填充表单 */
async function loadPayConfig() {
    try {
        const res = await apiRequest('/pay-config');
        if (res.code !== 0) throw new Error(res.message || ec9T('admin.loadFailed', '加载失败'));
        fillPayConfigForm(res.data.config || {});
        const r = document.getElementById('pcTestResult');
        if (r) r.innerHTML = '';
    } catch (e) {
        pcSetText('pcModeText', '-');
        const r = document.getElementById('pcTestResult');
        if (r) {
            r.innerHTML = `<div style="padding:16px;color:#EF4444;">${ec9Esc(e.message)}</div>`;
        }
    }
}

function fillPayConfigForm(c) {
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v == null ? '' : v; };

    // 模式下拉（按当前语种重填）
    const sel = document.getElementById('pcMode');
    if (sel) {
        sel.innerHTML = PC_MODES.map(([v, key, fb]) =>
            `<option value="${v}">${ec9Esc(ec9T(key, fb))}</option>`).join('');
    }
    const en = document.getElementById('pcEnabled');
    if (en) {
        en.innerHTML = `<option value="1">${ec9Esc(ec9T('ec9.field.enabled', '启用'))}</option>` +
            `<option value="0">${ec9Esc(ec9T('ec9.field.disabled', '停用'))}</option>`;
    }

    setVal('pcMode', c.mode || 'mock');
    setVal('pcEnabled', String(c.enabled == null ? 1 : c.enabled));
    setVal('pcAppId', c.app_id);
    setVal('pcMchId', c.mch_id);
    setVal('pcSignType', c.sign_type || 'MD5');
    setVal('pcCertPath', c.cert_path);
    setVal('pcNotifyUrl', c.notify_url);
    setVal('pcRefundNotifyUrl', c.refund_notify_url);
    setVal('pcExpire', c.order_expire_minutes || 30);
    setVal('pcRemark', c.remark);

    // 密钥输入框永远留空（回传空 = 不修改），只展示掩码
    setVal('pcApiKey', '');
    setVal('pcApiV3Key', '');
    const mask = (id, masked, isSet) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (isSet && masked) {
            el.textContent = ec9T('ec9.payCfg.keySet', '已设置') + '：' + masked + ' · ' +
                ec9T('ec9.payCfg.keyKeepHint', '留空则不修改');
            el.style.color = '#6B7280';
        } else {
            el.textContent = ec9T('ec9.payCfg.keyUnset', '未设置');
            el.style.color = '#EF4444';
        }
    };
    mask('pcApiKeyMask', c.api_key_masked, c.api_key_set);
    mask('pcApiV3KeyMask', c.api_v3_key_masked, c.api_v3_key_set);

    // 顶部状态卡
    const modeRow = PC_MODES.find(m => m[0] === (c.mode || 'mock'));
    pcSetText('pcModeText', modeRow ? ec9T(modeRow[1], modeRow[2]) : (c.mode || '-'));
    pcSetText('pcSourceText', c.source === 'db'
        ? ec9T('ec9.payCfg.sourceDb', '数据库')
        : ec9T('ec9.payCfg.sourceEnv', '环境变量'));
    pcSetText('pcEnabledText', Number(c.enabled) === 1
        ? ec9T('ec9.field.enabled', '启用')
        : ec9T('ec9.field.disabled', '停用'));
    pcSetText('pcUpdatedText', c.updated_at ? ec9Esc(String(c.updated_at).slice(0, 19).replace('T', ' ')) : '-');
}

/** 保存：密钥留空表示不修改 */
async function savePayConfig() {
    const val = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    const payload = {
        mode: val('pcMode'),
        enabled: Number(val('pcEnabled')),
        app_id: val('pcAppId'),
        mch_id: val('pcMchId'),
        api_key: val('pcApiKey'),
        api_v3_key: val('pcApiV3Key'),
        sign_type: val('pcSignType'),
        cert_path: val('pcCertPath'),
        notify_url: val('pcNotifyUrl'),
        refund_notify_url: val('pcRefundNotifyUrl'),
        order_expire_minutes: Number(val('pcExpire') || 30),
        remark: val('pcRemark')
    };
    if (payload.mode === 'real' && !payload.mch_id) {
        alert(ec9T('ec9.payCfg.needMchId', '生产模式必须填写商户号'));
        return;
    }
    try {
        const res = await apiRequest('/pay-config', {
            method: 'PUT',
            body: JSON.stringify(payload)
        });
        if (res.code !== 0) throw new Error(res.message || ec9T('ec9.payCfg.saveFailed', '保存失败'));
        alert(ec9T('ec9.payCfg.saved', '支付配置已保存并生效，无需重启'));
        await loadPayConfig();
        await testPayConfig();
    } catch (e) {
        alert(e.message);
    }
}

/** 最近一次自检结果（切语言时用来重渲染，不重新请求） */
let pcLastTest = null;

/** 配置自检 */
async function testPayConfig() {
    const box = document.getElementById('pcTestResult');
    if (!box) return;
    box.innerHTML = `<div style="padding:16px;color:#6B7280;">${ec9Esc(ec9T('admin.loading', '加载中'))}...</div>`;
    try {
        const res = await apiRequest('/pay-config/test', { method: 'POST', body: JSON.stringify({}) });
        if (res.code !== 0) throw new Error(res.message || ec9T('admin.loadFailed', '加载失败'));
        pcLastTest = res.data || {};
        renderPayConfigIssues(pcLastTest);
    } catch (e) {
        box.innerHTML = `<div style="padding:16px;color:#EF4444;">${ec9Esc(e.message)}</div>`;
    }
}

/**
 * 渲染自检结果
 *
 * ⚠️ 后端 issue 带 code，这里按 ec9.payCfg.issue.<code> 取译文，
 *    不能直接把后端中文 message 写进 DOM —— 那样切英文后这块还是中文
 *    （i18n 只对整段完全匹配的文本做反查，拼接串反查不到）。
 */
function renderPayConfigIssues(d) {
    const box = document.getElementById('pcTestResult');
    if (!box) return;
    const issues = d.issues || [];
    const colorOf = (lv) => (lv === 'error' ? '#EF4444' : lv === 'warn' ? '#F59E0B' : lv === 'ok' ? '#10B981' : '#6B7280');
    const bgOf = (lv) => (lv === 'error' ? '#FEF2F2' : lv === 'warn' ? '#FFFBEB' : lv === 'ok' ? '#ECFDF5' : '#F9FAFB');

    const head = `<div style="padding:12px 16px;border-radius:8px;margin-bottom:8px;background:${d.ok ? '#ECFDF5' : '#FEF2F2'};color:${d.ok ? '#10B981' : '#EF4444'};font-weight:600;">` +
        (d.ok ? ec9T('ec9.payCfg.testPass', '配置检查通过')
            : ec9T('ec9.payCfg.testFail', '配置存在问题，请修正后再启用生产模式')) +
        `（${ec9Esc(ec9T('ec9.payCfg.mode', '运行模式'))}: ${ec9Esc(d.mode || '-')}）</div>`;

    const rows = issues.map((i) => {
        let text = i.message || '';
        if (i.code) {
            const tpl = ec9T('ec9.payCfg.issue.' + i.code, i.message);
            // 只有取到译文（不是原样回落）才做参数替换
            text = tpl.replace(/\{(\d+)\}/g, (m, idx) => {
                const p = (i.params || [])[Number(idx)];
                return p == null ? m : String(p);
            });
        }
        return `<div style="padding:10px 16px;border-radius:8px;margin-bottom:6px;background:${bgOf(i.level)};color:${colorOf(i.level)};">${ec9Esc(text)}</div>`;
    }).join('');

    box.innerHTML = head + (rows || `<div style="padding:12px 16px;color:#6B7280;">${ec9Esc(ec9T('ec9.payCfg.noIssue', '没有需要提示的项'))}</div>`);
}

/**
 * 语言切换后重渲染自检结果
 * 挂在 I18N.setLang 上：切语言时若正停在支付配置页且已跑过自检，就用新语种重画一遍。
 */
(function hookPayConfigLangSwitch() {
    if (typeof window === 'undefined') return;
    // ⚠️ 不能去包装 I18N.setLang：切换按钮 onclick 调的是 i18n.js 闭包内的 setLang，
    //    包装导出对象上的引用根本不会被调用到。i18n.js 切换完成后会派发 i18n:changed，
    //    监听这个事件才是正确姿势（此时新语言包已 apply 完，取词一定是最新的）。
    window.addEventListener('i18n:changed', function () {
        try {
            const page = document.getElementById('pay-config');
            if (pcLastTest && page && !page.classList.contains('hidden')) {
                renderPayConfigIssues(pcLastTest);
            }
        } catch (e) { /* 重渲染失败不影响语言切换 */ }
    });
})();

/* ============================================================
 * 短信配置（通道凭证 + 验证码参数）
 * ------------------------------------------------------------
 * 与支付配置同一套做法：落库 + 后台可改 + 热更新，不再依赖 .env。
 * AccessKey Secret 对外只回掩码，明文只在进程内存里给发送客户端用。
 * ============================================================ */

let scLastTest = null;

async function loadSmsConfig() {
    try {
        const res = await apiRequest('/sms-config');
        if (res.code !== 0) throw new Error(res.message || ec9T('admin.loadFailed', '加载失败'));
        fillSmsConfigForm(res.data.config || {});
        const r = document.getElementById('scTestResult');
        if (r) r.innerHTML = '';
    } catch (e) {
        scSetText('scStatusText', '-');
        const r = document.getElementById('scTestResult');
        if (r) r.innerHTML = `<div style="padding:16px;color:#EF4444;">${ec9Esc(e.message)}</div>`;
    }
}

function scSetText(id, v) {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
}

function fillSmsConfigForm(c) {
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v == null ? '' : v; };

    const en = document.getElementById('scEnabled');
    if (en) {
        en.innerHTML = `<option value="1">${ec9Esc(ec9T('ec9.field.enabled', '启用'))}</option>` +
            `<option value="0">${ec9Esc(ec9T('ec9.field.disabled', '停用'))}</option>`;
    }
    setVal('scEnabled', String(c.enabled == null ? 0 : c.enabled));
    setVal('scRegion', c.region || 'cn-hangzhou');
    setVal('scAkId', c.access_key_id);
    setVal('scSignName', c.sign_name);
    setVal('scVerifyTpl', c.verify_template_code);
    setVal('scExpire', c.code_expire_minutes || 5);
    setVal('scResend', c.code_resend_seconds || 60);
    setVal('scDaily', c.code_daily_limit || 10);
    setVal('scAttempts', c.code_max_attempts || 5);
    setVal('scEndpoint', c.endpoint);
    setVal('scRemark', c.remark);

    setVal('scAkSecret', '');
    const maskEl = document.getElementById('scAkSecretMask');
    if (maskEl) {
        if (c.access_key_secret_set && c.access_key_secret_masked) {
            maskEl.textContent = ec9T('ec9.payCfg.keySet', '已设置') + '：' + c.access_key_secret_masked + ' · ' +
                ec9T('ec9.payCfg.keyKeepHint', '留空则不修改');
            maskEl.style.color = '#6B7280';
        } else {
            maskEl.textContent = ec9T('ec9.payCfg.keyUnset', '未设置');
            maskEl.style.color = '#EF4444';
        }
    }

    scSetText('scStatusText', c.ready
        ? ec9T('ec9.smsCfg.ready', '可用')
        : (Number(c.enabled) === 1 ? ec9T('ec9.smsCfg.notReady', '缺参数') : ec9T('ec9.field.disabled', '停用')));
    scSetText('scSourceText', c.source === 'db'
        ? ec9T('ec9.payCfg.sourceDb', '数据库')
        : ec9T('ec9.payCfg.sourceEnv', '环境变量'));
    scSetText('scSignText', c.sign_name || '-');
    scSetText('scUpdatedText', c.updated_at ? String(c.updated_at).slice(0, 19).replace('T', ' ') : '-');
}

async function saveSmsConfig() {
    const val = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    const payload = {
        enabled: Number(val('scEnabled')),
        region: val('scRegion'),
        access_key_id: val('scAkId'),
        access_key_secret: val('scAkSecret'),
        sign_name: val('scSignName'),
        verify_template_code: val('scVerifyTpl'),
        code_expire_minutes: Number(val('scExpire') || 5),
        code_resend_seconds: Number(val('scResend') || 60),
        code_daily_limit: Number(val('scDaily') || 10),
        code_max_attempts: Number(val('scAttempts') || 5),
        endpoint: val('scEndpoint'),
        remark: val('scRemark')
    };
    try {
        const res = await apiRequest('/sms-config', { method: 'PUT', body: JSON.stringify(payload) });
        if (res.code !== 0) throw new Error(res.message || ec9T('ec9.payCfg.saveFailed', '保存失败'));
        alert(ec9T('ec9.smsCfg.saved', '短信配置已保存并生效，无需重启'));
        await loadSmsConfig();
        await testSmsConfig();
    } catch (e) {
        alert(e.message);
    }
}

async function testSmsConfig() {
    const box = document.getElementById('scTestResult');
    if (!box) return;
    box.innerHTML = `<div style="padding:16px;color:#6B7280;">${ec9Esc(ec9T('admin.loading', '加载中'))}...</div>`;
    try {
        const res = await apiRequest('/sms-config/test', { method: 'POST', body: JSON.stringify({}) });
        if (res.code !== 0) throw new Error(res.message || ec9T('admin.loadFailed', '加载失败'));
        scLastTest = res.data || {};
        renderSmsConfigIssues(scLastTest);
    } catch (e) {
        box.innerHTML = `<div style="padding:16px;color:#EF4444;">${ec9Esc(e.message)}</div>`;
    }
}

/** 自检结果渲染：与支付配置同一套（按 code 取译文，切语言跟着变） */
function renderSmsConfigIssues(d) {
    const box = document.getElementById('scTestResult');
    if (!box) return;
    const issues = d.issues || [];
    const colorOf = (lv) => (lv === 'error' ? '#EF4444' : lv === 'warn' ? '#F59E0B' : lv === 'ok' ? '#10B981' : '#6B7280');
    const bgOf = (lv) => (lv === 'error' ? '#FEF2F2' : lv === 'warn' ? '#FFFBEB' : lv === 'ok' ? '#ECFDF5' : '#F9FAFB');
    const head = `<div style="padding:12px 16px;border-radius:8px;margin-bottom:8px;background:${d.ok ? '#ECFDF5' : '#FEF2F2'};color:${d.ok ? '#10B981' : '#EF4444'};font-weight:600;">` +
        (d.ready ? ec9T('ec9.smsCfg.testReady', '通道可用，可发起真实发送')
            : ec9T('ec9.smsCfg.testFail', '通道暂不可用，请补全参数')) + '</div>';
    const rows = issues.map((i) => {
        let text = i.message || '';
        if (i.code) {
            const tpl = ec9T('ec9.smsCfg.issue.' + i.code, i.message);
            text = tpl.replace(/\{(\d+)\}/g, (m, idx) => {
                const p = (i.params || [])[Number(idx)];
                return p == null ? m : String(p);
            });
        }
        return `<div style="padding:10px 16px;border-radius:8px;margin-bottom:6px;background:${bgOf(i.level)};color:${colorOf(i.level)};">${ec9Esc(text)}</div>`;
    }).join('');
    box.innerHTML = head + (rows || `<div style="padding:12px 16px;color:#6B7280;">${ec9Esc(ec9T('ec9.payCfg.noIssue', '没有需要提示的项'))}</div>`);
}

/** 切语言后重渲染（i18n:changed，见支付配置同款注释） */
(function hookSmsConfigLangSwitch() {
    if (typeof window === 'undefined') return;
    window.addEventListener('i18n:changed', function () {
        try {
            const page = document.getElementById('sms-config');
            if (scLastTest && page && !page.classList.contains('hidden')) renderSmsConfigIssues(scLastTest);
        } catch (e) { /* 忽略 */ }
    });
})();
