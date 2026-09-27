/**
 * Pulls the product catalogue from the Shopify Admin GraphQL API and writes it
 * to data/catalog.json (which the backend reads at request time).
 *
 *   SHOPIFY_STORE_DOMAIN=my-store.myshopify.com \
 *   SHOPIFY_ADMIN_TOKEN=shpat_... \
 *   npm run sync:catalog
 *
 * Metafields are NOT returned by the REST products endpoint, so we use GraphQL
 * and pull each `custom.*` metafield by key. Product tags come back as an array.
 * Adjust METAFIELD_MAP if your namespace/keys differ.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Catalog, Product } from "../src/catalog.js";

const domain = requireEnv("SHOPIFY_STORE_DOMAIN");
const apiVersion = process.env.SHOPIFY_API_VERSION ?? "2024-10";
let accessToken = ""; // resolved in main() — either a static token or a client-credentials exchange

// Product field <- custom.<key>. The GraphQL alias is the Product field name.
const METAFIELD_MAP: Record<keyof Product, string | null> = {
  handle: null,
  title: null,
  url: null,
  tags: null,
  image: null,
  essenceType: "essence_type",
  helpsWith: "short_description_v2",
  resonance: "resonance",
  essenceSummary: "essence_new",
  keyAttractors: "key_attractors",
  keyChallenges: "key_challenges",
  mental: "mental",
  emotional: "emotional",
  physical: "physical",
  spiritual: "spiritual",
  meridians: "meridians",
  chakras: "chakras",
  ingredients: "ingredients",
};

// Tags that carry no meaning for matching a customer's feeling — operational,
// logistics, blog/collection, and import markers. Dropped at sync time so only
// the descriptive emotional/energetic vocabulary reaches the model.
const DROP_TAG_PREFIXES = ["bl_", "no-", "nic-", "pst-"];
const DROP_TAGS = new Set(
  ["general-essences", "books", "kits"].map((t) => t.toLowerCase()),
);

// Individual bottles have a "|" in the title (e.g. "Abundance | Combination
// Essence"), with the essence type after the pipe. Kits, gift cards, cards,
// oils, and misc SKUs don't — exclude them so the assistant only recommends
// individual bottles.
//
// A few kits/sets/non-products do have a "|", so also drop these by name
// (matched against the part before the pipe, case-insensitive).
const DROP_PRODUCT_NAMES = new Set(
  [
    "3 Sprays Kit",
    "Five Elements Retreat",
    "Heart Kit",
    "Attractors",
    "Diffuser Oils Set",
    "New Perspectives",
  ].map((s) => s.toLowerCase()),
);

function isIndividualBottle(title: string): boolean {
  if (!title.includes("|")) return false;
  const name = title.split("|")[0].trim().toLowerCase();
  return !DROP_PRODUCT_NAMES.has(name);
}

function filterTags(tags: string[]): string[] {
  return tags.filter((tag) => {
    const t = tag.trim().toLowerCase();
    if (!t) return false;
    if (DROP_TAGS.has(t)) return false;
    if (DROP_TAG_PREFIXES.some((p) => t.startsWith(p))) return false;
    return true;
  });
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env var ${name}. See .env.example.`);
    process.exit(1);
  }
  return v;
}

/**
 * Resolves an Admin API access token. Two supported modes:
 *  - SHOPIFY_ADMIN_TOKEN: a static token (legacy admin-created custom apps).
 *  - SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET: a Dev Dashboard app — exchanged
 *    here for a short-lived (24h) token via the client_credentials grant. This
 *    is the current path, since the Dev Dashboard no longer surfaces a token.
 * The app must have the read_products Admin API scope and be installed on the store.
 */
async function resolveAccessToken(): Promise<string> {
  const direct = process.env.SHOPIFY_ADMIN_TOKEN;
  if (direct) return direct;

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (clientId && clientSecret) {
    const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!res.ok) {
      throw new Error(`Token exchange ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { access_token?: string };
    if (!data.access_token) {
      throw new Error(`Token exchange returned no access_token: ${JSON.stringify(data)}`);
    }
    return data.access_token;
  }

  console.error(
    "No credentials. Set either SHOPIFY_ADMIN_TOKEN, or SHOPIFY_CLIENT_ID + " +
      "SHOPIFY_CLIENT_SECRET (Dev Dashboard app). See .env.example.",
  );
  process.exit(1);
}

function metafieldSelections(): string {
  return Object.entries(METAFIELD_MAP)
    .filter(([, key]) => key)
    .map(([alias, key]) => `${alias}: metafield(namespace: "custom", key: "${key}") { value }`)
    .join("\n        ");
}

const QUERY = `
query Products($cursor: String) {
  products(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      handle
      title
      tags
      featuredImage { url }
      ${metafieldSelections()}
    }
  }
}`;

interface GqlNode {
  handle: string;
  title: string;
  tags: string[];
  featuredImage?: { url?: string } | null;
  [alias: string]: unknown; // metafield aliases -> { value: string } | null
}

async function graphql(cursor: string | null): Promise<{
  nodes: GqlNode[];
  hasNextPage: boolean;
  endCursor: string | null;
}> {
  const res = await fetch(`https://${domain}/admin/api/${apiVersion}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { cursor } }),
  });
  if (!res.ok) throw new Error(`Shopify GraphQL ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as {
    data?: { products: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: GqlNode[] } };
    errors?: unknown;
  };
  if (body.errors) throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
  const products = body.data!.products;
  return {
    nodes: products.nodes,
    hasNextPage: products.pageInfo.hasNextPage,
    endCursor: products.pageInfo.endCursor,
  };
}

// Shopify rich_text_field metafields return a JSON node tree, not plain text.
// Flatten it so the prompt gets readable text instead of raw JSON.
function flattenRichText(node: unknown, out: string[]): void {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const n of node) flattenRichText(n, out);
    return;
  }
  if (typeof node !== "object") return;
  const n = node as { type?: string; value?: string; children?: unknown };
  if (n.type === "text") {
    if (typeof n.value === "string") out.push(n.value);
    return;
  }
  if (n.type === "list-item") out.push("- ");
  if (n.children) flattenRichText(n.children, out);
  if (n.type === "paragraph" || n.type === "heading" || n.type === "list-item") out.push("\n");
}

function richTextToPlain(value: string): string {
  const t = value.trim();
  if (!t.startsWith("{")) return value; // plain text / comma list — leave as-is
  try {
    const parsed = JSON.parse(t);
    if (parsed && (parsed.type === "root" || parsed.children)) {
      const out: string[] = [];
      flattenRichText(parsed, out);
      return out.join("").replace(/\n{2,}/g, "\n").trim();
    }
  } catch {
    /* not JSON — fall through */
  }
  return value;
}

function mfValue(node: GqlNode, alias: string): string | undefined {
  const mf = node[alias] as { value?: string } | null | undefined;
  if (!mf?.value) return undefined;
  const v = richTextToPlain(mf.value).trim();
  return v ? v : undefined;
}

function toProduct(node: GqlNode): Product {
  const p: Product = {
    handle: node.handle,
    title: node.title,
    url: `/products/${node.handle}`,
    tags: filterTags(node.tags ?? []),
  };
  if (node.featuredImage?.url) p.image = node.featuredImage.url;
  for (const [field, key] of Object.entries(METAFIELD_MAP)) {
    if (!key) continue;
    const value = mfValue(node, field);
    if (value) (p as unknown as Record<string, unknown>)[field] = value;
  }
  return p;
}

async function main() {
  accessToken = await resolveAccessToken();
  console.log(`Fetching products from ${domain} (GraphQL ${apiVersion})...`);
  const all: GqlNode[] = [];
  let cursor: string | null = null;
  do {
    const page = await graphql(cursor);
    all.push(...page.nodes);
    cursor = page.hasNextPage ? page.endCursor : null;
  } while (cursor);

  const mapped = all.map(toProduct);
  const products = mapped.filter((p) => isIndividualBottle(p.title));
  const excluded = mapped.filter((p) => !isIndividualBottle(p.title));

  const catalog: Catalog = {
    storeName: domain.replace(/\.myshopify\.com$/, ""),
    products,
  };

  const here = dirname(fileURLToPath(import.meta.url));
  const out = join(here, "..", "data", "catalog.json");
  writeFileSync(out, JSON.stringify(catalog, null, 2) + "\n");
  console.log(`Wrote ${products.length} individual essences to ${out}`);
  if (excluded.length) {
    console.log(
      `Excluded ${excluded.length} non-bottle items (no "|" in title). Examples:\n` +
        excluded.slice(0, 10).map((p) => `   - ${p.title}`).join("\n"),
    );
  }

  // Quality warning: products with no matchable emotional content are dead weight.
  const thin = catalog.products.filter(
    (p) => !p.helpsWith && !p.keyChallenges && !p.emotional && p.tags.length === 0,
  );
  if (thin.length) {
    console.warn(
      `\n⚠  ${thin.length} product(s) have no "can help with", key challenges, ` +
        `emotional field, or tags — the assistant can't match feelings to them:\n` +
        thin.map((p) => `   - ${p.title}`).join("\n"),
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
