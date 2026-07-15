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
  // Kommer i Task 2: skjema-stripe-rendring i celler, Cells.updateCellSource-
  // integrasjon, run:auto-debounce-rerun. Denne fila har bevisst INGEN
  // `if (typeof document !== 'undefined')`-seksjon ennå — legges til i
  // Task 2 samme sted som ui.js/cells.js sine DOM-halvdeler.
})(typeof window !== 'undefined' ? window : global);
