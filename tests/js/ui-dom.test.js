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
  // W5.2: Ui.renderEventResult bruker innerHTML to steder — '' for å tømme
  // en gjenbrukt target-node FØR ny rendering, og som råmarkup-container for
  // table-payloadets ferdig-bygde HTML (samme tillitsnivå/mønster som
  // dash.js sine table-kort). Stubben er minimal: en tom streng nullstiller
  // faktisk children (ekte DOM-semantikk vi trenger for replace-testen),
  // en ikke-tom streng lagres bare rått (ingen HTML-parsing i stubben —
  // testene leser den samme strengen rett tilbake).
  set innerHTML(v) { this._innerHTML = v; if (v === '') this.children = []; }
  get innerHTML() { return this._innerHTML !== undefined ? this._innerHTML : ''; }
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
  // W1-carryover (a): _registerInto fanger nextSibling FØR den fjerner en
  // type-byttet kontroll, for å insertBefore den nye noden på nøyaktig samme
  // plass (i stedet for å appende til slutten av stripa). Ekte DOM-noder har
  // nextSibling innebygd — stubben trenger en tilsvarende, avledet av
  // parentNode sin children-liste (ingen egen tilstand å holde synkron).
  get nextSibling() {
    if (!this._parentNode) return null;
    const idx = this._parentNode.children.indexOf(this);
    if (idx === -1) return null;
    return this._parentNode.children[idx + 1] || null;
  }
  addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
  dispatchEvent(ev) { (this._listeners[ev.type] || []).forEach((fn) => fn(ev)); }
  setAttribute(name, v) { this[name] = v; }
  getAttribute(name) { return this[name]; }
  // N3-fiksen (final-review): ui.js sin _updateControlSpec fjerner nå
  // min/max/step via removeAttribute når ny spec utelater dem — den ekte
  // DOM-en trenger dette (IDL-reflekterte attributter, tildeling av null/''
  // fjerner dem ikke pålitelig), og stubben må derfor ha en ekte
  // removeAttribute (ikke bare set/get) for at N3-testen skal bevise noe.
  removeAttribute(name) { delete this[name]; }
  // W5.2: ui.js sin delegerte dokument-lytter bruker e.target.closest(selector)
  // for å finne treffet element — minimal '#id'/'.klasse'/tagnavn-matching,
  // ingen ekte selektor-motor (samme minimalisme-filosofi som resten av
  // stubben; bindingenes selectors i testene er alltid enkle '#id'-former).
  closest(selector) {
    let node = this;
    while (node) {
      if (_matchesSelector(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
}

function _matchesSelector(node, selector) {
  if (!node || !selector) return false;
  if (selector[0] === '#') return node.id === selector.slice(1);
  if (selector[0] === '.') return !!(node.classList && node.classList.contains(selector.slice(1)));
  return node.tag === selector;
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
  // W5.2: element-event-bindingene trenger litt mer av `document` enn
  // kontroll-halvdelen gjorde — en EventTarget-lignende
  // addEventListener/dispatchEvent-pardans for den delegerte lytteren
  // (Ui.bindEvent/bindRunCell installerer ÉN document-lytter per
  // eventType), getElementById (target-oppslag i Ui.renderEventResult) og
  // et `head`-element (script-injeksjon i _renderFigure sin dash.js-
  // lasting).
  global.document = {
    createElement: (tag) => new FakeEl(tag),
    head: new FakeEl('head'),
    _idIndex: {},
    getElementById(id) { return this._idIndex[id] || null; },
    _listeners: {},
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
  };
  delete global.Dash;

  const cellEl = new FakeEl('div');
  cellEl.className = 'nb-cell';
  const inputEl = new FakeEl('div');
  inputEl.className = 'nb-input';
  const outEl = new FakeEl('div');
  outEl.className = 'nb-output';
  // Widget-plassering-fasen: .nb-output er en WRAPPER — js/cells.js sin
  // cellNode setter alltid inn .nb-output-body som barn FØR noen striper
  // finnes. _ensureStrip (js/ui.js) setter .ui-controls inn INNI outEl, rett
  // FØR bodyEl — speiler den ekte DOM-strukturen.
  const bodyEl = new FakeEl('div');
  bodyEl.className = 'nb-output-body';
  outEl.appendChild(bodyEl);
  cellEl.appendChild(inputEl);
  cellEl.appendChild(outEl);

  // Fase 3 (Task 1): doc-konteksten (rent skript) sin vert er #outputArea,
  // ikke en celles .nb-output — stubbet her, samme mønster som cellEl over,
  // slik at ALLE tester (ikke bare doc-ctx-spesifikke) kan finne den via
  // document.getElementById('outputArea') uten egen oppsett.
  const outputAreaEl = new FakeEl('div');
  outputAreaEl.id = 'outputArea';
  global.document._idIndex.outputArea = outputAreaEl;

  const cellIdx = opts.cellIdx != null ? opts.cellIdx : 0;
  let ctx;
  if (opts.ctxNull) ctx = null;
  else if (opts.docCtx) ctx = { cellIdx: null, cellEl: null, doc: true };
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
    // registerFromRegistry/valuesForCell (W2, Task 1) drives cellEl-oppslag
    // og cellKey-utledning via disse to i stedet for mdUiRunCtx() — enkel
    // default her: samme cellEl for den ene stubbede cellIdx-en, cellKeyAt
    // faller tilbake til String(idx) (samme som ui.js sin egen fallback når
    // Cells mangler helt). Enkelttester overstyrer disse direkte på
    // global.Cells når scenarioet (f.eks. et indeksskift) krever det.
    cellElementAt: (idx) => (idx === cellIdx ? cellEl : null),
    cellKeyAt: (idx) => String(idx),
  };
  global.mdIsScriptRunning = () => !!opts.scriptRunning;

  const Ui = require(UI_PATH);

  return {
    Ui, cellEl, inputEl, outEl, bodyEl, outputAreaEl, runCellCalls,
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

test('registerControl: oppretter .ui-controls INNI .nb-output (FØR .nb-output-body), returnerer spec-default (widget-plassering-fasen)', () => {
  const { Ui, cellEl, inputEl, outEl, bodyEl } = freshEnv();
  const res = Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 0, max: 10, value: 5 }));
  assert.strictEqual(JSON.parse(res), 5);

  assert.strictEqual(cellEl.children.length, 2, '.nb-cell selv er urørt — stripa lever inni .nb-output');
  assert.strictEqual(cellEl.children[0], inputEl);
  assert.strictEqual(cellEl.children[1], outEl);
  assert.strictEqual(outEl.children.length, 2, 'stripe + .nb-output-body');
  assert.strictEqual(outEl.children[0].className, 'ui-controls', 'stripa er FØRSTE barn i .nb-output, FØR body');
  assert.strictEqual(outEl.children[1], bodyEl, '.nb-output-body uendret, nå etter stripa');

  const strip = outEl.children[0];
  assert.strictEqual(strip.children.length, 1, 'ett kontrollelement i stripa');
});

test('registerControl: samme nøkkel re-registrert → returnerer LAGRET verdi, SAMME DOM-node (ingen ombygging)', async () => {
  const { Ui, cellEl, outEl } = freshEnv();
  Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 0, max: 100, value: 5 }));
  const strip = outEl.children[0];
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
  const { Ui, cellEl, outEl } = freshEnv();
  const first = Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 0, max: 100, value: 10 }));
  assert.strictEqual(JSON.parse(first), 10);

  const second = Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 50, max: 100, value: 10 }));
  assert.strictEqual(JSON.parse(second), 50, 'lagret verdi 10 er under ny min 50 — klampes opp');

  const strip = outEl.children[0];
  const rangeInput = strip.children[0].children[1];
  assert.strictEqual(Number(rangeInput.value), 50, 'DOM-noden reflekterer den klampede verdien');
});

// ---- B2 (final-review): type-bytte under samme nøkkel bygger på nytt -----

test('registerControl: type-bytte slider→dropdown under SAMME nøkkel bygger en fersk select-node (ikke option-noder inni range-input)', () => {
  const { Ui, cellEl, outEl } = freshEnv();
  Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 0, max: 100, value: 5 }));
  const strip = outEl.children[0];
  const oldWidget = strip.children[0];
  const oldInput = oldWidget.children[1];
  assert.strictEqual(oldInput.type, 'range');

  const res = Ui.registerControl(JSON.stringify({ type: 'dropdown', name: 'x', options: ['a', 'b'] }));
  assert.strictEqual(JSON.parse(res), 'a', 'fersk dropdown-default, ikke noe restet fra slideren');
  assert.strictEqual(strip.children.length, 1, 'gammel node fjernet OG ny lagt til — ingen dobling');

  const newWidget = strip.children[0];
  assert.notStrictEqual(newWidget, oldWidget, 'helt ny wrap-node, ikke den gamle mutert');
  const select = newWidget.children[1];
  assert.strictEqual(select.tag, 'select', 'select-node — ikke range-input gjenbrukt med <option>-barn presset inn');
  assert.strictEqual(select.children.length, 2, 'select har options-listen, ren');
});

test('registerControl: type-bytte slider→button under SAMME nøkkel gir en fungerende knapp (klikk fyrer rerun)', async () => {
  const { Ui, cellEl, outEl, runCellCalls } = freshEnv({ cellIdx: 9 });
  Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 0, max: 100, value: 5 }));
  Ui.registerControl(JSON.stringify({ type: 'button', name: 'x', label: 'Kjør' }));

  const strip = outEl.children[0];
  assert.strictEqual(strip.children.length, 1, 'slider-wrapen er fjernet, kun knappen står igjen');
  const btn = strip.children[0];
  assert.strictEqual(btn.tag, 'button');
  assert.strictEqual(btn.textContent, 'Kjør');

  btn.dispatchEvent({ type: 'click' });
  // B3-fiksen gjør selve Cells.runCell-kallet ett mikrotask unna (se
  // kommentaren i "button: klikk → UMIDDELBAR rerun"-testen over).
  await Promise.resolve();
  assert.deepStrictEqual(runCellCalls, [9], 'knappen virker etter type-byttet — ingen gutta slider-wrap igjen i veien');
});

// ---- endring → debounce → rerun -------------------------------------------

test("change → lagrer umiddelbart, kjører Cells.runCell('self'-cellIdx) etter 150ms debounce", async () => {
  const { Ui, cellEl, outEl, runCellCalls } = freshEnv({ cellIdx: 2 });
  Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 0, max: 100, value: 5 }));
  const strip = outEl.children[0];
  const rangeInput = strip.children[0].children[1];

  rangeInput.value = '77';
  rangeInput.dispatchEvent({ type: 'input' });

  assert.strictEqual(runCellCalls.length, 0, 'ingen umiddelbar kjøring — debouncet');
  await wait(200);
  assert.deepStrictEqual(runCellCalls, [2], 'debouncet rerun av den deklarerende cellen (idx 2)');
});

test("rerun: 'none' lagrer verdien men trigger ALDRI en rerun", async () => {
  const { Ui, cellEl, outEl, runCellCalls } = freshEnv({ cellIdx: 3 });
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'x', value: 'a', rerun: 'none' }));
  const strip = outEl.children[0];
  const textInput = strip.children[0].children[1];

  textInput.value = 'b';
  textInput.dispatchEvent({ type: 'change' });
  await wait(200);

  assert.deepStrictEqual(runCellCalls, [], "rerun:'none' skal aldri kjøre noe");
  const again = Ui.registerControl(JSON.stringify({ type: 'text', name: 'x', value: 'a', rerun: 'none' }));
  assert.strictEqual(JSON.parse(again), 'b', 'men verdien ER lagret');
});

test('rerun: ukjent id-mål → console.warn + hoppes over (ingen kjøring)', async () => {
  const { Ui, cellEl, outEl, runCellCalls } = freshEnv({ idMap: {} });
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'x', value: 'a', rerun: 'nope' }));
  const strip = outEl.children[0];
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
  const { Ui, cellEl, outEl, runCellCalls } = freshEnv({ idMap: { a: 3, b: 4 } });
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'x', value: 'v', rerun: ['a', 'b'] }));
  const strip = outEl.children[0];
  const textInput = strip.children[0].children[1];

  textInput.value = 'w';
  textInput.dispatchEvent({ type: 'change' });
  await wait(200);

  assert.deepStrictEqual(runCellCalls.slice().sort(), [3, 4]);
});

test('rerun: duplikat-id-er i array dedupes — én kjøring per unik målcelle', async () => {
  const { Ui, cellEl, outEl, runCellCalls } = freshEnv({ idMap: { a: 3, b: 4 } });
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'x', value: 'v', rerun: ['a', 'a', 'b'] }));
  const strip = outEl.children[0];
  const textInput = strip.children[0].children[1];

  textInput.value = 'w';
  textInput.dispatchEvent({ type: 'change' });
  await wait(200);

  assert.deepStrictEqual(runCellCalls.slice().sort(), [3, 4], "['a','a','b'] → nøyaktig én kjøring for 'a'");
});

// B3-fiksen (final-review): mdRunNotebookCell (index.html) setter
// scriptRunInProgress SYNKRONT ved oppstart, akkurat som denne fake
// runCell simulerer med `busy` under — før fiksen fyrte _rerunFor et
// synkront forEach av global.Cells.runCell(idx) for HVERT mål i
// rerun:['a','b',…], så mål nr. 2 startet mens mål nr. 1 fortsatt "kjørte"
// og ville i den ekte koden ha blitt refuse-droppet av nøyaktig denne typen
// vakt. Nå kjøres målene i SERIE (Cells.runCell returnerer alltid et
// promise) — testen bekrefter at mål 4 ikke starter før mål 3 er HELT
// ferdig.
test('rerun: flermåls-array kjøres SERIELT — mål 2 venter til mål 1 er helt ferdig (B3, final-review)', async () => {
  const { Ui, cellEl, outEl } = freshEnv({ idMap: { a: 3, b: 4 } });
  const order = [];
  let busy = false;
  global.Cells.runCell = (idx) => {
    assert.strictEqual(busy, false, 'mål ' + idx + ' startet mens et tidligere mål fortsatt kjørte — ikke serielt');
    busy = true;
    order.push('start:' + idx);
    return new Promise((resolve) => {
      setTimeout(() => {
        order.push('end:' + idx);
        busy = false;
        resolve();
      }, 20);
    });
  };

  Ui.registerControl(JSON.stringify({ type: 'text', name: 'x', value: 'v', rerun: ['a', 'b'] }));
  const strip = outEl.children[0];
  const textInput = strip.children[0].children[1];

  textInput.value = 'w';
  textInput.dispatchEvent({ type: 'change' });
  await wait(250);

  assert.deepStrictEqual(order, ['start:3', 'end:3', 'start:4', 'end:4'],
    'mål 4 (id b) venter til mål 3 (id a) er helt ferdig FØR det starter');
});

test('refuse-drop: mens mdIsScriptRunning() er true, forkastes den debouncede reruen (kjøres ikke i ettertid)', async () => {
  const { Ui, cellEl, outEl, runCellCalls, setScriptRunning } = freshEnv({ cellIdx: 1, scriptRunning: true });
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'x', value: 'a' }));
  const strip = outEl.children[0];
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

test('button: klikk → UMIDDELBAR rerun (ingen debounce-ventetid), returnerer null-verdi', async () => {
  const { Ui, cellEl, outEl, runCellCalls } = freshEnv({ cellIdx: 5 });
  const res = Ui.registerControl(JSON.stringify({ type: 'button', label: 'Kjør nå' }));
  assert.strictEqual(JSON.parse(res), null);

  const strip = outEl.children[0];
  const btn = strip.children[0];
  assert.strictEqual(btn.textContent, 'Kjør nå');

  btn.dispatchEvent({ type: 'click' });
  // B3-fiksen (final-review): _rerunFor kjører nå targets via
  // Promise.resolve().then(...) (serialisering, se B3-kommentaren i
  // js/ui.js) i stedet for et synkront forEach — INGEN 150ms-debounce
  // fortsatt (det er poenget testnavnet dekker), men selve Cells.runCell-
  // kallet skjer nå ett mikrotask unna, ikke i samme synkrone tikk som
  // dispatchEvent. En tom `await` flusher akkurat den ene mikrotasken.
  await Promise.resolve();
  assert.deepStrictEqual(runCellCalls, [5], 'ingen debounce-ventetid — knapp-klikk kjører uten 150ms-forsinkelse');
});

// ---- endCellRun: mark-og-sopp for kontroller som ikke re-registreres -----

test('endCellRun: fjerner kontroller registrert i FORRIGE kjøring men ikke gjenregistrert i DENNE', () => {
  const { Ui, cellEl, outEl } = freshEnv({ cellIdx: 0 });
  // Kjøring 1: registrerer 'a' og 'b'.
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'a', value: '1' }));
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'b', value: '2' }));
  Ui.endCellRun(0);
  const strip = outEl.children[0];
  assert.strictEqual(strip.children.length, 2, 'begge finnes etter kjøring 1 sin egen (tomme) sopp');

  // Kjøring 2: kun 'a' registreres på nytt ('b'-linjen er fjernet fra kilden).
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'a', value: '1' }));
  Ui.endCellRun(0);

  assert.strictEqual(strip.children.length, 1, "'b' ble sopt bort — ikke gjenregistrert i kjøring 2");
});

test('beginCellRun + endCellRun uten NOEN registreringer (reviewer-repro): alle gamle kontroller OG verdiene deres sopes', async () => {
  const { Ui, cellEl, outEl } = freshEnv({ cellIdx: 0 });
  // Kjøring 1: registrer en slider, bruker-endre verdien, avslutt.
  Ui.beginCellRun(0);
  Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 0, max: 100, value: 5 }));
  const strip = outEl.children[0];
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
  const { Ui, cellEl, outEl } = freshEnv({ cellIdx: 0 });
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'a', value: '1' }));
  Ui.endCellRun(0);
  Ui.endCellRun(0); // duplikatkall — skal ikke fjerne 'a'
  const strip = outEl.children[0];
  assert.strictEqual(strip.children.length, 1, "'a' overlever et duplikat endCellRun-kall");
});

// ---- resetDocument: glemmer alt ------------------------------------------

test('resetDocument: nullstiller verdilager og stripe — neste registrering får spec-default, ikke gammel lagret verdi', async () => {
  const { Ui, cellEl, outEl } = freshEnv();
  Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 0, max: 100, value: 3 }));
  const strip = outEl.children[0];
  const rangeInput = strip.children[0].children[1];
  rangeInput.value = '77';
  rangeInput.dispatchEvent({ type: 'input' });

  // Uten reset: gjenregistrering skal hente den lagrede 77.
  const beforeReset = Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 0, max: 100, value: 3 }));
  assert.strictEqual(JSON.parse(beforeReset), 77);

  Ui.resetDocument();
  assert.strictEqual(cellEl.children.length, 2, '.nb-cell selv uendret (input+output)');
  assert.strictEqual(outEl.children.length, 1, 'stripa er fjernet — kun .nb-output-body igjen i .nb-output');

  const afterReset = Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 0, max: 100, value: 3 }));
  assert.strictEqual(JSON.parse(afterReset), 3, 'fersk spec-default, ikke den gamle lagrede verdien 77');
  // Flush den løse debouncen fra dispatchEvent over (se tilsvarende
  // kommentar i "samme nøkkel re-registrert"-testen).
  await wait(200);
});

// ---- byggere: dekning for de resterende kontrolltypene -------------------

test('dropdown: default (første option), select-liste bygget riktig', () => {
  const { Ui, cellEl, outEl } = freshEnv();
  const res = Ui.registerControl(JSON.stringify({ type: 'dropdown', name: 'd', options: ['a', 'b', 'c'] }));
  assert.strictEqual(JSON.parse(res), 'a');
  const strip = outEl.children[0];
  const select = strip.children[0].children[1];
  assert.strictEqual(select.tag, 'select');
  assert.strictEqual(select.children.length, 3);
});

test('checkbox: verdi + endring lagres som boolean', async () => {
  const { Ui, cellEl, outEl, runCellCalls } = freshEnv({ cellIdx: 7 });
  const res = Ui.registerControl(JSON.stringify({ type: 'checkbox', name: 'c', value: false }));
  assert.strictEqual(JSON.parse(res), false);
  const strip = outEl.children[0];
  const checkboxInput = strip.children[0].children[0]; // insertBefore → input er FØRSTE barn
  assert.strictEqual(checkboxInput.type, 'checkbox');

  checkboxInput.checked = true;
  checkboxInput.dispatchEvent({ type: 'change' });
  await wait(200);
  assert.deepStrictEqual(runCellCalls, [7]);
});

test('switch: samme som checkbox men med role="switch" og ui-widget--switch-klasse på wrap', () => {
  const { Ui, cellEl, outEl } = freshEnv();
  Ui.registerControl(JSON.stringify({ type: 'switch', name: 's', value: true }));
  const strip = outEl.children[0];
  const wrap = strip.children[0];
  const switchInput = wrap.children[0];
  assert.strictEqual(switchInput.getAttribute('role'), 'switch');
  assert.strictEqual(switchInput.checked, true);
  assert.ok(wrap.classList.contains('ui-widget--switch'), 'wrap skiller switch fra vanlig checkbox');
  assert.ok(wrap.classList.contains('ui-widget--check'));
});

test('number: verdi og min/max/step overføres til input-elementet', () => {
  const { Ui, cellEl, outEl } = freshEnv();
  const res = Ui.registerControl(JSON.stringify({ type: 'number', name: 'n', value: 5, min: 0, max: 10, step: 2 }));
  assert.strictEqual(JSON.parse(res), 5);
  const strip = outEl.children[0];
  const numInput = strip.children[0].children[1];
  assert.strictEqual(numInput.type, 'number');
  assert.strictEqual(numInput.min, 0);
  assert.strictEqual(numInput.max, 10);
  assert.strictEqual(numInput.step, 2);
});

// N3-fiksen (final-review): _updateControlSpec fjerner nå min/max/step via
// removeAttribute når en re-registrering UTELATER dem — før fiksen ble de
// bare ikke oppdatert, så en tidligere kjørings min=0/max=10/step=2 ble
// hengende igjen som en STALE begrensning selv etter at kilden fjernet dem
// fra ui.number(...)-kallet.
test('number: re-registrering UTEN min/max/step fjerner tidligere attributter (N3, final-review)', () => {
  const { Ui, cellEl, outEl } = freshEnv();
  Ui.registerControl(JSON.stringify({ type: 'number', name: 'n', value: 5, min: 0, max: 10, step: 2 }));
  const strip = outEl.children[0];
  const numInput = strip.children[0].children[1];
  assert.strictEqual(numInput.min, 0);
  assert.strictEqual(numInput.max, 10);
  assert.strictEqual(numInput.step, 2);

  Ui.registerControl(JSON.stringify({ type: 'number', name: 'n', value: 5 }));
  assert.strictEqual(numInput.min, undefined, 'min-attributt fjernet, ikke stale 0');
  assert.strictEqual(numInput.max, undefined, 'max-attributt fjernet, ikke stale 10');
  assert.strictEqual(numInput.step, undefined, 'step-attributt fjernet, ikke stale 2');
});

test('ukjent kontrolltype: registerControl varsler og returnerer null, ingen stripe-endring', () => {
  const { Ui, cellEl, outEl } = freshEnv();
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
  assert.strictEqual(cellEl.children.length, 2, '.nb-cell uendret');
  assert.strictEqual(outEl.children.length, 1, 'ingen stripe opprettet i .nb-output for en avvist spec');
});

// ============================================================================
// W2 Task 1: registerFromRegistry, valuesForCell, cellKey-stabilitet,
// W1-carryover-polering (insertBefore-posisjon, reduce-catch).
// ============================================================================

// ---- registerFromRegistry: bulk-registrering fra et JSON-array -----------

test('registerFromRegistry: renderer N kontroller fra ett JSON-array, gjenbruker lagret verdi, sopper stale ved neste kall', async () => {
  const { Ui, cellEl, outEl } = freshEnv({ cellIdx: 6 });
  Ui.registerFromRegistry(6, JSON.stringify([
    { type: 'slider', name: 'a', min: 0, max: 10, value: 3 },
    { type: 'text', name: 'b', value: 'hei' },
    { type: 'checkbox', name: 'c', value: true },
  ]));
  const strip = outEl.children[0];
  assert.strictEqual(strip.children.length, 3, 'tre kontroller rendret fra registryet');

  // Simuler brukerendring på slideren ('a') via UI — lagres umiddelbart.
  const rangeInput = strip.children[0].children[1];
  rangeInput.value = '7';
  rangeInput.dispatchEvent({ type: 'input' });
  await wait(200);

  // Andre kall (R-cellen kjørte på nytt, kilden kaller nå kun ui_slider):
  // 'a' skal gjenbruke lagret verdi 7 (ikke spec-default 3); 'b' og 'c' er
  // borte fra registryet → sopes akkurat som pyodide-veiens mark-og-sopp.
  Ui.registerFromRegistry(6, JSON.stringify([
    { type: 'slider', name: 'a', min: 0, max: 10, value: 3 },
  ]));
  assert.strictEqual(strip.children.length, 1, "'b' og 'c' sopt bort, kun 'a' igjen");
  const values = JSON.parse(Ui.valuesForCell(6));
  assert.deepStrictEqual(values, { a: 7 }, 'lagret verdi 7 gjenbrukt, ikke spec-default 3');
});

test('registerFromRegistry: null/ugyldig spec i arrayet varsler og hoppes over, resten registreres', () => {
  const { Ui, cellEl, outEl } = freshEnv({ cellIdx: 1 });
  const origWarn = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  try {
    Ui.registerFromRegistry(1, JSON.stringify([
      { type: 'text', name: 'ok', value: 'hei' },
      { type: 'unknowntype', name: 'bad' },
    ]));
  } finally {
    console.warn = origWarn;
  }
  const strip = outEl.children[0];
  assert.strictEqual(strip.children.length, 1, 'kun den gyldige kontrollen ble rendret');
  assert.ok(warned >= 1, 'console.warn kalt for den forkastede specen');
});

test('registerFromRegistry: ugyldig JSON → console.warn, ingen krasj', () => {
  const { Ui } = freshEnv({ cellIdx: 1 });
  const origWarn = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  try {
    assert.doesNotThrow(() => Ui.registerFromRegistry(1, '{not json'));
  } finally {
    console.warn = origWarn;
  }
  assert.ok(warned >= 1);
});

test('registerFromRegistry: specsJson er ikke et array → console.warn, ingen krasj', () => {
  const { Ui } = freshEnv({ cellIdx: 1 });
  const origWarn = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  try {
    assert.doesNotThrow(() => Ui.registerFromRegistry(1, JSON.stringify({ type: 'text' })));
  } finally {
    console.warn = origWarn;
  }
  assert.ok(warned >= 1);
});

test('registerFromRegistry: Cells.cellElementAt finner ingen node → no-op, ingen krasj', () => {
  const { Ui } = freshEnv({ cellIdx: 2 });
  global.Cells.cellElementAt = () => null;
  assert.doesNotThrow(() => {
    Ui.registerFromRegistry(2, JSON.stringify([{ type: 'text', name: 'a', value: '1' }]));
  });
});

// ---- valuesForCell: navn-keyet verdi-eksport ------------------------------

test('valuesForCell: JSON-objekt keyet på kontrollnavnet ALENE (uten celle-prefiks) — R sitt .ui_values-format', () => {
  const { Ui } = freshEnv({ cellIdx: 8 });
  Ui.registerFromRegistry(8, JSON.stringify([
    { type: 'number', name: 'n', value: 7 },
    { type: 'text', name: 'w0', value: 'a' },
    { type: 'button', name: 'go', label: 'Kjør' },
  ]));
  const values = JSON.parse(Ui.valuesForCell(8));
  assert.deepStrictEqual(values, { n: 7, w0: 'a' }, 'button har ingen lagret verdi og er derfor ekskludert');
});

test('valuesForCell: celle uten registrerte kontroller → tomt objekt', () => {
  const { Ui } = freshEnv({ cellIdx: 3 });
  assert.deepStrictEqual(JSON.parse(Ui.valuesForCell(3)), {});
});

// ---- W2-carryover (d): id-stabil nøkkel overlever et indeksskift ---------

test('id-stabil nøkkel: kontrollverdi overlever et strukturelt indeksskift (Cells.cellKeyAt styrer nøkkelen, ikke råindeksen)', async () => {
  const { Ui, cellEl, outEl, setCtx } = freshEnv({ cellIdx: 2 });
  // Samme stabile id ('mycell') uansett hvilken råindeks cellen står på —
  // simulerer Cells.cellKeyAt sin attrs.id-gren for en id-tagget celle.
  global.Cells.cellKeyAt = () => 'mycell';
  global.Cells.cellElementAt = () => cellEl;

  const first = Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 0, max: 100, value: 5 }));
  assert.strictEqual(JSON.parse(first), 5);

  const strip = outEl.children[0];
  const rangeInput = strip.children[0].children[1];
  rangeInput.value = '77';
  rangeInput.dispatchEvent({ type: 'input' });
  await wait(200);

  // Cellen "flytter" til råindeks 5 (en celle satt inn over den et sted) —
  // ctx.cellIdx endres, men den stabile cellKey-en ('mycell') er den samme.
  setCtx({ cellIdx: 5, cellEl: cellEl });
  const second = Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 0, max: 100, value: 5 }));
  assert.strictEqual(JSON.parse(second), 77,
    'lagret verdi 77 overlever indeksskiftet — ikke spec-defaulten 5, selv om råindeksen (2→5) endret seg');
});

test('registerFromRegistry: id-stabil nøkkel overlever indeksskift (register cellKey "mycell" ved idx 2, re-registrer samme nøkkel ved idx 5)', () => {
  const { Ui, cellEl: cellEl2, outEl } = freshEnv({ cellIdx: 2 });
  const cellEl5 = cellEl2; // samme underliggende DOM-node gjenbrukt for enkelhets skyld i denne stubben
  global.Cells.cellKeyAt = () => 'mycell';
  global.Cells.cellElementAt = (idx) => (idx === 2 || idx === 5 ? cellEl5 : null);

  Ui.registerFromRegistry(2, JSON.stringify([{ type: 'number', name: 'n', value: 1 }]));
  let values = JSON.parse(Ui.valuesForCell(2));
  assert.deepStrictEqual(values, { n: 1 });

  // Brukeren endret ALDRI verdien her (registerFromRegistry setter kun
  // spec-defaulten ved første registrering) — re-registrer under samme
  // stabile nøkkel ('mycell') på en NY råindeks (5): verdien 1 skal
  // fortsatt være der (lagret på cellKey, ikke på råindeksen 2).
  Ui.registerFromRegistry(5, JSON.stringify([{ type: 'number', name: 'n', value: 1 }]));
  values = JSON.parse(Ui.valuesForCell(5));
  assert.deepStrictEqual(values, { n: 1 }, 'verdien overlevde re-registrering under samme cellKey på ny råindeks');
  // valuesForCell(2) skal gi SAMME resultat (nøkkelen er cellKey-basert, ikke råindeks-basert).
  assert.deepStrictEqual(JSON.parse(Ui.valuesForCell(2)), { n: 1 });
});

test('idx-mismatch + type-bytte: slettet verdi når type endres over indeksskift (slider val 7 ved idx 2 → dropdown ved idx 5)', async () => {
  const { Ui, cellEl: cellEl2, outEl, setCtx } = freshEnv({ cellIdx: 2 });
  const cellEl5 = cellEl2;
  global.Cells.cellKeyAt = () => 'x';
  global.Cells.cellElementAt = (idx) => (idx === 2 || idx === 5 ? cellEl5 : null);

  // Registrer slider ved idx 2, bruker endrer til verdi 7
  Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 0, max: 100, value: 5 }));
  const uiControlsStrips = () => outEl.children.filter((c) => c.classList.contains('ui-controls'));
  let strip = uiControlsStrips()[0];
  const sliderInput = strip.children[0].children[1];
  sliderInput.value = '7';
  sliderInput.dispatchEvent({ type: 'input' });
  await wait(200);

  // "Cellen flytter" fra idx 2 til idx 5 (strukturelt indeksskift) OG type endrer fra slider til dropdown
  setCtx({ cellIdx: 5, cellEl: cellEl5 });
  const res = Ui.registerControl(JSON.stringify({ type: 'dropdown', name: 'x', options: ['a', 'b', 'c'] }));

  // Verdien skal være dropdown-defaulten ('a'), IKKE den gamle slider-verdien 7
  assert.strictEqual(JSON.parse(res), 'a', 'dropdown default, ikke stale slider-verdi 7 fra idx-mismatch-scenarioet');

  // Hent den OPPDATERTE stripa: _ensureStrip bygger en FRISK .ui-controls for
  // den (ukjente) nye cellIdx-nøkkelen 5 og setter den inn rett FØR
  // .nb-output-body (widget-plassering-fasen — IKKE lenger cellEl.firstChild,
  // se js/ui.js) — altså SISTE .ui-controls-barn i .nb-output (den
  // idx-2-stripa som ble værende igjen fysisk, siden idx-nøkkelen endret
  // seg, sitter fortsatt FØR den, et forhold som allerede fantes i den
  // eldre cellEl-firstChild-koden også).
  const strips = uiControlsStrips();
  strip = strips[strips.length - 1];
  assert.strictEqual(strip.children.length, 1, 'stripa har kun den nye dropdown-kontrollen');
  const newWidget = strip.children[0];
  const select = newWidget.children[1];
  assert.strictEqual(select.tag, 'select', 'ny dropdown-kontroll opprettet');
});

// ---- W1-carryover (a): type-bytte beholder ORIGINAL stripe-posisjon ------

test('type-bytte (B2) beholder ORIGINAL stripe-posisjon — insertBefore på gammel plass, ikke append til slutt (W1-carryover a)', () => {
  const { Ui, cellEl, outEl } = freshEnv({ cellIdx: 0 });
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'a', value: '1' }));
  Ui.registerControl(JSON.stringify({ type: 'slider', name: 'b', min: 0, max: 10, value: 5 }));
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'c', value: '3' }));
  const strip = outEl.children[0];
  assert.strictEqual(strip.children.length, 3, 'tre kontroller (a, b, c) i rekkefølge');

  // Bytt type på den MIDTERSTE kontrollen (b: slider → dropdown) — skal
  // fortsatt stå i midten etterpå, ikke hoppe til slutten av stripa.
  const res = Ui.registerControl(JSON.stringify({ type: 'dropdown', name: 'b', options: ['x', 'y'] }));
  assert.strictEqual(JSON.parse(res), 'x');
  assert.strictEqual(strip.children.length, 3, 'fortsatt tre kontroller, ingen dobling');
  const middleSelect = strip.children[1].children[1];
  assert.strictEqual(middleSelect.tag, 'select', 'midterste plass har nå b sitt nye dropdown-input');

  const firstInput = strip.children[0].children[1];
  const lastInput = strip.children[2].children[1];
  assert.strictEqual(firstInput.value, '1', 'a er urørt, fortsatt først');
  assert.strictEqual(lastInput.value, '3', 'c er urørt, fortsatt sist');
});

// ---- W1-carryover (b): trailing .catch på _rerunFor sin reduce-kjede ------

test('_rerunFor: reduce-kjeden har en avsluttende .catch — et rerun-mål som kaster SYNKRONT varsler i stedet for en unhandled rejection (W1-carryover b)', async () => {
  const { Ui, cellEl, outEl } = freshEnv({ cellIdx: 4 });
  global.Cells.runCell = () => { throw new Error('boom'); };

  const origWarn = console.warn;
  const warned = [];
  console.warn = (...args) => { warned.push(args); };
  let unhandled = null;
  const onUnhandled = (err) => { unhandled = err; };
  process.on('unhandledRejection', onUnhandled);

  try {
    Ui.registerControl(JSON.stringify({ type: 'text', name: 'x', value: 'a' }));
    const strip = outEl.children[0];
    const textInput = strip.children[0].children[1];
    textInput.value = 'b';
    textInput.dispatchEvent({ type: 'change' });
    await wait(250);
  } finally {
    console.warn = origWarn;
    process.removeListener('unhandledRejection', onUnhandled);
  }

  assert.ok(warned.length >= 1, 'console.warn kalt via reduce-kjedens avsluttende .catch');
  assert.strictEqual(unhandled, null, 'ingen unhandled rejection skal boble ut av _rerunFor');
});

// ---- Task 3: per-kontroll plassering (placement=top|bottom|left) ---------

test('registerControl: placement:"left" havner i den DELTE .nb-strips-left (ikke direkte .ui-controls-barn av .nb-output)', () => {
  const { Ui, outEl } = freshEnv();
  Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 0, max: 10, value: 3, placement: 'left' }));
  const leftWrap = outEl.children.find((c) => c.classList.contains('nb-strips-left'));
  assert.ok(leftWrap, '.nb-strips-left opprettet inni .nb-output');
  assert.ok(!outEl.children.some((c) => c.classList.contains('ui-controls')),
    'ingen .ui-controls direkte i .nb-output — den lever inni sidekolonnen');
  const strip = leftWrap.children.find((c) => c.classList.contains('ui-controls'));
  assert.ok(strip, '.ui-controls inni .nb-strips-left');
  assert.strictEqual(strip.getAttribute('data-pos'), 'left');
  assert.strictEqual(strip.children.length, 1);
});

test('registerControl: placement:"bottom" oppretter en EGEN .ui-controls[data-pos=bottom], adskilt fra en top-stripe', () => {
  const { Ui, outEl } = freshEnv();
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'a', value: '1' }));
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'b', value: '2', placement: 'bottom' }));
  const strips = outEl.children.filter((c) => c.classList.contains('ui-controls'));
  assert.strictEqual(strips.length, 2, 'to separate .ui-controls-noder — én per posisjon');
  const topStrip = strips.find((s) => s.getAttribute('data-pos') === 'top');
  const bottomStrip = strips.find((s) => s.getAttribute('data-pos') === 'bottom');
  assert.ok(topStrip && bottomStrip);
  assert.strictEqual(topStrip.children.length, 1);
  assert.strictEqual(bottomStrip.children.length, 1);
});

test('registerControl: uten egen placement følger cellens widgets=left-default (nb-widgets-left på .nb-output)', () => {
  const { Ui, outEl } = freshEnv();
  outEl.className = 'nb-output nb-widgets-left';
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'a', value: '1' }));
  const leftWrap = outEl.children.find((c) => c.classList.contains('nb-strips-left'));
  assert.ok(leftWrap, 'cellens default (left) brukt — ingen egen placement på kontrollen');
  const strip = leftWrap.children.find((c) => c.classList.contains('ui-controls'));
  assert.ok(strip);
});

test('registerControl: kontrollens EGEN placement overstyrer cellens widgets=bottom-default', () => {
  const { Ui, outEl } = freshEnv();
  outEl.className = 'nb-output nb-widgets-bottom';
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'a', value: '1', placement: 'top' }));
  const strips = outEl.children.filter((c) => c.classList.contains('ui-controls'));
  assert.strictEqual(strips.length, 1);
  assert.strictEqual(strips[0].getAttribute('data-pos'), 'top', 'kontroll-nivå placement vant over cellens bottom-default');
});

test('registerControl: placement-bytte under SAMME nøkkel flytter kontrollen til ny stripe, BEHOLDER lagret verdi, ingen dobling', () => {
  const { Ui, outEl } = freshEnv();
  Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 0, max: 10, value: 3 }));
  // Endre lagret verdi (simulerer et brukerdrag) FØR plassering byttes —
  // no-verdi-tap-kravet testes best når verdien IKKE lenger er spec-defaulten.
  let strip = outEl.children.find((c) => c.classList.contains('ui-controls') && c.getAttribute('data-pos') === 'top');
  const oldInput = strip.children[0].children[1];
  oldInput.value = '7';
  oldInput.dispatchEvent({ type: 'input' });

  const res = Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 0, max: 10, value: 3, placement: 'left' }));
  assert.strictEqual(JSON.parse(res), 7, 'verdien overlever plassering-byttet (samme kontrolltype)');

  const topStrips = outEl.children.filter((c) => c.classList.contains('ui-controls') && c.getAttribute('data-pos') === 'top');
  assert.strictEqual(topStrips.length, 1, 'den gamle top-stripa henger igjen (tom nå), men er IKKE fjernet av seg selv');
  assert.strictEqual(topStrips[0].children.length, 0, 'den gamle wrap-noden er fjernet fra top-stripa — ingen duplikat der');

  const leftWrap = outEl.children.find((c) => c.classList.contains('nb-strips-left'));
  assert.ok(leftWrap, 'ny .nb-strips-left opprettet');
  const leftStrip = leftWrap.children.find((c) => c.classList.contains('ui-controls'));
  assert.ok(leftStrip);
  assert.strictEqual(leftStrip.children.length, 1, 'nøyaktig én kontroll i den nye stripa — ingen dobling');
  const newInput = leftStrip.children[0].children[1];
  assert.strictEqual(Number(newInput.value), 7, 'ny node seedet fra den LAGREDE verdien, ikke spec sin value:3');
});

test('mixed placements i én celle (topp-slider + venstre-dropdown + bunn-knapp) → tre containere populert riktig', async () => {
  const { Ui, outEl, runCellCalls } = freshEnv({ cellIdx: 2 });
  Ui.registerControl(JSON.stringify({ type: 'slider', name: 's', min: 0, max: 10, value: 4 }));
  Ui.registerControl(JSON.stringify({ type: 'dropdown', name: 'd', options: ['a', 'b'], placement: 'left' }));
  Ui.registerControl(JSON.stringify({ type: 'button', name: 'btn', label: 'Kjør', placement: 'bottom' }));

  const topStrip = outEl.children.find((c) => c.classList.contains('ui-controls') && c.getAttribute('data-pos') === 'top');
  const bottomStrip = outEl.children.find((c) => c.classList.contains('ui-controls') && c.getAttribute('data-pos') === 'bottom');
  const leftWrap = outEl.children.find((c) => c.classList.contains('nb-strips-left'));
  assert.ok(topStrip && bottomStrip && leftWrap, 'alle tre containere finnes');

  assert.strictEqual(topStrip.children.length, 1, 'sliderens topp-stripe har ett element');
  assert.strictEqual(topStrip.children[0].children[1].type, 'range');

  const leftStrip = leftWrap.children.find((c) => c.classList.contains('ui-controls'));
  assert.strictEqual(leftStrip.children.length, 1, 'dropdownen sin venstre-stripe har ett element');
  assert.strictEqual(leftStrip.children[0].children[1].tag, 'select');

  assert.strictEqual(bottomStrip.children.length, 1, 'knappens bunn-stripe har ett element');
  const btn = bottomStrip.children[0];
  assert.strictEqual(btn.tag, 'button');
  btn.dispatchEvent({ type: 'click' });
  await Promise.resolve();
  assert.deepStrictEqual(runCellCalls, [2]);
});

test('endCellRun: sopper stale kontroller fra ALLE posisjons-containere samtidig (topp + bunn + venstre)', () => {
  const { Ui, outEl } = freshEnv({ cellIdx: 3 });
  Ui.beginCellRun(3);
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'a', value: '1' }));
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'b', value: '2', placement: 'bottom' }));
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'c', value: '3', placement: 'left' }));
  Ui.endCellRun(3);

  const topStrip = outEl.children.find((c) => c.classList.contains('ui-controls') && c.getAttribute('data-pos') === 'top');
  const bottomStrip = outEl.children.find((c) => c.classList.contains('ui-controls') && c.getAttribute('data-pos') === 'bottom');
  const leftWrap = outEl.children.find((c) => c.classList.contains('nb-strips-left'));
  assert.strictEqual(topStrip.children.length, 1);
  assert.strictEqual(bottomStrip.children.length, 1);
  assert.strictEqual(leftWrap.children.find((c) => c.classList.contains('ui-controls')).children.length, 1);

  // Neste kjøring registrerer KUN "a" (top) — b og c sin kilde forsvant.
  Ui.beginCellRun(3);
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'a', value: '1' }));
  Ui.endCellRun(3);

  assert.strictEqual(topStrip.children.length, 1, 'a står fortsatt');
  assert.strictEqual(bottomStrip.children.length, 0, 'b sopet fra BUNN-stripa');
  assert.strictEqual(leftWrap.children.find((c) => c.classList.contains('ui-controls')).children.length, 0,
    'c sopet fra VENSTRE-stripa');
});

// ---- Final-review BLOCKER: posisjons-skopet stale-sveip i _ensureStrip ----
//
// Reviewer-repro: en celle med kontroller i >=2 posisjoner (mixed
// placements), en F6-strukturell re-rendring (cellEl bytter identitet, SAMME
// cellIdx — begge posisjoners cache-de striper er nå stale samtidig), deretter
// to kjøringer PÅ RAD uten noen ny re-rendring. Feilen (før fiksen): sveipet i
// _ensureStrip slettet _controls-oppføringer for HELE cellIdx-en når KUN én
// posisjon sin stripe var stale — det slo dermed også ut den andre
// posisjonens SAMME-run-oppføring (allerede bygget friskt i sin egen,
// fortsatt gyldige stripe), som dermed ble en levende orphan uten
// _controls-oppføring. Kjøringen ETTER DET fant ingen `existing` for den
// nøkkelen og bygde en ANDRE, duplikat node ved siden av. Fiksen skoper
// sveipet til `cellIdx === cellIdx && placement === pos` — kun DEN stale
// posisjonen sveipes.
function buildFreshCellStruct() {
  const cellEl = new FakeEl('div');
  cellEl.className = 'nb-cell';
  const inputEl = new FakeEl('div');
  inputEl.className = 'nb-input';
  const outEl = new FakeEl('div');
  outEl.className = 'nb-output';
  const bodyEl = new FakeEl('div');
  bodyEl.className = 'nb-output-body';
  outEl.appendChild(bodyEl);
  cellEl.appendChild(inputEl);
  cellEl.appendChild(outEl);
  return { cellEl, outEl, bodyEl };
}

function countTopAndLeft(outEl) {
  const topStrip = outEl.children.find((c) => c.classList.contains('ui-controls') && c.getAttribute('data-pos') === 'top');
  const leftWrap = outEl.children.find((c) => c.classList.contains('nb-strips-left'));
  const leftStrip = leftWrap && leftWrap.children.find((c) => c.classList.contains('ui-controls'));
  return { top: topStrip ? topStrip.children.length : 0, left: leftStrip ? leftStrip.children.length : 0 };
}

test('_ensureStrip: F6 (cellEl-identitetsbytte) etterfulgt av to kjøringer på rad → INGEN duplikat-kontroll i noen posisjon (posisjons-skopet sveip)', () => {
  const { Ui, outEl: outElA, setCtx } = freshEnv({ cellIdx: 0 });

  function runOnce() {
    Ui.beginCellRun(0);
    Ui.registerControl(JSON.stringify({ type: 'slider', name: 'a', min: 0, max: 10, value: 3 }));
    Ui.registerControl(JSON.stringify({ type: 'text', name: 'b', value: 'x', placement: 'left' }));
    Ui.endCellRun(0);
  }

  // Kjøring 1 på cellEl A.
  runOnce();
  assert.deepStrictEqual(countTopAndLeft(outElA), { top: 1, left: 1 }, 'kjøring 1: ett element per posisjon');

  // F6: strukturell re-rendring — cellEl bytter identitet (ny B), samme
  // cellIdx. Begge posisjoners cache-de striper (fra A) er nå stale.
  const B = buildFreshCellStruct();
  setCtx({ cellIdx: 0, cellEl: B.cellEl });

  // Kjøring 2 (rett etter F6) — begge stripene bygges friskt i B.
  runOnce();
  assert.deepStrictEqual(countTopAndLeft(B.outEl), { top: 1, left: 1 }, 'kjøring 2 (post-F6): fortsatt ett element per posisjon');

  // Kjøring 3 — INGEN videre re-rendring. Før fiksen dukket en duplikat opp
  // her (en levende orphan fra kjøring 2 mistet sin _controls-oppføring).
  runOnce();
  assert.deepStrictEqual(countTopAndLeft(B.outEl), { top: 1, left: 1 },
    'kjøring 3: fortsatt ett element per posisjon — ingen duplikat');

  // Kjøring 4, for god måls skyld (reviewer-repro sin egen ekstra runde).
  runOnce();
  assert.deepStrictEqual(countTopAndLeft(B.outEl), { top: 1, left: 1 },
    'kjøring 4: fortsatt ett element per posisjon — ingen duplikat');

  // Én entry per posisjon impliserer også én _controls-oppføring per nøkkel
  // (skulle sveipet slettet en SAMME-run-oppføring uten å fjerne DOM-noden,
  // hadde neste kjøring bygget en ANDRE node ved siden av — nettopp
  // duplikat-symptomet assertene over utelukker).
});

// ---- W5.2: element-events — bindingsregister, delegering, rendering ------
// (spec 2026-07-16-notebook-widget-events). Ui.bindEvent/bindRunCell
// registrerer en binding under en cellekjøring (samme begin/endCellRun-par
// som kontrollene bruker over), Ui.renderEventResult tegner en handler sitt
// payload. Simulerer en ekte klikk-bubbling til dokument-nivå ved å kalle
// document-lytteren direkte (freshEnv sin document-stub har addEventListener
// men ingen ekte bubbling-motor).

function dispatchDocEvent(type, target) {
  const evt = { type, target };
  (global.document._listeners[type] || []).forEach((fn) => fn(evt));
}

test('W5.2: bindEvent registrerer og sveipes ved rerun uten re-deklarasjon', () => {
  const { Ui } = freshEnv({ cellIdx: 0 });
  const knapp = new FakeEl('button');
  knapp.id = 'knapp';
  let calls = 0;

  Ui.beginCellRun(0);
  const ok = Ui.bindEvent(JSON.stringify({ selector: '#knapp', event: 'click' }), () => {
    calls++;
    return '{"kind":"text","text":"hei"}';
  });
  Ui.endCellRun(0);
  assert.strictEqual(ok, true);

  dispatchDocEvent('click', knapp);
  assert.strictEqual(calls, 1, 'handler kalles mens bindingen lever');

  // Rerun som IKKE re-deklarerer bindingen → sveipes.
  Ui.beginCellRun(0);
  Ui.endCellRun(0);

  dispatchDocEvent('click', knapp);
  assert.strictEqual(calls, 1, 'sveipet binding mottar ingen flere dispatch');
});

test('W5.2: destroy kalles på handler med destroy-metode ved sveip', () => {
  const { Ui } = freshEnv({ cellIdx: 0 });
  let destroyed = false;
  const h = () => '{"kind":"text","text":""}';
  h.destroy = () => { destroyed = true; };

  Ui.beginCellRun(0);
  Ui.bindEvent(JSON.stringify({ selector: '#x', event: 'click' }), h);
  Ui.endCellRun(0);

  Ui.beginCellRun(0);
  Ui.endCellRun(0); // sveip — ingen re-deklarasjon i denne kjøringen
  assert.strictEqual(destroyed, true);
});

test('W5.2: bindEvent uten aktiv cellekjøring (plain script) registrerer likevel, cellIdx=null', () => {
  const { Ui } = freshEnv({ ctxNull: true });
  const ok = Ui.bindEvent(JSON.stringify({ selector: '#x', event: 'click' }), () => '{}');
  assert.strictEqual(ok, true, 'i motsetning til registerControl kreves ikke et levende cellEl for en binding');
});

test('W5.2: bindEvent — ctx finnes men cellEl er null (kant-case) registrerer likevel', () => {
  const { Ui } = freshEnv({ cellElNull: true });
  const ok = Ui.bindEvent(JSON.stringify({ selector: '#x', event: 'click' }), () => '{}');
  assert.strictEqual(ok, true);
});

test('W5.2: bindEvent uten mdUiRunCtx-mekanisme i det hele tatt → null', () => {
  const { Ui } = freshEnv({ cellIdx: 0 });
  delete global.mdUiRunCtx;
  const ok = Ui.bindEvent(JSON.stringify({ selector: '#x', event: 'click' }), () => '{}');
  assert.strictEqual(ok, null);
});

test('W5.2: bindEvent — ugyldig JSON eller manglende selector/event → null, console.warn', () => {
  const { Ui } = freshEnv({ cellIdx: 0 });
  assert.strictEqual(Ui.bindEvent('{ugyldig', () => '{}'), null);
  assert.strictEqual(Ui.bindEvent(JSON.stringify({ selector: '#x' }), () => '{}'), null, 'mangler event');
  assert.strictEqual(Ui.bindEvent(JSON.stringify({ selector: '#x', event: 'click' }), 'ikke-en-funksjon'), null);
});

test('W5.2: renderEventResult — text/error/table-kinds rendres i celle-slot (ingen target)', () => {
  const { Ui, bodyEl } = freshEnv({ cellIdx: 0 });
  const b = { cellIdx: 0, target: null };

  Ui.renderEventResult(b, JSON.stringify({ kind: 'text', text: 'hallo' }));
  assert.strictEqual(bodyEl.children.length, 1);
  assert.strictEqual(bodyEl.children[0].tag, 'pre');
  assert.strictEqual(bodyEl.children[0].textContent, 'hallo');

  Ui.renderEventResult(b, JSON.stringify({ kind: 'error', text: 'oi' }));
  assert.strictEqual(bodyEl.children[1].className, 'error');
  assert.strictEqual(bodyEl.children[1].textContent, 'oi');

  Ui.renderEventResult(b, JSON.stringify({ kind: 'table', html: '<table></table>' }));
  assert.strictEqual(bodyEl.children[2].tag, 'div');
  assert.strictEqual(bodyEl.children[2].innerHTML, '<table></table>');
});

test('W5.2: renderEventResult — target-id finnes → erstatter innholdet i DEN (ikke celle-slot)', () => {
  const { Ui, bodyEl } = freshEnv({ cellIdx: 0 });
  const mal = new FakeEl('div');
  mal.id = 'mitt-mal';
  mal.appendChild(new FakeEl('span')); // gammelt innhold som skal tømmes
  global.document._idIndex['mitt-mal'] = mal;

  Ui.renderEventResult({ cellIdx: 0, target: 'mitt-mal' }, JSON.stringify({ kind: 'text', text: 'ny' }));
  assert.strictEqual(mal.children.length, 1, 'gammelt innhold er tømt');
  assert.strictEqual(mal.children[0].textContent, 'ny');
  assert.strictEqual(bodyEl.children.length, 0, 'celle-sloten er urørt — target-noden ble brukt');
});

test('W5.2: renderEventResult — target-id mangler → notis + fallback til celle-slot', () => {
  const { Ui, bodyEl } = freshEnv({ cellIdx: 0 });
  Ui.renderEventResult({ cellIdx: 0, target: 'finnes-ikke' }, JSON.stringify({ kind: 'text', text: 'x' }));
  assert.strictEqual(bodyEl.children.length, 2, 'notis + selve teksten');
  assert.match(bodyEl.children[0].textContent, /finnes-ikke/);
  assert.strictEqual(bodyEl.children[1].textContent, 'x');
});

test('W5.2: renderEventResult — {} (eksplisitt no-op payload) tegner ingenting', () => {
  const { Ui, bodyEl } = freshEnv({ cellIdx: 0 });
  Ui.renderEventResult({ cellIdx: 0, target: null }, '{}');
  assert.strictEqual(bodyEl.children.length, 0);
});

test('W5.2: renderEventResult — cellIdx null (plain-script) faller tilbake til #outputArea', () => {
  const { Ui } = freshEnv({ cellIdx: 0 });
  const outputArea = new FakeEl('div');
  outputArea.id = 'outputArea';
  global.document._idIndex.outputArea = outputArea;

  Ui.renderEventResult({ cellIdx: null, target: null }, JSON.stringify({ kind: 'text', text: 'plain' }));
  assert.strictEqual(outputArea.children.length, 1);
  assert.strictEqual(outputArea.children[0].textContent, 'plain');
});

test('W5.2: renderEventResult figur — Dash allerede lastet: bruker Dash.renderPayload direkte', () => {
  const { Ui, bodyEl } = freshEnv({ cellIdx: 0 });
  const figNode = new FakeEl('div');
  figNode.className = 'dash-figure';
  global.Dash = {
    renderPayload: (p) => {
      assert.strictEqual(p.kind, 'figure');
      assert.deepStrictEqual(p.spec, { data: [] });
      return figNode;
    },
  };
  Ui.renderEventResult({ cellIdx: 0, target: null }, JSON.stringify({ kind: 'figure', spec: { data: [] } }));
  assert.strictEqual(bodyEl.children[0], figNode);
});

test('W5.2: renderEventResult figur — Dash mangler: laster js/dash.js lazy (memoized <script>), feil ved lasting gir tekstnotis', async () => {
  const { Ui, bodyEl } = freshEnv({ cellIdx: 0 });

  Ui.renderEventResult({ cellIdx: 0, target: null }, JSON.stringify({ kind: 'figure', spec: {} }));

  const script = global.document.head.children.find((c) => c.tag === 'script');
  assert.ok(script, 'js/dash.js injisert som <script> i <head>');
  assert.strictEqual(script.src, 'js/dash.js');

  script.onerror();
  await wait(10); // flush .then/.catch-kjeden

  const notice = bodyEl.children.find((c) => c.tag === 'pre' && c.className === 'error');
  assert.ok(notice, 'feil ved lasting av dash.js gir en synlig tekstnotis');
});

test('W5.2: bindRunCell dispatcher til Cells.runCell via cellIndexById', () => {
  const { Ui, runCellCalls } = freshEnv({ cellIdx: 0, idMap: { celleB: 3 } });
  const knapp = new FakeEl('button');
  knapp.id = 'kjor';

  Ui.beginCellRun(0);
  const ok = Ui.bindRunCell(JSON.stringify({ selector: '#kjor', event: 'click', cellId: 'celleB' }));
  Ui.endCellRun(0);
  assert.strictEqual(ok, true);

  dispatchDocEvent('click', knapp);
  assert.deepStrictEqual(runCellCalls, [3]);
});

test('W5.2: bindRunCell — ukjent cellId → console.warn, ingen kjøring', () => {
  const { Ui, runCellCalls } = freshEnv({ cellIdx: 0 });
  const knapp = new FakeEl('button');
  knapp.id = 'kjor';
  const warns = [];
  const origWarn = console.warn;
  console.warn = (msg) => warns.push(msg);
  try {
    Ui.bindRunCell(JSON.stringify({ selector: '#kjor', event: 'click', cellId: 'ukjent' }));
    dispatchDocEvent('click', knapp);
  } finally {
    console.warn = origWarn;
  }
  assert.deepStrictEqual(runCellCalls, []);
  assert.ok(warns.some((m) => m.includes('ukjent')));
});

test('W5.2: bindRunCell — mangler cellId → null, ingen registrering', () => {
  const { Ui } = freshEnv({ cellIdx: 0 });
  const ok = Ui.bindRunCell(JSON.stringify({ selector: '#x', event: 'click' }));
  assert.strictEqual(ok, null);
});

test('W5.2: resetBindings destruerer alle handlere og glemmer registeret (dispatch etterpå er en no-op)', () => {
  const { Ui } = freshEnv({ cellIdx: 0 });
  let destroyed = 0;
  let called = 0;
  const h = () => { called++; return '{}'; };
  h.destroy = () => { destroyed++; };
  Ui.bindEvent(JSON.stringify({ selector: '#a', event: 'click' }), h);

  Ui.resetBindings();
  assert.strictEqual(destroyed, 1);

  const el = new FakeEl('button');
  el.id = 'a';
  dispatchDocEvent('click', el);
  assert.strictEqual(called, 0, 'bindingen er glemt etter resetBindings — handler kalles ikke');
});

test('W5.2: erstatning — re-deklarasjon av SAMME binding-nøkkel i samme kjøring destruerer forrige handler', () => {
  const { Ui } = freshEnv({ cellIdx: 0 });
  let destroyedFirst = false;
  const h1 = () => '{}';
  h1.destroy = () => { destroyedFirst = true; };
  const h2 = () => '{}';

  Ui.beginCellRun(0);
  Ui.bindEvent(JSON.stringify({ selector: '#x', event: 'click' }), h1);
  Ui.bindEvent(JSON.stringify({ selector: '#x', event: 'click' }), h2); // samme nøkkel, ny handler
  Ui.endCellRun(0);

  assert.strictEqual(destroyedFirst, true, 'den erstattede handleren destrueres, ikke bare glemmes');
});

// ============================================================================
// Fase 3 / Task 1: doc-kontekst (rent skript uten #%%), rerun="all",
// sync_to — spec 2026-07-15-notebook-widgets-design.md §1/§3.
// ============================================================================

test('doc-kontekst: registerControl uten celle men med doc-ctx → stripe i #outputArea, nøkkel doc::', () => {
  const { Ui, outputAreaEl } = freshEnv({ docCtx: true });
  const v = Ui.registerControl(JSON.stringify({ type: 'slider', name: 'n', value: 5, min: 0, max: 10 }));
  assert.strictEqual(JSON.parse(v), 5);
  const strip = outputAreaEl.children.find((c) => c.classList.contains('ui-controls'));
  assert.ok(strip, 'stripe opprettet i #outputArea');
  assert.strictEqual(strip.getAttribute('data-pos'), 'top');
  assert.strictEqual(JSON.parse(Ui.valuesForCell(null)).n, 5);
});

test('doc-kontekst: uten aktiv doc-kjøring er registerControl fortsatt null (uendret no-op)', () => {
  const { Ui } = freshEnv({ ctxNull: true });
  assert.strictEqual(Ui.registerControl(JSON.stringify({ type: 'slider', name: 'n' })), null);
});

test('doc-kontekst: rerun-oppløsning — self→ingen (stille), id→warn+ingen, all→mdRunWholeScript etter debounce', async () => {
  const { Ui, outputAreaEl, runCellCalls } = freshEnv({ docCtx: true });
  let wholeScriptCalls = 0;
  global.mdRunWholeScript = () => { wholeScriptCalls++; };
  // Doc-kontekst har ingen notatbok — Cells trengs aldri for disse tre
  // scenarioene (self→[] og id→[] løses FØR noe Cells-oppslag, all→
  // mdRunWholeScript i stedet for Cells.runCell), så en fraværende Cells
  // beviser det.
  global.Cells = undefined;

  // 1) self (default): endre slider-verdi → ingen mdRunWholeScript, ingen runCell
  Ui.registerControl(JSON.stringify({ type: 'slider', name: 's1', value: 1, min: 0, max: 10 }));
  let strip = outputAreaEl.children.find((c) => c.classList.contains('ui-controls'));
  let input = strip.children[0].children[1];
  input.value = '5';
  input.dispatchEvent({ type: 'input' });
  await wait(200);
  assert.strictEqual(wholeScriptCalls, 0, 'self i doc-ctx løses stille til ingen mål');
  assert.deepStrictEqual(runCellCalls, []);

  // 2) rerun:'plot' (id): console.warn fanget, ingen kall — id-mål er
  // meningsløst uten celler å peke på.
  const origWarn = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  try {
    Ui.registerControl(JSON.stringify({ type: 'slider', name: 's2', value: 1, min: 0, max: 10, rerun: 'plot' }));
    strip = outputAreaEl.children.find((c) => c.classList.contains('ui-controls'));
    input = strip.children[1].children[1];
    input.value = '3';
    input.dispatchEvent({ type: 'input' });
    await wait(200);
  } finally {
    console.warn = origWarn;
  }
  assert.ok(warned >= 1, 'console.warn kalt for id-mål i doc-kontekst');
  assert.strictEqual(wholeScriptCalls, 0);
  assert.deepStrictEqual(runCellCalls, []);

  // 3) rerun:'all': endre verdi → etter 150ms+ er mdRunWholeScript kalt
  // nøyaktig én gang (to raske endringer → fortsatt én, debounce).
  Ui.registerControl(JSON.stringify({ type: 'slider', name: 's3', value: 1, min: 0, max: 10, rerun: 'all' }));
  strip = outputAreaEl.children.find((c) => c.classList.contains('ui-controls'));
  input = strip.children[2].children[1];
  input.value = '2';
  input.dispatchEvent({ type: 'input' });
  input.value = '4';
  input.dispatchEvent({ type: 'input' });
  await wait(200);
  assert.strictEqual(wholeScriptCalls, 1, "rerun:'all' kaller mdRunWholeScript nøyaktig én gang etter debounce");
});

test('sync_to: push ved registrering og ved endring, FØR evt. rerun', async () => {
  const { Ui, outputAreaEl } = freshEnv({ docCtx: true });
  const log = [];
  global.mdUiSyncTo = (name, value) => { log.push([name, value]); };

  const v = Ui.registerControl(JSON.stringify({ type: 'slider', name: 'n', value: 3, min: 0, max: 10, sync_to: 'n' }));
  assert.strictEqual(JSON.parse(v), 3);
  assert.deepStrictEqual(log, [['n', 3]], 'push skjedde allerede ved registrering');

  const strip = outputAreaEl.children.find((c) => c.classList.contains('ui-controls'));
  const input = strip.children[0].children[1];
  input.value = '7';
  input.dispatchEvent({ type: 'input' });
  assert.deepStrictEqual(log, [['n', 3], ['n', 7]],
    'push skjer UMIDDELBART ved endring (før den 150ms-debouncede reruen har rukket å fyre)');
  await wait(200); // flush løs debounce-timer FØR neste test overtar globalene
});

test('doc-kontekst: mark-og-sopp på tvers av to brakettede kjøringer', () => {
  const { Ui, outputAreaEl } = freshEnv({ docCtx: true });
  Ui.beginCellRun(null);
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'a', value: '1' }));
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'b', value: '2' }));
  Ui.endCellRun(null);
  const strip = outputAreaEl.children.find((c) => c.classList.contains('ui-controls'));
  assert.strictEqual(strip.children.length, 2, 'begge finnes etter første brakett');

  Ui.beginCellRun(null);
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'a', value: '1' }));
  Ui.endCellRun(null);
  assert.strictEqual(strip.children.length, 1, "'b' er fjernet fra stripa — ikke gjenregistrert i andre brakett");
});

test('registerFromRegistry(null, json) → doc-stripa (webR plain-sti)', () => {
  const { Ui, outputAreaEl, outEl } = freshEnv();
  Ui.registerFromRegistry(null, JSON.stringify([{ type: 'slider', name: 'r1', value: 2, min: 0, max: 5 }]));
  assert.strictEqual(JSON.parse(Ui.valuesForCell(null)).r1, 2);
  const strip = outputAreaEl.children.find((c) => c.classList.contains('ui-controls'));
  assert.ok(strip, 'stripa lever i #outputArea, ikke i en celle');
  assert.strictEqual(strip.children.length, 1);
  assert.ok(!outEl.children.some((c) => c.classList.contains('ui-controls')),
    'ingen .ui-controls havnet i cellens .nb-output');
});

// Task PSW-5 exit-gate-funn (rad 6/7/8): brython/mpy runSelf og R sin
// plain-sti bygger doc-stripa MENS skriptet kjører, men gjør SÅ et
// helhets-render (host.innerHTML=''; host.appendChild(...)) som frakobler
// den nettopp bygde stripa fra #outputArea uten å ødelegge selve noden —
// Ui.reattachDocStrips() setter den tilbake. Simulerer wipen presist ved å
// fjerne stripa fra outputAreaEl (samme sluttresultat som innerHTML='' gir
// en ekte DOM-node: children-lista mister den OG dens parentNode nulles).
test('reattachDocStrips: setter en frakoblet doc-stripe (etter helhets-render-wipe) tilbake i #outputArea, kontroll + verdi intakt', () => {
  const { Ui, outputAreaEl } = freshEnv({ docCtx: true });
  Ui.registerControl(JSON.stringify({ type: 'slider', name: 'n', value: 5, min: 0, max: 10 }));
  const strip = outputAreaEl.children.find((c) => c.classList.contains('ui-controls'));
  assert.ok(strip, 'stripa bygget under kjøring, som forventet');

  // Simuler wholesale-rendringen (renderOutput/renderROutputParts sitt
  // host.innerHTML=''; host.appendChild(nytt-innhold)) som skjer ETTER at
  // stripa allerede er bygget i brython/mpy/R sin plain-sti.
  outputAreaEl.removeChild(strip);
  const nyOutputNode = new FakeEl('pre');
  outputAreaEl.appendChild(nyOutputNode);
  assert.strictEqual(strip.parentNode, null, 'stripa er nå frakoblet, samme som en ekte innerHTML=\'\'-wipe gir');
  assert.strictEqual(outputAreaEl.children.indexOf(strip), -1);

  Ui.reattachDocStrips();

  assert.strictEqual(outputAreaEl.children[0], strip, 'stripa er satt tilbake som FØRSTE barn (data-pos "top")');
  assert.strictEqual(strip.parentNode, outputAreaEl);
  assert.strictEqual(strip.children.length, 1, 'kontrollen (slideren) sitter fortsatt inni stripa');
  assert.strictEqual(JSON.parse(Ui.valuesForCell(null)).n, 5, 'lagret verdi er uendret');

  // Idempotent: et andre kall når stripa allerede er tilkoblet endrer ikke
  // rekkefølgen eller lager en duplikat-node.
  Ui.reattachDocStrips();
  assert.strictEqual(outputAreaEl.children.filter((c) => c.classList.contains('ui-controls')).length, 1,
    'ingen duplikat-stripe etter et andre, no-op-kall');
  assert.strictEqual(outputAreaEl.children[0], strip);
});

// 4a-sluttreview Minor, lukket 4b §5: notatbok-aktiv → #outputArea sitt
// eneste ekte barn er .doc-root (docRender) — en frakoblet PLAIN-SCRIPT
// dokument-stripe (cellIdx=null, fra FØR notatboken ble aktivert) skal
// ALDRI reinnsettes som et søsken-element ved siden av .doc-root.
test('reattachDocStrips: no-op når notatboken er aktiv (stale plain-script doc-stripe skal ikke lande ved siden av .doc-root)', () => {
  const { Ui, outputAreaEl } = freshEnv({ docCtx: true });
  Ui.registerControl(JSON.stringify({ type: 'slider', name: 'n', value: 5, min: 0, max: 10 }));
  const strip = outputAreaEl.children.find((c) => c.classList.contains('ui-controls'));
  assert.ok(strip, 'stripa bygget under kjøring, som forventet');

  outputAreaEl.removeChild(strip);
  assert.strictEqual(strip.parentNode, null, 'stripa er frakoblet');

  global.Cells.active = () => true;
  Ui.reattachDocStrips();

  assert.strictEqual(strip.parentNode, null,
    'guarden hindrer reattach mens notatboken er aktiv — stripa forblir frakoblet');
  assert.strictEqual(outputAreaEl.children.filter((c) => c.classList.contains('ui-controls')).length, 0,
    'ingen ui-controls-stripe ved siden av .doc-root i #outputArea');
});
