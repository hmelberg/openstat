# Notebook Cells — Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase A of the notebook-cells spec (`docs/superpowers/specs/2026-07-13-notebook-cells-design.md`): `#%%` markers turn a script into a notebook; the existing view modes (Kolonner/Stablet/Kun output) each get a cell rendering; Run All attributes output to per-cell slots. No per-cell run yet (that is Phase B).

**Architecture:** New `js/cells.js` following the `js/dash.js` convention — a pure, node-tested half (parse/serialize/runnable-text transform) on top, a browser-only DOM half (the notebook renderer) below. `index.html` gets thin hooks: an include, an init call, view-dropdown routing, a runnable-text transform at the run entry, and per-segment output sinks in the existing segment loops. The plain-text script in `#scriptInput` stays canonical at all times.

**Tech Stack:** Vanilla ES5-style JS (no build step, classic `<script src>` tags sharing the `window.*` surface), `node:test` for the pure half, pytest for repo-level checks, CSS in `app.css` using the existing custom properties.

## Global Constraints

- **Canonical text:** every notebook operation reads/writes `#scriptInput.value`; the cell model is derived, never authoritative.
- **Gating:** no `#%%` markers (or unsupported mode) ⇒ zero new code paths execute; the app must be pixel-identical to today.
- **Supported modes (Phase A):** `python`, `r`, `duckdb`, `microdata`. Other modes render as plain scripts.
- **Code style:** match `js/dash.js` — `var`, two-space indent, Norwegian comments, IIFE with `module.exports` guard for the pure half.
- **UI strings:** Norwegian, wrapped in `t('…')` (global i18n fn; fall back to identity if absent).
- **No new dependencies.** Markdown rendering reuses the already-loaded `window.markdownit`.
- **Line-count preservation:** the runnable-text transform must keep line numbers identical to the document (error messages point into the real text).
- **Commits:** one per task, message prefix `feat(cells):` / `test(cells):` as appropriate, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

**Existing code facts the tasks rely on** (verified 2026-07-13):

- `index.html:3426` `initViewModeDropdown()` — view dropdown; handler at ~3445 maps `columns|stacked|output|forklar`.
- `index.html:~8410` `btnRun.addEventListener('click', …)` — main run handler; reads `const rawScript = scriptInput.value;` a few lines in; `activeEditorMode` is in scope.
- `index.html:8644-8663` — JS segment loop (python/duckdb/microdata modes): `appendOutput(stdout.slice(renderedLen), asHtml, suppress)` at 8649 and 8661; `outputArea.innerHTML = ''` at 8641; error path appends `pre.error` to `outputArea` at ~8678.
- `index.html:5753` `renderOutput(raw, asHtml, suppress)`, `index.html:5762` `appendOutput(raw, asHtml, suppress)`, `index.html:5769` `purgePlots(container)` — all inside the big inline module (not on `window` yet).
- `index.html:6024` `parseHybridScript`-style segmentation: `segments.push({ kind: mode, text: t })` per `## lang` marker; normalizer at `index.html:7413-7428` maps marker variants to `## python` / `## r`.
- `index.html:7513` `async function runHybridR(src, py, runOpts)` — R-mode runner (output emission pattern unverified; Task 7 investigates).
- `index.html:5523` `const md = window.markdownit ? window.markdownit({ breaks: true }) : null;` — markdown-it is loaded globally.
- Layout: `.container` holds `.panel-left` (editor, inside `.code-input-wrap`) and the output panel with `#outputArea`; classes `layout-columns`/`layout-stacked`/`input-hidden` control view modes (`index.html:1188-1231`, `window.mdSetLayoutMode`/`mdIsStackedLayout`/`mdIsInputHidden`).
- Tests: `node --test tests/js/` (see `tests/js/dash.test.js` for the pattern: `require('../../js/dash.js')`), pytest via `.venv/bin/python -m pytest tests/`.
- Examples: files under `examples/<mode>/`, first line `# label: …`; `examples/generate_manifest.py` regenerates `examples/manifest.json`.

---

### Task 1: `js/cells.js` pure half — header parsing

**Files:**
- Create: `js/cells.js`
- Test: `tests/js/cells.test.js`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `Cells.parseHeader(line) → {type: string|null, attrs: {key: string|true}, warnings: string[]}`, `Cells.isMarkerLine(line) → bool`, `Cells.hasMarkers(text) → bool`, `Cells.supportedMode(mode) → bool`, `Cells.isCodeType(type) → bool`, `Cells.resolveType(cell, docMode) → string`. Module exported as `window.Cells` in the browser and via `module.exports` in node.

- [ ] **Step 1: Write the failing tests**

Create `tests/js/cells.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const C = require('../../js/cells.js');

test('parseHeader: bare markør → ingen type/attrs', () => {
  const h = C.parseHeader('#%%');
  assert.strictEqual(h.type, null);
  assert.deepStrictEqual(h.attrs, {});
  assert.deepStrictEqual(h.warnings, []);
});

test('parseHeader: type, begge stavemåter, case-insensitiv', () => {
  assert.strictEqual(C.parseHeader('#%% python').type, 'python');
  assert.strictEqual(C.parseHeader('# %% r').type, 'r');
  assert.strictEqual(C.parseHeader('#%% PYTHON').type, 'python');
});

test('parseHeader: aliaser og VS Code-brakettform', () => {
  assert.strictEqual(C.parseHeader('#%% py').type, 'python');
  assert.strictEqual(C.parseHeader('#%% pyodide').type, 'python');
  assert.strictEqual(C.parseHeader('#%% markdown').type, 'md');
  assert.strictEqual(C.parseHeader('#%% text').type, 'md');
  assert.strictEqual(C.parseHeader('# %% [markdown]').type, 'md');
});

test('parseHeader: attrs — flagg, key=value, sitert verdi', () => {
  const h = C.parseHeader('#%% r id=plot hide-code style=card');
  assert.strictEqual(h.type, 'r');
  assert.deepStrictEqual(h.attrs, { id: 'plot', 'hide-code': true, style: 'card' });
  assert.deepStrictEqual(h.warnings, []);
  const s = C.parseHeader('#%% python speak="hei verden"');
  assert.strictEqual(s.attrs.speak, 'hei verden');
});

test('parseHeader: advarsler — ukjent nøkkel/flagg/style, ugyldig id', () => {
  assert.match(C.parseHeader('#%% python foo=bar').warnings[0], /ukjent attributt/);
  assert.match(C.parseHeader('#%% python blah').warnings[0], /ukjent flagg/);
  assert.match(C.parseHeader('#%% python style=fancy').warnings[0], /ukjent style/);
  const bad = C.parseHeader('#%% python id=æøå');
  assert.match(bad.warnings[0], /ugyldig id/);
  assert.strictEqual(bad.attrs.id, undefined);
});

test('parseHeader: ukjent første token er attr, ikke type', () => {
  const h = C.parseHeader('#%% notatype');
  assert.strictEqual(h.type, null);
  assert.strictEqual(h.attrs.notatype, true);
  assert.strictEqual(h.warnings.length, 1);
});

test('isMarkerLine/hasMarkers', () => {
  assert.ok(C.isMarkerLine('#%%'));
  assert.ok(C.isMarkerLine('# %% python id=x'));
  assert.ok(!C.isMarkerLine('  #%%'));            // kun kolonne 0
  assert.ok(!C.isMarkerLine('#%%x'));
  assert.ok(C.hasMarkers('a\n#%% md\nb'));
  assert.ok(!C.hasMarkers('print(1)'));
  assert.ok(C.isMarkerLine('#%%\r'));             // CRLF-dokumenter
});

test('supportedMode / isCodeType / resolveType', () => {
  assert.ok(C.supportedMode('python') && C.supportedMode('r') &&
            C.supportedMode('duckdb') && C.supportedMode('microdata'));
  assert.ok(!C.supportedMode('brython') && !C.supportedMode('jamovi'));
  assert.ok(C.isCodeType('python') && !C.isCodeType('md') &&
            !C.isCodeType('html') && !C.isCodeType('skip'));
  assert.strictEqual(C.resolveType({ type: null }, 'r'), 'r');
  assert.strictEqual(C.resolveType({ type: 'md' }, 'r'), 'md');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/js/cells.test.js`
Expected: FAIL — `Cannot find module '../../js/cells.js'`

- [ ] **Step 3: Implement the pure half (header part)**

Create `js/cells.js`:

```js
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

  global.Cells = C;
  if (typeof module !== 'undefined' && module.exports) module.exports = C;
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/js/cells.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add js/cells.js tests/js/cells.test.js
git commit -m "feat(cells): ren halvdel — #%%-headerparsing (type, attrs, advarsler)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: pure half — `parseCells` + `serializeCells` (round-trip)

**Files:**
- Modify: `js/cells.js` (insert into the pure half, before the export lines)
- Test: `tests/js/cells.test.js` (append)

**Interfaces:**
- Consumes: `parseHeader`, `MARKER_RE` from Task 1.
- Produces: `Cells.parseCells(text) → {cells, warnings}` where a cell is `{type, attrs, headerRaw: string|null, headerLine, startLine, endLine, source, hasBody}` (`headerRaw === null` ⇒ implicit preamble; `type === null` ⇒ document mode; line numbers 0-based, spans include the header line); `Cells.cellBlock(cell) → string`; `Cells.serializeCells(cells) → string` with the guarantee `serializeCells(parseCells(t).cells) === t`.

- [ ] **Step 1: Write the failing tests** (append to `tests/js/cells.test.js`)

```js
test('parseCells: uten markører → én implisitt preambelcelle', () => {
  const p = C.parseCells('print(1)\nprint(2)');
  assert.strictEqual(p.cells.length, 1);
  assert.strictEqual(p.cells[0].headerRaw, null);
  assert.strictEqual(p.cells[0].source, 'print(1)\nprint(2)');
});

test('parseCells: preambel + to celler, spans og kilder', () => {
  const doc = '# load x\n\n#%% md\n# Tittel\n\n#%% python id=a\n1 + 1';
  const p = C.parseCells(doc);
  assert.strictEqual(p.cells.length, 3);
  assert.strictEqual(p.cells[0].headerRaw, null);
  assert.strictEqual(p.cells[0].source, '# load x\n');
  assert.strictEqual(p.cells[1].type, 'md');
  assert.strictEqual(p.cells[1].headerLine, 2);
  assert.strictEqual(p.cells[1].source, '# Tittel\n');
  assert.strictEqual(p.cells[2].attrs.id, 'a');
  assert.strictEqual(p.cells[2].source, '1 + 1');
  assert.strictEqual(p.cells[2].startLine, 5);
  assert.strictEqual(p.cells[2].endLine, 6);
});

test('parseCells: dokument som starter med markør har ingen preambel', () => {
  const p = C.parseCells('#%% python\nx = 1');
  assert.strictEqual(p.cells.length, 1);
  assert.strictEqual(p.cells[0].headerRaw, '#%% python');
});

test('parseCells: duplisert id gir advarsel', () => {
  const p = C.parseCells('#%% python id=a\n1\n#%% r id=a\n2');
  assert.ok(p.warnings.some(w => /duplisert id/.test(w)));
});

test('round-trip: serialize(parse(t)) === t — eksakt', () => {
  const docs = [
    'print(1)',
    'print(1)\n',
    '# pre\n#%% md\ntekst\n\n#%% python id=x hide-code\n1+1\n',
    '#%% r',                    // header-only, ingen body
    '#%% r\n',                  // header + én tom linje
    '#%%\n#%% python\n',        // to markører rett etter hverandre
    '\n\n#%% md\n',             // blank preambel bevares
    '',
  ];
  for (const d of docs) {
    assert.strictEqual(C.serializeCells(C.parseCells(d).cells), d, JSON.stringify(d));
  }
});

test('cellBlock: redigert celle serialiseres med header', () => {
  const p = C.parseCells('#%% python\nx = 1');
  p.cells[0].source = 'x = 2';
  p.cells[0].hasBody = true;
  assert.strictEqual(C.serializeCells(p.cells), '#%% python\nx = 2');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/js/cells.test.js`
Expected: FAIL — `C.parseCells is not a function`

- [ ] **Step 3: Implement** (insert into `js/cells.js` after `parseHeader`)

```js
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
```

Note: an empty document `''` parses to one preamble cell with `source: ''` — `serializeCells` returns `''` ✓. Verify the round-trip test covers it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/js/cells.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add js/cells.js tests/js/cells.test.js
git commit -m "feat(cells): parseCells/serializeCells med eksakt round-trip

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: pure half — `executableSource` + `segmentPlan`

**Files:**
- Modify: `js/cells.js` (insert after `serializeCells`)
- Test: `tests/js/cells.test.js` (append)

**Interfaces:**
- Consumes: `parseCells`, `resolveType`, `isCodeType`, `cellBlock`, `hasMarkers`.
- Produces: `Cells.executableSource(text, docMode) → string` (runnable text, same line count) and `Cells.segmentPlan(text, docMode) → number[]` (cell indexes in expected segment order; used by Task 6 to map segment *i* → cell). Also `Cells.SEG_MARKER` (lang → legacy marker map) for Task 6/7's verification.

- [ ] **Step 1: Write the failing tests** (append)

```js
test('executableSource: uten markører → uendret', () => {
  assert.strictEqual(C.executableSource('x = 1\ny = 2', 'python'), 'x = 1\ny = 2');
});

test('executableSource: kodecelle-header → ## lang, md blankes, linjetall bevares', () => {
  const doc = '# pre\n#%% md\n# En **tittel**\nmer tekst\n#%% python\n1 + 1\n#%% r\nsummary(x)';
  const out = C.executableSource(doc, 'python');
  const inLines = doc.split('\n'), outLines = out.split('\n');
  assert.strictEqual(outLines.length, inLines.length);          // linjetall bevart
  assert.strictEqual(outLines[0], '# pre');                     // preambel urørt
  assert.strictEqual(outLines[1], '');                          // md-header blanket
  assert.strictEqual(outLines[2], '');                          // md-innhold blanket
  assert.strictEqual(outLines[3], '');
  assert.strictEqual(outLines[4], '## python');                 // header → segmentmarkør
  assert.strictEqual(outLines[5], '1 + 1');
  assert.strictEqual(outLines[6], '## r');
  assert.strictEqual(outLines[7], 'summary(x)');
});

test('executableSource: default-type følger docMode', () => {
  const out = C.executableSource('#%%\nsummary(x)', 'r');
  assert.strictEqual(out.split('\n')[0], '## r');
});

test('executableSource: skip og usegmenterbare språk blankes', () => {
  const doc = '#%% skip\nhemmelig()\n#%% brython\nalert(1)\n#%% python\n1';
  const out = C.executableSource(doc, 'python').split('\n');
  assert.deepStrictEqual(out.slice(0, 4), ['', '', '', '']);
  assert.strictEqual(out[4], '## python');
});

test('segmentPlan: preambel leder, deretter kjørbare celler i rekkefølge', () => {
  const doc = '# pre\n#%% md\ntekst\n#%% python\n1\n#%% r\n2';
  // celleindekser: 0=preambel, 1=md, 2=python, 3=r
  assert.deepStrictEqual(C.segmentPlan(doc, 'python'), [0, 2, 3]);
});

test('segmentPlan: md først (ingen preambel) eier leder-segmentet', () => {
  const doc = '#%% md\ntekst\n#%% python\n1';
  assert.deepStrictEqual(C.segmentPlan(doc, 'python'), [0, 1]);
});

test('segmentPlan: dokument som starter rett på kodecelle', () => {
  const doc = '#%% python\n1\n#%% python\n2';
  assert.deepStrictEqual(C.segmentPlan(doc, 'python'), [0, 1]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/js/cells.test.js`
Expected: FAIL — `C.executableSource is not a function`

- [ ] **Step 3: Implement** (insert into `js/cells.js`)

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/js/cells.test.js`
Expected: PASS. Also run the full JS suite to confirm no regressions: `node --test tests/js/` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add js/cells.js tests/js/cells.test.js
git commit -m "feat(cells): executableSource (dokument → kjørbar tekst) + segmentPlan

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: DOM half — notebook renderer with three layouts

**Files:**
- Modify: `js/cells.js` (DOM half appended before the export lines, gated on `typeof document !== 'undefined'`)
- Modify: `app.css` (append notebook styles)
- Modify: `index.html` (add `<script src="js/cells.js"></script>` next to the existing `js/dash.js` script tag; expose `window.purgePlots = purgePlots;` right after `purgePlots`'s definition at ~5769)

**Interfaces:**
- Consumes: pure half from Tasks 1–3; `window.markdownit`, `window.updateLineNumbers`, `window.refreshPlotlyAfterLayout`, `window.purgePlots` (exposed here), global `t` (optional).
- Produces (all on `window.Cells`): `init(docMode)`, `setDocMode(mode)`, `active() → bool`, `enter(layout?) → bool`, `exit(opts?)` (`{raw:true}` sets the raw override), `setLayout('columns'|'stacked'|'output')`, `refreshFromScript()`. Task 5 wires these into the app; Task 6 adds the run-sink API.

- [ ] **Step 1: Implement the DOM half** (insert into `js/cells.js` after the pure half, before `global.Cells = C;`)

```js
  // ---------- DOM-halvdel (kun browser) ----------
  if (typeof document !== 'undefined') (function () {
    var t = typeof global.t === 'function' ? global.t : function (s) { return s; };
    var NB = { root: null, cells: [], docMode: 'python', layout: 'columns',
               rawOverride: false, activeFlag: false, lastSerialized: null,
               plan: [], runSinks: null, trailing: null, chip: null,
               editTimer: null };

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
      setInterval(tick, 1000);
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
      NB.activeFlag = true;
      NB.rawOverride = false;
      if (layout) NB.layout = layout;
      var container = document.querySelector('.container');
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
```

- [ ] **Step 2: Add CSS** (append to `app.css`; reuse the file's existing custom properties — check the variable names at the top of `app.css` and substitute if they differ from `--border`/`--bg-code`)

```css
/* ── Notatbok-celler (js/cells.js, spec 2026-07-13) ─────────────────────── */
.container.nb-hidden { display: none !important; }
.nb-root { flex: 1 1 auto; overflow-y: auto; padding: 12px 16px 40px; }
.nb-bar { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; }
.nb-raw-btn { font-size: 12px; padding: 3px 10px; border: 1px solid var(--border);
  border-radius: 4px; background: transparent; color: inherit; cursor: pointer; }
.nb-warnings { font-size: 12px; opacity: .75; }
.nb-cell { display: grid; gap: 10px; margin-bottom: 12px; border: 1px solid var(--border);
  border-radius: 6px; padding: 10px; }
.nb-layout-columns .nb-cell { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.nb-layout-columns .nb-cell.nb-noncode,
.nb-layout-columns .nb-cell.nb-hide-code,
.nb-layout-columns .nb-cell.nb-rendered-only { grid-template-columns: 1fr; }
.nb-layout-stacked .nb-cell { grid-template-columns: 1fr; }
.nb-layout-output .nb-cell { grid-template-columns: 1fr; border: none; padding: 4px 0; }
.nb-layout-output .nb-input { display: none; }
.nb-rendered-only .nb-input { display: none; }
.nb-hide-code .nb-input { display: none; }
.nb-hide-output .nb-output { display: none; }
.nb-skip { opacity: .55; }
.nb-head { font-size: 11px; opacity: .65; margin-bottom: 4px; }
.nb-src { width: 100%; min-height: 1.6em; resize: none; border: 1px solid var(--border);
  border-radius: 4px; background: var(--bg-code); color: inherit;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
  line-height: 1.45; padding: 6px 8px; box-sizing: border-box; }
.nb-output { min-width: 0; overflow-x: auto; }
.nb-output.nb-trailing { border-top: 1px dashed var(--border); padding-top: 8px; }
.nb-style-note { border-left: 4px solid #4a90d9; }
.nb-style-warn { border-left: 4px solid #d9a54a; }
.nb-style-card { box-shadow: 0 1px 4px rgba(0,0,0,.15); }
.nb-chip { position: absolute; right: 12px; top: 8px; z-index: 6; font-size: 12px;
  padding: 3px 10px; border: 1px solid var(--border); border-radius: 12px;
  background: var(--bg-code); color: inherit; cursor: pointer; }
```

If `.container`'s parent is not a flex column (check in DevTools), give `.nb-root` `height: calc(100vh - <topbar+bottombar height>)` instead of `flex: 1` — match how `.container` itself is sized in `app.css`.

- [ ] **Step 3: Wire into `index.html`**

1. Find the `<script src="js/dash.js">` tag (or the block of classic script includes near `widgets/forklar-widgets.js` at ~580) and add `<script src="js/cells.js"></script>` beside it.
2. Right after `function purgePlots(container) { … }` (~5769), add: `window.purgePlots = purgePlots;`

- [ ] **Step 4: Manual render check (no run integration yet)**

Serve: `python3 -m http.server 8123` from the repo root; open `http://localhost:8123/index.html`.
In DevTools console: `Cells.setDocMode('python'); document.getElementById('scriptInput').value = '#%% md\n# Hei\n\n#%% python\n1+1'; Cells.enter();`
Expected: the two-panel UI disappears; a cell list renders — one rendered markdown cell (heading "Hei"), one python cell with editable source; "Rå tekst" button returns to the normal editor with the text intact. `Cells.setLayout('stacked')` / `('columns')` / `('output')` switch layouts. Typing in the python cell then clicking "Rå tekst" shows the edit in the textarea. No console errors.

- [ ] **Step 5: Run the test suites** (`node --test tests/js/` — all PASS; the DOM half must not break node loading since it is gated on `typeof document`).

- [ ] **Step 6: Commit**

```bash
git add js/cells.js app.css index.html
git commit -m "feat(cells): DOM-halvdel — notebook-rendrer med tre layouter, Rå tekst-toggle, hint-chip

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: app integration — init, view dropdown, mode switching

**Files:**
- Modify: `index.html` (three small insertions)

**Interfaces:**
- Consumes: `Cells.init/setDocMode/active/setLayout/enter/exit` from Task 4.
- Produces: notebook auto-engages at startup; the view dropdown drives notebook layouts; mode switches keep `Cells` informed.

- [ ] **Step 1: Init call at startup**

Locate the `restoreEditorMode()` IIFE (search for `restoreEditorMode` — it finalizes `activeEditorMode` and seeds the startup example, near `index.html:3470`'s comment). Immediately after mode restore + editor seeding completes, add:

```js
if (window.Cells) window.Cells.init(activeEditorMode);
```

- [ ] **Step 2: View dropdown routing**

In `initViewModeDropdown()`'s click handler (`index.html:~3445`), insert at the very top of the `data-view` button handler, before the `v === 'forklar'` branch:

```js
if (window.Cells && window.Cells.active() && v !== 'forklar') {
  window.Cells.setLayout(v === 'output' ? 'output' : v);
  setActive(v);
  return;
}
```

(Skrittvis keeps its existing behavior — it runs on the canonical text; documented Phase A limitation.)

- [ ] **Step 3: Mode-switch integration**

Find where `activeEditorMode` is assigned on a user mode switch (search `activeEditorMode =` — there is a setter function invoked by the mode dropdown). After the assignment, add:

```js
if (window.Cells) window.Cells.setDocMode(activeEditorMode);
```

(`setDocMode` already exits notebook rendering when the new mode is unsupported.)

- [ ] **Step 4: Manual check**

Serve and open the app. Paste a notebook (same snippet as Task 4) into the editor in python mode, wait ≤1 s → the hint chip "Notatbok — vis som celler" appears over the editor; click it → notebook renders. Use the view dropdown: Kolonner → input|output rows; Stablet → Jupyter-style; Kun output → outputs/markdown only. Switch mode to Brython → notebook exits to plain script, no chip. Switch back to python → chip reappears. Reload the page with the notebook text persisted → notebook auto-enters at startup. A plain script (no `#%%`): no chip, app behaves exactly as before (check all four dropdown entries).

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat(cells): app-integrasjon — init ved oppstart, visningsmeny-ruting, modusbytte

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: run integration — runnable text + per-cell output sinks (python/duckdb/microdata)

**Files:**
- Modify: `js/cells.js` (run-sink API in the DOM half)
- Modify: `index.html` (`btnRun` handler, `appendOutput`/`renderOutput`, the segment loop at 8644-8663, the error path at ~8678, the result-enhancer observer)

**Interfaces:**
- Consumes: `Cells.executableSource`, `Cells.segmentPlan`, `Cells.active`, `Cells.SEG_MARKER`; existing `appendOutput`, `buildOutputNodes`, segment loop.
- Produces: `Cells.beginRun(segmentCount) → sinks|null`, `Cells.sinkForSegment(i) → Element|null`, `Cells.errorHost() → Element|null`. `appendOutput(raw, asHtml, suppress, target?)` and `renderOutput(raw, asHtml, suppress, target?)` accept an optional target container (default `outputArea` — all existing callers unchanged).

- [ ] **Step 1: Verify the segment-marker spellings**

Read `index.html:6024-6042` (the segmentation) and `index.html:7413-7428` (the normalizer). Confirm which marker strings produce segments of kind `python`, `r`, `duckdb`, `microdata` (e.g. whether duckdb is `## duckdb` or `#duckdb`, and whether a leading no-marker span yields a segment even when blank). Adjust `SEG_MARKER` in `js/cells.js` and, if the leading-segment behavior differs from `segmentPlan`'s assumption (leading segment exists only when there is any text before the first marker), adjust `segmentPlan` and its tests to match. Re-run `node --test tests/js/cells.test.js`.

- [ ] **Step 2: Add the run-sink API to the DOM half** (inside the `typeof document` block, after `updateChip`)

```js
    // ---- kjøring (Task 6): per-celle output-slots ----
    // beginRun kalles fra segmentløkken i index.html med antall segmenter.
    // Returnerer sink-listen, eller null (→ samlet fallback-slot nederst)
    // når planen ikke matcher — f.eks. ##-markører skrevet manuelt i en celle.
    C.beginRun = function (segmentCount) {
      if (!NB.activeFlag) return null;
      var outs = NB.root.querySelectorAll('.nb-cell .nb-output');
      for (var i = 0; i < outs.length; i++) {
        var cellEl = outs[i].parentNode;
        if (cellEl.classList.contains('nb-noncode')) continue;   // md/html beholder rendringen
        purge(outs[i]);
        outs[i].innerHTML = '';
      }
      if (NB.trailing) { NB.trailing.remove(); NB.trailing = null; }
      if (segmentCount !== NB.plan.length) { NB.runSinks = null; return null; }
      NB.runSinks = [];
      for (var s = 0; s < NB.plan.length; s++) {
        var node = NB.root.querySelector('.nb-cell[data-idx="' + NB.plan[s] + '"] .nb-output');
        NB.runSinks.push(node || null);
      }
      return NB.runSinks;
    };

    C.sinkForSegment = function (i) {
      if (NB.runSinks && NB.runSinks[i]) return NB.runSinks[i];
      return C.errorHost();
    };

    // Samle-slot nederst: fallback ved planavvik og vert for feilmeldinger.
    C.errorHost = function () {
      if (!NB.activeFlag) return null;
      if (!NB.trailing || !NB.trailing.isConnected) {
        NB.trailing = el('div', 'nb-output nb-trailing');
        NB.root.appendChild(NB.trailing);
      }
      return NB.trailing;
    };
```

- [ ] **Step 3: Optional target on the two render helpers** (`index.html:5753-5765`)

```js
    function renderOutput(raw, asHtml, suppress, target) {
      var host = target || outputArea;
      const frag = buildOutputNodes(raw, asHtml, suppress);
      purgePlots(host);
      host.innerHTML = '';
      host.appendChild(frag);
    }

    function appendOutput(raw, asHtml, suppress, target) {
      if (!raw || !raw.trim()) return;
      (target || outputArea).appendChild(buildOutputNodes(raw, asHtml, suppress));
    }
```

- [ ] **Step 4: Runnable text at the run entry**

In the `btnRun` click handler, change `const rawScript = scriptInput.value;` to:

```js
      const rawScript = (window.Cells && window.Cells.active())
        ? window.Cells.executableSource(scriptInput.value, activeEditorMode)
        : scriptInput.value;
```

(Gate on `active()`, not `hasMarkers()`: with the raw override on, the user sees plain text and gets today's behavior — `#%%` lines are comments.)

- [ ] **Step 5: Sinks in the segment loop** (`index.html:8636-8663`)

After `outputArea.innerHTML = '';` (~8641), add:

```js
        const _nbSinks = (window.Cells && window.Cells.active())
          ? window.Cells.beginRun(segments.length) : null;
        const _nbActive = !!(window.Cells && window.Cells.active());
```

Change both `appendOutput` calls in the loop (8649 and 8661) to pass the sink:

```js
            appendOutput(stdout.slice(renderedLen), asHtml, suppress,
                         _nbActive ? window.Cells.sinkForSegment(i) : null);
```

In the catch block (~8677-8681), route the error `pre` to the notebook when active:

```js
        const _errHost = (window.Cells && window.Cells.active() && window.Cells.errorHost()) || outputArea;
        …
        _errHost.appendChild(pre);
```

Also check the `runInlineRSegment(segments[i])` branch (8651): open `runInlineRSegment` (~7124) and see where it renders. If it appends to `outputArea`, thread the sink through as an extra parameter (`runInlineRSegment(seg, target)`) and use `(target || outputArea)` at its append site(s).

- [ ] **Step 6: Result-enhancer observer**

Search `index.html` for `new MutationObserver` near the comment at ~5780 ("debounced MutationObserver på #outputArea"). Expose its scheduling function (or create a wrapper) as `window.mdScheduleResultEnhance`, and in `js/cells.js` `C.enter()` (first time `NB.root` is created), add:

```js
        new MutationObserver(function () {
          if (global.mdScheduleResultEnhance) global.mdScheduleResultEnhance();
        }).observe(NB.root, { childList: true, subtree: true });
```

If the existing enhancer queries only inside `#outputArea`, generalize its query root to cover `#notebookRoot` too (it adds copy buttons on `table, pre, .plotly-container`).

- [ ] **Step 7: Manual verification (python mode)**

Serve the app; paste:

```
#%% md
# Test

#%% python
print("hei")
1 + 1

#%% python
[x * x for x in range(5)]
```

Enter notebook view, click Kjør. Expected: cell 2's output slot shows `hei` and `2` (Phase A keeps show-all display); cell 3's slot shows the list; the md cell keeps its rendered markdown; nothing lands in the hidden `#outputArea`. Introduce a syntax error in cell 3 and re-run: cells before it show output; the error appears in the trailing slot. Then test the fallback: put a literal `## python` line *inside* a cell body and run — all output goes to the single trailing slot (plan mismatch), no crash. Test a duckdb and a microdata document the same way (mode duckdb / microdata, one or two code cells). Test a plot: `#%% python` cell with a plotly figure — the figure renders inside the cell's slot and has a copy button.

- [ ] **Step 8: Run suites**

`node --test tests/js/` → PASS. `.venv/bin/python -m pytest tests/ -x -q -k "manifest or notebook_prose"` → PASS (fast subset; full suite runs in Task 8).

- [ ] **Step 9: Commit**

```bash
git add js/cells.js index.html
git commit -m "feat(cells): kjøring — executableSource ved Kjør + per-celle output-sinks i segmentløkken

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: R-mode output attribution

**Files:**
- Modify: `index.html` (`runHybridR`, ~7513 onward)
- Modify: `js/cells.js` only if the investigation requires an extra helper (it should not)

**Interfaces:**
- Consumes: `Cells.beginRun/sinkForSegment/errorHost`, the target params from Task 6.
- Produces: R-mode notebooks attribute output per cell when `runHybridR` runs segment-wise; otherwise the whole R output renders into the trailing slot (accepted Phase A fallback, spec §6).

- [ ] **Step 1: Investigate how `runHybridR` emits output**

Read `runHybridR` (`index.html:7513` to its end, past 7564 where `parseHybridScript(normalized, …)` is called). Determine: (a) does it loop segments JS-side and render incrementally (look for per-segment `appendOutput`/direct `outputArea.appendChild`), or (b) does it collect everything and call `renderOutput(lastOutput, …)` once (the calls near 8830/8910 — confirm which belongs to this path)?

- [ ] **Step 2a: If it loops segments** — mirror Task 6: `Cells.beginRun(segments.length)` after its output-clearing step, pass `window.Cells.sinkForSegment(i)` as the target of each per-segment render/append, route its error rendering to `Cells.errorHost()`.

- [ ] **Step 2b: If it renders once** — at its final `renderOutput(...)` call, pass the trailing slot:

```js
          renderOutput(lastOutput, asHtml, suppress,
                       (window.Cells && window.Cells.active() && window.Cells.errorHost()) || null);
```

and call `window.Cells.beginRun(0)` up front when active, purely to clear stale cell outputs (returns null; the count `0` intentionally mismatches so sinks stay off). Add a one-line comment that per-cell R attribution is Phase B.

- [ ] **Step 3: Manual verification (r mode)**

Mode = r; paste `#%% md`-cell + two `#%% r` cells (`summary(1:10)`, `plot(1:10)` or `hist(rnorm(100))`). Run. Expected per the branch taken in Step 2: outputs per cell (2a) or all R output in the trailing slot with md still rendered (2b). No console errors; a plain R script (no markers) runs exactly as before.

- [ ] **Step 4: Commit**

```bash
git add index.html js/cells.js
git commit -m "feat(cells): r-modus — output-attribusjon (per segment eller samlet fallback)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: example notebook + manifest + full test pass

**Files:**
- Create: `examples/python/py_notatbok_celler.txt` (if the python examples folder has a different name, e.g. `examples/pyodide/`, follow the existing layout — check `examples/manifest.json` keys)
- Modify: `examples/manifest.json` (via the generator)

**Interfaces:**
- Consumes: the full Phase A feature.
- Produces: a discoverable example notebook in the Examples menu; green suites.

- [ ] **Step 1: Create the example** — `examples/python/py_notatbok_celler.txt`:

```
# label: Notatbok — celler med #%% (python + markdown)
#options.mode = python
#options.title = "Notatbok-celler"
#options.description = "Celler skilles med #%% — markdown, kode og attrs som hide-code"
# load https://raw.githubusercontent.com/hmelberg/openstat/main/data/iris.csv as iris

#%% md
# Iris-notatbok
Dette dokumentet er en **notatbok**: celler skilles med `#%%`.
Kolonner-visning legger output ved siden av hver celle; Stablet under;
Kun output viser bare resultatene. Knappen «Rå tekst» gir vanlig editor.

#%% python
iris.groupby("species")["sepal_length"].mean()

#%% python hide-code
iris.describe()

#%% md style=note
Cellen over har `hide-code` — bare resultatet vises.
```

- [ ] **Step 2: Regenerate the manifest**

Run: `.venv/bin/python examples/generate_manifest.py` (check the script's own usage header if it takes arguments). Verify `examples/manifest.json` gained the entry with the label above.

- [ ] **Step 3: Full suites**

Run: `node --test tests/js/` → all PASS.
Run: `.venv/bin/python -m pytest tests/ -q` → all PASS (the pre-existing suite plus manifest tests; no Python engine code was touched, so any failure here means a repo regression — investigate before proceeding).

- [ ] **Step 4: Manual: load the example from the Examples menu**

Serve; pick the new example in the Examples menu (python mode). The 1 s tick detects the programmatic content change → notebook auto-renders (or the chip appears if raw override was on). Run it; verify per-cell outputs and the `hide-code` cell showing only output.

- [ ] **Step 5: Commit**

```bash
git add examples/
git commit -m "feat(cells): eksempel-notatbok + manifest

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: regression sweep + docs touch

**Files:**
- Modify: `README.md` (one line in the layout table for `js/cells.js`)

**Interfaces:** none new — this is the exit gate.

- [ ] **Step 1: No-marker regression checklist** (manual, served app)

1. Plain python script: run → output identical to before; all four view-dropdown entries behave as before; no chip.
2. Existing dashboard example (`examples/ex_dashboard_iris.py` or a brython dashboard): renders and re-runs correctly.
3. Skrittvis on a plain script: unchanged (dock, TTS).
4. A legacy hybrid script with `## r` inside a python script (no `#%%`): runs as before, NOT treated as a notebook.
5. Share-link flow: create a share link for a notebook document, open it → text intact, notebook auto-renders.
6. Kolonner/Stablet resizer and output-only toggle on a plain script: unchanged.

- [ ] **Step 2: README line** — add to the layout table:

```
| `js/cells.js` | Notebook cells: `#%%` parsing/serialisering (ren halvdel, node-testet) + celle-rendrer for visningene (spec `docs/superpowers/specs/2026-07-13-notebook-cells-design.md`). |
```

- [ ] **Step 3: Final suites** — `node --test tests/js/` and `.venv/bin/python -m pytest tests/ -q` → all PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: js/cells.js i layout-tabellen (notatbok-celler, fase A)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
