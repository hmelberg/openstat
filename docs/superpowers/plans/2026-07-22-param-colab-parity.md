# Param Colab Parity (#@title / #@markdown) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `docs/superpowers/specs/2026-07-22-param-colab-parity-design.md` — render Colab's `#@title` (heading + cell-wide run-default meta) and `#@markdown` (prose rows, source-ordered) in the param form strips; `//@` dialect in JS mode; `display-mode` parsed-and-warned (deferred).

**Architecture:** Entirely in `js/param-forms.js` + its two test files. `ParamForms.parse` gains `kind` on entries (`"param"` for today's, plus `"title"`/`"markdown"`); the DOM half renders the new kinds as inert rows (no inputs, no write-back) interleaved by `lineIdx` in the cell's default-placement strip, title always first. Markdown text renders via `global.Ui && Ui.renderPayload({kind:'markdown', text:...}, host)` with a `textContent` fallback when `Ui`/markdownit is absent (node tests). Title-line meta `{run:"manual"}` becomes the cell default for params without their own `run:`; `display-mode` warns + ignores. The `entries`/`builtEntries` structural comparison treats kind+text as structure (changed markdown text → rebuild).

**Tech Stack:** ES5 JS, Norwegian comments; node --test.

## Global Constraints

- `#@param` behavior byte-frozen: all existing param tests pass unchanged (only additions to test files).
- `#@title` requires the marker immediately after the comment token (`#@title`/`//@title`) — `# @title` stays a plain comment (Colab-compatible strictness; same family as the existing `(?:#|\/\/)\s*@param` — NOTE the existing param regex allows `# @param`; mirror THAT tolerance instead if and only if a quick Colab check shows Colab also tolerates it for params — decide by matching the EXISTING LINE_RE tolerance for consistency within OpenStat, and document the choice in the code comment).
- Title/markdown rows carry NO write-back: `_commit`, `writeValue`, and the run-chip logic must ignore them; the run-chip still appears per its existing rules when a MANUAL param (incl. manual-by-title-default) commits.
- Placement: new kinds always render in the cell's default strip (`_cellDefaultPlacement`); params keep per-line placement. Title first, then rows by `lineIdx`.
- Structural comparison: `kind` and `text` participate; a markdown text edit rebuilds the strip (verify against how `refresh`/`syncSource` compare `builtEntries` today — read that machinery FIRST; do not weaken its parallelism invariant between `controls[i]` and `builtEntries[i]` — decide explicitly whether non-param entries live in the same list with null controls or a parallel list, and document why).
- ES5, Norwegian comments. No changes outside `js/param-forms.js`, its two test files, and (final task) docs/examples/`?v=`.

---

### Task 1: Parse — `kind` entries, title meta, dialects

**Files:**
- Modify: `js/param-forms.js` (parse half)
- Test: `tests/js/param-forms.test.js`

- [ ] **Step 1 (TDD):** Add parse tests: title with text only; title with `{run:"manual"}` meta (→ entry meta captured + exported cell-default surfaced however parse exposes it — design: `ParamForms.parse` returns the entries array as today, with title entries carrying their meta; a helper `ParamForms.cellRunDefault(entries)` returns `"auto"`/`"manual"`); title with `display-mode` → warning recorded + field ignored; second title → warn + ignored (not in entries); markdown lines in order with text preserved (leading/trailing space trimmed); `//@title`/`//@markdown` when `lang` indicates JS (match how LINE_RE handles the `//` today — it is lang-independent; keep that); param entries now carry `kind:"param"` and ALL existing parse tests still pass unchanged; run-default inheritance: param without `run:` in a manual-title cell → effective manual (test via the exported helper or effective-meta field, per your design), param with explicit `run:"auto"` overrides.
- [ ] **Step 2:** Run — new fail, old pass. **Step 3:** Implement (new `TITLE_RE`/`MD_RE` alongside `LINE_RE`; reuse `balancedSpan`/`looseJsonParse` for the title meta). **Step 4:** Full param suite green. **Step 5:** Commit `feat(params): parse #@title/#@markdown (+//@-dialekt) — kind-entries, tittel-meta som celle-default for run, display-mode varsles og utsettes`.

### Task 2: DOM — render title/markdown rows, no write-back, structural refresh

**Files:**
- Modify: `js/param-forms.js` (DOM half)
- Test: `tests/js/param-forms-dom.test.js`

- [ ] **Step 1 (TDD):** DOM tests: title renders first as `.param-form-title` with the text; markdown rows `.param-form-md` interleaved by lineIdx among param rows in the default strip; markdown renders via a stubbed `global.Ui.renderPayload` (assert kind:"markdown" + text) with textContent fallback when Ui absent; rows have no inputs and `_commit`-related state untouched; editing a markdown line's TEXT via `syncSource`+`refresh` rebuilds the strip (structure change); manual-by-title cell: changing a param shows the run-chip (existing chip tests as model); params with per-line `placement` still land in their strips while title/md stay in the default strip.
- [ ] **Step 2–4:** fail → implement → full JS suite green. **Step 5:** Commit `feat(params): #@title/#@markdown rendres i skjemastripen — tittel først, markdown i kildeorden, ingen write-back; markdown via Ui.renderPayload med tekst-fallback`.

### Task 3: Docs, example, sweep, delivery

**Files:**
- Modify: `docs/interactive-elements.html` (Level 1 section: add title/markdown to the syntax example + one bullet), `docs/ROADMAP.md` (tick the two Colab items; leave `display-mode` unticked with a note), `index.html` (`?v=` for js/param-forms.js only)
- Create: extend ONE existing param example (`examples/javascript/js06_params.txt` gets `//@title`+`//@markdown`; `examples/python/py_param_forms.txt`-equivalent gets `#@title`+`#@markdown` — find the actual python param example filename first) — no new files; regenerate manifest only if labels changed (they should not).

Steps: docs edits; example edits (keep them runnable); full suites (`node --test tests/js/*.test.js`, `python -m pytest tests/ -q`); browser sweep — python cell with title+markdown+params renders Colab-shaped form (title heading, prose, controls in order), run-default from title-meta honored (manual → chip), JS-mode twin works, a REAL pasted Colab form snippet renders sanely, both themes; `?v=` bump; spec Status → DELIVERED; commit `docs+chore(params): Colab-paritet levert — docs, eksempler, ?v=; spec markert levert`.
