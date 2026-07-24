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

test('compile: import plukker kolonner + nøkkel fra read_parquet', () => {
  const spec = { sources: ['p'], datasets: [
    { name: 'demo', key: 'unit_id', steps: [{ op: 'import', source: 'p', columns: ['inntekt', 'alder'], how: 'left' }] },
  ] };
  const out = AD.compile(spec, DESC);
  const sql = out.datasetStatements[0].sql;
  assert.match(sql, /read_parquet\('https:\/\/x\/person\.parquet'\)/);
  assert.match(sql, /"unit_id", "inntekt", "alder"/);
});

test('compile: to import-steg blir USING-join med EXCLUDE av nøkkelen', () => {
  const spec = { sources: ['p', 's'], datasets: [
    { name: 'demo', key: 'pid', steps: [
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
    { name: 'b', key: 'pid', steps: [{ op: 'join', from: 'a', on: 'pid', how: 'left' }] },
  ] };
  assert.throws(() => AD.compile(spec, DESC), /join krever minst én import først/);
});

test('compile: topo-sortering lar join referere senere deklarert datasett', () => {
  const spec = { sources: ['p', 's'], datasets: [
    { name: 'b', key: 'pid', steps: [
      { op: 'import', source: 'p', columns: ['inntekt'], how: 'left' },
      { op: 'join', from: 'a', on: 'pid', how: 'inner' },
    ] },
    { name: 'a', load: 's' },
  ] };
  const out = AD.compile(spec, DESC);
  assert.deepEqual(out.datasetStatements.map(d => d.name), ['a', 'b']);
  assert.match(out.datasetStatements[1].sql, /INNER JOIN/);
});

test('_topoSort: sirkulær avhengighet kaster', () => {
  const ds = [
    { name: 'a', key: 'k', steps: [{ op: 'join', from: 'b', on: 'k', how: 'left' }] },
    { name: 'b', key: 'k', steps: [{ op: 'join', from: 'a', on: 'k', how: 'left' }] },
  ];
  assert.throws(() => AD._topoSort(ds), /sirkulær/);
});

// ── format()-argumentet i create-dataset (parses i data-directives) ─────────
require('../../js/data-directives.js');
const DD = globalThis.DataDirectives;

test('parseAssembly: format(data.table) fanges, default null', () => {
  const r = DD.parseAssembly([
    '# connect https://x/p.parquet as p',
    '# create-dataset a, key(pid), format(data.table)',
    '# import p/inntekt into a',
    '# create-dataset b, key(pid)',
    '# import p/alder into b',
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
    '# create-dataset a, key(region aar)',
    '# create-dataset b, key(pid)',
    '# create-dataset c, key(region, aar), format(pandas)',
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
    '# create-dataset a, key(pid)',
    '# import p/x into a',
    '# create-dataset b, key(pid)',
    '# import p/y into b',
    '# join a into b on region, aar inner',
    '# join a into b on k left',
  ].join('\n'));
  assert.equal(r.errors.length, 0);
  const b = r.spec.datasets.find(d => d.name === 'b');
  const joins = b.steps.filter(s => s.op === 'join');
  assert.deepEqual(joins[0].on, ['region', 'aar']);
  assert.equal(joins[0].how, 'inner');
  assert.deepEqual(joins[1].on, ['k']);
  assert.equal(joins[1].how, 'left');
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
