'use strict';
/** 城市慢行站 · 季节年历 API + 静态站点服务（零框架） */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { openDb } = require('./db');
const svc = require('./service');
const { seedIfEmpty } = require('./seed');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data.sqlite');

const db = openDb(DB_FILE);
seedIfEmpty(db);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.md': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const routes = {
  'GET /api/stations': () => db.prepare('SELECT * FROM stations').all(),
  'GET /api/routes': (q) => {
    const rows = q.station_id
      ? db.prepare('SELECT * FROM routes WHERE station_id = ?').all(q.station_id)
      : db.prepare('SELECT * FROM routes').all();
    return rows.map(r => ({
      ...r,
      segments: db.prepare('SELECT * FROM route_segments WHERE route_id = ? ORDER BY seq').all(r.id),
    }));
  },
  'GET /api/templates': (q) => {
    const rows = q.station_id
      ? db.prepare('SELECT * FROM activity_templates WHERE station_id = ?').all(q.station_id)
      : db.prepare('SELECT * FROM activity_templates').all();
    return rows.map(t => ({ ...t, segment_ids: svc.templateSegments(db, t.id) }));
  },
  'GET /api/calendar': (q) => {
    const from = q.from ? Date.parse(q.from) : Date.now();
    const to = q.to ? Date.parse(q.to) : from + 31 * 86400000;
    return svc.calendarRange(db, q.station_id, from, to, q.viewer_tz || null);
  },
  'GET /api/recommendations/week': (q) =>
    svc.weeklyRecommendations(db, q.station_id, q.ref ? Date.parse(q.ref) : Date.now(), q.viewer_tz || null),
  'GET /api/cancellations': (q) => svc.cancellationHistory(db, q.station_id),
  'GET /api/closures': (q) => q.route_id
    ? db.prepare('SELECT * FROM closures WHERE route_id = ?').all(q.route_id)
    : db.prepare('SELECT * FROM closures').all(),
  'GET /api/exceptions': (q) =>
    db.prepare('SELECT * FROM activity_exceptions WHERE template_id = ?').all(q.template_id),
  'GET /api/revisions': (q) =>
    db.prepare('SELECT * FROM template_revisions WHERE template_id = ? ORDER BY edited_utc DESC').all(q.template_id),

  'POST /api/templates': async (q, body) => ({ id: svc.createTemplate(db, body, Date.now()) }),
  'POST /api/closures': async (q, body) => ({ id: svc.createClosure(db, body, Date.now()) }),
};

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const q = Object.fromEntries(u.searchParams);

    // 动态路由
    let m;
    if (req.method === 'GET' && (m = u.pathname.match(/^\/api\/instances\/([^/]+)\/explain$/))) {
      return sendJson(res, 200, svc.explainInstance(db, decodeURIComponent(m[1]), q.viewer_tz || null));
    }
    if (req.method === 'PUT' && (m = u.pathname.match(/^\/api\/templates\/([^/]+)$/))) {
      const body = await readBody(req);
      svc.updateTemplate(db, decodeURIComponent(m[1]), body, body.edit_reason, Date.now());
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && (m = u.pathname.match(/^\/api\/templates\/([^/]+)\/exceptions$/))) {
      const body = await readBody(req);
      const id = svc.addException(db, {
        templateId: decodeURIComponent(m[1]),
        occurrenceDate: body.occurrence_date,
        kind: body.kind,
        newStartUtc: body.new_start_utc || null,
        reason: body.reason || '',
      }, Date.now());
      return sendJson(res, 200, { id });
    }

    const key = `${req.method} ${u.pathname}`;
    if (routes[key]) {
      const result = await routes[key](q, req.method === 'POST' ? await readBody(req) : undefined);
      return sendJson(res, 200, result);
    }
    if (u.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });

    // 静态文件
    let fp = path.normalize(path.join(ROOT, u.pathname === '/' ? 'index.html' : u.pathname));
    if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    fs.readFile(fp, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.message });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`慢行站季节年历: http://localhost:${PORT}/calendar.html`));
}
module.exports = { server, db };
