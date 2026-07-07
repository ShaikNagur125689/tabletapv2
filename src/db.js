// Data layer with two interchangeable backends behind ONE async API:
//   DATABASE_URL set  -> PostgreSQL (e.g. Neon). Data survives restarts,
//                        redeploys, and free-tier sleep. Use this in production.
//   DATABASE_URL unset-> local SQLite file. Zero-setup for development.
// Every query is parameterized on both backends — no string-built SQL.
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const bus = new EventEmitter();
bus.setMaxListeners(0);
const uid = (n = 10) => crypto.randomBytes(n).toString('base64url');

// Shared DDL that both SQLite and Postgres accept.
// Timestamps are BIGINT because Date.now() overflows Postgres INTEGER.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS owners (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL,
    pass_hash TEXT NOT NULL, created_at BIGINT NOT NULL,
    verified INTEGER NOT NULL DEFAULT 0,
    verify_code TEXT, verify_expires BIGINT,
    verify_attempts INTEGER NOT NULL DEFAULT 0,
    reset_code TEXT, reset_expires BIGINT,
    reset_attempts INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS venues (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
    name TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'cafe',
    kitchen_pin TEXT NOT NULL, token_counter INTEGER NOT NULL DEFAULT 100,
    status TEXT NOT NULL DEFAULT 'active',
    store_open INTEGER NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL,
    FOREIGN KEY (owner_id) REFERENCES owners(id)
  )`,
  `CREATE TABLE IF NOT EXISTS menu_items (
    id TEXT PRIMARY KEY, venue_id TEXT NOT NULL,
    name TEXT NOT NULL, price INTEGER NOT NULL,
    cat TEXT NOT NULL, diet TEXT NOT NULL DEFAULT 'veg',
    available INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (venue_id) REFERENCES venues(id)
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    venue_id TEXT NOT NULL, token INTEGER NOT NULL,
    table_id TEXT NOT NULL, items_json TEXT NOT NULL,
    subtotal INTEGER NOT NULL, tax INTEGER NOT NULL, total INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'placed',
    timing TEXT NOT NULL, method TEXT, paid INTEGER NOT NULL DEFAULT 0,
    payment_ref TEXT, note TEXT, cancel_reason TEXT, cancelled_by TEXT,
    refunded INTEGER NOT NULL DEFAULT 0, refunded_at BIGINT,
    placed_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
    PRIMARY KEY (venue_id, token),
    FOREIGN KEY (venue_id) REFERENCES venues(id)
  )`,
  `CREATE TABLE IF NOT EXISTS invites (
    code TEXT PRIMARY KEY, created_at BIGINT NOT NULL,
    used_by TEXT, used_at BIGINT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_orders_venue ON orders(venue_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_menu_venue ON menu_items(venue_id)`,
];

// q = the active driver: { run(sql, params), get(...) -> row|null, all(...) -> rows }
let q;

if (process.env.DATABASE_URL) {
  /* ----------------------------- PostgreSQL ----------------------------- */
  const { default: pg } = await import('pg');
  const local = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    ssl: local ? false : { rejectUnauthorized: false }, // Neon requires SSL
  });
  pool.on('error', (e) => console.error('[db] pool error:', e.message));
  const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => '$' + ++i); };
  q = {
    run: async (sql, p = []) => { await pool.query(toPg(sql), p); },
    get: async (sql, p = []) => (await pool.query(toPg(sql), p)).rows[0] ?? null,
    all: async (sql, p = []) => (await pool.query(toPg(sql), p)).rows,
  };
  for (const s of SCHEMA) await q.run(s);
  // Upgrade tables created by earlier versions (safe on every start).
  for (const s of [
    'ALTER TABLE owners ADD COLUMN IF NOT EXISTS reset_code TEXT',
    'ALTER TABLE owners ADD COLUMN IF NOT EXISTS reset_expires BIGINT',
    'ALTER TABLE owners ADD COLUMN IF NOT EXISTS reset_attempts INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE orders ADD COLUMN IF NOT EXISTS note TEXT',
    'ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT',
    'ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_by TEXT',
    'ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_at BIGINT',
    "ALTER TABLE venues ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'",
    'ALTER TABLE venues ADD COLUMN IF NOT EXISTS store_open INTEGER NOT NULL DEFAULT 1',
  ]) await q.run(s);
  console.log('[db] PostgreSQL connected — data persists across restarts and redeploys.');
} else {
  /* ------------------------------- SQLite ------------------------------- */
  const { DatabaseSync } = await import('node:sqlite');
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'tabletap.sqlite'));
  db.exec('PRAGMA journal_mode = WAL');
  for (const s of SCHEMA) db.exec(s);
  // migrations for databases created before email verification existed
  for (const s of [
    'ALTER TABLE owners ADD COLUMN verified INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE owners ADD COLUMN verify_code TEXT',
    'ALTER TABLE owners ADD COLUMN verify_expires BIGINT',
    'ALTER TABLE owners ADD COLUMN verify_attempts INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE owners ADD COLUMN reset_code TEXT',
    'ALTER TABLE owners ADD COLUMN reset_expires BIGINT',
    'ALTER TABLE owners ADD COLUMN reset_attempts INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE orders ADD COLUMN note TEXT',
    'ALTER TABLE orders ADD COLUMN cancel_reason TEXT',
    'ALTER TABLE orders ADD COLUMN cancelled_by TEXT',
    'ALTER TABLE orders ADD COLUMN refunded INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE orders ADD COLUMN refunded_at BIGINT',
    "ALTER TABLE venues ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
    'ALTER TABLE venues ADD COLUMN store_open INTEGER NOT NULL DEFAULT 1',
  ]) { try { db.exec(s); } catch (_) {} }
  q = {
    run: async (sql, p = []) => { db.prepare(sql).run(...p); },
    get: async (sql, p = []) => db.prepare(sql).get(...p) ?? null,
    all: async (sql, p = []) => db.prepare(sql).all(...p),
  };
  console.warn('[db] DATABASE_URL not set — using a local SQLite file. Fine for development; on free hosting this data is wiped on every restart.');
}

/* --------------------------------- owners -------------------------------- */
export async function createOwner(email, passHash, verifyCode, verifyExpires) {
  const id = 'own_' + uid();
  await q.run(`INSERT INTO owners (id, email, pass_hash, created_at, verified, verify_code, verify_expires)
               VALUES (?, ?, ?, ?, 0, ?, ?)`, [id, email, passHash, Date.now(), verifyCode, verifyExpires]);
  return { id, email };
}
export const getOwnerByEmail = (email) => q.get('SELECT * FROM owners WHERE email = ?', [email]);
export const getOwner = (id) => q.get('SELECT * FROM owners WHERE id = ?', [id]);
export async function setVerifyCode(id, code, expires) {
  await q.run('UPDATE owners SET verify_code = ?, verify_expires = ?, verify_attempts = 0 WHERE id = ?', [code, expires, id]);
}
export async function bumpVerifyAttempts(id) {
  await q.run('UPDATE owners SET verify_attempts = verify_attempts + 1 WHERE id = ?', [id]);
  const r = await q.get('SELECT verify_attempts FROM owners WHERE id = ?', [id]);
  return r ? Number(r.verify_attempts) : 0;
}
export async function markVerified(id) {
  await q.run('UPDATE owners SET verified = 1, verify_code = NULL, verify_expires = NULL, verify_attempts = 0 WHERE id = ?', [id]);
}
export async function setResetCode(id, code, expires) {
  await q.run('UPDATE owners SET reset_code = ?, reset_expires = ?, reset_attempts = 0 WHERE id = ?', [code, expires, id]);
}
export async function bumpResetAttempts(id) {
  await q.run('UPDATE owners SET reset_attempts = reset_attempts + 1 WHERE id = ?', [id]);
  const r = await q.get('SELECT reset_attempts FROM owners WHERE id = ?', [id]);
  return r ? Number(r.reset_attempts) : 0;
}
export async function updatePassword(id, passHash) {
  await q.run('UPDATE owners SET pass_hash = ?, reset_code = NULL, reset_expires = NULL, reset_attempts = 0 WHERE id = ?', [passHash, id]);
}

/* --------------------------------- venues -------------------------------- */
export function slugify(name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'venue';
  return base + '-' + crypto.randomBytes(2).toString('hex');
}
export async function createVenue(ownerId, name, mode, kitchenPin) {
  const id = slugify(name);
  await q.run('INSERT INTO venues (id, owner_id, name, mode, kitchen_pin, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, ownerId, name, mode, kitchenPin, Date.now()]);
  return getVenue(id);
}
export const getVenue = (id) => q.get('SELECT * FROM venues WHERE id = ?', [id]);
export const getVenueByOwner = (ownerId) => q.get('SELECT * FROM venues WHERE owner_id = ?', [ownerId]);
export async function updateVenue(id, { name, mode, kitchen_pin, store_open }) {
  const v = await getVenue(id); if (!v) return null;
  await q.run('UPDATE venues SET name = ?, mode = ?, kitchen_pin = ?, store_open = ? WHERE id = ?',
    [name ?? v.name, mode ?? v.mode, kitchen_pin ?? v.kitchen_pin, store_open ?? v.store_open, id]);
  return getVenue(id);
}
// RETURNING makes increment+read one atomic statement, so two simultaneous
// orders can never be handed the same token number.
export async function nextToken(venueId) {
  const r = await q.get('UPDATE venues SET token_counter = token_counter + 1 WHERE id = ? RETURNING token_counter', [venueId]);
  return Number(r.token_counter);
}

/* ---------------------------------- menu --------------------------------- */
export const listMenu = (venueId, onlyAvailable = false) =>
  q.all(`SELECT * FROM menu_items WHERE venue_id = ? ${onlyAvailable ? 'AND available = 1' : ''} ORDER BY cat, name`, [venueId]);
export const getMenuItem = (venueId, id) =>
  q.get('SELECT * FROM menu_items WHERE venue_id = ? AND id = ?', [venueId, id]);
export async function addMenuItem(venueId, { name, price, cat, diet }) {
  const id = 'itm_' + uid(6);
  await q.run('INSERT INTO menu_items (id, venue_id, name, price, cat, diet) VALUES (?, ?, ?, ?, ?, ?)',
    [id, venueId, name, price, cat, diet]);
  return getMenuItem(venueId, id);
}
export async function updateMenuItem(venueId, id, patch) {
  const it = await getMenuItem(venueId, id); if (!it) return null;
  await q.run('UPDATE menu_items SET name = ?, price = ?, cat = ?, diet = ?, available = ? WHERE venue_id = ? AND id = ?',
    [patch.name ?? it.name, patch.price ?? it.price, patch.cat ?? it.cat,
     patch.diet ?? it.diet, patch.available ?? it.available, venueId, id]);
  return getMenuItem(venueId, id);
}
export async function deleteMenuItem(venueId, id) {
  await q.run('DELETE FROM menu_items WHERE venue_id = ? AND id = ?', [venueId, id]);
}

/* --------------------------------- orders -------------------------------- */
const rowToOrder = (r) => r && ({
  venueId: r.venue_id, token: Number(r.token), table: r.table_id,
  items: JSON.parse(r.items_json),
  subtotal: Number(r.subtotal), tax: Number(r.tax), total: Number(r.total),
  status: r.status, timing: r.timing, method: r.method, paid: !!Number(r.paid),
  note: r.note || null, cancelReason: r.cancel_reason || null, cancelledBy: r.cancelled_by || null,
  refunded: !!Number(r.refunded || 0), refundedAt: r.refunded_at ? Number(r.refunded_at) : null,
  placedAt: Number(r.placed_at), updatedAt: Number(r.updated_at),
});
export async function createOrder(o) {
  await q.run(`INSERT INTO orders (venue_id, token, table_id, items_json, subtotal, tax, total,
      status, timing, method, paid, payment_ref, note, placed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [o.venueId, o.token, o.table, JSON.stringify(o.items), o.subtotal, o.tax, o.total,
     o.status, o.timing, o.method, o.paid ? 1 : 0, o.paymentRef || null, o.note || null, o.placedAt, o.placedAt]);
  const saved = await getOrder(o.venueId, o.token);
  bus.emit('venue:' + o.venueId, saved);
  bus.emit('order:' + o.venueId + ':' + o.token, saved);
  return saved;
}
export async function getOrder(venueId, token) {
  return rowToOrder(await q.get('SELECT * FROM orders WHERE venue_id = ? AND token = ?', [venueId, token]));
}
export async function updateOrder(venueId, token, patch) {
  const cur = await getOrder(venueId, token); if (!cur) return null;
  const m = { ...cur, ...patch };
  await q.run(`UPDATE orders SET status = ?, method = ?, paid = ?, cancel_reason = ?, cancelled_by = ?,
               refunded = ?, refunded_at = ?, updated_at = ?
               WHERE venue_id = ? AND token = ?`,
    [m.status, m.method, m.paid ? 1 : 0, m.cancelReason || null, m.cancelledBy || null,
     m.refunded ? 1 : 0, m.refundedAt || null, Date.now(), venueId, token]);
  const saved = await getOrder(venueId, token);
  bus.emit('venue:' + venueId, saved);
  bus.emit('order:' + venueId + ':' + token, saved);
  return saved;
}
/* ------------------------- invites & platform -------------------------- */
export async function createInvite(code) {
  await q.run('INSERT INTO invites (code, created_at) VALUES (?, ?)', [code, Date.now()]);
  return { code };
}
export const getInvite = (code) => q.get('SELECT * FROM invites WHERE code = ?', [code]);
export const listInvites = () => q.all('SELECT * FROM invites ORDER BY created_at DESC');
// Mark-if-unused, then verify who got it — safe against double-spend races.
export async function consumeInvite(code, email) {
  await q.run('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL', [email, Date.now(), code]);
  const inv = await getInvite(code);
  return !!(inv && inv.used_by === email);
}
export async function setVenueStatus(id, status) {
  await q.run('UPDATE venues SET status = ? WHERE id = ?', [status, id]);
  return getVenue(id);
}
export const listVenuesWithOwners = () =>
  q.all(`SELECT v.id, v.name, v.mode, v.status, v.created_at, o.email AS owner_email
         FROM venues v JOIN owners o ON o.id = v.owner_id ORDER BY v.created_at DESC`);
export const orderCountsByVenue = () =>
  q.all('SELECT venue_id, COUNT(*) AS c FROM orders GROUP BY venue_id');

export async function listOrdersSince(venueId, since) {
  return (await q.all('SELECT * FROM orders WHERE venue_id = ? AND placed_at >= ? ORDER BY token', [venueId, since])).map(rowToOrder);
}
export async function listOrders(venueId) {
  return (await q.all('SELECT * FROM orders WHERE venue_id = ? ORDER BY token', [venueId])).map(rowToOrder);
}
