// tests/js/duckdb-views.test.js — view-registeret for format(duckdb)-monterte
// assembly-datasett (js/duckdb-views.js): ren tilstand + statement-bygging,
// ingen duckdb-avhengighet.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const DV = require('../../js/duckdb-views.js');

test('tomt register: isEmpty, ingen replay-statements', () => {
  DV.set(null);
  assert.equal(DV.isEmpty(), true);
  assert.deepEqual(DV.names(), []);
  assert.deepEqual(DV.registrationStatements(), []);
});

test('views uten attaches: én CREATE OR REPLACE VIEW per navn', () => {
  DV.set({ views: { demo: 'SELECT * FROM read_parquet(\'https://x/p.parquet\')' } });
  assert.equal(DV.isEmpty(), false);
  assert.deepEqual(DV.names(), ['demo']);
  const st = DV.registrationStatements();
  assert.equal(st.length, 1);
  assert.equal(st[0].sql, 'CREATE OR REPLACE VIEW "demo" AS SELECT * FROM read_parquet(\'https://x/p.parquet\')');
  assert.equal(st[0].ignoreError, false);
});

test('attaches replayes FØR views, med svelgbar DETACH per alias', () => {
  DV.set({
    views: { panel: 'SELECT * FROM att_0."patients"' },
    attaches: [{ alias: 'att_0', sql: "ATTACH 'https://x/f.duckdb' AS att_0" }],
  });
  const st = DV.registrationStatements();
  assert.deepEqual(st.map(s => [s.sql, s.ignoreError]), [
    ['DETACH "att_0"', true],
    ["ATTACH 'https://x/f.duckdb' AS att_0", false],
    ['CREATE OR REPLACE VIEW "panel" AS SELECT * FROM att_0."patients"', false],
  ]);
});

test('attaches uten views: replay er tom (ingenting å re-registrere)', () => {
  DV.set({ views: {}, attaches: [{ alias: 'att_0', sql: "ATTACH 'u' AS att_0" }] });
  assert.deepEqual(DV.registrationStatements(), []);
});

test('statementsFor emitterer attaches også uten views (monteringsveien)', () => {
  const st = DV.statementsFor({ views: {}, attaches: [{ alias: 'att_0', sql: "ATTACH 'u' AS att_0" }] });
  assert.deepEqual(st.map(s => s.sql), ['DETACH "att_0"', "ATTACH 'u' AS att_0"]);
});

test('set erstatter HELE registeret (ingen gjenferd fra forrige script)', () => {
  DV.set({ views: { gammel: 'SELECT 1' } });
  DV.set({ views: { ny: 'SELECT 2' } });
  assert.deepEqual(DV.names(), ['ny']);
});

test('view-navn quotes som identifikator (″ dobles)', () => {
  const st = DV.statementsFor({ views: { 'a"b': 'SELECT 1' } });
  assert.equal(st[0].sql, 'CREATE OR REPLACE VIEW "a""b" AS SELECT 1');
});
