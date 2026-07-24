# Scope B: Fjern m2py-motoren fra openstat

> **For agentiske arbeidere:** ANBEFALT SUB-SKILL: superpowers:subagent-driven-development eller
> superpowers:executing-plans; kryss av task-for-task, verifiser i nettleser etter hver kjøresti-endring.

**Status:** utkast 2026-07-24, venter på Hans' beslutningspunkter. Forutsetter at
`PLAN_remove_microdata_mode.md` (scope A) er utført — all microdata-*kjøring* hard-feiler allerede;
motoren står igjen som passasjer i booten.

## Mål og kontekst

Etter scope A bruker openstat m2py-motoren til nøyaktig fire ting — ingen av dem er tolking:
1. **Datasett-register**: `e.datasets`/`e.active_name` + `e.sync_datasets_to_globals(_g)` — limet bak
   `# load`-aliaser, `# use` på tvers av moduser/celler, `to_microdata()` og statx.
2. **Katalog/labels**: `e.label_manager` + `_apply_labels_to_globals` (verdietiketter på
   katalogvariabler) og variable_metadata.json til statx-autocomplete.
3. **`scrub`/`protect`-eksponering** i python-modus (`import protect` → `_g["scrub"]`).
4. **Død vekt**: `e.run_script` (uoppnåelig), `e.static_source`/`plan_sql`/`runStaticSchemas`
   (microdata-import-planlegging, uoppnåelig), mockdata-modulene (m2py-toppnivåimport),
   `M2PY_DATA_SOURCE`-plumbing, `_run_microdata_chunk`-def i forklar/replay.

Kartlagt 2026-07-24: `duckdb_bridge.py` og `static_source.py` importerer IKKE m2py;
`tests/test_statx_runner.py` bruker allerede en `_FakeEngine` (datasets-dict + active_name) —
beviset på at statx klarer seg med en ~30-linjers klasse. `notebook_prose.py` er ren `ast`.
`_show_one`/`_exec_pyodide_block` (display-policy) refererer m2py kun for `M2PY_DATA_SOURCE`.

**Gevinst:** boot uten m2py/mockdata/functions (~15k linjer Python mindre å hente/registrere pr.
sesjon), skarpere identitet (internasjonal åpen-data-arbeidsbenk), og openstat løsrives fra
motor-synken — fikser drift-problemet fra Fable-reviewen for openstats del ved å fjerne årsaken.

## ⚠️ Beslutningspunkter (Hans avgjør FØR utførelse)

1. **`scrub`/`protect` i python-modus.** `protect.py` eksponeres i dag som `scrub`/`protect` for
   python-brukere (anonymiserings-verktøykasse). (a) Fjern helt — safestats domene, åpne data
   trenger det ikke (planens antakelse), eller (b) behold `protect.py` som ren python-lib (koster
   én synket fil + boot-fetch).
2. **Verdietiketter på katalogvariabler.** `_apply_labels_to_globals`/`label_manager` gir etiketter
   kun for microdata-katalogvariabler — i praksis statx-demodataene. (a) Dropp etikettene (statx
   viser koder; planens antakelse — åpne kilder har uansett ingen katalog), eller (b) behold en
   liten etikett-shim lest fra `static_data/value_labels.parquet`.
3. **Autocomplete-kilden for statx/duckdb-tab.** `variable_metadata.json` (640 KB) beholdes KUN som
   navneliste, eller erstattes med et lite generert navne-JSON (~10 KB) fra
   `static_data/variables.parquet`? Planens antakelse: generer lite navne-JSON, slett
   variable_metadata.json + codelists/ fra openstat.
4. **Sync-kontrakten (endring i SAFESTAT-repoet).** Etter scope B har openstat ingen av
   kjernefilene i `scripts/sync_check.sh`-listen. Alternativer: (a) sync_check dropper
   openstat-benet helt (planens antakelse — tri-repo-delingen blir safestat↔microdata), eller
   (b) beholde en minimal delt liste (command_help.js?). NB: dette er et arkitektur-statement som
   peker samme vei som monorepo-anbefalingen fra reviewen — openstat blir en selvstendig kodebase.

## Oppgaver

### Task 1 — `DatasetStore`: slank erstatning for `e`
**Filer:** `index.html` (getInterpreterCorePython-malen)
- [ ] Ny ~30-linjers Python-klasse i core-malen: `datasets` (dict), `active_name`,
      `sync_datasets_to_globals(g)` (samme oppførsel som i dag: hvert datasett som global
      variabel under sitt navn). `e = DatasetStore()`; behold globalnavnene `e`/`micro_interpreter`
      i `_g` (Cells/# use-koden refererer `e.datasets` fra JS-siden 10+ steder — uendret API).
- [ ] `to_microdata()`: uendret signatur/oppførsel, men uten `label_manager`-kallet (beslutning 2).
      Vurder alias `register_dataset()` som nytt primærnavn (behold `to_microdata` som alias —
      navnet er innarbeidet i eksempler/safestat-paritet).
- [ ] `show()`/`_show_one`/`_exec_pyodide_block`: uendret, minus `_m2py_mod`-referansene.
- [ ] `_m2py_run_segment`: fjern død microdata-gren + `_apply_labels_to_globals`-kall (eller
      no-op-stub ved beslutning 2b); python/duckdb/prose-grenene uendret.
- [ ] Statx (`runStatxScript` + `statx_runner.py`): virker uendret mot DatasetStore
      (bruker kun datasets/active_name — bevist av test_statx_runner's _FakeEngine).
      `statx_runner.py` beholdes i openstat (blir openstat-egen fil, ute av implisitt sync).
- [ ] Forklar/replay: fjern `_run_microdata_chunk`-def + replay-kallene (uoppnåelige).

### Task 2 — Fjern motor-booten
**Filer:** `index.html`
- [ ] `_loadPyodideAndM2pyImpl`: slutt å hente/registrere `m2py.py`, `functions.py`,
      `mockdata_core.py`, `mockdata_realism.py`, `protect.py` (beslutning 1), `static_source.py`;
      behold `notebook_prose.py` (ren ast, brukes av prose-celler) og pyodide-pakkelasting
      (numpy/pandas/scipy — python-modus trenger dem uansett). Rename funksjonen
      (`loadPyodideCore`?) — behold gammelt navn som alias hvis mange kallsteder.
- [ ] Fjern `__applyLangToPython`s m2py-gren (M2PY_LANG-speilingen — motoren er borte; behold
      funksjonen som no-op eller fjern + kallsteder).
- [ ] Fjern `M2PY_DATA_SOURCE`-plumbing, `runStaticSchemas`, static-source-preamblen i core-malen,
      `buildM2pyDefaultsSnippet` (label_format-linjen dør med motoren) + `getLabelFormat`/
      `getImportLimit`/datakilde-getterne (localStorage-rester).
- [ ] `ensureM2pyRuntime`/`m2py_runtime`-fetchen (~9960): kun konsument var offline-oversetteren
      (fjernet i scope A) + emulator-merge — verifiser med grep, fjern.
- [ ] `ensureMicrodataAssets`/`ensureMicrodataCatalog`: reduser til autocomplete-kilden
      (beslutning 3); fjern mockdata-modul-delen.

### Task 3 — Slett filene
**Filer:** repo-rot
- [ ] Slett: `m2py.py`, `m2py_translate.py`, `functions.py`, `mockdata_core.py`,
      `mockdata_realism.py`, `mockdata_export.py`, `m2py_runtime/`, `static_source.py`,
      `build_static_data.py`?†, `build_kommune_eras.py`, `kommune_eras_output.json` (død alt),
      `codelists/`, `variable_metadata.json` (beslutning 3), `protect.py` (beslutning 1),
      `manual_scripts/` (CI-røyk for motoren).
      † `build_static_data.py` genererer static_data/*.parquet fra mockdata — demodataene BEHOLDES
      som committede parquet; regenerering skjer i microdata/safestat-repoene. Slett scriptet her,
      noter i README hvor demodataene bygges.
- [ ] BEHOLD: `static_data/` (DuckDB/statx-demo + Norge-geojson), `duckdb_bridge.py`,
      `notebook_prose.py`, `statx_runner.py`, `names.json`, `examples/`, `data/`.
- [ ] `sw.js`: suffiks-regelen for .py står (dekker de gjenværende .py-filene); CACHE-bump.

### Task 4 — Testflytting
**Filer:** `tests/`, `.github/workflows/`
- [ ] Slett motor-testene (finnes i safestat/microdata): test_regressions, test_silent_errors,
      test_polars_backend, test_translate, test_if_condition, test_merge_into, test_key_resolution,
      test_mockdata, test_protect_tail, test_profile, test_performance, test_sources,
      test_safestat_sources, test_safestat_print_flag, test_manifest*. Verifiser FØRST med diff at
      safestat/microdata har samme eller nyere versjon av hver slettet fil.
- [ ] Behold + juster: test_display_policy (fjern m2py-avhengighet i uttrekket om noen),
      test_duckdb_bridge, test_examples_manifest, test_example_datasets, test_gen_jmv_specs,
      test_notebook_prose, test_statx_runner, test_ui_*, test_ipw_setup, conftest (fjern
      m2py-preimport).
- [ ] `m2py-tests.yml`: pek på gjenværende suite; rename workflow (`app-tests.yml`);
      path-filtre oppdatert. Node/brython/micropython-suitene: uberørt (brython/micropython-
      shimene er IKKE motoren — de er egne språkmoduser og beholdes).

### Task 5 — Safestat-siden: sync-kontrakten (beslutning 4)
**Filer:** `safestat/scripts/sync_check.sh` (+ README-avsnittet den peker på)
- [ ] Fjern openstat-benet fra kjernefil-loopen (eller reduser til valgt minimal liste);
      microdata-benet uendret. Kommenter HVORFOR (scope B, dato, peker til denne planen).
- [ ] Oppdater safestats README/ROADMAP-notat om tri-repo-strukturen.

### Task 6 — Verifisering + opprydding
- [ ] Nettleser: python-kjøring m/ `# load` + `show()` + `to_microdata()`/`# use` på tvers av
      celler; statx-eksempel; duckdb-native + hybrid py→sql; jamovi-datasynk; brython/micropython;
      Norge-kart; forklar i python; publiser dokument. `#micro` gir fortsatt hard feil
      (feilen bor i JS-laget, uavhengig av motoren).
- [ ] Suiter grønne (node + gjenværende pytest); grep-sanity: `import m2py|from m2py` = 0 treff
      i openstat; `M2PY_VERSION` beholdes som navn på cache-bust-konstanten (kosmetisk rename
      til APP_VERSION er valgfritt — 20+ forekomster, egen liten task).
- [ ] Bump versjon + CACHE; push. Oppdater `docs/ROADMAP.md` og minne.

## Rekkefølge

1 → 2 → 3 → 4 → 6 i openstat; Task 5 (safestat) samtidig med 3 (ellers rødt sync-check).
Alt i openstat er fritt-driftende filer; ingen delte filer endres (de slettes).

## Risiko / ikke i scope

- **`# use` på tvers av python↔r↔duckdb** er den mest sammenvevde forbrukeren av e.datasets —
  Task 1 endrer ikke API-et, men Task 6 må teste alle retningene eksplisitt.
- Monorepo-spørsmålet (reviewen) blir MER aktuelt etter scope B (openstat frikoblet;
  safestat↔microdata fortsatt kopi-synket) — egen beslutning, ikke denne planen.
- Safestat/microdata er uberørt bortsett fra sync_check (Task 5).
