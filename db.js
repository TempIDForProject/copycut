// Order database: any PostgreSQL (BotKeep, Render, Neon, Supabase ...).
// Stores only: order id, order time, order value, file links, tracking id, user id (Firebase UID).
import pg from 'pg';

const { DATABASE_URL, PGHOST, DATABASE_SSL, DATABASE_SSL_VERIFY, ALLOW_MEMORY_DB } = process.env;
// Either DATABASE_URL, or the separate PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE variables (easier when the password has special characters).
export const mode = (DATABASE_URL || PGHOST) ? 'postgres' : 'memory';
if (mode === 'memory') {
  if (ALLOW_MEMORY_DB !== 'true') { console.error('FATAL: database is not configured (set PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE or DATABASE_URL). Orders would be lost on restart. (ALLOW_MEMORY_DB=true is for testing only.)'); process.exit(1); }
  console.warn('WARNING: running with an in-memory database (testing only, data is lost on restart).');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mem = new Map();
let pool = null;
if (mode === 'postgres') {
  const cfg = { max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 };
  if (DATABASE_URL) { const u = new URL(DATABASE_URL); u.searchParams.delete('sslmode'); u.searchParams.delete('ssl'); cfg.connectionString = u.toString(); }
  // Encrypted (TLS) connection is ON by default. The certificate is only verified when DATABASE_SSL_VERIFY=true
  // (hosted databases reached by a bare IP address usually cannot be verified). Use DATABASE_SSL=false only for a local database.
  if (DATABASE_SSL !== 'false') cfg.ssl = { rejectUnauthorized: DATABASE_SSL_VERIFY === 'true' };
  pool = new pg.Pool(cfg);
  pool.on('error', (e) => console.error('pg pool error:', e.message));
}

async function q(text, params = []) { // one retry for connection hiccups (free Postgres can restart)
  for (let attempt = 0; ; attempt++) {
    try { return await pool.query(text, params); }
    catch (e) {
      const transient = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|terminating connection|Connection terminated|timeout/i.test(String(e.code) + ' ' + e.message) || /^(08|57P0)/.test(String(e.code));
      if (attempt >= 1 || !transient) throw e;
      await sleep(600);
    }
  }
}

export async function init() {
  if (mode !== 'postgres') return;
  await q(`CREATE TABLE IF NOT EXISTS orders (
    order_id TEXT PRIMARY KEY,
    order_time TIMESTAMPTZ NOT NULL,
    order_value NUMERIC(10,2) NOT NULL,
    tracking_id TEXT,
    uid TEXT NOT NULL
  )`);
  await q(`CREATE TABLE IF NOT EXISTS order_files (
    order_id TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
    link TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (order_id, link)
  )`);
  await q('CREATE INDEX IF NOT EXISTS orders_uid_idx ON orders (uid)');
}

const toOrder = (r, links) => ({ orderId: r.order_id, orderTime: new Date(r.order_time).toISOString(), orderValue: Number(r.order_value), fileLinks: links, trackingId: r.tracking_id || null, uid: r.uid });

export async function get(id) {
  if (mode === 'memory') return mem.get(id) || null;
  const { rows } = await q('SELECT order_id, order_time, order_value, tracking_id, uid FROM orders WHERE order_id = $1', [id]);
  if (!rows.length) return null;
  const f = await q('SELECT link FROM order_files WHERE order_id = $1 ORDER BY created_at, link', [id]);
  return toOrder(rows[0], f.rows.map((x) => x.link));
}

export async function put(o) { // idempotent: a second insert of the same order is ignored
  if (mode === 'memory') { if (!mem.has(o.orderId)) mem.set(o.orderId, { ...o, fileLinks: o.fileLinks || [] }); return; }
  await q('INSERT INTO orders (order_id, order_time, order_value, tracking_id, uid) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (order_id) DO NOTHING',
    [o.orderId, o.orderTime, o.orderValue, o.trackingId ?? null, o.uid]);
}

export async function addFile(id, link) { // true if the order exists
  if (mode === 'memory') { const o = mem.get(id); if (!o) return false; if (!o.fileLinks.includes(link)) o.fileLinks.push(link); return true; }
  const r = await q('INSERT INTO order_files (order_id, link) SELECT $1::text, $2::text WHERE EXISTS (SELECT 1 FROM orders WHERE order_id = $1) ON CONFLICT (order_id, link) DO NOTHING', [id, link]);
  if (r.rowCount > 0) return true;
  return !!(await get(id));
}

export async function setTracking(id, trackingId) {
  if (mode === 'memory') { const o = mem.get(id); if (!o) return false; o.trackingId = trackingId; return true; }
  const r = await q('UPDATE orders SET tracking_id = $2 WHERE order_id = $1', [id, trackingId]);
  return r.rowCount > 0;
}

export async function list(limit = 1000) { // newest first - used by /internal/export for backups
  if (mode === 'memory') return [...mem.values()].reverse().slice(0, limit);
  const o = await q('SELECT order_id, order_time, order_value, tracking_id, uid FROM orders ORDER BY order_time DESC LIMIT $1', [limit]);
  const f = await q('SELECT f.order_id, f.link FROM order_files f JOIN (SELECT order_id FROM orders ORDER BY order_time DESC LIMIT $1) o ON o.order_id = f.order_id ORDER BY f.created_at, f.link', [limit]);
  const by = {}; f.rows.forEach((x) => { (by[x.order_id] = by[x.order_id] || []).push(x.link); });
  return o.rows.map((r) => toOrder(r, by[r.order_id] || []));
}

export async function ping() { if (mode === 'postgres') await q('SELECT 1'); }
export async function close() { if (pool) await pool.end(); }
