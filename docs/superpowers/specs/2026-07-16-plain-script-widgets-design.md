# Widgets in plain scripts + `sync_to` (design)

Phase 3 of the unified document model
(`2026-07-16-unified-document-model-notes.md` §3 and §6.3, decision 7 —
approved by Hans 2026-07-16). Extends spec 2's `ui` system (W1-W5).

## Summary

Three capabilities:

1. **`ui.*` controls work in plain scripts** (no `#%%`): they render into
   a document-level control strip at the top of `#outputArea`, with the
   same pull model as notebooks — but **defaulting to `rerun="none"`**
   (a change is picked up on the next manual run; nothing reruns by
   itself).
2. **`rerun="all"`**: a new rerun target — the whole script (the Kjør
   button's path), debounced, for the rare control that should re-run
   everything on change. Valid in notebooks too (there it means Kjør
   alle).
3. **`sync_to="name"`** on value controls (all four facades): pushes the
   control's value into the named **engine session variable**
   immediately on change (and at registration), WITHOUT rerunning —
   `ui.slider(1, 10, sync_to="n")` keeps `n` current so `ui.on`
   handlers and manual runs against a live session see fresh values.

**In notebooks nothing else changes**: default `rerun="self"` as today.

### Disposition of the marker-pattern proposal (Hans, 2026-07-16)

Hans suggested the "plain-text markers transformed before HTML" pattern
(as used for plot-JSON embeds and `notebook_prose` markdown) as a
possible channel for plain-script widgets, especially webR. Decision:
**for webR we reuse exactly that pattern's existing incarnation** — the
`.ui$registry` JSON channel (`webr/ui.R`, declare-during-run, host reads
`.ui_registry_json()` after the run and builds DOM) — extended to
plain-script runs. No NEW inline output markers are introduced: the
document-level strip makes positional markers unnecessary, and the
registry channel already crosses the worker boundary as plain JSON text.
The three main-thread engines keep their synchronous
`window.Ui.registerControl` call (no marker indirection needed on the
main thread).

## Global constraints

- **The pull model is unchanged**: `ui.*` returns the stored value;
  values live in `js/ui.js`'s document-scoped `_values` store.
- **Notebook behavior unchanged**: every existing notebook path
  (brackets, strips, rerun="self"/id-targets, mark-and-sweep) behaves
  exactly as today; the full existing ui test suites stay green.
- **`sync_to` never triggers a rerun** and never creates a session; with
  no live session it is a silent no-op (the value store still updates —
  the next run's pull gets it).
- The hybrid segment machinery is untouched. `htmlTrusted` untouched.
- ES5 var-style JS, Norwegian comments, user-facing strings through
  `t()`. Facade twins: pyodide/brython/micropython python files mirror
  each other with only documented dialect differences; webR follows in
  R idiom.
- pytest facade suites extended; node stub-DOM suites extended.

## 1. The document context in `js/ui.js`

Plain-script runs get a **doc-level control context**, mirroring the
`'doc'` sentinel the event-binding path already uses (`_resolveCellIdx`
→ null, `_slotFor` → `#outputArea`):

- `Ui.registerControl` (js/ui.js:755): when `mdUiRunCtx()` yields no
  cell context, fall back to the doc context **iff a doc run is active**
  (index.html sets the same `nbUiRunCtx` global to
  `{ cellIdx: null, cellEl: null, doc: true }` around plain-script
  execution). Outside any run bracket the guard still returns null
  (unchanged no-op semantics).
- **cellKey**: `cellIdx === null` → `'doc'` (value keys become
  `doc::name`, persisting across runs like notebook keys).
- **Strip host**: `_ensureStrip` with no `cellEl` uses
  `#outputArea` — the strip (`.ui-controls[data-pos]`) is inserted as
  `#outputArea`'s **first child** for `placement="top"` (default) and
  appended last for `"bottom"`; `"left"` falls back to top (no grid in
  `#outputArea`; documented). The strip must survive/rebuild across the
  output-area clearing at run start — the run bracket (below)
  re-registers controls, exactly the notebook model.
- **Run bracket**: the plain-script runner calls
  `Ui.beginCellRun(null)` / `Ui.endCellRun(null)` around the run —
  the existing mark-and-sweep then removes doc controls that a changed
  script no longer registers. (`_cellRuns` keying tolerates the null
  sentinel via the same `'doc'` key.)
- **rerun default by context**: `normalizeSpec` keeps `'self'`; target
  RESOLUTION handles context — in the doc context, `'self'` and
  cell-id targets are meaningless and resolve to **no targets** with
  one `console.warn` (`'self'` silently → none, id-targets warn);
  `'none'` stays none. So the effective plain-script default is
  `rerun="none"` per decision 7 without forking the facades.

## 2. `rerun="all"`

- `normalizeSpec` accepts the string `'all'` (VALID value alongside
  none/self/id/array).
- `_resolveTargets` returns the sentinel `'all'`; `_rerunFor` handles
  it by triggering the whole-script run: a new index.html hook
  `window.mdRunWholeScript()` that clicks `#btnRun` iff
  `!mdIsScriptRunning()` (the existing `btnRun.click()` precedent).
  Debounced by the existing per-control 150ms `_debounce` (unchanged
  wiring); the `mdIsScriptRunning` refuse-drop guard at the top of
  `_rerunFor` already prevents overlap.
- Works in both contexts: in a notebook, `#btnRun` IS Kjør alle; in a
  plain script it is the normal run. Button controls with
  `rerun="all"` become "run the document" buttons.

## 3. `sync_to`

- **Spec key**: `sync_to` joins `VALID_KEYS`; value must match
  `/^[A-Za-z_.][\w.]*$/` (letters/digits/underscore/dot — dot for R
  idiom; anything else → `console.warn`, key dropped). Only meaningful
  on **value** controls (slider/dropdown/checkbox/switch/number/text);
  on buttons it warns and is dropped.
- **When it fires**: (a) at registration (each run re-pushes the
  current stored value, so after any run the session variable matches
  the strip) and (b) on every change event, immediately, before/
  independent of any rerun (a control can have both `sync_to` and a
  `rerun` target; sync fires first).
- **Dispatch**: `js/ui.js` stays engine-agnostic — it calls the new
  hook `window.mdUiSyncTo(name, value)` (double-guarded). index.html
  implements it, routing on `activeEditorMode`:
  - **python (pyodide)**: if the interpreter and the exec-globals dict
    `_g` exist (a boot has happened): transfer via
    `pyodide.globals.set('__ui_sync_v', value)` then
    `pyodide.runPython('_g["<name>"] = __ui_sync_v')` — user variables
    live in `_g`, NOT in pyodide's top-level globals. No boot → no-op.
  - **brython / micropython**: new runner twin helper
    `_sync_var(name, value_json)` writing
    `_shared_vars[name] = json.loads(value_json)` (same pattern as
    `_bind_datasets`); exposed on the engine objects; no-op when the
    engine is not loaded.
  - **r (webR)**: `webR.evalRVoid('<name> <- <literal>')` against
    `.GlobalEnv` (value serialized as an R literal: number, string
    with proper escaping, TRUE/FALSE). Async fire-and-forget with
    `.catch(console.warn)`. No webR yet → no-op.
  - other modes (duckdb/microdata/statx/jamovi): no-op.
- **Name injection safety**: the identifier regex above is the guard —
  the name is interpolated into code strings in all three dispatches,
  so ui.js MUST enforce the regex before ever calling the hook.
- **Facades**: all four gain the `sync_to=None` keyword on value
  controls, passed through into the spec (string). Docstrings updated.
  Twins byte-mirror except documented dialect differences; `webr/ui.R`
  adds `sync_to = NULL` params serialized into the registry JSON.

## 4. webR plain scripts (declare-and-inject, extended)

The notebook R path's per-segment inject/read pair
(index.html:8110-8116 / 8171-8183) gets a plain-script sibling in
`runHybridR`'s non-notebook path:

- **Before the run**: `__ensureUiR()`, then inject
  `.ui_values <- jsonlite::fromJSON(<Ui.valuesForCell(null) JSON>)`
  (doc-scoped values, `doc::` prefix stripped by the existing
  `valuesForCell`).
- **After the run**: read `.ui_registry_json()` and call
  `Ui.registerFromRegistry(null, json)` — `registerFromRegistry`
  accepts the null cellIdx and routes to the doc context (same
  bracket/mark-and-sweep as §1; it already brackets with
  begin/endCellRun).
- `sync_to` declared in R specs flows through the registry JSON into
  the shared `_registerInto`, so the JS-side change/registration pushes
  work identically (dispatch hits the webR branch).

## 5. Engine run-path bracketing (index.html)

The doc context + bracket wraps these plain-script paths:

- **pyodide family segment loop** (the `_nbActive` false branch,
  index.html ~10053-10107): set `nbUiRunCtx = {cellIdx:null, cellEl:
  null, doc:true}` + `Ui.beginCellRun(null)` before the segment loop,
  `Ui.endCellRun(null)` + ctx clear in the existing `finally`.
- **brython/micropython plain `run()`** (modeRegistry runSelf,
  non-notebook branch): same bracket around `engine.run(...)`. (Fase
  C's "run() untouched" constraint applied to that phase; this phase
  deliberately extends the plain path — the engines' own files are
  still untouched, the bracket lives in index.html.)
- **webR plain path**: §4 (inject/read; begin/end via
  registerFromRegistry).
- Bracketing must not disturb notebook paths: the notebook branches
  already set their own ctx; the doc bracket is strictly the else
  branch.

## Error handling

- `sync_to` with invalid name: one console.warn at normalize time, key
  dropped, control still works.
- `mdUiSyncTo` dispatch with no live target: silent no-op (value store
  is still authoritative for the next pull).
- webR evalRVoid failures: console.warn, never a user-facing error.
- `rerun="all"` while a run is in progress: dropped by the existing
  refuse-drop guard (no queueing).
- Doc-context registerControl outside any run bracket: null (unchanged).

## Testing

- **node (`tests/js/ui*.test.js` idiom, stub DOM)**: doc-context
  registration (strip in `#outputArea`, `doc::` keys, top/bottom
  placement, left→top fallback); rerun resolution in doc context
  (self→none silent, id→warn+none, none, all→mdRunWholeScript called
  once after debounce); sync_to validation (regex, buttons rejected);
  sync push at registration and on change (stub `mdUiSyncTo` captures
  calls, ordering before rerun); mark-and-sweep of doc controls across
  two bracketed runs; notebook paths regression (existing suites).
- **pytest (facade suites)**: `sync_to` kwarg accepted on all value
  controls and serialized into the spec JSON for all three python
  facades (FakeUiJs pattern); button rejects it; twins stay in sync.
  R: manual Rscript parse+smoke per the W5 precedent.
- **Exit gate (browser, per engine)**: python/brython/micropython/R
  plain scripts with a slider+dropdown — controls render in the
  top strip, change does NOT rerun, next manual Kjør picks values up;
  `rerun="all"` slider reruns whole script debounced; `sync_to`
  verified live (`ui.on` handler reads the synced variable without a
  rerun; for R, evalRString probe); notebook regression sweep (widgets
  in notebooks unchanged incl. rerun="self" and id-targets); dash and
  `#@param` unaffected; both themes.

## Out of scope (documented)

- Positional/inline widget markers in output text (rejected above —
  registry channel + doc strip cover the need).
- `sync_to` on `#@param` forms (params rewrite source text by design).
- Multi-strip/positional placement in `#outputArea` beyond top/bottom.
- duckdb/microdata/statx facades (no `ui` there today).
- Buffering sync values for sessions that do not exist yet.

## Phasing

Single plan, expected 5 tasks: (1) js/ui.js — doc context, rerun
resolution, `'all'`, `sync_to` validation + hook calls, node tests;
(2) index.html — doc bracketing (pyodide family + brython/mpy plain) +
`mdRunWholeScript` + `mdUiSyncTo` dispatcher + runner `_sync_var`
twins, node/pytest tests; (3) webR plain path (inject/read) + ui.R
`sync_to`; (4) python facades `sync_to` + pytest; (5) examples + exit
gate.
