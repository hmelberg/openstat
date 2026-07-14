'use strict';

// DOM-halvdel av js/ui.js er ikke node-testbar uten en DOM — dette er en
// minimal hånd-stubbet DOM, installert som globaler FØR require('../../js/ui.js')
// slik at `typeof document !== 'undefined'`-porten åpner seg. Samme mønster
// som tests/js/cells-dom.test.js bruker for js/cells.js, men stubben her er
// enda enklere: ui.js sin DOM-halvdel bruker aldri querySelector mot cellEl
// (kun _strips-registeret + parentNode-identitet), så ingen selektor-motor
// trengs.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const UI_PATH = path.join(__dirname, '..', '..', 'js', 'ui.js');

class FakeEl {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this._parentNode = null;
    this._listeners = {};
    this._className = '';
    this.value = '';
    this.checked = false;
    this.min = undefined;
    this.max = undefined;
    this.step = undefined;
    this.type = '';
    this._text = '';
  }
  set className(v) { this._className = v; }
  get className() { return this._className; }
  get classList() {
    const self = this;
    return { contains: (c) => self._className.split(/\s+/).filter(Boolean).includes(c) };
  }
  set textContent(v) { this._text = v; this.children = []; }
  get textContent() { return this._text; }
  appendChild(c) { this.children.push(c); c._parentNode = this; return c; }
  insertBefore(node, ref) {
    if (ref == null) {
      this.children.push(node);
    } else {
      const idx = this.children.indexOf(ref);
      if (idx === -1) this.children.push(node);
      else this.children.splice(idx, 0, node);
    }
    node._parentNode = this;
    return node;
  }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c._parentNode = null; return c; }
  remove() { if (this._parentNode) this._parentNode.removeChild(this); }
  get parentNode() { return this._parentNode; }
  get firstChild() { return this.children[0] || null; }
  addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
  dispatchEvent(ev) { (this._listeners[ev.type] || []).forEach((fn) => fn(ev)); }
  setAttribute(name, v) { this[name] = v; }
  getAttribute(name) { return this[name]; }
}

function wait(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// Bygger en frisk DOM-stub + laster ui.js på nytt (dokument-scoped tilstand
// — _values/_controls/_strips/_cellRuns — er et closure-singleton, så et
// fersk require er nødvendig per scenario, akkurat som cells-dom.test.js).
function freshEnv(opts) {
  opts = opts || {};
  delete require.cache[require.resolve(UI_PATH)];
  global.document = { createElement: (tag) => new FakeEl(tag) };

  const cellEl = new FakeEl('div');
  cellEl.className = 'nb-cell';
  const inputEl = new FakeEl('div');
  inputEl.className = 'nb-input';
  const outEl = new FakeEl('div');
  outEl.className = 'nb-output';
  cellEl.appendChild(inputEl);
  cellEl.appendChild(outEl);

  const cellIdx = opts.cellIdx != null ? opts.cellIdx : 0;
  let ctx;
  if (opts.ctxNull) ctx = null;
  else if (opts.cellElNull) ctx = { cellIdx: cellIdx, cellEl: null };
  else ctx = { cellIdx: cellIdx, cellEl: cellEl };

  global.mdUiRunCtx = () => ctx;

  const runCellCalls = [];
  global.Cells = {
    runCell: (idx) => { runCellCalls.push(idx); },
    cellIndexById: (id) => {
      const map = opts.idMap || {};
      return Object.prototype.hasOwnProperty.call(map, id) ? map[id] : -1;
    },
  };
  global.mdIsScriptRunning = () => !!opts.scriptRunning;

  const Ui = require(UI_PATH);

  return {
    Ui, cellEl, inputEl, outEl, runCellCalls,
    setCtx: (c) => { ctx = c; },
    setScriptRunning: (v) => { global.mdIsScriptRunning = () => v; },
  };
}

// ---- registrering: strip-plassering, default, no-rebuild -----------------

test('registerControl: null ctx (utenfor kjøring) → null', () => {
  const { Ui } = freshEnv({ ctxNull: true });
  const res = Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x' }));
  assert.strictEqual(res, null);
});

test('registerControl: ctx finnes men cellEl er null (kant-case fra Task 2) → null', () => {
  const { Ui } = freshEnv({ cellElNull: true });
  const res = Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x' }));
  assert.strictEqual(res, null);
});

test('registerControl: oppretter .ui-controls som FØRSTE barn (før .nb-input/.nb-output), returnerer spec-default', () => {
  const { Ui, cellEl, inputEl, outEl } = freshEnv();
  const res = Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 0, max: 10, value: 5 }));
  assert.strictEqual(JSON.parse(res), 5);

  assert.strictEqual(cellEl.children.length, 3, 'stripe + de to opprinnelige barna');
  assert.strictEqual(cellEl.children[0].className, 'ui-controls', 'stripa er FØRSTE barn');
  assert.strictEqual(cellEl.children[1], inputEl, '.nb-input uendret, nå andre barn');
  assert.strictEqual(cellEl.children[2], outEl, '.nb-output uendret, nå tredje barn');

  const strip = cellEl.children[0];
  assert.strictEqual(strip.children.length, 1, 'ett kontrollelement i stripa');
});

test('registerControl: samme nøkkel re-registrert → returnerer LAGRET verdi, SAMME DOM-node (ingen ombygging)', async () => {
  const { Ui, cellEl } = freshEnv();
  Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 0, max: 100, value: 5 }));
  const strip = cellEl.children[0];
  const widgetNode = strip.children[0];
  const rangeInput = widgetNode.children[1]; // label-span, input, readout-span

  // Bruker endrer via UI (simulerer en 'input'-hendelse) — lagres umiddelbart.
  rangeInput.value = '42';
  rangeInput.dispatchEvent({ type: 'input' });

  const res = Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 0, max: 100, value: 5 }));
  assert.strictEqual(JSON.parse(res), 42, 'lagret verdi (ikke spec sin default 5) returneres');
  assert.strictEqual(strip.children.length, 1, 'ingen duplikat-node opprettet');
  assert.strictEqual(strip.children[0], widgetNode, 'samme DOM-node gjenbrukt — ingen ombygging/fokus-tap');
  // Flush den ekte 150ms-debouncen fra dispatchEvent over FØR testen
  // avsluttes — ellers overlever en løs timer inn i neste test og kaller
  // Cells.runCell mot DEN testens (da reassignerte) global.Cells-stub.
  await wait(200);
});

test('registerControl: endret min klamper lagret verdi til nytt intervall', () => {
  const { Ui, cellEl } = freshEnv();
  const first = Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 0, max: 100, value: 10 }));
  assert.strictEqual(JSON.parse(first), 10);

  const second = Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 50, max: 100, value: 10 }));
  assert.strictEqual(JSON.parse(second), 50, 'lagret verdi 10 er under ny min 50 — klampes opp');

  const strip = cellEl.children[0];
  const rangeInput = strip.children[0].children[1];
  assert.strictEqual(Number(rangeInput.value), 50, 'DOM-noden reflekterer den klampede verdien');
});

// ---- endring → debounce → rerun -------------------------------------------

test("change → lagrer umiddelbart, kjører Cells.runCell('self'-cellIdx) etter 150ms debounce", async () => {
  const { Ui, cellEl, runCellCalls } = freshEnv({ cellIdx: 2 });
  Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 0, max: 100, value: 5 }));
  const strip = cellEl.children[0];
  const rangeInput = strip.children[0].children[1];

  rangeInput.value = '77';
  rangeInput.dispatchEvent({ type: 'input' });

  assert.strictEqual(runCellCalls.length, 0, 'ingen umiddelbar kjøring — debouncet');
  await wait(200);
  assert.deepStrictEqual(runCellCalls, [2], 'debouncet rerun av den deklarerende cellen (idx 2)');
});

test("rerun: 'none' lagrer verdien men trigger ALDRI en rerun", async () => {
  const { Ui, cellEl, runCellCalls } = freshEnv({ cellIdx: 3 });
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'x', value: 'a', rerun: 'none' }));
  const strip = cellEl.children[0];
  const textInput = strip.children[0].children[1];

  textInput.value = 'b';
  textInput.dispatchEvent({ type: 'change' });
  await wait(200);

  assert.deepStrictEqual(runCellCalls, [], "rerun:'none' skal aldri kjøre noe");
  const again = Ui.registerControl(JSON.stringify({ type: 'text', name: 'x', value: 'a', rerun: 'none' }));
  assert.strictEqual(JSON.parse(again), 'b', 'men verdien ER lagret');
});

test('rerun: ukjent id-mål → console.warn + hoppes over (ingen kjøring)', async () => {
  const { Ui, cellEl, runCellCalls } = freshEnv({ idMap: {} });
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'x', value: 'a', rerun: 'nope' }));
  const strip = cellEl.children[0];
  const textInput = strip.children[0].children[1];

  const origWarn = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  try {
    textInput.value = 'b';
    textInput.dispatchEvent({ type: 'change' });
    await wait(200);
  } finally {
    console.warn = origWarn;
  }
  assert.deepStrictEqual(runCellCalls, []);
  assert.ok(warned >= 1, 'console.warn skal kalles for ukjent rerun-id');
});

test('rerun: array av id-er reruner HVER av dem', async () => {
  const { Ui, cellEl, runCellCalls } = freshEnv({ idMap: { a: 3, b: 4 } });
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'x', value: 'v', rerun: ['a', 'b'] }));
  const strip = cellEl.children[0];
  const textInput = strip.children[0].children[1];

  textInput.value = 'w';
  textInput.dispatchEvent({ type: 'change' });
  await wait(200);

  assert.deepStrictEqual(runCellCalls.slice().sort(), [3, 4]);
});

test('rerun: duplikat-id-er i array dedupes — én kjøring per unik målcelle', async () => {
  const { Ui, cellEl, runCellCalls } = freshEnv({ idMap: { a: 3, b: 4 } });
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'x', value: 'v', rerun: ['a', 'a', 'b'] }));
  const strip = cellEl.children[0];
  const textInput = strip.children[0].children[1];

  textInput.value = 'w';
  textInput.dispatchEvent({ type: 'change' });
  await wait(200);

  assert.deepStrictEqual(runCellCalls.slice().sort(), [3, 4], "['a','a','b'] → nøyaktig én kjøring for 'a'");
});

test('refuse-drop: mens mdIsScriptRunning() er true, forkastes den debouncede reruen (kjøres ikke i ettertid)', async () => {
  const { Ui, cellEl, runCellCalls, setScriptRunning } = freshEnv({ cellIdx: 1, scriptRunning: true });
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'x', value: 'a' }));
  const strip = cellEl.children[0];
  const textInput = strip.children[0].children[1];

  textInput.value = 'b';
  textInput.dispatchEvent({ type: 'change' });
  await wait(200);

  assert.deepStrictEqual(runCellCalls, [], 'skript kjører allerede — reruen droppes, ingen kø');
  setScriptRunning(false);
  // Ingen ny endring skjedde — droppet rerun skal IKKE dukke opp av seg selv.
  await wait(50);
  assert.deepStrictEqual(runCellCalls, []);
});

// ---- button: umiddelbar, ingen debounce -----------------------------------

test('button: klikk → UMIDDELBAR rerun (ingen debounce-ventetid), returnerer null-verdi', () => {
  const { Ui, cellEl, runCellCalls } = freshEnv({ cellIdx: 5 });
  const res = Ui.registerControl(JSON.stringify({ type: 'button', label: 'Kjør nå' }));
  assert.strictEqual(JSON.parse(res), null);

  const strip = cellEl.children[0];
  const btn = strip.children[0];
  assert.strictEqual(btn.textContent, 'Kjør nå');

  btn.dispatchEvent({ type: 'click' });
  assert.deepStrictEqual(runCellCalls, [5], 'ingen ventetid — knapp-klikk kjører umiddelbart');
});

// ---- endCellRun: mark-og-sopp for kontroller som ikke re-registreres -----

test('endCellRun: fjerner kontroller registrert i FORRIGE kjøring men ikke gjenregistrert i DENNE', () => {
  const { Ui, cellEl } = freshEnv({ cellIdx: 0 });
  // Kjøring 1: registrerer 'a' og 'b'.
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'a', value: '1' }));
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'b', value: '2' }));
  Ui.endCellRun(0);
  const strip = cellEl.children[0];
  assert.strictEqual(strip.children.length, 2, 'begge finnes etter kjøring 1 sin egen (tomme) sopp');

  // Kjøring 2: kun 'a' registreres på nytt ('b'-linjen er fjernet fra kilden).
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'a', value: '1' }));
  Ui.endCellRun(0);

  assert.strictEqual(strip.children.length, 1, "'b' ble sopt bort — ikke gjenregistrert i kjøring 2");
});

test('beginCellRun + endCellRun uten NOEN registreringer (reviewer-repro): alle gamle kontroller OG verdiene deres sopes', async () => {
  const { Ui, cellEl } = freshEnv({ cellIdx: 0 });
  // Kjøring 1: registrer en slider, bruker-endre verdien, avslutt.
  Ui.beginCellRun(0);
  Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 0, max: 100, value: 5 }));
  const strip = cellEl.children[0];
  const rangeInput = strip.children[0].children[1];
  rangeInput.value = '42';
  rangeInput.dispatchEvent({ type: 'input' });
  Ui.endCellRun(0);
  assert.strictEqual(strip.children.length, 1, 'slider finnes etter kjøring 1');

  // Kjøring 2: kilden har fjernet ALLE ui.*-kall — kun brakettene fyrer.
  Ui.beginCellRun(0);
  Ui.endCellRun(0);

  assert.strictEqual(strip.children.length, 0,
    'rerun med null registreringer skal sope ALLE gamle kontroller');

  // _values-oppføringen er også borte: en senere gjenregistrering med samme
  // nøkkel skal få spec-defaulten, ikke den gamle lagrede 42.
  Ui.beginCellRun(0);
  const res = Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 0, max: 100, value: 5 }));
  assert.strictEqual(JSON.parse(res), 5, 'verdilager-oppføringen ble slettet av soppen');
  // Flush den løse 150ms-debouncen fra dispatchEvent over (se tilsvarende
  // kommentar i "samme nøkkel re-registrert"-testen).
  await wait(200);
});

test('endCellRun: kalt to ganger på rad for samme celle er idempotent (andre kallet fjerner ingenting nytt)', () => {
  const { Ui, cellEl } = freshEnv({ cellIdx: 0 });
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'a', value: '1' }));
  Ui.endCellRun(0);
  Ui.endCellRun(0); // duplikatkall — skal ikke fjerne 'a'
  const strip = cellEl.children[0];
  assert.strictEqual(strip.children.length, 1, "'a' overlever et duplikat endCellRun-kall");
});

// ---- resetDocument: glemmer alt ------------------------------------------

test('resetDocument: nullstiller verdilager og stripe — neste registrering får spec-default, ikke gammel lagret verdi', async () => {
  const { Ui, cellEl } = freshEnv();
  Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 0, max: 100, value: 3 }));
  const strip = cellEl.children[0];
  const rangeInput = strip.children[0].children[1];
  rangeInput.value = '77';
  rangeInput.dispatchEvent({ type: 'input' });

  // Uten reset: gjenregistrering skal hente den lagrede 77.
  const beforeReset = Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 0, max: 100, value: 3 }));
  assert.strictEqual(JSON.parse(beforeReset), 77);

  Ui.resetDocument();
  assert.strictEqual(cellEl.children.length, 2, 'stripa er fjernet — kun de to opprinnelige barna igjen');

  const afterReset = Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 0, max: 100, value: 3 }));
  assert.strictEqual(JSON.parse(afterReset), 3, 'fersk spec-default, ikke den gamle lagrede verdien 77');
  // Flush den løse debouncen fra dispatchEvent over (se tilsvarende
  // kommentar i "samme nøkkel re-registrert"-testen).
  await wait(200);
});

// ---- byggere: dekning for de resterende kontrolltypene -------------------

test('dropdown: default (første option), select-liste bygget riktig', () => {
  const { Ui, cellEl } = freshEnv();
  const res = Ui.registerControl(JSON.stringify({ type: 'dropdown', name: 'd', options: ['a', 'b', 'c'] }));
  assert.strictEqual(JSON.parse(res), 'a');
  const strip = cellEl.children[0];
  const select = strip.children[0].children[1];
  assert.strictEqual(select.tag, 'select');
  assert.strictEqual(select.children.length, 3);
});

test('checkbox: verdi + endring lagres som boolean', async () => {
  const { Ui, cellEl, runCellCalls } = freshEnv({ cellIdx: 7 });
  const res = Ui.registerControl(JSON.stringify({ type: 'checkbox', name: 'c', value: false }));
  assert.strictEqual(JSON.parse(res), false);
  const strip = cellEl.children[0];
  const checkboxInput = strip.children[0].children[0]; // insertBefore → input er FØRSTE barn
  assert.strictEqual(checkboxInput.type, 'checkbox');

  checkboxInput.checked = true;
  checkboxInput.dispatchEvent({ type: 'change' });
  await wait(200);
  assert.deepStrictEqual(runCellCalls, [7]);
});

test('switch: samme som checkbox men med role="switch" og ui-widget--switch-klasse på wrap', () => {
  const { Ui, cellEl } = freshEnv();
  Ui.registerControl(JSON.stringify({ type: 'switch', name: 's', value: true }));
  const strip = cellEl.children[0];
  const wrap = strip.children[0];
  const switchInput = wrap.children[0];
  assert.strictEqual(switchInput.getAttribute('role'), 'switch');
  assert.strictEqual(switchInput.checked, true);
  assert.ok(wrap.classList.contains('ui-widget--switch'), 'wrap skiller switch fra vanlig checkbox');
  assert.ok(wrap.classList.contains('ui-widget--check'));
});

test('number: verdi og min/max/step overføres til input-elementet', () => {
  const { Ui, cellEl } = freshEnv();
  const res = Ui.registerControl(JSON.stringify({ type: 'number', name: 'n', value: 5, min: 0, max: 10, step: 2 }));
  assert.strictEqual(JSON.parse(res), 5);
  const strip = cellEl.children[0];
  const numInput = strip.children[0].children[1];
  assert.strictEqual(numInput.type, 'number');
  assert.strictEqual(numInput.min, 0);
  assert.strictEqual(numInput.max, 10);
  assert.strictEqual(numInput.step, 2);
});

test('ukjent kontrolltype: registerControl varsler og returnerer null, ingen stripe-endring', () => {
  const { Ui, cellEl } = freshEnv();
  const origWarn = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  let res;
  try {
    res = Ui.registerControl(JSON.stringify({ type: 'radio', name: 'x' }));
  } finally {
    console.warn = origWarn;
  }
  assert.strictEqual(res, null);
  assert.ok(warned >= 1);
  assert.strictEqual(cellEl.children.length, 2, 'ingen stripe opprettet for en avvist spec');
});
