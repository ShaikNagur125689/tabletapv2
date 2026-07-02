# TableTap v2

Multi-tenant QR table-ordering platform. Cafe/restaurant owners sign up, build
their menu, set their own kitchen PIN, and print per-table QR codes — all
self-service from a browser. Diners scan, order, pay online or cash (in advance
at cafes, after the meal at restaurants), get a token, and track it live.

## Run

Requires Node 22.13+ (uses Node's built-in SQLite — no native deps).

    npm install
    npm start

Open http://localhost:3000

1. Click "I run a cafe / restaurant" → Create account (email, password, venue name, type).
2. In the dashboard: add menu items, note/change your kitchen PIN, generate a table QR.
3. Open the QR's link (or scan it) → order as a diner.
4. Open /kitchen → sign in with your venue code + PIN → advance the order; the diner's screen updates live.

## What changed from v1

- Owner accounts: register/login; passwords stored as scrypt hashes, never plain text.
- Multi-tenant: unlimited venues on one deployment; menus, tables, tokens, orders,
  kitchen access, and live streams are all isolated per venue.
- Self-service: owners edit their menu (add/edit/delete/mark unavailable), rename the
  venue, switch cafe/restaurant mode, and rotate the kitchen PIN — no config files.
- Real database: SQLite (WAL mode), all queries parameterized.

## Still pending before real money / real launch

- Payment gateway: "Paid" is still SIMULATED. Wire Razorpay/Stripe in
  `simulatedGatewayCharge()` (src/server.js) and confirm via webhook.
- Hosting + HTTPS (see render.yaml for a one-click Render blueprint).
- On Render's free tier the SQLite file resets on redeploy — attach a persistent
  disk or move to Postgres for real use.
- Email verification / password reset, per-staff accounts, refunds, order history UI.
