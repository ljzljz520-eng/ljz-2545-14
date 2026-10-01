-- =====================================================================
-- 城市慢行站 · 季节年历 数据库结构
-- 时间约定：所有 *_utc 字段为 ISO8601 UTC 字符串（lexicographic 即可比较），
--          所有 *_local 字段为“活动所在地”墙钟时间，时区存于 stations.tz。
-- =====================================================================

-- 慢行站（活动所在地，时区计算的锚点）
CREATE TABLE IF NOT EXISTS stations (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  tz         TEXT NOT NULL               -- IANA 时区，如 Asia/Shanghai
);

-- 慢行路线
CREATE TABLE IF NOT EXISTS routes (
  id         TEXT PRIMARY KEY,
  station_id TEXT NOT NULL REFERENCES stations(id),
  name       TEXT NOT NULL
);

-- 路线分段（施工通告按段相交判断）
CREATE TABLE IF NOT EXISTS route_segments (
  id       TEXT PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES routes(id),
  seq      INTEGER NOT NULL,
  name     TEXT NOT NULL,
  UNIQUE (route_id, seq)
);

-- 施工/管制通告：仅作用于“相交路段 × 相交时间”
CREATE TABLE IF NOT EXISTS closures (
  id          TEXT PRIMARY KEY,
  route_id    TEXT NOT NULL REFERENCES routes(id),
  segment_id  TEXT REFERENCES route_segments(id),  -- NULL 表示全线
  starts_utc  TEXT NOT NULL,
  ends_utc    TEXT NOT NULL,
  reason      TEXT NOT NULL,
  created_utc TEXT NOT NULL
);

-- 活动模板（循环系列）。修改系列 = 行内升级 version，旧值进 template_revisions；
-- 已结束实例永不被覆盖。
CREATE TABLE IF NOT EXISTS activity_templates (
  id            TEXT PRIMARY KEY,
  station_id    TEXT NOT NULL REFERENCES stations(id),
  route_id      TEXT REFERENCES routes(id),
  title         TEXT NOT NULL,
  season        TEXT NOT NULL,           -- 季节年历标签，如 2026-spring
  poster_url    TEXT NOT NULL DEFAULT '',
  rrule         TEXT NOT NULL,           -- FREQ/INTERVAL/BYDAY/BYMONTHDAY/UNTIL/COUNT
  dtstart_local TEXT NOT NULL,           -- 活动所在地本地首场时间 YYYY-MM-DDTHH:MM:SS
  duration_min  INTEGER NOT NULL CHECK (duration_min > 0),  -- 时长（可跨午夜）
  version       INTEGER NOT NULL DEFAULT 1,
  edit_reason   TEXT NOT NULL DEFAULT '',
  created_utc   TEXT NOT NULL,
  updated_utc   TEXT NOT NULL
);

-- 模板关联路段（活动经过哪些段）
CREATE TABLE IF NOT EXISTS activity_template_segments (
  template_id TEXT NOT NULL REFERENCES activity_templates(id),
  segment_id  TEXT NOT NULL REFERENCES route_segments(id),
  PRIMARY KEY (template_id, segment_id)
);

-- 单次例外：与循环系列分开存放（取消 / 临时改期）
CREATE TABLE IF NOT EXISTS activity_exceptions (
  id              TEXT PRIMARY KEY,
  template_id     TEXT NOT NULL REFERENCES activity_templates(id),
  occurrence_date TEXT NOT NULL,         -- 系列内那一场的站点本地日期
  kind            TEXT NOT NULL CHECK (kind IN ('cancel','reschedule')),
  new_start_utc   TEXT,                  -- kind=reschedule 时的新开始时间
  reason          TEXT NOT NULL,
  created_utc     TEXT NOT NULL,
  UNIQUE (template_id, occurrence_date)  -- 一场只能有一个生效例外
);

-- 发生实例（物化）。id  deterministic => 幂等生成的天然键。
CREATE TABLE IF NOT EXISTS activity_instances (
  id              TEXT PRIMARY KEY,      -- ser:{template}:{date} / exc:{exception}
  template_id     TEXT NOT NULL REFERENCES activity_templates(id),
  occurrence_date TEXT NOT NULL,         -- 站点本地日期（按活动所在地）
  start_utc       TEXT NOT NULL,
  end_utc         TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('scheduled','cancelled','rescheduled')),
  cancel_reason   TEXT,
  poster_url      TEXT NOT NULL,         -- 海报快照：历史海报可追溯
  title_snapshot  TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('series','exception')),
  created_utc     TEXT NOT NULL,
  updated_utc     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_instances_tpl  ON activity_instances(template_id, occurrence_date);
CREATE INDEX IF NOT EXISTS idx_instances_span ON activity_instances(start_utc, end_utc);

-- 取消历史（理由 + 当时海报快照，可追溯）
CREATE TABLE IF NOT EXISTS cancellation_history (
  id              TEXT PRIMARY KEY,      -- his:{instance_id}，幂等
  instance_id     TEXT NOT NULL,
  template_id     TEXT NOT NULL,
  occurrence_date TEXT NOT NULL,
  reason          TEXT NOT NULL,
  poster_url      TEXT NOT NULL,
  cancelled_utc   TEXT NOT NULL
);

-- 系列修改审计（每次编辑留快照与理由）
CREATE TABLE IF NOT EXISTS template_revisions (
  id            TEXT PRIMARY KEY,
  template_id   TEXT NOT NULL,
  version       INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  edit_reason   TEXT NOT NULL,
  edited_utc    TEXT NOT NULL
);

-- 数据版本号：缓存失效信号（写操作 bump，读缓存按版本比对）
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
