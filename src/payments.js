// Payment providers for TableTap. Three lanes per venue (venue.pay_mode):
//   'simulated'  – instant fake success. Demo/dev only.
//   'upi_direct' – diner pays the venue's own UPI ID via any UPI app. ₹0 fees.
//                  No server-side proof exists for plain VPAs, so staff verify
//                  (soundbox + one tap) — the diner's claim NEVER marks paid.
//   'phonepe'    – PhonePe PG v2 (Standard Checkout). Auto-verified: webhook
//                  and/or Check-Status API confirm server-to-server, then we
//                  mark paid. Venue brings its own PhonePe merchant account.
// SECURITY RULE for every lane: "paid" flips ONLY on server-verified evidence
// (simulated stub, staff tap, or gateway server response) — never client say-so.
import crypto from 'node:crypto';

/* ------------------------------ UPI Direct ------------------------------ */
// Build the deep link that opens any UPI app with amount + token prefilled.
export function upiDirectLink(venue, order) {
  const p = new URLSearchParams({
    pa: venue.upi_vpa,                       // the CAFE's own UPI ID
    pn: (venue.name || 'TableTap').slice(0, 40),
    am: String(order.total),                 // rupees
    cu: 'INR',
    tn: `TableTap order #${order.token}`,    // shows in the cafe's app/soundbox
  });
  return 'upi://pay?' + p.toString();
}

/* ------------------------------ PhonePe PG ------------------------------ */
// PhonePe Standard Checkout v2 (OAuth). Docs: developer.phonepe.com
// Flow: oauth token -> create payment (returns redirectUrl) -> diner pays on
// PayPage -> webhook + Check Status confirm -> we mark paid.
const PP_BASES = {
  sandbox: {
    auth: 'https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token',
    api: 'https://api-preprod.phonepe.com/apis/pg-sandbox',
  },
  prod: {
    auth: 'https://api.phonepe.com/apis/identity-manager/v1/oauth/token',
    api: 'https://api.phonepe.com/apis/pg',
  },
};

export function phonepeConfigured(venue) {
  return !!(venue.pp_client_id && venue.pp_client_secret && venue.pp_env);
}

// Token cache per venue (tokens are short-lived; refresh 60s early).
const tokenCache = new Map();
async function ppToken(venue) {
  const cached = tokenCache.get(venue.id);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const base = PP_BASES[venue.pp_env] || PP_BASES.sandbox;
  const body = new URLSearchParams({
    client_id: venue.pp_client_id,
    client_version: venue.pp_client_version || '1',
    client_secret: venue.pp_client_secret,
    grant_type: 'client_credentials',
  });
  const res = await fetch(base.auth, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error('PhonePe auth failed (' + res.status + ') — check the venue\'s PhonePe credentials.');
  const j = await res.json();
  const token = j.access_token;
  const expiresAt = (j.expires_at ? Number(j.expires_at) * 1000 : Date.now() + 14 * 60_000);
  tokenCache.set(venue.id, { token, expiresAt });
  return token;
}

// Create a checkout session. Returns { redirectUrl, merchantOrderId }.
export async function ppCreatePayment(venue, order, returnUrl) {
  const base = PP_BASES[venue.pp_env] || PP_BASES.sandbox;
  const token = await ppToken(venue);
  const merchantOrderId = `TT-${venue.id}-${order.token}-${Date.now()}`.slice(0, 63);
  const res = await fetch(base.api + '/checkout/v2/pay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'O-Bearer ' + token },
    body: JSON.stringify({
      merchantOrderId,
      amount: order.total * 100, // paise
      expireAfter: 1200,
      metaInfo: { udf1: String(order.token), udf2: venue.id },
      paymentFlow: {
        type: 'PG_CHECKOUT',
        message: `TableTap order #${order.token}`,
        merchantUrls: { redirectUrl: returnUrl },
      },
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.redirectUrl) {
    throw new Error('PhonePe create-payment failed (' + res.status + '): ' + JSON.stringify(j).slice(0, 200));
  }
  return { redirectUrl: j.redirectUrl, merchantOrderId };
}

// Authoritative status: ask PhonePe's server directly.
// Returns 'COMPLETED' | 'FAILED' | 'PENDING'.
export async function ppCheckStatus(venue, merchantOrderId) {
  const base = PP_BASES[venue.pp_env] || PP_BASES.sandbox;
  const token = await ppToken(venue);
  const res = await fetch(base.api + '/checkout/v2/order/' + encodeURIComponent(merchantOrderId) + '/status', {
    headers: { authorization: 'O-Bearer ' + token },
  });
  if (!res.ok) throw new Error('PhonePe status check failed (' + res.status + ')');
  const j = await res.json();
  const state = String(j.state || j.status || '').toUpperCase();
  if (state === 'COMPLETED') return 'COMPLETED';
  if (state === 'FAILED') return 'FAILED';
  return 'PENDING';
}

// Webhook auth: PhonePe sends Authorization: SHA256(username:password) where
// username/password are what the merchant configured in the PhonePe dashboard.
export function ppVerifyWebhookAuth(venue, authHeader) {
  if (!venue.pp_webhook_user || !venue.pp_webhook_pass) return false;
  const expected = crypto.createHash('sha256')
    .update(venue.pp_webhook_user + ':' + venue.pp_webhook_pass).digest('hex');
  const got = String(authHeader || '').replace(/^SHA256\s*/i, '').trim().toLowerCase();
  try {
    return got.length === expected.length
      && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  } catch (_) { return false; }
}
