# Pretty output — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `pretty_output`-modus (på som default): objekter som i dag faller til ren tekst — særlig DataFrames — rendres som HTML-embeds, styrt av `show.defaults`-registry, `#options.pretty_output`-direktiv og meny-toggle.

**Architecture:** Ingen tekstomskriving og ingen ny transport — et pretty-flagg på de EKSISTERENDE display-hookene (`_show_one` i pyodide-preludiet, `_fmt`/`_show` i brython/mpy-runnerne), som emitterer eksisterende embed-typer (`tablehtml__`/`tabulator__`/`html__`) via markør-protokollen. Flagget três som sesjonsglobal i pyodide (`_PRETTY`, satt per kjøring via `runPythonAsync`) og som modulflagg i brython/mpy (`_set_pretty`, kalt av motoren per kjøring). Spec: `docs/superpowers/specs/2026-07-30-pretty-output-design.md`.

**Tech Stack:** Vanilla JS (inline i `index.html` + `js/*.js`), Python-prelude i JS-template-literal, Brython/MicroPython-runnere (ren Python, ingen `ast`), pytest + `node --test`.

## Global Constraints

- Default PÅ; presedens **script-direktiv > Innstillinger > `true`** (mønster: `show_commands`, `index.html:11688`).
- Default tabellvisning: **statisk `to_html`** (`tablehtml__`-embed). `"tabulator"`/`"text"` velges via `show.defaults` eller `format=`-kwarg.
- `pretty_output=False` = dagens oppførsel per motor, byte-for-byte (brython/mpy sin nakne-df-tablehtml er OK og beholdes; `show(df)` uten format gir da tabulator som i dag).
- Eksplisitt `print(df)` gir ALLTID rå tekst.
- Dispatch-rekkefølge (spec §4): rike grener inkl. `_openstat_el_id`-montering FØRAN registry-lag og `_repr_html_`-fallback.
- Ukjent verdi i `show.defaults` → fall stille tilbake til `"html"`. Ukjent eksplisitt `format=` → `ValueError` med teksten `"show(format=...): gyldige verdier er 'tabulator', 'html' og 'text'"`.
- Python-koden i `index.html` ligger i en JS-template-literal: bruk `chr(10)` for linjeskift i strenger, ALDRI literal `\n`, ALDRI backticks eller `${` i tilføyd kode.
- Nye i18n-strenger (norsk tekst = nøkkel) må inn i `js/i18n/en.js`.
- Testkommandoer (begge grønne i dag): `python3 -m pytest -q` og `node --test tests/js/*.test.js` (kjøres fra repo-rot `/Users/hom/Documents/GitHub/openstat`).
- Commit etter hver task. IKKE push (openstat pushes av kontrolløren, aldri automatisk).

---

### Task 1: Innstillinger — nøkler (bugfiks), Pen output-toggle, gettere, i18n

**Files:**
- Modify: `index.html:355-414` (settings-modal-markup), `index.html:2374-2464` (nøkler/gettere/initSettings)
- Modify: `js/i18n/en.js` (nye strenger)

**Interfaces:**
- Consumes: ingenting nytt.
- Produces: `PRETTY_OUTPUT_KEY` (+ de fire manglende nøklene), `getPrettyOutputDefault(): boolean`, `getPrettyEffective(scriptOpts): boolean` — Task 3 og 6 kaller `getPrettyEffective`.

Bakgrunn (bugfiks): `TTS_RATE_KEY`, `BLOCK_PAUSE_KEY`, `DECIMALS_KEY`, `SHOW_COMMANDS_KEY` refereres i `index.html:2375/2379/2383/2388/2442/2445/2450/2455` men er ALDRI deklarert — alle referansene sitter i `try/catch`, så Save kaster stille bort verdiene. Verifiser først:

- [ ] **Step 1: Bekreft at nøklene mangler**

Run: `grep -n "TTS_RATE_KEY\s*=\|BLOCK_PAUSE_KEY\s*=\|DECIMALS_KEY\s*=\|SHOW_COMMANDS_KEY\s*=" index.html`
Expected: ingen treff (kun bruk, ingen deklarasjon). Hvis deklarasjoner finnes, stopp og revurder steget.

- [ ] **Step 2: Deklarer nøklene**

I `index.html`, rett OVER `function getTtsRate() {` (linje 2374), sett inn:

```js
    // Innstillings-nøkler. Bugfiks 2026-07-30: de fire første var referert
    // men aldri deklarert — ReferenceError ble svelget av try/catch-ene, så
    // Save kastet stille bort Decimals/Show-commands/TTS/pause-verdiene.
    var TTS_RATE_KEY = 'microdata_tts_rate';
    var BLOCK_PAUSE_KEY = 'microdata_block_pause';
    var DECIMALS_KEY = 'microdata_decimals';
    var SHOW_COMMANDS_KEY = 'microdata_show_commands';
    var PRETTY_OUTPUT_KEY = 'microdata_pretty_output';
```

- [ ] **Step 3: Gettere for pretty**

Rett ETTER `getShowCommandsEffectiveDefault()` (som slutter `index.html:2401`), sett inn:

```js
    function getPrettyOutputDefault() {
      try {
        var v = localStorage.getItem(PRETTY_OUTPUT_KEY);
        if (v === 'off') return false;
        if (v === 'on') return true;
      } catch(e) {}
      return true;
    }
    // Presedens: script-direktiv > Innstillinger > true (samme mønster som
    // show_commands-lesingen ved btnRun, se «Presedens:»-kommentaren der).
    function getPrettyEffective(scriptOpts) {
      if (scriptOpts && typeof scriptOpts.pretty_output === 'boolean') return scriptOpts.pretty_output;
      return getPrettyOutputDefault();
    }
```

- [ ] **Step 4: Modal-felt**

I settings-modalen, rett ETTER `settingShowCommands`-feltets lukkende `</div>` (`index.html:385`), sett inn:

```html
        <div class="settings-field">
          <label for="settingPrettyOutput" data-i18n>Pen output (HTML-tabeller)</label>
          <select id="settingPrettyOutput">
            <option value="on" selected data-i18n>P&#229; (standard)</option>
            <option value="off" data-i18n>Av</option>
          </select>
          <p class="settings-hint" data-i18n-html>Tabeller (DataFrames o.l.) vises som HTML i output i stedet for ren tekst. Kan overstyres per script med <code>#options.pretty_output=False</code>.</p>
        </div>
```

- [ ] **Step 5: initSettings-wiring**

I `initSettings` (`index.html:2403-2464`):
1. Etter `var showCmdsEl = document.getElementById('settingShowCommands');` legg til
   `var prettyEl = document.getElementById('settingPrettyOutput');`
2. I `openSettings()`, etter `showCmdsEl`-linjen (2427):
   `if (prettyEl) prettyEl.value = getPrettyOutputDefault() ? 'on' : 'off';`
3. I save-handleren, etter `SHOW_COMMANDS_KEY`-blokken (2453-2456):

```js
        if (prettyEl) {
          var po = prettyEl.value === 'off' ? 'off' : 'on';
          try { localStorage.setItem(PRETTY_OUTPUT_KEY, po); } catch(e2) {}
        }
```

- [ ] **Step 6: i18n**

Finn mønsteret for settings-strengene: `grep -n "Kommando-echo i output" js/i18n/en.js`. Legg til tilsvarende oppføringer (norsk nøkkel → engelsk verdi) samme sted:
- `'Pen output (HTML-tabeller)'` → `'Pretty output (HTML tables)'`
- Hint-strengen fra Step 4 → `'Tables (DataFrames etc.) are rendered as HTML in the output instead of plain text. Can be overridden per script with <code>#options.pretty_output=False</code>.'`
(`'På (standard)'` og `'Av'` finnes allerede for show_commands — gjenbrukes automatisk.)

- [ ] **Step 7: Verifiser**

Run: `grep -c "PRETTY_OUTPUT_KEY" index.html` → Expected: `3` (deklarasjon + getter + save).
Run: `node --test tests/js/*.test.js 2>&1 | tail -3` → Expected: ingen failing.
Run: `python3 -m pytest -q 2>&1 | tail -2` → Expected: alt grønt.

- [ ] **Step 8: Commit**

```bash
git add index.html js/i18n/en.js
git commit -m "feat: Pen output-toggle i innstillinger + bugfiks: deklarer manglende settings-nøkler"
```

---

### Task 2: Pyodide-kjernen — pretty-hook, show.defaults, kwargs (TDD)

**Files:**
- Modify: `index.html:7591-7697` (python-preludiet i `getInterpreterCorePython`)
- Test: `tests/test_pretty_output.py` (ny)

**Interfaces:**
- Consumes: eksisterende `_EMBED_S`/`_EMBED_E`, `pd`, `_show_one`-kjeden.
- Produces (python-globals i pyodide-sesjonen): `_PRETTY` (én-elements liste, `[True]`), `show(*args, **kwargs)` med `show.defaults = {"dataframe": "html", "series": "html", "default": "auto"}`, hjelperne `_emit_df_html(df)`, `_emit_df_tabulator(df, opts)`, `_df_kind_how(obj, fmtv)`. Task 3 setter `_PRETTY[0]` via `runPythonAsync`. Testfilens anker-strenger: slice fra `"_PRETTY = [True]"` til `"def to_microdata("`.

VIKTIG: dette er kode inne i en JS-template-literal — bruk `chr(10)`, aldri `\n`-literaler/backticks/`${`. Merk at `tests/test_display_policy.py` slicer `def _exec_pyodide_block(` → `def _duck_concise(` — `_exec_pyodide_block` røres IKKE i denne planen, så de 18 testene skal forbli grønne uendret.

- [ ] **Step 1: Skriv failing tests**

Opprett `tests/test_pretty_output.py`:

```python
"""Pretty output (spec 2026-07-30): tester den EKTE _show_one/show-kjeden
hentet ut av index.html sin JS-template-literal (samme utpakkings-idé som
test_display_policy.py). pandas fakes (isinstance-sjekkene treffer
fake-klassene); tabulator stubbes i sys.modules."""
import io
import json
import pathlib
import sys
import types

import pytest

INDEX = pathlib.Path(__file__).resolve().parents[1] / "index.html"


def _load_pretty_src():
    text = INDEX.read_text(encoding="utf-8")
    start = text.index("_PRETTY = [True]")
    end = text.index("def to_microdata(", start)
    return text[start:end].replace("\\\\", "\\")


class FakeSeries:
    def __init__(self, values):
        self.values = values
    def to_frame(self):
        return FakeDF({"v": self.values})
    def __str__(self):
        return "SERIES-TEXT"


class FakeDF:
    def __init__(self, cols):
        self.cols = cols
        self.columns = list(cols)
    def to_html(self, **kw):
        return '<table class="dataframe"><tr><td>x</td></tr></table>'
    def __str__(self):
        return "DF-TEXT"


class FakeTable:
    def __init__(self, df, **kw):
        self.df = df
        self.kw = kw
    def to_tabulator_json_str(self):
        return json.dumps({"kw": sorted(k for k, v in self.kw.items() if v)})


@pytest.fixture
def ns(monkeypatch):
    tabmod = types.ModuleType("tabulator")
    tabmod.calls = []
    def _table(df, **kw):
        t = FakeTable(df, **kw)
        tabmod.calls.append(t)
        return t
    tabmod.table = _table
    monkeypatch.setitem(sys.modules, "tabulator", tabmod)
    pd = types.ModuleType("pd")
    pd.DataFrame = FakeDF
    pd.Series = FakeSeries
    n = {"pd": pd,
         "_EMBED_S": "__micro_transform_start_",
         "_EMBED_E": "__micro_transform_end__"}
    exec(compile(_load_pretty_src(), "<index.html:pretty>", "exec"), n)
    n["_tabmod"] = tabmod
    return n


def _out(capsys):
    return capsys.readouterr().out


def test_pretty_df_gives_tablehtml(ns, capsys):
    ns["_show_one"](FakeDF({"a": [1]}))
    out = _out(capsys)
    assert "tablehtml__" in out and "DF-TEXT" not in out


def test_pretty_off_df_gives_text(ns, capsys):
    ns["_PRETTY"][0] = False
    ns["_show_one"](FakeDF({"a": [1]}))
    out = _out(capsys)
    assert "DF-TEXT" in out and "tablehtml__" not in out


def test_defaults_text_gives_text(ns, capsys):
    ns["show"].defaults["dataframe"] = "text"
    ns["_show_one"](FakeDF({"a": [1]}))
    assert "DF-TEXT" in _out(capsys)


def test_defaults_tabulator_gives_tabulator(ns, capsys):
    ns["show"].defaults["dataframe"] = "tabulator"
    ns["_show_one"](FakeDF({"a": [1]}))
    assert "tabulator__" in _out(capsys)


def test_defaults_unknown_value_falls_back_to_html(ns, capsys):
    ns["show"].defaults["dataframe"] = "excel"
    ns["_show_one"](FakeDF({"a": [1]}))
    assert "tablehtml__" in _out(capsys)


def test_series_via_to_frame(ns, capsys):
    ns["_show_one"](FakeSeries([1, 2]))
    assert "tablehtml__" in _out(capsys)


def test_show_format_tabulator_overrides_defaults(ns, capsys):
    ns["show"](FakeDF({"a": [1]}), format="tabulator")
    assert "tabulator__" in _out(capsys)


def test_show_format_works_even_when_pretty_off(ns, capsys):
    ns["_PRETTY"][0] = False
    ns["show"](FakeDF({"a": [1]}), format="tabulator")
    assert "tabulator__" in _out(capsys)


def test_show_unknown_format_raises(ns):
    with pytest.raises(ValueError) as e:
        ns["show"](FakeDF({"a": [1]}), format="pdf")
    assert "tabulator" in str(e.value)


def test_show_kwargs_forwarded_to_tabulator(ns, capsys):
    ns["show"](FakeDF({"a": [1]}), format="tabulator", title="T", filters=True)
    assert ns["_tabmod"].calls[-1].kw.get("title") == "T"
    assert ns["_tabmod"].calls[-1].kw.get("filters") is True


def test_repr_html_fallback_when_pretty(ns, capsys):
    class Rich:
        def _repr_html_(self):
            return "<b>rik</b>"
    ns["_show_one"](Rich())
    out = _out(capsys)
    assert "html__" in out and "<b>rik</b>" in out


def test_repr_html_skipped_when_pretty_off(ns, capsys):
    class Rich:
        def _repr_html_(self):
            return "<b>rik</b>"
    ns["_PRETTY"][0] = False
    ns["_show_one"](Rich())
    assert "html__" not in _out(capsys)


def test_repr_html_skipped_when_default_not_auto(ns, capsys):
    class Rich:
        def _repr_html_(self):
            return "<b>rik</b>"
    ns["show"].defaults["default"] = "text"
    ns["_show_one"](Rich())
    assert "html__" not in _out(capsys)


def test_ui_element_mounts_never_html_embed(ns, capsys):
    calls = []
    class El:
        _openstat_el_id = "el-1"
        def _repr_html_(self):
            return "<a>lenke</a>"
        def show(self):
            calls.append("mounted")
    ns["_show_one"](El())
    out = _out(capsys)
    assert calls == ["mounted"] and "html__" not in out


def test_plain_objects_still_print(ns, capsys):
    ns["_show_one"](42)
    assert "42" in _out(capsys)
```

- [ ] **Step 2: Kjør — verifiser at de feiler**

Run: `python3 -m pytest tests/test_pretty_output.py -q`
Expected: FAIL/ERROR allerede i fixturen (`ValueError: substring not found` — ankeret `_PRETTY = [True]` finnes ikke ennå).

- [ ] **Step 3: Implementer i preludiet**

I `index.html`, rett FØR `def _show_one(obj):` (linje 7591, dvs. etter matplotlib-blokkens avsluttende `except Exception:`/`    pass`), sett inn:

```python
_PRETTY = [True]
def _emit_df_html(df):
    try:
        _html = df.to_html(max_rows=200, classes="output-table", border=0)
    except TypeError:
        _html = df.to_html()
        if '<table class=' not in _html:
            _html = _html.replace('<table', '<table class="output-table"', 1)
    print(_EMBED_S + "tablehtml__" + chr(10) + _html + chr(10) + _EMBED_E)
def _emit_df_tabulator(df, opts):
    import tabulator as _tab
    _kw = {}
    for _k in ("pagination", "height", "filters", "sortable", "title"):
        if _k in opts and opts[_k] is not None:
            _kw[_k] = opts[_k]
    _t = _tab.table(df, **_kw)
    print(_EMBED_S + "tabulator__" + chr(10) + _t.to_tabulator_json_str() + chr(10) + _EMBED_E)
def _df_kind_how(obj, fmtv):
    # 'dataframe'/'series' -> renderer-navn fra show.defaults; eksplisitt
    # format= vinner. Ukjent defaults-verdi faller stille til 'html';
    # ukjent EKSPLISITT format skal derimot si fra.
    _kind = "series" if isinstance(obj, pd.Series) else "dataframe"
    _how = fmtv if fmtv is not None else show.defaults.get(_kind, "html")
    if _how not in ("html", "tabulator", "text"):
        if fmtv is not None:
            raise ValueError("show(format=...): gyldige verdier er 'tabulator', 'html' og 'text'")
        _how = "html"
    return _how
```

Erstatt pandas-grenen i `_show_one` (dagens linjer 7666-7671):

```python
    try:
        if isinstance(obj, (pd.DataFrame, pd.Series)):
            print(obj)
            return
    except Exception:
        pass
```

med:

```python
    try:
        if isinstance(obj, (pd.DataFrame, pd.Series)):
            # pretty (spec 2026-07-30): registry-oppslag i show.defaults;
            # av (dagens oppførsel) -> ren print som før.
            if not _PRETTY[0]:
                print(obj)
                return
            _how = _df_kind_how(obj, None)
            if _how == "text":
                print(obj)
                return
            _df = obj.to_frame() if isinstance(obj, pd.Series) else obj
            if _how == "tabulator":
                _emit_df_tabulator(_df, {})
            else:
                _emit_df_html(_df)
            return
    except Exception:
        pass
```

Erstatt `_show_one` sin siste linje (`    print(obj)`, linje 7694, rett etter `_openstat_el_id`-grenen) med:

```python
    if _PRETTY[0] and show.defaults.get("default", "auto") == "auto":
        # Generisk fallback (spec §4 pkt 3): Jupyter-protokollen _repr_html_
        # fanger "andre objekter" (Styler, statsmodels-summary, sklearn ...)
        # uten at vi enumererer dem. Ligger ETTER _openstat_el_id-grenen —
        # ui-elementer skal monteres levende, aldri bli en statisk kopi.
        try:
            _rh = getattr(obj, "_repr_html_", None)
            if callable(_rh):
                _h = _rh()
                if isinstance(_h, str) and _h.strip():
                    print(_EMBED_S + "html__" + chr(10) + _h + chr(10) + _EMBED_E)
                    return
        except Exception:
            pass
    print(obj)
```

Erstatt `show` (dagens linjer 7695-7697):

```python
def show(*args):
    for _a in args:
        _show_one(_a)
```

med:

```python
def show(*args, **kwargs):
    # Naken df == show(df) == oppslag i show.defaults (spec 2026-07-30);
    # format=/pagination=/height=/filters=/sortable=/title= per kall vinner.
    # Eksplisitt format= virker også med pretty av (ny kapabilitet — gammel
    # show tok ingen kwargs, så ingen regresjon).
    _fmtv = kwargs.pop("format", None)
    for _a in args:
        try:
            _is_df = isinstance(_a, (pd.DataFrame, pd.Series))
        except Exception:
            _is_df = False
        if _is_df and (_fmtv is not None or _PRETTY[0]):
            _how = _df_kind_how(_a, _fmtv)
            if _how == "text":
                print(_a)
                continue
            _df = _a.to_frame() if isinstance(_a, pd.Series) else _a
            if _how == "tabulator":
                _emit_df_tabulator(_df, kwargs)
            else:
                _emit_df_html(_df)
            continue
        _show_one(_a)
show.defaults = {"dataframe": "html", "series": "html", "default": "auto"}
```

- [ ] **Step 4: Kjør — verifiser grønt**

Run: `python3 -m pytest tests/test_pretty_output.py tests/test_display_policy.py -q`
Expected: alt PASS (display-policy-testene urørt grønne — de stubber `_show_one`).

- [ ] **Step 5: Commit**

```bash
git add index.html tests/test_pretty_output.py
git commit -m "feat: pretty display-hook i pyodide-preludiet (show.defaults, kwargs, _repr_html_-fallback)"
```

---

### Task 3: Pyodide-wiring — flagget inn i run-stiene + tabulator-seed

**Files:**
- Modify: `index.html` — btnRun-stien (~11707-11745), `bootNotebookSession` (~10775-10776), `nbEnsureSession` (~10814-10825), per-celle-stien (~11271-11274)

**Interfaces:**
- Consumes: `getPrettyEffective(scriptOpts)` (Task 1), `_PRETTY` (Task 2), eksisterende `__ensureTabulatorPy(py)` (`index.html:9925`).
- Produces: `_ctx.pretty` (boolean) — Task 6 sin `runSelf`-tråding leser den; `ctx.pretty` inn i `bootNotebookSession`.

Navnevalg: bruk `_prettyOut` (ikke `_pretty`) i JS for å unngå kollisjon — verifiser først: `grep -n "_prettyOut" index.html` → Expected: ingen treff.

- [ ] **Step 1: btnRun-stien**

Etter `_showCmds`-beregningen (`index.html:11707-11709`), legg til:

```js
        var _prettyOut = getPrettyEffective(_scriptOpts);
```

Utvid `_ctx` (11724) med `pretty: _prettyOut`:

```js
        var _ctx = { py: py, rightStatus: rightStatus, showCommands: _showCmds, profile: _scriptOpts.profile, displayAll: _displayAll, pretty: _prettyOut };
```

Utvid `_bootCtx` (11745) med `pretty: _prettyOut`:

```js
        var _bootCtx = { py: py, activeEditorMode: activeEditorMode, effectiveScript: effectiveScript, duckPreResolved: _duckPreResolved, showCommands: _showCmds, pretty: _prettyOut };
```

- [ ] **Step 2: bootNotebookSession**

Rett FØR `setStatus(rightStatus, 'Running...');` + `await py.runPythonAsync(setupCode);` (`index.html:10775-10776`), sett inn tabulator-seedingen (spec §5: `show.defaults["dataframe"]="tabulator"` skal virke uten import — modulen er 165 avhengighetsfrie linjer, hentes én gang og caches):

```js
        // pretty (spec 2026-07-30): registrer tabulator-modulen ubetinget så
        // show.defaults["dataframe"]="tabulator" virker uten eksplisitt import.
        try { await __ensureTabulatorPy(py); }
        catch (e) { console.warn('tabulator-prelude (pretty):', e); }
```

Rett ETTER `await py.runPythonAsync(setupCode);`, sett inn:

```js
        if (typeof ctx.pretty === 'boolean') {
          try { await py.runPythonAsync('_PRETTY[0] = ' + (ctx.pretty ? 'True' : 'False')); }
          catch (e) { console.warn('pretty-flagg (boot):', e); }
        }
```

- [ ] **Step 3: nbEnsureSession**

I `nbEnsureSession` (`index.html:10814-10825`), etter `_showCmds`-beregningen, legg til `var _prettyOut = getPrettyEffective(_scriptOpts);` og utvid `bootNotebookSession`-argumentet med `pretty: _prettyOut`:

```js
      var _result = await bootNotebookSession({
        py: py,
        activeEditorMode: _mode,
        effectiveScript: effectiveScript,
        duckPreResolved: null,
        showCommands: _showCmds,
        pretty: _prettyOut
      });
```

- [ ] **Step 4: Per-celle-stien**

I `mdRunNotebookCell` sin pyodide/duckdb-gren, etter `_displayLast`-linjen (`index.html:11274`), sett inn (sesjonen kan være LIVE fra en tidligere kjøring med annet direktiv, derfor settes flagget per kjøring):

```js
        var _prettyCell = getPrettyEffective(_scriptOpts);
        try { await py.runPythonAsync('_PRETTY[0] = ' + (_prettyCell ? 'True' : 'False')); }
        catch (e) { console.warn('pretty-flagg (celle):', e); }
```

Merk (akseptert i v1, dokumenteres i Task 7): Forklar/«Kjør skrittvis» setter ikke flagget selv — den arver verdien fra siste kjøring/sesjonsboot.

- [ ] **Step 5: Verifiser**

Run: `grep -c "_prettyOut\|_prettyCell\|_PRETTY\[0\] = " index.html` → Expected: ≥ 8.
Run: `python3 -m pytest tests/test_pretty_output.py tests/test_display_policy.py -q` → Expected: PASS (ankrene `_PRETTY = [True]`, `def _exec_pyodide_block(`, `def _duck_concise(` er uendret).
Run: `node --test tests/js/*.test.js 2>&1 | tail -3` → Expected: ingen failing.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat: pretty_output-flagget três inn i pyodide-run-stiene + tabulator-seed i sesjonsboot"
```

---

### Task 4: Brython-runneren — registry, _set_pretty, _df_html_embed (TDD)

**Files:**
- Modify: `brython/brython_runner.py`
- Test: `brython/tests/test_pretty_defaults.py` (ny), `brython/tests/test_tabulator_runner.py` (to tester endres)

**Interfaces:**
- Consumes: eksisterende `_fmt`, `_show`, `_df_tabulator_spec`, `_shared_vars`.
- Produces: `_pretty` (én-elements liste, default `[True]`), `_set_pretty(flag)` (motoren kaller, Task 6), `_df_html_embed(obj)`, `_show.defaults = {'dataframe': 'html', 'series': 'html', 'default': 'auto'}`. Task 5 porterer identisk til mpy; Task 6 kaller `mod._set_pretty(...)`.

Merk: `show.defaults['series']` er pyodide-only i v1 — shim-Series har `to_html` men ikke `columns`, så den følger alltid html-veien her (dokumenteres i Task 7).

- [ ] **Step 1: Skriv failing tests**

Opprett `brython/tests/test_pretty_defaults.py` (samme harness-stil som `test_tabulator_runner.py`; dekker BEGGE runnere for paritet — mpy-delene feiler til Task 5 er gjort, kjør derfor kun brython-parametrene i denne tasken):

```python
#   python3 -m pytest brython/tests/test_pretty_defaults.py -q
import sys, os, io, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'shared'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'micropython'))
import pandas_brython as bpd
import brython_runner
import micropython_runner

import pytest

RUNNERS = [brython_runner, micropython_runner]


@pytest.fixture(autouse=True)
def _restore_state():
    saved = []
    for r in RUNNERS:
        saved.append((r, dict(r._shared_vars['show'].defaults), r._pretty[0]))
    yield
    for r, defaults, pretty in saved:
        r._shared_vars['show'].defaults.clear()
        r._shared_vars['show'].defaults.update(defaults)
        r._pretty[0] = pretty


def _df():
    return bpd.DataFrame({'aar': [2020, 2021], 'antall': [1, 2]})


def _capture_show(runner, *a, **kw):
    buf = io.StringIO()
    old = sys.stdout
    sys.stdout = buf
    try:
        runner._shared_vars['show'](*a, **kw)
    finally:
        sys.stdout = old
    return buf.getvalue()


@pytest.mark.parametrize('runner', RUNNERS)
def test_fmt_df_default_is_tablehtml(runner):
    out = runner._fmt(_df())
    assert 'tablehtml__' in out and 'tabulator__' not in out


@pytest.mark.parametrize('runner', RUNNERS)
def test_fmt_df_defaults_tabulator(runner):
    runner._shared_vars['show'].defaults['dataframe'] = 'tabulator'
    out = runner._fmt(_df())
    assert 'tabulator__' in out and 'tablehtml__' not in out


@pytest.mark.parametrize('runner', RUNNERS)
def test_fmt_df_defaults_text(runner):
    runner._shared_vars['show'].defaults['dataframe'] = 'text'
    out = runner._fmt(_df())
    assert 'tablehtml__' not in out and 'tabulator__' not in out
    assert 'aar' in out   # str(df) — shimens __str__


@pytest.mark.parametrize('runner', RUNNERS)
def test_fmt_df_pretty_off_is_tablehtml_even_with_defaults(runner):
    # pretty av = dagens oppførsel: naken df -> statisk tablehtml, registry hoppes over
    runner._shared_vars['show'].defaults['dataframe'] = 'tabulator'
    runner._set_pretty(False)
    out = runner._fmt(_df())
    assert 'tablehtml__' in out and 'tabulator__' not in out


@pytest.mark.parametrize('runner', RUNNERS)
def test_fmt_defaults_unknown_falls_back_to_html(runner):
    runner._shared_vars['show'].defaults['dataframe'] = 'excel'
    out = runner._fmt(_df())
    assert 'tablehtml__' in out


@pytest.mark.parametrize('runner', RUNNERS)
def test_show_default_follows_defaults_html(runner):
    out = _capture_show(runner, _df())
    assert 'tablehtml__' in out and 'tabulator__' not in out


@pytest.mark.parametrize('runner', RUNNERS)
def test_show_pretty_off_defaults_to_tabulator(runner):
    # dagens kontrakt (spec 2026-07-24) beholdes når pretty er av
    runner._set_pretty(False)
    out = _capture_show(runner, _df())
    assert 'tabulator__' in out


@pytest.mark.parametrize('runner', RUNNERS)
def test_show_format_text(runner):
    out = _capture_show(runner, _df(), format='text')
    assert 'tablehtml__' not in out and 'tabulator__' not in out and 'aar' in out


@pytest.mark.parametrize('runner', RUNNERS)
def test_show_unknown_format_raises(runner):
    with pytest.raises(ValueError) as e:
        _capture_show(runner, _df(), format='pdf')
    assert 'tabulator' in str(e.value)


@pytest.mark.parametrize('runner', RUNNERS)
def test_set_pretty_roundtrip(runner):
    assert runner._pretty[0] is True
    runner._set_pretty(False)
    assert runner._pretty[0] is False
    runner._set_pretty(True)
    assert runner._pretty[0] is True


@pytest.mark.parametrize('runner', RUNNERS)
def test_non_df_to_html_objects_always_html(runner):
    # statsmodels-summary o.l.: to_html uten .columns -> alltid html-embed,
    # registry gjelder kun df-aktige (har .columns)
    class Summarylike:
        def to_html(self):
            return '<table><tr><td>s</td></tr></table>'
    runner._shared_vars['show'].defaults['dataframe'] = 'text'
    out = runner._fmt(Summarylike())
    assert 'tablehtml__' in out
```

- [ ] **Step 2: Kjør — verifiser at de feiler riktig**

Run: `python3 -m pytest brython/tests/test_pretty_defaults.py -q -k brython_runner`
Expected: FAIL med `AttributeError` (`_pretty`/`_set_pretty`/`defaults` finnes ikke ennå). (mpy-parametrene feiler også — de blir grønne i Task 5.)

- [ ] **Step 3: Implementer i brython_runner.py**

1. Etter `_last_error = ''` (linje 11), sett inn:

```python
_pretty = [True]

def _set_pretty(flag):
    """Motoren (js/brython-engine.js) kaller denne før hver kjøring med
    effektiv pretty_output (direktiv > meny > True). Modul-global —
    _snapshot/_rollback rører kun _shared_vars, så replay-pass bevarer den."""
    _pretty[0] = bool(flag)


def _df_html_embed(obj):
    html = obj.to_html()
    if '<table class=' not in html:
        html = html.replace('<table', '<table class="output-table"', 1)
    return _EMBED_S + 'tablehtml__' + '\n' + html + '\n' + _EMBED_E
```

2. Erstatt `to_html`-grenen i `_fmt` (dagens linjer 45-49):

```python
    if hasattr(obj, 'to_html'):
        html = obj.to_html()
        if '<table class=' not in html:
            html = html.replace('<table', '<table class="output-table"', 1)
        return _EMBED_S + 'tablehtml__' + '\n' + html + '\n' + _EMBED_E
```

med:

```python
    if hasattr(obj, 'to_html'):
        # pretty (spec 2026-07-30): df-aktige (har .columns) følger
        # show.defaults['dataframe']; html er default og identisk med dagens
        # oppførsel. Ukjent verdi faller stille til html. Ikke-df-to_html
        # (statsmodels-summary o.l.) er alltid html.
        if _pretty[0] and hasattr(obj, 'columns'):
            how = _show.defaults.get('dataframe', 'html')
            if how == 'tabulator':
                spec = _df_tabulator_spec(obj, {})
                return _EMBED_S + 'tabulator__' + '\n' + json.dumps(spec) + '\n' + _EMBED_E
            if how == 'text':
                return str(obj)
        return _df_html_embed(obj)
```

MERK: `_fmt` står FØR `_df_tabulator_spec`/`_show` i filen — begge slås opp ved kall, ikke ved def, så rekkefølgen er trygg.

3. Erstatt kroppen i `_show` (dagens linjer 203-230) slik at defaults konsulteres (docstring oppdateres tilsvarende):

```python
def _show(*objs, **kwargs):
    """User-facing show(). DataFrames følger show.defaults['dataframe']
    (pretty-modus, spec 2026-07-30) — 'html' er standard; format= per kall
    vinner. Med pretty AV gjelder dagens hardkodede tabulator-default
    (spec 2026-07-24). Øvrige kwargs (pagination/height/filters/sortable/
    title) går til tabellbyggingen."""
    fmtv = kwargs.pop('format', None)
    for o in objs:
        if (hasattr(o, 'to_html') and hasattr(o, 'columns')
                and not hasattr(o, 'to_tabulator_json_str')):
            how = fmtv
            if how is None:
                how = _show.defaults.get('dataframe', 'html') if _pretty[0] else 'tabulator'
            if how not in ('tabulator', 'html', 'text'):
                if fmtv is not None:
                    raise ValueError("show(format=...): gyldige verdier er "
                                     "'tabulator', 'html' og 'text'")
                how = 'html'
            if how == 'tabulator':
                spec = _df_tabulator_spec(o, kwargs)
                print(_EMBED_S + 'tabulator__' + '\n' + json.dumps(spec)
                      + '\n' + _EMBED_E)
                continue
            if how == 'text':
                print(str(o))
                continue
            print(_df_html_embed(o))
            continue
        # Speiler `if shown:`-vakten ved _execute_code sitt sist-uttrykk-kall:
        # en ui.html.*-Element formaterer til '' (_fmt monterer den) —
        # print('') ville skrevet en tom linje.
        shown = _fmt(o)
        if shown:
            print(shown)

_show.defaults = {'dataframe': 'html', 'series': 'html', 'default': 'auto'}
```

(`_shared_vars['show'] = _show` på linjen etter beholdes uendret. `_baseline_vars` tas etterpå i filen, så `_reset()` bevarer show-objektet med defaults.)

- [ ] **Step 4: Oppdater de to endrede kontraktene i test_tabulator_runner.py**

`test_show_df_defaults_to_tabulator` (linje 31) tester GAMMEL kontrakt. Erstatt den med:

```python
def test_show_df_default_follows_pretty_defaults_html():
    # Endret kontrakt (spec 2026-07-30): show(df) uten format følger
    # show.defaults['dataframe'] (html) når pretty er på (default).
    df = bpd.DataFrame({'aar': [2020, 2021], 'antall': [1, 2]})
    for runner in (brython_runner, micropython_runner):
        out = _capture_show(runner, df)
        assert 'tablehtml__' in out, out[:120]
        assert 'tabulator__' not in out
```

`test_show_opts_forwarded` (linje 55) bruker default-formatet — legg til eksplisitt `format='tabulator'` i kallet:

```python
    out = _capture_show(brython_runner, df, format='tabulator', filters=True, title='T')
```

- [ ] **Step 5: Kjør — brython-parametrene grønne**

Run: `python3 -m pytest brython/tests/test_pretty_defaults.py -q -k brython_runner`
Expected: PASS.
Run: `python3 -m pytest brython/tests/ -q 2>&1 | tail -2`
Expected: kun mpy-relaterte feil fra `test_pretty_defaults.py`/`test_tabulator_runner.py` (fikses i Task 5); ingen andre.

- [ ] **Step 6: Commit**

```bash
git add brython/brython_runner.py brython/tests/test_pretty_defaults.py brython/tests/test_tabulator_runner.py
git commit -m "feat: pretty-registry (show.defaults) + _set_pretty i brython-runneren"
```

---

### Task 5: MicroPython-runneren — identisk port + paritet

**Files:**
- Modify: `micropython/micropython_runner.py`

**Interfaces:**
- Consumes: Task 4 sitt design (byte-paritet der mulig).
- Produces: `_pretty`, `_set_pretty(flag)`, `_df_html_embed(obj)`, `_show.defaults` — samme navn/kontrakt som brython. Task 6 legger `_set_pretty` i handles-mappen.

- [ ] **Step 1: Kjør mpy-parametrene — verifiser at de feiler**

Run: `python3 -m pytest brython/tests/test_pretty_defaults.py -q -k micropython_runner`
Expected: FAIL med `AttributeError`.

- [ ] **Step 2: Port endringene**

Gjør NØYAKTIG de samme tre endringene som Task 4 Step 3 i `micropython/micropython_runner.py`:
1. `_pretty`/`_set_pretty`/`_df_html_embed` etter `_last_error = ''` (linje 18) — samme kode; i `_set_pretty`-docstringen: bytt `js/brython-engine.js` → `js/micropython-engine.js`.
2. `to_html`-grenen i `_fmt` (dagens linjer 62-66) — samme erstatning som Task 4 (identisk kode og kommentar).
3. `_show` (dagens linjer 223-246) — samme erstatning + `_show.defaults = {...}`-linjen. Behold mpy-varianten av speil-kommentaren.

- [ ] **Step 3: Kjør — alt grønt**

Run: `python3 -m pytest brython/tests/test_pretty_defaults.py brython/tests/test_tabulator_runner.py micropython/tests/ -q`
Expected: PASS (inkl. `test_spec_parity_with_core`).

- [ ] **Step 4: Commit**

```bash
git add micropython/micropython_runner.py
git commit -m "feat: pretty-registry + _set_pretty portert til micropython-runneren (paritet)"
```

---

### Task 6: Motor-JS-kanalen — opts.pretty gjennom run/runCell + kallsteder

**Files:**
- Modify: `js/brython-engine.js:409-527` (run + nbRunCell)
- Modify: `js/micropython-engine.js:185-198` (handles) + `:372-486` (run + nbRunCell)
- Modify: `index.html:2780` og `:2848` (runSelf-kallene), `index.html:11122-11167` (runNotebookEngineCell)

**Interfaces:**
- Consumes: `_set_pretty` (Task 4/5), `ctx.pretty` (Task 3), `getPrettyEffective` (Task 1).
- Produces: `BrythonEngine.run(script, {loads, extraDatasets, pretty})`, `notebookSession.runCell(source, opts)` med `opts.pretty` — samme for MicroPythonEngine. `JsEngine` røres IKKE (ekstra argument til dens `runCell(source)` er harmløst i JS og ignoreres).

- [ ] **Step 1: brython-engine.js**

I `run(script, opts)`, rett etter `var mod = await load();` (linje 418), sett inn:

```js
      // pretty (spec 2026-07-30): modulflagg, satt per kjøring — replay-
      // passene under arver det (rollback rører kun _shared_vars).
      if (mod._set_pretty) mod._set_pretty(!(opts && opts.pretty === false));
```

I `nbRunCell`, endre signaturen (linje 489) fra `async function nbRunCell(source) {` til `async function nbRunCell(source, opts) {`, og sett inn samme to linjer rett etter `var mod = await load();` (linje 495).

- [ ] **Step 2: micropython-engine.js**

1. I handles-mappen i `load()` (linje 185-198), legg til etter `_sync_var`-linjen:

```js
        _sync_var: mp.globals.get('_sync_var'),
        _set_pretty: mp.globals.get('_set_pretty')
```

2. I `run(script, opts)` rett etter `var mod = await load();` (linje 376) og i `nbRunCell` (signatur → `async function nbRunCell(source, opts) {`, linje 446) rett etter `var mod = await load();` (linje 451): samme `if (mod._set_pretty) ...`-linje som Step 1.

- [ ] **Step 3: runSelf-kallene i index.html**

Brython (linje 2780) — utvid opts:

```js
            res = await window.BrythonEngine.run(script, { loads: _dl.loads, extraDatasets: _asmX && _asmX.datasets, pretty: ctx.pretty !== false });
```

MicroPython (linje 2848) — tilsvarende:

```js
            res = await window.MicroPythonEngine.run(script, { loads: _dl.loads, extraDatasets: _asmX && _asmX.datasets, pretty: ctx.pretty !== false });
```

- [ ] **Step 4: runNotebookEngineCell**

I `runNotebookEngineCell` (`index.html:11122`), etter `var sess = engine.notebookSession;` (11133), sett inn (dokument-brede opts, samme konvensjon som pyodide-per-celle-stien):

```js
      var _engPretty = getPrettyEffective(extractScriptOptions(scriptInput.value));
```

Oppdater BEGGE runCell-kallene:
- preambelen (11158): `await sess.runCell(window.Cells.execCellSource(_pre) || '', { pretty: _engPretty });`
- målcellen (11167): `var res = await sess.runCell((payload && payload.selText) || payload.text || '', { pretty: _engPretty });`

(JsEngine sin `runCell(source)` ignorerer det ekstra argumentet — ingen endring der.)

- [ ] **Step 5: Verifiser**

Run: `grep -c "_set_pretty" js/brython-engine.js js/micropython-engine.js brython/brython_runner.py micropython/micropython_runner.py` → Expected: 2/3/1/1 (brython-engine: run+nbRunCell; mpy-engine: handles+run+nbRunCell; runnerne: def-linjen).
Run: `node --test tests/js/*.test.js 2>&1 | tail -3` → Expected: ingen failing.
Run: `python3 -m pytest -q 2>&1 | tail -2` → Expected: alt grønt.

- [ ] **Step 6: Commit**

```bash
git add js/brython-engine.js js/micropython-engine.js index.html
git commit -m "feat: opts.pretty-kanal gjennom brython/micropython-motorene og kallstedene"
```

---

### Task 7: Docs, full suite og browser-smoke

**Files:**
- Modify: `docs/interactive-elements.html` (display-policy-avsnittet, linjer 105-126)
- Modify: `command_help.js` (kun hvis `show` er dokumentert der — sjekk først)

**Interfaces:**
- Consumes: alt over.
- Produces: brukervendt dokumentasjon + verifisert helhet.

- [ ] **Step 1: Docs**

I `docs/interactive-elements.html`, etter display-policy-avsnittet (linjer 105-126), legg til et kort avsnitt «Pen output (pretty_output)» som dokumenterer (samme stil/format som naboavsnittene):
- Default på; `#options.pretty_output=False` og meny-toggelen; presedens direktiv > meny.
- `show.defaults` med de tre nøklene og gyldige verdier (`html`/`tabulator`/`text`; `default: auto` = `_repr_html_`-fallback).
- `show(df, format=..., pagination=..., height=..., filters=..., sortable=..., title=...)` — nå også i python-modus.
- `print(df)` gir alltid rå tekst.
- Kjente avgrensninger: `show.defaults['series']` er python-modus-only (shimene mangler `columns` på Series); Forklar/«Kjør skrittvis» arver flagget fra forrige kjøring; endret kontrakt: `show(df)` uten `format=` følger nå `show.defaults` (html), bruk `format='tabulator'` for den gamle visningen.

Sjekk også: `grep -n "show" command_help.js | head` — hvis `show` har en hjelpetekst der, oppdater den med `format=`-kwargen og `show.defaults`; hvis ikke, hopp over.

- [ ] **Step 2: Full suite**

Run: `python3 -m pytest -q 2>&1 | tail -2` → Expected: alt grønt.
Run: `node --test tests/js/*.test.js 2>&1 | tail -3` → Expected: ingen failing.

- [ ] **Step 3: Browser-smoke (kort)**

Start: `python3 -m http.server 8000` i repo-roten, åpne `http://localhost:8000/` og **hard-reload med «ignore cache»** (kjent felle: Chrome HTTP-cacher `js/`). Sjekkliste:
1. python-modus: kjør `import pandas as pd` + `df = pd.DataFrame({"a":[1,2]})` + naken `df` → HTML-tabell (ikke `<pre>`-tekst). Legg til `#options.pretty_output=False` øverst → rekjør → ren tekst.
2. python-modus: `show(df, format="tabulator")` → interaktiv tabell.
3. brython-modus: naken `df` → HTML-tabell; kjør så `show.defaults["dataframe"] = "tabulator"` i en celle og naken `df` i neste → tabulator.
4. brython-modus: `x = ui.html.link("Lenke", href="#")` + naken `x` → lenken monteres levende (ikke statisk kopi).
5. Innstillinger: sett «Pen output» til Av → naken `df` i python-modus gir tekst. Sett Decimals til 3, lagre, reload → åpne Innstillinger igjen og se at 3 står (bugfiks-verifisering).
6. Et plott (f.eks. plotly) rendres som før i begge pretty-tilstander.

- [ ] **Step 4: Commit**

```bash
git add docs/interactive-elements.html command_help.js
git commit -m "docs: pretty output-dokumentasjon (interactive-elements + evt. command_help)"
```
