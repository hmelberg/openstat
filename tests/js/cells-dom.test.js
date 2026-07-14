'use strict';

// DOM-halvdel av cells.js (tikk-tilstandsmaskinen for auto-inngang/hint-chip)
// er ikke node-testbar uten en DOM — dette er en minimal hånd-stubbet DOM,
// installert som globaler FØR require('../../js/cells.js') slik at
// `typeof document !== 'undefined'`-porten åpner seg. Stubben er bevisst
// minimal (kun det cells.js DOM-halvdel faktisk bruker).

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const CELLS_PATH = path.join(__dirname, '..', '..', 'js', 'cells.js');

class FakeEl {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this._classes = new Set();
    this.dataset = {};
    this.style = {};
    this._listeners = {};
    this.hidden = false;
    this.value = '';
    this.id = '';
    this._text = '';
    this._html = '';
  }
  get classList() {
    const self = this;
    return {
      add: (...c) => c.forEach((x) => self._classes.add(x)),
      remove: (...c) => c.forEach((x) => self._classes.delete(x)),
      toggle: (c, force) => {
        const on = force === undefined ? !self._classes.has(c) : !!force;
        if (on) self._classes.add(c); else self._classes.delete(c);
        return on;
      },
      contains: (c) => self._classes.has(c),
    };
  }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return Array.from(this._classes).join(' '); }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  insertBefore(node) { this.children.push(node); node.parentNode = this; return node; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
  dispatchEvent(ev) { (this._listeners[ev.type] || []).forEach((fn) => fn(ev)); }
  set innerHTML(v) { this._html = v; this.children = []; }
  get innerHTML() { return this._html; }
  set textContent(v) { this._text = v; }
  get textContent() { return this._text; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  get nextSibling() { return null; }
  get parentNode() { return this._parentNode; }
  set parentNode(v) { this._parentNode = v; }
}

// Bygger en frisk DOM-stub + laster cells.js på nytt (modulets NB-tilstand
// er et closure-singleton, så et fersk require er nødvendig per scenario).
function freshEnv() {
  const scriptInputEl = new FakeEl('textarea');
  scriptInputEl.id = 'scriptInput';
  const containerEl = new FakeEl('div');
  containerEl.className = 'container';
  const bodyEl = new FakeEl('body');
  bodyEl.appendChild(containerEl);
  const wrapEl = new FakeEl('div');
  wrapEl.className = 'code-input-wrap';

  global.document = {
    getElementById: (id) => (id === 'scriptInput' ? scriptInputEl : null),
    querySelector: (sel) => {
      if (sel === '.container') return containerEl;
      if (sel === '.code-input-wrap') return wrapEl;
      return null;
    },
    querySelectorAll: () => [],
    createElement: (tag) => new FakeEl(tag),
  };

  let intervalCallback = null;
  global.setInterval = (fn) => { intervalCallback = fn; return 1; };
  global.clearInterval = () => {};

  let fakeNow = 1000000;
  Date.now = () => fakeNow;

  global.mdIsInputHidden = undefined;
  global.mdIsStackedLayout = undefined;
  global.requestAnimationFrame = () => {};
  global.purgePlots = undefined;

  delete require.cache[require.resolve(CELLS_PATH)];
  const C = require(CELLS_PATH);

  return {
    C,
    scriptInputEl,
    containerEl,
    wrapEl,
    tick() { fakeNow += 1000; if (intervalCallback) intervalCallback(); },
    typeInput(newValue) {
      scriptInputEl.value = newValue;
      scriptInputEl.dispatchEvent({ type: 'input' });
    },
  };
}

test('init med markører i aktiv modus → auto-åpner umiddelbart', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\nprint(1)\n';
  C.init('python');
  assert.strictEqual(C.active(), true);
});

test('init uten markører → inaktiv; programmatisk endring (uten input-event) → neste tikk auto-åpner', () => {
  const { C, scriptInputEl, tick } = freshEnv();
  scriptInputEl.value = 'print(1)\n';
  C.init('python');
  assert.strictEqual(C.active(), false, 'ingen markører ved init → forblir inaktiv');

  // Programmatisk .value-endring uten input-event (share-lenke/eksempel-stil).
  scriptInputEl.value = '#%% python\nprint(2)\n';
  tick();
  assert.strictEqual(C.active(), true, 'programmatisk injeksjon fanges av tikk og auto-åpner');
});

test('brukerskrevet markør (input-event) etterfulgt av rene tikk → ALDRI auto-åpning', () => {
  const { C, scriptInputEl, tick, typeInput } = freshEnv();
  scriptInputEl.value = 'print(1)\n';
  C.init('python');

  // Bruker skriver selv inn en markør — input-event fyres i samme vindu som
  // verdiendringen, så tikk-attribusjonen må klassifisere dette som skriving,
  // ikke programmatisk injeksjon.
  typeInput('#%% python\nprint(2)\n');

  for (let i = 0; i < 12; i++) tick(); // 12s pause etter skriving
  assert.strictEqual(C.active(), false, 'skriving skal aldri auto-åpne, uansett pauselengde');
});

test('exit({raw:true}) etterfulgt av programmatisk endring → rawOverride holder den lukket', () => {
  const { C, scriptInputEl, tick } = freshEnv();
  scriptInputEl.value = '#%% python\nprint(1)\n';
  C.init('python');
  assert.strictEqual(C.active(), true);

  C.exit({ raw: true });
  assert.strictEqual(C.active(), false);

  // Programmatisk endring (ingen input-event) mens rawOverride er satt.
  scriptInputEl.value = '#%% python\nprint(1)\nprint(2)\n';
  tick();
  assert.strictEqual(C.active(), false, 'rawOverride skal blokkere auto-inngang selv om innhold endres programmatisk');
});

test('syncTickBaseline() etter modusbytte-gjenoppretting sluker endringen: neste tikk auto-åpner IKKE (regresjon for finding 1)', () => {
  const { C, scriptInputEl, tick } = freshEnv();
  scriptInputEl.value = '#%% python\nprint(1)\n';
  C.init('python');
  assert.strictEqual(C.active(), true);

  // Simulerer switchEditorMode: bytt til en ustøttet modus (exit), gjenopprett
  // gammelt python-innhold ved retur (programmatisk .value-set uten input-event),
  // men kall syncTickBaseline() rett etter — akkurat som index.html nå gjør.
  C.setDocMode('brython');
  assert.strictEqual(C.active(), false, 'ustøttet modus → forlater notatboken');

  scriptInputEl.value = 'plain brython script\n';
  C.setDocMode('brython'); // no-op, already brython
  tick(); // ingen markører uansett, forblir inaktiv

  // Bytt tilbake til python: gjenopprett den lagrede python-teksten MED
  // markører (programmatisk, ingen input-event) og synk tikk-basislinjen —
  // dette er nøyaktig rekkefølgen index.html's switchEditorMode nå bruker.
  scriptInputEl.value = '#%% python\nprint(1)\n';
  C.setDocMode('python');
  C.syncTickBaseline();

  tick();
  assert.strictEqual(C.active(), false, 'syncTickBaseline skal hindre at gjenopprettingen leses som injeksjon');

  // Hint-chippen bestemmer i stedet: den skal vises fordi markører finnes.
  assert.strictEqual(C.hasMarkers(scriptInputEl.value), true);
});

test('contentLoaded() etter kryssmodus eksempel-lasting → auto-åpner (speiler loadExampleFile-mønsteret)', () => {
  const { C, scriptInputEl, tick } = freshEnv();
  scriptInputEl.value = 'print("plain python")\n';
  C.init('python');
  assert.strictEqual(C.active(), false, 'inaktiv på ren python');

  // loadExampleFile av et r-modus-notatbok-eksempel: editorContent[r] settes,
  // switchEditorMode('r') kjører → restore + setDocMode + syncTickBaseline,
  // deretter settes verdien (samme tekst) og contentLoaded() signaliseres.
  const rNotebook = '#%% r\nsummary(iris)\n#%% md\nhei\n';
  scriptInputEl.value = rNotebook;   // switchEditorMode-restore av editorContent.r
  C.setDocMode('r');
  C.syncTickBaseline();
  // switchEditorMode alene skal ikke auto-åpne …
  tick();
  assert.strictEqual(C.active(), false, 'modusbytte-heuristikken sluker gjenopprettingen');
  // … men det eksplisitte innlastingssignalet skal:
  C.contentLoaded();
  assert.strictEqual(C.active(), true, 'contentLoaded auto-åpner notatbok-dokument uavhengig av tick-heuristikken');
});

test('contentLoaded() nullstiller rawOverride: nytt dokument re-åpner etter Rå tekst-exit', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\nprint(1)\n';
  C.init('python');
  assert.strictEqual(C.active(), true);

  C.exit({ raw: true });
  assert.strictEqual(C.active(), false);

  // Nytt dokument med markører leveres (eksempel/share) → rawOverride
  // gjaldt det FORRIGE dokumentet og nullstilles.
  scriptInputEl.value = '#%% python\nprint(2)\n#%% md\nny\n';
  C.contentLoaded();
  assert.strictEqual(C.active(), true, 'nytt dokument skal re-åpne selv etter Rå tekst-valg');
});

test('contentLoaded() uten markører mens aktiv → forlater notatboken (rent dokument lastet)', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\nprint(1)\n';
  C.init('python');
  assert.strictEqual(C.active(), true);

  scriptInputEl.value = 'print("plain doc")\n';
  C.contentLoaded();
  assert.strictEqual(C.active(), false, 'rent dokument skal ikke bli stående i cellevisning');
});

// ---- beginRun (Task 9 bug (a)-fiks: kind-array justerer planen) ----

test('beginRun med kind-array: strippet preambel (kun #options.*) justeres, gir sinks — ikke trailing-fallback', () => {
  const { C, scriptInputEl } = freshEnv();
  // Speiler bug (a)-repro: preambelen er KUN et #options.*-direktiv, som
  // strippes bort før segmentering i index.html — segmentPlan (som jobber
  // på rå kildetekst) teller den likevel som et lederssegment (3 planslots),
  // mens kjøretiden faktisk bare produserer 2 segmenter (microdata-cellene).
  scriptInputEl.value = '#options.mode = microdata\n#%% microdata\nfoo\n#%% microdata\nbar\n';
  C.init('python');
  assert.strictEqual(C.active(), true);

  const sinks = C.beginRun(['microdata', 'microdata']); // faktiske kjøretids-kinds, uten preambelen
  assert.notStrictEqual(sinks, null, 'aligned plan skal gi sinks, ikke null → trailing-fallback');
  assert.strictEqual(sinks.length, 2);
});

test('beginRun med kind-array: eksakt match (ingen strippet preambel) → uendret plan, sinks', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\n1\n#%% r\n2\n';
  C.init('python');
  assert.strictEqual(C.active(), true);

  const sinks = C.beginRun(['pyodide', 'r']);
  assert.notStrictEqual(sinks, null);
  assert.strictEqual(sinks.length, 2);
});

test('beginRun med kind-array: reelt avvik (ingen 1:1-mapping) → null (trailing-fallback)', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\n1\n#%% r\n2\n';
  C.init('python');
  assert.strictEqual(C.active(), true);

  const sinks = C.beginRun(['pyodide', 'r', 'r']); // ingen justering gir dette
  assert.strictEqual(sinks, null);
});

test('beginRun(0) (tall, bakoverkompatibelt) → fortsatt null-sinks (runHybridR sin bevisste avvik-semantikk)', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\n1\n#%% r\n2\n';
  C.init('python');
  assert.strictEqual(C.active(), true);

  const sinks = C.beginRun(0);
  assert.strictEqual(sinks, null);
});

// ---- Fix 1: HTML-tillit for utrygt opphav (delte lenker / GitHub / dyplenker) ----

// Rekursiv innsamling av alle noder i notatbok-treet (stubben eksponerer
// children + _html/_text, så vi kan observere innerHTML- vs textContent-bruk).
function collectNodes(node, acc) {
  if (!node) return acc;
  acc.push(node);
  (node.children || []).forEach((c) => collectNodes(c, acc));
  return acc;
}
function nbRoot(containerEl) {
  const body = containerEl.parentNode;
  return body.children.find((c) => c.classList.contains('nb-root'));
}

test('contentLoaded({untrusted:true}) med html-celle → kilden eskapert (textContent), ingen live innerHTML', () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  C.init('python'); // tom editor → inaktiv
  const payload = '<img src=x onerror="window.__pwned=1">';
  scriptInputEl.value = '#%% md\nhei\n#%% html\n' + payload + '\n#%% python\nprint(1)\n';
  C.contentLoaded({ untrusted: true });
  assert.strictEqual(C.active(), true, 'notatbok-dokument auto-åpnes');

  const nodes = collectNodes(nbRoot(containerEl), []);
  const htmls = nodes.map((n) => n.innerHTML).filter(Boolean);
  assert.ok(!htmls.some((h) => h.includes('onerror')),
    'ingen node fikk payloaden satt som live innerHTML');
  const texts = nodes.map((n) => n.textContent).filter(Boolean);
  assert.ok(texts.some((tx) => tx.includes('onerror')),
    'kilden vises eskapert via textContent');
  const btn = nodes.find((n) => n.tag === 'button' && n.textContent === 'Vis HTML');
  assert.ok(btn, 'Vis HTML-knapp vises (tillit er false)');
  // md-cellen rendres uansett (trygg — markdown-it html:false som standard).
  assert.ok(texts.some((tx) => tx === 'hei'), 'md-celle rendres');
});

test('grantHtmlTrust() gjør html-celler live og re-rendrer hele notatboken', () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  C.init('python');
  const payload = '<img src=x onerror="window.__pwned=1">';
  scriptInputEl.value = '#%% html\n' + payload + '\n#%% python\nprint(1)\n';
  C.contentLoaded({ untrusted: true });
  // Før: eskapert, ingen live payload.
  let nodes = collectNodes(nbRoot(containerEl), []);
  assert.ok(!nodes.map((n) => n.innerHTML).filter(Boolean).some((h) => h.includes('onerror')));

  C.grantHtmlTrust();

  nodes = collectNodes(nbRoot(containerEl), []);
  const htmls = nodes.map((n) => n.innerHTML).filter(Boolean);
  assert.ok(htmls.some((h) => h.includes('onerror')),
    'html rendres live etter innvilget tillit');
  assert.ok(!nodes.some((n) => n.tag === 'button' && n.textContent === 'Vis HTML'),
    'Vis HTML-knappen er borte etter re-rendring');
});

test('contentLoaded() uten flagg gir betrodd dokument: html rendres live umiddelbart', () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  C.init('python');
  const payload = '<b id="hb">ok</b>';
  scriptInputEl.value = '#%% html\n' + payload + '\n#%% python\nprint(1)\n';
  C.contentLoaded(); // ingen untrusted-flagg → tillit nullstilles til true
  assert.strictEqual(C.active(), true);

  const nodes = collectNodes(nbRoot(containerEl), []);
  const htmls = nodes.map((n) => n.innerHTML).filter(Boolean);
  assert.ok(htmls.some((h) => h.includes('id="hb"')),
    'betrodd html rendres live');
  assert.ok(!nodes.some((n) => n.tag === 'button' && n.textContent === 'Vis HTML'),
    'ingen Vis HTML-knapp for betrodd dokument');
});

test('untrusted → contentLoaded() uten flagg gjenoppretter tillit (nytt dokument erstatter tilstand)', () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  C.init('python');
  const payload = '<img src=x onerror="window.__pwned=1">';
  // Først et utrygt dokument.
  scriptInputEl.value = '#%% html\n' + payload + '\n';
  C.contentLoaded({ untrusted: true });
  let nodes = collectNodes(nbRoot(containerEl), []);
  assert.ok(nodes.some((n) => n.tag === 'button' && n.textContent === 'Vis HTML'),
    'utrygt: knapp vises');
  // Så et betrodd dokument (eksempel/lokalt) → tillit nullstilles til true.
  scriptInputEl.value = '#%% html\n<b id="hb">ok</b>\n';
  C.contentLoaded();
  nodes = collectNodes(nbRoot(containerEl), []);
  assert.ok(nodes.map((n) => n.innerHTML).filter(Boolean).some((h) => h.includes('id="hb"')),
    'nytt betrodd dokument rendres live');
  assert.ok(!nodes.some((n) => n.tag === 'button' && n.textContent === 'Vis HTML'),
    'ingen knapp igjen etter betrodd lasting');
});

test('C.init slår opp #scriptInput kun én gang (finding 3: gjenbruk referanse)', () => {
  const { C, scriptInputEl } = freshEnv();
  const original = global.document.getElementById;
  let calls = 0;
  global.document.getElementById = (id) => { calls++; return original(id); };
  scriptInputEl.value = 'print(1)\n';
  C.init('python');
  assert.strictEqual(calls, 1, 'init skal hente #scriptInput én gang, ikke to');
});
