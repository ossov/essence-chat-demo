/**
 * Evaluation harness. Feeds each case study's `main_symptom` to the model and
 * checks whether the essence it recommends is among the essences that actually
 * helped in that case (`essences_used`) — a labeled accuracy signal you can use
 * to tune the system prompt.
 *
 *   ANTHROPIC_API_KEY=... ANTHROPIC_MODEL=claude-sonnet-4-6 \
 *     npm run eval -- --limit 15        # quick sample
 *   ANTHROPIC_API_KEY=... ANTHROPIC_MODEL=claude-sonnet-4-6 \
 *     npm run eval                      # full run (~174 cases)
 *
 * Flags: --limit N (subset), --csv <path>, --out <path>
 * Writes a per-case CSV report and prints overall accuracy.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { completeReply, modelFor, type Version } from "../src/claude.js";
import { loadCatalog } from "../src/catalog.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const CSV = arg("--csv") || process.env.CASE_STUDIES_CSV || "/Users/ethanossowski/Story_Database_V2/story_log.csv";
const LIMIT = parseInt(arg("--limit") || "0", 10);
const VERSION = (arg("--version") || "v1") as Version;
const OUT = arg("--out") || `eval-results-${VERSION}.csv`;

// Minimal CSV parser: handles quoted fields, embedded commas, escaped quotes.
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

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const catalog = loadCatalog();
const handleToTitle = new Map(
  catalog.products.map((p) => [p.handle, p.title.split("|")[0].trim()]),
);

function extractHandle(text: string): string | null {
  const m = text.match(/\[\[card:([^\]]+)\]\]/);
  return m ? m[1].trim() : null;
}

// Lenient match: recommended name equals, or is contained in / contains, any
// of the essences that actually helped (≥4 chars to avoid trivial overlaps).
function isHit(recName: string, expected: string[]): boolean {
  const r = norm(recName);
  if (!r) return false;
  return expected.some((e) => {
    const en = norm(e);
    return en.length >= 4 && (en === r || en.includes(r) || r.includes(en));
  });
}

function csvCell(s: string): string {
  return '"' + (s || "").replace(/"/g, '""') + '"';
}

async function main() {
  const rows = parseCsv(readFileSync(CSV, "utf8"));
  const header = rows[0];
  const symIdx = header.indexOf("main_symptom");
  const essIdx = header.indexOf("essences_used");
  if (symIdx < 0 || essIdx < 0) throw new Error("CSV missing main_symptom/essences_used columns.");

  let data = rows.slice(1).filter((r) => r[symIdx]?.trim());
  if (LIMIT > 0) data = data.slice(0, LIMIT);

  console.log(`Version: ${VERSION}  |  model: ${modelFor(VERSION)}  |  cases: ${data.length}\n`);

  const out: string[][] = [["problem", "recommended_handle", "recommended_title", "expected", "hit"]];
  let hits = 0, noRec = 0;

  for (let i = 0; i < data.length; i++) {
    const problem = data[i][symIdx].trim();
    const expected = (data[i][essIdx] || "").split(",").map((s) => s.trim()).filter(Boolean);
    let recHandle = "", recTitle = "", hit = false;
    try {
      const { text } = await completeReply([{ role: "user", content: problem }], VERSION);
      const h = extractHandle(text);
      if (h) {
        recHandle = h;
        recTitle = handleToTitle.get(h) || h;
        hit = isHit(recTitle, expected);
      } else {
        noRec++;
        recTitle = "(no recommendation)";
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/authentication_error|invalid x-api-key|\b401\b/.test(msg)) {
        console.error(
          "\nAuth failed — ANTHROPIC_API_KEY is missing or invalid (not the sk-ant-... placeholder). " +
            "Set a real key and retry.",
        );
        process.exit(1);
      }
      recTitle = "ERROR: " + msg;
    }
    if (hit) hits++;
    out.push([problem, recHandle, recTitle, expected.join("; "), hit ? "yes" : "no"]);
    process.stdout.write(
      `[${i + 1}/${data.length}] ${hit ? "HIT " : "miss"} | ${problem.slice(0, 48).padEnd(48)} -> ${recTitle}\n`,
    );
  }

  // Lead with a UTF-8 BOM so Excel/Numbers render em dashes & quotes correctly.
  writeFileSync(OUT, "﻿" + out.map((r) => r.map(csvCell).join(",")).join("\n") + "\n");
  console.log(
    `\nAccuracy: ${hits}/${data.length} = ${Math.round((100 * hits) / data.length)}%` +
      `  (cases with no recommendation: ${noRec})`,
  );
  console.log(`Full report: ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
