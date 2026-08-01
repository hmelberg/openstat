# Roadmap — safestat/openstat

*Levende dokument. Oppdatert 2026-07-23. Punktene er ikke forpliktelser, men
prioritert idéliste. Kilder: designdok/reviews fra jamovi 2.0 fase 1–3
(docs/PLAN_jamovi_*.md, docs/jamovi-validation.md) + løpende samtaler og Hans' testing.*

## Prioritering av det gjenstående (vurdert 2026-07-23)

**Viktigst — anbefalt neste økt:**
- [ ] **Numerisk validering av jamovi-modus mot ekte jamovi** — eksistensiell
      for tillit i et statistikkverktøy: stille gale tall er den verste
      feilklassen produktet kan ha, og skaden skjer utenfor appen. UX er
      testet (Hans 9/7); sjekklisten med 9 rader står klar i
      docs/jamovi-validation.md. Krever Hans (manuell side-om-side), én
      konsentrert økt.

**Ferdig 2026-07-23 — cache-skew ved deploy (var vurdert nest viktigst):**
- [x] SW/py-cache-strategien: (a) begge motorenes `fetchText` bærer nå
      `?v=M2PY_VERSION` (samme konvensjon som __ensureUi); (b) sw.js sin
      enumererte SWR-liste (som DRIFTET — manglet ui_brython/ui_mpy/
      shared/ui_core, de tre filene som faktisk krasjet 20.–22.7) erstattet
      med én suffiks-regel for alle lokale .py; (c) SWR-nøkkelen inkluderer
      søkestrengen, så en versjonsbump gir cache-MISS → ferskt svar på
      FØRSTE last etter deploy (før: serve-stale-først); (d) CACHE bumpet
      v33. Deploy-simulert i browser: ny ?v= → egen nøkkel + ferskt innhold.
      M2PY_VERSION-disiplinen dekker dermed nå OGSÅ brython/micropython-
      filene — bump ved enhver .py-adferdsendring.

**Mindre viktig (beskrevet for fremtidige økter):**
- [ ] Engine-notatbøkenes auto-kjøringsrest: brython/mpy/js-auto-kjøringen
      har et lite klikk-svelg-vindu via `engineNbRunActive`-porten (samme
      klasse som første-kjøring-fiksen 2477e76 løste for pyodide-veien, men
      mye mindre vindu — motor-boot er 1–3 s). Ta ved neste berøring av
      den porten.
- [ ] Manuell AI-røyktest av auto-retting nivå 1 mot LASTET runtime
      (trenger nøkkel-flyt): provoser en syntaksfeil i et python-svar og se
      at reparasjonsrunden fyrer med linjenummer; samme for R.
- [ ] `display-mode:"form"`/hide-code er semantisk levert men visuelt
      sovende til per-celle-kodevisning eventuelt gjeninnføres (post-4a
      finnes ingen — Rå tekst er kodeflaten). Ingen handling nødvendig; kun
      relevant hvis cellevisningen endres.
- [ ] AI auto-retting nivå 2 (sandkasse-prøvekjøring) — kun hvis nivå 1
      viser seg å fange for lite i praksis.
- [ ] jamovi RM-ANOVA + CFA, scatr-wasm (venter på Hans), pakkekrav-
      direktivet, minnebruk på svake maskiner — funksjonalitet/komfort,
      ikke risiko; se seksjonene under.

## jamovi-modus — gjenstående arbeid

**Analyser (24 av ~26 i menyen; disse to gjenstår):**
- [ ] **Repeated Measures ANOVA** (anovaRM) — den tyngste gjenstående biten: krever
      RM-design-UI (definer faktorer med navn+nivåer via `rm`, tilordne målekolonner
      til celler via `rmCells`) + rmTerms/bsTerms (modellbyggeren gjenbrukes),
      kontraster og utvidet postHoc-form. Estimat: egen dedikert økt.
- [ ] **CFA** — faktor-definisjons-UI (`factors` = Array of Group {label, vars}:
      navngi latente faktorer og tilordne variabler; ligner rolleboksene med
      redigerbart navn + «legg til faktor»-knapp) + `resCov` (Pairs, finnes).
      FØRSTESTEG: lavaan-røyktest i webR (kjøring er utestet; lasting virker).
      Estimat: én økt, forutsatt at lavaan kjører.

**Figurer (utsatt av Hans 9/7 — tas når han sier fra):**
- [ ] Bygge nyere `scatr` fra jamovi sitt GitHub-repo som wasm (rwasm-verktøyet;
      finnes IKKE ferdigbygget på r-universe — verifisert). Gir Bar/Box/Histogram/
      Line/Pareto som egne analyser med alle ~60 stilopsjonene (error bars, titler,
      akser, legend, fonter). Krever eget wasm-byggmiljø (emscripten) — den tyngste
      enkeltjobben i køen.
- [ ] Pareto Plot tilbake i menyen (avhenger av punktet over)

**Validering:**
- [ ] Manuell side-om-side-validering av TALLENE mot ekte jamovi-appen —
      sjekklisten med 9 rader står klar i docs/jamovi-validation.md (UX er testet
      av Hans 9/7; den numeriske gjennomgangen gjenstår)

**Teknisk gjeld (fra reviewene, småting):**
- [ ] Skille pliktige/valgfrie roller i «Velg variabler»-hintet (i dag kan hintet
      maskere reelle R-feil når en valgfri rolle står tom)
- [ ] `refLevels`: feilet nivå-henting gir permanent deaktivert nedtrekksliste
      uten retry (kun ved motorfeil; lav prioritet)
- [ ] NMXList: tømt valg sender `character(0)` — live-verifisert kun for
      jmv::mancova; de 6 andre analysene med NMXList deler antakelsen uverifisert
- [ ] Bilde-rekkefølgenøkler i `.jmv_serialize` (i dag ordre-basert matching mot
      captureGraphics; robust nok, men skjørt ved fremtidige jmv-endringer)
- [ ] `console.warn` ved bilde-underskudd i renderJmvResults (feilsøkingshjelp)
- [ ] Bayes factor-opsjonene (bf/bfPrior): krever wasm-bygg eller stub av `deSolve`
- [ ] Måle minnebruk på svake maskiner; `jamovi_v1`/«Jamovi light» er nødbrems

**Avklaringer (Hans bestemmer):**
- [ ] Output-rens ved modusbytte: jamovi-resultater tømmes også ved
      jamovi→python→jamovi (konsekvens av ønsket rensing ved inngang).
      Alternativ: bevare jamovi-resultatene over en tur innom andre moduser.
- [ ] Modus-gjenoppretting ved sidelast: appen kan i dag ikke starte rett i
      jamovi-modus (lazy-registrering; faller tilbake til standardmodus).
      Ville kreve at MODE_MODULES-moduler lastes før restoreEditorMode.

**Ferdig (jamovi fase 1–3, alt merget 2026-07-09):** ekte jmv 2.7.7 i webR (pinnet
v0.6.0, SW-cachet); 24 analyser inkl. ANCOVA/MANCOVA/Friedman/Log-Linear/Factor-
gruppen; u.yaml-genererte dialoger m/ grupper, grid, nøsting, enable-avhengigheter,
NMXList-checkparts og radiogrupper; modellbygger (interaksjoner/post hoc/blocks);
refLevels-velger m/ nivåer fra data; live-oppdatering uten Kjør-knapp; skjult
toppmeny m/ bryter; ikoner + finpolish; «Jamovi light» (v1) som egen modus;
websocket-stub for contTables; kopier-knapp på tabeller og figurer; datasett-synk
på tvers av moduser; output-rens ved inngang.

## Publisering (lagt til 2026-07-27)

- [ ] **Selvstendig publisering** — publiserte HTML-dokumenter krever i dag
      appens `js/`-mappe på samme host (relative script-stier; virker ikke
      åpnet fra `file://` eller kopiert alene til en annen host — bekreftet i
      Hans' test 2026-07-27). Mål: et valgfritt «helt selvstendig»-nivå ved
      publisering som inliner de nødvendige js-modulene (+ ev. pinner
      CDN-motorene) og et valg om å bake inn data. Fundamentet finnes:
      bro-cachen bakes allerede som `ostbridgedata_`-tags (S4, 2026-07-27),
      og direktivdata som spec-tags — det som mangler er inlining av
      script-avhengighetene og et UI-valg. Ikke prioritert nå (Hans
      2026-07-27). NB: `exportPublish`-tooltipen sier fortsatt bare
      «# read»-data bakes — oppdateres (med i18n-nøkkelen) når dette tas.

## Interaktive elementer — backlog (lagt til 2026-07-21)

*Kontekst: fase 1–3 av spec 2026-07-20-unified-interactive-elements-design.md
er levert (display policy v2, delt konstruksjonskjerne, delt fasadekjerne).
Brukeroversikt: docs/interactive-elements.html.*

**Ferdig (fase 4a/4b, spec 2026-07-21-explicit-containers-design.md):**
`sync_to`-seeding pinnet + dokumentert (4a); `into=`-håndtak-retur,
`ui.row`/`ui.column`/`ui.grid` + `Element.add(area=/span=/align=)` med
område-erstatt-semantikk, og Containers-seksjonen i
docs/interactive-elements.html (4b) — alt levert og testet.

**Colab-paritet for `#@param` (syntaksen er ellers Colab-kompatibel;
run:auto-default og placement/R/JS-støtte er OpenStat-utvidelser Colab mangler):**
- [x] `#@title` — celletittel-linje med form-meta (`{run:"manual"}` som
      celle-run-default); levert 2026-07-22
- [x] `#@markdown` — prosa-linjer rendret i skjemastripen, kildeorden;
      levert 2026-07-22
- [x] `display-mode: "form"` per celle — skjul koden, vis bare skjemaet;
      levert 2026-07-22 via det tidligere sovende `hide-code`-celleflagget
      (js/cells.js KNOWN_FLAGS, `#%% python hide-code`/`#tag.hide-code = true`
      — nå vekket og satt/fjernet reaktivt av `#@title`s
      `{display-mode:"form"}`-meta, se js/param-forms.js). Rå tekst forblir
      fluktveien til å se/redigere koden (ærlig forbehold: post-4a rendrer
      INGEN doc-celle koden sin per-celle uansett, så klassen er per i dag
      semantisk/fremtidsrettet, ikke synlig-endrende).

**Småting-batch (levert 2026-07-22, plan 2026-07-22-smaating-batch.md,
browser-verifisert):**
- [x] Høflig R-feilmelding for `ui_row`/`ui_column`/`ui_grid`
- [x] `ui.grid(..., style="rå css-streng")` bevarer nå templaten
- [x] brython/mpy demping-hjørner: mellomrom-før-paren dempes,
      `_navn  # kommentar` dempes, `ui.slider(...) + 1`-haler dempes IKKE
      lenger feilaktig (paren-slutt-krav; kjent grense: parenteser i
      streng-argumenter — dokumentert i runnerne)
- [x] To manglende test-pins (demping × echo, regel 3–4 × only_last)
- [x] Snubletråden ser nå konstant-redefinisjoner (Assign-innsamling)
- [x] Døde configure-placeholders fjernet
- [x] `_`-prefikset element monteres ikke lenger i brython/mpy
      (pyodide-paritet, tvillingtester)

*M2PY_VERSION-disiplin: bump ved enhver adferdsendring i pyodide/ui.py
eller shared/ui_core.py (deler versjonsparam) — håndhevet i fase 4b/5 og
i småting-batchen.*

**Bevisste features-i-backlog (ikke hygiene):**
- [x] Første-kjøring-tomt — LØST 2026-07-22 (commit 2477e76): rotårsaken var
      IKKE boot-venting, men auto-kjøringen av starteksempelet som gjorde
      Kjør-knappen til «Avbryt» — brukerens første klikk i det vinduet ble
      en stille abort. Nå avbrytes auto-kjøringen og brukerens dokument
      kjøres automatisk; «Venter på Python-motoren…»-status ved kjøring før
      boot; permanente [kjør]-brødsmuler (console.debug) ved kjøregrensene.
      Kjent rest (lite vindu): engine-notatbøkenes auto-kjøring
      (brython/mpy/js) har samme teoretiske svelg via engineNbRunActive —
      ta ved neste berøring av den porten
- [x] `ui.button` med element-barn — levert 2026-07-22
      (ui-features-batch; label_els i spec, miks av tekst/element)
- [x] `.add([v1,v2], area=)` auto-stakker nå alle payloads i kildeorden —
      levert 2026-07-22 (ui-features-batch)

## AI-assistenten

- [x] **Auto-retting nivå 1 for python- og r-modus i v2-flyten** — levert
      2026-07-22 (commits b3daf09+766f558): modus-dispatch i `runFastQueryV2`
      (microdata byte-frosset, reviewer-verifisert), syntakssjekk via
      ALLEREDE LASTET Pyodide `compile()` / webR `parse()` (booter aldri for
      validering — {skipped} ellers), linjenummer i feilene, ukjent-variabel-
      sjekken grunnet i microdata-segmentene (unngår falske positive fra
      divisjoner/stier), passiv-varsel-fallback uten kodefence, og backendens
      `prior_script`-fence gjort modus-riktig (var hardkodet microdata —
      review-funn). BEVISST kuttet: kolonnenavn-sjekk mot `lastDatasetInfo`
      (post-kjøring-tilstand er feil orakel for et ferskt svars egne
      #micro-aliaser — ville gitt falske reparasjonsrunder). Ikke røyktestet
      mot LASTET runtime i browser ennå (trenger AI-nøkkel-flyt) — ta en
      manuell sjekk ved neste anledning.
      - Nivå 2 (senere, hvis nivå 1 ikke fanger nok): sandkasse-prøvekjøring mot
        kopi av aktivt datasett med timeout; send runtime-feilen til
        reparasjonsrunden. Utfordringer: bivirkninger, nettkall, kjøretid.
- [x] Vurdere Send⚗︎-flyten (v2) også for openstat-brukere på ikke-micro-URL-er
      — løst 2026-07-10: Send rutes nå av aktiv modus (microdata-modus → v2),
      ikke av URL-en
      (i dag går de til data-svar som er admin-gated — bevisst valg 9/7, men verdt
      å revurdere hvis vanlige brukere trenger AI-hjelp uten egen nøkkel)
- [ ] **Modustilpassede AI-svar (notert 2026-07-31, etter svar-porten):**
      `/api/svar` prompter i dag alt som ikke er r/duckdb som python
      (`coerceDataMode`, `_lib/svar-prompt.ts:6-8`). Tre tilpasninger ønskes:
      1. **javascript-modus:** egen MODE_JS-blokk slik at svaret kommer som
         kjørbar js-kode når man spør fra js-modus (i dag får man python
         som js-motoren ikke kan kjøre).
      2. **brython/micropython:** variant av python-blokken som sier mer om
         begrensningene — man har litt av pandas m.m., men ikke alt
         (micropython smalest); modellen skal ikke anta full pyodide.
      3. **pyodide (python-modus):** tillegg om at man faktisk kan
         installere flere bibliotek enn de forhåndslastede hvis det
         hjelper (micropip: pyodide-pakkelista + rene wheels fra PyPI) —
         med liste eller lenke,
         https://pyodide.org/en/stable/usage/packages-in-pyodide.html.
      Husk speilkravet svar-prompt.ts ↔ prompts/svar.md. askstat har kun
      python/r/duckdb-moduser, så runden er openstat-spesifikk (men
      brython/mpy-motorfellene er dokumentert i brython-engine-notatene).

## Pakkeinstallasjon (python/r)

*Status i dag: autoinstallasjon er PÅ i begge språk — Python: `loadPackagesFromImports`
+ micropip-fallback per import (index.html preRun); R: `library()`-overstyring som
kjører `webr::install()`. Service workeren cacher pakke-hostene (offline etter første gang).*

Mål: brukeren skal kunne installere alt fra Pyodide-wheels til ting man kan
prøve fra PyPI eller GitHub. Nivåene:

- [ ] **Pakkekrav-direktiv** (husets direktiv-stil er pythonsk siden
      2026-07-27, så formen må avklares mot den grammatikken — ikke
      `# requires: <navn>`) med:
      - versjonspinning (`plotnine==0.13`)
      - alias-kart for navne-mismatch (`sklearn`→scikit-learn, `PIL`→pillow, `cv2`→opencv)
      - eksplisitte kilder, se nivåene under
- [ ] **Python-kilder**, i økende dristighet:
      1. Pyodide-bundlede pakker (auto, virker i dag)
      2. PyPI rene Python-wheels via micropip (auto, virker i dag)
      3. Wheel-URL: `micropip.install('https://…/pakke.whl')` — inkl. wheels fra
         GitHub-releases (raw/objects.githubusercontent har CORS)
      4. GitHub-repo uten wheel (kun ren Python): hent zip → `pyodide.unpackArchive`
         → sys.path; direktivsyntaks f.eks. `# ost.require("github:bruker/repo")`
         (formen er ikke avgjort — se punktet over)
      (Grense: pakker med ubygget C/Fortran kan ikke installeres i nettleseren.)
- [ ] **R-kilder**:
      1. repo.r-wasm.org-binærer (auto, virker i dag)
      2. **r-universe**: nesten alle CRAN- og GitHub-R-pakker finnes som wasm-binærer
         der — `webr::install(pkg, repos='https://<bruker>.r-universe.dev')`;
         direktivet kan ta `bruker/repo` og utlede universe-URL-en
      3. Egenbygde wasm-pakker med rwasm (som planlagt for nyere scatr)
      4. `require()`/`pkg::` trigges ikke av dagens `library()`-overstyring — dekkes
         av direktivet
- [ ] **`!pip install X`-høflighet**: preprosesser Jupyter-vane-linjer til
      micropip-kall (eller vis vennlig melding om at import auto-installerer)
- [ ] Tydelig feilmelding når en pakke ikke finnes som wasm (med peker til
      hva som faktisk støttes)

## Datalag / montering (lagt til 2026-07-24)

- [x] **format(duckdb)** — montert datasett som view i DuckDB-katalogen
      (null minnekost, kolonne-henting ved behov); view-registeret
      {navn: sql} i js/duckdb-views.js re-registrerer ved hver øktstart
      (øktene er ferske per kjøring). I duckdb-modus er view-montering
      defaulten for alle monteringsdatasett. Levert 2026-07-24.
- [x] **API-kilder (SSB/PxWeb først)** — LEVERT 2026-07-24 (spec
      2026-07-24-pxweb-sources-design.md): `kind(pxweb)` med
      `# load ssb/<tabellid>[?valueCodes…] as navn`; data hentes som
      json-stat2 (lang-format, UTF-8 — default-CSV-en er pivotert og
      iso-8859-1) og konverteres i js/pxweb.js til koder + value;
      metadata-endepunktet mater kildekatalogen og `ssb/05839.`-tab UTEN
      nedlasting. Composite keys levert som forutsetning: `key(region aar)`
      og `join … on a, b` er arrays hele veien, `USING (a, b)` i
      kompilatoren og `merge(on=liste)` i pandas-fallbacken. Bifangst:
      duckdb-fallbackveien (Pyodide alt bootet) strippet aldri
      direktivlinjer fra SQL-segmenter — fikset (stripDataDirectiveLines).
- [x] **Eurostat som json-stat2-gjenbruk** — LEVERT 2026-07-25:
      `kind(eurostat)` (`# connect https://ec.europa.eu/eurostat/api/
      dissemination/statistics/1.0/data as eu, kind(eurostat)` +
      `# read eu/nama_10_gdp?geo=NO&… as bnp`). Samme json-stat2-konvertering
      som pxweb (det VAR poenget); egen URL-form (format=JSON, lang=en
      default, direkte dimensjonsfiltre). Dekker lastelag, montering,
      eksport (_px_frame gjenbrukes), openstat.py (kind="eurostat") og
      kildekatalog/tab (lastTimePeriod=1-probe med tidsparametre strippet —
      Eurostat 400-er ved kombinerte tidsvinduer, funnet i verifiseringen).
      Verifisert live i CPython og editor: norsk BNP (6×6, 470 358,7 MEUR
      i 2025). CORS er * (verifisert).
- [x] **API-kinds fase 1 (sdmx/dbnomics/worldbank)** — LEVERT 2026-07-25
      (spec 2026-07-25-api-kinds-design.md). Generalisert etter Hans'
      innspill: protokoll-adaptere i js/api-kinds.js fremfor kilde-kinds,
      og kildenavn som inngang (`# connect oecd` — registeret bærer kind;
      `kind(oecd)` aliases til sdmx). Premisset fra forrige økt («OECD
      krever egen SDMX-JSON-konverterer») var FORELDET: API-et leverer
      SDMX-CSV direkte via Accept-header (application/vnd.sdmx.data+csv;
      labels=id) — null konverterer. kind(sdmx) dekker OECD + Norges Bank
      (Accept-veien) + ECB (406 på Accept → format=csvdata-fallback) og
      trolig IMF (uverifisert); kind(dbnomics) dekker ~80 kilder (JSON →
      lang-format-flatener, observations=1 tvinges, maks 1000 serier);
      kind(worldbank) (JSON [meta,rader], per_page=20000-default,
      sideløkke). VIKTIG FELLE (styrer alt videre): SDMX 2.1-API-ene
      ignorerer ukjente parametre STILLE (c[DIM]=-filtre ga Colombia/HUF/
      AUD-rader der NOR/USD var bedt om) — send aldri uverifiserte
      parametre. Dekker lastelag (Accept via item.fetchHeaders + hent-core
      videresender accept), montering, eksport (_sdmx_frame m/UA openstat —
      urllib 403-er hos OECD uten! + _wb_frame/_dbn_frame), openstat.py
      (paritet, delte fixtures), register (ecb+dbnomics nye; oecd/
      norgesbank/worldbank/eurostat fikk kind+korrigert base_url).
      Verifisert live: eksportert CPython mot 4 API-er, nettleser-datalag
      mot alle 5, editor-run (webR) mot Verdensbanken.
- [x] **API-kinds fase 2: kanonisk vokabular** — LEVERT 2026-07-25 (spec
      §3): years(a:b)/countries()/regions()/indicators()/filters(k=v …) på
      read-linjen, oversatt per kind i translateCanonical (ren funksjon,
      testet): worldbank (sti syntetiseres fra indicators+countries; date=;
      åpne ender → 1900/2100, probet ok), eurostat (geo=, since/until­-
      TimePeriod), pxweb (valueCodes[Region/ContentsCode]; years lukket →
      eksplisitt liste — range() FINNES IKKE i v2 (probet 400); åpen start →
      from(a), probet ok), sdmx (startPeriod/endPeriod; countries/
      indicators/filters → punktumnøkkel via CSV-header-introspeksjon:
      lastNObservations=1-probe, kolonnene mellom prefikset (DATAFLOW|
      STRUCTURE,STRUCTURE_ID,ACTION|KEY) og TIME_PERIOD er nøkkeldimen-
      sjonene i orden), dbnomics (years klient-side; resten hard feil med
      maske-hint). Hard-feil-regelen overalt (jf. stille-ignorerings-
      fellen). Eksporten emitterer runtime-introspeksjon (_sdmx_key_dims/
      _sdmx_key i py+R) og dbnomics-årsfilter; openstat.py har full
      paritet (delte fixtures sdmx_headers.json m.fl.). Verifisert live:
      eksportert CPython ga KUN NOR/SWE fra OECD (168×21) — beviset på at
      nøkkelen faktisk filtrerer; nettleser-loader det samme (43 rader NOR).
      Åpent: WHO GHO (API-et svarte ikke 2026-07-25), IMF-liveverifisering,
      katalog-/tab-probe for nye kilder, `<dim>_label`-kolonner.
- [ ] Fortsatt åpent fra pxweb-økten: `<dim>_label`-kolonner som opt-in og
      tabell-SØK (`/tables?query=`) i katalogen.
- [x] **Datacache-styring (a)** — LEVERT 2026-07-25: `cache(<ttl>)`-opsjon
      på connect/load (`90s`/`30m`/`2h`/`1d`; `cache(0)`/`cache(no)` buster
      begge lag) — opt-in disk-L2 via Cache API ('m2py-data') under
      _bufCache, overlever side-reload (browser-verifisert: identisk
      x-m2py-fetched-at etter reload; bust fjerner oppføringen). Bevisst
      opt-in: stille foreldede tall er verre enn en ekstra henting.
      Gjenstår (c): varmere tolk-gjenbruk — se «Diverse / uavklart» —
      re-bindingen per kjøring er fortsatt den strukturelle kostnaden.
- [x] **Eksport-gap: montering + pxweb** — LEVERT 2026-07-25: eksporten
      emitterer nå selvforsynt kode for kind(pxweb) (_px_frame/px_frame_-
      hjelper, json-stat2 → langt format i både python og R) og for
      montering (create-dataset/import/join → kildelesing + merge-kjeder
      med composite keys; duckdb/sqlite-kilder får ærlig kommentar+warning).
      VERIFISERT ved ekte kjøring: samme eksporterte script ga (360, 5) og
      (360, 3) i både lokal CPython og Rscript mot live SSB-API.
- [x] **openstat.py (pakke-punkt 1+2)** — LEVERT 2026-07-25: én fil (rot,
      som duckdb_bridge.py) med connect/read/dataset/add/datasets — kjører
      UENDRET i CPython (urllib) og Pyodide (synkron XHR; browser-verifisert
      i editoren: import openstat → read('05839') → (360, 5)). Ring 1-ren:
      stdlib+pandas; duckdb kun som valgfri parquet-pushdown. Preloades i
      editor-python (notebook_prose-mønsteret). Kontrakts-fixture delt
      mellom pytest og node (tests/fixtures/pxweb_dataset.json).
- [ ] **openstat-pakken — konklusjoner fra designdiskusjonen (Hans+Claude
      2026-07-25):** Mål: script skal kunne tas UT av editoren og virke i
      vanlig python/R, og samme verb skal virke i pyodide/webr/brython/mpy.
      Avgjort: (1) navn `openstat`, verb på engelsk: `connect`/`read`/
      `dataset`+`add`/`datasets()` — `read` valgt fordi det er intuitivt og
      kollisjonsfritt (`load` maskerer base::load i R; get/pull/fetch/open
      kolliderer alle med noe). (2) Ring-modell for JS-bruk: ring 1 =
      kontrakten, ren implementasjon (språkets standard + synkron XHR) som
      virker i ALLE verter (også JupyterLite/andres webR); ring 2 = felles
      browser-goder (SW-cache) bak feature-detection; ring 3 = editor-goder
      (sidebar, proxy, duckdb-wasm-montering). JS er lov som FORBEDRING,
      aldri som krav. (3) Synkron XHR er den ensartede transporten (lovlig
      i workers — webR er derfor MINST problematisk, ikke mest); JS-broen
      kan ikke bære synkrone pakkeverb (Promise-basert). (4) duckdb er IKKE
      limet (finnes ikke i pyodide/brython/mpy som pakke; Promise-API via
      js-interop bryter sync-kontrakten) — valgfri CPython-akselerator og
      fortsatt editorens monteringsmotor. Limet er kontrakten + delte
      test-fixtures + tekstformatene (json-stat2/csv). (5) Variabel-for-
      variabel-bygging dekkes av dataset(key)/add-byggeren på ramme-nivå —
      SQL-kompilatoren imiteres ikke i pakken; kolonne-pruning som
      `columns=`-kwarg. (6) Kost/nytte-beslutning: FULL pakkefamilie er
      IKKE verdt det nå (0 brukere, 4-5× varig vedlikehold) — punkt 1+2
      under leveres, resten venter: R-pakken (webR-porten er dyreste hale),
      brython/mpy-modulene og PyPI/CRAN tas først når en reell bruker
      etterspør det. Jamovi-valideringen står fortsatt øverst.
      - [ ] Punkt 3 (VENTER på reelle brukere): openstat R-pakke (vanlig R
            → webR-port), brython/micropython-moduler, PyPI/CRAN-publisering,
            SW-som-datacache for pakke-sync-XHR, direktiver-som-sukker-
            kompilering.
- [ ] **Navngitte hemmeligheter — fjern nøkkel-literaler fra script**
      (Hans' idé 2026-07-26, i forlengelsen av `key` → `secret_key`-omdøpingen).
      `js/keys.js` er allerede et generisk `type→verdi`-register i localStorage
      (`md_keys`, med `get/set/remove/registered`), brukt for anthropic/github/
      fred. Utvid til brukerregistrerte navn, slik at
      `secret_key="github"` slår opp `Keys.get('github')`.
      Motivasjon: `secret_key="ask"` alene er for tungvint for lange API-nøkler
      — folk går rundt det ved å lime nøkkelen inn i scriptet igjen, altså
      nøyaktig det vi vil unngå. Navngitt oppslag gir både «ingen hemmelighet
      i scriptet» OG «skriv den én gang».
      Gevinsten er at `scrubKeys` kan **slettes helt**: både `"github"` og
      `"ask"` er ufarlige strenger, så det finnes ikke lenger noe å maskere,
      og hele klassen «maskeringen ødelegger kode den ikke skulle røre»
      forsvinner strukturelt i stedet for heuristisk.
      Må med når det gjøres:
      1. Literaler må **avvises**, ikke bare frarådes — ellers kan ikke
         `scrubKeys` slettes. Feilmelding som peker til Innstillinger.
      2. `ask` reserveres som navn (ellers tvetydig mot en nøkkel brukeren
         faktisk kalte «ask»).
      3. Delt script må gi tydelig feil hos mottakeren: «ingen registrert
         nøkkel «github» — legg den inn i Innstillinger», ikke en 401.
      4. `js/keys.js` er **ukryptert** localStorage — bevisst og dokumentert i
         spec 2026-07-23-user-keys-and-source-registry. Dette punktet endrer
         ikke den vurderingen og skal ikke leses som en ny garanti.
      Openstat-kontekst: lav hastegrad (ingen innlogging, ingen beskyttede
      kilder, kryptert-fil-eksempelet ligger i `examples/_unlinked/`). Verdien
      er størst i safestat, som deler `js/data-directives.js`.

- [ ] **Streaming-/levende kilder** (notert 2026-07-25). Trapp: (1)
      polling — `# <alias> = ost.connect(…, refresh="30s")` som re-henter og re-rendrer en
      utpekt output; passer dagens batch-modell (fersk økt per kjøring) og
      dekker det meste av statistikk-kilder; liten økt. (2) Ekte push
      (websocket/SSE → løpende INSERT i duckdb-tabell + reaktiv visning) —
      krever noe à la Perspective.js (wasm, streaming-tabeller m/ grid og
      charts; passer LIB_REGISTRY-mønsteret som js-dep). Stort — egen spec
      først, og avklar hvilke kilder som faktisk streamer.

- [x] **Pythonsk direktivsyntaks** — LEVERT 2026-07-27: én grammatikk
      (`# <navn> = ost.<verb>(…)` og `#meta.<datasett>.<nøkkel> = …`) erstatter
      åtte regexer; `isDirectiveLine()` erstatter de divergerende verblistene.
      `key` → `secret_key` for hemmeligheter; `key` er nå kun kolonnenavn.
      openstat.py fikk `Dataset.join` og `format=`, og avviser editor-argumenter.
      Portabel eksport fjerner dem. Hard omlegging uten aliaser — gammel syntaks
      gir feilmelding med forslag.
      FJERNET UTEN ETTERFØLGER: `# require <navn> as <alias>`.
      UTESTET: AI-evalene (`data-svar`) er kalibrert mot gammelt vokabular og må
      re-kjøres med nøkkel.

- [x] **Direktivord-omdøping (pakke-paritet)** — LEVERT 2026-07-25 (Hans'
      beslutning): kanoniske ord er nå `# read` (før load), `# add` (før
      import) og `# create` (før create-dataset; `create` valgt fremfor
      `dataset` — fanger intuisjonen, og pakken fikk `ost.create()` i samme
      slengen). Gamle ord ble den gang godtatt som STILLE aliaser i parseren
      (ett ord i regexene — ingen dobbel API); den aksepten falt bort
      2026-07-27, se punktet over. Alt synlig (hjelp, eksempler,
      directive-language-examples, starteksempler, AI-promptmalene,
      eksport-headeren) lærer bort de nye. `connect`/`join`/`use` uendret.
      NB: data-svar-EVALENE er kalibrert mot gammelt vokabular — re-kjør
      evalsettet ved neste AI-økt (krever nøkkel; promptmalene er alt
      oppdatert til # read).

- [ ] **Hugging Face som datakilde — teknisk klarert, men trenger et
      «hva slags data spør du om?»-lag** (undersøkt 2026-08-01). Alt målt
      live mot ekte API-er:
      - **CORS er helt åpent.** Søke-API-et (`huggingface.co/api/datasets?
        search=…&sort=downloads`), Dataset Viewer (`datasets-server.
        huggingface.co`: `/is-valid`, `/rows`, `/filter`, `/search`,
        `/parquet`) OG selve parquet-filene reflekterer Origin. Parquet-
        CDN-en svarer HTTP 206 på range-forespørsler med
        `access-control-allow-origin: *` og eksponerer Accept-Ranges/
        Content-Range → **duckdb-wasm kan spørre HF-parquet DIREKTE fra
        nettleseren, uten /api/hent**. Det er en kapabilitet vi ikke har
        for noen annen kilde i dag.
      - `/rows` gir typet kolonneskjema (`features[].type.dtype`), altså
        gratis grunnlag for typing/kodebok-laget.
      - **MEN søkekvaliteten er dårlig i vårt domene.** «health
        expenditure» sortert på nedlastinger gir republiserte WHO/OWID-
        derivater fra bulk-opplastere (66–188 nedlastinger) — dårligere
        kopier av kilder vi allerede har VED KILDEN, med svakere
        proveniens. Å legge HF rett inn i `search_datasets`' rotasjon
        ville støye ned nettopp de spørsmålene Hans jobber med.
      - **Derfor det åpne designspørsmålet (Hans, 2026-08-01): hvordan
        skille «jeg vil ha ML-/forskningsdata» fra «jeg vil ha offisiell
        statistikk»?** To retninger, ikke gjensidig utelukkende:
        (a) BRUKERVALG — eksplisitt kilde/omfang i UI-et, eller at
        HF bare nås når brukeren navngir den (`# d = huggingface.read(…)`);
        (b) INFERENS fra spørsmålet — ruteren/`scope`-parameteren
        klassifiserer allerede stats/research; HF hører hjemme under
        `research` sammen med datacite/dataeuropa, ikke under `stats`.
        Merk at dagens `scope='research'` KUN har metadatakataloger som
        stort sett gir landingssider — HF er den eneste kandidaten som gir
        direkte lastbare, typede data. Det er det sterkeste argumentet for
        å ta den inn, og det gjelder survey-/individ-/mikrodata, som
        KODEBOK-blokken og de kausale designene eksplisitt etterspør.
      - Foreslått rekkefølge om vi går videre: (1) HF som EKSPLISITT
        navngitt kilde i registeret (ingen discovery-støy), (2) duckdb-
        parquet-veien som egen leveringsform, (3) først til slutt —
        og bare hvis (1) viser seg nyttig — vurdere plass i `research`-
        rotasjonen, med kvalitetsfilter (nedlastinger/likes) og
        eksplisitt «uoffisiell kilde»-merking i svaret.
      - Vurdert og forkastet samtidig: skills.rest-skillene
        (`api-data-fetcher` genererer requests/pandas = EVAL-regel 4-brudd
        og dekker FRED/WB/OECD vi har bedre; `nl-gov-shared` er en
        konfig-stubb; `datagouv-apis` har en ekte Tabular API med
        server-side filter/sort/aggregat, men fransk forvaltningsdata =
        lav relevans). openstat konsumerer uansett ikke Claude Skills —
        alt må bli adapter + registeroppføring + promptregel.

## Output-rendering (lagt til 2026-07-30)

- [ ] **`//`-linjer forsvinner stille fra output** — `formatPreBlockWithCommandHighlight`
      (index.html ~5962) dropper hver tekstlinje som starter med `//`
      (`if (t.indexOf('//') === 0) continue;`). Regelen stammer fra microdata-DSL-en,
      der `//` var kommentartegn og kommentar-linjene ble ekkoet tilbake i output —
      men filteret treffer ALL tekst som passerer gjennom `<pre>`-grenen, uansett
      modus. `print("// merk")` i python-modus, en R-streng med `//`, en URL på
      egen linje, eller en SQL-linje med `//` blir dermed usynlig — verst
      feilklasse: stille tap, ingen indikasjon på at noe ble fjernet.
      Fiks: filteret hører til microdata-ekkoet, ikke til den generelle
      tekstrendringen. Enten (a) begrens dropping til microdata-kind (segmentet
      vet sin egen kind — tråd den inn i `buildOutputNodes`/`splitTextIntoBlocks`),
      eller (b) fjern den helt og la microdata-veien selv unnlate å printe
      kommentar-linjene ved kilden. (b) er sannsynligvis renest — output-
      rendringen bør være modus-uavhengig. Sjekk samtidig `FEIL`-regelen rett
      under (linjer som starter med `FEIL` farges røde uansett modus) og
      `stripInlineMdComment` i kommando-ekko-grenen — samme klasse antakelse.
      Regresjonstest: `print("// x")` i python-modus skal vise linjen.

## Diverse / uavklart

- [ ] Pandas-basert GUI som egen modus (Hans' idé — holdes adskilt fra
      jamovi-modus, som skal forbli tro mot ekte jamovi/R)
- [ ] «Kjør»-knappen reinitialiserer Python-tolken hver gang (modus-uavhengig,
      eldre oppførsel) — datasett laget i jamovi overlever bytte til python-modus,
      men ikke et nytt «Kjør»-trykk der. Vurder varmere tolk-gjenbruk.
