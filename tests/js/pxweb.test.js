// tests/js/pxweb.test.js — PxWeb-hjelperne (js/pxweb.js): URL-bygging og
// json-stat2 → lang-format, ingen nett/duckdb-avhengighet.
// Spec: docs/superpowers/specs/2026-07-24-pxweb-sources-design.md §2.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const PX = require('../../js/pxweb.js');

test('dataUrl: /data + json-stat2 tvinges + lang=no default', () => {
  assert.equal(PX.dataUrl('https://data.ssb.no/api/pxwebapi/v2/tables/05839'),
    'https://data.ssb.no/api/pxwebapi/v2/tables/05839/data?lang=no&outputFormat=json-stat2');
});

test('dataUrl: brukerens query bevares, lang overstyrbar, outputFormat overstyres', () => {
  assert.equal(PX.dataUrl('https://x/tables/05839?valueCodes[Tid]=2020,2021&lang=en&outputFormat=csv'),
    'https://x/tables/05839/data?valueCodes[Tid]=2020,2021&lang=en&outputFormat=json-stat2');
});

test('dataUrl: outputFormatParams strippes ogsaa (UseTexts-fella, maalt SSB-400)', () => {
  const out = PX.dataUrl('https://x/tables/05839?outputFormat=csv&outputFormatParams=UseTexts');
  assert.ok(!out.includes('outputFormat=csv'));
  assert.ok(!out.includes('outputFormatParams'));
  assert.equal(out, 'https://x/tables/05839/data?lang=no&outputFormat=json-stat2');
});

test('metadataUrl: /metadata + lang=no default, query bevares', () => {
  assert.equal(PX.metadataUrl('https://x/tables/05839'), 'https://x/tables/05839/metadata?lang=no');
  assert.equal(PX.metadataUrl('https://x/tables/05839?lang=en'), 'https://x/tables/05839/metadata?lang=en');
});

// ── kind(eurostat) (2026-07-25): samme json-stat2-konvertering, egen URL-form
// (<base>/<kode>?format=JSON&lang=en&<dimensjon>=<verdi>-filtre) ────────────
test('eurostatDataUrl: format=JSON tvinges + lang=en default, filtre bevares', () => {
  assert.equal(PX.eurostatDataUrl('https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/nama_10_gdp'),
    'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/nama_10_gdp?lang=en&format=JSON');
  assert.equal(PX.eurostatDataUrl('https://x/data/tab?geo=NO&time=2023&lang=de&format=csv'),
    'https://x/data/tab?geo=NO&time=2023&lang=de&format=JSON');
});

test('dataUrlFor: ruter per kind', () => {
  assert.equal(PX.dataUrlFor('pxweb', 'https://x/tables/05839'),
    'https://x/tables/05839/data?lang=no&outputFormat=json-stat2');
  assert.equal(PX.dataUrlFor('eurostat', 'https://x/data/tab'),
    'https://x/data/tab?lang=en&format=JSON');
});

// 2×2×1-fixture: id/size i row-major-orden (json-stat2 §value). DELT med
// pytest (tests/test_openstat.py) — kontrakts-frøet fra pakke-diskusjonen:
// js/pxweb.js og openstat.py må gi samme svar på samme dokument.
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/pxweb_dataset.json'), 'utf8'));

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
require('../../js/directive-parser.js');   // data-directives kaller DirectiveParser ved parsing
require('../../js/data-directives.js');
(0, eval)(fs.readFileSync(path.join(__dirname, '../../js/data-loader.js'), 'utf8'));
const DD = globalThis.DataDirectives;
const DL = globalThis.DataLoader;

test('resolve: kind(pxweb) krever tabell-id og setter table', () => {
  const p = DD.parse([
    '# ssb = ost.connect("https://data.ssb.no/api/pxwebapi/v2/tables", kind="pxweb")',
    '# bef = ssb.read("05839?valueCodes[Tid]=2020")',
    '# feil = ssb.read()',
  ].join('\n'));
  const r = DD.resolve(p, []);
  const bef = r.find(x => x.alias === 'bef');
  assert.equal(bef.kind, 'pxweb');
  assert.equal(bef.table, '05839');
  assert.equal(bef.url, 'https://data.ssb.no/api/pxwebapi/v2/tables/05839?valueCodes[Tid]=2020');
  const feil = r.find(x => x.alias === 'feil');
  assert.match(feil.error, /ressurssti/);
});

// ── cache()-opsjonen (plan 2026-07-25-eksportgap-cache-openstatpy Task 1) ───
test('parseOptions/resolve: cache() følger med fra connect og load', () => {
  const p = DD.parse([
    '# k = ost.connect("https://x/data.csv", kind="csv", cache="1d")',
    '# a = k.read()',
    '# b = ost.read("https://y/f.parquet", cache="30m")',
    '# ssb = ost.connect("https://data.ssb.no/api/pxwebapi/v2/tables", kind="pxweb", cache="2h")',
    '# c = ssb.read("05839")',
  ].join('\n'));
  const r = DD.resolve(p, []);
  assert.equal(r.find(x => x.alias === 'a').cache, '1d');    // arves fra connect
  assert.equal(r.find(x => x.alias === 'b').cache, '30m');   // direkte på load
  assert.equal(r.find(x => x.alias === 'c').cache, '2h');    // pxweb-grenen
});

test('parseCacheTtl: enheter, bust-verdier og ugyldig', () => {
  assert.equal(DL._parseCacheTtl('90'), 90 * 1000);
  assert.equal(DL._parseCacheTtl('30m'), 30 * 60 * 1000);
  assert.equal(DL._parseCacheTtl('2h'), 2 * 3600 * 1000);
  assert.equal(DL._parseCacheTtl('1d'), 24 * 3600 * 1000);
  assert.equal(DL._parseCacheTtl('0'), 0);
  assert.equal(DL._parseCacheTtl('no'), 0);
  assert.equal(DL._parseCacheTtl('off'), 0);
  assert.equal(DL._parseCacheTtl('snart'), null);
  assert.equal(DL._parseCacheTtl(undefined), null);
});

test('resolve: kind(eurostat) krever tabell-id, som pxweb', () => {
  const p = DD.parse([
    '# eu = ost.connect("https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data", kind="eurostat")',
    '# bnp = eu.read("nama_10_gdp?geo=NO")',
    '# feil = eu.read()',
  ].join('\n'));
  const r = DD.resolve(p, []);
  const bnp = r.find(x => x.alias === 'bnp');
  assert.equal(bnp.kind, 'eurostat');
  assert.equal(bnp.table, 'nama_10_gdp');
  assert.match(r.find(x => x.alias === 'feil').error, /ressurssti/);
});

test('fetchResolvedItems: eurostat henter json-stat2 og leverer csv-bytes', async () => {
  DL._resetCacheForTests();
  let seenUrl = null;
  const fetchImpl = (input) => {
    seenUrl = String(input);
    return Promise.resolve(new Response(JSON.stringify(FIX), { status: 200, headers: { 'content-type': 'application/json' } }));
  };
  const out = await DL.fetchResolvedItems(
    [{ alias: 'bnp', url: 'https://x/data/nama_10_gdp?geo=NO', kind: 'eurostat', table: 'nama_10_gdp' }],
    { fetchImpl, registry: [] });
  assert.equal(seenUrl, 'https://x/data/nama_10_gdp?lang=en&geo=NO&format=JSON');
  assert.equal(out[0].format, 'csv');
  assert.match(new TextDecoder().decode(out[0].bytes), /^Kjonn,Tid,ContentsCode,value\n/);
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

// ── Typet kanonisk vei (plan 2026-07-27): typemeta-kontrakten er DELT med
// openstat.py (typemeta_from_jsonstat) via samme fixture — endres den ene
// siden, endres den andre. Pytest håndhever i tillegg at den injiserte
// python-kilden (pyApplyTypemetaSource) oppfører seg som openstat.py sin
// apply_typemeta (tests/test_openstat.py::test_js_apply_source_paritet).
test('typeMetaFromJsonStat: samme kontrakt som openstat.py', () => {
  const tm = PX.typeMetaFromJsonStat(FIX);
  assert.deepEqual(tm.time, ['Tid']);
  assert.deepEqual(tm.metric, ['ContentsCode']);
  assert.deepEqual(tm.dims.Kjonn.categories, ['1', '2']);
  assert.deepEqual(tm.dims.Kjonn.labels, { '1': 'Menn', '2': 'Kvinner' });
  assert.deepEqual(tm.units, { Personer: { base: 'personer', decimals: 0 } });
});

test('typeMetaFromJsonStat: degraderer pent uten role/label/unit', () => {
  const tm = PX.typeMetaFromJsonStat({ id: ['A'], size: [2],
    dimension: { A: { category: { index: { x: 0, y: 1 } } } }, value: [1, 2] });
  assert.deepEqual(tm.time, []);
  assert.deepEqual(tm.units, {});
  assert.deepEqual(tm.dims.A.categories, ['x', 'y']);
});

test('pyApplyTypemetaSource: definerer apply-funksjonen med dtype-vern', () => {
  const src = PX.pyApplyTypemetaSource();
  ['_ost_apply_typemeta', 'Categorical', 'to_numeric', 'ost_typemeta'].forEach(
    (tok) => assert.ok(src.includes(tok), tok));
});

test('recognizeUrl: delt fixture, paritet med openstat.py', () => {
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'recognize_urls.json'), 'utf8')).cases;
  for (const c of cases) {
    assert.deepStrictEqual(PX.recognizeUrl(c.url), c.expect, c.url);
  }
});

// ── Strengflaten for R/mini-konsum (plan 2026-07-28) ──────────────────────────
test('metaUrlFor: gjenkjent -> json-stat2-form med samme spørring, ukjent -> tom', () => {
  assert.equal(
    PX.metaUrlFor('https://data.ssb.no/api/pxwebapi/v2/tables/05839/data?valueCodes[Tid]=*&outputFormat=csv'),
    PX.dataUrlFor('pxweb', 'https://data.ssb.no/api/pxwebapi/v2/tables/05839?valueCodes[Tid]=*&outputFormat=csv'));
  assert.equal(PX.metaUrlFor('https://ourworldindata.org/grapher/co2.csv'), '');
  assert.equal(PX.metaUrlFor('ikke en url'), '');
});

test('typemetaTsvFromText: fixture -> linjer m/ klasse og koder i kildens orden', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'pxweb_dataset.json'), 'utf8');
  const tsv = PX.typemetaTsvFromText(text);
  const tm = PX.typeMetaFromJsonStat(JSON.parse(text));
  const lines = tsv.split('\n');
  assert.equal(lines.length, Object.keys(tm.dims).length);
  for (const line of lines) {
    const p = line.split('\x1f');
    const did = p[0];
    assert.ok(tm.dims[did], did);
    assert.equal(p[1], tm.time.indexOf(did) !== -1 ? 'time' : 'dim');
    assert.deepEqual(p.slice(2), tm.dims[did].categories.map(String));
  }
});

test('typemetaTsvFromText: heltallslignende dim-id-er beholder kildens orden (ds.id)', () => {
  const ds = { id: ['9', '2'], role: {}, dimension: {
    '9': { category: { index: { a: 0 }, label: {} } },
    '2': { category: { index: { b: 0 }, label: {} } } } };
  const lines = PX.typemetaTsvFromText(JSON.stringify(ds)).split('\n');
  assert.equal(lines[0].split('\x1f')[0], '9');
  assert.equal(lines[1].split('\x1f')[0], '2');
});

test('typemetaTsvFromText: søppel og separator-koder gir ERR, aldri kast', () => {
  assert.match(PX.typemetaTsvFromText('ikke json'), /^ERR:/);
  const evil_obj = { id: ['a'], role: {}, dimension: { a: { category: { index: {}, label: {} } } } };
  evil_obj.dimension.a.category.index['x\x1fy'] = 0;
  const evil = JSON.stringify(evil_obj);
  assert.match(PX.typemetaTsvFromText(evil), /^ERR:/);
});

// ── obligatoriske dimensjoner / 400-oversettelse (spec 2026-07-31-ssb-mandatory-variabler §3) ──
test('missingMandatory: finner mandatory-dimensjoner uten valg i URL-en', () => {
  const meta = {
    role: { time: ['Tid'] },
    dimension: {
      Region: { label: 'region', category: { index: { '0301': 0 }, label: { '0301': 'Oslo' } }, extension: { elimination: true } },
      ContentsCode: { label: 'statistikkvariabel', category: { index: { Folkemengde: 0 }, label: { Folkemengde: 'Personer' } }, extension: { elimination: false } },
      Tid: { label: 'år', category: { index: { 2024: 0 }, label: { 2024: '2024' } }, extension: { elimination: false } },
    },
  };
  const url = 'https://data.ssb.no/api/pxwebapi/v2/tables/11342?valueCodes[Region]=0301&valueCodes[Tid]=from(2015)';
  const missing = PX.missingMandatory(url, meta);
  assert.strictEqual(missing.length, 1);
  assert.strictEqual(missing[0].dim, 'ContentsCode');
  assert.deepStrictEqual(missing[0].codes, [{ code: 'Folkemengde', label: 'Personer' }]);
});

test('missingMandatory: elimination mangler → fallback ContentsCode+tid; alt valgt → tom', () => {
  const meta = {
    role: { time: ['Tid'] },
    dimension: {
      ContentsCode: { label: 'v', category: { index: { A: 0 }, label: { A: 'a' } } },
      Tid: { label: 'år', category: { index: { 2024: 0 }, label: {} } },
    },
  };
  assert.strictEqual(PX.missingMandatory('https://x/t?x=1', meta).length, 2);
  assert.strictEqual(PX.missingMandatory(
    'https://x/t?valueCodes[ContentsCode]=A&valueCodes[Tid]=top(5)', meta).length, 0);
});

test('mandatoryErrorMessage: nevner dim, read-syntaks og koder', () => {
  const msg = PX.mandatoryErrorMessage('11342', [
    { dim: 'ContentsCode', label: 'statistikkvariabel', codes: [{ code: 'Folkemengde', label: 'Personer' }] },
  ]);
  assert.match(msg, /11342/);
  assert.match(msg, /ContentsCode/);
  assert.match(msg, /indicators=/);
  assert.match(msg, /Folkemengde \(Personer\)/);
});
