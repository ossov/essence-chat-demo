/**
 * Case-study summarizer. Reads every .docx in a folder, and for each one asks
 * the model to distill the person's PROBLEM into a 1-2 sentence prompt (and
 * nothing else — no essences, no treatment, no outcome). Writes the prompts to
 * a CSV you can then feed to the review harness.
 *
 *   set -a; source .env.local; set +a
 *   npm run summarize                         # reads ./case-studies
 *   npm run summarize -- --dir case-studies --out case-study-prompts.csv
 *
 * Flags: --dir <folder> (default case-studies), --out <csv> (default case-study-prompts.csv)
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const DIR = arg("--dir") || "case-studies";
const OUT = arg("--out") || "case-study-prompts.csv";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

const SYSTEM = `You are reading a flower-essence practitioner's case-study notes about ONE person. Your only job is to describe that person's presenting problem.

Write 1-2 sentences, in the first person, as if the person themselves were describing what they're struggling with or how they feel when reaching out for help.

STRICT rules:
- Output ONLY the problem description — no preamble, no quotation marks, no labels, no headings, no commentary.
- Describe ONLY the emotional/psychological/life problem. Do NOT mention any essences, remedies, products, dosages, treatments, practitioners, sessions, dates, or outcomes.
- Stay grounded in the notes; do not invent details.
- Keep it to one or two natural sentences.`;

const client = new Anthropic();

// Extract readable text from a .docx (a zip) without extra deps: unzip the
// main document part and strip the XML, turning paragraphs into line breaks.
function docxText(path: string): string {
  const xml = execFileSync("unzip", ["-p", path, "word/document.xml"], {
    maxBuffer: 64 * 1024 * 1024,
  }).toString("utf8");
  return xml
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function summarize(text: string): Promise<string> {
  const r = await client.messages.create({
    model: MODEL,
    max_tokens: 250,
    system: SYSTEM,
    messages: [{ role: "user", content: text }],
  });
  return r.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

const csvCell = (s: string) => '"' + (s || "").replace(/"/g, '""') + '"';

async function main() {
  const files = readdirSync(DIR).filter((f) => f.toLowerCase().endsWith(".docx")).sort();
  if (files.length === 0) throw new Error(`No .docx files found in ${DIR}`);
  console.log(`Summarizing ${files.length} case studies in ${DIR} (model: ${MODEL})...\n`);

  // Process all at once.
  const results = await Promise.all(
    files.map(async (file) => {
      try {
        const prompt = await summarize(docxText(join(DIR, file)));
        return { file, prompt };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/authentication_error|invalid x-api-key|\b401\b/.test(msg)) {
          console.error("\nAuth failed — set a real ANTHROPIC_API_KEY (source .env.local) and retry.");
          process.exit(1);
        }
        return { file, prompt: "ERROR: " + msg };
      }
    }),
  );

  for (const { file, prompt } of results) {
    console.log(`### ${file}\n${prompt}\n`);
  }

  const rows = [["case_file", "problem_prompt"], ...results.map((r) => [r.file, r.prompt])];
  // Lead with a UTF-8 BOM so Excel/Numbers render em dashes & quotes correctly.
  writeFileSync(OUT, "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n");
  console.log(`Wrote ${results.length} prompts to ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
