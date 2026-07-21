# Phase 4a: sync_to Pin + Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 4a of `docs/superpowers/specs/2026-07-21-explicit-containers-design.md` (as corrected): the registration-time `sync_to` seed already exists (`_syncPush` at js/ui.js:1095 → `mdUiSyncTo` hook) and is browser-verified — this plan PINS it with a JS test (uncovered today) and documents the value channel + the self-shadow caveat in the user doc.

**Architecture:** No production code changes. One test in `tests/js/ui-dom.test.js` stubbing the `mdUiSyncTo` global and asserting the push fires at registration AND at change; one documentation edit in `docs/interactive-elements.html`.

**Tech Stack:** node --test; hand-stubbed DOM harness (`freshEnv()`) already in the test file.

## Global Constraints

- ZERO production-code changes. If the test reveals the seed does NOT fire in the harness path, stop and report BLOCKED — do not "fix" js/ui.js in this plan.
- Follow the test file's existing conventions for globals: if other tests stub `global.mdUiSyncTo`-style hooks, mirror their setup/teardown idiom; otherwise stub before `freshEnv()`/register and delete the global at test end so no other test observes it.
- Docs edits in English, matching `docs/interactive-elements.html`'s existing tone and markup (no new CSS).

---

### Task 1: Pin the registration-time and change-time sync push

**Files:**
- Test: `tests/js/ui-dom.test.js`

- [ ] **Step 1: Write the test (append; model harness lines on the register-tests at :253–:311 and the change-test at :347)**

```js
// ---- fase 4a (spec 2026-07-21): sync_to-push pinnes — VED REGISTRERING og ved endring ----

test('fase 4a pin: sync_to pusher via mdUiSyncTo VED REGISTRERING (seed) og ved endring, FØR rerun', async () => {
  const pushes = [];
  global.mdUiSyncTo = (name, value) => { pushes.push([name, value]); };
  try {
    const { Ui } = freshEnv();
    Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 0, max: 100, value: 40, sync_to: 'n' }));
    // Seed: registreringen alene har pushet gjeldende verdi til sesjonsvariabelen.
    assert.deepStrictEqual(pushes, [['n', 40]]);
    // Endring: input-event → umiddelbar push (før den debouncede reruen).
    const input = /* nå kontrollens range-input via samme vei som testen på :347 */;
    input.value = 70;
    input.dispatchEvent({ type: 'input' });
    assert.deepStrictEqual(pushes[pushes.length - 1], ['n', 70]);
  } finally {
    delete global.mdUiSyncTo;
  }
});
```

(The `input`-reaching line and event-dispatch idiom MUST be copied from the existing change-test at :347 — the stub DOM's event objects are plain `{type: 'input'}` style. The assertions are the contract; adapt only harness plumbing. If a second registration of the same key also pushes, that is today's behavior — extend the first assertion accordingly and note it, don't weaken it.)

- [ ] **Step 2: Run — must pass against CURRENT code (this is a pin, not TDD)**

Run: `node --test tests/js/ui-dom.test.js`
Expected: all pass including the new pin. If the seed assertion FAILS, report BLOCKED with the observed push list (production behavior differs from the browser-verified claim — controller must reconcile).

- [ ] **Step 3: Full JS suite + commit**

Run: `node --test tests/js/*.test.js`
Expected: all pass

```bash
git add tests/js/ui-dom.test.js
git commit -m "test(fase4a): pin — sync_to pusher via mdUiSyncTo ved registrering (seed) og ved endring før rerun"
```

---

### Task 2: Document the sync_to value channel + self-shadow caveat

**Files:**
- Modify: `docs/interactive-elements.html`

- [ ] **Step 1: Extend the widgets section**

In the `<ul>` after the "Reading and steering controls" block, the existing `sync_to` bullet reads:

```html
<li><strong><code>sync_to="varname"</code></strong> pushes the value into a
    live session variable as the user drags, without a rerun.</li>
```

Replace it with:

```html
<li><strong><code>sync_to="varname"</code></strong> pushes the value into a
    live session variable — seeded already at registration, then updated as
    the user drags, without a rerun. This makes it a full value channel of
    its own: <code>ui.slider(0, 100, sync_to="n")</code> on its own line,
    then use <code>n</code> anywhere below. One caveat: don't assign the
    control to the SAME name you sync to (<code>n = ui.slider(sync_to="n")</code>)
    — a rerun re-executes the assignment and the variable's type ends up
    depending on interaction history. Use the bare-call form, or two
    distinct names.</li>
```

- [ ] **Step 2: Verify rendering + commit**

Serve the repo root and load `docs/interactive-elements.html` — the bullet renders, no markup breakage (a quick DOM query for the new text suffices).

```bash
git add docs/interactive-elements.html
git commit -m "docs(fase4a): sync_to som fullverdig verdikanal (seedet ved registrering) + selv-skygge-advarselen"
```
