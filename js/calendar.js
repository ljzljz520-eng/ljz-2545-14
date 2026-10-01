'use strict';
/**
 * 城市慢行站 · 季节年历前端
 * - 月历渲染（按活动所在地日期归日）
 * - 模板（周期/关联路线）编辑、单次例外（取消/改期）
 * - 施工通告、本周推荐、取消历史
 * - “计算依据”弹窗：解释活动为什么在这一天
 */
(function () {
  const $ = id => document.getElementById(id);
  const api = {
    get: (p) => fetch(p).then(r => r.json()),
    post: (p, body) => fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()),
    put: (p, body) => fetch(p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()),
  };

  const state = {
    stations: [], routes: [], templates: [],
    stationId: null, viewerTz: '',
    year: new Date().getFullYear(), month: new Date().getMonth() + 1,
    monthItems: [], currentInstance: null,
  };

  const SEASON_MONTH = { spring: 3, summer: 6, autumn: 9, winter: 12 };
  const pad2 = n => String(n).padStart(2, '0');

  function toast(msg) {
    let el = document.querySelector('.toast-cal');
    if (!el) { el = document.createElement('div'); el.className = 'toast-cal'; document.body.appendChild(el); }
    el.textContent = msg; el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2600);
  }

  // ---------------- 数据加载 ----------------
  async function loadBase() {
    state.stations = await api.get('/api/stations');
    state.stationId = state.stationId || (state.stations[0] && state.stations[0].id);
    const sel = $('stationSelect');
    sel.innerHTML = state.stations.map(s => `<option value="${s.id}">${s.name}（${s.tz}）</option>`).join('');
    sel.value = state.stationId;
    state.routes = await api.get(`/api/routes?station_id=${state.stationId}`);
    fillRouteSelects();
    await Promise.all([loadTemplates(), loadMonth(), loadWeek(), loadClosures(), loadCancellations()]);
  }

  function fillRouteSelects() {
    const opts = state.routes.map(r => `<option value="${r.id}">${r.name}</option>`).join('');
    $('tplRoute').innerHTML = `<option value="">（不关联路线）</option>` + opts;
    $('closureRoute').innerHTML = opts;
    fillSegments($('closureRoute').value, $('closureSegment'), true);
    fillSegments($('tplRoute').value, null, false);
  }

  function fillSegments(routeId, selectEl, allowAll) {
    const route = state.routes.find(r => r.id === routeId);
    const segs = route ? route.segments : [];
    if (selectEl) {
      selectEl.innerHTML = (allowAll ? '<option value="">全线</option>' : '') +
        segs.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
    } else {
      $('tplSegments').innerHTML = segs.map(s =>
        `<label><input type="checkbox" value="${s.id}" class="tpl-seg"> ${s.name}</label>`).join('') || '<span class="muted">未关联路线</span>';
    }
  }

  async function loadTemplates() {
    state.templates = await api.get(`/api/templates?station_id=${state.stationId}`);
    const ul = $('templateList');
    ul.innerHTML = state.templates.map(t => `
      <li data-id="${t.id}">
        <div class="tpl-title">${t.title} <small>v${t.version}</small></div>
        <div class="tpl-sub">${t.rrule} · ${t.dtstart_local.slice(0, 10)} ${t.dtstart_local.slice(11, 16)} 起 · ${t.duration_min}分钟</div>
        <div class="tpl-sub">${t.season} · ${routeName(t.route_id)}</div>
      </li>`).join('') || '<li class="muted">暂无模板，请在右侧创建</li>';
    ul.querySelectorAll('li[data-id]').forEach(li =>
      li.addEventListener('click', () => fillTemplateForm(li.dataset.id)));
  }

  const routeName = id => (state.routes.find(r => r.id === id) || {}).name || '（无路线）';

  async function loadMonth() {
    const { year, month } = state;
    $('monthLabel').textContent = `${year} 年 ${month} 月`;
    const from = `${year}-${pad2(month)}-01`;
    const toDate = new Date(Date.UTC(year, month, 1));
    const to = `${toDate.getUTCFullYear()}-${pad2(toDate.getUTCMonth() + 1)}-01`;
    const tzq = state.viewerTz ? `&viewer_tz=${state.viewerTz}` : '';
    state.monthItems = await api.get(`/api/calendar?station_id=${state.stationId}&from=${from}&to=${to}${tzq}`);
    renderGrid();
    highlightSeasonTab();
  }

  async function loadWeek() {
    const tzq = state.viewerTz ? `&viewer_tz=${state.viewerTz}` : '';
    const data = await api.get(`/api/recommendations/week?station_id=${state.stationId}${tzq}`);
    $('weekRange').textContent = `${data.week_start_local} 起 · ${data.station_tz}`;
    $('weekList').innerHTML = data.items.map(i => `
      <li data-iid="${i.id}"><b>${i.occurrence_date}</b> ${i.title}
        <span class="muted">${i.local_display}${i.advisories.length ? ' · ⚠️' + i.advisories[0].reason : ''}</span>
      </li>`).join('') || '<li class="muted">本周暂无场次（取消场次不会重现）</li>';
    $('weekList').querySelectorAll('li[data-iid]').forEach(li =>
      li.addEventListener('click', () => openInstance(li.dataset.iid)));
  }

  async function loadClosures() {
    const list = await api.get('/api/closures');
    $('closureList').innerHTML = list.map(c => `
      <li class="warn-item">${c.reason}
        <span class="muted">${routeName(c.route_id)} · ${segmentName(c.segment_id)} · ${c.starts_utc.slice(0, 16).replace('T', ' ')}Z ~ ${c.ends_utc.slice(0, 16).replace('T', ' ')}Z</span>
      </li>`).join('') || '<li class="muted">暂无施工通告</li>';
  }
  const segmentName = id => {
    if (!id) return '全线';
    for (const r of state.routes) { const s = r.segments.find(x => x.id === id); if (s) return s.name; }
    return id;
  };

  async function loadCancellations() {
    const list = await api.get(`/api/cancellations?station_id=${state.stationId}`);
    $('cancelHistory').innerHTML = list.map(h => `
      <li class="cancel-item"><b>${h.occurrence_date}</b> ${h.title}
        <span class="muted">理由：${h.reason} · 海报 ${h.poster_url || '无'} · ${h.cancelled_utc.slice(0, 16).replace('T', ' ')}Z</span>
      </li>`).join('') || '<li class="muted">暂无取消记录</li>';
  }

  // ---------------- 月历渲染 ----------------
  function renderGrid() {
    const { year, month } = state;
    const first = new Date(Date.UTC(year, month - 1, 1));
    const startOffset = (first.getUTCDay() + 6) % 7; // 周一开头
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const byDate = {};
    for (const it of state.monthItems) (byDate[it.occurrence_date] = byDate[it.occurrence_date] || []).push(it);

    const todayStr = new Date().toISOString().slice(0, 10);
    let html = '';
    for (let i = 0; i < startOffset; i++) html += '<div class="cal-cell outside"></div>';
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${year}-${pad2(month)}-${pad2(d)}`;
      const items = (byDate[ds] || []).sort((a, b) => a.start_utc.localeCompare(b.start_utc));
      html += `<div class="cal-cell${ds === todayStr ? ' today' : ''}"><span class="day-num">${d}</span>`;
      for (const it of items) {
        const cls = it.status === 'cancelled' ? 'cancelled' : it.status === 'rescheduled' ? 'rescheduled' : it.source === 'exception' ? 'exception' : '';
        const warn = it.advisories.length ? '<span class="warn">⚠️</span>' : '';
        const mid = it.crosses_midnight ? '<span class="mid">🌙</span>' : '';
        const time = (state.viewerTz && it.viewer_display ? it.viewer_display : it.local_display).slice(11, 16);
        html += `<div class="evt ${cls}" data-iid="${it.id}" title="${it.title} ${it.status}${it.cancel_reason ? '：' + it.cancel_reason : ''}">${time} ${it.title}${warn}${mid}</div>`;
      }
      html += '</div>';
    }
    $('calGrid').innerHTML = html;
    $('calGrid').querySelectorAll('.evt').forEach(el =>
      el.addEventListener('click', () => openInstance(el.dataset.iid)));
  }

  function highlightSeasonTab() {
    const m = state.month;
    const season = m >= 3 && m <= 5 ? 'spring' : m >= 6 && m <= 8 ? 'summer' : m >= 9 && m <= 11 ? 'autumn' : 'winter';
    document.querySelectorAll('#seasonTabs button').forEach(b =>
      b.classList.toggle('active', b.dataset.season === season));
  }

  // ---------------- 实例详情 + 计算依据 ----------------
  async function openInstance(instanceId) {
    const tzq = state.viewerTz ? `?viewer_tz=${state.viewerTz}` : '';
    const data = await api.get(`/api/instances/${encodeURIComponent(instanceId)}/explain${tzq}`);
    if (data.error) return toast(data.error);
    state.currentInstance = data.instance;
    const i = data.instance;
    $('miTitle').textContent = `${i.title} · ${i.occurrence_date}`;
    $('miMeta').innerHTML = `
      <span>状态：<b>${{ scheduled: '正常', cancelled: '已取消', rescheduled: '已改期' }[i.status]}</b></span>
      <span>站点时间：<b>${i.local_display}</b></span>
      ${i.viewer_display ? `<span>您的时间：<b>${i.viewer_display}</b></span>` : ''}
      <span>UTC：<b>${i.start_utc.slice(11, 16)}–${i.end_utc.slice(11, 16)}Z</b></span>
      <span>来源：<b>${i.source === 'series' ? '循环系列' : '单次改期'}</b></span>
      ${i.cancel_reason ? `<span>理由：<b>${i.cancel_reason}</b></span>` : ''}`;
    $('miAdvisories').innerHTML = i.advisories.map(a =>
      `<div class="mi-advisory">⚠️ 施工提示：${a.reason}（${a.starts_utc.slice(0, 16).replace('T', ' ')}Z ~ ${a.ends_utc.slice(0, 16).replace('T', ' ')}Z，仅影响相交的本场）</div>`).join('');
    $('miSteps').innerHTML = data.steps.map(s => `<li>${s}</li>`).join('');
    $('miActions').style.display = i.status === 'scheduled' ? 'flex' : 'none';
    $('miCancelBtn').style.display = i.status === 'scheduled' ? '' : 'none';
    $('miRescheduleBtn').style.display = i.status === 'scheduled' ? '' : 'none';
    $('instanceModal').classList.add('open');
  }

  async function submitException(kind) {
    const inst = state.currentInstance;
    const reason = $('miReason').value.trim();
    if (!reason) return toast('请填写理由（可追溯）');
    const body = { occurrence_date: inst.occurrence_date, kind, reason };
    if (kind === 'reschedule') {
      const v = $('miNewStart').value;
      if (!v) return toast('请选择改期新时间（站点当地时间）');
      body.new_start_utc = v + ':00'; // datetime-local 按站点当地理解，服务端换算
      // 前端按站点时区换算为 UTC 再提交
      body.new_start_utc = await localToUtc(body.new_start_utc);
    }
    const r = await api.post(`/api/templates/${inst.template_id}/exceptions`, body);
    if (r.error) return toast(r.error);
    toast(kind === 'cancel' ? '已取消本场（系列其余场次不受影响）' : '已改期本场（与循环分开保存）');
    $('instanceModal').classList.remove('open');
    await Promise.all([loadMonth(), loadWeek(), loadCancellations()]);
  }

  // 站点当地墙钟 -> UTC（用 explain 返回的站点时区）
  async function localToUtc(localStr) {
    const tz = state.currentInstance.station_tz;
    // 与服务端同一算法：猜测-修正迭代
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const offsetAt = (ms) => {
      const p = {}; dtf.formatToParts(new Date(ms)).forEach(x => { if (x.type !== 'literal') p[x.type] = x.value; });
      let h = +p.hour; if (h === 24) h = 0;
      return Date.UTC(+p.year, +p.month - 1, +p.day, h, +p.minute, +p.second) - ms;
    };
    const wall = Date.parse(localStr.replace('T', 'T') + 'Z'); // 当作 UTC 的墙钟
    let utc = wall - offsetAt(wall);
    for (let k = 0; k < 3; k++) { const n = wall - offsetAt(utc); if (n === utc) break; utc = n; }
    return new Date(utc).toISOString();
  }

  // ---------------- 模板表单 ----------------
  function fillTemplateForm(id) {
    const t = state.templates.find(x => x.id === id);
    if (!t) return;
    document.querySelectorAll('#templateList li').forEach(li => li.classList.toggle('active', li.dataset.id === id));
    $('tplFormTitle').textContent = `编辑系列：${t.title}（已结束场次不受影响）`;
    $('tplId').value = t.id;
    $('tplTitle').value = t.title;
    $('tplSeason').value = t.season;
    $('tplRoute').value = t.route_id || '';
    fillSegments(t.route_id, null, false);
    const m = t.rrule.match(/FREQ=(\w+)/);
    $('tplFreq').value = m ? m[1] : 'WEEKLY';
    const bd = t.rrule.match(/BYDAY=(\w+)/);
    if (bd) $('tplByday').value = bd[1];
    const bmd = t.rrule.match(/BYMONTHDAY=(\d+)/);
    if (bmd) $('tplBymonthday').value = bmd[1];
    const until = t.rrule.match(/UNTIL=(\d{8})/);
    $('tplUntil').value = until ? `${until[1].slice(0, 4)}-${until[1].slice(4, 6)}-${until[1].slice(6, 8)}` : '';
    $('tplDtstart').value = t.dtstart_local.slice(0, 10);
    $('tplTime').value = t.dtstart_local.slice(11, 16);
    $('tplDuration').value = t.duration_min;
    $('tplPoster').value = t.poster_url || '';
    $('tplEditReason').value = '';
    toggleFreqFields();
    setTimeout(() => {
      document.querySelectorAll('.tpl-seg').forEach(cb => { cb.checked = (t.segment_ids || []).includes(cb.value); });
    }, 0);
  }

  function resetTemplateForm() {
    $('tplFormTitle').textContent = '新建循环活动';
    $('tplId').value = '';
    $('templateForm').reset();
    document.querySelectorAll('#templateList li').forEach(li => li.classList.remove('active'));
    toggleFreqFields();
  }

  function toggleFreqFields() {
    const f = $('tplFreq').value;
    $('bydayWrap').style.display = f === 'WEEKLY' ? '' : 'none';
    $('bymonthdayWrap').style.display = f === 'MONTHLY' ? '' : 'none';
  }

  function buildRrule() {
    const f = $('tplFreq').value;
    const until = $('tplUntil').value.replace(/-/g, '');
    let r = `FREQ=${f}`;
    if (f === 'WEEKLY') r += `;BYDAY=${$('tplByday').value}`;
    if (f === 'MONTHLY') r += `;BYMONTHDAY=${$('tplBymonthday').value}`;
    if (until) r += `;UNTIL=${until}`;
    return r;
  }

  async function submitTemplate(e) {
    e.preventDefault();
    const segs = [...document.querySelectorAll('.tpl-seg:checked')].map(cb => cb.value);
    const body = {
      station_id: state.stationId,
      route_id: $('tplRoute').value || null,
      title: $('tplTitle').value.trim(),
      season: $('tplSeason').value,
      poster_url: $('tplPoster').value.trim(),
      rrule: buildRrule(),
      dtstart_local: `${$('tplDtstart').value}T${$('tplTime').value}:00`,
      duration_min: +$('tplDuration').value,
      segment_ids: segs,
      edit_reason: $('tplEditReason').value.trim() || '日历页编辑',
    };
    const id = $('tplId').value;
    const r = id ? await api.put(`/api/templates/${id}`, body) : await api.post('/api/templates', body);
    if (r.error) return toast(r.error);
    toast(id ? '系列已更新：未来场次重新生成，已结束与已取消场次保持原样' : '已创建循环活动');
    resetTemplateForm();
    await Promise.all([loadTemplates(), loadMonth(), loadWeek(), loadCancellations()]);
  }

  // ---------------- 施工通告 ----------------
  async function submitClosure(e) {
    e.preventDefault();
    const tz = (state.stations.find(s => s.id === state.stationId) || {}).tz || 'Asia/Shanghai';
    const toUtc = (v) => {
      const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const off = ms => { const p = {}; dtf.formatToParts(new Date(ms)).forEach(x => { if (x.type !== 'literal') p[x.type] = x.value; }); let h = +p.hour; if (h === 24) h = 0; return Date.UTC(+p.year, +p.month - 1, +p.day, h, +p.minute, +p.second) - ms; };
      const wall = Date.parse(v + ':00Z');
      let utc = wall - off(wall);
      for (let k = 0; k < 3; k++) { const n = wall - off(utc); if (n === utc) break; utc = n; }
      return new Date(utc).toISOString();
    };
    const body = {
      route_id: $('closureRoute').value,
      segment_id: $('closureSegment').value || null,
      starts_utc: toUtc($('closureStart').value),
      ends_utc: toUtc($('closureEnd').value),
      reason: $('closureReason').value.trim(),
    };
    const r = await api.post('/api/closures', body);
    if (r.error) return toast(r.error);
    toast('施工通告已发布：仅作用于相交路段与相交时间的场次');
    $('closureForm').reset();
    await Promise.all([loadClosures(), loadMonth(), loadWeek()]);
  }

  // ---------------- 事件绑定 ----------------
  function bind() {
    $('stationSelect').addEventListener('change', e => { state.stationId = e.target.value; loadBase(); });
    $('viewerTzSelect').addEventListener('change', e => { state.viewerTz = e.target.value; Promise.all([loadMonth(), loadWeek()]); });
    $('prevMonth').addEventListener('click', () => { shiftMonth(-1); });
    $('nextMonth').addEventListener('click', () => { shiftMonth(1); });
    $('todayBtn').addEventListener('click', () => { const n = new Date(); state.year = n.getFullYear(); state.month = n.getMonth() + 1; loadMonth(); });
    $('seasonTabs').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      state.month = SEASON_MONTH[b.dataset.season]; // 跳到该季节起始月（冬季=12月）
      loadMonth();
    });
    $('tplFreq').addEventListener('change', toggleFreqFields);
    $('tplRoute').addEventListener('change', e => fillSegments(e.target.value, null, false));
    $('closureRoute').addEventListener('change', e => fillSegments(e.target.value, $('closureSegment'), true));
    $('templateForm').addEventListener('submit', submitTemplate);
    $('tplReset').addEventListener('click', resetTemplateForm);
    $('closureForm').addEventListener('submit', submitClosure);
    $('modalClose').addEventListener('click', () => $('instanceModal').classList.remove('open'));
    $('instanceModal').addEventListener('click', e => { if (e.target === $('instanceModal')) $('instanceModal').classList.remove('open'); });
    $('miCancelBtn').addEventListener('click', () => submitException('cancel'));
    $('miRescheduleBtn').addEventListener('click', () => submitException('reschedule'));
  }

  function shiftMonth(delta) {
    state.month += delta;
    if (state.month > 12) { state.month = 1; state.year++; }
    if (state.month < 1) { state.month = 12; state.year--; }
    loadMonth();
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!$('calGrid')) return;
    bind();
    toggleFreqFields();
    loadBase().catch(e => toast('无法连接年历服务：请先启动 server（npm start）'));
  });
})();
