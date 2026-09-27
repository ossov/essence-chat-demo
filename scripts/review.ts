/**
 * Review harness. For each case study, sends the person's problem (main_symptom)
 * to the model and records the input and the FULL AI reply to a CSV so you can
 * judge accuracy yourself — no automatic scoring.
 *
 *   set -a; source .env.local; set +a        # loads ANTHROPIC_API_KEY + MODEL
 *   npm run review                            # first 15 cases
 *   npm run review -- --limit 30              # first 30
 *   npm run review -- --limit 0               # all cases
 *
 * Flags: --limit N (0 = all; default 15), --csv <path>, --out <path>
 * Output columns: #, problem, ai_reply, recommended_essence, actual_essences_used
 */
import { readFileSync, writeFileSync } from "node:fs";
import { completeReply } from "../src/claude.js";
import { loadCatalog } from "../src/catalog.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const CSV = arg("--csv") || process.env.CASE_STUDIES_CSV || "/Users/ethanossowski/Story_Database_V2/story_log.csv";
const LIMIT = arg("--limit") !== undefined ? parseInt(arg("--limit") as string, 10) : 15;
const OUT = arg("--out") || "review-results.csv";

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const catalog = loadCatalog();
const handleToTitle = new Map(
  catalog.products.map((p) => [p.handle, p.title.split("|")[0].trim()]),
);

const stripMarker = (t: string) => t.replace(/\[\[card:[^\]]*\]\]/g, "").trim();
function extractHandle(t: string): string | null {
  const m = t.match(/\[\[card:([^\]]+)\]\]/);
  return m ? m[1].trim() : null;
}
const csvCell = (s: string) => '"' + (s || "").replace(/"/g, '""') + '"';

async function main() {
  const rows = parseCsv(readFileSync(CSV, "utf8"));
  const header = rows[0];
  const symIdx = header.indexOf("main_symptom");
  const essIdx = header.indexOf("essences_used");
  if (symIdx < 0) throw new Error("CSV missing main_symptom column.");

  let data = rows.slice(1).filter((r) => r[symIdx]?.trim());
  if (LIMIT > 0) data = data.slice(0, LIMIT);

  const out: string[][] = [["#", "problem", "ai_reply", "recommended_essence", "actual_essences_used"]];
  for (let i = 0; i < data.length; i++) {
    const problem = data[i][symIdx].trim();
    const actual = (data[i][essIdx] || "").trim();
    let reply = "", recTitle = "";
    try {
      const { text } = await completeReply([{ role: "user", content: problem }]);
      reply = stripMarker(text);
      const h = extractHandle(text);
      if (h) recTitle = handleToTitle.get(h) || h;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/authentication_error|invalid x-api-key|\b401\b/.test(msg)) {
        console.error("\nAuth failed — set a real ANTHROPIC_API_KEY (source .env.local) and retry.");
        process.exit(1);
      }
      reply = "ERROR: " + msg;
    }
    out.push([String(i + 1), problem, reply, recTitle, actual]);
    process.stdout.write(`[${i + 1}/${data.length}] ${problem.slice(0, 50).padEnd(50)} -> ${recTitle || "(none)"}\n`);
  }

  // Lead with a UTF-8 BOM so Excel/Numbers render em dashes & quotes correctly.
  writeFileSync(OUT, "﻿" + out.map((r) => r.map(csvCell).join(",")).join("\n") + "\n");
  console.log(`\nWrote ${data.length} cases to ${OUT} — open it to review the replies.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
