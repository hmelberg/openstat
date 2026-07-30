# Pretty output — design

Dato: 2026-07-30
Status: godkjent retning, klar for implementasjonsplan
Omfang v1: python-dialektene (pyodide, brython, micropython) + meny/direktiv. R og SQL er bevisst utsatt.

## Beslutninger (avklart med Hans 2026-07-30)

| Spørsmål | Beslutning |
|---|---|
| Default på/av | **På som standard** (opt-out med `#options.pretty_output=False`). Ingen brukere ennå → ingen bakoverkompat-hensyn. |
| Default tabellvisning | **Statisk `to_html`** (`tablehtml`-embed), ikke Tabulator. Tabulator kan velges via registry/kwarg. |
| Omfang v1 | Python-dialektene + meny-toggle. R/SQL som egne oppfølginger. |
| Bruker-overstyring | **`show.defaults`-dict** (attributt på `show`-funksjonen), pluss kwargs per kall. Ikke nye `#options`-nøkler utover `pretty_output` i v1. |
| Gjelder ikke bare DataFrames | Registry + generisk `_repr_html_`-fallback dekker andre objekttyper uten å enumerere dem. |

## 1. Mål og bakgrunn

Brukeren skal kunne velge mellom to generelle output-moduser:

- `pretty_output=False`: nøyaktig dagens oppførsel per motor.
- `pretty_output=True` (default): objekter som i dag faller ned til ren tekst
  (særlig pandas DataFrame/Series i pyodide) rendres i stedet som HTML-vennlige
  embeds, tilpasset web.

Nøkkelinnsikt fra kartleggingen: mekanismen brukeren beskrev («`__show(var)` ved
hver linje som bare er et variabelnavn») **finnes allerede** som display policy
v2 — AST/parse-basert evaluering med en display-hook, ikke tekstomskriving:

- pyodide: `_exec_pyodide_block` → `_show_one(v)` (`index.html:7723` / `:7591`),
  med demperegler for `None`, `_`-prefiks, `;` og nakne `ui.<kontroll>()`-kall.
- brython/mpy: siste-uttrykk-deteksjon → `_fmt(v)` (`brython_runner.py:234`/`:13`,
  `micropython_runner.py`).
- js: `splitLastExpr` → `valueToOutput` (`js/javascript-engine.js:120`/`:158`).

Transporten er markør-protokollen `__micro_transform_start_<type>__ … __micro_transform_end__`
i stdout, parset av `parseOutput` og rendret av `buildOutputNodes`
(`index.html:6041`/`6384`) med ferdige renderere for `tablehtml`, `tabulator`,
`figure`, `vegalite`, `leafletmap`, `png`, `markdown`, `ipywidget`, `html`.

**Derfor bygges det INGEN tekstomskriving og INGEN ny transportmodell.**
Pretty er et flagg som endrer hva de eksisterende hookene emitterer.
(Vurdert og forkastet: (B) omskriving til `__show(navn)` — krever parsing av sju
språksyntakser i JS og dobbeltevaluerer side-effekter; (C) strukturert
parts-modell à la R/jamovi for alle motorer — stor omskriving, null ny
kapabilitet. Riktig langsiktig retning er å konvergere R *inn i*
markør-protokollen, se §8.)

## 2. Semantikk og presedens

- Ny option `pretty_output` (bool). `extractScriptOptions` (`index.html:6966`)
  parser `#options.pretty_output=False` uten parser-endring.
- Presedens, samme mønster som `show_commands` (`index.html:11688`):
  **script-direktiv > Innstillinger (meny) > default `true`**.
- Flagget gjelder **display-hookene** (autoprint av nakne uttrykk + `show()`).
  Eksplisitt `print(df)` gir alltid rå tekst — garantert fluktvei.
- `pretty_output=False` = dagens oppførsel per motor, uendret. Merk at
  brython/mpy allerede viser naken `df` som statisk HTML-tabell i dag; False
  «nedgraderer» ikke dette (ingen regresjon i publiserte dashboards).
- Rike objekter (plotly, altair, folium, matplotlib, widgets, `ui.*`-elementer)
  rendres rikt i **begge** moduser, som i dag.

## 3. Registry: `show.defaults`

`show`-funksjonen får en dict-attributt, lik i alle tre dialektene:

```python
show.defaults = {
    "dataframe": "html",   # "html" | "tabulator" | "text"
    "series":    "html",
    "default":   "auto",   # auto = _repr_html_()/to_html() hvis mulig, ellers tekst
}
```

- Verdiene er renderer-navn som mapper til eksisterende embed-typer:
  `"html"` → `tablehtml`-embed, `"tabulator"` → `tabulator`-embed,
  `"text"` → `print`/`str` som i dag.
- Naken `df` ≡ `show(df)` ≡ oppslag i `show.defaults`. Kwargs per kall
  overstyrer: `show(df, format="tabulator", height=400, pagination=True, ...)`.
  Kwarg-settet fra brython/mpy (`format`, `pagination`, `height`, `filters`,
  `sortable`, `title`) porteres til pyodide.
- Ny objekttype senere = én registry-nøkkel + én emitter-gren. Ingen ny
  infrastruktur.
- `show.defaults` lever i brukerens namespace og kan endres fra kode når som
  helst; den overlever celler (persistente globals i alle tre dialektene).

**Kjent oppførselsendring:** eksplisitt `show(df)` uten `format=` i brython/mpy
gir i dag Tabulator; med unifiseringen følger den `show.defaults["dataframe"]`
= `"html"`. Bevisst valgt (ett mentalt system), jf. ingen-bakoverkompat.
`show(df, format="tabulator")` gir eksakt dagens visning.

## 4. Dispatch-rekkefølge (normativ)

Rekkefølgen i `_show_one`/`_fmt` er kontrakten. Pretty-laget skyves inn UNDER
de eksisterende rike grenene:

1. Eksisterende rike grener, uendret rekkefølge: ipywidgets-mimebundle,
   tabulator-objekt, folium, altair, plotly, matplotlib, **`_openstat_el_id`
   (ui.*-element → `obj.show()`, direkte DOM-montering)**.
   → Et ui-element (`x = ui.html.link(); x`) kan dermed aldri bli «to_html-et»
   til en død kopi; det monteres levende, utenom markør-protokollen, som i dag.
2. DataFrame/Series-gren: slå opp i `show.defaults` → emitter tilsvarende embed
   (pretty) eller `print(obj)` (ikke-pretty).
3. Ny generisk fallback (kun pretty): objektet har `_repr_html_()` (pyodide)
   eller `to_html()` (brython/mpy-shims) → `tablehtml`/`html`-embed, i
   try/except (feiler stille til tekst).
4. Som i dag: ndarray/list/tuple-rekursjon, til slutt `print(obj)`/`repr`.

Ui-elementer trenger ingen nøkkel i `show.defaults` — de har egen kanal.

## 5. Per-motor endringer (v1)

### pyodide (`index.html`)
- `_show_one` pandas-gren (`:7666-7671`): pretty → emitter `tablehtml`-embed
  via `to_html(max_rows=200)` med `class="output-table"` injisert (samme
  mønster som `brython_runner.py:45-49`). 200 matcher js-motorens
  `TABLE_LIMIT` og tabulator-kjernens auto-paginering. Series → via
  `to_frame()`.
- `_repr_html_`-fallback iht. §4.
- `show` (`:7695`) får kwargs-signaturen + `show.defaults`.
- `"tabulator"`-renderingen bruker `shared/tabulator_core.py` (lastes allerede
  lazy via `__ensureTabulatorPy`, `index.html:9924-9944`); i v1 seedes
  tabulator_core inn i sesjonspreludiet (165 linjer, avhengighetsfri) slik at
  `show.defaults["dataframe"]="tabulator"` virker uten import.
- Flagget inn via eksisterende per-segment-kanal (`_seg._nb`, konsumert
  `index.html:10754-10756`) — ny nøkkel `_nb.pretty`, videre som parameter til
  `_exec_pyodide_block`.

### brython / micropython
- `_fmt` sin `to_html`-gren konsulterer `show.defaults` (html er dagens
  oppførsel → default-casen er nesten no-op; `"tabulator"` gjenbruker
  `_df_tabulator_spec`, `"text"` gir `str(obj)`).
- `_show` respekterer `show.defaults` når `format=` ikke er gitt (jf. §3).
- Runnerne er bevisst duplisert; mønsteret følges: dupliser + paritetstest
  (som `test_spec_parity_with_core`).
- Kanal: `Engine.run(script, opts)` og `notebookSession.runCell(source, opts)`
  får `{pretty}`; runneren mottar det som nytt argument til `_execute_code`
  (tilstandsløst, samme mønster i begge runnere — de eksisterende
  `_execute_code`-kallpunktene i `js/brython-engine.js` og
  `js/micropython-engine.js:185-198` oppdateres). Denne kanalen er samme gap som gjør at
  `#options.display`/`show_commands` er døde i disse modusene i dag — bygges
  slik at den kan bære flere opts senere.

### javascript
- Uendret i v1 (arquero emitterer allerede `tablehtml`; dict/objekt →
  pretty-JSON). Kanalen (`runCell(source, opts)`) bygges likt for
  fremtidig bruk.

### Lesepunkter for optionen
`extractScriptOptions`-kallstedene som må plukke opp `pretty_output` og trê den
inn: `index.html:10814` (sesjonsboot), `:11233` (per-celle pyodide/duckdb),
`:11587` (engine-notebook «Kjør alle»), `:11689` (hoved-`btnRun`), pluss
`runNotebookEngineCell` (`:11122`) som i dag kaller `sess.runCell(text)` uten
opts.

## 6. Meny og lagring

- Ny toggle i innstillings-modalen (`index.html:355-413`): «Pen output (HTML)»,
  default på. Hint-tekst dokumenterer overstyringen, som for show_commands:
  «Kan overstyres per script med `#options.pretty_output=False`».
- Ekte, deklarert localStorage-nøkkel: `microdata_pretty_output`.
- **Samtidig bugfiks:** `TTS_RATE_KEY`, `BLOCK_PAUSE_KEY`, `DECIMALS_KEY`,
  `SHOW_COMMANDS_KEY` refereres i `initSettings` (`index.html:2374-2462`) men er
  aldri deklarert — alle sitter i `try/catch`, så Save kaster stille bort
  Decimals/Show-commands/TTS/pause-verdiene. Nøklene deklareres
  (`microdata_`-prefiks) så hele modalen faktisk persisterer.
- Getter `getPrettyOutputDefault()` + effektiv verdi etter presedensen i §2.

## 7. Tester

- `tests/test_display_policy.py` (harnesset ekstraherer den ekte
  pyodide-kjernen fra index.html): pretty på/av, df → tablehtml-embed,
  `show.defaults`-oppslag, `_repr_html_`-fallback, ui-element-rekkefølgen
  (element monteres, blir aldri html-embed), `print(df)` forblir tekst.
- `brython/tests/` og `micropython/tests/`: registry-oppslag i `_fmt`/`_show`,
  paritetstest brython↔mpy.
- `tests/js/cells-dom.test.js`: opts-kanalen (`runCell(source, {pretty})`).
- Innstillinger: test/verifisering av at nøklene er deklarert og at Save
  persisterer.

## 8. Bevisst utenfor v1

- **R**: la `captureRToOutputParts` (`index.html:9226`) kjøre stdout gjennom
  `parseOutput` — gir R hele embed-vokabularet og fikser samtidig at
  R-prosa-markdown-markører kan havne som rå tekst. Den ubrukte
  `type:'html'`-grenen (`index.html:9156`) er landingsplassen.
- **Native SQL**: `renderOutput(lastOutput, false, false)` (`index.html:8588`)
  flippes til html + `formatColumnsText` → tabell-embed.
- Layout-kwargs per objekt (align/width) — sentrering av pretty-tabeller løses
  med CSS på `.output-table-wrap`, ikke API.
- Brython/mpy-avviket «kun siste uttrykk vises» (akseptert i display policy
  v2-spec) — endres ikke av pretty.
- `#options.table_format`-direktiv — kan legges til senere hvis behov;
  `show.defaults` er valgt kanal nå.
