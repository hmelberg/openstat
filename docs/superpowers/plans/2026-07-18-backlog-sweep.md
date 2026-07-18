# Backlog-sweep etter målbildet — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lukke den konsoliderte post-målbilde-backloggen (progress.md linje 274 + spredte minors): testhygiene til helgrønt, 12 små reelle bugs, dokumentasjonshull i fasadene, og forklar-per-celle-språk.

**Architecture:** Ingen nye subsystemer — kun målrettede fikser i eksisterende filer (index.html inline-scripts, js/cells.js, sw.js, tre python-fasader, tre brython-eksempler, to testfiler). Hver fiks er recon-verifisert mot dagens kode med fil:linje-ankere (linjetall er ca. — verifiser mot konteksten som siteres).

**Tech Stack:** Vanilla JS (inline + js/*.js), node:test (`node --test tests/js/*.test.js`), pytest, Playwright/browser-smoke mot lokal server.

## Global Constraints

- **Browser-smoke i SAMME oppgave** for enhver index.html-inline-endring (prosessregel fra 4a/EC — node --check fanger ikke scope). Kryss-IIFE alltid via `window.md*`.
- **Tvilling-paritet:** pyodide/ui.py ↔ brython/ui_brython.py ↔ micropython/ui_mpy.py holdes byte-like (kun dokumenterte dialektlinjer).
- **Rerun ×3** er standardrad i alle smokes som rører celle-kjøring (prosessnotat fra ui-html Task 3).
- Kommentarer og varseltekster på norsk (repo-husstil).
- **Cache-bumps SIST** (Task 8): `js/cells.js?v=` (index.html:580, nå `2026-07-18a`), `window.M2PY_VERSION` (index.html:597, nå `'2026-07-17e'`), `sw.js` `CACHE` (linje 6, nå `'m2py-v27'`).
- Baseline før planen: node 675 pass / 679 + 4 kjente ENOENT; pytest 1557 + 1 kjent collection-feil (krever `--continue-on-collection-errors`). **Etter Task 1 er begge helgrønne — alle senere tasks skal holde det.**
- Ledger: `.superpowers/sdd/progress.md` oppdateres per task.

## Bevisst UTSATT (ikke i denne planen)

- **nbCellAtCursor-drift** (index.html:5400-5419): akseptert og dokumentert ett-tikk-vindu; Task 2 fjerner den eneste krasjstien (TypeError-guarden). Ingen videre fiks.
- **_commit samme-celle-residual** (cells.js:1645-1700 + param-forms.js:730-780): akseptert designavveining («mist én kontroll-interaksjon fremfor tekstkorrupsjon»). Ingen endring.
- **`#options.view = present`-regexen matcher hele dokumentet** (index.html:6615): ankring til en options-region endrer semantikk for ALLE `#options.*` og kan knekke eksisterende dokumenter — egen beslutning med Hans, ikke backlog-opprydding.
- **R bare-value trailing-echo / R per-celle-attribusjon**: neste fase (egen spec/plan etter denne planen).
- **ui.widget for knapper som feature**: knapper har ingen verdi — dokumenteres (Task 5), bygges ikke.

---

### Task 1: Testhygiene — helgrønne suiter

**Files:**
- Modify: `tests/js/example-loads.test.js:13-24`
- Modify: `tests/conftest.py:8,14-15`
- Delete: `tests/test_equivalence.py`

**Interfaces:**
- Produces: nye baselinetall — node **679/679**, pytest **1557 pass uten flagg** — som alle senere tasks måler mot.

Bakgrunn: De 4 ENOENT-testene peker på flat `examples/`-rot, men fixturene ble flyttet til `examples/python/` og `examples/r/` (innholdet tilfredsstiller fortsatt assertions — verifisert). `tests/test_equivalence.py:18` gjør `from py2m import transform`, men `py2m/`-katalogen er permanent fjernet — harnessen kan aldri importere; filen slettes (gjenopprettbar fra git-historikk).

- [ ] **Step 1: Repoint fixture-stiene**

I `tests/js/example-loads.test.js`, erstatt (linje 13-14):

```js
const FILES = ['ex_csv_iris.txt','ex_columns_penguins.txt',
               'rex_csv_iris.txt','rex_columns_penguins.txt'];
```

med underkatalog-stier:

```js
const FILES = ['python/ex_csv_iris.txt','python/ex_columns_penguins.txt',
               'r/rex_csv_iris.txt','r/rex_columns_penguins.txt'];
```

(`path.join(root, 'examples', f)` på linje 18 håndterer `/` i navnet uendret.)

- [ ] **Step 2: Kjør node-suiten**

Run: `node --test tests/js/example-loads.test.js`
Expected: alle pass, 0 fail. Deretter full suite `node --test tests/js/*.test.js` → **679 pass / 0 fail**.

- [ ] **Step 3: Fjern død py2m-harness**

```bash
git rm tests/test_equivalence.py
```

I `tests/conftest.py`: slett linje 14-15 (kommentaren «Deretter: gjør py2m-pakken importerbar…» og `sys.path.insert(0, str(_root / "py2m"))`) og py2m-omtalen i toppkommentaren (linje 8) hvis den finnes.

- [ ] **Step 4: Kjør pytest UTEN flagg**

Run: `pytest tests/ brython/tests micropython/tests`
Expected: **1557 passed, 0 errors** — ingen `--continue-on-collection-errors` lenger.

- [ ] **Step 5: Commit**

```bash
git add -A tests/
git commit -m "test: helgrønne baselines — repoint 4 ENOENT-fixtures til examples/python|r, fjern død py2m-ekvivalensharness"
```

---

### Task 2: Små editorfikser (rightStatus, cursor-guard, advance, img-klikkfilter)

**Files:**
- Modify: `index.html:10517` (rightStatus), `index.html:5416-5417` (guard), `index.html:5512-5541` (advance)
- Modify: `js/cells.js:1266-1281` (klikkfilter)
- Test: `tests/js/cells-dom.test.js`

**Interfaces:**
- Consumes: `nbFirstBodyLine` (index.html:5436-5438), `mdJumpToCell`s hasBody-fallback (index.html:5708-5716) som mal.

- [ ] **Step 1: rightStatus-henget**

`bootNotebookSession` setter `setStatus(rightStatus, 'Running...')` (index.html:9802) men bare microdata-grenen tømmer den. I `mdRunNotebookCell`s finally (index.html:10517), erstatt:

```js
        if (isMicrodataReplay) setStatus(rightStatus, '');
```

med (ubetinget — idempotent for stier som aldri satte status):

```js
        // Sesjonsboot (nbEnsureSession→bootNotebookSession) setter 'Running...'
        // uten å tømme selv — tøm alltid her, ikke bare for microdata-replay.
        setStatus(rightStatus, '');
```

- [ ] **Step 2: TypeError-guard i nbCellAtCursor**

index.html:5416-5417 — stale `idx` fra `cellAtLineInDoc` kan peke utenfor fersk-parset `.cells` ved raskt programmatisk modusbytte → `resolveType(undefined)` kaster. Etter `var cell = window.Cells.parseCells(ta.value).cells[idx];`, legg inn:

```js
      if (!cell) return { idx: -1 }; // stale NB-idx vs. nytt dokumentinnhold (modusbytte i tikk-vinduet)
```

- [ ] **Step 3: advance() tomcelle-off-by-one**

I `advance()` (index.html:5512-5541), erstatt siste linje:

```js
  nbMoveCursorToLine(sTa, nbFirstBodyLine(nextCell));
```

med mdJumpToCell-mønsteret (index.html:5713):

```js
  // Tom celle (hasBody=false): startLine+1 er neste celles header — bli på headerlinjen.
  var lineIdx = (nextCell.hasBody || nextCell.headerRaw === null) ? nbFirstBodyLine(nextCell) : nextCell.startLine;
  nbMoveCursorToLine(sTa, lineIdx);
```

- [ ] **Step 4: img i klikkfilter — failing test først**

matplotlib-output rendres ofte som `<img>` (PNG-data-URL, jf. index.html:8103-8108) — klikk på den stjeler fokus/hopper markøren. I `tests/js/cells-dom.test.js`, følg fila sitt eksisterende harness-mønster (samme oppsett som eksisterende slot-klikk-tester rundt `isIgnorableClickTarget`/`CLICK_IGNORE`):

```js
test('klikk på <img> i slot stjeler ikke fokus (mdJumpToCell kalles ikke)', () => {
  // bygg doc med én kodecelle, render, legg en <img> i cellens .nb-output-body
  // (gjenbruk fila sitt oppsett for slot-klikk-testene), spy på window.mdJumpToCell,
  // dispatch click på img-noden:
  let jumped = false;
  global.window.mdJumpToCell = () => { jumped = true; };
  imgNode.dispatchEvent(new global.window.Event('click', { bubbles: true }));
  assert.equal(jumped, false);
});
```

Run: `node --test tests/js/cells-dom.test.js` → Expected: FAIL (klikket hopper i dag).

- [ ] **Step 5: Fiks — legg `img` i CLICK_IGNORE_TAGS**

`js/cells.js:1266`:

```js
var CLICK_IGNORE_TAGS = { input: 1, button: 1, select: 1, textarea: 1, a: 1, svg: 1, canvas: 1, img: 1 };
```

Oppdater resonnement-kommentaren (1257-1259) til også å nevne `<img>` (matplotlib-PNG via data-URL).

Run: `node --test tests/js/cells-dom.test.js` → Expected: PASS. Full suite: `node --test tests/js/*.test.js` → 680/680 (679 + den nye).

- [ ] **Step 6: Browser-smoke (obligatorisk — index.html-inline endret)**

Start lokal server (`python3 -m http.server 8899`), åpne appen:
1. Notatbok-dokument (f.eks. eksempelet «py_tag_direktiver»), kald sesjon, klikk per-celle ▶ på en python-celle → etter kjøring viser rightStatus IKKE «Running...» (hang før).
2. Shift+Enter i en celle rett før en TOM kodecelle → markøren lander på den tomme cellens headerlinje, ikke i neste celle.
3. Kjør en celle med matplotlib-plot (py_widgets_ui e.l.), klikk på plottet (img) → editor-markøren hopper IKKE.
4. Raskt modusbytte python↔brython ×3 med åpen konsoll → ingen TypeError fra cursor-tracking.
5. Rerun ×3 på én celle → ingen regresjon.

- [ ] **Step 7: Commit**

```bash
git add index.html js/cells.js tests/js/cells-dom.test.js
git commit -m "fix(editor): rightStatus tømmes alltid etter per-celle-boot; nbCellAtCursor-guard; advance() tomcelle-fallback; img i klikkfilteret"
```

---

### Task 3: cells.js-runde (tom-selText, #tag.id-dup, markørløs-gate, sniff-dedup, blank-slide)

**Files:**
- Modify: `js/cells.js:2093-2122` (runSelection), `:296,314-317,359-381` (id-varsel), `:330-340` (markørløs-gate), `:232-283` (sniff-dedup), `:426-453,1143-1147,1407-1413` (slidePlan/presentStart)
- Test: `tests/js/cells.test.js` (ren halvdel), `tests/js/cells-dom.test.js` (runSelection)

**Interfaces:**
- Produces: `C.slidePlan` uendret signatur, men `C.presentStart()` returnerer nå `false` for dokumenter der ALLE slides har tom `cellIdxs` (index.html:3657-3661 viser da eksisterende notis — ingen index.html-endring trengs).

- [ ] **Step 1: tom-selText → no-op, ikke helcelle — failing test**

I dag: seleksjon som kun består av tag-linjer blankes av `blankTagLinesInText` → falsy `selText` → `|| payload.text`-fallbacken (index.html:10034/10180/10317) kjører HELE cellen. Test i `tests/js/cells-dom.test.js` (følg eksisterende runSelection-testers oppsett med stubbet `global.mdRunNotebookCell`):

```js
test('runSelection med kun tag-linjer i seleksjonen kjører ingenting', () => {
  let called = false;
  global.mdRunNotebookCell = () => { called = true; return Promise.resolve({}); };
  // dokument med celle som har en #tag-linje; selText = kun tag-linjen:
  const res = global.Cells.runSelection(1, '#tag.style = width:100px');
  assert.equal(called, false);
  assert.equal(res, null);
});
```

Run: `node --test tests/js/cells-dom.test.js` → FAIL (mdRunNotebookCell kalles i dag).

- [ ] **Step 2: Fiks i C.runSelection**

I `js/cells.js` (~2093-2122), flytt blankingen FØR payload-byggingen og legg inn early-return:

```js
  var blankedSel = blankTagLinesInText(selText);
  if (!blankedSel.trim()) {
    // Seleksjonen var kun tag-/direktivlinjer — ingenting å kjøre.
    // Bevisst no-op (før falt vi til HELE cellen via ||-fallbacken nedstrøms).
    return null;
  }
```

og bruk `selText: blankedSel` i payload. Run test → PASS.

- [ ] **Step 3: #tag.id-duplikatvarsel — failing test**

`ids`-mappet bygges kun fra header-parsede id-er (cells.js:296,314-317); `#tag.id = foo` lander i `cell.attrs.id` via tag-merge (~380) uten dup-sjekk. Test i `tests/js/cells.test.js`:

```js
test('#tag.id duplisert mot header-id gir varsel', () => {
  const doc = '#%% python id=alpha\nx = 1\n#%% python\n#tag.id = alpha\ny = 2\n';
  const parsed = DD.parseCells(doc);
  assert.ok(parsed.warnings.some(w => /duplisert id: alpha/.test(w)));
});
test('#tag.id duplisert mot annen #tag.id gir varsel', () => {
  const doc = '#%% python\n#tag.id = beta\nx = 1\n#%% python\n#tag.id = beta\ny = 2\n';
  const parsed = DD.parseCells(doc);
  assert.ok(parsed.warnings.some(w => /duplisert id: beta/.test(w)));
});
```

Run: `node --test tests/js/cells.test.js` → FAIL ×2.

- [ ] **Step 4: Fiks i tag-merge-passet**

I den generiske merge-grenen (cells.js ~359-381), der `mk === 'id'` skrives til `cell.attrs`, sjekk og oppdater `ids` (samme varselformat som header-grenen på 315; linjetall = `bodyBase + ent.line + 1` — samme formel som warnings-løkka på 338-340, `ent` er tag-oppføringen med `line`-felt):

```js
        if (mk === 'id') {
          if (ids[ent.value] !== undefined && ids[ent.value] !== ci) {
            warnings.push('linje ' + (bodyBase + ent.line + 1) + ': duplisert id: ' + ent.value);
          }
          ids[ent.value] = ci; // sist vinner — samme regel som header-id
        }
```

(Verifiser feltnavnene mot den faktiske entry-formen i `scan.tags` før du committer.) Run tester → PASS.

- [ ] **Step 5: Markørløs-gate for tag-varsler**

`parseCells` skanner også markørløse dokumenters implisitte preambel og produserer varsler ingen konsument viser (alle gater på `hasMarkers`). Kun VARSLENE gates — `cell.tags` beholdes (plain-skript `#tag.import` er lastbærende via `Cells.scanTagBlock` direkte). I parse-passet (~330), beregn én gang og gate pushen (338-340):

```js
  var collectTagWarnings = C.hasMarkers(text);
  ...
      for (var wi = 0; wi < scan.warnings.length; wi++) {
        if (!collectTagWarnings) break;
        warnings.push('linje ' + (bodyBase + scan.warnings[wi].line + 1) + ': ' + scan.warnings[wi].msg);
      }
```

Test i `tests/js/cells.test.js`:

```js
test('markørløst dokument samler ingen tag-varsler', () => {
  const parsed = DD.parseCells('#tag.id = kan-ikke-vare-dokument-default\nx = 1\n');
  assert.equal(parsed.warnings.length, 0);
});
```

(RED først: dagens kode gir preambel-varselet «id kan ikke være dokument-default».)

- [ ] **Step 6: sniffType/renderContent-dedup**

Trekk den duplerte lone-string-skannen (cells.js:239-243 vs 270-280) inn i én helper over begge:

```js
  /** Lone-'''-blokk-skann: returnerer {rest, close} når HELE innholdet
   *  (etter første ikke-blanke linje) er én lukket triple-quoted streng,
   *  ellers null. Delt av sniffType (verdikt) og renderContent (uttrekk). */
  function loneStringScan(lines) {
    var first = -1;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].trim() !== '') { first = i; break; }
    }
    if (first === -1) return null;
    if (lines[first].slice(0, 3) !== '"""') return null;
    var rest = lines.slice(first).join('\n').slice(3);
    var close = rest.indexOf('"""');
    if (close === -1) return null;
    if (rest.slice(close + 3).trim() !== '') return null;
    return { rest: rest, close: close };
  }
```

`sniffType` beholder sin `<`-html-gren og blir ellers `return loneStringScan(lines) ? 'md' : null;`. `renderContent` (md+sniffed-grenen) blir:

```js
    var scan2 = loneStringScan(kept);
    if (scan2) out = scan2.rest.slice(0, scan2.close).replace(/^\n/, '').replace(/\n$/, '');
```

Ren refaktor — eksisterende sniff/render-tester i `tests/js/cells.test.js` er vernet: kjør dem før og etter, identisk resultat.

- [ ] **Step 7: All-skip-dokument → zero-slides-notis — failing test**

`slidePlan` bygger `nums` FØR skip-filtrering (cells.js:440-447), så all-skip gir én slide med tom `cellIdxs`; `presentStart` gater kun på `!plan.slides.length` (1147) → én blank slide. Test i `tests/js/cells.test.js`:

```js
test('slidePlan: alle celler skip → presentStart-gaten skal avvise', () => {
  const doc = '#%% skip\nx\n#%% skip\ny\n';
  const plan = DD.slidePlan(DD.parseCells(doc).cells);
  assert.ok(plan.slides.every(s => s.cellIdxs.length === 0));
});
```

Fiks i `presentStart` (cells.js:1146-1147) — behandle helt tomme planer som null slides:

```js
      var plan = C.slidePlan(NB.cells);
      var hasVisible = plan.slides.some(function (s) { return s.cellIdxs.length > 0; });
      if (!plan.slides.length || !hasVisible) return false;
```

Speil samme `hasVisible`-sjekk i re-plan-guarden (~1407-1413, samme `!_plan.slides.length`-form). index.html:3658-3661 viser da den eksisterende notisen gratis.

- [ ] **Step 8: Full suite + commit**

Run: `node --test tests/js/*.test.js` → alle pass (680 + de nye).

```bash
git add js/cells.js tests/js/cells.test.js tests/js/cells-dom.test.js
git commit -m "fix(cells): tag-only-seleksjon er no-op; #tag.id dekkes av duplikatvarselet; markørløs-gate for tag-varsler; loneStringScan-dedup; all-skip-presentasjon avvises med notis"
```

---

### Task 4: index.html-atferd (auto-klikk-suppress + engine-import-hoist)

**Files:**
- Modify: `index.html:9500-9517` (runtimeReadyBootstrap), `:1525` (eksempel/GitHub-last), `:1793` (filopplasting), `:10152-10174` (engine-notatbok-gate)

**Interfaces:**
- Produces: `window.mdUserLoadedDoc` (boolean, kryss-IIFE per prosessregelen).

- [ ] **Step 1: Suppress-flagget ved brukerinitiert last**

Ved de to brukerinitierte lastestedene, rett FØR `if (window.Cells) window.Cells.contentLoaded();`:

Eksempel/GitHub-lasteren (index.html:~1525) og filopplastings-handleren (index.html:~1793):

```js
          window.mdUserLoadedDoc = true; // undertrykk startup-auto-kjør når runtime blir klar
```

(IKKE i standalone/publisert boot ~2194 — publisert tekst matcher aldri STARTUP_EXAMPLES, og `?run=`/modusbytte-stiene skal fortsatt auto-kjøre startseksempelet.)

- [ ] **Step 2: Guard i runtimeReadyBootstrap**

Erstatt index.html:9507-9515:

```js
      if (!scriptRunInProgress && !_nbFrag) {
        setRunButtonsUi('idle');
        // Auto-kjør starteksempelet hvis brukeren ikke har endret teksten
        if (STARTUP_EXAMPLES[activeEditorMode] && scriptInput.value.trim() === STARTUP_EXAMPLES[activeEditorMode].trim()) {
          document.getElementById('btnRun').click();
        }
      } else if (!scriptRunInProgress) {
        setRunButtonsUi('idle');
      }
```

med (samme idle-semantikk, ett ekstra vilkår for klikket):

```js
      if (!scriptRunInProgress) {
        setRunButtonsUi('idle');
        // Auto-kjør starteksempelet hvis brukeren ikke har endret teksten —
        // men aldri etter en brukerinitiert dokumentlast (auto-klikk-racet,
        // 5b-sluttreviewens backlog): klikket kunne treffe et nylastet dokument.
        if (!_nbFrag && !window.mdUserLoadedDoc
            && STARTUP_EXAMPLES[activeEditorMode] && scriptInput.value.trim() === STARTUP_EXAMPLES[activeEditorMode].trim()) {
          document.getElementById('btnRun').click();
        }
      }
```

- [ ] **Step 3: Engine-import-hoist**

`runNotebookEngineCell` (index.html:10139-10192): flytt try/catch-blokken på 10162-10163

```js
          try { await window.mdEnsureTagImports(rightStatus); }
          catch (e) { console.warn('#tag.import (motor-notatbok):', e); }
```

UT av `if (!sess.isLive()) { ... }`-gaten (10152) til rett FØR den — kjøres nå hver celle, som pyodide-stien (10266-10272) og plain-runSelf (3291/3355) allerede gjør. `mdEnsureTagImports` er idempotent. Oppdater kommentaren på 10157-10161 («ÉN gang her» → «hver kjøring, idempotent — imports lagt til i live sesjon virker uten restart»).

- [ ] **Step 4: Browser-smoke (obligatorisk)**

1. Kald start (friskt vindu, python-modus, urørt starteksempel) → auto-kjør fyrer fortsatt når pyodide blir klar.
2. Friskt vindu, last et eksempel fra menyen FØR pyodide er klar → når runtime blir klar: ingen auto-klikk (`window.mdUserLoadedDoc === true` i konsollen), ingen uventet kjøring/interrupt.
3. Brython-notatbok: Kjør alle (kald sesjon) → legg til `#tag.import sl` i preambelen MENS sesjonen er live → kjør én celle med `ui.sl.button("x")` → elementet rendres UTEN restart. Rerun ×3.
4. Micropython: samme som 3.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "fix(app): undertrykk startup-auto-kjør etter brukerinitiert last; #tag.import lastes hver motor-cellekjøring (ikke kun kald sesjon)"
```

---

### Task 5: Fasade-docs + cls/class_-varsel (tvillinger ×3)

**Files:**
- Modify: `pyodide/ui.py` (`_normalize_kwargs` ~707-711, docstring ~678-689; `widget()` 568-586; `button()` 338-345)
- Modify: `brython/ui_brython.py` (speilede steder ~684-685, 581-599)
- Modify: `micropython/ui_mpy.py` (speilede steder ~776-777, 672-690)
- Test: `tests/test_ui_module.py`, `brython/tests/test_ui_brython.py`, `micropython/tests/test_ui_mpy.py`

**Interfaces:**
- Consumes: `_normalize_kwargs` er PUR og returnerer `(result, handlers, warnings)` — varselet legges i `warnings`-listen (kalleren emitter via `_warn`, pyodide/ui.py:625-630). INGEN `_warn`-kall inne i funksjonen.

- [ ] **Step 1: Failing test for cls+class_-kollisjonen**

I `tests/test_ui_module.py` (følg fila sitt eksisterende `_normalize_kwargs`-testmønster):

```python
def test_normalize_kwargs_cls_og_class_samtidig_varsler():
    result, handlers, warnings = ui._normalize_kwargs({"cls": "a", "class_": "b"})
    assert result["attrs"]["class"] == "b"  # siste vinner (kwargs-rekkefølge)
    assert any("cls=" in w and "class_=" in w for w in warnings)

def test_normalize_kwargs_kun_cls_ingen_varsel():
    result, handlers, warnings = ui._normalize_kwargs({"cls": "a"})
    assert result["attrs"]["class"] == "a"
    assert warnings == []
```

Run: `pytest tests/test_ui_module.py -k cls -v` → FAIL.

- [ ] **Step 2: Fiks i _normalize_kwargs (alle tre fasader, byte-like)**

Erstatt cls/class_-grenen:

```python
        if key in ("cls", "class_"):
            if "class" in attrs:
                warnings.append(
                    "ui.html: bade cls= og class_= angitt - siste vinner (her: " + key + "=)"
                )
            attrs["class"] = raw_value
            continue
```

Speil identisk i `brython/ui_brython.py` og `micropython/ui_mpy.py`, og speil testene i `brython/tests/test_ui_brython.py` og `micropython/tests/test_ui_mpy.py`.

- [ ] **Step 3: Docstring-linjer (alle tre fasader)**

I `_normalize_kwargs`-docstringen, utvid to punkter:
- cls-punktet: «BEGGE aksepteres; angis begge samtidig vinner den siste i kall-rekkefølgen + advarsel.»
- attrs-punktet: «Ved samme attributt-navn fra data_x=/aria_x= og attrs={} vinner den som kommer SIST i kall-rekkefølgen (attrs merges på sin plass) — udefinert var det aldri, men nå er det dokumentert.»

I `widget()`-docstringen (pyodide/ui.py:568-586 + tvillinger), legg til:
«Knapper kan ALDRI adresseres her: en button har ingen lagret verdi (ingen _values-oppføring JS-side, se js/ui.js _lookupKeyByName), så ui.widget("knappnavn") returnerer alltid None med "ukjent navn"-varselet.»

I `button()`-docstringen (pyodide/ui.py:338-345 + tvillinger), legg til kryssreferansen: «(derfor kan heller ikke ui.widget() adressere knapper).»

- [ ] **Step 4: Kjør suitene + tvilling-sjekk**

Run: `pytest tests/test_ui_module.py brython/tests/test_ui_brython.py micropython/tests/test_ui_mpy.py -v` → alle pass.
Run: full `pytest tests/ brython/tests micropython/tests` → 1557 + de nye, 0 feil.
Tvilling-verifisering: diff de tre `_normalize_kwargs`-kroppene mot hverandre (kun kjente dialektlinjer skal avvike).

- [ ] **Step 5: Commit**

```bash
git add pyodide/ui.py brython/ui_brython.py micropython/ui_mpy.py tests/test_ui_module.py brython/tests/test_ui_brython.py micropython/tests/test_ui_mpy.py
git commit -m "fix(ui-fasader): varsel ved cls=+class_= samtidig; dokumentert data_/attrs-presedens og at ui.widget aldri når knapper"
```

---

### Task 6: sw.js 404-fallback + brython-eksemplenes toppnivå-comprehensions

**Files:**
- Modify: `sw.js:92-110` (cacheFirst)
- Modify: `examples/brython/bry18_dashboard_fordeling.txt:47`, `examples/brython/bry22_dashboard_duckdb.txt:34-36`, `examples/brython/bry23_sklearn.txt:15,21,22,26`

**Interfaces:**
- Consumes: bry17-oppskriften (`examples/brython/bry17_dashboard_kostnad.txt`, commit 3e0b05b) som referansemønster: toppnivå-comprehensions → hjelpefunksjoner med vanlige for-løkker (motorens skop-lekkasje når ikke inn i ekte funksjonsskop).

- [ ] **Step 1: cacheFirst — behandle resolved-men-!ok som miss**

sw.js:92-110: en HTTP-404 er en OPPFYLT fetch-promise og returneres i dag verbatim (linje 104) — cache-fallbacken (106) nås kun ved kastet nettverksfeil. Erstatt try-kroppen:

```js
    try {
      const res = await fetch(req);
      if (res && res.ok) {
        cache.put(req, res.clone()).catch(() => {});
        return res;
      }
      // Transient 4xx/5xx (CDN-blipp): prøv cachet kopi før vi gir feilen videre —
      // en resolved !ok-respons nådde aldri catch-fallbacken under.
      const stale = await cache.match(req, { ignoreSearch: true });
      return stale || res;
    } catch (err) {
      const fallback = await cache.match(req, { ignoreSearch: true });
      if (fallback) return fallback;
      throw err;
    }
```

(Cache-bump av `CACHE` skjer samlet i Task 8.)

- [ ] **Step 2: bry18 — hoist tetthetslinjen**

`examples/brython/bry18_dashboard_fordeling.txt:47` — erstatt:

```python
ys = [float(norm.pdf(x, loc=mu, scale=sigma)) for x in xs]
```

med:

```python
def tetthet(xs, mu, sigma):
    ut = []
    for x in xs:
        ut.append(float(norm.pdf(x, loc=mu, scale=sigma)))
    return ut

ys = tetthet(xs, mu, sigma)
```

(Linje 44 er allerede trygt inne i `def xakse(...)` — ikke rør.)

- [ ] **Step 3: bry22 — hoist detalj-dicten**

`examples/brython/bry22_dashboard_duckdb.txt:34-36` — erstatt dict-comprehensionen med:

```python
def bygg_detalj(arter):
    d = {}
    for art in arter:
        d[art] = duckdb.sql(
            "SELECT sepal_length, petal_length FROM iris "
            "WHERE species = '" + art + "'").df()
    return d

detalj = bygg_detalj(ARTER)
```

- [ ] **Step 4: bry23 — hoist alle fire (to bruker lekkasjenavnet `r`)**

`examples/brython/bry23_sklearn.txt` — erstatt linjene 15/21/22/26 med hjelpefunksjoner:

```python
def str_kolonne(verdier):
    ut = []
    for k in verdier:
        ut.append(str(k))
    return ut

def kolonne(matrise, idx):
    ut = []
    for rad in matrise:
        ut.append(rad[idx])
    return ut

def merk_virginica(arter):
    ut = []
    for s in arter:
        ut.append(1 if s == "virginica" else 0)
    return ut
```

og kallstedene: `iris["klynge"] = str_kolonne(km.labels_.tolist())`, `iris["pc1"] = kolonne(pc, 0)`, `iris["pc2"] = kolonne(pc, 1)`, `y = merk_virginica(iris["species"])`. Plasser hjelpefunksjonene naturlig i dokumentflyten (bry17 som stilreferanse).

- [ ] **Step 5: Browser-verifisering (obligatorisk for eksempel-endringer)**

Per eksempel (bry18, bry22, bry23): last dokumentet, Kjør alle → identisk output som før (plot/tabeller rendres), rerun ×3, deretter DOKUMENTBYTTE til et annet brython-eksempel og tilbake (dette er _reset-stien lekkasjene forgiftet) → ingen `_reset`-advarsler i konsollen, andre kjøring ren.

- [ ] **Step 6: Commit**

```bash
git add sw.js examples/brython/bry18_dashboard_fordeling.txt examples/brython/bry22_dashboard_duckdb.txt examples/brython/bry23_sklearn.txt
git commit -m "fix(sw,eksempler): cacheFirst faller til cache ved transient !ok-respons; bry18/22/23 toppnivå-comprehensions hoistet per bry17-oppskriften"
```

---

### Task 7: forklar per-celle-språk (celletype i steget + ærlig notis)

**Files:**
- Modify: `js/cells.js:642-662` (forklarCellSteps)
- Modify: `index.html:6948-6957` (buildForklarBlocksForNotebook), `js/en.js` (ny nøkkel)
- Test: `tests/js/cells.test.js`

**Interfaces:**
- Produces: kodesteg fra `C.forklarCellSteps` bærer nå `cellType` (verdien fra `C.resolveType(cell, docMode)`). Fremmede celler (cellType ≠ docMode) får en tale-only notisblokk i stedet for feil-motor-kjøring. Replay-stien (index.html:11307-11345) hopper allerede over blokker med tom `code` (11314-11315) — ingen endring der.

Bakgrunn: steget bærer i dag kun `kind:'code'`; dispatchen (index.html:11372-11378) går på `activeEditorMode`, så en duckdb-celle i et python-dokument kjøres som pyodide-python → SyntaxError (nåbar via py_tag_direktiver + skrittvis, fase 1-backlog). Scope-beslutning: fremmedceller HOPPES ÆRLIG OVER med talt notis — kryss-motor-kjøring i forklar (duck-brua i forklar-sesjonen) er en egen feature, ikke backlog-opprydding.

- [ ] **Step 1: Failing test for cellType**

I `tests/js/cells.test.js` (ved de eksisterende forklarCellSteps-testene):

```js
test('forklarCellSteps bærer per-celle-språket', () => {
  const doc = '#%% python\nx = 1\n#%% duckdb\nSELECT 1\n#%% md\n"""tekst"""\n';
  const steps = DD.forklarCellSteps(doc, 'python');
  const code = steps.filter(s => s.kind === 'code');
  assert.equal(code[0].cellType, 'python');
  assert.equal(code[1].cellType, 'duckdb');
});
```

Run: `node --test tests/js/cells.test.js` → FAIL (`cellType` er undefined).

- [ ] **Step 2: Fiks i forklarCellSteps**

`js/cells.js:651` — erstatt:

```js
        steps.push({ kind: 'code', cellIdx: idx, source: C.execCellSource(cells[idx]) });
```

med:

```js
        steps.push({
          kind: 'code', cellIdx: idx,
          cellType: C.resolveType(cells[idx], docMode),
          source: C.execCellSource(cells[idx])
        });
```

Run test → PASS.

- [ ] **Step 3: Notisblokk for fremmedceller**

`index.html:6948-6957` — erstatt løkkekroppen i `buildForklarBlocksForNotebook`:

```js
      for (let i = 0; i < steps.length; i++) {
        const st = steps[i];
        // Fremmed celle (annet språk enn dokumentmotoren): ALDRI feil-motor-
        // kjøring (duckdb→pyodide ga SyntaxError, fase 1-backloggen) — en
        // tale-only notisblokk i stedet. Tom code ⇒ replay-stien hopper over
        // den selv (codeTrim-gaten i forklarReplayChunksBeforeIndex).
        if (st.kind === 'code' && st.cellType && st.cellType !== docMode) {
          blocks.push({
            code: '', codeTrim: '',
            commentItems: [{ silent: false, text: t('Cellen er i et annet språk og hoppes over i forklar-modus') + ' (' + st.cellType + ')', kwargs: {} }],
            postCommentItems: [], skipCodeSpeech: false
          });
          continue;
        }
        const b = st.kind === 'md' ? buildForklarMdNarrationBlock(st.source) : buildForklarCellCodeBlock(st.source);
        if (b) blocks.push(b);
      }
```

Legg nøkkelen `'Cellen er i et annet språk og hoppes over i forklar-modus'` i `js/en.js` («This cell is in a different language and is skipped in explain mode»).

- [ ] **Step 4: Browser-smoke (obligatorisk)**

Last «py_tag_direktiver»-eksempelet (python-dokument med duckdb-celle):
1. Start skrittvis/forklar → python-cellene kjører og tales som før; duckdb-cellen gir notisen (vist + talt), INGEN SyntaxError.
2. Bruk goto/tilbakespoling forbi duckdb-cellen → replay kjører rent (notisblokken hoppes over).
3. Vanlig notatbok-«Kjør alle» på samme dokument → uendret (duck-cellen kjører normalt der).
4. Forklar på et RENT python-dokument → byte-identisk oppførsel med før (ingen notiser).

- [ ] **Step 5: Commit**

```bash
git add js/cells.js index.html js/en.js tests/js/cells.test.js
git commit -m "fix(forklar): steg bærer per-celle-språk — fremmedceller får talt notis i stedet for feil-motor-kjøring"
```

---

### Task 8: Exit gate — cache-bumps, fulle suiter, sveip, ledger

**Files:**
- Modify: `index.html:580` (cells.js?v), `index.html:597` (M2PY_VERSION), `sw.js:6` (CACHE)
- Modify: `.superpowers/sdd/progress.md`

- [ ] **Step 1: Cache-bumps**

- `index.html:580`: `js/cells.js?v=2026-07-18a` → `js/cells.js?v=2026-07-18b`
- `index.html:597`: `window.M2PY_VERSION = '2026-07-17e'` → `'2026-07-18a'` (fasadene pyodide/ui.py m.fl. hentes med `?v=M2PY_VERSION`)
- `sw.js:6`: `const CACHE = 'm2py-v27'` → `'m2py-v28'`

- [ ] **Step 2: Fulle suiter**

Run: `node --test tests/js/*.test.js` → forventet: alle pass (679 + nye fra Task 2/3/7), **0 fail**.
Run: `pytest tests/ brython/tests micropython/tests` → forventet: 1557 + nye fra Task 5, **0 errors, uten flagg**.

- [ ] **Step 3: Browser-sveipmatrise (fersk server, cache-omgått)**

| # | Rad | Forventet |
|---|-----|-----------|
| 1 | Kald start python, urørt starteksempel | auto-kjør fyrer |
| 2 | Last eksempel før runtime klar | ingen auto-klikk |
| 3 | Per-celle ▶ på kald sesjon (python + duckdb-celle) | output OK, rightStatus tom etterpå |
| 4 | Shift+Enter-kjeding gjennom dokument med tom celle | markør riktig hele veien |
| 5 | Klikk på matplotlib-img i slot | ingen markørhopp |
| 6 | Seleksjonskjøring: kun tag-linjer valgt | no-op, hele cellen kjøres IKKE |
| 7 | brython-notatbok: #tag.import i live sesjon | element rendres uten restart, rerun ×3 |
| 8 | bry18/22/23: Kjør alle + dokbytte + tilbake ×2 | ingen _reset-advarsler |
| 9 | Skrittvis på py_tag_direktiver | duckdb-notis, ingen SyntaxError, goto OK |
| 10 | Presentasjon på all-skip-dokument | notis, ingen blank slide |
| 11 | Presentasjon på normalt dokument | uendret |
| 12 | py_widgets_ui full flyt (RunAll, widget-endring, Oppdater) | uendret regresjon |

- [ ] **Step 4: Ledger + commit**

Oppdater `.superpowers/sdd/progress.md` med backlog-sweep-seksjonen (per task: commit, review-status, gjenstående). Noter de nye baselinetallene og at UTSATT-listen (plan-headeren) er den gjenværende backloggen.

```bash
git add index.html sw.js .superpowers/sdd/progress.md
git commit -m "chore: backlog-sweep exit gate — cache-bumps (cells b, M2PY 2026-07-18a, sw v28), sveip 12/12"
```

---

## Selv-review-notater

- **Dekning mot backloggen (progress.md:274 + spredte):** alle punkter er enten en task (1-7), eksplisitt UTSATT (headeren), eller allerede fikset på main (bry10, stale kommentarer — commit 2e2eb95). R-attribusjon er neste fase.
- **Linjetall er recon-ankere**, ikke kontrakter — implementer verifiserer mot sitert kontekst før edit.
- **Typekonsistens:** `cellType` (Task 7) er `resolveType`-vokabularet ('python'|'duckdb'|'r'|'microdata'|'brython'|'micropython'|...); `window.mdUserLoadedDoc` boolean; `loneStringScan` returnerer `null | {rest, close}`.
