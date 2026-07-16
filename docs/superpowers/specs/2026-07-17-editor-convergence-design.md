# Editor convergence — one raw editor, one rendered document (design)

Phase 4 of the unified document model
(`2026-07-16-unified-document-model-notes.md` §1 and §6.4; decisions 1,
2, 4, 5 — all resolved by Hans 2026-07-16). The largest phase: it
replaces the Jupyter-style cell-list renderer with the target model and
REMOVES the cell-list once the replacement is verified (decision 1).

## Summary

**The editor is ALWAYS `#scriptInput` (raw text). The document is a
rendered view in `#outputArea`.** `#%%` is structure in the text, not
separate editor boxes. Concretely:

1. **The converged document renderer**: when a notebook document is
   active, `.container` stays visible; the document (rendered md/html,
   per-cell output slots, widget/param strips) renders INTO
   `#outputArea` (panel-right). The `.container`-swap to a sibling
   `#notebookRoot` is abandoned; the per-cell editors (`.nb-input`,
   `.nb-src` textareas, `.nb-head`, `.nb-tools` toolbar, ✎/dblclick
   affordances, «Rå tekst») cease to exist — plain text editing in
   `#scriptInput` covers every cell operation (decision 2).
2. **Partial execution**: Ctrl/Cmd+Enter in the editor runs the cell
   containing the cursor against the live session; Shift+Enter runs and
   advances; a marked selection runs just the selection into the
   enclosing cell's slot; Kjør runs everything (no separate button).
3. **Gutter ▶** on the ACTIVE cell only (decision 5) — one symbol in the
   existing `#lineNumbers` gutter, on the active cell's first line.
4. **Cursor ↔ slot coupling**: the active cell's slot is highlighted in
   the document; clicking a slot jumps the cursor to its cell. The
   stale tint moves to the slot.
5. **The five-view menu** (decision 4): Rad (editor top / document
   bottom = `layout-stacked`), Kolonne (editor left / document right =
   `layout-columns`), Kun output (`input-hidden`), Skrittvis
   (unchanged, a run), Presentasjon (re-hosted on the new document).
6. **Cell-list removal** (final task, after browser verification):
   `cellNode`'s editor half, `buildToolbar`, `onSrcKeydown`,
   `autoSize`, the nb-bar, the raw-override machinery and their CSS are
   deleted.

## Global constraints

- **The pure half of `js/cells.js` is untouched** (parseCells,
  executableSource, segmentPlan, alignPlan, forklarCellSteps, slidePlan,
  the six structural transforms, execCellSource, renderContent, …).
- **`mdRunNotebookCell` keeps its contract**: `{kind, text, uses, nb,
  cellIdx}` in, `{text|error|notice|rparts}` out; `cellIdx` remains an
  index into the aligned plan — the run path in index.html does not
  change (it is already DOM-free).
- **Mount-seam compatibility**: ParamForms/Ui/dash/ipywidgets resolve
  their hosts via `Cells.cellElementAt(idx)` →
  `.nb-output`/`.nb-output-body` (or `mdUiRunCtx().cellEl`). The new
  document slots keep those class names and `cellElementAt` returns the
  new slot wrapper — the four systems work unmodified.
- **Plain scripts unchanged**: no `#%%` → exactly today's behavior
  (including phase 3's doc-level widget strip — the document renderer
  engages only for `#%%` documents).
- **`htmlTrusted` gate survives**: html cells (explicit or sniffed) in
  the new document renderer keep the escaped-until-trusted behavior.
- **Skrittvis untouched** (it already runs against `#scriptInput` + its
  own overlay and only consumes the pure `forklarCellSteps`).
- ES5 var-style JS, Norwegian comments, user-facing strings through
  `t()` (+ `js/i18n/en.js`). Existing suites stay green through every
  task except tests that test the removed cell-list UI, which are
  removed/rewritten in the same task as the code they test.

## 1. The document renderer (js/cells.js DOM half, rebuilt)

**Host**: a `.doc-root` container created inside `#outputArea` when a
notebook document is active (`C.enter`). `.container` keeps its normal
layout classes; `.nb-hidden` is never applied. `#outputArea`'s normal
plain-script usage is untouched (the doc-root replaces its content only
while a notebook document is active, exactly as run output replaces
prior output today).

**Per cell** (`docCellNode(c, idx)` — the output-only successor of
`cellNode`): a `.nb-cell.doc-cell[data-idx]` wrapper containing:

- `.nb-output` wrapper (with `nb-widgets-<pos>` class) →
  `.nb-output-body` (the sink, stored as `c._out`) — identical
  structure/classes to today's output half, so strips/dash/ipywidgets
  mount unchanged.
- md/html cells: rendered content via
  `renderNonCode(body, type, C.renderContent(...))` into the body
  (`.nb-rendered-only` semantics without any edit affordance).
- Code cells: `hide-output` hides the wrapper; `hide-code` is
  meaningless in the document (there is no code there) and is ignored
  by the renderer (the attr remains valid for skrittvis/echo policy).
- `style=note|warn|card` classes carry over (they are content).
- NO `.nb-input`, no textarea, no head chip, no toolbar, no ✎.
- `skip` cells render nothing (excluded from the document entirely).
- The trailing sink (`.nb-trailing`) and `errorHost` semantics carry
  over at the end of `.doc-root`.

**Render/update policy** (replaces the tick/raw-override machinery):

- Source of truth stays `#scriptInput.value`. Edits re-render the
  document DEBOUNCED (250ms, the existing edit-debounce constant).
- **Reconciliation**: if the parse yields the same cell count with the
  same `headerRaw` sequence, update in place — re-render md/html bodies
  whose source changed, apply `markStaleIfRan` to code cells whose
  source changed, leave untouched cells' slots (and their outputs)
  alone. Otherwise (structure changed): rebuild all slots (outputs
  cleared, stale reset) — the same "ærlig reset" today's cell-list does
  on structural change.
- `contentLoaded`/`init`/`setDocMode` keep their roles (auto-engage for
  `#%%` documents in supported modes, session/Ui/param invalidation,
  htmlTrusted per untrusted flag). The «Rå tekst» override and the
  auto-open chip die — raw text is permanently visible in the editor.

**API surface preserved** (reimplemented against doc slots):
`active()`, `enter`, `exit`, `contentLoaded`, `refreshFromScript`,
`runCell(idx)`, `beginRun`, `sinkForSegment`, `segmentDisplay`,
`errorHost`, `cellIdxForSegment`, `cellIndexById`, `cellKeyAt`,
`cellElementAt` (→ the `.doc-cell` node), `alignedPlanForKinds`,
`engineRunPlan`, `updateCellSource` (→ splices the cell's lines inside
`#scriptInput.value` via the cell's `startLine`/`bodyStart`/`endLine`
and triggers the debounced re-render — the ParamForms.writeValue seam),
`grantHtmlTrust`, `presentStart/presentExit/presenting` (§4),
`setLayout` (§3), `_afterCellRun`, `markStaleIfRan`-equivalents.
`Cells.exit()` returns to plain-script behavior (used by skrittvis).

**Stale/running/active tint hosts move to the slot**: `.nb-stale`,
`.nb-running` and the new `.doc-active` (cursor coupling, §2) are
toggled on the `.doc-cell` wrapper.

## 2. Partial execution + cursor coupling (index.html editor side)

**Cursor→cell mapping** (pure): cursor line = count of `\n` before
`selectionStart`; the active cell is the one whose
`[startLine, endLine]` contains the line (from `parseCells`).

**Keybindings** (the existing `#scriptInput` keydown handler,
index.html ~5283):

- **Ctrl+Enter / Cmd+Enter** (notebook active): run the active cell —
  `Cells.runCell(idx)`. With a NON-EMPTY selection: selection run
  (below). Plain scripts keep today's whole-script Ctrl+Enter. (This
  fixes the currently-unbound Cmd+Enter as a side effect.)
- **Shift+Enter** (notebook active): run active cell + move the cursor
  to the first body line of the next code cell (skip md/html/skip),
  scrolling the editor. In a plain script: unbound (default newline).
- **Kjør** = run all (unchanged).
- **Cursor in the preamble** → Ctrl+Enter runs the preamble (cell 0
  when `headerRaw === null`) against the session — `runCell(0)` where
  the plan supports it (hybrid family); engines: preamble re-run via
  the existing cold-session path semantics.
- **Cursor in an md/html cell** → Ctrl+Enter re-renders that cell's
  document content immediately (no session call, no error).

**Selection run** (new capability): if the selection is non-empty and
lies entirely within ONE code cell's body, run the selected text
against the live session with output to that cell's slot: payload
`{kind, text: <tag-blanked selection>, uses: [], nb: {echo: false,
last: true}, cellIdx}` — the same display policy as a cell run.
Selections spanning cell boundaries or inside md/html cells: status
notice (`t('Merk tekst innenfor én kodecelle for å kjøre et utvalg')`),
no run. The selection text goes through the same tag-line blanking as
cell bodies (a selection may include the tag block).

**Gutter ▶** (decision 5): the active cell's FIRST line (headerLine for
marked cells, line 0 for the preamble) gets class `gutter-run` on its
`span[data-line]` in `#lineNumbers`; CSS renders a ▶ (replacing the
line number on hover, or beside it — one symbol only, never one per
`#%%`). Clicking it runs the active cell (delegated handler beside the
existing breakpoint handler; breakpoint clicks keep working on other
lines). Cursor tracking: `selectionchange` on `document` (filtered to
`#scriptInput` focus) + `click`/`keyup` fallbacks, debounced ~100ms →
recompute active cell → update gutter class + `.doc-active` slot
highlight + scroll the slot into view in the document pane (gentle,
`scrollIntoView({block:'nearest'})`).

**Slot→cursor**: clicking a `.doc-cell` (on non-interactive content —
ignore clicks on inputs/buttons/links/plots' controls) places the
cursor at the cell's first body line in `#scriptInput`, focuses it and
scrolls it into view.

## 3. The five-view menu

`#viewModeMenu` becomes: **Rad** (`data-view="stacked"`, relabeled),
**Kolonne** (`columns`), **Kun output** (`output`), **Skrittvis**
(`forklar`, unchanged), **Presentasjon** (`present`). With the
converged model there is no separate notebook layout: `Cells.setLayout`
collapses into the app primitives (`mdSetLayoutMode`,
`mdSetInputHidden`) — the `nb-layout-*` classes and `appLayout()`
mirroring die. Labels: «Rad» and «Kolonne» replace «Stablet» and
«Kolonner» (i18n keys updated, en.js: "Row"/"Column"). «Kun output /
dashboard» keeps its label. The menu behaves identically for plain
scripts and notebook documents.

## 4. Presentation re-hosted

`presentStart/presentExit` (phase 2) re-target the new document:
`nb-present` goes on `.doc-root` (inside `#outputArea`), `body.
present-active` additionally hides `.panel-left`/`#resizer` (the
editor) and the bars; slide visibility classes go on `.doc-cell`
wrappers; the nav overlay/counter attach to `.doc-root`. Slide
semantics (`slidePlan`) unchanged. `#options.view = present` and the
menu entry work as in phase 2.

## 5. Removal (decision 1 — last task, after verification)

After the browser exit gate verifies the converged model end-to-end:

- Delete from js/cells.js: `cellNode`'s editor half (now unused),
  `buildToolbar` + the six toolbar wirings, `onSrcKeydown`,
  `focusNextCodeCell`, `autoSize`/`autoSizeAll`, the nb-bar (Rå
  tekst/warnings strip/session chip move: warnings + session chip get
  a slim `.doc-bar` at the top of the document; Rå tekst dies),
  `NB.rawOverride`/tick auto-open chip machinery, edit-debounce
  plumbing for per-cell textareas (`onEdit`/`flushPendingEdit` where
  editor-specific; `updateCellSource` survives repointed at
  `#scriptInput`).
- Delete the corresponding app.css blocks (`.nb-input`, `.nb-src`,
  `.nb-head`, `.nb-tools`, `.nb-edit-btn`, `nb-layout-*`, hint-chip)
  and the cell-list-specific tests (rewritten as doc-renderer tests in
  the same commits that changed the behavior — never a later cleanup).
- KNOWN dependents to re-verify at removal: ParamForms `syncSource`
  (reads the textarea?) — its source of truth becomes `#scriptInput`
  via `updateCellSource`; the W4 param-forms DOM tests that build
  `.nb-input` fixtures.

## Error handling

- Cursor outside any cell (empty document): Ctrl+Enter no-op with
  status notice; gutter shows no ▶.
- `runCell` on a non-runnable cell type in the active mode: the
  existing polite-notice pattern (unchanged — it comes from
  `mdRunNotebookCell`).
- Selection run while a run is in progress: refused (existing
  `mdIsScriptRunning` guard), status notice.
- Document render of a malformed document: parse warnings render in
  the `.doc-bar` (today's nb-warnings channel).

## Testing

- **node (pure)**: cursor-line→cell mapping helper (new pure function
  `C.cellAtLine(cells, line)`); selection-span validation (within one
  code cell). Reconciliation decision function (same-structure check)
  if extracted pure.
- **node (stub-DOM, rewritten alongside each task)**: doc renderer
  builds slots without `.nb-input`; renderCellResult into doc slots;
  begin/sink/segmentDisplay against doc slots; htmlTrusted gate in doc
  renderer; reconciliation (edit md → re-render; edit code → stale;
  structure change → rebuild); updateCellSource splices `#scriptInput`
  and re-renders; present re-host; stale/running/active classes on
  `.doc-cell`.
- **Exit gate (browser, BEFORE the removal task)**: full matrix on a
  hybrid document (python+duckdb+md+html+sniffed cells) — Kjør alle;
  Ctrl+Enter per cell incl. preamble and md; Shift+Enter advance;
  selection run; gutter ▶ click; slot highlight + click-to-jump; stale
  tint on edit; widgets (`ui.*` in cells) + `#@param` + dash + a
  `#tag`-typed cell; R notebook; brython/micropython notebook; share
  link (untrusted html gate); five views incl. presentation; skrittvis;
  plain-script regression (incl. phase 3 doc widgets); both themes.
  THEN the removal task, THEN a regression re-run of the same matrix.

## Out of scope (documented)

- The dash absorption inventory (phase 5).
- Editor syntax-highlight changes (the `#%%`/`#tag` lines could get
  subtle styling — nice-to-have, not this phase).
- Multi-cursor/IDE features; drag-reorder of slots.
- The forklar per-cell-language backlog fix (separate follow-up; its
  entry point is untouched here).

## Phasing

Two plans (each independently shippable):

- **Plan 4a — the converged document**: doc renderer + reconciliation
  + preserved API surface + mount seams + five-view menu + presentation
  re-host. Exit gate: everything works with the cell-list code still
  present but UNREACHABLE (enter() builds the doc renderer).
- **Plan 4b — partial execution + removal**: cursor mapping,
  keybindings, selection run, gutter ▶, slot coupling, THEN the
  removal + CSS/test cleanup + final regression matrix.
