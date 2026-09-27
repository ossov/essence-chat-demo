import type { IncomingMessage, ServerResponse } from "node:http";
import { handleChat } from "../src/chatHandler.js";

// V1 — the live setup (full catalog, model from ANTHROPIC_MODEL).
export default function handler(
  req: IncomingMessage & { method?: string; url?: string },
  res: ServerResponse,
) {
  return handleChat(req, res, "v1");
}
