# Notebook cells — design (spec 1 of 3: core cells)

**Status:** approved design, pending user review of this document
**Date:** 2026-07-13
**Repo:** openstat leads; port to safestat later; **no** microdata port.
**Series:** spec 1 of 3 — core cells. Spec 2 (widgets/`ui` module) and spec 3
(presentation mode) follow after the core lands, and build on this format.

## Summary

Add a cell structure to openstat in the Jupytext/"percent format" style
(option C of the exploration): **the plain-text script stays the canonical
format**; `#%%` markers in the text define cells; the front-end parses text →
in-memory cell model → renders cell-aware views → serializes edits back to
text. A script without markers is a valid single-cell document with exactly
today's behavior, so every existing script, example, and share link is
unchanged. Cell-aware behavior is opt-in by using `#%%` at all.

Two views of the same document:

1. **Kolonner + celler** — the existing Kolonner (columns) view
   auto-upgrades when `#%%` markers are present: one script buffer on the
   left (native editing, undo, cross-cell selection), per-cell outputs
   grouped on the right, per-cell run buttons in the gutter. Pattern proven
   by VS Code's Python Interactive mode.
2. **Celler** — a new fifth view mode: Jupyter-style vertical cell list,
   each cell a small editor with its output directly beneath.

## Goals

- Cells in plain text: `#%%` separators with type + attributes on the marker line.
- Non-code cells: markdown (`md`) and `html`, rendered in place.
- Multi-language cells: any openstat mode per cell, reusing the existing
  hybrid segment pipeline (incl. cross-runtime data sharing).
- Per-cell run against live runtime sessions (incremental execution;
  stale state is accepted, "Restart & Run All" is the reset).
- Traditional notebook output: an explicit cell displays only the value of
  its **last** expression (per-language details below).
- Zero behavior change for documents without `#%%` markers.

## Non-goals (later specs / never)

- Widgets, `ui` module, `rerun=` callbacks — **spec 2**. The attr names
  `rerun` and `sync` are reserved now.
- Presentation/slide mode, autoplay, narration — **spec 3**. The attr names
  `slide` and `speak` are reserved now.
- Reactive dependency-tracked re-execution (marimo/Pluto style) — not planned.
- `.ipynb` import/export — not in scope; the percent format is the format.
- No changes to skrittvis, share links, GitHub storage, AI features, or the
  microdata emulator semantics.

## 1. Text format

### Marker

A cell starts at a line matching `^#\s?%%` (`#%%` or `# %%`, column 0).
The marker line is a **document-level token**: it is stripped before any text
is sent to a runtime, regardless of the cell's language (so it is also used
in R, DuckDB, and microdata cells — no per-language comment variants).

### Header grammar

```
#%% [type] [attr ...]
attr  := flag | key=value
value := bareword | "quoted string with spaces"   (\" escapes a quote)
```

- **type** (optional): first token, recognized case-insensitively against the
  known list; if the first token is not a known type it is parsed as an attr.
  Known types: the openstat mode ids `python`, `r`, `duckdb`, `brython`,
  `micropython`, `microdata`, `statx`, plus `md`, `html`, `skip`.
  Aliases: `py`/`pyodide` → `python`; `markdown`/`text` → `md`;
  `# %% [markdown]` (VS Code/Jupytext bracket form) → `md`.
  Omitted type → the document's mode (`#options.mode` / active editor mode).
- **Spec-1 attrs:** `id=` (`[A-Za-z0-9_-]+`, unique per document — duplicate
  ids warn, last one wins), `hide-code`, `hide-output`,
  `style=note|warn|card`.
- **Reserved attrs** (documented, parsed, ignored until their spec):
  `slide`, `speak`, `rerun`, `sync`.
- **Unknown keys/flags warn, never error** — old notebooks keep working in
  newer versions and vice versa.

### Document structure

- Text **before the first marker** is an implicit preamble cell of the
  document's mode (this is where `#options.*` directives and `# load`
  directives usually live). It renders as a normal code cell.
- A document with **no markers** is one implicit cell with today's exact
  behavior (display policy included — see §4).
- Legacy language markers `## python` / `## r` / `#duckdb` keep working:
  the existing marker normalizer (index.html ~7413) additionally maps them
  to `#%% <lang>` before segmentation, so old hybrid scripts become cell
  documents for free.

### Serialization round-trip

`serializeCells(parseCells(text)) === text` for any input (headers are kept
verbatim; a normalized header is emitted only when the UI edits that cell's
attrs). Cell operations are text transforms:

| Operation | Text transform |
|---|---|
| add cell above/below | insert a `#%%` header (+ blank line) |
| delete cell | remove its span |
| move up/down | swap adjacent spans |
| split at cursor | insert `#%%` header at cursor line |
| merge with previous | delete this cell's header line |
| change type / edit attrs | rewrite the header line |

## 2. Module layout

New **`js/cells.js`**, mirroring the `dash.js` convention:

- **Pure half** (node-testable, no DOM): `parseCells(text)` →
  `[{type, attrs, source, span:{startLine,endLine}, headerRaw}]`,
  `serializeCells(cells)`, attr parsing/serializing, id validation.
- **DOM half**: the Celler view (cell list, per-cell editors, toolbar) and
  the Kolonner upgrade (gutter buttons, boundary overlays, output grouping,
  active-cell sync).

Hooks into existing `index.html` code are deliberately thin:

| Touch point | Change |
|---|---|
| view-mode dropdown (~3424) | add "Celler" entry (~10 lines) |
| marker normalizer (~7413) | `## lang` → `#%%` mapping (~10 lines) |
| embedded Python core (~6815) | guarded `display='last'` flag (~10 lines) |
| output rendering | render-target threading (§5 — the designated hard part) |

CSS lives in `app.css` (additive). Everything else is new files.

## 3. Views

### 3.1 Kolonner auto-upgrade (single buffer + per-cell outputs)

When the parser finds ≥1 marker, the Kolonner view gains:

- **Cell boundaries** drawn as separator lines over the editor and **run
  buttons** in the gutter at each header (positioning via the same
  line-range→pixel technique as the forklar highlight band).
- **Right pane** groups output into one slot per cell, in document order.
- **Active-cell sync** instead of strict row alignment (which is a tarpit —
  output heights never match code heights): panes scroll independently; the
  output slot of the cell containing the cursor is highlighted and scrolled
  into view; clicking an output slot jumps the editor to that cell.
- Re-parse on input (debounced ~150 ms); boundaries and slots follow edits.

No markers → the view is pixel-identical to today.

### 3.2 Celler view (Jupyter-style list)

Fifth view mode. Vertical list; per cell: header chip (type + attrs),
editable code area, output beneath. Details:

- **Hover toolbar:** run, add above/below, delete, move up/down, change
  type, edit attrs; split/merge as in §1.
- **Keyboard:** Shift+Enter = run + advance (creates a trailing cell at the
  end), Ctrl/Cmd+Enter = run in place.
- **md/html cells** render by default; double-click flips to the editor,
  blur/re-run flips back.
- **`hide-code`** shows output only (an unobtrusive affordance reveals the
  code); **`hide-output`** the inverse; **`skip`** cells are dimmed and
  never executed.
- **`style=note|warn|card`** applies preset frames/backgrounds to the cell.
- **Stale tint:** a cell edited since its last run gets a subtle tint —
  information, not nagging.
- Edits serialize back to the canonical text; switching view modes is
  always lossless (the raw editor is authoritative).

## 4. Execution

### Sessions

Runtimes (Pyodide, webR, DuckDB, Brython, MicroPython) hold state across
calls — a **session**. Lifecycle:

- First run (any cell, or Run All) boots the needed runtime and executes the
  **hoisted `# load` directives** (loads are collected document-wide and made
  idempotent, so a lone cell run never misses its data).
- Subsequent cell runs execute incrementally against the live session.
- Per-runtime **status chips** (e.g. Python ● live / R ○ cold) and a
  **Restart & Run All** action (the reproducibility reset).

### Per-cell run

"Run cell" executes that cell's text via the **existing segment executors**
(the pyodide exec core, `runInlineRSegment`, the shared DuckDB executor) —
new orchestration, not new execution machinery. Cross-runtime data sharing
continues to work because cells ride the same hybrid segment pipeline.

**Microdata cells are the exception:** the emulator is script-oriented, so
"run cell" there means *run from the top through this cell* (the tutorial
rewind mechanism, index.html ~9051). Same button, per-runtime strategy.

Run controls: **Run cell**, **Run all**, **Run above**. Run All executes
cells in document order and **stops at the first error**; the error renders
in that cell's output slot.

### Display policy ("last line only")

Applies to **explicit cells** (those created by a `#%%` header):

- **python / brython / micropython:** the AST walker (index.html ~6815)
  already evaluates statement-by-statement; a `display='last'` flag skips
  `_show_one` for all but the final top-level expression. `print()` and
  plots always show. The `>>>` echo is off in cell context.
- **r:** unchanged — R's own visibility semantics already match notebook
  expectations (assignments are invisible; visible values print).
- **duckdb:** only the last result-producing statement's result set shows.
- **microdata:** exempt — commands (`tabulate`, `summarize`, `barchart`, …)
  emit per-command output as today; a last-line rule would hide most results
  and break every existing example.

Documents **without markers keep today's show-all REPL behavior.**
`#options.display = all` opts a marked document back into show-all;
`#options.display = last` forces last-only for an unmarked script.

## 5. Output routing (the designated hard part)

Today all results append to the single `#outputArea`. Cell views need each
run's output rendered into **that cell's slot**. Design:

- Thread an optional **render target** (a container element) through the
  output path; default remains `#outputArea`, so non-cell modes are
  untouched.
- The per-segment rendering that already exists ("segmentvis kjøring",
  index.html ~5761) is the seam to build on.
- Post-render enhancers, Plotly mounts, and dashboard mounting must accept
  the target container instead of assuming `#outputArea`. This is the
  largest change to existing code and the most likely regression source —
  it gets its own implementation-plan phase and explicit regression tests
  (dashboards + plots render correctly in all pre-existing view modes).
- Phase A avoids this entirely (below), so the risk is isolated in phase B.

## 6. Phasing

- **Phase A — parser + views on Run All only.** `cells.js` pure half with
  full test coverage; Celler view and Kolonner upgrade rendering cells and
  outputs, where "run" is today's whole-document run and outputs are
  **sliced into per-cell slots afterward** (the existing pipeline already
  produces output in segment order). No changes to execution or output
  threading. Independently shippable: a real notebook view.
- **Phase B — per-cell run.** Sessions, hoisted loads, render-target
  threading (§5), gutter buttons, last-expression display flag, Run
  above/Restart, stale tint, cell toolbar editing operations.

If phase B stalls, phase A remains a shippable feature.

## 7. Compatibility, sync, risks

- **Gating:** all new code paths require `#%%` markers or the Celler view.
  No markers + old views = no new code executes.
- **Documents are still scripts:** `#%%` headers are comments to every
  runtime; a broken cell view cannot corrupt a document; any notebook can be
  pasted into microdata.no-style tooling minus the marker lines.
- **Sibling repos:** openstat leads this feature. Later safestat port is
  kept cheap by concentrating work in `js/cells.js` + thin hooks. No
  microdata-repo port (kept intentionally smaller).
- **Known accepted risks:** stale session state (accepted by design;
  Restart & Run All is the escape hatch); notebook-UX long tail (focus,
  undo-across-cells, scroll polish) — mitigated because the raw editor
  remains authoritative and available.

## 8. Testing

- **Parser/serializer (node, like the dash.js pure-half tests):** grammar
  cases (both marker spellings, types/aliases/bracket form, quoting,
  flags, unknown-attr warnings, duplicate ids), round-trip guarantee,
  legacy `## lang` normalization, implicit preamble/single-cell documents,
  all cell operations as text transforms.
- **Display policy:** pytest/JS tests that `display='last'` shows only the
  final expression, `print`/plots always show, unmarked scripts unchanged,
  microdata exempt.
- **Example notebooks** in `examples/` (multi-language + md/html cells) run
  as smoke tests alongside `manual_scripts/`.
- **Regression:** all existing examples and `manual_scripts/` unchanged in
  old views; dashboards and Plotly output correct before/after the
  render-target threading.

## 9. Decisions log (from the brainstorm, 2026-07-13)

- Plain text canonical, Jupytext-style (option C) — chosen over pure-view
  (A), JSON notebook (B), dash-only (D).
- All cell attrs on the `#%%` line — chosen over Quarto `#|` lines and
  code2web `#tag.*` lines (code2web's separators/ideas mined; its `#tag.*`
  vocabulary, auto type-inference, and large `ui.*` surface deliberately
  not adopted).
- Jupyter-style cell list for the Celler view — chosen over two-pane-only
  and read-only-first variants.
- Kolonner auto-upgrades on marker presence (opt-in via using `#%%`) —
  folded into spec 1; no separate dropdown entry.
- Per-cell incremental run accepted incl. stale-state tradeoff; last-line
  display confirmed with the microdata exemption.
- Three specs: core (this) → widgets → presentation.
