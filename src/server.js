import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as DB from './db.js';
import {
  hashPassword, verifyPassword, passwordIssue, safeEqual, rateLimit,
  issueOwnerToken, verifyOwnerToken, issueKitchenToken, verifyKitchenToken,
  signTable, verifyTable,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const TAX_RATE = 0.05;
const FLOW = ['placed', 'preparing', 'ready', 'completed'];

app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
const ip = (req) => (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || '?';

/* ------------------------------ validation ----------------------------- */
const cleanStr = (s, max) => (typeof s === 'string' ? s.trim().slice(0, max) : '');
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 120;
const isPin = (s) => /^[0-9]{4,8}$/.test(s);
const isTable = (s) => /^[A-Za-z0-9-]{1,12}$/.test(s);

function requireOwner(req, res, next) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  const p = verifyOwnerToken(t);
  if (!p) return res.status(401).json({ error: 'Please sign in again.' });
  req.ownerId = p.oid;
  const venue = DB.getVenueByOwner(p.oid);
  if (!venue) return res.status(401).json({ error: 'Account has no venue.' });
  req.venue = venue;
  next();
}
function requireKitchen(req, res, next) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '') || req.query.token;
  const p = verifyKitchenToken(t);
  if (!p || p.vid !== req.params.venueId) return res.status(401).json({ error: 'Kitchen sign-in required.' });
  next();
}

/* ------------------------- owner: register/login ----------------------- */
app.post('/api/owners/register', (req, res) => {
  const rl = rateLimit({ key: 'reg:' + ip(req), limit: 5, windowMs: 3600_000 });
  if (!rl.ok) return res.status(429).json({ error: 'Too many signups. Try later.' });
  const email = cleanStr(req.body?.email, 120).toLowerCase();
  const password = String(req.body?.password || '');
  const venueName = cleanStr(req.body?.venueName, 60);
  const mode = req.body?.mode === 'restaurant' ? 'restaurant' : 'cafe';
  if (!isEmail(email)) return res.status(400).json({ error: 'Enter a valid email.' });
  const pwErr = passwordIssue(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  if (venueName.length < 2) return res.status(400).json({ error: 'Enter your cafe/restaurant name.' });
  if (DB.getOwnerByEmail(email)) return res.status(409).json({ error: 'An account with this email already exists.' });
  const owner = DB.createOwner(email, hashPassword(password));
  const pin = String(crypto.randomInt(100000, 999999)); // starter kitchen PIN; owner can change it
  const venue = DB.createVenue(owner.id, venueName, mode, pin);
  res.status(201).json({ token: issueOwnerToken(owner.id), venue: ownerVenueView(venue) });
});

app.post('/api/owners/login', (req, res) => {
  const rl = rateLimit({ key: 'login:' + ip(req), limit: 10, windowMs: 600_000 });
  if (!rl.ok) return res.status(429).json({ error: 'Too many attempts. Wait a bit.' });
  const email = cleanStr(req.body?.email, 120).toLowerCase();
  const owner = DB.getOwnerByEmail(email);
  if (!owner || !verifyPassword(String(req.body?.password || ''), owner.pass_hash)) {
    return res.status(401).json({ error: 'Wrong email or password.' });
  }
  const venue = DB.getVenueByOwner(owner.id);
  res.json({ token: issueOwnerToken(owner.id), venue: ownerVenueView(venue) });
});

/* --------------------------- owner: dashboard -------------------------- */
function ownerVenueView(v) {
  return { id: v.id, name: v.name, mode: v.mode, kitchenPin: v.kitchen_pin };
}
app.get('/api/owner/venue', requireOwner, (req, res) => {
  res.json({ venue: ownerVenueView(req.venue), menu: DB.listMenu(req.venue.id) });
});
app.patch('/api/owner/venue', requireOwner, (req, res) => {
  const patch = {};
  if (req.body?.name !== undefined) {
    const n = cleanStr(req.body.name, 60);
    if (n.length < 2) return res.status(400).json({ error: 'Name too short.' });
    patch.name = n;
  }
  if (req.body?.mode !== undefined) {
    if (!['cafe', 'restaurant'].includes(req.body.mode)) return res.status(400).json({ error: 'Bad mode.' });
    patch.mode = req.body.mode;
  }
  if (req.body?.kitchenPin !== undefined) {
    if (!isPin(String(req.body.kitchenPin))) return res.status(400).json({ error: 'PIN must be 4–8 digits.' });
    patch.kitchen_pin = String(req.body.kitchenPin);
  }
  res.json({ venue: ownerVenueView(DB.updateVenue(req.venue.id, patch)) });
});

const validItem = (b) => {
  const name = cleanStr(b?.name, 60);
  const price = Number(b?.price);
  const cat = cleanStr(b?.cat, 30) || 'Menu';
  const diet = b?.diet === 'nonveg' ? 'nonveg' : 'veg';
  if (name.length < 1) return { error: 'Item needs a name.' };
  if (!Number.isInteger(price) || price < 1 || price > 100000) return { error: 'Price must be a whole number of rupees.' };
  return { name, price, cat, diet };
};
app.post('/api/owner/menu', requireOwner, (req, res) => {
  const v = validItem(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  if (DB.listMenu(req.venue.id).length >= 200) return res.status(400).json({ error: 'Menu limit reached.' });
  res.status(201).json({ item: DB.addMenuItem(req.venue.id, v) });
});
app.patch('/api/owner/menu/:id', requireOwner, (req, res) => {
  const cur = DB.getMenuItem(req.venue.id, req.params.id);
  if (!cur) return res.status(404).json({ error: 'Item not found.' });
  const v = validItem({ ...cur, ...req.body });
  if (v.error) return res.status(400).json({ error: v.error });
  const available = req.body?.available === undefined ? cur.available : (req.body.available ? 1 : 0);
  res.json({ item: DB.updateMenuItem(req.venue.id, req.params.id, { ...v, available }) });
});
app.delete('/api/owner/menu/:id', requireOwner, (req, res) => {
  DB.deleteMenuItem(req.venue.id, req.params.id);
  res.json({ ok: true });
});

app.get('/api/owner/table-link/:table', requireOwner, (req, res) => {
  const table = String(req.params.table);
  if (!isTable(table)) return res.status(400).json({ error: 'Table id: letters/numbers only.' });
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({ table, url: `${base}/order?v=${req.venue.id}&t=${encodeURIComponent(table)}&sig=${signTable(req.venue.id, table)}` });
});

/* ---------------------------- public: venue ---------------------------- */
app.get('/api/venues/:venueId/config', (req, res) => {
  const v = DB.getVenue(req.params.venueId);
  if (!v) return res.status(404).json({ error: 'Venue not found.' });
  res.json({ venue: { id: v.id, name: v.name, mode: v.mode }, taxRatePct: TAX_RATE * 100 });
});
app.get('/api/venues/:venueId/menu', (req, res) => {
  const v = DB.getVenue(req.params.venueId);
  if (!v) return res.status(404).json({ error: 'Venue not found.' });
  const items = DB.listMenu(v.id, true).map(({ id, name, price, cat, diet }) => ({ id, name, price, cat, diet }));
  res.json({ menu: items, categories: [...new Set(items.map((i) => i.cat))] });
});

/* ----------------------------- ordering -------------------------------- */
async function simulatedGatewayCharge(amount) {
  // Placeholder gateway. Replace with Razorpay/Stripe create+verify and set
  // paid from the WEBHOOK in production. "Paid" here is simulated.
  await new Promise((r) => setTimeout(r, 250));
  return { ok: true, reference: 'pay_' + crypto.randomBytes(8).toString('hex'), amount };
}
const idempo = new Map();

app.post('/api/venues/:venueId/orders', async (req, res) => {
  const rl = rateLimit({ key: 'order:' + ip(req), limit: 20, windowMs: 60_000 });
  if (!rl.ok) return res.status(429).json({ error: 'Too many orders, slow down a moment.' });
  const venue = DB.getVenue(req.params.venueId);
  if (!venue) return res.status(404).json({ error: 'Venue not found.' });

  const { table, sig, lines, pay, idempotencyKey } = req.body || {};
  const ikey = idempotencyKey ? venue.id + ':' + cleanStr(idempotencyKey, 64) : null;
  if (ikey && idempo.has(ikey)) {
    const existing = DB.getOrder(venue.id, idempo.get(ikey));
    if (existing) return res.json({ order: publicOrder(existing) });
  }
  if (!isTable(String(table)) || !verifyTable(venue.id, String(table), sig)) {
    return res.status(403).json({ error: 'Invalid table code. Please rescan the QR on your table.' });
  }
  // Server-side pricing from the venue's own menu.
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > 40) {
    return res.status(400).json({ error: 'Your cart is empty or invalid.' });
  }
  const items = []; let subtotal = 0;
  for (const l of lines) {
    const it = DB.getMenuItem(venue.id, String(l?.id || ''));
    const qty = Number(l?.qty);
    if (!it || !it.available || !Number.isInteger(qty) || qty < 1 || qty > 50) {
      return res.status(400).json({ error: 'An item in your cart is unavailable. Please refresh the menu.' });
    }
    subtotal += it.price * qty;
    items.push({ id: it.id, name: it.name, price: it.price, qty, diet: it.diet });
  }
  const tax = Math.round(subtotal * TAX_RATE);
  const total = subtotal + tax;

  const payMode = venue.mode === 'cafe' ? 'now' : (pay?.mode === 'now' ? 'now' : 'after');
  const method = pay?.method === 'cash' ? 'cash' : 'online';
  let paid = false, paymentRef = null;
  if (payMode === 'now' && method === 'online') {
    const r = await simulatedGatewayCharge(total);
    if (!r.ok) return res.status(402).json({ error: 'Payment was declined.' });
    paid = true; paymentRef = r.reference;
  }
  const order = DB.createOrder({
    venueId: venue.id, token: DB.nextToken(venue.id), table: String(table),
    items, subtotal, tax, total, status: 'placed',
    timing: payMode === 'now' ? 'advance' : 'after',
    method: payMode === 'now' ? method : null, paid, paymentRef, placedAt: Date.now(),
  });
  if (ikey) idempo.set(ikey, order.token);
  res.status(201).json({ order: publicOrder(order) });
});

app.get('/api/venues/:venueId/orders/:token', (req, res) => {
  const o = DB.getOrder(req.params.venueId, Number(req.params.token));
  if (!o) return res.status(404).json({ error: 'Order not found.' });
  res.json({ order: publicOrder(o) });
});

app.post('/api/venues/:venueId/orders/:token/settle', async (req, res) => {
  const o = DB.getOrder(req.params.venueId, Number(req.params.token));
  if (!o) return res.status(404).json({ error: 'Order not found.' });
  if (o.timing !== 'after' || o.paid) return res.status(409).json({ error: 'Nothing to settle.' });
  const method = req.body?.method === 'cash' ? 'cash' : 'online';
  if (method === 'online') {
    const r = await simulatedGatewayCharge(o.total);
    if (!r.ok) return res.status(402).json({ error: 'Payment was declined.' });
    return res.json({ order: publicOrder(DB.updateOrder(o.venueId, o.token, { method, paid: true })) });
  }
  res.json({ order: publicOrder(DB.updateOrder(o.venueId, o.token, { method, paid: false })) });
});

/* ------------------------------ kitchen -------------------------------- */
app.post('/api/venues/:venueId/kitchen/login', (req, res) => {
  const rl = rateLimit({ key: 'kpin:' + ip(req), limit: 10, windowMs: 600_000 });
  if (!rl.ok) return res.status(429).json({ error: 'Too many attempts. Wait a bit.' });
  const venue = DB.getVenue(req.params.venueId);
  if (!venue) return res.status(404).json({ error: 'Venue not found.' });
  if (!safeEqual(String(req.body?.pin || ''), venue.kitchen_pin)) {
    return res.status(401).json({ error: 'Wrong PIN.' });
  }
  res.json({ token: issueKitchenToken(venue.id), venue: { id: venue.id, name: venue.name, mode: venue.mode } });
});
app.get('/api/venues/:venueId/kitchen/orders', requireKitchen, (req, res) => {
  res.json({ orders: DB.listOrders(req.params.venueId).map(publicOrder) });
});
app.post('/api/venues/:venueId/kitchen/orders/:token/advance', requireKitchen, (req, res) => {
  const o = DB.getOrder(req.params.venueId, Number(req.params.token));
  if (!o) return res.status(404).json({ error: 'Order not found.' });
  const i = FLOW.indexOf(o.status);
  if (i === -1 || !FLOW[i + 1]) return res.status(409).json({ error: 'Order is already complete.' });
  res.json({ order: publicOrder(DB.updateOrder(o.venueId, o.token, { status: FLOW[i + 1] })) });
});
app.post('/api/venues/:venueId/kitchen/orders/:token/collect', requireKitchen, (req, res) => {
  const o = DB.getOrder(req.params.venueId, Number(req.params.token));
  if (!o) return res.status(404).json({ error: 'Order not found.' });
  if (o.paid) return res.status(409).json({ error: 'Already paid.' });
  res.json({ order: publicOrder(DB.updateOrder(o.venueId, o.token, { paid: true, method: o.method || 'cash' })) });
});

/* ----------------------------- live (SSE) ------------------------------ */
function sse(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write(': connected\n\n');
}
app.get('/api/stream/venues/:venueId/orders/:token', (req, res) => {
  const o = DB.getOrder(req.params.venueId, Number(req.params.token));
  if (!o) return res.status(404).end();
  sse(res);
  const ev = 'order:' + req.params.venueId + ':' + req.params.token;
  const h = (order) => res.write(`data: ${JSON.stringify(publicOrder(order))}\n\n`);
  DB.bus.on(ev, h);
  const ka = setInterval(() => res.write(': ka\n\n'), 25_000);
  req.on('close', () => { clearInterval(ka); DB.bus.off(ev, h); });
});
app.get('/api/stream/venues/:venueId/kitchen', (req, res) => {
  const p = verifyKitchenToken(req.query.token);
  if (!p || p.vid !== req.params.venueId) return res.status(401).end();
  sse(res);
  const ev = 'venue:' + req.params.venueId;
  const h = (order) => res.write(`data: ${JSON.stringify(publicOrder(order))}\n\n`);
  DB.bus.on(ev, h);
  const ka = setInterval(() => res.write(': ka\n\n'), 25_000);
  req.on('close', () => { clearInterval(ka); DB.bus.off(ev, h); });
});

/* ------------------------------- statics ------------------------------- */
function publicOrder(o) {
  return {
    token: o.token, table: o.table, items: o.items,
    subtotal: o.subtotal, tax: o.tax, total: o.total,
    status: o.status, timing: o.timing, method: o.method, paid: o.paid,
    placedAt: o.placedAt, updatedAt: o.updatedAt,
  };
}
app.use(express.static(path.join(__dirname, '..', 'public')));
const page = (f) => (req, res) => res.sendFile(path.join(__dirname, '..', 'public', f));
app.get('/order', page('diner.html'));
app.get('/kitchen', page('kitchen.html'));
app.get('/admin', page('admin.html'));

app.listen(PORT, () => {
  console.log(`\n  TableTap v2 running → http://localhost:${PORT}`);
  console.log(`  Owners sign up at /admin · Kitchen at /kitchen · Diners via table QR links\n`);
});
