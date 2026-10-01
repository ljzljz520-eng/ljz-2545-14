'use strict';
/** HTTP 集成测试：真实启动服务，走完整 API 流程 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.DB_FILE = ':memory:';
const { server, db } = require(path.join('..', 'server', 'index.js'));

let base;
before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const j = r => r.json();
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(j);
const put = (p, body) => fetch(base + p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(j);
const get = p => fetch(base + p).then(j);

test('HTTP 全流程：建模板→取消→改期→日历/推荐/解释/历史一致', async () => {
  // 1. 创建模板（每周六 07:00，关联路线与路段）
  const { id: tpl } = await post('/api/templates', {
    station_id: 'st-binjiang', route_id: 'rt-riverside', title: '测试晨骑',
    season: '2026-autumn', poster_url: 'p1.png',
    rrule: 'FREQ=WEEKLY;BYDAY=SA;UNTIL=20261231', dtstart_local: '2026-10-03T07:00:00',
    duration_min: 120, segment_ids: ['seg-a', 'seg-b'], edit_reason: '集成测试',
  });
  assert.ok(tpl.startsWith('tpl_'));

  // 2. 日历应包含 10 月所有周六
  let cal = await get('/api/calendar?station_id=st-binjiang&from=2026-10-01&to=2026-11-01');
  const sat = cal.filter(i => i.template_id === tpl).map(i => i.occurrence_date);
  assert.deepEqual(sat, ['2026-10-03', '2026-10-10', '2026-10-17', '2026-10-24', '2026-10-31']);

  // 3. 取消 10-17 → 日历状态变化 + 历史可追溯
  await post(`/api/templates/${tpl}/exceptions`, { occurrence_date: '2026-10-17', kind: 'cancel', reason: '台风' });
  cal = await get('/api/calendar?station_id=st-binjiang&from=2026-10-01&to=2026-11-01');
  assert.equal(cal.find(i => i.occurrence_date === '2026-10-17' && i.template_id === tpl).status, 'cancelled');
  const his = await get('/api/cancellations?station_id=st-binjiang');
  assert.ok(his.some(h => h.reason === '台风' && h.occurrence_date === '2026-10-17'));

  // 4. 本周推荐不出现取消场次
  const wk = await get('/api/recommendations/week?station_id=st-binjiang&ref=2026-10-15T00:00:00Z');
  assert.ok(!wk.items.some(i => i.occurrence_date === '2026-10-17' && i.template_id === tpl));

  // 5. 改期 10-24 → 10-25 15:00（上海）= 07:00Z
  await post(`/api/templates/${tpl}/exceptions`, {
    occurrence_date: '2026-10-24', kind: 'reschedule',
    new_start_utc: '2026-10-25T07:00:00.000Z', reason: '马拉松封路',
  });
  cal = await get('/api/calendar?station_id=st-binjiang&from=2026-10-20&to=2026-10-28');
  const mine = cal.filter(i => i.template_id === tpl);
  assert.ok(mine.some(i => i.occurrence_date === '2026-10-24' && i.status === 'rescheduled'));
  assert.ok(mine.some(i => i.occurrence_date === '2026-10-25' && i.source === 'exception' && i.status === 'scheduled'));

  // 6. 解释接口给出计算依据
  const ex = await get(`/api/instances/${encodeURIComponent(`ser:${tpl}:2026-10-31`)}/explain`);
  assert.ok(ex.steps.some(s => s.includes('FREQ=WEEKLY')));
  assert.ok(ex.steps.some(s => s.includes('Asia/Shanghai')));

  // 7. 修改系列（时长 120→90）→ 未来场次更新，取消场次不复活
  await put(`/api/templates/${tpl}`, { duration_min: 90, edit_reason: '缩短时长' });
  cal = await get('/api/calendar?station_id=st-binjiang&from=2026-10-26&to=2026-11-08');
  const nov = cal.filter(i => i.template_id === tpl && i.status === 'scheduled');
  assert.ok(nov.length > 0);
  for (const i of nov) {
    assert.equal(Date.parse(i.end_utc) - Date.parse(i.start_utc), 90 * 60000);
  }
  const still = await get('/api/calendar?station_id=st-binjiang&from=2026-10-15&to=2026-10-20');
  assert.equal(still.find(i => i.occurrence_date === '2026-10-17' && i.template_id === tpl).status, 'cancelled');

  // 8. 浏览者时区仅影响展示
  const tzCal = await get('/api/calendar?station_id=st-binjiang&from=2026-10-31&to=2026-11-02&viewer_tz=America/New_York');
  const one = tzCal.find(i => i.template_id === tpl && i.occurrence_date === '2026-10-31');
  assert.ok(one.viewer_display && one.viewer_display !== one.local_display);
  assert.equal(one.start_utc, '2026-10-30T23:00:00.000Z', '存储瞬间不因浏览者时区改变');
});

test('HTTP：施工通告只命中相交场次', async () => {
  // 种子数据：周末晨骑经过 seg-a/seg-b；施工在 seg-b 10-10 上午
  const cal = await get('/api/calendar?station_id=st-binjiang&from=2026-10-01&to=2026-11-01');
  const rides = cal.filter(i => i.title === '周末晨骑');
  const withAdv = rides.filter(i => i.advisories.length > 0).map(i => i.occurrence_date);
  assert.deepEqual(withAdv, ['2026-10-10'], '只有相交的那一场带施工提示');
  assert.ok(rides.every(i => i.status === 'scheduled'), '施工不取消任何场次');
});
