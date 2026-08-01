// tests/js/directive-semantics.test.js — parse() på ny grammatikk
// (spec 2026-07-26-pythonsk-direktivsyntaks-design §4.1).
const test = require('node:test');
const assert = require('node:assert');
require('../../js/directive-parser.js');
require('../../js/data-directives.js');
const DD = globalThis.DataDirectives;

test('parse: connect + read med kind og kanonisk vokabular', () => {
  const p = DD.parse([
    '# ssb = ost.connect("https://data.ssb.no/api/pxwebapi/v2/tables", kind="pxweb")',
    '# bef = ssb.read("05839", years="2000:2009", indicators="Personer")',
  ].join('\n'));
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.connects, [{
    target: 'https://data.ssb.no/api/pxwebapi/v2/tables',
    alias: 'ssb', options: { kind: 'pxweb' },
  }]);
  assert.equal(p.loads.length, 1);
  assert.equal(p.loads[0].target, 'ssb/05839');
  assert.equal(p.loads[0].alias, 'bef');
  assert.equal(p.loads[0].verb, 'read');
  assert.deepEqual(p.loads[0].options.canonical,
    { years: { from: '2000', to: '2009' }, indicators: ['Personer'] });
});

test('parse: bar URL uten connect', () => {
  const p = DD.parse('# co2 = ost.read("https://ourworldindata.org/grapher/co2.csv")');
  assert.equal(p.loads[0].target, 'https://ourworldindata.org/grapher/co2.csv');
  assert.deepEqual(p.connects, []);
});

test('parse: read() uten argument gir hele rammen', () => {
  const p = DD.parse([
    '# h = ost.connect("helse2025", secret_key="ask")',
    '# df = h.read()',
  ].join('\n'));
  assert.equal(p.connects[0].options.key, 'ask');
  assert.equal(p.loads[0].target, 'h');
});

test('parse: years med åpen ende, countries som liste, all og filters', () => {
  const p = DD.parse([
    '# eu = ost.connect("https://x/", kind="eurostat")',
    '# b = eu.read("nama_10_gdp", years="2020:", countries=["NO","SE"], all=True,',
    '#              filters={"na_item": "B1GQ"})',
  ].join('\n'));
  // flerlinjede kall støttes IKKE — linje 3 skal gi feil, ikke stille dropp
  assert.ok(p.errors.length >= 1);
});

test('parse: enlinjet variant av samme', () => {
  const p = DD.parse([
    '# eu = ost.connect("https://x/", kind="eurostat")',
    '# b = eu.read("nama_10_gdp", years="2020:", countries=["NO","SE"], all=True, filters={"na_item":"B1GQ"})',
  ].join('\n'));
  assert.deepEqual(p.errors, []);
  const c = p.loads[0].options.canonical;
  assert.deepEqual(c.years, { from: '2020', to: null });
  assert.deepEqual(c.countries, ['NO', 'SE']);
  assert.equal(c.all, true);
  assert.deepEqual(c.filters, { na_item: 'B1GQ' });
});

test('parse: ukjent kwarg gir did-you-mean', () => {
  const p = DD.parse('# b = ost.read("https://x/d.csv", yers="2020")');
  assert.match(p.errors[0], /linje 1.*ukjent argument «yers».*years/);
});

test('parse: gammel syntaks gir feil, ikke stille dropp', () => {
  const p = DD.parse('# read ssb/05839 as bef');
  assert.equal(p.loads.length, 0);
  assert.match(p.errors[0], /gammel syntaks/);
});

test('scrubKeys: maskerer secret_key, beholder "ask"', () => {
  assert.equal(DD.scrubKeys('# d = ost.read("u", secret_key="hemmelig")'),
                            '# d = ost.read("u", secret_key="***")');
  assert.equal(DD.scrubKeys('# d = ost.read("u", secret_key="ask")'),
                            '# d = ost.read("u", secret_key="ask")');
  assert.equal(DD.scrubKeys("# d = ost.read('u', secret_key='ask')"),
                            "# d = ost.read('u', secret_key='ask')");
});

// Hver av disse slapp gjennom en tidligere versjon av maskeringen.
test('scrubKeys: ingen hemmelighet overlever, uansett form', () => {
  [
    '# d = ost.read("u", secret_key="it\'s-a-secret")',
    '# d = ost.read("u", secret_key=\'pass"word\')',
    '# h = ost.connect("x", secret_key="sk_live_A\\\\")',   // hale-backslash
    '# h = ost.connect("x", secret_key="sk_live_B',           // glemt sluttfnutt
    '# s = ost.connect("x", secret_key="oops, x=1, secret_key="s3cr3t")',
    '# d = ost.read("u", secret_key=sk_live_C)',              // usitert
    '# d = ost.read("u", secret_key=["sk_live_D"])',          // liste
    '-- d = ost.read("u", secret_key="hemmelig")',
    '// d = ost.read("u", secret_key="hemmelig")',
  ].forEach((line) => {
    assert.doesNotMatch(DD.scrubKeys(line).replace(/secret_key/g, ''),
                        /hemmelig|s3cr3t|sk_live|pass"word/, line);
  });
});

// Omdøpingens hele poeng: `key` betyr nå KUN kolonnenavn, så maskeringen kan
// ikke lenger røre vanlig kode. Tidligere versjoner gjorde
// «sorted(rows, key=lambda r: r[0])» om til «sorted(rows, key="***"» og
// maskerte ost.create(key="pid") — som github-storage så lagret ødelagt.
test('scrubKeys: kode, prosa og create(key=) er urørt', () => {
  ['sorted(rows, key=lambda r: r[0])', 'max(items, key=lambda i: i.value)',
   "df.sort_values('col', key=abs)", 'key = c(1,2)', 'PRIMARY KEY = id',
   'api_key="ikke-vaar"', '#%% python key=1', '# the key = value mapping',
   '# panel = ost.create(key="pid")',
   '# d = ost.create(key=["kommune_nr", "year"])',
  ].forEach((line) => assert.equal(DD.scrubKeys(line), line, line));
});

test('scrubKeys: idempotent', () => {
  const once = DD.scrubKeys('# d = ost.read("u", secret_key="hemmelig")');
  assert.equal(DD.scrubKeys(once), once);
});

test('meta: note, title og ukjent nøkkel som felt', () => {
  const p = DD.parse([
    '#meta.bef.title = "Folkemengde"',
    '#meta.bef.note = "Etter alder og kjønn 2000-2009"',
    '#meta.bef.publisher = "SSB"',
    '#meta.bef.metode = "Registerdata"',
  ].join('\n'));
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.metas.map((m) => m.kind), ['title', 'text', 'field', 'field']);
  assert.equal(p.metas[2].field, 'publisher');
  assert.equal(p.metas[3].field, 'metode');
});

test('meta: lenke som streng, tuppel og liste', () => {
  const p = DD.parse([
    '#meta.a.link = "https://x/1"',
    '#meta.b.link = ["https://x/2a", "https://x/2b"]',
    '#meta.c.link = {"https://x/3": "Tre", "https://x/4": "Fire"}',
  ].join('\n'));
  assert.deepEqual(p.errors, []);
  const links = p.metas.filter((m) => m.kind === 'link');
  assert.equal(links.length, 5);
  assert.equal(links[0].url, 'https://x/1');
  assert.equal(links[0].label, undefined);
  assert.equal(links[1].url, 'https://x/2a');
  assert.equal(links[1].label, undefined);
  assert.equal(links[3].label, 'Tre');
  assert.equal(links[4].url, 'https://x/4');
});

test('meta: variabelnivå og bulk labels', () => {
  const p = DD.parse([
    '#meta.bef.alder.label = "Alder i hele år"',
    '#meta.bef.labels = {"kjonn": "Kjønn", "region": "Region"}',
  ].join('\n'));
  assert.deepEqual(p.errors, []);
  const labs = p.metas.filter((m) => m.kind === 'label');
  assert.deepEqual(labs.map((m) => [m.variable, m.text]),
    [['alder', 'Alder i hele år'], ['kjonn', 'Kjønn'], ['region', 'Region']]);
});

test('meta: kjent datasettnøkkel med ekstra ledd gir feil', () => {
  const p = DD.parse('#meta.bef.note.x = "y"');
  assert.match(p.errors[0], /linje 1.*«note» tar en verdi, ikke en sti/);
});

test('parseAssembly: create + add + join', () => {
  const a = DD.parseAssembly([
    '# p = ost.connect("people")',
    '# s = ost.connect("sales_src")',
    '# panel = ost.create(key="pid")',
    '# panel.add(p, ["income", "edu"])',
    '# panel.add(p, "region")',
    '# sales = s.read()',
    '# panel.join(sales, on="pid")',
  ].join('\n'));
  assert.deepEqual(a.errors, []);
  const panel = a.spec.datasets.find((d) => d.name === 'panel');
  assert.deepEqual(panel.key, ['pid']);
  assert.deepEqual(panel.steps, [
    { op: 'import', source: 'p', columns: ['income', 'edu'], how: 'left' },
    { op: 'import', source: 'p', columns: ['region'], how: 'left' },
    { op: 'join', from: 'sales', on: ['pid'], how: 'left' },
  ]);
  assert.ok(a.spec.sources.indexOf('p') >= 0);
});

// De gamle regex-passene kjørte alle add FØR alle join. To konsumenter er
// avhengige av det: assembly-duckdb kaster, portable-export dropper stille.
test('parseAssembly: add kommer alltid før join, uansett skriptrekkefølge', () => {
  const a = DD.parseAssembly([
    '# p = ost.connect("people")',
    '# s = ost.connect("sales")',
    '# panel = ost.create(key="pid")',
    '# panel.add(p, ["income"])',
    '# sales = s.read()',
    '# panel.join(sales, on="pid")',
    '# panel.add(p, ["edu"])',
  ].join('\n'));
  assert.deepEqual(a.errors, []);
  const steps = a.spec.datasets.find((d) => d.name === 'panel').steps;
  assert.deepEqual(steps.map((x) => x.op), ['import', 'import', 'join']);
  assert.deepEqual(steps.filter((x) => x.op === 'import').map((x) => x.columns[0]),
                   ['income', 'edu']);   // innbyrdes rekkefølge bevart
});

test('parseAssembly: sammensatt nøkkel, format og eksplisitt how', () => {
  const a = DD.parseAssembly([
    '# db = ost.connect("https://x/panel.duckdb", kind="duckdb")',
    '# d = ost.create(key=["kommune_nr", "year"], format="duckdb")',
    '# d.add(db, ["age"], table="patients", how="inner")',
  ].join('\n'));
  assert.deepEqual(a.errors, []);
  const d = a.spec.datasets.find((x) => x.name === 'd');
  assert.deepEqual(d.key, ['kommune_nr', 'year']);
  assert.equal(d.format, 'duckdb');
  assert.deepEqual(d.steps, [{ op: 'import', source: 'db__patients', columns: ['age'], how: 'inner' }]);
  assert.deepEqual(a.spec.sourceTables.db__patients, { source: 'db', table: 'patients' });
});

test('parseAssembly: datasett kan hete __proto__ eller constructor', () => {
  assert.deepEqual(DD.parseAssembly('# __proto__ = ost.create(key="k")').errors, []);
  assert.deepEqual(DD.parseAssembly('# constructor = ost.create(key="k")').errors, []);
  const a = DD.parseAssembly(['# d = ost.create(key="k")',
                              '# d.add(__proto__, ["x"])'].join('\n'));
  assert.ok(a.spec.sources.indexOf('__proto__') >= 0,
            'hver step.source må finnes i spec.sources');
});

test('parseAssembly: tilordning på add/join gir feil, ikke stille dropp', () => {
  const a = DD.parseAssembly(['# d = ost.create(key="k")',
                              '# x = d.add(p, ["a"])'].join('\n'));
  assert.match(a.errors[0], /returnerer ingenting/);
});

test('parseAssembly: add til ukjent datasett gir feil', () => {
  const a = DD.parseAssembly('# ukjent.add(p, "x")');
  assert.match(a.errors[0], /ukjent datasett «ukjent»/);
});

test('parseAssembly: duplikat create gir feil', () => {
  const a = DD.parseAssembly([
    '# d = ost.create(key="k")',
    '# d = ost.create(key="k")',
  ].join('\n'));
  assert.match(a.errors[0], /allerede opprettet/);
});

test('metaByTarget: felter, tittel og variabler', () => {
  const out = DD.metaByTarget([
    '#meta.bef.title = "Folkemengde"',
    '#meta.bef.note = "Notat"',
    '#meta.bef.publisher = "SSB"',
    '#meta.bef.link = {"https://ssb.no": "Om SSB"}',
    '#meta.bef.alder.label = "Alder"',
  ].join('\n'));
  assert.equal(out.bef.title, 'Folkemengde');
  assert.deepEqual(out.bef.text, ['Notat']);
  assert.deepEqual(out.bef.fields, [{ label: 'publisher', verdi: 'SSB' }]);
  assert.deepEqual(out.bef.links, [{ url: 'https://ssb.no', label: 'Om SSB' }]);
  assert.equal(out.bef.variables.alder.label, 'Alder');
});

// Notatlister (Task 8-forberedelse): gammel syntaks AKKUMULERTE gjentatte
// «# meta iris …»-linjer, ny modell lar dropPrevious fjerne den forrige. Uten
// listeformen ville migreringen mistet alle notater unntatt det siste — se
// examples/brython/bry35_meta_lenker_advarsel.txt, som har to for «iris».
test('meta: note tar en liste — flere notater på samme mål', () => {
  const r = DD.parse('# meta.iris.note = ["Fishers irisdata (1936)", "Målt i cm"]');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.metas.map((m) => [m.kind, m.variable, m.text]), [
    ['text', null, 'Fishers irisdata (1936)'],
    ['text', null, 'Målt i cm'],
  ]);
});

test('meta: note-liste virker også på variabelnivå', () => {
  const r = DD.parse('# meta.iris.sepal_length.note = ["A", "B"]');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.metas.map((m) => [m.kind, m.variable, m.text]), [
    ['text', 'sepal_length', 'A'], ['text', 'sepal_length', 'B'],
  ]);
});

test('meta: note som streng er uendret', () => {
  const r = DD.parse('# meta.iris.note = "A"');
  assert.deepEqual(r.metas.map((m) => [m.kind, m.text]), [['text', 'A']]);
});

test('meta: gjentatt note overskriver fortsatt (spec §3.3)', () => {
  const r = DD.parse('# meta.iris.note = "A"\n# meta.iris.note = "B"');
  assert.deepEqual(r.metas.map((m) => m.text), ['B']);
});

// String(v) på en liste ga «A,B» og på en dict «[object Object]» — søppel i
// sidepanelet uten et ord til brukeren.
test('meta: ikke-tekst i enkeltverdifelt gir feil, ikke søppel', () => {
  [['# meta.iris.title = ["A","B"]', /«title» må være en tekst/],
   ['# meta.iris.kilde = {"a": "b"}', /«kilde» må være en tekst/],
   ['# meta.iris.note = [1, 2]', /«note» må være en tekst eller en liste/],
   ['# meta.iris.sepal_length.label = ["A"]', /«label» må være en tekst/],
   ['# meta.iris.labels = {"k": ["A"]}', /«labels.k» må være en tekst/],
  ].forEach(([line, re]) => {
    const r = DD.parse(line);
    assert.deepEqual(r.metas, [], line);
    assert.match(r.errors[0], re, line);
  });
});

// parse() skopet seg til connect/read i Task 8 (den ropte ellers «ukjent
// argument «key»» på en gyldig ost.create og knakk portabel eksport). Da
// mistet create/add/join den TILFELDIGE kwarg-dekningen de hadde — uten
// vakten under er «add(py, ["a"], hwo="inner")» stille: steget bygges med
// how="left" og brukeren tror han ba om inner.
test('parseAssembly: ukjent argument på create/add/join gir feil', () => {
  const pre = ['# py = ost.connect("https://x/py.parquet")',
               '# demo = ost.create(key="unit_id")',
               '# sales = py.read("salg")', ''].join('\n');
  [['# demo.add(py, ["alder"], hwo="inner")', /ukjent argument «hwo» for add/],
   ['# demo.add(py, ["alder"], tabel="t")', /ukjent argument «tabel» for add/],
   ['# demo.join(sales, onn="pid")', /ukjent argument «onn» for join/],
   ['# d2 = ost.create(key="pid", secret_key="lekk")', /ukjent argument «secret_key» for create/],
  ].forEach(([line, re]) => {
    const r = DD.parseAssembly(pre + line);
    assert.match(r.errors[0] || '', re, line);
  });
});

test('parseAssembly: how er et lukket sett', () => {
  const pre = ['# py = ost.connect("https://x/py.parquet")',
               '# demo = ost.create(key="unit_id")', ''].join('\n');
  const bad = DD.parseAssembly(pre + '# demo.add(py, ["a"], how="innner")');
  assert.match(bad.errors[0], /how må være left, inner eller outer/);
  assert.deepEqual(bad.spec.datasets.find((d) => d.name === 'demo').steps, []);

  ['left', 'inner', 'outer', 'INNER'].forEach((h) => {
    const ok = DD.parseAssembly(pre + '# demo.add(py, ["a"], how="' + h + '")');
    assert.deepEqual(ok.errors, [], h);
    assert.equal(ok.spec.datasets.find((d) => d.name === 'demo').steps[0].how, h.toLowerCase());
  });
});

test('parseAssembly: gyldige argumenter er urørt', () => {
  const r = DD.parseAssembly([
    '# py = ost.connect("https://x/py.parquet")',
    '# demo = ost.create(key=["a", "b"], format="duckdb")',
    '# sales = py.read("salg")',
    '# demo.add(py, ["alder"], table="t", how="outer")',
    '# demo.join(sales, on="pid", how="inner")',
  ].join('\n'));
  assert.deepEqual(r.errors, []);
  const d = r.spec.datasets.find((x) => x.name === 'demo');
  assert.deepEqual(d.steps, [
    { op: 'import', source: 'py__t', columns: ['alder'], how: 'outer' },
    { op: 'join', from: 'sales', on: ['pid'], how: 'inner' },
  ]);
});

test('isDirectiveLine: eksportert fra DataDirectives', () => {
  assert.equal(DD.isDirectiveLine('#meta.bef.note = "t"'), true);
  assert.equal(DD.isDirectiveLine('# bef = ssb.read("05839")'), true);
  assert.equal(DD.isDirectiveLine('SELECT 1'), false);
  assert.equal(DD.isDirectiveLine('#options.view = "output-only"'), false);
  assert.equal(DD.isDirectiveLine('#%% python'), false);
});

// Regresjon: verblisten i stripDataDirectiveLines sluttet å matche da
// grammatikken ble pythonsk, og «#» er ikke kommentar i DuckDB. ALLE
// direktivlinjer lakk inn i __duck.exec(), ikke bare meta-linjene.
test('isDirectiveLine: alle direktivformer må ut av SQL, linjetall bevart', () => {
  const sql = ['#meta.bef.note = "Folkemengde"',
               '# bef = ssb.read("05839")',
               '# panel = ost.create(key="pid")',
               '# panel.add(bef, ["alder"])',
               '-- en vanlig SQL-kommentar',
               'SELECT * FROM bef'].join('\n');
  const stripped = sql.split(/(\r?\n)/)
    .map((p, i) => (i % 2 === 0 && DD.isDirectiveLine(p)) ? '' : p).join('');
  assert.equal(stripped, '\n\n\n\n-- en vanlig SQL-kommentar\nSELECT * FROM bef');
  assert.equal(stripped.split('\n').length, sql.split('\n').length);
});

// ── makeLoad (Task 10) ────────────────────────────────────────────────────
// Direktivstrenger som skrives ett sted og parses et annet har ingen kobling
// mellom seg: tre ganger i denne omleggingen endret grammatikken seg og
// strengen sluttet stille å matche. makeLoad bygger elementet DIREKTE, og
// disse testene pinner at formen er identisk med parserens.
test('makeLoad: gir nøyaktig samme form som parse().loads', () => {
  const made = DD.makeLoad({ alias: 'bef', source: 'ssb', table: '05839' });
  const parsed = DD.parse('# bef = ssb.read("05839")').loads[0];
  assert.deepEqual(made, parsed);
});

test('makeLoad: uten tabell', () => {
  const made = DD.makeLoad({ alias: 'df', source: 'h', table: null });
  const parsed = DD.parse('# df = h.read()').loads[0];
  assert.deepEqual(made, parsed);
});

// Regresjon for feilklassen: den syntetiserte lastelisten må resolve likt
// enten den er bygget direkte eller skrevet som tekst og parset tilbake.
// Tekstveien døde stille tre ganger under omleggingen.
test('makeLoad: monteringskilder resolver likt som tekstveien', () => {
  const script = ['# p = ost.connect("https://x.example/personer.csv")',
                  '# db = ost.connect("https://x/panel.duckdb", kind="duckdb")',
                  '# panel = ost.create(key="pid")',
                  '# panel.add(p, ["income"])',
                  '# panel.add(db, ["age"], table="patients")'].join('\n');
  const spec = DD.parseAssembly(script).spec;
  const tables = spec.sourceTables || {};
  const direct = { connects: DD.parse(script).connects,
                   loads: spec.sources.map((a) => {
                     const t = tables[a];
                     return DD.makeLoad({ alias: a, source: t ? t.source : a, table: t ? t.table : null });
                   }), metas: [], errors: [] };
  const viaText = DD.parse(script + '\n' + spec.sources.map((a) => {
    const t = tables[a];
    return t ? `# ${a} = ${t.source}.read("${t.table}")` : `# ${a} = ${a}.read()`;
  }).join('\n'));
  assert.deepEqual(DD.resolve(direct, []),
                   DD.resolve({ connects: viaText.connects,
                                loads: viaText.loads.filter((l) => spec.sources.indexOf(l.alias) >= 0) }, []));
});

// Pakken har signaturen add(source, columns, table=None, how=None), så
// «add(p, "income", "edu")» leste «edu» som table= og lot kolonnen forsvinne
// STILLE — mens parseren tok den med. Samme linje, to svar. Spec §4.5(a):
// add tar ÉN kolonneparameter.
test('parseAssembly: add tar én kolonneparameter, ikke varargs', () => {
  const pre = ['# p = ost.connect("https://x/p.csv")',
               '# panel = ost.create(key="pid")', ''].join('\n');
  const bad = DD.parseAssembly(pre + '# panel.add(p, "income", "edu")');
  assert.match(bad.errors[0], /add tar én kolonneparameter/);
  assert.deepEqual(bad.spec.datasets.find((d) => d.name === 'panel').steps, []);

  const ok = DD.parseAssembly(pre + '# panel.add(p, ["income", "edu"])');
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.spec.datasets.find((d) => d.name === 'panel').steps[0].columns,
                   ['income', 'edu']);
});

// += (2026-07-27): «=» erstatter (spec §3.3), «+=» føyer til. Uten += var
// eneste vei til flere notater én lang listelinje — og direktivlinjer kan
// ikke brytes, så taket lå på ~2 lenker før linja ble uleselig.
test('meta: += føyer til i stedet for å overskrive', () => {
  const r = DD.parse('# meta.iris.note = "A"\n# meta.iris.note += "B"');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.metas.map((m) => m.text), ['A', 'B']);
});

test('meta: = etter += nullstiller (bevisst erstatning)', () => {
  const r = DD.parse('# meta.iris.note += "A"\n# meta.iris.note = "C"');
  assert.deepEqual(r.metas.map((m) => m.text), ['C']);
});

test('meta: link += utvider lenkelista', () => {
  const r = DD.parse('# meta.iris.link = {"https://a": "A"}\n# meta.iris.link += {"https://b": "B"}');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.metas.map((m) => [m.url, m.label]), [['https://a', 'A'], ['https://b', 'B']]);
});

test('meta: += som første linje er greit (føyer til tomt)', () => {
  const r = DD.parse('# meta.iris.note += "A"');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.metas.map((m) => m.text), ['A']);
});

test('meta: += på variabelnivå virker', () => {
  const r = DD.parse('# meta.iris.sepal_length.note = "A"\n# meta.iris.sepal_length.note += "B"');
  assert.deepEqual(r.metas.map((m) => [m.variable, m.text]), [['sepal_length', 'A'], ['sepal_length', 'B']]);
});

test('meta: += på enkeltverdinøkler gir feil, ikke stillhet', () => {
  ['# meta.iris.title += "T"', '# meta.iris.kilde += "K"',
   '# meta.iris.labels += {"k": "K"}', '# meta.iris.sepal_length.label += "L"',
  ].forEach((line) => {
    const r = DD.parse(line);
    assert.deepEqual(r.metas, [], line);
    assert.match(r.errors[0] || '', /«\+=» støttes bare for note og link/, line);
  });
});

// Gjentatt = som faktisk kaster noe er lov (spec §3.3, x=5;x=7-klassen) —
// men den skal VARSLE, ikke tie: før migreringen AKKUMULERTE gjentatte
// meta-linjer, så vanen sitter, og tapet er brukerens egen tekst.
test('meta: gjentatt = på note/link varsler uten å endre resultatet', () => {
  const r = DD.parse('# meta.iris.note = "A"\n# meta.iris.note = "B"');
  assert.deepEqual(r.metas.map((m) => m.text), ['B']);
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /\+=/);
});

test('meta: første = varsler ikke, og ulike mål varsler ikke', () => {
  const r = DD.parse('# meta.iris.note = "A"\n# meta.pen.note = "B"\n# meta.iris.link = "https://a"');
  assert.deepEqual(r.warnings, []);
});

// ── where-uttrykk (spec 2026-07-29-row-filter-montering §3) ──

test('parseWhereExpr: tall, streng, and', () => {
  const r = DD._parseWhereExpr("folketall > 5000 and fylke == 'Oslo'");
  assert.deepEqual(r, { conds: [
    { col: 'folketall', op: '>', value: 5000 },
    { col: 'fylke', op: '==', value: 'Oslo' },
  ] });
});

test('parseWhereExpr: in-liste med tall og strenger', () => {
  assert.deepEqual(DD._parseWhereExpr('aar in [2020, 2021]'),
    { conds: [{ col: 'aar', op: 'in', value: [2020, 2021] }] });
  assert.deepEqual(DD._parseWhereExpr('fylke in ["Oslo", "Viken"]'),
    { conds: [{ col: 'fylke', op: 'in', value: ['Oslo', 'Viken'] }] });
});

test('parseWhereExpr: unicode-kolonner og backticks', () => {
  assert.deepEqual(DD._parseWhereExpr('år >= 2020'),
    { conds: [{ col: 'år', op: '>=', value: 2020 }] });
  assert.deepEqual(DD._parseWhereExpr('`hele landet` != 0'),
    { conds: [{ col: 'hele landet', op: '!=', value: 0 }] });
});

test('parseWhereExpr: negative tall og desimaltall', () => {
  assert.deepEqual(DD._parseWhereExpr('endring < -0.5'),
    { conds: [{ col: 'endring', op: '<', value: -0.5 }] });
});

test('parseWhereExpr: = gir hint om ==', () => {
  assert.match(DD._parseWhereExpr("fylke = 'Oslo'").error, /mente du «==»/);
});

test('parseWhereExpr: or avvises med in-hint', () => {
  assert.match(DD._parseWhereExpr('a > 1 or b > 2').error, /or støttes ikke/);
});

test('parseWhereExpr: parenteser, tomme uttrykk og rester avvises', () => {
  assert.ok(DD._parseWhereExpr('(a > 1)').error);
  assert.ok(DD._parseWhereExpr('').error);
  assert.ok(DD._parseWhereExpr('a > 1 b').error);
  assert.ok(DD._parseWhereExpr('a in []').error);
  assert.ok(DD._parseWhereExpr('a in 5').error);
  assert.ok(DD._parseWhereExpr('a == b').error);   // kolonne-mot-kolonne: verdi må være literal
});

test('parseWhereExpr: and/or-prefiksede unicode-kolonner misparses ikke', () => {
  // «andøy» er et reelt norsk navn — ASCII-\b ville stille lest and + «øy»
  assert.match(DD._parseWhereExpr('aar > 1 andøy == 2').error, /uventet tekst/);
  assert.ok(DD._parseWhereExpr('orø == 2').conds);   // gyldig kolonne, IKKE or-feil
});

// ── where= på add + filter()-verb (spec 2026-07-29 §2) ──

test('parseAssembly: where= på add gir AST på import-steget', () => {
  const a = DD.parseAssembly([
    '# panel = ost.create(key="kommune")',
    '# panel.add(bef, ["folketall"], where="folketall > 5000")',
  ].join('\n'));
  assert.deepEqual(a.errors, []);
  const st = a.spec.datasets[0].steps[0];
  assert.equal(st.op, 'import');
  assert.deepEqual(st.where, [{ col: 'folketall', op: '>', value: 5000 }]);
});

test('parseAssembly: add uten where har IKKE where-felt', () => {
  const a = DD.parseAssembly([
    '# panel = ost.create(key="kommune")',
    '# panel.add(bef, ["folketall"])',
  ].join('\n'));
  assert.equal('where' in a.spec.datasets[0].steps[0], false);
});

test('parseAssembly: ugyldig where-uttrykk gir linjenummer-feil', () => {
  const a = DD.parseAssembly([
    '# panel = ost.create(key="kommune")',
    '# panel.add(bef, ["folketall"], where="folketall or 5")',
  ].join('\n'));
  assert.equal(a.errors.length, 1);
  assert.match(a.errors[0], /linje 2: ugyldig where-uttrykk/);
});

test('parseAssembly: filter etter add+join uansett linjeplassering', () => {
  const a = DD.parseAssembly([
    '# ekstra = fyl.read()',
    '# panel = ost.create(key="kommune")',
    '# panel.filter("folketall < 99999")',
    '# panel.add(bef, ["folketall"])',
    '# panel.join(ekstra, on="kommune")',
  ].join('\n'));
  assert.deepEqual(a.errors, []);
  const ops = a.spec.datasets.find(d => d.name === 'panel').steps.map(s => s.op);
  assert.deepEqual(ops, ['import', 'join', 'filter']);
});

test('parseAssembly: flere filter-linjer AND-es som separate steg i rekkefølge', () => {
  const a = DD.parseAssembly([
    '# panel = ost.create(key="kommune")',
    '# panel.add(bef, ["folketall", "areal"])',
    '# panel.filter("folketall > 100")',
    '# panel.filter("areal > 5")',
  ].join('\n'));
  assert.deepEqual(a.errors, []);
  const steps = a.spec.datasets[0].steps;
  assert.deepEqual(steps.map(s => s.op), ['import', 'filter', 'filter']);
  assert.equal(steps[1].where[0].col, 'folketall');
  assert.equal(steps[2].where[0].col, 'areal');
});

test('parseAssembly: filter avviser tilordning, kwargs og manglende uttrykk', () => {
  const t1 = DD.parseAssembly('# panel = ost.create(key="k")\n# x = panel.filter("a > 1")');
  assert.match(t1.errors[0], /filter returnerer ingenting/);
  const t2 = DD.parseAssembly('# panel = ost.create(key="k")\n# panel.filter("a > 1", how="inner")');
  assert.match(t2.errors[0], /filter tar ingen navngitte argumenter — fikk «how»/);
  const t3 = DD.parseAssembly('# panel = ost.create(key="k")\n# panel.filter()');
  assert.match(t3.errors[0], /filter krever et uttrykk/);
});

test('parseAssembly: filter på ukjent datasett gir feil, ikke stillhet', () => {
  const a = DD.parseAssembly('# ukjent.filter("a > 1")');
  assert.match(a.errors[0], /linje 1: ukjent datasett «ukjent»/);
});

test('parseAssembly: where må være streng', () => {
  const a = DD.parseAssembly([
    '# panel = ost.create(key="k")',
    '# panel.add(bef, ["a"], where=5)',
  ].join('\n'));
  assert.match(a.errors[0], /where må være en streng/);
});

// Auto-connect (2026-08-01): en registerkilde-id kan stå direkte som receiver
// uten connect-linje — «# helse = worldbank.read("country/…")» skal resolve
// som om «# worldbank = ost.connect("worldbank")» sto over. Feilklassen var
// målt: alle how_to_read-hint og DELIVERY-eksempelet viser bare read-linja.
const AUTOCONNECT_REG = [
  { id: 'worldbank', navn: 'World Bank Open Data', utgiver: 'Verdensbanken',
    tillit: 'offisiell', tilgang: 'rest', kind: 'worldbank',
    base_url: 'https://api.worldbank.org/v2/', cors: true },
  { id: 'oecd', navn: 'OECD SDMX', utgiver: 'OECD', tillit: 'offisiell',
    tilgang: 'sdmx', kind: 'sdmx',
    base_url: 'https://sdmx.oecd.org/public/rest/data/', cors: true },
];

test('resolve: registerkilde som receiver uten connect-linje (auto-connect)', () => {
  const p = DD.parse('# helse = worldbank.read("country/NOR;SWE/indicator/SH.XPD.CHEX.GD.ZS")');
  assert.deepEqual(p.errors, []);
  const items = DD.resolve(p, AUTOCONNECT_REG);
  assert.equal(items[0].error, undefined);
  assert.equal(items[0].url, 'https://api.worldbank.org/v2/country/NOR;SWE/indicator/SH.XPD.CHEX.GD.ZS');
  assert.equal(items[0].kind, 'worldbank');
});

test('resolve: auto-connect med kanonisk vokabular (sdmx)', () => {
  const p = DD.parse('# o = oecd.read("OECD.CFE.EDS,DSD_FUA_CLIM@DF_CLIM_PROJ", years="2030:2060", countries=["NOR"])');
  assert.deepEqual(p.errors, []);
  const items = DD.resolve(p, AUTOCONNECT_REG);
  assert.equal(items[0].error, undefined);
  assert.equal(items[0].url,
    'https://sdmx.oecd.org/public/rest/data/OECD.CFE.EDS,DSD_FUA_CLIM@DF_CLIM_PROJ?startPeriod=2030&endPeriod=2060');
  assert.deepEqual(items[0].needsSdmxKey,
    { countries: ['NOR'], indicators: null, filters: null });
});

test('resolve: ukjent receiver uten registertreff feiler fortsatt', () => {
  const p = DD.parse('# x = tullekilde.read("noe/sti")');
  const items = DD.resolve(p, AUTOCONNECT_REG);
  assert.match(items[0].error, /ukjent kilde-alias «tullekilde»/);
});

test('resolve: eksplisitt connect-alias vinner over registerid', () => {
  const p = DD.parse([
    '# worldbank = ost.connect("https://example.org/annet/")',
    '# x = worldbank.read("sti")',
  ].join('\n'));
  const items = DD.resolve(p, AUTOCONNECT_REG);
  assert.equal(items[0].url, 'https://example.org/annet/sti');
});

// dbnomics dimensions= (2026-08-01): API-et STØTTER dimensjonsfiltrering via
// ?dimensions=<url-enkodet JSON med lister>. Før avviste translateCanonical
// filters= og ba modellen «snevre inn med dimensjonsfiltre i stien» — en
// instruks grammatikken ikke tillot. Målt live: uten filter traff IMF/WEO
// 8624 serier mot 1000-taket (hard feil); med filter 44, alle levert.
const DBN_REG = [{
  id: 'dbnomics', navn: 'DBnomics', utgiver: 'Cepremap', tillit: 'etablert',
  tilgang: 'rest', kind: 'dbnomics', base_url: 'https://api.db.nomics.world/v22/series/', cors: true,
}];

test('translateCanonical dbnomics: filters blir dimensions=<url-enkodet JSON>', () => {
  const t = DD.translateCanonical('dbnomics', 'IMF/WEO:latest',
    { filters: { 'weo-country': ['NOR', 'SWE'] } });
  assert.equal(t.error, undefined);
  assert.equal(t.params.length, 1);
  const val = decodeURIComponent(t.params[0].replace(/^dimensions=/, ''));
  assert.deepEqual(JSON.parse(val), { 'weo-country': ['NOR', 'SWE'] });
});

test('translateCanonical dbnomics: enkeltverdi pakkes som liste (API-et krever array)', () => {
  const t = DD.translateCanonical('dbnomics', 'IMF/WEO:latest', { filters: { 'weo-country': 'NOR' } });
  const val = decodeURIComponent(t.params[0].replace(/^dimensions=/, ''));
  assert.deepEqual(JSON.parse(val), { 'weo-country': ['NOR'] });
});

test('translateCanonical dbnomics: countries/indicators peker til filters, ikke til stien', () => {
  const t = DD.translateCanonical('dbnomics', 'IMF/WEO:latest', { countries: ['NOR'] });
  assert.ok(t.error, 'countries skal fortsatt avvises (dimensjonsnavn varierer per datasett)');
  assert.match(t.error, /filters=/);
  assert.ok(!/i stien/.test(t.error), 'skal IKKE lenger be om noe grammatikken forbyr: ' + t.error);
});

test('resolve dbnomics: filters + years gir dimensions i URL og klient-årsfilter', () => {
  const p = DD.parse('# w = dbnomics.read("IMF/WEO:latest", filters={"weo-country": ["NOR"]}, years="2015:2020")');
  assert.deepEqual(p.errors, []);
  const item = DD.resolve(p, DBN_REG)[0];
  assert.equal(item.error, undefined);
  assert.match(item.url, /^https:\/\/api\.db\.nomics\.world\/v22\/series\/IMF\/WEO:latest\?dimensions=/);
  assert.deepEqual(JSON.parse(decodeURIComponent(item.url.split('dimensions=')[1])), { 'weo-country': ['NOR'] });
  assert.deepEqual(item.clientYears, { from: '2015', to: '2020' });
});
