'use strict';
/**
 * 业务核心：
 *  - 服务端有界展开 + 与预生成实例比较（diff），幂等生成；
 *  - 例外（取消/临时改期）与循环系列分开存放，例外优先；
 *  - 修改系列只影响未来场次，已结束实例永不覆盖；
 *  - 施工通告按“相交路段 × 相交时间”逐场判定；
 *  - 数据版本号驱动的缓存，写后立即可读（缓存不迟到）。
 */
const crypto = require('crypto');
const tz = require('./tz');
const { expandRrule } = require('./rrule');

const HORIZON_DAYS = 370;  // 未来展开窗口（有界）
const PAST_DAYS = 120;     // 过去保留窗口（历史可追溯，同时有界）
const DAY = tz.DAY_MS;

const iso = tz.iso;
const uuid = p => `${p}_${crypto.randomUUID()}`;

// ---------------------------------------------------------------- 版本与缓存
function getDataVersion(db) {
  const row = db.prepare("SELECT value FROM kv WHERE key = 'data_version'").get();
  return row ? Number(row.value) : 0;
}
function bumpDataVersion(db) {
  db.prepare(`INSERT INTO kv(key, value) VALUES ('data_version', '1')
              ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`).run();
}

const cache = new Map(); // key -> { version, payload }
function cached(key, db, producer) {
  const v = getDataVersion(db);
  const hit = cache.get(key);
  if (hit && hit.version === v) return hit.payload;
  const payload = producer();
  cache.set(key, { version: v, payload });
  return payload;
}
function cacheSize() { return cache.size; }

// ---------------------------------------------------------------- 查询辅助
const getTemplate = (db, id) =>
  db.prepare('SELECT * FROM activity_templates WHERE id = ?').get(id);
const getStation = (db, id) =>
  db.prepare('SELECT * FROM stations WHERE id = ?').get(id);

function templateSegments(db, templateId) {
  return db.prepare('SELECT segment_id FROM activity_template_segments WHERE template_id = ?')
    .all(templateId).map(r => r.segment_id);
}

/** 施工通告与实例的相交判定：同路线 AND 路段相交 AND 时间相交 */
function closuresForInstance(db, tpl, inst) {
  if (!tpl.route_id) return [];
  const segs = new Set(templateSegments(db, tpl.id));
  return db.prepare('SELECT * FROM closures WHERE route_id = ?').all(tpl.route_id)
    .filter(c =>
      (c.segment_id === null || segs.has(c.segment_id)) &&      // 路段相交（全线通告视为与所有段相交）
      c.starts_utc < inst.end_utc && c.ends_utc > inst.start_utc // 时间相交（严格区间重叠）
    )
    .map(c => ({ id: c.id, reason: c.reason, segment_id: c.segment_id,
                 starts_utc: c.starts_utc, ends_utc: c.ends_utc }));
}

// ---------------------------------------------------------------- 模板 CRUD
function createTemplate(db, input, nowMs) {
  const id = uuid('tpl');
  const nowIso = iso(nowMs);
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO activity_templates
      (id, station_id, route_id, title, season, poster_url, rrule, dtstart_local,
       duration_min, version, edit_reason, created_utc, updated_utc)
      VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?)`).run(
      id, input.station_id, input.route_id ?? null, input.title, input.season,
      input.poster_url ?? '', input.rrule, input.dtstart_local, input.duration_min,
      input.edit_reason ?? '创建', nowIso, nowIso);
    replaceSegments(db, id, input.segment_ids);
    snapshotRevision(db, id, '创建', nowMs);
    regenerate(db, id, nowMs);
    bumpDataVersion(db);
  });
  tx();
  return id;
}

function updateTemplate(db, id, patch, editReason, nowMs) {
  const tx = db.transaction(() => {
    const old = getTemplate(db, id);
    if (!old) throw Object.assign(new Error('模板不存在'), { status: 404 });
    snapshotRevision(db, id, editReason || '修改系列', nowMs); // 旧值入审计
    const next = { ...old, ...patch };
    db.prepare(`UPDATE activity_templates SET
        route_id=?, title=?, season=?, poster_url=?, rrule=?, dtstart_local=?,
        duration_min=?, version=version+1, edit_reason=?, updated_utc=?
      WHERE id=?`).run(
      next.route_id, next.title, next.season, next.poster_url, next.rrule,
      next.dtstart_local, next.duration_min, editReason || '修改系列', iso(nowMs), id);
    if (patch.segment_ids) replaceSegments(db, id, patch.segment_ids);
    regenerate(db, id, nowMs);
    bumpDataVersion(db);
  });
  tx();
}

function replaceSegments(db, templateId, segmentIds) {
  db.prepare('DELETE FROM activity_template_segments WHERE template_id = ?').run(templateId);
  const ins = db.prepare('INSERT OR IGNORE INTO activity_template_segments (template_id, segment_id) VALUES (?,?)');
  for (const s of segmentIds || []) ins.run(templateId, s);
}

function snapshotRevision(db, templateId, reason, nowMs) {
  const row = getTemplate(db, templateId);
  if (!row) return;
  db.prepare(`INSERT INTO template_revisions (id, template_id, version, snapshot_json, edit_reason, edited_utc)
              VALUES (?,?,?,?,?,?)`)
    .run(uuid('rev'), templateId, row.version, JSON.stringify(row), reason, iso(nowMs));
}

// ---------------------------------------------------------------- 例外
/** 校验日期确为系列中的一场（用宽窗口验证；生成窗口仍保持有界） */
function assertOccurrenceExists(db, tpl, occurrenceDate, nowMs) {
  const zone = getStation(db, tpl.station_id).tz;
  const far = nowMs + 5 * 366 * DAY; // 验证窗口放宽到 5 年
  const occs = expandRrule({
    rrule: tpl.rrule, dtstartLocal: tpl.dtstart_local, durationMin: tpl.duration_min,
    tz: zone, windowStartMs: 0, windowEndMs: far,
  });
  if (!occs.some(o => o.date === occurrenceDate)) {
    throw Object.assign(new Error(`${occurrenceDate} 不是该系列的有效场次日期`), { status: 400 });
  }
}

/** 添加/覆盖单次例外（取消 或 临时改期），与循环系列分开存放 */
function addException(db, { templateId, occurrenceDate, kind, newStartUtc = null, reason }, nowMs) {
  if (!['cancel', 'reschedule'].includes(kind)) throw Object.assign(new Error('非法例外类型'), { status: 400 });
  if (kind === 'reschedule' && !newStartUtc) throw Object.assign(new Error('改期必须给出新时间'), { status: 400 });
  let excId;
  const tx = db.transaction(() => {
    const tpl = getTemplate(db, templateId);
    if (!tpl) throw Object.assign(new Error('模板不存在'), { status: 404 });
    assertOccurrenceExists(db, tpl, occurrenceDate, nowMs);
    const existing = db.prepare(
      'SELECT id FROM activity_exceptions WHERE template_id = ? AND occurrence_date = ?'
    ).get(templateId, occurrenceDate);
    excId = existing ? existing.id : uuid('exc');
    const normNew = newStartUtc ? iso(Date.parse(newStartUtc)) : null;
    db.prepare(`INSERT INTO activity_exceptions
        (id, template_id, occurrence_date, kind, new_start_utc, reason, created_utc)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(template_id, occurrence_date)
        DO UPDATE SET kind=excluded.kind, new_start_utc=excluded.new_start_utc, reason=excluded.reason`)
      .run(excId, templateId, occurrenceDate, kind, normNew, reason, iso(nowMs));
    regenerate(db, templateId, nowMs);
    bumpDataVersion(db);
  });
  tx();
  return excId;
}

// ---------------------------------------------------------------- 核心：有界展开 + 幂等 diff
/**
 * 重新生成某模板的实例。
 * 比较“本次展开结果”与“库中预生成实例”：
 *  - 新增：INSERT（deterministic id，天然幂等）；
 *  - 未来且 scheduled 的系列实例：跟随模板更新（时间/时长/海报/标题）；
 *  - 已结束实例：永不覆盖；
 *  - 有例外的场次：例外优先，系列生成不得翻案；
 *  - 规则改变后不再发生的未来 scheduled 系列实例：删除；已结束/已取消保留为历史。
 */
function regenerate(db, templateId, nowMs) {
  const tpl = getTemplate(db, templateId);
  if (!tpl) throw new Error(`模板不存在: ${templateId}`);
  const station = getStation(db, tpl.station_id);
  const zone = station.tz;

  const occs = expandRrule({
    rrule: tpl.rrule, dtstartLocal: tpl.dtstart_local, durationMin: tpl.duration_min,
    tz: zone, windowStartMs: nowMs - PAST_DAYS * DAY, windowEndMs: nowMs + HORIZON_DAYS * DAY,
  });

  const excByDate = new Map(
    db.prepare('SELECT * FROM activity_exceptions WHERE template_id = ?').all(templateId)
      .map(e => [e.occurrence_date, e]));
  const existing = db.prepare('SELECT * FROM activity_instances WHERE template_id = ?').all(templateId);
  const existById = new Map(existing.map(r => [r.id, r]));
  const nowIso = iso(nowMs);
  const desiredDates = new Set();

  const insInst = db.prepare(`INSERT INTO activity_instances
    (id, template_id, occurrence_date, start_utc, end_utc, status, cancel_reason,
     poster_url, title_snapshot, source, created_utc, updated_utc)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insHistory = db.prepare(`INSERT OR IGNORE INTO cancellation_history
    (id, instance_id, template_id, occurrence_date, reason, poster_url, cancelled_utc)
    VALUES (?,?,?,?,?,?,?)`);

  for (const occ of occs) {
    const id = `ser:${templateId}:${occ.date}`;
    desiredDates.add(occ.date);
    const exc = excByDate.get(occ.date);
    const row = existById.get(id);
    const startIso = iso(occ.startMs), endIso = iso(occ.endMs);

    if (exc && exc.kind === 'cancel') {
      if (!row) {
        insInst.run(id, templateId, occ.date, startIso, endIso, 'cancelled',
          exc.reason, tpl.poster_url, tpl.title, 'series', nowIso, nowIso);
        insHistory.run(`his:${id}`, id, templateId, occ.date, exc.reason, tpl.poster_url, nowIso);
      } else if (row.status === 'scheduled') {
        db.prepare(`UPDATE activity_instances SET status='cancelled', cancel_reason=?, updated_utc=? WHERE id=?`)
          .run(exc.reason, nowIso, id);
        insHistory.run(`his:${id}`, id, templateId, occ.date, exc.reason, row.poster_url, nowIso);
      } // 已 cancelled：不动（幂等 + 例外优先）
      continue;
    }

    if (exc && exc.kind === 'reschedule') {
      // 原场次标记 rescheduled（保留轨迹），新场次以独立实例存在 —— 与循环分开
      if (!row) {
        insInst.run(id, templateId, occ.date, startIso, endIso, 'rescheduled',
          exc.reason, tpl.poster_url, tpl.title, 'series', nowIso, nowIso);
      } else if (row.status === 'scheduled') {
        db.prepare(`UPDATE activity_instances SET status='rescheduled', cancel_reason=?, updated_utc=? WHERE id=?`)
          .run(exc.reason, nowIso, id);
      }
      const newStartMs = Date.parse(exc.new_start_utc);
      const newEndMs = newStartMs + tpl.duration_min * 60000;
      const excInstId = `exc:${exc.id}`;
      const excRow = existById.get(excInstId);
      if (!excRow) {
        insInst.run(excInstId, templateId, tz.localDateOf(zone, newStartMs),
          iso(newStartMs), iso(newEndMs), 'scheduled', null,
          tpl.poster_url, `${tpl.title}（改期）`, 'exception', nowIso, nowIso);
      } else if (excRow.status === 'scheduled' && Date.parse(excRow.end_utc) > nowMs) {
        db.prepare(`UPDATE activity_instances SET start_utc=?, end_utc=?, occurrence_date=?, updated_utc=? WHERE id=?`)
          .run(iso(newStartMs), iso(newEndMs), tz.localDateOf(zone, newStartMs), nowIso, excInstId);
      }
      continue;
    }

    // 正常场次
    if (!row) {
      insInst.run(id, templateId, occ.date, startIso, endIso, 'scheduled',
        null, tpl.poster_url, tpl.title, 'series', nowIso, nowIso);
    } else if (row.source === 'series' && row.status === 'scheduled' && Date.parse(row.end_utc) > nowMs) {
      // 仅未来场次跟随系列更新；已结束实例不覆盖
      if (row.start_utc !== startIso || row.end_utc !== endIso ||
          row.poster_url !== tpl.poster_url || row.title_snapshot !== tpl.title) {
        db.prepare(`UPDATE activity_instances SET start_utc=?, end_utc=?, poster_url=?, title_snapshot=?, updated_utc=? WHERE id=?`)
          .run(startIso, endIso, tpl.poster_url, tpl.title, nowIso, id);
      }
    }
  }

  // 规则改变后不再发生的未来 scheduled 系列实例：移除；历史一律保留
  const del = db.prepare('DELETE FROM activity_instances WHERE id = ?');
  for (const row of existing) {
    if (row.source !== 'series' || desiredDates.has(row.occurrence_date)) continue;
    if (row.status === 'scheduled' && Date.parse(row.start_utc) > nowMs) del.run(row.id);
  }
}

// ---------------------------------------------------------------- 施工通告
function createClosure(db, input, nowMs) {
  const id = uuid('clo');
  db.prepare(`INSERT INTO closures (id, route_id, segment_id, starts_utc, ends_utc, reason, created_utc)
              VALUES (?,?,?,?,?,?,?)`)
    .run(id, input.route_id, input.segment_id ?? null,
      iso(Date.parse(input.starts_utc)), iso(Date.parse(input.ends_utc)),
      input.reason, iso(nowMs));
  bumpDataVersion(db);
  return id;
}

// ---------------------------------------------------------------- 读模型
function instanceDto(db, tpl, row, viewerTz) {
  const station = getStation(db, tpl.station_id);
  const startMs = Date.parse(row.start_utc), endMs = Date.parse(row.end_utc);
  return {
    id: row.id, template_id: row.template_id, title: row.title_snapshot,
    occurrence_date: row.occurrence_date,
    start_utc: row.start_utc, end_utc: row.end_utc,
    status: row.status, cancel_reason: row.cancel_reason, source: row.source,
    poster_url: row.poster_url, season: tpl.season, station_tz: station.tz,
    crosses_midnight: tz.localDateOf(station.tz, startMs) !== tz.localDateOf(station.tz, endMs),
    local_display: `${tz.formatInTz(station.tz, startMs)} → ${tz.formatInTz(station.tz, endMs)}`,
    viewer_display: viewerTz
      ? `${tz.formatInTz(viewerTz, startMs)} → ${tz.formatInTz(viewerTz, endMs)}` : null,
    advisories: closuresForInstance(db, tpl, row),
  };
}

/** 日历区间查询（带缓存；写操作 bump 版本号，缓存不会迟到） */
function calendarRange(db, stationId, fromMs, toMs, viewerTz) {
  return cached(`cal:${stationId}:${fromMs}:${toMs}:${viewerTz || ''}`, db, () => {
    const rows = db.prepare(`
      SELECT i.*, t.station_id FROM activity_instances i
      JOIN activity_templates t ON t.id = i.template_id
      WHERE t.station_id = ? AND i.end_utc > ? AND i.start_utc < ?
      ORDER BY i.start_utc`).all(stationId, iso(fromMs), iso(toMs));
    return rows.map(r => instanceDto(db, getTemplate(db, r.template_id), r, viewerTz));
  });
}

/** 本周推荐：站点时区的自然周；仅 scheduled —— 取消场次绝不重现 */
function weeklyRecommendations(db, stationId, refMs, viewerTz) {
  const station = getStation(db, stationId);
  const { startMs, endMs, mondayLocal } = tz.weekBoundsInTz(station.tz, refMs);
  const rows = db.prepare(`
    SELECT i.* FROM activity_instances i
    JOIN activity_templates t ON t.id = i.template_id
    WHERE t.station_id = ? AND i.status = 'scheduled'
      AND i.start_utc >= ? AND i.start_utc < ?
    ORDER BY i.start_utc`).all(stationId, iso(startMs), iso(endMs));
  return {
    week_start_local: mondayLocal, station_tz: station.tz,
    items: rows.map(r => instanceDto(db, getTemplate(db, r.template_id), r, viewerTz)),
  };
}

/** 计算依据解释：前端据此向用户说明“活动为什么在这一天” */
function explainInstance(db, instanceId, viewerTz) {
  const row = db.prepare('SELECT * FROM activity_instances WHERE id = ?').get(instanceId);
  if (!row) throw Object.assign(new Error('实例不存在'), { status: 404 });
  const tpl = getTemplate(db, row.template_id);
  const station = getStation(db, tpl.station_id);
  const zone = station.tz;
  const steps = [];
  const startMs = Date.parse(row.start_utc);

  steps.push(`活动所在地「${station.name}」时区 ${zone}，一切周期计算以该地墙钟为准。`);
  if (row.source === 'series') {
    steps.push(`模板规则 ${tpl.rrule}，首场 ${tpl.dtstart_local}（本地），时长 ${tpl.duration_min} 分钟。`);
    // 计算该场次是全序列第几场
    const occs = expandRrule({
      rrule: tpl.rrule, dtstartLocal: tpl.dtstart_local, durationMin: tpl.duration_min,
      tz: zone, windowStartMs: 0, windowEndMs: startMs + 1,
    });
    const idx = occs.findIndex(o => o.date === row.occurrence_date);
    if (idx >= 0) steps.push(`按规则展开，本场是第 ${idx + 1} 场，落在本地日期 ${row.occurrence_date}。`);
  } else {
    const exc = db.prepare('SELECT * FROM activity_exceptions WHERE id = ?')
      .get(row.id.replace(/^exc:/, ''));
    steps.push(`本场为单次临时改期（与循环系列分开存放），原场次本地日期 ${exc ? exc.occurrence_date : '?'}。`);
    if (exc) steps.push(`改期理由：${exc.reason}；新时间 ${exc.new_start_utc}。`);
  }
  steps.push(`本地 ${tz.formatInTz(zone, startMs)} 换算为 UTC ${row.start_utc}（按 ${zone} 当时偏移）。`);
  const endLocal = tz.formatInTz(zone, Date.parse(row.end_utc));
  const crosses = tz.localDateOf(zone, startMs) !== tz.localDateOf(zone, Date.parse(row.end_utc));
  steps.push(`时长 ${tpl.duration_min} 分钟 → 本地结束 ${endLocal}` +
    (crosses ? '（跨午夜，仍归属开始日）。' : '。'));
  if (row.status === 'cancelled') {
    const his = db.prepare('SELECT * FROM cancellation_history WHERE instance_id = ?').get(row.id);
    steps.push(`该场已取消：${row.cancel_reason}（取消时间 ${his ? his.cancelled_utc : '未知'}，取消优先于系列重新生成）。`);
  } else if (row.status === 'rescheduled') {
    steps.push(`该场已改期：${row.cancel_reason}。`);
  }
  const adv = closuresForInstance(db, tpl, row);
  for (const a of adv) {
    steps.push(`施工提示「${a.reason}」与本场路段相交且时间相交（${a.starts_utc} ~ ${a.ends_utc}），仅影响本场。`);
  }
  if (viewerTz) {
    steps.push(`浏览者时区 ${viewerTz} 仅影响展示：您看到的是 ${tz.formatInTz(viewerTz, startMs)}。`);
  }
  return {
    instance: instanceDto(db, tpl, row, viewerTz),
    template: { id: tpl.id, title: tpl.title, rrule: tpl.rrule, dtstart_local: tpl.dtstart_local,
                duration_min: tpl.duration_min, version: tpl.version, season: tpl.season },
    steps,
  };
}

function cancellationHistory(db, stationId) {
  return db.prepare(`
    SELECT h.*, t.title FROM cancellation_history h
    JOIN activity_templates t ON t.id = h.template_id
    WHERE t.station_id = ? ORDER BY h.cancelled_utc DESC`).all(stationId);
}

module.exports = {
  HORIZON_DAYS, PAST_DAYS,
  getDataVersion, bumpDataVersion, cached, cacheSize,
  getTemplate, getStation, templateSegments, closuresForInstance,
  createTemplate, updateTemplate, addException, regenerate,
  createClosure, calendarRange, weeklyRecommendations, explainInstance,
  cancellationHistory, instanceDto,
};
