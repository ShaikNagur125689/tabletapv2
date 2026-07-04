// Sends verification emails through Brevo (https://brevo.com).
// Needs two environment variables:
//   BREVO_API_KEY — from Brevo → SMTP & API → API Keys
//   BREVO_SENDER  — the email address you VERIFIED as a sender in Brevo
// If either is missing, we fall back to printing the code in the server logs
// so the flow stays testable end-to-end.
const KEY = process.env.BREVO_API_KEY || '';
const SENDER = process.env.BREVO_SENDER || '';

export async function sendVerifyCode(to, code, venueName) {
  return sendCode(to, code, {
    subject: `${code} is your TableTap verification code`,
    line: `Enter it on the sign-up screen to activate your account${venueName ? ' for ' + venueName : ''}.`,
    ignore: `If you didn't create a TableTap account, you can ignore this email.`,
  });
}

export async function sendResetCode(to, code) {
  return sendCode(to, code, {
    subject: `${code} is your TableTap password reset code`,
    line: `Enter it on the "Forgot password" screen to set a new password.`,
    ignore: `If you didn't request a password reset, you can ignore this email — your password stays unchanged.`,
  });
}

async function sendCode(to, code, t) {
  if (!KEY || !SENDER) {
    console.log(`[verify] Code for ${to}: ${code}  (set BREVO_API_KEY and BREVO_SENDER in Render to send real emails)`);
    return { ok: true, dev: true };
  }
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: 'TableTap', email: SENDER },
        to: [{ email: to }],
        subject: t.subject,
        textContent:
`Your TableTap code is: ${code}

It expires in 15 minutes. ${t.line}

${t.ignore}`,
        htmlContent:
`<div style="font-family:Arial,sans-serif;max-width:440px;margin:0 auto;padding:24px">
  <h2 style="margin:0 0 6px">TableTap</h2>
  <p>Your code is:</p>
  <p style="font-size:34px;font-weight:800;letter-spacing:6px;margin:10px 0">${code}</p>
  <p style="color:#555">It expires in 15 minutes. ${t.line}</p>
  <p style="color:#999;font-size:12px">${t.ignore}</p>
</div>`,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('[email] Brevo rejected the send:', res.status, detail.slice(0, 300));
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    console.error('[email] send failed:', e.message);
    return { ok: false };
  }
}
