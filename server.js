import express from 'express';
import rateLimit from 'express-rate-limit';
import Razorpay from 'razorpay';
import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import * as db from './db.js';

// ---------- Config & startup checks ----------
const E = process.env;
const missing = ['RZP_KEY_ID', 'RZP_KEY_SECRET', 'RZP_WEBHOOK_SECRET', 'RECEIPT_SECRET', 'INTERNAL_SECRET', 'ALLOWED_ORIGINS'].filter((k) => !E[k]);
if (missing.length) { console.error('FATAL: missing env vars:', missing.join(', ')); process.exit(1); }
if (E.RECEIPT_SECRET.length < 32 || E.INTERNAL_SECRET.length < 32) { console.error('FATAL: RECEIPT_SECRET and INTERNAL_SECRET must be at least 32 characters.'); process.exit(1); }
const FIREBASE_PROJECT = E.FIREBASE_PROJECT || 'copycut-000';
const PORT = E.PORT || 3000;
const ORIGINS = E.ALLOWED_ORIGINS.split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean);
const rzp = new Razorpay({ key_id: E.RZP_KEY_ID, key_secret: E.RZP_KEY_SECRET });
console.log(`Razorpay mode: ${E.RZP_KEY_ID.startsWith('rzp_live_') ? 'LIVE' : 'TEST'} | DB: ${db.mode} | Firebase project: ${FIREBASE_PROJECT}`);

const jwks = createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'));
const hmac = (secret, msg) => crypto.createHmac('sha256', secret).update(msg).digest('hex');
const same = (a, b) => { a = String(a); b = String(b); return a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); };
const s = (v, n) => String(v ?? '').slice(0, n);

// ---------- App & middleware ----------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => { // CORS: only your own web app origin(s)
  const o = req.headers.origin;
  if (o && ORIGINS.includes(o)) res.set({ 'Access-Control-Allow-Origin': o, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '86400' });
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
app.use('/webhook', express.raw({ type: '*/*', limit: '200kb' })); // raw body needed for signature check
app.use(express.json({ limit: '20kb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));
const createLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

async function auth(req, res, next) { // Firebase ID token (from the browser)
  try {
    const t = (req.headers.authorization || '').replace(/^Bearer /, '');
    const { payload } = await jwtVerify(t, jwks, { issuer: `https://securetoken.google.com/${FIREBASE_PROJECT}`, audience: FIREBASE_PROJECT });
    req.uid = payload.sub; next();
  } catch { res.status(401).json({ error: 'auth' }); }
}
const internal = (req, res, next) => (same(req.headers['x-internal'] || '', E.INTERNAL_SECRET) ? next() : res.status(403).json({ error: 'forbidden' }));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- Pricing (paise). Same rules as the website; client amount is never trusted ----------
const BIND = { stapler: (p) => p * 4, soft: (p) => Math.ceil(p / 300) * 3500, spiral: (p) => Math.ceil(p / 150) * 2500 };
function price(items, express) {
  if (!Array.isArray(items) || !items.length || items.length > 10) return null;
  let pages = 0, bind = 0;
  for (const i of items) {
    if (!i || !Number.isInteger(i.pages) || i.pages < 1 || i.pages > 500 || !Object.hasOwn(BIND, i.binding)) return null;
    pages += i.pages; bind += BIND[i.binding](i.pages);
  }
  const delivery = pages <= 200 ? 3500 : pages <= 400 ? 4500 : 5500;
  return pages * 75 + bind + delivery + 1000 + (express ? 1000 : 0);
}

// ---------- Health (ping every ~10 min with UptimeRobot to keep the free instance awake) ----------
let lastDbPing = 0;
app.get('/health', (_, res) => {
  res.send('ok');
  if (Date.now() - lastDbPing > 12 * 3600e3) { lastDbPing = Date.now(); db.ping().catch(() => {}); } // keeps the free DB from being deleted for inactivity
});

// ---------- Orders ----------
app.post('/create-order', createLimiter, auth, wrap(async (req, res) => {
  const { items, express: ex, form = {}, names } = req.body || {};
  const title = (Array.isArray(names) ? names.slice(0, 10) : []).map((n) => s(n, 60)).join(', ');
  const amount = price(items, !!ex);
  if (!amount) return res.status(400).json({ error: 'bad items' });
  if (!/^[6-9]\d{9}$/.test(String(form.phone || '')) || !/^\S+@\S+\.\S+$/.test(String(form.email || '')) || !String(form.name || '').trim() || !String(form.addr || '').trim()) return res.status(400).json({ error: 'bad form' });
  const o = await rzp.orders.create({
    amount, currency: 'INR', receipt: 'cc_' + Date.now(),
    notes: { uid: req.uid, name: s(form.name, 60), phone: s(form.phone, 15), email: s(form.email, 80), addr: s(form.addr, 250), speed: ex ? 'express' : 'economical', items: items.map((i) => `${i.pages}p/${i.binding}`).join(','), title: s(title, 200), files: String(items.length) },
  });
  res.json({ orderId: o.id, amount: o.amount, keyId: E.RZP_KEY_ID });
}));

// Idempotent: used by /verify, /order-status and the webhook. Stateless - customer data is read back from the Razorpay order.
const inflight = new Map();
function finalize(oid, pid) {
  if (inflight.has(oid)) return inflight.get(oid);
  const p = doFinalize(oid, pid).finally(() => inflight.delete(oid));
  inflight.set(oid, p); return p;
}
async function doFinalize(oid, pid) {
  const [o, p] = await Promise.all([rzp.orders.fetch(oid), rzp.payments.fetch(pid)]);
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  if (p.order_id !== oid || p.amount !== o.amount) throw bad('mismatch');
  if (p.status === 'authorized') await rzp.payments.capture(pid, o.amount, 'INR');
  else if (p.status !== 'captured') throw bad('not paid');
  const n = o.notes;
  const raw = JSON.stringify({ oid, pid, amt: o.amount / 100, uid: n.uid, ts: p.created_at * 1000, name: n.name, phone: n.phone, email: n.email, addr: n.addr, speed: n.speed, items: n.items });
  if (!(await db.get(oid))) await db.put({ orderId: oid, orderTime: new Date(p.created_at * 1000).toISOString(), orderValue: o.amount / 100, fileLinks: [], trackingId: null, uid: n.uid, title: n.title || '', filesCount: Number(n.files) || null });
  return { raw, sig: hmac(E.RECEIPT_SECRET, raw) }; // signed receipt, verified again by the Cloudflare Worker
}

app.post('/verify', auth, wrap(async (req, res) => {
  const { orderId, paymentId, signature } = req.body || {};
  if (!orderId || !paymentId || !signature) return res.status(400).json({ error: 'missing fields' });
  if (!same(hmac(E.RZP_KEY_SECRET, `${orderId}|${paymentId}`), signature)) return res.status(400).json({ error: 'bad signature' });
  const o = await rzp.orders.fetch(orderId);
  if (o.notes.uid !== req.uid) return res.status(403).json({ error: 'not yours' });
  res.json(await finalize(orderId, paymentId));
}));

// Browser closed right after paying (no payment id): recover the receipt.
app.get('/order-status/:oid', auth, wrap(async (req, res) => {
  const o = await rzp.orders.fetch(req.params.oid);
  if (o.notes.uid !== req.uid) return res.status(403).json({ error: 'not yours' });
  const pays = await rzp.orders.fetchPayments(req.params.oid);
  const ok = pays.items.find((x) => x.status === 'captured' || x.status === 'authorized');
  if (!ok) return res.status(404).json({ error: 'unpaid' });
  res.json(await finalize(req.params.oid, ok.id));
}));

// Razorpay Dashboard -> Webhooks -> URL https://<your-render>.onrender.com/webhook -> event: payment.captured
app.post('/webhook', wrap(async (req, res) => {
  const sig = req.headers['x-razorpay-signature'] || '';
  if (!Buffer.isBuffer(req.body) || !same(hmac(E.RZP_WEBHOOK_SECRET, req.body), sig)) return res.status(400).end();
  const ev = JSON.parse(req.body.toString('utf8'));
  if (ev.event === 'payment.captured') { const p = ev.payload.payment.entity; if (p.order_id) await finalize(p.order_id, p.id); }
  res.json({ ok: true });
}));

// Each customer's own order history + tracking IDs (kept on the server, tied to the Firebase account)
app.get('/my-orders', auth, wrap(async (req, res) => {
  const list = await db.listByUid(req.uid, 50);
  res.set('Cache-Control', 'no-store');
  res.json({ orders: list.map((o) => ({ orderId: o.orderId, orderTime: o.orderTime, orderValue: o.orderValue, title: o.title || '', filesCount: o.filesCount, trackingId: o.trackingId, uploaded: o.uploaded })) });
}));

app.get('/track/:oid', auth, wrap(async (req, res) => {
  const o = await db.get(req.params.oid);
  if (!o || o.uid !== req.uid) return res.status(404).json({ error: 'none' });
  res.json({ trackingId: o.trackingId || null });
}));

// ---------- Internal (Worker / you). All need header x-internal: <INTERNAL_SECRET> ----------
app.post('/internal/claim', internal, wrap(async (req, res) => { // Worker: one upload per paid order
  const o = await db.get(String(req.body?.orderId || ''));
  if (!o) return res.status(404).json({ error: 'no order' });
  if ((o.fileLinks || []).length) return res.status(409).json({ error: 'already uploaded' });
  res.json({ ok: true });
}));
app.post('/internal/files', internal, wrap(async (req, res) => { // Worker: save one-click download link
  const ok = await db.addFile(String(req.body?.orderId || ''), s(req.body?.link, 600));
  res.status(ok ? 200 : 404).json({ ok });
}));
app.post('/internal/tracking', internal, wrap(async (req, res) => { // you: set tracking ID after shipping
  const ok = await db.setTracking(String(req.body?.orderId || ''), s(req.body?.trackingId, 40));
  res.status(ok ? 200 : 404).json({ ok });
}));
app.get('/internal/export', internal, wrap(async (req, res) => { // you: backup of recent orders as JSON (?limit=1000, max 10000)
  const limit = Math.min(Math.max(parseInt(req.query && req.query.limit, 10) || 1000, 1), 10000);
  const orders = await db.list(limit);
  res.json({ count: orders.length, orders });
}));
app.get('/internal/order/:oid', internal, wrap(async (req, res) => { // you: look up one order
  const o = await db.get(req.params.oid);
  o ? res.json(o) : res.status(404).json({ error: 'none' });
}));

// ---------- Errors ----------
app.use((req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, req, res, _next) => { console.error(req.method, req.path, err && err.message); res.status((err && err.status) || (err && err.type === 'entity.parse.failed' ? 400 : 500)).json({ error: 'server' }); });
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));

await db.init(); // creates the tables on first start
app.listen(PORT, () => console.log('copycut-render listening on', PORT));
