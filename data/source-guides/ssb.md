# SSB (Statistisk sentralbyrå) — PxWebApi v2

kilde: SSBs api-eksempler (janbrus), destillert 2026-07-31

## Reglene som forhindrer feil (les FØRST)

**Mandatory-regelen.** En FILTRERT spørring mot `/data` MÅ oppgi verdier
for ALLE dimensjoner som har `elimination: false` i tabellens metadata.
To dimensjoner er ALLTID obligatoriske — `ContentsCode` (hva som måles)
og `Tid` (tid) — selv i tabeller med bare ett innholdsalternativ. Mangler
én: SSB svarer `400 Bad Request` med `title`-feltet
`"Missing selection for mandantory variable"` (ja, SSBs egen stavefeil —
«mandantory»). Responsen ellers er bare `type`/`title`/`status` — INGEN
liste over hvilke koder som mangler (derfor har appen sin egen
feiloversettelse, `mandatoryErrorMessage`, som slår opp mot
`table_metadata` for å fortelle hvilke dimensjoner/koder som trengs).
Sjekk `mandatory`-flagget per dimensjon i `table_metadata`-svaret FØR du
bygger spørringen — ikke gjett hvilke som trengs.

**Kanonisk lesevei.** Default-responsen fra `/tables/{id}/data` (uten
`outputFormat=`) er json-stat2 — tidy, UTF-8-kodet JSON — og det er
dette `<alias>.read(...)` (direktivveien) bruker under panseret. Ber du
i stedet eksplisitt om `outputFormat=csv`, får du CSV som er BRED (én
kolonne per Tid-verdi) og kodet i latin-1 (iso-8859-1) — begge deler
feller for kode som antar tidy UTF-8. Skriv aldri en rå
`outputFormat=csv`-URL sammen med analysekode som forventer tidy data —
la default (json-stat2) stå, eller bruk `<alias>.read(...)`.

## URL-mønstre

| Formål | Endepunkt |
|---|---|
| Søk tabeller | `GET /tables?query=<ord>&lang=no` |
| Tabellinfo | `GET /tables/{id}` |
| Metadata (dimensjoner, koder, elimination) | `GET /tables/{id}/metadata` |
| Data | `GET`/`POST /tables/{id}/data?...` |
| Kodelisteoppslag | `GET /codelists/{id}` |

Base: `https://data.ssb.no/api/pxwebapi/v2/`. Bruk alltid `/v2/`, ikke
`/v2-beta/` — sistnevnte er en beta-sti SSB ikke garanterer stabilitet
på: søk/metadata/data svarte 503 der 2026-07-25, men de samme
endepunktene svarte 200 igjen ved probe 2026-07-31 (nedetiden var
trolig forbigående). Uansett stabilitet akkurat nå: «beta» i stien er i
seg selv god nok grunn til å styre unna i kode som skal vare.

## Tidsuttrykk (Tid-dimensjonen)

Funksjonsfiltre brukes ALENE i valueCodes for Tid (ikke sammen med
eksplisitte koder):

- `top(n)` — de n nyeste periodene
- `from(år)` — fra og med gitt periode

`range(fra,til)` finnes IKKE i PxWeb v2 — SSB svarer `400 Bad Request`
(`"Illegal selection expression"`) på den, verifisert 2026-07-31. Skal
du ha et lukket intervall, enumerer eksplisitte tidskoder i stedet.

Eksplisitte tidskoder må matche tabellens `timeUnit` (årlig: `"2024"`;
kvartalsvis: `"2024K2"`). I `<alias>.read(...)` skrives et lukket
intervall som `years="2015:2024"` — adapteren enumererer dette til
`valueCodes[Tid]=2015,2016,...,2024` (aldri `range()`). Et åpent
intervall (`years="2015:"`) oversettes til `valueCodes[Tid]=from(2015)`.

## Codelists (aggregering/utvalg)

Listet per dimensjon i `dimension.<variabel>.extension.codeLists` i
metadata, to typer:

- `agg_`-prefiks — aggregering, mange koder summeres til én (f.eks.
  kommune → fylke)
- `vs_`-prefiks — valueset, et alternativt (ofte kortere) utvalg av koder

Bruk i spørring: `codelist[Region]=agg_...&valueCodes[Region]=*`. Med en
aggregeringscodelist styrer `outputValues[Region]=aggregated|single` om
summerte eller enkeltverdier returneres. Slå opp selve kodene/etikettene
med `GET /codelists/{id}` — koder fra ulike codelists må ikke blandes.

## Kjente feller

- **`/v2-beta/` er beta, ikke en stabil produksjonssti** — 503 på
  søk/metadata/data 2026-07-25, 200 på de samme kallene 2026-07-31.
  Bruk `/v2/` uansett, ikke fordi beta-stien nødvendigvis er nede akkurat
  nå, men fordi SSB ikke lover at den forblir oppe.
- **`outputFormat=csv` er bred og latin-1** — default (json-stat2, uten
  `outputFormat=`) er tidy, UTF-8-kodet JSON, og det er det
  `<alias>.read(...)` bruker.
- **CORS på data-endepunktet har variert over tid** — registerets
  quirks-notat fra 2026-07-25 målte `access-control-allow-origin`
  fraværende der; et nytt probe 2026-07-31 målte den til stede (`*`, på
  både 200- og 400-svar). Stol på et ferskt probe-resultat fremfor denne
  filen for om CORS finnes akkurat nå — og uansett utfall er en rå
  `fetch()` trygg å forsøke først: appens datahenting faller automatisk
  tilbake til `/api/hent`-proxyen ved CORS-feil, aldri en stille feil.
- **`range(fra,til)` finnes ikke** — bruk `top(n)`/`from(år)`, eller
  enumerer eksplisitte tidskoder for et lukket intervall.
- Ukjent variabel-/verdikode, feil tidsformat, for mange celler (sjekk
  `/config` → `maxDataCells`) og manglende obligatorisk dimensjon gir
  alle `400` — `title`-feltet i responsen forteller hvilken (ingen
  kodeliste følger med).

## Komplett eksempel (Oslos folkemengde, tabell 11342)

```
# ssb = ost.connect("ssb")
# oslo = ssb.read("11342", regions=["0301"], indicators=["Folkemengde"], years="2015:2024")
```

Verifisert 2026-07-31: `Region=0301` (Oslo kommune) sammen med
`ContentsCode=Folkemengde` gir data uten 400. Fant du ikke riktig
regionkode i kodelisten? Bruk `find="Oslo"` i `table_metadata` fremfor å
gjette koder.
