# Editor Convergence 4a — The Converged Document Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cell-list notebook renderer's ROLE with a converged document rendered into `#outputArea` (editor stays `#scriptInput`), preserving the full `Cells.*` API surface and all mount seams — per `docs/superpowers/specs/2026-07-17-editor-convergence-design.md` §§1, 3, 4 (plan 4b does partial execution + removal).

**Architecture:** A new document renderer in js/cells.js's DOM half (`docRender`/`docCellNode`) builds `.doc-root` inside `#outputArea` with output-only cell slots that keep today's `.nb-cell[data-idx]` → `.nb-output` → `.nb-output-body` classes (so ParamForms/Ui/dash/ipywidgets mount unchanged via `cellElementAt`). `C.enter` no longer swaps `.container` for a sibling root. Edits reconcile in place (same structure → update changed cells; else rebuild). `Cells.setLayout` collapses into the app layout primitives; presentation re-hosts on `.doc-root`. The old cell-list code stays in the file but UNREACHABLE (removed in plan 4b).

**Tech Stack:** ES5 var-style JS (js/cells.js DOM half, index.html), app.css, node built-in test runner (stub DOM).

## Global Constraints

- **The pure half of js/cells.js is untouched** (everything above the `typeof document` IIFE gate).
- **`mdRunNotebookCell` contract unchanged** ({kind,text,uses,nb,cellIdx} → {text|error|notice|rparts}); index.html's run path is not modified except where named below.
- **Mount seams**: `Cells.cellElementAt(idx)` returns a node under which `.querySelector('.nb-output')`/`.nb-output-body` works; strips insert before `.nb-output-body` exactly as today.
- **Plain scripts unchanged** (no `#%%` → today's behavior byte-identically, incl. phase 3 doc widgets).
- **htmlTrusted gate survives** in the doc renderer (escaped + «Vis HTML» until trusted).
- Skrittvis untouched. ES5 var, Norwegian comments, strings via `t()` + en.js.
- Baselines: `node --test tests/js/cells-dom.test.js` → 103 pass; `cells.test.js` → 115; `ui-dom.test.js` → 70; full node → 4 known ENOENT only; pytest full → 1247 + 1 known error.
- Cell-list tests that assert `.nb-input`/textarea/toolbar behavior may be REWRITTEN in the same task that makes them obsolete — never silently deleted; each rewrite is named in the task's report.
- Every task ends with the full node suite at (new) baseline; record the new counts in the report.

---

### Task 1: Pure helpers — `C.cellAtLine`, `C.sameStructure`

**Files:**
- Modify: `js/cells.js` (pure half, after `C.slidePlan`)
- Test: `tests/js/cells.test.js` (append)

**Interfaces:**
- Produces: `C.cellAtLine(cells, line)` → cell index or -1 (the cell whose `[startLine, endLine]` contains the 0-based line; `-1` for out-of-range/empty). `C.sameStructure(cellsA, cellsB)` → boolean (same length AND pairwise identical `headerRaw` — the reconciliation gate). Tasks 3 (reconciliation) and plan 4b (cursor mapping) consume these.

- [ ] **Step 1: Failing tests**

```js
// ---------- editor-konvergens: rene hjelpere (spec 2026-07-17 §1/§2) ----------

test('cellAtLine: linje → celleindeks via startLine/endLine; utenfor → -1', () => {
  const p = C.parseCells('# pre\n\n#%% python\nx = 1\ny = 2\n#%% md\ntekst');
  assert.strictEqual(C.cellAtLine(p.cells, 0), 0);   // preambel
  assert.strictEqual(C.cellAtLine(p.cells, 1), 0);
  assert.strictEqual(C.cellAtLine(p.cells, 2), 1);   // #%%-linjen tilhører cellen
  assert.strictEqual(C.cellAtLine(p.cells, 4), 1);
  assert.strictEqual(C.cellAtLine(p.cells, 6), 2);
  assert.strictEqual(C.cellAtLine(p.cells, 99), -1);
  assert.strictEqual(C.cellAtLine([], 0), -1);
});

test('sameStructure: samme headerRaw-sekvens → true; endret antall/markør → false', () => {
  const a = C.parseCells('#%% python\nx = 1\n#%% md\nA').cells;
  const b = C.parseCells('#%% python\ny = 2\n#%% md\nB endret').cells;
  const c = C.parseCells('#%% python\nx = 1\n#%% html\nA').cells;
  const d = C.parseCells('#%% python\nx = 1').cells;
  assert.strictEqual(C.sameStructure(a, b), true);   // kun kropper endret
  assert.strictEqual(C.sameStructure(a, c), false);  // markørlinje endret
  assert.strictEqual(C.sameStructure(a, d), false);  // antall endret
});
```

- [ ] **Step 2: Run** `node --test tests/js/cells.test.js` — new tests FAIL.

- [ ] **Step 3: Implement** (after `C.slidePlan`):

```js
  // ---------- editor-konvergens (spec 2026-07-17-editor-convergence-design.md) ----------

  // Markørlinje → celleindeks: cellen hvis [startLine, endLine] inneholder
  // linjen. #%%-linjen tilhører sin egen celle (startLine = headerLine).
  // -1 utenfor dokumentet / tom celleliste.
  C.cellAtLine = function (cells, line) {
    for (var i = 0; i < cells.length; i++) {
      if (line >= cells[i].startLine && line <= cells[i].endLine) return i;
    }
    return -1;
  };

  // Forsonings-porten (spec §1 render/update-policy): samme antall celler
  // med samme headerRaw-sekvens → oppdater på plass; ellers full rebuild.
  C.sameStructure = function (a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i].headerRaw !== b[i].headerRaw) return false;
    }
    return true;
  };
```

- [ ] **Step 4: Run** — PASS (117 total). **Step 5: Commit** `feat(cells): cellAtLine + sameStructure — rene hjelpere for konvergert editor`

---

### Task 2: The document renderer core

**Files:**
- Modify: `js/cells.js` (DOM half): new `docRender()`/`docCellNode()`/`docBar()`; rewrite `C.enter`, `C.exit`, `render()`-dispatch, `cellElementAt`, `errorHost`, `runCell`'s slot lookup, `setRunningUi`, `renderCellResult` requery selector
- Modify: `app.css` (append `.doc-root`/`.doc-cell`/`.doc-bar` section)
- Test: `tests/js/cells-dom.test.js` (extend the stub env with `#outputArea`; new doc-renderer tests; REWRITE the cell-list-DOM-dependent tests that break, listing each in the report)

**Interfaces:**
- Consumes: pure half unchanged; existing DOM-half internals ported verbatim where named: `renderNonCode` (cells.js ~1300s), `purge`, `el`, `updateSessionChip`/`attachSessionListener`, `renderCellResult` internals, `_afterCellRun`.
- Produces: with a `#%%` document active, `C.enter()` builds `.doc-root` INSIDE `#outputArea` (never touches `.container` classes); `docCellNode` slots as spec §1; `C.cellElementAt(idx)` → the `.doc-cell` node; `C.errorHost()` → `.nb-trailing` at `.doc-root`'s end; `C.runCell/beginRun/sinkForSegment` operate on doc slots; `NB.docBar` hosts parse warnings + session chip + Restart-knappen. The OLD `render()`/`cellNode()` remain in the file but are no longer called from anywhere (verify by grep). Tasks 3-5 build on this.

- [ ] **Step 1: Failing stub-DOM tests** (extend `freshEnv` so `document.getElementById('outputArea')` returns a FakeEl attached under body — mirror how `scriptInputEl` is provided):

```js
// ---------- konvergert dokument (spec 2026-07-17, 4a Task 2) ----------

test('enter(): doc-root bygges i #outputArea; .container røres ikke; ingen nb-input', () => {
  const { C, scriptInputEl, outputAreaEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% md\n# Hei\n#%% python\nx = 1\n';
  C.init('python');
  assert.strictEqual(C.active(), true);
  const root = outputAreaEl.children.find((n) => n.classList.contains('doc-root'));
  assert.ok(root, 'doc-root i #outputArea');
  assert.ok(!containerEl.classList.contains('nb-hidden'), 'container-swappen er borte');
  const nodes = collectNodes(root, []);
  assert.ok(!nodes.some((n) => n.classList && n.classList.contains('nb-input')), 'ingen editor-halvdel');
  assert.ok(!nodes.some((n) => n.tag === 'textarea'), 'ingen celle-textareas');
  // md-cellen rendret, kodecellen har tomt sluk
  assert.ok(nodes.some((n) => n.classList && n.classList.contains('output-markdown')));
  const cell1 = nodes.find((n) => n.classList && n.classList.contains('doc-cell') && n.dataset.idx === '1');
  assert.ok(collectNodes(cell1, []).some((n) => n.classList && n.classList.contains('nb-output-body')));
});

test('cellElementAt/runCell/renderCellResult virker mot doc-slots', async () => {
  const { C, scriptInputEl, outputAreaEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 2\n#%% python\na + 3\n';
  C.init('python');
  const el1 = C.cellElementAt(1);
  assert.ok(el1 && el1.classList.contains('doc-cell'));
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = () => Promise.resolve({ text: '5' });
  await C.runCell(1);
  const body = collectNodes(el1, []).find((n) => n.classList && n.classList.contains('nb-output-body'));
  assert.strictEqual(body.textContent, '5');
});

test('htmlTrusted-gaten gjelder i dokumentet (delt lenke → eskapert + Vis HTML)', () => {
  const { C, scriptInputEl, outputAreaEl } = freshEnv();
  C.init('python');
  scriptInputEl.value = '#%% html\n<img src=x onerror="window.__pwned=1">\n';
  C.contentLoaded({ untrusted: true });
  const nodes = collectNodes(outputAreaEl, []);
  assert.ok(!nodes.map((n) => n.innerHTML).filter(Boolean).some((h) => h.includes('onerror')));
  assert.ok(nodes.some((n) => n.tag === 'button' && n.textContent === 'Vis HTML'));
});

test('beginRun/sinkForSegment/segmentDisplay mot doc-slots (Kjør alle-kontrakten)', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 1\n#%% duckdb\nselect 1\n';
  C.init('python');
  const plan = C.beginRun(['pyodide', 'duckdb']);
  assert.ok(plan !== null, 'planen justeres');
  assert.ok(C.sinkForSegment(0), 'sluk for segment 0');
  assert.deepStrictEqual(C.segmentDisplay(0), { explicit: true });
});

test('skip-celler utelates; hide-output skjuler wrapper; style-klasser følger med', () => {
  const { C, scriptInputEl, outputAreaEl } = freshEnv();
  scriptInputEl.value = '#%% skip\nx\n#%% md style=note\nA\n#%% python hide-output\ny = 1\n';
  C.init('python');
  const cells = collectNodes(outputAreaEl, []).filter((n) => n.classList && n.classList.contains('doc-cell'));
  assert.strictEqual(cells.length, 2, 'skip-cellen rendres ikke');
  assert.ok(cells[0].classList.contains('nb-style-note'));
  assert.ok(cells[1].classList.contains('nb-hide-output'));
});

test('exit() fjerner doc-root og gjenoppretter plain-oppførsel', () => {
  const { C, scriptInputEl, outputAreaEl } = freshEnv();
  scriptInputEl.value = '#%% python\nx = 1\n';
  C.init('python');
  C.exit();
  assert.strictEqual(C.active(), false);
  assert.ok(!outputAreaEl.children.some((n) => n.classList.contains('doc-root')));
});
```

- [ ] **Step 2: Run** — new tests FAIL (and note which PRE-EXISTING cells-dom tests fail because they assert `.nb-input`/nb-root: list them; they are rewritten in Step 4).

- [ ] **Step 3: Implement the renderer**

New code in the DOM half (placed before the old `render()`); the old `render`/`cellNode`/`buildToolbar` stay but every caller is repointed:

```js
    // ---------- konvergert dokument (spec 2026-07-17 §1) ----------
    // Dokumentet rendres INN I #outputArea (doc-root); .container beholder
    // sine layoutklasser (nb-hidden-swappen er død). Slots beholder
    // .nb-cell/.nb-output/.nb-output-body-klassene med vilje: ParamForms/
    // Ui/dash/ipywidgets finner vertene sine uendret via cellElementAt.

    function docHost() { return document.getElementById('outputArea'); }

    function docBar(parsed) {
      var bar = el('div', 'doc-bar');
      if (parsed.warnings.length) bar.appendChild(el('span', 'nb-warnings', parsed.warnings.join(' · ')));
      var sessionChip = el('span', 'nb-session-chip');
      NB.sessionChip = sessionChip;
      bar.appendChild(sessionChip);
      var restartBtn = el('button', 'nb-restart-btn', t('Restart & kjør alle'));
      restartBtn.type = 'button';
      restartBtn.addEventListener('click', onRestartClick);
      NB.restartBtn = restartBtn;
      bar.appendChild(restartBtn);
      return bar;
    }

    function docCellNode(c, idx) {
      var type = C.resolveType(c, NB.docMode);
      var wrap = el('div', 'nb-cell doc-cell');
      wrap.dataset.idx = String(idx);
      if (c.attrs.style && /^(note|warn|card)$/.test(c.attrs.style)) wrap.classList.add('nb-style-' + c.attrs.style);
      if (c.attrs['hide-output']) wrap.classList.add('nb-hide-output');
      var out = el('div', 'nb-output');
      var widgetsPos = WIDGETS_POS[c.attrs.widgets] ? c.attrs.widgets : 'top';
      out.classList.add('nb-widgets-' + widgetsPos);
      var body = el('div', 'nb-output-body');
      out.appendChild(body);
      if (!C.isCodeType(type)) {
        wrap.classList.add('nb-rendered-only');
        renderNonCode(body, type, C.renderContent(c.source, type, c.sniffed));
      }
      wrap.appendChild(out);
      c._out = body;
      c._wrap = wrap;
      var paramLang = C.paramLangForType(type);
      if (paramLang && global.ParamForms && typeof global.ParamForms.decorate === 'function') {
        global.ParamForms.decorate(idx, wrap, c.source, paramLang);
      }
      return wrap;
    }

    function docRender() {
      var ta = $('scriptInput');
      var parsed = C.parseCells(ta.value);
      NB.cells = parsed.cells;
      NB.lastSerialized = ta.value;
      NB.plan = C.segmentPlan(ta.value, NB.docMode);
      NB.runSinks = null; NB.runPlan = null; NB.trailing = null;
      NB.stale = {}; NB.ranOk = {};
      var host = docHost();
      if (!host) return;
      if (NB.root) { purge(NB.root); NB.root.remove(); }
      NB.root = el('div', 'doc-root');
      host.innerHTML = '';
      host.appendChild(NB.root);
      NB.root.appendChild(docBar(parsed));
      attachSessionListener();
      updateSessionChip();
      for (var i = 0; i < NB.cells.length; i++) {
        var type = C.resolveType(NB.cells[i], NB.docMode);
        if (type === 'skip') continue;               // spec §1: skip rendres ikke
        NB.root.appendChild(docCellNode(NB.cells[i], i));
      }
      // presentasjons-overlevelse: samme hale som gamle render() (gjenbruk
      // den eksisterende NB.present-blokken uendret, mot doc-cellene).
    }
```

Rewire (each change small and named):

- `C.enter` — drop the `.container` `nb-hidden` add and the sibling insert; `NB.root` lives in `#outputArea` via `docRender()`. The MutationObserver enhance-hook moves to `.doc-root` creation.
- `C.exit` — remove `.doc-root` from `#outputArea` (restore empty output area), skip the layout mirroring back-compat (layout never changed), keep `flushPendingEdit` no-op-safe, presentExit first (unchanged).
- `render()` callers (`refreshFromScript`, `contentLoaded`, `setLayout`, structural ops, `grantHtmlTrust`) → `docRender()`.
- `cellElementAt` → query `.doc-cell[data-idx]` under `NB.root`.
- `renderCellResult`'s requery selector → `.doc-cell[data-idx="…"] .nb-output-body`.
- `setRunningUi`/`markStaleIfRan`/`clearAllStale`/`_afterCellRun` → toggle `.nb-running`/`.nb-stale` on `c._wrap` (the doc-cell) instead of `c._input`.
- `errorHost` → `.nb-trailing` appended to `NB.root` (unchanged logic).
- The present block in the old `render()` tail: move into `docRender()`'s tail unchanged (present classes now land on doc-cells; visibility keying via `byCell` is index-based and works — skip-cells have no node: `presentApply` already guards `c._wrap`).
- KEEP the old functions in place (unreachable); add one comment at old `render()`: `// DØD ETTER 4a — fjernes i plan 4b (spec §5).`

app.css append:

```css
/* ---------- konvergert dokument (spec 2026-07-17) ---------- */
.doc-root { padding: 4px 8px; }
.doc-bar { display: flex; align-items: center; gap: 10px; padding: 2px 0 8px;
  font-size: 12px; color: var(--text-muted); }
.doc-cell { padding: 2px 0; }
.doc-cell.nb-running { outline: 2px solid color-mix(in srgb, var(--accent) 35%, transparent); }
.doc-cell.nb-stale { opacity: .75; }
```

- [ ] **Step 4: Rewrite broken cell-list tests** — for each pre-existing cells-dom test that asserted `.nb-input`/textarea/nb-root placement, rewrite the assertion against the doc renderer when the INTENT survives (html-trust tests, runCell slot-isolation tests, session-chip tests) and DELETE only tests whose sole subject is the removed editor half (toolbar ops, autoSize, onSrcKeydown, dblclick-edit) — those behaviors are gone by design (decision 2); list every rewrite/delete in the report. Presentation tests: adapt `nbRoot()` helper to find `.doc-root`.

- [ ] **Step 5: Run** `node --test tests/js/cells-dom.test.js` → all pass; full node suite → only 4 known ENOENT. **Step 6: Commit** `feat(cells): konvergert dokumentrenderer — doc-root i #outputArea, slots uten editor-halvdel, seams bevart`

---

### Task 3: Reconciliation + `updateCellSource` + edit flow

**Files:**
- Modify: `js/cells.js` — `docRender` gains reconcile mode; the tick/edit path (`refreshFromScript`, tick auto-open, `updateCellSource`)
- Test: `tests/js/cells-dom.test.js` (append)

**Interfaces:**
- Consumes: `C.sameStructure` (Task 1), Task 2's renderer.
- Produces: editing `#scriptInput` re-renders debounced (250ms via the existing tick machinery); same structure → in-place update (changed md/html bodies re-rendered; changed code cells get `.nb-stale`; untouched cells' slots and OUTPUTS survive); structure change → full `docRender()`. `C.updateCellSource(idx, newSource)` splices the cell's body lines inside `#scriptInput.value` (using `startLine`/`hasBody`/`endLine`), updates `NB.cells[idx].source`, syncs the tick baseline, and triggers the reconcile — the ParamForms.writeValue seam.

- [ ] **Step 1: Failing tests**

```js
test('forsoning: kropps-endring i md re-rendrer cellen; kode-endring gir stale; output overlever', async () => {
  const { C, scriptInputEl, outputAreaEl, tick } = freshEnv();
  scriptInputEl.value = '#%% md\n# En\n#%% python\nx = 1\n';
  C.init('python');
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = () => Promise.resolve({ text: 'ok' });
  await C.runCell(1);
  scriptInputEl.value = '#%% md\n# To\n#%% python\nx = 2\n';
  C.refreshFromScript();
  const nodes = collectNodes(outputAreaEl, []);
  const md = nodes.find((n) => n.classList && n.classList.contains('output-markdown'));
  assert.ok((md.innerHTML || md.textContent).includes('To'), 'md re-rendret');
  const cell1 = nodes.find((n) => n.classList && n.classList.contains('doc-cell') && n.dataset.idx === '1');
  assert.ok(cell1.classList.contains('nb-stale'), 'kodecellen stale');
  const body1 = collectNodes(cell1, []).find((n) => n.classList && n.classList.contains('nb-output-body'));
  assert.strictEqual(body1.textContent, 'ok', 'outputen overlevde forsoningen');
});

test('forsoning: strukturendring → full rebuild (output borte, stale nullstilt)', async () => {
  const { C, scriptInputEl, outputAreaEl } = freshEnv();
  scriptInputEl.value = '#%% python\nx = 1\n';
  C.init('python');
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = () => Promise.resolve({ text: 'ok' });
  await C.runCell(0);
  scriptInputEl.value = '#%% python\nx = 1\n#%% md\nny celle\n';
  C.refreshFromScript();
  const cell0 = collectNodes(outputAreaEl, []).find((n) => n.classList && n.classList.contains('doc-cell') && n.dataset.idx === '0');
  const body0 = collectNodes(cell0, []).find((n) => n.classList && n.classList.contains('nb-output-body'));
  assert.strictEqual(body0.textContent, '', 'rebuild tømmer slots (ærlig reset)');
});

test('updateCellSource: splicer #scriptInput, forsoner, bevarer resten av dokumentet', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\nn = 3 #@param\n#%% md\nA\n';
  C.init('python');
  C.updateCellSource(0, 'n = 7 #@param');
  assert.strictEqual(scriptInputEl.value, '#%% python\nn = 7 #@param\n#%% md\nA\n');
  assert.strictEqual(C.parseCells(scriptInputEl.value).cells[0].source, 'n = 7 #@param');
});
```

- [ ] **Step 2: FAIL run.** **Step 3: Implement** — `docReconcile(parsed)`: when `C.sameStructure(NB.cells, parsed.cells)`, per index: transfer `_out`/`_wrap` refs onto the fresh cell objects, re-render noncode bodies whose `source` changed, `markStaleIfRan(idx)` for code cells whose `source` changed, refresh `ParamForms.decorate` for changed cells, update `NB.cells = parsed.cells` + `NB.plan`; else `docRender()`. `refreshFromScript`/tick route through it. `updateCellSource(idx, newSource)`: rebuild the document text via lines-splice (body span from `startLine`/`headerRaw`/`endLine` — reuse the exact splice logic the old implementation used, repointed at `#scriptInput` instead of the cell textarea), set `#scriptInput.value`, `C.syncTickBaseline()`, then reconcile. **Step 4: PASS + full suite. Step 5: Commit** `feat(cells): forsonings-policy + updateCellSource mot #scriptInput — outputs overlever kroppsredigeringer`

---

### Task 4: Five-view menu + presentation re-host

**Files:**
- Modify: `index.html` — `#viewModeMenu` labels (Rad/Kolonne), `initViewModeDropdown` (notebook branch collapses into the app primitives), `C.setLayout` callers
- Modify: `js/cells.js` — `setLayout` delegates to `mdSetLayoutMode`/`mdSetInputHidden` (nb-layout classes die from the ACTIVE path), present re-host (`nb-present` on `.doc-root`; `body.present-active` CSS additionally hides `.panel-left`/`#resizer`)
- Modify: `app.css` — present-selector updates (`.doc-root.nb-present`), `body.present-active .panel-left, body.present-active #resizer { display: none; }`
- Modify: `js/i18n/en.js` — "Rad": "Row", "Kolonne": "Column" (+ dropdown title key update)
- Test: `tests/js/cells-dom.test.js` (adapt present tests to doc-root; new: setLayout delegates to app primitives)

**Interfaces:**
- Consumes: Tasks 2-3.
- Produces: one layout system: the menu drives `mdSetLayoutMode`/`mdSetInputHidden` for BOTH plain and notebook documents; `Cells.setLayout(v)` becomes a thin delegate (kept for compat, used by the menu's notebook branch); presentation works on the converged document exactly as phase 2 specified (nav, counter, Esc, directive auto-start).

Steps follow the established pattern: adapt tests (present suite's `nbRoot` helper → `.doc-root`; new delegation test asserting `mdSetLayoutMode` called), implement, run, commit `feat(visning): femvisningsmenyen på app-primitivene + presentasjon re-hostet på dokumentet`. The `viewModeBtn` title and labels: `Rad`, `Kolonne`, `Kun output / dashboard`, `Skrittvis`, `Presentasjon`; setActive init mapping unchanged (`stacked`→Rad etc. — keep data-view values `stacked`/`columns` so persisted state survives).

---

### Task 5: Browser exit gate 4a

**Files:**
- Modify: `docs/superpowers/specs/2026-07-17-editor-convergence-design.md` (status: 4a DELIVERED)
- Test: browser sweep; report `.superpowers/sdd/task-ec4a-5-report.md`
- Modify: `index.html` `js/cells.js?v=` bump + `sw.js` CACHE bump

Sweep (serve + Playwright; hybrid document with python+duckdb+md+html+sniffed+`#tag`-typed cells; record PASS/FAIL each):

1. Notebook document loads → document renders in `#outputArea`, editor stays live in panel-left, NO cell textareas anywhere; Rad/Kolonne/Kun output switch panes correctly.
2. Kjør alle → outputs land in the right slots (python, duckdb, microdata-fri dokument OK); trailing/error host works (provoke an error).
3. Editing an md cell body → document re-renders that cell only (output slots of other cells survive); adding a `#%%` → honest rebuild.
4. `ui.*` widgets in a cell + `#@param` form + dash cell + ipywidgets cell → all mount into their slots; `#@param` edit → writeValue → `#scriptInput` text updates (updateCellSource seam) and rerun works.
5. R notebook document: Kjør alle + per-celle-knappløs kjøring via Ctrl+Enter is 4b — here verify Kjør alle + widgets (registerFromRegistry per segment) land in doc slots.
6. brython/micropython notebook: Kjør alle loop (engineRunPlan → runCell) renders into doc slots.
7. Share link (untrusted): html/sniffed-html cells escaped with Vis HTML in the document; trust click → live.
8. Presentation: menu + `#options.view = present` on the converged document (slides = doc-cells, editor hidden, Esc restores).
9. Skrittvis: runs unchanged (exits doc view? — verify the forklar entry still behaves; it calls Cells.exit()).
10. Plain script regression: no `#%%` → byte-identical behavior incl. phase 3 doc widgets; mode switches; examples menu.
11. Session chip + Restart & kjør alle from the doc-bar; parse warnings visible there.
12. Both themes.

Then suites (full node + pytest baselines), spec status `**Status 4a:** DELIVERED <date>`, commit `feat(cells): konvergert dokument verifisert — exit gate 4a`.
