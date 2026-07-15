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
    button: 1
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
    rerun: 1
  };

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

      // Sett verdi — hvis eksplisitt gitt, konverter til string; ellers bruk første option
      if (raw.value !== undefined) {
        spec.value = String(raw.value);
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
    } else if (type === 'button') {
      // Button har bare label, ingen value
      // label allerede kopiert ovenfor
    }

    return { spec: spec, warnings: warnings };
  };

  /**
   * Ui.controlKey(cellIdx, spec, ordinal) → string
   * Returner identiteten for denne kontrollen: cellIdx + '::' + (spec.name || 'w' + ordinal)
   */
  Ui.controlKey = function (cellIdx, spec, ordinal) {
    var name = spec.name || ('w' + ordinal);
    return cellIdx + '::' + name;
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
    // cellIdx → cellens .ui-controls-node (for lazy gjenbruk mellom kall).
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
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
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
      if (rerun === 'self' || rerun == null) return [selfCellIdx];
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
      targets.reduce(function (p, idx) {
        return p.then(function () {
          if (global.Cells && typeof global.Cells.runCell === 'function') return global.Cells.runCell(idx);
        });
      }, Promise.resolve());
    }

    // Felles endrings-håndterer: lagrer verdien UMIDDELBART (getValue()),
    // debouncer selve rerun-kallet 150ms.
    function _wireChange(key, getValue) {
      var fireDebounced = _debounce(function () { _rerunFor(key); }, 150);
      return function () {
        _values[key] = getValue();
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
      var input = document.createElement('input');
      input.type = 'range';
      input.min = spec.min; input.max = spec.max; input.step = spec.step;
      input.value = value;
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
      var input = document.createElement('select');
      spec.options.forEach(function (opt) {
        var o = document.createElement('option');
        o.value = opt; o.textContent = opt;
        input.appendChild(o);
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
      var input = document.createElement('input');
      input.type = 'checkbox';
      if (isSwitch) input.setAttribute('role', 'switch');
      input.checked = !!value;
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
      var input = document.createElement('input');
      input.type = 'number';
      if (spec.min != null) input.min = spec.min;
      if (spec.max != null) input.max = spec.max;
      if (spec.step != null) input.step = spec.step;
      input.value = value;
      input.addEventListener('change', _wireChange(key, function () { return Number(input.value); }));
      wrap.appendChild(input);
      return { wrap: wrap, input: input, labelEl: labelEl };
    }

    function _buildText(key, cellIdx, spec, value) {
      var wrap = _el('label', 'ui-widget');
      var labelEl = _el('span', 'ui-widget-label', _labelText(spec));
      wrap.appendChild(labelEl);
      var input = document.createElement('input');
      input.type = 'text';
      input.value = value;
      input.addEventListener('change', _wireChange(key, function () { return String(input.value); }));
      wrap.appendChild(input);
      return { wrap: wrap, input: input, labelEl: labelEl };
    }

    function _buildButton(key, cellIdx, spec) {
      var label = spec.label || (typeof t === 'function' ? t('Kjør') : 'Kjør');
      var btn = _el('button', 'ui-widget ui-widget--button', label);
      btn.type = 'button';
      // Ingen debounce: et knappeklikk skal rerunne UMIDDELBART.
      btn.addEventListener('click', function () { _rerunFor(key); });
      return { wrap: btn, input: btn };
    }

    var _BUILDERS = {
      slider: _buildSlider,
      dropdown: _buildDropdown,
      checkbox: function (key, cellIdx, spec, value) { return _buildCheckbox(key, cellIdx, spec, value, false); },
      switch: function (key, cellIdx, spec, value) { return _buildCheckbox(key, cellIdx, spec, value, true); },
      number: _buildNumber,
      text: _buildText
    };

    // Oppdaterer en EKSISTERENDE kontrollnode i place (label/min/max/step/
    // options fra ny spec) men BEHOLDER lagret verdi (klampet til evt. nytt
    // intervall) — ingen ny DOM-node, ingen fokus-tap.
    function _updateControlSpec(ctrl, newSpec) {
      var stored = _values.hasOwnProperty(ctrl.key) ? _values[ctrl.key] : newSpec.value;
      ctrl.spec = newSpec;
      if (ctrl.labelEl) ctrl.labelEl.textContent = _labelText(newSpec);
      if (newSpec.type === 'slider') {
        ctrl.input.min = newSpec.min; ctrl.input.max = newSpec.max; ctrl.input.step = newSpec.step;
        if (stored < newSpec.min) stored = newSpec.min;
        if (stored > newSpec.max) stored = newSpec.max;
        ctrl.input.value = stored;
        if (ctrl.readout) ctrl.readout.textContent = String(stored);
      } else if (newSpec.type === 'dropdown') {
        while (ctrl.input.firstChild) ctrl.input.removeChild(ctrl.input.firstChild);
        newSpec.options.forEach(function (opt) {
          var o = document.createElement('option');
          o.value = opt; o.textContent = opt;
          ctrl.input.appendChild(o);
        });
        if (newSpec.options.indexOf(stored) === -1) stored = newSpec.options[0];
        ctrl.input.value = stored;
      } else if (newSpec.type === 'number') {
        if (newSpec.min != null) { ctrl.input.min = newSpec.min; if (stored < newSpec.min) stored = newSpec.min; }
        if (newSpec.max != null) { ctrl.input.max = newSpec.max; if (stored > newSpec.max) stored = newSpec.max; }
        if (newSpec.step != null) ctrl.input.step = newSpec.step;
        ctrl.input.value = stored;
      } else if (newSpec.type === 'checkbox' || newSpec.type === 'switch') {
        ctrl.input.checked = !!stored;
      } else if (newSpec.type === 'text') {
        ctrl.input.value = stored;
      }
      return stored;
    }

    // Lag (lazy) eller gjenbruk cellens .ui-controls-stripe. Settes inn som
    // FØRSTE barn av cellens rot-node (sibling FØR .nb-input/.nb-output —
    // se js/cells.js sin cellNode, linje ~439-483: input bygges/appendes
    // først, deretter output, ingen egen header-sone utenfor input finnes
    // fra før). Plassering som FØRSTE barn (ikke bare "før .nb-output")
    // er et bevisst valg: i .nb-layout-columns er cellen et to-kolonners
    // grid (input | output) — en stripe midt mellom dem ville falt inn i
    // kolonne to sammen med output. Som ubetinget FØRSTE barn, med
    // `grid-column: 1 / -1` i CSS-en (app.css), spenner den i stedet hele
    // bredden som en header-rad over BEGGE soner, i alle layout-varianter
    // (kolonner/stablet/kun-output). Ved en strukturell re-rendring bytter
    // cellEl identitet (F6-mønsteret) — da bygges stripa på nytt (gamle
    // DOM-referanser i _controls for cellen glemmes), men _values (selve
    // verdiene) er dokument-scoped, ikke DOM-node-scoped, og overlever.
    function _ensureStrip(cellEl, cellIdx) {
      var strip = _strips[cellIdx];
      if (strip && strip.parentNode === cellEl) return strip;
      Object.keys(_controls).forEach(function (key) {
        if (_controls[key].cellIdx === cellIdx) delete _controls[key];
      });
      strip = document.createElement('div');
      strip.className = 'ui-controls';
      if (cellEl.firstChild) cellEl.insertBefore(strip, cellEl.firstChild);
      else cellEl.appendChild(strip);
      _strips[cellIdx] = strip;
      return strip;
    }

    /**
     * Ui.registerControl(specJson) → JSON-streng med gjeldende verdi, eller
     * null (ingen aktiv kjørekontekst — "plain script"-fallback, spec §krav).
     */
    Ui.registerControl = function (specJson) {
      var ctx = (typeof global.mdUiRunCtx === 'function') ? global.mdUiRunCtx() : null;
      // cellEl kan være null i en kant-case (Task 2-rapporten) — dette
      // guardes eksplisitt, ikke bare "ctx finnes".
      if (!ctx || !ctx.cellEl) return null;

      var cellIdx = ctx.cellIdx;
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

      var run = _cellRuns[cellIdx];
      if (!run || run.closed) {
        run = _cellRuns[cellIdx] = { ordinal: 0, registered: {} };
      }
      var ordinal = run.ordinal++;
      var key = Ui.controlKey(cellIdx, spec, ordinal);
      run.registered[key] = true;

      var strip = _ensureStrip(ctx.cellEl, cellIdx);
      var existing = _controls[key];

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
      if (existing && existing.type !== spec.type) {
        if (existing.wrap && typeof existing.wrap.remove === 'function') existing.wrap.remove();
        delete _controls[key];
        delete _values[key];
        existing = undefined;
      }

      if (spec.type === 'button') {
        if (!existing) {
          var builtBtn = _buildButton(key, cellIdx, spec);
          strip.appendChild(builtBtn.wrap);
          _controls[key] = { key: key, cellIdx: cellIdx, spec: spec, wrap: builtBtn.wrap, input: builtBtn.input, type: 'button' };
        } else {
          existing.spec = spec;
          existing.wrap.textContent = spec.label || (typeof t === 'function' ? t('Kjør') : 'Kjør');
        }
        return JSON.stringify(null);
      }

      var value;
      if (existing) {
        value = _updateControlSpec(existing, spec);
      } else {
        var stored = _values.hasOwnProperty(key) ? _values[key] : spec.value;
        var builder = _BUILDERS[spec.type];
        var built = builder(key, cellIdx, spec, stored);
        strip.appendChild(built.wrap);
        _controls[key] = {
          key: key, cellIdx: cellIdx, spec: spec, wrap: built.wrap, input: built.input,
          labelEl: built.labelEl, readout: built.readout, type: spec.type
        };
        value = stored;
      }
      _values[key] = value;
      return JSON.stringify(value);
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
      _cellRuns[cellIdx] = { ordinal: 0, registered: {} };
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
          delete _controls[key];
          delete _values[key];
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
      Object.keys(_strips).forEach(function (cellIdx) {
        var strip = _strips[cellIdx];
        if (strip && typeof strip.remove === 'function') strip.remove();
      });
      _values = {};
      _controls = {};
      _strips = {};
      _cellRuns = {};
    };
  }
})(typeof window !== 'undefined' ? window : global);
