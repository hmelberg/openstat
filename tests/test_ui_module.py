"""pyodide/ui.py sin fasade testet i CPython: `js`-modulen stubbes med et
`window.Ui.registerControl` som fanger spec-JSON-en og returnerer en gitt
kanned verdi (eller None, for aa teste plain-script-fallback-stien)."""
import importlib.util
import json
import pathlib
import sys
import types

import pytest

# fase 3: fasaden importerer ui_core fra shared/ — gjør den importerbar
# FØR fasade-lastingen (samme mekanisme i alle tre fasade-suitene).
_SHARED = str(pathlib.Path(__file__).resolve().parents[1] / "shared")
if _SHARED not in sys.path:
    sys.path.insert(0, _SHARED)


class FakeUiJs:
    """window.Ui-stubben. `next_result` speiler ekte Ui.registerControl sin
    JSON-STRENG-retur (eller None/FakeJsNull for "ingen kjørekontekst") -
    UENDRET oppførsel fra før ui-html-fasen. ui-html-fasen (Task 2) legger
    til: has_handler-pakking (KUN når next_result er en ekte JSON-streng -
    ekte Ui.registerControl sjekker kjørekontekst FØR has_handler, så et
    manglende-kontekst-resultat skal forbli upakket uansett has_handler),
    bindControlHandler-opptak, og el*/value-opptak (elCreate/elSetProps/
    elAppend/elClear/elOn/elShow/elNode/value)."""

    def __init__(self, next_result=None, next_key="k1", value_store=None, imports=None, widget_keys=None, widget_value_store=None):
        self.calls = []
        self.next_result = next_result
        self.next_key = next_key
        self.bound_handlers = {}   # controlKey -> handler (fra bindControlHandler)
        self.value_store = value_store if value_store is not None else {}
        self.el_calls = []
        self._next_el_id = 1
        # fase 4b: speiler js/ui.js sin Ui.widgetValue - {controlKey: rå
        # python-verdi}, json.dumps'et ved lesing (samme retur-kontrakt som
        # ekte Ui.widgetValue: en JSON-STRENG, eller None for ukjent nøkkel).
        self.widget_value_store = widget_value_store if widget_value_store is not None else {}
        # ui-html-fasen (Task 4): speiler window.__uiImports (js/ui.js sin
        # Ui.hasImport) - {ns: True} for "importert", fraværende/False for
        # "ikke importert ennå".
        self.imports = imports if imports is not None else {}
        # dash-absorpsjon 5a Task 2: speiler js/ui.js sin Ui.widgetLookup —
        # {navn: controlKey}, fraværende navn -> None (ukjent). widget_calls
        # (separat fra el_calls, samme opptaksfilosofi) samler
        # widgetLookup/widgetSet/widgetVisible/widgetNode/widgetBind-kall.
        self.widget_keys = widget_keys if widget_keys is not None else {}
        self.widget_calls = []
        # widgetSet sin retur (JSON-streng) — None betyr "ekko tilbake den
        # mottatte JSON-en uendret" (default, dekker "koersjon skjer i
        # js/ui.js" — testene som eksplisitt vil se en KLAMPET/koersert
        # retur setter denne selv).
        self.widget_set_result = None

    def widgetLookup(self, name):
        self.widget_calls.append(("widgetLookup", name))
        return self.widget_keys.get(name)

    def widgetSet(self, key, value_json):
        self.widget_calls.append(("widgetSet", key, json.loads(value_json)))
        if self.widget_set_result is not None:
            return self.widget_set_result
        return value_json

    def widgetVisible(self, key, visible):
        self.widget_calls.append(("widgetVisible", key, visible))

    def widgetNode(self, key, which):
        self.widget_calls.append(("widgetNode", key, which))
        return "node:" + str(key) + ":" + str(which)

    def widgetBind(self, key, event, handler):
        self.widget_calls.append(("widgetBind", key, event, handler))
        return True

    def widgetValue(self, key):
        # fase 4b: speiler js/ui.js sin Ui.widgetValue(key) - nøkkel-basert
        # verdioppslag (til forskjell fra Ui.value(navn)) for navnløse
        # into=-håndtak sin .value.
        self.widget_calls.append(("widgetValue", key))
        if key not in self.widget_value_store:
            return None
        return json.dumps(self.widget_value_store[key])

    def registerControl(self, spec_json):
        spec = json.loads(spec_json)
        self.calls.append(spec)
        # fase 4b: into= — når spec inneholder "into" OG en ekte kjørekontekst
        # finnes (next_result er en JSON-verdi-streng, samme "ekte kontekst"-
        # signal som has_handler-grenen under bruker), speiler
        # Ui.registerControl sin utvidede objekt-retur ({"__into": true,
        # "value":..., "key":..., "name":...}, Task 1) - mounting "lykkes"
        # alltid i denne stubben (ingen ekte _els-register å slå feil mot;
        # ukjent-el-id-fallback er JS-sidens ansvar, testet der).
        if spec.get("into") and isinstance(self.next_result, str):
            return json.dumps({
                "__into": True,
                "value": json.loads(self.next_result),
                "key": self.next_key,
                "name": spec.get("name"),
            })
        if spec.get("has_handler") and isinstance(self.next_result, str):
            return json.dumps({"value": json.loads(self.next_result), "key": self.next_key})
        return self.next_result

    def bindControlHandler(self, key, handler):
        self.bound_handlers[key] = handler

    # ---- ui.html element-motoren (Task 1-kontrakten, speilet her) ----

    def elCreate(self, tag, props_json):
        el_id = "el" + str(self._next_el_id)
        self._next_el_id += 1
        self.el_calls.append(("elCreate", tag, json.loads(props_json) if props_json else None))
        return el_id

    def elSetProps(self, el_id, props_json):
        self.el_calls.append(("elSetProps", el_id, json.loads(props_json) if props_json else None))

    def elAppend(self, parent_id, child_json):
        self.el_calls.append(("elAppend", parent_id, json.loads(child_json)))

    def elClear(self, el_id):
        self.el_calls.append(("elClear", el_id))

    def elPayload(self, el_id, payload_json):
        # dash-absorpsjon 5a Task 3: speiler js/ui.js sin Ui.elPayload —
        # tar imot (elId, payloadJson) og returnerer en (her: rå dict, den
        # PYTHONske fasadens kpi/markdown/image-byggere bryr seg aldri om
        # returverdien - se _payload_element).
        payload = json.loads(payload_json)
        self.el_calls.append(("elPayload", el_id, payload))
        return payload

    def elOn(self, el_id, event, handler):
        self.el_calls.append(("elOn", el_id, event, handler))
        return True

    def elShow(self, el_id, opts_json):
        self.el_calls.append(("elShow", el_id, json.loads(opts_json) if opts_json else None))

    def elNode(self, el_id):
        self.el_calls.append(("elNode", el_id))
        return "node:" + el_id

    def value(self, name):
        self.el_calls.append(("value", name))
        return self.value_store.get(name)

    def hasImport(self, ns):
        self.el_calls.append(("hasImport", ns))
        return bool(self.imports.get(ns))


def _load_ui(monkeypatch, next_result=None, ui_js=None, next_key="k1", value_store=None, imports=None, widget_keys=None, widget_value_store=None):
    js = types.ModuleType("js")
    fake = ui_js if ui_js is not None else FakeUiJs(
        next_result=next_result, next_key=next_key, value_store=value_store, imports=imports, widget_keys=widget_keys,
        widget_value_store=widget_value_store)
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


def test_run_button_default_er_kjor_all(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=None)
    assert mod.run_button() is None
    assert fake.calls[-1]["label"] == "Kjør"
    assert fake.calls[-1]["rerun"] == "all"


def test_run_button_target_celle_id(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=None)
    mod.run_button("Oppdater", target="plott")
    assert fake.calls[-1]["label"] == "Oppdater"
    assert fake.calls[-1]["rerun"] == "plott"


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


# ═══════════════════════════════════════════════════════════════════════
# ui-html-fasen (Task 2, spec 2026-07-17-ui-html-design.md): ui.html-
# byggere, kwargs-normalisering, widget-callables, ui.value.
# ═══════════════════════════════════════════════════════════════════════

# ---- _alias_rerun: en callable skal ALDRI havne i rerun= ----

def test_alias_rerun_skips_callable(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    handler = lambda v: v
    assert mod._alias_rerun("self", handler) == "self"
    assert mod._alias_rerun("plot", handler) == "plot"


def test_alias_rerun_string_still_wins(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    assert mod._alias_rerun("self", "plot") == "plot"


def test_alias_rerun_none_alias_keeps_rerun(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    assert mod._alias_rerun("self", None) == "self"


# ---- _register_value: dual retur-form (skalar vs {value,key}) ----

def test_register_value_unwraps_dict_shape_and_binds(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result="9", next_key="kx")
    spec = {"type": "slider"}
    result = mod._register_value(spec, lambda v: v)
    assert spec["has_handler"] is True
    assert result == 9
    assert "kx" in fake.bound_handlers


def test_register_value_plain_scalar_when_no_handler(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result="9")
    spec = {"type": "slider"}
    result = mod._register_value(spec, None)
    assert "has_handler" not in spec
    assert result == 9
    assert fake.bound_handlers == {}


def test_register_value_string_handler_not_callable_untouched(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result="9")
    spec = {"type": "slider"}
    result = mod._register_value(spec, "cellnavn")
    assert "has_handler" not in spec
    assert result == 9


# ---- widget on_change/on_click callable dispatch (vs. streng-alias) ----

def test_slider_on_change_callable_sets_has_handler_and_binds(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result="5", next_key="cell0::0::n")
    result = mod.slider(0, 10, name="n", on_change=lambda v: v)
    assert result == 5
    assert fake.calls[-1]["has_handler"] is True
    assert fake.calls[-1]["rerun"] == "self"   # callable havner ALDRI i rerun=
    assert "cell0::0::n" in fake.bound_handlers


def test_slider_on_change_string_no_handler_binding(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result="5")
    result = mod.slider(0, 10, on_change="plot")
    assert result == 5
    assert "has_handler" not in fake.calls[-1]
    assert fake.calls[-1]["rerun"] == "plot"
    assert fake.bound_handlers == {}


def test_slider_on_change_callable_no_ctx_falls_back(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=None)
    result = mod.slider(0, 100, value=42, on_change=lambda v: v)
    assert result == 42
    assert fake.bound_handlers == {}


def test_dropdown_on_change_callable(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=json.dumps("blue"), next_key="k3")
    result = mod.dropdown(["red", "blue"], on_change=lambda v: v)
    assert result == "blue"
    assert "k3" in fake.bound_handlers


def test_checkbox_on_change_callable(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result="true", next_key="k4")
    result = mod.checkbox("Vis", on_change=lambda v: None)
    assert result is True
    assert "k4" in fake.bound_handlers


def test_switch_on_change_callable(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result="true", next_key="k5")
    result = mod.switch("Aktiv", on_change=lambda v: None)
    assert result is True
    assert "k5" in fake.bound_handlers


def test_number_on_change_callable(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result="3.5", next_key="k6")
    result = mod.number(0, on_change=lambda v: None)
    assert result == 3.5
    assert "k6" in fake.bound_handlers


def test_text_on_change_callable(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=json.dumps("hei"), next_key="k7")
    result = mod.text("", on_change=lambda v: None)
    assert result == "hei"
    assert "k7" in fake.bound_handlers


def test_button_on_click_callable_receives_none_value(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result="null", next_key="k2")
    result = mod.button("Kjør", on_click=lambda v: v)
    assert result is None
    assert fake.calls[-1]["has_handler"] is True
    seen = []
    handler = fake.bound_handlers["k2"]
    handler(json.dumps({"value": None}))
    # via _make_event_wrapper -> handler kalt med den unwrapte verdien
    # (bekreftes indirekte i wrapper-testene under; her: bare at kallet
    # ikke kaster og at en handler faktisk ble bundet).


def test_button_on_click_string_alias_unaffected(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=None)
    result = mod.button("Kjør", on_click="plot")
    assert result is None
    assert "has_handler" not in fake.calls[-1]
    assert fake.calls[-1]["rerun"] == "plot"


# ---- bindControlHandler-wrapperen: pakker ut {"value": v} -> handler(v) ----

def test_bound_control_handler_wrapper_calls_python_handler_with_unwrapped_value(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result="5", next_key="k1")
    seen = []
    def h(v):
        seen.append(v)
        return "fikk " + str(v)
    mod.slider(0, 10, on_change=h)
    handler = fake.bound_handlers["k1"]
    out = json.loads(handler(json.dumps({"value": 7})))
    assert seen == [7]
    assert out == {"kind": "text", "text": "fikk 7"}


def test_bound_control_handler_wrapper_catches_exception(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result="5", next_key="k1")
    def boom(v):
        raise ValueError("au")
    mod.slider(0, 10, on_change=boom)
    handler = fake.bound_handlers["k1"]
    out = json.loads(handler(json.dumps({"value": 1})))
    assert out["kind"] == "error" and "au" in out["text"]


def test_bound_control_handler_wrapper_button_value_is_none(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result="null", next_key="k2")
    seen = []
    mod.button("Kjør", on_click=lambda v: seen.append(v))
    handler = fake.bound_handlers["k2"]
    handler(json.dumps({"value": None}))
    assert seen == [None]


# ---- ui.value(name) ----

def test_ui_value_reads_stored_value(monkeypatch):
    mod, fake = _load_ui(monkeypatch, value_store={"n": 7})
    assert mod.value("n") == 7


def test_ui_value_unknown_name_returns_none(monkeypatch):
    mod, fake = _load_ui(monkeypatch, value_store={})
    assert mod.value("missing") is None


def test_ui_value_real_js_null_returns_none(monkeypatch):
    mod, fake = _load_ui(monkeypatch)
    fake.value_store = {"n": mod.JsNull()}
    assert mod.value("n") is None


def test_ui_value_falsy_real_values_survive(monkeypatch):
    mod, fake = _load_ui(monkeypatch, value_store={"z": 0, "f": False, "s": ""})
    assert mod.value("z") == 0
    assert mod.value("f") is False
    assert mod.value("s") == ""


def test_ui_value_no_window_returns_none(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    monkeypatch.setattr(mod, "window", None)
    assert mod.value("n") is None


def test_ui_value_bridge_exception_returns_none(monkeypatch):
    mod, fake = _load_ui(monkeypatch)
    def boom(name):
        raise RuntimeError("no ui.js")
    fake.value = boom
    assert mod.value("n") is None


# ---- ui.widget("navn") — WidgetHandle (dash-absorpsjon 5a Task 2) ----------
# Ettlinjeregel: ui.slider(...) DEKLARERER kontrollen og gir verdien;
# ui.widget("navn") gir HÅNDTAKET.

def test_widget_unknown_name_returns_none_and_warns(monkeypatch):
    mod, fake = _load_ui(monkeypatch, widget_keys={})
    warned = []
    monkeypatch.setattr(mod, "_warn", warned.append)
    h = mod.widget("finnes-ikke")
    assert h is None
    assert len(warned) == 1


def test_widget_no_window_returns_none(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    monkeypatch.setattr(mod, "window", None)
    assert mod.widget("x") is None


def test_widget_bridge_exception_returns_none(monkeypatch):
    mod, fake = _load_ui(monkeypatch, widget_keys={"x": "0::x"})
    def boom(name):
        raise RuntimeError("no ui.js")
    fake.widgetLookup = boom
    assert mod.widget("x") is None


def test_widget_known_name_returns_handle(monkeypatch):
    mod, fake = _load_ui(monkeypatch, widget_keys={"x": "0::x"})
    h = mod.widget("x")
    assert isinstance(h, mod.WidgetHandle)
    assert h._name == "x"
    assert h._key == "0::x"


def test_widget_value_property_reads_live_via_ui_value(monkeypatch):
    mod, fake = _load_ui(monkeypatch, widget_keys={"x": "0::x"}, value_store={"x": 7})
    h = mod.widget("x")
    assert h.value == 7
    fake.value_store["x"] = 8
    assert h.value == 8, "live oppslag — IKKE en frosset verdi ved konstruksjon"


def test_widget_set_returns_coerced_value_and_sends_key_and_json(monkeypatch):
    mod, fake = _load_ui(monkeypatch, widget_keys={"x": "0::x"})
    fake.widget_set_result = json.dumps(10)
    h = mod.widget("x")
    assert h.set(999) == 10
    call = [c for c in fake.widget_calls if c[0] == "widgetSet"][-1]
    assert call == ("widgetSet", "0::x", 999)


def test_widget_set_without_ui_returns_none(monkeypatch):
    mod, fake = _load_ui(monkeypatch, widget_keys={"x": "0::x"})
    h = mod.widget("x")
    monkeypatch.setattr(mod, "window", None)
    assert h.set(1) is None


def test_widget_set_bridge_exception_returns_none(monkeypatch):
    mod, fake = _load_ui(monkeypatch, widget_keys={"x": "0::x"})
    h = mod.widget("x")
    def boom(key, value_json):
        raise RuntimeError("no ui.js")
    fake.widgetSet = boom
    assert h.set(1) is None


def test_widget_on_wraps_handler_and_binds_via_widgetBind(monkeypatch):
    mod, fake = _load_ui(monkeypatch, widget_keys={"x": "0::x"})
    h = mod.widget("x")
    seen = {}

    def handler(v):
        seen["v"] = v
        return "ok"

    ret = h.on("input", handler)
    assert ret is h, "kjedbar (returnerer self)"
    calls = [c for c in fake.widget_calls if c[0] == "widgetBind"]
    assert len(calls) == 1
    _, key, event, wrapped = calls[0]
    assert key == "0::x" and event == "input"
    # SAMME wrapper-konvensjon som ui.on()/Element.on() (IKKE widgets sin
    # enklere handler(value) — se _bind_handler_if_callable/on_change=):
    # handler mottar hele event-dicten.
    out = json.loads(wrapped(json.dumps({"type": "input", "value": 5})))
    assert seen["v"] == {"type": "input", "value": 5}
    assert out["kind"] == "text" and out["text"] == "ok"


def test_widget_hide_show_calls_widgetVisible_and_chain(monkeypatch):
    mod, fake = _load_ui(monkeypatch, widget_keys={"x": "0::x"})
    h = mod.widget("x")
    assert h.hide() is h
    assert h.show() is h
    calls = [c for c in fake.widget_calls if c[0] == "widgetVisible"]
    assert calls == [("widgetVisible", "0::x", False), ("widgetVisible", "0::x", True)]


def test_widget_element_and_input_call_widgetNode(monkeypatch):
    mod, fake = _load_ui(monkeypatch, widget_keys={"x": "0::x"})
    h = mod.widget("x")
    assert h.element == "node:0::x:wrap"
    assert h.input == "node:0::x:input"
    calls = [c[0] for c in fake.widget_calls if c[0] == "widgetNode"]
    assert calls == ["widgetNode", "widgetNode"]


# ---- _normalize_kwargs (PUR kjerne) - hele "unified kwargs standard"-matrisen ----

def test_normalize_cls_to_attrs_class(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    norm, handlers, warnings = mod._normalize_kwargs({"cls": "box"})
    assert norm["attrs"]["class"] == "box"
    assert handlers == [] and warnings == []


def test_normalize_class_underscore_to_attrs_class(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    norm, _, _ = mod._normalize_kwargs({"class_": "box"})
    assert norm["attrs"]["class"] == "box"


def test_normalize_kwargs_cls_og_class_samtidig_varsler(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    norm, handlers, warnings = mod._normalize_kwargs({"cls": "a", "class_": "b"})
    assert norm["attrs"]["class"] == "b"  # siste vinner (kwargs-rekkefølge)
    assert any("cls=" in w and "class_=" in w for w in warnings)


def test_normalize_kwargs_kun_cls_ingen_varsel(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    norm, _, warnings = mod._normalize_kwargs({"cls": "a"})
    assert norm["attrs"]["class"] == "a"
    assert warnings == []


def test_normalize_kwargs_attrs_class_pluss_cls_gir_ikke_cls_class_varsel(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    result, handlers, warnings = mod._normalize_kwargs({"attrs": {"class": "x"}, "cls": "y"})
    assert result["attrs"]["class"] == "y"  # siste vinner, dokumentert presedens
    assert warnings == []  # attrs-vs-cls er dok-dekket, IKKE cls/class_-varselet


def test_normalize_style_string_passthrough(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    norm, _, _ = mod._normalize_kwargs({"style": "color:red"})
    assert norm["style"] == "color:red"


def test_normalize_style_dict_snake_to_camel(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    norm, _, _ = mod._normalize_kwargs({"style": {"background_color": "red", "fontSize": 12}})
    assert norm["style"] == {"backgroundColor": "red", "fontSize": 12}


def test_normalize_no_style_key_when_absent(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    norm, _, _ = mod._normalize_kwargs({})
    assert "style" not in norm
    assert norm == {"props": {}, "attrs": {}}


def test_normalize_data_underscore_to_attrs_hyphen(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    norm, _, _ = mod._normalize_kwargs({"data_x": 1})
    assert norm["attrs"]["data-x"] == 1


def test_normalize_data_multi_underscore_all_hyphenated(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    norm, _, _ = mod._normalize_kwargs({"data_test_id": "abc"})
    assert norm["attrs"]["data-test-id"] == "abc"


def test_normalize_aria_underscore_to_attrs_hyphen(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    norm, _, _ = mod._normalize_kwargs({"aria_label": "Lukk"})
    assert norm["attrs"]["aria-label"] == "Lukk"


def test_normalize_attrs_merged_verbatim(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    norm, _, _ = mod._normalize_kwargs({"cls": "a", "attrs": {"data-x": "1", "role": "button"}})
    assert norm["attrs"] == {"class": "a", "data-x": "1", "role": "button"}


def test_normalize_attrs_non_dict_raises_typeerror(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    with pytest.raises(TypeError):
        mod._normalize_kwargs({"attrs": "oops"})


def test_normalize_bool_passthrough_in_props(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    norm, _, warnings = mod._normalize_kwargs({"checked": True, "disabled": False})
    assert norm["props"]["checked"] is True
    assert norm["props"]["disabled"] is False
    assert warnings == []


def test_normalize_generic_key_camelcased(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    norm, _, _ = mod._normalize_kwargs({"tab_index": 3})
    assert norm["props"]["tabIndex"] == 3


def test_normalize_on_event_callable_collected_as_handler(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    def h(evt):
        return None
    norm, handlers, warnings = mod._normalize_kwargs({"on_click": h})
    assert handlers == [("click", h)]
    assert "click" not in norm["props"] and "onClick" not in norm["props"]
    assert warnings == []


def test_normalize_on_event_string_warns_and_dropped(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    norm, handlers, warnings = mod._normalize_kwargs({"on_click": "cellnavn"})
    assert handlers == []
    assert len(warnings) == 1
    assert "on_click" not in norm["props"] and "on_click" not in norm["attrs"]


def test_normalize_callable_without_on_prefix_warns_and_dropped(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    norm, handlers, warnings = mod._normalize_kwargs({"click": lambda: None})
    assert handlers == []
    assert "click" not in norm["props"]
    assert len(warnings) == 1


def test_normalize_non_json_safe_value_warns_and_stringified(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    class Weird:
        def __str__(self):
            return "weird!"
    norm, _, warnings = mod._normalize_kwargs({"foo": Weird()})
    assert norm["props"]["foo"] == "weird!"
    assert len(warnings) == 1


def test_normalize_dict_and_list_values_are_json_safe(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    norm, _, warnings = mod._normalize_kwargs({"data_config": {"a": 1}, "items": [1, 2, 3]})
    assert norm["attrs"]["data-config"] == {"a": 1}
    assert norm["props"]["items"] == [1, 2, 3]
    assert warnings == []


# ---- HTML_TAGS + ui.html.__getattr__ ----

def test_html_tags_constant_contains_expected_tags(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    tags = set(mod.HTML_TAGS.split())
    for t in ("div", "span", "input", "button", "table", "svg", "video", "template", "select"):
        assert t in tags


def test_html_getattr_unknown_tag_raises_attributeerror(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    with pytest.raises(AttributeError) as exc:
        mod.html.definitely_not_a_real_tag
    assert "HTML_TAGS" in str(exc.value)


# ---- ui.html.<tag>(...) tag-byggeren + Element ----

def test_html_div_creates_element_with_props_and_class(monkeypatch):
    mod, fake = _load_ui(monkeypatch)
    el = mod.html.div("hello", cls="box")
    create_calls = [c for c in fake.el_calls if c[0] == "elCreate"]
    assert len(create_calls) == 1
    _, tag, props = create_calls[0]
    assert tag == "div"
    assert props == {"props": {}, "attrs": {"class": "box"}}
    assert el._openstat_el_id == "el1"
    assert el._classes == {"box"}
    append_calls = [c for c in fake.el_calls if c[0] == "elAppend"]
    assert append_calls == [("elAppend", "el1", {"text": "hello"})]


def test_html_builder_children_none_skipped(monkeypatch):
    mod, fake = _load_ui(monkeypatch)
    mod.html.div("a", None, "b")
    texts = [c[2]["text"] for c in fake.el_calls if c[0] == "elAppend"]
    assert texts == ["a", "b"]


def test_html_builder_children_list_flatten_one_level(monkeypatch):
    mod, fake = _load_ui(monkeypatch)
    mod.html.div("a", ["b", "c"], None)
    texts = [c[2]["text"] for c in fake.el_calls if c[0] == "elAppend"]
    assert texts == ["a", "b", "c"]


def test_html_builder_children_nested_list_warns_and_skipped(monkeypatch):
    mod, fake = _load_ui(monkeypatch)
    warned = []
    monkeypatch.setattr(mod, "_warn", warned.append)
    mod.html.div(["a", ["b", "c"]])
    texts = [c[2]["text"] for c in fake.el_calls if c[0] == "elAppend"]
    assert texts == ["a"]
    assert len(warned) == 1


def test_html_builder_children_element_appended_as_el_ref(monkeypatch):
    mod, fake = _load_ui(monkeypatch)
    inner = mod.html.span("x")
    outer = mod.html.div(inner)
    append_calls = [c for c in fake.el_calls if c[0] == "elAppend"]
    assert ("elAppend", outer._openstat_el_id, {"el": inner._openstat_el_id}) in append_calls


def test_html_builder_on_click_kwarg_binds_via_elOn(monkeypatch):
    mod, fake = _load_ui(monkeypatch)
    el = mod.html.button("Klikk", on_click=lambda evt: None)
    on_calls = [c for c in fake.el_calls if c[0] == "elOn"]
    assert len(on_calls) == 1
    assert on_calls[0][1] == el._openstat_el_id
    assert on_calls[0][2] == "click"


def test_html_builder_without_ui_returns_inert_element(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    monkeypatch.setattr(mod, "window", None)
    el = mod.html.div("hei")
    assert el._openstat_el_id is None
    assert el.el is None
    # skal ikke kaste selv uten en aktiv bro:
    el.show()
    el.clear()
    el.add_class("x")
    el.set_style(color="red")


# ---- Element-metoder ----

def test_element_add_appends_more_children(monkeypatch):
    mod, fake = _load_ui(monkeypatch)
    el = mod.html.div("a")
    el.add("b")
    texts = [c[2]["text"] for c in fake.el_calls if c[0] == "elAppend"]
    assert texts == ["a", "b"]


def test_element_clear_calls_elClear(monkeypatch):
    mod, fake = _load_ui(monkeypatch)
    el = mod.html.div()
    el.clear()
    assert ("elClear", el._openstat_el_id) in fake.el_calls


def test_element_set_style_calls_elSetProps(monkeypatch):
    mod, fake = _load_ui(monkeypatch)
    el = mod.html.div()
    el.set_style(background_color="red", fontSize=12)
    last = [c for c in fake.el_calls if c[0] == "elSetProps"][-1]
    assert last[2] == {"style": {"backgroundColor": "red", "fontSize": 12}}


def test_element_add_class_and_remove_class(monkeypatch):
    mod, fake = _load_ui(monkeypatch)
    el = mod.html.div(cls="a")
    el.add_class("b", "c")
    last = [c for c in fake.el_calls if c[0] == "elSetProps"][-1]
    assert last[2] == {"attrs": {"class": "a b c"}}
    el.remove_class("b")
    last2 = [c for c in fake.el_calls if c[0] == "elSetProps"][-1]
    assert last2[2] == {"attrs": {"class": "a c"}}


def test_element_show_default_target_none(monkeypatch):
    mod, fake = _load_ui(monkeypatch)
    el = mod.html.div()
    el.show()
    assert ("elShow", el._openstat_el_id, {"target": None}) in fake.el_calls


def test_element_show_with_target(monkeypatch):
    mod, fake = _load_ui(monkeypatch)
    el = mod.html.div()
    el.show(target="slot1")
    assert ("elShow", el._openstat_el_id, {"target": "slot1"}) in fake.el_calls


def test_element_el_property_calls_elNode(monkeypatch):
    mod, fake = _load_ui(monkeypatch)
    el = mod.html.div()
    node = el.el
    assert node == "node:" + el._openstat_el_id
    assert ("elNode", el._openstat_el_id) in fake.el_calls


def test_element_on_binds_and_dispatches(monkeypatch):
    mod, fake = _load_ui(monkeypatch)
    el = mod.html.button("Klikk")
    seen = {}
    def handler(evt):
        seen.update(evt)
        return "ok"
    el.on("click", handler)
    on_calls = [c for c in fake.el_calls if c[0] == "elOn"]
    assert len(on_calls) == 1
    _, el_id, event, wrapped = on_calls[0]
    assert el_id == el._openstat_el_id and event == "click"
    out = json.loads(wrapped('{"type":"click","value":"7"}'))
    assert seen["value"] == "7"
    assert out["kind"] == "text" and out["text"] == "ok"


def test_element_returns_self_for_chaining(monkeypatch):
    mod, fake = _load_ui(monkeypatch)
    el = mod.html.div()
    assert el.add("x") is el
    assert el.clear() is el
    assert el.set_style(color="red") is el
    assert el.add_class("a") is el
    assert el.remove_class("a") is el


# ══════════════════════════════════════════════════════════════════════════
# #tag.import — kuratert register + dynamiske navnerom (ui-html-fasen,
# Task 4, spec §4). js/ui.js sin faktiske LASTING (mdEnsureTagImports) er
# ikke testet her (JS-side, node-testet i tests/js/*) — disse testene dekker
# KUN python-fasadens del av kontrakten: modul-__getattr__, _LibNamespace,
# accepts-validering, pico-klassekartet, ui.lib().
# ══════════════════════════════════════════════════════════════════════════

def test_module_getattr_sl_not_imported_raises_clear_error(monkeypatch):
    mod, fake = _load_ui(monkeypatch, imports={})
    with pytest.raises(AttributeError, match=r"#tag\.import = sl"):
        mod.sl


def test_module_getattr_pico_not_imported_raises_clear_error(monkeypatch):
    mod, fake = _load_ui(monkeypatch, imports={})
    with pytest.raises(AttributeError, match=r"#tag\.import = pico"):
        mod.pico


def test_module_getattr_generic_not_imported_raises_clear_error(monkeypatch):
    mod, fake = _load_ui(monkeypatch, imports={})
    with pytest.raises(AttributeError, match=r"#tag\.import = acme"):
        mod.acme


def test_module_getattr_unknown_dunder_still_raises_attributeerror(monkeypatch):
    mod, fake = _load_ui(monkeypatch, imports={})
    with pytest.raises(AttributeError):
        mod._some_private_name


def test_module_getattr_sl_imported_returns_lib_namespace(monkeypatch):
    mod, fake = _load_ui(monkeypatch, imports={"sl": True})
    assert isinstance(mod.sl, mod._LibNamespace)
    assert mod.sl._prefix == "sl"
    assert mod.sl._accepts is mod._SL_ACCEPTS


def test_module_getattr_pico_imported_returns_pico_namespace(monkeypatch):
    mod, fake = _load_ui(monkeypatch, imports={"pico": True})
    assert isinstance(mod.pico, mod._PicoNamespace)


def test_module_getattr_generic_imported_returns_lib_namespace_no_accepts(monkeypatch):
    mod, fake = _load_ui(monkeypatch, imports={"acme": True})
    ns = mod.acme
    assert isinstance(ns, mod._LibNamespace)
    assert ns._prefix == "acme"
    assert ns._accepts == {}


def test_lib_function_mirrors_getattr(monkeypatch):
    mod, fake = _load_ui(monkeypatch, imports={"acme": True})
    ns = mod.lib("acme")
    assert isinstance(ns, mod._LibNamespace)
    assert ns._prefix == "acme"
    with pytest.raises(AttributeError):
        mod.lib("nope")


def test_sl_namespace_button_builds_sl_button_tag(monkeypatch):
    mod, fake = _load_ui(monkeypatch, imports={"sl": True})
    el = mod.sl.button("Klikk", variant="primary")
    create = [c for c in fake.el_calls if c[0] == "elCreate"][0]
    assert create[1] == "sl-button"
    assert create[2]["props"]["variant"] == "primary"
    assert el._openstat_tag == "sl-button"


def test_sl_namespace_snake_to_kebab_component_name(monkeypatch):
    mod, fake = _load_ui(monkeypatch, imports={"sl": True})
    mod.sl.button_group()
    create = [c for c in fake.el_calls if c[0] == "elCreate"][0]
    assert create[1] == "sl-button-group"


def test_sl_namespace_getattr_gates_even_when_import_revoked_later(monkeypatch):
    # MicroPython-avviket (se ui_mpy.py): _LibNamespace sin EGEN gate er den
    # eneste som fyrer der (ingen modul-__getattr__) — testet HER via
    # instansen direkte, uavhengig av modul-__getattr__ sin egen (tidligere)
    # gate, akkurat som mpy-fasaden faktisk fungerer.
    mod, fake = _load_ui(monkeypatch, imports={"sl": True})
    ns = mod.sl
    fake.imports["sl"] = False
    with pytest.raises(AttributeError, match=r"#tag\.import = sl"):
        ns.button


def test_sl_accepts_known_component_valid_child_no_warning(monkeypatch):
    mod, fake = _load_ui(monkeypatch, imports={"sl": True})
    warned = []
    monkeypatch.setattr(mod, "_warn", warned.append)
    option = mod.sl.option("x")
    mod.sl.select(option)
    assert warned == []


def test_sl_accepts_known_component_invalid_child_warns_but_still_appends(monkeypatch):
    mod, fake = _load_ui(monkeypatch, imports={"sl": True})
    warned = []
    monkeypatch.setattr(mod, "_warn", warned.append)
    bad_child = mod.html.div("x")   # elCreate #1 + elAppend #1 (div sin egen "x"-tekst)
    select_el = mod.sl.select(bad_child)   # elCreate #2 + elAppend #2 (el-referansen)
    assert len(warned) == 1
    assert "div" in warned[0]
    appends = [c for c in fake.el_calls if c[0] == "elAppend"]
    assert len(appends) == 2   # varsel, men IKKE blokkert — barnet ble likevel appendet
    ref_append = [c for c in appends if c[1] == select_el._openstat_el_id][0]
    assert ref_append[2] == {"el": bad_child._openstat_el_id}


def test_sl_accepts_unknown_component_no_validation_at_all(monkeypatch):
    mod, fake = _load_ui(monkeypatch, imports={"sl": True})
    warned = []
    monkeypatch.setattr(mod, "_warn", warned.append)
    mod.sl.some_unknown_widget(mod.html.div("whatever"))
    assert warned == []


def test_sl_accepts_string_child_never_warns(monkeypatch):
    mod, fake = _load_ui(monkeypatch, imports={"sl": True})
    warned = []
    monkeypatch.setattr(mod, "_warn", warned.append)
    mod.sl.select("bare tekst")
    assert warned == []


def test_generic_namespace_has_no_accepts_validation(monkeypatch):
    mod, fake = _load_ui(monkeypatch, imports={"acme": True})
    warned = []
    monkeypatch.setattr(mod, "_warn", warned.append)
    mod.acme.select(mod.html.div("x"))   # "select" betyr ingenting for et generisk navnerom
    assert warned == []
    creates = [c for c in fake.el_calls if c[0] == "elCreate"]
    assert creates[-1][1] == "acme-select"   # creates[0] er div("x") sin egen elCreate


def test_pico_button_gets_btn_class(monkeypatch):
    mod, fake = _load_ui(monkeypatch, imports={"pico": True})
    mod.pico.button("Ok")
    create = [c for c in fake.el_calls if c[0] == "elCreate"][0]
    assert create[1] == "button"
    assert create[2]["attrs"]["class"] == "btn"


def test_pico_button_utility_kwarg_adds_extra_class_not_a_dom_prop(monkeypatch):
    mod, fake = _load_ui(monkeypatch, imports={"pico": True})
    mod.pico.button("Ok", primary=True)
    create = [c for c in fake.el_calls if c[0] == "elCreate"][0]
    assert create[2]["attrs"]["class"] == "btn btn-primary"
    assert "primary" not in create[2]["props"]


def test_pico_button_extra_cls_appended_after_pico_class(monkeypatch):
    mod, fake = _load_ui(monkeypatch, imports={"pico": True})
    mod.pico.button("Ok", cls="my-extra")
    create = [c for c in fake.el_calls if c[0] == "elCreate"][0]
    assert create[2]["attrs"]["class"] == "btn my-extra"


def test_pico_unknown_component_falls_back_to_div_with_own_name_as_class(monkeypatch):
    mod, fake = _load_ui(monkeypatch, imports={"pico": True})
    mod.pico.thingamajig("x")
    create = [c for c in fake.el_calls if c[0] == "elCreate"][0]
    assert create[1] == "div"
    assert create[2]["attrs"]["class"] == "thingamajig"


def test_pico_known_non_default_html_element(monkeypatch):
    mod, fake = _load_ui(monkeypatch, imports={"pico": True})
    mod.pico.label("x")
    create = [c for c in fake.el_calls if c[0] == "elCreate"][0]
    assert create[1] == "label"
    assert create[2]["attrs"]["class"] == "form-label"


def test_pico_positional_string_child_is_a_text_node_not_special_cased(monkeypatch):
    # Dokumentert avvik fra code2web (se PICO_HTML_ELEMENTS-kommentaren i
    # pyodide/ui.py): INGEN placeholder-gjetting for input/textarea/select —
    # alle ui.<navn>-byggere (inkl. pico) bruker SAMME "streng -> tekstnode"
    # regel som ui.html (spec §1).
    mod, fake = _load_ui(monkeypatch, imports={"pico": True})
    mod.pico.input("placeholder-aktig tekst")
    texts = [c[2]["text"] for c in fake.el_calls if c[0] == "elAppend"]
    assert texts == ["placeholder-aktig tekst"]


def test_pico_namespace_getattr_gates_on_import(monkeypatch):
    mod, fake = _load_ui(monkeypatch, imports={})
    ns = mod._PicoNamespace()
    with pytest.raises(AttributeError, match=r"#tag\.import = pico"):
        ns.button


def test_element_show_returns_none(monkeypatch):
    mod, fake = _load_ui(monkeypatch)
    el = mod.html.div()
    assert el.show() is None
    assert el.show(target="slot1") is None


# ══════════════════════════════════════════════════════════════════════════
# Task 3 (dash-absorpsjon 5a): ui.play(...) + ui.kpi/ui.markdown/ui.image
# ══════════════════════════════════════════════════════════════════════════

# ---- ui.play: fallback + spec-form ----

def test_play_fallback_default_er_min(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=None)
    assert mod.play(0, 10) == 0
    assert fake.calls[-1]["min"] == 0


def test_play_fallback_bruker_gitt_value(monkeypatch):
    mod, _ = _load_ui(monkeypatch, next_result=None)
    assert mod.play(0, 10, value=4) == 4


def test_play_spec_inneholder_forventede_nokler_inkl_interval_og_loop(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=None)
    mod.play(0, 20, value=5, step=2, interval=300, loop=True, label="Tid",
              name="t", rerun="plot")
    spec = fake.calls[-1]
    assert spec["type"] == "play"
    assert spec["min"] == 0
    assert spec["max"] == 20
    assert spec["step"] == 2
    assert spec["value"] == 5
    assert spec["interval"] == 300
    assert spec["loop"] is True
    assert spec["label"] == "Tid"
    assert spec["name"] == "t"
    assert spec["rerun"] == "plot"


def test_play_default_interval_og_loop(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=None)
    mod.play(0, 10)
    spec = fake.calls[-1]
    assert spec["interval"] == 600
    assert spec["loop"] is False


def test_play_returnerer_registrert_verdi_koersert_som_slider(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result="7")
    assert mod.play(0, 10) == 7
    assert isinstance(mod.play(0, 10), int)


def test_play_on_change_alias_for_rerun(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=None)
    mod.play(0, 10, rerun="self", on_change="andre_celle")
    assert fake.calls[-1]["rerun"] == "andre_celle"


def test_play_on_change_callable_dispatch_speiler_de_andre_kontrollene(monkeypatch):
    # Samme callable-dispatch-mønster som slider/number/osv. (spec §3:
    # "callable dispatch like the other controls") — has_handler satt,
    # bindControlHandler kalt med den returnerte nøkkelen, rerun= UENDRET
    # (aldri satt til et callable-objekt).
    mod, fake = _load_ui(monkeypatch, next_result='3', next_key="pk1")
    calls = []
    mod.play(0, 10, on_change=lambda v: calls.append(v))
    spec = fake.calls[-1]
    assert spec["has_handler"] is True
    assert spec["rerun"] == "self"
    assert "pk1" in fake.bound_handlers


def test_play_sync_to_gjennomstroms(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result=None)
    mod.play(0, 10, sync_to="x.y")
    assert fake.calls[-1]["sync_to"] == "x.y"


# ---- ui.kpi/ui.markdown/ui.image: elCreate('div', {}) → elPayload → Element ----

def test_kpi_builds_via_elcreate_div_then_elpayload(monkeypatch):
    mod, fake = _load_ui(monkeypatch)
    el = mod.kpi(120, unit="kr", fmt=".0f", label="Salg")
    create_calls = [c for c in fake.el_calls if c[0] == "elCreate"]
    assert len(create_calls) == 1
    assert create_calls[0][1] == "div"
    payload_calls = [c for c in fake.el_calls if c[0] == "elPayload"]
    assert len(payload_calls) == 1
    _, el_id, payload = payload_calls[0]
    assert el_id == el._openstat_el_id == "el1"
    assert payload == {"kind": "kpi", "value": 120, "unit": "kr", "fmt": ".0f",
                        "label": "Salg", "bra": "opp"}
    assert isinstance(el, mod.Element)


def test_kpi_delta_direkte_har_forrang_over_ref(monkeypatch):
    mod, fake = _load_ui(monkeypatch)
    mod.kpi(5, delta=-3, ref=100, bra="ned")
    payload = [c for c in fake.el_calls if c[0] == "elPayload"][0][2]
    assert payload["delta"] == -3
    assert "ref" not in payload
    assert payload["bra"] == "ned"


def test_kpi_ref_uten_delta_sendes_som_ref(monkeypatch):
    mod, fake = _load_ui(monkeypatch)
    mod.kpi(120, ref=100)
    payload = [c for c in fake.el_calls if c[0] == "elPayload"][0][2]
    assert payload["ref"] == 100
    assert "delta" not in payload


def test_kpi_minimal_uten_unit_fmt_label_delta_ref(monkeypatch):
    mod, fake = _load_ui(monkeypatch)
    mod.kpi(1)
    payload = [c for c in fake.el_calls if c[0] == "elPayload"][0][2]
    assert payload == {"kind": "kpi", "value": 1, "bra": "opp"}


def test_kpi_nan_og_inf_saniteres_til_none_for_value_delta_ref(monkeypatch):
    mod, fake = _load_ui(monkeypatch)
    mod.kpi(float("nan"), delta=float("inf"))
    payload = [c for c in fake.el_calls if c[0] == "elPayload"][0][2]
    assert payload["value"] is None
    assert payload["delta"] is None

    mod.kpi(1, ref=float("-inf"))
    payload2 = [c for c in fake.el_calls if c[0] == "elPayload"][-1][2]
    assert payload2["ref"] is None


def test_markdown_builds_via_elcreate_div_then_elpayload(monkeypatch):
    mod, fake = _load_ui(monkeypatch)
    el = mod.markdown("hei **du**")
    create_calls = [c for c in fake.el_calls if c[0] == "elCreate"]
    assert create_calls[0][1] == "div"
    payload = [c for c in fake.el_calls if c[0] == "elPayload"][0][2]
    assert payload == {"kind": "markdown", "text": "hei **du**"}
    assert isinstance(el, mod.Element)


def test_markdown_coerces_non_string_to_str(monkeypatch):
    mod, fake = _load_ui(monkeypatch)
    mod.markdown(123)
    payload = [c for c in fake.el_calls if c[0] == "elPayload"][0][2]
    assert payload["text"] == "123"


def test_image_string_src_passes_through_unchanged(monkeypatch):
    mod, fake = _load_ui(monkeypatch)
    el = mod.image("https://example.com/x.png", alt="et bilde")
    create_calls = [c for c in fake.el_calls if c[0] == "elCreate"]
    assert create_calls[0][1] == "div"
    payload = [c for c in fake.el_calls if c[0] == "elPayload"][0][2]
    assert payload == {"kind": "image", "src": "https://example.com/x.png", "alt": "et bilde"}
    assert isinstance(el, mod.Element)


def test_image_string_src_uten_alt(monkeypatch):
    mod, fake = _load_ui(monkeypatch)
    mod.image("data:image/png;base64,xx")
    payload = [c for c in fake.el_calls if c[0] == "elPayload"][0][2]
    assert payload == {"kind": "image", "src": "data:image/png;base64,xx"}


class _FakeMplFigure:
    """Duck-typer en ekte matplotlib.figure.Figure akkurat nok for
    pyodide/ui.py sin _mpl_image (portert fra dash.py:175): savefig/
    set_size_inches/set_dpi. savefig skriver en kjenneligbar bytestreng
    til bufferet slik testen kan bevise base64-innholdet stemmer."""

    def __init__(self):
        self.size = None
        self.dpi = None
        self.saved_kwargs = None

    def set_size_inches(self, w, h):
        self.size = (w, h)

    def set_dpi(self, d):
        self.dpi = d

    def savefig(self, buf, format=None, bbox_inches=None):
        self.saved_kwargs = {"format": format, "bbox_inches": bbox_inches}
        buf.write(b"PNGDATA")


def _install_fake_matplotlib(monkeypatch):
    """sys.modules-injeksjon av en minimal matplotlib/matplotlib.pyplot —
    _mpl_image sin `if "matplotlib" not in sys.modules` + `import
    matplotlib.pyplot as plt` trenger begge oppføringene, uansett om ekte
    matplotlib er installert i test-miljøet eller ikke."""
    closed = []
    mpl_mod = types.ModuleType("matplotlib")
    plt_mod = types.ModuleType("matplotlib.pyplot")
    plt_mod.close = lambda fig: closed.append(fig)
    monkeypatch.setitem(sys.modules, "matplotlib", mpl_mod)
    monkeypatch.setitem(sys.modules, "matplotlib.pyplot", plt_mod)
    return closed


def test_image_matplotlib_figure_konverteres_til_png_data_uri(monkeypatch):
    closed = _install_fake_matplotlib(monkeypatch)
    mod, fake = _load_ui(monkeypatch)
    fig = _FakeMplFigure()
    el = mod.image(fig, alt="graf")
    payload = [c for c in fake.el_calls if c[0] == "elPayload"][0][2]
    assert payload["src"].startswith("data:image/png;base64,")
    import base64
    encoded = payload["src"].split(",", 1)[1]
    assert base64.b64decode(encoded) == b"PNGDATA"
    assert payload["alt"] == "graf"
    assert fig.size == (7.2, 4.4)
    assert fig.dpi == 100
    assert fig.saved_kwargs == {"format": "png", "bbox_inches": "tight"}
    assert closed == [fig]
    assert isinstance(el, mod.Element)


def test_image_matplotlib_axes_via_figure_attribute(monkeypatch):
    # df.plot()-varianten: en Axes med .figure, ikke .savefig direkte
    # (samme dispatch som dash.py:180: "fig = x if hasattr(x, 'savefig')
    # else getattr(x, 'figure', None)").
    _install_fake_matplotlib(monkeypatch)
    mod, fake = _load_ui(monkeypatch)
    fig = _FakeMplFigure()
    axes = types.SimpleNamespace(figure=fig)
    mod.image(axes)
    payload = [c for c in fake.el_calls if c[0] == "elPayload"][0][2]
    assert payload["src"].startswith("data:image/png;base64,")


def test_image_uten_matplotlib_importert_faller_tilbake_til_str(monkeypatch):
    # "matplotlib" ikke i sys.modules i det hele tatt → _mpl_image gir
    # None umiddelbart → image() faller tilbake til str(src) (aldri en
    # krasj for et objekt som verken er en streng eller en gjenkjennelig
    # matplotlib-figur).
    monkeypatch.delitem(sys.modules, "matplotlib", raising=False)
    monkeypatch.delitem(sys.modules, "matplotlib.pyplot", raising=False)
    mod, fake = _load_ui(monkeypatch)
    obj = object()
    mod.image(obj)
    payload = [c for c in fake.el_calls if c[0] == "elPayload"][0][2]
    assert payload["src"] == str(obj)


def test_kpi_markdown_image_uten_ui_returnerer_inert_element(monkeypatch):
    mod, _ = _load_ui(monkeypatch)
    monkeypatch.setattr(mod, "window", None)
    assert mod.kpi(1)._openstat_el_id is None
    assert mod.markdown("x")._openstat_el_id is None
    assert mod.image("x.png")._openstat_el_id is None


def test_fase3_core_delt_kilde(monkeypatch):
    """Fasaden re-eksporterer kjernesymbolene fra ui_core — samme objekt,
    ikke en kopi (dedup-beviset)."""
    import ui_core
    mod, _ = _load_ui(monkeypatch)
    assert mod.HTML_TAGS is ui_core.HTML_TAGS
    assert mod._snake_to_camel is ui_core._snake_to_camel
    assert mod._spec is ui_core._spec


# ══════════════════════════════════════════════════════════════════════════
# into= — kontroller kan monteres i et element/container-håndtak i stedet
# for stripa (fase 4b, spec 2026-07-21, task-2-brief.md). Task 1 (js/ui.js)
# sin utvidede registerControl-retur ({"__into": true, "value":..., "key":
# ..., "name":...}) og Ui.widgetValue konsumeres via
# _core._handle_from_into (shared/ui_core.py) - se WidgetHandle.value sin
# nøkkel-fallback-gren.
# ══════════════════════════════════════════════════════════════════════════

def test_into_sender_el_id_i_spec_og_gir_widgethandle(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result="40", widget_value_store={"k1": 70})
    host = mod.html.div()
    handle = mod.slider(0, 100, into=host)
    assert fake.calls[-1]["into"] == host._openstat_el_id
    assert isinstance(handle, mod.WidgetHandle)
    assert handle.value == 70
    assert ("widgetValue", "k1") in fake.widget_calls


def test_uten_into_retur_uendret_i_samme_kjoring(monkeypatch):
    # (b) uten into= - samme skalar-retur som før into= i det hele tatt
    # eksisterte (reuser fallback-formen fra test_slider_fallback_default_
    # er_min over) - INGEN "into"-nøkkel havner i spec-en når parameteret
    # ikke ble gitt (_spec dropper None-verdier som vanlig).
    mod, fake = _load_ui(monkeypatch, next_result=None)
    assert mod.slider(0, 100) == 0
    mod2, fake2 = _load_ui(monkeypatch, next_result="55")
    assert mod2.slider(0, 100, name="n") == 55
    assert "into" not in fake2.calls[-1]


def test_into_og_placement_begge_sendt_gjennom(monkeypatch):
    # (c) into= + placement= samtidig - fasaden preempter IKKE JS-advarselen
    # (den lever js-side, Task 1) - begge nøklene skal bare tres gjennom
    # uendret i spec-en.
    mod, fake = _load_ui(monkeypatch, next_result="10")
    host = mod.html.div()
    mod.slider(0, 100, into=host, placement="top")
    spec = fake.calls[-1]
    assert spec["into"] == host._openstat_el_id
    assert spec["placement"] == "top"


def test_into_uten_kjorekontekst_gir_handle_med_husket_default(monkeypatch):
    # (d) plain-script-fallback (registerControl -> None, ingen kjøre-
    # kontekst) MED into=: fortsatt et WidgetHandle (aldri en krasj) -
    # key=None (ingen nøkkel finnes), .value faller da tilbake til den
    # HUSKEDE spec-defaulten i stedet for et navneoppslag.
    mod, fake = _load_ui(monkeypatch, next_result=None)
    host = mod.html.div()
    handle = mod.slider(0, 100, value=42, into=host)
    assert isinstance(handle, mod.WidgetHandle)
    assert handle.value == 42


def test_into_med_ugyldig_objekt_gir_typeerror(monkeypatch):
    mod, _ = _load_ui(monkeypatch, next_result="1")
    with pytest.raises(TypeError):
        mod.slider(0, 100, into=object())


def test_into_pa_button_gir_widgethandle(monkeypatch):
    # button() sin egen kontrakt (retur alltid None UTEN into=) endres til
    # et WidgetHandle når into= er gitt (samme mønster som verdikontrollene).
    mod, fake = _load_ui(monkeypatch, next_result="null", widget_value_store={"k1": None})
    host = mod.html.div()
    handle = mod.button("Kjør", into=host)
    assert fake.calls[-1]["into"] == host._openstat_el_id
    assert isinstance(handle, mod.WidgetHandle)


def test_play_into_gir_widgethandle(monkeypatch):
    mod, fake = _load_ui(monkeypatch, next_result="3", widget_value_store={"k1": 5})
    host = mod.html.div()
    handle = mod.play(0, 10, into=host)
    assert fake.calls[-1]["into"] == host._openstat_el_id
    assert isinstance(handle, mod.WidgetHandle)
    assert handle.value == 5
