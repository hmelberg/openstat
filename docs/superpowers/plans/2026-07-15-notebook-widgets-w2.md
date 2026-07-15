# Notebook Widgets — W2 Implementation Plan (`ui` everywhere)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec 2 track 1, phase W2: the `ui` widget system in **R-mode notebooks** (declare-then-inject model), **brython/micropython** facades (real pull model, defaults-only until those modes gain notebook support), the **N1 replay-value fix**, and the W1 carry-over polish batch.

**Architecture (research-verified 2026-07-15):** R cannot pull values synchronously (webR = worker + PostMessage channel; no COOP/COEP in this deployment; `eval_js` unused). The R facade mirrors `webr/dash.R`: `ui_slider(...)` **declares** the spec into an R-side registry during the run and returns the value found in a pre-injected `.ui_values` list (falling back to the default); after the cell's `captureR`, JS reads the registry (`evalRString`), renders/updates controls in the cell's strip, and on change **re-runs the cell with values injected via `evalRVoid`** (the `# load`/`.dash_run` idiom). Brython/micropython run on the main thread — their facades call `window.Ui.registerControl` synchronously exactly like `pyodide/ui.py` (precedent: `brython/dash.py` → `window.Dash`), which returns null outside notebooks → defaults.

## Global Constraints

- Per-language parity is a goal, not a straitjacket (user decision, spec 2 track 1): the R inject-model difference and the brython/mpy defaults-only behavior are documented adaptations, not bugs.
- No behavior change for documents that never use `ui`; R dashboard-cell guard in `runNotebookRCell` stays untouched.
- R widgets are supported in **per-cell runs** (and render there); during R Run All, `ui_*` calls return injected/stored values if present else defaults, but controls are NOT rendered (Run All R output is unattributed trailing-slot — phase-A contract). Documented adaptation.
- Style/test/commit conventions as W1 (ES5, Norwegian, tokens-only CSS, trailer). Baselines: node 235/4 pre-existing; pytest 664 + pre-existing collection error.

**Research facts (file:line refs may drift):**

- `webr/dash.R` declare-only pattern (registry env, `.dash_registry_json()` read post-run by js/dash-webr.js:120-126); `.dash_run(di, ci, values_json)` re-invocation with `jsonlite::fromJSON` (webr/dash.R:207-229); serial queue in dash-webr.js:14-30.
- Pre-run injection idiom: `webR.evalRVoid('alias <- jsonlite::fromJSON(...)')` (index.html:7701-7726 `# load`, 7792-7846 `# use`); double-JSON.stringify to pass a JSON string as R literal (dash-webr.js:88-89); jsonlite reliably available (installed by dash-webr ensureDefs and load-paths).
- `runNotebookRCell` (index.html:8930-8979): captureR + captureRToOutputParts + shelter purge; dashboard guard at 8938-8940 stays.
- Brython module delivery: `js/brython-engine.js` LIB_REGISTRY (38-69) + `_register_module` (116-140); the `dash` entry shows the `js:` dependency slot (`{url:'js/dash.js', global:'Dash'}`). Micropython mirror: js/micropython-engine.js:25-31. Facade precedents: `brython/dash.py:3` `from browser import window`; `micropython/dash.py:76` `from js import window`.
- Notebook truth: `SEG_MARKER` (js/cells.js:144-145) has no brython/micropython — such cells are blanked; the facades' notebook path is unreachable today by construction.
- N1: microdata replay sets `nbUiRunCtx` only for the target segment (index.html:~9115); non-target python segments replay with `ui.*` defaults. Fix: bracket ALL replayed pyodide segments with their aligned cell idx (`_aligned[_ri]`), so replays consume stored values. (Strips of non-target cells: `beginCellRun` will fire for them — that is CORRECT; their controls re-register with stored values.)
- W1 carry-overs (final-review, ledger): (a) type-changed control should `insertBefore` at its old position, not append (capture `nextSibling` before removal); (b) trailing `.catch` on `_rerunFor`'s reduce chain; (c) N2 warning wording (`snappet til første` should name the target, not the rejected value); (d) prefer `attrs.id` in the value-store key when the cell has one (`(id||cellIdx)::name` — keeps values stable across structural edits; migration not needed, store resets on document load).

---

### Task 1: `Ui` JS additions — bulk registry registration + value export + carry-over polish

**Files:** Modify `js/ui.js`; Test `tests/js/ui-dom.test.js`, `tests/js/ui.test.js`

**Interfaces produced:**
- `Ui.registerFromRegistry(cellIdx, specsJson) → void`: parse a JSON ARRAY of specs (each passed through `normalizeSpec`; nulls skipped with console.warn), then — bracketed internally by `beginCellRun(cellIdx)`/`endCellRun(cellIdx)` — register each into cell `cellIdx`'s strip using the same code path as `registerControl` but with an EXPLICIT cellIdx instead of `mdUiRunCtx()` (refactor the ctx-dependent part of `registerControl` into an internal `_registerInto(cellIdx, cellEl, spec)` both entry points share). Values: stored value if present else spec default (same semantics).
- `Ui.valuesForCell(cellIdx) → string`: JSON object `{key→value}` for that cell's controls, keys WITHOUT the cell prefix (the control-name part only, e.g. `{"n": 7, "w0": "a"}`) — this is what gets injected into R as `.ui_values`.
- Carry-over polish: (a) `insertBefore` at old position on type change; (b) trailing `.catch` on the rerun reduce; (c) N2 warning wording; (d) value-store key uses `attrs.id` when the cell has one — add `Ui`-side support by letting the KEY function take an optional stable cell key: change `controlKey(cellKey, spec, ordinal)` semantics so callers pass `Cells`-provided stable key (`Cells.cellKeyAt(idx)` NEW in js/cells.js: returns `attrs.id || String(idx)`). Update registerControl/_registerInto/valuesForCell accordingly; tests updated.

- [ ] Tests first (stub-DOM + pure): registerFromRegistry renders N controls with stored-value reuse and sweeps stale; valuesForCell returns name-keyed values; type-change keeps position; reduce-chain catch (fake runCell rejecting synchronously) warns and continues nothing-broken; id-keyed store survives an index shift (simulate: same cell id at new idx keeps value).
- [ ] Implement; suites green (`node --test tests/js/*.test.js` → 235+new / 4).
- [ ] Commit `feat(ui): registerFromRegistry + valuesForCell, id-stabile verdinøkler, W1-polering`.

### Task 2: `webr/ui.R` facade + per-cell R integration

**Files:** Create `webr/ui.R`; Modify `index.html` (`runNotebookRCell` + an `__ensureUiR` lazy loader), `js/ui.js` if small gaps emerge

**Interfaces produced:**
- `webr/ui.R` (mirror dash.R's file conventions): `.ui$registry` env; `ui_slider(min=0, max=100, value=NULL, step=1, label=NULL, name=NULL, rerun='self')`, `ui_dropdown(options, value=NULL, ...)`, `ui_checkbox(label=NULL, value=FALSE, ...)`, `ui_switch(...)`, `ui_number(...)`, `ui_text(...)`, `ui_button(label, rerun='self', ...)`. Each: computes its key (name or `w<ordinal>`, ordinal counter reset by `.ui_begin()`), appends the spec to the registry, and returns `.ui_values[[key]]` if present else the default (same fallback rules as pyodide/ui.py; button returns invisible(NULL)). `.ui_registry_json()` returns and CLEARS the registry (jsonlite::toJSON, auto_unbox).
- `__ensureUiR()` in index.html: lazily `webR.FS.writeFile('/home/web_user/ui.R', …fetched source…)` + `evalRVoid('source(...)')` (or evalRVoid the source directly — mirror how dash.R is delivered; READ js/dash-webr.js `ensureDefs` first and copy its delivery mechanism exactly), gated on `/\bui_(slider|dropdown|checkbox|switch|number|text|button)\s*\(/.test(cellText or document)`.
- `runNotebookRCell` additions (order): (1) if the ui-regex matches the document → `await __ensureUiR()`; (2) inject values: `evalRVoid('.ui_values <- jsonlite::fromJSON(' + double-stringified Ui.valuesForCell(cellIdx-with-stable-key) + ')')` and `evalRVoid('.ui_begin()')`; (3) existing captureR; (4) post-run: `evalRString('.ui_registry_json()')` → if non-empty array, `Ui.registerFromRegistry(cellIdx, specsJson)`; (5) existing parts conversion/purge. All steps guarded so non-ui R cells are byte-identical (regex gate).
- Change→rerun: nothing new — controls registered via registerFromRegistry carry `rerun` specs; the existing debounce→`Cells.runCell` wiring fires the R cell rerun, which re-injects values. Verify the loop converges (rerun of an R cell re-registers the same controls → update-in-place, no flicker).
- R Run All: NO integration (documented adaptation) — but `.ui_values` may not exist there; `ui_*` must handle missing `.ui_values` (default) so Run All doesn't error.

- [ ] Implement; unit-test the R file itself if a pytest-style harness is impossible — at minimum `Rscript`-free static check + the browser gate below carries verification. JS-side additions get stub-DOM tests (registry read path mocked).
- [ ] Browser verification (Playwright, fresh port; webR wait): r-mode notebook, cell `n <- ui_slider(1, 10, value=3)` + `n * 100` → per-cell ▶: control renders post-run, output 300; move slider to 7 → rerun → 700, control NOT rebuilt; `ui_dropdown` + `ui_button(rerun='plot')` targeting an id-cell; Run All → no controls rendered, no errors, values default (documented); plain R script with ui_slider → runs, default, no render.
- [ ] Commit `feat(ui): R-fasade — deklarer-og-injiser-modellen (webr/ui.R) + per-celle-integrasjon`.

### Task 3: brython + micropython facades

**Files:** Create `brython/ui_brython.py`, `micropython/ui_mpy.py`; Modify `js/brython-engine.js`, `js/micropython-engine.js` (LIB_REGISTRY `ui` entries with `js: [{url:'js/ui.js', global:'Ui'}]`)

Port `pyodide/ui.py` with the per-engine import adaptations (`from browser import window` / `from js import window` — study how `brython/dash.py` and `micropython/dash.py` handle JSON and null returns; MicroPython jsffi null semantics may differ — test what registerControl's null becomes). Module name must be `ui` (alias in registry like dash). Same public API, same fallback defaults. Docstring: full widgets krever notatbok-støtte i disse modusene (fremtid); i dag returneres defaults.

- [ ] Implement both + registry entries; smoke-test in browser: brython mode script `import ui; print(ui.slider(1, 10, value=4))` → prints 4, no errors; same for micropython. Verify `js/ui.js` loads as dependency without side effects in those modes.
- [ ] Commit `feat(ui): brython- og micropython-fasader (pull-modell, defaults til modusene får celler)`.

### Task 4: N1 — replay consumes stored widget values

**Files:** Modify `index.html` (microdata replay loop)

Bracket ALL replayed pyodide segments with their aligned cell idx (set `nbUiRunCtx` from `_aligned[_ri]` + `Cells.cellElementAt`, and call `Ui.beginCellRun`/`endCellRun` for each — same pattern as the target segment). Non-target segments' output stays discarded (unchanged); only the ctx/value semantics change. Update the spec's "Known W1 limitation" note to resolved.

- [ ] Implement; browser verification: microdata doc with a python widget cell (slider set to non-default) + a microdata cell; per-cell run the MICRODATA cell → replay; then a python cell reading the widget variable shows the STORED value, and the widget cell's strip survives with correct value.
- [ ] Commit `fix(ui): replay konsumerer lagrede widget-verdier (N1) — alle replay-segmenter bracketes`.

### Task 5: exit gate

- [ ] Example: extend `examples/python/py_widgets_ui.txt`? No — add `examples/r/rex_widgets_ui.txt` (or the r-examples folder's actual name — check manifest keys) with an R widget notebook; regenerate manifest.
- [ ] Suites: node (235+new/4), pytest (664 baseline). Browser regression sweep (abridged): python widgets example unchanged; R widgets example full loop; plain scripts all modes; notebook Run All python + R; brython/mpy dash examples still work (LIB_REGISTRY untouched behavior).
- [ ] Spec 2: mark W2 done in Phasing; resolve the N1 limitation note.
- [ ] Commit `docs+test(ui): W2 exit gate — R-eksempel, regresjonssveip, spec-status`.
