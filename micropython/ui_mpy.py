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
fra det offentlige importnavnet, løst via alias-mekanismen).

#tag.import-avviket (ui-html-fasen, Task 4, spec §4) - VIKTIG, verifisert
via KILDEINSPEKSJON (ikke gjetning) av micropython_runner.py sin egen
modul-registreringsmekanisme (`_register_module`/`_Mod`, linje ~176-202
der): MicroPython "kan ikke lage types.ModuleType-instanser" (den filas
egen kommentar) - `sys.modules['ui']` er derfor IKKE et ekte modulobjekt,
men en `_Mod`-wrapper hvis `__getattr__(self, k)` gjør et FLATT oppslag
(`self._g[k]`) i eksekverings-globals-dicten. Den kaller ALDRI en
funksjon bokstavelig navngitt `__getattr__` som er DEFINERT INNI den
dicten som en PEP 562-fallback - modul-nivå `__getattr__` (slik
pyodide/ui.py og brython/ui_brython.py bruker for `ui.sl`/`ui.pico`/
`ui.<generisk navn>`) FUNGERER DERFOR IKKE her, strukturelt, uavhengig av
hvilken MicroPython-VERSJON som kjører. Løsning (spec sin eksplisitt
sanksjonerte fallback): `sl`/`pico` er FORHÅNDSINSTANSIERTE ekte
modul-attributter her (finnes direkte i `_Mod._g`, ingen `__getattr__`-
fallback nødvendig for DEM) - selve importert-gaten flyttes til
`_LibNamespace`/`_PicoNamespace` sin EGEN (instans-nivå, helt ordinær
Python-attributt-)`__getattr__`, som IKKE har dette problemet (det er
almindelig OOP-instans-`__getattr__`, ikke modul-nivå PEP 562) - gaten
fyrer da ved `ui.sl.<name>`/`ui.pico.<name>`, ikke ved selve `ui.sl`/
`ui.pico`-oppslaget (dokumentert avvik fra spec sin idelle "raises at
ui.<navn>"-ordlyd). Generiske `#tag.import = <url> as navn`-navnerom KAN
IKKE nås via `ui.<navn>` i det hele tatt her (ingen måte å forhånds-
instansiere et navn som ikke er kjent når denne fila lastes) - de er KUN
nåbare via `ui.lib("navn")` (en vanlig funksjon, ikke et attributtoppslag
- ingen modul-`__getattr__` involvert)."""
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
    _make_event_wrapper for capture-par/stdout-fangst + feil->error-
    payload, akkurat som ui.on()/run_cell() gjør.

    INGEN create_proxy her (dialektavvik fra pyodide/ui.py, spec: "no
    create_proxy — brython/mpy functions are jsffi-callable directly"):
    samme presedens som on()/run_cell() under - en MicroPython-funksjon
    sendes rått over grensen (jsffi)."""
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
    har ingen lagret verdi) - (derfor kan heller ikke ui.widget()
    adressere knapper)."""
    rerun = _alias_rerun(rerun, on_click)
    spec = _spec("button", label=label, name=name, rerun=rerun, placement=placement)
    _register_value(spec, on_click)
    return None


def run_button(label="Kjør", *, target="all", name=None, placement=None):
    """ui.run_button() - felles kjør-knapp for kontrollstripen (brukerønske
    2026-07-18): ÉN knapp som kjører target (default "all" = hele
    dokumentet; ellers en celle-id eller liste av id-er) i stedet for én
    knapp per widget. Ren sukker over ui.button(label, on_click=target) -
    samme knapp-mekanikk, samme None-retur, samme "knapper har ingen
    verdi"-regler (inkl. at ui.widget() ikke kan adressere den)."""
    return button(label, on_click=target, name=name, placement=placement)


def play(min, max, *, value=None, step=1, interval=600, loop=False, label=None,
         name=None, rerun='self', on_change=None, placement=None, sync_to=None):
    """Avspillings-glidebryter (dash-absorpsjon 5a Task 3, spec §3 - dash sin
    play()-widget, absorbert): som slider, men med en innebygd play/pause-
    knapp (js/ui.js sin _buildPlay) som stepper value+step per interval-ms,
    med dash sin EKSAKTE tre-veis timerhygiene (pause-klikk/manuell slider-
    endring/frakoblet-i-selve-tick-en - se der). interval gulves til 200ms;
    loop=True wrapper til min ved max i stedet for å stoppe.

    Fallback (ingen notatbok): value hvis gitt, ellers min - samme regel som
    slider(). on_change= er kanonisk alias for rerun= (W5.1) - aliaset
    vinner. on_change= kan OGSÅ være en python-callable: da bindes den som
    en handler (kontrollen rerunner ALDRI via rerun=) - men HVER tick fyrer
    likevel handleren, akkurat som en manuell brukerendring ville gjort
    (js/ui.js sin _wireChange/_buildPlay: "hver tick går gjennom SAMME sti
    som en brukerendring").
    sync_to= pusher verdien inn i live-sesjonsvariabelen ved hver
    endring/tick, uten rerun."""
    rerun = _alias_rerun(rerun, on_change)
    spec = _spec("play", min=min, max=max, value=value, step=step,
                 interval=interval, loop=bool(loop), label=label, name=name,
                 rerun=rerun, placement=placement, sync_to=sync_to)
    result = _register_value(spec, on_change)
    if result is None:
        return _scalar(value) if value is not None else _scalar(min)
    return _num(result)


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


def value(name):
    """ui.value(name) (spec §3) - gjeldende LAGREDE verdi for kontrollen
    `name`, hvor som helst i dokumentet, UTEN å kjøre noe (rent synkront
    oppslag i js/ui.js sitt verdilager via Ui.value - se der for
    "siste registrerte vinner ved duplikate navn"-regelen + console.warn).

    None ved: ingen window/Ui (ikke i nettleser/ikke lastet ennå), ukjent
    navn, ELLER en ekte JS `null` (Ui.value returnerer JS `null` for et
    ukjent navn). Merk at Ui.value returnerer den RÅ verdien direkte
    (ikke en JSON-streng slik registerControl gjør) - ingen json.loads
    her.

    Dialektavvik fra pyodide/ui.py OG brython/ui_brython.py (browser-
    verifisert 2026-07-17, Task 3-browserverifisering): en RÅ JS `null`
    KRYSSER til Python `None` over MicroPythons jsffi-grense (i motsetning
    til Brython, der den blir en instans av det interne `NullType`-
    duck-type-sentinelet - se ui_brython.py sin _is_js_null - og i
    motsetning til pyodide, der den blir en `pyodide.ffi.JsNull`-instans).
    `raw is None` alene er derfor TILSTREKKELIG her - ingen ekstra
    sentinel-type-sjekk nødvendig (til forskjell fra de to andre
    fasadene, som begge trenger en slik sjekk fordi deres broer IKKE
    konverterer null til None)."""
    u = _ui()
    if u is None:
        return None
    try:
        raw = u.value(str(name))
    except Exception:
        return None
    if raw is None:
        return None
    return raw


# Brython-felle (samme dialektforsiktighet som brython/ui_brython.py - se
# der + test_brython_scoping_trap.py - ikke verifisert i ekte MicroPython,
# men fasadene er byte-mirror-tvillinger og betaler ingenting for å dele
# aliaset): en METODE som refererer en global funksjon med SAMME navn som
# METODEN er en no-op-felle i Brython. WidgetHandle.value (under) kaller
# derfor denne ikke-kolliderende aliasen i stedet for value(...) direkte.
_value = value


# ══════════════════════════════════════════════════════════════════════════
# ui.widget("navn") - håndtak til en ALLEREDE DEKLARERT kontroll
# (dash-absorpsjon 5a Task 2, speiler pyodide/ui.py BYTE FOR BYTE - se der
# for den fulle arkitektur-kommentaren. Eneste dialektavvik: INGEN
# create_proxy (MicroPython-funksjoner er jsffi-kallbare direkte over
# grensen, som resten av denne fila allerede gjør for on()/run_cell()/
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
        _value (Brython-felle-aliaset over), ikke value(...) direkte."""
        return _value(self._name)

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

        INGEN create_proxy her (dialektavvik fra pyodide/ui.py) -
        MicroPython-funksjoner er jsffi-kallbare direkte."""
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


def widget(name):
    """ui.widget("navn") - håndtaket til en ALLEREDE DEKLARERT kontroll
    (spec §1, dash-absorpsjon 5a Task 2). Ettlinjeregel: ui.slider(...)
    DEKLARERER kontrollen og gir verdien; ui.widget("navn") gir HÅNDTAKET.

    None ved: ingen window/Ui (ikke i nettleser/ikke lastet ennå), ELLER
    ukjent navn (console.warn via broen - "aldri en kastet feil for et
    skrivefeil-navn", speiler resten av fila).

    Knapper kan ALDRI adresseres her: en button har ingen lagret verdi
    (ingen _values-oppføring JS-side, se js/ui.js _lookupKeyByName), så
    ui.widget("knappnavn") returnerer alltid None med "ukjent navn"-
    varselet."""
    u = _ui()
    if u is None:
        return None
    try:
        key = u.widgetLookup(str(name))
    except Exception:
        return None
    if not key:
        _warn('ui.widget: ukjent navn "' + str(name) + '"')
        return None
    return WidgetHandle(str(name), str(key))


# ══════════════════════════════════════════════════════════════════════════
# ui.html - element-byggere (ui-html-fasen, Task 3, speiler pyodide/ui.py
# sin Task 2-seksjon BYTE FOR BYTE - se der for den fulle arkitektur-
# kommentaren. Eneste dialektavvik: INGEN create_proxy noe sted
# (MicroPython-funksjoner er jsffi-kallbare direkte over grensen, som
# resten av denne fila allerede gjør for on()/run_cell()/
# _bind_handler_if_callable).
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
    micropython_runner.py sin `_fmt` display-krok bruker (spec §2) til å
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
        (Ui.elOn) - samme wrapper-konvensjon (capture-par/stdout-fangst,
        feil->error-payload) som ui.on()/run_cell() bruker for
        HTML-celle-events.

        INGEN create_proxy her (dialektavvik fra pyodide/ui.py) -
        MicroPython-funksjoner er jsffi-kallbare direkte."""
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
    """_scalar(v), MEN NaN/±Infinity → None (samme regel som
    micropython/dash.py sin _number_payload: json.dumps av NaN/Infinity gir
    literal NaN/Infinity-tokens som knekker JSON.parse i JS - ui.kpi sine
    value=/delta=/ref= er alle DIREKTE brukerverdier, ikke forhånds-sjekket
    av noen add()-dispatch slik dash sin _payload() gjorde det)."""
    v = _scalar(v)
    if isinstance(v, float) and (v != v or abs(v) == float("inf")):
        return None
    return v


def kpi(value, delta=None, *, unit=None, fmt=None, ref=None, bra="opp", label=None):
    """ui.kpi(...) -> Element (dash-absorpsjon 5a Task 3, spec §2 - dash sin
    'number'-payload/dashboard.add(tall)-kort, som en EGEN Element-bygger i
    stedet for en add()-dispatch): kort-node med verdi/enhet/delta.

    delta= er DIREKTE-formen (forrang når gitt); ref= beregner delta MOT en
    referanseverdi (dash sin regel: diff = value - ref). bra= ("opp"/"ned")
    avgjør hvilken retning som fargelegges "god" (js/ui.js sin
    deltaFromDiff). Bygget via Ui.elPayload (kind "kpi") - SAMME
    rendrings-vokabular som en ui.on()-handler sin returverdi (et tall)
    rendres med."""
    payload = {"kind": "kpi", "value": _clean_num(value)}
    if unit is not None:
        payload["unit"] = str(unit)
    if fmt is not None:
        payload["fmt"] = str(fmt)
    if label is not None:
        payload["label"] = str(label)
    if delta is not None:
        payload["delta"] = _clean_num(delta)
    elif ref is not None:
        payload["ref"] = _clean_num(ref)
    if bra is not None:
        payload["bra"] = str(bra)
    return _payload_element(payload)


def markdown(text):
    """ui.markdown(text) -> Element (<div class="ui-md"> via mdToHtml,
    JS-side - samme markdown-renderer ui.on()-handlere sin markdown-
    payload bruker; uten markdown-it lastet faller Ui.renderPayload
    tilbake til ren <pre>, se der)."""
    return _payload_element({"kind": "markdown", "text": str(text)})


def _figure_spec(x):
    """Duck-typet plotly-figur-gjenkjenning - PORTERT ORDRETT fra
    micropython/dash.py sin _figure_spec (samme presedens/rekkefølge, se
    der for hvorfor to_plotly_json_str() sjekkes FØRST:
    plotly_express_mpy.PlotlyFigure har VERKEN to_plotly_json() NOR
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
    plotly_express_mpy sin figur-shim rasteriserer aldri noe - PORTERT fra
    micropython/dash.py sin egen håndtering: en slik figur duck-typet via
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
                'HTML_TAGS-listen i micropython/ui_mpy.py (speiler '
                'pyodide/ui.py, som er kopiert fra '
                'code2web/ui.py:4481-4495): ' + HTML_TAGS.strip())
        return _tag_builder(tag)


html = _HtmlNamespace()


# ══════════════════════════════════════════════════════════════════════════
# #tag.import — kuratert register + dynamiske navnerom (ui-html-fasen,
# Task 4). Speiler pyodide/ui.py sin klasser/dicter/feilmeldinger BYTE FOR
# BYTE der det er mulig - se filhodets #tag.import-avviks-kommentar FØRST
# for HVORFOR denne fila ikke kan bruke modul-nivå `__getattr__` (INGEN
# gjetning - verifisert via kildeinspeksjon av micropython_runner.py sin
# `_Mod`-modulwrapper). sl/pico er derfor FORHÅNDSINSTANSIERTE ekte
# modul-attributter (helt nederst i fila), og generiske #tag.import-navn er
# KUN nåbare via ui.lib(navn), ALDRI via ui.<navn>.
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

    Gaten er HER (instans-`__getattr__`, ordinær Python-OOP - IKKE modul-
    nivå PEP 562) - se filhodets #tag.import-avviks-kommentar: dette er
    den ENESTE gaten som fyrer i DENNE fila (ingen modul-`__getattr__`
    finnes). `ui.sl`/`ui.pico` (forhåndsinstansiert under) løses derfor
    alltid til ET objekt - feilen kommer først ved `.knappenavn` (ett
    steg senere enn i pyodide/brython, dokumentert avvik)."""

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


# shoelace sin accepts-whitelist (spec §4, portert ORDRETT fra
# code2web/ui.py:3320-3380 — se pyodide/ui.py for den fulle kommentaren).
_SL_ACCEPTS = {
    "select": ["sl-option"],
    "dropdown": ["sl-menu-item"],
    "button-group": ["sl-button", "button"],
    "card": ["sl-card-header", "sl-card-body", "sl-card-footer",
             "div", "p", "h1", "h2", "h3", "h4", "h5", "h6"],
    "form": ["sl-input", "sl-textarea", "sl-select", "sl-checkbox",
             "sl-radio", "sl-button", "sl-button-group"],
    "dialog": ["sl-dialog-header", "sl-dialog-body", "sl-dialog-footer",
               "div", "p"],
    "tabs": ["sl-tab", "sl-tab-panel"],
    "accordion": ["sl-accordion-item"],
}


# Pico-navnerommet — portert ORDRETT fra code2web/ui.py:3751-3808 (se
# pyodide/ui.py for den fulle "bevisst forenkling"-kommentaren om
# input/textarea/select-placeholder-varten som er DROPPET her med vilje).
PICO_HTML_ELEMENTS = frozenset((
    "button input textarea select form fieldset legend label article aside "
    "footer header main nav section"
).split())

PICO_COMPONENT_CLASSES = {
    "button": "btn", "input": "form-control", "textarea": "form-control",
    "select": "form-control", "checkbox": "form-check-input",
    "radio": "form-check-input", "range": "form-range", "progress": "progress",
    "card": "card", "modal": "modal", "nav": "nav", "accordion": "accordion",
    "tabs": "tabs", "dropdown": "dropdown", "form": "form",
    "fieldset": "fieldset", "legend": "legend", "label": "form-label",
    "group": "form-group", "grid": "grid", "container": "container",
    "article": "article", "aside": "aside", "footer": "footer",
    "header": "header", "main": "main", "section": "section",
}

PICO_UTILITY_CLASSES = {
    "primary": "btn-primary", "secondary": "btn-secondary",
    "contrast": "btn-contrast", "outline": "btn-outline", "ghost": "btn-ghost",
    "small": "btn-sm", "large": "btn-lg", "full": "btn-full",
    "loading": "btn-loading", "disabled": "btn-disabled",
}


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
    _LibNamespace over (den ENESTE gaten i denne fila)."""

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        if not _has_import("pico"):
            raise _not_imported_error("pico")
        return _pico_component(name)


def lib(name):
    """ui.lib(navn) - MicroPython-avviket (se filhodet): dette er den
    ENESTE måten å nå et GENERISK (#tag.import = <url> as navn)
    navnerom på i denne fasaden - `ui.<navn>` attributt-syntaks fungerer
    KUN for sl/pico (forhåndsinstansiert under), ALDRI for et generisk
    navn (ingen modul-`__getattr__` her til å bygge det lazy).

    Dialektavvik fra pyodide/brython: sl/pico-spesialtilfeller returnerer
    de forhåndsinstansierte modul-attributtene (samme semantikk som direkte
    `ui.sl`/`ui.pico`-oppslag), ikke opprett nye _LibNamespace-instanser."""
    name = str(name)
    # Spesialtilfelle sl og pico: returnér de forhåndsinstansierte
    # navnerommene (dialektavvik fra pyodide/brython, der disse går
    # via modul-nivå __getattr__)
    if name == "sl":
        return sl
    if name == "pico":
        return pico
    if not _has_import(name):
        raise _not_imported_error(name)
    return _LibNamespace(name)


# Forhåndsinstansierte modul-attributter (MicroPython-avviket - se
# filhodet) - EKTE nøkler i _Mod sin globals-dict, funnet av `_Mod.
# __getattr__`'s flate `self._g[k]`-oppslag uten noen PEP 562-fallback
# involvert. Selve importert-gaten ligger i _LibNamespace/_PicoNamespace
# sin EGEN __getattr__ (over) - fyrer ved `ui.sl.<navn>`/`ui.pico.<navn>`,
# ikke ved selve `ui.sl`/`ui.pico`-oppslaget.
sl = _LibNamespace("sl", _SL_ACCEPTS)
pico = _PicoNamespace()
