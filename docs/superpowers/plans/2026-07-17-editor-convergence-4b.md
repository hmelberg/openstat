# Editor Convergence 4b — Partial Execution + Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cursor-run (Ctrl/Cmd+Enter, Shift+Enter), selection run, the gutter ▶, cursor↔slot coupling, then the cell-list island removal — per `docs/superpowers/specs/2026-07-17-editor-convergence-design.md` §§2, 5 (plan 4a delivered §§1/3/4 and is merged).

**Architecture:** The editor side lives in index.html (the `#scriptInput` keydown handler + a cursor-tracker) with pure helpers in js/cells.js (`C.cellAtLine` exists; new `C.selectionCellSpan`). Runs go through the existing `Cells.runCell(idx)`/`mdRunNotebookCell`; selection runs thread the selected text through a new `selText` payload field. The gutter ▶ rides the existing `#lineNumbers` delegated-click gutter. Slot coupling toggles `.doc-active` on `.doc-cell` wrappers. Finally the dead cell-list island + its CSS/tests are deleted per the §5 checklist (extended by the 4a final review).

**Tech Stack:** ES5 var-style JS (index.html, js/cells.js), app.css, node test runner; browser exit gate before AND after removal.

## Global Constraints

- **4b opening requirement (4a final review, Important 1)**: fix the `updateCellSource` stale-span race BEFORE anything else (Task 1).
- Plain scripts: Ctrl+Enter keeps today's whole-script behavior; Shift+Enter stays unbound; no gutter ▶; zero behavioral delta.
- `mdRunNotebookCell` contract may gain ONE optional field (`selText`) — everything else unchanged.
- Selection runs use the cell display policy (`nb:{echo:false,last:true}`), output to the enclosing cell's slot; selections spanning cells or inside md/html → status notice, no run.
- Skrittvis untouched. htmlTrusted untouched. ES5/Norwegian/`t()`+en.js.
- Baselines at plan start: cells-dom 85, cells 117, ui-dom 70, param-forms-dom 43, full node 538/542 (4 known ENOENT), pytest 1247 + 1 known error.
- ANY index.html inline-script change gets a browser smoke IN THE SAME TASK (the 4a scoping lesson — node --check is insufficient). Cross-IIFE calls always via `window.md*`.

---

### Task 1: The updateCellSource stale-span race (4a Important 1)

**Files:** Modify `js/cells.js` (`C.updateCellSource`), `js/param-forms.js` (`_commit`); Test `tests/js/cells-dom.test.js`, `tests/js/param-forms-dom.test.js` (append)

**Interfaces:** Produces a reconcile-first `updateCellSource`: if `$('scriptInput').value !== NB.lastSerialized`, run the reconcile (`docReconcile`/full render path used by tick) FIRST so `NB.cells` spans are fresh, THEN splice. In js/param-forms.js `_commit`: after the reconcile-aware splice, re-sync `st.source` from the live cell (`Cells`' fresh parse) rather than trusting the pre-edit copy — read `_commit` and `writeValue` first; the minimal correct change is to call `ParamForms.syncSource(cellIdx, <fresh cell source>)` after `updateCellSource` returns, or have `updateCellSource` return the fresh source and `_commit` use it.

- [ ] Step 1: failing test — cells-dom: init doc `'#%% python\nn = 3 #@param\n#%% md\nA\n'`; run cell 0 (stub run); simulate an UNRECONCILED user edit by setting `scriptInputEl.value = '# ny linje\n#%% python\nn = 3 #@param\n#%% md\nA\n'` WITHOUT calling refresh/tick; then `C.updateCellSource(1, 'n = 7 #@param')` (index 1 = the python cell in the NEW text — but NB.cells still has it at 0: the test asserts the API reconciles first so callers pass the CURRENT index... NOTE: ParamForms passes the index it captured at decorate time, which predates the edit. The contract to pin: updateCellSource reconciles FIRST, then resolves the target cell by the caller's index INTO THE FRESH PARSE — a caller holding a stale index gets the fresh cell at that index, and ParamForms' indices are refreshed by the reconcile's syncSource pass before _commit can fire again. The minimal safe assertion: after the call, `scriptInputEl.value` contains BOTH `'# ny linje'` AND `'n = 7 #@param'` and the md cell is intact — no corruption, no reverted keystrokes.)
- [ ] Step 2: implement (reconcile-first guard in updateCellSource; `_commit` source re-sync), run all four suites + full.
- [ ] Step 3: commit `fix(cells): updateCellSource forsoner først — stale-span-racet fra 4a-sluttreviewen tettet`

---

### Task 2: Cursor-run, Shift+Enter, selection run

**Files:** Modify `index.html` (the `#scriptInput` keydown handler ~5283-5324; `mdRunNotebookCell`'s pyodide/duck/microdata branch for `selText`; R + engine branches likewise), `js/cells.js` (pure `C.selectionCellSpan`; DOM-half `C.runSelection(idx, selText)`), i18n; Test cells.test.js + cells-dom.test.js + browser smoke (same task)

**Interfaces:**
- `C.selectionCellSpan(cells, startLine, endLine, docMode)` (pure) → `{idx}` when the whole span lies inside ONE code cell's body (header line excluded), else `{error: 'span'|'noncode'|'outside'}`.
- `C.runSelection(idx, selText)` (DOM half) → Promise; mirrors `runCell` but payload gains `selText` (tag-blanked selection) and skips the dash-purge branch.
- `mdRunNotebookCell`: when `payload.selText` is a non-empty string, the EXECUTED code for the target cell is `selText` instead of the cell body. **Verify-first fact**: the hybrid family (pyodide/duckdb/microdata) branch may re-derive the cell's code from the document text via the aligned plan rather than using `payload.text` — READ index.html ~9785-9800 and thread `selText` into whatever the branch actually executes for the target segment. R (`runNotebookRCell`) and engines (`runNotebookEngineCell`) use `payload.text`/`payload.selText` directly — verify each.
- Keydown (notebook active only): Ctrl/Cmd+Enter → selection non-empty ? selection-run flow : `Cells.runCell(cellAtLine(cursorLine))`; md/html cell → `Cells.rerenderCell(idx)` (re-render just that cell's body — small new export, reuse the reconcile's noncode re-render); preamble → `runCell(0)` if preamble exists in plan, else notice. Shift+Enter → run + move cursor to next code cell's first body line (`selectionStart/End` + scroll). Plain script: existing behavior untouched (guard on `Cells.active()`).
- Notices (t() + en.js): `'Merk tekst innenfor én kodecelle for å kjøre et utvalg'`, `'Markøren står utenfor cellene'`.

Steps: pure tests for `selectionCellSpan` (inside body ok; includes header line → error; spans two cells → error; md cell → noncode; preamble body ok when code) → implement → DOM tests for runSelection payload (`selText` present, cellIdx right, display policy) → keydown wiring in index.html → **browser smoke in this task**: python doc, cursor in cell 2 Ctrl+Enter runs only it; selection of two lines runs them into that slot; Shift+Enter advances; plain script Ctrl+Enter still whole-run. Commit `feat(editor): markør- og seleksjonskjøring — Ctrl/Cmd+Enter, Shift+Enter, selText-payload`.

---

### Task 3: Gutter ▶ + cursor↔slot coupling

**Files:** Modify `index.html` (cursor tracker + gutter class + gutter click branch beside the breakpoint handler ~1371-1387), `js/cells.js` (`C.setActiveCell(idx)` toggling `.doc-active`; slot-click → `window.mdJumpToCell(idx)` hook), `app.css` (gutter-run ▶ styling, `.doc-cell.doc-active` highlight); Test cells-dom + browser smoke (same task)

**Interfaces:**
- index.html cursor tracker: `selectionchange` on document (guard `document.activeElement === scriptInput`) + `keyup`/`click` fallbacks, debounced ~100ms → line via `value.slice(0, selectionStart).split('\n').length - 1` → `C.cellAtLine(NB-cells-from-Cells.parse? — expose `C.activeCells()` getter or reuse `Cells.cellAtLineInDoc(line)` wrapper reading NB.cells)` → `window.mdSetActiveCellLine(idx, firstLine)`: adds `gutter-run` class to `#lineNumbers span[data-line=firstLine+1]` (1-based spans — verify), removes from previous; calls `Cells.setActiveCell(idx)`.
- `C.setActiveCell(idx)`: toggles `.doc-active` on the doc-cell wrappers; `scrollIntoView({block:'nearest'})` on change; idempotent; null → clear.
- Gutter click on the ▶ line (the active cell's first line): run the active cell — extend the existing delegated `#lineNumbers` click handler: if the clicked span has `gutter-run` → `Cells.runCell(activeIdx)`; else existing breakpoint toggle.
- Slot click→cursor: in `docCellNode`, a click listener on the wrapper (ignore clicks on `input/button/select/textarea/a`, `.ui-controls`, `.param-form`, `.dash`) → `window.mdJumpToCell(idx)` (index.html): set `selectionStart/End` to the cell's first body line start, focus, scroll editor.
- CSS: `.line-numbers span.gutter-run::after { content:'▶'; ... }` (or replace number on hover), `.doc-cell.doc-active { outline/left-border accent }`, both themes.

Browser smoke in-task: cursor movement updates ▶ + slot highlight; gutter ▶ click runs; slot click jumps cursor; breakpoints still toggle on other lines. Commit `feat(editor): gutter-▶ for aktiv celle + markør↔slot-kobling`.

---

### Task 4: §5 removal + cleanup checklist

**Files:** Modify `js/cells.js` (delete the island), `app.css`, `js/i18n/en.js`, `index.html` (stale comments), tests; run everything.

Delete (verify each unreferenced first, then remove): `render()`, `cellNode()`, `buildToolbar()`, `commitStructuralOp`, `showUndoToast`/`hideUndoToast`, `onEdit`/`doFlush`/`flushPendingEdit`'s pending machinery (keep a no-op `flushPendingEdit` ONLY if live callers remain — check `runCell`/`exit`), `onSrcKeydown`, `focusNextCodeCell`, `autoSize`/`autoSizeAll`, `NB.rawOverride` + tick auto-open chip remnants (`updateChip` — check what remains of it: the chip UI is gone with the nb-bar; keep the session-invalidation parts of tick), `setNbButtonsDisabled`'s dead `_runBtn/_toolEls` loop. CSS: `.nb-input`, `.nb-src`, `.nb-head`, `.nb-tools`, `.nb-edit-btn`, `.nb-raw-btn`, `nb-layout-*`, hint-chip, undo-toast; the `.nb-root` half of present selectors. en.js: orphaned title key + any keys only used by deleted UI (Rå tekst, toolbar titles — grep each in the codebase before removing). index.html: stale `#notebookRoot`/nb-hidden comments. cells.js stale decorate comment (~2005). Redundant docRender MutationObserver (observe `#outputArea` once instead — or drop, since index.html already observes it: VERIFY then delete). `reattachDocStrips` guard: skip reattach when `Cells.active()` (js/ui.js — the 4a-review Minor). Tests: delete/adjust any test referencing removed internals; full suite green at NEW baseline (record counts).

Commit `feat(cells): cellelisten fjernet — §5-sjekklisten komplett (island, CSS, i18n, observer, reattach-guard)`.

---

### Task 5: Browser exit gate 4b + regression matrix

Re-run the 4a 16-row matrix PLUS: 17 cursor-run per cell type (code/preamble/md/duckdb/#tag-typed); 18 Shift+Enter chain through the document; 19 selection runs (valid, cross-cell → notice, md → notice); 20 gutter ▶ (single symbol, follows cursor, click runs; breakpoints coexist); 21 slot highlight + click-to-jump; 22 stale tint on slot after edit; 23 plain-script regression AGAIN (keybindings unchanged, no gutter); 24 both themes on gutter/highlight. Suites; spec `**Status 4b:** DELIVERED <date>` + mark phase 4 complete in the spec header; cache bumps (cells.js ?v=, sw v23); commit `feat(editor): fase 4 komplett — delvis kjøring verifisert, celleliste fjernet`.
