// js/javascript-engine.js — native JavaScript-motor for openstat/safestat.
// Designspec: docs/superpowers/specs/2026-07-19-javascript-mode-design.md
//
// Kjører brukerens JavaScript direkte i siden (ingen wasm-boot — raskeste
// modus i appen). Speiler brython-/micropython-motorens kontrakt:
// {load, run, notebookSession} og {text, error}-retur med embed-markørtekst
// som index.html renderer via buildOutputNodes(). Biblioteker (aq/ss/jStat/
// ML/Plot) lastes lat fra CDN kun når koden refererer dem (scanLibs).
// Variabler lever i et scope-objekt bak en with()-proxy; pre-passen under
// skriver toppnivå-deklarasjoner om til tilordninger slik at de overlever
// mellom celler/kjøringer. NB: with() er inkompatibelt med strict mode —
// AsyncFunction-kroppen har derfor med vilje ingen 'use strict'.
(function (global) {
  'use strict';

  var EMBED_S = '__micro_transform_start_';
  var EMBED_E = '__micro_transform_end__';

  // Bibliotek-register — {js: [{url, global}], also: [ekstra scope-navn]}.
  // js-listen lastes i rekkefølge (Plot trenger global d3 først); en url
  // hoppes over når window[global] alt finnes (samme som micropython-
  // motorens loadJsDep). URL-ene er pinnet og verifisert (plan 2026-07-19).
  var LIB_REGISTRY = {
    aq:    { js: [{ url: 'https://cdn.jsdelivr.net/npm/arquero@8.0.3/dist/arquero.min.js', global: 'aq' }],
             also: ['op'] },   // op = aq.op — praktisk i derive/rollup-uttrykk
    ss:    { js: [{ url: 'https://cdn.jsdelivr.net/npm/simple-statistics@7.8.8/dist/simple-statistics.min.js', global: 'ss' }] },
    jStat: { js: [{ url: 'https://cdn.jsdelivr.net/npm/jstat@1.9.6/dist/jstat.min.js', global: 'jStat' }] },
    // jsdelivr har ingen browser-dist for npm-pakken `ml` — lactame er
    // mljs-organisasjonens offisielle CDN (verifisert 200, UMD-global ML).
    ML:    { js: [{ url: 'https://www.lactame.com/lib/ml/6.0.0/ml.min.js', global: 'ML' }] },
    Plot:  { js: [{ url: 'https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js', global: 'd3' },
                  { url: 'https://cdn.jsdelivr.net/npm/@observablehq/plot@0.6.17/dist/plot.umd.min.js', global: 'Plot' }] }
  };

  // ── Ren halvdel (node-testet, tests/js/javascript-engine.test.js) ──────

  function scanLibs(code) {
    var src = String(code);
    var needed = [];
    for (var k in LIB_REGISTRY) {
      var names = [k].concat(LIB_REGISTRY[k].also || []);
      for (var i = 0; i < names.length; i++) {
        if (new RegExp('\\b' + names[i] + '\\b').test(src)) { needed.push(k); break; }
      }
    }
    return needed;
  }

  // "# use <navn> from duckdb" — hent forrige duckdb-kjørings tabell som
  // arquero-tabell (via parquet-bytes, se bindDuckUses i runtime-halvdelen).
  function scanDuckUses(script) {
    var out = [], re = /^#\s*use\s+([A-Za-z_]\w*)\s+from\s+duckdb\s*$/gmi, m;
    while ((m = re.exec(String(script)))) out.push(m[1]);
    return out;
  }

  // Pre-pass — toppnivå (kolonne 0)-omskrivinger, linjetall bevares:
  //   '#'-linjer (# load/# use/#%%/#options/#tag/#@param m.fl.) → ''
  //   'const/let/var X = …'    → 'X = …'         (overlever i scopet)
  //   'let x;' / 'let x, y'    → 'x = undefined; …'
  //   'const {a,b} = …;'       → '({a,b} = …);'  (destrukturering, én linje)
  //   'function f(…) {'        → 'f = function f(…) {'
  //   'class C …'              → 'C = class C …'
  // Innrykkede linjer røres ALDRI (blokk-lokale deklarasjoner beholder ekte
  // JS-semantikk). Kjente begrensninger gir høylytt SyntaxError/
  // ReferenceError, aldri stille korrupsjon (se spec §7): flerlinje-
  // destrukturering på toppnivå, hoisting av omskrevne funksjoner, og
  // template-literals med kolonne-0-linjer som ligner direktiver/deklarasjoner.
  function prepass(src) {
    var lines = String(src).split('\n');
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var m;
      if (/^#/.test(line)) { out.push(''); continue; }
      if ((m = line.match(/^(?:const|let|var)\s+([{[].*)$/))) {
        out.push('(' + m[1].replace(/;\s*$/, '') + ');');
      } else if ((m = line.match(/^(?:const|let|var)\s+([A-Za-z_$][^=]*)$/)) && m[1].indexOf('=') === -1) {
        // bare deklarasjon uten initialisering: 'let x;' / 'let x, y'
        out.push(m[1].replace(/;\s*$/, '').split(',').map(function (n) {
          return n.trim() + ' = undefined;';
        }).join(' '));
      } else if ((m = line.match(/^(?:const|let|var)\s+([A-Za-z_$].*)$/))) {
        out.push(m[1]);
      } else if ((m = line.match(/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/))) {
        out.push(m[1] + ' = ' + line);
      } else if ((m = line.match(/^class\s+([A-Za-z_$][\w$]*)/))) {
        out.push(m[1] + ' = ' + line);
      } else {
        out.push(line);
      }
    }
    return out.join('\n');
  }

  var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

  function compilesAsExpr(s) {
    try { new AsyncFunction('return (' + s + '\n);'); return true; } catch (e) { return false; }
  }
  function compilesAsBody(s) {
    try { new AsyncFunction(s); return true; } catch (e) { return false; }
  }

  // Del koden i {body, expr}: expr = siste sammenhengende toppnivå-setning
  // HVIS den er et rent uttrykk (ikke tilordning/kontrollflyt) — vises som
  // celleresultat (notatbok-følelse). Kompilerings-probing på begge sider
  // gjør heuristikken trygg: usikre tilfeller gir {expr: null} (ingen
  // visning), aldri feil kjøring.
  var MAX_EXPR_LINES = 20;
  function splitLastExpr(code) {
    var lines = String(code).split('\n');
    var end = lines.length - 1;
    while (end >= 0 && !lines[end].trim()) end--;
    if (end < 0) return { body: code, expr: null };
    for (var start = end; start >= 0 && end - start < MAX_EXPR_LINES; start--) {
      if (!lines[start].trim()) break;   // uttrykk strekker seg ikke over blanklinjer
      var cand = lines.slice(start, end + 1).join('\n').trim().replace(/;+\s*$/, '');
      if (/^[A-Za-z_$][\w$.]*\s*=[^=]/.test(cand)) return { body: code, expr: null };
      var body = lines.slice(0, start).join('\n');
      if (compilesAsExpr(cand) && compilesAsBody(body)) return { body: body, expr: cand };
    }
    return { body: code, expr: null };
  }

  function prettyPrint(v) {
    var seen = [];
    try {
      var s = JSON.stringify(v, function (k, val) {
        if (typeof val === 'bigint') return String(val) + 'n';
        if (val instanceof Map) return { '[Map]': Array.from(val.entries()) };
        if (val instanceof Set) return { '[Set]': Array.from(val.values()) };
        if (typeof val === 'function') return '[Function ' + (val.name || 'anonym') + ']';
        if (val && typeof val === 'object') {
          if (seen.indexOf(val) !== -1) return '[Circular]';
          seen.push(val);
        }
        return val;
      }, 2);
      return s === undefined ? String(v) : s;
    } catch (e) { return String(v); }
  }

  function embed(type, payload) { return EMBED_S + type + '__\n' + payload + '\n' + EMBED_E; }

  // Verdi → output-tekst. Duck-typing (ikke instanceof) — testbar i node
  // uten DOM/bibliotek, og robust mot flere arquero-/plotly-versjoner.
  var TABLE_LIMIT = 200;
  function valueToOutput(v) {
    if (v === null || v === undefined) return '';
    if (typeof v.toHTML === 'function' && typeof v.objects === 'function') {
      var n = null;
      try { n = typeof v.numRows === 'function' ? v.numRows() : v.numRows; } catch (e) {}
      var html = v.toHTML({ limit: TABLE_LIMIT });
      if (typeof n === 'number' && n > TABLE_LIMIT) {
        html += '<div class="output-note">… viser ' + TABLE_LIMIT + ' av ' + n + ' rader</div>';
      }
      return embed('tablehtml', html);
    }
    if (typeof v === 'object' && Array.isArray(v.data) && ('layout' in v)) {
      try { return embed('figure', JSON.stringify(v)); } catch (e) {}
    }
    if (v.nodeType === 1 && typeof v.outerHTML === 'string') {
      return embed('html', v.outerHTML);
    }
    if (typeof v === 'string') return v;
    if (typeof v === 'object') return prettyPrint(v);
    return String(v);
  }

  // ── Runtime-halvdel ────────────────────────────────────────────────────

  // Scope-proxy: has() → true gjør at ALLE navneoppslag i with-blokken går
  // via proxyen — get faller tilbake til window-globaler, og oppslag som
  // ikke finnes noe sted kaster ReferenceError (ellers ville skrivefeil
  // stille blitt undefined; prisen er at også `typeof x` kaster for ukjente
  // navn — akseptert, analysescripts bruker sjelden typeof-guards). set
  // skriver alltid til scope-objektet — det er persistensen mellom celler.
  var LIB_HINT = ' — bibliotekglobalene i JavaScript-modus er aq, op, ss, jStat, ML, Plot og Plotly';
  function makeScope() {
    var vars = Object.create(null);
    var proxy = new Proxy(vars, {
      has: function () { return true; },
      get: function (t, k) {
        if (k === Symbol.unscopables) return undefined;
        if (k in t) return t[k];
        if (k in global) return global[k];
        throw new ReferenceError(String(k) + ' er ikke definert' +
          (LIB_REGISTRY[k] || k === 'op' ? LIB_HINT : ''));
      },
      set: function (t, k, v) { t[k] = v; return true; }
    });
    return { vars: vars, proxy: proxy };
  }

  async function execIn(scope, code) {
    var split = splitLastExpr(code);
    var body = split.expr ? split.body + '\nreturn (' + split.expr + '\n);' : code;
    // INGEN 'use strict' her — with() er forbudt i strict mode.
    var fn = new AsyncFunction('__scope', 'with (__scope) {\n' + body + '\n}');
    return fn(scope.proxy);
  }

  function captureConsole(buf) {
    var keys = ['log', 'info', 'warn', 'error'];
    var orig = {};
    keys.forEach(function (k) {
      orig[k] = console[k];
      console[k] = function () {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) {
          parts.push(typeof arguments[i] === 'string' ? arguments[i] : prettyPrint(arguments[i]));
        }
        buf.push(parts.join(' '));
        try { orig[k].apply(console, arguments); } catch (e) {}
      };
    });
    return function restore() { keys.forEach(function (k) { console[k] = orig[k]; }); };
  }

  var __jsLoaded = {};   // url → Promise (delt på tvers av registernøkler)
  function addScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Kunne ikke laste ' + src)); };
      document.head.appendChild(s);
    });
  }
  function loadJsDep(dep) {
    if (global[dep.global]) return Promise.resolve();
    if (!__jsLoaded[dep.url]) {
      __jsLoaded[dep.url] = addScript(dep.url).catch(function (e) {
        delete __jsLoaded[dep.url];
        throw e;
      });
    }
    return __jsLoaded[dep.url];
  }
  function ensureLibs(keys) {
    return keys.reduce(function (p, k) {
      return p.then(function () {
        return LIB_REGISTRY[k].js.reduce(function (pp, dep) {
          return pp.then(function () { return loadJsDep(dep); });
        }, Promise.resolve());
      }).then(function () {
        if (k === 'aq' && global.aq && global.op === undefined) global.op = global.aq.op;
      });
    }, Promise.resolve());
  }

  // ── Datasett-spec ({navn: {kind:'csv'|'columns', payload}}) ────────────
  // Samme tag-/spec-format som Brython-motorens buildDatasetSpec: «Publiser
  // dokument (HTML)» (index.html) leser getLastDatasetSpec() og baker
  // entriene inn som <script type="application/json" id="jsdata_<navn>">-
  // tags; ved lasting av den publiserte sida binder collectSpec() dem igjen.
  async function specFromLoad(l) {
    if (l.format === 'csv') {
      return { kind: 'csv', payload: new TextDecoder().decode(l.bytes) };
    }
    if (l.format === 'json') {
      return { kind: 'columns', payload: JSON.parse(new TextDecoder().decode(l.bytes)) };
    }
    if (l.format === 'parquet') {
      if (typeof global.__brythonParquetColumns !== 'function') {
        throw new Error('parquet-kilden «' + l.alias + '» støttes ikke: DuckDB-hjelperen mangler');
      }
      return { kind: 'columns', payload: await global.__brythonParquetColumns(l.bytes) };
    }
    throw new Error('formatet «' + l.format + '» (' + l.alias + ') støttes ikke i JavaScript-modus — bruk python/r');
  }

  function tableFromSpec(entry) {
    var aq = global.aq;
    if (entry.kind === 'csv') return aq.fromCSV(entry.payload);
    return Array.isArray(entry.payload) ? aq.from(entry.payload) : aq.table(entry.payload);
  }

  // Innbakte datablokker (publiserte dokumenter). Etter # load, slik at en
  // eksplisitt load vinner over en innbakt kopi med samme navn. En parsed
  // verdi UTEN kind-felt tolkes som rå kolonner (samme bakoverkompatibilitet
  // som brython-tagene). document-guard: node-testene har ingen DOM.
  function collectEmbedded(spec) {
    if (typeof document === 'undefined' || !document.querySelectorAll) return;
    var nodes = document.querySelectorAll('script[type="application/json"][id^="jsdata_"], script[id^="jsdata_"]');
    for (var i = 0; i < nodes.length; i++) {
      var name = nodes[i].id.slice('jsdata_'.length);
      if (spec[name]) continue;
      var parsed = JSON.parse(nodes[i].textContent);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
          (parsed.kind === 'csv' || parsed.kind === 'columns')) {
        spec[name] = { kind: parsed.kind, payload: parsed.payload };
      } else {
        spec[name] = { kind: 'columns', payload: parsed };
      }
    }
  }

  // Siste kjørings resolverte spec — «Publiser dokument» leser herfra uten å
  // kjøre scriptet på nytt. Overskrives kun når en kjøring faktisk
  // resolverte datasett (per-celle-kjøringer med tomme loads beholder
  // ensure-tidens spec).
  var __lastSpec = {};

  async function bindLoads(scope, loads) {
    var spec = {};
    var withBytes = (loads || []).filter(function (l) { return l && l.bytes; });
    for (var i = 0; i < withBytes.length; i++) {
      spec[withBytes[i].alias] = await specFromLoad(withBytes[i]);
    }
    collectEmbedded(spec);
    if (!Object.keys(spec).length) return;
    __lastSpec = spec;
    await ensureLibs(['aq']);
    for (var name in spec) {
      scope.vars[name] = tableFromSpec(spec[name]);
    }
  }

  // "# use <navn> from duckdb" — parquet-bytes fra forrige duckdb-kjørings
  // wasm-katalog (window.__duckUseBytes, eksponert av index.html) →
  // arquero-tabell. Samme økt-semantikk som use from duckdb i python/r.
  async function bindDuckUses(scope, script) {
    var names = scanDuckUses(script);
    if (!names.length) return;
    if (typeof global.__duckUseBytes !== 'function') {
      throw new Error('use … from duckdb er ikke tilgjengelig her');
    }
    await ensureLibs(['aq']);
    for (var i = 0; i < names.length; i++) {
      var bytes = await global.__duckUseBytes(names[i]);
      var columns = await global.__brythonParquetColumns(bytes);
      // Inn i spec-cachen også — «Publiser dokument» skal kunne bake inn
      // duck-hentede tabeller på lik linje med # load-datasett.
      __lastSpec[names[i]] = { kind: 'columns', payload: columns };
      scope.vars[names[i]] = global.aq.table(columns);
    }
  }

  // Kontrakt: resolver ALLTID {text, error} — aldri reject (som Brython).
  async function runIn(scope, script, loads) {
    var buf = [], restore = null;
    try {
      await ensureLibs(scanLibs(script));
      await bindLoads(scope, loads);
      await bindDuckUses(scope, script);
      var code = prepass(script);
      restore = captureConsole(buf);
      var value = await execIn(scope, code);
      restore(); restore = null;
      var text = buf.join('\n');
      var disp = valueToOutput(value);
      if (disp) text += (text ? '\n' : '') + disp;
      return { text: text, error: null };
    } catch (e) {
      if (restore) restore();
      return { text: buf.join('\n'), error: (e && e.message) || String(e) };
    }
  }

  function load() { return Promise.resolve(); }

  async function run(script, opts) {
    return runIn(makeScope(), script, (opts && opts.loads) || []);
  }

  // ── Notatbok-sesjon (Fase C-kontrakten, som Brython/MicroPython) ───────
  var __nb = { live: false, scope: null };
  async function nbEnsure(loads) {
    if (__nb.live) return;
    var scope = makeScope();
    await bindLoads(scope, loads);
    __nb.scope = scope;
    __nb.live = true;
  }
  async function nbRunCell(source) {
    if (!__nb.live) {
      return { text: '', error: 'notebookSession.ensure() må kalles før runCell()' };
    }
    return runIn(__nb.scope, source, []);
  }
  async function nbReset() { __nb.live = false; __nb.scope = null; }
  function nbInvalidate() { __nb.live = false; __nb.scope = null; }
  function nbIsLive() { return __nb.live; }

  global.JsEngine = {
    load: load, run: run,
    getLastDatasetSpec: function () { return __lastSpec; },
    notebookSession: { ensure: nbEnsure, runCell: nbRunCell, reset: nbReset,
                       invalidate: nbInvalidate, isLive: nbIsLive },
    _prepass: prepass, _splitLastExpr: splitLastExpr, _scanLibs: scanLibs,
    _scanDuckUses: scanDuckUses, _prettyPrint: prettyPrint,
    _valueToOutput: valueToOutput, _makeScope: makeScope, _runIn: runIn
  };
})(typeof window !== 'undefined' ? window : globalThis);
