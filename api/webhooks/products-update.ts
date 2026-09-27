import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

// We need the RAW request bytes to verify the HMAC — disable any body parsing.
export const config = { api: { bodyParser: false } };

/**
 * Shopify `products/update` webhook.
 *
 * Verifies the webhook HMAC (base64 HMAC-SHA256 of the raw body, keyed by the
 * webhook signing secret), then triggers a Vercel deploy hook. The redeploy
 * re-runs `npm run sync:catalog` at build time, refreshing data/catalog.json.
 *
 * Env:
 *   SHOPIFY_WEBHOOK_SECRET  signing secret from Settings → Notifications → Webhooks
 *   VERCEL_DEPLOY_HOOK_URL  a Vercel deploy hook (Project → Settings → Git → Deploy Hooks)
 */
async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function verifyWebhook(rawBody: Buffer, headerHmac: string, secret: string): boolean {
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(headerHmac, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async function handler(
  req: IncomingMessage & { method?: string; headers: Record<string, string | string[] | undefined> },
  res: ServerResponse,
) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end("Method Not Allowed");
    return;
  }

  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    res.statusCode = 500;
    res.end("Server not configured: SHOPIFY_WEBHOOK_SECRET missing");
    return;
  }

  const headerHmac = (req.headers["x-shopify-hmac-sha256"] as string) ?? "";
  const rawBody = await readRawBody(req);

  if (!headerHmac || !verifyWebhook(rawBody, headerHmac, secret)) {
    res.statusCode = 401;
    res.end("Invalid webhook signature");
    return;
  }

  // Acknowledge fast (Shopify expects a 2xx within ~5s), then fire the redeploy.
  const deployHook = process.env.VERCEL_DEPLOY_HOOK_URL;
  if (deployHook) {
    try {
      await fetch(deployHook, { method: "POST" });
    } catch (err) {
      console.error("deploy hook failed:", err);
      // Still 200 so Shopify doesn't retry-storm; the next product edit retries.
    }
  } else {
    console.warn("VERCEL_DEPLOY_HOOK_URL not set — webhook verified but no refresh triggered.");
  }

  res.statusCode = 200;
  res.end("ok");
}
