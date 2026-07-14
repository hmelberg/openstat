# Notebook Widgets — W1 Implementation Plan (`ui` core, pyodide)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec 2 track 1, phase W1 (docs/superpowers/specs/2026-07-15-notebook-widgets-design.md): the common `ui` widget system for **pyodide** — `n = ui.slider(10, 200)` in a notebook cell renders a native-HTML control in that cell, returns the current value, and control changes rerun the cell (or a named target) through the existing per-cell run machinery.

**Architecture:** New `js/ui.js` (dash.js convention: node-testable pure half + DOM half exposing `window.Ui`) + new `pyodide/ui.py` facade (lazy-loaded like `pyodide/dash.py`). A **pull model**: controls live in a per-cell `.ui-controls` strip *outside* the output slot (survives output clearing); the value store is JS-side; on every (re)run the `ui.*` call re-registers its control and *returns the stored current value* — no push into Python globals, no state in Python. Changes debounce (150 ms) then `Cells.runCell(target)`.

**Tech Stack:** unchanged (vanilla ES5, embedded loaders in index.html, node:test + stub-DOM, Playwright verification).

## Global Constraints

- Widgets require an active notebook + live pyodide path; in plain scripts `ui.*` returns defaults and renders nothing (no error).
- No behavior change for documents that never `import ui`; the module loads lazily.
- No dash.js refactor in W1: `js/ui.js` gets its own small builders modeled on dash's (dedup is a W2+ cleanup, noted in code comment).
- Code style: `var` ES5, Norwegian comments, `t()` for UI strings; python side mirrors `pyodide/dash.py` conventions (json across the boundary, `create_proxy` lifecycle if callbacks are ever passed — W1 passes none: the change→rerun wiring is entirely JS-side).
- CSS on existing tokens; the vendored Pico-derived rules (range thumb/track, switch, focus-visible) carry an MIT attribution comment naming Pico CSS.
- Test baselines: `node --test tests/js/*.test.js` = 161 pass / 4 pre-existing ENOENT fail; pytest 640 + pre-existing test_equivalence collection error.
- Commits end `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

**Research facts (verified 2026-07-15; line refs may drift):**

- Lazy python-module pattern: `__ensurePyDash(py)` (index.html:7946-7963) fetches `pyodide/dash.py` and registers it via `importlib spec_from_loader + exec(compile(...))` into `sys.modules`; triggered from the python-mode preRun hook when the script matches `/^\s*(?:import|from)\s+dash\b/m` (index.html:3138-3142) — BEFORE micropip auto-install so micropip never tries PyPI. Copy this exactly for `ui`.
- JS bridge pattern: `pyodide/dash.py` uses `from js import window`, JSON strings across the boundary (`window.Dash.addControls(id, json.dumps(specs), ...)`), `window.Dash.initialValues(id)` returns JSON back. Pyodide runs on the main thread — synchronous calls.
- **No current-cell context exists JS-side.** Sinks are locals: Run All loop `_sink` (index.html:9283, used at 9287/9306); `mdRunNotebookCell` never touches DOM — `js/cells.js` `renderCellResult(idx, c._out, res)` does. The context bracket points: Run All per-segment (around index.html:9304-9307, cell idx from the aligned plan), `mdRunNotebookCell` single path (around index.html:9125-9126, `payload.cellIdx`; clear in the finally at ~9137-9144), microdata replay loop — set only for the target segment (~9052-9058).
- `dash.js` `buildControl(spec, report, override)` → `{node, name, initial}` and its 150 ms `debounce` (js/dash.js:170-177, 328-473) are internal closures — NOT reachable; model our builders on them (types there: slider/dropdown/checkbox/numberfield/textfield/play).
- `Cells` has no id→index lookup; add `C.cellIndexById(id)` scanning live `NB.cells` (consistent with `sinkForSegment`'s live-state assumption).
- `contentLoaded()` (js/cells.js:~279) is the new-document signal (already invalidates the run session) — the Ui value store must reset there too.
- `beginRun` clears code cells' `.nb-output` slots; `renderCellResult` clears the run cell's slot — hence the strip must be a SIBLING of `.nb-output`, not inside it.

---

### Task 1: `js/ui.js` pure half — spec normalization + keying

**Files:** Create `js/ui.js`; Test `tests/js/ui.test.js`

**Interfaces produced:** module exported as `window.Ui` + `module.exports`. Pure half:
- `Ui.normalizeSpec(raw) → {spec, warnings}`: coerce/validate one control spec `{type, name?, label?, value?, min?, max?, step?, options?, rerun?}`. Types: `slider|dropdown|checkbox|switch|number|text|button`. Rules: slider requires numeric min/max (defaults 0/100, step 1), value clamped into range; dropdown requires non-empty `options` array (values coerced to strings), value defaults to first option; checkbox/switch value coerced boolean; number numeric (default 0); text string (default '');
  button has label only. `rerun`: `'self'` (default) | `'none'` | a string id | array of ids. Unknown type → `{spec:null, warnings:['ukjent kontrolltype: …']}`. Unknown keys warn, never error (mirror cells.js grammar philosophy).
- `Ui.controlKey(cellIdx, spec, ordinal) → string`: `cellIdx + '::' + (spec.name || 'w' + ordinal)` — the identity that makes re-registration update-in-place.

- [ ] **Step 1:** Write failing tests (node:test, require `../../js/ui.js`): slider defaults + clamping (`{type:'slider', value:500, max:200}` → 200); dropdown default-first + string coercion; checkbox truthiness; unknown type → null+warning; unknown key warning; rerun default `'self'`, array passthrough; `controlKey` with and without name.
- [ ] **Step 2:** Run `node --test tests/js/ui.test.js` → fails (module missing).
- [ ] **Step 3:** Implement pure half (IIFE, dash.js file-header style, DOM half gated on `typeof document` added in Task 3 — leave a marked section).
- [ ] **Step 4:** Tests pass; full suite `node --test tests/js/*.test.js` → 161+new / 4.
- [ ] **Step 5:** Commit `feat(ui): ren halvdel — spec-normalisering og kontrollnøkler`.

### Task 2: cell-run context + lazy loader + id-lookup (index.html, js/cells.js)

**Files:** Modify `index.html`, `js/cells.js`; Test `tests/js/cells-dom.test.js` (id lookup)

**Interfaces produced:**
- `window.mdUiRunCtx() → {cellIdx, cellEl} | null` — module-level `let nbUiRunCtx = null` in index.html, set/cleared at the FOUR bracket points from the research facts (Run All per segment with the aligned cell idx + that cell's element via `Cells`, single-cell path, microdata replay target-only, all cleared in the corresponding finally/loop-exit). `cellEl` obtained via a new `Cells.cellElementAt(idx)` (returns the `.nb-cell[data-idx]` node or null).
- `__ensureUi(py)`: clone of `__ensurePyDash` fetching `pyodide/ui.py` (cache-busted), registering module name `"ui"`; triggered in the same preRun hook on `/^\s*(?:import|from)\s+ui\b/m` (add alongside the dash regex, same placement rationale — before micropip).
- `Cells.cellIndexById(id) → idx|-1` (scan live `NB.cells` for `attrs.id`), `Cells.cellElementAt(idx)`.
- `Cells.contentLoaded()` additionally calls `window.Ui && window.Ui.resetDocument()` (guarded — Ui may not be loaded).

- [ ] **Step 1:** stub-DOM tests: `cellIndexById` finds by id / -1 when absent; `contentLoaded` calls a stubbed `window.Ui.resetDocument`.
- [ ] **Step 2:** Implement all pieces. The context brackets must not change any existing behavior when `ui` is unused (pure set/clear of a null-checked variable).
- [ ] **Step 3:** `node --test tests/js/*.test.js` green (+new); quick browser sanity: plain script + notebook Run All unchanged (no console errors).
- [ ] **Step 4:** Commit `feat(ui): kjørekontekst per celle, lazy ui.py-laster, cellIndexById`.

### Task 3: `js/ui.js` DOM half — `window.Ui` + CSS

**Files:** Modify `js/ui.js`, `app.css`, `index.html` (script include next to cells.js); Test `tests/js/ui-dom.test.js` (stub-DOM harness — crib the setup from tests/js/cells-dom.test.js)

**Interfaces produced (DOM half):**
- `Ui.registerControl(specJson) → string|null`: parse+normalize; read `window.mdUiRunCtx()` — null → return null (plain-script fallback). Manage the per-cell strip: `div.ui-controls` inserted as first child of the cell element (sibling BEFORE `.nb-output`), created lazily, NOT touched by output clearing. Per run, controls re-register: maintain a per-cell ordinal counter reset when the ctx's cellIdx changes or a new run starts (hook: reset counters when `mdUiRunCtx` transitions from null); key via `controlKey`. Existing key → update spec in place (label/min/max/options/step) but KEEP the stored value (clamped to new range); new key → build node, use stored value if present else spec value. Stale controls (registered last run, not this run) are removed at the END of the cell's run (hook `Ui.endCellRun(cellIdx)` called from the same brackets that clear the ctx — or simpler: mark-and-sweep using the ordinal counter). Return `JSON.stringify(currentValue)`.
- Value store: `Ui._values` map keyed by `controlKey`; `Ui.resetDocument()` clears store + forgets strips.
- Change wiring: input/change listeners → store update → shared 150 ms debounce → resolve rerun target(s): `'self'` → the declaring cellIdx; id string/array → `Cells.cellIndexById` (unknown id → console.warn + skip); `'none'` → store only. Rerun via `window.Cells.runCell(idx)`; if `window.mdIsScriptRunning()` refuse-drop (next change retriggers). Button: click → immediate (no debounce) rerun of target.
- Builders (own, modeled on dash's): slider (`input type=range` + value readout span), dropdown (`select`), checkbox (`input type=checkbox`), switch (checkbox with `role="switch"` + switch CSS), number, text, button. Labels via `<label>` wrap.
- CSS in app.css: `.ui-controls` strip (compact row, wraps, top border-less card zone), control styling on tokens, `accent-color: var(--accent)` for the input types, and the **vendored Pico-derived rules** for range thumb/track cross-browser, switch appearance, and `:focus-visible` — with attribution comment `/* Tilpasset fra Pico CSS (MIT, picocss.com) — range/switch/fokus-oppskrifter */`. Both themes.

- [ ] **Step 1:** stub-DOM tests first: register creates strip+control and returns spec default; second register same key returns STORED value and does not duplicate nodes; register with changed min clamps stored value; change event updates store and (fake timers) triggers `Cells.runCell(selfIdx)` after debounce; rerun `'none'` does not; unknown id warns and skips; null ctx → returns null; `resetDocument` clears.
- [ ] **Step 2:** Implement DOM half + CSS + include tag.
- [ ] **Step 3:** Suites green; browser smoke deferred to Task 5.
- [ ] **Step 4:** Commit `feat(ui): DOM-halvdel — kontrollstripe per celle, verdilager, debounce→rerun + CSS (Pico-oppskrifter, MIT)`.

### Task 4: `pyodide/ui.py` facade

**Files:** Create `pyodide/ui.py`

**Interfaces produced (python):**
```python
ui.slider(min=0, max=100, *, value=None, step=1, label=None, name=None, rerun='self') -> int|float
ui.dropdown(options, *, value=None, label=None, name=None, rerun='self') -> str
ui.checkbox(label=None, *, value=False, name=None, rerun='self') -> bool
ui.switch(label=None, *, value=False, name=None, rerun='self') -> bool
ui.number(value=0, *, min=None, max=None, step=None, label=None, name=None, rerun='self') -> int|float
ui.text(value='', *, label=None, name=None, rerun='self') -> str
ui.button(label, *, rerun='self', name=None) -> None
```
Each builds the spec dict, `window.Ui.registerControl(json.dumps(spec))`; result string → `json.loads` → coerce to the python return type; `None` result (no notebook/plain script) → return the default (slider: value if given else midpoint of min/max? NO — return `value if value is not None else min`; keep deterministic and document). Mirror `pyodide/dash.py`'s CPython fallback so the module imports under pytest (window shim returning None).

- [ ] **Step 1:** Write the module (docstring in Norwegian explaining the pull model + plain-script fallback).
- [ ] **Step 2:** Quick pytest-side import check: add `tests/test_ui_module.py` — imports `pyodide/ui.py` via importlib with a stubbed `js` module, asserts fallback returns (slider default, dropdown first option) and that spec JSON produced for a slider contains type/min/max (capture via the stub). Run `python3 -m pytest tests/test_ui_module.py -q`.
- [ ] **Step 3:** Commit `feat(ui): pyodide-fasade — ui.slider/dropdown/checkbox/switch/number/text/button`.

### Task 5: browser verification + example + exit gate

**Files:** Create `examples/python/py_widgets_ui.txt`; modify `examples/manifest.json` (generator)

- [ ] **Step 1:** Example notebook: md intro + a cell `import ui` + slider/dropdown driving a small pandas/plotly output, a `rerun="plot"`-button targeting an id-cell. Regenerate manifest.
- [ ] **Step 2:** Browser (Playwright, fresh port, close `#welcomeOk`; pyodide boot takes ~30-60 s): (a) run the widget cell → controls appear in the strip, output below; (b) drag the slider → after debounce the cell reruns and output reflects the new value; strip does NOT rebuild (assert same DOM node identity before/after, focus preserved); (c) `ui.button(..., rerun="plot")` reruns the id-target cell; (d) Run All → controls render once, values survive; (e) edit the cell adding a second widget → rerun → both present, first kept its value; (f) plain script with `import ui` + `ui.slider(...)` → runs, prints nothing widget-ish, returns default (no crash); (g) `#options.display`-policy and non-widget notebooks unaffected; (h) both themes screenshot of the strip.
- [ ] **Step 3:** Full suites (node 161+new/4; pytest baseline+new ui test). Update spec 2's W1 line to done.
- [ ] **Step 4:** Commit `feat(ui): eksempel-notatbok + W1 exit gate`.
