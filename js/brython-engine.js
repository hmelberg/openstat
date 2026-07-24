// js/brython-engine.js — lightweight Python engine (Brython) for openstat/safestat.
// Design: docs/superpowers/specs/2026-07-10-brython-engine-design.md
// Lazy libs: docs/superpowers/plans/2026-07-11-brython-lazy-registration.md
//
// Loads Brython 3.12 core+stdlib from CDN, compiles brython_runner.py once via
// __BRYTHON__.runPythonSource, and exposes run(). Python libraries are NOT
// loaded up front: before each run, scanImports() finds which LIB_REGISTRY
// libraries the user's code mentions and ensureLibs() fetches and registers
// only those — via the runner's _register_module(), which execs the source
// into a fresh module object and inserts it in sys.modules. External JS
// dependencies (e.g. a stats lib backing a wrapper module) are declared per
// library in LIB_REGISTRY and loaded on first use only.
//
// This replaces the original text/python script-tag mechanism and with it the
// MutationObserver race it required (tags had to be registered before
// brython() ran; the full analysis lives in git history of this file).
//
// Verified against the actual jsdelivr brython@3.12.0 bundle:
//   - brython() is called with NO arguments; its options object only reads
//     debug/args/breakpoint/indexedDB/python_extension — nothing else exists.
//   - __BRYTHON__.runPythonSource(source, script_id) takes the module name as
//     its second argument (compile-unit name; auto-generated only when the
//     argument is literally undefined).
//
// Output is embed-marker text; index.html renders it via buildOutputNodes().
(function (global) {
  'use strict';

  var BRYTHON_CORE = 'https://cdn.jsdelivr.net/npm/brython@3.12.0/brython.min.js';
  var BRYTHON_STDLIB = 'https://cdn.jsdelivr.net/npm/brython@3.12.0/brython_stdlib.js';

  // Library registry — single source of truth for lazily loaded Python libs.
  // Key = canonical module name (== brython/<key>.py).
  //   aliases: extra import names resolving to the same module.
  //   deps:    registry keys that must be registered first (module-level imports).
  //   js:      external JS scripts loaded (once) before the module registers;
  //            skipped when window[<global>] already exists.
  var LIB_REGISTRY = {
    // pandas_brython.py:15 har en modulnivå try-import av plotly (df.plot);
    // uten deps-oppføringen feiler den stille ved lazy registrering.
    pandas_brython:         { aliases: [], deps: ['plotly_express_brython'], js: [] },
    plotly_express_brython: { aliases: [], deps: [], js: [] },
    // aliasrekkefølgen er bindende: 'matplotlib' (plain) må registreres før
    // den dottede 'matplotlib.pyplot' (trenger forelderen i sys.modules)
    matplotlib_brython:     { aliases: ['matplotlib', 'matplotlib.pyplot'],
                              deps: ['plotly_express_brython'], js: [] },
    // aliasrekkefølgen bindende her også: 'scipy' før 'scipy.stats'
    scipy_stats_brython:    { aliases: ['scipy', 'scipy.stats'],
                              deps: [], js: [] },
    // tre alias-nivåer — rekkefølgen bindende (forelder før barn)
    statsmodels_brython:    { aliases: ['statsmodels', 'statsmodels.formula',
                                        'statsmodels.formula.api'],
                              deps: ['scipy_stats_brython'], js: [] },
    numpy_brython:          { aliases: ['numpy'], deps: [], js: [] },
    seaborn_brython:        { aliases: ['seaborn'],
                              deps: ['matplotlib_brython', 'plotly_express_brython'], js: [] },
    // async-bro med replay — se beginDuckBridge()/run(); pandas for .df()
    duckdb_brython:         { aliases: ['duckdb'],
                              deps: ['pandas_brython'], js: [] },
    // flat modul + namespace-objekter; dottede aliaser krever 'sklearn' først
    sklearn_brython:        { aliases: ['sklearn', 'sklearn.model_selection',
                                        'sklearn.preprocessing', 'sklearn.linear_model',
                                        'sklearn.cluster', 'sklearn.decomposition',
                                        'sklearn.neighbors', 'sklearn.metrics'],
                              deps: ['numpy_brython'], js: [] },
    // ui_brython.py/ui.py (W2): filnavnet skiller seg fra det offentlige
    // importnavnet (samme mønster som numpy_brython/numpy), løst via alias.
    // js/ui.js er allerede script-tag-lastet i index.html for notatbok-siden
    // (window.Ui finnes derfor typisk allerede) — loadJsDep() over hopper
    // allerede over enhver url der window[global] finnes, så denne
    // oppføringen kan ALDRI dobbel-kjøre IIFE-en og nullstille Ui-tilstand.
    // deps: ['ui_core'] — fase 3: ui_brython.py importerer selv
    // shared/ui_core.py (dedup pyodide/brython/micropython), må derfor
    // registreres FØR ui_brython selv (deps kjøres først, se ensureLibs).
    ui_brython:             { aliases: ['ui'], deps: ['ui_core'],
                              js: [{ url: 'js/ui.js', global: 'Ui' }] },
    // fase 3 (spec 2026-07-20): delt fasadekjerne — én fil for alle tre
    // python-runtimene; path-feltet overstyrer katalogkonvensjonen.
    ui_core:                { aliases: [], deps: [], js: [],
                              path: 'shared/ui_core.py' },
    // altair (spec 2026-07-23): delt dialektfri kjerne i shared/ — samme
    // path-overstyring som ui_core. Vega-stakken lastes lazy ved
    // `import altair`; rekkefølgen er bindende (vega -> vega-lite ->
    // vega-embed), lasteren går sekvensielt gjennom js-listen.
    altair_brython:         { aliases: ['altair'], deps: ['altair_core'],
                              js: [
      { url: 'https://cdn.jsdelivr.net/npm/vega@5.30.0/build/vega.min.js', global: 'vega' },
      { url: 'https://cdn.jsdelivr.net/npm/vega-lite@5.21.0/build/vega-lite.min.js', global: 'vegaLite' },
      { url: 'https://cdn.jsdelivr.net/npm/vega-embed@6.26.0/build/vega-embed.min.js', global: 'vegaEmbed' }
                              ] },
    altair_core:            { aliases: [], deps: [], js: [],
                              path: 'shared/altair_core.py' },
    // folium (spec 2026-07-24): samme mønster som altair — delt kjerne i
    // shared/, Leaflet lastes lazy ved `import folium` (CSS-en er statisk
    // i index.html-head, Tabulator-presedensen).
    folium_brython:         { aliases: ['folium'], deps: ['folium_core'],
                              js: [
      { url: 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.min.js', global: 'L' }
                              ] },
    folium_core:            { aliases: [], deps: [], js: [],
                              path: 'shared/folium_core.py' },
    // lifelines (spec 2026-07-24): ren beregning — ingen js-deps; plott
    // gjenbruker plotly-shimet (deps sørger for rekkefølgen). Dotted
    // alias-rekkefølge bindende (statsmodels-presedensen).
    lifelines_brython:      { aliases: ['lifelines', 'lifelines.statistics'],
                              deps: ['lifelines_core', 'plotly_express_brython',
                                     'pandas_brython'], js: [] },
    lifelines_core:         { aliases: [], deps: [], js: [],
                              path: 'shared/lifelines_core.py' },
    // tabulator (spec 2026-07-24): interaktive tabeller — ingen js-deps
    // (Tabulator 6.3.1 er statisk lastet i index.html-head).
    tabulator_brython:      { aliases: ['tabulator'], deps: ['tabulator_core'], js: [] },
    tabulator_core:         { aliases: [], deps: [], js: [],
                              path: 'shared/tabulator_core.py' }
  };

  function scanImports(code) {
    // Find registry libraries mentioned in import statements. Over-matching
    // (imports inside strings/docstrings) is harmless — it only registers a
    // library the code never uses. Dotted names count by their first segment.
    // Under-matches: one-line compounds (`if x: import y`), semicolon-glued
    // imports and dynamic imports (__import__) — failure mode is a loud
    // ModuleNotFoundError, never silent wrong output.
    var needed = [];
    function add(rawName) {
      var name = rawName.split('.')[0];
      var canonical = LIB_REGISTRY.hasOwnProperty(name) ? name : null;
      if (!canonical) {
        for (var k in LIB_REGISTRY) {
          if (LIB_REGISTRY[k].aliases.indexOf(name) !== -1) { canonical = k; break; }
        }
      }
      if (canonical && needed.indexOf(canonical) === -1) needed.push(canonical);
    }
    var re = /^[ \t]*(?:from[ \t]+([A-Za-z_][A-Za-z0-9_.]*)|import[ \t]+([^#\r\n]+))/gm;
    var m, parts, i, t;
    while ((m = re.exec(code))) {
      if (m[1]) { add(m[1]); continue; }
      parts = m[2].split(',');
      for (i = 0; i < parts.length; i++) {
        t = parts[i].trim().split(/[ \t]/)[0];   // drop "as <alias>"
        if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(t)) add(t);
      }
    }
    return needed;
  }

  var __registered = {};   // canonical name -> true once registered in the runner
  var __jsLoaded = {};     // url -> load promise (shared across libs)

  function loadJsDep(dep) {
    if (global[dep.global]) return Promise.resolve();   // already on the page
    if (!__jsLoaded[dep.url]) {
      __jsLoaded[dep.url] = addScript(dep.url).catch(function (e) {
        delete __jsLoaded[dep.url];                     // ikke cache feil — prøv igjen neste run
        throw e;
      });
    }
    return __jsLoaded[dep.url];
  }

  async function ensureLibs(mod, names, _visiting) {
    _visiting = _visiting || {};                       // syklusvakt for deps-rekursjonen
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      if (__registered[name]) continue;
      var entry = LIB_REGISTRY[name];
      if (!entry) {
        throw new Error('Ukjent bibliotek i LIB_REGISTRY: ' + name);   // typo i en deps-liste
      }
      if (_visiting[name]) {
        throw new Error('Sirkulær avhengighet i LIB_REGISTRY: ' + name);
      }
      _visiting[name] = true;
      await ensureLibs(mod, entry.deps, _visiting);     // deps first (module-level imports)
      for (var j = 0; j < entry.js.length; j++) await loadJsDep(entry.js[j]);
      // entry.path overstyrer katalogkonvensjonen (fase 3: ui_core deles fra
      // shared/, ikke fra brython/ — se ui_core-oppføringen i LIB_REGISTRY).
      var source = await fetchText(entry.path || ('brython/' + name + '.py'));
      var err = mod._register_module(name, source);
      if (err) throw new Error(String(err));
      for (var a = 0; a < entry.aliases.length; a++) {
        err = mod._alias_module(entry.aliases[a], name);
        if (err) throw new Error(String(err));
      }
      __registered[name] = true;
    }
  }

  var PENDING_MARKER = '__BRYTHON_PENDING__';   // == runnerens _last_error-markør
  var MAX_DUCK_PASSES = 10;

  // Per-run duckdb-bro: duckdb_brython.py kaller window.__brythonDuckSync(sql)
  // synkront. Cache-treff returnerer JSON-strengen; miss legger spørringen i
  // kø og returnerer null (Python kaster da pending-unntaket). flush() kjører
  // køen asynkront via index.html-hjelperen __brythonDuck og cacher svarene;
  // run() re-kjører deretter scriptet (replay). Closure settes friskt per run
  // — en gammel closure ville ellers servert forrige runs data.
  function beginDuckBridge(spec, sharedState) {
    var cache = {};      // sql -> JSON-streng {cols} | {error}
    var pending = [];    // sql-strenger i kø til neste flush
    // Notatbok-økten (notebookSession) eier et delt {registered}-objekt så
    // view-registreringen skjer én gang per ØKT selv om broen er fersk per
    // celle; run() sender ingenting og får lokal engangs-tilstand som før.
    var st = sharedState || { registered: false };
    // Returnerer ALLTID en JSON-streng — JS null blir IKKE Python None i
    // Brython 3.12, så miss signaliseres med {"pending":true} i stedet.
    global.__brythonDuckSync = function (sqlText) {
      if (cache.hasOwnProperty(sqlText)) return cache[sqlText];
      if (pending.indexOf(sqlText) === -1) pending.push(sqlText);
      return '{"pending":true}';
    };
    return {
      hasPending: function () { return pending.length > 0; },
      flush: async function () {
        if (!global.__brythonDuck) {
          throw new Error('duckdb i Brython-modus krever DuckDB-hjelperen (__brythonDuck) i index.html');
        }
        if (!st.registered) {
          // # load-datasett (og innbakte blokker) blir spørrbare views
          for (var name in spec) {
            await global.__brythonDuck.register(name, spec[name].kind, spec[name].payload);
          }
          st.registered = true;
        }
        var batch = pending;
        pending = [];
        for (var i = 0; i < batch.length; i++) {
          try {
            var cols = await global.__brythonDuck.query(batch[i]);
            cache[batch[i]] = JSON.stringify({ cols: cols });
          } catch (e) {
            // feilen caches så replay-passet feiler PÅ kallstedet med norsk prefiks
            cache[batch[i]] = JSON.stringify({ error: (e && e.message) || String(e) });
          }
        }
      }
    };
  }

  var __enginePromise = null;
  // ui sync_to (fase 3): siste vellykket resolverte modul-objekt, satt i
  // load() under. syncVar() må svare SYNKRONT (samme kontrakt som
  // ui.js sin mdUiSyncTo-bro), så den kan ikke selv avvente __enginePromise
  // (som kan henge lenge/aldri under en pågående lasting) — best-effort: en
  // motor som ikke er ferdig lastet ENNÅ gir stille no-op, ikke en trigget lasting.
  var __loadedMod = null;

  function addScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Kunne ikke laste ' + src)); };
      document.head.appendChild(s);
    });
  }

  function fetchText(path) {
    // Cache-skew-fiksen (2026-07-23, roadmap): versjons-param på ALLE
    // runtime-hentede .py-filer — samme konvensjon som __ensureUi
    // (index.html) bruker for pyodide-familien. Uten denne kunne
    // browserens heuristiske HTTP-cache (og SW-en) servere en STALE
    // motorfil etter deploy (observert: ny js/ui.js + gammel
    // ui-fasade → TypeError ved kjøring).
    var ver = (typeof window !== 'undefined' && window.M2PY_VERSION) || '1';
    var url = path + (path.indexOf('?') >= 0 ? '&' : '?') + 'v=' + ver;
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('Kunne ikke hente ' + path + ' (' + r.status + ')');
      return r.text();
    });
  }

  function load() {
    if (__enginePromise) return __enginePromise;
    __enginePromise = (async function () {
      await addScript(BRYTHON_CORE);
      await addScript(BRYTHON_STDLIB);
      var source = await fetchText('brython/brython_runner.py');
      global.brython();                // no-args (see header)
      var mod = global.__BRYTHON__.runPythonSource(source, 'brython_runner');
      __loadedMod = mod;               // ui sync_to (fase 3): synkron syncVar()-tilgang
      return mod;
    })().catch(function (e) { __enginePromise = null; throw e; });
    return __enginePromise;
  }

  // Convert resolveAndFetchLoads results + embedded blocks to the runner's
  // {name: {kind, payload}} spec. CSV/JSON parse in Python; parquet converts
  // via the DuckDB-WASM helper exported by index.html (lazy — only if used).
  async function buildDatasetSpec(loads) {
    var spec = {};
    var i, l;
    for (i = 0; i < (loads || []).length; i++) {
      l = loads[i];
      if (!l.bytes) continue;
      if (l.format === 'csv') {
        spec[l.alias] = { kind: 'csv', payload: new TextDecoder().decode(l.bytes) };
      } else if (l.format === 'json') {
        spec[l.alias] = { kind: 'columns', payload: JSON.parse(new TextDecoder().decode(l.bytes)) };
      } else if (l.format === 'parquet') {
        if (typeof global.__brythonParquetColumns !== 'function') {
          throw new Error('parquet-kilden «' + l.alias + '» støttes ikke: DuckDB-hjelperen mangler');
        }
        spec[l.alias] = { kind: 'columns', payload: await global.__brythonParquetColumns(l.bytes) };
      } else {
        throw new Error('formatet «' + l.format + '» (' + l.alias + ') støttes ikke i Brython-modus — bruk python/r');
      }
    }
    // Embedded data blocks (published dashboards): checked after # load so an
    // explicit load wins over a baked-in copy with the same name. A parsed
    // value with a "kind" field is read explicitly ({kind:'csv',
    // payload:<csv-text>} binds via the same read_csv path as a live
    // # load; {kind:'columns', payload:{...}} is already column-shaped). A
    // value WITHOUT a "kind" field is treated as raw columns —
    // backward-compatible with tags written before this format.
    var nodes = document.querySelectorAll('script[type="application/json"][id^="brythondata_"]');
    for (i = 0; i < nodes.length; i++) {
      var name = nodes[i].id.slice('brythondata_'.length);
      if (spec[name]) continue;
      var parsed = JSON.parse(nodes[i].textContent);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.kind === 'csv') {
        spec[name] = { kind: 'csv', payload: parsed.payload };
      } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.kind === 'columns') {
        spec[name] = { kind: 'columns', payload: parsed.payload };
      } else {
        spec[name] = { kind: 'columns', payload: parsed };
      }
    }
    return spec;
  }

  // Siste kjørings resolverte datasett-spec ({navn: {kind, payload}}),
  // cachet slik at "Publiser dashboard" (index.html) kan bake dem inn som
  // brythondata_<navn>-tags uten å kjøre scriptet på nytt.
  var __lastSpec = {};

  async function run(script, opts) {
    // Contract: run() ALWAYS resolves {text, error} — never rejects. Callers
    // (index.html's mode dispatch) only handle a resolved promise; load()
    // failures (script/fetch errors) and buildDatasetSpec() throws
    // (unsupported format, missing DuckDB parquet helper) previously
    // rejected here, which would surface as an unhandled rejection instead
    // of the Norwegian error text meant for the user. Catch everything and
    // fold it into the same {text, error} shape.
    try {
      var mod = await load();
      var spec = await buildDatasetSpec(opts && opts.loads);
      // Variabel-montering (2026-07-24): ferdig-monterte kolonnesett fra
      // DuckDB-pushdownen i index.html bindes som vanlige columns-datasett.
      var _extra = (opts && opts.extraDatasets) || null;
      if (_extra) for (var _ek in _extra) spec[_ek] = { kind: 'columns', payload: _extra[_ek] };
      __lastSpec = spec;
      var needed = scanImports(script);
      if (Object.keys(spec).length && needed.indexOf('pandas_brython') === -1) {
        needed.push('pandas_brython');   // _bind_datasets bygger DataFrames
      }
      await ensureLibs(mod, needed);
      // Replay-løkke (duckdb-async-broen): et pass som stopper på en ventende
      // SQL-spørring signaliserer via PENDING_MARKER; vi kjører køen, spoler
      // brukerglobals tilbake og kjører hele scriptet på nytt. Uten duckdb i
      // koden er dette nøyaktig ett pass (pending oppstår aldri).
      var duck = beginDuckBridge(spec);
      mod._snapshot();
      var text = '', err = null, pass;
      for (pass = 0; pass < MAX_DUCK_PASSES; pass++) {
        if (pass > 0) mod._rollback();   // spol brukerglobals til før pass 1
        if (Object.keys(spec).length) {
          var bindErr = mod._bind_datasets(JSON.stringify(spec));   // ferske frames per pass
          if (bindErr) return { text: '', error: String(bindErr) };
        }
        text = mod._execute_code(script);
        err = mod._get_last_error();
        if (err !== PENDING_MARKER) break;
        if (!duck.hasPending()) {
          return { text: '', error: 'duckdb_brython: replay uten ventende spørringer (intern feil)' };
        }
        await duck.flush();
      }
      if (err === PENDING_MARKER) {
        return { text: '', error: 'duckdb-spørringene stabiliserer seg ikke etter ' +
                 MAX_DUCK_PASSES + ' pass — bygges SQL-tekstene av ikke-deterministiske ' +
                 'verdier (f.eks. random uten seed)?' };
      }
      return { text: String(text == null ? '' : text), error: err ? String(err) : null };
    } catch (e) {
      return { text: '', error: (e && e.message) || String(e) };
    }
  }

  // ── Notatbok-sesjon (fase C, spec 2026-07-16) ─────────────────────────
  // ÉN levende økt for celle-for-celle-kjøring: datasett bindes ÉN gang i
  // ensure() (IKKE per celle slik run() gjør — brukerens mutasjoner av
  // datasettvariabler skal overleve mellom celler). Duck-broen er derimot
  // FERSK per celle (se nbRunCell) — kun view-registreringen deles per økt
  // via duckShared. Vanlige scripts (uten #%%) bruker run() uendret —
  // paramount-invarianten.
  var __nb = { live: false, spec: null, duckShared: null };

  async function nbEnsure(loads) {
    if (__nb.live) return;
    var mod = await load();
    var spec = await buildDatasetSpec(loads);
    __lastSpec = spec;   // "Publiser dashboard" leser herfra, som ved run()
    if (Object.keys(spec).length) {
      await ensureLibs(mod, ['pandas_brython']);   // _bind_datasets bygger DataFrames
      var bindErr = mod._bind_datasets(JSON.stringify(spec));
      if (bindErr) throw new Error(String(bindErr));
    }
    __nb.spec = spec;
    __nb.duckShared = { registered: false };   // views registreres én gang per økt
    __nb.live = true;
  }

  async function nbRunCell(source) {
    // Kontrakt som run(): resolver ALLTID {text, error} — aldri reject.
    try {
      if (!__nb.live) {
        return { text: '', error: 'notebookSession.ensure() må kalles før runCell()' };
      }
      var mod = await load();
      await ensureLibs(mod, scanImports(source));
      // Fersk bro (og dermed ferskt hook+cache) per celle — samme
      // per-kjøring-cachesemantikk som run(); kun view-registreringen deles
      // per økt via duckShared. En delt bro ville ellers både mistet det
      // globale sync-hooket til en mellomliggende run() og servert stale
      // cache-treff etter muterende SQL (INSERT/CREATE OR REPLACE).
      var duck = beginDuckBridge(__nb.spec, __nb.duckShared);
      mod._snapshot();   // duck-replay-spoling gjelder KUN denne cellens pass
      var text = '', err = null, pass;
      for (pass = 0; pass < MAX_DUCK_PASSES; pass++) {
        if (pass > 0) mod._rollback();
        text = mod._execute_code(source);
        err = mod._get_last_error();
        if (err !== PENDING_MARKER) break;
        if (!duck.hasPending()) {
          return { text: '', error: 'duckdb_brython: replay uten ventende spørringer (intern feil)' };
        }
        await duck.flush();
      }
      if (err === PENDING_MARKER) {
        return { text: '', error: 'duckdb-spørringene stabiliserer seg ikke etter ' +
                 MAX_DUCK_PASSES + ' pass — bygges SQL-tekstene av ikke-deterministiske ' +
                 'verdier (f.eks. random uten seed)?' };
      }
      return { text: String(text == null ? '' : text), error: err ? String(err) : null };
    } catch (e) {
      return { text: '', error: (e && e.message) || String(e) };
    }
  }

  async function nbReset() {
    var mod = await load();
    var err = mod._reset();
    if (err) throw new Error(String(err));
    // live=false → neste ensure() re-resolver # load og rebinder datasett
    // (rene frames tilbake etter reset). __brythonDuck.register er
    // idempotent (typebevisst DROP + CREATE VIEW, index.html ~2707), så
    // neste økt kan trygt re-registrere de samme viewene.
    __nb.live = false;
    __nb.spec = null;
    __nb.duckShared = null;
  }

  function nbInvalidate() { __nb.live = false; __nb.spec = null; __nb.duckShared = null; }
  function nbIsLive() { return __nb.live; }

  global.BrythonEngine = {
    load: load, run: run, _scanImports: scanImports,
    getLastDatasetSpec: function () { return __lastSpec; },
    notebookSession: { ensure: nbEnsure, runCell: nbRunCell, reset: nbReset,
                       invalidate: nbInvalidate, isLive: nbIsLive },
    // ui sync_to (fase 3): skriv inn i _shared_vars uten kjøring. No-op
    // ('' returneres) når motoren ikke er lastet — sync er best-effort.
    syncVar: function (name, valueJson) {
      if (!__loadedMod) return '';
      try { return __loadedMod._sync_var(name, valueJson) || ''; }
      catch (e) { return (e && e.message) || String(e); }
    },
    // Sidebar-refleksjon (2026-07-24): alle DataFrames i _shared_vars —
    // # load-bundne OG avledede. {} når motoren ikke er lastet/feiler.
    datasetInfo: function () {
      if (!__loadedMod) return {};
      try { return JSON.parse(__loadedMod._dataset_info() || '{}'); }
      catch (e) { return {}; }
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
