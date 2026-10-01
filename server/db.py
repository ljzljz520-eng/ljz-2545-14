"""SQLite 连接初始化与演示种子数据。"""
from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

SCHEMA = Path(__file__).with_name("schema.sql").read_text(encoding="utf-8")

DEFAULT_DB = os.environ.get("CALENDAR_DB", str(Path(__file__).resolve().parent.parent
                                                / "data" / "calendar.db"))


def connect(db_path: str | None = None) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path or DEFAULT_DB)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db(db_path: str | None = None, seed: bool = True) -> sqlite3.Connection:
    conn = connect(db_path)
    conn.executescript(SCHEMA)
    conn.commit()
    if seed and conn.execute("SELECT COUNT(*) c FROM activity_templates").fetchone()["c"] == 0:
        _seed(conn)
    return conn


def _line(coords):
    geom = {"type": "LineString", "coordinates": coords}
    xs = [c[0] for c in coords]
    ys = [c[1] for c in coords]
    return json.dumps(geom), json.dumps([min(xs), min(ys), max(xs), max(ys)])


def _seed(conn):
    # ---------- 路线 ----------
    lines = {
        "binjiang": _line([[120.10, 30.20 + i * 0.01] for i in range(12)]),
        "wulumuqi": _line([[87.60, 43.80 + i * 0.01] for i in range(12)]),
        "berlin": _line([[13.40, 52.50 + i * 0.01] for i in range(12)]),
    }
    routes = [
        ("binjiang", "滨江慢行道", "Asia/Shanghai"),
        ("wulumuqi", "乌市林荫道", "Asia/Urumqi"),
        ("berlin", "柏林菩提慢行道", "Europe/Berlin"),
    ]
    for code, name, tz in routes:
        geom, bbox = lines[code]
        conn.execute("INSERT INTO routes(code,name,timezone,geometry,bbox) VALUES(?,?,?,?,?)",
                     (code, name, tz, geom, bbox))
    r_binjiang, r_wlq, r_berlin = (
        conn.execute("SELECT id FROM routes WHERE code=?", (c,)).fetchone()["id"]
        for c in ("binjiang", "wulumuqi", "berlin"))

    # ---------- 活动模板 ----------
    # 1) 周五夜骑：22:00 出发，次日 00:30 结束（跨午夜），占用 2.0~8.0km
    conn.execute(
        "INSERT INTO activity_templates(slug,title,description,timezone,rrule_freq,rrule_interval,"
        "by_weekday,start_date,end_date,start_time,end_time,route_id,seg_from,seg_to,poster) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ("friday-night-ride", "滨江周五夜骑", "沿滨江慢行道的夜间休闲骑行，跨午夜。",
         "Asia/Shanghai", "WEEKLY", 1, "4", "2026-09-04", "2026-12-25",
         "22:00", "00:30", r_binjiang, 2.0, 8.0, "🌙 夜骑海报 v1"))
    # 2) 月末巡线：每月 31 日 09:00（遇小月跳过），赛季跨年到 2027-03
    conn.execute(
        "INSERT INTO activity_templates(slug,title,description,timezone,rrule_freq,rrule_interval,"
        "by_monthday,start_date,end_date,start_time,end_time,route_id,seg_from,seg_to,poster) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ("month-end-patrol", "月末 31 日安全巡线", "仅在有 31 天的月份发生，月底越界自动跳过。",
         "Asia/Shanghai", "MONTHLY", 1, "31", "2026-09-01", "2027-03-31",
         "09:00", "11:00", r_binjiang, 0.0, 4.0, "🛡️ 巡线海报 v1"))
    # 3) 乌鲁木齐晨骑：每周六 08:00（当地 UTC+6，验证跨时区日期）
    conn.execute(
        "INSERT INTO activity_templates(slug,title,description,timezone,rrule_freq,rrule_interval,"
        "by_weekday,start_date,end_date,start_time,end_time,route_id,seg_from,seg_to,poster) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ("wulumuqi-satride", "乌市周六晨骑", "按乌鲁木齐当地时间计算，与北京相差 2 小时。",
         "Asia/Urumqi", "WEEKLY", 1, "5", "2026-09-05", "2026-12-26",
         "08:00", "10:00", r_wlq, 1.0, 9.0, "🌅 晨骑海报 v1"))
    # 4) 柏林月度漫步：每月 1 日 19:00（跨 DST：10/25 夏令时结束）
    conn.execute(
        "INSERT INTO activity_templates(slug,title,description,timezone,rrule_freq,rrule_interval,"
        "by_monthday,start_date,end_date,start_time,end_time,route_id,seg_from,seg_to,poster) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ("berlin-monthly", "柏林月度河畔漫步", "欧洲中部时间，验证夏令时切换。",
         "Europe/Berlin", "MONTHLY", 1, "1", "2026-10-01", "2027-02-01",
         "19:00", "20:30", r_berlin, 0.0, 6.0, "🥨 Berlin Walk v1"))

    # ---------- 施工提示 ----------
    # A) 10/26 09:00 ~ 10/30 18:00，4~6km：与 10/30 夜骑(22:00-次日00:30) 时间不相交
    #    => 同月施工不应影响 10/30 的夜骑
    conn.execute(
        "INSERT INTO route_construction(route_id,seg_from,seg_to,starts_at_local,ends_at_local,"
        "effect,reason) VALUES(?,?,?,?,?,?,?)",
        (r_binjiang, 4.0, 6.0, "2026-10-26T09:00", "2026-10-30T18:00", "NOTICE",
         "滨江步道中段铺砖"))
    # B) 11/06 20:00 ~ 11/07 02:00，2~4km，CANCEL：与 11/6 夜骑(22:00-00:30) 双相交 => 取消该场
    conn.execute(
        "INSERT INTO route_construction(route_id,seg_from,seg_to,starts_at_local,ends_at_local,"
        "effect,reason) VALUES(?,?,?,?,?,?,?)",
        (r_binjiang, 2.0, 4.0, "2026-11-06T20:00", "2026-11-07T02:00", "CANCEL",
         "夜间桥面抢修"))
    # C) 同月但不相交路段：11 月 9~10km 白天施工，不影响夜骑(占用2~8km)
    conn.execute(
        "INSERT INTO route_construction(route_id,seg_from,seg_to,starts_at_local,ends_at_local,"
        "effect,reason) VALUES(?,?,?,?,?,?,?)",
        (r_binjiang, 9.0, 10.0, "2026-11-09T08:00", "2026-11-20T18:00", "CANCEL",
         "下游栈桥维护（与活动路段不相交）"))

    conn.commit()

    # 物化全部模板（用固定“当前时刻”= 2026-10-01 UTC，便于演示与测试）
    from scheduler import materialize_template
    for row in conn.execute("SELECT id FROM activity_templates").fetchall():
        materialize_template(conn, row["id"])
    conn.commit()


if __name__ == "__main__":
    db = init_db()
    n = db.execute("SELECT COUNT(*) c FROM activity_instances").fetchone()["c"]
    print(f"initialized at {DEFAULT_DB}: {n} instances")
