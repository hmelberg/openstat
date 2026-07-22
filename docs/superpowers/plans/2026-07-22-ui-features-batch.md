# UI Features Batch: button element-children + multi-payload area-add

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The two deliberate features-in-backlog from docs/ROADMAP.md: (a) `ui.button` accepts element children (spec 2026-07-21 decision 9's optional nicety), (b) `.add([v1, v2], area=...)` renders EVERY payload (auto-wrap in a column) instead of only the last.

## Design (settled here — no separate spec; both were pre-described in the phase-4 spec/reviews)

**(a) `ui.button(*children, ...)`** — backward compatible: today's `ui.button("Run", ...)` (single string) is unchanged. New: positional args may be a MIX of strings and `ui.html` Elements: `ui.button(ui.html.b("Run"), " now", on_click=fn)`.
- Facade (mirrored 3×): `button(*children, rerun='self', on_click=None, name=None, placement=None, into=None)` — first collect children; the JOINED plain-text of string children becomes `spec.label` (fallback for JS-side text paths and accessibility); Element children's el-ids go in `spec.label_els` = ordered list of `{"el": id}` / `{"text": s}` items (same child-vocabulary as `elAppend`) so ORDER is preserved across mixed content. Guard: `label` must be non-empty OR label_els non-empty → else TypeError (today's `button(label)` requires label — keep an equivalent loud failure).
- JS (`_buildButton` + the `existing` update branch in `_registerInto`): when `spec.label_els` present, build the button EMPTY and append per item (text → createTextNode, el → `_els`-lookup node; unknown el-id → warn + skip). The update branch today does `existing.wrap.textContent = label` — extend: when label_els present, clear and re-append (children may have been re-created this run; same _els-resolution). Play/other builders untouched.
- Out of scope: element children on other controls (only button — it is the one with free-form content).

**(b) multi-payload `.add`** — in the facades' `Element.add` area-branch (mirrored 3×): when the children list contains MORE THAN ONE payload-value (non-Element/non-str), or a mix of values and elements, wrap the AREA content in a generated stack: clear the area child once, create one sub-div per child IN CALL ORDER (element children appended into their own sub-div too — this also fixes the documented payload-before-elements ordering wart), payload-render each value into its sub-div. Single-value and element-only calls keep today's exact code path (no wrapper div — zero regression surface). The stack uses class `os-col` (existing container CSS) on a plain generated div.
- Docstring: replace the "only the last shows" caveat with the new semantics.

## Global Constraints

- Facade edits mirrored 3× (drift tripwire guards; recalibrate floors only if measured below — report ratios).
- Without the new inputs, behavior byte-identical: existing suites pass unchanged (label-only buttons, single-payload area-adds).
- ES5/Norwegian in JS; MicroPython-safe Python. `?v=`/M2PY bumps in the final verification (js/ui.js + core/facades change).

### Task 1: `ui.button` element-children (JS + facades, TDD)
Files: `js/ui.js`, `tests/js/ui-dom.test.js`, three facades, three facade suites.
Steps: JS tests first (label_els build order incl. mixed text/el, unknown-id warn+skip, update-branch re-append on re-registration keeping SAME button node, plain-label path byte-unchanged); then facade tests (spec assembly: label = joined strings, label_els ordered items, TypeError on empty, Element extraction via `_openstat_el_id`); implement; all suites green; commit `feat(ui): ui.button med element-barn — label_els i spec, ordnet miks av tekst/element, oppdatering re-appender (fase 4-beslutning 9-opsjonen)`.

### Task 2: multi-payload area-add (facades, TDD)
Files: three facades (+ shared/ui_core.py only if helpers needed), three facade suites.
Steps: tests first (two values → two sub-divs in order via el_calls, mixed element+value preserves call order, single value → today's exact call sequence pinned unchanged, docstring updated); implement; suites green; commit `feat(containere): .add med flere payloads i område — auto-stakk i kildeorden (og miks bevarer rekkefølgen); enkel-verdi-stien uendret`.

### Task 3: Verification
Full suites; `?v=` bump js/ui.js + M2PY bump (facades changed behaviorally); quick browser spot (button with bold child clicks+reruns; `.add([df.head(3), df.tail(3)], area="a")` shows both); docs one-liner in interactive-elements.html (button children + updated .add caveat); roadmap tick; ledger; commit.
