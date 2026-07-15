"""pyodide/ipw_setup.py sin bro testet i CPython: `js` OG `comm` stubbes
(`comm` er IKKE en erklært pytest-avhengighet i dette repoet - se
ipw_setup.py sin docstring - browseren får den transitivt via micropip sin
ipywidgets-installasjon, aldri denne testen).

FakeBaseComm/FakeCommManager under er en TRO, forenklet kopi av den
installerte `comm==0.2.3`-pakkens base_comm.py (hentet og lest 2026-07-15,
IKKE gjettet fra minnet) - nok til å teste at OpenstatComm.publish_msg
bygger riktig content-form og at _ipw_dispatch ruter riktig, uten at selve
PyPI-pakken trenger å være installert i testmiljøet."""
import importlib.util
import json
import pathlib
import sys
import types
import uuid

import pytest


IPW_SETUP_PATH = pathlib.Path(__file__).resolve().parents[1] / "pyodide" / "ipw_setup.py"


# ---- comm-stub: tro (forenklet) kopi av comm==0.2.3 sin base_comm.py -------

class FakeBaseComm:
    """Speiler comm.base_comm.BaseComm.__init__/open/send/close/on_msg/
    on_close/handle_msg/handle_close nøyaktig (uten ZMQStream-typehint/
    __del__-gc-koblingen - irrelevant for denne broen)."""

    def __init__(self, target_name="comm", data=None, metadata=None,
                 buffers=None, comm_id=None, primary=True,
                 target_module=None, **kwargs):
        self.comm_id = comm_id if comm_id else uuid.uuid4().hex
        self.primary = primary
        self.target_name = target_name
        self.target_module = target_module
        self._msg_callback = None
        self._close_callback = None
        self._closed = True
        if self.primary:
            self.open(data=data, metadata=metadata, buffers=buffers)
        else:
            self._closed = False

    def open(self, data=None, metadata=None, buffers=None):
        comm.get_comm_manager().register_comm(self)
        self.publish_msg("comm_open", data=data, metadata=metadata,
                         buffers=buffers, target_name=self.target_name,
                         target_module=self.target_module)
        self._closed = False

    def send(self, data=None, metadata=None, buffers=None):
        self.publish_msg("comm_msg", data=data, metadata=metadata, buffers=buffers)

    def close(self, data=None, metadata=None, buffers=None):
        if self._closed:
            return
        self._closed = True
        self.publish_msg("comm_close", data=data, metadata=metadata, buffers=buffers)

    def on_msg(self, callback):
        self._msg_callback = callback

    def on_close(self, callback):
        self._close_callback = callback

    def handle_msg(self, msg):
        if self._msg_callback:
            self._msg_callback(msg)

    def handle_close(self, msg):
        if self._close_callback:
            self._close_callback(msg)

    def publish_msg(self, msg_type, data=None, metadata=None, buffers=None, **keys):
        raise NotImplementedError


class FakeCommManager:
    """Speiler comm.base_comm.CommManager sin register_comm/get_comm/
    comm_open/comm_msg/comm_close - `calls` legger til for assertions
    (samme rolle som FakeUiJs.calls i test_ui_module.py)."""

    def __init__(self):
        self.comms = {}
        self.targets = {}
        self.calls = []  # [(method_name, msg_dict)]

    def register_comm(self, c):
        self.comms[c.comm_id] = c
        return c.comm_id

    def unregister_comm(self, c):
        self.comms.pop(c.comm_id, None)

    def get_comm(self, comm_id):
        return self.comms.get(comm_id)

    def comm_open(self, stream, ident, msg):
        self.calls.append(("comm_open", msg))
        content = msg["content"]
        target_name = content["target_name"]
        c = comm.create_comm(comm_id=content["comm_id"], primary=False,
                             target_name=target_name)
        self.register_comm(c)

    def comm_msg(self, stream, ident, msg):
        self.calls.append(("comm_msg", msg))
        c = self.get_comm(msg["content"]["comm_id"])
        if c is not None:
            c.handle_msg(msg)

    def comm_close(self, stream, ident, msg):
        self.calls.append(("comm_close", msg))
        c = self.comms.pop(msg["content"]["comm_id"], None)
        if c is not None:
            c.handle_close(msg)


comm = None  # rebundet per test av _install_fake_comm (se under) - modulnivå
             # slik at FakeBaseComm/FakeCommManager over (definert FØR
             # fixturen kjører) kan referere til "comm" som et vanlig
             # navneoppslag i sin egen closure, akkurat som ipw_setup.py selv.


def _install_fake_comm(monkeypatch):
    global comm
    fake_mod = types.ModuleType("comm")
    fake_mod.BaseComm = FakeBaseComm
    manager = FakeCommManager()
    fake_mod.get_comm_manager = lambda: manager
    fake_mod.create_comm = FakeBaseComm  # ipw_setup.py overskriver denne selv
    monkeypatch.setitem(sys.modules, "comm", fake_mod)
    comm = fake_mod
    return fake_mod, manager


class FakeIpwBridge:
    """window.IpwBridge - fanger fromKernel-kall (speiler FakeUiJs sin
    registerControl-fangst i test_ui_module.py)."""

    def __init__(self):
        self.calls = []  # [(msg_type, content_dict, metadata_dict, buffers)]

    def fromKernel(self, msg_type, content_json, metadata_json, buffers):
        self.calls.append((msg_type, json.loads(content_json),
                           json.loads(metadata_json), buffers))


def _load_ipw(monkeypatch, with_bridge=True):
    _install_fake_comm(monkeypatch)
    js_mod = types.ModuleType("js")
    bridge = FakeIpwBridge() if with_bridge else None
    js_mod.window = types.SimpleNamespace(IpwBridge=bridge) if with_bridge \
        else types.SimpleNamespace()
    monkeypatch.setitem(sys.modules, "js", js_mod)
    spec = importlib.util.spec_from_file_location("ipw_setup_under_test", IPW_SETUP_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod, bridge


# ---- (a) import fungerer uten js (og uten comm reelt installert) ----------

def test_import_uten_js_modul(monkeypatch):
    """Simulerer ren CPython uten pyodide-stub for js: `from js import
    window` feiler med ImportError, modulen faller tilbake til
    window = None (speiler ui.py sin test_ingen_js_modul_i_det_hele_tatt).
    comm ER stubbet (se docstring: comm er ikke en reell pytest-avhengighet
    her, men modulen KAN ikke importeres uten en BaseComm å subklasse)."""
    _install_fake_comm(monkeypatch)
    monkeypatch.delitem(sys.modules, "js", raising=False)
    real_import = __import__

    def fake_import(name, *args, **kwargs):
        if name == "js":
            raise ImportError("ingen js-modul her")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", fake_import)
    spec = importlib.util.spec_from_file_location("ipw_setup_noimport", IPW_SETUP_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.window is None
    assert mod.comm.create_comm is mod.OpenstatComm


def test_comm_create_comm_ombygges(monkeypatch):
    mod, _ = _load_ipw(monkeypatch)
    assert mod.comm.create_comm is mod.OpenstatComm


# ---- (b) publish_msg content-form (kernel -> frontend) ---------------------

def test_comm_open_sender_riktig_content_og_metadata(monkeypatch):
    mod, bridge = _load_ipw(monkeypatch)
    c = mod.OpenstatComm(target_name="jupyter.widget",
                         data={"value": 5, "_model_name": "IntSliderModel"},
                         metadata={"version": "2.1.0"})
    assert len(bridge.calls) == 1
    msg_type, content, metadata, buffers = bridge.calls[0]
    assert msg_type == "comm_open"
    assert content["comm_id"] == c.comm_id
    assert content["data"] == {"value": 5, "_model_name": "IntSliderModel"}
    assert content["target_name"] == "jupyter.widget"
    assert content["target_module"] is None
    assert metadata == {"version": "2.1.0"}
    assert buffers is None


def test_send_sender_comm_msg_uten_target_keys(monkeypatch):
    mod, bridge = _load_ipw(monkeypatch)
    c = mod.OpenstatComm(target_name="jupyter.widget", data={})
    bridge.calls.clear()
    c.send(data={"method": "update", "state": {"value": 7}})
    assert len(bridge.calls) == 1
    msg_type, content, metadata, buffers = bridge.calls[0]
    assert msg_type == "comm_msg"
    assert content == {"data": {"method": "update", "state": {"value": 7}},
                       "comm_id": c.comm_id}
    assert "target_name" not in content
    assert metadata == {}


def test_close_sender_comm_close(monkeypatch):
    mod, bridge = _load_ipw(monkeypatch)
    c = mod.OpenstatComm(target_name="jupyter.widget", data={})
    bridge.calls.clear()
    c.close()
    msg_type, content, _, _ = bridge.calls[-1]
    assert msg_type == "comm_close"
    assert content["comm_id"] == c.comm_id


def test_ingen_bro_lastet_dropper_stille(monkeypatch):
    """window finnes, men IpwBridge er ikke satt ennå (browser-race) -
    publish_msg skal IKKE kaste, bare droppe meldingen (speiler ui.py sin
    _register()-fallback uten window.Ui)."""
    mod, _ = _load_ipw(monkeypatch, with_bridge=False)
    c = mod.OpenstatComm(target_name="jupyter.widget", data={"value": 1})
    assert c.comm_id  # konstruksjonen fullførte uten unntak


def test_buffers_koerseres_uten_pyodide_ffi(monkeypatch):
    """CPython (ingen pyodide.ffi.to_js tilgjengelig) faller tilbake til en
    ren python-liste - kun en teststi (fromKernel finnes uansett ikke der å
    levere ekte buffere til i en ekte kjørevei)."""
    mod, bridge = _load_ipw(monkeypatch)
    bridge.calls.clear()
    c = mod.OpenstatComm(target_name="jupyter.widget", data={},
                         buffers=[b"\x01\x02"])
    _, _, _, buffers = bridge.calls[-1]
    assert buffers == [b"\x01\x02"]


def test_tomme_buffere_blir_none(monkeypatch):
    mod, bridge = _load_ipw(monkeypatch)
    c = mod.OpenstatComm(target_name="jupyter.widget", data={}, buffers=[])
    _, _, _, buffers = bridge.calls[-1]
    assert buffers is None


# ---- (c) _ipw_dispatch (frontend -> kernel) --------------------------------

def test_dispatch_comm_msg_ruter_til_manager_og_on_msg(monkeypatch):
    mod, bridge = _load_ipw(monkeypatch)
    c = mod.OpenstatComm(target_name="jupyter.widget", data={})
    received = []
    c.on_msg(lambda msg: received.append(msg))

    content_json = json.dumps({"comm_id": c.comm_id, "data": {"value": 9}})
    mod._ipw_dispatch("comm_msg", content_json)

    # "buffers": [] på toppnivå er obligatorisk - ipywidgets sin
    # Widget._handle_msg leser msg['buffers'] så snart data har
    # 'buffer_paths' (se _ipw_dispatch sin docstring for den empirisk
    # funnede KeyError-en denne formen forhindrer).
    expected = {"content": {"comm_id": c.comm_id, "data": {"value": 9}},
                "buffers": []}
    manager = comm.get_comm_manager()
    assert manager.calls[-1] == ("comm_msg", expected)
    assert received == [expected]


def test_dispatch_comm_close_ruter_og_fjerner_comm(monkeypatch):
    mod, bridge = _load_ipw(monkeypatch)
    c = mod.OpenstatComm(target_name="jupyter.widget", data={})
    manager = comm.get_comm_manager()
    assert manager.get_comm(c.comm_id) is c

    closed = []
    c.on_close(lambda msg: closed.append(msg))
    content_json = json.dumps({"comm_id": c.comm_id, "data": {}})
    mod._ipw_dispatch("comm_close", content_json)

    assert manager.get_comm(c.comm_id) is None
    assert closed == [{"content": {"comm_id": c.comm_id, "data": {}},
                       "buffers": []}]


def test_dispatch_comm_open_ruter_til_manager(monkeypatch):
    mod, bridge = _load_ipw(monkeypatch)
    manager = comm.get_comm_manager()
    content_json = json.dumps({"comm_id": "frontend-1", "target_name": "jupyter.widget"})
    mod._ipw_dispatch("comm_open", content_json)
    assert manager.calls[-1][0] == "comm_open"
    assert manager.get_comm("frontend-1") is not None


def test_dispatch_ukjent_type_er_stille_no_op(monkeypatch):
    mod, bridge = _load_ipw(monkeypatch)
    manager = comm.get_comm_manager()
    calls_before = list(manager.calls)
    mod._ipw_dispatch("noe_ukjent", json.dumps({"comm_id": "x"}))
    assert manager.calls == calls_before


def test_dispatch_ukjent_comm_id_ruter_stille(monkeypatch):
    """comm_msg for en comm_id ingen har åpnet - manager.get_comm returnerer
    None, .handle_msg kalles aldri, ingen unntak (speiler FakeCommManager/
    den ekte comm.CommManager sin get_comm-None-vakt)."""
    mod, bridge = _load_ipw(monkeypatch)
    mod._ipw_dispatch("comm_msg", json.dumps({"comm_id": "ukjent", "data": {}}))
    manager = comm.get_comm_manager()
    assert manager.calls[-1][0] == "comm_msg"
