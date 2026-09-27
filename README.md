# Essence Chat

> **Portfolio version.** This is a sanitized copy of a system running on a commercial store.
> The client's brand voice, catalogue and operational thresholds have been replaced with generic
> equivalents, and it ships with a small fictional sample catalogue so it runs out of the box.
> The engineering is unchanged.

An AI shopping assistant for a flower-essence Shopify store. Customers describe how they
*feel* - "I'm overwhelmed and can't sleep" - and the assistant, speaking in the first person
as the maker of the essences, recommends the single best-matching product and renders it as a
card on the storefront.

**No vector database.** The catalogue is small enough to fit in the model's context window, so
the whole thing goes into the system prompt and Claude does the feeling→product matching
natively. At this catalogue size that's simpler, cheaper and more accurate than retrieval.

## Architecture

```
Storefront page
  └─ chat widget (widget/essence-chat.js)
       └─ POST /apps/essence-chat/chat-v2      ← Shopify App Proxy (HMAC-signed)
            └─ Vercel serverless (api/chat-v2.ts → src/chatHandler.ts)
                 ├─ auth: App Proxy signature (enforced) 
                 ├─ rate limiting + abuse alerting
                 └─ Claude Messages API (streaming + prompt caching)
```

The backend holds the API key; it never reaches the client. Replies stream back as SSE.

### Two versions, side by side

`src/claude.ts` defines a `Version` type so two configurations run simultaneously behind
separate endpoints. This made it possible to change the model and catalogue scope against live
traffic without touching the working setup.

| | Endpoint | Model | Catalogue |
|---|---|---|---|
| **V1** | `/api/chat` | `ANTHROPIC_MODEL` | Full (213 products) |
| **V2** | `/api/chat-v2` | `claude-sonnet-5` | Combination essences only (27), trimmed rendering |

Switching between them is a theme-setting change - no redeploy.

## Layout

| Path | What it is |
|---|---|
| `src/catalog.ts` | Catalogue types, loader, renderer, combinations filter |
| `src/systemPrompt.ts` | Persona, response rules, Q&A rules, crisis handling, catalogue injection |
| `src/claude.ts` | Anthropic client; per-version model + prompt, streaming, prompt caching |
| `src/chatHandler.ts` | Shared request handler: auth, input caps, rate limiting, SSE |
| `src/rateLimit.ts` | Per-client and global rate limiting (fails open) |
| `src/alert.ts` | Emails when traffic looks like a flood |
| `api/chat.ts` / `api/chat-v2.ts` | Thin endpoints selecting V1 / V2 |
| `api/product.ts` | Product lookup by handle, for the card |
| `api/health.ts` | Diagnostics: catalogue loaded, product counts, models |
| `api/webhooks/products-update.ts` | Shopify webhook → Vercel deploy hook (catalogue refresh) |
| `widget/essence-chat.js` | Storefront widget (vanilla JS) |
| `shopify/sections/essence-chat.liquid` | Theme section with editor settings |
| `scripts/` | Catalogue sync, evaluation, adversarial + auth test suites |

## Setup

```bash
npm install
cp .env.example .env.local
```

Then fill in `ANTHROPIC_API_KEY`. See `.env.example` for the full list - Shopify credentials,
App Proxy secret, rate-limit thresholds and alert settings are all documented there.

## Catalogue sync

```bash
npm run sync:catalog          # Shopify → data/catalog.json
npm run build:combinations    # → data/catalog.combinations.json (V2)
```

Both run at build time on Vercel, so the catalogue tracks the store.

The assistant references **only** product tags plus the `custom.*` metafields:
`short_description_v2` ("can help with"), `key_challenges`, `key_attractors`, `mental`,
`emotional`, `physical`, `spiritual`, `resonance`, `essence_new`, `essence_type`, `meridians`,
`chakras`, `ingredients`. Matching quality lives mostly in `key_challenges`, "can help with",
`emotional`/`mental` and `tags` - keep those rich.

Sync uses the **GraphQL** Admin API (REST doesn't return metafields inline) and flattens
rich-text metafields to plain text. Non-descriptive tags (`bl_`, `no-`, `nic-`, `pst-` prefixes
plus `Books`/`Kits`/`general-essences`) are stripped via `DROP_TAG_PREFIXES` / `DROP_TAGS`.

> **Shopify 2026 note:** legacy custom apps can no longer be created, and Dev Dashboard apps
> don't expose a static Admin token. The sync exchanges **Client ID + Secret** for a short-lived
> admin token via the `client_credentials` grant. A static `shpat_` token still works if you
> have one.

## Safety

Suicide and self-harm disclosures are detected by the model rather than by keyword matching -
keywords can't read tense, negation or subject, so "I *used to* feel that way" and "my friend
is suicidal" are handled differently from a present-tense disclosure. On a genuine disclosure
the assistant drops the product pitch entirely, suppresses the card, and points to
[findahelpline.com](https://findahelpline.com) (country-agnostic) plus local emergency services
where severe. Ordinary heavy feelings - grief, despair, exhaustion - are met with an essence as
normal.

The assistant also never claims an essence treats or cures an illness, and a medical disclaimer
sits under the conversation.

## Security

The endpoint is only reachable through Shopify's App Proxy: requests carry an HMAC-SHA256
signature computed with the app's shared secret, and unsigned requests are rejected
(`REQUIRE_APP_PROXY=true`). Before this, an `Origin` header was the only gate - and an `Origin`
header is self-reported, so the endpoint could be driven directly from a script.

Behind that sit two-layer rate limiting (per-client for unsigned traffic, a global cap that
bounds spend) and an email alert when message volume crosses a threshold. Both fail open: a bug
in either must never stop a customer chatting.

## Testing

```bash
npm run test:auth        # 17 tests - signature forgery, rate limiting. No API calls, free.
npm run adversarial      # 30 tests - jailbreaks, medical claims, hallucination, junk input
npm run eval -- --version v2    # accuracy against real case studies
npm run typecheck
```

`adversarial` exits non-zero on failure, so it can gate a deploy. Every reply is also checked
against invariants: no card handle outside the catalogue, no invented prices, no leaked prompt,
no affirmative cure claims.

`eval` scores the model's pick against the essence that actually helped in each recorded case.
The case-study data is client material and is **not** in this repo.

## Cost

The catalogue dominates every request, so prompt size is the main lever. Prompt caching cuts
repeat reads to ~0.1×, but a low-traffic store pays the cache *write* on most first messages -
which makes payload size, not cache strategy, the thing that matters.

Trimming the rendering (dropping fields the terse reply never surfaces, compact labels) and
scoping V2 to combination essences took the prompt from ~70K tokens to ~12.8K, cutting the
cold-message cost by roughly 88%.
