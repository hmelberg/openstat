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

test('parseHeader: ulukket sitat → advarsel + degradert til mellomrom-splitt, ingen throw', () => {
  let h;
  assert.doesNotThrow(() => { h = C.parseHeader('#%% python speak="hei'); });
  assert.ok(h.warnings.some((w) => /ulukket "/.test(w)), 'advarsel om ulukket sitat mangler');
  // Degradert parsing: tokeniseringen faller til mellomrom-splitt, så typen
  // fanges fortsatt og attributtet får den rå (sitatledede) verdien.
  assert.strictEqual(h.type, 'python');
  assert.strictEqual(h.attrs.speak, '"hei');
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

test('segmentPlan: md først (ingen preambel) blankes helt — ingen leder-segment', () => {
  // executableSource blanker HELE md-cellen (header+body); parseHybridScripts
  // flush() dropper et segment som trimmer til tomt, så det finnes ingen
  // reell segment 0 å tilskrive — kun python-cellen kjører (verifisert Task 6).
  const doc = '#%% md\ntekst\n#%% python\n1';
  assert.deepStrictEqual(C.segmentPlan(doc, 'python'), [1]);
});

test('segmentPlan: dokument som starter rett på kodecelle', () => {
  const doc = '#%% python\n1\n#%% python\n2';
  assert.deepStrictEqual(C.segmentPlan(doc, 'python'), [0, 1]);
});

// ---- alignPlan (Task 9 bug (a)-fiks) ----

test('alignPlan: eksakt kind-match → planen returneres uendret', () => {
  const doc = '# pre\n#%% python\n1\n#%% r\n2';
  const p = C.parseCells(doc);
  const plan = C.segmentPlan(doc, 'python'); // [0, 1, 2]
  const aligned = C.alignPlan(plan, p.cells, 'python', ['pyodide', 'pyodide', 'r']);
  assert.deepStrictEqual(aligned, plan);
});

test('alignPlan: preambel strippet bort (kun #options.*-linjer) → planen justeres uten leder', () => {
  // Speiler bug (a): en preambel som KUN inneholder direktivlinjer blir blank
  // etter effectiveScript-strippingen i index.html (~8541) og gir dermed
  // ALDRI et faktisk kjøretidssegment, selv om segmentPlan (som jobber på rå
  // kildetekst) fortsatt teller den som et lederssegment.
  const doc = '#options.mode = microdata\n#%% microdata\nrequire no.ssb.fdb:51 as db\n#%% microdata\nsummarize inntekt';
  const p = C.parseCells(doc);
  const plan = C.segmentPlan(doc, 'python'); // [0, 1, 2] — preambel + to celler
  assert.deepStrictEqual(plan, [0, 1, 2]);
  // Faktiske kjøretidssegmenter: preambelen forsvant, kun de to cellene kjørte.
  const aligned = C.alignPlan(plan, p.cells, 'python', ['microdata', 'microdata']);
  assert.deepStrictEqual(aligned, [1, 2]);
});

test('alignPlan: reelt avvik (ingen 1:1-mapping mulig) → null', () => {
  const doc = '#%% python\n1\n#%% r\n2';
  const p = C.parseCells(doc);
  const plan = C.segmentPlan(doc, 'python'); // [0, 1]
  // Verken uendret plan eller preambel-fjernet variant matcher denne kind-
  // sekvensen (feil rekkefølge/antall) — f.eks. en manuelt skrevet '## r'
  // midt inni en celle som splitter kjøretiden i tre reelle segmenter.
  const aligned = C.alignPlan(plan, p.cells, 'python', ['pyodide', 'r', 'r']);
  assert.strictEqual(aligned, null);
});

test('alignPlan: preambel finnes ikke (planen starter ikke med en ekte preambel) → null ved avvik', () => {
  const doc = '#%% python\n1\n#%% r\n2';
  const p = C.parseCells(doc);
  const plan = C.segmentPlan(doc, 'python'); // [0, 1] — begge ekte celler, ingen preambel
  const aligned = C.alignPlan(plan, p.cells, 'python', ['r']); // feil lengde/kind, og plan[0] er ikke preambel
  assert.strictEqual(aligned, null);
});

// ---- paramLangForType (spec 2 W4, Task 2): celletype → #@param-språk ------

test('paramLangForType: python-familien (python/brython/micropython) → "python"', () => {
  assert.strictEqual(C.paramLangForType('python'), 'python');
  assert.strictEqual(C.paramLangForType('brython'), 'python');
  assert.strictEqual(C.paramLangForType('micropython'), 'python');
});

test('paramLangForType: r → "r"', () => {
  assert.strictEqual(C.paramLangForType('r'), 'r');
});

test('paramLangForType: duckdb/microdata/statx/md/html/skip/ukjent → null (parse-gate, #@param inert)', () => {
  ['duckdb', 'microdata', 'statx', 'md', 'html', 'skip', 'nonsense', undefined, null].forEach((type) => {
    assert.strictEqual(C.paramLangForType(type), null, 'type=' + type);
  });
});

// ---- forklarCellSteps / mdNarrationText (fase B2 Task 2: skrittvis celleavspilling) ----

test('forklarCellSteps: kode-celler blir "code"-steg, md blir "md"-steg, skip/html utelates', () => {
  const doc = '#%% md\nHallo\n#%% python\n1+1\n#%% skip\nx = 1\n#%% html\n<b>hei</b>\n#%% python\n2+2';
  const steps = C.forklarCellSteps(doc, 'python');
  assert.deepStrictEqual(steps.map(s => s.kind), ['md', 'code', 'code']);
  assert.strictEqual(steps[0].source, 'Hallo');
  assert.strictEqual(steps[1].source, '1+1');
  assert.strictEqual(steps[2].source, '2+2');
});

test('forklarCellSteps: ikke-kjørbar kodetype (uten SEG_MARKER, f.eks. brython) utelates helt — verken kjørt eller lest', () => {
  const doc = '#%% brython\nprint(1)\n#%% python\n1+1';
  const steps = C.forklarCellSteps(doc, 'python');
  assert.deepStrictEqual(steps.map(s => s.kind), ['code']);
  assert.strictEqual(steps[0].source, '1+1');
});

test('forklarCellSteps: ikke-blank preambel er ETT "code"-steg (speiler segmentPlan)', () => {
  const doc = '# load noe\n#%% python\n1+1';
  const steps = C.forklarCellSteps(doc, 'python');
  assert.deepStrictEqual(steps.map(s => s.kind), ['code', 'code']);
  assert.strictEqual(steps[0].source, '# load noe');
});

test('forklarCellSteps: blank/manglende preambel gir intet steg', () => {
  const doc = '#%% python\n1+1';
  const steps = C.forklarCellSteps(doc, 'python');
  assert.strictEqual(steps.length, 1);
  assert.strictEqual(steps[0].kind, 'code');
});

test('forklarCellSteps: tom md-celle er fortsatt ETT "md"-steg (tomhet håndteres av mdNarrationText/blokkbygger, ikke her)', () => {
  const doc = '#%% md\n#%% python\n1';
  const steps = C.forklarCellSteps(doc, 'python');
  assert.deepStrictEqual(steps.map(s => s.kind), ['md', 'code']);
  assert.strictEqual(steps[0].source, '');
});

test('mdNarrationText: overskrifter, emphasis, lenker, inline-kode og lister strippes rimelig', () => {
  const src = '# Tittel\n\nDette er **fet** og *kursiv* tekst med `kode` og en [lenke](https://x.no).\n\n- punkt en\n- punkt to';
  const out = C.mdNarrationText(src);
  assert.ok(out.indexOf('#') === -1, 'ingen # igjen: ' + out);
  assert.ok(out.indexOf('*') === -1, 'ingen * igjen: ' + out);
  assert.ok(out.indexOf('`') === -1, 'ingen ` igjen: ' + out);
  assert.ok(out.indexOf('](') === -1, 'ingen markdown-lenkesyntaks igjen: ' + out);
  assert.ok(out.indexOf('Tittel') !== -1);
  assert.ok(out.indexOf('fet') !== -1 && out.indexOf('kursiv') !== -1);
  assert.ok(out.indexOf('lenke') !== -1 && out.indexOf('https://x.no') === -1);
  assert.ok(out.indexOf('punkt en') !== -1 && out.indexOf('punkt to') !== -1);
});

test('mdNarrationText: kodeblokk-gjerder fjernes, innhold beholdes; blockquote/hr strippes', () => {
  const src = '```python\nprint(1)\n```\n\n> et sitat\n\n---';
  const out = C.mdNarrationText(src);
  assert.ok(out.indexOf('```') === -1);
  assert.ok(out.indexOf('print(1)') !== -1);
  assert.ok(out.indexOf('et sitat') !== -1);
  assert.ok(out.indexOf('---') === -1);
});

test('mdNarrationText: tom/ren-whitespace kilde → tom streng', () => {
  assert.strictEqual(C.mdNarrationText(''), '');
  assert.strictEqual(C.mdNarrationText('   \n  \n'), '');
  assert.strictEqual(C.mdNarrationText(null), '');
});

// ---- celle-verktøylinje: strukturelle teksttransformer (fase B2 Task 1) ----
// Alle operasjoner returnerer { cells, warnings } og bygger sin nye tekst via
// eksisterende cellBlock/serializeCells + en full re-parse — round-trip-
// garantien (serializeCells(parseCells(t)) === t, testet over) gjør derfor
// "resultatets serialisering er den tiltenkte teksten" automatisk oppfylt:
// vi tester her at den KONSTRUERTE teksten er den vi forventer.

function ser(cells) { return C.serializeCells(cells); }

// -- insertCellAfter --

test('insertCellAfter: setter inn ny celle med header+blank kropp etter idx', () => {
  const cells = C.parseCells('#%% python\n1').cells;
  const r = C.insertCellAfter(cells, 0, 'md');
  assert.deepStrictEqual(r.warnings, []);
  assert.strictEqual(ser(r.cells), '#%% python\n1\n#%% md\n');
  assert.strictEqual(r.cells.length, 2);
  assert.strictEqual(r.cells[1].type, 'md');
  assert.strictEqual(r.cells[1].source, '');
});

test('insertCellAfter: idx=-1 setter inn FØRST (add over første celle)', () => {
  const cells = C.parseCells('#%% python\n1').cells;
  const r = C.insertCellAfter(cells, -1, 'r');
  assert.strictEqual(ser(r.cells), '#%% r\n\n#%% python\n1');
  assert.strictEqual(r.cells[0].type, 'r');
});

test('insertCellAfter: idx=-1 med implisitt preambel → klemmes til ETTER preambelen (preambel-vern)', () => {
  // B2-review Critical-repro: uten vernet ville '#%% python'-headeren
  // splices FORAN preambel-teksten, og '# load x\nprint(1)' bli den nye
  // cellens KROPP — dokumentet mister preambelen sin permanent.
  const doc = '# load x\nprint(1)\n#%% python\ny=2\n';
  const cells = C.parseCells(doc).cells;
  const r = C.insertCellAfter(cells, -1, 'python');
  assert.strictEqual(r.cells[0].headerRaw, null, 'preambelen står fortsatt FØRST');
  assert.strictEqual(r.cells[0].source, '# load x\nprint(1)', 'preambel-innholdet er intakt');
  assert.strictEqual(r.cells[1].headerRaw, '#%% python', 'den nye cellen landet rett ETTER preambelen');
  assert.strictEqual(r.cells[1].source, '');
  assert.strictEqual(C.serializeCells(r.cells), '# load x\nprint(1)\n#%% python\n\n#%% python\ny=2\n');
});

test('insertCellAfter: idx=-1 UTEN preambel setter fortsatt inn helt først (vernet er preambel-spesifikt)', () => {
  const cells = C.parseCells('#%% r\n1\n').cells;
  const r = C.insertCellAfter(cells, -1, 'md');
  assert.strictEqual(r.cells[0].headerRaw, '#%% md');
});

test('insertCellAfter: ukjent type → advarsel + fallback python', () => {
  const cells = C.parseCells('#%% python\n1').cells;
  const r = C.insertCellAfter(cells, 0, 'sprocket');
  assert.ok(r.warnings.some(w => /ukjent celletype/.test(w)));
  assert.strictEqual(r.cells[1].type, 'python');
});

// -- deleteCell --

test('deleteCell: fjerner cellens span, resten uendret', () => {
  const cells = C.parseCells('#%% md\ntekst\n#%% python\n1+1').cells;
  const r = C.deleteCell(cells, 0);
  assert.strictEqual(ser(r.cells), '#%% python\n1+1');
});

test('deleteCell: siste gjenværende celle → tom implisitt celle (ikke no-op)', () => {
  const cells = C.parseCells('#%% python\nx=1').cells;
  const r = C.deleteCell(cells, 0);
  assert.strictEqual(r.cells.length, 1);
  assert.strictEqual(r.cells[0].headerRaw, null);
  assert.strictEqual(ser(r.cells), '');
});

test('deleteCell: ugyldig indeks → no-op + advarsel', () => {
  const cells = C.parseCells('#%% python\n1').cells;
  const r = C.deleteCell(cells, 5);
  assert.strictEqual(r.cells, cells);
  assert.ok(r.warnings.length > 0);
});

// -- moveCell --

test('moveCell: bytter to naboceller (dir=+1 og dir=-1 er symmetriske)', () => {
  const cells = C.parseCells('#%% python id=a\n1\n#%% r id=b\n2').cells;
  const down = C.moveCell(cells, 0, 1);
  assert.strictEqual(ser(down.cells), '#%% r id=b\n2\n#%% python id=a\n1');
  const up = C.moveCell(cells, 1, -1);
  assert.strictEqual(ser(up.cells), ser(down.cells));
});

test('moveCell: grense — første celle opp / siste celle ned er no-op', () => {
  const cells = C.parseCells('#%% python\n1\n#%% r\n2').cells;
  const up = C.moveCell(cells, 0, -1);
  assert.strictEqual(up.cells, cells);
  const down = C.moveCell(cells, 1, 1);
  assert.strictEqual(down.cells, cells);
});

test('moveCell: preambel kan aldri flyttes, og ingen celle kan bytte plass med den', () => {
  const cells = C.parseCells('# load x\n#%% python\n1').cells;
  const movePreamble = C.moveCell(cells, 0, 1);
  assert.strictEqual(ser(movePreamble.cells), ser(cells));
  assert.ok(movePreamble.warnings.length > 0);
  const swapIntoPreamble = C.moveCell(cells, 1, -1);
  assert.strictEqual(ser(swapIntoPreamble.cells), ser(cells));
  assert.ok(swapIntoPreamble.warnings.length > 0);
});

// -- changeCellType --

test('changeCellType: skriver om KUN typetoken, attrs bevares verbatim', () => {
  const cells = C.parseCells('#%% python id=x hide-code style=card\n1+1').cells;
  const r = C.changeCellType(cells, 0, 'r');
  assert.strictEqual(ser(r.cells), '#%% r id=x hide-code style=card\n1+1');
  assert.deepStrictEqual(r.cells[0].attrs, { id: 'x', 'hide-code': true, style: 'card' });
});

test('changeCellType: bar header uten type → setter inn type', () => {
  const cells = C.parseCells('#%%\n1+1').cells;
  const r = C.changeCellType(cells, 0, 'md');
  assert.strictEqual(ser(r.cells), '#%% md\n1+1');
});

test('changeCellType: header med kun attrs (ingen type) → type settes inn FØR attrs', () => {
  const cells = C.parseCells('#%% id=x\n1+1').cells;
  const r = C.changeCellType(cells, 0, 'r');
  assert.strictEqual(ser(r.cells), '#%% r id=x\n1+1');
});

test('changeCellType: preambel → no-op + advarsel', () => {
  const cells = C.parseCells('print(1)').cells;
  const r = C.changeCellType(cells, 0, 'md');
  assert.strictEqual(r.cells, cells);
  assert.ok(r.warnings.length > 0);
});

test('changeCellType: ukjent type → no-op + advarsel', () => {
  const cells = C.parseCells('#%% python\n1').cells;
  const r = C.changeCellType(cells, 0, 'sprocket');
  assert.strictEqual(r.cells, cells);
  assert.ok(r.warnings.length > 0);
});

test('changeCellType: alias normaliseres (py → python-header)', () => {
  const cells = C.parseCells('#%% r\n1').cells;
  const r = C.changeCellType(cells, 0, 'py');
  assert.strictEqual(ser(r.cells), '#%% python\n1');
});

// -- splitCell --

test('splitCell: deler kilden ved linjeoffset, ny celle arver samme (eksplisitte) type', () => {
  const cells = C.parseCells('#%% python\na\nb\nc').cells;
  const r = C.splitCell(cells, 0, 2);
  assert.strictEqual(ser(r.cells), '#%% python\na\nb\n#%% python\nc');
  assert.strictEqual(r.cells.length, 2);
});

test('splitCell: type null (arver docMode) → ny celle får bar #%%-header', () => {
  const cells = C.parseCells('#%%\na\nb').cells;
  const r = C.splitCell(cells, 0, 1);
  assert.strictEqual(ser(r.cells), '#%%\na\n#%%\nb');
  assert.strictEqual(r.cells[1].type, null);
});

test('splitCell: lineOffset 0 → no-op', () => {
  const cells = C.parseCells('#%% python\na\nb').cells;
  const r = C.splitCell(cells, 0, 0);
  assert.strictEqual(r.cells, cells);
});

test('splitCell: lineOffset forbi slutten (>= antall linjer) → no-op', () => {
  const cells = C.parseCells('#%% python\na\nb').cells;
  const r = C.splitCell(cells, 0, 2); // n=2 linjer, offset===n er "forbi slutten"
  assert.strictEqual(r.cells, cells);
  const r2 = C.splitCell(cells, 0, 99);
  assert.strictEqual(r2.cells, cells);
});

test('splitCell: siste linje-split er GYLDIG (ikke "forbi slutten")', () => {
  const cells = C.parseCells('#%% python\na\nb\nc').cells;
  const r = C.splitCell(cells, 0, 2); // n=3, offset=2 < n → gyldig, kun 'c' flyttes
  assert.strictEqual(ser(r.cells), '#%% python\na\nb\n#%% python\nc');
});

test('splitCell: celle uten kropp (n=0) → alltid no-op uansett offset', () => {
  const cells = C.parseCells('#%% python\n#%% r\n1').cells;
  const r = C.splitCell(cells, 0, 0);
  assert.strictEqual(r.cells, cells);
});

test('splitCell: preambelen kan splittes (blir stående som preambel, halen får ekte header)', () => {
  const cells = C.parseCells('a\nb\nc').cells;
  const r = C.splitCell(cells, 0, 1);
  assert.strictEqual(ser(r.cells), 'a\n#%%\nb\nc');
  assert.strictEqual(r.cells[0].headerRaw, null);
  assert.strictEqual(r.cells[1].headerRaw, '#%%');
});

// -- mergeWithPrevious --

test('mergeWithPrevious: sletter cellens headerlinje, kroppene smelter sammen', () => {
  const cells = C.parseCells('#%% python id=a\n1\n#%% r\n2').cells;
  const r = C.mergeWithPrevious(cells, 1);
  assert.strictEqual(ser(r.cells), '#%% python id=a\n1\n2');
  assert.strictEqual(r.cells.length, 1);
  assert.strictEqual(r.cells[0].attrs.id, 'a');
});

test('mergeWithPrevious: første celle (idx=0) → no-op + advarsel (ingen forrige)', () => {
  const cells = C.parseCells('#%% python\n1\n#%% r\n2').cells;
  const r = C.mergeWithPrevious(cells, 0);
  assert.strictEqual(r.cells, cells);
  assert.ok(r.warnings.length > 0);
});

test('mergeWithPrevious: inn i preambelen fungerer (headerRaw null + attrs bevares ikke — preamblen har ingen)', () => {
  const cells = C.parseCells('# load x\n#%% python\n1+1').cells;
  const r = C.mergeWithPrevious(cells, 1);
  assert.strictEqual(ser(r.cells), '# load x\n1+1');
  assert.strictEqual(r.cells.length, 1);
  assert.strictEqual(r.cells[0].headerRaw, null);
});

test('mergeWithPrevious: bar header (ingen kropp) foran → kun cur sin kropp består', () => {
  const cells = C.parseCells('#%% md\n#%% python\n1').cells;
  const r = C.mergeWithPrevious(cells, 1);
  assert.strictEqual(ser(r.cells), '#%% md\n1');
});

test('mergeWithPrevious: ugyldig indeks (>= length) → no-op + advarsel', () => {
  const cells = C.parseCells('#%% python\n1').cells;
  const r = C.mergeWithPrevious(cells, 9);
  assert.strictEqual(r.cells, cells);
  assert.ok(r.warnings.length > 0);
});
