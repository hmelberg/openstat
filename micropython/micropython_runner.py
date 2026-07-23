# micropython/micropython_runner.py — persistent kjøremiljø for MicroPython-
# modusen. Port av brython/brython_runner.py (samme grensesnitt og
# embed-marker-protokoll); designspec 2026-07-12-micropython-mode-design.md.
#
# VIKTIGSTE forskjell fra Brython-runneren: stdout fanges IKKE her.
# MicroPython tillater ikke sys.stdout-bytte (fase 0: c_sys_stdout_assign);
# motoren (js/micropython-engine.js) fanger stdout via loadMicroPython({stdout}).
# _execute_code print()-er derfor alt (også trailing expression) og
# returnerer ''. Under CPython (pytest) fanges utskriften med capsys.
import sys, json
from io import StringIO

_EMBED_S = '__micro_transform_start_'
_EMBED_E = '__micro_transform_end__'
_PENDING = '__BRYTHON_PENDING__'   # delt protokollmarkør (samme som Brython)

_shared_vars = {}
_last_error = ''


def _format_exc(e):
    """Traceback-tekst på begge dialekter."""
    if hasattr(sys, 'print_exception'):        # MicroPython
        buf = StringIO()
        sys.print_exception(e, buf)
        return buf.getvalue()
    import traceback                            # CPython (pytest)
    return traceback.format_exc()


def _fmt(obj):
    """Formater ett objekt som output-tekst (embed-markører for figurer/frames)."""
    if obj is None:
        return ''
    if hasattr(obj, '_openstat_el_id'):
        # ui-html-fasen (Task 3, spec §2/mount): et Element-håndtak
        # (ui.html.*) er en MONTERBAR verdi, ikke noe å repr-printe —
        # display-kroken kaller show() (append i cellens output-slot NÅ) i
        # stedet, og returnerer '' (kallstedet ~134-136 sin `if shown:`-
        # vakt behandler allerede '' som "ingenting å skrive ut" — ingen
        # blank linje). Guardet HER (ikke bare inni Element.show() sin egen
        # try/except rundt selve elShow-broen) fordi show() SELV kan kaste
        # før den når broen (f.eks. en overstyrt duck-typet .show()) — en
        # slik feil skal ALDRI drepe cellen, samme forsiktighetslinje som
        # resten av denne funksjonen.
        try:
            obj.show()
        except Exception:
            pass
        return ''
    if hasattr(obj, 'to_leaflet_json_str'):
        # folium-shimet (spec 2026-07-24): Leaflet-rendring i JS
        return _EMBED_S + 'leafletmap__' + '\n' + obj.to_leaflet_json_str() + '\n' + _EMBED_E
    if hasattr(obj, 'to_vegalite_json_str'):
        # altair-shimet (spec 2026-07-23): vega-embed-rendring i JS
        return _EMBED_S + 'vegalite__' + '\n' + obj.to_vegalite_json_str() + '\n' + _EMBED_E
    if hasattr(obj, 'to_plotly_json_str'):
        return _EMBED_S + 'figure__' + '\n' + obj.to_plotly_json_str() + '\n' + _EMBED_E
    if hasattr(obj, 'to_html'):
        html = obj.to_html()
        if '<table class=' not in html:
            html = html.replace('<table', '<table class="output-table"', 1)
        return _EMBED_S + 'tablehtml__' + '\n' + html + '\n' + _EMBED_E
    if isinstance(obj, str):
        return obj
    return repr(obj)


_UI_CONTROLS = ('slider', 'dropdown', 'checkbox', 'switch', 'number', 'text',
                'button', 'run_button', 'play')


def _is_bare_underscore_name(s):
    """True hvis `s` er nøyaktig ett bart navn som starter med '_' (ingen
    andre tegn enn '_'/bokstav/siffer). Brukt av _-demping-grenen under, og
    gjenbrukt for "bare-navn-pluss-kommentar"-formen (korner 1)."""
    if not s or not s.startswith('_'):
        return False
    for _ch in s:
        if not (_ch == '_' or _ch.isalpha() or _ch.isdigit()):
            return False
    return True

def _tail_suppressed(tail):
    """Display policy v2 (spec 2026-07-20 §Phase 1) på trailing-uttrykket:
    demp visningen når det er (a) et nakent navn med _-prefiks eller (b) et
    nakent ui.<kontroll>(...)-kall (kontrollen registreres av evalueringen —
    pull-modellen; skalar-ekkoet er støy). Evalueringen skjer UANSETT
    (sideeffekter bevart). ';'-demping trenger ingen kode her: en hale med
    ';' kompilerer ikke i eval-modus, så kandidaten forkastes og hele koden
    plain-exec'es uten visning. Ingen `ast` — string-sjekker (samme grunn
    som kandidat-skanningen i _execute_code).

    Hjørnefikser (fase-1 sluttreview + fase-3-era ledger):
    1. `_navn  # kommentar` skal fortsatt dempes — strip en trailing
       kommentar FØR understreksjekken, men bare for "bare-navn-pluss-
       kommentar"-formen: splitt på FØRSTE '#' og krev at delen FØR den
       (.strip()'et) i seg selv består IdentifierListen (samme sjekk som
       under) — regex-fritt, og kan ikke feiltolke '#' inni en streng-hale
       fordi den halen uansett ikke er et bart navn.
    2/3. Et ui.<kontroll>(...)-kall dempes bare når halen SLUTTER ved
       kallets egen matchende lukke-parentes (kun whitespace/en strippet
       kommentar tillatt etterpå) — `ui.slider(0,100) + 1` og
       `ui.slider(0,100).value` er dermed IKKE lenger falske positiver
       (prefiks-match alene godtok dem før). Valgfritt whitespace mellom
       kontrollnavnet og '(' godtas også (`ui.slider (0,100)`).
       Kjent begrensning: parenteser inni streng-argumenter
       (`ui.dropdown(["a)b"])`) forvirrer telleren, så slike nakne kall
       VISES i stedet for å dempes — trygg retning (støy, aldri
       feilaktig demping)."""
    _bare_check = tail
    if '#' in tail:
        _pre = tail.split('#', 1)[0].strip()
        if _is_bare_underscore_name(_pre):
            _bare_check = _pre
    if _is_bare_underscore_name(_bare_check):
        return True
    if tail.startswith('ui.'):
        _rest = tail[3:]
        for _name in _UI_CONTROLS:
            if not _rest.startswith(_name):
                continue
            _after = _rest[len(_name):]
            _i = 0
            while _i < len(_after) and _after[_i] in (' ', chr(9)):
                _i += 1
            if _i >= len(_after) or _after[_i] != '(':
                continue
            _depth = 0
            _j = _i
            _matched = -1
            while _j < len(_after):
                _c = _after[_j]
                if _c == '(':
                    _depth += 1
                elif _c == ')':
                    _depth -= 1
                    if _depth == 0:
                        _matched = _j
                        break
                _j += 1
            if _matched == -1:
                continue
            _remainder = _after[_matched + 1:].strip()
            if _remainder == '' or _remainder.startswith('#'):
                return True
    return False


def _show(*objs):
    for o in objs:
        # Speiler `if shown: print(shown)`-vakten i _execute_code (~linje
        # 150-152): et ui.html.*-Element formaterer til '' (_fmt monterer det
        # i stedet for å repr-printe, se _fmt sin _openstat_el_id-gren over)
        # — print('') ville uansett skrevet en tom linje. Reviewer-funn (samme
        # gjennomgang som data-ui-shown-for-kjøringsrensken i js/cells.js,
        # commit 15ce63c) — port av Brython-tvillingens fiks.
        shown = _fmt(o)
        if shown:
            print(shown)


_shared_vars['show'] = _show


def _execute_code(code):
    """Kjør koden i de persistente brukerglobals. All output via print
    (motoren samler); returnerer alltid ''."""
    global _last_error
    _last_error = ''
    try:
        # Statement-aware trailing-expression detection (no `ast` — must run
        # under Brython 3.12 too). REPL semantics: if the code's final
        # top-level statement is itself an expression, display its value.
        # A top-level statement always starts at column 0 (no leading
        # space/tab). But column-0 is only *necessary*, not *sufficient*,
        # evidence of "this is where the final top-level statement begins":
        # - Black-style wrapping puts a lone closing ')' at column 0
        #   (`pe.scatter(\n    df, ...\n)`), so the LAST column-0 line can be
        #   a continuation fragment, not the statement start.
        # - Unindented continuations (`sum(nums,\n0)`) put a fragment like
        #   '0)' at column 0 too.
        # - A bare multi-line triple-quoted string's last physical line
        #   ('b"""') is not valid source on its own.
        # So: collect column-0 candidate line indices from the END upward
        # (capped, to bound pathological inputs) and try each one as a
        # prospective statement start, taking tail = lines[i:] joined. The
        # first candidate whose tail compiles in 'eval' mode AND whose head
        # (lines[:i], or 'pass' if empty) compiles in 'exec' mode wins: exec
        # the head, eval+display the tail. If the head fails to compile for
        # that candidate, keep scanning upward rather than giving up. If no
        # candidate ever produces a compilable (head, tail) pair, fall back
        # to plain-exec of the whole code with no display — identical to
        # today's behavior. This still keeps indented-last-line-inside-a-
        # block safe: the only column-0 candidate is the block header,
        # whose tail (header + body) cannot compile as 'eval' (a for/if/def
        # is not a valid expression), so it plain-execs instead of evaling
        # the inner line out of context.
        #
        # Two bounds guard against pathological inputs while staying correct
        # for editor-sized scripts: the scan cap (1000) bounds how many
        # column-0 lines get probed — compiling ~1000 small string slices is
        # negligible cost, and real scripts don't run deeper than that. But
        # a single trailing expression can still legitimately spill more
        # than 1000 unindented lines (e.g. a long literal list, one item per
        # line); if the cap is hit before line 0 is reached, line 0 itself
        # is appended as a final fallback candidate (whole code as tail,
        # head='pass'), so a single-statement script is always found
        # regardless of length.
        lines = code.split(chr(10))
        while lines and lines[-1].strip() == '':
            lines.pop()
        result = None
        displayed = False
        suppressed = False
        if lines:
            candidates = []
            for i in range(len(lines) - 1, -1, -1):
                line = lines[i]
                if line and line[:1] not in (' ', chr(9)):
                    candidates.append(i)
                    if len(candidates) >= 1000:
                        break
            if 0 not in candidates:
                candidates.append(0)
            for i in candidates:
                tail_src = chr(10).join(lines[i:])
                tail_stripped = tail_src.strip()
                if not tail_stripped or tail_stripped.startswith('#'):
                    continue
                try:
                    tail_code = compile(tail_src, '<micropython>', 'eval')
                except SyntaxError:
                    continue
                head_src = chr(10).join(lines[:i]) or 'pass'
                try:
                    head_code = compile(head_src, '<micropython>', 'exec')
                except SyntaxError:
                    continue
                exec(head_code, _shared_vars)
                result = eval(tail_code, _shared_vars)
                displayed = True
                suppressed = _tail_suppressed(tail_stripped)
                break
        if not displayed:
            exec(compile(code, '<micropython>', 'exec'), _shared_vars)
        # Korner 4 (fase-3-era ledger Minor 2, pyodide-paritet): når halen er
        # suppressed, ikke kall _fmt() i det hele tatt — en _-prefikset
        # ui.html-ELEMENT skal ikke montere (_fmt sin _openstat_el_id-gren
        # kaller obj.show() som sideeffekt; det må ikke skje for en dempet
        # verdi, akkurat som pyodide-siden aldri kaller _show_one for den).
        shown = _fmt(result) if (displayed and not suppressed) else ''
        if shown:
            print(shown)
        return ''
    except BaseException as e:
        if getattr(e, '__brython_pending__', False):
            _last_error = _PENDING
            return ''
        if not isinstance(e, Exception):
            raise
        _last_error = _format_exc(e)
        return ''


def _get_last_error():
    return _last_error


class _Mod:
    """MicroPython kan ikke lage types.ModuleType-instanser; et vanlig objekt
    i sys.modules fungerer for både `import m` og `from m import navn`
    (fase 0: c_module_trick). __getattr__ delegerer til modul-globals."""
    def __init__(self, name, g):
        self.__name__ = name
        self._g = g

    def __getattr__(self, k):
        try:
            return self._g[k]
        except KeyError:
            raise AttributeError(k)


def _register_module(name, source):
    """Lazy lib-lasting (motoren kaller): gjør `source` importerbar som `name`.
    Idempotent; '' ved suksess, traceback-tekst ved feil."""
    if name in sys.modules:
        return ''
    g = {'__name__': name}
    try:
        exec(compile(source, name + '.py', 'exec'), g)
    except Exception as e:
        return _format_exc(e)
    sys.modules[name] = _Mod(name, g)
    return ''


def _alias_module(alias, canonical):
    """`import alias` -> allerede registrert `canonical`. Dottet alias krever
    forelder i sys.modules først (samme regel som Brython-runneren)."""
    if canonical not in sys.modules:
        return 'Ukjent modul: ' + canonical
    if '.' in alias:
        parent_name, _, child = alias.rpartition('.')
        if parent_name not in sys.modules:
            return 'Ukjent foreldremodul: ' + parent_name
        setattr(sys.modules[parent_name], child, sys.modules[canonical])
    sys.modules[alias] = sys.modules[canonical]
    return ''


_snap = None


def _snapshot():
    global _snap
    _snap = dict(_shared_vars)


def _rollback():
    # Per-nøkkel med vilje (arv fra Brython-fella; ufarlig og likt begge steder)
    if _snap is None:
        return
    for k in list(_shared_vars.keys()):
        if k not in _snap:
            del _shared_vars[k]
    for k in list(_snap.keys()):
        _shared_vars[k] = _snap[k]


def _bind_datasets(spec_json):
    """Bind datasett fra JS til brukerglobals. spec: {name: {kind, payload}}.
    kind 'csv' -> CSV-tekst; kind 'columns' -> {kolonne: [verdier]}.
    NB: ingen float-str-rundtur her — MicroPythons json gir ekte floats
    (fase 0: c_json_floats); Brython-fella finnes ikke i denne dialekten."""
    try:
        import pandas_mpy as _pd
        spec = json.loads(spec_json) if isinstance(spec_json, str) else spec_json
        for name, d in spec.items():
            if d['kind'] == 'csv':
                _shared_vars[name] = _pd.read_csv(StringIO(d['payload']))
            else:
                cols = {k: [_pd.nan if v is None else v for v in vals]
                        for k, vals in d['payload'].items()}
                _shared_vars[name] = _pd.DataFrame(cols)
        return ''
    except Exception as e:
        return _format_exc(e)

def _sync_var(name, value_json):
    """ui sync_to (fase 3): skriv en widget-verdi inn i _shared_vars uten
    kjøring. Speiler _bind_datasets-kontrakten: '' ved suksess, ellers
    feilstreng."""
    try:
        _shared_vars[name] = json.loads(value_json)
        return ''
    except Exception as e:
        return _format_exc(e)

# Boot-baseline for fase C (spec 2026-07-16): et grunt bilde av
# _shared_vars slik de så ut ved boot — ATSKILT fra _snapshot/_rollback-
# paret, som er reservert duck-replay-løkken (per kjøring). _reset() spoler
# brukerglobals tilbake hit ("Restart & kjør alle" i notatbok), men beholder
# registrerte biblioteker i sys.modules — samme avveining som R-modusens
# rm(list=ls()) (og samme grunt-kopi-forbehold som _rollback dokumenterer:
# muterte objekter DELES med baselinen; grunne kopier er kontrakten her).
_baseline_vars = dict(_shared_vars)

def _warn(msg):
    """console.warn via broen, GUARDET (ingen js-modul i CPython-pytest) -
    speiler ui_mpy.py sin _warn semantisk (samme "aldri stille, men aldri
    en krasj for en advarsel"-linje). Importerer INNI funksjonen (ikke på
    modulnivå, i motsetning til ui_mpy.py sin `from js import window`)
    fordi micropython_runner.py - ulikt ui_mpy.py - lastes direkte under
    CPython i pytest (ingen js-modul-garanti der)."""
    try:
        from js import window
        window.console.warn(msg)
    except Exception:
        pass


def _reset():
    """Spol brukerglobals tilbake til boot-baseline; ''/traceback-kontrakt.
    Per-nøkkel med vilje — SAMME Brython 3.12-felle som _rollback over
    dokumenterer (arvet av MicroPython-runneren via tvillingstrukturen selv
    om fella i seg selv er Brython-spesifikk): clear()+update() mistet
    gjenopprettede nøkler (browser-verifisert 2026-07-16 i Brython-tvillingen
    — _reset() speiles her uendret for symmetri). d[k]=v / del d[k] oppfører
    seg riktig, som i _rollback. Bruker _format_exc(e) (IKKE bar
    traceback.format_exc()) — ekte MicroPython (WASM) mangler `traceback`-
    modulen (browser-verifisert 2026-07-16: et modulnivå-`import traceback`
    her feilet ALL sesjonsboot med "ImportError: no module named
    'traceback'"); _format_exc() dekker begge dialekter via
    sys.print_exception().
    HERDET (exit gate-funn 2026-07-18, speiler Brython-tvillingens fiks for
    paritet — se brython_runner.py sin _reset()-docstring for hele
    historikken): robusthetsprinsippet gjelder her selv om MicroPython selv
    IKKE har Brython 3.12s scoping-bug (bar generator-uttrykk lekker ikke
    løkkevariabelen i denne dialekten) — en fremtidig forgiftet/lekket
    nøkkel av en HELT ANNEN årsak skal likevel aldri kunne abortere det
    hele per-nøkkel-loopet og hoppe over gjenopprettingsloopet (som
    restaurerer 'show' m.fl. fra _baseline_vars), og dermed korrumpere
    sesjonen for resten av nettleserøkta. NÅ: hver enkelt del/set-operasjon
    er sitt EGET try/except - én forgiftet nøkkel kan aldri stoppe loopet
    for de andre nøklene, og kan aldri hindre gjenopprettingsloopet i å
    kjøre. Mislykkede nøkler samles og varsles ÉN gang via _warn() (samme
    console.warn-bro som ui_mpy.py bruker), så resten fortsetter uansett -
    reset returnerer fortsatt '' (suksess) selv om én nøkkel ikke lot seg
    slette/sette; den forblir da værende i _shared_vars som et harmløst
    levn, i stedet for å korrumpere hele sesjonen."""
    global _last_error
    try:
        _failed = []
        for k in list(_shared_vars.keys()):
            if k not in _baseline_vars:
                try:
                    del _shared_vars[k]
                except BaseException:
                    _failed.append(k)
        for k in list(_baseline_vars.keys()):
            try:
                _shared_vars[k] = _baseline_vars[k]
            except BaseException:
                _failed.append(k)
        if _failed:
            _warn('_reset(): ' + str(len(_failed)) + ' nøkkel(er) kunne ikke '
                  'tilbakestilles (fortsetter likevel, se _reset()-docstring): ' +
                  ', '.join(sorted(set(_failed))))
        _last_error = ''
        return ''
    except BaseException as e:
        return _format_exc(e)
