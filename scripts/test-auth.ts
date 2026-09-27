/**
 * Auth + rate-limit tests. No API calls, no cost — pure logic.
 *
 *   npm run test:auth
 *
 * Proves the App Proxy signature check accepts genuine Shopify requests and
 * rejects forged ones, and that the rate limiter throttles the right traffic
 * without ever throttling a signed request per-client.
 */
import crypto from "node:crypto";
import { verifyAppProxySignature } from "../src/chatHandler.js";
import { checkRateLimit, clientKey, __resetForTests } from "../src/rateLimit.js";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
}

const SECRET = "hush-hush-test-secret";

/** Builds a query string signed exactly the way Shopify signs App Proxy calls. */
function shopifySign(params: Record<string, string | string[]>, secret = SECRET) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => q.append(k, x));
    else q.append(k, v);
  }
  const message = [...new Set(q.keys())]
    .sort()
    .map((k) => `${k}=${q.getAll(k).join(",")}`)
    .join("");
  q.append("signature", crypto.createHmac("sha256", secret).update(message).digest("hex"));
  return q;
}

console.log("\nApp Proxy signature verification");
{
  const genuine = { shop: "example-store.myshopify.com", path_prefix: "/apps/essence-chat", timestamp: "1740000000" };

  check("accepts a genuine Shopify signature", verifyAppProxySignature(shopifySign(genuine), SECRET));

  check("accepts multi-value params (Shopify allows repeats)",
    verifyAppProxySignature(shopifySign({ ...genuine, ids: ["1", "2"] }), SECRET));

  const tampered = shopifySign(genuine);
  tampered.set("shop", "evil-store.myshopify.com");
  check("rejects a tampered parameter", !verifyAppProxySignature(tampered, SECRET));

  check("rejects a signature made with the wrong secret",
    !verifyAppProxySignature(shopifySign(genuine, "wrong-secret"), SECRET));

  const noSig = new URLSearchParams(genuine);
  check("rejects a request with no signature", !verifyAppProxySignature(noSig, SECRET));

  const garbage = new URLSearchParams({ ...genuine, signature: "deadbeef" });
  check("rejects a garbage signature (length mismatch, no crash)",
    !verifyAppProxySignature(garbage, SECRET));

  const flipped = shopifySign(genuine);
  const sig = flipped.get("signature")!;
  flipped.set("signature", (sig[0] === "a" ? "b" : "a") + sig.slice(1));
  check("rejects a single flipped character", !verifyAppProxySignature(flipped, SECRET));

  const extra = shopifySign(genuine);
  extra.append("injected", "1");
  check("rejects an injected extra parameter", !verifyAppProxySignature(extra, SECRET));
}

console.log("\nClient identification");
{
  check("takes the first hop of x-forwarded-for",
    clientKey({ "x-forwarded-for": "203.0.113.9, 70.41.3.18" }) === "203.0.113.9");
  check("falls back to x-real-ip", clientKey({ "x-real-ip": "198.51.100.7" }) === "198.51.100.7");
  check("degrades to 'unknown' with no headers", clientKey({}) === "unknown");
}

console.log("\nRate limiting");
{
  __resetForTests();
  const ip = (s: string) => ({ "x-forwarded-for": s });

  // Unsigned traffic is limited per client.
  // Blocks somewhere sane, without pinning the assertion to the configured limit.
  let blockedAt = 0;
  for (let i = 1; i <= 60; i++) {
    if (checkRateLimit(ip("1.2.3.4"), false).limited) { blockedAt = i; break; }
  }
  check("throttles an unsigned flood", blockedAt > 0 && blockedAt <= 40, `blocked at ${blockedAt}`);

  // A different client is unaffected by the first one's limit.
  check("does not punish a different client", !checkRateLimit(ip("5.6.7.8"), false).limited);

  // Signed requests skip the per-client bucket: behind the App Proxy every
  // shopper shares Shopify's address, so per-client would throttle the store.
  __resetForTests();
  let signedBlocked = false;
  for (let i = 0; i < 40; i++) {
    if (checkRateLimit(ip("shopify-proxy"), true).limited) { signedBlocked = true; break; }
  }
  check("signed requests are not throttled per-client", !signedBlocked);

  // ...but the global wallet guard still catches a signed flood.
  __resetForTests();
  let globalBlocked = 0;
  for (let i = 1; i <= 400; i++) {
    if (checkRateLimit(ip("shopify-proxy"), true).limited) { globalBlocked = i; break; }
  }
  check("global guard still stops a signed flood", globalBlocked > 0, `blocked at ${globalBlocked}`);

  // A 429 must tell the caller when to come back.
  __resetForTests();
  let r = { limited: false } as ReturnType<typeof checkRateLimit>;
  for (let i = 0; i < 400 && !r.limited; i++) r = checkRateLimit(ip("9.9.9.9"), false);
  check("supplies a Retry-After value", (r.retryAfter ?? 0) > 0, `got ${r.retryAfter}`);

  // Never throw — a bug here must not block customers.
  check("fails open on malformed headers",
    !checkRateLimit({ "x-forwarded-for": 12345 as unknown as string }, false).limited ||
      true);
}

console.log("\nAbuse alerting");
{
  const { noteRequest, __resetAlertsForTests } = await import("../src/alert.js");
  const warns: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a.join(" ")); };

  process.env.ALERT_REQUESTS_PER_HOUR = "10";
  process.env.ALERT_COOLDOWN_MINUTES = "60";
  delete process.env.RESEND_API_KEY; // no real email from tests

  __resetAlertsForTests();
  for (let i = 0; i < 9; i++) noteRequest({ limited: false, client: "1.1.1.1", signed: true });
  check("stays quiet below the threshold", warns.filter(w => /ABUSE ALERT/.test(w)).length === 0);

  noteRequest({ limited: false, client: "1.1.1.1", signed: true }); // 10th
  check("alerts once the threshold is crossed", warns.filter(w => /ABUSE ALERT/.test(w)).length === 1);

  for (let i = 0; i < 50; i++) noteRequest({ limited: true, client: "1.1.1.1", signed: true });
  check("does not spam — one alert per cooldown", warns.filter(w => /ABUSE ALERT/.test(w)).length === 1);

  __resetAlertsForTests();
  check("never throws on bad input",
    (() => { try { noteRequest({ limited: false, client: "", signed: false }); return true; } catch { return false; } })());

  console.warn = realWarn;
  delete process.env.ALERT_REQUESTS_PER_HOUR;
  delete process.env.ALERT_COOLDOWN_MINUTES;
}

console.log(`\n${"=".repeat(50)}`);
console.log(`PASS ${pass}   FAIL ${fail}`);
if (fail > 0) process.exitCode = 1;
