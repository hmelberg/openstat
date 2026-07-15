# Notebook Widgets — W3 Implementation Plan (ipywidgets bridge, pyodide-only)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec 2 track 2: real `ipywidgets` running natively in pyodide notebooks — `import ipywidgets as w; s = w.IntSlider(...); s` renders a live Jupyter widget in the cell; `observe` callbacks fire in Python on frontend changes; zero footprint for documents that never import ipywidgets. v1 scope per the (just-corrected) spec: stock controls, observe/traitlets sync both ways, display in slots. `interact()`/`Output` explicitly deferred.

**Architecture (research-verified 2026-07-15, sources in the ledger):** Python side reuses the real `comm` package — a `BaseComm` subclass whose `publish_msg` calls a JS-bound function directly (main thread, no transport; JupyterLite's `pyodide_kernel/comm.py` is the model, minus the worker plumbing). JS side: lazy-load `require.min.js` + the pinned `@jupyter-widgets/html-manager@1.0.14` `embed-amd.js` bundle, subclass `HTMLManager` overriding its no-op `_create_comm`/`_get_comm_info` with a hand-rolled `IClassicComm` shim registry; incoming widget messages route via `ManagerBase.handle_comm_open`/the shim's `on_msg`; outgoing frontend changes call back into Python via `comm_manager.comm_msg`-style dispatch. Display: the exec core detects `_repr_mimebundle_` containing `application/vnd.jupyter.widget-view+json` and emits an embed marker; the output renderer mounts the view via `manager.get_model(id)` → `create_view` → `display_view(view, el)`.

## Global Constraints

- **Isolation guarantee (spec):** no code shared with track 1 (`ui`); nothing loads unless the document matches `/^\s*(?:import|from)\s+ipywidgets\b/m`; a failed bridge load degrades to a clear error in the cell, never a crash; plain scripts and ui-widget notebooks byte-identical.
- **Version pins are law:** `@jupyter-widgets/html-manager@1.0.14` (embed-amd.js, SRI `sha256-wVnYFUr/gmgTB+SmzVXY1d5HFbS034aMlD6CueTCjuA=`), `require.min.js 2.3.4` (cdnjs, SRI `sha256-Ae2Vz/4ePdIu6ZyI/5ZGsYnb+m0JlOmKPjt6XZ9JJkA=`), python `ipywidgets==8.1.6` (+ its lockstep deps). Pins live in ONE place (a const block) with a comment pointing at the lockstep table in the ledger/spec.
- ipywidgets protocol facts (from `packages/schema/messages.md`): comm target `jupyter.widget`; `comm_open` metadata carries `version: '2.1.0'` — the manager rejects on major mismatch; msg methods `update`/`echo_update`/`request_state`/`custom` with `buffer_paths`; display mimebundle `{"model_id": …, "version_major": 2}`. The `jupyter.widget.control`/`request_states` bulk path is only used by `restoreWidgets()` — we never call it (no pre-existing widgets on page load); do not implement.
- micropip: plain `micropip.install('ipywidgets==8.1.6')` pulls `widgetsnbextension`/`jupyterlab_widgets` (inert JS-asset wheels, requires_dist:None) — ACCEPT them (harmless, avoids deps=False fragility). IPython's `pexpect`/`psutil` have `sys_platform != "emscripten"` markers (skip automatically). If IPython import trips on missing stdlib modules at runtime, mock them the JupyterLite way (`sys.modules['fcntl'] = types.ModuleType(...)` etc. — see their `mocks.py`) — add only the mocks that prove necessary.
- Style/test/commit conventions as W1/W2. Baselines: node 253/4 pre-existing; pytest 664 (+ facades 478).

**Reference implementation facts (condensed from research; the implementer should NOT need to re-fetch):**

- JupyterLite kernel comm (pattern to copy): `class Comm(BaseComm): def publish_msg(self, msg_type, data=None, metadata=None, buffers=None, **keys): content = dict(data=data or {}, comm_id=self.comm_id, **keys); <deliver>(msg_type, content, metadata or {}, buffers)` then `comm.create_comm = Comm`. `comm.get_comm_manager()` returns the STOCK `CommManager` — its `comm_open/comm_msg/comm_close(stream, ident, msg)` methods are the incoming-dispatch entry points; msg shape `{'content': {'comm_id':…, 'data':…}, …}` (mirror how pyodide-kernel's worker calls `comm_manager.comm_msg(None, None, toPy(content))` — pass Python dicts, e.g. built via `json.loads`).
- Frontend: `ManagerBase.handle_comm_open(comm, msg)` validates `msg.metadata.version`, applies `put_buffers`, `new_model({model_name, model_module, model_module_version, comm}, state)`. The `comm` argument must look like `IClassicComm`: `{comm_id, target_name, on_msg(cb), on_close(cb), send(data, callbacks, metadata, buffers), open(...), close(...)}`. Rendering: `manager.get_model(id)` → `manager.create_view(model)` → `manager.display_view(view, el)` (Lumino attach — inherited, works for any manager subclass).
- embed-amd.js defines AMD modules; after loading require.min.js + embed-amd.js, obtain classes via `require(['@jupyter-widgets/html-manager'], …)` (and base/base-manager modules are registered by libembed glue inside the bundle). Verify at implementation time which module ids resolve (`@jupyter-widgets/html-manager` exports `HTMLManager`).

---

### Task 1: `js/ipywidgets-bridge.js` — loader, manager subclass, comm shim

**Files:** Create `js/ipywidgets-bridge.js`; Test `tests/js/ipywidgets-bridge.test.js` (pure parts); Modify `index.html` (script include)

**Interfaces produced (`window.IpwBridge`):**
- `ensure() → Promise` — memoized: inject `require.min.js` then `embed-amd.js` (pinned URLs + SRI + crossorigin anonymous), `require` the html-manager module, build the singleton `LiveManager extends HTMLManager` with: `_create_comm(target_name, model_id, data, metadata, buffers)` → create/register a shim + notify Python side (only used for frontend-initiated comms — rare in v1; implement minimally), `_get_comm_info()` → resolve `{}` (we never restoreWidgets), and a `loader` passthrough for CDN third-party AMD (best effort, default on).
- `fromKernel(msgTypeStr, contentJson, metadataJson, buffersArr)` — called BY PYTHON: `comm_open` → build shim, `manager.handle_comm_open(shim, {content, metadata, buffers})`; `comm_msg` → shim's registered on_msg callback with the message shape the widgets expect (`{content: {comm_id, data}, buffers}`); `comm_close` → on_close + registry cleanup. Buffers: accept an array of ArrayBuffer/TypedArray (pyodide `to_js` output), pass through as DataView list per protocol.
- Shim `send(data, callbacks, metadata, buffers)` (frontend → kernel) → invoke the Python dispatch function (`IpwBridge._toKernel`, a pyodide-bound callable set during python setup) with `(comm_id, dataJson, buffers)`.
- `renderView(modelId, el) → Promise` — get_model → create_view → display_view; unknown model → friendly error text into el.
- `reset()` — dispose views/models/registry (document switch, session restart).
- Pure, node-testable half: the comm-shim registry (open/route/close bookkeeping, callback fan-out) factored as `IpwBridge._registry` with no DOM/require dependency + tests (open→msg routes to the right shim; close cleans; msg for unknown id warns; double-open same id replaces with warn).

- [ ] Tests first for the pure registry; implement; `node --test tests/js/*.test.js` → 253+new / 4. Include tag added next to ui.js.
- [ ] Commit `feat(ipw): bridge-skjelett — lazy lasting (pinnede bundles + SRI), LiveManager, comm-shim-register`.

### Task 2: python side — `pyodide/ipw_setup.py` + lazy loader + session lifecycle

**Files:** Create `pyodide/ipw_setup.py`; Modify `index.html` (`__ensureIpywidgets(py)` + preRun/per-cell gates mirroring `__ensureUi`'s TWO entry points — learn from W1's B1 blocker: BOTH btnRun preRun AND `mdRunNotebookCell` must gate)

**Interfaces produced:**
- `__ensureIpywidgets(py)`: memoized; gate regex `/^\s*(?:import|from)\s+ipywidgets\b/m` on the whole document; steps: (1) `micropip.install(['ipywidgets==8.1.6'])` (accept transitive wheels; status text `t('Installerer ipywidgets…')` — ~10 MB first time); (2) run `pyodide/ipw_setup.py` (fetched, exec'd via the spec_from_loader pattern) which: subclasses `BaseComm` with `publish_msg` calling the JS-bound deliverer, sets `comm.create_comm`, defines `_ipw_dispatch(msg_type, content_json, buffers)` that routes into `comm.get_comm_manager().comm_open/comm_msg/comm_close(None, None, msg_dict)` building the msg dict shape the stock CommManager expects; (3) JS side: `await IpwBridge.ensure()`, bind the deliverer (`IpwBridge.fromKernel`) into python (py.globals or a js-module attribute) and bind `_ipw_dispatch` as `IpwBridge._toKernel`'s target. Failure at any step → console.warn + `{notice}`-style message in the running cell, never an abort.
- Session lifecycle: `mdNotebookSession` restart/invalidate and `Cells.contentLoaded` → `IpwBridge.reset()` (guarded); python-side comms die with the session (fresh `e`/`_g` — but NOTE: `sys.modules`/`comm.create_comm` live in the PERSISTENT pyodide interpreter, so setup is once-per-page, while widget instances/comms are per-session — `reset()` must clear the JS registry so stale model ids can't render; a fresh run's new widgets re-open comms cleanly. Trace this split carefully; document in comments).

- [ ] Implement; pytest-side test for ipw_setup.py with stubbed `js`/`comm` modules (import works, publish_msg builds the right content dict, dispatch routes to a fake CommManager) — reuse the test_ui_module.py harness pattern.
- [ ] Commit `feat(ipw): python-side — BaseComm→JS-bro, dispatch inn, lazy install med pinnede versjoner`.

### Task 3: display integration — widget mimebundle → cell slot

**Files:** Modify `index.html` (exec core `_show_one` region + `buildOutputNodes` embed handler), `js/ipywidgets-bridge.js` if needed

- Exec core: in the display path (where `_show_one(_v)` decides), BEFORE generic repr: `if hasattr(_v, '_repr_mimebundle_')` → get bundle; if `application/vnd.jupyter.widget-view+json` in it → `print()` an embed marker (existing `__micro_transform_start_…` convention — add embedType `ipywidget` with payload = the mimebundle JSON). Respect the last-expression display policy (a widget as non-last bare expression in a notebook cell: hidden like other values — consistent).
- `buildOutputNodes`: new embed case `ipywidget` → placeholder div + async `IpwBridge.renderView(model_id, el)` (guarded: bridge absent → text fallback naming the model id).
- Interaction check: a widget assigned to a variable and displayed in one cell, mutated from another cell (`s.value = 7`) → frontend updates (traitlets → publish_msg → shim on_msg → model update). And frontend slider drag → python `s.value` reflects + `observe` handlers run (they execute OUTSIDE a captured run: stdout from callbacks goes to console — document as v1 behavior in the example).

- [ ] Implement; browser-verify the full loop (Task 5 does the exhaustive pass; here a smoke: IntSlider displays, drag updates python value — check via a follow-up cell).
- [ ] Commit `feat(ipw): display-integrasjon — widget-mimebundle → celle-slot via embed-markør`.

### Task 4: SW precache + offline story + example

**Files:** Modify `sw.js` (add the two pinned CDN URLs to PRECACHE/CDN handling per its existing conventions — READ the CACHE-bump comment at the top and bump if required), Create `examples/python/py_ipywidgets.txt` (+ manifest regen)

- Example: md intro (hva broen er, at `import ipywidgets` laster ~10 MB første gang, observe-callbacks: print går til konsollen i v1, interact/Output kommer senere), IntSlider + FloatSlider + Dropdown + observe demo (slider styrer en Label via observe), a cell reading `s.value` to show kernel-side sync.
- [ ] Implement; verify SW precache diff follows the file's own rules (CACHE version bump comment).
- [ ] Commit `feat(ipw): SW-precache av pinnede bundles + eksempel-notatbok`.

### Task 5: exit gate

- [ ] Suites: node (253+new/4), pytest (664+new), facades (478).
- [ ] Browser (Playwright, fresh port, generous pyodide+wheels wait; network required): (a) example via Examples menu: widgets render in their cells; slider drag → `observe`-driven Label updates live WITHOUT rerunning any cell; a later cell prints the dragged value (kernel sync). (b) `s.value = 9` from another cell → frontend slider moves. (c) Restart & kjør alle → clean rebuild, no stale-model errors. (d) Document switch (load another example) → IpwBridge.reset, no leakage. (e) A ui-track notebook (W1 example) unaffected; a plain script unaffected; a notebook WITHOUT ipywidgets never triggers install (network log). (f) Version-pin smoke: check the loaded bundle URL is the pinned one. (g) Both themes screenshot.
- [ ] Spec 2: mark W3 done in Phasing (with the v1-scope wording as corrected).
- [ ] Commit `docs+test(ipw): W3 exit gate`.
