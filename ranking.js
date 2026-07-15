/**
 * The ranking functions, shared by every build-time consumer.
 *
 * These MIRROR assets/js/command-palette.js. That mirroring is the whole point and the
 * whole hazard: a divergence here means the build gate (generate_embeddings.js) and the
 * eval harness (generate_eval.js) stop testing what actually ships.
 *
 * This file exists so there are exactly TWO copies of the ranking -- this one for Node,
 * and command-palette.js for the browser -- rather than one per build script. When you
 * change the ranking in command-palette.js, change it here, and both consumers follow.
 *
 * Pure functions only. No I/O, no model loading, no side effects on import -- importing
 * this must never do work. (generate_embeddings.js calls main() at module scope, which
 * is exactly why nothing can import *it*; same trap SEARCH_PLAN.md 2 calls out for
 * `import build_snapshots` on the Python side.)
 */

// Calibrated constants. See command-palette.js for the measurement behind them:
// MIN_SCORE sits between the 0.195 noise ceiling and the 0.312 weakest true hit.
export const MIN_SCORE = 0.25;
export const LEX_WEIGHT = 0.10;

export const STOPWORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'for', 'of',
  'to', 'in', 'on', 'my', 'our', 'we', 'i', 'do', 'does', 'did', 'what', 'who', 'where',
  'how', 'much', 'next', 'me', 'show', 'find', 'get', 'all', 'and', 'it', 'be']);

export const hayOf = (r) => (r.title + ' ' + r.section + ' ' + r.text).toLowerCase();

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Prefix-anchored at a word boundary: \blate matches "late" but not "plate";
// \bcertification still matches "certifications".
const hasWord = (hay, w) => new RegExp('\\b' + reEsc(w)).test(hay);

/* Crude singular/plural fold, used ONLY by keywordScore's word matching.
 *
 * hasWord's prefix anchoring is one-directional: a query of "certification" matches the
 * hay word "certifications" (prefix), but "facility" does NOT match "facilities" -- the
 * shared prefix stops at "facilit". So the user typing the singular of a plural title
 * got nothing. Measured: Facilities Setup sat at 33% keyword recall largely on this.
 *
 * Linguistic correctness is not the goal and is not achievable in one line ("status" ->
 * "statu"). CONSISTENCY is: both sides go through the same fold, so a wrong-but-stable
 * stem still matches itself. */
const stem = (w) => (w.length > 3 ? w.replace(/ies$/, 'y').replace(/([^s])s$/, '$1') : w);

// A query word matches a hay word if the hay word starts with it (prefix, as before) OR
// the two agree once folded (facility ~ facilities).
const matchesWord = (hayWords, qw) => {
  const s = stem(qw);
  for (const hw of hayWords) if (hw.indexOf(qw) === 0 || stem(hw) === s) return true;
  return false;
};

const wordsOf = (s) => s.match(/[a-z0-9#]+/g) || [];

// 0..1 lexical overlap. Exact phrase match wins outright; otherwise the fraction of
// meaningful query words present. Note this uses a raw substring test for word hits,
// unlike keywordScore's hasWord -- that asymmetry is deliberate and calibrated.
export function lexical(r, query) {
  const hay = hayOf(r);
  const norm = query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!norm) return 0;
  if (hay.includes(norm)) return 1;
  const words = norm.split(' ').filter((w) => w.length > 2 && !STOPWORDS.has(w));
  if (!words.length) return 0;
  return words.filter((w) => hay.includes(w)).length / words.length;
}

/* Filler that never identifies a page. Used ONLY by keywordScore -- deliberately NOT
 * merged into STOPWORDS, which feeds lexical(), whose LEX_WEIGHT was measured against
 * today's exact word set. Changing that set silently moves the semantic path.
 *
 * These are the CRUD/navigation verbs a user wraps a real noun in. Nouns are NOT listed,
 * even generic-sounding ones: "module" looks like filler until "Document Module
 * Configuration", and "list" until "Maintenance Due List". Verbs are safe; nouns are the
 * thing being searched for. */
const KW_FILLER = new Set([...STOPWORDS,
  'add', 'new', 'edit', 'update', 'view', 'open', 'create', 'delete', 'remove',
  'manage', 'see', 'go', 'need', 'want']);
// NOT filtered, despite looking like filler -- each is load-bearing in a real title:
//   "setup"/"set"  -> Facilities Setup, Account Managers Setup, Operation Areas Setup
//   "check"        -> Check List Report 1-4
//   "list"         -> Maintenance Due List
//   "module"       -> Document Module Configuration
// Filtering "setup" cost Facilities Setup two thirds of its keyword recall (measured).

const contentWords = (q) => {
  // Length > 2 drops "of"/"to" noise -- but NEVER drop a number. Check List Report 1-4
  // have byte-identical sections, columns and `search` text; the trailing digit is the
  // ONLY thing that tells them apart. Filtering it left "cl report 2" tied four ways and
  // resolved by ID ORDER to Report 1 (measured: Reports 2-4 sat at 8% keyword recall).
  const all = q.split(/\s+/).filter((w) => w.length > 2 || /^\d+$/.test(w));
  const kept = all.filter((w) => !KW_FILLER.has(w));
  // "show all" is pure filler; scoring 0 there is worse than scoring on what was typed.
  return kept.length ? kept : all;
};

/* Fallback ranking for when the model is unavailable (file://, blocked WASM, and the
 * cold-start window -- which on a DEPLOYED site is a 22MB model download, not the ~2.1s
 * it takes off local disk. This lane is what most first-time visitors actually see).
 *
 * Scaled into a rough 0..1 band so MIN_SCORE stays meaningful across both modes.
 *
 * Two properties the old version lacked, both measured:
 *
 *  - FILLER IS DROPPED. "add new customer" matched 1 of 3 words -> (1/3)*0.5 = 0.167,
 *    under MIN_SCORE, so the panel came back EMPTY. 95 of 492 queries died this way.
 *    Only "customer" carries identity; the verb should not be able to veto the noun.
 *
 *  - TITLE BEATS HAYSTACK. The old cap squeezed every partial match into 0..0.5, so
 *    "customer certifications list" tied at 0.33 between Customer Certifications and
 *    Customer Master and broke by ID ORDER. A hay hit is cheap -- `search` is a bag of
 *    synonyms by design -- while a title hit is the user naming the page. Weighting them
 *    the same throws away the only signal that separates near-identical pages. */
export function keywordScore(r, query) {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const hay = hayOf(r);
  const title = r.title.toLowerCase();

  // Identification tiers: unchanged, still the strongest evidence there is.
  if (title === q) return 1;
  if (title.indexOf(q) === 0) return 0.9;
  if (title.includes(q)) return 0.75;

  const words = contentWords(q);
  if (!words.length) return hay.includes(q) ? 0.55 : 0;

  const titleW = wordsOf(title);
  const hayW = wordsOf(hay);
  const inTitle = words.filter((w) => matchesWord(titleW, w)).length / words.length;
  const inHay = words.filter((w) => matchesWord(hayW, w)).length / words.length;

  /* How much of the TITLE the query accounts for. Without this, "maintenance" scored
   * identically against "Maintenance", "Predictive Maintenance" and "Maintenance Due
   * List" -- all three contain the word, so all three tied and ID ORDER picked the
   * winner (Predictive Maintenance, which is not what anyone means by "maintenance").
   *
   * Naming a page's whole title is stronger evidence than naming one word of a longer
   * one. Small weight on purpose: it breaks ties, it does not overturn the lanes above. */
  const titleWords = titleW.filter((w) => w.length > 2);
  const coverage = titleWords.length
    ? titleWords.filter((tw) => words.some((qw) => tw.indexOf(qw) === 0 || stem(tw) === stem(qw))).length / titleWords.length
    : 0;

  // Ceilings: a title-word match tops out below the 0.9 title-prefix tier, and a
  // hay-only match reaches ~0.30 -- above MIN_SCORE so it still shows, but it can never
  // outrank a page the user actually partly named.
  let score = 0.50 * inTitle + 0.30 * inHay + 0.09 * coverage;

  /* The user's exact phrase appearing verbatim beats the same words scattered around.
   * As a bare floor (max(score, 0.55)) this never fired when word-matching already
   * scored higher -- so "expired certifications" tied at 0.595 between General
   * Certifications, whose `search` contains that exact phrase, and Equipment
   * Certifications, which merely contains both words. ID order then picked Equipment,
   * and the build gate caught it. Keep the floor, but let the phrase also break ties. */
  if (hay.includes(q)) score = Math.max(score, 0.55) + 0.08;

  return Math.min(score, 0.89);
}

export const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

/** Semantic lane: cosine (vectors are pre-normalized) plus the small lexical nudge. */
export const semanticScores = (rows, qv, query) =>
  rows.map((r) => ({ id: r.id, s: dot(qv, r.vector) + LEX_WEIGHT * lexical(r, query) }));

/** Keyword lane: what file:// and the cold-model window actually run. */
export const keywordScores = (rows, query) =>
  rows.map((r) => ({ id: r.id, s: keywordScore(r, query) }));

/** Ids at or above MIN_SCORE, best first. */
export function rank(scored) {
  return scored.filter((x) => x.s >= MIN_SCORE).sort((a, b) => b.s - a.s);
}

/** Top-1 id of ONE lane, or null. Note: NOT what the user sees -- see rankMerged. */
export function topId(scored) {
  const hits = rank(scored);
  return hits.length ? hits[0].id : null;
}

/* ------------------------------------------------------------------- name lane
 * Deterministic, model-free lookup over id + title + section, layered ON TOP of the
 * meaning lane by POSITION. These tiers are their own namespace: never added to a
 * cosine, never compared against MIN_SCORE.
 *
 * This lane is why "maintenance" resolves to Maintenance and not Predictive Maintenance,
 * and it is easy to forget precisely because it is not part of either score. Any harness
 * that scores semanticScores/keywordScores alone is measuring a lane, NOT the product --
 * it will report confident misses on queries the palette actually gets right. */
export const MAX_RESULTS = 5;
const NAME_PIN_MAX = 3;   // names take at most 3 of MAX_RESULTS; 2 always left for meaning
const PIN_TIER = 0.80;    // at/above this the user NAMED a page; below is mere evidence
const AMBIG_MAX = 6;      // a tier matching more pages than this has identified nothing

// Both sides must normalise identically, or "Warehouse / Yard Address" can never be
// found by "warehouse yard".
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

const nameFields = (e) => {
  if (!e._nm) {
    const t = norm(e.title);
    e._nm = { id: norm(e.id), title: t, words: t.split(' '), section: norm(e.section) };
  }
  return e._nm;
};

// "inv rep" -> ERP Inventory Report: every query word must prefix a distinct title word,
// in order.
function wordPrefixes(words, qs) {
  let w = 0;
  for (let i = 0; i < qs.length; i++) {
    while (w < words.length && words[w].indexOf(qs[i]) !== 0) w++;
    if (w >= words.length) return false;
    w++;
  }
  return true;
}

export function nameTier(e, q) {
  if (!q) return 0;
  const f = nameFields(e);
  if (f.id === q) return 1.00;                                    // "1676"    -> Payroll
  if (f.title === q) return 0.98;                                 // "payroll" -> Payroll
  if (q.length >= 2) {
    if (f.id.indexOf(q) === 0) return 0.92;                       // "159"     -> the 1590 family
    if (f.title.indexOf(q) === 0) return 0.90;                    // "payr"    -> Payroll
    const qs = q.split(' ');
    if (qs.length > 1 && wordPrefixes(f.words, qs)) return 0.85;  // "inv rep" -> ERP Inventory Report
  }
  // Evidence only, below PIN_TIER -- real, but not an identification.
  if (f.title.indexOf(' ' + q) !== -1) return 0.70;
  if (f.title.indexOf(q) !== -1) return 0.60;
  if (f.section === q) return 0.50;
  if (f.section.indexOf(q) === 0) return 0.40;
  return 0;
}

/** Name hits that earn a pinned slot. Both gates are load-bearing -- see command-palette.js. */
export function pinnedNames(rows, query) {
  const q = norm(query);
  if (!q) return [];
  const hits = rows.map((e) => ({ id: e.id, tier: nameTier(e, q) }))
    .filter((h) => h.tier > 0)
    .sort((a, b) => b.tier - a.tier);
  const top = hits.filter((h) => h.tier >= PIN_TIER);
  if (!top.length || top.length > AMBIG_MAX) return []; // a flood identifies nothing
  return top.slice(0, NAME_PIN_MAX);
}

/**
 * What the user actually sees: pins first (by tier), then the meaning lane, deduped,
 * capped at MAX_RESULTS. `laneScored` is semanticScores(...) or keywordScores(...).
 * Returns ids, best first.
 */
export function rankMerged(rows, query, laneScored) {
  const pins = pinnedNames(rows, query);
  const out = pins.map((p) => p.id);
  const seen = new Set(out);
  for (const x of rank(laneScored)) {
    if (out.length >= MAX_RESULTS) break;
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    out.push(x.id);
  }
  return out;
}
