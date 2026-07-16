# Presentation view — slides over the rendered notebook (design)

**Status:** DELIVERED 2026-07-16 (plan 2026-07-16-presentation.md).

Phase 2 of the unified document model
(`2026-07-16-unified-document-model-notes.md` §4 and §6.2, decision 6 —
"all three recommendations" approved by Hans 2026-07-16). Spec 3 in the
notebook series. Builds directly on the `#tag` phase (`cell.attrs.slide`
is already parsed and merged from header, `#tag.slide` and preamble
defaults — reserved since spec 1, consumed here for the first time).

## Summary

**Presentation = pagination of the SAME rendered document.** No new
rendering machinery: the notebook's existing `.nb-root` cell DOM stays
exactly where it is; presentation is a layout state that (a) hides all
editor chrome (the `nb-layout-output` precedent), (b) shows only the
cells of the current slide, and (c) adds navigation (arrow keys, click
zones, Esc) plus a slide counter. Widgets, `#@param` strips, plots and
dash mounts keep living in their cells' `.nb-output` — they stay live on
their slide with zero extra work (visibility is CSS `display`, DOM nodes
never move).

Three entry points (decision 6): the view menu ("Presentasjon"), the
document directive `#options.view = present` applied at load time (so a
shared link opens directly as a presentation), and the same directive at
run time.

## Global constraints

- **Notebook-only**: presentation requires an active notebook
  (`Cells.active()` — a `#%%` document in a supported mode). For plain
  scripts the menu entry shows the standard polite notice pattern.
- **No DOM moves**: slides are visibility classes on the existing
  `.nb-cell` nodes. Plots/widgets/dash must never be reparented.
- **No new execution semantics**: entering/leaving presentation never
  runs code. An unrun document presents md/html cells rendered and empty
  output slots; Kjør fills them as usual (presentation survives a run).
- **htmlTrusted unaffected**: html cells on slides go through the exact
  same trust gate ("Vis HTML") as everywhere else. Auto-starting
  presentation from a shared link is safe because presentation executes
  nothing.
- The hybrid segment machinery is untouched. ES5 var-style JS, Norwegian
  comments, user-facing strings through `t()` (+ `js/i18n/en.js` entries).

## 1. Slide grouping (pure half, `js/cells.js`)

New pure function **`C.slidePlan(cells)`** → `{ slides, byCell }`:

- `slides`: array of slide descriptors `{ num, cellIdxs }` in
  presentation order; `byCell`: array mapping cell index → slide
  position (0-based), used by the DOM half.
- **Effective slide number per cell**: the cell's own `attrs.slide`, else
  inherited from the previous cell (decision doc: "unnumbered cells
  follow the previous cell's slide").
- `slide=N` with integer N: that number. **Bare `slide` flag** (boolean
  `true`, the KNOWN_FLAGS form) and non-numeric values (`parseInt` NaN):
  auto-number = (highest number seen so far) + 1 — the ergonomic
  "`#%% md slide` starts the next slide" form. No warnings (tolerant,
  layout-level).
- **Grouping is by number, not adjacency**: slides are the distinct
  effective numbers sorted ascending; a slide's `cellIdxs` are all its
  cells in document order. (Because visibility is per-cell CSS,
  non-contiguous groups cost nothing and give authors reordering power.)
- **Leading cells** (preamble included) with no effective number belong
  to the first slide. **If no cell in the document carries a slide
  attr**: one slide containing everything (presentation degrades to a
  clean full-screen rendered view).
- `skip` cells are excluded from `cellIdxs` (they render nothing) but do
  NOT break inheritance (their own `slide` attr still updates the
  running number — a `#%% skip slide=4` boundary marker works).
- The trailing sink (`.nb-trailing`, plan-mismatch fallback) is handled
  by the DOM half: visible only on the last slide.

## 2. Presentation state (DOM half, `js/cells.js` + `app.css`)

New state on NB: `NB.present = null | { slides, byCell, cur, prevLayout }`.

- **`C.presentStart()`**: no-op unless `NB.activeFlag`. Computes
  `slidePlan(NB.cells)`, remembers the current layout
  (`NB.present.prevLayout = NB.layout`), sets `NB.present.cur = 0`,
  adds class `nb-present` to `NB.root` AND class `present-active` to
  `document.body`, applies visibility, installs the keyboard handler,
  builds the nav overlay (once), syncs the view dropdown
  (`mdSyncViewDropdown('present')`). Idempotent.
- **`C.presentExit()`**: removes classes, removes the keyboard handler,
  restores `prevLayout` via the existing `C.setLayout` + app-layout
  mirroring, syncs the dropdown back. Called by Esc, by choosing any
  other view in the menu, by `C.exit()` (Rå tekst), and by the
  invalidation hooks (`contentLoaded`, mode switch) — presentation never
  survives a document/mode change.
- **Visibility**: cell at index i gets class `nb-slide-hidden`
  (`display: none`) unless `byCell[i] === cur`. The `.nb-trailing` node
  gets the same class unless `cur` is the last slide.
- **Navigation**: `next()`/`prev()` clamp to `[0, slides.length-1]` and
  re-apply visibility + counter. Keyboard (document-level `keydown`,
  installed only while presenting): ArrowRight/ArrowDown/PageDown/Space
  → next; ArrowLeft/ArrowUp/PageUp → prev; Escape → exit. The handler
  ignores events whose target is a form field (`input`, `textarea`,
  `select`, `[contenteditable]`) so widgets keep their keys; existing
  overlay-scoped Esc handlers coexist (they early-return when their
  overlay is closed; ours only runs while presenting).
- **Nav overlay** (built once, children of `NB.root`): two fixed
  edge click zones `.nb-present-nav.nb-present-prev/.nb-present-next`
  (narrow full-height strips with ‹ › chevrons, transparent until
  hover) and a counter `.nb-present-counter` ("3 / 7") bottom right.
  Edge strips — never a whole-surface click target — so clicks on
  widgets, links and scrollbars inside the slide are untouched.
- **Re-render survival**: `render()` rebuilds all cell nodes. At its
  tail, if `NB.present` is active, recompute `slidePlan` (the document
  may have changed), clamp `cur`, re-apply classes and rebuild the
  overlay. A running document (widget rerun via `renderCellResult`)
  touches only slot contents — nothing to do.

### CSS (`app.css`, both themes via existing custom properties)

- `body.present-active`: hide `.topbar`, the bottom bar and `.container`
  siblings (the notebook root is already a sibling of `.container`).
- `.nb-root.nb-present`: `position: fixed; inset: 0; overflow-y: auto;
  background: var(--bg); z-index` above app chrome; generous padding;
  slightly larger base font (`1.15em`).
- Inside `.nb-present`: hide `.nb-bar`, `.nb-input`, `.nb-tools`,
  `.nb-edit-btn` (the `nb-layout-output` recipe, extended); `.nb-cell`
  loses borders/card chrome for a clean slide surface (except explicit
  `style=card|note|warn`, which keep their look — they are content).
- `.nb-slide-hidden { display: none; }`
- Nav strips + counter styled for `light`/`dark` via variables.

## 3. Entry points (index.html)

- **View menu** (bottom bar, `#viewModeMenu` ~index.html:278-291): new
  `<button data-view="present" data-i18n>Presentasjon</button>`. In the
  click handler (`initViewModeDropdown`, ~3508-3531): `data-view ===
  'present'` → if `Cells.active()`, call `Cells.presentStart()`; else
  `setStatus` notice `t('Presentasjon krever et notatbok-dokument
  (#%%-celler)')` and no state change. Choosing any OTHER view while
  presenting calls `Cells.presentExit()` first (the handler already
  routes notebook layouts through `Cells.setLayout`). New i18n keys in
  `js/i18n/en.js` ("Presentasjon" → "Presentation", the notice, nav
  titles).
- **Load-time directive** (all load paths — examples, share links,
  GitHub files, deep links): at the tail of `C.contentLoaded`
  (js/cells.js), after the notebook has auto-opened, match
  `^\s*(?:#|\/\/)\s*options\.view\s*=\s*["']?present["']?\s*$` (mi)
  against the document and call `C.presentStart()` when the notebook is
  active. (`mdNotebookMaybeAutorun` would be the wrong hook — it
  early-returns unless the link requested autorun (`?run=`/output
  action), while `contentLoaded` fires for every programmatic document
  load.) No run gate needed (presentation executes nothing; any
  `?run=` autorun keeps its existing `autorunNeedsGate` behavior and
  simply fills the slides' slots when it completes).
- **Run-time directive**: the existing `#options.view` run handler
  (index.html ~9974-9979) additionally recognizes `present` →
  `Cells.presentStart()` (idempotent if already presenting) instead of
  the `mdSetInputHidden` mapping.

## Error handling

- `presentStart()` on an inactive notebook: silent no-op from code paths,
  status notice from the menu path (the one user-initiated caller).
- Slide plan of an edge-case document (empty, one cell, all-skip):
  degrades to one slide / an empty slide list → `presentStart()` with
  zero slides is a no-op with the same notice.
- Malformed `slide` values never warn or throw (auto-number fallback).

## Testing

- **node (`tests/js/cells.test.js`)**: `slidePlan` matrix — explicit
  numbers, inheritance, bare-flag auto-numbering, NaN values, grouping
  by repeated number (non-contiguous), leading unnumbered cells → first
  slide, no-attrs → single slide, skip-cell exclusion + boundary
  inheritance, preamble membership, `#tag.slide` and preamble-default
  `#tag.slide` feeding the plan (via parseCells).
- **node stub-DOM (`tests/js/cells-dom.test.js`)**: presentStart hides
  non-current cells (`nb-slide-hidden`) and editor chrome class present;
  next/prev clamp + counter text; Esc → presentExit restores layout
  classes; re-render while presenting keeps the mode and clamps `cur`;
  exit on `contentLoaded`.
- **Exit gate (browser)**: a slides example end-to-end — menu entry
  (both from Kolonner and Kun output), arrows/click zones/Esc, counter;
  widgets live on a slide (slider rerun updates the same slide);
  `#options.view = present` share-link auto-start (untrusted html cell
  stays escaped on its slide until Vis HTML); run while presenting
  (Kjør alle fills slots without leaving the mode); both themes;
  regression: normal notebook views and plain scripts unaffected.

## Out of scope (documented)

- `speak` (TTS per slide) — stays reserved.
- Fullscreen API (browser F11 works; native fullscreen can come later).
- Printing/PDF export of slides.
- Per-slide transitions/animations.
- Phase 4's five-view menu restructuring — this phase only ADDS the
  entry to the existing dropdown; the menu itself is reorganized in
  phase 4.

## Phasing

Single plan, expected 3 tasks: (1) pure half — `slidePlan` + node
tests; (2) DOM half + CSS — present state, nav, keyboard, dropdown
sync, stub-DOM tests; (3) index.html entry points + i18n + example +
browser exit gate.
