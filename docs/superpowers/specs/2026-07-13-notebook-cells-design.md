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

**Notebook is a document property, not a view mode** (revision 2026-07-13):
a document containing at least one `#%%` marker *is* a notebook; without
markers it is a script. The existing view modes (Kolonner, Stablet, Kun
output, Skrittvis) stay unchanged in the dropdown — each simply gets a
notebook rendering when the document is a notebook (see §3). There is no
new view mode and no separate "cell mode" toggle; typing `#%%` is the
opt-in.

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
- **DOM half**: the notebook renderer — one cell-list component with three
  CSS layouts (columns / stacked / output-only), per-cell editors and
  output slots, the raw-text toggle, and the notebook-detection hint.

Hooks into existing `index.html` code are deliberately thin:

| Touch point | Change |
|---|---|
| view-mode dropdown (~3426) | route Kolonner/Stablet/Kun output to notebook layouts when a notebook is active (~10 lines) |
| marker normalizer (~7413) | `## lang` → `#%%` mapping (~10 lines) |
| embedded Python core (~6815) | guarded `display='last'` flag (~10 lines) |
| output rendering | render-target threading (§5 — the designated hard part) |

CSS lives in `app.css` (additive). Everything else is new files.

## 3. Views

Notebook rendering maps onto the **existing** view modes:

| View | Script (no markers) | Notebook (`#%%` present) |
|---|---|---|
| Kolonner | editor left, output right | one scrolling list; each cell is a grid **row**: input cell left, its output cell right — alignment is free because input and output share a row; md/html cells span the full width |
| Stablet | editor top, output bottom | classic Jupyter: input cell with its output cell directly beneath |
| Kun output | output only | output cells only — md/html rendered, code hidden: the report/publish view (and the substrate for spec 3's presentation mode) |
| Skrittvis | blank-line block playback | cell-by-cell playback (**phase B**; phase A keeps today's behavior) |

### 3.1 Notebook renderer

One renderer (the `cells.js` DOM half) with three CSS layouts — there is no
separate "Jupyter view" component. Per cell: header chip (type + attrs),
auto-sizing source editor, output slot. Details:

- **md/html cells** render by default; double-click flips to the editor,
  blur re-renders.
- **`hide-code`** shows output only (an unobtrusive affordance reveals the
  code); **`hide-output`** the inverse; **`skip`** cells are dimmed and
  never executed.
- **`style=note|warn|card`** applies preset frames/backgrounds to the cell.
- **Phase B:** hover toolbar (run, add above/below, delete, move up/down,
  change type, split/merge as in §1), Shift+Enter = run + advance,
  Ctrl/Cmd+Enter = run in place, stale tint on cells edited since last run.
- Edits serialize back to the canonical text (debounced); switching view
  modes is always lossless (the text is authoritative).

### 3.2 Raw-text escape and transitions

- **"Rå tekst" toggle** (visible only when the document is a notebook):
  switches to the ordinary script editor and back. Bulk edits,
  search/replace, and cross-cell selection live there — it compensates for
  losing the single continuous buffer in notebook rendering. While the raw
  override is on, auto-notebook is suppressed.
- **Managed transitions:** notebook rendering engages at document load
  (restore, share link, examples). While typing in the raw editor, a
  debounced detector shows a discreet hint ("Notatbok oppdaget — vis som
  celler") instead of flipping the editor mid-keystroke.

### 3.3 Mode support (phase A)

Notebook rendering engages in **python / r / duckdb / microdata** modes
(the hybrid-segment family). In other modes (brython, micropython, statx,
jamovi) `#%%` lines are inert comments and the document renders as a plain
script, until those runners gain cell support in a later phase.

## 4. Execution

### Document → runnable text

Before a run, the notebook text is transformed (pure function in
`cells.js`): each **code cell's** `#%%` header line is rewritten to the
corresponding legacy segment marker (`## python`, `## r`, …) so the
existing hybrid pipeline segments it; each **non-code cell's** (md/html/
skip) header and body lines are replaced by *blank lines*. Line counts are
preserved exactly, so error line numbers still point into the real
document. The runtime never sees non-code content — md/html cells are
rendered by the view layer, not the engine. A document without markers
passes through unchanged.

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

**Moved from Phase B into Phase A** (user decision 2026-07-14, first
hands-on test): notebook cell output follows notebook conventions — a cell
shows only its last expression's value, and the `>>>` command echo is OFF
in notebook runs (reusing the existing `show_commands` mechanism). The
implicit preamble cell keeps show-all.

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

- **Phase A — parser + notebook rendering on Run All only.** `cells.js`
  pure half (parse/serialize/runnable-text transform) with full test
  coverage; the notebook renderer with all three layouts; raw-text toggle
  and detection hint; "run" is today's whole-document run, with per-cell
  output attribution via the existing JS segment loops (python/duckdb/
  microdata; R falls back to a combined trailing slot if its runner proves
  single-shot); an example notebook; and (added 2026-07-14) the notebook
  display policy — last-expression-only output + `>>>`-echo off in
  notebook runs. Independently shippable.
- **Phase B — per-cell run.** Sessions, hoisted loads, full render-target
  threading (§5, incl. dashboards/enhancers), per-cell run buttons +
  keyboard shortcuts, Run above/Restart, stale tint, cell toolbar editing
  operations, skrittvis cell playback.

If phase B stalls, phase A remains a shippable feature.

## 7. Compatibility, sync, risks

- **Gating:** all new code paths require `#%%` markers (plus a supported
  mode, §3.3). No markers = no new code executes; the app is
  pixel-identical to today.
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
- **Revision (same day):** notebook is a *document property* derived from
  `#%%` presence, not a view mode — the existing view modes each get a
  notebook rendering (Kolonner = aligned input|output grid rows, Stablet =
  Jupyter-style, Kun output = report view). This replaced the earlier
  "fifth view mode + Kolonner upgrade" design: conceptually cleaner, one
  renderer instead of two, and the single-buffer gutter-overlay machinery
  is dropped in favor of a "Rå tekst" escape toggle.
- Per-cell incremental run accepted incl. stale-state tradeoff; last-line
  display confirmed with the microdata exemption.
- Three specs: core (this) → widgets → presentation.
