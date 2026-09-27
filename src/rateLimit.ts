/**
 * Lightweight in-process rate limiting.
 *
 * Two layers, because each guards a different failure mode:
 *   - per-client: stops one visitor (or one script) hammering the endpoint.
 *   - global:     a wallet guard. Even when we can't tell clients apart — every
 *                 App Proxy request reaches us from Shopify's infrastructure, not
 *                 the shopper's IP — this caps total spend per instance.
 *
 * Caveat worth knowing: Vercel runs several function instances, each with its own
 * memory, so an attacker spread across instances gets a higher effective ceiling.
 * This raises the bar rather than sealing it; the Anthropic spend cap is the only
 * absolute limit. Everything here fails OPEN — a bug in this file must never stop
 * a real customer from chatting.
 */

/** Fixed-window counter. Windows are cheap and predictable; precision isn't the point. */
class Window {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly limit: number, private readonly windowMs: number) {}

  /** Records a hit. Returns seconds to wait if over the limit, otherwise null. */
  check(key: string, now = Date.now()): number | null {
    let e = this.hits.get(key);
    if (!e || now >= e.resetAt) {
      e = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, e);
    }
    e.count++;
    if (this.hits.size > 5000) this.sweep(now); // bound memory on a hostile key space
    return e.count > this.limit ? Math.max(1, Math.ceil((e.resetAt - now) / 1000)) : null;
  }

  private sweep(now: number) {
    for (const [k, v] of this.hits) if (now >= v.resetAt) this.hits.delete(k);
  }
}

function envInt(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Defaults sized well above real use: a person sends a handful of messages a
// minute, and the whole store is unlikely to exceed ~120/min legitimately.
const perClientMinute = new Window(envInt("RATE_LIMIT_PER_MIN", 20), 60_000);
const perClientHour = new Window(envInt("RATE_LIMIT_PER_HOUR", 200), 3_600_000);
const globalMinute = new Window(envInt("RATE_LIMIT_GLOBAL_PER_MIN", 200), 60_000);

/** Best-effort client identity. Shopify-proxied requests often share one address. */
export function clientKey(headers: Record<string, unknown>): string {
  const fwd = headers["x-forwarded-for"];
  const first = typeof fwd === "string" ? fwd.split(",")[0].trim() : "";
  const real = typeof headers["x-real-ip"] === "string" ? (headers["x-real-ip"] as string) : "";
  return first || real || "unknown";
}

export interface RateLimitResult {
  limited: boolean;
  retryAfter?: number;
  reason?: string;
}

/**
 * @param signed true when the request carried a valid App Proxy signature. Those
 *   arrive from Shopify's IPs, so a per-client limit would bucket every shopper
 *   together and throttle the whole store — they get the global guard only.
 */
export function checkRateLimit(
  headers: Record<string, unknown>,
  signed: boolean,
): RateLimitResult {
  try {
    const g = globalMinute.check("__global__");
    if (g !== null) return { limited: true, retryAfter: g, reason: "global" };

    if (!signed) {
      const key = clientKey(headers);
      const m = perClientMinute.check(key);
      if (m !== null) return { limited: true, retryAfter: m, reason: "per-client/min" };
      const h = perClientHour.check(key);
      if (h !== null) return { limited: true, retryAfter: h, reason: "per-client/hour" };
    }
    return { limited: false };
  } catch {
    return { limited: false }; // fail open — never block a customer on our bug
  }
}

/** Test seam: fresh counters so suites don't leak state into each other. */
export function __resetForTests() {
  (perClientMinute as unknown as { hits: Map<string, unknown> }).hits = new Map();
  (perClientHour as unknown as { hits: Map<string, unknown> }).hits = new Map();
  (globalMinute as unknown as { hits: Map<string, unknown> }).hits = new Map();
}
