/* cells.js — notatbok-celler (spec: docs/superpowers/specs/2026-07-13-notebook-cells-design.md)
   Ren halvdel (øverst): #%%-parsing, serialisering, kjørbar-tekst-transform.
   Node-testet, ingen DOM. DOM-halvdel (nederst): notebook-rendrer. Kun browser.
   Kanonisk format er alltid ren tekst i #scriptInput — cellemodellen er avledet. */
(function (global) {
  'use strict';
  var C = {};

  // ---------- ren halvdel ----------

  var MARKER_RE = /^#\s?%%(?:\s+(.*))?\s*$/;
  var TYPES = ['python', 'r', 'duckdb', 'brython', 'micropython', 'javascript', 'microdata',
               'statx', 'md', 'html', 'skip'];
  var ALIASES = { py: 'python', pyodide: 'python', js: 'javascript', markdown: 'md', text: 'md' };
  var NONCODE = { md: 1, html: 1, skip: 1 };
  // slide/speak/rerun/sync er reservert for spec 2/3 — parses, brukes ikke ennå.
  // widgets (widget-plassering-fasen): styrer hvor .param-form/.ui-controls-
  // stripene havner i cellens .nb-output (se docCellNode) — top|bottom|left,
  // default top når fraværende eller ugyldig (WIDGETS_POS under).
  // import: ui-html-fasen (Task 4, spec §4) — '#tag.import' er en KJENT
  // nøkkel (unngår "ukjent attributt"-varselet), men er PREAMBEL-ONLY —
  // se parseCells() sin post-pass under, som varsler eksplisitt når den
  // dukker opp i en celleblokk i stedet for å bake den inn i cell.attrs.
  // cols (Task 4, spec §4) — dash-gridens enkle arvtaker: heltall 2-6, gjør
  // .nb-output-body til et grid som lar flere mounted payloads/elementer
  // flyte i kolonner (docCellNode/app.css under). Ugyldig verdi (ikke et
  // heltall 2-6) speiler id sin "droppes"-semantikk (se COLS_VALUES-sjekkene
  // i parseHeader/scanTagBlock) i stedet for style/widgets sin "behold verdi,
  // bare varsle" — en cols-klasse kan ikke finnes for en verdi CSS-en ikke
  // har en regel for, så attributten må utelates helt, ikke bare varsles om.
  var KNOWN_KEYS = { id: 1, style: 1, slide: 1, speak: 1, rerun: 1, sync: 1, widgets: 1, import: 1, cols: 1 };
  var KNOWN_FLAGS = { 'hide-code': 1, 'hide-output': 1, slide: 1 };
  var STYLES = { note: 1, warn: 1, card: 1 };
  var WIDGETS_POS = { top: 1, bottom: 1, left: 1 };
  var COLS_VALUES = { 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 };
  C.WIDGETS_POS = WIDGETS_POS;
  var ID_RE = /^[A-Za-z0-9_-]+$/;
  // Fase A: modusene der notebook-rendring og segmentkjøring er støttet.
  // Fase C (spec 2026-07-16): + brython/micropython — motor-notatbøker som
  // kjøres celle-for-celle UTENOM segmentmaskineriet (SEG_MARKER har dem
  // med vilje IKKE; executableSource skal fortsette å blanke dem).
  var SUPPORTED_MODES = { python: 1, r: 1, duckdb: 1, microdata: 1,
                          brython: 1, micropython: 1, javascript: 1 };

  C.isMarkerLine = function (line) { return MARKER_RE.test(String(line)); };

  C.hasMarkers = function (text) {
    var lines = String(text == null ? '' : text).split('\n');
    for (var i = 0; i < lines.length; i++) if (MARKER_RE.test(lines[i])) return true;
    return false;
  };

  C.supportedMode = function (mode) { return SUPPORTED_MODES[mode] === 1; };
  C.isCodeType = function (type) { return !NONCODE[type]; };
  C.resolveType = function (cell, docMode) { return cell.type || docMode || 'python'; };

  // 'python id=plot speak="hei du"' → ['python', 'id=plot', 'speak=hei du']
  function tokenize(s) {
    var out = [], cur = '', inQ = false, i = 0;
    while (i < s.length) {
      var ch = s.charAt(i);
      if (inQ) {
        if (ch === '\\' && s.charAt(i + 1) === '"') { cur += '"'; i += 2; continue; }
        if (ch === '"') { inQ = false; i++; continue; }
        cur += ch; i++; continue;
      }
      if (ch === '"') { inQ = true; i++; continue; }
      if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } i++; continue; }
      cur += ch; i++;
    }
    if (inQ) return null; // ulukket sitat
    if (cur) out.push(cur);
    return out;
  }

  C.parseHeader = function (line) {
    var m = MARKER_RE.exec(String(line));
    var res = { type: null, attrs: {}, warnings: [] };
    if (!m) { res.warnings.push('ikke en markørlinje'); return res; }
    var rest = (m[1] || '').trim();
    if (!rest) return res;
    var toks = tokenize(rest);
    if (toks === null) { res.warnings.push('ulukket " i celle-header'); toks = rest.split(/\s+/); }
    if (toks.length) {
      var br = /^\[(\w+)\]$/.exec(toks[0]);
      var t0 = (br ? br[1] : toks[0]).toLowerCase();
      if (ALIASES[t0]) t0 = ALIASES[t0];
      if (TYPES.indexOf(t0) !== -1) { res.type = t0; toks.shift(); }
    }
    toks.forEach(function (tok) {
      var eq = tok.indexOf('=');
      if (eq > 0) {
        var key = tok.slice(0, eq).toLowerCase();
        var val = tok.slice(eq + 1);
        if (!KNOWN_KEYS[key]) res.warnings.push('ukjent attributt: ' + key);
        if (key === 'id' && !ID_RE.test(val)) { res.warnings.push('ugyldig id: ' + val); return; }
        if (key === 'cols' && !COLS_VALUES[val]) { res.warnings.push('ugyldig cols: ' + val + ' (2-6)'); return; }
        if (key === 'style' && !STYLES[val]) res.warnings.push('ukjent style: ' + val);
        if (key === 'widgets' && !WIDGETS_POS[val]) res.warnings.push('ukjent widgets-plassering: ' + val);
        res.attrs[key] = val;
      } else {
        var flag = tok.toLowerCase();
        if (!KNOWN_FLAGS[flag]) res.warnings.push('ukjent flagg: ' + flag);
        res.attrs[flag] = true;
      }
    });
    return res;
  };

  // ---------- #tag-celledirektiver (spec 2026-07-16-tag-directives-design.md) ----------

  var TAG_PREFIX_RE = /^\s*#\s*tag\./;
  var TAG_LINE_RE = /^\s*#\s*tag\.([A-Za-z_][\w-]*)\s*=\s*(\S.*?)\s*$/;

  // Verdi-koersjon (spec §1): '"x"'/"'x'" → x; usitert true/false → boolean
  // (så '#tag.hide-code = true' gir samme attrs-form som header-flagget);
  // alt annet forblir streng (header-attrs er strenger — slide=3 er '3').
  function coerceTagValue(raw) {
    var q = raw.charAt(0);
    if (raw.length >= 2 && (q === '"' || q === "'") && raw.charAt(raw.length - 1) === q) {
      return raw.slice(1, -1);
    }
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return raw;
  }

  // Skann en cellekropps tag-blokk (spec §1/§2). Ren funksjon, kropps-
  // relative 0-baserte linjenumre (parseCells absoluttiserer til 'linje N').
  // Celle-modus: ledende blanklinjer hoppes over, deretter sammenhengende
  // tag-linjer; første andre linje (også blank) avslutter blokken. En linje
  // som LIGNER en tag (prefikset) men ikke matcher full syntaks konsumeres
  // med varsel — én skrivefeil skal ikke stille demotere resten av blokken.
  // Preambel-modus: tag-linjer plukkes fra den LEDENDE blank/#-kommentar-
  // kjeden (ekte preambler begynner med # label:/#options./# load — de
  // linjene røres ikke); første ikke-blanke ikke-#-linje avslutter skannet.
  // Tag-aktige linjer ETTER blokken er inerte kommentarer og varsles (kjent
  // forbehold i spec: strengliteral-innhold kan gi falskt positivt varsel).
  C.scanTagBlock = function (source, isPreamble) {
    var lines = String(source == null ? '' : source).split('\n');
    var res = { tags: {}, entries: [], tagLines: [], warnings: [] };
    var open = true;      // skannet (blokken/preambel-kjeden) er fortsatt åpent
    var started = false;  // (celle-modus) blokken har fått sin første tag-linje
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var blank = line.trim() === '';
      var tagish = TAG_PREFIX_RE.test(line);
      if (open) {
        if (isPreamble) {
          if (blank) continue;
          if (line.replace(/^\s+/, '').charAt(0) !== '#') { open = false; }
          else if (!tagish) continue;           // # label:/# load/#options. — urørt
        } else if (!started) {
          if (blank) continue;                  // ledende blanklinjer tillatt
          if (!tagish) open = false;            // første innholdslinje — ingen blokk
          else started = true;
        } else if (!tagish) {
          open = false;                         // blank eller innhold avslutter blokken
        }
      }
      if (!tagish) continue;
      if (!open) {                              // inert sen tag-linje — kun varsel
        res.warnings.push({ line: i, msg: '#tag utenfor tagg-blokken — ignorert' });
        continue;
      }
      res.tagLines.push(i);
      var m = TAG_LINE_RE.exec(line);
      if (!m) { res.warnings.push({ line: i, msg: 'ugyldig #tag-linje' }); continue; }
      var key = m[1].toLowerCase();
      var val = coerceTagValue(m[2]);
      if (key === 'type') {
        var tv = String(val).toLowerCase();
        if (ALIASES[tv]) tv = ALIASES[tv];
        if (TYPES.indexOf(tv) === -1) {
          res.warnings.push({ line: i, msg: 'ukjent type: ' + val });
          continue;                             // ugyldig type lagres ikke
        }
        val = tv;
      } else if (!KNOWN_KEYS[key] && !KNOWN_FLAGS[key]) {
        res.warnings.push({ line: i, msg: 'ukjent attributt: ' + key });
      }
      if (key === 'id') {
        if (isPreamble) {
          res.warnings.push({ line: i, msg: 'id kan ikke være dokument-default' });
          continue;
        }
        if (!ID_RE.test(String(val))) {
          res.warnings.push({ line: i, msg: 'ugyldig id: ' + val });
          continue;                             // speiler parseHeader: ugyldig id droppes
        }
      }
      if (key === 'cols' && !COLS_VALUES[val]) {
        res.warnings.push({ line: i, msg: 'ugyldig cols: ' + val + ' (2-6)' });
        continue;                               // speiler parseHeader: ugyldig cols droppes
      }
      if (key === 'style' && !STYLES[val]) res.warnings.push({ line: i, msg: 'ukjent style: ' + val });
      if (key === 'widgets' && !WIDGETS_POS[val]) res.warnings.push({ line: i, msg: 'ukjent widgets-plassering: ' + val });
      // 'import' er REPETERBAR med vilje (ui-html-fasen, Task 4, spec §4:
      // "the last-wins tags map is bypassed for this key") — hver
      // '#tag.import = …'-linje er en EGEN import, ikke en omskriving av
      // forrige, så duplikat-varselet (som er skrevet for last-wins-nøkler)
      // skal aldri fyre for den.
      if (key !== 'import' && Object.prototype.hasOwnProperty.call(res.tags, key)) {
        res.warnings.push({ line: i, msg: 'duplisert #tag-nøkkel: ' + key });
      }
      res.tags[key] = val;
      res.entries.push({ key: key, value: val, line: i });
    }
    return res;
  };

  // Kroppslinjene uten de konsumerte tag-linjene — delt av sniffing (her)
  // og renderContent (rendring). tagLines er kort (en håndfull), indexOf ok.
  function linesWithoutTags(source, tagLines) {
    var lines = String(source == null ? '' : source).split('\n');
    if (!tagLines || !tagLines.length) return lines;
    var keep = [];
    for (var i = 0; i < lines.length; i++) {
      if (tagLines.indexOf(i) === -1) keep.push(lines[i]);
    }
    return keep;
  }

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

  // Innholds-sniffing for UMERKEDE celler (spec §3): '<' som første tegn på
  // første ikke-blanke linje → html ('<' kan aldri starte gyldig python/r/
  // sql). ÉN trippel-sitert streng ALENE → md: '"""' i kolonne 0, FØRSTE
  // '"""' etter åpneren lukker (indexOf, ingen regex-backtracking), og alt
  // etter lukkeren må være blankt — docstring-vernet: '"""doc"""' fulgt av
  // kode sniffes aldri. Presedens: notebook_prose.py sin "bare streng alene
  // = prosa", løftet til celletyping. "'''" og \"""-escapes sniffes ikke
  // (dokumentert begrensning i spec).
  function sniffType(lines) {
    var first = -1;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].trim() !== '') { first = i; break; }
    }
    if (first !== -1 && /^\s*</.test(lines[first])) return 'html';
    return loneStringScan(lines) ? 'md' : null;
  }

  // Kjørbar cellekropp (spec §4): tag-linjene blankes PÅ PLASS (linjetall
  // bevares — executableSource-konvensjonen). Nødvendig, ikke kosmetisk:
  // '#' er ikke kommentar i duckdb-SQL og er direktiv-prefiks i microdata —
  // tag-linjer må aldri nå motorene.
  C.execCellSource = function (cell) {
    if (!cell) return '';
    if (!cell.tagLines || !cell.tagLines.length) return cell.source;
    var lines = cell.source.split('\n');
    for (var i = 0; i < cell.tagLines.length; i++) lines[cell.tagLines[i]] = '';
    return lines.join('\n');
  };

  // Render-innhold (spec §4): kropp minus tag-linjer; sniffet md-celle →
  // teksten MELLOM '"""'-delimiterne (én ledende/avsluttende blank linje
  // trimmes). Kildenivå (ikke cellenivå) med vilje: blur-forhåndsvisningen
  // i cellNode rendrer den LEVENDE textarea-verdien, ikke cellens kilde.
  // Faller tilbake til den tag-strippede kroppen hvis lone-string-mønsteret
  // ikke lenger holder etter redigering (typen er låst til re-parse uansett).
  C.renderContent = function (source, type, sniffed) {
    var scan = C.scanTagBlock(source, false);
    var kept = linesWithoutTags(source, scan.tagLines);
    var out = kept.join('\n');
    if (type === 'md' && sniffed === 'md') {
      var scan2 = loneStringScan(kept);
      if (scan2) out = scan2.rest.slice(0, scan2.close).replace(/^\n/, '').replace(/\n$/, '');
    }
    return out;
  };

  // Parse hele dokumentet → { cells, warnings }.
  // Celle: { type, attrs, tags, tagLines, sniffed, headerRaw, headerLine, startLine, endLine, source, hasBody }
  //  - headerRaw === null: implisitt preambel (tekst før første markør)
  //  - source: linjene ETTER headeren t.o.m. linjen før neste markør
  //  - hasBody: om cellen hadde minst én kildelinje (skiller '#%% r' fra '#%% r\n')
  //  - tags: objekt med samla #tag-direktiver (type og attributter)
  //  - tagLines: null-baserte kroppslinjer som inneholder #tag-linjer
  //  - sniffed: 'md', 'html', eller null — innholds-sniffet type for umerkede celler
  //  - type, attrs: effektive (mergede) verdier: header > tag > sniff > preambel-default
  C.parseCells = function (text) {
    var lines = String(text == null ? '' : text).split('\n');
    var cells = [], warnings = [], ids = {};
    var cur = null;
    function close(endLine) {
      if (!cur) return;
      cur.endLine = endLine;
      var bodyStart = cur.headerRaw === null ? cur.startLine : cur.startLine + 1;
      cur.hasBody = endLine >= bodyStart;
      cur.source = cur.hasBody ? lines.slice(bodyStart, endLine + 1).join('\n') : '';
      cells.push(cur);
      cur = null;
    }
    for (var i = 0; i < lines.length; i++) {
      if (MARKER_RE.test(lines[i])) {
        close(i - 1);
        var h = C.parseHeader(lines[i]);
        for (var w = 0; w < h.warnings.length; w++) warnings.push('linje ' + (i + 1) + ': ' + h.warnings[w]);
        cur = { type: h.type, attrs: h.attrs, headerRaw: lines[i], headerLine: i,
                startLine: i, endLine: -1, source: '', hasBody: false };
        if (h.attrs.id) {
          if (ids[h.attrs.id] !== undefined) warnings.push('linje ' + (i + 1) + ': duplisert id: ' + h.attrs.id);
          ids[h.attrs.id] = cells.length; // sist vinner
        }
      } else if (!cur) {
        cur = { type: null, attrs: {}, headerRaw: null, headerLine: -1,
                startLine: i, endLine: -1, source: '', hasBody: false };
      }
    }
    close(lines.length - 1);
    // --- #tag-direktiver: merge, sniffing, preambel-defaults (spec §1-§3).
    // Kjøres som post-pass over ferdiglukkede celler: presedens
    // header-attr > celle-tag > (kun type: sniff) > preambel-default.
    // Merge baker effektive attrs/type inn i celleobjektet — round-trip
    // røres ikke (serialisering bruker headerRaw + source, aldri attrs).
    var defaults = { type: null, attrs: {} };
    // Markørløse dokumenter (plain-skript) har ingen konsument som viser
    // parseCells sine warnings — deres implisitte preambel skannes likevel
    // for tags (cell.tags/scanTagBlock er lastbærende, f.eks. #tag.import),
    // men VARSLENE fra det skannet skal ikke samles opp i tomrommet.
    // Beregnes ÉN gang (ikke per celle — hasMarkers er dokumentnivå).
    var collectTagWarnings = C.hasMarkers(text);
    for (var ci = 0; ci < cells.length; ci++) {
      var cell = cells[ci];
      var isPre = cell.headerRaw === null;
      var scan = C.scanTagBlock(cell.source, isPre);
      cell.tags = scan.tags;
      cell.tagLines = scan.tagLines;
      cell.sniffed = null;
      var bodyBase = isPre ? cell.startLine : cell.startLine + 1;
      for (var wi = 0; wi < scan.warnings.length; wi++) {
        if (!collectTagWarnings) break;
        warnings.push('linje ' + (bodyBase + scan.warnings[wi].line + 1) + ': ' + scan.warnings[wi].msg);
      }
      if (isPre) {
        // Preambelens tags er DOKUMENT-defaults (spec §2): type = default
        // CELLE-type (retyper aldri preambelen selv), øvrige nøkler =
        // attr-defaults. id er alt avvist av skanneren i preambel-modus.
        // 'import' er PREAMBEL-ONLY — må IKKE bli en default-attributt
        // (ville blitt satt på ALLE celler, og motsier celleblokk-guardet som
        // eksplisitt dropper det der).
        for (var pk in scan.tags) {
          if (pk === 'type') defaults.type = scan.tags[pk];
          else if (pk !== 'import') defaults.attrs[pk] = scan.tags[pk];
        }
        continue;
      }
      // Siste forekomst per nøkkel styrer mergen (skanneren har alt varslet
      // duplikater) — entries-løkka under må derfor dedupliseres først, så
      // en tidligere forekomst ikke utløser et falskt overstyrt-varsel.
      var lastEnt = {};
      for (var ei = 0; ei < scan.entries.length; ei++) lastEnt[scan.entries[ei].key] = scan.entries[ei];
      for (var mk in lastEnt) {
        var ent = lastEnt[mk];
        var lineNo = bodyBase + ent.line + 1;
        if (mk === 'type') {
          if (cell.type !== null) warnings.push('linje ' + lineNo + ': #tag.type overstyrt av #%%-typen');
          else cell.type = ent.value;
          continue;
        }
        // ui-html-fasen (Task 4, spec §4): '#tag.import' er et DOKUMENT-
        // (preambel-)konsept, ikke en celle-attributt — en forekomst i en
        // celleblokk varsles eksplisitt og droppes (ikke bakt inn i
        // cell.attrs, som ellers ville gjort den usynlig for konsumenten
        // i index.html, der KUN preambelen skannes for imports).
        if (mk === 'import') {
          warnings.push('linje ' + lineNo + ': #tag.import gjelder bare i preambelen');
          continue;
        }
        // Header-attributtet vinner alltid over #tag — sjekkes FØR duplikat-
        // id-registrering, ellers ville en avvist #tag.id (som aldri blir
        // cellens effektive id) likevel besette ids-mappet og utløse et
        // falskt duplisert-id-varsel på en senere celle som legitimt bruker
        // samme id.
        if (Object.prototype.hasOwnProperty.call(cell.attrs, mk)) {
          warnings.push('linje ' + lineNo + ': #tag.' + mk + ' overstyrt av #%%-attributt');
          continue;
        }
        // #tag.id dekkes av samme duplikat-id-varsel som header-id (linje
        // 314-317 over) — ids-mappet er delt, «sist vinner» gjelder likt.
        // Registreres først nå, når vi vet tag-iden faktisk anvendes.
        if (mk === 'id') {
          if (ids[ent.value] !== undefined && ids[ent.value] !== ci) {
            warnings.push('linje ' + lineNo + ': duplisert id: ' + ent.value);
          }
          ids[ent.value] = ci; // sist vinner — samme regel som header-id
        }
        cell.attrs[mk] = ent.value;
      }
      // Innholds-sniffing — kun helt umerkede celler (spec §3); sniff slår
      // preambel-defaulten (den finnes nettopp for å slå dokument-defaulten).
      if (cell.type === null && cell.hasBody) {
        cell.sniffed = sniffType(linesWithoutTags(cell.source, cell.tagLines));
        if (cell.sniffed) cell.type = cell.sniffed;
      }
      // Preambel-defaults — svakest presedens.
      if (cell.type === null && defaults.type) cell.type = defaults.type;
      for (var dk in defaults.attrs) {
        if (!Object.prototype.hasOwnProperty.call(cell.attrs, dk)) cell.attrs[dk] = defaults.attrs[dk];
      }
    }
    return { cells: cells, warnings: warnings };
  };

  // Én celles tekstblokk (header + body). Round-trip-garanti for uendrede celler.
  C.cellBlock = function (c) {
    if (c.headerRaw === null) return c.source;
    if (!c.hasBody && c.source === '') return c.headerRaw;
    return c.headerRaw + '\n' + c.source;
  };

  C.serializeCells = function (cells) {
    var out = [];
    for (var i = 0; i < cells.length; i++) out.push(C.cellBlock(cells[i]));
    return out.join('\n');
  };

  // ---------- presentasjon: slide-plan (spec 2026-07-16-presentation-design.md §1) ----------

  // Effektivt slide-nummer per celle: eget attrs.slide, ellers arvet fra
  // forrige celle ("unummererte celler følger forrige celles slide").
  // slide=N (heltall) = eksplisitt nummer; bare `slide`-flagget (boolean
  // true) og ikke-numeriske verdier = auto-nummer (høyeste sett så langt
  // + 1) — den ergonomiske «#%% md slide starter neste slide»-formen.
  // Tolerant: aldri varsler (layout-nivå, ikke parse-nivå). Gruppering er
  // PER NUMMER, ikke naboskap — slides er de distinkte numrene stigende
  // sortert; synligheten er per-celle-CSS (DOM-halvdelen), så ikke-
  // sammenhengende grupper koster ingenting og gir forfattere omstokkings-
  // makt. skip-celler deltar i arven (en '#%% skip slide=4'-grensemarkør
  // virker) men utelates fra cellIdxs (de rendrer ingenting — CSS skjuler
  // dem uansett i presentasjon). Ledende celler uten nummer (preambelen
  // inkludert) tilhører den FØRSTE eksplisitte sliden (1 når ingen finnes)
  // — «tittel-cellene før første nummer hører til første slide».
  C.slidePlan = function (cells) {
    var eff = [], cur = null, maxSeen = 0, i;
    for (i = 0; i < cells.length; i++) {
      var a = cells[i].attrs ? cells[i].attrs.slide : undefined;
      if (a !== undefined) {
        var n = a === true ? NaN : parseInt(a, 10);
        cur = isNaN(n) ? maxSeen + 1 : n;
      }
      if (cur !== null && cur > maxSeen) maxSeen = cur;
      eff.push(cur);
    }
    var first = null;
    for (i = 0; i < eff.length; i++) { if (eff[i] !== null) { first = eff[i]; break; } }
    if (first === null) first = 1;
    var nums = [];
    for (i = 0; i < eff.length; i++) {
      if (eff[i] === null) eff[i] = first;
      if (nums.indexOf(eff[i]) === -1) nums.push(eff[i]);
    }
    nums.sort(function (x, y) { return x - y; });
    var slides = [], byCell = [];
    for (i = 0; i < nums.length; i++) slides.push({ num: nums[i], cellIdxs: [] });
    for (i = 0; i < cells.length; i++) {
      var pos = nums.indexOf(eff[i]);
      byCell.push(pos);
      if (C.resolveType(cells[i], null) !== 'skip') slides[pos].cellIdxs.push(i);
    }
    return { slides: slides, byCell: byCell };
  };

  // ---------- editor-konvergens (spec 2026-07-17-editor-convergence-design.md) ----------

  // Markørlinje → celleindeks: cellen hvis [startLine, endLine] inneholder
  // linjen. #%%-linjen tilhører sin egen celle (startLine = headerLine).
  // -1 utenfor dokumentet / tom celleliste.
  C.cellAtLine = function (cells, line) {
    for (var i = 0; i < cells.length; i++) {
      if (line >= cells[i].startLine && line <= cells[i].endLine) return i;
    }
    return -1;
  };

  // Markørspenn (spec §4 "cursor-run/selection-run", plan 4b Task 2): [startLine,
  // endLine] → { idx } når HELE spennet ligger inni ÉN celles KROPP (header-
  // linjen selv teller ALDRI som kropp — en preambel har ingen header, så dens
  // kropp starter på startLine i stedet for startLine+1) OG cellen resolver til
  // en kjørbar (kode-)type; ellers { error }. En kroppslinje kan aldri tilhøre
  // to celler samtidig (parseCells sin close() gjør span-ene disjunkte — neste
  // celles header-linje ligger MELLOM to nabo-kroppers spenn), så "startLine og
  // endLine begge treffer en gyldig kropp, men ULIKE celler" er i seg selv
  // beviset for at seleksjonen krysser minst én header-linje ("spans two
  // cells" — task-brief). 'outside' dekker BÅDE "linje utenfor ethvert
  // celle-spenn" og "linje på en header-linje" (samme gren: header-linjer
  // inngår aldri i noe body-intervall her).
  C.selectionCellSpan = function (cells, startLine, endLine, docMode) {
    var startIdx = -1, endIdx = -1;
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      var bodyStart = c.headerRaw === null ? c.startLine : c.startLine + 1;
      var bodyEnd = c.endLine;
      if (startLine >= bodyStart && startLine <= bodyEnd) startIdx = i;
      if (endLine >= bodyStart && endLine <= bodyEnd) endIdx = i;
    }
    if (startIdx === -1 || endIdx === -1) return { error: 'outside' };
    if (startIdx !== endIdx) return { error: 'span' };
    var cell = cells[startIdx];
    var type = C.resolveType(cell, docMode);
    if (!C.isCodeType(type)) return { error: 'noncode' };
    return { idx: startIdx };
  };

  // Forsonings-porten (spec §1 render/update-policy): samme antall celler
  // med samme headerRaw-sekvens → oppdater på plass; ellers full rebuild.
  C.sameStructure = function (a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i].headerRaw !== b[i].headerRaw) return false;
    }
    return true;
  };

  // Språk → legacy segmentmarkør slik parseHybridScript i index.html forventer.
  // Verifisert i Task 6 mot matchHybridMarker (index.html ~6028-6037, case-
  // insensitiv) og normalizeBlockMarkers (~7437-7450): '## python' matcher
  // (pyodide|python|py) og gir kind:'pyodide'; '## r' → kind:'r';
  // '## duckdb' matcher (duckdb|duck|sql) → kind:'duckdb'; '## microdata'
  // matcher (microdata|micro) → kind:'microdata'. Stavemåtene under stemmer.
  var SEG_MARKER = { python: '## python', r: '## r', duckdb: '## duckdb',
                     microdata: '## microdata' };
  C.SEG_MARKER = SEG_MARKER;

  function blankLike(s) {
    return String(s).split('\n').map(function () { return ''; }).join('\n');
  }

  // Dokument → kjørbar tekst (spec §4 "Document → runnable text"):
  // kode-cellers header → '## lang', ikke-kode (md/html/skip) og språk uten
  // segmentstøtte blankes. Linjetall bevares eksakt. Tag-linjer blankes PÅ
  // PLASS i både preambel og kodeceller (execCellSource).
  C.executableSource = function (text, docMode) {
    if (!C.hasMarkers(text)) return String(text == null ? '' : text);
    var parsed = C.parseCells(text);
    var out = [];
    for (var i = 0; i < parsed.cells.length; i++) {
      var c = parsed.cells[i];
      if (c.headerRaw === null) { out.push(C.execCellSource(c)); continue; }   // preambel kjører med tags blanket
      var type = C.resolveType(c, docMode);
      var runnable = C.isCodeType(type) && !!SEG_MARKER[type];
      if (!runnable) { out.push(blankLike(C.cellBlock(c))); continue; }
      if (!c.hasBody && c.source === '') { out.push(SEG_MARKER[type]); continue; }
      out.push(SEG_MARKER[type] + '\n' + C.execCellSource(c));
    }
    return out.join('\n');
  };

  // Forventet segmentrekkefølge → celleindekser. Verifisert mot faktisk
  // kjøretidsatferd i Task 6: parseHybridScripts flush() DROPPER et segment
  // hvis bufferet trimmer til tomt (index.html ~6044-6047). executableSource
  // blanker HELE cellen (header + body) for enhver ikke-kjørbar celle —
  // eneste unntak er en ekte preambel (headerRaw === null), som kjøres
  // uendret. Dermed kan KUN en preambel med ikke-blankt innhold gi opphav
  // til et lederseament (segment 0); en ledende ikke-kjørbar CELLE (f.eks.
  // '#%% md' først, ingen preambel) blankes helt og gir INGEN egen segment —
  // motsatt av en tidligere antakelse her (se historikk/test-fiks Task 6).
  // Deretter ett segment per kjørbar celle. Blankede celler etter første
  // markør smelter (som blanke linjer) inn i forrige segment.
  C.segmentPlan = function (text, docMode) {
    var parsed = C.parseCells(text);
    var plan = [];
    var start = 0;
    if (parsed.cells.length && parsed.cells[0].headerRaw === null) {
      if (parsed.cells[0].source && parsed.cells[0].source.trim() !== '') plan.push(0);
      start = 1;
    }
    for (var i = start; i < parsed.cells.length; i++) {
      var c = parsed.cells[i];
      var type = C.resolveType(c, docMode);
      var runnable = c.headerRaw !== null && C.isCodeType(type) && !!SEG_MARKER[type];
      if (runnable) plan.push(i);
    }
    return plan;
  };

  // Celletype → runtime segment-kind slik matchHybridMarker/parseHybridScript
  // (index.html ~6039-6072) navngir dem: python→'pyodide', r→'r',
  // duckdb→'duckdb', microdata→'microdata'. Samme mapping som SEG_MARKER,
  // bare med kjøretidens kind-navn i stedet for legacy-markørteksten.
  var KIND_FOR_TYPE = { python: 'pyodide', r: 'r', duckdb: 'duckdb',
                        microdata: 'microdata',
                        brython: 'brython', micropython: 'micropython',
                        javascript: 'javascript' };
  C.KIND_FOR_TYPE = KIND_FOR_TYPE;

  // Ren avledning av "er denne cellen faktisk kjørbar" (review Minor 3):
  // kode-type OG en kjent runtime-kind i KIND_FOR_TYPE over (statx/md/html/
  // skip/duckdb/microdata uten mapping → false, samme "null → inert"-
  // prinsipp som paramLangForType bruker). ÉN kilde til sannhet delt av
  // C.runCell sin egen guard (se kommentaren der) OG index.html sin
  // ▶-synlighetssjekk (nbUpdateActiveCellFromCursor, tverr-IIFE) — uten
  // denne måtte begge steder holde en duplisert "isCodeType && kind"-sjekk
  // manuelt i synk.
  C.isRunnableType = function (type) { return C.isCodeType(type) && !!KIND_FOR_TYPE[type]; };

  // Celletype → #@param-språk (spec 2 W4, Task 2): python-familien (python +
  // aliasene pyodide/py normalisert til 'python' av resolveType, samt
  // brython/micropython som deler python-literal-syntaks: True/False,
  // enkelt-kvoterte strenger) skriver via formatLiteral(lang='python');
  // 'r' skriver TRUE/FALSE og støtter <- i tillegg til =. duckdb/microdata/
  // statx/md/html/skip har INGEN mapping her (null) — parse-gate per planens
  // Global Constraints ("microdata/duckdb cells: out of scope for W4"):
  // ParamForms.decorate hoppes bevisst over for disse celletypene, samme
  // "null → inert" prinsipp som KIND_FOR_TYPE bruker for ikke-kjørbare typer.
  var PARAM_LANG_FOR_TYPE = { python: 'python', brython: 'python', micropython: 'python', r: 'r',
                              javascript: 'javascript' };
  C.paramLangForType = function (type) { return PARAM_LANG_FOR_TYPE[type] || null; };

  // Juster planen mot de faktiske segment-kindene fra kjøretiden: hvis
  // leder-oppføringen (preambel) ble strippet bort før segmentering
  // (f.eks. #-direktivlinjer i microdata-modus), fjern den fra planen.
  // Returnerer justert plan, eller null når ingen 1:1-mapping finnes.
  C.alignPlan = function (plan, cells, docMode, segmentKinds) {
    function expectedKind(idx) {
      var c = cells[idx];
      if (!c) return null;
      var type = c.headerRaw === null ? docMode : C.resolveType(c, docMode);
      return KIND_FOR_TYPE[type] || null;
    }
    function kindsMatch(idxs) {
      if (idxs.length !== segmentKinds.length) return false;
      for (var i = 0; i < idxs.length; i++) {
        if (expectedKind(idxs[i]) !== segmentKinds[i]) return false;
      }
      return true;
    }
    if (kindsMatch(plan)) return plan;
    if (plan.length && cells[plan[0]] && cells[plan[0]].headerRaw === null &&
        kindsMatch(plan.slice(1))) {
      return plan.slice(1);
    }
    return null;
  };

  // ---------- skrittvis (forklar) celleavspilling (fase B2 Task 2) ----------

  // Rekkefølgen forklar skal spille av et notatbok-dokument i: kjørbare
  // kode-celler (SAMME kjørbarhets-gate som segmentPlan bruker for Kjør
  // alle — gjenbrukt herfra, ALDRI duplisert) blir kjør-og-tal-steg, md-
  // celler blir tale-only-steg, i DOKUMENT-rekkefølge. Skip/html/ikke-
  // kjørbare kodetyper (brython/micropython/statx m.fl. uten SEG_MARKER,
  // eller en celletype som ikke matcher docMode sin kjøretid) er HELT
  // utelatt — verken kjørt eller lest opp (task-2-brief: "skip cells and
  // blanked/non-runnable types are skipped entirely"). En ikke-kjørbar
  // (blank) preambel gir intet steg — speiler segmentPlan sin egen
  // preambel-betingelse. index.html vet ingenting om cellemodellen her:
  // den bygger bare selve tale/kode-blokkene (kommentar-konvensjonen,
  // markdown-narrasjon) ut fra {kind, source} denne funksjonen returnerer.
  // Sniffede md-celler blir narrasjon-steg automatisk og deres delimitere/tags
  // nå renderContent og når aldri TTS.
  C.forklarCellSteps = function (text, docMode) {
    var parsed = C.parseCells(text);
    var cells = parsed.cells;
    var codePlan = C.segmentPlan(text, docMode);
    var codeSet = {};
    for (var i = 0; i < codePlan.length; i++) codeSet[codePlan[i]] = true;
    var steps = [];
    for (var idx = 0; idx < cells.length; idx++) {
      if (codeSet[idx]) {
        // cellType følger med steget (Task 7) slik at forklar-eksekutoren
        // kan oppdage fremmede celler (annet språk enn docMode) og hoppe
        // dem ærlig over i stedet for å kjøre dem i feil motor.
        steps.push({
          kind: 'code', cellIdx: idx,
          cellType: C.resolveType(cells[idx], docMode),
          source: C.execCellSource(cells[idx])
        });
        continue;
      }
      var c = cells[idx];
      if (c.headerRaw === null) continue; // ikke-kjørbar preambel — intet steg
      if (C.resolveType(c, docMode) === 'md') {
        steps.push({ kind: 'md', cellIdx: idx, source: C.renderContent(c.source, 'md', c.sniffed) });
      }
      // skip / html / ikke-kjørbare kodetyper: verken kjørt eller lest opp
    }
    return steps;
  };

  // md-celletekst → tale-tekst: rimelig markdown-stripping for TTS (IKKE en
  // full renderer — målet er lesbar tale, ikke korrekt syntaks-gjenkjenning).
  // Rekkefølgen er bevisst: kodegjerder/inline-kode FØR generisk tag-
  // fjerning; bilder FØR lenker FØR emphasis (så '![alt](url)' og
  // '[tekst](url)' ikke feiltolkes som stjerne-emphasis via '*' i url-en);
  // '***' FØR '**' FØR '*' (samme grunn — grådig lengste-match-rekkefølge
  // unngår at et trippel-par bare mister ett lag). Linjeskift kollapses til
  // mellomrom (TTS leser løpende tekst, ikke avsnitts-struktur).
  C.mdNarrationText = function (src) {
    var s = String(src == null ? '' : src);
    s = s.replace(/```[^\n]*\n?/g, '');
    s = s.replace(/`([^`]+)`/g, '$1');
    s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, function (m, alt) { return alt || ''; });
    s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
    s = s.replace(/^\s{0,3}>\s?/gm, '');
    s = s.replace(/^\s*([-*+]|\d+[.)])\s+/gm, '');
    s = s.replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, '');
    s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
    s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
    s = s.replace(/\*([^*]+)\*/g, '$1');
    s = s.replace(/___([^_]+)___/g, '$1');
    s = s.replace(/__([^_]+)__/g, '$1');
    s = s.replace(/_([^_]+)_/g, '$1');
    s = s.replace(/<[^>]+>/g, '');
    s = s.split(/\n+/).map(function (l) { return l.trim(); }).filter(Boolean).join(' ');
    return s.replace(/\s+/g, ' ').trim();
  };

  // ---------- celle-verktøylinje: strukturelle teksttransformer (fase B2) ----------
  // Spec §1 "Serialization round-trip" tabellen sier hver operasjon ER en
  // teksttransform (sett inn/fjern/bytt/skriv om header-linjer). Alle seks
  // funksjonene under følger derfor SAMME oppskrift: bygg den TILTENKTE
  // teksten (via cellBlock/serializeCells-byggeklosser eller direkte
  // linjesplitting), kjør den gjennom parseCells på nytt, og returner DE
  // ferske celleobjektene derfra. Round-trip-garantien over
  // (serializeCells(parseCells(t).cells) === t, se cells.test.js) gjør at
  // "resultatets serialisering er den tiltenkte teksten"-kravet er oppfylt
  // AUTOMATISK — vi trenger aldri håndbygge celleobjekter med riktige
  // startLine/endLine/headerLine selv (kun parseCells vet hvordan).
  //
  // Konsistent returform for ALLE seks (task-brief: "decide a consistent
  // {cells, warnings} return"): { cells: Cell[], warnings: string[] }.
  // Ugyldig indeks/grense/preambel-forbudte operasjoner er no-op'er som
  // returnerer SAMME cells-referanse (===) + en forklarende advarsel, ALDRI
  // en kastet feil — samme "advarsel, ikke feil"-filosofi som parseHeader.

  // Kjenner igjen en type-token (case-insensitiv, aliaser) — samme regelsett
  // som parseHeader sin egen toks[0]-gjenkjenning, faktorisert ut hit fordi
  // insertCellAfter/changeCellType begge trenger den UTENFOR en hel
  // header-linje (kun selve typeteksten fra en dropdown, f.eks.).
  function normalizeType(tok) {
    if (tok == null) return null;
    var t0 = String(tok).toLowerCase();
    if (ALIASES[t0]) t0 = ALIASES[t0];
    return TYPES.indexOf(t0) !== -1 ? t0 : null;
  }
  C.normalizeType = normalizeType;

  // Sett inn en ny celle (header + tom kropp) rett etter cells[idx].
  // idx === -1 setter inn FØRST i dokumentet ("legg til over" den nåværende
  // første cellen). idx klemmes til [-1, cells.length-1] — en avvikende
  // indeks fra kalleren gir dermed fortsatt et fornuftig resultat (append)
  // i stedet for et no-op, i motsetning til de andre operasjonene: å SETTE
  // INN en celle har ingen "ugyldig posisjon" i seg selv, bare en klemmet en.
  C.insertCellAfter = function (cells, idx, type) {
    var warnings = [];
    var norm = normalizeType(type);
    if (type != null && norm === null) {
      warnings.push('ukjent celletype: ' + type + ' — bruker python');
    }
    var useType = norm || 'python';
    var i = idx;
    if (i < -1) i = -1;
    if (i > cells.length - 1) i = cells.length - 1;
    // Preambel-vern (B2-review, Critical): «sett inn FØRST» (i === -1) i et
    // dokument MED implisitt preambel ville splice den nye '#%% type'-
    // headeren FORAN preambel-teksten — ved re-parse blir preambelen
    // (typisk '# load'-/'#options.*'-linjer!) da KROPPEN til den nye cellen,
    // og dokumentet mister preambelen sin permanent. En preambel MÅ stå
    // først (samme filosofi som moveCell sitt preambel-vern over): «over
    // preambelen» er et meningsløst sted, så klem til rett ETTER den i
    // stedet.
    if (i === -1 && cells.length && cells[0].headerRaw === null) i = 0;
    var blocks = cells.map(C.cellBlock);
    // Header + ÉN blank kroppslinje (spec §1: "insert a #%% header (+ blank
    // line)") — se cellBlock/parseCells-samspillet: en trailing '\n' her gir
    // hasBody:true, source:'' etter re-parse (verifisert i testene).
    blocks.splice(i + 1, 0, '#%% ' + useType + '\n');
    var text = blocks.join('\n');
    var p = C.parseCells(text);
    return { cells: p.cells, warnings: warnings.concat(p.warnings) };
  };

  // Fjern cellens span (header + kropp) helt. Siste gjenværende celle i
  // dokumentet er et spesialtilfelle (brief: "delete last remaining cell
  // leaves one empty implicit cell") — vi VALGTE dette fremfor no-op, slik
  // at brukeren alltid kan tømme dokumentet helt via verktøylinjen; en tom
  // implisitt preambelcelle er uansett hva parseCells('') selv produserer.
  C.deleteCell = function (cells, idx) {
    if (idx < 0 || idx >= cells.length) {
      return { cells: cells, warnings: ['ugyldig celleindeks: ' + idx] };
    }
    if (cells.length === 1) {
      return { cells: C.parseCells('').cells, warnings: [] };
    }
    var blocks = cells.map(C.cellBlock);
    blocks.splice(idx, 1);
    var text = blocks.join('\n');
    var p = C.parseCells(text);
    return { cells: p.cells, warnings: p.warnings };
  };

  // Bytt cells[idx] med sin nabo i retning dir (-1 = opp, +1 = ned).
  // Grensetilfeller (første celle opp / siste celle ned) er no-op'er uten
  // advarsel — det er ikke en feiltilstand, bare "ingenting å gjøre" (samme
  // som en piltast mot kanten av en liste). Den underforståtte preambel-
  // cellen (headerRaw === null, alltid på plass 0, se parseCells) kan
  // derimot ALDRI flyttes og ALDRI byttes inn i: den har ingen header-linje
  // som markerer hvor kroppen dens begynner — et bytte ville gjort
  // preambelens rå tekst til KROPPEN til nabocellen sin header i stedet for
  // et eget dokument-nivå-element, og dermed korrumpert strukturen (se
  // task-1-brief "move at boundaries no-ops" + design-notatet i cells.test.js).
  C.moveCell = function (cells, idx, dir) {
    if (idx < 0 || idx >= cells.length) {
      return { cells: cells, warnings: ['ugyldig celleindeks: ' + idx] };
    }
    var j = idx + (dir < 0 ? -1 : 1);
    if (j < 0 || j >= cells.length) return { cells: cells, warnings: [] };
    if (cells[idx].headerRaw === null || cells[j].headerRaw === null) {
      return { cells: cells, warnings: ['kan ikke flytte eller bytte plass med den underforståtte preambel-cellen'] };
    }
    var blocks = cells.map(C.cellBlock);
    var tmp = blocks[idx]; blocks[idx] = blocks[j]; blocks[j] = tmp;
    var text = blocks.join('\n');
    var p = C.parseCells(text);
    return { cells: p.cells, warnings: p.warnings };
  };

  // Skriv om KUN typetoken på cells[idx] sin header-linje — attrs (id=,
  // hide-code, style=, ...) bevares VERBATIM (task-brief: "rewrite header
  // line preserving attrs"). Fremgangsmåten: parseHeader() forteller oss OM
  // headerens første token ble tolket som en type (h.type !== null); i så
  // fall strippes NØYAKTIG den rå ledende token'en (+ mellomrommet etter)
  // fra header-resten via regex, og resten (attrs-delen, inkl. sitering)
  // står urørt. Fantes det ingen type-token i utgangspunktet (attrs-only
  // eller helt bar header), settes den nye typen inn FØRST i stedet.
  // Preambel-celler (headerRaw null) har ingen header å skrive om — no-op
  // + advarsel, som task-1-brief krever.
  C.changeCellType = function (cells, idx, newType) {
    if (idx < 0 || idx >= cells.length) {
      return { cells: cells, warnings: ['ugyldig celleindeks: ' + idx] };
    }
    var c = cells[idx];
    if (c.headerRaw === null) {
      return { cells: cells, warnings: ['kan ikke endre type på den underforståtte preambel-cellen'] };
    }
    var norm = normalizeType(newType);
    if (!norm) {
      return { cells: cells, warnings: ['ukjent celletype: ' + newType] };
    }
    var h = C.parseHeader(c.headerRaw);
    var m = MARKER_RE.exec(c.headerRaw);
    var rest = (m && m[1]) || '';
    var remainder = h.type !== null ? rest.replace(/^\s*\S+\s*/, '') : rest;
    var newHeaderRaw = remainder ? ('#%% ' + norm + ' ' + remainder) : ('#%% ' + norm);
    var blocks = cells.map(C.cellBlock);
    blocks[idx] = C.cellBlock({ headerRaw: newHeaderRaw, hasBody: c.hasBody, source: c.source });
    var text = blocks.join('\n');
    var p = C.parseCells(text);
    return { cells: p.cells, warnings: p.warnings };
  };

  // Del cells[idx] sin kilde i to celler ved lineOffset (0-indeksert linje
  // INNE i cellens KILDE — dvs. antall '\n' før markøren, slik en textareas
  // selectionStart→linje-utregning gir). Linjer [0, lineOffset) blir
  // værende i den OPPRINNELIGE cellen (header uendret); linjer
  // [lineOffset, n) flyttes til en NY celle rett etter, med SAMME type som
  // originalen (c.type — ikke resolveType mot docMode, som ikke er kjent
  // her: en implisitt/typeløs original gir en like typeløs ny celle, som
  // arver dokumentmodus akkurat som originalen gjorde). lineOffset 0 (ingen
  // linjer før markøren) eller lineOffset >= n ("forbi slutten", ingenting å
  // flytte ut) er begge no-op'er (task-1-brief). En celle uten kropp har
  // n=0, så ENHVER offset der er automatisk "forbi slutten".
  C.splitCell = function (cells, idx, lineOffset) {
    if (idx < 0 || idx >= cells.length) {
      return { cells: cells, warnings: ['ugyldig celleindeks: ' + idx] };
    }
    var c = cells[idx];
    var lines = c.hasBody ? String(c.source).split('\n') : [];
    var n = lines.length;
    if (lineOffset <= 0 || lineOffset >= n) return { cells: cells, warnings: [] };
    var firstSrc = lines.slice(0, lineOffset).join('\n');
    var restSrc = lines.slice(lineOffset).join('\n');
    var newHeaderRaw = c.type ? ('#%% ' + c.type) : '#%%';
    var blocks = cells.map(C.cellBlock);
    blocks[idx] = C.cellBlock({ headerRaw: c.headerRaw, hasBody: true, source: firstSrc });
    blocks.splice(idx + 1, 0, C.cellBlock({ headerRaw: newHeaderRaw, hasBody: true, source: restSrc }));
    var text = blocks.join('\n');
    var p = C.parseCells(text);
    return { cells: p.cells, warnings: p.warnings };
  };

  // Slå sammen cells[idx] med cellen FØR den (spec §1: "merge with previous |
  // delete this cell's header line") — vi bygger derfor den fulle
  // dokumentteksten (serializeCells, samme byggeklosser som resten av denne
  // seksjonen) og fjerner NØYAKTIG cur sin header-linje (cur.headerLine,
  // ferske og korrekte fordi `cells` alltid kommer fra en nylig re-parse —
  // enten den opprinnelige render()-parsen eller resultatet av en tidligere
  // toolbar-operasjon). Å slette header-linjen fjerner grensen mellom de to
  // cellene, så prev sin kropp og cur sin kropp smelter sammen til ÉTT
  // sammenhengende span ved re-parse — ingen håndrullet kombineringslogikk
  // trengs (fungerer likt uansett om prev er en ekte celle ELLER selve den
  // underforståtte preambelen). Første celle (idx <= 0, ingen forrige å slå
  // sammen med) er en grense-no-op + advarsel — dette dekker AUTOMATISK
  // "preambel kan ikke slås sammen med forrige" fra task-1-brief, siden
  // preambelen (headerRaw null) alltid er nøyaktig cells[0].
  C.mergeWithPrevious = function (cells, idx) {
    if (idx <= 0 || idx >= cells.length) {
      return { cells: cells, warnings: ['ingen forrige celle å slå sammen med: ' + idx] };
    }
    var cur = cells[idx];
    var text = C.serializeCells(cells);
    var lines = text.split('\n');
    lines.splice(cur.headerLine, 1);
    var newText = lines.join('\n');
    var p = C.parseCells(newText);
    return { cells: p.cells, warnings: p.warnings };
  };

  // ---------- DOM-halvdel (kun browser) ----------
  if (typeof document !== 'undefined') (function () {
    var t = typeof global.t === 'function' ? global.t : function (s) { return s; };
    var NB = { root: null, cells: [], docMode: 'python', layout: 'columns',
               activeFlag: false, lastSerialized: null,
               plan: [], runSinks: null, runPlan: null, trailing: null, chip: null,
               tickHandle: null, lastUserInput: 0,
               lastTickValue: null, lastTickTime: 0, htmlTrusted: true,
               // Fase B1 Task 5: per-celle kjøring — "endret siden sist kjørt"
               // (stale) og "har kjørt OK minst én gang" (ranOk), keyet på
               // celleindeks. Sesjonschip/Restart-knapp (NB.sessionChip/
               // NB.restartBtn) og deres onStateChange-abonnement er fjernet
               // (Hans' avgjørelse 2026-07-17, se docBar): doc-baren viser nå
               // kun parse-varsler.
               stale: {}, ranOk: {},
               // Editor-konvergens (plan 4b Task 3): markør↔slot-koblingens
               // "hvilken celle er aktiv" — satt av C.setActiveCell (index.html
               // sin cursor-tracker kaller denne), lest av applyActiveCellClass
               // for å reapplisere .doc-active etter en docRender-rebygging
               // (nye DOM-noder — se applyActiveCellClass sin egen kommentar).
               activeCellIdx: null };

    function $(id) { return document.getElementById(id); }
    function el(tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }
    function purge(node) { if (typeof global.purgePlots === 'function') global.purgePlots(node); }

    C.active = function () { return NB.activeFlag; };
    C.setDocMode = function (mode) {
      NB.docMode = mode;
      if (NB.activeFlag && !C.supportedMode(mode)) C.exit();
    };

    // Kalles etter programmatiske editor-oppdateringer som IKKE skal
    // auto-åpne notatboken (modusbytte-gjenoppretting): resynk tick-basislinjen.
    C.syncTickBaseline = function () {
      var ta = $('scriptInput');
      NB.lastTickValue = ta ? ta.value : null;
      NB.lastTickTime = Date.now();
    };

    // Eksplisitt signal fra innlastingsstedene (eksempler, share/GitHub):
    // nytt dokument er lastet → auto-åpne notatboken hvis dokumentet er en,
    // uavhengig av tick-heuristikken.
    // opts.untrusted === true (share-lenker, GitHub-filer, dyplenker — alt
    // eksternt): html-celler rendres eskapert til brukeren godtar dem (Vis HTML
    // / Kjør), så attributt-baserte hendelseshandlere ikke kjører ved lasting.
    // Uten flagget (lokalt/eksempler i repoen) er dokumentet brukerens eget og
    // fullt betrodd. Nytt dokument erstatter forrige tillitstilstand.
    C.contentLoaded = function (opts) {
      // Nytt dokument → gammel sesjon er ugyldig (final-review F1): en celle
      // kjørt i dokument B skal aldri kunne gjenbruke e/_g/loads fra
      // dokument A. Må kalles FØR render()/exit() under, ellers rekker en
      // per-celle-kjøring å starte mot den gamle sesjonen først.
      if (global.mdNotebookSession) global.mdNotebookSession.invalidate();
      // Ui-verdilageret (Task 3) er også dokument-scoped: et nytt dokument må
      // glemme forrige dokuments kontrollverdier/strips, akkurat som pyodide-
      // sesjonen over. Ui er ikke nødvendigvis lastet ennå (lazy, kun ved
      // "import ui") — dobbelt-guardet, speiler stilen resten av fila bruker
      // for globaler som kan mangle i stub-DOM-testene.
      if (global.Ui && global.Ui.resetDocument) global.Ui.resetDocument();
      // ipywidgets-broen (spec 2 W3, Task 2) er også dokument-scoped: nytt
      // dokument → glem forrige dokuments widget-modeller/comm-register
      // (js/ipywidgets-bridge.js). mdNotebookSession.invalidate() over gjør
      // også dette (belte-og-bukser: reset() er idempotent), men speilingen
      // her følger Ui.resetDocument-presedensen — samme dobbelt-guard for
      // stub-DOM-tester der globalen kan mangle.
      if (global.IpwBridge && global.IpwBridge.reset) global.IpwBridge.reset();
      // #@param-skjemaene (spec 2 W4, Task 2) er også dokument-scoped: et nytt
      // dokument må glemme forrige dokuments skjema-tilstand (cellEl-
      // referanser til nå-orphanede noder) OG kansellere evt. ventende
      // run:auto-debounce-timere — uten dette kunne en gammel 150ms-timer fra
      // det FORRIGE dokumentet fyre etter at et nytt dokument er lastet og
      // (hvis samme celleindeks tilfeldigvis finnes der òg) kjøre feil celle.
      if (global.ParamForms && global.ParamForms.resetDocument) global.ParamForms.resetDocument();
      // Nytt dokument → presentasjonen avsluttes (samme invalidering som
      // sesjonen over; presentasjon overlever aldri dokument-/modusbytte).
      C.presentExit();
      NB.htmlTrusted = !(opts && opts.untrusted === true);
      var ta = $('scriptInput');
      if (!ta) return;
      if (NB.activeFlag) { if (C.hasMarkers(ta.value)) docRender(); else C.exit(); }
      else if (C.hasMarkers(ta.value) && C.supportedMode(NB.docMode)) { C.enter(appLayout()); }
      else { updateChip(); }
      // #options.view = present (spec §3): delte lenker/eksempler/GitHub-
      // filer åpner rett i presentasjon. Kun her (dokumentlasting) — vanlig
      // redigering trigger aldri auto-start. Trygt for utrygt opphav:
      // presentasjon KJØRER ingenting, og html-celler beholder trust-gaten.
      if (NB.activeFlag && ta &&
          /^\s*(?:#|\/\/)\s*options\.view\s*=\s*["']?present["']?\s*$/mi.test(ta.value)) {
        C.presentStart();
      }
      C.syncTickBaseline();
    };

    C.init = function (docMode) {
      NB.docMode = docMode;
      var ta = $('scriptInput');
      if (!NB.tickHandle) {
        NB.tickHandle = setInterval(tick, 1000);
        // Spor aktiv skriving separat fra programmatiske .value-endringer
        // (delt av tick(), se der).
        if (ta) ta.addEventListener('input', function () { NB.lastUserInput = Date.now(); });
        // Startpunkt for per-tikk-attribusjon: en endring som lander mellom
        // init og første tikk (f.eks. share-lenke på 'load') må regnes som
        // programmatisk, ikke som skriving.
        NB.lastTickValue = ta ? ta.value : null;
        NB.lastTickTime = Date.now();
      }
      if (ta && C.supportedMode(docMode) && C.hasMarkers(ta.value)) C.enter(appLayout());
    };

    function appLayout() {
      if (global.mdIsInputHidden && global.mdIsInputHidden()) return 'output';
      if (global.mdIsStackedLayout && global.mdIsStackedLayout()) return 'stacked';
      return 'columns';
    }

    // 4a (spec 2026-07-17 §1): .container-swappen er død — dokumentet
    // rendres INN I #outputArea (docRender/docHost under), .container
    // beholder sine vanlige layoutklasser og blir ALDRI nb-hidden.
    C.enter = function (layout) {
      var ta = $('scriptInput');
      if (!ta || !C.supportedMode(NB.docMode) || !C.hasMarkers(ta.value)) return false;
      if (!docHost()) return false;
      NB.activeFlag = true;
      if (layout) NB.layout = layout;
      docRender();
      updateChip();
      return true;
    };

    C.exit = function () {
      C.presentExit();
      NB.activeFlag = false;
      // Markør↔slot-kobling (plan 4b Task 3): en inaktiv notatbok har ingen
      // aktiv celle — NB.root fjernes rett under uansett (klassen forsvinner
      // med noden), men NB.activeCellIdx-TILSTANDEN må også nullstilles, slik
      // at en senere re-inngang (docRender/enter) ikke reapplisérer .doc-active
      // mot en indeks som hørte til et helt annet dokument-øyeblikk.
      NB.activeCellIdx = null;
      // 4a: doc-root fjernes fra #outputArea (gjenoppretter tom output-
      // flate for påfølgende vanlig skript-kjøring) — ingen container-
      // klasse å reversere lenger, og ingen layout-speiling tilbake til
      // app-primitivene (layouten ble aldri endret av docRender/enter,
      // se spec §1 — den mirroring-back-compat-koden hørte til den gamle
      // .container-swappen og er død sammen med den).
      if (NB.root) { purge(NB.root); NB.root.remove(); NB.root = null; }
      if (global.updateLineNumbers) global.updateLineNumbers();
      if (global.refreshPlotlyAfterLayout) global.refreshPlotlyAfterLayout();
      updateChip();
    };

    // 4a (spec 2026-07-17 §2): tynn delegat — det konvergerte dokumentet har
    // ingen egen notatbok-layout lenger (ingen .nb-input-halvdel å legge i
    // kolonner/stables mot, se docCellNode), så "layout" betyr nå det samme
    // for et notatbok-aktivt dokument som for et vanlig skript: appens egne
    // primitiver (mdSetLayoutMode/mdSetInputHidden på .container). NB.layout
    // oppdateres her, men er IKKE kilden presentStart leser prevLayout fra —
    // visningsmenyens "Kun output"/"Stables" bruker mdSetInputHidden/
    // mdSetLayoutMode direkte (meny-bypass) uten om denne funksjonen, så
    // NB.layout kan være stale ved presentStart-tidspunktet. appLayout()
    // (live avlesning av app-primitivene) er den faktiske kilden, se
    // C.presentStart under. Dobbelt-guardet — globalene kan mangle i
    // stub-DOM-testene, samme mønster som resten av fila.
    C.setLayout = function (layout) {
      NB.layout = layout;
      if (layout === 'output') {
        if (global.mdSetInputHidden) global.mdSetInputHidden(true);
      } else {
        if (global.mdSetInputHidden) global.mdSetInputHidden(false);
        if (global.mdSetLayoutMode) global.mdSetLayoutMode(layout === 'stacked' ? 'stacked' : 'columns');
      }
    };

    // ---------- presentasjon (spec 2026-07-16-presentation-design.md §2,
    //            re-hostet på det konvergerte dokumentet i 4a §3) ----------
    // Layout-TILSTAND over samme rendrede dokument: ingen DOM-flytting —
    // synlighet per celle via .nb-slide-hidden. Editor-halvdelen (redigerings-
    // ruta/panel-left, #resizer) finnes ikke lenger INNI dokumentet (den
    // konvergerte doc-root har ingen .nb-input) — den skjules i stedet av
    // body.present-active .panel-left/#resizer (app.css), satt/fjernet av
    // presentStart/presentExit under. Widgets/plots blir stående i
    // cellene sine og lever videre på sin slide. Stub-DOM-forbehold:
    // document.body/addEventListener kan mangle i test-harnesset — samme
    // dobbelt-guard som resten av fila bruker for globaler.

    function presentApply() {
      var P = NB.present;
      if (!P || !NB.root) return;
      for (var i = 0; i < NB.cells.length; i++) {
        var c = NB.cells[i];
        if (c && c._wrap) c._wrap.classList.toggle('nb-slide-hidden', P.byCell[i] !== P.cur);
      }
      // Samle-sloten (planavvik-fallback) hører til siste slide.
      if (NB.trailing) NB.trailing.classList.toggle('nb-slide-hidden', P.cur !== P.slides.length - 1);
      if (P.counter) P.counter.textContent = (P.cur + 1) + ' / ' + P.slides.length;
    }

    function presentNav(delta) {
      var P = NB.present;
      if (!P) return;
      var next = Math.min(P.slides.length - 1, Math.max(0, P.cur + delta));
      if (next === P.cur) return;
      P.cur = next;
      presentApply();
      if (NB.root) NB.root.scrollTop = 0;
    }

    // Piler/Esc — kun installert mens presentasjonen er aktiv. Skjemafelt
    // (widgets på sliden) beholder tastene sine; eksisterende Esc-handlere
    // er overlay-scopet og sameksisterer. Eksportert (_-prefiks) for
    // stub-DOM-testene, som mangler document.addEventListener.
    function presentKeydown(ev) {
      if (!NB.present) return;
      var tgt = ev.target;
      var tag = tgt && tgt.tagName ? String(tgt.tagName).toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || (tgt && tgt.isContentEditable)) return;
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown' || ev.key === 'PageDown' || ev.key === ' ') {
        ev.preventDefault(); presentNav(1);
      } else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' || ev.key === 'PageUp') {
        ev.preventDefault(); presentNav(-1);
      } else if (ev.key === 'Escape') {
        ev.preventDefault(); C.presentExit();
      }
    }
    C._presentKeydown = presentKeydown;

    function presentBuildNav() {
      var P = NB.present;
      if (!P || !NB.root) return;
      var prev = el('button', 'nb-present-nav nb-present-prev', '‹');
      prev.type = 'button'; prev.title = t('Forrige slide');
      prev.addEventListener('click', function () { presentNav(-1); });
      var next = el('button', 'nb-present-nav nb-present-next', '›');
      next.type = 'button'; next.title = t('Neste slide');
      next.addEventListener('click', function () { presentNav(1); });
      var counter = el('span', 'nb-present-counter');
      P.counter = counter;
      P.navEls = [prev, next, counter];
      NB.root.appendChild(prev); NB.root.appendChild(next); NB.root.appendChild(counter);
    }

    C.presenting = function () { return !!NB.present; };

    C.presentStart = function () {
      if (!NB.activeFlag || !NB.root) return false;
      if (NB.present) return true;                       // idempotent
      var plan = C.slidePlan(NB.cells);
      var hasVisible = plan.slides.some(function (s) { return s.cellIdxs.length > 0; });
      if (!plan.slides.length || !hasVisible) return false;
      // prevLayout fanges fra LIVE app-tilstand (appLayout()), ikke NB.layout:
      // visningsmenyens direkte primitiv-kall (mdSetInputHidden/
      // mdSetLayoutMode) er en meny-bypass som ikke oppdaterer NB.layout, så
      // NB.layout kan være stale her (f.eks. fortsatt 'columns' fra dokument-
      // lastingstidspunktet selv om brukeren siden valgte «Kun output» via
      // menyen). presentExit sin C.setLayout(prevLayout) re-synker NB.layout
      // ved avslutning, så ingenting ekstra trengs her.
      NB.present = { slides: plan.slides, byCell: plan.byCell, cur: 0,
                     prevLayout: appLayout(), counter: null, navEls: [] };
      NB.root.classList.add('nb-present');
      if (document.body && document.body.classList) document.body.classList.add('present-active');
      presentBuildNav();
      presentApply();
      if (document.addEventListener) document.addEventListener('keydown', presentKeydown);
      if (global.mdSyncViewDropdown) global.mdSyncViewDropdown('present');
      if (global.refreshPlotlyAfterLayout) global.refreshPlotlyAfterLayout();
      return true;
    };

    C.presentExit = function () {
      if (!NB.present) return;
      var P = NB.present;
      NB.present = null;
      if (document.removeEventListener) document.removeEventListener('keydown', presentKeydown);
      if (document.body && document.body.classList) document.body.classList.remove('present-active');
      if (NB.root) {
        NB.root.classList.remove('nb-present');
        for (var i = 0; i < P.navEls.length; i++) { if (P.navEls[i] && P.navEls[i].remove) P.navEls[i].remove(); }
        for (var j = 0; j < NB.cells.length; j++) {
          var c = NB.cells[j];
          if (c && c._wrap) c._wrap.classList.remove('nb-slide-hidden');
        }
        if (NB.trailing) NB.trailing.classList.remove('nb-slide-hidden');
      }
      // Gjenopprett layouten fra før presentasjonen — setLayout (4a: tynn
      // delegat til mdSetLayoutMode/mdSetInputHidden) driver app-
      // primitivene direkte, samme vei som visningsmenyen selv bruker.
      C.setLayout(P.prevLayout || 'columns');
      if (global.mdSyncViewDropdown) {
        global.mdSyncViewDropdown(P.prevLayout === 'output' ? 'output' : (P.prevLayout || 'columns'));
      }
    };

    // ---------- konvergert dokument (spec 2026-07-17 §1) ----------
    // Dokumentet rendres INN I #outputArea (doc-root); .container beholder
    // sine layoutklasser (nb-hidden-swappen er død). Slots beholder
    // .nb-cell/.nb-output/.nb-output-body-klassene med vilje: ParamForms/
    // Ui/ipywidgets finner vertene sine uendret via cellElementAt.

    function docHost() { return document.getElementById('outputArea'); }

    // Doc-baren viser NÅ KUN parse-varsler (Hans' avgjørelse 2026-07-17):
    // sesjonschippen («python ● aktiv») og «Restart & kjør alle»-knappen er
    // fjernet — bunnlinjas motus-dropdown viser allerede kjøretids-språket,
    // og «Kjør» ER NÅ restart-og-kjør-alle i alle modi. pyodide-familien
    // (python/duckdb/microdata) bootet allerede en fersk sesjon per Kjør alle
    // (index.html btnRun → bootNotebookSession, uendret). R- og motor-
    // notatbøker (brython/micropython) kaller nå window.mdNotebookSession.
    // restart() (index.html) FØR sin egen kjøreløkke — akkurat samme kall den
    // gamle Restart-knappen gjorde her i cells.js (onRestartClick, nå
    // fjernet); restart()-funksjonen selv (index.html) er UENDRET, kun
    // KALLESTEDET flyttet dit motene sine egne "Kjør alle"-løkker allerede
    // lever (modeRegistry.r.runSelf / btnRun sin engineNbRunActive-gren).
    //
    // Create-on-demand (valgt fremfor "alltid bygg baren, skjul med CSS når
    // tom"): en tom .doc-bar hadde uansett null synlig innhold og null CSS-
    // rolle nå som chip/knapp er borte — å aldri sette den inn i DOM-en når
    // parsed.warnings er tomt er det enkleste som oppfyller kontrakten
    // ("kun appendes når parsed.warnings.length > 0") uten en ekstra display:
    // none-regel å holde synkron. docBar() og updateWarnings() (kalt fra
    // docReconcile sin in-place-gren, Task 3-review-funn 4) deler denne ene
    // bygge-funksjonen slik at begge veier setter NB.docBarEl/NB.warningsEl
    // identisk.
    function docBar(warnings) {
      var bar = el('div', 'doc-bar');
      NB.docBarEl = bar;
      NB.warningsEl = el('span', 'nb-warnings', warnings.join(' · '));
      bar.appendChild(NB.warningsEl);
      return bar;
    }

    // Doc-bar-varsler holdes ferske gjennom en forsoning (Task 3-review-funn
    // 4, Minor): docReconcile sin in-place-gren rørte tidligere ALDRI baren —
    // en kroppsredigering som endret et #tag-varsel (duplisert nøkkel,
    // ugyldig verdi, …) uten å røre strukturen lot baren stå med et foreldet
    // varselsett helt til neste strukturendring eller eksplisitt docRender().
    // Nå som baren KUN finnes når det er noe å varsle om (create-on-demand,
    // se docBar over), må denne funksjonen også opprette/fjerne selve
    // .doc-bar-noden (ikke bare varsel-spanet inni den): tomt → ikke-tomt
    // setter inn en fersk bar som NB.root sitt FØRSTE barn (samme plassering
    // som docRender selv bruker); ikke-tomt → tomt fjerner hele baren; begge
    // ikke-tomme oppdaterer kun teksten på plass.
    function updateWarnings(warnings) {
      if (!warnings.length) {
        if (NB.docBarEl) { NB.docBarEl.remove(); NB.docBarEl = null; NB.warningsEl = null; }
        return;
      }
      if (NB.warningsEl) { NB.warningsEl.textContent = warnings.join(' · '); return; }
      if (NB.root) NB.root.insertBefore(docBar(warnings), NB.root.children[0] || null);
    }

    // Slot→markør (spec §5, plan 4b Task 3): klikk på selve cellekroppen
    // hopper editor-markøren dit (window.mdJumpToCell, tverr-IIFE-bro — se
    // filens "Cross-IIFE only via window.md*"-begrensning, index.html eier
    // #scriptInput). Klikk på et INTERAKTIVT element INNI sloten (en
    // #@param-/ui.*-kontroll, en lenke, presentasjons-pilene)
    // skal derimot IKKE hoppe markøren — det ville stjålet klikket fra selve
    // kontrollen (f.eks. avbrutt en slider-dra) som en overraskende
    // sideeffekt. Samme resonnement dekker plot/chart-flater (review
    // Important 2): svg/canvas er tegne-overflater for Plotly/matplotlib-
    // aktige resultater, og js-plotly-plot er Plotlys egen rot-container —
    // et klikk/dra INNI et diagram (zoom, hover, legend-toggle) skal IKKE
    // stjele fokus til editoren, akkurat som en slider ikke skal. Samme
    // resonnement dekker også <img> (Task 2, backlog-sweep): matplotlib-
    // output rendres ofte som et <img> (PNG-data-URL) — et klikk på selve
    // bildet skal heller ikke hoppe markøren. Ekte browser-DOM har
    // Element.prototype.closest; test-harnessets FakeEl har
    // den ikke (samme "utestbar uten en manuell forelder-vandring"-
    // situasjon som resten av filen løser med egne hjelpere i stedet for
    // DOM-native APIer) — egen forelder-vandring fungerer identisk i begge
    // miljøer.
    var CLICK_IGNORE_TAGS = { input: 1, button: 1, select: 1, textarea: 1, a: 1, svg: 1, canvas: 1, img: 1 };
    var CLICK_IGNORE_CLASSES = ['ui-controls', 'param-form', 'nb-present-nav', 'js-plotly-plot'];
    function isIgnorableClickTarget(node, stopAt) {
      var n = node;
      while (n && n !== stopAt) {
        var tag = (n.tagName || n.tag || '').toLowerCase();
        if (CLICK_IGNORE_TAGS[tag]) return true;
        if (n.classList) {
          for (var i = 0; i < CLICK_IGNORE_CLASSES.length; i++) {
            if (n.classList.contains(CLICK_IGNORE_CLASSES[i])) return true;
          }
        }
        n = n.parentNode;
      }
      return false;
    }

    // Output-only cellenode (spec §1): ETTERFØLGER av den gamle (nå fjernede,
    // 4b §5) cellNode, men uten .nb-input/textarea/head/toolbar — kun
    // .nb-output → .nb-output-body
    // (identisk klassenavn/struktur, så ParamForms/Ui/ipywidgets sine
    // mount-seams via cellElementAt/renderCellResult trenger ingen endring).
    function docCellNode(c, idx) {
      var type = C.resolveType(c, NB.docMode);
      var wrap = el('div', 'nb-cell doc-cell');
      wrap.dataset.idx = String(idx);
      if (c.attrs.style && /^(note|warn|card)$/.test(c.attrs.style)) wrap.classList.add('nb-style-' + c.attrs.style);
      if (c.attrs['hide-output']) wrap.classList.add('nb-hide-output');
      // hide-code (dormant siden 4a-konvergensen, spec 2026-07-22-param-
      // colab-parity-design.md sitt utsatte display-mode-punkt vekket via
      // DENNE flagget i stedet — se docs/ROADMAP.md): samme "flagg → klasse
      // på wrap"-mønster som hide-output rett over. app.css sin
      // .nb-hide-code-regel skjuler cellens kode-halvdel, ikke param-/
      // widget-stripene eller output — se app.css-kommentaren der for
      // hvorfor selve regelen pr. i dag ikke treffer noe synlig element i
      // DENNE (output-only) doc-cellen: Rå tekst/#scriptInput er uendret
      // synlig ved siden av, se docs/interactive-elements.html. Samme
      // aksepterte in-place-etterslep som hide-output/style/widgets/cols
      // (docReconcile-kommentaren lenger ned) gjelder også her — kun en
      // strukturell docRender bygger denne klassen på nytt fra c.attrs.
      // ParamForms.decorate (kalt rett under) kan I TILLEGG legge til/
      // fjerne SAMME klasse reaktivt ut fra #@title sin display-mode:"form"-
      // meta (js/param-forms.js sin _build/refresh) — de to kildene er et
      // OR til én delt klasse, men IKKE uavhengige i betydningen "toggler
      // klassen fritt": param-forms sin halvdel (_applyFormHideCode) fjerner
      // ALDRI klassen med mindre den selv satte den (en data-form-hide-code-
      // markør er beviset) — ellers ville den stille revet ned nettopp
      // DETTE flagget sitt bidrag på hver eneste decorate/refresh for en
      // celle uten display-mode:"form" (review-fiks, Major, 2026-07-22).
      if (c.attrs['hide-code']) wrap.classList.add('nb-hide-code');
      // cols (Task 4, spec §4): verdien er allerede validert (heltall 2-6,
      // ellers droppet av parseHeader/scanTagBlock over) — trygg å bruke
      // direkte i klassenavnet uten en ny range-sjekk her.
      // Belte-sjekk (review-Minor): bare `cols`-FLAGGET (boolean true fra
      // ukjent-flagg-stien) skal ikke gi en inert nb-cols-true-klasse —
      // kun validerte strengverdier ('2'..'6') når hit fra skannerne.
      if (typeof c.attrs.cols === 'string') wrap.classList.add('nb-cols-' + c.attrs.cols);
      var out = el('div', 'nb-output');
      var widgetsPos = WIDGETS_POS[c.attrs.widgets] ? c.attrs.widgets : 'top';
      out.classList.add('nb-widgets-' + widgetsPos);
      var body = el('div', 'nb-output-body');
      out.appendChild(body);
      if (!C.isCodeType(type)) {
        // md/html rendres direkte inn i sluket (nb-rendered-only semantics
        // uten noen redigerings-affordance — spec §1: ingen editor-halvdel
        // i dokumentet i det hele tatt, kun ren tekst i #scriptInput).
        wrap.classList.add('nb-rendered-only');
        renderNonCode(body, type, C.renderContent(c.source, type, c.sniffed));
      }
      wrap.appendChild(out);
      c._out = body;
      c._wrap = wrap;
      var paramLang = C.paramLangForType(type);
      if (paramLang && global.ParamForms && typeof global.ParamForms.decorate === 'function') {
        global.ParamForms.decorate(idx, wrap, c.source, paramLang);
      }
      // Slot→markør-klikk (se isIgnorableClickTarget over) — leser idx LEVENDE
      // av wrap.dataset.idx i stedet for å stole på den lukningsfangede
      // parameteren, samme "levende tilstand"-preferanse resten av filen
      // bruker (cellElementAt/cellIndexById): wrap-noden lever videre
      // gjennom en docReconcile, og selv om en strukturell endring alltid
      // gir en helt FERSK wrap (docRender), er det billigere å lese den
      // samme dataset-attributten enn å holde styr på om lukningen kan bli
      // stale.
      wrap.addEventListener('click', function (e) {
        var target = (e && e.target) || wrap;
        if (isIgnorableClickTarget(target, wrap)) return;
        if (typeof global.mdJumpToCell !== 'function') return;
        global.mdJumpToCell(parseInt(wrap.dataset.idx, 10));
      });
      return wrap;
    }

    function docRender() {
      var ta = $('scriptInput');
      var parsed = C.parseCells(ta.value);
      NB.cells = parsed.cells;
      NB.lastSerialized = ta.value;
      NB.plan = C.segmentPlan(ta.value, NB.docMode);
      NB.runSinks = null; NB.runPlan = null; NB.trailing = null;
      // Struktur-(re)rendring er en ærlig reset av stale/ranOk (samme
      // begrunnelse som gamle render()): friskt parsede celleobjekter kan
      // ikke arve forrige generasjons indeks-keyede stempler. NB.activeCellIdx
      // reset følger SAMME resonnement, UBETINGET (review Important 1: en
      // "hvis utenfor grensen"-sjekk var util å ha — en strukturell rebuild
      // gir alltid FERSKE wrap-noder uten .doc-active, se docCellNode/
      // applyActiveCellClass, så en "fortsatt gyldig indeks"-idx fra forrige
      // generasjon peker på en tilfeldig ANNEN celle i den nye, ikke
      // nødvendigvis "samme" markørposisjon). Markørens tracker
      // (nbUpdateActiveCellFromCursor, index.html) reetablerer den riktige
      // aktive cellen ved neste cursor-hendelse likevel.
      NB.stale = {}; NB.ranOk = {};
      NB.activeCellIdx = null;
      var host = docHost();
      if (!host) return;
      if (NB.root) { purge(NB.root); NB.root.remove(); }
      NB.root = el('div', 'doc-root');
      host.innerHTML = '';
      host.appendChild(NB.root);
      // Kopier-knapper (tabell/pre/plotly) på resultater rendret inn i celle-
      // outputene: dekkes av #outputArea sin EGEN MutationObserver
      // (index.html, observeOutputAreaForCopyButtons — { childList: true,
      // subtree: true } på #outputArea selv) — NB.root er ALLTID et barn av
      // #outputArea (docHost() over), så enhver mutasjon inni doc-root er
      // allerede inni det observerte subtreet. En egen doc-root-scoped
      // MutationObserver her (én ny instans per docRender-kall) var dermed
      // en ren duplikat-forsterkning (samme mdScheduleResultEnhance-kall to
      // ganger per mutasjon) — fjernet i 4b §5 (spec 2026-07-17 §5-sjekklisten).
      // Baren er create-on-demand (se docBar/updateWarnings sin egen
      // kommentar) — kun appendes når det faktisk er noe å varsle om.
      NB.docBarEl = null; NB.warningsEl = null;
      if (parsed.warnings.length) NB.root.appendChild(docBar(parsed.warnings));
      for (var i = 0; i < NB.cells.length; i++) {
        var type = C.resolveType(NB.cells[i], NB.docMode);
        if (type === 'skip') continue;               // spec §1: skip rendres ikke
        NB.root.appendChild(docCellNode(NB.cells[i], i));
      }
      // Markør↔slot-kobling (plan 4b Task 3, review Important 1): docRender
      // bygger FERSKE wrap-noder (host.innerHTML = '' over) — enhver
      // tidligere .doc-active ble kastet sammen med den gamle noden, og
      // NB.activeCellIdx selv er allerede UBETINGET klart over (samme
      // "ærlig reset"-linje som NB.stale/NB.ranOk). applyActiveCellClass her
      // er da et rent no-op-oppgjør (ingen indeks matcher null), men holder
      // koden IDEMPOTENT hvis reset-linjen over noen gang flyttes.
      // INGEN scrollIntoView her — dette er en rebygging, ikke en faktisk
      // markørflytting (se applyActiveCellClass sin egen kommentar).
      applyActiveCellClass();
      // #lineNumbers-▶ og aktiv-celle-sporet i index.html kan ikke nås
      // direkte herfra (tverr-IIFE — samme "Cross-IIFE only via window.md*"-
      // begrensning som slot→markør-klikket i docCellNode bruker), så
      // varsle via den etablerte broen: mdSetActiveCellLine(null, null)
      // klarer BÅDE gutter-markøren OG kaller Cells.setActiveCell(null) selv
      // (se index.html sin egen kommentar der) — konsistent med resetten
      // over i stedet for å la en foreldet ▶ bli stående på en linje som nå
      // kan tilhøre en helt annen celle. Markørens tracker reetablerer
      // riktig ▶ ved neste cursor-hendelse (samme begrunnelse som resten av
      // denne resetten).
      if (typeof global.mdSetActiveCellLine === 'function') global.mdSetActiveCellLine(null, null);
      // Presentasjons-overlevelse (spec §2, gjenbruker gamle render() sin
      // hale uendret, mot doc-cellene): host.innerHTML=''-rebyggingen over
      // kastet nav-nodene/synlighetsklassene/nb-present — regn planen på
      // nytt (dokumentet kan ha endret seg), klem cur, bygg overlegget på nytt.
      if (NB.present) {
        var _plan = C.slidePlan(NB.cells);
        var _hasVisible = _plan.slides.some(function (s) { return s.cellIdxs.length > 0; });
        if (!_plan.slides.length || !_hasVisible) {
          C.presentExit();
        } else {
          NB.present.slides = _plan.slides;
          NB.present.byCell = _plan.byCell;
          if (NB.present.cur >= _plan.slides.length) NB.present.cur = _plan.slides.length - 1;
          NB.root.classList.add('nb-present');
          presentBuildNav();
          presentApply();
        }
      }
    }

    // Forsonings-policy (Task 3, spec §1 "Render/update policy"): samme
    // celletall + samme headerRaw-sekvens (C.sameStructure, Task 1) →
    // oppdater PÅ PLASS — untouched celler (source uendret) beholder sin
    // DOM-node OG sitt tidligere resultat urørt; kun cellene hvis `source`
    // faktisk endret seg re-rendres (md/html-kropp på nytt, kodeceller får
    // .nb-stale). Ulik struktur (celle lagt til/fjernet, header omskrevet)
    // → ærlig full rebuild (docRender, samme "outputs borte, stale
    // nullstilt"-oppførsel som strukturendring alltid har hatt).
    //
    // `parsed` er ALLEREDE resultatet av C.parseCells(ta.value) — kalleren
    // (refreshFromScript/tick/updateCellSource) har lest #scriptInput selv,
    // docReconcile parser aldri på nytt.
    function docReconcile(parsed) {
      if (!NB.root || !C.sameStructure(NB.cells, parsed.cells)) { docRender(); return; }
      // Sniffet/effektiv TYPE-endring (Task 3-review-funn 1, Important):
      // sameStructure over sammenlikner KUN headerRaw — en UMERKET celle
      // (ingen type-token på '#%%'-linjen) kan bytte SNIFFET effektiv type
      // ved en REN kroppsendring (f.eks. '"""md"""' → 'x = 1', eller
      // omvendt) uten at headeren rører seg i det hele tatt. Uten denne
      // ekstra porten ville in-place-grenen under beholde DOM-noden som ble
      // bygget for den GAMLE typen — en stale 'output-markdown' (fortsatt
      // 'nb-rendered-only', aldri renset til et kode-sluk) eller omvendt en
      // manglende 'nb-rendered-only' for en celle som nettopp ble sniffet
      // til md/html. Enhver effektiv-type-endring krever derfor akkurat
      // samme ærlige full rebuild som en header-omskriving allerede utløser.
      for (var gi = 0; gi < parsed.cells.length; gi++) {
        if (C.resolveType(NB.cells[gi], NB.docMode) !== C.resolveType(parsed.cells[gi], NB.docMode)) {
          docRender();
          return;
        }
      }
      var ta = $('scriptInput');
      var oldCells = NB.cells;
      var newCells = parsed.cells;
      NB.cells = newCells;
      NB.lastSerialized = ta.value;
      NB.plan = C.segmentPlan(ta.value, NB.docMode);
      // Task 3-review-funn 4 (Minor): doc-baren sine parse-varsler holdes
      // ferske gjennom in-place-grenen — se updateWarnings sin egen kommentar.
      updateWarnings(parsed.warnings);
      // Wrap-attr in-place-etterslep (kjent, akseptert — samme kategori som
      // doc-bar-etterslepet over var FØR Task 3-review-funn 4 rettet nettopp
      // DEN ene): style/hide-output/widgets/cols (Task 4, spec §4) bakes alle
      // inn i selve WRAP/OUT-noden av docCellNode, men denne grenen overfører
      // kun _out/_wrap-REFERANSENE til de gamle nodene (linjene rett under) —
      // den skriver aldri klasselisten på nytt. En #tag-ENDRING av en av disse
      // fire i cellekroppen (uten at headerRaw eller effektiv type endrer
      // seg, se sniff-porten over) etterlater derfor de gamle nb-style-/
      // nb-hide-output/nb-widgets-/nb-cols-klassene inntil neste STRUKTURELLE
      // rendring (docRender), som alltid bygger ferske wrap-noder fra ferske
      // attrs. Akseptert: en full wrap-klasse-resync her ville krevd å lese
      // cell.attrs på nytt for HVER untouched celle og differensiere mot
      // wrap.classList — en kostnad ingen bruker har bedt om ennå.
      for (var i = 0; i < newCells.length; i++) {
        var oldC = oldCells[i], c = newCells[i];
        // Slot-identitet overlever (spec §1 "leave untouched cells' slots
        // (and their outputs) alone") — DOM-nodene ble bygget for oldC av en
        // TIDLIGERE docRender/docReconcile og lever fortsatt i NB.root; å
        // overføre referansene hit er det som gjør resultatet av en
        // tidligere kjøring synlig etter forsoningen (renderCellResult skrev
        // rett inn i akkurat denne _out-noden).
        c._out = oldC._out;
        c._wrap = oldC._wrap;
        if (oldC.source === c.source) continue;   // untouched — ingen re-rendring
        var type = C.resolveType(c, NB.docMode);
        if (C.isCodeType(type)) {
          markStaleIfRan(i);
        } else if (c._out) {
          // md/html: kroppen ER resultatet — re-render inn i det overlevende
          // sluket (samme byggeklosser som docCellNode selv brukte).
          renderNonCode(c._out, type, C.renderContent(c.source, type, c.sniffed));
        }
        // #@param-stripa må følge den endrede kildeteksten, men UTEN å rive
        // ned/bygge kontroll-DOM-en på nytt her (Task 3-review-funn 2,
        // Important): en levende slider-drag committer PER 'input'-hendelse
        // via Cells.updateCellSource → docReconcile (se _buildSlider i
        // js/param-forms.js) — et ParamForms.decorate-kall her ville da
        // full-ombygd stripa på HVER pikselbevegelse og drept selve
        // dra-gesten (fokus/pointer-capture mistet midt i draget). Den GAMLE
        // (pre-4a) modellens per-redigerings-søm var nettopp
        // ParamForms.syncSource — en billig, DOM-fri kildesynk (kun
        // st.source/st.entries oppdateres, se der) kalt ved AKKURAT denne
        // kadensen (js/cells.js sin daværende onEdit, per tastetrykk), mens
        // en FULL ombygging (decorate/_build) kun skjedde ved en hel
        // dokument-(re)rendring (cellNode/nå docCellNode). Mirrorer det
        // her — decorate lever nå UTELUKKENDE i docCellNode.
        //
        // Residual (bevisst, dokumentert per review-funn 2): syncSource
        // rører ALDRI DOM-en, så en #@param-LINJE lagt til/fjernet ved en
        // kroppsredigering (ikke via en kontrolls egen commit) gir IKKE en
        // ny/fjernet fysisk stripe her — kun neste strukturelle rendring
        // (docRender) bygger stripa på nytt. Den gamle modellen hadde samme
        // begrensning ved AKKURAT denne kadensen (dens egen per-tastetrykk-
        // syncSource var like DOM-fri); der fantes riktignok en ekstra,
        // separat 250ms-debounce-hale (ParamForms.refresh, kalt fra
        // doFlush) som til slutt tok seg av strukturelle ADD/REMOVE — den
        // halen hører til det fjernede cellNode/onEdit-maskineriet og har
        // ingen motpart i den konvergerte editoren, så et forsonings-
        // trigget syncSource-kall her ombygger aldri selv.
        var paramLang = C.paramLangForType(type);
        if (paramLang && global.ParamForms && typeof global.ParamForms.syncSource === 'function') {
          global.ParamForms.syncSource(i, c.source);
        }
      }
    }

    // Delt forsonings-sti (spec 4b Task 1 — 4a-sluttreview Important 1):
    // NØYAKTIG samme gren tick() alltid har brukt for "#scriptInput har
    // endret seg siden sist serialisert/rendret" — faktorert ut hit slik at
    // C.updateCellSource() (under) kan kjøre AKKURAT samme forsoning FØR sin
    // egen splice, i stedet for å duplisere (og dermed potensielt avvike
    // fra) tick() sin logikk. Markører fortsatt der → docReconcile (untouched
    // cellers slots/outputs overlever); markørene borte → C.exit() (samme
    // som tick() alltid har gjort for en tekst som ikke lenger er en
    // notatbok).
    function reconcileScriptInput(v) {
      if (C.hasMarkers(v)) docReconcile(C.parseCells(v));
      else C.exit();
    }

    // refreshFromScript() sitt dobbelt-modus (Task 3): "uendret siden sist
    // rendret" (`ta.value === NB.lastSerialized`) → full ærlig reset
    // (docRender); "endret siden sist" → forsoning (docReconcile — outputs
    // for UENDREDE celler overlever). Samme skillelinje som tick() selv
    // allerede bruker.
    //
    // index.html sin clearOutput() kalte tidligere DENNE funksjonen som sin
    // "nullstill output"-handling (Task 3b), men det var en race (Task 3-
    // review-funn 3, Minor): dual-mode-porten over ville FORSONE (og dermed
    // BEHOLDE utdata) i stedet for å tømme, hvis brukeren rakk å redigere
    // #scriptInput i samme sekund som "Tøm output" ble trykket (ta.value !==
    // NB.lastSerialized på det tidspunktet). clearOutput() kaller nå i
    // stedet C.rebuildDocument() under — en ubetinget docRender(), uansett
    // NB.lastSerialized-tilstand. refreshFromScript() beholdes UENDRET som
    // offentlig API (dual-mode-kontrakten er fortsatt dekket av "forsoning:
    // …"-testene) — tick() (under) kaller for øvrig ALLEREDE docReconcile
    // direkte, ikke via denne, og har aldri gjort det.
    C.refreshFromScript = function () {
      if (!NB.activeFlag) { updateChip(); return; }
      var ta = $('scriptInput');
      if (!ta) return;
      if (ta.value === NB.lastSerialized) { docRender(); return; }
      docReconcile(C.parseCells(ta.value));
    };

    // Eksplisitt "nullstill output"-handling (Task 3-review-funn 3, Minor —
    // adskilt fra refreshFromScript() sin dual-mode-forsoning over): ALLTID
    // en ærlig full docRender(), uansett om #scriptInput har endret seg
    // siden sist rendret. index.html sin clearOutput() (notatbok-aktiv-
    // grenen) kaller denne i stedet for refreshFromScript() — se kommentaren
    // over for raceen dette lukker. No-op når notatboken ikke er aktiv
    // (speiler refreshFromScript() sin egen guard).
    C.rebuildDocument = function () {
      if (NB.activeFlag) docRender();
    };

    function renderNonCode(out, type, src) {
      purge(out);
      out.innerHTML = '';
      if (type === 'md') {
        var md = typeof global.markdownit === 'function' ? global.markdownit({ breaks: true }) : null;
        var div = el('div', 'output-markdown');
        if (md) div.innerHTML = md.render(src); else div.textContent = src;
        out.appendChild(div);
      } else if (!NB.htmlTrusted) {
        // Utrygt opphav (delt lenke / GitHub / dyplenke): vis kilden eskapert
        // (textContent — ingen live-DOM, ingen onerror/onload kjører) + en
        // knapp som gir tillit til HELE dokumentet på ett klikk.
        out.appendChild(el('pre', 'nb-html-escaped', src));
        var btn = el('button', 'nb-html-trust-btn', t('Vis HTML'));
        btn.type = 'button';
        btn.title = t('Dokumentet kom fra en delt lenke — HTML vises først når du godtar det');
        btn.addEventListener('click', function () { C.grantHtmlTrust(); });
        out.appendChild(btn);
      } else {
        var host = el('div', 'nb-html');
        host.innerHTML = src;   // html-celle: betrodd dokument (lokalt/eksempel/godtatt)
        out.appendChild(host);
      }
    }

    // Idempotent tillitsinnvilgelse: setter flagget true og re-rendrer HELE
    // notatboken (alle html-celler blir live) kun hvis det var false. Kalles
    // fra Vis HTML-knappen og fra Kjør-stien (kjøring dominerer HTML-rendring).
    C.grantHtmlTrust = function () {
      if (NB.htmlTrusted) return;
      NB.htmlTrusted = true;
      if (NB.activeFlag && NB.root) docRender();
    };

    // Cells.updateCellSource(idx, newSource) (spec 2 W4, Task 2; retarget mot
    // #scriptInput i Task 3): den PROGRAMMATISKE motparten til vanlig
    // #scriptInput-redigering — brukt av ParamForms når en skjema-kontroll
    // endrer verdi (control → writeValue → HIT). 4a fjernet celle-listens
    // egne textareaer (c._ta) — kanonisk kilde er nå #scriptInput ALENE, så
    // denne funksjonen SPLICER cellens kroppslinjer rett inn i
    // #scriptInput.value i stedet for å sette en cellelokal .value.
    //
    // Kroppsspennet gjenbruker NØYAKTIG samme aritmetikk som parseCells sin
    // egen close() (linje 279 over): bodyStart er startLine (preambel,
    // headerRaw null) eller startLine+1 (vanlig celle — kroppen begynner
    // rett ETTER headerlinja); deleteCount er 0 for en kroppsløs celle
    // (hasBody false — splicingen blir da en REN INNSETTING rett etter
    // headerlinja, ingen linjer å slette) ellers hele det eksisterende
    // spennet (endLine - bodyStart + 1). newSource === '' splices inn NULL
    // linjer (IKKE ['']  — en tom streng ville satt inn én uønsket blank
    // linje) — symmetrisk med hvordan cellBlock/parseCells selv behandler
    // en tømt kropp (hasBody:false etter re-parse).
    //
    // syncTickBaseline() FØR docReconcile (ikke etter): forsoningen under
    // leser/oppdaterer selv NB.lastSerialized til den nye teksten, men
    // tikkeren sin EGEN "endret siden forrige tikk"-basislinje
    // (NB.lastTickValue) må også synkes her — samme regel som enhver annen
    // programmatisk #scriptInput-endring (se contentLoaded/setDocMode) — så
    // IKKE et påfølgende tikk tolker AKKURAT DENNE skriften som en ny
    // ekstern injeksjon.
    //
    // docReconcile ser cellens headerRaw-linje URØRT (kun kroppslinjer ble
    // spliset), så C.sameStructure holder ALLTID her → forsoningen tar den
    // in-place-grenen, som re-kaller ParamForms.syncSource for DENNE cellIdx-
    // en (source endret) — DOM-fri kildesynk, IKKE et full decorate-ombygg
    // (se docReconcile over for hvorfor et re-kall mot samme, fortsatt
    // tilkoblede c._wrap er trygt uten å rive ned kontroll-DOM-en).
    //
    // Stale-span-racet (4a-sluttreview, Important 1 — spec 4b Task 1): idx
    // og c.startLine/c.endLine kommer fra NB.cells sist gang DOKUMENTET ble
    // forsonet/rendret — men brukeren kan ha skrevet direkte i #scriptInput
    // (lagt til/fjernet linjer) i INNEVÆRENDE ett-sekunds tikk-vindu UTEN at
    // den skrivingen enda er forsonet inn i NB.cells. En splice mot #script-
    // Input.value (som ALLEREDE reflekterer brukerens ferske tekst) basert
    // på disse FORELDEDE linjenumrene ville da enten treffe feil linjespenn
    // i en NABOcelle (korrumpert tekst) eller regne feil deleteCount for
    // DENNE cellen (sletter/overskriver brukerens nettopp skrevne linjer).
    // Forson derfor FØRST — nøyaktig samme sti (reconcileScriptInput) tick()
    // selv bruker for AKKURAT denne "endret siden sist"-oppdagelsen — slik
    // at c/NB.cells alltid er ferske FØR selve spennet under regnes ut.
    C.updateCellSource = function (idx, newSource) {
      var ta = $('scriptInput');
      if (!ta) return null;
      if (ta.value !== NB.lastSerialized) {
        var rootBefore = NB.root;
        reconcileScriptInput(ta.value);
        // Indeks-identitet-forbeholdet (spec 4b Task 1c): reconcileScript-
        // Input over kan ha tatt docRender-grenen (celletall/header endret,
        // ELLER en sniffet effektiv-type-endring, se docReconcile) — HELE
        // notatboken (og med den, ParamForms sine skjema-striper) ble da
        // rebygget fra bunnen, og cellIdx-en kalleren (ParamForms._commit)
        // fanget ved dekoreringstidspunktet kan nå peke på en ANNEN celle
        // enn den brukeren faktisk endret — eller C.exit() kan ha kjørt
        // (ingen markører igjen, NB.root null). En full rebuild bytter
        // ALLTID NB.root sin node-identitet (docRender bygger en helt ny
        // 'doc-root'-node hver gang, se der); en in-place-forsoning rører
        // aldri NB.root. Sammenlikningen under er dermed en billig, presis
        // detektor for "ble stripa allerede rebygget under oss?" — i så
        // fall: dropp splicingen fremfor å gjette/korrumpere feil celle.
        // ParamForms sin egen strip er uansett allerede fersk (bygget av
        // den rebyggingen); brukerens ENE kontroll-interaksjon er langt å
        // foretrekke å miste fremfor å risikere tekst-korrupsjon.
        if (NB.root !== rootBefore) return null;
      }
      var c = NB.cells[idx];
      if (!c) return null;
      var lines = String(ta.value).split('\n');
      var bodyStart = c.headerRaw === null ? c.startLine : c.startLine + 1;
      var deleteCount = c.hasBody ? (c.endLine - bodyStart + 1) : 0;
      var newLines = newSource === '' ? [] : String(newSource).split('\n');
      var spliceArgs = [bodyStart, deleteCount].concat(newLines);
      Array.prototype.splice.apply(lines, spliceArgs);
      ta.value = lines.join('\n');
      C.syncTickBaseline();
      docReconcile(C.parseCells(ta.value));
      // Returner den FERSKE kildeteksten (spec 4b Task 1b): ParamForms sin
      // egen st.source-cache kan ellers holde på den PRE-splice-kopien den
      // selv beregnet newSource fra — se js/param-forms.js sin _commit, som
      // bruker nettopp denne returverdien (når den er en streng) til å
      // resynke seg selv i stedet for blindt å stole på sin egen closure-
      // fangede kopi.
      var fresh = NB.cells[idx];
      return fresh ? fresh.source : null;
    };

    // Én tikker: aktiv → fang programmatiske endringer i #scriptInput
    // (eksempler/AI setter .value uten input-event) og forson dem (Task 3:
    // docReconcile — untouched cellers slots/outputs overlever, kun det som
    // faktisk endret seg re-rendres; ulik struktur faller selv tilbake til
    // docRender inni docReconcile); inaktiv → vis/skjul hint.
    function tick() {
      var ta = $('scriptInput');
      if (!ta) return;
      var v = ta.value;
      if (NB.activeFlag) {
        if (v !== NB.lastSerialized) reconcileScriptInput(v);
      } else if (v !== NB.lastTickValue && NB.lastUserInput < NB.lastTickTime &&
                 C.hasMarkers(v) && C.supportedMode(NB.docMode)) {
        // Per-tikk-attribusjon: verdien endret seg siden forrige tikk UTEN at
        // noen input-event fyrte i samme vindu → endringen er programmatisk
        // (share-lenke, eksempler, i18n-gjenoppretting) → rett til celle-
        // visning (spec §3.2). Fyrte en input-event, er det aktiv skriving →
        // kun hint-chip, aldri auto-inngang — uansett hvor lenge brukeren
        // pauser mellom tastetrykk.
        C.enter(appLayout());
      } else updateChip();
      NB.lastTickValue = v;
      NB.lastTickTime = Date.now();
    }

    function updateChip() {
      var ta = $('scriptInput');
      if (!NB.chip) {
        var wrap = document.querySelector('.code-input-wrap');
        if (!wrap) return;
        NB.chip = el('button', 'nb-chip', t('Notatbok — vis som celler'));
        NB.chip.type = 'button';
        NB.chip.addEventListener('click', function () {
          C.enter(appLayout());
        });
        wrap.appendChild(NB.chip);
      }
      NB.chip.hidden = !(!NB.activeFlag && ta && C.hasMarkers(ta.value) && C.supportedMode(NB.docMode));
    }

    // ---- kjøring (Task 6/9): per-celle output-slots ----
    // beginRun kalles fra segmentløkken i index.html. Aksepterer enten:
    //  - et array av segment-KINDS (f.eks. ['pyodide','microdata']) → justerer
    //    planen mot de faktiske kindene via alignPlan (Task 9 bug (a)-fiks:
    //    en strippet preambel gir ikke lenger trailing-fallback), eller
    //  - et tall (bakoverkompatibelt antall-sjekk — runHybridR sender bevisst
    //    0 for å alltid falle til trailing-sloten, se runHybridR).
    // Returnerer sink-listen, eller null (→ samlet fallback-slot nederst)
    // når planen ikke matcher — f.eks. ##-markører skrevet manuelt i en celle.
    C.beginRun = function (segmentsOrCount) {
      if (!NB.activeFlag) return null;
      // Kjør alle/Forklar kjører ALT på nytt (Global Constraints: Restart &
      // Kjør alle ER reset-mekanismen for stale-tilstand) — enhver beginRun
      // regnes derfor som en fullstendig frisk kjøring av hver celle, uansett
      // om et enkelt segment feiler underveis (bevisst forenkling, spec §7).
      clearAllStale();
      // Purger KUN .nb-output-body (sluket) — widget-plassering-fasen:
      // .nb-output er nå en wrapper som også kan holde .param-form/
      // .ui-controls-striper, og disse skal IKKE tømmes her (de overlever
      // «Kjør alle» akkurat som de overlever enkelt-celle-rerun). Body sin
      // besteforelder er cellens .doc-cell-wrap (body → .nb-output → .doc-cell).
      var outs = NB.root.querySelectorAll('.doc-cell .nb-output-body');
      for (var i = 0; i < outs.length; i++) {
        var cellEl = outs[i].parentNode && outs[i].parentNode.parentNode;
        // md/html-celler er markert 'nb-rendered-only' (docCellNode) i stedet
        // for det gamle cellNode sitt 'nb-noncode' — samme "behold rendringen,
        // ikke purge"-vakt, ny klassekilde (skip-celler finnes ikke i
        // dokumentet lenger, se docRender, så det skillet trengs ikke her).
        if (cellEl && cellEl.classList.contains('nb-rendered-only')) continue;
        purge(outs[i]);
        outs[i].innerHTML = '';
      }
      if (NB.trailing) { NB.trailing.remove(); NB.trailing = null; }
      var plan = NB.plan;
      if (Array.isArray(segmentsOrCount)) {
        var aligned = C.alignPlan(NB.plan, NB.cells, NB.docMode, segmentsOrCount);
        if (aligned === null) { NB.runSinks = null; NB.runPlan = null; return null; }
        plan = aligned;
      } else if (segmentsOrCount !== NB.plan.length) {
        NB.runSinks = null; NB.runPlan = null; return null;
      }
      NB.runPlan = plan;
      NB.runSinks = [];
      for (var s = 0; s < plan.length; s++) {
        var node = NB.root.querySelector('.doc-cell[data-idx="' + plan[s] + '"] .nb-output-body');
        NB.runSinks.push(node || null);
      }
      return NB.runSinks;
    };

    C.sinkForSegment = function (i) {
      if (NB.runSinks && NB.runSinks[i]) return NB.runSinks[i];
      return C.errorHost();
    };

    // Justert plan UTEN beginRun sine sluk-bivirkninger (ui-widgets, plass-
    // fase Task 2): R-modus sin "Kjør alle" (runHybridR) kaller beginRun nå
    // med de EKTE segment-kindene i notatbokmodus (per-celle-attribusjon,
    // spec 2026-07-18) — denne funksjonen trengs likevel fortsatt som et
    // separat, side-effekt-fritt oppslag: den brukes for ui-verdi-injeksjon/
    // registeroppdatering per r-segment UAVHENGIG av om beginRun sitt kall
    // skjedde/lyktes, uten å røre NB.runSinks/NB.runPlan. Denne funksjonen
    // gjør NØYAKTIG det alignPlan-kallet inni beginRun gjør (samme NB.plan/
    // NB.cells/NB.docMode), men returnerer planen i stedet for å lagre den
    // noe sted — ingen purge, ingen NB.runSinks/NB.runPlan-mutasjon, ingen
    // clearAllStale(). Returnerer null når notatboken er inaktiv eller
    // planen ikke kan justeres mot `kinds` (samme fallback-kontrakt som
    // beginRun/alignPlan for øvrig).
    C.alignedPlanForKinds = function (kinds) {
      if (!NB.activeFlag) return null;
      return C.alignPlan(NB.plan, NB.cells, NB.docMode, kinds);
    };

    // Fase C (spec 2026-07-16): kjøreplan for motor-notatbøker (brython/
    // micropython) — celleindeksene til ALLE kodeceller med en KIND_FOR_TYPE-
    // oppføring, i dokumentrekkefølge (preambelen inkludert: den resolver
    // til docMode og kjøres som "celle 0" inn i sesjonen). Ingen segmenter
    // her — enspråklige dokumenter kjøres celle for celle via C.runCell, og
    // fremmede kode-kinds får sin notis fra mdRunNotebookCell, ikke herfra.
    // null når notatboken er inaktiv (samme kontrakt som alignedPlanForKinds).
    C.engineRunPlan = function () {
      if (!NB.activeFlag) return null;
      var out = [];
      for (var i = 0; i < NB.cells.length; i++) {
        var type = C.resolveType(NB.cells[i], NB.docMode);
        if (C.isCodeType(type) && KIND_FOR_TYPE[type]) out.push(i);
      }
      return out;
    };

    // Segment-indeks → celleindeks i den justerte planen (Task 2, ui-widgets
    // W1): index.html sin "Kjør alle"-segmentløkke trenger cellens indeks
    // (ikke bare sinken) for å bygge kjørekonteksten window.mdUiRunCtx()
    // leser fra. Samme kilde som sinkForSegment/segmentDisplay (NB.runPlan) —
    // null når planen ikke er justert (ingen 1:1-mapping, se beginRun).
    C.cellIdxForSegment = function (i) {
      if (!NB.runPlan) return null;
      var idx = NB.runPlan[i];
      return idx === undefined ? null : idx;
    };

    // Celle-id → celleindeks (Task 2, ui-widgets W1): scanner NB.cells sin
    // attrs.id, samme "levende tilstand"-antakelse som sinkForSegment (ikke
    // et cachet oppslag — cellene kan endre indeks ved struktur-re-rendring).
    // -1 når id ikke finnes, eller notatboken er inaktiv.
    C.cellIndexById = function (id) {
      for (var i = 0; i < NB.cells.length; i++) {
        if (NB.cells[i] && NB.cells[i].attrs && NB.cells[i].attrs.id === id) return i;
      }
      return -1;
    };

    // ---- markør-/seleksjonskjøring (spec §4, plan 4b Task 2) ----
    // DOM-halvdel-innpakninger rundt de rene hjelperne (cellAtLine/
    // selectionCellSpan) mot LEVENDE NB.cells/NB.docMode — samme "levende
    // tilstand"-antakelse som cellIndexById/cellElementAt over: index.html
    // trenger aldri selv holde styr på docMode eller re-parse #scriptInput
    // bare for å slå opp cellen markøren står i. -1 / {error:'outside'} når
    // notatboken er inaktiv (samme fallback-kontrakt som resten av filen).
    C.cellAtLineInDoc = function (line) {
      if (!NB.activeFlag) return -1;
      return C.cellAtLine(NB.cells, line);
    };
    C.selectionSpanInDoc = function (startLine, endLine) {
      if (!NB.activeFlag) return { error: 'outside' };
      return C.selectionCellSpan(NB.cells, startLine, endLine, NB.docMode);
    };

    // Celleindeks → gjeldende DOM-node (Task 2, ui-widgets W1): brukes av
    // window.mdUiRunCtx() sin cellEl-oppslag. Querier NB.root direkte (samme
    // '.doc-cell[data-idx="…"]'-mønster som beginRun bruker) i stedet for å
    // cache en referanse — cellens node byttes ut ved enhver struktur-
    // re-rendring (final-review F6-mønsteret), en frisk oppslag er alltid
    // korrekt. null når notatboken ikke har en rendret rot, eller idx mangler.
    // 4a: returnerer .doc-cell-noden (docCellNode) — samme mount-seam-
    // kontrakt som før (.nb-output/.nb-output-body finnes uendret inni).
    C.cellElementAt = function (idx) {
      if (!NB.root) return null;
      return NB.root.querySelector('.doc-cell[data-idx="' + idx + '"]') || null;
    };

    // Celleindeks → STABIL nøkkel (ui-widgets W2, Task 1): attrs.id når
    // cellen har én, ellers råindeksen konvertert til streng. Brukes av
    // js/ui.js sitt verdilager (Ui._values/_controls nøkler nå på DENNE i
    // stedet for den rå celleindeksen) — en id-tagget celle beholder dermed
    // sine ui.*-kontrollverdier på tvers av strukturelle indeksskift
    // (en celle satt inn/fjernet over den), mens en id-løs celle fortsatt
    // nøkler på indeksen (ingen stabilitetsgaranti utover det, som før).
    // Samme "levende tilstand"-antakelse som cellIndexById/cellElementAt:
    // leser NB.cells direkte, ingen cache.
    //
    // '#'-prefiks (B2 Task 4-fiks): en id-tagget nøkkel returneres som
    // '#' + id, IKKE den rå id-strengen — uten dette kunne en celle med
    // f.eks. attrs.id === "0" kollidere med den indeks-baserte nøkkelen til
    // en helt annen (id-løs) celle på råindeks 0 (begge ville vært strengen
    // "0" i _values/_controls). '#' er ikke et gyldig ledende tegn i en
    // #%%-header sin id=…-verdi (samme identifikator-regex som parseCells
    // bruker), så id-grenen og indeks-grenen kan aldri produsere samme
    // streng. Alle forbrukere (js/ui.js sin _cellKeyAt/valuesForCell/
    // controlKey) behandler nøkkelen som en opak streng — ingen strukturell
    // parsing av innholdet — så prefikset krever ingen endring der.
    C.cellKeyAt = function (idx) {
      var c = NB.cells[idx];
      return (c && c.attrs && c.attrs.id) ? ('#' + c.attrs.id) : String(idx);
    };

    // Visningspolicy per segment (§4 "Display policy" i spec): brukes av
    // JS-segmentløkken i index.html til å avgjøre om et pyodide-segment skal
    // kjøre med echo av + kun siste uttrykk vist (eksplisitt celle) eller
    // beholde dagens vis-alt-oppførsel (implisitt preambel, eller ingen
    // justert plan — f.eks. håndskrevne '##'-markører inni en celle).
    // Returnerer { explicit: bool } for segment-indeks i, eller null når
    // notatbok er inaktiv eller planen ikke kunne justeres mot kjøretiden.
    C.segmentDisplay = function (i) {
      if (!NB.activeFlag || !NB.runPlan) return null;
      var idx = NB.runPlan[i];
      var c = idx === undefined ? null : NB.cells[idx];
      if (!c) return null;
      return { explicit: c.headerRaw !== null };
    };

    // Samle-slot nederst: fallback ved planavvik og vert for feilmeldinger.
    // Ingen strip-vert (ikke inni en .nb-cell, ingen widgets-konsept her) —
    // derfor .nb-output-body direkte, samme sluk-klasse som alle andre
    // run-output-mål, IKKE .nb-output-wrapperen.
    C.errorHost = function () {
      if (!NB.activeFlag) return null;
      if (!NB.trailing || !NB.trailing.isConnected) {
        NB.trailing = el('div', 'nb-output-body nb-trailing');
        NB.root.appendChild(NB.trailing);
      }
      return NB.trailing;
    };

    // ---- kjøring: enkelt-celle mot levende sesjon (Task 2, fase B1) ----
    // Kjør ÉN celle via window.mdRunNotebookCell (sesjon + eksekvering lever
    // i index.html — cells.js sin DOM-halvdel forblir Pyodide/DuckDB-agnostisk).
    // Rendrer KUN inn i denne cellens EGEN .nb-output (lagret direkte på
    // celleobjektet i cellNode) — ingen segment-plan-oppslag trengs her, i
    // motsetning til beginRun/sinkForSegment (som betjener HELE kjøreløkken
    // under Kjør alle): vi vet allerede nøyaktig hvilken DOM-node dette er.
    // "# use"-oppløsning mot full dokumentkontekst skjer i index.html
    // (forskningsfaktum: use-inferens skanner hele dokumentet) — payload.uses
    // sendes derfor tom herfra; index.html sin egen segmentoppløsning
    // (buildDocumentSegments + Cells.segmentPlan/alignPlan på cellIdx) er
    // autoritativ.
    C.runCell = function (idx) {
      if (!NB.activeFlag) return Promise.resolve();
      var c = NB.cells[idx];
      if (!c) return Promise.resolve();
      if (global.mdIsScriptRunning && global.mdIsScriptRunning()) return Promise.resolve();
      var type = C.resolveType(c, NB.docMode);
      // Ekvivalent med !C.isRunnableType(type) (se den pure exporten over,
      // review Minor 3 — samme kilde brukes av index.html sin ▶-synlighet)
      // — beholdt som et direkte oppslag her fordi vi trenger selve
      // `kind`-VERDIEN rett under (mdRunNotebookCell-kallet), ikke bare et
      // boolsk "kan kjøres"-svar.
      var kind = C.isCodeType(type) ? KIND_FOR_TYPE[type] : null;
      if (!kind) {
        flashHint(c._wrap);
        return Promise.resolve();
      }
      if (typeof global.mdRunNotebookCell !== 'function') return Promise.resolve();
      var out = c._out;
      // mount-to-slot (fase B2 Task 4b): en enkelt-celle-rerun kjører KUN mot
      // DENNE cellens .nb-output — ulikt "Kjør alle" (Cells.beginRun purger
      // ALLE sluk FØR segmentløkka, se over), tømmes ikke denne sloten før
      // hvert runCell-kall i dag.
      //
      // data-ui-shown er den ENESTE preserverte-innhold-kontrakten (dash-
      // absorpsjon 5b: dash sin ".dash"-halvdel er fjernet) — forrige kjørings
      // monterte ui.html-elementer (Ui.elShow) er fortsatt tilkoblet DOM-en
      // ved rerun-start; uten denne for-kjøringsrensken akkumulerer reruns
      // duplikater (review-funn 15ce63c): en ny .show() i den nye kjøringen
      // ville STAPLET et nytt element oppå det gamle i stedet for å erstatte
      // det. Purge+clear her kobler den gamle noden fra DOM-en (isConnected
      // blir false); den generasjons-skopede _els-sveipen i Ui.endCellRun
      // (js/ui.js) reklamerer selv registeroppføringen ved kjøringens slutt.
      if (out && out.querySelector && out.querySelector('[data-ui-shown]')) {
        purge(out);
        out.innerHTML = '';
      }
      var payload = {
        kind: kind,
        text: C.execCellSource(c) || '',
        uses: [],
        // Display policy v2 (spec 2026-07-20 §Phase 1): echo av, ALLE nakne
        // uttrykk vises (dempingsreglene håndheves i _exec_pyodide_block).
        // index.html legger selv på last:true ved '#options.display = last',
        // og dropper hele _nb ved '#options.display = all' (leses fra HELE
        // dokumentet, aldri fra cellen).
        nb: { echo: false },
        cellIdx: idx
      };
      // Task 5: kjøre-livssyklusen driver den kjørende cellens .nb-running-
      // puls — poll-fritt, symmetrisk start/slutt-par (ingen finally()
      // avhengighet: begge then-grenene under fullfører alltid uten å kaste
      // videre). Deaktiverte tidligere OGSÅ Restart-knappen (setNbButtonsDisabled)
      // og oppdaterte sesjonschippen — begge fjernet 2026-07-17.
      setRunningUi(idx, true);
      return global.mdRunNotebookCell(payload).then(function (res) {
        renderCellResult(idx, out, res);
        C._afterCellRun(idx, !(res && res.error));
      }, function (err) {
        renderCellResult(idx, out, { error: (err && err.message) || String(err) });
        C._afterCellRun(idx, false);
      }).then(function () {
        setRunningUi(idx, false);
        // Skjema-stripe-rekkefølge (widget-plassering-fasen): IKKE lenger en
        // reorder-reassert her — js/param-forms.js og js/ui.js setter nå
        // begge inn sin stripe på en FAST plass inni `.nb-output`
        // (param-form, ui-controls, .nb-output-body, i den rekkefølgen,
        // uansett hvilken av de to som dukker opp først), så rekkefølgen
        // trenger aldri reasserteres i ettertid.
      });
    };

    // Tømmer "endret siden sist kjørt"-tint (.nb-stale) ved suksess og
    // markerer cellen som "har kjørt OK" (senere redigering skal da vise
    // stale igjen, se markStaleIfRan). Feilet kjøring rører IKKE stale-
    // tilstanden — spec sier eksplisitt "cleared when that cell later runs
    // OK", ikke ved feil.
    C._afterCellRun = function (idx, ok) {
      if (!ok) return;
      NB.ranOk[idx] = true;
      if (NB.stale[idx]) {
        NB.stale[idx] = false;
        var c = NB.cells[idx];
        if (c && c._wrap) c._wrap.classList.remove('nb-stale');
      }
      // Kjør-chip (param-forms.js): denne kanalen dekker BÅDE celle-hodets
      // ▶ og chippen sitt eget klikk (begge kaller Cells.runCell → hit ved
      // suksess) — ubetinget på `ok`, IKKE inni "if (NB.stale[idx])" over:
      // en celle som ALDRI har kjørt før (NB.ranOk var false) får aldri
      // .nb-stale i utgangspunktet, men #@param-kontrollen kan likevel ha
      // vist en chip (se ParamForms._commit) — den skal skjules her akkurat
      // som for enhver annen celle. Guardet — ParamForms er valgfri.
      if (global.ParamForms && typeof global.ParamForms.onCellRan === 'function') {
        global.ParamForms.onCellRan(idx);
      }
    };

    // Blanker #tag-linjer INNI en fristående tekst-seleksjon (plan 4b Task 2):
    // en seleksjon er en vilkårlig substring av en cellekropp — den kan bare
    // ha SIN EGEN tag-blokk hvis seleksjonen tilfeldigvis starter ved
    // kroppens begynnelse, men scanTagBlock(text, false) er trygg å kjøre
    // uansett (finner ingen blokk i en seleksjon som starter midt inni
    // koden, se scanTagBlock sin egen "ledende blanklinjer/celle-modus"-
    // kommentar) — samme "# er direktiv-prefiks i microdata/ikke-kommentar i
    // duckdb-SQL"-begrunnelse som execCellSource: en tag-linje MÅ aldri nå
    // motorene, selv i en delvis kjøring.
    function blankTagLinesInText(text) {
      var s = String(text == null ? '' : text);
      var scan = C.scanTagBlock(s, false);
      if (!scan.tagLines.length) return s;
      var lines = s.split('\n');
      for (var i = 0; i < scan.tagLines.length; i++) lines[scan.tagLines[i]] = '';
      return lines.join('\n');
    }

    // Kjør en TEKST-SELEKSJON inni cells[idx] mot den levende sesjonen (plan
    // 4b Task 2: markør-/seleksjonskjøring, Ctrl/Cmd+Enter over en ikke-tom
    // seleksjon). Speiler C.runCell sin struktur (guardene, payload-formen,
    // setRunningUi/renderCellResult-parret) MED TO BEVISSTE AVVIK:
    //
    //  1. Ingen ui.html mount-to-slot-purge før kjøring (sammenlign
    //     C.runCell sin egen '[data-ui-shown]'-sjekk rett før payload
    //     bygges, review-funn 15ce63c): den purgen eksisterer KUN for å
    //     hindre at en FULL rerun av SAMME celle stapler en ny ui.html-
    //     montering oppå en gammel i cellens slot (Ui sin generasjons-
    //     skopede _els-sveip i Ui.endCellRun ser den gamle data-ui-shown-
    //     noden som "i live" til den kobles fra). En seleksjonskjøring er
    //     per definisjon en DELVIS, ikke-kanonisk kjøring av cellen (se
    //     avvik 2 rett under) — et ui.html-element cellens ekte (fulle)
    //     kjøring har montert i denne sloten hører til DEN kjøringen og skal
    //     overleve en seleksjonskjøring urørt, akkurat som stale/ranOk-
    //     tilstanden skal. (Kjører seleksjonen selv en NY .show(), er
    //     utfallet det samme som om C.runCell aldri hadde purge-grenen i det
    //     hele tatt — en akseptert kant, ikke denne funksjonens ansvar å
    //     dekke.) Denne funksjonen deler INGEN kode med C.runCell sin
    //     purge-gren (egen funksjonskropp, ingen felles helper) — den kan
    //     derfor aldri "arve" data-ui-shown-utvidelsen ved et uhell; dette
    //     avviket dokumenterer bevisst UTELATELSEN, ikke en risiko.
    //  2. C._afterCellRun kalles ALDRI: et utvalg er ikke cellen — "partial
    //     run ≠ cell ran" (task-brief). En stale-tint cellen hadde FØR
    //     seleksjonskjøringen skal stå present ETTER den også (kjøring av
    //     tre linjer midt i en tolv-linjers celle sier ingenting om hvorvidt
    //     RESTEN av cellen fortsatt matcher det den viste resultatet), og en
    //     celle som ALDRI har kjørt i sin helhet skal fortsatt ikke telle som
    //     ranOk. Samme resonnement dekker Kjør-chip-skjulingen (den kanalen
    //     henger på _afterCellRun) — en seleksjonskjøring skal aldri skjule
    //     den.
    C.runSelection = function (idx, selText) {
      if (!NB.activeFlag) return Promise.resolve();
      var c = NB.cells[idx];
      if (!c) return Promise.resolve();
      if (global.mdIsScriptRunning && global.mdIsScriptRunning()) return Promise.resolve();
      var type = C.resolveType(c, NB.docMode);
      var kind = C.isCodeType(type) ? KIND_FOR_TYPE[type] : null;
      if (!kind) {
        flashHint(c._wrap);
        return Promise.resolve();
      }
      if (typeof global.mdRunNotebookCell !== 'function') return Promise.resolve();
      var blankedSel = blankTagLinesInText(selText);
      if (!blankedSel.trim()) {
        // Seleksjonen var kun tag-/direktivlinjer — ingenting å kjøre.
        // Bevisst no-op (før falt vi til HELE cellen via ||-fallbacken nedstrøms).
        return null;
      }
      var out = c._out;
      var payload = {
        kind: kind,
        text: C.execCellSource(c) || '',
        selText: blankedSel,
        uses: [],
        nb: { echo: false },
        cellIdx: idx
      };
      setRunningUi(idx, true);
      return global.mdRunNotebookCell(payload).then(function (res) {
        renderCellResult(idx, out, res);
      }, function (err) {
        renderCellResult(idx, out, { error: (err && err.message) || String(err) });
      }).then(function () {
        setRunningUi(idx, false);
      });
    };

    // Re-render en md/html-celles kropp PÅ PLASS (plan 4b Task 2: markørkjøring
    // over en ikke-kjørbar celle rendrer i stedet på nytt — samme handling som
    // dobbeltklikk-ut-av-redigering/blur ga i den gamle cellNode, og samme
    // gren docReconcile sin egen "kroppen ER resultatet"-oppdatering bruker
    // (se docReconcile over) — faktorert hit slik at BEGGE stiene kaller
    // NØYAKTIG samme rendring. No-op for kode-celler (ingenting å re-rendre —
    // C.runCell er den rette handlingen der) eller en celle uten et
    // tilkoblet sluk ennå.
    C.rerenderCell = function (idx) {
      var c = NB.cells[idx];
      if (!c || !c._out) return;
      var type = C.resolveType(c, NB.docMode);
      if (C.isCodeType(type)) return;
      renderNonCode(c._out, type, C.renderContent(c.source, type, c.sniffed));
    };

    // ---- markør↔slot-kobling (spec §5, plan 4b Task 3) ----
    // Speiler NB.activeCellIdx mot .doc-active på de rendrede cellenes
    // wrap-noder — samme "kun ett om gangen"-idempotens som nb-stale/
    // nb-running (fjern fra alle, legg til på den ene). Kalt BÅDE fra
    // C.setActiveCell (under, en tilstandsENDRING) OG fra docRender (en
    // REBYGGING — NB.cells' _wrap-referanser er da FERSKE noder som aldri
    // har hatt klassen, se docRender sitt eget reapply-kall) — derfor egen
    // funksjon, uten scrollIntoView (den hører kun til den faktiske
    // markørflyttingen, ikke til enhver rebygging som tilfeldigvis lander på
    // samme indeks).
    function applyActiveCellClass() {
      for (var i = 0; i < NB.cells.length; i++) {
        var c = NB.cells[i];
        if (!c || !c._wrap || !c._wrap.classList) continue;
        if (i === NB.activeCellIdx) c._wrap.classList.add('doc-active');
        else c._wrap.classList.remove('doc-active');
      }
    }

    // idx: celleindeks eller null/undefined (klarer aktiv celle). Idempotent
    // — samme idx to ganger endrer ingen klasser og scroller ikke på nytt
    // (scrollIntoView kjører KUN når idx faktisk endrer seg, task-brief: "on
    // CHANGE only"). scrollIntoView er guardet med typeof — stub-DOM-testenes
    // FakeEl har den ikke, samme mønster som resten av filen bruker for
    // browser-only DOM-metoder.
    C.setActiveCell = function (idx) {
      var next = (idx === null || idx === undefined) ? null : idx;
      var changed = next !== NB.activeCellIdx;
      NB.activeCellIdx = next;
      applyActiveCellClass();
      if (changed && next !== null) {
        var c = NB.cells[next];
        if (c && c._wrap && typeof c._wrap.scrollIntoView === 'function') {
          c._wrap.scrollIntoView({ block: 'nearest' });
        }
      }
    };

    function markStaleIfRan(idx) {
      if (!NB.ranOk[idx] || NB.stale[idx]) return;
      NB.stale[idx] = true;
      var c = NB.cells[idx];
      if (c && c._wrap) c._wrap.classList.add('nb-stale');
    }

    function clearAllStale() {
      var ranOk = {};
      for (var i = 0; i < NB.cells.length; i++) {
        ranOk[i] = true;
        var c = NB.cells[i];
        if (c && c._wrap) c._wrap.classList.remove('nb-stale');
        // Kjør-chip: "Kjør alle" (nå alltid restart-og-kjør-alle, se docBar)/
        // Forklar (Cells.beginRun, eneste kaller av denne funksjonen) regner
        // — akkurat som for
        // .nb-stale over — HELE kjøringen som frisk FØR selve løkka starter
        // (bevisst forenkling, se beginRun sin kommentar) — chippen for
        // enhver celle som måtte ha en, skjules derfor her, samtidig med
        // .nb-stale, ikke separat per fullført segment.
        if (global.ParamForms && typeof global.ParamForms.onCellRan === 'function') {
          global.ParamForms.onCellRan(i);
        }
      }
      NB.stale = {};
      NB.ranOk = ranOk;
    }

    // Kjørende-puls (Task 5, forenklet 2026-07-17): NB.restartBtn-
    // deaktiveringen setNbButtonsDisabled tidligere drev herfra (og fra
    // docRender()-tidens engangs-sjekk av mdIsScriptRunning()) er fjernet
    // sammen med Restart-knappen selv (se docBar) — .nb-running-klassen på
    // selve celle-wrapperen er igjen det eneste denne funksjonen gjør.
    function setRunningUi(idx, running) {
      var c = NB.cells[idx];
      if (c && c._wrap) c._wrap.classList.toggle('nb-running', running);
    }

    // Rendrer mdRunNotebookCell sitt resultat inn i ÉN celles output-node:
    // purge+innerHTML='' (replace-semantikk) før nytt innhold, akkurat som
    // renderOutput() gjør i index.html — kjørt gjennom window.mdRenderOutput
    // (samme buildOutputNodes) når den finnes, ellers en ren tekst-fallback
    // (brukt av node-testene, som ikke stubber mdRenderOutput).
    // {rparts} (fase B1 Task 4): R-kjøringer via captureR returnerer bilde-
    // bærende deler som ikke kan rundtures gjennom {text} uten å miste
    // plottene — rendres i stedet via window.renderROutputParts (samme
    // bygger som R-modusens fulle kjøring/Forklar bruker) rett inn i denne
    // cellens EGEN slot (target-parameteren, fase A Task 7).
    // {notice} (Task 4 carry-over-polering): dokumenterte begrensnings-
    // meldinger (R-celle i ikke-R-modus, microdata-celle i R-modus) er IKKE
    // feil — en rolig info-boks (.nb-notice), ikke rød pre.error.
    // {idx} (final-review F6): en strukturell re-rendring (render(), utløst
    // av f.eks. en samtidig contentLoaded/exit) kan skje MENS denne cellens
    // kjøring pågår — c._out fanget ved kjørestart er da en detached node
    // (fjernet fra DOM av render()'ens purge/gjenoppbygging), og et resultat
    // som skrives dit ville forsvinne stille. Requery cellens NÅVÆRENDE slot
    // via data-idx før rendring; finnes cellen ikke lenger, drop med warn
    // fremfor å kaste (kjøringen fullførte tross alt).
    function renderCellResult(idx, out, res) {
      if (out && !out.isConnected && NB.root) {
        out = NB.root.querySelector('.doc-cell[data-idx="' + idx + '"] .nb-output-body');
        if (!out) {
          console.warn('renderCellResult: celle', idx, 'finnes ikke lenger (strukturendring midt i kjøring) — resultat droppet');
          return;
        }
      }
      if (!out) return;
      // ui-html-fasen (Task 3-browserverifisering 2026-07-17, dash-absorpsjon
      // 5b: '[data-ui-shown]' er nå den ENESTE preserverte-innhold-
      // kontrakten): et ui.html.*-element montert via .show() (siste-uttrykk-
      // display-kroken, spec §2) — Ui.elShow (js/ui.js) merker noden med
      // data-ui-shown ved nettopp DENNE (target=null, slot-append) grenen —
      // kan ha blitt satt DIREKTE inn i `out` MENS scriptet nettopp kjørte
      // (window.mdUiRunCtx() pekte hit under selve kjøringen), altså FØR
      // dette kallet. Uten denne sjekken ville grenene under sitt ubetingede
      // purge(out); out.innerHTML = '' tømt akkurat den DOM-en som nettopp
      // ble satt inn, idet run-resultatet (tekst/notice/feil) rendres rett
      // etterpå (browser-verifisert: pyodide sin "Kjør alle" bruker en
      // append-only segmentløkke og rammes aldri av dette; brython/
      // micropython sin per-celle Cells.runCell-vei — DENNE funksjonen —
      // gjorde det, siden mdRenderOutput/renderOutput sin innerHTML=''-
      // tømming ikke visste om det ferske .show()-kallet).
      // R-celler setter aldri nbUiRunCtx (mountContainer-mønsteret gjaldt kun
      // dash, nå fjernet) — hasUiShown er derfor alltid false for R-celler,
      // res.rparts-grenen er dermed urørt.
      var hasUiShown = !!(out.querySelector && out.querySelector('[data-ui-shown]'));
      if (res && res.rparts) {
        // Paritet med pyodide/brython/mpy (Hans, 2026-07-18): per-celle ▶ på
        // en celle uten output etterlater sloten TOM — cellen forblir skjult
        // av tomcelle-regelen i app.css. «(ingen output)»-plassholderen
        // (buildROutputNodes' tomme-fallback) er forbeholdt plain-visningens
        // #outputArea, der eksplisitt feedback gir mening.
        if (!res.rparts.length || typeof global.renderROutputParts !== 'function') {
          purge(out);
          out.innerHTML = '';
        } else {
          global.renderROutputParts(res.rparts, out);
        }
      } else if (res && res.notice) {
        if (!hasUiShown) { purge(out); out.innerHTML = ''; }
        out.appendChild(el('pre', 'nb-notice', res.notice));
      } else if (res && res.error) {
        if (!hasUiShown) { purge(out); out.innerHTML = ''; }
        out.appendChild(el('pre', 'error', res.error));
      } else if (typeof global.mdRenderOutput === 'function') {
        if (hasUiShown && typeof global.mdAppendOutput === 'function') {
          global.mdAppendOutput((res && res.text) || '', out);
        } else {
          global.mdRenderOutput((res && res.text) || '', out);
        }
      } else if (hasUiShown) {
        // Node-testfallback uten global.mdRenderOutput: out.textContent = ''
        // ville uansett fjernet den monterte noden (textContent-setteren
        // tømmer ALLE barn) — legg til som en tekst-node i stedet for å
        // overskrive.
        if (res && res.text) out.appendChild(document.createTextNode(res.text));
      } else {
        purge(out);
        out.innerHTML = '';
        out.textContent = (res && res.text) || '';
      }
    }

    // Kort visuelt hint uten kjøring (md/html/skip-celler, ukjente
    // celletyper): flash-klasse fjernes selv igjen — ingen tilstand å rydde.
    function flashHint(wrapEl) {
      if (!wrapEl) return;
      wrapEl.classList.add('nb-cell-hint');
      var h = global.setTimeout(function () { wrapEl.classList.remove('nb-cell-hint'); }, 400);
      if (h && typeof h.unref === 'function') h.unref();
    }
  })();

  global.Cells = C;
  if (typeof module !== 'undefined' && module.exports) module.exports = C;
})(typeof window !== 'undefined' ? window : globalThis);
