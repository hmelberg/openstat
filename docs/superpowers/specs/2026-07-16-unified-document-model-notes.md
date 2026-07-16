# Unified document model — decisions (pre-spec, complete)

**Status:** APPROVED direction, all open questions resolved by Hans
2026-07-16 (two brainstorm rounds + a nine-question closing round).
This document is the durable record; each phase below still gets its own
spec → plan → SDD cycle before implementation.
**Context:** spec 1 (cells, incl. Phase C) and spec 2 (widgets, incl. W5
events) are delivered. Spec 3 (presentation) is written against THIS
document. Backwards compatibility is explicitly NOT a constraint (the
system is not in use; examples can be rewritten) — the only obligation is
that existing *functionality* survives the restructuring.

## 1. The target model

**One raw text editor + one rendered output document.** `#%%` is structure
in the text, not separate editor boxes (the VS Code/Spyder percent-format
model). The raw text is the key view (Hans); Jupyter-style input-over-
output adjacency is explicitly unimportant.

- The editor is ALWAYS raw text. Md/html cells are edited as text — no
  per-cell editors, no dblclick-to-edit, no "Rå tekst" toggle (raw IS the
  editor). No small buttons/chips inside the editor surface (durable Hans
  preference); anything needed goes in the top menu.
- The output area is a rendered document: md/html rendered, code output
  in document order in per-cell slots, widgets/param strips in place.
  (All of this machinery exists — it is the cell-list's *editor* half
  that goes away, not the output half.)
- **The Jupyter-style cell-list renderer is REMOVED once the replacement
  is verified** (decision 1). Its cell operations (add/delete/move/split/
  merge/change type) need no menu equivalents — plain text editing
  suffices (decision 2).

### Views (decision 4)

The view menu holds five entries:

| View | Meaning in the target model |
|---|---|
| **Rad** | editor on top, rendered document below |
| **Kolonne** | editor left, rendered document right |
| **Kun output** | rendered document only — the report/app/web-page view |
| **Skrittvis** | preserved as-is (pedagogy feature, its own thing) |
| **Presentasjon** | the rendered document paginated into slides (§4) |

Presentasjon and Skrittvis are not pure layout modes but live in the same
menu — presentation needs slide state + arrow-key navigation; skrittvis
is kept unchanged by Hans's explicit wish.

### Partial execution (confirmed requirement)

Run-cell-at-cursor drives the existing cell-index machinery
(`mdRunNotebookCell`, live sessions, engine notebookSessions) via
cursor→span mapping (`span.startLine/endLine` already in the parser):

- Ctrl+Enter = run the cell containing the cursor; Shift+Enter = run +
  advance. Kjør = run all (no separate "run all cells" button).
- **Selection run** (new capability the cell-list never had): run a
  marked text region against the live session, output to the enclosing
  cell's slot.
- **Gutter affordance (decision 5): a ▶ in the editor gutter for the
  ACTIVE cell only** (the cell containing the cursor) — one symbol, not
  one per `#%%` line (visual noise).
- Cursor-cell ↔ output-slot coupling: the active cell's slot is
  highlighted in the document; clicking a slot jumps to its cell in the
  editor. Stale tint moves to the slot.
- Cursor in preamble = run preamble; cursor in md/html cell = re-render
  (or no-op) — the spec defines this precisely.

## 2. `#tag.` cell directives (decision 3 — expanded)

Comment-line metadata inside the cell body, motivated by Colab/Jupytext
interop (those tools regenerate/own the `#%%` marker lines, so attrs on
the marker do not survive round-trips; comment lines in the body always
survive). Pattern-completes the existing family: `#options.*` (document),
`#tag.*` (cell), `#@param` (line).

Rules (all confirmed):

- Syntax `#tag.key = value`, one per line.
- **Position: at the very beginning of the cell body, before anything
  else.** First non-`#tag` line ends the tag block.
- **Merged into the cell's attrs at parse time** (before any execution —
  the whole document parses before a run, so tags correctly affect both
  execution and rendering).
- Precedence on conflict: the `#%%`-line attribute wins, with a warning.
- Hidden in rendered views (like `#options.*`); visible in the editor.
- **Tags can set the cell's language/type**: `#tag.type = r` (etc.) —
  this is the Colab-friendly way to type a cell when the `#%%` line
  cannot carry it.
- **Document defaults via preamble tags**: `#tag.*` lines in the preamble
  (before the first `#%%`) act as defaults for every cell that does not
  override them — e.g. a default type so not every cell must say it is
  python. (This coexists with `#options.mode`, which remains the document
  runtime; the spec defines the interplay: options.mode = runtime,
  preamble `#tag.type` = default cell type where they could differ.)

### Content-sniffed cell types (Hans proposal, accepted with care)

For UNMARKED cells only (no type on the `#%%` line and no `#tag.type`):

- first line starts with `"""` → **markdown** cell (content = the text
  inside the triple quotes; the delimiters are not rendered),
- first line starts with `<` → **html** cell.

Explicit type always wins over sniffing. Known caveat for the spec: a
triple-quoted string opening a legitimate python cell is valid python
(docstring/expression) — the spec must pin the disambiguation rule
(proposal: sniff only when the cell consists of the string alone, or
require the `"""` to open at column 0 on the first line AND the cell to
close with `"""`; decide in the #tag spec with tests). `<` at the start
of a python/r line is never valid code, so the html sniff is safe.

## 3. Widgets in plain scripts + `sync_to` (decision 7 — revised from
earlier draft)

Hans's usage: widget changes should mostly rerun *parts* of the code,
not everything. Therefore:

- Widgets in plain scripts (no `#%%`) render into the document output
  area, but **default to `rerun="none"`** there (NOT whole-script
  rerun). The value is picked up on the next manual run (pull model).
- An explicit `rerun="all"` opt-in reruns the whole script on change
  (debounced) for the rare case it is wanted.
- **New `sync_to=` keyword on value controls (all facades)**: pushes the
  widget's value into a named session variable immediately on change,
  WITHOUT rerunning — `ui.slider(1, 10, sync_to="n")` keeps python/
  brython/micropython/R variable `n` current, so manual runs and `ui.on`
  handlers see fresh values. (In notebooks this complements the pull
  model; in plain scripts it is the main live channel.)
- In notebooks nothing changes: default `rerun="self"` as today.

## 4. Presentation (spec 3, decision 6)

Pagination of the SAME rendered document — inherits widgets/plots/params
with no new machinery:

- `slide=3` on the `#%%` line or `#tag.slide = 3` groups cells into
  slides; unnumbered cells follow the previous cell's slide.
- Navigation: left/right arrow keys + click zones + Esc to exit.
- Startable from the view menu AND from a document directive
  (`#options.view = present`) so a shared link opens directly as a
  presentation.
- Estimated 2-3 tasks, not a full mode.

## 5. Dash: absorb and retire (backwards-compat waiver)

Hans decision: dash is not in use; examples can be rewritten; the
functionality must survive in the common `ui`/cell system. Absorption
inventory (must ship BEFORE dash is removed):

- **Layout**: grid/multi-column → cell attribute `cols=` (decision 8);
  `#%% html` grid + `target=` remains the power-user pattern.
- **KPI cards**: `ui.kpi(value, delta=…)` as its own control/payload
  kind (decision 8). Markdown and image payload kinds join the `ui`
  render vocabulary (text/table/figure/error exist since W5).
- **Play widget** (animated slider): `ui.play`, with dash's documented
  timer-hygiene pattern.
- **Publish**: "Publiser dashboard" generalizes to "publish document"
  (report view of any notebook, data baked, standalone HTML).

Then: rewrite the ~20 dash examples as cell/widget documents; remove the
four dash adapters (`pyodide/brython/micropython` `dash.py`, `webr` dash)
and `js/dash.js`, moving renderer internals `ui` reuses (figure path from
W5) into ui.js. Removal happens LAST.

## 6. Sequencing (decision 9 — delegated to assistant, chosen)

1. **`#tag` + sniffing + preamble defaults** (parser-level, unlocks
   Colab interop; now slightly larger than first sketched).
2. **Presentation (spec 3)** — most visible, cheap in this model.
3. **Widgets in plain scripts + `sync_to`**.
4. **Editor convergence** — cursor/selection run, gutter ▶, the five-view
   menu, slot coupling, cell-list removal (after verification), inline
   editor buttons removed.
5. **Dash absorption** (cols=, ui.kpi, ui.play, markdown/image payloads,
   publish document) → example rewrite → dash removal.

Each phase: brainstorm-lite → spec → plan → subagent-driven execution,
merge+push per phase, ledger in `.superpowers/sdd/progress.md`.

## Resolved-question log (2026-07-16)

1. Cell-list: remove when replacement verified. 2. Cell ops: text editing
suffices. 3. `#tag`: `#%%` wins + warning; tags first in cell; hidden in
render; can set type; preamble tags = document defaults; `"""`→md and
`<`→html sniffing for unmarked cells (with the python-docstring caveat to
resolve in-spec). 4. Views: Rad, Kolonne, Kun output, Skrittvis,
Presentasjon. 5. Gutter ▶ on the active cell only. 6. Presentation: all
three recommendations. 7. Plain-script widgets: no auto-rerun by default;
`rerun="all"` opt-in; new `sync_to=`. 8. `ui.kpi` + `cols=`. 9. Sequencing
delegated; order above.
