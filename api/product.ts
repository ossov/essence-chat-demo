import type { IncomingMessage, ServerResponse } from "node:http";
import { loadCatalog } from "../src/catalog.js";

// Build a handle -> product lookup once at module load (catalog is stable).
const byHandle = new Map(loadCatalog().products.map((p) => [p.handle, p]));

function allowedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Returns public card data for one product by handle:
 *   GET /api/product?handle=abundance-essence
 * The widget calls this to populate a recommended-product card.
 */
export default function handler(
  req: IncomingMessage & { method?: string; url?: string },
  res: ServerResponse,
) {
  const origin = (req.headers.origin as string | undefined) ?? "";
  if (origin && allowedOrigins().includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "https://placeholder.local");
  const handle = url.searchParams.get("handle") ?? "";
  const p = byHandle.get(handle);

  res.setHeader("Content-Type", "application/json");
  if (!p) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  res.statusCode = 200;
  res.end(
    JSON.stringify({
      handle: p.handle,
      // Card shows the clean name (before the " | type" suffix).
      title: p.title.split("|")[0].trim(),
      resonance: p.resonance ?? null,
      image: p.image ?? null,
      url: p.url,
    }),
  );
}
