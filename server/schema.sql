-- ============================================================
-- 城市慢行站 · 季节年历 数据模型
-- 设计要点:
--   1. 活动模板(activity_templates) 保存“系列”规则；发生实例(activity_instances)
--      是服务端按有界窗口展开的物化结果，二者分离。
--   2. 单次例外(activity_exceptions) 只锚定某一次实例(orig_occ_date)，
--      CANCEL / RESCHEDULE / RESTORE 都不改模板。
--   3. 取消历史(cancellation_history) 仅追加(append-only)，记录海报快照与理由，
--      便于历史追溯；REinstATE 也留痕，绝不物理删除取消事实。
--   4. 所有“挂钟时间”均以活动所在地时区解释(local_* 列)，
--      utc_* 仅为换算结果，供排序/跨时区查询。浏览者时区只在展示层生效。
--   5. UNIQUE(template_id, orig_occ_date) 是“重复实例任务”幂等的数据库级硬保证。
-- ============================================================

PRAGMA foreign_keys = ON;

-- 慢行路线（可用 GeoJSON LineString 的 bbox 做粗筛，geometry 做精确相交）
CREATE TABLE IF NOT EXISTS routes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    code          TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    timezone      TEXT NOT NULL,                       -- 路线/活动所在地时区 IANA 名
    geometry      TEXT NOT NULL,                       -- GeoJSON LineString
    bbox          TEXT NOT NULL,                       -- [minx,miny,maxx,maxy]
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 路线施工提示：仅对“相交路段 + 相交时间”生效
CREATE TABLE IF NOT EXISTS route_construction (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id      INTEGER NOT NULL REFERENCES routes(id),
    seg_from      REAL NOT NULL,                       -- 施工段里程区间(km)
    seg_to        REAL NOT NULL,
    starts_at_local TEXT NOT NULL,                     -- 施工窗口（以路线所在地本地时间解释）
    ends_at_local   TEXT NOT NULL,
    effect        TEXT NOT NULL DEFAULT 'NOTICE'
                    CHECK (effect IN ('NOTICE','CANCEL')),
    reason        TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_constr_route ON route_construction(route_id);

-- 活动模板（系列规则）
CREATE TABLE IF NOT EXISTS activity_templates (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    slug            TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    timezone        TEXT NOT NULL,                     -- 活动所在地时区
    rrule_freq      TEXT NOT NULL CHECK (rrule_freq IN ('DAILY','WEEKLY','MONTHLY')),
    rrule_interval  INTEGER NOT NULL DEFAULT 1 CHECK (rrule_interval > 0),
    by_weekday      TEXT,                              -- WEEKLY: 0-6 逗号分隔, 0=周一
    by_monthday     TEXT,                              -- MONTHLY: 1..31 / -1 逗号分隔
    start_date      TEXT NOT NULL,                     -- 系列本地开始日期 YYYY-MM-DD
    end_date        TEXT NOT NULL,                     -- 系列本地结束日期(有界, 含当日)
    start_time      TEXT NOT NULL DEFAULT '19:00',     -- 本地开始 HH:MM
    end_time        TEXT NOT NULL DEFAULT '20:30',     -- 本地结束 HH:MM（可跨午夜）
    route_id        INTEGER REFERENCES routes(id),
    seg_from        REAL NOT NULL DEFAULT 0.0,        -- 活动占用路线里程起(km)
    seg_to          REAL NOT NULL DEFAULT 1000000.0,  -- 活动占用路线里程止(km)
    poster          TEXT NOT NULL DEFAULT '',
    version         INTEGER NOT NULL DEFAULT 1,        -- 模板版本（更新递增）
    archived        INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (end_date >= start_date),
    CHECK (time(end_time) IS NOT NULL AND time(start_time) IS NOT NULL)
);

-- 单次例外：锚定“原始发生日”，模板更新不影响这些行
CREATE TABLE IF NOT EXISTS activity_exceptions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id     INTEGER NOT NULL REFERENCES activity_templates(id),
    orig_occ_date   TEXT NOT NULL,                     -- 原始本地发生日期 YYYY-MM-DD
    kind            TEXT NOT NULL CHECK (kind IN ('CANCEL','RESCHEDULE')),
    new_date        TEXT,                              -- RESCHEDULE: 新本地日期
    new_start_time  TEXT,                              -- RESCHEDULE: 新本地开始
    new_end_time    TEXT,                              -- RESCHEDULE: 新本地结束(可跨午夜)
    reason          TEXT NOT NULL DEFAULT '',
    source          TEXT NOT NULL DEFAULT 'MANUAL'
                      CHECK (source IN ('MANUAL','CONSTRUCTION')),
    created_by      TEXT NOT NULL DEFAULT 'editor',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (template_id, orig_occ_date)               -- 同一发生日只有一条权威例外
);

-- 物化发生实例（有界展开结果；幂等 upsert 的目标）
CREATE TABLE IF NOT EXISTS activity_instances (
    template_id        INTEGER NOT NULL REFERENCES activity_templates(id),
    orig_occ_date      TEXT NOT NULL,                 -- 系列规则下的原始发生日
    local_start        TEXT NOT NULL,                 -- 生效本地起始（改期后可能不同于原始）
    local_end          TEXT NOT NULL,                 -- 生效本地结束（可跨午夜/跨日）
    utc_start          TEXT NOT NULL,
    utc_end            TEXT NOT NULL,
    base_local_start   TEXT NOT NULL,                 -- 不含例外时模板算出的起始（解锁恢复用）
    base_local_end     TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'SCHEDULED'
                         CHECK (status IN ('SCHEDULED','CANCELLED','RESCHEDULED')),
    exception_id       INTEGER REFERENCES activity_exceptions(id),
    construction_ids   TEXT NOT NULL DEFAULT '',       -- 命中的施工提示 id，逗号分隔
    construction_note  TEXT NOT NULL DEFAULT '',
    rule_version       INTEGER NOT NULL,               -- 生成时模板版本
    locked             INTEGER NOT NULL DEFAULT 0,     -- 已结束/已例外 => 模板更新不改写
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (template_id, orig_occ_date)
);
CREATE INDEX IF NOT EXISTS idx_inst_utc ON activity_instances(utc_start, utc_end);
CREATE INDEX IF NOT EXISTS idx_inst_status ON activity_instances(status);

-- 取消历史（append-only；海报快照 + 理由，可追溯）
CREATE TABLE IF NOT EXISTS cancellation_history (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id      INTEGER NOT NULL,
    orig_occ_date    TEXT NOT NULL,
    title            TEXT NOT NULL,
    poster_snapshot  TEXT NOT NULL DEFAULT '',
    reason           TEXT NOT NULL DEFAULT '',
    source           TEXT NOT NULL DEFAULT 'MANUAL',
    event            TEXT NOT NULL DEFAULT 'CANCELLED'
                       CHECK (event IN ('CANCELLED','REINSTATED')),
    actor            TEXT NOT NULL DEFAULT 'editor',
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cancel_tpl ON cancellation_history(template_id, orig_occ_date);

-- 幂等键：同一请求重放返回同一结果，绝不重复生成/重复取消
CREATE TABLE IF NOT EXISTS idempotency_keys (
    idempotency_key TEXT PRIMARY KEY,
    method          TEXT NOT NULL,
    path            TEXT NOT NULL,
    request_hash    TEXT NOT NULL,
    response_code   INTEGER NOT NULL,
    response_body   TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 本周推荐的版本化缓存（迟到的旧版本缓存写入会被拒绝）
CREATE TABLE IF NOT EXISTS weekly_cache (
    scope           TEXT PRIMARY KEY,                  -- 如 recommend:Asia/Shanghai:2026-10-05T00:00:00Z
    version         INTEGER NOT NULL,
    payload         TEXT NOT NULL,
    computed_at     TEXT NOT NULL
);

-- ============================================================
-- 全局数据版本：任何影响周推荐/月历结果的写入（模板、实例、例外、
-- 取消历史、施工）都会经触发器 +1；据此判断缓存是否过时。
-- 这样取消历史/例外表的小 id 增量不会被实例表的高 rowid 掩盖。
-- ============================================================
CREATE TABLE IF NOT EXISTS calendar_meta (
    k TEXT PRIMARY KEY,
    v INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO calendar_meta(k, v) VALUES ('data_version', 0);
CREATE TRIGGER IF NOT EXISTS trg_ver_activity_templates_INSERT
    AFTER INSERT ON activity_templates
    BEGIN UPDATE calendar_meta SET v = v + 1 WHERE k = 'data_version'; END;
CREATE TRIGGER IF NOT EXISTS trg_ver_activity_templates_UPDATE
    AFTER UPDATE ON activity_templates
    BEGIN UPDATE calendar_meta SET v = v + 1 WHERE k = 'data_version'; END;
CREATE TRIGGER IF NOT EXISTS trg_ver_activity_templates_DELETE
    AFTER DELETE ON activity_templates
    BEGIN UPDATE calendar_meta SET v = v + 1 WHERE k = 'data_version'; END;
CREATE TRIGGER IF NOT EXISTS trg_ver_activity_instances_INSERT
    AFTER INSERT ON activity_instances
    BEGIN UPDATE calendar_meta SET v = v + 1 WHERE k = 'data_version'; END;
CREATE TRIGGER IF NOT EXISTS trg_ver_activity_instances_UPDATE
    AFTER UPDATE ON activity_instances
    BEGIN UPDATE calendar_meta SET v = v + 1 WHERE k = 'data_version'; END;
CREATE TRIGGER IF NOT EXISTS trg_ver_activity_instances_DELETE
    AFTER DELETE ON activity_instances
    BEGIN UPDATE calendar_meta SET v = v + 1 WHERE k = 'data_version'; END;
CREATE TRIGGER IF NOT EXISTS trg_ver_activity_exceptions_INSERT
    AFTER INSERT ON activity_exceptions
    BEGIN UPDATE calendar_meta SET v = v + 1 WHERE k = 'data_version'; END;
CREATE TRIGGER IF NOT EXISTS trg_ver_activity_exceptions_UPDATE
    AFTER UPDATE ON activity_exceptions
    BEGIN UPDATE calendar_meta SET v = v + 1 WHERE k = 'data_version'; END;
CREATE TRIGGER IF NOT EXISTS trg_ver_activity_exceptions_DELETE
    AFTER DELETE ON activity_exceptions
    BEGIN UPDATE calendar_meta SET v = v + 1 WHERE k = 'data_version'; END;
CREATE TRIGGER IF NOT EXISTS trg_ver_cancellation_history_INSERT
    AFTER INSERT ON cancellation_history
    BEGIN UPDATE calendar_meta SET v = v + 1 WHERE k = 'data_version'; END;
CREATE TRIGGER IF NOT EXISTS trg_ver_cancellation_history_UPDATE
    AFTER UPDATE ON cancellation_history
    BEGIN UPDATE calendar_meta SET v = v + 1 WHERE k = 'data_version'; END;
CREATE TRIGGER IF NOT EXISTS trg_ver_cancellation_history_DELETE
    AFTER DELETE ON cancellation_history
    BEGIN UPDATE calendar_meta SET v = v + 1 WHERE k = 'data_version'; END;
CREATE TRIGGER IF NOT EXISTS trg_ver_route_construction_INSERT
    AFTER INSERT ON route_construction
    BEGIN UPDATE calendar_meta SET v = v + 1 WHERE k = 'data_version'; END;
CREATE TRIGGER IF NOT EXISTS trg_ver_route_construction_UPDATE
    AFTER UPDATE ON route_construction
    BEGIN UPDATE calendar_meta SET v = v + 1 WHERE k = 'data_version'; END;
CREATE TRIGGER IF NOT EXISTS trg_ver_route_construction_DELETE
    AFTER DELETE ON route_construction
    BEGIN UPDATE calendar_meta SET v = v + 1 WHERE k = 'data_version'; END;
