/* ===================================================================
   svar-refs.js — ren referansekjerne + output-klassifiserer, portert
   VERBATIM (kommentarer inkludert) fra askstats js/ask-view.js. Bærer
   window-globalene js/ai-chat.js (askstat) forventer, slik at den fila
   kan kobles inn uendret i openstat (Task 4). Resolver/slots/ankre/KaTeX
   og planRefResolution porteres IKKE — se ask-view.js for den halvdelen.
   =================================================================== */
(function svarRefsModule() {

  // Dybde for /api/svar: 'standard' er default; velges på split-knappen.
  function coerceAskDepth(v) { return v === 'deep' ? 'deep' : 'standard'; }

  /* ── Output-referanser (spec 2026-07-31-ask-svar-referanser): svaret
     peker på levende output-noder. Ren halvdel her (node-testet);
     DOM-resolveren lenger ned. ─────────────────────────────────────── */
  var ASK_REF_LINE_RE = /^\{\{(fig|table|map|widget|html|controls):([1-9]\d*)\}\}$/;
  // kind (elementtype fra klassifisereren) → referanseklasse
  var KIND_TO_CLASS = {
    plotly: 'fig', png: 'fig', vegalite: 'fig',
    table: 'table', tabulator: 'table',
    map: 'map', widget: 'widget', html: 'html', controls: 'controls',
  };
  var REF_CLASSES = { fig: 1, table: 1, map: 1, widget: 1, html: 1, controls: 1 };

  // assignRefs(items): items er dokumentrekkefølgen av output-elementer —
  // {kind: 'plotly'} for et levende element, {anchor: 'fig:1'} for et
  // hjemreise-anker etter en utflyttet node. Ankre OPPTAR nummeret sitt
  // (utflyttede noder beholder referansen på tvers av delvise
  // re-rendringer) uten selv å bli med i resultatet.
  function assignRefs(items) {
    var counts = {};
    var out = [];
    (items || []).forEach(function (it, i) {
      if (it && it.anchor) {
        var parts = String(it.anchor).split(':');
        var n = parseInt(parts[1], 10);
        if (REF_CLASSES[parts[0]] && n > 0) {
          counts[parts[0]] = Math.max(counts[parts[0]] || 0, n);
        }
        return;
      }
      var cls = it && KIND_TO_CLASS[it.kind];
      if (!cls) return;
      counts[cls] = (counts[cls] || 0) + 1;
      out.push({ ref: cls + ':' + counts[cls], kind: it.kind, idx: i });
    });
    return out;
  }

  // OUTPUTS-linjen i run_code-resultatet (les i sammenheng med
  // svar-prompt.ts sin RUN-blokk — de forteller samme historie).
  function formatOutputsManifest(refs) {
    if (!refs || !refs.length) return '';
    return 'OUTPUTS: ' + refs.map(function (r) {
      return r.kind === r.ref.split(':')[0] ? r.ref : r.ref + ' (' + r.kind + ')';
    }).join(', ');
  }

  // stripRefs: plassholder-alene-linjer → «[fig 1]» (utklippstavle +
  // feilede kjøringer der ingen output finnes å peke på).
  function stripRefs(markdown) {
    return String(markdown == null ? '' : markdown).split('\n').map(function (line) {
      var m = ASK_REF_LINE_RE.exec(line.trim());
      return m ? '[' + m[1] + ' ' + m[2] + ']' : line;
    }).join('\n');
  }

  // DOM-klassifisereren: wrapper-selektorene fra buildOutputNodes/mdRender*
  // (index.html). Rekkefølgen er også kind-prioritet ved treff.
  var ASK_OUT_SELECTORS = [
    ['.plotly-container', 'plotly'],
    ['img.output-matplotlib-img', 'png'],
    ['.vegalite-container', 'vegalite'],
    ['.tabulator-embed', 'tabulator'],
    ['.output-table-wrap', 'table'],
    ['.leafletmap-container', 'map'],
    ['.ipw-view', 'widget'],
    ['.output-html-embed', 'html'],
    ['.param-form', 'controls'],
    ['.ui-controls', 'controls'],
  ];
  var ASK_OUT_SELECTOR_ALL = ASK_OUT_SELECTORS.map(function (s) { return s[0]; }).join(', ');
  var ASK_SCAN_SELECTOR = ASK_OUT_SELECTOR_ALL + ', .ask-out-anchor';

  // mdClassifyAskOutput(container) → [{ref, kind, el}] i dokumentrekkefølge.
  // Nøstede treff (element inni et annet treff) hoppes over — wrapperen er
  // referansen. Ankre telles med i nummereringen (se assignRefs) men
  // returneres ikke.
  function classifyAskOutput(container) {
    if (!container || !container.querySelectorAll) return [];
    var els = Array.prototype.slice.call(container.querySelectorAll(ASK_SCAN_SELECTOR));
    els = els.filter(function (el) {
      return !(el.parentElement && el.parentElement.closest &&
               el.parentElement.closest(ASK_OUT_SELECTOR_ALL));
    });
    var items = els.map(function (el) {
      if (el.classList && el.classList.contains('ask-out-anchor')) {
        return { anchor: (el.dataset && el.dataset.ref) || '' };
      }
      for (var i = 0; i < ASK_OUT_SELECTORS.length; i++) {
        if (el.matches && el.matches(ASK_OUT_SELECTORS[i][0])) {
          return { kind: ASK_OUT_SELECTORS[i][1] };
        }
      }
      return {};
    });
    return assignRefs(items).map(function (r) {
      return { ref: r.ref, kind: r.kind, el: els[r.idx] };
    });
  }
  if (typeof window !== 'undefined') {
    window.mdClassifyAskOutput = classifyAskOutput;
    window.mdAskManifest = formatOutputsManifest;
    // AI-panelet (js/ai-chat.js) deler /api/svar men har ingen resolver —
    // stripRefs er dets eneste vei bort fra rå {{fig:1}}-tekst.
    window.mdAskStripRefs = stripRefs;
    window.mdCoerceAskDepth = coerceAskDepth;
  }

  // Node-testbar seam (samme mønster som js/ai-chat.js nederst).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      coerceAskDepth: coerceAskDepth,
      assignRefs: assignRefs,
      formatOutputsManifest: formatOutputsManifest,
      stripRefs: stripRefs,
      classifyAskOutput: classifyAskOutput,
    };
  }
})();
