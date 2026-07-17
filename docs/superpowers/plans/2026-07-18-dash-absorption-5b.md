# Dash Rewrite + Removal 5b Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the 13 dash documents as cell/ui documents, then remove dash entirely — per `docs/superpowers/specs/2026-07-18-dash-absorption-design.md` §§6-7. This completes the ENTIRE unified document model.

**Architecture:** Rewrites first (each browser-verified in its engine — equivalent functionality via `ui.*`/`ui.html`/`ui.kpi`/`ui.play`/`cols=`/`ui.widget`), removal LAST against the 5a final review's verified grep-list, then a full post-removal regression matrix.

## Global Constraints

- Functionality survives; the dash API does not. Each rewritten example must demonstrate the same capability (controls, KPIs, plots, layout, interactivity) — not merely run.
- Removal only AFTER every rewrite is browser-verified. After removal: zero `Dash`/`dash` code references outside comments/history (grep gate); `Ui.renderPayload` treats `node` as unknown (already true).
- R rewrites use native plots/tables (no R payload builders — spec §3); K2 URL-state dies (spec-sanctioned).
- ES5/Norwegian/`t()`; index.html changes browser-smoked in-task; rerun ×3 standard.
- Baselines: node 707/711 + 4 known ENOENT; pytest 1586 + 1 known. Removal SHRINKS these (dash tests die) — record the new baselines precisely.

---

### Task 1: Rewrite pyodide + micropython + R dash examples

**Files:** Rewrite `examples/python/py06_dashboard.txt`, `examples/micropython/03_dashboard.txt`, `examples/r/r09_dashboard.txt`; DELETE `examples/ex_dashboard_iris.py`, `examples/_unlinked/ex_dashboard_iris.txt`, `ex_dashboard_jobb.r` (repo root, loose); manifest regen (additive/removals only for these).

Each rewrite: a `#%%`-document with md intro, `cols=` where the original had a grid, `ui.slider/dropdown/play` controls with `on_change` targeting a plot cell (`#tag.id`), `ui.kpi` for the KPI cards, plotly/native plots. R: `ui_slider`+`ui_play` + native plot/table cells (no kpi builder — a small md/html KPI or plain output; document the choice). Keep `# label:`/`#options` conventions. Browser-verify EACH in its engine (controls drive the plot; kpi renders; play animates; rerun ×3). Commit `docs(eksempler): dash-dokumentene omskrevet — pyodide/mpy/R (celle/ui-modellen)`.

### Task 2: Rewrite the 7 brython dash examples

**Files:** `examples/brython/bry10_dashboard_iris.txt`, `bry11_dashboard_salg.txt`, `bry17_dashboard_kostnad.txt`, `bry18_dashboard_fordeling.txt`, `bry19_dashboard_regresjon.txt`, `bry20_dashboard_rapport.txt`, `bry22_dashboard_duckdb.txt`; manifest regen.

Same recipe (brython engine; bry22 keeps its duckdb-bridge usage via `import duckdb` in cells). Browser-verify each (batch smoke acceptable: load each, Kjør alle, one interaction). Commit `docs(eksempler): dash-dokumentene omskrevet — brython ×7`.

### Task 3: The removal

**Files:** DELETE `pyodide/dash.py`, `brython/dash.py`, `micropython/dash.py`, `webr/dash.R`, `js/dash.js`, `js/dash-webr.js`, `css/dash.css`, `tests/js/dash.test.js`, `tests/js/dash-webr.test.js`, `tests/test_pyodide_dash.py`, `micropython/tests/test_dash_mpy.py`, `micropython/tests/mpy_smoke_dash.py`. MODIFY per the 5a-final-review grep-list: index.html (css link :11, script tags :581+dash-webr, `__ensurePyDash` ~8755 + preRun call ~3232, DashWebR sites 8506-8717 + invalidateDefs ~3281, `Dash.sweepDisconnected` caller ~10459, publish comment ~2119), js/cells.js (`Dash.sweepDisconnected` ~2006 + the `.dash` half of the two-half markers — `data-ui-shown` becomes the single contract; update comments), js/ui.js (`Ui.formatNumber` fallback guard in… no, that guard is in dash.js and dies; the `_figures` prune-on-push improvement; any `_loadDash` remnants/comments), engine JS (LIB_REGISTRY dash entries ×2), `pyodide/ui.py` `_reap`-adjacent? (dash's `_reap` dies with dash.py — verify ui's own proxy hygiene stands alone).

Gate BEFORE committing: `grep -rn "Dash\b\|dash\.js\|dash\.py\|dash\.R\|DashWebR" --include="*.js" --include="*.html" --include="*.py" --include="*.R" js/ index.html pyodide/ brython/ micropython/ webr/ | grep -v "test\|\.md"` → only comment/history hits acceptable (list them). Suites at NEW baseline (record). Browser smoke: a python doc + a brython doc + plain scripts run clean; the REWRITTEN examples still work; no console errors about missing Dash. Commit `feat(fjern): dash fjernet — adaptere, motor, tester, markør-unifisering (data-ui-shown alene)`.

### Task 4: Final exit gate — the whole målbilde

Full regression matrix post-removal (port 8871): all 10 rewritten examples; py_ui_html/py_widgets_ui/py_param_forms/py_plain_widgets/py_presentasjon/py_tag_direktiver; notebook core (cursor-run, selection, gutter, slot coupling, presentation, skrittvis); publish (mpy notebook incl. kpi/play); share link untrusted gate; plain scripts all four engines; both themes; rerun ×3 combined docs. Suites (new baselines). Spec: `**Status 5b:** DELIVERED <date> — dash fjernet; HELE MÅLBILDET KOMPLETT.` + update `2026-07-16-unified-document-model-notes.md` with a completion header line. Cache: sw v27, ui.js/cells.js ?v= bumps. Commit `feat(ui): fase 5 komplett — dash fjernet, målbildet levert`.
