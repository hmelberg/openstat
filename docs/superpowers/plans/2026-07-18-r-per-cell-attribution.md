# R per-celle-attribusjon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** R «Kjør alle» i notatbokmodus ruter hvert R-segments output (tekst/plots/feil/echo) til segmentets celle-slot i stedet for samlet trailing-output.

**Architecture:** Tilnærming B fra spec (docs/superpowers/specs/2026-07-18-r-per-cell-attribution-design.md): kun ruting endres inne i `runHybridR` — `beginRun(0)` → `beginRun(<kinds>)` aktiverer de eksisterende sinkene, og segment-løkka samler parts per segment og appender dem i cellens `.nb-output-body`. Alt hybridmaskineri (laster, pakker, microdata-fase, `# use`, statement-splitting, UI-kanal, restart-semantikk) urørt.

**Tech Stack:** Vanilla JS (index.html inline), webR 0.6.0, eksisterende `Cells.beginRun`/`NB.runSinks`-API (js/cells.js:1786-1830), Playwright-smoke.

## Global Constraints

- **Browser-smoke i SAMME oppgave** for index.html-inline-endringer; **rerun ×3** standard; kryss-IIFE via `window.md*`.
- Rene R-skript (notatbok inaktiv) og per-celle ▶ (`runNotebookRCell`) skal være **atferdsuendret**.
- Microdata-segmenter i R-hybriddokumenter: **uendret** (fase 1 kjører stille som setup i dag — ingen output-ruting å endre; beslutning 2 i spec).
- `renderROutputParts` beholder wholesale-semantikken (wipe) for trailing/plain; celle-slots får **append uten wipe** (`[data-ui-shown]`/strip-kontrakten fra 5b må ikke brytes — `beginRun`-purgen (cells.js:1793-1808) er den eneste tømmingen).
- Kommentarer på norsk. Suiter helgrønne: node 688/688 (`node --test tests/js/*.test.js`), pytest 1566 (`pytest tests/ brython/tests micropython/tests`). Ingen ren-halvdel-atferdsendringer forventes (kun kommentar-oppdatering i cells.js).
- Linjetall er recon-ankere fra HEAD 046da76 — verifiser mot sitert kontekst før edit.
- Ledger: `.superpowers/sdd/progress.md`.

---

### Task 1: Sink-kobling i runHybridR

**Files:**
- Modify: `index.html:8143-8152` (ny helper ved renderROutputParts), `index.html:8386-8394` (beginRun), `index.html:8543-8633` (segment-løkka), `index.html:8670-8674` (sluttrender), `index.html:8500-8508` (stale kommentar)
- Modify: `js/cells.js:1832-1844` (kun kommentar — alignedPlanForKinds-rasjonalet refererer beginRun(0))

**Interfaces:**
- Consumes: `Cells.beginRun(kindsArray)` → `NB.runSinks[]` (én node per segmentindeks i dokumentrekkefølge, null-hull ved manglende celle-node; returnerer null når notatbok inaktiv eller planen ikke justerer — cells.js:1786-1825). `buildROutputNodes(parts)` (index.html:8100-8141). `rSegOrigIdx[ri]` = R-segmentets indeks i `_rSegsAll` (hele dokumentets segmentrekkefølge, index.html:8381-8385).
- Produces: `appendROutputParts(parts, host)` — append-variant uten wipe; `_rSinks` (resultatet av beginRun) som segment-løkka ruter mot.

- [ ] **Step 1: Ny helper `appendROutputParts`**

Rett under `renderROutputParts` (index.html:8152), legg til:

```js
    // Per-celle-varianten (R per-celle-attribusjon, spec 2026-07-18): APPEND
    // uten wipe — beginRun-purgen (js/cells.js) har allerede tømt slottene
    // med bevart strip/[data-ui-shown]-kontrakt (5b); en innerHTML=''-wipe
    // her ville radert kontrollstriper og [data-ui-shown]-noder i cellen.
    function appendROutputParts(outputParts, host) {
      if (!host || !outputParts.length) return;
      host.appendChild(buildROutputNodes(outputParts));
    }
```

- [ ] **Step 2: Aktiver sinkene**

Erstatt index.html:8388-8394 (kommentaren + `beginRun(0)`-kallet):

```js
      // Notatbok aktiv: aktiver per-celle-sinkene (spec 2026-07-18, tilnærming
      // B) — samme beginRun-kall som pyodide-løkka, med HELE dokumentets
      // segment-kinds i dokumentrekkefølge (_rSegsAll — samme grunnlag som
      // _rUiPlan under). beginRun purger slottene og bygger NB.runSinks;
      // null (inaktiv notatbok / plan som ikke justerer, f.eks. håndskrevne
      // ##-markører) → gammel samlet trailing-rendring uendret.
      var _rSinks = (window.Cells && window.Cells.active())
        ? window.Cells.beginRun(_rSegsAll.map(function (s) { return s.kind; }))
        : null;
```

- [ ] **Step 3: Per-segment-samling og ruting**

I R-segment-løkka: innfør en segment-lokal liste og rut den etter statement-løkka. Øverst i løkkekroppen (etter `var segText = ...; if (!segText) continue;`, index.html:8544-8545):

```js
        // Per-celle-attribusjon: dette segmentets parts samles lokalt og
        // rutes til cellens slot etter statement-løkka; uten sink faller de
        // til den delte outputParts (samlet trailing-rendring nederst).
        var segParts = _rSinks ? [] : outputParts;
```

Bytt deretter ALLE `outputParts.push(...)`-kallene inne i statement-løkka til `segParts.push(...)` — fire steder: echo (8587), stdout (8605), stderr (8608), images (8612) og error-catch (8616). (Med `_rSinks === null` er `segParts === outputParts`, så gammel sti er identisk.)

Etter statement-løkkas slutt (etter linje 8618, FØR registry-lesingen på 8620): 

```js
        if (_rSinks) {
          var _rSegSink = _rSinks[rSegOrigIdx[ri]] || null;
          if (_rSegSink) appendROutputParts(segParts, _rSegSink);
          else Array.prototype.push.apply(outputParts, segParts);
        }
```

(Bevisst IKKE `Cells.sinkForSegment` — dens errorHost-fallback ville kollidert med sluttrenderens wholesale-wipe av trailing-sloten; null-hull i `_rSinks` går i stedet til `outputParts` og rendres samlet.)

- [ ] **Step 4: Sluttrenderen hoppes over når tom i sink-modus**

Erstatt index.html:8670-8674 (renderROutputParts-kallet, behold omkringliggende kode):

```js
      // Sink-modus med alt attribuert: intet å rendre i trailing (og en tom
      // wholesale-rendring ville skapt en tom trailing-node). Ellers (plain,
      // fallback-parts, plan-mismatch): samlet rendring som før.
      if (!_rSinks || outputParts.length) {
        renderROutputParts(outputParts,
          (window.Cells && window.Cells.active() && window.Cells.errorHost()) || null);
      }
```

- [ ] **Step 5: Kommentar-oppdateringer**

(a) index.html:8500-8508 (`_rUiPlan`-kommentaren): setningen «HELT ADSKILT fra Cells.beginRun(0) over: den planen forblir bevisst null (trailing-slot for ALL tekst-/plott-output, uendret W2-tilpasning)» omskrives til at beginRun nå FÅR den ekte planen (spec 2026-07-18) og at `alignedPlanForKinds` beholdes som side-effekt-fritt oppslag for UI-indeksene (samme justering, samme resultat som NB.runPlan).
(b) js/cells.js:1832-1844 (`alignedPlanForKinds`-kommentaren): oppdater «runHybridR kaller beginRun(0) for å BEVISST tvinge…»-rasjonalet — beginRun får nå ekte kinds i notatbokmodus; funksjonen består som sluk-bivirkningsfritt oppslag.
(c) index.html:8143-8146 (`renderROutputParts`-kommentaren): «derfor 2b-grenen … ikke per-celle-attribusjon» oppdateres — per-celle-attribusjon finnes nå (appendROutputParts); wholesale-varianten gjelder trailing/plain.

- [ ] **Step 6: Suiter**

Run: `node --test tests/js/*.test.js` → 688/688 (kun kommentar i cells.js). `pytest tests/ brython/tests micropython/tests` → 1566.

- [ ] **Step 7: Browser-smoke (obligatorisk)**

Fersk server/port, R-modus (webR fra CDN — generøse ventetider):
1. Flercellet R-notatbok-eksempel (f.eks. rex-eksempel fra manifestet med ≥2 kodeceller): Kjør alle → hver celles output (tekst og evt. plot) i CELLENS slot; ingen samlet trailing-blokk med R-parts. Rerun ×3 → ingen akkumulering (beginRun-purgen tømmer).
2. Per-celle ▶ på én av cellene → samme output i samme slot som Kjør alle ga.
3. Plain R-skript (uten `#%%`): kjør → aggregert output i #outputArea som før, echo per `show_commands`.
4. R-celle med feil (`stop("x")`) midt i dokumentet: rød feiltekst i DENS celle; øvrige celler får sin output.
5. show_commands på: kode-echo vises i riktig celle; av: ingen echo.
6. R+microdata-hybriddokument (eller minimalt håndskrevet): microdata-fasen kjører stille, R-celler attribuert.

- [ ] **Step 8: Commit**

```bash
git add index.html js/cells.js
git commit -m "feat(r): per-celle-attribusjon i Kjør alle — beginRun med ekte plan + segment-ruting til celle-slots (spec 2026-07-18)"
```

---

### Task 2: r09-omskriving + full verifiseringsmatrise + cache

**Files:**
- Modify: `examples/r/r09_dashboard.txt` (kontrollcellens on_change, begrensnings-prosaen linje 16-27; evt. id på plot-cellen)
- Modify: `index.html:580` (cells.js?v — cells.js fikk kommentar-edit i Task 1: bump `2026-07-18b` → `2026-07-18c`), `sw.js:6` (`CACHE 'm2py-v28'` → `'m2py-v29'` — index.html + eksempel endret)

**Interfaces:**
- Consumes: Task 1s per-celle-attribusjon; `ui_slider(..., on_change = "<celle-id>")` (målrettet rerun via runNotebookRCell — samme mekanisme som python-eksemplene).

- [ ] **Step 1: r09 — målrettet on_change**

Åpne `examples/r/r09_dashboard.txt`. Finn plot-cellen (cellen som tegner mot `mu`); gi den `id=plott` i `#%%`-headeren hvis den mangler id. Endre kontrollcellen (linje ~29-35):

```r
mu <- ui_slider(-5, 5, value = 0, step = 1, label = "Forventning (mu)",
                name = "mu", on_change = "plott", sync_to = "mu")
```

(Behold `sync_to`. Bruk plot-cellens FAKTISKE id hvis en annen id allerede finnes.)

- [ ] **Step 2: r09 — prosa**

Erstatt begrensnings-avsnittet (linje ~16-27, «R-begrensning …») med en kort note:

```
R har per-celle output-attribusjon i «Kjør alle» (som python/brython/
micropython): hver celles tekst og plot lander i cellens egen output-slot,
og et målrettet on_change (her: "plott") rerunner KUN mål-cellen og
erstatter dens slot — ingen foreldede duplikater. on_change = "all" er
fortsatt gyldig når hele dokumentet skal rekjøres.
```

Behold `{ }`-blokk-kommentaren (linje ~44-47, statement-splitting) uendret.

- [ ] **Step 3: Cache-bumps**

- `index.html:580`: `js/cells.js?v=2026-07-18b` → `js/cells.js?v=2026-07-18c`
- `sw.js:6`: `const CACHE = 'm2py-v28'` → `'m2py-v29'`

- [ ] **Step 4: Full browser-verifiseringsmatrise (obligatorisk)**

Fersk server/port, cache omgått:
1. r09: RunAll → alle celler attribuert; slider-endring → KUN plot-cellen oppdateres (ingen ny trailing-blokk, ingen duplikat-img), ×3 endringer.
2. r09: «Oppdater»-løse widget-endringer og RunAll om hverandre → konsistent, ingen akkumulering.
3. Rå tekst-visning på r09 → uendret editor-oppførsel; tilbake til dokument → re-render korrekt.
4. Presentasjon på en R-notatbok → starter/avslutter som før (kjører ikke kode).
5. Per-celle ▶ og Kjør alle om hverandre på r09 → slots konsistente.
6. Regresjon: ett python-eksempel (py_widgets_ui) RunAll + widget-endring → uendret (delt kode ikke berørt).
7. Suiter: node 688/688, pytest 1566.

- [ ] **Step 5: Commit**

```bash
git add examples/r/r09_dashboard.txt index.html sw.js
git commit -m "feat(r): r09 demonstrerer målrettet on_change; begrensnings-notat erstattet; cache-bumps (cells c, sw v29)"
```

---

## Selv-review-notater

- **Spec-dekning:** §1 sink-aktivering (T1 Step 2), §2 per-segment-rendring + fallback (T1 Steps 1/3/4), §3 uendret flate (T1 rører kun ruting; smoke-rad 3/6 verifiserer), §4 r09 (T2 Steps 1-2), §5 bieffekter (T2-matrise rad 1), testing-matrisen (T1 Step 7 + T2 Step 4). Avgrensningene: ingen task rører runNotebookRCell, statement-splitting eller webR-broen.
- **Typekonsistens:** `_rSinks` = returverdien fra `Cells.beginRun` (array eller null); `appendROutputParts(parts, host)` void; `segParts` aliaser `outputParts` når `_rSinks === null` (gammel sti byte-ekvivalent).
- **Placeholder-skann:** rent; r09-id-instruksen er betinget på filens faktiske innhold (eksplisitt adressert, ikke utsatt).
