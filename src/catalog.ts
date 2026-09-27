import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "data");

/**
 * A product, modelled on the store's Shopify metafields (all under the `custom`
 * namespace) plus product tags. These are the ONLY fields the assistant is
 * allowed to reference. Optional fields are omitted from the prompt when empty.
 */
export interface Product {
  handle: string;
  title: string;
  /** Storefront-relative path, e.g. "/products/abundance". */
  url: string;
  /** Shopify product tags — the store's controlled vocabulary of states/themes. */
  tags: string[];
  /** Featured image URL — used by the product card, not shown to the model. */
  image?: string;

  /** custom.essence_type — Flower & Tree, Sea Essences, Sprays, Combinations, etc. */
  essenceType?: string;
  /** custom.short_description_v2 — "This Essence Can Help with". */
  helpsWith?: string;
  /** custom.resonance — the essence's core quality. */
  resonance?: string;
  /** custom.essence_new — fuller summary (deeper than resonance). */
  essenceSummary?: string;
  /** custom.key_attractors — what it provides / what the person is seeking. */
  keyAttractors?: string;
  /** custom.key_challenges — the problems a person has that this essence addresses. */
  keyChallenges?: string;
  /** custom.mental */
  mental?: string;
  /** custom.emotional */
  emotional?: string;
  /** custom.physical */
  physical?: string;
  /** custom.spiritual */
  spiritual?: string;
  /** custom.meridians — meridians it affects. */
  meridians?: string;
  /** custom.chakras — chakras it affects. */
  chakras?: string;
  /** custom.ingredients */
  ingredients?: string;
}

export interface Catalog {
  storeName: string;
  products: Product[];
}

/**
 * Loads the live catalog if present (data/catalog.json, written by sync:catalog),
 * otherwise falls back to the committed sample so the project runs out of the box.
 */
export function loadCatalog(): Catalog {
  // Prefer the live (synced) catalog over the committed sample. Check both the
  // module-relative path and the project-root path, since serverless bundlers
  // (Vercel) may place included files relative to the deployment root.
  const candidates = [
    join(dataDir, "catalog.json"),
    join(process.cwd(), "data", "catalog.json"),
    join(dataDir, "catalog.sample.json"),
    join(process.cwd(), "data", "catalog.sample.json"),
  ];
  const path = candidates.find((p) => existsSync(p));
  if (!path) {
    throw new Error("No catalog file found. Looked in:\n" + candidates.join("\n"));
  }
  const catalog = JSON.parse(readFileSync(path, "utf8")) as Catalog;
  if (!catalog.products?.length) {
    throw new Error(`Catalog at ${path} has no products.`);
  }
  return catalog;
}

/**
 * Keeps only the multi-essence "Combination" products, dropping every individual
 * flower/gem/sea/tree essence and all animal essences. The rule is `essenceType`
 * exactly "Combination" (trimmed) — the `| Combination Essence` title suffix is
 * the human-readable sanity check, not the filter key.
 */
export function combinationsOnly(catalog: Catalog): Catalog {
  return {
    ...catalog,
    products: catalog.products.filter((p) => (p.essenceType ?? "").trim() === "Combination"),
  };
}

/**
 * Loads the combinations-only catalog. Prefers the prebuilt
 * `data/catalog.combinations.json` (written by `build:combinations` at deploy
 * time); if it's missing, derives it on the fly from the full catalog so the
 * scoped view can never go stale or fail to load.
 */
export function loadCombinationCatalog(): Catalog {
  const candidates = [
    join(dataDir, "catalog.combinations.json"),
    join(process.cwd(), "data", "catalog.combinations.json"),
  ];
  const path = candidates.find((p) => existsSync(p));
  if (path) {
    const catalog = JSON.parse(readFileSync(path, "utf8")) as Catalog;
    if (catalog.products?.length) return catalog;
  }
  return combinationsOnly(loadCatalog());
}

/** One renderable field: which Product key it reads, plus a verbose and a compact label. */
type FieldSpec = { key: keyof Product; label: string; short: string };

// Order field labels for the model: matching signal first, context after.
const FIELD_SPECS: FieldSpec[] = [
  { key: "helpsWith", label: "can help with", short: "helps with" },
  { key: "keyChallenges", label: "key challenges (problems it addresses)", short: "challenges" },
  { key: "keyAttractors", label: "key attractors (what it provides / they seek)", short: "seeks" },
  { key: "emotional", label: "emotional", short: "emotional" },
  { key: "mental", label: "mental", short: "mental" },
  { key: "spiritual", label: "spiritual", short: "spiritual" },
  { key: "physical", label: "physical", short: "physical" },
  { key: "resonance", label: "resonance", short: "resonance" },
  { key: "essenceSummary", label: "summary", short: "summary" },
  { key: "essenceType", label: "essence type", short: "type" },
  { key: "meridians", label: "meridians", short: "meridians" },
  { key: "chakras", label: "chakras", short: "chakras" },
  { key: "ingredients", label: "ingredients", short: "ingredients" },
];

/**
 * Controls how much of each product is rendered into the prompt. The defaults
 * reproduce the original full rendering (V1); pass options to slim it down (V2)
 * to cut per-request tokens — the catalog is the bulk of every request.
 */
export interface RenderOptions {
  /** Product fields to omit entirely (e.g. TCM/energetic jargon for V2). */
  exclude?: Set<keyof Product>;
  /** Use terse field labels instead of the verbose descriptive ones. */
  compactLabels?: boolean;
  /** Omit the per-product `url` line — it's just `/products/<handle>`. */
  omitUrl?: boolean;
}

/** Renders the catalog into compact, model-readable text for the system prompt. */
export function renderCatalog(catalog: Catalog, opts: RenderOptions = {}): string {
  return catalog.products.map((p) => renderProduct(p, opts)).join("\n\n");
}

function renderProduct(p: Product, opts: RenderOptions = {}): string {
  const lines: string[] = [`## ${p.title}`, `- handle: ${p.handle}`];
  if (!opts.omitUrl) lines.push(`- url: ${p.url}`);
  for (const spec of FIELD_SPECS) {
    if (opts.exclude?.has(spec.key)) continue;
    const value = p[spec.key];
    if (typeof value === "string" && value.trim()) {
      const label = opts.compactLabels ? spec.short : spec.label;
      lines.push(`- ${label}: ${value.trim()}`);
    }
  }
  if (p.tags.length) lines.push(`- tags: ${p.tags.join(", ")}`);
  return lines.join("\n");
}
