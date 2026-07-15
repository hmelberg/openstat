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

test('registry: route for unknown comm_id buffers (no warn, no throw) instead of dropping — Task 4 Part 0', () => {
  // Behaviour change from the pre-Task-4 registry (which warned+dropped): a
  // comm_msg for an unknown comm_id can legitimately be a race (comm_open
  // handling still pending) rather than an error, so it is buffered for
  // later replay — see the buffer/replay tests below.
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
    assert.strictEqual(result, true);
    assert.deepStrictEqual(calls, []);
  });
});

test('registry: comm_msg for a not-yet-opened comm_id is buffered, then replayed in order once on_msg registers', () => {
  const reg = IpwBridge._createRegistry();
  const seen = [];

  const ok1 = reg.route('z', { content: { data: { n: 1 } } });
  const ok2 = reg.route('z', { content: { data: { n: 2 } } });
  assert.strictEqual(ok1, true);
  assert.strictEqual(ok2, true);
  assert.strictEqual(seen.length, 0); // nothing to deliver to yet — no shim at all

  // comm_open handling catches up: open() then on_msg registration (the real
  // order in js/ipywidgets-bridge.js's _makeShim/handle_comm_open flow).
  reg.open('z', 'jupyter.widget');
  reg.onMsg('z', (msg) => seen.push(msg.content.data.n));

  assert.deepStrictEqual(seen, [1, 2]); // order preserved, delivered on registration
});

test('registry: comm_msg for an open comm with no on_msg listener yet is buffered, replayed once a listener registers', () => {
  const reg = IpwBridge._createRegistry();
  reg.open('y', 'jupyter.widget');
  const seen = [];

  reg.route('y', { content: { data: { n: 'a' } } });
  reg.route('y', { content: { data: { n: 'b' } } });
  assert.strictEqual(seen.length, 0);

  reg.onMsg('y', (msg) => seen.push(msg.content.data.n));

  assert.deepStrictEqual(seen, ['a', 'b']);
});

test('registry: buffered comm_msg queue caps at 100 — overflow warns and drops without throwing', () => {
  const reg = IpwBridge._createRegistry();
  let lastOk;
  withCapturedWarnings((calls) => {
    for (let i = 0; i < 101; i++) {
      lastOk = reg.route('overflow-id', { content: { data: { n: i } } });
    }
    assert.strictEqual(lastOk, false); // the 101st is dropped
    assert.ok(calls.some((c) => c.includes('overflow-id')));
  });

  const seen = [];
  reg.open('overflow-id', 'jupyter.widget');
  reg.onMsg('overflow-id', (msg) => seen.push(msg.content.data.n));
  assert.strictEqual(seen.length, 100); // only the first 100 survived the cap
  assert.strictEqual(seen[0], 0);
  assert.strictEqual(seen[99], 99);
});

test('registry: comm_close on a buffered-only (never-opened) comm_id still warns (unknown) but clears its pending queue', () => {
  const reg = IpwBridge._createRegistry();
  reg.route('ghost-buffer', { content: { data: {} } });

  withCapturedWarnings((calls) => {
    const ok = reg.close('ghost-buffer', { content: { data: {} } });
    assert.strictEqual(ok, false);
    assert.ok(calls.some((c) => c.includes('ghost-buffer')));
  });

  // Re-opening the same id afterwards must NOT replay the old (cleared) buffer.
  const seen = [];
  reg.open('ghost-buffer', 'jupyter.widget');
  reg.onMsg('ghost-buffer', (msg) => seen.push(msg));
  assert.deepStrictEqual(seen, []);
});

test('registry: normal flow (on_msg registered before comm_msg arrives) is unaffected by buffering', () => {
  const reg = IpwBridge._createRegistry();
  const seen = [];
  reg.open('normal', 'jupyter.widget');
  reg.onMsg('normal', (msg) => seen.push(msg.content.data.n));

  const ok = reg.route('normal', { content: { data: { n: 42 } } });

  assert.strictEqual(ok, true);
  assert.deepStrictEqual(seen, [42]); // delivered immediately, no buffering involved
});

test('registry: reset() also clears any buffered (not-yet-opened) comm_msg queues', () => {
  const reg = IpwBridge._createRegistry();
  reg.route('will-reset', { content: { data: { n: 1 } } });

  reg.reset();

  const seen = [];
  reg.open('will-reset', 'jupyter.widget');
  reg.onMsg('will-reset', (msg) => seen.push(msg));
  assert.deepStrictEqual(seen, []); // buffer was cleared by reset(), nothing to replay
});

test('registry: close cleans up bookkeeping (has() false, further route buffers instead of warning — Task 4 Part 0)', () => {
  const reg = IpwBridge._createRegistry();
  reg.open('c', 'jupyter.widget');
  reg.onMsg('c', () => {});
  const closeMsgs = [];
  reg.onClose('c', (m) => closeMsgs.push(m));

  const ok = reg.close('c', { content: { data: {} } });

  assert.strictEqual(ok, true);
  assert.strictEqual(closeMsgs.length, 1);
  assert.strictEqual(reg.has('c'), false);

  // Post-close, 'c' is an unknown comm_id from route()'s point of view — per
  // Task 4 Part 0 this now buffers (no warn) rather than warn+drop, exactly
  // like any other unknown-id comm_msg race.
  withCapturedWarnings((calls) => {
    const routed = reg.route('c', { content: { data: {} } });
    assert.strictEqual(routed, true);
    assert.deepStrictEqual(calls, []);
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
