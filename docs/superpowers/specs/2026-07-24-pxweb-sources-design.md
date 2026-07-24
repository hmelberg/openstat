# API-kilder: SSB/PxWeb som connect-kind (design)

*Økt 2 fra roadmapen 2026-07-24 (Hans' bestilling): nytt connect-kind for
PxWeb, metadata-endepunktet mater kildekatalogen og tab-fullføringen uten
nedlasting, og den harde forutsetningen — composite keys — løses først.
Eurostat/OECD gjenbruker mønsteret i en senere økt.*

## §1 Composite keys (forutsetningen)

PxWeb-uttrekk er lang-format med flere dimensjonskolonner (Region, Tid, …);
å montere to uttrekk krever flerkolonne-nøkler. I dag er nøkkelen én kolonne
hele veien.

- **Syntaks:** `# create-dataset d, key(region aar)` — én eller flere
  kolonner, skilt med mellomrom/komma (parentesene avgrenser, så mellomrom er
  trygt). `# join a into b on region, aar` — komma-skilt for flerkolonne
  (mellomrom alene ville vært tvetydig mot `left|inner|outer`-halen).
- **Spec-form:** `d.key` og `step.on` er ALLTID arrays (ingen bakoverkompat —
  Hans' beslutning 2026-07: erstatt, ikke migrer). Konsumenter oppdateres:
  - `AssemblyDuckdb.compile`: SELECT-listen = nøkler + kolonner,
    `USING ("a", "b")` og `EXCLUDE ("a", "b")` med hele listen.
  - Pandas-fallbacken (buildAssemblyPreamble): `merge(on=<liste>)`
    (pandas tar lister direkte); kolonneplukk med `not in`-filter.

## §2 kind(pxweb)

- **connect:** `# connect https://data.ssb.no/api/pxwebapi/v2/tables as ssb, kind(pxweb)`
  — basen peker på `/tables`-nivået (samme konvensjon som registerets
  eksisterende SSB-oppføringer).
- **load:** `# load ssb/05839 as bef` — tabell-id kreves (som duckdb/sqlite:
  «stien» er tabellen). Utvalg og språk sendes som PxWeb-query i målet:
  `# load ssb/05839?valueCodes[Tid]=2020,2021&lang=en as bef`. Uten utvalg
  gjelder API-ets defaultSelection (typisk siste periode) — bevisst: raskt og
  ærlig, brukeren utvider selv.
- **import:** `# import ssb/05839.value into d` — punktum skiller tabell fra
  kolonne, samme som duckdb/sqlite-kilder.

### Dataformat: json-stat2 → ryddig lang-format (verifisert mot live API 2026-07-24)

Default-CSV-en fra PxWeb er PIVOTERT (bred: «Personer 2009 0/1/2») og
iso-8859-1-kodet — begge deler ubrukelig for nøkler/joins og æøå. json-stat2
er alltid lang, UTF-8, har åpen CORS (`access-control-allow-origin: *`), og
er også Eurostats format (gjenbruk). Derfor:

- Data hentes som `<base>/<id>/data?…&outputFormat=json-stat2` (lang=no som
  default når query-en ikke angir lang) og konverteres klient-side til én
  kolonne per dimensjon (KODENE som verdier, dimensjons-id som kolonnenavn)
  pluss `value`. Row-major-ekspansjon etter `id`/`size`; `value` kan være
  array eller sparse objekt (spec-en tillater begge). Størrelse begrenses av
  API-taket per kall.
- **I lastelaget** (`DataLoader.fetchResolvedItems`): uttrekket serialiseres
  til UTF-8 CSV-bytes med `format: 'csv'` — ALLE eksisterende konsumenter
  (python-FS/read_csv, R, duckdb registerCsv, brython/mpy, portable export)
  virker uendret.
- **I monteringen** (`resolveAssemblyColumns`): pxweb-deskriptorer
  materialiseres via samme fetch-vei (delt _bufCache), registreres som
  filbuffer `_px_<kilde>.csv` i duckdb-wasm, og deskriptoren omskrives til
  `{format:'csv', url:'_px_<kilde>.csv'}` — pushdown, composite-joins og
  format(duckdb)-views virker da uten kompilatorendringer (read_csv leser
  registrerte buffere ved navn). Ærlig unntak: px-uttrekk er API-nedlastinger;
  «null minnekost»-egenskapen gjelder remote parquet, ikke pxweb.

### Metadata → kildekatalog + tab (uten nedlasting)

- `<base>/<id>/metadata` (json-stat2-dataset: `id` = dimensjonsliste) mater
  `__connectedSources['ssb/05839']` med kolonnene (dimensjons-id-ene +
  `value`) — ingen datanedlasting. Oppføringer bygges for tabellene scriptet
  faktisk refererer (load-linjer + import-kilder), ikke hele API-katalogen.
- Tab-fullføring: `ssb/05839.<prefix>` foreslår tabellens kolonner (ny
  tabell-bevisst gren i microdataSlashSuggest); sidepanel-radene rendres med
  `.`-separator for tabell-oppføringer (matcher import-syntaksen).

## §3 Bevisst utenfor økten

- Eurostat/OECD-oppføringer (gjenbruk av kind + konvertering senere).
- Tabell-SØK (`/tables?query=…`) og valueCodes-utforsker-UI.
- Etikett-kolonner (`<dim>_label`) — kodene er join-sannheten; etiketter kan
  komme som opt-in senere.
