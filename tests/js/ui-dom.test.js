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

// ---- B2 (final-review): type-bytte under samme nøkkel bygger på nytt -----

test('registerControl: type-bytte slider→dropdown under SAMME nøkkel bygger en fersk select-node (ikke option-noder inni range-input)', () => {
  const { Ui, cellEl } = freshEnv();
  Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 0, max: 100, value: 5 }));
  const strip = cellEl.children[0];
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
  const { Ui, cellEl, runCellCalls } = freshEnv({ cellIdx: 9 });
  Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 0, max: 100, value: 5 }));
  Ui.registerControl(JSON.stringify({ type: 'button', name: 'x', label: 'Kjør' }));

  const strip = cellEl.children[0];
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
  const { Ui, cellEl } = freshEnv({ idMap: { a: 3, b: 4 } });
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
  const strip = cellEl.children[0];
  const textInput = strip.children[0].children[1];

  textInput.value = 'w';
  textInput.dispatchEvent({ type: 'change' });
  await wait(250);

  assert.deepStrictEqual(order, ['start:3', 'end:3', 'start:4', 'end:4'],
    'mål 4 (id b) venter til mål 3 (id a) er helt ferdig FØR det starter');
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

test('button: klikk → UMIDDELBAR rerun (ingen debounce-ventetid), returnerer null-verdi', async () => {
  const { Ui, cellEl, runCellCalls } = freshEnv({ cellIdx: 5 });
  const res = Ui.registerControl(JSON.stringify({ type: 'button', label: 'Kjør nå' }));
  assert.strictEqual(JSON.parse(res), null);

  const strip = cellEl.children[0];
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

// N3-fiksen (final-review): _updateControlSpec fjerner nå min/max/step via
// removeAttribute når en re-registrering UTELATER dem — før fiksen ble de
// bare ikke oppdatert, så en tidligere kjørings min=0/max=10/step=2 ble
// hengende igjen som en STALE begrensning selv etter at kilden fjernet dem
// fra ui.number(...)-kallet.
test('number: re-registrering UTEN min/max/step fjerner tidligere attributter (N3, final-review)', () => {
  const { Ui, cellEl } = freshEnv();
  Ui.registerControl(JSON.stringify({ type: 'number', name: 'n', value: 5, min: 0, max: 10, step: 2 }));
  const strip = cellEl.children[0];
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

// ============================================================================
// W2 Task 1: registerFromRegistry, valuesForCell, cellKey-stabilitet,
// W1-carryover-polering (insertBefore-posisjon, reduce-catch).
// ============================================================================

// ---- registerFromRegistry: bulk-registrering fra et JSON-array -----------

test('registerFromRegistry: renderer N kontroller fra ett JSON-array, gjenbruker lagret verdi, sopper stale ved neste kall', async () => {
  const { Ui, cellEl } = freshEnv({ cellIdx: 6 });
  Ui.registerFromRegistry(6, JSON.stringify([
    { type: 'slider', name: 'a', min: 0, max: 10, value: 3 },
    { type: 'text', name: 'b', value: 'hei' },
    { type: 'checkbox', name: 'c', value: true },
  ]));
  const strip = cellEl.children[0];
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
  const { Ui, cellEl } = freshEnv({ cellIdx: 1 });
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
  const strip = cellEl.children[0];
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
  const { Ui, cellEl, setCtx } = freshEnv({ cellIdx: 2 });
  // Samme stabile id ('mycell') uansett hvilken råindeks cellen står på —
  // simulerer Cells.cellKeyAt sin attrs.id-gren for en id-tagget celle.
  global.Cells.cellKeyAt = () => 'mycell';
  global.Cells.cellElementAt = () => cellEl;

  const first = Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 0, max: 100, value: 5 }));
  assert.strictEqual(JSON.parse(first), 5);

  const strip = cellEl.children[0];
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
  const { Ui, cellEl: cellEl2 } = freshEnv({ cellIdx: 2 });
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

// ---- W1-carryover (a): type-bytte beholder ORIGINAL stripe-posisjon ------

test('type-bytte (B2) beholder ORIGINAL stripe-posisjon — insertBefore på gammel plass, ikke append til slutt (W1-carryover a)', () => {
  const { Ui, cellEl } = freshEnv({ cellIdx: 0 });
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'a', value: '1' }));
  Ui.registerControl(JSON.stringify({ type: 'slider', name: 'b', min: 0, max: 10, value: 5 }));
  Ui.registerControl(JSON.stringify({ type: 'text', name: 'c', value: '3' }));
  const strip = cellEl.children[0];
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
  const { Ui, cellEl } = freshEnv({ cellIdx: 4 });
  global.Cells.runCell = () => { throw new Error('boom'); };

  const origWarn = console.warn;
  const warned = [];
  console.warn = (...args) => { warned.push(args); };
  let unhandled = null;
  const onUnhandled = (err) => { unhandled = err; };
  process.on('unhandledRejection', onUnhandled);

  try {
    Ui.registerControl(JSON.stringify({ type: 'text', name: 'x', value: 'a' }));
    const strip = cellEl.children[0];
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
