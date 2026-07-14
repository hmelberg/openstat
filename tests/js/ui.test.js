const test = require('node:test');
const assert = require('node:assert');
const Ui = require('../../js/ui.js');

// ===== normalizeSpec tests =====

test('normalizeSpec: slider defaults min/max/step', () => {
  const res = Ui.normalizeSpec({ type: 'slider' });
  assert.strictEqual(res.spec.type, 'slider');
  assert.strictEqual(res.spec.min, 0);
  assert.strictEqual(res.spec.max, 100);
  assert.strictEqual(res.spec.step, 1);
  assert.deepStrictEqual(res.warnings, []);
});

test('normalizeSpec: slider value clamped to range', () => {
  const res = Ui.normalizeSpec({ type: 'slider', value: 500, max: 200 });
  assert.strictEqual(res.spec.value, 200);
  assert.deepStrictEqual(res.warnings, []);
});

test('normalizeSpec: slider value clamped to min', () => {
  const res = Ui.normalizeSpec({ type: 'slider', min: 50, max: 100, value: 10 });
  assert.strictEqual(res.spec.value, 50);
});

test('normalizeSpec: slider with custom min/max/step/value', () => {
  const res = Ui.normalizeSpec({ type: 'slider', min: 10, max: 50, step: 5, value: 30 });
  assert.strictEqual(res.spec.min, 10);
  assert.strictEqual(res.spec.max, 50);
  assert.strictEqual(res.spec.step, 5);
  assert.strictEqual(res.spec.value, 30);
});

test('normalizeSpec: slider NaN min → defaults + warning', () => {
  const res = Ui.normalizeSpec({ type: 'slider', min: 'abc' });
  assert.ok(res.spec);
  assert.strictEqual(res.spec.min, 0);
  assert.strictEqual(res.spec.max, 100);
  assert.strictEqual(res.spec.value, 0);
  assert.ok(res.warnings.some(w => /ugyldig min/.test(w)));
});

test('normalizeSpec: slider NaN max → default + warning', () => {
  const res = Ui.normalizeSpec({ type: 'slider', max: 'xyz' });
  assert.strictEqual(res.spec.max, 100);
  assert.ok(res.warnings.some(w => /ugyldig max/.test(w)));
});

test('normalizeSpec: slider NaN value → min + warning', () => {
  const res = Ui.normalizeSpec({ type: 'slider', min: 10, max: 50, value: 'nope' });
  assert.strictEqual(res.spec.value, 10);
  assert.ok(res.warnings.some(w => /ugyldig value/.test(w)));
});

test('normalizeSpec: slider min > max → swapped + warning', () => {
  const res = Ui.normalizeSpec({ type: 'slider', min: 100, max: 0 });
  assert.ok(res.spec);
  assert.strictEqual(res.spec.min, 0);
  assert.strictEqual(res.spec.max, 100);
  assert.ok(res.warnings.some(w => /min > max/.test(w)));
});

test('normalizeSpec: number NaN value → 0 + warning', () => {
  const res = Ui.normalizeSpec({ type: 'number', value: 'notanumber' });
  assert.strictEqual(res.spec.value, 0);
  assert.ok(res.warnings.some(w => /ugyldig value/.test(w)));
});

test('normalizeSpec: dropdown requires options array', () => {
  const res = Ui.normalizeSpec({ type: 'dropdown' });
  assert.strictEqual(res.spec, null);
  assert.ok(res.warnings.some(w => /dropdown.*options/.test(w)));
});

test('normalizeSpec: dropdown with empty options array', () => {
  const res = Ui.normalizeSpec({ type: 'dropdown', options: [] });
  assert.strictEqual(res.spec, null);
  assert.ok(res.warnings.some(w => /dropdown.*options/.test(w)));
});

test('normalizeSpec: dropdown defaults to first option', () => {
  const res = Ui.normalizeSpec({ type: 'dropdown', options: ['apple', 'banana', 'cherry'] });
  assert.strictEqual(res.spec.value, 'apple');
});

test('normalizeSpec: dropdown coerces options to strings', () => {
  const res = Ui.normalizeSpec({ type: 'dropdown', options: [1, 2, 3] });
  assert.deepStrictEqual(res.spec.options, ['1', '2', '3']);
  assert.strictEqual(res.spec.value, '1');
});

test('normalizeSpec: dropdown with explicit value not in options coerces and uses it', () => {
  const res = Ui.normalizeSpec({ type: 'dropdown', options: ['a', 'b'], value: 'c' });
  assert.strictEqual(res.spec.value, 'c');
});

test('normalizeSpec: dropdown with numeric value coerced to string', () => {
  const res = Ui.normalizeSpec({ type: 'dropdown', options: ['1', '2', '3'], value: 2 });
  assert.strictEqual(res.spec.value, '2');
});

test('normalizeSpec: checkbox coerces value to boolean', () => {
  assert.strictEqual(Ui.normalizeSpec({ type: 'checkbox' }).spec.value, false);
  assert.strictEqual(Ui.normalizeSpec({ type: 'checkbox', value: true }).spec.value, true);
  assert.strictEqual(Ui.normalizeSpec({ type: 'checkbox', value: 1 }).spec.value, true);
  assert.strictEqual(Ui.normalizeSpec({ type: 'checkbox', value: 0 }).spec.value, false);
  assert.strictEqual(Ui.normalizeSpec({ type: 'checkbox', value: 'yes' }).spec.value, true);
  assert.strictEqual(Ui.normalizeSpec({ type: 'checkbox', value: '' }).spec.value, false);
});

test('normalizeSpec: switch coerces value to boolean', () => {
  assert.strictEqual(Ui.normalizeSpec({ type: 'switch' }).spec.value, false);
  assert.strictEqual(Ui.normalizeSpec({ type: 'switch', value: true }).spec.value, true);
  assert.strictEqual(Ui.normalizeSpec({ type: 'switch', value: 'on' }).spec.value, true);
});

test('normalizeSpec: number defaults to 0', () => {
  const res = Ui.normalizeSpec({ type: 'number' });
  assert.strictEqual(res.spec.value, 0);
});

test('normalizeSpec: number coerces value to numeric', () => {
  assert.strictEqual(Ui.normalizeSpec({ type: 'number', value: '42' }).spec.value, 42);
  assert.strictEqual(Ui.normalizeSpec({ type: 'number', value: '3.14' }).spec.value, 3.14);
});

// number sitt min/max/step er VALGFRITT (i motsetning til slider, som alltid
// får defaults) — speiler pyodide-fasadens ui.number(value=0, *, min=None,
// max=None, step=None, ...) signatur (Task 4). Fraværende min/max skal ikke
// dukke opp i spec i det hele tatt (ingen påtvunget default-grense).
test('normalizeSpec: number uten min/max/step → ingen av dem i spec', () => {
  const res = Ui.normalizeSpec({ type: 'number', value: 5 });
  assert.strictEqual(res.spec.min, undefined);
  assert.strictEqual(res.spec.max, undefined);
  assert.strictEqual(res.spec.step, undefined);
});

test('normalizeSpec: number med eksplisitt min/max/step → tatt med i spec', () => {
  const res = Ui.normalizeSpec({ type: 'number', value: 5, min: 0, max: 10, step: 2 });
  assert.strictEqual(res.spec.min, 0);
  assert.strictEqual(res.spec.max, 10);
  assert.strictEqual(res.spec.step, 2);
  assert.strictEqual(res.spec.value, 5);
});

test('normalizeSpec: number verdi klampes til [min,max] når begge er gitt', () => {
  const res = Ui.normalizeSpec({ type: 'number', value: 99, min: 0, max: 10 });
  assert.strictEqual(res.spec.value, 10);
});

test('normalizeSpec: number ugyldig min → varsel, min utelates fra spec', () => {
  const res = Ui.normalizeSpec({ type: 'number', value: 5, min: 'abc' });
  assert.strictEqual(res.spec.min, undefined);
  assert.ok(res.warnings.some((w) => /ugyldig min for number/.test(w)));
});

test('normalizeSpec: text defaults to empty string', () => {
  const res = Ui.normalizeSpec({ type: 'text' });
  assert.strictEqual(res.spec.value, '');
});

test('normalizeSpec: text coerces value to string', () => {
  assert.strictEqual(Ui.normalizeSpec({ type: 'text', value: 42 }).spec.value, '42');
  assert.strictEqual(Ui.normalizeSpec({ type: 'text', value: true }).spec.value, 'true');
});

test('normalizeSpec: button has label only, no value', () => {
  const res = Ui.normalizeSpec({ type: 'button', label: 'Click me' });
  assert.strictEqual(res.spec.type, 'button');
  assert.strictEqual(res.spec.label, 'Click me');
  assert.strictEqual(res.spec.value, undefined);
});

test('normalizeSpec: button without label', () => {
  const res = Ui.normalizeSpec({ type: 'button' });
  assert.strictEqual(res.spec.type, 'button');
  assert.strictEqual(res.spec.label, undefined);
});

test('normalizeSpec: unknown type → null + warning', () => {
  const res = Ui.normalizeSpec({ type: 'unknowntype' });
  assert.strictEqual(res.spec, null);
  assert.ok(res.warnings.some(w => /ukjent kontrolltype/.test(w)));
});

test('normalizeSpec: unknown type name in warning', () => {
  const res = Ui.normalizeSpec({ type: 'radio' });
  assert.ok(res.warnings.some(w => /radio/.test(w)));
});

test('normalizeSpec: unknown key warns but spec still built (uten nøkkelen)', () => {
  const res = Ui.normalizeSpec({ type: 'text', unknownKey: 'value' });
  assert.ok(res.spec, 'spec skal ikke nulles av ukjent nøkkel');
  assert.strictEqual(res.spec.type, 'text');
  assert.strictEqual(res.spec.value, '');
  assert.strictEqual(res.spec.unknownKey, undefined);
  assert.ok(res.warnings.some(w => /unknownKey/.test(w)));
});

test('normalizeSpec: multiple unknown keys warn, spec beholdes', () => {
  const res = Ui.normalizeSpec({ type: 'text', foo: 1, bar: 2 });
  assert.ok(res.spec);
  assert.strictEqual(res.spec.foo, undefined);
  assert.strictEqual(res.spec.bar, undefined);
  assert.ok(res.warnings.length >= 2);
});

test('normalizeSpec: unknown key on slider keeps normalized slider spec', () => {
  const res = Ui.normalizeSpec({ type: 'slider', value: 500, max: 200, bogus: true });
  assert.ok(res.spec);
  assert.strictEqual(res.spec.value, 200);
  assert.strictEqual(res.spec.bogus, undefined);
  assert.ok(res.warnings.some(w => /bogus/.test(w)));
});

test('normalizeSpec: rerun defaults to "self"', () => {
  const res = Ui.normalizeSpec({ type: 'text' });
  assert.strictEqual(res.spec.rerun, 'self');
});

test('normalizeSpec: rerun "none" passthrough', () => {
  const res = Ui.normalizeSpec({ type: 'text', rerun: 'none' });
  assert.strictEqual(res.spec.rerun, 'none');
});

test('normalizeSpec: rerun string id passthrough', () => {
  const res = Ui.normalizeSpec({ type: 'text', rerun: 'plot' });
  assert.strictEqual(res.spec.rerun, 'plot');
});

test('normalizeSpec: rerun array of ids passthrough', () => {
  const res = Ui.normalizeSpec({ type: 'text', rerun: ['plot', 'table'] });
  assert.deepStrictEqual(res.spec.rerun, ['plot', 'table']);
});

test('normalizeSpec: preserves name and label', () => {
  const res = Ui.normalizeSpec({ type: 'text', name: 'myvar', label: 'Enter text' });
  assert.strictEqual(res.spec.name, 'myvar');
  assert.strictEqual(res.spec.label, 'Enter text');
});

test('normalizeSpec: no warnings with valid spec', () => {
  const res = Ui.normalizeSpec({ type: 'slider', min: 0, max: 100, value: 50, label: 'Age' });
  assert.deepStrictEqual(res.warnings, []);
});

// ===== controlKey tests =====

test('controlKey: with name', () => {
  const spec = { name: 'myvar', type: 'text' };
  const key = Ui.controlKey(5, spec, 0);
  assert.strictEqual(key, '5::myvar');
});

test('controlKey: without name uses ordinal', () => {
  const spec = { type: 'text' };
  const key = Ui.controlKey(3, spec, 2);
  assert.strictEqual(key, '3::w2');
});

test('controlKey: different cellIdx and ordinal', () => {
  const spec = { type: 'slider' };
  assert.strictEqual(Ui.controlKey(0, spec, 0), '0::w0');
  assert.strictEqual(Ui.controlKey(10, spec, 5), '10::w5');
  assert.strictEqual(Ui.controlKey(99, spec, 0), '99::w0');
});

test('controlKey: name takes precedence over ordinal', () => {
  const spec1 = { name: 'a', type: 'text' };
  const spec2 = { type: 'text' };
  assert.strictEqual(Ui.controlKey(1, spec1, 0), '1::a');
  assert.strictEqual(Ui.controlKey(1, spec2, 0), '1::w0');
});
