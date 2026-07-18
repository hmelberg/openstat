# JavaScript-modus — implementasjonsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nytt kjørbart språk «JavaScript» i openstat — native kjøring i nettleseren med Arquero/simple-statistics/jStat/ml.js/Observable Plot lastet lat fra CDN, full integrasjon med `# load`, `#%%`-celler og eksisterende output-rendering.

**Architecture:** Ny motor `js/javascript-engine.js` som speiler Brython-/MicroPython-motorens kontrakt (`{load, run, notebookSession}`, `{text, error}`-retur med embed-markørtekst). Variabler lever i et scope-objekt bak en `with()`-proxy; en ren, node-testet pre-pass skriver toppnivå-deklarasjoner om til tilordninger og stripper `#`-direktivlinjer. Registrering i index.html følger nøyaktig samme punkter som brython/micropython (katalogisert under).

**Tech Stack:** Vanilla JS (IIFE på window/globalThis som øvrige js/-filer), node:test for rene deler, CDN-biblioteker (verifiserte URL-er, se Task 2).

**Spec:** `docs/superpowers/specs/2026-07-19-javascript-mode-design.md`

## Global Constraints

- Motorkontrakt: `run()`/`notebookSession.runCell()` resolver ALLTID `{text, error}` — aldri reject (samme som Brython-motoren).
- Embed-markører: `__micro_transform_start_<type>__\n<payload>\n__micro_transform_end__`; typene `tablehtml` og `figure` finnes; ny type `html` legges til i buildOutputNodes (Task 4).
- Pinnede CDN-URL-er (alle verifisert 200 per 2026-07-19):
  - arquero: `https://cdn.jsdelivr.net/npm/arquero@8.0.3/dist/arquero.min.js` (global `aq`)
  - simple-statistics: `https://cdn.jsdelivr.net/npm/simple-statistics@7.8.8/dist/simple-statistics.min.js` (global `ss`)
  - jstat: `https://cdn.jsdelivr.net/npm/jstat@1.9.6/dist/jstat.min.js` (global `jStat`)
  - ml.js: `https://www.lactame.com/lib/ml/6.0.0/ml.min.js` (global `ML`) — jsdelivr har INGEN dist for npm-pakken `ml`
  - d3: `https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js` (global `d3`) — plot.umd forventer global d3
  - Observable Plot: `https://cdn.jsdelivr.net/npm/@observablehq/plot@0.6.17/dist/plot.umd.min.js` (global `Plot`)
- `with()` og strict mode er inkompatible — motorens AsyncFunction-kropp skal IKKE ha `'use strict'`.
- Norske brukerstrenger via `t('…')` der de rendres i index.html; motorens egne feilstrenger er norske literaler (samme praksis som brython-engine.js).
- Testkommando for js-tester: `node --test tests/js/<fil>` (kjøres også av CI via tests/-sweep).
- Kjente, dokumenterte pre-pass-begrensninger (høylytt feil, aldri stille korrupsjon): flerlinje-destrukturering på toppnivå; hoisting av omskrevne funksjoner; template-literals med linjer som starter i kolonne 0 med direktiv-lignende `#`-tekst eller `const/let/var/function/class`.

---

### Task 1: Motorens rene kjerne (pre-pass, siste-uttrykk, lib-skanning, verdi→output)

**Files:**
- Create: `js/javascript-engine.js` (kun den rene halvdelen i denne tasken)
- Test: `tests/js/javascript-engine.test.js`

**Interfaces:**
- Produces: `globalThis.JsEngine._prepass(src) → string`, `._splitLastExpr(code) → {body, expr|null}`, `._scanLibs(code) → string[]` (registernøkler), `._scanDuckUses(script) → string[]`, `._prettyPrint(v) → string`, `._valueToOutput(v) → string` (embed-markørtekst eller rå tekst). Task 2 bygger runtime-halvdelen i SAMME fil og bruker alle disse.

- [ ] **Step 1: Skriv failende tester**

`tests/js/javascript-engine.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
require('../../js/javascript-engine.js');
const E = globalThis.JsEngine;

test('prepass: stripper direktivlinjer, beholder linjetall', () => {
  const out = E._prepass('# load x.csv as x\n#%% js\nconst a = 1;');
  assert.strictEqual(out, '\n\na = 1;');
});

test('prepass: const/let/var → tilordning, kun kolonne 0', () => {
  assert.strictEqual(E._prepass('const x = 1;'), 'x = 1;');
  assert.strictEqual(E._prepass('let a = 1, b = 2;'), 'a = 1, b = 2;');
  assert.strictEqual(E._prepass('  const inner = 1;'), '  const inner = 1;'); // innrykk urørt
});

test('prepass: bare deklarasjoner uten = blir undefined-tilordninger', () => {
  assert.strictEqual(E._prepass('let x;'), 'x = undefined;');
  assert.strictEqual(E._prepass('let x, y'), 'x = undefined; y = undefined;');
});

test('prepass: destrukturering på én linje wrappes i parens', () => {
  assert.strictEqual(E._prepass('const {a, b} = obj;'), '({a, b} = obj);');
  assert.strictEqual(E._prepass('const [p, q] = arr;'), '([p, q] = arr);');
});

test('prepass: function/class-deklarasjoner får navnetilordning', () => {
  assert.strictEqual(E._prepass('function f(x) {'), 'f = function f(x) {');
  assert.strictEqual(E._prepass('async function g() {'), 'g = async function g() {');
  assert.strictEqual(E._prepass('class Punkt {'), 'Punkt = class Punkt {');
});

test('splitLastExpr: rent uttrykk til slutt skilles ut', () => {
  const r = E._splitLastExpr('x = 5;\nx + 1');
  assert.strictEqual(r.expr, 'x + 1');
  assert.strictEqual(r.body, 'x = 5;');
});

test('splitLastExpr: flerlinje-uttrykk (metodekjede) skilles ut', () => {
  const r = E._splitLastExpr('t = 1;\nfoo(1)\n  .bar()\n  .baz()');
  assert.strictEqual(r.expr, 'foo(1)\n  .bar()\n  .baz()');
});

test('splitLastExpr: tilordning til slutt vises ikke', () => {
  assert.strictEqual(E._splitLastExpr('const-fri;\nx = 5').expr, null);
});

test('splitLastExpr: kontrollflyt til slutt vises ikke', () => {
  assert.strictEqual(E._splitLastExpr('for (let i=0;i<2;i++) { f(i); }').expr, null);
});

test('scanLibs: finner registernøkler via ordgrense, op → aq', () => {
  assert.deepStrictEqual(E._scanLibs('const t = aq.table({a:[1]});'), ['aq']);
  assert.deepStrictEqual(E._scanLibs('op.mean("x")'), ['aq']);
  assert.deepStrictEqual(E._scanLibs('ss.mean([1,2]); jStat.normal.cdf(0,0,1)'), ['ss', 'jStat']);
  assert.deepStrictEqual(E._scanLibs('Plotly.newPlot(el, d)'), []);   // Plotly er alltid lastet
  assert.deepStrictEqual(E._scanLibs('classy_name'), []);             // ingen delords-treff
});

test('scanDuckUses: finner use-from-duckdb-direktiver', () => {
  assert.deepStrictEqual(E._scanDuckUses('# use tab1 from duckdb\nx = 1;\n# use t2 from duckdb'),
    ['tab1', 't2']);
  assert.deepStrictEqual(E._scanDuckUses('# use x from python'), []);
});

test('valueToOutput: null/undefined → tom streng', () => {
  assert.strictEqual(E._valueToOutput(null), '');
  assert.strictEqual(E._valueToOutput(undefined), '');
});

test('valueToOutput: arquero-aktig tabell → tablehtml-embed med radgrense', () => {
  const fake = { toHTML: (o) => '<table class="output-table"><tr><td>x</td></tr></table>',
                 objects: () => [], numRows: () => 500 };
  const out = E._valueToOutput(fake);
  assert.ok(out.startsWith('__micro_transform_start_tablehtml__\n'));
  assert.ok(out.includes('viser 200 av 500 rader'));
  assert.ok(out.endsWith('__micro_transform_end__'));
});

test('valueToOutput: plotly-aktig objekt → figure-embed', () => {
  const out = E._valueToOutput({ data: [{ x: [1], y: [2] }], layout: { title: 't' } });
  assert.ok(out.startsWith('__micro_transform_start_figure__\n'));
  assert.ok(JSON.parse(out.split('\n').slice(1, -1).join('\n')).data.length === 1);
});

test('valueToOutput: DOM-aktig node → html-embed', () => {
  const out = E._valueToOutput({ nodeType: 1, outerHTML: '<svg><g/></svg>' });
  assert.ok(out.startsWith('__micro_transform_start_html__\n'));
  assert.ok(out.includes('<svg><g/></svg>'));
});

test('valueToOutput: skalarer og objekter', () => {
  assert.strictEqual(E._valueToOutput(42), '42');
  assert.strictEqual(E._valueToOutput('hei'), 'hei');
  assert.strictEqual(E._valueToOutput({ a: 1 }), '{\n  "a": 1\n}');
});

test('prettyPrint: sirkulær referanse og Map/Set', () => {
  const o = { a: 1 }; o.selv = o;
  assert.ok(E._prettyPrint(o).includes('[Circular]'));
  assert.ok(E._prettyPrint(new Map([['k', 1]])).includes('[Map]'));
});
```

- [ ] **Step 2: Kjør testene, verifiser at de feiler**

Run: `node --test tests/js/javascript-engine.test.js`
Expected: FAIL — `Cannot find module '../../js/javascript-engine.js'`

- [ ] **Step 3: Skriv den rene halvdelen av motoren**

`js/javascript-engine.js`:

```js
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
  //   '#'-direktivlinjer (# load/# use/#%%/#options/#tag/#@param) → ''
  //   'const/let/var X = …'    → 'X = …'         (overlever i scopet)
  //   'let x;' / 'let x, y'    → 'x = undefined; …'
  //   'const {a,b} = …;'       → '({a,b} = …);'  (destrukturering, én linje)
  //   'function f(…) {'        → 'f = function f(…) {'
  //   'class C …'              → 'C = class C …'
  // Innrykkede linjer røres ALDRI (blokk-lokale deklarasjoner beholder ekte
  // JS-semantikk). Kjente begrensninger gir høylytt SyntaxError/
  // ReferenceError, aldri stille korrupsjon (se spec §7).
  var DIRECTIVE_RE = /^#\s?(%%|load\b|use\b|options\.|tag\.|@param\b)/;
  function prepass(src) {
    var lines = String(src).split('\n');
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var m;
      if (DIRECTIVE_RE.test(line) || /^#/.test(line)) { out.push(''); continue; }
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
    if (v && typeof v.toHTML === 'function' && typeof v.objects === 'function') {
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

  // (Runtime-halvdelen — scope, kjøring, lib-lasting, run/notebookSession —
  // kommer i Task 2 og fyller ut eksporten under.)

  global.JsEngine = {
    _prepass: prepass, _splitLastExpr: splitLastExpr, _scanLibs: scanLibs,
    _scanDuckUses: scanDuckUses, _prettyPrint: prettyPrint, _valueToOutput: valueToOutput
  };
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: Kjør testene, verifiser at alle passerer**

Run: `node --test tests/js/javascript-engine.test.js`
Expected: PASS (alle)

- [ ] **Step 5: Commit**

```bash
git add js/javascript-engine.js tests/js/javascript-engine.test.js
git commit -m "feat(js-mode): ren motorkjerne — pre-pass, siste-uttrykk, lib-skanning, verdi→embed"
```

---

### Task 2: Motorens runtime-halvdel (scope, kjøring, lib-lasting, run/notebookSession)

**Files:**
- Modify: `js/javascript-engine.js` (samme fil — runtime-halvdel + full eksport)
- Test: `tests/js/javascript-engine.test.js` (nye tester nederst)

**Interfaces:**
- Consumes: Task 1s rene funksjoner.
- Produces: `window.JsEngine = { load() → Promise, run(script, {loads}) → Promise<{text, error}>, notebookSession: { ensure(loads), runCell(src) → Promise<{text, error}>, reset(), invalidate(), isLive() }, _makeScope(), _runIn(scope, script, loads) }`. `loads` har brython-formen `[{alias, bytes(Uint8Array), format}]`. index.html (Task 4) bruker nøyaktig denne kontrakten.

- [ ] **Step 1: Skriv failende tester (append i testfila)**

```js
// ── Runtime-halvdel (kjøres i node: AsyncFunction + scope-proxy er DOM-frie) ──

test('runIn: variabler overlever i samme scope, siste uttrykk vises', async () => {
  const scope = E._makeScope();
  const r1 = await E._runIn(scope, 'const x = 21;', []);
  assert.strictEqual(r1.error, null);
  const r2 = await E._runIn(scope, 'x * 2', []);
  assert.strictEqual(r2.error, null);
  assert.strictEqual(r2.text, '42');
});

test('runIn: console.log fanges, kommer før siste-uttrykk-visningen', async () => {
  const r = await E._runIn(E._makeScope(), 'console.log("a", {b: 1});\n"slutt"', []);
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.text, 'a {\n  "b": 1\n}\nslutt');
});

test('runIn: feil gir {error}, console gjenopprettes', async () => {
  const before = console.log;
  const r = await E._runIn(E._makeScope(), 'kastes_ikke_definert_feil()', []);
  assert.ok(r.error && /kastes_ikke_definert_feil/.test(r.error));
  assert.strictEqual(console.log, before);
});

test('runIn: ukjent identifikator gir ReferenceError med bibliotekhint for lib-navn', async () => {
  const r = await E._runIn(E._makeScope(), 'helt_ukjent_navn', []);
  assert.ok(/helt_ukjent_navn/.test(r.error));
});

test('runIn: await på toppnivå virker', async () => {
  const r = await E._runIn(E._makeScope(), 'const v = await Promise.resolve(7);\nv', []);
  assert.strictEqual(r.text, '7');
});

test('runIn: funksjonsdeklarasjon overlever til neste kjøring', async () => {
  const scope = E._makeScope();
  await E._runIn(scope, 'function dobbel(n) {\n  return n * 2;\n}', []);
  const r = await E._runIn(scope, 'dobbel(5)', []);
  assert.strictEqual(r.text, '10');
});

test('run: ferskt scope per kall (ingen lekkasje)', async () => {
  await E.run('const lekk = 1;', {});
  const r = await E.run('typeof lekk', {});
  assert.strictEqual(r.text, 'undefined');
});

test('notebookSession: ensure/runCell/reset-livssyklus', async () => {
  const sess = E.notebookSession;
  assert.strictEqual(sess.isLive(), false);
  const r0 = await sess.runCell('1 + 1');
  assert.ok(r0.error);                       // runCell før ensure → kontraktsfeil
  await sess.ensure([]);
  assert.strictEqual(sess.isLive(), true);
  await sess.runCell('const c = 3;');
  const r = await sess.runCell('c + 1');
  assert.strictEqual(r.text, '4');
  await sess.reset();
  assert.strictEqual(sess.isLive(), false);
});

test('bindLoads: csv-load blir arquero-tabell i scopet (stubbet aq)', async () => {
  globalThis.aq = {
    fromCSV: (txt) => ({ _csv: txt, toHTML: () => '<table></table>', objects: () => [], numRows: () => 1 }),
    from: (rows) => ({ rows }), table: (cols) => ({ cols }), op: {}
  };
  try {
    const scope = E._makeScope();
    const bytes = new TextEncoder().encode('a,b\n1,2');
    const r = await E._runIn(scope, 'iris._csv.length', [{ alias: 'iris', bytes, format: 'csv' }]);
    assert.strictEqual(r.error, null);
    assert.strictEqual(r.text, String('a,b\n1,2'.length));
  } finally { delete globalThis.aq; delete globalThis.op; }
});
```

- [ ] **Step 2: Kjør testene, verifiser at de nye feiler**

Run: `node --test tests/js/javascript-engine.test.js`
Expected: FAIL på de nye (`E._makeScope is not a function` osv.), Task 1-testene fortsatt PASS.

- [ ] **Step 3: Implementer runtime-halvdelen**

Sett inn FØR `global.JsEngine = {…}` og utvid eksporten:

```js
  // ── Runtime-halvdel ────────────────────────────────────────────────────

  // Scope-proxy: has() → true gjør at ALLE navneoppslag i with-blokken går
  // via proxyen — get faller tilbake til window-globaler, og oppslag som
  // ikke finnes noe sted kaster ReferenceError (ellers ville skrivefeil
  // stille blitt undefined). set skriver alltid til scope-objektet.
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

  async function tableFromLoad(l) {
    var aq = global.aq;
    if (l.format === 'csv') return aq.fromCSV(new TextDecoder().decode(l.bytes));
    if (l.format === 'json') {
      var parsed = JSON.parse(new TextDecoder().decode(l.bytes));
      return Array.isArray(parsed) ? aq.from(parsed) : aq.table(parsed);
    }
    if (l.format === 'parquet') {
      if (typeof global.__brythonParquetColumns !== 'function') {
        throw new Error('parquet-kilden «' + l.alias + '» støttes ikke: DuckDB-hjelperen mangler');
      }
      return aq.table(await global.__brythonParquetColumns(l.bytes));
    }
    throw new Error('formatet «' + l.format + '» (' + l.alias + ') støttes ikke i JavaScript-modus — bruk python/r');
  }
  async function bindLoads(scope, loads) {
    var withBytes = (loads || []).filter(function (l) { return l && l.bytes; });
    if (!withBytes.length) return;
    await ensureLibs(['aq']);
    for (var i = 0; i < withBytes.length; i++) {
      scope.vars[withBytes[i].alias] = await tableFromLoad(withBytes[i]);
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
      scope.vars[names[i]] = global.aq.table(await global.__brythonParquetColumns(bytes));
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
```

og bytt eksporten til:

```js
  global.JsEngine = {
    load: load, run: run,
    notebookSession: { ensure: nbEnsure, runCell: nbRunCell, reset: nbReset,
                       invalidate: nbInvalidate, isLive: nbIsLive },
    _prepass: prepass, _splitLastExpr: splitLastExpr, _scanLibs: scanLibs,
    _scanDuckUses: scanDuckUses, _prettyPrint: prettyPrint,
    _valueToOutput: valueToOutput, _makeScope: makeScope, _runIn: runIn
  };
```

- [ ] **Step 4: Kjør testene**

Run: `node --test tests/js/javascript-engine.test.js`
Expected: PASS (alle, gamle + nye)

- [ ] **Step 5: Commit**

```bash
git add js/javascript-engine.js tests/js/javascript-engine.test.js
git commit -m "feat(js-mode): runtime — scope-proxy, kjøring, console-fangst, lazy CDN-libs, notebookSession"
```

---

### Task 3: cells.js — javascript som celletype

**Files:**
- Modify: `js/cells.js:12-14` (TYPES/ALIASES), `js/cells.js:597-598` (KIND_FOR_TYPE)
- Test: `tests/js/cells.test.js` (nye tester)

**Interfaces:**
- Produces: `Cells.normalizeType('js') === 'javascript'`; `Cells.KIND_FOR_TYPE.javascript === 'javascript'`; dermed virker `engineRunPlan()`, `isRunnableType('javascript')` og celle-dropdownen automatisk (de leser TYPES/KIND_FOR_TYPE generisk). `paramLangForType('javascript')` forblir null (inert #@param i v1 — bevisst).

- [ ] **Step 1: Skriv failende tester (append i tests/js/cells.test.js)**

```js
test('javascript er en kjørbar celletype med engine-kind', () => {
  assert.strictEqual(Cells.normalizeType('javascript'), 'javascript');
  assert.strictEqual(Cells.normalizeType('js'), 'javascript');
  assert.strictEqual(Cells.KIND_FOR_TYPE.javascript, 'javascript');
  assert.strictEqual(Cells.isRunnableType('javascript'), true);
  assert.strictEqual(Cells.paramLangForType('javascript'), null);
});
```

(Sjekk toppen av testfila for hvordan `Cells` hentes — samme mønster som eksisterende tester.)

- [ ] **Step 2: Kjør testene, verifiser FAIL**

Run: `node --test tests/js/cells.test.js`
Expected: FAIL — `normalizeType('javascript')` er null.

- [ ] **Step 3: Gjør endringene**

`js/cells.js` linje 12-14:

```js
  var TYPES = ['python', 'r', 'duckdb', 'brython', 'micropython', 'javascript', 'microdata',
               'statx', 'md', 'html', 'skip'];
  var ALIASES = { py: 'python', pyodide: 'python', js: 'javascript', markdown: 'md', text: 'md' };
```

`js/cells.js` KIND_FOR_TYPE (~597):

```js
  var KIND_FOR_TYPE = { python: 'pyodide', r: 'r', duckdb: 'duckdb',
                        microdata: 'microdata',
                        brython: 'brython', micropython: 'micropython',
                        javascript: 'javascript' };
```

- [ ] **Step 4: Kjør ALLE cells-testene**

Run: `node --test tests/js/cells.test.js tests/js/cells-dom.test.js`
Expected: PASS (nye + alle eksisterende — ingen regresjon)

- [ ] **Step 5: Commit**

```bash
git add js/cells.js tests/js/cells.test.js
git commit -m "feat(js-mode): javascript-celletype i cells.js (TYPES/alias js/KIND_FOR_TYPE)"
```

---

### Task 4: index.html — modusregistrering (alle berøringspunkter) + html-embed

Berøringspunktene er katalogisert fra grep etter `'brython'` — hvert punkt under er verifisert i koden per 2026-07-19 (linjenumre er ca. og forskyves av tidligere edits; finn dem med de siterte kodefragmentene).

**Files:**
- Modify: `index.html` (punktene under)

**Interfaces:**
- Consumes: `window.JsEngine` (Task 2-kontrakten), `Cells.KIND_FOR_TYPE.javascript` (Task 3).
- Produces: modusen `javascript` er velgbar, kjørbar (plain + notatbok), og `buildOutputNodes` rendrer embed-typen `html`.

- [ ] **Step 1: Script-tag** — etter `<script src="js/brython-engine.js?v=…">` (~578):

```html
  <script src="js/javascript-engine.js?v=2026-07-19a"></script>
```

- [ ] **Step 2: Modusknapp** — etter MicroPython-knappen (~305):

```html
          <button type="button" data-mode="javascript">JavaScript</button>
```

- [ ] **Step 3: JS_HL_CFG** — etter `SQL_HL_CFG` (~2499):

```js
    const JS_HL_KW = new Set(['const','let','var','function','class','return','if','else',
      'for','while','do','switch','case','default','break','continue','new','delete','typeof',
      'instanceof','in','of','try','catch','finally','throw','async','await','yield',
      'import','export','extends','super','this','true','false','null','undefined']);
    const JS_HL_FN = new Set(['console','Math','JSON','Object','Array','String','Number',
      'Boolean','Date','Promise','Map','Set','RegExp','parseInt','parseFloat','isNaN','fetch',
      'aq','op','ss','jStat','ML','Plot','Plotly']);
    // commentChar '#' med vilje: # load/#%%-direktivlinjer farges som
    // kommentarer (motoren stripper dem før eval); '//' via commentPrefix.
    const JS_HL_CFG = { commentChar: '#', commentPrefix: '//', triple: false,
      identStart: /[A-Za-z_$]/, identPart: /[A-Za-z0-9_$]/, kw: JS_HL_KW, fn: JS_HL_FN };
```

- [ ] **Step 4: MODES-oppføring** — etter `micropython:`-oppføringen (~3423, før `};`). Speiler micropython-raden nøyaktig, med JsEngine:

```js
      javascript: { id: 'javascript', label: 'JavaScript', hlConfig: JS_HL_CFG, handleTab: handlePythonTab,
        onActivate: function () { if (window.JsEngine) window.JsEngine.load().catch(function () {}); },
        runSelf: async function (script, ctx) {
          var _dl = await window.DataLoader.resolveAndFetchLoads(script,
            { anthropicKey: getAnthropicKey(), promptKey: mdPromptKey });
          // '#tag.import' — samme wiring som Brython-/MicroPython-radene over.
          try { await window.mdEnsureTagImports(ctx.rightStatus); }
          catch (e) { console.warn('#tag.import (javascript runSelf):', e); }
          setStatus(ctx.rightStatus, t('Kjører…'));
          // Samme ui.*/doc-forbehold som motor-radene over: tøm FØR, ikke etter.
          window.mdClearOutputAreaUnlessDoc();
          nbUiRunCtx = { cellIdx: null, cellEl: null, doc: true };
          if (window.Ui && window.Ui.beginCellRun) window.Ui.beginCellRun(null);
          var res;
          try {
            res = await window.JsEngine.run(script, { loads: _dl.loads });
          } finally {
            nbUiRunCtx = null;
            if (window.Ui && window.Ui.endCellRun) window.Ui.endCellRun(null);
          }
          var _omEl = document.querySelector('input[name="outputMode"]:checked');
          var _asHtml = !_omEl || _omEl.value === 'html';
          var _suppress = (typeof suppressEmbedded !== 'undefined' && suppressEmbedded) ? !!suppressEmbedded.checked : false;
          if (outputArea.querySelector('[data-ui-shown]')) {
            appendOutput(res.text || '', _asHtml, _suppress);
          } else {
            renderOutput(res.text || '', _asHtml, _suppress);
          }
          if (window.Ui && window.Ui.reattachDocStrips) window.Ui.reattachDocStrips();
          if (res.error) {
            var _pre = document.createElement('pre');
            _pre.className = 'error';
            _pre.textContent = res.error;
            outputArea.appendChild(_pre);
          }
          setStatus(ctx.rightStatus, res.error ? t('Feil') : t('Ferdig'));
        } },
```

- [ ] **Step 5: RUNTIME_FOR_MODE** (~3450): legg til `javascript: 'javascript'` i objektet.

- [ ] **Step 6: Motor-invalidering ved modusbytte** — ved `// Fase C: motor-sesjonene er også modus-bundet` (~3460):

```js
      if (window.JsEngine && window.JsEngine.notebookSession) window.JsEngine.notebookSession.invalidate();
```

- [ ] **Step 7: editorContent/editorBP** (~3892): legg til `javascript: ''` og `javascript: new Set()`.

- [ ] **Step 8: STARTUP-eksempel** — etter `_STARTUP_BRYTHON` (~3786):

```js
    const _STARTUP_JS = [
      '// OpenStat — JavaScript: kjører direkte i nettleseren, ingen nedlasting.',
      '// Biblioteker lastes automatisk når de brukes: aq/op (Arquero, dataframes),',
      '// ss (simple-statistics), jStat (fordelinger), ML (ml.js), Plot, Plotly.',
      '# load ' + _DATA_RAW + 'iris.csv as iris',
      '',
      'const stats = iris',
      '  .groupby("species")',
      '  .rollup({ n: op.count(), snitt: op.mean("sepal_length") });',
      'console.log("Begerbladlengde per art:");',
      'stats',
    ].join('\n');
```

og i `STARTUP_EXAMPLES` (~3789): legg til `javascript: _STARTUP_JS`.

- [ ] **Step 9: Mode-lister** — eksempelmeny-gaten (~1529): legg til `|| mode === 'javascript'`; `#options.mode`-listen (~2035): legg til `'javascript'` i arrayen, og rett over (der `_wanted === 'py'` normaliseres): legg til `if (_wanted === 'js') _wanted = 'javascript';`

- [ ] **Step 10: Boot-gren** — etter micropython-grenen (~9640):

```js
    } else if (runtimeForMode(activeEditorMode) === 'javascript') {
      // JavaScript-modus har ingen runtime å boote — klar umiddelbart.
      runtimeReadyBootstrap(null);
```

- [ ] **Step 11: Kjør alle-reset** (~9986): utvid begge motor-betingelsene:

```js
        if (activeEditorMode === 'brython' || activeEditorMode === 'micropython' || activeEditorMode === 'javascript') {
          var _eng = activeEditorMode === 'brython' ? window.BrythonEngine
                   : activeEditorMode === 'javascript' ? window.JsEngine
                   : window.MicroPythonEngine;
```

- [ ] **Step 12: isLive-sjekken** (~10049) — legg til gren:

```js
        if (activeEditorMode === 'javascript' && window.JsEngine && window.JsEngine.notebookSession) {
          return window.JsEngine.notebookSession.isLive();
        }
```

- [ ] **Step 13: runtime()-klemmen** (~10063): legg til `|| m === 'javascript'`.

- [ ] **Step 14: Fase C-dispatch** — `runNotebookEngineCell` (~10245):

```js
      var engine = kind === 'brython' ? window.BrythonEngine
                 : kind === 'javascript' ? window.JsEngine
                 : window.MicroPythonEngine;
```

kind-porten (~10307): `if (kind === 'brython' || kind === 'micropython' || kind === 'javascript') {`
fremmed-kind-notisen (~10318): legg til `|| activeEditorMode === 'javascript'`.

- [ ] **Step 15: Kjør alle-grenen i btnRun** (~10648): legg til `|| activeEditorMode === 'javascript'` i Cells.active()-betingelsen.

- [ ] **Step 16: html-embedType** — i buildOutputNodes, ny gren FØR `} else {`-fallbacken (~6296):

```js
            } else if (p.embedType === 'html' && p.payload) {
              // JavaScript-modusens DOM-verdier (Observable Plot-SVG m.m.).
              // Payloaden kommer fra brukerens egen kode i brukerens egen
              // nettleser — samme tillitsnivå som html-celler etter trust-
              // gaten og ui.* sin direkte DOM-skriving.
              const hDiv = document.createElement('div');
              hDiv.className = 'output-html-embed';
              hDiv.innerHTML = p.payload;
              frag.appendChild(hDiv);
```

- [ ] **Step 17: Eksponer duck-uttrekket** — rett etter `async function __duckUseBytes(name) {…}` (~2867):

```js
    window.__duckUseBytes = __duckUseBytes;   // JavaScript-motorens use-from-duckdb
```

- [ ] **Step 18: Verifiser med node-syntakssjekk + full js-testsuite**

Run: `node --check js/javascript-engine.js && node --test tests/js/`
Expected: PASS. (index.html-endringene browser-verifiseres i Task 6.)

- [ ] **Step 19: Commit**

```bash
git add index.html
git commit -m "feat(js-mode): modusregistrering i index.html — MODES, runtime, Fase C, html-embed, duck-use"
```

---

### Task 5: i18n + hjelpesider

**Files:**
- Modify: `js/i18n/en.js` (nye strenger), `hjelp.html`, `hjelp.en.html` (JavaScript-seksjon)

**Interfaces:**
- Consumes: strengene brukt i Task 2/4 (`'Kjører…'`, `'Feil'`, `'Ferdig'` finnes alt; motorens feilstrenger oversettes ikke — samme praksis som brython-engine).

- [ ] **Step 1: en.js** — sjekk om noen NYE `t('…')`-strenger ble innført i Task 4 (grep diffen etter `t('`). Per planen gjenbrukes kun eksisterende strenger; hopp over hvis ingen nye.

- [ ] **Step 2: Hjelpesider** — legg til en seksjon i `hjelp.html` (norsk) og `hjelp.en.html` (engelsk) etter Brython-seksjonen (finn med grep etter "Brython"), samme HTML-struktur som naboseksjonene. Innhold (norsk; oversett tilsvarende for engelsk):

```html
<h3 id="javascript">JavaScript</h3>
<p>Kjører JavaScript direkte i nettleseren — ingen nedlasting av runtime.
Bibliotekene lastes automatisk fra CDN når koden bruker dem:</p>
<ul>
  <li><code>aq</code> / <code>op</code> — <a href="https://idl.uw.edu/arquero/">Arquero</a>: dataframes (filter, groupby, rollup, join, pivot)</li>
  <li><code>ss</code> — <a href="https://simple-statistics.github.io/">simple-statistics</a>: deskriptiv statistikk, t-tester, lineær regresjon</li>
  <li><code>jStat</code> — <a href="https://jstat.github.io/">jStat</a>: sannsynlighetsfordelinger og p-verdier</li>
  <li><code>ML</code> — <a href="https://github.com/mljs/ml">ml.js</a>: regresjon, PCA, k-means, random forest</li>
  <li><code>Plot</code> — <a href="https://observablehq.com/plot/">Observable Plot</a> og <code>Plotly</code> — grafikk</li>
</ul>
<p>Data inn med <code># load &lt;url&gt; as &lt;navn&gt;</code> (blir en Arquero-tabell),
og <code># use &lt;navn&gt; from duckdb</code> henter en tabell fra forrige
SQL-kjøring. Variabler overlever mellom celler; siste uttrykk i en celle
vises automatisk (tabeller som HTML, <code>{data, layout}</code>-objekter som
Plotly-figur). <code>#%%</code>-celler og notatbokvisningen virker som i
Python-modus.</p>
```

- [ ] **Step 3: Commit**

```bash
git add hjelp.html hjelp.en.html js/i18n/en.js
git commit -m "docs(js-mode): hjelpeseksjon (no/en) for JavaScript-modus"
```

---

### Task 6: Nettleser-røyk (verifisering ende-til-ende)

**Files:**
- Create: `manual_scripts/javascript_smoke.js` (røykscriptet som limes inn)

**Interfaces:**
- Consumes: hele kjeden fra Task 1–5.

- [ ] **Step 1: Røykscript**

`manual_scripts/javascript_smoke.js`:

```js
// Røyk for JavaScript-modus — lim inn i editoren i javascript-modus og Kjør.
// Forventet: konsollutskrift, HTML-tabell, Plotly-figur, Observable Plot-SVG.
# load https://raw.githubusercontent.com/mwaskom/seaborn-data/master/iris.csv as iris

console.log("rader:", iris.numRows());
const stats = iris
  .groupby("species")
  .rollup({ n: op.count(), snitt: op.mean("sepal_length") });
console.log("t-test setosa vs virginica (sepal_length):");
const setosa = iris.filter(d => d.species === "setosa").array("sepal_length");
const virginica = iris.filter(d => d.species === "virginica").array("sepal_length");
console.log("p =", ss.tTestTwoSample(setosa, virginica));
stats
```

(Nøyaktig iris-URL: bruk samme `_DATA_RAW`-kilde som `_STARTUP_BRYTHON` — les den ut av index.html og bruk den i scriptet.)

- [ ] **Step 2: Start lokal server og verifiser i nettleser** (chrome-devtools-MCP eller claude-in-chrome):

```bash
python3 -m http.server 8788 &
```

Sjekkliste i nettleseren på `http://localhost:8788/index.html`:
1. Modusvelgeren viser «JavaScript»; bytt til den → oppstartseksemplet vises.
2. Kjør oppstartseksemplet → console-tekst + HTML-tabell i output.
3. Lim inn røykscriptet → Kjør → alle fire output-typene.
4. Notatbok: script med `#%%`-celler (`#%%`-preambel med `# load`, celle med `const x = …`, celle med `x`-uttrykk) → kjør celle 1, så celle 2 → verdien vises (økt-persistens).
5. «Kjør» i notatbok (Kjør alle) → restart + alle celler på nytt.
6. Modusbytte bort og tilbake → sesjonschip «kald», neste kjøring re-binder `# load`.
7. Plotly-test: `({data: [{x: [1,2,3], y: [2,1,3], type: "bar"}], layout: {title: "test"}})` som siste uttrykk → figur med app-tema.
8. Observable Plot-test: `Plot.dot(iris.objects(), {x: "sepal_length", y: "sepal_width"}).plot()` → SVG i output.
9. duckdb-interop: kjør `CREATE TABLE t1 AS SELECT 1 AS a;` i SQL-modus, bytt til javascript, `# use t1 from duckdb` + `t1` → tabell vises.
10. Feilvei: `foo(` → norsk SyntaxError-tekst i rød pre; `ukjentnavn` → ReferenceError med hint.

- [ ] **Step 3: Fiks det som ryker, re-verifiser, commit**

```bash
git add manual_scripts/javascript_smoke.js
git commit -m "test(js-mode): manuelt røykscript + browser-verifisering"
```

---

## Self-review (utført under planskriving)

- **Spec-dekning:** §1 registrering → Task 4; §2 motor/økt → Task 1+2; §3 visning → Task 1 (valueToOutput) + Task 4 Step 16; §4 biblioteker → Task 1/2 (LIB_REGISTRY, verifiserte URL-er); §5 datadirektiver → Task 2 (bindLoads/bindDuckUses) + Task 4 Step 17; §6 eksempel/i18n/docs → Task 4 Step 8 + Task 5; §7 feilhåndtering → Task 2 (runIn-kontrakten, CDN-feil via loadJsDep-reject); §8 testing → Task 1–3 (node) + Task 6 (browser).
- **Avvik fra spec:** `# use from duckdb` VAR med i spec §5 og ER med (Task 2/4) — ikke utsatt. Eksempelmeny-oppføringer (spec §6 «hvis lett») er utelatt i v1 — kun startup-eksempel + røykscript.
- **Typekonsistens:** `JsEngine`-navnet, `notebookSession`-metodene (ensure/runCell/reset/invalidate/isLive) og `{text, error}`-formen er identiske i Task 2 (definisjon) og Task 4 (bruk). `loads`-formen `[{alias, bytes, format}]` matcher DataLoader (js/data-loader.js:72).
