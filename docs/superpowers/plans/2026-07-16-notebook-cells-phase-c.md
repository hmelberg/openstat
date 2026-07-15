# Notebook Cells Phase C (brython/micropython) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `#%%` notebooks runnable in brython and micropython modes (per-cell run, sessions, Restart & kjør alle) so that `ui` widgets and `#@param` forms work in both engines.

**Architecture:** Approach A from the spec (`docs/superpowers/specs/2026-07-16-notebook-cells-phase-c-design.md`): a direct cell loop that calls the engine once per code cell, bypassing the hybrid `## lang` segment machinery entirely. Both runners already keep persistent user globals and display the trailing expression, so the work is a session seam (bind `# load` datasets once, `_reset()`) plus notebook wiring (cells.js classification, `mdRunNotebookCell` dispatch, btnRun loop, session lifecycle).

**Tech Stack:** Vanilla ES5-style JS (IIFE modules), Brython 3.12 runner + MicroPython-wasm runner (both testable under CPython/pytest), node:test stub-DOM tests.

## Global Constraints

- **Paramount invariant:** documents without `#%%` behave byte-identically to today. The engines' existing `run()` (plain scripts, published dashboards) is untouched.
- The hybrid segment machinery is NOT modified: `SEG_MARKER`, `executableSource`, `segmentPlan`, `alignPlan` in `js/cells.js`, and `parseHybridScripts`/`buildDocumentSegments` in `index.html` keep their current behavior. `SEG_MARKER` gets NO new entries.
- Engine changes are twins: every runner/engine change lands in both brython and micropython variants, with only the documented dialect differences (brython: text returned from `_execute_code`; micropython: output via print into the engine's `__stdoutBuf`, `_execute_code` returns `''`).
- ES5 `var`-style JS in `js/*.js` and `index.html`, Norwegian comments, user-facing strings through `t()`.
- Per-cell bracketing contract (mirrors index.html ~9726/~9746): set `nbUiRunCtx = _nbUiCtxFor(payload.cellIdx)` and call `window.Ui.beginCellRun(payload.cellIdx)` before execution; in `finally`, `nbUiRunCtx = null`, `window.Ui.endCellRun(payload.cellIdx)`, `scriptRunInProgress = false`, `setRunButtonsUi('idle')`.
- Commit messages in Norwegian ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Branch: `notebook-cells-phase-c` off main.
- Test baselines before this phase: `node --test tests/js/*.test.js` = 467 pass / 4 pre-existing ENOENT failures (example-loads fixtures); `python3 -m pytest tests/ brython/tests/ micropython/tests/ -q` passes apart from the known `test_equivalence` collection error (run with `--ignore=tests/test_equivalence.py`).

---

### Task 1: Runner `_reset()` (both runners, TDD)

**Files:**
- Modify: `brython/brython_runner.py` (append at end of file)
- Modify: `micropython/micropython_runner.py` (append at end of file)
- Test: `brython/tests/test_brython_runner.py`, `micropython/tests/test_micropython_runner.py`

**Interfaces:**
- Consumes: existing `_shared_vars` (persistent user globals), `_last_error`, `_register_module`.
- Produces: `_reset()` → returns `''` on success, traceback string on failure (same contract style as `_register_module`). `_baseline_vars` module-level dict (private). Task 2's engine JS calls `mod._reset()`.

Both test files import their runner as a module under CPython (`import brython_runner as br` / `import micropython_runner as mr` after a `sys.path.insert`) — match each file's existing import alias and helper conventions. The micropython file has a `run(capsys, code)` helper (output via print/capsys); the brython runner returns output text directly from `_execute_code`.

- [ ] **Step 1: Write failing tests — brython**

Append to `brython/tests/test_brython_runner.py` (adjust the module alias to the file's existing one):

```python
def test_reset_clears_user_vars():
    br._execute_code('zz_fasec = 99')
    assert br._reset() == ''
    out = br._execute_code("'zz_fasec' in globals()")
    assert 'False' in out


def test_reset_keeps_baseline_show():
    br._reset()
    out = br._execute_code("show('fasec-baseline')")
    assert 'fasec-baseline' in out


def test_reset_clears_last_error():
    br._execute_code('1/0')
    assert br._get_last_error() != ''
    assert br._reset() == ''
    assert br._get_last_error() == ''


def test_reset_twice_is_safe():
    assert br._reset() == ''
    assert br._reset() == ''


def test_reset_keeps_registered_modules():
    assert br._register_module('fasec_dummy', 'V = 7') == ''
    br._reset()
    out = br._execute_code('import fasec_dummy\nfasec_dummy.V')
    assert '7' in out
```

- [ ] **Step 2: Write failing tests — micropython**

Append to `micropython/tests/test_micropython_runner.py` (uses the file's existing `run(capsys, code)` helper):

```python
def test_reset_clears_user_vars(capsys):
    run(capsys, 'zz_fasec = 99')
    assert mr._reset() == ''
    out = run(capsys, "print('zz_fasec' in globals())")
    assert 'False' in out


def test_reset_keeps_baseline_show(capsys):
    mr._reset()
    out = run(capsys, "show('fasec-baseline')")
    assert 'fasec-baseline' in out


def test_reset_clears_last_error(capsys):
    run(capsys, '1/0')
    assert mr._get_last_error() != ''
    assert mr._reset() == ''
    assert mr._get_last_error() == ''


def test_reset_twice_is_safe(capsys):
    assert mr._reset() == ''
    assert mr._reset() == ''


def test_reset_keeps_registered_modules(capsys):
    assert mr._register_module('fasec_dummy_mpy', 'V = 7') == ''
    mr._reset()
    out = run(capsys, 'import fasec_dummy_mpy\nprint(fasec_dummy_mpy.V)')
    assert '7' in out
```

NOTE: the micropython test file's header comment warns that pytest shares
the process across test files — use the unique variable/module names above
(`zz_fasec`, `fasec_dummy*`) so no other test observes them, and do not
assert on the *absence* of modules in `sys.modules`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `python3 -m pytest brython/tests/test_brython_runner.py micropython/tests/test_micropython_runner.py -q`
Expected: the new tests FAIL with `AttributeError: ... has no attribute '_reset'`; all pre-existing tests still pass.

- [ ] **Step 4: Implement `_reset()` in both runners**

Append at the very END of `brython/brython_runner.py` (after `_bind_datasets`), so the baseline captures every baseline entry (`show`, …):

```python
# Boot-baseline for fase C (spec 2026-07-16): et grunt bilde av
# _shared_vars slik de så ut ved boot — ATSKILT fra _snapshot/_rollback-
# paret, som er reservert duck-replay-løkken (per kjøring). _reset() spoler
# brukerglobals tilbake hit ("Restart & kjør alle" i notatbok), men beholder
# registrerte biblioteker i sys.modules — samme avveining som R-modusens
# rm(list=ls()) (og samme grunt-kopi-forbehold som _rollback dokumenterer:
# muterte objekter DELES med baselinen; grunne kopier er kontrakten her).
_baseline_vars = dict(_shared_vars)

def _reset():
    """Spol brukerglobals tilbake til boot-baseline; ''/traceback-kontrakt."""
    global _last_error
    try:
        _shared_vars.clear()
        _shared_vars.update(_baseline_vars)
        _last_error = ''
        return ''
    except BaseException:
        return traceback.format_exc()
```

Append the IDENTICAL block at the end of `micropython/micropython_runner.py` (same code — both runners already import `traceback` and define `_shared_vars`/`_last_error`; verify the names match that file and adjust only if its internals use different identifiers).

- [ ] **Step 5: Run tests to verify they pass**

Run: `python3 -m pytest brython/tests/ micropython/tests/ -q`
Expected: all pass, including the 10 new tests.

- [ ] **Step 6: Commit**

```bash
git add brython/brython_runner.py micropython/micropython_runner.py brython/tests/test_brython_runner.py micropython/tests/test_micropython_runner.py
git commit -m "feat(fase C): _reset() i begge runnerne — boot-baseline for Restart & kjør alle

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Engine `notebookSession` API (both engines)

**Files:**
- Modify: `js/brython-engine.js` (add before the final `global.BrythonEngine = …` export, extend the export)
- Modify: `js/micropython-engine.js` (same, before `global.MicroPythonEngine = …`)

**Interfaces:**
- Consumes: Task 1's `mod._reset()`; existing `load()`, `buildDatasetSpec(loads)`, `ensureLibs`, `scanImports`, `beginDuckBridge(spec)`, `PENDING_MARKER`, `MAX_DUCK_PASSES`, `__lastSpec`.
- Produces (used by Task 4/5): `BrythonEngine.notebookSession` / `MicroPythonEngine.notebookSession` =
  `{ ensure(loads) → Promise<void> (throws on bind error), runCell(source) → Promise<{text: string, error: string|null}> (never rejects), reset() → Promise<void> (throws on runner error), invalidate() → void, isLive() → boolean }`.

No unit tests in this task: the engines are browser modules (script tags, `document`, CDN fetches) with no existing node harness; the session API is exercised end-to-end by the Task 7 browser exit gate. State this in the commit body.

- [ ] **Step 1: Implement `notebookSession` in `js/brython-engine.js`**

Insert immediately before the `global.BrythonEngine = {` line:

```js
  // ── Notatbok-sesjon (fase C, spec 2026-07-16) ─────────────────────────
  // ÉN levende økt for celle-for-celle-kjøring: datasett bindes ÉN gang i
  // ensure() (IKKE per celle slik run() gjør — brukerens mutasjoner av
  // datasettvariabler skal overleve mellom celler), og duck-broen deles på
  // tvers av celler (views registreres én gang, spørringscachen gjenbrukes).
  // Vanlige scripts (uten #%%) bruker run() uendret — paramount-invarianten.
  var __nb = { live: false, duck: null };

  async function nbEnsure(loads) {
    if (__nb.live) return;
    var mod = await load();
    var spec = await buildDatasetSpec(loads);
    __lastSpec = spec;   // "Publiser dashboard" leser herfra, som ved run()
    if (Object.keys(spec).length) {
      await ensureLibs(mod, ['pandas_brython']);   // _bind_datasets bygger DataFrames
      var bindErr = mod._bind_datasets(JSON.stringify(spec));
      if (bindErr) throw new Error(String(bindErr));
    }
    __nb.duck = beginDuckBridge(spec);
    __nb.live = true;
  }

  async function nbRunCell(source) {
    // Kontrakt som run(): resolver ALLTID {text, error} — aldri reject.
    try {
      if (!__nb.live) {
        return { text: '', error: 'notebookSession.ensure() må kalles før runCell()' };
      }
      var mod = await load();
      await ensureLibs(mod, scanImports(source));
      var duck = __nb.duck;
      mod._snapshot();   // duck-replay-spoling gjelder KUN denne cellens pass
      var text = '', err = null, pass;
      for (pass = 0; pass < MAX_DUCK_PASSES; pass++) {
        if (pass > 0) mod._rollback();
        text = mod._execute_code(source);
        err = mod._get_last_error();
        if (err !== PENDING_MARKER) break;
        if (!duck.hasPending()) {
          return { text: '', error: 'duckdb_brython: replay uten ventende spørringer (intern feil)' };
        }
        await duck.flush();
      }
      if (err === PENDING_MARKER) {
        return { text: '', error: 'duckdb-spørringene stabiliserer seg ikke etter ' +
                 MAX_DUCK_PASSES + ' pass — bygges SQL-tekstene av ikke-deterministiske ' +
                 'verdier (f.eks. random uten seed)?' };
      }
      return { text: String(text == null ? '' : text), error: err ? String(err) : null };
    } catch (e) {
      return { text: '', error: (e && e.message) || String(e) };
    }
  }

  async function nbReset() {
    var mod = await load();
    var err = mod._reset();
    if (err) throw new Error(String(err));
    // live=false → neste ensure() re-resolver # load og rebinder datasett
    // (rene frames tilbake etter reset). __brythonDuck.register er
    // idempotent (typebevisst DROP + CREATE VIEW, index.html ~2707), så
    // en frisk bro kan trygt re-registrere de samme viewene.
    __nb.live = false;
    __nb.duck = null;
  }

  function nbInvalidate() { __nb.live = false; __nb.duck = null; }
  function nbIsLive() { return __nb.live; }
```

Then extend the export object:

```js
  global.BrythonEngine = {
    load: load, run: run, _scanImports: scanImports,
    getLastDatasetSpec: function () { return __lastSpec; },
    notebookSession: { ensure: nbEnsure, runCell: nbRunCell, reset: nbReset,
                       invalidate: nbInvalidate, isLive: nbIsLive }
  };
```

- [ ] **Step 2: Implement the twin in `js/micropython-engine.js`**

Same structure before `global.MicroPythonEngine = {`, with the four dialect differences:
1. `ensureLibs(mod, ['pandas_mpy'])` instead of `pandas_brython`.
2. The error strings say `duckdb_mpy`.
3. Output comes from the stdout buffer, and the script log must be fed
   (dash's `_func_params` source fallback reads it — one push per
   `runCell`, NOT per replay pass, same rule as `run()`):

```js
  async function nbRunCell(source) {
    try {
      if (!__nb.live) {
        return { text: '', error: 'notebookSession.ensure() må kalles før runCell()' };
      }
      var mod = await load();
      await ensureLibs(mod, scanImports(source));
      var duck = __nb.duck;
      __scriptLog.push(source);   // dash _func_params-fallback (se run())
      mod._snapshot();
      var err = null, pass;
      for (pass = 0; pass < MAX_DUCK_PASSES; pass++) {
        if (pass > 0) mod._rollback();
        __stdoutBuf.length = 0;   // nytt pass = tom buffer (pending-pass forkastes)
        __captureMark = 0;
        mod._execute_code(source);
        err = mod._get_last_error();
        if (err !== PENDING_MARKER) break;
        if (!duck.hasPending()) {
          return { text: '', error: 'duckdb_mpy: replay uten ventende spørringer (intern feil)' };
        }
        await duck.flush();
      }
      if (err === PENDING_MARKER) {
        return { text: '', error: 'duckdb-spørringene stabiliserer seg ikke etter ' +
                 MAX_DUCK_PASSES + ' pass — bygges SQL-tekstene av ikke-deterministiske ' +
                 'verdier (f.eks. random uten seed)?' };
      }
      var text = __stdoutBuf.join('\n');
      return { text: text, error: err ? String(err) : null };
    } catch (e) {
      return { text: '', error: (e && e.message) || String(e) };
    }
  }
```
4. `nbEnsure` is otherwise identical (uses this file's `buildDatasetSpec`/`beginDuckBridge`); export mirrors brython's.

- [ ] **Step 3: Syntax-check both files**

Run: `node --check js/brython-engine.js && node --check js/micropython-engine.js`
Expected: no output (both parse).

- [ ] **Step 4: Run the node suite (regression only)**

Run: `node --test tests/js/*.test.js 2>&1 | grep -E 'ℹ (tests|pass|fail)'`
Expected: `tests 471 / pass 467 / fail 4` (unchanged baseline).

- [ ] **Step 5: Commit**

```bash
git add js/brython-engine.js js/micropython-engine.js
git commit -m "feat(fase C): notebookSession-API i begge motorene (ensure/runCell/reset)

Ingen enhetstester her: motorene er browser-moduler uten node-harness;
API-et dekkes ende-til-ende av fase C sitt browser-exit-gate (Task 7).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: cells.js — mode activation, kinds, engine run plan (TDD)

**Files:**
- Modify: `js/cells.js:27` (`SUPPORTED_MODES`), `js/cells.js:209` (`KIND_FOR_TYPE`), new `C.engineRunPlan` in the DOM half (near `C.alignedPlanForKinds`, ~line 1409)
- Test: `tests/js/cells.test.js` (pure half), `tests/js/cells-dom.test.js` (engineRunPlan)

**Interfaces:**
- Produces: `Cells.supportedMode('brython') === true` (notebook renders in these modes); `Cells.KIND_FOR_TYPE.brython === 'brython'`, `.micropython === 'micropython'` (so `C.runCell` builds payloads with these kinds — no change needed in `C.runCell` itself); `Cells.engineRunPlan()` → array of cell indices for every code cell whose resolved type has a `KIND_FOR_TYPE` entry (in document order, preamble included), or `null` when the notebook is inactive. Task 5's Run All loop consumes it.
- Invariant to pin: `SEG_MARKER` unchanged → `executableSource` still blanks brython/micropython cells.

- [ ] **Step 1: Write failing pure-half tests**

Append to `tests/js/cells.test.js` (match the file's existing require/assert conventions):

```js
test('fase C: brython/micropython er støttede notatbok-moduser', function () {
  assert.equal(Cells.supportedMode('brython'), true);
  assert.equal(Cells.supportedMode('micropython'), true);
  assert.equal(Cells.supportedMode('statx'), false);   // uendret
});

test('fase C: KIND_FOR_TYPE har brython/micropython, SEG_MARKER har dem IKKE', function () {
  assert.equal(Cells.KIND_FOR_TYPE.brython, 'brython');
  assert.equal(Cells.KIND_FOR_TYPE.micropython, 'micropython');
  assert.equal(Cells.SEG_MARKER.brython, undefined);
  assert.equal(Cells.SEG_MARKER.micropython, undefined);
});

test('fase C: executableSource blanker fortsatt brython-celler (invariant)', function () {
  var doc = '# load x as y\n#%% brython\nprint(1)\n#%% md\nhei';
  var out = Cells.executableSource(doc, 'brython');
  assert.ok(out.indexOf('print(1)') === -1);
  assert.equal(out.split('\n').length, doc.split('\n').length);  // linjetall bevart
});
```

(If `KIND_FOR_TYPE` is not currently exported on `C`, export it —
`C.KIND_FOR_TYPE = KIND_FOR_TYPE;` already exists at line 210.)

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/js/cells.test.js`
Expected: the three new tests FAIL (supportedMode false / KIND undefined).

- [ ] **Step 3: Implement the two table additions**

`js/cells.js:27`:
```js
  // Fase A: modusene der notebook-rendring og segmentkjøring er støttet.
  // Fase C (spec 2026-07-16): + brython/micropython — motor-notatbøker som
  // kjøres celle-for-celle UTENOM segmentmaskineriet (SEG_MARKER har dem
  // med vilje IKKE; executableSource skal fortsette å blanke dem).
  var SUPPORTED_MODES = { python: 1, r: 1, duckdb: 1, microdata: 1,
                          brython: 1, micropython: 1 };
```

`js/cells.js:209`:
```js
  var KIND_FOR_TYPE = { python: 'pyodide', r: 'r', duckdb: 'duckdb',
                        microdata: 'microdata',
                        brython: 'brython', micropython: 'micropython' };
```

- [ ] **Step 4: Write failing DOM-half test for `engineRunPlan`**

Append to `tests/js/cells-dom.test.js` (reuse the file's stub-DOM setup and
its established enter/render helper pattern — several tests there already
activate a notebook from a document string; mirror the nearest one):

```js
test('fase C: engineRunPlan lister kodeceller i dokumentrekkefølge', function () {
  // dokument i brython-modus: preambel + brython-celle + md + brython-celle
  enterNotebook('# load a as b\n#%% brython\nx = 1\n#%% md\nhei\n#%% brython\nx + 1', 'brython');
  assert.deepEqual(Cells.engineRunPlan(), [0, 1, 3]);   // preambel er celle 0
  Cells.exit();
  assert.equal(Cells.engineRunPlan(), null);
});
```

(`enterNotebook(text, mode)` stands for the file's existing activation
helper — use the real one; if none is factored out, inline the same setup
the neighboring tests use.)

- [ ] **Step 5: Implement `C.engineRunPlan`**

Insert in the DOM half next to `C.alignedPlanForKinds` (~line 1409):

```js
    // Fase C (spec 2026-07-16): kjøreplan for motor-notatbøker (brython/
    // micropython) — celleindeksene til ALLE kodeceller med en KIND_FOR_TYPE-
    // oppføring, i dokumentrekkefølge (preambelen inkludert: den resolver
    // til docMode og kjøres som "celle 0" inn i sesjonen). Ingen segmenter
    // her — enspråklige dokumenter kjøres celle for celle via C.runCell, og
    // fremmede kode-kinds får sin notis fra mdRunNotebookCell, ikke herfra.
    // null når notatboken er inaktiv (samme kontrakt som alignedPlanForKinds).
    C.engineRunPlan = function () {
      if (!NB.activeFlag) return null;
      var out = [];
      for (var i = 0; i < NB.cells.length; i++) {
        var type = C.resolveType(NB.cells[i], NB.docMode);
        if (C.isCodeType(type) && KIND_FOR_TYPE[type]) out.push(i);
      }
      return out;
    };
```

- [ ] **Step 6: Run all cells tests**

Run: `node --test tests/js/cells.test.js tests/js/cells-dom.test.js`
Expected: all pass (new + existing).

- [ ] **Step 7: Full node suite + commit**

Run: `node --test tests/js/*.test.js 2>&1 | grep -E 'ℹ (tests|pass|fail)'`
Expected: pass = 467 + 4 new = 471, fail 4 (pre-existing).

```bash
git add js/cells.js tests/js/cells.test.js tests/js/cells-dom.test.js
git commit -m "feat(fase C): brython/micropython som notatbok-moduser + engineRunPlan i cells.js

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: index.html — per-cell dispatch + session lifecycle

**Files:**
- Modify: `index.html` — new `runNotebookEngineCell` (place directly after `runNotebookRCell`, which ends ~line 9421); `window.mdRunNotebookCell` dispatch (~9422-9441); `window.mdNotebookSession` (`runtime`/`isLive`/`restart`/`invalidate`, ~9179-9254); `switchEditorMode` (~3294)

**Interfaces:**
- Consumes: Task 2's `notebookSession` API; Task 3's kinds (payload.kind is now `'brython'|'micropython'` for those cells); existing `_nbUiCtxFor`, `nbUiRunCtx`, `scriptRunInProgress`, `setRunButtonsUi`, `setStatus`, `t()`, `window.DataLoader.resolveAndFetchLoads`, `getAnthropicKey()`, `mdPromptKey`.
- Produces: `mdRunNotebookCell` handles the two new kinds end-to-end (per-cell ▶, widgets rerun, `#@param` rerun, Kjør-chip all flow through this); `mdNotebookSession.restart()` resets the engine (no pyodide boot); session chip shows `brython`/`micropython` live/cold correctly. Task 5's Run All loop reuses all of this via `Cells.runCell`.

- [ ] **Step 1: Add `runNotebookEngineCell` after `runNotebookRCell`**

```js
    // Fase C (spec 2026-07-16): per-celle-kjøring for motor-notatbøker
    // (brython/micropython) — EGEN sti, som runNotebookRCell: ingen
    // Pyodide-sesjon skal bootes her. Motorene kjører på hovedtråden, så
    // ui-fasadenes pull-modell virker via nbUiRunCtx/beginCellRun-bracketen
    // (samme kontrakt som pyodide-grenen ~9726/~9746). Kald sesjon: ensure()
    // binder # load-datasett ÉN gang og preambelen (celle 0) kjøres FØRST
    // inn i økten — dens output forkastes (console.warn ved feil), målcellen
    // rendrer sin egen.
    async function runNotebookEngineCell(payload) {
      var kind = payload && payload.kind;
      if (activeEditorMode !== kind) {
        return { notice: t('{kind}-celler kjøres bare i {kind}-modus — bytt modus først', { kind: kind }) };
      }
      var engine = kind === 'brython' ? window.BrythonEngine : window.MicroPythonEngine;
      if (!engine || !engine.notebookSession) {
        return { error: t('Motoren er ikke lastet ennå. Vent og prøv igjen.') };
      }
      var sess = engine.notebookSession;
      scriptRunInProgress = true;
      setRunButtonsUi('running');
      try {
        if (!sess.isLive()) {
          setStatus(rightStatus, t('Starter økt…'));
          var _dl = await window.DataLoader.resolveAndFetchLoads(scriptInput.value,
            { anthropicKey: getAnthropicKey(), promptKey: mdPromptKey });
          await sess.ensure(_dl.loads);
          // Preambel (celle 0, headerRaw === null) inn i den ferske økten —
          // med mindre målcellen ER preambelen (da kjøres den under, med
          // synlig output i sin egen slot).
          var _parsed = window.Cells.parseCells(scriptInput.value);
          var _pre = _parsed.cells[0];
          if (_pre && _pre.headerRaw === null && payload.cellIdx !== 0) {
            var _preRes = await sess.runCell(_pre.source || '');
            if (_preRes.error) console.warn('preambel (fase C):', _preRes.error);
          }
        }
        setStatus(rightStatus, t('Kjører…'));
        nbUiRunCtx = _nbUiCtxFor(payload.cellIdx);
        if (window.Ui && window.Ui.beginCellRun) window.Ui.beginCellRun(payload.cellIdx);
        var res = await sess.runCell(payload.text || '');
        setStatus(rightStatus, res.error ? t('Feil') : t('Ferdig'));
        if (res.error) return { error: res.error };
        return { text: (res.text || '').trim() };
      } catch (e) {
        return { error: (e && e.message) || String(e) };
      } finally {
        nbUiRunCtx = null;
        if (window.Ui && window.Ui.endCellRun) window.Ui.endCellRun(payload.cellIdx);
        scriptRunInProgress = false;
        setRunButtonsUi('idle');
      }
    }
```

- [ ] **Step 2: Dispatch the new kinds in `mdRunNotebookCell`**

Directly after the `if (kind === 'r') { … }` block (~9432) and BEFORE the
`if (activeEditorMode === 'r')` guard, insert:

```js
      // Fase C: motor-celler (egen sti — se runNotebookEngineCell over).
      // Modusmatch håndheves DER (kind !== activeEditorMode → notis), så
      // en #%% brython-celle i et r-/python-dokument også lander riktig.
      if (kind === 'brython' || kind === 'micropython') {
        return runNotebookEngineCell(payload);
      }
```

Then, after the existing `if (activeEditorMode === 'r') { … }` guard
(~9436-9438), add the mirror guard for foreign kinds in engine modes
(without it, a `#%% python`/`#%% duckdb` cell's ▶ in brython mode would
boot a pointless pyodide session):

```js
      // Fase C: fremmede kode-kinds i motor-modus (spec-avgjørelse 1:
      // enspråklige dokumenter) — notis, aldri Pyodide-boot.
      if (activeEditorMode === 'brython' || activeEditorMode === 'micropython') {
        return { notice: t('Denne celletypen kjøres ikke i {mode}-modus — dokumentet er enspråklig', { mode: activeEditorMode }) };
      }
```

- [ ] **Step 3: Session lifecycle in `mdNotebookSession` and `switchEditorMode`**

(a) `runtime()` (~9246-9249) — add the two modes to the clamp:

```js
      runtime: function () {
        var m = activeEditorMode;
        return (m === 'python' || m === 'r' || m === 'duckdb' || m === 'microdata'
                || m === 'brython' || m === 'micropython') ? m : null;
      },
```

(b) `isLive()` (~9242) — delegate in engine modes (the pyodide flag
`nbSessionLive` is meaningless there):

```js
      isLive: function () {
        if (activeEditorMode === 'brython' && window.BrythonEngine && window.BrythonEngine.notebookSession) {
          return window.BrythonEngine.notebookSession.isLive();
        }
        if (activeEditorMode === 'micropython' && window.MicroPythonEngine && window.MicroPythonEngine.notebookSession) {
          return window.MicroPythonEngine.notebookSession.isLive();
        }
        return nbSessionLive;
      },
```

(c) `restart()` — insert an engine branch BEFORE the `if (activeEditorMode === 'r' …)` branch (~9204), after the `IpwBridge.reset()` line:

```js
        // Fase C: motor-modus — runner-nivå reset (spec-avgjørelse 2), ingen
        // Pyodide-boot (samme F4-prinsipp som r-grenen under). live=false i
        // notebookSession → neste kjørings ensure() re-resolver # load og
        // rebinder friske datasettvariabler.
        if (activeEditorMode === 'brython' || activeEditorMode === 'micropython') {
          var _eng = activeEditorMode === 'brython' ? window.BrythonEngine : window.MicroPythonEngine;
          if (_eng && _eng.notebookSession) {
            return _eng.notebookSession.reset().catch(function (e) {
              console.warn('motor-reset (fase C):', e);
              _eng.notebookSession.invalidate();   // feilet reset → i det minste kald sesjon
            });
          }
          return Promise.resolve();
        }
```

(d) `invalidate()` (~9236-9241) — add engine invalidation (cheap flag
flips, unconditional on both engines):

```js
        if (window.BrythonEngine && window.BrythonEngine.notebookSession) window.BrythonEngine.notebookSession.invalidate();
        if (window.MicroPythonEngine && window.MicroPythonEngine.notebookSession) window.MicroPythonEngine.notebookSession.invalidate();
```

(e) `switchEditorMode` (~3294, next to the existing `nbSetSessionLive(false)`) — same two lines as (d), with a one-line comment
(`// Fase C: motor-sesjonene er også modus-bundet`).

- [ ] **Step 4: Regression checks**

Run: `node --test tests/js/*.test.js 2>&1 | grep -E 'ℹ (tests|pass|fail)'`
Expected: 471/467/4 (unchanged — index.html has no node tests).

Serve and smoke-test manually if a browser is available (full verification
is Task 7): a python notebook still runs per-cell; an R notebook still
restarts correctly.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat(fase C): per-celle-kjøring og sesjonsliv for motor-notatbøker i index.html

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: index.html — Run All loop for engine notebooks

**Files:**
- Modify: `index.html` — btnRun click handler, directly after the interrupt guard (`if (scriptRunInProgress) { performRunInterrupt(); return; }`, ~9758-9762) and BEFORE the existing `Cells.active()` grantHtmlTrust/executableSource block (~9769)

**Interfaces:**
- Consumes: Task 3's `Cells.engineRunPlan()`, existing `Cells.runCell(idx)` (which now reaches Task 4's `runNotebookEngineCell` via the payload kind), `Cells.grantHtmlTrust`.
- Produces: «Kjør alle» and «Restart & kjør alle» (which is `mdNotebookSession.restart()` + a btnRun click, cells.js ~1694) work for engine notebooks.

- [ ] **Step 1: Add the module-level re-entry flag**

Next to `let nbSessionLive = false;` (~3680):

```js
    // Fase C: vakt mot dobbel "Kjør alle" i motor-notatbøker — løkka under
    // (btnRun) slipper scriptRunInProgress mellom cellene (hver celle eier
    // sitt eget flagg via mdRunNotebookCell), så btnRun sin vanlige
    // interrupt-vakt fanger ikke et nytt klikk midt i løkka.
    let engineNbRunActive = false;
```

- [ ] **Step 2: Add the Run All branch in btnRun**

```js
      // Fase C (spec 2026-07-16, valg A): motor-notatbøker (brython/
      // micropython) kjøres celle for celle via Cells.runCell — HELT UTENOM
      // executableSource/segmentmaskineriet under (som ville blanket alle
      // cellene: SEG_MARKER har med vilje ingen brython/micropython-
      // oppføringer). Cells.runCell gir stale-rydding, Kjør-chip-skjuling,
      // dash-sweep og renderCellResult gratis; fremmede kode-kinds får sin
      // notis fra mdRunNotebookCell. Kjør/idle-knappetilstanden blafrer kort
      // mellom cellene (hver celle eier sitt eget scriptRunInProgress-vindu)
      // — akseptert: en delt løkke-flagg ville fått Cells.runCell sin egen
      // mdIsScriptRunning-vakt til å avvise alle cellene.
      if (window.Cells && window.Cells.active()
          && (activeEditorMode === 'brython' || activeEditorMode === 'micropython')) {
        if (engineNbRunActive) return;
        engineNbRunActive = true;
        try {
          if (window.Cells.grantHtmlTrust) window.Cells.grantHtmlTrust();
          var _engPlan = window.Cells.engineRunPlan() || [];
          for (var _ei = 0; _ei < _engPlan.length; _ei++) {
            await window.Cells.runCell(_engPlan[_ei]);
          }
        } finally {
          engineNbRunActive = false;
          setRunButtonsUi('idle');
        }
        return;
      }
```

- [ ] **Step 3: Regression + smoke**

Run: `node --test tests/js/*.test.js 2>&1 | grep -E 'ℹ (tests|pass|fail)'`
Expected: 471/467/4.

Browser smoke (full sweep is Task 7): serve the repo
(`python3 -m http.server 8130`), switch to Brython mode, paste

```
# load https://raw.githubusercontent.com/hmelberg/openstat/main/data/iris.csv as iris

#%% md
# Test

#%% brython
x = iris.head(3)
x

#%% brython
len(iris)
```

Kjør alle → first code cell shows a 3-row table, second shows the row
count; edit `3` → `5`, per-cell ▶ → updated table; Restart & kjør alle →
both re-run against a fresh session. Repeat once in MicroPython mode
(engine boot is fast). Plain script without `#%%` still runs unchanged.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(fase C): Kjør alle som celle-loop for motor-notatbøker (btnRun)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Examples, facade headers, spec/doc updates, cache busting

**Files:**
- Create: `examples/brython/bry24_notatbok_widgets.txt`, `examples/micropython/05_notatbok_widgets.txt`
- Modify: `examples/manifest.json` (regenerated), `pyodide/../brython/ui_brython.py` header, `micropython/ui_mpy.py` header, `docs/superpowers/specs/2026-07-13-notebook-cells-design.md` (§3.3 + §6 Phase C entry), `docs/superpowers/specs/2026-07-15-notebook-widgets-design.md` (W2 parity-note update), `sw.js` (CACHE bump), `index.html` (script-tag `?v=` bumps)

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces: the two example notebooks the Task 7 exit gate drives.

- [ ] **Step 1: Create the brython example**

`examples/brython/bry24_notatbok_widgets.txt`:

```
# label: Notatbok — widgets og #@param (Brython)
#options.mode = brython
#options.title = "Notatbok med widgets (Brython)"
#options.description = "Celle-notatbok i Brython-modus: ui-widgets (pull-modellen) og #@param-skjema"
# load https://raw.githubusercontent.com/hmelberg/openstat/main/data/iris.csv as iris

#%% md
# Widgets i Brython-notatbok

Brython kjører på hovedtråden, så `ui`-modulen bruker samme pull-modell
som python-modus: hvert `ui.*`-kall leser kontrollens gjeldende verdi, og
endringer kjører cellen (eller en navngitt celle via `rerun=`) på nytt.

#%% brython
import ui

n = ui.slider(1, 20, value=5, label="Antall rader")
art = ui.dropdown(sorted(set(iris["species"])), label="Art")

iris[iris["species"] == art].head(n)

#%% brython id=plot
# Denne cellen BRUKER n/art fra cellen over (delt sesjon), men har ingen
# egne widgets — Oppdater-knappen under kjører den på nytt (rerun="plot").
import pandas_brython as pd
import plotly_express_brython as pe

sub = iris[iris["species"] == art].head(n)
pe.scatter(sub, x="sepal_length", y="petal_length",
           title="Iris — " + art + ", første " + str(n) + " rader")

#%% brython
import ui

ui.button("Oppdater", rerun="plot")

#%% md
`#@param` virker også — skjemaet skriver verdien inn i kildelinjen:

#%% brython
antall = 50 #@param {type:"slider", min:10, max:150, step:10, run:"auto"}
len(iris.head(antall))
```

NOTE to implementer: before committing, open `examples/brython/bry02_plotly_charts.txt` and confirm the `pe.scatter(...)` keyword surface used
above matches what `plotly_express_brython` actually supports (adjust the
plot call to that file's idiom if not — e.g. positional args or a
different chart helper). The document must run clean end-to-end in the
browser (Step 4).

- [ ] **Step 2: Create the micropython twin**

`examples/micropython/05_notatbok_widgets.txt` — same document with the
four dialect substitutions: `#options.mode = micropython`, title/label
`(MicroPython)`, `import pandas_mpy as pd` / `import plotly_express_mpy as pe`,
and `#%% micropython` headers. Same verification note against
`examples/micropython/02_plotly.txt`.

- [ ] **Step 3: Regenerate the manifest**

Run: `python3 examples/generate_manifest.py`
Then: `python3 -m pytest tests/test_examples_manifest.py tests/test_manifest_integration.py -q`
Expected: pass; `git diff examples/manifest.json` shows exactly the two new entries.

- [ ] **Step 4: Browser-verify both examples**

Serve, load each example from the examples menu in its mode, Kjør alle:
tables/plot render per cell, widgets appear, slider change reruns its
cell, Oppdater reruns the plot cell, `#@param` slider rewrites the source
line and reruns. (The deep sweep is Task 7 — this step just proves the
examples themselves are runnable documents.)

- [ ] **Step 5: Update the facade headers**

In `brython/ui_brython.py` and `micropython/ui_mpy.py`: replace the
paragraph claiming the engines have no notebook support ("Widgets krever i
dag en aktiv notatbok-kjørekontekst … kommer i en senere fase … faller
ALLTID tilbake til sin dokumenterte deterministiske default") with a short
paragraph stating the current reality:

```
Fase C (spec 2026-07-16): motoren HAR notatbok-cellestøtte — under
per-celle-kjøring/Kjør alle setter index.html kjørekonteksten
(Ui.beginCellRun), og registerControl registrerer/tegner kontrollen
akkurat som i pyodide-modus (samme pull-modell; hovedtråd = synkron
lesing). Utenfor en notatbok-kjørekontekst (vanlige scripts) returnerer
registerControl fortsatt null, og hvert ui.*-kall faller da tilbake til
sin dokumenterte deterministiske default (under, per funksjon).
```

Keep the FFI-null paragraphs untouched. Run the facade tests:
`python3 -m pytest tests/test_ui_module.py brython/tests/test_ui_brython.py micropython/tests/test_ui_mpy.py -q` — expected pass (comments only; adjust the exact test paths to where the two facade test files actually live if they differ).

- [ ] **Step 6: Spec/doc + cache updates**

- `docs/superpowers/specs/2026-07-13-notebook-cells-design.md` §3.3: change
  the mode list to "python / r / duckdb / microdata / brython /
  micropython" and drop brython/micropython from the inert-comment
  sentence; §6 Phase C entry: prefix with "**DONE <dato>**" and a one-line
  pointer to the phase C spec.
- `docs/superpowers/specs/2026-07-15-notebook-widgets-design.md`: in the
  W2 parity note's 2026-07-16 update paragraph, note Phase C is delivered.
- `sw.js`: `const CACHE = 'm2py-v17';` (runners are precached, both changed
  in Task 1).
- `index.html`: bump `?v=` to `2026-07-16a` on the `js/brython-engine.js`,
  `js/micropython-engine.js` and `js/cells.js` script tags (all changed
  this phase; find each tag and update only its query param).

- [ ] **Step 7: Commit**

```bash
git add examples/ brython/ui_brython.py micropython/ui_mpy.py docs/superpowers/specs/ sw.js index.html
git commit -m "docs+eksempler(fase C): notatbok-eksempler for brython/mpy, fasade-headere, spec-status, cache-bump

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Exit gate — full suites + browser sweep (both engines)

**Files:** none created (fixes go where the sweep finds them, each as its own commit).

- [ ] **Step 1: Full test suites**

Run:
```bash
node --test tests/js/*.test.js 2>&1 | grep -E 'ℹ (tests|pass|fail)'
python3 -m pytest tests/ brython/tests/ micropython/tests/ --ignore=tests/test_equivalence.py -q | tail -3
```
Expected: node = baseline + this phase's new tests, fail 4 (pre-existing
ENOENT); pytest all pass.

- [ ] **Step 2: Browser sweep — repeat the FULL matrix in BOTH modes (brython, then micropython)**

Serve fresh (new port). For each engine mode:
1. Load the phase's example → Kjør alle: every code cell gets output in
   its own slot, widgets render in the strip, plot renders (≤480px).
2. Widget flow: slider/dropdown change → the widget cell reruns with new
   values (table updates); Oppdater → plot cell reruns via `rerun="plot"`.
3. `#@param`: the run:"auto" slider rewrites its source line (check via
   Rå tekst) AND reruns; temporarily edit the meta to drop run:"auto" →
   change → stale tint + Kjør-chip appears → chip click runs and clears.
4. Per-cell: ▶ on a single cell against a cold session (fresh reload, no
   Kjør alle first) — session boots, `# load` data available, widgets
   render (this is the B1-regression analogue: cold per-cell must work).
5. Sessions: run a cell defining `q = 1`, run another cell reading `q` →
   works; Restart & kjør alle → variables reset (a cell reading a deleted
   var errors), dataset variables re-bound fresh, libraries still import
   without refetch; session chip shows `<mode> ● aktiv` after runs and
   `○ kald` after mode-switch away/back.
6. Foreign cells: add `#%% python\n1+1` to the document → its ▶ and Kjør
   alle both show the polite notice, never boot pyodide (watch the
   network/status bar).
7. md/html cells render; html cell from a shared `#s=` link stays escaped
   until Vis HTML/Kjør (paste a share link of the doc to verify).
8. Regression: a plain script (no `#%%`) in the same mode runs byte-
   identically (spot-check bry02/02_plotly example outputs); python and R
   notebooks still work (load one of each, Kjør alle + one per-cell run).
9. Both themes (light/dark) screenshot-checked for the widget strips.
10. Forklar/skrittvis is descoped (spec decision 4): if the Forklar toggle
    is reachable in these modes, flipping it must not crash and must not
    half-run the notebook — a notice or unchanged plain-text behavior are
    both acceptable; if it misbehaves, gate it with a notice as the fix.

- [ ] **Step 3: Fix what the sweep finds**

Each fix is its own commit with the covering test named in the message.
Re-run the affected sweep row after each fix.

- [ ] **Step 4: Final commit + ledger**

Append the phase C completion lines to `.superpowers/sdd/progress.md`.
