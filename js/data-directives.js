// connect/load-direktiver for Web-modus (spec 5b/5c i
// docs/superpowers/specs/2026-07-03-web-data-svar-design.md, utvidet av
// docs/superpowers/specs/2026-07-05-encrypted-external-sources-design.md §1).
// Syntaksen er pythonsk siden 2026-07-27 (spec
// docs/superpowers/specs/2026-07-26-pythonsk-direktivsyntaks-design.md).
// Formen parses av js/directive-parser.js; denne fila gir den betydning:
//   # <alias> = ost.connect("<base-url|register-id|anvil-navn>", kind="…")
//   # <navn>  = ost.read("<url>", secret_key="…", exec="…", cache="…")
//   # <navn>  = <alias>.read("<sti|tabell>", years="…", countries=[…], …)
//   kind="csv|parquet|duckdb|sqlite|json" — eksplisitt kildetype, hopper over sniffing
//   duckdb/sqlite: <alias>.read("<tabell>") og <datasett>.add(<alias>, ["<kolonne>"], table="<tabell>")
//   (se docs/superpowers/specs/2026-07-06-remote-columnar-sources-design.md)
//   INGEN aliaser: load/import/create-dataset/require er borte, ikke stille
//   oversatt — gammel syntaks gir migrasjonshint (js/directive-parser.js:124).
// Ren parsing/resolusjon — ingen fetch her. Brukes av index.html
// (materialisering) og testes med deno via eval (data-directives.test.ts).
(function (global) {
  'use strict';

  // Project A (variable-level assembly): ost.create/add/join -> AssemblySpec.
  // See docs/superpowers/plans/2026-07-05-variable-level-assembly.md.
  // format="<navn>" (2026-07-24): lever datasettet direkte i valgt frameformat
  // uten konverteringslinje — data.table/tibble i R, pandas i python (polars
  // når wasm-bygget finnes). Ustøttede kombinasjoner feiler høyt ved binding.
  // Composite keys (spec 2026-07-24-pxweb-sources-design §1): key=["region",
  // "aar"] tar 1+ kolonner, likeså on=[…] på join. d.key og step.on er ALLTID
  // arrays (én streng pakkes).
  function isUrlish(target) {
    return /^https?:\/\//i.test(target) || target.indexOf('/api/hent?') === 0;
  }

  // Kanonisk → kildens egen spørremodell (spec §3). REGELEN (SDMX-fellen,
  // spec §0): et felt som ikke kan oversettes VERIFISERBART for kilden →
  // hard feil med kildens native alternativ — aldri stille passthrough
  // (2.1-API-ene svarer «vellykket» med ufiltrerte data). Ren funksjon:
  // -> { rest, params: [..], needsSdmxKey?, clientYears?, error? }
  function translateCanonical(kind, rest, c) {
    var params = [], out = { rest: rest, params: params };
    var y = c.years || null;
    // all() (spec 2026-07-26-all-direktiv-design): «last alle verdier av
    // uspesifiserte dimensjoner» er foreløpig kun implementert for pxweb
    // (json-stat2-metadata gjør ekspansjonen mekanisk verifiserbar der) —
    // én felles sjekk her dekker sdmx/worldbank/eurostat/dbnomics uten å
    // duplisere feilen i hver gren.
    if (c.all && kind !== 'pxweb') return { error: 'all() støttes foreløpig kun for pxweb-kilder — for andre kilder, angi utvalg eksplisitt' };
    if (kind === 'worldbank') {
      if (c.regions) return { error: 'regions() støttes ikke for worldbank — bruk landkoder i countries()' };
      if (c.indicators) {
        if (rest) return { error: 'både ressurssti og indicators() angitt — velg én form' };
        out.rest = 'country/' + (c.countries ? c.countries.join(';') : 'all') +
                   '/indicator/' + c.indicators.join(';');
      } else if (c.countries) {
        return { error: 'countries() uten indicators() for worldbank — angi indikatoren også, eller bygg stien selv (country/NOR/indicator/…)' };
      }
      // date=a:b — åpne ender fylles med 1900/2100 (probet 2026-07-25: WB
      // godtar fremtidsår og leverer t.o.m. siste tilgjengelige).
      if (y) params.push('date=' + (y.from || '1900') + ':' + (y.to || '2100'));
      Object.keys(c.filters || {}).forEach(function (k) { params.push(k + '=' + c.filters[k]); });
      return out;
    }
    if (kind === 'eurostat') {
      if (c.indicators) return { error: 'Eurostat har ikke et felles indikatorbegrep — bruk filters(na_item=…) e.l. for dette datasettet' };
      (c.countries || []).concat(c.regions || []).forEach(function (g) { params.push('geo=' + g); });
      if (y && y.from) params.push('sinceTimePeriod=' + y.from);
      if (y && y.to) params.push('untilTimePeriod=' + y.to);
      Object.keys(c.filters || {}).forEach(function (k) { params.push(k + '=' + c.filters[k]); });
      return out;
    }
    if (kind === 'pxweb') {
      if (c.all) out.all = true;   // lasteren (Task 3) ekspanderer uspesifiserte dimensjoner
      if (c.countries) return { error: 'countries() gjelder ikke pxweb-kilder (SSB er norske data) — bruk regions() eller filters(<variabel>=…)' };
      if (c.regions) params.push('valueCodes[Region]=' + c.regions.join(','));
      if (c.indicators) params.push('valueCodes[ContentsCode]=' + c.indicators.join(','));
      if (y) {
        if (y.from && y.to) {
          // range() finnes ikke i PxWeb v2 (probet 2026-07-25: 400) —
          // lukket intervall enumereres eksplisitt.
          var a = parseInt(y.from, 10), b = parseInt(y.to, 10);
          if (isNaN(a) || isNaN(b) || b < a || b - a > 500) return { error: 'years(' + y.from + ':' + y.to + '): kan ikke enumerere intervallet for pxweb — bruk filters(Tid=…)' };
          var aar = [];
          for (var yy = a; yy <= b; yy++) aar.push(String(yy));
          params.push('valueCodes[Tid]=' + aar.join(','));
        } else if (y.from) {
          params.push('valueCodes[Tid]=from(' + y.from + ')');   // probet ok 2026-07-25
        } else {
          return { error: 'years(:' + y.to + ') for pxweb: angi startår også — from()-uttrykket har ingen bakover-variant' };
        }
      }
      Object.keys(c.filters || {}).forEach(function (k) { params.push('valueCodes[' + k + ']=' + c.filters[k]); });
      return out;
    }
    if (kind === 'sdmx') {
      if (c.regions) return { error: 'regions() støttes ikke for sdmx-kilder — bruk countries() (REF_AREA) eller filters(<DIM>=…)' };
      if (y && y.from) params.push('startPeriod=' + y.from);
      if (y && y.to) params.push('endPeriod=' + y.to);
      if (c.countries || c.indicators || c.filters) {
        // Nøkkelen krever dimensjonsordenen — CSV-header-introspeksjon i
        // lastelaget (query-params ville blitt STILLE ignorert, spec §0).
        out.needsSdmxKey = { countries: c.countries || null, indicators: c.indicators || null, filters: c.filters || null };
      }
      return out;
    }
    if (kind === 'dbnomics') {
      if (c.countries || c.indicators || c.regions || c.filters) {
        return { error: 'countries()/indicators()/filters() støttes ikke for dbnomics — dimensjonene ligger i serie-masken i stien (f.eks. IMF/WEO:latest/NOR+SWE.NGDP_RPCH)' };
      }
      if (y) out.clientYears = { from: y.from, to: y.to };   // filtreres klient-side etter flatening
      return out;
    }
    return out;
  }

  // secret_key="<literal>" -> secret_key="***" før scriptet logges eller
  // sendes til AI. secret_key="ask" er ingen hemmelighet og beholdes.
  // secret_key= er ENTYDIG: ingen konstruksjon i python, R, SQL eller JS bruker
  // det ordet. Derfor trengs ingen kandidatheuristikk og ingen parse-status —
  // masker verdien uansett form, og la "ask" stå (den er ingen hemmelighet).
  // create(key=...) heter fortsatt `key` og er et KOLONNENAVN; den røres aldri,
  // fordi vi utelukkende ser etter `secret_key`.
  var SECRET_RE = /\b(secret_key[ \t]*=[ \t]*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,)\n]*)/gi;

  function count(s) { return (String(s).match(/\bsecret_key[ \t]*=/gi) || []).length; }

  function scrubKeys(script) {
    var lines = String(script == null ? '' : script).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var before = count(line);
      if (!before) continue;
      var out = line.replace(SECRET_RE, function (m, head, val) {
        var inner = /^["']/.test(val) ? val.replace(/^["']|["']$/g, '') : val;
        return inner === 'ask' ? m : head + '"***"';
      });
      // Ble en secret_key=-klausul SLUKT av en uavsluttet literal foran den?
      // Da gjemmer den hemmeligheten seg utenfor treffet — masker ut linja.
      if (count(out) < before) {
        var m2 = /\bsecret_key[ \t]*=/i.exec(out);
        out = out.slice(0, m2.index) + 'secret_key="***"';
      }
      lines[i] = out;
    }
    return lines.join('\n');
  }

  var CANON_KEYS = { years: 1, countries: 1, regions: 1, indicators: 1, filters: 1, all: 1 };
  // Kwarg-navn -> internt opts-felt. Hemmeligheten heter secret_key utad,
  // men beholder feltnavnet «key» innvendig, slik at resolve() forblir urørt.
  // `key` som kwarg er BORTE — det ordet betyr nå kun kolonnenavn i ost.create.
  // format= gjelder KUN federert read — håndheves i parse under.
  var PLAIN_KEYS = { secret_key: 'key', exec: 'exec', kind: 'kind', cache: 'cache', format: 'format' };
  var LOWER_KEYS = { exec: 1, kind: 1, cache: 1, format: 1 };

  // Ekte Levenshtein: posisjonssammenligning straffer innskudd for hardt og
  // ville foreslått «key» for «yers» (kortere navn vinner på lengdeleddet).
  function editDistance(a, b) {
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur[0] = i;
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
                          prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
      }
      prev = cur.slice();
    }
    return prev[b.length];
  }

  // LENGDENORMALISERT og case-ufølsom: rå avstand favoriserer systematisk
  // korte navn, så «yr» og «ctry» fikk forslaget «key» i stedet for
  // «years»/«countries».
  function suggest(name) {
    var all = Object.keys(PLAIN_KEYS).concat(Object.keys(CANON_KEYS));
    var low = String(name).toLowerCase(), best = null, bestD = 99;
    for (var i = 0; i < all.length; i++) {
      var d = editDistance(all[i], low) / Math.max(all[i].length, low.length);
      if (d < bestD) { bestD = d; best = all[i]; }
    }
    return bestD <= 0.7 ? best : null;
  }

  function asList(v) {
    if (v == null) return [];
    if (Object.prototype.toString.call(v) === '[object Array]') return v.map(String);
    return String(v).split(/[\s,]+/).filter(Boolean);
  }

  // kwargs -> dagens options-form (uendret for resolve()).
  function optionsFromKwargs(kwargs, errors, lineNo) {
    var opts = {}, canonical = null;
    function canon() { return (canonical = canonical || (opts.canonical = {})); }
    Object.keys(kwargs || {}).forEach(function (name) {
      var v = kwargs[name];
      if (PLAIN_KEYS[name]) {
        opts[PLAIN_KEYS[name]] = LOWER_KEYS[name] ? String(v).toLowerCase() : String(v);
        return;
      }
      if (name === 'years') {
        // Spec §5.4: tall er en feil, ikke noe å coerce. years=2020 i stedet
        // for years="2020:2024" ville stille gitt ett år i stedet for fem.
        if (typeof v !== 'string') {
          errors.push('linje ' + lineNo + ': «years» må være streng, fikk ' +
                      (typeof v === 'number' ? 'tall' : typeof v) +
                      ' — skriv years="2020:2024"');
          return;
        }
        var parts = String(v).split(':');
        canon().years = { from: (parts[0] || '').trim() || null,
                          to: parts.length > 1 ? ((parts[1] || '').trim() || null)
                                               : ((parts[0] || '').trim() || null) };
        return;
      }
      if (name === 'countries' || name === 'regions' || name === 'indicators') {
        canon()[name] = asList(v); return;
      }
      if (name === 'filters') {
        if (typeof v !== 'object' || v === null || Object.prototype.toString.call(v) === '[object Array]') {
          errors.push('linje ' + lineNo + ': «filters» må være en dict — filters={"k": "v"}');
          return;
        }
        canon().filters = v; return;
      }
      if (name === 'all') { if (v) canon().all = true; return; }
      var s = suggest(name);
      errors.push('linje ' + lineNo + ': ukjent argument «' + name + '»' +
                  (s ? ' — mente du «' + s + '»?' : ''));
    });
    return opts;
  }

  // Direktivstyrte strenger blir dynamiske nøkler. Uten vern lar
  // «#meta.__proto__.title = "x"» seg skrive rett inn i Object.prototype,
  // globalt for resten av økten (verifisert). Og prototypemedlemmer som
  // «constructor» ville blitt feilklassifisert som kjente nøkler.
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function unsafeName(n) { return n === '__proto__' || n === 'constructor' || n === 'prototype'; }

  // Spec §3.3: «=» betyr OVERSKRIV, «+=» betyr FØYD TIL (2026-07-27). Uten
  // dropPrevious akkumulerer gjentatte tilordninger som i gammel syntaks —
  // to «publisher»-rader i sidepanelet. Returnerer antall fjernede: gjentatt
  // «=» på note/link varsler (før migreringen akkumulerte de, så vanen
  // sitter, og tapet er brukerens egen tekst — aldri stille).
  function dropPrevious(metas, target, variable, kind, field) {
    var n = 0;
    for (var i = metas.length - 1; i >= 0; i--) {
      var m = metas[i];
      if (m.target === target && m.variable === variable && m.kind === kind &&
          (kind !== 'field' || m.field === field)) { metas.splice(i, 1); n++; }
    }
    return n;
  }

  var DS_KEYS = { title: 1, note: 1, link: 1, labels: 1 };
  var VAR_KEYS = { label: 1, note: 1, link: 1 };

  function isArr(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

  // Lenker, entydig på type — ingen gjetting:
  //   streng  -> én lenke uten etikett
  //   liste   -> flere lenker uten etikett
  //   dict    -> URL: etikett
  // Tuppelformen ("url", "etikett") er BEVISST droppet: parseren
  // representerer (…) og […] likt, så ("a","b") og ["a","b"] var umulige å
  // skille — «to lenker» ble stille til «én lenke med etikett».
  function toLinks(v) {
    if (typeof v === 'string') return v ? [{ url: v }] : [];
    if (isArr(v)) {
      var out = [];
      for (var i = 0; i < v.length; i++) {
        if (typeof v[i] === 'string' && v[i]) out.push({ url: v[i] });
      }
      return out;
    }
    if (v && typeof v === 'object') {
      return Object.keys(v).map(function (u) {
        var label = String(v[u] == null ? '' : v[u]);
        return label ? { url: u, label: label } : { url: u };
      });
    }
    return [];
  }

  // Notater, symmetrisk med lenker (streng = ett, liste = flere). Listeformen
  // er ikke pynt: uten den overlever ikke to notater på samme mål migreringen
  // fra gammel syntaks. Der AKKUMULERTE gjentatte «# meta iris …»-linjer; her
  // fjerner dropPrevious den forrige, så «# meta.iris.note» skrevet to ganger
  // ville mistet det første notatet i stillhet.
  // -> [tekst, …], eller null når verdien ikke er tekst (kalleren feiler).
  function toTexts(v) {
    if (typeof v === 'string') return v ? [v] : [];
    if (isArr(v)) {
      var out = [];
      for (var i = 0; i < v.length; i++) {
        if (typeof v[i] !== 'string') return null;
        if (v[i]) out.push(v[i]);
      }
      return out;
    }
    return null;
  }

  function collectMeta(item, metas, errors, warnings) {
    var p = item.path, raw = item.raw, ln = item.lineNo;
    var augment = !!item.augment;
    if (p.length < 2) {
      errors.push('linje ' + ln + ': meta krever datasett og nøkkel — «# meta.<datasett>.note = …»');
      return;
    }
    var ds = p[0], k1 = p[1], v = item.value;
    for (var pi = 0; pi < p.length; pi++) {
      if (unsafeName(p[pi])) {
        errors.push('linje ' + ln + ': «' + p[pi] + '» kan ikke brukes som navn i meta');
        return;
      }
    }

    // += gir bare mening for de akkumulerende nøklene. På enkeltverdinøkler
    // (title/label/felt) ville den enten vært et synonym for = eller en
    // strengkonkatenering ingen ba om — begge stille overraskende.
    function rejectAugment(key) {
      if (!augment) return false;
      errors.push('linje ' + ln + ': «+=» støttes bare for note og link — «' + key + '» settes med =');
      return true;
    }

    // Overskriving med = er lov (spec §3.3) men aldri stille: før migreringen
    // AKKUMULERTE gjentatte meta-linjer, så vanen sitter.
    function warnOverwrite(what, variable) {
      var target = variable ? ds + '.' + variable : ds;
      (warnings || []).push('linje ' + ln + ': ' + what + ' for «' + target +
                            '» overskriver en tidligere — bruk «+=» for å beholde begge');
    }

    function pushLinks(variable, val) {
      var ls = toLinks(val);
      if (!ls.length) { errors.push('linje ' + ln + ': «link» må være en URL, en liste av URL-er, eller en dict {url: etikett}'); return; }
      if (!augment && dropPrevious(metas, ds, variable, 'link')) warnOverwrite('link', variable);
      ls.forEach(function (l) {
        metas.push({ target: ds, variable: variable, kind: 'link',
                     url: l.url, label: l.label, text: undefined, line: raw });
      });
    }

    // Ett notat eller flere, på datasett- eller variabelnivå.
    function pushNotes(variable, val) {
      var ts = toTexts(val);
      if (!ts) { errors.push('linje ' + ln + ': «note» må være en tekst eller en liste av tekster'); return; }
      if (!augment && dropPrevious(metas, ds, variable, 'text')) warnOverwrite('note', variable);
      ts.forEach(function (t) {
        // url/label settes eksplisitt til undefined, symmetrisk med pushLinks'
        // «text: undefined». Formen er en dokumentert kontrakt (deno-testen
        // sammenligner hele objektet, og assertEquals skiller manglende nøkkel
        // fra undefined verdi) — ikke fjern dem fordi de «alltid er tomme».
        metas.push({ target: ds, variable: variable, kind: 'text', text: t,
                     url: undefined, label: undefined, line: raw });
      });
    }

    // Enkeltverdier: en liste eller dict her ville blitt «A,B» eller
    // «[object Object]» gjennom String() — stille søppel i sidepanelet.
    function textOrNull(val, key) {
      if (typeof val === 'string') return val;
      errors.push('linje ' + ln + ': «' + key + '» må være en tekst');
      return null;
    }

    // Datasettnivå (to ledd)
    if (p.length === 2) {
      if (k1 === 'link') { pushLinks(null, v); return; }
      if (k1 === 'title') {
        if (rejectAugment('title')) return;
        var ti = textOrNull(v, 'title'); if (ti === null) return;
        dropPrevious(metas, ds, null, 'title');
        metas.push({ target: ds, variable: null, kind: 'title', text: ti, line: raw });
        return;
      }
      if (k1 === 'note') { pushNotes(null, v); return; }
      if (k1 === 'labels') {
        if (rejectAugment('labels')) return;
        if (typeof v !== 'object' || v === null || isArr(v)) {
          errors.push('linje ' + ln + ': «labels» må være en dict — labels={"kolonne": "Etikett"}');
          return;
        }
        Object.keys(v).forEach(function (name) {
          if (unsafeName(name)) { errors.push('linje ' + ln + ': «' + name + '» kan ikke brukes som variabelnavn'); return; }
          var lb = textOrNull(v[name], 'labels.' + name); if (lb === null) return;
          dropPrevious(metas, ds, name, 'label');
          metas.push({ target: ds, variable: name, kind: 'label', text: lb, line: raw });
        });
        return;
      }
      if (rejectAugment(k1)) return;
      var fv = textOrNull(v, k1); if (fv === null) return;
      dropPrevious(metas, ds, null, 'field', k1);
      metas.push({ target: ds, variable: null, kind: 'field', field: k1, text: fv, line: raw });
      return;
    }

    // Tre ledd: variabelnivå — men en kjent datasettnøkkel her er en feil
    if (has(DS_KEYS, k1)) {
      errors.push('linje ' + ln + ': «' + k1 + '» tar en verdi, ikke en sti');
      return;
    }
    if (p.length > 3) { errors.push('linje ' + ln + ': for dyp meta-sti — «# meta.<datasett>.<variabel>.<nøkkel>»'); return; }
    var k2 = p[2];
    if (!has(VAR_KEYS, k2)) {
      errors.push('linje ' + ln + ': ukjent variabelnøkkel «' + k2 + '» — gyldige: label, note, link');
      return;
    }
    if (k2 === 'link') { pushLinks(k1, v); return; }
    if (k2 === 'note') { pushNotes(k1, v); return; }
    if (rejectAugment('label')) return;
    var lv = textOrNull(v, 'label'); if (lv === null) return;
    dropPrevious(metas, ds, k1, 'label');
    metas.push({ target: ds, variable: k1, kind: 'label', text: lv, line: raw });
  }

  function parse(script) {
    var connects = [], loads = [], metas = [], errors = [], warnings = [];
    var res = global.DirectiveParser.parseScript(script);
    errors = res.errors.slice();
    res.items.forEach(function (it) {
      if (it.form === 'ns') { collectMeta(it, metas, errors, warnings); return; }
      if (it.form !== 'call') return;
      // optionsFromKwargs kjenner BARE connect/read sine argumenter. Kjørt på
      // alle verb rapporterte den «ukjent argument «key»» for ost.create,
      // «table»/«how» for add og «on» for join — og portable-export.js kaster
      // på parse().errors, så en helt gyldig monteringsscript feilet eksporten
      // med «Direktivfeil: ukjent argument «key» — mente du «secret_key»?».
      // create/add/join eies av parseAssembly, use av parseUse; deres kwargs
      // valideres der.
      var isConnect = (it.recv === 'ost' && it.verb === 'connect');
      if (!isConnect && it.verb !== 'read') return;
      var opts = optionsFromKwargs(it.kwargs, errors, it.lineNo);

      // Stille dropp er forbudt: «ssb.read("05839", "Personer")» (glemt
      // indicators=) ville ellers gitt et ufiltrert read uten noe signal.
      // MEN vakten må skopes til verbene denne funksjonen eier: add() tar
      // legitimt TO posisjonsargumenter (add(<kilde>, ["<kolonne>"])), og en
      // blank sjekk her ville gitt falsk feil på gyldig Task 6-syntaks.
      function tooManyArgs() {
        if (it.args.length <= 1) return false;
        errors.push('linje ' + it.lineNo + ': ' + it.verb + ' tar ett posisjonsargument — ' +
                    'resten må være navngitte (f.eks. indicators=["Personer"])');
        return true;
      }

      if (it.recv === 'ost' && it.verb === 'connect') {
        if (tooManyArgs()) return;
        if (!it.target) { errors.push('linje ' + it.lineNo + ': ost.connect krever en tilordning — «# <alias> = ost.connect(…)»'); return; }
        if (typeof it.args[0] !== 'string') { errors.push('linje ' + it.lineNo + ': ost.connect krever et mål som streng'); return; }
        if (opts.format) { errors.push('linje ' + it.lineNo + ': format= støttes bare i federert read — ost.read([<url>, …], format="csv")'); return; }
        connects.push({ target: it.args[0], alias: it.target, options: opts });
        return;
      }
      if (it.verb === 'read') {
        if (tooManyArgs()) return;
        if (!it.target) { errors.push('linje ' + it.lineNo + ': read krever en tilordning — «# <navn> = …read(…)»'); return; }
        var tgt;
        if (it.recv === 'ost') {
          // Federert (spec 2026-07-31-federert-pull §3): liste/dict der én
          // URL ellers står = union av medlemmene.
          var fed = fedMembersFrom(it.args[0]);
          if (fed) {
            if (fed.error) { errors.push('linje ' + it.lineNo + ': ' + fed.error); return; }
            loads.push({ verb: 'read', target: null, members: fed.members, alias: it.target, options: opts, line: it.raw });
            return;
          }
          if (typeof it.args[0] !== 'string') { errors.push('linje ' + it.lineNo + ': ost.read krever en URL som streng'); return; }
          tgt = it.args[0];
        } else {
          tgt = it.args.length ? (it.recv + '/' + String(it.args[0])) : it.recv;
        }
        if (opts.format) { errors.push('linje ' + it.lineNo + ': format= støttes bare i federert read (liste/dict av medlemmer)'); return; }
        loads.push({ verb: 'read', target: tgt, alias: it.target, options: opts, line: it.raw });
        return;
      }
      // create/add/join/use håndteres av parseAssembly/parseUse (T6/T7).
    });
    return { connects: connects, loads: loads, metas: metas, errors: errors, warnings: warnings };
  }

  // Ett element på nøyaktig parse().loads[i]-form, bygget DIREKTE. Alternativet
  // — å skrive en direktivstreng og parse den tilbake — har dødd stille tre
  // ganger i denne omleggingen: strengen og grammatikken har ingen kobling, så
  // en syntaksendring gjør bare at ingenting matcher. Ingen feil, ingen data.
  // `line` er kun for feilmeldinger og logg; ingenting parser den igjen.
  function makeLoad(o) {
    var target = o.target || (o.table ? (o.source + '/' + o.table) : o.source);
    var line = o.table
      ? ('# ' + o.alias + ' = ' + o.source + '.read("' + o.table + '")')
      : ('# ' + o.alias + ' = ' + o.source + '.read()');
    return { verb: 'read', target: target, alias: o.alias, options: {}, line: line };
  }

  // __member-navn for liste-form (spec 2026-07-31-federert-pull §3): filnavn
  // uten endelse når alle er unike, ellers m1..mN (safestat-default).
  function memberIdsFor(urls) {
    var names = urls.map(function (u) {
      var path = String(u).split(/[?#]/)[0].replace(/\/+$/, '');
      var last = path.slice(path.lastIndexOf('/') + 1);
      return last.replace(/\.[A-Za-z0-9]+$/, '');
    });
    var seen = {};
    for (var i = 0; i < names.length; i++) {
      if (!names[i] || seen[names[i]]) return urls.map(function (_, j) { return 'm' + (j + 1); });
      seen[names[i]] = 1;
    }
    return names;
  }

  // Liste/dict-argument til ost.read -> {members:[{id,url}]} | {error} | null
  // (null = ikke federert form). Medlemmer må være URL-strenger — et bart ord
  // blir {__ref} i parseLiteral og er en skrivefeil, ikke en kilde.
  function fedMembersFrom(a0) {
    var isArr = Object.prototype.toString.call(a0) === '[object Array]';
    var isDict = !!a0 && typeof a0 === 'object' && !isArr && typeof a0.__ref !== 'string';
    if (!isArr && !isDict) return null;
    var ids = isArr ? null : Object.keys(a0);
    var vals = isArr ? a0 : ids.map(function (k) { return a0[k]; });
    if (!vals.length) return { error: 'federert read krever minst ett medlem i listen' };
    for (var i = 0; i < vals.length; i++) {
      if (typeof vals[i] !== 'string' || !vals[i]) {
        var hva = (vals[i] && typeof vals[i] === 'object' && typeof vals[i].__ref === 'string')
          ? '«' + vals[i].__ref + '» uten anførselstegn' : typeof vals[i];
        return { error: 'federert medlem #' + (i + 1) + ' må være en URL-streng (fikk ' + hva + ')' };
      }
    }
    if (isArr) ids = memberIdsFor(vals);
    return { members: vals.map(function (u, i) { return { id: ids[i], url: u }; }) };
  }

  // Register-definert federert kilde (spec §3): samme JSON-vokabular som
  // safestat. Node-/beskyttet-medlemmer hører hjemme i safestat — klar nekt.
  function federatedFromRegistry(alias, src, rest, opts) {
    function nekt(msg) { return { alias: alias, url: '', viaProxy: false, error: msg }; }
    var members = src.members || [];
    if (!members.length) return nekt('federert kilde «' + src.id + '» har ingen medlemmer');
    var out = [];
    for (var i = 0; i < members.length; i++) {
      var m = members[i];
      if (m.tier === 'node' || m.api) {
        return nekt('kilden «' + src.id + '» har node-medlemmer — compute-to-data krever safestat; openstat kjører kun pull+union');
      }
      if (m.level && m.level !== 'public') {
        return nekt('medlem «' + (m.id || 'm' + (i + 1)) + '» i «' + src.id + '» er merket «' + m.level + '» — beskyttede kilder hører hjemme i safestat');
      }
      if (m.kind === 'federated' || m.members) {
        return nekt('federert kilde «' + src.id + '» kan ikke ha federerte medlemmer');
      }
      var url = String(m.url || '');
      if (!url) return nekt('medlem «' + (m.id || 'm' + (i + 1)) + '» i «' + src.id + '» mangler url');
      // Medlems-url er URL også når den er relativ (safestats explicitUrl-
      // lærdom) — aldri register-oppslag på den.
      if (rest) url = url.replace(/\/+$/, '') + '/' + String(rest).replace(/^\/+/, '');
      out.push({ id: m.id || ('m' + (i + 1)), url: url, key: opts.key, format: opts.format,
                 viaProxy: !!m.auth || m.cors === false || !!src.auth || src.cors === false });
    }
    var item = { alias: alias, federated: out };
    if (src.overlap) item.overlap = src.overlap;
    if (src.entity) item.entity = src.entity;
    return item;
  }

  function findRegistrySource(registry, id) {
    if (!registry) return null;
    for (var i = 0; i < registry.length; i++) if (registry[i].id === id) return registry[i];
    return null;
  }

  // API-kinds (spec 2026-07-25-api-kinds-design §1): registeret kan bære kind
  // (`# connect worldbank` uten kind()), og kildenavn (oecd/ecb/norgesbank/
  // imf) normaliseres til protokoll-kind (sdmx) via ApiKinds når modulen er
  // lastet — brukeren kjenner kilden, ikke formatet.
  function normalizeKind(kind, src) {
    // ssb/scb har ALDRI hatt et «kind»-felt i data-sources.json (git-historikk
    // sjekket 2026-07-31) — bare tilgang: "pxweb". Kanonisk `<alias>.read(...)`
    // via registeret (resolve() uten eksplisitt kind()) har derfor ikke
    // fungert i dette repoet før nå: uten kind falt resolve() rett forbi
    // pxweb-grenen (years=/indicators=/regions=-oversettelse OG
    // tables/-sti-fiksen kjørte ALDRI), og URL-en ble base+id — 404. Det som
    // faktisk fungerte var den eldre connect-direkte-til-…/tables-URL-formen
    // (kind="pxweb" oppgitt eksplisitt i connect()), brukt i eldre
    // tester/eksempler. data-sources.json har nå kind: "pxweb" eksplisitt på
    // begge (samme som alle andre kilder), men behold denne avledningen som
    // sikkerhetsnett mot at feltet mangler igjen — KUN for
    // tilgang==="pxweb", ikke andre tilgang-verdier (de skal fortsatt gi
    // undefined og feile synlig et annet sted, ikke late som de er pxweb).
    var k = kind || (src && src.kind) || (src && src.tilgang === 'pxweb' ? 'pxweb' : undefined);
    var AKD = global.ApiKinds;
    return (k && AKD && AKD.kindAlias(k)) ? AKD.kindAlias(k) : k;
  }

  function resolve(parsed, registry) {
    var byAlias = {};
    parsed.connects.forEach(function (c) { byAlias[c.alias] = c; });
    return parsed.loads.map(function (l) {
      var lopts = l.options || {};
      if (l.members) {
        // Inline federert: medlemmene er eksplisitte URL-er (også relative).
        if (lopts.format && lopts.format !== 'csv' && lopts.format !== 'parquet') {
          return { alias: l.alias, url: '', viaProxy: false,
                   error: '«' + l.alias + '»: format «' + lopts.format + '» støttes ikke for federerte medlemmer (kun csv/parquet)' };
        }
        return { alias: l.alias, federated: l.members.map(function (m) {
          return { id: m.id, url: m.url, key: lopts.key, format: lopts.format };
        }) };
      }
      if (isUrlish(l.target)) {
        return { alias: l.alias, url: l.target,
                 viaProxy: l.target.indexOf('/api/hent?') === 0,
                 key: lopts.key, exec: lopts.exec, kind: normalizeKind(lopts.kind, null), cache: lopts.cache };
      }
      var slash = l.target.indexOf('/');
      var head = slash > 0 ? l.target.slice(0, slash) : l.target;
      var rest = slash > 0 ? l.target.slice(slash + 1) : '';
      var conn = byAlias[head];
      if (!conn) {
        var fsrc = findRegistrySource(registry, head);
        if (fsrc && (fsrc.kind === 'federated' || fsrc.members)) {
          return federatedFromRegistry(l.alias, fsrc, rest, { key: lopts.key, format: lopts.format });
        }
        return { alias: l.alias, url: '', viaProxy: false, error: 'ukjent kilde-alias «' + head + '» (mangler connect-linje?)' };
      }
      var copts = conn.options || {};
      var key = lopts.key || copts.key, exec = lopts.exec || copts.exec, kind = lopts.kind || copts.kind;
      var cache = lopts.cache || copts.cache;
      var base, viaProxy = false, src = null;
      if (isUrlish(conn.target)) {
        base = conn.target;
      } else {
        src = findRegistrySource(registry, conn.target);
        if (src && (src.kind === 'federated' || src.members)) {
          return federatedFromRegistry(l.alias, src, rest, { key: key, format: lopts.format });
        }
        if (!src) {
          // Ikke i web-registeret: en registrert Anvil-kilde (spec §1, regel 3).
          return { alias: l.alias, anvil: conn.target, key: key, exec: exec, kind: normalizeKind(kind, null) };
        }
        base = src.base_url;
        viaProxy = !!src.auth || src.cors === false;
      }
      kind = normalizeKind(kind, src);
      // pxweb (spec 2026-07-24-pxweb-sources-design §2) og api-kinds (spec
      // 2026-07-25-api-kinds-design §2): «stien» er tabell-id/ressurssti
      // (evt. med kildens query bak ?); lastelaget bygger data-URL-ene selv.
      if (kind === 'pxweb' || kind === 'eurostat' || kind === 'sdmx' || kind === 'dbnomics' || kind === 'worldbank') {
        // Kanonisk vokabular (spec §3): oversett FØR sti-kravet — worldbank
        // kan syntetisere stien fra indicators()/countries().
        var qi0 = rest.indexOf('?');
        var restPath = qi0 >= 0 ? rest.slice(0, qi0) : rest;
        var restQuery = qi0 >= 0 ? rest.slice(qi0 + 1) : '';
        var tr = null;
        if (lopts.canonical) {
          tr = translateCanonical(kind, restPath, lopts.canonical);
          if (tr.error) return { alias: l.alias, url: base, viaProxy: viaProxy, kind: kind,
                                 error: '«' + l.alias + '»: ' + tr.error };
          restPath = tr.rest;
          if (tr.params.length) restQuery = restQuery ? restQuery + '&' + tr.params.join('&') : tr.params.join('&');
        }
        if (!restPath) return { alias: l.alias, url: base, viaProxy: viaProxy, kind: kind,
          error: '«' + l.alias + '»: ' + kind + '-kilder krever en ressurssti — «# ' + l.alias + ' = ' + head + '.read("<sti>")» (f.eks. ' +
            (kind === 'worldbank' ? 'country/NOR/indicator/NY.GDP.MKTP.CD' :
             kind === 'dbnomics' ? 'IMF/WEO:latest/NOR.NGDP_RPCH' :
             kind === 'sdmx' ? 'EXR/D.USD.EUR.SP00.A' : '<tabellid>') + ')' };
        // pxweb v2: tabellressursen bor under tables/<id> — direktivstien er
        // bare tabell-id-en (regresjon fra v2-beta→v2-migreringen 2026-07-25:
        // base_url mistet tables/-segmentet; målt 404 uten, 200 med).
        // Normaliser også et eksplisitt «tables/<id>» fra brukeren. Kun når
        // base IKKE allerede ender på /tables — direkte connect() til en URL
        // som selv er tabell-kolleksjonen (utbredt i eksisterende skript/
        // tester) skal ikke få et doblet tables/tables/-segment.
        var tableForItem = restPath;
        if (kind === 'pxweb') {
          if (restPath.indexOf('tables/') === 0) restPath = restPath.slice(7);
          tableForItem = restPath;
          if (!/\/tables$/.test(base.replace(/\/+$/, ''))) restPath = 'tables/' + restPath;
        }
        if (base.charAt(base.length - 1) !== '/') base += '/';
        var item = { alias: l.alias, url: base + restPath + (restQuery ? '?' + restQuery : ''),
                     viaProxy: viaProxy, key: key, exec: exec, kind: kind,
                     cache: cache, table: tableForItem };
        if (tr && tr.needsSdmxKey) item.needsSdmxKey = tr.needsSdmxKey;
        if (tr && tr.clientYears) item.clientYears = tr.clientYears;
        if (tr && tr.all) item.all = true;
        return item;
      }
      // duckdb/sqlite: én fil, flere tabeller — "stien" er tabellnavnet, ikke
      // en URL-sti (spec 2026-07-06-remote-columnar-sources-design §1).
      if (kind === 'duckdb' || kind === 'sqlite') {
        if (!rest) return { alias: l.alias, url: base, viaProxy: viaProxy, kind: kind,
          error: '«' + l.alias + '»: duckdb/sqlite-kilder krever en tabell — «# ' + l.alias + ' = ' + head + '.read("<tabell>")»' };
        return { alias: l.alias, url: base, viaProxy: viaProxy, key: key, exec: exec, kind: kind, cache: cache, table: rest };
      }
      if (rest) {
        if (base.charAt(base.length - 1) !== '/') base += '/';
        base += rest;
      }
      return { alias: l.alias, url: base, viaProxy: viaProxy, key: key, exec: exec, kind: kind, cache: cache };
    });
  }

  // where/filter-uttrykk (spec 2026-07-29-row-filter-montering §3):
  // «kolonne op verdi (and …)*». Lukket grammatikk — or, parenteser,
  // aritmetikk og kolonne-mot-kolonne er høylytte feil, ikke stille
  // passthrough: uttrykket skal oversettes IDENTISK til SQL, pandas og R,
  // og alt de tre emitterne ikke kan garantere likt, avvises her.
  // Returnerer {conds:[{col,op,value}]} eller {error}.
  function parseWhereExpr(src) {
    var s = String(src == null ? '' : src), i = 0, conds = [];
    function ws() { while (i < s.length && (s.charAt(i) === ' ' || s.charAt(i) === '\t')) i++; }
    // \b er ASCII-only og ser en grense mellom «d» og «ø» — «andøy» ville
    // stille blitt lest som and + kolonnen «øy». Grensen må være unicode-
    // bevisst, som identifikator-regexen.
    function keyword(w) {
      if (s.slice(i, i + w.length) !== w) return false;
      var next = s.charAt(i + w.length);
      return !next || !/[\p{L}\p{N}_]/u.test(next);
    }
    function ident() {
      if (s.charAt(i) === '`') {
        var j = s.indexOf('`', i + 1);
        if (j < 0 || j === i + 1) return null;
        var name = s.slice(i + 1, j); i = j + 1;
        return name;
      }
      var m = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(s.slice(i));
      if (!m) return null;
      i += m[0].length;
      return m[0];
    }
    function literal() {
      var c = s.charAt(i);
      if (c === "'" || c === '"') {
        var j = s.indexOf(c, i + 1);
        if (j < 0) return { error: 'streng mangler avsluttende ' + c };
        var v = s.slice(i + 1, j); i = j + 1;
        return { value: v };
      }
      var m = /^-?\d+(?:\.\d+)?/.exec(s.slice(i));
      if (m) { i += m[0].length; return { value: parseFloat(m[0]) }; }
      return { error: 'forventet tall eller \'streng\' (kolonne-mot-kolonne støttes ikke)' };
    }
    for (;;) {
      ws();
      var col = ident();
      if (!col) return { error: 'forventet kolonnenavn (identifikator eller `backticks`), fikk «' + s.slice(i, i + 20) + '»' };
      ws();
      var op = null, two = s.slice(i, i + 2);
      if (two === '==' || two === '!=' || two === '<=' || two === '>=') { op = two; i += 2; }
      else if (s.charAt(i) === '<' || s.charAt(i) === '>') { op = s.charAt(i); i += 1; }
      else if (s.charAt(i) === '=') return { error: '«=» er ikke en sammenligning — mente du «==»?' };
      else if (keyword('in')) { op = 'in'; i += 2; }
      else return { error: 'ukjent operator ved «' + s.slice(i, i + 10) + '» — gyldige: == != < <= > >= in' };
      ws();
      var val;
      if (op === 'in') {
        if (s.charAt(i) !== '[') return { error: 'in krever en liste — in [verdi, verdi]' };
        i++;
        var list = [];
        for (;;) {
          ws();
          if (s.charAt(i) === ']') { i++; break; }
          var e = literal();
          if (e.error) return { error: e.error };
          list.push(e.value);
          ws();
          if (s.charAt(i) === ',') { i++; continue; }
          if (s.charAt(i) === ']') { i++; break; }
          return { error: 'forventet «,» eller «]» i in-listen' };
        }
        if (!list.length) return { error: 'in-listen er tom' };
        val = list;
      } else {
        var lit = literal();
        if (lit.error) return { error: lit.error };
        val = lit.value;
      }
      conds.push({ col: col, op: op, value: val });
      ws();
      if (i >= s.length) break;
      if (keyword('and')) { i += 3; continue; }
      if (keyword('or')) return { error: 'or støttes ikke (v1) — for flere verdier av samme kolonne, bruk in [..]' };
      return { error: 'uventet tekst: «' + s.slice(i) + '»' };
    }
    return { conds: conds };
  }

  // Montering: create/add/join + read-med-alias → mode-nøytral spec.
  function parseAssembly(script) {
    var errors = [], datasets = [];
    // Direktivstyrte navn blir objektnøkler. Uten null-prototype arver
    // «__proto__»/«constructor» sannhetsverdier: de kunne aldri opprettes
    // («allerede opprettet» på første linje), og sources['__proto__'] = true
    // er et stille no-op som bryter invarianten «hver step.source finnes i
    // spec.sources» — uten én eneste feilmelding.
    var byName = Object.create(null), sources = Object.create(null), sourceTables = Object.create(null);
    var res = global.DirectiveParser.parseScript(script);
    res.errors.forEach(function (e) { errors.push(e); });

    // parse() validerer BARE connect/read sine argumenter (den skopet seg til
    // dem i Task 8 fordi den ellers ropte «ukjent argument «key»» på en helt
    // gyldig ost.create). Da mistet create/add/join den tilfeldige dekningen de
    // hadde. Uten denne vakten er «add(py, ["a"], hwo="inner")» stille: steget
    // bygges med how="left", brukeren ba om inner, ingen sier fra.
    var ASM_KWARGS = { create: ['key', 'format'], add: ['table', 'how', 'where'], join: ['on', 'how'], filter: [] };
    function checkKwargs(it) {
      var ok = ASM_KWARGS[it.verb], bad = Object.keys(it.kwargs).filter(function (k) {
        return ok.indexOf(k) < 0;
      });
      if (!bad.length) return true;
      errors.push(ok.length
        ? 'linje ' + it.lineNo + ': ukjent argument «' + bad[0] + '» for ' + it.verb +
          ' — gyldige: ' + ok.join(', ')
        : 'linje ' + it.lineNo + ': ' + it.verb + ' tar ingen navngitte argumenter — fikk «' + bad[0] + '»');
      return false;
    }

    // how= er et lukket sett. «innner» eller «Inner » ville ellers falt til
    // left uten et ord — feil sammenslåing, riktig-utseende resultat.
    function checkHow(it) {
      if (!Object.prototype.hasOwnProperty.call(it.kwargs, 'how')) return 'left';
      var h = typeof it.kwargs.how === 'string' ? it.kwargs.how.toLowerCase() : null;
      if (h === 'left' || h === 'inner' || h === 'outer') return h;
      errors.push('linje ' + it.lineNo + ': how må være left, inner eller outer, fikk «' +
                  String(it.kwargs.how) + '»');
      return null;
    }

    function srcKey(alias, table) { return table ? (alias + '__' + table) : alias; }
    function noteSource(alias, table) {
      var k = srcKey(alias, table);
      sources[k] = true;
      if (table) sourceTables[k] = { source: alias, table: table };
      return k;
    }
    function names(v) {
      if (typeof v === 'string') return [v];
      if (Object.prototype.toString.call(v) === '[object Array]') {
        return v.filter(function (x) { return typeof x === 'string'; });
      }
      return [];
    }

    // Pass 1: create + read-med-alias definerer navn.
    res.items.forEach(function (it) {
      if (it.form !== 'call') return;
      if (it.recv === 'ost' && it.verb === 'create') {
        if (!it.target) { errors.push('linje ' + it.lineNo + ': ost.create krever en tilordning'); return; }
        if (byName[it.target]) { errors.push('datasettet «' + it.target + '» er allerede opprettet'); return; }
        if (!checkKwargs(it)) return;
        var key = names(it.kwargs.key);
        if (!key.length) { errors.push('linje ' + it.lineNo + ': ost.create krever key="<kolonne>" eller key=[…]'); return; }
        var d = { name: it.target, key: key,
                  format: it.kwargs.format ? String(it.kwargs.format).toLowerCase() : null, steps: [] };
        datasets.push(d); byName[it.target] = d;
        return;
      }
      // `x = <alias>.read("tabell")` er også en monteringskilde (gammel LOADAS).
      // URL-lesing (`ost.read`) er IKKE en monteringskilde — som før.
      if (it.verb === 'read' && it.recv !== 'ost' && it.target) {
        if (byName[it.target]) { errors.push('datasettet «' + it.target + '» er allerede opprettet'); return; }
        var table = it.args.length ? String(it.args[0]) : null;
        // Bare enkle tabellnavn deltar i montering (som LOADAS_RE før).
        if (table !== null && !/^[A-Za-z_]\w*$/.test(table)) return;
        var k = noteSource(it.recv, table);
        var dl = { name: it.target, load: k };
        datasets.push(dl); byName[it.target] = dl;
      }
    });

    // Pass 2-4: alle add FØR alle join FØR alle filter, uavhengig av
    // rekkefølgen i scriptet. (add/join-begrunnelsen står over; filter sist
    // er kontrakten fra spec 2026-07-29 §2 — filter gjelder det FERDIG
    // monterte datasettet.)
    ['add', 'join', 'filter'].forEach(function (pass) {
    res.items.forEach(function (it) {
      if (it.form !== 'call') return;
      if (it.verb !== 'add' && it.verb !== 'join' && it.verb !== 'filter') return;
      if (it.verb !== pass) return;
      // Stille dropp er forbudt: «# x = panel.add(...)» parser fint, men ville
      // ellers blitt kastet uten feilmelding.
      if (it.target) {
        errors.push('linje ' + it.lineNo + ': ' + it.verb + ' returnerer ingenting — skriv «# ' +
                    it.recv + '.' + it.verb + '(…)» uten tilordning');
        return;
      }
      var d = byName[it.recv];
      if (!d || d.load) { errors.push('linje ' + it.lineNo + ': ukjent datasett «' + it.recv + '» (mangler ost.create?)'); return; }
      if (!checkKwargs(it)) return;

      if (it.verb === 'filter') {
        if (it.args.length !== 1 || typeof it.args[0] !== 'string' || !it.args[0].length) {
          errors.push('linje ' + it.lineNo + ': filter krever et uttrykk — filter("kolonne > verdi")');
          return;
        }
        var pf = parseWhereExpr(it.args[0]);
        if (pf.error) { errors.push('linje ' + it.lineNo + ': ugyldig filter-uttrykk — ' + pf.error); return; }
        d.steps.push({ op: 'filter', where: pf.conds });
        return;
      }

      var how = checkHow(it);
      if (how === null) return;

      if (it.verb === 'add') {
        var ref = it.args[0];
        if (!ref || !ref.__ref) { errors.push('linje ' + it.lineNo + ': add krever en kilde som første argument — add(<kilde>, ["<kolonne>"])'); return; }
        // ÉN kolonneparameter, ikke varargs (spec §4.5(a)). Pakken har
        // signaturen add(source, columns, table=None, how=None), så
        // «add(p, "income", "edu")» ble der lest som table="edu" — «edu»
        // forsvant STILLE fra rammen mens editoren tok den med. Samme linje,
        // to svar; nettopp det kopier-og-lim-pariteten lover at ikke skjer.
        if (it.args.length > 2) {
          errors.push('linje ' + it.lineNo + ': add tar én kolonneparameter — samle dem i en liste: ' +
                      'add(' + ref.__ref + ', ["<kolonne>", "<kolonne>"])');
          return;
        }
        var cols = names(it.args[1]);
        if (!cols.length) { errors.push('linje ' + it.lineNo + ': add krever minst én kolonne'); return; }
        var tbl = it.kwargs.table ? String(it.kwargs.table) : null;
        var step = { op: 'import', source: noteSource(ref.__ref, tbl), columns: cols, how: how };
        if (Object.prototype.hasOwnProperty.call(it.kwargs, 'where')) {
          if (typeof it.kwargs.where !== 'string') {
            errors.push('linje ' + it.lineNo + ': where må være en streng — where="kolonne > verdi"');
            return;
          }
          var pw = parseWhereExpr(it.kwargs.where);
          if (pw.error) { errors.push('linje ' + it.lineNo + ': ugyldig where-uttrykk — ' + pw.error); return; }
          step.where = pw.conds;
        }
        d.steps.push(step);
        return;
      }
      var from = it.args[0];
      if (!from || !from.__ref) { errors.push('linje ' + it.lineNo + ': join krever et datasettnavn — join(<navn>, on="<kolonne>")'); return; }
      if (!byName[from.__ref]) { errors.push('linje ' + it.lineNo + ': ukjent datasett «' + from.__ref + '» i join'); return; }
      var on = names(it.kwargs.on);
      if (!on.length) { errors.push('linje ' + it.lineNo + ': join krever on="<kolonne>" eller on=[…]'); return; }
      d.steps.push({ op: 'join', from: from.__ref, on: on, how: how });
    });
    });

    return { spec: { sources: Object.keys(sources), datasets: datasets, sourceTables: sourceTables }, errors: errors };
  }

  // "# <navn> = ost.use("<navn>"[, source="r|python|duckdb"])" — kryssruntime-
  // kopi av et datasett (parquet-bro, kopisemantikk: endringer smitter ikke).
  // Ren parsing; overføringen gjøres av index.html i materialiseringsfasen.
  // source= er valgfri: uten den utleder parseSegmentUses() kilden fra
  // segmentrekkefølgen, og run-start-brukere som krever eksplisitt kilde
  // feiler med tydelig melding.
  // Omdøping (mine = ost.use("df")) er IKKE støttet — forbrukerne i
  // index.html leser u.name som navnet i BEGGE kjøretider.

  // Ingen oppslagsobjekter her: {r:1,python:1}["constructor"] er sann, og den
  // klassen kostet allerede fikserunder i Task 5 og 6.
  function isUseSource(s) { return s === 'r' || s === 'python' || s === 'duckdb'; }

  // Linjene DENNE funksjonen eier: gammel «# use …» og ny «# x = ost.use(…)».
  // Parserfeil på dem videresendes; alt annet er parse()/parseAssembly() sitt.
  // Uten første halvdel ville «# use df from python» blitt stille ignorert av
  // den nye grammatikken (ingen use, ingen feil, ingen kopi) — hard omlegging
  // betyr feilmelding. Uten andre halvdel ville en avvist ny-syntaks-linje
  // (f.eks. «__proto__=» som argumentnavn) lent seg på at en ANNEN kaller
  // rekker å rapportere den først.
  var USE_SHAPED_RE = /^[ \t]*(?:#|--|\/\/)[ \t]*(?:use\b|(?:[A-Za-z_]\w*[ \t]*=[ \t]*)?ost[ \t]*\.[ \t]*use\b)/i;

  // parseLiteral gir {__ref:"df"} for bare ord — «[object Object]» i en
  // feilmelding hjelper ingen.
  function showLit(v) {
    if (v && typeof v === 'object' && typeof v.__ref === 'string') return v.__ref;
    return String(v);
  }

  // Ett use-item fra et parsetre-element, eller null (+ feil i errors).
  function useFromItem(it, errors) {
    if (it.form !== 'call' || it.recv !== 'ost' || it.verb !== 'use') return null;
    if (it.args.length > 1) {
      errors.push('use tar ett posisjonsargument — kilden er navngitt: ost.use("' +
                  showLit(it.args[0]) + '", source="python")');
      return null;
    }
    var name = it.args[0];
    if (typeof name !== 'string' || !/^[A-Za-z_]\w*$/.test(name)) {
      errors.push('ugyldig datasettnavn i use: «' + showLit(name) + '» — navnet må være en streng: ost.use("df")');
      return null;
    }
    if (!it.target) { errors.push('use krever en tilordning — «# ' + name + ' = ost.use("' + name + '")»'); return null; }
    if (it.target !== name) {
      errors.push('omdøping i use er ikke støttet ennå — skriv «# ' + name + ' = ost.use("' + name + '")»');
      return null;
    }
    // Ukjent argument må ALDRI falle stille tilbake til inferens: «from=»
    // (den gamle vanen) ville da gitt en gjetning på feil kjøretid.
    var bad = Object.keys(it.kwargs).filter(function (k) { return k !== 'source'; });
    if (bad.length) {
      errors.push('use «' + name + '»: ukjent argument «' + bad[0] + '»' +
                  (bad[0] === 'from' ? ' — mente du «source»?' : ' — gyldige: source'));
      return null;
    }
    var from = null;
    if (Object.prototype.hasOwnProperty.call(it.kwargs, 'source')) {
      // typeof-vakten er ikke pedanteri: String(["python"]) === "python", så
      // uten den ville en liste blitt godtatt som streng.
      from = typeof it.kwargs.source === 'string' ? it.kwargs.source.toLowerCase() : null;
      if (!isUseSource(from)) {
        errors.push('use «' + name + '»: kilde må være r, python eller duckdb, fikk «' + showLit(it.kwargs.source) + '»');
        return null;
      }
    }
    return { name: name, from: from };
  }

  function parseUse(script) {
    var uses = [], errors = [];
    var lines = String(script == null ? '' : script).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var pl = global.DirectiveParser.parseLine(lines[i]);
      if (!pl) continue;
      if (pl.error) {
        if (USE_SHAPED_RE.test(lines[i])) errors.push('linje ' + (i + 1) + ': ' + pl.error);
        continue;
      }
      var u = useFromItem(pl, errors);
      if (u) uses.push(u);
    }
    return { uses: uses, errors: errors };
  }

  // Runtime-familie per segment-kind: microdata/pyodide deler Python-heapen
  // (use er aldri nødvendig dem imellom), duckdb og r er egne motorer.
  function runtimeFamily(kind) {
    if (kind === 'r') return 'r';
    if (kind === 'duckdb') return 'duckdb';
    return 'python';   // microdata, pyodide, ukjent → trygt valg
  }

  // Segmentnivå-use (plan 2026-07-11-segment-use-cross-runtime): trekk
  // use-linjene ut av hvert segment, utled manglende kilde som familien til
  // NÆRMESTE FOREGÅENDE segment med annen runtime enn blokken selv, og
  // returner segmentene med use-linjene tømt (de er metadata; «# use»
  // er ikke gyldig SQL, og i R/py ville de bare vært støy).
  // -> { segments: [{kind, text, uses: [{name, from}]}], errors: [...] }
  function parseSegmentUses(segments) {
    var out = [], errors = [];
    (segments || []).forEach(function (seg, i) {
      var fam = runtimeFamily(seg.kind);
      var uses = [];
      // Splitt med FANGET linjeskift. use-linja tømmes (''), den slettes ikke:
      // linjenummer og \r\n må stå urørt, for R/Python peker feilmeldinger
      // tilbake i brukerens editor. Den gamle replace()-veien gjorde det samme.
      var parts = String(seg.text || '').split(/(\r?\n)/);
      for (var p = 0; p < parts.length; p += 2) {
        var line = parts[p];
        var pl = global.DirectiveParser.parseLine(line);
        if (pl && pl.error) {
          // Bare use-formede linjer varsles: en prosakommentar som tilfeldigvis
          // trigger et migrasjonshint skal ikke stoppe kjøringen her.
          if (USE_SHAPED_RE.test(line)) errors.push(pl.error);
          continue;
        }
        if (!pl || pl.form !== 'call' || pl.recv !== 'ost' || pl.verb !== 'use') continue;
        parts[p] = '';
        var u = useFromItem(pl, errors);
        if (!u) continue;                      // feil er registrert; linja er tømt uansett
        if (u.from === null) {
          for (var j = i - 1; j >= 0; j--) {
            var pf = runtimeFamily((segments[j] || {}).kind);
            if (pf !== fam) { u.from = pf; break; }
          }
          if (u.from === null) {
            errors.push('use «' + u.name + '»: fant ingen tidligere blokk med annet språk å hente fra — angi kilden: # ' + u.name + ' = ost.use("' + u.name + '", source="python")');
            continue;
          }
        }
        if (u.from === fam) {
          errors.push('use «' + u.name + '» from ' + u.from + ': blokken kjører allerede i ' + u.from + ' — datasett derfra refereres direkte');
          continue;
        }
        uses.push(u);
      }
      out.push({ kind: seg.kind, text: parts.join(''), uses: uses });
    });
    return { segments: out, errors: errors };
  }


  // metaByTarget(script) -> {alias: {title?, text:[], links:[], fields:[], variables:{…}}}
  // Samme innhold som sidebaren viser (MetaInfo), formet for DataFrame.attrs['meta'].
  function metaByTarget(script) {
    var out = Object.create(null);
    var metas = parse(script).metas || [];
    function bucket(o, key) {
      if (!Object.prototype.hasOwnProperty.call(o, key)) o[key] = { text: [], links: [] };
      return o[key];
    }
    for (var i = 0; i < metas.length; i++) {
      var m = metas[i];
      if (!Object.prototype.hasOwnProperty.call(out, m.target)) {
        out[m.target] = { text: [], links: [], fields: [], variables: Object.create(null) };
      }
      var root = out[m.target];
      var dst = m.variable ? bucket(root.variables, m.variable) : root;
      if (m.kind === 'link') {
        dst.links.push(m.label ? { url: m.url, label: m.label } : { url: m.url });
      } else if (m.kind === 'title') {
        root.title = m.text;
      } else if (m.kind === 'label') {
        bucket(root.variables, m.variable).label = m.text;
      } else if (m.kind === 'field') {
        root.fields.push({ label: m.field, verdi: m.text });
      } else if (m.text) {
        dst.text.push(m.text);
      }
    }
    return out;
  }

  // Reeksportert fra DirectiveParser slik at kallsteder som bare har
  // DataDirectives (index.html, portable-export) slipper å rulle sin egen
  // verbliste — de listene sluttet å matche stille da grammatikken ble
  // pythonsk. Én kilde til sannhet: parsetreet.
  function isDirectiveLine(line) { return global.DirectiveParser.isDirectiveLine(line); }

  global.DataDirectives = { parse: parse, makeLoad: makeLoad, metaByTarget: metaByTarget, resolve: resolve, scrubKeys: scrubKeys, parseAssembly: parseAssembly, translateCanonical: translateCanonical, parseUse: parseUse, parseSegmentUses: parseSegmentUses, runtimeFamily: runtimeFamily, isDirectiveLine: isDirectiveLine, _parseWhereExpr: parseWhereExpr };
})(typeof window !== 'undefined' ? window : globalThis);
