'use strict';
/**
 * 有界周期展开引擎（RFC5545 子集）。
 * 支持：FREQ=DAILY|WEEKLY|MONTHLY, INTERVAL, BYDAY, BYMONTHDAY, UNTIL, COUNT。
 *
 * 语义要点：
 *  - 所有候选日期是【活动所在地】的本地日历日期，时刻取 dtstart 的时分秒；
 *  - 月底越界（如 2 月没有 31 日）按 RFC5545【跳过】，不夹取、不顺延；
 *  - 展开窗口有界 [windowStartMs, windowEndMs)，并有迭代硬上限，杜绝失控；
 *  - UNTIL 为本地日期（含当日）；COUNT 为全序列总场次数。
 */
const tz = require('./tz');

const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const MAX_ITERATIONS = 20000; // 有界保护

function parseRrule(str) {
  const o = {};
  for (const part of String(str).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) o[part.slice(0, i).trim().toUpperCase()] = part.slice(i + 1).trim();
  }
  if (!o.FREQ || !['DAILY', 'WEEKLY', 'MONTHLY'].includes(o.FREQ)) {
    throw new Error(`不支持的 FREQ: ${o.FREQ || '(缺失)'}`);
  }
  const rule = {
    freq: o.FREQ,
    interval: o.INTERVAL ? Math.max(1, parseInt(o.INTERVAL, 10)) : 1,
    until: null,
    count: null,
    byday: null,       // 周几序号数组（0=周日），WEEKLY 用
    bymonthday: null,  // 月内日数组，MONTHLY 用
  };
  if (o.UNTIL) {
    const u = o.UNTIL.replace(/[-:]/g, '');
    rule.until = { y: +u.slice(0, 4), m: +u.slice(4, 6), d: +u.slice(6, 8) };
  }
  if (o.COUNT) rule.count = Math.max(0, parseInt(o.COUNT, 10));
  if (o.BYDAY) {
    rule.byday = o.BYDAY.split(',').map(s => {
      const w = WD[s.trim().toUpperCase()];
      if (w === undefined) throw new Error(`非法 BYDAY: ${s}`);
      return w;
    });
  }
  if (o.BYMONTHDAY) {
    rule.bymonthday = o.BYMONTHDAY.split(',').map(s => parseInt(s.trim(), 10))
      .filter(n => n >= 1 && n <= 31).sort((a, b) => a - b);
  }
  return rule;
}

/** 惰性生成 >= startDate 的候选本地日期（升序） */
function* occurrenceDates(rule, startDate) {
  if (rule.freq === 'DAILY') {
    for (let k = 0; ; k += rule.interval) yield tz.addDays(startDate, k);
  } else if (rule.freq === 'WEEKLY') {
    // WKST=MO：以周一为周界
    const wkst = tz.addDays(startDate, -((tz.weekday(startDate) + 6) % 7));
    const days = (rule.byday && rule.byday.length ? rule.byday : [tz.weekday(startDate)])
      .slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    for (let w = 0; ; w += rule.interval) {
      const base = tz.addDays(wkst, w * 7);
      for (const wd of days) {
        const d = tz.addDays(base, (wd + 6) % 7);
        if (tz.cmpDate(d, startDate) >= 0) yield d;
      }
    }
  } else { // MONTHLY
    const doms = rule.bymonthday && rule.bymonthday.length ? rule.bymonthday : [startDate.d];
    for (let k = 0; ; k += rule.interval) {
      const y = startDate.y + Math.floor((startDate.m - 1 + k) / 12);
      const m = ((startDate.m - 1 + k) % 12) + 1;
      const dim = tz.daysInMonth(y, m);
      for (const dom of doms) {
        if (dom > dim) continue; // 月底越界：跳过该月（RFC5545）
        const d = { y, m, d: dom };
        if (tz.cmpDate(d, startDate) >= 0) yield d;
      }
    }
  }
}

/**
 * 展开有界实例。
 * @returns Array<{date, startMs, endMs}> date=站点本地日期
 */
function expandRrule(opts) {
  const {
    rrule: rruleStr, dtstartLocal, durationMin, tz: zone,
    windowStartMs, windowEndMs,
  } = opts;
  const [datePart, timePart = '00:00:00'] = String(dtstartLocal).split('T');
  const startDate = tz.parseDate(datePart);
  const [hh, mm, ss] = timePart.split(':').map(Number);
  const rule = parseRrule(rruleStr);

  const out = [];
  let produced = 0; // 全序列已产生场次数（COUNT 语义）
  let iter = 0;
  for (const d of occurrenceDates(rule, startDate)) {
    if (++iter > MAX_ITERATIONS) break;                 // 有界硬上限
    if (rule.until && tz.cmpDate(d, rule.until) > 0) break;
    produced++;
    if (rule.count !== null && produced > rule.count) break;
    const startMs = tz.zonedLocalToUtcMs(zone, d.y, d.m, d.d, hh, mm, ss || 0);
    const endMs = startMs + durationMin * 60000;        // 时长为流逝时长，可跨午夜
    if (endMs <= windowStartMs) continue;               // 窗口之前，跳过但计入 COUNT
    if (startMs >= windowEndMs) break;                  // 日期递增，超出有界窗口即停
    out.push({ date: tz.fmtDate(d), startMs, endMs });
  }
  return out;
}

module.exports = { parseRrule, expandRrule, MAX_ITERATIONS };
