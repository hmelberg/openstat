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

// Minimal querySelector-motor for FakeEl (final-review F6): produksjonskoden
// bruker NØYAKTIG ett mønster mot elementer (ikke document) —
// '.klasse[data-attr="verdi"] .klasse' (etterkommer-kombinator av to
// sammensatte selektorer) — cells.js:683/900. Generisk nok til vilkårlig
// antall ledd, men støtter kun klasse- og attributt-deler (ingen tag/id),
// som er alt produksjonsselektorene faktisk bruker.
function parseCompoundSelector(compound) {
  var classes = [];
  var attrs = [];
  var re = /\.([\w-]+)|\[([\w-]+)(?:=("[^"]*"|'[^']*'|[^\]]*))?\]/g;
  var m;
  while ((m = re.exec(compound))) {
    if (m[1]) classes.push(m[1]);
    else attrs.push({ key: m[2], val: m[3] !== undefined ? m[3].replace(/^["']|["']$/g, '') : undefined });
  }
  return { classes: classes, attrs: attrs };
}
function matchesCompoundSelector(node, parsed) {
  for (var i = 0; i < parsed.classes.length; i++) {
    if (!(node.classList && node.classList.contains(parsed.classes[i]))) return false;
  }
  for (var j = 0; j < parsed.attrs.length; j++) {
    var a = parsed.attrs[j];
    var actual;
    if (a.key.indexOf('data-') === 0) {
      var camelKey = a.key.slice(5).replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); });
      actual = node.dataset ? node.dataset[camelKey] : undefined;
    } else {
      actual = node[a.key];
    }
    if (a.val !== undefined) { if (String(actual) !== a.val) return false; }
    else if (actual === undefined) return false;
  }
  return true;
}
function findAllMatchingDescendants(node, parsed, out) {
  (node.children || []).forEach(function (c) {
    if (matchesCompoundSelector(c, parsed)) out.push(c);
    findAllMatchingDescendants(c, parsed, out);
  });
}

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
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
  dispatchEvent(ev) { (this._listeners[ev.type] || []).forEach((fn) => fn(ev)); }
  focus() { if (global.document) global.document.activeElement = this; }
  // Speiler ekte DOM: å sette innerHTML='' (brukt av render()'s rebygging)
  // frakobler de gamle barna — final-review F6 sin "detached node midt i
  // kjøring"-scenario er utestbart kun hvis stubben faktisk frakobler dem.
  set innerHTML(v) {
    this._html = v;
    this.children.forEach((c) => { c.parentNode = null; });
    this.children = [];
  }
  get innerHTML() { return this._html; }
  // final-review F6: ekte tilkoblet-sjekk (walker parentNode-kjeden opp til
  // rot-sentinelen satt av freshEnv, IKKE bare "har en parentNode" — en node
  // som ble frakoblet via innerHTML='' beholder ingen parentNode, mens en
  // aldri-tilknyttet, fersk node (samme starttilstand) korrekt også regnes
  // som ikke tilkoblet).
  get isConnected() {
    let n = this;
    while (n) {
      if (n._attachedRoot) return true;
      n = n.parentNode;
    }
    return false;
  }
  set textContent(v) { this._text = v; }
  get textContent() { return this._text; }
  querySelector(sel) {
    if (!sel) return null;
    var parts = String(sel).trim().split(/\s+/).filter(Boolean).map(parseCompoundSelector);
    var candidates = [this];
    for (var i = 0; i < parts.length; i++) {
      var next = [];
      candidates.forEach(function (cand) {
        findAllMatchingDescendants(cand, parts[i], next);
      });
      candidates = next;
      if (!candidates.length) return null;
    }
    return candidates[0] || null;
  }
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
  bodyEl._attachedRoot = true; // final-review F6: rot-sentinel for isConnected-kjeden
  bodyEl.appendChild(containerEl);
  const wrapEl = new FakeEl('div');
  wrapEl.className = 'code-input-wrap';
  // Stub for "Restart & kjør alle" (Task 5): klikk-mål index.html eier i det
  // ekte dokumentet (btnRun) — her bare en klikkbar knapp vi kan observere.
  const btnRunEl = new FakeEl('button');
  btnRunEl.id = 'btnRun';
  let btnRunClicks = 0;
  btnRunEl.click = () => { btnRunClicks++; };

  global.document = {
    getElementById: (id) => {
      if (id === 'scriptInput') return scriptInputEl;
      if (id === 'btnRun') return btnRunEl;
      return null;
    },
    querySelector: (sel) => {
      if (sel === '.container') return containerEl;
      if (sel === '.code-input-wrap') return wrapEl;
      return null;
    },
    querySelectorAll: () => [],
    createElement: (tag) => new FakeEl(tag),
    activeElement: null,
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
    btnRunEl,
    getBtnRunClicks: () => btnRunClicks,
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

// final-review F1: et nytt dokument (eksempler, share/GitHub, dyplenker) skal
// alltid ugyldiggjøre en eventuell levende notatbok-sesjon FØR rendring,
// ellers kunne en celle kjørt i det nye dokumentet gjenbruke forrige
// dokuments e/_g/loads (kryss-dokument-kontaminering).
test('contentLoaded() kaller mdNotebookSession.invalidate() (sesjon fra forrige dokument ugyldiggjøres)', () => {
  const { C, scriptInputEl } = freshEnv();
  let invalidated = 0;
  global.mdNotebookSession = { invalidate: () => { invalidated++; } };
  scriptInputEl.value = '#%% python\nprint(1)\n';
  C.contentLoaded();
  assert.strictEqual(invalidated, 1, 'invalidate() skal kalles ved contentLoaded()');
  delete global.mdNotebookSession;
});

test('contentLoaded() uten mdNotebookSession (stub-DOM) → ingen krasj', () => {
  const { C, scriptInputEl } = freshEnv();
  delete global.mdNotebookSession;
  scriptInputEl.value = '#%% python\nprint(1)\n';
  assert.doesNotThrow(() => C.contentLoaded());
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

// ---- segmentDisplay (Task 10: notatbok-visningspolicy, spec §4 "Display policy") ----

test('segmentDisplay: preambel-segment er ikke eksplisitt, celle-segmenter er', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = 'print(1)\n#%% python\n2 + 1\n#%% python\n3 + 4\n';
  C.init('python');
  assert.strictEqual(C.active(), true);

  const sinks = C.beginRun(['pyodide', 'pyodide', 'pyodide']); // preambel + 2 celler
  assert.notStrictEqual(sinks, null);
  assert.deepStrictEqual(C.segmentDisplay(0), { explicit: false }, 'preambelen skal beholde vis-alt');
  assert.deepStrictEqual(C.segmentDisplay(1), { explicit: true });
  assert.deepStrictEqual(C.segmentDisplay(2), { explicit: true });
});

test('segmentDisplay: strippet preambel justeres bort — segment 0 er da den første cellen (eksplisitt)', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#options.mode = python\n#%% python\n1\n#%% python\n2\n';
  C.init('python');
  assert.strictEqual(C.active(), true);

  // Kjøretiden strippet #options.*-preambelen bort før segmentering — kun
  // 2 faktiske segmenter (samme bug-mønster som beginRun-testene over).
  const sinks = C.beginRun(['pyodide', 'pyodide']);
  assert.notStrictEqual(sinks, null);
  assert.deepStrictEqual(C.segmentDisplay(0), { explicit: true });
  assert.deepStrictEqual(C.segmentDisplay(1), { explicit: true });
});

test('segmentDisplay: reelt planavvik (beginRun → null) gir segmentDisplay → null for alle indekser', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\n1\n#%% r\n2\n';
  C.init('python');
  assert.strictEqual(C.active(), true);

  const sinks = C.beginRun(['pyodide', 'r', 'r']); // ingen 1:1-justering finnes
  assert.strictEqual(sinks, null);
  assert.strictEqual(C.segmentDisplay(0), null);
  assert.strictEqual(C.segmentDisplay(1), null);
});

test('segmentDisplay: notatbok inaktiv → null', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = 'print(1)\n';
  C.init('python');
  assert.strictEqual(C.active(), false);
  assert.strictEqual(C.segmentDisplay(0), null);
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

// ---- C.runCell (Task 2: per-celle-kjøring mot levende sesjon, fase B1) ----
// window.mdRunNotebookCell stubbes her (den ekte implementasjonen lever i
// index.html — sesjon/Pyodide/DuckDB er utenfor rekkevidde for et node-test).

function cellParts(containerEl, idx) {
  const root = nbRoot(containerEl);
  const wrap = root.children.find((n) => n.classList && n.classList.contains('nb-cell') &&
    n.dataset.idx === String(idx));
  const nodes = collectNodes(wrap, []);
  const ta = nodes.find((n) => n.tag === 'textarea');
  const out = nodes.find((n) => n.classList && n.classList.contains('nb-output'));
  const input = nodes.find((n) => n.classList && n.classList.contains('nb-input'));
  const runBtn = nodes.find((n) => n.tag === 'button' && n.classList && n.classList.contains('nb-runbtn'));
  return { wrap, ta, out, input, runBtn };
}

// .nb-bar (Task 5): sesjonschip + Restart-knapp lever der, ikke inni en celle.
function nbBar(containerEl) {
  const root = nbRoot(containerEl);
  return root.children.find((n) => n.classList && n.classList.contains('nb-bar'));
}
function sessionChipEl(containerEl) {
  const bar = nbBar(containerEl);
  return bar && bar.children.find((n) => n.classList && n.classList.contains('nb-session-chip'));
}
function restartBtnEl(containerEl) {
  const bar = nbBar(containerEl);
  return bar && bar.children.find((n) => n.tag === 'button' && n.classList && n.classList.contains('nb-restart-btn'));
}

test('runCell: eksplisitt python-celle → riktig payload (kind/cellIdx/nb), rendrer kun i egen slot', async () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 2\n#%% python\na + 3\n';
  C.init('python');
  assert.strictEqual(C.active(), true);

  let capturedPayload = null;
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = (payload) => {
    capturedPayload = payload;
    return Promise.resolve({ text: '5' });
  };

  await C.runCell(1);

  assert.ok(capturedPayload, 'mdRunNotebookCell skal kalles for en kjørbar celle');
  assert.strictEqual(capturedPayload.kind, 'pyodide');
  assert.strictEqual(capturedPayload.cellIdx, 1);
  assert.deepStrictEqual(capturedPayload.nb, { echo: false, last: true });

  const cell0 = cellParts(containerEl, 0);
  const cell1 = cellParts(containerEl, 1);
  assert.strictEqual(cell1.out.textContent, '5', 'resultatet rendres i cellens egen slot');
  assert.strictEqual(cell0.out.textContent, '', 'cell 0 sin slot er urørt av cell 1 sin kjøring');
});

test('runCell: {error} → pre.error i cellens egen slot', async () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% python\n1/0\n';
  C.init('python');
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = () => Promise.resolve({ error: 'ZeroDivisionError' });

  await C.runCell(0);

  const { out } = cellParts(containerEl, 0);
  const errNode = out.children.find((n) => n.tag === 'pre' && n.classList.contains('error'));
  assert.ok(errNode, 'feilen skal vises som pre.error');
  assert.strictEqual(errNode.textContent, 'ZeroDivisionError');
});

// final-review F6: en strukturell re-rendring (render(), f.eks. utløst av en
// samtidig redigering et annet sted) kan skje MENS en celle-kjøring pågår.
// out-noden fanget ved kjørestart (c._out) er da frakoblet av render()'ens
// NB.root.innerHTML=''-rebygging — uten en requery ville resultatet forsvinne
// stille inn i en node ingen lenger ser.
test('runCell: struktur-re-render midt i kjøring → resultatet rendres i cellens GJELDENDE slot, ikke den frakoblede', async () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 1\n#%% python\na + 1\n';
  C.init('python');
  global.mdIsScriptRunning = () => false;

  var resolveRun;
  global.mdRunNotebookCell = () => new Promise((res) => { resolveRun = res; });

  const runPromise = C.runCell(1);
  const staleOut = cellParts(containerEl, 1).out;
  assert.strictEqual(staleOut.isConnected, true, 'sanity: slot er tilkoblet før re-rendring');

  // Strukturendring midt i kjøringen (samme celletekst → cellen finnes
  // fortsatt på idx 1, men i en HELT NY DOM-node etter render()'ens rebygging).
  C.refreshFromScript();
  assert.strictEqual(staleOut.isConnected, false, 'den gamle noden er frakoblet etter re-rendring');

  resolveRun({ text: '2' });
  await runPromise;

  const freshOut = cellParts(containerEl, 1).out;
  assert.notStrictEqual(freshOut, staleOut, 'cellens slot er en annen node-instans etter rebygging');
  assert.strictEqual(freshOut.textContent, '2', 'resultatet endte i cellens GJELDENDE slot');
  assert.strictEqual(staleOut.textContent, '', 'den frakoblede, gamle noden fikk ALDRI resultatet');
});

test('runCell: struktur-re-render fjerner cellen midt i kjøring → resultatet droppes med console.warn, ingen krasj', async () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 1\n#%% python\na + 1\n';
  C.init('python');
  global.mdIsScriptRunning = () => false;

  var resolveRun;
  global.mdRunNotebookCell = () => new Promise((res) => { resolveRun = res; });

  const runPromise = C.runCell(1);

  // Cellen som kjører (idx 1) fjernes helt fra dokumentet før resultatet kommer.
  scriptInputEl.value = '#%% python\na = 1\n';
  C.refreshFromScript();

  const origWarn = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  try {
    resolveRun({ text: '2' });
    await assert.doesNotReject(runPromise);
  } finally {
    console.warn = origWarn;
  }
  assert.strictEqual(warned, 1, 'console.warn skal kalles når cellens slot ikke lenger finnes');
  // Gjenværende celle 0 sin slot skal være urørt av det droppede resultatet.
  assert.strictEqual(cellParts(containerEl, 0).out.textContent, '');
});

test('runCell: md-celle → ingen-op (mdRunNotebookCell kalles ikke)', async () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% md\nhei\n#%% python\n1\n';
  C.init('python');
  let called = false;
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = () => { called = true; return Promise.resolve({ text: '' }); };

  await C.runCell(0);
  assert.strictEqual(called, false, 'en md-celle skal aldri trigge en kjøring');
});

test('runCell: nekter mens mdIsScriptRunning() er true (kaller ikke mdRunNotebookCell)', async () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\n1\n';
  C.init('python');
  let called = false;
  global.mdIsScriptRunning = () => true;
  global.mdRunNotebookCell = () => { called = true; return Promise.resolve({ text: 'x' }); };

  await C.runCell(0);
  assert.strictEqual(called, false, 'skal nekte å kjøre mens en annen kjøring pågår');
});

test('runCell: flusher ventende redigering synkront FØR kjøring (kanonisk #scriptInput oppdatert)', async () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 2\n';
  C.init('python');
  const { ta } = cellParts(containerEl, 0);
  ta.value = 'a = 10\n';
  ta.dispatchEvent({ type: 'input' }); // starter 250ms-debouncen (ekte timer)
  assert.strictEqual(scriptInputEl.value, '#%% python\na = 2\n',
    'debouncen har ikke rukket å fyre ennå — #scriptInput er fortsatt den gamle teksten');

  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = () => Promise.resolve({ text: '10' });

  await C.runCell(0);

  assert.strictEqual(scriptInputEl.value, '#%% python\na = 10\n',
    'runCell skal flushe debouncen synkront FØR kjøringen starter');
});

// ---- C.runCell: R-modus per-celle-kjøring (Task 4, fase B1) ----
// index.html sin mdRunNotebookCell/webRShelter.captureR er utenfor rekkevidde
// for et node-test (ingen ekte webR her) — disse testene dekker KUN
// cells.js sin DOM-halvdel: riktig kind i payload for en r-celle, og at
// {rparts}/{notice} kontraktene (Task 4 sin utvidelse av returverdien)
// rendres riktig inn i cellens EGEN slot.

test('runCell: r-celle i r-modus → payload.kind er "r"', async () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% r\nx <- 1:10\n';
  C.init('r');
  assert.strictEqual(C.active(), true);

  let capturedPayload = null;
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = (payload) => {
    capturedPayload = payload;
    return Promise.resolve({ rparts: [] });
  };

  await C.runCell(0);

  assert.ok(capturedPayload, 'mdRunNotebookCell skal kalles for en r-celle');
  assert.strictEqual(capturedPayload.kind, 'r');
  assert.strictEqual(capturedPayload.cellIdx, 0);
});

test('runCell: {rparts} → rendres via window.renderROutputParts inn i cellens egen slot (bilde-bærende R-output)', async () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% r\nx <- 1:10\n#%% r\nsummary(x)\n';
  C.init('r');

  let calledWith = null;
  global.renderROutputParts = (parts, target) => { calledWith = { parts, target }; };
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = () => Promise.resolve({ rparts: [{ type: 'text', text: 'Min. 1st Qu. ...' }] });

  await C.runCell(1);

  const cell1 = cellParts(containerEl, 1);
  assert.ok(calledWith, 'renderROutputParts skal kalles for {rparts}');
  assert.deepStrictEqual(calledWith.parts, [{ type: 'text', text: 'Min. 1st Qu. ...' }]);
  assert.strictEqual(calledWith.target, cell1.out, 'rendres inn i DENNE cellens egen .nb-output, ikke en delt/global target');

  delete global.renderROutputParts;
});

test('runCell: {notice} → pre.nb-notice (ikke pre.error) i cellens egen slot (dashboard/mixed-mode begrensningsmeldinger)', async () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% r\ndashboard(title = "x")\n';
  C.init('r');
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = () => Promise.resolve({ notice: 'Dashboard-celler krever Kjør alle (fase B2)' });

  await C.runCell(0);

  const { out } = cellParts(containerEl, 0);
  const noticeNode = out.children.find((n) => n.tag === 'pre' && n.classList.contains('nb-notice'));
  const errNode = out.children.find((n) => n.tag === 'pre' && n.classList.contains('error'));
  assert.ok(noticeNode, 'begrensningsmeldingen skal vises som pre.nb-notice');
  assert.strictEqual(noticeNode.textContent, 'Dashboard-celler krever Kjør alle (fase B2)');
  assert.strictEqual(errNode, undefined, 'skal IKKE rendres som pre.error (den er rød/alarmerende, dette er ikke en feil)');
});

// ---- Task 5 (fase B1): kjøreknapper, Shift/Ctrl+Enter, stale-markering,
// sesjonschip + Restart ----------------------------------------------------

function fakeKeydown(overrides) {
  return Object.assign({
    type: 'keydown', key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false,
    _prevented: false,
    preventDefault() { this._prevented = true; },
  }, overrides);
}

test('kjøreknapp finnes kun på kode-celler, ikke på md/html/skip', () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% python\n1\n#%% md\nhei\n#%% html\n<b>x</b>\n#%% skip\nx\n';
  C.init('python');
  assert.strictEqual(C.active(), true);

  assert.ok(cellParts(containerEl, 0).runBtn, 'python-celle har kjøreknapp');
  assert.strictEqual(cellParts(containerEl, 1).runBtn, undefined, 'md-celle har INGEN kjøreknapp');
  assert.strictEqual(cellParts(containerEl, 2).runBtn, undefined, 'html-celle har INGEN kjøreknapp');
  assert.strictEqual(cellParts(containerEl, 3).runBtn, undefined, 'skip-celle har INGEN kjøreknapp');
});

test('kjøreknapp-klikk kaller C.runCell(idx)', async () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 1\n#%% python\na + 1\n';
  C.init('python');

  let calledIdx = null;
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = (payload) => { calledIdx = payload.cellIdx; return Promise.resolve({ text: '2' }); };

  const cell1 = cellParts(containerEl, 1);
  cell1.runBtn.dispatchEvent({ type: 'click' });
  assert.strictEqual(calledIdx, 1);
});

test('Shift+Enter i cellens tekstfelt: preventDefault, kjører cellen og flytter fokus til NESTE kode-celle', () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 1\n#%% md\nhei\n#%% python\na + 1\n';
  C.init('python');

  let calledIdx = null;
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = (payload) => { calledIdx = payload.cellIdx; return Promise.resolve({ text: '2' }); };

  const cell0 = cellParts(containerEl, 0);
  const cell2 = cellParts(containerEl, 2); // md-cellen (idx 1) hoppes over

  const ev = fakeKeydown({ shiftKey: true });
  cell0.ta.dispatchEvent(ev);

  assert.strictEqual(ev._prevented, true, 'Shift+Enter skal prevente default (linjeskift)');
  assert.strictEqual(calledIdx, 0, 'runCell(0) skal ha kjørt');
  assert.strictEqual(global.document.activeElement, cell2.ta,
    'fokus hopper over md-cellen til NESTE kode-celle (idx 2)');
});

test('Shift+Enter i SISTE celle: kjører, men beholder fokus (ingen auto-opprettet halecelle i fase B1)', () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 1\n';
  C.init('python');
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = () => Promise.resolve({ text: '1' });

  const cell0 = cellParts(containerEl, 0);
  global.document.activeElement = cell0.ta; // simuler at brukeren allerede står der

  cell0.ta.dispatchEvent(fakeKeydown({ shiftKey: true }));
  assert.strictEqual(global.document.activeElement, cell0.ta, 'ingen neste kode-celle → fokus urørt');
});

test('Ctrl+Enter kjører PÅ STEDET (ingen fokus-flytting)', () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 1\n#%% python\na + 1\n';
  C.init('python');

  let calledIdx = null;
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = (payload) => { calledIdx = payload.cellIdx; return Promise.resolve({ text: '2' }); };

  const cell0 = cellParts(containerEl, 0);
  const cell1 = cellParts(containerEl, 1);

  const ev = fakeKeydown({ ctrlKey: true });
  cell0.ta.dispatchEvent(ev);

  assert.strictEqual(ev._prevented, true, 'Ctrl+Enter skal prevente default');
  assert.strictEqual(calledIdx, 0, 'runCell(0) — kjøres på stedet');
  assert.notStrictEqual(global.document.activeElement, cell1.ta, 'fokus skal IKKE flyttes til neste celle');
});

test('Shift+Enter i en md-celles editor: IKKE preventDefault, ingen kjøring, fokus urørt (linjeskift skal fungere normalt)', () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% md\nhei\n#%% python\n1 + 1\n';
  C.init('python');

  let called = false;
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = () => { called = true; return Promise.resolve({ text: '2' }); };

  const mdCell = cellParts(containerEl, 0);
  const codeCell = cellParts(containerEl, 1);
  global.document.activeElement = mdCell.ta; // brukeren redigerer md-cellen (post-dblclikk)

  const ev = fakeKeydown({ shiftKey: true });
  mdCell.ta.dispatchEvent(ev);

  assert.strictEqual(ev._prevented, false,
    'Shift+Enter i en ikke-kode-celle skal ALDRI prevente default — det er et vanlig linjeskift');
  assert.strictEqual(called, false, 'ingen kjøring skal trigges fra en md-celle');
  assert.strictEqual(global.document.activeElement, mdCell.ta,
    'fokus skal IKKE rykkes til neste kodecelle midt i skrivingen');
  assert.notStrictEqual(global.document.activeElement, codeCell.ta);

  // Ctrl+Enter likeså: helt upåvirket i en ikke-kode-celle.
  const ev2 = fakeKeydown({ ctrlKey: true });
  mdCell.ta.dispatchEvent(ev2);
  assert.strictEqual(ev2._prevented, false, 'Ctrl+Enter i en md-celle skal heller ikke prevente default');
  assert.strictEqual(called, false);
});

test('vanlig Enter (uten shift/ctrl/cmd) er upåvirket: ingen preventDefault, ingen kjøring', () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 1\n';
  C.init('python');

  let called = false;
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = () => { called = true; return Promise.resolve({ text: '1' }); };

  const cell0 = cellParts(containerEl, 0);
  const ev = fakeKeydown({});
  cell0.ta.dispatchEvent(ev);

  assert.strictEqual(ev._prevented, false, 'vanlig Enter skal ALDRI prevente default (linjeskift i cellen)');
  assert.strictEqual(called, false, 'vanlig Enter skal ikke trigge en kjøring');
});

test('stale-markering: ingen tint før første kjøring; redigering etter vellykket kjøring markerer .nb-stale; ny vellykket kjøring fjerner den', async () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 1\n';
  C.init('python');
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = () => Promise.resolve({ text: '1' });

  const cell0 = cellParts(containerEl, 0);

  // Redigering FØR noen kjøring har skjedd: ingen stale-tint (ingenting å
  // mistro ennå — cellen har aldri produsert et resultat).
  cell0.ta.value = 'a = 2\n';
  cell0.ta.dispatchEvent({ type: 'input' });
  assert.strictEqual(cell0.input.classList.contains('nb-stale'), false,
    'redigering før første kjøring skal ikke markere stale');

  await C.runCell(0);
  assert.strictEqual(cell0.input.classList.contains('nb-stale'), false, 'rett etter vellykket kjøring: ikke stale');

  cell0.ta.value = 'a = 3\n';
  cell0.ta.dispatchEvent({ type: 'input' });
  assert.strictEqual(cell0.input.classList.contains('nb-stale'), true,
    'redigering etter en vellykket kjøring markerer stale UMIDDELBART (ikke ventet på debounce)');

  await C.runCell(0);
  assert.strictEqual(cell0.input.classList.contains('nb-stale'), false,
    'en ny vellykket kjøring fjerner stale-tinten igjen');
});

test('stale-markering: en FEILET kjøring rører IKKE en eksisterende stale-tint (kun suksess tømmer den)', async () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 1\n';
  C.init('python');
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = () => Promise.resolve({ text: '1' });

  const cell0 = cellParts(containerEl, 0);
  await C.runCell(0); // markerer ranOk

  cell0.ta.value = '1/0\n';
  cell0.ta.dispatchEvent({ type: 'input' });
  assert.strictEqual(cell0.input.classList.contains('nb-stale'), true);

  global.mdRunNotebookCell = () => Promise.resolve({ error: 'ZeroDivisionError' });
  await C.runCell(0);
  assert.strictEqual(cell0.input.classList.contains('nb-stale'), true,
    'feilet kjøring skal IKKE tømme en eksisterende stale-tint (spec: kun suksess tømmer)');
});

test('beginRun (Kjør alle-hook) tømmer ALLE stale-tinter — Kjør alle er reset-mekanismen', async () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 1\n#%% python\na + 1\n';
  C.init('python');
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = () => Promise.resolve({ text: 'ok' });

  const cell0 = cellParts(containerEl, 0);
  const cell1 = cellParts(containerEl, 1);
  await C.runCell(0);
  await C.runCell(1);
  cell0.ta.value = 'a = 9\n';
  cell0.ta.dispatchEvent({ type: 'input' });
  cell1.ta.value = 'a + 9\n';
  cell1.ta.dispatchEvent({ type: 'input' });
  assert.strictEqual(cell0.input.classList.contains('nb-stale'), true);
  assert.strictEqual(cell1.input.classList.contains('nb-stale'), true);
  // Flush den ekte 250ms-redigeringsdebouncen (uten å trigge en faktisk
  // kjøring/_afterCellRun som ville rørt stale-tilstanden) — celle 99
  // finnes ikke, så runCell returnerer tidlig RETT ETTER flushPendingEdit().
  await C.runCell(99);

  C.beginRun(['pyodide', 'pyodide']);

  assert.strictEqual(cell0.input.classList.contains('nb-stale'), false, 'beginRun tømmer stale for celle 0');
  assert.strictEqual(cell1.input.classList.contains('nb-stale'), false, 'beginRun tømmer stale for celle 1');
});

test('full render() (f.eks. contentLoaded-gjeninnlasting) nullstiller stale/ranOk-stempler', async () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 1\n#%% python\na + 1\n';
  C.init('python');
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = () => Promise.resolve({ text: 'ok' });

  const cell0 = cellParts(containerEl, 0);
  await C.runCell(0);
  cell0.ta.value = 'a = 9\n';
  cell0.ta.dispatchEvent({ type: 'input' });
  assert.strictEqual(cell0.input.classList.contains('nb-stale'), true, 'stale satt før re-rendring');
  // Flush den ekte 250ms-redigeringsdebouncen først (unngår en hengende
  // ekte timer som ellers ville overleve testen) — celle 99 finnes ikke.
  await C.runCell(99);

  // contentLoaded() på et notatbok-dokument mens notatboken er aktiv kjører
  // render() på nytt (samme sti nye dokumenter/eksempler/share-lenker
  // bruker) — en strukturendring er en ærlig reset (se render() i cells.js).
  C.contentLoaded();

  const freshCell0 = cellParts(containerEl, 0);
  assert.strictEqual(freshCell0.input.classList.contains('nb-stale'), false,
    'etter en full re-rendring skal ingen celle vises som stale');
});

test('kjøreknapper + Restart deaktiveres mens en celle-kjøring pågår, gjenopprettes etter fullført kjøring', async () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 1\n#%% python\na + 1\n';
  C.init('python');

  let resolveRun;
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = () => new Promise((res) => { resolveRun = res; });

  const cell0 = cellParts(containerEl, 0);
  const cell1 = cellParts(containerEl, 1);
  const restartBtn = restartBtnEl(containerEl);

  const p = C.runCell(0);
  assert.strictEqual(cell0.runBtn.disabled, true, 'den kjørende cellens knapp deaktiveres');
  assert.strictEqual(cell1.runBtn.disabled, true, 'ALLE kjøreknapper deaktiveres, ikke bare den kjørende cellen sin');
  assert.strictEqual(restartBtn.disabled, true, 'Restart-knappen deaktiveres også');
  assert.strictEqual(cell0.input.classList.contains('nb-running'), true, 'kjørende celle får .nb-running');
  assert.strictEqual(cell1.input.classList.contains('nb-running'), false, 'kun den kjørende cellen får .nb-running');

  resolveRun({ text: '2' });
  await p;

  assert.strictEqual(cell0.runBtn.disabled, false);
  assert.strictEqual(cell1.runBtn.disabled, false);
  assert.strictEqual(restartBtn.disabled, false);
  assert.strictEqual(cell0.input.classList.contains('nb-running'), false, '.nb-running fjernes i finally');
});

test('render() setter kjøreknapper som disabled fra start hvis mdIsScriptRunning() allerede er true', () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  global.mdIsScriptRunning = () => true;
  scriptInputEl.value = '#%% python\n1\n';
  C.init('python');

  const cell0 = cellParts(containerEl, 0);
  const restartBtn = restartBtnEl(containerEl);
  assert.strictEqual(cell0.runBtn.disabled, true, 'render()-tidens sjekk av mdIsScriptRunning() deaktiverer knappen');
  assert.strictEqual(restartBtn.disabled, true);
});

test('sesjonschip: viser kjøretid + kald/aktiv fra mdNotebookSession, oppdateres via onStateChange', () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  let live = false;
  let stateCb = null;
  global.mdNotebookSession = {
    runtime: () => 'python',
    isLive: () => live,
    onStateChange: (cb) => { stateCb = cb; },
    restart: () => Promise.resolve(),
  };
  scriptInputEl.value = '#%% python\n1\n';
  C.init('python');

  const chip = sessionChipEl(containerEl);
  assert.ok(chip.textContent.indexOf('python') !== -1, 'chip viser kjøretidsnavn');
  assert.ok(chip.textContent.indexOf('kald') !== -1, 'kald ved isLive()===false');
  assert.strictEqual(chip.classList.contains('nb-session-live'), false);

  live = true;
  assert.ok(typeof stateCb === 'function', 'onStateChange skal ha registrert en callback');
  stateCb(true);

  assert.ok(chip.textContent.indexOf('aktiv') !== -1, 'chip oppdateres til aktiv via onStateChange-kallet');
  assert.strictEqual(chip.classList.contains('nb-session-live'), true);

  delete global.mdNotebookSession;
});

test('sesjonschip: window.mdNotebookSession fraværende (stub-DOM) → viser dokumentmodus, ingen krasj', () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  delete global.mdNotebookSession;
  scriptInputEl.value = '#%% python\n1\n';
  C.init('python');

  const chip = sessionChipEl(containerEl);
  assert.ok(chip, 'chip-elementet finnes selv uten mdNotebookSession');
  assert.ok(chip.textContent.indexOf('python') !== -1, 'faller tilbake til dokumentmodus som kjøretidsnavn');
});

test('Restart & kjør alle: kaller mdNotebookSession.restart() og deretter btnRun.click()', async () => {
  const { C, scriptInputEl, containerEl, getBtnRunClicks } = freshEnv();
  let restarted = false;
  global.mdNotebookSession = {
    runtime: () => 'python',
    isLive: () => true,
    onStateChange: () => {},
    restart: () => { restarted = true; return Promise.resolve(); },
  };
  // final-review F3: onRestartClick guarder nå mot mdIsScriptRunning() —
  // eksplisitt false her (i stedet for å stole på forrige tests globale
  // stub) siden en foregående test bevisst lot den stå på true.
  global.mdIsScriptRunning = () => false;
  scriptInputEl.value = '#%% python\n1\n';
  C.init('python');

  const restartBtn = restartBtnEl(containerEl);
  restartBtn.dispatchEvent({ type: 'click' });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

  assert.strictEqual(restarted, true, 'mdNotebookSession.restart() skal ha blitt kalt');
  assert.strictEqual(getBtnRunClicks(), 1, 'btnRun.click() skal kalles ETTER restart()');

  delete global.mdNotebookSession;
});

test('Restart & kjør alle: window.mdNotebookSession fraværende → klikk gjør ingenting, ingen krasj (stub-DOM-guard)', () => {
  const { C, scriptInputEl, containerEl, getBtnRunClicks } = freshEnv();
  delete global.mdNotebookSession;
  scriptInputEl.value = '#%% python\n1\n';
  C.init('python');

  const restartBtn = restartBtnEl(containerEl);
  assert.doesNotThrow(() => restartBtn.dispatchEvent({ type: 'click' }));
  assert.strictEqual(getBtnRunClicks(), 0, 'uten sesjon skal btnRun aldri klikkes');
});

// final-review F3: Restart & kjør alle skal IKKE virke mens en Kjør alle/
// Forklar-kjøring allerede pågår — uten denne guarden kunne Restart rive
// vekk e/_g under føttene på den pågående kjøringen.
// ---- Task 2 (ui-widgets W1): cellIndexById / cellElementAt / contentLoaded→Ui.resetDocument ----

test('cellIndexById: finner celle med gitt id', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python id=first\na = 1\n#%% python id=target\na + 1\n';
  C.init('python');
  assert.strictEqual(C.active(), true);

  assert.strictEqual(C.cellIndexById('target'), 1);
  assert.strictEqual(C.cellIndexById('first'), 0);
});

test('cellIndexById: id finnes ikke → -1', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python id=first\na = 1\n';
  C.init('python');

  assert.strictEqual(C.cellIndexById('nope'), -1);
});

test('cellElementAt: returnerer riktig DOM-node for en gyldig indeks', () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 1\n#%% python\na + 1\n';
  C.init('python');

  const cell1 = cellParts(containerEl, 1);
  assert.strictEqual(C.cellElementAt(1), cell1.wrap);
});

test('cellElementAt: ugyldig/manglende indeks → null', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 1\n';
  C.init('python');

  assert.strictEqual(C.cellElementAt(99), null);
});

test('cellElementAt: notatbok uten rendret rot (aldri aktiv) → null, ingen krasj', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = 'print(1)\n'; // ingen markører → aldri aktiv, NB.root forblir null
  C.init('python');
  assert.strictEqual(C.active(), false);

  assert.strictEqual(C.cellElementAt(0), null);
});

test('contentLoaded(): kaller window.Ui.resetDocument når Ui er lastet', () => {
  const { C, scriptInputEl } = freshEnv();
  let resetCalls = 0;
  global.Ui = { resetDocument: () => { resetCalls++; } };
  scriptInputEl.value = '#%% python\n1\n';

  C.contentLoaded();

  assert.strictEqual(resetCalls, 1, 'Ui.resetDocument() skal kalles ved contentLoaded()');
  delete global.Ui;
});

test('contentLoaded(): window.Ui fraværende (ikke lastet ennå) → ingen krasj', () => {
  const { C, scriptInputEl } = freshEnv();
  delete global.Ui;
  scriptInputEl.value = '#%% python\n1\n';

  assert.doesNotThrow(() => C.contentLoaded());
});

test('Restart & kjør alle: nekter mens mdIsScriptRunning() er true (kaller ikke mdNotebookSession.restart())', async () => {
  const { C, scriptInputEl, containerEl, getBtnRunClicks } = freshEnv();
  let restarted = false;
  global.mdNotebookSession = {
    runtime: () => 'python',
    isLive: () => true,
    onStateChange: () => {},
    restart: () => { restarted = true; return Promise.resolve(); },
  };
  global.mdIsScriptRunning = () => true;
  scriptInputEl.value = '#%% python\n1\n';
  C.init('python');

  const restartBtn = restartBtnEl(containerEl);
  restartBtn.dispatchEvent({ type: 'click' });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

  assert.strictEqual(restarted, false, 'mdNotebookSession.restart() skal IKKE kalles mens en kjøring pågår');
  assert.strictEqual(getBtnRunClicks(), 0, 'btnRun skal heller ikke klikkes');

  delete global.mdNotebookSession;
});
