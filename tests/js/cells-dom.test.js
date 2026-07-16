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
  // 4a (spec 2026-07-17 §1): dokumentet rendres nå INN I #outputArea (en
  // etterkommer av .container i det ekte dokumentet — panel-right) i stedet
  // for en body-nivå #notebookRoot-søsken av .container. outputAreaEl er
  // derfor barn av containerEl her, slik at isConnected-kjeden (rot-
  // sentinelen på bodyEl) fortsatt fungerer for doc-root og alt inni den.
  const outputAreaEl = new FakeEl('div');
  outputAreaEl.id = 'outputArea';
  containerEl.appendChild(outputAreaEl);
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
      if (id === 'outputArea') return outputAreaEl;
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
  // B2-review-fiks 2: verktøylinje-handlerne sjekker nå mdIsScriptRunning()
  // (toolbarGate) — en tidligere test i FILA som satte den til () => true
  // uten opprydding ville ellers lekke inn og stille avvise alle senere
  // testers strukturelle operasjoner. freshEnv nullstiller, som for de
  // andre md*-globalene over.
  global.mdIsScriptRunning = undefined;
  global.mdRunNotebookCell = undefined;

  delete require.cache[require.resolve(CELLS_PATH)];
  const C = require(CELLS_PATH);

  return {
    C,
    scriptInputEl,
    containerEl,
    outputAreaEl,
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
  // (jamovi: ustøttet modus — fase C la brython/micropython TIL SUPPORTED_MODES,
  // så testen bruker nå en fortsatt-ustøttet modus for samme regresjonsscenario.)
  C.setDocMode('jamovi');
  assert.strictEqual(C.active(), false, 'ustøttet modus → forlater notatboken');

  scriptInputEl.value = 'plain jamovi script\n';
  C.setDocMode('jamovi'); // no-op, already jamovi
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

// ---- alignedPlanForKinds (plass-fase Task 2: planoppslag uten beginRun sine sluk-bivirkninger) ----

test('alignedPlanForKinds: r-dokument, eksakt kind-match → justert plan (ingen sluk-bivirkninger)', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% r\n1\n#%% r\n2\n';
  C.init('r');
  assert.strictEqual(C.active(), true);

  const aligned = C.alignedPlanForKinds(['r', 'r']);
  assert.deepStrictEqual(aligned, [0, 1]);
});

test('alignedPlanForKinds: reelt avvik (ingen 1:1-mapping) → null', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% r\n1\n#%% r\n2\n';
  C.init('r');
  assert.strictEqual(C.active(), true);

  const aligned = C.alignedPlanForKinds(['pyodide', 'r']); // r-cellene matcher ikke 'pyodide'
  assert.strictEqual(aligned, null);
});

// ---- engineRunPlan (fase C Task 3: kjøreplan for motor-notatbøker) ----

test('fase C: engineRunPlan lister kodeceller i dokumentrekkefølge', () => {
  const { C, scriptInputEl } = freshEnv();
  // dokument i brython-modus: preambel + brython-celle + md + brython-celle
  scriptInputEl.value = '# load a as b\n#%% brython\nx = 1\n#%% md\nhei\n#%% brython\nx + 1';
  C.init('brython');
  assert.strictEqual(C.active(), true);

  assert.deepStrictEqual(C.engineRunPlan(), [0, 1, 3]);   // preambel er celle 0
  C.exit();
  assert.strictEqual(C.engineRunPlan(), null);
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
// 4a (spec 2026-07-17 §1): doc-root lever nå INNI #outputArea, ikke som en
// body-nivå #notebookRoot-søsken av .container — finn den via den globale
// document-stubben freshEnv() satte opp (samme mønster som produksjonskoden
// sin egen docHost(), se js/cells.js). Parameteret beholdes (alle
// eksisterende kallsteder sender fortsatt containerEl) men brukes ikke
// lenger — outputArea er alltid nåbar via document.getElementById uansett
// hvilket element man kom fra.
function nbRoot() {
  const outputArea = global.document.getElementById('outputArea');
  return outputArea && outputArea.children.find((c) => c.classList.contains('doc-root'));
}

// ---------- konvergert dokument (spec 2026-07-17, 4a Task 2) ----------

test('enter(): doc-root bygges i #outputArea; .container røres ikke; ingen nb-input', () => {
  const { C, scriptInputEl, outputAreaEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% md\n# Hei\n#%% python\nx = 1\n';
  C.init('python');
  assert.strictEqual(C.active(), true);
  const root = outputAreaEl.children.find((n) => n.classList.contains('doc-root'));
  assert.ok(root, 'doc-root i #outputArea');
  assert.ok(!containerEl.classList.contains('nb-hidden'), 'container-swappen er borte');
  const nodes = collectNodes(root, []);
  assert.ok(!nodes.some((n) => n.classList && n.classList.contains('nb-input')), 'ingen editor-halvdel');
  assert.ok(!nodes.some((n) => n.tag === 'textarea'), 'ingen celle-textareas');
  // md-cellen rendret, kodecellen har tomt sluk
  assert.ok(nodes.some((n) => n.classList && n.classList.contains('output-markdown')));
  const cell1 = nodes.find((n) => n.classList && n.classList.contains('doc-cell') && n.dataset.idx === '1');
  assert.ok(collectNodes(cell1, []).some((n) => n.classList && n.classList.contains('nb-output-body')));
});

test('cellElementAt/runCell/renderCellResult virker mot doc-slots', async () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 2\n#%% python\na + 3\n';
  C.init('python');
  const el1 = C.cellElementAt(1);
  assert.ok(el1 && el1.classList.contains('doc-cell'));
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = () => Promise.resolve({ text: '5' });
  await C.runCell(1);
  const body = collectNodes(el1, []).find((n) => n.classList && n.classList.contains('nb-output-body'));
  assert.strictEqual(body.textContent, '5');
});

test('htmlTrusted-gaten gjelder i dokumentet (delt lenke → eskapert + Vis HTML)', () => {
  const { C, scriptInputEl, outputAreaEl } = freshEnv();
  C.init('python');
  scriptInputEl.value = '#%% html\n<img src=x onerror="window.__pwned=1">\n';
  C.contentLoaded({ untrusted: true });
  const nodes = collectNodes(outputAreaEl, []);
  assert.ok(!nodes.map((n) => n.innerHTML).filter(Boolean).some((h) => h.includes('onerror')));
  assert.ok(nodes.some((n) => n.tag === 'button' && n.textContent === 'Vis HTML'));
});

test('beginRun/sinkForSegment/segmentDisplay mot doc-slots (Kjør alle-kontrakten)', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 1\n#%% duckdb\nselect 1\n';
  C.init('python');
  const plan = C.beginRun(['pyodide', 'duckdb']);
  assert.ok(plan !== null, 'planen justeres');
  assert.ok(C.sinkForSegment(0), 'sluk for segment 0');
  assert.deepStrictEqual(C.segmentDisplay(0), { explicit: true });
});

test('skip-celler utelates; hide-output skjuler wrapper; style-klasser følger med', () => {
  const { C, scriptInputEl, outputAreaEl } = freshEnv();
  scriptInputEl.value = '#%% skip\nx\n#%% md style=note\nA\n#%% python hide-output\ny = 1\n';
  C.init('python');
  const cells = collectNodes(outputAreaEl, []).filter((n) => n.classList && n.classList.contains('doc-cell'));
  assert.strictEqual(cells.length, 2, 'skip-cellen rendres ikke');
  assert.ok(cells[0].classList.contains('nb-style-note'));
  assert.ok(cells[1].classList.contains('nb-hide-output'));
});

test('exit() fjerner doc-root og gjenoppretter plain-oppførsel', () => {
  const { C, scriptInputEl, outputAreaEl } = freshEnv();
  scriptInputEl.value = '#%% python\nx = 1\n';
  C.init('python');
  C.exit();
  assert.strictEqual(C.active(), false);
  assert.ok(!outputAreaEl.children.some((n) => n.classList.contains('doc-root')));
});

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

// 4a: forenklet til de feltene som fortsatt finnes i docCellNode (spec §1)
// — ta/input/runBtn/verktøylinje-knappene hørte til den fjernede editor-
// halvdelen (cellNode, nå unåbar) og er borte for godt her.
function cellParts(containerEl, idx) {
  const root = nbRoot(containerEl);
  const wrap = root.children.find((n) => n.classList && n.classList.contains('nb-cell') &&
    n.dataset.idx === String(idx));
  const nodes = collectNodes(wrap, []);
  // Widget-plassering-fasen: .nb-output er nå en WRAPPER (outWrap) som kan
  // holde .param-form/.ui-controls-striper — run-output-sluket (det gamle
  // `.out`-kontraktet testene under bruker) er `.nb-output-body`, samme node
  // som c._out peker på i produksjonskoden.
  const outWrap = nodes.find((n) => n.classList && n.classList.contains('nb-output'));
  const out = nodes.find((n) => n.classList && n.classList.contains('nb-output-body'));
  return { wrap, out, outWrap };
}
function click(node) { node.dispatchEvent({ type: 'click' }); }

// .doc-bar (4a, tidligere .nb-bar): sesjonschip + Restart-knapp lever der,
// ikke inni en celle. Rå tekst-knappen som levde i den gamle .nb-bar er
// borte (docBar, spec §1: «Rå tekst» dør sammen med nb-bar).
function nbBar(containerEl) {
  const root = nbRoot(containerEl);
  return root.children.find((n) => n.classList && n.classList.contains('doc-bar'));
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

// 4a: DELETED (ikke rewritet) — testen dokumenterte at runCell() flusher en
// ventende PER-CELLE redigeringsdebounce (armert av en textarea 'input'-
// hendelse på cellens egen c._ta) synkront før kjøring. Den debounce-kilden
// finnes ikke lenger: docCellNode har ingen textarea, og onEdit (som armerte
// NB.editTimer) er dermed unåbar død kode i 4a — flushPendingEdit() i
// C.runCell er fortsatt et no-op-safe kall (NB.editTimer er alltid null),
// se js/cells.js. Den nye redigerings-debouncen lever i #scriptInput selv
// (docReconcile/refreshFromScript) og er Task 3 sitt ansvar — et analogt
// "runCell flusher ventende #scriptInput-redigering"-scenario hører hjemme
// der, ikke her.

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

// ---- widget-plassering-fasen: widgets=top|bottom|left klasse-plumbing,
// og strip-overlevelse gjennom en output-purge (js/cells.js sin cellNode:
// .nb-output er nå en wrapper rundt .param-form?/.ui-controls?/.nb-output-body) ----

test('widgets=top|bottom|left: klassen plumbes til .nb-output (default top når fraværende)', () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% python widgets=left\n1\n#%% python widgets=bottom\n2\n#%% python\n3\n#%% python widgets=weird\n4\n';
  C.init('python');
  assert.strictEqual(C.active(), true);

  assert.ok(cellParts(containerEl, 0).outWrap.classList.contains('nb-widgets-left'));
  assert.ok(cellParts(containerEl, 1).outWrap.classList.contains('nb-widgets-bottom'));
  assert.ok(cellParts(containerEl, 2).outWrap.classList.contains('nb-widgets-top'), 'default er top');
  assert.ok(cellParts(containerEl, 3).outWrap.classList.contains('nb-widgets-top'),
    'ugyldig widgets-verdi (advart av parseHeader) faller tilbake til default top, ikke krasj');
});

test('strip (.param-form) overlever renderCellResult sin purge by construction — den lever UTENFOR .nb-output-body', async () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% python\nx = 1\n';
  // Minimal ParamForms-stub som speiler den ekte _insertStrip-kontrakten:
  // stripa settes inn i .nb-output, FØR .nb-output-body — kalt automatisk av
  // cellNode (paramLangForType('python') === 'python', se js/cells.js).
  global.ParamForms = {
    decorate: function (idx, cellEl, source, lang) {
      const outWrap = cellEl.children.find((c) => c.classList.contains('nb-output'));
      const body = outWrap.children.find((c) => c.classList.contains('nb-output-body'));
      const strip = document.createElement('div');
      strip.className = 'param-form';
      strip.textContent = 'STRIP';
      outWrap.insertBefore(strip, body);
    },
  };
  C.init('python');
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = () => Promise.resolve({ text: 'hello' });

  await C.runCell(0);

  const { out, outWrap } = cellParts(containerEl, 0);
  const strip = outWrap.children.find((n) => n.classList && n.classList.contains('param-form'));
  assert.ok(strip, 'param-form-stripa overlevde runCell sin renderCellResult-purge');
  assert.strictEqual(strip.textContent, 'STRIP', 'stripa er urørt — ingen ombygging skjedde');
  assert.strictEqual(out.textContent, 'hello', 'run-output rendret i .nb-output-body, uavhengig av stripa');

  delete global.ParamForms;
});

// 4a: den gamle testen sjekket OGSÅ per-celle ▶-knapper (cell0.runBtn/
// cell1.runBtn) og .nb-running på .nb-input (cell.input) — begge er borte
// (docCellNode har verken kjøreknapp eller editor-halvdel, spec §1). Restart-
// knappen (docBar) og .nb-running-tinten (nå på selve doc-cell-wrapperen,
// c._wrap — se setRunningUi/js/cells.js) er de eneste overlevende
// UI-observerbare delene av denne kontrakten; resten dekkes av
// setNbButtonsDisabled sin interne c._runBtn/c._toolEls-løkke, som er
// dødt kode inntil 4b (ingen slike noder finnes lenger å deaktivere).
test('kjøreknapper + Restart deaktiveres mens en celle-kjøring pågår, gjenopprettes etter fullført kjøring', async () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 1\n#%% python\na + 1\n';
  C.init('python');

  let resolveRun;
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = () => new Promise((res) => { resolveRun = res; });

  const cell0 = C.cellElementAt(0);
  const cell1 = C.cellElementAt(1);
  const restartBtn = restartBtnEl();

  const p = C.runCell(0);
  assert.strictEqual(restartBtn.disabled, true, 'Restart-knappen deaktiveres under kjøring');
  assert.strictEqual(cell0.classList.contains('nb-running'), true, 'kjørende celle får .nb-running');
  assert.strictEqual(cell1.classList.contains('nb-running'), false, 'kun den kjørende cellen får .nb-running');

  resolveRun({ text: '2' });
  await p;

  assert.strictEqual(restartBtn.disabled, false, 'Restart-knappen re-aktiveres etter fullført kjøring');
  assert.strictEqual(cell0.classList.contains('nb-running'), false, '.nb-running fjernes i finally');
});

test('docRender() setter Restart-knappen som disabled fra start hvis mdIsScriptRunning() allerede er true', () => {
  const { C, scriptInputEl } = freshEnv();
  global.mdIsScriptRunning = () => true;
  scriptInputEl.value = '#%% python\n1\n';
  C.init('python');

  const restartBtn = restartBtnEl();
  assert.strictEqual(restartBtn.disabled, true, 'docRender-tidens sjekk av mdIsScriptRunning() deaktiverer Restart');
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

// ---- cellKeyAt (ui-widgets W2, Task 1): stabil celle-nøkkel for Ui-verdilageret ----

// B2 Task 4-fiks: id-grenen prefikses med '#' (kollisjonssikkert mot den
// indeks-baserte fallback-grenen under — se testen lenger ned).
test('cellKeyAt: celle med id returnerer "#" + id-en (ikke den rå id-en, ikke indeksen)', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python id=first\na = 1\n#%% python id=target\na + 1\n';
  C.init('python');

  assert.strictEqual(C.cellKeyAt(0), '#first');
  assert.strictEqual(C.cellKeyAt(1), '#target');
});

// Kollisjonsfaren fiksen dekker: uten '#'-prefikset ville en celle med
// id === "0" produsert NØYAKTIG samme streng ("0") som indeks-fallbacken
// for en HELT ANNEN, id-løs celle som tilfeldigvis står på råindeks 0 —
// begge ville delt ÉN oppføring i js/ui.js sitt _values/_controls-lager
// (verdiene ville lekket mellom de to cellene).
test('cellKeyAt: en celle med id="0" kolliderer IKKE med indeks-fallbacken til en id-løs celle på råindeks 0', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 1\n#%% python id=0\nb = 2\n';
  C.init('python');

  assert.strictEqual(C.cellKeyAt(0), '0', 'id-løs celle på indeks 0: indeks-fallback, uendret');
  assert.strictEqual(C.cellKeyAt(1), '#0', 'id="0"-cellen: prefikset, IKKE den rå "0"');
  assert.notStrictEqual(C.cellKeyAt(0), C.cellKeyAt(1), 'de to nøklene må aldri kollidere');
});

test('cellKeyAt: celle uten id faller tilbake til indeksen som streng', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 1\n#%% python\na + 1\n';
  C.init('python');

  assert.strictEqual(C.cellKeyAt(0), '0');
  assert.strictEqual(C.cellKeyAt(1), '1');
});

test('cellKeyAt: ugyldig/manglende indeks → råindeksen som streng (ingen krasj)', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 1\n';
  C.init('python');

  assert.strictEqual(C.cellKeyAt(99), '99');
});

// Kjernen av W2-carryover (d): en id-tagget celles nøkkel overlever et
// strukturelt indeksskift — samme id gir samme cellKey uansett hvilken
// råindeks cellen for øyeblikket står på (ny celle satt inn foran den).
test('cellKeyAt: id-tagget celle beholder SAMME nøkkel etter et strukturelt indeksskift', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python id=stable\na = 1\n';
  C.init('python');
  assert.strictEqual(C.cellKeyAt(0), '#stable');

  // Sett inn en ny celle FORAN 'stable' — den flytter fra indeks 0 til 1.
  scriptInputEl.value = '#%% python\nb = 2\n#%% python id=stable\na = 1\n';
  C.contentLoaded();
  assert.strictEqual(C.cellKeyAt(1), '#stable', 'samme id-baserte nøkkel på den nye råindeksen');
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
// ---- #tag-direktiver (spec 2026-07-16-tag-directives-design.md, Task 4) ----

// 4a: den gamle testen sjekket ekstra at CELLENS TEXTAREA (c._ta, editor-
// halvdelen) beholdt rå kilde inkl. tag-linjer/"""-delimitere — den editor-
// halvdelen finnes ikke lenger (docCellNode har ingen textarea i det hele
// tatt, spec §1). Kildens rå tekst lever nå UTELUKKENDE i #scriptInput
// (uendret av docRender/docCellNode), så den påstanden er umulig å teste
// mot en celle-node og faller bort; selve rendrings-intensjonen (sniffet
// md vises rent, uten """ eller #tag-linjer) overlever uendret under.
test('sniffet md-celle rendres uten """ og uten tag-linjer i dokumentet', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\nx = 1\n#%%\n#tag.slide = 1\n"""\n# Hei\n"""\n';
  C.init('python');
  assert.strictEqual(C.active(), true);

  const nodes = collectNodes(nbRoot(), []);
  const mdDiv = nodes.find((n) => n.classList && n.classList.contains('output-markdown'));
  assert.ok(mdDiv, 'sniffet celle rendres som markdown (nb-rendered-only)');
  const rendered = (mdDiv.innerHTML || '') + (mdDiv.textContent || '');
  assert.ok(rendered.includes('Hei'), 'innholdet rendres');
  assert.ok(!rendered.includes('"""'), 'delimiterne er skjult i rendringen');
  assert.ok(!rendered.includes('#tag'), 'tag-linjene er skjult i rendringen');

  assert.strictEqual(scriptInputEl.value.indexOf('#tag.slide = 1') !== -1, true,
    'rå kilde (inkl. tags/delimitere) lever i #scriptInput, ikke i en celle-node');
});

test('runCell: payload.text er tag-blanket (linjetall bevart)', async () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\n#tag.slide = 1\nx = 1\n';
  C.init('python');
  assert.strictEqual(C.active(), true);

  let captured = null;
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = (payload) => {
    captured = payload;
    return Promise.resolve({ text: 'ok' });
  };

  await C.runCell(0);

  assert.ok(captured, 'mdRunNotebookCell kalles');
  // c.source for siste (og eneste) celle beholder kildens avsluttende '\n'
  // (rundtur-egenskapen serializeCells(parseCells(d)) === d, se cells.test.js);
  // execCellSource blanker KUN tag-linjen og bevarer linjetallet nøyaktig.
  assert.strictEqual(captured.text, '\nx = 1\n', 'tag-linjen blanket PÅ PLASS');
  assert.strictEqual(captured.cellIdx, 0);
});

// 4a (spec §1): "Code cells: hide-code is meaningless in the document
// (there is no code there) and is ignored by the renderer (the attr
// remains valid for skrittvis/echo policy)" — docCellNode viser ALDRI kode
// i det hele tatt, så hide-code-attributtet produserer bevisst INGEN
// DOM-klasse lenger (motsatt av den gamle cellNode-oppførselen denne testen
// tidligere dekket). Regresjonsvakt: attrs-mergen (#tag → attrs.hide-code)
// skal fortsatt parses uten å krasje docRender, selv om DOM-en ignorerer den.
test('hide-code via #tag: attrs-mergen krasjer ikke docRender, men gir INGEN DOM-effekt (kode vises aldri i dokumentet)', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\n#tag.hide-code = true\nx = 1\n';
  assert.doesNotThrow(() => C.init('python'));
  const cell0 = C.cellElementAt(0);
  assert.ok(cell0, 'cellen rendres uansett');
  assert.ok(!cell0.classList.contains('nb-hide-code'),
    'hide-code er meningsløst i dokumentet (spec §1) — ingen klasse settes');
});

// ---- presentasjon (spec 2026-07-16-presentation-design.md, Task 2) ----

test('presentStart: kun gjeldende slides celler synlige; nb-present på rota', () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% md slide=1\n# En\n#%% python\nx = 1\n#%% md slide=2\n# To\n';
  C.init('python');
  assert.strictEqual(C.active(), true);
  assert.strictEqual(C.presentStart(), true);
  assert.strictEqual(C.presenting(), true);
  const root = nbRoot(containerEl);
  assert.ok(root.classList.contains('nb-present'));
  assert.ok(!cellParts(containerEl, 0).wrap.classList.contains('nb-slide-hidden'));
  assert.ok(!cellParts(containerEl, 1).wrap.classList.contains('nb-slide-hidden'));
  assert.ok(cellParts(containerEl, 2).wrap.classList.contains('nb-slide-hidden'));
});

test('present: klikk-soner navigerer, teller oppdateres, klemming i endene', () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% md slide=1\nA\n#%% md slide=2\nB\n';
  C.init('python');
  C.presentStart();
  const root = nbRoot(containerEl);
  const nodes = collectNodes(root, []);
  const nextBtn = nodes.find((n) => n.classList && n.classList.contains('nb-present-next'));
  const prevBtn = nodes.find((n) => n.classList && n.classList.contains('nb-present-prev'));
  const counter = nodes.find((n) => n.classList && n.classList.contains('nb-present-counter'));
  assert.strictEqual(counter.textContent, '1 / 2');
  click(nextBtn);
  assert.strictEqual(counter.textContent, '2 / 2');
  assert.ok(cellParts(containerEl, 0).wrap.classList.contains('nb-slide-hidden'));
  click(nextBtn); // klem: forbli på siste
  assert.strictEqual(counter.textContent, '2 / 2');
  click(prevBtn);
  assert.strictEqual(counter.textContent, '1 / 2');
});

test('presentExit gjenoppretter layout og fjerner nav-noder + synlighetsklasser', () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% md slide=1\nA\n#%% md slide=2\nB\n';
  C.init('python');
  C.presentStart();
  C.presentExit();
  assert.strictEqual(C.presenting(), false);
  const root = nbRoot(containerEl);
  assert.ok(!root.classList.contains('nb-present'));
  assert.ok(root.classList.contains('nb-layout-columns'));
  assert.ok(!cellParts(containerEl, 1).wrap.classList.contains('nb-slide-hidden'));
  const nodes = collectNodes(root, []);
  assert.ok(!nodes.some((n) => n.classList && n.classList.contains('nb-present-nav')));
  assert.ok(!nodes.some((n) => n.classList && n.classList.contains('nb-present-counter')));
});

test('_presentKeydown: piler navigerer, Escape avslutter; skjemafelt ignoreres', () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% md slide=1\nA\n#%% md slide=2\nB\n';
  C.init('python');
  C.presentStart();
  let prevented = 0;
  const mk = (key, tag) => ({ key, target: { tagName: tag }, preventDefault: () => { prevented++; } });
  C._presentKeydown(mk('ArrowRight', 'DIV'));
  let counter = collectNodes(nbRoot(containerEl), []).find((n) => n.classList && n.classList.contains('nb-present-counter'));
  assert.strictEqual(counter.textContent, '2 / 2');
  C._presentKeydown(mk('ArrowRight', 'TEXTAREA'));   // skjemafelt: ignorert
  assert.strictEqual(counter.textContent, '2 / 2');
  C._presentKeydown(mk('Escape', 'DIV'));
  assert.strictEqual(C.presenting(), false);
  assert.ok(prevented >= 2, 'ArrowRight + Escape skal preventDefault');
});

test('re-render mens presentasjon er aktiv: modus beholdes, cur klemmes', () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% md slide=1\nA\n#%% md slide=2\nB\n';
  C.init('python');
  C.presentStart();
  const nodes = collectNodes(nbRoot(containerEl), []);
  click(nodes.find((n) => n.classList && n.classList.contains('nb-present-next')));
  scriptInputEl.value = '#%% md slide=1\nA\n';
  C.refreshFromScript();
  assert.strictEqual(C.presenting(), true);
  const root = nbRoot(containerEl);
  assert.ok(root.classList.contains('nb-present'), 'nb-present overlever render()s className-reset');
  const counter = collectNodes(root, []).find((n) => n.classList && n.classList.contains('nb-present-counter'));
  assert.strictEqual(counter.textContent, '1 / 1');
});

test('contentLoaded (nytt dokument) og exit (Rå tekst) avslutter presentasjonen', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% md slide=1\nA\n';
  C.init('python');
  C.presentStart();
  scriptInputEl.value = '#%% md\nB\n';
  C.contentLoaded();
  assert.strictEqual(C.presenting(), false);
  C.presentStart();
  C.exit({ raw: true });
  assert.strictEqual(C.presenting(), false);
});

test('presentStart: no-op uten aktiv notatbok', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = 'print(1)\n';
  C.init('python');
  assert.strictEqual(C.active(), false);
  assert.strictEqual(C.presentStart(), false);
  assert.strictEqual(C.presenting(), false);
});

test('contentLoaded: #options.view = present auto-starter presentasjonen', () => {
  const { C, scriptInputEl } = freshEnv();
  C.init('python');
  scriptInputEl.value = '#options.view = present\n\n#%% md slide=1\nA\n#%% md slide=2\nB\n';
  C.contentLoaded({ untrusted: true });
  assert.strictEqual(C.active(), true);
  assert.strictEqual(C.presenting(), true);
});

// ---------- Task 3b (spec 2026-07-17 §1): outputArea-tømming er doc-bevisst ----------
//
// index.html sin clearOutput()/mdClearOutput() kaller window.Cells.refreshFromScript()
// i stedet for å tømme #outputArea når en notatbok er aktiv (se index.html sin
// clearOutput()-funksjon) — refreshFromScript() re-rendrer dokumentet fra scratch,
// som gir tomme output-slots (den "ærlige nullstillingen"). index.html selv er ikke
// kjørbar i denne stub-DOM-en (for mange globaler), så kontrakten testes her på
// cells.js-nivå: refreshFromScript() etterlater dokumentet aktivt med tomme slots,
// aldri en slettet .doc-root. Run-stedene i index.html som ble gjort doc-bevisste
// (clearOutputAreaUnlessDoc()) er dekket ved lesing + exit-garantiene dokumentert i
// Task 3b-rapporten (.superpowers/sdd/task-3b-report.md), ikke av en egen stub her.
test('Task 3b: refreshFromScript() etter en kjøring rebygger dokumentet med TOMME slots (ikke sletter det)', async () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 2\n#%% python\na + 3\n';
  C.init('python');
  assert.strictEqual(C.active(), true);

  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = () => Promise.resolve({ text: '5' });
  await C.runCell(1);
  assert.strictEqual(cellParts(containerEl, 1).out.textContent, '5', 'sanity: output ligger i slot 1 før refresh');

  // Speiler clearOutput() sin Cells.active()-gren i index.html: kall
  // refreshFromScript() i stedet for å tømme #outputArea direkte.
  C.refreshFromScript();

  assert.strictEqual(C.active(), true, 'dokumentet forblir aktivt — refreshFromScript() er ikke exit()');
  assert.ok(nbRoot(containerEl), '.doc-root finnes fortsatt (ikke slettet)');
  const cell0 = cellParts(containerEl, 0);
  const cell1 = cellParts(containerEl, 1);
  assert.strictEqual(cell0.out.textContent, '', 'slot 0 er tom etter rebygging');
  assert.strictEqual(cell1.out.textContent, '', 'slot 1 sitt forrige resultat er borte — rebygd tomt, ikke bevart');
});
