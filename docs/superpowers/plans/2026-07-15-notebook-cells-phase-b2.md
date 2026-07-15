# Notebook Cells — Phase B2 Implementation Plan (siste fase av spec 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec 1 §6 Phase B2 — the remaining notebook features: the cell hover-toolbar (add/delete/move/change type/split/merge as text transforms), skrittvis cell playback, true R session reset at Restart, dash per-slot cleanup for per-cell reruns of python dashboard cells, `#options.display = last` for unmarked scripts — plus the accumulated small-fix queue from the W-phase reviews.

**Architecture:** Everything builds on established machinery. Toolbar ops are the spec §1 text-transform table applied via `Cells.updateCellSource`-style model+serialize discipline (structural ops go through a full re-render — that's correct and cheap). Skrittvis playback maps forklar's step engine onto cells (cells are better blocks than blank-line groups). R reset mirrors the spec note (`rm(list=ls())` + `DashWebR.reset()` before rerun). Dash per-slot cleanup uses dash.js's existing `!root.isConnected` lazy sweep — the per-cell path just needs to purge the slot BEFORE the rerun so the sweep sees disconnected roots.

## Global Constraints

- Text is canonical: every toolbar op is a serializable text transform (spec §1 table); undo story = the op is visible in Rå tekst; no op may corrupt round-trip guarantees (reuse parse/serialize, never string-hack).
- No behavior change for plain scripts; skrittvis on plain scripts unchanged (blank-line blocks).
- R dashboard cells per-cell run: IF the DashWebR registry can be scoped per-cell cheaply, do it; if it requires restructuring dash-webr.js, keep the existing notice and DOCUMENT (parity-not-straitjacket applies). The implementer investigates first and reports the call.
- Style/test/commit conventions as before. Baselines: node 364/4 pre-existing; pytest 677; facades 478.
- The follow-up queue items included in this phase: (a) `C.exit` flushes the pending edit debounce before switching to Rå tekst (≤250 ms typing loss); (b) numeric dropdown typing in `#@param [1,2,3]` (infer per-item literals); (c) cache-busting `?v=` on the brython/micropython engine script tags; (d) key-collision hardening: `cellKeyAt` prefixes id-derived keys (`'#'+id`) to avoid id='3' vs idx-3 collision (migration: none needed, stores reset per document).

---

### Task 1: cell hover-toolbar — structural ops

**Files:** Modify `js/cells.js`, `app.css`; Test `tests/js/cells-dom.test.js` + pure tests in `tests/js/cells.test.js`

- Pure half additions (node-tested): `C.insertCellAfter(cells, idx, type) → newCells` (new `#%% <type>` header + blank body), `C.deleteCell(cells, idx)`, `C.moveCell(cells, idx, dir)`, `C.changeCellType(cells, idx, newType)` (rewrite header line preserving attrs), `C.splitCell(cells, idx, lineOffset)`, `C.mergeWithPrevious(cells, idx)` — all returning new cell arrays whose `serializeCells` output is the intended text (round-trip tests for each op incl. attr preservation on type change, preamble edge cases, first/last-cell boundaries).
- DOM half: hover toolbar (`.nb-tools`, appears on cell hover/focus-within): ▶ (exists), + over/under, ↑ ↓, 🗑 (with a 2-second angre-toast instead of a confirm dialog — less friction, text is canonical anyway), type-dropdown (the known types), split-at-cursor (uses the textarea's selectionStart→line), merge-op. Each op: apply pure transform → serialize → `#scriptInput` → full `render()` (structural = rebuild, focus restored to the affected cell's textarea). Keyboard: no new shortcuts in B2 (deferred).
- Widget-state note: structural ops shift indexes — id-tagged cells keep values (W2 keys); index-keyed cells lose them (documented, spec'd behavior).

- [ ] Pure tests first; DOM tests (op → resulting #scriptInput text + focus target); implement; suites green.
- [ ] Commit `feat(cells): celle-verktøylinje — add/delete/move/type/split/merge som teksttransformer`.

### Task 2: skrittvis cell playback

**Files:** Modify `index.html` (forklar block-splitting seam), `js/cells.js` if a helper is needed

- Investigate `buildForklarFlatWork`/`splitMicrodataExplainSections` (~index.html:6390s): when the document is a NOTEBOOK (hasMarkers) and forklar starts, split on CELLS instead of blank lines: each code cell = one block (its comments still narrated per the existing comment-extraction), md cells = narration-only steps (read the md text aloud, render nothing new), skip cells skipped. Plain scripts keep today's blank-line behavior exactly.
- The forklar dock/highlight machinery stays; the highlight range = the cell's line span (already available via cell spans).
- [ ] Implement; browser-verify: notebook → Kjør skrittvis → steps follow cells, md narrated, highlight per cell; plain script unchanged.
- [ ] Commit `feat(cells): skrittvis spiller av celle for celle i notatbøker`.

### Task 3: ekte R-sesjonsreset + dash per-slot cleanup

**Files:** Modify `index.html`, possibly `js/dash.js`/`js/dash-webr.js` (investigate-first)

- R reset: in the r-mode branch of `nbEnsureSession`/Restart (the B1 F4 early-return), on `restart()` in r-mode: `webR.evalRVoid('rm(list = ls(envir = globalenv()), envir = globalenv())')` + `DashWebR.reset()` + `__uiResetR()` before the rerun; update spec note (B2 promise delivered). Verify `# load`-bound data re-binds on the subsequent Run All (it does — runHybridR re-binds per run).
- Dash per-slot cleanup (python): per-cell rerun of a cell that created a dashboard — `renderCellResult` already purges the slot DOM; verify dash.js's lazy `!isConnected` sweep then releases the old registry entry on the NEXT create, and that pyodide dash.py's `_reap()` releases proxies. If a per-cell rerun WITHOUT a new dashboard leaves a dead registry entry until the next create: add a guarded `window.Dash && Dash.sweepDisconnected && Dash.sweepDisconnected()` call after slot purge (export the existing sweep as a small API if it's inline). Browser-verify: dash cell rerun ×3 → one live dashboard, registry stable.
- R dashboard cells per-cell: INVESTIGATE (constraint above): can `.dash_run`-scoped rerun work per-cell without global reset? If yes (cheap), wire it and remove the notice; if no, keep notice + document the call in the report.
- [ ] Commit(s): `feat(cells): ekte R-sesjonsreset ved Restart` + `fix(dash): per-slot-opprydding ved per-celle-rerun` (+ evt. R-dash-beslutningen).

### Task 4: display=last for unmarked + the small-fix queue

**Files:** Modify `index.html`, `js/cells.js`, `js/param-forms.js`, `js/ui.js` (key prefix)

- `#options.display = last`: extractScriptOptions already parses; wire it so an UNMARKED script with the option gets `_nb`-style last-only display (echo follows show_commands) — the exec core supports the flags; the gate today requires Cells.active(); add the option-driven path (small, mirrors the display=all escape).
- Small fixes: (0) slett død kode `splitMicrodataExplainSections` + `buildForklarFlatWork` i index.html (null kallsteder, bekreftet i B2 T2-review); (a) `C.exit()` flushes pending edit debounce first; (b) `#@param [1,2,3]` numeric options — parse per-item literals, write back unquoted numerics (tests); (c) `?v=` cache-busting on brython/micropython engine script tags (match the repo's existing versioning param convention); (d) `cellKeyAt` id-prefix `'#'` + adjust consumers/tests.
- [ ] Tests for each; suites green.
- [ ] Commit `fix: B2-småfikser — display=last for umarkerte, exit-flush, numeriske #@param-options, cache-busting, nøkkelprefiks`.

### Task 5: exit gate

- [ ] Full suites; abridged browser sweep: toolbar ops (all seven) with round-trip checks via Rå tekst; skrittvis on the widgets example; Restart in R-mode actually clears `.GlobalEnv` (verify a variable is gone); dash-cell rerun stability; display=last unmarked script; plain-script + share-link regression; both themes on the toolbar.
- [ ] Spec 1 §6: mark B2 done (list what shipped; note the R-dash decision from Task 3). README one-line touch if warranted.
- [ ] Commit `docs+test(cells): fase B2 exit gate`.

### Task 4b: dash mount-to-slot (render-target-fullføringen for dashboards)

**Files:** Modify `js/dash.js` (mount-rot-valg), `index.html` if seam needed

- Found in Task 3: python dash-celler i notatbok-visning rendrer inn i det SKJULTE `#outputArea` (dash v2 skriver DOM dit direkte under kjøring). Spec 1 §5/§6 lover «full render-target threading incl. dashboards» i B2.
- Fix: `D.create`/mount-roten velger den kjørende cellens output-slot når notatbok-kontekst finnes — les `window.mdUiRunCtx()` (samme kontekst ui bruker) guarded; fallback `#outputArea` som i dag. Per-celle rerun: sloten purges allerede + sweepDisconnected (Task 3) → én levende dash per celle. Run All: segment-konteksten er satt (B1/W1-bracketene) → dash havner i riktig celle også der.
- Verify: browser — dash-celle i notatbok: dashboard SYNLIG i cellens slot; rerun ×3 stabil; plain script dash uendret (ingen ctx → outputArea); dash i to ulike celler samtidig → hver i sin slot; R-dash uendret (mount går via dash-webr til outputArea — kun python-stien endres, dokumenter).
- [ ] Commit `feat(dash): dashboards monteres i cellens slot i notatbøker (render-target-fullføring)`.
