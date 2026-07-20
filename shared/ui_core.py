"""ui_core - delt fasadekjerne for pyodide/brython/micropython (fase 3,
spec 2026-07-20 §Phase 3 revidert). KUN dialektfri kode: aldri import av
js/browser/jsffi, aldri direkte window-referanse. Dialekt-symboler
injiseres av HVER fasade via configure() - kjernefunksjonene slår dem opp
ved KALLTID (sen binding), slik at pytest (én CPython-prosess, tre
fasader) alltid ser den sist konfigurerte fasadens dialekt etter dens
egen (re)import."""

# ---- injiserte dialekt-symboler (settes av configure) -------------------
_register = None
_register_value = None
_bind_handler_if_callable = None
_ui = None
_warn_sink = None
_scalar = None


def configure(**kwargs):
    """Fasaden kaller configure(register=..., register_value=..., ...) ved
    import. Idempotent: hvert kall overskriver forrige (riktig under
    pytest der tre fasader deler prosessen og re-importeres per test)."""
    g = globals()
    for k, v in kwargs.items():
        g['_' + k] = v


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
