"""ui - MicroPython-fasade for notebook-widgets (spec 2026-07-15-notebook-widgets-design.md, W2).

Divergerende kopi av brython/ui_brython.py (samme dag som denne fila ble
laget, Task 3 W2) - speiler pyodide/ui.py NØYAKTIG (samme offentlige API,
samme fallback-semantikk). Kjører under unix-micropython/wasm-micropython
(Task 3-motoren, js/micropython-engine.js), IKKE under Brython - eneste
dialektforskjell mot brython/ui_brython.py er importen:
`from js import window` (MicroPython-motoren eksponerer window på
`js`-modulen/jsffi, ikke `browser`-modulen som Brython gjør) - se
micropython/dash.py sin filhode-kommentar for samme fella dokumentert for
dash-adapteren.

Hvert `ui.*`-kall bygger en kontrollspec og sender den over grensen som
JSON til `window.Ui.registerControl(...)` (js/ui.js). JS-siden EIER
verdien - `ui.*` returnerer den gjeldende LAGREDE verdien for kontrollen,
ikke nødvendigvis det scriptet nettopp sendte inn som `value=`.

MicroPython kjører på hovedtråden (som Brython, ikke i en worker slik webR
gjør), så `registerControl` kan kalles synkront akkurat som i pyodide/
Brython - se micropython/dash.py (`window.Dash`) for presedens.

Fase C (spec 2026-07-16): motoren HAR notatbok-cellestøtte - under
per-celle-kjøring/Kjør alle setter index.html kjørekonteksten
(Ui.beginCellRun), og registerControl registrerer/tegner kontrollen
akkurat som i pyodide-modus (samme pull-modell; hovedtråd = synkron
lesing). Utenfor en notatbok-kjørekontekst (vanlige scripts) returnerer
registerControl fortsatt null, og hvert ui.*-kall faller da tilbake til
sin dokumenterte deterministiske default (under, per funksjon).

Kritisk FFI-detalj: Brython 3.12 er verifisert til IKKE å konvertere en
ekte JS `null` til Python `None` over grensen (se brython/duckdb_brython.py,
js/brython-engine.js) - MicroPythons jsffi-lag er en annen implementasjon
og har IKKE blitt verifisert til å oppføre seg likt (ingen eksisterende
kode i denne motoren har trengt å skille "ekte JS null" fra "Python None"
til nå). `_register` under bruker likevel `not raw` (ikke `raw is None`)
som en robust falsy-sjekk uansett hvilken sentinel jsffi faktisk gir
tilbake for null - samme forsiktighetsprinsipp som pyodide/ui.py sin
post-fix-versjon, og med samme begrunnelse: en `raw is None`-sjekk som
bommer på en falsy-ikke-None-sentinel ville gitt en TypeError i
json.loads i stedet for korrekt fallback til default.

Denne fila lastes lat av js/micropython-engine.js sin LIB_REGISTRY (nøkkel
`ui_mpy`, alias `ui`) - speiler mønsteret til `numpy_brython`/`numpy` i
Brython-registeret (filnavnet, og dermed registry-nøkkelen, skiller seg
fra det offentlige importnavnet, løst via alias-mekanismen)."""
from js import window                # MicroPython: js-modulen (jsffi)
import json
import sys                           # _format_exc: sys.print_exception (ekte mpy)


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

    `not raw` (ikke `raw is None`) med vilje - se filhode-kommentaren om
    jsffi sin null-semantikk (uverifisert, men samme forsiktige mønster som
    brython/ui_brython.py og pyodide/ui.py brukes uansett)."""
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
    Samme oppskrift som brython/ui_brython.py og pyodide/dash.py sin
    _scalar - MEN med en MicroPython-dialektfelle rettet (funnet i
    browserverifisering, Task 3): `type(value).__module__` KASTER
    AttributeError for MicroPythons innebygde typer (`type(1).__module__`
    finnes ikke - i motsetning til CPython/Brython/pyodide, der ALLE
    typer, også innebygde, har `.__module__`). En vanlig `ui.slider(1, 10,
    value=4)`-kall (heltall, ingen numpy involvert) krasjet derfor med
    AttributeError i stedet for å bare returnere verdien uendret.
    `getattr(type(value), "__module__", None)` unngår krasjet uten å endre
    oppførselen i noen annen motor (CPython/Brython gir uansett strengen
    tilbake der attributten finnes)."""
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

    placement (Task 3, per-kontroll plassering) er en ren gjennomstrøms-
    kwarg her - selve valideringen ("top"/"bottom"/"left", ellers advarsel +
    ignorert) skjer på JS-siden (js/ui.js sin normalizeSpec), akkurat som
    rerun allerede er. None (ikke gitt) droppes av løkka under som vanlig,
    og kontrollen faller da tilbake til cellens widgets=-default."""
    spec = {"type": type_}
    for k, v in kwargs.items():
        if k in ("min", "max", "value", "step"):
            v = _scalar(v)
        if v is not None:
            spec[k] = v
    return spec


def _num(value):
    """JSON-tall -> int hvis heltallig, ellers float (dokumentert
    returtype for slider/number er int|float).

    `f == int(f)` i stedet for `f.is_integer()` (som pyodide/ui.py og
    brython/ui_brython.py sin tvilling bruker) - browserverifisert
    (Fase C, Task 6): ekte MicroPython (i motsetning til CPython/Brython)
    mangler `float.is_integer()`, så et helt ordinært `ui.slider(1, 20,
    value=5)`-kall i en faktisk kjørende notatbokcelle krasjet med
    AttributeError. `==` er en universell sammenligning som virker
    identisk i alle tre motorene."""
    if value is None or isinstance(value, bool):
        return value
    f = float(value)
    return int(f) if f == int(f) else f


def _event_payload(res, out_text):
    """Klassifiser (returverdi, stdout) -> payload-dict for
    Ui.renderEventResult (W5.2). Som pyodide/ui.py sin _event_payload,
    med ETT dokumentert avvik (delt med brython-fasaden): to_html()
    kalles uten border=0 - denne motorens DataFrame.to_html tar ingen
    kwargs (browser-verifisert i W5-exit-gate; pyodide har ekte pandas
    og beholder border=0). (Fasadene er divergente kopier per
    konvensjon - builder-dedup er et eksisterende backlog-punkt.)"""
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


def _format_exc(e):
    """Traceback-tekst på begge dialekter - mirror av
    micropython/micropython_runner.py sin _format_exc (samme begrunnelse):
    ekte MicroPython (unix/wasm) mangler `traceback`-modulen helt
    (browser-verifisert), men har `sys.print_exception(e, stream)`. CPython
    (pytest) har `traceback.format_exc()`, ikke `sys.print_exception`. Gir
    en ikke-tom streng i begge dialekter."""
    if hasattr(sys, 'print_exception'):        # MicroPython
        import io
        buf = io.StringIO()
        sys.print_exception(e, buf)
        return buf.getvalue()
    import traceback                            # CPython (pytest)
    return traceback.format_exc()


def _make_event_wrapper(handler):
    """Wrapperen JS faktisk kaller: JSON-event inn, payload-JSON ut.
    Fanger ALLE unntak -> {"kind":"error"}. Kontrakt: handler tar ALLTID
    ett argument (event-dicten) - ingen aritetssniffing (spec-avgjørelse).

    INGEN sys.stdout-bytte (i motsetning til pyodide/ui.py og
    brython/ui_brython.py): ekte MicroPython tillater ikke det
    (fase 0-funn c_sys_stdout_assign, se micropython/dash.py sin
    filhode-kommentar). I stedet brukes motorens delte utskriftsbuffer via
    window.__mpyCaptureStart()/__mpyCaptureEnd() (js/micropython-engine.js)
    - DESTRUKTIVT, må kalles NØYAKTIG én gang per invokasjon. Samme
    nøstede try/finally-struktur som micropython/dash.py sin _run()
    (~L536-575, inkl. gjenutgitt reentrancy-fiks): __mpyCaptureEnd() kalles
    i en `finally` rundt BARE selve handler-kallet, mens payload-byggingen
    ligger INNE i den ytre try-en (ikke i en `else`-klausul) - en `else`
    ville aldri blitt fanget av samme try sitt `except BaseException`,
    så unntak fra _event_payload selv (f.eks. en to_html() som kaster)
    ville da propagert ukontrollert i stedet for å bli et {"kind":"error"}.

    CPython-testvakt: `window is None` under pytest (ingen ekte mpy-motor
    - se brython/tests-mønsteret der window monkeypatches til None) faller
    tilbake til et vanlig StringIO-bytte av sys.stdout, slik at
    klassifiserings-/feilstiene i _event_payload lar seg teste meningsfullt
    under CPython. Ekte mpy: window er ALLTID satt (motoren eksponerer
    __mpyCaptureStart/__mpyCaptureEnd globalt på window), så denne grenen
    tas aldri i en faktisk kjørende notatbok."""
    def _wrapper(event_json):
        if window is None:
            import io
            buf = io.StringIO()
            old = sys.stdout
            sys.stdout = buf
            try:
                try:
                    evt = json.loads(event_json) if event_json else {}
                    res = handler(evt)
                finally:
                    sys.stdout = old
                    out_text = buf.getvalue()
                p = _event_payload(res, out_text)
                return json.dumps(p) if p is not None else '{}'   # tom payload -> JS no-op
            except BaseException as e:
                return json.dumps({"kind": "error", "text": _format_exc(e)})
        window.__mpyCaptureStart()
        try:
            try:
                evt = json.loads(event_json) if event_json else {}
                res = handler(evt)
            finally:
                # __mpyCaptureEnd() splitter (destruktivt) fra motorens
                # buffer - må kalles NØYAKTIG én gang. Denne finally
                # garanterer det uansett om handler-kallet lykkes eller
                # kaster, før resten av try (payload-byggingen) får
                # forsøke å bruke teksten.
                out_text = window.__mpyCaptureEnd()
            p = _event_payload(res, out_text)
            return json.dumps(p) if p is not None else '{}'   # tom payload -> JS no-op
        except BaseException as e:
            return json.dumps({"kind": "error", "text": _format_exc(e)})
    return _wrapper


def _alias_rerun(rerun, alias):
    """W5.1 (spec 2026-07-16-notebook-widget-events): on_click=/on_change=
    er kanoniske aliaser for rerun= - aliaset vinner når begge er satt
    (dokumentert kontrakt, ingen advarselskanal i v1)."""
    return alias if alias is not None else rerun


def slider(min=0, max=100, *, value=None, step=1, label=None, name=None, rerun='self', on_change=None, placement=None):
    """Glidebryter. Fallback (ingen notatbok-støtte): value hvis gitt, ellers min.
    on_change= er kanonisk alias for rerun= (W5.1) - aliaset vinner."""
    rerun = _alias_rerun(rerun, on_change)
    spec = _spec("slider", min=min, max=max, value=value, step=step,
                 label=label, name=name, rerun=rerun, placement=placement)
    result = _register(spec)
    if result is None:
        return _scalar(value) if value is not None else _scalar(min)
    return _num(result)


def dropdown(options, *, value=None, label=None, name=None, rerun='self', on_change=None, placement=None):
    """Nedtrekksmeny. Fallback: value hvis gitt, ellers første valg.
    on_change= er kanonisk alias for rerun= (W5.1) - aliaset vinner."""
    rerun = _alias_rerun(rerun, on_change)
    options = list(options)
    if not options:
        raise ValueError("ui.dropdown: options kan ikke være en tom liste.")
    spec = _spec("dropdown", options=[str(o) for o in options], value=value,
                 label=label, name=name, rerun=rerun, placement=placement)
    result = _register(spec)
    if result is None:
        return str(value) if value is not None else str(options[0])
    return str(result)


def checkbox(label=None, *, value=False, name=None, rerun='self', on_change=None, placement=None):
    """Avkrysningsboks. Fallback: value.
    on_change= er kanonisk alias for rerun= (W5.1) - aliaset vinner."""
    rerun = _alias_rerun(rerun, on_change)
    spec = _spec("checkbox", value=bool(value), label=label, name=name, rerun=rerun, placement=placement)
    result = _register(spec)
    if result is None:
        return bool(value)
    return bool(result)


def switch(label=None, *, value=False, name=None, rerun='self', on_change=None, placement=None):
    """Bryter (samme semantikk som checkbox, annen visning). Fallback: value.
    on_change= er kanonisk alias for rerun= (W5.1) - aliaset vinner."""
    rerun = _alias_rerun(rerun, on_change)
    spec = _spec("switch", value=bool(value), label=label, name=name, rerun=rerun, placement=placement)
    result = _register(spec)
    if result is None:
        return bool(value)
    return bool(result)


def number(value=0, *, min=None, max=None, step=None, label=None, name=None, rerun='self', on_change=None, placement=None):
    """Tallfelt. Fallback: value.
    on_change= er kanonisk alias for rerun= (W5.1) - aliaset vinner."""
    rerun = _alias_rerun(rerun, on_change)
    spec = _spec("number", value=value, min=min, max=max, step=step,
                 label=label, name=name, rerun=rerun, placement=placement)
    result = _register(spec)
    if result is None:
        return _scalar(value)
    return _num(result)


def text(value='', *, label=None, name=None, rerun='self', on_change=None, placement=None):
    """Tekstfelt. Fallback: str(value) - returtypen er alltid str
    (speiler dash.py sin textfield(default=str(default))).
    on_change= er kanonisk alias for rerun= (W5.1) - aliaset vinner."""
    rerun = _alias_rerun(rerun, on_change)
    spec = _spec("text", value=str(value), label=label, name=name, rerun=rerun, placement=placement)
    result = _register(spec)
    if result is None:
        return str(value)
    return str(result)


def button(label, *, rerun='self', on_click=None, name=None, placement=None):
    """Trykknapp. Returnerer alltid None - selve klikket trigger en rerun
    av målcellen (js/ui.js), ikke en verdi å lese ut.
    on_click= er kanonisk alias for rerun= (W5.1) - aliaset vinner."""
    rerun = _alias_rerun(rerun, on_click)
    spec = _spec("button", label=label, name=name, rerun=rerun, placement=placement)
    _register(spec)
    return None


def on(selector, event, handler, *, target=None):
    """Bind en python-funksjon til en HTML-event på et vilkårlig
    DOM-element (typisk i en #%% html-celle). handler(evt) kalles med
    event-dicten; returverdien rendres (tekst -> <pre>, DataFrame ->
    tabell, plotly-figur -> graf) i target-id-en, eller appendes i
    cellens output-slot når target utelates. Utenfor nettleser: no-op.

    INGEN create_proxy her (som i brython/ui_brython.py, i motsetning til
    pyodide/ui.py): MicroPython-funksjoner er jsffi-kallbare direkte over
    grensen - samme presedens som micropython/dash.py sin _add_func()/
    controls() (on_change sendes rått til window.Dash.addCard/
    addControls, se ~L491)."""
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
