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
