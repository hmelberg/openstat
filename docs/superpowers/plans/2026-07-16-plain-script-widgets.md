# Plain-Script Widgets + sync_to Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ui.*` controls in plain scripts (doc-level strip in `#outputArea`, default rerun="none"), a new `rerun="all"` target, and `sync_to="name"` pushing values into engine session variables — per `docs/superpowers/specs/2026-07-16-plain-script-widgets-design.md`.

**Architecture:** js/ui.js gets a **doc context** (cellIdx `null` → cellKey `'doc'`, strip host `#outputArea`), context-aware rerun resolution (`'self'`→none in doc context, new `'all'` sentinel → `window.mdRunWholeScript()`), and `sync_to` validation + push via `window.mdUiSyncTo(name, value)`. index.html brackets the plain-script run paths with the doc context and implements the two hooks (routing sync by `activeEditorMode`: pyodide `_g`, brython/mpy `_shared_vars` via new runner twins, webR `evalRVoid`). The webR plain path reuses the declare-and-inject registry channel with `cellIdx = null`. All four facades gain the `sync_to=` keyword.

**Tech Stack:** ES5 var-style JS (js/ui.js, index.html, js/brython-engine.js, js/micropython-engine.js), Python facades (pyodide/brython/micropython twins), R (webr/ui.R), node built-in test runner, pytest.

## Global Constraints

- **The pull model is unchanged**: `ui.*` returns the stored value; values live in the document-scoped `_values` store.
- **Notebook behavior unchanged**: all existing notebook paths behave exactly as today; existing ui suites stay green.
- **`sync_to` never triggers a rerun and never creates a session**; no live session → silent no-op.
- The hybrid segment machinery is untouched. htmlTrusted untouched.
- ES5 var-style JS, Norwegian comments, user-facing strings through `t()`. Python facade twins mirror each other byte-for-byte except documented dialect differences.
- **Name injection safety**: `sync_to` names are interpolated into code strings — js/ui.js MUST enforce `/^[A-Za-z_.][\w.]*$/` before the hook is ever called.
- Test baselines: `node --test tests/js/ui.test.js` → 48 pass; `tests/js/ui-dom.test.js` → 63 pass; full node suite → 4 known ENOENT failures only; `python3 -m pytest tests/test_ui_module.py -q` → 44 pass; full pytest (`python3 -m pytest tests/ brython/tests micropython/tests -q --continue-on-collection-errors`) → 1228 pass + 1 known error.
- Run all commands from the repo root.

---

### Task 1: js/ui.js — doc context, rerun resolution, `'all'`, `sync_to`

**Files:**
- Modify: `js/ui.js` — `VALID_KEYS` (~line 25), `normalizeSpec` (~50-201), `_resolveTargets` (~298), `_rerunFor` (~320), `_wireChange` (~352), `_cellDefaultPlacement` (~520), `_ensureStrip` (~574), `_cellKeyAt` (~629), `_registerInto` (~643), `Ui.registerControl` (~755), `Ui.registerFromRegistry` (~794)
- Test: `tests/js/ui-dom.test.js` and `tests/js/ui.test.js` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces (Tasks 2-5 rely on these): doc context accepted when `mdUiRunCtx()` returns `{ cellIdx: null, cellEl: null, doc: true }`; cellKey `'doc'` for `cellIdx == null` (so `Ui.valuesForCell(null)` exports doc values); `Ui.registerFromRegistry(null, json)` registers into the doc strip; `spec.sync_to` (validated string) triggers `window.mdUiSyncTo(name, value)` at registration and on change; `rerun: 'all'` triggers `window.mdRunWholeScript()` (debounced 150ms, refuse-drop while running).

- [ ] **Step 1: Write the failing tests**

Append to `tests/js/ui.test.js` (pure-half idiom — the file tests `Ui.normalizeSpec` etc. via `require`):

```js
test('normalizeSpec: sync_to — gyldig navn lagres, ugyldig varsles og droppes, button avvises', () => {
  const ok = Ui.normalizeSpec({ type: 'slider', sync_to: 'n' });
  assert.strictEqual(ok.spec.sync_to, 'n');
  assert.deepStrictEqual(ok.warnings, []);
  const dotted = Ui.normalizeSpec({ type: 'number', sync_to: 'my.var_2' });
  assert.strictEqual(dotted.spec.sync_to, 'my.var_2');
  const bad = Ui.normalizeSpec({ type: 'slider', sync_to: 'x; rm()' });
  assert.strictEqual(bad.spec.sync_to, undefined);
  assert.ok(bad.warnings.some((w) => /ugyldig sync_to-navn/.test(w)));
  const btn = Ui.normalizeSpec({ type: 'button', sync_to: 'n' });
  assert.strictEqual(btn.spec.sync_to, undefined);
  assert.ok(btn.warnings.some((w) => /sync_to støttes ikke på button/.test(w)));
});

test('normalizeSpec: rerun="all" aksepteres uendret', () => {
  const r = Ui.normalizeSpec({ type: 'slider', rerun: 'all' });
  assert.strictEqual(r.spec.rerun, 'all');
  assert.deepStrictEqual(r.warnings, []);
});
```

Append to `tests/js/ui-dom.test.js` (stub-DOM idiom — the file already builds a fake document/notebook; follow its existing helper setup. Key requirement: the fake `document.getElementById` must return an `#outputArea` FakeEl for these tests — extend the local env helper the same way the file already stubs other elements):

```js
test('doc-kontekst: registerControl uten celle men med doc-ctx → stripe i #outputArea, nøkkel doc::', () => {
  // env med #outputArea-stub; global.mdUiRunCtx = () => ({ cellIdx: null, cellEl: null, doc: true });
  const v = Ui.registerControl(JSON.stringify({ type: 'slider', name: 'n', value: 5, min: 0, max: 10 }));
  assert.strictEqual(JSON.parse(v), 5);
  const strip = outputAreaEl.children.find((c) => c.classList.contains('ui-controls'));
  assert.ok(strip, 'stripe opprettet i #outputArea');
  assert.strictEqual(strip.getAttribute('data-pos'), 'top');
  assert.strictEqual(JSON.parse(Ui.valuesForCell(null)).n, 5);
});

test('doc-kontekst: uten aktiv doc-kjøring er registerControl fortsatt null (uendret no-op)', () => {
  // global.mdUiRunCtx = () => null;
  assert.strictEqual(Ui.registerControl(JSON.stringify({ type: 'slider', name: 'n' })), null);
});

test('doc-kontekst: rerun-oppløsning — self→ingen (stille), id→warn+ingen, all→mdRunWholeScript etter debounce', async () => {
  // doc-ctx som over; stub global.mdRunWholeScript med teller; stub Cells = undefined
  // 1) self (default): endre slider-verdi → ingen mdRunWholeScript, ingen runCell
  // 2) rerun:'plot' (id): console.warn fanget, ingen kall
  // 3) rerun:'all': endre verdi → etter 150ms+ er mdRunWholeScript kalt nøyaktig én gang
  //    (to raske endringer → fortsatt én, debounce)
});

test('sync_to: push ved registrering og ved endring, FØR evt. rerun', () => {
  // stub global.mdUiSyncTo med logg; registrer slider {name:'n', value: 3, sync_to:'n'} i doc-ctx
  // → logg [['n', 3]] allerede ved registrering
  // endre input til 7 → logg [['n',3],['n',7]] umiddelbart (før debounce-rerun)
});

test('doc-kontekst: mark-og-sopp på tvers av to brakettede kjøringer', () => {
  // Ui.beginCellRun(null); registrer 'a' og 'b'; Ui.endCellRun(null) → begge finnes
  // Ui.beginCellRun(null); registrer kun 'a'; Ui.endCellRun(null) → 'b' er fjernet fra stripa
});

test('registerFromRegistry(null, json) → doc-stripa (webR plain-sti)', () => {
  Ui.registerFromRegistry(null, JSON.stringify([{ type: 'slider', name: 'r1', value: 2, min: 0, max: 5 }]));
  assert.strictEqual(JSON.parse(Ui.valuesForCell(null)).r1, 2);
  // og stripa lever i #outputArea, ikke i en celle
});
```

Write the four sketched tests as REAL tests using the file's existing env/builder helpers (read the file first; the comments state the required assertions — mirror the closest existing registerControl/rerun tests for setup).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/js/ui.test.js tests/js/ui-dom.test.js`
Expected: the new tests FAIL (sync_to dropped as unknown key, doc ctx returns null, 'all' unhandled); pre-existing 48+63 pass.

- [ ] **Step 3: Implement**

All changes in `js/ui.js`:

(a) `VALID_KEYS` gains `sync_to: 1`.

(b) `normalizeSpec` — after the placement block (~line 100), add:

```js
    // sync_to (fase 3, spec §3): push av verdien inn i en navngitt sesjons-
    // variabel. Navnet interpoleres i kodestrenger hos mottakerne
    // (mdUiSyncTo) — regexen her ER injeksjonsvernet, aldri fjern den.
    if (raw.sync_to !== undefined) {
      var syncName = String(raw.sync_to);
      if (type === 'button') {
        warnings.push('sync_to støttes ikke på button');
      } else if (!/^[A-Za-z_.][\w.]*$/.test(syncName)) {
        warnings.push('ugyldig sync_to-navn: ' + syncName);
      } else {
        spec.sync_to = syncName;
      }
    }
```

(c) `_resolveTargets` — new doc-context and `'all'` semantics (replace the function body's first lines):

```js
    function _resolveTargets(spec, selfCellIdx) {
      var rerun = spec.rerun;
      if (rerun === 'none') return [];
      if (rerun === 'all') return 'all';   // sentinel — hele skriptet (fase 3)
      if (rerun === 'self' || rerun == null) {
        // doc-kontekst (rent skript): default er rerun="none" per decision 7
        // — 'self' har ingen celle å peke på og løses STILLE til ingen mål.
        if (selfCellIdx == null) return [];
        return [selfCellIdx];
      }
      // id-mål i doc-kontekst: meningsløst — ett varsel, ingen mål.
      if (selfCellIdx == null) {
        console.warn('Ui: rerun-mål ignoreres i rent skript: ' + rerun);
        return [];
      }
      var ids = Array.isArray(rerun) ? rerun : [rerun];
      // (resten uendret)
```

(d) `_rerunFor` — handle the sentinel right after `_resolveTargets`:

```js
      var targets = _resolveTargets(ctrl.spec, ctrl.cellIdx);
      if (targets === 'all') {
        // Hele skriptet: index.html-kroken klikker #btnRun (Kjør alle i
        // notatbøker, vanlig kjøring ellers). Refuse-drop-vakta over
        // dekker allerede pågående kjøringer.
        if (typeof global.mdRunWholeScript === 'function') global.mdRunWholeScript();
        return;
      }
```

(e) `sync_to` push helper (place right after `_wireChange`):

```js
    // sync_to-push (fase 3, spec §3): inn i motorens sesjonsvariabel via
    // index.html-kroken. Fyrer ved registrering OG ved hver endring, alltid
    // FØR en evt. rerun. Ingen krok / ingen sesjon → stille no-op
    // (verdilageret er uansett autoritativt for neste pull).
    function _syncPush(spec, value) {
      if (!spec.sync_to) return;
      if (typeof global.mdUiSyncTo !== 'function') return;
      try { global.mdUiSyncTo(spec.sync_to, value); }
      catch (e) { console.warn('Ui sync_to: ' + ((e && e.message) || e)); }
    }
```

(f) `_wireChange` — push before the debounced rerun:

```js
    function _wireChange(key, getValue) {
      var fireDebounced = _debounce(function () { _rerunFor(key); }, 150);
      return function () {
        _values[key] = getValue();
        var ctrl = _controls[key];
        if (ctrl) _syncPush(ctrl.spec, _values[key]);
        fireDebounced();
      };
    }
```

(g) `_registerInto` — registration push, immediately before the final `return value;` (i.e. after `_values[key] = value;`):

```js
      _syncPush(spec, value);
```

(h) `_cellKeyAt` — doc sentinel first:

```js
    function _cellKeyAt(cellIdx) {
      if (cellIdx == null) return 'doc';   // rent skript (fase 3) — samme sentinel som bindingsstien
      return (global.Cells && typeof global.Cells.cellKeyAt === 'function')
        ? global.Cells.cellKeyAt(cellIdx) : String(cellIdx);
    }
```

(i) `_cellDefaultPlacement` — add as first line: `if (!cellEl) return 'top';`

(j) `_ensureStrip` — doc host branch. Replace the first two lines of the function with:

```js
    function _ensureStrip(cellEl, cellIdx, pos) {
      // Doc-kontekst (fase 3): verten er #outputArea, ikke en celles
      // .nb-output. 'left' faller til 'top' (ingen grid der — spec §1).
      var docHost = null;
      if (!cellEl) {
        docHost = document.getElementById ? document.getElementById('outputArea') : null;
        if (!docHost) return document.createElement('div');   // løsrevet, stille-forkastet
        if (pos === 'left') pos = 'top';
      }
      var outEl = docHost || _findChild(cellEl, 'nb-output');
      var container = (!docHost && pos === 'left') ? _ensureLeftWrapper(outEl) : outEl;
```

and in the insertion block at the end, add the doc branch first:

```js
      if (container) {
        if (docHost) {
          if (pos === 'bottom') container.appendChild(strip);
          else container.insertBefore(strip, container.firstChild || null);
        } else if (container === outEl) {
          var body = _findChild(outEl, 'nb-output-body');
          if (body) outEl.insertBefore(strip, body);
          else outEl.appendChild(strip);
        } else {
          container.appendChild(strip);
        }
      }
```

(NOTE: `pos` may have been rewritten to 'top' — `byPos[pos]`/`strip.setAttribute('data-pos', pos)` lines already use the local `pos`, so they pick the rewrite up automatically. `_strips[cellIdx]` with null cellIdx keys as `'null'` — fine, it is an internal map.)

(k) `Ui.registerControl` — accept the doc context:

```js
      var ctx = (typeof global.mdUiRunCtx === 'function') ? global.mdUiRunCtx() : null;
      if (!ctx) return null;
      // Fase 3: doc-kontekst (rent skript) — cellEl er null MED VILJE.
      // Uten doc-flagget gjelder den gamle vakta uendret.
      if (!ctx.cellEl && ctx.doc !== true) return null;
      ...
      var value = _registerInto(ctx.doc === true ? null : ctx.cellIdx,
                                ctx.doc === true ? null : ctx.cellEl, spec);
```

(l) `Ui.registerFromRegistry` — null cellIdx routes to doc:

```js
      var cellEl = null;
      if (cellIdx != null) {
        cellEl = (global.Cells && typeof global.Cells.cellElementAt === 'function')
          ? global.Cells.cellElementAt(cellIdx) : null;
        if (!cellEl) {
          console.warn('Ui.registerFromRegistry: fant ingen celle-node for cellIdx ' + cellIdx);
          return;
        }
      }
```

(the begin/end bracket and `_registerInto(cellIdx, cellEl, ...)` lines are unchanged — with `cellIdx = null` they hit the doc path; `_cellRuns[null]`/`ctrl.cellIdx === null` keying works, which the mark-and-sweep test pins).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/js/ui.test.js tests/js/ui-dom.test.js`
Expected: PASS — 48+2 and 63+6 (or your exact new-test count), 0 fail.

- [ ] **Step 5: Full node suite regression**

Run: `node --test tests/js/*.test.js`
Expected: only the 4 known ENOENT failures.

- [ ] **Step 6: Commit**

```bash
git add js/ui.js tests/js/ui.test.js tests/js/ui-dom.test.js
git commit -m "feat(ui): doc-kontekst for rene skript, rerun=all, sync_to — validering, striper i #outputArea, push-krok"
```

---

### Task 2: index.html brackets + hooks; runner `_sync_var` twins

**Files:**
- Modify: `index.html` — new `window.mdRunWholeScript` + `window.mdUiSyncTo` (define next to `window.mdIsScriptRunning`, search `mdIsScriptRunning = `); plain-script doc bracket in the btnRun segment loop (search `_nbActive` in the run path ~10050-10110) and in the brython/micropython plain `runSelf` (search `modeRegistry` entries for brython — the non-notebook branch that calls the engine's whole-script `run`); cells.js `?v=` bump (`2026-07-16d` → `e`)
- Modify: `brython/brython_runner.py`, `micropython/micropython_runner.py` — new `_sync_var`
- Modify: `js/brython-engine.js`, `js/micropython-engine.js` — expose `syncVar(name, valueJson)`
- Modify: `sw.js` — CACHE `m2py-v20` → `m2py-v21`
- Test: `brython/tests/test_brython_runner.py`, `micropython/tests/` runner test file (append `_sync_var` tests); browser smoke deferred to Task 5

**Interfaces:**
- Consumes: Task 1's doc context (`{cellIdx:null, cellEl:null, doc:true}`), `Ui.beginCellRun(null)`/`endCellRun(null)`, hook names `mdRunWholeScript`/`mdUiSyncTo`.
- Produces: `window.mdRunWholeScript()` (clicks `#btnRun` iff not running); `window.mdUiSyncTo(name, value)` routing by `activeEditorMode`; runner `_sync_var(name, value_json)` → `''` or error string; engine `syncVar(name, valueJson)` → same contract, no-op when engine not loaded.

- [ ] **Step 1: Write the failing runner tests**

Append to `brython/tests/test_brython_runner.py` (mirror in the micropython runner test file — twin convention):

```python
def test_sync_var_writes_shared_vars():
    import brython_runner as r
    err = r._sync_var("n", "7")
    assert err == ""
    assert r._shared_vars["n"] == 7
    err = r._sync_var("s", '"hei"')
    assert err == ""
    assert r._shared_vars["s"] == "hei"

def test_sync_var_bad_json_returns_error():
    import brython_runner as r
    err = r._sync_var("x", "{not json")
    assert err != ""
    assert "x" not in _fresh_or_absent(r)  # tilpass: verifiser at _shared_vars ikke fikk 'x'
```

Adapt the second assertion to the file's existing fixture style (the point: bad JSON → non-empty error string, `_shared_vars` unchanged). Run to see FAIL (`_sync_var` missing).

- [ ] **Step 2: Implement the runner twins**

In `brython/brython_runner.py` (and byte-mirrored in `micropython/micropython_runner.py`, same dialect notes as `_bind_datasets`):

```python
def _sync_var(name, value_json):
    """ui sync_to (fase 3): skriv en widget-verdi inn i _shared_vars uten
    kjoring. Speiler _bind_datasets-kontrakten: '' ved suksess, ellers
    feilstreng."""
    try:
        _shared_vars[name] = json.loads(value_json)
        return ""
    except Exception as e:
        return "%s: %s" % (type(e).__name__, e)
```

(verify `json` is already imported in each runner; add the import next to the existing ones if not). Run the runner tests → PASS.

- [ ] **Step 3: Expose `syncVar` on both engines**

In `js/brython-engine.js` and `js/micropython-engine.js`, next to where `_bind_datasets`/`_execute_code` handles are already resolved, add a `syncVar` method on the exported engine object following each engine's existing handle pattern (brython: module function reference; micropython: `mp.globals.get('_sync_var')`). Contract:

```js
    // ui sync_to (fase 3): skriv inn i _shared_vars uten kjøring. No-op
    // ('' returneres) når motoren ikke er lastet — sync er best-effort.
    syncVar: function (name, valueJson) {
      if (<engine-not-loaded-check per this engine>) return '';
      try { return <call _sync_var(name, valueJson)> || ''; }
      catch (e) { return (e && e.message) || String(e); }
    },
```

Replace the `<...>` parts with the engine's actual loaded-flag and call idiom (read the neighboring methods — e.g. how `notebookSession.runCell` reaches `_execute_code` — and copy that idiom exactly).

- [ ] **Step 4: index.html hooks**

Next to `window.mdIsScriptRunning` (search for its assignment):

```js
    // Fase 3 (spec 2026-07-16-plain-script-widgets): hele-skriptet-rerun
    // for ui-kontroller med rerun="all". Klikker Kjør-knappen (Kjør alle i
    // notatbøker, vanlig kjøring ellers); nektes mens en kjøring pågår
    // (samme refuse-drop som ui.js sin egen vakt).
    window.mdRunWholeScript = function () {
      if (scriptRunInProgress) return;
      var b = document.getElementById('btnRun');
      if (b && !b.disabled) b.click();
    };

    // Fase 3: sync_to-push — ruter på aktiv modus. Navnet er allerede
    // regex-validert i js/ui.js (injeksjonsvernet ligger DER); verdier er
    // tall/streng/boolean fra verdikontroller. Ingen levende sesjon →
    // stille no-op (spec §3).
    window.mdUiSyncTo = function (name, value) {
      try {
        if (activeEditorMode === 'python') {
          if (!pyodide) return;
          if (!pyodide.runPython('"_g" in globals()')) return;
          pyodide.globals.set('__ui_sync_v', value);
          pyodide.runPython('_g["' + name + '"] = __ui_sync_v');
        } else if (activeEditorMode === 'brython' || activeEditorMode === 'micropython') {
          var eng = activeEditorMode === 'brython' ? window.BrythonEngine : window.MicroPythonEngine;
          if (eng && typeof eng.syncVar === 'function') {
            var err = eng.syncVar(name, JSON.stringify(value));
            if (err) console.warn('mdUiSyncTo(' + activeEditorMode + '): ' + err);
          }
        } else if (activeEditorMode === 'r') {
          if (!webR || typeof webR.evalRVoid !== 'function') return;
          var lit;
          if (typeof value === 'number' && isFinite(value)) lit = String(value);
          else if (typeof value === 'boolean') lit = value ? 'TRUE' : 'FALSE';
          else lit = '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
          webR.evalRVoid(name + ' <- ' + lit).catch(function (e) { console.warn('mdUiSyncTo(r): ' + e); });
        }
        // andre moduser (duckdb/microdata/statx/jamovi): bevisst no-op.
      } catch (e) {
        console.warn('mdUiSyncTo: ' + ((e && e.message) || e));
      }
    };
```

(Adapt the two globals `pyodide` and `webR` to the actual module-level variable names at the definition site — search `let pyodide` / `let webR` / `var webR` and use what the file uses; if `pyodide` is only assigned inside the run flow, guard with `typeof`.)

- [ ] **Step 5: Doc brackets around the plain-script run paths**

(a) The pyodide-family segment loop: locate the run path where `_nbActive = window.Cells && window.Cells.active()` is computed and per-segment notebook ctx is set (`_nbUiCtxFor`). Add the else-side doc bracket: BEFORE the segment loop,

```js
        var _docUiRun = !_nbActive;   // fase 3: rent skript → doc-kontekst
        if (_docUiRun) {
          nbUiRunCtx = { cellIdx: null, cellEl: null, doc: true };
          if (window.Ui && window.Ui.beginCellRun) window.Ui.beginCellRun(null);
        }
```

and in the existing `finally` that already resets `nbUiRunCtx = null`, add:

```js
        if (_docUiRun && window.Ui && window.Ui.endCellRun) window.Ui.endCellRun(null);
```

(scope `_docUiRun` so the finally sees it; if the finally lives in an outer function, declare `_docUiRun` there).

(b) brython/micropython plain path: in each engine's `runSelf` (modeRegistry), the branch that runs the WHOLE script via the engine (not the notebook cell loop — that branch already brackets per cell). Wrap the engine run:

```js
        nbUiRunCtx = { cellIdx: null, cellEl: null, doc: true };
        if (window.Ui && window.Ui.beginCellRun) window.Ui.beginCellRun(null);
        try {
          /* eksisterende engine.run(...)-kall uendret */
        } finally {
          nbUiRunCtx = null;
          if (window.Ui && window.Ui.endCellRun) window.Ui.endCellRun(null);
        }
```

(c) Cache busts: index.html `js/ui.js?v=...` bump to the next unused suffix; `sw.js` CACHE → `'m2py-v21'`.

- [ ] **Step 6: Suites + commit**

Run: `node --test tests/js/*.test.js` → only 4 known ENOENT. `python3 -m pytest brython/tests micropython/tests -q` → all pass incl. new `_sync_var` tests.

```bash
git add index.html js/brython-engine.js js/micropython-engine.js brython/brython_runner.py micropython/micropython_runner.py brython/tests micropython/tests sw.js
git commit -m "feat(ui): doc-braketter for rene skript (pyodide-familien + brython/mpy), mdRunWholeScript + mdUiSyncTo, _sync_var-tvillinger"
```

---

### Task 3: webR plain path + ui.R `sync_to`

**Files:**
- Modify: `index.html` — `runHybridR`'s NON-notebook path (search `runHybridR`; the notebook inject/read pair is at the `_rUiPlan`/`.ui_values`/`.ui_registry_json` sites — mirror them for the plain path)
- Modify: `webr/ui.R` — `sync_to = NULL` param on value controls, serialized into the registry JSON
- Test: manual `Rscript` parse+smoke (the W5 precedent — no CI harness for ui.R); node full suite regression

**Interfaces:**
- Consumes: `Ui.valuesForCell(null)` (doc values, prefix-stripped) and `Ui.registerFromRegistry(null, json)` from Task 1; `__ensureUiR()`/`__uiEvalRString` existing helpers.
- Produces: plain R scripts with `ui_*` calls get the doc strip + pull model; `sync_to` flows through the registry into the shared JS path.

- [ ] **Step 1: ui.R sync_to**

In `webr/ui.R`, add `sync_to = NULL` to each value-control function signature (`ui_slider`, `ui_dropdown`, `ui_checkbox`, `ui_switch`, `ui_number`, `ui_text` — NOT `ui_button`) and include it in the spec list each builds (only when non-NULL), following how `placement` is already passed. Update the file-head comment. Smoke: `Rscript -e 'source("webr/ui.R"); cat(.ui_registry_json())'` after calling `ui_slider(1, 10, sync_to = "n")` in the same session — the JSON must contain `"sync_to":"n"`.

- [ ] **Step 2: The plain-path inject/read pair**

In `runHybridR`'s non-notebook flow (where the notebook path would have built `_rUiPlan` but it is null): gate on a cheap text test so scripts without ui pay nothing:

```js
      // Fase 3 (spec §4): rene R-skript med ui_* — samme declare-og-injiser-
      // kanal som notatbokcellene, men mot doc-konteksten (cellIdx null).
      var _rDocUi = !_rUiActive && /\bui_(slider|dropdown|checkbox|switch|number|text|button)\s*\(/.test(script);
      if (_rDocUi) {
        await __ensureUiR();
        await webR.evalRVoid('.ui_begin(); .ui_values <- jsonlite::fromJSON(' +
          JSON.stringify(window.Ui && window.Ui.valuesForCell ? window.Ui.valuesForCell(null) : '{}') + ')');
      }
```

(match the exact `.ui_begin()`/fromJSON incantation the notebook path uses — copy it, changing only the values source to `valuesForCell(null)`), and AFTER the run completes (same place the notebook path reads the registry, in its non-notebook mirror):

```js
      if (_rDocUi && window.Ui && window.Ui.registerFromRegistry) {
        var _reg = await __uiEvalRString('.ui_registry_json()');
        if (_reg && _reg !== '[]') window.Ui.registerFromRegistry(null, _reg);
      }
```

Adapt variable names (`script`) to what the enclosing function actually calls its script text; place the read in a position that runs on BOTH success and R-error completion if the notebook path does (mirror it exactly).

- [ ] **Step 3: Verify + commit**

`node --test tests/js/*.test.js` → 4 known ENOENT only (no JS unit coverage for this path — browser verification in Task 5).

```bash
git add index.html webr/ui.R
git commit -m "feat(ui,R): rene R-skript — doc-injisering/registry-lesing + sync_to i ui.R"
```

---

### Task 4: Python facades `sync_to` + pytest

**Files:**
- Modify: `pyodide/ui.py`, `brython/ui_brython.py`, `micropython/ui_mpy.py` — `sync_to=None` keyword on the six value controls (slider/dropdown/checkbox/switch/number/text; NOT button), passed into the spec dict when non-None; docstrings mention the push semantics
- Test: `tests/test_ui_module.py` (append; FakeUiJs captures the spec JSON)

**Interfaces:**
- Consumes: nothing (pure facade pass-through — validation lives in js/ui.js).
- Produces: `ui.slider(1, 10, sync_to="n")` puts `"sync_to": "n"` in the registered spec, all three facades.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_ui_module.py` (existing FakeUiJs idiom):

```python
def test_sync_to_passed_through_all_value_controls(ui_mod, fake_js):
    ui_mod.slider(1, 10, sync_to="n")
    ui_mod.dropdown(["a", "b"], sync_to="valg")
    ui_mod.number(value=3, sync_to="my.var")
    specs = [json.loads(s) for s in fake_js.specs]
    assert [s.get("sync_to") for s in specs] == ["n", "valg", "my.var"]

def test_sync_to_absent_when_not_given(ui_mod, fake_js):
    ui_mod.slider(1, 10)
    spec = json.loads(fake_js.specs[-1])
    assert "sync_to" not in spec
```

Adapt fixture names to the file's actual conventions (read it first — it stubs the `js` module with a FakeUiJs whose `registerControl` records payloads). Run → FAIL (unexpected keyword).

- [ ] **Step 2: Implement in `pyodide/ui.py`, mirror in the twins**

For each value control, add the keyword and spec line, e.g. slider:

```python
def slider(min=0, max=100, *, value=None, step=1, label=None, name=None, rerun='self', on_change=None, placement=None, sync_to=None):
    ...
    if sync_to is not None:
        spec["sync_to"] = sync_to
```

(match each facade's exact spec-building style; `on_change` alias handling untouched). Byte-mirror into `brython/ui_brython.py` and `micropython/ui_mpy.py` (their documented dialect differences are elsewhere — this addition is identical text). Update the three docstrings/file-head comments: sync_to pushes into the live session variable on change without rerunning.

- [ ] **Step 3: Run tests + full pytest**

Run: `python3 -m pytest tests/test_ui_module.py -q` → 46+ pass. Then the full baseline: `python3 -m pytest tests/ brython/tests micropython/tests -q --continue-on-collection-errors` → everything green except the 1 known error (count grows by your new tests).

- [ ] **Step 4: Commit**

```bash
git add pyodide/ui.py brython/ui_brython.py micropython/ui_mpy.py tests/test_ui_module.py
git commit -m "feat(ui-fasader): sync_to= på verdikontroller — pyodide/brython/micropython-tvillingene + tester"
```

---

### Task 5: Examples + browser exit gate

**Files:**
- Create: `examples/python/py_plain_widgets.txt` (a PLAIN script — no `#%%`)
- Modify: `examples/manifest.json` (via `python3 examples/generate_manifest.py`, additive diff only)
- Modify: `docs/superpowers/specs/2026-07-16-plain-script-widgets-design.md` (status line DELIVERED)
- Test: browser sweep; report to `.superpowers/sdd/task-psw-5-report.md`

- [ ] **Step 1: The example**

`examples/python/py_plain_widgets.txt`:

```
# label: Widgets i rent skript — pull, rerun="all" og sync_to
#options.mode = python
#options.title = "Widgets uten celler"
#options.description = "ui-kontroller i et vanlig skript: verdiene leses ved neste Kjør (pull); rerun=\"all\" kjører hele skriptet på nytt ved endring; sync_to holder en variabel oppdatert uten kjøring"
# load https://raw.githubusercontent.com/hmelberg/openstat/main/data/iris.csv as iris

import ui

# Kontrollene havner i en stripe øverst i output-området. Standard i rene
# skript er rerun="none": du endrer verdiene og trykker Kjør når du vil.
n = ui.slider(1, 50, value=10, label="Antall rader", name="n")
art = ui.dropdown(["setosa", "versicolor", "virginica"], label="Art", name="art")

# rerun="all": endres denne, kjøres HELE skriptet på nytt (debounced).
vis_snitt = ui.checkbox(False, label="Vis gjennomsnitt", name="snitt", rerun="all")

# sync_to: holder python-variabelen `terskel` oppdatert i sesjonen uten
# å kjøre noe — nyttig for ui.on-handlere.
terskel = ui.slider(0, 10, value=5, step=0.5, label="Terskel", name="t", sync_to="terskel")

utvalg = iris[iris["species"] == art].head(n)
utvalg if not vis_snitt else utvalg.describe()
```

- [ ] **Step 2: Manifest**

`python3 examples/generate_manifest.py`; `git diff examples/manifest.json` → exactly one added entry.

- [ ] **Step 3: Browser exit-gate sweep**

Serve (`python3 -m http.server 8899`, background) + Playwright. Rows (record PASS/FAIL + one-line evidence in `.superpowers/sdd/task-psw-5-report.md`):

1. Load the example (python mode, plain script) → Kjør: control strip renders at the TOP of `#outputArea`; table shows below.
2. Change the slider/dropdown → NOTHING reruns; press Kjør → new values respected (pull).
3. Toggle the `rerun="all"` checkbox → whole script reruns (debounced, once); output updates to `.describe()`.
4. `sync_to`: after a run, change the Terskel slider, then run `print(terskel)` appended via a quick edit + Kjør — sees the synced value; ALSO verify the no-rerun path: use browser_evaluate on `pyodide.runPython('_g["terskel"]')` right after moving the slider (no run) — returns the new value.
5. Strip mark-and-sweep: delete the checkbox line from the script, Kjør → checkbox control disappears from the strip; values of remaining controls survive.
6. brython mode: a small plain script with `import ui` + slider + `rerun="all"` — controls render, all-rerun works, `BrythonEngine.syncVar` path verified via a `sync_to` + `ui.on`-style check or console probe of `_shared_vars`.
7. micropython mode: same as 6 (twin).
8. R mode: plain script with `ui_slider(1, 10, name = "n")` + using `n <- ...`? (R pull: `n <- ui_slider(...)`) — control renders after run (registry channel), value picked up on next Kjør; `sync_to = "m"` slider → after moving it, `webR.evalRString('as.character(m)')` probe shows the value without a rerun.
9. Notebook regression: `py_widgets_ui.txt` example still behaves exactly as before (rerun="self"/"plot" targets, strips in cells); `#@param` example unaffected.
10. Doc strip does not leak into notebooks: open a notebook after the plain run — no doc strip remains (resetDocument on contentLoaded).
11. Both themes on the plain-script strip.

- [ ] **Step 4: Suites + status + commit**

`node --test tests/js/*.test.js` → 4 known ENOENT only. Full pytest baseline (as Task 4). Add `**Status:** DELIVERED <date> (plan 2026-07-16-plain-script-widgets.md).` under the spec title.

```bash
git add examples/python/py_plain_widgets.txt examples/manifest.json docs/superpowers/specs/2026-07-16-plain-script-widgets-design.md
git commit -m "docs(eksempel): py_plain_widgets — widgets i rene skript (pull, rerun=all, sync_to); exit gate verifisert"
```
