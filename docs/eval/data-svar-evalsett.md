# Evalsett for data-svar (Web-modus)

Kjøres manuelt/halvautomatisk FØR hver promptendring deployes (spec §7).
Per spørsmål: kjør i angitt modus med AI-modus «Web», og sjekk kriteriene.

Kriterier (alle må holde):
1. Minst én kilde er probe-verifisert (✅ i kildelista) og reell (åpne URL-en).
2. Scriptet kjører (evt. etter ≤3 auto-reparasjoner).
3. Datainnlasting følger grenseregelen (2026-07-27): `ost`-direktiver for
   register/nøkkel/POST/kanonisk spørring; ren `pd.read_csv(url)` er OK for
   åpne GET-tabeller — og for SSB-langformat skal SSB-MALEN brukes
   (`stub=` + `encoding="latin-1"`). Ingen ad-hoc requests/pyfetch-kode for
   GET-bare uttrekk.
4. Svaret skiller beskrivelse fra årsak, og oppgir antakelser ved kausale metoder.
5. Ingen fabrikerte tabell-ID-er/kolonner (sjekk mot probe-loggen i progresslinjene).
6. FORM-SAMSVAR (målt feilklasse 2026-07-27): lastingens form matcher
   analysekoden — aldri bred PxWeb-CSV (`outputFormat=csv` uten `stub=`)
   sammen med kode som antar tidy langformat.
7. ALDRI rå `pd.read_*`-URL mot SDMX-kilder (OECD/ECB/Norges Bank) — de
   ignorerer ukjente parametere stille; SDMX går via `ost` med kanonisk
   vokabular.
8. SPØRRELOGIKK-TRIAGE (2026-07-28): kausale spørsmål har VARIABELPLAN
   (variabel|rolle|kilde|kode|verifisert) FØR koden, med table_metadata-belegg
   per rad; deskriptive spørsmål har den IKKE (lett vei + én tolknings-
   setning). Feil begge veier teller: manglende plan ved kausalt spørsmål OG
   kausal-stillas rundt deskriptivt.
9. METODE↔DATA-BEGRUNNELSE (kausale): valgt metode begrunnes mot faktisk
   tilgjengelige data (kandidat forkastet ærlig når data ikke bærer den);
   hendelser brukt i identifikasjon er verifisert m/ dato + kilde-URL.
10. PORTABILITET: cors:true + GET-tabell → pd.read_csv DIREKTE (ikke
    /api/hent-innpakning); proxy kun ved målt CORS-feil eller nøkkelkilde.
11. FORSKNINGSSYNTESE-SITERINGER (2026-07-28): studier omtalt med
    funn/tall/årstall skal stå i et search_literature-treff (DOI-URL oppgitt
    i svaret) eller være web_fetch-lest; ellers merket «fra modellkunnskap —
    verifiser». Mekanisk sjekk: åpne DOI-URL-ene fra svaret.
12. DTYPE-HÅNDTERING (2026-07-28, overraskelsesprinsippet — appen typer
    ALDRI implisitt): generert python/R-kode håndterer typene selv med
    standard-idiomer — kodekolonner/join-nøkler som ser numeriske ut
    (kommunenr, tabellkoder) leses m/ dtype={...: str} (python) eller
    colClasses = c(... = "character") (R); datoer/kvartaler håndteres
    eksplisitt (parse_dates/to_datetime, as.Date — aldri inferens-antakelse);
    ost.read_csv/convert_dtypes (python, portabel) og
    ost_read_csv/ost_convert_dtypes (R, kun i appen) teller som eksplisitt
    metadata-vei. FAIL når analysen joiner/grupperer på en kodekolonne
    motoren har talltolket.

Dybde (2026-07-28): settet kjøres i Deep (default). Fast måles med
Fast/Deep-PAR på samme spørsmål og bedømmes etter «Fast reduserer ambisjon,
aldri ærlighet»: ærlighetskriteriene (1, 2, 5, 11) gjelder UENDRET i Fast;
omfangskriterier (flerkilde, heterogenitet, svarlengde) slakkes.

| # | Modus | Spørsmål | Forventet kilde(r) |
|---|-------|----------|--------------------|
| 1 | python | Hvordan har arbeidsledigheten i Norge utviklet seg siden 2010? | SSB |
| 2 | python | Er det en sammenheng mellom BNP per innbygger og CO₂-utslipp per land? | OWID/Verdensbanken (flerkilde-join på landkode) |
| 3 | r | Hvordan har boligprisene i Norge utviklet seg sammenlignet med lønningene? | SSB (to tabeller, join på år) |
| 4 | duckdb | Hvilke kommuner har høyest andel eldre, og hvordan har det endret seg siste 10 år? | SSB |
| 5 | python | Påvirket pandemien sysselsettingen ulikt i ulike næringer? (event study-aktig) | SSB |
| 6 | python | Hvordan er USAs arbeidsledighet nå sammenlignet med før finanskrisen? | FRED (nøkkel via proxy) |
| 7 | r | Hvor mye har vaksinasjonsdekningen for meslinger endret seg globalt? | WHO GHO |
| 8 | python | Finn en åpen CSV om drivstoffpriser i Norge og vis utviklingen. | web_search + probe (datanorge/funnet kilde) |
| 9 | duckdb | Sammenlign renta i Norge og eurosonen siste 5 år. | Norges Bank + ECB/Eurostat (flerkilde) |
| 10 | python | Hva vet vi om effekten av kontantstøtte på mødres yrkesdeltakelse? | ærlighets-test: identifikasjon er vanskelig — svaret skal si det, og evt. vise deskriptiv utvikling med forbehold |
| 11 | python | Har kommuner som skiftet ordførerparti ved valget i 2023 hatt annerledes utvikling i ledighet? | SSB (utfall) + Wikipedia/transkribert lim-tabell for partiskifte (nivå 2 i datatilfangst-stigen, med kilde-URL) |
| 12 | python | Finn et Kaggle-datasett om Titanic-passasjerene og vis overlevelsesrate etter kjønn. | kaggle (brukernøkkel; uten registrert nøkkel skal svaret si at nøkkel må registreres — ikke fabrikkere) |
| 13 | python | Hvordan har arbeidsledigheten i Sverige utviklet seg siste 10 år? | scb (search_catalog) |
| 14 | r | Sammenlign befolkningsveksten i Finland og Norge siden 2000. | statfin + ssb (flerkilde-join på år) |
| 15 | python | Hvordan har folketallet i Danmark utviklet seg per kvartal siden 2020? | dst |
| 16 | python | (nivå 2-leverandør, manuell m/ OpenAI-nøkkel) Hvordan har arbeidsledigheten i Sverige utviklet seg siste 10 år? — uten websøk skal svaret bygge på search_catalog/probe; foreslåtte modellkunnskaps-URL-er skal være probet eller ærlig avvist | scb (registerverktøy, MEMORY_URLS-regelen) |
| 17 | python | (uten registrert Kaggle-nøkkel) Finn et Kaggle-datasett om Titanic og vis overlevelsesrate etter kjønn. | kaggle (valgfri nøkkel — anonym henting skal fungere for åpne datasett) |

Resultatlogg (dato, #, PASS/FAIL, notat) føres nederst; feilmønstre omsettes
til promptregler i _lib/data-svar-prompt.ts eller quirks i data-sources.json.

## Kjøremetode (lokalt, 2026-07-03)

`netlify dev`s edge-function-runtime var brukket på maskinen som kjørte denne
runden. Brukte i stedet en direct-Deno-harness (samme tilnærming som Task 10,
se `.superpowers/sdd/task-10-report.md`): en liten Deno-server som serverer
`GET /data/data-sources.json` fra repoet og videresender `POST /api/data-svar`
til handlerens default-export, med env fra repoets `.env`
(`ANTHROPIC_API_KEY`, `M2PY_ACCESS_TOKEN`). Harnesset er ikke committet
(`.superpowers/sdd/.gitignore` ignorerer hele mappen). Kriterium 2 (scriptet
kjører i nettleser-sandkassen) kan ikke verifiseres i denne harnessen —
logges som «prod-verify» i notatfeltet i stedet for å gjettes.

## Resultatlogg
| Dato | # | Resultat | Notat |
|------|---|----------|-------|
| 2026-07-03 | 1 | PASS | OWID+World Bank, begge probe-verifisert (cors ✅); load-variabel brukt direkte; kriterium 2: prod-verify. |
| 2026-07-03 | 2 | PASS | OWID CO₂/BNP, begge probe-verifisert; eksplisitt «deskriptiv, ikke kausal» med reverskausalitet nevnt. Kriterium 2: prod-verify. |
| 2026-07-03 | 3 | PARTIAL (etter fix, kjøring 2) | Runde 1: R-koden ignorerte egen `# load`-variabel og kalte `read.csv(url)` på nytt mot en cors:false-URL (ville feilet i nettleser) — FAIL på kriterium 3. Runde 2 (etter DELIVERY-fix): ingen ad-hoc-fetch lenger; degraderer nå ÆRLIG til transkribert SSB-data («ikke maskinelt verifisert», kilde-URL oppgitt) i stedet for å late som probe lyktes — men ingen probe-verifisert kilde faktisk brukt (kriterium 1 fortsatt ikke oppfylt). Kriterium 2: prod-verify. |
| 2026-07-03 | 4 | PASS | DuckDB: fant SSB v0 POST-endepunkt, `# load /api/hent?...&body=...` brukt korrekt (ikke ad-hoc kode). Aldersestimat (67+ fra 10-årsgrupper) tydelig merket som lineær tilnærming. Kriterium 2: prod-verify. |
| 2026-07-03 | 5 | PARTIAL (etter fix, kjøring 2) | Runde 1: fabrikerte tabell-ID «09585» (aldri søkt/probet) og hevdet «503-feil» uten belegg; ingen `# load`-linjer, ren ad-hoc `requests.post/get`-kode — hard FAIL kriterium 1/3/5. Runde 2: ingen fabrikert ID lenger (kun 09174/09170/09789, alle faktisk spurt); men load-linjen bruker en Eurostat-URL-variant som probe viser `ok:false`, mens en ANNEN variant i samme probe-logg faktisk var `ok:true` — modellen leser ikke egen probe-logg presist nok. Fortsatt ikke ren PASS. Kriterium 2: prod-verify. |
| 2026-07-03 | 6 | PASS | FRED (fredgraph.csv, ingen nøkkel nødvendig — unngikk FRED_API_KEY-avhengighet elegant). `# load /api/hent?...` korrekt, load-variabel brukt direkte. God ærlighetshedge om redusert arbeidsstyrkedeltakelse. Kriterium 2: prod-verify. |
| 2026-07-03 | 7 | PASS (etter fix, kjøring 2) | Runde 1: R-koden ignorerte `# load`-variabelen og kalte `read.csv(url)` på nytt (samme mønster som Q3) — FAIL kriterium 3. Runde 2: full fiks — `# load /api/hent?...WHS8_110...` matcher eksakt den probe-verifiserte (ok:true) URL-en, og `mcv1_raw$value` brukes direkte i R-koden. Kriterium 2: prod-verify. |
| 2026-07-03 | 8 | FAIL (uendret etter fix) | Runde 1: ingen `# load` for POST-uttrekket (ad-hoc `pyodide.http.pyfetch` mot rå SSB-URL), pluss sannsynlig fabrikerte GlobalPetrolPrices-tall (probe kan ikke lese .xls-innhold). Runde 2: SAMME mønster gjentar seg — modellen skriver eksplisitt «gjør vi det som kode» og hopper over `/api/hent`-proxyen helt (POST rett mot data.ssb.no), og GlobalPetrolPrices-tallene gjentas uendret. Fiksen tok ikke for dette POST-innpaknings-tilfellet. Kriterium 2: prod-verify. |
| 2026-07-03 | 9 | PASS (etter fix, kjøring 2) | Runde 1: hevdet «probe-verifisert ✅» for en Norges Bank-URL som probe-loggen faktisk viser `ok:false` — brukte filtrert/feilet URL i stedet for den brede som lyktes. FAIL kriterium 1. Runde 2: full fiks — alle tre `# load`-linjer (nb_rente, ecb_dfr, ecb_mro) matcher eksakt de `ok:true`-probede URL-ene. Ren deskriptiv sammenligning, ingen kausalpåstand. Kriterium 2: prod-verify. |
| 2026-07-03 | 10 | PASS (ærlighetstest) | Korrekt: sier identifikasjon er vanskelig, viser til reelle metodevalg (diff-in-diff mot eldre barns mødre, panel-FE), ingen falsk kausal påstand. Sekundær observasjon (ikke jaget videre): ingen kode-blokk levert i det hele tatt (svarformat-kravet «ÉN kjørbar blokk» ble ikke fulgt), og litteraturtallene (Rønsen, Drange & Rege m.fl.) er ikke merket «fra modellkunnskap — verifiser» selv om de er trent-inn kunnskap. |
| 2026-07-03 | 11 | FAIL (miljø/infra, ikke promptfeil) | Begge kjøringer (før og etter fix) endte med `AbortError: The signal has been aborted` etter hhv. 324s/309s og 10-11 verktøykall (SSB + valg.no/valgresultat.no). Sannsynlig årsak: den ikke-strømmende siste-runden i `runAgenticStream` treffer 90s-timeouten (`AGENTIC_TIMEOUT_MS`) når konteksten er stor nok. Ingen svar produsert i noen av kjøringene — logget som infrastrukturfunn, ikke jaget videre innenfor budsjettet. |

**Oppsummering runde 1 (uten fix):** 5 PASS (1,2,4,6,10), 6 FAIL (3,5,7,8,9,11).
**Oppsummering runde 2 (etter DELIVERY-fix i `data-svar-prompt.ts` + `ssb`-registerfiks i `data-sources.json`, kun de 6 feilende spørsmålene kjørt på nytt):**
7 PASS (1,2,4,6,7,9,10), 2 PARTIAL (3,5 — forbedret fra FAIL, men ikke fullt kriterium-1-oppfylt), 2 FAIL (8,11 — 8 er en promptmiss for POST-innpakning i python-modus, 11 er et infra/timeout-funn).

## Runde 3 (v1.2, 2026-07-03): kun Q3, Q5, Q11 kjørt på nytt

Etter final-review-fiksene (DELIVERY-eksempelet justert til register-id +
proxy-form i tråd med `ssb`-registeroppføringen; `AGENTIC_TIMEOUT_MS` 90s →
180s i `_lib/anthropic.ts`). Transkripter i `.superpowers/sdd/eval/q{3,5,11}_v12.txt`
(ikke committet). Suksesskrav: Q11 uten AbortError; Q3/Q5 ikke verre enn før.

| Dato | # | Resultat | Notat |
|------|---|----------|-------|
| 2026-07-03 | 3 | PARTIAL (uendret) | Ingen ad-hoc-fetch: `# load /api/hent?url=<OECD-URL>` + `df <- hpi_raw` brukt direkte; ærlig merket «OECD-URL ikke probe-verifisert» og lønnstabellen «transkribert … verifiser». Kriterium 1 fortsatt ikke oppfylt: alle SSB-prober feilet fordi modellen skriver `data.ssb.no/api/v2/…` (uten `/pxwebapi/`-segmentet) — samme mønster fantes i runde 2-transkriptene, altså IKKE en regresjon fra v1.2-eksempelet, men et eget funn: modellen følger ikke registerets `sporrings_url_mal` bokstavelig. Kriterium 2: prod-verify. |
| 2026-07-03 | 5 | PARTIAL (litt bedre) | Runde 2-defekten (påstått «probe-verifisert» for en ok:false-URL) er borte: Eurostat-load-linjen er ærlig merket «ikke probe-verifisert (API-budsjettet ble brukt opp på SSB-forsøk)», og `emp_raw` brukes direkte (ingen ad-hoc fetch). Kriterium 1 fortsatt ikke oppfylt (probe-budsjettet gikk til SSB-prober som feilet — samme `/pxwebapi/`-mangel som Q3). Residual: guarded fallback med inline-tall «fra modellkunnskap» inkluderer utfallsvariabelen (brudd på stige-regelen nivå 3), tydelig merket — logget, ikke jaget. Kriterium 2: prod-verify. |
| 2026-07-03 | 11 | PASS på suksesskravet (infra-fiks verifisert); innhold PARTIAL | Ingen AbortError lenger: fullt svar levert på 166s med done-event (mot abort etter 309–324s før) — 180s-timeouten løste infra-funnet. Innholdet er ÆRLIG (sier rett ut at ingen kilde ble probe-verifisert, SSB 503; DiD-resultatet rammes inn som deskriptivt med seleksjonsskjevhet nevnt), men scriptet bruker en pyfetch-hjelpefunksjon mot /api/hent i stedet for `# load`-linjer (samme POST/flertrinns-mønster som Q8) — kriterium 3-miss, logget, ikke jaget (budsjett: én kjøring). Kriterium 2: prod-verify. |

**Oppsummering runde 3:** suksesskravet oppfylt — Q11 aborterer ikke lenger
(infra-fiksen virker), Q3/Q5 ikke verre (Q5 marginalt bedre på ærlighet).
Nytt tverrgående funn logget: modellen dropper `/pxwebapi/`-segmentet i
SSB-URL-er (forklarer de gjentatte 404/503-probene i Q3/Q5/Q11) — kandidat
for en quirks-presisering eller promptregel i en senere runde.

2026-07-23: nav-oppføring utsatt — standard CKAN package_search ikke verifisert (forsøkt: https://data.nav.no/api/3/action/package_search?q=arbeidsledighet → 404; https://data.nav.no/, /api/3, /api/3/action/status_show → alle 404 på en ellers levende host). NAVs datasett er allerede indeksert via datanorge/Felles datakatalog (bekreftet: POST https://search.api.fellesdatakatalog.digdir.no/search med q=«nav arbeidsledighet» gir treff), så `datanorge`-oppføringen dekker discovery-behovet inntil et NAV-spesifikt API er identifisert.
2026-07-23: Q13/16-variant kjørt live mot openai-responses (gpt-5.6, uten Anthropic-nøkkel): PASS på hele kjeden — search_catalog(scb, svensk+engelsk) → search_catalog(eurostat/oecd) → hosted websøk → probe(Eurostat une_rt_a) → script → kjøring med ekte tall (SE-ledighet 7.1/6.8/6.5/6.9 for 2016–2019) og plott. AVVIK 1: scriptet brukte requests-kode i stedet for # load-direktiver (brudd på leveringsreglene — vurder skjerpet regel/eksempel i MODE-blokken for nivå 2-modeller). AVVIK 2 (fikset i af641c2): sendWebMessage/mdInterpretResults-vaktene krevde Anthropic-nøkkel og sendte leverandør-brukere stille til settings.
| 2026-07-27 | 1 | PASS | Etter syntaks-cutover: probet med SSB-langformat-malen (stub+UseTexts), `ost.read` m/ eksakt ✅-URL (08517), tidy-samsvar hele veien, py-kompilerer, ingen ad-hoc. Kriterium 2: prod-verify. |
| 2026-07-27 | 3 | FAIL | Begge load-URL-er probet-FEILET eller aldri probet — «Kilde: …»-kommentarer som om verifisert, INGEN ærlig degradering. Probene gjettet `Tid=ALL` og `stub=år` (ugyldige PxWeb-v2-former). → EVAL-REGLER 2+3. |
| 2026-07-27 | 8 | FAIL | NY KLASSE: rå API-parametre som kwargs (`eurostat.read(..., geo="NO", siec=...)`) → høylytt parsefeil («ukjent argument») FØR kjøring; urllib-fallback; GlobalPetrolPrices-tall sitert tross FAIL-probe (fabrikasjonsklassen består). → EVAL-REGLER 1+4. |
| 2026-07-27 | 9 | FAIL (krit. 7 PASS) | Kanonisk ost mot norgesbank/ecb (ingen rå SDMX-URL ✓), men 0 ✅-prober (NB-nøkkelen 404 — reelt svar, verifisert m/ curl ±Accept); «probe-verifisert via søk»-påstand for FRED; fred krever nøkkel som ikke finnes i available_keys. → EVAL-REGLER 2+5. |
| 2026-07-27 | 13 | PARTIAL | To gode kilder: SCB via /api/hent m/ langformat-mal (stub+latin-1 ✓) og eurostat kanonisk m/ filters ✓ — men `requests.get`-fallback i try/except (forbudt klasse). → EVAL-REGEL 4. |
| 2026-07-27 | — | — | Prompt oppdatert m/ EVAL-REGLER 1-5 (needle-vaktet); re-kjøring av 3/8/9/13 følger. Harness: node-runner mot lokal netlify dev (BYOK-header fra .env); kriterium 2 = prod-verify som før. |
| 2026-07-27 | 8 (r2) | PASS | SNUDD etter EVAL-REGLENE: fant BEDRE kilde (SSB 09654 petroleumspriser, ✅-probet, langformat-mal m/ top(480)); load = eksakt ✅-URL; INGEN GlobalPetrolPrices (fabrikasjonsklassen borte); ingen ad-hoc. Kriterium 2: prod-verify. |
| 2026-07-27 | 13 (r2) | PASS | Eksemplarisk: prøvde stub-malen mot SCB, PROBENE viste FAIL (v2beta avviser stub-varianten — malen generaliserer IKKE dit, empirisk), falt riktig tilbake: bred ✅-URL + encoding iso-8859-1 + EKSPLISITT melt (håndterer bredformat, antar det ikke). pd.read_csv direkte etter CORS-sjekk (pandas-først ✓). NB: kontrollørens formMismatch-heuristikk feilpositiv (melt ≠ tidy-antakelse) — analysator rettet. |
| 2026-07-27 | 9 (r2) | NESTEN | Stor forbedring: riktig NB-dataflow ITERERT fram via prober (IR/M.KPRA.SD.R ✅), fredgraph.csv nøkkelfritt ✅ (regel 5 fulgt), ingen rå SDMX-URL. Én kwarg unna: startPeriod="2021-01" → høylytt parsefeil; kanonisk er years=. → regel 1 skjerpet m/ SDMX-tid-eksempel. |
| 2026-07-27 | 3 (r2) | PARTIAL | Mye ærligere: eksplisitt «TENTATIVE»-merking av uverifiserte kolonner + debug-instruks. Men «probe-verifisert via search_catalog» — katalogtreff er ikke probe (0 prober kjørt). → regel 2 skjerpet: kun probe-✅ teller. |
| 2026-07-27 | 3 (r3) | PASS | Full snuoperasjon: BEGGE loads ✅-probet (07230 + 11417 — byttet selv til hentbar lønnstabell), Tid=* korrekt (regel 3), «probe-verifisert ✅» nå SANT, melt-håndtering. |
| 2026-07-27 | 9 (r3) | PASS | years="2021:2026" brukt (regel 1-skjerpingen virket umiddelbart — null parsefeil); fredgraph via proxy ✅; nøkkelen M.SD.KPRA er innsnevring av den store ✅-probede kombinasjonen (derivasjon notert, ikke gjetting); kriterium 7 ✓. |
| 2026-07-27 | — | KONKLUSJON | 5/5 prioritetsspørsmål PASS etter to regelrunder (batch 1: 1/5). Målt regeleffekt: fabrikasjonsklassen borte (Q8), kwarg-klassen lukket (Q8/Q9), probe-disiplinen gjenopprettet (Q3), ærlig degradering + mal-fallback fungerer (Q13/SCB-stub-funnet). Resterende 12 spørsmål kjøres før neste promptendring (spec §7); harness gjenbrukbar (scratchpad/eval). |
| 2026-07-28 | 5 | PASS | Spørrelogikken virket: eksplisitt triage til deskriptiv m/ ærlig kausal-forbehold («for å isolere effekten kausalt ville man trenge…»), SSB 09174 ✅-probet, pd.read_csv DIREKTE (kriterium 10 ✓), næringsvis sammenligning. |
| 2026-07-28 | 10 | PASS m/ note | Tredje legitim vei: forskningssyntese m/ korrekte fakta (kontantstøtte aug 1998 ✓) og reell sitering (Drange og Rege 2013 ✓ — stikkprøvet). NOTE: lenkeløse siteringer — vurder krav om kilde-URL ved forskningssyntese-svar. |
| 2026-07-28 | 11 | PASS m/ note | HELE den kausale veien: VARIABELPLAN-tabell (roller inkl. avledet behandling + join-nøkkel), DiD-ramme, ærlig støy-forbehold for aggregerte data. NOTE: /api/hent-innpakket last (kriterium 10 ✗) tross SSB cors:true. |
| 2026-07-28 | 15 | PASS m/ note | Deskriptiv kontroll: lett vei HOLDT (ingen variabelplan-stillas ✓), DST FOLK1A ✅. NOTE: proxy-innpakket (kriterium 10 ✗) tross DST målt cors-åpen (curl-verifisert ACAO *). |
| 2026-07-28 | 15 (r2) | delvis | Etter regel 6: fortsatt proxy som primær, MEN legger selv til «bytt til pd.read_csv(url) lokalt»-kommentar — halv adopsjon. LÆRDOM: eksempler slår regler — NESTE SPAK er DELIVERY-blokkens egne eksempellinjer (viser fortsatt /api/hent-formen som kanonisk). Tas m/ neste målebatch. |
| 2026-07-28 | — | UTVIDET | Hans' innspill: (a) individdata finnes åpent — datatype-sjekk (aggregert/individ) inn i datarekognoseringen; (b) metodelisten eksplisitt ikke-uttømmende (+PSM); (c) METODEVERKTØYKASSE per modus (pyodide full / webR god m/ fixest-forbehold / duckdb deskriptiv + foreslå modusbytte). Umålt — inn i neste batch.
| 2026-07-28 | — | RUNDE | DELIVERY-eksempel-kirurgi + search_literature (OpenAlex) + Fast/Deep målt. FELLE målt underveis: (1) første eksempelversjon hadde halekommentar på direktivlinjene — modellen kopierte formen, parseren avviste («uventet tekst etter ')'»); fikset + permanent deno-vakt som parser promptens egne eksempelblokker. (2) netlify dev cacher edge-moduler i prosessens levetid — TS-endringer krever restart før måling (parallell til Chrome-js-cache-fella). |
| 2026-07-28 | 6 | PASS | Deep: fredgraph UNRATE ✅-probet, proxy KORREKT begrunnet i målt cors:false (probe-sannheten vant over regel 5s «CORS-åpen»-påstand — regelteksten overpromitterer, notert), deskriptiv vei, rent parse, direktivvariabel brukt direkte. |
| 2026-07-28 | 6 (fast) | PASS | Fast/Deep-PARET: budsjett holdt (1 websøk, 3 klientkall ≤4), samme ✅-kilde og ærlighet som Deep, kortere svar. «Reduserer ambisjon, aldri ærlighet» målt bekreftet på lett spørsmål. |
| 2026-07-28 | 10 (r2) | PASS | search_literature ADOPTERT umiddelbart: 12 litteratursøk, metodetabell m/ 7 DOI-siteringer — ALLE mekanisk verifisert reelle (doi.org handle-API 200×7), attribusjon stikkprøvet korrekt (Andresen&Havnes 2019, Österbacka&Räsänen 2021, Lalive m.fl. 2013). k10-notatet (lenkeløse siteringer) LUKKET. Kriterium 11 ✓. |
| 2026-07-28 | 2 | PARTIAL | Pandas-først ADOPTERT for OWID-CSV (pd.read_csv direkte etter cors:true-probe — kirurgiens målatferd ✓, kriterium 10 ✓) + god flerkilde-join m/ radtall. MEN World Bank-JSON (ikke tabellform) løst m/ urllib (regel 4-brudd) i stedet for registerets worldbank-adapter. NYTT MØNSTER: JSON-API → urllib-hullet; eksempelblokka mangler JSON-API-linje. Neste spak. |
| 2026-07-28 | 4 | PARTIAL (ærlig) | Alle 3 URL-prober FAILET (SSB v2-varianter); modellen fabrikkerte IKKE — kanonisk fallback ssb.read("07459", years, filters) m/ riktig `--`-form, «verifisert i metadata-oppslag» (ikke falskt «probe-verifisert»). Kriterium 1 strengt ikke oppfylt; ærlighet holdt. |
| 2026-07-28 | 7 | FAIL (krit. 3) | R-RE-FETCH-MØNSTERET TILBAKE: direktiver deklarert, men koden ignorerer direktivvariablene og re-henter via readLines(proxy_url) i fetch_gho()-hjelper (samme klasse som q3/q7 r1 2026-07-03). Ærlighet god (WHS8_111 eksplisitt «antatt, ikke probet»). BIFANGST: analyze.mjs fanget ikke readLines( — regex utvidet. |
| 2026-07-28 | 14 | FAIL (krit. 3) | SAMME R-klasse som q7: kanoniske direktiver (ssb_raw.read("06913", filters) ✓, SSB-malen stub+UseTexts+latin1 ✓, begge kilder ✅-probet ✓) — men koden re-henter selv (readr::read_csv(proxy_url)) og WB-JSON via fromJSON(url). R-modus ignorerer direktivvariabler: 2/2 i denne batchen. |
| 2026-07-28 | 12+17 | PASS | Kjørt ÉN gang (identiske inputs — q12 og q17 har samme spørsmålstekst og ingen nøkkel). Fant åpent GitHub-speil (datasciencedojo), ✅-probet cors:true, ren pd.read_csv DIREKTE (kriterium 10 ✓), overlevelsesrate etter kjønn levert, Kaggle-opphav oppgitt. q17-forventningen oppfylt; q12-forventningen («skal si at nøkkel må registreres») er FORELDET — åpne speil finnes, ingen fabrikasjon nødvendig. |
| 2026-07-28 | — | KONKLUSJON | Batch (fikset prompt, fersk server): 4 PASS (6, 6-fast, 10, 12+17), 2 PARTIAL (2, 4), 2 FAIL (7, 14). MÅLTE EFFEKTER av runden: pandas-først-eksemplet ADOPTERT (q2 OWID, q12+17 direkte read_csv); search_literature adoptert m/ 7/7 reelle DOI-er (q10); Fast/Deep-paret bekrefter designet (q6). TO TVERRGÅENDE mønstre til neste spak: (a) R-MODUS RE-FETCH — 2/2 r-kjøringer ignorerer direktivvariablene (MODE_R mangler eget eksempel; KRAV-teksten står i DELIVERY men eksempler slår regler); (b) JSON-API-HULLET — ikke-tabulær GET-JSON (World Bank) løses m/ urllib/fromJSON i stedet for direktiv/adapter (q2, q14); eksempelblokka mangler JSON-API-linje. q16 gjenstår (manuell OpenAI-leverandørkjøring). | |
| 2026-07-28 | 3 (r-bro) | PASS | FØRSTE rene q3-PASS i r-modus (3× PARTIAL/FAIL historisk): begge SSB-loads eksakt ✅-probet (07230+09786, stub-mal), cors:false ærlig → proxy, direktivvariablene bolig/lonn brukt DIREKTE (re-fetch-klassen borte), rent parse. |
| 2026-07-28 | 7 (r-bro) | PASS | Modellen skriver nå formen broen støtter: standard read.csv(url) DIREKTE mot to ✅-probede cors:true OWID-kilder, null direktiver (venstre kolonne), null ad-hoc (readLines/fetch_gho-klassen borte), «fra modellkunnskap»-merking på regionkart. |
| 2026-07-28 | 14 (r-bro) | PASS | EKSEMPLARISK — begge gårsdagens funn lukket i ett svar: kanonisk ssb.read("06913", filters/years) OG kanonisk wb.read("SP.POP.TOTL", countries) (JSON-API-hullet lukket — adapter i stedet for fromJSON), direktivvariabler brukt direkte, begge ✅. |
| 2026-07-28 | 2 (r-bro) | PASS | urllib-klassen borte: fant OWIDs FLATE gdp-per-capita-CSV i stedet for WB-JSON — begge loads rene pd.read_csv mot ✅ cors:true, py kompilerer. Pandas-først fullt ut. |
| 2026-07-28 | — | R-BRO-KONKLUSJON | 4/4 PASS. Begge tverrgående funn fra fastdeep-batchen MÅLT LUKKET: (a) R-re-fetch borte i alle tre r-svar (variabler brukt direkte ELLER standard-R som broen fanger); (b) JSON-API-hullet lukket begge veier (adapter i q14, flat-CSV-alternativ i q2). Kriterium 3-dømming fulgte grenseregel v2 (standard R for cors:true GET er PASS, ikke FAIL — MODE_R-prompten definerer). |
| 2026-07-28 | 11 (dtypes) | PASS m/ note | KRITERIUM 12 ADOPTERT: dtype={"knr": str} ved lesing + zfill-normalisering av join-nøkler + eksplisitt astype. Datakart+identifikasjonsstrategi m/ ærlig seleksjonsforbehold; wiki-direktiver; probe-budsjett ærlig deklarert oppbrukt. NB harness-fiks: pyKompilerer bruker nå PyCF_ALLOW_TOP_LEVEL_AWAIT (toppnivå-await micropip er gyldig Pyodide — falsk negativ rettet). |
| 2026-07-28 | 15 (dtypes) | DELT | Kriterium 12 EKSEMPLARISK (eksplisitt kvartal→dato-funksjon for 2024K1-klassen, to_numeric) — MEN regel 4-klassen i NY FORKLEDNING: direktivlinje m/ VARIABEL-argument (ugyldig grammatikk) kommentert som «autorativ», så «Simuler innlasting» m/ urllib. DST er MÅLT cors-åpen — riktig svar var ren pd.read_csv(url). NESTE SPAK: dynamiske URL-er + simuler-mønsteret. |
| 2026-07-28 | 2 (dtypes) | PASS | Mønstergyldig: begge OWID-CSV-er m/ pd.read_csv + dtype={"Code": str} på join-nøkkelen. |
| 2026-07-28 | 1 (dtypes) | PASS | Literal-direktiv m/ eksakt ✅-probet stub+UseTexts-URL, aku brukt direkte, eksplisitt to_numeric/astype(int), ærlig transkribert fallback (nivå 2). adHoc-flagget = harness-falskpositiv (urllib i kommentar). |
| 2026-07-28 | — | DTYPES-KONKLUSJON | Kriterium 12 adoptert 4/4 (dtype=str på koder/join-nøkler, eksplisitt dato/kvartal-håndtering, astype) — dtypes-prompten VIRKET umiddelbart. Score 3 PASS + 1 DELT (q15s regel 4-brudd er uavhengig av dtype-læren). Funn til neste spak: «simuler direktivet»-forkledningen ved dynamisk byggede URL-er; DST-cors-åpen-fakta bør evt. inn som quirk. |
| 2026-07-28 | 3 (r-dtypes) | PASS (etter brolinje) | Kjøring 1+2 (før brolinje): kriterium 12-R ADOPTERT (as.integer på join-nøkkelen aar begge sider, as.numeric på verdier) — MEN re-fetch-klassen VÅKNET IGJEN 2/2 (direktiver + read.csv/proxy mot samme kilder). Årsak identifisert: DTYPES-eksempelblokkens read.csv(url, colClasses=…) rett etter IKKE-hent-på-nytt-regelen inviterte kopimønsteret. Brolinje lagt til («på en ramme du ALT har fikser du typene direkte — IKKE hent på nytt bare for colClasses»); kjøring 3 REN: «Direktivvariabelen bolig er ferdig innlastet; bruker den direkte», typet join, 2/2 kilder ✅, null re-fetch. |
| 2026-07-28 | 7 (r-dtypes) | PASS | Probet cors:true OWID-CSV, direkte read.csv (venstre kolonne i grenseregelen), ingen kodekolonne-feller (Entity/Year) — kriterium 12 ikke-utløst, ingen brudd. |
| 2026-07-28 | 14 (r-dtypes) | PASS | EKSEMPLARISK igjen: direktivvariabelen norge_raw brukt DIREKTE (historisk FAIL-klasse fortsatt borte), WB via fromJSON mot ✅ cors:true (venstre kolonne), as.integer(aar)/as.integer(date) på BEGGE join-sider — kriterium 12-R levd ut uten å være eksplisitt nevnt i spørsmålet. |
| 2026-07-28 | — | R-DTYPES-KONKLUSJON | Kriterium 12-R adoptert 3/3 relevante kjøringer; MODE_R-dtypes-seksjonen VIRKET, men første versjon re-vekket re-fetch-klassen via eget eksempel (målt 2/2, fikset m/ brolinje, re-målt REN). Lærdom: et nytt prompt-eksempel kan undergrave en NABOREGEL — mål alltid naboklassene, ikke bare målkriteriet. ost_read_csv app-only-merket; ingen kjøring misbrukte den som RStudio-portabel. |
| 2026-07-28 | 15 (dyn-url) | PASS ×3 | Forkledningsklassen BORTE alle kjøringer: (a) kanonisk dst-adapter-direktiv (register-veien, gyldig grammatikk); (b) dynamisk URL (f-string-løkke over kvartaler) + pd.read_csv(proxy-form) i VANLIG KODE — regel 7 fulgt eksakt (urllib-flagget = urllib.parse.quote, enkoding ikke henting — kjent harness-falskpositiv); (c) etter probe-fiksen: IDEALSVARET fra det opprinnelige funnet — «Probe-verifisert ✅: cors:true, GET CSV direkte», dynamisk URL + ren pd.read_csv UTEN proxy. Ingen ugyldige direktiver, ingen «simuler», ingen urllib-henting. |
| 2026-07-28 | 1 (dyn-url-vakt) | PASS | Naboklasse-vakten grønn: literal-direktiver der de hører hjemme (ssb-register, stub-mal, ✅-probet), direktivvariabel brukt, null ad-hoc — regel 7 degraderte IKKE direktivbruken. |
| 2026-07-28 | — | INFRA-FUNN (probe) | q15-batchen avslørte at «DST-cors-quirken» var en PROBE-BUG: DST sender ACAO KUN ved Origin-header i forespørselen; probens server-side fetch sendte ingen → falsk cors:false → modeller proxy-pakket unødig (regel 6 undergravd). Fikset (probe sender Origin, godtar ACAO-ekko; 4 nye deno-tester). FRED kontrollmålt: EKTE cors:false (ingen ACAO selv m/ Origin) — regel 5 står. |
| 2026-07-28 | — | DYN-URL-KONKLUSJON | Regel 7 + kryss-lenke fra grammatikk-kravet (nabolærdommen anvendt proaktivt) + probe-fiksen: q15-klassen lukket 3/3, naboklassen intakt, og rotårsaken bak proxy-overforbruket fjernet i infra i stedet for å quirk-dokumenteres i prompt. |
| 2026-08-01 | — | INFRA-FUNN (oecd/worldbank-lasting) | Hans meldte «mange feil og forsøk» ved AI-datalasting fra OECD/World Bank. Diagnosen: promptene var ikke for kompliserte — de MASKINGENERERTE HINTENE lærte bort former grammatikken/lasteren avviser. Fire funn, alle verifisert med ekte parser + live API: (a) **slash/komma**: search_datasets/search_catalog ga flowRef som `<agency>/<flow>`, men data-endepunktet krever `<agency>,<flow>` — slash 404-er «Could not find Dataflow» (adapterne returnerer nå komma; table_metadata godtar begge); (b) **manglende connect-linje**: ALLE how_to_read-hint (og DELIVERY-eksempelet) viste bare read-linja, mens resolve krevde `# <id> = ost.connect("<id>")` → «ukjent kilde-alias» (fikset i infra: registerkilde-id som receiver ER en implisitt connect); (c) **quirks mot EVAL-regel 1**: oecd/nb/ecb-quirks anbefalte `/all` + `startPeriod=`, som parseren avviser — omskrevet til kanonisk vokabular; (d) **frase-substring-søk**: «health spending» ga 0 av 1540 OECD-dataflows (nå ordbasert scoring som worldbankSearch, live: 20 treff). |
| 2026-08-01 | — | INFRA-FUNN (probe mot sdmx) | Live smoke-test av fiksene avdekket en STØRRE feilklasse ingen fixture-test kunne fanget: probe sendte ingen Accept-header, så OECD svarte SDMX-**ML**. probe rapporterte da `ok:true`, note «CSV», og hele XML-dokumentet (målt 85 000 tegn) som ÉN kolonne — modellen fikk ✅ på et skjema scriptet aldri møter, og konteksten/budsjettet ble spist opp. Sannsynlig hovedårsak til «mange forsøk». Fikset i tre lag: probe sender lasterens Accept + Accept-Language for sdmx-kilder (registry-oppslag), probe avviser XML ærlig (`ok:false` m/ veiledning), og /api/hent forsyner sdmx-Accept med Accept-Language. Bonusfunn: OECDs DATA-endepunkt 500-er «languageTag1» på Denos fetch uten Accept-Language — samme felle som strukturendepunktet (2026-07-25), nå dekket begge steder. Lærdom bekreftet på nytt: live smoke-test før push finner det mock-ene ikke kan. |
