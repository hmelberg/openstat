"""brython/ui_brython.py sin fasade testet i CPython (speiler
tests/test_ui_module.py, som tester pyodide/ui.py): `browser`-modulen
stubbes med et `window.Ui.registerControl` som fanger spec-JSON-en og
returnerer en gitt kanned verdi (eller None/falsy sentinel, for å teste
plain-script-fallback-stien - se filhode-kommentaren i ui_brython.py om
Brythons ekte-JS-null-er-ikke-Python-None-fella)."""
import importlib.util
import json
import pathlib
import sys
import types

import pytest


class FakeUiJs:
    def __init__(self, next_result=None):
        self.calls = []
        self.next_result = next_result

    def registerControl(self, spec_json):
        self.calls.append(json.loads(spec_json))
        return self.next_result


def _load_ui(monkeypatch, next_result=None, ui_js=None):
    browser = types.ModuleType("browser")
    fake = ui_js if ui_js is not None else FakeUiJs(next_result=next_result)
    browser.window = types.SimpleNamespace(Ui=fake)
    monkeypatch.setitem(sys.modules, "browser", browser)
    path = pathlib.Path(__file__).resolve().parents[1] / "ui_brython.py"
    spec = importlib.util.spec_from_file_location("ui_brython_under_test", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod, fake


# ---- (a) fallback (registerControl -> None): plain-script / ingen notatbok-støtte ----

def test_slider_fallback_default_er_min(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=None)
    assert mod.slider(0, 100) == 0
    assert fake.calls[-1]["min"] == 0


def test_slider_fallback_bruker_gitt_value(monkeypatch):
    mod, _ = _load_ui(monkeypatch, next_result=None)
    assert mod.slider(0, 100, value=42) == 42


def test_dropdown_fallback_default_er_forste_valg(monkeypatch):
    mod, _ = _load_ui(monkeypatch, next_result=None)
    assert mod.dropdown(["a", "b", "c"]) == "a"


def test_checkbox_fallback_default_er_false(monkeypatch):
    mod, _ = _load_ui(monkeypatch, next_result=None)
    assert mod.checkbox("Vis") is False
    assert mod.checkbox("Vis", value=True) is True


def test_switch_fallback_default_er_value(monkeypatch):
    mod, _ = _load_ui(monkeypatch, next_result=None)
    assert mod.switch("Aktiv") is False
    assert mod.switch("Aktiv", value=True) is True


def test_number_fallback_default_er_value(monkeypatch):
    mod, _ = _load_ui(monkeypatch, next_result=None)
    assert mod.number(7) == 7


def test_text_fallback_default_er_value(monkeypatch):
    mod, _ = _load_ui(monkeypatch, next_result=None)
    assert mod.text("hei") == "hei"


def test_button_fallback_returnerer_none(monkeypatch):
    mod, _ = _load_ui(monkeypatch, next_result=None)
    assert mod.button("Kjør") is None


# ---- (b) spec JSON for slider inneholder type/min/max/step + rerun ----

def test_slider_spec_inneholder_forventede_nokler(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=None)
    mod.slider(0, 200, value=50, step=5, label="N", name="n", rerun="plot")
    spec = fake.calls[-1]
    assert spec["type"] == "slider"
    assert spec["min"] == 0
    assert spec["max"] == 200
    assert spec["step"] == 5
    assert spec["value"] == 50
    assert spec["label"] == "N"
    assert spec["name"] == "n"
    assert spec["rerun"] == "plot"


def test_slider_spec_default_rerun_er_self(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=None)
    mod.slider(0, 10)
    assert fake.calls[-1]["rerun"] == "self"


# ---- placement (Task 3, per-kontroll plassering) — ren gjennomstrøms-kwarg,
# validering skjer på JS-siden (js/ui.js sin normalizeSpec) ----

def test_slider_placement_passthrough_i_spec(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=None)
    mod.slider(0, 10, placement="left")
    assert fake.calls[-1]["placement"] == "left"


def test_slider_uten_placement_utelates_fra_spec(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=None)
    mod.slider(0, 10)
    assert "placement" not in fake.calls[-1]


def test_dropdown_placement_passthrough(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=None)
    mod.dropdown(["a", "b"], placement="bottom")
    assert fake.calls[-1]["placement"] == "bottom"


def test_checkbox_placement_passthrough(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=None)
    mod.checkbox("Vis", placement="top")
    assert fake.calls[-1]["placement"] == "top"


def test_switch_placement_passthrough(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=None)
    mod.switch("Aktiv", placement="left")
    assert fake.calls[-1]["placement"] == "left"


def test_number_placement_passthrough(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=None)
    mod.number(3, placement="bottom")
    assert fake.calls[-1]["placement"] == "bottom"


def test_text_placement_passthrough(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=None)
    mod.text("hei", placement="left")
    assert fake.calls[-1]["placement"] == "left"


def test_button_placement_passthrough(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=None)
    mod.button("Kjør", placement="top")
    assert fake.calls[-1]["placement"] == "top"


# ---- (c) live-sti: registerControl returnerer en verdi ----

def test_slider_live_returnerer_int(monkeypatch):
    mod, _ = _load_ui(monkeypatch, next_result="42")
    result = mod.slider(0, 100)
    assert result == 42
    assert isinstance(result, int)


def test_dropdown_live_returnerer_str(monkeypatch):
    mod, _ = _load_ui(monkeypatch, next_result=json.dumps("blue"))
    result = mod.dropdown(["red", "blue", "green"])
    assert result == "blue"
    assert isinstance(result, str)


def test_number_live_returnerer_float_ved_desimal(monkeypatch):
    mod, _ = _load_ui(monkeypatch, next_result="3.5")
    result = mod.number(0)
    assert result == 3.5
    assert isinstance(result, float)


def test_checkbox_live_returnerer_bool(monkeypatch):
    mod, _ = _load_ui(monkeypatch, next_result="true")
    assert mod.checkbox("Vis") is True


def test_button_live_returnerer_none_uansett(monkeypatch):
    mod, _ = _load_ui(monkeypatch, next_result="null")
    assert mod.button("Kjør") is None


# ---- skalar-koersjon + serialiseringsfeil ----

class FakeNumpyScalar:
    """Stub som treffer _scalar-vaktene eksakt (type.__module__ == 'numpy',
    har .item(), ikke __len__) uten å avhenge av numpy i testmiljøet."""
    def __init__(self, v):
        self._v = v

    def item(self):
        return self._v


FakeNumpyScalar.__module__ = "numpy"


def test_slider_numpy_skalar_koerseres_i_spec(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=None)
    result = mod.slider(FakeNumpyScalar(0), FakeNumpyScalar(200),
                        value=FakeNumpyScalar(50), step=FakeNumpyScalar(5))
    spec = fake.calls[-1]   # json.dumps overlevde -> spec ble sendt
    assert spec["min"] == 0
    assert spec["max"] == 200
    assert spec["value"] == 50
    assert spec["step"] == 5
    assert result == 50     # fallback: value ble gitt


def test_userialiserbar_value_gir_typeerror_hoyt(monkeypatch):
    """En value= som json.dumps ikke tåler skal feile HØYT på live-stien,
    ikke stille falle tilbake til plain-script-defaulten."""
    mod, fake = _load_ui(monkeypatch, next_result="42")
    with pytest.raises(TypeError):
        mod.slider(0, 100, value=object())
    assert fake.calls == []   # registerControl ble aldri nådd


def test_text_fallback_koerserer_til_str(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=None)
    result = mod.text(value=123)
    assert result == "123"
    assert isinstance(result, str)
    assert fake.calls[-1]["value"] == "123"   # str også i selve specen


# ---- (d) dropdown med tomt options skal feile tydelig ----

def test_dropdown_tomt_options_gir_valueerror(monkeypatch):
    mod, _ = _load_ui(monkeypatch, next_result=None)
    with pytest.raises(ValueError):
        mod.dropdown([])


# ---- ekte JS null (ikke Python None) fra registerControl (Brython-verifisert fella) ----

class FakeJsNull:
    """Etterligner Brythons ekte JS `null`-sentinel: falsy, men IKKE
    `is None` (verifisert - se brython/duckdb_brython.py og
    js/brython-engine.js). _register må bruke `not raw`, ikke `raw is
    None`, ellers kastes TypeError i json.loads."""
    def __bool__(self):
        return False


def test_slider_ekte_js_null_gir_fallback_ikke_typeerror(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=FakeJsNull())
    assert mod.slider(0, 100, value=42) == 42


def test_dropdown_ekte_js_null_gir_fallback_ikke_typeerror(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=FakeJsNull())
    assert mod.dropdown(["a", "b"]) == "a"


# ---- window/Ui mangler helt ----

def test_ingen_ui_paa_window_gir_samme_fallback(monkeypatch):
    browser = types.ModuleType("browser")
    browser.window = types.SimpleNamespace()   # ingen .Ui-attributt
    monkeypatch.setitem(sys.modules, "browser", browser)
    path = pathlib.Path(__file__).resolve().parents[1] / "ui_brython.py"
    spec = importlib.util.spec_from_file_location("ui_brython_under_test_nowindow", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.slider(0, 100) == 0
    assert mod.text("hei") == "hei"


# MERK: ui_brython.py, i likhet med brython/dash.py, gjør `from browser
# import window` UBESKYTTET (ingen try/except ImportError) - dette er
# bevisst forskjellig fra pyodide/ui.py, som er defensiv mot at `js`-
# modulen kan mangle helt i noen pyodide-kontekster. Brython-motoren
# garanterer at `browser`-modulen alltid finnes når denne fila lastes (den
# kjører kun inni selve Brython-runtimen), så det finnes ingen
# tilsvarende "ingen browser-modul i det hele tatt"-fallback å teste her.
