const test = require('node:test');
const assert = require('node:assert');
const D = require('../../js/dash.js');

// ---------- fase B2 Task 3: D.sweepDisconnected (DOM-halvdel, minimal stub) ----------

test('sweepDisconnected: fjerner registrerte dashboards straks roten er frakoblet DOM, uten å vente på neste create()', () => {
  function makeNode() {
    return {
      isConnected: true,
      appendChild: function () {},
      classList: { add: function () {}, remove: function () {}, toggle: function () {} },
      style: {},
      querySelector: function () { return null; }
    };
  }
  var created = []; // kun document.createElement-noder (IKKE containeren fra getElementById)
  var savedDocument = global.document;
  global.document = {
    getElementById: function () { return makeNode(); }, // #outputArea-containeren -- separat objekt, aldri i `created`
    createElement: function () { var n = makeNode(); created.push(n); return n; },
    body: makeNode()
  };
  try {
    var id1 = D.create('{}');
    var root1 = created[0]; // el('div', 'dash') er FØRSTE createElement-kall uten tittel/layout
    assert.strictEqual(D.isAlive(id1), true);
    // Simuler det index.html sin per-celle-purge nå gjør FØR en rerun (fase
    // B2 Task 3): #outputArea tømmes (outputArea.innerHTML = '') uten at et
    // NYTT dashboard nødvendigvis opprettes samme kjøring — roten kobles fra
    // DOM-treet, men D.create() (som ville sopet den lazy) kalles kanskje
    // aldri igjen i denne dokumentets levetid.
    root1.isConnected = false;
    assert.strictEqual(D.isAlive(id1), false); // isAlive sjekker isConnected direkte, uavhengig av sweep
    D.sweepDisconnected();
    // Selve poenget med en EKSPLISITT sweep (ikke bare stole på isAlive over):
    // registeroppføringen er nå faktisk BORTE, ikke bare "isConnected: false"
    // — addCard mot en sopet id kaster (dash-objektet finnes ikke), mot en
    // kun-frakoblet-men-ikke-sopet id ville addCard stille (og virkningsløst,
    // Plotly-instanser etc. aldri frigjort) ha skrevet videre inn i det døde
    // objektet.
    assert.throws(function () { D.addCard(id1, '{}', null, null); });
  } finally {
    global.document = savedDocument;
  }
});

// ---------- fase B2 Task 4b: D.create sin mount-rot (notatbok-slot vs #outputArea) ----------

test('D.create: notatbok-kontekst (mdUiRunCtx) → monterer i cellens .nb-output-body, IKKE #outputArea (widget-plassering-fasen)', () => {
  function makeNode(name) {
    var n = {
      name: name,
      isConnected: true,
      children: [],
      appendChild: function (child) { n.children.push(child); },
      classList: { add: function () {}, remove: function () {}, toggle: function () {} },
      style: {},
      querySelector: function () { return null; }
    };
    return n;
  }
  var outputAreaNode = makeNode('outputArea');
  var slotNode = makeNode('nb-output-body-slot');
  var cellEl = { querySelector: function (sel) { return sel === '.nb-output-body' ? slotNode : null; } };
  var savedDocument = global.document;
  var savedCtx = global.mdUiRunCtx;
  global.document = {
    getElementById: function () { return outputAreaNode; },
    createElement: function () { return makeNode('created'); },
    body: makeNode('body')
  };
  global.mdUiRunCtx = function () { return { cellIdx: 0, cellEl: cellEl }; };
  try {
    D.create('{}');
    assert.strictEqual(slotNode.children.length, 1, 'dashboardroten skal monteres i cellens .nb-output-body');
    assert.strictEqual(outputAreaNode.children.length, 0, '#outputArea skal IKKE motta roten når ctx finnes');
  } finally {
    global.document = savedDocument;
    global.mdUiRunCtx = savedCtx;
  }
});

test('D.create: ingen kjørekontekst → faller tilbake til #outputArea (vanlig skript, uendret)', () => {
  function makeNode(name) {
    var n = {
      name: name,
      isConnected: true,
      children: [],
      appendChild: function (child) { n.children.push(child); },
      classList: { add: function () {}, remove: function () {}, toggle: function () {} },
      style: {},
      querySelector: function () { return null; }
    };
    return n;
  }
  var outputAreaNode = makeNode('outputArea');
  var savedDocument = global.document;
  var savedCtx = global.mdUiRunCtx;
  global.document = {
    getElementById: function () { return outputAreaNode; },
    createElement: function () { return makeNode('created'); },
    body: makeNode('body')
  };
  global.mdUiRunCtx = function () { return null; }; // ingen aktiv notatbok-kjøring
  try {
    D.create('{}');
    assert.strictEqual(outputAreaNode.children.length, 1, 'plain-script-dashbord skal fortsatt gå til #outputArea');
  } finally {
    global.document = savedDocument;
    global.mdUiRunCtx = savedCtx;
  }
});

test('parseMosaic: enkel 2x2', () => {
  const m = D.parseMosaic('a b\nc d');
  assert.strictEqual(m.error, undefined);
  assert.strictEqual(m.columns, 2);
  assert.strictEqual(m.rows, 2);
  assert.deepStrictEqual(m.names.sort(), ['a', 'b', 'c', 'd']);
  assert.strictEqual(m.gridTemplateAreas, '"a b" "c d"');
});

test('parseMosaic: spenn horisontalt og vertikalt', () => {
  const m = D.parseMosaic(`
    kpi1 kpi2 kpi3 kpi3
    plot plot plot tab
    plot plot plot tab
  `);
  assert.strictEqual(m.error, undefined);
  assert.strictEqual(m.columns, 4);
  assert.strictEqual(m.rows, 3);
  assert.ok(m.names.includes('plot'));
});

test('parseMosaic: punktum er tom celle', () => {
  const m = D.parseMosaic('a . b\na . b');
  assert.strictEqual(m.error, undefined);
  assert.deepStrictEqual(m.names.sort(), ['a', 'b']);
  assert.strictEqual(m.gridTemplateAreas, '"a . b" "a . b"');
});

test('parseMosaic: ikke-rektangulaert omraade gir feil', () => {
  const m = D.parseMosaic('a a b\nc a b');
  assert.match(m.error, /rektangul/);
  assert.match(m.error, /"a"/);
});

test('parseMosaic: ulikt antall kolonner per linje gir feil', () => {
  const m = D.parseMosaic('a b c\nd e');
  assert.match(m.error, /linje 2/);
});

test('parseMosaic: mer enn 12 kolonner gir feil', () => {
  const m = D.parseMosaic('a b c d e f g h i j k l m');
  assert.match(m.error, /12/);
});

test('parseMosaic: tom streng gir feil', () => {
  assert.ok(D.parseMosaic('').error);
  assert.ok(D.parseMosaic(null).error);
});

test('autoSpan: KPI 3, plott/bilde 6, tekst/markdown 12', () => {
  assert.strictEqual(D.autoSpan('number'), 3);
  assert.strictEqual(D.autoSpan('figure'), 6);
  assert.strictEqual(D.autoSpan('image'), 6);
  assert.strictEqual(D.autoSpan('markdown'), 12);
  assert.strictEqual(D.autoSpan('text'), 12);
});

test('autoSpan: tabell 6 ved faa kolonner, 12 ved mange', () => {
  assert.strictEqual(D.autoSpan('table', 4), 6);
  assert.strictEqual(D.autoSpan('table', 9), 12);
  assert.strictEqual(D.autoSpan('table'), 6);
});

test('autoOrder: KPI foerst', () => {
  assert.strictEqual(D.autoOrder('number'), 0);
  assert.strictEqual(D.autoOrder('figure'), 1);
});

// ---------- K2: encodeState / decodeState (URL-state, rene funksjoner) ----------

test('encodeState/decodeState: rundtur med shared + cards', () => {
  const state = {
    shared: { n: 42, aktiv: true, navn: 'ærlig test' },
    cards: { '0': { terskel: -5.5 }, '1': { valg: 2 } }
  };
  const encoded = D.encodeState(state);
  assert.strictEqual(typeof encoded, 'string');
  assert.ok(encoded.length > 0);
  const decoded = D.decodeState(encoded);
  assert.deepStrictEqual(decoded, state);
});

test('encodeState: base64url uten padding, "+" eller "/"', () => {
  // Payload valgt for å sannsynliggjøre + og / i standard base64.
  const state = { shared: { x: 111111111, y: 999999999, s: '>>>???///+++' }, cards: {} };
  const encoded = D.encodeState(state);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.ok(!encoded.includes('+'));
  assert.ok(!encoded.includes('/'));
  assert.ok(!encoded.includes('='));
  assert.deepStrictEqual(D.decodeState(encoded), state);
});

test('decodeState: ugyldig input gir null', () => {
  assert.strictEqual(D.decodeState(null), null);
  assert.strictEqual(D.decodeState(undefined), null);
  assert.strictEqual(D.decodeState(''), null);
  assert.strictEqual(D.decodeState(123), null);
  assert.strictEqual(D.decodeState('ikke-gyldig-base64!!!'), null);
  assert.strictEqual(D.decodeState('####'), null);
  // Gyldig base64url, men JSON-innholdet er en array, ikke et objekt.
  const arrEncoded = D.encodeState([1, 2, 3]);
  assert.strictEqual(D.decodeState(arrEncoded), null);
});

test('encodeState/decodeState: tomt objekt rundtur', () => {
  const encoded = D.encodeState({});
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.deepStrictEqual(D.decodeState(encoded), {});
});

// ---------- Number-payload v3: formatNumber + computeDelta FLYTTET til
// js/ui.js (dash-absorpsjon 5a Task 1) — se tests/js/ui.test.js for de samme
// assertene mot Ui.formatNumber/Ui.computeDelta (repointet, ikke duplisert).
// D.formatNumber/D.computeDelta finnes ikke lenger på D. ----------

test('D.formatNumber/D.computeDelta finnes ikke lenger — flyttet til Ui (ingen gaffel)', () => {
  assert.strictEqual(D.formatNumber, undefined);
  assert.strictEqual(D.computeDelta, undefined);
});

test('payloadCols: html-tabell bruker cols, strukturert bruker columns.length', () => {
  assert.strictEqual(D.payloadCols({ kind: 'table', html: '<table/>', cols: 9 }), 9);
  assert.strictEqual(D.payloadCols({ kind: 'table', columns: ['a', 'b'], rows: [] }), 2);
  assert.strictEqual(D.payloadCols({ kind: 'number', value: 1 }), 0);
});

// ---------- D.renderPayload — tynn delegat til Ui.renderPayload (dash-
// absorpsjon 5a Task 1). Kun 'node' (dash-only, ingen rendring) og 'number'
// (mappes til Ui sin 'kpi') er dash-spesifikk logikk igjen — alt annet
// sendes videre uendret. En minimal document-stub (kun det D.renderPayload
// sin egen el()-hjelper og wegwerp-beholderen trenger: createElement,
// className, textContent, appendChild/firstChild) installeres PER test,
// sammen med en spionert global.Ui, ikke den ekte js/ui.js — selve
// Ui.renderPayload-innholdet er dekket av tests/js/ui.test.js og
// tests/js/ui-dom.test.js. ----------

class FakeDashEl {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this._className = '';
    this._text = '';
  }
  set className(v) { this._className = v; }
  get className() { return this._className; }
  set textContent(v) { this._text = v; }
  get textContent() { return this._text; }
  appendChild(c) { this.children.push(c); return c; }
  get firstChild() { return this.children[0] || null; }
}

function withFakeDom(fn) {
  const savedDocument = global.document;
  const savedUi = global.Ui;
  global.document = { createElement: (tag) => new FakeDashEl(tag) };
  try {
    fn();
  } finally {
    global.document = savedDocument;
    global.Ui = savedUi;
  }
}

test("D.renderPayload: kind 'node' returnerer nodeEl direkte — dash-only, Ui involveres aldri", () => {
  withFakeDom(() => {
    let called = false;
    global.Ui = { renderPayload: () => { called = true; } };
    const nodeEl = new FakeDashEl('div');
    const result = D.renderPayload({ kind: 'node' }, nodeEl);
    assert.strictEqual(result, nodeEl);
    assert.strictEqual(called, false, 'Ui.renderPayload skal ikke kalles for kind node');
  });
});

test("D.renderPayload: kind 'number' mappes til Ui sin 'kpi' FØR delegering, feltene uendret", () => {
  withFakeDom(() => {
    let seen = null;
    global.Ui = {
      renderPayload: (p, host) => {
        seen = p;
        const stub = new FakeDashEl('div');
        stub.className = 'ui-kpi';
        host.appendChild(stub);
        return stub;
      },
    };
    const result = D.renderPayload({ kind: 'number', value: 42, unit: 'kr', fmt: '.1f', ref: 40, bra: 'opp' }, null);
    assert.deepStrictEqual(seen, { kind: 'kpi', value: 42, unit: 'kr', fmt: '.1f', ref: 40, bra: 'opp' });
    assert.strictEqual(result.className, 'ui-kpi');
  });
});

['markdown', 'text', 'table', 'image', 'figure', 'error'].forEach((kind) => {
  test('D.renderPayload: kind ' + JSON.stringify(kind) + ' sendes UENDRET videre til Ui.renderPayload (ingen dash-mapping)', () => {
    withFakeDom(() => {
      let seenKind = null;
      global.Ui = {
        renderPayload: (p, host) => {
          seenKind = p.kind;
          const stub = new FakeDashEl('div');
          host.appendChild(stub);
          return stub;
        },
      };
      D.renderPayload({ kind: kind, value: 1, text: 'x', message: 'y' }, null);
      assert.strictEqual(seenKind, kind);
    });
  });
});

test('D.renderPayload: Ui mangler helt → forsiktig tekstfallback, kaster aldri', () => {
  withFakeDom(() => {
    delete global.Ui;
    const result = D.renderPayload({ kind: 'text', text: 'hei' }, null);
    assert.strictEqual(result.tag, 'pre');
    assert.match(result.textContent, /Ui\.renderPayload/);
  });
});

test('D.renderPayload: Ui.renderPayload rendrer ingenting (sann ukjent kind) → lokal JSON-fallback, appendChild krasjer aldri', () => {
  withFakeDom(() => {
    global.Ui = { renderPayload: () => null }; // etterligner Ui sin unknown-gren (host urørt)
    const result = D.renderPayload({ kind: 'noe-helt-ukjent', x: 1 }, null);
    assert.strictEqual(result.tag, 'pre');
    assert.strictEqual(result.textContent, JSON.stringify({ kind: 'noe-helt-ukjent', x: 1 }));
  });
});
