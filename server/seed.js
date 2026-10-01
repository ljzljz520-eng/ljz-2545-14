'use strict';
/** 演示数据：仅当库为空时写入 */
const svc = require('./service');

function seedIfEmpty(db) {
  const has = db.prepare('SELECT COUNT(*) n FROM stations').get().n > 0;
  if (has) return;
  const now = Date.now();
  const iso = ms => new Date(ms).toISOString();
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO stations (id, name, tz) VALUES (?,?,?)')
      .run('st-binjiang', '滨江慢行站', 'Asia/Shanghai');
    db.prepare('INSERT INTO stations (id, name, tz) VALUES (?,?,?)')
      .run('st-hudson', '哈德逊河畔站', 'America/New_York');

    db.prepare('INSERT INTO routes (id, station_id, name) VALUES (?,?,?)')
      .run('rt-riverside', 'st-binjiang', '滨江绿道');
    const seg = db.prepare('INSERT INTO route_segments (id, route_id, seq, name) VALUES (?,?,?,?)');
    seg.run('seg-a', 'rt-riverside', 1, '观澜段');
    seg.run('seg-b', 'rt-riverside', 2, '听涛段');
    seg.run('seg-c', 'rt-riverside', 3, '望海段');
    db.prepare('INSERT INTO routes (id, station_id, name) VALUES (?,?,?)')
      .run('rt-lake', 'st-binjiang', '山湖环线');
    seg.run('seg-d', 'rt-lake', 1, '栖霞段');
    seg.run('seg-e', 'rt-lake', 2, '望湖段');

    // 周末晨骑：每周六 07:00，2 小时，经过观澜/听涛段
    svc.createTemplate(db, {
      station_id: 'st-binjiang', route_id: 'rt-riverside',
      title: '周末晨骑', season: '2026-autumn', poster_url: '/posters/morning-ride.png',
      rrule: 'FREQ=WEEKLY;BYDAY=SA;UNTIL=20261231', dtstart_local: '2026-10-03T07:00:00',
      duration_min: 120, segment_ids: ['seg-a', 'seg-b'], edit_reason: '秋季排期',
    }, now);
    // 月中夜行：每月 15 日 21:30，3 小时（跨午夜）
    svc.createTemplate(db, {
      station_id: 'st-binjiang', route_id: 'rt-lake',
      title: '月中夜行', season: '2026-autumn', poster_url: '/posters/night-walk.png',
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=15;UNTIL=20270630', dtstart_local: '2026-10-15T21:30:00',
      duration_min: 180, segment_ids: ['seg-d', 'seg-e'], edit_reason: '常规排期',
    }, now);
    // 施工通告：听涛段，仅 10 月 10 日上午 —— 只影响相交的那一场
    svc.createClosure(db, {
      route_id: 'rt-riverside', segment_id: 'seg-b',
      starts_utc: iso(Date.UTC(2026, 9, 9, 22, 0)),  // 10-10 06:00 上海
      ends_utc: iso(Date.UTC(2026, 9, 10, 4, 0)),    // 10-10 12:00 上海
      reason: '听涛段栈道检修',
    }, now);
  });
  tx();
  console.log('已写入演示数据');
}

module.exports = { seedIfEmpty };
