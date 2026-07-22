"""ui_core - delt fasadekjerne for pyodide/brython/micropython (fase 3,
spec 2026-07-20 §Phase 3 revidert). KUN dialektfri kode: aldri import av
js/browser/jsffi, aldri direkte window-referanse. Dialekt-symboler
injiseres av HVER fasade via configure() - kjernefunksjonene slår dem opp
ved KALLTID (sen binding), slik at pytest (én CPython-prosess, tre
fasader) alltid ser den sist konfigurerte fasadens dialekt etter dens
egen (re)import."""

import json

# ---- injiserte dialekt-symboler (settes av configure) -------------------
_register_value = None
_ui = None
# `_warn_sink` (pre-scaffaldet i Task 1, koblet til FØRST nå i Task 3): EN
# fasade-lokal BRO-funksjon (`def _warn_sink(msg): _warn(msg)`), ALDRI
# flyttet - se widget()/_append_children()/_tag_builder() under, som alle
# kaller `_warn_sink(...)`, IKKE bare `_warn(...)`. Grunnen er sen binding
# + pytest sin monkeypatch-vane (`monkeypatch.setattr(mod, "_warn", ...)`,
# testene): widget/_append_children/_tag_builder er NÅ flyttet til DENNE
# fila, så et bart `_warn(...)`-kall INNI dem ville løst seg mot DENNE
# filas EGNE `_warn`-global (satt av configure(warn_sink=...) sin
# nabo-mekanisme ELLER av rebind-linja `_warn = _core._warn` i fasaden -
# uansett en SNAPSHOT tatt VED configure()-kalltidspunktet), og ville
# ALDRI se en test sin ETTERFØLGENDE ombinding av fasadens EGEN `_warn`-
# navn. `_warn_sink` derimot BLIR i fasaden - dens `_warn(msg)`-kall er et
# FRISKT globalt oppslag i FASADENS EGET navnerom hver gang den kalles
# (samme trick som `_ui()` sitt `window.Ui`-oppslag alt brukte for
# `window`-monkeypatching) - se task-3-report.md for full utledning.
_warn_sink = None
_scalar = None
# Task 3 (fase 3): resten av dialektsymbolene run_button/play/run_cell/
# widget/_append_children/kpi/markdown/_tag_builder trenger, injisert av
# HVER fasades configure()-kall (se filhode-doc + task-3-report.md).
# `_window` og `_button`/`_widget_handle_cls` er de tre som IKKE allerede
# hadde et understrek-prefikset fasade-lokalt navn å gjenbruke 1:1
# (fasadens `window`/`button`/`WidgetHandle`) - dette er den ENESTE
# grunnen til at disse tre får et kall-sted omdøpt til `_<navn>` inni de
# flyttede funksjonskroppene (se _append_children/_tag_builder/run_button/
# widget under); resten (`_alias_rerun`, `_num`, `_normalize_kwargs`,
# `_clean_num`, `_payload_element`, `_register_value`) var allerede
# understrek-prefikset fasade-lokalt og trengte INGEN omdøping - kroppene
# er der 100% ordrett.
_alias_rerun = None
_num = None
_normalize_kwargs = None
_element_cls = None
_clean_num = None
_payload_element = None
_window = None
_button = None
_widget_handle_cls = None


def configure(**kwargs):
    """Fasaden kaller configure(register_value=..., scalar=..., ...) ved
    import. Idempotent: hvert kall overskriver forrige (riktig under
    pytest der tre fasader deler prosessen og re-importeres per test)."""
    g = globals()
    for k, v in kwargs.items():
        g['_' + k] = v


def _into_el_id(into):
    """fase 4b (spec 2026-07-21): into= aksepterer et Element/container-
    håndtak (duck-typet på _openstat_el_id, samme kontrakt som
    _append_children/index.html sin _show_one bruker for "dette er et
    monterbart element") - hent ut elId-strengen, eller None hvis into=
    ikke ble gitt i det hele tatt. Et objekt UTEN attributtet er en klar
    programmeringsfeil (feil type sendt til into=) -> TypeError HØYT,
    ikke en stille fallback (speiler _register sin egen "userialiserbar
    verdi er en programmeringsfeil"-linje lenger ned i fila)."""
    if into is None:
        return None
    try:
        return into._openstat_el_id
    except AttributeError:
        raise TypeError("into= tar et ui.html-/container-element")


def _handle_from_into(res, name, default):
    """fase 4b: bygg WidgetHandle-retur for into=-kall. res er dict-formen
    fra registerControl ({'__into':..., 'value':..., 'key':..., 'name':...})
    eller None (ingen kjørekontekst) eller en bar skalarverdi (into= ba om
    montering, men JS falt tilbake til stripa - ukjent el-id). default
    huskes for no-context-.value-fallback (se WidgetHandle.value sin
    nøkkel-fallback-gren, mirrored 3x i hver fasade).

    fase 4b Task 3-mikrofiks (avdekket i task-2-rapportens hjørnetilfelle
    #2): når `res` IKKE er None (en ekte kjørekontekst fantes, into= ble
    forsøkt, men selve inn-målet løste seg ikke JS-side - "context exists
    but into-target unresolved"), skal den HUSKEDE verdien være den
    FAKTISK returnerte skalaren (`res`), ikke den frosne spec-defaulten -
    JS-siden har allerede returnert den ekte, LAGREDE kontrollverdien i
    dette tilfellet, og den skal ikke overskygges av value=/min= som ble
    sendt INN. Kun det RENE no-context-tilfellet (res is None, ingen
    kjørekontekst i det hele tatt) beholder den frosne defaulten."""
    if isinstance(res, dict) and res.get("__into"):
        return _widget_handle_cls(res.get("name"), res.get("key"))
    h = _widget_handle_cls(name, None)
    h._fallback_value = default if res is None else res
    return h


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


# Standard HTML-tagger for den generiske ui.html.<tag>(...)-fabrikken.
# Kopiert ORDRETT fra code2web/ui.py:4481-4495 (samme kildeliste spec §1
# selv peker til) - inkludert code2web sin egen duplisering av "table"
# (opptrer både i blokk-elementlisten og tabell-elementlisten under);
# harmløst for __getattr__-oppslaget under (et sett/medlemskapstest bryr
# seg ikke om duplikater i kildestrengen).
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


def _flatten_children(children):
    """Ett flatingsnivå (spec §1, samme regel _append_children bruker
    INNI seg selv - se lenger ned i denne filen) - PUR, ingen injeksjon.
    Flyttet hit (fase 4b, Task 3) i stedet for duplisert 3x fasade-lokalt:
    Element.add sin span=/align=-gren (mirrored 3x, pyodide/ui.py osv.) og
    _render_area_children (samme fasader) bruker den til å finne de
    FAKTISKE barna i et `.add([a, b], span=2)`-/`.add(x, area=...)`-kall."""
    flat = []
    for child in children:
        if isinstance(child, (list, tuple)):
            flat.extend(child)
        else:
            flat.append(child)
    return flat


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


# shoelace sin accepts-whitelist (spec §4, portert ORDRETT fra
# code2web/ui.py:3320-3380 sin `_component_definitions` - samme komponenter,
# samme aksepterte barn-tagger). Nøklene er kebab-navnet (dvs. det som står
# ETTER "sl-" i den fulle tag-strengen / det du skriver som
# ui.sl.button_group(...) -> "button-group"). Komponenter UTENFOR denne
# dicten er "unknown sl-names -> generic sl-*" (spec) - ingen
# barn-validering i det hele tatt, bygges likevel fint via _lib_tag_builder.
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


# Pico-navnerommet (spec §4: "CSS-class mapping onto plain elements -
# inherently curated, not generic") - IKKE en _LibNamespace (Pico er ikke
# custom-elements, bare vanlige HTML-tagger + klasser). Portert ORDRETT
# (samme klassenavn/nøkler - bevisst IKKE "korrigert" mot ekte Pico CSS sin
# faktiske klasseløse konvensjon; spec ber om en PORT av code2web sitt kart,
# ikke en nyskriving) fra code2web/ui.py:3751-3808 sin `_PicoNamespace`.
#
# Bevisst FORENKLING i selve BYGGINGEN (ikke i klassekartet): code2web sin
# variant har en egen "gjett hva det første positional-argumentet betyr"-
# spesialbehandling per komponent (placeholder for input/textarea, en
# disabled/selected <option> for select, ellers textContent) - DROPPET her.
# spec §1 sin "unified kwargs standard (fixes code2web's warts)" definerer
# ÉN generell regel for positional varargs (children - streng blir
# tekstnode, spec §1) som ALLEREDE er den ubetingede oppførselen for
# ui.html/ui.sl/enhver annen ui.<navn> - å la PICO ALENE ha en avvikende
# regel ville brutt "samme element-motor/kwargs-standard for alle" (denne
# task-spec-linja), så Pico sitt EGET bidrag er BARE klassekartleggingen,
# ikke input-gjetting-varten. Dokumentert avvik, ikke en forglemmelse.
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


# ══════════════════════════════════════════════════════════════════════════
# Task 3 (fase 3): resten av det byte-identiske API-settet - funksjoner som
# KALLER fasade-dialekt-symboler (i motsetning til det injeksjonsfrie
# settet over, flyttet i Task 1). Kroppene under er flyttet ORDRETT fra
# pyodide/ui.py (samme tekst, verifisert IDENTISK mot brython/ui_brython.py
# og micropython/ui_mpy.py av task-3-brief.md sitt Step 1-skript) - de tre
# unntakene (`window`->`_window`, `button`->`_button`,
# `WidgetHandle`->`_widget_handle_cls`) er dokumentert i placeholder-
# blokken over. `Element`/`_normalize_kwargs`/`_clean_num`/
# `_payload_element`/`_alias_rerun`/`_num`/`_register_value` FORBLIR
# fasade-lokale (0.9 eller rene AVVIK - IKKE flyttet), injisert som
# placeholders akkurat som `_scalar`/`_ui` allerede var.
#
# EN fjerde, subtil avvik (IKKE i navnet, i KALL-GRAFEN): widget()/
# _append_children()/_tag_builder() under kaller `_warn_sink(...)`, ikke
# bare `_warn(...)`, selv om `_warn` er definert RETT under HER i SAMME
# fil. Se `_warn_sink = None` sin kommentar i placeholder-blokken over for
# hele begrunnelsen (monkeypatch-kompatibilitet på tvers av modulgrensen).
# ══════════════════════════════════════════════════════════════════════════

def _warn(msg):
    """console.warn via broen, GUARDET (ingen window/console i CPython-
    pytest eller et vanlig script uten js/ui.js lastet ennå) - "aldri
    stille, men aldri en krasj for en advarsel" (spec: error handling).

    Selve terminal-implementasjonen (flyttet hit, byte-identisk) - kalt
    fra fasaden via rebind (`_warn = _core._warn`). widget()/
    _append_children()/_tag_builder() under kaller IKKE denne direkte
    (bart `_warn(...)` ville løst seg mot DENNE modulens egen global,
    upåvirket av en fasade-lokal monkeypatch) - de går via `_warn_sink`,
    se placeholder-blokken over."""
    try:
        _window.console.warn(msg)
    except Exception:
        pass


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
        if isinstance(child, _element_cls):
            payload = {"el": child._openstat_el_id}
        elif isinstance(child, (list, tuple)):
            _warn_sink("ui.html: nøstet liste (mer enn ett flatingsnivå) i children - hoppet over")
            continue
        else:
            payload = {"text": str(child)}
        try:
            u.elAppend(el_id, json.dumps(payload))
        except Exception:
            pass


def _tag_builder(tag):
    """Fabrikk: bygg en `f(*children, **kwargs) -> Element`-funksjon for
    én HTML-tag - selve elementet opprettes JS-side (Ui.elCreate) med de
    normaliserte kwargs-ene (_normalize_kwargs), barn appendes
    (_append_children), on_<event>=callable-oppføringer bindes
    (Element.on)."""
    def _build(*children, **kwargs):
        norm, handlers, warnings = _normalize_kwargs(kwargs)
        for w in warnings:
            _warn_sink(w)
        u = _ui()
        el_id = None
        if u is not None:
            try:
                el_id = u.elCreate(tag, json.dumps(norm))
            except Exception:
                el_id = None
        el = _element_cls(el_id, tag=tag)
        cls_attr = norm.get("attrs", {}).get("class")
        if cls_attr:
            el._classes.update(str(cls_attr).split())
        if children:
            el.add(*children)
        for event, handler in handlers:
            el.on(event, handler)
        return el
    return _build


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


def run_button(label="Kjør", *, target="all", name=None, placement=None):
    """ui.run_button() - felles kjør-knapp for kontrollstripen (brukerønske
    2026-07-18): ÉN knapp som kjører target (default "all" = hele
    dokumentet; ellers en celle-id eller liste av id-er) i stedet for én
    knapp per widget. Ren sukker over ui.button(label, on_click=target) -
    samme knapp-mekanikk, samme None-retur, samme "knapper har ingen
    verdi"-regler (inkl. at ui.widget() ikke kan adressere den)."""
    return _button(label, on_click=target, name=name, placement=placement)


def play(min, max, *, value=None, step=1, interval=600, loop=False, label=None,
         name=None, rerun='self', on_change=None, placement=None, sync_to=None,
         into=None):
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
    endring/tick, uten rerun.
    into= (fase 4b): monter kontrollen i et element/container-håndtak i
    stedet for stripa (_into_el_id henter ut elId-en) - da returneres et
    WidgetHandle (_handle_from_into) i stedet for verdien."""
    rerun = _alias_rerun(rerun, on_change)
    into_id = _into_el_id(into)
    spec = _spec("play", min=min, max=max, value=value, step=step,
                 interval=interval, loop=bool(loop), label=label, name=name,
                 rerun=rerun, placement=placement, sync_to=sync_to, into=into_id)
    result = _register_value(spec, on_change)
    if into is not None:
        default = _scalar(value) if value is not None else _scalar(min)
        return _handle_from_into(result, name, default)
    if result is None:
        return _scalar(value) if value is not None else _scalar(min)
    return _num(result)


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
        _warn_sink('ui.widget: ukjent navn "' + str(name) + '"')
        return None
    return _widget_handle_cls(str(name), str(key))


# ══════════════════════════════════════════════════════════════════════════
# Containere - ui.row/ui.column/ui.grid (fase 4b, Task 3, spec
# 2026-07-21-explicit-containers-design.md §Decisions 3-4). Rene funksjoner:
# de bygger et props-dict akkurat som _tag_builder gjør (kwargs -> cls=/
# style=), og kaller SAMME injiserte element-motor-sti (_tag_builder("div"),
# selv definert lenger opp i DENNE filen - bruker _element_cls/_ui/
# _normalize_kwargs/_warn_sink under panseret, allerede injisert av hver
# fasades configure()-kall). Ingen egne nye configure()-placeholdere trengs
# - containerne er 100% bygget av eksisterende injisert maskineri.
#
# `Element.add` sin area=/span=/align=-utvidelse (som LESER `_areas`-dicten
# grid() setter under) er derimot FASADE-SIDE (Element er en fasade-lokal
# klasse, ikke flyttet - se pyodide/ui.py osv.), mirrored 3x der.
# ══════════════════════════════════════════════════════════════════════════

def _parse_grid_template(template):
    """"kpi kpi | plot table" -> {"areas": '"kpi kpi" "plot table"',
    "names": ["kpi", "plot", "table"]} - CSS grid-template-areas-strengen
    (én anførselstegn-kvotert rad per "|"-separert rad, mellomrom skiller
    kolonner INNAD i en rad) + de unike områdenavnene i FØRSTE-SETT-
    rekkefølge (rekkefølgen area-barna i grid() pre-opprettes i, og
    dermed rekkefølgen `_areas`-dicten - og enhver test som lister den ut -
    ser dem i).

    Ragged rader (ulikt antall kolonner mellom rader) -> ValueError med en
    lesbar feiltekst - CSS grid-template-areas KREVER en rektangulær
    matrise (hver kvotert rad-streng må ha samme antall whitespace-
    separerte tokens), en ujevn template er derfor alltid en
    programmeringsfeil, ikke noe å stille falle tilbake fra.

    "." er CSS sin NULL-CELLE-token (grid-template-areas: en celle uten
    noe område - "tomt rom" i mosaikken). Den teller med i bredde-
    sjekken (ragged-valideringen over) og blir stående uendret i
    `areas`-strengen (CSS må se den), men skal ALDRI bli et områdenavn -
    hverken i `names` eller (dermed) som et forhåndsopprettet barn i
    grid() sin `_areas`-dict (Task 3-review, micro-addition 1).

    Pur (ingen injeksjon, ingen sideeffekt) - testet direkte i CPython."""
    rows = [row.split() for row in str(template).split("|")]
    if not rows or any(not cols for cols in rows):
        raise ValueError(
            'ui.grid: tom rad i template "' + str(template) + '" - '
            'hver "|"-separerte rad må ha minst én områdenavn-token')
    width = len(rows[0])
    for cols in rows:
        if len(cols) != width:
            raise ValueError(
                'ui.grid: ujevne rader i template "' + str(template) + '" - '
                'alle rader må ha samme antall kolonner (forventet ' +
                str(width) + ', fikk ' + str(len(cols)) + ' i "' +
                ' '.join(cols) + '")')
    areas = ' '.join('"' + ' '.join(cols) + '"' for cols in rows)
    names = []
    seen = set()
    for cols in rows:
        for name in cols:
            if name == ".":
                continue
            if name not in seen:
                seen.add(name)
                names.append(name)
    return {"areas": areas, "names": names}


def _style_dict_to_css_text(style):
    """{"gridTemplateAreas": '"a" "b"', ...} -> 'grid-template-areas: "a" "b";
    ...' - camelCase-nøkler til kebab-case CSS-egenskapsnavn (motsatt
    retning av _snake_to_camel), semikolon-separert. Brukt AV
    _merge_container_style sin grid-raw-style-fiks (Task 1, fase-4
    sluttreview L-3) til å uttrykke den beregnede grid-template-dicten som
    cssText-tekst, slik at den kan APPENDES til en brukergitt rå
    style=-streng i stedet for å bli erstattet av den."""
    parts = []
    for key, value in style.items():
        kebab = "".join("-" + c.lower() if c.isupper() else c for c in key)
        parts.append(kebab + ": " + str(value) + ";")
    return " ".join(parts)


def _merge_container_style(base_cls, style, kwargs):
    """Delt hale for row()/column()/grid(): slå den BEREGNEDE style-dicten
    (gap=/wrap=/justify=/align= for row/column, gridTemplate*=/gap= for
    grid) sammen med et ev. brukergitt style=-kwarg (dict merges nøkkel for
    nøkkel, brukerens SNAKE_CASE-nøkler camelCases som vanlig via
    _snake_to_camel - samme regel _normalize_kwargs allerede bruker for
    style=; en RAW cssText-streng derimot ERSTATTER den beregnede dicten
    her (de to formene lar seg ikke slå sammen på DENNE generelle
    funksjonen). For row()/column() er det greit (der finnes ingen
    positional template å miste). grid() unngår tapet ved å APPENDE de
    beregnede grid-template-deklarasjonene til en rå style=-streng FØR den
    når hit (se grid() sin egen docstring/kode) - kwargs["style"] er da
    allerede den ferdig-supplerte strengen når _merge_container_style ser
    den, så erstatningen under er fortsatt trygg.

    cls=/class_= merges til `base_cls` (BASE_KLASSEN FØRST, brukerens
    EKSTRA klasse(r) etter - samme "siste vinner ved kollisjon"-konvensjon
    som _normalize_kwargs sin cls-vs-class_-håndtering, men her er det en
    APPEND, ikke en erstatning - den kuraterte layout-klassen (os-row/
    os-col/os-grid) skal ALLTID være med).

    Muterer og returnerer `kwargs` (kalleren sender inn sin egen ferske
    **kwargs-dict, aldri en delt en) - kwargs går videre INN i
    _tag_builder("div")(**kwargs), som selv kjører _normalize_kwargs på
    den."""
    user_style = kwargs.pop("style", None)
    if isinstance(user_style, dict):
        style = dict(style)
        style.update({_snake_to_camel(k): v for k, v in user_style.items()})
    elif user_style is not None:
        style = user_style
    cls = kwargs.pop("cls", None)
    class_ = kwargs.pop("class_", None)
    if cls is not None and class_ is not None:
        # Task 4-review micro-addition 2: warn via _warn_sink (mirroring
        # _normalize_kwargs sin cls-vs-class_-advarsel, se der) - class_
        # er allerede POPPET her (før _tag_builder/_normalize_kwargs ser
        # kwargs), så DEN advarselen ville aldri trigge for containere
        # uten dette. cls= vinner her (ikke "siste i kallrekkefølge" -
        # begge er separate navngitte parametre, ingen kallrekkefølge å
        # observere), til forskjell fra _normalize_kwargs sin regel.
        _warn_sink(
            "ui.row/column/grid: bade cls= og class_= angitt - cls= vinner (class_= ignorert)"
        )
    user_cls = cls if cls is not None else class_
    kwargs["cls"] = base_cls if not user_cls else (base_cls + " " + str(user_cls))
    if style:
        kwargs["style"] = style
    return kwargs


def _layout_props(base_cls, gap=None, wrap=None, justify=None, align=None, **kwargs):
    """row()/column() sin felles kwargs-oppbygging: gap=/wrap=/justify=/
    align= er tynne layout-kwargs som overstyrer app.css sine .os-row/
    .os-col-defaults via inline style (facade-nøytralt - INGEN ny CSS
    utover de tre klassene app.css allerede har, spec §Decisions 3).
    wrap= aksepterer en ren bool (True -> "wrap", False -> "nowrap") ELLER
    en rå CSS-verdi (f.eks. "wrap-reverse") gitt direkte som streng."""
    style = {}
    if gap is not None:
        style["gap"] = gap
    if wrap is not None:
        if wrap is True:
            style["flexWrap"] = "wrap"
        elif wrap is False:
            style["flexWrap"] = "nowrap"
        else:
            style["flexWrap"] = wrap
    if justify is not None:
        style["justifyContent"] = justify
    if align is not None:
        style["alignItems"] = align
    return _merge_container_style(base_cls, style, kwargs)


def row(*, gap=None, wrap=None, justify=None, align=None, **kwargs):
    """ui.row(**kw) -> Element (fase 4b, container 1/3, spec §Decisions 3):
    en flex-rad (.os-row, app.css) - kontroller/elementer monteres inn via
    `.add()`/`into=`. gap=/wrap=/justify=/align= se _layout_props; alt
    annet (cls=/style=/data_*/aria_*/attrs=/on_<event>=) går uendret videre
    til den vanlige ui.html-kwargs-standarden (_normalize_kwargs, via
    _tag_builder)."""
    return _tag_builder("div")(**_layout_props(
        "os-row", gap=gap, wrap=wrap, justify=justify, align=align, **kwargs))


def column(*, gap=None, wrap=None, justify=None, align=None, **kwargs):
    """ui.column(**kw) -> Element (fase 4b, container 2/3): en flex-kolonne
    (.os-col). Samme layout-kwargs-sett som row() - flex er flex uansett
    akse (flex-direction er den ENESTE forskjellen mellom .os-row/.os-col,
    se app.css)."""
    return _tag_builder("div")(**_layout_props(
        "os-col", gap=gap, wrap=wrap, justify=justify, align=align, **kwargs))


def grid(template, cols=None, rows=None, *, gap=None, **kwargs):
    """ui.grid(template, cols=, rows=, **kw) -> Element (fase 4b, container
    3/3, spec §Decisions 3): navngitte områder (_parse_grid_template) ->
    CSS grid-template-areas, ETT barn-div PER UNIKT områdenavn (opprettet
    HER, style.gridArea satt) - lagret som `{områdenavn: Element}` på
    returverdien sitt `_areas`-attributt. `Element.add(x, area="navn")`
    (fasade-side utvidelse, mirrored 3x - se pyodide/ui.py osv.) leser
    NØYAKTIG denne dicten for å slå opp området å tømme+rendre inn i.

    cols=/rows= er de vanlige CSS grid-template-columns/-rows-verdiene
    (f.eks. "220px 1fr") - rene gjennomstrøms-strenger, ingen egen
    parsing (til forskjell fra selve area-templaten).

    style= som en RAW cssText-streng ville ellers (via
    _merge_container_style, se der) ERSTATTE denne beregnede style-dicten
    i sin helhet - og dermed stille slette gridTemplateAreas/-Columns/
    -Rows/gap fra templaten/cols=/rows=/gap= (fase-4 sluttreview L-3).
    Append i stedet: brukerens egne deklarasjoner FØRST, så de beregnede
    grid-template-deklarasjonene (cssText, _style_dict_to_css_text) -
    templaten overlever alltid en rå style=-streng. Dict-style=-merging
    (den vanlige, ikke-raw veien) er uendret - se _merge_container_style."""
    parsed = _parse_grid_template(template)
    style = {"gridTemplateAreas": parsed["areas"]}
    if cols is not None:
        style["gridTemplateColumns"] = cols
    if rows is not None:
        style["gridTemplateRows"] = rows
    if gap is not None:
        style["gap"] = gap
    user_style = kwargs.get("style")
    if isinstance(user_style, str):
        prefix = user_style.strip()
        if prefix and not prefix.endswith(";"):
            prefix += ";"
        kwargs["style"] = (prefix + " " + _style_dict_to_css_text(style)).strip()
    container = _tag_builder("div")(**_merge_container_style("os-grid", style, kwargs))
    areas = {}
    for name in parsed["names"]:
        child = _tag_builder("div")(style={"gridArea": name})
        container.add(child)
        areas[name] = child
    container._areas = areas
    return container
