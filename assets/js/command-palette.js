/* ==========================================================================
 * OpsFlo — AI command palette
 * Semantic "type what you want, land on the right page" navigation.
 *
 * Vanilla JS, classic script, no dependencies. Both are deliberate:
 *  - vanilla, because the real app's SiteV3.master loads no jQuery at all
 *    (it's per-page and version-inconsistent; 8 SiteV3 pages have none);
 *  - classic script, because ES modules are CORS-blocked under file://, and this
 *    must still degrade to keyword search when the demo is opened by double-click.
 *
 * Inputs (both supplied by build_snapshots.py):
 *   window.__OPSFLO_PAGE_INDEX__  - [{id,title,section,url,text,vector}]
 *   window.__OPSFLO_SITE_ROOT__   - "" at the site root, "../" inside pages/
 *
 * The widget NEVER builds a URL from an id -- it only prepends the site root to the
 * ready-made `url` on each entry. That is what lets the real app reuse this file
 * unchanged: it ships absolute URLs and an empty site root. See SEARCH_PLAN.md 8.2.
 * ========================================================================== */
(function () {
  'use strict';

  var INDEX = window.__OPSFLO_PAGE_INDEX__ || [];
  var SITE_ROOT = window.__OPSFLO_SITE_ROOT__ || '';

  // Must match generate_embeddings.js exactly, or the vectors aren't comparable.
  var MODEL = 'Xenova/all-MiniLM-L6-v2';

  // Absolute URL, not a relative string. import() treats a specifier that doesn't start
  // with "./", "../" or "/" as a BARE MODULE specifier and refuses to resolve it -- so
  // "assets/..." (which is what SITE_ROOT yields at the site root) fails, while
  // "../assets/..." (inside pages/) happens to work. That asymmetry would leave the
  // palette in keyword mode on exactly the two pages the demo opens on. Resolving
  // against document.baseURI once removes the whole class of problem, and also gives
  // ONNX unambiguous wasm/model paths.
  var VENDOR = new URL(SITE_ROOT + 'assets/frest/assets/vendor/libs/transformers/', document.baseURI).href;

  var MAX_RESULTS = 5;
  var DEBOUNCE_MS = 250;

  /* Hybrid ranking: cosine + a small lexical tiebreaker.
   *
   * Both constants were measured, not guessed (20-query set + 5 gibberish probes):
   *
   *   lexW   top-1   noise ceiling   weakest true positive
   *   0.00   18/20       0.195              0.212     <- pure semantic
   *   0.10   20/20       0.195              0.312     <- chosen
   *
   * Pure cosine ranked "who we work for" 3rd behind Account Managers, even though that
   * exact phrase is in Customer Master's text -- mean pooling dilutes a phrase across a
   * long string. The lexical term fixes that class of miss.
   *
   * The important property: gibberish has no lexical overlap, so LEX_WEIGHT cannot lift
   * the noise ceiling (0.195 at every weight). It only ever rewards true positives,
   * which is what opens the gap that makes MIN_SCORE safe.
   *
   * Semantic still dominates (cosine spans ~0.2-0.63); 0.10 is a tiebreaker, NOT a
   * keyword search wearing a trenchcoat. Raising it much further would make it one. */
  var LEX_WEIGHT = 0.10;
  var MIN_SCORE = 0.25; // sits between the 0.195 noise ceiling and the 0.312 weakest hit

  // Query words too common to signal intent. Without this, "who"/"what"/"my" quietly
  // hand lexical credit to any page whose text happens to contain them.
  var STOPWORDS = { the:1, a:1, an:1, is:1, are:1, was:1, were:1, for:1, of:1, to:1,
    in:1, on:1, my:1, our:1, we:1, i:1, do:1, does:1, did:1, what:1, who:1, where:1,
    how:1, much:1, next:1, me:1, show:1, find:1, get:1, all:1, and:1, it:1, be:1 };

  /* ----------------------------------------------------------- v1 filter rules
   * Keyword -> query param appended to the target URL. The target page reads it on
   * load and highlights matching rows (see applyDeepLink below).
   *
   * Values must match the status badges build_snapshots.py actually renders
   * (STATUSES: Active, Pending, Complete, Overdue, In Progress, On Hold).
   * Deliberately a rule table, not an LLM: it works offline and cannot embarrass us
   * live. Swapping in real NL extraction later is a one-function change. */
  var FILTER_RULES = [
    { re: /\b(overdue|late|past due|behind)\b/i, param: 'status', value: 'Overdue' },
    { re: /\b(pending|waiting|awaiting)\b/i, param: 'status', value: 'Pending' },
    { re: /\b(active|open|in progress|ongoing|current)\b/i, param: 'status', value: 'Active' },
    { re: /\b(complete|completed|done|finished|closed)\b/i, param: 'status', value: 'Complete' },
    { re: /\b(on hold|held|paused|stalled)\b/i, param: 'status', value: 'On Hold' }
  ];

  function ruleFor(query) {
    for (var i = 0; i < FILTER_RULES.length; i++) {
      if (FILTER_RULES[i].re.test(query)) return FILTER_RULES[i];
    }
    return null;
  }

  /* ------------------------------------------------------------------ scoring */

  // Corpus and query vectors are both L2-normalized, so cosine == dot product.
  function dot(a, b) {
    var s = 0;
    for (var i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  function haystack(entry) {
    if (!entry._hay) entry._hay = (entry.title + ' ' + entry.section + ' ' + entry.text).toLowerCase();
    return entry._hay;
  }

  // 0..1 lexical overlap. Exact phrase match wins outright; otherwise the fraction of
  // meaningful query words present. See LEX_WEIGHT for why this is small and safe.
  function lexical(entry, query) {
    var hay = haystack(entry);
    var norm = query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!norm) return 0;
    if (hay.indexOf(norm) !== -1) return 1;
    var words = norm.split(' ').filter(function (w) { return w.length > 2 && !STOPWORDS[w]; });
    if (!words.length) return 0;
    var hits = words.filter(function (w) { return hay.indexOf(w) !== -1; }).length;
    return hits / words.length;
  }

  function reEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // Prefix-anchored at a word boundary. \blate matches "late" but NOT "plate";
  // \bcertification still matches "certifications" (prefix, not whole-word).
  function hasWord(hay, w) { return new RegExp('\\b' + reEsc(w)).test(hay); }

  // Fallback when the model is unavailable (file://, blocked WASM, slow first load).
  // Not "AI", but it keeps the input honest instead of dead. Scores are scaled into a
  // rough 0..1 band so MIN_SCORE stays meaningful across both modes.
  //
  // MIRRORED in generate_embeddings.js for the example gate -- keep the two in sync, or
  // the gate stops testing what ships.
  /* Filler that never identifies a page. Used ONLY by keywordScore -- deliberately NOT
   * merged into STOPWORDS, which feeds lexical(), whose LEX_WEIGHT was measured against
   * today's exact word set. Verbs only: nouns are what is being searched FOR, and the
   * generic-looking ones are load-bearing in real titles ("setup" -> Facilities Setup,
   * "check"/"list" -> Check List Report, "module" -> Document Module Configuration). */
  var KW_FILLER = { add:1, new:1, edit:1, update:1, view:1, open:1, create:1, delete:1,
    remove:1, manage:1, see:1, go:1, need:1, want:1 };

  /* Crude singular/plural fold. hasWord's prefix anchoring is one-directional: a query
   * of "certification" matches hay "certifications", but "facility" does NOT match
   * "facilities" -- the shared prefix stops at "facilit". Linguistic correctness is not
   * the goal ("status" -> "statu"); CONSISTENCY is, since both sides use the same fold. */
  function stem(w) {
    return w.length > 3 ? w.replace(/ies$/, 'y').replace(/([^s])s$/, '$1') : w;
  }

  function wordsOf(s) { return s.match(/[a-z0-9#]+/g) || []; }

  function matchesWord(hayWords, qw) {
    var s = stem(qw);
    for (var i = 0; i < hayWords.length; i++) {
      if (hayWords[i].indexOf(qw) === 0 || stem(hayWords[i]) === s) return true;
    }
    return false;
  }

  function contentWords(q) {
    // Length > 2 drops "of"/"to" noise -- but NEVER drop a number. Check List Report 1-4
    // share identical sections, columns and `search` text; the trailing digit is the only
    // thing separating them.
    var all = q.split(/\s+/).filter(function (w) {
      return w.length > 2 || /^\d+$/.test(w);
    });
    var kept = all.filter(function (w) { return !KW_FILLER[w] && !STOPWORDS[w]; });
    return kept.length ? kept : all;   // "show all" is pure filler; score what was typed
  }

  /* Fallback ranking for when the model is unavailable (file://, blocked WASM, and the
   * cold-start window -- which on a DEPLOYED site is a 22MB model download, not the ~2s
   * it takes off local disk, so this lane is what most first-time visitors see).
   *
   * Scaled into a rough 0..1 band so MIN_SCORE stays meaningful across both modes. Safe
   * to tune with no re-measurement: fallback-only, and it never touches the semantic
   * path's measured LEX_WEIGHT / MIN_SCORE calibration.
   *
   * MIRRORED in ranking.js, which the build gate and eval harness use -- keep in sync,
   * or those stop testing what ships.
   *
   * Three properties the first version lacked, each measured on 492 real queries:
   *  - FILLER IS DROPPED. "add new customer" matched 1 of 3 words -> (1/3)*0.5 = 0.167,
   *    under MIN_SCORE, so the panel came back EMPTY. 95 of 492 queries died that way.
   *  - TITLE BEATS HAYSTACK. The old 0.5 cap squeezed every partial match into 0..0.5, so
   *    "customer certifications list" tied and broke by ID ORDER. A hay hit is cheap --
   *    `search` is a bag of synonyms by design; a title hit is the user naming the page.
   *  - COVERAGE BREAKS TIES. "maintenance" scored identically against Maintenance,
   *    Predictive Maintenance and Maintenance Due List. Naming a page's WHOLE title beats
   *    naming one word of a longer one.
   * Result: 62.8% -> 91.9% recall@1, empty panels 95 -> 10. */
  function keywordScore(entry, query) {
    var q = query.toLowerCase().trim();
    if (!q) return 0;
    var hay = haystack(entry);
    var title = entry.title.toLowerCase();

    // Identification tiers: unchanged, still the strongest evidence there is.
    if (title === q) return 1;
    if (title.indexOf(q) === 0) return 0.9;
    if (title.indexOf(q) !== -1) return 0.75;

    var words = contentWords(q);
    if (!words.length) return hay.indexOf(q) !== -1 ? 0.55 : 0;

    var titleW = wordsOf(title);
    var hayW = wordsOf(hay);
    var inTitle = words.filter(function (w) { return matchesWord(titleW, w); }).length / words.length;
    var inHay = words.filter(function (w) { return matchesWord(hayW, w); }).length / words.length;

    var titleWords = titleW.filter(function (w) { return w.length > 2; });
    var coverage = titleWords.length
      ? titleWords.filter(function (tw) {
          return words.some(function (qw) { return tw.indexOf(qw) === 0 || stem(tw) === stem(qw); });
        }).length / titleWords.length
      : 0;

    // Ceilings: a title-word match stays below the 0.9 title-prefix tier, and a hay-only
    // match reaches ~0.30 -- above MIN_SCORE so it still shows, but it can never outrank
    // a page the user actually partly named.
    var score = 0.50 * inTitle + 0.30 * inHay + 0.09 * coverage;
    // Exact phrase verbatim beats the same words scattered. As a bare floor this never
    // fired when word-matching already scored higher: "expired certifications" tied at
    // 0.595 between General Certifications (exact phrase in `search`) and Equipment
    // Certifications (both words, separately), and ID order picked Equipment.
    if (hay.indexOf(q) !== -1) score = Math.max(score, 0.55) + 0.08;
    return Math.min(score, 0.89);
  }

  /* ------------------------------------------------------------------ name lane
   * Deterministic, synchronous, model-free lookup over id + title + section. This is
   * what makes "1676", "payr" and "payroll" work instantly -- including in the ~2.1s
   * before the model is ready, and forever under file://.
   *
   * These scores are a TIER LADDER IN THEIR OWN NAMESPACE. They are NOT cosine. They
   * must never be added to a cosine and never compared against MIN_SCORE. See mergeLanes.
   *
   * Note the id is deliberately NOT in the embedded text nor in _hay: mean pooling would
   * shred "1676" into contentless subwords and dilute every other token in the vector,
   * and touching _hay would silently move the measured LEX_WEIGHT. A string compare gets
   * this right 100% of the time; an embedding cannot promise that. */
  var NAME_PIN_MAX = 3;    // names take at most 3 of MAX_RESULTS; 2 always left for meaning
  var PIN_TIER = 0.80;     // at/above this the user NAMED a page; below is mere evidence
  var AMBIG_MAX = 6;       // a tier matching more pages than this has identified nothing

  // Both sides must normalise identically, or "Warehouse / Yard Address" can never be
  // found by "warehouse yard", nor "Deployments / Arrivals" by "deployments arrivals".
  function norm(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Cached like haystack(), but DELIBERATELY separate from _hay: _hay feeds lexical(),
  // whose weight was measured against today's exact field set.
  function nameFields(e) {
    if (!e._nm) {
      var t = norm(e.title);
      e._nm = { id: norm(e.id), title: t, words: t.split(' '), section: norm(e.section) };
    }
    return e._nm;
  }

  // "inv rep" -> ERP Inventory Report: every query word must prefix a distinct title
  // word, in order.
  function wordPrefixes(words, qs) {
    var w = 0;
    for (var i = 0; i < qs.length; i++) {
      while (w < words.length && words[w].indexOf(qs[i]) !== 0) w++;
      if (w >= words.length) return false;
      w++;
    }
    return true;
  }

  function nameTier(e, q) {
    if (!q) return 0;
    var f = nameFields(e);
    /* --- identification: the user named a specific page (>= PIN_TIER) --- */
    if (f.id === q) return 1.00;                                  // "1676"    -> Payroll
    if (f.title === q) return 0.98;                               // "payroll" -> Payroll
    if (q.length >= 2) {                                          // 1 char identifies nothing
      if (f.id.indexOf(q) === 0) return 0.92;                     // "159"     -> the 1590 family
      if (f.title.indexOf(q) === 0) return 0.90;                  // "payr"    -> Payroll
      var qs = q.split(' ');
      if (qs.length > 1 && wordPrefixes(f.words, qs)) return 0.85; // "inv rep" -> ERP Inventory Report
    }
    /* --- evidence only: real, but not an identification (< PIN_TIER).
     * "report" lands here on 6 pages -- exactly the flood case pinnedNames() rejects. */
    if (f.title.indexOf(' ' + q) !== -1) return 0.70;             // word-boundary contains
    if (f.title.indexOf(q) !== -1) return 0.60;                   // "cert" in "certifications"
    if (f.section === q) return 0.50;                             // "safety"
    if (f.section.indexOf(q) === 0) return 0.40;                  // "report" -> Reports section
    return 0;
  }

  function nameHits(query) {
    var q = norm(query);
    if (!q) return [];
    var hits = [];
    for (var i = 0; i < INDEX.length; i++) {
      var t = nameTier(INDEX[i], q);
      if (t > 0) hits.push({ entry: INDEX[i], tier: t });
    }
    return hits.sort(function (a, b) { return b.tier - a.tier; });
  }

  /* Which name hits earn a pinned slot. Two gates, both load-bearing:
   *
   *  PIN_TIER  -- a substring is not an identification. "report" matches 6 titles at
   *               0.70; pinning 3 of them would evict the semantic answer in favour of
   *               an arbitrary 3-of-6. So contains/section tiers never pin, and the
   *               meaning lane -- which is good at "report" -- keeps the query.
   *
   *  AMBIG_MAX -- a tier matching a sixth of the corpus has identified nothing. "16"
   *               id-prefixes 10 pages; pinning 1600/1601/1602 is worse than pinning
   *               nothing. Demote the whole set rather than an arbitrary head of it. */
  function pinnedNames(hits) {
    var top = hits.filter(function (h) { return h.tier >= PIN_TIER; });
    if (!top.length || top.length > AMBIG_MAX) return [];
    return top.slice(0, NAME_PIN_MAX);
  }

  /* -------------------------------------------------------------- model loader
   * Isolated behind one function on purpose (SEARCH_PLAN.md 1): swapping this for a
   * hosted embeddings API later touches nothing else. */
  var embedder = null;
  var modelState = 'idle'; // idle | loading | ready | failed

  function loadModel() {
    if (modelState !== 'idle') return;
    modelState = 'loading';
    // Dynamic import: transformers.min.js is an ES module; this file is not. Under
    // file:// this rejects (CORS), which is exactly how we land in keyword mode.
    import(VENDOR + 'transformers.min.js')
      .then(function (t) {
        // Fully local: never phone home to the HF CDN. This is the whole point of
        // vendoring -- shipping the JS but streaming the model would defeat it.
        t.env.allowRemoteModels = false;
        t.env.localModelPath = VENDOR + 'models/';
        t.env.backends.onnx.wasm.wasmPaths = VENDOR;
        // Threaded ORT needs cross-origin isolation (COOP/COEP), which a plain static
        // server doesn't send. Pin to 1 so it loads the non-threaded SIMD binary.
        t.env.backends.onnx.wasm.numThreads = 1;
        return t.pipeline('feature-extraction', MODEL, { quantized: true });
      })
      .then(function (p) {
        embedder = p;
        modelState = 'ready';
        setStatus(INDEX.length + ' pages · semantic search ready');
        // Re-run whatever is already typed, now that we can do it properly.
        if (input && input.value.trim()) run(input.value);
      })
      .catch(function (err) {
        modelState = 'failed';
        console.warn('[command-palette] semantic model unavailable, using keyword search.', err);
        setStatus(INDEX.length + ' pages · keyword search');
      });
  }

  function embed(text) {
    return embedder(text, { pooling: 'mean', normalize: true }).then(function (o) {
      return Array.from(o.data);
    });
  }

  /* ------------------------------------------------------------------- search */

  /* -------------------------------------------------------------------- merging
   * RANK-MERGE, NOT SCORE-MERGE. Do not "simplify" this into an addition.
   *
   * Name tiers (0.40-1.00) and cosine (~0.20-0.63) are different scales measuring
   * different things. MIN_SCORE = 0.25 is not a general confidence threshold -- it is a
   * measured property of `dot + 0.10*lexical` specifically, sitting between that
   * formula's 0.195 noise ceiling and its 0.312 weakest true positive. Adding a name
   * tier to a cosine, or filtering name hits through MIN_SCORE, destroys the only thing
   * those numbers mean.
   *
   * So the meaning lane below is left exactly as it was, gate included, and names are
   * layered ON TOP by POSITION. No arithmetic ever crosses the two lanes -- which is why
   * this change needed no re-measurement. */
  function mergeLanes(pins, semantic) {
    var out = [], seen = {}, i;
    for (i = 0; i < pins.length; i++) {
      out.push({ entry: pins[i].entry, score: pins[i].tier, name: true });
      seen[pins[i].entry.id] = 1;
    }
    // Both lanes found the same page: the pin wins. Deterministic evidence outranks a
    // cosine, and the row keeps a stable rank instead of jumping when the model resolves.
    for (i = 0; i < semantic.length && out.length < MAX_RESULTS; i++) {
      if (seen[semantic[i].entry.id]) continue;
      out.push(semantic[i]);
    }
    return out;
  }

  function semanticLane(qv, query) {
    return INDEX
      .map(function (e) {
        return { entry: e, score: dot(qv, e.vector) + LEX_WEIGHT * lexical(e, query) };
      })
      .filter(function (r) { return r.score >= MIN_SCORE; })   // the measured gate. UNTOUCHED.
      .sort(function (a, b) { return b.score - a.score; });
    // No .slice() here on purpose: dedupe against the pins happens afterwards, so
    // slicing first would silently under-fill the panel when the lanes overlap.
    // mergeLanes() does the capping. 41 entries -- the cost is nil.
  }

  function keywordLane(query) {
    return INDEX
      .map(function (e) { return { entry: e, score: keywordScore(e, query) }; })
      .filter(function (r) { return r.score >= MIN_SCORE; })
      .sort(function (a, b) { return b.score - a.score; });
  }

  function rank(query) {
    var pins = pinnedNames(nameHits(query));   // sync + model-free, in BOTH branches
    if (modelState === 'ready') {
      return embed(query).then(function (qv) { return mergeLanes(pins, semanticLane(qv, query)); });
    }
    return Promise.resolve(mergeLanes(pins, keywordLane(query)));
  }

  // Each row carries its OWN resolved rule: a recent's chip comes from what was stored,
  // not from the live query (which is empty on the suggestion screen).
  function urlFor(entry, rule) {
    var url = SITE_ROOT + entry.url;
    if (rule) url += (url.indexOf('?') === -1 ? '?' : '&') + rule.param + '=' + encodeURIComponent(rule.value);
    return url;
  }

  function targetUrl(entry, query) { return urlFor(entry, ruleFor(query)); }

  /* ------------------------------------------------------------------- recents
   * Stores page IDs, never query text. Four reasons:
   *  1. Presentation-safe -- query text is arbitrary (rehearsal typos, half-typed words);
   *     titles come from the curated PAGES dict, so a leaked list reads as intentional.
   *  2. Portable -- URL shape differs per environment; a stored url would strand broken
   *     links across the port to the real app. An id can't.
   *  3. Permission-safe in production for free -- hydration is byId(); an id the user has
   *     no grant for simply fails to hydrate and drops out. The filter IS the check.
   *  4. Correct -- palettes show recent DESTINATIONS. Teaching NL is 'Try asking's job. */
  var RECENTS_MAX = 5;    // stored
  var RECENTS_SHOW = 3;   // rendered -- the nav-zone budget

  // Namespaced now, not later: localStorage is per-BROWSER, so on a shared production
  // workstation two users would otherwise share recents. Retrofitting means migrating
  // live keys.
  function recentsKey() {
    return 'opsflo-recents:' + (window.__OPSFLO_USER_KEY__ || 'demo');
  }

  // The seam: production may emit server-side recents instead. One function changes.
  function readRecents() {
    if (window.__OPSFLO_RECENTS__) return window.__OPSFLO_RECENTS__;
    try {
      var raw = JSON.parse(localStorage.getItem(recentsKey()) || 'null');
      if (!raw || raw.v !== 1 || !Object.prototype.toString.call(raw.items).match(/Array/)) return [];
      return raw.items;
    } catch (e) { return []; }   // quota / private mode / corrupt -> silently no recents
  }

  function remember(entry, rule) {
    if (!entry || !entry.id) return;
    var items = readRecents().filter(function (r) { return r.id !== entry.id; });  // dedupe
    var rec = { id: entry.id, t: Date.now() };
    if (rule) { rec.p = rule.param; rec.v = rule.value; }   // last intent wins
    items.unshift(rec);                                     // LRU: newest first
    try {
      localStorage.setItem(recentsKey(), JSON.stringify({ v: 1, items: items.slice(0, RECENTS_MAX) }));
    } catch (e) {}                                          // never throw on navigate
  }

  var BY_ID = null;
  function byId(id) {
    if (!BY_ID) { BY_ID = {}; INDEX.forEach(function (e) { BY_ID[e.id] = e; }); }
    return BY_ID[id];
  }

  /* --------------------------------------------------------------- suggestions
   * Empty state and zero-results share ONE code path. Always tops up to NAV_SLOTS nav
   * rows, so a fresh machine (no recents) and a used one look identical -- and so does a
   * machine where localStorage threw. The fallback path and the failure path are the same. */
  var NAV_SLOTS = 3;

  function suggestionRows() {
    var SUGGEST = window.__OPSFLO_SUGGESTIONS__ || {};
    var rows = [], seen = {}, nav = 0;

    // 1. Try asking -- curated, build-verified in BOTH ranking modes.
    (SUGGEST.examples || []).forEach(function (x) {
      // Self-guard: drop an example whose page isn't in THIS index. Free in the demo
      // (catches a deleted page); load-bearing in production, where the index is
      // per-user filtered and an example could point at an ungranted page.
      if (x.expect && !byId(x.expect)) return;
      rows.push({ kind: 'query', group: 'Try asking', q: x.q, entry: { title: x.q, section: null } });
    });

    // 2. Recent -- unknown ids drop out; that filter IS the production permission check.
    readRecents().forEach(function (r) {
      if (nav >= NAV_SLOTS) return;
      var e = byId(r.id);
      if (!e || seen[e.id]) return;
      seen[e.id] = 1; nav++;
      rows.push({ kind: 'page', group: 'Recent', entry: e,
                  rule: r.p ? { param: r.p, value: r.v } : null });
    });

    // 3. Jump to -- curated defaults top the nav zone back up to NAV_SLOTS.
    (SUGGEST.defaults || []).forEach(function (id) {
      if (nav >= NAV_SLOTS) return;
      var e = byId(id);
      if (!e || seen[id]) return;
      seen[id] = 1; nav++;
      rows.push({ kind: 'page', group: 'Jump to', entry: e, rule: null });
    });

    return rows;
  }

  /* ---------------------------------------------------------------------- DOM */

  var root, toggle, menu, input, resultsEl, statusEl, micBtn;
  // rows: [{ kind:'page'|'query', group:string|null, entry, score, rule, q, name }]
  // ONE flat array, headers derived at render time. That keeps data-i, move() and go()
  // working unchanged over a grouped list -- the keyboard path must never break.
  var rows = [];
  var active = -1;
  var timer = null;
  var seq = 0; // guards against a slow embed resolving after a newer keystroke
  var lastQuery = '';

  /* --------------------------------------------------------------- A/B: style
   * 'badge'   -> flat list; name hits show the page ID, AI hits show a similarity score
   * 'grouped' -> the same, PLUS "PAGES" / "BEST MATCHES" headers on search results
   * (Suggestions always group -- this only affects search results.)
   *
   * TEMPORARY scaffolding so both can be compared live. Once one is chosen, delete the
   * other and this switch: a permanent style toggle is cruft.
   *   __opsfloPaletteStyle('grouped')   console, persists + re-renders
   *   ?palette=grouped                  URL param, for a side-by-side */
  var style = 'badge';
  (function initStyle() {
    var m = /[?&]palette=(badge|grouped)/.exec(window.location.search);
    if (m) { style = m[1]; return; }
    try { style = localStorage.getItem('opsflo-palette-style') || 'badge'; } catch (e) {}
    if (style !== 'badge' && style !== 'grouped') style = 'badge';
  })();
  window.__opsfloPaletteStyle = function (s) {
    if (s !== 'badge' && s !== 'grouped') return 'usage: __opsfloPaletteStyle("badge"|"grouped")';
    style = s;
    try { localStorage.setItem('opsflo-palette-style', s); } catch (e) {}
    if (input) run(input.value);
    return 'palette style = ' + s;
  };
  window.__opsfloClearRecents = function () {
    try { localStorage.removeItem(recentsKey()); } catch (e) {}
    if (input && !input.value.trim()) run('');
    return 'recents cleared';
  };

  function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // `zeroQuery` is the failed query string when nothing matched, else null.
  function render(zeroQuery) {
    var html = '', prev = null;

    if (zeroQuery) {
      html += '<div class="cmdp-empty"><i class="bx bx-search-alt"></i><span>No page matches &ldquo;' +
              esc(zeroQuery) + '&rdquo; &mdash; try one of these:</span></div>';
    }

    html += rows.map(function (r, i) {
      var head = '';
      if (r.group && r.group !== prev) head = '<div class="cmdp-group">' + esc(r.group) + '</div>';
      prev = r.group;
      var isQ = r.kind === 'query';

      // Right-hand slot. A name hit must NOT show a similarity score: Math.round(1.00*100)
      // renders "100" beside a semantic "34", which is meaningless AND undercuts what the
      // score is there to prove ("this is ranked semantic matching, not a substring
      // filter") -- because a name hit IS a substring filter. Show the page ID instead;
      // it doubles as a hint that IDs are searchable.
      var right = '';
      if (r.name) right = '<span class="cmdp-badge">' + esc(r.entry.id) + '</span>';
      else if (r.score != null) right = '<span class="cmdp-score">' + Math.round(r.score * 100) + '</span>';

      var icon = isQ ? 'bx-bulb' : (r.name ? 'bx-hash' : 'bx-file');

      return head +
        '<a class="cmdp-item' + (isQ ? ' cmdp-item-q' : '') + (i === active ? ' active' : '') +
           '" href="' + (isQ ? 'javascript:void(0);' : esc(urlFor(r.entry, r.rule))) + '" data-i="' + i + '">' +
          '<i class="bx ' + icon + ' cmdp-item-ico"></i>' +
          '<span class="cmdp-item-body">' +
            '<span class="cmdp-item-title">' + esc(r.entry.title) + '</span>' +
            (r.entry.section
              ? '<span class="cmdp-item-sub">' + esc(r.entry.section) +
                (r.rule ? ' <span class="cmdp-chip">' + esc(r.rule.value) + '</span>' : '') + '</span>'
              : '') +
            // What the page is for, so the user can choose between two plausible titles
            // without opening both. Suggestion rows (kind === 'query') have no entry to
            // describe, and desc is absent on any index built before it existed -- both
            // just render without the line rather than an empty one.
            (!isQ && r.entry.desc
              ? '<span class="cmdp-item-desc">' + esc(r.entry.desc) + '</span>'
              : '') +
          '</span>' +
          right +
        '</a>';
    }).join('');

    resultsEl.innerHTML = html;
  }

  // Turn ranked results into rows. In 'grouped' style the two lanes get headers.
  function resultRows(ranked, query) {
    var rule = ruleFor(query);
    return ranked.map(function (r) {
      r.kind = 'page';
      r.rule = rule;
      r.group = (style === 'grouped') ? (r.name ? 'Pages' : 'Best matches') : null;
      return r;
    });
  }

  function showSuggestions(zeroQuery) {
    rows = suggestionRows();
    active = rows.length ? 0 : -1;   // panel looks alive; Ctrl+K then Enter runs an example
    render(zeroQuery || null);
  }

  function run(query) {
    var mine = ++seq;
    lastQuery = query;
    if (!query.trim()) { showSuggestions(null); return; }
    rank(query).then(function (r) {
      if (mine !== seq) return; // a newer query state exists
      if (!r.length) { showSuggestions(query); return; }
      // Don't yank the selection from someone who already arrowed down during the
      // instant preview -- only reset when the row under the cursor actually changed.
      var keep = active >= 0 && rows[active] && r[active] &&
                 r[active].entry && rows[active].entry &&
                 r[active].entry.id === rows[active].entry.id;
      rows = resultRows(r, query);
      if (!keep) active = rows.length ? 0 : -1;
      render(null);
    });
  }

  /* Instant lane: 0ms, synchronous, model-free, no debounce.
   *
   * Renders ONLY pinned name hits -- by construction the exact set, order and ranks that
   * mergeLanes() will pin again when the embed resolves. That invariant is what makes
   * this progressive disclosure rather than flicker: nothing on screen moves, semantic
   * rows only ever APPEND below. (Panel order is input -> results -> foot, so the input
   * never shifts either.)
   *
   * Without this, typing "1676" and pressing Enter at t=80ms navigates nowhere. The 250ms
   * debounce exists to avoid firing a transformer per keystroke; debouncing a string
   * compare behind it is indefensible. */
  function preview(query) {
    // LOAD-BEARING. seq means "a newer query state exists", and this IS a newer state.
    // Without it: type "payr" -> debounce fires -> run("payr") takes mine=seq=1 and starts
    // a ~40ms embed -> user types "o" -> preview("payro") renders -> stale run("payr")
    // resolves and checks mine !== seq, but seq is STILL 1 because "payro"'s debounce
    // hasn't fired. The guard passes and stale results clobber the fresh render.
    ++seq;
    lastQuery = query;
    if (!query.trim()) { showSuggestions(null); return; }
    var pins = pinnedNames(nameHits(query));
    if (!pins.length) return;   // nothing certain to say -- leave the panel as it is
    rows = resultRows(mergeLanes(pins, []), query);
    if (active < 0 || active >= rows.length) active = 0;
    render(null);
  }

  function open() {
    root.classList.add('show');
    menu.classList.add('show');
    input.focus();
    input.select();
    if (modelState === 'idle') loadModel();
    run(input.value);   // always re-derive: previously this left stale results on reopen
  }

  function close() {
    root.classList.remove('show');
    menu.classList.remove('show');
    input.blur();
  }

  function isOpen() { return menu.classList.contains('show'); }

  // Move the highlight by toggling two classes rather than re-rendering. innerHTML
  // replacement between mousedown and mouseup can swallow the click -- and now that the
  // empty state is clickable, that surface is much bigger than it was.
  function setActive(i) {
    if (i === active) return;
    var els = resultsEl.querySelectorAll('.cmdp-item');
    if (els[active]) els[active].classList.remove('active');
    if (els[i]) els[i].classList.add('active');
    active = i;
  }

  function move(delta) {
    if (!rows.length) return;
    var next = active;
    // Skip nothing today (every row is selectable), but wrap safely regardless.
    next = (next + delta + rows.length) % rows.length;
    setActive(next);
    var el = resultsEl.querySelector('.cmdp-item.active');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  function go() {
    var row = rows[active];
    if (!row) return;
    if (row.kind === 'query') {   // example chip: fill and run, never navigate
      input.value = row.q;
      run(row.q);
      return;
    }
    remember(row.entry, row.rule);
    window.location.href = urlFor(row.entry, row.rule);
  }

  /* --------------------------------------------------------------- v2: voice */

  function initVoice() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    // Feature-detect and stay hidden where unsupported. Also needs a secure context
    // (https or localhost) -- Start Demo.bat satisfies this; file:// does not.
    if (!SR || !window.isSecureContext) return;
    micBtn.hidden = false;

    var rec = new SR();
    rec.lang = 'en-US';
    rec.interimResults = true;
    rec.continuous = false;
    var listening = false;

    rec.onresult = function (e) {
      var text = '';
      for (var i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      input.value = text;
      run(text); // identical pipeline to typing -- no separate logic
    };
    rec.onerror = function (e) {
      console.warn('[command-palette] speech recognition error:', e.error);
      setStatus(e.error === 'not-allowed' ? 'Microphone blocked' : 'Voice input failed');
    };
    rec.onend = function () { listening = false; micBtn.classList.remove('listening'); };

    micBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (listening) { rec.stop(); return; }
      try {
        rec.start();
        listening = true;
        micBtn.classList.add('listening');
        setStatus('Listening&hellip;');
      } catch (err) { console.warn('[command-palette]', err); }
    });
  }

  /* ------------------------------------------- v1: deep-link highlight on load
   * The honest version of "it filtered for me" on a static site: the rows are already
   * rendered with fake data and there is no backend, so this highlights/filters what
   * is on the page. Demo-only -- the real app's Kendo grids filter server-side, so
   * this does NOT port (SEARCH_PLAN.md 8.3). */
  function applyDeepLink() {
    var m = /[?&]status=([^&]+)/.exec(window.location.search);
    if (!m) return;
    var want = decodeURIComponent(m[1]).toLowerCase();
    var rows = document.querySelectorAll('.card-datatable tbody tr');
    if (!rows.length) return;

    var matched = 0;
    Array.prototype.forEach.call(rows, function (tr) {
      var badge = tr.querySelector('.badge');
      var hit = badge && badge.textContent.trim().toLowerCase() === want;
      tr.classList.toggle('cmdp-row-hit', !!hit);
      tr.classList.toggle('cmdp-row-dim', !hit);
      if (hit) matched++;
    });
    if (!matched) return;

    var table = document.querySelector('.card-datatable');
    if (!table) return;
    var note = document.createElement('div');
    note.className = 'cmdp-filter-note';
    note.innerHTML =
      '<i class="bx bx-filter-alt"></i><span>Showing <strong>' + matched + '</strong> ' +
      esc(decodeURIComponent(m[1])) + ' of ' + rows.length + ' rows</span>' +
      '<button type="button" class="cmdp-filter-clear">Clear</button>';
    table.parentNode.insertBefore(note, table);
    note.querySelector('.cmdp-filter-clear').addEventListener('click', function () {
      Array.prototype.forEach.call(rows, function (tr) {
        tr.classList.remove('cmdp-row-hit', 'cmdp-row-dim');
      });
      note.remove();
      history.replaceState(null, '', window.location.pathname);
    });
  }

  /* ----------------------------------------------------------------- bootstrap */

  function init() {
    root = document.getElementById('cmdPalette');
    if (!root) return;
    toggle = document.getElementById('cmdPaletteToggle');
    menu = document.getElementById('cmdPaletteMenu');
    input = document.getElementById('cmdPaletteInput');
    resultsEl = document.getElementById('cmdPaletteResults');
    statusEl = document.getElementById('cmdPaletteStatus');
    micBtn = document.getElementById('cmdPaletteMic');

    if (!INDEX.length) {
      setStatus('Search index missing — run: node generate_embeddings.js');
      console.error('[command-palette] window.__OPSFLO_PAGE_INDEX__ is empty. Did assets/data/page-index.js load?');
      return;
    }
    setStatus(INDEX.length + ' pages · loading model…');

    toggle.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      isOpen() ? close() : open();
    });

    input.addEventListener('input', function () {
      var q = input.value;
      preview(q);                                                // instant, deterministic
      clearTimeout(timer);
      timer = setTimeout(function () { run(q); }, DEBOUNCE_MS);  // meaning fills in
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); go(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });

    // Delegated so it survives re-render. setActive (not render) -- see its comment.
    resultsEl.addEventListener('mousemove', function (e) {
      var item = e.target.closest ? e.target.closest('.cmdp-item') : null;
      if (!item) return;
      setActive(+item.getAttribute('data-i'));
    });

    resultsEl.addEventListener('click', function (e) {
      var el = e.target.closest ? e.target.closest('.cmdp-item') : null;
      if (!el) return;
      var row = rows[+el.getAttribute('data-i')];
      if (!row) return;
      if (row.kind === 'query') {   // example chip: fill the input and run it
        e.preventDefault();
        input.value = row.q;
        run(row.q);
        input.focus();
        return;
      }
      // Deliberately NO preventDefault: let the <a href> navigate natively so ctrl+click,
      // open-in-new-tab and the status-bar URL preview all keep working.
      // localStorage.setItem is synchronous, so this completes before unload begins.
      remember(row.entry, row.rule);
    });

    // Close on a click outside the palette.
    //
    // composedPath(), NOT root.contains(e.target). The path is computed at dispatch time
    // and survives the node being removed; `contains` does not. Clicking a suggestion
    // re-renders the list from run()'s promise during the microtask checkpoint between
    // listeners, which DETACHES the clicked node -- so by the time this handler ran,
    // root.contains(target) was false and the palette closed itself on its own click.
    // (Symptom: clicking an example query filled the input and ran the search into a
    // panel that had already slammed shut.)
    document.addEventListener('click', function (e) {
      if (!isOpen()) return;
      var path = e.composedPath ? e.composedPath() : null;
      var inside = path ? path.indexOf(root) !== -1 : root.contains(e.target);
      if (!inside) close();
    });

    // Ctrl+K / Cmd+K from anywhere on the page.
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault(); // beat Chrome's default
        isOpen() ? close() : open();
      }
    });

    initVoice();

    // Preload silently, before anyone types. This is what keeps the first live query
    // from stalling in front of an audience (SEARCH_PLAN.md 1).
    if ('requestIdleCallback' in window) requestIdleCallback(loadModel, { timeout: 2000 });
    else setTimeout(loadModel, 300);
  }

  function boot() { init(); applyDeepLink(); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
