# Unified document model — brainstorm conclusions (pre-spec notes)

**Status:** discussion outcome 2026-07-16 (Hans + assistant), target model
APPROVED by Hans ("Enig i målbildet"). Not yet a spec — this document is
the durable record so spec-writing can start fresh in any session.
**Context:** follows spec 1 (cells, incl. Phase C), spec 2 (widgets, incl.
W5 events) — all delivered. Spec 3 (presentation) still unwritten.

## The approved target model

**One raw text editor + one rendered output document.** `#%%` is structure
in the text, not separate editor boxes (the original VS Code/Spyder
percent-format model). Views become variants of showing the rendered
document:

- Edit view: editor + rendered document side by side (today's "Kolonner"
  collapses into this).
- Report/app view: rendered document only (= today's "Kun output"; with
  widgets live this IS a web page).
- Presentation: the same rendered document paginated into slides.
- The Jupyter-style cell list (per-cell editors) is DEMOTED to an optional
  view: kept for now, receives no new features. (Open: remove entirely
  later — Hans has not decided.)
- "Rå tekst" toggle becomes meaningless (the editor IS raw) and the
  stacked/column distinction loses importance — Hans explicitly rates the
  raw view as the key view and Jupyter-adjacency as unimportant.

**Per-cell / partial execution is preserved and is the point** (Hans
confirmed requirement): run-cell-at-cursor (Ctrl/Shift+Enter; optional
gutter ▶ per `#%%` line — NOT floating buttons in the editor), driven by
the existing cell-index machinery (`mdRunNotebookCell`, live sessions,
engine notebookSessions) via cursor→span mapping (`span.startLine/endLine`
already in the parser). BONUS the cell-list never had: run a text
SELECTION (sub-cell) against the live session, output to the enclosing
cell's slot. Known trade-off: input/output visual adjacency weakens —
mitigate with cursor-cell ↔ output-slot highlight coupling (and click slot
→ jump to cell), stale tint moves to the slot. A spec must define cursor
mapping precisely (preamble, md cells: run = re-render/no-op).

## Component decisions

1. **Dash: absorb and RETIRE** (Hans decision 2026-07-16: backwards
   compatibility is NOT important — the system is not in use, examples
   can be rewritten; what matters is that dash's functionality and its
   widgets carry over into the common `ui`/cell system). Absorption
   inventory (what `ui`/cells must gain before dash is removed):
   - **Layout**: grid/multi-column card layout → cell-level layout
     (e.g. `cols=`/row grouping attrs, or documented `#%% html` grid +
     `target=` patterns).
   - **Payload kinds**: KPI/number card (value + delta arrow), markdown,
     image — added to the `ui` event/render payload vocabulary
     (text/table/figure/error exist since W5).
   - **Controls**: dash's play/animated-slider widget → `ui.play` (timer
     hygiene per dash's documented pattern); dash's
     controls-call-function-with-kwargs model is already covered by
     `ui.on` + widget pull reads.
   - **Publish**: "Publiser dashboard" (baked data, standalone HTML) →
     "publish document" (report view of any notebook, data baked).
   Then: rewrite the ~20 dash examples as cell/widget documents, remove
   the four dash adapters (pyodide/brython/micropython/webr `dash.py`,
   `dash-webr`) and `js/dash.js` — keeping/moving whatever renderer
   internals `ui` reuses (`renderPayload` figure path from W5) into
   ui.js. Removal happens LAST, only after the inventory above ships.
2. **Presentation (spec 3) shrinks**: pagination of the rendered document.
   `slide=` attr (already reserved in spec 1 grammar) / `#tag.slide`
   groups slots into slides; unnumbered cells follow the previous one;
   next/prev controls + keyboard + Esc. Inherits widgets/plots/params for
   free. Estimated 2-3 tasks, not a full mode.
3. **Widgets in plain scripts** (no `#%%`): generalize the run context so
   `ui.*` registers against the document output area, `rerun="self"` =
   rerun the script. W5 did half: bindings with cellIdx null already fall
   back to `#outputArea`. Gives the continuum: script → notebook → app
   view → publish.
4. **`#tag.key = value` cell-body directives (from code2web) — REVERSED
   earlier decision, now wanted as an ADDITIONAL channel** (Hans's
   argument accepted: Colab/Jupytext regenerate/own the `#%%` marker
   lines, so attrs on the marker do not survive round-trips; comment
   lines inside the cell body always survive). Rules proposed (Hans not
   yet confirmed): `#%%`-line attrs stay canonical and WIN on conflict
   (+ warning); `#tag.` lines must be at the TOP of the cell body; hidden
   in rendered views like `#options.*`; merged into cell attrs at
   parseCells time (before execution — Hans's timing concern is satisfied
   since the whole document parses before any run). Pattern-consistent
   with `#options.*` (document level) and `#@param` (line level). Small
   spec: pure-half parser + tests.
5. **Editor chrome**: no small buttons/chips inside the editor surface
   (durable Hans preference, in assistant memory): move "Rå tekst" into
   the view choices, drop redundant "run all cells" (Kjør already does
   it). Gutter affordances acceptable.

## Suggested sequencing (assistant recommendation, Hans not yet chosen)

`#tag` spec (smallest, unlocks Colab interop) → presentation spec 3
(most visible, cheap in this model) → widgets-in-plain-scripts →
edit-view convergence (cursor-run + editor/document view) →
dash absorption (layout + payload kinds + play + publish-document,
then example rewrite and dash removal). Each its own brainstorm-lite →
spec → plan → SDD cycle.

## Open questions for Hans

(a) Jupyter cell-list: optional/frozen or eventually removed?
(b) Confirm `#tag.` rules above (precedence, top-of-cell requirement).
(c) Sequencing choice.
