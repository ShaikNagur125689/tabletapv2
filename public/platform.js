// TableTap Platform Console — for the platform owner only.
// Generate invite codes (every signup goes through you), see every venue,
// and suspend/reactivate venues (your leverage on non-payers).
const P = { token: null, invites: [], venues: [] };
const root = () => $('#app');

function boot() {
  $('#boot') && ($('#boot').innerHTML = icon('loader', 20));
  P.token = localStorage.getItem('tt_platform');
  if (P.token) open(); else renderLogin();
}

async function open() {
  try {
    const [inv, ven] = await Promise.all([
      api('/api/platform/invites', { token: P.token }),
      api('/api/platform/venues', { token: P.token }),
    ]);
    P.invites = inv.invites; P.venues = ven.venues;
    renderConsole();
  } catch (e) {
    localStorage.removeItem('tt_platform'); P.token = null;
    renderLogin(/sign-?in/i.test(e.message) ? '' : e.message);
  }
}

function renderLogin(err = '') {
  root().innerHTML = `<div class="login"><div class="box">
    <span style="color:var(--amber)">${icon('store', 28)}</span>
    <h2>Platform Console</h2><p>This area is for the TableTap platform owner only.</p>
    <input class="input" id="pw" type="password" placeholder="Platform password" autocomplete="current-password" />
    <div class="err" id="err">${esc(err)}</div>
    <button class="btn btn-amber" style="width:100%" id="go" onclick="doLogin()">Sign in</button>
  </div></div>`;
  const pw = $('#pw'); pw.focus();
  pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
}
async function doLogin() {
  const btn = $('#go'); btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    const res = await api('/api/platform/login', { method: 'POST', body: { password: $('#pw').value } });
    P.token = res.token; localStorage.setItem('tt_platform', res.token);
    await open();
  } catch (e) { btn.disabled = false; btn.textContent = 'Sign in'; $('#err').textContent = e.message; }
}
function logout() { localStorage.removeItem('tt_platform'); P.token = null; renderLogin(); }

function renderConsole() {
  const unused = P.invites.filter((i) => !i.used_by);
  const inviteRows = P.invites.length === 0
    ? `<div class="empty-col">No invite codes yet — generate one for your first cafe.</div>`
    : P.invites.slice(0, 30).map((i) => `
      <div style="background:#1E1812;border-radius:12px;padding:11px 14px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:8px">
        <span style="font-family:var(--mono);font-weight:800;font-size:16px;color:${i.used_by ? '#6E6962' : 'var(--amber)'}">${esc(i.code)}</span>
        <span style="flex:1;color:#8A8276;font-size:13px">created ${new Date(Number(i.created_at)).toLocaleDateString()}</span>
        ${i.used_by
          ? `<span class="pill" style="color:#7BAF8E;background:#18251D">Used · ${esc(i.used_by)}</span>`
          : `<span class="pill" style="color:#17130F;background:var(--amber)">Available</span>
             <button class="exit" onclick="copyCode('${esc(i.code)}')">Copy</button>`}
      </div>`).join('');

  const venueRows = P.venues.length === 0
    ? `<div class="empty-col">No venues yet.</div>`
    : P.venues.map((v) => `
      <div style="background:#1E1812;border-radius:12px;padding:12px 14px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:8px">
        <div style="min-width:180px"><div style="font-weight:800;color:var(--paper)">${esc(v.name)}</div>
          <div style="color:#8A8276;font-size:12px">${esc(v.ownerEmail)} · ${esc(v.mode)} · since ${new Date(v.createdAt).toLocaleDateString()}</div></div>
        <span style="flex:1;color:#A9A39A;font-size:13px"><b style="color:#B7B0A4">${v.orders}</b> orders</span>
        ${v.status === 'suspended'
          ? `<span class="pill" style="color:#C97B7B;background:#2A1A1A">Suspended</span>
             <button class="btn" style="background:var(--s-ready);color:#fff;font-size:13px;padding:8px 12px" onclick="setStatus('${esc(v.id)}','active')">Reactivate</button>`
          : `<span class="pill" style="color:#7BAF8E;background:#18251D">Active</span>
             <button class="btn" style="background:#2A1A1A;color:#C97B7B;font-size:13px;padding:8px 12px" onclick="setStatus('${esc(v.id)}','suspended')">Suspend</button>`}
      </div>`).join('');

  root().innerHTML = `<div class="kdb">
    <div class="topbar2"><div class="row">
      <div class="brand2">${icon('store',22)}<div><div style="font-weight:800;line-height:1.1">Platform Console</div>
        <small>${P.venues.length} venue${P.venues.length === 1 ? '' : 's'} · ${unused.length} invite${unused.length === 1 ? '' : 's'} available</small></div></div>
      <button class="exit" onclick="logout()">Sign out</button>
    </div></div>
    <div class="wrap-wide" style="padding-top:18px;padding-bottom:40px;max-width:820px">
      <div class="row-sb" style="margin-bottom:10px">
        <h3 style="color:var(--paper);font-size:14px;text-transform:uppercase;letter-spacing:.04em;margin:0">Invite codes</h3>
        <button class="btn btn-amber" style="font-size:14px;padding:9px 14px" onclick="genInvite()">+ Generate invite</button>
      </div>
      ${inviteRows}
      <h3 style="color:var(--paper);font-size:14px;text-transform:uppercase;letter-spacing:.04em;margin:26px 0 10px">Venues</h3>
      ${venueRows}
    </div></div>`;
}

async function genInvite() {
  try { const { invite } = await api('/api/platform/invites', { method: 'POST', token: P.token });
    toast('Invite ' + invite.code + ' created'); await open();
  } catch (e) { toast(e.message); }
}
function copyCode(code) {
  try { navigator.clipboard.writeText(code); toast(code + ' copied'); } catch (_) { toast(code); }
}
async function setStatus(id, status) {
  const v = P.venues.find((x) => x.id === id);
  if (status === 'suspended' && !confirm('Suspend "' + (v ? v.name : id) + '"?\nTheir QR ordering and kitchen display stop working until you reactivate.')) return;
  try { await api('/api/platform/venues/' + encodeURIComponent(id) + '/status', { method: 'POST', token: P.token, body: { status } });
    toast(status === 'suspended' ? 'Venue suspended' : 'Venue reactivated'); await open();
  } catch (e) { toast(e.message); }
}

boot();
