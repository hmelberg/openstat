/* cells.js — notatbok-celler (spec: docs/superpowers/specs/2026-07-13-notebook-cells-design.md)
   Ren halvdel (øverst): #%%-parsing, serialisering, kjørbar-tekst-transform.
   Node-testet, ingen DOM. DOM-halvdel (nederst): notebook-rendrer. Kun browser.
   Kanonisk format er alltid ren tekst i #scriptInput — cellemodellen er avledet. */
(function (global) {
  'use strict';
  var C = {};

  // ---------- ren halvdel ----------

  var MARKER_RE = /^#\s?%%(?:\s+(.*))?\s*$/;
  var TYPES = ['python', 'r', 'duckdb', 'brython', 'micropython', 'microdata',
               'statx', 'md', 'html', 'skip'];
  var ALIASES = { py: 'python', pyodide: 'python', markdown: 'md', text: 'md' };
  var NONCODE = { md: 1, html: 1, skip: 1 };
  // slide/speak/rerun/sync er reservert for spec 2/3 — parses, brukes ikke ennå.
  // widgets (widget-plassering-fasen): styrer hvor .param-form/.ui-controls-
  // stripene havner i cellens .nb-output (se cellNode) — top|bottom|left,
  // default top når fraværende eller ugyldig (WIDGETS_POS under).
  var KNOWN_KEYS = { id: 1, style: 1, slide: 1, speak: 1, rerun: 1, sync: 1, widgets: 1 };
  var KNOWN_FLAGS = { 'hide-code': 1, 'hide-output': 1, slide: 1 };
  var STYLES = { note: 1, warn: 1, card: 1 };
  var WIDGETS_POS = { top: 1, bottom: 1, left: 1 };
  C.WIDGETS_POS = WIDGETS_POS;
  var ID_RE = /^[A-Za-z0-9_-]+$/;
  // Fase A: modusene der notebook-rendring og segmentkjøring er støttet.
  var SUPPORTED_MODES = { python: 1, r: 1, duckdb: 1, microdata: 1 };

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

  // Parse hele dokumentet → { cells, warnings }.
  // Celle: { type, attrs, headerRaw, headerLine, startLine, endLine, source, hasBody }
  //  - headerRaw === null: implisitt preambel (tekst før første markør)
  //  - source: linjene ETTER headeren t.o.m. linjen før neste markør
  //  - hasBody: om cellen hadde minst én kildelinje (skiller '#%% r' fra '#%% r\n')
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
  // segmentstøtte blankes. Linjetall bevares eksakt.
  C.executableSource = function (text, docMode) {
    if (!C.hasMarkers(text)) return String(text == null ? '' : text);
    var parsed = C.parseCells(text);
    var out = [];
    for (var i = 0; i < parsed.cells.length; i++) {
      var c = parsed.cells[i];
      if (c.headerRaw === null) { out.push(c.source); continue; }   // preambel kjører som den er
      var type = C.resolveType(c, docMode);
      var runnable = C.isCodeType(type) && !!SEG_MARKER[type];
      if (!runnable) { out.push(blankLike(C.cellBlock(c))); continue; }
      if (!c.hasBody && c.source === '') { out.push(SEG_MARKER[type]); continue; }
      out.push(SEG_MARKER[type] + '\n' + c.source);
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
  var KIND_FOR_TYPE = { python: 'pyodide', r: 'r', duckdb: 'duckdb', microdata: 'microdata' };
  C.KIND_FOR_TYPE = KIND_FOR_TYPE;

  // Celletype → #@param-språk (spec 2 W4, Task 2): python-familien (python +
  // aliasene pyodide/py normalisert til 'python' av resolveType, samt
  // brython/micropython som deler python-literal-syntaks: True/False,
  // enkelt-kvoterte strenger) skriver via formatLiteral(lang='python');
  // 'r' skriver TRUE/FALSE og støtter <- i tillegg til =. duckdb/microdata/
  // statx/md/html/skip har INGEN mapping her (null) — parse-gate per planens
  // Global Constraints ("microdata/duckdb cells: out of scope for W4"):
  // ParamForms.decorate hoppes bevisst over for disse celletypene, samme
  // "null → inert" prinsipp som KIND_FOR_TYPE bruker for ikke-kjørbare typer.
  var PARAM_LANG_FOR_TYPE = { python: 'python', brython: 'python', micropython: 'python', r: 'r' };
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
  C.forklarCellSteps = function (text, docMode) {
    var parsed = C.parseCells(text);
    var cells = parsed.cells;
    var codePlan = C.segmentPlan(text, docMode);
    var codeSet = {};
    for (var i = 0; i < codePlan.length; i++) codeSet[codePlan[i]] = true;
    var steps = [];
    for (var idx = 0; idx < cells.length; idx++) {
      if (codeSet[idx]) {
        steps.push({ kind: 'code', cellIdx: idx, source: cells[idx].source });
        continue;
      }
      var c = cells[idx];
      if (c.headerRaw === null) continue; // ikke-kjørbar preambel — intet steg
      if (C.resolveType(c, docMode) === 'md') {
        steps.push({ kind: 'md', cellIdx: idx, source: c.source });
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
               rawOverride: false, activeFlag: false, lastSerialized: null,
               plan: [], runSinks: null, runPlan: null, trailing: null, chip: null,
               editTimer: null, pendingFlush: null, tickHandle: null, lastUserInput: 0,
               lastTickValue: null, lastTickTime: 0, htmlTrusted: true,
               // Fase B1 Task 5: per-celle kjøring — "endret siden sist kjørt"
               // (stale) og "har kjørt OK minst én gang" (ranOk), keyet på
               // celleindeks; sesjonschip/Restart-knapp-referanser og en
               // engangs-vakt for onStateChange-abonnementet.
               stale: {}, ranOk: {}, sessionChip: null, restartBtn: null,
               sessionListenerAttached: false,
               // Fase B2 Task 1: 2-sekunders "Angre"-toast etter Slett celle
               // (task-1-brief: "instead of a confirm dialog"). Toasten er en
               // ENKELT closure-singleton (samme mønster som chip/sessionChip
               // over) — en ny sletting FØR forrige toasts 2s er omme erstatter
               // (ikke stabler) forrige toast, se showUndoToast.
               undoToast: null, undoTimer: null };

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
    // uavhengig av tick-heuristikken. Nytt dokument nullstiller Rå tekst-valget.
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
      NB.htmlTrusted = !(opts && opts.untrusted === true);
      NB.rawOverride = false;
      var ta = $('scriptInput');
      if (!ta) return;
      if (NB.activeFlag) { if (C.hasMarkers(ta.value)) render(); else C.exit(); }
      else if (C.hasMarkers(ta.value) && C.supportedMode(NB.docMode)) { C.enter(appLayout()); }
      else { updateChip(); }
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

    C.enter = function (layout) {
      var ta = $('scriptInput');
      if (!ta || !C.supportedMode(NB.docMode) || !C.hasMarkers(ta.value)) return false;
      var container = document.querySelector('.container');
      if (!container) return false;
      NB.activeFlag = true;
      NB.rawOverride = false;
      if (layout) NB.layout = layout;
      container.classList.add('nb-hidden');
      if (!NB.root) {
        NB.root = el('div', 'nb-root');
        NB.root.id = 'notebookRoot';
        container.parentNode.insertBefore(NB.root, container.nextSibling);
        // Kopier-knapper (tabell/pre/plotly) på resultater rendret inn i
        // celle-outputene, samme mekanisme som #outputArea (index.html).
        // MutationObserver mangler i test-harnessets lette DOM-fake — bare
        // ekte browsere (og jsdom) trenger/har denne forsterkningen.
        if (typeof global.MutationObserver === 'function') {
          new global.MutationObserver(function () {
            if (global.mdScheduleResultEnhance) global.mdScheduleResultEnhance();
          }).observe(NB.root, { childList: true, subtree: true });
        }
      }
      NB.root.hidden = false;
      render();
      updateChip();
      return true;
    };

    C.exit = function (opts) {
      if (opts && opts.raw) NB.rawOverride = true;
      NB.activeFlag = false;
      // Flush en ventende celle-redigerings-debounce FØR vi bytter til Rå
      // tekst (B2 Task 4-fiks, speiler toolbarGate over): en ren clearTimeout
      // her ville DROPPET siste <250ms med utaste tekst (skrevet, aldri
      // serialisert) — brukeren ville sett en gammel #scriptInput-tekst i Rå
      // tekst-visningen. flushPendingEdit() kansellerer timeren OG kjører den
      // ventende doFlush-lukningen synkront (samme serializeAndSync-vei som
      // runCell() allerede stoler på), så #scriptInput alltid speiler akkurat
      // det brukeren nettopp skrev, uansett når exit() kalles.
      flushPendingEdit();
      if (NB.root) { purge(NB.root); NB.root.hidden = true; }
      var container = document.querySelector('.container');
      if (container) container.classList.remove('nb-hidden');
      // Speil notatbokens layoutvalg tilbake til den underliggende skript-
      // visningen, så «Rå tekst» og senere re-inngang stemmer med siste valg.
      if (NB.layout === 'output') {
        if (global.mdSetInputHidden) global.mdSetInputHidden(true);
      } else {
        if (global.mdSetInputHidden) global.mdSetInputHidden(false);
        if (global.mdSetLayoutMode) global.mdSetLayoutMode(NB.layout);
      }
      if (global.updateLineNumbers) global.updateLineNumbers();
      if (global.refreshPlotlyAfterLayout) global.refreshPlotlyAfterLayout();
      updateChip();
    };

    C.setLayout = function (layout) {
      NB.layout = layout;
      if (NB.root) {
        NB.root.classList.remove('nb-layout-columns', 'nb-layout-stacked', 'nb-layout-output');
        NB.root.classList.add('nb-layout-' + layout);
        if (global.refreshPlotlyAfterLayout) global.refreshPlotlyAfterLayout();
        // W-issue 1 fiks: kolonne↔stablet endrer bredden .nb-src bryter
        // teksten mot (to kolonner vs. full bredde), så linjetallet — og
        // dermed nødvendig høyde — må regnes om for hver celle på nytt.
        autoSizeAll();
      }
    };

    C.refreshFromScript = function () { if (NB.activeFlag) render(); else updateChip(); };

    function render() {
      var ta = $('scriptInput');
      var parsed = C.parseCells(ta.value);
      NB.cells = parsed.cells;
      NB.lastSerialized = ta.value;
      NB.plan = C.segmentPlan(ta.value, NB.docMode);
      NB.runSinks = null; NB.runPlan = null; NB.trailing = null;
      // Fase B1 Task 5: struktur-endring er en ærlig reset av stale/ranOk —
      // cellene under er FRISKE objekter (nettopp parset), gamle stempler
      // (keyet kun på indeks) ville ellers feste seg til feil innhold.
      NB.stale = {}; NB.ranOk = {};
      purge(NB.root);
      NB.root.innerHTML = '';
      NB.root.className = 'nb-root nb-layout-' + NB.layout;
      var bar = el('div', 'nb-bar');
      var rawBtn = el('button', 'nb-raw-btn', t('Rå tekst'));
      rawBtn.type = 'button';
      rawBtn.title = t('Rediger notatboken som ren tekst');
      rawBtn.addEventListener('click', function () { C.exit({ raw: true }); });
      bar.appendChild(rawBtn);
      if (parsed.warnings.length) bar.appendChild(el('span', 'nb-warnings', parsed.warnings.join(' · ')));
      var sessionChip = el('span', 'nb-session-chip');
      NB.sessionChip = sessionChip;
      bar.appendChild(sessionChip);
      var restartBtn = el('button', 'nb-restart-btn', t('Restart & kjør alle'));
      restartBtn.type = 'button';
      restartBtn.title = t('Restart & kjør alle');
      restartBtn.addEventListener('click', onRestartClick);
      NB.restartBtn = restartBtn;
      bar.appendChild(restartBtn);
      NB.root.appendChild(bar);
      attachSessionListener();
      updateSessionChip();
      for (var i = 0; i < NB.cells.length; i++) NB.root.appendChild(cellNode(NB.cells[i], i));
      // Render-tidens engangs-sjekk (poll-fri per Task 5-kontrakten): fanger
      // et Kjør alle/Forklar-løp som allerede er i gang idet notatboken
      // (re-)rendres (f.eks. en strukturendring midt i en kjøring) — den
      // løpende synkroniseringen ellers skjer via setRunningUi (runCell) og
      // clearAllStale (beginRun), ikke via en ny poll-løkke.
      setNbButtonsDisabled(!!(global.mdIsScriptRunning && global.mdIsScriptRunning()));
      // W-issue 1 fiks: samlet autoSize-pass HELT på slutten av render(), når
      // NB.root garantert er vedlagt DOM-treet og synlig (C.enter setter
      // NB.root.hidden = false FØR render() kalles, se over) — se
      // autoSizeAll for hvorfor det tidligere per-celle rAF-kallet i
      // cellNode ikke var pålitelig ved (re-)inngang.
      autoSizeAll();
    }

    function cellNode(c, idx) {
      var type = C.resolveType(c, NB.docMode);
      var nonCode = !C.isCodeType(type);
      var wrap = el('div', 'nb-cell');
      wrap.dataset.idx = String(idx);
      if (c.attrs.style && /^(note|warn|card)$/.test(c.attrs.style)) wrap.classList.add('nb-style-' + c.attrs.style);
      if (type === 'skip') wrap.classList.add('nb-skip');
      if (nonCode) wrap.classList.add('nb-noncode');
      if (c.attrs['hide-code']) wrap.classList.add('nb-hide-code');
      if (c.attrs['hide-output']) wrap.classList.add('nb-hide-output');

      var input = el('div', 'nb-input');
      c._input = input;
      var head = el('div', 'nb-head');
      head.appendChild(el('span', 'nb-type', type + (c.attrs.id ? ' · ' + c.attrs.id : '')));
      // Kjøreknapp per kode-celle (Task 5): fraværende for md/html/skip
      // (samme "nonCode"-flagg som resten av cellen bruker).
      if (!nonCode) {
        var runBtn = el('button', 'nb-runbtn', '▶');
        runBtn.type = 'button';
        runBtn.title = t('Kjør denne cellen');
        runBtn.addEventListener('click', function () { C.runCell(idx); });
        head.appendChild(runBtn);
        c._runBtn = runBtn;
      }
      input.appendChild(head);
      var ta = el('textarea', 'nb-src');
      ta.value = c.source;
      ta.spellcheck = false;
      ta.addEventListener('input', function () { autoSize(ta); onEdit(idx, ta.value); });
      ta.addEventListener('keydown', function (ev) { onSrcKeydown(ev, idx); });
      input.appendChild(ta);
      c._ta = ta;

      // Widget-plassering-fasen: .nb-output er nå en WRAPPER, ikke selve
      // sluket. Den inneholder (i FAST DOM-rekkefølge, uansett plassering):
      // .param-form? (ParamForms.decorate, under), .ui-controls? (js/ui.js
      // sin _ensureStrip, satt inn ved kjøring), og til slutt
      // .nb-output-body — SLUKET all kjøre-output/purge/rendring skjer mot
      // (renderCellResult, beginRun, sinkForSegment/errorHost, dash sin
      // mountContainer). Stripene lever DERMED strukturelt utenfor
      // .nb-output-body og overlever enhver output-purge helt uten egen
      // preserve-logikk. widgets=top|bottom|left (default top, se
      // WIDGETS_POS) er REN CSS: DOM-rekkefølgen over er alltid den samme,
      // kun `order`/flex-direction (app.css) styrer om stripene havner over,
      // under eller til venstre for kroppen — js/cells.js, js/ui.js og
      // js/param-forms.js forblir alle plasserings-agnostiske.
      var out = el('div', 'nb-output');
      var widgetsPos = WIDGETS_POS[c.attrs.widgets] ? c.attrs.widgets : 'top';
      out.classList.add('nb-widgets-' + widgetsPos);
      var body = el('div', 'nb-output-body');
      out.appendChild(body);
      if (nonCode && type !== 'skip') {
        wrap.classList.add('nb-rendered-only');
        renderNonCode(body, type, c.source);
        body.title = t('Dobbeltklikk for å redigere');
        var enterEdit = function () {
          wrap.classList.remove('nb-rendered-only');
          autoSize(ta); ta.focus();
        };
        body.addEventListener('dblclick', enterEdit);
        var editBtn = el('button', 'nb-edit-btn', '✎');
        editBtn.type = 'button';
        editBtn.title = t('Dobbeltklikk for å redigere');
        editBtn.addEventListener('click', enterEdit);
        wrap.appendChild(editBtn);
        ta.addEventListener('blur', function () {
          renderNonCode(body, type, ta.value);
          wrap.classList.add('nb-rendered-only');
        });
      }
      wrap.appendChild(input);
      wrap.appendChild(out);
      // (Ingen per-celle rAF-autoSize her lenger — W-issue 1 fiks: se
      // autoSizeAll, kalt samlet fra render() sin hale i stedet, ETTER at
      // .nb-root faktisk er synlig/i DOM-treet.)
      // Direkte DOM-referanser for enkelt-celle-kjøring (Task 2): runCell(idx)
      // vet allerede nøyaktig hvilken celle den kjører, så et querySelector-
      // oppslag mot NB.root (som beginRun/sinkForSegment bruker for segment-
      // JUSTERT plan-indeksering) er unødvendig her — cellens egen node holdes.
      // c._out peker på .nb-output-body (SLUKET), ikke wrapperen — all
      // run-output-skriving (renderCellResult, dash mount-to-slot-sjekken
      // under) er dermed body-scoped by construction.
      c._out = body;
      c._wrap = wrap;
      // Post-build seam (spec 2 W4, Task 2): #@param-skjema-stripe. Kun for
      // celletyper ParamForms faktisk vet hvordan den skal skrive literaler
      // for (paramLangForType → null for duckdb/microdata/statx/md/html/skip
      // — parse-gate per planens Global Constraints). js/param-forms.js sin
      // egen _build/_insertStrip finner `.nb-output` inni `wrap` og setter
      // stripa inn der (FØR en evt. .ui-controls, alltid FØR .nb-output-body)
      // — ParamForms.reorder-hacken (fase 2 W4) er borte: rekkefølgen er nå
      // strukturell, ikke noe som må reasserteres etter hver kjøring.
      var paramLang = C.paramLangForType(type);
      if (paramLang && global.ParamForms && typeof global.ParamForms.decorate === 'function') {
        global.ParamForms.decorate(idx, wrap, c.source, paramLang);
      }
      wrap.appendChild(buildToolbar(c, idx, type));
      return wrap;
    }

    // Fase B2 Task 1: hover/focus-within-verktøylinje for strukturelle
    // operasjoner. Absolutt posisjonert (se app.css .nb-tools) — bevisst
    // UTENFOR .nb-cell sitt grid-flow, slik at den ikke forstyrrer
    // ParamForms/Ui sine "jeg er alltid FØRSTE barn"-antakelser (deres
    // striper settes inn via insertBefore(wrap.firstChild), som denne
    // ordinære appendChild-en ved slutten av cellNode aldri kolliderer med).
    // Hver knapp: ren transform (js/cells.js sin egen C.*-funksjon) →
    // #scriptInput → full render() → fokus tilbake på berørt celles
    // tekstfelt — nøyaktig oppskriften fra spec/task-1-brief.
    function buildToolbar(c, idx, type) {
      var tools = el('div', 'nb-tools');
      // Alle interaktive verktøylinje-elementer samles på celleobjektet så
      // setNbButtonsDisabled kan deaktivere dem under en kjøring (B2-review,
      // Important) — samme livssyklus som c._runBtn. Grense-deaktiverte
      // knapper (↑ på første, ↓ på siste) markeres med _staticDisabled slik
      // at re-aktiveringen etter kjøringen ikke ved et uhell slår dem PÅ.
      c._toolEls = [];
      function track(node, staticDisabled) {
        if (staticDisabled) { node.disabled = true; node._staticDisabled = true; }
        c._toolEls.push(node);
        tools.appendChild(node);
        return node;
      }
      function toolBtn(cls, label, title, handler) {
        var b = el('button', 'nb-tool-btn ' + cls, label);
        b.type = 'button';
        b.title = title;
        b.addEventListener('click', handler);
        return b;
      }
      track(toolBtn('nb-tool-add-above', '+▲', t('Legg til celle over'),
        function () { toolbarInsert(idx - 1, type); }));
      track(toolBtn('nb-tool-add-below', '+▼', t('Legg til celle under'),
        function () { toolbarInsert(idx, type); }));
      track(toolBtn('nb-tool-up', '↑', t('Flytt celle opp'), function () { toolbarMove(idx, -1); }),
        idx === 0);
      track(toolBtn('nb-tool-down', '↓', t('Flytt celle ned'), function () { toolbarMove(idx, 1); }),
        idx === NB.cells.length - 1);
      track(toolBtn('nb-tool-split', '✂', t('Del celle ved markøren'),
        function () { toolbarSplit(idx); }));
      // Type-bytte og slå-sammen-med-forrige gir ingen mening for den
      // underforståtte preambel-cellen (headerRaw null — ingen header-linje å
      // skrive om, og ingen "forrige" som ikke allerede ER den — de rene
      // transformene no-op'er begge her uansett, men UI-et utelater dem helt
      // i stedet for å tilby en knapp som alltid feiler stille).
      if (c.headerRaw !== null) {
        track(toolBtn('nb-tool-merge', '⤒', t('Slå sammen med forrige celle'),
          function () { toolbarMerge(idx); }), idx === 0);

        var typeSel = el('select', 'nb-tool-type');
        typeSel.title = t('Bytt celletype');
        TYPES.forEach(function (ty) {
          var opt = el('option', null, ty);
          opt.value = ty;
          typeSel.appendChild(opt);
        });
        typeSel.value = type;
        typeSel.addEventListener('change', function () { toolbarChangeType(idx, typeSel.value); });
        track(typeSel);
      }
      track(toolBtn('nb-tool-delete', '🗑', t('Slett celle'), function () { toolbarDelete(idx); }));
      return tools;
    }

    // Sett cellens fremdriftsindeks etter en strukturell operasjon: fokuser
    // dens tekstfelt, og — hvis oppgitt — plasser markøren på cursorPos
    // (tegnoffset inn i cellens NYE kilde). setSelectionRange finnes ikke på
    // test-harnessets lette DOM-stub — vaktet, ekte nettlesere har den alltid.
    function focusCellAt(targetIdx, cursorPos) {
      var c = NB.cells[targetIdx];
      if (!c || !c._ta) return;
      c._ta.focus();
      if (cursorPos != null && typeof c._ta.setSelectionRange === 'function') {
        c._ta.setSelectionRange(cursorPos, cursorPos);
      }
    }

    // Felles hale for enhver strukturell verktøylinje-operasjon som FAKTISK
    // endret noe: skriv den nye teksten til #scriptInput, hold linjenumrene
    // synkront (samme kall som serializeAndSync gjør), full re-rendring
    // (struktur-endring = rebuild, per spec), gjenopprett fokus. Selve
    // pure-transformen + no-op-sjekken (result.cells === NB.cells → uendret
    // referanse, se js/cells.js sin ren halvdel) gjøres av HVER kaller for
    // seg, siden hver operasjon har sin egen no-op-begrunnelse (flashHint) og
    // sitt eget fokusmål.
    function commitStructuralOp(newCells) {
      var ta = $('scriptInput');
      ta.value = C.serializeCells(newCells);
      if (global.updateLineNumbers) global.updateLineNumbers();
      render();
    }

    // Felles PORT for enhver strukturell verktøylinje-operasjon (B2-review,
    // Important + Minor) — kalt FØRST i hver handler, FØR NB.cells leses:
    //  1. Kjøre-guard (speiler C.runCell/onRestartClick sin egen sjekk):
    //     en strukturell render() midt i et Kjør alle-løp river vekk
    //     .nb-output-nodene kjøringen ruter inn i (F6-faren) — stille
    //     avvisning, akkurat som runCell.
    //  2. flushPendingEdit (speiler runCell sin "skriv → kjør"-disiplin):
    //     en armert 250ms-redigeringsdebounce ville ellers kunne fyre ETTER
    //     den strukturelle re-rendringen — mot en closure-fanget idx som nå
    //     peker på en annen (eller fjernet) celle — og re-serialisere gammel
    //     tilstand over det ferske dokumentet. Flushen anvender redigeringen
    //     synkront NÅ, så transformen under opererer på den ferskeste kilden.
    function toolbarGate() {
      if (global.mdIsScriptRunning && global.mdIsScriptRunning()) return false;
      flushPendingEdit();
      return true;
    }

    function toolbarInsert(afterIdx, type) {
      if (!toolbarGate()) return;
      // Speil insertCellAfter sitt preambel-vern for FOKUS-målet: «over
      // preambelen» klemmes til «rett etter preambelen» i den rene halvdelen
      // (se insertCellAfter) — den nye cellen lander da på indeks 1, ikke 0.
      if (afterIdx === -1 && NB.cells.length && NB.cells[0].headerRaw === null) afterIdx = 0;
      var r = C.insertCellAfter(NB.cells, afterIdx, type);
      commitStructuralOp(r.cells);
      focusCellAt(afterIdx + 1, 0);
    }

    function toolbarMove(idx, dir) {
      if (!toolbarGate()) return;
      var wrapBefore = NB.cells[idx] && NB.cells[idx]._wrap;
      var r = C.moveCell(NB.cells, idx, dir);
      if (r.cells === NB.cells) { flashHint(wrapBefore); return; }
      commitStructuralOp(r.cells);
      focusCellAt(idx + dir, null);
    }

    function toolbarSplit(idx) {
      if (!toolbarGate()) return;
      var c = NB.cells[idx];
      var wrapBefore = c && c._wrap;
      var offset = 0;
      if (c && c._ta) {
        var pos = c._ta.selectionStart || 0;
        offset = String(c._ta.value).slice(0, pos).split('\n').length - 1;
      }
      var r = C.splitCell(NB.cells, idx, offset);
      if (r.cells === NB.cells) { flashHint(wrapBefore); return; }
      commitStructuralOp(r.cells);
      focusCellAt(idx + 1, 0);
    }

    function toolbarMerge(idx) {
      if (!toolbarGate()) return;
      var prev = NB.cells[idx - 1];
      // Fokuser markøren PÅ SAMMENFØYNINGSPUNKTET (slutten av forrige celles
      // ORIGINALE kilde — fanget FØR operasjonen muterer NB.cells) — ikke
      // slutten av den ferdig sammenslåtte teksten. Speiler mergeWithPrevious
      // sin egen kombineringslogikk (se js/cells.js): prev uten kropp bidrar
      // ingen tegn, så sømmen er da posisjon 0.
      var seamPos = prev && prev.hasBody ? String(prev.source).length : 0;
      var wrapBefore = NB.cells[idx] && NB.cells[idx]._wrap;
      var r = C.mergeWithPrevious(NB.cells, idx);
      if (r.cells === NB.cells) { flashHint(wrapBefore); return; }
      commitStructuralOp(r.cells);
      focusCellAt(idx - 1, seamPos);
    }

    function toolbarChangeType(idx, newType) {
      if (!toolbarGate()) return;
      var wrapBefore = NB.cells[idx] && NB.cells[idx]._wrap;
      var r = C.changeCellType(NB.cells, idx, newType);
      if (r.cells === NB.cells) { flashHint(wrapBefore); return; }
      commitStructuralOp(r.cells);
      focusCellAt(idx, null);
    }

    // Slett celle: INGEN confirm-dialog (task-1-brief: "less friction, text
    // is canonical anyway") — i stedet en 2-sekunders flytende "Angre"-toast
    // som gjenoppretter den PRE-operasjon-serialiserte teksten byte-for-byte
    // (samme tekst NB.lastSerialized pekte på RETT FØR denne slettingen).
    function toolbarDelete(idx) {
      if (!toolbarGate()) return;
      var preOpText = NB.lastSerialized;
      var r = C.deleteCell(NB.cells, idx);
      if (r.cells === NB.cells) { flashHint(NB.cells[idx] && NB.cells[idx]._wrap); return; }
      commitStructuralOp(r.cells);
      focusCellAt(Math.min(idx, NB.cells.length - 1), null);
      showUndoToast(preOpText);
    }

    // Flytende Angre-knapp (2s, se toolbarDelete): closure-singleton (samme
    // "kun én om gangen"-mønster som NB.chip/NB.sessionChip) — en ny sletting
    // FØR forrige toasts tidsavbrudd erstatter den (ingen stabling). Selve
    // klikket setter #scriptInput tilbake til preOpText BYTE-FOR-BYTE og
    // rendrer på nytt — ingen egen gjenopprettings-logikk, samme
    // sett-verdi-og-render()-oppskrift som resten av verktøylinjen.
    function showUndoToast(preOpText) {
      hideUndoToast();
      var toast = el('div', 'nb-undo-toast');
      toast.appendChild(el('span', 'nb-undo-label', t('Celle slettet')));
      var btn = el('button', 'nb-undo-btn', t('Angre'));
      btn.type = 'button';
      btn.addEventListener('click', function () {
        var ta = $('scriptInput');
        ta.value = preOpText;
        if (global.updateLineNumbers) global.updateLineNumbers();
        render();
        hideUndoToast();
      });
      toast.appendChild(btn);
      NB.root.appendChild(toast);
      NB.undoToast = toast;
      var h = global.setTimeout(function () { hideUndoToast(); }, 2000);
      if (h && typeof h.unref === 'function') h.unref();
      NB.undoTimer = h;
    }

    function hideUndoToast() {
      if (NB.undoTimer) { global.clearTimeout(NB.undoTimer); NB.undoTimer = null; }
      if (NB.undoToast) { NB.undoToast.remove(); NB.undoToast = null; }
    }

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
      if (NB.activeFlag && NB.root) render();
    };

    // W-issue 1 fiks: klem inline-høyden til samme tak som CSS-en (.nb-src
    // max-height, app.css) bruker. CSS-en alene ville uansett klemt visningen
    // (max-height vinner alltid over en inline height-verdi), men vi klemmer
    // OGSÅ her i JS slik at vi aldri skriver en urimelig stor inline height
    // (unødvendig reflow-kostnad for en 200-linjers celle vi vet blir klippet
    // ned igjen av CSS-en likevel). Holdes i sync med .nb-src { max-height }.
    var NB_SRC_MAX_PX = 420;

    function autoSize(ta) {
      if (!ta) return;
      ta.style.height = 'auto';
      var h = Math.min(ta.scrollHeight + 2, NB_SRC_MAX_PX);
      ta.style.height = h + 'px';
    }

    // Kjør autoSize over ALLE celletekstfelt i én omgang (W-issue 1 fiks).
    // Erstatter en tidligere per-celle rAF-kall ved cellNode-bygging: et
    // enkelt-celle-kall som fyrer FØR .nb-root faktisk er lagt ut/synlig
    // (skjult container midt i enter(), fonter ikke ferdig lastet, eller
    // display:none akkurat idet rAF-en kjører) leser scrollHeight som 0/feil
    // — resultatet var en for lav tekstboks med indre scroll i stedet for å
    // vise hele cellens kode. Kalles i stedet FRA HALEN av render()/enter()
    // (NB.root er da allerede satt synlig og satt inn i DOM-treet, se
    // C.enter over) og fra setLayout (kolonne↔stablet endrer bredden
    // teksten brytes mot, så linjetallet — og dermed høyden — må regnes om).
    // To nøstede rAF-lag: én ekstra frame etter innsetting fanger opp
    // tilfeller der layout/fonter fortsatt ikke er helt klare i den aller
    // første (samme forsiktighet som spesifikasjonen ber om).
    function autoSizeAllNow() {
      for (var i = 0; i < NB.cells.length; i++) {
        if (NB.cells[i]._ta) autoSize(NB.cells[i]._ta);
      }
    }
    function autoSizeAll() {
      requestAnimationFrame(function () {
        autoSizeAllNow();
        requestAnimationFrame(autoSizeAllNow);
      });
    }

    // Fase B1 Task 5: Shift+Enter = kjør + hopp til NESTE kode-celle (ingen
    // auto-opprettelse av en hale-celle ennå); Ctrl/Cmd+Enter = kjør på
    // stedet (fokus urørt). preventDefault KUN for disse to kombinasjonene —
    // vanlig Enter (linjeskift i cellen) er helt upåvirket. Gjelder KUN
    // kodeceller (samme port som kjøreknappen): i en md/html/skip-celles
    // editor (etter dblclikk) er Shift+Enter et vanlig linjeskift — uten
    // denne vakten ville preventDefault sluke linjeskiftet og Shift+Enter
    // rykke fokus til neste kodecelle midt i skrivingen.
    function onSrcKeydown(ev, idx) {
      if (ev.key !== 'Enter') return;
      var c = NB.cells[idx];
      if (!c || !C.isCodeType(C.resolveType(c, NB.docMode))) return;
      var mod = ev.ctrlKey || ev.metaKey;
      if (mod) {
        ev.preventDefault();
        C.runCell(idx);
      } else if (ev.shiftKey) {
        ev.preventDefault();
        C.runCell(idx);
        focusNextCodeCell(idx);
      }
    }

    // Neste KODE-celle (md/html/skip hoppes over — de har ingen kjørbar
    // tekstflate å lande fokus i som gir mening her). Siste celle / ingen
    // flere kode-celler → behold fokus i inneværende (spec: ingen auto-
    // opprettet hale-celle i fase B1).
    function focusNextCodeCell(idx) {
      for (var i = idx + 1; i < NB.cells.length; i++) {
        var c = NB.cells[i];
        var type = C.resolveType(c, NB.docMode);
        // Hopp over celler med skjult editor (hide-code) — focus() på et
        // usynlig felt gjør ingenting, og markøren ville "forsvinne".
        if (C.isCodeType(type) && c._ta && !c.attrs['hide-code']) { c._ta.focus(); return; }
      }
    }

    // Serialiser NB.cells → #scriptInput + oppdater plan/linjenummer. Felles
    // kjerne mellom onEdit sin debouncede flush og updateCellSource (Task 2)
    // sitt UMIDDELBARE (ikke-debouncede) skriv — begge ender opp med å måtte
    // gjøre nøyaktig det samme etter at NB.cells er mutert (spec §Task 2:
    // "reuse the existing flush path — read onEdit/flushPendingEdit and
    // factor or call").
    function serializeAndSync() {
      var ta = $('scriptInput');
      var text = C.serializeCells(NB.cells);
      NB.lastSerialized = text;
      ta.value = text;
      NB.plan = C.segmentPlan(text, NB.docMode);
      if (global.updateLineNumbers) global.updateLineNumbers();
      return text;
    }

    function onEdit(idx, value) {
      var c = NB.cells[idx];
      c.source = value;
      c.hasBody = true;
      // SYNKRON kildesynk mot skjema-tilstanden (W4 review-fiks 1a,
      // krysskanal-race): ParamForms sitt splice-grunnlag (st.source +
      // st.entries med ferske lineIdx-er) må følge HVERT tastetrykk, ikke
      // 250ms-debouncen under — ellers ville en skjema-kontroll avfyrt
      // INNENFOR debounce-vinduet splice inn i en foreldet kilde og stille
      // miste nettopp-skrevet tekst (repro: skriv `y = 1` på linja over en
      // #@param-slider, dra slideren < 250ms etter). syncSource er DOM-fri
      // og billig (ren re-parse av én celles tekst); den VISUELLE
      // oppdateringen av kontrollene hører fortsatt til refresh i doFlush.
      if (global.ParamForms && typeof global.ParamForms.syncSource === 'function') {
        global.ParamForms.syncSource(idx, value);
      }
      markStaleIfRan(idx);
      if (NB.editTimer) { clearTimeout(NB.editTimer); NB.editTimer = null; }
      // Selve flush-kroppen holdes i en navngitt lukning (NB.pendingFlush) i
      // tillegg til å være setTimeout-callbacken, slik at runCell() kan
      // trigge AKKURAT samme logikk synkront (flushPendingEdit) uten å vente
      // på debouncen — "skriv → kjør" skal alltid kjøre det du nettopp skrev.
      var doFlush = function () {
        NB.editTimer = null;
        NB.pendingFlush = null;
        serializeAndSync();
        // GJELDENDE kilde, ikke den closure-fangede `value` (W4 review-fiks
        // 1b): en skjema-kontroll kan ha kalt Cells.updateCellSource (og
        // dermed endret c.source) ETTER tastetrykket som armerte denne
        // debouncen men FØR den fyrte — å flushe med den fangede verdien
        // ville da rulle skjemaets tilstand tilbake til før kontroll-
        // endringen og desynke videre. serializeAndSync() over serialiserte
        // allerede nettopp c.source; refresh/markør-skanningen under må se
        // NØYAKTIG samme tekst.
        var cur = NB.cells[idx] ? NB.cells[idx].source : value;
        // Manuell tekst-redigering (Task 2): re-parse cellens #@param-linjer
        // og oppdater skjema-kontrollene i place — IKKE synkront per
        // tastetrykk (ville vært distraherende midt i skriving), men her,
        // hooket på AKKURAT samme 250ms-debounce som resten av flush-en,
        // slik planen ber om. Strukturelle endringer (linje lagt til/fjernet,
        // type endret) bygger stripa på nytt inni ParamForms.refresh selv —
        // cells.js trenger ikke vite forskjellen.
        if (global.ParamForms && typeof global.ParamForms.refresh === 'function') {
          global.ParamForms.refresh(idx, cur);
        }
        // Skrev brukeren en ny #%%-markør inni cellen? Da har strukturen
        // endret seg — full re-rendring (bevisst handling, fokus-hopp ok).
        var lines = String(cur).split('\n');
        for (var i = 0; i < lines.length; i++) {
          if (C.isMarkerLine(lines[i])) { render(); return; }
        }
      };
      NB.pendingFlush = doFlush;
      NB.editTimer = setTimeout(doFlush, 250);
    }

    // Cells.updateCellSource(idx, newSource) (spec 2 W4, Task 2): den
    // PROGRAMMATISKE motparten til onEdit — brukt av ParamForms når en
    // skjema-kontroll endrer verdi (control → writeValue → HIT). I motsetning
    // til onEdit (drevet av en ekte 'input'-DOM-hendelse på cellens egen
    // textarea) MÅ denne selv synkronisere den synlige textareaen (c._ta) —
    // å sette .value programmatisk fyrer ALDRI en 'input'-hendelse, så uten
    // denne linja ville brukeren dratt en slider og sett cellens Python-tekst
    // henge igjen uendret til neste manuelle redigering.
    //
    // KRITISK ingen-ombygging-disiplin (samme prinsipp som js/ui.js sin
    // _updateControlSpec): INGEN rebuild av celle-noden her — kun c._ta.value
    // + autoSize i place. En slider midt i en drag ville ellers blitt revet
    // ned av sin EGEN endring (control → updateCellSource → en hypotetisk
    // rebuild → ny DOM-node → dragens 'input'-lytter peker på en fjernet
    // node). c._out/output røres ikke i det hele tatt (ingen kjøring skjedde).
    //
    // Kaller til slutt ParamForms.refresh(idx, newSource) (guardet) — IKKE
    // for å lukke en loop tilbake til onEdit (updateCellSource fyrer aldri en
    // 'input'-hendelse på c._ta, så onEdit sin debounce trigges ALDRI av
    // dette kallet — ingen sirkularitet finnes), men fordi updateCellSource
    // er et generelt Cells-API som i prinsippet kan kalles av annet enn
    // ParamForms selv: skjemaet skal uansett reflektere den nyeste kilden.
    // ParamForms.refresh sin egen "no-op når verdien allerede stemmer"-vakt
    // (se js/param-forms.js) gjør AKKURAT dette kallet en trygg no-op for
    // kontrollen som selv utløste endringen (formatLiteral→currentValue
    // rundtures byte-nøyaktig til samme typede verdi) — den drasende
    // slideren sin range-input røres dermed ALDRI av dette tilbakekallet.
    C.updateCellSource = function (idx, newSource) {
      var c = NB.cells[idx];
      if (!c) return;
      c.source = newSource;
      c.hasBody = true;
      if (c._ta) { c._ta.value = newSource; autoSize(c._ta); }
      markStaleIfRan(idx);
      serializeAndSync();
      if (global.ParamForms && typeof global.ParamForms.refresh === 'function') {
        global.ParamForms.refresh(idx, newSource);
      }
    };

    // Kjør cellens ventende redigering (250ms debounce) SYNKRONT — kalt fra
    // runCell() FØR kjøringen leser #scriptInput, slik at index.html sin
    // segmentoppløsning (full-dokument, cellIdx → segment) alltid ser den
    // ferskeste kildeteksten, ikke en som henger igjen til debouncen fyrer.
    function flushPendingEdit() {
      if (!NB.editTimer) return;
      clearTimeout(NB.editTimer);
      NB.editTimer = null;
      var fn = NB.pendingFlush;
      NB.pendingFlush = null;
      if (fn) fn();
    }

    // Én tikker: aktiv → fang programmatiske endringer i #scriptInput
    // (eksempler/AI setter .value uten input-event); inaktiv → vis/skjul hint.
    function tick() {
      var ta = $('scriptInput');
      if (!ta) return;
      var v = ta.value;
      if (NB.activeFlag) {
        if (v !== NB.lastSerialized) {
          if (C.hasMarkers(v)) render();
          else C.exit();
        }
      } else if (v !== NB.lastTickValue && NB.lastUserInput < NB.lastTickTime &&
                 C.hasMarkers(v) && C.supportedMode(NB.docMode) && !NB.rawOverride) {
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
          NB.rawOverride = false;
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
      // besteforelder er cellens .nb-cell-wrap (body → .nb-output → .nb-cell).
      var outs = NB.root.querySelectorAll('.nb-cell .nb-output-body');
      for (var i = 0; i < outs.length; i++) {
        var cellEl = outs[i].parentNode && outs[i].parentNode.parentNode;
        if (cellEl && cellEl.classList.contains('nb-noncode')) continue;   // md/html beholder rendringen
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
        var node = NB.root.querySelector('.nb-cell[data-idx="' + plan[s] + '"] .nb-output-body');
        NB.runSinks.push(node || null);
      }
      return NB.runSinks;
    };

    C.sinkForSegment = function (i) {
      if (NB.runSinks && NB.runSinks[i]) return NB.runSinks[i];
      return C.errorHost();
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

    // Celleindeks → gjeldende DOM-node (Task 2, ui-widgets W1): brukes av
    // window.mdUiRunCtx() sin cellEl-oppslag. Querier NB.root direkte (samme
    // '.nb-cell[data-idx="…"]'-mønster som beginRun bruker) i stedet for å
    // cache en referanse — cellens node byttes ut ved enhver struktur-
    // re-rendring (final-review F6-mønsteret), en frisk oppslag er alltid
    // korrekt. null når notatboken ikke har en rendret rot, eller idx mangler.
    C.cellElementAt = function (idx) {
      if (!NB.root) return null;
      return NB.root.querySelector('.nb-cell[data-idx="' + idx + '"]') || null;
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
      flushPendingEdit();
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
      var out = c._out;
      // dash mount-to-slot (fase B2 Task 4b, se js/dash.js sin mountContainer()):
      // en enkelt-celle-rerun kjører KUN mot DENNE cellens .nb-output — ulikt
      // "Kjør alle" (Cells.beginRun purger ALLE sluk FØR segmentløkka, se over)
      // tømmes ikke denne sloten før hvert runCell-kall i dag. Hvis forrige
      // kjøring i AKKURAT denne cellen bygde et dashboard, står den <div
      // class="dash">-roten fortsatt tilkoblet DOM-en ved rerun-start —
      // D.create() sin egen lazy sweepDisconnected() ser den derfor som "i
      // live", og en NY dashboard()-celle ville STAPLE en ny rot oppå den
      // gamle i samme slot i stedet for å erstatte den (browser-verifisert).
      // Gated på ".dash"-tilstedeværelse (IKKE et ubetinget purge+clear, slik
      // mdRunNotebookCell sin #outputArea-tømming er) — #outputArea er aldri
      // synlig for vanlig tekst-/plott-output, så en ubetinget tømming der er
      // alltid virkningsløs for andre celletyper; .nb-output er derimot den
      // SYNLIGE sloten for ALLE celletyper, så en ubetinget tømming her ville
      // flimret/skjult forrige resultat ved hver rerun av en helt vanlig
      // (ikke-dashboard) celle. Eksplisitt sweepDisconnected()-kall rett
      // etter, samme par-begrunnelse som mdRunNotebookCell sin #outputArea-
      // sweep: uten det ville registeroppføringen henge igjen til et
      // vilkårlig FREMTIDIG dashboard()-kall et annet sted i dokumentet.
      if (out && out.querySelector && out.querySelector('.dash')) {
        purge(out);
        out.innerHTML = '';
        if (global.Dash && typeof global.Dash.sweepDisconnected === 'function') global.Dash.sweepDisconnected();
      }
      var payload = {
        kind: kind,
        text: c.source || '',
        uses: [],
        // Eksplisitt celle (spec §4 "Display policy"): echo av, kun siste
        // uttrykk vises — index.html overstyrer/dropper dette selv når
        // dokumentet har '#options.display = all' (leses fra HELE dokumentet,
        // aldri fra cellen).
        nb: { echo: false, last: true },
        cellIdx: idx
      };
      // Task 5: kjøre-livssyklusen driver BÅDE den kjørende cellens
      // .nb-running-puls OG deaktivering av ALLE kjøreknapper + Restart —
      // poll-fritt, symmetrisk start/slutt-par (ingen finally() avhengighet:
      // begge then-grenene under fullfører alltid uten å kaste videre).
      setRunningUi(idx, true);
      return global.mdRunNotebookCell(payload).then(function (res) {
        renderCellResult(idx, out, res);
        C._afterCellRun(idx, !(res && res.error));
      }, function (err) {
        renderCellResult(idx, out, { error: (err && err.message) || String(err) });
        C._afterCellRun(idx, false);
      }).then(function () {
        setRunningUi(idx, false);
        updateSessionChip();
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
        if (c && c._input) c._input.classList.remove('nb-stale');
      }
    };

    function markStaleIfRan(idx) {
      if (!NB.ranOk[idx] || NB.stale[idx]) return;
      NB.stale[idx] = true;
      var c = NB.cells[idx];
      if (c && c._input) c._input.classList.add('nb-stale');
    }

    function clearAllStale() {
      var ranOk = {};
      for (var i = 0; i < NB.cells.length; i++) {
        ranOk[i] = true;
        var c = NB.cells[i];
        if (c && c._input) c._input.classList.remove('nb-stale');
      }
      NB.stale = {};
      NB.ranOk = ranOk;
    }

    // Poll-fri knappe-deaktivering (Task 5): flippes fra selve kjøre-
    // livssyklusen (setRunningUi, kalt av runCell) i tillegg til render()-
    // tidens engangs-sjekk av mdIsScriptRunning() — Kjør alle/Forklar sin
    // egen kjøreløkke har ingen tilbakekalls-hake inn i cells.js sin DOM-
    // halvdel underveis, så et allerede-rendret notatbok-visning som IKKE
    // re-rendres midt i et Kjør alle-løp forblir uendret (akseptert scope,
    // se brief).
    function setNbButtonsDisabled(disabled) {
      for (var i = 0; i < NB.cells.length; i++) {
        var c = NB.cells[i];
        if (c && c._runBtn) c._runBtn.disabled = disabled;
        // Verktøylinje-kontrollene følger samme livssyklus (B2-review):
        // strukturelle operasjoner er like farlige midt i en kjøring som en
        // ny kjøring er (toolbarGate er den harde vakten; dette er den
        // synlige speilingen). _staticDisabled (grense-↑/↓, se buildToolbar)
        // vinner alltid over re-aktivering.
        if (c && c._toolEls) {
          for (var j = 0; j < c._toolEls.length; j++) {
            c._toolEls[j].disabled = disabled || !!c._toolEls[j]._staticDisabled;
          }
        }
      }
      if (NB.restartBtn) NB.restartBtn.disabled = disabled;
    }

    function setRunningUi(idx, running) {
      var c = NB.cells[idx];
      if (c && c._input) c._input.classList.toggle('nb-running', running);
      setNbButtonsDisabled(running);
    }

    // Sesjonschip (Task 5): kjøretid + levende/kald fra mdNotebookSession.
    // Globalen mangler i stub-DOM-testene og kan i prinsippet mangle i
    // browseren også (defensivt) — vis dokumentmodus og "kald" i stedet for
    // å kaste.
    function updateSessionChip() {
      if (!NB.sessionChip) return;
      var sess = global.mdNotebookSession;
      var rt = (sess && typeof sess.runtime === 'function') ? sess.runtime() : null;
      var live = !!(sess && typeof sess.isLive === 'function' && sess.isLive());
      var label = rt || NB.docMode;
      NB.sessionChip.textContent = label + ' ' + (live ? ('● ' + t('aktiv')) : ('○ ' + t('kald')));
      NB.sessionChip.classList.toggle('nb-session-live', live);
      NB.sessionChip.classList.toggle('nb-session-cold', !live);
    }

    // Abonner PRESIS ÉN gang på hele modulets levetid (NB.sessionListenerAttached
    // er et closure-singleton, som resten av NB) — render() kan kalles mange
    // ganger (strukturendringer), men mdNotebookSession.onStateChange skal
    // ikke få flere callbacks stablet opp for hver re-rendring.
    function attachSessionListener() {
      if (NB.sessionListenerAttached) return;
      var sess = global.mdNotebookSession;
      if (!sess || typeof sess.onStateChange !== 'function') return;
      NB.sessionListenerAttached = true;
      sess.onStateChange(function () { updateSessionChip(); });
    }

    // "Restart & kjør alle": tving en frisk sesjon, deretter samme "Kjør
    // alle"-knapp som index.html allerede driver (btnRun) — ingen ny
    // kjørelogikk duplisert her. Guard for window.mdNotebookSession sitt
    // fravær (stub-DOM-tester, og defensivt i browseren).
    function onRestartClick() {
      // Guard mot en pågående Kjør alle/Forklar (final-review F3, speiler
      // C.runCell sin egen sjekk): uten denne kunne Restart rive vekk
      // e/_g under føttene på en kjøring som allerede er i gang.
      if (global.mdIsScriptRunning && global.mdIsScriptRunning()) return;
      var sess = global.mdNotebookSession;
      if (!sess || typeof sess.restart !== 'function') return;
      setNbButtonsDisabled(true);
      sess.restart().then(function () {
        updateSessionChip();
        setNbButtonsDisabled(!!(global.mdIsScriptRunning && global.mdIsScriptRunning()));
        var btn = $('btnRun');
        if (btn) btn.click();
      }, function () {
        updateSessionChip();
        setNbButtonsDisabled(!!(global.mdIsScriptRunning && global.mdIsScriptRunning()));
      });
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
    // meldinger (R-celle i ikke-R-modus, microdata-celle i R-modus,
    // dashboard-celler) er IKKE feil — en rolig info-boks (.nb-notice),
    // ikke rød pre.error.
    // {idx} (final-review F6): en strukturell re-rendring (render(), utløst
    // av f.eks. en samtidig contentLoaded/exit) kan skje MENS denne cellens
    // kjøring pågår — c._out fanget ved kjørestart er da en detached node
    // (fjernet fra DOM av render()'ens purge/gjenoppbygging), og et resultat
    // som skrives dit ville forsvinne stille. Requery cellens NÅVÆRENDE slot
    // via data-idx før rendring; finnes cellen ikke lenger, drop med warn
    // fremfor å kaste (kjøringen fullførte tross alt).
    function renderCellResult(idx, out, res) {
      if (out && !out.isConnected && NB.root) {
        out = NB.root.querySelector('.nb-cell[data-idx="' + idx + '"] .nb-output-body');
        if (!out) {
          console.warn('renderCellResult: celle', idx, 'finnes ikke lenger (strukturendring midt i kjøring) — resultat droppet');
          return;
        }
      }
      if (!out) return;
      // dash mount-to-slot (fase B2 Task 4b): D.create() (js/dash.js) kan ha
      // montert et dashboard DIREKTE inn i `out` MENS scriptet nettopp kjørte
      // (window.mdUiRunCtx() pekte hit under selve kjøringen) — altså FØR
      // dette kallet. Uten denne sjekken ville grenene under sitt ubetingede
      // purge(out); out.innerHTML = '' tømme akkurat den DOM-en dashbordet
      // nettopp satte inn, idet run-resultatet (tekst/notice/feil) rendres
      // rett etterpå. Mirror av Brython/MicroPython sin runSelf-sjekk
      // (index.html ~3218: `outputArea.querySelector('.dash') ? appendOutput
      // : renderOutput`), her mot cellens EGEN slot i stedet for #outputArea.
      // R-dashbord havner ikke her fordi R-kjørestiene aldri setter
      // nbUiRunCtx (mountContainer faller da til #outputArea — se
      // js/dash.js) — hasDash er derfor alltid false for R-celler,
      // res.rparts-grenen er dermed urørt.
      var hasDash = !!(out.querySelector && out.querySelector('.dash'));
      if (res && res.rparts) {
        if (typeof global.renderROutputParts === 'function') {
          global.renderROutputParts(res.rparts, out);
        } else {
          purge(out);
          out.innerHTML = '';
        }
      } else if (res && res.notice) {
        if (!hasDash) { purge(out); out.innerHTML = ''; }
        out.appendChild(el('pre', 'nb-notice', res.notice));
      } else if (res && res.error) {
        if (!hasDash) { purge(out); out.innerHTML = ''; }
        out.appendChild(el('pre', 'error', res.error));
      } else if (typeof global.mdRenderOutput === 'function') {
        if (hasDash && typeof global.mdAppendOutput === 'function') {
          global.mdAppendOutput((res && res.text) || '', out);
        } else {
          global.mdRenderOutput((res && res.text) || '', out);
        }
      } else if (hasDash) {
        // Node-testfallback uten global.mdRenderOutput: out.textContent = ''
        // ville uansett fjernet dash-roten (textContent-setteren tømmer ALLE
        // barn) — legg til som en tekst-node i stedet for å overskrive.
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
