// tests/js/data-directives-federert.test.js — liste/dict i ost.read + register-
// definerte federerte kilder (spec 2026-07-31-federert-pull-design §3).
const test = require('node:test');
const assert = require('node:assert');
require('../../js/directive-parser.js');
require('../../js/data-directives.js');
const DD = globalThis.DataDirectives;

const REG = [
  { id: 'demo-fed', navn: 'Demo', kind: 'federated', overlap: 'possible', entity: 'pid',
    members: [
      { id: 'nord', url: 'data/federert/nord.parquet' },
      { id: 'vest', url: 'data/federert/vest.parquet' },
    ] },
  { id: 'fed-node', navn: 'N', kind: 'federated',
    members: [{ id: 'a', tier: 'node', api: 'http://localhost:9301', source: 'person' }] },
  { id: 'fed-beskyttet', navn: 'B', kind: 'federated',
    members: [{ id: 's', url: 'https://s.no/d.csv', level: 'sensitive' }] },
  { id: 'fed-nested', navn: 'X', kind: 'federated',
    members: [{ id: 'y', kind: 'federated', members: [] }] },
  { id: 'fed-tom', navn: 'T', kind: 'federated', members: [] },
];

function res1(script) {
  const p = DD.parse(script);
  assert.deepEqual(p.errors, [], 'uventede parsefeil: ' + p.errors.join('; '));
  return DD.resolve(p, REG)[0];
}

test('parse: liste gir members med filnavn-id-er', () => {
  const p = DD.parse('# person = ost.read(["data/nord.parquet", "data/vest.parquet"])');
  assert.deepEqual(p.errors, []);
  assert.equal(p.loads[0].target, null);
  assert.deepEqual(p.loads[0].members, [
    { id: 'nord', url: 'data/nord.parquet' },
    { id: 'vest', url: 'data/vest.parquet' },
  ]);
});

test('parse: like filnavn faller tilbake til m1..mN', () => {
  const p = DD.parse('# person = ost.read(["a/person.parquet", "b/person.parquet"])');
  assert.deepEqual(p.loads[0].members.map(m => m.id), ['m1', 'm2']);
});

test('parse: dict-nøkler blir medlemsnavn (insertion order)', () => {
  const p = DD.parse('# person = ost.read({"nord": "x/p1.csv", "vest": "y/p2.csv"})');
  assert.deepEqual(p.loads[0].members, [
    { id: 'nord', url: 'x/p1.csv' },
    { id: 'vest', url: 'y/p2.csv' },
  ]);
});

test('parse: bart ord i lista gir norsk feil med hint', () => {
  const p = DD.parse('# person = ost.read([nord])');
  assert.equal(p.loads.length, 0);
  assert.ok(/anførselstegn/.test(p.errors[0]), p.errors[0]);
});

test('parse: tom liste gir feil', () => {
  const p = DD.parse('# person = ost.read([])');
  assert.ok(/minst ett medlem/.test(p.errors[0]), p.errors[0]);
});

test('parse: format= på vanlig read avvises', () => {
  const p = DD.parse('# df = ost.read("https://x.no/d.csv", format="csv")');
  assert.ok(/format=/.test(p.errors[0]), p.errors[0]);
});

test('parse: format= på connect avvises', () => {
  const p = DD.parse('# h = ost.connect("https://x.no/", format="csv")');
  assert.ok(/format=/.test(p.errors[0]), p.errors[0]);
});

test('resolve: inline liste -> federated-item; relative stier er URL-er', () => {
  const r = res1('# person = ost.read(["data/nord.parquet", "data/vest.parquet"])');
  assert.equal(r.alias, 'person');
  assert.deepEqual(r.federated.map(m => m.url),
    ['data/nord.parquet', 'data/vest.parquet']);
});

test('resolve: secret_key= og format= arves av alle medlemmer', () => {
  const r = res1('# person = ost.read(["u1", "u2"], secret_key="abc", format="parquet")');
  r.federated.forEach(m => { assert.equal(m.key, 'abc'); assert.equal(m.format, 'parquet'); });
});

test('resolve: ugyldig format avvises', () => {
  const r = res1('# person = ost.read(["u1", "u2"], format="xlsx")');
  assert.ok(/format/.test(r.error), r.error);
});

test('resolve: register-id direkte i ost.read', () => {
  const r = res1('# person = ost.read("demo-fed")');
  assert.deepEqual(r.federated.map(m => m.id), ['nord', 'vest']);
  assert.equal(r.overlap, 'possible');
  assert.equal(r.entity, 'pid');
});

test('resolve: register via connect-alias, med sti-appendering', () => {
  const p = DD.parse('# h = ost.connect("demo-fed")\n# person = h.read("2024")');
  assert.deepEqual(p.errors, []);
  const r = DD.resolve(p, REG)[0];
  assert.deepEqual(r.federated.map(m => m.url),
    ['data/federert/nord.parquet/2024', 'data/federert/vest.parquet/2024']);
});

test('resolve: node-medlemmer nektes med safestat-peker', () => {
  const r = res1('# person = ost.read("fed-node")');
  assert.ok(/node-medlemmer/.test(r.error) && /safestat/.test(r.error), r.error);
});

test('resolve: beskyttet medlem nektes med safestat-peker', () => {
  const r = res1('# person = ost.read("fed-beskyttet")');
  assert.ok(/sensitive/.test(r.error) && /safestat/.test(r.error), r.error);
});

test('resolve: nesting nektes', () => {
  const r = res1('# person = ost.read("fed-nested")');
  assert.ok(/federerte medlemmer/.test(r.error), r.error);
});

test('resolve: tom members-liste nektes', () => {
  const r = res1('# person = ost.read("fed-tom")');
  assert.ok(/ingen medlemmer/.test(r.error), r.error);
});

test('resolve: ukjent id gir fortsatt alias-feilen', () => {
  const r = res1('# person = ost.read("finnes-ikke")');
  assert.ok(/ukjent kilde-alias/.test(r.error), r.error);
});

// Sluttreview-funn 2 (2026-07-31): kind=/cache=/exec= parses OK men hadde
// null effekt på federerte reads — stille dropp. kind="csv" er den naturlige
// skrivefeilen for format="csv".
test('resolve: kind= på inline federert liste avvises med format=-hint', () => {
  const r = res1('# person = ost.read(["u1", "u2"], kind="csv")');
  assert.ok(/kind=/.test(r.error) && /format=/.test(r.error), r.error);
});

test('resolve: kind= på register-id federert (uten connect) avvises med format=-hint', () => {
  const r = res1('# person = ost.read("demo-fed", kind="csv")');
  assert.ok(/kind=/.test(r.error) && /format=/.test(r.error), r.error);
});

test('resolve: kind= på federert via connect-alias avvises med format=-hint', () => {
  const p = DD.parse('# h = ost.connect("demo-fed", kind="csv")\n# person = h.read()');
  assert.deepEqual(p.errors, []);
  const r = DD.resolve(p, REG)[0];
  assert.ok(/kind=/.test(r.error) && /format=/.test(r.error), r.error);
});

test('resolve: exec= på inline federert liste avvises', () => {
  const r = res1('# person = ost.read(["u1", "u2"], exec="remote")');
  assert.ok(/exec=/.test(r.error), r.error);
});

test('resolve: exec= på register-id federert avvises', () => {
  const r = res1('# person = ost.read("demo-fed", exec="remote")');
  assert.ok(/exec=/.test(r.error), r.error);
});

test('resolve: cache= arves av alle medlemmer (inline)', () => {
  const r = res1('# person = ost.read(["u1", "u2"], cache="30m")');
  r.federated.forEach(m => assert.equal(m.cache, '30m'));
});

test('resolve: cache= arves av alle medlemmer (register-id)', () => {
  const r = res1('# person = ost.read("demo-fed", cache="1h")');
  r.federated.forEach(m => assert.equal(m.cache, '1h'));
});

test('resolve: cache= på connect arves av federerte medlemmer', () => {
  const p = DD.parse('# h = ost.connect("demo-fed", cache="1d")\n# person = h.read()');
  assert.deepEqual(p.errors, []);
  const r = DD.resolve(p, REG)[0];
  r.federated.forEach(m => assert.equal(m.cache, '1d'));
});
