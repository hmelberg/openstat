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
  // Widget-plassering-fasen: .nb-output er en WRAPPER — js/cells.js sin
  // cellNode setter alltid inn .nb-output-body som barn FØR noen striper
  // finnes. ParamForms sin _insertStrip setter .param-form inn INNI outEl,
  // FØR en evt. .ui-controls, ellers FØR bodyEl — speiler ekte DOM-struktur.
  const bodyEl = new FakeEl('div');
  bodyEl.className = 'nb-output-body';
  outEl.appendChild(bodyEl);
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

  return { ParamForms, cellEl, inputEl, outEl, bodyEl, updateCellSourceCalls, runCellCalls };
}

// ---- decorate: strip-bygging, seeding, no-param-celle --------------------

test('decorate: celle UTEN #@param → ingen .param-form-stripe opprettes', () => {
  const { ParamForms, cellEl, outEl } = freshEnv();
  ParamForms.decorate(0, cellEl, 'x = 3\nprint(x)', 'python');
  assert.strictEqual(cellEl.children.length, 2, 'kun de to opprinnelige barna (.nb-input/.nb-output)');
  assert.strictEqual(outEl.children.length, 1, 'kun .nb-output-body i outputen, ingen stripe');
  assert.ok(!outEl.children.some((c) => c.classList.contains('param-form')));
});

test('decorate: bygger .param-form som FØRSTE barn i .nb-output (FØR .nb-output-body), ett kontrollelement per entry, seedet fra currentValue', () => {
  const { ParamForms, cellEl, inputEl, outEl, bodyEl } = freshEnv();
  const src = 'x = 3  #@param {type:"slider", min:0, max:10}\nname = \'a\'  #@param ["a", "b", "c"]';
  ParamForms.decorate(0, cellEl, src, 'python');

  assert.strictEqual(cellEl.children.length, 2, '.nb-cell selv er urørt — stripa lever inni .nb-output');
  assert.strictEqual(cellEl.children[0], inputEl);
  assert.strictEqual(cellEl.children[1], outEl);
  assert.strictEqual(outEl.children.length, 2, 'stripe + .nb-output-body');
  const strip = outEl.children[0];
  assert.ok(strip.classList.contains('param-form'), 'stripa er FØRSTE barn i .nb-output, FØR body');
  assert.strictEqual(outEl.children[1], bodyEl, '.nb-output-body uendret, nå etter stripa');
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
  const { ParamForms, cellEl, outEl } = freshEnv();
  const src = 'name = \'a\'  #@param ["a", "b"] {allow-input:true}';
  ParamForms.decorate(0, cellEl, src, 'python');
  const strip = outEl.children[0];
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
  const { ParamForms, cellEl, outEl } = freshEnv();
  const src = 'flag = True  #@param {type:"boolean"}\nexpr = x + 1  #@param {type:"raw"}';
  ParamForms.decorate(0, cellEl, src, 'python');
  const strip = outEl.children[0];

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
  const { ParamForms, cellEl, outEl } = freshEnv();
  const src = 'n = 5  #@param {type:"number", min:0, max:9}\nd = \'2024-01-01\'  #@param {type:"date"}';
  ParamForms.decorate(0, cellEl, src, 'python');
  const strip = outEl.children[0];
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
  const { ParamForms, cellEl, outEl, updateCellSourceCalls, runCellCalls } = freshEnv();
  const src = 'x = 3  #@param {type:"slider", min:0, max:10, run:"auto"}';
  ParamForms.decorate(2, cellEl, src, 'python');
  const strip = outEl.children[0];
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
  const { ParamForms, cellEl, outEl, updateCellSourceCalls, runCellCalls } = freshEnv();
  const src = 'name = \'a\'  #@param ["a", "b", "c"]';
  ParamForms.decorate(1, cellEl, src, 'python');
  const strip = outEl.children[0];
  const select = strip.children[0].children[1];

  select.value = 'b';
  select.dispatchEvent({ type: 'change' });
  await wait(220);

  assert.deepStrictEqual(updateCellSourceCalls, [[1, 'name = \'b\'  #@param ["a", "b", "c"]']]);
  assert.deepStrictEqual(runCellCalls, [], 'uten run:auto skal runCell ALDRI kalles');
});

test('checkbox-endring (run:auto, IKKE slider) → UMIDDELBAR runCell, ingen debounce-ventetid', async () => {
  const { ParamForms, cellEl, outEl, runCellCalls } = freshEnv();
  const src = 'flag = True  #@param {type:"boolean", run:"auto"}';
  ParamForms.decorate(4, cellEl, src, 'python');
  const strip = outEl.children[0];
  const checkbox = strip.children[0].children[1];

  checkbox.checked = false;
  checkbox.dispatchEvent({ type: 'change' });
  assert.deepStrictEqual(runCellCalls, [4], 'ikke-slider run:auto kjører umiddelbart, ingen 150ms-venting');
});

test('mdIsScriptRunning() true: verdien lagres/skrives fortsatt, men run:auto-reruns nektes (samme mønster som js/ui.js)', async () => {
  const { ParamForms, cellEl, outEl, updateCellSourceCalls, runCellCalls } = freshEnv({ scriptRunning: true });
  const src = 'x = 3  #@param {type:"slider", min:0, max:10, run:"auto"}';
  ParamForms.decorate(0, cellEl, src, 'python');
  const strip = outEl.children[0];
  const slider = strip.children[0].children[1];

  slider.value = '9';
  slider.dispatchEvent({ type: 'input' });
  await wait(220);

  assert.strictEqual(updateCellSourceCalls.length, 1, 'teksten oppdateres uansett');
  assert.deepStrictEqual(runCellCalls, [], 'kjøring nektet mens skriptet allerede kjører');
});

// ---- no-løkke-egenskapen: kontrollens EGEN endring bygger ALDRI om --------

test('no-løkke: kontrollens egen writeValue→updateCellSource→refresh-sykel ombygger ALDRI noden (samme range-input, samme readout) midt i en "drag"', () => {
  const { ParamForms, cellEl, outEl, updateCellSourceCalls } = freshEnv();
  const src = 'x = 3  #@param {type:"slider", min:0, max:10}';
  ParamForms.decorate(0, cellEl, src, 'python');
  const strip = outEl.children[0];
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
  assert.strictEqual(outEl.children[0], strip, 'SAMME stripe-node — ingen ombygging');
  assert.strictEqual(strip.children[0], row, 'SAMME rad-node');
  assert.strictEqual(strip.children[0].children[1], sliderBefore, 'SAMME range-input-node — draget ble ikke revet ned');
  assert.strictEqual(strip.children[0].children[2], readoutBefore, 'SAMME readout-node');
  assert.strictEqual(readoutBefore.textContent, '7', 'readouten fulgte siste tikk');
  assert.strictEqual(Number(sliderBefore.value), 7);
});

// ---- krysskanal-race (review-fiks 1): manuell skriving + kontroll-endring
// innen samme debounce-vindu — INGEN av delene skal gå tapt -----------------

test('krysskanal-race: linje skrevet manuelt + slider dratt FØR debouncen → BÅDE den nye linja og den nye verdien overlever (reviewer-repro)', () => {
  const { ParamForms, cellEl, outEl, updateCellSourceCalls } = freshEnv();
  const src = 'x = 3  #@param {type:"slider", min:0, max:10}';
  ParamForms.decorate(0, cellEl, src, 'python');
  const slider = outEl.children[0].children[0].children[1];

  // Brukeren skriver `y = 1` på linja OVER #@param-linja — js/cells.js sin
  // onEdit kaller syncSource SYNKront per tastetrykk (review-fiks 1a), FØR
  // 250ms-debouncen har fyrt refresh:
  ParamForms.syncSource(0, 'y = 1\nx = 3  #@param {type:"slider", min:0, max:10}');

  // ... og drar så slideren INNENFOR debounce-vinduet. Splicingen må skje
  // mot den FERSKE kilden (og #@param-linjas NYE lineIdx 1), ikke mot den
  // closure-fangede entryen fra byggetid (lineIdx 0):
  slider.value = '7';
  slider.dispatchEvent({ type: 'input' });

  assert.strictEqual(updateCellSourceCalls.length, 1);
  assert.deepStrictEqual(updateCellSourceCalls[0],
    [0, 'y = 1\nx = 7  #@param {type:"slider", min:0, max:10}'],
    'BÅDE den manuelt skrevne linja OG den nye slider-verdien er i resultatet');
});

test('krysskanal-race: etter ombyggingen (refresh så strukturell lineIdx-endring) virker den NYE kontrollen mot riktig linje', () => {
  const { ParamForms, cellEl, outEl, updateCellSourceCalls } = freshEnv();
  ParamForms.decorate(0, cellEl, 'x = 3  #@param {type:"slider", min:0, max:10}', 'python');
  const oldSlider = outEl.children[0].children[0].children[1];

  ParamForms.syncSource(0, 'y = 1\nx = 3  #@param {type:"slider", min:0, max:10}');
  oldSlider.value = '7';
  oldSlider.dispatchEvent({ type: 'input' });
  // updateCellSource-stubben kalte refresh → lineIdx endret (0→1) er
  // strukturelt → stripa er ombygd med en NY slider bundet til linje 1.
  const newSlider = outEl.children[0].children[0].children[1];
  assert.notStrictEqual(newSlider, oldSlider, 'strukturell endring → fersk kontroll-node');
  assert.strictEqual(Number(newSlider.value), 7, 'ny kontroll seedet fra gjeldende kilde');

  newSlider.value = '5';
  newSlider.dispatchEvent({ type: 'input' });
  assert.deepStrictEqual(updateCellSourceCalls[updateCellSourceCalls.length - 1],
    [0, 'y = 1\nx = 5  #@param {type:"slider", min:0, max:10}'],
    'den ombygde kontrollen splicer korrekt inn i linje 1');
});

test('syncSource: verdi-endring uten strukturskifte → splice-grunnlaget følger med, kontrollen ombygges IKKE av en senere commit', () => {
  const { ParamForms, cellEl, outEl, updateCellSourceCalls } = freshEnv();
  ParamForms.decorate(0, cellEl, 'x = 3  #@param {type:"slider", min:0, max:10}', 'python');
  const slider = outEl.children[0].children[0].children[1];

  // Bruker redigerer selve verdien manuelt (samme struktur): syncSource per
  // tastetrykk — st.source er nå 'x = 9', men kontrollen viser fortsatt 3
  // (den visuelle oppdateringen er debouncet, med vilje).
  ParamForms.syncSource(0, 'x = 9  #@param {type:"slider", min:0, max:10}');

  slider.value = '4';
  slider.dispatchEvent({ type: 'input' });
  assert.deepStrictEqual(updateCellSourceCalls[0],
    [0, 'x = 4  #@param {type:"slider", min:0, max:10}'],
    'splicet mot den ferske kilden (9 → 4), ikke den gamle (3)');
  assert.strictEqual(outEl.children[0].children[0].children[1], slider,
    'samme struktur hele veien — kontroll-noden er aldri ombygd');
});

test('syncSource: cellIdx uten decorate-tilstand → no-op, ingen krasj', () => {
  const { ParamForms } = freshEnv();
  assert.doesNotThrow(() => ParamForms.syncSource(3, 'x = 1  #@param {type:"number"}'));
});

test('_commit etter at linja er FJERNET under hånden (syncSource tømte entries) → warn + drop, ingen korrupt skriving', () => {
  const { ParamForms, cellEl, outEl, updateCellSourceCalls } = freshEnv();
  ParamForms.decorate(0, cellEl, 'x = 3  #@param {type:"slider", min:0, max:10}', 'python');
  const slider = outEl.children[0].children[0].children[1];

  // Brukeren slettet hele #@param-linja; debouncen har ikke fyrt ennå.
  ParamForms.syncSource(0, 'print(1)');

  const origWarn = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  try {
    slider.value = '8';
    slider.dispatchEvent({ type: 'input' });
  } finally {
    console.warn = origWarn;
  }
  assert.deepStrictEqual(updateCellSourceCalls, [], 'ingen skriving mot en kilde uten oppføringen');
  assert.ok(warned >= 1, 'console.warn om droppet endring');
});

// ---- manuell tekst-redigering: refresh oppdaterer i place / bygger om -----

test('refresh: samme struktur (kun ny verdi) → kontrollverdi oppdateres I PLACE, SAMME DOM-node', () => {
  const { ParamForms, cellEl, outEl } = freshEnv();
  const src = 'x = 3  #@param {type:"slider", min:0, max:10}';
  ParamForms.decorate(0, cellEl, src, 'python');
  const strip = outEl.children[0];
  const sliderBefore = strip.children[0].children[1];

  ParamForms.refresh(0, 'x = 8  #@param {type:"slider", min:0, max:10}');

  assert.strictEqual(outEl.children[0], strip, 'ingen ombygging av stripa');
  assert.strictEqual(strip.children[0].children[1], sliderBefore, 'samme input-node, kun .value endret');
  assert.strictEqual(Number(sliderBefore.value), 8);
  assert.strictEqual(strip.children[0].children[2].textContent, '8', 'readout fulgte med');
});

test('refresh: verdi UENDRET → ren no-op (input.value ikke rørt i det hele tatt)', () => {
  const { ParamForms, cellEl, outEl } = freshEnv();
  const src = 'n = 5  #@param {type:"number"}';
  ParamForms.decorate(0, cellEl, src, 'python');
  const strip = outEl.children[0];
  const numInput = strip.children[0].children[1];
  numInput.value = '5'; // simuler at DOM-en allerede viser 5 (som seedet)

  ParamForms.refresh(0, 'n = 5  #@param {type:"number"}');
  assert.strictEqual(numInput.value, '5');
});

test('refresh: strukturell endring (en ny #@param-linje lagt til) → stripa bygges HELT PÅ NYTT (ny node)', () => {
  const { ParamForms, cellEl, outEl } = freshEnv();
  const src = 'x = 3  #@param {type:"slider", min:0, max:10}';
  ParamForms.decorate(0, cellEl, src, 'python');
  const oldStrip = outEl.children[0];

  const newSrc = 'x = 3  #@param {type:"slider", min:0, max:10}\ny = \'a\'  #@param ["a", "b"]';
  ParamForms.refresh(0, newSrc);

  const newStrip = outEl.children[0];
  assert.notStrictEqual(newStrip, oldStrip, 'HELT NY stripe-node');
  assert.strictEqual(newStrip.children.length, 2, 'to kontroller nå');
});

test('refresh: strukturell endring (type byttet på SAMME linje) → bygges på nytt', () => {
  const { ParamForms, cellEl, outEl } = freshEnv();
  const src = 'x = 3  #@param {type:"slider", min:0, max:10}';
  ParamForms.decorate(0, cellEl, src, 'python');
  const oldStrip = outEl.children[0];
  const oldInput = oldStrip.children[0].children[1];
  assert.strictEqual(oldInput.type, 'range');

  ParamForms.refresh(0, 'x = \'a\'  #@param ["a", "b"]');

  const newStrip = outEl.children[0];
  assert.notStrictEqual(newStrip, oldStrip);
  const newInput = newStrip.children[0].children[1];
  assert.strictEqual(newInput.tag, 'select', 'slider → dropdown krever en helt ny select-node');
});

test('refresh: ALLE #@param-linjer fjernet → stripa fjernes (tilbake til "ingen skjema")', () => {
  const { ParamForms, cellEl, outEl } = freshEnv();
  const src = 'x = 3  #@param {type:"slider", min:0, max:10}';
  ParamForms.decorate(0, cellEl, src, 'python');
  assert.strictEqual(outEl.children.length, 2, 'stripe + body');

  ParamForms.refresh(0, 'x = 3');
  assert.strictEqual(outEl.children.length, 1, 'stripa fjernet, kun .nb-output-body igjen');
});

test('refresh: bruker SKRIVER en fersk #@param-linje inn i en tidligere param-fri celle → strukturell endring, stripa bygges (dukker opp)', () => {
  const { ParamForms, cellEl, outEl } = freshEnv();
  ParamForms.decorate(0, cellEl, 'x = 3', 'python'); // ingen entries → ingen strip ennå, men state (cellEl/lang) lagres
  assert.strictEqual(outEl.children.length, 1, 'ingen stripe før den første #@param-linja skrives');

  assert.doesNotThrow(() => ParamForms.refresh(0, 'x = 3  #@param {type:"number"}'));
  assert.strictEqual(outEl.children.length, 2, 'lagt-til-linje er en strukturell endring → stripa bygges nå');
  assert.ok(outEl.children[0].classList.contains('param-form'));
});

test('refresh: cellIdx uten NOEN forutgående decorate-kall → no-op (ingen krasj) — refresh alene kan aldri initialisere en celle', () => {
  const { ParamForms, cellEl, outEl } = freshEnv();
  assert.doesNotThrow(() => ParamForms.refresh(0, 'x = 3  #@param {type:"number"}'));
  assert.strictEqual(outEl.children.length, 1, 'ingen decorate-tilstand for idx 0 ennå → refresh er en total no-op');
});

// ParamForms.reorder er fjernet (widget-plassering-fasen): _insertStrip
// setter nå .param-form inn INNI .nb-output på riktig plass ved
// KONSTRUKSJON (FØR en evt. .ui-controls, alltid FØR .nb-output-body) — se
// ny test under "widget-plassering-fasen: strip-plassering" for dekning av
// dette. Ingen reassert-i-ettertid-funksjon å teste lenger.

// ---- resetDocument: glemmer skjema-tilstand + kansellerer ventende run:auto-timere ----

test('resetDocument: kansellerer en ventende run:auto-slider-debounce (nytt dokument skal ikke kunne kjøre en gammel celle)', async () => {
  const { ParamForms, cellEl, outEl, runCellCalls } = freshEnv();
  const src = 'x = 3  #@param {type:"slider", min:0, max:10, run:"auto"}';
  ParamForms.decorate(0, cellEl, src, 'python');
  const slider = outEl.children[0].children[0].children[1];
  slider.value = '9';
  slider.dispatchEvent({ type: 'input' }); // starter en 150ms-timer

  ParamForms.resetDocument();
  await wait(220);
  assert.deepStrictEqual(runCellCalls, [], 'timeren fra FØR resetDocument skal ALDRI fyre');
});

test('resetDocument: glemmer skjema-tilstand — en senere refresh for samme cellIdx er en no-op (ingen decorate-tilstand igjen)', () => {
  const { ParamForms, cellEl, outEl } = freshEnv();
  ParamForms.decorate(0, cellEl, 'x = 3  #@param {type:"number"}', 'python');
  ParamForms.resetDocument();
  assert.doesNotThrow(() => ParamForms.refresh(0, 'x = 4  #@param {type:"number"}'));
  // cellEl selv er urørt av resetDocument (den fjerner ikke DOM-noder — det
  // er cells.js sin fulle render() som gjør det ved neste dokumentlasting);
  // poenget her er at den GAMLE _forms-oppføringen ikke lenger styrer noe.
});

// ---- R-språk: boolean skrives som TRUE/FALSE, ikke True/False -------------

test('R-modus: boolean-kontroll skriver TRUE/FALSE (ikke Python sin True/False)', () => {
  const { ParamForms, cellEl, outEl, updateCellSourceCalls } = freshEnv();
  const src = 'flag <- TRUE  #@param {type:"boolean"}';
  ParamForms.decorate(0, cellEl, src, 'r');
  const checkbox = outEl.children[0].children[0].children[1];
  checkbox.checked = false;
  checkbox.dispatchEvent({ type: 'change' });
  assert.deepStrictEqual(updateCellSourceCalls[0], [0, 'flag <- FALSE  #@param {type:"boolean"}']);
});

test('komposisjon: decorate mottaker/bruker lang=\'r\' for #%% r-celle i python-dokument → boolean skriver TRUE/FALSE', () => {
  // Simuler en python-modus notebook som inkluderer en r-celle.
  // Cells.paramLangForType ville gitt 'r' basert på cellen sin type/deklarasjon.
  const { ParamForms, cellEl, outEl, updateCellSourceCalls } = freshEnv();

  // Decorate kalles med lang='r' — stemmer med at cellen er #%% r.
  const src = 'show_details <- FALSE #@param {type:"boolean"}';
  ParamForms.decorate(2, cellEl, src, 'r');

  assert.strictEqual(outEl.children.length, 2, 'stripa bygd');
  const strip = outEl.children[0];
  assert.ok(strip.classList.contains('param-form'));

  const checkboxRow = strip.children[0];
  const checkbox = checkboxRow.children[1];
  assert.strictEqual(checkbox.type, 'checkbox', 'boolean → checkbox');
  assert.strictEqual(checkbox.checked, false, 'seedet fra FALSE');

  // Endre til true — skal skrive TRUE (R-stil), ikke True (Python-stil)
  checkbox.checked = true;
  checkbox.dispatchEvent({ type: 'change' });

  assert.strictEqual(updateCellSourceCalls.length, 1);
  assert.deepStrictEqual(updateCellSourceCalls[0], [2, 'show_details <- TRUE #@param {type:"boolean"}'],
    'R-modus skriver TRUE, ikke True');
});

// ---- Task 3: per-kontroll plassering (placement:"top"|"bottom"|"left") ---

test('decorate: placement:"left" havner i den DELTE .nb-strips-left (ikke direkte .param-form-barn av .nb-output)', () => {
  const { ParamForms, cellEl, outEl } = freshEnv();
  const src = 'x = 3  #@param {type:"slider", min:0, max:10, placement:"left"}';
  ParamForms.decorate(0, cellEl, src, 'python');

  const leftWrap = outEl.children.find((c) => c.classList.contains('nb-strips-left'));
  assert.ok(leftWrap, '.nb-strips-left opprettet inni .nb-output');
  assert.ok(!outEl.children.some((c) => c.classList.contains('param-form')),
    'ingen .param-form direkte i .nb-output — den lever inni sidekolonnen');
  const strip = leftWrap.children.find((c) => c.classList.contains('param-form'));
  assert.ok(strip, '.param-form inni .nb-strips-left');
  assert.strictEqual(strip.getAttribute('data-pos'), 'left');
  assert.strictEqual(strip.children.length, 1);
});

test('decorate: placement:"bottom" oppretter en EGEN .param-form[data-pos=bottom], adskilt fra en top-plassert linje', () => {
  const { ParamForms, cellEl, outEl } = freshEnv();
  const src = 'a = 1  #@param {type:"number"}\nb = 2  #@param {type:"number", placement:"bottom"}';
  ParamForms.decorate(0, cellEl, src, 'python');

  const strips = outEl.children.filter((c) => c.classList.contains('param-form'));
  assert.strictEqual(strips.length, 2, 'to separate .param-form-noder — én per posisjon');
  const topStrip = strips.find((s) => s.getAttribute('data-pos') === 'top');
  const bottomStrip = strips.find((s) => s.getAttribute('data-pos') === 'bottom');
  assert.ok(topStrip && bottomStrip);
  assert.strictEqual(topStrip.children.length, 1);
  assert.strictEqual(bottomStrip.children.length, 1);
});

test('decorate: uten egen placement følger cellens widgets=left-default (nb-widgets-left på .nb-output)', () => {
  const { ParamForms, cellEl, outEl } = freshEnv();
  outEl.className = 'nb-output nb-widgets-left';
  const src = 'x = 3  #@param {type:"number"}';
  ParamForms.decorate(0, cellEl, src, 'python');

  const leftWrap = outEl.children.find((c) => c.classList.contains('nb-strips-left'));
  assert.ok(leftWrap, 'cellens default (left) brukt — linja har ingen egen placement');
  assert.ok(leftWrap.children.find((c) => c.classList.contains('param-form')));
});

test('decorate: linjens EGEN placement overstyrer cellens widgets=bottom-default', () => {
  const { ParamForms, cellEl, outEl } = freshEnv();
  outEl.className = 'nb-output nb-widgets-bottom';
  const src = 'x = 3  #@param {type:"number", placement:"top"}';
  ParamForms.decorate(0, cellEl, src, 'python');

  const strips = outEl.children.filter((c) => c.classList.contains('param-form'));
  assert.strictEqual(strips.length, 1);
  assert.strictEqual(strips[0].getAttribute('data-pos'), 'top', 'linje-nivå placement vant over cellens bottom-default');
});

test('refresh: placement ENDRET på samme linje (top → left) → bygges på nytt, verdien overlever, ingen dobling', () => {
  const { ParamForms, cellEl, outEl } = freshEnv();
  const src = 'x = 3  #@param {type:"slider", min:0, max:10}';
  ParamForms.decorate(0, cellEl, src, 'python');
  const oldStrip = outEl.children.find((c) => c.classList.contains('param-form') && c.getAttribute('data-pos') === 'top');
  assert.strictEqual(oldStrip.children.length, 1);

  const newSrc = 'x = 7  #@param {type:"slider", min:0, max:10, placement:"left"}';
  ParamForms.refresh(0, newSrc);

  // Den gamle top-stripa henger igjen som node (samme cellIdx-lagring), men
  // skal nå være TOM — ingen duplikat kontroll der.
  const topStripAfter = outEl.children.find((c) => c.classList.contains('param-form') && c.getAttribute('data-pos') === 'top');
  assert.ok(!topStripAfter || topStripAfter.children.length === 0, 'ingen kontroll igjen i den gamle top-posisjonen');

  const leftWrap = outEl.children.find((c) => c.classList.contains('nb-strips-left'));
  assert.ok(leftWrap, 'ny .nb-strips-left opprettet');
  const leftStrip = leftWrap.children.find((c) => c.classList.contains('param-form'));
  assert.strictEqual(leftStrip.children.length, 1, 'nøyaktig én kontroll i den nye stripa — ingen dobling');
  const input = leftStrip.children[0].children[1];
  assert.strictEqual(Number(input.value), 7, 'verdien (7, fra kildeteksten) overlever plassering-byttet');
});

// Final-review-fiks (Low): param-før-ui-invarianten i den DELTE venstre-
// kolonnen ("param-form skal alltid stå FØR ui-controls", se app.css sin
// .nb-output-kommentar og js/ui.js sin _ensureStrip-kommentar) må overleve en
// STRUKTURELL ombygging av #@param-skjemaet, ikke bare gjelde ved første
// _insertStrip-kall. Feilen (før fiksen): _insertStrip sin left-gren brukte
// wrap.appendChild(strip) — det setter alltid den FERSKE param-form-noden
// BAKERST i wrap, selv når en .ui-controls-node (satt inn av js/ui.js under
// en TIDLIGERE kjøring, og fortsatt liggende i samme delte wrap) allerede
// bor der. Fiksen bruker insertBefore(strip, _findChild(wrap, 'ui-controls'))
// (null-safe — ingen ui-controls-node ennå → insertBefore(strip, null)
// oppfører seg som appendChild).
test('_insertStrip (left): param-form settes inn FØR en allerede tilstedeværende .ui-controls i den delte venstre-kolonnen, OGSÅ etter en strukturell rebuild', () => {
  const { ParamForms, cellEl, outEl } = freshEnv();
  const src = 'x = 3  #@param {type:"slider", min:0, max:10, placement:"left"}';
  ParamForms.decorate(0, cellEl, src, 'python');
  const wrap = outEl.children.find((c) => c.classList.contains('nb-strips-left'));
  assert.ok(wrap, '.nb-strips-left opprettet');

  // Simuler js/ui.js sin _ensureStrip: en .ui-controls-node for 'left' legges
  // inn i den DELTE wrap-en (slik en samtidig venstre-plassert ui.slider(...)
  // ville gjort under en kjøring).
  const uiStrip = new FakeEl('div');
  uiStrip.className = 'ui-controls';
  uiStrip.setAttribute('data-pos', 'left');
  wrap.appendChild(uiStrip);
  assert.deepStrictEqual(wrap.children.map((c) => c.className), ['param-form', 'ui-controls'],
    'param-form FØR ui-controls rett etter decorate');

  // Strukturell endring i kildeteksten (en ny #@param-linje lagt til) →
  // ParamForms._build fjerner den gamle param-form-noden og bygger en FERSK
  // — uten fiksen endte den ferske noden BAKERST i wrap, altså ETTER
  // ui-controls-noden fra js/ui.js (brutt rekkefølge).
  const newSrc = src + '\ny = 1  #@param {type:"number", placement:"left"}';
  ParamForms.refresh(0, newSrc);

  assert.deepStrictEqual(wrap.children.map((c) => c.className), ['param-form', 'ui-controls'],
    'param-form fortsatt FØR ui-controls etter strukturell rebuild — invarianten overlever');
});

test('mixed placements i én celle (topp-slider + venstre-dropdown + bunn-checkbox) → tre containere populert riktig', () => {
  const { ParamForms, cellEl, outEl } = freshEnv();
  const src = [
    'n = 3  #@param {type:"slider", min:0, max:10}',
    'name = \'a\'  #@param ["a", "b"] {placement:"left"}',
    'flag = True  #@param {type:"boolean", placement:"bottom"}',
  ].join('\n');
  ParamForms.decorate(0, cellEl, src, 'python');

  const topStrip = outEl.children.find((c) => c.classList.contains('param-form') && c.getAttribute('data-pos') === 'top');
  const bottomStrip = outEl.children.find((c) => c.classList.contains('param-form') && c.getAttribute('data-pos') === 'bottom');
  const leftWrap = outEl.children.find((c) => c.classList.contains('nb-strips-left'));
  assert.ok(topStrip && bottomStrip && leftWrap, 'alle tre containere finnes');

  assert.strictEqual(topStrip.children.length, 1);
  assert.strictEqual(topStrip.children[0].children[1].type, 'range');

  const leftStrip = leftWrap.children.find((c) => c.classList.contains('param-form'));
  assert.strictEqual(leftStrip.children.length, 1);
  assert.strictEqual(leftStrip.children[0].children[1].tag, 'select');

  assert.strictEqual(bottomStrip.children.length, 1);
  assert.strictEqual(bottomStrip.children[0].children[1].type, 'checkbox');
});

test('sweep: fjerner ALLE #@param-linjer (spredt over topp+bunn+venstre samtidig) → alle tre stripe-containere tømmes/fjernes', () => {
  const { ParamForms, cellEl, outEl } = freshEnv();
  const src = [
    'n = 3  #@param {type:"slider", min:0, max:10}',
    'name = \'a\'  #@param ["a", "b"] {placement:"left"}',
    'flag = True  #@param {type:"boolean", placement:"bottom"}',
  ].join('\n');
  ParamForms.decorate(0, cellEl, src, 'python');
  assert.ok(outEl.children.some((c) => c.classList.contains('param-form')));
  assert.ok(outEl.children.some((c) => c.classList.contains('nb-strips-left')));

  ParamForms.refresh(0, 'n = 3\nname = \'a\'\nflag = True');

  assert.ok(!outEl.children.some((c) => c.classList.contains('param-form')),
    'ingen .param-form igjen direkte i .nb-output (topp+bunn er borte)');
  const leftWrap = outEl.children.find((c) => c.classList.contains('nb-strips-left'));
  assert.ok(!leftWrap || !leftWrap.children.some((c) => c.classList.contains('param-form')),
    'venstre-kolonnen er også tom (ingen restanse)');
});

// ---- Kjør-chip (run-chip): ikke-auto endring venter på å bli kjørt -------
// Spec: se prosjekt-briefen for param-run-chip-grenen. Chippen er ÉN PER
// CELLE, bygget inn i den TOPP-MESTE eksisterende .param-form-stripa (top >
// bottom > left) som SISTE barn (etter feltradene) — se _build/_showRunChip
// i js/param-forms.js.

test('Kjør-chip: ikke-auto commit → chip vises som SISTE barn i stripa, med "Kjør"/▶ i teksten', () => {
  const { ParamForms, cellEl, outEl } = freshEnv();
  const src = 'name = \'a\'  #@param ["a", "b", "c"]';
  ParamForms.decorate(0, cellEl, src, 'python');
  const strip = outEl.children[0];
  assert.strictEqual(strip.children.length, 1, 'ingen chip før noen endring');

  const select = strip.children[0].children[1];
  select.value = 'b';
  select.dispatchEvent({ type: 'change' });

  assert.strictEqual(strip.children.length, 2, 'chip lagt til som SISTE barn');
  const chip = strip.children[1];
  assert.ok(chip.classList.contains('param-form-runchip'));
  assert.ok(!chip.classList.contains('param-form-row'), 'chippen er ikke en kontroll-rad');
  assert.ok(chip.textContent.indexOf('Kjør') !== -1, 'teksten inneholder "Kjør"');
  assert.ok(chip.textContent.indexOf('▶') !== -1, 'teksten inneholder ▶');
});

test('Kjør-chip: mixed-plassering (topp-slider run:auto + venstre-dropdown ikke-auto) → chippen havner i den TOPP-MESTE stripa (top), ikke i venstre-kolonnen', () => {
  const { ParamForms, cellEl, outEl } = freshEnv();
  const src = [
    'n = 3  #@param {type:"slider", min:0, max:10, run:"auto"}',
    'name = \'a\'  #@param ["a", "b"] {placement:"left"}',
  ].join('\n');
  ParamForms.decorate(0, cellEl, src, 'python');

  const leftWrap = outEl.children.find((c) => c.classList.contains('nb-strips-left'));
  const leftStrip = leftWrap.children.find((c) => c.classList.contains('param-form'));
  const select = leftStrip.children[0].children[1];
  select.value = 'b';
  select.dispatchEvent({ type: 'change' });

  const topStrip = outEl.children.find((c) => c.classList.contains('param-form') && c.getAttribute('data-pos') === 'top');
  assert.strictEqual(topStrip.children.length, 2, 'chip lagt til i TOPP-stripa (1 rad + chip)');
  assert.ok(topStrip.children[1].classList.contains('param-form-runchip'));
  assert.strictEqual(leftStrip.children.length, 1, 'venstre-stripa fikk INGEN chip (kun sin egen rad)');
});

test('Kjør-chip: celle med KUN en run:auto-kontroll → chip vises ALDRI', async () => {
  const { ParamForms, cellEl, outEl } = freshEnv();
  const src = 'x = 3  #@param {type:"slider", min:0, max:10, run:"auto"}';
  ParamForms.decorate(0, cellEl, src, 'python');
  const strip = outEl.children[0];
  const slider = strip.children[0].children[1];
  slider.value = '9';
  slider.dispatchEvent({ type: 'input' });
  await wait(220);
  assert.strictEqual(strip.children.length, 1, 'ingen chip lagt til for en run:auto-endring');
});

test('Kjør-chip: klikk kaller Cells.runCell(idx)', () => {
  const { ParamForms, cellEl, outEl, runCellCalls } = freshEnv();
  const src = 'name = \'a\'  #@param ["a", "b"]';
  ParamForms.decorate(5, cellEl, src, 'python');
  const strip = outEl.children[0];
  const select = strip.children[0].children[1];
  select.value = 'b';
  select.dispatchEvent({ type: 'change' });

  const chip = strip.children[strip.children.length - 1];
  chip.dispatchEvent({ type: 'click' });
  assert.deepStrictEqual(runCellCalls, [5], 'klikk kjørte riktig celle');
});

test('Kjør-chip: klikk nektes stille mens mdIsScriptRunning() er true (samme guard-mønster som resten av fila)', () => {
  const { ParamForms, cellEl, outEl, runCellCalls } = freshEnv({ scriptRunning: true });
  const src = 'name = \'a\'  #@param ["a", "b"]';
  ParamForms.decorate(0, cellEl, src, 'python');
  const strip = outEl.children[0];
  const select = strip.children[0].children[1];
  select.value = 'b';
  select.dispatchEvent({ type: 'change' });

  const chip = strip.children[strip.children.length - 1];
  chip.dispatchEvent({ type: 'click' });
  assert.deepStrictEqual(runCellCalls, [], 'nektet — scriptet kjører allerede');
});

test('Kjør-chip: ParamForms.onCellRan(idx) skjuler en synlig chip (speiler js/cells.js sin C._afterCellRun/clearAllStale)', () => {
  const { ParamForms, cellEl, outEl } = freshEnv();
  const src = 'name = \'a\'  #@param ["a", "b"]';
  ParamForms.decorate(2, cellEl, src, 'python');
  const strip = outEl.children[0];
  const select = strip.children[0].children[1];
  select.value = 'b';
  select.dispatchEvent({ type: 'change' });
  assert.strictEqual(strip.children.length, 2, 'chip synlig FØR kjøring');

  ParamForms.onCellRan(2);
  assert.strictEqual(strip.children.length, 1, 'chip fjernet fra DOM-en etter kjøring');

  // Idempotent — flere kall (f.eks. både enkelt-celle-suksess OG en
  // etterfølgende "Kjør alle" i samme tikk) skal ikke krasje.
  assert.doesNotThrow(() => ParamForms.onCellRan(2));
});

test('Kjør-chip: ParamForms.onCellRan for en cellIdx uten (eller uten synlig) chip → no-op, ingen krasj', () => {
  const { ParamForms } = freshEnv();
  assert.doesNotThrow(() => ParamForms.onCellRan(99));
});

test('Kjør-chip: strukturell ombygging (ParamForms.refresh → full _build) resetter en synlig chip', () => {
  const { ParamForms, cellEl, outEl } = freshEnv();
  const src = 'name = \'a\'  #@param ["a", "b"]';
  ParamForms.decorate(0, cellEl, src, 'python');
  const strip = outEl.children[0];
  const select = strip.children[0].children[1];
  select.value = 'b';
  select.dispatchEvent({ type: 'change' });
  assert.strictEqual(strip.children.length, 2, 'chip synlig');

  // Strukturell endring (en ny #@param-linje lagt til) → full _build, IKKE
  // in-place-oppdatering — chippen skal IKKE overleve inn i den ferske stripa.
  const newSrc = src + '\ny = 1  #@param {type:"number"}';
  ParamForms.refresh(0, newSrc);
  const newStrip = outEl.children[0];
  assert.notStrictEqual(newStrip, strip, 'stripa er ombygd (ny node)');
  assert.strictEqual(newStrip.children.length, 2, 'to kontroll-rader, INGEN chip i den ferske stripa');
});

test('Kjør-chip: resetDocument glemmer chip-tilstanden — en fersk decorate for samme cellIdx starter uten synlig chip', () => {
  const { ParamForms, cellEl, outEl } = freshEnv();
  const src = 'name = \'a\'  #@param ["a", "b"]';
  ParamForms.decorate(0, cellEl, src, 'python');
  const strip = outEl.children[0];
  const select = strip.children[0].children[1];
  select.value = 'b';
  select.dispatchEvent({ type: 'change' });
  assert.strictEqual(strip.children.length, 2, 'chip synlig FØR reset');

  ParamForms.resetDocument();

  // Speiler en fersk cellNode-bygging etter et nytt dokument lastes (se
  // js/cells.js sin C.contentLoaded → full render() → nye .nb-cell-noder).
  const cellEl2 = new FakeEl('div');
  cellEl2.className = 'nb-cell';
  const inputEl2 = new FakeEl('div'); inputEl2.className = 'nb-input';
  const outEl2 = new FakeEl('div'); outEl2.className = 'nb-output';
  const bodyEl2 = new FakeEl('div'); bodyEl2.className = 'nb-output-body';
  outEl2.appendChild(bodyEl2);
  cellEl2.appendChild(inputEl2);
  cellEl2.appendChild(outEl2);

  ParamForms.decorate(0, cellEl2, src, 'python');
  const strip2 = outEl2.children[0];
  assert.strictEqual(strip2.children.length, 1, 'ingen chip i den ferske stripa etter resetDocument');
});

// ---------- spec 4b Task 1b (4a-sluttreview Important 1): stale-span-racet ----------
//
// Cells.updateCellSource forsoner nå FØRST og returnerer cellens FERSKE
// kildetekst (js/cells.js) — _commit skal bruke DEN til å resynke st.source
// i stedet for å stole blindt på den newSource den selv beregnet fra sin
// egen (potensielt foreldede) closure-fangede kopi. Denne stubben ER
// feasible for å teste akkurat dette: global.Cells slås opp FERSKT av
// _commit ved HVER commit (ikke fanget ved decorate-tid), så testen kan
// overstyre stubbens returverdi MELLOM to commits og observere at den ANDRE
// commiten splicer mot den overstyrte (ferske), ikke den opprinnelig
// beregnede, kilden.
test('_commit: bruker Cells.updateCellSource sin returnerte FERSKE kilde til å resynke st.source, ikke den lokalt beregnede kopien', () => {
  const { ParamForms, cellEl, outEl, updateCellSourceCalls } = freshEnv();
  ParamForms.decorate(3, cellEl, 'n = 3  #@param\nm = 5  #@param', 'python');
  const strip = outEl.children[0];
  const nInput = strip.children[0].children[1];
  const mInput = strip.children[1].children[1];

  // Overstyr stubben (ETTER decorate — _commit slår opp global.Cells ferskt
  // ved hvert kall, se der): simuler at Cells.updateCellSource forsonet
  // #scriptInput FØRST (spec 4b Task 1a) og fant en usforsonet linje lagt
  // til ØVERST i cellen — den ferske kilden den returnerer har derfor én
  // ekstra linje foran, som flytter "m" sin lineIdx (1 → 2).
  global.Cells.updateCellSource = (idx, newSource) => {
    updateCellSourceCalls.push([idx, newSource]);
    return '# reconciled\n' + newSource;
  };

  nInput.value = '9';
  nInput.dispatchEvent({ type: 'change' });

  // Andre kontroll (m) endres nå: _freshEntryFor MÅ finne "m" i de
  // RESYNKEDE entries (lineIdx flyttet til 2 pga. den forsonede linja), og
  // writeValue MÅ splice mot den RESYNKEDE (3-linjers) st.source — ikke mot
  // den lokalt beregnede 2-linjers newSource fra forrige commit, som ville
  // mistet "# reconciled"-linja og feilplassert m sin nye verdi.
  mInput.value = '42';
  mInput.dispatchEvent({ type: 'change' });

  assert.strictEqual(updateCellSourceCalls.length, 2);
  assert.deepStrictEqual(
    updateCellSourceCalls[1],
    [3, '# reconciled\nn = 9  #@param\nm = 42  #@param'],
    'den andre commiten splicer mot den RETURNERTE ferske kilden (med den forsonede linja intakt)'
  );
});
