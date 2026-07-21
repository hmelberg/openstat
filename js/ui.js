/* ui.js — ui-widgetar (spec: docs/superpowers/specs/2026-07-15-notebook-widgets-design.md)
   Ren halvdel (øverst): kontroll-spec normalisering, nøkkelerutvikling.
   Node-testet, ingen DOM.
   DOM-halvdel (nederst): kontrollstripe, verdilager, endring-debounce→rerun. Kun browser.
   Adaptere (pyodide/ui.py) kaller det globale `Ui`-API-et; all data
   krysser grensen som JSON-strenger. */
(function (global) {
  'use strict';
  var Ui = {};

  // ---------- ren halvdel ----------

  // Gyldig kontrolltyper
  var VALID_TYPES = {
    slider: 1,
    dropdown: 1,
    checkbox: 1,
    switch: 1,
    number: 1,
    text: 1,
    button: 1,
    play: 1
  };

  // Gyldige nøkler i kontrollspec
  var VALID_KEYS = {
    type: 1,
    name: 1,
    label: 1,
    value: 1,
    min: 1,
    max: 1,
    step: 1,
    options: 1,
    rerun: 1,
    placement: 1,
    sync_to: 1,
    has_handler: 1,
    // into (fase 4b: mount-mål — el-id fra _els-registeret, se
    // _registerInto i DOM-halvdelen). Ren gjennomkopiering her (samme
    // "valider ikke innholdet i den rene halvdelen" som has_handler over)
    // — DOM-halvdelen slår opp selve elementet og advarer ved ukjent id.
    into: 1,
    // play (dash-absorpsjon 5a Task 3): avspillingsintervall (ms, gulvet
    // til 200 av normalizeSpec under) + loop-flagg (wrap til min ved max,
    // fremfor å stoppe).
    interval: 1,
    loop: 1
  };

  // Gyldige placement-verdier (per-kontroll plassering, Task 3) — samme
  // vokabular som cellens widgets=top|bottom|left-attributt (js/cells.js sin
  // WIDGETS_POS), men her en EGEN, uavhengig konstant: js/ui.js er en fri-
  // stående, node-testbar modul uten avhengighet til js/cells.js sin pure
  // halvdel (samme duplisering som resten av fila allerede dokumenterer).
  var VALID_PLACEMENTS = { top: 1, bottom: 1, left: 1 };

  /**
   * Ui.normalizeSpec(raw) → {spec, warnings}
   * Normaliser og valider én kontrollspec {type, name?, label?, value?, min?, max?, step?, options?, rerun?}
   * Returner {spec: normalized_spec_or_null, warnings: [strings]}
   */
  Ui.normalizeSpec = function (raw) {
    var spec = {};
    var warnings = [];

    if (!raw || typeof raw !== 'object') {
      warnings.push('kontrollspec er ikke objekt');
      return { spec: null, warnings: warnings };
    }

    // Ukjente nøkler: advar og ignorer (speiler cells.js parseHeader) —
    // spec bygges videre uten dem, aldri feil.
    for (var key in raw) {
      if (raw.hasOwnProperty(key) && !VALID_KEYS[key]) {
        warnings.push('ukjent nøkkel: ' + key);
      }
    }

    var type = raw.type;
    if (!type || !VALID_TYPES[type]) {
      var typeName = type ? String(type) : 'mangler';
      warnings.push('ukjent kontrolltype: ' + typeName);
      return { spec: null, warnings: warnings };
    }

    spec.type = type;

    // Kopier navn og label hvis de finnes
    if (raw.name !== undefined) spec.name = raw.name;
    if (raw.label !== undefined) spec.label = raw.label;

    // Håndter rerun
    if (raw.rerun !== undefined) {
      spec.rerun = raw.rerun;
    } else {
      spec.rerun = 'self';
    }

    // Håndter placement (Task 3, per-kontroll plassering): gyldig verdi →
    // OVERSTYRER cellens widgets=top|bottom|left-default for DENNE
    // kontrollen alene (DOM-halvdelen, _effectivePlacement, løser den
    // faktiske plasseringen — denne funksjonen validerer bare). Ugyldig
    // verdi → advar + IGNORER (spec.placement forblir udefinert, kontrollen
    // faller da tilbake til cellens default), aldri fatalt for hele specen.
    if (raw.placement !== undefined) {
      var placementVal = String(raw.placement);
      if (VALID_PLACEMENTS[placementVal]) {
        spec.placement = placementVal;
      } else {
        warnings.push('ugyldig placement: ' + placementVal);
      }
    }

    // has_handler (ui-html-fasen, Task 1, widget-callable-kanalen): fasaden
    // (Task 2) setter denne når on_change=/on_click= er et python-callable
    // (i motsetning til et cellenavn-strengalias) — DOM-halvdelens
    // Ui.registerControl leser flagget for å pakke returverdien inn i
    // {value,key} (se der) slik fasaden får nøkkelen å binde
    // Ui.bindControlHandler mot. Ren boolsk kopiering, ingen validering
    // utover det (enhver "sannferdig" verdi normaliseres til ekte boolsk).
    if (raw.has_handler !== undefined) {
      spec.has_handler = !!raw.has_handler;
    }

    // into (fase 4b): el-id — streng, gjennomkopiert UVALIDERT (selve
    // eksistensen av elementet sjekkes i DOM-halvdelen, _registerInto, som
    // har _els-registeret; den rene halvdelen her vet ingenting om DOM).
    if (raw.into !== undefined) {
      spec.into = String(raw.into);
    }

    // sync_to (fase 3, spec §3): push av verdien inn i en navngitt sesjons-
    // variabel. Navnet interpoleres i kodestrenger hos mottakerne
    // (mdUiSyncTo) — regexen her ER injeksjonsvernet, aldri fjern den.
    if (raw.sync_to !== undefined) {
      var syncName = String(raw.sync_to);
      if (type === 'button') {
        warnings.push('sync_to støttes ikke på button');
      } else if (!/^[A-Za-z_.][\w.]*$/.test(syncName)) {
        warnings.push('ugyldig sync_to-navn: ' + syncName);
      } else {
        spec.sync_to = syncName;
      }
    }

    // Type-spesifikk normalisering
    if (type === 'slider') {
      var min = raw.min !== undefined ? Number(raw.min) : 0;
      var max = raw.max !== undefined ? Number(raw.max) : 100;
      var step = raw.step !== undefined ? Number(raw.step) : 1;
      // NaN-vakter: ugyldige tall faller tilbake til default + advarsel
      if (isNaN(min)) { warnings.push('ugyldig min for slider: ' + raw.min); min = 0; }
      if (isNaN(max)) { warnings.push('ugyldig max for slider: ' + raw.max); max = 100; }
      if (isNaN(step)) { warnings.push('ugyldig step for slider: ' + raw.step); step = 1; }
      if (min > max) {
        warnings.push('slider: min > max — byttet om');
        var tmp = min; min = max; max = tmp;
      }
      var value = raw.value !== undefined ? Number(raw.value) : min;
      if (isNaN(value)) { warnings.push('ugyldig value for slider: ' + raw.value); value = min; }

      // Klamp verdi til intervall
      if (value < min) value = min;
      if (value > max) value = max;

      spec.min = min;
      spec.max = max;
      spec.step = step;
      spec.value = value;
    } else if (type === 'dropdown') {
      if (!raw.options || !Array.isArray(raw.options) || raw.options.length === 0) {
        warnings.push('dropdown krever non-tomt options array');
        return { spec: null, warnings: warnings };
      }

      // Konverter options til strenger
      spec.options = raw.options.map(function (opt) {
        return String(opt);
      });

      // Sett verdi — hvis eksplisitt gitt, konverter til string; ellers bruk
      // første option. N2-fiksen (final-review): første-kjørings-stien her
      // beholdt tidligere en eksplisitt verdi UTENFOR options uendret (kun
      // koersjon til string), mens oppdaterings-stien (_updateControlSpec
      // under, DOM-halvdelen) alltid har snappet en slik verdi til
      // options[0] — de to stiene var altså uenige om SAMME spec avhengig av
      // om det var celledens første eller n-te kjøring. Align'et her på
      // oppdaterings-stiens oppførsel: snap + advarsel, ALDRI en verdi som
      // ikke finnes i options-lista.
      if (raw.value !== undefined) {
        var strValue = String(raw.value);
        if (spec.options.indexOf(strValue) === -1) {
          // W1-carryover (c): meldingen skal navngi verdien vi SNAPPET TIL
          // (spec.options[0]) — tidligere sto her den AVVISTE verdien
          // (strValue), som er misvisende ("snappet til første: c" mens den
          // faktiske snappede verdien var "a").
          warnings.push('dropdown: value ikke i options — snappet til første: ' + spec.options[0]);
          spec.value = spec.options[0];
        } else {
          spec.value = strValue;
        }
      } else {
        spec.value = spec.options[0];
      }
    } else if (type === 'checkbox' || type === 'switch') {
      // Konverter til boolean
      spec.value = Boolean(raw.value);
    } else if (type === 'number') {
      var numVal = raw.value !== undefined ? Number(raw.value) : 0;
      if (isNaN(numVal)) { warnings.push('ugyldig value for number: ' + raw.value); numVal = 0; }
      // min/max/step er valgfrie for number (i motsetning til slider, som
      // krever dem) — speiler pyodide-fasadens signatur (Task 4:
      // ui.number(value=0, *, min=None, max=None, step=None, ...)). Kun
      // kopiert inn i spec når eksplisitt gitt; ugyldige tall varsler og
      // ignoreres (samme NaN-vakt-filosofi som slider over) i stedet for
      // å falle tilbake til en påtvunget default — number har ingen
      // naturlig default-grense.
      if (raw.min !== undefined) {
        var numMin = Number(raw.min);
        if (isNaN(numMin)) { warnings.push('ugyldig min for number: ' + raw.min); }
        else spec.min = numMin;
      }
      if (raw.max !== undefined) {
        var numMax = Number(raw.max);
        if (isNaN(numMax)) { warnings.push('ugyldig max for number: ' + raw.max); }
        else spec.max = numMax;
      }
      if (raw.step !== undefined) {
        var numStep = Number(raw.step);
        if (isNaN(numStep)) { warnings.push('ugyldig step for number: ' + raw.step); }
        else spec.step = numStep;
      }
      if (spec.min !== undefined && numVal < spec.min) numVal = spec.min;
      if (spec.max !== undefined && numVal > spec.max) numVal = spec.max;
      spec.value = numVal;
    } else if (type === 'text') {
      var strVal = raw.value !== undefined ? String(raw.value) : '';
      spec.value = strVal;
    } else if (type === 'play') {
      // dash-absorpsjon 5a Task 3: som slider (min/max/step/value, samme
      // NaN-vakter/klamping/min>max-bytte), PLUSS interval (ms, gulvet til
      // 200 — dash sin play-widget sin egen regel, js/dash.js:309) og loop
      // (boolsk — wrap til min ved max fremfor å stoppe).
      var pMin = raw.min !== undefined ? Number(raw.min) : 0;
      var pMax = raw.max !== undefined ? Number(raw.max) : 100;
      var pStep = raw.step !== undefined ? Number(raw.step) : 1;
      if (isNaN(pMin)) { warnings.push('ugyldig min for play: ' + raw.min); pMin = 0; }
      if (isNaN(pMax)) { warnings.push('ugyldig max for play: ' + raw.max); pMax = 100; }
      if (isNaN(pStep)) { warnings.push('ugyldig step for play: ' + raw.step); pStep = 1; }
      if (pMin > pMax) {
        warnings.push('play: min > max — byttet om');
        var pTmp = pMin; pMin = pMax; pMax = pTmp;
      }
      var pValue = raw.value !== undefined ? Number(raw.value) : pMin;
      if (isNaN(pValue)) { warnings.push('ugyldig value for play: ' + raw.value); pValue = pMin; }
      if (pValue < pMin) pValue = pMin;
      if (pValue > pMax) pValue = pMax;
      spec.min = pMin;
      spec.max = pMax;
      spec.step = pStep;
      spec.value = pValue;
      var pInterval = raw.interval !== undefined ? Number(raw.interval) : 600;
      if (isNaN(pInterval)) { warnings.push('ugyldig interval for play: ' + raw.interval); pInterval = 600; }
      spec.interval = Math.max(200, pInterval);
      spec.loop = !!raw.loop;
    } else if (type === 'button') {
      // Button har bare label, ingen value
      // label allerede kopiert ovenfor
    }

    return { spec: spec, warnings: warnings };
  };

  /**
   * Ui.controlKey(cellKey, spec, ordinal) → string
   * Returner identiteten for denne kontrollen: cellKey + '::' + (spec.name || 'w' + ordinal)
   * cellKey er notatbokens STABILE celle-nøkkel (W2-carryover: Cells.cellKeyAt
   * — attrs.id når cellen har én, ellers råindeksen konvertert til streng) —
   * IKKE nødvendigvis selve celleindeksen lenger. Denne funksjonen forblir en
   * ren streng-sammenslåing og gjør ingen oppslag selv; DOM-halvdelen under
   * står for å utlede riktig cellKey via Cells.cellKeyAt (guardet) FØR den
   * kalles.
   */
  Ui.controlKey = function (cellKey, spec, ordinal) {
    var name = spec.name || ('w' + ordinal);
    return cellKey + '::' + name;
  };

  // ---------- payload-vokabular: tallformat (flyttet fra js/dash.js, dash-
  // absorpsjon 5a Task 1 — SAMME implementasjon, ikke en gaffel; dash.js
  // delegerer nå til Ui.formatNumber/Ui.computeDelta i stedet for å eie
  // dem selv). Number-payload v3 (spec 2026-07-12 §3.1): adapterne sender
  // rå {value, unit, fmt, ref, bra}; motoren formaterer. Én implementasjon
  // av norsk tallformat — U+202F tusenskille, komma-desimal, U+2212-minus.
  var NNBSP = '\u202f';
  var MINUS = '\u2212';

  function groupInt(intStr) {
    return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, NNBSP);
  }

  // fmt: python-format-spec-delmengden [,][.N][f|%]. Ukjent spec → default
  // (rund til 2 desimaler, strip etternuller, grupper). Kaster aldri.
  Ui.formatNumber = function (value, fmt) {
    if (typeof value !== 'number' || !isFinite(value)) return String(value);
    var m = (typeof fmt === 'string' && fmt) ? fmt.match(/^(,)?(?:\.(\d+))?(f|%)?$/) : null;
    var known = !!(m && (m[1] || m[2] != null || m[3]));
    var group = known ? !!m[1] : true;
    var pct = known && m[3] === '%';
    var v = pct ? value * 100 : value;
    var abs = Math.abs(v);
    var s;
    if (known) {
      var decimals = (m[2] != null) ? +m[2] : (m[3] ? 6 : null); // som pythons format()
      s = (decimals != null) ? abs.toFixed(decimals) : String(abs);
    } else {
      s = String(Math.abs(+v.toFixed(2)));
    }
    var parts = s.split('.');
    if (group) parts[0] = groupInt(parts[0]);
    s = parts[0] + (parts[1] ? ',' + parts[1] : '');
    return (v < 0 ? MINUS : '') + s + (pct ? '%' : '');
  };

  // Delt av Ui.computeDelta (diff = value - ref) og ui.kpi sin direkte
  // delta= (diff = den rå delta-verdien, ingen ref/value involvert) — se
  // Ui.renderPayload sin kpi-gren.
  function deltaFromDiff(diff, fmt, bra) {
    var dir = diff > 0 ? 'opp' : (diff < 0 ? 'ned' : 'flat');
    var good = dir === 'flat' || dir === (bra || 'opp');
    return { text: (diff >= 0 ? '+' : MINUS) + Ui.formatNumber(Math.abs(diff), fmt),
             dir: dir, good: good };
  }

  Ui.computeDelta = function (value, ref, fmt, bra) {
    if (typeof value !== 'number' || !isFinite(value)) return null;
    if (typeof ref !== 'number' || !isFinite(ref)) return null;
    return deltaFromDiff(value - ref, fmt, bra);
  };

  // Eksporter til global og CommonJS
  global.Ui = Ui;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Ui;
  }

  // ---------- DOM-halvdel (kun browser) ----------
  // Kjøres kun når det finnes et `document` (nettleser) — node:test-suiten
  // for den rene halvdelen over (tests/js/ui.test.js) har ingen DOM og skal
  // aldri nå hit. DOM-halvdelens egen suite (tests/js/ui-dom.test.js)
  // installerer en hånd-stubbet DOM FØR require(), samme mønster som
  // tests/js/cells-dom.test.js bruker for js/cells.js.
  //
  // Pull-modell (spec §arkitektur): verdiene lever HER (Ui._values), ikke i
  // Python. Hver `ui.*`-kontroll re-registreres for hver kjøring av cellen
  // og FÅR TILBAKE den lagrede gjeldende verdien — ingen push inn i Python-
  // globaler. Endringer (input/change) lagrer umiddelbart, men selve
  // rerun-kallet er debouncet (150ms, samme oppskrift som js/dash.js sin
  // `debounce`) for å unngå en kjøring per piksel en slider dras over.
  //
  // Byggerne (_buildSlider/_buildDropdown/osv.) er EGNE, modellert på
  // dash.js sin `buildControl` (js/dash.js:328-448) — dash sine er interne
  // lukkinger (ikke eksponert på `window.Dash`), så de kan ikke gjenbrukes
  // direkte. Denne dupliseringen er en bevisst W1-avgrensning (se planens
  // "No dash.js refactor in W1") — en felles kontroll-bygger-modul er en
  // W2+ opprydding.
  if (typeof document !== 'undefined') {
    // ---- dokument-scoped tilstand ------------------------------------
    // controlKey → gjeldende verdi. Overlever celle-reregistrering og
    // struktur-re-rendring (F6-mønsteret) — kun Ui.resetDocument() (nytt
    // dokument, se Cells.contentLoaded) nullstiller dette.
    var _values = {};
    // controlKey → { key, cellIdx, spec, wrap, input, labelEl, readout, type }
    // DOM-referansene for gjeldende, LEVENDE kontroller (oppdateres i
    // registerControl, fjernes i endCellRun/resetDocument).
    var _controls = {};
    // controlKey → handler-funksjon (ui-html-fasen, Task 1: widget-callable-
    // kanalen). Satt av Ui.bindControlHandler (kalt av fasaden RETT ETTER
    // registerControl når spec.has_handler er sann), lest av _wireChange/
    // knappe-klikk i stedet for å fyre en rerun. Samme guardede .destroy-
    // livssyklus som _bindings (fjernes i endCellRun/resetDocument/ved
    // erstatning) — pyodide-proxier destrueres, brython/mpy-funksjoner er
    // en no-op der.
    var _controlHandlers = {};
    // controlKey → setInterval-id (dash-absorpsjon 5a Task 3: ui.play sin
    // avspillingstimer). EKSPLISITT sporet (i motsetning til bare en
    // lukking-lokal variabel i _buildPlay) slik enhver kode-sti som fjerner
    // en kontroll (type-bytte, sveip i endCellRun, resetDocument) kan
    // klarere ut timeren DETERMINISTISK via clearInterval — uten dette ville
    // en fjernet/frakoblet play-kontroll latt sin setInterval fortsette å
    // fyre for alltid (et no-op-tick takket være tick() sin egen
    // isConnected-sjekk, men fortsatt en ekte, uendelig kjørende timer —
    // spec §Error handling: "ui.play timer can never leak"). Se
    // _stopPlayTimer under.
    var _playTimers = {};
    function _stopPlayTimer(key) {
      var t = _playTimers[key];
      if (t) { clearInterval(t); delete _playTimers[key]; }
    }
    // cellIdx → { top?, bottom?, left? } — cellens .ui-controls-noder PER
    // POSISJON (Task 3, per-kontroll plassering; tidligere én enkelt node
    // per celle) for lazy gjenbruk mellom kall.
    var _strips = {};
    // cellIdx → { ordinal, registered: {controlKey: true}, closed }.
    // Nullstilles EKSPLISITT av Ui.beginCellRun (kalt fra de samme
    // kjørebrakettene i index.html som SETTER nbUiRunCtx) — det gjør
    // stale-soppen i endCellRun korrekt også når en rerun har NULL
    // ui.*-kall (kilden fjernet alle kontrollene): uten beginCellRun
    // ville "ny kjøring startet" bare vært observerbar via første
    // registerControl, som aldri kommer. "closed" (satt av endCellRun)
    // beholdes som lat fallback for registerControl-kall som skulle nå
    // hit uten en foregående beginCellRun, og gjør endCellRun idempotent
    // — et duplikatkall (flere kjørebraketter kan begge kalle den for
    // samme celle) sopper ingenting nytt andre gang.
    var _cellRuns = {};

    function _el(tag, cls, text) {
      var props = {};
      if (cls) props.className = cls;
      if (text != null) props.textContent = text;
      return Ui.makeNode(tag, { props: props });
    }

    function _labelText(spec) {
      return spec.label || spec.name || '';
    }

    // Kopi av js/dash.js sin debounce (js/dash.js:170-177) — hver kontroll
    // får sin EGEN debounce-lukking (ikke én delt global timer): en slider
    // og en dropdown i samme celle skal ikke kunne kansellere hverandres
    // ventende rerun.
    function _debounce(fn, ms) {
      var timer = null;
      return function () {
        var args = arguments;
        clearTimeout(timer);
        timer = setTimeout(function () { fn.apply(null, args); }, ms);
      };
    }

    // rerun-oppløsning: 'none' → ingen mål; 'self'/udefinert → den
    // deklarerende cellen; streng/array av id-er → Cells.cellIndexById
    // (ukjent id → console.warn + hoppes over, aldri kastet).
    function _resolveTargets(spec, selfCellIdx) {
      var rerun = spec.rerun;
      if (rerun === 'none') return [];
      if (rerun === 'all') return 'all';   // sentinel — hele skriptet (fase 3)
      if (rerun === 'self' || rerun == null) {
        // doc-kontekst (rent skript): default er rerun="none" per decision 7
        // — 'self' har ingen celle å peke på og løses STILLE til ingen mål.
        if (selfCellIdx == null) return [];
        return [selfCellIdx];
      }
      // id-mål i doc-kontekst: meningsløst — ett varsel, ingen mål.
      if (selfCellIdx == null) {
        console.warn('Ui: rerun-mål ignoreres i rent skript: ' + rerun);
        return [];
      }
      var ids = Array.isArray(rerun) ? rerun : [rerun];
      var idxs = [];
      ids.forEach(function (id) {
        var idx = (global.Cells && typeof global.Cells.cellIndexById === 'function')
          ? global.Cells.cellIndexById(id) : -1;
        if (idx === -1) {
          console.warn('Ui: ukjent rerun-mål id: ' + id);
        } else if (idxs.indexOf(idx) === -1) {
          // Dedup: rerun:['a','a'] (eller to id-er som løses til samme
          // celle) skal gi ÉN kjøring, ikke to.
          idxs.push(idx);
        }
      });
      return idxs;
    }

    // Kjører rerun for kontrollen med gitt nøkkel. Nektes (drop, ikke kø)
    // mens en kjøring allerede pågår — neste endring re-trigger debouncen.
    function _rerunFor(key) {
      var ctrl = _controls[key];
      if (!ctrl) return;
      if (global.mdIsScriptRunning && global.mdIsScriptRunning()) return;
      var targets = _resolveTargets(ctrl.spec, ctrl.cellIdx);
      if (targets === 'all') {
        // Hele skriptet: index.html-kroken klikker #btnRun (Kjør alle i
        // notatbøker, vanlig kjøring ellers). Refuse-drop-vakta over
        // dekker allerede pågående kjøringer.
        if (typeof global.mdRunWholeScript === 'function') global.mdRunWholeScript();
        return;
      }
      // B3-fiksen (final-review): mdRunNotebookCell (index.html) setter
      // scriptRunInProgress SYNKRONT idet kjøringen starter — å fyre
      // global.Cells.runCell(idx) for alle mål i samme synkrone forEach
      // (som før) betydde at mål nr. 2..n traff den vakta (samme
      // mdIsScriptRunning()-sjekk som over dette blokk) mens mål nr. 1
      // fortsatt kjørte, og ble refuse-droppet — kun det FØRSTE
      // rerun-målet i en `rerun:['a','b',…]`-liste kjørte noensinne i
      // praksis. Kjør target-listen i SERIE i stedet:
      // Cells.runCell(idx) returnerer ALLTID et promise (js/cells.js
      // ~770, både tidlig-retur-grenene og hovedløpet), så neste mål
      // venter til forrige er HELT ferdig (inkludert dens egen
      // scriptRunInProgress=false) før den i det hele tatt starter.
      // W1-carryover (b): en avsluttende .catch på HELE kjeden — uten den
      // ville et mål som kaster synkront (eller returnerer et avvist promise)
      // latt rejectionen boble ut som en unhandled rejection (ingen .then-
      // gren over fanger den, og _rerunFor sitt kall-sted bryr seg ikke om
      // returverdien). console.warn i stedet: kjøringen fortsetter å fungere
      // for brukeren, feilen blir synlig i konsollen fremfor å krasje stille.
      targets.reduce(function (p, idx) {
        return p.then(function () {
          if (global.Cells && typeof global.Cells.runCell === 'function') return global.Cells.runCell(idx);
        });
      }, Promise.resolve()).catch(console.warn);
    }

    // sync_to-push (fase 3, spec §3): inn i motorens sesjonsvariabel via
    // index.html-kroken. Fyrer ved registrering OG ved hver endring, alltid
    // FØR en evt. rerun. Ingen krok / ingen sesjon → stille no-op
    // (verdilageret er uansett autoritativt for neste pull).
    function _syncPush(spec, value) {
      if (!spec.sync_to) return;
      if (typeof global.mdUiSyncTo !== 'function') return;
      try { global.mdUiSyncTo(spec.sync_to, value); }
      catch (e) { console.warn('Ui sync_to: ' + ((e && e.message) || e)); }
    }

    // Widget-callable-kanalen (ui-html-fasen, Task 1): fyrer den bundne
    // handleren for `key` (om noen finnes) i stedet for en rerun. Samme
    // nekt-mens-kjøring-pågår-filosofi og feil-innpakning som
    // _dispatchBinding (W5.2, under) bruker for element-event-bindinger —
    // duplisert her fremfor delt fordi payload-formen og mål-cellen
    // (ctrl.cellIdx, ikke en binding sitt cellIdx) er kontroll-spesifikk.
    // Returnerer true når EN handler fantes (uansett om den ble droppet) —
    // "en kontroll med et callable rerunner aldri", så _wireChange skal
    // ALDRI falle videre til fireDebounced() når dette er tilfellet.
    function _fireControlHandler(key, value) {
      var handler = _controlHandlers[key];
      if (!handler) return false;
      if (global.mdIsScriptRunning && global.mdIsScriptRunning()) {
        console.debug('Ui: kontroll-handler droppet (kjøring pågår)');
        return true;
      }
      var payloadJson;
      try {
        payloadJson = handler(JSON.stringify({ value: value }));
      } catch (err) {
        payloadJson = JSON.stringify({ kind: 'error', text: String((err && err.message) || err) });
      }
      var ctrl = _controls[key];
      Ui.renderEventResult({ cellIdx: ctrl ? ctrl.cellIdx : null, target: null }, payloadJson);
      return true;
    }

    // Felles endrings-håndterer: lagrer verdien UMIDDELBART (getValue()),
    // debouncer selve rerun-kallet 150ms — MED MINDRE en handler er bundet
    // (widget-callable-kanalen, Task 1): da fyres handleren i stedet, og
    // reruen droppes helt (dokumentert: en kontroll med et callable
    // rerunner aldri). _syncPush kjører uansett FØRST, uendret.
    function _wireChange(key, getValue) {
      var fireDebounced = _debounce(function () { _rerunFor(key); }, 150);
      return function () {
        _values[key] = getValue();
        var ctrl = _controls[key];
        if (ctrl) _syncPush(ctrl.spec, _values[key]);
        if (_fireControlHandler(key, _values[key])) return;
        fireDebounced();
      };
    }

    // ---- byggere (én per kontrolltype) --------------------------------
    // Alle unntatt button returnerer { wrap, input, labelEl?, readout? }.
    // `wrap` er selve <label>-noden som legges i stripa.

    function _buildSlider(key, cellIdx, spec, value) {
      var wrap = _el('label', 'ui-widget');
      var labelEl = _el('span', 'ui-widget-label', _labelText(spec));
      wrap.appendChild(labelEl);
      var input = Ui.makeNode('input', { props: { type: 'range', min: spec.min, max: spec.max, step: spec.step, value: value } });
      var readout = _el('span', 'ui-widget-value', String(value));
      var change = _wireChange(key, function () { return Number(input.value); });
      input.addEventListener('input', function () {
        readout.textContent = String(input.value);
        change();
      });
      wrap.appendChild(input);
      wrap.appendChild(readout);
      return { wrap: wrap, input: input, labelEl: labelEl, readout: readout };
    }

    function _buildDropdown(key, cellIdx, spec, value) {
      var wrap = _el('label', 'ui-widget');
      var labelEl = _el('span', 'ui-widget-label', _labelText(spec));
      wrap.appendChild(labelEl);
      var input = Ui.makeNode('select');
      spec.options.forEach(function (opt) {
        input.appendChild(Ui.makeNode('option', { props: { value: opt, textContent: opt } }));
      });
      input.value = value;
      input.addEventListener('change', _wireChange(key, function () { return input.value; }));
      wrap.appendChild(input);
      return { wrap: wrap, input: input, labelEl: labelEl };
    }

    function _buildCheckbox(key, cellIdx, spec, value, isSwitch) {
      // Egen modifikator-klasse for switch (CSS-en selv nøkler på
      // input[role="switch"], men wrap-klassen gjør varianten adresserbar
      // for tester/fremtidige regler uten attributt-selektor).
      var wrap = _el('label', isSwitch ? 'ui-widget ui-widget--check ui-widget--switch' : 'ui-widget ui-widget--check');
      var labelEl = _el('span', 'ui-widget-label', _labelText(spec));
      wrap.appendChild(labelEl);
      var input = Ui.makeNode('input', isSwitch
        ? { props: { type: 'checkbox', checked: !!value }, attrs: { role: 'switch' } }
        : { props: { type: 'checkbox', checked: !!value } });
      input.addEventListener('change', _wireChange(key, function () { return input.checked; }));
      // Avkrysningsboksen/svitsjen konvensjonelt FØR etiketten (speiler
      // js/dash.js sin dash-widget--check, dash.js:369-370).
      wrap.insertBefore(input, wrap.firstChild);
      return { wrap: wrap, input: input, labelEl: labelEl };
    }

    function _buildNumber(key, cellIdx, spec, value) {
      var wrap = _el('label', 'ui-widget');
      var labelEl = _el('span', 'ui-widget-label', _labelText(spec));
      wrap.appendChild(labelEl);
      var nprops = { type: 'number', value: value };
      if (spec.min != null) nprops.min = spec.min;
      if (spec.max != null) nprops.max = spec.max;
      if (spec.step != null) nprops.step = spec.step;
      var input = Ui.makeNode('input', { props: nprops });
      input.addEventListener('change', _wireChange(key, function () { return Number(input.value); }));
      wrap.appendChild(input);
      return { wrap: wrap, input: input, labelEl: labelEl };
    }

    function _buildText(key, cellIdx, spec, value) {
      var wrap = _el('label', 'ui-widget');
      var labelEl = _el('span', 'ui-widget-label', _labelText(spec));
      wrap.appendChild(labelEl);
      var input = Ui.makeNode('input', { props: { type: 'text', value: value } });
      input.addEventListener('change', _wireChange(key, function () { return String(input.value); }));
      wrap.appendChild(input);
      return { wrap: wrap, input: input, labelEl: labelEl };
    }

    // dash-absorpsjon 5a Task 3: slider + play/pause-knapp + readout, med
    // dash sin EKSAKTE tre-veis timerhygiene (js/dash.js:272-324, portert
    // ordrett hit): timeren ryddes (1) ved pause-klikk, (2) ved manuell
    // slider-'input' (brukeren tok kontrollen selv), og (3) — sjekket INNI
    // selve tick-en — når input-noden er koblet fra DOM-et (kontrollen
    // fjernet/erstattet uten at noen av de to andre veiene fyrte). Ved max:
    // wrap til min hvis spec.loop, ellers stopp. HVER tick går gjennom
    // NØYAKTIG samme sti som en brukerendring — samme `change`-lukking
    // _wireChange returnerer (som _buildSlider bruker for sin 'input'-
    // lytter): input.value settes FØRST, deretter kalles change(), som
    // lagrer _values[key] (leser DET NYE input.value), sync_to-pusher, og
    // enten fyrer en bundet handler eller debouncer en rerun — ingen egen
    // "tick-payload"-vei. _playTimers[key] (over) er den EKSPLISITTE
    // timer-sporingen fjernings-stiene (typeChanged/placementChanged/
    // endCellRun/resetDocument) klarerer ut via _stopPlayTimer.
    function _buildPlay(key, cellIdx, spec, value) {
      var wrap = _el('label', 'ui-widget ui-widget--play');
      var labelEl = _el('span', 'ui-widget-label', _labelText(spec));
      wrap.appendChild(labelEl);
      var input = Ui.makeNode('input', { props: { type: 'range', min: spec.min, max: spec.max, step: spec.step, value: value } });
      var readout = _el('span', 'ui-widget-value', String(value));
      var btn = Ui.makeNode('button', { props: { className: 'ui-play-btn', textContent: '▶', type: 'button' }, attrs: { 'aria-label': 'Spill av' } });
      var change = _wireChange(key, function () { return Number(input.value); });

      function stopPlay() {
        _stopPlayTimer(key);
        btn.textContent = '▶';
        // className (ikke classList.add/remove — resten av filen bruker
        // ALDRI classList-mutasjon, kun _el()/className direkte; btn har
        // uansett bare disse to gjensidig utelukkende tilstandene).
        btn.className = 'ui-play-btn';
      }
      function tick() {
        if (!input.isConnected) { stopPlay(); return; }
        // Review-fiks (Task 3-oppfølging, repro bekreftet kjørbart): les
        // LEVENDE spec fra _controls[key] her — IKKE den FROSNE closure-en
        // `spec` fra _buildPlay-kallet som bygde denne noden. Når kontrollen
        // re-registreres MENS timeren løper (_updateControlSpec skriver
        // ctrl.spec = newSpec), fortsetter en tick som leser `spec` direkte
        // å bruke de OPPRINNELIGE grensene for alltid: loop true→false
        // wrappet fortsatt ved max, og max 2→10 stoppet fortsatt ved 2.
        // Speiler hvordan _wireChange (~550) allerede leser _controls[key]
        // i stedet for en frosset spec-referanse.
        var liveSpec = (_controls[key] && _controls[key].spec) || spec;
        var v = Number(input.value) + Number(liveSpec.step);
        if (v > liveSpec.max) {
          if (liveSpec.loop) v = liveSpec.min;
          else { stopPlay(); return; }
        }
        input.value = v;
        readout.textContent = String(v);
        change();
      }
      function startPlay() {
        if (_playTimers[key]) return;
        // Samme levende-spec-lesing som tick() (over). MERK: en ALLEREDE
        // løpende setInterval kan ikke "retimes" av en spec-endring
        // underveis (ingen clearInterval-fri måte å bytte periode på en
        // levende timer) — en interval-endring får derfor først effekt fra
        // NESTE play-trykk (stopp+start), ikke på en kontroll som allerede
        // spiller.
        var liveSpec = (_controls[key] && _controls[key].spec) || spec;
        var ms = Math.max(200, Number(liveSpec.interval) || 600);
        btn.textContent = '⏸';
        btn.className = 'ui-play-btn ui-play-btn--playing';
        _playTimers[key] = setInterval(tick, ms);
      }
      btn.addEventListener('click', function () {
        if (_playTimers[key]) stopPlay(); else startPlay();
      });
      input.addEventListener('input', function () {
        stopPlay();
        readout.textContent = String(input.value);
        change();
      });
      wrap.appendChild(input);
      wrap.appendChild(readout);
      wrap.appendChild(btn);
      return { wrap: wrap, input: input, labelEl: labelEl, readout: readout };
    }

    function _buildButton(key, cellIdx, spec) {
      var label = spec.label || (typeof t === 'function' ? t('Kjør') : 'Kjør');
      var btn = Ui.makeNode('button', { props: { className: 'ui-widget ui-widget--button', textContent: label, type: 'button' } });
      // Ingen debounce: et knappeklikk skal rerunne UMIDDELBART — MED
      // MINDRE en handler er bundet (widget-callable-kanalen, Task 1): da
      // fyres handleren i stedet (knapper har ingen lagret verdi, se
      // over — value-argumentet til handleren er derfor alltid null).
      btn.addEventListener('click', function () {
        if (_controlHandlers[key]) { _fireControlHandler(key, null); return; }
        _rerunFor(key);
      });
      return { wrap: btn, input: btn };
    }

    // fase 2 (spec 2026-07-20): all konstruksjon går via Ui.makeNode — byggerne eier ingen egne DOM-idiomer lenger.
    var _BUILDERS = {
      slider: _buildSlider,
      dropdown: _buildDropdown,
      checkbox: function (key, cellIdx, spec, value) { return _buildCheckbox(key, cellIdx, spec, value, false); },
      switch: function (key, cellIdx, spec, value) { return _buildCheckbox(key, cellIdx, spec, value, true); },
      number: _buildNumber,
      text: _buildText,
      play: _buildPlay
    };

    // Skriver `v` til kontrollens DOM-node PER TYPE — klampet/koersert mot
    // ctrl.spec sine GJELDENDE grenser/valg (slider/number: min/max;
    // dropdown: options; checkbox/switch: boolsk; text: streng) — og
    // returnerer den faktisk skrevne verdien. Factored ut av
    // _updateControlSpec (dash-absorpsjon 5a Task 2: "the VALUE-write out
    // of" spec-oppdateringen) slik Ui.widgetSet (under) kan gjenbruke
    // NØYAKTIG samme per-type-klamp for et programmatisk .set(v) — UTEN
    // noen av de STRUKTURELLE spec-endringene (min/max-attributter,
    // dropdown-options-listen, label) _updateControlSpec selv gjør FØR den
    // kaller hit. Button har ingen gren her (ingen lagret verdi, ingen
    // DOM-verdi å skrive) — _registerInto returnerer alltid FØR
    // _updateControlSpec for button-specs, og Ui.widgetSet (under) avviser
    // button-nøkler eksplisitt av samme grunn.
    function _writeControlValue(ctrl, v) {
      var spec = ctrl.spec;
      var value = v;
      if (spec.type === 'slider' || spec.type === 'play') {
        value = Number(value);
        if (value < spec.min) value = spec.min;
        if (value > spec.max) value = spec.max;
        ctrl.input.value = value;
        if (ctrl.readout) ctrl.readout.textContent = String(value);
      } else if (spec.type === 'dropdown') {
        value = String(value);
        if (spec.options.indexOf(value) === -1) value = spec.options[0];
        ctrl.input.value = value;
      } else if (spec.type === 'number') {
        value = Number(value);
        if (spec.min != null && value < spec.min) value = spec.min;
        if (spec.max != null && value > spec.max) value = spec.max;
        ctrl.input.value = value;
      } else if (spec.type === 'checkbox' || spec.type === 'switch') {
        value = !!value;
        ctrl.input.checked = value;
      } else if (spec.type === 'text') {
        value = String(value);
        ctrl.input.value = value;
      }
      return value;
    }

    // Oppdaterer en EKSISTERENDE kontrollnode i place (label/min/max/step/
    // options fra ny spec) men BEHOLDER lagret verdi (klampet til evt. nytt
    // intervall) — ingen ny DOM-node, ingen fokus-tap. Den STRUKTURELLE
    // delen (attributter/options-liste/label) skjer her; selve
    // verdi-skrivingen (klamp + input.value/checked) er _writeControlValue
    // (over) — kalt SIST, ETTER at ctrl.spec/attributtene allerede
    // reflekterer newSpec, slik klampen bruker de NYE grensene.
    function _updateControlSpec(ctrl, newSpec) {
      var stored = _values.hasOwnProperty(ctrl.key) ? _values[ctrl.key] : newSpec.value;
      ctrl.spec = newSpec;
      if (ctrl.labelEl) ctrl.labelEl.textContent = _labelText(newSpec);
      if (newSpec.type === 'slider' || newSpec.type === 'play') {
        ctrl.input.min = newSpec.min; ctrl.input.max = newSpec.max; ctrl.input.step = newSpec.step;
      } else if (newSpec.type === 'dropdown') {
        while (ctrl.input.firstChild) ctrl.input.removeChild(ctrl.input.firstChild);
        newSpec.options.forEach(function (opt) {
          ctrl.input.appendChild(Ui.makeNode('option', { props: { value: opt, textContent: opt } }));
        });
      } else if (newSpec.type === 'number') {
        // N3-fiksen (final-review): min/max/step er VALGFRIE for number
        // (normalizeSpec kopierer dem kun inn når eksplisitt gitt). Om ny
        // spec UTELATER en av dem (kilden fjernet f.eks. `max=10` fra
        // ui.number(...)-kallet), må attributtet FJERNES her — å bare la
        // være å sette en ny verdi lot den forrige kjøringens min/max/step
        // henge igjen som en STALE begrensning ingen gjeldende spec lenger
        // ber om.
        if (newSpec.min != null) ctrl.input.min = newSpec.min;
        else ctrl.input.removeAttribute('min');
        if (newSpec.max != null) ctrl.input.max = newSpec.max;
        else ctrl.input.removeAttribute('max');
        if (newSpec.step != null) ctrl.input.step = newSpec.step;
        else ctrl.input.removeAttribute('step');
      }
      return _writeControlValue(ctrl, stored);
    }

    // Finn cellEl sitt (direkte) barn med gitt klasse — enkel lineær skann
    // (ingen querySelector-motor forutsettes å finnes på stub-DOM-er i
    // tester; speiler js/param-forms.js sin egen _findChild for symmetri).
    function _findChild(parent, cls) {
      var kids = (parent && parent.children) || [];
      for (var i = 0; i < kids.length; i++) {
        if (kids[i].classList && kids[i].classList.contains(cls)) return kids[i];
      }
      return null;
    }

    // Cellens DEFAULT-plassering (Task 3): lest av widgets=top|bottom|left
    // sin nb-widgets-<pos>-klasse på .nb-output (satt av js/cells.js sin
    // cellNode, uendret av dette tasket) — brukes KUN når en kontrolls EGEN
    // spec.placement mangler/er ugyldig (normalizeSpec har allerede validert
    // den, se VALID_PLACEMENTS over). 'top' er defaulten når klassen selv
    // mangler (cellEl uten .nb-output-barn, f.eks. en avvikende test-stub).
    function _cellDefaultPlacement(cellEl) {
      if (!cellEl) return 'top';
      var outEl = _findChild(cellEl, 'nb-output');
      if (outEl && outEl.classList) {
        if (outEl.classList.contains('nb-widgets-left')) return 'left';
        if (outEl.classList.contains('nb-widgets-bottom')) return 'bottom';
      }
      return 'top';
    }

    // Kontroll-nivå OVERSTYRER cellens default (Task 3-designet: "control-
    // level placement OVERRIDES the cell attr").
    function _effectivePlacement(spec, cellEl) {
      if (spec.placement === 'top' || spec.placement === 'bottom' || spec.placement === 'left') {
        return spec.placement;
      }
      return _cellDefaultPlacement(cellEl);
    }

    // Venstre-sidekolonnen er DELT mellom param-forms og ui.js (Task 3-
    // designet: én .nb-strips-left-node per celle, ikke én per system) —
    // js/param-forms.js sin egen _build/_insertStrip finner/oppretter SAMME
    // node via samme klassenavn, så begge systemers venstre-plasserte
    // kontroller stables i den ene delte kolonnen.
    function _ensureLeftWrapper(outEl) {
      if (!outEl) return null;
      var wrap = _findChild(outEl, 'nb-strips-left');
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'nb-strips-left';
        outEl.appendChild(wrap);
      }
      return wrap;
    }

    // Lag (lazy) eller gjenbruk cellens .ui-controls-stripe FOR EN GITT
    // POSISJON (Task 3: opptil tre samtidige .ui-controls-noder per celle —
    // top/bottom/left — i stedet for én). Et data-pos-attributt (satt her)
    // er det CSS-en (app.css) faktisk ruter visuell plassering på via
    // grid-area — DOM-rekkefølgen under er derfor bevisst UENDRET fra
    // tidligere (alltid "rett FØR .nb-output-body" når stripa lever direkte
    // i .nb-output) for BÅDE top- og bottom-plasserte striper: visuell
    // plassering er nå CSS Grid sin jobb (data-pos → grid-area), ikke
    // DOM-rekkefølgen, så å bruke samme insertBefore-oppskrift for en
    // bunn-stripe også er ufarlig og holder funksjonen enkel og ensartet.
    // Ved en strukturell re-rendring bytter cellEl identitet (F6-mønsteret)
    // — da bygges stripa på nytt (gamle DOM-referanser i _controls for
    // cellen glemmes), men _values (selve verdiene) er dokument-scoped,
    // ikke DOM-node-scoped, og overlever. outEl/container mangler → stripa
    // opprettes men forblir en løsrevet node, samme stille-forkastet-
    // filosofi som resten av modulen.
    function _ensureStrip(cellEl, cellIdx, pos) {
      // Doc-kontekst (fase 3): verten er #outputArea, ikke en celles
      // .nb-output. 'left' faller til 'top' (ingen grid der — spec §1).
      var docHost = null;
      if (!cellEl) {
        docHost = document.getElementById ? document.getElementById('outputArea') : null;
        if (!docHost) return document.createElement('div');   // løsrevet, stille-forkastet
        if (pos === 'left') pos = 'top';
      }
      var outEl = docHost || _findChild(cellEl, 'nb-output');
      var container = (!docHost && pos === 'left') ? _ensureLeftWrapper(outEl) : outEl;
      var byPos = _strips[cellIdx] || (_strips[cellIdx] = {});
      var strip = byPos[pos];
      if (strip && strip.parentNode === container) return strip;
      // Task 3-fiks: sveip-ALT-for-cellIdx-en er kun en STALENESS-signal
      // (F6 strukturell re-rendring — cellEl byttet identitet, DENNE
      // posisjonens strip henger fortsatt på det GAMLE, nå frakoblede
      // outEl) — IKKE "denne posisjonen brukes for aller første gang i
      // cellens levetid" (byPos[pos] === undefined er det NORMALE, hyppige
      // tilfellet når en celle blander plasseringer: f.eks. en kontroll
      // flyttes fra 'top' til 'left', og 'left' sin strip opprettes her for
      // FØRSTE gang — det er IKKE bevis på at 'top' sine allerede levende
      // kontroller (en helt annen, fortsatt gyldig stripe) er foreldede).
      // Sveipes derfor KUN når byPos[pos] FANTES men var stale, aldri når
      // den bare var fraværende.
      //
      // Final-review-fiks (BLOCKER): sveipet må skopes til DENNE posisjonen
      // (cellIdx OG placement === pos), ikke til HELE cellIdx-en. Kun
      // stripa for `pos` er stale her — andre posisjoners striper (f.eks.
      // 'top' mens 'left' er den stale) er fortsatt like levende og innsatt
      // som før F6-byttet. Å slette ALLE _controls-oppføringer for cellIdx
      // rammer da også SAMME-run-registreringer fra de andre posisjonene
      // (de er allerede bygget på nytt i denne kjøringen, i sin egen
      // fortsatt-gyldige stripe) — de mister sin _controls-oppføring uten å
      // miste DOM-noden sin, og blir en levende orphan: neste kjøring finner
      // ingen `existing` for den nøkkelen og bygger en ANDRE node ved siden
      // av, altså en duplikat-kontroll.
      if (strip) {
        Object.keys(_controls).forEach(function (key) {
          if (_controls[key].cellIdx === cellIdx && _controls[key].placement === pos) delete _controls[key];
        });
      }
      strip = document.createElement('div');
      strip.className = 'ui-controls';
      strip.setAttribute('data-pos', pos);
      if (container) {
        if (docHost) {
          if (pos === 'bottom') container.appendChild(strip);
          else container.insertBefore(strip, container.firstChild || null);
        } else if (container === outEl) {
          var body = _findChild(outEl, 'nb-output-body');
          if (body) outEl.insertBefore(strip, body);
          else outEl.appendChild(strip);
        } else {
          container.appendChild(strip);
        }
      }
      byPos[pos] = strip;
      return strip;
    }

    // Utleder den STABILE celle-nøkkelen for en råindeks (W2-carryover d):
    // Cells.cellKeyAt (js/cells.js) når tilgjengelig, ellers råindeksen selv
    // konvertert til streng (samme fallback som Cells.cellKeyAt sin egen
    // id-løse gren — holdt i sync eksplisitt her fordi Cells kan mangle helt
    // i node:test-stubbene og i "plain script"-kjøretid uten notatbok).
    function _cellKeyAt(cellIdx) {
      if (cellIdx == null) return 'doc';   // rent skript (fase 3) — samme sentinel som bindingsstien
      return (global.Cells && typeof global.Cells.cellKeyAt === 'function')
        ? global.Cells.cellKeyAt(cellIdx) : String(cellIdx);
    }

    /**
     * _registerInto(cellIdx, cellEl, spec) → {value, key} — value er
     * gjeldende verdi (rå JS-verdi, ikke JSON-streng; null for button), key
     * er kontrollens stabile controlKey (ui-html-fasen, Task 1: fasaden
     * trenger nøkkelen for å binde Ui.bindControlHandler når
     * spec.has_handler er sann — se Ui.registerControl). Delt kjerne mellom
     * Ui.registerControl (ctx-drevet, ett spec om gangen) og
     * Ui.registerFromRegistry (eksplisitt cellIdx, et helt array om gangen) —
     * begge kaller inn HIT for selve registrerings-/ombyggingslogikken; de er
     * bare to ulike måter å komme frem til (cellIdx, cellEl, ferdig normalisert
     * spec) på.
     */
    function _registerInto(cellIdx, cellEl, spec) {
      var cellKey = _cellKeyAt(cellIdx);

      var run = _cellRuns[cellIdx];
      if (!run || run.closed) {
        run = _cellRuns[cellIdx] = { ordinal: 0, registered: {} };
      }
      var ordinal = run.ordinal++;
      var key = Ui.controlKey(cellKey, spec, ordinal);
      run.registered[key] = true;

      // Task 3: effektiv plassering FØR stripa hentes — _ensureStrip må vite
      // hvilken av de (opptil tre) posisjons-stripene denne kontrollen skal
      // bygges/oppdateres i.
      var pos = _effectivePlacement(spec, cellEl);

      // fase 4b (spec 2026-07-21): into= — monter kontrollen i et element
      // fra _els-registeret i stedet for stripa. Ukjent id → warn +
      // stripe-fallback (en kontroll skal aldri forsvinne). into vinner
      // over placement (gjensidig utelukkende, warn ved begge).
      var intoNode = null;
      if (spec.into) {
        if (spec.placement) console.warn('Ui: into= og placement= er gjensidig utelukkende — into vinner');
        var intoEntry = _els[spec.into];
        intoNode = intoEntry ? intoEntry.node : null;
        if (!intoNode) console.warn('Ui: ukjent into-mål ' + spec.into + ' — faller tilbake til stripa');
      }
      var strip = intoNode || _ensureStrip(cellEl, cellIdx, pos);
      var existing = _controls[key];

      // W2-carryover (d): en id-tagget celle kan ha flyttet RÅINDEKS siden
      // forrige registrering (strukturell re-rendring satte den inn et annet
      // sted) mens den STABILE nøkkelen (cellKey) er uendret — eksisterende
      // her peker da på en kontroll-node bundet til en ANNEN (trolig allerede
      // fjernet) stripe, og kan ikke gjenbrukes i place i DENNE stripa.
      // _values[key] (selve verdien) er IKKE rørt her — kun denne stale
      // _controls-oppføringen slippes, slik at grenene under bygger en fersk
      // node i riktig stripe, seedet med den overlevende lagrede verdien.
      if (existing && existing.cellIdx !== cellIdx) {
        if (existing.type !== spec.type) delete _values[key];
        existing = undefined;
      }

      // B2-fiksen (final-review): et type-bytte under SAMME nøkkel (kilden
      // endret f.eks. ui.slider(...) til ui.dropdown(...) uten å endre
      // name/rekkefølge — samme controlKey) må bygge kontrollen HELT PÅ
      // NYTT. Grenene under (existing ? _updateControlSpec : bygg fersk)
      // antar at `existing`, når den finnes, er SAMME kontrolltype — de
      // muterer input-noden i place (f.eks. dropdown-grenen i
      // _updateControlSpec legger <option>-noder RETT INN i det som var et
      // <input type="range">, og en slider→button hadde tømt button-wrappen
      // sin egen struktur). Fjern den gamle DOM-noden og glem både
      // kontroll- og verdi-oppføringen — resten av funksjonen ser da
      // nøyaktig ut som en helt fersk registrering.
      //
      // Task 3: et PLASSERING-bytte under samme nøkkel (samme kontrolltype,
      // men effektiv posisjon endret — cellens attributt eller kontrollens
      // egen placement=) må RE-PARENTES like rent: fjern den gamle wrap-noden
      // fra sin gamle stripe og bygg fersk i den NYE (strip peker allerede på
      // riktig posisjon over). Til forskjell fra et type-bytte beholdes
      // _values[key] HER (samme kontrolltype — verdien er fortsatt gyldig,
      // kun stedet den vises endret seg; "no value loss" per Task 3-kravet).
      var typeChanged = existing && existing.type !== spec.type;
      // fase 4b: host-bytte (intoId endret — inn i et NYTT into-mål, eller inn/
      // ut av into-verdenen) join'er samme regel som et rent stripe-bytte.
      // existing.intoId er ALLTID satt (spec.into || null, se lagrings-
      // punktene under) — aldri undefined — så sammenligningen er trygg også
      // for kontroller som aldri har brukt into.
      var placementChanged = existing && !typeChanged &&
        (existing.placement !== pos || existing.intoId !== (spec.into || null));
      //
      // W1-carryover (a): FØR fjerning, fang nextSibling — den gamle nodens
      // posisjon i stripa. Den nye kontrollen settes inn PRESIS der (insertBefore
      // i stedet for appendChild lenger ned), slik at et type-bytte midt i en
      // strek med flere kontroller ikke lenger hopper til slutten av stripa.
      // reinsertBefore er null i det vanlige tilfellet (ingen type-bytte) —
      // insertBefore(node, null) legger til på slutten, akkurat som
      // appendChild ville gjort, så denne ene insertBefore-kallet dekker
      // begge situasjonene ensartet. Ved et RENT plassering-bytte er
      // reinsertBefore alltid null (den nye stripa er en ANNEN node enn den
      // gamle — "sett inn presis der" gir ingen mening på tvers av striper).
      var reinsertBefore = null;
      if (typeChanged) {
        reinsertBefore = existing.wrap ? existing.wrap.nextSibling : null;
        if (existing.wrap && typeof existing.wrap.remove === 'function') existing.wrap.remove();
        // dash-absorpsjon 5a Task 3: en type-byttet play-kontroll sin
        // avspillingstimer må dø HER — no-op for enhver annen type (se
        // _stopPlayTimer).
        _stopPlayTimer(key);
        delete _controls[key];
        delete _values[key];
        // ui-html-fasen (Task 1): en type-endret kontroll er en HELT NY
        // identitet under samme nøkkel — en gammel bundet handler (om noen)
        // hører til den forrige typens semantikk og må ikke henge igjen.
        // Fasaden re-binder (Ui.bindControlHandler) uansett på nytt i SAMME
        // registrerings-runde dersom den nye specen også har has_handler,
        // så denne sletting-med-destroy er ren hygiene mot lekkasje for
        // tilfellet der den IKKE har det lenger.
        if (_controlHandlers[key]) {
          _destroyHandler({ handler: _controlHandlers[key] });
          delete _controlHandlers[key];
        }
        existing = undefined;
      } else if (placementChanged) {
        // fase 4b: når DENNE registreringen faktisk løser til et into-mål
        // (intoNode satt), er et host-bytte IKKE en grunn til å rive ned og
        // bygge fersk — samme node gjenbrukes og re-parenteres i stedet
        // (se appendChild-kallet i eksisterende-grenen under). Kun en
        // stripe-internt bytte (eller en retrett UT av into-verdenen, hvor
        // intoNode denne runden er null) river ned og bygger fersk, som før.
        if (!intoNode) {
          if (existing.wrap && typeof existing.wrap.remove === 'function') existing.wrap.remove();
          // Samme timer-hygiene som typeChanged over: den GAMLE noden (og
          // dens ev. løpende timer) forlates for godt — en fersk kontroll
          // bygges rett under, alltid i pause-tilstand.
          _stopPlayTimer(key);
          delete _controls[key];
          existing = undefined;
        }
      }

      if (spec.type === 'button') {
        if (!existing) {
          var builtBtn = _buildButton(key, cellIdx, spec);
          if (builtBtn.input && typeof builtBtn.input.setAttribute === 'function') builtBtn.input.setAttribute('data-ui-key', key);
          strip.insertBefore(builtBtn.wrap, reinsertBefore);
          _controls[key] = { key: key, cellIdx: cellIdx, spec: spec, wrap: builtBtn.wrap, input: builtBtn.input, type: 'button', placement: pos, intoId: spec.into || null };
        } else {
          existing.spec = spec;
          existing.wrap.textContent = spec.label || (typeof t === 'function' ? t('Kjør') : 'Kjør');
          // fase 4b: hold intoId i sync + re-parenter INN i (evt. nye)
          // into-målet på HVER into-registrering — appendChild flytter
          // noden når den allerede har en annen forelder.
          existing.intoId = spec.into || null;
          if (intoNode) {
            intoNode.appendChild(existing.wrap);
          } else if (existing.intoId) {
            // fase 4b review-fiks: into-målet forsvant under et UENDRET into=-id
            // (generasjons-sveipet tok verts-elementet) — strand aldri kontrollen
            // usynlig; samme stripe-fallback som en fersk ukjent-id-registrering får.
            strip.insertBefore(existing.wrap, null);
            existing.intoId = null;
          }
        }
        // fase 4b: håndtak-kontrakt KUN når monteringen faktisk skjedde
        // (intoNode satt) — ukjent into-mål faller tilbake til den vanlige,
        // enkle returen (ingen __into-wrapper, se _registerInto sin
        // fallback-dokumentasjon over).
        if (intoNode) return { value: null, key: key, __into: true, name: spec.name || null };
        return { value: null, key: key };
      }

      var value;
      if (existing) {
        value = _updateControlSpec(existing, spec);
        existing.intoId = spec.into || null;
        if (intoNode) {
          intoNode.appendChild(existing.wrap);
        } else if (existing.intoId) {
          // fase 4b review-fiks: into-målet forsvant under et UENDRET into=-id
          // (generasjons-sveipet tok verts-elementet) — strand aldri kontrollen
          // usynlig; samme stripe-fallback som en fersk ukjent-id-registrering får.
          strip.insertBefore(existing.wrap, null);
          existing.intoId = null;
        }
      } else {
        var stored = _values.hasOwnProperty(key) ? _values[key] : spec.value;
        var builder = _BUILDERS[spec.type];
        var built = builder(key, cellIdx, spec, stored);
        // data-ui-key (spec-krav, ui-html-fasen Task 1): stabil DOM-identitet
        // for kontrollen — bygges kun ved fersk node (nøkkelen er stabil på
        // tvers av re-registreringer av SAMME kontroll, ingen grunn til å
        // re-sette den ved en ren _updateControlSpec-oppdatering over).
        if (built.input && typeof built.input.setAttribute === 'function') built.input.setAttribute('data-ui-key', key);
        strip.insertBefore(built.wrap, reinsertBefore);
        _controls[key] = {
          key: key, cellIdx: cellIdx, spec: spec, wrap: built.wrap, input: built.input,
          labelEl: built.labelEl, readout: built.readout, type: spec.type, placement: pos, intoId: spec.into || null
        };
        value = stored;
      }
      _values[key] = value;
      _syncPush(spec, value);
      if (intoNode) return { value: value, key: key, __into: true, name: spec.name || null };
      return { value: value, key: key };
    }

    /**
     * Ui.registerControl(specJson) → JSON-streng med gjeldende verdi, eller
     * null (ingen aktiv kjørekontekst — "plain script"-fallback, spec §krav).
     * Ctx-drevet tynn wrapper rundt _registerInto: løser (cellIdx, cellEl) via
     * window.mdUiRunCtx() og parser/normaliserer ÉN spec, deretter delegerer.
     *
     * Widget-callable-kanalen (ui-html-fasen, Task 1): når spec.has_handler
     * er sann UTVIDES returen til et JSON-OBJEKT `{value, key}` (nøkkelen
     * fasaden trenger for det påfølgende Ui.bindControlHandler-kallet) —
     * ALLE andre specs (has_handler fraværende/usann) beholder den gamle,
     * enkle verdi-returen UENDRET (bakoverkompatibelt med pyodide/brython/
     * mpy/R-fasadene slik de er i dag).
     *
     * fase 4b: når _registerInto sin retur har `__into` (spec.into faktisk
     * monterte kontrollen et sted), UTVIDES returen i stedet til
     * `{__into: true, value, key, name}` — dette VINNER over has_handler-
     * grenen over (into og has_handler er ikke gjensidig utelukkende i
     * specen, men into-håndtaket er det fasaden (Task 2) trenger når
     * kontrollen ikke lever i stripa). Ukjent into-mål (fallback til stripa)
     * har IKKE `__into` på reg — den grenen faller da videre til
     * has_handler/bare-verdi som før.
     */
    Ui.registerControl = function (specJson) {
      var ctx = (typeof global.mdUiRunCtx === 'function') ? global.mdUiRunCtx() : null;
      if (!ctx) return null;
      // cellEl kan være null i en kant-case (Task 2-rapporten) — dette
      // guardes eksplisitt, ikke bare "ctx finnes".
      // Fase 3: doc-kontekst (rent skript) — cellEl er null MED VILJE.
      // Uten doc-flagget gjelder den gamle vakta uendret.
      if (!ctx.cellEl && ctx.doc !== true) return null;

      var raw;
      try {
        raw = JSON.parse(specJson);
      } catch (e) {
        console.warn('Ui.registerControl: ugyldig JSON-spec: ' + (e && e.message));
        return null;
      }
      var result = Ui.normalizeSpec(raw);
      for (var i = 0; i < result.warnings.length; i++) console.warn('Ui: ' + result.warnings[i]);
      var spec = result.spec;
      if (!spec) return null;

      var reg = _registerInto(ctx.doc === true ? null : ctx.cellIdx,
                              ctx.doc === true ? null : ctx.cellEl, spec);
      if (reg.__into) {
        return JSON.stringify({ __into: true, value: reg.value, key: reg.key, name: reg.name });
      }
      if (spec.has_handler) {
        return JSON.stringify({ value: reg.value, key: reg.key });
      }
      return JSON.stringify(reg.value);
    };

    /**
     * Ui.registerFromRegistry(cellIdx, specsJson) → void
     * Bulk-registrering for cellen med EKSPLISITT cellIdx (i stedet for
     * window.mdUiRunCtx()) — R-fasadens declare-og-injiser-modell (Task 2):
     * etter at en R-celle har kjørt, leser index.html hele dens ui_*-registry
     * (ett JSON-array av rå specs) og sender det hit i ETT kall, i stedet for
     * ett registerControl-kall per kontroll slik pyodide (pull-modell, synkron
     * ui.*-kall inni selve kjøringen) gjør.
     *
     * specsJson MÅ være et JSON-array. Hvert element normaliseres via
     * Ui.normalizeSpec — ugyldige/nullede specs varsles (console.warn) og
     * hoppes over, resten registreres. Kallet brakettes internt av
     * beginCellRun/endCellRun (samme par som index.html sine kjørebraketter
     * bruker for pyodide) slik at kontroller som IKKE lenger finnes i
     * registryet (kilden sluttet å kalle ui_* for dem) sopes bort ved
     * funksjonens slutt — helt symmetrisk med pyodide-veiens mark-og-sopp.
     */
    Ui.registerFromRegistry = function (cellIdx, specsJson) {
      var list;
      try {
        list = JSON.parse(specsJson);
      } catch (e) {
        console.warn('Ui.registerFromRegistry: ugyldig JSON: ' + (e && e.message));
        return;
      }
      if (!Array.isArray(list)) {
        console.warn('Ui.registerFromRegistry: forventet et JSON-array av specs');
        return;
      }
      var cellEl = null;
      if (cellIdx != null) {
        cellEl = (global.Cells && typeof global.Cells.cellElementAt === 'function')
          ? global.Cells.cellElementAt(cellIdx) : null;
        if (!cellEl) {
          console.warn('Ui.registerFromRegistry: fant ingen celle-node for cellIdx ' + cellIdx);
          return;
        }
      }

      Ui.beginCellRun(cellIdx);
      for (var i = 0; i < list.length; i++) {
        var result = Ui.normalizeSpec(list[i]);
        for (var w = 0; w < result.warnings.length; w++) console.warn('Ui: ' + result.warnings[w]);
        if (!result.spec) {
          console.warn('Ui.registerFromRegistry: spec #' + i + ' forkastet (ugyldig), hoppet over');
          continue;
        }
        _registerInto(cellIdx, cellEl, result.spec);
      }
      Ui.endCellRun(cellIdx);
    };

    /**
     * Ui.reattachDocStrips() — gjeninnsetter dokument-stripene (cellIdx=null)
     * i #outputArea dersom en helhets-rendring har koblet dem fra. Brython/
     * micropython sin runSelf og R sin plain-sti (Task PSW-5 exit-gate-funn,
     * rad 6/7/8) bygger stripa MENS skriptet kjører (_ensureStrip setter den
     * inn i #outputArea), men kaller SÅ renderOutput()/renderROutputParts()
     * som gjør en fullstendig `host.innerHTML = ''`-erstatning av
     * #outputArea AFTER stripa allerede er bygget — stripa forblir en
     * gyldig, fullt fungerende DOM-node (lyttere og verdier intakt i
     * _strips/_controls), men er ikke lenger et barn av #outputArea og blir
     * dermed usynlig for brukeren. pyodide sin plain-sti er upåvirket (den
     * bruker kun append, aldri innerHTML=''-erstatning, etter at stripa
     * finnes). Denne funksjonen retter OPP en allerede frakoblet stripe —
     * den bygger ingenting nytt, kun setter eksisterende noder tilbake på
     * riktig plass (byPos-nøkkelen for hver posisjon styrer hvor: 'top' →
     * settes inn som #outputArea sitt første barn, 'bottom' → appendes
     * sist). Stille no-op om #outputArea mangler eller ingen
     * dokument-striper (cellIdx=null) finnes ennå.
     *
     * Guard (4a-sluttreview Minor, lukket 4b §5): notatbok-aktiv → #outputArea
     * sitt eneste ekte barn skal være .doc-root (docRender, js/cells.js) —
     * en cellIdx=null-plain-script-stripe fra FØR notatboken ble aktivert
     * skal ALDRI reinnsettes som et søsken-element ved siden av .doc-root
     * (stale plain-script-stripe ville dukket opp over/under det konvergerte
     * dokumentet). Notatbok-aktive dokumenter har uansett ingen dokument-nivå
     * (cellIdx=null) striper av sin egen — kontroller der er alltid
     * celle-scopet (ParamForms.decorate/Ui _ensureStrip med en ekte cellIdx,
     * se docCellNode) — så guarden dropper aldri en LEGITIM reattach.
     */
    Ui.reattachDocStrips = function () {
      if (global.Cells && typeof global.Cells.active === 'function' && global.Cells.active()) return;
      var outputArea = document.getElementById ? document.getElementById('outputArea') : null;
      if (!outputArea) return;
      var byPos = _strips[null];
      if (!byPos) return;
      Object.keys(byPos).forEach(function (pos) {
        var strip = byPos[pos];
        if (!strip || strip.parentNode === outputArea) return;
        if (pos === 'bottom') outputArea.appendChild(strip);
        else outputArea.insertBefore(strip, outputArea.firstChild || null);
      });
    };

    /**
     * Ui.valuesForCell(cellIdx) → JSON-streng, {navn → verdi} for cellens
     * kontroller — nøklene er kontrollnavnet ALENE (uten celle-prefikset
     * controlKey ellers legger på), f.eks. {"n": 7, "w0": "a"}. Dette er
     * formatet R-fasaden (Task 2) injiserer som `.ui_values` før en R-celle
     * kjøres på nytt. Slår opp via den STABILE cellKey (samme utledning som
     * _registerInto bruker) — IKKE via ctrl.cellIdx — slik at et strukturelt
     * indeksskift på en id-tagget celle ikke mister verdiene idet neste
     * verdi-eksport gjøres (samme robusthet som selve verdilageret, W2-carryover d).
     * Button-kontroller har ingen lagret verdi (_values får aldri en
     * oppføring for dem, se _registerInto) og er derfor naturlig fraværende.
     */
    Ui.valuesForCell = function (cellIdx) {
      var prefix = _cellKeyAt(cellIdx) + '::';
      var out = {};
      Object.keys(_values).forEach(function (key) {
        if (key.indexOf(prefix) === 0) out[key.slice(prefix.length)] = _values[key];
      });
      return JSON.stringify(out);
    };

    // Delt oppslag (dash-absorpsjon 5a Task 2: factored ut av Ui.value):
    // finn _values-nøkkelen som SLUTTER på "::<name>", uansett hvilken
    // celle/dokument kontrollen ble registrert i (spec §3: "navnet
    // interpoleres i kodestrenger" — navn skal være unike, men er de IKKE,
    // vinner den SIST REGISTRERTE (siste innsatte nøkkel i _values, se
    // Object.keys-rekkefølgen under) + ETT console.warn). Returnerer
    // NØKKELEN (eller null) — Ui.value (under) slår selv opp verdien i
    // _values via nøkkelen; Ui.widgetLookup (Task 2) returnerer nøkkelen
    // DIREKTE til fasadens WidgetHandle. Kun kontroller MED en lagret verdi
    // (_values-oppføring) er søkbare her — knapper (ingen _values-
    // oppføring, se _registerInto) finnes derfor aldri, i BEGGE bruk.
    function _lookupKeyByName(name) {
      var suffix = '::' + name;
      var found = null;
      var hits = 0;
      Object.keys(_values).forEach(function (key) {
        if (key.length >= suffix.length && key.slice(-suffix.length) === suffix) {
          found = key;
          hits++;
        }
      });
      if (hits > 1) {
        console.warn('Ui: flere kontroller med navnet "' + name + '" — bruker sist registrerte');
      }
      return found;
    }

    /**
     * Ui.value(name) → gjeldende (rå JS-)verdi til kontrollen hvis nøkkel
     * SLUTTER på "::<name>" (se _lookupKeyByName for selve regelen).
     * Ukjent navn → null (JSON-vennlig, speiler registerControl sin
     * null-for-"ingen kjørekontekst"-konvensjon). Synkront rent oppslag i
     * dokument-verdilageret — kjører ingenting.
     */
    Ui.value = function (name) {
      var key = _lookupKeyByName(name);
      return key === null ? null : _values[key];
    };

    /**
     * Ui.widgetLookup(name) → controlKey|null (dash-absorpsjon 5a Task 2,
     * spec §1 "widgets-vs-elements"): SAMME suffix-match-regel som
     * Ui.value (siste registrerte vinner ved duplikate navn + ett
     * console.warn, delt via _lookupKeyByName over) — men returnerer selve
     * NØKKELEN i stedet for verdien, slik fasadens WidgetHandle (ui.widget
     * ("navn")) kan adressere kontrollen for Ui.widgetSet/widgetVisible/
     * widgetNode/widgetBind (under). Ukjent navn → null, STILLE her
     * (speiler Ui.value sin egen stillhet for "ingen treff" — fasaden gjør
     * sin EGEN advarsel over broen når den mottar null, se pyodide/ui.py
     * sin widget()).
     */
    Ui.widgetLookup = function (name) {
      return _lookupKeyByName(name);
    };

    /**
     * Ui.widgetSet(key, valueJson) → JSON av den FAKTISK skrevne (koersert/
     * klampede) verdien, eller JSON null ved ukjent/uskrivbar nøkkel
     * (console.warn — samme tolerante "aldri en kastet feil" som resten av
     * modulen). Skriver _values[key] + kontrollens DOM (Gjenbruker
     * _writeControlValue — SAMME per-type-klamp som en spec-drevet
     * _updateControlSpec-oppdatering ville brukt) + sync_to-push — men
     * fyrer ALDRI _fireControlHandler eller en rerun: et programmatisk
     * .set(v) er IKKE en brukerhandling (Hans, 2026-07-18 håndtak-
     * avgjørelsen) — en on_change-handler som selv kaller .set() skal
     * aldri kunne trigge seg selv i en løkke. Knapper (ingen lagret verdi
     * å skrive/klampe, se _writeControlValue) behandles som ukjente nøkler
     * her. Doc-gap (review): en kjørende play-timer overlever .set —
     * programmatisk verdi stopper ikke avspillingen.
     */
    Ui.widgetSet = function (key, valueJson) {
      var ctrl = _controls[key];
      if (!ctrl || ctrl.type === 'button') {
        console.warn('Ui.widgetSet: ukjent nøkkel ' + key);
        return JSON.stringify(null);
      }
      var v;
      try {
        v = JSON.parse(valueJson);
      } catch (e) {
        console.warn('Ui.widgetSet: ugyldig JSON-verdi: ' + ((e && e.message) || e));
        return JSON.stringify(null);
      }
      var written = _writeControlValue(ctrl, v);
      _values[key] = written;
      _syncPush(ctrl.spec, written);
      return JSON.stringify(written);
    };

    /**
     * Ui.widgetValue(key) → JSON-streng med kontrollens LAGREDE verdi,
     * eller null for ukjent nøkkel — nøkkel-varianten av Ui.value(navn)
     * (fase 4b: håndtak for NAVNLØSE into-kontroller trenger live .value).
     */
    Ui.widgetValue = function (key) {
      if (!_values.hasOwnProperty(key)) return null;
      try { return JSON.stringify(_values[key]); } catch (e) { return null; }
    };

    /**
     * Ui.widgetVisible(key, visible) — toggler kontrollens `.ui-widget`-
     * wrap sin display (dash-absorpsjon 5a Task 2: fasadens .hide()/
     * .show()). Ukjent nøkkel → console.warn, no-op.
     */
    Ui.widgetVisible = function (key, visible) {
      var ctrl = _controls[key];
      if (!ctrl) { console.warn('Ui.widgetVisible: ukjent nøkkel ' + key); return; }
      ctrl.wrap.style.display = visible ? '' : 'none';
    };

    /**
     * Ui.widgetNode(key, which) → den rå DOM-noden ('wrap' eller 'input'),
     * eller null (ukjent nøkkel/ukjent `which`). Fasadens .element/.input
     * -eskapeluke (dash-absorpsjon 5a Task 2) — SAMME "aldri sendt over
     * JSON-broen selv, kun JS-internt/håndtak-eskapeluke"-kontrakt som
     * Ui.elNode. For en knapp er wrap === input (se _buildButton) — begge
     * `which`-verdiene gir samme node der.
     */
    Ui.widgetNode = function (key, which) {
      var ctrl = _controls[key];
      if (!ctrl) return null;
      if (which === 'input') return ctrl.input || null;
      if (which === 'wrap') return ctrl.wrap || null;
      console.warn('Ui.widgetNode: ukjent which "' + which + '" (forventet "wrap" eller "input")');
      return null;
    };

    /**
     * Ui.hasImport(ns) → true/false (ui-html-fasen, Task 4, spec §4):
     * er navnerommet `ns` (f.eks. "sl"/"pico"/et generisk `as navn`-navn)
     * faktisk lastet? Leser `window.__uiImports` — satt av index.html sin
     * mdEnsureTagImports() KUN ved vellykket lasting av det tilhørende
     * '#tag.import'-oppslaget (aldri optimistisk FØR lastingen er ferdig).
     * Guardet mot at __uiImports ikke finnes ennå (ingen import kjørt i
     * dette dokumentet) — fasadenes `ui.sl`/`ui.pico`/`ui.<navn>`
     * modul-`__getattr__` kaller denne FØR de bygger navnerom-objektet,
     * og skal da få et rent `false`, ikke en TypeError.
     */
    Ui.hasImport = function (ns) {
      try {
        return !!(global.__uiImports && global.__uiImports[String(ns)]);
      } catch (e) {
        return false;
      }
    };

    /**
     * Ui.bindControlHandler(key, handler) — widget-callable-kanalen
     * (ui-html-fasen, Task 1): binder `handler` (en JS-funksjon — pyodide-
     * fasaden sender en create_proxy-innpakket python-callable, brython/mpy
     * en ren funksjon) til kontrollen med controlKey `key`, slik at
     * _wireChange/knappe-klikk fyrer DENNE i stedet for en rerun (se der).
     * En eksisterende handler på samme nøkkel destrueres (guardet) FØR
     * erstatning — samme mønster som _registerBinding (W5.2, under) bruker
     * ved re-deklarasjon av samme binding-nøkkel. `key` kommer fra
     * Ui.registerControl sin {value,key}-retur (kun for has_handler-specs).
     */
    Ui.bindControlHandler = function (key, handler) {
      if (!key) { console.warn('Ui.bindControlHandler: mangler nøkkel'); return; }
      if (typeof handler !== 'function') { console.warn('Ui.bindControlHandler: handler er ikke en funksjon'); return; }
      var old = _controlHandlers[key];
      if (old) _destroyHandler({ handler: old });
      _controlHandlers[key] = handler;
    };

    // ── W5.2: element-events (spec 2026-07-16-notebook-widget-events) ────
    // Delegerte dokument-lyttere + bindingsregister. En binding deklareres
    // under en cellekjøring (ui.on()/ui.run_cell() i fasadene, Task 3-4) og
    // lever til cellen re-kjøres uten å re-deklarere den (mark-og-sveip,
    // SAMME par — Ui.beginCellRun/endCellRun — som kontrollene over bruker),
    // eller til Ui.resetBindings() (sesjonsrestart/invalidate, index.html —
    // samme sted som IpwBridge.reset()). JS EIER handler-livssyklusen:
    // pyodide-proxier har .destroy() — kalles GUARDET overalt en binding
    // fjernes (sveip/erstatning/reset); brython/mpy-funksjoner har ingen
    // destroy og er da en no-op.
    var _bindings = {};      // "cellKey::selector::event" -> binding
    var _delegated = {};     // eventType -> true når dokument-lytteren er satt

    function _destroyHandler(b) {
      if (b && b.handler && typeof b.handler.destroy === 'function') {
        try { b.handler.destroy(); } catch (e) { /* allerede destruert e.l. — ufarlig */ }
      }
    }

    // Én delegert lytter PER eventType for HELE dokumentets levetid (aldri
    // fjernet — når _bindings er tom for en type er den bare en evig no-op,
    // billigere enn å legge til/fjerne én lytter per binding).
    function _installDelegate(eventType) {
      if (_delegated[eventType] || typeof document === 'undefined') return;
      _delegated[eventType] = true;
      document.addEventListener(eventType, function (e) {
        for (var key in _bindings) {
          if (!_bindings.hasOwnProperty(key)) continue;
          var b = _bindings[key];
          if (b.event !== eventType) continue;
          // ui-html-fasen (Task 1): el-scopede bindinger (Ui.elOn) har ingen
          // CSS-selector — de matcher via elementets EGEN data-ui-el-
          // markering (satt av _registerElBinding) i stedet for et
          // selector-treff mot en ANNEN, forhåndskjent node. Widget-scopede
          // bindinger (Ui.widgetBind, dash-absorpsjon 5a Task 2) er samme
          // idé, men matcher via kontrollens EGEN data-ui-key (satt
          // allerede ved registrering, se _registerInto) i stedet for en
          // egen data-ui-el-markering.
          var sel = b.elId ? '[data-ui-el="' + b.elId + '"]'
            : (b.wKey ? '[data-ui-key="' + b.wKey + '"]' : b.selector);
          var hit = (e.target && typeof e.target.closest === 'function') ? e.target.closest(sel) : null;
          if (hit) _dispatchBinding(b, e, hit);
        }
      });
    }

    function _dispatchBinding(b, e, hit) {
      if (b.kind === 'cell') {
        if (!global.Cells || typeof global.Cells.cellIndexById !== 'function') return;
        var idx = global.Cells.cellIndexById(b.cellId);
        if (idx === -1) { console.warn('Ui.run_cell: fant ikke celle-id ' + b.cellId); return; }
        global.Cells.runCell(idx);
        return;
      }
      // kind === 'fn': dropp events midt i en kjøring (v1 — ingen kø, samme
      // refuse-drop-filosofi som _rerunFor over bruker for kontroll-endringer).
      if (global.mdIsScriptRunning && global.mdIsScriptRunning()) {
        console.debug('Ui.on: event droppet (kjøring pågår)');
        return;
      }
      var evt = {
        type: e.type,
        value: (hit && hit.value !== undefined) ? hit.value : null,
        checked: (hit && hit.checked !== undefined) ? !!hit.checked : null,
        targetId: (hit && hit.id) ? hit.id : null
      };
      var payloadJson;
      try {
        payloadJson = b.handler(JSON.stringify(evt));
      } catch (err) {
        payloadJson = JSON.stringify({ kind: 'error', text: String((err && err.message) || err) });
      }
      Ui.renderEventResult(b, payloadJson);
    }

    // Finn/opprett cellens kjørebrakett — DELT _cellRuns-register med
    // kontrollene (Ui.beginCellRun/endCellRun under) — og sørg for at
    // bindingsRegistered-settet finnes: braketten kan i prinsippet være
    // opprettet av _registerInto (en kontroll registrert FØR noen binding i
    // samme kjøring) og hadde da manglet dette feltet.
    function _bindingsRunFor(cellIdx) {
      var run = _cellRuns[cellIdx];
      if (!run || run.closed) run = _cellRuns[cellIdx] = { ordinal: 0, registered: {}, bindingsRegistered: {}, showsRegistered: {} };
      if (!run.bindingsRegistered) run.bindingsRegistered = {};
      // ui-html-fasen (Task 1): showsRegistered er elShow(target=...) sin
      // tvilling for bindingsRegistered — samme lat-init-begrunnelse.
      if (!run.showsRegistered) run.showsRegistered = {};
      return run;
    }

    // Kjørekontekst-oppløsning for bindEvent/bindRunCell: samme
    // mdUiRunCtx()-mekanisme som Ui.registerControl (js/ui.js: se
    // dokumentasjonen der), MEN med et løsere krav — en binding er en
    // DELEGERT dokument-lytter, ikke en inline DOM-node i cellestripa, og
    // trenger ALDRI et levende cellEl for selve registreringen. Kun det å
    // MANGLE selve mekanismen (window.mdUiRunCtx ikke satt i det hele tatt)
    // regnes som "ingen kjørekontekst" og returnerer undefined (avvises av
    // kallerne under) — speiler registerControl sin ternary-fallback
    // nøyaktig. En ekte plain-script-kjøring (mekanismen finnes, men
    // returnerer null — ingen aktiv cellekjøring akkurat nå) ELLER ctx sitt
    // kant-case uten cellEl (samme kant-case som registerControl sin egen
    // test) gir BEGGE cellIdx=null her: rendering faller da tilbake til
    // #outputArea (se _slotFor) i stedet for en cellespesifikk slot.
    function _resolveCellIdx() {
      if (typeof global.mdUiRunCtx !== 'function') return undefined; // ingen mekanisme i det hele tatt
      var ctx = global.mdUiRunCtx();
      return (ctx && ctx.cellIdx != null) ? ctx.cellIdx : null;
    }

    // Delt registreringskjerne for Ui.bindEvent/Ui.bindRunCell.
    function _registerBinding(raw, kind, handler) {
      var cellIdx = _resolveCellIdx();
      if (cellIdx === undefined) return null; // ingen kjørekontekst-mekanisme i det hele tatt

      var cellKey = cellIdx != null ? _cellKeyAt(cellIdx) : 'doc';
      var key = cellKey + '::' + raw.selector + '::' + raw.event;

      if (cellIdx != null) {
        var run = _bindingsRunFor(cellIdx);
        run.bindingsRegistered[key] = true;
      }

      var old = _bindings[key];
      if (old) _destroyHandler(old); // erstatning — samme guardede destroy som sveip/reset
      var binding = {
        key: key, cellIdx: cellIdx, kind: kind,
        selector: raw.selector, event: raw.event,
        target: raw.target || null
      };
      if (kind === 'fn') binding.handler = handler;
      else binding.cellId = raw.cellId;
      _bindings[key] = binding;
      _installDelegate(raw.event);
      return true;
    }

    /**
     * Ui.bindEvent(bindingJson, handler) → true (registrert) eller null
     * (ugyldig binding, eller ingen kjørekontekst-mekanisme i det hele
     * tatt). bindingJson = {"selector","event","target"?}. handler kalles
     * med ÉN JSON-streng (event-payload: {type,value,checked,targetId}) og
     * MÅ returnere en JSON-streng payload ('{}' for no-op) — se
     * Ui.renderEventResult for payload-formatet.
     */
    Ui.bindEvent = function (bindingJson, handler) {
      var raw;
      try {
        raw = JSON.parse(bindingJson);
      } catch (e) {
        console.warn('Ui.bindEvent: ugyldig JSON: ' + (e && e.message));
        return null;
      }
      if (!raw || !raw.selector || !raw.event) {
        console.warn('Ui.bindEvent: binding krever selector og event');
        return null;
      }
      if (typeof handler !== 'function') {
        console.warn('Ui.bindEvent: handler er ikke en funksjon');
        return null;
      }
      return _registerBinding(raw, 'fn', handler);
    };

    /**
     * Ui.bindRunCell(bindingJson) → true/null, samme kontekst-oppløsning
     * som bindEvent, men uten handler: bindingJson =
     * {"selector","event","cellId","target"?} — et treff dispatcher
     * direkte til Cells.runCell(Cells.cellIndexById(cellId)), ingen
     * payload/rendering involvert.
     */
    Ui.bindRunCell = function (bindingJson) {
      var raw;
      try {
        raw = JSON.parse(bindingJson);
      } catch (e) {
        console.warn('Ui.bindRunCell: ugyldig JSON: ' + (e && e.message));
        return null;
      }
      if (!raw || !raw.selector || !raw.event || !raw.cellId) {
        console.warn('Ui.bindRunCell: binding krever selector, event og cellId');
        return null;
      }
      return _registerBinding(raw, 'cell', null);
    };

    // Finn cellens .nb-output-body (Cells.cellElementAt → .nb-output →
    // .nb-output-body, samme oppslag som resten av modulen), eller
    // #outputArea når bindingen ikke er celle-scoped (cellIdx null,
    // plain-script) eller cellen ikke lenger finnes.
    function _slotFor(b) {
      if (b.cellIdx != null) {
        var cellEl = (global.Cells && typeof global.Cells.cellElementAt === 'function')
          ? global.Cells.cellElementAt(b.cellIdx) : null;
        if (cellEl) {
          var outEl = _findChild(cellEl, 'nb-output');
          var body = outEl ? _findChild(outEl, 'nb-output-body') : null;
          if (body) return body;
        }
      }
      return (typeof document !== 'undefined' && document.getElementById)
        ? document.getElementById('outputArea') : null;
    }

    // ── payload-vokabular: figur/tema (flyttet fra js/dash.js:183-240+297-
    // 314, dash-absorpsjon 5a Task 1; dash.js selv fjernet i 5b). Figuren er
    // NATIV her — _figures er registeret for ALLE ui.renderPayload-rendrede
    // figurer — én temabytte-observer relayouter ALLE tilkoblede figurer,
    // uansett hvilken kilde som ba om rendring.
    var _md = null;
    var _figures = [];
    var _themeObserverInstalled = false;

    function themeColor(name, fallback) {
      try {
        var c = getComputedStyle(document.body).getPropertyValue(name).trim();
        return c || fallback;
      } catch (e) { return fallback; }
    }

    function installThemeObserver() {
      if (_themeObserverInstalled) return;
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
      _themeObserverInstalled = true;
      var mo = new MutationObserver(function () {
        if (!global.Plotly) return;
        var color = themeColor('--text', '#333');
        // Luk ut frakoblede figurer i samme slag — enklere enn å holde et
        // separat sveipe-kall, og observeren fyrer sjelden (kun ved faktisk
        // temabytte).
        _figures = _figures.filter(function (f) { return f && f.isConnected; });
        _figures.forEach(function (f) {
          try { global.Plotly.relayout(f, { 'font.color': color }); } catch (e) {}
        });
      });
      mo.observe(document.body, { attributes: true, attributeFilter: ['data-theme'] });
    }

    function mdToHtml(text) {
      if (!_md && global.markdownit) _md = global.markdownit({ linkify: true });
      return _md ? _md.render(String(text)) : null;
    }

    /**
     * Ui.renderPayload(p, hostEl) → den opprettede rot-noden (eller null for
     * '{}'-lignende ukjente/tomme kinds — se under), ALLEREDE lagt inn i
     * hostEl. Delt rendrings-vokabular (dash-absorpsjon 5a Task 1 — flyttet
     * hit fra js/dash.js sin D.renderPayload, MED de nye kindene kpi/
     * markdown/image lagt til): text/error (pre-boks), table (html ELLER
     * strukturert {columns,rows} — SAMME tillitsnivå som før: strukturert
     * variant bygges kun med textContent, aldri innerHTML), figure (Plotly,
     * temadefaults, isConnected-vakt), kpi (dash sin 'number'-payload —
     * value/unit/fmt/ref/bra formatert her, PLUSS delta= (direkte, for
     * ui.kpi Task 3) og label), markdown (mdToHtml), image ({src|dataUri,
     * alt?}). Ukjent kind → console.warn, ingenting tegnes (samme stille
     * ikke-rendrende oppførsel som Ui.renderEventResult alltid har hatt for
     * ukjente kinds — generalisert hit).
     */
    Ui.renderPayload = function (p, hostEl) {
      var kind = p && p.kind;
      var node = null;

      if (kind === 'text' || kind === 'error') {
        node = _el(kind === 'error' ? 'div' : 'pre', kind === 'error' ? 'ui-error' : 'ui-text');
        if (kind === 'error') {
          node.appendChild(_el('strong', null, 'Feil: '));
          // dash sender p.message, Ui.on-handlere sender p.text — begge
          // aksepteres (samme tolerante prinsipp som resten av modulen).
          node.appendChild(_el('span', null, (p.text != null ? p.text : p.message) || ''));
        } else {
          node.textContent = p.text || '';
        }
      } else if (kind === 'table') {
        node = _el('div', 'ui-table-wrap');
        if (p.html != null) {
          node.innerHTML = p.html; // vår egen to_html-bygger, samme tillitsnivå som før
        } else {
          // strukturert variant (spec 2026-07-12 §3.2, flyttet fra dash.js)
          // — bygget med textContent, aldri innerHTML: celleinnhold kan ikke
          // smugle markup.
          var tbl = _el('table');
          var trh = _el('tr');
          (p.columns || []).forEach(function (c) { trh.appendChild(_el('th', null, String(c))); });
          var thead = _el('thead');
          thead.appendChild(trh);
          tbl.appendChild(thead);
          var tbody = _el('tbody');
          (p.rows || []).forEach(function (row) {
            var tr = _el('tr');
            (row || []).forEach(function (cell) {
              tr.appendChild(_el('td', null, cell == null ? '' : String(cell)));
            });
            tbody.appendChild(tr);
          });
          tbl.appendChild(tbody);
          node.appendChild(tbl);
        }
      } else if (kind === 'figure') {
        node = _el('div', 'ui-figure');
        var spec = p.spec || {};
        var layout = Object.assign({
          autosize: true,
          margin: { t: 28, r: 12, b: 36, l: 44 },
          paper_bgcolor: 'rgba(0,0,0,0)',
          plot_bgcolor: 'rgba(0,0,0,0)',
          font: { color: themeColor('--text', '#333') }
        }, spec.layout || {});
        // 5a review Minor (dash-absorpsjon 5b-oppfølging): luk ut frakoblede
        // oppføringer VED PUSH også, ikke bare inni temabytte-observerens
        // callback (installThemeObserver over) — uten dette vokser _figures
        // ubegrenset for et dokument som aldri bytter tema i samme økt (hver
        // celle-rerun med et nytt figure-payload la til enda en oppføring,
        // de gamle frakoblede ble aldri luket ut før et faktisk temabytte).
        _figures = _figures.filter(function (f) { return f && f.isConnected; });
        _figures.push(node);
        installThemeObserver();
        setTimeout(function () {
          if (global.Plotly && node.isConnected) {
            global.Plotly.newPlot(node, spec.data || [], layout,
              { responsive: true, displayModeBar: false });
          }
        }, 0);
      } else if (kind === 'kpi') {
        node = _el('div', 'ui-kpi');
        if (p.label) node.appendChild(_el('div', 'ui-kpi-label', p.label));
        node.appendChild(_el('span', 'ui-kpi-value', Ui.formatNumber(p.value, p.fmt)));
        if (p.unit) node.appendChild(_el('span', 'ui-kpi-unit', p.unit));
        // delta=: direkte tall (ui.kpi Task 3) har forrang; ellers beregnes
        // den som før fra ref+bra (dash sin 'number'-payload).
        var delta = null;
        if (typeof p.delta === 'number' && isFinite(p.delta)) delta = deltaFromDiff(p.delta, p.fmt, p.bra);
        else if (p.ref != null) delta = Ui.computeDelta(p.value, p.ref, p.fmt, p.bra);
        if (delta) {
          var arrow = delta.dir === 'opp' ? '▲' : (delta.dir === 'ned' ? '▼' : '–');
          // Klassene koder GODHET (delta.good = retning×bra), ikke aritmetisk retning — pilen (▲/▼) viser retningen.
          var dcls = 'ui-kpi-delta ' + (delta.good ? 'ui-kpi-delta--good' : 'ui-kpi-delta--bad');
          node.appendChild(_el('span', dcls, arrow + ' ' + delta.text));
        }
      } else if (kind === 'markdown') {
        var html = mdToHtml(p.text);
        if (html != null) {
          node = _el('div', 'ui-md');
          node.innerHTML = html;
        } else {
          node = _el('pre', 'ui-text', p.text);
        }
      } else if (kind === 'image') {
        node = _el('img', 'ui-img');
        node.src = p.src != null ? p.src : p.dataUri;
        if (p.alt) node.alt = p.alt;
      } else {
        console.warn('Ui.renderPayload: ukjent payload-kind: ' + kind);
        return null;
      }

      if (hostEl) hostEl.appendChild(node);
      return node;
    };

    /**
     * Ui.renderEventResult(b, payloadJson) — tegner en handler sitt
     * payload-resultat. b er den interne binding-oppføringen (trenger kun
     * .target og .cellIdx). payload = Ui.renderPayload sitt vokabular
     * (text/error/table/figure/kpi/markdown/image), eller '{}' (eksplisitt
     * no-op — ingenting tegnes).
     */
    Ui.renderEventResult = function (b, payloadJson) {
      var p;
      try {
        p = JSON.parse(payloadJson || '{}');
      } catch (e) {
        p = { kind: 'error', text: 'Ui.on: ugyldig payload fra handler' };
      }
      if (!p || !p.kind) return; // '{}' — eksplisitt no-op, ingenting å tegne

      var node = null, replace = false, missingTarget = null;
      if (b.target) {
        node = (typeof document !== 'undefined' && document.getElementById) ? document.getElementById(b.target) : null;
        if (node) replace = true;
        else missingTarget = b.target;
      }
      if (!node) node = _slotFor(b);
      if (!node) return;
      if (replace) node.innerHTML = '';
      if (missingTarget) {
        var notice = document.createElement('pre');
        notice.className = 'error';
        notice.textContent = 'Ui.on: fant ikke target-element #' + missingTarget + ' — viser her i stedet';
        node.appendChild(notice);
      }

      Ui.renderPayload(p, node);
    };

    // ── Task 1 (fase ui-html, spec 2026-07-17-ui-html-design.md §1-3):
    // element-motoren. `ui.html.*`-byggerne (Task 2-3-fasadene) er en tynn
    // python-innpakning rundt EN elId (streng) — selve DOM-noden EIES og
    // leves her, JSON over broen begge veier (samme window.Ui.*-mønster som
    // registerControl/bindEvent). _els er id-registeret; elOn gjenbruker
    // W5.2 sin _bindings/_installDelegate/_dispatchBinding-maskin (over)
    // fremfor å bygge en egen — samme mark-og-sopp, samme guardede destroy.
    var _els = {};            // elId → { node, cellIdx, gen } (se _elGens under)
    var _elCounter = 1;       // neste elId er 'el' + _elCounter
    var _elShowTargets = {};  // "cellKey::target" -> { elId, cellIdx, target }

    // ui-html-fasen (Task 1, revidert etter reviewer-anmerkning på commit
    // daa9ee3): per-cellIdx generasjonsteller for _els-sveipen under. Hvorfor
    // dette finnes i det hele tatt — den OPPRINNELIGE sveipen var et blankt
    // isConnected-feie over HELE _els ved ENHVER endCellRun, uansett hvilken
    // celle som bygget oppføringen. Det drepte kryss-celle-idiomet spec-en
    // selv legger opp til: celle 1 bygger `x = ui.html.div(...)` (elCreate,
    // ALDRI vist DER — meningen er at en SENERE celle skal vise den), celle
    // 2 kaller `x.show()`. Under den gamle sveipen ble _els[x] allerede
    // fjernet av celle 1 sin EGEN endCellRun (før celle 2 i det hele tatt
    // fikk kjøre) — elShow ble da en stille no-op mot et elId som "aldri
    // fantes". Generasjonstelleren gjør sveipen presis: en oppføring bygget
    // I DENNE kjøringen overlever ALLTID sin egen kjørings avslutning (den
    // kan jo bli hentet av en senere celle); den sveipes først når dens
    // SKAPENDE celle kjører PÅ NYTT uten å ha koblet den til noe sted i
    // mellomtiden — se Ui.beginCellRun/endCellRun under for selve bruken.
    var _elGens = {}; // cellIdx → nåværende generasjon (monotont voksende, økt i Ui.beginCellRun)

    function _currentElGen(cellIdx) {
      return _elGens[cellIdx] || 0;
    }

    // Delt props-application for Ui.elCreate/Ui.elSetProps: DOM-egenskap når
    // `navn in node`, ellers setAttribute (se _setAttrValue for dict/list/
    // boolsk-håndteringen der). Hver enkelt navn er sin EGEN try/catch —
    // én ugyldig verdi skal aldri hindre resten av props-settet fra å
    // appliseres (spec: "console.warn on failure, never throw").
    function _applyOneElProp(node, name, value) {
      try {
        if (name in node) {
          node[name] = value;
        } else {
          _setAttrValue(node, name, value);
        }
      } catch (e) {
        console.warn('Ui.el: klarte ikke å sette egenskapen "' + name + '": ' + ((e && e.message) || e));
      }
    }

    // setAttribute-grenen sin verdi-normalisering: boolsk → tom-attributt
    // til stede (true) / fjernet (false) — IKKE "true"/"false"-strenger
    // (en setAttribute(name,'false') hadde vært til stede og dermed
    // "sann" for enhver CSS-/JS-sjekk på attributt-eksistens, feil for et
    // web-komponent-boolsk flagg). dict/list → JSON-kodet streng (web-
    // komponent-konvensjonen spec-en selv nevner). Alt annet → String().
    function _setAttrValue(node, name, value) {
      try {
        if (typeof value === 'boolean') {
          if (value) node.setAttribute(name, '');
          else node.removeAttribute(name);
        } else if (value !== null && typeof value === 'object') {
          node.setAttribute(name, JSON.stringify(value));
        } else {
          node.setAttribute(name, String(value));
        }
      } catch (e) {
        console.warn('Ui.el: klarte ikke å sette attributtet "' + name + '": ' + ((e && e.message) || e));
      }
    }

    // style: streng → cssText (rått, som HTML-attributtet); objekt → én
    // node.style[navn]=verdi-tildeling per nøkkel (nøklene er ALLEREDE
    // camelCase — python-siden normaliserer snake_case→camelCase FØR broen,
    // se spec §1 "unified kwargs standard").
    function _applyElStyle(node, style) {
      if (!node.style) return; // stub/node uten style-objekt — stille no-op
      try {
        if (typeof style === 'string') {
          node.style.cssText = style;
        } else if (style && typeof style === 'object') {
          Object.keys(style).forEach(function (k) {
            try { node.style[k] = style[k]; }
            catch (e) { console.warn('Ui.el: klarte ikke å sette style."' + k + '": ' + ((e && e.message) || e)); }
          });
        }
      } catch (e) {
        console.warn('Ui.el: feil ved stilsetting: ' + ((e && e.message) || e));
      }
    }

    // opts = {"props": {...}, "style": {...}|"...", "attrs": {...}, "events": [...]}
    // "events" er reservert for python-fasaden (kwarg-samling av
    // on_click=/on_change=-callables) — selve BINDINGEN skjer alltid via et
    // eget Ui.elOn-kall (handlere kan ikke JSON-serialiseres over broen),
    // så nøkkelen er en stille no-op her.
    function _applyElProps(node, opts) {
      if (!opts || typeof opts !== 'object') return;
      if (opts.props && typeof opts.props === 'object') {
        Object.keys(opts.props).forEach(function (name) { _applyOneElProp(node, name, opts.props[name]); });
      }
      if (opts.attrs && typeof opts.attrs === 'object') {
        Object.keys(opts.attrs).forEach(function (name) { _setAttrValue(node, name, opts.attrs[name]); });
      }
      if (opts.style !== undefined) _applyElStyle(node, opts.style);
    }

    /**
     * Ui.makeNode(tag, opts) → rå DOM-node eller null — den DELTE
     * konstruksjonskjernen (fase 2, spec 2026-07-20): samme props/attrs/
     * style-applisering som elCreate (_applyElProps), men tar et EKTE
     * objekt (aldri JSON), registrerer INGENTING i _els (ingen livssyklus,
     * ingen kjørekontekst) og er ment for JS-interne kallere — kontroll-
     * byggerne her og i js/param-forms.js. elCreate er nå sugar over den.
     */
    Ui.makeNode = function (tag, opts) {
      var node;
      try {
        node = document.createElement(tag);
      } catch (e) {
        console.warn('Ui.makeNode: klarte ikke å opprette <' + tag + '>: ' + ((e && e.message) || e));
        return null;
      }
      if (opts) _applyElProps(node, opts);
      return node;
    };

    /**
     * Ui.elCreate(tag, propsJson) → elId (streng, "el<n>") eller null ved
     * ugyldig tag/JSON. Oppretter en EKTE DOM-node (document.createElement)
     * og registrerer den under en fersk, monotont voksende id — python-
     * wrapperen (Task 2-3) holder KUN denne strengen, aldri noden selv.
     */
    Ui.elCreate = function (tag, propsJson) {
      var opts = null;
      if (propsJson) {
        try { opts = JSON.parse(propsJson); }
        catch (e) { console.warn('Ui.elCreate: ugyldig JSON-props: ' + ((e && e.message) || e)); }
      }
      var node = Ui.makeNode(tag, opts);
      if (!node) return null;
      var id = 'el' + (_elCounter++);
      // Task 1 (revidert): cellIdx løses via SAMME mekanisme som
      // _registerInto sine kallere bruker (_resolveCellIdx — elOn/elShow sin
      // egen kjørekontekst-oppløsning) — null både når det ikke finnes noen
      // kjørekontekst-mekanisme i det hele tatt (undefined normalisert til
      // null) OG i doc-/ingen-kjøring-tilfellet (samme sentinel som resten
      // av fila). gen er nåværende generasjon for DEN cellIdx-en — se
      // Ui.beginCellRun.
      var cellIdx = _resolveCellIdx();
      if (cellIdx === undefined) cellIdx = null;
      _els[id] = { node: node, cellIdx: cellIdx, gen: _currentElGen(cellIdx) };
      return id;
    };

    /**
     * Ui.elSetProps(elId, propsJson) — samme props-applisering som
     * elCreate, på en EKSISTERENDE node. Ukjent elId/ugyldig JSON → warn,
     * no-op.
     */
    Ui.elSetProps = function (elId, propsJson) {
      var entry = _els[elId];
      var node = entry ? entry.node : null;
      if (!node) { console.warn('Ui.elSetProps: ukjent elId ' + elId); return; }
      var opts;
      try {
        opts = JSON.parse(propsJson);
      } catch (e) {
        console.warn('Ui.elSetProps: ugyldig JSON-props: ' + ((e && e.message) || e));
        return;
      }
      _applyElProps(node, opts);
    };

    /**
     * Ui.elAppend(parentId, childJson) — childJson er ENTEN {"el": elId}
     * (en annen, allerede opprettet el-node) ELLER {"text": "…"} (en
     * ekte tekst-node via document.createTextNode). Ukjent parentId/el-id
     * eller manglende felt → warn, no-op.
     */
    Ui.elAppend = function (parentId, childJson) {
      var parentEntry = _els[parentId];
      var parent = parentEntry ? parentEntry.node : null;
      if (!parent) { console.warn('Ui.elAppend: ukjent parentId ' + parentId); return; }
      var child;
      try {
        child = JSON.parse(childJson);
      } catch (e) {
        console.warn('Ui.elAppend: ugyldig JSON-child: ' + ((e && e.message) || e));
        return;
      }
      if (!child || typeof child !== 'object') { console.warn('Ui.elAppend: ugyldig childJson'); return; }
      try {
        if (child.el !== undefined) {
          var childEntry = _els[child.el];
          var childNode = childEntry ? childEntry.node : null;
          if (!childNode) { console.warn('Ui.elAppend: ukjent el-id ' + child.el); return; }
          parent.appendChild(childNode);
        } else if (child.text !== undefined) {
          var textNode = document.createTextNode(String(child.text));
          parent.appendChild(textNode);
        } else {
          console.warn('Ui.elAppend: childJson mangler "el" eller "text"');
        }
      } catch (e) {
        console.warn('Ui.elAppend: klarte ikke å legge til barn: ' + ((e && e.message) || e));
      }
    };

    /**
     * Ui.elClear(elId) — fjerner ALLE barn av noden (tømmer den, rører
     * ikke selve noden eller dens plass i EGEN forelder).
     */
    Ui.elClear = function (elId) {
      var entry = _els[elId];
      var node = entry ? entry.node : null;
      if (!node) { console.warn('Ui.elClear: ukjent elId ' + elId); return; }
      try {
        while (node.firstChild) node.removeChild(node.firstChild);
      } catch (e) {
        console.warn('Ui.elClear: klarte ikke å tømme elementet: ' + ((e && e.message) || e));
      }
    };

    /**
     * Ui.elPayload(elId, payloadJson) → den rendrede rot-noden (eller null),
     * dash-absorpsjon 5a Task 3: rendrer et Ui.renderPayload-payload (kpi/
     * markdown/image/… — samme vokabular som Ui.renderEventResult bruker)
     * INN i en EKSISTERENDE, JS-eid node — clear-then-render (Ui.elClear
     * FØRST, deretter Ui.renderPayload inn i den nå tomme noden). Dette er
     * fasadenes ui.kpi()/ui.markdown()/ui.image() sin eneste JS-avhengighet
     * utover Ui.elCreate: `elCreate('div', {}) → elPayload(elId, payload) →
     * Element(elId)` — ÉN rendrings-implementasjon (Ui.renderPayload) delt
     * mellom event-resultater og disse byggerne. Ukjent elId/ugyldig JSON
     * → warn, null (samme defensive konvensjon som elSetProps/elClear).
     */
    Ui.elPayload = function (elId, payloadJson) {
      var entry = _els[elId];
      var node = entry ? entry.node : null;
      if (!node) { console.warn('Ui.elPayload: ukjent elId ' + elId); return null; }
      var p;
      try {
        p = JSON.parse(payloadJson);
      } catch (e) {
        console.warn('Ui.elPayload: ugyldig JSON-payload: ' + ((e && e.message) || e));
        return null;
      }
      while (node.firstChild) node.removeChild(node.firstChild);
      return Ui.renderPayload(p, node);
    };

    /**
     * Ui.elNode(elId) → den rå DOM-noden, eller null. Fasadenes `.el`-
     * eskapeluke (spec §1) — ALDRI sendt over JSON-broen selv, kun brukt
     * JS-internt (f.eks. andre js/*.js-moduler som trenger direkte
     * DOM-tilgang til et ui.html-bygget element).
     */
    Ui.elNode = function (elId) {
      var entry = _els[elId];
      return entry ? entry.node : null;
    };

    // Delt registreringskjerne for Ui.elOn — el-scopet variant av
    // _registerBinding (over): nøkkelen er 'el::<elId>::<event>' (INGEN
    // cellKey-prefiks — elId er allerede globalt unik i _els), og treffet
    // matches ikke via en CSS-selector mot en FORHÅNDSKJENT node, men via
    // elementets EGEN data-ui-el-markering (satt her, idempotent) — se
    // _installDelegate sin sel = b.elId ? '[data-ui-el="..."]' : b.selector
    // -gren (over). Ellers BYTE-FOR-BYTE samme livssyklus som
    // _registerBinding: samme kjørekontekst-oppløsning, samme
    // erstatning-destruerer-forrige-handler, samme bindingsRegistered-
    // sporing (mark-og-sopp i Ui.endCellRun, uendret — den løkka er
    // generisk over _bindings og bryr seg ikke om selector- eller
    // elId-formen på nøkkelen).
    function _registerElBinding(elId, event, handler) {
      var cellIdx = _resolveCellIdx();
      if (cellIdx === undefined) return null; // ingen kjørekontekst-mekanisme i det hele tatt

      var elEntry = _els[elId];
      var node = elEntry ? elEntry.node : null;
      if (!node) { console.warn('Ui.elOn: ukjent elId ' + elId); return null; }

      var key = 'el::' + elId + '::' + event;

      if (cellIdx != null) {
        var run = _bindingsRunFor(cellIdx);
        run.bindingsRegistered[key] = true;
      }

      var old = _bindings[key];
      if (old) _destroyHandler(old); // erstatning — samme guardede destroy som sveip/reset

      try { node.setAttribute('data-ui-el', elId); }
      catch (e) { console.warn('Ui.elOn: klarte ikke å merke elementet: ' + ((e && e.message) || e)); }

      var binding = { key: key, cellIdx: cellIdx, kind: 'fn', elId: elId, event: event, target: null, handler: handler };
      _bindings[key] = binding;
      _installDelegate(event);
      return true;
    }

    /**
     * Ui.elOn(elId, event, handler) → true/null. Element-scopet variant av
     * Ui.bindEvent (over) — handler kalles med samme JSON event-payload
     * ({type,value,checked,targetId}) og MÅ returnere en JSON-payload-
     * streng, tegnet via Ui.renderEventResult (binding.target er alltid
     * null her → slot-fallback, se _slotFor).
     */
    Ui.elOn = function (elId, event, handler) {
      if (!elId || !event) { console.warn('Ui.elOn: elId og event er påkrevd'); return null; }
      if (typeof handler !== 'function') { console.warn('Ui.elOn: handler er ikke en funksjon'); return null; }
      return _registerElBinding(elId, event, handler);
    };

    // Delt registreringskjerne for Ui.widgetBind (dash-absorpsjon 5a Task
    // 2) — kontroll-scopet tvilling av _registerElBinding (over): nøkkelen
    // er 'wk::<controlKey>::<event>' (INGEN cellKey-prefiks — controlKey er
    // allerede globalt unik i _controls), og treffet matches via
    // kontrollens EGEN data-ui-key-markering (satt allerede ved
    // registrering, se _registerInto — IKKE satt her, i motsetning til
    // _registerElBinding sin data-ui-el, siden den allerede finnes). Ellers
    // BYTE-FOR-BYTE samme livssyklus: samme kjørekontekst-oppløsning
    // (_resolveCellIdx — DEN KJØRENDE cellen som KALLER widgetBind EIER
    // bindingen, ikke nødvendigvis kontrollens egen deklarerende celle),
    // samme erstatning-destruerer-forrige-handler, samme
    // bindingsRegistered-sporing (mark-og-sopp i Ui.endCellRun er generisk
    // over _bindings og bryr seg ikke om nøkkel-formen).
    function _registerWidgetBinding(key, event, handler) {
      var cellIdx = _resolveCellIdx();
      if (cellIdx === undefined) return null; // ingen kjørekontekst-mekanisme i det hele tatt

      if (!_controls[key]) { console.warn('Ui.widgetBind: ukjent nøkkel ' + key); return null; }

      var bindKey = 'wk::' + key + '::' + event;

      if (cellIdx != null) {
        var run = _bindingsRunFor(cellIdx);
        run.bindingsRegistered[bindKey] = true;
      }

      var old = _bindings[bindKey];
      if (old) _destroyHandler(old); // erstatning — samme guardede destroy som sveip/reset

      var binding = { key: bindKey, cellIdx: cellIdx, kind: 'fn', wKey: key, event: event, target: null, handler: handler };
      _bindings[bindKey] = binding;
      _installDelegate(event);
      return true;
    }

    /**
     * Ui.widgetBind(key, event, handler) → true/null. Kontroll-scopet
     * variant av Ui.bindEvent/Ui.elOn (dash-absorpsjon 5a Task 2) —
     * fasadens WidgetHandle.on(event, fn): en EKSTRA lytter på kontrollens
     * input-node, VED SIDEN AV en ev. on_change=/on_click= gitt ved selve
     * deklarasjonen (egen kanal/nøkkel — forstyrrer ikke
     * _controlHandlers/has_handler-kanalen _fireControlHandler bruker).
     * handler kalles med samme JSON event-payload ({type,value,checked,
     * targetId}) og MÅ returnere en JSON-payload-streng, tegnet via
     * Ui.renderEventResult (binding.target er alltid null her → slot-
     * fallback, se _slotFor).
     */
    Ui.widgetBind = function (key, event, handler) {
      if (!key || !event) { console.warn('Ui.widgetBind: nøkkel og event er påkrevd'); return null; }
      if (typeof handler !== 'function') { console.warn('Ui.widgetBind: handler er ikke en funksjon'); return null; }
      return _registerWidgetBinding(key, event, handler);
    };

    // Finn den KJØRENDE kontekstens monteringssted for elShow(target=null):
    // mdUiRunCtx() sin cellEl → .nb-output-body (samme oppslag som
    // _slotFor over, men UAVHENGIG av en binding-struktur — elShow kalles
    // direkte fra fasaden, ikke via en handler-dispatch); doc-ctx → hele
    // #outputArea (fase 3-presedens); ingen ctx i det hele tatt → null
    // (kalleren varsler).
    function _runningSlot() {
      var ctx = (typeof global.mdUiRunCtx === 'function') ? global.mdUiRunCtx() : null;
      if (!ctx) return null;
      if (ctx.doc === true) {
        return (typeof document !== 'undefined' && document.getElementById) ? document.getElementById('outputArea') : null;
      }
      if (ctx.cellEl) {
        var outEl = _findChild(ctx.cellEl, 'nb-output');
        var body = outEl ? _findChild(outEl, 'nb-output-body') : null;
        return body || null;
      }
      return null;
    }

    /**
     * Ui.elShow(elId, optsJson) — optsJson = {"target": "dom-id"|null}.
     *
     * target null: append noden til DEN KJØRENDE cellens/dokumentets slot
     * (se _runningSlot) — flere .show()-kall i samme celle monterer flere
     * ganger, som spec-en krever (ingen dedup).
     *
     * target satt: erstatt innholdet i #target-noden med DENNE noden,
     * sporet PER (cellKey,target) i _elShowTargets slik at en re-kjøring av
     * DEN DEKLARERENDE cellen erstatter forrige visning i stedet for å
     * stable duplikater — samme livssyklus-mønster (mark-og-sopp i
     * Ui.endCellRun, glem-alt i Ui.resetDocument) som resten av
     * kjørebrakett-registrene i denne fila.
     *
     * target satt men #target IKKE funnet i dokumentet (revidert etter
     * reviewer-anmerkning på commit daa9ee3): dette er IKKE lenger en stille
     * console.warn+no-op. Samme W5-fallback som Ui.renderEventResult sin
     * missingTarget-gren (se der, ~linje 1330+) — noden vises likevel, i den
     * KJØRENDE kontekstens slot (_runningSlot), sammen med en synlig
     * varsel-boks (samme <pre class="error">-stil). showKey-registeret
     * (_elShowTargets/showsRegistered — FREMTIDIG mark-og-sopp-grunnlag i
     * Ui.endCellRun) får INGEN oppføring i dette tilfellet: en fantom-
     * oppføring for et mål som faktisk aldri ble truffet ville latt en
     * SENERE, ekte visning til samme mål bli feilaktig sopt av en rerun som
     * selv aldri klarte å treffe #target.
     */
    Ui.elShow = function (elId, optsJson) {
      var elEntry = _els[elId];
      var node = elEntry ? elEntry.node : null;
      if (!node) { console.warn('Ui.elShow: ukjent elId ' + elId); return; }
      var opts = {};
      if (optsJson) {
        try { opts = JSON.parse(optsJson) || {}; }
        catch (e) { console.warn('Ui.elShow: ugyldig JSON-opts: ' + ((e && e.message) || e)); }
      }
      var target = opts.target || null;

      if (!target) {
        var slot = _runningSlot();
        if (!slot) { console.warn('Ui.elShow: ingen aktiv kjørekontekst å vise elementet i'); return; }
        try {
          slot.appendChild(node);
          // data-ui-shown (ui-html-fasen, Task 3-browserverifisering
          // 2026-07-17): markerer noden som et LIVE elShow-montert element —
          // brython/mpy sin per-celle "Kjør alle" (js/cells.js sin
          // renderCellResult) og plain-script runSelf-grenene (index.html,
          // brython/micropython) sjekker denne (SAMME mønster som '.dash')
          // for å IKKE tømme sloten sin ubetinget etter kjøring, som ellers
          // ville revet ned akkurat denne noden idet run-resultatets
          // TEKST rendres rett etter (browser-verifisert: pyodide sin
          // "Kjør alle" bruker en append-only segmentløkke og rammes aldri
          // av dette, men brython/mpy sin Cells.runCell-vei gjorde det -
          // uten denne markøren forsvant et .show()-montert element idet
          // cellens print-tekst ble rendret etterpå).
          try { node.setAttribute('data-ui-shown', '1'); } catch (e2) {}
        }
        catch (e) { console.warn('Ui.elShow: klarte ikke å legge til elementet: ' + ((e && e.message) || e)); }
        return;
      }

      var cellIdx = _resolveCellIdx();
      var cellKey = cellIdx != null ? _cellKeyAt(cellIdx) : 'doc';
      var showKey = cellKey + '::' + target;

      var host = (typeof document !== 'undefined' && document.getElementById) ? document.getElementById(target) : null;
      if (!host) {
        console.warn('Ui.elShow: fant ikke target-element #' + target);
        var fallbackSlot = _runningSlot();
        if (!fallbackSlot) { console.warn('Ui.elShow: ingen aktiv kjørekontekst å vise elementet i'); return; }
        try {
          var notice = document.createElement('pre');
          notice.className = 'error';
          notice.textContent = 'Ui.elShow: fant ikke target-element #' + target + ' — viser her i stedet';
          try { notice.setAttribute('data-ui-shown', '1'); } catch (e2) {}
          fallbackSlot.appendChild(notice);
          try { node.setAttribute('data-ui-shown', '1'); } catch (e2) {}
          fallbackSlot.appendChild(node);
        } catch (e) {
          console.warn('Ui.elShow: klarte ikke å legge til elementet: ' + ((e && e.message) || e));
        }
        return;
      }

      // showKey-registreringen skjer HER, ETTER host-sjekken over — se
      // docstringen (ingen fantom-oppføring for et treff som aldri skjedde).
      if (cellIdx != null) {
        var run = _bindingsRunFor(cellIdx);
        run.showsRegistered[showKey] = true;
      }
      _elShowTargets[showKey] = { elId: elId, cellIdx: cellIdx, target: target };

      try {
        while (host.firstChild) host.removeChild(host.firstChild);
        host.appendChild(node);
      } catch (e) {
        console.warn('Ui.elShow: klarte ikke å erstatte innholdet i #' + target + ': ' + ((e && e.message) || e));
      }
    };

    /**
     * Ui.resetBindings() — sesjons-scoped livssyklus (index.html sine
     * restart()/invalidate()-braketter, samme sted som IpwBridge.reset()):
     * destruer HVER handler (guardet) og glem alle bindinger. Delegerte
     * dokument-lyttere (_delegated) FJERNES ikke — de blir stående som
     * evige no-ops når _bindings er tom, samme memoiserings-forutsetning
     * som _installDelegate over allerede bygger på.
     */
    Ui.resetBindings = function () {
      Object.keys(_bindings).forEach(function (key) { _destroyHandler(_bindings[key]); });
      _bindings = {};
    };

    /**
     * Ui.beginCellRun(cellIdx) — eksplisitt start på en celles kjøring:
     * nullstiller ordinal-teller og registrert-sett. Kalles fra de samme
     * kjørebrakettene i index.html som SETTER nbUiRunCtx (Kjør alle per
     * segment, enkelt-celle-stien, microdata-replayens målsegment) —
     * guardet `window.Ui && window.Ui.beginCellRun`, så plain scripts
     * uten notatbok berøres aldri. Uten dette kallet ville en rerun med
     * NULL ui.*-kall (kilden fjernet alle kontrollene) aldri nullstilt
     * registrert-settet, og endCellRun-soppen under hadde latt de gamle
     * kontrollene stå igjen.
     */
    Ui.beginCellRun = function (cellIdx) {
      // W5.2: bindingsRegistered er kontrollenes registered-sett sin
      // tvilling for element-event-bindinger — nullstilt her på nøyaktig
      // samme måte, av samme grunn (se docstringen over). ui-html-fasen
      // (Task 1): showsRegistered er DENS tvilling for elShow(target=...).
      _cellRuns[cellIdx] = { ordinal: 0, registered: {}, bindingsRegistered: {}, showsRegistered: {} };
      // ui-html-fasen (Task 1, revidert): NY generasjon for DENNE cellIdx-en
      // sin _els-sveip (se _elGens-docstringen over Ui.elCreate) — hver
      // elCreate SOM SKJER I DENNE KJØRINGEN tagges med denne generasjonen,
      // og overlever dermed uansett DENNE kjøringens egen endCellRun
      // (kryss-celle-vinduet). En oppføring fra en TIDLIGERE generasjon av
      // SAMME cellIdx som fortsatt er løsrevet når DENNE kjøringen lukkes,
      // sveipes derimot — det er nettopp "skaperens neste rerun".
      _elGens[cellIdx] = _currentElGen(cellIdx) + 1;
    };

    /**
     * Ui.endCellRun(cellIdx) — mark-og-sopp: kontroller som var registrert
     * i FORRIGE kjøring men ikke ble re-registrert i DENNE, fjernes (kilden
     * sluttet å kalle ui.* for dem — f.eks. en fjernet linje, eller en
     * betinget gren som ikke lenger treffer). Idempotent: kalles den for
     * samme cellIdx to ganger på rad (flere kjørebrakketter kan begge
     * ville nullstille), er andre kallet en no-op (se _cellRuns-kommentaren
     * over for hvorfor).
     */
    Ui.endCellRun = function (cellIdx) {
      var run = _cellRuns[cellIdx];
      var registered = run ? run.registered : {};
      Object.keys(_controls).forEach(function (key) {
        var ctrl = _controls[key];
        if (ctrl.cellIdx === cellIdx && !registered[key]) {
          if (ctrl.wrap && typeof ctrl.wrap.remove === 'function') ctrl.wrap.remove();
          // dash-absorpsjon 5a Task 3: en sopt play-kontroll sin timer må
          // dø HER — ellers tikker den videre for alltid mot en frakoblet
          // node (no-op takket være tick() sin egen isConnected-sjekk, men
          // fortsatt en ekte lekkasje av selve timer-handle-et).
          _stopPlayTimer(key);
          delete _controls[key];
          delete _values[key];
          // ui-html-fasen (Task 1): en sopt kontroll sin bundne handler (om
          // noen) skal ikke leve videre uten en synlig kontroll å tilhøre.
          if (_controlHandlers[key]) {
            _destroyHandler({ handler: _controlHandlers[key] });
            delete _controlHandlers[key];
          }
        }
      });
      // W5.2: samme mark-og-sopp-skjema for element-event-bindinger —
      // guardet destroy (pyodide-proxy) på hver sopt binding.
      var bindingsRegistered = run ? (run.bindingsRegistered || {}) : {};
      Object.keys(_bindings).forEach(function (key) {
        var b = _bindings[key];
        if (b.cellIdx === cellIdx && !bindingsRegistered[key]) {
          _destroyHandler(b);
          delete _bindings[key];
        }
      });
      // ui-html-fasen (Task 1): elShow(target=...) sin mark-og-sopp — en
      // deklarerende celle som IKKE re-viser til samme (cellKey,target) i
      // DENNE kjøringen mister det gamle innholdet i target-noden (samme
      // "kilden sluttet å produsere dette"-filosofi som kontroller/
      // bindinger over).
      var showsRegistered = run ? (run.showsRegistered || {}) : {};
      Object.keys(_elShowTargets).forEach(function (showKey) {
        var entry = _elShowTargets[showKey];
        if (entry.cellIdx === cellIdx && !showsRegistered[showKey]) {
          var host = (typeof document !== 'undefined' && document.getElementById)
            ? document.getElementById(entry.target) : null;
          if (host) { while (host.firstChild) host.removeChild(host.firstChild); }
          delete _elShowTargets[showKey];
        }
      });
      // ui-html-fasen (Task 1, revidert etter reviewer-anmerkning på commit
      // daa9ee3): _els-sveipen er nå GENERASJONS-SKOPET, ikke lenger et
      // blankt isConnected-feie over HELE registeret uansett hvilken celle
      // som bygget oppføringen (se _elGens-docstringen ved Ui.elCreate for
      // hvorfor det var galt — kryss-celle-idiomet `x = ui.html.div(...)` i
      // celle 1, `x.show()` i celle 2, ble drept av den gamle sveipen).
      //
      // En oppføring sveipes HER kun når ALLE tre holder: (1) DENNE
      // cellIdx-en BYGGET den (entry.cellIdx === cellIdx — en annen celles
      // endCellRun rører den aldri), (2) den er fra en TIDLIGERE generasjon
      // av DEN cellens kjøring (entry.gen < currentGen — en oppføring
      // bygget I DENNE kjøringen overlever alltid sin egen kjørings
      // avslutning, selv om den ennå ikke er vist noe sted), og (3) den er
      // fortsatt løsrevet (!isConnected — en vist/tilkoblet node sveipes
      // aldri, uansett generasjon). Lekkasjen (bygget-men-aldri-vist)
      // avgrenses dermed ikke ved kjøringens egen slutt, men ved dens
      // SKAPENDE celles NESTE rerun uten at noden ble koblet til i mellomtiden
      // — kryss-celle-handles (norsk: "kryss-celle-handtak") er gyldige helt
      // til akkurat det skjer.
      var currentElGen = _currentElGen(cellIdx);
      Object.keys(_els).forEach(function (id) {
        var entry = _els[id];
        if (entry && entry.cellIdx === cellIdx && entry.gen < currentElGen &&
            entry.node && entry.node.isConnected === false) {
          delete _els[id];
        }
      });
      if (run) run.closed = true;
    };

    /**
     * Ui.resetDocument() — nytt dokument (Cells.contentLoaded): glem ALT
     * (verdier, kontrollnoder, stripe-referanser, kjøre-bokføring). Kalt
     * guardet fra js/cells.js sin contentLoaded().
     */
    Ui.resetDocument = function () {
      // Task 3: _strips[cellIdx] er nå { top?, bottom?, left? } — fjern
      // hver posisjons-node som finnes (i stedet for én enkelt node per
      // cellIdx som før).
      Object.keys(_strips).forEach(function (cellIdx) {
        var byPos = _strips[cellIdx] || {};
        Object.keys(byPos).forEach(function (pos) {
          var strip = byPos[pos];
          if (strip && typeof strip.remove === 'function') strip.remove();
        });
      });
      // ui-html-fasen (Task 1): destruer ALLE bundne kontroll-handlere
      // (guardet .destroy, samme mønster som Ui.resetBindings under) FØR
      // registeret glemmes.
      Object.keys(_controlHandlers).forEach(function (key) {
        _destroyHandler({ handler: _controlHandlers[key] });
      });
      _controlHandlers = {};
      // dash-absorpsjon 5a Task 3: klarer ut ALLE ennå-løpende play-timere
      // FØR registeret glemmes — et nytt dokument har ingen gamle
      // kontroller å tikke videre for (samme "glem ALT"-hensikt som resten
      // av funksjonen; clearInterval, ikke bare et blankt objekt-bytte, ellers
      // ville selve nettleser-timeren fortsatt løpt uavhengig av registeret).
      Object.keys(_playTimers).forEach(function (key) { clearInterval(_playTimers[key]); });
      _playTimers = {};
      _values = {};
      _controls = {};
      _strips = {};
      _cellRuns = {};
      // ui-html-fasen (Task 1): glem hele element-registeret og alle
      // target-monterte elShow-oppføringer — et nytt dokument har ingen
      // gamle elId-er å referere til lenger.
      _els = {};
      _elCounter = 1;
      _elShowTargets = {};
      // ui-html-fasen (Task 1, revidert): glem generasjonstellerne også —
      // et nytt dokument har ingen gamle cellIdx-kjøringer å telle videre
      // fra (se _elGens-docstringen ved Ui.elCreate).
      _elGens = {};
      // W5.2: et helt nytt dokument invaliderer også alle element-event-
      // bindinger fra det forrige (samme "glem ALT"-hensikt som resten av
      // denne funksjonen) — guardet Ui.resetBindings finnes alltid her
      // siden begge er definert i samme DOM-halvdel-blokk.
      if (Ui.resetBindings) Ui.resetBindings();
    };
  }
})(typeof window !== 'undefined' ? window : global);
