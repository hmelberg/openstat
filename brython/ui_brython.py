"""ui - Brython-fasade for notebook-widgets (spec 2026-07-15-notebook-widgets-design.md, W2).

Speiler pyodide/ui.py NØYAKTIG (samme offentlige API, samme fallback-
semantikk): hvert `ui.*`-kall bygger en kontrollspec og sender den over
grensen som JSON til `window.Ui.registerControl(...)` (js/ui.js). JS-siden
EIER verdien - `ui.*` returnerer den gjeldende LAGREDE verdien for
kontrollen, ikke nødvendigvis det scriptet nettopp sendte inn som `value=`.

Brython/MicroPython kjører på hovedtråden (ikke i en worker slik webR gjør),
så `registerControl` kan kalles synkront akkurat som i pyodide - se
`brython/dash.py` (`window.Dash`) for presedens på dette mønsteret.

Fase C (spec 2026-07-16): motoren HAR notatbok-cellestøtte - under
per-celle-kjøring/Kjør alle setter index.html kjørekonteksten
(Ui.beginCellRun), og registerControl registrerer/tegner kontrollen
akkurat som i pyodide-modus (samme pull-modell; hovedtråd = synkron
lesing). Utenfor en notatbok-kjørekontekst (vanlige scripts) returnerer
registerControl fortsatt null, og hvert ui.*-kall faller da tilbake til
sin dokumenterte deterministiske default (under, per funksjon).

Kritisk FFI-detalj (verifisert, se brython/duckdb_brython.py og
js/brython-engine.js): en ekte JS `null` som kommer tilbake over
Brython-grensen konverteres IKKE til Python `None` (i motsetning til f.eks.
JSON-parsing av strengen "null", som naturligvis gir Python `None`).
`_register` under bruker derfor `not raw` (ikke `raw is None`) - samme
robuste falsy-sjekk som pyodide/ui.py sin post-fix-versjon, og med samme
begrunnelse: en `raw is None`-sjekk ville bommet på Brythons null-sentinel
og json.loads ville kastet TypeError i stedet for å falle tilbake til
default.

Denne fila lastes lat av js/brython-engine.js sin LIB_REGISTRY (nøkkel
`ui_brython`, alias `ui`) - speiler mønsteret til `numpy_brython`/`numpy`
o.l.: filnavnet (og dermed registry-nøkkelen) skiller seg fra det
offentlige importnavnet, som løses via alias-mekanismen (se `dash`-
oppføringen for et eksempel UTEN alias, der nøkkel og importnavn er like)."""
from browser import window
import json


def _ui():
    """window.Ui hvis den finnes og er lastet ennå, ellers None."""
    try:
        return window.Ui
    except AttributeError:
        return None


def _register(spec):
    """Send spec til window.Ui.registerControl, JSON begge veier.
    None kommer tilbake ved: ingen window, Ui ikke lastet ennå, eller
    registerControl selv returnerer null (ingen kjørekontekst - plain
    script/ingen notatbok-støtte ennå i denne motoren). json.dumps ligger
    UTENFOR try-en med vilje: en userialiserbar verdi (f.eks. et vilkårlig
    objekt som value=) er en programmeringsfeil og skal feile HØYT med
    TypeError, ikke stille falle tilbake til default så widgeten bare
    uteblir.

    `not raw` (ikke `raw is None`) med vilje: en ekte JS `null` som kommer
    tilbake over Brython-grensen konverteres IKKE til Python `None`
    (verifisert - se brython/duckdb_brython.py og js/brython-engine.js) -
    `is None` bommer da helt. Alle ekte (ikke-fallback) svar er ikke-tomme
    JSON-strenger ("3", "false", "null" for knapp), så `not raw` treffer
    aldri en gyldig verdi."""
    ui = _ui()
    if ui is None:
        return None
    payload = json.dumps(spec)
    try:
        raw = ui.registerControl(payload)
    except Exception:
        return None
    if not raw:
        return None
    return json.loads(raw)


def _scalar(value):
    """numpy-skalar -> python int/float/bool (json.dumps tåler ikke numpy).
    Samme oppskrift som brython/dash.py sin Widget.from_raw-nabolag.
    `getattr(..., None)` i stedet for rå attributtilgang: robust mot
    søskenmotoren MicroPython sin dialektfelle der innebygde typer mangler
    `.__module__` (se micropython/ui_mpy.py sin _scalar) - koster
    ingenting her (Brython har `.__module__` på alle typer), men holder de
    to portene identiske i implementasjon, ikke bare i API."""
    if getattr(type(value), "__module__", None) == "numpy" and hasattr(value, "item") \
            and not hasattr(value, "__len__"):
        try:
            return value.item()
        except Exception:
            return value
    return value


# fase 3: injeksjonsfrie tabeller/hjelpere flyttet til shared/ui_core.py
# (dedup pyodide/brython/micropython) - _spec sin _scalar-koersjon er
# fasade-spesifikk (numpy), derfor injisert via configure(scalar=_scalar).
import ui_core as _core
_core.configure(scalar=_scalar)
HTML_TAGS = _core.HTML_TAGS
_HTML_TAG_SET = _core._HTML_TAG_SET
_SL_ACCEPTS = _core._SL_ACCEPTS
PICO_COMPONENT_CLASSES = _core.PICO_COMPONENT_CLASSES
PICO_HTML_ELEMENTS = _core.PICO_HTML_ELEMENTS
PICO_UTILITY_CLASSES = _core.PICO_UTILITY_CLASSES
_snake_to_camel = _core._snake_to_camel
_json_safe = _core._json_safe
_spec = _core._spec
_into_el_id = _core._into_el_id


def _num(value):
    """JSON-tall -> int hvis heltallig, ellers float (dokumentert
    returtype for slider/number er int|float)."""
    if value is None or isinstance(value, bool):
        return value
    f = float(value)
    return int(f) if f.is_integer() else f


def _event_payload(res, out_text):
    """Klassifiser (returverdi, stdout) -> payload-dict for
    Ui.renderEventResult (W5.2). Som pyodide/ui.py sin _event_payload,
    med ETT dokumentert avvik: to_html() kalles uten border=0 - denne
    motorens DataFrame.to_html tar ingen kwargs (browser-verifisert i
    W5-exit-gate; pyodide har ekte pandas og beholder border=0).
    (Fasadene er divergente kopier per konvensjon - builder-dedup er
    et eksisterende backlog-punkt.)"""
    out_text = (out_text or "").rstrip("\n")
    if res is not None and hasattr(res, "to_plotly_json"):
        pj = res.to_plotly_json()
        return {"kind": "figure", "spec": {"data": pj.get("data"), "layout": pj.get("layout")}}
    if res is not None and hasattr(res, "to_html") and hasattr(res, "columns"):
        return {"kind": "table", "html": res.to_html()}
    if res is None:
        return {"kind": "text", "text": out_text} if out_text else None
    text = str(res)
    if out_text:
        text = out_text + "\n" + text
    return {"kind": "text", "text": text}


def _make_event_wrapper(handler):
    """Wrapperen JS faktisk kaller: JSON-event inn, payload-JSON ut.
    Fanger stdout (sys.stdout-bytte - Brython tillater dette, samme som
    CPython/pyodide, se brython/dash.py sin _run) og ALLE unntak ->
    {"kind":"error"}. Kontrakt: handler tar ALLTID ett argument
    (event-dicten) - ingen aritetssniffing (spec-avgjørelse)."""
    def _wrapper(event_json):
        import io, sys, traceback
        buf = io.StringIO()
        old = sys.stdout
        sys.stdout = buf
        try:
            evt = json.loads(event_json) if event_json else {}
            res = handler(evt)
            p = _event_payload(res, buf.getvalue())
            return json.dumps(p) if p is not None else '{}'   # tom payload -> JS no-op
        except BaseException:
            return json.dumps({"kind": "error", "text": traceback.format_exc()})
        finally:
            sys.stdout = old
    return _wrapper


def _alias_rerun(rerun, alias):
    """W5.1 (spec 2026-07-16-notebook-widget-events): on_click=/on_change=
    er kanoniske aliaser for rerun= - aliaset vinner når begge er satt
    (dokumentert kontrakt, ingen advarselskanal i v1).

    ui-html-fasen (Task 3, spec §3, speiler pyodide/ui.py sin post-Task-2-
    versjon): en CALLABLE alias skal ALDRI havne i rerun= (en python-
    funksjon er ikke json.dumps-bar, og en kontroll med en bundet handler
    rerunner uansett aldri - se _register_value/Ui._fireControlHandler).
    rerun= beholder da sin egen verdi (default "self") uendret; selve
    callable-dispatchen skjer i _register_value."""
    if callable(alias):
        return rerun
    return alias if alias is not None else rerun


def _register_value(spec, handler):
    """_register(spec), men forstår BEGGE retur-formene fra
    Ui.registerControl (ui-html-fasen, Task 1, speilet fra pyodide/ui.py):
    den gamle skalarverdien (uendret sti - ALLTID når `handler` ikke er en
    callable), ELLER {"value": ..., "key": ...} når spec får
    has_handler=True (satt HER, kun når handler faktisk er en python-
    callable - en streng/None rerun-alias er allerede løst av _alias_rerun
    og treffer aldri denne grenen). Ved dict-formen bindes handler til den
    returnerte nøkkelen via Ui.bindControlHandler FØR verdien pakkes ut -
    alle widget-byggerne under kan dermed fortsette å behandle
    _register_value(...) sin retur nøyaktig som den gamle
    _register(...)-returen (skalar-eller-None).

    fase 4b (into=): registerControl sin objekt-form kan OGSÅ være
    into=-treffet ({"__into": true, "value":..., "key":..., "name":...},
    Task 1) - denne pakkes ALDRI ut her (trådd gjennom UKOERSERT til
    kalleren, som kjenner into= sin egen kontrakt via
    _core._handle_from_into) - kun den gamle has_handler-formen
    ({"value":..., "key":...}, uten "__into") kollapses til .get("value")
    som før. has_handler-bindingen skjer uansett (begge formene har en
    "key")."""
    if callable(handler):
        spec["has_handler"] = True
    result = _register(spec)
    if isinstance(result, dict):
        _bind_handler_if_callable(handler, result.get("key"))
        if result.get("__into"):
            return result
        return result.get("value")
    return result


def _bind_handler_if_callable(handler, key):
    """Bind `handler` (python-callable) til has_handler-kontrollen med
    controlKey `key` via Ui.bindControlHandler. Wrapperen pakker ut
    event-JSON-en Ui._fireControlHandler sender ({"value": v}) og kaller
    handler(v) - widgets sin enklere signatur `handler(value)` (spec §3),
    til forskjell fra ui.on() sin `handler(event)`. Gjenbruker
    _make_event_wrapper for stdout-fangst + feil->error-payload, akkurat
    som ui.on()/run_cell() gjør.

    INGEN create_proxy her (dialektavvik fra pyodide/ui.py, spec: "no
    create_proxy — brython/mpy functions are jsffi-callable directly"):
    samme presedens som on()/run_cell() under - en Brython-funksjon sendes
    rått over grensen."""
    if not callable(handler) or not key:
        return
    u = _ui()
    if u is None:
        return

    def _adapter(evt):
        return handler(evt.get("value") if isinstance(evt, dict) else None)

    try:
        u.bindControlHandler(key, _make_event_wrapper(_adapter))
    except Exception:
        # Samme defensive konvensjon som resten av fila: en utdatert
        # js/ui.js (uten bindControlHandler) skal degradere stille.
        pass


def slider(min=0, max=100, *, value=None, step=1, label=None, name=None, rerun='self', on_change=None, placement=None, sync_to=None, into=None):
    """Glidebryter. Fallback (ingen notatbok-støtte): value hvis gitt, ellers min.
    on_change= er kanonisk alias for rerun= (W5.1) - aliaset vinner.
    on_change= kan OGSÅ være en python-callable (ui-html-fasen, Task 3,
    spec §3): da bindes den som en handler (kontrollen rerunner ALDRI)
    i stedet for rerun-alias-stien.
    sync_to= pusher verdien inn i live-sesjonsvariabelen ved endring, uten rerun.
    into= (fase 4b): monter kontrollen i et element/container-håndtak i
    stedet for stripa - returnerer da et WidgetHandle i stedet for verdien."""
    rerun = _alias_rerun(rerun, on_change)
    into_id = _into_el_id(into)
    spec = _spec("slider", min=min, max=max, value=value, step=step,
                 label=label, name=name, rerun=rerun, placement=placement, sync_to=sync_to, into=into_id)
    result = _register_value(spec, on_change)
    if into is not None:
        default = _scalar(value) if value is not None else _scalar(min)
        return _core._handle_from_into(result, name, default)
    if result is None:
        return _scalar(value) if value is not None else _scalar(min)
    return _num(result)


def dropdown(options, *, value=None, label=None, name=None, rerun='self', on_change=None, placement=None, sync_to=None, into=None):
    """Nedtrekksmeny. Fallback: value hvis gitt, ellers første valg.
    on_change= er kanonisk alias for rerun= (W5.1) - aliaset vinner.
    on_change= kan OGSÅ være en python-callable (ui-html-fasen, Task 3,
    spec §3): da bindes den som en handler (kontrollen rerunner ALDRI)
    i stedet for rerun-alias-stien.
    sync_to= pusher verdien inn i live-sesjonsvariabelen ved endring, uten rerun.
    into= (fase 4b): monter kontrollen i et element/container-håndtak i
    stedet for stripa - returnerer da et WidgetHandle i stedet for verdien."""
    rerun = _alias_rerun(rerun, on_change)
    into_id = _into_el_id(into)
    options = list(options)
    if not options:
        raise ValueError("ui.dropdown: options kan ikke være en tom liste.")
    spec = _spec("dropdown", options=[str(o) for o in options], value=value,
                 label=label, name=name, rerun=rerun, placement=placement, sync_to=sync_to, into=into_id)
    result = _register_value(spec, on_change)
    if into is not None:
        default = str(value) if value is not None else str(options[0])
        return _core._handle_from_into(result, name, default)
    if result is None:
        return str(value) if value is not None else str(options[0])
    return str(result)


def checkbox(label=None, *, value=False, name=None, rerun='self', on_change=None, placement=None, sync_to=None, into=None):
    """Avkrysningsboks. Fallback: value.
    on_change= er kanonisk alias for rerun= (W5.1) - aliaset vinner.
    on_change= kan OGSÅ være en python-callable (ui-html-fasen, Task 3,
    spec §3): da bindes den som en handler (kontrollen rerunner ALDRI)
    i stedet for rerun-alias-stien.
    sync_to= pusher verdien inn i live-sesjonsvariabelen ved endring, uten rerun.
    into= (fase 4b): monter kontrollen i et element/container-håndtak i
    stedet for stripa - returnerer da et WidgetHandle i stedet for verdien."""
    rerun = _alias_rerun(rerun, on_change)
    into_id = _into_el_id(into)
    spec = _spec("checkbox", value=bool(value), label=label, name=name, rerun=rerun, placement=placement, sync_to=sync_to, into=into_id)
    result = _register_value(spec, on_change)
    if into is not None:
        return _core._handle_from_into(result, name, bool(value))
    if result is None:
        return bool(value)
    return bool(result)


def switch(label=None, *, value=False, name=None, rerun='self', on_change=None, placement=None, sync_to=None, into=None):
    """Bryter (samme semantikk som checkbox, annen visning). Fallback: value.
    on_change= er kanonisk alias for rerun= (W5.1) - aliaset vinner.
    on_change= kan OGSÅ være en python-callable (ui-html-fasen, Task 3,
    spec §3): da bindes den som en handler (kontrollen rerunner ALDRI)
    i stedet for rerun-alias-stien.
    sync_to= pusher verdien inn i live-sesjonsvariabelen ved endring, uten rerun.
    into= (fase 4b): monter kontrollen i et element/container-håndtak i
    stedet for stripa - returnerer da et WidgetHandle i stedet for verdien."""
    rerun = _alias_rerun(rerun, on_change)
    into_id = _into_el_id(into)
    spec = _spec("switch", value=bool(value), label=label, name=name, rerun=rerun, placement=placement, sync_to=sync_to, into=into_id)
    result = _register_value(spec, on_change)
    if into is not None:
        return _core._handle_from_into(result, name, bool(value))
    if result is None:
        return bool(value)
    return bool(result)


def number(value=0, *, min=None, max=None, step=None, label=None, name=None, rerun='self', on_change=None, placement=None, sync_to=None, into=None):
    """Tallfelt. Fallback: value.
    on_change= er kanonisk alias for rerun= (W5.1) - aliaset vinner.
    on_change= kan OGSÅ være en python-callable (ui-html-fasen, Task 3,
    spec §3): da bindes den som en handler (kontrollen rerunner ALDRI)
    i stedet for rerun-alias-stien.
    sync_to= pusher verdien inn i live-sesjonsvariabelen ved endring, uten rerun.
    into= (fase 4b): monter kontrollen i et element/container-håndtak i
    stedet for stripa - returnerer da et WidgetHandle i stedet for verdien."""
    rerun = _alias_rerun(rerun, on_change)
    into_id = _into_el_id(into)
    spec = _spec("number", value=value, min=min, max=max, step=step,
                 label=label, name=name, rerun=rerun, placement=placement, sync_to=sync_to, into=into_id)
    result = _register_value(spec, on_change)
    if into is not None:
        return _core._handle_from_into(result, name, _scalar(value))
    if result is None:
        return _scalar(value)
    return _num(result)


def text(value='', *, label=None, name=None, rerun='self', on_change=None, placement=None, sync_to=None, into=None):
    """Tekstfelt. Fallback: str(value) - returtypen er alltid str
    (speiler dash.py sin textfield(default=str(default))).
    on_change= er kanonisk alias for rerun= (W5.1) - aliaset vinner.
    on_change= kan OGSÅ være en python-callable (ui-html-fasen, Task 3,
    spec §3): da bindes den som en handler (kontrollen rerunner ALDRI)
    i stedet for rerun-alias-stien.
    sync_to= pusher verdien inn i live-sesjonsvariabelen ved endring, uten rerun.
    into= (fase 4b): monter kontrollen i et element/container-håndtak i
    stedet for stripa - returnerer da et WidgetHandle i stedet for verdien."""
    rerun = _alias_rerun(rerun, on_change)
    into_id = _into_el_id(into)
    spec = _spec("text", value=str(value), label=label, name=name, rerun=rerun, placement=placement, sync_to=sync_to, into=into_id)
    result = _register_value(spec, on_change)
    if into is not None:
        return _core._handle_from_into(result, name, str(value))
    if result is None:
        return str(value)
    return str(result)


def button(label, *, rerun='self', on_click=None, name=None, placement=None, into=None):
    """Trykknapp. Returnerer alltid None - selve klikket trigger en rerun
    av målcellen (js/ui.js), ikke en verdi å lese ut.
    on_click= er kanonisk alias for rerun= (W5.1) - aliaset vinner.
    on_click= kan OGSÅ være en python-callable (ui-html-fasen, Task 3,
    spec §3): da bindes den som en handler (klikket rerunner ALDRI) i
    stedet for rerun-alias-stien; handleren mottar alltid None (knapper
    har ingen lagret verdi) - (derfor kan heller ikke ui.widget()
    adressere knapper).
    into= (fase 4b): monter knappen i et element/container-håndtak i
    stedet for stripa - returnerer da et WidgetHandle i stedet for None."""
    rerun = _alias_rerun(rerun, on_click)
    into_id = _into_el_id(into)
    spec = _spec("button", label=label, name=name, rerun=rerun, placement=placement, into=into_id)
    result = _register_value(spec, on_click)
    if into is not None:
        return _core._handle_from_into(result, name, None)
    return None


# fase 3 (Task 3): run_button/play er byte-identiske på tvers av fasadene
# - flyttet til shared/ui_core.py. Rebindes her (etter at button/_num/
# _alias_rerun/_register_value er definert lenger nede/over) - selve
# configure()-kallet som injiserer dialektsymbolene ligger samlet et
# stykke ned i fila (se kommentaren der), ETTER at ALLE navnene disse (og
# resten av Task 3-settet) refererer til faktisk finnes i denne fila.
run_button = _core.run_button
play = _core.play


def on(selector, event, handler, *, target=None):
    """Bind en python-funksjon til en HTML-event på et vilkårlig
    DOM-element (typisk i en #%% html-celle). handler(evt) kalles med
    event-dicten; returverdien rendres (tekst -> <pre>, DataFrame ->
    tabell, plotly-figur -> graf) i target-id-en, eller appendes i
    cellens output-slot når target utelates. Utenfor nettleser: no-op.

    INGEN create_proxy her (i motsetning til pyodide/ui.py): Brython-
    funksjoner er JS-kallbare direkte over grensen - samme presedens som
    brython/dash.py sin controls()/_add_func() (on_change sendes rått til
    window.Dash.addControls/addCard, se ~L268)."""
    u = _ui()
    if u is None:
        return None
    binding = {"selector": str(selector), "event": str(event)}
    if target is not None:
        binding["target"] = str(target)
    try:
        u.bindEvent(json.dumps(binding), _make_event_wrapper(handler))
    except Exception:
        # Samme defensive konvensjon som _register: en utdatert js/ui.js
        # (uten bindEvent) skal degradere stille til no-op, ikke kaste.
        return None
    return None


# fase 3 (Task 3): run_cell flyttet til shared/ui_core.py (byte-identisk).
run_cell = _core.run_cell


def _is_js_null(raw):
    """True hvis `raw` er Brythons interne representasjon av en EKTE JS
    `null` lest RÅTT over grensen (ikke via JSON, se value() sin docstring
    under) - dialektavvik fra pyodide/ui.py, som importerer et offentlig
    `pyodide.ffi.JsNull` for akkurat dette. Brython har ingen tilsvarende
    offentlig sentinel-klasse å importere, så denne fila gjør et
    NAVNE-basert duck-type-oppslag i stedet (browser-verifisert
    2026-07-17, Task 3-browserverifisering): en RÅ JS `null` blir en
    instans av Brythons interne `javascript.NullType`
    (type(x).__name__=='NullType', type(x).__module__=='javascript') -
    IKKE Python `None` (x is None -> False), og IKKE json.loads("null")
    sin Python None heller (den konverteringen skjer alltid riktig, dette
    gjelder KUN rå (ikke-JSON) verdier som krysser grensen direkte, som
    Ui.value() sin retur er).

    ADVARSEL: kall ALDRI repr()/str() på en slik verdi - Brythons
    NullType-introspeksjon kaster en JavascriptError ("Cannot read
    properties of null") for begge (browser-verifisert). Denne funksjonen
    kaller derfor KUN type(raw).__name__, aldri noe som rører selve
    verdien."""
    return type(raw).__name__ == "NullType"


def value(name):
    """ui.value(name) (spec §3) - gjeldende LAGREDE verdi for kontrollen
    `name`, hvor som helst i dokumentet, UTEN å kjøre noe (rent synkront
    oppslag i js/ui.js sitt verdilager via Ui.value - se der for
    "siste registrerte vinner ved duplikate navn"-regelen + console.warn).

    None ved: ingen window/Ui (ikke i nettleser/ikke lastet ennå), ukjent
    navn, ELLER en ekte JS `null` (Ui.value returnerer JS `null` for et
    ukjent navn - denne krysser IKKE grensen som Python None i Brython,
    se _is_js_null over). Merk at Ui.value returnerer den RÅ verdien
    direkte (ikke en JSON-streng slik registerControl gjør) - ingen
    json.loads her."""
    u = _ui()
    if u is None:
        return None
    try:
        raw = u.value(str(name))
    except Exception:
        return None
    if raw is None or _is_js_null(raw):
        return None
    return raw


# Brython-felle (verifisert, se matplotlib_brython.py + test_brython_
# scoping_trap.py): en METODE som refererer en global funksjon med SAMME
# navn som METODEN blir stille en no-op i Brython. WidgetHandle.value
# (under) kaller derfor denne ikke-kolliderende aliasen i stedet for
# value(...) direkte.
_value = value


# ══════════════════════════════════════════════════════════════════════════
# ui.widget("navn") - håndtak til en ALLEREDE DEKLARERT kontroll
# (dash-absorpsjon 5a Task 2, speiler pyodide/ui.py BYTE FOR BYTE - se der
# for den fulle arkitektur-kommentaren. Eneste dialektavvik: INGEN
# create_proxy (Brython-funksjoner er JS-kallbare direkte over grensen, som
# resten av denne fila allerede gjør for on()/run_cell()/
# _bind_handler_if_callable).
# ══════════════════════════════════════════════════════════════════════════

class WidgetHandle:
    """ui.widget("navn") sitt håndtak. Holder (_name, _key): _key er
    controlKey-en Ui.widgetLookup fant VED KONSTRUKSJON (ui.widget(...)
    slår opp NÅ, ikke lat) - .set()/.on()/.hide()/.show()/.element/.input
    adresserer DEN NØKKELEN direkte (js/ui.js sitt _controls-register), mens
    .value fortsatt går via navnet (samme livsløp/robusthet som
    ui.value(navn) - en re-registrering med samme navn kan bytte
    UNDERLIGGENDE nøkkel, .value følger da alltid GJELDENDE kontroll)."""

    def __init__(self, name, key):
        self._name = name
        self._key = key

    @property
    def value(self):
        """Live oppslag - SAMME som ui.value(self._name) (navnet, ikke den
        FROSSEDE nøkkelen - .value skal alltid følge GJELDENDE kontroll
        under dette navnet, ikke en potensielt utdatert identitet). Kaller
        _value (Brython-felle-aliaset over), ikke value(...) direkte.

        fase 4b (into=): navnløse håndtak (self._name er None - bygget av
        _core._handle_from_into for en into=-kontroll uten name=) har
        INTET navn å slå opp via - faller da tilbake til nøkkelen i
        stedet: ingen nøkkel heller (no-context-fallback, into= ba om
        montering men det finnes ingen kjørekontekst) -> den HUSKEDE
        default-verdien (_fallback_value, satt av _handle_from_into);
        ellers Ui.widgetValue(key) (JSON-dekodet, samme falsy/JsNull-
        disiplin som _register - "not raw" fanger både None og en ekte
        JS `null`)."""
        if self._name is not None:
            return _value(self._name)
        if self._key is None:
            return getattr(self, '_fallback_value', None)
        u = _ui()
        if u is None:
            return None
        try:
            raw = u.widgetValue(self._key)
        except Exception:
            return None
        if not raw:
            return None
        return json.loads(raw)

    def set(self, v):
        """Skriv en ny verdi til kontrollen (verdilager + DOM + sync_to,
        Ui.widgetSet) - fyrer ALDRI on_change/rerun (se modulens
        toppkommentar over). Returnerer den FAKTISK skrevne (koersert/
        klampede) verdien, eller None ved manglende bro/ukjent nøkkel."""
        u = _ui()
        if u is None:
            return None
        try:
            raw = u.widgetSet(self._key, json.dumps(v))
        except Exception:
            return None
        if not raw:
            return None
        return json.loads(raw)

    def on(self, event, handler):
        """Bind en EKSTRA python-callable til en DOM-event på kontrollens
        input-node (Ui.widgetBind) - VED SIDEN AV en ev. on_change=/on_click=
        gitt VED DEKLARASJONEN (egen kanal/nøkkel - forstyrrer ikke
        has_handler-kanalen _fireControlHandler bruker). handler mottar
        HELE event-dicten (som Element.on), IKKE bare verdien - til
        forskjell fra on_change= sin enklere handler(value)-signatur (se
        _bind_handler_if_callable).

        INGEN create_proxy her (dialektavvik fra pyodide/ui.py) - Brython-
        funksjoner er JS-kallbare direkte over grensen."""
        u = _ui()
        if u is not None:
            try:
                u.widgetBind(self._key, str(event), _make_event_wrapper(handler))
            except Exception:
                pass
        return self

    def hide(self):
        """Skjul kontrollen (Ui.widgetVisible(key, False) - display:none
        på .ui-widget-wrap)."""
        u = _ui()
        if u is not None:
            try:
                u.widgetVisible(self._key, False)
            except Exception:
                pass
        return self

    def show(self):
        """Vis kontrollen igjen (Ui.widgetVisible(key, True))."""
        u = _ui()
        if u is not None:
            try:
                u.widgetVisible(self._key, True)
            except Exception:
                pass
        return self

    @property
    def element(self):
        """Eskapeluke: kontrollens wrap-node (Ui.widgetNode(key,'wrap')) -
        samme "aldri sendt over JSON-broen selv"-kontrakt som Element.el."""
        u = _ui()
        if u is None:
            return None
        try:
            return u.widgetNode(self._key, 'wrap')
        except Exception:
            return None

    @property
    def input(self):
        """Eskapeluke: kontrollens RÅ input-node (Ui.widgetNode(key,
        'input'))."""
        u = _ui()
        if u is None:
            return None
        try:
            return u.widgetNode(self._key, 'input')
        except Exception:
            return None


# fase 3 (Task 3): widget flyttet til shared/ui_core.py (byte-identisk).
widget = _core.widget


# ══════════════════════════════════════════════════════════════════════════
# ui.html - element-byggere (ui-html-fasen, Task 3, speiler pyodide/ui.py
# sin Task 2-seksjon BYTE FOR BYTE - se der for den fulle arkitektur-
# kommentaren. Eneste dialektavvik: INGEN create_proxy noe sted (Brython-
# funksjoner er JS-kallbare direkte over grensen, som resten av denne
# fila allerede gjør for on()/run_cell()/_bind_handler_if_callable).
# ══════════════════════════════════════════════════════════════════════════

# fase 3 (Task 3): _warn flyttet til shared/ui_core.py (byte-identisk;
# kjernens kopi refererer `_window` i stedet for bare `window` - injisert
# under, se configure()-kallet).
_warn = _core._warn


def _warn_sink(msg):
    """BRO, ALDRI flyttet (Task 3) - widget()/_append_children()/
    _tag_builder() er nå flyttet til shared/ui_core.py og kaller
    `_warn_sink(...)`, ikke bare `_warn(...)`: et bart `_warn(...)`-kall
    INNI dem ville løst seg mot ui_core.py sin EGEN `_warn`-global (siden
    de nå er DEFINERT der), og ville derfor ALDRI se en test sin
    `monkeypatch.setattr(mod, "_warn", ...)` (som bare ombinder DENNE
    fasadens `_warn`-navn). Denne funksjonen blir i fasaden nettopp for at
    kallet `_warn(msg)` under er et FRISKT oppslag i FASADENS EGET
    navnerom hver gang - samme trick som `_ui()` alt brukte for
    `window`-monkeypatching."""
    _warn(msg)


def _normalize_kwargs(kwargs):
    """PUR (ingen side-effekter, ingen broen) - den tungt testede kjernen
    av den "unified kwargs standard"-en spec §1 definerer. Returnerer
    (propsdict, handlers, warnings) - se pyodide/ui.py sin fulle docstring
    (identisk regelsett, speilet her byte for byte):

    - propsdict: {"props": {...}, "attrs": {...}} (+ "style" hvis gitt).
    - handlers: [(event, callable), ...] samlet fra on_<event>=callable.
    - warnings: menneskelesbare advarsel-strenger - PUR, ingen
      console.warn-kall her; kalleren emitter dem via _warn().

    To presedens-punkter (identisk med pyodide/ui.py, se der for det
    fulle regelsettet): cls=/class_= - BEGGE aksepteres; angis begge
    samtidig vinner den siste i kall-rekkefølgen + advarsel. Ved samme
    attributt-navn fra data_x=/aria_x= og attrs={} vinner den som kommer
    SIST i kall-rekkefølgen (attrs merges på sin plass) - udefinert var
    det aldri, men nå er det dokumentert."""
    props = {}
    attrs = {}
    style = None
    handlers = []
    warnings = []
    class_key_seen = None
    for key, raw_value in kwargs.items():
        if key in ("cls", "class_"):
            if class_key_seen is not None:
                warnings.append(
                    "ui.html: bade cls= og class_= angitt - siste vinner (her: " + key + "=)"
                )
            class_key_seen = key
            attrs["class"] = raw_value
            continue
        if key == "style":
            if isinstance(raw_value, dict):
                style = {_snake_to_camel(k): v for k, v in raw_value.items()}
            else:
                style = raw_value
            continue
        if key == "attrs":
            if not isinstance(raw_value, dict):
                raise TypeError(
                    "ui.html: attrs= må være en dict, fikk " + type(raw_value).__name__)
            attrs.update(raw_value)
            continue
        if key.startswith("data_") or key.startswith("aria_"):
            attrs[key.replace("_", "-")] = raw_value
            continue
        if key.startswith("on_") and len(key) > 3:
            event = key[3:]
            if callable(raw_value):
                handlers.append((event, raw_value))
            else:
                warnings.append(
                    'ui.html: on_' + event + '= forventer en callable (fikk '
                    + type(raw_value).__name__ + ') - IGNORERT, ikke eksekvert')
            continue
        # bool passthrough + "alt annet": samme gren med vilje (spec §1) -
        # python normaliserer kun navnet, JS avgjør property/attributt-
        # anvendelsen (inkl. bool->tom-attributt) for BEGGE.
        if callable(raw_value):
            warnings.append(
                'ui.html: "' + key + '" er en callable men mangler on_-'
                'prefiks - ignorert (mente du on_' + key + '=?)')
            continue
        if not _json_safe(raw_value):
            warnings.append(
                'ui.html: "' + key + '" har en verdi av type '
                + type(raw_value).__name__ + ' som ikke er JSON-vennlig - '
                'konvertert med str()')
            raw_value = str(raw_value)
        props[_snake_to_camel(key)] = raw_value
    result = {"props": props, "attrs": attrs}
    if style is not None:
        result["style"] = style
    return result, handlers, warnings


# fase 3 (Task 3): _append_children flyttet til shared/ui_core.py (byte-
# identisk; kjernens kopi refererer `_element_cls` i stedet for bare
# `Element` - injisert under, se configure()-kallet).
_append_children = _core._append_children


class Element:
    """Python-håndtak for en JS-eid DOM-node (ui-html-fasen, Task 3,
    speiler pyodide/ui.py sin Element byte for byte). Holder KUN elId (en
    streng) - selve noden lever og eies JS-side (js/ui.js sitt
    _els-register, Task 1). `_openstat_el_id` er duck-type-kontrakten
    brython_runner.py sin `_fmt` display-krok bruker (spec §2) til å
    avgjøre "dette er et monterbart element, ikke en vanlig verdi å
    repr-printe"."""

    def __init__(self, el_id, tag=None):
        self._openstat_el_id = el_id
        # Python-sidens speil av class-settet - add_class/remove_class
        # (under) må kjenne HELE det gjeldende settet for å kunne sende
        # en fullstendig erstatnings-streng til elSetProps (JS eier ikke
        # et strukturert class-sett, bare selve attributt-STRENGEN).
        self._classes = set()
        # ui-html-fasen (Task 4, speiler pyodide/ui.py byte for byte) -
        # elementets EGEN tag, KUN til _validate_accepts-whitelisten under.
        self._openstat_tag = tag

    def add(self, *children):
        """Legg til flere barn (samme regler som konstruktørens
        *children - str/Element/liste-ett-nivå/None, spec §1)."""
        _append_children(self._openstat_el_id, children)
        return self

    def clear(self):
        """Tøm elementet (Ui.elClear) - fjerner alle barn, rører ikke
        elementets egen plass i SIN forelder."""
        u = _ui()
        if u is not None and self._openstat_el_id is not None:
            try:
                u.elClear(self._openstat_el_id)
            except Exception:
                pass
        return self

    def on(self, event, handler):
        """Bind en python-callable til en DOM-event på DETTE elementet
        (Ui.elOn) - samme wrapper-konvensjon (stdout-fangst, feil->error-
        payload) som ui.on()/run_cell() bruker for HTML-celle-events.

        INGEN create_proxy her (dialektavvik fra pyodide/ui.py) - Brython-
        funksjoner er JS-kallbare direkte."""
        u = _ui()
        if u is not None and self._openstat_el_id is not None:
            try:
                u.elOn(self._openstat_el_id, str(event), _make_event_wrapper(handler))
            except Exception:
                pass
        return self

    def set_style(self, **styles):
        """Sett CSS-stiler (snake_case->camelCase, spec §1 - SAMME regel
        som style=-kwarget ved konstruksjon)."""
        style = {_snake_to_camel(k): v for k, v in styles.items()}
        u = _ui()
        if u is not None and self._openstat_el_id is not None:
            try:
                u.elSetProps(self._openstat_el_id, json.dumps({"style": style}))
            except Exception:
                pass
        return self

    def add_class(self, *names):
        """Legg til CSS-klasser (python-side class-SETT -> én
        elSetProps(attrs={"class": "..."})-samlekall, ikke én per
        navn)."""
        self._classes.update(str(n) for n in names)
        self._push_classes()
        return self

    def remove_class(self, *names):
        """Fjern CSS-klasser (samme samlekall-mønster som add_class)."""
        self._classes.difference_update(str(n) for n in names)
        self._push_classes()
        return self

    def _push_classes(self):
        u = _ui()
        if u is not None and self._openstat_el_id is not None:
            try:
                u.elSetProps(self._openstat_el_id,
                              json.dumps({"attrs": {"class": " ".join(sorted(self._classes))}}))
            except Exception:
                pass

    def show(self, target=None):
        """Monter elementet (Ui.elShow, spec §2). target=None: append i
        DEN KJØRENDE cellens output-slot nå (kan kalles flere ganger per
        celle). target="dom-id": erstatt-inn-i-target, med W5-registerets
        replace-ved-rerun-semantikk (js/ui.js sin _elShowTargets).

        Returnerer None med vilje — siste-uttrykk-display skal ikke
        re-montere; kjedebruk av .show() er ikke støttet."""
        u = _ui()
        if u is not None and self._openstat_el_id is not None:
            opts = {"target": str(target) if target is not None else None}
            try:
                u.elShow(self._openstat_el_id, json.dumps(opts))
            except Exception:
                pass
        return None

    @property
    def el(self):
        """Eskapeluke: den rå JS DOM-noden (Ui.elNode) - for tilfeller
        denne wrapperen ikke (ennå) dekker."""
        u = _ui()
        if u is None or self._openstat_el_id is None:
            return None
        try:
            return u.elNode(self._openstat_el_id)
        except Exception:
            return None


# ══════════════════════════════════════════════════════════════════════════
# ui.kpi/ui.markdown/ui.image - Element-byggere for det delte payload-
# vokabularet (dash-absorpsjon 5a Task 3, spec §2). Speiler pyodide/ui.py
# sitt API NØYAKTIG. Ui.renderPayload (js/ui.js, Task 1) er ÉN rendrings-
# implementasjon delt mellom event-resultater (ui.on()-handlere sin
# returverdi) OG disse byggerne. Mekanikken: elCreate('div', {}) → en tom
# vert-node, elPayload(elId, payload) → Ui.renderPayload sitt resultat
# rendret INN i den (clear-then-render), Element(elId) → det vanlige
# ui.html-håndtaket.
# ══════════════════════════════════════════════════════════════════════════

def _payload_element(payload):
    """Felles kjerne for ui.kpi/ui.markdown/ui.image: en tom vert-div
    (Ui.elCreate) med `payload` rendret INN i den (Ui.elPayload, Task 3).
    Ingen window/Ui (ikke i nettleser/ikke lastet ennå) → et Element med
    el_id=None (samme "eskapelukene blir None"-fallback som resten av
    ui-html-fasen)."""
    u = _ui()
    el_id = None
    if u is not None:
        try:
            el_id = u.elCreate('div', json.dumps({}))
        except Exception:
            el_id = None
        if el_id is not None:
            try:
                u.elPayload(el_id, json.dumps(payload))
            except Exception:
                pass
    return Element(el_id)


def _clean_num(v):
    """_scalar(v), MEN NaN/±Infinity → None (samme regel som brython/dash.py
    sin _number_payload: json.dumps av NaN/Infinity gir literal NaN/
    Infinity-tokens som knekker JSON.parse i JS - ui.kpi sine value=/
    delta=/ref= er alle DIREKTE brukerverdier, ikke forhånds-sjekket av
    noen add()-dispatch slik dash sin _payload() gjorde det)."""
    v = _scalar(v)
    if isinstance(v, float) and (v != v or abs(v) == float("inf")):
        return None
    return v


# fase 3 (Task 3): kpi/markdown/_tag_builder (under, etter _figure_spec/
# image) er byte-identiske - flyttet til shared/ui_core.py. Alle
# dialektsymbolene Task 3-settet (kpi/markdown/_tag_builder OG de
# tidligere flyttede _warn/_append_children/run_button/play/run_cell/
# widget over) refererer, er nå definert i DENNE fila (button, WidgetHandle,
# _normalize_kwargs, Element, _payload_element, _clean_num - alle over;
# _num/_alias_rerun/_register_value/_ui/_scalar/window også over) - DETTE
# er derfor det tryggeste stedet i fila for det ETT konsoliderte
# configure()-kallet som injiserer dem (configure() er additiv, se
# shared/ui_core.py: rører ikke scalar= satt av det tidligere kallet).
_core.configure(
    register_value=_register_value, ui=_ui, alias_rerun=_alias_rerun,
    num=_num, normalize_kwargs=_normalize_kwargs, element_cls=Element,
    clean_num=_clean_num, payload_element=_payload_element,
    window=window, button=button, widget_handle_cls=WidgetHandle,
    warn_sink=_warn_sink,
)
kpi = _core.kpi
markdown = _core.markdown


def _figure_spec(x):
    """Duck-typet plotly-figur-gjenkjenning - PORTERT ORDRETT fra
    brython/dash.py sin _figure_spec (samme presedens/rekkefølge, se der
    for hvorfor to_plotly_json_str() sjekkes FØRST:
    plotly_express_brython.PlotlyFigure - matplotlib-shimmen
    (matplotlib_brython) bygger PÅ denne - har VERKEN to_plotly_json() NOR
    to_dict(), bare to_plotly_json_str())."""
    if hasattr(x, "to_plotly_json_str"):
        try:
            d = json.loads(x.to_plotly_json_str())
            if isinstance(d, dict) and "data" in d:
                return d
        except Exception:
            pass
    for m in ("to_plotly_json", "to_dict"):
        if hasattr(x, m):
            try:
                d = getattr(x, m)()
                if isinstance(d, dict) and "data" in d and "layout" in d:
                    return d
            except Exception:
                pass
    if isinstance(x, dict) and "data" in x and "layout" in x:
        return x
    if hasattr(x, "data") and hasattr(x, "layout") and not hasattr(x, "to_html"):
        try:
            return {"data": list(x.data), "layout": dict(x.layout)}
        except Exception:
            pass
    return None


def image(src, alt=None):
    """ui.image(src, alt=None) -> Element (<img class="ui-img">, ELLER en
    native <div class="ui-figure">-plotly-graf - se under). `src`
    aksepterer ENTEN en streng (URL eller data-URI, sendt uendret) ELLER en
    matplotlib-figur.

    DIALEKTAVVIK fra pyodide/ui.py sin _mpl_image (PNG-data-URI via ekte
    matplotlib.savefig): denne motoren har INGEN ekte matplotlib -
    "matplotlib" er en shim (matplotlib_brython) som bygger PÅ
    plotly_express_brython.PlotlyFigure og aldri rasteriserer noe
    (savefig() render bare figuren, skriver ikke en fil/buffer) - PORTERT
    fra brython/dash.py sin egen håndtering: en slik figur duck-typet via
    _figure_spec (over, samme funksjon dash.py bruker) rendres i stedet
    NATIVT som en plotly-figur (kind "figure"), ikke en PNG-data-URI (kind
    "image") - samme underliggende Ui.elPayload-rendringshus, bare en
    annen payload-kind. `alt` brukes ikke i figur-grenen (ingen alt-tekst-
    konsept for plotly-figurer i vokabularet). En ikke-streng som IKKE er
    en gjenkjennelig figur faller tilbake til str(src) (aldri en krasj)."""
    if isinstance(src, str):
        payload = {"kind": "image", "src": src}
        if alt is not None:
            payload["alt"] = str(alt)
        return _payload_element(payload)
    fig = _figure_spec(src)
    if fig is not None:
        return _payload_element({"kind": "figure", "spec": fig})
    return _payload_element({"kind": "image", "src": str(src)})


# fase 3 (Task 3): _tag_builder flyttet til shared/ui_core.py (byte-
# identisk; kjernens kopi refererer `_element_cls` i stedet for bare
# `Element`, injisert av configure()-kallet over).
_tag_builder = _core._tag_builder


class _HtmlNamespace:
    """`ui.html` - namespace-objektet spec §1 beskriver. `__getattr__`
    over HTML_TAGS -> en fersk tag-bygger PER OPPSLAG (billig, ingen
    cache nødvendig - selve elementet opprettes først ved KALL, ikke ved
    attributt-oppslag). Ukjent tag -> AttributeError som navngir
    HTML_TAGS-kilden (spec: "unknown attribute -> clear AttributeError
    listing the tag list source")."""

    def __getattr__(self, tag):
        if tag.startswith("_") or tag not in _HTML_TAG_SET:
            raise AttributeError(
                'ui.html: ukjent tag "' + tag + '" - gyldige tagger er '
                'HTML_TAGS-listen i brython/ui_brython.py (speiler '
                'pyodide/ui.py, som er kopiert fra '
                'code2web/ui.py:4481-4495): ' + HTML_TAGS.strip())
        return _tag_builder(tag)


html = _HtmlNamespace()


# ══════════════════════════════════════════════════════════════════════════
# #tag.import — kuratert register + dynamiske navnerom (ui-html-fasen,
# Task 4). Speiler pyodide/ui.py sin tilsvarende seksjon BYTE FOR BYTE
# (samme klasser/dicter/feilmeldinger) — se der for den fulle
# arkitektur-kommentaren. Dialektnote: Brython har EKTE modul-objekter
# (types.ModuleType, se brython_runner.py sin _register_module) og
# implementerer PEP 562 modul-__getattr__ som en generell Python 3.7+-
# språkfunksjon — samme mønster som pyodide fungerer derfor uendret her
# (verifisert i browser, se task-4-rapporten). MicroPython-avviket (INGEN
# modul-__getattr__ der) er dokumentert i ui_mpy.py sin egen header-
# kommentar, ikke her.
# ══════════════════════════════════════════════════════════════════════════

def _has_import(ns):
    """Ui.hasImport(ns) over broen - se js/ui.js sin docstring."""
    u = _ui()
    if u is None:
        return False
    try:
        return bool(u.hasImport(str(ns)))
    except Exception:
        return False


def _not_imported_error(navn):
    return AttributeError(
        'ui.' + str(navn) + ': ikke importert - legg til "#tag.import = '
        + str(navn) + '" (eller for et generisk bibliotek: "#tag.import = '
        '<url> as ' + str(navn) + '") i preambelen')


def _validate_accepts(prefix, name, accepted, children):
    """`accepts`-barn-whitelist-validering (spec §4, portert fra
    code2web/ui.py:3320-3380) - varsler (ALDRI blokkerer) når et
    Element-barn av en KJENT komponent har en tag utenfor den kuraterte
    lista. `accepted` tom/None -> ingen validering (ukjent komponent)."""
    if not accepted:
        return
    flat = []
    for child in children:
        if isinstance(child, (list, tuple)):
            flat.extend(child)
        else:
            flat.append(child)
    for child in flat:
        child_tag = getattr(child, "_openstat_tag", None)
        if child_tag is not None and child_tag not in accepted:
            _warn(
                'ui.' + prefix + '.' + name + ': "' + child_tag + '" er '
                'kanskje ikke en gyldig barn-tag her (forventet en av: '
                + ", ".join(accepted) + ")")


def _lib_tag_builder(tag, prefix=None, name=None, accepted=None):
    """Som _tag_builder (ui.html), men for et #tag.import-lastet biblioteks
    egen tag + valgfri accepts-validering FØR barna appendes."""
    def _build(*children, **kwargs):
        norm, handlers, warnings = _normalize_kwargs(kwargs)
        for w in warnings:
            _warn(w)
        if children and accepted:
            _validate_accepts(prefix, name, accepted, children)
        u = _ui()
        el_id = None
        if u is not None:
            try:
                el_id = u.elCreate(tag, json.dumps(norm))
            except Exception:
                el_id = None
        el = Element(el_id, tag=tag)
        cls_attr = norm.get("attrs", {}).get("class")
        if cls_attr:
            el._classes.update(str(cls_attr).split())
        if children:
            el.add(*children)
        for event, handler in handlers:
            el.on(event, handler)
        return el
    return _build


class _LibNamespace:
    """`ui.<navn>` for et #tag.import-lastet bibliotek (spec §4).
    Gate HER (i tillegg til modul-__getattr__ sin gate under) med vilje -
    samme instans-klasse gjenbrukes uendret av ui_mpy.py, der DENNE gaten
    er den ENESTE som fyrer (ingen modul-__getattr__ der)."""

    def __init__(self, prefix, accepts=None):
        self._prefix = prefix
        self._accepts = accepts or {}

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        if not _has_import(self._prefix):
            raise _not_imported_error(self._prefix)
        kebab = name.replace("_", "-")
        tag = self._prefix + "-" + kebab
        return _lib_tag_builder(tag, prefix=self._prefix, name=name,
                                 accepted=self._accepts.get(kebab))


def _pico_component(name):
    """component_name -> f(*children, **kwargs) -> Element - se pyodide/
    ui.py for den fulle docstringen."""
    html_tag = name if name in PICO_HTML_ELEMENTS else "div"
    pico_class = PICO_COMPONENT_CLASSES.get(name, name)

    def _build(*children, **kwargs):
        classes = [pico_class]
        for key in list(kwargs.keys()):
            if key in PICO_UTILITY_CLASSES:
                classes.append(PICO_UTILITY_CLASSES[key])
                del kwargs[key]
        extra_cls = kwargs.pop("cls", None)
        extra_cls = kwargs.pop("class_", extra_cls)
        if extra_cls:
            classes.append(str(extra_cls))
        kwargs["cls"] = " ".join(classes)
        return _tag_builder(html_tag)(*children, **kwargs)
    return _build


class _PicoNamespace:
    """`ui.pico` (spec §4). Samme gate-i-instansen-begrunnelse som
    _LibNamespace (MicroPython-avviket, se der)."""

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        if not _has_import("pico"):
            raise _not_imported_error("pico")
        return _pico_component(name)


# PEP 562 - modul-nivå __getattr__. Brython implementerer dette som en
# generell språkfunksjon på ekte types.ModuleType-instanser (verifisert i
# browser) — samme oppførsel/feilmeldinger som pyodide/ui.py, se der for
# den fulle kommentaren.
def __getattr__(name):
    if name.startswith("_"):
        raise AttributeError("module 'ui' has no attribute '" + name + "'")
    if name == "sl":
        if not _has_import("sl"):
            raise _not_imported_error("sl")
        return _LibNamespace("sl", _SL_ACCEPTS)
    if name == "pico":
        if not _has_import("pico"):
            raise _not_imported_error("pico")
        return _PicoNamespace()
    if _has_import(name):
        return _LibNamespace(name)
    # Samme feiltekst som sl/pico-grenene over (og ui.lib(), som ruter
    # gjennom akkurat denne funksjonen) - ÉN feilformulering for "ikke
    # importert", uansett hvilken vei den nås fra.
    raise _not_imported_error(name)


def lib(name):
    """ui.lib(navn) - eksplisitt funksjonsform (spec §4: "also available
    for symmetry") - se pyodide/ui.py for den fulle docstringen."""
    return __getattr__(str(name))
