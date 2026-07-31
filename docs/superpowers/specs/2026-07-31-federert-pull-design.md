# Federert kilde (pull+union) i openstat — design

*Hans' bestilling 2026-07-31: safestats federert-funksjon skal finnes i openstat
også, men uten Anvil-login; nøkler til datasett kan ligge i scriptet når kilder
krever det (de er ikke hemmelige i openstat). Scope og syntaks avklart med Hans
samme dag: fase 0-paritet (pull+union) og liste/dict-i-`ost.read`-syntaks.*

**Dato:** 2026-07-31
**Status:** Godkjent av Hans 2026-07-31. Ikke implementert.
**Kilde-paritet:** safestats fase 0, spec
`safestat/docs/superpowers/specs/2026-07-29-federated-sources-design.md` (fase 1/2
— compute-to-data med noder, SDC, tillitsnivåer — porteres IKKE; openstat har
ingen m2py-motor og ingen beskyttelsesnivåer).

## 1. Problem

Samme tabell ligger ofte delt på flere kilder (regioner, år, filer per land):
samme variabler, ulike rader. Analytikeren skal kunne skrive skriptet **som om
dataene var én kilde** — openstat henter alle medlemmene, unioner dem og legger
på en `__member`-kolonne så per-medlem-nedbrytning fortsatt er mulig.

Kun modell A (pull — dataene reiser) er i scope. Modell B (compute-to-data)
krever det restriktive verbsettet med combine-regler og SDC, som bevisst er
slettet fra openstat; safestat eier den delen.

## 2. Beslutninger (Hans, 2026-07-31)

1. **Omfang:** pull+union av URL-/fil-medlemmer (csv/parquet, inkl. rene
   GET-URLer som returnerer CSV). Ikke API-kind-medlemmer (pxweb/sdmx …) i v1 —
   skjemaene spriker på tvers av byråer og trenger en harmoniseringshistorie.
   Ikke node-medlemmer — ingen combine-motor i openstat.
2. **Syntaks:** liste/dict der én URL ellers står, i `ost.read`. Ingen ny
   grammatikk (parseren støtter allerede lister/dicts), ingen nye verb.
   Register-definerte federerte kilder refereres med id som i safestat.
3. **Nøkler:** `secret_key=` på read-linja arves av alle medlemmer. Inline
   nøkler i script er akseptert i openstat (ikke hemmelige); `scrubKeys`
   maskerer dem allerede før logging/AI.

## 3. Syntaks og semantikk

```
# person = ost.read(["data/nord.parquet", "data/vest.parquet", "data/sor.parquet"])
# person = ost.read({"nord": "data/nord.parquet", "vest": "data/vest.parquet"})
# person = ost.read("demo-federert")            ← registeroppslag, kind:"federated"
# person = ost.read([...], secret_key="ask")    ← arves av alle medlemmer
```

- **Liste** → union; medlemsnavn i `__member` = filnavn uten endelse når alle er
  unike (`nord.parquet` → `nord`), ellers `m1..mN` (safestat-default).
- **Dict** → nøklene blir `__member`-verdier (insertion order = medlemsrekkefølge).
- **Register-id** → oppføring i `data/data-sources.json` med `kind:"federated"`
  + `members` — samme JSON-vokabular som safestat (drop-in):

```json
{ "id": "demo-federert", "navn": "Demo: federert persontabell (3 deler)",
  "utgiver": "openstat", "tillit": "demo", "tilgang": "fil",
  "kind": "federated", "partition": "horizontal", "overlap": "none",
  "cors": true,
  "members": [ { "id": "nord", "url": "data/federert/nord.parquet" },
               { "id": "vest", "url": "data/federert/vest.parquet" },
               { "id": "sor",  "url": "data/federert/sor.parquet" } ] }
```

- `format=`-kwarg gjelder alle medlemmer (for GET-URLer uten filendelse).
  Kun csv/parquet i v1; annet → klar feil (samme melding som safestat:
  «medlemsformat «x» støttes ikke»).
- Nesting (federert medlem i federert kilde) avvises.
- Registermedlemmer med `tier:"node"` avvises med melding som peker til
  safestat («node-medlemmer krever safestat — openstat kjører kun pull»).
- `overlap`/`entity`/`partition` i registeroppføringer aksepteres og sendes
  gjennom (fremtidssikring, samme som safestat fase 0 — `overlap:"possible"`
  gir kun console.info).

## 4. Arkitektur

Byte-nær port av safestats fase 0. Union skjer i duckdb-wasm og materialiseres
som parquet-bytes inn i den vanlige lasteveien — virker dermed i alle 7 moduser
uten motorspesifikk kode. Alternativ (lazy UNION-view med HTTP-range-pushdown)
forkastet: gevinst kun i duckdb-modus, og safestat-pariteten ryker.

| Fil | Endring |
| --- | --- |
| `js/federate.js` | **NY** — kopieres byte-likt fra safestat (88 linjer, null avhengigheter utover `AssemblyDuckdb.CSV_OPTS`). `planUnion` (UNION ALL BY NAME + `__member` + DESCRIBE-per-medlem), `checkSchemas` (skjemadrift-nekt), `runNodes` (ubrukt i openstat, beholdes for byte-paritet). |
| `js/assembly-duckdb.js` | Eksporter `CSV_OPTS` (i dag modul-lokal, linje ~22; safestat eksporterer den nettopp for federate.js). |
| `js/directive-parser.js` | **Ingen endring** — lister/dicts parses allerede av `parseLiteral`. |
| `js/data-directives.js` | Resolve-gren: (a) liste/dict som read-target → `{alias, federated:[medlemmer]}`; (b) registeroppføring med `kind:"federated"`/`members` (sjekkes FØR anvil-fallthrough ~linje 536-540); medlemsnavn-regel; node-tier-nekt; nesting-nekt; `secret_key`-arv til medlemmer. |
| `js/data-loader.js` | Ny gren i `fetchResolvedItems` (før pxweb-grenen ~linje 314): hvert medlem hentes gjennom eksisterende fetch/cache-vei, deretter `deps.unionExec(alias, memberLoads, fedMeta)` → `{alias, bytes, format:'parquet', federated:true}`. Mangler `unionExec` → kast. `resolveSourcesOnly` ~linje 578: `|| r.federated` i pushdown-ekskluderingen. |
| `index.html` | `__federatedUnion(alias, members, meta)` ved siden av `__ensureDuckDB` (~linje 2170-2380): `registerFileBuffer` per medlem → `Federate.planUnion` → DESCRIBE-runde → `Federate.checkSchemas` → `COPY (unionSql) TO parquet` → `copyFileToBuffer`; `finally` rydder filer + lukker connection. Injiseres som `deps.unionExec` på alle 8 DataLoader-kallstedene (linje ~2779, 2854, 2919, 8097, 9577, 10797, 11318, 12384). `<script src="js/federate.js">`-tag. |

Ingen serverendringer: `tilgang:"fil"` er allerede gyldig i
`netlify/edge-functions/_lib/registry.ts` sin lukkede TILGANG-mengde, og
federerte kilder skal ikke være søkbare i v1.

## 5. Feilhåndtering (paritet med safestat)

- **Skjemadrift**: avvisning som navngir medlem + manglende/ekstra kolonner
  (navnemengde, rekkefølge-ufølsom; medlem 0 er referanse).
- **Ett medlem nede/feiler** → hele kjøringen feiler med medlemsnavn i
  meldingen. Fail-fast er bevisst: delvise resultater presentert som helheten
  er en korrekthetsfelle.
- **Relative medlems-URLer** behandles som URL-er også når de er relative
  (safestats explicitUrl-felle — porteres riktig fra start).

## 6. Demo, eksempler, hjelp

- `scripts/build_federert_demo.py`-mønsteret fra safestat gjenbrukes på
  openstats demodata (`data/person_year_sample.csv`, 8000 rader) → 3
  parquet-shards under `data/federert/` + `demo-federert` i registeret.
  Deterministisk splitt slik at union == usplittet tabell er testbar invariant.
- Ett eksempelskript (python-modus) med `value_counts()` på `__member`.
- Hjelpeseksjon i openstats hjelpeside (tilpasset — uten tillitsnivåer/noder).
- AI-data-svar-prompten nevner ikke federert i v1.

## 7. Testing

- **Node-tester** (`node --test tests/js/`): port av safestats tre filer
  tilpasset ost-syntaks — `federate.test.js` (planUnion/checkSchemas/runNodes),
  direktiv-resolve (liste/dict/register/nekt-tilfeller/`secret_key`-arv),
  loader-gren (fake fetch + fake `unionExec`, pushdown-ekskludering,
  manglende `unionExec` kaster).
- **Deno-testene** som eval-er browser-filene (`data-loader.test.ts`,
  `data-directives.test.ts`) utvides tilsvarende.
- **Invariant**: union av demo-shards == usplittet tabell (radantall +
  kolonnesett; `__member`-fordeling == splittstørrelsene).
- Browser-smoke før push (openstat-regelen: smoke er pre-push-port).

## 8. Ikke-mål

- Node-medlemmer / compute-to-data, SDC, tillitsnivåer (safestat eier dette).
- API-kind-medlemmer (mulig fase 2 med harmoniseringshistorie).
- Overlap-håndtering utover å la registerfeltene passere.
- Vertikal partisjonering / record linkage.
- Pushdown/lazy views for federerte kilder.
