/* dash.js — dash v2-motor (spec: docs/superpowers/specs/2026-07-11-dash-v2-design.md)
   Ren halvdel (øverst): mosaikk-parsing + auto-layout-plan. Node-testet, ingen DOM.
   DOM-halvdel (nederst): mount, kort, widgets, payload-rendering. Kun browser.
   Adaptere (brython/dash.py m.fl.) kaller det globale `Dash`-API-et; all data
   krysser grensen som JSON-strenger, pluss rå callbacks og DOM-noder. */
(function (global) {
  'use strict';
  var D = {};

  // ---------- ren halvdel ----------

  D.parseMosaic = function (str) {
    if (!str || !String(str).trim()) return { error: 'layout er tom' };
    var rows = String(str).split('\n')
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return l.length; })
      .map(function (l) { return l.split(/\s+/); });
    var cols = rows[0].length;
    if (cols > 12) return { error: 'layout: maks 12 kolonner, fikk ' + cols };
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].length !== cols) {
        return { error: 'layout linje ' + (i + 1) + ': ventet ' + cols +
                 ' navn, fikk ' + rows[i].length };
      }
    }
    var box = {};
    rows.forEach(function (row, r) {
      row.forEach(function (name, c) {
        if (name === '.') return;
        var b = box[name] || (box[name] = { r0: r, r1: r, c0: c, c1: c });
        if (r < b.r0) b.r0 = r; if (r > b.r1) b.r1 = r;
        if (c < b.c0) b.c0 = c; if (c > b.c1) b.c1 = c;
      });
    });
    for (var name in box) {
      var b = box[name];
      for (var r = b.r0; r <= b.r1; r++) {
        for (var c = b.c0; c <= b.c1; c++) {
          if (rows[r][c] !== name) {
            return { error: 'layout: omraadet "' + name +
                     '" er ikke rektangulaert (linje ' + (r + 1) + ')' };
          }
        }
      }
    }
    return {
      columns: cols,
      rows: rows.length,
      names: Object.keys(box),
      gridTemplateAreas: rows.map(function (row) {
        return '"' + row.join(' ') + '"';
      }).join(' ')
    };
  };

  D.autoSpan = function (kind, cols) {
    if (kind === 'number') return 3;
    if (kind === 'markdown' || kind === 'text') return 12;
    if (kind === 'table') return (cols && cols > 6) ? 12 : 6;
    return 6; // figure, image, node, error
  };

  D.autoOrder = function (kind) {
    return kind === 'number' ? 0 : 1;
  };

  // Number-payload v3 (spec 2026-07-12 §3.1): formatNumber/computeDelta er
  // FLYTTET til js/ui.js (dash-absorpsjon 5a Task 1 — Ui.formatNumber/
  // Ui.computeDelta, samme implementasjon, ingen gaffel). D.renderPayload
  // (DOM-halvdelen under) delegerer dit for kind 'number' → 'kpi'; widget-
  // avlesningen (fmtNumber, også under) gjør det samme.

  D.payloadCols = function (p) {
    if (!p) return 0;
    if (typeof p.cols === 'number') return p.cols;
    if (p.columns && p.columns.length) return p.columns.length;
    return 0;
  };

  // K2 (docs/superpowers/plans/2026-07-11-dash-v2-forbedringer.md): URL-state
  // {shared:{navn:råverdi}, cards:{"<n>":{navn:råverdi}}} <-> kompakt JSON i
  // base64url (uten padding). Rene funksjoner, ingen DOM — node-testet.
  function b64encode(str) {
    if (typeof Buffer !== 'undefined') return Buffer.from(str, 'utf8').toString('base64');
    return btoa(unescape(encodeURIComponent(str)));
  }
  function b64decode(str) {
    if (typeof Buffer !== 'undefined') return Buffer.from(str, 'base64').toString('utf8');
    return decodeURIComponent(escape(atob(str)));
  }

  D.encodeState = function (state) {
    try {
      var json = JSON.stringify(state);
      if (typeof json !== 'string') return null;
      var b64 = b64encode(json);
      return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    } catch (e) { return null; }
  };

  D.decodeState = function (str) {
    if (typeof str !== 'string' || !str) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(str)) return null;
    try {
      var b64 = str.replace(/-/g, '+').replace(/_/g, '/');
      var pad = b64.length % 4;
      if (pad) b64 += '===='.slice(pad);
      var json = b64decode(b64);
      var obj = JSON.parse(json);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
      return obj;
    } catch (e) { return null; }
  };

  // ---------- DOM-halvdel (kun browser) ----------
  var _seq = 0;
  var _dashes = {};  // dashId -> {root, grid, overflow, mosaic, used:{}}
  var _cards = {};   // cardId -> {node, content, placed, figEl}

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(null, args); }, ms);
    };
  }

  // Widget-avlesning (slider/play-verdi) — delegerer til Ui.formatNumber
  // (dash-absorpsjon 5a Task 1: flyttet dit, se kommentaren ved D.payloadCols
  // over). Ui.js er alltid lastet i praksis (index.html laster begge
  // scriptene), men en forsiktig fallback (samme still-aldri-kaste-stil som
  // resten av fila) dekker en teoretisk lastefeil.
  function fmtNumber(v) {
    return (global.Ui && typeof global.Ui.formatNumber === 'function')
      ? global.Ui.formatNumber(v) : String(v);
  }

  // ---- K2: URL-state (ds) — module-lokal, lazy fra window.__DASH_DS_INIT__
  // (satt av index.html sin tidlige hash-stripping, se der for hvorfor) ----
  var _dsState = null;

  function getDsState() {
    if (_dsState) return _dsState;
    var raw = (typeof window !== 'undefined') ? window.__DASH_DS_INIT__ : null;
    var decoded = raw ? D.decodeState(raw) : null;
    _dsState = (decoded && typeof decoded === 'object') ? decoded : {};
    if (!_dsState.shared || typeof _dsState.shared !== 'object') _dsState.shared = {};
    if (!_dsState.cards || typeof _dsState.cards !== 'object') _dsState.cards = {};
    return _dsState;
  }

  function dsBucket(dsPath) {
    var state = getDsState();
    if (dsPath[0] === 'shared') return state.shared;
    if (!state.cards[dsPath[1]]) state.cards[dsPath[1]] = {};
    return state.cards[dsPath[1]];
  }

  function writeDsUrl() {
    if (typeof location === 'undefined' || typeof history === 'undefined') return;
    var encoded = D.encodeState(getDsState());
    var h = String(location.hash || '');
    if (h.charAt(0) === '#') h = h.slice(1);
    h = h.replace(/;ds=[A-Za-z0-9_-]*$/, '');
    var next = h + (encoded ? ';ds=' + encoded : '');
    var url = location.pathname + location.search + (next ? '#' + next : '');
    try { history.replaceState(null, '', url); } catch (e) { /* ignore */ }
  }

  // Tema-observeren (font.color-relayout på temabytte) og selve
  // figur/tekst/tabell/kpi/markdown/image-rendringen er FLYTTET til
  // js/ui.js (dash-absorpsjon 5a Task 1 — Ui.renderPayload +
  // Ui sin egen body[data-theme]-MutationObserver, se der). D.renderPayload
  // under er nå en TYNN delegat: kind 'node' er dash-only (rå DOM-node fra
  // adapteren, ingen rendring involvert) og 'number' mappes til Ui sin
  // 'kpi' — alt annet (markdown/text/table/image/figure/error) sendes
  // videre UENDRET, siden Ui.renderPayload sitt vokabular allerede dekker
  // dem (feltnavnene stemmer overens — Ui sin 'error'-gren aksepterer BÅDE
  // p.text og dash sin p.message).
  D.renderPayload = function (p, nodeEl) {
    var kind = p && p.kind;
    if (kind === 'node') return nodeEl;
    if (!global.Ui || typeof global.Ui.renderPayload !== 'function') {
      // Skal aldri skje i praksis (index.html laster js/ui.js), men kaster
      // aldri — samme forsiktige stil som resten av fila.
      return el('pre', null, 'Ui.renderPayload mangler');
    }
    var mapped = (kind === 'number') ? Object.assign({}, p, { kind: 'kpi' }) : p;
    // wegwerp-beholder: Ui.renderPayload legger nøyaktig én rot-node i den
    // (append-kontrakten, se js/ui.js) — vi plukker den ut igjen slik at
    // D.updateCard sin egen appendChild (uendret) kan flytte den inn i
    // kortet, akkurat som før delegeringen (samme "detached node"-kontrakt).
    var host = el('div');
    global.Ui.renderPayload(mapped, host);
    // Ui.renderPayload sitt vokabular dekker alt dash sender (kind 'kpi' er
    // mappingen over, resten er uendret navn) — host.firstChild finnes i
    // praksis alltid. En sann ukjent kind (adapter-bug/fremtidig kind Ui
    // ikke kjenner) → Ui.renderPayload varsler og lar host stå tom; D sin
    // egen appendChild-kaller (D.updateCard) forventer ALLTID en node å
    // sette inn — samme "kaster aldri, viser i stedet"-garanti som resten
    // av fila, derfor en lokal fallback her i stedet for å la det krasje.
    return host.firstChild || el('pre', null, JSON.stringify(p));
  };

  // override: gjenopprettet råverdi fra K2 ds-state (eller undefined) — DOM
  // settes FØR `initial` beregnes, slik at initial alltid gjenspeiler det som
  // faktisk står i DOM-elementet (spec.default eller override).
  function buildControl(spec, report, override) {
    var wrap = el('label', 'dash-widget');
    wrap.appendChild(el('span', 'dash-widget-label', spec.label || spec.name));
    var input, initial;
    if (spec.type === 'slider') {
      input = el('input');
      input.type = 'range';
      input.min = spec.min; input.max = spec.max;
      if (spec.step != null) input.step = spec.step;
      input.value = (override != null) ? override : spec.default;
      initial = Number(input.value);
      var out = el('span', 'dash-widget-value', fmtNumber(initial));
      input.addEventListener('input', function () {
        out.textContent = fmtNumber(Number(input.value));
        report(spec.name, Number(input.value));
      });
      wrap.appendChild(input);
      wrap.appendChild(out);
    } else if (spec.type === 'dropdown') {
      input = el('select');
      (spec.options || []).forEach(function (o) {
        input.appendChild(el('option', null, o));
      });
      var idx = (override != null) ? override : (spec.index || 0);
      // Clamp ds-override index to valid range
      if (idx < 0 || idx >= (spec.options || []).length) {
        idx = spec.index || 0;
      }
      input.selectedIndex = idx;
      initial = idx;
      input.addEventListener('change', function () {
        report(spec.name, input.selectedIndex);
      });
      wrap.appendChild(input);
    } else if (spec.type === 'checkbox') {
      input = el('input');
      input.type = 'checkbox';
      input.checked = (override != null) ? !!override : !!spec.default;
      initial = input.checked;
      input.addEventListener('change', function () {
        report(spec.name, input.checked);
      });
      wrap.classList.add('dash-widget--check');
      wrap.insertBefore(input, wrap.firstChild);
    } else if (spec.type === 'numberfield') {
      input = el('input');
      input.type = 'number';
      if (spec.min != null) input.min = spec.min;
      if (spec.max != null) input.max = spec.max;
      if (spec.step != null) input.step = spec.step;
      input.value = (override != null) ? override : spec.default;
      initial = Number(input.value);
      input.addEventListener('change', function () {
        report(spec.name, Number(input.value));
      });
      wrap.appendChild(input);
    } else if (spec.type === 'play') {
      // K3: slider + play/pause-knapp. Verdien øker med step per tick
      // (interval ms, min 200); ved max: stopp, eller hopp til min ved loop.
      // Timeren ryddes ved pause, manuell slider-endring, og — sjekket i
      // selve tick-en — når input-elementet er koblet fra DOM-et.
      input = el('input');
      input.type = 'range';
      input.min = spec.min; input.max = spec.max;
      if (spec.step != null) input.step = spec.step;
      var playDefault = spec.default != null ? spec.default : spec.min;
      input.value = (override != null) ? override : playDefault;
      initial = Number(input.value);
      var pout = el('span', 'dash-widget-value', fmtNumber(initial));
      var btn = el('button', 'dash-play-btn', '▶');
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Spill av');
      var stepVal = spec.step != null ? Number(spec.step) : 1;
      var minVal = Number(spec.min), maxVal = Number(spec.max);
      var timer = null;
      function stopPlay() {
        if (timer) { clearInterval(timer); timer = null; }
        btn.textContent = '▶';
        btn.classList.remove('dash-play-btn--playing');
      }
      function tick() {
        if (!input.isConnected) { stopPlay(); return; }
        var v = Number(input.value) + stepVal;
        if (v > maxVal) {
          if (spec.loop) v = minVal;
          else { stopPlay(); return; }
        }
        input.value = v;
        pout.textContent = fmtNumber(v);
        report(spec.name, v);
      }
      function startPlay() {
        if (timer) return;
        var ms = Math.max(200, Number(spec.interval) || 600);
        btn.textContent = '⏸';
        btn.classList.add('dash-play-btn--playing');
        timer = setInterval(tick, ms);
      }
      btn.addEventListener('click', function () {
        if (timer) stopPlay(); else startPlay();
      });
      input.addEventListener('input', function () {
        stopPlay();
        pout.textContent = fmtNumber(Number(input.value));
        report(spec.name, Number(input.value));
      });
      wrap.appendChild(input);
      wrap.appendChild(pout);
      wrap.appendChild(btn);
    } else { // textfield
      input = el('input');
      input.type = 'text';
      input.value = (override != null) ? override : (spec.default != null ? spec.default : '');
      initial = String(input.value);
      input.addEventListener('change', function () {
        report(spec.name, input.value);
      });
      wrap.appendChild(input);
    }
    return { node: wrap, name: spec.name, initial: initial };
  }

  // dsPath: ['shared'] eller ['cards', '<n>'] — når satt, oppdaterer report()
  // ogsaa K2-tilstanden og skriver den (debounced sammen med onChange) til
  // location.hash sin ds-parameter. overrides: {navn: råverdi} fra ds-state,
  // brukt som gjenopprettede startverdier for widgetene.
  function buildControls(specs, onChange, cls, overrides, dsPath) {
    var bar = el('div', cls);
    var values = {};
    var fire = debounce(function () {
      if (dsPath) writeDsUrl();
      if (typeof onChange === 'function') onChange(JSON.stringify(values));
    }, 150);
    function report(name, value) {
      values[name] = value;
      if (dsPath) dsBucket(dsPath)[name] = value;
      fire();
    }
    specs.forEach(function (spec) {
      var override = overrides ? overrides[spec.name] : undefined;
      var c = buildControl(spec, report, override);
      values[c.name] = c.initial;
      bar.appendChild(c.node);
    });
    return { node: bar, values: values };
  }

  // Rydd registeret for oppforinger hvis DOM-rot er koblet fra (fase B2
  // Task 3: eksportert som egen D.sweepDisconnected() -- opprinnelig kun
  // en inline løkke i D.create nedenfor, kalt lazy ved neste dashboard().
  // Brukt to steder nå: (1) D.create sin egen lazy sweep (uendret, dekker
  // "vanlig R-/Kjør alle"-scriptet uten dashboard() kjørt etter et med"),
  // (2) index.html sin per-celle notatbok-kjøring (mdRunNotebookCell)
  // kaller den EKSPLISITT rett etter å ha tømt #outputArea, FØR cellens
  // kode kjører -- uten det EKSPLISITTE kallet ville en per-celle-rerun
  // av en dashboard()-celle som IKKE lager et nytt dashboard denne gangen
  // (f.eks. redigert bort) latt forrige runs registeroppføring henge igjen
  // til NESTE gang NOEN celle i dokumentet lager et dashboard (om noen
  // gang) -- se kommentaren ved kallstedet i index.html for hele analysen
  // (browser-verifisert: uten purge+sweep vokser #outputArea sine
  // `.dash`-noder ÉN per per-celle-rerun, siden roten aldri kobles fra).
  function sweepDisconnected() {
    for (var did in _dashes) {
      if (_dashes[did].root && !_dashes[did].root.isConnected) delete _dashes[did];
    }
    for (var cid in _cards) {
      if (_cards[cid].node && !_cards[cid].node.isConnected) delete _cards[cid];
    }
  }
  D.sweepDisconnected = sweepDisconnected;

  // Mount-rot (fase B2 Task 4b, oppdatert i widget-plassering-fasen):
  // dashbord i en notatbok-celle skal rendre INN i cellens EGEN
  // .nb-output-body (sluket ALL run-output skriver til, se js/cells.js sin
  // cellNode/renderCellResult), ikke #outputArea (som etter fase 4-
  // konvergeringen HOSTER selve doc-root'en -- #outputArea er ikke skjult;
  // .nb-hidden døde i 4a. Uten celleadressert kontekst havner mount-roten
  // der som før: enten via mountContainer sin ctx-routing, eller via
  // errorHost-fallback dersom ingen kontekst er satt). Merk: `.nb-output` er nå en
  // WRAPPER som også kan holde .param-form/.ui-controls-striper -- å montere
  // rett i `.nb-output` (som før) ville lagt dashboardroten som en tredje
  // stripe der, IKKE i sluket, og latt den forstyrres av widgets=left sin
  // rad-layout. window.mdUiRunCtx() (samme kontekst js/ui.js sin
  // Ui.registerControl leser, satt/nullstilt av de FIRE kjøre-brakettene i
  // index.html: Kjør alle-segmentløkka, mdRunNotebookCell sin enkelt-celle-
  // sti, og microdata-replay-løkka) er ikke-null NØYAKTIG mens en
  // celleadressert kjøring pågår -- inkludert MENS pyodide/dash.py sitt
  // Dash.__init__ kaller window.Dash.create() synkront, siden pyodide kjører
  // på hovedtråden. cellEl hentes FERSKT fra ctx (aldri cachet, samme F6-
  // forbehold som resten av notatbok-kjøringen). Fallback #outputArea
  // UENDRET (samme node/streng som før) når ctx mangler -- vanlig skript
  // uten notatbok, eller notatboken er inaktiv. MERK: R- (dash-webr.js:131)
  // og brython/micropython-veiene kaller OGSÅ D.create(), men deres
  // kjørestier setter aldri nbUiRunCtx — DET er invarianten som holder dem
  // på #outputArea, ikke hvem som kaller create. En fremtidig per-celle-
  // R-sti som setter ctx ville derfor omdirigere R-dash hit (bevisst urørt,
  // se Task B2-3-rapporten: en per-celle-trygg R-dash krever en egen
  // webR-registerrestrukturering, utenfor denne oppgavens omfang).
  function mountContainer() {
    var ctx = (typeof global.mdUiRunCtx === 'function') ? global.mdUiRunCtx() : null;
    var slot = (ctx && ctx.cellEl && typeof ctx.cellEl.querySelector === 'function')
      ? ctx.cellEl.querySelector('.nb-output-body') : null;
    if (slot) return slot;
    // ctx/slot-stien ga ingenting -- typisk en planavvik-kjøring (ctx.cellEl
    // null, eller cellen manglet .nb-output-body). Mens notatboken er aktiv
    // ligger #outputArea INNI .doc-root (Cells.active()), så et rått
    // #outputArea-mål her ville montert dashbordroten som en søskennode
    // VED SIDEN AV .doc-root i stedet for inni den (Task 3b-funnet). Bruk
    // Cells.errorHost() -- samme samle-slot (NB.trailing) som all annen
    // planavvik-output havner i -- før det rå #outputArea-fallbacket, som
    // forblir uendret for vanlig skript uten notatbok (Cells inaktiv/mangler).
    if (global.Cells && typeof global.Cells.active === 'function' && global.Cells.active()) {
      var host = global.Cells.errorHost();
      if (host) return host;
    }
    return document.getElementById('outputArea');
  }

  D.create = function (optsJson) {
    // Rydd registeret for stale oppforinger fra tidligere kjoringer for samme
    // rerun-syklus (outputArea.innerHTML = '' fjerner DOM-noder uten a rydde
    // _dashes/_cards, ellers vokser registeret ubegrenset og gamle Plotly-
    // instanser lekker). For notatbok-montering (over): js/cells.js sin
    // C.runCell purger cellens EGEN slot (gated på ".dash"-tilstedeværelse)
    // FØR rerun, av samme grunn -- se kommentaren der.
    sweepDisconnected();
    var opts = JSON.parse(optsJson || '{}');
    var container = mountContainer();
    var root = el('div', 'dash');
    if (opts.title) {
      var head = el('header', 'dash-header');
      head.appendChild(el('h1', 'dash-title', opts.title));
      root.appendChild(head);
    }
    var mosaic = null;
    if (opts.layout) {
      var m = D.parseMosaic(opts.layout);
      if (m.error) {
        // 'ui-error' — samme feilboks-styling som Ui.renderPayload sin
        // 'error'-payload (app.css), gjenbrukt her for et layout-parse-
        // avvik som aldri går via payload-vokabularet i det hele tatt.
        root.appendChild(el('div', 'ui-error', m.error));
      } else {
        mosaic = m;
      }
    }
    var grid = el('div', 'dash-grid');
    if (mosaic) {
      grid.style.gridTemplateAreas = mosaic.gridTemplateAreas;
      grid.style.gridTemplateColumns = 'repeat(' + mosaic.columns + ', 1fr)';
      grid.style.gridTemplateRows = 'repeat(' + mosaic.rows + ', minmax(96px, auto))';
    } else {
      grid.style.gridTemplateColumns = 'repeat(12, 1fr)';
    }
    root.appendChild(grid);
    container.appendChild(root);
    var id = 'dash' + (++_seq);
    _dashes[id] = { root: root, grid: grid, overflow: null, mosaic: mosaic, used: {},
                     controlCardSeq: 0, controlsBar: null, sharedValues: null };
    // Tema-observeren installeres nå av js/ui.js sin Ui.renderPayload selv,
    // FØRSTE gang en figur faktisk rendres (dash- eller ui-rendret — samme
    // observer, samme register, se kommentaren ved D.renderPayload over) —
    // ikke lenger noe eget kall her.
    return id;
  };

  function placeCard(dash, rec, kind, cols) {
    if (rec.placed) return;
    if (dash.mosaic) {
      var area = rec.area;
      if (!area) {
        area = dash.mosaic.names.find(function (n) { return !dash.used[n]; });
      } else if (dash.used[area]) {
        area = null;   // eksplisitt at= peker på et allerede brukt omraade -> overflow, ikke dobbel-tildeling
      }
      if (area && dash.mosaic.names.indexOf(area) !== -1) {
        dash.used[area] = true;
        rec.node.style.gridArea = area;
        dash.grid.appendChild(rec.node);
      } else {
        if (!dash.overflow) {
          dash.overflow = el('div', 'dash-grid dash-grid--overflow');
          dash.overflow.style.gridTemplateColumns = 'repeat(12, 1fr)';
          dash.root.appendChild(dash.overflow);
          if (rec.area) console.warn('dash: omraadet "' + rec.area +
            '" finnes ikke i layout eller er allerede brukt; kortet legges under gridet');
        }
        rec.node.style.gridColumn = 'span ' + D.autoSpan(kind, cols);
        dash.overflow.appendChild(rec.node);
      }
    } else {
      rec.node.style.gridColumn = 'span ' + D.autoSpan(kind, cols);
      rec.node.style.order = D.autoOrder(kind);
      dash.grid.appendChild(rec.node);
    }
    rec.placed = true;
  }

  D.addCard = function (dashId, optsJson, onChange, nodeEl) {
    var dash = _dashes[dashId];
    var opts = JSON.parse(optsJson || '{}');
    var card = el('section', 'dash-card');
    if (opts.title) card.appendChild(el('h3', 'dash-cardtitle', opts.title));
    var controlValues = null;
    if (opts.controls && opts.controls.length) {
      var n = String(dash.controlCardSeq++);
      var overrides = getDsState().cards[n] || {};
      var built = buildControls(opts.controls, onChange, 'dash-cardbar', overrides, ['cards', n]);
      card.appendChild(built.node);
      controlValues = built.values;
    }
    var content = el('div', 'dash-content');
    card.appendChild(content);
    var cardId = 'dashcard' + (++_seq);
    // provisional: kortet ble plassert foreløpig (som funksjonskort, uten
    // kjent kind) — updateCard flytter det til riktig span/order ved første
    // reelle payload (punkt 3), kun i auto-layout (mosaikk-plassering røres ikke).
    var rec = { node: card, content: content, placed: false, provisional: false,
                area: opts.area || null, dashId: dashId, controlValues: controlValues };
    _cards[cardId] = rec;
    if (opts.content) {
      D.updateCard(cardId, JSON.stringify(opts.content), nodeEl); // plasserer også
    } else {
      card.classList.add('dash-card--loading');
      rec.provisional = true;
      placeCard(dash, rec, 'figure', 0); // foreløpig plassering for funksjonskort
    }
    return cardId;
  };

  D.updateCard = function (cardId, payloadJson, nodeEl) {
    var rec = _cards[cardId];
    if (!rec) return;
    var p = JSON.parse(payloadJson);
    if (rec.figEl && global.Plotly) { try { global.Plotly.purge(rec.figEl); } catch (e) {} }
    rec.content.innerHTML = '';
    var node = D.renderPayload(p, nodeEl);
    rec.figEl = (p.kind === 'figure') ? node : null;
    rec.content.appendChild(node);
    rec.node.classList.remove('dash-card--loading');
    rec.node.classList.toggle('dash-card--error', p.kind === 'error');
    if (rec.dashId && !rec.placed) {
      placeCard(_dashes[rec.dashId], rec, p.kind, D.payloadCols(p));
    } else if (rec.provisional) {
      // Punkt 3: første reelle payload for et funksjonskort som ble
      // foreløpig plassert i auto-layout — oppdater span/order til faktisk kind.
      var dash = _dashes[rec.dashId];
      if (dash && !dash.mosaic) {
        rec.node.style.gridColumn = 'span ' + D.autoSpan(p.kind, D.payloadCols(p));
        rec.node.style.order = D.autoOrder(p.kind);
      }
      rec.provisional = false;
    }
  };

  D.addControls = function (dashId, specsJson, onChange) {
    var dash = _dashes[dashId];
    var specs = JSON.parse(specsJson || '[]');
    var overrides = getDsState().shared || {};
    var built = buildControls(specs, onChange, 'dash-controls', overrides, ['shared']);
    // Punkt 4: en ny addControls-samtale ERSTATTER eksisterende toppstripe.
    if (dash.controlsBar && dash.controlsBar.parentNode) {
      dash.controlsBar.parentNode.replaceChild(built.node, dash.controlsBar);
    } else {
      dash.root.insertBefore(built.node, dash.grid);
    }
    dash.controlsBar = built.node;
    dash.sharedValues = built.values;
  };

  // K2: {navn: råverdi} for et kort- eller dash-id sine effektive
  // startverdier (gjenopprettet fra ds, eller widgetenes defaults hvis ingen
  // ds-state) — python-adapteren kaller dette rett etter addCard/addControls.
  D.initialValues = function (id) {
    if (_cards[id]) return JSON.stringify(_cards[id].controlValues || {});
    if (_dashes[id]) return JSON.stringify(_dashes[id].sharedValues || {});
    return '{}';
  };

  // Async-runtimes (dash-webr): slå på loading-shimmer til neste updateCard.
  D.setBusy = function (cardId) {
    var rec = _cards[cardId];
    if (rec) rec.node.classList.add('dash-card--loading');
  };

  // Lever dashboardet fortsatt i DOM? (pyodide-adapteren rydder proxies
  // for døde dashboards ved neste dashboard()-kall.)
  D.isAlive = function (id) {
    var d = _dashes[id];
    return !!(d && d.root && d.root.isConnected);
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = D;
  global.Dash = D;
})(typeof window !== 'undefined' ? window : globalThis);
