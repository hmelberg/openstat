# Shared Node Core (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 2 of `docs/superpowers/specs/2026-07-20-unified-interactive-elements-design.md` (as amended 2026-07-20): extract one shared DOM-construction core `Ui.makeNode(tag, opts)` from the element engine, and re-platform BOTH builder sets — `js/ui.js`'s widget builders and `js/param-forms.js`'s form builders — onto it, without touching either system's wiring.

**Architecture:** `Ui.elCreate` (js/ui.js:1933) already contains the one true props-application path (`_applyElProps`: props → property-or-attribute, attrs → `setAttribute` with boolean/JSON normalization, style → cssText-or-per-key). Phase 2 splits it: `Ui.makeNode(tag, opts)` = createElement + `_applyElProps`, real object in, raw node out, NO `_els` registration; `elCreate` becomes JSON-parse + makeNode + registry. The builders then swap their private `document.createElement` + assignment idioms for makeNode recipes. Their return contracts (`{wrap, input, labelEl, readout}` in ui.js; `{input, readout?, extra?}` in param-forms), event wiring (`_wireChange` / `_commit`), play-timer semantics, and `_registerInto` are byte-for-byte untouched — this is a construction-layer swap only.

**Tech Stack:** Vanilla ES5 JS, Norwegian comments; `node --test` for JS suites; no build step.

## Global Constraints

- ES5 var-style JS, Norwegian comments. No user-facing strings added.
- Builder return contracts unchanged: ui.js builders return `{wrap, input, labelEl?, readout?}` (button: `{wrap, input}` where both are the button node); param-forms builders return `{input, readout?, extra?}`.
- Wiring untouched: `_wireChange`/`_syncPush`/`_rerunFor`/`_fireControlHandler`/play-timer code in ui.js; `_commit`/`_scheduleRun` in param-forms.js. `_registerInto`, `_writeControlValue`, `_updateControlSpec` untouched.
- `Ui.makeNode` takes a REAL object (never JSON), registers nothing in `_els`, and never touches run-context (`_resolveCellIdx`).
- DOM-visible output must be identical: same tags, same class strings, same child order, same attributes. In the real DOM, `input.value/min/max/step/checked/id` are element properties, so makeNode's property path reproduces today's direct assignments exactly; `role="switch"` must go through `attrs` (forced `setAttribute`), matching today's explicit `setAttribute('role', 'switch')`.
- Load order: index.html loads `js/ui.js` (:583) before `js/param-forms.js` (:584) — param-forms may hard-depend on `window.Ui.makeNode`. Its DOM half is already gated on `typeof document !== 'undefined'`.
- Existing suites are the parity contract: `node --test tests/js/*.test.js` (726 tests) must pass unchanged except where a task explicitly adds tests. `python -m pytest tests/ brython/tests/ micropython/tests/ -q` (1600) must stay green (nothing here touches Python, so any failure is a red flag).
- index.html is NOT edited in this plan (no template-literal hazards). If any task finds it needs an index.html change, that's a plan error — stop and escalate.
- Commit after every task, Norwegian commit messages.

## File map

- `js/ui.js` — new `Ui.makeNode` (next to `elCreate`, ~:1927); builders `_buildSlider`…`_buildButton` (:561–:750); `_el` helper (:406)
- `js/param-forms.js` — builders `_buildText`/`_buildRaw`/`_buildDropdown`/`_buildCheckbox`/`_buildNumber`/`_buildDate`/`_buildSlider` (:505–:603); `_el` helper (:483); `_makeRunChip` (:693)
- `tests/js/ui-dom.test.js` — makeNode tests + builder shape pins
- `tests/js/param-forms-dom.test.js` — shape pins; gains a `require('../../js/ui.js')` before param-forms

---

### Task 1: Extract `Ui.makeNode` (element engine unchanged in behavior)

**Files:**
- Modify: `js/ui.js` (~:1927, immediately above `Ui.elCreate`)
- Test: `tests/js/ui-dom.test.js`

**Interfaces:**
- Produces: `Ui.makeNode(tag, opts) -> Node|null` where `opts` is `{props?: {...}, attrs?: {...}, style?: string|{...}}` (same shape `_applyElProps` already consumes). Tasks 2–4 call it; Task 4 calls it from another file via `window.Ui`.

- [ ] **Step 1: Write the failing tests (append to `tests/js/ui-dom.test.js`, using the same `freshEnv()` harness the elCreate tests at :1700–:1725 use)**

```js
// ---- fase 2 (spec 2026-07-20): Ui.makeNode — delt konstruksjonskjerne ----

test('fase 2: makeNode — rå node med props/attrs/style, INGEN _els-registrering', () => {
  const { Ui } = freshEnv();
  const before = Ui.elCreate('div'); // registrerer én — måler tellerens ståsted
  const node = Ui.makeNode('input', {
    props: { type: 'range', min: 0, max: 10, value: 5 },
    attrs: { role: 'switch' },
    style: { color: 'red' }
  });
  assert.ok(node, 'makeNode returnerer en node');
  assert.strictEqual(node.type, 'range');
  assert.strictEqual(node.min, 0);
  assert.strictEqual(node.max, 10);
  assert.strictEqual(node.value, 5);
  assert.strictEqual(node.getAttribute('role'), 'switch');
  const after = Ui.elCreate('div');
  // elId-telleren har KUN rykket ett hakk (de to elCreate-kallene) — makeNode
  // registrerte ingenting i _els.
  assert.strictEqual(Number(after.slice(2)) - Number(before.slice(2)), 1);
});

test('fase 2: makeNode — opts utelatt gir naken node; ugyldig tag gir null', () => {
  const { Ui } = freshEnv();
  const bare = Ui.makeNode('span');
  assert.ok(bare);
  assert.strictEqual(bare.tagName.toLowerCase(), 'span');
});
```

(If `freshEnv()` in this file returns a different shape than `{ Ui }`, adapt the destructuring line to match the neighbouring elCreate tests exactly — the assertions stay as written. If the FakeEl stub's `createElement` cannot be made to throw, drop the "ugyldig tag" clause rather than stubbing exotics.)

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/js/ui-dom.test.js`
Expected: the two new tests FAIL (`Ui.makeNode is not a function`); all existing pass

- [ ] **Step 3: Implement `Ui.makeNode` and refactor `elCreate` to delegate**

Insert directly above `Ui.elCreate` (js/ui.js ~:1927):

```js
    /**
     * Ui.makeNode(tag, opts) → rå DOM-node eller null — den DELTE
     * konstruksjonskjernen (fase 2, spec 2026-07-20): samme props/attrs/
     * style-applisering som elCreate (_applyElProps), men tar et EKTE
     * objekt (aldri JSON), registrerer INGENTING i _els (ingen livssyklus,
     * ingen kjørekontekst) og er ment for JS-interne kallere — kontroll-
     * byggerne her og i js/param-forms.js. elCreate er nå sugar over den.
     */
    Ui.makeNode = function (tag, opts) {
      var node;
      try {
        node = document.createElement(tag);
      } catch (e) {
        console.warn('Ui.makeNode: klarte ikke å opprette <' + tag + '>: ' + ((e && e.message) || e));
        return null;
      }
      if (opts) _applyElProps(node, opts);
      return node;
    };
```

Then in `Ui.elCreate`, replace the body between the JSON-parse block and the `var cellIdx = _resolveCellIdx();` line — i.e. replace:

```js
      var node;
      try {
        node = document.createElement(tag);
      } catch (e) {
        console.warn('Ui.elCreate: klarte ikke å opprette <' + tag + '>: ' + ((e && e.message) || e));
        return null;
      }
      if (opts) _applyElProps(node, opts);
      var id = 'el' + (_elCounter++);
```

with:

```js
      var node = Ui.makeNode(tag, opts);
      if (!node) return null;
      var id = 'el' + (_elCounter++);
```

(The only observable difference is the warn prefix on an un-creatable tag — `Ui.makeNode:` instead of `Ui.elCreate:`. No test pins that text; verified by grep before this plan was written.)

- [ ] **Step 4: Run the full JS suite**

Run: `node --test tests/js/*.test.js`
Expected: all pass (726 + 2 new)

- [ ] **Step 5: Commit**

```bash
git add js/ui.js tests/js/ui-dom.test.js
git commit -m "feat(ui): Ui.makeNode — delt konstruksjonskjerne trukket ut av elCreate (fase 2); elCreate er nå sugar"
```

---

### Task 2: Re-platform ui.js's simple builders (slider, dropdown, checkbox/switch, number, text)

Shape-pin tests FIRST (they must pass against the CURRENT builders — they are the parity contract), then the swap.

**Files:**
- Modify: `js/ui.js` (`_el` :406; `_buildSlider` :561, `_buildDropdown` :580, `_buildCheckbox` :596, `_buildNumber` :614, `_buildText` :629)
- Test: `tests/js/ui-dom.test.js`

**Interfaces:**
- Consumes: `Ui.makeNode` from Task 1 (same-file closure — call it as `Ui.makeNode`).
- Produces: unchanged builder contract; Task 3 repeats the same recipe pattern for play/button.

- [ ] **Step 1: Write shape-pin tests (append to `tests/js/ui-dom.test.js`); model the register-call lines on the existing test at :253 (`Ui.registerControl(JSON.stringify({ type: 'slider', … }))`), reading the built control via the same env the neighbouring tests use**

```js
// ---- fase 2: byggernes DOM-form pinnes FØR re-plattformingen --------------
// (disse skal passere UENDRET både før og etter makeNode-swapen — de ER
// paritetskontrakten for konstruksjonslaget.)

test('fase 2 pin: slider — wrap/label/input/readout-form', () => {
  const { Ui, strip } = freshEnv();
  Ui.registerControl(JSON.stringify({ type: 'slider', name: 'x', min: 0, max: 10, step: 2, value: 4 }));
  const wrap = strip.children[0];
  assert.strictEqual(wrap.tagName.toLowerCase(), 'label');
  assert.strictEqual(wrap.className, 'ui-widget');
  const [labelEl, input, readout] = wrap.children;
  assert.strictEqual(labelEl.className, 'ui-widget-label');
  assert.strictEqual(input.type, 'range');
  assert.strictEqual(input.min, 0);
  assert.strictEqual(input.max, 10);
  assert.strictEqual(input.step, 2);
  assert.strictEqual(String(input.value), '4');
  assert.strictEqual(readout.className, 'ui-widget-value');
  assert.strictEqual(readout.textContent, '4');
});

test('fase 2 pin: dropdown — select med options i rekkefølge', () => {
  const { Ui, strip } = freshEnv();
  Ui.registerControl(JSON.stringify({ type: 'dropdown', name: 'd', options: ['a', 'b'], value: 'b' }));
  const wrap = strip.children[0];
  const input = wrap.children[1];
  assert.strictEqual(input.tagName.toLowerCase(), 'select');
  assert.strictEqual(input.children.length, 2);
  assert.strictEqual(input.children[0].value, 'a');
  assert.strictEqual(input.children[1].textContent, 'b');
  assert.strictEqual(input.value, 'b');
});

test('fase 2 pin: checkbox/switch — input FØR label, switch-klasse + role', () => {
  const { Ui, strip } = freshEnv();
  Ui.registerControl(JSON.stringify({ type: 'switch', name: 's', value: true }));
  const wrap = strip.children[0];
  assert.strictEqual(wrap.className, 'ui-widget ui-widget--check ui-widget--switch');
  const input = wrap.children[0]; // insertBefore(input, firstChild)
  assert.strictEqual(input.type, 'checkbox');
  assert.strictEqual(input.getAttribute('role'), 'switch');
  assert.strictEqual(input.checked, true);
});

test('fase 2 pin: number — min/max/step kun når satt', () => {
  const { Ui, strip } = freshEnv();
  Ui.registerControl(JSON.stringify({ type: 'number', name: 'n', value: 7 }));
  const input = strip.children[0].children[1];
  assert.strictEqual(input.type, 'number');
  assert.ok(!('min' in input) || input.min === undefined || input.min === '',
    'min settes IKKE når spec utelater den');
  assert.strictEqual(String(input.value), '7');
});

test('fase 2 pin: text — type=text, strengverdi', () => {
  const { Ui, strip } = freshEnv();
  Ui.registerControl(JSON.stringify({ type: 'text', name: 't', value: 'hei' }));
  const input = strip.children[0].children[1];
  assert.strictEqual(input.type, 'text');
  assert.strictEqual(input.value, 'hei');
});
```

(Adapt the `{ Ui, strip }` destructuring to what `freshEnv()` actually exposes — the existing tests around :241–:311 show how the built strip is reached. The assertions are the contract; do not weaken them.)

- [ ] **Step 2: Run to verify they PASS against the current builders**

Run: `node --test tests/js/ui-dom.test.js`
Expected: all pass — including the 5 new pins (they describe today's DOM)

- [ ] **Step 3: Swap the construction layer**

(a) `_el` (:406) becomes sugar over the core (signature/behavior identical):

```js
    function _el(tag, cls, text) {
      var props = {};
      if (cls) props.className = cls;
      if (text != null) props.textContent = text;
      return Ui.makeNode(tag, { props: props });
    }
```

(b) `_buildSlider` (:561) — replace the input construction lines:

```js
      var input = document.createElement('input');
      input.type = 'range';
      input.min = spec.min; input.max = spec.max; input.step = spec.step;
      input.value = value;
```

with:

```js
      var input = Ui.makeNode('input', { props: { type: 'range', min: spec.min, max: spec.max, step: spec.step, value: value } });
```

(c) `_buildDropdown` (:580) — select + options:

```js
      var input = Ui.makeNode('select');
      spec.options.forEach(function (opt) {
        input.appendChild(Ui.makeNode('option', { props: { value: opt, textContent: opt } }));
      });
      input.value = value;
```

(d) `_buildCheckbox` (:596) — the `role` goes through `attrs` (forced setAttribute, exactly today's behavior):

```js
      var input = Ui.makeNode('input', isSwitch
        ? { props: { type: 'checkbox', checked: !!value }, attrs: { role: 'switch' } }
        : { props: { type: 'checkbox', checked: !!value } });
```

(delete the now-redundant `input.checked = !!value;` and `if (isSwitch) input.setAttribute(...)` lines).

(e) `_buildNumber` (:614) — conditional props assembled first (min/max/step must NOT be set when absent — today's `!= null` guards):

```js
      var nprops = { type: 'number', value: value };
      if (spec.min != null) nprops.min = spec.min;
      if (spec.max != null) nprops.max = spec.max;
      if (spec.step != null) nprops.step = spec.step;
      var input = Ui.makeNode('input', { props: nprops });
```

(f) `_buildText` (:629):

```js
      var input = Ui.makeNode('input', { props: { type: 'text', value: value } });
```

Event listeners, wrap/label/readout assembly, and return objects stay exactly as they are. Add one comment above `_BUILDERS` (:742): `// fase 2 (spec 2026-07-20): all konstruksjon går via Ui.makeNode — byggerne eier ingen egne DOM-idiomer lenger.`

- [ ] **Step 4: Run the full JS suite**

Run: `node --test tests/js/*.test.js`
Expected: all pass, unchanged counts (the 5 pins prove the DOM shape survived)

- [ ] **Step 5: Commit**

```bash
git add js/ui.js tests/js/ui-dom.test.js
git commit -m "refactor(ui): slider/dropdown/checkbox/switch/number/text bygger via Ui.makeNode — form-pins uendret (fase 2)"
```

---

### Task 3: Re-platform ui.js's play and button builders

The delicate pair: play owns timer semantics, button owns the immediate-rerun/handler branch. NOTHING in their behavior changes — only node construction.

**Files:**
- Modify: `js/ui.js` (`_buildPlay` :656, `_buildButton` :727)
- Test: `tests/js/ui-dom.test.js`

**Interfaces:**
- Consumes: `Ui.makeNode` (Task 1); pattern from Task 2.

- [ ] **Step 1: Write shape-pin tests (append; same harness conventions)**

```js
test('fase 2 pin: play — wrap-klasse, input/readout/knapp i rekkefølge, aria-label', () => {
  const { Ui, strip } = freshEnv();
  Ui.registerControl(JSON.stringify({ type: 'play', name: 'p', min: 0, max: 10, step: 1, value: 0, interval: 600 }));
  const wrap = strip.children[0];
  assert.strictEqual(wrap.className, 'ui-widget ui-widget--play');
  const [labelEl, input, readout, btn] = wrap.children;
  assert.strictEqual(input.type, 'range');
  assert.strictEqual(readout.className, 'ui-widget-value');
  assert.strictEqual(btn.className, 'ui-play-btn');
  assert.strictEqual(btn.textContent, '▶');
  assert.strictEqual(btn.type, 'button');
  assert.strictEqual(btn.getAttribute('aria-label'), 'Spill av');
});

test('fase 2 pin: button — wrap ER knappen, klasse + type', () => {
  const { Ui, strip } = freshEnv();
  Ui.registerControl(JSON.stringify({ type: 'button', name: 'b', label: 'Trykk' }));
  const btn = strip.children[0];
  assert.strictEqual(btn.className, 'ui-widget ui-widget--button');
  assert.strictEqual(btn.type, 'button');
  assert.strictEqual(btn.textContent, 'Trykk');
});
```

- [ ] **Step 2: Run — the pins must PASS against current code**

Run: `node --test tests/js/ui-dom.test.js`
Expected: pass

- [ ] **Step 3: Swap construction**

In `_buildPlay` (:656): the input gets the same one-liner as `_buildSlider`'s (Task 2b, identical props). The play button construction:

```js
      var btn = _el('button', 'ui-play-btn', '▶');
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Spill av');
```

becomes:

```js
      var btn = Ui.makeNode('button', { props: { className: 'ui-play-btn', textContent: '▶', type: 'button' }, attrs: { 'aria-label': 'Spill av' } });
```

Timer functions (`stopPlay`/`tick`/`startPlay`), the live-spec reads, listeners, and assembly order stay untouched — including the `btn.className = …` state flips inside `stopPlay`/`startPlay` (runtime state, not construction).

In `_buildButton` (:727):

```js
      var btn = _el('button', 'ui-widget ui-widget--button', label);
      btn.type = 'button';
```

becomes:

```js
      var btn = Ui.makeNode('button', { props: { className: 'ui-widget ui-widget--button', textContent: label, type: 'button' } });
```

Click listener and return `{ wrap: btn, input: btn }` untouched.

- [ ] **Step 4: Run the full JS suite (play-timer tests included)**

Run: `node --test tests/js/*.test.js`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add js/ui.js tests/js/ui-dom.test.js
git commit -m "refactor(ui): play/button bygger via Ui.makeNode — timer-/handler-semantikk urørt (fase 2)"
```

---

### Task 4: Re-platform param-forms' builders onto the shared core

param-forms' DOM half gains a hard dependency on `window.Ui.makeNode` (load order already correct: index.html:583–584). Its wiring (`_commit`, `_scheduleRun`, chip) is untouched.

**Files:**
- Modify: `js/param-forms.js` (`_el` :483; `_buildText` :505, `_buildRaw` :519, `_buildDropdown` :528, `_buildCheckbox` :558, `_buildNumber` :566, `_buildDate` :578, `_buildSlider` :586)
- Test: `tests/js/param-forms-dom.test.js`

**Interfaces:**
- Consumes: `Ui.makeNode` via `global.Ui` (cross-file).

- [ ] **Step 1: Make the test file load the real ui.js before param-forms**

At the top of `tests/js/param-forms-dom.test.js`, after the fake-DOM globals are installed but BEFORE `require('../../js/param-forms.js')`, add (mirroring how `tests/js/ui-dom.test.js` requires ui.js against the same stub pattern):

```js
// fase 2: param-forms' byggere konstruerer nå via window.Ui.makeNode —
// last den EKTE js/ui.js mot samme fake-DOM (samme mønster som
// ui-dom.test.js), aldri en stub av kjernen.
require('../../js/ui.js');
```

(If ui.js's DOM half needs globals this file's stub lacks, extend the stub minimally the way ui-dom.test.js's stub does — do not fork a second FakeEl dialect; copy the missing member.)

- [ ] **Step 2: Write shape-pin tests (append to `tests/js/param-forms-dom.test.js`, using that file's existing helpers for building a strip from a parsed cell — model on its existing per-type tests)**

```js
test('fase 2 pin: param-slider — range-input med param-form-value-readout', () => {
  // bygg en celle med: x = 4 #@param {type:"slider", min:0, max:10, step:2}
  // via filens eksisterende decorate/build-helper, hent kontrollen, og pin:
  //   input.type === 'range', min 0, max 10, step 2, String(value) '4',
  //   readout.className === 'param-form-value', readout.textContent === '4'
});

test('fase 2 pin: param-dropdown med allowInput — text-input + datalist-extra', () => {
  //   input.type === 'text', input.getAttribute('list') === datalist.id,
  //   datalist har options i rekkefølge
});

test('fase 2 pin: param-number integer — step tvunget til 1', () => {
  //   input.type === 'number', input.step === 1
});
```

Fill the three bodies concretely with the file's own harness idioms (the per-type build tests already in the file show the exact calls); the commented assertions are the required contract. They must PASS against current code before Step 3.

- [ ] **Step 3: Run — pins pass against current builders**

Run: `node --test tests/js/param-forms-dom.test.js`
Expected: pass

- [ ] **Step 4: Swap construction in `js/param-forms.js`**

(a) `_el` (:483) — same sugar as ui.js's (Task 2a), via the global:

```js
    function _el(tag, cls, text) {
      var props = {};
      if (cls) props.className = cls;
      if (text != null) props.textContent = text;
      return global.Ui.makeNode(tag, { props: props });
    }
```

Add above it: `// fase 2 (spec 2026-07-20): all konstruksjon via Ui.makeNode (js/ui.js lastes FØR denne filen, index.html:583-584) — W4-duplikatet ("B2 dedup") er dermed pensjonert.`

(b) Each builder's `document.createElement` + assignments become makeNode recipes, preserving the conditional-attribute guards:

- `_buildText`/`_buildDate`: `var input = global.Ui.makeNode('input', { props: { type: 'text', value: value == null ? '' : String(value) } });` (date: `type: 'date'`).
- `_buildRaw`: adds `className: 'param-form-raw'` to props.
- `_buildCheckbox`: `{ props: { type: 'checkbox', checked: !!value } }`.
- `_buildNumber`: assemble `nprops = { type: 'number', value: value }` then the same three `!== undefined` guards as today (integer forces `step: 1`).
- `_buildSlider`: `{ props: { type: 'range', min: range.min, max: range.max, step: range.step, value: value } }`; readout via `_el` unchanged.
- `_buildDropdown`: select + options via makeNode (as Task 2c); the allowInput branch builds the text input via makeNode with `attrs: { list: listId }` (list is attribute-only in real DOM — keep it in attrs) and the datalist via `global.Ui.makeNode('datalist', { props: { id: listId } })`, options appended via makeNode.

Event listeners and return objects untouched.

- [ ] **Step 5: Run the param-forms suites, then everything**

Run: `node --test tests/js/param-forms-dom.test.js tests/js/param-forms.test.js`
Expected: pass
Run: `node --test tests/js/*.test.js`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add js/param-forms.js tests/js/param-forms-dom.test.js
git commit -m "refactor(param-forms): byggerne konstruerer via Ui.makeNode — W4-duplikatet pensjonert, wiring urørt (fase 2)"
```

---

### Task 5: Full suites + browser sweep + spec status

**Files:**
- Modify: `docs/superpowers/specs/2026-07-20-unified-interactive-elements-design.md` (Status line, after the sweep)

- [ ] **Step 1: Full suites**

Run: `node --test tests/js/*.test.js` and `python -m pytest tests/ brython/tests/ micropython/tests/ -q`
Expected: all pass (Python untouched by this plan — a Python failure means something unexpected happened; stop and investigate)

- [ ] **Step 2: Browser sweep (serve repo root, cache-busted URL, pyodide boot ~30–60 s)**

- (a) Widget cell with all seven controls (`ui.slider`, `ui.dropdown`, `ui.checkbox`, `ui.switch`, `ui.number`, `ui.text`, `ui.play`, `ui.button`) → every control renders with today's look (compare against a pre-change screenshot if in doubt); values round-trip; slider drag reruns after debounce without rebuilding the strip (same node identity).
- (b) Play control: ▶ starts ticking, ⏸ stops, manual drag stops the timer, loop wraps.
- (c) Rerun the cell (edit + ▶) → controls update in place, no duplicates, values survive.
- (d) `#@param` cell with slider + dropdown(options) + boolean + integer + date + raw → form renders identically, edits write back into the source text, `run:auto` reruns.
- (e) `ui.html` example still works (element engine path — `elCreate` now routes through makeNode).
- (f) Both themes: quick visual check of the widget strip and param form.

- [ ] **Step 3: Update spec status and commit**

Append to the spec's `**Status:**` line: `; Phase 2 DELIVERED <dato> (plan 2026-07-20-shared-node-core.md)`.

```bash
git add docs/superpowers/specs/2026-07-20-unified-interactive-elements-design.md
git commit -m "docs(spec): fase 2 (delt konstruksjonskjerne) levert — begge byggersett på Ui.makeNode"
```
