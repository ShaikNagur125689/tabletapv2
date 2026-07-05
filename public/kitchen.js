// Kitchen display, venue-scoped. Staff sign in with the venue code + the PIN
// the owner set in the dashboard.
const K = { venueId: null, token: null, venue: null, orders: new Map(), es: null, flash: false, unacked: new Set() };
const COLS = [
  { key: 'placed', title: 'New', action: 'Start preparing' },
  { key: 'preparing', title: 'Preparing', action: 'Mark ready' },
  { key: 'ready', title: 'Ready', action: 'Hand over' },
];
const root = () => $('#app');
const V = (p) => '/api/venues/' + encodeURIComponent(K.venueId) + p;

function boot() {
  $('#boot') && ($('#boot').innerHTML = icon('loader', 20));
  const p = new URLSearchParams(location.search);
  K.venueId = p.get('v') || localStorage.getItem('tt_kitchen_venue') || '';
  const saved = localStorage.getItem('tt_kitchen_tok_' + K.venueId);
  if (K.venueId && saved) { K.token = saved; open(); } else renderLogin();
}

async function open() {
  try {
    const { orders } = await api(V('/kitchen/orders'), { token: K.token });
    const cfg = await api(V('/config'));
    K.venue = cfg.venue;
    K.orders = new Map(orders.map((o) => [o.token, o]));
    renderBoard(); subscribe();
  } catch (e) {
    localStorage.removeItem('tt_kitchen_tok_' + K.venueId); K.token = null;
    renderLogin();
  }
}

function renderLogin(err = '') {
  root().innerHTML = `<div class="login"><div class="box">
    <span style="color:var(--amber)">${icon('chef', 28)}</span>
    <h2>Kitchen Display</h2><p>Enter your venue code and the kitchen PIN your owner set in the dashboard.</p>
    <input class="input" id="vid" placeholder="Venue code (e.g. batman-cafe-6727)" value="${esc(K.venueId || '')}" autocomplete="off" />
    <input class="input" id="pin" type="password" inputmode="numeric" placeholder="Kitchen PIN" autocomplete="off" />
    <div class="err" id="err">${esc(err)}</div>
    <button class="btn btn-amber" style="width:100%" id="go" onclick="doLogin()">Sign in</button>
    <p style="margin-top:14px;font-size:12px;color:#8A8276">The venue code is shown in the owner dashboard's kitchen link.</p>
  </div></div>`;
  $('#pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
}
async function doLogin() {
  initAudio();
  const btn = $('#go'); btn.disabled = true; btn.textContent = 'Signing in…';
  K.venueId = $('#vid').value.trim();
  try {
    const res = await api(V('/kitchen/login'), { method: 'POST', body: { pin: $('#pin').value.trim() } });
    K.token = res.token; K.venue = res.venue;
    localStorage.setItem('tt_kitchen_venue', K.venueId);
    localStorage.setItem('tt_kitchen_tok_' + K.venueId, res.token);
    await open();
  } catch (e) { btn.disabled = false; btn.textContent = 'Sign in'; $('#err').textContent = e.message; }
}
function logout() {
  if (K.es) K.es.close();
  localStorage.removeItem('tt_kitchen_tok_' + K.venueId);
  K.token = null; K.orders.clear(); renderLogin();
}

function subscribe() {
  if (K.es) K.es.close();
  K.es = new EventSource('/api/stream/venues/' + encodeURIComponent(K.venueId) + '/kitchen?token=' + encodeURIComponent(K.token));
  K.es.onmessage = (ev) => {
    try {
      const o = JSON.parse(ev.data);
      const existed = K.orders.has(o.token);
      K.orders.set(o.token, o);
      if (o.status !== 'placed') K.unacked.delete(o.token);
      if (!existed && o.status === 'placed') {
        K.unacked.add(o.token); // nags every 10s until a human acknowledges it
        chime();
        K.flash = true; setTimeout(() => { K.flash = false; const d = $('#liveDot'); if (d) d.style.background = 'var(--s-ready)'; }, 1200);
      }
      renderBoard();
    } catch (_) {}
  };
}

setInterval(() => { if (K.unacked.size > 0) chime(); }, 10_000);
function ack(token) { if (K.unacked.delete(token)) renderBoard(); }

// Two-tone alert using WebAudio (no sound file needed). The AudioContext is
// created on the sign-in click, so browsers allow it to play.
let audioCtx = null;
function initAudio() { try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch (_) {} }
// Browsers only allow sound after a user gesture. Login covers fresh sign-ins,
// but a SAVED session skips login — so the first tap anywhere unlocks audio too.
['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, initAudio, { once: true, capture: true }));
K.muted = localStorage.getItem('tt_kitchen_muted') === '1';
function toggleMute() {
  K.muted = !K.muted;
  localStorage.setItem('tt_kitchen_muted', K.muted ? '1' : '0');
  initAudio();
  if (!K.muted) chime(); // audible confirmation that sound now works
  renderBoard();
}
function chime() {
  if (!audioCtx || K.muted) return;
  try {
    const t0 = audioCtx.currentTime;
    [[880, 0], [1175, 0.18]].forEach(([freq, dt]) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = freq; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t0 + dt);
      g.gain.exponentialRampToValueAtTime(0.4, t0 + dt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.35);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t0 + dt); o.stop(t0 + dt + 0.4);
    });
  } catch (_) {}
}

function renderBoard() {
  const all = [...K.orders.values()].sort((a, b) => a.token - b.token);
  const open = all.filter((o) => o.status !== 'completed');
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const today = all.filter((o) => o.placedAt >= midnight.getTime());
  const todayLive = today.filter((o) => o.status !== 'cancelled');
  const refundsDue = all.filter((o) => o.status === 'cancelled' && o.paid && !o.refunded).length;
  const statsBar = `<div style="display:flex;flex-wrap:wrap;gap:14px;align-items:center;color:#A9A39A;font-size:13px;margin:0 2px 14px">
    <span><b style="color:var(--paper);font-size:16px">${todayLive.length}</b> orders today</span>
    <span><b style="color:var(--paper);font-size:16px">${open.length}</b> open now</span>
    ${today.length - todayLive.length ? `<span style="color:#C97B7B">${today.length - todayLive.length} cancelled</span>` : ''}
    ${refundsDue ? `<span style="color:#E0A030;font-weight:700">${refundsDue} refund${refundsDue > 1 ? 's' : ''} pending ↓</span>` : ''}
  </div>`;
  const done = all.filter((o) => o.status === 'completed' || o.status === 'cancelled').slice(-12).reverse();

  let body;
  if (open.length === 0) {
    body = `<div style="text-align:center;padding:70px 0"><div style="color:#5A5349">${icon('bell',34)}</div>
      <div style="color:var(--paper);font-weight:700;margin-top:10px">No open orders</div>
      <div style="color:#8A8276;font-size:14px;margin-top:4px">New tickets from diners appear here automatically.</div></div>`;
  } else {
    body = `<div class="cols">` + COLS.map((col) => {
      const list = all.filter((o) => o.status === col.key);
      const cards = list.length ? list.map((o) => ticket(o, col.action)).join('') : `<div class="empty-col">Empty</div>`;
      return `<div class="col"><h3><span style="width:9px;height:9px;border-radius:50%;background:var(--s-${col.key})"></span>${col.title}<span class="count">${list.length}</span></h3>${cards}</div>`;
    }).join('') + `</div>`;
  }
  const doneStrip = done.length ? `<div style="margin-top:26px">
    <div style="font-size:12px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#6E6962;margin:0 2px 10px">Completed &amp; cancelled today</div>
    <div style="display:grid;grid-template-columns:1fr;gap:8px">` + done.map(historyRow).join('') + `</div></div>` : '';

  root().innerHTML = `<div class="kdb">
    <div class="topbar2"><div class="row">
      <div class="brand2">${icon('chef',22)}<div><div style="font-weight:800;line-height:1.1">${esc(K.venue ? K.venue.name : 'Kitchen')}</div>
        <small><span id="liveDot" class="live-dot" style="${K.flash ? 'background:var(--amber)' : ''}"></span> Live kitchen display</small></div></div>
      <button class="exit" onclick="logout()">${icon('store',15)} Sign out</button>
    </div></div>
    <div class="wrap-wide" style="padding-top:16px;padding-bottom:40px">${statsBar}${body}${doneStrip}</div>
  </div>`;
}

function ticket(o, action) {
  const unacked = K.unacked.has(o.token);
  const cashDue = o.method === 'cash' && !o.paid;
  const payAfter = o.timing === 'after' && !o.paid && o.method !== 'cash';
  const mins = Math.max(0, Math.floor((Date.now() - o.placedAt) / 60000));
  const badges = [
    o.paid ? `<span class="pill" style="color:#0E7C57;background:#DDF3E9">${icon('check',12,2.6)} Paid</span>` : '',
    cashDue ? `<span class="pill" style="color:#9A6312;background:#FBF1DD">${icon('wallet',12)} Cash due</span>` : '',
    payAfter ? `<span class="pill" style="color:#6B6357;background:#EFEBE2">${icon('receipt',12)} Pay after</span>` : '',
  ].join('');
  const lines = o.items.map((it) => `<div class="li"><span class="q" style="color:var(--s-${o.status})">${it.qty}×</span><span class="diet ${it.diet}"><i></i></span><span class="nm">${esc(it.name)}</span></div>`).join('');
  const advanceBtn = o.status !== 'completed' ? `<button class="btn" style="background:var(--s-${o.status});color:#fff" onclick="advance(${o.token})">${action}</button>` : '';
  const collectBtn = cashDue ? `<button class="btn" style="background:#FBF1DD;color:#9A6312;border:1px solid #F0DDB4" onclick="collect(${o.token})">Mark cash collected</button>`
    : (payAfter && (o.status === 'ready' || o.status === 'completed')) ? `<button class="btn btn-ghost" onclick="collect(${o.token})">Collect payment</button>` : '';
  const newBadge = unacked ? `<span class="pill pulse" style="color:#fff;background:var(--s-placed)">NEW</span>` : '';
  const noteLine = o.note ? `<div style="margin-top:6px;font-size:13px;font-weight:600;background:#FBF1DD;color:#7A5410;border-radius:8px;padding:7px 9px">📝 ${esc(o.note)}</div>` : '';
  const cancelBtn = (o.status !== 'completed') ? `<button class="btn" style="background:transparent;color:#B23B3B;font-size:13px;padding:6px" onclick="event.stopPropagation();kitchenCancel(${o.token})">Cancel order</button>` : '';
  return `<div class="ticket" style="border-top-color:var(--s-${o.status});${unacked ? 'box-shadow:0 0 0 3px var(--s-placed);' : ''}" onclick="ack(${o.token})">
    <div class="head"><div><div class="tk">#${o.token}</div><div class="meta">Table ${esc(o.table)} · ${mins === 0 ? 'just now' : mins + 'm ago'}</div></div>
      <div class="badges">${newBadge}${badges}</div></div>
    <div class="lines">${lines}${noteLine}<div class="amt tabular">${money(o.total)}</div></div>
    <div class="acts">${advanceBtn}${collectBtn}${cancelBtn}</div></div>`;
}

function historyRow(o) {
  const canc = o.status === 'cancelled';
  const time = new Date(o.placedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const itemsLine = o.items.map((it) => `${it.qty}× ${esc(it.name)}`).join(' · ');
  const refundDue = canc && o.paid && !o.refunded;
  const badges = [
    canc ? `<span class="pill" style="color:#C97B7B;background:#2A1A1A">✕ Cancelled${o.cancelledBy === 'kitchen' ? ' (kitchen)' : ''}</span>`
         : `<span class="pill" style="color:#7BAF8E;background:#18251D">${icon('check',12,2.6)} Done</span>`,
    !canc && o.paid ? `<span class="pill" style="color:#7BAF8E;background:#18251D">Paid</span>` : '',
    !canc && !o.paid ? `<span class="pill" style="color:#C9A35B;background:#2A2114">Unpaid</span>` : '',
    canc && o.paid && o.refunded ? `<span class="pill" style="color:#7BAF8E;background:#18251D">Refunded</span>` : '',
    refundDue ? `<span class="pill" style="color:#17130F;background:#E0A030">Refund due</span>` : '',
  ].join('');
  return `<div style="background:#1E1812;border-radius:12px;padding:12px 14px;display:flex;flex-wrap:wrap;gap:10px;align-items:center">
    <div style="min-width:130px"><span style="font-family:var(--mono);font-weight:800;color:#B7B0A4;font-size:16px">#${o.token}</span>
      <span style="color:#8A8276;font-size:13px"> · T${esc(o.table)} · ${time}</span></div>
    <div style="flex:1;min-width:160px;color:#A9A39A;font-size:13px">${itemsLine}${o.note ? `<div style="color:#C9A35B">📝 ${esc(o.note)}</div>` : ''}${o.cancelReason ? `<div style="color:#C97B7B">Reason: ${esc(o.cancelReason)}</div>` : ''}</div>
    <div style="font-weight:800;color:#B7B0A4" class="tabular">${money(o.total)}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">${badges}</div>
    ${refundDue ? `<button class="btn" style="background:#E0A030;color:#17130F;font-size:13px;padding:8px 12px" onclick="markRefunded(${o.token})">Mark refunded</button>` : ''}
  </div>`;
}
async function markRefunded(token) {
  if (!confirm('Confirm you have returned the money for order #' + token + '?')) return;
  try {
    const { order } = await api(V('/kitchen/orders/' + token + '/refund'), { method: 'POST', token: K.token });
    K.orders.set(order.token, order); renderBoard(); toast('Refund recorded');
  } catch (e) { toast(e.message); }
}
async function advance(token) {
  K.unacked.delete(token);
  try { const { order } = await api(V('/kitchen/orders/' + token + '/advance'), { method: 'POST', token: K.token }); K.orders.set(order.token, order); renderBoard(); }
  catch (e) { toast(e.message); if (/sign-?in/i.test(e.message)) logout(); }
}
async function kitchenCancel(token) {
  const reason = prompt('Cancel order #' + token + '?\nOptional reason shown to the customer (e.g. "Item out of stock"):');
  if (reason === null) return; // staff pressed Cancel on the prompt
  K.unacked.delete(token);
  try {
    const { order } = await api(V('/kitchen/orders/' + token + '/cancel'), { method: 'POST', token: K.token, body: { reason: reason.trim() } });
    K.orders.set(order.token, order); renderBoard();
    toast(order.paid ? 'Cancelled — customer paid, refund at counter' : 'Order cancelled');
  } catch (e) { toast(e.message); }
}
async function collect(token) {
  try { const { order } = await api(V('/kitchen/orders/' + token + '/collect'), { method: 'POST', token: K.token }); K.orders.set(order.token, order); renderBoard(); toast('Payment collected'); }
  catch (e) { toast(e.message); }
}

boot();
setInterval(() => { if (K.token && K.venue) renderBoard(); }, 30000);
