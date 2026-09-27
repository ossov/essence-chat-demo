/**
 * Derives the combinations-only catalog from the full catalog and writes it to
 * data/catalog.combinations.json. Run after sync:catalog (see vercel.json
 * buildCommand) so the scoped file always mirrors the live Shopify catalogue.
 *
 *   npm run build:combinations
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCatalog, combinationsOnly } from "../src/catalog.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "data", "catalog.combinations.json");

const combinations = combinationsOnly(loadCatalog());
writeFileSync(out, JSON.stringify(combinations, null, 2) + "\n");

console.log(
  `Wrote ${combinations.products.length} combination products to ${out}`,
);
for (const p of combinations.products) console.log("  -", p.title);
