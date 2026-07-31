// tests/js/data-loader-federert.test.js — fan-out + unionExec for federerte
// kilder (spec 2026-07-31-federert-pull-design §4). Fake fetch/union.
const test = require('node:test');
const assert = require('node:assert');
require('../../js/directive-parser.js');
require('../../js/data-directives.js');
require('../../js/data-loader.js');
const DL = globalThis.DataLoader;

const REG = [
  { id: 'demo-fed', navn: 'Demo', kind: 'federated', overlap: 'possible',
    members: [
      { id: 'nord', url: 'https://nord.no/person.csv' },
      { id: 'vest', url: 'https://vest.no/person.csv' },
    ] },
];

function fakeFetch(urls) {
  return async (url) => {
    urls.push(url);
    return {
      ok: true,
      headers: { get: () => 'text/csv' },
      arrayBuffer: async () => new TextEncoder().encode('x,y\n1,2\n').buffer,
    };
  };
}

const SCRIPT = '# h = ost.connect("demo-fed")\n# df = h.read()';

test('federert: henter alle medlemmer og kaller unionExec', async () => {
  DL._resetCacheForTests();
  const urls = [];
  let called = null;
  const r = await DL.resolveAndFetchLoads(SCRIPT, {
    fetchImpl: fakeFetch(urls), registry: REG,
    unionExec: async (alias, members, meta) => {
      called = { alias, members, meta };
      return { bytes: new Uint8Array([1]), format: 'parquet' };
    },
  });
  assert.deepEqual(urls.sort(), ['https://nord.no/person.csv', 'https://vest.no/person.csv']);
  assert.equal(called.alias, 'df');
  assert.equal(called.members.length, 2);
  assert.equal(called.members[0].id, 'nord');
  assert.equal(called.members[0].format, 'csv');       // sniffet fra content-type
  assert.equal(called.meta.overlap, 'possible');
  assert.equal(r.loads.length, 1);
  assert.equal(r.loads[0].format, 'parquet');
  assert.equal(r.loads[0].federated, true);
  assert.equal(r.loads[0].overlap, 'possible');
});

test('federert: register-id direkte i ost.read virker likt', async () => {
  DL._resetCacheForTests();
  const urls = [];
  const r = await DL.resolveAndFetchLoads('# df = ost.read("demo-fed")', {
    fetchImpl: fakeFetch(urls), registry: REG,
    unionExec: async () => ({ bytes: new Uint8Array([1]), format: 'parquet' }),
  });
  assert.equal(urls.length, 2);
  assert.equal(r.loads[0].federated, true);
});

test('federert: format= overstyrer sniff for medlemmene', async () => {
  DL._resetCacheForTests();
  let called = null;
  await DL.resolveAndFetchLoads('# df = ost.read(["a/x1.bin", "b/x2.bin"], format="parquet")', {
    fetchImpl: fakeFetch([]), registry: [],
    unionExec: async (alias, members) => { called = members; return { bytes: new Uint8Array([1]), format: 'parquet' }; },
  });
  assert.deepEqual(called.map(m => m.format), ['parquet', 'parquet']);
});

test('federert: mangler unionExec gir norsk feil', async () => {
  DL._resetCacheForTests();
  await assert.rejects(
    DL.resolveAndFetchLoads(SCRIPT, { fetchImpl: fakeFetch([]), registry: REG }),
    /unionExec/
  );
});

test('federert: node-medlem stoppes allerede i resolve-laget', async () => {
  DL._resetCacheForTests();
  const reg = [{ id: 'f', navn: 'F', kind: 'federated',
    members: [{ id: 'a', tier: 'node', api: 'http://localhost:9301' }] }];
  await assert.rejects(
    DL.resolveAndFetchLoads('# df = ost.read("f")',
      { fetchImpl: fakeFetch([]), registry: reg, unionExec: async () => ({}) }),
    /node-medlemmer/
  );
});

test('resolveSourcesOnly: federert kilde er aldri pushdown-kandidat', async () => {
  const script = [
    '# h = ost.connect("demo-fed")',
    '# t = ost.create(key="x")',
    '# t.add(h, ["x", "y"])',
  ].join('\n');
  const r = await DL.resolveSourcesOnly(script, { fetchImpl: fakeFetch([]), registry: REG });
  assert.equal(r.descriptors.h, undefined);   // ekskludert -> canPushdown blir false
});
