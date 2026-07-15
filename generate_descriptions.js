/**
 * Writes a one-line, user-facing description for every page in PAGES.
 *
 * Run:  node generate_descriptions.js        # -> eval/descriptions.json, for REVIEW
 *
 * These are NOT like eval queries. Eval queries are internal test data -- if one is
 * wrong, a number moves. Descriptions SHIP: they render under the title in the palette
 * and a CEO reads them off a projector. So this script writes a review file and stops.
 * It does not touch build_snapshots.py. You read the 41 lines, fix the ones that are
 * wrong, and only then paste them into PAGES as desc="...".
 *
 * Nothing generated here reaches a vector: `desc` is display-only (see emit_pages_json).
 * That is what makes this safe to run against a tuned index -- recall cannot move.
 *
 * Provider config (LLM_API_KEY / LLM_BASE_URL / LLM_MODEL) is shared with
 * generate_eval.js -- same .env, same free-tier lessons. See that file's header.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* shell env still works */ }

const PAGES = path.join(ROOT, 'assets', 'data', 'pages.json');
const OUT = path.join(ROOT, 'eval', 'descriptions.json');

const BASE_URL = process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1';
const LLM_MODEL = process.env.LLM_MODEL || 'openai/gpt-oss-120b';
const BATCH = Number(process.env.LLM_BATCH || 8);
const DELAY_MS = Number(process.env.LLM_DELAY_MS || 20000);

// max_completion_tokens is a RESERVATION checked against the per-minute budget BEFORE
// the request runs -- see generate_eval.js maxOut() for the 413 that taught us this.
const maxOut = () => Math.min(8192, BATCH * 60 + 2048);

const SYSTEM = `You write short descriptions for pages in OpsFlo, an operations/logistics \
ERP used by dispatchers, field technicians, payroll clerks, and warehouse staff.

You get a batch of pages (id, title, section, and the page's real column headers). Write \
ONE description per page.

Rules:
- 6 to 12 words. It renders on a single line under the title in a search result; anything \
longer is truncated and looks broken.
- Say what the user DOES here, or what the page is FOR. Lead with a verb where natural: \
"Track", "Schedule", "Review", "Record".
- Use the column headers as evidence of what the page holds, but do NOT just list them. \
"Work Order, Asset, Due Date" becomes "Track repair work orders by asset and due date".
- Do not repeat the page title verbatim -- it is already shown directly above. \
"Payroll" should not be described as "The payroll page".
- No marketing language, no "easily", no "seamlessly", no exclamation marks. Plain and \
factual. A dispatcher is reading this to decide whether to click.
- Sentence case, no trailing full stop.

Reply with JSON only, no markdown fence and no commentary, in exactly this shape:
{"results": [{"id": "<the page id you were given>", "desc": "Track repair work orders by asset and due date"}]}

Include one entry per page, using its id exactly as given.`;

const userPrompt = (batch) =>
  `PAGES\n` +
  batch.map((p) => {
    const cols = p.cols?.length ? p.cols.join(', ') : `(no table -- this is a ${p.archetype} view)`;
    return `  id ${p.id} -- ${p.title} (section: ${p.section})\n      columns: ${cols}`;
  }).join('\n') +
  `\n\nWrite one description for each of the ${batch.length} pages.`;

function parseBatch(raw, batch) {
  let t = (raw ?? '').trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) t = fenced[1].trim();
  const open = t.indexOf('{'), close = t.lastIndexOf('}');
  if (open !== -1 && close > open) t = t.slice(open, close + 1);

  const obj = JSON.parse(t);
  const results = Array.isArray(obj) ? obj : obj.results ?? obj.pages;
  if (!Array.isArray(results)) throw new Error(`no "results" array in: ${t.slice(0, 120)}`);

  const out = new Map();
  for (const r of results) {
    const id = String(r?.id ?? '').trim();
    const desc = String(r?.desc ?? '').trim().replace(/\.$/, '');
    if (batch.some((p) => p.id === id) && desc) out.set(id, desc);
  }
  const missing = batch.filter((p) => !out.has(p.id));
  if (missing.length) throw new Error(`batch omitted ${missing.map((p) => p.id).join(',')}`);
  return out;
}

const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

async function main() {
  if (!process.env.LLM_API_KEY) {
    console.error('LLM_API_KEY is not set. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }
  if (!fs.existsSync(PAGES)) {
    console.error(`Missing ${path.relative(ROOT, PAGES)} -- run:  python build_snapshots.py`);
    process.exit(1);
  }
  const pages = JSON.parse(fs.readFileSync(PAGES, 'utf8'));
  const client = new OpenAI({ apiKey: process.env.LLM_API_KEY, baseURL: BASE_URL, maxRetries: 1 });

  const batches = chunk(pages, BATCH);
  console.log(`Describing ${pages.length} pages via ${LLM_MODEL}`);
  console.log(`  ${batches.length} request(s), ${BATCH} pages each, ${DELAY_MS}ms apart\n`);

  const have = new Map();
  for (let i = 0; i < batches.length; i++) {
    if (i && DELAY_MS) await new Promise((r) => setTimeout(r, DELAY_MS));
    const batch = batches[i];
    const res = await client.chat.completions.create({
      model: LLM_MODEL,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: userPrompt(batch) }],
      response_format: { type: 'json_object' },
      max_completion_tokens: maxOut(),
    });
    for (const [id, desc] of parseBatch(res.choices?.[0]?.message?.content, batch)) have.set(id, desc);
    console.log(`  ${String(have.size).padStart(2)}/${pages.length}  ${batch.map((p) => p.id).join(' ')}`);
  }

  const rows = pages.map((p) => ({ id: p.id, title: p.title, section: p.section, desc: have.get(p.id) }));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ model: LLM_MODEL, pages: rows }, null, 1), 'utf8');

  console.log(`\nWrote ${path.relative(ROOT, OUT)} -- REVIEW IT, then paste into PAGES as desc="..."\n`);
  const longest = Math.max(...rows.map((r) => r.title.length));
  for (const r of rows) {
    const words = r.desc.split(/\s+/).length;
    console.log(`  ${String(r.id).padEnd(6)} ${r.title.padEnd(longest)}  ${r.desc}${words > 12 ? `   <-- ${words} words, too long` : ''}`);
  }
}

main().catch((e) => {
  const said = e?.error?.error?.message || e?.error?.message || e?.message;
  if (e?.status) console.error(`\n${BASE_URL} returned ${e.status}:\n\n  ${said}\n`);
  else console.error(e);
  process.exit(1);
});
