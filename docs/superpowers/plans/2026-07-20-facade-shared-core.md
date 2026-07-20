# Facade Shared Core (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 3 of `docs/superpowers/specs/2026-07-20-unified-interactive-elements-design.md` (as revised 2026-07-20): extract the provably-identical facade logic into one `shared/ui_core.py` used by all three Python runtimes, add a twin-drift tripwire test for what stays mirrored, and freeze `webr/ui.R` as documented legacy.

**Architecture:** The three facades (`pyodide/ui.py` 1380 lines, `brython/ui_brython.py` 1305, `micropython/ui_mpy.py` 1401) mirror each other by hand. Function-level analysis (2026-07-20) shows ~260 code lines byte-identical (tables + pure helpers + several API functions) and ~220 near-identical; the heavy functions are dialect-entangled and STAY per-facade. `shared/ui_core.py` holds the identical set; dialect symbols the moved functions call (`_register_value`, `_ui`, `_warn`-sink, …) are injected via `ui_core.configure(...)` — the core never imports `js`/`browser`/jsffi. Loading: pyodide's `__ensureUi` fetches the core file too; the brython/micropython engines' lib registries gain an optional `path` field so `ui_core` resolves to `shared/ui_core.py` and becomes a `deps` entry of the ui module. The 490 existing facade tests are the behavioral contract and must pass unchanged.

**Tech Stack:** Python (CPython-testable, MicroPython-compatible subset — the moved code already runs under all three runtimes today), ES5 JS for the two engine files, pytest + node --test.

## Global Constraints

- **Zero behavior change.** The 490 facade tests (`tests/test_ui_module.py` 170, `brython/tests/test_ui_brython.py` 160, `micropython/tests/test_ui_mpy.py` 160) must pass with NO assertion changes — only harness wiring (making `import ui_core` resolvable) may be touched in them.
- `shared/ui_core.py` must not import `js`, `browser`, `pyodide.*`, or any jsffi module, and must not reference `window` directly. Every dialect dependency is a module-global placeholder set by `configure(...)`. MicroPython compatibility: no f-strings beyond what the current facades already use, no `dataclasses`, no `typing` imports (the moved code is copied verbatim from files that already run under MicroPython, so this is automatic — do not "modernize" anything while moving it).
- **Late binding + reconfiguration safety:** core functions must read injected symbols at CALL time (module-global lookup), and `configure()` must be idempotent. Rationale: in the browser each runtime has its own interpreter, but under pytest ALL THREE facades load into one CPython process — each facade test file must (re)load its facade so that `configure()` re-runs before that facade's tests use core functions. Verify each facade test file's existing load pattern and add a reload if it imports the facade only once at module level.
- Facades keep their public API byte-compatible: `ui.play`, `ui.kpi`, etc. remain attributes of the facade module (bound from core), so `from ui import play` and the engines' alias machinery keep working.
- index.html may be edited ONLY in the `__ensureUi` function (plain-JS zone) — nowhere near the Python template literal (backtick hazard; phase 1 taught us the failure mode). No backticks in any string added to index.html.
- ES5 var-style + Norwegian comments in JS; Norwegian comments in moved-code files preserved as-is (do not rewrite comments while moving).
- `webr/ui.R` gets ONLY a header comment (freeze notice) — no code changes.
- Commit after every task, Norwegian messages.

## File map

- Create: `shared/ui_core.py`, `tests/test_ui_core_drift.py`
- Modify: `pyodide/ui.py`, `brython/ui_brython.py`, `micropython/ui_mpy.py`, `js/brython-engine.js` (registry + fetch), `js/micropython-engine.js` (same), `index.html` (`__ensureUi` only), `webr/ui.R` (header), the three facade test files (harness wiring only), `docs/superpowers/specs/2026-07-20-unified-interactive-elements-design.md` (status)

---

### Task 1: `shared/ui_core.py` (injection-free subset) + pyodide integration

Start with the zero-risk subset — constants and pure helpers that need NO injected symbols — and get the full load chain working for the reference runtime (pyodide) plus its test suite.

**Files:**
- Create: `shared/ui_core.py`
- Modify: `pyodide/ui.py`, `index.html` (`__ensureUi`), `tests/test_ui_module.py` (harness wiring only)

**Interfaces:**
- Produces: module `ui_core` with (this task) `HTML_TAGS`, `_HTML_TAG_SET`, `_SL_ACCEPTS`, `PICO_COMPONENT_CLASSES`, `PICO_HTML_ELEMENTS`, `PICO_UTILITY_CLASSES`, `_snake_to_camel(name)`, `_json_safe(value)`, `_spec(type_, **kwargs)` — all moved VERBATIM from `pyodide/ui.py` (:625, :640, :1241, pico tables, :653, :665, :110) — plus an (as yet mostly empty) `configure(**kwargs)`/placeholder scaffold that Task 3 fills:

```python
"""ui_core - delt fasadekjerne for pyodide/brython/micropython (fase 3,
spec 2026-07-20 §Phase 3 revidert). KUN dialektfri kode: aldri import av
js/browser/jsffi, aldri direkte window-referanse. Dialekt-symboler
injiseres av HVER fasade via configure() - kjernefunksjonene slår dem opp
ved KALLTID (sen binding), slik at pytest (én CPython-prosess, tre
fasader) alltid ser den sist konfigurerte fasadens dialekt etter dens
egen (re)import."""

# ---- injiserte dialekt-symboler (settes av configure) -------------------
_register = None
_register_value = None
_bind_handler_if_callable = None
_ui = None
_warn_sink = None


def configure(**kwargs):
    """Fasaden kaller configure(register=..., register_value=..., ...) ved
    import. Idempotent: hvert kall overskriver forrige (riktig under
    pytest der tre fasader deler prosessen og re-importeres per test)."""
    g = globals()
    for k, v in kwargs.items():
        g['_' + k] = v
```

- pyodide facade change: `_scalar` stays facade-side (numpy is a pyodide concern); the facade deletes its own copies of the moved names and binds them:

```python
import ui_core as _core
_core.configure()  # ingen injeksjoner trengs for Task 1-settet
HTML_TAGS = _core.HTML_TAGS
_HTML_TAG_SET = _core._HTML_TAG_SET
_SL_ACCEPTS = _core._SL_ACCEPTS
PICO_COMPONENT_CLASSES = _core.PICO_COMPONENT_CLASSES
PICO_HTML_ELEMENTS = _core.PICO_HTML_ELEMENTS
PICO_UTILITY_CLASSES = _core.PICO_UTILITY_CLASSES
_snake_to_camel = _core._snake_to_camel
_json_safe = _core._json_safe
_spec = _core._spec
```

CAVEAT for `_spec`: the pyodide version coerces numeric kwargs through `_scalar` (numpy). Read `_spec` in all three files first — the analysis marked it identical, so all three call `_scalar`; therefore `_scalar` must be an INJECTED symbol after all: move `_spec` verbatim (it references `_scalar`), add `_scalar` to the placeholder list, and have each facade pass its own `_scalar` in `configure(scalar=...)` — with the core's `_spec` body edited in exactly one way: `_scalar(v)` → `_scalar(v)` still works because the placeholder global is named `_scalar`. (I.e. add `_scalar = None` to the placeholders and pass it from each facade.)

- [ ] **Step 1: Write the failing test wiring (in `tests/test_ui_module.py`)**

Add, next to the file's existing path setup (read the top of the file first — it loads `pyodide/ui.py` via `importlib` with stubbed `js`):

```python
# fase 3: fasaden importerer ui_core fra shared/ — gjør den importerbar
# FØR fasade-lastingen (samme mekanisme i alle tre fasade-suitene).
_SHARED = str(pathlib.Path(__file__).resolve().parents[1] / "shared")
if _SHARED not in sys.path:
    sys.path.insert(0, _SHARED)
```

And one new test:

```python
def test_fase3_core_delt_kilde():
    """Fasaden re-eksporterer kjernesymbolene fra ui_core — samme objekt,
    ikke en kopi (dedup-beviset)."""
    import ui_core
    ui = load_ui()  # bruk filens eksisterende fasade-laster-helper (navnet kan avvike — se filens andre tester)
    assert ui.HTML_TAGS is ui_core.HTML_TAGS
    assert ui._snake_to_camel is ui_core._snake_to_camel
    assert ui._spec is ui_core._spec
```

- [ ] **Step 2: Run to verify it fails**

Run: `python -m pytest tests/test_ui_module.py -q`
Expected: the new test FAILS (`ModuleNotFoundError: ui_core` or attribute mismatch); the 170 existing pass

- [ ] **Step 3: Create `shared/ui_core.py` and slim the pyodide facade**

Move the listed defs VERBATIM (docstrings and Norwegian comments included) from `pyodide/ui.py` into `shared/ui_core.py` under the scaffold shown above; delete them from the facade and add the import/bind block. `configure(scalar=_scalar)` from the facade (per the `_spec` caveat).

- [ ] **Step 4: Run the pyodide facade suite**

Run: `python -m pytest tests/test_ui_module.py -q`
Expected: 171 pass

- [ ] **Step 5: Wire browser loading in `__ensureUi` (index.html)**

Read the `__ensureUi` function first (search `async function __ensureUi`). It fetches `pyodide/ui.py` and materializes it for `import ui`. Add, BEFORE the ui.py step and modeled on its exact fetch/write idiom: fetch `shared/ui_core.py` and write it as `ui_core.py` in the same location/mechanism, so the facade's `import ui_core` resolves. Same graceful-failure convention as the surrounding code (console.warn, no abort). No backticks in added strings.

- [ ] **Step 6: Full suites**

Run: `python -m pytest tests/ -q` and `node --test tests/js/*.test.js`
Expected: all pass (738 js; python count grows by 1)

- [ ] **Step 7: Commit**

```bash
git add shared/ui_core.py pyodide/ui.py index.html tests/test_ui_module.py
git commit -m "feat(fase3): shared/ui_core.py — injeksjonsfritt delsett (tabeller + rene hjelpere) + pyodide-integrasjon (__ensureUi henter kjernen)"
```

---

### Task 2: brython + micropython integration

**Files:**
- Modify: `js/brython-engine.js` (LIB_REGISTRY ~:38 + `fetchText('brython/' + name + '.py')` ~:136), `js/micropython-engine.js` (same pattern, registry ~:23), `brython/ui_brython.py`, `micropython/ui_mpy.py`, `brython/tests/test_ui_brython.py`, `micropython/tests/test_ui_mpy.py` (harness wiring only)

**Interfaces:**
- Consumes: `ui_core` module shape from Task 1.
- Produces: registry entries support optional `path`; `ui_core` registered before the ui module in both engines.

- [ ] **Step 1: Test wiring + shared-source test in both facade suites (failing first)**

Same `sys.path` insertion of `shared/` as Task 1 Step 1 (adapt the path: these files live one level deeper — `parents[2] / "shared"`), plus the same `test_fase3_core_delt_kilde` test adapted to each file's facade-loader helper.

- [ ] **Step 2: Run to verify the new tests fail, old pass**

Run: `python -m pytest brython/tests/test_ui_brython.py micropython/tests/test_ui_mpy.py -q`

- [ ] **Step 3: Slim both facades**

Same move as Task 1 Step 3: delete the facade-local copies of the Task-1 set, add `import ui_core as _core`, `_core.configure(scalar=_scalar)` (each facade passes its OWN `_scalar` — brython/mpy's versions differ from pyodide's, that is fine, it's an injected dialect symbol), and the bind block. Do NOT touch any function the analysis did not mark identical.

- [ ] **Step 4: Engine registry `path` support (both engines)**

In `js/brython-engine.js`: registry entries gain an optional `path`; the fetch site (~:136) becomes:

```js
      var source = await fetchText(entry.path || ('brython/' + name + '.py'));
```

(read the surrounding code — `entry` may need to be fetched from LIB_REGISTRY at that point; adapt variable names to what is in scope). Add the entry and dep:

```js
    // fase 3 (spec 2026-07-20): delt fasadekjerne — én fil for alle tre
    // python-runtimene; path-feltet overstyrer katalogkonvensjonen.
    ui_core:                { aliases: [], deps: [], js: [],
                              path: 'shared/ui_core.py' },
```

and change `ui_brython`'s entry to `deps: ['ui_core']`. Mirror both edits in `js/micropython-engine.js` (`ui_mpy` gets `deps: ['ui_core']`; fetch path convention there is `micropython/<key>.py` — read it first).

- [ ] **Step 5: Run everything**

Run: `python -m pytest tests/ brython/tests/ micropython/tests/ -q` and `node --test tests/js/*.test.js`
Expected: all pass (the js suites cover the engines' registry scan logic — if any engine test pins the registry shape, update per its own conventions and say so in the report)

- [ ] **Step 6: Commit**

```bash
git add brython/ micropython/ js/brython-engine.js js/micropython-engine.js
git commit -m "feat(fase3): brython/micropython på delt ui_core — path-felt i lib-registrene, deps-lasting før ui-modulen"
```

---

### Task 3: Move the injected-dependency identical functions

The rest of the byte-identical set — functions that call facade-dialect symbols. Analysis list (all marked identical modulo comments): `_warn`, `_append_children`, `_tag_builder`, `kpi`, `markdown`, `play`, `run_button`, `run_cell`, `widget`, `html` (the `_HtmlNamespace` INSTANCE binding stays facade-side if the class is dialectal — verify: the class was 0.9, the instance line `html = _HtmlNamespace()` was identical; move only what is clean).

**Files:**
- Modify: `shared/ui_core.py`, all three facades, no test-assertion changes

**Interfaces:**
- Consumes: `configure()` placeholder pattern from Task 1.

- [ ] **Step 1: For each candidate function, verify identity yourself before moving**

Run this from the repo root — it is the same analysis that produced the candidate list; only move functions it reports IDENTICAL today:

```bash
python3 - <<'EOF'
import ast, re
files = ['pyodide/ui.py','brython/ui_brython.py','micropython/ui_mpy.py']
def defs(src):
    out={}; lines=src.split('\n')
    for n in ast.parse(src).body:
        if isinstance(n,(ast.FunctionDef,ast.ClassDef)):
            out[n.name]='\n'.join(lines[n.lineno-1:n.end_lineno])
    return out
d=[defs(open(f).read()) for f in files]
def strip(s):
    ls=[re.sub(r'\s+#.*','',l).rstrip() for l in s.split('\n')]
    return [l for l in ls if l.strip() and not l.strip().startswith('#')]
for name in ['_warn','_append_children','_tag_builder','kpi','markdown','play','run_button','run_cell','widget']:
    ok=all(name in x for x in d) and strip(d[0][name])==strip(d[1][name])==strip(d[2][name])
    print(name, 'IDENTISK' if ok else 'AVVIK — IKKE FLYTT')
EOF
```

- [ ] **Step 2: Inventory each mover's dialect references**

For each function to move, list the module-level names it calls that are NOT already in core (e.g. `play` → `_spec`, `_register_value`, `_alias_rerun`?, `_bind_handler_if_callable`; `kpi` → `_payload_element`; `_tag_builder` → `_normalize_kwargs`, `_ui`, `_warn`, `Element`; `_append_children` → `_ui`). Every such name becomes a `configure()`-injected placeholder in core (add to the placeholder block + each facade's `configure(...)` call). `Element` as an injected placeholder is fine — core calls whatever class the facade passes.

- [ ] **Step 3: Move them (verbatim), extend `configure`, bind in all three facades**

Facade `configure` call grows to e.g.:

```python
_core.configure(scalar=_scalar, register=_register, register_value=_register_value,
                bind_handler_if_callable=_bind_handler_if_callable, ui=_ui,
                payload_element=_payload_element, normalize_kwargs=_normalize_kwargs,
                element_cls=Element, alias_rerun=_alias_rerun)
```

(exact set = whatever Step 2's inventory found; keep placeholder names `_<kwarg>`). Facades bind the moved functions (`play = _core.play` etc.) and delete their local copies.

- [ ] **Step 4: Run all three facade suites + everything**

Run: `python -m pytest tests/ brython/tests/ micropython/tests/ -q`
Expected: all pass, zero assertion changes (493 facade tests incl. the three new shared-source tests)

- [ ] **Step 5: Commit**

```bash
git add shared/ui_core.py pyodide/ui.py brython/ui_brython.py micropython/ui_mpy.py
git commit -m "feat(fase3): identiske API-funksjoner (kpi/markdown/play/run_button/run_cell/widget/taggbygger) flyttet til ui_core med injiserte dialektsymboler"
```

---

### Task 4: Twin-drift tripwire test

**Files:**
- Create: `tests/test_ui_core_drift.py`

- [ ] **Step 1: Write the tripwire**

```python
"""Fase 3 (spec 2026-07-20): tvillingdrift-snubletråd for fasadene.

De dialekt-sammenfiltrede funksjonene ble BEVISST værende per fasade
(spec §Phase 3 revidert). Risikoen er ensidige endringer: en fiks i én
fasade som aldri speiles. Denne testen feiler når (a) fasadenes
offentlige API-navnesett divergerer, (b) et navn som skal være delt
re-defineres lokalt i en fasade, eller (c) normalisert likhet for et
speilet funksjonspar faller UNDER gulvet målt 2026-07-20 — en ensidig
endring senker likheten; en synkronisert endring holder den oppe.
Gulvjustering er en BEVISST handling: oppdater tallet i samme commit
som en strukturell (synkron) omskriving, med begrunnelse i meldingen."""
import ast
import difflib
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[1]
FILES = {
    "pyodide": ROOT / "pyodide" / "ui.py",
    "brython": ROOT / "brython" / "ui_brython.py",
    "mpy": ROOT / "micropython" / "ui_mpy.py",
}

# Speilede-men-dialektale funksjoner og deres likhetsgulv (min. parvis
# likhet målt 2026-07-20, avrundet NED til nærmeste 0.05 for slingring).
MIRRORED_FLOORS = {
    "slider": 0.80,
    "dropdown": 0.90,
    "checkbox": 0.85,
    "switch": 0.85,
    "number": 0.90,
    "text": 0.90,
    "button": 0.85,
    "on": 0.70,
    "value": 0.60,
    "_normalize_kwargs": 0.65,
    "Element": 0.80,
    "WidgetHandle": 0.90,
    "_payload_element": 0.90,
    "_lib_tag_builder": 0.85,
    "_validate_accepts": 0.70,
}

# Navn som skal komme fra ui_core og ALDRI re-defineres i en fasade.
SHARED = ["HTML_TAGS", "_SL_ACCEPTS", "_snake_to_camel", "_json_safe",
          "_spec", "kpi", "markdown", "play", "run_button", "run_cell",
          "widget", "_tag_builder", "_append_children"]


def _defs(path):
    src = path.read_text(encoding="utf-8")
    out = {}
    lines = src.split("\n")
    for n in ast.parse(src).body:
        if isinstance(n, (ast.FunctionDef, ast.ClassDef)):
            out[n.name] = "\n".join(lines[n.lineno - 1:n.end_lineno])
    return out


def _norm(body):
    ls = [re.sub(r"\s+#.*", "", l).rstrip() for l in body.split("\n")]
    return [l for l in ls if l.strip() and not l.strip().startswith("#")]


def test_ingen_lokal_redefinisjon_av_delte_navn():
    for runtime, path in FILES.items():
        d = _defs(path)
        offenders = [n for n in SHARED if n in d]
        assert not offenders, (
            f"{runtime}: {offenders} er delte ui_core-navn men re-definert "
            f"lokalt i {path.name} — flytt endringen til shared/ui_core.py")


def test_speilede_funksjoner_har_ikke_driftet():
    ds = {k: _defs(p) for k, p in FILES.items()}
    problems = []
    for name, floor in MIRRORED_FLOORS.items():
        bodies = {k: _norm(d[name]) for k, d in ds.items() if name in d}
        assert len(bodies) == 3, f"{name} mangler i {set(FILES) - set(bodies)}"
        keys = list(bodies)
        for i in range(len(keys)):
            for j in range(i + 1, len(keys)):
                r = difflib.SequenceMatcher(None, bodies[keys[i]], bodies[keys[j]]).ratio()
                if r < floor:
                    problems.append(f"{name}: {keys[i]}~{keys[j]} = {r:.2f} < gulv {floor}")
    assert not problems, (
        "Mulig ensidig fasade-endring (speil den i tvillingene, eller "
        "juster gulvet bevisst i samme commit):\n" + "\n".join(problems))
```

- [ ] **Step 2: Calibrate the floors against reality**

Run: `python -m pytest tests/test_ui_core_drift.py -v`
If a floor is above today's measured similarity, lower THAT entry to measured-minus-0.05 (the table above is derived from the 2026-07-20 analysis but Task 1-3 moves change the files — recalibrate honestly, do not delete entries). Both tests must pass at HEAD.

- [ ] **Step 3: Prove the tripwire trips**

Temporarily add a nonsense line to `brython/ui_brython.py`'s `_normalize_kwargs`, run the test, confirm it FAILS with the drift message; revert the nonsense line, confirm PASS again. Note the round-trip in the report.

- [ ] **Step 4: Commit**

```bash
git add tests/test_ui_core_drift.py
git commit -m "test(fase3): tvillingdrift-snubletråd — API-paritet, ingen lokal redefinisjon av delte navn, likhetsgulv for speilede funksjoner"
```

---

### Task 5: Freeze `webr/ui.R`, docs, full verification

**Files:**
- Modify: `webr/ui.R` (header comment only), spec status line

- [ ] **Step 1: Freeze header**

Prepend to `webr/ui.R`'s existing header comment block (R `#` comments, keep the existing text below):

```r
# FRYST 2026-07-20 (spec 2026-07-20-unified-interactive-elements-design.md,
# fase 3): denne fasaden beholder dagens widget-oppførsel mot den stabile
# registerControl/registerFromRegistry-kontrakten, men får IKKE ui.html
# eller nye kontroller uten ny beslutning. Delingen med python-fasadene
# (shared/ui_core.py) omfatter ikke R. Endringer her skal være rene
# vedlikeholdsfikser.
```

- [ ] **Step 2: Full suites**

Run: `python -m pytest tests/ brython/tests/ micropython/tests/ -q` and `node --test tests/js/*.test.js`
Expected: all pass

- [ ] **Step 3: Browser sweep (serve root, cache-busted URL; bump `?v=` on any `<script src>` whose file changed in this plan — check `git diff --stat` against the plan-start commit; pyodide boot ~30–60 s)**

- (a) pyodide notebook: widget cell (slider + kpi + play), `ui.html.p(...)`, `#tag.import = pico` + a `ui.pico.*` call → all render; `ui.kpi(...)` renders (kpi moved to core — the proof the load chain works).
- (b) brython mode: `import ui` + `ui.slider(...)` + `ui.kpi(42)` → renders (proves registry `path`/deps loading of shared/ui_core.py).
- (c) micropython mode: same as (b).
- (d) R mode: widgets example still works (frozen, untouched).
- (e) Console: no errors from any engine's module registration.

- [ ] **Step 4: Mark Phase 3 delivered and commit**

Append to the spec `**Status:**` line: `; Phase 3 DELIVERED <dato> (plan 2026-07-20-facade-shared-core.md)`.

```bash
git add webr/ui.R docs/superpowers/specs/2026-07-20-unified-interactive-elements-design.md
git commit -m "docs(fase3): ui.R fryst som legacy + fase 3 levert — delt kjerne, snubletråd, alle suiter grønne"
```
