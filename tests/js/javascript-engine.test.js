// Node-tester for den rene halvdelen av js/javascript-engine.js
// (pre-pass, siste-uttrykk-splitt, lib-skanning, verdi→embed) og de
// DOM-frie delene av runtime-halvdelen (scope-proxy, kjøring, console-
// fangst, notebookSession). Kjør: node --test tests/js/javascript-engine.test.js
const test = require('node:test');
const assert = require('node:assert');
require('../../js/javascript-engine.js');
const E = globalThis.JsEngine;

test('prepass: stripper direktivlinjer, beholder linjetall', () => {
  const out = E._prepass('# load x.csv as x\n#%% js\nconst a = 1;');
  assert.strictEqual(out, '\n\na = 1;');
});

test('prepass: const/let/var → tilordning, kun kolonne 0', () => {
  assert.strictEqual(E._prepass('const x = 1;'), 'x = 1;');
  assert.strictEqual(E._prepass('let a = 1, b = 2;'), 'a = 1, b = 2;');
  assert.strictEqual(E._prepass('  const inner = 1;'), '  const inner = 1;'); // innrykk urørt
});

test('prepass: bare deklarasjoner uten = blir undefined-tilordninger', () => {
  assert.strictEqual(E._prepass('let x;'), 'x = undefined;');
  assert.strictEqual(E._prepass('let x, y'), 'x = undefined; y = undefined;');
});

test('prepass: destrukturering på én linje wrappes i parens', () => {
  assert.strictEqual(E._prepass('const {a, b} = obj;'), '({a, b} = obj);');
  assert.strictEqual(E._prepass('const [p, q] = arr;'), '([p, q] = arr);');
});

test('prepass: function/class-deklarasjoner får navnetilordning', () => {
  assert.strictEqual(E._prepass('function f(x) {'), 'f = function f(x) {');
  assert.strictEqual(E._prepass('async function g() {'), 'g = async function g() {');
  assert.strictEqual(E._prepass('class Punkt {'), 'Punkt = class Punkt {');
});

test('splitLastExpr: rent uttrykk til slutt skilles ut', () => {
  const r = E._splitLastExpr('x = 5;\nx + 1');
  assert.strictEqual(r.expr, 'x + 1');
  assert.strictEqual(r.body, 'x = 5;');
});

test('splitLastExpr: flerlinje-uttrykk (metodekjede) skilles ut', () => {
  const r = E._splitLastExpr('t = 1;\nfoo(1)\n  .bar()\n  .baz()');
  assert.strictEqual(r.expr, 'foo(1)\n  .bar()\n  .baz()');
});

test('splitLastExpr: tilordning til slutt vises ikke', () => {
  assert.strictEqual(E._splitLastExpr('f();\nx = 5').expr, null);
});

test('splitLastExpr: kontrollflyt til slutt vises ikke', () => {
  assert.strictEqual(E._splitLastExpr('for (let i=0;i<2;i++) { f(i); }').expr, null);
});

test('scanLibs: finner registernøkler via ordgrense, op → aq', () => {
  assert.deepStrictEqual(E._scanLibs('const t = aq.table({a:[1]});'), ['aq']);
  assert.deepStrictEqual(E._scanLibs('op.mean("x")'), ['aq']);
  assert.deepStrictEqual(E._scanLibs('ss.mean([1,2]); jStat.normal.cdf(0,0,1)'), ['ss', 'jStat']);
  assert.deepStrictEqual(E._scanLibs('Plotly.newPlot(el, d)'), []);   // Plotly er alltid lastet
  assert.deepStrictEqual(E._scanLibs('classy_name'), []);             // ingen delords-treff
});

test('scanDuckUses: finner use-from-duckdb-direktiver', () => {
  assert.deepStrictEqual(E._scanDuckUses('# use tab1 from duckdb\nx = 1;\n# use t2 from duckdb'),
    ['tab1', 't2']);
  assert.deepStrictEqual(E._scanDuckUses('# use x from python'), []);
});

test('valueToOutput: null/undefined → tom streng', () => {
  assert.strictEqual(E._valueToOutput(null), '');
  assert.strictEqual(E._valueToOutput(undefined), '');
});

test('valueToOutput: arquero-aktig tabell → tablehtml-embed med radgrense', () => {
  const fake = { toHTML: (o) => '<table class="output-table"><tr><td>x</td></tr></table>',
                 objects: () => [], numRows: () => 500 };
  const out = E._valueToOutput(fake);
  assert.ok(out.startsWith('__micro_transform_start_tablehtml__\n'));
  assert.ok(out.includes('viser 200 av 500 rader'));
  assert.ok(out.endsWith('__micro_transform_end__'));
});

test('valueToOutput: plotly-aktig objekt → figure-embed', () => {
  const out = E._valueToOutput({ data: [{ x: [1], y: [2] }], layout: { title: 't' } });
  assert.ok(out.startsWith('__micro_transform_start_figure__\n'));
  assert.ok(JSON.parse(out.split('\n').slice(1, -1).join('\n')).data.length === 1);
});

test('valueToOutput: DOM-aktig node → html-embed', () => {
  const out = E._valueToOutput({ nodeType: 1, outerHTML: '<svg><g/></svg>' });
  assert.ok(out.startsWith('__micro_transform_start_html__\n'));
  assert.ok(out.includes('<svg><g/></svg>'));
});

test('valueToOutput: skalarer og objekter', () => {
  assert.strictEqual(E._valueToOutput(42), '42');
  assert.strictEqual(E._valueToOutput('hei'), 'hei');
  assert.strictEqual(E._valueToOutput({ a: 1 }), '{\n  "a": 1\n}');
});

test('prettyPrint: sirkulær referanse og Map/Set', () => {
  const o = { a: 1 }; o.selv = o;
  assert.ok(E._prettyPrint(o).includes('[Circular]'));
  assert.ok(E._prettyPrint(new Map([['k', 1]])).includes('[Map]'));
});

// ── Runtime-halvdel (kjøres i node: AsyncFunction + scope-proxy er DOM-frie) ──

test('runIn: variabler overlever i samme scope, siste uttrykk vises', async () => {
  const scope = E._makeScope();
  const r1 = await E._runIn(scope, 'const x = 21;', []);
  assert.strictEqual(r1.error, null);
  const r2 = await E._runIn(scope, 'x * 2', []);
  assert.strictEqual(r2.error, null);
  assert.strictEqual(r2.text, '42');
});

test('runIn: console.log fanges, kommer før siste-uttrykk-visningen', async () => {
  const r = await E._runIn(E._makeScope(), 'console.log("a", {b: 1});\n"slutt"', []);
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.text, 'a {\n  "b": 1\n}\nslutt');
});

test('runIn: feil gir {error}, console gjenopprettes', async () => {
  const before = console.log;
  const r = await E._runIn(E._makeScope(), 'kastes_ikke_definert_feil()', []);
  assert.ok(r.error && /kastes_ikke_definert_feil/.test(r.error));
  assert.strictEqual(console.log, before);
});

test('runIn: ukjent identifikator gir ReferenceError, lib-navn får hint', async () => {
  const r = await E._runIn(E._makeScope(), 'helt_ukjent_navn', []);
  assert.ok(/helt_ukjent_navn/.test(r.error));
});

test('runIn: await på toppnivå virker', async () => {
  const r = await E._runIn(E._makeScope(), 'const v = await Promise.resolve(7);\nv', []);
  assert.strictEqual(r.text, '7');
});

test('runIn: funksjonsdeklarasjon overlever til neste kjøring', async () => {
  const scope = E._makeScope();
  await E._runIn(scope, 'function dobbel(n) {\n  return n * 2;\n}', []);
  const r = await E._runIn(scope, 'dobbel(5)', []);
  assert.strictEqual(r.text, '10');
});

test('run: ferskt scope per kall (ingen lekkasje)', async () => {
  await E.run('const lekk = 1;', {});
  // NB: også `typeof lekk` ville kastet her — alle oppslag går via proxyen,
  // som kaster ReferenceError for ukjente navn (bevisst: høylytte skrivefeil).
  const r = await E.run('lekk', {});
  assert.ok(r.error && /lekk/.test(r.error));
});

test('notebookSession: ensure/runCell/reset-livssyklus', async () => {
  const sess = E.notebookSession;
  assert.strictEqual(sess.isLive(), false);
  const r0 = await sess.runCell('1 + 1');
  assert.ok(r0.error);                       // runCell før ensure → kontraktsfeil
  await sess.ensure([]);
  assert.strictEqual(sess.isLive(), true);
  await sess.runCell('const c = 3;');
  const r = await sess.runCell('c + 1');
  assert.strictEqual(r.text, '4');
  await sess.reset();
  assert.strictEqual(sess.isLive(), false);
});

test('bindLoads: csv-load blir arquero-tabell i scopet (stubbet aq)', async () => {
  globalThis.aq = {
    fromCSV: (txt) => ({ _csv: txt, toHTML: () => '<table></table>', objects: () => [], numRows: () => 1 }),
    from: (rows) => ({ rows }), table: (cols) => ({ cols }), op: {}
  };
  try {
    const scope = E._makeScope();
    const bytes = new TextEncoder().encode('a,b\n1,2');
    const r = await E._runIn(scope, 'iris._csv.length', [{ alias: 'iris', bytes, format: 'csv' }]);
    assert.strictEqual(r.error, null);
    assert.strictEqual(r.text, String('a,b\n1,2'.length));
  } finally { delete globalThis.aq; delete globalThis.op; }
});
