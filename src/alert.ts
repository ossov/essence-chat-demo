/**
 * Abuse alerting — emails you when chat traffic looks like someone draining
 * funds rather than shopping.
 *
 * Why volume and not just rate-limit hits: with the App Proxy enforced, every
 * request reaches us from Shopify's address, so the per-client limit is skipped
 * on purpose (it would otherwise bucket every shopper together). A steady
 * flood below the global cap would trip nothing at all, so the primary signal
 * here is requests-per-hour.
 *
 * Delivery is Resend (https://resend.com) — one API key, no SDK. Everything is
 * best-effort: an alerting failure must never affect a customer's chat.
 *
 * Env:
 *   RESEND_API_KEY            enables email; without it alerts only log
 *   ALERT_EMAIL_TO            where to send (required for email)
 *   ALERT_EMAIL_FROM          default "Essence Chat <onboarding@resend.dev>"
 *   ALERT_REQUESTS_PER_HOUR   volume that counts as abuse (default 100)
 *   ALERT_COOLDOWN_MINUTES    minimum gap between emails (default 60)
 *   ALERT_COST_PER_REQUEST    for the cost estimate (default 0.004 USD)
 */

function envNum(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

interface Bucket {
  count: number;
  limitedCount: number;
  windowStart: number;
}

const HOUR_MS = 3_600_000;
let bucket: Bucket = { count: 0, limitedCount: 0, windowStart: Date.now() };
let lastAlertAt = 0;

/** Rolling hourly counters. Resets whenever the window expires. */
function record(limited: boolean, now: number): Bucket {
  if (now - bucket.windowStart >= HOUR_MS) {
    bucket = { count: 0, limitedCount: 0, windowStart: now };
  }
  bucket.count++;
  if (limited) bucket.limitedCount++;
  return bucket;
}

async function sendEmail(subject: string, text: string): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.ALERT_EMAIL_TO;
  if (!key || !to) return; // not configured — the console.warn above still fired

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.ALERT_EMAIL_FROM ?? "Essence Chat <onboarding@resend.dev>",
      to: [to],
      subject,
      text,
    }),
  });
  if (!res.ok) {
    console.error("alert email failed:", res.status, (await res.text()).slice(0, 200));
  }
}

/**
 * Call once per authorized chat request. Fires an email when hourly volume
 * crosses the threshold, rate-limited to one message per cooldown period.
 * Never throws and never blocks the response.
 */
export function noteRequest(opts: { limited: boolean; client: string; signed: boolean }): void {
  try {
    const now = Date.now();
    const b = record(opts.limited, now);
    const threshold = envNum("ALERT_REQUESTS_PER_HOUR", 100);
    if (b.count < threshold) return;

    const cooldownMs = envNum("ALERT_COOLDOWN_MINUTES", 60) * 60_000;
    if (now - lastAlertAt < cooldownMs) return;
    lastAlertAt = now;

    const mins = Math.max(1, Math.round((now - b.windowStart) / 60_000));
    const perRequest = envNum("ALERT_COST_PER_REQUEST", 0.004);
    const summary = [
      `Essence Chat has handled ${b.count} messages in the last ${mins} minute(s).`,
      `That is above the alert threshold of ${threshold}/hour, so it may be someone`,
      `spamming the chat rather than normal shopping.`,
      ``,
      `  messages:          ${b.count}`,
      `  throttled (429):   ${b.limitedCount}`,
      `  window:            ${new Date(b.windowStart).toISOString()} -> ${new Date(now).toISOString()}`,
      `  est. cost so far:  ~$${(b.count * perRequest).toFixed(2)}`,
      `  arriving via:      ${opts.signed ? "Shopify App Proxy (signed)" : "direct (unsigned)"}`,
      `  last client:       ${opts.client}`,
      ``,
      `What you can do:`,
      `  - Anthropic usage:  https://platform.claude.com/usage`,
      `  - Lower the ceiling: set RATE_LIMIT_GLOBAL_PER_MIN in Vercel, then redeploy`,
      `  - Hard stop:        lower the spend limit at https://platform.claude.com/settings/billing`,
      ``,
      `No further email for ${envNum("ALERT_COOLDOWN_MINUTES", 60)} minutes.`,
    ].join("\n");

    console.warn(`ABUSE ALERT: ${b.count} messages in ${mins}m (threshold ${threshold}/hr)`);
    // Fire and forget: the customer's reply must not wait on an email.
    void sendEmail(`Essence Chat: unusual traffic (${b.count} messages/hour)`, summary).catch(
      (err) => console.error("alert email error:", err),
    );
  } catch (err) {
    console.error("alerting error (ignored):", err);
  }
}

/** Test seam. */
export function __resetAlertsForTests() {
  bucket = { count: 0, limitedCount: 0, windowStart: Date.now() };
  lastAlertAt = 0;
}
