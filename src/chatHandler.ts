import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { streamReply, type ChatTurn, type Version } from "./claude.js";
import { checkRateLimit, clientKey } from "./rateLimit.js";
import { noteRequest } from "./alert.js";

// Limits — keep requests cheap and abuse-resistant.
const MAX_MESSAGES = 60;
const MAX_CHARS_PER_MESSAGE = 2000;

/**
 * Verifies a Shopify App Proxy request signature.
 * Shopify appends a `signature` query param = HMAC-SHA256(sorted "key=value"
 * pairs concatenated, no separators) using the app's shared secret, hex-encoded.
 * See: shopify.dev/docs/apps/online-store/app-proxies#calculate-a-digital-signature
 */
export function verifyAppProxySignature(query: URLSearchParams, secret: string): boolean {
  const signature = query.get("signature");
  if (!signature) return false;

  const pairs: string[] = [];
  const keys = [...new Set([...query.keys()])].filter((k) => k !== "signature").sort();
  for (const key of keys) {
    const values = query.getAll(key);
    pairs.push(`${key}=${values.join(",")}`);
  }
  const message = pairs.join("");
  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");

  // Timing-safe compare; lengths must match first.
  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  // Vercel may have parsed it already.
  const anyReq = req as IncomingMessage & { body?: unknown };
  if (anyReq.body && typeof anyReq.body === "object") return anyReq.body;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sanitizeMessages(input: unknown): ChatTurn[] {
  if (!input || typeof input !== "object" || !Array.isArray((input as any).messages)) {
    throw new Error("Body must be { messages: [{ role, content }] }.");
  }
  const raw = (input as { messages: unknown[] }).messages;
  if (raw.length === 0 || raw.length > MAX_MESSAGES) {
    throw new Error(`messages must have 1..${MAX_MESSAGES} entries.`);
  }
  return raw.map((m) => {
    if (!m || typeof m !== "object") throw new Error("Each message must be an object.");
    const { role, content } = m as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") {
      throw new Error("role must be 'user' or 'assistant'.");
    }
    if (typeof content !== "string" || content.length === 0) {
      throw new Error("content must be a non-empty string.");
    }
    return { role, content: content.slice(0, MAX_CHARS_PER_MESSAGE) };
  });
}

function allowedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Shared chat endpoint. `version` selects the behavior variant (see src/claude.ts):
 * `v1` is the live setup; `v2` is the trimmed-catalog + Sonnet 5 cost experiment.
 * Everything else — auth, validation, SSE — is identical across versions.
 */
export async function handleChat(
  req: IncomingMessage & { method?: string; url?: string },
  res: ServerResponse,
  version: Version = "v1",
) {
  // CORS — only echo the Origin back if it's explicitly allow-listed.
  const origin = (req.headers.origin as string | undefined) ?? "";
  const originAllowed = !!origin && allowedOrigins().includes(origin);
  if (originAllowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end("Method Not Allowed");
    return;
  }

  // --- Authorize: a valid Shopify App Proxy signature OR an allow-listed origin ---
  // App Proxy is the production path. The origin allow-list is the lighter path
  // for testing (e.g. the widget calling the Vercel URL directly from a hidden
  // page) — set ALLOWED_ORIGINS to your storefront origin(s).
  // Set REQUIRE_APP_PROXY=true once the proxy is confirmed working: the origin
  // fallback then stops being accepted and the public Vercel URL is closed off.
  // Kept as an env flag so the cutover — and the rollback — is a setting change,
  // not a redeploy.
  const requireProxy = process.env.REQUIRE_APP_PROXY === "true";
  const secret = process.env.SHOPIFY_APP_SECRET;
  const url = new URL(req.url ?? "/", "https://placeholder.local");
  const signature = url.searchParams.get("signature");
  let signed = false;
  if (secret && signature) {
    signed = verifyAppProxySignature(url.searchParams, secret);
  }
  const authorized = signed || (originAllowed && !requireProxy);
  if (!authorized) {
    // Diagnostics for a rejected request. Logs which parameters arrived and how
    // far the check got — never the secret, the signature, or any value.
    console.warn(
      "auth failed:",
      JSON.stringify({
        secretConfigured: !!secret,
        signaturePresent: !!signature,
        signatureValid: signed,
        params: [...new Set(url.searchParams.keys())].sort(),
        originAllowed,
        requireProxy,
      }),
    );
    res.statusCode = 401;
    // AUTH_DEBUG surfaces the same non-secret diagnostics in the response body,
    // for when platform logs aren't reachable. Unset it once the proxy is working.
    if (process.env.AUTH_DEBUG === "true") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: "unauthorized",
          secretConfigured: !!secret,
          signaturePresent: !!signature,
          signatureValid: signed,
          params: [...new Set(url.searchParams.keys())].sort(),
          originAllowed,
          requireProxy,
        }),
      );
      return;
    }
    res.end(
      requireProxy
        ? "Unauthorized. This endpoint only accepts Shopify App Proxy requests."
        : "Unauthorized. Either call via the Shopify App Proxy (set SHOPIFY_APP_SECRET) " +
            "or add this storefront's origin to ALLOWED_ORIGINS.",
    );
    return;
  }

  // --- Throttle: a signed request is vouched for by Shopify but still costs
  // money, so the global guard applies to everything. ---
  const limit = checkRateLimit(req.headers as Record<string, unknown>, signed);
  // Volume watch — emails once when hourly traffic looks like a flood. Counts
  // throttled requests too, since those are the clearest abuse signal.
  noteRequest({
    limited: limit.limited,
    client: clientKey(req.headers as Record<string, unknown>),
    signed,
  });
  if (limit.limited) {
    console.warn(`rate limited (${limit.reason})`);
    res.statusCode = 429;
    res.setHeader("Retry-After", String(limit.retryAfter ?? 60));
    res.end("Too many requests. Please wait a moment and try again.");
    return;
  }

  let messages: ChatTurn[];
  try {
    messages = sanitizeMessages(await readJsonBody(req));
  } catch (err) {
    res.statusCode = 400;
    res.end(err instanceof Error ? err.message : "Bad request");
    return;
  }

  // --- Stream the reply as Server-Sent Events ---
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  try {
    for await (const delta of streamReply(messages, version)) {
      res.write(`data: ${JSON.stringify({ delta })}\n\n`);
    }
    res.write(`event: done\ndata: {}\n\n`);
  } catch (err) {
    console.error("stream error:", err);
    res.write(`event: error\ndata: ${JSON.stringify({ message: "Something went wrong." })}\n\n`);
  } finally {
    res.end();
  }
}
