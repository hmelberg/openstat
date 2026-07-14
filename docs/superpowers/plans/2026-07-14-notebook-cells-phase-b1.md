# Notebook Cells — Phase B1 Implementation Plan (per-cell run)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run ONE cell at a time against a live runtime session: per-cell run buttons, Shift+Enter / Ctrl+Cmd+Enter, stale tint, runtime status chips, and "Restart & kjør alle" — spec §6 Phase B, first half (B2 = cell toolbar ops, skrittvis playback, dashboard render-target completion).

**Architecture:** A notebook *session* keeps the interpreter namespace (`e`/`_g`) alive between runs. "Kjør" (Run All) keeps today's semantics exactly (fresh boot — it doubles as the deterministic reset together with the explicit "Restart & kjør alle"). "Run cell" executes one cell's segment against the live session via the existing executors: `_m2py_run_segment`/`_exec_pyodide_block` for python/duckdb, the forklar replay pattern for microdata (run-from-top-through-cell, spec §4), `webRShelter.captureR` for R. Output goes only to that cell's slot (replace semantics). Orchestration lives in `js/cells.js`; session plumbing in `index.html` next to the existing runner.

**Tech Stack:** unchanged (vanilla ES5 JS, embedded Python core in index.html, node:test + stub-DOM harness, Playwright verification).

## Global Constraints

- **No behavior change outside notebooks:** plain scripts and notebook Run All are byte-identical to phase A. Everything new is gated on `Cells.active()` or explicit new UI.
- **Stale state is accepted by design** (spec §7); "Restart & kjør alle" and Run All are the reset. NO dependency tracking.
- **Run-button invariants** (research Q8): any cell run must set `scriptRunInProgress = true` … `finally { false }`, call `setRunButtonsUi('running')`/`'idle'`, keep `window.mdIsScriptRunning()` accurate, and restore `py.setStdout()/setStderr()` in `finally`.
- **Stdout noise filter**: any new stdout capture reapplies the micropip Loading/Loaded filter (duplicated today at index.html ~8533-8539 and ~9113-9118).
- Code style as before: `var` ES5 in js/, Norwegian comments/UI strings via `t()`, commits end `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Test baselines: `node --test tests/js/*.test.js` = 131 pass / 4 pre-existing ENOENT fails; pytest 640 pass + pre-existing test_equivalence collection error.

**Research facts this plan relies on** (verified 2026-07-14; re-verify line refs, the file drifts):

- `pyodide` instance persists (`__pyodidePromise`, index.html:7959); `e` + `_g` are rebuilt EVERY run by `setupCode` (`getInterpreterCorePython()`, 6651; `_g` at 6788; run via `py.runPythonAsync(setupCode)` at 8737).
- Forklar already runs single blocks against live state: `explainInit` (9130-9155) defines fresh `e`/`_g` + `_run_microdata_chunk` (clears `output_log`, runs, stores `_forklar_last_chunk_out`); pyodide blocks run `_exec_pyodide_block(_st, _g, …)` with stdout captured via the gated accumulator `forklarChunkCapture`/`forklarChunkStdout` inside the shared `py.setStdout` callback (9110-9123); R blocks use `webRShelter.captureR(code, {withAutoprint:true})` (9083) against the persistent `.GlobalEnv`.
- Rewind = `forklarReplayChunksBeforeIndex` (9178): re-runs `explainInit` (fresh `e`/`_g`) then replays chunks 0..N-1.
- `# load` bytes are cached tab-wide (`_bufCache`, js/data-loader.js:27); binding into the session happens only via `setupCode`'s preamble (`buildWebDataLoaderPreamble`, 6631) — a session boot covers it; a lone cell run against a live session needs no refetch.
- DC-settings are pushed into module-level `_m2py_mod.M2PY_DEFAULTS` every run (6680-6688) — must be reapplied per cell run.
- `# use` inference scans the WHOLE document's segments (js/data-directives.js:208, 223-232) — per-cell runs must resolve uses with full-document segment context.
- DuckDB `window.__duck.begin()` (2789) DROPS ALL TABLES (2792-2805) — per-cell duck runs need a `fresh:false` variant; full runs keep drop-all.
- `#options.*` extraction is document-wide (extractScriptOptions at 8552/6080) — per-cell runs read options from the FULL document, never from the single cell.
- Dash (python): lazy sweep on `Dash.create` handles disconnected roots (js/dash.js:475-485) — clearing the cell's slot before re-run is sufficient. Dash (R): `DashWebR.reset()` is per-full-run (7754); per-cell R runs must NOT call it (documented limitation: R dashboard cells require Run All).
- `Cells` phase-A API: `parseCells/serializeCells/executableSource/segmentPlan/alignPlan/SEG_MARKER/segmentDisplay`, DOM half `NB` state with `runSinks`, `beginRun(kinds)`, `sinkForSegment`, `errorHost`, stub-DOM tests in tests/js/cells-dom.test.js.

---

### Task 1: session layer in index.html

**Files:**
- Modify: `index.html` (extract/boot session; expose `window.mdNotebookSession`)

**Interfaces:**
- Produces (on `window.mdNotebookSession`, all async):
  - `ensure() → Promise<{py}>` — boot the notebook session if not live: run `loadPyodideAndM2py()`, fetch+bind `# load`s (`DataLoader.resolveAndFetchLoads` + FS writes + preamble), run `setupCode` (fresh `e`/`_g`), mark live. Reuses the EXACT code the btnRun python path runs today — extract those steps into a function both callers share; btnRun's behavior must stay byte-identical (it calls the same function with `force:true` semantics, since Run All always reboots).
  - `restart() → Promise` — force re-boot (same as ensure with force).
  - `isLive() → bool`, `runtime() → 'python'|'r'|'duckdb'|'microdata'`, `onStateChange(cb)` — for the status chips.
  - `reapplySettings()` — re-push `M2PY_DEFAULTS` (DC thresholds, label format) into the live session (extract the existing block at ~6680-6688 into a reusable snippet).
- Session invalidation: mode switch (`switchEditorMode`) and Restart mark the session dead. Run All (btnRun) reboots by definition — after its setupCode, mark session live (so a subsequent cell run reuses it).

- [ ] **Step 1:** Read the btnRun python-path boot sequence (loads at ~8594-8657, setupCode build+run at ~8657-8737) and extract it into `async function bootNotebookSession(force)` used by btnRun verbatim (same order, same variables). Careful: btnRun also does non-boot work (status text, outputArea clearing, segmentation) — ONLY the boot belongs in the function.
- [ ] **Step 2:** Implement `window.mdNotebookSession` as above, with a module-level `let nbSessionLive = false;` set true after each successful boot, false on mode switch and on `restart()` entry.
- [ ] **Step 3:** Verify: `node --test tests/js/*.test.js` unchanged (131/4). Browser: plain python script Run All twice → identical output both times; notebook Run All → per-cell outputs as before (byte-identical phase-A behavior).
- [ ] **Step 4:** Commit: `feat(cells): sesjonslag — bootNotebookSession + mdNotebookSession (ensure/restart/reapplySettings)`

### Task 2: per-cell execution for python/duckdb kinds

**Files:**
- Modify: `index.html` (new `runNotebookCell` entry point), `js/cells.js` (orchestration API)
- Test: `tests/js/cells-dom.test.js` (orchestration-level tests with stubbed runner)

**Interfaces:**
- `js/cells.js` produces: `C.runCell(idx) → Promise` — serialize pending edits first (flush the 250 ms debounce synchronously), compute `parseCells`+`segmentPlan`, resolve the cell's segment text via `executableSource` on the full document (slice out the target cell's segment), then call `window.mdRunNotebookCell(payload)` where payload = `{ kind, text, uses, nb: {echo:false,last:true per phase-A rules}, cellIdx }`. Renders result into that cell's slot only (purgePlots + innerHTML='' on THAT slot; replace semantics), stale tint cleared on success, error `pre.error` into the same slot.
- `index.html` produces: `window.mdRunNotebookCell(payload) → Promise<{text, error}>`:
  1. Maintain run-button invariants (Global Constraints).
  2. `await mdNotebookSession.ensure()`; `reapplySettings()`.
  3. Resolve the cell's `# use` directives with FULL-document segment context (build the document's segment array once via the same normalizer+segmentation btnRun uses, find the target segment by index from `segmentPlan` alignment, take ITS `uses`).
  4. Execute via `_m2py_run_segment` with the payload's segment JSON (including `_nb` display flags), capturing stdout with a gated accumulator like forklar's (`nbCellCapture`/`nbCellStdout` in the shared setStdout callback, WITH the micropip noise filter).
  5. duckdb kind: same path (`_m2py_run_segment`'s duckdb branch) but first add `fresh` option to `window.__duck.begin(opts)` (index.html:2789): `begin({fresh:false})` skips the drop-all block; cell runs pass `fresh:false`, all existing callers unchanged (default `fresh:true`). Note in a comment that duck tables now persist across CELL runs until Run All/Restart.
  6. `refreshDatasetSidebarFromPy(py)` after the run (forklar precedent).
- Options: read `#options.*` from the FULL document before each cell run (display=all escape + show_commands), not from the cell.

- [ ] **Step 1:** stub-DOM tests first: `C.runCell` flushes pending edit, calls `window.mdRunNotebookCell` with correct `{kind, cellIdx}` for an explicit python cell, renders returned text into the right slot, routes `{error}` to the same slot, skips md/skip cells (no-op + brief visual hint), and refuses (queues nothing) when `window.mdIsScriptRunning()` is true.
- [ ] **Step 2:** Implement both halves. Keep `runNotebookCell` structurally parallel to the segment loop (same helpers, same finally-restore).
- [ ] **Step 3:** Browser verification (Playwright, fresh port): notebook with 3 python cells (`a = 2`, `a + 3` → `5`, `print(a)` → `2`); run cell 1 then cell 2 → `5` appears in cell 2's slot only, other slots untouched; edit cell 1 to `a = 10`, run cell 2 alone → `13` (live session, stale-by-design); Run All afterward → fresh session, all three slots repopulated; a duckdb-mode notebook: cell 1 `CREATE TABLE t AS SELECT 42 AS x`, cell 2 `SELECT * FROM t` — run cell 1 then cell 2 individually → works (fresh:false); Run All still works. Plain script regression: unchanged.
- [ ] **Step 4:** Commit: `feat(cells): per-celle-kjøring for python/duckdb mot levende sesjon`

### Task 3: microdata per-cell = replay-through (spec §4)

**Files:**
- Modify: `index.html` (`mdRunNotebookCell` microdata branch), `js/cells.js` (kind dispatch)

**Interfaces:** consumes Task 2's entry point; microdata-kind cells (and any cell in a microdata-mode doc whose target segment kind is `microdata`) take the replay path: fresh `e`/`_g` (rerun setupCode — the session restarts by definition, mirroring `forklarReplayChunksBeforeIndex`), then run segments 0..target in order; only the TARGET segment's output is rendered (earlier segments run silently — their existing slots stay as-is). Reuse `output_log.clear()` per segment (already in `_m2py_run_segment`).

- [ ] **Step 1:** Implement the branch; show a status text while replaying (`t('Kjører fra toppen…')`).
- [ ] **Step 2:** Browser: microdata notebook (require/create-dataset/imports in cell 1; `summarize`/`tabulate` in cell 2): run cell 2 alone → replays silently, cell 2's slot gets only its own output; cell 1's slot untouched.
- [ ] **Step 3:** Commit: `feat(cells): microdata per-celle-kjøring — kjør-fra-toppen-gjennom-cellen (spec §4)`

### Task 4: R-mode per-cell via captureR

**Files:**
- Modify: `index.html`, `js/cells.js`

**Interfaces:** in r-mode documents, r-kind cells run via `webRShelter.captureR(cellCode, {withAutoprint:true})` against the persistent `.GlobalEnv` (forklar's `forklarRunOneRBlock` pattern at ~9052-9097 including shelter purge). Package auto-install: run `extractRPackages` on the CELL text before executing. Rendering: convert captureR result to output like forklar does. Do NOT call `DashWebR.reset()` — and if the cell's code mentions `dashboard(` , show the documented limitation message in the slot (`t('Dashboard-celler krever Kjør alle (fase B2)')`) instead of executing. Non-r kinds inside r-mode docs (microdata segments): out of scope → limitation message.

- [ ] **Step 1:** Implement; reuse forklar's captureR→render conversion helper (extract if inline).
- [ ] **Step 2:** Browser: r-mode notebook, cell 1 `x <- 1:10`, cell 2 `summary(x)`: run 1 then 2 individually → summary in cell 2's slot; `hist(rnorm(100))` cell renders its plot in-slot; Run All unchanged (trailing-slot fallback as in phase A).
- [ ] **Step 3:** Commit: `feat(cells): r-modus per-celle-kjøring via captureR (dashboards krever Kjør alle)`

### Task 5: UI — run buttons, shortcuts, spinner, stale tint, session chips, Restart

**Files:**
- Modify: `js/cells.js` (DOM half), `app.css`

**Interfaces (consumes `C.runCell`, `mdNotebookSession`):**
- **Run button** per code cell in `.nb-head` (▶, `t('Kjør denne cellen')`); spinner state on the running cell (`.nb-running` class, subtle pulse); all cell-run buttons disabled while `mdIsScriptRunning()`.
- **Keyboard** on `.nb-src` textareas: Shift+Enter = run + focus next cell's editor (no auto-create trailing cell in B1); Ctrl/Cmd+Enter = run in place. preventDefault only for these combos.
- **Stale tint:** cell edited since its last successful run gets `.nb-stale` (subtle tint on the input zone); cleared when that cell runs or on Run All. Track per-cell run stamps in NB state keyed by cell index; a full `render()` (structure change) clears stamps (honest: structure changed).
- **Session chips + Restart** in `.nb-bar`: runtime chip (`Python ● aktiv` / `○ kald` via `mdNotebookSession.isLive()`+`onStateChange`), and a `Restart & kjør alle`-button = `mdNotebookSession.restart()` then `btnRun.click()`.
- CSS: `.nb-running`, `.nb-stale`, chip styles — theme vars only.

- [ ] **Step 1:** stub-DOM tests: Shift+Enter triggers runCell(idx) and moves focus; stale set on edit + cleared on run; buttons disabled while running.
- [ ] **Step 2:** Implement UI + CSS.
- [ ] **Step 3:** Browser (both themes, both layouts): run buttons visible and working; shortcuts; stale tint appears on edit and clears on run; chip flips kald→aktiv on first run; Restart & kjør alle reboots and reruns; nothing changes for plain scripts.
- [ ] **Step 4:** Commit: `feat(cells): per-celle kjøreknapper, Shift/Ctrl+Enter, stale-markering, sesjonschip + Restart`

### Task 6: exit gate — suites, example, regression, docs

- [ ] **Step 1:** Update the shipped example (`examples/python/py_notatbok_celler.txt`) with one line of md mentioning per-cell run (▶ / Shift+Enter). Regenerate manifest.
- [ ] **Step 2:** Full suites: node (131+new / 4 pre-existing), pytest (640 baseline). Browser regression sweep (abridged): plain script all views; notebook Run All (phase-A behavior incl. display policy); share-link open; mode switches; mixed doc (`## r` cell in python mode) — per-cell run of the r cell inside a python-mode doc goes through `runInlineRSegment`-equivalent or shows the limitation message (implementer verifies which path Task 2 gave it and documents).
- [ ] **Step 3:** Spec: mark B1 items done in §6 (small edit noting B1/B2 split).
- [ ] **Step 4:** Commit: `docs+test(cells): fase B1 exit gate — eksempel, regresjonssveip, spec-status`
