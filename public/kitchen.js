// Kitchen display, venue-scoped. Staff sign in with the venue code + the PIN
// the owner set in the dashboard.
const K = { venueId: null, token: null, venue: null, orders: new Map(), es: null, flash: false };
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
      if (!existed) { K.flash = true; setTimeout(() => { K.flash = false; const d = $('#liveDot'); if (d) d.style.background = 'var(--s-ready)'; }, 1200); }
      renderBoard();
    } catch (_) {}
  };
}

function renderBoard() {
  const all = [...K.orders.values()].sort((a, b) => a.token - b.token);
  const open = all.filter((o) => o.status !== 'completed');
  const done = all.filter((o) => o.status === 'completed').slice(-6).reverse();

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
  const doneStrip = done.length ? `<div style="margin-top:26px"><div style="font-size:12px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#6E6962;margin:0 2px 8px">Recently completed</div>
    <div class="done-row">` + done.map((o) => `<span class="done-chip"><b>#${o.token}</b> · T${esc(o.table)} · ${money(o.total)}</span>`).join('') + `</div></div>` : '';

  root().innerHTML = `<div class="kdb">
    <div class="topbar2"><div class="row">
      <div class="brand2">${icon('chef',22)}<div><div style="font-weight:800;line-height:1.1">${esc(K.venue ? K.venue.name : 'Kitchen')}</div>
        <small><span id="liveDot" class="live-dot" style="${K.flash ? 'background:var(--amber)' : ''}"></span> Live kitchen display</small></div></div>
      <button class="exit" onclick="logout()">${icon('store',15)} Sign out</button>
    </div></div>
    <div class="wrap-wide" style="padding-top:16px;padding-bottom:40px">${body}${doneStrip}</div>
  </div>`;
}

function ticket(o, action) {
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
  return `<div class="ticket" style="border-top-color:var(--s-${o.status})">
    <div class="head"><div><div class="tk">#${o.token}</div><div class="meta">Table ${esc(o.table)} · ${mins === 0 ? 'just now' : mins + 'm ago'}</div></div>
      <div class="badges">${badges}</div></div>
    <div class="lines">${lines}<div class="amt tabular">${money(o.total)}</div></div>
    <div class="acts">${advanceBtn}${collectBtn}</div></div>`;
}

async function advance(token) {
  try { const { order } = await api(V('/kitchen/orders/' + token + '/advance'), { method: 'POST', token: K.token }); K.orders.set(order.token, order); renderBoard(); }
  catch (e) { toast(e.message); if (/sign-?in/i.test(e.message)) logout(); }
}
async function collect(token) {
  try { const { order } = await api(V('/kitchen/orders/' + token + '/collect'), { method: 'POST', token: K.token }); K.orders.set(order.token, order); renderBoard(); toast('Payment collected'); }
  catch (e) { toast(e.message); }
}

boot();
setInterval(() => { if (K.token && K.venue) renderBoard(); }, 30000);
