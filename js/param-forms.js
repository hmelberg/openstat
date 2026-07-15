/* param-forms.js — Colab-stil #@param-skjemaer (spec 2 track 3, plan:
   docs/superpowers/plans/2026-07-15-notebook-widgets-w4.md)
   Ren halvdel (denne fila, Task 1): parser (linje → {varName, assignOp,
   valueRaw, meta}) + literal-skriver (splicer en ny verdi inn i EKSAKT
   verdi-spennet på linja, uendret ellers). Node-testet, ingen DOM.
   DOM-halvdel (skjema-stripe i celler, tekst-splicing via Cells, run:auto-
   rerun) kommer i Task 2 — legges til NEDERST i denne fila, samme
   ett-fil-mønster som js/ui.js og js/cells.js.

   Grammatikk-referanse: ipyform sin reverse-engineering av Colabs
   #@param-kommentarer (github.com/phihung/ipyform) + Colabs offisielle
   forms-eksempel-notatbok. W4 støtter et avgrenset delsett (se planens
   Global Constraints): {type:"string"} (+ bart array-literal → dropdown;
   allow-input:true → redigerbar), {type:"boolean"}, {type:"number"}/
   {type:"integer"}, {type:"slider", min, max, step}, {type:"date"},
   {type:"raw"}. #@title/#@markdown er UTSATT (ikke implementert her).

   Metadata-objektet i Colab-kilder er IKKE gyldig JSON i alminnelighet —
   nøkler er som oftest uten anførselstegn (`{type:"slider"}`, ikke
   `{"type":"slider"}`), og noen forfattere skriver også ukvoterte
   verdi-ord. `looseJsonParse` under er en tolerant mini-parser bygget for
   nettopp dette: den prøver JSON.parse rått først, og gjør så stadig mer
   dristige tekst-transformasjoner (kvoter bare nøkler, kvoter bare
   verdi-ord, enkelt→dobbelt anførselstegn) inntil JSON.parse lykkes eller
   alle forsøk er brukt opp. Aldri eval — brukerens rå kildetekst berøres
   aldri av parsing, kun selve metadata-teksten etter "@param". */
(function (global) {
  'use strict';
  var ParamForms = {};

  // ---------- ren halvdel ----------

  // Linje-mønster (planens regex, med eksplisitte fangst-grupper rundt ALL
  // mellomrom-bruk — nødvendig for at writeValue kan gjenskape linja
  // byte-nøyaktig og kun bytte ut selve verdi-spennet):
  //   1 indent, 2 varName, 3 mellomrom-før-op, 4 assignOp (= | <-),
  //   5 mellomrom-etter-op, 6 valueRaw (ikke-grådig), 7 mellomrom-før-kommentar,
  //   8 hele kommentaren ("#...@param..."), 9 metadata-teksten etter "@param".
  var LINE_RE = /^(\s*)([A-Za-z_]\w*)(\s*)(=|<-)(\s*)(.+?)(\s*)(#\s*@param\b(.*))?$/;

  var VALID_TYPES = { string: 1, boolean: 1, number: 1, integer: 1, slider: 1, date: 1, raw: 1 };

  // ---- tolerant mini-parser for Colabs løse "JSON" ----------------------

  // Finn indeksen til den lukkende parentesen som balanserer text[startIdx]
  // (som må være openCh) — hopper over parenteser inni anførselstegn-strenger
  // og over escapede tegn (\") slik at f.eks. `{label:"a}b"}` ikke telles feil.
  function balancedSpan(text, startIdx, openCh, closeCh) {
    var depth = 0;
    var inStr = null;
    for (var i = startIdx; i < text.length; i++) {
      var ch = text.charAt(i);
      if (inStr) {
        if (ch === '\\') { i++; continue; }
        if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'") { inStr = ch; continue; }
      if (ch === openCh) depth++;
      else if (ch === closeCh) {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  // `{type:"slider"}` → `{"type":"slider"}` — kvoter ukvoterte nøkler
  // (bokstav/understrek-start, tillater bindestrek som i "allow-input").
  function quoteBareKeys(s) {
    return s.replace(/([{,]\s*)([A-Za-z_][\w-]*)\s*:/g, '$1"$2":');
  }

  // `type:auto` → `type:"auto"` — kvoter ukvoterte verdi-ORD (ikke tall,
  // ikke true/false/null, ikke allerede kvotert) foran , eller } eller ].
  function quoteBareValues(s) {
    return s.replace(/:(\s*)([A-Za-z_][\w-]*)(\s*)(?=[,}\]])/g, function (m, sp1, word, sp2) {
      if (word === 'true' || word === 'false' || word === 'null') return m;
      return ':' + sp1 + '"' + word + '"' + sp2;
    });
  }

  // 'slider' → "slider" — enkle anførselstegn (Python-stil) til doble
  // (JSON-stil). Antar ingen doble anførselstegn inni verdien (utenfor
  // W4-delsettets bruk).
  function singleToDoubleQuotes(s) {
    return s.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, function (m, inner) {
      return '"' + inner.replace(/"/g, '\\"') + '"';
    });
  }

  // Prøv JSON.parse rått, så stadig mer tolerante transformasjoner.
  // Returnerer undefined (ALDRI kaster) hvis ingen av forsøkene lykkes.
  function looseJsonParse(text) {
    var attempts = [
      text,
      quoteBareKeys(text)
    ];
    attempts.push(quoteBareValues(attempts[1]));
    attempts.push(singleToDoubleQuotes(attempts[2]));
    for (var i = 0; i < attempts.length; i++) {
      try { return JSON.parse(attempts[i]); } catch (e) { /* prøv neste */ }
    }
    return undefined;
  }

  // Type inferert fra selve verdi-uttrykket når metadata er tom (bart
  // `#@param` uten `{...}`/`[...]`): kvotert → string, True/False/TRUE/FALSE
  // → boolean, numerisk → number, ellers → raw (planens regel).
  function inferType(valueRaw) {
    var v = String(valueRaw).trim();
    if (/^'[\s\S]*'$/.test(v) || /^"[\s\S]*"$/.test(v)) return 'string';
    if (v === 'True' || v === 'TRUE' || v === 'False' || v === 'FALSE') return 'boolean';
    if (/^-?(\d+\.?\d*|\.\d+)$/.test(v)) return 'number';
    return 'raw';
  }

  // Parse metadata-teksten etter "@param" (gruppe 9 i LINE_RE) →
  // {meta, warnings, fatal?}. fatal:true betyr "ikke gyldig — hopp over
  // hele linja" (ukjent/ubalansert syntaks); warnings uten fatal er
  // ikke-fatale (ukjente nøkler o.l.) og festes til den ferdige entryen.
  function parseMetaText(raw) {
    var warnings = [];
    var text = (raw == null ? '' : String(raw)).trim();
    var meta = {};
    if (!text) return { meta: meta, warnings: warnings };

    var remainder = text;

    if (remainder.charAt(0) === '[') {
      var closeArr = balancedSpan(remainder, 0, '[', ']');
      if (closeArr === -1) {
        warnings.push('ubalansert "[" i @param-metadata: ' + remainder);
        return { meta: null, warnings: warnings, fatal: true };
      }
      var arrText = remainder.slice(0, closeArr + 1);
      var arr = looseJsonParse(arrText);
      if (!Array.isArray(arr)) {
        warnings.push('kunne ikke tolke options-array i @param-metadata: ' + arrText);
        return { meta: null, warnings: warnings, fatal: true };
      }
      meta.options = arr.map(function (x) { return String(x); });
      meta.type = 'string';
      remainder = remainder.slice(closeArr + 1).trim();
    }

    if (remainder) {
      if (remainder.charAt(0) !== '{') {
        warnings.push('uventet tekst i @param-metadata: ' + remainder);
        return { meta: null, warnings: warnings, fatal: true };
      }
      var closeObj = balancedSpan(remainder, 0, '{', '}');
      if (closeObj === -1) {
        warnings.push('ubalansert "{" i @param-metadata: ' + remainder);
        return { meta: null, warnings: warnings, fatal: true };
      }
      var objText = remainder.slice(0, closeObj + 1);
      var obj = looseJsonParse(objText);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        warnings.push('kunne ikke tolke @param-metadata-objekt: ' + objText);
        return { meta: null, warnings: warnings, fatal: true };
      }
      // min/max/step: NaN-vakt (review-fiks 3, samme filosofi som js/ui.js
      // sin normalizeSpec) — et ikke-numerisk tall gir advarsel og nøkkelen
      // DROPPES (entryen beholdes; kontrollen får da sin default senere).
      function numKey(key, val) {
        var n = Number(val);
        if (isNaN(n)) { warnings.push('ugyldig ' + key + ' i @param-metadata: ' + val); return; }
        meta[key] = n;
      }
      Object.keys(obj).forEach(function (key) {
        var val = obj[key];
        if (key === 'type') meta.type = String(val);
        else if (key === 'min' || key === 'max' || key === 'step') numKey(key, val);
        else if (key === 'allow-input') meta.allowInput = Boolean(val);
        else if (key === 'run') { if (val === 'auto') meta.runAuto = true; }
        else if (key === 'options') {
          meta.options = Array.isArray(val) ? val.map(String) : meta.options;
        } else {
          warnings.push('ukjent nøkkel i @param-metadata: ' + key);
        }
      });
      // Overflødig tekst etter den lukkende "}" (sjelden, men ikke-fatalt —
      // ignoreres med en advarsel i stedet for å forkaste hele linja).
      var trailing = remainder.slice(closeObj + 1).trim();
      if (trailing) warnings.push('overflødig tekst etter @param-metadata: ' + trailing);
    }

    return { meta: meta, warnings: warnings };
  }

  /**
   * ParamForms.parse(cellSource, lang) → [{lineIdx, varName, assignOp,
   * valueRaw, meta, warnings}]
   * Skanner hver linje i cellen for #@param-mønsteret. Linjer uten
   * "#@param" gir ingen entry (helt inerte — spec §Global Constraints:
   * null-effekt på dokumenter uten #@param). Ukjent/ubalansert metadata
   * eller ukjent type → console.warn + linja hoppes over (INGEN entry) —
   * dette er bevisst asymmetrisk med per-entry `warnings` (ukjente NØKLER
   * i et ellers gyldig metadata-objekt er ikke-fatale og havner i den
   * returnerte entryens warnings-liste i stedet).
   */
  // Stripp en eventuell avsluttende '\r' (CRLF-dokumenter, review-fiks 2) —
  // LINE_RE sin `$` ville ellers aldri matche (\r er ikke \s i regex-forstand
  // FØR $-ankeret her, og selv om det var, ville \r havnet inni en fanget
  // gruppe og korrumpert reassemblering). Split på '\n' + stripp per linje
  // (i stedet for split på /\r?\n/) holder linje-indeksene identiske mellom
  // parse og writeValue OG lar writeValue re-attache \r-en byte-nøyaktig.
  function stripCR(line) {
    return line.charAt(line.length - 1) === '\r' ? line.slice(0, -1) : line;
  }

  ParamForms.parse = function (cellSource, lang) {
    var lines = String(cellSource == null ? '' : cellSource).split('\n');
    var entries = [];
    for (var i = 0; i < lines.length; i++) {
      var m = LINE_RE.exec(stripCR(lines[i]));
      if (!m || m[8] === undefined) continue; // ingen #@param på denne linja

      var varName = m[2];
      var assignOp = m[4];
      var valueRaw = m[6];
      var metaRaw = m[9] || '';

      var result = parseMetaText(metaRaw);
      if (result.fatal) {
        console.warn('ParamForms.parse: linje ' + (i + 1) + ': ' + result.warnings.join('; ') + ' — hopper over');
        continue;
      }
      var meta = result.meta;
      if (!meta.type) meta.type = inferType(valueRaw);
      if (!VALID_TYPES[meta.type]) {
        console.warn('ParamForms.parse: linje ' + (i + 1) + ': ukjent @param-type: ' + meta.type + ' — hopper over');
        continue;
      }

      entries.push({
        lineIdx: i,
        varName: varName,
        assignOp: assignOp,
        valueRaw: valueRaw,
        meta: meta,
        warnings: result.warnings
      });
    }
    return entries;
  };

  // Kvoter og escape en streng for python/r-literal-bruk. Review-fiks 1:
  // en backslash dobles KUN der den ellers ville skapt tvetydighet — rett
  // foran et anførselstegn (ellers ville quote-escapingens innsatte \ smelte
  // sammen med den) eller helt sist i strengen (ellers ville den escape det
  // lukkende anførselstegnet). En "ensom" backslash midt i teksten (f.eks.
  // verdien \t — to tegn) skrives UENDRET, slik at kilde-literalet '\t'
  // round-tripper byte-nøyaktig gjennom currentValue→writeValue (motstykket
  // i unquoteString under unescaper tilsvarende kun \\ og anførselstegnet).
  // Aldri eval — dette er ren tekstbehandling av brukerens NYE, typede verdi.
  function quoteAndEscape(s) {
    var escaped = String(s)
      .replace(/(\\*)'/g, function (m, bs) { return bs + bs + "\\'"; })
      .replace(/(\\*)$/, function (m, bs) { return bs + bs; });
    return "'" + escaped + "'";
  }

  function isTruthyBoolInput(value) {
    return value === true || value === 1 || value === 'true' || value === 'True' || value === 'TRUE';
  }

  /**
   * ParamForms.formatLiteral(newValue, type, lang) → string
   * Formaterer den nye verdien som et språk-bevisst literal, KLAR til å
   * settes rett inn i verdi-spennet på linja (writeValue). string/date →
   * enkelt-kvotert + escaped; boolean → True/False (py) / TRUE/FALSE (r);
   * number/slider → numerisk; integer → numerisk, rundet til nærmeste
   * heltall; raw → verbatim som skrevet (ingen kvotering/escaping — rå
   * kildekode-uttrykk, IKKE en streng-verdi).
   */
  ParamForms.formatLiteral = function (newValue, type, lang) {
    switch (type) {
      case 'string':
      case 'date':
        return quoteAndEscape(newValue);
      case 'boolean': {
        var truthy = isTruthyBoolInput(newValue);
        return lang === 'r' ? (truthy ? 'TRUE' : 'FALSE') : (truthy ? 'True' : 'False');
      }
      case 'integer':
        return String(Math.round(Number(newValue)));
      case 'number':
      case 'slider':
        return String(Number(newValue));
      case 'raw':
        return String(newValue);
      default:
        return String(newValue);
    }
  };

  /**
   * ParamForms.writeValue(cellSource, entry, newValue, lang) → newSource
   * Splicer newValue (formatert via formatLiteral) inn i EKSAKT
   * verdi-spennet på entry.lineIdx sin linje — indent, variabelnavn,
   * tildelingsoperator, all mellomrom-bruk og HELE kommentaren (inkl.
   * metadata) forblir byte-nøyaktig uendret. cellSource re-splittes og
   * linja re-matches mot samme LINE_RE (i stedet for å lagre offset-er på
   * entryen) — entry-formen holdes dermed identisk med planens
   * grensesnitt-liste.
   */
  ParamForms.writeValue = function (cellSource, entry, newValue, lang) {
    var lines = String(cellSource == null ? '' : cellSource).split('\n');
    var rawLine = lines[entry.lineIdx];
    if (rawLine === undefined) {
      console.warn('ParamForms.writeValue: ingen linje ' + entry.lineIdx + ' i cellSource');
      return cellSource;
    }
    // CRLF (review-fiks 2): \r holdes UTENFOR det matchede spennet og
    // re-attaches verbatim — dokumentets linjeender bevares byte-nøyaktig.
    var line = stripCR(rawLine);
    var cr = line === rawLine ? '' : '\r';
    var m = LINE_RE.exec(line);
    if (!m || m[8] === undefined) {
      console.warn('ParamForms.writeValue: linje ' + entry.lineIdx + ' matcher ikke lenger #@param-mønsteret');
      return cellSource;
    }
    var formatted = ParamForms.formatLiteral(newValue, entry.meta.type, lang);
    lines[entry.lineIdx] = m[1] + m[2] + m[3] + m[4] + m[5] + formatted + m[7] + m[8] + cr;
    return lines.join('\n');
  };

  // Fjern kvoter fra en python/r-streng-literal — motstykket til
  // quoteAndEscape. Review-fiks 1: unescape KUN \\ og selve anførsels-
  // tegnet; alle andre backslash-sekvenser (\t, \n, \x41, …) forblir
  // byte-intakte (verdien for '\t' er den TO-tegns strengen backslash-t,
  // ikke en tab) — parseren behandler gjeldende verdi som en opak streng
  // (spec §Global Constraints), aldri som noe som skal "tolkes".
  function unquoteString(raw) {
    var s = String(raw).trim();
    var q = s.charAt(0);
    if ((q === "'" || q === '"') && s.length >= 2 && s.charAt(s.length - 1) === q) {
      var inner = s.slice(1, -1);
      var out = '';
      for (var i = 0; i < inner.length; i++) {
        var ch = inner.charAt(i);
        if (ch === '\\' && i + 1 < inner.length) {
          var next = inner.charAt(i + 1);
          if (next === '\\' || next === q) { out += next; i++; continue; }
        }
        out += ch;
      }
      return out;
    }
    return s;
  }

  /**
   * ParamForms.currentValue(entry, lang) → typed js value
   * Utleder den TYPEDE JS-verdien fra entry.valueRaw for å seede kontrollen
   * (motstykket til formatLiteral): string/date → unquote; boolean → JS
   * boolean; number/integer/slider → JS number; raw → den rå strengen
   * uendret (et rått uttrykk har ingen "typet" form utover selve teksten).
   */
  ParamForms.currentValue = function (entry, lang) {
    var raw = entry.valueRaw;
    switch (entry.meta.type) {
      case 'string':
      case 'date':
        return unquoteString(raw);
      case 'boolean':
        return isTruthyBoolInput(String(raw).trim());
      case 'number':
      case 'integer':
      case 'slider':
        return Number(raw);
      case 'raw':
        return raw;
      default:
        return raw;
    }
  };

  // Eksporter til global og CommonJS (samme mønster som js/ui.js/js/cells.js).
  global.ParamForms = ParamForms;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ParamForms;
  }

  // ---------- DOM-halvdel (Task 2) ----------
  // Skjema-stripe-rendring i celler: én `.param-form`-node per celle, satt
  // inn av Cells sin cellNode (post-build-sømmen, js/cells.js) som cellens
  // FØRSTE barn — FØR en evt. `.ui-controls`-stripe (js/ui.js), se
  // ParamForms.reorder under. Byggerne her er EGNE, minimale kontroller
  // (planens "B2 dedup: felles builder-modul" — bevisst IKKE gjenbrukt fra
  // js/ui.js/js/dash.js i W4, samme avgrensning som js/ui.js selv dokumenterer
  // for SIN egen duplisering mot js/dash.js).
  //
  // Arkitektur: `_forms[cellIdx]` er dokument-scoped tilstand med TO
  // entry-lister (review-fiks 1, krysskanal-race):
  //  - `entries`: den FERSKESTE parsen av cellens kilde — holdes synkron med
  //    HVERT tastetrykk via ParamForms.syncSource (kalt synkront fra
  //    js/cells.js sin onEdit, FØR 250ms-debouncen) og med hver _commit.
  //    Dette er splice-grunnlaget: _commit slår ALLTID opp sin entry her
  //    (fersk lineIdx), aldri i den closure-fangede entryen fra byggetid.
  //  - `builtEntries`: entry-øyeblikksbildet stripa/`controls` faktisk ble
  //    BYGGET fra — refresh sin struktur-sammenlikning går mot DENNE (ikke
  //    mot `entries`, som syncSource kan ha oppdatert i mellomtiden), slik
  //    at "controls[i] hører til builtEntries[i]"-parallelliteten aldri
  //    brytes av en mellomliggende tastetrykk-synk.
  // I tillegg cellEl/lang/source (gjeldende kilde), strip-noden og controls.
  if (typeof document !== 'undefined') {
    var _forms = {};      // cellIdx -> { cellEl, lang, source, entries, builtEntries, strip, controls }
    var _runTimers = {};  // "cellIdx:lineIdx" -> debounce-timer-håndtak (run:auto slider)

    function _el(tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }

    function _sliderMeta(entry) {
      var meta = entry.meta;
      return {
        min: meta.min !== undefined ? meta.min : 0,
        max: meta.max !== undefined ? meta.max : 100,
        step: meta.step !== undefined ? meta.step : 1
      };
    }

    // ---- kontroll-byggere (én per type) -----------------------------------
    // Alle returnerer { input, readout?, extra? } — `input` er selve
    // skjema-elementet (lagt i raden ETTER label-spanen), `readout` en
    // valgfri verdi-visning (kun slider), `extra` en usynlig ledsager-node
    // (datalist for dropdown+allow-input).

    function _buildText(cellIdx, entry, value, lang) {
      var input = document.createElement('input');
      input.type = 'text';
      input.value = value == null ? '' : String(value);
      input.addEventListener('change', function () { _commit(cellIdx, entry, input.value, lang); });
      return { input: input };
    }

    // raw: BEVISST et vanlig, unadorned tekstfelt uten kvotering/escaping —
    // Task 1-rapporten flagget at formatLiteral('raw') setter verdien inn
    // VERBATIM som kildekode (ingen streng-literal). Det er riktig by design
    // (brukeren redigerer sin EGEN kode via dette feltet, ikke en tilfeldig
    // streng) — kontrollen her gjør derfor ingen sanering utover det
    // tekstfeltet i seg selv naturlig gir.
    function _buildRaw(cellIdx, entry, value, lang) {
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'param-form-raw';
      input.value = value == null ? '' : String(value);
      input.addEventListener('change', function () { _commit(cellIdx, entry, input.value, lang); });
      return { input: input };
    }

    function _buildDropdown(cellIdx, entry, value, lang) {
      var meta = entry.meta;
      var options = meta.options || [];
      if (meta.allowInput) {
        var input = document.createElement('input');
        input.type = 'text';
        input.value = value == null ? '' : String(value);
        var listId = 'param-form-list-' + cellIdx + '-' + entry.lineIdx;
        input.setAttribute('list', listId);
        var datalist = document.createElement('datalist');
        datalist.id = listId;
        options.forEach(function (opt) {
          var o = document.createElement('option');
          o.value = opt;
          datalist.appendChild(o);
        });
        input.addEventListener('change', function () { _commit(cellIdx, entry, input.value, lang); });
        return { input: input, extra: datalist };
      }
      var select = document.createElement('select');
      options.forEach(function (opt) {
        var o = document.createElement('option');
        o.value = opt; o.textContent = opt;
        select.appendChild(o);
      });
      select.value = value;
      select.addEventListener('change', function () { _commit(cellIdx, entry, select.value, lang); });
      return { input: select };
    }

    function _buildCheckbox(cellIdx, entry, value, lang) {
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!value;
      input.addEventListener('change', function () { _commit(cellIdx, entry, input.checked, lang); });
      return { input: input };
    }

    function _buildNumber(cellIdx, entry, value, lang) {
      var input = document.createElement('input');
      input.type = 'number';
      if (entry.meta.type === 'integer') input.step = 1;
      else if (entry.meta.step !== undefined) input.step = entry.meta.step;
      if (entry.meta.min !== undefined) input.min = entry.meta.min;
      if (entry.meta.max !== undefined) input.max = entry.meta.max;
      input.value = value;
      input.addEventListener('change', function () { _commit(cellIdx, entry, input.value, lang); });
      return { input: input };
    }

    function _buildDate(cellIdx, entry, value, lang) {
      var input = document.createElement('input');
      input.type = 'date';
      input.value = value == null ? '' : String(value);
      input.addEventListener('change', function () { _commit(cellIdx, entry, input.value, lang); });
      return { input: input };
    }

    function _buildSlider(cellIdx, entry, value, lang) {
      var range = _sliderMeta(entry);
      var input = document.createElement('input');
      input.type = 'range';
      input.min = range.min; input.max = range.max; input.step = range.step;
      input.value = value;
      var readout = _el('span', 'param-form-value', String(value));
      // 'input' (ikke 'change'): live oppdatering av readout OG av kilden
      // mens brukeren drar — run:auto sin faktiske kjøring debounces separat
      // (_scheduleRun, 150ms) slik at hver piksel IKKE trigger en kjøring,
      // men teksten/readouten følger draget umiddelbart (samme UX-valg som
      // js/ui.js sin _buildSlider).
      input.addEventListener('input', function () {
        readout.textContent = String(input.value);
        _commit(cellIdx, entry, input.value, lang);
      });
      return { input: input, readout: readout };
    }

    var _BUILDERS = {
      string: function (cellIdx, entry, value, lang) {
        return entry.meta.options ? _buildDropdown(cellIdx, entry, value, lang) : _buildText(cellIdx, entry, value, lang);
      },
      boolean: _buildCheckbox,
      number: _buildNumber,
      integer: _buildNumber,
      slider: _buildSlider,
      date: _buildDate,
      raw: _buildRaw
    };

    // ---- run:auto debounce (150ms for slider, umiddelbar ellers) ----------

    function _runNow(cellIdx) {
      // Samme nekt-mønster som js/ui.js sin _rerunFor: nektes (drop, ikke kø)
      // mens skriptet allerede kjører — neste endring re-trigger sin egen
      // debounce/umiddelbare kall.
      if (global.mdIsScriptRunning && global.mdIsScriptRunning()) return;
      if (global.Cells && typeof global.Cells.runCell === 'function') global.Cells.runCell(cellIdx);
    }

    function _scheduleRun(cellIdx, entry, debounced) {
      var key = cellIdx + ':' + entry.lineIdx;
      if (_runTimers[key]) { clearTimeout(_runTimers[key]); _runTimers[key] = null; }
      if (!debounced) { _runNow(cellIdx); return; }
      _runTimers[key] = setTimeout(function () {
        _runTimers[key] = null;
        _runNow(cellIdx);
      }, 150);
    }

    // Slå opp den FERSKESTE entryen (fra st.entries, holdt synkron per
    // tastetrykk via syncSource) som svarer til en closure-fanget entry fra
    // byggetid (review-fiks 1): identitet først (ingen synk har skjedd),
    // deretter eksakt (varName, type, lineIdx), til slutt (varName, type)
    // alene — linja kan ha FLYTTET seg (bruker skrev en linje over) uten at
    // kontrollen er ombygd ennå. Duplicate varName+type på ulike linjer er
    // patologisk (samme variabel tilordnet to ganger med hver sin #@param);
    // første match vinner da — dokumentert begrensning, aldri korrupsjon av
    // en IKKE-#@param-linje (writeValue re-matcher linja uansett).
    function _freshEntryFor(st, captured) {
      var list = st.entries || [];
      var i;
      for (i = 0; i < list.length; i++) if (list[i] === captured) return captured;
      for (i = 0; i < list.length; i++) {
        if (list[i].varName === captured.varName && list[i].meta.type === captured.meta.type &&
            list[i].lineIdx === captured.lineIdx) return list[i];
      }
      for (i = 0; i < list.length; i++) {
        if (list[i].varName === captured.varName && list[i].meta.type === captured.meta.type) return list[i];
      }
      return null;
    }

    // Kontroll endret → writeValue → Cells.updateCellSource → evt. run:auto.
    // st.source (cellens NÅVÆRENDE kildetekst, holdt i _forms og synkron med
    // hvert tastetrykk via syncSource — review-fiks 1) er writeValue sitt
    // cellSource-argument — IKKE hele dokumentet (entry.lineIdx er
    // celle-relativ, se den rene halvdelen over). Den closure-fangede entryen
    // brukes KUN som oppslagsnøkkel (_freshEntryFor) — splicingen skjer alltid
    // mot den ferskeste entryen/kilden, så en manuelt skrevet linje i samme
    // debounce-vindu aldri mistes og lineIdx aldri er foreldet.
    function _commit(cellIdx, capturedEntry, newValue, lang) {
      var st = _forms[cellIdx];
      if (!st) return;
      var entry = _freshEntryFor(st, capturedEntry);
      if (!entry) {
        console.warn('ParamForms: fant ikke #@param-oppføringen for "' + capturedEntry.varName +
          '" i gjeldende kilde (linja fjernet/endret under hånden?) — endringen droppes');
        return;
      }
      var newSource = ParamForms.writeValue(st.source, entry, newValue, lang);
      st.source = newSource;
      // Hold st.entries selv-konsistent med den nye kilden (fersk valueRaw)
      // uavhengig av om Cells.updateCellSource → refresh-tilbakekallet under
      // faktisk finnes (guardet) — billig (cellen er liten), og gjør _commit
      // korrekt også i isolasjon.
      st.entries = ParamForms.parse(newSource, st.lang);
      if (global.Cells && typeof global.Cells.updateCellSource === 'function') {
        global.Cells.updateCellSource(cellIdx, newSource);
      }
      if (entry.meta.runAuto) _scheduleRun(cellIdx, entry, entry.meta.type === 'slider');
    }

    function _buildEntryControl(cellIdx, entry, value, lang) {
      var builder = _BUILDERS[entry.meta.type] || _buildText;
      var built = builder(cellIdx, entry, value, lang);
      var row = _el('label', 'param-form-row');
      row.appendChild(_el('span', 'param-form-label', entry.varName));
      row.appendChild(built.input);
      if (built.readout) row.appendChild(built.readout);
      if (built.extra) row.appendChild(built.extra);
      return { row: row, input: built.input, readout: built.readout, entry: entry };
    }

    // Sett `strip` inn i `cellEl` som FØRSTE barn — MEN før en evt. allerede
    // tilstedeværende `.ui-controls`-stripe (js/ui.js), slik at
    // .param-form ALLTID kommer før .ui-controls når begge finnes (planens
    // eksplisitte rekkefølgekrav). Det vanlige tilfellet (skjemaet dekoreres
    // FØR cellen noensinne har kjørt, altså FØR .ui-controls i det hele tatt
    // finnes) gjør dette til en ren "sett som cellEl.firstChild"; det
    // uvanlige tilfellet (en .ui-controls dukker opp SENERE, når cellen
    // kjøres) håndteres i stedet av ParamForms.reorder (kalt fra
    // js/cells.js sin runCell etter hver kjøring).
    function _insertStrip(cellEl, strip) {
      var kids = cellEl.children || [];
      var uiControls = null;
      for (var i = 0; i < kids.length; i++) {
        if (kids[i].classList && kids[i].classList.contains('ui-controls')) { uiControls = kids[i]; break; }
      }
      if (uiControls) cellEl.insertBefore(strip, uiControls);
      else if (cellEl.firstChild) cellEl.insertBefore(strip, cellEl.firstChild);
      else cellEl.appendChild(strip);
    }

    // Bygg (eller gjenbygg) skjema-stripa for cellIdx fra bunnen av — kalt av
    // BÅDE decorate (alltid) og refresh (kun ved strukturell endring, se
    // under). En eldre stripe (fra en TIDLIGERE _build for SAMME cellIdx,
    // fortsatt festet til SAMME cellEl) fjernes eksplisitt først — i den
    // vanlige "cellNode bygde en helt ny cellEl"-flyten er dette en no-op
    // (den forrige stripa henger på en allerede orphanet cellEl og trengs
    // ikke ryddes), men gjør funksjonen trygg å kalle to ganger på rad for
    // samme, fortsatt-tilkoblede cellEl også.
    function _build(cellIdx, cellEl, source, lang) {
      var prev = _forms[cellIdx];
      if (prev && prev.strip && prev.strip.parentNode === cellEl) prev.strip.remove();
      var entries = ParamForms.parse(source, lang);
      if (!entries.length) {
        _forms[cellIdx] = { cellEl: cellEl, lang: lang, source: source,
                            entries: [], builtEntries: [], strip: null, controls: [] };
        return;
      }
      var strip = _el('div', 'param-form');
      var controls = [];
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var value = ParamForms.currentValue(entry, lang);
        var ctrl = _buildEntryControl(cellIdx, entry, value, lang);
        strip.appendChild(ctrl.row);
        controls.push(ctrl);
      }
      _insertStrip(cellEl, strip);
      // entries og builtEntries starter som SAMME liste (bygget nettopp nå);
      // de divergerer først når syncSource oppdaterer entries per tastetrykk
      // mens stripa fortsatt står — refresh sammenlikner alltid mot
      // builtEntries (det kontrollene faktisk ble bygget fra).
      _forms[cellIdx] = { cellEl: cellEl, lang: lang, source: source,
                          entries: entries, builtEntries: entries, strip: strip, controls: controls };
    }

    // To entry-lister har "samme struktur" (→ oppdater kontroller i place)
    // når de har identisk lengde og hver enkelt entry er UENDRET i alt som
    // påvirker HVILKEN kontroll som tegnes (linje, variabelnavn, type,
    // slider/number-intervall, dropdown-options, allow-input) — kun selve
    // VERDIEN har lov til å avvike. Alt annet (lagt til/fjernet en
    // #@param-linje, byttet type, nytt options-sett, …) er strukturelt →
    // full ombygging.
    function _sameOptions(a, b) {
      a = a || []; b = b || [];
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    }
    function _sameStructure(oldEntries, newEntries) {
      if (oldEntries.length !== newEntries.length) return false;
      for (var i = 0; i < oldEntries.length; i++) {
        var a = oldEntries[i], b = newEntries[i];
        if (a.lineIdx !== b.lineIdx || a.varName !== b.varName || a.meta.type !== b.meta.type) return false;
        if (a.meta.type === 'slider' || a.meta.type === 'number') {
          if (a.meta.min !== b.meta.min || a.meta.max !== b.meta.max || a.meta.step !== b.meta.step) return false;
        }
        if (!!a.meta.allowInput !== !!b.meta.allowInput) return false;
        if (!_sameOptions(a.meta.options, b.meta.options)) return false;
      }
      return true;
    }

    // Oppdater ÉN kontrolls viste verdi fra en fersk entry — NO-OP (rører
    // ikke DOM-en i det hele tatt) når den nye verdien allerede er det
    // kontrollen viser. Dette er selve no-løkke-garantien planen etterspør:
    // Cells.updateCellSource kaller ParamForms.refresh etter HVER commit
    // (også kontrollens EGEN), og siden formatLiteral→currentValue rundtures
    // byte-/verdi-nøyaktig, er den kontrollen som nettopp ble endret ALLTID
    // en no-op her — en slider midt i en drag mister aldri fokus/blir aldri
    // skrevet til av sin egen sykel.
    function _updateControlValue(ctrl, newEntry, lang) {
      var newValue = ParamForms.currentValue(newEntry, lang);
      ctrl.entry = newEntry;
      var type = newEntry.meta.type;
      if (type === 'slider' || type === 'number' || type === 'integer') {
        if (Number(ctrl.input.value) === Number(newValue)) return;
        ctrl.input.value = newValue;
        if (ctrl.readout) ctrl.readout.textContent = String(newValue);
      } else if (type === 'boolean') {
        if (!!ctrl.input.checked === !!newValue) return;
        ctrl.input.checked = !!newValue;
      } else {
        if (String(ctrl.input.value) === String(newValue)) return;
        ctrl.input.value = newValue;
      }
    }

    /**
     * ParamForms.decorate(cellIdx, cellEl, source, lang) — bygg (alltid)
     * skjema-stripa for denne cellen. Kalt fra js/cells.js sin cellNode
     * (post-build-sømmen) for HVER celle ved hver (re)rendring — cellEl er
     * da alltid en FERSK node, så en ubetinget full bygging her er korrekt
     * (ingen forsøk på å gjenbruke DOM-noder på tvers av en strukturell
     * re-rendring, samme "F6-mønster" som resten av notatbok-rendringen).
     * Ingen entries → ingen stripe i det hele tatt (zero-effekt-kravet for
     * dokumenter/celler uten #@param).
     */
    ParamForms.decorate = function (cellIdx, cellEl, source, lang) {
      if (!cellEl) return;
      _build(cellIdx, cellEl, source, lang);
    };

    /**
     * ParamForms.refresh(cellIdx, source) — re-parse cellens kildetekst og
     * oppdater skjemaet: samme struktur → kontrollverdier oppdateres I PLACE
     * (ingen ombygging, se _updateControlValue over); strukturell endring
     * (linje lagt til/fjernet, type/intervall/options endret) → stripa bygges
     * på nytt (_build, samme sti som decorate). Kalt fra to steder i
     * js/cells.js: onEdit sin 250ms-debounce (manuell tekst-redigering) og
     * Cells.updateCellSource (en kontrolls EGEN endring — se _updateControlValue
     * sin no-op-garanti for hvorfor dette ikke er en sirkulær ombyggings-loop).
     * Merk: `decorate` lagrer ALLTID en `_forms`-oppføring (cellEl + lang),
     * selv for en celle UTEN #@param-linjer (entries: []) — en fersk
     * #@param-linje skrevet inn i en tidligere param-fri celle er dermed en
     * ordinær STRUKTURELL endring (0 → 1 entries) som _build (under) bygger
     * stripa for, akkurat som ethvert annet lagt-til/fjernet-linje-tilfelle.
     * Ingen `_forms`-oppføring i det hele tatt for denne cellIdx-en (decorate
     * ble aldri kalt — f.eks. en celletype ParamForms ikke dekorerer, se
     * Cells.paramLangForType) → total no-op; refresh kan ALDRI initialisere
     * en celle på egen hånd, kun bygge videre på en decorate som alt har kjørt.
     */
    ParamForms.refresh = function (cellIdx, source) {
      var st = _forms[cellIdx];
      if (!st) return;
      var newEntries = ParamForms.parse(source, st.lang);
      // Struktur-sammenlikningen går mot builtEntries — det kontrollene
      // faktisk ble BYGGET fra — ikke mot st.entries, som syncSource kan ha
      // oppdatert per tastetrykk siden (review-fiks 1): controls[i] er
      // parallell med builtEntries[i], og det er DEN parallelliteten som
      // avgjør om en oppdatering i place er trygg.
      if (!_sameStructure(st.builtEntries, newEntries)) {
        _build(cellIdx, st.cellEl, source, st.lang);
        return;
      }
      for (var i = 0; i < newEntries.length; i++) {
        _updateControlValue(st.controls[i], newEntries[i], st.lang);
      }
      st.entries = newEntries;
      st.builtEntries = newEntries;
      st.source = source;
    };

    /**
     * ParamForms.syncSource(cellIdx, source) — SYNKRON, DOM-fri kildesynk
     * (review-fiks 1, krysskanal-race): kalles fra js/cells.js sin onEdit
     * for HVERT tastetrykk (FØR 250ms-debouncen), slik at _commit sitt
     * splice-grunnlag (st.source) og entry-oppslag (st.entries, fersk
     * lineIdx) aldri er eldre enn det brukeren faktisk ser i cellens
     * textarea. Uten dette kunne en kontroll-endring innen debounce-vinduet
     * splice inn i en FORELDET kilde og stille miste nettopp-skrevet tekst
     * (reviewer-repro: skriv `y = 1` på linja over, dra slideren < 250ms
     * etter → `y = 1` forsvant). Rører ALDRI DOM-en — den visuelle
     * oppdateringen (_updateControlValue/ombygging) hører fortsatt til den
     * debouncede ParamForms.refresh.
     */
    ParamForms.syncSource = function (cellIdx, source) {
      var st = _forms[cellIdx];
      if (!st) return;
      st.source = source;
      st.entries = ParamForms.parse(source, st.lang);
    };

    /**
     * ParamForms.reorder(cellElOrIdx) — reassert at `.param-form` (om den
     * finnes) står FØR `.ui-controls` (om DEN finnes) blant cellens direkte
     * barn. Nødvendig fordi js/ui.js sin _ensureStrip ikke vet noe om
     * .param-form og alltid setter .ui-controls inn som cellEl.firstChild —
     * .ui-controls kan dukke opp FØRSTE gang under en cellekjøring (den
     * eneste anledningen den kan oppstå): enkelt-celle-stien (js/cells.js
     * sin runCell kaller hit med cellens _wrap-node) OG "Kjør alle"/replay-
     * segmentløkkene i index.html (review-fiks 2 — de kaller hit med
     * CELLEINDEKSEN, ved samme brakettpunkter som Ui.endCellRun). Et tall
     * løses derfor til cellens gjeldende DOM-node via Cells.cellElementAt
     * (friskt oppslag — noden byttes ved strukturell re-rendring, F6-
     * mønsteret). No-op når en av de to stripene (eller begge) mangler,
     * eller når rekkefølgen allerede stemmer.
     */
    ParamForms.reorder = function (cellElOrIdx) {
      var cellEl = cellElOrIdx;
      if (typeof cellElOrIdx === 'number') {
        cellEl = (global.Cells && typeof global.Cells.cellElementAt === 'function')
          ? global.Cells.cellElementAt(cellElOrIdx) : null;
      }
      if (!cellEl || !cellEl.children) return;
      var kids = cellEl.children;
      var form = null, controls = null, formIdx = -1, controlsIdx = -1;
      for (var i = 0; i < kids.length; i++) {
        var k = kids[i];
        if (!k.classList) continue;
        if (k.classList.contains('param-form')) { form = k; formIdx = i; }
        else if (k.classList.contains('ui-controls')) { controls = k; controlsIdx = i; }
      }
      if (!form || !controls || formIdx < controlsIdx) return;
      cellEl.insertBefore(form, controls);
    };

    /**
     * ParamForms.resetDocument() — nytt dokument (Cells.contentLoaded, samme
     * dokument-scoped-reset-kjede som Ui.resetDocument/IpwBridge.reset):
     * glem all skjema-tilstand OG kanseller enhver ventende run:auto-
     * debounce-timer. Uten timer-kanselleringen kunne en løs 150ms-timer fra
     * FORRIGE dokument fyre `Cells.runCell(idx)` mot et NYTT dokuments celle
     * på samme indeks.
     */
    ParamForms.resetDocument = function () {
      Object.keys(_runTimers).forEach(function (key) {
        if (_runTimers[key]) clearTimeout(_runTimers[key]);
      });
      _runTimers = {};
      _forms = {};
    };
  }
})(typeof window !== 'undefined' ? window : global);
