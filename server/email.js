// Outbound email via the Resend API. No SDK — it's one HTTPS POST.
// Without RESEND_API_KEY (local dev), sends are skipped and the caller
// falls back to logging.

const API_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.EMAIL_FROM || 'Plant Care <noreply@auth.offhourslab.com>';

export async function sendEmail(to, subject, text) {
  if (!API_KEY) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM, to: [to], subject, text }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[email] resend ${res.status} sending to ${to}: ${body.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[email] send failed to ${to}: ${err.message}`);
    return false;
  }
}

export function sendLoginCode(to, code) {
  return sendEmail(
    to,
    `${code} is your Plant Care sign-in code`,
    `Your Plant Care sign-in code is:\n\n    ${code}\n\nIt expires in 15 minutes. If you didn't request this, ignore this email.`
  );
}
