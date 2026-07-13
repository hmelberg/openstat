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
