'use strict';

// DOM-halvdel av js/param-forms.js (spec 2 W4, Task 2) er ikke node-testbar
// uten en DOM — dette er en hånd-stubbet DOM, installert som globaler FØR
// require('../../js/param-forms.js') slik at `typeof document !== 'undefined'`
// -porten åpner seg. Samme mønster/FakeEl-familie som tests/js/ui-dom.test.js
// og tests/js/cells-dom.test.js bruker for sine respektive DOM-halvdeler
// ("crib harness" per oppgaven).

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const PF_PATH = path.join(__dirname, '..', '..', 'js', 'param-forms.js');

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
    this._attrs = {};
  }
  set className(v) { this._className = v; }
  get className() { return this._className; }
  get classList() {
    const self = this;
    return {
      contains: (c) => self._className.split(/\s+/).filter(Boolean).includes(c),
      add: (...c) => { const set = new Set(self._className.split(/\s+/).filter(Boolean)); c.forEach((x) => set.add(x)); self._className = Array.from(set).join(' '); },
    };
  }
  set textContent(v) { this._text = v; this.children = []; }
  get textContent() { return this._text; }
  appendChild(c) { this.children.push(c); c._parentNode = this; return c; }
  insertBefore(node, ref) {
    // Ekte DOM-semantikk: flytter noden (fjerner den fra sin gamle plass
    // FØRST) i stedet for å duplisere den — nødvendig for at
    // ParamForms.reorder (som insertBefore-er en ALLEREDE tilstedeværende
    // node) skal kunne testes meningsfullt.
    if (node._parentNode) node._parentNode.removeChild(node);
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
  get nextSibling() {
    if (!this._parentNode) return null;
    const idx = this._parentNode.children.indexOf(this);
    if (idx === -1) return null;
    return this._parentNode.children[idx + 1] || null;
  }
  addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
  dispatchEvent(ev) { (this._listeners[ev.type] || []).forEach((fn) => fn(ev)); }
  setAttribute(name, v) { this._attrs[name] = v; this[name] = v; }
  getAttribute(name) { return this._attrs[name]; }
  removeAttribute(name) { delete this._attrs[name]; delete this[name]; }
}

function wait(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// Bygger en frisk DOM-stub + laster param-forms.js på nytt (dokument-scoped
// tilstand — _forms/_runTimers — er et closure-singleton, akkurat som
// ui.js/cells.js sine DOM-halvdeler; et fersk require er nødvendig per test).
function freshEnv(opts) {
  opts = opts || {};
  delete require.cache[require.resolve(PF_PATH)];
  global.document = { createElement: (tag) => new FakeEl(tag) };

  const cellEl = new FakeEl('div');
  cellEl.className = 'nb-cell';
  const inputEl = new FakeEl('div');
  inputEl.className = 'nb-input';
  const outEl = new FakeEl('div');
  outEl.className = 'nb-output';
  cellEl.appendChild(inputEl);
  cellEl.appendChild(outEl);

  const updateCellSourceCalls = [];
  const runCellCalls = [];
  global.Cells = {
    updateCellSource: (idx, newSource) => {
      updateCellSourceCalls.push([idx, newSource]);
      // Speiler den EKTE koblingen i js/cells.js (C.updateCellSource kaller
      // ParamForms.refresh etter hver commit) — nødvendig for å faktisk
      // bevise no-løkke-egenskapen (writeValue → updateCellSource →
      // refresh) i denne testfila sin egen isolasjon av param-forms.js.
      const PF = require(PF_PATH);
      if (typeof PF.refresh === 'function') PF.refresh(idx, newSource);
    },
    runCell: (idx) => { runCellCalls.push(idx); },
  };
  global.mdIsScriptRunning = () => !!opts.scriptRunning;

  const ParamForms = require(PF_PATH);

  return { ParamForms, cellEl, inputEl, outEl, updateCellSourceCalls, runCellCalls };
}

// ---- decorate: strip-bygging, seeding, no-param-celle --------------------

test('decorate: celle UTEN #@param → ingen .param-form-stripe opprettes', () => {
  const { ParamForms, cellEl } = freshEnv();
  ParamForms.decorate(0, cellEl, 'x = 3\nprint(x)', 'python');
  assert.strictEqual(cellEl.children.length, 2, 'kun de to opprinnelige barna (.nb-input/.nb-output)');
  assert.ok(!cellEl.children.some((c) => c.classList.contains('param-form')));
});

test('decorate: bygger .param-form som FØRSTE barn, ett kontrollelement per entry, seedet fra currentValue', () => {
  const { ParamForms, cellEl, inputEl, outEl } = freshEnv();
  const src = 'x = 3  #@param {type:"slider", min:0, max:10}\nname = \'a\'  #@param ["a", "b", "c"]';
  ParamForms.decorate(0, cellEl, src, 'python');

  assert.strictEqual(cellEl.children.length, 3, 'stripe + de to opprinnelige barna');
  const strip = cellEl.children[0];
  assert.ok(strip.classList.contains('param-form'), 'stripa er FØRSTE barn');
  assert.strictEqual(cellEl.children[1], inputEl);
  assert.strictEqual(cellEl.children[2], outEl);
  assert.strictEqual(strip.children.length, 2, 'to kontroll-rader');

  const sliderRow = strip.children[0];
  assert.strictEqual(sliderRow.children[0].textContent, 'x', 'label = varName');
  const sliderInput = sliderRow.children[1];
  assert.strictEqual(sliderInput.type, 'range');
  assert.strictEqual(Number(sliderInput.value), 3, 'seedet fra currentValue');
  assert.strictEqual(sliderInput.min, 0);
  assert.strictEqual(sliderInput.max, 10);
  const readout = sliderRow.children[2];
  assert.strictEqual(readout.textContent, '3');

  const dropdownRow = strip.children[1];
  assert.strictEqual(dropdownRow.children[0].textContent, 'name');
  const select = dropdownRow.children[1];
  assert.strictEqual(select.tag, 'select');
  assert.strictEqual(select.children.length, 3);
  assert.strictEqual(select.value, 'a', 'seedet fra currentValue (unquoted)');
});

test('decorate: dropdown med allow-input:true → tekstfelt + datalist (ikke select)', () => {
  const { ParamForms, cellEl } = freshEnv();
  const src = 'name = \'a\'  #@param ["a", "b"] {allow-input:true}';
  ParamForms.decorate(0, cellEl, src, 'python');
  const strip = cellEl.children[0];
  const row = strip.children[0];
  const input = row.children[1];
  assert.strictEqual(input.tag, 'input');
  assert.strictEqual(input.type, 'text');
  assert.strictEqual(input.getAttribute('list'), 'param-form-list-0-0');
  const datalist = row.children[2];
  assert.strictEqual(datalist.tag, 'datalist');
  assert.strictEqual(datalist.children.length, 2);
});

test('decorate: boolean → checkbox seedet riktig; raw → vanlig tekstfelt seedet VERBATIM', () => {
  const { ParamForms, cellEl } = freshEnv();
  const src = 'flag = True  #@param {type:"boolean"}\nexpr = x + 1  #@param {type:"raw"}';
  ParamForms.decorate(0, cellEl, src, 'python');
  const strip = cellEl.children[0];

  const checkboxRow = strip.children[0];
  const checkbox = checkboxRow.children[1];
  assert.strictEqual(checkbox.type, 'checkbox');
  assert.strictEqual(checkbox.checked, true);

  const rawRow = strip.children[1];
  const rawInput = rawRow.children[1];
  assert.strictEqual(rawInput.tag, 'input');
  assert.strictEqual(rawInput.type, 'text');
  assert.strictEqual(rawInput.value, 'x + 1', 'rå uttrykk seedet verbatim, ingen kvotering');
});

test('decorate: number og date bygges med riktig input-type', () => {
  const { ParamForms, cellEl } = freshEnv();
  const src = 'n = 5  #@param {type:"number", min:0, max:9}\nd = \'2024-01-01\'  #@param {type:"date"}';
  ParamForms.decorate(0, cellEl, src, 'python');
  const strip = cellEl.children[0];
  const numInput = strip.children[0].children[1];
  assert.strictEqual(numInput.type, 'number');
  assert.strictEqual(Number(numInput.value), 5);
  assert.strictEqual(numInput.min, 0);
  assert.strictEqual(numInput.max, 9);
  const dateInput = strip.children[1].children[1];
  assert.strictEqual(dateInput.type, 'date');
  assert.strictEqual(dateInput.value, '2024-01-01');
});

// ---- endring → writeValue → Cells.updateCellSource → evt. run:auto -------

test('slider-endring (run:auto): updateCellSource kalles med KORREKT spliset tekst; runCell debounces 150ms', async () => {
  const { ParamForms, cellEl, updateCellSourceCalls, runCellCalls } = freshEnv();
  const src = 'x = 3  #@param {type:"slider", min:0, max:10, run:"auto"}';
  ParamForms.decorate(2, cellEl, src, 'python');
  const strip = cellEl.children[0];
  const slider = strip.children[0].children[1];

  slider.value = '7';
  slider.dispatchEvent({ type: 'input' });

  assert.strictEqual(updateCellSourceCalls.length, 1);
  assert.deepStrictEqual(updateCellSourceCalls[0], [2, 'x = 7  #@param {type:"slider", min:0, max:10, run:"auto"}']);
  assert.strictEqual(runCellCalls.length, 0, 'ingen umiddelbar kjøring — debouncet 150ms for slider');

  await wait(220);
  assert.deepStrictEqual(runCellCalls, [2], 'debouncet run:auto-rerun fyrte etter 150ms');
});

test('dropdown-endring UTEN run:auto: updateCellSource kalles, runCell ALDRI (kun stale-tint kommuniserer, se cells.js)', async () => {
  const { ParamForms, cellEl, updateCellSourceCalls, runCellCalls } = freshEnv();
  const src = 'name = \'a\'  #@param ["a", "b", "c"]';
  ParamForms.decorate(1, cellEl, src, 'python');
  const strip = cellEl.children[0];
  const select = strip.children[0].children[1];

  select.value = 'b';
  select.dispatchEvent({ type: 'change' });
  await wait(220);

  assert.deepStrictEqual(updateCellSourceCalls, [[1, 'name = \'b\'  #@param ["a", "b", "c"]']]);
  assert.deepStrictEqual(runCellCalls, [], 'uten run:auto skal runCell ALDRI kalles');
});

test('checkbox-endring (run:auto, IKKE slider) → UMIDDELBAR runCell, ingen debounce-ventetid', async () => {
  const { ParamForms, cellEl, runCellCalls } = freshEnv();
  const src = 'flag = True  #@param {type:"boolean", run:"auto"}';
  ParamForms.decorate(4, cellEl, src, 'python');
  const strip = cellEl.children[0];
  const checkbox = strip.children[0].children[1];

  checkbox.checked = false;
  checkbox.dispatchEvent({ type: 'change' });
  assert.deepStrictEqual(runCellCalls, [4], 'ikke-slider run:auto kjører umiddelbart, ingen 150ms-venting');
});

test('mdIsScriptRunning() true: verdien lagres/skrives fortsatt, men run:auto-reruns nektes (samme mønster som js/ui.js)', async () => {
  const { ParamForms, cellEl, updateCellSourceCalls, runCellCalls } = freshEnv({ scriptRunning: true });
  const src = 'x = 3  #@param {type:"slider", min:0, max:10, run:"auto"}';
  ParamForms.decorate(0, cellEl, src, 'python');
  const strip = cellEl.children[0];
  const slider = strip.children[0].children[1];

  slider.value = '9';
  slider.dispatchEvent({ type: 'input' });
  await wait(220);

  assert.strictEqual(updateCellSourceCalls.length, 1, 'teksten oppdateres uansett');
  assert.deepStrictEqual(runCellCalls, [], 'kjøring nektet mens skriptet allerede kjører');
});

// ---- no-løkke-egenskapen: kontrollens EGEN endring bygger ALDRI om --------

test('no-løkke: kontrollens egen writeValue→updateCellSource→refresh-sykel ombygger ALDRI noden (samme range-input, samme readout) midt i en "drag"', () => {
  const { ParamForms, cellEl, updateCellSourceCalls } = freshEnv();
  const src = 'x = 3  #@param {type:"slider", min:0, max:10}';
  ParamForms.decorate(0, cellEl, src, 'python');
  const strip = cellEl.children[0];
  const row = strip.children[0];
  const sliderBefore = row.children[1];
  const readoutBefore = row.children[2];

  // Simuler flere "drag"-tikk på rad — hver av dem trigger HELE
  // control → writeValue → Cells.updateCellSource → ParamForms.refresh
  // (stubbet i freshEnv til å speile den ekte js/cells.js-koblingen).
  [4, 5, 6, 7].forEach((v) => {
    sliderBefore.value = String(v);
    sliderBefore.dispatchEvent({ type: 'input' });
  });

  assert.strictEqual(updateCellSourceCalls.length, 4, 'ett updateCellSource-kall per tikk');
  assert.strictEqual(cellEl.children[0], strip, 'SAMME stripe-node — ingen ombygging');
  assert.strictEqual(strip.children[0], row, 'SAMME rad-node');
  assert.strictEqual(strip.children[0].children[1], sliderBefore, 'SAMME range-input-node — draget ble ikke revet ned');
  assert.strictEqual(strip.children[0].children[2], readoutBefore, 'SAMME readout-node');
  assert.strictEqual(readoutBefore.textContent, '7', 'readouten fulgte siste tikk');
  assert.strictEqual(Number(sliderBefore.value), 7);
});

// ---- manuell tekst-redigering: refresh oppdaterer i place / bygger om -----

test('refresh: samme struktur (kun ny verdi) → kontrollverdi oppdateres I PLACE, SAMME DOM-node', () => {
  const { ParamForms, cellEl } = freshEnv();
  const src = 'x = 3  #@param {type:"slider", min:0, max:10}';
  ParamForms.decorate(0, cellEl, src, 'python');
  const strip = cellEl.children[0];
  const sliderBefore = strip.children[0].children[1];

  ParamForms.refresh(0, 'x = 8  #@param {type:"slider", min:0, max:10}');

  assert.strictEqual(cellEl.children[0], strip, 'ingen ombygging av stripa');
  assert.strictEqual(strip.children[0].children[1], sliderBefore, 'samme input-node, kun .value endret');
  assert.strictEqual(Number(sliderBefore.value), 8);
  assert.strictEqual(strip.children[0].children[2].textContent, '8', 'readout fulgte med');
});

test('refresh: verdi UENDRET → ren no-op (input.value ikke rørt i det hele tatt)', () => {
  const { ParamForms, cellEl } = freshEnv();
  const src = 'n = 5  #@param {type:"number"}';
  ParamForms.decorate(0, cellEl, src, 'python');
  const strip = cellEl.children[0];
  const numInput = strip.children[0].children[1];
  numInput.value = '5'; // simuler at DOM-en allerede viser 5 (som seedet)

  ParamForms.refresh(0, 'n = 5  #@param {type:"number"}');
  assert.strictEqual(numInput.value, '5');
});

test('refresh: strukturell endring (en ny #@param-linje lagt til) → stripa bygges HELT PÅ NYTT (ny node)', () => {
  const { ParamForms, cellEl } = freshEnv();
  const src = 'x = 3  #@param {type:"slider", min:0, max:10}';
  ParamForms.decorate(0, cellEl, src, 'python');
  const oldStrip = cellEl.children[0];

  const newSrc = 'x = 3  #@param {type:"slider", min:0, max:10}\ny = \'a\'  #@param ["a", "b"]';
  ParamForms.refresh(0, newSrc);

  const newStrip = cellEl.children[0];
  assert.notStrictEqual(newStrip, oldStrip, 'HELT NY stripe-node');
  assert.strictEqual(newStrip.children.length, 2, 'to kontroller nå');
});

test('refresh: strukturell endring (type byttet på SAMME linje) → bygges på nytt', () => {
  const { ParamForms, cellEl } = freshEnv();
  const src = 'x = 3  #@param {type:"slider", min:0, max:10}';
  ParamForms.decorate(0, cellEl, src, 'python');
  const oldStrip = cellEl.children[0];
  const oldInput = oldStrip.children[0].children[1];
  assert.strictEqual(oldInput.type, 'range');

  ParamForms.refresh(0, 'x = \'a\'  #@param ["a", "b"]');

  const newStrip = cellEl.children[0];
  assert.notStrictEqual(newStrip, oldStrip);
  const newInput = newStrip.children[0].children[1];
  assert.strictEqual(newInput.tag, 'select', 'slider → dropdown krever en helt ny select-node');
});

test('refresh: ALLE #@param-linjer fjernet → stripa fjernes (tilbake til "ingen skjema")', () => {
  const { ParamForms, cellEl } = freshEnv();
  const src = 'x = 3  #@param {type:"slider", min:0, max:10}';
  ParamForms.decorate(0, cellEl, src, 'python');
  assert.strictEqual(cellEl.children.length, 3);

  ParamForms.refresh(0, 'x = 3');
  assert.strictEqual(cellEl.children.length, 2, 'stripa fjernet, kun de opprinnelige to barna igjen');
});

test('refresh: bruker SKRIVER en fersk #@param-linje inn i en tidligere param-fri celle → strukturell endring, stripa bygges (dukker opp)', () => {
  const { ParamForms, cellEl } = freshEnv();
  ParamForms.decorate(0, cellEl, 'x = 3', 'python'); // ingen entries → ingen strip ennå, men state (cellEl/lang) lagres
  assert.strictEqual(cellEl.children.length, 2, 'ingen stripe før den første #@param-linja skrives');

  assert.doesNotThrow(() => ParamForms.refresh(0, 'x = 3  #@param {type:"number"}'));
  assert.strictEqual(cellEl.children.length, 3, 'lagt-til-linje er en strukturell endring → stripa bygges nå');
  assert.ok(cellEl.children[0].classList.contains('param-form'));
});

test('refresh: cellIdx uten NOEN forutgående decorate-kall → no-op (ingen krasj) — refresh alene kan aldri initialisere en celle', () => {
  const { ParamForms, cellEl } = freshEnv();
  assert.doesNotThrow(() => ParamForms.refresh(0, 'x = 3  #@param {type:"number"}'));
  assert.strictEqual(cellEl.children.length, 2, 'ingen decorate-tilstand for idx 0 ennå → refresh er en total no-op');
});

// ---- reorder: .param-form ALLTID før .ui-controls -------------------------

test('reorder: flytter .param-form FØR en .ui-controls som dukket opp ETTER (samme celle, en kjøring registrerte ui.slider)', () => {
  const { ParamForms, cellEl } = freshEnv();
  ParamForms.decorate(0, cellEl, 'x = 3  #@param {type:"number"}', 'python');
  const form = cellEl.children[0];
  assert.ok(form.classList.contains('param-form'));

  // Simuler js/ui.js sin _ensureStrip: insertBefore(strip, cellEl.firstChild)
  // — som per planens naive oppførsel havner FØR .param-form.
  const uiControls = new FakeEl('div');
  uiControls.className = 'ui-controls';
  cellEl.insertBefore(uiControls, cellEl.firstChild);
  assert.strictEqual(cellEl.children[0], uiControls, 'ui-controls havnet feilaktig først (reprodusert)');

  ParamForms.reorder(cellEl);
  assert.strictEqual(cellEl.children[0], form, 'param-form er FØRST igjen etter reorder');
  assert.strictEqual(cellEl.children[1], uiControls, 'ui-controls er nå etter param-form');
});

test('reorder: rekkefølgen ALLEREDE riktig → no-op (ingen kaste, ingen endring)', () => {
  const { ParamForms, cellEl } = freshEnv();
  ParamForms.decorate(0, cellEl, 'x = 3  #@param {type:"number"}', 'python');
  const form = cellEl.children[0];
  const uiControls = new FakeEl('div');
  uiControls.className = 'ui-controls';
  cellEl.appendChild(uiControls); // etter param-form (og etter .nb-input/.nb-output) allerede
  const before = cellEl.children.slice();
  assert.doesNotThrow(() => ParamForms.reorder(cellEl));
  assert.deepStrictEqual(cellEl.children, before, 'ingen endring — rekkefølgen var allerede korrekt');
  assert.ok(cellEl.children.indexOf(form) < cellEl.children.indexOf(uiControls));
});

test('reorder: kun én av de to (eller ingen) finnes → no-op', () => {
  const { ParamForms, cellEl } = freshEnv();
  assert.doesNotThrow(() => ParamForms.reorder(cellEl));
  assert.doesNotThrow(() => ParamForms.reorder(null));
});

// ---- resetDocument: glemmer skjema-tilstand + kansellerer ventende run:auto-timere ----

test('resetDocument: kansellerer en ventende run:auto-slider-debounce (nytt dokument skal ikke kunne kjøre en gammel celle)', async () => {
  const { ParamForms, cellEl, runCellCalls } = freshEnv();
  const src = 'x = 3  #@param {type:"slider", min:0, max:10, run:"auto"}';
  ParamForms.decorate(0, cellEl, src, 'python');
  const slider = cellEl.children[0].children[0].children[1];
  slider.value = '9';
  slider.dispatchEvent({ type: 'input' }); // starter en 150ms-timer

  ParamForms.resetDocument();
  await wait(220);
  assert.deepStrictEqual(runCellCalls, [], 'timeren fra FØR resetDocument skal ALDRI fyre');
});

test('resetDocument: glemmer skjema-tilstand — en senere refresh for samme cellIdx er en no-op (ingen decorate-tilstand igjen)', () => {
  const { ParamForms, cellEl } = freshEnv();
  ParamForms.decorate(0, cellEl, 'x = 3  #@param {type:"number"}', 'python');
  ParamForms.resetDocument();
  assert.doesNotThrow(() => ParamForms.refresh(0, 'x = 4  #@param {type:"number"}'));
  // cellEl selv er urørt av resetDocument (den fjerner ikke DOM-noder — det
  // er cells.js sin fulle render() som gjør det ved neste dokumentlasting);
  // poenget her er at den GAMLE _forms-oppføringen ikke lenger styrer noe.
});

// ---- R-språk: boolean skrives som TRUE/FALSE, ikke True/False -------------

test('R-modus: boolean-kontroll skriver TRUE/FALSE (ikke Python sin True/False)', () => {
  const { ParamForms, cellEl, updateCellSourceCalls } = freshEnv();
  const src = 'flag <- TRUE  #@param {type:"boolean"}';
  ParamForms.decorate(0, cellEl, src, 'r');
  const checkbox = cellEl.children[0].children[0].children[1];
  checkbox.checked = false;
  checkbox.dispatchEvent({ type: 'change' });
  assert.deepStrictEqual(updateCellSourceCalls[0], [0, 'flag <- FALSE  #@param {type:"boolean"}']);
});
