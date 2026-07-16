"""pyodide/ui.py sin fasade testet i CPython: `js`-modulen stubbes med et
`window.Ui.registerControl` som fanger spec-JSON-en og returnerer en gitt
kanned verdi (eller None, for aa teste plain-script-fallback-stien)."""
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
    js = types.ModuleType("js")
    fake = ui_js if ui_js is not None else FakeUiJs(next_result=next_result)
    js.window = types.SimpleNamespace(Ui=fake)
    monkeypatch.setitem(sys.modules, "js", js)
    path = pathlib.Path(__file__).resolve().parents[1] / "pyodide" / "ui.py"
    spec = importlib.util.spec_from_file_location("ui_under_test", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod, fake


# ---- (a) fallback (registerControl -> None): plain-script / ingen notatbok ----

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


# ---- on_click/on_change (W5.1) — kanoniske aliaser for rerun, aliaset vinner ----

def test_on_click_alias_wins_over_rerun(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=None)
    mod.button("Kjør", rerun="a", on_click="plot")
    assert fake.calls[-1]["rerun"] == "plot"


def test_on_change_alias_on_slider(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=None)
    mod.slider(1, 10, on_change="plot")
    assert fake.calls[-1]["rerun"] == "plot"


def test_no_alias_keeps_rerun_default(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=None)
    mod.slider(1, 10)
    assert fake.calls[-1].get("rerun") == "self"


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


# ---- skalar-koersjon + serialiseringsfeil (review-runde 2) ----

class FakeNumpyScalar:
    """Stub som treffer _scalar-vaktene eksakt (type.__module__ == 'numpy',
    har .item(), ikke __len__) uten aa avhenge av numpy i testmiljoet."""
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


def test_number_ekte_numpy_skalar_koerseres(monkeypatch):
    np = pytest.importorskip("numpy")
    mod, fake = _load_ui(monkeypatch, next_result=None)
    mod.number(np.int64(7), min=np.float64(0.5), max=np.int64(10))
    spec = fake.calls[-1]
    assert spec["value"] == 7
    assert spec["min"] == 0.5
    assert spec["max"] == 10


def test_userialiserbar_value_gir_typeerror_hoyt(monkeypatch):
    """En value= som json.dumps ikke taaler skal feile HOYT paa live-stien,
    ikke stille falle tilbake til plain-script-defaulten."""
    mod, fake = _load_ui(monkeypatch, next_result="42")
    with pytest.raises(TypeError):
        mod.slider(0, 100, value=object())
    assert fake.calls == []   # registerControl ble aldri naadd


def test_text_fallback_koerserer_til_str(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=None)
    result = mod.text(value=123)
    assert result == "123"
    assert isinstance(result, str)
    assert fake.calls[-1]["value"] == "123"   # str ogsaa i selve specen


# ---- (d) dropdown med tomt options skal feile tydelig ----

def test_dropdown_tomt_options_gir_valueerror(monkeypatch):
    mod, _ = _load_ui(monkeypatch, next_result=None)
    with pytest.raises(ValueError):
        mod.dropdown([])


# ---- ekte JS null (ikke Python None) fra registerControl (browser-bug) ----

class FakeJsNull:
    """Etterligner pyodide.ffi.JsNull: falsy, men IKKE `is None` - ekte JS
    `null` konverteres til denne sentinelen over pyodide-grensen, ikke til
    Python None. _register maa bruke `not raw`, ikke `raw is None`, ellers
    kastes TypeError i json.loads (funnet i browserverifisering, Task 5)."""
    def __bool__(self):
        return False


def test_slider_ekte_js_null_gir_fallback_ikke_typeerror(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=FakeJsNull())
    assert mod.slider(0, 100, value=42) == 42


def test_dropdown_ekte_js_null_gir_fallback_ikke_typeerror(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=FakeJsNull())
    assert mod.dropdown(["a", "b"]) == "a"


# ---- window/Ui mangler helt (enda tidligere pyodide-tilstand) ----

def test_ingen_window_gir_samme_fallback(monkeypatch):
    js = types.ModuleType("js")
    js.window = None
    monkeypatch.setitem(sys.modules, "js", js)
    path = pathlib.Path(__file__).resolve().parents[1] / "pyodide" / "ui.py"
    spec = importlib.util.spec_from_file_location("ui_under_test_nowindow", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.slider(0, 100) == 0
    assert mod.text("hei") == "hei"


def test_ingen_js_modul_i_det_hele_tatt(monkeypatch):
    """Simulerer ren CPython uten pyodide-stub: `from js import window` feiler
    med ImportError, og modulen faller tilbake til window = None."""
    monkeypatch.delitem(sys.modules, "js", raising=False)
    real_import = __import__

    def fake_import(name, *args, **kwargs):
        if name == "js":
            raise ImportError("ingen js-modul her")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", fake_import)
    path = pathlib.Path(__file__).resolve().parents[1] / "pyodide" / "ui.py"
    spec = importlib.util.spec_from_file_location("ui_under_test_noimport", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.slider(0, 100) == 0
    assert mod.button("Kjør") is None


# ---- (e) event-payload klassifisering (W5.2) ----

def test_event_payload_text_from_return(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    p = mod._event_payload(42, "")
    assert p == {"kind": "text", "text": "42"}


def test_event_payload_stdout_prepended(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    p = mod._event_payload("res", "logget\n")
    assert p["kind"] == "text" and "logget" in p["text"] and "res" in p["text"]


def test_event_payload_none_with_stdout(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    assert mod._event_payload(None, "bare print\n") == {"kind": "text", "text": "bare print"}


def test_event_payload_none_silent(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    assert mod._event_payload(None, "") is None   # ingenting å rendre


def test_event_payload_figure_ducktype(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    class Fig:
        def to_plotly_json(self):
            return {"data": [{"y": [1]}], "layout": {"title": "x"}}
    p = mod._event_payload(Fig(), "")
    assert p["kind"] == "figure" and p["spec"]["layout"]["title"] == "x"


def test_event_payload_dataframe_ducktype(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    class DF:
        columns = ["a"]
        def to_html(self, **kw):
            return "<table><tr><td>1</td></tr></table>"
    p = mod._event_payload(DF(), "")
    assert p["kind"] == "table" and p["html"].startswith("<table")


def test_wrapper_catches_exception(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    def boom(evt):
        raise ValueError("au")
    w = mod._make_event_wrapper(boom)
    out = json.loads(w('{"type":"click"}'))
    assert out["kind"] == "error" and "au" in out["text"]


def test_wrapper_passes_event_dict(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    seen = {}
    def h(evt):
        seen.update(evt)
        return "ok"
    w = mod._make_event_wrapper(h)
    out = json.loads(w('{"type":"click","value":"7"}'))
    assert seen["value"] == "7" and out["kind"] == "text"


def test_on_and_run_cell_return_none_without_browser(monkeypatch):
    # CPython: window is None -> begge er no-op uten å kaste
    mod, _ = _load_ui(monkeypatch, next_result=None)
    monkeypatch.setattr(mod, "window", None)
    assert mod.on("#x", "click", lambda e: None) is None
    assert mod.run_cell("#x", "click", "plot") is None


# ---- sync_to (Task 4, push til live session variable utan rerun) ----

def test_sync_to_passed_through_all_value_controls(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=None)
    mod.slider(1, 10, sync_to="n")
    mod.dropdown(["a", "b"], sync_to="valg")
    mod.number(value=3, sync_to="my.var")
    specs = [s for s in fake.calls]
    assert specs[0].get("sync_to") == "n"
    assert specs[1].get("sync_to") == "valg"
    assert specs[2].get("sync_to") == "my.var"


def test_sync_to_absent_when_not_given(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=None)
    mod.slider(0, 10)
    spec = fake.calls[-1]
    assert "sync_to" not in spec


def test_checkbox_sync_to_passthrough(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=None)
    mod.checkbox("Vis", sync_to="cb_state")
    assert fake.calls[-1].get("sync_to") == "cb_state"


def test_switch_sync_to_passthrough(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=None)
    mod.switch("Aktiv", sync_to="switch_state")
    assert fake.calls[-1].get("sync_to") == "switch_state"


def test_text_sync_to_passthrough(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=None)
    mod.text("default", sync_to="txt_val")
    assert fake.calls[-1].get("sync_to") == "txt_val"
