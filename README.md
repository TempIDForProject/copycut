# Copycut Render service

Deploy: Render -> New Web Service -> this folder as repo root -> Build `npm install` -> Start `npm start` (or use render.yaml Blueprint). Then add the env vars below. Ping `https://<service>.onrender.com/health` every 10 min (UptimeRobot).

| Name | Value |
|---|---|
| `RZP_KEY_ID` | Razorpay Dashboard (Test Mode) -> Account & Settings -> API Keys -> Key Id (`rzp_test_...`) |
| `RZP_KEY_SECRET` | Same page, Key Secret (shown once when generated) |
| `RZP_WEBHOOK_SECRET` | Any long random string you make up; paste the same string in Razorpay -> Webhooks -> Secret |
| `RECEIPT_SECRET` | Random 64 hex chars (`openssl rand -hex 32`). Same value in the Cloudflare Worker |
| `INTERNAL_SECRET` | Another random 64 hex chars. Same value in the Cloudflare Worker |
| `FIREBASE_PROJECT` | `copycut-000` |
| `ORIGINCHAIN_URL` | Base URL of your OriginChainDB API (from its dashboard), no trailing slash |
| `ORIGINCHAIN_KEY` | OriginChainDB API key |
| `ALLOWED_ORIGINS` | Your web app URL(s), comma separated, no trailing slash, e.g. `https://copycut-app.pages.dev` |
| `NODE_VERSION` | `20` |

Optional (only if your OriginChainDB API differs): `ORIGINCHAIN_AUTH_HEADER` (default `Authorization`), `ORIGINCHAIN_AUTH_SCHEME` (default `Bearer `), `OC_PATH_GET` (`/orders/{id}`), `OC_PATH_CREATE` (`/orders`), `OC_PATH_UPDATE` (`/orders/{id}`), `OC_UPDATE_METHOD` (`PATCH`), `OC_TIMEOUT_MS` (`10000`), `ALLOW_MEMORY_DB` (`true` = testing only).

Razorpay webhook: URL `https://<service>.onrender.com/webhook`, event `payment.captured`.
Set tracking ID: `curl -X POST https://<service>.onrender.com/internal/tracking -H "x-internal: <INTERNAL_SECRET>" -H "Content-Type: application/json" -d '{"orderId":"order_xxx","trackingId":"ABC123"}'`
Look up an order: `curl https://<service>.onrender.com/internal/order/order_xxx -H "x-internal: <INTERNAL_SECRET>"`
