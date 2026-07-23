# Portable export — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `PortableExport.transpile(script, mode, registry)` engine that replaces `# connect`/`# load`-directives with freestanding Python/R loading code (proxy URLs unwrapped, POST-wraps reversed, key placeholders, non-portable sources commented out), plus a download/clipboard pair in the Fil menu.

**Architecture:** New classic-script module `js/portable-export.js` reusing `DataDirectives.parse/resolve` (the runtime's own resolution). Directive lines are replaced in place — original directive kept as a comment above the emitted code; everything else passes through. UI handlers live in `js/github-storage.js` next to `shareLink` (same `$`/`T`/`toast`/registry-fetch idioms).

**Tech Stack:** Plain classic-script JS (IIFE on window/globalThis); Deno tests via the eval harness (`data-loader.test.ts` pattern).

**Spec:** `docs/superpowers/specs/2026-07-23-portable-export-design.md`

## Global Constraints

- Test command: `cd netlify/edge-functions && deno check *.ts _lib/*.ts _lib/providers/*.ts && deno test --allow-all _lib/`
- Key VALUES must never appear in exported code: `key(<literal>)` → masked via `DataDirectives.scrubKeys` semantics; registry keys become PLACEHOLDER constants only.
- Norwegian comments/warnings in the emitted code, matching the spec's exact texts where given.
- Emitted Python csv loads use `sep=None, engine="python"`; POST bodies are inlined via `json.loads(r'''<raw-json>''')` (never hand-converted true/false/null).
- No directives → `code === script` byte-identical, `warnings: []`.
- Directive resolution errors → `throw new Error('Direktivfeil: …')` (same shape as the runtime).
- Commit messages: `feat(...)`/`fix(...)` + Norwegian summary; commits on main; TDD per task.
- Plan-level decision (spec is silent): `kind(duckdb)`/`kind(sqlite)` loads are treated as NON-portable in v1 (comment block + warning) — their table-extraction semantics belong to the app.
- Plan-level simplification of spec §2 (documented deviation): full code emission for keyed sources is built ONLY for `query:`-placement; `basic`/`header:`-placement keyed sources get a placeholder constant + guidance comment instead of executable auth code. Rationale: the only shipped basic source (kaggle) is `valgfri` and exports anonymously, so the executable-basic path has no current consumer (YAGNI).

---

### Task 1: Core engine — Python emissions (`js/portable-export.js`)

**Files:**
- Create: `js/portable-export.js`
- Test: `netlify/edge-functions/_lib/portable-export.test.ts`

**Interfaces:**
- Consumes: `global.DataDirectives` (`parse(script)` → `{connects, loads:[{verb,target,alias,options,line}], errors}`; `resolve(parsed, registry)` → per load `{alias,url,viaProxy,key,exec,kind,table,anvil?,error?}`; `scrubKeys(script)`).
- Produces (Tasks 2-4 rely on): `global.PortableExport = { transpile }` with
  `transpile(script, mode /* "python"|"r" */, registry /* array|null */) → { code: string, warnings: string[] }`.
  Internal seams Task 2/3 extend: `emitPython(item, url, body, fmt, out)` and a mode dispatch in `emitFor` — Task 2 adds `emitR`, Task 3 adds the keyed/non-portable branches BEFORE format emission.

- [ ] **Step 1: Write the failing tests**

Create `netlify/edge-functions/_lib/portable-export.test.ts`:

```ts
import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";

for (const f of ["data-directives.js", "portable-export.js"]) {
  (0, eval)(await Deno.readTextFile(new URL(`../../../js/${f}`, import.meta.url)));
}
// deno-lint-ignore no-explicit-any
const PE = (globalThis as any).PortableExport;

Deno.test("passthrough: script uten direktiver er byte-identisk", () => {
  const s = "import pandas as pd\nprint('hei')\n";
  const out = PE.transpile(s, "python", []);
  assertEquals(out.code, s);
  assertEquals(out.warnings, []);
});

Deno.test("GET csv: direkte URL → pd.read_csv, original som kommentar, header + import lagt til", () => {
  const s = "# load https://ourworldindata.org/grapher/life-expectancy.csv as co2\nprint(co2.head())\n";
  const out = PE.transpile(s, "python", []);
  if (!out.code.includes("Portabel eksport fra OpenStat")) throw new Error("mangler header:\n" + out.code);
  if (!out.code.includes("import pandas as pd")) throw new Error("mangler pandas-import");
  if (!out.code.includes('# load https://ourworldindata.org/grapher/life-expectancy.csv as co2')) {
    throw new Error("originaldirektivet mangler som kommentar");
  }
  if (!out.code.includes('co2 = pd.read_csv("https://ourworldindata.org/grapher/life-expectancy.csv", sep=None, engine="python")')) {
    throw new Error("feil emisjon:\n" + out.code);
  }
  assertEquals(out.warnings, []);
});

Deno.test("proxy-utpakking: /api/hent?url=<enc> → indre URL", () => {
  const inner = "https://data.ssb.no/api/pxwebapi/v2/tables/05839/data?valueCodes[Kjonn]=0&outputFormat=csv";
  const s = "# load /api/hent?url=" + encodeURIComponent(inner) + " as ledighet\n";
  const out = PE.transpile(s, "python", []);
  if (!out.code.includes(`ledighet = pd.read_csv(${JSON.stringify(inner)}, sep=None, engine="python")`)) {
    throw new Error("indre URL ikke pakket ut:\n" + out.code);
  }
  if (out.code.includes("/api/hent")) {
    // originaldirektivet (kommentaren) FÅR inneholde /api/hent — men emisjonslinjen skal ikke
    const emitted = out.code.split("\n").filter((l) => l.includes("pd.read_csv"));
    if (emitted.some((l) => l.includes("/api/hent"))) throw new Error("proxy-URL i emisjon");
  }
});

Deno.test("POST-reversering: &body= → requests.post + json.loads", () => {
  const inner = "https://statfin.stat.fi/PXWeb/api/v1/en/StatFin/tyokay/tabell.px";
  const body = JSON.stringify({ query: [], response: { format: "csv" } });
  const s = "# load /api/hent?url=" + encodeURIComponent(inner) + "&body=" + encodeURIComponent(body) + " as syss\n";
  const out = PE.transpile(s, "python", []);
  if (!out.code.includes("requests.post(")) throw new Error("mangler requests.post:\n" + out.code);
  if (!out.code.includes("json.loads(r'''" + body + "''')")) throw new Error("body ikke inlinet via json.loads");
  if (!out.code.includes("io.StringIO(")) throw new Error("csv-respons skal leses via io.StringIO");
  for (const imp of ["import requests", "import io", "import json"]) {
    if (!out.code.includes(imp)) throw new Error("mangler " + imp);
  }
});

Deno.test("kind(json) → .json()-emisjon m/ rå-JSON-kommentar", () => {
  const s = "# load https://api.worldbank.org/v2/country/NO/indicator/X?format=json as wb, kind(json)\n";
  const out = PE.transpile(s, "python", []);
  if (!out.code.includes('wb = requests.get("https://api.worldbank.org/v2/country/NO/indicator/X?format=json").json()')) {
    throw new Error("feil json-emisjon:\n" + out.code);
  }
});

Deno.test("connect + register-id løses via registry; cors:false-kilde blir DIREKTE URL", () => {
  const REG = [{ id: "ssb", navn: "SSB", utgiver: "SSB", tillit: "offisiell", tilgang: "pxweb",
    base_url: "https://data.ssb.no/api/pxwebapi/v2-beta/", cors: false }];
  const s = "# connect ssb\n# load ssb/tables/05839/metadata as meta, kind(json)\n";
  const out = PE.transpile(s, "python", REG);
  if (!out.code.includes('meta = requests.get("https://data.ssb.no/api/pxwebapi/v2-beta/tables/05839/metadata").json()')) {
    throw new Error("registry-oppløsning feilet:\n" + out.code);
  }
});

Deno.test("parquet og csv-default: endelse styrer; ukjent endelse → csv + warning", () => {
  const s = "# load https://x.example/data.parquet as p\n# load https://x.example/api/rows as r\n";
  const out = PE.transpile(s, "python", []);
  if (!out.code.includes('p = pd.read_parquet("https://x.example/data.parquet")')) throw new Error("parquet-emisjon mangler");
  if (!out.code.includes('r = pd.read_csv("https://x.example/api/rows", sep=None, engine="python")')) throw new Error("csv-default mangler");
  if (!out.warnings.some((w: string) => w.includes("r"))) throw new Error("mangler csv-default-warning: " + JSON.stringify(out.warnings));
});

Deno.test("import-dedup: eksisterende 'import pandas as pd' dupliseres ikke", () => {
  const s = "import pandas as pd\n# load https://x.example/d.csv as df\n";
  const out = PE.transpile(s, "python", []);
  const count = (out.code.match(/^import pandas as pd$/gm) || []).length;
  assertEquals(count, 1);
});

Deno.test("direktivfeil → Error('Direktivfeil: …')", () => {
  assertThrows(() => PE.transpile("# load ukjent/tab as x\n", "python", []), Error, "Direktivfeil");
});

Deno.test("ukjent mode → Error", () => {
  assertThrows(() => PE.transpile("print(1)", "duckdb", []), Error);
});
```

- [ ] **Step 2: RED** — `cd netlify/edge-functions && deno test --allow-all _lib/portable-export.test.ts` → module not found.

- [ ] **Step 3: Implement `js/portable-export.js`**

```js
// Portabel eksport (spec 2026-07-23-portable-export-design): transpilerer
// # connect/# load-direktiver til frittstående lastekode. Nøkkelinnsikt:
// utenfor nettleseren finnes ikke CORS, så /api/hent-innpakkede URL-er
// pakkes UT til direkte kilde-URL-er. Direktivlinjene erstattes på stedet
// (original beholdt som kommentar over); alt annet passerer uendret.
// Testes i deno via eval (portable-export.test.ts).
(function (global) {
  'use strict';

  var HEADER = [
    '# ── Portabel eksport fra OpenStat ──',
    '# «# load»-direktivene er oversatt til frittstående lastekode.',
    '# Generert av appen — rediger fritt.',
  ];

  // /api/hent?url=<enc>[&body=<enc-json>] → {url, body|null}; ellers null.
  function decodeHentUrl(target) {
    if (target.indexOf('/api/hent?') !== 0) return null;
    var mUrl = /[?&]url=([^&]+)/.exec(target);
    if (!mUrl) return null;
    var mBody = /[?&]body=([^&]+)/.exec(target);
    try {
      return {
        url: decodeURIComponent(mUrl[1]),
        body: mBody ? decodeURIComponent(mBody[1]) : null,
      };
    } catch (e) { return null; }
  }

  // kind() vinner; ellers URL-endelse; ellers csv (som kjøretidens default) + warn.
  function formatFor(item, url, warnings) {
    if (item.kind) return item.kind;
    if (/\.parquet(\?|$)/.test(url)) return 'parquet';
    if (/\.json(\?|$)/.test(url)) return 'json';
    if (/\.csv(\?|$)/.test(url)) return 'csv';
    warnings.push('«' + item.alias + '»: ukjent format — antar csv (bruk kind(...) i direktivet for å styre)');
    return 'csv';
  }

  function pyStr(s) { return JSON.stringify(s); }

  // Emisjon for én kilde i python-modus. out.lines fylles; out.needs merkes.
  function emitPython(item, url, body, fmt, out) {
    if (body !== null) {
      out.needs.requests = true;
      out.needs.json = true;
      if (fmt === 'json') {
        out.lines.push(item.alias + ' = requests.post(' + pyStr(url) + ", json=json.loads(r'''" + body + "''')).json()");
      } else {
        out.needs.io = true;
        out.needs.pandas = true;
        out.lines.push('_resp = requests.post(' + pyStr(url) + ", json=json.loads(r'''" + body + "'''))");
        out.lines.push(item.alias + ' = pd.read_csv(io.StringIO(_resp.text), sep=None, engine="python")');
      }
      return;
    }
    if (fmt === 'json') {
      out.needs.requests = true;
      out.lines.push(item.alias + ' = requests.get(' + pyStr(url) + ').json()  # rå JSON — appens binding kan avvike');
      return;
    }
    if (fmt === 'parquet') {
      out.needs.pandas = true;
      out.lines.push(item.alias + ' = pd.read_parquet(' + pyStr(url) + ')  # krever pyarrow');
      return;
    }
    out.needs.pandas = true;
    out.lines.push(item.alias + ' = pd.read_csv(' + pyStr(url) + ', sep=None, engine="python")');
  }

  // Importblokk for python — bare det som trengs og ikke alt finnes i scriptet.
  function pythonImports(needs, script) {
    var want = [];
    if (needs.pandas && !/^\s*import pandas as pd\b/m.test(script)) want.push('import pandas as pd');
    if (needs.requests && !/^\s*import requests\b/m.test(script)) want.push('import requests');
    if (needs.io && !/^\s*import io\b/m.test(script)) want.push('import io');
    if (needs.json && !/^\s*import json\b/m.test(script)) want.push('import json');
    return want;
  }

  // Én kilde → linjer. Task 3 legger nøkkel/ikke-portabel-grener FØRST her.
  function emitFor(item, mode, registry, warnings, needs) {
    var out = { lines: [], needs: needs };
    var url = item.url, body = null;
    var hent = decodeHentUrl(url);
    if (hent) { url = hent.url; body = hent.body; }
    if (url.indexOf('/') === 0) {
      out.lines.push('# (ikke portabel: app-intern URL «' + url + '» — hopp over eller erstatt manuelt)');
      warnings.push('«' + item.alias + '»: app-intern URL kan ikke gjøres portabel');
      return out.lines;
    }
    if (item.kind === 'duckdb' || item.kind === 'sqlite') {
      out.lines.push('# (ikke portabel i v1: ' + item.kind + '-kilde med tabellen «' + (item.table || '') + '» — last ned fila og spør den manuelt)');
      warnings.push('«' + item.alias + '»: ' + item.kind + '-kilder eksporteres ikke i v1');
      return out.lines;
    }
    var fmt = formatFor(item, url, warnings);
    if (mode === 'python') emitPython(item, url, body, fmt, out);
    else emitR(item, url, body, fmt, out);   // Task 2
    return out.lines;
  }

  function emitR() { throw new Error('R-eksport kommer i neste oppgave'); } // erstattes i Task 2

  function transpile(script, mode, registry) {
    if (mode !== 'python' && mode !== 'r') throw new Error('portabel eksport støtter python og r, ikke «' + mode + '»');
    var DD = global.DataDirectives;
    var parsed = DD.parse(script);
    if (parsed.errors.length) throw new Error('Direktivfeil: ' + parsed.errors.join('; '));
    if (!parsed.loads.length) return { code: script, warnings: [] };
    var resolved = DD.resolve(parsed, registry || []);
    var bad = resolved.filter(function (r) { return r.error; });
    if (bad.length) throw new Error('Direktivfeil: ' + bad.map(function (b) { return b.error; }).join('; '));

    var warnings = [];
    var needs = {};
    // load-linje (trimmet tekst) → emitterte linjer, konsumert i rekkefølge.
    var queue = parsed.loads.map(function (l, i) {
      return { line: l.line, emitted: emitFor(resolved[i], mode, registry || [], warnings, needs) };
    });

    var outLines = [];
    var lines = String(script).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var trimmed = lines[i].trim();
      var qi = -1;
      for (var q = 0; q < queue.length; q++) {
        if (queue[q] && queue[q].line === trimmed) { qi = q; break; }
      }
      if (qi >= 0) {
        outLines.push(lines[i]);                 // originaldirektivet som kommentar
        outLines.push.apply(outLines, queue[qi].emitted);
        queue[qi] = null;                        // konsumert (duplikatlinjer i rekkefølge)
      } else {
        outLines.push(lines[i]);
      }
    }

    var head = HEADER.slice();
    var imports = mode === 'python' ? pythonImports(needs, script) : rImports(needs, script); // rImports: Task 2
    var code = head.concat(imports.length ? imports : []).concat(['']).join('\n') + outLines.join('\n');
    return { code: code, warnings: warnings };
  }

  function rImports() { return []; } // erstattes i Task 2

  global.PortableExport = { transpile: transpile };
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: GREEN** — the R-mode test cases don't exist yet, so `emitR`'s throw is unreached. Run the focused file → all pass. Then full check.

- [ ] **Step 5: Commit**

```bash
git add js/portable-export.js netlify/edge-functions/_lib/portable-export.test.ts
git commit -m "feat(eksport): portabel transpileringsmotor (python) — proxy-utpakking, POST-reversering, formatvalg, import-dedup, direktiv som kommentar"
```

---

### Task 2: R emissions

**Files:**
- Modify: `js/portable-export.js` (replace the `emitR`/`rImports` stubs)
- Test: `netlify/edge-functions/_lib/portable-export.test.ts`

**Interfaces:**
- Consumes: Task 1's seams (`emitFor` dispatches `mode === 'r'` to `emitR(item, url, body, fmt, out)`; `rImports(needs, script)` returns lines for the header block).
- Produces: R-mode transpilation. R has no import statements to dedup — `rImports` returns `[]` always (packages are referenced with `::`); the header keeps only the comment block.

- [ ] **Step 1: Write the failing tests**

Append to `portable-export.test.ts`:

```ts
Deno.test("R: GET csv → read.csv m/ separator-kommentar", () => {
  const s = "-- load https://x.example/d.csv as df\nsummary(df)\n";
  const out = PE.transpile(s, "r", []);
  if (!out.code.includes('df <- read.csv("https://x.example/d.csv")  # NB: sjekk skilletegn — nordiske CSV-er bruker ofte sep=";"')) {
    throw new Error("feil R-csv-emisjon:\n" + out.code);
  }
});

Deno.test("R: kind(json) → jsonlite::fromJSON", () => {
  const s = "# load https://x.example/d as j, kind(json)\n";
  const out = PE.transpile(s, "r", []);
  if (!out.code.includes('j <- jsonlite::fromJSON("https://x.example/d")  # krever jsonlite')) {
    throw new Error("feil R-json-emisjon:\n" + out.code);
  }
});

Deno.test("R: POST-reversering → httr::POST-skjelett", () => {
  const inner = "https://statfin.stat.fi/PXWeb/api/v1/en/t.px";
  const body = JSON.stringify({ query: [], response: { format: "csv" } });
  const s = "# load /api/hent?url=" + encodeURIComponent(inner) + "&body=" + encodeURIComponent(body) + " as syss\n";
  const out = PE.transpile(s, "r", []);
  if (!out.code.includes('httr::POST("https://statfin.stat.fi/PXWeb/api/v1/en/t.px"')) throw new Error("mangler httr::POST:\n" + out.code);
  if (!out.code.includes(body.replace(/"/g, '\\"')) && !out.code.includes("'" + body + "'")) {
    throw new Error("body ikke inlinet:\n" + out.code);
  }
  if (!out.code.includes("# krever httr")) throw new Error("mangler pakke-kommentar");
});

Deno.test("R: parquet → nedlasting + arrow, med kommentar", () => {
  const s = "# load https://x.example/d.parquet as p\n";
  const out = PE.transpile(s, "r", []);
  if (!out.code.includes('download.file("https://x.example/d.parquet"')) throw new Error("mangler download.file:\n" + out.code);
  if (!out.code.includes("arrow::read_parquet")) throw new Error("mangler arrow::read_parquet");
});
```

- [ ] **Step 2: RED** — `emitR` throws.

- [ ] **Step 3: Implement** — replace the two stubs:

```js
  function rStr(s) { return JSON.stringify(s); }

  function emitR(item, url, body, fmt, out) {
    if (body !== null) {
      out.lines.push('# krever httr (+ jsonlite for JSON-svar):');
      out.lines.push('_resp <- httr::POST(' + rStr(url) + ", body = '" + body.replace(/'/g, "\\'") + "', encode = \"raw\", httr::content_type_json())");
      if (fmt === 'json') {
        out.lines.push(item.alias + ' <- httr::content(_resp, as = "parsed")');
      } else {
        out.lines.push(item.alias + ' <- read.csv(text = httr::content(_resp, as = "text"))  # NB: sjekk skilletegn (sep=";")');
      }
      return;
    }
    if (fmt === 'json') {
      out.lines.push(item.alias + ' <- jsonlite::fromJSON(' + rStr(url) + ')  # krever jsonlite');
      return;
    }
    if (fmt === 'parquet') {
      var tmp = '"' + item.alias + '.parquet"';
      out.lines.push('download.file(' + rStr(url) + ', ' + tmp + ', mode = "wb")');
      out.lines.push(item.alias + ' <- arrow::read_parquet(' + tmp + ')  # krever arrow');
      return;
    }
    out.lines.push(item.alias + ' <- read.csv(' + rStr(url) + ')  # NB: sjekk skilletegn — nordiske CSV-er bruker ofte sep=";"');
  }

  function rImports() { return []; }   // R: pakker refereres med :: — ingen import-blokk
```

(Delete the two stub definitions from Task 1; `rImports` keeps the same empty-array behavior but with the explanatory comment.)

- [ ] **Step 4: GREEN + full check.**

- [ ] **Step 5: Commit**

```bash
git add js/portable-export.js netlify/edge-functions/_lib/portable-export.test.ts
git commit -m "feat(eksport): R-emisjoner — read.csv/jsonlite/httr::POST/arrow m/ ærlige pakke- og separatorkommentarer"
```

---

### Task 3: Keyed sources, valgfri, non-portable blocks, key masking

**Files:**
- Modify: `js/portable-export.js` (`emitFor` gains branches before format emission; `transpile` gains scrub + placeholder collection)
- Test: `netlify/edge-functions/_lib/portable-export.test.ts`

**Interfaces:**
- Consumes: registry entries with `auth: {type, env?, user?, valgfri?, plassering}` (shape from `_lib/registry.ts`); resolved items with `key` (from `key(...)`), `anvil`, `exec`.
- Produces: complete engine per spec §2's keyed/non-portable rules.

- [ ] **Step 1: Write the failing tests**

Append:

```ts
const FRED_REG = [{ id: "fred", navn: "FRED", utgiver: "Fed", tillit: "etablert", tilgang: "rest",
  base_url: "https://api.stlouisfed.org/fred/", cors: false,
  auth: { type: "api_key", env: "FRED_API_KEY", plassering: "query:api_key" } }];
const KAGGLE_REG = [{ id: "kaggle", navn: "Kaggle", utgiver: "K", tillit: "etablert", tilgang: "rest",
  base_url: "https://www.kaggle.com/api/v1/", cors: false,
  auth: { type: "api_key", user: true, valgfri: true, plassering: "basic" } }];

Deno.test("nøkkelkilde (query-plassering) → plassholder-konstant + param i URL + warning", () => {
  const s = "# connect fred\n# load fred/series/observations?series_id=UNRATE&file_type=json as u, kind(json)\n";
  const out = PE.transpile(s, "python", FRED_REG);
  if (!out.code.includes('FRED_API_KEY = "SETT-INN-EGEN-NØKKEL"')) throw new Error("mangler plassholder:\n" + out.code);
  if (!out.code.includes('"&api_key=" + FRED_API_KEY')) throw new Error("nøkkelparam ikke bygget:\n" + out.code);
  if (!out.warnings.some((w: string) => w.includes("nøkkel"))) throw new Error("mangler warning");
  if (out.code.includes("SETT-INN-EGEN-NØKKEL\"\nFRED_API_KEY")) throw new Error("plassholder duplisert");
});

Deno.test("valgfri kilde (kaggle) → anonym eksport + kommentar, ingen plassholder", () => {
  const s = "# connect kaggle\n# load kaggle/datasets/download/o/s/f.csv as k\n";
  const out = PE.transpile(s, "python", KAGGLE_REG);
  if (out.code.includes("SETT-INN-EGEN-NØKKEL")) throw new Error("valgfri kilde skal ikke få plassholder");
  if (!out.code.includes("# nøkkel er valgfri")) throw new Error("mangler valgfri-kommentar:\n" + out.code);
  if (!out.code.includes('k = pd.read_csv("https://www.kaggle.com/api/v1/datasets/download/o/s/f.csv"')) {
    throw new Error("anonym emisjon mangler:\n" + out.code);
  }
});

Deno.test("key(<literal>) maskeres i output og gir warning", () => {
  const s = "# load https://x.example/hemmelig.csv as h, key(supersecret123)\n";
  const out = PE.transpile(s, "python", []);
  if (out.code.includes("supersecret123")) throw new Error("nøkkelliteral lekket til eksport");
  if (!out.code.includes("key(***)")) throw new Error("maskering mangler i kommentarlinjen");
  if (!out.warnings.some((w: string) => w.includes("h"))) throw new Error("mangler warning for kryptert kilde");
});

Deno.test("anvil-kilde og exec(remote) → ikke-portabel kommentarblokk, resten eksporteres", () => {
  const s = "# connect minkilde\n# load minkilde as d\nprint('etterpå')\n";
  const out = PE.transpile(s, "python", []);   // tomt register → anvil-gren
  if (!out.code.includes("krever OpenStat-appen")) throw new Error("mangler ikke-portabel-blokk:\n" + out.code);
  if (!out.code.includes("print('etterpå')")) throw new Error("resten av scriptet mangler");
  if (!out.warnings.length) throw new Error("mangler warning");
});
```

- [ ] **Step 2: RED.**

- [ ] **Step 3: Implement.** In `emitFor`, BEFORE the `decodeHentUrl` handling, add:

```js
    // Ikke-portable kilder (spec §2): krypterte (key), Anvil/SafeStat, remote.
    if (item.anvil || item.exec === 'remote' || item.key) {
      out.lines.push('# (denne kilden krever OpenStat-appen — hopp over eller erstatt manuelt: «' + item.alias + '»)');
      warnings.push('«' + item.alias + '»: kilden krever appen (kryptert/registrert/remote) og ble ikke transpilert');
      return out.lines;
    }
```

After URL unwrap (so `url` is the direct URL), add the keyed-source branch:

```js
    // Registerkilder med auth: plassholder-nøkkel (aldri verdier) — spec §2.
    var authSrc = findAuthSource(url, registry);
    if (authSrc && authSrc.auth) {
      if (authSrc.auth.valgfri) {
        out.lines.push('# nøkkel er valgfri for ' + authSrc.id + ' — åpne datasett virker uten; privat-/konkurransedata krever egen nøkkel');
      } else {
        var cname = authSrc.id.toUpperCase() + '_API_KEY';
        needs.placeholders = needs.placeholders || {};
        needs.placeholders[cname] = true;
        warnings.push('«' + item.alias + '»: ' + authSrc.id + ' krever egen nøkkel — sett inn verdien i ' + cname);
        var plass = authSrc.auth.plassering || '';
        if (plass.indexOf('query:') === 0) {
          var param = plass.slice(6);
          // URL-en bygges i koden med nøkkelen limt på:
          if (mode === 'python') {
            out.lines.push('_url_' + item.alias + ' = ' + pyStr(url) + ' + "' + (url.indexOf('?') >= 0 ? '&' : '?') + param + '=" + ' + cname);
          } else {
            out.lines.push('_url_' + item.alias + ' <- paste0(' + rStr(url) + ', "' + (url.indexOf('?') >= 0 ? '&' : '?') + param + '=", ' + cname + ')');
          }
          url = '__URLVAR__' + item.alias;   // marker: emisjonen bruker variabelen
        } else {
          out.lines.push('# ' + authSrc.id + ' bruker ' + plass + '-autentisering — legg nøkkelen i ' + cname + ' og send den som beskrevet i API-dokumentasjonen');
        }
      }
    }
```

and in `emitPython`/`emitR`, when the url starts with `__URLVAR__`, emit the variable name (`_url_<alias>`) instead of a string literal (small helper `urlExpr(url, item, mode)` used by both). `findAuthSource(url, registry)` matches `new URL(url).host` against entries' `base_url` host, same as `js/data-loader.js`'s `userAuthSourceFor` but for ANY `auth` (copy the try/catch URL-parse defensiveness).

In `transpile`, after building `code`:

```js
    // Plassholder-konstanter øverst (etter header, før imports):
    var placeholders = Object.keys((needs.placeholders || {}));
    // python: NAVN = "SETT-INN-EGEN-NØKKEL"; r: NAVN <- "SETT-INN-EGEN-NØKKEL"
    // — settes inn i head-blokken i samme rekkefølge som de oppdages.
    // Til slutt: maskér alle key(<literal>) i output (delelenke-regelen):
    var scrubbed = DD.scrubKeys(code);
    if (scrubbed !== code) warnings.push('key(...)-verdier ble maskert i eksporten — bruk key(ask) eller egen nøkkelhåndtering utenfor appen');
    code = scrubbed;
```

(Insert placeholders into the `head` array before joining — restructure the tail of `transpile` accordingly; the Task 1 tests must keep passing unchanged.)

- [ ] **Step 4: GREEN + full check.**

- [ ] **Step 5: Commit**

```bash
git add js/portable-export.js netlify/edge-functions/_lib/portable-export.test.ts
git commit -m "feat(eksport): nøkkel-plassholdere per plasseringsregel, valgfri-kommentar, ikke-portable blokker, key(literal)-maskering"
```

---

### Task 4: UI — Fil-meny (last ned + kopier) + i18n

**Files:**
- Modify: `index.html` (Fil-submenu, after `menuSave` line ~24)
- Modify: `js/github-storage.js` (handlers next to `shareLink`, wiring in the `on(...)` block ~line 823, icons map ~line 805)
- Modify: `js/i18n/en.js`
- Modify: `index.html` script includes: add `<script src="js/portable-export.js"></script>` before `js/github-storage.js`

**Interfaces:**
- Consumes: `PortableExport.transpile`, `$`/`T`/`toast`/`closeMenu` in github-storage.js, `data-mode-only` visibility, `window.M2PY.currentMode()`.
- Produces: menu entries `menuPortableSave` and `menuPortableCopy`, visible only in python/r.

- [ ] **Step 1: Markup**

In `index.html`'s Fil-submenu, after the `menuSave` button:

```html
            <button type="button" id="menuPortableSave" data-mode-only="python r" data-i18n-title title="Last ned scriptet med # load-direktivene oversatt til frittstående kode (pd.read_csv/requests eller read.csv) — kan kjøres i Jupyter/RStudio utenfor appen." data-i18n>Last ned portabelt script</button>
            <button type="button" id="menuPortableCopy" data-mode-only="python r" data-i18n>Kopier portabelt script</button>
```

Add `<script src="js/portable-export.js"></script>` immediately BEFORE the `js/github-storage.js` include (in the block near line 11780).

- [ ] **Step 2: Handlers in `js/github-storage.js`** (place directly after `shareLink`):

```js
      // --- Portabel eksport (spec 2026-07-23-portable-export-design) ---
      var _peRegistry = null;
      async function peRegistry() {
        if (_peRegistry) return _peRegistry;
        try {
          const r = await fetch('data/data-sources.json');
          _peRegistry = r.ok ? await r.json() : [];
        } catch (e) { _peRegistry = []; }   // offline: URL-loads virker fortsatt
        return _peRegistry;
      }

      async function portableCode() {
        const si = $('scriptInput');
        const script = si ? si.value : '';
        if (!script.trim()) { alert(T('Editoren er tom — ingenting å eksportere.')); return null; }
        const mode = (window.M2PY && window.M2PY.currentMode && window.M2PY.currentMode().id) || 'python';
        try {
          return window.PortableExport.transpile(script, mode, await peRegistry());
        } catch (e) {
          alert(T('Kunne ikke eksportere: {msg}', { msg: e.message || e }));
          return null;
        }
      }

      function peToastWarnings(w) {
        if (w && w.length) toast(T('Eksportert med {n} merknader — se kommentarene i scriptet', { n: w.length }));
      }

      async function portableSave() {
        closeMenu();
        const out = await portableCode();
        if (!out) return;
        const mode = (window.M2PY && window.M2PY.currentMode && window.M2PY.currentMode().id) || 'python';
        const ext = mode === 'r' ? '.R' : '.py';
        const name = (($('scriptName') && $('scriptName').value) || 'script').trim().replace(/\.(txt|py|r)$/i, '') + ext;
        const blob = new Blob([out.code], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        URL.revokeObjectURL(a.href);
        peToastWarnings(out.warnings);
      }

      async function portableCopy() {
        closeMenu();
        const out = await portableCode();
        if (!out) return;
        try {
          await navigator.clipboard.writeText(out.code);
          toast(T('Portabelt script kopiert til utklippstavlen'));
          peToastWarnings(out.warnings);
        } catch (e) {
          // Clipboard utilgjengelig → fall tilbake til nedlasting (spec §4).
          portableSave();
        }
      }
```

Wire them in the `on(...)` block (next to `on('menuShareLink', shareLink);`):

```js
        on('menuPortableSave', portableSave);
        on('menuPortableCopy', portableCopy);
```

Add icons to the icon map (reuse the download-arrow path for `menuPortableSave` and the share path for `menuPortableCopy` — copy the existing `menuSave`/`menuShareLink` SVG strings under the new keys).

- [ ] **Step 3: i18n** (`js/i18n/en.js`; skip keys that exist):

```js
  "Last ned portabelt script": "Download portable script",
  "Kopier portabelt script": "Copy portable script",
  "Last ned scriptet med # load-direktivene oversatt til frittstående kode (pd.read_csv/requests eller read.csv) — kan kjøres i Jupyter/RStudio utenfor appen.": "Download the script with the # load directives translated to freestanding code (pd.read_csv/requests or read.csv) — runs in Jupyter/RStudio outside the app.",
  "Editoren er tom — ingenting å eksportere.": "The editor is empty — nothing to export.",
  "Kunne ikke eksportere: {msg}": "Could not export: {msg}",
  "Eksportert med {n} merknader — se kommentarene i scriptet": "Exported with {n} notes — see the comments in the script",
  "Portabelt script kopiert til utklippstavlen": "Portable script copied to the clipboard",
```

- [ ] **Step 4: Verify + commit**

`node --check js/github-storage.js && node --check js/portable-export.js && node --check js/i18n/en.js` → silent. Full deno check/test still green.

```bash
git add index.html js/github-storage.js js/portable-export.js js/i18n/en.js
git commit -m "feat(ui): Fil-menyen får Last ned/Kopier portabelt script (python/r) m/ registeroppslag, warnings-toast og clipboard-fallback"
```

- [ ] **Step 5 (controller): browser smoke test**

Static serve + Playwright: (1) in python mode the two entries are visible in Fil-menyen, in microdata mode hidden; (2) with a script containing `# load /api/hent?url=<enc SSB-url> as x`, «Kopier portabelt script» produces code where the emitted line contains the DIRECT SSB URL (no `/api/hent`), a pandas import, and the original directive as comment (read the clipboard via `navigator.clipboard.readText()` in the page context); (3) empty editor → the Norwegian alert path (verify via dialog handler or by checking the function returns without toast).

---

## Post-plan notes

- Deferred by spec: DuckDB-mode export, data-embedding, json-stat parsing, auto-offering in AI answers.
- The engine is deliberately UI-independent — the save-time-appendix idea (evaluated and declined 2026-07-23) can reuse `transpile` unchanged if revived.
