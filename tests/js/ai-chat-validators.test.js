// tests/js/ai-chat-validators.test.js — nivå 1 auto-retting for python/R i
// v2-flyten (docs/ROADMAP.md §AI-assistenten). js/ai-chat.js er en
// nettleser-IIFE som kjører init() ved require-tid (side-wiring), så en
// minimal document-stubb installeres FØR require — samme mønster som
// tests/js/ui-dom.test.js/cells-dom.test.js bruker for js/ui.js og
// js/cells.js. init() bailer tidlig når document.getElementById('aiSidebar')
// gir null (se js/ai-chat.js sin `if (!dom.aiSidebar) return;`), så resten av
// DOM-oppkoblingen (event-lyttere osv.) kjører aldri i denne test-konteksten
// — kun de rene funksjonene modulen selv eksporterer (module.exports-seamen
// nederst i fila) testes her.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const AI_CHAT_PATH = path.join(__dirname, '..', '..', 'js', 'ai-chat.js');

global.window = global;
global.document = {
  readyState: 'complete',
  addEventListener: function () {},
  getElementById: function () { return null; },
  querySelectorAll: function () { return []; },
};

const aiChat = require(AI_CHAT_PATH);

// ---- extractFirstCodeBlock -------------------------------------------------

test('extractFirstCodeBlock: henter riktig språk-tagget blokk, hopper over andre', () => {
  const md = 'Her er svaret:\n\n```r\nx <- 1\n```\n\n```python\ny = 2\n```\n';
  assert.equal(aiChat.extractFirstCodeBlock(md, 'python').trim(), 'y = 2');
  assert.equal(aiChat.extractFirstCodeBlock(md, 'r').trim(), 'x <- 1');
});

test('extractFirstCodeBlock: aksepterer py-alias for python', () => {
  const md = '```py\nprint(1)\n```';
  assert.equal(aiChat.extractFirstCodeBlock(md, 'python').trim(), 'print(1)');
});

test('extractFirstCodeBlock: ingen treff gir tom streng', () => {
  assert.equal(aiChat.extractFirstCodeBlock('bare prosetekst, ingen kodeblokk', 'python'), '');
  assert.equal(aiChat.extractFirstCodeBlock('', 'r'), '');
});

test('extractFirstCodeBlock: microdata-blokker telles ikke som python/r', () => {
  const md = '```microdata\nrequire no.ssb.fdb:53 as fd\n```';
  assert.equal(aiChat.extractFirstCodeBlock(md, 'python'), '');
  assert.equal(aiChat.extractFirstCodeBlock(md, 'r'), '');
});

// ---- extractLangSegment ----------------------------------------------------
// parseHybridScript selv er definert i index.html (bare global, delt
// script-scope — samme cross-fil-mønster som activeEditorMode/
// microdataCatalog ellers i js/ai-chat.js). Stubbes her for testens formål.

test('extractLangSegment: splitter #micro-header fra #python-koden via parseHybridScript', () => {
  global.parseHybridScript = function (text) {
    // Enkel stand-in: alt før "#python" er microdata, resten er pyodide.
    const idx = text.indexOf('#python');
    if (idx < 0) return [{ kind: 'microdata', text: text }];
    return [
      { kind: 'microdata', text: text.slice(0, idx) },
      { kind: 'pyodide', text: text.slice(idx + '#python'.length) },
    ];
  };
  const script = '#micro\nrequire no.ssb.fdb:53 as fd\n\n#python\nfolk["kjonn"].value_counts()';
  const seg = aiChat.extractLangSegment(script, 'python');
  assert.equal(seg.includes('require'), false);
  assert.equal(seg.includes('value_counts'), true);
  delete global.parseHybridScript;
});

test('extractLangSegment: faller tilbake til hele scriptet uten parseHybridScript', () => {
  delete global.parseHybridScript;
  const script = '#micro\nimport fd/X as y\n\n#r\nsummary(y)';
  assert.equal(aiChat.extractLangSegment(script, 'r'), script);
});

// ---- findUnknownVarNames / buildRepairErrors (uendret — regresjonssikring) --

test('findUnknownVarNames + buildRepairErrors: uendret format', () => {
  global.microdataVariableNames = ['BEFOLKNING_KJOENN'];
  const unknown = aiChat.findUnknownVarNames('import fd/OPPDIKTET_VARIABEL as x');
  assert.deepEqual(unknown, ['OPPDIKTET_VARIABEL']);
  const errStr = aiChat.buildRepairErrors({ skipped: true }, unknown);
  assert.equal(errStr, 'Ukjente variabelnavn (finnes ikke i katalogen): OPPDIKTET_VARIABEL');
  delete global.microdataVariableNames;
});

// ---- _v2Validators: nivå 1-dispatch-tabellens form -------------------------

test('_v2Validators: har microdata/python/r med extract+validate+unknownNames', () => {
  ['microdata', 'python', 'r'].forEach((k) => {
    const entry = aiChat._v2Validators[k];
    assert.ok(entry, 'mangler oppføring for ' + k);
    assert.equal(typeof entry.extract, 'function');
    assert.equal(typeof entry.validate, 'function');
    assert.equal(typeof entry.unknownNames, 'function');
  });
});

test('_v2Validators.python/r.validate: skipped:true når ingen runtime er lastet (aldri boot)', async () => {
  // __pyodidePromise/webRPromise er ikke definert i dette testmiljøet — nivå
  // 1-kravet er at validatorene ALDRI booter en ny runtime for å validere;
  // dette beviser at fraværet av en allerede-lastet økt gir skipped, ikke et
  // forsøk på å laste en.
  const pyResult = await aiChat._v2Validators.python.validate('print(1)');
  assert.deepEqual(pyResult, { skipped: true });
  const rResult = await aiChat._v2Validators.r.validate('print(1)');
  assert.deepEqual(rResult, { skipped: true });
});

test('_v2Validators.python.validate: skipped:true selv med en pending pyodide-økt uten kode', async () => {
  global.__pyodidePromise = Promise.resolve(null);
  const res = await aiChat._v2Validators.python.validate('#micro\nimport fd/X as y\n');
  assert.deepEqual(res, { skipped: true });
  delete global.__pyodidePromise;
});
