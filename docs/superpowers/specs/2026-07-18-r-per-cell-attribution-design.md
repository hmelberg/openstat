# R per-celle-attribusjon — designdokument

**Dato:** 2026-07-18 · **Status:** APPROVED (Hans, én designrunde) · **Scope:** R «Kjør alle» i notatbokmodus

## Problem

R «Kjør alle» (`runHybridR`, index.html:8258) slår bevisst av celle-sinkene (`Cells.beginRun(0)`, 8394 — count 0 matcher aldri `NB.plan.length`) og rendrer hele kjøringens output samlet i trailing-sloten (`renderROutputParts(outputParts, Cells.errorHost())`, 8673). Konsekvenser:

1. R-notatbøker mangler per-celle-output som python/duckdb/microdata (sink-løkka, index.html:10771) og brython/micropython (fase C-celleløkka, 10564) har.
2. Målrettet `on_change` mot enkeltceller etterlater en foreldet duplikat-blokk i trailing-sloten → r09-eksempelet er tvunget til `on_change="all"` (dokumentert begrensning i examples/r/r09_dashboard.txt:16-27).
3. «R bare-value trailing-echo» (4a-observasjonen): autoprint-verdier lander i trailing i stedet for cellens slot.

Per-celle ▶ (`runNotebookRCell`, index.html:10047) attribuerer allerede korrekt: `captureR` → `{rparts}` → `renderCellResult`s rparts-gren (cells.js:2305) → cellens `.nb-output-body`. Gapet er kun ruting i Kjør alle-stien.

## Beslutninger (Hans, 2026-07-18)

1. **Tilnærming B — sink-kobling inne i runHybridR.** Alt hybridmaskineri beholdes (webR-ready-guard, `# load`/`# connect`, pakkeinstall, microdata-fasen, `# use`-materialisering, `.m2py_split_statements`, UI-injeksjon/registry per segment, sesjonsrestart per 462f6f9, `_showCmds`); kun output-rutingen endres. Forkastet: A (fase C-celleløkke — mister hybridmaskineriet i Kjør alle) og C (full R-motorsesjon — 2b-scopet, utsatt).
2. **Kun R-segmenter attribueres.** Microdata-segmenter i R-hybriddokumenter beholder trailing-slot-ruting uendret.
3. **r09 skrives om** til målrettet `on_change` mot plot-cellen; begrensnings-prosaen fjernes/erstattes.

## Design

### 1. Sink-aktivering (notatbokmodus)

I `runHybridR`, når `Cells.active()`: erstatt `Cells.beginRun(0)` med `Cells.beginRun(<kinds-array for hybridsegmentene i dokumentrekkefølge>)` — samme kall som pyodide-stien (index.html:10756) slik at `alignPlan` (cells.js:1818-1824) bygger `NB.runSinks`. Segment→celle-justeringen finnes allerede: `rSegOrigIdx` + `Cells.alignedPlanForKinds` (8510-8512) brukes i dag til widget-attribusjon; output gjenbruker samme indeksering. Ikke-notatbok (plain script / Rå tekst): `beginRun(0)`-atferden beholdes uendret.

**Invariant:** kinds-arrayen som gis `beginRun` skal være identisk med den `alignedPlanForKinds` bygger UI-planen fra — én kilde, ingen ny justeringslogikk.

### 2. Per-segment-rendring

R-segment-løkka (8543-8633) samler segmentets parts i en segment-lokal liste (i stedet for den delte `outputParts`). Etter hvert segment:

- `var sink = Cells.sinkForSegment(origIdx)` (cells.js:1827).
- Med sink: **append** via ny hjelper `appendROutputParts(parts, host)` = `buildROutputNodes(parts)` + append — **uten** `host.innerHTML = ''`. `beginRun`-purgen har allerede tømt slottene med bevart `[data-ui-shown]`/strip-kontrakt (to-halvdels-kontrakten fra 5b); en wholesale-wipe her ville brutt den.
- Uten sink (microdata-segment, plan-mismatch, ikke-notatbok): parts går til den delte `outputParts` og rendres samlet i trailing som i dag (`renderROutputParts` urørt — den beholder wholesale-semantikken for plain/trailing).

Feil per statement: samme semantikk som i dag (error-part, løkka fortsetter/stopper uendret), bare rutet til segmentets sink.

### 3. Uendret flate

- `runNotebookRCell` (per-celle ▶): urørt.
- webR-broen, `captureR`-batching, `buildROutputNodes` (bitmap→`<img>`): urørt.
- Registry-kanalen (`webr/ui.R`, `.ui_begin`/`.ui_values`/`.ui_registry_json` → `Ui.registerFromRegistry`): urørt.
- `refreshDatasetSidebarFromR`, `webRShelter.purge()`: urørt.
- `_showCmds`-kode-echo: samme gating, rutes per celle.
- htmlTrusted/injeksjonsflater: ingen berøring.

### 4. r09-omskriving

`examples/r/r09_dashboard.txt`: kontrollcellen bytter `on_change = "all"` → målrettet `on_change` mot plot-cellens id. Begrensnings-prosaen (linje 16-27) erstattes av en kort note («R har nå per-celle-attribusjon; målrettet rerun erstatter cellens egen output»). `{ }`-blokk-kommentaren (44-47, statement-splitting) beholdes — den begrensningen består.

### 5. Løses som bieffekt

- Duplikat-blokk-problemet (roten til all-mønsteret): målrettet rerun via `runNotebookRCell` erstatter cellens slot; ingen foreldet trailing-kopi eksisterer lenger.
- R bare-value trailing-echo (4a): autoprint lander i riktig celle.

## Testing / verifisering

Ren halvdel: ingen forventede endringer (eksisterende `beginRun`/`sinkForSegment`-API). Node-suiter skal stå urørt grønne.

Browser-matrise (obligatorisk, Playwright, rerun ×3-regelen):
1. rex-eksempel (flercellet R-notatbok): Kjør alle → hver celle får sin output (tekst + plot), trailing tom for R-parts.
2. r09 omskrevet: RunAll → per-celle; slider-endring → KUN plot-cellen rerunner, ingen duplikater, ×3.
3. Per-celle ▶: uendret oppførsel, samme output som Kjør alle-cellen.
4. Plain R-skript (uten markører): byte-uendret aggregert output i #outputArea.
5. R+microdata-hybrid: microdata-output i trailing (uendret), R-celler attribuert.
6. Feil i én R-celle: rød boks i cellens slot, øvrige celler upåvirket.
7. Rå tekst-visning + presentasjon: uendret.
8. show_commands på/av: echo følger cellen.

## Avgrensning

- Ingen R-motorsesjon/isLive-paritet (C-tilnærmingen) — fortsatt runSelf-stien.
- Ingen endring i statement-splitting eller plot-oppløsning.
- Microdata-attribusjon i R-dokumenter: bevisst utenfor (beslutning 2).
- webR `ui_widget`-handles over worker-grensen: fortsatt utenfor (fase 5-beslutning).
