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
import { sendVerifyCode } from './email.js';

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

async function requireOwner(req, res, next) {
  try {
    const t = (req.headers.authorization || '').replace(/^Bearer /, '');
    const p = verifyOwnerToken(t);
    if (!p) return res.status(401).json({ error: 'Please sign in again.' });
    req.ownerId = p.oid;
    const venue = await DB.getVenueByOwner(p.oid);
    if (!venue) return res.status(401).json({ error: 'Account has no venue.' });
    req.venue = venue;
    next();
  } catch (e) { next(e); }
}
function requireKitchen(req, res, next) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '') || req.query.token;
  const p = verifyKitchenToken(t);
  if (!p || p.vid !== req.params.venueId) return res.status(401).json({ error: 'Kitchen sign-in required.' });
  next();
}

/* ------------------------- owner: register/login ----------------------- */
const newCode = () => String(crypto.randomInt(100000, 1000000));
const CODE_TTL = 15 * 60 * 1000;

async function issueAndSendCode(owner, venueName) {
  const code = newCode();
  await DB.setVerifyCode(owner.id, code, Date.now() + CODE_TTL);
  return sendVerifyCode(owner.email, code, venueName);
}

app.post('/api/owners/register', async (req, res, next) => {
  try {
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
    if (await DB.getOwnerByEmail(email)) return res.status(409).json({ error: 'An account with this email already exists.' });

    const code = newCode();
    const owner = await DB.createOwner(email, hashPassword(password), code, Date.now() + CODE_TTL);
    const pin = String(crypto.randomInt(100000, 999999));
    await DB.createVenue(owner.id, venueName, mode, pin);
    await sendVerifyCode(email, code, venueName);
    // No session token yet — the account activates only after the code is entered.
    res.status(201).json({ pending: true, email });
  } catch (e) { next(e); }
});

app.post('/api/owners/verify', async (req, res, next) => {
  try {
    const rl = rateLimit({ key: 'verify:' + ip(req), limit: 15, windowMs: 600_000 });
    if (!rl.ok) return res.status(429).json({ error: 'Too many attempts. Wait a bit.' });
    const email = cleanStr(req.body?.email, 120).toLowerCase();
    const code = cleanStr(req.body?.code, 10);
    const owner = await DB.getOwnerByEmail(email);
    if (!owner) return res.status(400).json({ error: 'Wrong code. Check the email and try again.' });
    const venue = await DB.getVenueByOwner(owner.id);
    if (Number(owner.verified)) {
      return res.json({ token: issueOwnerToken(owner.id), venue: ownerVenueView(venue) });
    }
    if (Number(owner.verify_attempts) >= 5) {
      return res.status(429).json({ error: 'Too many wrong codes. Tap "Resend code" to get a fresh one.' });
    }
    if (!owner.verify_code || !owner.verify_expires || Date.now() > Number(owner.verify_expires)) {
      return res.status(400).json({ error: 'That code has expired. Tap "Resend code" to get a fresh one.' });
    }
    if (!safeEqual(code, owner.verify_code)) {
      await DB.bumpVerifyAttempts(owner.id);
      return res.status(400).json({ error: 'Wrong code. Check the email and try again.' });
    }
    await DB.markVerified(owner.id);
    res.json({ token: issueOwnerToken(owner.id), venue: ownerVenueView(venue) });
  } catch (e) { next(e); }
});

app.post('/api/owners/resend', async (req, res, next) => {
  try {
    const email = cleanStr(req.body?.email, 120).toLowerCase();
    const rl = rateLimit({ key: 'resend:' + email, limit: 3, windowMs: 600_000 });
    if (!rl.ok) return res.status(429).json({ error: 'Code already sent — wait a few minutes before requesting another.' });
    const owner = await DB.getOwnerByEmail(email);
    if (owner && !Number(owner.verified)) {
      const venue = await DB.getVenueByOwner(owner.id);
      await issueAndSendCode(owner, venue ? venue.name : '');
    }
    // Always the same answer, so this endpoint can't be used to probe which emails exist.
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/owners/login', async (req, res, next) => {
  try {
    const rl = rateLimit({ key: 'login:' + ip(req), limit: 10, windowMs: 600_000 });
    if (!rl.ok) return res.status(429).json({ error: 'Too many attempts. Wait a bit.' });
    const email = cleanStr(req.body?.email, 120).toLowerCase();
    const owner = await DB.getOwnerByEmail(email);
    if (!owner || !verifyPassword(String(req.body?.password || ''), owner.pass_hash)) {
      return res.status(401).json({ error: 'Wrong email or password.' });
    }
    if (!Number(owner.verified)) {
      const sendRl = rateLimit({ key: 'resend:' + email, limit: 3, windowMs: 600_000 });
      if (sendRl.ok) {
        const venue = await DB.getVenueByOwner(owner.id);
        await issueAndSendCode(owner, venue ? venue.name : '');
      }
      return res.status(403).json({ error: 'Please verify your email first — we just sent you a code.', unverified: true });
    }
    const venue = await DB.getVenueByOwner(owner.id);
    res.json({ token: issueOwnerToken(owner.id), venue: ownerVenueView(venue) });
  } catch (e) { next(e); }
});

/* --------------------------- owner: dashboard -------------------------- */
function ownerVenueView(v) {
  return { id: v.id, name: v.name, mode: v.mode, kitchenPin: v.kitchen_pin };
}
app.get('/api/owner/venue', requireOwner, async (req, res, next) => {
  try { res.json({ venue: ownerVenueView(req.venue), menu: await DB.listMenu(req.venue.id) }); }
  catch (e) { next(e); }
});
app.patch('/api/owner/venue', requireOwner, async (req, res, next) => {
  try {
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
    res.json({ venue: ownerVenueView(await DB.updateVenue(req.venue.id, patch)) });
  } catch (e) { next(e); }
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
app.post('/api/owner/menu', requireOwner, async (req, res, next) => {
  try {
    const v = validItem(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    if ((await DB.listMenu(req.venue.id)).length >= 200) return res.status(400).json({ error: 'Menu limit reached.' });
    res.status(201).json({ item: await DB.addMenuItem(req.venue.id, v) });
  } catch (e) { next(e); }
});
app.patch('/api/owner/menu/:id', requireOwner, async (req, res, next) => {
  try {
    const cur = await DB.getMenuItem(req.venue.id, req.params.id);
    if (!cur) return res.status(404).json({ error: 'Item not found.' });
    const v = validItem({ ...cur, ...req.body });
    if (v.error) return res.status(400).json({ error: v.error });
    const available = req.body?.available === undefined ? cur.available : (req.body.available ? 1 : 0);
    res.json({ item: await DB.updateMenuItem(req.venue.id, req.params.id, { ...v, available }) });
  } catch (e) { next(e); }
});
app.delete('/api/owner/menu/:id', requireOwner, async (req, res, next) => {
  try { await DB.deleteMenuItem(req.venue.id, req.params.id); res.json({ ok: true }); }
  catch (e) { next(e); }
});

app.get('/api/owner/table-link/:table', requireOwner, (req, res) => {
  const table = String(req.params.table);
  if (!isTable(table)) return res.status(400).json({ error: 'Table id: letters/numbers only.' });
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({ table, url: `${base}/order?v=${req.venue.id}&t=${encodeURIComponent(table)}&sig=${signTable(req.venue.id, table)}` });
});

/* ---------------------------- public: venue ---------------------------- */
app.get('/api/venues/:venueId/config', async (req, res, next) => {
  try {
    const v = await DB.getVenue(req.params.venueId);
    if (!v) return res.status(404).json({ error: 'Venue not found.' });
    res.json({ venue: { id: v.id, name: v.name, mode: v.mode }, taxRatePct: TAX_RATE * 100 });
  } catch (e) { next(e); }
});
app.get('/api/venues/:venueId/menu', async (req, res, next) => {
  try {
    const v = await DB.getVenue(req.params.venueId);
    if (!v) return res.status(404).json({ error: 'Venue not found.' });
    const items = (await DB.listMenu(v.id, true)).map(({ id, name, price, cat, diet }) => ({ id, name, price, cat, diet }));
    res.json({ menu: items, categories: [...new Set(items.map((i) => i.cat))] });
  } catch (e) { next(e); }
});

/* ------------------------------ ordering ------------------------------- */
async function simulatedGatewayCharge(amount) {
  // Placeholder gateway. Replace with Razorpay/Stripe create+verify and set
  // paid from the WEBHOOK in production. "Paid" here is simulated.
  await new Promise((r) => setTimeout(r, 250));
  return { ok: true, reference: 'pay_' + crypto.randomBytes(8).toString('hex'), amount };
}
const idempo = new Map();

app.post('/api/venues/:venueId/orders', async (req, res, next) => {
  try {
    const rl = rateLimit({ key: 'order:' + ip(req), limit: 20, windowMs: 60_000 });
    if (!rl.ok) return res.status(429).json({ error: 'Too many orders, slow down a moment.' });
    const venue = await DB.getVenue(req.params.venueId);
    if (!venue) return res.status(404).json({ error: 'Venue not found.' });

    const { table, sig, lines, pay, idempotencyKey } = req.body || {};
    const ikey = idempotencyKey ? venue.id + ':' + cleanStr(idempotencyKey, 64) : null;
    if (ikey && idempo.has(ikey)) {
      const existing = await DB.getOrder(venue.id, idempo.get(ikey));
      if (existing) return res.json({ order: publicOrder(existing) });
    }
    if (!isTable(String(table)) || !verifyTable(venue.id, String(table), sig)) {
      return res.status(403).json({ error: 'Invalid table code. Please rescan the QR on your table.' });
    }
    if (!Array.isArray(lines) || lines.length === 0 || lines.length > 40) {
      return res.status(400).json({ error: 'Your cart is empty or invalid.' });
    }
    // Server-side pricing from the venue's own menu.
    const items = []; let subtotal = 0;
    for (const l of lines) {
      const it = await DB.getMenuItem(venue.id, String(l?.id || ''));
      const qty = Number(l?.qty);
      if (!it || !Number(it.available) || !Number.isInteger(qty) || qty < 1 || qty > 50) {
        return res.status(400).json({ error: 'An item in your cart is unavailable. Please refresh the menu.' });
      }
      subtotal += Number(it.price) * qty;
      items.push({ id: it.id, name: it.name, price: Number(it.price), qty, diet: it.diet });
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
    const order = await DB.createOrder({
      venueId: venue.id, token: await DB.nextToken(venue.id), table: String(table),
      items, subtotal, tax, total, status: 'placed',
      timing: payMode === 'now' ? 'advance' : 'after',
      method: payMode === 'now' ? method : null, paid, paymentRef, placedAt: Date.now(),
    });
    if (ikey) idempo.set(ikey, order.token);
    res.status(201).json({ order: publicOrder(order) });
  } catch (e) { next(e); }
});

app.get('/api/venues/:venueId/orders/:token', async (req, res, next) => {
  try {
    const o = await DB.getOrder(req.params.venueId, Number(req.params.token));
    if (!o) return res.status(404).json({ error: 'Order not found.' });
    res.json({ order: publicOrder(o) });
  } catch (e) { next(e); }
});

app.post('/api/venues/:venueId/orders/:token/settle', async (req, res, next) => {
  try {
    const o = await DB.getOrder(req.params.venueId, Number(req.params.token));
    if (!o) return res.status(404).json({ error: 'Order not found.' });
    if (o.timing !== 'after' || o.paid) return res.status(409).json({ error: 'Nothing to settle.' });
    const method = req.body?.method === 'cash' ? 'cash' : 'online';
    if (method === 'online') {
      const r = await simulatedGatewayCharge(o.total);
      if (!r.ok) return res.status(402).json({ error: 'Payment was declined.' });
      return res.json({ order: publicOrder(await DB.updateOrder(o.venueId, o.token, { method, paid: true })) });
    }
    res.json({ order: publicOrder(await DB.updateOrder(o.venueId, o.token, { method, paid: false })) });
  } catch (e) { next(e); }
});

/* ------------------------------ kitchen -------------------------------- */
app.post('/api/venues/:venueId/kitchen/login', async (req, res, next) => {
  try {
    const rl = rateLimit({ key: 'kpin:' + ip(req), limit: 10, windowMs: 600_000 });
    if (!rl.ok) return res.status(429).json({ error: 'Too many attempts. Wait a bit.' });
    const venue = await DB.getVenue(req.params.venueId);
    if (!venue) return res.status(404).json({ error: 'Venue not found.' });
    if (!safeEqual(String(req.body?.pin || ''), venue.kitchen_pin)) {
      return res.status(401).json({ error: 'Wrong PIN.' });
    }
    res.json({ token: issueKitchenToken(venue.id), venue: { id: venue.id, name: venue.name, mode: venue.mode } });
  } catch (e) { next(e); }
});
app.get('/api/venues/:venueId/kitchen/orders', requireKitchen, async (req, res, next) => {
  try { res.json({ orders: (await DB.listOrders(req.params.venueId)).map(publicOrder) }); }
  catch (e) { next(e); }
});
app.post('/api/venues/:venueId/kitchen/orders/:token/advance', requireKitchen, async (req, res, next) => {
  try {
    const o = await DB.getOrder(req.params.venueId, Number(req.params.token));
    if (!o) return res.status(404).json({ error: 'Order not found.' });
    const i = FLOW.indexOf(o.status);
    if (i === -1 || !FLOW[i + 1]) return res.status(409).json({ error: 'Order is already complete.' });
    res.json({ order: publicOrder(await DB.updateOrder(o.venueId, o.token, { status: FLOW[i + 1] })) });
  } catch (e) { next(e); }
});
app.post('/api/venues/:venueId/kitchen/orders/:token/collect', requireKitchen, async (req, res, next) => {
  try {
    const o = await DB.getOrder(req.params.venueId, Number(req.params.token));
    if (!o) return res.status(404).json({ error: 'Order not found.' });
    if (o.paid) return res.status(409).json({ error: 'Already paid.' });
    res.json({ order: publicOrder(await DB.updateOrder(o.venueId, o.token, { paid: true, method: o.method || 'cash' })) });
  } catch (e) { next(e); }
});

/* ----------------------------- live (SSE) ------------------------------ */
function sse(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write(': connected\n\n');
}
app.get('/api/stream/venues/:venueId/orders/:token', async (req, res) => {
  const o = await DB.getOrder(req.params.venueId, Number(req.params.token)).catch(() => null);
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

// Last-resort error handler: log the real cause, never leak internals.
app.use((err, req, res, next) => {
  console.error('[server] unhandled error on', req.method, req.path, '-', err.message);
  if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

app.listen(PORT, () => {
  console.log(`\n  TableTap v2 running → http://localhost:${PORT}`);
  console.log(`  Owners sign up at /admin · Kitchen at /kitchen · Diners via table QR links\n`);
});
