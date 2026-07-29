# Rad-filtrering i monteringsspråket (`where=` + `filter()`) — implementasjonsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rad-filtrering i monteringsspråket: `where=`-kwarg på `add` (per kilde, før join) og `filter()`-verb (på montert datasett, etter join), med felles uttrykksgrammatikk som emitteres identisk til SQL (DuckDB), pandas og R.

**Architecture:** Én uttryksparser i `js/data-directives.js` produserer en AST (`[{col, op, value}, …]`, AND-et liste) som lagres på import-steget (`where:`) hhv. som eget step (`{op:'filter', where:}`). Tre emitterere konsumerer AST-en: `js/assembly-duckdb.js` (WHERE-klausul — dekker r/brython/mpy/js/sql-modus + python-pushdown), pandas-fallback-preamblet i `index.html`, og `js/portable-export.js` (python/R-eksport). Motorfilene røres ikke.

**Tech Stack:** Vanilla JS (IIFE-moduler på `globalThis`), node:test, Pyodide/pandas (generert preamble), DuckDB-WASM SQL.

**Spec:** `docs/superpowers/specs/2026-07-29-row-filter-montering-design.md`

## Global Constraints

- NA/NULL-semantikk er SQL-kanonisk i ALLE backends: rader med NULL/NaN i filterkolonnen droppes av alle betingelser, også `!=` (spec §4). pandas: `& .notna()` ved `!=`; R: radindeks via `which(…)`.
- Grammatikk v1 (spec §3): `betingelse (and betingelse)*`; op ∈ `== != < <= > >= in`; verdi = tall | `'streng'`/`"streng"` | `[liste]` (kun `in`). Kolonne: unicode-identifikator eller backtick-sitert. ALT annet er høylytt feil med linjenummer; `=` gir hint «mente du ==?», `or` gir hint om `in`.
- `filter` kjører ALLTID etter alle add og join (pass-rekkefølge add, join, filter), uansett linjeplassering (spec §2).
- Ingen bakoverkompat-hensyn (ingen brukere) — men eksisterende tester skal fortsatt passere.
- Testkommando (= CI): `node --test 'tests/js/*.test.js'` fra repo-rot `/Users/hom/Documents/GitHub/openstat`.
- Commit etter hver task. IKKE push — push i openstat er Hans' beslutning.
- Kommentarstil: norsk, forklarer hvorfor/kontrakt, refererer spec-§ (se eksisterende filer).

---

### Task 1: Uttryksparser `parseWhereExpr` i data-directives.js

**Files:**
- Modify: `js/data-directives.js` (ny funksjon rett FØR `function parseAssembly` på linje 579; eksport på linje 895)
- Test: `tests/js/directive-semantics.test.js` (nye tester nederst)

**Interfaces:**
- Produces: `DataDirectives._parseWhereExpr(str)` → `{ conds: [{col: string, op: '=='|'!='|'<'|'<='|'>'|'>='|'in', value: number|string|Array}] }` ELLER `{ error: string }`. Task 2–5 konsumerer AST-formen `[{col, op, value}]`.

- [ ] **Step 1: Skriv failende tester**

Nederst i `tests/js/directive-semantics.test.js`:

```js
// ── where-uttrykk (spec 2026-07-29-row-filter-montering §3) ──

test('parseWhereExpr: tall, streng, and', () => {
  const r = DD._parseWhereExpr("folketall > 5000 and fylke == 'Oslo'");
  assert.deepEqual(r, { conds: [
    { col: 'folketall', op: '>', value: 5000 },
    { col: 'fylke', op: '==', value: 'Oslo' },
  ] });
});

test('parseWhereExpr: in-liste med tall og strenger', () => {
  assert.deepEqual(DD._parseWhereExpr('aar in [2020, 2021]'),
    { conds: [{ col: 'aar', op: 'in', value: [2020, 2021] }] });
  assert.deepEqual(DD._parseWhereExpr('fylke in ["Oslo", "Viken"]'),
    { conds: [{ col: 'fylke', op: 'in', value: ['Oslo', 'Viken'] }] });
});

test('parseWhereExpr: unicode-kolonner og backticks', () => {
  assert.deepEqual(DD._parseWhereExpr('år >= 2020'),
    { conds: [{ col: 'år', op: '>=', value: 2020 }] });
  assert.deepEqual(DD._parseWhereExpr('`hele landet` != 0'),
    { conds: [{ col: 'hele landet', op: '!=', value: 0 }] });
});

test('parseWhereExpr: negative tall og desimaltall', () => {
  assert.deepEqual(DD._parseWhereExpr('endring < -0.5'),
    { conds: [{ col: 'endring', op: '<', value: -0.5 }] });
});

test('parseWhereExpr: = gir hint om ==', () => {
  assert.match(DD._parseWhereExpr("fylke = 'Oslo'").error, /mente du «==»/);
});

test('parseWhereExpr: or avvises med in-hint', () => {
  assert.match(DD._parseWhereExpr('a > 1 or b > 2').error, /or støttes ikke/);
});

test('parseWhereExpr: parenteser, tomme uttrykk og rester avvises', () => {
  assert.ok(DD._parseWhereExpr('(a > 1)').error);
  assert.ok(DD._parseWhereExpr('').error);
  assert.ok(DD._parseWhereExpr('a > 1 b').error);
  assert.ok(DD._parseWhereExpr('a in []').error);
  assert.ok(DD._parseWhereExpr('a in 5').error);
  assert.ok(DD._parseWhereExpr('a == b').error);   // kolonne-mot-kolonne: verdi må være literal
});
```

- [ ] **Step 2: Kjør — verifiser FAIL**

Run: `node --test tests/js/directive-semantics.test.js`
Expected: de nye testene feiler med `DD._parseWhereExpr is not a function`.

- [ ] **Step 3: Implementer parseren**

I `js/data-directives.js`, rett før `function parseAssembly(script) {` (linje 579):

```js
  // where/filter-uttrykk (spec 2026-07-29-row-filter-montering §3):
  // «kolonne op verdi (and …)*». Lukket grammatikk — or, parenteser,
  // aritmetikk og kolonne-mot-kolonne er høylytte feil, ikke stille
  // passthrough: uttrykket skal oversettes IDENTISK til SQL, pandas og R,
  // og alt de tre emitterne ikke kan garantere likt, avvises her.
  // Returnerer {conds:[{col,op,value}]} eller {error}.
  function parseWhereExpr(src) {
    var s = String(src == null ? '' : src), i = 0, conds = [];
    function ws() { while (i < s.length && (s.charAt(i) === ' ' || s.charAt(i) === '\t')) i++; }
    function ident() {
      if (s.charAt(i) === '`') {
        var j = s.indexOf('`', i + 1);
        if (j < 0 || j === i + 1) return null;
        var name = s.slice(i + 1, j); i = j + 1;
        return name;
      }
      var m = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(s.slice(i));
      if (!m) return null;
      i += m[0].length;
      return m[0];
    }
    function literal() {
      var c = s.charAt(i);
      if (c === "'" || c === '"') {
        var j = s.indexOf(c, i + 1);
        if (j < 0) return { error: 'streng mangler avsluttende ' + c };
        var v = s.slice(i + 1, j); i = j + 1;
        return { value: v };
      }
      var m = /^-?\d+(?:\.\d+)?/.exec(s.slice(i));
      if (m) { i += m[0].length; return { value: parseFloat(m[0]) }; }
      return { error: 'forventet tall eller \'streng\' (kolonne-mot-kolonne støttes ikke)' };
    }
    for (;;) {
      ws();
      var col = ident();
      if (!col) return { error: 'forventet kolonnenavn (identifikator eller `backticks`), fikk «' + s.slice(i, i + 20) + '»' };
      ws();
      var op = null, two = s.slice(i, i + 2);
      if (two === '==' || two === '!=' || two === '<=' || two === '>=') { op = two; i += 2; }
      else if (s.charAt(i) === '<' || s.charAt(i) === '>') { op = s.charAt(i); i += 1; }
      else if (s.charAt(i) === '=') return { error: '«=» er ikke en sammenligning — mente du «==»?' };
      else if (/^in\b/.test(s.slice(i))) { op = 'in'; i += 2; }
      else return { error: 'ukjent operator ved «' + s.slice(i, i + 10) + '» — gyldige: == != < <= > >= in' };
      ws();
      var val;
      if (op === 'in') {
        if (s.charAt(i) !== '[') return { error: 'in krever en liste — in [verdi, verdi]' };
        i++;
        var list = [];
        for (;;) {
          ws();
          if (s.charAt(i) === ']') { i++; break; }
          var e = literal();
          if (e.error) return { error: e.error };
          list.push(e.value);
          ws();
          if (s.charAt(i) === ',') { i++; continue; }
          if (s.charAt(i) === ']') { i++; break; }
          return { error: 'forventet «,» eller «]» i in-listen' };
        }
        if (!list.length) return { error: 'in-listen er tom' };
        val = list;
      } else {
        var lit = literal();
        if (lit.error) return { error: lit.error };
        val = lit.value;
      }
      conds.push({ col: col, op: op, value: val });
      ws();
      if (i >= s.length) break;
      if (/^and\b/.test(s.slice(i))) { i += 3; continue; }
      if (/^or\b/.test(s.slice(i))) return { error: 'or støttes ikke (v1) — for flere verdier av samme kolonne, bruk in [..]' };
      return { error: 'uventet tekst: «' + s.slice(i) + '»' };
    }
    return { conds: conds };
  }
```

I eksportlinjen (linje 895), legg til `_parseWhereExpr: parseWhereExpr` i objektet:

```js
  global.DataDirectives = { parse: parse, makeLoad: makeLoad, metaByTarget: metaByTarget, resolve: resolve, scrubKeys: scrubKeys, parseAssembly: parseAssembly, translateCanonical: translateCanonical, parseUse: parseUse, parseSegmentUses: parseSegmentUses, runtimeFamily: runtimeFamily, isDirectiveLine: isDirectiveLine, _parseWhereExpr: parseWhereExpr };
```

- [ ] **Step 4: Kjør — verifiser PASS (alle, ikke bare nye)**

Run: `node --test tests/js/directive-semantics.test.js`
Expected: PASS, 0 failing.

- [ ] **Step 5: Commit**

```bash
git add js/data-directives.js tests/js/directive-semantics.test.js
git commit -m "feat(montering): parseWhereExpr — lukket where-grammatikk til AST (spec 2026-07-29 §3)"
```

---

### Task 2: `where=` på add, `filter`-verb, METHODS-oppføring

**Files:**
- Modify: `js/directive-parser.js:104` (METHODS)
- Modify: `js/data-directives.js` (`ASM_KWARGS` linje 595; add/join-passet linje 667-711)
- Test: `tests/js/directive-semantics.test.js`

**Interfaces:**
- Consumes: `parseWhereExpr` fra Task 1.
- Produces: import-steg kan bære `where: [{col,op,value}]` (feltet UTELATES når kwarg mangler); nytt steg-slag `{op:'filter', where:[{col,op,value}]}` som alltid ligger ETTER alle import/join-steg i `d.steps`.

- [ ] **Step 1: Skriv failende tester**

Nederst i `tests/js/directive-semantics.test.js`:

```js
test('parseAssembly: where= på add gir AST på import-steget', () => {
  const a = DD.parseAssembly([
    '# panel = ost.create(key="kommune")',
    '# panel.add(bef, ["folketall"], where="folketall > 5000")',
  ].join('\n'));
  assert.deepEqual(a.errors, []);
  const st = a.spec.datasets[0].steps[0];
  assert.equal(st.op, 'import');
  assert.deepEqual(st.where, [{ col: 'folketall', op: '>', value: 5000 }]);
});

test('parseAssembly: add uten where har IKKE where-felt', () => {
  const a = DD.parseAssembly([
    '# panel = ost.create(key="kommune")',
    '# panel.add(bef, ["folketall"])',
  ].join('\n'));
  assert.equal('where' in a.spec.datasets[0].steps[0], false);
});

test('parseAssembly: ugyldig where-uttrykk gir linjenummer-feil', () => {
  const a = DD.parseAssembly([
    '# panel = ost.create(key="kommune")',
    '# panel.add(bef, ["folketall"], where="folketall or 5")',
  ].join('\n'));
  assert.equal(a.errors.length, 1);
  assert.match(a.errors[0], /linje 2: ugyldig where-uttrykk/);
});

test('parseAssembly: filter etter add+join uansett linjeplassering', () => {
  const a = DD.parseAssembly([
    '# ekstra = fyl.read()',
    '# panel = ost.create(key="kommune")',
    '# panel.filter("folketall < 99999")',
    '# panel.add(bef, ["folketall"])',
    '# panel.join(ekstra, on="kommune")',
  ].join('\n'));
  assert.deepEqual(a.errors, []);
  const ops = a.spec.datasets.find(d => d.name === 'panel').steps.map(s => s.op);
  assert.deepEqual(ops, ['import', 'join', 'filter']);
});

test('parseAssembly: flere filter-linjer AND-es som separate steg i rekkefølge', () => {
  const a = DD.parseAssembly([
    '# panel = ost.create(key="kommune")',
    '# panel.add(bef, ["folketall", "areal"])',
    '# panel.filter("folketall > 100")',
    '# panel.filter("areal > 5")',
  ].join('\n'));
  assert.deepEqual(a.errors, []);
  const steps = a.spec.datasets[0].steps;
  assert.deepEqual(steps.map(s => s.op), ['import', 'filter', 'filter']);
  assert.equal(steps[1].where[0].col, 'folketall');
  assert.equal(steps[2].where[0].col, 'areal');
});

test('parseAssembly: filter avviser tilordning, kwargs og manglende uttrykk', () => {
  const t1 = DD.parseAssembly('# panel = ost.create(key="k")\n# x = panel.filter("a > 1")');
  assert.match(t1.errors[0], /filter returnerer ingenting/);
  const t2 = DD.parseAssembly('# panel = ost.create(key="k")\n# panel.filter("a > 1", how="inner")');
  assert.match(t2.errors[0], /ukjent argument «how» for filter/);
  const t3 = DD.parseAssembly('# panel = ost.create(key="k")\n# panel.filter()');
  assert.match(t3.errors[0], /filter krever et uttrykk/);
});

test('parseAssembly: filter på ukjent datasett gir feil, ikke stillhet', () => {
  const a = DD.parseAssembly('# ukjent.filter("a > 1")');
  assert.match(a.errors[0], /ukjent datasett «ukjent»/);
});

test('parseAssembly: where må være streng', () => {
  const a = DD.parseAssembly([
    '# panel = ost.create(key="k")',
    '# panel.add(bef, ["a"], where=5)',
  ].join('\n'));
  assert.match(a.errors[0], /where må være en streng/);
});
```

- [ ] **Step 2: Kjør — verifiser FAIL**

Run: `node --test tests/js/directive-semantics.test.js`
Expected: FAIL. Merk formen på feilene: uten METHODS-endringen er `# panel.filter(…)` IKKE et parse-tre-kall, så `filter på ukjent datasett`-testen får 0 errors (stille prosa) — det er nettopp fellen METHODS-oppføringen tetter.

- [ ] **Step 3: Implementer**

**a) `js/directive-parser.js:104`:**

```js
  var METHODS = { read: 1, add: 1, join: 1, filter: 1 };
```

**b) `js/data-directives.js:595`:**

```js
    var ASM_KWARGS = { create: ['key', 'format'], add: ['table', 'how', 'where'], join: ['on', 'how'], filter: [] };
```

**c) Pass-løkken (linje 667-711).** Endre pass-arrayen og verb-vakten, og legg inn filter-gren ETTER `checkKwargs` men FØR `checkHow` (filter har ingen how):

```js
    // Pass 2-4: alle add FØR alle join FØR alle filter, uavhengig av
    // rekkefølgen i scriptet. (add/join-begrunnelsen står over; filter sist
    // er kontrakten fra spec 2026-07-29 §2 — filter gjelder det FERDIG
    // monterte datasettet.)
    ['add', 'join', 'filter'].forEach(function (pass) {
    res.items.forEach(function (it) {
      if (it.form !== 'call') return;
      if (it.verb !== 'add' && it.verb !== 'join' && it.verb !== 'filter') return;
      if (it.verb !== pass) return;
```

(Behold resten av den eksisterende innledningen uendret: target-vakten, `var d = byName[it.recv]`-oppslaget, `checkKwargs`.) Rett etter `if (!checkKwargs(it)) return;`, FØR `var how = checkHow(it);`:

```js
      if (it.verb === 'filter') {
        if (it.args.length !== 1 || typeof it.args[0] !== 'string' || !it.args[0].length) {
          errors.push('linje ' + it.lineNo + ': filter krever et uttrykk — filter("kolonne > verdi")');
          return;
        }
        var pf = parseWhereExpr(it.args[0]);
        if (pf.error) { errors.push('linje ' + it.lineNo + ': ugyldig filter-uttrykk — ' + pf.error); return; }
        d.steps.push({ op: 'filter', where: pf.conds });
        return;
      }
```

**d) I add-grenen**, rett før `d.steps.push({ op: 'import', … })` (linje 701), erstatt push-linjen med:

```js
        var step = { op: 'import', source: noteSource(ref.__ref, tbl), columns: cols, how: how };
        if (Object.prototype.hasOwnProperty.call(it.kwargs, 'where')) {
          if (typeof it.kwargs.where !== 'string') {
            errors.push('linje ' + it.lineNo + ': where må være en streng — where="kolonne > verdi"');
            return;
          }
          var pw = parseWhereExpr(it.kwargs.where);
          if (pw.error) { errors.push('linje ' + it.lineNo + ': ugyldig where-uttrykk — ' + pw.error); return; }
          step.where = pw.conds;
        }
        d.steps.push(step);
        return;
```

- [ ] **Step 4: Kjør — verifiser PASS (hele testfila + parser-testene)**

Run: `node --test tests/js/directive-semantics.test.js tests/js/directive-parser.test.js`
Expected: PASS, 0 failing (directive-parser.test.js vokter METHODS-naboskapet).

- [ ] **Step 5: Commit**

```bash
git add js/directive-parser.js js/data-directives.js tests/js/directive-semantics.test.js
git commit -m "feat(montering): where= på add + filter()-verb i parseAssembly (spec 2026-07-29 §2)"
```

---

### Task 3: SQL-emisjon i assembly-duckdb.js

**Files:**
- Modify: `js/assembly-duckdb.js` (ny hjelper etter `quoteLit` linje 35; import-grenen linje 115-125; ny filter-gren etter join-grenen linje 126-135)
- Test: `tests/js/assembly-duckdb.test.js`

**Interfaces:**
- Consumes: `step.where` / `{op:'filter', where:}` AST fra Task 2.
- Produces: WHERE-klausuler i `compile(...)`-SQL. Dekker r/brython/mpy/js/duckdb-modus + python-pushdown uten andre endringer.

- [ ] **Step 1: Skriv failende tester**

Nederst i `tests/js/assembly-duckdb.test.js`:

```js
// ── where/filter (spec 2026-07-29-row-filter-montering §5) ──

test('compile: where på import gir WHERE inne i kildebrikken', () => {
  const spec = { sources: ['p'], datasets: [
    { name: 'd', key: ['pid'], steps: [
      { op: 'import', source: 'p', columns: ['inntekt'], how: 'left',
        where: [{ col: 'inntekt', op: '>', value: 5000 }, { col: 'fylke', op: '==', value: 'Oslo' }] },
    ] },
  ] };
  const sql = AD.compile(spec, DESC).datasetStatements[0].sql;
  assert.match(sql, /FROM read_parquet\('https:\/\/x\/person\.parquet'\) WHERE "inntekt" > 5000 AND "fylke" = 'Oslo'\)/);
});

test('compile: where-strenger escapes (O\'Brien) og != blir <>', () => {
  const spec = { sources: ['p'], datasets: [
    { name: 'd', key: ['pid'], steps: [
      { op: 'import', source: 'p', columns: ['navn'], how: 'left',
        where: [{ col: 'navn', op: '!=', value: "O'Brien" }] },
    ] },
  ] };
  const sql = AD.compile(spec, DESC).datasetStatements[0].sql;
  assert.match(sql, /WHERE "navn" <> 'O''Brien'/);
});

test('compile: in-liste blir IN (…)', () => {
  const spec = { sources: ['p'], datasets: [
    { name: 'd', key: ['pid'], steps: [
      { op: 'import', source: 'p', columns: ['aar'], how: 'left',
        where: [{ col: 'aar', op: 'in', value: [2020, 2021] }] },
    ] },
  ] };
  assert.match(AD.compile(spec, DESC).datasetStatements[0].sql, /WHERE "aar" IN \(2020, 2021\)/);
});

test('compile: filter-steg wrapper ytterst, etter join', () => {
  const spec = { sources: ['p', 's'], datasets: [
    { name: 'a', load: 's' },
    { name: 'b', key: ['pid'], steps: [
      { op: 'import', source: 'p', columns: ['inntekt'], how: 'left' },
      { op: 'join', from: 'a', on: ['pid'], how: 'inner' },
      { op: 'filter', where: [{ col: 'inntekt', op: '<', value: 400000 }] },
    ] },
  ] };
  const sql = AD.compile(spec, DESC).datasetStatements.find(d => d.name === 'b').sql;
  // filter-wrappen skal ligge UTENFOR join-uttrykket
  assert.match(sql, /^SELECT \* FROM \(SELECT \* FROM \(.*INNER JOIN.*\) WHERE "inntekt" < 400000\)$/);
});

test('compile: filter som første steg er ærlig feil', () => {
  const spec = { sources: ['p'], datasets: [
    { name: 'd', key: ['pid'], steps: [{ op: 'filter', where: [{ col: 'x', op: '>', value: 1 }] }] },
  ] };
  assert.throws(() => AD.compile(spec, DESC), /filter krever minst én import først i «d»/);
});
```

- [ ] **Step 2: Kjør — verifiser FAIL**

Run: `node --test tests/js/assembly-duckdb.test.js`
Expected: FAIL (WHERE mangler i SQL; filter-steget faller i dag gjennom uten effekt).

- [ ] **Step 3: Implementer**

I `js/assembly-duckdb.js`, etter `quoteLit` (linje 35):

```js
  // where/filter-emisjon (spec 2026-07-29-row-filter-montering §5): AST fra
  // parseWhereExpr → SQL-predikat. NA-semantikken er SQL-native (NULL faller
  // ut av alle betingelser, også <>) — pandas-/R-emitterne speiler den, se
  // buildAssemblyPreamble og portable-export.js.
  function sqlLit(v) { return typeof v === 'number' ? String(v) : quoteLit(v); }
  function whereClause(conds) {
    return conds.map(function (c) {
      var col = quoteIdent(c.col);
      if (c.op === 'in') return col + ' IN (' + c.value.map(sqlLit).join(', ') + ')';
      var op = c.op === '==' ? '=' : c.op === '!=' ? '<>' : c.op;
      return col + ' ' + op + ' ' + sqlLit(c.value);
    }).join(' AND ');
  }
```

I import-grenen (linje 119), utvid brikke-byggingen:

```js
          var piece = '(SELECT ' + selectCols + ' FROM ' + ref +
            (step.where ? ' WHERE ' + whereClause(step.where) : '') + ')';
```

Etter join-grenen (etter linje 135), ny gren:

```js
        } else if (step.op === 'filter') {
          if (sql === null) throw new Error('filter krever minst én import først i «' + ds.name + '»');
          sql = '(SELECT * FROM ' + sql + ' WHERE ' + whereClause(step.where) + ')';
        }
```

- [ ] **Step 4: Kjør — verifiser PASS**

Run: `node --test tests/js/assembly-duckdb.test.js`
Expected: PASS, 0 failing (også alle eksisterende).

- [ ] **Step 5: Commit**

```bash
git add js/assembly-duckdb.js tests/js/assembly-duckdb.test.js
git commit -m "feat(montering): WHERE-emisjon for where/filter i DuckDB-kompilatoren (spec 2026-07-29 §5)"
```

---

### Task 4: pandas-fallback i buildAssemblyPreamble (index.html)

**Files:**
- Modify: `index.html:8391-8419` (`buildAssemblyPreamble`)

**Interfaces:**
- Consumes: `step.where` / `{op:'filter'}` (JSON-serialisert i `_asmPayload.spec` — følger med automatisk, ingen payload-endring).
- Produces: pandas-montering med SQL-kanonisk NA-semantikk. Kun python-modus uten pushdown treffer denne veien.

- [ ] **Step 1: Erstatt template-strengen**

Hele python-blokken i `buildAssemblyPreamble` (linje 8393-8418) erstattes med:

```js
      return `
# ── Variabel-montering (# connect/create-dataset/import/join) ──
_asm = json.loads(${JSON.stringify(JSON.stringify(payload))})
for _an in (_asm.get('cols') or {}):
    to_microdata(pd.DataFrame(_asm['cols'][_an]), name=_an, make_active=False)
def _asm_mask(df, conds):
    # SQL-kanonisk NA-semantikk (spec 2026-07-29 §4): NaN faller ut av ALLE
    # betingelser — også !=, der pandas ellers ville beholdt NaN-rader og
    # stille gitt et annet radantall enn DuckDB-veien.
    m = None
    for _c in conds:
        _s = df[_c['col']]; _op = _c['op']; _v = _c['value']
        if _op == '==': _r = _s == _v
        elif _op == '!=': _r = (_s != _v) & _s.notna()
        elif _op == '<': _r = _s < _v
        elif _op == '<=': _r = _s <= _v
        elif _op == '>': _r = _s > _v
        elif _op == '>=': _r = _s >= _v
        elif _op == 'in': _r = _s.isin(list(_v))
        else: raise ValueError('ukjent where-operator: ' + str(_op))
        m = _r if m is None else (m & _r)
    return m
if _asm.get('spec'):
    _asrc = {}
    for _f in _asm['files']:
        _asrc[_f['alias']] = pd.read_parquet(_f['path']) if _f['format'] == 'parquet' else pd.read_csv(_f['path'])
    for _ds in _asm['spec']['datasets']:
        if _ds.get('load'):
            to_microdata(_asrc[_ds['load']].copy(), name=_ds['name'], make_active=False)
            continue
        _key = list(_ds.get('key') or [])   # composite keys: alltid liste
        _acc = None
        for _st in _ds.get('steps') or []:
            if _st['op'] == 'import':
                _pool = _asrc[_st['source']]
                # where filtrerer kilden FØR kolonnesubset — kan referere
                # kolonner som ikke importeres (paritet med SQL, spec §2)
                if _st.get('where'): _pool = _pool[_asm_mask(_pool, _st['where'])]
                _cols = _key + [c for c in _st['columns'] if c not in _key]
                _piece = _pool[_cols]
                _acc = _piece.copy() if _acc is None else _acc.merge(_piece, on=_key, how=_st['how'])
            elif _st['op'] == 'join':
                if _acc is None:
                    raise ValueError('join krever minst én import først i «' + _ds['name'] + '»')
                _acc = _acc.merge(e.datasets[_st['from']], on=list(_st['on']), how=_st['how'])
            elif _st['op'] == 'filter':
                if _acc is None:
                    raise ValueError('filter krever minst én import først i «' + _ds['name'] + '»')
                _acc = _acc[_asm_mask(_acc, _st['where'])]
            else:
                raise ValueError('ukjent monterings-steg: ' + str(_st.get('op')))
        to_microdata(_acc, name=_ds['name'], make_active=False)
`;
```

Merk: den gamle bare `else:`-grenen (som fanget ALT ikke-import som join) er nå eksplisitt `elif`-kjede med høylytt `else` — det er spec §5 sitt krav, ikke bare pynt.

- [ ] **Step 2: Verifiser at ingenting annet røk**

Run: `node --test 'tests/js/*.test.js'`
Expected: PASS (preamblet er ikke node-testet; dette vokter naboene). Browser-verifisering skjer i Task 6.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat(montering): where/filter i pandas-fallbacken med SQL-kanonisk NA-semantikk (spec 2026-07-29 §4-5)"
```

---

### Task 5: portable-export.js — python/R-emisjon + NY testfil

**Files:**
- Modify: `js/portable-export.js` (`isAssemblyLine` linje 576-580; nye hjelpere ved `mergeLine` linje 582; step-løkken linje 647-658)
- Create: `tests/js/portable-export.test.js`

**Interfaces:**
- Consumes: `step.where` / `{op:'filter'}` fra Task 2; `pyStr`/`rStr` (linje 83/323).
- Produces: eksportert python/R-kode med filtrering; `PortableExport.transpile(script, mode, registry)` uendret signatur.

- [ ] **Step 1: Skriv failende tester**

Create `tests/js/portable-export.test.js`:

```js
// tests/js/portable-export.test.js — transpile av monteringsdirektiver
// (opprettet med where/filter-runden 2026-07-29; fila var utestet før).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
require('../../js/directive-parser.js');
require('../../js/data-directives.js');
require('../../js/assembly-duckdb.js');
require('../../js/portable-export.js');
const PE = globalThis.PortableExport;

const SCRIPT = [
  '# bef = ost.connect("https://x/bef.parquet")',
  '# panel = ost.create(key="kommune")',
  '# panel.add(bef, ["folketall"], where="folketall > 5000")',
  '# panel.filter("folketall != 99999")',
  '',
  'panel',
].join('\n');

test('transpile python: where filtrerer kilden FØR kolonnesubset', () => {
  const out = PE.transpile(SCRIPT, 'python', []);
  assert.match(out.code,
    /panel = src_bef\[\(src_bef\["folketall"\] > 5000\)\]\[\["kommune", "folketall"\]\]/);
});

test('transpile python: filter-steg med != får .notna()-vern (NA-paritet)', () => {
  const out = PE.transpile(SCRIPT, 'python', []);
  assert.match(out.code,
    /panel = panel\[\(panel\["folketall"\] != 99999\) & panel\["folketall"\]\.notna\(\)\]/);
});

test('transpile r: where blir which()-radindeks i kildeuttrykket', () => {
  const out = PE.transpile(SCRIPT, 'r', []);
  assert.match(out.code,
    /panel <- src_bef\[which\(src_bef\[\["folketall"\]\] > 5000\), c\("kommune", "folketall"\)\]/);
});

test('transpile r: filter-steg blir which()-linje (NA droppes)', () => {
  const out = PE.transpile(SCRIPT, 'r', []);
  assert.match(out.code,
    /panel <- panel\[which\(panel\[\["folketall"\]\] != 99999\), \]/);
});

test('transpile: in-liste blir isin/%in%', () => {
  const s = [
    '# bef = ost.connect("https://x/bef.parquet")',
    '# panel = ost.create(key="kommune")',
    '# panel.add(bef, ["aar"], where="aar in [2020, 2021]")',   // direktiv-literaler: doble fnutter
  ].join('\n');
  assert.match(PE.transpile(s, 'python', []).code, /src_bef\["aar"\]\.isin\(\[2020, 2021\]\)/);
  assert.match(PE.transpile(s, 'r', []).code, /src_bef\[\["aar"\]\] %in% c\(2020, 2021\)/);
});

test('transpile: montering UTEN where/filter er uendret (regresjon)', () => {
  const s = [
    '# bef = ost.connect("https://x/bef.parquet")',
    '# panel = ost.create(key="kommune")',
    '# panel.add(bef, ["folketall"])',
  ].join('\n');
  assert.match(PE.transpile(s, 'python', []).code, /panel = src_bef\[\["kommune", "folketall"\]\]/);
  assert.match(PE.transpile(s, 'r', []).code, /panel <- src_bef\[, c\("kommune", "folketall"\)\]/);
});
```

- [ ] **Step 2: Kjør — verifiser FAIL**

Run: `node --test tests/js/portable-export.test.js`
Expected: where/filter-testene FAIL (filter-steget treffer i dag join-grenen og emitterer en meningsløs mergeLine); regresjonstesten PASS.

- [ ] **Step 3: Implementer**

**a) `isAssemblyLine` (linje 579)** — filter-linjen skal også forankre monteringsblokken:

```js
              ((p.recv === 'ost' && p.verb === 'create') || p.verb === 'add' || p.verb === 'join' || p.verb === 'filter'));
```

**b) Nye hjelpere rett etter `mergeLine` (etter linje 588):**

```js
  // where/filter-emisjon (spec 2026-07-29-row-filter-montering §5).
  // NA-regler er SQL-kanoniske (spec §4): pandas trenger .notna()-vern ved
  // != (NaN != v er ellers True); R-siden bruker which(), som dropper NA.
  function pyLit(v) { return typeof v === 'number' ? String(v) : pyStr(v); }
  function rLit(v) { return typeof v === 'number' ? String(v) : rStr(v); }
  function pyMask(varName, conds) {
    return conds.map(function (c) {
      var s = varName + '[' + pyStr(c.col) + ']';
      if (c.op === 'in') return s + '.isin([' + c.value.map(pyLit).join(', ') + '])';
      if (c.op === '!=') return '(' + s + ' != ' + pyLit(c.value) + ') & ' + s + '.notna()';
      return '(' + s + ' ' + c.op + ' ' + pyLit(c.value) + ')';
    }).join(' & ');
  }
  function rWhich(varName, conds) {
    return 'which(' + conds.map(function (c) {
      var s = varName + '[[' + rStr(c.col) + ']]';
      if (c.op === 'in') return s + ' %in% c(' + c.value.map(rLit).join(', ') + ')';
      return s + ' ' + c.op + ' ' + rLit(c.value);
    }).join(' & ') + ')';
  }
```

**c) Step-løkken (linje 647-658)** erstattes med:

```js
      d.steps.forEach(function (st, si) {
        if (st.op === 'import') {
          var cols = keys.concat(st.columns.filter(function (c) { return keys.indexOf(c) < 0; }));
          var srcVar = 'src_' + st.source;
          var subset;
          if (mode === 'python') {
            var base = st.where ? srcVar + '[' + pyMask(srcVar, st.where) + ']' : srcVar;
            subset = base + '[[' + cols.map(pyStr).join(', ') + ']]';
          } else {
            var rows = st.where ? rWhich(srcVar, st.where) : '';
            subset = srcVar + '[' + rows + ', c(' + cols.map(rStr).join(', ') + ')]';
          }
          if (si === 0) lines.push(mode === 'python' ? (d.name + ' = ' + subset) : (d.name + ' <- ' + subset));
          else lines.push(mergeLine(d.name, subset, keys, st.how, mode));
        } else if (st.op === 'join') {
          lines.push(mergeLine(d.name, st.from, st.on, st.how, mode));
        } else {   // filter (spec 2026-07-29 §2: alltid etter add/join)
          lines.push(mode === 'python'
            ? d.name + ' = ' + d.name + '[' + pyMask(d.name, st.where) + ']'
            : d.name + ' <- ' + d.name + '[' + rWhich(d.name, st.where) + ', ]');
        }
      });
```

- [ ] **Step 4: Kjør — verifiser PASS (hele suiten)**

Run: `node --test 'tests/js/*.test.js'`
Expected: PASS, 0 failing.

- [ ] **Step 5: Commit**

```bash
git add js/portable-export.js tests/js/portable-export.test.js
git commit -m "feat(montering): where/filter i portabel eksport (python/R) + første testfil for portable-export (spec 2026-07-29 §5)"
```

---

### Task 6: Dokumentasjon, eksempel og browser-smoke (pre-push-porten)

**Files:**
- Modify: `docs/directive-language-examples.md` (grammatikk-linjen `METHOD := …` ca. linje 38; §10 «Variable-level assembly» ca. linje 206-223)
- Modify: `docs/directive-language-examples.html` (KUN hvis den inneholder samme METHOD/§10-tekst — sjekk med grep; den er en rendert tvilling)
- Modify: `examples/python/smoke02_montering.txt`

**Interfaces:**
- Consumes: alt fra Task 1-5.
- Produces: dokumentert syntaks + oppdatert smoke-script som utøver begge formene.

- [ ] **Step 1: Oppdater docs/directive-language-examples.md**

Grammatikk-linjen (ca. linje 38):

```
METHOD      := read | add | join | filter
```

Og i listen over navngitte argumenter (ca. linje 48): utvid `add`-omtalen til `how="left"|"inner"|"outer"` on `add`/`join`, and `where="<expr>"` on `add`.

I §10, etter dagens `how=`-eksempel (ca. linje 223), nytt underavsnitt:

```markdown
Row filtering comes in two distinct forms:

```text
# panel.add(p, ["income"], where="income > 5000")   # filters the SOURCE, before the join
# panel.filter("income != 99999")                    # filters the ASSEMBLED dataset, after all add/join
```

`where=` runs before the join — with a left join, rows that fail the
condition in a secondary source stay in the panel with NA. `filter(...)`
runs after all `add`/`join` lines (wherever it appears in the script) and
drops rows. The expression grammar is closed: `column op value`, combined
with `and`; `op` is `== != < <= > >= in`; values are numbers, `'strings'`
or `[lists]` (for `in`); column names may be backtick-quoted. Anything
else — `or`, parentheses, arithmetic, column-vs-column — is a loud error.
NA semantics are SQL-canonical in every mode: rows with NA in a filter
column are dropped by every condition, including `!=`. `where=` may
reference source columns that are not imported. For API sources
(pxweb/eurostat/sdmx/dbnomics/worldbank) the extract is materialized
first, so `where`/`filter` reduce rows locally — they do not shrink the
API download itself (use `filters=`/`years()`/`countries()` on the source
for that). For remote parquet/sqlite/duckdb, `where` is pushed into the
source query.
```

- [ ] **Step 2: Sjekk html-tvillingen**

Run: `grep -n "read | add | join" docs/directive-language-examples.html`
Hvis treff: gjør samme to endringer der (METHOD-linjen + §10-avsnittet, html-formatert som naboteksten). Hvis ikke treff: hopp over.

- [ ] **Step 3: Utvid smoke-scriptet**

`examples/python/smoke02_montering.txt` — utvid med begge formene (behold eksisterende linjer):

```
# label: Smoke 2 — montering (create + add + join + where/filter)
# group: Smoke-test
# Forvent: panel med kommune_navn/fylke_nr/befolkning/fylke_navn, KUN rader
# med 5000 < befolkning < 500000 (Oslo faller ut i filter-steget); ⊞ åpner
# datatabellen. Prøv også portabel eksport (python og r): monteringsblokken
# skal stå FØR panel.head og inneholde både kilde-filteret og filter-linjen.
# kom = ost.connect("https://raw.githubusercontent.com/hmelberg/openstat/main/static_data/kommune.parquet")
# fyl = ost.connect("https://raw.githubusercontent.com/hmelberg/openstat/main/static_data/fylke.parquet")
# panel = ost.create(key="kommune_nr")
# panel.add(kom, ["kommune_navn", "fylke_nr", "befolkning"], where="befolkning > 5000")
# fylke = fyl.read()
# panel.join(fylke, on="fylke_nr")
# panel.filter("befolkning < 500000")

panel.head(10)
```

- [ ] **Step 4: Browser-smoke (manuelt, Hans eller kontrollør m/ browser-verktøy)**

Husk verify-fellene: hard-reload med ignoreCache (Chrome cacher js/), restart netlify dev ved edge-endringer.

1. **Python-modus (pushdown):** kjør smoke02 — forvent filtrert panel (færre rader enn før; ingen rader med befolkning ≤ 5000 eller ≥ 500000).
2. **R-modus:** samme script i R-modus — samme radantall som python-modus (paritetssjekken ER poenget).
3. **Python-fallback:** endre kilden midlertidig til en json-kilde (ikke pushdown-egnet) med where= — forvent samme filtrering via pandas-veien, ingen feil.
4. **Portabel eksport:** eksporter smoke02 til python og r — sjekk at filterlinjene står i monteringsblokken.

Expected: identisk radantall i 1-3; ved avvik: stopp, ikke commit — det er NA-semantikk-regresjonen §4 finnes for.

- [ ] **Step 5: Full suite + commit**

```bash
node --test 'tests/js/*.test.js'
git add docs/directive-language-examples.md docs/directive-language-examples.html examples/python/smoke02_montering.txt
git commit -m "docs(montering): where/filter dokumentert + smoke02 utvidet (spec 2026-07-29 §6)"
```

IKKE push — Hans avgjør push i openstat.

---

## Utenfor planen (bevisst)

- safestat: divergert eldre parser — eget spor (spec §8).
- `or`/parenteser/kolonne-mot-kolonne i grammatikken; `where=` på join/read; dataset-nivå `query()` (spec §8).
- Wrapping av kjøretidsfeil for ukjent kolonne (Binder Error/KeyError er allerede høylytte, spec §6).
