'use strict';
/**
 * 城市慢行站 · 季节年历 测试套件
 * 覆盖：月底越界 / 跨年 / 幂等生成 / 取消后模板更新 / 缓存迟到 /
 *       本周推荐不重现取消 / 历史海报与理由可追溯 / 计算依据可解释 /
 *       跨午夜 / 时区按活动所在地 / 施工相交判定 / 系列修改不覆盖已结束实例
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { openDb } = require(path.join('..', 'server', 'db'));
const svc = require(path.join('..', 'server', 'service'));
const tz = require(path.join('..', 'server', 'tz'));
const { expandRrule } = require(path.join('..', 'server', 'rrule'));

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 1, 0, 0, 0); // 2026-10-01T00:00:00Z 固定“当前”

function fixtures() {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO stations (id, name, tz) VALUES (?,?,?)').run('st1', '滨江慢行站', 'Asia/Shanghai');
  db.prepare('INSERT INTO stations (id, name, tz) VALUES (?,?,?)').run('st2', '河畔站', 'America/New_York');
  db.prepare('INSERT INTO routes (id, station_id, name) VALUES (?,?,?)').run('rt1', 'st1', '滨江绿道');
  const seg = db.prepare('INSERT INTO route_segments (id, route_id, seq, name) VALUES (?,?,?,?)');
  seg.run('segA', 'rt1', 1, '观澜段');
  seg.run('segB', 'rt1', 2, '听涛段');
  seg.run('segC', 'rt1', 3, '望海段');
  return db;
}
const allInst = (db, tpl) =>
  db.prepare('SELECT * FROM activity_instances WHERE template_id=? ORDER BY start_utc').all(tpl);
const dates = rows => rows.map(r => r.occurrence_date);
const edates = rows => rows.map(r => r.date); // expandRrule 返回 {date,...}

// ---------------------------------------------------------------- 月底越界
test('月底越界：每月31日，2月/4月等无31日的月份跳过，不夹取不顺延', () => {
  const occ = expandRrule({
    rrule: 'FREQ=MONTHLY;BYMONTHDAY=31', dtstartLocal: '2026-01-31T10:00:00',
    durationMin: 60, tz: 'Asia/Shanghai', windowStartMs: 0, windowEndMs: Date.UTC(2027, 0, 1),
  });
  assert.deepEqual(edates(occ), [
    '2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31',
    '2026-08-31', '2026-10-31', '2026-12-31',
  ]);
  assert.ok(!edates(occ).some(d => d.includes('02-')), '2 月不产生任何场次');
});

test('月底越界：闰年2月29日序列，平年跳过', () => {
  const occ = expandRrule({
    rrule: 'FREQ=MONTHLY;BYMONTHDAY=29', dtstartLocal: '2024-01-29T08:00:00',
    durationMin: 30, tz: 'Asia/Shanghai', windowStartMs: 0, windowEndMs: Date.UTC(2026, 0, 1),
  });
  const ds = edates(occ);
  assert.ok(ds.includes('2024-02-29'), '闰年 2 月 29 日正常');
  assert.ok(!ds.includes('2025-02-29') && !ds.some(d => d.startsWith('2025-02')), '平年 2 月整体跳过');
});

// ---------------------------------------------------------------- 跨年
test('跨年：每周六序列平滑跨越 2026→2027，星期不漂移', () => {
  const occ = expandRrule({
    rrule: 'FREQ=WEEKLY;BYDAY=SA', dtstartLocal: '2026-12-19T07:00:00',
    durationMin: 120, tz: 'Asia/Shanghai', windowStartMs: 0, windowEndMs: Date.UTC(2027, 0, 20),
  });
  assert.deepEqual(edates(occ), ['2026-12-19', '2026-12-26', '2027-01-02', '2027-01-09', '2027-01-16']);
  for (const o of occ) assert.equal(tz.weekday(tz.parseDate(o.date)), 6, '都是周六');
});

test('跨年：UNTIL 落在次年，边界当日包含、次日不含', () => {
  const occ = expandRrule({
    rrule: 'FREQ=DAILY;UNTIL=20270102', dtstartLocal: '2026-12-30T09:00:00',
    durationMin: 30, tz: 'Asia/Shanghai', windowStartMs: 0, windowEndMs: Date.UTC(2027, 6, 1),
  });
  assert.deepEqual(edates(occ), ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
});

// ---------------------------------------------------------------- 幂等生成（重复实例任务）
test('重复实例任务：多次 regenerate 结果完全一致（幂等），取消历史不重复', () => {
  const db = fixtures();
  const tpl = svc.createTemplate(db, {
    station_id: 'st1', route_id: 'rt1', title: '周末晨骑', season: '2026-autumn',
    poster_url: 'p1.png', rrule: 'FREQ=WEEKLY;BYDAY=SA;UNTIL=20261231',
    dtstart_local: '2026-10-03T07:00:00', duration_min: 120, segment_ids: ['segA'],
  }, NOW);
  svc.addException(db, { templateId: tpl, occurrenceDate: '2026-10-10', kind: 'cancel', reason: '暴雨橙色预警' }, NOW);

  const snap1 = allInst(db, tpl);
  svc.regenerate(db, tpl, NOW);          // 模拟任务重复执行
  svc.regenerate(db, tpl, NOW + DAY);    // 跨天再执行
  const snap2 = allInst(db, tpl);
  assert.deepEqual(snap2, snap1, '重复生成不得改变任何行');
  const ids = snap2.map(r => r.id);
  assert.equal(new Set(ids).size, ids.length, '无重复实例');
  const his = db.prepare('SELECT * FROM cancellation_history').all();
  assert.equal(his.length, 1, '取消历史只记一次');
});

// ---------------------------------------------------------------- 某次取消后模板更新（例外优先）
test('某次取消后模板更新：取消不被覆盖，未来场次跟随新模板', () => {
  const db = fixtures();
  const tpl = svc.createTemplate(db, {
    station_id: 'st1', route_id: 'rt1', title: '周末晨骑', season: '2026-autumn',
    poster_url: 'p1.png', rrule: 'FREQ=WEEKLY;BYDAY=SA;UNTIL=20261231',
    dtstart_local: '2026-10-03T07:00:00', duration_min: 120, segment_ids: ['segA'],
  }, NOW);
  svc.addException(db, { templateId: tpl, occurrenceDate: '2026-10-17', kind: 'cancel', reason: '台风' }, NOW);
  // 更新系列：换海报、改时长 90 分钟、改标题
  svc.updateTemplate(db, tpl, { title: '周末晨骑·精简版', poster_url: 'p2.png', duration_min: 90 }, '天气转凉缩短时长', NOW);

  const rows = allInst(db, tpl);
  const cancelled = rows.find(r => r.occurrence_date === '2026-10-17');
  assert.equal(cancelled.status, 'cancelled', '取消场次不得被系列更新复活');
  assert.equal(cancelled.cancel_reason, '台风');
  assert.equal(cancelled.poster_url, 'p1.png', '取消时海报快照保留');

  const future = rows.filter(r => r.status === 'scheduled');
  assert.ok(future.length > 0);
  for (const f of future) {
    assert.equal(f.poster_url, 'p2.png', '未来场次应用新海报');
    assert.equal(Date.parse(f.end_utc) - Date.parse(f.start_utc), 90 * 60000, '未来场次应用新时长');
  }
  const his = db.prepare('SELECT * FROM cancellation_history').all();
  assert.equal(his.length, 1);
  assert.equal(his[0].reason, '台风', '取消理由可追溯');
  assert.equal(his[0].poster_url, 'p1.png', '历史海报可追溯');
});

// ---------------------------------------------------------------- 改系列不覆盖已结束实例
test('改系列不覆盖已经结束实例：历史行保持原时间原海报', () => {
  const db = fixtures();
  const tpl = svc.createTemplate(db, {
    station_id: 'st1', route_id: 'rt1', title: '晨骑', season: '2026-autumn',
    poster_url: 'old.png', rrule: 'FREQ=WEEKLY;BYDAY=SA;UNTIL=20261231',
    dtstart_local: '2026-09-05T07:00:00', duration_min: 120, segment_ids: ['segA'],
  }, NOW);
  const before = allInst(db, tpl).find(r => r.occurrence_date === '2026-09-05');
  assert.ok(Date.parse(before.end_utc) < NOW, '该场已结束');

  svc.updateTemplate(db, tpl, { poster_url: 'new.png', duration_min: 45, title: '晨骑·新版' }, '改版', NOW);
  const after = allInst(db, tpl).find(r => r.occurrence_date === '2026-09-05');
  assert.deepEqual(after, before, '已结束实例一字不改');
  assert.equal(after.poster_url, 'old.png', '历史海报快照不被覆盖');
});

// ---------------------------------------------------------------- 缓存迟到
test('缓存迟到：取消操作后立刻读日历，缓存不得返回过期数据', () => {
  const db = fixtures();
  const tpl = svc.createTemplate(db, {
    station_id: 'st1', route_id: 'rt1', title: '晨骑', season: '2026-autumn',
    poster_url: 'p.png', rrule: 'FREQ=WEEKLY;BYDAY=SA;UNTIL=20261130',
    dtstart_local: '2026-10-03T07:00:00', duration_min: 120, segment_ids: ['segA'],
  }, NOW);
  const from = Date.UTC(2026, 9, 1), to = Date.UTC(2026, 10, 1);
  const cal1 = svc.calendarRange(db, 'st1', from, to);           // 填充缓存
  assert.ok(cal1.some(i => i.occurrence_date === '2026-10-10' && i.status === 'scheduled'));

  svc.addException(db, { templateId: tpl, occurrenceDate: '2026-10-10', kind: 'cancel', reason: '路面湿滑' }, NOW);
  const cal2 = svc.calendarRange(db, 'st1', from, to);           // 同参数再读
  const hit = cal2.find(i => i.occurrence_date === '2026-10-10');
  assert.equal(hit.status, 'cancelled', '写后读必须立刻反映取消（缓存按数据版本失效）');
  assert.notDeepEqual(cal2, cal1);
});

// ---------------------------------------------------------------- 本周推荐不重现取消场次
test('本周推荐不会重现取消场次（含重新生成之后）', () => {
  const db = fixtures();
  const tpl = svc.createTemplate(db, {
    station_id: 'st1', route_id: 'rt1', title: '晨骑', season: '2026-autumn',
    poster_url: 'p.png', rrule: 'FREQ=WEEKLY;BYDAY=SA;UNTIL=20261231',
    dtstart_local: '2026-10-03T07:00:00', duration_min: 120, segment_ids: ['segA'],
  }, NOW);
  const refMs = Date.UTC(2026, 9, 8); // 周四，本周六 = 2026-10-10
  let wk = svc.weeklyRecommendations(db, 'st1', refMs);
  assert.deepEqual(wk.items.map(i => i.occurrence_date), ['2026-10-10']);

  svc.addException(db, { templateId: tpl, occurrenceDate: '2026-10-10', kind: 'cancel', reason: '赛事管制' }, NOW);
  svc.regenerate(db, tpl, NOW); // 即使任务再跑一遍
  wk = svc.weeklyRecommendations(db, 'st1', refMs);
  assert.equal(wk.items.length, 0, '取消场次不得在本周推荐重现');
});

// ---------------------------------------------------------------- 临时改期与循环分开
test('临时改期：原场次标记 rescheduled，新场次为独立实例，系列其余场次不受影响', () => {
  const db = fixtures();
  const tpl = svc.createTemplate(db, {
    station_id: 'st1', route_id: 'rt1', title: '晨骑', season: '2026-autumn',
    poster_url: 'p.png', rrule: 'FREQ=WEEKLY;BYDAY=SA;UNTIL=20261130',
    dtstart_local: '2026-10-03T07:00:00', duration_min: 120, segment_ids: ['segA'],
  }, NOW);
  const newStart = tz.zonedLocalToUtcMs('Asia/Shanghai', 2026, 10, 11, 15, 0); // 改到周日下午
  svc.addException(db, { templateId: tpl, occurrenceDate: '2026-10-10', kind: 'reschedule', newStartUtc: tz.iso(newStart), reason: '上午马拉松封路' }, NOW);

  const rows = allInst(db, tpl);
  const base = rows.find(r => r.occurrence_date === '2026-10-10' && r.source === 'series');
  const moved = rows.find(r => r.source === 'exception');
  assert.equal(base.status, 'rescheduled');
  assert.equal(moved.status, 'scheduled');
  assert.equal(moved.occurrence_date, '2026-10-11', '新场次按活动所在地计算本地日期');
  assert.equal(moved.start_utc, tz.iso(newStart));
  assert.ok(rows.some(r => r.occurrence_date === '2026-10-17' && r.status === 'scheduled'), '下周场次不受影响');
  // 幂等：再生成不重复改期实例
  svc.regenerate(db, tpl, NOW);
  assert.equal(allInst(db, tpl).filter(r => r.source === 'exception').length, 1);
});

// ---------------------------------------------------------------- 跨午夜
test('跨午夜：22:30 开始 3 小时，结束在次日，场次归属开始日', () => {
  const db = fixtures();
  const tpl = svc.createTemplate(db, {
    station_id: 'st1', route_id: 'rt1', title: '夜骑', season: '2026-autumn',
    poster_url: 'p.png', rrule: 'FREQ=WEEKLY;BYDAY=FR;COUNT=2',
    dtstart_local: '2026-10-02T22:30:00', duration_min: 180, segment_ids: ['segA'],
  }, NOW);
  const rows = allInst(db, tpl);
  assert.equal(rows.length, 2);
  const r0 = rows[0];
  assert.equal(r0.occurrence_date, '2026-10-02', '归属开始日');
  assert.equal(r0.start_utc, '2026-10-02T14:30:00.000Z', '上海 22:30 = UTC 14:30');
  assert.equal(r0.end_utc, '2026-10-02T17:30:00.000Z', 'UTC 层面 +3h');
  assert.equal(tz.localDateOf('Asia/Shanghai', Date.parse(r0.end_utc)), '2026-10-03', '本地已跨到次日 01:30');
  const dto = svc.instanceDto(db, svc.getTemplate(db, tpl), r0, null);
  assert.equal(dto.crosses_midnight, true);
});

// ---------------------------------------------------------------- 时区按活动所在地
test('时区转换按活动所在地：纽约站每周 09:00 跨 DST，本地时刻不变、UTC 偏移变化', () => {
  const db = fixtures();
  const tpl = svc.createTemplate(db, {
    station_id: 'st2', route_id: null, title: '河畔晨走', season: '2026-spring',
    poster_url: 'p.png', rrule: 'FREQ=WEEKLY;BYDAY=SU;COUNT=4',
    dtstart_local: '2026-03-01T09:00:00', duration_min: 60,
  }, Date.UTC(2026, 1, 1));
  const rows = allInst(db, tpl);
  // 2026-03-08 02:00 美国进入夏令时
  assert.equal(rows[0].start_utc, '2026-03-01T14:00:00.000Z', 'DST 前 EST(-5)');
  assert.equal(rows[1].start_utc, '2026-03-08T13:00:00.000Z', 'DST 后 EDT(-4)');
  for (const r of rows) {
    assert.equal(tz.formatInTz('America/New_York', Date.parse(r.start_utc)).slice(11), '09:00', '本地始终 09:00');
  }
  // 浏览者时区只影响展示
  const dto = svc.instanceDto(db, svc.getTemplate(db, tpl), rows[1], 'Asia/Shanghai');
  assert.ok(dto.viewer_display.includes('21:00'), '上海浏览者看到 21:00，但存储瞬间不变');
  assert.equal(dto.start_utc, rows[1].start_utc);
});

// ---------------------------------------------------------------- 施工相交判定
test('施工提示仅作用于相交路段与相交时间，同月施工不取消整季', () => {
  const db = fixtures();
  const tpl = svc.createTemplate(db, {
    station_id: 'st1', route_id: 'rt1', title: '晨骑', season: '2026-autumn',
    poster_url: 'p.png', rrule: 'FREQ=WEEKLY;BYDAY=SA;UNTIL=20261231',
    dtstart_local: '2026-10-03T07:00:00', duration_min: 120, segment_ids: ['segA', 'segB'],
  }, NOW);
  // 施工1：segB，仅 10-10 06:00~12:00（上海）—— 与 10-10 场次相交
  svc.createClosure(db, {
    route_id: 'rt1', segment_id: 'segB',
    starts_utc: tz.iso(tz.zonedLocalToUtcMs('Asia/Shanghai', 2026, 10, 10, 6, 0)),
    ends_utc: tz.iso(tz.zonedLocalToUtcMs('Asia/Shanghai', 2026, 10, 10, 12, 0)),
    reason: '栈道检修',
  }, NOW);
  // 施工2：segC（活动不经过），时间重叠 —— 不应命中
  svc.createClosure(db, {
    route_id: 'rt1', segment_id: 'segC',
    starts_utc: tz.iso(tz.zonedLocalToUtcMs('Asia/Shanghai', 2026, 10, 17, 6, 0)),
    ends_utc: tz.iso(tz.zonedLocalToUtcMs('Asia/Shanghai', 2026, 10, 17, 12, 0)),
    reason: '望海段绿化',
  }, NOW);
  // 施工3：segA 但时间在 11 月 —— 只影响 11 月相交场
  svc.createClosure(db, {
    route_id: 'rt1', segment_id: 'segA',
    starts_utc: tz.iso(tz.zonedLocalToUtcMs('Asia/Shanghai', 2026, 11, 7, 6, 0)),
    ends_utc: tz.iso(tz.zonedLocalToUtcMs('Asia/Shanghai', 2026, 11, 7, 12, 0)),
    reason: '观澜段铺装的',
  }, NOW);

  const rows = allInst(db, tpl);
  const tplRow = svc.getTemplate(db, tpl);
  const advOf = r => svc.closuresForInstance(db, tplRow, r).map(c => c.reason);
  const byDate = Object.fromEntries(rows.map(r => [r.occurrence_date, r]));

  assert.deepEqual(advOf(byDate['2026-10-10']), ['栈道检修'], '相交路段×相交时间 → 命中');
  assert.deepEqual(advOf(byDate['2026-10-17']), [], '不相交路段 → 不命中');
  assert.deepEqual(advOf(byDate['2026-10-03']), [], '同月其他场次不受影响');
  assert.deepEqual(advOf(byDate['2026-11-07']), ['观澜段铺装的'], '11 月相交场命中');
  assert.ok(rows.every(r => r.status === 'scheduled'), '施工只打提示，绝不自动取消整季');
});

// ---------------------------------------------------------------- 计算依据可解释
test('计算依据：explain 给出规则、序号、时区换算与例外信息', () => {
  const db = fixtures();
  const tpl = svc.createTemplate(db, {
    station_id: 'st1', route_id: 'rt1', title: '晨骑', season: '2026-autumn',
    poster_url: 'p.png', rrule: 'FREQ=WEEKLY;BYDAY=SA;UNTIL=20261231',
    dtstart_local: '2026-10-03T07:00:00', duration_min: 120, segment_ids: ['segA'],
  }, NOW);
  svc.addException(db, { templateId: tpl, occurrenceDate: '2026-10-10', kind: 'cancel', reason: '台风' }, NOW);

  const normal = svc.explainInstance(db, `ser:${tpl}:2026-10-17`, 'Asia/Shanghai');
  assert.ok(normal.steps.some(s => s.includes('FREQ=WEEKLY')), '包含规则');
  assert.ok(normal.steps.some(s => s.includes('第 3 场')), '包含场次序号');
  assert.ok(normal.steps.some(s => s.includes('Asia/Shanghai')), '包含时区依据');

  const cancelled = svc.explainInstance(db, `ser:${tpl}:2026-10-10`);
  assert.ok(cancelled.steps.some(s => s.includes('台风')), '取消理由进入解释');
  assert.equal(cancelled.instance.status, 'cancelled');
});

// ---------------------------------------------------------------- 历史海报与理由可追溯
test('历史海报与理由可追溯：取消历史 + 模板修订审计', () => {
  const db = fixtures();
  const tpl = svc.createTemplate(db, {
    station_id: 'st1', route_id: 'rt1', title: '晨骑', season: '2026-autumn',
    poster_url: 'v1.png', rrule: 'FREQ=WEEKLY;BYDAY=SA;UNTIL=20261130',
    dtstart_local: '2026-10-03T07:00:00', duration_min: 120, segment_ids: ['segA'],
  }, NOW);
  svc.addException(db, { templateId: tpl, occurrenceDate: '2026-10-10', kind: 'cancel', reason: '空气重污染' }, NOW);
  svc.updateTemplate(db, tpl, { poster_url: 'v2.png' }, '换新海报', NOW);

  const his = svc.cancellationHistory(db, 'st1');
  assert.equal(his.length, 1);
  assert.equal(his[0].reason, '空气重污染');
  assert.equal(his[0].poster_url, 'v1.png', '取消时的海报快照可查');

  const revs = db.prepare('SELECT * FROM template_revisions WHERE template_id=? ORDER BY edited_utc').all(tpl);
  assert.ok(revs.length >= 2, '创建与修改均留审计');
  assert.ok(revs.some(r => r.edit_reason === '换新海报'));
  const snap = JSON.parse(revs[revs.length - 1].snapshot_json);
  assert.equal(snap.poster_url, 'v1.png', '修订前旧值可追溯');
});

// ---------------------------------------------------------------- COUNT/UNTIL 有界
test('有界展开：COUNT 限制总场次，窗口限制返回范围', () => {
  const occ = expandRrule({
    rrule: 'FREQ=DAILY;COUNT=5', dtstartLocal: '2026-01-01T09:00:00',
    durationMin: 30, tz: 'Asia/Shanghai', windowStartMs: 0, windowEndMs: Date.UTC(2030, 0, 1),
  });
  assert.equal(occ.length, 5);
  const win = expandRrule({
    rrule: 'FREQ=DAILY', dtstartLocal: '2026-01-01T09:00:00',
    durationMin: 30, tz: 'Asia/Shanghai',
    windowStartMs: Date.UTC(2026, 0, 10), windowEndMs: Date.UTC(2026, 0, 13),
  });
  assert.deepEqual(edates(win), ['2026-01-10', '2026-01-11', '2026-01-12']);
});

// ---------------------------------------------------------------- 例外日期校验
test('例外日期必须属于系列：对错乱日期加例外返回 400', () => {
  const db = fixtures();
  const tpl = svc.createTemplate(db, {
    station_id: 'st1', route_id: 'rt1', title: '晨骑', season: '2026-autumn',
    poster_url: 'p.png', rrule: 'FREQ=WEEKLY;BYDAY=SA;UNTIL=20261231',
    dtstart_local: '2026-10-03T07:00:00', duration_min: 120, segment_ids: ['segA'],
  }, NOW);
  assert.throws(
    () => svc.addException(db, { templateId: tpl, occurrenceDate: '2026-10-18', kind: 'cancel', reason: 'x' }, NOW),
    /不是该系列的有效场次日期/,
    '周日不是该周六系列的场次'
  );
  // 合法日期不受影响
  const id = svc.addException(db, { templateId: tpl, occurrenceDate: '2026-10-24', kind: 'cancel', reason: 'ok' }, NOW);
  assert.ok(id.startsWith('exc_'));
});
