# Tabulator-wrapper (`tabulator_core`) + generalisert show() — interaktive tabeller (design)

**Status:** APPROVED 2026-07-24 (avklart med Hans: modulnavn `tabulator`
— ærlig om backenden, Tabulator-dokumentasjonen gjelder opsjonene, og
fremtidige tabellpakker kan få egne moduler; `show()` forblir openstats
GENERELLE visningsverb og skal håndtere både tabellobjekter og
DataFrames, med tabulator som default for DataFrames). Fjerde og siste
leveranse i shim-workstreamen (altair, folium, lifelines levert
2026-07-24).

## Motivasjon

Sorterbare/filtrerbare/paginerte tabeller er daglig behov i en
statistikk-app; i dag finnes bare statisk tablehtml. Tabulator 6.3.1 er
allerede statisk lastet i index.html (JS defer + CSS, brukt av
individata-modalen) — wrapperen koster bare en spec-bygger og en
embed-case. Ingen python-tvilling finnes (itables wrapper DataTables),
så API-et er vårt eget, bevisst tynt over Tabulator-opsjonene.

## Arkitektur

    tabulator.table(df, ...) -> Table-objekt (spec-dict)
    -> to_tabulator_json_str() -> __micro_transform_start_tabulator__-embed
    -> buildOutputNodes(): new Tabulator(div, {...})

    show(df)                 -> samme embed (tabulator er DEFAULT for DataFrames)
    show(df, format='html')  -> gammel statisk tablehtml (som før)

### Filer

- **`shared/tabulator_core.py`** — dialektregler som de andre kjernene
  (fellelisten i plotly_express_mpy.py-filhodet); ingen runtime-imports,
  ingen configure-behov (ren dict-bygging).
- **`brython/tabulator_brython.py`** / **`micropython/tabulator_mpy.py`**
  — fasader med eksplisitte rebind-er (aldri stjerneimport, _Mod-fellen).
- **Registry** (begge motorene): `tabulator_core`
  (path-overstyring `shared/tabulator_core.py`) og
  `tabulator_brython`/`tabulator_mpy` med `aliases: ['tabulator']`,
  `deps: ['tabulator_core']`, `js: []` (Tabulator-JS-en er statisk).
- **Runnere** (`brython_runner.py` / `micropython_runner.py`):
  1. `_fmt`: ny gren FØR leafletmap-grenen —
     `hasattr(obj, 'to_tabulator_json_str')` → `tabulator__`-embed.
  2. **`_show(*objs, format=None, **opts)`** (den globale `show`):
     - objekt med `to_tabulator_json_str` → som _fmt.
     - DataFrame-aktig (har `to_html` OG `columns`):
       `format` None/'tabulator' → bygg tabulator-spec via en LITEN
       lokal hjelper i runneren (`_df_tabulator_spec(df, opts)` — skal
       IKKE kreve at tabulator-modulen er importert/registrert;
       duplisert ~20 linjer per runner er akseptert pris for at
       `show(df)` virker uten import); `format='html'` → dagens
       tablehtml-vei; ukjent format → ValueError med gyldige verdier.
     - alt annet: uendret `_fmt`-vei. `opts` (pagination/height/
       filters/sortable/title) sendes til spec-byggeren.
  3. Trailing bare `df`-uttrykk: UENDRET statisk tablehtml (publiserte
     dashboards skal ikke endre utseende; kan revurderes senere).
- **`index.html`**:
  1. Ny `tabulator`-case i `buildOutputNodes()` (FØR leafletmap-casen),
     guardet `typeof Tabulator !== 'undefined'`, med
     parse-feil-placeholder: div + `new Tabulator(div, oversatt spec)`.
     Gjenbruk stilkonvensjonene fra individata-modalens
     Tabulator-oppsett (~linje 4824-området) der de passer.
  2. Pyodide python-modus: (a) preRun-gren à la `__ensureUi`: når
     scriptet importerer `tabulator`, fetch `shared/tabulator_core.py`
     (med M2PY_VERSION-cachebuster) og registrer som modulen
     `tabulator`; (b) `_show_one`-gren FØR folium-grenen:
     `hasattr(obj, 'to_tabulator_json_str')` → print `tabulator__`-
     embed. Python-modusens visning av bare `df` forblir tekst.
  3. `PYTHON_DS_IMPORTS`: + `'tabulator'`. `M2PY_VERSION` bumpes.

## Spec-format (embed-payload)

```json
{
  "columns": [{"title": "aar", "field": "aar", "hozAlign": "right",
               "headerFilter": "input"?}, ...],
  "data": [{"aar": 2020, ...}, ...],
  "options": {  Tabulator-opsjoner, ferdig flettet  },
  "title": "..." | fraværende
}
```

JS-siden gjør `new Tabulator(div, Object.assign({data, columns,
layout: 'fitDataTable'}, spec.options))` + en enkel tittel-linje over
når `title` er satt.

## API (v1)

`tabulator.table(data, pagination=None, height=None, filters=False,
sortable=True, title=None, options=None)`:

- `data`: DataFrame (duck-typet `.columns` + `.to_dict()` → {kol: liste}
  — samme som folium/lifelines), dict-av-lister eller liste-av-records.
  NaN → None (vises tomt). Kolonnenavn → str.
- Kolonner autogenereres: alle får `sorter` etter type ('number' når
  kolonnen er helnumerisk, ellers 'string'); numeriske kolonner får
  `hozAlign: 'right'`; `filters=True` → `headerFilter: 'input'` på alle.
  `sortable=False` → `headerSort: false` på alle.
- `pagination`: None → auto (paginering PÅ med sidestørrelse 20 når
  radantall > 200, ellers av); tall → på med den sidestørrelsen;
  False → alltid av.
- `height`: px-tall → Tabulator `height` (virtuell DOM/scroll).
- `options={...}`: flettes SIST inn i Tabulator-opsjonene (vinner over
  de genererte) — passthrough-flaten som gjør Tabulator-dokumentasjonen
  til referansen. Kun JSON-serialiserbare verdier (callables →
  TypeError med forklaring).
- Returnerer `Table` med `to_dict()`, `to_tabulator_json_str()`,
  `__repr__` som de andre shimene ('use show() or leave as last
  expression').

`show(df, ...)`-kwargs (runner-siden): `format` (None/'tabulator'/'html'),
`pagination`, `height`, `filters`, `sortable`, `title` — videresendt til
samme spec-bygging (runner-hjelperen og tabulator_core skal produsere
IDENTISK spec for samme input; håndheves av en test som sammenligner de
to veiene).

## Testing

1. **`brython/tests/test_tabulator_core.py`** — spec per input-form,
   kolonnetyper/justering/sortere, pagination-auto-terskelen (200),
   filters/sortable-flagg, options-passthrough (vinner over generert),
   callable i options → TypeError, NaN → None, runner-protokollen.
2. **Runner-tester** (`test_tabulator_runner.py`): `_fmt(Table)` →
   tabulator-embed; `_show(df)` → tabulator-embed (default);
   `_show(df, format='html')` → tablehtml; ukjent format → ValueError;
   spec-paritet runner-hjelper vs tabulator_core.table; plotly/vegalite/
   leafletmap-greinene upåvirket.
3. **MPy-røyk** (`mpy_smoke_tabulator.py`) + kjøring av
   micropython-runnerens egen testfil.
4. **Browser** (alle tre moduser + tema): sortering ved klikk,
   header-filter, paginering på stor tabell, options-passthrough,
   `show(df)` vs `show(df, format='html')` side om side, pyodide
   `tabulator.table(df)` på ekte pandas.

## Eksempler & docs

`examples/brython/bry30_tabulator.txt`,
`examples/micropython/10_tabulator.txt`,
`examples/python/py10_tabulator.txt`; manifest regenereres.

## Utenfor v1

Celle-redigering, events/callbacks til python, eksport-knapper utover
eksisterende kopier-mekanikk, great_tables-stil publikasjonstabeller
(ev. egen modul senere), endring av trailing-`df`-visningen.
