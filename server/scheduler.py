"""季节年历核心：周期规则展开 + 有界物化 + 例外优先级 + 施工相交。

时区约定（关键）：
- 规则与“挂钟时间”一律以活动所在地时区(template.timezone)做本地日期算术，
  再换算 UTC 存储。绝不用 UTC 日期去匹配 by_weekday/by_monthday，
  否则跨时区浏览者会看到“活动出现在错误的一天”。
- 浏览者时区不参与任何计算，只在展示层换算（见 calendar.js 渲染）。
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

MAX_OCCURRENCES = 20_000  # 有界展开硬上限，防止规则错误导致无限生成

WEEKDAY_CN = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]


# --------------------------------------------------------------------------- #
# 基础工具
# --------------------------------------------------------------------------- #
def parse_date(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()


def parse_hm(s: str) -> time:
    return datetime.strptime(s, "%H:%M").time()


def _ints(s: str | None) -> list[int]:
    if not s:
        return []
    return [int(x) for x in str(s).split(",") if x != ""]


def local_dt(d: date, t: time, tz: ZoneInfo) -> datetime:
    """本地挂钟时间 -> 带时区 datetime（fold 由 zoneinfo 自动处理 DST 回退）。"""
    return datetime.combine(d, t).replace(tzinfo=tz)


def iso_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def instance_window(start_date: date, start_t: time, end_t: time) -> tuple[date, date]:
    """返回 (起始日期, 结束日期)；end_time <= start_time 视为跨午夜，结束日 +1。"""
    end_d = start_date + timedelta(days=1) if end_t <= start_t else start_date
    return start_date, end_d


# --------------------------------------------------------------------------- #
# 周期展开
# --------------------------------------------------------------------------- #
@dataclass
class Occurrence:
    occ_date: date            # 规则下的“原始发生日”（本地）
    local_start: datetime
    local_end: datetime

    def as_row(self) -> dict:
        return {
            "local_start": self.local_start.replace(tzinfo=None).isoformat(timespec="minutes"),
            "local_end": self.local_end.replace(tzinfo=None).isoformat(timespec="minutes"),
            "utc_start": iso_utc(self.local_start),
            "utc_end": iso_utc(self.local_end),
        }


def expand_rule(tpl: dict, window_from: date | None = None,
                window_to: date | None = None) -> list[Occurrence]:
    """把模板规则在有界窗口内展开。窗口默认取模板赛季；任何情况都不越过赛季边界。

    MONTHLY 月底越界：by_monthday=31 落在只有 30 天的月份时“跳过”该月，
    不顺延到下月 1 日（避免与下月规则重复，也符合直觉）。-1 表示月末。
    """
    tz = ZoneInfo(tpl["timezone"])
    season_from = parse_date(tpl["start_date"])
    season_to = parse_date(tpl["end_date"])
    win_from = max(season_from, window_from or season_from)
    win_to = min(season_to, window_to or season_to)
    if win_from > win_to:
        return []

    start_t = parse_hm(tpl["start_time"])
    end_t = parse_hm(tpl["end_time"])
    interval = int(tpl["rrule_interval"])
    freq = tpl["rrule_freq"]

    raw_dates: list[date] = []

    if freq == "DAILY":
        d = season_from
        # 窗口起点对齐到步长：从赛季首日起每 interval 天
        offset = (win_from - season_from).days
        d = season_from + timedelta(days=(offset // interval) * interval)
        while d <= win_to and len(raw_dates) < MAX_OCCURRENCES:
            raw_dates.append(d)
            d += timedelta(days=interval)

    elif freq == "WEEKLY":
        dows = set(_ints(tpl.get("by_weekday"))) or {season_from.weekday()}
        # 以赛季首周（周一）为周序号 0，按 interval 跳周
        season_monday = season_from - timedelta(days=season_from.weekday())
        cur_monday = win_from - timedelta(days=win_from.weekday())
        while cur_monday <= win_to and len(raw_dates) < MAX_OCCURRENCES:
            week_index = (cur_monday - season_monday).days // 7
            if week_index % interval == 0:
                for dow in sorted(dows):
                    d = cur_monday + timedelta(days=dow)
                    if season_from <= d <= win_to:
                        raw_dates.append(d)
            cur_monday += timedelta(days=7)

    elif freq == "MONTHLY":
        days = _ints(tpl.get("by_monthday")) or [season_from.day]
        y, m = win_from.year, win_from.month
        base_index = (season_from.year * 12 + season_from.month)
        while True:
            cur_index = y * 12 + m
            first = date(y, m, 1)
            if first > win_to:
                break
            if (cur_index - base_index) % interval == 0:
                last_day = (date(y + (m // 12), (m % 12) + 1, 1) - timedelta(days=1)).day \
                    if m < 12 else (date(y + 1, 1, 1) - timedelta(days=1)).day
                for md in days:
                    real_d = last_day if md == -1 else md
                    if real_d > last_day:
                        # 月底越界：跳过（如 31 日遇 2/4/6/9/11 月）
                        continue
                    d = date(y, m, real_d)
                    if season_from <= d <= win_to:
                        raw_dates.append(d)
            m += 1
            if m > 12:
                y, m = y + 1, 1
            if len(raw_dates) >= MAX_OCCURRENCES:
                break
    else:
        raise ValueError(f"unknown freq: {freq}")

    out: list[Occurrence] = []
    for d in sorted(set(raw_dates)):
        s_dt = local_dt(d, start_t, tz)
        end_d = d + timedelta(days=1) if end_t <= start_t else d
        e_dt = local_dt(end_d, end_t, tz)
        out.append(Occurrence(d, s_dt, e_dt))
    return out


# --------------------------------------------------------------------------- #
# 规则解释（供前端“为什么出现在这一天”展示）
# --------------------------------------------------------------------------- #
def rule_explanation(tpl: dict, occ_date: date, ordinal: int | None = None) -> str:
    freq = tpl["rrule_freq"]
    iv = tpl["rrule_interval"]
    if freq == "DAILY":
        pat = "每天" if iv == 1 else f"每 {iv} 天"
    elif freq == "WEEKLY":
        names = "、".join(WEEKDAY_CN[i] for i in sorted(_ints(tpl.get("by_weekday")))) \
            or WEEKDAY_CN[parse_date(tpl["start_date"]).weekday()]
        pat = ("每周" if iv == 1 else f"每 {iv} 周") + f"的{names}"
    else:
        mds = _ints(tpl.get("by_monthday")) or [parse_date(tpl["start_date"]).day]
        parts = ["月末" if x == -1 else f"{x}日" for x in mds]
        pat = ("每月" if iv == 1 else f"每 {iv} 个月") + "、".join(parts)
    ord_txt = f"，赛季内第 {ordinal} 次发生" if ordinal is not None else ""
    return (f"按模板「{tpl['title']}」v{tpl['version']}：{pat}；"
            f"{occ_date.isoformat()} 位于赛季 {tpl['start_date']} ~ {tpl['end_date']} 内{ord_txt}。")


# --------------------------------------------------------------------------- #
# 物化（幂等）
# --------------------------------------------------------------------------- #
def _latest_event(conn, template_id, occ):
    row = conn.execute(
        "SELECT event FROM cancellation_history WHERE template_id=? AND orig_occ_date=? "
        "ORDER BY id DESC LIMIT 1", (template_id, occ)).fetchone()
    return row["event"] if row else None


def _append_history(conn, template_id, occ, event, tpl, reason, source, actor="editor"):
    if _latest_event(conn, template_id, occ) == event:
        return  # 幂等：同一状态不重复留痕
    conn.execute(
        "INSERT INTO cancellation_history(template_id,orig_occ_date,title,poster_snapshot,"
        "reason,source,event,actor) VALUES(?,?,?,?,?,?,?,?)",
        (template_id, occ, tpl["title"], tpl.get("poster", ""), reason, source, event, actor))


def _construction_hits(conn, tpl: dict, occ: Occurrence):
    """返回与该实例“路段相交 且 时间相交”的施工提示。"""
    if not tpl.get("route_id"):
        return []
    tz = ZoneInfo(tpl["timezone"])
    t_from = float(tpl["seg_from"]) if tpl.get("seg_from") is not None else 0.0
    t_to = float(tpl["seg_to"]) if tpl.get("seg_to") is not None else 10**9
    rows = conn.execute("SELECT * FROM route_construction WHERE route_id=?",
                        (tpl["route_id"],)).fetchall()
    hits = []
    for c in rows:
        # 1) 路段相交（闭开区间）
        if max(t_from, c["seg_from"]) >= min(t_to, c["seg_to"]):
            continue
        # 2) 时间相交：施工窗口按路线所在地本地时间解释
        c_s = datetime.fromisoformat(c["starts_at_local"]).replace(tzinfo=tz)
        c_e = datetime.fromisoformat(c["ends_at_local"]).replace(tzinfo=tz)
        if occ.local_start < c_e and c_s < occ.local_end:
            hits.append(c)
    return hits


def _apply_exception(conn, tpl, exc, now_local: datetime):
    """把一条单次例外落到实例行（例外优先级高于一切规则/模板更新）。"""
    tz = ZoneInfo(tpl["timezone"])
    occ = exc["orig_occ_date"]
    inst = conn.execute(
        "SELECT * FROM activity_instances WHERE template_id=? AND orig_occ_date=?",
        (tpl["id"], occ)).fetchone()
    if inst is None:
        return  # 异常发生日不在已展开范围；创建例外时已拦截，这里静默
    if exc["kind"] == "CANCEL":
        conn.execute(
            "UPDATE activity_instances SET status='CANCELLED', exception_id=?, locked=1, "
            "updated_at=datetime('now') WHERE template_id=? AND orig_occ_date=?",
            (exc["id"], tpl["id"], occ))
        _append_history(conn, tpl["id"], occ, "CANCELLED", tpl,
                        exc["reason"] or "单次取消", exc["source"])
    elif exc["kind"] == "RESCHEDULE":
        nd = parse_date(exc["new_date"])
        ns = parse_hm(exc["new_start_time"])
        ne = parse_hm(exc["new_end_time"])
        s_dt = local_dt(nd, ns, tz)
        end_d = nd + timedelta(days=1) if ne <= ns else nd
        e_dt = local_dt(end_d, ne, tz)
        conn.execute(
            "UPDATE activity_instances SET status='RESCHEDULED', exception_id=?, locked=1, "
            "local_start=?, local_end=?, utc_start=?, utc_end=?, "
            "construction_ids='', construction_note='', updated_at=datetime('now') "
            "WHERE template_id=? AND orig_occ_date=?",
            (exc["id"], s_dt.replace(tzinfo=None).isoformat(timespec="minutes"),
             e_dt.replace(tzinfo=None).isoformat(timespec="minutes"),
             iso_utc(s_dt), iso_utc(e_dt), tpl["id"], occ))


def _reset_after_exception_removed(conn, tpl, occ: str, reason: str, source: str,
                                   now_utc: datetime | None = None):
    """例外被移除（施工提前结束 / 手动恢复）后回到规则基线。"""
    tz = ZoneInfo(tpl["timezone"])
    inst = conn.execute(
        "SELECT * FROM activity_instances WHERE template_id=? AND orig_occ_date=?",
        (tpl["id"], occ)).fetchone()
    if inst is None:
        return
    bs = datetime.fromisoformat(inst["base_local_start"]).replace(tzinfo=tz)
    be = datetime.fromisoformat(inst["base_local_end"]).replace(tzinfo=tz)
    now_local = (now_utc or datetime.now(timezone.utc)).astimezone(tz)
    ended = be <= now_local
    conn.execute(
        "UPDATE activity_instances SET status='SCHEDULED', exception_id=NULL, locked=?, "
        "local_start=base_local_start, local_end=base_local_end, "
        "utc_start=?, utc_end=?, updated_at=datetime('now') "
        "WHERE template_id=? AND orig_occ_date=?",
        (1 if ended else 0, iso_utc(bs), iso_utc(be), tpl["id"], occ))
    _append_history(conn, tpl["id"], occ, "REINSTATED", tpl, reason, source)


def materialize_template(conn, tpl_id: int, window_from: str | None = None,
                         window_to: str | None = None, now_utc: datetime | None = None) -> dict:
    """幂等物化一个模板：新增缺失实例、更新未锁定实例、跳过已结束/已例外实例。

    返回 {created, updated, unchanged, skipped_locked, cancelled_by_construction, reinstated}
    """
    tpl = conn.execute("SELECT * FROM activity_templates WHERE id=?", (tpl_id,)).fetchone()
    if tpl is None:
        raise KeyError(f"template {tpl_id} not found")
    tpl = dict(tpl)
    tz = ZoneInfo(tpl["timezone"])
    now = now_utc or datetime.now(timezone.utc)
    now_local = now.astimezone(tz)

    wf = parse_date(window_from) if window_from else None
    wt = parse_date(window_to) if window_to else None
    occs = expand_rule(tpl, wf, wt)
    occ_map = {o.occ_date.isoformat(): o for o in occs}

    stats = {"created": 0, "updated": 0, "unchanged": 0, "skipped_locked": 0,
             "cancelled_by_construction": 0, "reinstated": 0}

    # ---- 预对账 1：清理“已经不再相交”的施工取消例外（即便该实例已因此被锁定） ----
    for ce in conn.execute(
            "SELECT * FROM activity_exceptions WHERE template_id=? AND source='CONSTRUCTION'",
            (tpl_id,)).fetchall():
        occ = occ_map.get(ce["orig_occ_date"])
        still = bool(occ) and any(h["effect"] == "CANCEL"
                                  for h in _construction_hits(conn, tpl, occ))
        if not still:
            # 先解除实例引用（FK），再删除例外，最后留恢复历史
            _reset_after_exception_removed(conn, tpl, ce["orig_occ_date"],
                                           "施工提前结束/路段或时间不再相交", "CONSTRUCTION",
                                           now_utc)
            conn.execute("DELETE FROM activity_exceptions WHERE id=?", (ce["id"],))
            stats["reinstated"] += 1

    existing = {r["orig_occ_date"]: r for r in conn.execute(
        "SELECT * FROM activity_instances WHERE template_id=?", (tpl_id,)).fetchall()}

    for i, occ in enumerate(occs, start=1):
        row = occ.as_row()
        ended = occ.local_end <= now_local
        ex = existing.get(occ.occ_date.isoformat())
        # 锁定原因：已结束 或 有任意单次例外（手动/施工）。锁定实例不被系列规则改写。
        has_exc = conn.execute(
            "SELECT 1 FROM activity_exceptions WHERE template_id=? AND orig_occ_date=?",
            (tpl_id, occ.occ_date.isoformat())).fetchone()
        locked = ended or bool(has_exc)
        if ex is None:
            conn.execute(
                "INSERT INTO activity_instances(template_id,orig_occ_date,local_start,local_end,"
                "utc_start,utc_end,base_local_start,base_local_end,status,rule_version,locked) "
                "VALUES(?,?,?,?,?,?,?,?, 'SCHEDULED', ?, ?)",
                (tpl_id, occ.occ_date.isoformat(), row["local_start"], row["local_end"],
                 row["utc_start"], row["utc_end"], row["local_start"], row["local_end"],
                 tpl["version"], 1 if locked else 0))
            stats["created"] += 1
            continue
        if ex["locked"]:
            stats["skipped_locked"] += 1
            continue
        # 未锁定：模板改规则只覆盖未结束、无例外的实例
        changed = (ex["base_local_start"] != row["local_start"]
                   or ex["base_local_end"] != row["local_end"]
                   or ex["rule_version"] != tpl["version"])
        if changed:
            conn.execute(
                "UPDATE activity_instances SET base_local_start=?, base_local_end=?, "
                "local_start=?, local_end=?, utc_start=?, utc_end=?, rule_version=?, "
                "locked=?, updated_at=datetime('now') "
                "WHERE template_id=? AND orig_occ_date=?",
                (row["local_start"], row["local_end"], row["local_start"], row["local_end"],
                 row["utc_start"], row["utc_end"], tpl["version"], 1 if locked else 0,
                 tpl_id, occ.occ_date.isoformat()))
            stats["updated"] += 1
        else:
            if ended and not ex["locked"]:
                conn.execute("UPDATE activity_instances SET locked=1 WHERE template_id=? "
                             "AND orig_occ_date=?", (tpl_id, occ.occ_date.isoformat()))
            stats["unchanged"] += 1

    # ---- 施工相交对账：NOTICE 仅提示；CANCEL 对“路段+时间双相交”的未结束场次生效 ----
    for occ in occs:
        key = occ.occ_date.isoformat()
        inst = conn.execute(
            "SELECT * FROM activity_instances WHERE template_id=? AND orig_occ_date=?",
            (tpl_id, key)).fetchone()
        if inst is None:
            continue
        # 手动例外优先级最高：手动取消/改期的场次不受施工影响
        manual = conn.execute(
            "SELECT 1 FROM activity_exceptions WHERE template_id=? AND orig_occ_date=? "
            "AND source='MANUAL'", (tpl_id, key)).fetchone()
        if manual:
            continue
        hits = _construction_hits(conn, tpl, occ)
        ids = ",".join(str(h["id"]) for h in hits)
        notes = [f"施工提示#{h['id']} {h['starts_at_local']}~{h['ends_at_local']} "
                 f"({h['seg_from']}-{h['seg_to']}km)：{h['reason']}" for h in hits]
        cancels = [h for h in hits if h["effect"] == "CANCEL"]
        if inst["exception_id"] and inst["locked"]:
            continue  # 已由施工取消且仍相交（预对账已处理不再相交的情形）

        conn.execute(
            "UPDATE activity_instances SET construction_ids=?, construction_note=?, "
            "updated_at=datetime('now') WHERE template_id=? AND orig_occ_date=?",
            (ids, "；".join(notes), tpl_id, key))

        if cancels and occ.local_end > now_local:
            h = cancels[0]
            cur = conn.execute(
                "INSERT OR IGNORE INTO activity_exceptions(template_id,orig_occ_date,kind,"
                "reason,source) VALUES(?,?,'CANCEL',?, 'CONSTRUCTION')",
                (tpl_id, key, f"路线施工：{h['reason']}"))
            if cur.rowcount:
                exc = dict(conn.execute(
                    "SELECT * FROM activity_exceptions WHERE template_id=? AND orig_occ_date=?",
                    (tpl_id, key)).fetchone())
                _apply_exception(conn, tpl, exc, now_local)
                stats["cancelled_by_construction"] += 1

    # ---- 例外优先级收口：确保所有例外都落到实例（幂等，重复不产生新历史） ----
    for exc in conn.execute(
            "SELECT * FROM activity_exceptions WHERE template_id=? ORDER BY id",
            (tpl_id,)).fetchall():
        inst = conn.execute(
            "SELECT * FROM activity_instances WHERE template_id=? AND orig_occ_date=?",
            (tpl_id, exc["orig_occ_date"])).fetchone()
        if inst is not None and (inst["exception_id"] != exc["id"]
                                 or (inst["status"] == "SCHEDULED")):
            _apply_exception(conn, tpl, dict(exc), now_local)

    return stats


def instance_basis(conn, tpl: dict, inst: dict) -> dict:
    """构造“活动为什么出现在这一天”的可解释依据。"""
    occ_d = parse_date(inst["orig_occ_date"])
    ordinal = None
    if tpl["rrule_freq"] == "MONTHLY":
        ordinal = (occ_d.year - parse_date(tpl["start_date"]).year) * 12 \
            + occ_d.month - parse_date(tpl["start_date"]).month + 1
    derived = "RULE"
    exc_detail = None
    if inst["exception_id"]:
        exc = conn.execute("SELECT * FROM activity_exceptions WHERE id=?",
                           (inst["exception_id"],)).fetchone()
        if exc:
            exc_detail = dict(exc)
            derived = f"EXCEPTION:{exc['kind']}:{exc['source']}"
    constructions = [dict(c) for c in conn.execute(
        "SELECT id,reason,effect,starts_at_local,ends_at_local,seg_from,seg_to "
        "FROM route_construction WHERE id IN (%s)" %
        (",".join(inst["construction_ids"].split(",")) or "0",
         )).fetchall()] if inst["construction_ids"] else []
    return {
        "derived_from": derived,
        "precedence": ["单次例外(MANUAL)", "施工取消(CONSTRUCTION)", "周期规则(RULE)",
                       "模板默认值"],
        "timezone": tpl["timezone"],
        "rule": {
            "freq": tpl["rrule_freq"], "interval": tpl["rrule_interval"],
            "by_weekday": _ints(tpl.get("by_weekday")),
            "by_monthday": _ints(tpl.get("by_monthday")),
            "season_start": tpl["start_date"], "season_end": tpl["end_date"],
            "version": tpl["version"],
        },
        "orig_occ_date": inst["orig_occ_date"],
        "explanation_zh": rule_explanation(dict(tpl), occ_d, ordinal),
        "exception": exc_detail,
        "construction": constructions,
        "note": "所有日期/时间按活动所在地时区计算；你的浏览器时区仅影响显示。",
    }
