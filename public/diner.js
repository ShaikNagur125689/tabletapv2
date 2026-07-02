// Diner flow, venue-scoped: /order?v=<venueId>&t=<table>&sig=<hmac>
const app = {
  stage: 'menu', venueId: null, table: null, sig: null,
  config: null, menu: [], categories: [], activeCat: null,
  cart: {}, order: null, idemKey: null,
  payMode: 'now', method: 'online', es: null,
};
const root = () => $('#app');
const V = (p) => '/api/venues/' + encodeURIComponent(app.venueId) + p;

const activeKey = () => 'tt_order_' + app.venueId + '_' + app.table;
const saveActive = (t) => { try { localStorage.setItem(activeKey(), String(t)); } catch (_) {} };
const clearActive = () => { try { localStorage.removeItem(activeKey()); } catch (_) {} };
const getActive = () => { try { return localStorage.getItem(activeKey()); } catch (_) { return null; } };

function init() {
  const p = new URLSearchParams(location.search);
  app.venueId = p.get('v'); app.table = p.get('t'); app.sig = p.get('sig');
  $('#boot') && ($('#boot').innerHTML = icon('loader', 20));
  if (!app.venueId || !app.table || !app.sig) {
    root().innerHTML = `<div class="center-load" style="color:var(--sub);flex-direction:column;text-align:center;padding:0 24px">
      <div style="margin-top:80px">${icon('qr', 40)}</div>
      <h2 class="page">Scan your table's QR</h2>
      <p style="max-width:300px">Please scan the QR code placed on your table to start ordering.</p></div>`;
    return;
  }
  load();
}

async function load() {
  try {
    const [cfg, mn] = await Promise.all([api(V('/config')), api(V('/menu'))]);
    app.config = cfg; app.menu = mn.menu; app.categories = mn.categories;
    app.activeCat = app.categories[0] || null;
    app.payMode = cfg.venue.mode === 'cafe' ? 'now' : 'after';
    const saved = getActive();
    if (saved) {
      try {
        const { order } = await api(V('/orders/' + saved));
        app.order = order; app.stage = 'track';
        render(); subscribe(); return;
      } catch (_) { clearActive(); }
    }
    render();
  } catch (e) { root().innerHTML = `<div class="center-load" style="color:var(--sub)">${esc(e.message)}</div>`; }
}

const itemById = (id) => app.menu.find((m) => m.id === id);
const cartCount = () => Object.values(app.cart).reduce((a, b) => a + b, 0);
const subtotal = () => Object.entries(app.cart).reduce((s, [id, q]) => s + (itemById(id)?.price || 0) * q, 0);
const taxAmt = () => Math.round(subtotal() * (app.config.taxRatePct / 100));
const totalAmt = () => subtotal() + taxAmt();
const addItem = (id) => { app.cart[id] = (app.cart[id] || 0) + 1; render(); };
const subItem = (id) => { if (!app.cart[id]) return; app.cart[id]--; if (app.cart[id] <= 0) delete app.cart[id]; render(); };

function render() {
  if (app.stage === 'track') return renderTrack();
  if (app.stage === 'checkout') return renderCheckout();
  const cafe = app.config.venue.mode === 'cafe';
  let html = `
  <div class="topbar"><div class="row">
    <span style="width:22px"></span>
    <div style="text-align:center"><div class="eyebrow">${esc(app.config.venue.name)}</div><div class="ttl">Table ${esc(app.table)}</div></div>
    <span class="pill" style="background:#fff;color:var(--brand)">${cafe ? 'Pay first' : 'Pay after'}</span>
  </div></div>`;

  if (app.menu.length === 0) {
    html += `<div class="center-load" style="color:var(--sub);flex-direction:column"><p>The menu is being set up. Please check with the counter.</p></div>`;
    root().innerHTML = html; return;
  }

  if (app.stage === 'menu') {
    html += `<div class="cat-rail"><div class="inner">` +
      app.categories.map((c) => `<button class="chip ${c === app.activeCat ? 'on' : ''}" onclick="setCat('${esc(c)}')">${esc(c)}</button>`).join('') +
      `</div></div><div class="wrap" style="padding-top:12px;padding-bottom:${cartCount() ? 96 : 24}px">
      <h2 class="page">${esc(app.activeCat)}</h2>` +
      app.menu.filter((m) => m.cat === app.activeCat).map(menuRow).join('') + `</div>`;
  } else {
    html += `<div class="wrap" style="padding-top:14px;padding-bottom:120px">
      <button class="btn" style="padding:0;color:var(--brand);font-size:14px;font-weight:600;margin-bottom:10px" onclick="goMenu()">${icon('chevL',16)} Add more items</button>
      <h2 class="page">Your order</h2>
      <div class="card" style="overflow:hidden">` +
      Object.entries(app.cart).map(([id, q], i) => cartRow(id, q, i)).join('') + `</div>
      <div class="card summ" style="margin-top:12px">
        <div class="ln"><span>Item total</span><span class="tabular">${money(subtotal())}</span></div>
        <div class="ln"><span>Taxes (${app.config.taxRatePct}%)</span><span class="tabular">${money(taxAmt())}</span></div>
        <div class="ln tot"><span>To pay</span><span class="tabular">${money(totalAmt())}</span></div>
      </div></div>`;
  }

  if (cartCount() > 0) {
    html += `<div class="dock"><div class="inner">` + (app.stage === 'menu'
      ? `<button class="btn bar btn-ink" onclick="goCart()"><span style="display:flex;gap:8px;align-items:center;font-weight:800">${icon('bag',18)} ${cartCount()} ${cartCount() === 1 ? 'item' : 'items'}</span><span style="display:flex;gap:8px;align-items:center;font-weight:800">${money(totalAmt())} ${icon('arrowR',18)}</span></button>`
      : `<button class="btn bar btn-amber" style="justify-content:center" onclick="goCheckout()">Checkout · ${money(totalAmt())} ${icon('arrowR',18)}</button>`)
      + `</div></div>`;
  }
  root().innerHTML = html;
}
function menuRow(m) {
  const q = app.cart[m.id] || 0;
  const ctrl = q === 0
    ? `<button class="add" onclick="addItem('${m.id}')">${icon('plus',15,2.6)} Add</button>`
    : `<div class="stepper"><button onclick="subItem('${m.id}')">${icon('minus',16,2.8)}</button><span class="q tabular">${q}</span><button onclick="addItem('${m.id}')">${icon('plus',16,2.8)}</button></div>`;
  return `<div class="card menu-item"><div class="info"><span class="diet ${m.diet}"><i></i></span>
    <span><span class="name">${esc(m.name)}</span><div class="price">${money(m.price)}</div></span></div>${ctrl}</div>`;
}
function cartRow(id, q, i) {
  const m = itemById(id);
  return `<div class="row-sb" style="padding:12px 14px;${i ? 'border-top:1px solid var(--line)' : ''}">
    <div style="display:flex;gap:10px;align-items:center;min-width:0"><span class="diet ${m.diet}"><i></i></span>
      <span><div style="font-weight:600">${esc(m.name)}</div><div style="font-size:12px;color:var(--sub)">${money(m.price)} each</div></span></div>
    <div style="display:flex;gap:12px;align-items:center">
      <div class="stepper" style="background:#F1EDE4"><button style="color:var(--ink)" onclick="subItem('${id}')">${icon('minus',15,2.6)}</button><span class="q tabular" style="color:var(--ink)">${q}</span><button style="color:var(--ink)" onclick="addItem('${id}')">${icon('plus',15,2.6)}</button></div>
      <b class="tabular" style="width:64px;text-align:right">${money(m.price * q)}</b></div></div>`;
}

function renderCheckout() {
  const cafe = app.config.venue.mode === 'cafe';
  const payingNow = cafe || app.payMode === 'now';
  let html = `
  <div class="topbar"><div class="row"><button class="iconbtn" onclick="goCart()">${icon('chevL',22)}</button>
    <span class="ttl">Checkout</span><span style="width:22px"></span></div></div>
  <div class="wrap" style="padding-top:16px;padding-bottom:120px">
    <div class="card summ">
      <div class="ln"><span>Items (${cartCount()})</span><span class="tabular">${money(subtotal())}</span></div>
      <div class="ln"><span>Taxes (${app.config.taxRatePct}%)</span><span class="tabular">${money(taxAmt())}</span></div>
      <div class="ln tot"><span>Total</span><span class="tabular">${money(totalAmt())}</span></div>
    </div>
    <div class="note">${icon('clock',18)}<span>${cafe
      ? 'This is a cafe — orders are paid in advance, then prepared.'
      : 'This is a restaurant — order now and settle the bill after your meal, or pay now if you prefer.'}</span></div>`;
  if (!cafe) {
    html += `<div class="choice">
      <button class="${app.payMode === 'after' ? 'on' : ''}" onclick="setPayMode('after')">${icon('receipt',18)}<b>Pay after meal</b><small>Settle the bill later</small></button>
      <button class="${app.payMode === 'now' ? 'on' : ''}" onclick="setPayMode('now')">${icon('wallet',18)}<b>Pay now</b><small>Settle in advance</small></button>
    </div>`;
  }
  if (payingNow) {
    html += `<p class="section-label">How would you like to pay?</p>
      ${methodRow('online', 'card', 'Pay online', 'UPI · Card · Wallet')}
      ${methodRow('cash', 'wallet', 'Pay cash at counter', 'No online payment needed')}`;
    if (app.method === 'cash') html += `<p style="font-size:12px;color:var(--sub);margin-top:2px">Your token is issued right away. Show it and pay cash at the counter.</p>`;
  }
  html += `</div>
  <div class="dock"><div class="inner"><button class="btn bar btn-brand" id="placeBtn" style="justify-content:center" onclick="placeOrder()">${placeLabel(payingNow)}</button></div></div>`;
  root().innerHTML = html;
}
function methodRow(key, ic, title, sub) {
  const on = app.method === key;
  return `<button class="method ${on ? 'on' : ''}" onclick="setMethod('${key}')">
    <span class="ic">${icon(ic,19)}</span><span class="tx"><b>${title}</b><small>${sub}</small></span>
    <span class="rad" style="display:flex;align-items:center;justify-content:center">${on ? `<span style="color:#fff">${icon('check',13,3)}</span>` : ''}</span></button>`;
}
function placeLabel(payingNow) {
  if (payingNow) return app.method === 'online' ? `Pay ${money(totalAmt())} &amp; place order` : `Place order · pay ${money(totalAmt())} at counter`;
  return `Place order · pay after meal`;
}

async function placeOrder() {
  const btn = $('#placeBtn'); if (btn) { btn.disabled = true; btn.textContent = 'Placing order…'; }
  app.idemKey = app.idemKey || (Date.now() + '-' + Math.random().toString(16).slice(2));
  const cafe = app.config.venue.mode === 'cafe';
  const lines = Object.entries(app.cart).map(([id, qty]) => ({ id, qty }));
  try {
    const { order } = await api(V('/orders'), { method: 'POST', body: {
      table: app.table, sig: app.sig, lines,
      pay: { mode: cafe ? 'now' : app.payMode, method: app.method },
      idempotencyKey: app.idemKey,
    }});
    app.order = order; app.stage = 'track'; app.idemKey = null;
    saveActive(order.token);
    render(); subscribe();
  } catch (e) { toast(e.message); renderCheckout(); }
}

function subscribe() {
  if (app.es) app.es.close();
  app.es = new EventSource('/api/stream/venues/' + encodeURIComponent(app.venueId) + '/orders/' + app.order.token);
  app.es.onmessage = (ev) => { try { app.order = JSON.parse(ev.data); if (app.stage === 'track') renderTrack(); } catch (_) {} };
}

function renderTrack() {
  const o = app.order;
  const curIdx = FLOW.indexOf(o.status);
  const st = STATUS[o.status];
  const needsSettle = o.timing === 'after' && !o.paid && (o.status === 'ready' || o.status === 'completed');
  const payText = o.paid ? 'Paid' : o.method === 'cash' ? 'Pay cash at counter' : o.timing === 'after' ? 'Settle after your meal' : 'Payment pending';

  const steps = FLOW.map((s, i) => {
    const done = i < curIdx, active = i === curIdx, c = STATUS[s].color;
    const dot = done ? `<div class="dot" style="background:${c}"><span style="color:#fff">${icon('check',16,2.6)}</span></div>`
      : `<div class="dot" ${active ? `style="background:${c}"` : ''}><i ${active ? 'style="background:#fff"' : ''}></i></div>`;
    const bar = i < FLOW.length - 1 ? `<div class="bar" ${done ? `style="background:${c}"` : ''}></div>` : '';
    const sub = active ? (s === 'completed' ? '<small>Enjoy your meal!</small>' : '<small>The outlet is on it…</small>') : '';
    return `<div class="step"><div class="dot-wrap">${dot}${bar}</div><div class="lbl ${done || active ? '' : 'muted'}"><b>${STATUS[s].diner}</b>${sub}</div></div>`;
  }).join('');

  let html = `
  <div class="topbar"><div class="row"><span class="ttl">${esc(app.config.venue.name)}</span>
    <span class="pill" style="background:#fff;color:var(--brand)">Table ${esc(o.table)}</span></div></div>
  <div class="wrap" style="padding-bottom:40px">
    <div class="stub">
      <div class="token-cap"><div class="cap">Your token</div>
        <div class="token">${o.token}</div>
        <span class="pill" style="color:#fff;background:${st.color}"><span class="pulse" style="width:7px;height:7px;border-radius:50%;background:#fff"></span> ${st.diner}</span>
      </div>
      <div class="perf"><span class="n l"></span><span class="n r"></span><div class="line"></div></div>
      <div class="steps">${steps}</div>
    </div>
    <div class="card row-sb" style="padding:16px;margin-top:12px">
      <div style="display:flex;gap:10px;align-items:center">${icon('receipt',18)}
        <div><div style="font-weight:700" class="tabular">${money(o.total)}</div><div style="font-size:12px;color:var(--sub)">${payText}</div></div></div>
      ${o.paid ? `<span class="pill" style="color:#0E7C57;background:#DDF3E9">${icon('check',13,2.6)} Paid</span>`
              : `<span class="pill" style="color:#9A6312;background:#FBF1DD">${icon('wallet',13)} Due</span>`}
    </div>`;
  if (needsSettle) {
    html += `<div class="card" style="padding:16px;margin-top:12px;border:2px solid var(--amber)">
      <b>Settle your bill</b>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px">
        <button class="btn btn-brand" onclick="settle('online')">Pay online</button>
        <button class="btn btn-ghost" onclick="settle('cash')">Cash at counter</button></div></div>`;
  }
  html += `<p style="text-align:center;font-size:12px;color:var(--sub);margin-top:16px">Saved to this phone — rescan the table QR anytime to return here.</p>
    <button class="btn btn-ink" style="width:100%;margin-top:8px" onclick="orderMore()">Order something else</button></div>`;
  root().innerHTML = html;
}
async function settle(method) {
  try { const { order } = await api(V('/orders/' + app.order.token + '/settle'), { method: 'POST', body: { method } });
    app.order = order; renderTrack(); toast(method === 'online' ? 'Payment received' : 'Please pay cash at the counter');
  } catch (e) { toast(e.message); }
}

function setCat(c) { app.activeCat = c; render(); }
function goMenu() { app.stage = 'menu'; render(); }
function goCart() { app.stage = 'cart'; render(); }
function goCheckout() { app.stage = 'checkout'; render(); }
function setPayMode(m) { app.payMode = m; render(); }
function setMethod(m) { app.method = m; render(); }
function orderMore() { if (app.es) app.es.close(); clearActive(); app.cart = {}; app.order = null; app.stage = 'menu'; render(); }

init();
