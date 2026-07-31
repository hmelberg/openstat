// tests/js/portable-export.test.js — transpile av monteringsdirektiver
// (opprettet med where/filter-runden 2026-07-29; fila var utestet før).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
require('../../js/directive-parser.js');
require('../../js/data-directives.js');
require('../../js/assembly-duckdb.js');
require('../../js/portable-export.js');
const PE = globalThis.PortableExport;

const SCRIPT = [
  '# bef = ost.connect("https://x/bef.parquet")',
  '# panel = ost.create(key="kommune")',
  '# panel.add(bef, ["folketall"], where="folketall > 5000")',
  '# panel.filter("folketall != 99999")',
  '',
  'panel',
].join('\n');

test('transpile python: where filtrerer kilden FØR kolonnesubset', () => {
  const out = PE.transpile(SCRIPT, 'python', []);
  assert.match(out.code,
    /panel = src_bef\[\(src_bef\["folketall"\] > 5000\)\]\[\["kommune", "folketall"\]\]/);
});

test('transpile python: filter-steg med != får .notna()-vern (NA-paritet)', () => {
  const out = PE.transpile(SCRIPT, 'python', []);
  assert.match(out.code,
    /panel = panel\[\(panel\["folketall"\] != 99999\) & panel\["folketall"\]\.notna\(\)\]/);
});

test('transpile r: where blir which()-radindeks i kildeuttrykket', () => {
  const out = PE.transpile(SCRIPT, 'r', []);
  assert.match(out.code,
    /panel <- src_bef\[which\(src_bef\[\["folketall"\]\] > 5000\), c\("kommune", "folketall"\)\]/);
});

test('transpile r: filter-steg blir which()-linje (NA droppes)', () => {
  const out = PE.transpile(SCRIPT, 'r', []);
  assert.match(out.code,
    /panel <- panel\[which\(panel\[\["folketall"\]\] != 99999\), \]/);
});

test('transpile: in-liste blir isin/%in%', () => {
  const s = [
    '# bef = ost.connect("https://x/bef.parquet")',
    '# panel = ost.create(key="kommune")',
    '# panel.add(bef, ["aar"], where="aar in [2020, 2021]")',   // direktiv-literaler: doble fnutter
  ].join('\n');
  assert.match(PE.transpile(s, 'python', []).code, /src_bef\["aar"\]\.isin\(\[2020, 2021\]\)/);
  assert.match(PE.transpile(s, 'r', []).code, /src_bef\[\["aar"\]\] %in% c\(2020, 2021\)/);
});

test('transpile: montering UTEN where/filter er uendret (regresjon)', () => {
  const s = [
    '# bef = ost.connect("https://x/bef.parquet")',
    '# panel = ost.create(key="kommune")',
    '# panel.add(bef, ["folketall"])',
  ].join('\n');
  assert.match(PE.transpile(s, 'python', []).code, /panel = src_bef\[\["kommune", "folketall"\]\]/);
  assert.match(PE.transpile(s, 'r', []).code, /panel <- src_bef\[, c\("kommune", "folketall"\)\]/);
});

test('transpile: flerbetingelses-and blir &-kjede i python og R', () => {
  const s = [
    '# bef = ost.connect("https://x/bef.parquet")',
    '# panel = ost.create(key="kommune")',
    '# panel.add(bef, ["folketall"], where="folketall > 100 and folketall < 900")',
  ].join('\n');
  assert.match(PE.transpile(s, 'python', []).code,
    /\(src_bef\["folketall"\] > 100\) & \(src_bef\["folketall"\] < 900\)/);
  assert.match(PE.transpile(s, 'r', []).code,
    /which\(src_bef\[\["folketall"\]\] > 100 & src_bef\[\["folketall"\]\] < 900\)/);
});

// Sluttreview-funn 1 (2026-07-31): federerte resolve-items har ingen .url —
// emitFor(item.federated) kastet TypeError («Cannot read properties of
// undefined (reading 'indexOf')») før vakten ble lagt til. Dekker inline-
// liste, register-id og federert connect brukt i montering (emitAssembly).
const FED_REG = [
  { id: 'demo-fed', navn: 'Demo', kind: 'federated', overlap: 'possible',
    members: [
      { id: 'nord', url: 'data/federert/nord.parquet' },
      { id: 'vest', url: 'data/federert/vest.parquet' },
    ] },
];

test('transpile: federert inline-liste kaster ikke — norsk advarsel, ingen undefined', () => {
  const s = '# person = ost.read(["a.parquet", "b.parquet"])';
  const out = PE.transpile(s, 'python', []);
  assert.match(out.code, /# federert kilde «person» støttes ikke i portabel eksport ennå — last ned medlemmene manuelt/);
  assert.ok(!/undefined/.test(out.code), out.code);
  assert.ok(out.warnings.some(w => /federert kilde/.test(w) && /person/.test(w)), JSON.stringify(out.warnings));
});

test('transpile: federert register-id kaster ikke — norsk advarsel, ingen undefined', () => {
  const s = '# person = ost.read("demo-fed")';
  const out = PE.transpile(s, 'python', FED_REG);
  assert.match(out.code, /# federert kilde «person» støttes ikke i portabel eksport ennå — last ned medlemmene manuelt/);
  assert.ok(!/undefined/.test(out.code), out.code);
  assert.ok(out.warnings.some(w => /federert kilde/.test(w)));
});

test('transpile: federert kilde brukt i montering (emitAssembly) kaster ikke', () => {
  const s = [
    '# fed = ost.connect("demo-fed")',
    '# panel = ost.create(key="kommune")',
    '# panel.add(fed, ["folketall"])',
  ].join('\n');
  const out = PE.transpile(s, 'python', FED_REG);
  assert.match(out.code, /# federert kilde «src_fed» støttes ikke i portabel eksport ennå — last ned medlemmene manuelt/);
  assert.match(out.code, /# \(datasettet «panel» kunne ikke eksporteres — se advarslene\)/);
  assert.ok(!/undefined/.test(out.code), out.code);
});
