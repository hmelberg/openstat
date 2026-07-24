# format(duckdb) — montert datasett som view i DuckDB-katalogen

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `create-dataset navn, key(k), format(duckdb)` monterer datasettet som
VIEW i den delte DuckDB-wasm-katalogen i stedet for å materialisere det til et
frameformat — null minnekost, kolonner hentes ved behov (parquet via range
requests). I duckdb-modus er view-montering *defaulten* for alle
monteringsdatasett.

**Architecture:** Den kompilerte SQL-en fra `AssemblyDuckdb.compile` blir view-
definisjonen (`CREATE OR REPLACE VIEW navn AS <sql>`). Designbeslutningen som
bevares: et view-register `{navn: sql}` (+ ATTACH-listen) i en ren, node-testbar
modul `js/duckdb-views.js`; `window.__duck.begin()` re-registrerer viewene ved
hver øktstart, siden begin() dropper hele katalogen per kjøring. Registeret
erstattes i sin helhet av hver kjøring som har monteringsdirektiver — scriptet
er sannheten, et script uten format(duckdb) tømmer registeret.

**Tech Stack:** Vanilla JS (var/IIFE-moduler på globalThis med
module.exports-fallback), duckdb-wasm 1.29.0, node --test, pytest.

## Global Constraints

- JS-moduler følger husstilen: IIFE på `(typeof window !== 'undefined' ? window : globalThis)`, `'use strict'`, `var`, norske kommentarer, `module.exports`-fallback for node-testing (mønster: `js/duckdb-native.js`).
- Alle brukersynlige feilmeldinger går via `t('…')` og trenger engelsk oppslag i `js/i18n/en.js`.
- Ingen bakoverkompatibilitet (Hans' beslutning 2026-07): `compile()` sitt returformat ENDRES (attachStatements → attaches), kallstedet oppdateres — ingen dobbel-API.
- `node --test 'tests/js/*.test.js'` og `python3 -m pytest tests/` skal være grønne etter hver task.
- M2PY_VERSION bumpes ÉN gang, i siste task (`2026-07-24u`, index.html:559). sw.js CACHE trenger IKKE bump (app-shell js/index.html SW-caches ikke — se sw.js:77-82).
- Test-kjørekommandoer: `cd /Users/hom/Documents/GitHub/openstat && node --test 'tests/js/*.test.js'` og `python3 -m pytest tests/ -q`.

## Feature-semantikk (fasit for alle tasks)

- `format(duckdb)` på `create-dataset`: datasettet materialiseres IKKE — den
  kompilerte SQL-en registreres som `CREATE OR REPLACE VIEW` i den delte
  duckdb-wasm-katalogen, og navnet legges i view-registeret.
- Tillatt i ALLE moduser (katalogen er motoruavhengig; viewet brukes fra
  `## duckdb`-segmenter og `# use navn from duckdb`). Nye tillatt-lister:
  python/brython/micropython `['pandas','data.frame','duckdb']`, javascript
  `['arquero','duckdb']`, r `['data.frame','data.table','tibble','duckdb']`,
  duckdb-modus `['duckdb']`.
- duckdb-modus (native OG pyodide-fallback): monteringsdatasett UTEN format()
  defaulter til `duckdb` (view-montering) — materialisering har ingen mottaker
  der og avvises av tillatt-listen.
- format(duckdb) + ikke-pushdown-egnet kilde (f.eks. json): høylytt feil ved
  binding (viewets SQL må kunne lese kilden direkte).
- Re-registrering ved øktstart: `__duck.begin()` (fresh-veien) replayer
  registeret ETTER drop-alt-blokken. Replay-feil logges med console.warn og
  stopper IKKE kjøringen (den høylytte feilen kom allerede ved montering; et
  råttent view skal ikke drepe uavhengige SQL-kjøringer).
- ATTACH-idempotens: replay og montering kjører `DETACH "<alias>"` (feil
  svelges) før hver `ATTACH` — dette fikser samtidig den latente
  «att_0 already exists»-fella ved andre gangs kjøring av samme script
  (dagens attach-løkke i resolveAssemblyColumns har den).
- `begin({fresh:false})` (per-celle) hopper over replay — ingenting ble droppet.

---

### Task 1: `js/duckdb-views.js` — view-registeret som ren modul

**Files:**
- Create: `js/duckdb-views.js`
- Test: `tests/js/duckdb-views.test.js`

**Interfaces:**
- Produces: `DuckdbViews.set({views: {navn: sql}, attaches: [{alias, sql}]})`,
  `DuckdbViews.isEmpty() -> bool`, `DuckdbViews.names() -> [navn]`,
  `DuckdbViews.statementsFor({views, attaches}) -> [{sql, ignoreError}]`,
  `DuckdbViews.registrationStatements() -> [{sql, ignoreError}]`.
  Task 3 bruker `set` + `statementsFor`; Task 4 bruker `registrationStatements`.

- [ ] **Step 1: Skriv de feilende testene**

```js
// tests/js/duckdb-views.test.js — view-registeret for format(duckdb)-monterte
// assembly-datasett (js/duckdb-views.js): ren tilstand + statement-bygging,
// ingen duckdb-avhengighet.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const DV = require('../../js/duckdb-views.js');

test('tomt register: isEmpty, ingen replay-statements', () => {
  DV.set(null);
  assert.equal(DV.isEmpty(), true);
  assert.deepEqual(DV.names(), []);
  assert.deepEqual(DV.registrationStatements(), []);
});

test('views uten attaches: én CREATE OR REPLACE VIEW per navn', () => {
  DV.set({ views: { demo: 'SELECT * FROM read_parquet(\'https://x/p.parquet\')' } });
  assert.equal(DV.isEmpty(), false);
  assert.deepEqual(DV.names(), ['demo']);
  const st = DV.registrationStatements();
  assert.equal(st.length, 1);
  assert.equal(st[0].sql, 'CREATE OR REPLACE VIEW "demo" AS SELECT * FROM read_parquet(\'https://x/p.parquet\')');
  assert.equal(st[0].ignoreError, false);
});

test('attaches replayes FØR views, med svelgbar DETACH per alias', () => {
  DV.set({
    views: { panel: 'SELECT * FROM att_0."patients"' },
    attaches: [{ alias: 'att_0', sql: "ATTACH 'https://x/f.duckdb' AS att_0" }],
  });
  const st = DV.registrationStatements();
  assert.deepEqual(st.map(s => [s.sql, s.ignoreError]), [
    ['DETACH "att_0"', true],
    ["ATTACH 'https://x/f.duckdb' AS att_0", false],
    ['CREATE OR REPLACE VIEW "panel" AS SELECT * FROM att_0."patients"', false],
  ]);
});

test('attaches uten views: replay er tom (ingenting å re-registrere)', () => {
  DV.set({ views: {}, attaches: [{ alias: 'att_0', sql: "ATTACH 'u' AS att_0" }] });
  assert.deepEqual(DV.registrationStatements(), []);
});

test('statementsFor emitterer attaches også uten views (monteringsveien)', () => {
  const st = DV.statementsFor({ views: {}, attaches: [{ alias: 'att_0', sql: "ATTACH 'u' AS att_0" }] });
  assert.deepEqual(st.map(s => s.sql), ['DETACH "att_0"', "ATTACH 'u' AS att_0"]);
});

test('set erstatter HELE registeret (ingen gjenferd fra forrige script)', () => {
  DV.set({ views: { gammel: 'SELECT 1' } });
  DV.set({ views: { ny: 'SELECT 2' } });
  assert.deepEqual(DV.names(), ['ny']);
});

test('view-navn quotes som identifikator (″ dobles)', () => {
  const st = DV.statementsFor({ views: { 'a"b': 'SELECT 1' } });
  assert.equal(st[0].sql, 'CREATE OR REPLACE VIEW "a""b" AS SELECT 1');
});
```

- [ ] **Step 2: Kjør testene og se dem feile**

Kjør: `node --test tests/js/duckdb-views.test.js`
Forventet: FAIL — `Cannot find module '../../js/duckdb-views.js'`

- [ ] **Step 3: Skriv modulen**

```js
// js/duckdb-views.js — view-registeret for format(duckdb)-monterte assembly-
// datasett (økt 2026-07-24): {navn: sql} + ATTACH-listen fra
// AssemblyDuckdb.compile. DuckDB-wasm-øktene er ferske per kjøring
// (__duck.begin() dropper hele katalogen) — index.html replayer derfor
// registrationStatements() ved hver øktstart. Registeret erstattes i sin
// helhet av hver kjøring med monteringsdirektiver: scriptet er sannheten,
// og et script uten format(duckdb)-datasett tømmer det.
// Ren modul uten duckdb/DOM-avhengighet: kjører under node --test.
(function (global) {
  'use strict';

  var state = { views: {}, attaches: [] };

  function quoteIdent(id) { return '"' + String(id).replace(/"/g, '""') + '"'; }

  function set(next) {
    state = { views: (next && next.views) || {}, attaches: (next && next.attaches) || [] };
  }

  function isEmpty() { return !Object.keys(state.views).length; }
  function names() { return Object.keys(state.views); }

  // Statement-liste for montering/replay. DETACH-ene er idempotens-vern
  // (ATTACH-er overlever øktbytte i samme wasm-instans, og alias-navnene
  // att_N er per-kompilering) og skal svelges ved feil; resten skal feile
  // hørbart hos kalleren.
  function statementsFor(reg) {
    var out = [];
    ((reg && reg.attaches) || []).forEach(function (a) {
      out.push({ sql: 'DETACH ' + quoteIdent(a.alias), ignoreError: true });
      out.push({ sql: a.sql, ignoreError: false });
    });
    var views = (reg && reg.views) || {};
    Object.keys(views).forEach(function (n) {
      out.push({ sql: 'CREATE OR REPLACE VIEW ' + quoteIdent(n) + ' AS ' + views[n], ignoreError: false });
    });
    return out;
  }

  // Øktstart-replay: uten views er attachene dødvekt — tom liste.
  function registrationStatements() {
    return isEmpty() ? [] : statementsFor(state);
  }

  var api = { set: set, isEmpty: isEmpty, names: names,
              statementsFor: statementsFor, registrationStatements: registrationStatements };
  global.DuckdbViews = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: Kjør testene og se dem passere**

Kjør: `node --test tests/js/duckdb-views.test.js`
Forventet: PASS (7 tester)

- [ ] **Step 5: Full testsuite + commit**

Kjør: `node --test 'tests/js/*.test.js'` — forventet: alt grønt.

```bash
git add js/duckdb-views.js tests/js/duckdb-views.test.js
git commit -m "duckdb-views: view-registeret {navn: sql} som ren modul"
```

---

### Task 2: `AssemblyDuckdb.compile` — strukturerte attaches

**Files:**
- Modify: `js/assembly-duckdb.js` (buildAttaches ~linje 38-53, compile-retur ~linje 136)
- Modify: `index.html` (attach-løkka i resolveAssemblyColumns, ~linje 7452)
- Test: `tests/js/assembly-duckdb.test.js`

**Interfaces:**
- Consumes: dagens `compile(spec, descriptors)`.
- Produces: `compile` returnerer `{ attaches: [{alias, sql}], datasetStatements: [{name, sql}] }`
  — `attachStatements` (ren strengliste) FJERNES (ingen bakoverkompat).
  Task 3 bruker `attaches` som `DuckdbViews`-input.

- [ ] **Step 1: Skriv den feilende testen** (legg til i tests/js/assembly-duckdb.test.js)

```js
test('compile: attaches er strukturerte {alias, sql} (én per unik fil-URL)', () => {
  const desc = {
    a: { url: 'https://x/f.duckdb', format: 'duckdb', table: 'pasienter' },
    b: { url: 'https://x/f.duckdb', format: 'duckdb', table: 'besok' },
    c: { url: 'https://x/g.sqlite', format: 'sqlite', table: 'takster' },
  };
  const spec = { sources: ['a', 'b', 'c'], datasets: [
    { name: 'p', load: 'a' }, { name: 'v', load: 'b' }, { name: 't', load: 'c' },
  ] };
  const out = AD.compile(spec, desc);
  assert.deepEqual(out.attaches, [
    { alias: 'att_0', sql: "ATTACH 'https://x/f.duckdb' AS att_0" },
    { alias: 'att_1', sql: "ATTACH 'https://x/g.sqlite' AS att_1 (TYPE sqlite)" },
  ]);
  assert.equal(out.attachStatements, undefined);
});
```

- [ ] **Step 2: Kjør testen og se den feile**

Kjør: `node --test tests/js/assembly-duckdb.test.js`
Forventet: FAIL — `out.attaches` er undefined.

- [ ] **Step 3: Endre buildAttaches + compile**

I `js/assembly-duckdb.js`, erstatt statements-byggingen i `buildAttaches` (behold byUrl/order-logikken):

```js
    var statements = order.map(function (url) {
      var alias = byUrl[url];
      var typeClause = descriptorFormatForUrl(descriptors, url) === 'sqlite' ? ' (TYPE sqlite)' : '';
      return { alias: alias, sql: 'ATTACH ' + quoteLit(url) + ' AS ' + alias + typeClause };
    });
```

og compile-returen (linje ~136):

```js
    return { attaches: att.statements, datasetStatements: datasetStatements };
```

- [ ] **Step 4: Oppdater kallstedet i index.html**

I `resolveAssemblyColumns` (index.html ~7452), erstatt:

```js
        for (var i = 0; i < cmp.attachStatements.length; i++) await conn.query(cmp.attachStatements[i]);
```

med:

```js
        for (var i = 0; i < cmp.attaches.length; i++) await conn.query(cmp.attaches[i].sql);
```

(Idempotens-DETACHen kommer i Task 3, som skriver om hele denne blokken.)

- [ ] **Step 5: Kjør testene og se dem passere**

Kjør: `node --test tests/js/assembly-duckdb.test.js` — forventet: PASS.
Kjør: `grep -c "attachStatements" js/assembly-duckdb.js index.html` — forventet: 0 treff i begge (ingen rester).

- [ ] **Step 6: Commit**

```bash
git add js/assembly-duckdb.js tests/js/assembly-duckdb.test.js index.html
git commit -m "assembly-duckdb: strukturerte attaches {alias, sql} fra compile"
```

---

### Task 3: `resolveAssemblyColumns` — view-montering + registeroppdatering

**Files:**
- Modify: `index.html` — resolveAssemblyColumns (~7434-7462) + ny hjelper rett over den
- Modify: `js/i18n/en.js` — én ny t()-streng

**Interfaces:**
- Consumes: `DuckdbViews.set/statementsFor` (Task 1), `cmp.attaches` (Task 2).
- Produces: `resolveAssemblyColumns(script, statusEl, opts)` der
  `opts.defaultFormat` (valgfri, f.eks. `'duckdb'`) settes på datasett uten
  eksplisitt format(). Returen får nytt felt `mounted: [navn]` (view-monterte
  datasett; de er IKKE med i `datasets`-kolonnene). Task 5 bruker begge.

- [ ] **Step 1: Ny statement-eksekverer** (legg rett FØR resolveAssemblyColumns, ~linje 7433)

```js
    // Kjør en DuckdbViews-statementliste: ignoreError-setninger (DETACH-
    // idempotensvernet) svelges, resten feiler hørbart.
    async function __duckExecStatements(conn, stmts) {
      for (var i = 0; i < stmts.length; i++) {
        if (stmts[i].ignoreError) { try { await conn.query(stmts[i].sql); } catch (e) {} }
        else await conn.query(stmts[i].sql);
      }
    }
```

- [ ] **Step 2: Skriv om resolveAssemblyColumns**

Erstatt hele funksjonen (signaturen får `opts`; formats-blokken får default;
kroppen splitter view/materialisering). Fullstendig ny kropp:

```js
    async function resolveAssemblyColumns(script, statusEl, opts) {
      var DD = window.DataDirectives;
      if (!DD || !DD.parseAssembly) return null;
      var parsed = DD.parseAssembly(script);
      if (parsed.errors.length) throw new Error('Monteringsfeil: ' + parsed.errors.join('; '));
      if (!(parsed.spec.datasets || []).length) return null;
      var deps = { anthropicKey: getAnthropicKey(), promptKey: mdPromptKey };
      // format(duckdb)-montering (økt 2026-07-24): datasett med format duckdb
      // materialiseres IKKE — den kompilerte SQL-en blir CREATE OR REPLACE
      // VIEW i den delte katalogen, og view-registeret (js/duckdb-views.js)
      // replayes ved hver __duck.begin(). opts.defaultFormat ('duckdb' i
      // duckdb-modus) gjelder datasett uten eksplisitt format().
      var formats = {};
      var defFmt = opts && opts.defaultFormat;
      (parsed.spec.datasets || []).forEach(function (d) {
        if (d.format) formats[d.name] = d.format;
        else if (defFmt) formats[d.name] = defFmt;
      });
      var hasDuckFmt = Object.keys(formats).some(function (n) { return formats[n] === 'duckdb'; });
      var so = await window.DataLoader.resolveSourcesOnly(script, deps);
      if (!window.AssemblyDuckdb.canPushdown(so.spec, so.descriptors)) {
        if (hasDuckFmt) {
          throw new Error(t('format(duckdb) krever kilder DuckDB kan lese direkte (parquet/csv/duckdb/sqlite).'));
        }
        return { pushdown: false, parsed: parsed, deps: deps, formats: formats };
      }
      if (statusEl) setStatus(statusEl, t('Monterer datasett (DuckDB)…'));
      var cmp = window.AssemblyDuckdb.compile(so.spec, so.descriptors);
      var views = {};
      cmp.datasetStatements.forEach(function (d) {
        if (formats[d.name] === 'duckdb') views[d.name] = d.sql;
      });
      // Registeret erstattes i sin helhet — scriptet er sannheten; uten
      // format(duckdb)-datasett tømmes det (ingen gjenferd fra forrige run).
      window.DuckdbViews.set({ views: views, attaches: cmp.attaches });
      var db = await __ensureDuckDB();
      var conn = await db.connect();
      try {
        // DETACH+ATTACH (+ CREATE VIEW for de monterte) via samme statement-
        // bygger som øktstart-replayen; her feiler alt unntatt DETACH hørbart.
        await __duckExecStatements(conn, window.DuckdbViews.statementsFor({ views: views, attaches: cmp.attaches }));
        var cols = {};
        for (var j = 0; j < cmp.datasetStatements.length; j++) {
          var d = cmp.datasetStatements[j];
          if (views[d.name] !== undefined) continue;   // montert som view over
          cols[d.name] = __arrowToColumns(await conn.query(d.sql));
        }
        return { pushdown: true, datasets: cols, formats: formats, mounted: Object.keys(views) };
      } finally { await conn.close(); }
    }
```

- [ ] **Step 3: en.js-oppslag**

Legg til i `js/i18n/en.js` (følg filens eksisterende nøkkel-format):

```js
  'format(duckdb) krever kilder DuckDB kan lese direkte (parquet/csv/duckdb/sqlite).':
    'format(duckdb) requires sources DuckDB can read directly (parquet/csv/duckdb/sqlite).',
```

- [ ] **Step 4: Kjør testene**

Kjør: `node --test 'tests/js/*.test.js'` og `python3 -m pytest tests/ -q`
Forventet: grønt (funksjonen er index.html-inline — browser-verifiseres i Task 7).

- [ ] **Step 5: Commit**

```bash
git add index.html js/i18n/en.js
git commit -m "resolveAssemblyColumns: format(duckdb) monterer view + oppdaterer registeret"
```

---

### Task 4: øktstart-replay i `__duck.begin()` + script-tag

**Files:**
- Modify: `index.html` — `__duck.begin()` (~linje 2262-2281) og script-tag-blokka (~linje 11306)

**Interfaces:**
- Consumes: `DuckdbViews.registrationStatements()` (Task 1).
- Produces: hver ferske duckdb-økt har de monterte viewene tilgjengelig — både
  native duckdb-kjøringer og pyodide-broens `_duck_js.__duck.begin(...)`.

- [ ] **Step 1: Script-tag**

I index.html, FØR `<script src="js/assembly-duckdb.js"></script>` (~linje 11306):

```html
  <script src="js/duckdb-views.js"></script>
```

- [ ] **Step 2: Replay i begin()**

I `__duck.begin(opts)`, rett ETTER drop-alt-løkka (etter `for (let i = 0; …) { … DROP … }`, ~linje 2280), legg til:

```js
        // Re-registrer format(duckdb)-monterte views (view-registeret
        // {navn: sql}, js/duckdb-views.js): øktene er ferske per kjøring —
        // drop-alt over fjernet også dem. Feil her skal ikke drepe en
        // uavhengig SQL-kjøring (den hørbare feilen kom ved montering):
        // warn + fortsett; et manglende view gir uansett tydelig
        // «does not exist»-feil hvis noen spør etter det.
        const _regs = window.DuckdbViews ? window.DuckdbViews.registrationStatements() : [];
        for (let i = 0; i < _regs.length; i++) {
          try { await this.conn.query(_regs[i].sql); }
          catch (e) { if (!_regs[i].ignoreError) console.warn('view-replay:', _regs[i].sql, e); }
        }
```

Merk: replayen ligger i fresh-grenen (etter `if (!fresh) return;`) — per-celle-
kjøringer (`begin({fresh:false})`) dropper ingenting og trenger ingen replay.

- [ ] **Step 3: Kjør testene + commit**

Kjør: `node --test 'tests/js/*.test.js'` — forventet: grønt.

```bash
git add index.html
git commit -m "__duck.begin: replay av view-registeret ved hver ferske økt"
```

---

### Task 5: modus-wiring — tillatt-lister, duckdb-default, native-veien

**Files:**
- Modify: `index.html` — assertAssemblyFormats-kallene (5 steder: ~2713, ~2781, ~2835, ~8428, ~9614), bootNotebookSession (~9610), maybeRunDuckNative (~7633-7708)
- Modify: `js/i18n/en.js` — én ny streng hvis Step 3-meldingen er ny

**Interfaces:**
- Consumes: `resolveAssemblyColumns(script, statusEl, {defaultFormat})` + `mounted` (Task 3).
- Produces: format(duckdb) tillatt i alle moduser; duckdb-modus monterer alle
  monteringsdatasett som views på både native- og fallback-veien.

- [ ] **Step 1: Utvid tillatt-listene (4 av 5 kallsteder)**

- ~2713: `assertAssemblyFormats(_asmX, ['pandas', 'data.frame', 'duckdb'], 'Brython');`
- ~2781: `assertAssemblyFormats(_asmX, ['pandas', 'data.frame', 'duckdb'], 'MicroPython');`
- ~2835: `assertAssemblyFormats(_asmX, ['arquero', 'duckdb'], 'JavaScript');`
- ~8428: `assertAssemblyFormats(_asmR, ['data.frame', 'data.table', 'tibble', 'duckdb'], 'R');`

(Bindingsløkkene itererer over `asm.datasets`-nøklene — view-monterte datasett
er ikke der og hoppes naturlig over; ingen andre endringer i de fire modusene.)

- [ ] **Step 2: bootNotebookSession — duckdb-default på fallback-veien**

Ved ~9610 (i `bootNotebookSession`; deles av python-modus og duckdb-modusens
pyodide-fallback — `ctx.activeEditorMode` finnes i `_bootCtx`):

```js
        var _asmDuckMode = ctx.activeEditorMode === 'duckdb';
        var _asmRes = await resolveAssemblyColumns(effectiveScript, rightStatus,
          _asmDuckMode ? { defaultFormat: 'duckdb' } : null);
        if (_asmRes && _asmRes.formats && Object.values(_asmRes.formats).indexOf('polars') >= 0) {
          throw new Error(t('format(polars) er ikke tilgjengelig i nettleseren ennå (polars mangler wasm-bygg) — dropp format() for pandas.'));
        }
        assertAssemblyFormats(_asmRes,
          _asmDuckMode ? ['duckdb'] : ['pandas', 'data.frame', 'duckdb'],
          _asmDuckMode ? 'duckdb' : 'python');
```

(NB: sjekk de faktiske variabelnavnene i funksjonen — `effectiveScript`/
`rightStatus` kan ligge på `ctx`; bruk det som står der i dag.)

- [ ] **Step 3: maybeRunDuckNative — montering i den native veien**

Rett ETTER hybrid-markør-sjekken (`if (/^\s*(\/\/|##?)…/im.test(script)) return …`, ~7658) og FØR `setStatus(ctx.rightStatus, t('Kjører…'))`:

```js
      // Variabel-montering i duckdb-modus (format(duckdb) er defaulten her):
      // datasettene monteres som views i katalogen — materialisering til et
      // frameformat har ingen mottaker i den native veien og avvises av
      // tillatt-listen. Ikke-pushdown-kilder feiler allerede høylytt inne i
      // resolveAssemblyColumns (defaulten gjør alle datasett til duckdb-format).
      refreshConnectedSources(script);   // fire-and-forget: kildekatalog + tab
      var _asm = await resolveAssemblyColumns(script, ctx.rightStatus, { defaultFormat: 'duckdb' });
      assertAssemblyFormats(_asm, ['duckdb'], 'duckdb');
```

Og rett FØR `lastOutput = _out.join('\n\n');` (~7702), meld fra om monteringen
(samme uoversatte stil som «Opprettet datasett …»-linjene):

```js
      if (_asm && _asm.mounted && _asm.mounted.length) {
        _out.unshift('Montert som view i DuckDB: ' + _asm.mounted.join(', '));
      }
```

Merk: et script med KUN direktiver (ingen SQL) hopper over exec-blokka
(`DN.scrub(_sql).trim()` er tom), men monteringen har allerede skjedd og
`refreshDatasetSidebarFromDuck()` på slutten viser viewet i sidepanelet.

- [ ] **Step 4: Kjør testene**

Kjør: `node --test 'tests/js/*.test.js'` og `python3 -m pytest tests/ -q` — forventet: grønt.

- [ ] **Step 5: Commit**

```bash
git add index.html js/i18n/en.js
git commit -m "format(duckdb) i alle moduser + view-montering som default i duckdb-modus"
```

---

### Task 6: ROADMAP — dokumenter API-kilde-økten (punkt 2 fra Hans)

**Files:**
- Modify: `docs/ROADMAP.md`

- [ ] **Step 1: Ny seksjon**

Legg til etter «## Pakkeinstallasjon (python/r)»-seksjonen:

```markdown
## Datalag / montering (lagt til 2026-07-24)

- [x] **format(duckdb)** — montert datasett som view i DuckDB-katalogen
      (null minnekost, kolonne-henting ved behov); view-registeret
      {navn: sql} i js/duckdb-views.js re-registrerer ved hver øktstart
      (øktene er ferske per kjøring). Levert 2026-07-24.
- [ ] **API-kilder (SSB/PxWeb først)** — nytt connect-kind (`kind(pxweb)`),
      metadata-endepunktet mater kildekatalogen (`__connectedSources`) og
      tab-fullføringen UTEN nedlasting. HARD forutsetning som må løses
      først: composite keys — `key(region aar)` i create-dataset og
      `USING (a, b)` i AssemblyDuckdb-kompilatoren (dagens nøkkel er én
      kolonne hele veien). Eurostat/OECD gjenbruker samme kind-mønster
      etterpå. Egen økt.
```

- [ ] **Step 2: Commit**

```bash
git add docs/ROADMAP.md
git commit -m "ROADMAP: format(duckdb) levert + API-kilde-økten dokumentert"
```

---

### Task 7: verifisering, versjonsbump og push

**Files:**
- Modify: `index.html` (M2PY_VERSION, linje ~559)

- [ ] **Step 1: Full testsuite**

Kjør: `node --test 'tests/js/*.test.js'` og `python3 -m pytest tests/ -q`
Forventet: alt grønt (813+ node, 317 pytest — pluss de nye).

- [ ] **Step 2: Browser-røyktest (ÉN kompakt seanse — token-økonomi, ingen skjermbilder med mindre noe feiler)**

Server: `python3 -m http.server 8123` fra repo-rota; åpne
`http://localhost:8123/index.html` med chrome-devtools-MCP.

Scenario A — duckdb-modus, default-montering + SQL mot viewet
(kommune_year.parquet-kolonnene er verifisert i planleggingen: kommune_nr,
year, SB12843_KOSTRA_EIENDOMSSKATT_I_ALT m.fl.):
1. Bytt til SQL/DuckDB-modus. Kjør:
   ```
   # connect http://localhost:8123/static_data/kommune_year.parquet as ky, kind(parquet)
   # create-dataset demo, key(kommune_nr)
   # import ky/year, ky/SB12843_KOSTRA_EIENDOMSSKATT_I_ALT into demo
   SELECT count(*) AS n FROM demo;
   ```
   Forventet: output inneholder «Montert som view i DuckDB: demo» + tellelinja; sidepanelet viser demo (runtime duckdb).
2. Kjør DERETTER et rent SQL-script `SELECT * FROM demo LIMIT 3;` — forventet:
   virker (beviser øktstart-replayen: begin() droppet katalogen og
   re-registrerte viewet fra registeret).

Scenario B — python-modus, eksplisitt format(duckdb) + hybrid-segment:
```
# connect http://localhost:8123/static_data/kommune_year.parquet as ky, kind(parquet)
# create-dataset demo2, key(kommune_nr), format(duckdb)
# import ky/year, ky/SB12843_KOSTRA_EIENDOMSSKATT_I_ALT into demo2
## duckdb
SELECT count(*) FROM demo2;
```
Forventet: python-kjøringen materialiserer IKKE demo2 (ikke i pandas-sidebaren),
duckdb-segmentet leser viewet.

Feiler noe: stopp, diagnostiser (systematic-debugging), fiks, re-kjør.

- [ ] **Step 3: Versjonsbump**

index.html linje ~559: `window.M2PY_VERSION = '2026-07-24u';`

- [ ] **Step 4: Commit + push**

```bash
git add index.html
git commit -m "format(duckdb): view-montering browser-verifisert + M2PY_VERSION 2026-07-24u"
git push
```

Rapportér til Hans med «pushet og live på <GitHub Pages-URL for openstat>»
FØRST i svaret (hans faste preferanse), og nevn eksplisitt hva som IKKE er
verifisert, om noe.
