# Fjern microdata-modus og -innstillinger fra openstat

> **For agentiske arbeidere:** ANBEFALT SUB-SKILL: bruk superpowers:subagent-driven-development eller superpowers:executing-plans og kryss av (`- [ ]`) task-for-task. Verifiser i nettleser (lokal `python3 -m http.server`) etter hver UI-endrende task.

**Status:** utkast, ikke påbegynt. Skrevet 2026-07-24 etter Fable-gjennomgang + samtale med Hans.

## Mål

Fjern microdata-*modusen* og de microdata-spesifikke *innstillingene* fra openstat. Poenget: microdata emulerer microdata.no som **system** (kommandospråk + avsløringskontroll), og den øvingen hører hjemme i `microdata`-repoen; safestat beholder modusen for beskyttede data. openstat er for **åpne** data (SSB, Eurostat, World Bank, OECD, …) og skal ha en skarpere identitet: `python / r / duckdb / statx / jamovi / brython`.

Dette er en fullføring av fase 0 (2026-07-11, gated microdata av fra landings-/lagret modus) og lazy-microdata-assets (2026-07-23, katalog + mockdata lastes lat). Nå fjernes selve modus-oppføringen, UI-restene og AI-rutingen.

**Scope: KUN UI + ruting.** Motoren (`m2py.py`, `functions.py`, `protect.py`, `m2py_runtime/`, `mockdata_*`, `static_data/`, katalogen) røres IKKE — den er lastbærende for statx, DuckDB-demodata, Norge-kart, `# load`-assembly og notebook-prose. Motor-fjerning er en egen, større frakobling-refaktor (se «Ikke i scope»).

## Arkitektur

Alle endringer er i `index.html` (inline-script + markup) og `js/ai-chat.js`. Ingen delte/synkede Python-filer endres, så `scripts/sync_check.sh` er upåvirket. Mønsteret er additivt-i-revers: fjern modus-oppføringen i `modeRegistry`, fjern de fire `data-mode-only="microdata"`/microdata-semantiske innstillingene med all wiring, og rut AI-en entydig til `data-svar` (web).

## ⚠️ MÅ BEHOLDES (delt / lastbærende — ikke slett)

- **`microdataHandleTab` (index.html:5421)** — `handleTab` for BÅDE `statx` og `duckdb`, ikke bare microdata. Beholdes uendret.
- **`ensureMicrodataCatalog()`** — `statx.onActivate` prefetcher katalogen for autocomplete. Beholdes.
- **Motorbooten** (`_loadPyodideAndM2pyImpl`, `getInterpreterCorePython`, `from m2py import MicroInterpreter`) — hver Pyodide-kjøring bruker `e`-objektet (bl.a. `e.datasets` for statx). Beholdes.
- **`static_data/` + `variable_metadata.json`** — DuckDB/statx-demodata, Norge-choropleth (`static_data/*.geojson`), `static_source.plan_sql`. Beholdes.
- **statx-modus** i sin helhet — kjører på pdexplorer (Stata), uavhengig av microdata-modus.

## Beslutningspunkter (Hans avgjør før/underveis)

1. **`#options.mode = microdata`-direktiv og `#%% microdata`-segmenter i hybrid-scripts.** Etter fjerning: (a) **hard, tydelig feil** som peker til microdata-repoen (mest konsistent med intensjonen), eller (b) la dem kjøre videre på motoren som står igjen (minst brudd). Planen antar **(a)** — men det er en atferdsendring for eksisterende dokumenter. Bekreft.
2. **Avsløringskontroll-direktivet** `// m2py: disclosure-control=on` — fjernes sammen med knappen (Task 2), eller beholdes som skjult kraftbruker-flagg? Planen antar **fjernes**.
3. **`safestat`-modus** i `RUNTIME_FOR_MODE`/registeret (om den finnes som rest i openstat) — utenfor dette grepet, men verdt en titt i samme runde.

## Oppgaver

### Task 1 — Fjern modusen fra registeret og ruting-defaultene
**Filer:** `index.html`
- [ ] Fjern `modeRegistry.microdata`-oppføringen (~3269–3272).
- [ ] Fjern `microdata`-nøkkelen i `RUNTIME_FOR_MODE` (3567).
- [ ] Fjern `microdata: ''` fra `editorContent`-objektet (4034) og andre modus-lister der `microdata` ramses opp eksplisitt (f.eks. gyldig-modus-sjekken ~1552, ~10926).
- [ ] `parseHybridScript`: endre default-fallbacken fra `'microdata'` til `'python'` (7074) og hybrid-default (8910: `hasMarkers ? 'microdata' : 'r'` → vurder `'python'`/`'r'`).
- [ ] `restoreEditorMode()` (4059): behold fallback-vakt, men forenkle kommentaren — microdata er nå helt borte, ikke bare gated.
- [ ] **Beslutningspunkt 1:** implementer valgt oppførsel for `#options.mode = microdata` (hard feil m/ peker til microdata-repoen, eller pass-through).
- [ ] Verifiser: modus-velgeren er uendret (microdata var aldri der); et dokument med `#options.mode = microdata` oppfører seg som besluttet; python/r/duckdb/statx/jamovi/brython uendret.

### Task 2 — Fjern avsløringskontroll (knapp + wiring + Pyodide-speiling)
**Filer:** `index.html`
- [ ] Fjern `<button id="menuDisclosureControl">` (438).
- [ ] Fjern DC-wiringen: `DC_KEY`/`getDisclosureControl`/`updateDisclosureControlLabel`/knappe-listener (~1889–1910).
- [ ] Fjern Pyodide-speilingen av `M2PY_DISCLOSURE_CONTROL` (9832–9842) — motoren defaulter til AV når flagget mangler, så åpne-data-kjøringer er uendret.
- [ ] **Beslutningspunkt 2:** fjern direktiv-parsingen `// m2py: disclosure-control=on` (om beholdt: la stå, men uten UI).
- [ ] Fjern i18n-strengen (1120) og knappens on/av-labels.
- [ ] Verifiser: ingen avsløringskontroll-knapp; en kjøring gir rå tall (som DC=AV i dag); ingen konsollfeil om manglende element.

### Task 3 — Fjern dataminimering (dm-quick + modal + AI-kall)
**Filer:** `index.html`, `js/ai-chat.js`
- [ ] Fjern `<button id="btnDmQuick">` (329) og `<div id="dmOptionsBackdrop">`-modalen (~12257–12300).
- [ ] Fjern `dmOptionsState`, `openDmOptions`/modal-wiringen (631–695) og `runDmVurder`/`runDmQuick`.
- [ ] Fjern dm-relaterte kall/ruting i `js/ai-chat.js` (dataminimerings-prompten er microdata/personvern-spesifikk).
- [ ] Fjern tilhørende i18n-strenger.
- [ ] Verifiser: ingen dm-knapp/modal; AI-panelet fungerer uten den.

### Task 4 — Fjern offline-oversetter-knappen
**Filer:** `index.html`
- [ ] Fjern `<button id="menuOfflineBtn" data-mode-only="microdata">` (47) og dens klikk-handler (`loadTranslator`/«Vis offline Python»-flyten).
- [ ] La `m2py_translate.py`-fetchen (`loadTranslator`) stå hvis noe annet bruker den; ellers fjern den døde lastefunksjonen. Sjekk med grep før fjerning.
- [ ] Verifiser: ingen offline-knapp; oversetter-koden gir ingen dead-reference.

### Task 5 — Fjern kjøremodus-toggelen (Pyodide vs Microdata startspråk)
**Filer:** `index.html`
- [ ] Fjern `<button id="menuRunnerMode">` og hele blokken `RUNNER_MODE_KEY`/`getRunnerModeFromStorage`/`setRunnerModeInStorage`/`updateRunnerModeMenuLabel`/listener (1859–1890).
- [ ] Finn og fjern konsumentene av `getRunnerModeFromStorage()` (bl.a. ~8587) — startspråk er nå alltid python (ikke microdata).
- [ ] Verifiser: ingen kjøremodus-knapp; nytt tomt script starter i python.

### Task 6 — Rut AI-en entydig til data-svar (web)
**Filer:** `js/ai-chat.js`
- [ ] `sendCurrent()`/`sendMessage`: fjern microdata-grenen (`_m.id === 'microdata' → sendMessage(true)` kode-svar/v2). openstat skal alltid gå `sendWebMessage()` (data-svar).
- [ ] Fjern nå-døde microdata-only AI-kodestier (v2-validator-grenen som gjelder microdata, kode-svar-prompt-bygging som er microdata-spesifikk) — behold python/r/duckdb-validatorene.
- [ ] Verifiser: AI svarer via data-svar i alle openstat-moduser; ingen referanse til fjernet microdata-ruting.

### Task 7 — Rydd rester (localStorage, i18n, kommentarer)
**Filer:** `index.html`, `js/i18n/en.js`
- [ ] Døde `localStorage`-nøkler: `microdata_runner_mode`, `microdata_disclosure_control` (fjernet i Task 2/5). Vurder en engangs-opprydding ved oppstart som sletter dem (valgfritt — de er bare inerte).
- [ ] Fjern gjenværende `data-mode-only="microdata"`-attributter (skal være 0 igjen etter Task 2–4; grep for å bekrefte).
- [ ] Fjern foreldreløse i18n-nøkler i `js/i18n/en.js` for de fjernede strengene.
- [ ] Grep-sanity: `grep -c microdata index.html` skal falle kraftig (fra ~283); resten skal være legitime treff (statx-katalog, `microdataHandleTab`, `ensureMicrodataCatalog`, kommentarer, `# load`/notebook-prose).

### Task 8 — Verifisering (nettleser + tester)
- [ ] `node --test 'tests/js/*.test.js'` grønn (oppdater/fjern tester som asserterer microdata-modus/DC/dm i openstat).
- [ ] `python3 -m pytest tests/ -q` grønn (motoren er urørt; forvent uendret).
- [ ] Nettleser (lokal server): python-, r-, duckdb-, **statx-**, jamovi-, brython-kjøring virker; statx-autocomplete (microdata-variabelnavn via `microdataHandleTab`) virker fortsatt; Norge-kart og DuckDB-demodata virker (bekrefter at `static_data`/katalog står).
- [ ] Bump `M2PY_VERSION` (index.html endret) og verifiser fersk last etter deploy.
- [ ] Ingen konsollfeil om manglende elementer (`menuDisclosureControl`, `btnDmQuick`, `menuRunnerMode`, `menuOfflineBtn`).

## Ikke i scope (senere, egen runde)

- **Motor-fjerning (scope B):** slette `m2py.py`/`mockdata_*`/`protect.py`/`m2py_runtime/` fra openstat. Blokkert av at statx bruker `e.datasets`-containeren + katalogen, og DuckDB/kart bruker `static_data`. Krever å gi statx en lettvekts datasett-container + autocomplete-kilde uten m2py, og henger sammen med monorepo-/arkitektur-beslutningen. Stata-kjøringen (pdexplorer) overlever uansett.
- **statx** beholdes — generell Stata-syntaks er en legitim åpen-data-funksjon.
- **Rydding av microdata-kopien av `docs/ROADMAP.md`** (egen dead-file-opprydding).
