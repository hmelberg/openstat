# Rad-filtrering i monteringsspråket: `where=` + `filter()` (design)

*Hans' bestilling 2026-07-29: monteringsspråket (`ost.create`/`add`/`join`)
kan velge kolonner, men ikke rader. Legg til rad-filtrering slik at det
virker i alle språkmoduser. Avklart i brainstorm: BEGGE former —
`where=`-kwarg på `add` (per kilde, før join) og `filter()`-verb (på det
monterte datasettet, etter join) — med felles uttrykksgrammatikk.*

## §1 Hvorfor to former

De gjør semantisk ulike ting, tydeligst ved `how="left"`:

- `# panel.add(inntekt, ["medianinntekt"], where="medianinntekt < 400000")`
  filtrerer inntektskilden FØR joinen → kommuner med høy inntekt beholdes i
  panelet med NA i medianinntekt-kolonnen.
- `# panel.filter("medianinntekt < 400000")` filtrerer ETTER joinen → de
  samme kommunene forsvinner helt (NA-rader droppes, se §4).

`where=` er i tillegg pushdown-punktet: betingelsen havner inne i
per-kilde-SELECT-en, så for remote parquet/sqlite/duckdb hentes færre
rader/row-groups over nettet.

**Navnevalget `filter`:** dplyr-brukere kjenner det som radfiltrering, og
det skiller tydelig fra `where=`. Kollisjonen med pandas' kolonne-velgende
`DataFrame.filter()` er ufarlig fordi verbet står på monterings-objektet
(`panel`), ikke på en DataFrame — kopier-og-lim-pariteten mot pandas
brytes ikke. (`query` var alternativet; forkastet fordi `where`/`filter`
leser bedre som par.)

## §2 Overflate

```
# panel = ost.create(key="kommune")
# panel.add(befolkning, ["folketall"], where="folketall > 5000")
# panel.add(inntekt, ["medianinntekt"])
# panel.filter("medianinntekt < 400000")
```

- **`where=`** (nytt kwarg på `add`): gjelder én kilde, før join. Kan
  referere ALLE kildens kolonner — også ikke-importerte (SQL-WHERE
  evalueres før projeksjon; pandas/R-veiene filtrerer før kolonnesubset
  for paritet).
- **`filter(uttrykk)`** (nytt verb): gjelder det ferdig monterte
  datasettet, etter ALLE add og join — uansett hvor i scriptet linjen står
  (samme tvungne pass-rekkefølge som dagens «alle add før alle join»;
  pass-rekkefølgen blir add, join, filter). Kan kun referere kolonner som
  finnes i det monterte datasettet (nøkkel + importerte kolonner). Flere
  filter-linjer AND-es. Ingen kwargs; posisjonsargumentet er
  uttrykks-strengen. Tilordning avvises som for add/join («filter
  returnerer ingenting — skriv # panel.filter(…) uten tilordning»).
- IKKE i v1: `where=` på `join` eller på `<alias>.read("tabell")`-
  lasteformen; `where`/`filter` på URL-`ost.read`.

## §3 Uttrykksgrammatikk (v1) og AST

`betingelse (and betingelse)*` der betingelse = `kolonne op verdi`.

- op ∈ `== != < <= > >= in`
- verdi: tall, `'streng'`/`"streng"`, eller `[liste]` (liste kun for `in`;
  listeelementer er tall eller strenger)
- kolonnenavn: identifikator inkl. unicode-bokstaver (æøå …), eller
  backtick-sitert for navn med mellomrom/spesialtegn (`` `hele landet` ``)
- ALT annet er høylytt parse-feil med linjenummer: `or`, parenteser,
  aritmetikk, funksjoner, kolonne-mot-kolonne. `=` alene gir hintet
  «mente du ==?». `or` gir hint om `in`-listen.

Parses ÉN gang, i `js/data-directives.js` ved direktiv-parsing (feil
oppdages på linjenivå før noe kjøres). AST-form: liste av
`{col, op, value}` som AND-es. Lagres som `where: [...]` på
import-steget hhv. som eget step `{op: 'filter', where: [...]}`.

## §4 NA/NULL-semantikk: SQL-kanonisk i alle backends

Rader med NULL/NaN i en filterkolonne droppes av ALLE betingelser — også
`!=`. Uten dette ville `!=` stille beholdt NaN-rader i pandas men droppet
dem i SQL (NULL != x er NULL): samme script, ulikt antall rader per modus
— nettopp typen stille avvik prosjektet har brent seg på
(seks-stille-dødsfall-lærdommen). Derfor:

- SQL: naturlig oppførsel, ingen ekstra klausul.
- pandas: `& piece["col"].notna()` legges på ved `!=` (øvrige operatorer
  dropper NaN av seg selv).
- R: radindeksering via `which(...)` (dropper NA; naken logisk indeks
  ville gitt NA-rader).

## §5 Kompilering — tre emitterere, delt AST

| Konsument | Fil | Endring |
|---|---|---|
| DuckDB-kompilatoren | `js/assembly-duckdb.js:114-136` | `where` på import-steg → `WHERE`-klausul inne i per-kilde-`(SELECT … FROM ref WHERE …)`. `filter`-step → ytterste wrap `(SELECT * FROM (…) WHERE …)`. Identifikatorer `"…"`-siteres (eksisterende `quoteIdent`), strenger `'…'`-escapes (eksisterende `quoteLit`), `in` → `IN (…)`. |
| Pandas-fallbacken | `buildAssemblyPreamble`, `index.html:8391-8419` | `where`: boolsk maske (IKKE `.query()` — robust mot rare kolonnenavn) anvendt på kilden FØR kolonnesubset. `filter`-step: maske på `_acc`. Samtidig gjøres dagens `else`-gren eksplisitt (`elif op == 'join'` + høylytt `else` ved ukjent op). |
| portable-export | `js/portable-export.js:590-666` | python-eksport: maske-uttrykk; R-eksport: `df[which(…), ]`. Guard-antakelsen på 639-641 (kun import/join, første step er import) oppdateres. `isAssemblyLine` (576-580) må gjenkjenne `filter`-verbet. |

Dekningen følger av kartleggingen (2026-07-29): brython-, micropython-,
javascript-, R- og duckdb/sql-modus kjører montering UTELUKKENDE via
pushdown-veien (`resolveAssemblyColumns` → `AssemblyDuckdb.compile`) og
mottar kun materialiserte kolonner — motorfilene trenger null endring.
Python-modus bruker pushdown når mulig, ellers pandas-fallbacken.
Microdata-modus finnes ikke i openstat (hard feil allerede) — utenfor
scope. `js/directive-parser.js` trenger METHODS-oppføring for `filter`
(where er kwarg på eksisterende add og krever ingenting der).

## §6 Ærlige begrensninger (dokumenteres i hjelpeteksten)

- API-kilder (pxweb/eurostat/sdmx/dbnomics/worldbank) materialiseres til
  CSV før montering — `where`/`filter` filtrerer da LOKALT og reduserer
  ikke API-nedlastingen. Vil man begrense selve nedlastingen er svaret
  fortsatt `filters=`/`years()`/`countries()` på kilden. For remote
  parquet/sqlite/duckdb gir `where` derimot reell pushdown.
- Ukjent kolonnenavn oppdages først ved kjøring (Binder Error fra DuckDB /
  KeyError fra pandas) — begge er allerede høylytte; v1 wrapper dem ikke.

## §7 Tester

CI-kommandoen er `node --test 'tests/js/*.test.js'` (app-tests.yml:48-49).

- `tests/js/directive-semantics.test.js`: parse — gyldige uttrykk (tall,
  streng, `in`, `and`, backticks, æøå), avvisning (`or`, `=`-hint,
  parenteser, kwargs på filter, tilordning til filter), pass-rekkefølge
  (filter alltid sist, uansett linjeplassering).
- `tests/js/assembly-duckdb.test.js`: WHERE-emisjon (tall, streng-escaping
  med `'`, `in`-liste, flere betingelser, `where` + `filter` i samme
  montering, filter-wrap etter join, kompositt-nøkler uendret).
- NY `tests/js/portable-export.test.js`: filter-emisjon python + R
  (fila er utestet i dag — dette tetter samtidig et eksisterende hull).
- Manuell smoke i appen før push (pre-push-porten, jf. 2026-07-27-økten).

## §8 Utenfor scope

- safestat: har eldre regex-basert parseAssembly og divergert
  assembly-duckdb (enkeltnøkkel) — filter der er et EGET spor som krever
  grammatikk-synk først, ikke ren kopiering.
- `or`, parenteser, kolonne-mot-kolonne — legges til i grammatikken ved
  behov, uten API-endring.
- `where=` på join/read-lasteformen; dataset-nivå `query()`.
