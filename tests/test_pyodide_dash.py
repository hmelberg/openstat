"""pyodide/dash.py sin rene logikk testet i CPython: `js` og `pyodide.ffi`
stubbes, saa _infer/_payload/dashboard-flyten kan kjoeres uten browser."""
import importlib.util
import json
import pathlib
import sys
import types

import pytest


class FakeDashJs:
    def __init__(self):
        self.calls = {"create": [], "addCard": [], "updateCard": [], "addControls": []}

    def create(self, opts_json):
        self.calls["create"].append(json.loads(opts_json))
        return "dash%d" % len(self.calls["create"])

    def addCard(self, dash_id, opts_json, on_change, node):
        self.calls["addCard"].append(
            {"dash": dash_id, "opts": json.loads(opts_json),
             "on_change": on_change, "node": node})
        return "card%d" % len(self.calls["addCard"])

    def updateCard(self, cid, payload_json, node):
        self.calls["updateCard"].append(
            {"cid": cid, "payload": json.loads(payload_json), "node": node})

    def addControls(self, dash_id, specs_json, on_change):
        self.calls["addControls"].append(
            {"dash": dash_id, "specs": json.loads(specs_json),
             "on_change": on_change})

    def initialValues(self, id_):
        return "{}"

    def isAlive(self, id_):
        return True


@pytest.fixture()
def dash(monkeypatch):
    js = types.ModuleType("js")
    js.window = types.SimpleNamespace(Dash=FakeDashJs())
    monkeypatch.setitem(sys.modules, "js", js)
    path = pathlib.Path(__file__).resolve().parents[1] / "pyodide" / "dash.py"
    spec = importlib.util.spec_from_file_location("dash_under_test", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def fake(dash):
    from js import window  # stubben over
    return window.Dash


def test_number_payload_er_raa_v3(dash):
    p = dash._payload(42.5, unit="kr", fmt=",.1f", ref=40, bra="opp")
    assert p == {"kind": "number", "value": 42.5, "unit": "kr",
                 "fmt": ",.1f", "ref": 40, "bra": "opp"}


def test_number_payload_nan_ref_saniteres(dash):
    p = dash._payload(1.0, ref=float("nan"))
    assert p["ref"] is None


def test_nan_verdi_blir_tekst(dash):
    assert dash._payload(float("nan"))["kind"] == "text"


def test_infer_tuple_liste_bool(dash):
    assert dash._infer("bins", (5, 50)).kind == "slider"
    assert dash._infer("art", ["a", "b"]).kind == "dropdown"
    assert dash._infer("vis", True).kind == "checkbox"
    assert dash._infer("navn", "x").kind == "textfield"
    assert dash._infer("n", 7).kind == "numberfield"


def test_funksjonskort_foerste_render(dash):
    d = dash.dashboard("T")
    d.add(lambda bins: bins * 2, bins=(5, 50))
    calls = fake(dash).calls
    assert len(calls["addCard"]) == 1
    specs = calls["addCard"][0]["opts"]["controls"]
    assert specs[0]["type"] == "slider" and specs[0]["name"] == "bins"
    # foerste kjoering med default (min=5) -> updateCard med number 10
    up = calls["updateCard"][-1]["payload"]
    assert up["kind"] == "number" and up["value"] == 10


def test_print_fanges_naar_retur_er_none(dash):
    d = dash.dashboard("T")
    d.add(lambda n: print("hei", n), n=3)
    up = fake(dash).calls["updateCard"][-1]["payload"]
    assert up == {"kind": "text", "text": "hei 3"}


def test_exception_gir_feilkort(dash):
    d = dash.dashboard("T")
    d.add(lambda n: 1 / 0, n=3)
    up = fake(dash).calls["updateCard"][-1]["payload"]
    assert up["kind"] == "error" and "ZeroDivisionError" in up["message"]


def test_controls_rekjoerer_kort_med_navneoverlapp(dash):
    d = dash.dashboard("T")
    d.add(lambda aar: aar * 1)
    before = len(fake(dash).calls["updateCard"])
    d.controls(aar=(2020, 2026))
    calls = fake(dash).calls
    assert len(calls["addControls"]) == 1
    assert len(calls["updateCard"]) == before + 1  # kortet rekjoert med delt default
    assert calls["updateCard"][-1]["payload"]["value"] == 2020


# ---- fase B2 Task 3: _reap() -- proxy-frigjøring for DØDE dashboards ----
# FakeDashJs.isAlive over returnerer alltid True (uendret, andre tester
# stoler på det) -- disse to testene overstyrer isAlive per test for å
# gjøre _reap()'s faktiske filtrering observerbar, med en FakeProxy som
# (i motsetning til modulens egen CPython-fallback create_proxy, som bare
# returnerer callable-en uendret uten .destroy()) faktisk sporer destroy().

def test_reap_destroy_proxies_for_doede_dashboards(dash, monkeypatch):
    destroyed = []

    class FakeProxy:
        def __init__(self, f):
            self.f = f

        def destroy(self):
            destroyed.append(self.f)

    monkeypatch.setattr(dash, "create_proxy", FakeProxy)
    js_dash = fake(dash)
    alive = {}
    js_dash.isAlive = lambda id_: alive.get(id_, False)

    d1 = dash.Dash()
    alive[d1.id] = True
    d1.add(lambda n: n, n=3)  # widget-kort -> on_change registreres via _proxy
    assert len(d1._proxies) == 1

    # Simuler at d1 sin DOM-rot ble frakoblet (per-celle-purge/outputArea-
    # tømming eller D.sweepDisconnected(), se dash.test.js) -- INGEN nytt
    # dashboard er laget ennå, så _reap() har ikke kjørt igjen.
    alive[d1.id] = False
    assert destroyed == []  # ingen automatisk reaping bare fordi isAlive endret seg

    # Konstruksjon av et NYTT dashboard kjører _reap() FØR den registrerer
    # seg selv (se Dash.__init__) -- d1 er nå død, dens proxy skal destroyes.
    d2 = dash.Dash()
    alive[d2.id] = True
    assert destroyed == [d1._proxies[0].f]
    assert [entry[0] for entry in dash._live] == [d2.id]


def test_reap_lar_levende_dashboards_vaere(dash, monkeypatch):
    destroyed = []

    class FakeProxy:
        def __init__(self, f):
            self.f = f

        def destroy(self):
            destroyed.append(self.f)

    monkeypatch.setattr(dash, "create_proxy", FakeProxy)
    js_dash = fake(dash)
    alive = {}
    js_dash.isAlive = lambda id_: alive.get(id_, False)

    d1 = dash.Dash()
    alive[d1.id] = True
    d1.add(lambda n: n, n=3)
    d2 = dash.Dash()  # d1 fortsatt "alive" -> ikke reaped
    alive[d2.id] = True
    assert destroyed == []
    assert {entry[0] for entry in dash._live} == {d1.id, d2.id}
