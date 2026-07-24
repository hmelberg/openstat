# PxWeb-kilder + composite keys — implementasjonsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `kind(pxweb)` gjør SSB-tabeller til førsteklasses kilder (`# load
ssb/05839 as bef`), metadata mater kildekatalog + tab uten nedlasting, og
composite keys (`key(region aar)` → `USING ("region", "aar")`) løses først som
forutsetning. Spec: docs/superpowers/specs/2026-07-24-pxweb-sources-design.md.

**Architecture:** Se spec §1–2. Nøkkel/on blir arrays overalt (ingen
bakoverkompat). PxWeb-data hentes som json-stat2 og konverteres i ny ren modul
`js/pxweb.js` til lang-format; lastelaget leverer CSV-bytes (format 'csv'),
monteringen registrerer filbuffer i duckdb-wasm og omskriver deskriptoren.

**Tech Stack:** Vanilla JS (husets IIFE-mønster), node --test, deno (CI kjører
edge-testene mot js/data-directives.js direkte — hold dem grønne), pytest.

## Global Constraints

- Samme husregler som forrige plan (IIFE/var/norske kommentarer/module.exports;
  t()-strenger → js/i18n/en.js; node+pytest grønne per task).
- `deno test --allow-all netlify/edge-functions/_lib/` kjører mot
  js/data-directives.js — kjør den i Task 1 og 5 hvis deno finnes lokalt
  (ellers: CI fanger det; noter i rapporten).
- M2PY_VERSION bumpes én gang i siste task (`2026-07-24v`).
- Ingen .py-endringer (python-fallbacken lever inline i index.html).

---

### Task 1: Composite keys i parseren (data-directives)

**Files:** Modify `js/data-directives.js` (CREATE_RE, JOIN_RE, parseAssembly);
Test: `tests/js/assembly-duckdb.test.js` (parse-delen ligger der i dag).

**Interfaces — Produces:** `parseAssembly` gir `d.key: [kolonner]` og
join-steg `on: [kolonner]` (alltid arrays).

- [ ] Step 1: Feilende tester — `key(region aar)` → `['region','aar']`;
  `key(pid)` → `['pid']`; `join a into b on region, aar inner` →
  `on: ['region','aar'], how: 'inner'`; `on k left` → `on: ['k'], how: 'left'`.
- [ ] Step 2: CREATE_RE key-gruppe → `([A-Za-z_]\w*(?:[ \t,]+[A-Za-z_]\w*)*)`,
  split på `/[\s,]+/`. JOIN_RE on-gruppe → `([A-Za-z_]\w*(?:[ \t]*,[ \t]*[A-Za-z_]\w*)*)`
  (komma-skilt multi — mellomrom er reservert for how-halen), split på komma.
- [ ] Step 3: node --test grønt (+ deno-testene hvis deno finnes). Commit:
  `create-dataset/join: composite keys — key(a b) og on a, b som arrays`.

### Task 2: Composite keys i kompilatoren + pandas-fallbacken

**Files:** Modify `js/assembly-duckdb.js` (compile import/join-steg),
`index.html` (buildAssemblyPreamble ~7594); Test: `tests/js/assembly-duckdb.test.js`.

**Interfaces — Consumes:** arrays fra Task 1. **Produces:** SQL med
`USING ("a", "b")`/`EXCLUDE ("a", "b")`; python-preamble med `on=<liste>`.

- [ ] Step 1: Feilende tester — composite import-join gir
  `USING ("kommune_nr", "year")` + `EXCLUDE ("kommune_nr", "year")` og
  SELECT-liste som starter med begge nøklene; eksisterende tester oppdateres
  til array-nøkler (`key: ['pid']`).
- [ ] Step 2: compile: `keys = ds.key`; kolonnefilter `keys.indexOf(c) < 0`;
  keyList/onList = `.map(quoteIdent).join(', ')` i USING/EXCLUDE.
- [ ] Step 3: buildAssemblyPreamble: `_key = _ds.get('key') or []`;
  `_cols = list(_key) + [c for c in _st['columns'] if c not in _key]`;
  `merge(on=_key/…on=_st['on'])`.
- [ ] Step 4: node+pytest grønt. Commit: `compile/pandas-fallback: USING (a, b) for composite keys`.

### Task 3: `js/pxweb.js` — ren modul (TDD)

**Files:** Create `js/pxweb.js`; Test `tests/js/pxweb.test.js`.

**Interfaces — Produces:** `PxWeb.dataUrl(url)`, `PxWeb.metadataUrl(url)`
(query-merge; outputFormat=json-stat2 tvinges på data; lang=no default på
begge når query mangler lang), `PxWeb.columnsFromJsonStat(ds)` →
`{DimId: [koder], …, value: [tall|null]}` (row-major etter id/size; value som
array ELLER sparse objekt), `PxWeb.columnsToCsv(cols)` → CSV-tekst (RFC-quoting
som __colsToCsv: null/NaN → tom celle her — read_csv/pandas skal se NA).

- [ ] Step 1: Feilende tester med liten json-stat2-fixture (2×2×1: id
  ['Kjonn','Tid','ContentsCode'], size [2,2,1], category.index både objekt- og
  arrayform, sparse value-objekt i én test). URL-tester: query bevares,
  outputFormat overstyres, lang default/overstyrbar.
- [ ] Step 2: Implementer modulen (husets IIFE-mønster).
- [ ] Step 3: node grønt. Commit: `pxweb: json-stat2 → lang-format + URL-hjelpere som ren modul`.

### Task 4: resolve() + lastelaget

**Files:** Modify `js/data-directives.js` (pxweb-gren i resolve),
`js/data-loader.js` (pxweb-gren i fetchResolvedItems), `index.html`
(script-tag `js/pxweb.js` før data-loader.js); Test: eksisterende suiter +
liten resolve-test.

**Interfaces — Produces:** resolve gir `{url: <base>/<id>[?query], kind:
'pxweb', table: '<id>'}` (tabell-id kreves — ærlig feil uten, som duckdb);
fetchResolvedItems leverer `{alias, bytes: <csv-utf8>, format: 'csv', table,
kind: 'pxweb'}`.

- [ ] Step 1: resolve(): pxweb-gren rett ved duckdb/sqlite-grenen — krever
  rest; table = rest før evt. `?`; url = vanlig base+rest-join. Test i
  assembly-duckdb.test.js (parse+resolve) på feilmelding og table-felt.
- [ ] Step 2: fetchResolvedItems: `if (item.kind === 'pxweb')`-gren FØR
  vanlig fetchBytes: pseudo-item med `url: PxWeb.dataUrl(item.url)` gjennom
  fetchBytes (delt cache/proxy-fallback), JSON.parse → columnsFromJsonStat →
  columnsToCsv → TextEncoder-bytes, format 'csv'. (maybeDecrypt hoppes —
  offentlige API-data.) PxWeb-referansen: `global.PxWeb` med module.exports-
  fallback-require i node-testmiljø — samme mønster som DataDirectives-
  referansen i data-loader.js.
- [ ] Step 3: node+pytest grønt. Commit: `kind(pxweb): resolve + lastelag (json-stat2 → csv-bytes)`.

### Task 5: Montering + katalog/tab + i18n

**Files:** Modify `index.html` (resolveAssemblyColumns pxweb-presteg;
refreshConnectedSources/updateSidebarSources; microdataSlashSuggest),
`js/i18n/en.js`.

- [ ] Step 1: resolveAssemblyColumns, FØR canPushdown-sjekken: for
  deskriptorer med format 'pxweb' → DataLoader.fetchResolvedItems (csv-bytes)
  → `db.registerFileBuffer('_px_' + alias + '.csv', bytes)` → deskriptor
  omskrives til `{format:'csv', url:'_px_' + alias + '.csv', table}`.
- [ ] Step 2: refreshConnectedSources: i tillegg til connect-syntetiske loads,
  bygg (alias, tabell)-par fra scriptets ekte load-linjer + parseAssembly
  sourceTables der kind er pxweb; per par: fetch PxWeb.metadataUrl → JSON →
  kolonner = `id`-listen + 'value' → `__connectedSources[alias + '/' + tbl] =
  {url, format: 'pxweb', columns, types: [], sep: '.'}`. updateSidebarSources:
  bruk `entry.sep || '/'` i rad-etikettene.
- [ ] Step 3: microdataSlashSuggest: ny gren FØR dagens alias/-gren:
  `/([A-Za-z_]\w*)\/(\w+)\.([A-Za-z0-9_]*)$/` → oppslag
  `__connectedSources[alias + '/' + tabell]` → foreslå kolonner.
- [ ] Step 4: en.js-oppslag for nye t()-strenger (om noen). node+pytest grønt.
  Commit: `pxweb: montering (filbuffer-omskriving) + kildekatalog/tab fra metadata`.

### Task 6: Verifisering, ROADMAP, versjonsbump, push

- [ ] Step 1: Full suite (node, pytest, deno hvis tilgjengelig).
- [ ] Step 2: Browser-røyktest (én kompakt seanse, localhost:8123 +
  chrome-devtools, ingen skjermbilder uten feil):
  A. python-modus: `# connect https://data.ssb.no/api/pxwebapi/v2/tables as
  ssb, kind(pxweb)` + `# load ssb/05839 as bef` + `print(bef.head())` →
  lang-format med Alder/Kjonn/ContentsCode/Tid/value; katalogen viser
  `ssb/05839` med dimensjonskolonner.
  B. Composite keys ende-til-ende (lokal parquet under to aliaser):
  create-dataset med `key(kommune_nr year)` + import fra begge → 5985 rader
  (1:1-join på begge nøklene).
- [ ] Step 3: ROADMAP: kryss av API-kilde-punktet for SSB/PxWeb-delen; noter
  Eurostat/OECD-gjenbruk som gjenstående. M2PY_VERSION → '2026-07-24v'.
- [ ] Step 4: Commit + push; rapport til Hans med «pushet og live på <URL>»
  først + ærlige forbehold.
