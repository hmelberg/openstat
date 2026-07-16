# `#tag.` Cell Directives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `#tag.key = value` cell directives, content-sniffed cell types (`"""`→md, `<`→html) and preamble tag defaults, per `docs/superpowers/specs/2026-07-16-tag-directives-design.md`.

**Architecture:** Everything lands in the parse result (`C.parseCells` in `js/cells.js`, the pure half): a new scanner `C.scanTagBlock` finds tag lines, a post-pass merges them into `cell.attrs`/`cell.type` (header wins), sniffs unmarked cells, and applies preamble defaults. Two derived accessors — `C.renderContent` (tags/delimiters removed, for md/html rendering) and `C.execCellSource` (tag lines blanked in place, line count preserved, for execution) — are wired into the existing consumers. No new consumer logic: `resolveType`, `segmentPlan`, `executableSource`, `alignPlan` pick up tag-set types automatically because the merge is baked into the parse.

**Tech Stack:** ES5 var-style JS (`js/cells.js`, `index.html`), node built-in test runner (`tests/js/`), no build step.

## Global Constraints

- **Paramount invariant (spec 1):** documents without `#%%` behave byte-identically to today. `#tag.` has meaning only inside `#%%` documents.
- **Round-trip guarantee unchanged:** `serializeCells(parseCells(t).cells) === t`. Tags live in `cell.source`; never rewrite text.
- **Line-count preservation** in all execution transforms (blank lines in place, never delete).
- The hybrid segment machinery in index.html (`parseHybridScripts`, `matchHybridMarker`, flush) is **not modified**.
- ES5 `var`-style JS, Norwegian comments, user-facing strings through `t()`.
- Test baselines before this plan: `node --test tests/js/cells.test.js` → 70 pass; `node --test tests/js/*.test.js` → 493 tests / 489 pass / 4 fail (pre-existing ENOENT fixtures — do not touch); `python -m pytest tests/ -q` → 1228 pass baseline (no pytest changes expected in this plan).
- Run node tests from the repo root: `/Users/hom/Documents/GitHub/openstat`.

---

### Task 1: `C.scanTagBlock` — the pure tag-line scanner

**Files:**
- Modify: `js/cells.js` (pure half — insert after the `C.parseHeader` function, i.e. after line ~95, before the `parseCells` doc comment)
- Test: `tests/js/cells.test.js` (append)

**Interfaces:**
- Consumes: existing module-level vocabularies `TYPES`, `ALIASES`, `KNOWN_KEYS`, `KNOWN_FLAGS`, `STYLES`, `WIDGETS_POS`, `ID_RE` (js/cells.js lines 12-25).
- Produces: `C.scanTagBlock(source, isPreamble)` → `{ tags: Object, entries: [{key, value, line}], tagLines: [int], warnings: [{line, msg}] }`. Line numbers are **body-relative 0-based**. `tags` is last-wins; `entries` preserves every stored occurrence in order. Task 2 (parseCells post-pass), Task 3 (`renderContent`) depend on this exact shape.

- [ ] **Step 1: Write the failing tests**

Append to `tests/js/cells.test.js` (follow the existing `test('...', () => {...})` idiom; the module is already loaded as `C` at the top):

```js
// ---------- #tag-celledirektiver (spec 2026-07-16-tag-directives-design.md) ----------

test('scanTagBlock: enkel blokk — nøkler lowercases, verdier koerseres', () => {
  const s = C.scanTagBlock('#tag.ID = plot\n#tag.slide = 3\n#tag.hide-code = true\nx = 1', false);
  assert.deepStrictEqual(s.tags, { id: 'plot', slide: '3', 'hide-code': true });
  assert.deepStrictEqual(s.tagLines, [0, 1, 2]);
  assert.deepStrictEqual(s.warnings, []);
});

test('scanTagBlock: siterte verdier strippes, false koerseres, verdi-case bevares', () => {
  const s = C.scanTagBlock('#tag.speak = "Hei Du"\n#tag.style = \'note\'\n#tag.hide-output = false', false);
  assert.deepStrictEqual(s.tags, { speak: 'Hei Du', style: 'note', 'hide-output': false });
});

test('scanTagBlock: ledende blanklinjer tillatt; blank/innhold avslutter blokken', () => {
  const s = C.scanTagBlock('\n\n#tag.slide = 1\n\n#tag.slide = 2\nkode', false);
  assert.deepStrictEqual(s.tags, { slide: '1' });
  assert.deepStrictEqual(s.tagLines, [2]);
});

test('scanTagBlock: første innholdslinje → ingen blokk; senere tag-linje varsles og er inert', () => {
  const s = C.scanTagBlock('x = 1\n#tag.slide = 2', false);
  assert.deepStrictEqual(s.tags, {});
  assert.deepStrictEqual(s.tagLines, []);
  assert.strictEqual(s.warnings.length, 1);
  assert.strictEqual(s.warnings[0].line, 1);
  assert.ok(/utenfor tagg-blokken/.test(s.warnings[0].msg));
});

test('scanTagBlock: ugyldig tag-linje konsumeres inn i blokken med varsel — demoterer ikke resten', () => {
  const s = C.scanTagBlock('#tag.slide = 1\n#tag.oops\n#tag.speak = hei\nx', false);
  assert.deepStrictEqual(s.tags, { slide: '1', speak: 'hei' });
  assert.deepStrictEqual(s.tagLines, [0, 1, 2]);
  assert.strictEqual(s.warnings.length, 1);
  assert.ok(/ugyldig #tag-linje/.test(s.warnings[0].msg));
});

test('scanTagBlock: validering — ukjent nøkkel lagres med varsel (header-leniens); type normaliseres via alias', () => {
  const s = C.scanTagBlock('#tag.foo = bar\n#tag.type = py', false);
  assert.strictEqual(s.tags.foo, 'bar');
  assert.strictEqual(s.tags.type, 'python');
  assert.strictEqual(s.warnings.length, 1);
  assert.ok(/ukjent attributt: foo/.test(s.warnings[0].msg));
});

test('scanTagBlock: ugyldig type/id droppes med varsel; ukjent style lagres med varsel', () => {
  const s = C.scanTagBlock('#tag.type = klingon\n#tag.id = "a b"\n#tag.style = fancy', false);
  assert.strictEqual(s.tags.type, undefined);
  assert.strictEqual(s.tags.id, undefined);
  assert.strictEqual(s.tags.style, 'fancy');
  assert.strictEqual(s.warnings.length, 3);
});

test('scanTagBlock: duplisert nøkkel — siste vinner, varsel', () => {
  const s = C.scanTagBlock('#tag.slide = 1\n#tag.slide = 2', false);
  assert.strictEqual(s.tags.slide, '2');
  assert.strictEqual(s.warnings.length, 1);
  assert.ok(/duplisert/.test(s.warnings[0].msg));
});

test('scanTagBlock: fleksibel whitespace og "# tag."-variant', () => {
  const s = C.scanTagBlock('  # tag.slide=3\n#tag.speak =  hei du ', false);
  assert.deepStrictEqual(s.tags, { slide: '3', speak: 'hei du' });
});

test('scanTagBlock preambel: tags plukkes fra ledende #-kommentar-kjede, direktivlinjer urørt', () => {
  const src = '# label: Demo\n#options.mode = python\n#tag.type = r\n# load x.csv as x\n#tag.slide = 1\nx = 1\n#tag.speak = nei';
  const s = C.scanTagBlock(src, true);
  assert.deepStrictEqual(s.tags, { type: 'r', slide: '1' });
  assert.deepStrictEqual(s.tagLines, [2, 4]);
  // #tag etter første kodelinje: utenfor — varsles
  assert.strictEqual(s.warnings.length, 1);
  assert.strictEqual(s.warnings[0].line, 6);
});

test('scanTagBlock preambel: id kan ikke være dokument-default', () => {
  const s = C.scanTagBlock('#tag.id = plot', true);
  assert.strictEqual(s.tags.id, undefined);
  assert.strictEqual(s.warnings.length, 1);
  assert.ok(/dokument-default/.test(s.warnings[0].msg));
});

test('scanTagBlock: tom kropp og kropp uten tags → tomt resultat', () => {
  assert.deepStrictEqual(C.scanTagBlock('', false).tagLines, []);
  assert.deepStrictEqual(C.scanTagBlock('x = 1\ny = 2', false).tags, {});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/js/cells.test.js`
Expected: FAIL — `C.scanTagBlock is not a function` for each new test; the pre-existing 70 still pass.

- [ ] **Step 3: Implement `C.scanTagBlock`**

Insert into `js/cells.js` after `C.parseHeader` (after line ~95), before the `parseCells` doc comment:

```js
  // ---------- #tag-celledirektiver (spec 2026-07-16-tag-directives-design.md) ----------

  var TAG_PREFIX_RE = /^\s*#\s*tag\./;
  var TAG_LINE_RE = /^\s*#\s*tag\.([A-Za-z_][\w-]*)\s*=\s*(.+?)\s*$/;

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
      if (key === 'style' && !STYLES[val]) res.warnings.push({ line: i, msg: 'ukjent style: ' + val });
      if (key === 'widgets' && !WIDGETS_POS[val]) res.warnings.push({ line: i, msg: 'ukjent widgets-plassering: ' + val });
      if (Object.prototype.hasOwnProperty.call(res.tags, key)) {
        res.warnings.push({ line: i, msg: 'duplisert #tag-nøkkel: ' + key });
      }
      res.tags[key] = val;
      res.entries.push({ key: key, value: val, line: i });
    }
    return res;
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/js/cells.test.js`
Expected: PASS — 82 tests (70 pre-existing + 12 new), 0 fail.

- [ ] **Step 5: Commit**

```bash
git add js/cells.js tests/js/cells.test.js
git commit -m "feat(cells): C.scanTagBlock — ren skanner for #tag.-celledirektiver"
```

---

### Task 2: parseCells integration — merge, sniffing, preamble defaults

**Files:**
- Modify: `js/cells.js` — `C.parseCells` (lines ~102-133; add a post-pass before `return`), plus two new module-level helper functions next to `scanTagBlock`
- Test: `tests/js/cells.test.js` (append)

**Interfaces:**
- Consumes: `C.scanTagBlock(source, isPreamble)` from Task 1 (exact return shape above).
- Produces: every cell from `C.parseCells` gains `tags` (object), `tagLines` (array of body-relative ints), `sniffed` (`'md' | 'html' | null`); `cell.type` and `cell.attrs` are now the **effective** merged values (precedence: header attr > cell tag > (type only: sniff) > preamble default). Also produces the internal (non-exported) helper `linesWithoutTags(source, tagLines)` → array of lines, which Task 3's `renderContent` reuses. The preamble cell itself keeps `type: null, attrs: {}`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/js/cells.test.js`:

```js
test('parseCells: cellens tags merges inn i attrs; tagLines/sniffed settes', () => {
  const p = C.parseCells('#%% python\n#tag.slide = 3\n#tag.hide-code = true\nx = 1');
  const c = p.cells[0];
  assert.strictEqual(c.attrs.slide, '3');
  assert.strictEqual(c.attrs['hide-code'], true);
  assert.deepStrictEqual(c.tags, { slide: '3', 'hide-code': true });
  assert.deepStrictEqual(c.tagLines, [0, 1]);
  assert.strictEqual(c.sniffed, null);
  assert.deepStrictEqual(p.warnings, []);
});

test('parseCells: #tag.type setter celletypen når headeren ikke har en', () => {
  const p = C.parseCells('#%%\n#tag.type = r\nx <- 1');
  assert.strictEqual(p.cells[0].type, 'r');
  assert.strictEqual(C.resolveType(p.cells[0], 'python'), 'r');
});

test('parseCells: header vinner over tag — verdi beholdes, varsel med absolutt linjetall', () => {
  const p = C.parseCells('#%% python slide=1\n#tag.slide = 2\n#tag.type = r\nx = 1');
  const c = p.cells[0];
  assert.strictEqual(c.attrs.slide, '1');
  assert.strictEqual(c.type, 'python');
  assert.strictEqual(p.warnings.length, 2);
  assert.ok(p.warnings.some((w) => /^linje 2: #tag\.slide overstyrt av #%%-attributt$/.test(w)));
  assert.ok(p.warnings.some((w) => /^linje 3: #tag\.type overstyrt av #%%-typen$/.test(w)));
});

test('parseCells: duplisert tag-nøkkel — siste vinner også i merge (ingen falskt overstyrt-varsel)', () => {
  const p = C.parseCells('#%%\n#tag.type = r\n#tag.type = md\nheisann');
  assert.strictEqual(p.cells[0].type, 'md');
  // kun duplikat-varselet fra skanneren, INGEN 'overstyrt av #%%-typen'
  assert.strictEqual(p.warnings.length, 1);
  assert.ok(/duplisert/.test(p.warnings[0]));
});

test('parseCells sniffing: lone-string """-celle → md; docstring + kode forblir kode', () => {
  const md = C.parseCells('#%%\n"""\n# Overskrift\ntekst\n"""');
  assert.strictEqual(md.cells[0].type, 'md');
  assert.strictEqual(md.cells[0].sniffed, 'md');
  const code = C.parseCells('#%%\n"""docstring"""\nx = 1');
  assert.strictEqual(code.cells[0].type, null);
  assert.strictEqual(code.cells[0].sniffed, null);
});

test('parseCells sniffing: enlinjes """x""" → md; """ midt i teksten etterfulgt av kode → kode', () => {
  assert.strictEqual(C.parseCells('#%%\n"""Hei **verden**"""').cells[0].sniffed, 'md');
  // første lukker etter 'a', deretter kode → IKKE sniffet (indexOf-regelen, ingen backtracking)
  assert.strictEqual(C.parseCells('#%%\n"""a""" b\nx = """s"""').cells[0].sniffed, null);
});

test('parseCells sniffing: """ må stå i kolonne 0; uavsluttet streng sniffes ikke', () => {
  assert.strictEqual(C.parseCells('#%%\n  """tekst"""').cells[0].sniffed, null);
  assert.strictEqual(C.parseCells('#%%\n"""aldri lukket').cells[0].sniffed, null);
});

test('parseCells sniffing: <-førstelinje → html; ledende blanklinjer og tag-blokk hoppes over', () => {
  const p = C.parseCells('#%%\n#tag.slide = 2\n\n  <div>hei</div>');
  assert.strictEqual(p.cells[0].type, 'html');
  assert.strictEqual(p.cells[0].sniffed, 'html');
  assert.strictEqual(p.cells[0].attrs.slide, '2');
});

test('parseCells sniffing: eksplisitt type (header eller tag) vinner over sniff', () => {
  assert.strictEqual(C.parseCells('#%% python\n"""bare en streng"""').cells[0].sniffed, null);
  const p = C.parseCells('#%%\n#tag.type = python\n"""bare en streng"""');
  assert.strictEqual(p.cells[0].type, 'python');
  assert.strictEqual(p.cells[0].sniffed, null);
});

test('parseCells preambel-defaults: type og attrs gjelder celler uten egen verdi', () => {
  const src = '#tag.type = r\n#tag.hide-code = true\n# load x\n\n#%%\ny <- 1\n#%% python slide=1\nz = 2\n#%%\n#tag.hide-code = false\nw <- 3';
  const p = C.parseCells(src);
  // preambelen selv røres ikke
  assert.strictEqual(p.cells[0].type, null);
  assert.deepStrictEqual(p.cells[0].attrs, {});
  // celle 1: arver begge defaults
  assert.strictEqual(p.cells[1].type, 'r');
  assert.strictEqual(p.cells[1].attrs['hide-code'], true);
  // celle 2: header-type vinner; attrs-default gjelder fortsatt
  assert.strictEqual(p.cells[2].type, 'python');
  assert.strictEqual(p.cells[2].attrs.slide, '1');
  assert.strictEqual(p.cells[2].attrs['hide-code'], true);
  // celle 3: egen tag overstyrer defaulten
  assert.strictEqual(p.cells[3].attrs['hide-code'], false);
  assert.strictEqual(p.cells[3].type, 'r');
});

test('parseCells: sniff vinner over preambel-default (umerket prosacelle i typet dokument)', () => {
  const p = C.parseCells('#tag.type = python\n\n#%%\n"""# Notat"""');
  assert.strictEqual(p.cells[1].type, 'md');
  assert.strictEqual(p.cells[1].sniffed, 'md');
});

test('parseCells: round-trip-garantien holder med tags og sniffede celler', () => {
  const src = '#tag.type = python\n# load x\n\n#%%\n#tag.slide = 3\n"""tekst"""\n#%% r id=a\n#tag.speak = hei\ny <- 1';
  assert.strictEqual(C.serializeCells(C.parseCells(src).cells), src);
});

test('parseCells: #tag.type = r gir r-segment i python-dokument (segmentPlan + executableSource)', () => {
  const src = '#%%\n#tag.type = r\ny <- 1\n#%% python\nx = 1';
  assert.deepStrictEqual(C.segmentPlan(src, 'python'), [0, 1]);
  const exec = C.executableSource(src, 'python');
  assert.ok(/^## r$/m.test(exec));
  assert.ok(/^## python$/m.test(exec));
});

test('parseCells: sniffet md-celle blankes av executableSource (ikke-kode)', () => {
  const src = '#%% python\nx = 1\n#%%\n"""tekst"""';
  const exec = C.executableSource(src, 'python');
  assert.strictEqual(exec.split('\n').length, src.split('\n').length);
  assert.ok(exec.indexOf('tekst') === -1);
  assert.deepStrictEqual(C.segmentPlan(src, 'python'), [0]);
});

test('parseCells: ingen #%% → ingen tag-maskineri påvirker dokumentet (paramount-invarianten)', () => {
  const src = '#tag.type = r\nx = 1';
  assert.strictEqual(C.executableSource(src, 'python'), src);
  // parseCells på ren tekst: preambel-cellen beholder type null/attrs {}
  const p = C.parseCells(src);
  assert.strictEqual(p.cells[0].type, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/js/cells.test.js`
Expected: FAIL on the new `parseCells:`-prefixed tests (`c.tags` undefined, types not merged); the 82 from Task 1 still pass.

- [ ] **Step 3: Implement the post-pass**

(a) Add two module-level helpers right after `C.scanTagBlock` in `js/cells.js`:

```js
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
    if (first === -1) return null;
    if (/^\s*</.test(lines[first])) return 'html';
    if (lines[first].slice(0, 3) !== '"""') return null;
    var rest = lines.slice(first).join('\n').slice(3);
    var close = rest.indexOf('"""');
    if (close === -1) return null;
    if (rest.slice(close + 3).trim() !== '') return null;
    return 'md';
  }
```

(b) In `C.parseCells`, immediately before `return { cells: cells, warnings: warnings };` (after the final `close(...)` call), add the post-pass:

```js
    // --- #tag-direktiver: merge, sniffing, preambel-defaults (spec §1-§3).
    // Kjøres som post-pass over ferdiglukkede celler: presedens
    // header-attr > celle-tag > (kun type: sniff) > preambel-default.
    // Merge baker effektive attrs/type inn i celleobjektet — round-trip
    // røres ikke (serialisering bruker headerRaw + source, aldri attrs).
    var defaults = { type: null, attrs: {} };
    for (var ci = 0; ci < cells.length; ci++) {
      var cell = cells[ci];
      var isPre = cell.headerRaw === null;
      var scan = C.scanTagBlock(cell.source, isPre);
      cell.tags = scan.tags;
      cell.tagLines = scan.tagLines;
      cell.sniffed = null;
      var bodyBase = isPre ? cell.startLine : cell.startLine + 1;
      for (var wi = 0; wi < scan.warnings.length; wi++) {
        warnings.push('linje ' + (bodyBase + scan.warnings[wi].line + 1) + ': ' + scan.warnings[wi].msg);
      }
      if (isPre) {
        // Preambelens tags er DOKUMENT-defaults (spec §2): type = default
        // CELLE-type (retyper aldri preambelen selv), øvrige nøkler =
        // attr-defaults. id er alt avvist av skanneren i preambel-modus.
        for (var pk in scan.tags) {
          if (pk === 'type') defaults.type = scan.tags[pk];
          else defaults.attrs[pk] = scan.tags[pk];
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
        if (Object.prototype.hasOwnProperty.call(cell.attrs, mk)) {
          warnings.push('linje ' + lineNo + ': #tag.' + mk + ' overstyrt av #%%-attributt');
          continue;
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
```

Also update the cell-shape doc comment above `parseCells` (lines ~97-101) to mention the three new fields (`tags`, `tagLines`, `sniffed`) and that `type`/`attrs` are effective (merged) values.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/js/cells.test.js`
Expected: PASS — 97 tests (82 + 15 new), 0 fail. If any PRE-EXISTING test fails, stop and investigate before proceeding (the merge must not change documents without tags).

- [ ] **Step 5: Run the full node suite (regression)**

Run: `node --test tests/js/*.test.js`
Expected: 4 fail max (the known ENOENT baseline), everything else pass.

- [ ] **Step 6: Commit**

```bash
git add js/cells.js tests/js/cells.test.js
git commit -m "feat(cells): #tag-merge i parseCells — presedens, innholds-sniffing, preambel-defaults"
```

---

### Task 3: `execCellSource` / `renderContent` + pure-half consumers

**Files:**
- Modify: `js/cells.js` — new exported helpers (next to `scanTagBlock`), `C.executableSource` (lines ~165-179), `C.forklarCellSteps` (lines ~270-290)
- Test: `tests/js/cells.test.js` (append)

**Interfaces:**
- Consumes: `cell.tagLines`, `cell.sniffed` from Task 2; internal `linesWithoutTags`.
- Produces: `C.execCellSource(cell)` → string, `cell.source` with tag lines blanked in place (line count identical). `C.renderContent(source, type, sniffed)` → string, body minus tag lines; for `type === 'md' && sniffed === 'md'` the text between the `"""` delimiters (one leading/trailing newline trimmed), falling back to the tag-stripped body if the lone-string pattern no longer holds. Task 4 (DOM half + index.html) calls both.

- [ ] **Step 1: Write the failing tests**

Append to `tests/js/cells.test.js`:

```js
test('execCellSource: tag-linjer blankes PÅ PLASS — linjetall bevares', () => {
  const p = C.parseCells('#%% duckdb\n#tag.id = tab\n#tag.slide = 2\nselect 1');
  const out = C.execCellSource(p.cells[0]);
  assert.strictEqual(out, '\n\nselect 1');
  assert.strictEqual(out.split('\n').length, p.cells[0].source.split('\n').length);
});

test('execCellSource: celle uten tags returnerer kilden uendret; null-celle → tom streng', () => {
  const p = C.parseCells('#%% python\nx = 1');
  assert.strictEqual(C.execCellSource(p.cells[0]), 'x = 1');
  assert.strictEqual(C.execCellSource(null), '');
});

test('renderContent: tag-linjer fjernes; sniffet md → indre tekst uten delimitere', () => {
  assert.strictEqual(C.renderContent('#tag.slide = 1\n"""\n# Hei\n"""', 'md', 'md'), '# Hei');
  assert.strictEqual(C.renderContent('"""enlinjes **fet**"""', 'md', 'md'), 'enlinjes **fet**');
});

test('renderContent: eksplisitt md-celle beholder """ (kun sniffede strippes); html får tags fjernet', () => {
  assert.strictEqual(C.renderContent('"""x"""', 'md', null), '"""x"""');
  assert.strictEqual(C.renderContent('#tag.slide = 1\n<div>x</div>', 'html', 'html'), '<div>x</div>');
});

test('renderContent: fallback når lone-string-mønsteret ikke lenger holder etter redigering', () => {
  assert.strictEqual(C.renderContent('"""x"""\nkode()', 'md', 'md'), '"""x"""\nkode()');
});

test('executableSource: tag-blokken blankes i kodeceller OG preambel — linjetall eksakt bevart', () => {
  const src = '#tag.type = python\n# load x\n\n#%%\n#tag.slide = 1\nx = 1\n#%% duckdb\n#tag.id = t\nselect 1';
  const exec = C.executableSource(src, 'python');
  const lines = exec.split('\n');
  assert.strictEqual(lines.length, src.split('\n').length);
  assert.strictEqual(lines[0], '');            // preambel-tag blanket
  assert.strictEqual(lines[1], '# load x');    // direktivlinje urørt
  assert.strictEqual(lines[3], '## python');   // #tag.type-default → python-segment
  assert.strictEqual(lines[4], '');            // celle-tag blanket
  assert.strictEqual(lines[5], 'x = 1');
  assert.strictEqual(lines[7], '');            // duckdb-cellens tag blanket ('#' er ikke SQL)
  assert.strictEqual(lines[8], 'select 1');
});

test('executableSource: celle med KUN tag-blokk ≙ tom celle (kjent godartet plan/kjøretids-asymmetri)', () => {
  // Samme oppførsel som '#%% python' uten kropp: segmentPlan tar cellen med,
  // flush() dropper det tomme segmentet — alignPlan-fallbacken håndterer det
  // (ledger Task 9). Pinnes her: blankingen skal IKKE endre denne likheten.
  const tagOnly = '#%% python\n#tag.slide = 1\n#%% python\nx = 1';
  const empty = '#%% python\n\n#%% python\nx = 1';
  assert.strictEqual(C.executableSource(tagOnly, 'python'), C.executableSource(empty, 'python'));
  assert.deepStrictEqual(C.segmentPlan(tagOnly, 'python'), [0, 1]);
});

test('forklarCellSteps: md-steg bruker renderContent (sniffede celler taler uten delimitere), kode-steg blankes', () => {
  const src = '#%%\n"""\n# Hei\n"""\n#%% python\n#tag.slide = 1\nx = 1';
  const steps = C.forklarCellSteps(src, 'python');
  assert.strictEqual(steps.length, 2);
  const mdStep = steps.find((s) => s.kind === 'md');
  assert.strictEqual(mdStep.source, '# Hei');
  const codeStep = steps.find((s) => s.kind === 'code');
  assert.strictEqual(codeStep.source, '\nx = 1');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/js/cells.test.js`
Expected: FAIL — `C.execCellSource is not a function`, `C.renderContent is not a function`, and the `executableSource`/`forklarCellSteps` assertions.

- [ ] **Step 3: Implement helpers and rewire the two pure-half consumers**

(a) Add after `sniffType` in `js/cells.js`:

```js
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
      var first = -1;
      for (var i = 0; i < kept.length; i++) {
        if (kept[i].trim() !== '') { first = i; break; }
      }
      if (first !== -1 && kept[first].slice(0, 3) === '"""') {
        var rest = kept.slice(first).join('\n').slice(3);
        var close = rest.indexOf('"""');
        if (close !== -1 && rest.slice(close + 3).trim() === '') {
          out = rest.slice(0, close).replace(/^\n/, '').replace(/\n$/, '');
        }
      }
    }
    return out;
  };
```

(b) In `C.executableSource` (lines ~165-179), route both emit paths through `execCellSource`:

- line ~171: `out.push(c.source)` → `out.push(C.execCellSource(c))` (preamble)
- line ~176: `out.push(SEG_MARKER[type] + '\n' + c.source)` → `out.push(SEG_MARKER[type] + '\n' + C.execCellSource(c))`

(the `!c.hasBody` branch at ~175 is unchanged). Extend the function's doc comment: tag lines are blanked (spec §4).

(c) In `C.forklarCellSteps` (lines ~270-290):

- code step (~279): `source: cells[idx].source` → `source: C.execCellSource(cells[idx])`
- md step (~285): `source: c.source` → `source: C.renderContent(c.source, 'md', c.sniffed)`

Note in the function comment that sniffed md cells now become narration steps automatically (they resolve to `md`), and their delimiters/tags never reach TTS.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/js/cells.test.js`
Expected: PASS — 105 tests (97 + 8 new), 0 fail.

- [ ] **Step 5: Full node suite regression**

Run: `node --test tests/js/*.test.js`
Expected: only the 4 known ENOENT failures.

- [ ] **Step 6: Commit**

```bash
git add js/cells.js tests/js/cells.test.js
git commit -m "feat(cells): execCellSource/renderContent — tag-blanking i kjøring, tag-/delimiter-fri rendring (executableSource, forklar)"
```

---

### Task 4: DOM half + index.html wiring

**Files:**
- Modify: `js/cells.js` — `cellNode` (two `renderNonCode` call sites, lines ~811 and ~824), `C.runCell` payload (line ~1575)
- Modify: `index.html` — `runNotebookEngineCell` preamble run (line ~9508: `sess.runCell(_pre.source || '')`), cache-bust `js/cells.js?v=` (line ~581)
- Modify: `sw.js` — bump `const CACHE = 'm2py-v18'` (line ~6) to `'m2py-v19'`
- Test: `tests/js/cells-dom.test.js` (append)

**Interfaces:**
- Consumes: `C.renderContent(source, type, sniffed)`, `C.execCellSource(cell)` from Task 3; `cell.sniffed` from Task 2.
- Produces: no new API. After this task every render and execution path is tag-clean; the editor textarea (`.nb-src`) still shows raw source including tags (spec: raw IS the editor).

- [ ] **Step 1: Write the failing stub-DOM tests**

Append to `tests/js/cells-dom.test.js`. The suite's helpers are already defined in the file: `freshEnv()` → `{ C, scriptInputEl, containerEl }` (fresh DOM stub + fresh `require` of cells.js), `C.init(mode)` activates the notebook from `scriptInputEl.value`, `collectNodes(node, [])` flattens the tree, `nbRoot(containerEl)` finds the notebook root, `cellParts(containerEl, idx)` returns `{ wrap, ta, out, … }` for one cell (see the existing `runCell: eksplisitt python-celle → riktig payload` test at ~line 638 for the exact pattern):

```js
// ---- #tag-direktiver (spec 2026-07-16-tag-directives-design.md, Task 4) ----

test('sniffet md-celle rendres uten """ og uten tag-linjer; textarea beholder rå kilde', () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% python\nx = 1\n#%%\n#tag.slide = 1\n"""\n# Hei\n"""\n';
  C.init('python');
  assert.strictEqual(C.active(), true);

  const nodes = collectNodes(nbRoot(containerEl), []);
  const mdDiv = nodes.find((n) => n.classList && n.classList.contains('output-markdown'));
  assert.ok(mdDiv, 'sniffet celle rendres som markdown (nb-rendered-only)');
  const rendered = (mdDiv.innerHTML || '') + (mdDiv.textContent || '');
  assert.ok(rendered.includes('Hei'), 'innholdet rendres');
  assert.ok(!rendered.includes('"""'), 'delimiterne er skjult i rendringen');
  assert.ok(!rendered.includes('#tag'), 'tag-linjene er skjult i rendringen');

  const cell1 = cellParts(containerEl, 1);
  assert.ok(cell1.ta.value.includes('#tag.slide = 1'), 'textarea viser rå kilde (tags)');
  assert.ok(cell1.ta.value.includes('"""'), 'textarea viser rå kilde (delimitere)');
});

test('runCell: payload.text er tag-blanket (linjetall bevart)', async () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\n#tag.slide = 1\nx = 1\n';
  C.init('python');
  assert.strictEqual(C.active(), true);

  let captured = null;
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = (payload) => {
    captured = payload;
    return Promise.resolve({ text: 'ok' });
  };

  await C.runCell(0);

  assert.ok(captured, 'mdRunNotebookCell kalles');
  assert.strictEqual(captured.text, '\nx = 1', 'tag-linjen blanket PÅ PLASS');
  assert.strictEqual(captured.cellIdx, 0);
});

test('hide-code via #tag gir nb-hide-code-klassen (attrs-mergen når DOM-en uten egen wiring)', () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% python\n#tag.hide-code = true\nx = 1\n';
  C.init('python');
  const cell0 = cellParts(containerEl, 0);
  assert.ok(cell0.wrap.classList.contains('nb-hide-code'));
});
```

Note for the first test: `scriptInputEl.value` ends with `\n`, so the sniffed cell's body is `#tag.slide = 1\n"""\n# Hei\n"""\n` — the lone-string rule still matches (trailing blank line after the closer is whitespace). If `cellParts` lacks a field you need, extend the assertion via `collectNodes` instead of changing the helper.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/js/cells-dom.test.js`
Expected: the three new tests FAIL (`"""` present in markdown node, payload.text contains `#tag`, etc.); pre-existing tests pass.

- [ ] **Step 3: Implement the four call-site changes**

(a) `js/cells.js` `cellNode` line ~811:
```js
        renderNonCode(body, type, C.renderContent(c.source, type, c.sniffed));
```
(b) `js/cells.js` `cellNode` blur handler line ~824:
```js
          renderNonCode(body, type, C.renderContent(ta.value, type, c.sniffed));
```
(c) `js/cells.js` `C.runCell` payload line ~1575:
```js
        text: C.execCellSource(c) || '',
```
(d) `index.html` line ~9508 (in `runNotebookEngineCell`):
```js
            var _preRes = await sess.runCell(window.Cells.execCellSource(_pre) || '');
```
Add a one-line Norwegian comment at (d): preambelens tag-linjer blankes (spec 2026-07-16-tag-directives) — samme kontrakt som executableSource.

(e) `index.html` line ~581: bump `js/cells.js?v=2026-07-16a` → `js/cells.js?v=2026-07-16c` (a is current, b is taken by ui.js — pick the next unused suffix for the date if different at implementation time).

(f) `sw.js` line ~6: `const CACHE = 'm2py-v18'` → `'m2py-v19'`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/js/cells-dom.test.js`
Expected: PASS, 0 fail.

- [ ] **Step 5: Full node suite regression**

Run: `node --test tests/js/*.test.js`
Expected: only the 4 known ENOENT failures. (param-forms-dom tests exercise `ParamForms.decorate(idx, wrap, c.source, …)` — unchanged, tags are inert to its `LINE_RE`.)

- [ ] **Step 6: Commit**

```bash
git add js/cells.js index.html sw.js tests/js/cells-dom.test.js
git commit -m "feat(cells): tag-fri rendring og kjøring — renderNonCode/runCell/motor-preambel + cache-bump"
```

---

### Task 5: Example, docs touch-up, exit gate (browser sweep)

**Files:**
- Create: `examples/python/py_tag_direktiver.txt`
- Modify: `examples/manifest.json` (via `python3 examples/generate_manifest.py` — verify the diff is purely additive)
- Modify: `docs/superpowers/specs/2026-07-16-tag-directives-design.md` (status line: DELIVERED + date at top)
- Test: browser (Playwright or Claude-in-Chrome) against a locally served repo root

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: the shipped example + verified exit gate; report file `.superpowers/sdd/task-tag-5-report.md` with the sweep matrix results.

- [ ] **Step 1: Write the example**

`examples/python/py_tag_direktiver.txt` (follow `examples/python/py_widgets_ui.txt` conventions — `# label:` first line, `#options.*`, then content; Norwegian prose):

```
# label: Notatbok — #tag-direktiver og innholds-sniffing
#options.mode = python
#options.title = "Celle-direktiver med #tag"
#options.description = "#tag.key = value i cellekroppen: metadata som overlever Colab/Jupytext-runde-turer, defaults i preambelen, og celler som selv røper typen sin"
#tag.type = python

#%%
"""
# `#tag`-direktiver

Metadata kan ligge som kommentarlinjer ØVERST i cellekroppen i stedet for
på `#%%`-linjen: `#tag.key = value`, én per linje. Colab og Jupytext eier
`#%%`-linjene og skriver dem om — kommentarlinjer i kroppen overlever
alltid. Denne cellen er dessuten *sniffet*: den er én `"""`-streng alene,
og rendres derfor som markdown uten noen `md`-markering.

- `#tag.type = python` i preambelen over gir dokumentets standard-celletype.
- `#tag.hide-code = true` under skjuler koden i cellen, som header-flagget.
- Alt vises fortsatt som ren tekst i editoren — rå tekst ER editoren.
"""

#%%
#tag.hide-code = true
#tag.id = beregning
summen = sum(range(10))
summen

#%%
<p>Denne cellen begynner med <code>&lt;</code> og sniffes som <b>html</b>.</p>

#%% duckdb
#tag.id = tabell
select 42 as svar
```

- [ ] **Step 2: Regenerate the manifest**

Run: `python3 examples/generate_manifest.py`
Then: `git diff examples/manifest.json` — expected: ONE added entry for `python/py_tag_direktiver.txt` with the label from the `# label:` line. If anything else changed, stop and investigate.

- [ ] **Step 3: Browser exit-gate sweep**

Serve the repo (`python3 -m http.server 8899` from the repo root; use a fresh port and cache-bypass) and verify in the browser, loading the new example plus ad-hoc documents. Record each row PASS/FAIL in `.superpowers/sdd/task-tag-5-report.md`:

1. The example loads: sniffed md cell renders as markdown (no `"""`, no `#tag` visible), html cell renders live (after Kjør/Vis HTML — trust gate), duckdb cell shows `svar 42` after Kjør alle.
2. `#tag.hide-code = true` cell: code hidden, output visible; textarea (edit affordance ✎) still shows the raw `#tag` lines.
3. Per-cell ▶ on the duckdb cell: runs clean (no `#`-SQL syntax error — the blanking works).
4. Colab-interop scenario (ad hoc): a document where NO `#%%` line carries a type, everything typed via preamble `#tag.type = python` + one `#tag.type = duckdb` cell — Kjør alle runs both correctly.
5. Warnings surface: add `#%% python slide=1` + `#tag.slide = 2` → the nb-bar warning strip shows the `overstyrt av #%%-attributt` warning with a line number.
6. Forklar (skrittvis) over the example: the sniffed md cell is narrated without delimiters/tags; code steps run.
7. `#@param` in a tagged cell (ad hoc: `#tag.slide = 1` above an `x = 3 #@param` line): form decorates and rewrites as before.
8. Share-link reload (copy share URL, open fresh): tags/sniffing identical after reload; html cell escaped until trusted (existing gate).
9. Plain-script regression (paramount invariant): a no-`#%%` python script containing a literal `#tag.type = r` line runs byte-identically to today (the line is an ordinary comment; mode unchanged).
10. Microdata mode: a `#%%`-notebook with a tagged microdata cell runs (tag lines never parsed as directives). Both themes (light/dark) spot-checked on the example.

- [ ] **Step 4: Full suites**

Run: `node --test tests/js/*.test.js` → only the 4 known ENOENT failures.
Run: `python -m pytest tests/ -q` → 1228 pass baseline (unchanged; nothing python-side was touched).

- [ ] **Step 5: Spec status + commit**

Add at the top of `docs/superpowers/specs/2026-07-16-tag-directives-design.md` under the title: `**Status:** DELIVERED <date> (plan 2026-07-16-tag-directives.md).`

```bash
git add examples/python/py_tag_direktiver.txt examples/manifest.json docs/superpowers/specs/2026-07-16-tag-directives-design.md .superpowers/sdd/task-tag-5-report.md
git commit -m "docs(eksempel): py_tag_direktiver — #tag-direktiver, sniffing og preambel-defaults; exit gate verifisert"
```
