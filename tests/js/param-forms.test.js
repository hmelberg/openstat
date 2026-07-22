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

// B2 Task 4-fiks: bart numerisk array-literal — options er fortsatt strenger
// (DOM <option>-verdier), men optionTypes husker at ELEMENTENE var tall
// (looseJsonParse gir ekte JS-tall for numeriske literaler), slik at
// writeValue kan formatere den valgte verdien tilbake UNQUOTED.
test('parse: bare NUMERIC array literal → options stringified, optionTypes all "number"', () => {
  const entries = PF.parse('n = 5 #@param [1, 2, 3]', 'python');
  assert.strictEqual(entries[0].meta.type, 'string', 'meta.type forblir "string" — det er kontroll-dispatchens type, uendret');
  assert.deepStrictEqual(entries[0].meta.options, ['1', '2', '3']);
  assert.deepStrictEqual(entries[0].meta.optionTypes, ['number', 'number', 'number']);
});

test('parse: BLANDET array-literal ([1, "to", 3]) → optionTypes per element', () => {
  const entries = PF.parse('n = 1 #@param [1, "to", 3]', 'python');
  assert.deepStrictEqual(entries[0].meta.options, ['1', 'to', '3']);
  assert.deepStrictEqual(entries[0].meta.optionTypes, ['number', 'string', 'number']);
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

test('parse: run:"auto" sets runAuto (eksplisitt, samme som default)', () => {
  const entries = PF.parse('x = 3  #@param {type:"slider", min:0, max:10, run:"auto"}', 'python');
  assert.strictEqual(entries[0].meta.runAuto, true);
});

test('parse: ingen run-nøkkel → runAuto er DEFAULT (auto)', () => {
  const entries = PF.parse('x = 3  #@param {type:"slider", min:0, max:10}', 'python');
  assert.strictEqual(entries[0].meta.runAuto, true);
});

test('parse: bare #@param uten metadata → runAuto default', () => {
  const entries = PF.parse('x = 3  #@param', 'python');
  assert.strictEqual(entries[0].meta.runAuto, true);
});

test('parse: run:"manual" slår av auto-kjøring', () => {
  const entries = PF.parse('x = 3  #@param {type:"slider", run:"manual"}', 'python');
  assert.strictEqual(entries[0].meta.runAuto, false);
});

test('parse: ugyldig run-verdi → advarsel, beholder auto-default', () => {
  const entries = PF.parse('x = 3  #@param {type:"slider", run:"nei"}', 'python');
  assert.strictEqual(entries[0].meta.runAuto, true);
  assert.ok(entries[0].warnings.some((w) => w.includes('run')));
});

// ===== parse: placement (Task 3, per-kontroll plassering) =====

test('parse: placement absent → meta.placement undefined (linja følger cellens default)', () => {
  const entries = PF.parse('x = 3  #@param {type:"slider", min:0, max:10}', 'python');
  assert.strictEqual(entries[0].meta.placement, undefined);
});

test('parse: placement "top"/"bottom"/"left" passthrough uendret', () => {
  ['top', 'bottom', 'left'].forEach((pos) => {
    const entries = PF.parse('x = 3  #@param {type:"slider", placement:"' + pos + '"}', 'python');
    assert.strictEqual(entries[0].meta.placement, pos);
    assert.deepStrictEqual(entries[0].warnings, []);
  });
});

test('parse: ugyldig placement → advarsel + IGNORERT (linja beholdes, meta.placement udefinert)', () => {
  const entries = PF.parse('x = 3  #@param {type:"slider", placement:"middle"}', 'python');
  assert.strictEqual(entries.length, 1, 'ikke-fatalt — linja beholdes');
  assert.strictEqual(entries[0].meta.placement, undefined);
  assert.ok(entries[0].warnings.some((w) => /ugyldig placement/.test(w)));
});

test('parse: placement er en KJENT nøkkel — varsler ikke som "ukjent nøkkel"', () => {
  const entries = PF.parse('x = 3  #@param {type:"slider", placement:"left"}', 'python');
  assert.ok(!entries[0].warnings.some((w) => /ukjent nøkkel/.test(w)));
});

test('parse: bart array-literal + eksplisitt placement object ([...] {placement:"left"})', () => {
  const entries = PF.parse('name = \'a\'  #@param ["a", "b"] {placement:"left"}', 'python');
  assert.strictEqual(entries[0].meta.placement, 'left');
  assert.deepStrictEqual(entries[0].meta.options, ['a', 'b']);
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

// ===== parse: #@title / #@markdown (Colab parity, Task 1 — see
// docs/superpowers/specs/2026-07-22-param-colab-parity-design.md) =====

test('parse: param entries carry kind:"param"', () => {
  const entries = PF.parse('x = 3  #@param', 'python');
  assert.strictEqual(entries[0].kind, 'param');
});

test('parse: #@title with text only → kind:"title" entry, text captured, no meta', () => {
  const entries = PF.parse('#@title My Form', 'python');
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].kind, 'title');
  assert.strictEqual(entries[0].text, 'My Form');
  assert.strictEqual(entries[0].lineIdx, 0);
  assert.strictEqual(entries[0].meta.runAuto, true, 'no run: meta → default auto');
});

test('parse: #@title with {run:"manual"} meta → meta captured, cellRunDefault "manual"', () => {
  const entries = PF.parse('#@title My Form {run:"manual"}', 'python');
  assert.strictEqual(entries[0].kind, 'title');
  assert.strictEqual(entries[0].text, 'My Form');
  assert.strictEqual(entries[0].meta.runAuto, false);
  assert.strictEqual(PF.cellRunDefault(entries), 'manual');
});

test('cellRunDefault: no title entry → "auto"', () => {
  const entries = PF.parse('x = 1  #@param', 'python');
  assert.strictEqual(PF.cellRunDefault(entries), 'auto');
});

test('cellRunDefault: title with explicit run:"auto" → "auto"', () => {
  const entries = PF.parse('#@title Form {run:"auto"}', 'python');
  assert.strictEqual(PF.cellRunDefault(entries), 'auto');
});

test('parse: #@title display-mode:"form" → honored — meta.displayMode stored, no warning', () => {
  const spy = warnSpy();
  const entries = PF.parse('#@title My Form {display-mode:"form"}', 'python');
  spy.restore();
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].kind, 'title');
  assert.strictEqual(entries[0].meta.displayMode, 'form', 'vekket 2026-07-22 — parses OG lagres nå');
  assert.strictEqual(entries[0].meta['display-mode'], undefined, 'lagres under camelCase displayMode, ikke rå nøkkelen');
  assert.strictEqual(spy.calls.length, 0, 'gyldig verdi skal ikke varsle');
});

test('parse: #@title display-mode med ugyldig verdi → fortsatt varsel+drop, meldingen navngir "form"', () => {
  const spy = warnSpy();
  const entries = PF.parse('#@title My Form {display-mode:"column"}', 'python');
  spy.restore();
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].kind, 'title');
  assert.strictEqual(entries[0].meta.displayMode, undefined, 'ugyldig verdi lagres ikke');
  assert.ok(spy.calls.some((c) => /display-mode/.test(c) && /"form"/.test(c)),
    'meldingen navngir den gyldige verdien i stedet for å kalle hele nøkkelen utsatt');
});

test('parse: second #@title → warn + ignored, not in entries', () => {
  const spy = warnSpy();
  const src = ['#@title First', '#@title Second'].join('\n');
  const entries = PF.parse(src, 'python');
  spy.restore();
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].text, 'First');
  assert.ok(spy.calls.some((c) => /title/.test(c)));
});

test('parse: #@markdown lines → kind:"markdown" entries in source order, text trimmed', () => {
  const src = [
    '#@markdown  Some explanatory text  ',
    'x = 1  #@param',
    '#@markdown More text'
  ].join('\n');
  const entries = PF.parse(src, 'python');
  assert.strictEqual(entries.length, 3);
  assert.strictEqual(entries[0].kind, 'markdown');
  assert.strictEqual(entries[0].text, 'Some explanatory text');
  assert.strictEqual(entries[1].kind, 'param');
  assert.strictEqual(entries[2].kind, 'markdown');
  assert.strictEqual(entries[2].text, 'More text');
  assert.deepStrictEqual(entries.map((e) => e.lineIdx), [0, 1, 2]);
});

test('parse: consecutive #@markdown lines → separate entries (not merged)', () => {
  const src = ['#@markdown First line', '#@markdown Second line'].join('\n');
  const entries = PF.parse(src, 'python');
  assert.strictEqual(entries.length, 2);
  assert.deepStrictEqual(entries.map((e) => e.text), ['First line', 'Second line']);
});

test('parse: //@title and //@markdown recognized (javascript dialect, lang-independent like //@param)', () => {
  const src = [
    '//@title JS Form',
    '//@markdown some prose',
    'n = 5  //@param'
  ].join('\n');
  const entries = PF.parse(src, 'javascript');
  assert.strictEqual(entries.length, 3);
  assert.strictEqual(entries[0].kind, 'title');
  assert.strictEqual(entries[0].text, 'JS Form');
  assert.strictEqual(entries[1].kind, 'markdown');
  assert.strictEqual(entries[1].text, 'some prose');
  assert.strictEqual(entries[2].kind, 'param');
});

// Marker-toleranse: planens Global Constraints ber oss speile LINE_RE sin
// EKSISTERENDE toleranse ("# @param" med mellomrom matcher) for
// #@title/#@markdown også, for konsistens INNAD i OpenStat — dette er en
// BEVISST AVVIK fra spec-teksten ("# @title stays a comment"/Colab-strict),
// se code-kommentar ved TITLE_RE/MD_RE.
test('parse: "# @title" (mellomrom etter #) matches — MIRRORS LINE_RE tolerance, deviates from spec text', () => {
  const entries = PF.parse('# @title Spaced', 'python');
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].kind, 'title');
  assert.strictEqual(entries[0].text, 'Spaced');
});

test('parse: "# @markdown" (mellomrom etter #) matches — same tolerance', () => {
  const entries = PF.parse('# @markdown Spaced prose', 'python');
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].kind, 'markdown');
  assert.strictEqual(entries[0].text, 'Spaced prose');
});

test('parse: #@title text ending in a non-meta "{...}" is kept as literal text (meta parse failure → no split)', () => {
  const entries = PF.parse('#@title Use braces like {this}', 'python');
  assert.strictEqual(entries[0].kind, 'title');
  assert.strictEqual(entries[0].text, 'Use braces like {this}');
  assert.strictEqual(entries[0].meta.runAuto, true);
});

test('parse: run-default inheritance — manual title → params without own run: inherit effective manual', () => {
  const src = [
    '#@title Form {run:"manual"}',
    'x = 1  #@param',
    'y = 2  #@param {type:"integer", run:"auto"}'
  ].join('\n');
  const entries = PF.parse(src, 'python');
  const params = entries.filter((e) => e.kind === 'param');
  assert.strictEqual(params[0].meta.runAuto, false, 'inherits manual default from title');
  assert.strictEqual(params[1].meta.runAuto, true, 'explicit run:"auto" on the param line overrides the title default');
});

test('parse: no title → params keep their own auto/manual behavior unchanged (regression)', () => {
  const src = [
    'x = 1  #@param',
    'y = 2  #@param {type:"integer", run:"manual"}'
  ].join('\n');
  const entries = PF.parse(src, 'python');
  assert.strictEqual(entries[0].meta.runAuto, true);
  assert.strictEqual(entries[1].meta.runAuto, false);
});

test('parse: title placed AFTER params still applies its run-default (order-independent)', () => {
  const src = [
    'x = 1  #@param',
    '#@title Form {run:"manual"}'
  ].join('\n');
  const entries = PF.parse(src, 'python');
  const param = entries.find((e) => e.kind === 'param');
  assert.strictEqual(param.meta.runAuto, false);
});

test('parse: unknown key in @title-metadata → non-fatal warning attached, title kept', () => {
  const entries = PF.parse('#@title Form {foo:1}', 'python');
  assert.strictEqual(entries.length, 1);
  assert.ok(entries[0].warnings.some((w) => /foo/.test(w)));
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

// B2 Task 4-fiks — reviewerens repro: n = 5 #@param [1, 2, 3], velg "2" i
// dropdownen → skal skrive n = 2 (unquoted numerisk literal), IKKE n = '2'
// (meta.type er 'string' — uten per-opsjon-typingen ville formatLiteral
// kvotert verdien som en streng).
test('writeValue: numerisk bart array-literal skriver UNQUOTED tallverdi ved valg (reviewer-repro)', () => {
  const src = 'n = 5 #@param [1, 2, 3]';
  const entries = PF.parse(src, 'python');
  const out = PF.writeValue(src, entries[0], '2', 'python');
  assert.strictEqual(out, 'n = 2 #@param [1, 2, 3]');
});

test('writeValue: blandet array-literal — numerisk opsjon unquoted, streng-opsjon quoted (per-element)', () => {
  const src = 'n = 1 #@param [1, "to", 3]';
  const entries = PF.parse(src, 'python');
  assert.strictEqual(PF.writeValue(src, entries[0], '3', 'python'), 'n = 3 #@param [1, "to", 3]',
    'numerisk opsjon "3" → unquoted 3');
  assert.strictEqual(PF.writeValue(src, entries[0], 'to', 'python'), "n = 'to' #@param [1, \"to\", 3]",
    'streng-opsjon "to" → quoted \'to\'');
});

test('writeValue: rene objekt-form-options ({"type":"string","options":[...]}, INGEN bart array-prefiks) er UENDRET — ingen optionTypes, quoted som før fiksen', () => {
  const src = 'x = "a" #@param {"type": "string", "options": ["a", "b"]}';
  const entries = PF.parse(src, 'python');
  // Ingen ledende "["-array her — options kommer fra objekt-nøkkelen
  // "options" (linje ~178 i param-forms.js), en HELT ANNEN grein enn den
  // bare array-literal-formen som nå produserer optionTypes. Denne entryen
  // har derfor ingen optionTypes, og writeValue faller tilbake til
  // entry.meta.type ('string') akkurat som før fiksen.
  assert.strictEqual(entries[0].meta.optionTypes, undefined);
  assert.strictEqual(PF.writeValue(src, entries[0], 'b', 'python'),
    'x = \'b\' #@param {"type": "string", "options": ["a", "b"]}');
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

// ===== escape-bevaring: \t/\n/skråstrek-sekvenser må overleve round-trip =====
// (review-fiks 1: unquoteString strippet tidligere backslash av ALLE escapede
// tegn — 'sep = \'\\t\'' round-trippet til 'sep = \'t\''. Nå unescapes KUN
// \\ og anførselstegnet; alle andre backslash-sekvenser er byte-intakte.)

test("currentValue: '\\t' → two-char string backslash-t (not unescaped)", () => {
  const e = PF.parse("sep = '\\t'  #@param", 'python')[0];
  assert.strictEqual(PF.currentValue(e, 'python'), '\\t');
});

test("round-trip byte-exact: '\\t'", () => {
  const src = "sep = '\\t'  #@param";
  const e = PF.parse(src, 'python')[0];
  const out = PF.writeValue(src, e, PF.currentValue(e, 'python'), 'python');
  assert.strictEqual(out, src);
});

test("round-trip byte-exact: '\\n'", () => {
  const src = "sep = '\\n'  #@param {type:\"string\"}";
  const e = PF.parse(src, 'python')[0];
  const out = PF.writeValue(src, e, PF.currentValue(e, 'python'), 'python');
  assert.strictEqual(out, src);
});

test("round-trip byte-exact: 'a\\'b' (escaped quote)", () => {
  const src = "s = 'a\\'b'  #@param";
  const e = PF.parse(src, 'python')[0];
  assert.strictEqual(PF.currentValue(e, 'python'), "a'b");
  const out = PF.writeValue(src, e, PF.currentValue(e, 'python'), 'python');
  assert.strictEqual(out, src);
});

test("round-trip byte-exact: 'a\\\\' (escaped trailing backslash)", () => {
  const src = "s = 'a\\\\'  #@param";
  const e = PF.parse(src, 'python')[0];
  assert.strictEqual(PF.currentValue(e, 'python'), 'a\\');
  const out = PF.writeValue(src, e, PF.currentValue(e, 'python'), 'python');
  assert.strictEqual(out, src);
});

// ===== CRLF documents (review-fiks 2) =====

test('parse: CRLF document → entries found (\\r not part of the match)', () => {
  const src = 'a = 1  #@param\r\nb = 2  #@param {type:"integer"}\r\n';
  const entries = PF.parse(src, 'python');
  assert.strictEqual(entries.length, 2);
  assert.deepStrictEqual(entries.map((e) => e.varName), ['a', 'b']);
  assert.strictEqual(entries[0].valueRaw, '1');
});

test('writeValue: CRLF document → line endings preserved byte-exact', () => {
  const src = 'a = 1  #@param\r\nb = 2  #@param {type:"integer"}\r\nprint(a)\r\n';
  const entries = PF.parse(src, 'python');
  const out = PF.writeValue(src, entries[0], 9, 'python');
  assert.strictEqual(out, 'a = 9  #@param\r\nb = 2  #@param {type:"integer"}\r\nprint(a)\r\n');
});

test('writeValue: CRLF round-trip with unchanged value is a byte-exact no-op', () => {
  const src = 'x = 3  #@param {type:"slider", min:0, max:10}\r\n';
  const e = PF.parse(src, 'python')[0];
  assert.strictEqual(PF.writeValue(src, e, PF.currentValue(e, 'python'), 'python'), src);
});

// ===== NaN-validering av min/max/step (review-fiks 3) =====

test('parse: non-numeric min/max/step → warning, key dropped, entry kept', () => {
  const entries = PF.parse('x = 3  #@param {type:"slider", min:0, max:10, step:big}', 'python');
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].meta.step, undefined);
  assert.strictEqual(entries[0].meta.min, 0);
  assert.strictEqual(entries[0].meta.max, 10);
  assert.ok(entries[0].warnings.some((w) => /step/.test(w)));
});

// ===== pinning-tester: farlige linjeformer feiler TRYGT (review-punkt 4) =====

test('pin: "#@param" inside a string value → skipped + warned, never corrupted', () => {
  const spy = warnSpy();
  const src = 'x = "text with #@param inside" #@param {type:"string"}';
  const entries = PF.parse(src, 'python');
  spy.restore();
  // Regexen (planens grammatikk) matcher det FØRSTE #@param — som her står
  // inni streng-literalen. Metadata-teksten blir da 'inside" #@param {...}',
  // som verken er [ eller { → fatal advarsel + hele linja hoppes over.
  // TRYGT: ingen entry betyr at writeValue aldri kan nå (og korruptere) linja.
  assert.strictEqual(entries.length, 0);
  assert.ok(spy.calls.length >= 1);
});

test('pin: expression value (x = x + 1 #@param) → raw entry, splice-safe', () => {
  const src = 'x = x + 1 #@param';
  const entries = PF.parse(src, 'python');
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].meta.type, 'raw');
  assert.strictEqual(entries[0].valueRaw, 'x + 1');
  // Round-trip med uendret verdi er en byte-nøyaktig no-op.
  assert.strictEqual(PF.writeValue(src, entries[0], PF.currentValue(entries[0], 'python'), 'python'), src);
});

test('pin: multiple #@param on one line → skipped + warned', () => {
  const spy = warnSpy();
  const entries = PF.parse('x = 1 #@param #@param {type:"integer"}', 'python');
  spy.restore();
  // Første #@param matches; resten (' #@param {...}') er ugyldig metadata
  // (starter ikke med [ eller {) → fatal advarsel + linja hoppes over.
  assert.strictEqual(entries.length, 0);
  assert.ok(spy.calls.length >= 1);
});

test('pin: non-raw value containing # → skipped + warned (fail-safe for comment-in-value)', () => {
  const spy = warnSpy();
  const src = 'x = 3 # note #@param {type:"slider", min:0, max:10}';
  const entries = PF.parse(src, 'python');
  spy.restore();
  // valueRaw er '3 # note' — inneholder # for slider (non-raw) → fatal advarsel + linja hoppes over.
  // TRYGT: ingen entry betyr at writeValue aldri kan nå (og korruptere) linja.
  assert.strictEqual(entries.length, 0);
  assert.ok(spy.calls.some((c) => /inneholder #/.test(c)));
});

test('pin: raw-type value containing # is allowed (raw is verbatim by design)', () => {
  const src = 'x = some_func() # with comment #@param {type:"raw"}';
  const entries = PF.parse(src, 'python');
  // raw-type tillater # i verdien — det er bare rå kildekode
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].meta.type, 'raw');
  assert.strictEqual(entries[0].valueRaw, 'some_func() # with comment');
  // Round-trip byte-exact — verdien skal aldri bli korrupt
  const out = PF.writeValue(src, entries[0], PF.currentValue(entries[0], 'python'), 'python');
  assert.strictEqual(out, src);
});

// ===== formatLiteral (exposed for direct testing per plan's writeValue doc) =====

test('formatLiteral: quote escaped; lone inner backslash left intact', () => {
  // Review-fiks 1: en backslash som IKKE står foran anførselstegn eller på
  // slutten av strengen skal IKKE dobles — ellers ville '\t'-round-trippen
  // over vært umulig. Kun anførselstegn (og backslasher som ellers ville
  // skapt tvetydighet: rett foran et anførselstegn eller helt sist) escapes.
  assert.strictEqual(PF.formatLiteral("back\\slash and 'quote'", 'string', 'python'),
    "'back\\slash and \\'quote\\''");
});

test('formatLiteral: trailing backslash doubled (would otherwise escape the closing quote)', () => {
  assert.strictEqual(PF.formatLiteral('a\\', 'string', 'python'), "'a\\\\'");
});

test('formatLiteral: integer rounds to nearest', () => {
  assert.strictEqual(PF.formatLiteral(3.9, 'integer', 'python'), '4');
});

// ===== javascript-modus: //@param-kommentarform =====

test('parse: //@param-linjer gjenkjennes (javascript)', () => {
  const src = 'terskel = 5  //@param {type:"slider", min:0, max:10}';
  const entries = PF.parse(src, 'javascript');
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].varName, 'terskel');
  assert.strictEqual(entries[0].meta.type, 'slider');
});

test('writeValue: //@param-kommentaren bevares byte-nøyaktig (javascript)', () => {
  const src = '  navn = \'iris\'  //@param {type:"string"}';
  const entries = PF.parse(src, 'javascript');
  const out = PF.writeValue(src, entries[0], 'penguins', 'javascript');
  assert.strictEqual(out, "  navn = 'penguins'  //@param {type:\"string\"}");
});

test('formatLiteral: boolean → true/false for javascript', () => {
  assert.strictEqual(PF.formatLiteral(true, 'boolean', 'javascript'), 'true');
  assert.strictEqual(PF.formatLiteral(false, 'boolean', 'javascript'), 'false');
});

test('currentValue: javascript-boolean true gjenkjennes', () => {
  const src = 'flagg = true  //@param {type:"boolean"}';
  const entries = PF.parse(src, 'javascript');
  assert.strictEqual(PF.currentValue(entries[0], 'javascript'), true);
});
