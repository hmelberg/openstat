# Portable export — transpile load-directives to freestanding code (design)

**Status:** APPROVED 2026-07-23 (scope settled with Hans 2026-07-23 after the
directive-discipline discussion: keep strict `# load` discipline IN the app,
solve portability as an EXPORT transform instead of relaxing the delivery
rules. Modes: Python + R (DuckDB deferred). Delivery: download + clipboard
pair in the Fil menu.)

## Motivation

`# load`-directives are load-bearing in the app (CORS/proxy fallback,
server-side key injection, byte-caching, source list, scrubbing) — but they
make scripts non-portable: outside the editor the directives are dead
comments and the aliases never exist. Researchers take scripts to
Jupyter/RStudio; today that means hand-rewriting the data loading. The live
provider test (eval log 2026-07-23) also showed models are tempted to write
`requests` code precisely because portability feels valuable — an export
feature removes that temptation's justification while keeping in-app
discipline strict.

Key insight the transform exploits: **outside the browser there is no
CORS**, so proxy-wrapped URLs must be UNWRAPPED to direct source URLs — a
portable script can fetch straight from SSB, which the in-browser script
cannot.

## Design

### 1. Core module — `js/portable-export.js` (new)

Classic-script IIFE (window/globalThis), testable via the Deno eval harness
(like `data-loader.test.ts`). One API:

```
PortableExport.transpile(script, mode, registry)
  → { code: string, warnings: string[] }
```

- `mode` ∈ `"python" | "r"` (anything else → throw; UI never offers it).
- Uses `DataDirectives.parse` + `DataDirectives.resolve(parsed, registry)`
  — the same resolution the runtime uses (connect-aliases, registry ids,
  `kind()`/`key()`/`table()` options).
- Directive lines are replaced IN PLACE; every other line passes through
  unchanged. The original directive is kept as a comment immediately above
  its replacement (provenance stays visible).
- Output gets a small header comment: generated from OpenStat, that
  directives were transpiled, and a pointer back to the app.
- No directives in the script → `code === script` unchanged,
  `warnings: []`.
- Directive errors (unknown alias etc.) → throw with the same Norwegian
  message shape the runtime uses (`Direktivfeil: …`).

### 2. Transformation rules

Per resolved item `{alias, url, kind, viaProxy, key, table, anvil, exec}`:

- **Proxy unwrap:** a target of the form `/api/hent?url=<enc>` becomes the
  decoded inner URL. A `&body=<enc-json>` param reverses the GET-wrap into a
  real POST (`requests.post(url, json={…})` / R comment-guided
  `httr::POST`). Relative `/api/...` URLs that are NOT hent-wrappers are
  non-portable → comment block + warning.
- **Format choice:** explicit `kind()` wins; else URL extension
  (`.csv`/`.parquet`/`.json`/`.sqlite`/`.duckdb`); else default csv (matches
  the runtime's sniff default). The export cannot content-type-sniff — when
  it falls back to the csv default it appends a warning comment on the line.
- **Python emissions:**
  - csv → `alias = pd.read_csv("<url>", sep=None, engine="python")`
    (auto-separator — SSB/DST use semicolons).
  - parquet → `alias = pd.read_parquet("<url>")` + comment (`pyarrow`/
    `fsspec` required).
  - json → `alias = requests.get("<url>").json()` + comment that the in-app
    binding may differ (json-stat responses stay raw).
  - POST-wrapped → `alias = requests.post("<url>", json=<body>).…` with the
    same format handling on the response (csv → `io.StringIO` +
    `pd.read_csv`).
  - Needed imports (`pandas as pd`, `requests`, `io`) are added once at the
    top ONLY if not already imported in the script.
- **R emissions:**
  - csv → `alias <- read.csv("<url>")` + warning comment about separators
    (base R cannot auto-sniff; suggest `sep=";"` for Nordic statistics CSV).
  - json → `alias <- jsonlite::fromJSON("<url>")` + comment (jsonlite
    required).
  - POST-wrapped → `httr::POST` + `httr::content` skeleton with the body
    inlined, marked «krever httr» in a comment.
- **Keyed sources** (registry `auth`): a placeholder constant is emitted at
  the top of the output —
  `FRED_API_KEY = "SETT-INN-EGEN-NØKKEL"` (name derived `<ID>_API_KEY`) —
  and the fetch is built per the registry `plassering` rule (`query:` →
  appended URL param; `basic` → Basic-auth header from the placeholder).
  Comment states the key must be the user's own. `valgfri` sources export
  anonymously (no placeholder) with a comment that a key unlocks
  private/competition data. **Key VALUES never appear in the export**:
  `key(<literal>)` occurrences are masked exactly like the share-link path
  (`DataDirectives.scrubKeys` semantics), with a warning.
- **Non-portable sources** (encrypted envelopes via `key(...)`, Anvil/
  SafeStat-registered sources (`item.anvil`), `exec(remote)`): the directive
  is replaced by a clearly marked comment block («denne kilden krever
  OpenStat-appen — hopp over eller erstatt manuelt») + a warning; the rest
  of the script still exports.

### 3. UI — Fil menu pair

Two entries after the existing Del/Last ned pattern, visible only in
python/r modes via the existing `data-mode-only` mechanism:

- **«Last ned portabelt script»** — downloads `<scriptnavn>.py` / `.R`
  (falls back to `script.py`/`script.R` when unnamed).
- **«Kopier portabelt script»** — clipboard + the app's usual copied-
  confirmation.

Both run the transpile on the current editor content with the loaded
registry. `warnings.length > 0` → one short toast/alert:
«Eksportert med N merknader — se kommentarene i scriptet.»

### 4. Error handling

- Directive resolution errors → surface the thrown Norwegian message
  (same as Run does).
- Registry unavailable (offline) → resolve with empty registry: plain-URL
  loads still transpile; registry-id loads become non-portable comment
  blocks with a warning (never a hard failure).
- Clipboard API unavailable → fall back to download.

### 5. Testing

Deno eval-harness tests (`netlify/edge-functions/_lib/portable-export.test.ts`):
proxy unwrap (incl. POST reversal), connect-alias via registry, kind
override, csv default + warning, keyed source placeholder (query and basic),
valgfri anonymous export, `key(literal)` masking (value never in output),
non-portable comment block (anvil/encrypted), R variants, import-dedup, and
the no-directives passthrough. UI verified in the browser smoke test.

## Out of scope / roadmap

- DuckDB-mode export (SQL for duckdb CLI).
- Embedding fetched data in the export (the existing «Publiser dokument
  (HTML)» covers the frozen-data use case).
- Parsing json-stat into data frames in exported code (raw `.json()` +
  comment in v1).
- Auto-offering the portable variant in AI answers.
