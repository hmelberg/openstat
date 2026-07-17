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


def _spec(type_, **kwargs):
    """type + gitte kwargs, None-verdier droppes (matcher js/ui.js sin
    normalizeSpec, som selv fyller inn defaults for det som mangler).
    Numeriske kwargs (min/max/value/step) koerseres via _scalar, slik at
    f.eks. `max=df['x'].max()` (numpy-skalar) overlever json.dumps.

    placement (Task 3, per-kontroll plassering) og sync_to (Task 4,
    synkronisering til live-sesjonsvariabel) er rene gjennomstrøms-kwargs
    her - selve valideringen skjer på JS-siden (js/ui.js sin normalizeSpec),
    akkurat som rerun allerede er. None (ikke gitt) droppes av løkka under
    som vanlig, og kontrollen faller da tilbake til cellens widgets=-default."""
    spec = {"type": type_}
    for k, v in kwargs.items():
        if k in ("min", "max", "value", "step"):
            v = _scalar(v)
        if v is not None:
            spec[k] = v
    return spec


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
    _register(...)-returen (skalar-eller-None)."""
    if callable(handler):
        spec["has_handler"] = True
    result = _register(spec)
    if isinstance(result, dict):
        _bind_handler_if_callable(handler, result.get("key"))
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


def slider(min=0, max=100, *, value=None, step=1, label=None, name=None, rerun='self', on_change=None, placement=None, sync_to=None):
    """Glidebryter. Fallback (ingen notatbok-støtte): value hvis gitt, ellers min.
    on_change= er kanonisk alias for rerun= (W5.1) - aliaset vinner.
    on_change= kan OGSÅ være en python-callable (ui-html-fasen, Task 3,
    spec §3): da bindes den som en handler (kontrollen rerunner ALDRI)
    i stedet for rerun-alias-stien.
    sync_to= pusher verdien inn i live-sesjonsvariabelen ved endring, uten rerun."""
    rerun = _alias_rerun(rerun, on_change)
    spec = _spec("slider", min=min, max=max, value=value, step=step,
                 label=label, name=name, rerun=rerun, placement=placement, sync_to=sync_to)
    result = _register_value(spec, on_change)
    if result is None:
        return _scalar(value) if value is not None else _scalar(min)
    return _num(result)


def dropdown(options, *, value=None, label=None, name=None, rerun='self', on_change=None, placement=None, sync_to=None):
    """Nedtrekksmeny. Fallback: value hvis gitt, ellers første valg.
    on_change= er kanonisk alias for rerun= (W5.1) - aliaset vinner.
    on_change= kan OGSÅ være en python-callable (ui-html-fasen, Task 3,
    spec §3): da bindes den som en handler (kontrollen rerunner ALDRI)
    i stedet for rerun-alias-stien.
    sync_to= pusher verdien inn i live-sesjonsvariabelen ved endring, uten rerun."""
    rerun = _alias_rerun(rerun, on_change)
    options = list(options)
    if not options:
        raise ValueError("ui.dropdown: options kan ikke være en tom liste.")
    spec = _spec("dropdown", options=[str(o) for o in options], value=value,
                 label=label, name=name, rerun=rerun, placement=placement, sync_to=sync_to)
    result = _register_value(spec, on_change)
    if result is None:
        return str(value) if value is not None else str(options[0])
    return str(result)


def checkbox(label=None, *, value=False, name=None, rerun='self', on_change=None, placement=None, sync_to=None):
    """Avkrysningsboks. Fallback: value.
    on_change= er kanonisk alias for rerun= (W5.1) - aliaset vinner.
    on_change= kan OGSÅ være en python-callable (ui-html-fasen, Task 3,
    spec §3): da bindes den som en handler (kontrollen rerunner ALDRI)
    i stedet for rerun-alias-stien.
    sync_to= pusher verdien inn i live-sesjonsvariabelen ved endring, uten rerun."""
    rerun = _alias_rerun(rerun, on_change)
    spec = _spec("checkbox", value=bool(value), label=label, name=name, rerun=rerun, placement=placement, sync_to=sync_to)
    result = _register_value(spec, on_change)
    if result is None:
        return bool(value)
    return bool(result)


def switch(label=None, *, value=False, name=None, rerun='self', on_change=None, placement=None, sync_to=None):
    """Bryter (samme semantikk som checkbox, annen visning). Fallback: value.
    on_change= er kanonisk alias for rerun= (W5.1) - aliaset vinner.
    on_change= kan OGSÅ være en python-callable (ui-html-fasen, Task 3,
    spec §3): da bindes den som en handler (kontrollen rerunner ALDRI)
    i stedet for rerun-alias-stien.
    sync_to= pusher verdien inn i live-sesjonsvariabelen ved endring, uten rerun."""
    rerun = _alias_rerun(rerun, on_change)
    spec = _spec("switch", value=bool(value), label=label, name=name, rerun=rerun, placement=placement, sync_to=sync_to)
    result = _register_value(spec, on_change)
    if result is None:
        return bool(value)
    return bool(result)


def number(value=0, *, min=None, max=None, step=None, label=None, name=None, rerun='self', on_change=None, placement=None, sync_to=None):
    """Tallfelt. Fallback: value.
    on_change= er kanonisk alias for rerun= (W5.1) - aliaset vinner.
    on_change= kan OGSÅ være en python-callable (ui-html-fasen, Task 3,
    spec §3): da bindes den som en handler (kontrollen rerunner ALDRI)
    i stedet for rerun-alias-stien.
    sync_to= pusher verdien inn i live-sesjonsvariabelen ved endring, uten rerun."""
    rerun = _alias_rerun(rerun, on_change)
    spec = _spec("number", value=value, min=min, max=max, step=step,
                 label=label, name=name, rerun=rerun, placement=placement, sync_to=sync_to)
    result = _register_value(spec, on_change)
    if result is None:
        return _scalar(value)
    return _num(result)


def text(value='', *, label=None, name=None, rerun='self', on_change=None, placement=None, sync_to=None):
    """Tekstfelt. Fallback: str(value) - returtypen er alltid str
    (speiler dash.py sin textfield(default=str(default))).
    on_change= er kanonisk alias for rerun= (W5.1) - aliaset vinner.
    on_change= kan OGSÅ være en python-callable (ui-html-fasen, Task 3,
    spec §3): da bindes den som en handler (kontrollen rerunner ALDRI)
    i stedet for rerun-alias-stien.
    sync_to= pusher verdien inn i live-sesjonsvariabelen ved endring, uten rerun."""
    rerun = _alias_rerun(rerun, on_change)
    spec = _spec("text", value=str(value), label=label, name=name, rerun=rerun, placement=placement, sync_to=sync_to)
    result = _register_value(spec, on_change)
    if result is None:
        return str(value)
    return str(result)


def button(label, *, rerun='self', on_click=None, name=None, placement=None):
    """Trykknapp. Returnerer alltid None - selve klikket trigger en rerun
    av målcellen (js/ui.js), ikke en verdi å lese ut.
    on_click= er kanonisk alias for rerun= (W5.1) - aliaset vinner.
    on_click= kan OGSÅ være en python-callable (ui-html-fasen, Task 3,
    spec §3): da bindes den som en handler (klikket rerunner ALDRI) i
    stedet for rerun-alias-stien; handleren mottar alltid None (knapper
    har ingen lagret verdi)."""
    rerun = _alias_rerun(rerun, on_click)
    spec = _spec("button", label=label, name=name, rerun=rerun, placement=placement)
    _register_value(spec, on_click)
    return None


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


def run_cell(selector, event, cell_id):
    """Kjør en navngitt celle (id= i #%%-headeren) når HTML-eventen
    fyrer - cellevarianten av on() (eget navn, ingen overloading)."""
    u = _ui()
    if u is None:
        return None
    try:
        u.bindRunCell(json.dumps({"selector": str(selector), "event": str(event), "cellId": str(cell_id)}))
    except Exception:
        # Samme defensive konvensjon som _register: en utdatert js/ui.js
        # (uten bindRunCell) skal degradere stille til no-op, ikke kaste.
        return None
    return None


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


# ══════════════════════════════════════════════════════════════════════════
# ui.html - element-byggere (ui-html-fasen, Task 3, speiler pyodide/ui.py
# sin Task 2-seksjon BYTE FOR BYTE - se der for den fulle arkitektur-
# kommentaren. Eneste dialektavvik: INGEN create_proxy noe sted (Brython-
# funksjoner er JS-kallbare direkte over grensen, som resten av denne
# fila allerede gjør for on()/run_cell()/_bind_handler_if_callable).
# ══════════════════════════════════════════════════════════════════════════

# Standard HTML-tagger for den generiske ui.html.<tag>(...)-fabrikken.
# Kopiert ORDRETT fra pyodide/ui.py (som selv kopierte den ordrett fra
# code2web/ui.py:4481-4495) - samme kilde, samme duplisering av "table".
HTML_TAGS = (
    "head link meta style title body "
    "address article aside footer header h1 h2 h3 h4 h5 h6 main nav section "
    "blockquote dd div dl dt figcaption figure hr li ol p pre table ul "
    "a abbr b bdi bdo br cite code data dfn em i kbd mark q rp rt ruby s samp small span strong sub sup time u var wbr "
    "area audio img map track video "
    "embed iframe object param picture portal source "
    "svg math "
    "canvas noscript script "
    "del ins "
    "caption col colgroup table tbody td tfoot th thead tr "
    "button datalist fieldset form input label legend meter optgroup option output progress select textarea "
    "details dialog menu summary "
    "slot template "
)
_HTML_TAG_SET = frozenset(HTML_TAGS.split())


def _warn(msg):
    """console.warn via broen, GUARDET (ingen window/console i CPython-
    pytest eller et vanlig script uten js/ui.js lastet ennå) - "aldri
    stille, men aldri en krasj for en advarsel" (spec: error handling)."""
    try:
        window.console.warn(msg)
    except Exception:
        pass


def _snake_to_camel(name):
    """snake_case -> camelCase, for style-dict-nøkler og generiske
    DOM-egenskapsnavn (IKKE for class/data_/aria_/attrs - de har egne
    regler i _normalize_kwargs). Navn UTEN understrek er uendret. Et
    ENKELT etterslengt understrek (f.eks. "for_" for å unngå å kollidere
    med et python-nøkkelord) strippes til "for" som et harmløst biprodukt."""
    if "_" not in name:
        return name
    head, *rest = name.split("_")
    return head + "".join(p[:1].upper() + p[1:] for p in rest if p)


def _json_safe(value):
    """True hvis `value` er trygg å json.dumps rett over broen (samme
    primitiv-familie som JSON selv - str/int/float/bool/None/dict/list),
    rekursivt for dict/list. Brukes av _normalize_kwargs til å fange opp
    "mistenkelige" propsverdier FØR de når json.dumps (som ville kastet
    en rå TypeError midt inne i et elCreate-kall)."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return True
    if isinstance(value, dict):
        return all(isinstance(k, str) and _json_safe(v) for k, v in value.items())
    if isinstance(value, (list, tuple)):
        return all(_json_safe(v) for v in value)
    return False


def _normalize_kwargs(kwargs):
    """PUR (ingen side-effekter, ingen broen) - den tungt testede kjernen
    av den "unified kwargs standard"-en spec §1 definerer. Returnerer
    (propsdict, handlers, warnings) - se pyodide/ui.py sin fulle docstring
    (identisk regelsett, speilet her byte for byte):

    - propsdict: {"props": {...}, "attrs": {...}} (+ "style" hvis gitt).
    - handlers: [(event, callable), ...] samlet fra on_<event>=callable.
    - warnings: menneskelesbare advarsel-strenger - PUR, ingen
      console.warn-kall her; kalleren emitter dem via _warn()."""
    props = {}
    attrs = {}
    style = None
    handlers = []
    warnings = []
    for key, raw_value in kwargs.items():
        if key in ("cls", "class_"):
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


def _append_children(el_id, children):
    """Legg til `children` (Element.add/tag-byggeren sin *children) under
    el_id via Ui.elAppend, ETT nivå flatet (spec §1: "lists flatten one
    level") - str -> tekstnode, Element -> el-referanse, None -> hoppet
    over, en GJENVÆRENDE liste/tuple etter flatingen (dvs. nøstet mer enn
    ett nivå) -> advarsel + hoppet over (aldri gjettet på som tekst)."""
    u = _ui()
    if u is None or el_id is None:
        return
    flat = []
    for child in children:
        if isinstance(child, (list, tuple)):
            flat.extend(child)
        else:
            flat.append(child)
    for child in flat:
        if child is None:
            continue
        if isinstance(child, Element):
            payload = {"el": child._openstat_el_id}
        elif isinstance(child, (list, tuple)):
            _warn("ui.html: nøstet liste (mer enn ett flatingsnivå) i children - hoppet over")
            continue
        else:
            payload = {"text": str(child)}
        try:
            u.elAppend(el_id, json.dumps(payload))
        except Exception:
            pass


class Element:
    """Python-håndtak for en JS-eid DOM-node (ui-html-fasen, Task 3,
    speiler pyodide/ui.py sin Element byte for byte). Holder KUN elId (en
    streng) - selve noden lever og eies JS-side (js/ui.js sitt
    _els-register, Task 1). `_openstat_el_id` er duck-type-kontrakten
    brython_runner.py sin `_fmt` display-krok bruker (spec §2) til å
    avgjøre "dette er et monterbart element, ikke en vanlig verdi å
    repr-printe"."""

    def __init__(self, el_id):
        self._openstat_el_id = el_id
        # Python-sidens speil av class-settet - add_class/remove_class
        # (under) må kjenne HELE det gjeldende settet for å kunne sende
        # en fullstendig erstatnings-streng til elSetProps (JS eier ikke
        # et strukturert class-sett, bare selve attributt-STRENGEN).
        self._classes = set()

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


def _tag_builder(tag):
    """Fabrikk: bygg en `f(*children, **kwargs) -> Element`-funksjon for
    én HTML-tag - selve elementet opprettes JS-side (Ui.elCreate) med de
    normaliserte kwargs-ene (_normalize_kwargs), barn appendes
    (_append_children), on_<event>=callable-oppføringer bindes
    (Element.on)."""
    def _build(*children, **kwargs):
        norm, handlers, warnings = _normalize_kwargs(kwargs)
        for w in warnings:
            _warn(w)
        u = _ui()
        el_id = None
        if u is not None:
            try:
                el_id = u.elCreate(tag, json.dumps(norm))
            except Exception:
                el_id = None
        el = Element(el_id)
        cls_attr = norm.get("attrs", {}).get("class")
        if cls_attr:
            el._classes.update(str(cls_attr).split())
        if children:
            el.add(*children)
        for event, handler in handlers:
            el.on(event, handler)
        return el
    return _build


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
