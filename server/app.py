"""季节年历 HTTP API（Python 标准库实现，零第三方依赖）。

核心语义：
- POST 默认要求 Idempotency-Key：同键 + 同请求体重放 => 返回首次结果，不重复生效。
- 时间以活动所在地时区计算；?viewer_tz= 只影响响应里的“展示字段”，不影响存储。
- 周推荐带版本化缓存：读取对账取消状态；迟到的旧版本缓存写入被拒绝。
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from zoneinfo import ZoneInfo

from db import init_db
from scheduler import (expand_rule, instance_basis, materialize_template,
                       parse_date, parse_hm, local_dt, iso_utc, rule_explanation)

DB_PATH = os.environ.get("CALENDAR_DB")
NOW_OVERRIDE = os.environ.get("CALENDAR_NOW")  # 测试/演示用固定当前时刻 ISO
_write_lock = threading.Lock()


def now_utc() -> datetime:
    if NOW_OVERRIDE:
        return datetime.fromisoformat(NOW_OVERRIDE).replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------- #
# 序列化辅助
# --------------------------------------------------------------------------- #
def row(r):
    return dict(r) if r is not None else None


def viewer_fields(inst: dict, viewer_tz: str | None):
    """仅展示层换算；不改变 local_*/utc_* 权威字段。"""
    if not viewer_tz:
        return {}
    tz = ZoneInfo(viewer_tz)
    out = {}
    for k in ("utc_start", "utc_end"):
        dt = datetime.fromisoformat(inst[k].replace("Z", "+00:00"))
        out["viewer_" + k.replace("utc_", "")] = dt.astimezone(tz).isoformat(timespec="minutes")
    # 展示层“看起来的本地日”（可能与活动当地日不同）
    out["viewer_date"] = datetime.fromisoformat(
        inst["utc_start"].replace("Z", "+00:00")).astimezone(tz).date().isoformat()
    return out


def instance_json(conn, inst, viewer_tz=None, with_basis=False):
    tpl = conn.execute("SELECT * FROM activity_templates WHERE id=?",
                       (inst["template_id"],)).fetchone()
    rte = conn.execute("SELECT code,name,timezone FROM routes WHERE id=?",
                       (tpl["route_id"],)).fetchone() if tpl["route_id"] else None
    d = {
        "template_id": inst["template_id"],
        "template_slug": tpl["slug"],
        "title": tpl["title"],
        "orig_occ_date": inst["orig_occ_date"],
        "local_start": inst["local_start"],
        "local_end": inst["local_end"],
        "utc_start": inst["utc_start"],
        "utc_end": inst["utc_end"],
        "status": inst["status"],
        "locked": bool(inst["locked"]),
        "timezone": tpl["timezone"],
        "route": dict(rte) if rte else None,
        "poster": tpl["poster"],
        "construction_note": inst["construction_note"],
        "rule_version": inst["rule_version"],
    }
    d.update(viewer_fields(inst, viewer_tz))
    if with_basis:
        d["basis"] = instance_basis(conn, dict(tpl), dict(inst))
    return d


# --------------------------------------------------------------------------- #
# 周推荐（版本化缓存 + 取消对账）
# --------------------------------------------------------------------------- #
def cache_version(conn) -> int:
    """全局数据版本：模板/实例/例外/取消历史/施工任一写入都经触发器 +1。

    保证“只取消一场（例外表小 id 增量）”也能使周推荐缓存失效，
    不会被实例表的大 rowid 掩盖。
    """
    r = conn.execute("SELECT v FROM calendar_meta WHERE k='data_version'").fetchone()
    return int(r["v"]) if r else 0


def week_window(anchor_utc: datetime):
    """以 UTC 划分自然周（周一 00:00 起，7 天）。浏览者日期差异在展示层体现。"""
    monday = (anchor_utc - timedelta(days=anchor_utc.weekday())).replace(
        hour=0, minute=0, second=0, microsecond=0)
    return monday, monday + timedelta(days=7)


def compute_weekly(conn, viewer_tz: str, anchor_iso: str | None):
    anchor = (datetime.fromisoformat(anchor_iso).replace(tzinfo=timezone.utc)
              if anchor_iso else now_utc())
    w_s, w_e = week_window(anchor)
    rows = conn.execute(
        "SELECT * FROM activity_instances WHERE utc_start >= ? AND utc_start < ? "
        "AND status != 'CANCELLED' ORDER BY utc_start",
        (iso_utc(w_s), iso_utc(w_e))).fetchall()
    items = [instance_json(conn, r, viewer_tz, with_basis=False) for r in rows]
    return {
        "week_start_utc": iso_utc(w_s), "week_end_utc": iso_utc(w_e),
        "viewer_timezone": viewer_tz,
        "generated_at": iso_utc(now_utc()),
        "items": items,
    }


def get_weekly(conn, scope, viewer_tz, anchor_iso, use_cache=True):
    """读缓存：命中旧版本 => 对账取消态并自愈；取消场永不复活（本周推荐不重现取消场次）。"""
    if not use_cache:
        return compute_weekly(conn, viewer_tz, anchor_iso), "fresh"
    cached = conn.execute("SELECT * FROM weekly_cache WHERE scope=?", (scope,)).fetchone()
    fresh = compute_weekly(conn, viewer_tz, anchor_iso)
    if cached is None:
        _save_cache(conn, scope, fresh, reject_stale=True)
        return fresh, "fresh"
    if cached["version"] == cache_version(conn):
        return json.loads(cached["payload"]), "cache-hit"
    # 迟到的旧缓存：版本落后。对缓存内容做取消对账——被取消的场次必须剔除
    stale = json.loads(cached["payload"])
    live_keys = {(i["template_id"], i["orig_occ_date"]): i for i in fresh["items"]}
    healed = []
    removed = []
    for it in stale["items"]:
        cur = conn.execute(
            "SELECT status FROM activity_instances WHERE template_id=? AND orig_occ_date=?",
            (it["template_id"], it["orig_occ_date"])).fetchone()
        if cur and cur["status"] != "CANCELLED" and (it["template_id"], it["orig_occ_date"]) in live_keys:
            healed.append(it)
        else:
            removed.append({"template_id": it["template_id"],
                            "orig_occ_date": it["orig_occ_date"], "title": it["title"]})
    fresh["healed_from_stale_cache"] = True
    fresh["removed_stale_entries"] = removed
    _save_cache(conn, scope, fresh, reject_stale=True)
    return fresh, "stale-reconciled"


def _save_cache(conn, scope, payload, reject_stale=True):
    ver = cache_version(conn)
    old = conn.execute("SELECT version FROM weekly_cache WHERE scope=?", (scope,)).fetchone()
    if reject_stale and old is not None and old["version"] > ver:
        # 迟到的旧版本写入：拒绝
        return False
    conn.execute(
        "INSERT INTO weekly_cache(scope,version,payload,computed_at) VALUES(?,?,?,?) "
        "ON CONFLICT(scope) DO UPDATE SET version=excluded.version, payload=excluded.payload, "
        "computed_at=excluded.computed_at WHERE excluded.version >= weekly_cache.version",
        (scope, ver, json.dumps(payload, ensure_ascii=False), payload["generated_at"]))
    return True


# --------------------------------------------------------------------------- #
# 校验
# --------------------------------------------------------------------------- #
class ApiError(Exception):
    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


def validate_template_payload(body):
    required = ["slug", "title", "timezone", "rrule_freq", "start_date", "end_date"]
    for k in required:
        if not body.get(k):
            raise ApiError(400, f"缺少必填字段: {k}")
    if body["rrule_freq"] not in ("DAILY", "WEEKLY", "MONTHLY"):
        raise ApiError(400, "rrule_freq 必须为 DAILY/WEEKLY/MONTHLY")
    parse_date(body["start_date"]); parse_date(body["end_date"])
    if body["end_date"] < body["start_date"]:
        raise ApiError(400, "end_date 不能早于 start_date")
    try:
        ZoneInfo(body["timezone"])
    except Exception:
        raise ApiError(400, f"无法识别的时区: {body['timezone']}")
    for k in ("start_time", "end_time"):
        if k in body:
            parse_hm(body[k])
    if body["rrule_freq"] == "WEEKLY" and body.get("by_weekday"):
        dows = [int(x) for x in str(body["by_weekday"]).split(",")]
        if any(d < 0 or d > 6 for d in dows):
            raise ApiError(400, "by_weekday 取值 0-6（0=周一）")
    if body["rrule_freq"] == "MONTHLY" and body.get("by_monthday"):
        for x in str(body["by_monthday"]).split(","):
            v = int(x)
            if v != -1 and not (1 <= v <= 31):
                raise ApiError(400, "by_monthday 取值 1-31 或 -1（月末）")


# --------------------------------------------------------------------------- #
# 处理器
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    server_version = "SlowCalendar/1.0"

    def log_message(self, *a):
        if os.environ.get("CALENDAR_LOG"):
            super().log_message(*a)

    # --- 基础响应 ---
    def _send(self, code, obj, extra_headers=None):
        data = json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        if n == 0:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except json.JSONDecodeError:
            raise ApiError(400, "请求体不是合法 JSON")

    def _idempotency_lookup(self, conn, body):
        key = self.headers.get("Idempotency-Key")
        if not key:
            return None
        req_hash = hashlib.sha256(json.dumps(body, sort_keys=True,
                                             ensure_ascii=False).encode()).hexdigest()
        rec = conn.execute("SELECT * FROM idempotency_keys WHERE idempotency_key=?",
                           (key,)).fetchone()
        if rec:
            if rec["request_hash"] != req_hash:
                raise ApiError(409, "幂等键已被不同请求体使用",
                               {"original_path": rec["path"]})
            return {"replayed": True, "code": rec["response_code"],
                    "body": json.loads(rec["response_body"])}
        return {"key": key, "hash": req_hash}

    def _store_idempotency(self, conn, ide, method, path, code, obj):
        if ide and ide.get("key"):
            conn.execute(
                "INSERT OR IGNORE INTO idempotency_keys(idempotency_key,method,path,"
                "request_hash,response_code,response_body) VALUES(?,?,?,?,?,?)",
                (ide["key"], method, path, ide["hash"], code,
                 json.dumps(obj, ensure_ascii=False, default=str)))

    # --- 路由 ---
    def do_GET(self):
        self._dispatch()

    def do_POST(self):
        self._dispatch()

    def do_PUT(self):
        self._dispatch()

    def do_DELETE(self):
        self._dispatch()

    def _dispatch(self):
        u = urlparse(self.path)
        path, qs = u.path.rstrip("/") or "/", parse_qs(u.query)
        # 非 /api/ 请求 => 静态文件（仓库根目录），便于单端口运行前端
        if not path.startswith("/api/") and self.command == "GET":
            return self._serve_static(path)
        conn = init_db(DB_PATH, seed=True)
        try:
            with _write_lock if self.command in ("POST", "PUT", "DELETE") else _null():
                self._route(conn, path, qs)
        except ApiError as e:
            self._send(e.code, {"error": e.message, "details": e.details})
        except KeyError as e:
            self._send(404, {"error": str(e).strip("'")})
        except Exception:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            self._send(500, {"error": "internal error; see server log"})
        finally:
            conn.commit()
            conn.close()

    def _serve_static(self, path):
        import mimetypes
        root = Path(os.environ.get("STATIC_ROOT",
                                   str(Path(__file__).resolve().parent.parent)))
        rel = path.lstrip("/") or "calendar.html"
        if path == "/":
            rel = "calendar.html"
        target = (root / rel).resolve()
        if root.resolve() not in target.parents and target != root.resolve():
            return self._send(403, {"error": "forbidden"})
        if not target.is_file():
            return self._send(404, {"error": f"not found: {path}"})
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype + ("; charset=utf-8"
                                                  if ctype.startswith("text/")
                                                  or ctype.endswith("/javascript")
                                                  or ctype == "application/json" else ""))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def _route(self, conn, path, qs):
        m = self.command
        viewer_tz = qs.get("viewer_tz", [None])[0]
        if viewer_tz:
            try:
                ZoneInfo(viewer_tz)
            except Exception:
                raise ApiError(400, f"无法识别的 viewer_tz: {viewer_tz}")

        if path == "/api/health" and m == "GET":
            return self._send(200, {"ok": True, "now_utc": iso_utc(now_utc())})

        if path == "/api/routes" and m == "GET":
            return self._send(200, [dict(r) for r in conn.execute(
                "SELECT id,code,name,timezone FROM routes ORDER BY id")])

        if path == "/api/construction" and m == "GET":
            return self._send(200, [dict(r) for r in conn.execute(
                "SELECT * FROM route_construction ORDER BY id")])

        if path == "/api/templates" and m == "GET":
            return self._send(200, [dict(r) for r in conn.execute(
                "SELECT id,slug,title,timezone,rrule_freq,rrule_interval,by_weekday,"
                "by_monthday,start_date,end_date,start_time,end_time,route_id,"
                "seg_from,seg_to,poster,version,archived FROM activity_templates "
                "WHERE archived=0 ORDER BY id")])

        # ---- 创建模板 ----
        if path == "/api/templates" and m == "POST":
            body = self._read_json()
            ide = self._idempotency_lookup(conn, body)
            if ide and ide.get("replayed"):
                return self._send(ide["code"], ide["body"],
                                  {"Idempotent-Replay": "true"})
            validate_template_payload(body)
            if conn.execute("SELECT 1 FROM activity_templates WHERE slug=?",
                            (body["slug"],)).fetchone():
                raise ApiError(409, f"slug 已存在: {body['slug']}")
            cur = conn.execute(
                "INSERT INTO activity_templates(slug,title,description,timezone,rrule_freq,"
                "rrule_interval,by_weekday,by_monthday,start_date,end_date,start_time,end_time,"
                "route_id,seg_from,seg_to,poster) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (body["slug"], body["title"], body.get("description", ""), body["timezone"],
                 body["rrule_freq"], int(body.get("rrule_interval", 1)),
                 body.get("by_weekday"), body.get("by_monthday"),
                 body["start_date"], body["end_date"],
                 body.get("start_time", "19:00"), body.get("end_time", "20:30"),
                 body.get("route_id"), float(body.get("seg_from", 0.0)),
                 float(body.get("seg_to", 1000000.0)), body.get("poster", "")))
            tid = cur.lastrowid
            stats = materialize_template(conn, tid, now_utc=now_utc())
            tpl = dict(conn.execute("SELECT * FROM activity_templates WHERE id=?",
                                    (tid,)).fetchone())
            obj = {"template": tpl, "materialize": stats}
            self._store_idempotency(conn, ide, m, path, 201, obj)
            return self._send(201, obj, {"Idempotent-Replay": "false"})

        # ---- 更新模板（改系列；已结束/已例外实例不被覆盖） ----
        if path.startswith("/api/templates/") and path.endswith("/update") and m == "POST":
            tid = int(path.split("/")[3])
            body = self._read_json()
            ide = self._idempotency_lookup(conn, body)
            if ide and ide.get("replayed"):
                return self._send(ide["code"], ide["body"],
                                  {"Idempotent-Replay": "true"})
            tpl = conn.execute("SELECT * FROM activity_templates WHERE id=?", (tid,)).fetchone()
            if tpl is None:
                raise ApiError(404, f"模板不存在: {tid}")
            merged = dict(tpl)
            for k in ("title", "description", "rrule_freq", "by_weekday", "by_monthday",
                      "start_date", "end_date", "start_time", "end_time", "poster",
                      "route_id", "seg_from", "seg_to", "timezone"):
                if k in body:
                    merged[k] = body[k]
            if "rrule_interval" in body:
                merged["rrule_interval"] = int(body["rrule_interval"])
            validate_template_payload(merged)
            fields = ["title", "description", "timezone", "rrule_freq", "rrule_interval",
                      "by_weekday", "by_monthday", "start_date", "end_date", "start_time",
                      "end_time", "route_id", "seg_from", "seg_to", "poster"]
            sets = ", ".join(f"{k}=?" for k in fields) + ", version=version+1, " \
                   "updated_at=datetime('now')"
            conn.execute(f"UPDATE activity_templates SET {sets} WHERE id=?",
                         [merged[k] for k in fields] + [tid])
            stats = materialize_template(conn, tid, now_utc=now_utc())
            new_tpl = dict(conn.execute("SELECT * FROM activity_templates WHERE id=?",
                                        (tid,)).fetchone())
            obj = {"template": new_tpl, "materialize": stats,
                   "note": "已结束(locked)与已挂单次例外的实例保持不变"}
            self._store_idempotency(conn, ide, m, path, 200, obj)
            return self._send(200, obj, {"Idempotent-Replay": "false"})

        # ---- 预览展开（不落库） ----
        if path.startswith("/api/templates/") and path.endswith("/preview") and m == "GET":
            tid = int(path.split("/")[3])
            tpl = dict(conn.execute("SELECT * FROM activity_templates WHERE id=?",
                                    (tid,)).fetchone())
            wf, wt = qs.get("from", [None])[0], qs.get("to", [None])[0]
            occs = expand_rule(tpl, parse_date(wf) if wf else None,
                               parse_date(wt) if wt else None)
            return self._send(200, {"count": len(occs), "occurrences": [
                {"date": o.occ_date.isoformat(), **o.as_row()} for o in occs]})

        # ---- 物化（有界窗口；重复任务幂等） ----
        if path.startswith("/api/templates/") and path.endswith("/materialize") and m == "POST":
            tid = int(path.split("/")[3])
            body = self._read_json()
            ide = self._idempotency_lookup(conn, body)
            if ide and ide.get("replayed"):
                return self._send(ide["code"], ide["body"],
                                  {"Idempotent-Replay": "true"})
            if not conn.execute("SELECT 1 FROM activity_templates WHERE id=?",
                                (tid,)).fetchone():
                raise ApiError(404, f"模板不存在: {tid}")
            stats = materialize_template(conn, tid, body.get("window_from"),
                                         body.get("window_to"), now_utc=now_utc())
            self._store_idempotency(conn, ide, m, path, 200, stats)
            return self._send(200, stats, {"Idempotent-Replay": "false"})

        # ---- 实例列表 / 单实例依据 ----
        if path.startswith("/api/templates/") and "/instances" in path and m == "GET":
            tid = int(path.split("/")[3])
            rows = conn.execute(
                "SELECT * FROM activity_instances WHERE template_id=? ORDER BY orig_occ_date",
                (tid,)).fetchall()
            return self._send(200, [instance_json(conn, r, viewer_tz) for r in rows])

        if path.startswith("/api/instances/") and m == "GET":
            parts = path.split("/")  # /api/instances/<slug>/<date>
            slug, d = parts[3], parts[4]
            tpl = conn.execute("SELECT * FROM activity_templates WHERE slug=?",
                               (slug,)).fetchone()
            if tpl is None:
                raise ApiError(404, f"模板不存在: {slug}")
            inst = conn.execute("SELECT * FROM activity_instances WHERE template_id=? "
                                "AND orig_occ_date=?", (tpl["id"], d)).fetchone()
            if inst is None:
                raise ApiError(404, f"实例不存在: {slug} {d}")
            return self._send(200, instance_json(conn, inst, viewer_tz, with_basis=True))

        # ---- 单次取消 / 改期 / 恢复 ----
        if path.startswith("/api/instances/") and path.endswith("/cancel") and m == "POST":
            return self._instance_exception(conn, path, "CANCEL", self._read_json())
        if path.startswith("/api/instances/") and path.endswith("/reschedule") and m == "POST":
            return self._instance_exception(conn, path, "RESCHEDULE", self._read_json())
        if path.startswith("/api/instances/") and path.endswith("/restore") and m == "POST":
            return self._restore_instance(conn, path, self._read_json())

        # ---- 周推荐 ----
        if path == "/api/weekly" and m == "GET":
            tz = viewer_tz or "Asia/Shanghai"
            anchor = qs.get("at", [None])[0]
            use_cache = qs.get("cache", ["1"])[0] != "0"
            anchor_dt = (datetime.fromisoformat(anchor).replace(tzinfo=timezone.utc)
                         if anchor else now_utc())
            monday, _ = week_window(anchor_dt)
            scope = f"recommend:{tz}:{iso_utc(monday)}"  # 缓存按“浏览者时区+自然周”隔离
            payload, state = get_weekly(conn, scope, tz, anchor, use_cache)
            return self._send(200, {**payload, "cache_state": state,
                                    "cache_version": cache_version(conn)})

        if path == "/api/cache/weekly" and m == "POST":
            # 测试/运维：注入一个“迟到的旧版本缓存”（body.version 可显式伪造旧版本号）
            body = self._read_json()
            tz = body.get("viewer_tz", "Asia/Shanghai")
            ws = body["payload"].get("week_start_utc")
            scope = f"recommend:{tz}:{ws}" if ws else f"recommend:{tz}"
            cur_ver = cache_version(conn)
            inject_ver = int(body.get("version", cur_ver))
            if inject_ver > cur_ver:
                raise ApiError(400, f"注入版本({inject_ver})不能高于当前版本({cur_ver})")
            conn.execute(
                "INSERT INTO weekly_cache(scope,version,payload,computed_at) VALUES(?,?,?,?) "
                "ON CONFLICT(scope) DO UPDATE SET version=excluded.version,payload=excluded.payload,"
                "computed_at=excluded.computed_at",
                (scope, inject_ver, json.dumps(body["payload"], ensure_ascii=False),
                 body["payload"].get("generated_at", iso_utc(now_utc()))))
            return self._send(200, {"accepted": True, "injected_version": inject_ver,
                                    "current_version": cur_ver})

        # ---- 历史（取消/恢复，append-only，海报快照可追溯） ----
        if path == "/api/history" and m == "GET":
            rows = conn.execute(
                "SELECT h.*, t.slug FROM cancellation_history h JOIN activity_templates t "
                "ON t.id=h.template_id ORDER BY h.id DESC").fetchall()
            return self._send(200, [dict(r) for r in rows])

        if path == "/api/exceptions" and m == "GET":
            rows = conn.execute("SELECT e.*, t.slug FROM activity_exceptions e "
                                "JOIN activity_templates t ON t.id=e.template_id ORDER BY e.id")
            return self._send(200, [dict(r) for r in rows])

        raise ApiError(404, f"未找到路由: {m} {path}")

    # --------------------------------------------------------------------- #
    def _instance_exception(self, conn, path, kind, body):
        ide = self._idempotency_lookup(conn, body)
        if ide and ide.get("replayed"):
            return self._send(ide["code"], ide["body"], {"Idempotent-Replay": "true"})
        parts = path.split("/")  # /api/instances/<slug>/<date>/<action>
        slug, d = parts[3], parts[4]
        tpl = conn.execute("SELECT * FROM activity_templates WHERE slug=?",
                           (slug,)).fetchone()
        if tpl is None:
            raise ApiError(404, f"模板不存在: {slug}")
        inst = conn.execute("SELECT * FROM activity_instances WHERE template_id=? "
                            "AND orig_occ_date=?", (tpl["id"], d)).fetchone()
        if inst is None:
            raise ApiError(404, f"实例不存在: {slug} {d}（请先在有界窗口内物化）")
        if body.get("allow_ended") is not True and inst["locked"] \
                and not inst["exception_id"]:
            raise ApiError(409, "该实例已结束并锁定，不能再改单次；如确需操作请显式 allow_ended=true")

        if kind == "RESCHEDULE":
            for k in ("new_date", "new_start_time", "new_end_time"):
                if not body.get(k):
                    raise ApiError(400, f"改期需要 {k}")
            parse_date(body["new_date"]); parse_hm(body["new_start_time"])
            parse_hm(body["new_end_time"])
            collide = conn.execute(
                "SELECT 1 FROM activity_instances WHERE template_id=? AND local_start=? "
                "AND status!='CANCELLED' AND orig_occ_date!=?",
                (tpl["id"], body["new_date"] + "T" + body["new_start_time"], d)).fetchone()
            if collide:
                raise ApiError(409, "改期目标时间与其它实例冲突")

        existing = conn.execute(
            "SELECT * FROM activity_exceptions WHERE template_id=? AND orig_occ_date=?",
            (tpl["id"], d)).fetchone()
        if existing:
            if existing["kind"] == kind and kind == "CANCEL":
                obj = {"already": True, "exception": dict(existing)}
                self._store_idempotency(conn, ide, self.command, path, 200, obj)
                return self._send(200, obj)
            raise ApiError(409, f"该场次已有单次例外: {existing['kind']}，请先恢复")

        cur = conn.execute(
            "INSERT INTO activity_exceptions(template_id,orig_occ_date,kind,new_date,"
            "new_start_time,new_end_time,reason,source,created_by) "
            "VALUES(?,?,?,?,?,?,?,'MANUAL',?)",
            (tpl["id"], d, kind, body.get("new_date"), body.get("new_start_time"),
             body.get("new_end_time"), body.get("reason", ""), body.get("created_by", "editor")))
        materialize_template(conn, tpl["id"], now_utc=now_utc())
        inst2 = conn.execute("SELECT * FROM activity_instances WHERE template_id=? "
                             "AND orig_occ_date=?", (tpl["id"], d)).fetchone()
        obj = {"exception_id": cur.lastrowid, "instance": instance_json(conn, inst2)}
        self._store_idempotency(conn, ide, self.command, path, 200, obj)
        return self._send(200, obj, {"Idempotent-Replay": "false"})

    def _restore_instance(self, conn, path, body):
        ide = self._idempotency_lookup(conn, body)
        if ide and ide.get("replayed"):
            return self._send(ide["code"], ide["body"], {"Idempotent-Replay": "true"})
        parts = path.split("/")
        slug, d = parts[3], parts[4]
        tpl = conn.execute("SELECT * FROM activity_templates WHERE slug=?",
                           (slug,)).fetchone()
        exc = conn.execute("SELECT * FROM activity_exceptions WHERE template_id=? "
                           "AND orig_occ_date=?", (tpl["id"], d)).fetchone()
        if exc is None:
            raise ApiError(404, "该场次没有可恢复的单次例外")
        if exc["source"] == "CONSTRUCTION" and not body.get("allow_construction"):
            raise ApiError(409, "该取消由施工相交产生，仍在施工窗口内；强制恢复需 allow_construction=true")
        from scheduler import _reset_after_exception_removed
        _reset_after_exception_removed(conn, dict(tpl), d,
                                       body.get("reason", "手动恢复"), "MANUAL",
                                       now_utc())
        conn.execute("DELETE FROM activity_exceptions WHERE id=?", (exc["id"],))
        materialize_template(conn, tpl["id"], now_utc=now_utc())
        inst = conn.execute("SELECT * FROM activity_instances WHERE template_id=? "
                            "AND orig_occ_date=?", (tpl["id"], d)).fetchone()
        obj = {"restored": True, "instance": instance_json(conn, inst)}
        self._store_idempotency(conn, ide, self.command, path, 200, obj)
        return self._send(200, obj, {"Idempotent-Replay": "false"})


class _null:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def main(port=None):
    port = int(port or os.environ.get("PORT", "8090"))
    init_db(DB_PATH, seed=True).close()
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"季节年历 API listening on :{port} (now={iso_utc(now_utc())})")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
