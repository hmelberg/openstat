"""ipw_setup - pyodide-bro mellom ekte ipywidgets (comm-protokollen, pakken
`comm` fra PyPI) og window.IpwBridge (js/ipywidgets-bridge.js) (spec
2026-07-15-notebook-widgets-design.md, plan 2026-07-15-notebook-widgets-w3.md,
Task 2). Isolasjonsgaranti (spec/plan): INGEN kode delt med pyodide/ui.py -
helt annet spor (ekte ipywidgets-protokoll, ikke ui.*-stripe-widgets).

Lastes lat av __ensureIpywidgets (index.html), ETTER at micropip har
installert den PINNEDE `ipywidgets==8.1.6` (+ dens lockstep-avhengighet
`comm` - se planens Global Constraints). Speiler pyodide/ui.py og
pyodide/dash.py sitt henting-og-exec-mønster (spec_from_loader), men denne
fila kjøres KUN for sin bivirkning (comm.create_comm-ombyggingen under) -
ingen brukerkode importerer `ipw_setup` selv, kun `import ipywidgets`.

To retninger over grensen, ingen ekte transportkanal (samme hovedtråd-triks
som JupyterLite sin pyodide_kernel/comm.py - se planens "Reference
implementation facts", kondensert fra ekte forskning):

  kernel -> frontend (python-siden endrer/åpner en widget, f.eks.
  `s = w.IntSlider(5)` eller `s.value = 7`): ipywidgets kaller
  `comm.create_comm(...)` (åpning, via BaseComm.__init__ -> .open()) eller
  det åpne comm-objektets `.send(...)` (endring) - vi har erstattet
  `comm.create_comm` med OpenstatComm under, hvis `publish_msg` leverer
  RETT INN på `window.IpwBridge.fromKernel(...)`.

  frontend -> kernel (brukeren drar en slider): js/ipywidgets-bridge.js sin
  comm-shim `send()` kaller `IpwBridge._toKernel` (bundet i
  __ensureIpywidgets, index.html) som til slutt kaller `_ipw_dispatch()`
  her - den ruter meldingen inn på den STOCK `comm.CommManager`-singletonen
  (`comm.get_comm_manager()`), akkurat slik en ekte Jupyter-kjerne ville
  rutet en innkommende comm_msg fra iopub-kanalen.

Msg-formen begge veier er VERIFISERT mot den installerte `comm`-pakkens
kildekode (comm==0.2.3, base_comm.py, hentet og lest 2026-07-15 - IKKE
gjettet fra minnet):
  - `BaseComm.open()` kaller
    `self.publish_msg("comm_open", data=data, metadata=metadata,
    buffers=buffers, target_name=self.target_name,
    target_module=self.target_module)` - dvs. publish_msg sin `**keys`
    fanger `target_name`/`target_module` for akkurat comm_open (send()/
    close() gir ingen ekstra keys).
  - `CommManager.comm_open/comm_msg/comm_close(stream, ident, msg)` leser
    UTELUKKENDE `msg["content"]` (aldri `stream`/`ident` - ren ZMQ-plumbing
    i en ekte kjerne, virkningsløs her) - `content["comm_id"]` alltid,
    `content["target_name"]` kun i comm_open (brukt til å slå opp en
    registrert target-callback - vi registrerer ingen, se _ipw_dispatch).

Fallback (CPython/pytest uten en ekte browser): `from js import window`
feiler med ImportError utenfor pyodide - speiler pyodide/ui.py sin
_ui()-fallback nøyaktig. `comm` (pakken) stubbes av testen selv
(tests/test_ipw_setup.py) - den er IKKE en erklært pytest-avhengighet i
dette repoet (ingen requirements.txt/pyproject.toml), og i browseren
installeres den uansett kun transitivt via micropip (ipywidgets sin
lockstep-avhengighet), aldri direkte av denne fila.
"""
import json

try:
    from js import window
except ImportError:      # CPython (pytest uten js-stub, eller ingen browser)
    window = None

import comm
from comm import BaseComm


def _bridge_from_kernel():
    """window.IpwBridge.fromKernel hvis broen er lastet, ellers None.
    None dekker BÅDE "ingen window i det hele tatt" (CPython) OG "window
    finnes, men js/ipywidgets-bridge.js har ikke satt IpwBridge/fromKernel
    ennå" (browser-race, bør aldri skje i praksis siden scripttaggen er
    statisk i index.html - men speiler ui.py sin defensive _ui()-stil)."""
    try:
        return window.IpwBridge.fromKernel
    except AttributeError:
        return None


def _buffers_to_js(buffers):
    """list[bytes] (eller None/tom) -> JS Uint8Array[] via pyodide sin
    to_js. None/tom liste -> None (ingen buffere å sende - normaltilfellet
    for stock-kontroller i v1; ekte binærdata via Output/interact er
    eksplisitt utsatt, se planens Global Constraints). CPython (ingen
    pyodide.ffi tilgjengelig) faller tilbake til en ren python-liste - kun
    en import-/teststi, aldri en ekte kjørevei (fromKernel finnes uansett
    ikke der å levere til)."""
    if not buffers:
        return None
    try:
        from pyodide.ffi import to_js
        return to_js(list(buffers))
    except ImportError:
        return list(buffers)


class OpenstatComm(BaseComm):
    """BaseComm-subklasse uten ekte iopub-kanal: publish_msg leverer
    direkte til window.IpwBridge.fromKernel på samme hovedtråd - ingen
    serialisering over en ekte sokkel (speiler JupyterLite sin
    pyodide_kernel/comm.py, se modulens docstring over)."""

    def publish_msg(self, msg_type, data=None, metadata=None, buffers=None, **keys):
        # content-formen (data/comm_id ved siden av **keys, IKKE inni data)
        # er den stock BaseComm-kontrakten - se modulens docstring for
        # verifiseringen mot comm-pakkens kildekode.
        content = dict(data=data or {}, comm_id=self.comm_id, **keys)
        deliver = _bridge_from_kernel()
        if deliver is None:
            # Ingen bro lastet (CPython/test, eller browseren rakk aldri å
            # laste js/ipywidgets-bridge.js) - meldingen droppes stille.
            # Widgeten fungerer uansett fint python-side (traitlets endres
            # likevel) - den vises/synkes bare ikke, akkurat som ui.py sin
            # _register() faller tilbake til en default uten window.Ui.
            return
        deliver(msg_type, json.dumps(content), json.dumps(metadata or {}),
                 _buffers_to_js(buffers))


# comm.create_comm ombygges GLOBALT for HELE den (persistente) pyodide-
# interpreteren (se planens Task 2-notat: sys.modules/comm.create_comm
# lever på tvers av notatbok-økter - kun selve widget-instansene/comm-ene
# er økt-scoped, ryddet av IpwBridge.reset() ved restart/dokumentbytte, se
# index.html). get_comm_manager() forblir STOCK (comm-pakkens egen
# CommManager-singleton) - vi ruter kun INN på den (_ipw_dispatch under),
# aldri erstatter den.
comm.create_comm = OpenstatComm


def _ipw_dispatch(msg_type, content_json):
    """Kalt AV JS (IpwBridge._toKernel, bundet i __ensureIpywidgets,
    index.html) for hver frontend-initiert comm-hendelse (i praksis nesten
    alltid comm_msg - brukeren endret en kontroll; comm_open/comm_close
    støttes for fullstendighets skyld men er sjeldne i v1, se
    js/ipywidgets-bridge.js sin _create_comm-kommentar).

    Ruter inn på den STOCK comm.CommManager-singletonen sine
    comm_open/comm_msg/comm_close(stream, ident, msg)-handlere - msg-formen
    ({"content": {...}}) og stream/ident=None/None er VERIFISERT mot
    comm-pakkens kildekode i modulens docstring (handlerne leser
    UTELUKKENDE msg["content"], stream/ident er ubrukt ZMQ-plumbing i en
    ekte kjerne).

    Kaster ALDRI videre til JS uhåndtert utover det comm.CommManager selv
    allerede fanger internt (comm_open/comm_msg wrapper kallet til
    target-callbacken/comm.handle_msg i try/except og logger - se
    kildekoden) - en ukjent msg_type er den eneste egen vakten her, og den
    er en stille no-op (aldri en reell protokollverdi fra en ekte
    ipywidgets-kontroll).

    "buffers": [] på toppnivå er OBLIGATORISK, ikke pynt (funnet empirisk i
    browserverifiseringen, 2026-07-15): comm.CommManager selv leser kun
    msg["content"], men ipywidgets 8.1.6 sin Widget._handle_msg (widget.py
    ~772) gjør `_put_buffers(state, data['buffer_paths'], msg['buffers'])`
    så snart data har 'buffer_paths' (og frontend-managerens update-
    meldinger har ALLTID buffer_paths, også som tom liste) - manglet
    nøkkelen, døde oppdateringen i en KeyError('buffers') som @_show_
    traceback-dekoratoren SVELGET stille (s.value forble uendret, ingen
    synlig feil). Alltid tom liste i v1: stock-kontrollenes frontend→kernel-
    meldinger bærer aldri binærbuffere (Output/interact er utsatt)."""
    content = json.loads(content_json)
    msg = {"content": content, "buffers": []}
    mgr = comm.get_comm_manager()
    if msg_type == "comm_open":
        mgr.comm_open(None, None, msg)
    elif msg_type == "comm_msg":
        mgr.comm_msg(None, None, msg)
    elif msg_type == "comm_close":
        mgr.comm_close(None, None, msg)
    # else: ukjent type fra JS - stille no-op (se docstring).
