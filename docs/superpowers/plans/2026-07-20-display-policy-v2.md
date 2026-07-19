# Display Policy v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 1 of `docs/superpowers/specs/2026-07-20-unified-interactive-elements-design.md` — every bare expression on its own line displays (notebook cells AND scripts), with four suppression rules: `None`, `_`-prefixed bare names, a `;` immediately after the expression, and bare `ui.*` control calls (control renders, scalar echo muted).

**Architecture:** The pyodide execution core is Python source embedded in a JS template literal inside `index.html` (`_exec_pyodide_block`, ~line 7511). It ALREADY supports show-all (`only_last=False`) — the notebook default of "last only" is imposed by JS callers sending `_nb = {last: true}`. So the work splits cleanly: (a) add the suppression rules inside `_exec_pyodide_block`, (b) flip the JS callers so notebook cells stop sending `last: true` (with `#options.display = last` as the opt-out), (c) apply the same suppression rules to the trailing-expression display in the brython/micropython runners (they stay last-only per spec — they have no `ast` module).

**Tech Stack:** Vanilla JS (ES5 var-style, Norwegian comments) in `index.html`/`js/*.js`; embedded Pyodide Python; pytest for Python, `node --test` for JS. No build step.

## Global Constraints

- `index.html`'s Python lives inside a JS **template literal**: a literal `\n` inside a Python string must be written `\\n` in the file (see existing `src.split("\\n")` at index.html:7531). Never write a bare `\n` inside a Python string literal there.
- ES5 `var`-style JS, Norwegian comments, `t()` for user-facing strings (this plan adds no user-facing strings).
- `mdRunNotebookCell` contract and the hybrid segment machinery untouched.
- R/webR display untouched. JavaScript-mode cells untouched.
- Existing behaviors that must NOT change: `print()` output, `show()`, plots, `#options.display = all` escape (keeps today's echo-follows-`_showCmds` behavior), echo (`>>> `) formatting, the `_nb.echo` flag, matplotlib end-of-block flush.
- Suppression-rule semantics (spec §Phase 1, precised here): rule 3 is "the expression is immediately followed by `;`" (so `a; b` mutes `a`, shows `b`; `df.head(); # kommentar` is muted; `df.head() # note;` is shown). Task 6 updates the spec wording to match.
- Commit after every task; commit messages in the repo's Norwegian style.

## File map

- `index.html` — embedded Python core (`_exec_pyodide_block` ~7511) + JS caller flags (~10482, ~10557, ~10662, ~10982)
- `js/cells.js` — `payload.nb` producers (:2029, :2154)
- `brython/brython_runner.py`, `micropython/micropython_runner.py` — trailing-expression display
- `tests/test_display_policy.py` (new), `tests/js/cells-dom.test.js` (:764), `brython/tests/test_brython_runner.py`, `micropython/tests/test_micropython_runner.py`
- `docs/superpowers/specs/2026-07-20-unified-interactive-elements-design.md`, `examples/brython/bry02_plotly_charts.txt` — doc touch-ups

---

### Task 1: Pytest harness + characterization tests for the embedded exec core

The pyodide core has NO direct pytest today. Build an extraction harness that pulls `_exec_pyodide_block` out of `index.html`, un-escapes the template-literal escaping, and execs it with stubs. Then pin CURRENT behavior (these tests must pass before any production change).

**Files:**
- Create: `tests/test_display_policy.py`

**Interfaces:**
- Produces: `_load_core_src()` and `make_exec_block(shown)` in `tests/test_display_policy.py` — Task 2's tests reuse both. `make_exec_block` returns the real `_exec_pyodide_block(code, g, show_commands=False, only_last=False)`; every displayed value is appended to the `shown` list.

- [ ] **Step 1: Write the harness + characterization tests**

```python
"""Display policy v2 (spec 2026-07-20 §Phase 1): tester den EKTE
_exec_pyodide_block hentet ut av index.html sin JS-template-literal.
Utpakkingen reverserer literal-escapingen: '\\n' i filen er '\n' når
Pyodide får koden — derfor .replace('\\\\', '\\') under. _show_one
stubbes med en opptaker (policy-testene bryr seg om HVA som vises,
ikke hvordan); _m2py_flush_pyplot_figs stubbes som no-op."""
import ast
import pathlib

INDEX = pathlib.Path(__file__).resolve().parents[1] / "index.html"


def _load_core_src():
    text = INDEX.read_text(encoding="utf-8")
    start = text.index("def _exec_pyodide_block(")
    end = text.index("def _duck_concise(", start)
    src = text[start:end]
    return src.replace("\\\\", "\\")


def make_exec_block(shown):
    ns = {
        "ast": ast,
        "_show_one": shown.append,
        "_m2py_flush_pyplot_figs": lambda: None,
    }
    exec(compile(_load_core_src(), "<index.html:_exec_pyodide_block>", "exec"), ns)
    return ns["_exec_pyodide_block"]


def run_block(code, only_last=False, show_commands=False, g=None):
    shown = []
    block = make_exec_block(shown)
    block(code, g if g is not None else {}, show_commands, only_last)
    return shown


# ---- karakterisering: dagens oppførsel (må passere FØR endringene) ----

def test_all_mode_shows_every_bare_expression():
    assert run_block("1 + 1\n'to'\n3") == [2, "to", 3]

def test_only_last_shows_only_last_expression():
    assert run_block("1 + 1\n'to'\n3", only_last=True) == [3]

def test_none_is_suppressed():
    assert run_block("None\nprint") == [print]

def test_assignments_not_displayed():
    assert run_block("x = 5\ny = x + 1") == []

def test_statements_execute_in_order_with_state():
    g = {}
    assert run_block("x = 5\nx + 1\nx = 7\nx + 1", g=g) == [6, 8]
    assert g["x"] == 7

def test_echo_mode_prints_commands(capsys):
    run_block("x = 5", show_commands=True)
    assert ">>> x = 5" in capsys.readouterr().out
```

- [ ] **Step 2: Run to verify the harness works against current code**

Run: `python -m pytest tests/test_display_policy.py -v`
Expected: 6 PASS (these pin today's behavior; no production change yet)

- [ ] **Step 3: Commit**

```bash
git add tests/test_display_policy.py
git commit -m "test(display): pytest-sele for _exec_pyodide_block hentet ut av index.html + karakterisering av dagens policy"
```

---

### Task 2: Suppression rules in `_exec_pyodide_block`

TDD: failing tests first, then the rules — a nested helper `_expr_suppressed` inside `_exec_pyodide_block` (nested so the Task-1 extraction marker `def _exec_pyodide_block(` keeps capturing everything).

**Files:**
- Modify: `index.html` (function `_exec_pyodide_block`, ~line 7511)
- Test: `tests/test_display_policy.py`

**Interfaces:**
- Consumes: `run_block` from Task 1.
- Produces: the four suppression rules inside `_exec_pyodide_block`; signature unchanged (`code, g, show_commands=False, only_last=False`) — Task 3 relies on `only_last=False` + rules being the "all"-policy.

- [ ] **Step 1: Write the failing tests (append to `tests/test_display_policy.py`)**

```python
# ---- display policy v2: nye dempingsregler (spec §Phase 1, regel 2-4) ----

class FakeUi:
    """Minimal ui-fasade: slider registrerer (sideeffekt) og returnerer
    skalar — som pyodide/ui.py sin pull-modell."""
    def __init__(self):
        self.calls = []
    def slider(self, *a, **k):
        self.calls.append(a)
        return 42
    def value(self, name):
        return 99

def test_underscore_bare_name_suppressed():
    assert run_block("_x = 123\n_x") == []

def test_underscore_name_in_only_last_mode_suppressed():
    assert run_block("_x = 123\n_x", only_last=True) == []

def test_call_on_underscore_name_still_shown():
    assert run_block("_s = 'abc'\n_s.upper()") == ["ABC"]

def test_semicolon_after_expression_mutes():
    assert run_block("5 + 5;") == []

def test_semicolon_then_comment_mutes():
    assert run_block("5 + 5 ;  # kommentar") == []

def test_semicolon_only_inside_comment_shows():
    assert run_block("5 + 5  # merknad;") == [10]

def test_semicolon_between_two_expressions_mutes_first_only():
    assert run_block("'a'; 'b'") == ["b"]

def test_multiline_expression_with_trailing_semicolon_mutes():
    assert run_block("(1 +\n 2);") == []

def test_semicolon_after_nonascii_expression_mutes():
    # end_col_offset er BYTE-offset (utf-8) — 'blåbær' har multibyte-tegn.
    assert run_block("'blåbær';") == []

def test_bare_ui_control_call_registers_but_not_echoed():
    ui = FakeUi()
    assert run_block("ui.slider(0, 100)", g={"ui": ui}) == []
    assert ui.calls == [(0, 100)]

def test_assigned_ui_control_value_displays_via_name():
    ui = FakeUi()
    assert run_block("n = ui.slider(0, 100)\nn", g={"ui": ui}) == [42]

def test_non_control_ui_call_still_shown():
    ui = FakeUi()
    assert run_block("ui.value('n')", g={"ui": ui}) == [99]
```

- [ ] **Step 2: Run to verify they fail**

Run: `python -m pytest tests/test_display_policy.py -v`
Expected: the 12 new tests FAIL (values shown that should be suppressed); the 6 characterization tests still PASS

- [ ] **Step 3: Implement the rules in `index.html`**

In `_exec_pyodide_block` (~line 7511): extend the docstring, add the nested helper after the `_echo` definition, and gate the `_show_one` call. REMEMBER: `\n` inside Python strings must be written `\\n` in this file.

Replace this block:

```python
    try:
        try:
            tree = ast.parse(code, mode="exec")
        except SyntaxError:
```

with:

```python
    _UI_CONTROL_NAMES = ("slider", "dropdown", "checkbox", "switch", "number", "text", "button", "run_button", "play")
    _plines = code.split("\\n")
    def _expr_suppressed(stmt):
        # Display policy v2 (spec 2026-07-20 §Phase 1, regel 2-4; regel 1 =
        # None-filteret i visnings-if'en under). Gjelder BEGGE moduser
        # (all og only_last).
        _val = stmt.value
        # Regel 2: nakent navn med _-prefiks (KUN ast.Name — _df.head() vises).
        if isinstance(_val, ast.Name) and _val.id.startswith("_"):
            return True
        # Regel 3: ';' rett etter uttrykket demper. end_col_offset er
        # BYTE-offset (utf-8) — slice i bytes, ikke i str (norske tegn!).
        try:
            _ln = _plines[stmt.end_lineno - 1]
            _rest = _ln.encode("utf-8")[stmt.end_col_offset:].decode("utf-8", "replace").lstrip()
            if _rest.startswith(";"):
                return True
        except Exception:
            pass
        # Regel 4: nakent ui.<kontroll>(...)-kall — kontrollen registreres av
        # evalueringen (pull-modellen), men skalar-ekkoet er støy. Kun det
        # bokstavelige navnet `ui` (import ui as u dekkes ikke — dokumentert
        # hjørne, `;` er utveien). ui.html.* har Attribute-verdi, ikke Name —
        # matcher ikke og beholder selvvisningen via _show_one.
        if isinstance(_val, ast.Call):
            _f = _val.func
            if isinstance(_f, ast.Attribute) and isinstance(_f.value, ast.Name) and _f.value.id == "ui" and _f.attr in _UI_CONTROL_NAMES:
                return True
        return False
    try:
        try:
            tree = ast.parse(code, mode="exec")
        except SyntaxError:
```

Then change the display gate (currently `if _v is not None and (not only_last or _i == _last_expr_i):`) to:

```python
                if _v is not None and (not only_last or _i == _last_expr_i) and not _expr_suppressed(stmt):
```

Also update the function's docstring first line from "alle Expr-setninger vises" to mention the rules, e.g. append: `Display policy v2 (spec 2026-07-20): _-prefiks-navn, ';'-etterheng og nakne ui.*-kontrollkall dempes i begge moduser.`

- [ ] **Step 4: Run to verify all pass**

Run: `python -m pytest tests/test_display_policy.py -v`
Expected: 18 PASS

- [ ] **Step 5: Commit**

```bash
git add index.html tests/test_display_policy.py
git commit -m "feat(display): dempingsregler i _exec_pyodide_block — _-navn, ';'-etterheng, nakne ui.*-kontrollkall (policy v2 regel 2-4)"
```

---

### Task 3: Notebook default → show-all; `#options.display = last` becomes the opt-out

Flip the JS callers: notebook cells stop forcing `last: true`. `#options.display = last` now forces last-only in BOTH notebook cells and unmarked scripts; `#options.display = all` keeps its existing meaning (skip `_nb` entirely → echo follows `_showCmds`).

**Files:**
- Modify: `js/cells.js:2029`, `js/cells.js:2154` (payload producers)
- Modify: `index.html` ~10482 (per-cell scope), ~10557 (replay), ~10662 (single segment), ~10982 (Kjør alle loop)
- Test: `tests/js/cells-dom.test.js:764`

**Interfaces:**
- Consumes: Task 2's `_exec_pyodide_block` (with `only_last=False` + rules = the "all" policy).
- Produces: `payload.nb` is now `{ echo: false }` (no `last` key). `_nb.last` is only ever true when `#options.display = last`.

- [ ] **Step 1: Update the JS test expectation (failing first)**

`tests/js/cells-dom.test.js:764` — change:

```js
  assert.deepStrictEqual(capturedPayload.nb, { echo: false, last: true });
```

to:

```js
  // Display policy v2 (spec 2026-07-20 §Phase 1): cellene tvinger ikke
  // lenger last:true — alle nakne uttrykk vises; '#options.display = last'
  // legges på av index.html, ikke av cells.js.
  assert.deepStrictEqual(capturedPayload.nb, { echo: false });
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/js/cells-dom.test.js`
Expected: that one test FAILS (payload still has `last: true`)

- [ ] **Step 3: Change the two payload producers in `js/cells.js`**

At :2029 (the `runCell` payload) replace:

```js
        // Eksplisitt celle (spec §4 "Display policy"): echo av, kun siste
        // uttrykk vises — index.html overstyrer/dropper dette selv når
        // dokumentet har '#options.display = all' (leses fra HELE dokumentet,
        // aldri fra cellen).
        nb: { echo: false, last: true },
```

with:

```js
        // Display policy v2 (spec 2026-07-20 §Phase 1): echo av, ALLE nakne
        // uttrykk vises (dempingsreglene håndheves i _exec_pyodide_block).
        // index.html legger selv på last:true ved '#options.display = last',
        // og dropper hele _nb ved '#options.display = all' (leses fra HELE
        // dokumentet, aldri fra cellen).
        nb: { echo: false },
```

At :2154 (the selection-run payload) replace `nb: { echo: false, last: true },` with `nb: { echo: false },` (same one-line form; the long comment lives at the :2029 site).

- [ ] **Step 4: Run to verify the JS test passes**

Run: `node --test tests/js/cells-dom.test.js`
Expected: PASS (all tests in the file)

- [ ] **Step 5: Wire `#options.display = last` in `index.html`**

(a) Per-cell scope, directly after line ~10482 (`var _displayAll = ...`), add:

```js
        // Display policy v2: '#options.display = last' gjenoppretter
        // siste-uttrykk-visningen (opt-out fra vis-alle-defaulten).
        var _displayLast = String(_scriptOpts.display || '').toLowerCase() === 'last';
```

(b) Replay branch ~10557 — replace:

```js
                  _rseg._nb = payload.nb || { echo: false, last: true };
```

with:

```js
                  _rseg._nb = payload.nb || { echo: false };
                  if (_displayLast) _rseg._nb = { echo: _rseg._nb.echo, last: true };
```

(c) Single-segment branch ~10662 — replace:

```js
            targetSeg._nb = payload.nb || { echo: false, last: true };
```

with:

```js
            targetSeg._nb = payload.nb || { echo: false };
            if (_displayLast) targetSeg._nb = { echo: targetSeg._nb.echo, last: true };
```

(d) Kjør alle-loop ~10982 — replace:

```js
            if (_sd && _sd.explicit) segments[i]._nb = { echo: false, last: true };
```

with:

```js
            if (_sd && _sd.explicit) segments[i]._nb = { echo: false, last: _displayLast };
```

(`_displayLast` already exists in this scope, defined at ~10894.) Update the comment above the branch (~10977-10979) from "echo av, kun siste uttrykk vises" to "echo av, alle nakne uttrykk vises (policy v2); '#options.display = last' gjenoppretter siste-uttrykk".

- [ ] **Step 6: Run the full JS suite**

Run: `node --test tests/js/`
Expected: all PASS

- [ ] **Step 7: Commit**

```bash
git add js/cells.js index.html tests/js/cells-dom.test.js
git commit -m "feat(display): notatbokceller viser alle nakne uttrykk — last-only nå opt-in via '#options.display = last' (policy v2)"
```

---

### Task 4: Brython runner — suppression rules on the trailing expression

Brython stays last-expression-only (no `ast` — spec-accepted divergence), but rules 2 and 4 apply to that trailing expression. Rule 3 (`;`) needs NO code: a tail with `;` fails to compile in `'eval'` mode, so the candidate is discarded and the whole code plain-execs with no display — pin that with a test.

**Files:**
- Modify: `brython/brython_runner.py` (module-level helper + `_execute_code`)
- Test: `brython/tests/test_brython_runner.py`

**Interfaces:**
- Produces: module-level `_tail_suppressed(tail: str) -> bool` and `_UI_CONTROLS` tuple in `brython_runner.py` — Task 5 mirrors both names in `micropython_runner.py`.

- [ ] **Step 1: Write the failing tests (append to `brython/tests/test_brython_runner.py`)**

```python
# ---- display policy v2 (spec 2026-07-20 §Phase 1) på trailing-uttrykket ----

def test_underscore_bare_name_trailing_not_displayed():
    br._execute_code('_hemmelig = 123')
    out = br._execute_code('_hemmelig')
    assert '123' not in out
    assert br._get_last_error() == ''

def test_call_on_underscore_name_still_displayed():
    br._execute_code('_tekst = "abc"')
    out = br._execute_code('_tekst.upper()')
    assert 'ABC' in out

def test_trailing_semicolon_mutes_display():
    # ';' i halen kompilerer ikke i eval-modus → kandidaten forkastes og
    # hele koden plain-exec'es uten visning. Pinner den naturlige dempingen.
    out = br._execute_code('sv = 7\nsv;')
    assert '7' not in out
    assert br._get_last_error() == ''

def test_ui_control_call_evaluated_but_not_echoed():
    br._execute_code(
        'class FakeUi:\n'
        '    def __init__(self):\n'
        '        self.calls = []\n'
        '    def slider(self, *a, **k):\n'
        '        self.calls.append(a)\n'
        '        return 42\n'
        'ui = FakeUi()')
    out = br._execute_code('ui.slider(0, 100)')
    assert '42' not in out
    assert br._get_last_error() == ''
    out2 = br._execute_code('len(ui.calls)')
    assert '1' in out2

def test_non_control_ui_call_still_displayed():
    br._execute_code(
        'class FakeUi2:\n'
        '    def value(self, name):\n'
        '        return 99\n'
        'ui = FakeUi2()')
    out = br._execute_code('ui.value("n")')
    assert '99' in out
```

- [ ] **Step 2: Run to verify they fail**

Run: `python -m pytest brython/tests/test_brython_runner.py -v`
Expected: `test_underscore_bare_name_trailing_not_displayed` and `test_ui_control_call_evaluated_but_not_echoed` FAIL; the `;` and "still displayed" tests may already pass (natural behavior) — that is fine

- [ ] **Step 3: Implement in `brython/brython_runner.py`**

Add at module level (after the `_fmt` function):

```python
_UI_CONTROLS = ('slider', 'dropdown', 'checkbox', 'switch', 'number', 'text',
                'button', 'run_button', 'play')

def _tail_suppressed(tail):
    """Display policy v2 (spec 2026-07-20 §Phase 1) på trailing-uttrykket:
    demp visningen når det er (a) et nakent navn med _-prefiks eller (b) et
    nakent ui.<kontroll>(...)-kall (kontrollen registreres av evalueringen —
    pull-modellen; skalar-ekkoet er støy). Evalueringen skjer UANSETT
    (sideeffekter bevart). ';'-demping trenger ingen kode her: en hale med
    ';' kompilerer ikke i eval-modus, så kandidaten forkastes og hele koden
    plain-exec'es uten visning. Ingen `ast` — string-sjekker (samme grunn
    som kandidat-skanningen i _execute_code)."""
    if tail.startswith('_'):
        _ok = True
        for _ch in tail:
            if not (_ch == '_' or _ch.isalpha() or _ch.isdigit()):
                _ok = False
                break
        if _ok:
            return True
    if tail.startswith('ui.'):
        _rest = tail[3:]
        for _name in _UI_CONTROLS:
            if _rest.startswith(_name + '('):
                return True
    return False
```

In `_execute_code`: change `result = None` / `displayed = False` (lines ~110-111) to also initialize `suppressed = False`; in the winning-candidate branch set the flag after eval:

```python
                exec(head_code, _shared_vars)
                result = eval(tail_code, _shared_vars)
                displayed = True
                suppressed = _tail_suppressed(tail_stripped)
                break
```

and change the display line (~143) from `shown = _fmt(result)` to:

```python
        shown = '' if suppressed else _fmt(result)
```

(NOTE: `displayed` keeps its existing meaning — "a candidate was found and evaluated" — it still gates the plain-exec fallback. Do NOT reuse it for suppression; that would double-exec the code.)

- [ ] **Step 4: Run to verify all pass**

Run: `python -m pytest brython/tests/test_brython_runner.py -v`
Expected: all PASS (old + 5 new)

- [ ] **Step 5: Commit**

```bash
git add brython/brython_runner.py brython/tests/test_brython_runner.py
git commit -m "feat(display): policy v2-demping på trailing-uttrykket i brython-runneren (_-navn, ui.*-kontrollkall; ';' pinnet)"
```

---

### Task 5: MicroPython runner — same rules

Mirror of Task 4. `micropython_runner.py` has the same candidate scan; its output goes via `print` (tests use `capsys` through the file's `run(capsys, code)` helper).

**Files:**
- Modify: `micropython/micropython_runner.py`
- Test: `micropython/tests/test_micropython_runner.py`

**Interfaces:**
- Consumes: the helper shape from Task 4 (`_UI_CONTROLS`, `_tail_suppressed`) — copy it verbatim (the runners are deliberate twins; a shared module is not possible, the files load standalone in their runtimes).

- [ ] **Step 1: Write the failing tests (append to `micropython/tests/test_micropython_runner.py`; the file's `run(capsys, code)` helper asserts the `''`-return contract)**

```python
# ---- display policy v2 (spec 2026-07-20 §Phase 1) på trailing-uttrykket ----

def test_underscore_bare_name_trailing_not_displayed(capsys):
    run(capsys, '_hemmelig = 123')
    out = run(capsys, '_hemmelig')
    assert '123' not in out
    assert mr._get_last_error() == ''

def test_call_on_underscore_name_still_displayed(capsys):
    run(capsys, '_tekst = "abc"')
    out = run(capsys, '_tekst.upper()')
    assert 'ABC' in out

def test_trailing_semicolon_mutes_display(capsys):
    out = run(capsys, 'sv = 7\nsv;')
    assert '7' not in out
    assert mr._get_last_error() == ''

def test_ui_control_call_evaluated_but_not_echoed(capsys):
    run(capsys,
        'class FakeUi:\n'
        '    def __init__(self):\n'
        '        self.calls = []\n'
        '    def slider(self, *a, **k):\n'
        '        self.calls.append(a)\n'
        '        return 42\n'
        'ui = FakeUi()')
    out = run(capsys, 'ui.slider(0, 100)')
    assert '42' not in out
    assert mr._get_last_error() == ''
    out2 = run(capsys, 'len(ui.calls)')
    assert '1' in out2

def test_non_control_ui_call_still_displayed(capsys):
    run(capsys,
        'class FakeUi2:\n'
        '    def value(self, name):\n'
        '        return 99\n'
        'ui = FakeUi2()')
    out = run(capsys, 'ui.value("n")')
    assert '99' in out
```

- [ ] **Step 2: Run to verify the two suppression tests fail**

Run: `python -m pytest micropython/tests/test_micropython_runner.py -v`
Expected: underscore + ui-control tests FAIL; others may pass

- [ ] **Step 3: Implement in `micropython/micropython_runner.py`**

Add the identical `_UI_CONTROLS` + `_tail_suppressed` from Task 4 at module level (after `_fmt`). In `_execute_code`: initialize `suppressed = False` next to `result = None` / `displayed = False` (~lines 126-127); set `suppressed = _tail_suppressed(tail_stripped)` after the `result = eval(tail_code, _shared_vars)` line in the winning branch; change line ~158 from:

```python
        shown = _fmt(result) if displayed else ''
```

to:

```python
        shown = _fmt(result) if (displayed and not suppressed) else ''
```

(Only `str.isalpha`/`str.isdigit` string methods are used in the helper — both exist in MicroPython; `str.isidentifier` does not, which is why the helper spells out the character loop.)

- [ ] **Step 4: Run to verify all pass**

Run: `python -m pytest micropython/tests/test_micropython_runner.py -v`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add micropython/micropython_runner.py micropython/tests/test_micropython_runner.py
git commit -m "feat(display): policy v2-demping i micropython-runneren — speil av brython-tvillingen"
```

---

### Task 6: Docs, spec alignment, example touch-up

**Files:**
- Modify: `docs/superpowers/specs/2026-07-20-unified-interactive-elements-design.md` (rule-3 wording + Phase 1 status)
- Modify: `examples/brython/bry02_plotly_charts.txt:18`

**Interfaces:** none (docs only).

- [ ] **Step 1: Align the spec's rule 3 with the implemented semantics**

In the spec's Phase 1 "Rule" list, replace item 3's first sentence:

> 3. The statement's source line ends with `;` → suppressed.

with:

> 3. The expression is immediately followed by `;` → suppressed
>    (so `a; b` mutes `a` and shows `b`; `df.head(); # kommentar` is
>    muted; `df.head() # note;` is shown — implemented via the
>    expression's `end_col_offset`, not line-level text).

Keep the rest of item 3 (rationale/escape-hatch sentences) unchanged.

Also in the spec's "Where" subsection, replace the sentence `The
`only_last` flag becomes a display-policy object; notebook cells and
script segments use the same "all bare expressions" policy.` with:

> The `only_last` boolean is kept as-is (YAGNI — no policy object
> needed): the "all"-policy is simply `only_last=False` plus the
> suppression rules, which apply in both modes; notebook cells and
> script segments now both default to it. Also update the spec's **Status:** line to `APPROVED 2026-07-20; Phase 1 DELIVERED <dagens dato> (plan 2026-07-20-display-policy-v2.md)` when the browser sweep in Task 7 is green — it is fine to do that edit as part of Task 7's commit instead.

- [ ] **Step 2: Update the example comment**

`examples/brython/bry02_plotly_charts.txt:18` says `# The last expression is displayed automatically:` — change to:

```
# A bare expression on its own line is displayed automatically:
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-20-unified-interactive-elements-design.md examples/brython/bry02_plotly_charts.txt
git commit -m "docs(display): presiser ';'-regelen i specen + oppdater eksempel-kommentar til vis-alle-policyen"
```

---

### Task 7: Full suites + browser verification sweep

**Files:** none (verification only; spec status edit from Task 6 allowed here).

- [ ] **Step 1: Full Python and JS suites**

Run: `python -m pytest tests/ brython/tests/ micropython/tests/ -q` and `node --test tests/js/`
Expected: all PASS

- [ ] **Step 2: Browser sweep (serve the repo root, e.g. `python -m http.server`, open index.html; pyodide boot takes ~30-60 s)**

Notebook document with `#%%` cells, pyodide mode:
- (a) A cell with `x = 5` then `x + 1` then `"hei"` on three lines → BOTH `6` and `hei` appear in the cell output (new), in order.
- (b) Same cell with a trailing `x;` line → no extra echo of `5`.
- (c) A cell with `_tmp = 3` and bare `_tmp` → nothing shown.
- (d) A widget cell: bare `ui.slider(0, 100)` on its own line → slider renders in the strip, NO number echoed in the output; drag → cell reruns, still no scalar echo.
- (e) `n = ui.slider(0, 100)` + bare `n` line → slider renders AND the value shows; drag → value updates.
- (f) A `ui.html` cell (e.g. `ui.html.p("hei")` bare) → element still mounts (rule 4 must NOT catch `ui.html.*`).
- (g) Add `#options.display = last` to the document → cells back to last-expression-only; remove it again.
- (h) `#options.display = all` → unchanged legacy behavior (everything shows, echo per innstilling).
- (i) A `#@param`-cell with `run:auto` → form renders, changing a value reruns without scalar noise.
- (j) Brython mode and MicroPython mode: repeat (c), (d) and a plain `1 + 1` trailing line → `2` shows; `_tmp` and slider-echo suppressed. (These runtimes still show only the trailing expression — expected divergence.)
- (k) Whole-script "Kjør" (no cells): bare expressions all display as before; `_x` bare name now suppressed (intended change).
- (l) Single-cell run (▶), selection run (Ctrl/Cmd+Enter over a selection) and "Kjør alle" all follow the same policy.

- [ ] **Step 3: Mark the spec Phase 1 as delivered (see Task 6 Step 1) and commit**

```bash
git add docs/superpowers/specs/2026-07-20-unified-interactive-elements-design.md
git commit -m "docs(spec): fase 1 (display policy v2) levert"
```
