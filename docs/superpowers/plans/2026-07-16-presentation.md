# Presentation View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Presentation view — the rendered notebook paginated into slides via the `slide` cell attribute, with arrow-key/click navigation, Esc exit, a view-menu entry and `#options.view = present` auto-start, per `docs/superpowers/specs/2026-07-16-presentation-design.md`.

**Architecture:** Pure half gets `C.slidePlan(cells)` (effective slide number per cell: own attr, else inherited; group by number). The DOM half gets a presentation layout STATE (`NB.present`): CSS classes hide editor chrome (the `nb-layout-output` recipe) and non-current cells (`nb-slide-hidden`) — DOM nodes never move, so widgets/plots/dash stay live on their slides. index.html adds the menu entry, the run-time directive branch; `C.contentLoaded` adds the load-time directive.

**Tech Stack:** ES5 var-style JS (`js/cells.js`, `index.html`), `app.css` (theme via existing custom properties `--bg/--text/--text-muted/--border/--accent`), node built-in test runner.

## Global Constraints

- **Notebook-only**: presentation requires `Cells.active()`; the menu path shows a status notice otherwise; code paths are silent no-ops.
- **No DOM moves**: slides are visibility classes on existing `.nb-cell` nodes; plots/widgets/dash are never reparented.
- **No new execution semantics**: entering/leaving presentation never runs code; presentation survives a run.
- **htmlTrusted unaffected**: html cells on slides keep the exact same trust gate.
- The hybrid segment machinery in index.html is not modified.
- ES5 var-style JS, Norwegian comments, user-facing strings through `t()` (+ `js/i18n/en.js` entries).
- Test baselines before this plan: `node --test tests/js/cells.test.js` → 106 pass; `node --test tests/js/cells-dom.test.js` → 95 pass; `node --test tests/js/*.test.js` → 532 tests / 528 pass / 4 known pre-existing ENOENT failures. pytest is untouched by this plan (baseline `python3 -m pytest tests/ brython/tests micropython/tests -q --continue-on-collection-errors` → 1228 pass + 1 known error).
- Run all commands from the repo root `/Users/hom/Documents/GitHub/openstat`.

---

### Task 1: `C.slidePlan` — the pure slide grouping

**Files:**
- Modify: `js/cells.js` (pure half — insert after the `C.renderContent` function, before the `SEG_MARKER` section)
- Test: `tests/js/cells.test.js` (append)

**Interfaces:**
- Consumes: `cell.attrs.slide` (string `'N'` from `slide=N`/`#tag.slide = N`, boolean `true` from the bare `slide` flag, or absent — already parsed/merged, reserved since spec 1), `C.resolveType`.
- Produces: `C.slidePlan(cells)` → `{ slides: [{ num: int, cellIdxs: [int] }], byCell: [int] }`. `slides` sorted by `num` ascending; `byCell[i]` = 0-based position in `slides` of cell i's slide (every cell gets one, including `skip` cells); `skip` cells are excluded from `cellIdxs` only. Task 2 depends on this exact shape.

- [ ] **Step 1: Write the failing tests**

Append to `tests/js/cells.test.js`:

```js
// ---------- presentasjon: slidePlan (spec 2026-07-16-presentation-design.md §1) ----------

test('slidePlan: eksplisitte numre + arv — unummererte følger forrige', () => {
  const p = C.parseCells('#%% md slide=1\na\n#%% python\nb\n#%% md slide=2\nc');
  const sp = C.slidePlan(p.cells);
  assert.deepStrictEqual(sp.slides.map((s) => s.num), [1, 2]);
  assert.deepStrictEqual(sp.slides[0].cellIdxs, [0, 1]);
  assert.deepStrictEqual(sp.slides[1].cellIdxs, [2]);
  assert.deepStrictEqual(sp.byCell, [0, 0, 1]);
});

test('slidePlan: bare slide-flagget auto-nummererer (høyeste sett + 1)', () => {
  const p = C.parseCells('#%% md slide=3\na\n#%% md slide\nb\n#%% md\nc');
  const sp = C.slidePlan(p.cells);
  assert.deepStrictEqual(sp.slides.map((s) => s.num), [3, 4]);
  assert.deepStrictEqual(sp.byCell, [0, 1, 1]);
});

test('slidePlan: ikke-numerisk verdi behandles som flagget (auto), ingen varsler', () => {
  const p = C.parseCells('#%% md slide=intro\na\n#%% md slide=abc\nb');
  const sp = C.slidePlan(p.cells);
  assert.deepStrictEqual(sp.slides.map((s) => s.num), [1, 2]);
});

test('slidePlan: gruppering per nummer, ikke naboskap — gjentatt nummer samler celler', () => {
  const p = C.parseCells('#%% md slide=1\na\n#%% md slide=2\nb\n#%% md slide=1\nc');
  const sp = C.slidePlan(p.cells);
  assert.deepStrictEqual(sp.slides.map((s) => s.num), [1, 2]);
  assert.deepStrictEqual(sp.slides[0].cellIdxs, [0, 2]);
  assert.deepStrictEqual(sp.byCell, [0, 1, 0]);
});

test('slidePlan: ledende unummererte celler (inkl. preambel) → første eksplisitte slide', () => {
  const p = C.parseCells('# preamble\n\n#%% md\nintro\n#%% md slide=5\na');
  const sp = C.slidePlan(p.cells);
  assert.deepStrictEqual(sp.slides.map((s) => s.num), [5]);
  assert.deepStrictEqual(sp.slides[0].cellIdxs, [0, 1, 2]);
  assert.deepStrictEqual(sp.byCell, [0, 0, 0]);
});

test('slidePlan: ingen slide-attrs → én slide med alt', () => {
  const p = C.parseCells('#%% md\na\n#%% python\nb');
  const sp = C.slidePlan(p.cells);
  assert.strictEqual(sp.slides.length, 1);
  assert.strictEqual(sp.slides[0].num, 1);
  assert.deepStrictEqual(sp.slides[0].cellIdxs, [0, 1]);
});

test('slidePlan: skip-celler utelates fra cellIdxs men driver arven (grensemarkør)', () => {
  const p = C.parseCells('#%% md slide=1\na\n#%% skip slide=2\nx\n#%% md\nb');
  const sp = C.slidePlan(p.cells);
  assert.deepStrictEqual(sp.slides.map((s) => s.num), [1, 2]);
  assert.deepStrictEqual(sp.slides[1].cellIdxs, [2]);
  assert.deepStrictEqual(sp.byCell, [0, 1, 1]);
});

test('slidePlan: #tag.slide og preambel-default mater planen via parseCells', () => {
  const p = C.parseCells('#tag.slide = 1\n# load x\n\n#%% md\n#tag.slide = 2\na\n#%% python\nb');
  const sp = C.slidePlan(p.cells);
  assert.deepStrictEqual(sp.slides.map((s) => s.num), [1, 2]);
  // preambelen (idx 0) er ledende-unummerert → FØRSTE EKSPLISITTE nummer i
  // dokumentrekkefølge (md-cellens 2, ikke laveste); md-cellen har egen
  // tag → 2; python-cellen får preambel-DEFAULTEN slide='1' (bakes i
  // attrs) → 1. slides sorteres stigende: pos 0 = nummer 1, pos 1 = nummer 2.
  assert.deepStrictEqual(sp.byCell, [1, 1, 0]);
});

test('slidePlan: tom celleliste → tom plan', () => {
  const sp = C.slidePlan([]);
  assert.deepStrictEqual(sp.slides, []);
  assert.deepStrictEqual(sp.byCell, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/js/cells.test.js`
Expected: FAIL — `C.slidePlan is not a function` on the 9 new tests; the pre-existing 106 still pass.

- [ ] **Step 3: Implement `C.slidePlan`**

Insert into `js/cells.js` after `C.renderContent` (pure half):

```js
  // ---------- presentasjon: slide-plan (spec 2026-07-16-presentation-design.md §1) ----------

  // Effektivt slide-nummer per celle: eget attrs.slide, ellers arvet fra
  // forrige celle ("unummererte celler følger forrige celles slide").
  // slide=N (heltall) = eksplisitt nummer; bare `slide`-flagget (boolean
  // true) og ikke-numeriske verdier = auto-nummer (høyeste sett så langt
  // + 1) — den ergonomiske «#%% md slide starter neste slide»-formen.
  // Tolerant: aldri varsler (layout-nivå, ikke parse-nivå). Gruppering er
  // PER NUMMER, ikke naboskap — slides er de distinkte numrene stigende
  // sortert; synligheten er per-celle-CSS (DOM-halvdelen), så ikke-
  // sammenhengende grupper koster ingenting og gir forfattere omstokkings-
  // makt. skip-celler deltar i arven (en '#%% skip slide=4'-grensemarkør
  // virker) men utelates fra cellIdxs (de rendrer ingenting — CSS skjuler
  // dem uansett i presentasjon). Ledende celler uten nummer (preambelen
  // inkludert) tilhører den FØRSTE eksplisitte sliden (1 når ingen finnes)
  // — «tittel-cellene før første nummer hører til første slide».
  C.slidePlan = function (cells) {
    var eff = [], cur = null, maxSeen = 0, i;
    for (i = 0; i < cells.length; i++) {
      var a = cells[i].attrs ? cells[i].attrs.slide : undefined;
      if (a !== undefined) {
        var n = a === true ? NaN : parseInt(a, 10);
        cur = isNaN(n) ? maxSeen + 1 : n;
      }
      if (cur !== null && cur > maxSeen) maxSeen = cur;
      eff.push(cur);
    }
    var first = null;
    for (i = 0; i < eff.length; i++) { if (eff[i] !== null) { first = eff[i]; break; } }
    if (first === null) first = 1;
    var nums = [];
    for (i = 0; i < eff.length; i++) {
      if (eff[i] === null) eff[i] = first;
      if (nums.indexOf(eff[i]) === -1) nums.push(eff[i]);
    }
    nums.sort(function (x, y) { return x - y; });
    var slides = [], byCell = [];
    for (i = 0; i < nums.length; i++) slides.push({ num: nums[i], cellIdxs: [] });
    for (i = 0; i < cells.length; i++) {
      var pos = nums.indexOf(eff[i]);
      byCell.push(pos);
      if (C.resolveType(cells[i], null) !== 'skip') slides[pos].cellIdxs.push(i);
    }
    return { slides: slides, byCell: byCell };
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/js/cells.test.js`
Expected: PASS — 115 tests (106 + 9 new), 0 fail.

- [ ] **Step 5: Commit**

```bash
git add js/cells.js tests/js/cells.test.js
git commit -m "feat(cells): C.slidePlan — effektive slide-numre, arv, auto-nummer, gruppering per nummer"
```

---

### Task 2: Presentation state — DOM half + CSS

**Files:**
- Modify: `js/cells.js` (DOM half — new block after `C.setLayout`; small additions to `render()`, `C.exit`, `C.contentLoaded`)
- Modify: `app.css` (append a presentation section)
- Test: `tests/js/cells-dom.test.js` (append)

**Interfaces:**
- Consumes: `C.slidePlan(cells)` from Task 1 (exact shape above); existing `NB` state, `el()`, `t()`, `C.setLayout`, `render()`.
- Produces: `C.presentStart()` → boolean (false when notebook inactive or zero slides; true otherwise, idempotent), `C.presentExit()` (safe no-op when not presenting), `C.presenting()` → boolean, and the test-only export `C._presentKeydown(ev)`. `NB.present = null | { slides, byCell, cur, prevLayout, counter, navEls }`. CSS classes: `nb-present` (on `.nb-root`), `present-active` (on `body`), `nb-slide-hidden` (per cell), `.nb-present-nav`/`.nb-present-prev`/`.nb-present-next`/`.nb-present-counter`. Task 3's entry points call `presentStart`/`presentExit`/`presenting`.

- [ ] **Step 1: Write the failing stub-DOM tests**

Append to `tests/js/cells-dom.test.js` (helpers `freshEnv`, `collectNodes`, `nbRoot`, `cellParts`, `click` already exist in the file):

```js
// ---- presentasjon (spec 2026-07-16-presentation-design.md, Task 2) ----

test('presentStart: kun gjeldende slides celler synlige; nb-present på rota', () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% md slide=1\n# En\n#%% python\nx = 1\n#%% md slide=2\n# To\n';
  C.init('python');
  assert.strictEqual(C.active(), true);
  assert.strictEqual(C.presentStart(), true);
  assert.strictEqual(C.presenting(), true);
  const root = nbRoot(containerEl);
  assert.ok(root.classList.contains('nb-present'));
  assert.ok(!cellParts(containerEl, 0).wrap.classList.contains('nb-slide-hidden'));
  assert.ok(!cellParts(containerEl, 1).wrap.classList.contains('nb-slide-hidden'));
  assert.ok(cellParts(containerEl, 2).wrap.classList.contains('nb-slide-hidden'));
});

test('present: klikk-soner navigerer, teller oppdateres, klemming i endene', () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% md slide=1\nA\n#%% md slide=2\nB\n';
  C.init('python');
  C.presentStart();
  const root = nbRoot(containerEl);
  const nodes = collectNodes(root, []);
  const nextBtn = nodes.find((n) => n.classList && n.classList.contains('nb-present-next'));
  const prevBtn = nodes.find((n) => n.classList && n.classList.contains('nb-present-prev'));
  const counter = nodes.find((n) => n.classList && n.classList.contains('nb-present-counter'));
  assert.strictEqual(counter.textContent, '1 / 2');
  click(nextBtn);
  assert.strictEqual(counter.textContent, '2 / 2');
  assert.ok(cellParts(containerEl, 0).wrap.classList.contains('nb-slide-hidden'));
  click(nextBtn); // klem: forbli på siste
  assert.strictEqual(counter.textContent, '2 / 2');
  click(prevBtn);
  assert.strictEqual(counter.textContent, '1 / 2');
});

test('presentExit gjenoppretter layout og fjerner nav-noder + synlighetsklasser', () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% md slide=1\nA\n#%% md slide=2\nB\n';
  C.init('python');
  C.presentStart();
  C.presentExit();
  assert.strictEqual(C.presenting(), false);
  const root = nbRoot(containerEl);
  assert.ok(!root.classList.contains('nb-present'));
  assert.ok(root.classList.contains('nb-layout-columns'));
  assert.ok(!cellParts(containerEl, 1).wrap.classList.contains('nb-slide-hidden'));
  const nodes = collectNodes(root, []);
  assert.ok(!nodes.some((n) => n.classList && n.classList.contains('nb-present-nav')));
  assert.ok(!nodes.some((n) => n.classList && n.classList.contains('nb-present-counter')));
});

test('_presentKeydown: piler navigerer, Escape avslutter; skjemafelt ignoreres', () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% md slide=1\nA\n#%% md slide=2\nB\n';
  C.init('python');
  C.presentStart();
  let prevented = 0;
  const mk = (key, tag) => ({ key, target: { tagName: tag }, preventDefault: () => { prevented++; } });
  C._presentKeydown(mk('ArrowRight', 'DIV'));
  let counter = collectNodes(nbRoot(containerEl), []).find((n) => n.classList && n.classList.contains('nb-present-counter'));
  assert.strictEqual(counter.textContent, '2 / 2');
  C._presentKeydown(mk('ArrowRight', 'TEXTAREA'));   // skjemafelt: ignorert
  assert.strictEqual(counter.textContent, '2 / 2');
  C._presentKeydown(mk('Escape', 'DIV'));
  assert.strictEqual(C.presenting(), false);
  assert.ok(prevented >= 2, 'ArrowRight + Escape skal preventDefault');
});

test('re-render mens presentasjon er aktiv: modus beholdes, cur klemmes', () => {
  const { C, scriptInputEl, containerEl } = freshEnv();
  scriptInputEl.value = '#%% md slide=1\nA\n#%% md slide=2\nB\n';
  C.init('python');
  C.presentStart();
  const nodes = collectNodes(nbRoot(containerEl), []);
  click(nodes.find((n) => n.classList && n.classList.contains('nb-present-next')));
  scriptInputEl.value = '#%% md slide=1\nA\n';
  C.refreshFromScript();
  assert.strictEqual(C.presenting(), true);
  const root = nbRoot(containerEl);
  assert.ok(root.classList.contains('nb-present'), 'nb-present overlever render()s className-reset');
  const counter = collectNodes(root, []).find((n) => n.classList && n.classList.contains('nb-present-counter'));
  assert.strictEqual(counter.textContent, '1 / 1');
});

test('contentLoaded (nytt dokument) og exit (Rå tekst) avslutter presentasjonen', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = '#%% md slide=1\nA\n';
  C.init('python');
  C.presentStart();
  scriptInputEl.value = '#%% md\nB\n';
  C.contentLoaded();
  assert.strictEqual(C.presenting(), false);
  C.presentStart();
  C.exit({ raw: true });
  assert.strictEqual(C.presenting(), false);
});

test('presentStart: no-op uten aktiv notatbok', () => {
  const { C, scriptInputEl } = freshEnv();
  scriptInputEl.value = 'print(1)\n';
  C.init('python');
  assert.strictEqual(C.active(), false);
  assert.strictEqual(C.presentStart(), false);
  assert.strictEqual(C.presenting(), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/js/cells-dom.test.js`
Expected: the 7 new tests FAIL (`C.presentStart is not a function`); pre-existing 95 pass.

- [ ] **Step 3: Implement the presentation block**

(a) Insert after `C.setLayout` in `js/cells.js` (DOM half):

```js
    // ---------- presentasjon (spec 2026-07-16-presentation-design.md §2) ----------
    // Layout-TILSTAND over samme rendrede dokument: ingen DOM-flytting —
    // synlighet per celle via .nb-slide-hidden, editor-chrome skjules av
    // .nb-present-CSS-en (nb-layout-output-oppskriften, app.css). Widgets/
    // plots/dash blir stående i cellene sine og lever videre på sin slide.
    // Stub-DOM-forbehold: document.body/addEventListener kan mangle i test-
    // harnesset — samme dobbelt-guard som resten av fila bruker for globaler.

    function presentApply() {
      var P = NB.present;
      if (!P || !NB.root) return;
      for (var i = 0; i < NB.cells.length; i++) {
        var c = NB.cells[i];
        if (c && c._wrap) c._wrap.classList.toggle('nb-slide-hidden', P.byCell[i] !== P.cur);
      }
      // Samle-sloten (planavvik-fallback) hører til siste slide.
      if (NB.trailing) NB.trailing.classList.toggle('nb-slide-hidden', P.cur !== P.slides.length - 1);
      if (P.counter) P.counter.textContent = (P.cur + 1) + ' / ' + P.slides.length;
    }

    function presentNav(delta) {
      var P = NB.present;
      if (!P) return;
      var next = Math.min(P.slides.length - 1, Math.max(0, P.cur + delta));
      if (next === P.cur) return;
      P.cur = next;
      presentApply();
      if (NB.root) NB.root.scrollTop = 0;
    }

    // Piler/Esc — kun installert mens presentasjonen er aktiv. Skjemafelt
    // (widgets på sliden) beholder tastene sine; eksisterende Esc-handlere
    // er overlay-scopet og sameksisterer. Eksportert (_-prefiks) for
    // stub-DOM-testene, som mangler document.addEventListener.
    function presentKeydown(ev) {
      if (!NB.present) return;
      var tgt = ev.target;
      var tag = tgt && tgt.tagName ? String(tgt.tagName).toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || (tgt && tgt.isContentEditable)) return;
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown' || ev.key === 'PageDown' || ev.key === ' ') {
        ev.preventDefault(); presentNav(1);
      } else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' || ev.key === 'PageUp') {
        ev.preventDefault(); presentNav(-1);
      } else if (ev.key === 'Escape') {
        ev.preventDefault(); C.presentExit();
      }
    }
    C._presentKeydown = presentKeydown;

    function presentBuildNav() {
      var P = NB.present;
      if (!P || !NB.root) return;
      var prev = el('button', 'nb-present-nav nb-present-prev', '‹');
      prev.type = 'button'; prev.title = t('Forrige slide');
      prev.addEventListener('click', function () { presentNav(-1); });
      var next = el('button', 'nb-present-nav nb-present-next', '›');
      next.type = 'button'; next.title = t('Neste slide');
      next.addEventListener('click', function () { presentNav(1); });
      var counter = el('span', 'nb-present-counter');
      P.counter = counter;
      P.navEls = [prev, next, counter];
      NB.root.appendChild(prev); NB.root.appendChild(next); NB.root.appendChild(counter);
    }

    C.presenting = function () { return !!NB.present; };

    C.presentStart = function () {
      if (!NB.activeFlag || !NB.root) return false;
      if (NB.present) return true;                       // idempotent
      var plan = C.slidePlan(NB.cells);
      if (!plan.slides.length) return false;
      NB.present = { slides: plan.slides, byCell: plan.byCell, cur: 0,
                     prevLayout: NB.layout, counter: null, navEls: [] };
      NB.root.classList.add('nb-present');
      if (document.body && document.body.classList) document.body.classList.add('present-active');
      presentBuildNav();
      presentApply();
      if (document.addEventListener) document.addEventListener('keydown', presentKeydown);
      if (global.mdSyncViewDropdown) global.mdSyncViewDropdown('present');
      if (global.refreshPlotlyAfterLayout) global.refreshPlotlyAfterLayout();
      return true;
    };

    C.presentExit = function () {
      if (!NB.present) return;
      var P = NB.present;
      NB.present = null;
      if (document.removeEventListener) document.removeEventListener('keydown', presentKeydown);
      if (document.body && document.body.classList) document.body.classList.remove('present-active');
      if (NB.root) {
        NB.root.classList.remove('nb-present');
        for (var i = 0; i < P.navEls.length; i++) { if (P.navEls[i] && P.navEls[i].remove) P.navEls[i].remove(); }
        for (var j = 0; j < NB.cells.length; j++) {
          var c = NB.cells[j];
          if (c && c._wrap) c._wrap.classList.remove('nb-slide-hidden');
        }
        if (NB.trailing) NB.trailing.classList.remove('nb-slide-hidden');
      }
      // Gjenopprett layouten fra før presentasjonen (setLayout re-appliserer
      // nb-layout-klassen render()s className-reset ellers ville satt).
      C.setLayout(P.prevLayout || 'columns');
      if (global.mdSyncViewDropdown) {
        global.mdSyncViewDropdown(P.prevLayout === 'output' ? 'output' : (P.prevLayout || 'columns'));
      }
    };
```

(b) `render()` tail — right after the existing `autoSizeAll();` line at the end of the function, add:

```js
      // Presentasjon overlever re-render (spec §2): innerHTML=''-rebyggingen
      // over kastet nav-nodene og alle synlighetsklasser, og className-
      // resetten fjernet nb-present. Regn planen på nytt (dokumentet kan ha
      // endret seg), klem cur, og bygg overlegget på nytt.
      if (NB.present) {
        var _plan = C.slidePlan(NB.cells);
        if (!_plan.slides.length) {
          C.presentExit();
        } else {
          NB.present.slides = _plan.slides;
          NB.present.byCell = _plan.byCell;
          if (NB.present.cur >= _plan.slides.length) NB.present.cur = _plan.slides.length - 1;
          NB.root.classList.add('nb-present');
          presentBuildNav();
          presentApply();
        }
      }
```

(c) `C.exit` — add as the FIRST line of the function body (before `if (opts && opts.raw)`):

```js
      C.presentExit();
```

(d) `C.contentLoaded` — add right after the `ParamForms.resetDocument` guard block (before `NB.htmlTrusted = ...`):

```js
      // Nytt dokument → presentasjonen avsluttes (samme invalidering som
      // sesjonen over; presentasjon overlever aldri dokument-/modusbytte).
      C.presentExit();
```

(e) Append to `app.css`:

```css
/* ---------- presentasjon (spec 2026-07-16-presentation-design.md) ---------- */
/* Layout-tilstand over samme rendrede dokument: full-viewport-overlegg,
   editor-chrome skjult (nb-layout-output-oppskriften), én slide synlig.
   Temaer via de eksisterende variablene (--bg/--text-muted/--border). */
body.present-active .topbar, body.present-active .bottombar { display: none; }
.nb-root.nb-present { position: fixed; inset: 0; z-index: 250; overflow-y: auto;
  background: var(--bg); margin: 0; padding: 48px 72px; font-size: 1.15em; }
.nb-present .nb-bar, .nb-present .nb-input, .nb-present .nb-tools,
.nb-present .nb-edit-btn, .nb-present .nb-skip { display: none; }
/* Ren slide-flate: cellekort-chrome av — men style=note/warn/card er INNHOLD
   og beholder utseendet sitt. */
.nb-present .nb-cell:not(.nb-style-note):not(.nb-style-warn):not(.nb-style-card) {
  border: none; padding: 4px 0; }
.nb-present .nb-cell { grid-template-columns: 1fr; }
.nb-slide-hidden { display: none !important; }
.nb-present-nav { position: fixed; top: 0; bottom: 0; width: 7%; min-width: 48px;
  border: none; background: transparent; color: transparent; font-size: 42px;
  cursor: pointer; z-index: 260; }
.nb-present-nav:hover { color: var(--text-muted);
  background: color-mix(in srgb, var(--text) 5%, transparent); }
.nb-present-prev { left: 0; }
.nb-present-next { right: 0; }
.nb-present-counter { position: fixed; right: 16px; bottom: 12px; z-index: 260;
  font-size: 13px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/js/cells-dom.test.js`
Expected: PASS — 102 tests (95 + 7 new), 0 fail.

- [ ] **Step 5: Full node suite regression**

Run: `node --test tests/js/*.test.js`
Expected: only the 4 known ENOENT failures.

- [ ] **Step 6: Commit**

```bash
git add js/cells.js app.css tests/js/cells-dom.test.js
git commit -m "feat(cells): presentasjonstilstand — slide-synlighet, nav-soner, tastatur, exit-hooks + CSS"
```

---

### Task 3: Entry points, i18n, example, exit gate

**Files:**
- Modify: `index.html` — view menu markup (`#viewModeMenu`, ~line 285-290), `initViewModeDropdown` handler (~line 3489-3533), run-time `#options.view` branch (~line 9974-9980), `viewModeBtn` title (~line 281), cells.js `?v=` bump (~line 581)
- Modify: `js/cells.js` — `C.contentLoaded` tail (load-time directive)
- Modify: `js/i18n/en.js` — 4 new keys
- Modify: `sw.js` — CACHE bump `m2py-v19` → `m2py-v20`
- Create: `examples/python/py_presentasjon.txt`
- Modify: `examples/manifest.json` (via `python3 examples/generate_manifest.py`)
- Modify: `docs/superpowers/specs/2026-07-16-presentation-design.md` (status line)
- Test: browser exit gate; report to `.superpowers/sdd/task-pres-3-report.md`

**Interfaces:**
- Consumes: `C.presentStart()`/`C.presentExit()`/`C.presenting()` from Task 2 (exact semantics above).
- Produces: user-facing entry points; the shipped example.

- [ ] **Step 1: View menu markup + handler**

(a) index.html `#viewModeMenu` — add after the `forklar` button:

```html
          <button type="button" data-view="present" data-i18n>Presentasjon</button>
```

(b) index.html `viewModeBtn` title (data-i18n-title attribute value): change to
`title="Velg visning (kolonner, stablet, kun output/dashboard, skrittvis, presentasjon)"`.

(c) In `initViewModeDropdown`: extend `LABELS` with `present: t('Presentasjon')`, and add a `present` branch FIRST in the click handler (before the notebook-active branch), plus a `presentExit` call in the notebook-active branch:

```js
          var v = b.dataset.view;
          if (v === 'present') {
            if (window.Cells && window.Cells.active() && window.Cells.presentStart()) {
              setActive('present');
            } else {
              setStatus(rightStatus, t('Presentasjon krever et notatbok-dokument (#%%-celler)'), true);
            }
            return;
          }
          if (window.Cells && window.Cells.active() && v !== 'forklar') {
            if (window.Cells.presentExit) window.Cells.presentExit();
            window.Cells.setLayout(v === 'output' ? 'output' : v);
            setActive(v);
            return;
          }
```

(the rest of the handler is unchanged).

- [ ] **Step 2: Load-time + run-time directive**

(a) `js/cells.js`, tail of `C.contentLoaded` — right BEFORE the final `C.syncTickBaseline();` line, add:

```js
      // #options.view = present (spec §3): delte lenker/eksempler/GitHub-
      // filer åpner rett i presentasjon. Kun her (dokumentlasting) — vanlig
      // redigering trigger aldri auto-start. Trygt for utrygt opphav:
      // presentasjon KJØRER ingenting, og html-celler beholder trust-gaten.
      if (NB.activeFlag && ta &&
          /^\s*(?:#|\/\/)\s*options\.view\s*=\s*["']?present["']?\s*$/mi.test(ta.value)) {
        C.presentStart();
      }
```

(b) index.html run-time `#options.view` branch (~9974-9980) — replace the block body:

```js
        // #options.view = output-only | split | present → visnings-tilstand fra scriptet
        if (_scriptOpts.view !== undefined && window.mdSetInputHidden) {
          var _vw = String(_scriptOpts.view).toLowerCase().replace(/[\s_]+/g, '-');
          if (_vw === 'present' || _vw === 'presentasjon') {
            if (window.Cells && window.Cells.active() && window.Cells.presentStart) window.Cells.presentStart();
          } else {
            var _hide = (_vw === 'output-only' || _vw === 'output' || _vw === 'results-only');
            window.mdSetInputHidden(_hide);
            if (window.mdOnInputToggle) window.mdOnInputToggle(_hide);
          }
        }
```

(c) `js/i18n/en.js` — add near the other UI strings (e.g. after the "Meny"/"Fil" block):

```js
  "Presentasjon": "Presentation",
  "Presentasjon krever et notatbok-dokument (#%%-celler)": "Presentation requires a notebook document (#%% cells)",
  "Forrige slide": "Previous slide",
  "Neste slide": "Next slide",
  "Velg visning (kolonner, stablet, kun output/dashboard, skrittvis, presentasjon)": "Choose view (columns, stacked, output only/dashboard, step-by-step, presentation)",
```

(d) Cache busts: index.html `js/cells.js?v=2026-07-16c` → `?v=2026-07-16d`; `sw.js` `const CACHE = 'm2py-v19'` → `'m2py-v20'`.

- [ ] **Step 3: Stub-DOM smoke for the contentLoaded directive**

Append to `tests/js/cells-dom.test.js`:

```js
test('contentLoaded: #options.view = present auto-starter presentasjonen', () => {
  const { C, scriptInputEl } = freshEnv();
  C.init('python');
  scriptInputEl.value = '#options.view = present\n\n#%% md slide=1\nA\n#%% md slide=2\nB\n';
  C.contentLoaded({ untrusted: true });
  assert.strictEqual(C.active(), true);
  assert.strictEqual(C.presenting(), true);
});
```

Run: `node --test tests/js/cells-dom.test.js`
Expected: PASS — 103 tests, 0 fail. Then `node --test tests/js/*.test.js` — only the 4 known ENOENT failures.

- [ ] **Step 4: Write the example + manifest**

Create `examples/python/py_presentasjon.txt`:

```
# label: Notatbok — presentasjon (slides)
#options.mode = python
#options.title = "Presentasjon — slides fra celler"
#options.description = "slide=-attributtet grupperer celler i slides; piltaster/klikkesoner navigerer, Esc avslutter; #options.view = present åpner delte lenker rett i presentasjonen"
# load https://raw.githubusercontent.com/hmelberg/openstat/main/data/iris.csv as iris

#%% md slide=1
# Iris som presentasjon

Dette dokumentet er også en presentasjon: `slide=1` på cellemarkøren
(eller `#tag.slide = 1` øverst i cellekroppen) grupperer celler i slides.
Celler uten nummer følger forrige celle.

Velg **Presentasjon** i visningsmenyen nede til venstre. Piltaster eller
klikkesonene i kantene bytter slide; Esc avslutter. Legg til
`#options.view = present` i preambelen for at en delt lenke skal åpne
rett i presentasjonen.

#%% python slide=2 hide-code
iris.groupby("species")["sepal_length"].mean()

#%% md
Gjennomsnittlig begerbladlengde per art — kodecellen over har
`hide-code`, så bare resultatet vises på sliden. Denne tekstcellen har
ikke noe eget slide-nummer og følger forrige celle (slide 2).

#%% python slide=3
#tag.hide-code = true
import plotly.express as pe
pe.scatter(iris, x="sepal_length", y="sepal_width", color="species")
```

Then run `python3 examples/generate_manifest.py` and check `git diff examples/manifest.json` shows exactly ONE added entry.

- [ ] **Step 5: Browser exit-gate sweep**

Serve the repo (`python3 -m http.server 8899`, run from the repo root, fresh port, cache-bypass query) and verify with Playwright. Record each row PASS/FAIL with one line of evidence in `.superpowers/sdd/task-pres-3-report.md`:

1. Load the example → Kjør alle → view menu → Presentasjon: slide 1 shows only the title cell; counter "1 / 3"; topbar/bottombar hidden; no editors/toolbars visible.
2. ArrowRight/ArrowLeft navigate; edge click zones navigate; Esc exits and restores the previous layout AND the dropdown label.
3. Slide 2: the `hide-code` result and the unnumbered md cell both visible (grouping + inheritance); slide 3: the plotly scatter renders (`#tag.hide-code` hides its code).
4. Widget live on a slide (ad hoc doc: an `ui.slider(...)`-cell with `slide=1` + rerun) — moving the slider reruns and updates the same slide without leaving presentation.
5. `#options.view = present`: add the directive to the example text, copy a share link (Del), open it fresh → presentation auto-starts; an html cell on a slide stays escaped with "Vis HTML" (untrusted) until accepted.
6. Kjør alle WHILE presenting → output slots fill; presentation stays active.
7. Plain script (no `#%%`) → menu Presentasjon → status notice, view unchanged.
8. Regression: kolonner/stablet/kun output all still work after exiting presentation; Skrittvis entry still runs; Rå tekst exits presentation cleanly.
9. Both themes: nav chevrons/counter legible in light and dark.
10. Keyboard isolation: with a widget input focused on a slide, ArrowLeft/Right edits the field and does NOT change slide.

- [ ] **Step 6: Suites + spec status + commit**

Run: `node --test tests/js/*.test.js` → only the 4 known ENOENT failures.
Run: `python3 -m pytest tests/ brython/tests micropython/tests -q --continue-on-collection-errors` → 1228 pass + 1 known error.

Add at the top of `docs/superpowers/specs/2026-07-16-presentation-design.md` under the title: `**Status:** DELIVERED <date> (plan 2026-07-16-presentation.md).`

```bash
git add index.html js/cells.js js/i18n/en.js sw.js examples/python/py_presentasjon.txt examples/manifest.json tests/js/cells-dom.test.js docs/superpowers/specs/2026-07-16-presentation-design.md
git commit -m "feat(presentasjon): menyoppføring, #options.view=present (last+kjør), i18n, eksempel — exit gate verifisert"
```
