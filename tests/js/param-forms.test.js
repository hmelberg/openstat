'use strict';

// param-forms.js — ren halvdel (parser + literal-skriver for #@param-skjemaer).
// Node-testet, ingen DOM (DOM-halvdelen kommer i Task 2, se
// tests/js/param-forms-dom.test.js). Grammatikk-referanse: ipyform
// (github.com/phihung/ipyform), avgrenset til W4-delsettet i planen
// (docs/superpowers/plans/2026-07-15-notebook-widgets-w4.md).

const test = require('node:test');
const assert = require('node:assert');
const PF = require('../../js/param-forms.js');

function warnSpy() {
  const calls = [];
  const orig = console.warn;
  console.warn = function () { calls.push(Array.prototype.join.call(arguments, ' ')); };
  return { calls: calls, restore: function () { console.warn = orig; } };
}

// ===== parse: type inference (bare #@param, no meta) =====

test('parse: bare number → inferred type number', () => {
  const entries = PF.parse('x = 5  #@param', 'python');
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].meta.type, 'number');
  assert.strictEqual(entries[0].varName, 'x');
  assert.strictEqual(entries[0].assignOp, '=');
  assert.strictEqual(entries[0].valueRaw, '5');
  assert.strictEqual(entries[0].lineIdx, 0);
});

test('parse: bare quoted string → inferred type string', () => {
  const entries = PF.parse("x = 'hei'  #@param", 'python');
  assert.strictEqual(entries[0].meta.type, 'string');
});

test('parse: bare double-quoted string → inferred type string', () => {
  const entries = PF.parse('x = "hei"  #@param', 'python');
  assert.strictEqual(entries[0].meta.type, 'string');
});

test('parse: bare True (python) → inferred type boolean', () => {
  const entries = PF.parse('x = True  #@param', 'python');
  assert.strictEqual(entries[0].meta.type, 'boolean');
});

test('parse: bare TRUE (r) → inferred type boolean', () => {
  const entries = PF.parse('x <- TRUE #@param', 'r');
  assert.strictEqual(entries[0].meta.type, 'boolean');
  assert.strictEqual(entries[0].assignOp, '<-');
});

test('parse: bare FALSE/False also boolean', () => {
  assert.strictEqual(PF.parse('x = False #@param', 'python')[0].meta.type, 'boolean');
  assert.strictEqual(PF.parse('x <- FALSE #@param', 'r')[0].meta.type, 'boolean');
});

test('parse: bare negative/decimal number inferred', () => {
  assert.strictEqual(PF.parse('x = -3.5  #@param', 'python')[0].meta.type, 'number');
});

test('parse: bare non-quoted non-numeric non-bool → inferred raw', () => {
  const entries = PF.parse('x = compute_default()  #@param', 'python');
  assert.strictEqual(entries[0].meta.type, 'raw');
  assert.strictEqual(entries[0].valueRaw, 'compute_default()');
});

// ===== parse: <- assignment (R) =====

test('parse: R <- assignment with explicit type', () => {
  const entries = PF.parse('x <- 3 #@param {type:"integer"}', 'r');
  assert.strictEqual(entries[0].assignOp, '<-');
  assert.strictEqual(entries[0].meta.type, 'integer');
  assert.strictEqual(entries[0].varName, 'x');
});

// ===== parse: bare array (dropdown) =====

test('parse: bare array literal → string dropdown', () => {
  const entries = PF.parse('x = "b"  #@param ["a", "b", "c"]', 'python');
  assert.strictEqual(entries[0].meta.type, 'string');
  assert.deepStrictEqual(entries[0].meta.options, ['a', 'b', 'c']);
});

test('parse: array + allow-input object → allowInput true, options preserved', () => {
  const entries = PF.parse('x = "b"  #@param ["a", "b"] {"allow-input": true}', 'python');
  assert.deepStrictEqual(entries[0].meta.options, ['a', 'b']);
  assert.strictEqual(entries[0].meta.allowInput, true);
});

// ===== parse: loose JSON object metas =====

test('parse: loose unquoted-key meta (slider, min/max/step)', () => {
  const entries = PF.parse('x = 3  #@param {type:"slider", min:0, max:10, step:2}', 'python');
  assert.strictEqual(entries[0].meta.type, 'slider');
  assert.strictEqual(entries[0].meta.min, 0);
  assert.strictEqual(entries[0].meta.max, 10);
  assert.strictEqual(entries[0].meta.step, 2);
});

test('parse: standard quoted JSON meta also works', () => {
  const entries = PF.parse('x = 3  #@param {"type": "slider", "min": 0, "max": 10}', 'python');
  assert.strictEqual(entries[0].meta.type, 'slider');
  assert.strictEqual(entries[0].meta.min, 0);
  assert.strictEqual(entries[0].meta.max, 10);
});

test('parse: run:"auto" sets runAuto', () => {
  const entries = PF.parse('x = 3  #@param {type:"slider", min:0, max:10, run:"auto"}', 'python');
  assert.strictEqual(entries[0].meta.runAuto, true);
});

test('parse: no run key → runAuto not set', () => {
  const entries = PF.parse('x = 3  #@param {type:"slider", min:0, max:10}', 'python');
  assert.ok(!entries[0].meta.runAuto);
});

test('parse: boolean type explicit', () => {
  const entries = PF.parse('x = True  #@param {type:"boolean"}', 'python');
  assert.strictEqual(entries[0].meta.type, 'boolean');
});

test('parse: date type', () => {
  const entries = PF.parse("x = '2024-01-01'  #@param {type:\"date\"}", 'python');
  assert.strictEqual(entries[0].meta.type, 'date');
});

test('parse: raw type explicit', () => {
  const entries = PF.parse('x = 1  #@param {type:"raw"}', 'python');
  assert.strictEqual(entries[0].meta.type, 'raw');
});

// ===== parse: unknown key → per-entry warning, not fatal =====

test('parse: unknown key in meta object → entry kept, warning attached', () => {
  const entries = PF.parse('x = 3  #@param {type:"slider", min:0, max:10, foo:1}', 'python');
  assert.strictEqual(entries.length, 1);
  assert.ok(entries[0].warnings.some((w) => /foo/.test(w)));
});

// ===== parse: malformed / unknown type → warn + skipped (no entry) =====

test('parse: unknown type → console.warn + skipped', () => {
  const spy = warnSpy();
  const entries = PF.parse('x = 3  #@param {type:"emoji"}', 'python');
  spy.restore();
  assert.strictEqual(entries.length, 0);
  assert.ok(spy.calls.some((c) => /emoji|type/.test(c)));
});

test('parse: malformed meta (unbalanced brace) → console.warn + skipped', () => {
  const spy = warnSpy();
  const entries = PF.parse('x = 3  #@param {type:"slider", min:0', 'python');
  spy.restore();
  assert.strictEqual(entries.length, 0);
  assert.ok(spy.calls.length >= 1);
});

test('parse: malformed meta (garbage, not [ or {) → console.warn + skipped', () => {
  const spy = warnSpy();
  const entries = PF.parse('x = 3  #@param not valid json at all !!', 'python');
  spy.restore();
  assert.strictEqual(entries.length, 0);
  assert.ok(spy.calls.length >= 1);
});

test('parse: unparseable array → console.warn + skipped', () => {
  const spy = warnSpy();
  const entries = PF.parse('x = 3  #@param [a, b, ]]]', 'python');
  spy.restore();
  assert.strictEqual(entries.length, 0);
  assert.ok(spy.calls.length >= 1);
});

// ===== parse: non-param lines untouched / multi-param cells =====

test('parse: non-param lines produce no entries', () => {
  const src = [
    'import statx',
    '# a normal comment, not a param',
    'y = 1 + 2',
    'print(y)  # just a trailing comment'
  ].join('\n');
  assert.deepStrictEqual(PF.parse(src, 'python'), []);
});

test('parse: multiple params in one cell → multiple entries, correct lineIdx', () => {
  const src = [
    'import statx',
    'n = 3  #@param {type:"slider", min:0, max:10}',
    '# not a param',
    'name = "alice"  #@param',
    'flag = True  #@param {type:"boolean"}'
  ].join('\n');
  const entries = PF.parse(src, 'python');
  assert.strictEqual(entries.length, 3);
  assert.deepStrictEqual(entries.map((e) => e.lineIdx), [1, 3, 4]);
  assert.deepStrictEqual(entries.map((e) => e.varName), ['n', 'name', 'flag']);
});

test('parse: mixed valid + malformed lines → only valid ones kept', () => {
  const spy = warnSpy();
  const src = [
    'a = 1  #@param',
    'b = 2  #@param {type:"nope"}',
    'c = 3  #@param'
  ].join('\n');
  const entries = PF.parse(src, 'python');
  spy.restore();
  assert.deepStrictEqual(entries.map((e) => e.varName), ['a', 'c']);
});

// ===== writeValue: byte-exact splicing =====

test('writeValue: replaces only the value span, preserves indent/spacing/comment', () => {
  const src = '    x = 3  #@param {type:"slider", min:0, max:10, step:2}';
  const entries = PF.parse(src, 'python');
  const out = PF.writeValue(src, entries[0], 7, 'python');
  assert.strictEqual(out, '    x = 7  #@param {type:"slider", min:0, max:10, step:2}');
});

test('writeValue: tight spacing (no spaces) preserved exactly', () => {
  const src = 'x=3#@param {type:"integer"}';
  const entries = PF.parse(src, 'python');
  const out = PF.writeValue(src, entries[0], 9, 'python');
  assert.strictEqual(out, 'x=9#@param {type:"integer"}');
});

test('writeValue: only the target line changes in a multi-line cell', () => {
  const src = [
    'a = 1  #@param',
    'b = 2  #@param'
  ].join('\n');
  const entries = PF.parse(src, 'python');
  const out = PF.writeValue(src, entries[1], 99, 'python');
  assert.strictEqual(out, [
    'a = 1  #@param',
    'b = 99  #@param'
  ].join('\n'));
});

test('writeValue: string escaping — embedded single quote', () => {
  const src = "s = 'x'  #@param";
  const entries = PF.parse(src, 'python');
  const out = PF.writeValue(src, entries[0], "it's", 'python');
  assert.strictEqual(out, "s = 'it\\'s'  #@param");
});

test('writeValue: boolean formatted True/False for python', () => {
  const src = 'flag = True  #@param {type:"boolean"}';
  const entries = PF.parse(src, 'python');
  assert.strictEqual(PF.writeValue(src, entries[0], false, 'python'),
    'flag = False  #@param {type:"boolean"}');
});

test('writeValue: boolean formatted TRUE/FALSE for r', () => {
  const src = 'flag <- TRUE #@param {type:"boolean"}';
  const entries = PF.parse(src, 'r');
  assert.strictEqual(PF.writeValue(src, entries[0], false, 'r'),
    'flag <- FALSE #@param {type:"boolean"}');
});

test('writeValue: raw type inserted verbatim, no quoting', () => {
  const src = 'x = old_expr()  #@param {type:"raw"}';
  const entries = PF.parse(src, 'python');
  const out = PF.writeValue(src, entries[0], 'new_expr(1,2)', 'python');
  assert.strictEqual(out, 'x = new_expr(1,2)  #@param {type:"raw"}');
});

test('writeValue: date formatted as quoted ISO string', () => {
  const src = "d = '2024-01-01'  #@param {type:\"date\"}";
  const entries = PF.parse(src, 'python');
  const out = PF.writeValue(src, entries[0], '2025-06-15', 'python');
  assert.strictEqual(out, "d = '2025-06-15'  #@param {type:\"date\"}");
});

test('writeValue: dropdown (string type from bare array) quoted on write', () => {
  const src = 'x = "a"  #@param ["a", "b", "c"]';
  const entries = PF.parse(src, 'python');
  const out = PF.writeValue(src, entries[0], 'c', 'python');
  assert.strictEqual(out, 'x = \'c\'  #@param ["a", "b", "c"]');
});

// ===== currentValue: typed seed for the control =====

test('currentValue: string unquoted, escapes undone', () => {
  const entries = PF.parse("s = 'it\\'s'  #@param", 'python');
  assert.strictEqual(PF.currentValue(entries[0], 'python'), "it's");
});

test('currentValue: number/integer/slider parsed as JS number', () => {
  const e1 = PF.parse('x = 3  #@param {type:"slider", min:0, max:10}', 'python')[0];
  assert.strictEqual(PF.currentValue(e1, 'python'), 3);
  const e2 = PF.parse('x = 3.5  #@param', 'python')[0];
  assert.strictEqual(PF.currentValue(e2, 'python'), 3.5);
});

test('currentValue: boolean parsed as JS boolean (python + r)', () => {
  const ePy = PF.parse('x = True  #@param', 'python')[0];
  assert.strictEqual(PF.currentValue(ePy, 'python'), true);
  const eR = PF.parse('x <- FALSE #@param', 'r')[0];
  assert.strictEqual(PF.currentValue(eR, 'r'), false);
});

test('currentValue: raw returned verbatim as string', () => {
  const e = PF.parse('x = foo(1, 2)  #@param', 'python')[0];
  assert.strictEqual(PF.currentValue(e, 'python'), 'foo(1, 2)');
});

test('currentValue: date returned as unquoted string', () => {
  const e = PF.parse("d = '2024-01-01'  #@param {type:\"date\"}", 'python')[0];
  assert.strictEqual(PF.currentValue(e, 'python'), '2024-01-01');
});

// ===== formatLiteral (exposed for direct testing per plan's writeValue doc) =====

test('formatLiteral: string escapes both backslash and quote', () => {
  assert.strictEqual(PF.formatLiteral("back\\slash and 'quote'", 'string', 'python'),
    "'back\\\\slash and \\'quote\\''");
});

test('formatLiteral: integer rounds to nearest', () => {
  assert.strictEqual(PF.formatLiteral(3.9, 'integer', 'python'), '4');
});
