# Brython engine for openstat/safestat — design

**Date:** 2026-07-10
**Status:** Approved (design discussion with Hans, 2026-07-10)
**Applies to:** `openstat/` and `safestat/` (duplicated code, both must be updated)

## Goal

Add **Brython** as a lightweight Python engine so published dashboards load in ~1–2 s
(Brython core+stdlib ≈ 3 MB) instead of Pyodide's 10–30 s cold boot (≈ 20 MB + WASM
compile). Primary use case: **dashboard viewers** — dashboards that must render
instantly on first visit, low-end devices, and mobile.

Brython is a *separate, clearly-branded fast tier*, not a third full Python:

- Mode name in UI: **Brython** (distinct from the existing Python/Pyodide mode).
- Library imports make the difference explicit:
  `import pandas_brython as pd` and `import plotly_express_brython as pe`.
- Anything needing real pandas/numpy/statsmodels stays in Python (Pyodide) mode.

## Non-goals (phase 1)

- Widgets (`ui.py` / `newui.py` from code2web) — dashboards already have a widget layer.
- Cross-runtime sync/event API from code2web.
- `# use <name> from python/r/duckdb` (cross-engine frame bridge) — deferred.
- Filling the pandas gaps (`merge`, `pivot`, `melt`, `corr`, `rolling`, …) — these
  raise clear errors instead (see Error handling).
- Refactoring the openstat/safestat engine-layer duplication (possible later,
  independently).

## Source material

- **code2web is the authoritative source** for the pure-Python libraries
  (`pandas.py` ~3 150 lines, `plotly_express.py` ~3 300 lines, runner pattern in
  `brython_shared_module.py`). xplainer contains only a thin display shim — nothing
  to reuse from there.
- openstat/safestat already contain planning comments for Brython at the exact seams
  (`RUNTIME_FOR_MODE`, eager-load branch, run-cost branch), e.g. openstat
  `index.html:3355-3358`.

## Architecture

Approach: **self-contained engine file with minimal hooks** (option A of three
considered; B = refactor shared engine layer first, C = embed code2web runtime —
both rejected: B touches everything, C bypasses data directives and publishing).

### New files (identical copies in both repos, like the rest of `js/`)

| File | Contents |
|---|---|
| `js/brython-engine.js` | Memoized loader + runner + data binding (see below). |
| `brython/pandas_brython.py` | code2web `pandas.py`, renamed; gap-verbs raise clear errors. |
| `brython/plotly_express_brython.py` | code2web `plotly_express.py`, renamed; `plotlyplot:` output convention removed — the library builds figure objects, the runner owns serialization. |

`js/brython-engine.js` responsibilities:

1. **Loader** — memoized in-flight promise (same pattern as `__ensureDuckDB()` /
   `__pyodidePromise`): inject `brython@3.12.0/brython.min.js` +
   `brython_stdlib.js` from jsdelivr, call `brython()`, then fetch the two `.py`
   libraries and register each as `<script type="text/python" id="pandas_brython">`
   / `id="plotly_express_brython">` — the `id` must equal the module name, since
   that is how Brython's import system resolves `import pandas_brython as pd`.
   Failures null the promise so retry works.
2. **Runner** — a persistent shared module (compiled once via
   `__BRYTHON__.runPythonSource`, code2web pattern): executes each run in a
   persistent globals dict (REPL-style state across runs), captures stdout to
   `StringIO`, evaluates the last expression, and formats output (below). Exposed
   as `window.runBrython(code, ctx)`.
3. **Data binding** — resolves dataset names for the run (see Data).

### Hooks in each `index.html` (~20 lines total, at the pre-marked seams)

- Mode button `Brython` in the language menu.
- `modeRegistry` entry: `id: 'brython'`, Python `hlConfig`, `runSelf` → engine,
  `onActivate` → warm-load.
- `RUNTIME_FOR_MODE` row: `brython: 'brython'`.
- Eager-load branch: if active mode's runtime is `brython`, load Brython at
  startup instead of Pyodide.
- `editorContent` / `STARTUP_EXAMPLES` entries with the starter example.
- `sw.js`: add `cdn.jsdelivr.net` Brython paths to cached hosts / precache list.

Everything else in `index.html` is untouched.

## Output protocol

Reuse the existing text-marker protocol so **`buildOutputNodes()` needs zero
changes**. The runner duck-types results and prints:

- Plotly figure (object with `to_plotly_json()` / the `pe` figure type) →
  `_EMBED_S + "figure__" + "\n" + <plotly JSON> + "\n" + _EMBED_E`.
  JSON is sanitized (tuples→lists, NaN/inf→null) — code2web's `json_safe` logic
  moves into the runner.
- DataFrame → `to_html()` rendered through the existing table pathway.
- Everything else → `repr()` / captured stdout as plain text.

Plotly.js is already loaded globally (`index.html:675`); no renderer work.

## Data

Three paths, resolved by the engine binding in this order (~30 lines):

1. **Embedded data** — a published dashboard may carry
   `<script type="application/json" id="brythondata_<name>">…</script>` blocks.
   Checked first; zero network fetches at view time. (Publishing-side support for
   baking data in is a follow-up to phase 1 wiring; the *reader* side ships now.)
2. **`# load <url|alias> as <name>`** — `js/data-directives.js` and
   `js/data-loader.js` are untouched (runtime-neutral by design). The engine takes
   the returned `{alias, format, bytes}`:
   - CSV → decode to text → `io.StringIO` → `pd.read_csv`.
   - JSON → `JSON.parse` → `pd.DataFrame(dict)`.
3. **Parquet** — same directive; bytes are routed through the **existing**
   DuckDB-WASM static engine (`__ensureDuckDB()` → `SELECT *` → JSON →
   `pd.DataFrame`). DuckDB loads lazily only when a parquet source is actually
   requested, so CSV/JSON/embedded dashboards keep the full speed advantage.

Loaded frames are exposed to user code under their `<name>`, matching the
convention of the other engines.

## Error handling

- Python exceptions surface in the same error output style as Pyodide mode
  (traceback text in the output area).
- Unimplemented pandas verbs (`merge`, `join`, `pivot`, `pivot_table`, `melt`,
  `crosstab`, `get_dummies`, `rolling`, `resample`, `corr`) raise
  `NotImplementedError("merge is not available in Brython mode — switch to Python mode")`
  — always naming the escape hatch.
- Parquet load when DuckDB fails → same message pattern.

## Constraints to document (starter example + docs)

- Brython runs **on the main thread** (no worker, no WASM): heavy loops freeze the
  UI. Intended scale: dashboard-sized data, roughly tens of thousands of rows.
  Not for microdata.
- `pandas_brython` covers single-frame operations (filter, groupby, sort,
  describe, fillna, value_counts, read_csv, concat, …); relational/reshaping verbs
  are Python-mode-only.

## Testing

One `brython` example dashboard exercising: each chart family in
`plotly_express_brython`, a `# load` CSV, and an embedded dataset. It doubles as
documentation and the manual smoke test (verified in browser). No test framework.

## Rollout

1. Implement in **openstat** first; verify in browser.
2. Copy the new files + apply the same `index.html`/`sw.js` hooks to **safestat**.
3. Remember the CDN-cache pitfall from the dashboard deploy flow when publishing.
