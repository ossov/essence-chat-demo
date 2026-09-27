import type { IncomingMessage, ServerResponse } from "node:http";
import { loadCatalog, loadCombinationCatalog } from "../src/catalog.js";
import { modelFor } from "../src/claude.js";

/**
 * Diagnostic endpoint. Reports which catalogue is loaded (store name + product
 * count) so you can confirm a deploy is serving the real catalogue, not the
 * sample. Exposes no secrets. GET https://<app>.vercel.app/api/health
 */
export default function handler(_req: IncomingMessage, res: ServerResponse) {
  res.setHeader("Content-Type", "application/json");
  try {
    const c = loadCatalog();
    res.statusCode = 200;
    res.end(
      JSON.stringify(
        {
          ok: true,
          storeName: c.storeName,
          products: c.products.length,
          combinationProducts: loadCombinationCatalog().products.length,
          firstTitles: c.products.slice(0, 3).map((p) => p.title),
          model: modelFor("v1"),
          modelV2: modelFor("v2"),
          hasApiKey: !!process.env.ANTHROPIC_API_KEY,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  }
}
