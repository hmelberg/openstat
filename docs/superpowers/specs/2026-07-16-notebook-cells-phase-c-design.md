# Notebook cells Phase C — brython/micropython notebook execution (design)

Companion to spec 1 (`2026-07-13-notebook-cells-design.md`, §6 Phase C entry)
and spec 2 (`2026-07-15-notebook-widgets-design.md`, W2 parity note). Approved
in brainstorm 2026-07-16 (approach A).

## Summary

Lift spec 1 §3.3's restriction for the two main-thread Python engines:
notebooks (`#%%` documents) become runnable in **brython** and
**micropython** modes, with per-cell run, sessions, Restart & kjør alle —
and, as the exit gate, working `ui` widgets and `#@param` forms in both.

The exploration finding that shapes everything: both runners already execute
in **persistent user globals** (`_shared_vars`) and already implement
**trailing-expression display** (REPL semantics) per `_execute_code` call.
So one engine call per cell gives the notebook display policy and session
semantics almost for free. What is missing is a session seam (bind datasets
once, reset) and the notebook wiring.

## Approach (decided)

**A — direct cell loop, bypassing the hybrid segment machinery.** These
documents are single-language (decision below), so `## lang` markers,
`executableSource`, `parseHybridScripts`, `SEG_MARKER` and `alignPlan` are
never involved and MUST NOT be modified. The notebook layer loops over
cells and calls the engine once per code cell. Rejected: B (teach the
hybrid parser the new kinds — surgery in the app's riskiest code for a
mixed-language capability we chose not to have) and C (microdata-style
replay-from-top — wastes the live sessions the runners already have).

## Decisions (user, 2026-07-16)

1. **Single-language documents:** a brython (resp. micropython) notebook
   contains brython (resp. micropython) code cells plus md/html/skip.
   Other code-cell types render a polite notice when run (mirroring
   R-mode's treatment of foreign kinds). DuckDB remains available *inside*
   cells via `import duckdb` (the existing bridge).
2. **Restart = runner-level reset** (R-mode model): clear user globals back
   to boot baseline, keep registered libraries. No wasm reboot.
3. **Both engines in the same phase**, twin-task style (the engines mirror
   each other line for line; every task touches both).
4. **Forklar/skrittvis descoped** for these modes (notice shown);
   documented as a known limitation alongside the existing R gaps.

## Global constraints

- **Paramount invariant (spec 1):** documents without `#%%` behave
  byte-identically to today. The engines' existing `run()` (whole-script
  path used by plain scripts and published dashboards) is untouched.
- The hybrid segment machinery (`SEG_MARKER`, `executableSource`,
  `segmentPlan`, `alignPlan`, `parseHybridScripts` in index.html) is
  **not modified**.
- Engine changes are twins: every runner/engine change lands in both
  `brython_runner.py`/`js/brython-engine.js` and
  `micropython_runner.py`/`js/micropython-engine.js`, with only the
  documented dialect differences (`from browser import window` vs
  `from js import window`; text from `_execute_code` return vs stdout
  buffer).
- ES5 var-style JS, Norwegian comments, user-facing strings through `t()`.
- Per-cell run reuses the existing bracketing contract: `nbUiRunCtx` /
  `window.mdUiRunCtx()` set for the duration of the cell run,
  `Ui.beginCellRun(idx)` / `Ui.endCellRun(idx)` around execution,
  cleared in `finally`.

## Components

### 1. Runner additions (both runners)

- At boot, after the runner defines its helpers and `_shared_vars`
  baseline entries (`show`, …), take a **baseline snapshot**:
  `_baseline_vars = dict(_shared_vars)` (shallow copy, separate from the
  `_snapshot`/`_rollback` pair, which stays reserved for the duck-replay
  loop).
- New `_reset()`: restore `_shared_vars` to the baseline
  (`_shared_vars.clear(); _shared_vars.update(_baseline_vars)`), clear
  `_last_error`, return `''` on success / error string on failure (same
  contract style as `_register_module`). Registered modules stay in
  `sys.modules` — same trade-off R-mode made (and fixed) for sourced defs:
  libraries survive, user variables do not. Shallow-copy caveat (mutated
  shared objects) is the same one `_rollback` already documents.

### 2. Engine session API (both engines)

New `notebookSession` object on `BrythonEngine`/`MicroPythonEngine`;
the existing `run()` is not changed.

- `ensure(loads)` → Promise. Memoized while the session is live:
  `load()` the engine, `buildDatasetSpec(loads)`, cache as `__lastSpec`
  (keeps "Publiser dashboard" working), if the spec is non-empty ensure
  the pandas lib and call `_bind_datasets` **once** — datasets are NOT
  rebound per cell, so user mutations of dataset variables survive across
  cells (unlike the per-call rebinding in `run()`). Creates the session's
  duck bridge (views registered once, query cache shared across cells).
- `runCell(source)` → Promise<{text, error}>. `ensureLibs(scanImports(
  source))` (memoized registry makes repeat calls cheap), `_snapshot()`,
  then the duck-replay loop exactly as in `run()` (≤ `MAX_DUCK_PASSES`,
  `_rollback()` between passes; micropython clears `__stdoutBuf` per pass
  and reads text from the buffer, brython reads the `_execute_code`
  return). No dataset rebinding inside `runCell`.
- `reset()` → Promise. Calls runner `_reset()` and invalidates the
  memoized ensure so the next `ensure(loads)` re-resolves `# load` and
  rebinds datasets (restoring pristine dataset variables). The duck
  bridge is rebuilt on next ensure; re-registering views is safe because
  `__brythonDuck.register` (index.html ~2707) is already idempotent
  (type-aware DROP then CREATE VIEW).
- `isLive()` → boolean (session ensured and not reset/invalidated).

### 3. cells.js

- **Notebook activation:** the mode gate that today engages notebook
  rendering for python/r/duckdb/microdata (spec 1 §3.3) is extended with
  `brython` and `micropython`. §3.3's text updates accordingly.
- **Kinds:** `KIND_FOR_TYPE` gains `brython: 'brython'` and
  `micropython: 'micropython'` so per-cell payloads carry the right kind
  (run buttons, `runCell` dispatch). `SEG_MARKER` deliberately does NOT
  gain entries — `executableSource`/`segmentPlan` keep blanking these
  types, which is correct because the new Run All path never uses them.
- `PARAM_LANG_FOR_TYPE` already maps both modes to `'python'` — no change.

### 4. index.html — Run All

In `modeRegistry.brython.runSelf` / `modeRegistry.micropython.runSelf`:
when `Cells.active()`, branch to a new shared helper
`runEngineNotebookAll(engine, ctx)` instead of the whole-script path:

1. `DataLoader.resolveAndFetchLoads` on the full document text (as today).
2. `notebookSession.ensure(loads)`.
3. Run the preamble (text before the first `#%%`, which may contain code
   beyond `# load` directives) as an invisible "cell 0" into the session
   via `runCell`; its output goes to the document's leading slot the same
   way the hybrid family treats preamble output.
4. Loop code cells in order: set run context, `Ui.beginCellRun(idx)`,
   `runCell(cellSource)`, render `{text, error}` through the existing
   `renderCellResult(idx, …)`, `Ui.endCellRun(idx)`. md/html cells render
   as they already do; foreign code kinds get the notice.
5. A cell error renders as the usual red `pre` in that cell's slot and
   the loop **continues** with the next cell (matching the hybrid
   family's Run All behavior).

### 5. index.html — per-cell run

`window.mdRunNotebookCell` accepts kinds `'brython'` and `'micropython'`:

- Kind must match `activeEditorMode` (else the same polite notice pattern
  R-mode uses for foreign kinds).
- Guarded by `scriptRunInProgress` like the other kinds.
- Cold session: `ensure(loads)` (resolving `# load` from the current
  document text) and preamble run happen first, then the target cell.
- Bracketing per the global constraint (run context + begin/endCellRun in
  try/finally) — this is what makes `ui` widgets and `#@param` work.
- Returns the same result shape the existing per-cell contract uses.

### 6. Session lifecycle

The existing `mdNotebookSession` invalidation hooks (contentLoaded, mode
switch, file load, forklar entry) also invalidate the engine sessions.
"Restart & kjør alle" in brython/micropython mode calls
`notebookSession.reset()` and re-runs the notebook loop — and, like the
R-mode fix (F4), must NOT boot pyodide.

### 7. Widgets, params, dash (exit-gate features, no new code expected)

- `ui` facades (`ui_brython.py`/`ui_mpy.py`) already call
  `window.Ui.registerControl` synchronously; with the bracketing in place
  the pull model works as in pyodide. Their file-header comments claiming
  "no notebook support yet" are updated.
- `#@param` forms already decorate and splice for these cell types; they
  become functional the moment per-cell run works (incl. Kjør-chip).
- dash v2 mounts into the running cell's `.nb-output-body` via the
  existing `mdUiRunCtx()` route in `js/dash.js` (the LIB_REGISTRY `dash`
  entries already load it).
- ipywidgets stays pyodide-only by design (unchanged).

## Error handling

- Engine load failure: status message via `setStatus`, buttons back to
  idle — no crash, no half-rendered notebook.
- Cell error: red `pre` in the cell's own slot, run continues (Run All)
  or returns the error shape (per-cell).
- Duck-replay non-stabilization: the existing Norwegian error message,
  surfaced in the failing cell's slot.
- `_reset()` failure (unexpected): surfaced as an error in the status
  line; session stays invalidated so the next run re-ensures.

## Testing

- **pytest:** `_reset()` unit tests for both runners in the existing
  runner-test files (baseline restore, libraries survive, `_last_error`
  cleared, twice-in-a-row safe).
- **node (stub-DOM):** `KIND_FOR_TYPE` additions and notebook-activation
  gate for the two modes; `SEG_MARKER` still lacks them
  (`executableSource` keeps blanking — regression-pin the invariant).
- **Examples:** one notebook example per engine covering both `ui`
  widgets (slider/dropdown + button with `rerun=`) and a `#@param` cell,
  following the existing example-file conventions (label/options header,
  manifest registration).
- **Exit gate (browser, both engines):** widgets end-to-end (defaults at
  Kjør alle, change → rerun, button `rerun=` targeting a named cell),
  `#@param` (run:"auto" live rewrite + rerun; non-auto → stale tint +
  Kjør-chip), per-cell ▶ + Shift/Enter, Restart & kjør alle (variables
  reset, libs survive), md/html rendering, plain-script regression sweep
  in both modes (no `#%%` → byte-identical behavior), both themes.

## Out of scope (documented)

- Forklar/skrittvis for brython/micropython notebooks (notice; backlog
  alongside the R forklar gaps).
- Mixed-language documents in these modes.
- ipywidgets outside pyodide (by design, spec 2).
- `#options.display = last` interplay beyond what already works for plain
  scripts in these modes.

## Phasing

Single implementation plan (twin-task structure): runner reset → engine
session API → cells.js classification/activation → Run All loop →
per-cell dispatch + lifecycle → examples + exit gate.
