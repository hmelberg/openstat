// tests/js/svar-refs.test.js — ren referansekjerne portert fra askstats
// tests/js/ask-view.test.js (kun blokkene for coerceAskDepth, assignRefs,
// formatOutputsManifest, stripRefs — planRefResolution porteres ikke, se
// js/svar-refs.js). js/svar-refs.js er en nettleser-IIFE med samme
// module.exports-seam og document-stubb-mønster som ai-chat-validators.test.js.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

global.window = global;
global.document = {
  readyState: 'complete',
  addEventListener: function () {},
  getElementById: function () { return null; },
  documentElement: { classList: { contains: function () { return false; } } },
};

const svarRefs = require(path.join(__dirname, '..', '..', 'js', 'svar-refs.js'));

test('coerceAskDepth: kun deep er deep', () => {
  assert.equal(svarRefs.coerceAskDepth('deep'), 'deep');
  assert.equal(svarRefs.coerceAskDepth('fast'), 'standard');
  assert.equal(svarRefs.coerceAskDepth(null), 'standard');
});

test('assignRefs: nummerering per klasse i dokumentrekkefølge', () => {
  const refs = svarRefs.assignRefs([
    { kind: 'plotly' }, { kind: 'table' }, { kind: 'png' },
    { kind: 'tabulator' }, { kind: 'controls' }]);
  assert.deepStrictEqual(refs.map(r => r.ref),
    ['fig:1', 'table:1', 'fig:2', 'table:2', 'controls:1']);
  assert.deepStrictEqual(refs.map(r => r.idx), [0, 1, 2, 3, 4]);
});

test('assignRefs: anker opptar nummeret sitt', () => {
  // fig:1 er flyttet ut (anker står igjen) → neste fig blir fig:2
  const refs = svarRefs.assignRefs([{ anchor: 'fig:1' }, { kind: 'plotly' }]);
  assert.deepStrictEqual(refs.map(r => r.ref), ['fig:2']);
  assert.strictEqual(refs[0].idx, 1);
});

test('assignRefs: anker med høyt nummer + ukjent kind hoppes over', () => {
  const refs = svarRefs.assignRefs([
    { kind: 'plotly' }, { anchor: 'fig:2' }, { kind: 'png' }, {}, { anchor: 'tull' }]);
  assert.deepStrictEqual(refs.map(r => r.ref), ['fig:1', 'fig:3']);
});

test('formatOutputsManifest: parentes kun når kind ≠ klasse', () => {
  assert.strictEqual(svarRefs.formatOutputsManifest([]), '');
  assert.strictEqual(
    svarRefs.formatOutputsManifest(svarRefs.assignRefs([
      { kind: 'plotly' }, { kind: 'table' }, { kind: 'tabulator' }])),
    'OUTPUTS: fig:1 (plotly), table:1, table:2 (tabulator)');
});

test('stripRefs: plassholder-alene-linjer → klammetekst', () => {
  assert.strictEqual(svarRefs.stripRefs('a\n{{fig:1}}\n tekst {{fig:2}} inni\n{{table:3}} \nb'),
    'a\n[fig 1]\n tekst {{fig:2}} inni\n[table 3]\nb');
  assert.strictEqual(svarRefs.stripRefs(null), '');
});
