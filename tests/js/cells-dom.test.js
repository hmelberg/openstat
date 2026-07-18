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

  global.document = {
    // Task 4 (spec 2026-07-17 §3): presentStart/presentExit dytter/fjerner
    // 'present-active' på document.body (guardet — mangler i mange av de
    // andre testenes DOM-fake, se resten av fila) — eksponer bodyEl (samme
    // node som isConnected-rot-sentinelen over) slik at present-active-
    // testen faktisk kan observere klassen lande/forsvinne.
    body: bodyEl,
    getElementById: (id) => {
      if (id === 'scriptInput') return scriptInputEl;
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
    // Samme minimale ekte-tekst-node-stub som tests/js/ui-dom.test.js sin
    // document-fake bruker (js/ui.js/js/cells.js sitt document.createTextNode-
    // kall trenger dette — cells.js:2242 sin hasDash-append-fallback rammes
    // av en ny data-ui-shown-regresjonstest under).
    createTextNode: (text) => { const n = new FakeEl('#text'); n.textContent = text; return n; },
    activeElement: null,
  };

  let intervalCallback = null;
  global.setInterval = (fn) => { intervalCallback = fn; return 1; };
  global.clearInterval = () => {};

  let fakeNow = 1000000;
  Date.now = () => fakeNow;

  global.mdIsInputHidden = undefined;
  global.mdIsStackedLayout = undefined;
  // Task 4 (spec 2026-07-17 §2): C.setLayout er nå en tynn delegat til disse
  // to app-primitivene (index.html sin initLayoutAndResizer) i stedet for å
  // style .doc-root selv — call-recorder-stubber slik at presentExit/setLayout-
  // testene kan se ETTER hvilke primitiver som ble kalt, med hvilke argumenter,
  // i stedet for å inspisere klasser som ikke lenger settes her.
  const layoutModeCalls = [];
  const inputHiddenCalls = [];
  global.mdSetLayoutMode = (mode) => { layoutModeCalls.push(mode); };
  global.mdSetInputHidden = (hidden) => { inputHiddenCalls.push(hidden); };
  // Task 4-review-fiks (Critical): presentStart/presentExit synker view-
  // dropdownen ('present' ved start, prevLayout-verdien ved exit) — call-
  // recorder slik at meny-bypass-regresjonstesten kan se AT dropdownen
  // faktisk synkes til 'output' (ikke 'columns') når prevLayout ble fanget
  // fra live appLayout() mens brukeren stod i «Kun output».
  const syncViewDropdownCalls = [];
  global.mdSyncViewDropdown = (mode) => { syncViewDropdownCalls.push(mode); };
  global.requestAnimationFrame = () => {};
  global.purgePlots = undefined;
  // B2-review-fiks 2: verktøylinje-handlerne sjekker nå mdIsScriptRunning()
  // (toolbarGate) — en tidligere test i FILA som satte den til () => true
  // uten opprydding ville ellers lekke inn og stille avvise alle senere
  // testers strukturelle operasjoner. freshEnv nullstiller, som for de
  // andre md*-globalene over.
  global.mdIsScriptRunning = undefined;
  global.mdRunNotebookCell = undefined;
  // Editor-konvergens (plan 4b Task 3): slot→markør-broen — samme
  // reset-mønster som mdRunNotebookCell over, forhindrer lekkasje mellom
  // tester som stubber den.
  global.mdJumpToCell = undefined;

  delete require.cache[require.resolve(CELLS_PATH)];
  const C = require(CELLS_PATH);

  return {
    C,
    scriptInputEl,
    containerEl,
    outputAreaEl,
    wrapEl,
    bodyEl,
    getLayoutModeCalls: () => layoutModeCalls.slice(),
    getInputHiddenCalls: () => inputHiddenCalls.slice(),
    getSyncViewDropdownCalls: () => syncViewDropdownCalls.slice(),
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

// 4b §5: DELETED (ikke rewritet) — testen dokumenterte NB.rawOverride, flagget
// exit({raw:true}) (den gamle nb-bar sin Rå tekst-knapp) satte for å blokkere
// tick() sin auto-inngang inntil neste contentLoaded(). Knappen/UI-en som
// SATTE flagget døde med celle-listen (docBar har ingen Rå tekst-affordanse,
// se nbBar-kommentaren over) — rawOverride var dermed en skrive-ALDRI-lest-
// UNNTATT-AV-SEG-SELV tilstand, fjernet i sin helhet (js/cells.js). C.exit()
// tar ikke lenger noen opts; et exit() etterfulgt av en programmatisk endring
// auto-åpner nå alltid igjen (dekket av de andre tick()-auto-inngang-testene
// i denne fila).

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

test('contentLoaded() etter exit(): nytt dokument re-åpner uansett (ingen rest-tilstand fra forrige exit blokkerer)', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\nprint(1)\n';
  C.init('python');
  assert.strictEqual(C.active(), true);

  C.exit();
  assert.strictEqual(C.active(), false);

  // Nytt dokument med markører leveres (eksempel/share) — det eksplisitte
  // innlastingssignalet auto-åpner uavhengig av forrige exit().
  scriptInputEl.value = '#%% python\nprint(2)\n#%% md\nny\n';
  C.contentLoaded();
  assert.strictEqual(C.active(), true, 'nytt dokument skal re-åpne etter en tidligere exit()');
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

test('docCellNode: cols=3 legger til nb-cols-3 på wrapperen; ugyldig cols gir ingen nb-cols-*-klasse', () => {
  const { C, scriptInputEl, outputAreaEl } = freshEnv();
  scriptInputEl.value = '#%% python cols=3\nx = 1\n#%% python cols=9\ny = 2\n#%% python\nz = 3\n';
  C.init('python');
  const cells = collectNodes(outputAreaEl, []).filter((n) => n.classList && n.classList.contains('doc-cell'));
  assert.strictEqual(cells.length, 3);
  assert.ok(cells[0].classList.contains('nb-cols-3'), 'gyldig cols=3 gir nb-cols-3');
  assert.ok(!cells[1].className.split(/\s+/).some((c) => /^nb-cols-/.test(c)), 'ugyldig cols=9 gir ingen nb-cols-klasse (droppet av parseHeader)');
  assert.ok(!cells[2].className.split(/\s+/).some((c) => /^nb-cols-/.test(c)), 'cols-løs celle er uendret');
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

// .doc-bar (4a, tidligere .nb-bar): NÅ KUN parse-varsler (Hans' avgjørelse
// 2026-07-17 — sesjonschip/Restart-knapp fjernet, se js/cells.js docBar) —
// og create-on-demand (finnes IKKE i DOM-en når parsed.warnings er tomt, se
// samme kommentar), så nbBar() kan returnere undefined selv etter en vellykket
// rendring. Rå tekst-knappen som levde i den gamle .nb-bar er også borte
// (docBar, spec §1: «Rå tekst» dør sammen med nb-bar).
function nbBar(containerEl) {
  const root = nbRoot(containerEl);
  return root.children.find((n) => n.classList && n.classList.contains('doc-bar'));
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
// finnes ikke lenger: docCellNode har ingen textarea. 4b §5: onEdit/
// doFlush/flushPendingEdit (og NB.editTimer/NB.pendingFlush) var dermed
// unåbar død kode og er nå fjernet fra js/cells.js i sin helhet — runCell()
// kaller ikke lenger noe flush-steg først. Den nye redigerings-debouncen
// lever i #scriptInput selv (docReconcile/refreshFromScript) og er Task 3
// sitt ansvar — et analogt "runCell flusher ventende #scriptInput-
// redigering"-scenario hører hjemme der, ikke her.

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

test('runCell: {notice} → pre.nb-notice (ikke pre.error) i cellens egen slot (mixed-mode begrensningsmeldinger)', async () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% r\nprint("x")\n';
  C.init('r');
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = () => Promise.resolve({ notice: 'R-celler i ikke-R-modus-dokumenter kjøres foreløpig kun via Kjør alle' });

  await C.runCell(0);

  const { out } = cellParts(containerEl, 0);
  const noticeNode = out.children.find((n) => n.tag === 'pre' && n.classList.contains('nb-notice'));
  const errNode = out.children.find((n) => n.tag === 'pre' && n.classList.contains('error'));
  assert.ok(noticeNode, 'begrensningsmeldingen skal vises som pre.nb-notice');
  assert.strictEqual(noticeNode.textContent, 'R-celler i ikke-R-modus-dokumenter kjøres foreløpig kun via Kjør alle');
  assert.strictEqual(errNode, undefined, 'skal IKKE rendres som pre.error (den er rød/alarmerende, dette er ikke en feil)');
});

// ---- data-ui-shown for-kjøringsrensk (review-funn 15ce63c: commit 15ce63c
// speilet kun HALVE .dash-mønsteret — post-run-vaktposten (renderCellResult
// sin hasDash-sjekk) ble utvidet til data-ui-shown, men PRE-run-purgen i
// C.runCell (rett før payload bygges) ble stående gated på KUN '.dash'. Et
// mdRunNotebookCell-stub under simulerer Ui.elShow sin live DOM-mutasjon
// (js/ui.js): den monterer en ny data-ui-shown-node RETT INN i cellens
// .nb-output-body SYNKRONT, før Promise'n resolver — nøyaktig slik
// Brython/MicroPython sin bro kaller inn under selve kjøringen (mdUiRunCtx()
// peker da på nettopp denne sloten, se cells.js sin egen kommentar over
// renderCellResult sin hasDash-linje). ----

test('runCell: rerun med et data-ui-shown-montert element PURGER forrige kjørings node først — ingen akkumulering (review-funn 15ce63c)', async () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% python\nx = ui.html.div()\nx.show()\n';
  C.init('python');
  global.mdIsScriptRunning = () => false;

  var mountCount = 0;
  global.mdRunNotebookCell = () => {
    mountCount++;
    var out = cellParts(containerEl, 0).out;
    var mounted = document.createElement('div');
    mounted.dataset.uiShown = '1';
    mounted.textContent = 'mount-' + mountCount;
    out.appendChild(mounted);
    return Promise.resolve({ text: '' });
  };

  await C.runCell(0);
  var out1 = cellParts(containerEl, 0).out;
  var shown1 = out1.children.filter((n) => n.dataset && n.dataset.uiShown === '1');
  assert.strictEqual(shown1.length, 1, 'første kjøring: ett montert data-ui-shown-element');

  await C.runCell(0);
  var out2 = cellParts(containerEl, 0).out;
  var shown2 = out2.children.filter((n) => n.dataset && n.dataset.uiShown === '1');
  assert.strictEqual(shown2.length, 1, 'andre kjøring: FORTSATT bare ett data-ui-shown-element (forrige rerun sin node skal være purget, ikke akkumulert ved siden av)');
  assert.strictEqual(shown2[0].textContent, 'mount-2', 'det gjenværende elementet er DEN FERSKE kjøringens monterte node, ikke den gamle');
});

test('renderCellResult: et data-ui-shown-element montert MIDT I kjøringen overlever selve kjøringens output-rendring (append-ikke-tøm, innad i ÉN kjøring)', async () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% python\nx = ui.html.div()\nx.show()\n';
  C.init('python');
  global.mdIsScriptRunning = () => false;

  global.mdRunNotebookCell = () => {
    var out = cellParts(containerEl, 0).out;
    var mounted = document.createElement('div');
    mounted.dataset.uiShown = '1';
    mounted.textContent = 'live-mount';
    out.appendChild(mounted);
    return Promise.resolve({ text: 'siste uttrykk' });
  };

  await C.runCell(0);

  var out = cellParts(containerEl, 0).out;
  var shown = out.children.filter((n) => n.dataset && n.dataset.uiShown === '1');
  assert.strictEqual(shown.length, 1, 'det monterte elementet skal overleve DENNE kjøringens egen resultat-rendring (append, ikke wipe)');
  assert.strictEqual(shown[0].textContent, 'live-mount');
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
// (docCellNode har verken kjøreknapp eller editor-halvdel, spec §1).
// Sesjonschip/Restart-knappen (docBar) er fjernet 2026-07-17 (Hans'
// avgjørelse — «Kjør» ER NÅ restart-og-kjør-alle i alle modi, se js/cells.js
// docBar-kommentaren) — .nb-running-tinten på selve doc-cell-wrapperen
// (c._wrap, se setRunningUi) er nå den eneste UI-observerbare delen av
// denne kontrakten.
test('celle-kjøring: kun den kjørende cellen får .nb-running, fjernes etter fullført kjøring', async () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 1\n#%% python\na + 1\n';
  C.init('python');

  let resolveRun;
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = () => new Promise((res) => { resolveRun = res; });

  const cell0 = C.cellElementAt(0);
  const cell1 = C.cellElementAt(1);

  const p = C.runCell(0);
  assert.strictEqual(cell0.classList.contains('nb-running'), true, 'kjørende celle får .nb-running');
  assert.strictEqual(cell1.classList.contains('nb-running'), false, 'kun den kjørende cellen får .nb-running');

  resolveRun({ text: '2' });
  await p;

  assert.strictEqual(cell0.classList.contains('nb-running'), false, '.nb-running fjernes i finally');
});

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
  // Task 4 (spec 2026-07-17 §2): setLayout er nå en tynn delegat — den
  // gjenopprettede layouten vises IKKE lenger som en nb-layout-*-klasse på
  // .doc-root (den klasse-juggleringen er død), men som et kall til
  // mdSetLayoutMode ('columns', prevLayout-standarden) + mdSetInputHidden(false).
  const { C, scriptInputEl, containerEl, getLayoutModeCalls, getInputHiddenCalls } = freshEnv();
  scriptInputEl.value = '#%% md slide=1\nA\n#%% md slide=2\nB\n';
  C.init('python');
  C.presentStart();
  C.presentExit();
  assert.strictEqual(C.presenting(), false);
  const root = nbRoot(containerEl);
  assert.ok(!root.classList.contains('nb-present'));
  assert.deepStrictEqual(getInputHiddenCalls(), [false], 'presentExit gjenoppretter synlig input via app-primitiven');
  assert.deepStrictEqual(getLayoutModeCalls(), ['columns'], 'prevLayout ("columns", satt av presentStart) gjenopprettes via app-primitiven');
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

test('contentLoaded (nytt dokument) og exit() avslutter presentasjonen', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% md slide=1\nA\n';
  C.init('python');
  C.presentStart();
  scriptInputEl.value = '#%% md\nB\n';
  C.contentLoaded();
  assert.strictEqual(C.presenting(), false);
  C.presentStart();
  C.exit();
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

test('presentStart: alle celler skip → avvises som "ingen slides" (index.html viser eksisterende notis)', () => {
  // slidePlan bygger nums FØR skip-filtrering (se slidePlan-testen i
  // cells.test.js) — et all-skip-dokument gir derfor ÉN slide med tom
  // cellIdxs, ikke en tom slides-liste. Den gamle '!plan.slides.length'-
  // gaten alene sluk igjennom denne og åpnet en blank presentasjon.
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% skip\nx\n#%% skip\ny\n';
  C.init('python');
  assert.strictEqual(C.active(), true, 'sanity: dokumentet er aktivt (kun ikke-kjørbart)');
  assert.strictEqual(C.presentStart(), false, 'ingen synlig celle i noen slide — presentStart skal avvise');
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

// ---- Task 4 (spec 2026-07-17 §2/§3): fem-visningsmenyen på app-primitivene
//      + presentasjon re-hostet på det konvergerte dokumentet ----

test('setLayout delegerer til app-primitivene (ingen nb-layout-*-klasser lenger)', () => {
  const { C, scriptInputEl, containerEl, getLayoutModeCalls, getInputHiddenCalls } = freshEnv();
  scriptInputEl.value = '#%% python\nx = 1\n';
  C.init('python');
  C.setLayout('stacked');
  assert.deepStrictEqual(getInputHiddenCalls(), [false]);
  assert.deepStrictEqual(getLayoutModeCalls(), ['stacked']);
  const root = nbRoot(containerEl);
  assert.ok(!root.classList.contains('nb-layout-stacked'), 'ingen nb-layout-klasse på doc-root lenger');

  C.setLayout('output');
  assert.deepStrictEqual(getInputHiddenCalls(), [false, true]);
  assert.deepStrictEqual(getLayoutModeCalls(), ['stacked'], 'output kaller ikke mdSetLayoutMode');

  C.setLayout('columns');
  assert.deepStrictEqual(getInputHiddenCalls(), [false, true, false]);
  assert.deepStrictEqual(getLayoutModeCalls(), ['stacked', 'columns']);
});

test('presentStart: body.present-active lander (skjuler panel-left/#resizer via CSS); Esc gjenoppretter layouten via delegaten', () => {
  const { C, scriptInputEl, bodyEl, getLayoutModeCalls, getInputHiddenCalls } = freshEnv();
  scriptInputEl.value = '#%% md slide=1\nA\n#%% md slide=2\nB\n';
  C.init('python');
  assert.ok(!bodyEl.classList.contains('present-active'));
  assert.strictEqual(C.presentStart(), true);
  // body.present-active lander på rota (CSS-en — app.css sin
  // `body.present-active .panel-left, body.present-active #resizer { display: none; }`
  // — er browser-land og verifiseres ikke her, kun at bryteren faktisk slås på).
  assert.ok(bodyEl.classList.contains('present-active'));
  C._presentKeydown({ key: 'Escape', target: { tagName: 'DIV' }, preventDefault: () => {} });
  assert.strictEqual(C.presenting(), false);
  assert.ok(!bodyEl.classList.contains('present-active'), 'Esc fjerner present-active igjen');
  // Layouten (NB.layout var 'columns' — default — da presentStart fanget
  // prevLayout) gjenopprettes via NØYAKTIG samme app-primitiv-delegat som
  // visningsmenyen selv bruker (setLayout-delegasjonstesten over).
  assert.deepStrictEqual(getInputHiddenCalls(), [false]);
  assert.deepStrictEqual(getLayoutModeCalls(), ['columns']);
});

// Critical (Task 4-review, commit 9aa3e82): visningsmenyens håndterer driver
// mdSetInputHidden/mdSetLayoutMode DIREKTE (meny-bypass, se index.html) uten
// om C.setLayout — NB.layout blir dermed stale når brukeren bytter visning
// via menyen. presentStart fanget tidligere prevLayout FRA NB.layout, altså
// den stale verdien fra dokument-lastingstidspunktet — Esc etter presentasjon
// startet fra «Kun output» avdekket dette ved å gjenopprette 'columns'
// (avsløre editoren) i stedet for å bli i «Kun output». Fikset ved å lese
// prevLayout fra appLayout() (live avlesning av app-primitivene) i stedet.
test('presentStart: prevLayout fanges fra live appLayout(), ikke stale NB.layout (meny-bypass-regresjon)', () => {
  const { C, scriptInputEl, getLayoutModeCalls, getInputHiddenCalls, getSyncViewDropdownCalls } = freshEnv();
  scriptInputEl.value = '#%% md slide=1\nA\n#%% md slide=2\nB\n';
  C.init('python');
  // C.init/enter satte NB.layout = 'columns' (appLayout() sin default DA,
  // siden mdIsInputHidden var udefinert). Simuler deretter visningsmenyens
  // direkte primitiv-kall («Kun output» valgt via menyen, ETTER dokument-
  // lasting): mdIsInputHidden() begynner å returnere true, men NB.layout
  // rører ingen ved denne veien og forblir 'columns' — akkurat den stale
  // tilstanden som utløste bugen.
  global.mdIsInputHidden = () => true;
  assert.strictEqual(C.presentStart(), true);
  C.presentExit();
  assert.strictEqual(C.presenting(), false);
  assert.deepStrictEqual(getInputHiddenCalls(), [true],
    'Esc gjenoppretter «Kun output» (mdSetInputHidden(true)) — IKKE default false fra stale NB.layout');
  assert.deepStrictEqual(getLayoutModeCalls(), [],
    'output-gjenoppretting kaller aldri mdSetLayoutMode (samme kontrakt som setLayout("output"))');
  assert.deepStrictEqual(getSyncViewDropdownCalls(), ['present', 'output'],
    'view-dropdown synkes til "output" ved exit (fra appLayout()-fanget prevLayout), ikke "columns"');
});

// ---------- Task 3b (spec 2026-07-17 §1): outputArea-tømming er doc-bevisst ----------
//
// index.html sin clearOutput()/mdClearOutput() kaller window.Cells.rebuildDocument()
// i stedet for å tømme #outputArea når en notatbok er aktiv (se index.html sin
// clearOutput()-funksjon) — rebuildDocument() re-rendrer dokumentet fra scratch
// UBETINGET (Task 3-review-funn 3, Minor: refreshFromScript() sitt dual-mode-gate
// kunne race'e mot en fersk redigering og FORSONE — altså BEHOLDE utdata — i stedet
// for å tømme), som gir tomme output-slots (den "ærlige nullstillingen"). index.html
// selv er ikke kjørbar i denne stub-DOM-en (for mange globaler), så kontrakten
// testes her på cells.js-nivå: rebuildDocument() etterlater dokumentet aktivt med
// tomme slots, aldri en slettet .doc-root. Run-stedene i index.html som ble gjort
// doc-bevisste (clearOutputAreaUnlessDoc()) er dekket ved lesing + exit-garantiene
// dokumentert i Task 3b-rapporten (.superpowers/sdd/task-3b-report.md), ikke av en
// egen stub her.
test('Task 3b/3-review-funn 3: rebuildDocument() etter en kjøring rebygger dokumentet med TOMME slots (ikke sletter det)', async () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 2\n#%% python\na + 3\n';
  C.init('python');
  assert.strictEqual(C.active(), true);

  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = () => Promise.resolve({ text: '5' });
  await C.runCell(1);
  assert.strictEqual(cellParts(containerEl, 1).out.textContent, '5', 'sanity: output ligger i slot 1 før refresh');

  // Speiler clearOutput() sin Cells.active()-gren i index.html: kall
  // rebuildDocument() i stedet for å tømme #outputArea direkte.
  C.rebuildDocument();

  assert.strictEqual(C.active(), true, 'dokumentet forblir aktivt — rebuildDocument() er ikke exit()');
  assert.ok(nbRoot(containerEl), '.doc-root finnes fortsatt (ikke slettet)');
  const cell0 = cellParts(containerEl, 0);
  const cell1 = cellParts(containerEl, 1);
  assert.strictEqual(cell0.out.textContent, '', 'slot 0 er tom etter rebygging');
  assert.strictEqual(cell1.out.textContent, '', 'slot 1 sitt forrige resultat er borte — rebygd tomt, ikke bevart');
});

// Task 3-review-funn 3 (race): rebuildDocument() må tømme UBETINGET selv når
// #scriptInput FAKTISK har endret seg siden sist rendret (motsatt av
// refreshFromScript() sitt dual-mode-gate, som ville tatt forsonings-grenen
// og BEHOLDT den overlevende cellens output her — se docReconcile). Dette er
// nøyaktig raceen brukeren kunne trigge ved å redigere i samme sekund som
// "Tøm output" ble trykket.
test('Task 3-review-funn 3: rebuildDocument() tømmer selv når #scriptInput ble endret siden sist rendret (ikke en forsoning)', async () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 2\n#%% python\na + 3\n';
  C.init('python');
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = () => Promise.resolve({ text: '5' });
  await C.runCell(1);

  // "Uendret celle 0, redigert celle 1" — akkurat mønsteret som ville
  // forsonet (og dermed bevart celle 1 sin output) via refreshFromScript().
  scriptInputEl.value = '#%% python\na = 2\n#%% python\na + 4\n';
  C.rebuildDocument();

  const cell1 = cellParts(containerEl, 1);
  assert.strictEqual(cell1.out.textContent, '', 'ubetinget tømming — ikke forsonet/bevart, selv om teksten endret seg');
});

// refreshFromScript() sin egen forsonings-kontrakt (Task 3) beholdes UENDRET
// og dekkes fortsatt her: kalt ETTER at #scriptInput faktisk har endret seg
// tar den reconcile-grenen (docReconcile) — se "forsoning: …"-testene under
// for full dekning av den (kropps-endring overlever/kode blir stale/
// strukturendring rebygger).

// ---------- Task 3 (spec 2026-07-17 §1): forsonings-policy + updateCellSource ----------
//
// refreshFromScript() dobbeltjobber (se js/cells.js): kalt med #scriptInput
// UENDRET siden sist rendret (Task 3b sin "nullstill output"-kontrakt over)
// → full docRender(); kalt ETTER at #scriptInput faktisk har endret seg
// (denne seksjonen) → docReconcile() — untouched cellers slots/outputs
// overlever, kun det som faktisk endret seg re-rendres.

test('forsoning: kropps-endring i md re-rendrer cellen; kode-endring gir stale; output overlever', async () => {
  const { C, scriptInputEl, outputAreaEl } = freshEnv();
  scriptInputEl.value = '#%% md\n# En\n#%% python\nx = 1\n';
  C.init('python');
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = () => Promise.resolve({ text: 'ok' });
  await C.runCell(1);
  scriptInputEl.value = '#%% md\n# To\n#%% python\nx = 2\n';
  C.refreshFromScript();
  const nodes = collectNodes(outputAreaEl, []);
  const md = nodes.find((n) => n.classList && n.classList.contains('output-markdown'));
  assert.ok((md.innerHTML || md.textContent).includes('To'), 'md re-rendret');
  const cell1 = nodes.find((n) => n.classList && n.classList.contains('doc-cell') && n.dataset.idx === '1');
  assert.ok(cell1.classList.contains('nb-stale'), 'kodecellen stale');
  const body1 = collectNodes(cell1, []).find((n) => n.classList && n.classList.contains('nb-output-body'));
  assert.strictEqual(body1.textContent, 'ok', 'outputen overlevde forsoningen');
});

test('forsoning: strukturendring → full rebuild (output borte, stale nullstilt)', async () => {
  const { C, scriptInputEl, outputAreaEl } = freshEnv();
  scriptInputEl.value = '#%% python\nx = 1\n';
  C.init('python');
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = () => Promise.resolve({ text: 'ok' });
  await C.runCell(0);
  scriptInputEl.value = '#%% python\nx = 1\n#%% md\nny celle\n';
  C.refreshFromScript();
  const cell0 = collectNodes(outputAreaEl, []).find((n) => n.classList && n.classList.contains('doc-cell') && n.dataset.idx === '0');
  const body0 = collectNodes(cell0, []).find((n) => n.classList && n.classList.contains('nb-output-body'));
  assert.strictEqual(body0.textContent, '', 'rebuild tømmer slots (ærlig reset)');
});

// Task 3-review-funn 1 (Important): sameStructure sammenlikner KUN
// headerRaw — en UMERKET celle ('#%%' uten type-token) kan bytte SNIFFET
// effektiv type ved en ren kroppsendring uten at headeren rører seg.
// Reprodusert her: en celle som sniffes til 'md' (lone-triple-quote-
// mønsteret) redigeres om til vanlig python-kode — samme headerRaw ('#%%')
// begge veier, så uten typegaten ville in-place-grenen feilaktig beholde den
// gamle 'nb-rendered-only'/'output-markdown'-noden.
test('forsoning: sniffet type-flip på umerket celle (md-kropp → python-kropp) tvinger full rebuild, ikke in-place', () => {
  const { C, scriptInputEl, outputAreaEl } = freshEnv();
  scriptInputEl.value = '#%%\n"""md"""\n';
  C.init('python');

  let nodes = collectNodes(outputAreaEl, []);
  let cell0 = nodes.find((n) => n.classList && n.classList.contains('doc-cell') && n.dataset.idx === '0');
  assert.ok(cell0.classList.contains('nb-rendered-only'), 'sniffet til md — rendret direkte, ingen kode-affordance');
  assert.ok(collectNodes(cell0, []).some((n) => n.classList && n.classList.contains('output-markdown')),
    'md-innhold rendret inn i sluket');

  scriptInputEl.value = '#%%\nx = 1\n';
  C.refreshFromScript();

  nodes = collectNodes(outputAreaEl, []);
  cell0 = nodes.find((n) => n.classList && n.classList.contains('doc-cell') && n.dataset.idx === '0');
  assert.ok(cell0, 'cellen finnes fortsatt etter forsoningen');
  assert.ok(!cell0.classList.contains('nb-rendered-only'), 'sniffet til python nå — ikke lenger rendered-only');
  const body0 = collectNodes(cell0, []).find((n) => n.classList && n.classList.contains('nb-output-body'));
  assert.ok(body0, 'kode-cellen har et output-body-sluk');
  assert.strictEqual(body0.textContent, '', 'friskt, tomt kode-sluk — ingen gjenværende md-DOM');
});

// Task 3-review-funn 2 (Important): docReconcile kalte tidligere
// ParamForms.decorate (full stripe-ombygging) for HVER endret celle — en
// levende slider-drag committer per 'input'-hendelse via updateCellSource →
// docReconcile, så decorate der ville rive ned/bygge kontroll-DOM-en på nytt
// på HVER pikselbevegelse (dreper draget). Fiksen kaller ParamForms.syncSource
// (DOM-fri kildesynk) i stedet; decorate skal KUN kalles ved cellens
// opprinnelige bygging (docCellNode, via C.init/docRender).
test('forsoning: endret param-celle kaller ParamForms.syncSource (ikke decorate) — stripa ombygges ALDRI av docReconcile', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\nn = 3 #@param\n';
  let decorateCalls = 0;
  const syncSourceCalls = [];
  global.ParamForms = {
    decorate: function () { decorateCalls++; },
    syncSource: function (idx, source) { syncSourceCalls.push([idx, source]); },
  };
  C.init('python');
  assert.strictEqual(decorateCalls, 1, 'initial docCellNode-bygging kaller decorate én gang');

  // Speiler en kontrolls egen commit (ParamForms._commit → Cells.updateCellSource
  // → docReconcile) — den frekvensen decorate der ville drept en slider-drag.
  C.updateCellSource(0, 'n = 9 #@param');

  assert.strictEqual(decorateCalls, 1, 'docReconcile skal ALDRI kalle decorate for en endret celle');
  assert.strictEqual(syncSourceCalls.length, 1, 'docReconcile kaller syncSource i stedet');
  assert.deepStrictEqual(syncSourceCalls[0], [0, 'n = 9 #@param']);

  delete global.ParamForms;
});

// Task 3-review-funn 4 (Minor): docReconcile sin in-place-gren rørte
// tidligere ALDRI doc-baren — et #tag-varsel som endret seg ved en
// kroppsredigering (samme struktur, kun kildetekst) ble stående til neste
// strukturendring eller eksplisitt docRender(). updateWarnings() skal nå
// oppdatere/opprette/fjerne .nb-warnings-spanet i .doc-bar direkte i
// in-place-grenen. 2026-07-17 (Hans' avgjørelse, create-on-demand — se
// js/cells.js docBar-kommentaren): «fjernes» betyr nå at HELE .doc-bar-noden
// forsvinner fra DOM-en (ikke bare varsel-spanet inni den, siden baren ikke
// har noe annet innhold igjen) — nbBar(containerEl) returnerer derfor
// undefined, ikke en tom bar, når varselsettet er tomt.
test('forsoning: doc-bar sine parse-varsler oppdateres av in-place-grenen (opprettes/oppdateres/fjernes)', () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  // '#tag.style' med en ugyldig verdi gir et varsel uten å endre strukturen
  // (samme headerRaw begge veier — se sameStructure).
  scriptInputEl.value = '#%% python\n#tag.style = "rar"\nx = 1\n';
  C.init('python');
  let bar = nbBar(containerEl);
  let warn = bar && bar.children.find((n) => n.classList && n.classList.contains('nb-warnings'));
  assert.ok(warn, 'varsel-span finnes ved initial rendring');
  assert.ok(warn.textContent.indexOf('style') !== -1);

  // Fjern varselet (gyldig style) — samme struktur (headerRaw uendret).
  scriptInputEl.value = '#%% python\n#tag.style = "note"\nx = 1\n';
  C.refreshFromScript();
  bar = nbBar(containerEl);
  assert.strictEqual(bar, undefined, 'HELE .doc-bar-noden fjernes når varselsettet blir tomt (create-on-demand)');

  // Sett et NYTT varsel (ugyldig #tag-nøkkel) — baren skal opprettes på nytt.
  scriptInputEl.value = '#%% python\n#tag.ukjentnokkel = "x"\nx = 1\n';
  C.refreshFromScript();
  bar = nbBar(containerEl);
  warn = bar && bar.children.find((n) => n.classList && n.classList.contains('nb-warnings'));
  assert.ok(warn, 'doc-baren og varsel-spanet opprettes på nytt når et nytt varsel dukker opp');
  assert.ok(warn.textContent.indexOf('ukjentnokkel') !== -1);
});

test('updateCellSource: splicer #scriptInput, forsoner, bevarer resten av dokumentet', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\nn = 3 #@param\n#%% md\nA\n';
  C.init('python');
  C.updateCellSource(0, 'n = 7 #@param');
  assert.strictEqual(scriptInputEl.value, '#%% python\nn = 7 #@param\n#%% md\nA\n');
  assert.strictEqual(C.parseCells(scriptInputEl.value).cells[0].source, 'n = 7 #@param');
});

// Review-funn (Task 2): eksplisitt kontrollpunkt for at .nb-stale faktisk
// lander på .doc-cell-WRAPPEREN (samme node cellElementAt/beginRun/CSS ser),
// ikke bare et internt objekt-flagg — kjør en celle, endre kilden via den
// offentlige Cells.updateCellSource-API-en (ParamForms sin seam), og les
// klassen tilbake fra DOM-en via cellElementAt.
test('updateCellSource: .nb-stale lander på .doc-cell-wrapperen for en tidligere kjørt celle', async () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\nx = 1\n';
  C.init('python');
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = () => Promise.resolve({ text: 'ok' });
  await C.runCell(0);
  C.updateCellSource(0, 'x = 2');
  assert.strictEqual(C.cellElementAt(0).classList.contains('nb-stale'), true);
});

// ---------- spec 4b Task 1 (4a-sluttreview Important 1): stale-span-racet ----------
//
// Race: brukeren skriver direkte i #scriptInput (linjer forskjøvet) i
// INNEVÆRENDE ett-sekunds tikk-vindu — NB.cells sine spenn (startLine/
// endLine) er da FORELDET helt til neste tikk/forsoning. Skjer en
// #@param-kontrolls commit (Cells.updateCellSource) INNENFOR akkurat dette
// vinduet, ville en splice mot de forelede spennene enten korrumpere
// naboteksten eller slette/overskrive brukerens ferske linje. Fiksen
// forsoner FØRST (nøyaktig samme sti som tick() selv bruker) — se
// reconcileScriptInput i js/cells.js.

test('updateCellSource: usforsonet linje lagt til FØR cellen (spenn forskjøvet) korrumperer ikke — begge endringer overlever', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '# preamble\n#%% python\nn = 3 #@param\n#%% md\nA\n';
  C.init('python');

  // USFORSONET brukerredigering: en ny linje lagt til i preambelen, FØR
  // python-cellen — samme struktur (samme headerRaw-sekvens/celletall,
  // C.sameStructure), men python-cellens linjespenn FORSKYVES med én. Satt
  // direkte på .value (ingen tick()/refreshFromScript()) — NB.cells vet
  // ennå ingenting om denne redigeringen når updateCellSource kalles.
  scriptInputEl.value = '# preamble\n# ny linje\n#%% python\nn = 3 #@param\n#%% md\nA\n';

  // Speiler en kontrolls egen commit (ParamForms._commit, cellIdx=1 uendret
  // — kun spennet, ikke indeksen, er foreldet her).
  const fresh = C.updateCellSource(1, 'n = 7 #@param');

  assert.strictEqual(
    scriptInputEl.value,
    '# preamble\n# ny linje\n#%% python\nn = 7 #@param\n#%% md\nA\n',
    'brukerens ferske linje OG den nye param-verdien er begge til stede — ingen korrupsjon, ingen reverterte tastetrykk'
  );
  assert.strictEqual(fresh, 'n = 7 #@param', 'returnerer cellens ferske kilde (spec 4b Task 1b)');
  assert.strictEqual(C.parseCells(scriptInputEl.value).cells[2].source, 'A\n', 'md-cellen er urørt');
});

// Indeks-identitet-forbeholdet (spec 4b Task 1c): en usforsonet redigering
// som LEGGER TIL en #%%-celle endrer STRUKTUREN (celletall/headerRaw-
// sekvens) — docReconcile sin egen "sameStructure"-port tar da IKKE
// in-place-grenen, men en full docRender() (hele notatboken, ParamForms
// sine striper inkludert, rebygges fra bunnen). cellIdx-en en kontroll
// fanget ved DEKORERINGSTIDSPUNKTET (predaterer redigeringen) er da ikke
// lenger trygg å splice mot — updateCellSource må droppe splicingen
// (return null) fremfor å gjette/korrumpere feil celle.
test('updateCellSource: usforsonet redigering som legger til en #%%-celle → full rebuild → splice droppes (null), brukerens redigering overlever uendret', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\nn = 3 #@param\n#%% md\nA\n';
  C.init('python');

  // USFORSONET redigering: en HELT NY '#%% skip'-celle satt inn FØRST —
  // strukturen endrer seg (2 → 3 celler). idx=0 var python-cellen FØR denne
  // redigeringen (dekoreringstidspunktets indeks) — men peker nå på den nye
  // skip-cellen i den ferske parsen.
  const edited = '#%% skip\nz = 1\n#%% python\nn = 3 #@param\n#%% md\nA\n';
  scriptInputEl.value = edited;

  const result = C.updateCellSource(0, 'n = 7 #@param');

  assert.strictEqual(result, null, 'strukturell forsoning → splicingen droppes, ikke gjettes');
  assert.strictEqual(scriptInputEl.value, edited, 'brukerens redigering står urørt — ingen korrupsjon fra en feilrettet splice');
  assert.strictEqual(C.parseCells(scriptInputEl.value).cells[1].source, 'n = 3 #@param', 'param-verdien er UENDRET — kontroll-interaksjonen ble droppet, ikke feilrettet inn i feil celle');
});

// ---------- spec 4b Task 2: markør-/seleksjonskjøring ----------

// ---- C.cellAtLineInDoc / C.selectionSpanInDoc (DOM-halvdel-innpakninger) ----

test('cellAtLineInDoc: speiler cellAtLine mot NB.cells; -1 når notatboken er inaktiv', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\nx = 1\ny = 2\n#%% md\ntekst\n';
  C.init('python');
  assert.strictEqual(C.active(), true);

  assert.strictEqual(C.cellAtLineInDoc(1), 0);
  assert.strictEqual(C.cellAtLineInDoc(3), 1);
  assert.strictEqual(C.cellAtLineInDoc(99), -1);

  C.exit();
  assert.strictEqual(C.cellAtLineInDoc(1), -1, 'inaktiv notatbok → -1, aldri en stale indeks');
});

test('selectionSpanInDoc: speiler selectionCellSpan mot NB.cells/NB.docMode; {error:"outside"} når inaktiv', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\nx = 1\ny = 2\n#%% md\ntekst\n';
  C.init('python');
  assert.strictEqual(C.active(), true);

  assert.deepStrictEqual(C.selectionSpanInDoc(1, 2), { idx: 0 });
  assert.deepStrictEqual(C.selectionSpanInDoc(0, 1), { error: 'outside' }, 'linje 0 er header-linjen');
  assert.deepStrictEqual(C.selectionSpanInDoc(4, 4), { error: 'noncode' }, 'md-cellens kropp');

  C.exit();
  assert.deepStrictEqual(C.selectionSpanInDoc(1, 2), { error: 'outside' });
});

// ---- C.runSelection ----

test('runSelection: payload har text (hele cellekroppen), selText (seleksjonen) og riktig cellIdx/kind/nb', async () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 1\nb = 2\nc = 3\n';
  C.init('python');
  assert.strictEqual(C.active(), true);

  let captured = null;
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = (payload) => { captured = payload; return Promise.resolve({ text: '2' }); };

  await C.runSelection(0, 'b = 2');

  assert.ok(captured, 'mdRunNotebookCell skal kalles');
  assert.strictEqual(captured.kind, 'pyodide');
  assert.strictEqual(captured.cellIdx, 0);
  assert.strictEqual(captured.text, 'a = 1\nb = 2\nc = 3\n', 'text er HELE (tag-blanket) cellekroppen, som runCell');
  assert.strictEqual(captured.selText, 'b = 2', 'selText er seleksjonen');
  assert.deepStrictEqual(captured.nb, { echo: false, last: true });

  const { out } = cellParts(containerEl, 0);
  assert.strictEqual(out.textContent, '2', 'resultatet rendres i cellens egen slot, som runCell');
});

test('runSelection: selText tag-blankes (samme #tag-vern som execCellSource)', async () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\nx = 1\n';
  C.init('python');

  let captured = null;
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = (payload) => { captured = payload; return Promise.resolve({ text: '' }); };

  await C.runSelection(0, '#tag.style = "note"\nprint(1)');

  assert.ok(captured);
  assert.strictEqual(captured.selText, '\nprint(1)', 'tag-linjen blanket PÅ PLASS, linjetall bevart');
});

test('runSelection: IKKE C._afterCellRun — en tidligere stale-tint overlever en seleksjonskjøring', async () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\nx = 1\ny = 2\n';
  C.init('python');
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = () => Promise.resolve({ text: 'ok' });

  // Kjør cellen i sin helhet én gang (ranOk=true), rediger den så kroppen
  // (docReconcile markerer stale), og kjør SÅ et utvalg — stale skal IKKE
  // fjernes av seleksjonskjøringen, i motsetning til en full runCell().
  await C.runCell(0);
  scriptInputEl.value = '#%% python\nx = 9\ny = 2\n';
  C.refreshFromScript();
  assert.strictEqual(C.cellElementAt(0).classList.contains('nb-stale'), true, 'sanity: cellen er stale før seleksjonskjøringen');

  await C.runSelection(0, 'y = 2');

  assert.strictEqual(C.cellElementAt(0).classList.contains('nb-stale'), true,
    'seleksjonskjøring er en DELVIS kjøring — "partial run ≠ cell ran", stale-tinten overlever');
});

test('runSelection: purger IKKE et data-ui-shown-montert element fra cellens ekte (fulle) kjøring — avvik 1 dekker nå også ui.html, ikke bare dash (review-funn 15ce63c)', async () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% python\nx = ui.html.div()\nx.show()\n';
  C.init('python');
  global.mdIsScriptRunning = () => false;

  // Cellens ekte (fulle) kjøring monterer et data-ui-shown-element i sin slot.
  global.mdRunNotebookCell = () => {
    const out = cellParts(containerEl, 0).out;
    const mounted = document.createElement('div');
    mounted.dataset.uiShown = '1';
    mounted.textContent = 'full-run-mount';
    out.appendChild(mounted);
    return Promise.resolve({ text: '' });
  };
  await C.runCell(0);
  let shown = cellParts(containerEl, 0).out.children.filter((n) => n.dataset && n.dataset.uiShown === '1');
  assert.strictEqual(shown.length, 1, 'sanity: full kjøring monterte elementet');

  // En etterfølgende SELEKSJONSkjøring (som ikke selv monterer noe nytt) skal
  // ikke rive ned den ekte kjøringens data-ui-shown-node — C.runSelection
  // mangler bevisst C.runCell sin pre-run-purge (se avvik 1-kommentaren over
  // funksjonen).
  global.mdRunNotebookCell = () => Promise.resolve({ text: 'delresultat' });
  await C.runSelection(0, 'x.show()');

  shown = cellParts(containerEl, 0).out.children.filter((n) => n.dataset && n.dataset.uiShown === '1');
  assert.strictEqual(shown.length, 1, 'seleksjonskjøringen skal la den fulle kjøringens montering stå urørt');
  assert.strictEqual(shown[0].textContent, 'full-run-mount', 'det er FORTSATT den fulle kjøringens node, ikke fjernet/erstattet');
});

test('runSelection: en tidligere runCell-suksess (ranOk) er urørt av en seleksjonskjøring — ny stale etter redigering fungerer som før', async () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\nx = 1\n';
  C.init('python');
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = () => Promise.resolve({ text: 'ok' });

  // Cellen har ALDRI kjørt (ranOk=false) — kjør et utvalg av den.
  await C.runSelection(0, 'x = 1');
  // markStaleIfRan (docReconcile) skal fortsatt ikke gi stale ved en
  // etterfølgende kroppsredigering, fordi runSelection ALDRI satte ranOk.
  scriptInputEl.value = '#%% python\nx = 2\n';
  C.refreshFromScript();
  assert.strictEqual(C.cellElementAt(0).classList.contains('nb-stale'), false,
    'cellen har aldri "kjørt" (kun et utvalg av den) — markStaleIfRan er et no-op uten ranOk');
});

test('runSelection: nekter mens mdIsScriptRunning() er true / for en md-celle (ingen-op, speiler runCell)', async () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% md\nhei\n#%% python\n1\n';
  C.init('python');
  let called = false;
  global.mdRunNotebookCell = () => { called = true; return Promise.resolve({ text: '' }); };

  global.mdIsScriptRunning = () => false;
  await C.runSelection(0, 'hei'); // md-celle
  assert.strictEqual(called, false, 'en md-celle skal aldri trigge en kjøring');

  global.mdIsScriptRunning = () => true;
  await C.runSelection(1, '1');
  assert.strictEqual(called, false, 'skal nekte å kjøre mens en annen kjøring pågår');
});

test('runSelection: seleksjon med kun tag-linjer er no-op (ikke helcelle-fallback)', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% md\nhei\n#%% python\nx = 1\n';
  C.init('python');
  let called = false;
  global.mdIsScriptRunning = () => false;
  global.mdRunNotebookCell = () => { called = true; return Promise.resolve({}); };

  // seleksjonen er KUN en tag-linje — blankTagLinesInText gjør den tom, og
  // i dag faller den tomme selText'en tilbake til å kjøre HELE cellen via
  // index.html sin '|| payload.text'-fallback (se runSelection-kommentaren).
  const res = C.runSelection(1, '#tag.style = "note"');

  assert.strictEqual(called, false, 'kun tag-/direktivlinjer i seleksjonen skal ikke trigge en kjøring');
  assert.strictEqual(res, null, 'bevisst no-op returnerer null, ikke et promise');
});

// ---- C.rerenderCell ----

test('rerenderCell: re-rendrer en md-celles kropp fra NB.cells sin kildetekst inn i sitt eget sluk', () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% md\nHei\n';
  C.init('python');
  const { out } = cellParts(containerEl, 0);
  // Vandaliser sluket direkte (simulerer et utdatert/feil-rendret innhold) —
  // cellens KILDE (NB.cells[0].source) er urørt av dette.
  out.textContent = 'FEIL INNHOLD';

  C.rerenderCell(0);

  const nodes = collectNodes(containerEl, []);
  const md = nodes.find((n) => n.classList && n.classList.contains('output-markdown'));
  assert.ok(md, 'rerenderCell bygger markdown-strukturen på nytt');
  const rendered = (md.innerHTML || '') + (md.textContent || '');
  assert.ok(rendered.includes('Hei'), 'innholdet kommer fra cellens KILDE, ikke det vandaliserte sluket');
});

test('rerenderCell: no-op for en kode-celle og for en ugyldig indeks', () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% python\nx = 1\n';
  C.init('python');
  const before = cellParts(containerEl, 0).out.textContent;
  assert.doesNotThrow(() => C.rerenderCell(0));
  assert.strictEqual(cellParts(containerEl, 0).out.textContent, before, 'kode-celle: ingen re-rendring');
  assert.doesNotThrow(() => C.rerenderCell(99), 'ugyldig indeks krasjer ikke');
});

// ---- C.setActiveCell / docCellNode slot→markør (plan 4b Task 3: gutter ▶ +
// markør↔slot-kobling) ----

test('setActiveCell: .doc-active på riktig celle, kun én om gangen; null klarer', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 1\n#%% md\nA\n#%% python\nb = 2\n';
  C.init('python');
  const cell0 = C.cellElementAt(0);
  const cell1 = C.cellElementAt(1);
  const cell2 = C.cellElementAt(2);

  C.setActiveCell(1);
  assert.strictEqual(cell0.classList.contains('doc-active'), false);
  assert.strictEqual(cell1.classList.contains('doc-active'), true);
  assert.strictEqual(cell2.classList.contains('doc-active'), false, 'kun én celle aktiv om gangen');

  // Idempotent: samme indeks igjen endrer ingen klasser.
  C.setActiveCell(1);
  assert.strictEqual(cell1.classList.contains('doc-active'), true);

  C.setActiveCell(2);
  assert.strictEqual(cell1.classList.contains('doc-active'), false, 'forrige aktiv celle mister klassen');
  assert.strictEqual(cell2.classList.contains('doc-active'), true);

  C.setActiveCell(null);
  assert.strictEqual(cell2.classList.contains('doc-active'), false, 'null klarer aktiv celle');
});

test('setActiveCell: scrollIntoView({block:"nearest"}) kun ved en FAKTISK endring, guardet — stub-DOM uten metoden krasjer ikke', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 1\n#%% python\nb = 2\n';
  C.init('python');

  // FakeEl har ingen scrollIntoView i det hele tatt (samme "browser-only
  // DOM-metode"-situasjon som resten av filen guarder med typeof) — dette
  // kallet skal ikke kaste.
  assert.doesNotThrow(() => C.setActiveCell(1));

  const cell0 = C.cellElementAt(0);
  const cell1 = C.cellElementAt(1);
  let scrollCalls = [];
  cell0.scrollIntoView = (opts) => scrollCalls.push(opts);
  cell1.scrollIntoView = (opts) => scrollCalls.push(opts);

  C.setActiveCell(0);
  assert.deepStrictEqual(scrollCalls, [{ block: 'nearest' }]);

  // Samme indeks igjen: INGEN ny scroll.
  C.setActiveCell(0);
  assert.strictEqual(scrollCalls.length, 1, 'uendret idx scroller ikke på nytt');

  C.setActiveCell(1);
  assert.strictEqual(scrollCalls.length, 2, 'faktisk endring scroller');
});

// Review Important 1: docRender sin strukturelle rebuild nullstiller
// NB.activeCellIdx UBETINGET nå (samme "ærlig reset" som NB.stale/NB.ranOk
// får noen linjer over i js/cells.js) — den forrige "reapplisér på samme
// indeks hvis fortsatt gyldig"-oppførselen var feil: en FERSK celle på
// samme indeks etter en strukturendring er ikke nødvendigvis "samme celle"
// markøren stod i. Markørens tracker (nbUpdateActiveCellFromCursor,
// index.html) reetablerer riktig aktiv celle ved neste cursor-hendelse —
// se den funksjonens egen kommentar.
test('setActiveCell: strukturendring (docRender) nullstiller aktiv celle ubetinget — reetableres ikke automatisk på samme indeks', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 1\n#%% python\nb = 2\n';
  C.init('python');
  C.setActiveCell(1);
  const oldCell1 = C.cellElementAt(1);
  assert.strictEqual(oldCell1.classList.contains('doc-active'), true);

  // Strukturendring (ny celle lagt til) → docReconcile ser ulik struktur og
  // faller tilbake til en full docRender (ferske wrap-noder, se
  // js/cells.js sin egen kommentar der).
  scriptInputEl.value = '#%% python\na = 1\n#%% python\nb = 2\n#%% python\nc = 3\n';
  C.refreshFromScript();

  const newCell1 = C.cellElementAt(1);
  assert.notStrictEqual(newCell1, oldCell1, 'strukturendring bygger en NY node for indeks 1');
  assert.strictEqual(newCell1.classList.contains('doc-active'), false,
    'ingen celle er lenger markert aktiv etter en strukturell rebuild');
  assert.strictEqual(C.cellElementAt(0).classList.contains('doc-active'), false);
});

// Reconcile-in-place-motstykket til testen over: SAMME struktur (samme
// celletall + headerRaw-sekvens, C.sameStructure) → docReconcile oppdaterer
// PÅ PLASS (samme wrap-noder, se docReconcile sin egen kommentar) — aktiv
// celle er da fortsatt gyldig og skal IKKE klares.
test('setActiveCell: overlever docReconcile (samme struktur, in-place-oppdatering) — .doc-active urørt', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 1\n#%% python\nb = 2\n';
  C.init('python');
  C.setActiveCell(1);
  const cell1 = C.cellElementAt(1);
  assert.strictEqual(cell1.classList.contains('doc-active'), true);

  // Kun kroppen til celle 1 endres — samme headerRaw-sekvens som før, så
  // sameStructure holder og docReconcile tar in-place-grenen (ikke docRender).
  scriptInputEl.value = '#%% python\na = 1\n#%% python\nb = 99\n';
  C.refreshFromScript();

  const sameCell1 = C.cellElementAt(1);
  assert.strictEqual(sameCell1, cell1, 'in-place-forsoning gjenbruker samme wrap-node');
  assert.strictEqual(sameCell1.classList.contains('doc-active'), true,
    'aktiv celle overlever en in-place-forsoning uendret');
});

test('setActiveCell: aktiv indeks utenfor det nye celletallet klarer stille etter docRender', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 1\n#%% python\nb = 2\n';
  C.init('python');
  C.setActiveCell(1);

  scriptInputEl.value = '#%% python\na = 1\n';
  C.refreshFromScript();
  assert.strictEqual(C.cellElementAt(1), null, 'celle 1 finnes ikke lenger');

  // Ingen gjenværende stale tilstand — en senere setActiveCell(0) fungerer
  // normalt (og scroller, siden 1 !== 0 fortsatt telles som en endring).
  C.setActiveCell(0);
  assert.strictEqual(C.cellElementAt(0).classList.contains('doc-active'), true);
});

test('exit(): nullstiller aktiv-celle-tilstanden — spøker ikke inn i et senere, urelatert dokument', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 1\n#%% python\nb = 2\n';
  C.init('python');
  C.setActiveCell(1);
  C.exit();

  scriptInputEl.value = '#%% md\nA\n'; // helt annet, kortere dokument
  C.contentLoaded({});
  assert.strictEqual(C.active(), true);
  const cell0 = C.cellElementAt(0);
  assert.strictEqual(cell0.classList.contains('doc-active'), false,
    'gammel indeks 1 fra FORRIGE dokument skal ikke reapplisere .doc-active på celle 0 i det nye');
});

test('docCellNode: klikk på cellekroppen kaller window.mdJumpToCell(idx)', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 1\n#%% python\nb = 2\n';
  const jumpCalls = [];
  global.mdJumpToCell = (idx) => jumpCalls.push(idx);
  C.init('python');

  const wrap1 = C.cellElementAt(1);
  wrap1.dispatchEvent({ type: 'click', target: wrap1 });
  assert.deepStrictEqual(jumpCalls, [1]);

  const wrap0 = C.cellElementAt(0);
  wrap0.dispatchEvent({ type: 'click', target: wrap0 });
  assert.deepStrictEqual(jumpCalls, [1, 0]);
});

test('docCellNode: klikk på en kontroll (eller en etterkommer AV en) inni sloten hopper IKKE markøren', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 1 #@param\n';
  const jumpCalls = [];
  global.mdJumpToCell = (idx) => jumpCalls.push(idx);
  C.init('python');

  const wrap0 = C.cellElementAt(0);

  const btn = global.document.createElement('button');
  wrap0.appendChild(btn);
  wrap0.dispatchEvent({ type: 'click', target: btn });
  assert.deepStrictEqual(jumpCalls, [], 'klikk på en <button> hopper ikke');

  // Et barn AV knappen (flernivås forelder-vandring, ikke bare direkte-barn-sjekk).
  const span = global.document.createElement('span');
  btn.appendChild(span);
  wrap0.dispatchEvent({ type: 'click', target: span });
  assert.deepStrictEqual(jumpCalls, [], 'klikk på et barn av en knapp hopper heller ikke');

  const uiControls = global.document.createElement('div');
  uiControls.className = 'ui-controls';
  wrap0.appendChild(uiControls);
  wrap0.dispatchEvent({ type: 'click', target: uiControls });
  assert.deepStrictEqual(jumpCalls, [], 'klikk på .ui-controls hopper ikke');

  // Klikk på sloten selv (ingen ignorerbar forelder mellom target og wrap)
  // hopper fortsatt normalt — filteret er spesifikt, ikke en generell
  // klikk-blokkering.
  wrap0.dispatchEvent({ type: 'click', target: wrap0 });
  assert.deepStrictEqual(jumpCalls, [0]);
});

// Review Important 2: plot/chart-flater (Plotly/matplotlib-aktige resultater)
// manglet fra ignore-listen — et klikk/dra INNI et diagram (zoom, hover,
// legend-toggle) stjal editor-fokus via mdJumpToCell, en overraskende
// sideeffekt identisk med den .ui-controls allerede var fikset mot.
test('docCellNode: klikk på en plot/chart-flate (svg/canvas/.js-plotly-plot) inni sloten hopper IKKE markøren', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\nplot()\n';
  const jumpCalls = [];
  global.mdJumpToCell = (idx) => jumpCalls.push(idx);
  C.init('python');

  const wrap0 = C.cellElementAt(0);

  // Plotlys egen rot-container-klasse — treffer selv om roten er en <div>.
  const plotlyRoot = global.document.createElement('div');
  plotlyRoot.className = 'js-plotly-plot';
  wrap0.appendChild(plotlyRoot);
  wrap0.dispatchEvent({ type: 'click', target: plotlyRoot });
  assert.deepStrictEqual(jumpCalls, [], 'klikk på .js-plotly-plot hopper ikke');

  // svg-tegneflaten selv (Plotlys interne <svg>, matplotlib-SVG-eksport).
  const svg = global.document.createElement('svg');
  plotlyRoot.appendChild(svg);
  wrap0.dispatchEvent({ type: 'click', target: svg });
  assert.deepStrictEqual(jumpCalls, [], 'klikk på <svg> hopper ikke');

  // Et barn AV svg-en (flernivås forelder-vandring, samme mønster som
  // knapp/span-sjekken over) — f.eks. en <path> eller <g> i et faktisk plot.
  const path = global.document.createElement('path');
  svg.appendChild(path);
  wrap0.dispatchEvent({ type: 'click', target: path });
  assert.deepStrictEqual(jumpCalls, [], 'klikk på et barn av <svg> hopper heller ikke');

  // canvas-tegneflaten (matplotlib/Plotly kan begge rendre til <canvas>).
  const canvas = global.document.createElement('canvas');
  wrap0.appendChild(canvas);
  wrap0.dispatchEvent({ type: 'click', target: canvas });
  assert.deepStrictEqual(jumpCalls, [], 'klikk på <canvas> hopper ikke');

  // Tag-navnet er case-insensitivt sammenliknet (samme toLowerCase() som
  // resten av isIgnorableClickTarget bruker på input/button/select/...).
  const svgUpper = global.document.createElement('SVG');
  wrap0.appendChild(svgUpper);
  wrap0.dispatchEvent({ type: 'click', target: svgUpper });
  assert.deepStrictEqual(jumpCalls, [], 'SVG med stor forbokstav hopper heller ikke');

  // Klikk på sloten selv fortsatt normalt — filteret er spesifikt.
  wrap0.dispatchEvent({ type: 'click', target: wrap0 });
  assert.deepStrictEqual(jumpCalls, [0]);
});

// Task 2 (backlog-sweep): matplotlib-output rendres ofte som <img> (PNG-data-
// URL, jf. index.html ~8103-8108) inni cellens .nb-output-body — et klikk på
// selve bildet skal IKKE hoppe editor-markøren, samme resonnement som svg/
// canvas-plotflatene over (et bilde-resultat er ikke en interaktiv kontroll,
// men brukeren klikker på det for å se det, ikke for å hoppe i editoren).
test('klikk på <img> i slot stjeler ikke fokus (mdJumpToCell kalles ikke)', () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% python\nplot()\n';
  const jumpCalls = [];
  global.mdJumpToCell = (idx) => jumpCalls.push(idx);
  C.init('python');

  const wrap0 = C.cellElementAt(0);
  const out0 = cellParts(containerEl, 0).out;

  const img = global.document.createElement('img');
  out0.appendChild(img);
  wrap0.dispatchEvent({ type: 'click', target: img });
  assert.deepStrictEqual(jumpCalls, [], 'klikk på <img> i output-body hopper ikke');

  // Klikk på sloten selv fortsatt normalt — filteret er spesifikt.
  wrap0.dispatchEvent({ type: 'click', target: wrap0 });
  assert.deepStrictEqual(jumpCalls, [0]);
});

test('docCellNode: klikk-lytteren krasjer ikke uten en window.mdJumpToCell (guardet tverr-IIFE-bro)', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% python\na = 1\n';
  global.mdJumpToCell = undefined;
  C.init('python');
  const wrap0 = C.cellElementAt(0);
  assert.doesNotThrow(() => wrap0.dispatchEvent({ type: 'click', target: wrap0 }));
});
