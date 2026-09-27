import Anthropic from "@anthropic-ai/sdk";
import { loadCatalog, loadCombinationCatalog } from "./catalog.js";
import { buildSystemPrompt } from "./systemPrompt.js";

export const MAX_TOKENS = 1024;

/** A single conversation turn from the client. */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Which behavior variant to run.
 * - `v1`: the live setup — full catalog, model from ANTHROPIC_MODEL.
 * - `v2`: cost experiment — Sonnet 5 + the combinations-only catalog + a trimmed
 *   rendering (drops the TCM/energetic fields the terse one-line reply never
 *   surfaces, plus compact labels / no url).
 */
export type Version = "v1" | "v2";

interface VersionConfig {
  model: string;
  systemPrompt: string;
}

// Build the system prompts once at module load — they're stable across requests,
// which is exactly what lets the prompt cache hit.
const catalog = loadCatalog();

const CONFIGS: Record<Version, VersionConfig> = {
  v1: {
    model: process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8",
    systemPrompt: buildSystemPrompt(catalog),
  },
  v2: {
    model: process.env.ANTHROPIC_MODEL_V2 ?? "claude-sonnet-5",
    systemPrompt: buildSystemPrompt(loadCombinationCatalog(), {
      exclude: new Set(["meridians", "chakras", "resonance", "spiritual", "physical"]),
      compactLabels: true,
      omitUrl: true,
    }),
  },
};

/** The model id a given version will call. */
export function modelFor(version: Version = "v1"): string {
  return CONFIGS[version].model;
}

/** V1 model id — kept for callers/back-compat. */
export const MODEL = CONFIGS.v1.model;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");
    client = new Anthropic({ apiKey });
  }
  return client;
}

/**
 * The system parameter as a cacheable block. `cache_control` marks the catalog +
 * persona as a cache breakpoint so repeat requests read it at ~0.1x cost.
 */
function systemParam(version: Version): Anthropic.MessageCreateParams["system"] {
  return [
    {
      type: "text",
      text: CONFIGS[version].systemPrompt,
      cache_control: { type: "ephemeral" },
    },
  ];
}

/**
 * Streams a reply. Yields text deltas as they arrive; resolves the final message
 * (with usage) via the returned promise on the stream object if you need it.
 */
export async function* streamReply(
  messages: ChatTurn[],
  version: Version = "v1",
): AsyncGenerator<string, void, unknown> {
  const stream = getClient().messages.stream({
    model: CONFIGS[version].model,
    max_tokens: MAX_TOKENS,
    system: systemParam(version),
    messages,
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }
}

/** Non-streaming convenience wrapper — returns the full text plus usage. */
export async function completeReply(
  messages: ChatTurn[],
  version: Version = "v1",
): Promise<{ text: string; usage: Anthropic.Usage }> {
  const response = await getClient().messages.create({
    model: CONFIGS[version].model,
    max_tokens: MAX_TOKENS,
    system: systemParam(version),
    messages,
  });
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return { text, usage: response.usage };
}
