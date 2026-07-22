# Småting-batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the six review-triaged hygiene items from the interactive-elements phase reviews (docs/ROADMAP.md "Fra fase 4-sluttreviewet" + "Fra fase-reviewene"), each with its reviewer-prescribed fix. NOT in scope: første-kjøring-racet (own design job), `ui.button` element-children and multi-payload auto-wrap (features, stay in backlog), `display-mode:"form"`.

**Architecture:** Independent micro-fixes grouped into three code tasks by file-cluster + one verification task. Every fix was prescribed by a named review — the plan quotes the prescription; implementers follow it.

**Tech Stack:** as per file: ES5 JS / R / MicroPython-safe Python; node --test + pytest.

## Global Constraints

- Each item lands with a test that pins it (except pure deletions). No behavior changes beyond the six items.
- `webr/ui.R` is FROZEN except "rene vedlikeholdsfikser" — the polite-error stubs are exactly that (and were spec-promised in 2026-07-21-explicit-containers-design.md §Out of scope); nothing else in the file may change.
- index.html: only the `UI_R_REGEX` line (find it near :8349) and the `M2PY_VERSION` bump in the final task. No template-literal zones; no backticks.
- Roadmap bookkeeping in the final task: tick the six items, annotate the two intentionally-remaining features, reword the M2PY-discipline line as a standing note (not a checkbox).
- Commit per task, Norwegian messages.

---

### Task 1: R polite errors + ui.grid raw-style fix

**Files:** `webr/ui.R` (stop-stubs only), `index.html` (UI_R_REGEX only), `shared/ui_core.py`, `tests/test_ui_module.py` (+ mirrored twins if the suite-idiom demands), R-side test if a suite exists (check `tests/` for ui.R coverage — if none exists, the browser spot in Task 4 is the gate; say so in the report).

1. **R polite errors** (fase-4 sluttreview L-1): add `|row|column|grid` to `UI_R_REGEX` in index.html and three `stop()` stubs in webr/ui.R following the EXISTING pattern at ui.R:284–307 (`ui_html`-family stubs: "støttes ikke i R ennå — bruk python-modusene"). Message names the python containers (`ui.row/ui.column/ui.grid`).
2. **`ui.grid(..., style="raw css string")`** (fase-4 sluttreview L-3): today a string `style=` REPLACES the computed dict, silently discarding `gridTemplateAreas`/`gridTemplateColumns` from the positional template. Fix per review: on the grid path, when `style` is a string, append the computed grid-template declarations to the cssText (semicolon-joined), so the template survives; keep dict-style merging as-is. Test: grid with template + string style → el_calls style contains BOTH the user css and gridTemplateAreas.

Commit: `fix(småting): høflig R-feil for containere (spec-lovet) + ui.grid bevarer templaten ved rå style-streng`

### Task 2: Display-policy corners in brython/micropython runners

**Files:** `brython/brython_runner.py`, `micropython/micropython_runner.py`, both runner test suites.

Reviewer-prescribed (fase-1 sluttreview + fase-3-era ledger), apply identically in BOTH runners (`_tail_suppressed` + the trailing-detection):
1. **Trailing comment defeats `_`-suppression**: `_navn  # kommentar` as trailing expression displays today. Fix: strip a trailing `#`-comment (outside quotes — a simple heuristic: only strip when the tail is a bare-name-plus-comment shape, i.e. regex-free check: split on '#' only if the pre-'#' part `.strip()` passes the existing identifier loop) before the underscore check.
2. **False positives on control-call tails**: `ui.slider(0,100) + 1` and `ui.slider(0,100).value` are muted today (prefix match) though they are not bare control calls. Fix per review: require the tail to END at the matching close-paren of the control call — walk the parens from the first `(` (reuse the runner's existing balanced-scan idiom if one exists; else a small counter loop) and require only whitespace (or a stripped comment) after it.
3. **Space before paren**: `ui.slider (0,100)` is NOT muted today (accepted corner) — while touching this code, allow optional whitespace between control name and `(` to close the corner cheaply.
4. **Element-mount divergence** (fase-3-era ledger Minor 2): a bare `_`-prefixed ui.html ELEMENT still mounts in brython/mpy (`_fmt` side-effect) but not in pyodide. Align to pyodide: when the tail is suppressed, SKIP `_fmt` entirely (revert the always-call pattern for the suppressed case only). This changes the old pin `test_execute_code_element_last_expression_mounts_no_blank_line` if it uses a `_`-named element — rename its variable to a non-underscore name (keeping its mount coverage) and ADD a twin test pinning that a `_`-named element does NOT mount (matching pyodide). Do this in both suites.

TDD throughout; both runner suites + full pytest green.
Commit: `fix(småting): demping-hjørner i brython/mpy — kommentar-hale, paren-slutt-krav, mellomrom-før-paren, _-element monteres ikke (pyodide-paritet)`

### Task 3: Test hygiene — pins, tripwire constants, dead placeholders

**Files:** `tests/test_display_policy.py`, `tests/test_ui_core_drift.py`, `shared/ui_core.py`.

1. **Two missing pyodide pins** (fase-1 sluttreview Minor 2): (a) suppression × echo mode — `show_commands=True` with a bare `ui.slider(...)` echoes the `>>> ` command but shows no value; (b) rules 3–4 under `only_last=True` — trailing `df.head();`-style and trailing bare control call both suppressed. Concrete asserts against the existing `run_block` harness.
2. **Tripwire Assign-blindness** (fase-3 sluttreview Minor 2): extend `_defs` to ALSO collect module-level `ast.Assign` targets whose RHS is NOT an `Attribute` access on `_core` (i.e. a local re-definition of a constant) — so SHARED entries like `HTML_TAGS`/`_SL_ACCEPTS` actually guard. Add `_HTML_TAG_SET` and the three `PICO_*` names to SHARED. Prove the trip: temporarily add `HTML_TAGS = "x"` to a facade → test fails; revert → passes (report the round-trip).
3. **Dead placeholders** (fase-3 sluttreview nit): delete `_register = None` and `_bind_handler_if_callable = None` from shared/ui_core.py's placeholder block (verified unused by any core code; facades configure only what core reads — verify with grep before deleting, and remove the corresponding kwargs from the facades' configure() calls IF they pass them — check).

Commit: `test(småting): manglende pins (demping × echo, regel 3-4 × only_last), snubletråd ser konstant-redefinisjoner, døde placeholders fjernet`

### Task 4: Verification + bookkeeping

1. Full suites: `python -m pytest tests/ brython/tests/ micropython/tests/ -q` + `node --test tests/js/*.test.js`.
2. `M2PY_VERSION` bump in index.html (shared/ui_core.py changed behaviorally in Task 1 — the roadmap's own standing rule).
3. Browser spot-checks: R mode `ui_row()` → polite Norwegian error (not "could not find function"); python `ui.grid("a b | c d", cols="1fr 1fr", style="background: papayawhip") ` still lays out areas; brython `_el = ui.html.p("x")` bare as trailing → does NOT mount; `ui.slider (0, 100)` bare with space → no scalar echo.
4. Roadmap: tick the six delivered items; annotate `ui.button`-element-children + multi-payload auto-wrap as deliberate features-in-backlog; convert the M2PY-discipline checkbox to a prose note ("håndhevet i fase 4b/5 og i denne batchen").
5. Ledger + commit `chore(småting): verifikasjon, M2PY-bump, roadmap-avhuking — batch levert`.
