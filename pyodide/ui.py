"""ui - pyodide-fasade for notebook-widgets (spec 2026-07-15-notebook-widgets-design.md, W1).

Pull-modell: hvert `ui.*`-kall bygger en kontrollspec og sender den over
grensen som JSON til `window.Ui.registerControl(...)` (js/ui.js). Det er
JS-siden som EIER verdien - `ui.*` returnerer den gjeldende LAGREDE verdien
for kontrollen, ikke nødvendigvis det scriptet nettopp sendte inn som
`value=`. Når brukeren endrer kontrollen i nettleseren, oppdaterer js/ui.js
verdilageret og kjører cellen (eller et annet mål-id via `rerun=`) på nytt
gjennom den vanlige per-celle-kjøremaskinen - scriptet leser da UT den nye
verdien neste gang det kaller `ui.*`. Ingen tilstand lever i Python: en
celle er en ren funksjon av (kode, lagret verdi et sted i js/ui.js).
`ui.run_button(label, target=)` (2026-07-18) gir én felles kjør-knapp for
stripen — sukker over `ui.button(label, on_click=target)`, default "all".

I et vanlig script - ingen notatbok, ingen aktiv celle-kjørekontekst -
finnes det ingen `window.mdUiRunCtx()` å registrere kontrollen mot:
`registerControl` returnerer da None (eller `window`/`window.Ui` finnes
ikke i det hele tatt), og hver `ui.*`-funksjon faller tilbake til en
deterministisk default (dokumentert per funksjon under) - ALDRI en feil,
og ingen widget tegnes.

Widgets krever altså en aktiv notatbok + kjørende pyodide (med js/ui.js
lastet og en aktiv celle-kjørekontekst). Denne fila lastes lazy av
__ensureUi (index.html): en `import ui`/`from ui import ...` i en celle
trigger henting av denne fila FØR micropip forsøker å installere den fra
PyPI.

ui-html-fasen (Task 2, spec 2026-07-17-ui-html-design.md): `ui.html.*`
(ekte DOM-elementer via js/ui.js sin id-baserte element-motor, Task 1),
`ui.value(name)` (rent oppslag i verdilageret, kjører ingenting), og
on_change=/on_click= som i tillegg aksepterer en python-callable (bundet
via Ui.bindControlHandler - kontrollen rerunner da ALDRI, se
_register_value under).
"""
import io
import json
import sys

try:
    from js import window
except ImportError:      # CPython (pytest uten js-stub, eller ingen browser)
    window = None

try:
    from pyodide.ffi import create_proxy
except ImportError:          # CPython (pytest med js-stub): ingen proxy noedvendig
    def create_proxy(f):
        return f

try:
    from pyodide.ffi import JsNull
except ImportError:          # CPython (pytest med js-stub): egen falsy stub-klasse
    class JsNull:
        """Stub for CPython/pytest - ekte pyodide.ffi.JsNull finnes ikke der.
        En instans av DENNE klassen (satt av FakeUiJs i tester) er falsy,
        akkurat som den ekte - se ui.value() sin isinstance-vakt."""
        def __bool__(self):
            return False


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
    script). json.dumps ligger UTENFOR try-en med vilje: en userialiserbar
    verdi (f.eks. et vilkårlig objekt som value=) er en programmeringsfeil
    og skal feile HØYT med TypeError, ikke stille falle tilbake til
    default så widgeten bare uteblir.

    `not raw` (ikke `raw is None`) med vilje: et ekte JS `null` som kommer
    tilbake over pyodide-grensen konverteres IKKE til Python `None`, men til
    en egen falsy sentinel (`pyodide.ffi.JsNull`) - `is None` bommer da helt
    (oppdaget i browserverifisering: plain script + `import ui` kastet
    TypeError i json.loads i stedet for aa falle tilbake til default). Alle
    ekte (ikke-fallback) svar er ikke-tomme JSON-strenger ("3", "false",
    "null" for knapp), sa `not raw` treffer aldri en gyldig verdi."""
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
    Samme oppskrift som pyodide/dash.py sin _scalar."""
    if type(value).__module__ == "numpy" and hasattr(value, "item") \
            and not hasattr(value, "__len__"):
        try:
            return value.item()
        except Exception:
            return value
    return value


# fase 3: injeksjonsfrie tabeller/hjelpere flyttet til shared/ui_core.py
# (dedup pyodide/brython/micropython) - _spec sin _scalar-koersjon er
# facade-spesifikk (numpy), derfor injisert via configure(scalar=_scalar).
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
    Ui.renderEventResult (W5.2). Egen kompakt variant inspirert av dash.py
    sin kort-klassifisering (dash ducktyper figurer via to_json+data/layout;
    her brukes to_plotly_json, frame via to_html/columns) - fasadene er
    divergente kopier per konvensjon (builder-dedup er et eksisterende
    backlog-punkt)."""
    out_text = (out_text or "").rstrip("\n")
    if res is not None and hasattr(res, "to_plotly_json"):
        pj = res.to_plotly_json()
        return {"kind": "figure", "spec": {"data": pj.get("data"), "layout": pj.get("layout")}}
    if res is not None and hasattr(res, "to_html") and hasattr(res, "columns"):
        return {"kind": "table", "html": res.to_html(border=0)}
    if res is None:
        return {"kind": "text", "text": out_text} if out_text else None
    text = str(res)
    if out_text:
        text = out_text + "\n" + text
    return {"kind": "text", "text": text}


def _make_event_wrapper(handler):
    """Wrapperen JS faktisk kaller: JSON-event inn, payload-JSON ut.
    Fanger stdout (sys.stdout-bytte, dash-presedens) og ALLE unntak ->
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

    ui-html-fasen (Task 2, spec §3): en CALLABLE alias skal ALDRI havne i
    rerun= (en python-funksjon er ikke json.dumps-bar, og en kontroll med
    en bundet handler rerunner uansett aldri - se _register_value/
    Ui._fireControlHandler). rerun= beholder da sin egen verdi (default
    "self") uendret; selve callable-dispatchen skjer i _register_value."""
    if callable(alias):
        return rerun
    return alias if alias is not None else rerun


def _register_value(spec, handler):
    """_register(spec), men forstår BEGGE retur-formene fra
    Ui.registerControl (ui-html-fasen, Task 1): den gamle skalarverdien
    (uendret sti - ALLTID når `handler` ikke er en callable), ELLER
    {"value": ..., "key": ...} når spec får has_handler=True (satt HER,
    kun når handler faktisk er en python-callable - en streng/None
    rerun-alias er allerede løst av _alias_rerun og treffer aldri denne
    grenen). Ved dict-formen bindes handler til den returnerte nøkkelen
    via Ui.bindControlHandler FØR verdien pakkes ut - alle
    widget-byggerne under kan dermed fortsette å behandle
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
    som ui.on()/run_cell() gjør."""
    if not callable(handler) or not key:
        return
    u = _ui()
    if u is None:
        return

    def _adapter(evt):
        return handler(evt.get("value") if isinstance(evt, dict) else None)

    try:
        u.bindControlHandler(key, create_proxy(_make_event_wrapper(_adapter)))
    except Exception:
        # Samme defensive konvensjon som resten av fila: en utdatert
        # js/ui.js (uten bindControlHandler) skal degradere stille.
        pass


def slider(min=0, max=100, *, value=None, step=1, label=None, name=None, rerun='self', on_change=None, placement=None, sync_to=None, into=None):
    """Glidebryter. Fallback (ingen notatbok): value hvis gitt, ellers min.
    on_change= er kanonisk alias for rerun= (W5.1) - aliaset vinner.
    on_change= kan OGSÅ være en python-callable (ui-html-fasen, Task 2,
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
    on_change= kan OGSÅ være en python-callable (ui-html-fasen, Task 2,
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
    on_change= kan OGSÅ være en python-callable (ui-html-fasen, Task 2,
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
    on_change= kan OGSÅ være en python-callable (ui-html-fasen, Task 2,
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
    on_change= kan OGSÅ være en python-callable (ui-html-fasen, Task 2,
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
    on_change= kan OGSÅ være en python-callable (ui-html-fasen, Task 2,
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
    on_click= kan OGSÅ være en python-callable (ui-html-fasen, Task 2,
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
    cellens output-slot når target utelates. Utenfor nettleser: no-op."""
    u = _ui()
    if u is None:
        return None
    binding = {"selector": str(selector), "event": str(event)}
    if target is not None:
        binding["target"] = str(target)
    try:
        u.bindEvent(json.dumps(binding), create_proxy(_make_event_wrapper(handler)))
    except Exception:
        # Samme defensive konvensjon som _register: en utdatert js/ui.js
        # (uten bindEvent) skal degradere stille til no-op, ikke kaste.
        return None
    return None


# fase 3 (Task 3): run_cell flyttet til shared/ui_core.py (byte-identisk).
run_cell = _core.run_cell


def value(name):
    """ui.value(name) (spec §3) - gjeldende LAGREDE verdi for kontrollen
    `name`, hvor som helst i dokumentet, UTEN å kjøre noe (rent synkront
    oppslag i js/ui.js sitt verdilager via Ui.value - se der for
    "siste registrerte vinner ved duplikate navn"-regelen + console.warn).

    None ved: ingen window/Ui (ikke i nettleser/ikke lastet ennå), ukjent
    navn, ELLER en ekte JS `null` (Ui.value returnerer JS `null` for et
    ukjent navn - denne krysser IKKE broen som Python None, se JsNull-
    importen øverst i fila + _register sin tilsvarende dokumentasjon).
    Merk at Ui.value returnerer den RÅ verdien direkte (ikke en
    JSON-streng slik registerControl gjør) - ingen json.loads her."""
    u = _ui()
    if u is None:
        return None
    try:
        raw = u.value(str(name))
    except Exception:
        return None
    if raw is None:
        return None
    if isinstance(raw, JsNull) or type(raw).__name__ == "JsNull":
        return None
    return raw


# Brython-felle (se brython/matplotlib_brython.py + test_brython_scoping_
# trap.py): en METODE som refererer en global funksjon med SAMME navn som
# METODEN blir stille en no-op i Brython (CPython/pyodide er korrekt, men
# fasadene er byte-mirror-tvillinger - samme alias overalt). WidgetHandle.
# value (under) kaller derfor denne ikke-kolliderende aliasen i stedet for
# value(...) direkte.
_value = value


# ══════════════════════════════════════════════════════════════════════════
# ui.widget("navn") - håndtak til en ALLEREDE DEKLARERT kontroll
# (dash-absorpsjon 5a Task 2, spec 2026-07-18-dash-absorption-design.md §1,
# "widgets-vs-elements"-avgjørelsen, Hans 2026-07-18).
#
# Ettlinjeregelen: ui.slider(...)/ui.dropdown(...)/osv. DEKLARERER
# kontrollen og GIR VERDIEN (den primære APIen, UENDRET av dette - se
# funksjonene over) - ui.widget("navn") GIR HÅNDTAKET til en kontroll som
# ALLEREDE er deklarert et annet sted (typisk en TIDLIGERE celle), for
# imperativ styring UTENFOR selve deklarasjonen (en event-handler, en
# annen celle).
#
# .set(v) fyrer ALDRI on_change/rerun: et PROGRAMMATISK sett er ikke en
# brukerhandling - en on_change-handler som selv kaller .set() på widgeten
# sin EGEN kontroll (eller en ANNEN) skal ikke kunne trigge seg selv i en
# løkke (js/ui.js sin Ui.widgetSet - se der - kaller aldri
# _fireControlHandler/_rerunFor).
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
        has_handler-kanalen _fireControlHandler bruker). Samme
        wrapper-konvensjon (stdout-fangst, feil->error-payload,
        create_proxy) som ui.on()/Element.on()."""
        u = _ui()
        if u is not None:
            try:
                u.widgetBind(self._key, str(event), create_proxy(_make_event_wrapper(handler)))
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
# ui.html - element-byggere (ui-html-fasen, Task 2, spec §1)
#
# Arkitektur (pinned 2026-07-17): DOM-noden EIES og leves JS-side
# (js/ui.js sitt Ui.el*-register, Task 1) - denne fila holder BARE en
# streng-id (elId) per element. Kwarg-NAVN-normalisering (cls/class_/
# style-dict/data_/aria_/attrs) er PUR python-side (_normalize_kwargs,
# tungt testet i isolasjon); selve property-vs-setAttribute-avgjørelsen
# skjer JS-side (Ui._applyOneElProp/_setAttrValue) - denne fila sender
# bare ferdig-normaliserte navn/verdier over broen som JSON.
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
    (propsdict, handlers, warnings):

    - propsdict: {"props": {...}, "attrs": {...}} (+ "style" hvis gitt) -
      EXAKT formen Ui.elCreate/elSetProps (js/ui.js, Task 1) forventer.
    - handlers: [(event, callable), ...] samlet fra on_<event>=callable -
      selve BINDINGEN skjer aldri her (en callable kan ikke json.dumps-es
      over broen) - kalleren (tag-bygger/Element) gjør ett Ui.elOn-kall
      per oppføring etter at elementet er opprettet.
    - warnings: menneskelesbare advarsel-strenger - PUR betyr INGEN
      console.warn-kall her; kalleren emitter dem via _warn() (holder
      denne funksjonen 100% sideeffekt-fri og enkel å enhetsteste).

    Regler (spec §1, "unified kwargs standard"):
    - cls=/class_= -> attrs["class"] (BEGGE aksepteres; angis begge
      samtidig vinner den siste i kall-rekkefølgen + advarsel; class MÅ
      gå setAttribute-veien, se elCreate sin _setAttrValue).
    - style= streng -> style-strengen uendret (cssText); style= dict ->
      dict med nøklene snake_case->camelCase (construction og
      Element.set_style er nå SAMME regel, code2web-varten spec §1
      nevner eksplisitt).
    - data_x=/aria_x= -> attrs["data-x"]/attrs["aria-x"] (ALLE
      understreker i resten av navnet -> bindestrek, ikke bare den
      første - "data_test_id" -> "data-test-id").
    - attrs={...} merges verbatim inn i attrs (escape hatch for
      vilkårlige attributt-navn) - MÅ være en dict, ellers TypeError
      (klar programmeringsfeil, ikke en "mistenkelig verdi"-advarsel).
      Ved samme attributt-navn fra data_x=/aria_x= og attrs={} vinner
      den som kommer SIST i kall-rekkefølgen (attrs merges på sin
      plass) - udefinert var det aldri, men nå er det dokumentert.
    - on_<event>=callable -> samlet i handlers; on_<event>=<ikke-callable>
      (typisk en streng) -> IKKE eksekvert (motsatt av code2web sin
      exec()-vane) - droppet med en advarsel i stedet (spec §1: "a string
      value is NOT executed... dropped, warn instead").
    - bool -> "passthrough": sendes uendret under props (samme gren som
      "alt annet" under) - JS-siden (Ui._applyOneElProp/_setAttrValue)
      avgjør property-vs-attributt OG bool->tom-attributt-konvensjonen;
      python normaliserer bare NAVNET, aldri verdien, for bool.
    - alt annet -> props[snake_case->camelCase(navn)] = verdi. En callable
      HER (dvs. IKKE on_-prefikset) er nesten alltid en brukerfeil
      (glemt on_-prefiks) -> advarsel, verdien droppes (ikke sendt).
      En ikke-JSON-vennlig verdi -> advarsel + str()-fallback (aldri en
      rå TypeError midt i elCreate)."""
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
# fase 4b (Task 3): _flatten_children flyttet til shared/ui_core.py
# (pur, ingen fasade-avhengighet - samme ett-nivå-flating
# _append_children selv bruker internt, se der) - brukt av
# Element.add sin span=/align=-gren og _render_area_children under.
_flatten_children = _core._flatten_children


def _render_area_children(target_el_id, children):
    """fase 4b (Element.add sin area=-gren, spec §Decisions 4): render
    `children` INN i et allerede TØMT område-barn (Ui.elClear er kallerens
    ansvar, FØR dette kalles). Element/str-barn går den vanlige
    _append_children-stien (elAppend, med samme ett-nivå-flating og
    nøstet-liste-advarsel som der). Alt annet - en VERDI (DataFrame/figur/
    tall/bool/osv., hverken Element, str eller liste) - klassifiseres
    PRESIS som en on_change-handler sin returverdi ville blitt
    (_event_payload, samme funksjon W5.2 allerede bruker for
    Ui.renderEventResult) og rendres via Ui.elPayload inn i noden - SAMME
    rendrings-vokabular som ui.kpi/ui.markdown (_payload_element-familien)
    bruker, ikke en rå str()-tekstnode slik _append_children sin
    catch-all-gren ville gjort."""
    element_or_text = []
    u = None
    for child in _flatten_children(children):
        if child is None:
            continue
        if isinstance(child, (list, tuple)):
            _warn_sink("ui.grid: nøstet liste (mer enn ett flatingsnivå) i area-barn - hoppet over")
            continue
        if isinstance(child, (Element, str)):
            element_or_text.append(child)
            continue
        if u is None:
            u = _ui()
        if u is not None and target_el_id is not None:
            payload = _event_payload(child, "")
            if payload is not None:
                try:
                    u.elPayload(target_el_id, json.dumps(payload))
                except Exception:
                    pass
    if element_or_text:
        _append_children(target_el_id, element_or_text)


class Element:
    """Python-håndtak for en JS-eid DOM-node (ui-html-fasen, Task 2,
    spec §1). Holder KUN elId (en streng) - selve noden lever og eies
    JS-side (js/ui.js sitt _els-register, Task 1). `_openstat_el_id` er
    duck-type-kontrakten index.html sin `_show_one` display-krok bruker
    (spec §2) til å avgjøre "dette er et monterbart element, ikke en
    vanlig verdi å repr-printe"."""

    def __init__(self, el_id, tag=None):
        self._openstat_el_id = el_id
        # Python-sidens speil av class-settet - add_class/remove_class
        # (under) må kjenne HELE det gjeldende settet for å kunne sende
        # en fullstendig erstatnings-streng til elSetProps (JS eier ikke
        # et strukturert class-sett, bare selve attributt-STRENGEN).
        self._classes = set()
        # ui-html-fasen (Task 4, spec §4): elementets EGEN tag (f.eks.
        # "div" eller "sl-button") - satt av _tag_builder/_lib_tag_builder
        # ved opprettelse, None for elementer bygget på annet vis (aldri
        # antatt/gjettet i etterkant). Brukes KUN til `accepts`-
        # barn-whitelist-validering (_validate_accepts under) - portert fra
        # code2web/ui.py:3320-3380 sin "er dette en gyldig barn-tag for
        # denne komponenten"-sjekk, generalisert til å virke via SAMME
        # Element-klasse som ui.html bruker (ingen egen sl-Element-klasse).
        self._openstat_tag = tag

    def add(self, *children, area=None, span=None, align=None):
        """Legg til flere barn (samme regler som konstruktørens
        *children - str/Element/liste-ett-nivå/None, spec §1) - UENDRET
        når area=/span=/align= ikke er gitt (dagens *children-oppførsel,
        inkludert `.add([a, b])`-listeformen, er 100% som før).

        fase 4b (spec 2026-07-21 §Decisions 4, Task 3): tre nye,
        valgfrie per-kalls-kwargs:

        - area= (kun ui.grid-elementer, KREVER `_areas` satt av grid() -
          en ANNEN Element uten et kjent område -> TypeError med en lesbar
          feiltekst, ALDRI en stille no-op): tømmer området sitt
          forhåndsopprettede barn-div (Ui.elClear) og RENDRER children INN
          i det - erstatt-semantikk (W5 sin target-registry-idé, spec:
          "into an OCCUPIED area REPLACES its content"), ikke append.
          Element/str-barn går den vanlige _append_children-veien;
          VERDI-barn (DataFrame/figur/skalar - hverken Element, str eller
          liste) går via _render_area_children under, som klassifiserer
          dem PRESIS som en on_change-handler sin returverdi ville blitt
          (gjenbruker _event_payload) og rendrer via Ui.elPayload - SAMME
          rendrings-vokabular som ui.kpi/ui.markdown/ui.on() allerede
          bruker (_payload_element-familien).
        - span=/align= (ethvert barn, ikke bare grid): satt på HVERT
          Element-barn i DETTE kallet (span= -> style.gridColumn =
          "span N"; align= -> style.alignSelf) via Element.set_style -
          verdi-/tekst-barn har ingen egen DOM-node å style og hoppes
          derfor stille over."""
        if area is not None:
            areas = getattr(self, "_areas", None)
            if not areas or area not in areas:
                raise TypeError(
                    'ui.grid: "' + str(area) + '" er ikke et gyldig område på '
                    'dette elementet - area= krever et ui.grid(...)-element '
                    'med dette området i sin template')
            target = areas[area]
            target.clear()
            _render_area_children(target._openstat_el_id, children)
            style_targets = [target]
        else:
            _append_children(self._openstat_el_id, children)
            style_targets = [c for c in _flatten_children(children) if isinstance(c, Element)]
        if span is not None or align is not None:
            styles = {}
            if span is not None:
                styles["grid_column"] = "span " + str(span)
            if align is not None:
                styles["align_self"] = align
            for el in style_targets:
                el.set_style(**styles)
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
        payload) som ui.on()/run_cell() bruker for HTML-celle-events."""
        u = _ui()
        if u is not None and self._openstat_el_id is not None:
            try:
                u.elOn(self._openstat_el_id, str(event),
                       create_proxy(_make_event_wrapper(handler)))
            except Exception:
                pass
        return self

    def set_style(self, **styles):
        """Sett CSS-stiler (snake_case->camelCase, spec §1 - SAMME regel
        som style=-kwarget ved konstruksjon, code2web-varten sitt
        avvik er eksplisitt fikset her)."""
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
# vokabularet (dash-absorpsjon 5a Task 3, spec §2). Ui.renderPayload
# (js/ui.js, Task 1) er ÉN rendrings-implementasjon delt mellom
# event-resultater (ui.on()-handlere sin returverdi) OG disse byggerne -
# begge veier bygger et {kind, ...}-payload-dict og rendrer det gjennom
# NØYAKTIG samme JS-kode. Mekanikken her: elCreate('div', {}) → en tom
# vert-node, elPayload(elId, payload) → Ui.renderPayload sitt resultat
# rendret INN i den (clear-then-render), Element(elId) → det vanlige
# ui.html-håndtaket (mountes/kjedes/stiles akkurat som ui.html.div(...)).
# ══════════════════════════════════════════════════════════════════════════

def _payload_element(payload):
    """Felles kjerne for ui.kpi/ui.markdown/ui.image: en tom vert-div
    (Ui.elCreate) med `payload` rendret INN i den (Ui.elPayload, Task 3).
    Ingen window/Ui (ikke i nettleser/ikke lastet ennå) → et Element med
    el_id=None (samme "eskapelukene blir None"-fallback som resten av
    ui-html-fasen - IKKE en feil, elementet er da bare aldri-monterbart)."""
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
    """_scalar(v), MEN NaN/±Infinity → None (samme regel som dash.py sin
    _number_payload: json.dumps av NaN/Infinity gir literal NaN/Infinity-
    tokens som knekker JSON.parse i JS - ui.kpi sine value=/delta=/ref=
    er alle DIREKTE brukerverdier, ikke forhånds-sjekket av noen add()-
    dispatch slik dash sin _payload() gjorde det FØR den kalte
    _number_payload)."""
    v = _scalar(v)
    if isinstance(v, float) and (v != v or abs(v) == float("inf")):
        return None
    return v


# fase 3 (Task 3): kpi/markdown/_tag_builder (under, etter _mpl_image/
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

# fase 4b (Task 3, spec 2026-07-21): row/column/grid (containere) er rene
# funksjoner i shared/ui_core.py - byte-identiske på tvers av fasadene
# (samme injiserte element-motor-sti som _tag_builder, ingen egen
# fasade-spesifikk kode). row/column/grid trenger IKKE selv en ny
# configure()-injeksjon (de bruker bare _tag_builder, allerede rebundet
# under sin egen kommentar lenger ned i fila - late binding via
# ui_core.py sine egne modul-globals løser dette uansett rekkefølge).
row = _core.row
column = _core.column
grid = _core.grid


def _mpl_image(x):
    """Ekte matplotlib Figure/Axes (inkl. df.plot()-retur) -> PNG data-URI.
    Portert ORDRETT fra pyodide/dash.py:175 (samme funksjon, samme grunn:
    denne motoren har EKTE matplotlib - forsøkes kun når scriptet alt har
    importert det). None hvis `x` ikke er en gjenkjennelig matplotlib-figur
    (eller matplotlib ikke er importert i det hele tatt)."""
    if "matplotlib" not in sys.modules:
        return None
    fig = x if hasattr(x, "savefig") else getattr(x, "figure", None)
    if fig is None or not hasattr(fig, "savefig"):
        return None
    import base64
    import matplotlib.pyplot as plt
    fig.set_size_inches(7.2, 4.4)   # fyller innholdsflaten uten letterboxing (v1 §7)
    fig.set_dpi(100)
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight")
    plt.close(fig)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def image(src, alt=None):
    """ui.image(src, alt=None) -> Element (<img class="ui-img">). `src`
    aksepterer ENTEN en streng (URL eller data-URI, sendt uendret) ELLER en
    ekte matplotlib Figure/Axes (konvertert til en PNG data-URI via
    _mpl_image, portert fra dash.py:175 - denne motoren har ekte
    matplotlib). En ikke-streng som IKKE er en gjenkjennelig matplotlib-
    figur faller tilbake til str(src) (aldri en krasj - samme tolerante
    prinsipp som resten av ui-html-fasen)."""
    if not isinstance(src, str):
        mpl_src = _mpl_image(src)
        src = mpl_src if mpl_src is not None else str(src)
    payload = {"kind": "image", "src": src}
    if alt is not None:
        payload["alt"] = str(alt)
    return _payload_element(payload)


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
                'HTML_TAGS-listen i pyodide/ui.py (kopiert fra '
                'code2web/ui.py:4481-4495): ' + HTML_TAGS.strip())
        return _tag_builder(tag)


html = _HtmlNamespace()


# ══════════════════════════════════════════════════════════════════════════
# #tag.import - kuratert register + dynamiske navnerom (ui-html-fasen,
# Task 4, spec §4)
#
# Selve LASTINGEN (script/link-injeksjon, TAG_IMPORT_REGISTRY med pinnede
# jsdelivr-URL-er, idempotens) skjer JS-side (index.html sin
# mdEnsureTagImports() - kjørt FØR brukerkoden, ved alle kjøreveiene som
# allerede ensure'er pyodide/ui.py selv). Denne fila vet bare to ting:
# (1) er navnerommet `ns` faktisk lastet (Ui.hasImport, satt av
# mdEnsureTagImports ved suksess), og (2) hvordan man bygger
# `<prefix>-<kebab(navn)>`-elementer via SAMME element-motor/kwargs-standard
# som ui.html - _LibNamespace/_lib_tag_builder under.
# ══════════════════════════════════════════════════════════════════════════

def _has_import(ns):
    """Ui.hasImport(ns) over broen - se js/ui.js sin docstring. False (ikke
    en feil) ved: ingen window/Ui (ikke i nettleser/ikke lastet ennå), ELLER
    en utdatert js/ui.js uten hasImport (samme defensive konvensjon som
    resten av fila - degraderer stille til False, aldri en krasj)."""
    u = _ui()
    if u is None:
        return False
    try:
        return bool(u.hasImport(str(ns)))
    except Exception:
        return False


def _not_imported_error(navn):
    """Samme feiltekst uansett hvor den kastes fra (modul-__getattr__ HER,
    ELLER - MicroPython-avviket, se ui_mpy.py sin header-kommentar -
    _LibNamespace/_PicoNamespace sin EGEN __getattr__) - spec §4: "clear
    error naming the #tag.import line to add"."""
    return AttributeError(
        'ui.' + str(navn) + ': ikke importert - legg til "#tag.import = '
        + str(navn) + '" (eller for et generisk bibliotek: "#tag.import = '
        '<url> as ' + str(navn) + '") i preambelen')


def _validate_accepts(prefix, name, accepted, children):
    """`accepts`-barn-whitelist-validering (spec §4, portert fra
    code2web/ui.py:3320-3380 sitt `_component_definitions`) - varsler (ALDRI
    blokkerer, speiler code2web sin egen ikke-fatale "may not be a valid
    child"-oppførsel) når et Element-barn av en KJENT komponent har en tag
    utenfor den kuraterte lista. `accepted` er None/tom for en UKJENT
    komponent (spec: "unknown sl-names -> generic sl-*") - da skjer INGEN
    validering i det hele tatt, uansett hvilke barn som gis. Samme ett-nivås
    flating som _append_children (spec §1) - en dobbelt-nøstet liste er
    allerede _append_children sitt eget varselansvar, ikke denne
    funksjonens."""
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
    egen tag (f.eks. "sl-button") + valgfri accepts-validering
    (_validate_accepts) FØR barna faktisk appendes. `prefix`/`name` er kun
    til varselteksten (ikke til selve byggingen - `tag` er allerede den
    fullstendige, sammensatte kebab-tag-strengen)."""
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
    `__getattr__(navn)` -> byggerfunksjon for `<prefix>-<kebab(navn)>`, via
    SAMME element-motor/kwargs-standard som ui.html (_lib_tag_builder).

    Gate HER (i tillegg til modul-__getattr__ sin gate under) med vilje -
    se ui_mpy.py sin header-kommentar: MicroPython-fasaden har INGEN
    modul-__getattr__ i det hele tatt (den er forhåndsinstansiert der), så
    denne instans-__getattr__-gaten er den ENESTE gaten som fyrer i den
    fasaden. Harmløst dobbelt-sjekket i pyodide/brython (modul-__getattr__
    har allerede gatet FØR denne klassen i det hele tatt instansieres der).

    `accepts` (kun satt for "sl", spec §4): valgfritt
    {kebab-navn: [aksepterte barn-tagger]} - portert fra
    code2web/ui.py:3320-3380."""

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
    """component_name -> f(*children, **kwargs) -> Element (spec §4: "plain
    tags + pico classes"). HTML-tag = `name` selv hvis den er i
    PICO_HTML_ELEMENTS, ellers "div" (code2web-varten sin regel, linje
    3808). pico_class = PICO_COMPONENT_CLASSES.get(name, name) - et UKJENT
    name får sitt eget navn som klasse (code2web sin fallback, linje 3814).
    Utility-kwargs (primary=True/secondary=True/...) legges til som EKSTRA
    klasser og fjernes FØR resten når over til _tag_builder (de er ikke
    ekte DOM-props)."""
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
    """`ui.pico` (spec §4). `__getattr__` over VILKÅRLIG navn - code2web
    sin variant har ingen fast medlemsliste (ethvert navn blir enten et av
    PICO_HTML_ELEMENTS eller <div class="{navn}">, se _pico_component sin
    egen fallback). Samme gate-i-instansen-begrunnelse som _LibNamespace
    (MicroPython-avviket, se der)."""

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        if not _has_import("pico"):
            raise _not_imported_error("pico")
        return _pico_component(name)


# PEP 562 - modul-nivå __getattr__ (kun pyodide/brython - se ui_mpy.py sin
# header-kommentar for MicroPython-avviket: INGEN modul-__getattr__ der,
# sl/pico er forhåndsinstansierte modul-attributter i stedet, og generiske
# #tag.import-navn er KUN nåbare via ui.lib(navn), ikke ui.<navn>).
#
# ui.sl / ui.pico / ui.<et hvilket som helst #tag.import-lastet generisk
# navn> løses HER, LAZY - navnerommet finnes bare når det tilsvarende
# #tag.import faktisk ble lastet (Ui.hasImport, satt av index.html sin
# mdEnsureTagImports ved KJØRETID, FØR brukerkoden - se modulens
# toppkommentar). Ukjent/ikke-importert navn -> AttributeError som navngir
# #tag.import-linja å legge til (spec: "Namespaces exist lazily... raises a
# clear error naming the #tag.import line to add").
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
    # importert", uansett hvilken vei den nås fra (forenkling, ikke en
    # egen "ukjent attributt"-variant).
    raise _not_imported_error(name)


def lib(name):
    """ui.lib(navn) - eksplisitt FUNKSJONSFORM av nøyaktig samme oppslag som
    modul-__getattr__ over (spec §4: "ui.lib() also available for
    symmetry") - nyttig når navnet er en PYTHON-VERDI (variabel) i stedet
    for et bokstavelig attributtnavn (`ui.<navn>` krever et syntaktisk
    identifikatornavn; `ui.lib(en_variabel)` gjør ikke det). Samme
    feil/gate-oppførsel som __getattr__ - IKKE en egen sti."""
    return __getattr__(str(name))
