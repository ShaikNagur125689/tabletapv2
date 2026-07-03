// Owner dashboard: sign up / sign in, venue settings, menu management, table QRs.
const A = { token: null, venue: null, menu: [], authMode: 'login', editing: null, pendingEmail: null };
const root = () => $('#app');

function boot() {
  $('#boot') && ($('#boot').innerHTML = icon('loader', 20));
  A.token = localStorage.getItem('tt_owner');
  if (A.token) loadVenue(); else renderAuth();
}

async function loadVenue() {
  try {
    const { venue, menu } = await api('/api/owner/venue', { token: A.token });
    A.venue = venue; A.menu = menu;
    renderDash();
  } catch (e) { localStorage.removeItem('tt_owner'); A.token = null; renderAuth(); }
}

/* --------------------------------- auth ----------------------------------- */
function renderAuth(err = '') {
  const login = A.authMode === 'login';
  root().innerHTML = `
  <div class="auth-card">
    <div class="brandmark" style="margin-bottom:14px"><span class="qr" style="width:34px;height:34px;border-radius:10px;background:var(--amber);display:flex;align-items:center;justify-content:center">${icon('qr',19,2.4)}</span>
      <h1 style="font-size:21px;margin:0">TableTap</h1></div>
    <div class="seg">
      <button class="${login ? 'on' : ''}" onclick="setAuthMode('login')">Sign in</button>
      <button class="${!login ? 'on' : ''}" onclick="setAuthMode('register')">Create account</button>
    </div>
    ${!login ? `
    <div class="field"><label>Your cafe / restaurant name</label><input id="f-venue" placeholder="e.g. Batman Cafe" maxlength="60" /></div>
    <div class="field"><label>Venue type</label><select id="f-mode">
      <option value="cafe">Cafe — diners pay in advance</option>
      <option value="restaurant">Restaurant — diners pay after the meal</option></select></div>` : ''}
    <div class="field"><label>Email</label><input id="f-email" type="email" placeholder="you@example.com" autocomplete="username" /></div>
    <div class="field"><label>Password ${!login ? "(8+ chars, letters + numbers)" : ""}</label><input id="f-pass" type="password" autocomplete="${login ? 'current-password' : 'new-password'}" /></div>
    <div class="err" id="err" style="color:#B23B3B">${esc(err)}</div>
    <button class="btn btn-brand" style="width:100%" id="go" onclick="submitAuth()">${login ? 'Sign in' : 'Create my venue'}</button>
  </div>`;
  $('#f-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });
}
function setAuthMode(m) { A.authMode = m; renderAuth(); }
async function submitAuth() {
  const btn = $('#go'); btn.disabled = true;
  const email = $('#f-email').value;
  const body = { email, password: $('#f-pass').value };
  let path = '/api/owners/login';
  if (A.authMode === 'register') {
    path = '/api/owners/register';
    body.venueName = $('#f-venue').value; body.mode = $('#f-mode').value;
  }
  try {
    const res = await api(path, { method: 'POST', body });
    if (res.pending) {                       // signup created a pending account
      A.pendingEmail = res.email;
      renderVerify();
      return;
    }
    A.token = res.token; localStorage.setItem('tt_owner', res.token);
    await loadVenue();
  } catch (e) {
    if (/verify your email/i.test(e.message)) {  // login on an unverified account
      A.pendingEmail = email.trim().toLowerCase();
      renderVerify('We sent a fresh code to your email.');
      return;
    }
    btn.disabled = false; $('#err').textContent = e.message;
  }
}

/* --------------------------- email verification ---------------------------- */
function renderVerify(note = '') {
  root().innerHTML = `
  <div class="auth-card">
    <div class="brandmark" style="margin-bottom:14px"><span class="qr" style="width:34px;height:34px;border-radius:10px;background:var(--amber);display:flex;align-items:center;justify-content:center">${icon('qr',19,2.4)}</span>
      <h1 style="font-size:21px;margin:0">Check your email</h1></div>
    <p style="font-size:14px;color:var(--sub);margin:0 0 16px">We sent a 6-digit code to <b>${esc(A.pendingEmail)}</b>. Enter it below to activate your account. It expires in 15 minutes — check spam if you don't see it.</p>
    <div class="field"><label>Verification code</label>
      <input id="f-code" inputmode="numeric" maxlength="6" placeholder="6-digit code"
        style="letter-spacing:8px;font-size:22px;font-weight:800;text-align:center" autocomplete="one-time-code" /></div>
    <div class="err" id="err" style="color:#B23B3B">${esc(note)}</div>
    <button class="btn btn-brand" style="width:100%" id="vgo" onclick="submitVerify()">Verify &amp; activate</button>
    <button class="btn" style="width:100%;margin-top:8px;color:var(--brand);font-size:14px" onclick="resendCode()">Resend code</button>
    <button class="btn" style="width:100%;color:var(--sub);font-size:13px" onclick="A.pendingEmail=null;renderAuth()">Back to sign in</button>
  </div>`;
  const inp = $('#f-code'); inp.focus();
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitVerify(); });
}
async function submitVerify() {
  const btn = $('#vgo'); btn.disabled = true; btn.textContent = 'Verifying…';
  try {
    const res = await api('/api/owners/verify', { method: 'POST', body: { email: A.pendingEmail, code: $('#f-code').value.trim() } });
    A.token = res.token; localStorage.setItem('tt_owner', res.token);
    A.pendingEmail = null;
    await loadVenue();
    toast('Account activated — welcome!');
  } catch (e) { btn.disabled = false; btn.textContent = 'Verify & activate'; $('#err').textContent = e.message; }
}
async function resendCode() {
  try { await api('/api/owners/resend', { method: 'POST', body: { email: A.pendingEmail } });
    $('#err').style.color = 'var(--sub)'; $('#err').textContent = 'A fresh code is on its way — give it a minute.';
  } catch (e) { $('#err').textContent = e.message; }
}
function logout() { localStorage.removeItem('tt_owner'); A.token = null; renderAuth(); }

/* ------------------------------- dashboard -------------------------------- */
function renderDash() {
  const v = A.venue;
  const cats = [...new Set(A.menu.map((m) => m.cat))];
  const kitchenUrl = location.origin + '/kitchen?v=' + v.id;

  const menuRows = A.menu.length === 0
    ? `<div style="padding:22px;text-align:center;color:var(--sub);font-size:14px">No items yet — add your first dish below.</div>`
    : A.menu.map((m) => `
      <div class="mi-row ${m.available ? '' : 'off'}">
        <span class="diet ${m.diet}"><i></i></span>
        <span class="nm">${esc(m.name)} <span style="color:var(--sub);font-weight:500;font-size:12px">· ${esc(m.cat)}</span></span>
        <span class="pr">${money(m.price)}</span>
        <button class="mi-act" onclick="toggleItem('${m.id}', ${m.available ? 0 : 1})">${m.available ? 'Mark out' : 'Bring back'}</button>
        <button class="mi-act" onclick="editItem('${m.id}')">Edit</button>
        <button class="mi-act" style="color:#B23B3B" onclick="removeItem('${m.id}')">Delete</button>
      </div>`).join('');

  root().innerHTML = `
  <div class="topbar"><div class="row" style="max-width:680px;margin:0 auto">
    <div><div class="eyebrow">Owner dashboard</div><div class="ttl">${esc(v.name)}</div></div>
    <button class="pill" style="background:#fff;color:var(--brand);cursor:pointer" onclick="logout()">Sign out</button>
  </div></div>
  <div class="admin-wrap" style="padding-top:16px">

    <div class="card" style="padding:16px;margin-bottom:14px">
      <p class="section-label">Venue settings</p>
      <div class="field"><label>Venue name</label><input id="s-name" value="${esc(v.name)}" maxlength="60" /></div>
      <div class="field"><label>Payment style</label><select id="s-mode">
        <option value="cafe" ${v.mode === 'cafe' ? 'selected' : ''}>Cafe — diners pay in advance</option>
        <option value="restaurant" ${v.mode === 'restaurant' ? 'selected' : ''}>Restaurant — diners pay after the meal</option></select></div>
      <button class="btn btn-brand" style="padding:10px 16px;font-size:14px" onclick="saveVenue()">Save settings</button>
    </div>

    <div class="card" style="padding:16px;margin-bottom:14px">
      <p class="section-label">Kitchen access</p>
      <div class="row-sb">
        <div><div style="font-size:13px;color:var(--sub)">Staff sign in at the kitchen page with this PIN</div>
          <div class="pin-big">${esc(v.kitchenPin)}</div></div>
        <button class="mi-act" onclick="changePin()">Change PIN</button>
      </div>
      <div class="copybox" style="margin-top:10px">Kitchen page: ${esc(kitchenUrl)}</div>
    </div>

    <div class="card" style="padding:16px;margin-bottom:14px">
      <p class="section-label">Table QR codes</p>
      <div style="font-size:13px;color:var(--sub);margin-bottom:10px">Generate a QR for each table, print it, place it on the table.</div>
      <div style="display:flex;gap:8px">
        <input id="t-num" placeholder="Table number (e.g. 5)" maxlength="12" style="flex:1;border:1px solid var(--line);border-radius:12px;padding:11px 13px;font-size:15px" />
        <button class="btn btn-ink" style="padding:10px 16px;font-size:14px" onclick="makeQR()">Generate QR</button>
      </div>
    </div>

    <div class="card" style="margin-bottom:14px;overflow:hidden">
      <p class="section-label" style="padding:14px 14px 0">Your menu (${A.menu.length} items)</p>
      ${menuRows}
    </div>

    <div class="card" style="padding:16px" id="itemForm">
      <p class="section-label" id="if-title">${A.editing ? 'Edit item' : 'Add a menu item'}</p>
      <div class="field"><label>Item name</label><input id="i-name" maxlength="60" placeholder="e.g. Masala Dosa" /></div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
        <div class="field"><label>Price (₹)</label><input id="i-price" type="number" min="1" step="1" placeholder="120" /></div>
        <div class="field"><label>Category</label><input id="i-cat" maxlength="30" placeholder="Breakfast" list="cats" />
          <datalist id="cats">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></div>
        <div class="field"><label>Diet</label><select id="i-diet"><option value="veg">Veg</option><option value="nonveg">Non-veg</option></select></div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-brand" style="padding:10px 16px;font-size:14px" onclick="saveItem()">${A.editing ? 'Save changes' : 'Add item'}</button>
        ${A.editing ? `<button class="btn btn-ghost" style="padding:10px 16px;font-size:14px" onclick="cancelEdit()">Cancel</button>` : ''}
      </div>
    </div>
  </div>`;

  if (A.editing) {
    const m = A.menu.find((x) => x.id === A.editing);
    if (m) { $('#i-name').value = m.name; $('#i-price').value = m.price; $('#i-cat').value = m.cat; $('#i-diet').value = m.diet; }
    $('#itemForm').scrollIntoView({ behavior: 'smooth' });
  }
}

async function saveVenue() {
  try {
    const { venue } = await api('/api/owner/venue', { method: 'PATCH', token: A.token,
      body: { name: $('#s-name').value, mode: $('#s-mode').value } });
    A.venue = venue; toast('Settings saved'); renderDash();
  } catch (e) { toast(e.message); }
}
async function changePin() {
  const pin = prompt('New kitchen PIN (4–8 digits). Staff will use this to sign in:');
  if (pin === null) return;
  try {
    const { venue } = await api('/api/owner/venue', { method: 'PATCH', token: A.token, body: { kitchenPin: pin.trim() } });
    A.venue = venue; toast('Kitchen PIN updated'); renderDash();
  } catch (e) { toast(e.message); }
}

/* ---------------------------------- menu ---------------------------------- */
async function saveItem() {
  const body = {
    name: $('#i-name').value, price: parseInt($('#i-price').value, 10),
    cat: $('#i-cat').value || 'Menu', diet: $('#i-diet').value,
  };
  try {
    if (A.editing) {
      await api('/api/owner/menu/' + A.editing, { method: 'PATCH', token: A.token, body });
      A.editing = null; toast('Item updated');
    } else {
      await api('/api/owner/menu', { method: 'POST', token: A.token, body });
      toast('Item added');
    }
    await loadVenue();
  } catch (e) { toast(e.message); }
}
function editItem(id) { A.editing = id; renderDash(); }
function cancelEdit() { A.editing = null; renderDash(); }
async function toggleItem(id, available) {
  try { await api('/api/owner/menu/' + id, { method: 'PATCH', token: A.token, body: { available: !!available } }); await loadVenue(); }
  catch (e) { toast(e.message); }
}
async function removeItem(id) {
  const m = A.menu.find((x) => x.id === id);
  if (!confirm('Delete "' + (m ? m.name : 'this item') + '" from your menu?')) return;
  try { await api('/api/owner/menu/' + id, { method: 'DELETE', token: A.token }); await loadVenue(); toast('Item deleted'); }
  catch (e) { toast(e.message); }
}

/* --------------------------------- table QR -------------------------------- */
async function makeQR() {
  const t = $('#t-num').value.trim();
  if (!t) return toast('Enter a table number first');
  try {
    const { url, table } = await api('/api/owner/table-link/' + encodeURIComponent(t), { token: A.token });
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:80;padding:20px';
    ov.innerHTML = `<div style="background:#fff;border-radius:18px;padding:24px;max-width:340px;width:100%;text-align:center">
      <div style="font-weight:800;font-size:18px">${esc(A.venue.name)}</div>
      <div style="font-weight:700;margin-bottom:4px">Table ${esc(table)}</div>
      <div style="font-size:13px;color:var(--sub);margin-bottom:14px">Print this and place it on the table.</div>
      <div id="qrbox" style="display:flex;justify-content:center;padding:8px"></div>
      <div class="copybox" style="margin:12px 0">${esc(url)}</div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-ghost" style="flex:1;font-size:14px;padding:10px" onclick="window.print()">Print</button>
        <button class="btn btn-ink" style="flex:1;font-size:14px;padding:10px" onclick="this.closest('div').parentNode.parentNode.remove()">Close</button>
      </div></div>`;
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
    document.body.appendChild(ov);
    if (window.QRCode) new QRCode($('#qrbox', ov), { text: url, width: 200, height: 200, colorDark: '#17130F' });
    else $('#qrbox', ov).innerHTML = '<span style="color:var(--sub);font-size:13px">QR library offline — use the link above.</span>';
  } catch (e) { toast(e.message); }
}

boot();
