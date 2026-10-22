// OriginChainDB adapter. Endpoint paths and auth header are configurable by env vars, so you can match
// your OriginChainDB dashboard docs without editing code. Record shape (only these fields are stored):
// { orderId, orderTime, orderValue, fileLinks[], trackingId, uid }
const {
  ORIGINCHAIN_URL: BASE,
  ORIGINCHAIN_KEY: KEY,
  ORIGINCHAIN_AUTH_HEADER: AUTH_HEADER = 'Authorization',
  ORIGINCHAIN_AUTH_SCHEME: AUTH_SCHEME = 'Bearer ',
  OC_PATH_GET = '/orders/{id}',
  OC_PATH_CREATE = '/orders',
  OC_PATH_UPDATE = '/orders/{id}',
  OC_UPDATE_METHOD = 'PATCH',
  OC_TIMEOUT_MS = '10000',
  ALLOW_MEMORY_DB,
} = process.env;

export const mode = BASE ? 'originchaindb' : 'memory';
if (mode === 'memory') {
  if (ALLOW_MEMORY_DB !== 'true') {
    console.error('FATAL: ORIGINCHAIN_URL is not set. Orders would be lost on restart. (Set ALLOW_MEMORY_DB=true only for testing.)');
    process.exit(1);
  }
  console.warn('WARNING: running with in-memory DB (testing only, data is lost on restart).');
}
if (BASE && !KEY) { console.error('FATAL: ORIGINCHAIN_KEY is not set.'); process.exit(1); }

const mem = new Map();
const url = (tpl, id = '') => BASE.replace(/\/+$/, '') + tpl.replace('{id}', encodeURIComponent(id));
const unwrap = (r) => (r && typeof r === 'object' ? (r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : r.record ?? r.row ?? r) : r);

// 10 s timeout + one retry (the free DB may need a moment to wake up)
async function call(method, tpl, id, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Number(OC_TIMEOUT_MS));
    try {
      const r = await fetch(url(tpl, id), {
        method,
        headers: { 'content-type': 'application/json', accept: 'application/json', [AUTH_HEADER]: AUTH_SCHEME + KEY },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
      if (r.status === 404) return null;
      if (r.status >= 500 && attempt === 0) continue;
      if (!r.ok) throw new Error(`OriginChainDB ${method} ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const txt = await r.text();
      return txt ? JSON.parse(txt) : {};
    } catch (e) {
      if (attempt === 1 || String(e.message).startsWith('OriginChainDB')) throw e;
    } finally { clearTimeout(timer); }
  }
  throw new Error('OriginChainDB unavailable');
}

export async function get(id) {
  if (mode === 'memory') return mem.get(id) || null;
  const o = unwrap(await call('GET', OC_PATH_GET, id));
  return o && o.orderId ? o : null;
}
export async function put(o) {
  if (mode === 'memory') { mem.set(o.orderId, o); return; }
  await call('POST', OC_PATH_CREATE, '', o);
}
export async function patch(id, p) {
  const cur = await get(id);
  if (!cur) return false;
  const merged = { ...cur, ...p };
  if (mode === 'memory') mem.set(id, merged);
  else await call(OC_UPDATE_METHOD, OC_PATH_UPDATE, id, merged);
  return true;
}
export async function addFile(id, link) {
  const cur = await get(id);
  if (!cur) return false;
  const links = cur.fileLinks || [];
  if (links.includes(link)) return true;
  return patch(id, { fileLinks: [...links, link] });
}
export async function ping() { if (mode !== 'memory') await call('GET', OC_PATH_GET, '__ping__'); } // keeps the free DB "in use"
