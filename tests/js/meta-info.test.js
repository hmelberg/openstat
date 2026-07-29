// tests/js/meta-info.test.js — MetaInfo (js/meta-info.js): fletting av
// apiMeta + `# meta`-direktiver til MetaInfo-formen, HTML-renderer og
// kommentarlenke-konvensjonen.
// Spec: docs/superpowers/specs/2026-07-25-metadata-sidebar-design.md
// §1 (MetaInfo-formen), §2 (flettingsregelen), §7 (kommentarlenke).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
require('../../js/meta-info.js');
const MI = globalThis.MetaInfo;

function textDirective(target, variable, text) {
  return { target: target, variable: variable, kind: 'text', url: undefined, label: undefined, text: text, line: '' };
}
function linkDirective(target, variable, url, label) {
  return { target: target, variable: variable, kind: 'link', url: url, label: label, text: undefined, line: '' };
}

// (a) merge med kun direktiver (apiMeta null) gir beskrivelse+lenker.
test('merge: apiMeta null, kun direktiver -> beskrivelse + lenker fra direktivene', () => {
  const metas = [
    textDirective('lonn', null, 'Spørreundersøkelse om lønn, innsamlet 2024'),
    linkDirective('lonn', null, 'https://example.com/skjema.pdf', 'Spørreskjema')
  ];
  const mi = MI.merge(null, metas, 'lonn');
  assert.equal(mi.beskrivelse, 'Spørreundersøkelse om lønn, innsamlet 2024');
  assert.deepEqual(mi.lenker, [{ label: 'Spørreskjema', url: 'https://example.com/skjema.pdf' }]);
  assert.equal(mi.tittel, undefined);
  assert.deepEqual(mi.felter, []);
});

// (b) merge med begge: direktiv-lenker FØRST i lista, api-tittel beholdt,
// begge beskrivelser tilstede (brukerens plassert øverst, kildens under).
test('merge: apiMeta + direktiver -> direktiv-lenker først, api-tittel beholdt, begge beskrivelser med', () => {
  const apiMeta = {
    tittel: 'Lønn etter yrke',
    beskrivelse: 'Offisiell tabellbeskrivelse fra kilden.',
    felter: [{ label: 'Periode', verdi: '2008K1–2026K2' }],
    lenker: [{ label: 'Tabellside', url: 'https://ssb.no/tabell/05839' }],
    variabler: []
  };
  const metas = [
    linkDirective('ssb', null, 'https://example.com/skjema.pdf', 'Spørreskjema'),
    textDirective('ssb', null, 'Brukt i lønnsanalysen 2026.')
  ];
  const mi = MI.merge(apiMeta, metas, 'ssb');
  assert.equal(mi.tittel, 'Lønn etter yrke');
  assert.deepEqual(mi.lenker, [
    { label: 'Spørreskjema', url: 'https://example.com/skjema.pdf' },
    { label: 'Tabellside', url: 'https://ssb.no/tabell/05839' }
  ]);
  assert.equal(mi.direktivBeskrivelse, 'Brukt i lønnsanalysen 2026.');
  assert.equal(mi.autoBeskrivelse, 'Offisiell tabellbeskrivelse fra kilden.');
  assert.equal(mi.beskrivelse, 'Brukt i lønnsanalysen 2026.\n\nOffisiell tabellbeskrivelse fra kilden.');
  assert.deepEqual(mi.felter, apiMeta.felter);
});

// (c) forVariable finner kodeliste fra apiMeta og beskrivelse fra direktiv samtidig.
test('forVariable: kodeliste fra apiMeta + beskrivelse fra direktiv, samtidig', () => {
  const apiMeta = {
    variabler: [
      { navn: 'Region', label: 'Region', kodeliste: [{ kode: '03', label: 'Oslo' }, { kode: '11', label: 'Rogaland' }] }
    ]
  };
  const mi = MI.merge(apiMeta, [], 'ssb');
  const metas = [textDirective('ssb', 'Region', 'NB: fylkessammenslåing 2020 er ikke reversert i denne tabellen.')];
  const v = MI.forVariable(mi, metas, 'ssb', 'Region');
  assert.deepEqual(v.kodeliste, [{ kode: '03', label: 'Oslo' }, { kode: '11', label: 'Rogaland' }]);
  assert.equal(v.beskrivelse, 'NB: fylkessammenslåing 2020 er ikke reversert i denne tabellen.');
  assert.equal(v.label, 'Region');
});

// (d) render escaper <script> i direktivtekst (index.html setter innerHTML rått).
test('render: escaper HTML i direktivtekst (trygt for innerHTML)', () => {
  const metas = [textDirective('x', null, '<script>alert(1)</script>')];
  const mi = MI.merge(null, metas, 'x');
  const html = MI.render(mi, { labels: {} });
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>alert'));
});

// (e) commentUrl("ssb/05839.Region") gir korrekt enkodet URL (spec §7).
test('commentUrl: enkoder mål-strengen (kilde/tabell.variabel)', () => {
  assert.equal(
    MI.commentUrl('ssb/05839.Region'),
    'https://github.com/hmelberg/openstat-metadata/discussions?discussions_q=ssb%2F05839.Region'
  );
});

// (f) kodeliste-tabell cappes på 40 rader med en overflow-rad.
test('renderVariable: kodeliste cappes på 40 rader + én overflow-rad', () => {
  const kodeliste = [];
  for (let i = 0; i < 45; i++) kodeliste.push({ kode: String(i), label: 'Verdi ' + i });
  const v = { label: 'Kommune', kodeliste: kodeliste, lenker: [] };
  const html = MI.renderVariable(v, {});
  const rowCount = (html.match(/<tr/g) || []).length;
  assert.equal(rowCount, 41); // 40 data-rader + 1 overflow-rad
  assert.ok(html.includes('data-more="5"'));
  assert.ok(html.includes('+5'));
});

// Ekstra: kommentarlenke bygges fra opts.commentTarget + labels.comment —
// ingen hardkodet norsk tekst i modulen selv.
test('render: kommentarlenke bygges fra opts.commentTarget + labels.comment', () => {
  const mi = MI.merge(null, [], 'ssb');
  const html = MI.render(mi, { commentTarget: 'ssb/05839', labels: { comment: 'Kommenter' } });
  assert.ok(html.includes(MI.commentUrl('ssb/05839')));
  assert.ok(html.includes('>Kommenter<'));
});

// Ekstra: ingen lenkeliste (og dermed ingen kommentarlenke) uten lenker og
// uten commentTarget.
test('render: ingen lenkeliste når verken lenker eller commentTarget finnes', () => {
  const mi = MI.merge(null, [], 'ssb');
  const html = MI.render(mi, {});
  assert.ok(!html.includes('meta-info-links'));
});

// Ekstra: escaper anførselstegn i attributt-posisjon (href), ikke bare i
// tekst-noder — en direktiv-URL med et rått anførselstegn kunne ellers bryte
// ut av href-attributtet (spec: index.html setter innerHTML rått).
test('render: escaper anførselstegn i href (attributt-posisjon), ikke bare tekst', () => {
  const metas = [linkDirective('x', null, 'https://example.com/"><script>alert(1)</script>', '<script>alert(2)</script>')];
  const mi = MI.merge(null, metas, 'x');
  const html = MI.render(mi, { labels: {} });
  // href-attributtets verdi er fullt escapet: hverken anførselstegnet eller
  // <script> slipper gjennom rått.
  const hrefMatch = html.match(/href="([^"]*)"/);
  assert.ok(hrefMatch, 'forventet en href-attributt i outputen');
  assert.ok(hrefMatch[1].includes('&quot;'));
  assert.ok(hrefMatch[1].includes('&lt;script&gt;'));
  assert.ok(html.includes('&lt;script&gt;alert(2)&lt;/script&gt;')); // label (tekst-node)
  assert.ok(!html.includes('"><script>alert(1)</script>'));
  assert.ok(!html.includes('<script>alert(2)</script>'));
});

// Ekstra: variabel-antall vises som rent tall (ingen hardkodet norsk
// UI-tekst — i18n skjer i index.html per global constraint).
test('render: variabel-antall er et rent tall', () => {
  const apiMeta = { variabler: [{ navn: 'a' }, { navn: 'b' }, { navn: 'c' }] };
  const mi = MI.merge(apiMeta, [], 'ssb');
  const html = MI.render(mi, {});
  assert.ok(html.includes('data-count="3"'));
  assert.ok(html.includes('>3<'));
});

// Ekstra: direktiv-beskrivelse merkes med meta-info-user (§2: brukerens
// innhold skal kunne skilles visuelt fra kildens, øverst).
test('render: direktiv-beskrivelse ligger i meta-info-user, øverst (før kildens)', () => {
  const apiMeta = { beskrivelse: 'Kildens tekst.' };
  const metas = [textDirective('ssb', null, 'Brukerens tekst.')];
  const mi = MI.merge(apiMeta, metas, 'ssb');
  const html = MI.render(mi, {});
  const userIdx = html.indexOf('meta-info-user');
  const userTextIdx = html.indexOf('Brukerens tekst.');
  const apiTextIdx = html.indexOf('Kildens tekst.');
  assert.ok(userIdx >= 0 && userIdx < userTextIdx);
  assert.ok(userTextIdx < apiTextIdx);
});

test('merge: title og field fra direktiver når fram til MetaInfo', () => {
  const metas = [
    { target: 'bef', variable: null, kind: 'title', text: 'Folkemengde' },
    { target: 'bef', variable: null, kind: 'text', text: 'Etter alder' },
    { target: 'bef', variable: null, kind: 'field', field: 'publisher', text: 'SSB' },
    { target: 'bef', variable: null, kind: 'field', field: 'lisens', text: 'CC BY 4.0' },
  ];
  const mi = MI.merge(null, metas, 'bef');
  assert.equal(mi.tittel, 'Folkemengde');
  assert.equal(mi.beskrivelse, 'Etter alder');
  assert.deepEqual(mi.felter, [{ label: 'publisher', verdi: 'SSB' },
                               { label: 'lisens', verdi: 'CC BY 4.0' }]);
});

test('forVariable: label fra direktiv vinner over råt variabelnavn', () => {
  const metas = [{ target: 'bef', variable: 'alder', kind: 'label', text: 'Alder i hele år' }];
  const mi = MI.merge(null, metas, 'bef');
  const v = MI.forVariable(mi, metas, 'bef', 'alder');
  assert.equal(v.label, 'Alder i hele år');
});

// Kildens egen metadata skal fortsatt ikke overstyres stille (dagens regel).
test('merge: brukerens title overstyrer ikke kildens uten å vises som brukerinnhold', () => {
  const api = { tittel: 'SSB 05839' };
  const metas = [{ target: 'bef', variable: null, kind: 'title', text: 'Min tittel' }];
  const mi = MI.merge(api, metas, 'bef');
  assert.ok(mi.tittel);   // en av dem, men merket som brukerinnhold i renderingen
});

test('render: direktivtittel, felt og kildens tittel havner alle i HTML-en', () => {
  const metas = [
    { target: 'bef', variable: null, kind: 'title', text: 'Folkemengde' },
    { target: 'bef', variable: null, kind: 'field', field: 'publisher', text: 'SSB' },
    { target: 'bef', variable: null, kind: 'field', field: 'tom', text: '' },
  ];
  const html = MI.render(MI.merge({ tittel: 'SSB 05839', felter: [] }, metas, 'bef'), 'bef');
  assert.match(html, /Folkemengde/);      // brukerens tittel
  assert.match(html, /SSB 05839/);        // kildens tittel bevart
  assert.match(html, /publisher/);        // fritt felt vises
  assert.doesNotMatch(html, /<dt>tom<\/dt>/);   // tomt felt droppes
});

test('renderVariable: direktivetiketten havner i HTML-en', () => {
  const metas = [{ target: 'bef', variable: 'alder', kind: 'label', text: 'Alder i hele år' }];
  const v = MI.forVariable(MI.merge(null, metas, 'bef'), metas, 'bef', 'alder');
  assert.match(MI.renderVariable(v, 'bef.alder'), /Alder i hele år/);
});

test('render: brukerinnhold escapes', () => {
  const metas = [{ target: 'bef', variable: null, kind: 'title', text: '<script>alert(1)</script>' }];
  const html = MI.render(MI.merge(null, metas, 'bef'), 'bef');
  assert.doesNotMatch(html, /<script>/);
});

// sourcePageUrl(registerId, table): deterministisk menneskeside for register-
// kilder i proveniens-linjen — null når ingen sikker mal finnes (lenken skal
// heller mangle enn å gjette feil).
test('sourcePageUrl: ssb-tabell -> statbank-siden', () => {
  assert.equal(MI.sourcePageUrl('ssb', '07459'), 'https://www.ssb.no/statbank/table/07459');
});

test('sourcePageUrl: dst-tabell -> statistikbanken.dk', () => {
  assert.equal(MI.sourcePageUrl('dst', 'FOLK1A'), 'https://www.statistikbanken.dk/FOLK1A');
});

test('sourcePageUrl: eurostat-kode -> databrowser-siden', () => {
  assert.equal(MI.sourcePageUrl('eurostat', 'nama_10_gdp'),
    'https://ec.europa.eu/eurostat/databrowser/view/nama_10_gdp/default/table');
});

test('sourcePageUrl: worldbank-sti -> indikatorsiden (første ved flere)', () => {
  assert.equal(MI.sourcePageUrl('worldbank', 'country/NOR/indicator/SP.POP.TOTL'),
    'https://data.worldbank.org/indicator/SP.POP.TOTL');
  assert.equal(MI.sourcePageUrl('worldbank', 'country/all/indicator/SP.POP.TOTL;NY.GDP.MKTP.CD'),
    'https://data.worldbank.org/indicator/SP.POP.TOTL');
});

test('sourcePageUrl: dbnomics -> provider/datasett (versjon og seriemaske strippes)', () => {
  assert.equal(MI.sourcePageUrl('dbnomics', 'IMF/WEO:latest/NOR+SWE.NGDP_RPCH'),
    'https://db.nomics.world/IMF/WEO');
  assert.equal(MI.sourcePageUrl('dbnomics', 'AMECO/ZUTN'),
    'https://db.nomics.world/AMECO/ZUTN');
});

test('sourcePageUrl: kilder uten sikker mal -> null', () => {
  assert.equal(MI.sourcePageUrl('statfin', 'statfin_tyti_pxt_137h'), null);
  assert.equal(MI.sourcePageUrl('fhi', 'nokkel/tabell'), null);
  assert.equal(MI.sourcePageUrl('oecd', 'QNA'), null);
  assert.equal(MI.sourcePageUrl('scb', 'TAB1234'), null);
});

test('sourcePageUrl: tabellform som ikke passer malen -> null (aldri gjett)', () => {
  assert.equal(MI.sourcePageUrl('ssb', '07459/ekstra'), null);
  assert.equal(MI.sourcePageUrl('dst', 'FOLK1A/mer'), null);
  assert.equal(MI.sourcePageUrl('worldbank', 'country/NOR'), null);
  assert.equal(MI.sourcePageUrl('dbnomics', 'bareprovider'), null);
  assert.equal(MI.sourcePageUrl('', ''), null);
  assert.equal(MI.sourcePageUrl(null, null), null);
});
