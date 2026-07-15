/**
 * Build-time eval harness: how much real user language actually reaches the right page?
 *
 * NOT part of `npm run build`. The build gate in generate_embeddings.js checks the 3
 * clickable examples in suggestions.json -- that protects the most visible surface, but
 * 3 queries over 41 pages measures almost nothing. This measures the rest.
 *
 * Run:  node generate_eval.js              # generate if needed, then score
 *       node generate_eval.js --score-only # score whatever is cached; never call the API
 *       node generate_eval.js --regenerate # throw away the test set and rebuild it
 *
 * Two phases:
 *   1. generate -- an LLM writes N realistic queries per page. Cached to eval/queries.json.
 *                  Needs LLM_API_KEY. Runs once, then never again until you pass
 *                  --regenerate or add pages.
 *   2. score    -- embeds every query with the SAME MiniLM the browser runs, ranks it
 *                  against the SHIPPED vectors in assets/data/page-index.js, reports
 *                  what misses. Free, offline, no key, no provider.
 *
 * ---------------------------------------------------------------------------------
 * DEPLOYMENT: this script does not deploy. Anywhere. Ever.
 *
 * It is developer tooling that runs on your machine (or in CI) and writes eval/*.json.
 * If you host the demo on Vercel or anything else, LLM_API_KEY does NOT belong in that
 * host's environment variables -- the deployed site is static, makes zero network calls,
 * and would not know what to do with a key. Adding one there only widens the blast radius
 * of a leak for no benefit.
 *
 * The corollary is the important half: NEVER give this key a NEXT_PUBLIC_ / VITE_ /
 * REACT_APP_ prefix. Those prefixes are an instruction to the bundler to inline the value
 * into JavaScript that ships to every visitor's browser. A key in client-side JS is a
 * published key, whatever the hosting platform's docs call it.
 *
 * A key would only ever be needed server-side, and only if you later add the runtime NL
 * filter extraction from SEARCH_PLAN.md 4 -- which means a serverless function holding the
 * key, and the demo losing the "no backend, nothing to fail live" property that 6.1
 * deliberately paid for. That is a real trade, worth making deliberately, in production
 * rather than in the demo. It is not this file's problem.
 * ---------------------------------------------------------------------------------
 * PROVIDER: any OpenAI-compatible endpoint. Put these in .env (see .env.example).
 *
 *   LLM_API_KEY    (required)
 *   LLM_BASE_URL   (default: Groq's OpenAI-compatible endpoint)
 *   LLM_MODEL      (default: openai/gpt-oss-120b)
 *
 * Known free tiers, all OpenAI-compatible -- pick one, paste its two values:
 *
 *   Groq           https://api.groq.com/openai/v1                            openai/gpt-oss-120b
 *   Cerebras       https://api.cerebras.ai/v1                                llama-3.3-70b
 *   Mistral        https://api.mistral.ai/v1                                 mistral-small-latest
 *   OpenRouter     https://openrouter.ai/api/v1                              <any model ending in :free>
 *   Google Gemini  https://generativelanguage.googleapis.com/v1beta/openai/  gemini-2.5-flash
 *
 * Model names drift and free-tier lineups change -- if you get a 404, the name is stale.
 *
 * A 429 here usually does NOT mean "too fast". Measured on Gemini 2026-07-15: free-tier
 * quota is granted PER MODEL, and /models happily lists models you have no quota for --
 * one key returned 200 on gemini-2.5-flash and 429 "limit: 0" on 2.0-flash, 2.0-flash-lite
 * and 2.5-pro at the same moment. That same key then proved to have a *daily* cap of 20
 * requests. Read the provider's error text (the handler at the bottom prints it verbatim)
 * before touching LLM_CONCURRENCY -- and prefer raising LLM_BATCH over slowing down, since
 * request budgets bite long before token budgets do.
 *
 * This phase is deliberately undemanding: short prompts, small JSON out, no tool use, no
 * long context. A free-tier model is genuinely adequate here -- you are asking for
 * plausible search phrasings, not reasoning. The eval's rigor comes from withholding the
 * `search` text (below), not from the model's horsepower.
 * ---------------------------------------------------------------------------------
 *
 * The loop this is built for: score -> see which pages real phrasing can't reach -> add
 * terms to that page's `search` in build_snapshots.py -> rebuild -> score again. Phase 1
 * does not re-run, so the test set stays fixed while you tune against it. A test set that
 * regenerates on every run measures nothing, because you can never tell whether the
 * number moved because you fixed the page or because the queries got easier.
 *
 * ---------------------------------------------------------------------------------
 * WHY QUERIES ARE GENERATED FROM title + section ONLY
 *
 * pages.json `text` is "Title. Section. Cols. <hand-written search synonyms>" -- the
 * synonyms are already in there. Show that text to the model and it will paraphrase the
 * synonyms back at you, every query will match the page it came from, and the eval will
 * report ~100% while telling you nothing.
 *
 * Withholding it is the entire point. The model gets only what the page IS ("Payroll",
 * "Accounting") and has to guess how a user would ask for it. A miss then means
 * something real: the `search` text does not bridge that phrasing to that page. That is
 * the gap SEARCH_PLAN.md 3.1 calls the quality lever, and it is currently hand-authored
 * with no way to find what it missed.
 *
 * Cols are withheld for the same reason -- they are page internals, not user vocabulary.
 * They still count on the scoring side, because they are in the embedded text.
 * ---------------------------------------------------------------------------------
 */
import { pipeline, env } from '@xenova/transformers';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import { rankMerged, semanticScores, keywordScores } from './ranking.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/* Load .env if present. Built into Node (>=20.12) -- no dotenv dependency. Shell vars
 * already set WIN over the file, so `$env:LLM_MODEL="x"; node generate_eval.js` still
 * overrides for a one-off run without editing .env.
 *
 * .env is gitignored. It is read here, at build time, on your machine. It is never
 * bundled, never referenced by assets/, and never needed by the deployed site -- see the
 * DEPLOYMENT note in the header. */
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // No .env, or Node too old to have loadEnvFile. Shell env still works; if the key is
  // missing entirely, generateQueries prints the actionable error.
}
const PAGES = path.join(ROOT, 'assets', 'data', 'pages.json');
const INDEX = path.join(ROOT, 'assets', 'data', 'page-index.js');
const EVAL_DIR = path.join(ROOT, 'eval');
const QUERIES = path.join(EVAL_DIR, 'queries.json');
const REPORT = path.join(EVAL_DIR, 'report.json');

// Must match generate_embeddings.js and command-palette.js, or the vectors are not
// comparable and every number below is noise.
const MODEL = 'Xenova/all-MiniLM-L6-v2';
const QUANTIZED = true;

// Any OpenAI-compatible endpoint. See the PROVIDER block in the header.
const BASE_URL = process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1';
const LLM_MODEL = process.env.LLM_MODEL || 'openai/gpt-oss-120b';

/* Free tiers meter REQUESTS, not tokens, and they meter them brutally: Gemini's free tier
 * for gemini-2.5-flash reports `limit: 20`. This script's first design asked one request
 * per page -- 41 requests against a 20-request budget. No amount of pacing fixes a plan
 * that needs twice the requests it is allowed, which is why the first two attempts died
 * at pages 6 and 14 and looked like a speed problem.
 *
 * So: batch pages into one request. 41 pages / 8 = 6 requests, comfortably inside 20, and
 * cheaper in tokens too -- the 41-page roster is sent once per batch instead of once per
 * page. Pacing and checkpointing stay as the belt-and-braces for whatever is left. */
const BATCH = Number(process.env.LLM_BATCH || 8);
const CONCURRENCY = Number(process.env.LLM_CONCURRENCY || 1);
// Groq meters tokens-per-minute (free tier: 8000 TPM), so pacing here rations tokens, not
// requests. ~20s apart keeps 6 requests inside the window with room to spare.
const DELAY_MS = Number(process.env.LLM_DELAY_MS || 20000);

/* max_completion_tokens is a RESERVATION, not a ceiling you only pay when you use it.
 * Groq checks `input + max_completion_tokens <= TPM` BEFORE generating and 413s if it
 * fails -- measured: an 880-token prompt with a 16384 reservation asked for 17266 against
 * a limit of 8000 and was rejected without producing a single token. A "generous" ceiling
 * is therefore not free; it is the whole budget, claimed upfront.
 *
 * So size it to the actual job: BATCH x N_QUERIES short strings (~16 tokens each with JSON
 * scaffolding), plus a fixed cushion for the wrapper and -- on reasoning models like
 * gpt-oss-120b -- the model's own thinking, which is billed from this same budget.
 *
 * Note the tension with BATCH: bigger batches need a bigger reservation, but repeat the
 * 41-page roster fewer times, so total tokens FALL. If you are TPM-bound, raising BATCH
 * usually helps; if a single request 413s, lower it. */
const maxOut = () => Math.min(8192, BATCH * N_QUERIES * 16 + 2048);

env.allowRemoteModels = true; // build-time only; the browser runs fully local.

/* ------------------------------------------------------------------------ args */
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};
const has = (name) => argv.includes(`--${name}`);

const REGENERATE = has('regenerate');
// Score a partial test set without touching the API. Free-tier request budgets are small
// enough that a set can legitimately take several days to finish -- you should not have
// to wait for page 41 to start learning from pages 1-14.
const SCORE_ONLY = has('score-only');
const N_QUERIES = Number(flag('queries', 12));
const FAIL_UNDER = flag('fail-under', null); // e.g. --fail-under=0.85 for CI

/* -------------------------------------------------------------- phase 1: generate */

/**
 * Shape is asked for in the prompt and validated on the way back, rather than enforced
 * with response_format:{type:'json_schema'}. Strict schema support is the least portable
 * thing across OpenAI-compatible providers -- some 400 on it, some silently ignore it,
 * some honour it. json_object mode is near-universal, and parseQueries below repairs the
 * two failure modes that survive it (markdown fences, prose preamble). The cost of being
 * wrong here is one retry, so portability wins.
 */
const SYSTEM = `You generate realistic search queries for evaluating a command palette in \
OpsFlo, an operations/logistics ERP used by dispatchers, field technicians, payroll \
clerks, and warehouse staff.

You will be given a batch of TARGET pages (id + title + section) and the full roster of \
every page in the app. For EACH target page, write queries that a real user would type \
into a search box when they want that page.

Rules:
- Write how users actually type: lowercase, terse, often no punctuation. "who's late", \
"overtime last week", "add a new truck". Not formal prose.
- Vary the angle: the job to be done ("who is late"), the domain noun ("overtime"), the \
action ("book a shift"), and the plain page name. Roughly a quarter should be phrased as \
a question or a goal rather than a keyword.
- Do NOT simply restate the page title in every query. At most one query may be the bare \
title.
- CRITICAL: each query must unambiguously belong to the TARGET page and not to any other \
page on the roster. If a phrasing would equally well describe a sibling page, do not use \
it. Check the roster before you commit to each one.
- No page IDs, no internal jargon, no column names the user would not say out loud.

Reply with JSON only, no markdown fence and no commentary, in exactly this shape:
{"results": [{"id": "<the page id you were given>", "queries": ["first query", "second query"]}]}

Include one entry per target page, using its id exactly as given.`;

const userPrompt = (batch, roster) =>
  `TARGET PAGES (write queries for each of these)\n` +
  batch.map((p) => `  id ${p.id} -- ${p.title} (section: ${p.section})`).join('\n') +
  `\n\nFULL ROSTER (do not write queries that could mean any of these instead)\n` +
  roster.map((p) => `  ${p.title} -- ${p.section}`).join('\n') +
  `\n\nWrite exactly ${N_QUERIES} queries for each of the ${batch.length} target pages.`;

async function runPool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

/**
 * Pull a queries array out of whatever the model actually sent. json_object mode is not
 * a guarantee across providers -- these are the real-world deviations worth repairing
 * silently. Anything past this throws and gets one retry.
 */
function parseBatch(raw, batch) {
  let t = (raw ?? '').trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);   // fence despite json_object
  if (fenced) t = fenced[1].trim();
  const open = t.indexOf('{');                              // prose preamble
  const close = t.lastIndexOf('}');
  if (open !== -1 && close > open) t = t.slice(open, close + 1);

  const obj = JSON.parse(t); // throws on truncation -> caller retries once
  const results = Array.isArray(obj) ? obj : obj.results ?? obj.pages;
  if (!Array.isArray(results)) throw new Error(`no "results" array in: ${t.slice(0, 120)}`);

  const out = new Map();
  for (const r of results) {
    const id = String(r?.id ?? '').trim();
    if (!batch.some((p) => p.id === id)) continue; // ignore ids we did not ask for
    const clean = [...new Set((r.queries || []).filter((q) => typeof q === 'string')
      .map((q) => q.trim()).filter(Boolean))];
    if (clean.length) out.set(id, clean);
  }
  const missing = batch.filter((p) => !out.has(p.id));
  if (missing.length) throw new Error(`batch omitted ${missing.map((p) => p.id).join(',')}`);
  return out;
}

const chunk = (arr, n) =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

async function generateQueries(pages, existing = []) {
  if (!process.env.LLM_API_KEY) {
    console.error(
      'LLM_API_KEY is not set -- phase 1 (query generation) needs it.\n\n' +
      '  PowerShell:  $env:LLM_API_KEY = "..."\n' +
      '  bash:        export LLM_API_KEY=...\n\n' +
      `Currently pointed at:  ${BASE_URL}\n` +
      `                       model ${LLM_MODEL}\n\n` +
      'Any OpenAI-compatible free tier works -- override LLM_BASE_URL and LLM_MODEL to\n' +
      'switch provider. See the PROVIDER block at the top of this file for known ones.\n\n' +
      'The key is only ever read here, at build time. Nothing in assets/ ships it, and\n' +
      'the palette itself never makes a network call. See SEARCH_PLAN.md 1.\n'
    );
    process.exit(1);
  }

  const client = new OpenAI({
    apiKey: process.env.LLM_API_KEY,
    baseURL: BASE_URL,
    // Deliberately low. Every retry SPENDS a request from the same metered budget that
    // just refused us -- retrying a request-quota 429 six times burns 6 more of the 20
    // we were allowed. Fail fast, checkpoint, resume.
    maxRetries: 1,
  });
  const roster = pages.map((p) => ({ title: p.title, section: p.section }));

  // Resume: anything already in eval/queries.json is finished work. Never re-buy it.
  const have = new Map(existing.map((p) => [p.id, p]));
  const todo = pages.filter((p) => !have.has(p.id));
  if (!todo.length) return [...have.values()];

  const save = () => {
    fs.mkdirSync(EVAL_DIR, { recursive: true });
    const ordered = pages.map((p) => have.get(p.id)).filter(Boolean);
    fs.writeFileSync(QUERIES, JSON.stringify({
      provider: BASE_URL, model: LLM_MODEL, n: N_QUERIES,
      generated_at: new Date().toISOString(),
      complete: ordered.length === pages.length,
      pages: ordered,
    }, null, 1), 'utf8');
  };

  const batches = chunk(todo, BATCH);
  console.log(`Generating ${N_QUERIES} queries x ${todo.length} pages` +
              (have.size ? `  (resuming; ${have.size} already done)` : ''));
  console.log(`  provider  ${BASE_URL}`);
  console.log(`  model     ${LLM_MODEL}`);
  console.log(`  plan      ${batches.length} request(s), ${BATCH} pages each, ${DELAY_MS}ms apart\n`);

  const askOnce = async (batch, repair) => {
    const messages = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userPrompt(batch, roster) },
    ];
    if (repair) messages.push({ role: 'user', content: `That reply was unusable (${repair}). Reply with ONLY {"results":[{"id":"...","queries":[...]}]} covering every id.` });

    const res = await client.chat.completions.create({
      model: LLM_MODEL,
      messages,
      response_format: { type: 'json_object' },
      max_completion_tokens: maxOut(), // a reservation, not a ceiling -- see maxOut()
    });
    return parseBatch(res.choices?.[0]?.message?.content, batch);
  };

  try {
    await runPool(batches, CONCURRENCY, async (batch, i) => {
      if (i && DELAY_MS) await new Promise((r) => setTimeout(r, DELAY_MS));
      let got;
      try {
        got = await askOnce(batch);
      } catch (e) {
        if (e instanceof SyntaxError || /results|omitted/.test(e.message)) {
          got = await askOnce(batch, e.message.slice(0, 80)); // one repair attempt
        } else {
          throw e;
        }
      }
      for (const p of batch) {
        have.set(p.id, { id: p.id, title: p.title, section: p.section, queries: got.get(p.id) });
      }
      save(); // checkpoint per batch -- a throttle must never cost finished work
      console.log(`  ${String(have.size).padStart(2)}/${pages.length}  ` +
                  batch.map((p) => p.id).join(' '));
    });
  } catch (e) {
    save();
    console.error(`\n${have.size}/${pages.length} pages saved to ${path.relative(ROOT, QUERIES)}.\n` +
                  'Re-run the same command to resume from there -- finished pages are not re-fetched.');
    throw e;
  }

  save();
  console.log(`\nWrote ${path.relative(ROOT, QUERIES)} -- this is now your fixed test set.`);
  console.log('Commit it. Re-runs score against it for free; --regenerate replaces it.\n');
  return [...have.values()];
}

/* ----------------------------------------------------------------- phase 2: score */

/**
 * Load the SHIPPED index, not pages.json. page-index.js is what the browser actually
 * gets, including the 6-decimal vector truncation -- scoring anything else would test a
 * build artifact that nobody runs.
 */
function loadShippedIndex() {
  if (!fs.existsSync(INDEX)) {
    console.error(`Missing ${path.relative(ROOT, INDEX)} -- run:  npm run build`);
    process.exit(1);
  }
  const shim = {};
  new Function('window', fs.readFileSync(INDEX, 'utf8'))(shim);
  const rows = shim.__OPSFLO_PAGE_INDEX__;
  if (!Array.isArray(rows) || !rows.length) {
    console.error('page-index.js did not yield __OPSFLO_PAGE_INDEX__ -- rebuild it.');
    process.exit(1);
  }
  return rows;
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;

async function score(testSet) {
  const rows = loadShippedIndex();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const name = (id) => (id ? `${id} ${byId.get(id)?.title ?? '?'}` : '(no result)');

  const stale = testSet.filter((p) => !byId.has(p.id));
  if (stale.length) {
    console.warn(`! ${stale.length} page(s) in the test set no longer exist: ` +
                 `${stale.map((p) => p.id).join(', ')} -- re-run with --regenerate.\n`);
  }
  const live = testSet.filter((p) => byId.has(p.id));

  console.log(`Loading ${MODEL} (quantized=${QUANTIZED})...`);
  const embed = await pipeline('feature-extraction', MODEL, { quantized: QUANTIZED });

  const perPage = [];
  const misses = [];
  const kwMisses = [];
  let semHit1 = 0, semHit5 = 0, kwHit1 = 0, kwHit5 = 0, total = 0;

  for (const p of live) {
    let s1 = 0, s5 = 0, k1 = 0, k5 = 0;

    for (const q of p.queries) {
      const out = await embed(q, { pooling: 'mean', normalize: true });
      const qv = Array.from(out.data);

      // rankMerged, NOT the raw lanes: the name lane pins exact title/id matches ahead
      // of the cosine, so scoring semanticScores() alone measures a component the user
      // never sees on its own. See ranking.js -> name lane.
      const semTop5 = rankMerged(rows, q, semanticScores(rows, qv, q));
      const kwTop5 = rankMerged(rows, q, keywordScores(rows, q));
      const semTop = semTop5[0] ?? null;
      const kwTop = kwTop5[0] ?? null;

      if (semTop === p.id) s1++;
      if (semTop5.includes(p.id)) s5++;
      if (kwTop === p.id) k1++;
      if (kwTop5.includes(p.id)) k5++;
      total++;

      if (semTop !== p.id) {
        misses.push({ id: p.id, query: q, got: semTop, expected: p.id, lane: 'semantic' });
      }
      // Keyword misses were invisible here until now, which is why the lane sat at 63%
      // with no diagnosis: the report showed an aggregate and no failing cases.
      if (kwTop !== p.id) {
        kwMisses.push({ id: p.id, query: q, got: kwTop, expected: p.id, lane: 'keyword' });
      }
    }

    semHit1 += s1; semHit5 += s5; kwHit1 += k1; kwHit5 += k5;
    perPage.push({
      id: p.id, title: p.title, section: p.section, n: p.queries.length,
      sem_recall_1: s1 / p.queries.length, sem_recall_5: s5 / p.queries.length,
      kw_recall_1: k1 / p.queries.length, kw_recall_5: k5 / p.queries.length,
    });
  }

  /* ------------------------------------------------------------------- report */
  const summary = {
    sem_recall_1: semHit1 / total, sem_recall_5: semHit5 / total,
    kw_recall_1: kwHit1 / total, kw_recall_5: kwHit5 / total,
    pages: live.length, queries: total,
  };

  console.log(`\n${'='.repeat(66)}`);
  console.log(`${live.length} pages, ${total} queries, scored against the shipped index`);
  console.log('='.repeat(66));
  console.log(`  semantic   recall@1 ${pct(summary.sem_recall_1).padStart(6)}   recall@5 ${pct(summary.sem_recall_5).padStart(6)}`);
  console.log(`  keyword    recall@1 ${pct(summary.kw_recall_1).padStart(6)}   recall@5 ${pct(summary.kw_recall_5).padStart(6)}`);
  console.log(`             ^ keyword is what file:// and the cold-model window show.`);

  const unreachable = perPage.filter((p) => p.sem_recall_1 === 0);
  if (unreachable.length) {
    console.log(`\nUNREACHABLE -- no generated query reaches these pages at top-1 (semantic):`);
    for (const p of unreachable) {
      const took = {};
      for (const m of misses.filter((m) => m.id === p.id)) {
        const k = m.got ?? '(none)';
        took[k] = (took[k] || 0) + 1;
      }
      const where = Object.entries(took).sort((a, b) => b[1] - a[1])
        .map(([id, n]) => `${id === '(none)' ? '(no result)' : name(id)} x${n}`).join(', ');
      console.log(`  ${String(p.id).padEnd(6)} ${p.title.padEnd(28)} -> ${where}`);
    }
  }

  const weak = perPage.filter((p) => p.sem_recall_1 > 0 && p.sem_recall_1 < 0.6)
    .sort((a, b) => a.sem_recall_1 - b.sem_recall_1);
  if (weak.length) {
    console.log(`\nWEAK -- under 60% of real phrasings land (semantic recall@1):`);
    for (const p of weak) {
      console.log(`  ${String(p.id).padEnd(6)} ${p.title.padEnd(28)} ${pct(p.sem_recall_1).padStart(6)}`);
    }
  }

  if (misses.length) {
    console.log(`\nMISSES (${misses.length}) -- each one is a phrasing your \`search\` text does not cover:`);
    for (const m of misses) {
      console.log(`  "${m.query}"`);
      console.log(`      got ${name(m.got)}  //  want ${name(m.expected)}`);
    }
  }

  console.log(
    `\nTo fix: add the missing vocabulary to that page's \`search=\` in build_snapshots.py,\n` +
    `then  npm run build && node generate_eval.js  -- the test set does not change, so the\n` +
    `number moving means you actually fixed it.\n`
  );

  fs.mkdirSync(EVAL_DIR, { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify({ summary, per_page: perPage, misses, kw_misses: kwMisses }, null, 1), 'utf8');
  console.log(`Wrote ${path.relative(ROOT, REPORT)}`);

  if (FAIL_UNDER !== null) {
    const bar = Number(FAIL_UNDER);
    if (summary.sem_recall_1 < bar) {
      console.error(`\nFAIL: semantic recall@1 ${pct(summary.sem_recall_1)} is below --fail-under=${pct(bar)}`);
      process.exit(1);
    }
    console.log(`\nPASS: semantic recall@1 ${pct(summary.sem_recall_1)} >= ${pct(bar)}`);
  }
}

/* ------------------------------------------------------------------------ main */
async function main() {
  if (!fs.existsSync(PAGES)) {
    console.error(`Missing ${path.relative(ROOT, PAGES)} -- run:  python build_snapshots.py`);
    process.exit(1);
  }
  const pages = JSON.parse(fs.readFileSync(PAGES, 'utf8'));

  const cached = !REGENERATE && fs.existsSync(QUERIES)
    ? JSON.parse(fs.readFileSync(QUERIES, 'utf8'))
    : null;

  let testSet;
  const covered = cached ? cached.pages.filter((t) => pages.some((p) => p.id === t.id)) : [];
  const missing = pages.filter((p) => !covered.some((t) => t.id === p.id));

  if (SCORE_ONLY) {
    if (!cached) {
      console.error(`--score-only needs an existing ${path.relative(ROOT, QUERIES)}; there is none yet.`);
      process.exit(1);
    }
    testSet = covered;
    const n = testSet.reduce((s, p) => s + p.queries.length, 0);
    console.log(`Scoring cached set only, no API calls: ${testSet.length}/${pages.length} pages, ${n} queries.`);
    if (missing.length) {
      console.log(`${missing.length} page(s) not yet covered -- their score is unknown, not zero.\n` +
                  `Run without --score-only to fetch them when quota allows.\n`);
    }
  } else if (cached && !missing.length) {
    testSet = cached.pages;
    const n = testSet.reduce((s, p) => s + p.queries.length, 0);
    console.log(`Using cached test set: ${path.relative(ROOT, QUERIES)} ` +
                `(${testSet.length} pages, ${n} queries, ${cached.model ?? '?'}, ${cached.generated_at})\n`);
  } else {
    // Either nothing cached, or a previous run was cut short. Both resume the same way:
    // generateQueries skips whatever is already on disk.
    if (cached) {
      console.log(`Incomplete test set: ${covered.length}/${pages.length} pages done, ` +
                  `${missing.length} to go. Resuming.\n`);
    }
    testSet = await generateQueries(pages, REGENERATE ? [] : covered);
  }

  await score(testSet);
}

/**
 * ALWAYS print what the provider actually said before adding our own interpretation.
 * An earlier version of this handler pattern-matched the status code and printed only
 * its own guess -- a Gemini "quota limit: 0" (credential has no free tier at all) came
 * out as "you're going too fast, lower concurrency", which is the opposite of the fix
 * and unfalsifiable from the console. Our advice is a hint; theirs is the evidence.
 */
main().catch((e) => {
  const said = e?.error?.error?.message || e?.error?.message || e?.message;
  if (e?.status) console.error(`\n${BASE_URL}\nreturned ${e.status}:\n\n  ${said}\n`);

  if (e instanceof OpenAI.AuthenticationError) {
    console.error('The credential was rejected. Check LLM_API_KEY belongs to this provider --\n' +
                  'a Groq key will not work against Gemini\'s endpoint, and vice versa.');
  } else if (e instanceof OpenAI.NotFoundError) {
    console.error(`Model "${LLM_MODEL}" does not exist here. Free-tier lineups change often;\n` +
                  'check the provider\'s model list and set LLM_MODEL.');
  } else if (e?.status === 413) {
    // "Too large" is a per-REQUEST size problem: smaller batch, smaller reservation.
    // The opposite of the 429 fix -- do not slow down, that changes nothing.
    console.error(`This is a per-request size limit, not a rate limit -- pacing will not\n` +
                  `help. The request reserves input + max_completion_tokens (${maxOut()}) up\n` +
                  'front, so shrink the batch:\n\n' +
                  `  $env:LLM_BATCH = "${Math.max(1, Math.floor(BATCH / 2))}"   # currently ${BATCH}\n`);
  } else if (e instanceof OpenAI.RateLimitError) {
    // "limit: 0" is not throttling -- it means no quota exists for THIS model on this
    // account. Retrying or slowing down cannot fix a quota of zero. Note the provider's
    // message names the model; believe it over any theory about the credential.
    if (/limit:\s*0\b/.test(said || '')) {
      const m = (said.match(/model:\s*([\w.-]+)/) || [])[1] || LLM_MODEL;
      console.error(`NOTE: "limit: 0" means no free-tier quota for "${m}" on this account.\n` +
                    'It is NOT throttling -- retrying and lowering LLM_CONCURRENCY cannot\n' +
                    'help, because zero requests are allowed at any speed.\n\n' +
                    'Gemini grants free quota per model, and /models lists models you may\n' +
                    'have no quota for. Try a different one:\n\n' +
                    '  $env:LLM_MODEL = "gemini-2.5-flash"\n');
    } else {
      console.error('Throttled. Read the message above before reacting -- if it mentions a\n' +
                    'daily/quota cap, slowing down cannot help and you want fewer requests\n' +
                    `(raise LLM_BATCH, currently ${BATCH}) or another provider.\n\n` +
                    `If it is genuinely per-minute rate (currently ${DELAY_MS}ms apart):\n\n` +
                    `  $env:LLM_DELAY_MS = "${DELAY_MS * 2}"\n\n` +
                    'Either way, finished pages are saved and skipped, so each re-run makes\n' +
                    'forward progress.\n');
    }
  } else if (e instanceof OpenAI.APIConnectionError) {
    console.error(`Could not reach ${BASE_URL}\n` +
                  'Phase 2 (scoring) is fully offline -- once eval/queries.json exists, run\n' +
                  'without --regenerate and you never need the network again.');
  } else if (!e?.status) {
    console.error(e);
  }
  process.exit(1);
});
