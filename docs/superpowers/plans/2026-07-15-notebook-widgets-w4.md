# Notebook Widgets — W4 Implementation Plan (Colab `#@param` forms)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec 2 track 3: Colab-style `#@param` comment forms. A code-cell line `x = 3  #@param {type:"slider", min:0, max:10}` renders a form control above the cell; changing it **rewrites the literal in the canonical text** and (with `{run:"auto"}` semantics — see below) reruns the cell. Works in every notebook runtime by construction: the form edits text and reruns; it never touches a runtime.

**Architecture:** New `js/param-forms.js` (house pattern: pure half = parser + literal writer, node-tested; DOM half = a `.param-form` strip rendered during notebook cell rendering). Text edits go through a new `Cells.updateCellSource(idx, newSource)` (model + serialize + updateLineNumbers, reusing the existing onEdit flush machinery). Reruns via `Cells.runCell(idx)`. Controls: param-forms builds its own minimal native controls (third small duplication of builder code — note a `B2 dedup: felles builder-modul` comment; do NOT refactor ui.js/dash.js now).

## Global Constraints

- Zero effect on documents without `#@param` (parse gate per cell); zero effect outside notebooks (plain scripts: params are inert comments, exactly like Colab files opened in a plain editor).
- The reference grammar is `ipyform`'s reverse-engineering of Colab (github.com/phihung/ipyform) + the Colab forms example notebook. Supported in W4: `{type:"string"}` (+ bare array literal → dropdown; `allow-input:true` → editable), `{type:"boolean"}`, `{type:"number"}`/`{type:"integer"}`, `{type:"slider", min, max, step}`, `{type:"date"}` (native date input), `{type:"raw"}`. `#@title` and `#@markdown` are DEFERRED (documented). Unknown/unparseable meta → the line is left inert with a console.warn (never an error).
- **Run semantics decision:** Colab's `{run:"auto"}` reruns on change. We support it; WITHOUT it the form edits the text and marks the cell stale (the existing stale tint communicates "endret, ikke kjørt") — no auto-rerun. This is Colab-faithful.
- **Literal writing must be language-aware and loss-minimal**: replace ONLY the value expression between `=` and the `#@param` comment, preserving whitespace and the comment verbatim. Literal formatting per language: python `True/False/'str'/3/3.5`; R `TRUE/FALSE/'str'/3` (R docs use `x <- 3 #@param` — support both `=` and `<-` assignment); microdata/duckdb cells: out of scope for W4 (parse-gate on cell type python/r/brython-family; others inert).
- String quoting: single quotes, escape embedded quotes; NEVER eval user text — the parser treats the current value as an opaque string except for the control's own typed value.
- Style/test/commit conventions as prior phases. Baselines: node 272/4; pytest 677; facades 478.

---

### Task 1: `js/param-forms.js` pure half — parser + literal writer

**Files:** Create `js/param-forms.js`; Test `tests/js/param-forms.test.js`

**Interfaces produced (`window.ParamForms` + module.exports):**
- `parse(cellSource, lang) → [{lineIdx, varName, assignOp, valueRaw, meta:{type, options?, min?, max?, step?, allowInput?, runAuto?}, warnings}]` — scans lines for `^(\s*)([A-Za-z_]\w*)\s*(=|<-)\s*(.+?)\s*(#\s*@param\b(.*))?$` with `#@param` present; meta part: bare `["a","b"]` array (string dropdown), or `{...}` object in Colab's loose JSON (keys unquoted, values may be unquoted words — write a tolerant mini-parser, NOT JSON.parse alone; try JSON.parse first after quoting keys), or empty (type inferred from valueRaw: quoted→string, True/False/TRUE/FALSE→boolean, numeric→number, else raw). `run:"auto"` in the object → runAuto. Unknown type → warnings + null-entry skipped.
- `writeValue(cellSource, entry, newValue, lang) → newSource` — formats the literal per lang (`formatLiteral(newValue, meta.type, lang)`: string→`'…'` escaped; boolean→True/False (py) / TRUE/FALSE (r); number/integer/slider→numeric; date→quoted ISO string; raw→verbatim as typed) and splices it into exactly the value span of that line, preserving indent, assignment operator, spacing and the full comment.
- `currentValue(entry, lang) → typed js value` for seeding the control (unquote strings; parse numerics; booleans; raw → the raw string).

- [ ] Tests FIRST (node): each type parses (incl. bare-array form, allow-input, run:auto, `<-`, inferred types); loose-JSON metas (`{type:"slider", min:0, max:10, step:2}` unquoted keys); writeValue round-trips preserving comment/spacing byte-exact except the value; string escaping (`it's` → `'it\'s'`); non-param lines untouched; multiple params in one cell; malformed meta → warning + skipped.
- [ ] Implement; `node --test tests/js/*.test.js` → 272+new/4.
- [ ] Commit `feat(param): ren halvdel — #@param-parser og literal-skriver (Colab-grammatikk via ipyform)`.

### Task 2: DOM half + Cells integration

**Files:** Modify `js/param-forms.js` (DOM half), `js/cells.js` (`updateCellSource(idx, newSource)` + a render hook), `app.css`; Test stub-DOM `tests/js/param-forms-dom.test.js`

- `Cells.updateCellSource(idx, newSource)`: set the cell's source in the model, mark hasBody, serialize to `#scriptInput` (reuse the existing flush path — read onEdit/flushPendingEdit and factor or call), update line numbers, mark stale (the existing stale mechanism).
- Render hook: after a cell node is built (find the seam in cellNode/render — a post-build call `ParamForms.decorate(cellIdx, cellEl, source, lang)` guarded on `window.ParamForms`), parse; if entries: build `.param-form` strip as first child (BEFORE any `.ui-controls` strip; coexistence fine), one control per entry (own minimal builders: text/dropdown(+editable via datalist when allowInput)/checkbox/slider(+readout)/number/date), seeded from `currentValue`.
- Change wiring: control change → `writeValue` → `Cells.updateCellSource(idx, …)` → if runAuto → debounced (150 ms, sliders) `Cells.runCell(idx)`; else stale-tint only. IMPORTANT: after updateCellSource the cell's textarea content must reflect the new text (sync the visible editor — trace how render/onEdit keep ta.value in sync and update it in place WITHOUT rebuilding the cell node, else the form control you're dragging gets destroyed — same no-rebuild discipline as ui.js).
- Re-render/edit interplay: user edits the cell textarea manually → debounced re-parse must refresh the form controls' values (hook the existing onEdit debounce — a `ParamForms.refresh(cellIdx, source)` updating control values in place; structural param changes (added/removed lines) → rebuild the strip).
- CSS: `.param-form` strip styling on tokens (visually distinct from `.ui-controls` — a subtle 'skjema'-look, label左 kontroll høyre per Colab).

- [ ] stub-DOM tests: decorate builds controls seeded right; change → updateCellSource called with correctly spliced text; runAuto reruns via stubbed runCell, non-auto doesn't (stale only); manual textarea edit → refresh updates control value; no-param cell → no strip.
- [ ] Implement + include tag; suites green.
- [ ] Commit `feat(param): skjema-stripe i celler — tekst-splicing + run:auto`.

### Task 3: exit gate

- [ ] Example `examples/python/py_param_forms.txt` (label `# label: #@param-skjemaer (Colab-kompatible)`): md intro (Colab-notebooks med #@param virker; run:"auto" vs manuell; @title/@markdown kommer senere), cells demonstrating slider(run:auto), dropdown, boolean, string allow-input, date; one R-mode note in the md (R støttes: `x <- 3 #@param`). Manifest regen.
- [ ] Browser sweep (Playwright, fresh port): (a) example: forms render; slider drag with run:auto → the SOURCE LINE updates (verify via Rå tekst) AND output reruns; dropdown change without run:auto → text updates + stale tint, manual ▶ picks it up; (b) the same document round-trips through share-link (text canonical — forms rebuild); (c) an r-mode cell with `x <- 3 #@param {type:"slider", min:0, max:10, run:"auto"}` works end-to-end; (d) plain script with #@param → inert comments, runs unchanged; (e) coexistence: a cell with BOTH ui.slider and #@param renders both strips without interference; (f) both themes screenshot.
- [ ] Suites (node 272+new/4, pytest 677, facades 478); spec 2 Phasing → W4 done; W4 = siste W-fase: also mark track 3 done.
- [ ] Commit `docs+test(param): W4 exit gate — eksempel, sveip, spec-status`.
