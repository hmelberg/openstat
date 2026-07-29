// js/meta-info.js — MetaInfo: fletting av automatisk berikelse (apiMeta, fra
// /api/metadata e.l.) og brukerens `# meta`-direktiver (js/data-directives.js
// sitt `metas`-resultat) til én visningsform, pluss HTML-renderer.
// Spec: docs/superpowers/specs/2026-07-25-metadata-sidebar-design.md
//   §1 — MetaInfo-formen (tittel/beskrivelse/felter/lenker/variabler).
//   §2 — flettingsregelen: brukerens `# meta`-innhold vises ØVERST og
//        supplerer — overstyrer ALDRI stille kildens data (begge vises).
//   §7 — kommentarlenke-konvensjonen (GitHub Discussions-søk per mål).
// Ren logikk: ingen fetch, ingen DOM-tilgang, ingen andre globaler enn
// MetaInfo selv. Alle verdier escapes internt (esc()) — index.html kan sette
// innerHTML = MetaInfo.render(...) / renderVariable(...) trygt.
// Ingen norske UI-strenger hardkodes her: seksjonsoverskrifter og
// kommentarlenke-teksten injiseres via opts.labels — i18n skjer i
// index.html. Rene tall (variabel-antall, kodeliste-overflow) trenger ingen
// oversettelse og bygges direkte.
(function (global) {
  'use strict';

  var COMMENT_BASE = 'https://github.com/hmelberg/openstat-metadata/discussions?discussions_q=';
  var KODELISTE_CAP = 40;

  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // §7: samme mål-konvensjon som `# meta` (kilde/tabell eller
  // kilde/tabell.variabel) gir en deterministisk søkelenke i community-repoet.
  function commentUrl(target) {
    return COMMENT_BASE + encodeURIComponent(String(target || ''));
  }

  // sourcePageUrl(registerId, table) -> menneskesiden for tabellen hos kilden,
  // eller null. Kun kilder med DETERMINISTISK mal er med — en lenke som kan
  // treffe feil side skal heller mangle (statfin/fhi/scb/sdmx trenger
  // databasesti eller dimensjonskontekst som ikke ligger i tabell-id-en).
  function sourcePageUrl(registerId, table) {
    var id = String(registerId || '').toLowerCase();
    var tbl = String(table || '');
    var m;
    if (id === 'ssb' && /^\d+$/.test(tbl)) return 'https://www.ssb.no/statbank/table/' + tbl;
    if (id === 'dst' && /^[A-Za-z0-9]+$/.test(tbl)) return 'https://www.statistikbanken.dk/' + tbl;
    if (id === 'eurostat' && /^[A-Za-z0-9_]+$/.test(tbl)) {
      return 'https://ec.europa.eu/eurostat/databrowser/view/' + tbl + '/default/table';
    }
    if (id === 'worldbank') {
      // Stien er country/…/indicator/<kode>[;<kode>…] — lenk første indikator.
      m = tbl.match(/(?:^|\/)indicator\/([A-Za-z0-9._]+)/);
      return m ? 'https://data.worldbank.org/indicator/' + m[1] : null;
    }
    if (id === 'dbnomics') {
      // <provider>/<datasett>[:versjon][/<seriemaske>] -> provider/datasett.
      m = tbl.match(/^([^/:]+)\/([^/:]+)/);
      return m ? 'https://db.nomics.world/' + m[1] + '/' + m[2] : null;
    }
    return null;
  }

  // Direktiver mot ETT mål (datasett eller variabel): lenker, tittel,
  // variabeletiketter, felter og beskrivelsestekst i angitt rekkefølge
  // (§3: "gjentatte direktiver ... legges til, aldri overskriving").
  function collectDirectives(list) {
    var links = [], texts = [], fields = [], title, label;
    (list || []).forEach(function (m) {
      if (m.kind === 'link' && m.url) links.push({ label: m.label || m.url, url: m.url });
      else if (m.kind === 'text' && m.text) texts.push(m.text);
      else if (m.kind === 'title' && m.text) title = m.text;
      else if (m.kind === 'label' && m.text) label = m.text;
      else if (m.kind === 'field' && m.field && m.text) fields.push({ label: m.field, verdi: m.text });
    });
    return { links: links, text: texts.join('\n\n'),
             fields: fields, title: title, label: label };
  }

  // §2: brukerens tekst FØRST, kildens beholdt under — flat streng (MetaInfo-
  // formen har kun ett beskrivelse-felt) for eksterne konsumenter av
  // merge()/forVariable()s returverdi. render()/renderVariable() bruker i
  // stedet de usammenslåtte feltene (direktivBeskrivelse/autoBeskrivelse,
  // satt ved siden av) for å style dem ulikt (meta-info-user).
  function combineBeskrivelse(userText, apiText) {
    var parts = [];
    if (userText) parts.push(userText);
    if (apiText && apiText !== userText) parts.push(apiText);
    return parts.length ? parts.join('\n\n') : undefined;
  }

  // merge(apiMeta, metas, target) -> MetaInfo (spec §1), flettet per §2.
  // apiMeta kan være null (grasiøs degradering, spec §4: uten nett/endepunkt
  // vises bare direktiv-innhold + proveniens). Datasett-nivå: metas-
  // oppføringer med variable == null og target === target.
  function merge(apiMeta, metas, target) {
    var api = apiMeta || {};
    var list = (metas || []).filter(function (m) { return m.target === target && m.variable == null; });
    var d = collectDirectives(list);
    return {
      tittel: d.title || api.tittel || undefined,
      beskrivelse: combineBeskrivelse(d.text, api.beskrivelse),
      felter: d.fields.concat(api.felter || []),
      lenker: d.links.concat(api.lenker || []),
      variabler: (api.variabler || []).slice(),
      direktivBeskrivelse: d.text || undefined,
      autoBeskrivelse: api.beskrivelse || undefined,
      direktivLenker: d.links,
      autoLenker: (api.lenker || []).slice(),
      direktivTittel: d.title || undefined,
      autoTittel: api.tittel || undefined,
      direktivFelter: d.fields,
      autoFelter: (api.felter || []).slice()
    };
  }

  // forVariable(mi, metas, target, varName) -> {label, beskrivelse,
  // kodeliste, lenker, ...}. Slår sammen mi.variabler sin oppføring (satt av
  // merge() fra apiMeta) med variabel-nivå-direktivene for samme mål.
  function forVariable(mi, metas, target, varName) {
    var list = (metas || []).filter(function (m) { return m.target === target && m.variable === varName; });
    var d = collectDirectives(list);
    var apiVar = null;
    ((mi && mi.variabler) || []).some(function (item) {
      if (item.navn === varName) { apiVar = item; return true; }
      return false;
    });
    var api = apiVar || {};
    return {
      label: d.label || api.label || varName,
      beskrivelse: combineBeskrivelse(d.text, api.beskrivelse),
      kodeliste: api.kodeliste || undefined,
      lenker: d.links.concat(api.lenker || []),
      direktivBeskrivelse: d.text || undefined,
      autoBeskrivelse: api.beskrivelse || undefined,
      direktivLenker: d.links,
      autoLenker: (api.lenker || []).slice(),
      direktivLabel: d.label || undefined
    };
  }

  function splitParas(text) {
    return String(text).split(/\n{2,}/).map(function (p) {
      return '<p class="var-detail-prose">' + esc(p) + '</p>';
    }).join('');
  }

  // Lenkeliste: alle lenker (direktiv-lenker allerede først, satt av
  // merge()/forVariable()) + kommentarlenken sist, hvis et mål er oppgitt.
  function renderLenkeliste(lenker, opts) {
    var labels = (opts && opts.labels) || {};
    var items = (lenker || []).map(function (l) {
      return '<li><a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.label || l.url) + '</a></li>';
    });
    if (opts && opts.commentTarget) {
      items.push('<li><a href="' + esc(commentUrl(opts.commentTarget)) + '" target="_blank" rel="noopener">' + esc(labels.comment || '') + '</a></li>');
    }
    if (!items.length) return '';
    var heading = labels.links ? '<div class="var-detail-section-title">' + esc(labels.links) + '</div>' : '';
    return heading + '<ul class="meta-info-links">' + items.join('') + '</ul>';
  }

  // Kodeliste-tabell (§1: variabler[].kodeliste): cappet på 40 rader +
  // en overflow-rad. Overflow-etiketten bygges kun av tallet (data-more) —
  // modulen hardkoder ingen norsk UI-tekst; index.html kan style/oversette
  // via CSS/JS på klassen.
  function renderKodeliste(kodeliste) {
    var rows = kodeliste.slice(0, KODELISTE_CAP).map(function (c) {
      return '<tr><td>' + esc(c.kode) + '</td><td>' + esc(c.label) + '</td></tr>';
    }).join('');
    if (kodeliste.length > KODELISTE_CAP) {
      var extra = kodeliste.length - KODELISTE_CAP;
      rows += '<tr class="meta-info-kodeliste-more" data-more="' + extra + '"><td colspan="2">+' + esc(String(extra)) + '</td></tr>';
    }
    return '<table class="meta-info-kodeliste-table"><tbody>' + rows + '</tbody></table>';
  }

  // render(mi, opts) — datasett-/kilde-nivå container.
  // opts = {commentTarget, labels: {links, comment, fields}}.
  // Rekkefølge (§2): tittel, direktiv-beskrivelse (meta-info-user, øverst),
  // kildens beskrivelse, felter (<dl>), lenker (+kommentarlenke),
  // variabel-antall.
  function render(mi, opts) {
    mi = mi || {};
    opts = opts || {};
    var labels = opts.labels || {};
    var parts = [];
    if (mi.tittel) parts.push('<div class="var-detail-section-title">' + esc(mi.tittel) + '</div>');
    // §2-regelen gjelder også tittelen: brukerens vinner overskriften, men
    // kildens egen katalogtittel skal ikke forsvinne stille. Vises dempet
    // under, på samme måte som autoBeskrivelse.
    if (mi.direktivTittel && mi.autoTittel && mi.autoTittel !== mi.direktivTittel) {
      parts.push('<div class="var-detail-prose">' + esc(mi.autoTittel) + '</div>');
    }
    if (mi.direktivBeskrivelse) parts.push('<div class="meta-info-user">' + splitParas(mi.direktivBeskrivelse) + '</div>');
    if (mi.autoBeskrivelse) parts.push(splitParas(mi.autoBeskrivelse));
    if (mi.felter && mi.felter.length) {
      if (labels.fields) parts.push('<div class="var-detail-section-title">' + esc(labels.fields) + '</div>');
      parts.push('<dl class="var-detail-dl">' + mi.felter.map(function (f) {
        return '<dt>' + esc(f.label) + '</dt><dd>' + esc(f.verdi) + '</dd>';
      }).join('') + '</dl>');
    }
    parts.push(renderLenkeliste(mi.lenker, opts));
    if (mi.variabler && mi.variabler.length) {
      parts.push('<div class="meta-info-varcount" data-count="' + mi.variabler.length + '">' + esc(String(mi.variabler.length)) + '</div>');
    }
    return parts.join('');
  }

  // renderVariable(v, opts) — variabel-nivå container (forVariable()s
  // returverdi). Samme rekkefølge-prinsipp som render(), med kodeliste-
  // tabell i stedet for felter-<dl>.
  function renderVariable(v, opts) {
    v = v || {};
    opts = opts || {};
    var parts = [];
    if (v.label) parts.push('<div class="var-detail-section-title">' + esc(v.label) + '</div>');
    if (v.direktivBeskrivelse) parts.push('<div class="meta-info-user">' + splitParas(v.direktivBeskrivelse) + '</div>');
    if (v.autoBeskrivelse) parts.push(splitParas(v.autoBeskrivelse));
    if (v.kodeliste && v.kodeliste.length) parts.push(renderKodeliste(v.kodeliste));
    parts.push(renderLenkeliste(v.lenker, opts));
    return parts.join('');
  }

  global.MetaInfo = {
    merge: merge,
    forVariable: forVariable,
    render: render,
    renderVariable: renderVariable,
    commentUrl: commentUrl,
    sourcePageUrl: sourcePageUrl
  };
})(typeof window !== 'undefined' ? window : globalThis);
