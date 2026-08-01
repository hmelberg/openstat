// tests/js/data-directives-apikinds.test.js — resolve() for api-kinds
// (spec docs/superpowers/specs/2026-07-25-api-kinds-design.md §1-2):
// protokoll-kinds i kind-grenen, kind fra registeroppføring, kildenavn-alias.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
require('../../js/api-kinds.js');       // alias-tabellen (global.ApiKinds)
require('../../js/directive-parser.js');   // data-directives kaller DirectiveParser ved parsing
require('../../js/data-directives.js');
const DD = globalThis.DataDirectives;

function resolveOne(script, registry) {
  const r = DD.resolve(DD.parse(script), registry || []);
  assert.equal(r.length, 1);
  return r[0];
}

test('kind(oecd) med bar URL normaliseres til sdmx, sti + table settes', () => {
  const item = resolveOne(
    '# o = ost.connect("https://sdmx.oecd.org/public/rest/data", kind="oecd")\n' +
    '# le = o.read("OECD.ELS.HD,DSD_HEALTH_STAT@DF_LE/all?startPeriod=2020")');
  assert.equal(item.kind, 'sdmx');
  assert.equal(item.url, 'https://sdmx.oecd.org/public/rest/data/OECD.ELS.HD,DSD_HEALTH_STAT@DF_LE/all?startPeriod=2020');
  assert.equal(item.table, 'OECD.ELS.HD,DSD_HEALTH_STAT@DF_LE/all');
  assert.equal(item.alias, 'le');
});

test('kind fra registeroppføring: connect worldbank uten kind()', () => {
  const registry = [{ id: 'worldbank', base_url: 'https://api.worldbank.org/v2/', kind: 'worldbank' }];
  const item = resolveOne(
    '# worldbank = ost.connect("worldbank")\n' +
    '# bnp = worldbank.read("country/NOR/indicator/NY.GDP.MKTP.CD?date=2015:2024")', registry);
  assert.equal(item.kind, 'worldbank');
  assert.equal(item.url, 'https://api.worldbank.org/v2/country/NOR/indicator/NY.GDP.MKTP.CD?date=2015:2024');
  assert.equal(item.table, 'country/NOR/indicator/NY.GDP.MKTP.CD');
});

test('registerets kildenavn-kind normaliseres også (kind: "oecd" i registeret)', () => {
  const registry = [{ id: 'oecd', base_url: 'https://sdmx.oecd.org/public/rest/data/', kind: 'oecd' }];
  const item = resolveOne('# oecd = ost.connect("oecd")\n# x = oecd.read("EXR/all")', registry);
  assert.equal(item.kind, 'sdmx');
});

test('read uten ressurssti → norsk feil med eksempel', () => {
  const item = resolveOne(
    '# dbn = ost.connect("https://api.db.nomics.world/v22/series", kind="dbnomics")\n' +
    '# x = dbn.read()');
  assert.ok(item.error);
  assert.ok(/ressurssti/.test(item.error));
  assert.ok(/WEO/.test(item.error));   // dbnomics-eksemplet
});

test('kind(sdmx) direkte virker likt som kildenavnet', () => {
  const item = resolveOne(
    '# ecb = ost.connect("https://data-api.ecb.europa.eu/service/data", kind="sdmx")\n' +
    '# kurs = ecb.read("EXR/D.USD.EUR.SP00.A?startPeriod=2026-01-01")');
  assert.equal(item.kind, 'sdmx');
  assert.equal(item.url, 'https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?startPeriod=2026-01-01');
});

// ── kanonisk vokabular (spec §3, fase 2): years/countries/regions/
// indicators/filters oversettes per kind — mekanisk verifiserbart eller
// hard feil (SDMX-fellen: aldri stille passthrough). ────────────────────────

test('worldbank kanonisk: indicators+countries bygger stien, years → date', () => {
  const item = resolveOne(
    '# wb = ost.connect("https://api.worldbank.org/v2", kind="worldbank")\n' +
    '# bnp = wb.read(indicators=["NY.GDP.MKTP.CD"], countries=["NOR", "SWE"], years="2015:2024")');
  assert.ok(!item.error, item.error);
  assert.equal(item.url, 'https://api.worldbank.org/v2/country/NOR;SWE/indicator/NY.GDP.MKTP.CD?date=2015:2024');
});

test('worldbank kanonisk: åpne years-ender → 2100/1900-grensene (probet ok)', () => {
  const item = resolveOne(
    '# wb = ost.connect("https://api.worldbank.org/v2", kind="worldbank")\n' +
    '# bnp = wb.read(indicators=["A"], years="2020:")');
  assert.ok(/date=2020:2100/.test(item.url), item.url);
});

test('worldbank kanonisk: både sti og indicators → feil (velg én form)', () => {
  const item = resolveOne(
    '# wb = ost.connect("https://api.worldbank.org/v2", kind="worldbank")\n' +
    '# x = wb.read("country/NOR/indicator/A", indicators=["B"])');
  assert.ok(/én form/.test(item.error), item.error);
});

test('eurostat kanonisk: countries → geo, years → since/until, filters → params', () => {
  const item = resolveOne(
    '# eu = ost.connect("https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data", kind="eurostat")\n' +
    '# bnp = eu.read("nama_10_gdp", countries=["NO", "SE"], years="2020:2024", filters={"na_item": "B1GQ", "unit": "CP_MEUR"})');
  assert.ok(!item.error, item.error);
  assert.ok(/geo=NO&geo=SE/.test(item.url), item.url);
  assert.ok(/sinceTimePeriod=2020/.test(item.url));
  assert.ok(/untilTimePeriod=2024/.test(item.url));
  assert.ok(/na_item=B1GQ/.test(item.url) && /unit=CP_MEUR/.test(item.url));
});

test('eurostat kanonisk: indicators → hard feil med filters-hint', () => {
  const item = resolveOne(
    '# eu = ost.connect("https://x", kind="eurostat")\n' +
    '# bnp = eu.read("nama_10_gdp", indicators=["B1GQ"])');
  assert.ok(/filters\(/.test(item.error), item.error);
});

test('pxweb kanonisk: years lukket → eksplisitt liste, åpen start → from(); regions/indicators → valueCodes', () => {
  const lukket = resolveOne(
    '# ssb = ost.connect("https://data.ssb.no/api/pxwebapi/v2/tables", kind="pxweb")\n' +
    '# bef = ssb.read("05839", years="2007:2009", regions=["0", "30"], indicators=["Personer"])');
  assert.ok(!lukket.error, lukket.error);
  assert.ok(/valueCodes\[Tid\]=2007,2008,2009/.test(lukket.url), lukket.url);
  assert.ok(/valueCodes\[Region\]=0,30/.test(lukket.url));
  assert.ok(/valueCodes\[ContentsCode\]=Personer/.test(lukket.url));
  const aapen = resolveOne(
    '# ssb = ost.connect("https://x/tables", kind="pxweb")\n# bef = ssb.read("05839", years="2007:")');
  assert.ok(/valueCodes\[Tid\]=from\(2007\)/.test(aapen.url), aapen.url);
  const bakover = resolveOne(
    '# ssb = ost.connect("https://x/tables", kind="pxweb")\n# bef = ssb.read("05839", years=":2009")');
  assert.ok(/startår/.test(bakover.error), bakover.error);
  const land = resolveOne(
    '# ssb = ost.connect("https://x/tables", kind="pxweb")\n# bef = ssb.read("05839", countries=["NOR"])');
  assert.ok(land.error, 'countries skal feile for pxweb');
});

test('sdmx kanonisk: years → startPeriod/endPeriod; countries/filters → needsSdmxKey', () => {
  const bare = resolveOne(
    '# o = ost.connect("https://sdmx.oecd.org/public/rest/data", kind="oecd")\n' +
    '# le = o.read("OECD.ELS.HD,DSD_HEALTH_STAT@DF_LE", years="2020:2023")');
  assert.ok(!bare.error, bare.error);
  assert.ok(/startPeriod=2020/.test(bare.url) && /endPeriod=2023/.test(bare.url), bare.url);
  assert.ok(!bare.needsSdmxKey);
  const medLand = resolveOne(
    '# o = ost.connect("https://sdmx.oecd.org/public/rest/data", kind="oecd")\n' +
    '# le = o.read("OECD.ELS.HD,DSD_HEALTH_STAT@DF_LE", countries=["NOR", "SWE"], years="2020:")');
  assert.ok(!medLand.error, medLand.error);
  assert.deepEqual(medLand.needsSdmxKey.countries, ['NOR', 'SWE']);
  assert.ok(/startPeriod=2020/.test(medLand.url));
});

test('dbnomics kanonisk: years → klient-filter; countries → hard feil som peker på filters=', () => {
  const aar = resolveOne(
    '# dbn = ost.connect("https://api.db.nomics.world/v22/series", kind="dbnomics")\n' +
    '# vekst = dbn.read("IMF/WEO:latest/NOR.NGDP_RPCH", years="2020:2026")');
  assert.ok(!aar.error, aar.error);
  assert.deepEqual(aar.clientYears, { from: '2020', to: '2026' });
  // Endret 2026-08-01: feilen pekte før på serie-masken «i stien» — en vei
  // grammatikken ikke tar. Nå peker den på filters=, som FINNES (dimensions=).
  const land = resolveOne(
    '# dbn = ost.connect("https://api.db.nomics.world/v22/series", kind="dbnomics")\n' +
    '# vekst = dbn.read("IMF/WEO:latest/NOR.NGDP_RPCH", countries=["NOR"])');
  assert.match(land.error, /filters=/);
  assert.ok(!/i stien/.test(land.error), land.error);
});

test('pxweb/eurostat-grenen er uendret', () => {
  const item = resolveOne(
    '# ssb = ost.connect("https://data.ssb.no/api/pxwebapi/v2/tables", kind="pxweb")\n' +
    '# bef = ssb.read("05839")');
  assert.equal(item.kind, 'pxweb');
  assert.equal(item.table, '05839');
});

// ── pxweb v2 tables/-fiks (spec-oppdrag 2026-07-31, task 5): base_url for
// ssb/scb i registeret har ALDRI inneholdt /tables-segmentet (git-historikk
// sjekket 2026-07-31) — kanonisk registerlesevei (`ssb = ost.connect("ssb")`
// uten eksplisitt kind()) har derfor aldri fungert for ssb.read("11342") i
// dette repoet: URL-en ble base+id, som er 404 (live-verifisert; med tables/
// 200). Fikset i resolve() for kind==='pxweb' ALENE: prepend tables/ til
// restPath, men kun når base ikke allerede ender på /tables (direkte
// connect() til en URL som selv inneholder /tables, som i testene over —
// den eldre formen som FAKTISK har fungert — skal forbli uendret, ellers
// ville de fått tables/tables/). ─────────────────────────────────────────

test('pxweb v2: ssb.read via registeret setter inn tables/-segmentet (regresjon v2-beta→v2)', () => {
  const registry = [{ id: 'ssb', base_url: 'https://data.ssb.no/api/pxwebapi/v2/', kind: 'pxweb' }];
  const item = resolveOne(
    '# ssb = ost.connect("ssb")\n# bef = ssb.read("11342")', registry);
  assert.ok(!item.error, item.error);
  assert.equal(item.url, 'https://data.ssb.no/api/pxwebapi/v2/tables/11342');
  assert.equal(item.table, '11342');   // bare id — feilmeldingsvennlig (mandatoryErrorMessage)
});

test('pxweb v2: read("tables/11342") normaliseres — ingen tables/tables/', () => {
  const registry = [{ id: 'ssb', base_url: 'https://data.ssb.no/api/pxwebapi/v2/', kind: 'pxweb' }];
  const item = resolveOne(
    '# ssb = ost.connect("ssb")\n# bef = ssb.read("tables/11342")', registry);
  assert.ok(!item.error, item.error);
  assert.equal(item.url, 'https://data.ssb.no/api/pxwebapi/v2/tables/11342');
  assert.equal(item.table, '11342');
});

test('pxweb v2: connect-URL som allerede ender på /tables dobles ikke opp', () => {
  const item = resolveOne(
    '# ssb = ost.connect("https://data.ssb.no/api/pxwebapi/v2/tables", kind="pxweb")\n' +
    '# bef = ssb.read("05839")');
  assert.equal(item.url, 'https://data.ssb.no/api/pxwebapi/v2/tables/05839');
  assert.equal(item.table, '05839');
});

test('eurostat-grenen får ikke tables/-segmentet (kun pxweb rammes av fiksen)', () => {
  const registry = [{ id: 'eu', base_url: 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/', kind: 'eurostat' }];
  const item = resolveOne(
    '# eu = ost.connect("eu")\n# bnp = eu.read("nama_10_gdp")', registry);
  assert.ok(!item.error, item.error);
  assert.equal(item.url, 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/nama_10_gdp');
  assert.equal(item.table, 'nama_10_gdp');
});

// ── all()-direktiv (spec 2026-07-25/26-all-direktiv-design): last alle
// verdier av uspesifiserte dimensjoner for pxweb. Ren parser+resolve her —
// selve async-utvidelsen skjer i lasteren (Task 3). ──────────────────────

test('pxweb all(): setter all-flagget, bevarer eksplisitte valueCodes', () => {
  const bare = resolveOne(
    '# ssb = ost.connect("https://data.ssb.no/api/pxwebapi/v2/tables", kind="pxweb")\n' +
    '# bef = ssb.read("05839", all=True)');
  assert.ok(!bare.error, bare.error);
  assert.equal(bare.all, true);
  const kombi = resolveOne(
    '# ssb = ost.connect("https://data.ssb.no/api/pxwebapi/v2/tables", kind="pxweb")\n' +
    '# bef = ssb.read("05839", all=True, years="2000:2009", indicators=["Personer"])');
  assert.equal(kombi.all, true);
  assert.ok(/valueCodes\[Tid\]=2000,2001/.test(kombi.url), kombi.url);       // years bevart
  assert.ok(/valueCodes\[ContentsCode\]=Personer/.test(kombi.url));          // indicators bevart
});

test('all() på ikke-pxweb-kilde → feil', () => {
  const r = resolveOne(
    '# o = ost.connect("https://sdmx.oecd.org/public/rest/data", kind="oecd")\n' +
    '# le = o.read("OECD.ELS.HD,DSD_HEALTH_STAT@DF_LE/all", all=True)');
  assert.ok(r.error && /all\(\).*pxweb/i.test(r.error), r.error);
});

// ── kind-avledning fra tilgang (spec-oppdrag 2026-07-31, ssb-mandatory task
// 5): ssb/scb-oppføringene i data-sources.json har ALDRI hatt et «kind»-felt
// (kun tilgang: "pxweb") — git-historikken viser ingen tidligere versjon med
// kind satt. Uten kind falt resolve() rett forbi pxweb-grenen — kanonisk
// years=/indicators=/regions=-oversettelse OG tables/-sti-fiksen kjørte
// ALDRI — og ssb.read("11342") ble base+id, som er 404 (live-verifisert).
// data-sources.json har nå kind: "pxweb" eksplisitt på begge (samme som alle
// andre kilder), men normalizeKind() avleder også fra tilgang==="pxweb" som
// sikkerhetsnett mot at feltet mangler igjen — KUN pxweb, ikke andre
// tilgang-verdier (de skal fortsatt gi kind===undefined og feile synlig et
// annet sted, ikke late som de er pxweb). ─────────────────────────────────

test('normalizeKind avleder pxweb fra tilgang når kind mangler i registeret (sikkerhetsnett)', () => {
  const registry = [{ id: 'ssb', tilgang: 'pxweb', base_url: 'https://data.ssb.no/api/pxwebapi/v2/' }];
  const item = resolveOne(
    '# ssb = ost.connect("ssb")\n' +
    '# bef = ssb.read("11342", years="2007:2009", indicators=["Personer"], regions=["0", "30"])', registry);
  assert.ok(!item.error, item.error);
  assert.equal(item.kind, 'pxweb');
  assert.ok(/tables\/11342/.test(item.url), item.url);
  assert.ok(/valueCodes\[Tid\]=2007,2008,2009/.test(item.url), item.url);
  assert.ok(/valueCodes\[Region\]=0,30/.test(item.url), item.url);
  assert.ok(/valueCodes\[ContentsCode\]=Personer/.test(item.url), item.url);
});

test('normalizeKind avleder IKKE pxweb fra andre tilgang-verdier (tilgang: "rest" uten kind → kind===undefined)', () => {
  const registry = [{ id: 'x', tilgang: 'rest', base_url: 'https://example.org/api/' }];
  const item = resolveOne('# x = ost.connect("x")\n# y = x.read("foo")', registry);
  assert.equal(item.kind, undefined);
});

test('registerkonsistens: enhver tilgang==="pxweb"-oppføring i data/data-sources.json har kind==="pxweb" (vokter neste migrering)', () => {
  const raw = fs.readFileSync(path.join(__dirname, '../../data/data-sources.json'), 'utf8');
  const sources = JSON.parse(raw);
  const utenKind = sources.filter((s) => s.tilgang === 'pxweb' && s.kind !== 'pxweb').map((s) => s.id);
  assert.deepEqual(utenKind, [], 'pxweb-oppføringer uten kind: "pxweb": ' + utenKind.join(', '));
});
