// js/directive-parser.js — grammatikken for direktivlinjer.
// Ren: kjenner ikke kilder, registre, kinds eller URL-er — kun form.
// Spec: docs/superpowers/specs/2026-07-26-pythonsk-direktivsyntaks-design.md §5.
(function (global) {
  'use strict';

  var IDENT_RE = /^[A-Za-z_]\w*/;

  function skipWs(s, i) {
    while (i < s.length && (s.charAt(i) === ' ' || s.charAt(i) === '\t')) i++;
    return i;
  }

  function fail(msg) { throw new Error(msg); }

  // parseLiteral(s, i) -> {value, pos}
  function parseLiteral(s, i) {
    i = skipWs(s, i);
    if (i >= s.length) fail('mangler verdi');
    var c = s.charAt(i);

    if (c === '"' || c === "'") return parseString(s, i, c);
    if (c === '[') return parseSeq(s, i, ']');
    if (c === '(') return parseSeq(s, i, ')');
    if (c === '{') return parseDict(s, i);
    if (c === '-' || (c >= '0' && c <= '9')) return parseNumber(s, i);

    var m = IDENT_RE.exec(s.slice(i));
    if (m) {
      var word = m[0];
      if (word === 'True') return { value: true, pos: i + 4 };
      if (word === 'False') return { value: false, pos: i + 5 };
      if (word === 'None') return { value: null, pos: i + 4 };
      return { value: { __ref: word }, pos: i + word.length };
    }
    fail('uventet tegn «' + c + '»');
  }

  function parseString(s, i, quote) {
    var out = '', j = i + 1;
    while (j < s.length) {
      var ch = s.charAt(j);
      if (ch === '\\' && j + 1 < s.length) { out += s.charAt(j + 1); j += 2; continue; }
      if (ch === quote) return { value: out, pos: j + 1 };
      out += ch; j++;
    }
    fail('uavsluttet streng');
  }

  function parseNumber(s, i) {
    var m = /^-?\d+(?:\.\d+)?/.exec(s.slice(i));
    if (!m) fail('ugyldig tall');
    return { value: parseFloat(m[0]), pos: i + m[0].length };
  }

  function parseSeq(s, i, close) {
    var out = [], j = skipWs(s, i + 1);
    if (s.charAt(j) === close) return { value: out, pos: j + 1 };
    while (j < s.length) {
      var r = parseLiteral(s, j);
      out.push(r.value);
      j = skipWs(s, r.pos);
      if (s.charAt(j) === ',') { j = skipWs(s, j + 1); if (s.charAt(j) === close) return { value: out, pos: j + 1 }; continue; }
      if (s.charAt(j) === close) return { value: out, pos: j + 1 };
      fail('forventet «,» eller «' + close + '»');
    }
    fail('mangler «' + close + '»');
  }

  // «__proto__» er den ENE nøkkelen som er en aksessor på Object.prototype:
  // out['__proto__'] = v setter prototypen i stedet for å lage en egen
  // nøkkel, så verdien forsvinner STILLE og ingen Object.keys-basert vakt
  // nedstrøms ser den. «constructor» og resten er vanlige dataegenskaper som
  // skygges normalt. Vi avviser den i stedet for å gi alle dicter og
  // kwargs-objekter null-prototype: Object.create(null) ville fått String(v)
  // til å kaste hos hver forbruker som formaterer en verdi.
  function checkKey(k, what) {
    if (k === '__proto__') fail('«__proto__» kan ikke brukes som ' + what);
    return k;
  }

  function parseDict(s, i) {
    var out = {}, j = skipWs(s, i + 1);
    if (s.charAt(j) === '}') return { value: out, pos: j + 1 };
    while (j < s.length) {
      var k = parseLiteral(s, j);
      if (typeof k.value !== 'string') fail('dict-nøkkel må være streng');
      checkKey(k.value, 'dict-nøkkel');
      j = skipWs(s, k.pos);
      if (s.charAt(j) !== ':') fail('forventet «:» etter dict-nøkkel');
      var v = parseLiteral(s, j + 1);
      out[k.value] = v.value;
      j = skipWs(s, v.pos);
      if (s.charAt(j) === ',') { j = skipWs(s, j + 1); if (s.charAt(j) === '}') return { value: out, pos: j + 1 }; continue; }
      if (s.charAt(j) === '}') return { value: out, pos: j + 1 };
      fail('forventet «,» eller «}»');
    }
    fail('mangler «}»');
  }

  var MARKER_RE = /^[ \t]*(?:#|--|\/\/)[ \t]*/;
  var NS = { meta: 1 };
  var OST_VERBS = { connect: 1, read: 1, create: 1, use: 1 };
  var METHODS = { read: 1, add: 1, join: 1, filter: 1 };

  // Gammel syntaks -> migrasjonshint. Hvert mønster krever et KJENNETEGN som
  // prosa ikke har: " as " sammen med en sti/URL eller opsjonshale, " into "
  // med en <kilde>/<kolonne>-referanse, " on ", ", key(", " from ".
  //
  // Prinsippet er at falske positiver er verre enn tapte hint: et hint som
  // uteblir koster brukeren en oppslagstur, mens en kommentar som blir en
  // hard feilmelding stopper scriptet. Derfor varsles IKKE de bare
  // enkeltord-formene, som er strukturelt identiske med prosa:
  //   «# meta bef tekst»  ~ «# meta information about this repo»
  //   «# use df»          ~ «# use caution»
  //   «# connect ssb»     ~ «# connect manually»
  //   «# read h as df»    ~ «# read this as int»
  // AKSEPTERT GJENSTÅENDE: «connect <ord> as <ord>» kan ikke strammes uten å
  // miste hintet for den vanligste ekte formen («# connect ssb as s»), så
  // «# connect early as needed» gir feilmelding. `use` slipper unna fordi
  // kilden der er et lukket sett (r|python|duckdb).
  // Migreringsskriptet (Task 8) konverterer alle eksisterende filer, så disse
  // formene finnes ikke i repoet — vakten er kun en håndskrivingshjelp.
  var OLD_PATTERNS = [
    { w: 'connect', re: /^connect[ \t]+\S+[ \t]+as[ \t]+[A-Za-z_]\w*[ \t]*(?:,[ \t]*\w+\(.*)?$|^connect[ \t]+\S+[ \t]*,[ \t]*\w+\(.*$/i },
    { w: 'read',    re: /^(?:read|load|require)[ \t]+\S*[\/:]\S*[ \t]+as[ \t]+[A-Za-z_]\w*[ \t]*(?:,[ \t]*\w+\(.*)?$|^(?:read|load|require)[ \t]+\S+[ \t]+as[ \t]+[A-Za-z_]\w*[ \t]*,[ \t]*\w+\(.*$/i },
    { w: 'create',  re: /^create(?:[-_]dataset)?[ \t]+[A-Za-z_]\w*[ \t]*,[ \t]*key\(/i },
    { w: 'add',     re: /^(?:add|import)[ \t]+\S*\/\S*.*[ \t]+into[ \t]+[A-Za-z_]\w*(?:[ \t]+(?:left|inner|outer))?[ \t]*$/i },
    { w: 'join',    re: /^join[ \t]+[A-Za-z_]\w*[ \t]+into[ \t]+[A-Za-z_]\w*[ \t]+on[ \t]+\S/i },
    { w: 'use',     re: /^use[ \t]+[A-Za-z_]\w*[ \t]+from[ \t]+(?:r|python|duckdb)[ \t]*$/i }
  ];

  var HINT = {
    connect: 'skriv «# <alias> = ost.connect("<mål>")»',
    read: 'skriv «# <navn> = ost.read("<mål>")» eller «# <navn> = <alias>.read("<tabell>")»',
    create: 'skriv «# <navn> = ost.create(key="<kolonne>")»',
    add: 'skriv «# <datasett>.add(<kilde>, ["<kolonne>"])»',
    join: 'skriv «# <datasett>.join(<navn>, on="<kolonne>")»',
    use: 'skriv «# <navn> = ost.use("<navn>")»'
  };

  function parseArgs(s, i) {
    var args = [], kwargs = {};
    i = skipWs(s, i);
    if (s.charAt(i) === ')') return { args: args, kwargs: kwargs, pos: i + 1 };
    while (i < s.length) {
      var kw = /^([A-Za-z_]\w*)[ \t]*=(?!=)/.exec(s.slice(i));
      if (kw) {
        // Samme grunn som i parseDict: «__proto__="python"» ville slukt seg
        // selv, og ost.use ville stille GJETTET kjøretiden i stedet for å
        // varsle om et ukjent argument (funnet i Task 7-reviewen).
        checkKey(kw[1], 'argumentnavn');
        var v = parseLiteral(s, i + kw[0].length);
        kwargs[kw[1]] = v.value;
        i = skipWs(s, v.pos);
      } else {
        var a = parseLiteral(s, i);
        if (Object.keys(kwargs).length) fail('posisjonsargument etter navngitt argument');
        args.push(a.value);
        i = skipWs(s, a.pos);
      }
      if (s.charAt(i) === ',') { i = skipWs(s, i + 1); if (s.charAt(i) === ')') return { args: args, kwargs: kwargs, pos: i + 1 }; continue; }
      if (s.charAt(i) === ')') return { args: args, kwargs: kwargs, pos: i + 1 };
      fail('forventet «,» eller «)»');
    }
    fail('mangler «)»');
  }

  function oldSyntaxError(body) {
    for (var i = 0; i < OLD_PATTERNS.length; i++) {
      if (OLD_PATTERNS[i].re.test(body)) {
        return { error: '«' + body + '» er gammel syntaks — ' + (HINT[OLD_PATTERNS[i].w] || 'se hjelpen') };
      }
    }
    return null;
  }

  // parseLine(line) -> null | {form…} | {error}
  function parseLine(line) {
    var raw = String(line == null ? '' : line);
    var mk = MARKER_RE.exec(raw);
    if (!mk) return null;
    var body = raw.slice(mk[0].length).replace(/[ \t\r]+$/, '');
    if (!body) return null;

    // Den NYE grammatikken prøves først. Motsatt rekkefølge lot
    // gammel-syntaks-vakten svelge gyldige linjer som «read = ost.read("x")».
    try {
      // Form 1: <navnerom>.<sti> = <literal>  |  <navnerom>.<sti> += <literal>
      // += (2026-07-27): «=» erstatter, «+=» føyer til — standard Python-
      // semantikk. Semantikken (hvilke nøkler som godtar +=) eies av
      // data-directives.js; her bæres bare flagget.
      var ns = /^([A-Za-z_]\w*)((?:\.[A-Za-z_]\w*)+)[ \t]*(\+?=)[ \t]*/.exec(body);
      if (ns && NS[ns[1]]) {
        var path = ns[2].slice(1).split('.');
        var aug = ns[3] === '+=';
        var rest = body.slice(ns[0].length);
        var first = parseLiteral(rest, 0);
        var after = skipWs(rest, first.pos);
        if (after >= rest.length) return { form: 'ns', ns: ns[1], path: path, value: first.value, augment: aug, raw: raw.trim() };
        if (rest.charAt(after) !== ',') fail('uventet tekst etter verdi');
        var tup = [first.value];
        while (rest.charAt(after) === ',') {
          var probe = skipWs(rest, after + 1);
          if (probe >= rest.length) { after = probe; break; }   // trailing komma
          var nx = parseLiteral(rest, probe);
          tup.push(nx.value);
          after = skipWs(rest, nx.pos);
        }
        if (after < rest.length) fail('uventet tekst etter verdi');
        return { form: 'ns', ns: ns[1], path: path, value: tup, augment: aug, raw: raw.trim() };
      }

      // Form 2: [<navn> =] <mottaker>.<verb>(<args>)
      var call = /^(?:([A-Za-z_]\w*)[ \t]*=[ \t]*)?([A-Za-z_]\w*)\.([A-Za-z_]\w*)[ \t]*\(/.exec(body);
      if (call) {
        var target = call[1] || null, recv = call[2], verb = call[3];
        if ((recv === 'ost') || METHODS[verb]) {
          if (recv === 'ost' && !OST_VERBS[verb]) {
            return { error: 'ukjent verb «ost.' + verb + '» — gyldige: connect, read, create, use' };
          }
          var pr = parseArgs(body, call[0].length);
          if (skipWs(body, pr.pos) < body.length) fail('uventet tekst etter «)»');
          return { form: 'call', target: target, recv: recv, verb: verb,
                   args: pr.args, kwargs: pr.kwargs, raw: raw.trim() };
        }
      }
    } catch (e) {
      return { error: e.message };
    }

    return oldSyntaxError(body);
  }

  function parseScript(text) {
    var lines = String(text == null ? '' : text).split(/\r?\n/);
    var items = [], errors = [];
    for (var i = 0; i < lines.length; i++) {
      var r = parseLine(lines[i]);
      if (!r) continue;
      if (r.error) { errors.push('linje ' + (i + 1) + ': ' + r.error); continue; }
      r.lineNo = i + 1;
      items.push(r);
    }
    return { items: items, errors: errors };
  }

  function isDirectiveLine(line) {
    return parseLine(line) !== null;
  }

  global.DirectiveParser = { parseLiteral: parseLiteral, parseLine: parseLine,
                             parseScript: parseScript, isDirectiveLine: isDirectiveLine };
})(typeof window !== 'undefined' ? window : globalThis);
