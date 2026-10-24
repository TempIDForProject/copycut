# Copycut Render service (BotKeep Postgres)

Handles: Razorpay order + price (server decides), payment verification + signed receipt, order database, tracking ID.
Database: PostgreSQL (BotKeep) via `PG*` variables or `DATABASE_URL`. Stored per order: order id, order time, order value, file links, tracking id, user id.

## Deploy
1. Render -> New -> Web Service -> your GitHub repo (these files at the repo root): Build `npm install`, Start `npm start`.
2. Environment tab: add the variables below (or use render.yaml as a Blueprint).
3. Razorpay Dashboard (Test Mode) -> Webhooks -> `https://<your-service>.onrender.com/webhook` -> event `payment.captured` -> secret = `RZP_WEBHOOK_SECRET`.
4. UptimeRobot: ping `https://<your-service>.onrender.com/health` every 10 minutes.
Tables are created automatically on the first start (the BotKeep database user needs permission to create tables).

| Name | Value |
|---|---|
| `PGHOST` | `195.32.64.31` (BotKeep -> Host) |
| `PGPORT` | `8765` (BotKeep -> Port) |
| `PGUSER` | `botkeep` (BotKeep -> Username) |
| `PGDATABASE` | `app` (BotKeep -> Database) |
| `PGPASSWORD` | BotKeep -> Password -> tap the eye icon -> Copy (never put it in GitHub) |
| `DATABASE_SSL` | `true` (BotKeep shows TLS). Certificate is not verified unless `DATABASE_SSL_VERIFY=true` |
| `RZP_KEY_ID` | Razorpay (Test Mode) -> API Keys -> Key Id (`rzp_test_...`) |
| `RZP_KEY_SECRET` | Same page, Key Secret |
| `RZP_WEBHOOK_SECRET` | Any long random string; same string goes in the Razorpay webhook |
| `RECEIPT_SECRET` | 64 random hex chars; **same value in the Cloudflare Worker** |
| `INTERNAL_SECRET` | 64 random hex chars; **same value in the Cloudflare Worker** |
| `FIREBASE_PROJECT` | `copycut-000` |
| `ALLOWED_ORIGINS` | Your website origin(s), comma separated, no trailing slash |
| `NODE_VERSION` | `20` |

Instead of the 5 `PG*` variables you can set one `DATABASE_URL` (BotKeep "Connection URI"). If the password contains characters like `# @ / ?` prefer the separate `PG*` variables.
Random value: `openssl rand -hex 32`.
If BotKeep restricts which IPs may connect, allow Render's outbound addresses (Render dashboard -> your service -> Connect -> Outbound) or allow all.

## Owner tools (header `x-internal: <INTERNAL_SECRET>`)
- Set tracking ID: `curl -X POST https://<service>.onrender.com/internal/tracking -H "x-internal: <INTERNAL_SECRET>" -H "Content-Type: application/json" -d '{"orderId":"order_xxx","trackingId":"EW123456789IN"}'`
- One order: `GET /internal/order/order_xxx`
- Backup of recent orders (JSON): `GET /internal/export?limit=1000`  -> save the output regularly

## Database notes
The database is hosted on BotKeep, not on Render, so the 30-day deletion of free Render databases does not apply. Check BotKeep's plan limits and backups yourself, and still take `/internal/export` backups regularly. Latency between Render and BotKeep adds a little time to each query (normal for a database in another data centre).
