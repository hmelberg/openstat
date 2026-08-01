// tests/js/api-kinds.test.js — protokoll-adaptere (js/api-kinds.js): alias,
// URL-bygging og flatenere, ingen nett-avhengighet.
// Spec: docs/superpowers/specs/2026-07-25-api-kinds-design.md §1.
// Fixtures (worldbank_response.json, dbnomics_response.json) er trimmede
// EKTE API-svar (probet 2026-07-25) og deles med tests/test_openstat.py —
// samme tall begge steder ER paritetskontrakten.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const AK = require('../../js/api-kinds.js');

test('kindAlias: kildenavn → protokoll, protokollnavn → seg selv, ukjent → null', () => {
  assert.equal(AK.kindAlias('oecd'), 'sdmx');
  assert.equal(AK.kindAlias('ecb'), 'sdmx');
  assert.equal(AK.kindAlias('norgesbank'), 'sdmx');
  assert.equal(AK.kindAlias('imf'), 'sdmx');
  assert.equal(AK.kindAlias('worldbank'), 'worldbank');
  assert.equal(AK.kindAlias('dbnomics'), 'dbnomics');
  assert.equal(AK.kindAlias('sdmx'), 'sdmx');
  assert.equal(AK.kindAlias('OECD'), 'sdmx');
  assert.equal(AK.kindAlias('pxweb'), null);
  assert.equal(AK.kindAlias('csv'), null);
  assert.equal(AK.kindAlias(''), null);
});

test('sdmxNeedsFallback: 406 eller ikke-CSV → fallback (ECB-veien); ekte feil → ikke', () => {
  assert.equal(AK.sdmxNeedsFallback(406, 'application/problem+json'), true);
  assert.equal(AK.sdmxNeedsFallback(200, 'application/xml;charset=UTF-8'), true);
  assert.equal(AK.sdmxNeedsFallback(200, 'application/vnd.sdmx.data+csv; charset=utf-8'), false);
  assert.equal(AK.sdmxNeedsFallback(200, 'text/csv;charset=UTF-8'), false);
  assert.equal(AK.sdmxNeedsFallback(404, 'text/plain'), false);
  assert.equal(AK.sdmxNeedsFallback(422, 'text/plain'), false);
});

// ── worldbank (spec §1): [meta, [rader]], per_page-default 50 er en felle ──
const WB = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'worldbank_response.json'), 'utf8'));

test('worldbankDataUrl: format=json + per_page=20000 default, brukerens valg bevares', () => {
  assert.equal(AK.worldbankDataUrl('https://api.worldbank.org/v2/country/NOR/indicator/NY.GDP.MKTP.CD?date=2015:2024'),
    'https://api.worldbank.org/v2/country/NOR/indicator/NY.GDP.MKTP.CD?date=2015:2024&per_page=20000&format=json');
  assert.equal(AK.worldbankDataUrl('https://x/v2/country/NOR/indicator/A?per_page=99&format=xml'),
    'https://x/v2/country/NOR/indicator/A?per_page=99&format=json');
  assert.equal(AK.worldbankDataUrl('https://x/v2/country/NOR/indicator/A'),
    'https://x/v2/country/NOR/indicator/A?per_page=20000&format=json');
});

test('worldbankPageUrl: page-param legges til datalink-URL-en', () => {
  assert.equal(AK.worldbankPageUrl('https://x/v2/country/NOR/indicator/A?date=2015:2024', 3),
    'https://x/v2/country/NOR/indicator/A?date=2015:2024&per_page=20000&format=json&page=3');
});

test('worldbankMeta: pages/total fra meta; feilformen kaster med API-tekst', () => {
  assert.deepEqual(AK.worldbankMeta(WB.page1), { pages: 2, total: 7 });
  assert.throws(() => AK.worldbankMeta(WB.error), /Invalid value/);
  assert.throws(() => AK.worldbankMeta({}), /Uventet svar/);
});

test('worldbankColumns: flater sider til koder + value, null bevart', () => {
  const cols = AK.worldbankColumns([WB.page1, WB.page2]);
  assert.deepEqual(Object.keys(cols), ['indicator', 'country', 'countryiso3code', 'date', 'value']);
  assert.equal(cols.value.length, 7);
  assert.equal(cols.indicator[0], 'NY.GDP.MKTP.CD');
  assert.equal(cols.country[0], 'NO');
  assert.equal(cols.countryiso3code[0], 'NOR');
  assert.equal(cols.date[0], '2024');
  assert.equal(cols.value[0], 500886328034.123);
  assert.equal(cols.date[5], '2019');
  assert.equal(cols.value[6], null);
});

// ── dbnomics (spec §1): series.docs[] med period/value-arrayer ──────────────
const DBN = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'dbnomics_response.json'), 'utf8'));

test('dbnomicsDataUrl: observations=1 tvinges på', () => {
  assert.equal(AK.dbnomicsDataUrl('https://api.db.nomics.world/v22/series/IMF/WEO:latest/NOR.NGDP_RPCH'),
    'https://api.db.nomics.world/v22/series/IMF/WEO:latest/NOR.NGDP_RPCH?observations=1');
  assert.equal(AK.dbnomicsDataUrl('https://x/v22/series/A/B/C?observations=0&limit=5'),
    'https://x/v22/series/A/B/C?limit=5&observations=1');
});

test('dbnomicsColumns: én rad per (serie, periode); dimensjoner som kolonner; null bevart', () => {
  const cols = AK.dbnomicsColumns(DBN.ok);
  assert.deepEqual(Object.keys(cols), ['series_code', 'unit', 'weo-country', 'weo-subject', 'period', 'value']);
  assert.equal(cols.series_code.length, 6);
  assert.equal(cols.series_code[0], 'NOR.NGDP_RPCH.pcent_change');
  assert.equal(cols['weo-country'][0], 'NOR');
  assert.equal(cols['weo-country'][3], 'SWE');
  assert.equal(cols.period[0], '2024');
  assert.equal(cols.value[0], 2.058);
  assert.equal(cols.value[2], null);
});

test('dbnomicsColumns: num_found > docs → ærlig norsk feil', () => {
  assert.throws(() => AK.dbnomicsColumns(DBN.overflow), /1500 serier/);
});

// Feilmeldingen MÅ peke på en vei grammatikken faktisk har (2026-08-01):
// «snevre inn med dimensjonsfiltre i stien» ba om noe parseren avviser.
test('dbnomicsColumns: overflow-feilen peker på filters=, ikke på serie-masken i stien', () => {
  assert.throws(() => AK.dbnomicsColumns(DBN.overflow), /filters=/);
  assert.throws(() => AK.dbnomicsColumns(DBN.overflow), (e) => !/i stien/.test(e.message));
});

// ── sdmx CSV-header-introspeksjon (spec §3, fase 2): nøkkeldimensjonene er
// kolonnene mellom prefikset (DATAFLOW | STRUCTURE,STRUCTURE_ID,ACTION | KEY)
// og TIME_PERIOD — ekte headere fra probene 2026-07-25. ─────────────────────
const HDR = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'sdmx_headers.json'), 'utf8'));

test('sdmxKeyDims: alle tre prefiks-formene gir nøkkeldimensjonene i orden', () => {
  assert.equal(AK.sdmxKeyDims(HDR.oecd).length, 13);
  assert.equal(AK.sdmxKeyDims(HDR.oecd)[0], 'REF_AREA');
  assert.deepEqual(AK.sdmxKeyDims(HDR.nb), ['FREQ', 'BASE_CUR', 'QUOTE_CUR', 'TENOR']);
  assert.deepEqual(AK.sdmxKeyDims(HDR.ecb), ['FREQ', 'CURRENCY', 'CURRENCY_DENOM', 'EXR_TYPE', 'EXR_SUFFIX']);
  assert.deepEqual(AK.sdmxKeyDims('A,B,C'), []);   // ingen TIME_PERIOD → tomt
});

test('sdmxKeyPath: countries → REF_AREA-posisjon, flere verdier med +', () => {
  const dims = AK.sdmxKeyDims(HDR.oecd);
  const key = AK.sdmxKeyPath(dims, { countries: ['NOR', 'SWE'] });
  assert.equal(key, 'NOR+SWE' + '.'.repeat(12));
  assert.equal(key.split('.').length, 13);
});

test('sdmxKeyPath: filters → navngitt dimensjon; ukjent dimensjon → feil som lister gyldige', () => {
  const dims = AK.sdmxKeyDims(HDR.ecb);
  const key = AK.sdmxKeyPath(dims, { filters: { CURRENCY: 'USD', FREQ: 'D' } });
  assert.equal(key, 'D.USD...');
  assert.throws(() => AK.sdmxKeyPath(dims, { countries: ['NOR'] }), /ingen REF_AREA/);
  assert.throws(() => AK.sdmxKeyPath(dims, { filters: { TULL: 'X' } }), /FREQ, CURRENCY/);
});

test('sdmxFallbackUrl: format=csvdata legges på, eksisterende format strippes', () => {
  assert.equal(AK.sdmxFallbackUrl('https://x/data/EXR/D.USD?startPeriod=2026'),
    'https://x/data/EXR/D.USD?startPeriod=2026&format=csvdata');
  assert.equal(AK.sdmxFallbackUrl('https://x/data/EXR/all?format=csvfile'),
    'https://x/data/EXR/all?format=csvdata');
  assert.equal(AK.sdmxFallbackUrl('https://x/data/EXR/all'),
    'https://x/data/EXR/all?format=csvdata');
});
