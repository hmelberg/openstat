# Federert kilde (pull+union) i openstat — implementasjonsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ost.read` med liste/dict (eller register-id med `kind:"federated"`) leser N csv/parquet-medlemmer som ETT datasett med `__member`-kolonne, i alle moduser.

**Architecture:** Byte-lik port av safestats fase 0: `js/federate.js` (ren SQL-planlegger) + ny loader-gren bak injisert `deps.unionExec` + duckdb-wasm-executor `__federatedUnion` i index.html som materialiserer unionen som parquet-bytes inn i den vanlige lasteveien. Direktivsiden er openstat-egen (pythonsk grammatikk, ingen parserendring — lister/dicts parses allerede).

**Tech Stack:** Vanilla JS (IIFE-moduler), duckdb-wasm 1.29.0, node:test, Deno-test (eval av browserfiler), pytest + pandas/pyarrow.

**Spec:** `docs/superpowers/specs/2026-07-31-federert-pull-design.md`

## Global Constraints

- `js/federate.js` skal være **byte-identisk** med `../safestat/js/federate.js` (verifiser med `diff`); `runNodes` beholdes ubrukt.
- Alle feilmeldinger på norsk, og **aldri stille dropp** — ukjent/ugyldig input gir hard feil med reparasjonshint (husregelen fra direktivomleggingen).
- Node-testene kjøres `node --test 'tests/js/*.test.js'` (glob-formen — dir-form feiler på Node 26); deno: `cd netlify/edge-functions && deno test --allow-all _lib/`; pytest: `python3 -m pytest tests/ -q`.
- **IKKE push** — Hans kjører browser-smoke først (openstat-regelen). Commit per task.
- `docs/ROADMAP.md` har en **urelatert ucommittet endring** — aldri `git add` den.
- Statisk analyse av direktiver = parsetre-predikater, aldri nye regexer som matcher direktivtekst.

---

### Task 1: `js/federate.js` (byte-lik kopi) + `CSV_OPTS`-eksport

**Files:**
- Create: `js/federate.js` (kopi av `../safestat/js/federate.js`)
- Modify: `js/assembly-duckdb.js` (eksportlinja, i dag `global.AssemblyDuckdb = { canPushdown: canPushdown, compile: compile, _topoSort: topoSort };`)
- Test: `tests/js/federate.test.js`

**Interfaces:**
- Consumes: `global.AssemblyDuckdb.CSV_OPTS` (finnes som modul-lokal `var CSV_OPTS` i assembly-duckdb.js ~linje 22).
- Produces: `global.Federate = { planUnion, checkSchemas, runNodes }`.
  - `planUnion(files: [{id, format:'csv'|'parquet', fileName}]) -> {describes: [{id, sql}], unionSql}` — kaster på annet format.
  - `checkSchemas(schemas: [{id, columns: string[]}])` — kaster ved drift (medlem 0 er referanse, rekkefølge-ufølsom).
  - `runNodes(nodes, opts)` — ubrukt i openstat, beholdes for byte-paritet.

- [ ] **Step 1: Skriv testen**

Opprett `tests/js/federate.test.js` — port av safestats fil pluss én ekstra assertion som faktisk håndhever CSV_OPTS-eksporten (uten eksport blir `undefined` interpolert i SQL-en, og safestats originale assertion ville fortsatt passert):

```js
// tests/js/federate.test.js — ren union-planlegger for federerte kilder
// (spec 2026-07-31-federert-pull-design §4; mønster fra assembly-duckdb).
const test = require('node:test');
const assert = require('node:assert');
require('../../js/assembly-duckdb.js');
require('../../js/federate.js');
const F = globalThis.Federate;

const FILES = [
  { id: 'nord', format: 'parquet', fileName: 'fed_h_0.parquet' },
  { id: 'vest', format: 'csv', fileName: 'fed_h_1.csv' },
];

test('planUnion: __member-kolonne og UNION ALL BY NAME', () => {
  const p = F.planUnion(FILES);
  assert.ok(p.unionSql.indexOf("'nord' AS __member") >= 0);
  assert.ok(p.unionSql.indexOf("'vest' AS __member") >= 0);
  assert.ok(p.unionSql.indexOf('UNION ALL BY NAME') >= 0);
  assert.ok(p.unionSql.indexOf("read_parquet('fed_h_0.parquet')") >= 0);
  assert.ok(p.unionSql.indexOf("read_csv('fed_h_1.csv'") >= 0);
});

test('planUnion: csv-medlem bruker AssemblyDuckdb.CSV_OPTS (eksporten)', () => {
  assert.ok(globalThis.AssemblyDuckdb.CSV_OPTS.indexOf('nullstr') >= 0);
  const p = F.planUnion(FILES);
  assert.ok(p.unionSql.indexOf('auto_type_candidates') >= 0);   // ikke "undefined"
  assert.ok(p.unionSql.indexOf('undefined') < 0);
});

test('planUnion: describes per medlem', () => {
  const p = F.planUnion(FILES);
  assert.equal(p.describes.length, 2);
  assert.equal(p.describes[0].id, 'nord');
  assert.ok(p.describes[0].sql.indexOf('DESCRIBE') === 0);
});

test('planUnion: ukjent format gir norsk feil', () => {
  assert.throws(() => F.planUnion([{ id: 'x', format: 'sqlite', fileName: 'f' }]), /støttes ikke/);
});

test('checkSchemas: likt sett i annen rekkefølge er OK', () => {
  F.checkSchemas([
    { id: 'a', columns: ['x', 'y'] },
    { id: 'b', columns: ['y', 'x'] },
  ]);
});

test('checkSchemas: drift nevner medlem og kolonner', () => {
  assert.throws(
    () => F.checkSchemas([
      { id: 'a', columns: ['x', 'y'] },
      { id: 'b', columns: ['x', 'z'] },
    ]),
    (e) => e.message.indexOf('«b»') >= 0 && e.message.indexOf('y') >= 0 && e.message.indexOf('z') >= 0
  );
});

function nodeFetch(behavior) {
  // behavior: {id: {polls: N, result: {...}} | {fail: msg}}
  const polls = {};
  return async (url, init) => {
    const m = url.match(/^https:\/\/(\w+)\.no/);
    const id = m[1];
    const b = behavior[id];
    if (url.indexOf('run_extended_status') >= 0) {
      polls[id] = (polls[id] || 0) + 1;
      if (b.fail) return { ok: true, json: async () => ({ status: 'failed', error: b.fail }) };
      const done = polls[id] >= (b.polls || 1);
      return { ok: true, json: async () => (done ? { status: 'completed', result: b.result } : { status: 'running' }) };
    }
    return { ok: true, json: async () => ({ task_id: 't_' + id }) };
  };
}

test('runNodes: samler resultater i inputrekkefølge', async () => {
  const res = await F.runNodes(
    [{ id: 'nord', api: 'https://nord.no', body: { x: 1 } },
     { id: 'vest', api: 'https://vest.no', body: { x: 2 } }],
    { fetchImpl: nodeFetch({ nord: { polls: 2, result: { stats: ['a'] } },
                             vest: { polls: 1, result: { stats: ['b'] } } }),
      pollMs: 1 });
  assert.deepEqual(res.map(r => r.id), ['nord', 'vest']);
  assert.deepEqual(res[0].result.stats, ['a']);
});

test('runNodes: nettverksfeil (fetch kaster) navngir medlemmet', async () => {
  await assert.rejects(
    F.runNodes([{ id: 'nord', api: 'https://nord.no', body: {} }],
      { fetchImpl: async () => { throw new TypeError('Failed to fetch'); }, pollMs: 1 }),
    /«nord».*Failed to fetch/);
});

test('runNodes: én node feiler -> hele kjøringen feiler med medlemsnavn', async () => {
  await assert.rejects(
    F.runNodes(
      [{ id: 'nord', api: 'https://nord.no', body: {} },
       { id: 'vest', api: 'https://vest.no', body: {} }],
      { fetchImpl: nodeFetch({ nord: { polls: 1, result: {} },
                               vest: { fail: 'kilde nede' } }),
        pollMs: 1 }),
    /«vest».*kilde nede/);
});
```

- [ ] **Step 2: Kjør testen — skal feile**

Run: `node --test 'tests/js/federate.test.js'`
Expected: FAIL — `Cannot find module '../../js/federate.js'`

- [ ] **Step 3: Kopier fila og legg til eksporten**

```bash
cp ../safestat/js/federate.js js/federate.js
diff ../safestat/js/federate.js js/federate.js   # skal være tom (byte-lik)
```

I `js/assembly-duckdb.js`, endre eksportlinja (nest siste linje):

```js
// FØR:
global.AssemblyDuckdb = { canPushdown: canPushdown, compile: compile, _topoSort: topoSort };
// ETTER (CSV_OPTS eksporteres for js/federate.js — samme grep som safestat):
global.AssemblyDuckdb = { canPushdown: canPushdown, compile: compile, CSV_OPTS: CSV_OPTS, _topoSort: topoSort };
```

- [ ] **Step 4: Kjør testen — skal passere**

Run: `node --test 'tests/js/federate.test.js'`
Expected: PASS (9 tester)

- [ ] **Step 5: Kjør hele node-suiten (assembly-duckdb-testene må ikke brekke)**

Run: `node --test 'tests/js/*.test.js'`
Expected: PASS, ingen nye feil

- [ ] **Step 6: Commit**

```bash
git add js/federate.js js/assembly-duckdb.js tests/js/federate.test.js
git commit -m "feat(federert): js/federate.js (byte-lik fra safestat) + CSV_OPTS-eksport"
```

---

### Task 2: Direktivlaget — liste/dict i `ost.read` + register-`kind:"federated"`

**Files:**
- Modify: `js/data-directives.js` (PLAIN_KEYS/LOWER_KEYS ~linje 145-150; parse-funksjonens connect/read-grener ~linje 447-466; `resolve()` ~linje 514-540; nye hjelpere ved `findRegistrySource` ~linje 485)
- Test: `tests/js/data-directives-federert.test.js`
- Modify: `netlify/edge-functions/_lib/data-directives.test.ts` (én ny Deno-test)

**Interfaces:**
- Consumes: `parseLiteral`-former fra directive-parser (lister → JS-arrays, dicts → objekter med insertion order, bare ord → `{__ref}`).
- Produces (Task 3 er avhengig av nøyaktig disse formene):
  - Load-record: `{verb:'read', target:null, members:[{id,url}], alias, options, line}` (parse-nivå).
  - Resolve-item: `{alias, federated:[{id, url, key?, format?, viaProxy?}], overlap?, entity?}` — ELLER `{alias, url:'', viaProxy:false, error}` for nekt-tilfellene.
  - `format`-kwarg: `PLAIN_KEYS.format = 'format'`, lowercased, KUN gyldig på federert read.

- [ ] **Step 1: Skriv testen**

Opprett `tests/js/data-directives-federert.test.js`:

```js
// tests/js/data-directives-federert.test.js — liste/dict i ost.read + register-
// definerte federerte kilder (spec 2026-07-31-federert-pull-design §3).
const test = require('node:test');
const assert = require('node:assert');
require('../../js/directive-parser.js');
require('../../js/data-directives.js');
const DD = globalThis.DataDirectives;

const REG = [
  { id: 'demo-fed', navn: 'Demo', kind: 'federated', overlap: 'possible', entity: 'pid',
    members: [
      { id: 'nord', url: 'data/federert/nord.parquet' },
      { id: 'vest', url: 'data/federert/vest.parquet' },
    ] },
  { id: 'fed-node', navn: 'N', kind: 'federated',
    members: [{ id: 'a', tier: 'node', api: 'http://localhost:9301', source: 'person' }] },
  { id: 'fed-beskyttet', navn: 'B', kind: 'federated',
    members: [{ id: 's', url: 'https://s.no/d.csv', level: 'sensitive' }] },
  { id: 'fed-nested', navn: 'X', kind: 'federated',
    members: [{ id: 'y', kind: 'federated', members: [] }] },
  { id: 'fed-tom', navn: 'T', kind: 'federated', members: [] },
];

function res1(script) {
  const p = DD.parse(script);
  assert.deepEqual(p.errors, [], 'uventede parsefeil: ' + p.errors.join('; '));
  return DD.resolve(p, REG)[0];
}

test('parse: liste gir members med filnavn-id-er', () => {
  const p = DD.parse('# person = ost.read(["data/nord.parquet", "data/vest.parquet"])');
  assert.deepEqual(p.errors, []);
  assert.equal(p.loads[0].target, null);
  assert.deepEqual(p.loads[0].members, [
    { id: 'nord', url: 'data/nord.parquet' },
    { id: 'vest', url: 'data/vest.parquet' },
  ]);
});

test('parse: like filnavn faller tilbake til m1..mN', () => {
  const p = DD.parse('# person = ost.read(["a/person.parquet", "b/person.parquet"])');
  assert.deepEqual(p.loads[0].members.map(m => m.id), ['m1', 'm2']);
});

test('parse: dict-nøkler blir medlemsnavn (insertion order)', () => {
  const p = DD.parse('# person = ost.read({"nord": "x/p1.csv", "vest": "y/p2.csv"})');
  assert.deepEqual(p.loads[0].members, [
    { id: 'nord', url: 'x/p1.csv' },
    { id: 'vest', url: 'y/p2.csv' },
  ]);
});

test('parse: bart ord i lista gir norsk feil med hint', () => {
  const p = DD.parse('# person = ost.read([nord])');
  assert.equal(p.loads.length, 0);
  assert.ok(/anførselstegn/.test(p.errors[0]), p.errors[0]);
});

test('parse: tom liste gir feil', () => {
  const p = DD.parse('# person = ost.read([])');
  assert.ok(/minst ett medlem/.test(p.errors[0]), p.errors[0]);
});

test('parse: format= på vanlig read avvises', () => {
  const p = DD.parse('# df = ost.read("https://x.no/d.csv", format="csv")');
  assert.ok(/format=/.test(p.errors[0]), p.errors[0]);
});

test('parse: format= på connect avvises', () => {
  const p = DD.parse('# h = ost.connect("https://x.no/", format="csv")');
  assert.ok(/format=/.test(p.errors[0]), p.errors[0]);
});

test('resolve: inline liste -> federated-item; relative stier er URL-er', () => {
  const r = res1('# person = ost.read(["data/nord.parquet", "data/vest.parquet"])');
  assert.equal(r.alias, 'person');
  assert.deepEqual(r.federated.map(m => m.url),
    ['data/nord.parquet', 'data/vest.parquet']);
});

test('resolve: secret_key= og format= arves av alle medlemmer', () => {
  const r = res1('# person = ost.read(["u1", "u2"], secret_key="abc", format="parquet")');
  r.federated.forEach(m => { assert.equal(m.key, 'abc'); assert.equal(m.format, 'parquet'); });
});

test('resolve: ugyldig format avvises', () => {
  const r = res1('# person = ost.read(["u1", "u2"], format="xlsx")');
  assert.ok(/format/.test(r.error), r.error);
});

test('resolve: register-id direkte i ost.read', () => {
  const r = res1('# person = ost.read("demo-fed")');
  assert.deepEqual(r.federated.map(m => m.id), ['nord', 'vest']);
  assert.equal(r.overlap, 'possible');
  assert.equal(r.entity, 'pid');
});

test('resolve: register via connect-alias, med sti-appendering', () => {
  const p = DD.parse('# h = ost.connect("demo-fed")\n# person = h.read("2024")');
  assert.deepEqual(p.errors, []);
  const r = DD.resolve(p, REG)[0];
  assert.deepEqual(r.federated.map(m => m.url),
    ['data/federert/nord.parquet/2024', 'data/federert/vest.parquet/2024']);
});

test('resolve: node-medlemmer nektes med safestat-peker', () => {
  const r = res1('# person = ost.read("fed-node")');
  assert.ok(/node-medlemmer/.test(r.error) && /safestat/.test(r.error), r.error);
});

test('resolve: beskyttet medlem nektes med safestat-peker', () => {
  const r = res1('# person = ost.read("fed-beskyttet")');
  assert.ok(/sensitive/.test(r.error) && /safestat/.test(r.error), r.error);
});

test('resolve: nesting nektes', () => {
  const r = res1('# person = ost.read("fed-nested")');
  assert.ok(/federerte medlemmer/.test(r.error), r.error);
});

test('resolve: tom members-liste nektes', () => {
  const r = res1('# person = ost.read("fed-tom")');
  assert.ok(/ingen medlemmer/.test(r.error), r.error);
});

test('resolve: ukjent id gir fortsatt alias-feilen', () => {
  const r = res1('# person = ost.read("finnes-ikke")');
  assert.ok(/ukjent kilde-alias/.test(r.error), r.error);
});
```

- [ ] **Step 2: Kjør testen — skal feile**

Run: `node --test 'tests/js/data-directives-federert.test.js'`
Expected: FAIL — parse gir i dag `ost.read krever en URL som streng` for liste/dict (members finnes ikke)

- [ ] **Step 3: Implementer i `js/data-directives.js`**

**(a)** Utvid kwarg-tabellene (~linje 149-150):

```js
// FØR:
var PLAIN_KEYS = { secret_key: 'key', exec: 'exec', kind: 'kind', cache: 'cache' };
var LOWER_KEYS = { exec: 1, kind: 1, cache: 1 };
// ETTER (format= gjelder KUN federert read — håndheves i parse under):
var PLAIN_KEYS = { secret_key: 'key', exec: 'exec', kind: 'kind', cache: 'cache', format: 'format' };
var LOWER_KEYS = { exec: 1, kind: 1, cache: 1, format: 1 };
```

**(b)** Nye hjelpere rett over `findRegistrySource` (~linje 485):

```js
  // __member-navn for liste-form (spec 2026-07-31-federert-pull §3): filnavn
  // uten endelse når alle er unike, ellers m1..mN (safestat-default).
  function memberIdsFor(urls) {
    var names = urls.map(function (u) {
      var path = String(u).split(/[?#]/)[0].replace(/\/+$/, '');
      var last = path.slice(path.lastIndexOf('/') + 1);
      return last.replace(/\.[A-Za-z0-9]+$/, '');
    });
    var seen = {};
    for (var i = 0; i < names.length; i++) {
      if (!names[i] || seen[names[i]]) return urls.map(function (_, j) { return 'm' + (j + 1); });
      seen[names[i]] = 1;
    }
    return names;
  }

  // Liste/dict-argument til ost.read -> {members:[{id,url}]} | {error} | null
  // (null = ikke federert form). Medlemmer må være URL-strenger — et bart ord
  // blir {__ref} i parseLiteral og er en skrivefeil, ikke en kilde.
  function fedMembersFrom(a0) {
    var isArr = Object.prototype.toString.call(a0) === '[object Array]';
    var isDict = !!a0 && typeof a0 === 'object' && !isArr && typeof a0.__ref !== 'string';
    if (!isArr && !isDict) return null;
    var ids = isArr ? null : Object.keys(a0);
    var vals = isArr ? a0 : ids.map(function (k) { return a0[k]; });
    if (!vals.length) return { error: 'federert read krever minst ett medlem i listen' };
    for (var i = 0; i < vals.length; i++) {
      if (typeof vals[i] !== 'string' || !vals[i]) {
        var hva = (vals[i] && typeof vals[i] === 'object' && typeof vals[i].__ref === 'string')
          ? '«' + vals[i].__ref + '» uten anførselstegn' : typeof vals[i];
        return { error: 'federert medlem #' + (i + 1) + ' må være en URL-streng (fikk ' + hva + ')' };
      }
    }
    if (isArr) ids = memberIdsFor(vals);
    return { members: vals.map(function (u, i) { return { id: ids[i], url: u }; }) };
  }

  // Register-definert federert kilde (spec §3): samme JSON-vokabular som
  // safestat. Node-/beskyttet-medlemmer hører hjemme i safestat — klar nekt.
  function federatedFromRegistry(alias, src, rest, opts) {
    function nekt(msg) { return { alias: alias, url: '', viaProxy: false, error: msg }; }
    var members = src.members || [];
    if (!members.length) return nekt('federert kilde «' + src.id + '» har ingen medlemmer');
    var out = [];
    for (var i = 0; i < members.length; i++) {
      var m = members[i];
      if (m.tier === 'node' || m.api) {
        return nekt('kilden «' + src.id + '» har node-medlemmer — compute-to-data krever safestat; openstat kjører kun pull+union');
      }
      if (m.level && m.level !== 'public') {
        return nekt('medlem «' + (m.id || 'm' + (i + 1)) + '» i «' + src.id + '» er merket «' + m.level + '» — beskyttede kilder hører hjemme i safestat');
      }
      if (m.kind === 'federated' || m.members) {
        return nekt('federert kilde «' + src.id + '» kan ikke ha federerte medlemmer');
      }
      var url = String(m.url || '');
      if (!url) return nekt('medlem «' + (m.id || 'm' + (i + 1)) + '» i «' + src.id + '» mangler url');
      // Medlems-url er URL også når den er relativ (safestats explicitUrl-
      // lærdom) — aldri register-oppslag på den.
      if (rest) url = url.replace(/\/+$/, '') + '/' + String(rest).replace(/^\/+/, '');
      out.push({ id: m.id || ('m' + (i + 1)), url: url, key: opts.key, format: opts.format,
                 viaProxy: !!m.auth || m.cors === false || !!src.auth || src.cors === false });
    }
    var item = { alias: alias, federated: out };
    if (src.overlap) item.overlap = src.overlap;
    if (src.entity) item.entity = src.entity;
    return item;
  }
```

**(c)** I parse: connect-grenen (~linje 447-453) — legg inn format-vakten rett før `connects.push`:

```js
        if (opts.format) { errors.push('linje ' + it.lineNo + ': format= støttes bare i federert read — ost.read([<url>, …], format="csv")'); return; }
        connects.push({ target: it.args[0], alias: it.target, options: opts });
```

**(d)** I parse: read-grenen (~linje 454-466) — erstatt hele grenen med:

```js
      if (it.verb === 'read') {
        if (tooManyArgs()) return;
        if (!it.target) { errors.push('linje ' + it.lineNo + ': read krever en tilordning — «# <navn> = …read(…)»'); return; }
        var tgt;
        if (it.recv === 'ost') {
          // Federert (spec 2026-07-31-federert-pull §3): liste/dict der én
          // URL ellers står = union av medlemmene.
          var fed = fedMembersFrom(it.args[0]);
          if (fed) {
            if (fed.error) { errors.push('linje ' + it.lineNo + ': ' + fed.error); return; }
            loads.push({ verb: 'read', target: null, members: fed.members, alias: it.target, options: opts, line: it.raw });
            return;
          }
          if (typeof it.args[0] !== 'string') { errors.push('linje ' + it.lineNo + ': ost.read krever en URL som streng'); return; }
          tgt = it.args[0];
        } else {
          tgt = it.args.length ? (it.recv + '/' + String(it.args[0])) : it.recv;
        }
        if (opts.format) { errors.push('linje ' + it.lineNo + ': format= støttes bare i federert read (liste/dict av medlemmer)'); return; }
        loads.push({ verb: 'read', target: tgt, alias: it.target, options: opts, line: it.raw });
        return;
      }
```

**(e)** I `resolve()` (~linje 517): tre innstikk.

Øverst i map-callbacken, FØR `if (isUrlish(l.target))`:

```js
      if (l.members) {
        // Inline federert: medlemmene er eksplisitte URL-er (også relative).
        if (lopts.format && lopts.format !== 'csv' && lopts.format !== 'parquet') {
          return { alias: l.alias, url: '', viaProxy: false,
                   error: '«' + l.alias + '»: format «' + lopts.format + '» støttes ikke for federerte medlemmer (kun csv/parquet)' };
        }
        return { alias: l.alias, federated: l.members.map(function (m) {
          return { id: m.id, url: m.url, key: lopts.key, format: lopts.format };
        }) };
      }
```

I `if (!conn)`-grenen (~linje 528) — register-id direkte i `ost.read`:

```js
      if (!conn) {
        var fsrc = findRegistrySource(registry, head);
        if (fsrc && (fsrc.kind === 'federated' || fsrc.members)) {
          return federatedFromRegistry(l.alias, fsrc, rest, { key: lopts.key, format: lopts.format });
        }
        return { alias: l.alias, url: '', viaProxy: false, error: 'ukjent kilde-alias «' + head + '» (mangler connect-linje?)' };
      }
```

Rett etter `src = findRegistrySource(registry, conn.target);` (~linje 536), FØR `if (!src)`:

```js
        if (src && (src.kind === 'federated' || src.members)) {
          return federatedFromRegistry(l.alias, src, rest, { key: key, format: lopts.format });
        }
```

(NB: `key` er allerede den flettede `lopts.key || copts.key` fra linje ~530.)

- [ ] **Step 4: Kjør testen — skal passere**

Run: `node --test 'tests/js/data-directives-federert.test.js'`
Expected: PASS (17 tester)

- [ ] **Step 5: Legg til Deno-testen**

I `netlify/edge-functions/_lib/data-directives.test.ts` (samme eval-harness som eksisterende tester, nederst i fila):

```ts
Deno.test("federert: liste i ost.read og register-oppslag (spec 2026-07-31)", () => {
  const fedReg = [{ id: "demo-fed", kind: "federated", overlap: "possible",
    members: [{ id: "nord", url: "data/f/nord.parquet" }, { id: "vest", url: "data/f/vest.parquet" }] }];
  const p = DD.parse('# person = ost.read(["data/nord.parquet", "data/vest.parquet"])');
  assertEquals(p.errors, []);
  assertEquals(p.loads[0].members, [
    { id: "nord", url: "data/nord.parquet" },
    { id: "vest", url: "data/vest.parquet" },
  ]);
  const r = DD.resolve(DD.parse('# person = ost.read("demo-fed")'), fedReg);
  assertEquals(r[0].federated.length, 2);
  assertEquals(r[0].overlap, "possible");
});
```

- [ ] **Step 6: Kjør begge suitene**

Run: `node --test 'tests/js/*.test.js'` og `cd netlify/edge-functions && deno test --allow-all _lib/ && cd ../..`
Expected: PASS, ingen regressjoner (spesielt data-directives-apikinds/directive-semantics)

- [ ] **Step 7: Commit**

```bash
git add js/data-directives.js tests/js/data-directives-federert.test.js netlify/edge-functions/_lib/data-directives.test.ts
git commit -m "feat(federert): liste/dict i ost.read + register-kind federated i resolve"
```

---

### Task 3: Lastelaget — `deps.unionExec`-gren + pushdown-ekskludering

**Files:**
- Modify: `js/data-loader.js` (`fetchResolvedItems` map-callback ~linje 307, `resolveSourcesOnly` ~linje 578)
- Test: `tests/js/data-loader-federert.test.js`

**Interfaces:**
- Consumes: resolve-items `{alias, federated:[{id,url,key?,format?,viaProxy?}], overlap?, entity?}` fra Task 2; `sniffFormat(resp, url, kind)` og `maybeDecrypt(item, buf, format, deps)` (finnes).
- Produces: load-output `{alias, bytes, format:'parquet', federated:true, overlap?}`; kontrakt for Task 4: `deps.unionExec(alias, members:[{id,bytes,format}], meta:{overlap?,entity?}) -> Promise<{bytes, format:'parquet'}>`.

- [ ] **Step 1: Skriv testen**

Opprett `tests/js/data-loader-federert.test.js`:

```js
// tests/js/data-loader-federert.test.js — fan-out + unionExec for federerte
// kilder (spec 2026-07-31-federert-pull-design §4). Fake fetch/union.
const test = require('node:test');
const assert = require('node:assert');
require('../../js/directive-parser.js');
require('../../js/data-directives.js');
require('../../js/data-loader.js');
const DL = globalThis.DataLoader;

const REG = [
  { id: 'demo-fed', navn: 'Demo', kind: 'federated', overlap: 'possible',
    members: [
      { id: 'nord', url: 'https://nord.no/person.csv' },
      { id: 'vest', url: 'https://vest.no/person.csv' },
    ] },
];

function fakeFetch(urls) {
  return async (url) => {
    urls.push(url);
    return {
      ok: true,
      headers: { get: () => 'text/csv' },
      arrayBuffer: async () => new TextEncoder().encode('x,y\n1,2\n').buffer,
    };
  };
}

const SCRIPT = '# h = ost.connect("demo-fed")\n# df = h.read()';

test('federert: henter alle medlemmer og kaller unionExec', async () => {
  DL._resetCacheForTests();
  const urls = [];
  let called = null;
  const r = await DL.resolveAndFetchLoads(SCRIPT, {
    fetchImpl: fakeFetch(urls), registry: REG,
    unionExec: async (alias, members, meta) => {
      called = { alias, members, meta };
      return { bytes: new Uint8Array([1]), format: 'parquet' };
    },
  });
  assert.deepEqual(urls.sort(), ['https://nord.no/person.csv', 'https://vest.no/person.csv']);
  assert.equal(called.alias, 'df');
  assert.equal(called.members.length, 2);
  assert.equal(called.members[0].id, 'nord');
  assert.equal(called.members[0].format, 'csv');       // sniffet fra content-type
  assert.equal(called.meta.overlap, 'possible');
  assert.equal(r.loads.length, 1);
  assert.equal(r.loads[0].format, 'parquet');
  assert.equal(r.loads[0].federated, true);
  assert.equal(r.loads[0].overlap, 'possible');
});

test('federert: register-id direkte i ost.read virker likt', async () => {
  DL._resetCacheForTests();
  const urls = [];
  const r = await DL.resolveAndFetchLoads('# df = ost.read("demo-fed")', {
    fetchImpl: fakeFetch(urls), registry: REG,
    unionExec: async () => ({ bytes: new Uint8Array([1]), format: 'parquet' }),
  });
  assert.equal(urls.length, 2);
  assert.equal(r.loads[0].federated, true);
});

test('federert: format= overstyrer sniff for medlemmene', async () => {
  DL._resetCacheForTests();
  let called = null;
  await DL.resolveAndFetchLoads('# df = ost.read(["a/x1.bin", "b/x2.bin"], format="parquet")', {
    fetchImpl: fakeFetch([]), registry: [],
    unionExec: async (alias, members) => { called = members; return { bytes: new Uint8Array([1]), format: 'parquet' }; },
  });
  assert.deepEqual(called.map(m => m.format), ['parquet', 'parquet']);
});

test('federert: mangler unionExec gir norsk feil', async () => {
  DL._resetCacheForTests();
  await assert.rejects(
    DL.resolveAndFetchLoads(SCRIPT, { fetchImpl: fakeFetch([]), registry: REG }),
    /unionExec/
  );
});

test('federert: node-medlem stoppes allerede i resolve-laget', async () => {
  DL._resetCacheForTests();
  const reg = [{ id: 'f', navn: 'F', kind: 'federated',
    members: [{ id: 'a', tier: 'node', api: 'http://localhost:9301' }] }];
  await assert.rejects(
    DL.resolveAndFetchLoads('# df = ost.read("f")',
      { fetchImpl: fakeFetch([]), registry: reg, unionExec: async () => ({}) }),
    /node-medlemmer/
  );
});

test('resolveSourcesOnly: federert kilde er aldri pushdown-kandidat', async () => {
  const script = [
    '# h = ost.connect("demo-fed")',
    '# t = ost.create(key="x")',
    '# t.add(h, ["x", "y"])',
  ].join('\n');
  const r = await DL.resolveSourcesOnly(script, { fetchImpl: fakeFetch([]), registry: REG });
  assert.equal(r.descriptors.h, undefined);   // ekskludert -> canPushdown blir false
});
```

- [ ] **Step 2: Kjør testen — skal feile**

Run: `node --test 'tests/js/data-loader-federert.test.js'`
Expected: FAIL — federated-items har ingen `url`, dagens kode går rett i `fetchBytes(item)` med `undefined`

- [ ] **Step 3: Implementer i `js/data-loader.js`**

**(a)** Øverst i map-callbacken i `fetchResolvedItems` (~linje 307, FØR pxweb-grenen `if (item.kind === 'pxweb' …)`):

```js
      if (item.federated) {
        // Federert pull (spec 2026-07-31-federert-pull §4): hvert medlem
        // gjennom samme fetch/cache-vei som et vanlig load-item, deretter
        // union via injisert executor (index.html = duckdb-wasm; tester =
        // fake). Ett medlem som feiler feiler HELE lesingen — delresultater
        // presentert som helheten er en korrekthetsfelle.
        if (!deps.unionExec) throw new Error('federert kilde «' + item.alias + '» krever union-motoren (unionExec mangler)');
        var memberLoads = await Promise.all(item.federated.map(async function (mem) {
          var mf = await fetchBytes(mem);
          var mfmt = mem.format || sniffFormat(mf.resp, mem.url, mem.kind);
          var mdec = await maybeDecrypt(mem, mf.buf, mfmt, deps);
          return { id: mem.id, bytes: mdec.bytes, format: mdec.format };
        }));
        var fedMeta = {};
        if (item.overlap) fedMeta.overlap = item.overlap;
        if (item.entity) fedMeta.entity = item.entity;
        var merged = await deps.unionExec(item.alias, memberLoads, fedMeta);
        var fedOut = { alias: item.alias, bytes: merged.bytes, format: 'parquet', federated: true };
        if (item.overlap) fedOut.overlap = item.overlap;
        return fedOut;
      }
```

**(b)** I `resolveSourcesOnly` (~linje 578):

```js
// FØR:
      if (r.error || r.anvil) return; // protected/anvil/error sources are never pushdown-eligible
// ETTER:
      if (r.error || r.anvil || r.federated) return; // protected/anvil/error/federert er aldri pushdown-kandidater
```

- [ ] **Step 4: Kjør testen — skal passere**

Run: `node --test 'tests/js/data-loader-federert.test.js'`
Expected: PASS (6 tester)

- [ ] **Step 5: Kjør begge suitene**

Run: `node --test 'tests/js/*.test.js'` og `cd netlify/edge-functions && deno test --allow-all _lib/ && cd ../..`
Expected: PASS (deno data-loader.test.ts eval-er den endrede fila — ingen regressjoner)

- [ ] **Step 6: Commit**

```bash
git add js/data-loader.js tests/js/data-loader-federert.test.js
git commit -m "feat(federert): unionExec-gren i fetchResolvedItems + pushdown-ekskludering"
```

---

### Task 4: index.html — `__federatedUnion` + 9 deps-steder + script-tag

**Files:**
- Modify: `index.html` (funksjon ~linje 2314; 9 deps-objekter på linjene 2780, 2855, 2920, 8097, 8677, 9577, 10797, 11318, 12384; script-tag ved linje 12618)

**Interfaces:**
- Consumes: `window.Federate` (Task 1), `__ensureDuckDB()` (finnes, linje 2170), kontrakten `unionExec(alias, members, meta) -> {bytes, format:'parquet'}` (Task 3).
- Produces: `__federatedUnion` — den ene virkelige `unionExec`.

- [ ] **Step 1: Legg inn `__federatedUnion`**

Rett FØR linja `window.__duckUseBytes = __duckUseBytes;   // JavaScript-motorens use-from-duckdb` (~linje 2315), lim inn (identisk med safestats blokk, kun spec-referansen endret):

```js
    // Federert pull (spec 2026-07-31-federert-pull-design §4): den ENE
    // virkelige unionExec — medlemsbytes inn, én parquet ut, med __member-
    // kolonne og skjemasjekk. Ren plan fra js/federate.js; kjøres her mot
    // duckdb-wasm-singletonen. Injiseres som deps.unionExec ved alle
    // resolveAndFetchLoads/fetchResolvedItems-kall.
    async function __federatedUnion(alias, members, meta) {
      var db = await __ensureDuckDB();
      var conn = await db.connect();
      var files = members.map(function (m, i) {
        return { id: m.id, format: m.format, fileName: 'fed_' + alias + '_' + i + '.' + m.format };
      });
      try {
        for (var i = 0; i < members.length; i++) {
          await db.registerFileBuffer(files[i].fileName, members[i].bytes);
        }
        var plan = window.Federate.planUnion(files);
        var schemas = [];
        for (var j = 0; j < plan.describes.length; j++) {
          var dres = await conn.query(plan.describes[j].sql);
          schemas.push({ id: plan.describes[j].id,
            columns: dres.toArray().map(function (row) { return row.column_name; }) });
        }
        window.Federate.checkSchemas(schemas);
        if (meta && meta.overlap === 'possible') {
          console.info('federert «' + alias + '»: medlemmer kan overlappe — tellinger er episodenivå');
        }
        var outName = 'fed_' + alias + '_union.parquet';
        await conn.query("COPY (" + plan.unionSql + ") TO '" + outName + "' (FORMAT PARQUET)");
        var bytes = await db.copyFileToBuffer(outName);
        try { await db.dropFile(outName); } catch (e) { /* best-effort */ }
        return { bytes: bytes, format: 'parquet' };
      } finally {
        for (var k = 0; k < files.length; k++) {
          try { await db.dropFile(files[k].fileName); } catch (e) { /* best-effort */ }
        }
        await conn.close();
      }
    }
```

- [ ] **Step 2: Injiser på alle 9 deps-stedene**

Alle 9 har i dag den identiske teksten `{ anthropicKey: getAnthropicKey(), promptKey: mdPromptKey }` — én Edit med `replace_all`:

```
old: { anthropicKey: getAnthropicKey(), promptKey: mdPromptKey }
new: { anthropicKey: getAnthropicKey(), promptKey: mdPromptKey, unionExec: __federatedUnion }
```

- [ ] **Step 3: Script-tag**

Etter linja `<script src="js/assembly-duckdb.js"></script>` (~linje 12618):

```html
  <script src="js/federate.js"></script>
```

- [ ] **Step 4: Verifiser mekanisk**

Run: `grep -c "unionExec: __federatedUnion" index.html` → Expected: `9`
Run: `grep -c 'src="js/federate.js"' index.html` → Expected: `1`
Run: `node --test 'tests/js/*.test.js'` → Expected: PASS (index.html testes ikke i node, men suitene skal stå)

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat(federert): __federatedUnion (duckdb-wasm) injisert som unionExec på alle 9 lastesteder"
```

---

### Task 5: Server-validator + registeroppføring + demo-data + invariant-test

**Files:**
- Modify: `netlify/edge-functions/_lib/registry.ts` (interface + TILLIT + parseRegistry)
- Modify: `netlify/edge-functions/_lib/registry.test.ts` (to nye tester)
- Modify: `data/data-sources.json` (ny oppføring, følg filas eksisterende formattering)
- Create: `scripts/build_federert_demo.py`, `data/federert/{nord,vest,sor}.parquet`
- Test: `tests/test_federert_demo.py`

**Interfaces:**
- Produces: registeroppføringen `demo-federert` som Task 6-eksempelet leser; validatoren godtar `kind:"federated"`-oppføringer uten `base_url` og med `tillit:"demo"`.

- [ ] **Step 1: Skriv Deno-testene (registry.test.ts, nederst — bruk samme assert-importer som fila har)**

```ts
const FED_ENTRY = {
  id: "demo-federert", navn: "Demo: federert persontabell (3 deler)",
  utgiver: "openstat", tillit: "demo", tilgang: "fil",
  kind: "federated", partition: "horizontal", overlap: "none", cors: true,
  members: [
    { id: "nord", url: "data/federert/nord.parquet" },
    { id: "vest", url: "data/federert/vest.parquet" },
    { id: "sor", url: "data/federert/sor.parquet" },
  ],
};

Deno.test("parseRegistry: federert kilde uten base_url godtas", () => {
  const reg = parseRegistry([FED_ENTRY]);
  assertEquals(reg[0].id, "demo-federert");
  assertEquals(reg[0].members!.length, 3);
});

Deno.test("parseRegistry: federert kilde uten members avvises", () => {
  assertThrows(() => parseRegistry([{ ...FED_ENTRY, members: [] }]), Error, "members");
  assertThrows(() => parseRegistry([{ ...FED_ENTRY, members: [{ id: "x" }] }]), Error, "id og url");
});
```

(Om fila ikke allerede importerer `assertThrows`, legg den til i eksisterende import fra deno std assert.)

- [ ] **Step 2: Kjør — skal feile**

Run: `cd netlify/edge-functions && deno test --allow-all _lib/registry.test.ts && cd ../..`
Expected: FAIL — `mangler/ugyldig felt 'base_url'` og `ukjent tillit 'demo'`

- [ ] **Step 3: Implementer i `registry.ts`**

Interface-endringer:

```ts
  tillit: "offisiell" | "etablert" | "funnet" | "demo";
  // base_url utelates KUN for kind:"federated" (validert i parseRegistry) —
  // serveren ruter aldri trafikk til en federert kilde (ikke søkbar).
  base_url: string;
  // (…øvrige eksisterende felter uendret; legg members sist, etter guide?:)
  // kind:"federated" (spec 2026-07-31-federert-pull §3): pull+union-kilde;
  // members er delene. partition/overlap/entity passerer uvalidert gjennom.
  members?: { id: string; url: string }[];
```

`const TILLIT = new Set(["offisiell", "etablert", "funnet", "demo"]);`

I `parseRegistry`, erstatt felt-løkka + URL-sjekken:

```ts
    const isFed = e.kind === "federated";
    const req = ["id", "navn", "utgiver", "tillit", "tilgang"];
    if (!isFed) req.push("base_url");
    for (const field of req) {
      if (typeof e[field] !== "string" || !(e[field] as string).trim()) {
        throw new Error(`kilde #${i}: mangler/ugyldig felt '${field}'`);
      }
    }
    // (de eksisterende TILLIT-/TILGANG-/cors-sjekkene står UENDRET her)
    if (isFed) {
      const mems = e.members;
      if (!Array.isArray(mems) || mems.length === 0) {
        throw new Error(`kilde ${e.id}: federert kilde krever en ikke-tom members-liste`);
      }
      for (const m of mems as Record<string, unknown>[]) {
        if (typeof m.id !== "string" || !(m.id as string).trim() ||
            typeof m.url !== "string" || !(m.url as string).trim()) {
          throw new Error(`kilde ${e.id}: federert medlem krever id og url`);
        }
      }
    } else {
      new URL(e.base_url as string); // throws on invalid
    }
```

- [ ] **Step 4: Kjør — skal passere**

Run: `cd netlify/edge-functions && deno test --allow-all _lib/ && cd ../..`
Expected: PASS (hele deno-suiten — search-catalog/isSearchableSource rører ikke `tilgang:"fil"`+`kind:"federated"`)

- [ ] **Step 5: Registeroppføring + demo-data**

Legg `demo-federert`-oppføringen (nøyaktig JSON-en fra FED_ENTRY i Step 1) sist i `data/data-sources.json`.

Opprett `scripts/build_federert_demo.py`:

```python
"""Splitt data/person_year_sample.csv i tre disjunkte medlemmer for
demo-federert-kilden (spec 2026-07-31-federert-pull-design §6).
Deterministiske tredjedeler etter radrekkefølge — union av delene == den
usplittede tabellen er invarianten tests/test_federert_demo.py håndhever."""
import pathlib

import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent
df = pd.read_csv(ROOT / "data" / "person_year_sample.csv")
out = ROOT / "data" / "federert"
out.mkdir(parents=True, exist_ok=True)
n = len(df)
cuts = [0, n // 3, 2 * n // 3, n]
for name, a, b in zip(["nord", "vest", "sor"], cuts, cuts[1:]):
    df.iloc[a:b].to_parquet(out / f"{name}.parquet", index=False)
    print(f"{name}: {b - a} rader")
print(f"totalt: {n} rader")
```

Run: `python3 scripts/build_federert_demo.py`
Expected: tre filer under `data/federert/`, radantall summerer til kildens.

- [ ] **Step 6: Invariant-testen**

Opprett `tests/test_federert_demo.py`:

```python
"""Invarianten fra spec 2026-07-31-federert-pull §7: union av demo-shardene
== den usplittede tabellen (radantall, kolonner, innhold og radrekkefølge)."""
import pathlib

import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent
DELER = ["nord", "vest", "sor"]


def test_federert_demo_shards_union_equals_source():
    src = pd.read_csv(ROOT / "data" / "person_year_sample.csv")
    parts = [pd.read_parquet(ROOT / "data" / "federert" / f"{n}.parquet") for n in DELER]
    assert sum(len(p) for p in parts) == len(src)
    for p in parts:
        assert list(p.columns) == list(src.columns)
    union = pd.concat(parts, ignore_index=True)
    pd.testing.assert_frame_equal(union, src.reset_index(drop=True), check_dtype=False)
```

Run: `python3 -m pytest tests/test_federert_demo.py -q`
Expected: PASS

- [ ] **Step 7: Full pytest (registeret valideres også av eksisterende tester)**

Run: `python3 -m pytest tests/ -q`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add netlify/edge-functions/_lib/registry.ts netlify/edge-functions/_lib/registry.test.ts data/data-sources.json scripts/build_federert_demo.py data/federert/ tests/test_federert_demo.py
git commit -m "feat(federert): demo-federert i registeret + validator-støtte + demo-shards m/invariant-test"
```

---

### Task 6: Eksempel + hjelp + fulle suiter + browser-smoke

**Files:**
- Create: `examples/python/ex_federert_union.txt`
- Modify: `examples/manifest.json` (via `python3 examples/generate_manifest.py` — ikke for hånd)
- Modify: `hjelp.html`, `hjelp.en.html` (ny underseksjon i «Datadirektiver»-seksjonen)

**Interfaces:**
- Consumes: `demo-federert`-registeroppføringen (Task 5); hele kjeden Task 1-4.

- [ ] **Step 1: Eksempelskript**

Opprett `examples/python/ex_federert_union.txt` (kolonnene i person_year_sample: year/age/status/income/total_income/kommune):

```
# label: Federert kilde — tre deler som ett datasett
# Federert kilde (pull+union): tre deler hostes hver for seg, men analyseres
# som ETT datasett. __member-kolonnen viser hvilken del hver rad kom fra.

# person = ost.read("demo-federert")

print(len(person))
print(person["__member"].value_counts())
person.groupby("__member")["income"].describe()
```

Run: `python3 examples/generate_manifest.py && python3 -m pytest tests/test_examples_manifest.py tests/test_example_datasets.py -q`
Expected: manifest oppdatert, PASS

- [ ] **Step 2: Hjelpeseksjon (norsk)**

I `hjelp.html`, nederst i seksjonen «Datadirektiver — hente og montere data» (h2 ~linje 469, FØR neste `<h2>` «Lagre, dele og hente scripts» ~linje 531), sett inn:

```html
    <h3 id="hjelp-federert">Federerte kilder — flere deler som ett datasett</h3>
    <p>Når samme tabell er delt over flere filer/URL-er (regioner, år, land),
    kan du lese dem som ÉN kilde: openstat henter alle medlemmene, sjekker at
    skjemaene er like og unioner dem. Kolonnen <code>__member</code> viser
    hvilken del hver rad kom fra.</p>
    <pre># person = ost.read(["data/nord.parquet", "data/vest.parquet"])
# person = ost.read({"nord": "data/nord.parquet", "vest": "data/vest.parquet"})
# person = ost.read("demo-federert")   # register-definert federert kilde</pre>
    <ul>
      <li>Liste: medlemsnavn i <code>__member</code> tas fra filnavnet (uten
      endelse) når de er unike — ellers m1, m2, …. Dict: nøklene blir navn.</li>
      <li>Kun csv/parquet-medlemmer; ulike kolonnesett avvises med klar
      melding (medlem + manglende/ekstra kolonner).</li>
      <li>Feiler ett medlem, feiler hele lesingen — aldri stille delresultater.</li>
      <li><code>secret_key=</code> på linjen gjelder alle medlemmene;
      <code>format="csv"</code> når URL-ene mangler filendelse.</li>
      <li>I montering (<code>ost.create</code>/<code>add</code>): bruk
      register-formen via <code>ost.connect("<i>id</i>")</code> — inline-liste
      støttes ikke som monteringskilde ennå.</li>
    </ul>
```

- [ ] **Step 3: Hjelpeseksjon (engelsk)**

Tilsvarende i `hjelp.en.html` på samme sted i strukturen:

```html
    <h3 id="hjelp-federert">Federated sources — several parts as one dataset</h3>
    <p>When the same table is split across several files/URLs (regions, years,
    countries), you can read them as ONE source: openstat fetches every member,
    checks that the schemas match, and unions them. The <code>__member</code>
    column shows which part each row came from.</p>
    <pre># person = ost.read(["data/north.parquet", "data/west.parquet"])
# person = ost.read({"north": "data/north.parquet", "west": "data/west.parquet"})
# person = ost.read("demo-federert")   # registry-defined federated source</pre>
    <ul>
      <li>List: member names in <code>__member</code> come from the file name
      (without extension) when unique — otherwise m1, m2, …. Dict: the keys
      become the names.</li>
      <li>csv/parquet members only; differing column sets are refused with a
      clear message (member + missing/extra columns).</li>
      <li>If one member fails, the whole read fails — never silent partial
      results.</li>
      <li><code>secret_key=</code> on the line applies to every member;
      <code>format="csv"</code> when the URLs lack a file extension.</li>
      <li>In assembly (<code>ost.create</code>/<code>add</code>): use the
      registry form via <code>ost.connect("<i>id</i>")</code> — inline lists are
      not yet supported as assembly sources.</li>
    </ul>
```

- [ ] **Step 4: Alle suitene**

Run: `node --test 'tests/js/*.test.js' && (cd netlify/edge-functions && deno test --allow-all _lib/) && python3 -m pytest tests/ -q`
Expected: alt PASS

- [ ] **Step 5: Browser-smoke (verify-fella: hard reload m/ «ignore cache» — Chrome HTTP-cacher js/; kjøres netlify dev, restart den først)**

Sjekkliste (python-modus): åpne appen lokalt, kjør eksempelet `ex_federert_union` → forvent 8000 rader totalt, `value_counts()` viser nord/vest/sor ≈ 2666/2667/2667, ingen konsollfeil. Duckdb-modus: `SELECT __member, count(*) FROM person GROUP BY 1` etter `# person = ost.read("demo-federert")` → tre rader. Inline-form: `# p2 = ost.read(["data/federert/nord.parquet", "data/federert/vest.parquet"])` → 2 medlemmer. Feilvei: endre ett medlem til en fil med annet skjema → norsk skjemadrift-melding.

- [ ] **Step 6: Commit (IKKE push — Hans smoker først)**

```bash
git add examples/python/ex_federert_union.txt examples/manifest.json hjelp.html hjelp.en.html
git commit -m "feat(federert): demo-eksempel + hjelpeseksjon (no/en)"
```

---

## Self-review-notater (utført under planskriving)

- **Spec-dekning:** §3 syntaks → Task 2; §4 arkitektur → Task 1/3/4; §5 feilhåndtering → Task 1 (checkSchemas/fail-fast i runNodes-mønsteret), Task 2 (nekt-tilfeller), Task 3 (fail-fast via Promise.all); §6 demo/eksempel/hjelp → Task 5/6; §7 testing → alle. Ett spec-avvik dokumentert: level≠public-medlemmer nektes eksplisitt (Task 2) — strengere enn spec-teksten, i safestat-ånden; nevnes for Hans ved levering.
- **Kjent v1-begrensning** (dokumentert i hjelp, Task 6): inline-liste kan ikke brukes som monteringskilde (synthSourceLoads syntetiserer loads fra alias-navn); register-formen via connect virker i montering og ekskluderes korrekt fra pushdown.
- **Typekonsistens:** `deps.unionExec(alias, members:[{id,bytes,format}], meta) -> {bytes, format:'parquet'}` er identisk i Task 3 (konsument), Task 4 (produsent) og testenes fakes. Resolve-item-formen `{alias, federated:[…]}` identisk i Task 2 (produsent) og Task 3 (konsument).
- **sw.js:** precacher kun CDN-assets — ingen endring nødvendig for ny lokal js-fil.
