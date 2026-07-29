// Tester for js/assembly-duckdb.js (portert fra safestat 2026-07-24, re-wiret
// i openstat): ren kompilator AssemblySpec -> SQL, uten duckdb-avhengighet.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
require('../../js/assembly-duckdb.js');
const AD = globalThis.AssemblyDuckdb;

const DESC = {
  p: { url: 'https://x/person.parquet', format: 'parquet', table: null },
  s: { url: 'https://x/salg.csv', format: 'csv', table: null },
  o: { url: 'https://x/annet.json', format: 'other', table: null },
};

test('canPushdown: parquet+csv ja, other nei', () => {
  assert.equal(AD.canPushdown({ sources: ['p', 's'] }, DESC), true);
  assert.equal(AD.canPushdown({ sources: ['p', 'o'] }, DESC), false);
});

test('compile: composite key gir USING/EXCLUDE med hele nøkkellisten', () => {
  const spec = { sources: ['p', 's'], datasets: [
    { name: 'd', key: ['kommune_nr', 'year'], steps: [
      { op: 'import', source: 'p', columns: ['skatt'], how: 'left' },
      { op: 'import', source: 's', columns: ['avfall'], how: 'left' },
    ] },
  ] };
  const sql = AD.compile(spec, DESC).datasetStatements[0].sql;
  assert.match(sql, /"kommune_nr", "year", "skatt"/);
  assert.match(sql, /USING \("kommune_nr", "year"\)/);
  assert.match(sql, /EXCLUDE \("kommune_nr", "year"\)/);
});

test('compile: join-steg med flerkolonne-on gir USING-liste', () => {
  const spec = { sources: ['p', 's'], datasets: [
    { name: 'a', load: 's' },
    { name: 'b', key: ['pid'], steps: [
      { op: 'import', source: 'p', columns: ['inntekt'], how: 'left' },
      { op: 'join', from: 'a', on: ['region', 'aar'], how: 'inner' },
    ] },
  ] };
  const sql = AD.compile(spec, DESC).datasetStatements.find(d => d.name === 'b').sql;
  assert.match(sql, /INNER JOIN .* USING \("region", "aar"\)/);
  assert.match(sql, /EXCLUDE \("region", "aar"\)/);
});

test('compile: import plukker kolonner + nøkkel fra read_parquet', () => {
  const spec = { sources: ['p'], datasets: [
    { name: 'demo', key: ['unit_id'], steps: [{ op: 'import', source: 'p', columns: ['inntekt', 'alder'], how: 'left' }] },
  ] };
  const out = AD.compile(spec, DESC);
  const sql = out.datasetStatements[0].sql;
  assert.match(sql, /read_parquet\('https:\/\/x\/person\.parquet'\)/);
  assert.match(sql, /"unit_id", "inntekt", "alder"/);
});

test('compile: to import-steg blir USING-join med EXCLUDE av nøkkelen', () => {
  const spec = { sources: ['p', 's'], datasets: [
    { name: 'demo', key: ['pid'], steps: [
      { op: 'import', source: 'p', columns: ['inntekt'], how: 'left' },
      { op: 'import', source: 's', columns: ['belop'], how: 'left' },
    ] },
  ] };
  const sql = AD.compile(spec, DESC).datasetStatements[0].sql;
  assert.match(sql, /LEFT JOIN/);
  assert.match(sql, /EXCLUDE \("pid"\)/);
  assert.match(sql, /read_csv\(/);
});

test('compile: join som første steg gir ærlig feil (review-funn, ikke FROM (null))', () => {
  const spec = { sources: ['p'], datasets: [
    { name: 'a', load: 'p' },
    { name: 'b', key: ['pid'], steps: [{ op: 'join', from: 'a', on: ['pid'], how: 'left' }] },
  ] };
  assert.throws(() => AD.compile(spec, DESC), /join krever minst én import først/);
});

test('compile: topo-sortering lar join referere senere deklarert datasett', () => {
  const spec = { sources: ['p', 's'], datasets: [
    { name: 'b', key: ['pid'], steps: [
      { op: 'import', source: 'p', columns: ['inntekt'], how: 'left' },
      { op: 'join', from: 'a', on: ['pid'], how: 'inner' },
    ] },
    { name: 'a', load: 's' },
  ] };
  const out = AD.compile(spec, DESC);
  assert.deepEqual(out.datasetStatements.map(d => d.name), ['a', 'b']);
  assert.match(out.datasetStatements[1].sql, /INNER JOIN/);
});

test('_topoSort: sirkulær avhengighet kaster', () => {
  const ds = [
    { name: 'a', key: ['k'], steps: [{ op: 'join', from: 'b', on: ['k'], how: 'left' }] },
    { name: 'b', key: ['k'], steps: [{ op: 'join', from: 'a', on: ['k'], how: 'left' }] },
  ];
  assert.throws(() => AD._topoSort(ds), /sirkulær/);
});

// ── format()-argumentet i create-dataset (parses i data-directives) ─────────
require('../../js/directive-parser.js');   // data-directives kaller DirectiveParser ved parsing
require('../../js/data-directives.js');
const DD = globalThis.DataDirectives;

test('parseAssembly: format(data.table) fanges, default null', () => {
  const r = DD.parseAssembly([
    '# p = ost.connect("https://x/p.parquet")',
    '# a = ost.create(key="pid", format="data.table")',
    '# a.add(p, ["inntekt"])',
    '# b = ost.create(key="pid")',
    '# b.add(p, ["alder"])',
  ].join('\n'));
  assert.equal(r.errors.length, 0);
  const byName = {};
  r.spec.datasets.forEach(d => { byName[d.name] = d; });
  assert.equal(byName.a.format, 'data.table');
  assert.equal(byName.b.format, null);
});

// ── composite keys (spec 2026-07-24-pxweb-sources-design §1) ────────────────
test('parseAssembly: key(region aar) og key(pid) blir arrays', () => {
  const r = DD.parseAssembly([
    '# a = ost.create(key=["region", "aar"])',
    '# b = ost.create(key="pid")',
    '# c = ost.create(key=["region", "aar"], format="pandas")',
  ].join('\n'));
  assert.equal(r.errors.length, 0);
  const byName = {};
  r.spec.datasets.forEach(d => { byName[d.name] = d; });
  assert.deepEqual(byName.a.key, ['region', 'aar']);
  assert.deepEqual(byName.b.key, ['pid']);
  assert.deepEqual(byName.c.key, ['region', 'aar']);
  assert.equal(byName.c.format, 'pandas');
});

test('parseAssembly: join on region, aar inner — komma-liste + how', () => {
  const r = DD.parseAssembly([
    '# a = ost.create(key="pid")',
    '# a.add(p, ["x"])',
    '# b = ost.create(key="pid")',
    '# b.add(p, ["y"])',
    '# b.join(a, on=["region", "aar"], how="inner")',
    '# b.join(a, on="k", how="left")',
  ].join('\n'));
  assert.equal(r.errors.length, 0);
  const b = r.spec.datasets.find(d => d.name === 'b');
  const joins = b.steps.filter(s => s.op === 'join');
  assert.deepEqual(joins[0].on, ['region', 'aar']);
  assert.equal(joins[0].how, 'inner');
  assert.deepEqual(joins[1].on, ['k']);
  assert.equal(joins[1].how, 'left');
});

// ── nye direktivord (2026-07-25): read/add/create kanoniske, gamle ord er
// stille aliaser (pakke-paritet: ost.connect/read/create/add) ──────────────
test('direktivord: read/add/create parser likt som load/import/create-dataset', () => {
  const nyP = DD.parse('# k = ost.connect("https://x/f.csv")\n# a = k.read()');
  assert.equal(nyP.loads.length, 1);
  assert.equal(nyP.loads[0].alias, 'a');
  const r = DD.parseAssembly([
    '# panel = ost.create(key=["region", "aar"])',
    '# panel.add(p, ["inntekt"])',
    '# gammel1 = ost.create(key="pid")',
    '# gammel2 = ost.create(key="pid", format="pandas")',
    '# gammel1.add(p, ["x"])',
  ].join('\n'));
  assert.equal(r.errors.length, 0);
  const byName = {};
  r.spec.datasets.forEach(d => { byName[d.name] = d; });
  assert.deepEqual(byName.panel.key, ['region', 'aar']);
  assert.equal(byName.panel.steps[0].op, 'import');   // add == import-steg
  assert.equal(byName.gammel1.steps.length, 1);
  assert.equal(byName.gammel2.format, 'pandas');
});

test('direktivord: LOADAS-kortformen virker med read', () => {
  const r = DD.parseAssembly('# p = ost.connect("f")\n# hele = p.read()');
  assert.ok(r.spec.datasets.find(d => d.name === 'hele' && d.load === 'p'));
});

test('compile: attaches er strukturerte {alias, sql} (én per unik fil-URL)', () => {
  const desc = {
    a: { url: 'https://x/f.duckdb', format: 'duckdb', table: 'pasienter' },
    b: { url: 'https://x/f.duckdb', format: 'duckdb', table: 'besok' },
    c: { url: 'https://x/g.sqlite', format: 'sqlite', table: 'takster' },
  };
  const spec = { sources: ['a', 'b', 'c'], datasets: [
    { name: 'p', load: 'a' }, { name: 'v', load: 'b' }, { name: 't', load: 'c' },
  ] };
  const out = AD.compile(spec, desc);
  assert.deepEqual(out.attaches, [
    { alias: 'att_0', sql: "ATTACH 'https://x/f.duckdb' AS att_0" },
    { alias: 'att_1', sql: "ATTACH 'https://x/g.sqlite' AS att_1 (TYPE sqlite)" },
  ]);
  assert.equal(out.attachStatements, undefined);
});

// ── where/filter (spec 2026-07-29-row-filter-montering §5) ──

test('compile: where på import gir WHERE inne i kildebrikken', () => {
  const spec = { sources: ['p'], datasets: [
    { name: 'd', key: ['pid'], steps: [
      { op: 'import', source: 'p', columns: ['inntekt'], how: 'left',
        where: [{ col: 'inntekt', op: '>', value: 5000 }, { col: 'fylke', op: '==', value: 'Oslo' }] },
    ] },
  ] };
  const sql = AD.compile(spec, DESC).datasetStatements[0].sql;
  assert.match(sql, /FROM read_parquet\('https:\/\/x\/person\.parquet'\) WHERE "inntekt" > 5000 AND "fylke" = 'Oslo'\)/);
});

test('compile: where-strenger escapes (O\'Brien) og != blir <>', () => {
  const spec = { sources: ['p'], datasets: [
    { name: 'd', key: ['pid'], steps: [
      { op: 'import', source: 'p', columns: ['navn'], how: 'left',
        where: [{ col: 'navn', op: '!=', value: "O'Brien" }] },
    ] },
  ] };
  const sql = AD.compile(spec, DESC).datasetStatements[0].sql;
  assert.match(sql, /WHERE "navn" <> 'O''Brien'/);
});

test('compile: in-liste blir IN (…)', () => {
  const spec = { sources: ['p'], datasets: [
    { name: 'd', key: ['pid'], steps: [
      { op: 'import', source: 'p', columns: ['aar'], how: 'left',
        where: [{ col: 'aar', op: 'in', value: [2020, 2021] }] },
    ] },
  ] };
  assert.match(AD.compile(spec, DESC).datasetStatements[0].sql, /WHERE "aar" IN \(2020, 2021\)/);
});

test('compile: filter-steg wrapper ytterst, etter join', () => {
  const spec = { sources: ['p', 's'], datasets: [
    { name: 'a', load: 's' },
    { name: 'b', key: ['pid'], steps: [
      { op: 'import', source: 'p', columns: ['inntekt'], how: 'left' },
      { op: 'join', from: 'a', on: ['pid'], how: 'inner' },
      { op: 'filter', where: [{ col: 'inntekt', op: '<', value: 400000 }] },
    ] },
  ] };
  const sql = AD.compile(spec, DESC).datasetStatements.find(d => d.name === 'b').sql;
  // filter-wrappen skal ligge UTENFOR join-uttrykket
  assert.match(sql, /^SELECT \* FROM \(SELECT \* FROM \(.*INNER JOIN.*\) WHERE "inntekt" < 400000\)$/);
});

test('compile: filter som første steg er ærlig feil', () => {
  const spec = { sources: ['p'], datasets: [
    { name: 'd', key: ['pid'], steps: [{ op: 'filter', where: [{ col: 'x', op: '>', value: 1 }] }] },
  ] };
  assert.throws(() => AD.compile(spec, DESC), /filter krever minst én import først i «d»/);
});

test('compile: where på import og filter i samme montering', () => {
  const spec = { sources: ['p'], datasets: [
    { name: 'd', key: ['pid'], steps: [
      { op: 'import', source: 'p', columns: ['inntekt'], how: 'left',
        where: [{ col: 'inntekt', op: '>', value: 0 }] },
      { op: 'filter', where: [{ col: 'inntekt', op: '<', value: 400000 }] },
    ] },
  ] };
  const sql = AD.compile(spec, DESC).datasetStatements[0].sql;
  assert.match(sql, /WHERE "inntekt" > 0\)/);          // inne i kildebrikken
  assert.match(sql, /\) WHERE "inntekt" < 400000\)$/); // ytterst
});
