/* 城市慢行站 · 季节年历前端
   关键原则：浏览器时区只用于展示；所有编辑与计算都在服务端按活动所在地时区完成。 */
(function () {
    'use strict';

    const $ = (s, el = document) => el.querySelector(s);
    const $$ = (s, el = document) => [...el.querySelectorAll(s)];

    // 同源（Python 服务）优先；静态文件/其他端口打开时回退到 8090
    let BASE = location.protocol.startsWith('http') ? '' : 'http://localhost:8090';

    async function api(path, opts = {}) {
        opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
        if (opts.body && !opts.headers['Idempotency-Key']) {
            opts.headers['Idempotency-Key'] = (crypto.randomUUID && crypto.randomUUID()) ||
                ('k-' + Date.now() + '-' + Math.random().toString(16).slice(2));
        }
        const doFetch = b => fetch(b + path, opts).then(async r => {
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw Object.assign(new Error(data.error || r.statusText),
                { status: r.status, details: data.details, replay: r.headers.get('Idempotent-Replay') });
            return data;
        });
        try {
            return await doFetch(BASE);
        } catch (e) {
            if (BASE === '' && (location.protocol.startsWith('http'))) {
                BASE = location.protocol + '//' + location.hostname + ':8090';
                return doFetch(BASE);
            }
            throw e;
        }
    }

    const TZ_CHOICES = ['Asia/Shanghai', 'Asia/Urumqi', 'Asia/Tokyo', 'Asia/Bangkok',
        'Europe/Berlin', 'Europe/London', 'America/New_York', 'America/Los_Angeles',
        'Pacific/Auckland', 'UTC'];
    const viewerTz = $('#viewerTz');
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    [...new Set([detected, ...TZ_CHOICES])].forEach(z => viewerTz.add(new Option(z, z)));
    viewerTz.value = TZ_CHOICES.includes(detected) ? detected : 'Asia/Shanghai';

    const tzSelect = $('#tzSelect');
    TZ_CHOICES.forEach(z => tzSelect.add(new Option(z, z)));

    const state = { templates: [], routes: [], instances: [], currentTpl: null,
        viewYear: new Date().getFullYear(), viewMonth: new Date().getMonth(),
        selectedKey: null };

    function toast(msg, kind = '') {
        const t = $('#toast');
        t.textContent = msg; t.className = 'toast ' + kind; t.hidden = false;
        clearTimeout(toast._t);
        toast._t = setTimeout(() => { t.hidden = true; }, 3200);
    }

    const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const hm = iso => iso.slice(11, 16);

    // ---------------- 数据加载 ----------------
    async function loadRoutes() {
        state.routes = await api('/api/routes');
        const sel = $('#routeSelect');
        state.routes.forEach(r => sel.add(new Option(`${r.name}（${r.timezone}）`, r.id)));
    }

    async function loadTemplates() {
        state.templates = await api('/api/templates');
        const ul = $('#tplList');
        ul.innerHTML = '';
        state.templates.forEach(t => {
            const li = document.createElement('li');
            if (state.currentTpl && state.currentTpl.id === t.id) li.classList.add('active');
            const freqText = { DAILY: '每天', WEEKLY: '每周', MONTHLY: '每月' }[t.rrule_freq];
            li.innerHTML = `<div class="t-title">${esc(t.title)}
                <span class="vtag">v${t.version}</span></div>
                <div class="t-meta">${freqText} · ${esc(t.timezone)} ·
                ${t.start_date} ~ ${t.end_date} · ${esc(t.start_time)}-${esc(t.end_time)}
                ${t.end_time <= t.start_time ? '🌙跨午夜' : ''}</div>`;
            li.onclick = () => selectTemplate(t.id);
            ul.appendChild(li);
        });
        if (!state.currentTpl && state.templates.length) selectTemplate(state.templates[0].id);
        else if (state.currentTpl) render();
    }

    async function selectTemplate(id) {
        state.currentTpl = state.templates.find(t => t.id === id);
        state.instances = await api(`/api/templates/${id}/instances?viewer_tz=${viewerTz.value}`);
        const d = new Date();
        state.viewYear = d.getFullYear(); state.viewMonth = d.getMonth();
        loadTemplates(); // 高亮
        fillForm(state.currentTpl);
        render();
    }

    // ---------------- 月历 ----------------
    function render() {
        renderMonth();
        loadWeekly();
        loadHistory();
    }

    function renderMonth() {
        const t = state.currentTpl;
        $('#monthTitle').textContent = t
            ? `${state.viewYear} 年 ${state.viewMonth + 1} 月 · ${t.title}` : '—';
        const grid = $('#monthGrid');
        grid.innerHTML = '';
        const first = new Date(state.viewYear, state.viewMonth, 1);
        const lead = (first.getDay() + 6) % 7; // 周一为首列
        const daysIn = new Date(state.viewYear, state.viewMonth + 1, 0).getDate();
        const prevDays = new Date(state.viewYear, state.viewMonth, 0).getDate();
        const today = new Date();
        const byDate = {};
        (state.instances || []).forEach(i => (byDate[i.orig_occ_date] ||= []).push(i));

        const total = lead + daysIn;
        const cells = Math.ceil(total / 7) * 7;
        for (let c = 0; c < cells; c++) {
            const div = document.createElement('div');
            div.className = 'day';
            let ymd, dnum;
            if (c < lead) {
                dnum = prevDays - lead + c + 1;
                div.classList.add('out');
                const d = new Date(state.viewYear, state.viewMonth - 1, dnum);
                ymd = isoDate(d);
            } else if (c >= lead + daysIn) {
                dnum = c - lead - daysIn + 1;
                div.classList.add('out');
                ymd = isoDate(new Date(state.viewYear, state.viewMonth + 1, dnum));
            } else {
                dnum = c - lead + 1;
                ymd = `${state.viewYear}-${String(state.viewMonth + 1).padStart(2, '0')}-${String(dnum).padStart(2, '0')}`;
                if (today.getFullYear() === state.viewYear && today.getMonth() === state.viewMonth
                    && today.getDate() === dnum) div.classList.add('today');
            }
            div.innerHTML = `<span class="dnum">${dnum}</span>`;
            (byDate[ymd] || []).forEach(i => {
                const ev = document.createElement('span');
                ev.className = 'ev ' + (i.status === 'CANCELLED' ? 'cancel'
                    : i.status === 'RESCHEDULED' ? 'moved' : 'sched');
                if (i.construction_note && i.status === 'SCHEDULED') ev.classList.add('hasnotice');
                ev.title = `${i.status}｜${i.local_start} ~ ${i.local_end}${i.construction_note ? '\n' + i.construction_note : ''}`;
                const labelTime = i.status === 'RESCHEDULED' ? hm(i.local_start) : hm(i.local_start);
                ev.textContent = `${labelTime} ${i.title}`;
                ev.onclick = (e) => { e.stopPropagation(); showDetail(i); };
                div.appendChild(ev);
            });
            grid.appendChild(div);
        }
    }

    function isoDate(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    // ---------------- 详情 + 计算依据 ----------------
    async function showDetail(i) {
        state.selectedKey = i.template_slug + '@' + i.orig_occ_date;
        const box = $('#detailBox');
        box.innerHTML = '<p class="muted">加载计算依据…</p>';
        try {
            const d = await api(`/api/instances/${i.template_slug}/${i.orig_occ_date}?viewer_tz=${viewerTz.value}`);
            const b = d.basis;
            const exc = b.exception;
            const chain = `${esc(d.local_start)}（${esc(d.timezone)}）→ ${esc(d.utc_start)}` +
                (d.viewer_start ? ` → 你看到 ${esc(d.viewer_start)}（日期 ${esc(d.viewer_date)}）` : '');
            box.innerHTML = `
              <h3>${esc(d.title)} <span class="badge ${d.status}">${d.status}</span></h3>
              <dl class="kv">
                <dt>原始发生日</dt><dd>${esc(d.orig_occ_date)}（按 ${esc(d.timezone)}）</dd>
                <dt>当地时间</dt><dd>${esc(d.local_start)} ~ ${esc(d.local_end)}
                    ${d.local_end.slice(0, 10) !== d.local_start.slice(0, 10) ? '🌙跨午夜' : ''}</dd>
                <dt>UTC</dt><dd>${esc(d.utc_start)} ~ ${esc(d.utc_end)}</dd>
                ${d.viewer_start ? `<dt>你的时区</dt><dd>${esc(d.viewer_start)} ~ ${esc(d.viewer_end)}（${esc(d.viewer_date)}）</dd>` : ''}
                <dt>规则版本</dt><dd>v${d.rule_version} ${d.locked ? '🔒已锁定（结束或有单次例外）' : ''}</dd>
                <dt>关联路线</dt><dd>${d.route ? esc(d.route.name) : '无'}</dd>
              </dl>
              <div class="basis">
                <strong>为什么在这一天？</strong>
                <p>${esc(b.explanation_zh)}</p>
                <p>依据来源：<span class="chain">${esc(b.derived_from)}</span></p>
                ${exc ? `<p>单次例外：${esc(exc.kind)}（${esc(exc.source)}）理由：${esc(exc.reason || '—')}</p>` : ''}
                ${b.construction.length ? `<p>相交施工：${b.construction.map(c =>
                    `#${c.id} ${esc(c.reason)} ${esc(c.starts_at_local)}~${esc(c.ends_at_local)}`).join('；')}</p>` : ''}
                <p class="chain">${esc(chain)}</p>
                <p class="prec">优先级：${b.precedence.map(esc).join(' ＞ ')}<br>${esc(b.note)}</p>
              </div>
              <div class="inst-actions">
                <button class="btn btn-ghost btn-sm" id="cancelToggle">单次取消</button>
                <button class="btn btn-ghost btn-sm" id="moveToggle">临时改期</button>
                ${exc ? '<button class="btn btn-ghost btn-sm" id="restoreBtn">恢复为系列规则</button>' : ''}
              </div>
              <div class="mini-form" id="cancelForm">
                <label>取消理由<input id="cancelReason" placeholder="如：志愿者请假"></label>
                <button class="btn btn-primary btn-sm" id="cancelOk">确认取消（仅此一场）</button>
              </div>
              <div class="mini-form" id="moveForm">
                <label>改到日期<input id="moveDate" type="date"></label>
                <label>开始<input id="moveStart" type="time" value="${esc(d.local_start.slice(11, 16))}"></label>
                <label>结束<input id="moveEnd" type="time" value="20:30"></label>
                <label>理由<input id="moveReason"></label>
                <button class="btn btn-primary btn-sm" id="moveOk">确认改期</button>
              </div>`;
            $('#cancelToggle').onclick = () => $('#cancelForm').classList.toggle('open');
            $('#moveToggle').onclick = () => $('#moveForm').classList.toggle('open');
            $('#cancelOk').onclick = () => doException('cancel', {
                reason: $('#cancelReason').value });
            $('#moveOk').onclick = () => doException('reschedule', {
                new_date: $('#moveDate').value, new_start_time: $('#moveStart').value,
                new_end_time: $('#moveEnd').value, reason: $('#moveReason').value });
            if (exc) $('#restoreBtn').onclick = () => doRestore(exc.source === 'CONSTRUCTION');
        } catch (e) {
            box.innerHTML = `<p class="muted">加载失败：${esc(e.message)}</p>`;
        }
    }

    async function doException(kind, body) {
        const [slug, date] = state.selectedKey.split('@');
        try {
            const r = await api(`/api/instances/${slug}/${date}/${kind}`,
                { method: 'POST', body: JSON.stringify(body) });
            toast((r.replay === 'true' ? '幂等重放：' : '') +
                (kind === 'cancel' ? '该场次已取消（系列不受影响）' : '已改期（仅此一场）'), 'ok');
            await refreshAll();
            const inst = state.instances.find(x => x.template_slug === slug && x.orig_occ_date === date);
            if (inst) showDetail(inst);
        } catch (e) { toast(e.message, 'err'); }
    }

    async function doRestore(isConstruction) {
        const [slug, date] = state.selectedKey.split('@');
        const body = { reason: '编辑手动恢复' };
        if (isConstruction) body.allow_construction = confirm('该取消由施工相交产生。仍要强制恢复这一场吗？');
        if (isConstruction && !body.allow_construction) return;
        try {
            await api(`/api/instances/${slug}/${date}/restore`,
                { method: 'POST', body: JSON.stringify(body) });
            toast('已恢复为系列规则，并在历史中留痕', 'ok');
            await refreshAll();
            const inst = state.instances.find(x => x.template_slug === slug && x.orig_occ_date === date);
            if (inst) showDetail(inst);
        } catch (e) { toast(e.message, 'err'); }
    }

    async function refreshAll() {
        if (state.currentTpl) {
            state.instances = await api(`/api/templates/${state.currentTpl.id}/instances?viewer_tz=${viewerTz.value}`);
            state.templates = await api('/api/templates');
            renderMonth(); loadWeekly(); loadHistory();
        }
    }

    // ---------------- 本周推荐 ----------------
    async function loadWeekly() {
        try {
            const d = await api(`/api/weekly?viewer_tz=${viewerTz.value}`);
            const tag = $('#cacheState');
            tag.textContent = d.cache_state;
            tag.className = 'cache-tag ' + d.cache_state;
            const ul = $('#weeklyList');
            ul.innerHTML = '';
            if (!d.items.length) {
                ul.innerHTML = '<li class="muted">本周没有推荐（已取消场次不会出现）。</li>';
            }
            d.items.forEach(i => {
                const li = document.createElement('li');
                li.innerHTML = `<strong>${esc(i.title)}</strong><br>
                    ${esc(i.orig_occ_date)} ${esc(hm(i.local_start))}（当地 ${esc(i.timezone)}）
                    ${i.viewer_start ? `<div class="viewer">你的时区：${esc(i.viewer_start)}（${esc(i.viewer_date)}）</div>` : ''}
                    ${i.construction_note ? `<div class="viewer">⚠️ ${esc(i.construction_note)}</div>` : ''}`;
                li.onclick = () => selectTemplate(i.template_id);
                ul.appendChild(li);
            });
        } catch (e) {
            $('#weeklyList').innerHTML = `<li class="muted">加载失败：${esc(e.message)}</li>`;
        }
    }

    // ---------------- 历史 ----------------
    async function loadHistory() {
        try {
            const rows = await api('/api/history');
            const ul = $('#historyList');
            ul.innerHTML = rows.length ? '' : '<li class="muted">暂无取消/恢复记录。</li>';
            rows.forEach(h => {
                const li = document.createElement('li');
                li.className = h.event;
                li.innerHTML = `<strong>${h.event === 'CANCELLED' ? '❌ 取消' : '✅ 恢复'}</strong>
                    ${esc(h.title)} · ${esc(h.orig_occ_date)}
                    <div>来源：${esc(h.source)} · 理由：${esc(h.reason || '—')}</div>
                    <div class="poster">当时海报快照：${esc(h.poster_snapshot || '—')} · ${esc(h.created_at)}</div>`;
                ul.appendChild(li);
            });
        } catch (e) { /* ignore */ }
    }

    // ---------------- 模板表单 ----------------
    function fillForm(t) {
        const f = $('#tplForm');
        if (!t) { f.hidden = true; return; }
        f.hidden = false;
        $('#formTitle').textContent = `编辑：${t.title}（v${t.version}）`;
        const set = (n, v) => { if (f.elements[n]) f.elements[n].value = v ?? ''; };
        ['slug', 'title', 'description', 'timezone', 'by_weekday', 'by_monthday',
            'start_date', 'end_date', 'start_time', 'end_time', 'poster'].forEach(k => set(k, t[k]));
        f.elements['rrule_freq'].value = t.rrule_freq;
        f.elements['rrule_interval'].value = t.rrule_interval;
        f.elements['route_id'].value = t.route_id ?? '';
        f.elements['seg_from'].value = t.seg_from;
        f.elements['seg_to'].value = t.seg_to;
        f.elements['slug'].readOnly = true; // 更新不改 slug
        toggleFreqFields();
    }

    function toggleFreqFields() {
        const freq = $('#freqSelect').value;
        $('.wk-field').hidden = freq !== 'WEEKLY';
        $('.mo-field').hidden = freq !== 'MONTHLY';
    }

    function readForm() {
        const f = $('#tplForm');
        const v = Object.fromEntries(new FormData(f).entries());
        v.rrule_interval = Number(v.rrule_interval || 1);
        v.route_id = v.route_id ? Number(v.route_id) : null;
        v.seg_from = Number(v.seg_from || 0);
        v.seg_to = Number(v.seg_to || 1000000);
        if (v.rrule_freq !== 'WEEKLY') delete v.by_weekday;
        if (v.rrule_freq !== 'MONTHLY') delete v.by_monthday;
        if (!v.by_weekday) delete v.by_weekday;
        if (!v.by_monthday) delete v.by_monthday;
        return v;
    }

    $('#tplForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = readForm();
        try {
            if (state.currentTpl && state.currentTpl.slug === body.slug) {
                delete body.slug;
                const r = await api(`/api/templates/${state.currentTpl.id}/update`,
                    { method: 'POST', body: JSON.stringify(body) });
                toast(`已保存并展开：新增 ${r.materialize.created}，更新 ${r.materialize.updated}，跳过锁定 ${r.materialize.skipped_locked}`, 'ok');
            } else {
                const r = await api('/api/templates',
                    { method: 'POST', body: JSON.stringify(body) });
                toast('模板已创建并展开', 'ok');
                state.currentTpl = r.template;
            }
            await loadTemplates();
        } catch (err) { toast(err.message, 'err'); }
    });

    $('#newTplBtn').onclick = () => {
        state.currentTpl = null;
        const f = $('#tplForm');
        f.reset(); f.hidden = false;
        f.elements['slug'].readOnly = false;
        $('#formTitle').textContent = '新建活动模板';
        f.elements['start_date'].value = isoDate(new Date());
        const eoy = new Date(new Date().getFullYear(), 11, 31);
        f.elements['end_date'].value = isoDate(eoy);
        toggleFreqFields();
        $$('#tplList li').forEach(li => li.classList.remove('active'));
    };
    $('#cancelFormBtn').onclick = () => { $('#tplForm').hidden = true; };
    $('#freqSelect').onchange = toggleFreqFields;

    $('#prevMonth').onclick = () => shiftMonth(-1);
    $('#nextMonth').onclick = () => shiftMonth(1);
    function shiftMonth(delta) {
        const d = new Date(state.viewYear, state.viewMonth + delta, 1);
        state.viewYear = d.getFullYear(); state.viewMonth = d.getMonth();
        renderMonth();
    }
    $('#rematBtn').onclick = async () => {
        if (!state.currentTpl) return;
        try {
            const s = await api(`/api/templates/${state.currentTpl.id}/materialize`,
                { method: 'POST', body: JSON.stringify({}) });
            toast(`重新展开完成（幂等）：新增 ${s.created}，取消 ${s.cancelled_by_construction}，恢复 ${s.reinstated}`, 'ok');
            await refreshAll();
        } catch (e) { toast(e.message, 'err'); }
    };
    viewerTz.onchange = () => refreshAll().then(() => {
        if (state.selectedKey) {
            const [slug, date] = state.selectedKey.split('@');
            const inst = state.instances.find(x => x.template_slug === slug && x.orig_occ_date === date);
            if (inst) showDetail(inst);
        }
    });

    // ---------------- 启动 ----------------
    (async function boot() {
        try {
            await loadRoutes();
            await loadTemplates();
            $('#apiState').textContent = `已连接 ${BASE || '同源 API'} · 你的时区仅影响展示`;
            $('#apiState').className = 'api-state online';
        } catch (e) {
            $('#apiState').textContent = 'API 未连接（请先启动 python3 server/app.py）';
            $('#apiState').className = 'api-state offline';
            toast('无法连接后端：' + e.message, 'err');
        }
    })();
})();
