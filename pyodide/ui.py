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

I et vanlig script - ingen notatbok, ingen aktiv celle-kjørekontekst -
finnes det ingen `window.mdUiRunCtx()` å registrere kontrollen mot:
`registerControl` returnerer da None (eller `window`/`window.Ui` finnes
ikke i det hele tatt), og hver `ui.*`-funksjon faller tilbake til en
deterministisk default (dokumentert per funksjon under) - ALDRI en feil,
og ingen widget tegnes.

Widgets krever altså en aktiv notatbok + kjørende pyodide (med js/ui.js
lastet og en aktiv celle-kjørekontekst). Denne fila lastes lasy av
__ensureUi (index.html) - speiler pyodide/dash.py sitt mønster: en
`import ui`/`from ui import ...` i en celle trigger henting av denne fila
FØR micropip forsøker å installere den fra PyPI.
"""
import json

try:
    from js import window
except ImportError:      # CPython (pytest uten js-stub, eller ingen browser)
    window = None


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
    returtype for slider/number er int|float)."""
    if value is None or isinstance(value, bool):
        return value
    f = float(value)
    return int(f) if f.is_integer() else f


def _event_payload(res, out_text):
    """Klassifiser (returverdi, stdout) -> payload-dict for
    Ui.renderEventResult (W5.2). Speiler dash.py sin kort-klassifisering
    (figur-ducktyping via to_plotly_json, frame via to_html/columns),
    men som egen kompakt kopi - fasadene er divergente kopier per
    konvensjon (builder-dedup er et eksisterende backlog-punkt)."""
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
    (dokumentert kontrakt, ingen advarselskanal i v1)."""
    return alias if alias is not None else rerun


def slider(min=0, max=100, *, value=None, step=1, label=None, name=None, rerun='self', on_change=None, placement=None):
    """Glidebryter. Fallback (ingen notatbok): value hvis gitt, ellers min.
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
    cellens output-slot når target utelates. Utenfor nettleser: no-op."""
    u = _ui()
    if u is None:
        return None
    binding = {"selector": str(selector), "event": str(event)}
    if target is not None:
        binding["target"] = str(target)
    try:
        from pyodide.ffi import create_proxy
    except ImportError:
        def create_proxy(f):
            return f
    u.bindEvent(json.dumps(binding), create_proxy(_make_event_wrapper(handler)))
    return None


def run_cell(selector, event, cell_id):
    """Kjør en navngitt celle (id= i #%%-headeren) når HTML-eventen
    fyrer - cellevarianten av on() (eget navn, ingen overloading)."""
    u = _ui()
    if u is None:
        return None
    u.bindRunCell(json.dumps({"selector": str(selector), "event": str(event), "cellId": str(cell_id)}))
    return None
