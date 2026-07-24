// tests/js/pxweb.test.js — PxWeb-hjelperne (js/pxweb.js): URL-bygging og
// json-stat2 → lang-format, ingen nett/duckdb-avhengighet.
// Spec: docs/superpowers/specs/2026-07-24-pxweb-sources-design.md §2.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const PX = require('../../js/pxweb.js');

test('dataUrl: /data + json-stat2 tvinges + lang=no default', () => {
  assert.equal(PX.dataUrl('https://data.ssb.no/api/pxwebapi/v2/tables/05839'),
    'https://data.ssb.no/api/pxwebapi/v2/tables/05839/data?lang=no&outputFormat=json-stat2');
});

test('dataUrl: brukerens query bevares, lang overstyrbar, outputFormat overstyres', () => {
  assert.equal(PX.dataUrl('https://x/tables/05839?valueCodes[Tid]=2020,2021&lang=en&outputFormat=csv'),
    'https://x/tables/05839/data?valueCodes[Tid]=2020,2021&lang=en&outputFormat=json-stat2');
});

test('metadataUrl: /metadata + lang=no default, query bevares', () => {
  assert.equal(PX.metadataUrl('https://x/tables/05839'), 'https://x/tables/05839/metadata?lang=no');
  assert.equal(PX.metadataUrl('https://x/tables/05839?lang=en'), 'https://x/tables/05839/metadata?lang=en');
});

// 2×2×1-fixture: id/size i row-major-orden (json-stat2 §value).
const FIX = {
  version: '2.0', class: 'dataset',
  id: ['Kjonn', 'Tid', 'ContentsCode'],
  size: [2, 2, 1],
  dimension: {
    Kjonn: { category: { index: { '1': 0, '2': 1 } } },
    Tid: { category: { index: ['2020', '2021'] } },   // array-form er også lovlig
    ContentsCode: { category: { index: { Personer: 0 } } },
  },
  value: [10, 11, 20, 21],
};

test('columnsFromJsonStat: row-major-ekspansjon med koder + value', () => {
  const cols = PX.columnsFromJsonStat(FIX);
  assert.deepEqual(Object.keys(cols), ['Kjonn', 'Tid', 'ContentsCode', 'value']);
  assert.deepEqual(cols.Kjonn, ['1', '1', '2', '2']);
  assert.deepEqual(cols.Tid, ['2020', '2021', '2020', '2021']);
  assert.deepEqual(cols.ContentsCode, ['Personer', 'Personer', 'Personer', 'Personer']);
  assert.deepEqual(cols.value, [10, 11, 20, 21]);
});

test('columnsFromJsonStat: sparse value-objekt gir null i hullene', () => {
  const cols = PX.columnsFromJsonStat(Object.assign({}, FIX, { value: { '0': 10, '3': 21 } }));
  assert.deepEqual(cols.value, [10, null, null, 21]);
});

test('columnsToCsv: header + rader, null → tom celle, quoting ved behov', () => {
  const csv = PX.columnsToCsv({ a: ['x', 'y,z'], value: [1, null] });
  assert.equal(csv, 'a,value\nx,1\n"y,z",');
});

// ── resolve + lastelag for kind(pxweb) (samme eval-mønster som deno-testene:
// data-loader.js er et rent browser-script som setter globalThis) ───────────
require('../../js/data-directives.js');
const fs = require('node:fs');
const path = require('node:path');
(0, eval)(fs.readFileSync(path.join(__dirname, '../../js/data-loader.js'), 'utf8'));
const DD = globalThis.DataDirectives;
const DL = globalThis.DataLoader;

test('resolve: kind(pxweb) krever tabell-id og setter table', () => {
  const p = DD.parse([
    '# connect https://data.ssb.no/api/pxwebapi/v2/tables as ssb, kind(pxweb)',
    '# load ssb/05839?valueCodes[Tid]=2020 as bef',
    '# load ssb as feil',
  ].join('\n'));
  const r = DD.resolve(p, []);
  const bef = r.find(x => x.alias === 'bef');
  assert.equal(bef.kind, 'pxweb');
  assert.equal(bef.table, '05839');
  assert.equal(bef.url, 'https://data.ssb.no/api/pxwebapi/v2/tables/05839?valueCodes[Tid]=2020');
  const feil = r.find(x => x.alias === 'feil');
  assert.match(feil.error, /tabell-id/);
});

test('fetchResolvedItems: pxweb henter json-stat2 fra /data og leverer csv-bytes', async () => {
  DL._resetCacheForTests();
  let seenUrl = null;
  const fetchImpl = (input) => {
    seenUrl = String(input);
    const body = JSON.stringify(FIX);
    return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
  };
  const out = await DL.fetchResolvedItems(
    [{ alias: 'bef', url: 'https://x/tables/05839', kind: 'pxweb', table: '05839' }],
    { fetchImpl, registry: [] });
  assert.equal(seenUrl, 'https://x/tables/05839/data?lang=no&outputFormat=json-stat2');
  assert.equal(out[0].format, 'csv');
  assert.equal(out[0].table, '05839');
  const csv = new TextDecoder().decode(out[0].bytes);
  assert.match(csv, /^Kjonn,Tid,ContentsCode,value\n1,2020,Personer,10\n/);
});
