# Lazy microdata-assets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Microdata-katalogen (`variable_metadata.json`, 640 KB) og mockdata-modulene (`mockdata_core.py`, `mockdata_realism.py`, `static_source.py`) lastes først når noe faktisk trenger dem — ikke ved sideoppstart eller ved hver Pyodide-boot. I tillegg ryddes de siste `'microdata'`-default-fallbackene til `'python'`.

**Architecture:** To memoiserte ensure-funksjoner i `index.html` (`ensureMicrodataCatalog()` for katalog-JSON, `ensureMockdataModules(py)` for Pyodide-registrering av mockdata-modulene), samlet i `ensureMicrodataAssets(py)`. Fire kjøresteder gater på om microdata faktisk er involvert (modus eller segment-kind) og awaiter ensure før de bygger `catalogArg`. Den eager `fetchAutocompleteData`-IIFE-en og mockdata-delen av `_loadPyodideAndM2pyImpl` fjernes. **`m2py.py` endres IKKE** — filen er byte-synkronisert med søsterrepoene (safestat/microdata), og `MicroInterpreter(catalog=None)`-init er billig (kun demo-fallback-dict); all lazy-lasting skjer på JS-siden.

**Tech Stack:** Vanilla JS i `index.html` (inline script), Pyodide, node:test (`tests/js/`), pytest (`tests/`), browserverifisering via lokal `python3 -m http.server`.

> **Avvik funnet under utførelse (2026-07-23):** `mockdata_core.py` kan IKKE
> lazy-lastes — `m2py.py:1668` har en toppnivå `from mockdata_core import …`
> (delte konstanter, dedup 2026-07-07), så modulen må registreres FØR m2py i
> kjernebooten. Task 2 ble justert: mockdata_core (185 linjer) ble værende i
> `_loadPyodideAndM2pyImpl`; kun `mockdata_realism.py`, `static_source.py` og
> `variable_metadata.json` er lazy. Funnet via browserverifisering (boot
> feilet med ModuleNotFoundError før justeringen).

## Global Constraints

- `m2py.py`, `functions.py`, `m2py_translate.py`, `m2py_runtime/`, `mockdata_*.py`, `protect.py` er byte-identiske med søsterrepoene — **ingen av dem skal endres** i denne planen.
- Kjernebooten (`_loadPyodideAndM2pyImpl`) skal fortsatt registrere `functions`, `m2py`, `protect`, `notebook_prose` og `m2py_runtime` — alle kjøringer bruker `getInterpreterCorePython` som gjør `from m2py import MicroInterpreter`.
- Atferd for microdata-språket (statx-modus, `#options.mode = microdata`-dokumenter, `#%% microdata`-celler, forklar i microdata-modus, microdata-segmenter i R-hybrid) skal være **uendret** — samme katalog og samme mockdata-moduler tilgjengelig ved kjøring som i dag.
- Rene python/r/duckdb/brython/micropython/javascript/jamovi-kjøringer skal aldri utløse fetch av `variable_metadata.json`, `mockdata_core.py`, `mockdata_realism.py` eller `static_source.py`.
- `sw.js` trenger ingen endring (filene er runtime-cachet via stale-while-revalidate, ikke precachet).
- Linjenumre i denne planen er fra 2026-07-23 og kan drifte — finn alltid stedet via de siterte kodeankrene.

---

### Task 1: `ensureMicrodataCatalog()` — lazy katalog, fjern eager autocomplete-fetch

**Files:**
- Modify: `index.html` (~2630: `fetchAutocompleteData`-IIFE; ~3266: `modeRegistry.microdata`; ~3340: `modeRegistry.statx.onActivate`)

**Interfaces:**
- Produces: `ensureMicrodataCatalog(): Promise<object|null>` — memoisert; setter de eksisterende globalene `microdataCatalog` og `microdataVariableNames` ved suksess, returnerer katalogen (eller null ved feil, med nullstilt memo så neste kall prøver igjen). Brukes av Task 3.
- Consumes: globalene `microdataCatalog` (deklarert `let microdataCatalog = null;` ved ~4329) og `microdataVariableNames` (~2631) — begge finnes fra før.

- [ ] **Step 1: Erstatt den eager IIFE-en med ensure-funksjonen**

Finn denne blokken (~linje 2630–2653):

```js
    let microdataFunctions = [];
    let microdataVariableNames = [];

    (function fetchAutocompleteData() {
      const base = window.location.href.replace(/[^/]+$/, '');
      Promise.all([
        fetch(base + 'variable_metadata.json?v=' + (window.M2PY_VERSION || '1')).then(r => r.ok ? r.json() : {}).catch(() => ({})),
        fetch(base + 'functions.py?v=' + (window.M2PY_VERSION || '1')).then(r => r.ok ? r.text() : '').catch(() => '')
      ]).then(([meta, funcCode]) => {
        if (meta && meta.variables) {
          microdataVariableNames = Object.keys(meta.variables);
          microdataCatalog = meta;
        }
        if (funcCode) {
          const names = [];
          const re = /def\s+(\w+)\s*\(/g;
          let m;
          const skip = new Set(['_elementwise', '_safe', '_days_to_dt', 'get_microdata_functions', 'wrapped']);
          while ((m = re.exec(funcCode)) !== null)
            if (!skip.has(m[1])) names.push(m[1]);
          microdataFunctions = [...new Set(names)];
        }
      });
    })();
```

Erstatt hele blokken med:

```js
    let microdataFunctions = [];
    let microdataVariableNames = [];

    // Lazy katalog (plan 2026-07-23-lazy-microdata-assets): variable_metadata.json
    // (640 KB) hentes først når microdata-språket faktisk er i spill (statx-/
    // microdata-modus aktiveres, eller en kjøring har microdata-segmenter) —
    // aldri ved sideoppstart. microdataFunctions (autocomplete) fylles av
    // _loadPyodideAndM2pyImpl, som uansett henter functions.py.
    // Memo nullstilles ved feil så neste kall prøver på nytt.
    let __microdataCatalogPromise = null;
    function ensureMicrodataCatalog() {
      if (!__microdataCatalogPromise) {
        const base = window.location.href.replace(/[^/]+$/, '');
        __microdataCatalogPromise = fetch(base + 'variable_metadata.json?v=' + (window.M2PY_VERSION || '1'))
          .then(r => r.ok ? r.json() : null)
          .then(meta => {
            if (meta && meta.variables) {
              microdataCatalog = meta;
              microdataVariableNames = Object.keys(meta.variables);
            }
            return microdataCatalog;
          })
          .catch(() => { __microdataCatalogPromise = null; return null; });
      }
      return __microdataCatalogPromise;
    }
```

Merk: `microdataCatalog` er deklarert med `let` lenger ned (~4329) — det er trygt fordi tilordningen skjer i en async `.then` som alltid kjører etter at hele scriptet er evaluert (samme mønster som den gamle IIFE-en).

- [ ] **Step 2: Prefetch katalogen ved aktivering av statx- og microdata-modus**

I `modeRegistry` (~3263): utvid de to oppføringene. Fra:

```js
      microdata: { id: 'microdata', label: 'Microdata', handleTab: microdataHandleTab },
```

til:

```js
      microdata: { id: 'microdata', label: 'Microdata', handleTab: microdataHandleTab,
        // Modusen er ute av menyen i openstat, men nåbar via #options.mode-
        // direktiv/eksempellasting — prefetch katalogen ved aktivering.
        onActivate: function () { ensureMicrodataCatalog(); } },
```

Og statx-oppføringen fra:

```js
        onActivate: function () { if (!pdexplorerReady && !pdexplorerLoading) loadPyodideAndM2py().then(loadPdexplorer); },
```

til:

```js
        onActivate: function () {
          ensureMicrodataCatalog();
          if (!pdexplorerReady && !pdexplorerLoading) loadPyodideAndM2py().then(loadPdexplorer);
        },
```

(`ensureMicrodataCatalog` er en hoisted function declaration i samme script-blokk, så referansen fra `modeRegistry` er trygg.)

- [ ] **Step 3: Verifiser i browser**

Kjør: `cd /Users/hom/Documents/GitHub/openstat && python3 -m http.server 8123` (bakgrunn), åpne `http://localhost:8123/` i en fersk fane med Network-panelet (evt. `read_network_requests`).
Forventet: **ingen** request mot `variable_metadata.json` ved oppstart i python-modus. Ingen konsollfeil om `fetchAutocompleteData`/`microdataVariableNames`.

- [ ] **Step 4: Kjør JS-testsuiten som regresjonssjekk**

Kjør: `node --test tests/js/`
Forventet: PASS (suiten tester `js/*.js`-moduler og berøres ikke, men fanger utilsiktede brekkasjer).

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "perf(boot): lazy variable_metadata-katalog — fjern eager autocomplete-fetch ved oppstart"
```

---

### Task 2: `ensureMockdataModules(py)` + slank `_loadPyodideAndM2pyImpl`

**Files:**
- Modify: `index.html` (~9314–9501: `_loadPyodideAndM2pyImpl`; ny funksjon rett etter den)

**Interfaces:**
- Consumes: `ensureMicrodataCatalog()` fra Task 1.
- Produces: `ensureMockdataModules(py): Promise<void>` — memoisert; henter og registrerer `mockdata_core`, `mockdata_realism` og `static_source` i Pyodide-instansen. `ensureMicrodataAssets(py): Promise<void>` — `Promise.all` av begge. Brukes av Task 3.

- [ ] **Step 1: Fjern katalog- og mockdata-fetchene fra kjernebooten**

I `_loadPyodideAndM2pyImpl` (~9357–9379): endre status-teksten og fetch-listen. Fra:

```js
      setStatus(leftStatus, 'Fetching m2py, functions, mockdata modules and variable_metadata...');
      const base = window.location.href.replace(/[^/]+$/, '');
      const _cb = '?v=' + (window.M2PY_VERSION || '1');
      const [m2pyResp, funcResp, metaResp, coreResp, realismResp, protectResp, staticSrcResp, notebookProseResp] = await Promise.all([
        fetch(base + 'm2py.py' + _cb),
        fetch(base + 'functions.py' + _cb),
        fetch(base + 'variable_metadata.json' + _cb),
        fetch(base + 'mockdata_core.py' + _cb),
        fetch(base + 'mockdata_realism.py' + _cb),
        fetch(base + 'protect.py' + _cb).catch(function() { return { ok: false }; }),
        fetch(base + 'static_source.py' + _cb).catch(function() { return { ok: false }; }),
        fetch(base + 'notebook_prose.py' + _cb).catch(function() { return { ok: false }; })
      ]);
      if (!m2pyResp.ok || !funcResp.ok) {
        throw new Error('Could not load m2py.py or functions.py. Run from a local server (e.g. python -m http.server) from the microdata folder.');
      }
      try {
        microdataCatalog = metaResp.ok ? await metaResp.json() : null;
        if (microdataCatalog && microdataCatalog.variables)
          microdataVariableNames = Object.keys(microdataCatalog.variables);
      } catch (e) {
        microdataCatalog = null;
      }
```

til:

```js
      setStatus(leftStatus, 'Fetching m2py and functions...');
      const base = window.location.href.replace(/[^/]+$/, '');
      const _cb = '?v=' + (window.M2PY_VERSION || '1');
      const [m2pyResp, funcResp, protectResp, notebookProseResp] = await Promise.all([
        fetch(base + 'm2py.py' + _cb),
        fetch(base + 'functions.py' + _cb),
        fetch(base + 'protect.py' + _cb).catch(function() { return { ok: false }; }),
        fetch(base + 'notebook_prose.py' + _cb).catch(function() { return { ok: false }; })
      ]);
      if (!m2pyResp.ok || !funcResp.ok) {
        throw new Error('Could not load m2py.py or functions.py. Run from a local server (e.g. python -m http.server) from the microdata folder.');
      }
      // Katalog + mockdata-moduler er lazy (plan 2026-07-23-lazy-microdata-
      // assets): se ensureMicrodataAssets() — kjørestedene awaiter den når
      // microdata faktisk er involvert.
```

- [ ] **Step 2: Fjern mockdata-registreringen fra kjernebooten**

Samme funksjon, fjern hele denne blokken (~9432–9451):

```js
      // Register mockdata_core and mockdata_realism (used by m2py's realism dispatch).
      // Load order: mockdata_core (no deps) -> mockdata_realism (depends on core) -> m2py.
      if (coreResp.ok && realismResp.ok) {
        const coreCode = await coreResp.text();
        const realismCode = await realismResp.text();
        setStatus(leftStatus, 'Registering mockdata_core and mockdata_realism...');
        await pyodide.runPythonAsync(`
core_code = ${JSON.stringify(coreCode)}
spec_c = importlib.util.spec_from_loader("mockdata_core", loader=None)
sys.modules["mockdata_core"] = importlib.util.module_from_spec(spec_c)
exec(compile(core_code, "mockdata_core.py", "exec"), sys.modules["mockdata_core"].__dict__)

realism_code = ${JSON.stringify(realismCode)}
spec_r = importlib.util.spec_from_loader("mockdata_realism", loader=None)
sys.modules["mockdata_realism"] = importlib.util.module_from_spec(spec_r)
exec(compile(realism_code, "mockdata_realism.py", "exec"), sys.modules["mockdata_realism"].__dict__)
`);
      } else {
        console.warn('mockdata_core.py or mockdata_realism.py not available; realism dispatch in m2py will fall back.');
      }
```

og static_source-blokken (~9459–9471):

```js
      // Register static_source (statisk datakilde via DuckDB-WASM). Valgfri.
      if (staticSrcResp && staticSrcResp.ok) {
        try {
          const staticCode = await staticSrcResp.text();
          await pyodide.runPythonAsync(`
static_code = ${JSON.stringify(staticCode)}
spec_s = importlib.util.spec_from_loader("static_source", loader=None)
sys.modules["static_source"] = importlib.util.module_from_spec(spec_s)
exec(compile(static_code, "static_source.py", "exec"), sys.modules["static_source"].__dict__)
`);
          window.__staticSourceLoaded = true;
        } catch (e) { console.warn('static_source register:', e); }
      }
```

(Behold alt annet uendret: functions-registrering, autocomplete-parsingen av `funcCode` → `microdataFunctions`, protect, notebook_prose, m2py-registrering, disclosure-control-speiling, `ensureM2pyRuntime`.)

- [ ] **Step 3: Legg til de nye ensure-funksjonene**

Rett ETTER `_loadPyodideAndM2pyImpl`s avsluttende `}` (før `async function loadPdexplorer(py) {`, ~9504), sett inn:

```js
    // ── Lazy microdata-assets (plan 2026-07-23-lazy-microdata-assets) ──────
    // Mockdata-modulene trengs bare når microdata-språket kjører (statx-modus,
    // microdata-modus/-segmenter). m2py.py degraderer pent uten dem (realism-
    // dispatch faller tilbake), og getInterpreterCorePython sjekker selv
    // `'static_source' in _sys.modules` — så rene python/duckdb-kjøringer er
    // upåvirket av at modulene mangler. Registreringskoden er flyttet uendret
    // fra _loadPyodideAndM2pyImpl.
    let __mockdataModulesPromise = null;
    function ensureMockdataModules(py) {
      if (!__mockdataModulesPromise) {
        __mockdataModulesPromise = _ensureMockdataModulesImpl(py).catch(function (e) {
          __mockdataModulesPromise = null;  // tillat retry etter feil
          throw e;
        });
      }
      return __mockdataModulesPromise;
    }
    async function _ensureMockdataModulesImpl(py) {
      const base = window.location.href.replace(/[^/]+$/, '');
      const _cb = '?v=' + (window.M2PY_VERSION || '1');
      const [coreResp, realismResp, staticSrcResp] = await Promise.all([
        fetch(base + 'mockdata_core.py' + _cb).catch(function () { return { ok: false }; }),
        fetch(base + 'mockdata_realism.py' + _cb).catch(function () { return { ok: false }; }),
        fetch(base + 'static_source.py' + _cb).catch(function () { return { ok: false }; })
      ]);
      // Load order: mockdata_core (no deps) -> mockdata_realism (depends on core).
      if (coreResp.ok && realismResp.ok) {
        const coreCode = await coreResp.text();
        const realismCode = await realismResp.text();
        await py.runPythonAsync(`
import sys, importlib.util
core_code = ${JSON.stringify(coreCode)}
spec_c = importlib.util.spec_from_loader("mockdata_core", loader=None)
sys.modules["mockdata_core"] = importlib.util.module_from_spec(spec_c)
exec(compile(core_code, "mockdata_core.py", "exec"), sys.modules["mockdata_core"].__dict__)

realism_code = ${JSON.stringify(realismCode)}
spec_r = importlib.util.spec_from_loader("mockdata_realism", loader=None)
sys.modules["mockdata_realism"] = importlib.util.module_from_spec(spec_r)
exec(compile(realism_code, "mockdata_realism.py", "exec"), sys.modules["mockdata_realism"].__dict__)
`);
      } else {
        console.warn('mockdata_core.py or mockdata_realism.py not available; realism dispatch in m2py will fall back.');
      }
      // static_source (statisk datakilde via DuckDB-WASM). Valgfri.
      if (staticSrcResp && staticSrcResp.ok) {
        try {
          const staticCode = await staticSrcResp.text();
          await py.runPythonAsync(`
import sys, importlib.util
static_code = ${JSON.stringify(staticCode)}
spec_s = importlib.util.spec_from_loader("static_source", loader=None)
sys.modules["static_source"] = importlib.util.module_from_spec(spec_s)
exec(compile(static_code, "static_source.py", "exec"), sys.modules["static_source"].__dict__)
`);
          window.__staticSourceLoaded = true;
        } catch (e) { console.warn('static_source register:', e); }
      }
    }
    function ensureMicrodataAssets(py) {
      return Promise.all([ensureMicrodataCatalog(), ensureMockdataModules(py)]);
    }
```

Merk forskjellen fra originalen: registrerings-snuttene starter nå med `import sys, importlib.util` (originalen lente seg på at functions-registreringen hadde importert dem i samme globale Pyodide-namespace tidligere i booten — det holder ikke lenger når snuttene kjører frittstående).

- [ ] **Step 4: Verifiser i browser**

Hard-refresh `http://localhost:8123/` i python-modus, kjør `print(1+1)`.
Forventet: kjøringen fungerer; Network viser at `m2py.py` og `functions.py` hentes ved boot, men **ikke** `variable_metadata.json`, `mockdata_core.py`, `mockdata_realism.py` eller `static_source.py`. Konsollen kan vise «mockdata … will fall back»-warn kun hvis noe mot formodning kaller ensure — normalt ingen.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "perf(boot): mockdata-moduler og katalog ut av Pyodide-kjernebooten — lazy via ensureMicrodataAssets()"
```

---

### Task 3: Gate ensure-kallene inn på de fire kjørestedene

**Files:**
- Modify: `index.html` (~9944–9994: `bootNotebookSession`; ~9229: `runStatxScript`; ~8610: R-hybridens microdata-fase; ~11566: forklar/`explainInit`)

**Interfaces:**
- Consumes: `ensureMicrodataAssets(py)` fra Task 2.
- Produces: ingen nye — atferdskontrakt: alle stier som kjører microdata-språket har katalog + mockdata-moduler på plass FØR `catalogArg` bygges/`MicroInterpreter` brukes til generering.

- [ ] **Step 1: `bootNotebookSession` — ensure når dokumentet har microdata-segmenter**

Stedet i dag (~9968–9994, forkortet):

```js
        const catalogJson = microdataCatalog && microdataCatalog.variables
          ? JSON.stringify(microdataCatalog.variables)
          : null;
        const catalogArg = catalogJson !== null ? JSON.stringify(catalogJson) : 'None';
        const pageBase = window.location.href.replace(/[^/]+$/, '');
        // In Python mode, unmarked code is pyodide; otherwise use the stored runner default.
        // …
        let segments = await buildDocumentSegments(py, effectiveScript);
```

`catalogJson`/`catalogArg` bygges FØR segmentene finnes. Flytt dem NED: slett de fire linjene (`const catalogJson …` t.o.m. `: 'None';`) fra sin nåværende plass, og sett inn ensure + de samme linjene ETTER segment-byggingen. Rett etter linjen

```js
        let segments = await buildDocumentSegments(py, effectiveScript);
```

sett inn:

```js
        // Lazy microdata-assets: hent katalog + mockdata-moduler kun når
        // dokumentet faktisk kjører microdata-språket (modusen selv, eller
        // #%% microdata-/#micro-segmenter i andre moduser).
        if (activeEditorMode === 'microdata' || segments.some(function (s) { return s.kind === 'microdata'; })) {
          try { await ensureMicrodataAssets(py); }
          catch (e) { console.warn('microdata-assets:', e); }
        }
        const catalogJson = microdataCatalog && microdataCatalog.variables
          ? JSON.stringify(microdataCatalog.variables)
          : null;
        const catalogArg = catalogJson !== null ? JSON.stringify(catalogJson) : 'None';
```

(`pageBase`-linjen blir stående der den er. NB: `activeEditorMode` her er ctx-varianten — `var activeEditorMode = ctx.activeEditorMode;` øverst i funksjonen — som er riktig kilde. Duck-native fast-path og segment-use-koden mellom de to punktene leser ikke `catalogJson`, så flyttingen er trygg; verifiser med søk at `catalogJson` ikke brukes mellom gammelt og nytt sted.)

Dette dekker både «Kjør alle» (btnRun) og per-celle-kjøring: `mdRunNotebookCell` går via `mdNotebookSession.ensure()/restart()` → `nbEnsureSession` → `bootNotebookSession`, og microdata-celler tvinger alltid `restart()` (fersk boot) — så en python-notatbok som får sin første `#%% microdata`-celle booter på nytt MED assets.

- [ ] **Step 2: `runStatxScript` — ensure alltid**

Fra (~9231):

```js
      try {
        const py = await loadPyodideAndM2py();
        await loadPdexplorer(py);
```

til:

```js
      try {
        const py = await loadPyodideAndM2py();
        // statx kjører alltid mot m2py-emulatoren (use/katalogvariabler) —
        // hent microdata-assets ubetinget.
        try { await ensureMicrodataAssets(py); }
        catch (e) { console.warn('microdata-assets (statx):', e); }
        await loadPdexplorer(py);
```

- [ ] **Step 3: R-hybridens microdata-fase — ensure når `microdataSegs` finnes**

Fra (~8613–8619):

```js
          // R-modus kjører uten Pyodide siden fase 1 (btnRun sender py=null) —
          // microdata-segmenter er unntaket som lazy-laster den her.
          if (!py) py = await loadPyodideAndM2py();
          // Build catalog JSON to pass to Python for label application
          var _catJson = (microdataCatalog && microdataCatalog.variables)
            ? JSON.stringify(microdataCatalog.variables) : '{}';
```

til:

```js
          // R-modus kjører uten Pyodide siden fase 1 (btnRun sender py=null) —
          // microdata-segmenter er unntaket som lazy-laster den her.
          if (!py) py = await loadPyodideAndM2py();
          try { await ensureMicrodataAssets(py); }
          catch (e) { console.warn('microdata-assets (r-hybrid):', e); }
          // Build catalog JSON to pass to Python for label application
          var _catJson = (microdataCatalog && microdataCatalog.variables)
            ? JSON.stringify(microdataCatalog.variables) : '{}';
```

(Denne grenen står allerede inne i `if (microdataSegs.length > 0)` — ingen egen gate-betingelse trengs.)

- [ ] **Step 4: Forklar — ensure i microdata-/statx-modus**

Fra (~11566–11572):

```js
        if (activeEditorMode !== 'r') {
          const catalogJson = microdataCatalog && microdataCatalog.variables
            ? JSON.stringify(microdataCatalog.variables)
            : null;
```

til:

```js
        if (activeEditorMode !== 'r') {
          if (activeEditorMode === 'microdata' || activeEditorMode === 'statx') {
            try { await ensureMicrodataAssets(py); }
            catch (e) { console.warn('microdata-assets (forklar):', e); }
          }
          const catalogJson = microdataCatalog && microdataCatalog.variables
            ? JSON.stringify(microdataCatalog.variables)
            : null;
```

- [ ] **Step 5: Verifiser i browser — alle fire stier**

Med serveren fra Task 1:
1. Python-modus: kjør `import pandas as pd\nprint(pd.DataFrame({'a':[1]}))` → fungerer, fortsatt ingen katalog-/mockdata-fetch i Network.
2. Lim inn et script som starter med `#options.mode = microdata` etterfulgt av f.eks. `require no.ssb.fdb:51 as db\nimport db.BEFOLKNING_KJOENN as kjonn\ntabulate kjonn` og kjør → modusen bytter, Network viser at `variable_metadata.json` + `mockdata_core.py` + `mockdata_realism.py` + `static_source.py` hentes NÅ, output viser tabulering **med ekte etiketter** (Mann/Kvinne — ikke demo-fallback + ADVARSEL).
3. Python-modus-notatbok med en `#%% microdata`-celle (samme require/import/tabulate) → cellen kjører med ekte etiketter.
4. Statx-modus: aktiver modusen (katalog-prefetch i Network), kjør et lite statx-script med `use` → fungerer.

- [ ] **Step 6: Kjør testsuitene**

Kjør: `node --test tests/js/` og `.venv/bin/python -m pytest tests/ -x -q` (pytest berører ikke index.html, men bekrefter at ingen delte filer ble endret ved uhell — `git status` skal kun vise `index.html` og denne planen).
Forventet: PASS.

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat(lazy): microdata-assets ensures på alle fire kjørestier (boot/statx/r-hybrid/forklar)"
```

---

### Task 4: Rydd `'microdata'`-default-fallbackene til `'python'`

**Files:**
- Modify: `index.html` (~1540, ~3510, ~6936)
- Modify: `js/ai-chat.js` (~28, ~732)

**Interfaces:**
- Consumes/Produces: ingen — rene fallback-endringer. Fallbackene treffes bare når `activeEditorMode` er undefined/null, som ikke skjer i normal drift; endringen gjør at en evt. race lander i python (repoets reelle default) i stedet for den gatede microdata-modusen.

- [ ] **Step 1: `currentMode()`-fallback**

`index.html` ~3510, fra:

```js
      return modeRegistry[activeEditorMode] || modeRegistry.microdata;
```

til:

```js
      return modeRegistry[activeEditorMode] || modeRegistry.python;
```

- [ ] **Step 2: Eksempelmodal-fallback**

`index.html` ~1540, fra:

```js
        openExamplesModal(typeof activeEditorMode !== 'undefined' ? activeEditorMode : 'microdata');
```

til:

```js
        openExamplesModal(typeof activeEditorMode !== 'undefined' ? activeEditorMode : 'python');
```

- [ ] **Step 3: `parseExplainBlocks` — fjern null-som-microdata**

`index.html` ~6936, fra:

```js
      const isMicrodata = (mode === 'microdata' || mode == null);
```

til:

```js
      const isMicrodata = (mode === 'microdata');
```

(Eneste kaller er `parseExplainBlocks(extractBlockWidgets(snapshotScript), activeEditorMode)` (~11619) — mode er alltid satt.)

- [ ] **Step 4: ai-chat-fallbackene**

`js/ai-chat.js` ~28, fra:

```js
        const mode = (typeof activeEditorMode !== 'undefined' && activeEditorMode) ? activeEditorMode : 'microdata';
```

til:

```js
        const mode = (typeof activeEditorMode !== 'undefined' && activeEditorMode) ? activeEditorMode : 'python';
```

Samme endring på det andre stedet (~732, i `runFastQueryV2`). **IKKE** rør `mode === 'microdata'`-spesialtilfellene lenger ned (~755, ~815) — de er reell microdata-atferd, ikke fallbacks.

- [ ] **Step 5: Kjør testsuitene og verifiser**

Kjør: `node --test tests/js/` → PASS (inkl. `ai-chat-validators.test.js`).
Browser: hard-refresh, åpne Eksempler-menyen i python-modus (viser python-eksempler), send et AI-spørsmål hvis nøkkel finnes (valgfritt).

- [ ] **Step 6: Commit**

```bash
git add index.html js/ai-chat.js
git commit -m "refactor(modes): 'microdata'-fallbacks -> 'python' (reell default i openstat)"
```

---

### Task 5: Sluttverifisering

**Files:**
- Ingen nye endringer — full gjennomkjøring av verifiseringsmatrisen + evt. fikser.

- [ ] **Step 1: Full browsermatrise**

Fersk fane per rad, Network-panel åpent:

| # | Handling | Forventet |
|---|----------|-----------|
| 1 | Last siden (python-modus), kjør `print(1+1)` | Ingen fetch av variable_metadata/mockdata_*/static_source; kjøring OK |
| 2 | R-modus, kjør `print(summary(c(1,2,3)))` | Samme — ingen microdata-fetches |
| 3 | duckdb-modus, kjør `SELECT 1;` | Samme |
| 4 | `#options.mode = microdata`-script med require/import/tabulate | Assets hentes ved kjøring; ekte etiketter i output |
| 5 | Python-notatbok med `#%% microdata`-celle | Assets hentes; cellen kjører med etiketter |
| 6 | Statx-modus med `use`-script | Katalog prefetches ved aktivering; kjøring OK |
| 7 | Forklar på et microdata-script (rad 4-modusen) | Kjører som før |
| 8 | Innstillinger → Datakilde: Statisk, kjør rad 4-scriptet på nytt | static_source lastes, statisk kilde brukes (eller pen fallback til generering) |

- [ ] **Step 2: Testsuiter og diff-sjekk**

```bash
node --test tests/js/
.venv/bin/python -m pytest tests/ -q
git diff --stat main 2>/dev/null || git diff --stat HEAD~4
```

Forventet: begge suiter PASS; diffen omfatter KUN `index.html`, `js/ai-chat.js` og `docs/superpowers/plans/2026-07-23-lazy-microdata-assets.md` — ingen delte motorfiler.

- [ ] **Step 3: Commit (kun hvis fikser ble gjort i Step 1–2)**

```bash
git add -A
git commit -m "fix(lazy): oppfølging fra sluttverifisering av lazy microdata-assets"
```
