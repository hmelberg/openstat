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
    f.eks. `max=df['x'].max()` (numpy-skalar) overlever json.dumps."""
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


def slider(min=0, max=100, *, value=None, step=1, label=None, name=None, rerun='self'):
    """Glidebryter. Fallback (ingen notatbok): value hvis gitt, ellers min."""
    spec = _spec("slider", min=min, max=max, value=value, step=step,
                 label=label, name=name, rerun=rerun)
    result = _register(spec)
    if result is None:
        return _scalar(value) if value is not None else _scalar(min)
    return _num(result)


def dropdown(options, *, value=None, label=None, name=None, rerun='self'):
    """Nedtrekksmeny. Fallback: value hvis gitt, ellers første valg."""
    options = list(options)
    if not options:
        raise ValueError("ui.dropdown: options kan ikke være en tom liste.")
    spec = _spec("dropdown", options=[str(o) for o in options], value=value,
                 label=label, name=name, rerun=rerun)
    result = _register(spec)
    if result is None:
        return str(value) if value is not None else str(options[0])
    return str(result)


def checkbox(label=None, *, value=False, name=None, rerun='self'):
    """Avkrysningsboks. Fallback: value."""
    spec = _spec("checkbox", value=bool(value), label=label, name=name, rerun=rerun)
    result = _register(spec)
    if result is None:
        return bool(value)
    return bool(result)


def switch(label=None, *, value=False, name=None, rerun='self'):
    """Bryter (samme semantikk som checkbox, annen visning). Fallback: value."""
    spec = _spec("switch", value=bool(value), label=label, name=name, rerun=rerun)
    result = _register(spec)
    if result is None:
        return bool(value)
    return bool(result)


def number(value=0, *, min=None, max=None, step=None, label=None, name=None, rerun='self'):
    """Tallfelt. Fallback: value."""
    spec = _spec("number", value=value, min=min, max=max, step=step,
                 label=label, name=name, rerun=rerun)
    result = _register(spec)
    if result is None:
        return _scalar(value)
    return _num(result)


def text(value='', *, label=None, name=None, rerun='self'):
    """Tekstfelt. Fallback: str(value) - returtypen er alltid str
    (speiler dash.py sin textfield(default=str(default)))."""
    spec = _spec("text", value=str(value), label=label, name=name, rerun=rerun)
    result = _register(spec)
    if result is None:
        return str(value)
    return str(result)


def button(label, *, rerun='self', name=None):
    """Trykknapp. Returnerer alltid None - selve klikket trigger en rerun
    av målcellen (js/ui.js), ikke en verdi å lese ut."""
    spec = _spec("button", label=label, name=name, rerun=rerun)
    _register(spec)
    return None
