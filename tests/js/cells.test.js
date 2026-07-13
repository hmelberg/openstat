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
