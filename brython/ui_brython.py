"""ui - Brython-fasade for notebook-widgets (spec 2026-07-15-notebook-widgets-design.md, W2).

Speiler pyodide/ui.py NØYAKTIG (samme offentlige API, samme fallback-
semantikk): hvert `ui.*`-kall bygger en kontrollspec og sender den over
grensen som JSON til `window.Ui.registerControl(...)` (js/ui.js). JS-siden
EIER verdien - `ui.*` returnerer den gjeldende LAGREDE verdien for
kontrollen, ikke nødvendigvis det scriptet nettopp sendte inn som `value=`.

Brython/MicroPython kjører på hovedtråden (ikke i en worker slik webR gjør),
så `registerControl` kan kalles synkront akkurat som i pyodide - se
`brython/dash.py` (`window.Dash`) for presedens på dette mønsteret.

Widgets krever i dag en aktiv notatbok-kjørekontekst (satt av
`Ui.beginCellRun`) for at kontrollen faktisk skal registreres og tegnes.
Brython/MicroPython-motorene har IKKE notatbok-cellestøtte ennå (kommer i
en senere fase) - `SEG_MARKER` (js/cells.js) mangler brython/micropython,
så en notatbok-celle i disse modusene blir i dag blanket i stedet for
kjørt. Følgelig finnes det ingen aktiv kjørekontekst å registrere en
kontroll mot, og `registerControl` returnerer null uansett - hvert
`ui.*`-kall faller derfor ALLTID tilbake til sin dokumenterte deterministiske
default (under, per funksjon). Dette er IKKE en feil eller midlertidig
begrensning i denne fila - det er den korrekte oppførselen inntil
notatbok-cellestøtte finnes for disse motorene. API-et er likevel identisk
med pyodide-varianten, slik at kode kan porteres uendret den dagen støtten
kommer.

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
    """Glidebryter. Fallback (ingen notatbok-støtte): value hvis gitt, ellers min."""
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
