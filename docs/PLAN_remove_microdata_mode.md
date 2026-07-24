# Fjern microdata-modus, -blokker og -innstillinger fra openstat

> **For agentiske arbeidere:** ANBEFALT SUB-SKILL: bruk superpowers:subagent-driven-development eller superpowers:executing-plans og kryss av (`- [x]`) task-for-task. Verifiser i nettleser (lokal `python3 -m http.server`) etter hver UI-endrende task.

**Status:** UTFØRT 2026-07-24 (alle 8 tasks; verifisert i nettleser: hard feil for #micro, statx # load-datavei m/ pdexplorer-output, eksempelmeny uten microdata-kategori; node 807 + pytest 891 grønne).

Opprinnelig status: revidert v2, 2026-07-24. v1 hadde tre åpne beslutningspunkter; Hans har avgjort alle
(se «Avgjorte beslutninger»). Revisjonen er basert på ny kodegjennomgang med beslutningene på plass.

## Mål

Fjern microdata som **modus, blokk-språk og innstillingssett** fra openstat. Microdata emulerer
microdata.no som system (kommandospråk + avsløringskontroll); den øvingen hører hjemme i
`microdata`-repoen, og safestat beholder den for beskyttede data. openstat er for **åpne** data
(SSB, Eurostat, World Bank, OECD, …) med identiteten `python / r / duckdb / statx / jamovi / brython`.

Fullfører fase 0 (2026-07-11, microdata gated av fra landings-/lagret modus) og
lazy-microdata-assets (2026-07-23).

## Avgjorte beslutninger (Hans, 2026-07-24)

1. **Hard feil** for alt som peker mot microdata: `#options.mode = microdata`-direktiver OG
   `#micro`/`// microdata`-blokker i hybrid-/notatbok-scripts — i ALLE moduser (også statx).
   Ingen pass-through. Eksempler i openstat som bruker microdata-blokker skrives om (kun openstat;
   ikke søsterrepoene).
2. **Avsløringskontroll-direktivet fjernes** (`// m2py: disclosure-control=on` / `dc=on`).
   NB: direktiv-parsingen bor i `m2py.py` (byte-synket, kan ikke endres) — openstat stripper
   direktivlinjene før scriptet når motoren (se Task 3).
3. **safestat-/restricted-rester fjernes** — openstat trenger ikke safestat-modus,
   safestat-velkomstvariant eller safestat-gating-grener.

## Konsekvensfunn fra kodegjennomgangen (styrer taskene)

- **statx-modusens eneste datavei i dag ER `#micro`-blokker**: `runStatxScript` (index.html:9614)
  splitter scriptet, kjører micro-segmentene i m2py-emulatoren for å fylle `e.datasets`, og
  pdexplorer analyserer derfra. Alle 4 statx-eksempler starter med `#micro`. Beslutning 1 ⇒
  statx trenger en NY datavei (Task 5) før/samtidig med at blokkene hard-feiler.
- **Eksempel-omfang:** manifest-kategorien `microdata` har **95 oppføringer** (hele kategorien
  slettes). I tillegg bruker **14 ikke-microdata-eksempler** `#micro`-blokker til å lage data:
  python: `py02_pandas_microdata`, `py03_statsmodels_regression`, `py04_pandas_plot`;
  r: `r03_tidyverse_microdata`, `r04_ggplot_microdata`, `r05_dplyr_recode`, `r06_base_r_idioms`,
  `r07_regresjon`, `r08_across_sample`; statx: `st01`–`st04`; duckdb: `sql09_micro_then_sql`.
- **Markør-parsingen** bor i `matchHybridMarker` (index.html:7062, `microdata|micro` → 'microdata')
  og brukes av `parseHybridScript` (7072, default-fallback `'microdata'`), duckdb-native-gaten
  (8172), r-hybrid (8910: `hasMarkers ? 'microdata' : 'r'`) og Cells-kind-klassifiseringen.
- **safestat-rester:** `RUNTIME_FOR_MODE.safestat` (3569, død nøkkel — ingen registry-oppføring);
  `window.M2PY_APP || 'safestat'`-fallbacks (1139–1148, 2041) tross `M2PY_APP='openstat'` (612);
  `welcomeBodySafe`-markup (268–271) + `_bodies`-map (1142); `js/notebook-links.js`:
  `welcomeVariant`-safestat-gren (78) og `autorunNeedsGate` `app === 'safestat'`-gren (107 —
  **behold `hasSecret`-delen**, den er den reelle gaten i openstat).
- **DC-direktivet** parses i `m2py.py` (delt fil, linje 9/154–158 m.fl.) — openstat kan bare
  strippe klient-side. Hint-strenger: index.html:1121 (`// m2py: dc=off`-tipset).

## ⚠️ MÅ BEHOLDES (delt / lastbærende — ikke slett)

- **`microdataHandleTab` (index.html:5421)** — `handleTab` for BÅDE `statx` og `duckdb`.
  Vurder gjerne rename til `catalogHandleTab` i Task 7, men funksjonen beholdes.
- **`ensureMicrodataCatalog()`** — statx-autocomplete (`statx.onActivate`). Beholdes.
- **Motorbooten** (`_loadPyodideAndM2pyImpl`, `getInterpreterCorePython`,
  `from m2py import MicroInterpreter`) — `e`-objektet er statx' datasett-container. Beholdes.
- **`static_data/` + `variable_metadata.json`** — DuckDB/statx-demodata, Norge-choropleth,
  `static_source.plan_sql`. Beholdes.
- **statx-modus** — kjører på pdexplorer (Stata); generell Stata-syntaks er legitim
  åpen-data-funksjon. Beholdes, men får ny datavei (Task 5).
- **`// m2py:`-direktivsystemet for øvrige nøkler** (`label-format`, `data-source`) — kun
  `disclosure-control`/`dc` strippes.

## Oppgaver

### Task 1 — Hard feil for microdata-markører og -direktiv
**Filer:** `index.html`
- [x] `matchHybridMarker` (7062): behold gjenkjenningen av `microdata|micro`-markøren, men la
      konsumentene hard-feile: i `parseHybridScript`-konsumentene (pyodide-segmentløkka,
      r-hybrid, statx, duckdb) kastes en tydelig feil når et segment har `kind === 'microdata'`:
      «Microdata-blokker støttes ikke i OpenStat. Bruk microdata-appen
      (hmelberg.github.io/microdata) for å øve på microdata.no-syntaks.» (+ i18n).
      Gjenkjenning-med-feil (ikke stille reklassifisering) gir presis melding i stedet for
      kryptisk Python/R-syntaksfeil på microdata-kode.
- [x] `parseHybridScript` default-fallback (7074): `'microdata'` → `'pyodide'`; r-hybrid-default
      (8910): `hasMarkers ? 'microdata' : 'r'` → `'r'`. (Legacy-heuristikken «umerket preamble i
      markør-script = microdata» utgår — preamble klassifiseres som modusens eget språk.)
- [x] `#options.mode`-parsingen (~2050 + gyldig-modus-listene ~1552, 10926): fjern `microdata`
      fra tillatt-listene og gi hard feil med samme melding når verdien er `microdata`/`micro`
      (ikke stille fallback til gjeldende modus).
- [x] Cells-kind-klassifisering: bekreft at notatbok-celler med `## microdata`-header treffer
      samme harde feil ved kjøring (via segmentløkka) — ingen egen stille sti.
- [x] Verifiser: script med `#micro`-blokk gir feilmeldingen i output (alle moduser); script med
      `#options.mode = microdata` gir feilmeldingen; rene python/r/duckdb/statx/jamovi/brython-
      script upåvirket.

### Task 2 — Fjern modusen fra registeret og ruting
**Filer:** `index.html`
- [x] Fjern `modeRegistry.microdata` (~3269–3272), `RUNTIME_FOR_MODE.microdata` (3567) og
      `microdata: ''` i `editorContent` (4034).
- [x] `restoreEditorMode()` (4059): behold vakten mot lagret `md_editor_mode === 'microdata'`
      (nå død modus, faller til hostname-default), forenkle kommentaren.
- [x] Verifiser: ingen sti kan aktivere microdata-modus; oppstart, modusbytte og eksempellasting
      fungerer.

### Task 3 — Fjern avsløringskontroll (knapp, wiring, direktiv-strip)
**Filer:** `index.html`
- [x] Fjern `<button id="menuDisclosureControl">` (438) + DC-wiring (`DC_KEY`/`getDisclosureControl`/
      label-oppdatering/listener, ~1889–1910) + Pyodide-speilingen av `M2PY_DISCLOSURE_CONTROL`
      (9832–9842). Motoren defaulter til AV når flagget mangler.
- [x] **Direktiv-strip (beslutning 2):** i kjørestien(e) som sender script-tekst til motoren,
      strip linjer som matcher `^\s*(?://|#)\s*m2py:\s*(?:disclosure-control|dc)\s*=`.
      (`m2py.py` er byte-synket og beholder parsingen for søsterrepoene.)
- [x] Fjern hint-strengene: 1120 (avsløringskontroll-tips), 1121 (`// m2py: dc=off`-tips)
      + tilhørende i18n-nøkler.
- [x] Verifiser: ingen DC-knapp; `// m2py: dc=on` i et script har ingen effekt; øvrige
      `// m2py:`-direktiver (label-format, data-source) virker som før.

### Task 4 — Fjern dataminimering, offline-oversetter og kjøremodus-toggel
**Filer:** `index.html`, `js/ai-chat.js`
- [x] Dataminimering: fjern `<button id="btnDmQuick">` (329), `dmOptionsBackdrop`-modalen
      (~12257–12300), `dmOptionsState`/modal-wiring (631–695), `runDmVurder`/`runDmQuick` og
      dm-kallene i `js/ai-chat.js` + i18n.
- [x] Offline-oversetter: fjern `<button id="menuOfflineBtn">` (47) + «Vis offline Python»-flyten
      (`loadTranslator`-konsumenten). Grep etter andre brukere av `loadTranslator`/
      `m2py_translate`-fetchen før evt. fjerning av selve lastefunksjonen.
- [x] Kjøremodus-toggel: fjern `<button id="menuRunnerMode">` + `RUNNER_MODE_KEY`-blokken
      (1859–1890) + konsumentene av `getRunnerModeFromStorage()` (~8587) — startspråk er alltid
      python.
- [x] AI-ruting: i `js/ai-chat.js` fjern microdata-grenen i `sendCurrent()`/`sendMessage`
      (kode-svar/v2) — openstat går alltid `sendWebMessage()` (data-svar). Fjern microdata-only
      v2-validatorgrener; behold python/r/duckdb-validatorene.
- [x] Verifiser: knappene borte, ingen konsollfeil om manglende elementer, AI svarer via
      data-svar i alle moduser.

### Task 5 — Ny datavei for statx (erstatter `#micro`-blokkene)
**Filer:** `index.html`, evt. `statx_runner.py` (openstat-lokal? — sjekk sync-listen FØRST:
`statx_runner.py` er i dag byte-identisk på tvers; endringer må enten være openstat-lokale i
index.html-laget eller portes safestat-først)
- [x] **Anbefalt løsning (a): `# load`-direktiver i statx-modus.** `DataLoader.resolveAndFetchLoads`
      finnes allerede (python/r/brython bruker den). I `runStatxScript`: resolve `# load`-linjene,
      materialiser pandas-frames i Pyodide og registrer dem i `e.datasets[alias]` før
      `statx_runner.run_statx(e, …)`. Da virker `use ALIAS` som før.
- [x] **Tillegg (b), valgfritt:** `use NAME` som ikke finnes i `e.datasets` slår opp NAME blant
      `static_data/manifest.json`-tabellene og laster parquet-en — gir demodata uten noe direktiv.
      (Kan utsettes; (a) er tilstrekkelig for eksemplene.)
- [x] Fjern micro-segment-kjøringen i `runStatxScript` (microCode-blokken) — erstattet av Task 1-
      feilen + den nye dataveien.
- [x] Verifiser: omskrevet statx-eksempel (Task 6) kjører: `# load` → `use` → `summarize`/
      `tabulate`/`regress` gir output; `use ukjent` gir forståelig feilmelding.

### Task 6 — Eksempler: slett microdata-kategorien, skriv om hybrid-eksemplene
**Filer:** `examples/manifest.json`, `examples/microdata/` (slettes), 14 eksempelfiler (omskrives)
- [x] Slett hele `microdata`-kategorien fra `examples/manifest.json` (95 oppføringer) og
      `examples/microdata/`-katalogen. (KUN openstat — søsterrepoene beholder sine.)
- [x] Skriv om de 14 hybrid-eksemplene til åpne-data-mønsteret:
      - python (3) og r (6): erstatt `#micro`-blokken med `# load`-direktiv (static_data-parquet
        eller registrert åpen kilde) — samme analyse-del beholdes der det gir mening.
      - statx (4): erstatt `#micro`-blokken med Task 5-dataveien (`# load` + `use ALIAS`).
      - duckdb (1, `sql09_micro_then_sql`): erstatt med `read_parquet('static_data/….parquet')`
        direkte i SQL-en (eller slett hvis poenget — hybrid micro→SQL — er borte).
      - Oppdater `# label:`-linjer/kommentarer som refererer microdata.
- [x] `tests/js/example-loads.test.js` + `tests/test_examples_manifest.py` kjøres og oppdateres
      (de parser ekte eksempelfiler/manifest).
- [x] Verifiser: eksempel-menyen har ingen microdata-kategori; alle omskrevne eksempler kjører
      grønt i nettleser.

### Task 7 — Fjern safestat-/restricted-rester (beslutning 3)
**Filer:** `index.html`, `js/notebook-links.js`, `js/i18n/en.js`
- [x] Fjern `safestat: 'pyodide'` fra `RUNTIME_FOR_MODE` (3569) — død nøkkel uten registry-oppføring.
- [x] Velkomst: fjern `welcomeBodySafe`-markupen (268–271), forenkle `_bodies`-map (1142–1143) og
      fjern `M2PY_APP || 'safestat'`-fallbackene (1139–1148, 2041) — `M2PY_APP='openstat'` er satt
      ubetinget (612); fallback kan settes til `'openstat'` eller fjernes.
- [x] `js/notebook-links.js`: `welcomeVariant` returnerer alltid `'openstat_general'` (fjern
      safestat-grenen, 78); `autorunNeedsGate` beholder KUN `!!hasSecret` (fjern
      `app === 'safestat'`-grenen, 107).
- [x] Fjern SafeStat-velkomst-i18n-nøkler; oppdater `tests/js/notebook-links.test.js`
      (asserterer i dag safestat-varianter).
- [x] Verifiser: velkomstmodalen viser OpenStat-varianten; autorun-gaten trigges fortsatt av
      lagrede hemmeligheter.

### Task 8 — Opprydding + verifisering
**Filer:** `index.html`, `js/i18n/en.js`
- [x] Døde localStorage-nøkler (`microdata_runner_mode`, `microdata_disclosure_control`):
      valgfri engangs-sletting ved oppstart; ellers inerte.
- [x] Grep-sanity: `data-mode-only="microdata"` = 0 treff; `grep -c microdata index.html` faller
      kraftig (fra ~283) — rest skal være statx-katalog/`microdataHandleTab`/
      `ensureMicrodataCatalog`/historiske kommentarer.
- [x] Foreldreløse i18n-nøkler fjernes.
- [x] `node --test 'tests/js/*.test.js'` grønn (oppdater tester som asserterer fjernet oppførsel);
      `python3 -m pytest tests/ -q` grønn (motor urørt — forvent uendret).
- [x] Nettleser: python/r/duckdb/statx/jamovi/brython kjører; statx-autocomplete virker;
      Norge-kart + DuckDB-demodata virker; `#micro`-script og `#options.mode = microdata` gir
      den nye feilmeldingen; ingen konsollfeil.
- [x] Bump `M2PY_VERSION` og push.

## Rekkefølge og avhengigheter

Task 5 (statx-datavei) bør lande FØR eller SAMMEN MED Task 1 (hard feil) — ellers er statx uten
datavei i mellomtiden. Foreslått rekkefølge: 5 → 1 → 6 → 2 → 3 → 4 → 7 → 8. Alt er i
fritt-driftende filer (`index.html`, `js/`, `examples/`) unntatt evt. `statx_runner.py`
(sync-listen — sjekk før endring; helst uendret).

## Ikke i scope (senere, egen runde)

- **Motor-fjerning (scope B):** slette `m2py.py`/`mockdata_*`/`protect.py`/`m2py_runtime/` fra
  openstat. Fortsatt blokkert av statx (`e.datasets`-container + katalog-autocomplete) og
  DuckDB/kart (`static_data`). Merk: etter denne planen krymper motorens jobb i openstat til
  nettopp container + katalog — scope B blir dermed LETTERE etterpå (bytt `e.datasets` mot en
  enkel dict + egen autocomplete-kilde). Henger sammen med monorepo-beslutningen.
- **Rydding av microdata-repoens kopi av `docs/ROADMAP.md`** (egen dead-file-opprydding).
