// Real database: SQLite via Node's built-in driver (Node >= 22.13, no native deps).
// Every query is parameterized — no string-built SQL, no injection surface.
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'tabletap.sqlite'));

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS owners (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL,
    pass_hash TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS venues (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
    name TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'cafe',
    kitchen_pin TEXT NOT NULL, token_counter INTEGER NOT NULL DEFAULT 100,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (owner_id) REFERENCES owners(id)
  );
  CREATE TABLE IF NOT EXISTS menu_items (
    id TEXT PRIMARY KEY, venue_id TEXT NOT NULL,
    name TEXT NOT NULL, price INTEGER NOT NULL,
    cat TEXT NOT NULL, diet TEXT NOT NULL DEFAULT 'veg',
    available INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (venue_id) REFERENCES venues(id)
  );
  CREATE TABLE IF NOT EXISTS orders (
    venue_id TEXT NOT NULL, token INTEGER NOT NULL,
    table_id TEXT NOT NULL, items_json TEXT NOT NULL,
    subtotal INTEGER NOT NULL, tax INTEGER NOT NULL, total INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'placed',
    timing TEXT NOT NULL, method TEXT, paid INTEGER NOT NULL DEFAULT 0,
    payment_ref TEXT, placed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (venue_id, token),
    FOREIGN KEY (venue_id) REFERENCES venues(id)
  );
  CREATE INDEX IF NOT EXISTS idx_orders_venue ON orders(venue_id, status);
  CREATE INDEX IF NOT EXISTS idx_menu_venue ON menu_items(venue_id);
`);

export const bus = new EventEmitter();
bus.setMaxListeners(0);
const uid = (n = 10) => crypto.randomBytes(n).toString('base64url');

/* ------------------------------- owners -------------------------------- */
export function createOwner(email, passHash) {
  const id = 'own_' + uid();
  db.prepare('INSERT INTO owners (id, email, pass_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(id, email, passHash, Date.now());
  return { id, email };
}
export const getOwnerByEmail = (email) =>
  db.prepare('SELECT * FROM owners WHERE email = ?').get(email) || null;
export const getOwner = (id) =>
  db.prepare('SELECT * FROM owners WHERE id = ?').get(id) || null;

/* ------------------------------- venues -------------------------------- */
export function slugify(name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'venue';
  return base + '-' + crypto.randomBytes(2).toString('hex');
}
export function createVenue(ownerId, name, mode, kitchenPin) {
  const id = slugify(name);
  db.prepare('INSERT INTO venues (id, owner_id, name, mode, kitchen_pin, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, ownerId, name, mode, kitchenPin, Date.now());
  return getVenue(id);
}
export const getVenue = (id) =>
  db.prepare('SELECT * FROM venues WHERE id = ?').get(id) || null;
export const getVenueByOwner = (ownerId) =>
  db.prepare('SELECT * FROM venues WHERE owner_id = ?').get(ownerId) || null;
export function updateVenue(id, { name, mode, kitchen_pin }) {
  const v = getVenue(id); if (!v) return null;
  db.prepare('UPDATE venues SET name = ?, mode = ?, kitchen_pin = ? WHERE id = ?')
    .run(name ?? v.name, mode ?? v.mode, kitchen_pin ?? v.kitchen_pin, id);
  return getVenue(id);
}
export function nextToken(venueId) {
  db.prepare('UPDATE venues SET token_counter = token_counter + 1 WHERE id = ?').run(venueId);
  return getVenue(venueId).token_counter;
}

/* -------------------------------- menu --------------------------------- */
export const listMenu = (venueId, onlyAvailable = false) =>
  db.prepare(`SELECT * FROM menu_items WHERE venue_id = ? ${onlyAvailable ? 'AND available = 1' : ''} ORDER BY cat, name`)
    .all(venueId);
export const getMenuItem = (venueId, id) =>
  db.prepare('SELECT * FROM menu_items WHERE venue_id = ? AND id = ?').get(venueId, id) || null;
export function addMenuItem(venueId, { name, price, cat, diet }) {
  const id = 'itm_' + uid(6);
  db.prepare('INSERT INTO menu_items (id, venue_id, name, price, cat, diet) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, venueId, name, price, cat, diet);
  return getMenuItem(venueId, id);
}
export function updateMenuItem(venueId, id, patch) {
  const it = getMenuItem(venueId, id); if (!it) return null;
  db.prepare('UPDATE menu_items SET name = ?, price = ?, cat = ?, diet = ?, available = ? WHERE venue_id = ? AND id = ?')
    .run(patch.name ?? it.name, patch.price ?? it.price, patch.cat ?? it.cat,
         patch.diet ?? it.diet, patch.available ?? it.available, venueId, id);
  return getMenuItem(venueId, id);
}
export function deleteMenuItem(venueId, id) {
  db.prepare('DELETE FROM menu_items WHERE venue_id = ? AND id = ?').run(venueId, id);
}

/* -------------------------------- orders ------------------------------- */
const rowToOrder = (r) => r && ({
  venueId: r.venue_id, token: r.token, table: r.table_id,
  items: JSON.parse(r.items_json), subtotal: r.subtotal, tax: r.tax, total: r.total,
  status: r.status, timing: r.timing, method: r.method, paid: !!r.paid,
  placedAt: r.placed_at, updatedAt: r.updated_at,
});
export function createOrder(o) {
  db.prepare(`INSERT INTO orders (venue_id, token, table_id, items_json, subtotal, tax, total,
      status, timing, method, paid, payment_ref, placed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(o.venueId, o.token, o.table, JSON.stringify(o.items), o.subtotal, o.tax, o.total,
         o.status, o.timing, o.method, o.paid ? 1 : 0, o.paymentRef || null, o.placedAt, o.placedAt);
  const saved = getOrder(o.venueId, o.token);
  bus.emit('venue:' + o.venueId, saved);
  bus.emit('order:' + o.venueId + ':' + o.token, saved);
  return saved;
}
export const getOrder = (venueId, token) =>
  rowToOrder(db.prepare('SELECT * FROM orders WHERE venue_id = ? AND token = ?').get(venueId, token));
export function updateOrder(venueId, token, patch) {
  const cur = getOrder(venueId, token); if (!cur) return null;
  const merged = { ...cur, ...patch };
  db.prepare('UPDATE orders SET status = ?, method = ?, paid = ?, updated_at = ? WHERE venue_id = ? AND token = ?')
    .run(merged.status, merged.method, merged.paid ? 1 : 0, Date.now(), venueId, token);
  const saved = getOrder(venueId, token);
  bus.emit('venue:' + venueId, saved);
  bus.emit('order:' + venueId + ':' + token, saved);
  return saved;
}
export const listOrders = (venueId) =>
  db.prepare('SELECT * FROM orders WHERE venue_id = ? ORDER BY token').all(venueId).map(rowToOrder);
