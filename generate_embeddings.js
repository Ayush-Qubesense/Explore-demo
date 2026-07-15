/**
 * Reads  assets/data/pages.json   (emitted by build_snapshots.py)
 * Writes assets/data/page-index.js (same rows + a 384-float vector each)
 *
 * Run:   node generate_embeddings.js
 * Rerun whenever PAGES or the `search` text in build_snapshots.py changes.
 *
 * Why Node and not Python: the browser runs @xenova/transformers, so embedding the
 * corpus with the exact same library + model version here guarantees the corpus and
 * query vectors live in the same space. A Python sentence-transformers build of the
 * "same" model is not guaranteed to be comparable. See SEARCH_PLAN.md 2.
 *
 * Output is a .js assignment, not .json, so it loads over file:// too (a <script> tag
 * works where fetch() does not). See SEARCH_PLAN.md 6.1.
 */
import { pipeline, env } from '@xenova/transformers';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rankMerged, semanticScores, keywordScores } from './ranking.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'assets', 'data', 'pages.json');
const SUGG = path.join(ROOT, 'assets', 'data', 'suggestions.json');
const OUT = path.join(ROOT, 'assets', 'data', 'page-index.js');

// Must match command-palette.js exactly -- both sides of the comparison.
const MODEL = 'Xenova/all-MiniLM-L6-v2';
const QUANTIZED = true;

// Keep vectors small in the shipped file. MiniLM output is ~1e-2 scale; 6 decimals is
// far below the noise floor of the quantized model and saves ~40% of the file size.
const PRECISION = 6;

env.allowRemoteModels = true; // build-time only; the browser runs fully local.

/* ------------------------------------------------------------- example gate
 * The palette's empty state offers clickable example queries. If an example resolves
 * to the wrong page, the demo teaches the audience that the AI is wrong -- on the most
 * visible surface there is. So the build verifies every example and fails on a miss.
 *
 * It must check BOTH ranking modes. Semantic-only would have missed the real bug that
 * prompted this gate: "who's late" ranked Vehicle / Truck Master #1 in keyword mode,
 * because "late" is a substring of "plate"/"template"/"related" -- a 4-way tie at
 * MIN_SCORE broken by id order. Keyword mode is what file:// and the ~2.1s cold-model
 * window actually run.
 *
 * The ranking itself lives in ranking.js -- shared with generate_eval.js, and mirrored
 * from assets/js/command-palette.js. Keep those two in sync; a divergence means this
 * gate stops testing what ships. */

async function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`Missing ${path.relative(ROOT, SRC)} -- run:  python build_snapshots.py`);
    process.exit(1);
  }
  const pages = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  if (!Array.isArray(pages) || pages.length === 0) {
    console.error('pages.json is empty or not an array.');
    process.exit(1);
  }

  console.log(`Loading ${MODEL} (quantized=${QUANTIZED})...`);
  const embed = await pipeline('feature-extraction', MODEL, { quantized: QUANTIZED });

  const rows = [];
  for (const p of pages) {
    for (const k of ['id', 'title', 'section', 'url', 'text']) {
      if (!p[k]) throw new Error(`page ${p.id ?? '?'} is missing "${k}"`);
    }
    // pooling+normalize must match the query side, or cosine similarity is meaningless.
    // NOTE p.text, never p.desc: descriptions are display-only and must not reach a
    // vector. See DESCRIPTIONS in build_snapshots.py for why.
    const out = await embed(p.text, { pooling: 'mean', normalize: true });
    const vector = Array.from(out.data, (v) => Number(v.toFixed(PRECISION)));
    if (vector.length !== 384) throw new Error(`page ${p.id}: got ${vector.length} dims, expected 384`);
    rows.push({ id: p.id, title: p.title, section: p.section, url: p.url, text: p.text, desc: p.desc, vector });
    console.log(`  ${String(p.id).padEnd(6)} ${p.title}`);
  }

  // ---------------------------------------------------------- suggestions + gate
  let suggestions = { defaults: [], examples: [] };
  if (fs.existsSync(SUGG)) {
    suggestions = JSON.parse(fs.readFileSync(SUGG, 'utf8'));
  } else {
    console.warn(`\n! ${path.relative(ROOT, SUGG)} missing -- palette will have no suggestions.`);
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of suggestions.defaults || []) {
    if (!byId.has(id)) throw new Error(`suggestions.defaults references unknown page id "${id}"`);
  }

  const failures = [];
  for (const ex of suggestions.examples || []) {
    if (!byId.has(ex.expect)) throw new Error(`example "${ex.q}" expects unknown page id "${ex.expect}"`);
    const out = await embed(ex.q, { pooling: 'mean', normalize: true });
    const qv = Array.from(out.data);

    // rankMerged, not a bare lane: the name lane pins exact title/id matches ahead of
    // the cosine, so testing semanticScores() alone tests a component, not the product.
    const sem = rankMerged(rows, ex.q, semanticScores(rows, qv, ex.q))[0] ?? null;
    const kw = rankMerged(rows, ex.q, keywordScores(rows, ex.q))[0] ?? null;

    const name = (id) => (id ? `${id} ${byId.get(id).title}` : '(no result)');
    if (sem !== ex.expect) failures.push(`  "${ex.q}"  semantic top-1 = ${name(sem)}, expected ${name(ex.expect)}`);
    if (kw !== ex.expect) {
      failures.push(`  "${ex.q}"  keyword top-1 = ${name(kw)}, expected ${name(ex.expect)}\n` +
                    `      ^ this is what file:// and the cold-model window will show on stage.`);
    }
    if (sem === ex.expect && kw === ex.expect) console.log(`  ok   "${ex.q}" -> ${name(ex.expect)}`);
  }
  if (failures.length) {
    console.error('\nExample verification FAILED:\n' + failures.join('\n') +
      '\n\nFix the query, the page\'s `search` text, or the ranking -- do not ship a demo\n' +
      'whose own suggestions resolve to the wrong page.\n');
    process.exit(1);
  }

  const banner =
    '/* GENERATED by generate_embeddings.js -- do not edit.\n' +
    ` * Source: assets/data/pages.json + suggestions.json (build_snapshots.py)\n` +
    ` * Model:  ${MODEL} (quantized=${QUANTIZED}), mean-pooled + L2-normalized, ${rows.length} pages.\n` +
    ` * Examples verified top-1 in BOTH semantic and keyword mode.\n` +
    ' * Rebuild: python build_snapshots.py && node generate_embeddings.js\n' +
    ' */\n';
  // One row per line: large but diffable, and gzips well over the wire.
  const body =
    'window.__OPSFLO_PAGE_INDEX__ = [\n' +
    rows.map((r) => JSON.stringify(r)).join(',\n') +
    '\n];\n' +
    'window.__OPSFLO_SUGGESTIONS__ = ' + JSON.stringify(suggestions) + ';\n';

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, banner + body, 'utf8');

  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`\nWrote ${path.relative(ROOT, OUT)} -- ${rows.length} pages, 384 dims, ` +
              `${(suggestions.examples || []).length} verified examples, ${kb} KB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
