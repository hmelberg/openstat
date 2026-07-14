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
