import type { IncomingMessage, ServerResponse } from "node:http";
import { handleChat } from "../src/chatHandler.js";

// V2 — cost experiment (trimmed catalog, model from ANTHROPIC_MODEL_V2, default
// claude-sonnet-5). Runs alongside V1 so both can be compared live.
export default function handler(
  req: IncomingMessage & { method?: string; url?: string },
  res: ServerResponse,
) {
  return handleChat(req, res, "v2");
}
