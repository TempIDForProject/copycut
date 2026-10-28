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
    uid TEXT NOT NULL,
    title TEXT,
    files_count INTEGER,
    order_no INTEGER,
    uploaded_at TIMESTAMPTZ
  )`);
  for (const col of ['title TEXT', 'files_count INTEGER', 'order_no INTEGER', 'uploaded_at TIMESTAMPTZ']) { // upgrade older tables
    try { await q(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ${col}`); } catch (e) { if (!/syntax|exists/i.test(e.message)) console.error('migration:', e.message); }
  }
  await q('CREATE SEQUENCE IF NOT EXISTS copycut_order_seq START WITH 27 MINVALUE 1'); // order numbers CC-000027, CC-000028 ... (1-26 are reserved)
  await q('CREATE UNIQUE INDEX IF NOT EXISTS orders_order_no_idx ON orders (order_no)');
  await q('CREATE INDEX IF NOT EXISTS orders_uid_idx ON orders (uid)');
  // the older version stored file links in a separate table: keep only the "uploaded" fact, never the links
  try { await q('UPDATE orders SET uploaded_at = CURRENT_TIMESTAMP WHERE uploaded_at IS NULL AND order_id IN (SELECT order_id FROM order_files)'); }
  catch (e) { if (!/does not exist|no such table/i.test(e.message)) console.error('migration:', e.message); }
}

const COLS = 'order_id, order_time, order_value, tracking_id, uid, title, files_count, order_no, uploaded_at';
const toOrder = (r) => ({ orderId: r.order_id, orderNo: r.order_no == null ? null : Number(r.order_no), orderTime: new Date(r.order_time).toISOString(), orderValue: Number(r.order_value), trackingId: r.tracking_id || null, uid: r.uid, title: r.title || '', filesCount: r.files_count == null ? null : Number(r.files_count), uploaded: !!r.uploaded_at });
export const formatOrderNo = (n) => (n == null ? null : 'CC-' + String(n).padStart(6, '0'));

let memSeq = 26;
export async function get(id) {
  if (mode === 'memory') return mem.has(id) ? { ...mem.get(id) } : null;
  const { rows } = await q('SELECT ' + COLS + ' FROM orders WHERE order_id = $1', [id]);
  return rows.length ? toOrder(rows[0]) : null;
}

export async function put(o) { // idempotent; the order number is given here, in sequence, when the payment is confirmed
  if (mode === 'memory') { if (!mem.has(o.orderId)) mem.set(o.orderId, { ...o, orderNo: ++memSeq, uploaded: false }); return; }
  await q("INSERT INTO orders (order_id, order_time, order_value, tracking_id, uid, title, files_count, order_no) VALUES ($1, $2, $3, $4, $5, $6, $7, nextval('copycut_order_seq')) ON CONFLICT (order_id) DO NOTHING",
    [o.orderId, o.orderTime, o.orderValue, o.trackingId ?? null, o.uid, o.title ?? null, o.filesCount ?? null]);
}

export async function markUploaded(id) { // files reached the chat: remember that (only the fact - no files, no links)
  if (mode === 'memory') { const o = mem.get(id); if (!o) return false; o.uploaded = true; return true; }
  const r = await q('UPDATE orders SET uploaded_at = CURRENT_TIMESTAMP WHERE order_id = $1 AND uploaded_at IS NULL', [id]);
  return r.rowCount > 0 || !!(await get(id));
}

export async function setTracking(id, trackingId) {
  if (mode === 'memory') { const o = mem.get(id); if (!o) return false; o.trackingId = trackingId; return true; }
  const r = await q('UPDATE orders SET tracking_id = $2 WHERE order_id = $1', [id, trackingId]);
  return r.rowCount > 0;
}

export async function resolve(ref) { // accepts a Razorpay order id OR a Copycut number like CC-000027 / cc27
  const m = /^cc-?0*(\d+)$/i.exec(String(ref || '').trim());
  if (!m) return String(ref || '');
  if (mode === 'memory') { const f = [...mem.values()].find((o) => o.orderNo === Number(m[1])); return f ? f.orderId : ''; }
  const { rows } = await q('SELECT order_id FROM orders WHERE order_no = $1', [Number(m[1])]);
  return rows.length ? rows[0].order_id : '';
}

export async function list(limit = 1000) { // newest first - for /internal/export backups
  if (mode === 'memory') return [...mem.values()].reverse().slice(0, limit);
  const o = await q('SELECT ' + COLS + ' FROM orders ORDER BY order_time DESC LIMIT $1', [limit]);
  return o.rows.map(toOrder);
}

export async function listByUid(uid, limit = 50) { // one customer's own order history
  if (mode === 'memory') return [...mem.values()].filter((o) => o.uid === uid).reverse().slice(0, limit);
  const o = await q('SELECT ' + COLS + ' FROM orders WHERE uid = $1 ORDER BY order_time DESC LIMIT $2', [uid, limit]);
  return o.rows.map(toOrder);
}

export async function ping() { if (mode === 'postgres') await q('SELECT 1'); }
export async function close() { if (pool) await pool.end(); }
