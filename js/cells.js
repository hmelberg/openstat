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
  var KNOWN_KEYS = { id: 1, style: 1, slide: 1, speak: 1, rerun: 1, sync: 1 };
  var KNOWN_FLAGS = { 'hide-code': 1, 'hide-output': 1, slide: 1 };
  var STYLES = { note: 1, warn: 1, card: 1 };
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
  // VERIFISER stavemåtene mot segmenteringen (~index.html:6024 og
  // normalizeren ~7413-7428) i Task 6, og juster her om nødvendig.
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

  // Forventet segmentrekkefølge → celleindekser. Segment 0 er alt før første
  // '## lang'-markør (preambel + ev. blankede celler) og tilskrives den
  // FØRSTE cellen i det spennet. Deretter ett segment per kjørbar celle.
  // Blankede celler etter første markør smelter inn i forrige segment.
  C.segmentPlan = function (text, docMode) {
    var parsed = C.parseCells(text);
    var plan = [];
    var leadingIdx = null;
    var seen = false;
    for (var i = 0; i < parsed.cells.length; i++) {
      var c = parsed.cells[i];
      var type = C.resolveType(c, docMode);
      var runnable = c.headerRaw !== null && C.isCodeType(type) && !!SEG_MARKER[type];
      if (runnable) { seen = true; plan.push(i); continue; }
      if (!seen && leadingIdx === null) leadingIdx = i;
    }
    if (leadingIdx !== null) plan.unshift(leadingIdx);
    return plan;
  };

  // ---------- DOM-halvdel (kun browser) ----------
  if (typeof document !== 'undefined') (function () {
    var t = typeof global.t === 'function' ? global.t : function (s) { return s; };
    var NB = { root: null, cells: [], docMode: 'python', layout: 'columns',
               rawOverride: false, activeFlag: false, lastSerialized: null,
               plan: [], runSinks: null, trailing: null, chip: null,
               editTimer: null, tickHandle: null, lastUserInput: 0 };

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

    C.init = function (docMode) {
      NB.docMode = docMode;
      if (!NB.tickHandle) {
        NB.tickHandle = setInterval(tick, 1000);
        var ta0 = $('scriptInput');
        // Spor aktiv skriving separat fra programmatiske .value-endringer
        // (delt av tick(), se der).
        if (ta0) ta0.addEventListener('input', function () { NB.lastUserInput = Date.now(); });
      }
      var ta = $('scriptInput');
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
      if (container) container.classList.add('nb-hidden');
      if (!NB.root) {
        NB.root = el('div', 'nb-root');
        NB.root.id = 'notebookRoot';
        container.parentNode.insertBefore(NB.root, container.nextSibling);
      }
      NB.root.hidden = false;
      render();
      updateChip();
      return true;
    };

    C.exit = function (opts) {
      if (opts && opts.raw) NB.rawOverride = true;
      NB.activeFlag = false;
      if (NB.root) { purge(NB.root); NB.root.hidden = true; }
      var container = document.querySelector('.container');
      if (container) container.classList.remove('nb-hidden');
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
      }
    };

    C.refreshFromScript = function () { if (NB.activeFlag) render(); else updateChip(); };

    function render() {
      var ta = $('scriptInput');
      var parsed = C.parseCells(ta.value);
      NB.cells = parsed.cells;
      NB.lastSerialized = ta.value;
      NB.plan = C.segmentPlan(ta.value, NB.docMode);
      NB.runSinks = null; NB.trailing = null;
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
      NB.root.appendChild(bar);
      for (var i = 0; i < NB.cells.length; i++) NB.root.appendChild(cellNode(NB.cells[i], i));
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
      var head = el('div', 'nb-head');
      head.appendChild(el('span', 'nb-type', type + (c.attrs.id ? ' · ' + c.attrs.id : '')));
      input.appendChild(head);
      var ta = el('textarea', 'nb-src');
      ta.value = c.source;
      ta.spellcheck = false;
      ta.addEventListener('input', function () { autoSize(ta); onEdit(idx, ta.value); });
      input.appendChild(ta);

      var out = el('div', 'nb-output');
      if (nonCode && type !== 'skip') {
        wrap.classList.add('nb-rendered-only');
        renderNonCode(out, type, c.source);
        out.addEventListener('dblclick', function () {
          wrap.classList.remove('nb-rendered-only');
          autoSize(ta); ta.focus();
        });
        ta.addEventListener('blur', function () {
          renderNonCode(out, type, ta.value);
          wrap.classList.add('nb-rendered-only');
        });
      }
      wrap.appendChild(input);
      wrap.appendChild(out);
      requestAnimationFrame(function () { autoSize(ta); });
      return wrap;
    }

    function renderNonCode(out, type, src) {
      purge(out);
      out.innerHTML = '';
      if (type === 'md') {
        var md = typeof global.markdownit === 'function' ? global.markdownit({ breaks: true }) : null;
        var div = el('div', 'output-markdown');
        if (md) div.innerHTML = md.render(src); else div.textContent = src;
        out.appendChild(div);
      } else {
        var host = el('div', 'nb-html');
        host.innerHTML = src;   // html-celle: brukerens eget dokument, samme tillit som kode
        out.appendChild(host);
      }
    }

    function autoSize(ta) {
      ta.style.height = 'auto';
      ta.style.height = (ta.scrollHeight + 2) + 'px';
    }

    function onEdit(idx, value) {
      var c = NB.cells[idx];
      c.source = value;
      c.hasBody = true;
      if (NB.editTimer) clearTimeout(NB.editTimer);
      NB.editTimer = setTimeout(function () {
        var ta = $('scriptInput');
        var text = C.serializeCells(NB.cells);
        NB.lastSerialized = text;
        ta.value = text;
        NB.plan = C.segmentPlan(text, NB.docMode);
        if (global.updateLineNumbers) global.updateLineNumbers();
        // Skrev brukeren en ny #%%-markør inni cellen? Da har strukturen
        // endret seg — full re-rendring (bevisst handling, fokus-hopp ok).
        var lines = String(value).split('\n');
        for (var i = 0; i < lines.length; i++) {
          if (C.isMarkerLine(lines[i])) { render(); return; }
        }
      }, 250);
    }

    // Én tikker: aktiv → fang programmatiske endringer i #scriptInput
    // (eksempler/AI setter .value uten input-event); inaktiv → vis/skjul hint.
    function tick() {
      var ta = $('scriptInput');
      if (!ta) return;
      if (NB.activeFlag) {
        if (ta.value !== NB.lastSerialized) {
          if (C.hasMarkers(ta.value)) render();
          else C.exit();
        }
      } else if (C.hasMarkers(ta.value) && C.supportedMode(NB.docMode) && !NB.rawOverride &&
                 (Date.now() - NB.lastUserInput > 2000)) {
        // Programmatisk innlasting (share-lenke, eksempler, i18n-gjenoppretting) →
        // gå rett til cellevisning (spec §3.2). Aktiv skriving i rå-editoren
        // (lastUserInput fersk) → kun hint-chip, ikke auto-inngang.
        C.enter(appLayout());
      } else updateChip();
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
  })();

  global.Cells = C;
  if (typeof module !== 'undefined' && module.exports) module.exports = C;
})(typeof window !== 'undefined' ? window : globalThis);
