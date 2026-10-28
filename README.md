# Copycut backend (Node.js on BotKeep + BotKeep PostgreSQL)

Does: Razorpay order + price (server decides, includes the 2% gateway fee), payment verification + signed receipt, per-customer order history (`GET /my-orders`), tracking IDs, owner tools.

## Deploy on Render (current setup) - same code also runs on BotKeep
Render -> New Web Service -> GitHub repo (these files at the repo root) -> Build `npm install` -> Start `npm start` -> add the variables below. The database stays on BotKeep PostgreSQL (`PG*` variables).
Tracking: put either a full tracking URL or just an id in the tracking field. For plain ids set `TRACKING_URL_TEMPLATE` (e.g. `https://www.delhivery.com/track/package/{id}`) so the customer's **Track Order** button can open the right page. The id / link itself is never shown to customers.
Order numbers: `CC-000027`, `CC-000028` ... (a database sequence starting at 27). Owner commands accept these numbers (e.g. `"orderId":"CC-000027"`).
No files and no file links are stored in the database - only the fact that the files arrived.

## Create the server on BotKeep (optional)
Create server -> **Application** -> **Node.js** -> name `copycut-api` -> Runtime profile **22** -> Start command `npm start` -> Source: **GitHub** (this repo, files at the root) or **ZIP archive** (this ZIP).
If dependencies are not installed automatically, run `npm install` once in the server console (or set the start command to `npm install && npm start`).
Add the variables from `.env.example` in the server's environment/variables page, then start it.
Public URL: the website and Razorpay need an **https** address. Use the https domain BotKeep gives you (or put your own domain / Cloudflare in front). A plain `http://IP:port` will be blocked by browsers.
Then: website `API_URL` (top of the script in index.html) = that https URL; Cloudflare Worker variable `RENDER_URL` = the same URL; Razorpay webhook = `<URL>/webhook` (event `payment.captured`).

| Name | Value |
|---|---|
| `PGHOST` / `PGPORT` / `PGUSER` / `PGDATABASE` | `195.32.64.31` / `8765` / `botkeep` / `app` |
| `PGPASSWORD` | BotKeep database page -> Password -> eye icon -> Copy |
| `DATABASE_SSL` | `true` |
| `RZP_KEY_ID`, `RZP_KEY_SECRET` | Razorpay (Test Mode) API keys |
| `RZP_WEBHOOK_SECRET` | any long random string, same in the Razorpay webhook |
| `RECEIPT_SECRET`, `INTERNAL_SECRET` | 64 random hex chars each (`openssl rand -hex 32`); same values in the Worker |
| `FIREBASE_PROJECT` | `copycut-000` |
| `ALLOWED_ORIGINS` | your website origin(s), comma separated, no trailing slash |

## Rules built in
- Price shown = listed price + 2% gateway fee, rounded up to the paisa, so that after the gateway keeps 2% you still receive the listed price.
- Placed order (files uploaded) = **no refund**.
- Paid but order NOT placed = refund **70%** (30% deducted): `POST /internal/refund` (below).
- Customers see only their own history (order number, files title, price, upload status, a tracking link) - max 50 latest orders; `/my-orders` is limited to 20 requests per minute per IP.

## Owner tools (header `x-internal: <INTERNAL_SECRET>`)
- Tracking ID: `curl -X POST <URL>/internal/tracking -H "x-internal: <INTERNAL_SECRET>" -H "Content-Type: application/json" -d '{"orderId":"order_xxx","trackingId":"EW123456789IN"}'`
- Refund (paid but not placed, 70%): `curl -X POST <URL>/internal/refund -H "x-internal: <INTERNAL_SECRET>" -H "Content-Type: application/json" -d '{"orderId":"order_xxx"}'`
- One order: `GET <URL>/internal/order/order_xxx`; backup of recent orders: `GET <URL>/internal/export?limit=1000`
