'use strict';

// Tester KUN den rene halvdelen av js/ipywidgets-bridge.js (comm-shim-
// registeret) — ingen DOM, ingen require()-avhengighet. Filens node-testede
// del laster helt uten `document`, så `require('../../js/ipywidgets-
// bridge.js')` her gir en IpwBridge med kun _registry/_createRegistry
// (ensure/fromKernel/renderView/reset finnes ikke i dette miljøet — det er
// forventet og korrekt, se filens egen kommentar om DOM-halvdelen).

const test = require('node:test');
const assert = require('node:assert');
const IpwBridge = require('../../js/ipywidgets-bridge.js');

function withCapturedWarnings(fn) {
  const calls = [];
  const orig = console.warn;
  console.warn = (...args) => {
    calls.push(args.join(' '));
  };
  try {
    fn(calls);
  } finally {
    console.warn = orig;
  }
}

test('IpwBridge exposes a pure registry factory with no DOM globals touched', () => {
  assert.strictEqual(typeof IpwBridge._createRegistry, 'function');
  assert.ok(IpwBridge._registry);
  assert.strictEqual(typeof document, 'undefined');
});

test('registry: open then route delivers the message to the right shim only', () => {
  const reg = IpwBridge._createRegistry();
  const seenA = [];
  const seenB = [];
  reg.open('a', 'jupyter.widget');
  reg.open('b', 'jupyter.widget');
  reg.onMsg('a', (msg) => seenA.push(msg));
  reg.onMsg('b', (msg) => seenB.push(msg));

  const ok = reg.route('a', { content: { comm_id: 'a', data: { method: 'update', state: { value: 7 } } } });

  assert.strictEqual(ok, true);
  assert.strictEqual(seenA.length, 1);
  assert.strictEqual(seenB.length, 0);
  assert.strictEqual(seenA[0].content.data.state.value, 7);
});

test('registry: route for unknown comm_id warns and does not throw', () => {
  const reg = IpwBridge._createRegistry();
  withCapturedWarnings((calls) => {
    let threw = false;
    let result;
    try {
      result = reg.route('does-not-exist', { content: { data: {} } });
    } catch (e) {
      threw = true;
    }
    assert.strictEqual(threw, false);
    assert.strictEqual(result, false);
    assert.ok(calls.some((c) => c.includes('does-not-exist')));
  });
});

test('registry: close cleans up bookkeeping (has() false, further route warns)', () => {
  const reg = IpwBridge._createRegistry();
  reg.open('c', 'jupyter.widget');
  reg.onMsg('c', () => {});
  const closeMsgs = [];
  reg.onClose('c', (m) => closeMsgs.push(m));

  const ok = reg.close('c', { content: { data: {} } });

  assert.strictEqual(ok, true);
  assert.strictEqual(closeMsgs.length, 1);
  assert.strictEqual(reg.has('c'), false);

  withCapturedWarnings((calls) => {
    const routed = reg.route('c', { content: { data: {} } });
    assert.strictEqual(routed, false);
    assert.ok(calls.some((c) => c.includes('c')));
  });
});

test('registry: double-open of the same comm_id warns and replaces (old listeners gone)', () => {
  const reg = IpwBridge._createRegistry();
  const firstGen = [];
  const secondGen = [];
  reg.open('d', 'jupyter.widget');
  reg.onMsg('d', (m) => firstGen.push(m));

  withCapturedWarnings((calls) => {
    reg.open('d', 'jupyter.widget'); // replace
    assert.ok(calls.some((c) => c.includes('d')));
  });

  reg.onMsg('d', (m) => secondGen.push(m));
  reg.route('d', { content: { data: { method: 'update' } } });

  // Old (first-generation) listener must NOT fire after a replacing open —
  // only listeners registered after the second open should see the message.
  assert.strictEqual(firstGen.length, 0);
  assert.strictEqual(secondGen.length, 1);
});

test('registry: on_msg callback-list semantics — multiple listeners on the same comm_id all fire, in registration order', () => {
  const reg = IpwBridge._createRegistry();
  const order = [];
  reg.open('e', 'jupyter.widget');
  reg.onMsg('e', () => order.push('first'));
  reg.onMsg('e', () => order.push('second'));
  reg.onMsg('e', () => order.push('third'));

  reg.route('e', { content: { data: {} } });

  assert.deepStrictEqual(order, ['first', 'second', 'third']);
});

test('registry: onMsg/onClose registration against an unknown comm_id warns, does not throw, and is a no-op', () => {
  const reg = IpwBridge._createRegistry();
  withCapturedWarnings((calls) => {
    let threw = false;
    try {
      reg.onMsg('ghost', () => {});
      reg.onClose('ghost', () => {});
    } catch (e) {
      threw = true;
    }
    assert.strictEqual(threw, false);
    assert.ok(calls.length >= 2);
  });
  assert.strictEqual(reg.has('ghost'), false);
});

test('registry: reset() clears all open shims', () => {
  const reg = IpwBridge._createRegistry();
  reg.open('f', 'jupyter.widget');
  reg.open('g', 'jupyter.widget');
  assert.deepStrictEqual(reg.ids().sort(), ['f', 'g']);

  reg.reset();

  assert.deepStrictEqual(reg.ids(), []);
  assert.strictEqual(reg.has('f'), false);
});

test('registry: targetOf returns the target_name recorded at open, undefined once closed', () => {
  const reg = IpwBridge._createRegistry();
  reg.open('h', 'jupyter.widget');
  assert.strictEqual(reg.targetOf('h'), 'jupyter.widget');
  reg.close('h', { content: { data: {} } });
  assert.strictEqual(reg.targetOf('h'), undefined);
});

test('_closeAllComms: fires on_close for every open comm with a kernel-shaped comm_close msg, and empties the registry', () => {
  const reg = IpwBridge._createRegistry();
  const closed = [];
  reg.open('m1', 'jupyter.widget');
  reg.open('m2', 'jupyter.widget');
  reg.onClose('m1', (msg) => closed.push(msg));
  reg.onClose('m2', (msg) => closed.push(msg));

  IpwBridge._closeAllComms(reg);

  assert.strictEqual(closed.length, 2);
  const ids = closed.map((m) => m.content.comm_id).sort();
  assert.deepStrictEqual(ids, ['m1', 'm2']);
  closed.forEach((m) => assert.deepStrictEqual(m.content.data, {}));
  assert.deepStrictEqual(reg.ids(), []);
  assert.strictEqual(reg.has('m1'), false);
});

test('_closeAllComms: no-op on an empty registry (no throw, no warnings)', () => {
  const reg = IpwBridge._createRegistry();
  withCapturedWarnings((calls) => {
    IpwBridge._closeAllComms(reg);
    assert.deepStrictEqual(calls, []);
  });
  assert.deepStrictEqual(reg.ids(), []);
});

test('_closeAllComms: a comm with no on_close listeners still gets cleaned out (registry emptied)', () => {
  const reg = IpwBridge._createRegistry();
  reg.open('silent', 'jupyter.widget');
  IpwBridge._closeAllComms(reg);
  assert.strictEqual(reg.has('silent'), false);
  assert.deepStrictEqual(reg.ids(), []);
});

test('IpwBridge._registry is a live singleton independent from freshly created registries', () => {
  const fresh = IpwBridge._createRegistry();
  IpwBridge._registry.open('shared-singleton-probe', 'jupyter.widget');
  assert.strictEqual(fresh.has('shared-singleton-probe'), false);
  // cleanup so this test is order-independent w.r.t. the module-level singleton
  IpwBridge._registry.close('shared-singleton-probe', { content: { data: {} } });
});
