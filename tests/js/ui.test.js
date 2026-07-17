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

// N2-fiksen (final-review): normalizeSpec (første-kjørings-stien) og
// _updateControlSpec (oppdaterings-stien, DOM-halvdelen — se
// tests/js/ui-dom.test.js) var uenige om en eksplisitt dropdown-verdi som
// ikke finnes i options: oppdaterings-stien har alltid snappet til
// options[0], mens denne testen tidligere kodifiserte at FØRSTE kjøring
// beholdt den vilkårlige verdien uendret. Align'et nå på snap+advarsel.
test('normalizeSpec: dropdown with explicit value not in options snaps to first + warns', () => {
  const res = Ui.normalizeSpec({ type: 'dropdown', options: ['a', 'b'], value: 'c' });
  assert.strictEqual(res.spec.value, 'a', 'snappet til options[0], ikke den vilkårlige "c"');
  assert.ok(res.warnings.some(w => /value ikke i options/.test(w)), 'advarsel om snap');
});

// W1-carryover (c, final-review-ledger): advarselsteksten skal navngi
// verdien vi FAKTISK snappet TIL (options[0], her "a") — ikke den avviste
// verdien ("c"). Før fiksen sto den avviste verdien i meldingen, som er
// misvisende å lese ("snappet til første: c" mens "c" aldri ble brukt).
test('normalizeSpec: dropdown snap-advarsel navngir den SNAPPEDE verdien, ikke den avviste', () => {
  const res = Ui.normalizeSpec({ type: 'dropdown', options: ['a', 'b'], value: 'c' });
  assert.ok(res.warnings.some(w => /snappet til første: a/.test(w)),
    'advarselen skal si "snappet til første: a" (den snappede verdien), ikke nevne "c"');
  assert.ok(!res.warnings.some(w => /snappet til første: c/.test(w)),
    'advarselen skal IKKE navngi den avviste verdien "c"');
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

// ===== normalizeSpec: play (dash-absorpsjon 5a Task 3) — som slider
// (min/max/step/value NaN-vakter/klamping/min>max-bytte), pluss interval
// (gulvet til 200ms) og loop (boolsk). =====

test('normalizeSpec: play defaults min/max/step/interval/loop', () => {
  const res = Ui.normalizeSpec({ type: 'play' });
  assert.strictEqual(res.spec.type, 'play');
  assert.strictEqual(res.spec.min, 0);
  assert.strictEqual(res.spec.max, 100);
  assert.strictEqual(res.spec.step, 1);
  assert.strictEqual(res.spec.value, 0);
  assert.strictEqual(res.spec.interval, 600);
  assert.strictEqual(res.spec.loop, false);
});

test('normalizeSpec: play — interval under 200 gulves til 200', () => {
  const res = Ui.normalizeSpec({ type: 'play', interval: 50 });
  assert.strictEqual(res.spec.interval, 200);
});

test('normalizeSpec: play — interval over gulvet beholdes uendret', () => {
  const res = Ui.normalizeSpec({ type: 'play', interval: 1000 });
  assert.strictEqual(res.spec.interval, 1000);
});

test('normalizeSpec: play — ugyldig interval → 600 + advarsel', () => {
  const res = Ui.normalizeSpec({ type: 'play', interval: 'abc' });
  assert.strictEqual(res.spec.interval, 600);
  assert.ok(res.warnings.some((w) => /ugyldig interval/.test(w)));
});

test('normalizeSpec: play — loop koerseres til ekte boolsk', () => {
  assert.strictEqual(Ui.normalizeSpec({ type: 'play' }).spec.loop, false);
  assert.strictEqual(Ui.normalizeSpec({ type: 'play', loop: true }).spec.loop, true);
  assert.strictEqual(Ui.normalizeSpec({ type: 'play', loop: 1 }).spec.loop, true);
  assert.strictEqual(Ui.normalizeSpec({ type: 'play', loop: 0 }).spec.loop, false);
});

test('normalizeSpec: play — value klampes til [min,max]', () => {
  const overMax = Ui.normalizeSpec({ type: 'play', min: 0, max: 10, value: 99 });
  assert.strictEqual(overMax.spec.value, 10);
  const underMin = Ui.normalizeSpec({ type: 'play', min: 5, max: 10, value: 0 });
  assert.strictEqual(underMin.spec.value, 5);
});

test('normalizeSpec: play — min > max byttes om + advarsel', () => {
  const res = Ui.normalizeSpec({ type: 'play', min: 100, max: 0 });
  assert.strictEqual(res.spec.min, 0);
  assert.strictEqual(res.spec.max, 100);
  assert.ok(res.warnings.some((w) => /min > max/.test(w)));
});

test('normalizeSpec: play — NaN min/max/step/value → defaults + advarsler', () => {
  const res = Ui.normalizeSpec({ type: 'play', min: 'x', max: 'y', step: 'z', value: 'w' });
  assert.strictEqual(res.spec.min, 0);
  assert.strictEqual(res.spec.max, 100);
  assert.strictEqual(res.spec.step, 1);
  assert.strictEqual(res.spec.value, 0);
  assert.ok(res.warnings.some((w) => /ugyldig min for play/.test(w)));
  assert.ok(res.warnings.some((w) => /ugyldig max for play/.test(w)));
  assert.ok(res.warnings.some((w) => /ugyldig step for play/.test(w)));
  assert.ok(res.warnings.some((w) => /ugyldig value for play/.test(w)));
});

test('normalizeSpec: play — interval/loop er gyldige nøkler (ingen "ukjent nøkkel"-advarsel)', () => {
  const res = Ui.normalizeSpec({ type: 'play', interval: 300, loop: true });
  assert.ok(!res.warnings.some((w) => /ukjent nøkkel/.test(w)));
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

// ===== placement (Task 3, per-kontroll plassering) =====

test('normalizeSpec: placement absent → spec.placement undefined (kontrollen faller tilbake til cellens default)', () => {
  const res = Ui.normalizeSpec({ type: 'text' });
  assert.strictEqual(res.spec.placement, undefined);
  assert.deepStrictEqual(res.warnings, []);
});

test('normalizeSpec: placement "top"/"bottom"/"left" passthrough uendret', () => {
  ['top', 'bottom', 'left'].forEach((pos) => {
    const res = Ui.normalizeSpec({ type: 'text', placement: pos });
    assert.strictEqual(res.spec.placement, pos);
    assert.deepStrictEqual(res.warnings, []);
  });
});

test('normalizeSpec: ugyldig placement → advarsel + IGNORERES (spec.placement forblir udefinert, spec ikke nullet)', () => {
  const res = Ui.normalizeSpec({ type: 'text', placement: 'middle' });
  assert.ok(res.spec, 'spec skal ikke nulles av en ugyldig placement');
  assert.strictEqual(res.spec.placement, undefined);
  assert.ok(res.warnings.some((w) => /ugyldig placement/.test(w)));
});

test('normalizeSpec: placement er en KJENT nøkkel — varsler ikke som "ukjent nøkkel"', () => {
  const res = Ui.normalizeSpec({ type: 'slider', placement: 'left' });
  assert.ok(!res.warnings.some((w) => /ukjent nøkkel/.test(w)));
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
// W2-carryover (d): controlKey sitt første argument het tidligere "cellIdx"
// og var alltid en råindeks (tall). Det er nå en STABIL "cellKey" — enten
// Cells.cellKeyAt sin attrs.id-streng, eller (id-løs celle / fallback) samme
// råindeks konvertert til streng. Funksjonen selv er fortsatt en ren
// streng-sammenslåing og bryr seg ikke om hvilken av de to den får inn —
// testene under er derfor omdøpt (cellIdx → cellKey) og har fått ett par som
// dekker streng-varianten eksplisitt, men selve påstandene om format er
// uendret.

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

test('controlKey: different cellKey and ordinal', () => {
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

test('controlKey: cellKey som en id-streng (Cells.cellKeyAt sin attrs.id-gren) fungerer identisk med en tallnøkkel', () => {
  const spec = { name: 'x', type: 'slider' };
  assert.strictEqual(Ui.controlKey('mycell', spec, 0), 'mycell::x');
  assert.strictEqual(Ui.controlKey('mycell', { type: 'slider' }, 3), 'mycell::w3');
});

// ===== fase 3: sync_to, rerun="all" =====

test('normalizeSpec: sync_to — gyldig navn lagres, ugyldig varsles og droppes, button avvises', () => {
  const ok = Ui.normalizeSpec({ type: 'slider', sync_to: 'n' });
  assert.strictEqual(ok.spec.sync_to, 'n');
  assert.deepStrictEqual(ok.warnings, []);
  const dotted = Ui.normalizeSpec({ type: 'number', sync_to: 'my.var_2' });
  assert.strictEqual(dotted.spec.sync_to, 'my.var_2');
  const bad = Ui.normalizeSpec({ type: 'slider', sync_to: 'x; rm()' });
  assert.strictEqual(bad.spec.sync_to, undefined);
  assert.ok(bad.warnings.some((w) => /ugyldig sync_to-navn/.test(w)));
  const btn = Ui.normalizeSpec({ type: 'button', sync_to: 'n' });
  assert.strictEqual(btn.spec.sync_to, undefined);
  assert.ok(btn.warnings.some((w) => /sync_to støttes ikke på button/.test(w)));
});

test('normalizeSpec: rerun="all" aksepteres uendret', () => {
  const r = Ui.normalizeSpec({ type: 'slider', rerun: 'all' });
  assert.strictEqual(r.spec.rerun, 'all');
  assert.deepStrictEqual(r.warnings, []);
});

// ===== has_handler (ui-html-fasen, Task 1: widget-callable-kanalen) =====
// Fasaden (Task 2) setter has_handler=true på specen når on_change=/
// on_click= er et python-callable — DOM-halvdelens Ui.registerControl leser
// flagget for å pakke returverdien inn i {value,key} (se ui-dom.test.js).
// Denne rene halvdelen tester KUN at normalizeSpec kopierer/validerer
// nøkkelen korrekt — ingen DOM involvert.

test('normalizeSpec: has_handler:true kopieres inn i spec, ingen "ukjent nøkkel"-advarsel', () => {
  const r = Ui.normalizeSpec({ type: 'slider', name: 'x', has_handler: true });
  assert.strictEqual(r.spec.has_handler, true);
  assert.deepStrictEqual(r.warnings, []);
});

test('normalizeSpec: has_handler fraværende → spec.has_handler forblir udefinert', () => {
  const r = Ui.normalizeSpec({ type: 'slider', name: 'x' });
  assert.strictEqual(r.spec.has_handler, undefined);
});

test('normalizeSpec: has_handler:false kopieres inn som ekte boolsk false', () => {
  const r = Ui.normalizeSpec({ type: 'text', name: 'x', has_handler: false });
  assert.strictEqual(r.spec.has_handler, false);
});

test('normalizeSpec: has_handler normaliseres til ekte boolsk (sannferdig verdi → true)', () => {
  const r = Ui.normalizeSpec({ type: 'number', name: 'x', has_handler: 1 });
  assert.strictEqual(r.spec.has_handler, true);
});

test('normalizeSpec: has_handler gjelder også button (ingen sync_to-aktig avvisning)', () => {
  const r = Ui.normalizeSpec({ type: 'button', has_handler: true });
  assert.strictEqual(r.spec.has_handler, true);
  assert.deepStrictEqual(r.warnings, []);
});

// ===== Ui.formatNumber / Ui.computeDelta (dash-absorpsjon 5a Task 1:
// FLYTTET hit fra js/dash.js sin D.formatNumber/D.computeDelta — samme
// assertioner, repointet til Ui.*, ikke duplisert; dash.js delegerer nå til
// disse via D.renderPayload sin 'kpi'-mapping, se tests/js/dash.test.js). ====

test('formatNumber: default — heltall grupperes med U+202F', () => {
  assert.strictEqual(Ui.formatNumber(1234567), '1 234 567');
});

test('formatNumber: default — 2 desimaler uten etternuller, komma', () => {
  assert.strictEqual(Ui.formatNumber(3.14159), '3,14');
  assert.strictEqual(Ui.formatNumber(2.5), '2,5');
  assert.strictEqual(Ui.formatNumber(2.0), '2');
});

test('formatNumber: negativ bruker ekte minustegn', () => {
  assert.strictEqual(Ui.formatNumber(-1234.5), '−1 234,5');
});

test('formatNumber: fmt ",.1f" — gruppert, 1 desimal', () => {
  assert.strictEqual(Ui.formatNumber(12345.678, ',.1f'), '12 345,7');
});

test('formatNumber: fmt ".0f" — ingen gruppering', () => {
  assert.strictEqual(Ui.formatNumber(12345.678, '.0f'), '12346');
});

test('formatNumber: fmt ".1%" — prosent', () => {
  assert.strictEqual(Ui.formatNumber(0.1234, '.1%'), '12,3%');
});

test('formatNumber: ukjent fmt faller tilbake til default (kaster aldri)', () => {
  assert.strictEqual(Ui.formatNumber(1234.5, 'kroner'), '1 234,5');
});

test('formatNumber: ikke-tall passeres som streng', () => {
  assert.strictEqual(Ui.formatNumber(NaN), 'NaN');
  assert.strictEqual(Ui.formatNumber(Infinity), 'Infinity');
});

test('computeDelta: retning, fortegn og god/dårlig', () => {
  const d = Ui.computeDelta(120, 100, null, 'opp');
  assert.deepStrictEqual(d, { text: '+20', dir: 'opp', good: true });
  const n = Ui.computeDelta(80, 100, null, 'opp');
  assert.deepStrictEqual(n, { text: '−20', dir: 'ned', good: false });
  const f = Ui.computeDelta(100, 100, null, 'ned');
  assert.deepStrictEqual(f, { text: '+0', dir: 'flat', good: true });
});

test('computeDelta: null/ikke-endelig ref gir null', () => {
  assert.strictEqual(Ui.computeDelta(5, null, null, 'opp'), null);
  assert.strictEqual(Ui.computeDelta(5, undefined, null, 'opp'), null);
  assert.strictEqual(Ui.computeDelta(5, Infinity, null, 'opp'), null);
});

test('computeDelta: bruker fmt på differansen', () => {
  const d = Ui.computeDelta(0.35, 0.30, '.1%', 'opp');
  assert.strictEqual(d.text, '+5,0%');
});
