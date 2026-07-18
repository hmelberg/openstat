# JavaScript-modus — design

*Dato: 2026-07-19. Status: godkjent i brainstorm, klar for plan.*

## Mål

Et nytt kjørbart språk i appen: **JavaScript**, rettet mot tallanalyse og
presentasjon av resultater. Koden kjøres native i nettleseren (ingen
wasm-boot — raskeste modus i appen), med velkjente open source-biblioteker
lastet lat fra CDN. Full integrasjon fra første versjon: `# load`-
datadirektiver, `#%%`-notatbokceller og gjenbruk av eksisterende
output-rendering (embed-markører, Plotly-tema/-resize).

## Valgt tilnærming

Egen motor `js/javascript-engine.js` etter Brython-/MicroPython-mønsteret:
samme `{load, run, notebookSession}`-kontrakt, samme `{text, error}`-retur
med embed-markørtekst rendret av `buildOutputNodes()`. Forkastede
alternativer: sandboxet iframe/Worker (plots/ui trenger DOM; alle andre
runtimes kjører i siden; brukeren kan uansett kjøre vilkårlig kode) og
QuickJS-wasm (tregere, ingen DOM, ingen gevinst).

## 1. Modusregistrering (index.html)

- Modusvelger-knapp `<button type="button" data-mode="javascript">JavaScript</button>`
  (plasseres etter Brython/MicroPython-knappene).
- `MODES.javascript`: `{ id: 'javascript', label: 'JavaScript',
  hlConfig: JS_HL_CFG, handleTab: <gjenbruk py-tab eller enkel innrykk>,
  onActivate: () => JsEngine.load() (varm CDN-bibliotek-registeret er tomt å
  varme — load() er i praksis en no-op/rask resolve, men holder kontrakten),
  runSelf: <speiler brython-grenen: DataLoader.resolveAndFetchLoads →
  mdEnsureTagImports → mdClearOutputAreaUnlessDoc → nbUiRunCtx/Ui.beginCellRun-
  bracketing → JsEngine.run(script, {loads}) → renderOutput> }`.
- `JS_HL_CFG`: ny highlight-konfig for JavaScript (nøkkelord `const let var
  function class return if else for while await async =>` osv., `//`- og
  `/* */`-kommentarer, streng-/template-literals). Samme konfigform som
  `PY_HL_CFG`/`SQL_HL_CFG`.
- `RUNTIME_FOR_MODE.javascript = 'javascript'`.
- `editorContent`/`editorBP`: nye `javascript`-nøkler.
- Moduslistene som teller opp gyldige moduser: ~1529 (URL/state-gate) og
  ~2035 (`#options.mode`-overstyring) utvides med `'javascript'`.
- `runNotebookEngineCell` (~10245) og kind-dispatchen i `mdRunNotebookCell`
  (~10307): `kind === 'javascript'` → `window.JsEngine`.
- Invalideringspunktene for motorøkter (~3461 og ~10045) og isLive-sjekken
  (~10049): samme mønster som Brython/MicroPython, med `JsEngine`.
- Boot-grenen ~9628 (forhåndslasting per runtime): egen gren for
  `runtimeForMode(...) === 'javascript'`.

## 2. Motor og økt (js/javascript-engine.js)

`window.JsEngine` med:

- `load()`: rask resolve (ingen runtime å boote). Finnes for kontrakt-
  symmetri og for ev. fremtidig forhåndslasting.
- `run(script, {loads})`: engangs-kjøring (plain script). Oppretter ferskt
  scope, kjører, returnerer `{text, error}`.
- `notebookSession`: `{ isLive(), ensure(loads), runCell(src), restart(),
  invalidate() }` — vedvarende scope-objekt lever i økta; celler bygger på
  hverandre. «Kjør alle»/restart nullstiller scopet (samme semantikk som
  Brython-økta).

**Kjøring:** koden wrappes i en `AsyncFunction` (toppnivå-`await` virker)
som kjøres med en scope-proxy (`with (__scope)`). En lett pre-pass skriver
toppnivå-deklarasjoner om til scope-tilordninger slik at variabler overlever
mellom celler/kjøringer:

- `let x = …` / `const x = …` / `var x = …` → `x = …` (destrukturering
  `const {a, b} = …` → `({a, b} = __destrukturering…)`; holdes enkel:
  regex på toppnivålinjer, ikke full parser — samme pragmatisme som
  scanImports i Brython-motoren; over-/undermatch gir høylytt feil, ikke
  stille korrupsjon).
- `function f(…) {` og `class C …` beholdes, men navnet kopieres inn i
  scopet etter kjøring (deklarasjonen evalueres i funksjonskroppen; en
  etterfølgende `__scope.f = f`-hale genereres for deklarasjonsnavn funnet
  i pre-passen).
- Pre-passen opererer kun på toppnivå (innrykk 0 / ikke inne i blokk-,
  streng- eller kommentarkontekst i den grad den enkle skanningen ser det).

**Direktivlinjer:** `#` er ikke kommentar i JS. Motoren stripper alle
toppnivålinjer som begynner med `#` før eval (`# load`, `#%%`-cellemarkører,
`#options`, `#tag.import` osv.) — dermed virker eksisterende direktiv- og
notatbokmaskineri uendret. (`Cells.execCellSource` blanker allerede
headere/tag-linjer for celleveien; strippingen i motoren er belte-og-seler
for plain-veien og fremmede `#`-linjer.)

**console-fangst:** under kjøring byttes `console.log/info/warn/error` til
en buffer (originalene kalles også, så devtools beholder loggen). Bufferen
blir tekstdelen av output. Formatering: strenger som de er; andre verdier
via en kompakt pen-printer (JSON med innrykk, `Map`/`Set`/`Date` håndtert;
sirkulære referanser → `[Circular]`).

**Feil:** exceptions fanges; `{error: melding + kort stack (kun brukerens
rammer)}`.

## 3. Visning av resultater

Siste *uttrykk* i en celle/script vises automatisk (notatbok-følelse).
Pre-passen identifiserer om siste toppnivå-setning er et uttrykk og gjør det
til funksjonens returverdi. Verdien mappes til embed-markørtekst
(`__micro_transform_start_<type>__` … `__micro_transform_end__`):

| Verdi | Visning |
|---|---|
| Arquero-tabell (`aq.Table`, duck-typet på `.toHTML`/`.objects`) | HTML-tabell-embed (samme rendering som pandas-tabeller; begrenses til f.eks. 200 rader med «… n rader»-fotnote) |
| Plotly-figur (objekt med `data` + `layout`) | `figure`-embed (JSON) → eksisterende tema-/resize-håndtering |
| DOM-node (Observable Plot m.fl.) | html-embed (serialisert via `outerHTML`; SVG fra Plot er statisk og trygg gjennom eksisterende sanitering) |
| `null`/`undefined` | ingenting |
| Tall/streng/øvrige objekter | tekst (objekter som pen JSON) |

`console.log`-tekst kommer først, deretter siste-uttrykk-visningen — samme
rekkefølge som print + display i Python-modus.

## 4. Biblioteker (lazy CDN-register)

Ingen `import` i brukerscript — bibliotekene eksponeres som globale navn.
Motoren skanner koden for identifikatorene og laster (én gang, pinnede
versjoner fra jsdelivr) kun det som brukes. Registerform som
`LIB_REGISTRY` i Brython-motoren: `{ global, url(s), deps }`.

| Global | Bibliotek | Pinnet versjon (ved implementasjon) | Bruk |
|---|---|---|---|
| `aq` (+ `op` re-eksportert) | Arquero | nyeste 8.x | dataframes: filter, gruppering, aggregering, join, pivot |
| `ss` | simple-statistics | nyeste 7.x | deskriptiv statistikk, t-tester, enkel lineær regresjon |
| `jStat` | jStat | 1.9.x | fordelinger, p-verdier, ANOVA |
| `ML` | ml.js (mljs paraply) | nyeste 6.x | multippel regresjon, PCA, k-means, random forest, KNN |
| `Plot` (+ `d3` hvis bundelen krever) | Observable Plot | nyeste 0.6.x | deklarativ statistisk grafikk (returnerer SVG-node) |
| `Plotly` | Plotly | allerede lastet globalt (2.32) | interaktive plott |

Deteksjon: ord-grense-regex per global (`\baq\b`, `\bss\.`, `\bjStat\b`,
`\bML\b`, `\bPlot\b`). Overmatch er ufarlig (laster et bibliotek unødig);
undermatch gir en tydelig `ReferenceError` med hint om globalnavnene.

## 5. Datadirektiver og datainterop

- `# load <navn>`-linjer løses av `DataLoader.resolveAndFetchLoads` (som i
  Brython-grenen). Motoren mottar `loads` og materialiserer hvert datasett
  som **Arquero-tabell** i scopet under sitt navn:
  - CSV/tekst → `aq.fromCSV`
  - parquet → kolonner via den eksisterende duckdb-broen
    (`window.__brythonParquetColumns(bytes)`) → `aq.table(columns)`
  - JSON → `aq.from(rows)`
- Arquero lastes automatisk når et script har `# load` (implisitt dep).
- `# use <navn> from duckdb` gjenbruker eksisterende uttrekk (parquet-bytes
  fra wasm-katalogen) → samme materialisering. Interop fra python/r-økter
  holdes utenfor v1 hvis det krever Pyodide-boot; noteres som senere
  utvidelse.

## 6. Oppstartseksempel, i18n, docs

- `_STARTUP_JS` i `STARTUP_EXAMPLES`: lite script som laster et datasett
  med `# load`, aggregerer med `aq`, kjører regresjon med `ss`, plotter med
  `Plotly` — viser tabell + figur.
- i18n-strenger (norsk + `js/i18n/en.js`) for status-/feilmeldinger.
- Hjelpeside (`hjelp.html`/`hjelp.en.html`): seksjon om JavaScript-modus med
  globalnavnene og et par oppskrifter.
- Eksempelmeny: 2–3 eksempler i `web_examples`-stil hvis mønsteret er lett
  å følge (ellers kun startup-eksempelet i v1).

## 7. Feilhåndtering

- Bibliotek-CDN feiler → tydelig status/feilmelding («Kunne ikke laste
  Arquero fra CDN — sjekk nettverket»), kjøringen avbrytes.
- Syntaksfeil i brukerkode → feilen fra `new AsyncFunction` fanges og vises
  som `{error}` (radnummer så langt V8 gir det).
- Pre-pass-omskrivingen skal aldri endre semantikk stille: den rører kun
  linjer den positivt gjenkjenner; alt annet passerer uendret.

## 8. Testing og verifisering

- Node-testbare rene deler (samme mønster som `js/cells.js` sin rene
  halvdel): pre-passen (deklarasjon→tilordning, siste-uttrykk-retur,
  `#`-stripping), bibliotek-skanningen og verdi→embed-mappingen (med
  duck-typede stubber).
- Nettleser-røyk: et manuelt script i `manual_scripts`-stil som kjører
  `# load` + aq-aggregering + ss-regresjon + Plotly-figur + Observable
  Plot-figur i både plain- og notatbokdokument, pluss økt-persistens
  (variabel definert i celle 1 brukt i celle 2) og «Kjør alle»-reset.

## Avgrensninger (v1)

- Ingen `# use … from python/r` (krever Pyodide/webR-økt-uttrekk; senere).
- Ingen vendor-kopi av bibliotekene i repoet (CDN-only, som Brython-kjernen).
- danfo.js tas ikke inn (tung, TensorFlow.js-avhengig); Arquero er
  hovedbiblioteket. Kan legges til i registeret senere om ønsket.
- ui.*-widgets (js/ui.js) kobles ikke på JS-modus i v1 — brukeren har
  allerede full DOM-tilgang i JS.
