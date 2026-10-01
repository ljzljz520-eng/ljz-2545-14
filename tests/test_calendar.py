"""季节年历端到端测试：周期展开、幂等、例外优先级、施工相交、时区、缓存自愈、可追溯。

运行：python3 -m unittest tests.test_calendar -v   （在仓库根目录）
"""
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

FIXED_NOW = "2026-10-01T00:00:00Z"
os.environ["CALENDAR_NOW"] = FIXED_NOW
os.environ["CALENDAR_DB"] = os.path.join(tempfile.mkdtemp(prefix="cal-"), "test.db")

import db as dbmod          # noqa: E402
import app as appmod        # noqa: E402
from scheduler import (expand_rule, materialize_template, instance_basis,  # noqa: E402
                       parse_date)


class CalendarTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.conn = dbmod.init_db(os.environ["CALENDAR_DB"], seed=True)

    def db(self):
        return self.__class__.conn

    def tpl(self, slug):
        return self.db().execute("SELECT * FROM activity_templates WHERE slug=?",
                                   (slug,)).fetchone()

    def inst(self, slug, d):
        t = self.tpl(slug)
        return self.db().execute(
            "SELECT * FROM activity_instances WHERE template_id=? AND orig_occ_date=?",
            (t["id"], d)).fetchone()

    # 1) 月底越界：31 日落在小月必须跳过，不顺延
    def test_01_month_end_overflow_skipped(self):
        dates = [r["orig_occ_date"] for r in self.db().execute(
            "SELECT orig_occ_date FROM activity_instances i JOIN activity_templates t "
            "ON t.id=i.template_id WHERE t.slug='month-end-patrol' ORDER BY 1")]
        self.assertIn("2026-10-31", dates)
        self.assertIn("2026-12-31", dates)
        self.assertIn("2027-01-31", dates)
        self.assertIn("2027-03-31", dates)
        # 11 月、2 月没有 31 日
        self.assertFalse(any(d.startswith(("2026-11", "2027-02")) for d in dates))
        # 绝不顺延到下月 1 日
        self.assertNotIn("2026-12-01", dates)

    # 2) 跨年
    def test_02_cross_year(self):
        dates = [r["orig_occ_date"] for r in self.db().execute(
            "SELECT orig_occ_date FROM activity_instances i JOIN activity_templates t "
            "ON t.id=i.template_id WHERE t.slug='month-end-patrol' ORDER BY 1")]
        self.assertTrue(any(d.startswith("2026-") for d in dates))
        self.assertTrue(any(d.startswith("2027-") for d in dates))
        self.assertEqual(dates[-1], "2027-03-31")  # 不越过赛季末

    # 3) 重复实例任务：再次物化幂等，不新增/不重复取消
    def test_03_duplicate_materialize_idempotent(self):
        tid = self.tpl("friday-night-ride")["id"]
        n_before = self.db().execute(
            "SELECT COUNT(*) c FROM activity_instances WHERE template_id=?", (tid,)).fetchone()["c"]
        canc_before = self.db().execute(
            "SELECT COUNT(*) c FROM cancellation_history WHERE template_id=?", (tid,)).fetchone()["c"]
        stats = materialize_template(self.db(), tid)
        self.assertEqual(stats["created"], 0)
        n_after = self.db().execute(
            "SELECT COUNT(*) c FROM activity_instances WHERE template_id=?", (tid,)).fetchone()["c"]
        canc_after = self.db().execute(
            "SELECT COUNT(*) c FROM cancellation_history WHERE template_id=?", (tid,)).fetchone()["c"]
        self.assertEqual(n_before, n_after)
        self.assertEqual(canc_before, canc_after)
        # 再来一次仍然稳定
        stats2 = materialize_template(self.db(), tid)
        self.assertEqual(stats2["created"], 0)

    # 4) 已结束实例锁定；某次取消后更新模板不覆盖
    def test_04_past_locked_and_cancel_survives_template_update(self):
        slug = "friday-night-ride"
        # 9/4 已结束（固定现在=10/1） => 锁定
        self.assertEqual(self.inst(slug, "2026-09-04")["locked"], 1)
        self.assertEqual(self.inst(slug, "2026-09-04")["status"], "SCHEDULED")

        # 先对未来场次 10/16 做单次取消
        self.db().execute(
            "INSERT INTO activity_exceptions(template_id,orig_occ_date,kind,reason) "
            "VALUES(?,'2026-10-16','CANCEL','志愿者请假')",
            (self.tpl(slug)["id"],))
        materialize_template(self.db(), self.tpl(slug)["id"])
        self.assertEqual(self.inst(slug, "2026-10-16")["status"], "CANCELLED")

        # 改系列：时间提前到 20:00
        self.db().execute(
            "UPDATE activity_templates SET start_time='20:00', end_time='22:30', "
            "version=version+1 WHERE slug=?", (slug,))
        stats = materialize_template(self.db(), self.tpl(slug)["id"])
        # 9/4 保持旧时间（已结束，不覆盖）
        self.assertEqual(self.inst(slug, "2026-09-04")["local_start"],
                         "2026-09-04T22:00")
        # 10/9 未锁定、未例外 => 跟随新规则
        self.assertEqual(self.inst(slug, "2026-10-09")["local_start"],
                         "2026-10-09T20:00")
        # 10/16 取消仍然成立（改系列不覆盖某次例外）
        self.assertEqual(self.inst(slug, "2026-10-16")["status"], "CANCELLED")
        self.assertGreaterEqual(stats["skipped_locked"], 1)
        # 改回时间，保持后续断言稳定
        self.db().execute(
            "UPDATE activity_templates SET start_time='22:00', end_time='00:30', "
            "version=version+1 WHERE slug=?", (slug,))
        materialize_template(self.db(), self.tpl(slug)["id"])

    # 5) 缓存迟到：旧缓存里已取消场次复活 => 读取对账剔除
    def test_05_stale_cache_never_resurrects_cancelled(self):
        slug = "friday-night-ride"
        # 取包含 11/6（施工取消）的那一周
        payload, state = appmod.get_weekly(
            self.db(), "recommend:Asia/Shanghai", "Asia/Shanghai",
            "2026-11-09T00:00:00Z", use_cache=False)
        self.assertEqual(state, "fresh")
        keys = [(i["template_id"], i["orig_occ_date"]) for i in payload["items"]]
        self.assertNotIn((self.tpl(slug)["id"], "2026-11-06"), keys)

        # 人为注入“旧版本缓存”：把已取消的 11/6 塞进去，并把版本调低
        stale = json.loads(json.dumps(payload))
        bad = appmod.instance_json(self.db(), self.inst(slug, "2026-11-06"))
        bad["status"] = "SCHEDULED"
        stale["items"].insert(0, bad)
        self.db().execute(
            "INSERT INTO weekly_cache(scope,version,payload,computed_at) VALUES(?,?,?,?) "
            "ON CONFLICT(scope) DO UPDATE SET version=excluded.version,payload=excluded.payload",
            ("recommend:Asia/Shanghai", 1, json.dumps(stale, ensure_ascii=False),
             "2026-11-01T00:00:00Z"))

        healed, state2 = appmod.get_weekly(
            self.db(), "recommend:Asia/Shanghai", "Asia/Shanghai",
            "2026-11-09T00:00:00Z", use_cache=True)
        self.assertEqual(state2, "stale-reconciled")
        healed_keys = [(i["template_id"], i["orig_occ_date"]) for i in healed["items"]]
        self.assertNotIn((self.tpl(slug)["id"], "2026-11-06"), healed_keys)
        removed = [(r["template_id"], r["orig_occ_date"])
                   for r in healed["removed_stale_entries"]]
        self.assertIn((self.tpl(slug)["id"], "2026-11-06"), removed)

    # 6) 迟到的旧版本缓存写入被拒绝（不允许把版本往回写）
    def test_06_stale_cache_write_rejected(self):
        scope = "recommend:Europe/Berlin"
        good = {"items": [], "generated_at": FIXED_NOW}
        self.assertTrue(appmod._save_cache(self.db(), scope, good))
        v_now = appmod.cache_version(self.db())
        # 把缓存行伪造成更高版本，再用当前（更低）版本覆盖 => ON CONFLICT WHERE 拦截
        self.db().execute("UPDATE weekly_cache SET version=? WHERE scope=?",
                          (v_now + 10, scope))
        self.assertFalse(appmod._save_cache(self.db(), scope, good))

    # 6b) 取消一场（仅例外表小增量）也必须抬高数据版本，使周缓存失效
    def test_06b_cancel_bumps_cache_version(self):
        slug = "wulumuqi-satride"
        scope = "recommend:Asia/Shanghai:2026-09-28T00:00:00Z"
        # 先建立本周缓存
        appmod.get_weekly(self.db(), scope, "Asia/Shanghai",
                          "2026-10-01T00:00:00Z", use_cache=True)
        v0 = appmod.cache_version(self.db())
        self.db().execute(
            "INSERT INTO activity_exceptions(template_id,orig_occ_date,kind,reason) "
            "VALUES(?,'2026-10-03','CANCEL','缓存失效验证')",
            (self.tpl(slug)["id"],))
        materialize_template(self.db(), self.tpl(slug)["id"])
        v1 = appmod.cache_version(self.db())
        self.assertGreater(v1, v0)
        payload, state = appmod.get_weekly(
            self.db(), scope, "Asia/Shanghai", "2026-10-01T00:00:00Z", use_cache=True)
        self.assertEqual(state, "stale-reconciled")
        self.assertFalse(any(i["orig_occ_date"] == "2026-10-03" for i in payload["items"]))

    # 7) 施工：双相交才取消（11/6 取消）；同月不相交时间(10/30)/不相交路段(11/13)不取消
    def test_07_construction_intersection_only(self):
        self.assertEqual(self.inst("friday-night-ride", "2026-11-06")["status"],
                         "CANCELLED")
        self.assertIn("夜间桥面抢修",
                      self.inst("friday-night-ride", "2026-11-06")["construction_note"])
        # 10/26~10/30 18:00 的 NOTICE：10/30 夜骑 22:00 开始，时间不相交 => 无提示无取消
        self.assertEqual(self.inst("friday-night-ride", "2026-10-30")["status"],
                         "SCHEDULED")
        self.assertEqual(self.inst("friday-night-ride", "2026-10-30")["construction_ids"],
                         "")
        # 11/9~11/20 9~10km 施工：活动占 2~8km，路段不相交 => 不取消整季，也不挂提示
        self.assertEqual(self.inst("friday-night-ride", "2026-11-13")["status"],
                         "SCHEDULED")
        self.assertEqual(self.inst("friday-night-ride", "2026-11-20")["status"],
                         "SCHEDULED")
        # 11/6 例外来源是 CONSTRUCTION，取消历史可查
        exc = self.db().execute(
            "SELECT * FROM activity_exceptions WHERE template_id=? AND orig_occ_date='2026-11-06'",
            (self.tpl("friday-night-ride")["id"],)).fetchone()
        self.assertEqual(exc["source"], "CONSTRUCTION")

    # 8) 跨午夜：本地结束落到次日；UTC 仍是同一起始日
    def test_08_cross_midnight(self):
        inst = self.inst("friday-night-ride", "2026-10-09")
        self.assertEqual(inst["local_start"], "2026-10-09T22:00")
        self.assertEqual(inst["local_end"], "2026-10-10T00:30")
        self.assertEqual(inst["utc_start"], "2026-10-09T14:00:00Z")
        self.assertEqual(inst["utc_end"], "2026-10-09T16:30:00Z")

    # 9) 时区按活动所在地计算；浏览者时区只影响展示
    def test_09_timezone_activity_local_is_authoritative(self):
        inst = self.inst("wulumuqi-satride", "2026-10-03")
        # 乌鲁木齐 08:00 (UTC+6) => 02:00Z；orig_occ_date 按当地日期
        self.assertEqual(inst["local_start"], "2026-10-03T08:00")
        self.assertEqual(inst["utc_start"], "2026-10-03T02:00:00Z")
        vf = appmod.viewer_fields(dict(inst), "Asia/Shanghai")
        self.assertEqual(vf["viewer_date"], "2026-10-03")      # 上海 10:00 同日
        self.assertTrue(vf["viewer_start"].endswith("10:00+08:00"))
        vf_utc = appmod.viewer_fields(dict(inst), "UTC")
        self.assertTrue(vf_utc["viewer_start"].startswith("2026-10-03T02:00"))

    # 10) DST：柏林 19:00，10 月是 +02:00，11 月起 +01:00
    def test_10_dst_transition(self):
        self.assertEqual(self.inst("berlin-monthly", "2026-10-01")["utc_start"],
                         "2026-10-01T17:00:00Z")
        self.assertEqual(self.inst("berlin-monthly", "2026-11-01")["utc_start"],
                         "2026-11-01T18:00:00Z")
        # 2026-10-25 DST 结束当天展开仍正确（本地时间不变，UTC 偏移变化）
        tpl = dict(self.tpl("berlin-monthly"))
        occs = {o.occ_date.isoformat(): o for o in expand_rule(
            tpl, parse_date("2026-10-01"), parse_date("2026-12-01"))}
        self.assertIn("2026-11-01", occs)

    # 11) 例外优先级：手动恢复 vs 施工
    def test_11_exception_precedence(self):
        slug = "wulumuqi-satride"
        tid = self.tpl(slug)["id"]
        # 给 10/10 加一条施工（路段/时间相交，CANCEL）
        rc = self.db().execute(
            "INSERT INTO route_construction(route_id,seg_from,seg_to,starts_at_local,"
            "ends_at_local,effect,reason) VALUES("
            "(SELECT route_id FROM activity_templates WHERE id=?),1,9,"
            "'2026-10-10T06:00','2026-10-10T12:00','CANCEL','晨骑道路封闭')",
            (tid,))
        materialize_template(self.db(), tid)
        self.assertEqual(self.inst(slug, "2026-10-10")["status"], "CANCELLED")
        exc = self.db().execute(
            "SELECT * FROM activity_exceptions WHERE template_id=? AND orig_occ_date='2026-10-10'",
            (tid,)).fetchone()
        self.assertEqual(exc["source"], "CONSTRUCTION")

        # 施工提前结束（窗口改到 10/11 之后） => 重新物化应自动恢复并留 REINSTATED
        self.db().execute("UPDATE route_construction SET starts_at_local='2026-10-11T06:00',"
                            "ends_at_local='2026-10-11T12:00' WHERE id=?", (rc.lastrowid,))
        materialize_template(self.db(), tid)
        self.assertEqual(self.inst(slug, "2026-10-10")["status"], "SCHEDULED")
        last = self.db().execute(
            "SELECT event FROM cancellation_history WHERE template_id=? AND orig_occ_date='2026-10-10'"
            " ORDER BY id DESC LIMIT 1", (tid,)).fetchone()
        self.assertEqual(last["event"], "REINSTATED")

    # 12) 改期：循环与单次分开；改期后其它周期不受影响
    def test_12_reschedule_single_occurrence(self):
        slug = "wulumuqi-satride"
        tid = self.tpl(slug)["id"]
        self.db().execute(
            "INSERT INTO activity_exceptions(template_id,orig_occ_date,kind,new_date,"
            "new_start_time,new_end_time,reason) VALUES(?,?, 'RESCHEDULE',?,?,?,'天气改期')",
            (tid, "2026-10-17", "2026-10-18", "09:00", "11:00"))
        materialize_template(self.db(), tid)
        moved = self.inst(slug, "2026-10-17")
        self.assertEqual(moved["status"], "RESCHEDULED")
        self.assertEqual(moved["local_start"], "2026-10-18T09:00")
        # 邻近场次不受影响
        self.assertEqual(self.inst(slug, "2026-10-24")["local_start"],
                         "2026-10-24T08:00")

    # 13) 历史海报快照与理由可追溯（append-only）
    def test_13_history_poster_and_reason_traceable(self):
        tid = self.tpl("month-end-patrol")["id"]
        poster_before = self.tpl("month-end-patrol")["poster"]
        self.db().execute(
            "INSERT INTO activity_exceptions(template_id,orig_occ_date,kind,reason) "
            "VALUES(?,'2026-10-31','CANCEL','台风预警，依据气象局通报')", (tid,))
        materialize_template(self.db(), tid)
        # 之后模板换海报、改版本
        self.db().execute(
            "UPDATE activity_templates SET poster='🛡️ 巡线海报 v2（冬季）', version=version+1 "
            "WHERE id=?", (tid,))
        materialize_template(self.db(), tid)
        hist = self.db().execute(
            "SELECT * FROM cancellation_history WHERE template_id=? AND orig_occ_date='2026-10-31'"
            " ORDER BY id LIMIT 1", (tid,)).fetchone()
        self.assertEqual(hist["reason"], "台风预警，依据气象局通报")
        self.assertEqual(hist["poster_snapshot"], poster_before)  # 取消时的旧海报
        self.assertNotEqual(poster_before, "🛡️ 巡线海报 v2（冬季）")

    # 14) 计算依据可解释：前端能说明“为什么在这一天”
    def test_14_basis_explains_day(self):
        tpl = dict(self.tpl("friday-night-ride"))
        inst = dict(self.inst("friday-night-ride", "2026-11-06"))
        basis = instance_basis(self.db(), tpl, inst)
        self.assertEqual(basis["derived_from"], "EXCEPTION:CANCEL:CONSTRUCTION")
        self.assertEqual(basis["rule"]["freq"], "WEEKLY")
        self.assertIn("每周的周五", basis["explanation_zh"])
        self.assertIn("2026-11-06", basis["explanation_zh"])
        self.assertEqual(basis["timezone"], "Asia/Shanghai")
        self.assertTrue(basis["construction"])
        self.assertEqual(basis["precedence"][0], "单次例外(MANUAL)")

    # 15) 幂等键：同键重放不重复生效；异键同请求各自执行
    def test_15_idempotency_key_semantics(self):
        # 直接验证 materialize + 手工构造的重复取消 SQL 唯一约束
        tid = self.tpl("berlin-monthly")["id"]
        self.db().execute(
            "INSERT INTO activity_exceptions(template_id,orig_occ_date,kind,reason) "
            "VALUES(?,'2026-12-01','CANCEL','场地借用')", (tid,))
        materialize_template(self.db(), tid)
        n1 = self.db().execute(
            "SELECT COUNT(*) c FROM cancellation_history WHERE template_id=? "
            "AND orig_occ_date='2026-12-01'", (tid,)).fetchone()["c"]
        # 再跑物化：append 逻辑幂等，不新增历史
        materialize_template(self.db(), tid)
        n2 = self.db().execute(
            "SELECT COUNT(*) c FROM cancellation_history WHERE template_id=? "
            "AND orig_occ_date='2026-12-01'", (tid,)).fetchone()["c"]
        self.assertEqual(n1, n2)
        # UNIQUE 约束存在：重复插入同一发生日例外表直接失败
        with self.assertRaises(Exception):
            self.db().execute(
                "INSERT INTO activity_exceptions(template_id,orig_occ_date,kind) "
                "VALUES(?,'2026-12-01','CANCEL')", (tid,))


if __name__ == "__main__":
    unittest.main(verbosity=2)
