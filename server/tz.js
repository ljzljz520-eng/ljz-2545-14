'use strict';
/**
 * 时区与历法工具。
 *
 * 核心原则：
 *  - 周期展开、跨午夜、DST 转换全部按【活动所在地】时区做墙钟运算；
 *  - 存储一律 UTC 毫秒 / ISO 字符串；
 *  - 浏览者时区只在 formatInTz() 展示层生效，绝不参与计算。
 */

const dtfCache = new Map();
function getDtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

/** UTC 瞬间 -> 某时区的墙钟部件 */
function utcToZonedParts(tz, utcMs) {
  const parts = getDtf(tz).formatToParts(new Date(utcMs));
  const o = {};
  for (const p of parts) if (p.type !== 'literal') o[p.type] = p.value;
  let hour = parseInt(o.hour, 10);
  if (hour === 24) hour = 0;
  return {
    year: +o.year, month: +o.month, day: +o.day,
    hour, minute: +o.minute, second: +o.second,
  };
}

/** 某 UTC 瞬间，时区的偏移（毫秒，墙钟 - UTC） */
function tzOffsetMs(tz, utcMs) {
  const p = utcToZonedParts(tz, utcMs);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs;
}

/**
 * 活动所在地墙钟 -> UTC 毫秒。
 * 迭代求不动点，自动正确处理 DST 往返（春季拨快/秋季拨回）。
 */
function zonedLocalToUtcMs(tz, y, mo, d, h, mi, s = 0) {
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  let utc = wallAsUtc - tzOffsetMs(tz, wallAsUtc);
  for (let i = 0; i < 3; i++) {
    const next = wallAsUtc - tzOffsetMs(tz, utc);
    if (next === utc) break;
    utc = next;
  }
  return utc;
}

// ---------- 纯历法（与时刻无关，安全跨月/跨年/闰年） ----------
const DAY_MS = 86400000;

function parseDate(s) { // 'YYYY-MM-DD'
  return { y: +s.slice(0, 4), m: +s.slice(5, 7), d: +s.slice(8, 10) };
}
function fmtDate(dt) {
  const p2 = n => String(n).padStart(2, '0');
  return `${dt.y}-${p2(dt.m)}-${p2(dt.d)}`;
}
function dateToMs(dt) { return Date.UTC(dt.y, dt.m - 1, dt.d); }
function msToDate(ms) {
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}
function addDays(dt, n) { return msToDate(dateToMs(dt) + n * DAY_MS); }
function cmpDate(a, b) { return dateToMs(a) - dateToMs(b); }
/** 0=周日 ... 6=周六 */
function weekday(dt) { return new Date(dateToMs(dt)).getUTCDay(); }
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

/** 站点时区下的本地日期 */
function localDateOf(tz, utcMs) {
  const p = utcToZonedParts(tz, utcMs);
  return fmtDate({ y: p.year, m: p.month, d: p.day });
}

/** 站点时区下一周（周一 00:00 起）的 UTC 边界 [startMs, endMs) */
function weekBoundsInTz(tz, refMs) {
  const p = utcToZonedParts(tz, refMs);
  const today = { y: p.year, m: p.month, d: p.day };
  const monday = addDays(today, -((weekday(today) + 6) % 7));
  const nextMonday = addDays(monday, 7);
  return {
    startMs: zonedLocalToUtcMs(tz, monday.y, monday.m, monday.d, 0, 0, 0),
    endMs: zonedLocalToUtcMs(tz, nextMonday.y, nextMonday.m, nextMonday.d, 0, 0, 0),
    mondayLocal: fmtDate(monday),
  };
}

/** 展示层：把 UTC 瞬间格式化成某（浏览者）时区字符串 —— 仅影响展示 */
function formatInTz(tz, utcMs) {
  const p = utcToZonedParts(tz, utcMs);
  const p2 = n => String(n).padStart(2, '0');
  return `${p.year}-${p2(p.month)}-${p2(p.day)} ${p2(p.hour)}:${p2(p.minute)}`;
}

const iso = ms => new Date(ms).toISOString();

module.exports = {
  utcToZonedParts, tzOffsetMs, zonedLocalToUtcMs,
  parseDate, fmtDate, dateToMs, msToDate, addDays, cmpDate, weekday, daysInMonth,
  localDateOf, weekBoundsInTz, formatInTz, iso, DAY_MS,
};
