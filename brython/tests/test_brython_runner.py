import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import brython_runner as br

ES = '__micro_transform_start_'
EE = '__micro_transform_end__'

def test_stdout_and_last_expression():
    out = br._execute_code('print("hei")\n1 + 1')
    assert 'hei' in out and '2' in out
    assert br._get_last_error() == ''

def test_state_persists_between_runs():
    br._execute_code('xx = 41')
    out = br._execute_code('xx + 1')
    assert '42' in out

def test_figure_embed_marker():
    br._execute_code('import pandas_brython as pd\nimport plotly_express_brython as pe\n'
                     'df = pd.DataFrame({"x":[1,2],"y":[3,4]})')
    out = br._execute_code('pe.scatter(df, x="x", y="y")')
    assert (ES + 'figure__') in out and EE in out
    payload = out.split(ES + 'figure__')[1].split(EE)[0].strip()
    assert 'data' in json.loads(payload)

def test_dataframe_tablehtml_marker():
    out = br._execute_code('df')
    assert (ES + 'tablehtml__') in out and '<table' in out

def test_show_multiple():
    # show(df) emitterer tabulator-markøren siden tabulator-byttet (stale
    # assertion fanget i Fable-reviewen 2026-07-24; bare df-repr gir tablehtml).
    out = br._execute_code('show(df, "tekst")')
    assert (ES + 'tabulator__') in out and 'tekst' in out

def test_error_returns_traceback():
    out = br._execute_code('1/0')
    err = br._get_last_error()
    assert 'ZeroDivisionError' in err

def test_bind_datasets_csv_and_columns():
    spec = {'iris': {'kind': 'csv', 'payload': 'a,b\n1,x\n2,y\n'},
            'tall': {'kind': 'columns', 'payload': {'v': [1, 2, 3]}}}
    msg = br._bind_datasets(json.dumps(spec))
    assert msg == ''
    out = br._execute_code('str(len(iris)) + "," + str(len(tall))')
    assert '2,3' in out

def test_indented_last_line_not_evaled_out_of_context():
    # Last physical line is indented (inside the if-block) but is itself a
    # valid expression after .strip() ('y'). Must not be split into
    # exec(body) + eval(tail) — that execs the block without the last line
    # and then evals 'y' at top level, raising a spurious NameError.
    out = br._execute_code('if False:\n    y = 99\n    y')
    assert br._get_last_error() == ''
    assert out == ''

def test_indented_last_line_in_for_loop_not_displayed():
    br._execute_code('nums_rt = {"a": 10, "b": 30}')
    out = br._execute_code('for k_rt in nums_rt:\n    v_rt = nums_rt[k_rt]\n    v_rt')
    assert br._get_last_error() == ''
    assert '30' not in out

def test_multiline_trailing_call_displays_figure():
    # Reproduces the app's own starter example: a trailing call whose
    # arguments wrap across two physical lines, second line indented.
    # The last PHYSICAL line ('           title="t")') is indented, so a
    # purely line-based last-line check misses it entirely and the figure
    # is silently dropped. Statement-aware detection must find the call's
    # start (column 0) and eval the whole multi-line tail.
    br._execute_code('import pandas_brython as pd\nimport plotly_express_brython as pe\n'
                      'df_ml = pd.DataFrame({"x": [1, 2], "y": [3, 4]})')
    out = br._execute_code(
        'pe.scatter(df_ml, x="x", y="y",\n'
        '           title="t")'
    )
    assert (ES + 'figure__') in out and EE in out
    assert br._get_last_error() == ''

def test_multiline_trailing_expression_with_earlier_lines():
    # Earlier top-level statement, then a trailing multi-line parenthesized
    # arithmetic expression — must exec the earlier line and eval+display
    # the multi-line tail.
    out = br._execute_code(
        'a_ml = 3\n'
        '(a_ml +\n'
        ' 4)'
    )
    assert '7' in out
    assert br._get_last_error() == ''

def test_black_style_call_closing_paren_at_column_0():
    # Black-style formatting puts the lone closing ')' at column 0. The
    # naive "last column-0 line" is just ')' — compiling that alone as
    # 'eval' fails, so the scanner must walk further upward to the call's
    # true start ('pe_bs.scatter(') and succeed there instead of giving up.
    br._execute_code('import pandas_brython as pd\nimport plotly_express_brython as pe_bs\n'
                      'df_bs = pd.DataFrame({"x": [1, 2], "y": [3, 4]})')
    out = br._execute_code(
        'pe_bs.scatter(\n'
        '    df_bs, x="x", y="y"\n'
        ')'
    )
    assert (ES + 'figure__') in out and EE in out
    assert br._get_last_error() == ''

def test_unindented_continuation_line_displays_value():
    # `sum(nums,\n0)` — the second physical line ('0)') starts at column 0
    # but is NOT itself a new top-level statement; it's an unindented
    # continuation of the wrapped call on the previous line. The last
    # column-0 candidate's tail ('0)') fails to compile as 'eval', so the
    # scanner must walk upward to the real start ('sum(nums,') and succeed.
    br._execute_code('nums_uc = [1, 2, 3]')
    out = br._execute_code('sum(nums_uc,\n0)')
    assert '6' in out
    assert br._get_last_error() == ''

def test_bare_trailing_multiline_string_displays():
    # A bare multi-line triple-quoted string literal as the trailing
    # top-level statement. Its own last column-0 line ('b"""') is not
    # valid 'eval' source by itself; the scanner must walk up to the
    # opening '"""a' line and eval the whole string.
    out = br._execute_code('"""a\nb"""')
    assert 'a\nb' in out
    assert br._get_last_error() == ''

def test_trailing_multiline_string_assignment_not_misdisplayed():
    # A multi-line string literal used inside an assignment, followed by no
    # further top-level statement. Every column-0 candidate's tail is a
    # syntactically broken fragment (unterminated string literal, since the
    # string's closing quotes are followed by more source), so none compile
    # as 'eval' — must fall back to plain-exec with no display, and must
    # NOT mis-evaluate a fragment like '1 + 1' out of context.
    out = br._execute_code('s_ms = """hello\n1 + 1"""')
    assert out == ''
    assert br._get_last_error() == ''

def test_long_trailing_expression_beyond_scan_cap_displays():
    # A single trailing expression spanning many column-0 lines (one list
    # item per line, unindented) — more than the scan cap. The capped
    # upward scan alone would exhaust its candidates before reaching line 0
    # (the expression's true start), silently dropping the display. The
    # whole-code fallback candidate (index 0) must catch this.
    expr = 'sum([' + chr(10).join(str(i) + ',' for i in range(60)) + chr(10) + '])'
    out = br._execute_code(expr)
    assert str(sum(range(60))) in out
    assert br._get_last_error() == ''

# ── lazy library registration (_register_module / _alias_module) ──────────

def test_register_module_import_works():
    err = br._register_module('lazydemo_a', 'value = 41\ndef bump(x):\n    return x + 1\n')
    assert err == ''
    out = br._execute_code('import lazydemo_a\nlazydemo_a.bump(lazydemo_a.value)')
    assert br._get_last_error() == ''
    assert '42' in out

def test_register_module_is_idempotent():
    assert br._register_module('lazydemo_b', 'value = 1\n') == ''
    assert br._register_module('lazydemo_b', 'value = 2\n') == ''  # no-op, not re-exec
    out = br._execute_code('import lazydemo_b\nlazydemo_b.value')
    assert '1' in out

def test_register_module_syntax_error_reports_and_skips():
    err = br._register_module('lazydemo_bad', 'def broken(:\n')
    assert 'SyntaxError' in err
    assert 'lazydemo_bad' not in sys.modules

def test_register_module_runtime_error_reports_and_skips():
    err = br._register_module('lazydemo_boom', 'raise ValueError("boom")\n')
    assert 'ValueError' in err and 'boom' in err
    assert 'lazydemo_boom' not in sys.modules

def test_alias_module():
    br._register_module('lazydemo_c', 'value = 7\n')
    assert br._alias_module('lazydemo_c_alias', 'lazydemo_c') == ''
    out = br._execute_code('import lazydemo_c_alias\nlazydemo_c_alias.value')
    assert '7' in out

def test_alias_unknown_module_errors():
    assert br._alias_module('nope_alias', 'nope_canonical') != ''

def test_dotted_alias_binds_parent_attribute_and_sys_modules():
    br._register_module('lazydemo_mpl', 'def plot(x):\n    return x * 2\n')
    assert br._alias_module('lazydemo_pkg', 'lazydemo_mpl') == ''
    assert br._alias_module('lazydemo_pkg.pyplot', 'lazydemo_mpl') == ''
    out = br._execute_code('import lazydemo_pkg.pyplot as plt\nplt.plot(21)')
    assert br._get_last_error() == ''
    assert '42' in out

def test_dotted_alias_requires_parent_in_sys_modules():
    br._register_module('lazydemo_orphan', 'x = 1\n')
    err = br._alias_module('no_such_parent.child', 'lazydemo_orphan')
    assert 'Ukjent foreldremodul' in err
    assert 'no_such_parent.child' not in sys.modules

class _Pending(BaseException):
    __brython_pending__ = True

def test_pending_exception_sets_marker_and_discards_output():
    br._shared_vars['_P'] = _Pending
    out = br._execute_code('print("halv utskrift")\nraise _P("q1")')
    assert out == ''
    assert br._get_last_error() == '__BRYTHON_PENDING__'

def test_pending_not_swallowed_by_user_except_exception():
    br._shared_vars['_P'] = _Pending
    code = ('try:\n'
            '    raise _P("q2")\n'
            'except Exception:\n'
            '    print("slukt")\n')
    br._execute_code(code)
    assert br._get_last_error() == '__BRYTHON_PENDING__'

def test_normal_exception_still_formats_traceback():
    br._execute_code('1/0')
    assert 'ZeroDivisionError' in br._get_last_error()

def test_snapshot_rollback_rewinds_rebindings():
    br._shared_vars['sxx'] = 1
    br._snapshot()
    out = br._execute_code('sxx = sxx + 1\nnytt_navn = 99')
    assert br._get_last_error() == ''
    assert br._shared_vars['sxx'] == 2
    br._rollback()
    assert br._shared_vars['sxx'] == 1
    assert 'nytt_navn' not in br._shared_vars

def test_reset_clears_user_vars():
    br._execute_code('zz_fasec = 99')
    assert br._reset() == ''
    out = br._execute_code("'zz_fasec' in globals()")
    assert 'False' in out


def test_reset_keeps_baseline_show():
    br._reset()
    out = br._execute_code("show('fasec-baseline')")
    assert 'fasec-baseline' in out


def test_reset_clears_last_error():
    br._execute_code('1/0')
    assert br._get_last_error() != ''
    assert br._reset() == ''
    assert br._get_last_error() == ''


def test_reset_twice_is_safe():
    assert br._reset() == ''
    assert br._reset() == ''


def test_reset_keeps_registered_modules():
    assert br._register_module('fasec_dummy', 'V = 7') == ''
    br._reset()
    out = br._execute_code('import fasec_dummy\nfasec_dummy.V')
    assert '7' in out


class _HostileDict(dict):
    """Dict-subklasse hvis __delitem__ kaster for én navngitt "forgiftet"
    nøkkel - simulerer exit gate-funnet (2026-07-18): bry17s bare
    generator-uttrykk (`sum(rad[...] for rad in ...)`) lekker løkkevariabelen
    `rad` inn i _shared_vars via en Brython 3.12-scoping-bug, og _reset()s
    per-nøkkel del-loop kastet (KeyError) midt i loopet FØR gjenopprettings-
    loopet (som restaurerer 'show' m.fl.) fikk kjøre - sesjonen forble
    korrupt for resten av nettleserøkta (bry19 rendret blankt etter
    bry17->bry18->bry19). Kan ikke reprodusere Brythons EGEN dict-felle i
    CPython, men effekten (en del som kaster for én nøkkel) er identisk og
    testbar via denne hostile __delitem__."""
    def __init__(self, *a, poison_key=None, **kw):
        super().__init__(*a, **kw)
        self._poison_key = poison_key

    def __delitem__(self, key):
        if key == self._poison_key:
            raise KeyError(key)  # speiler det faktiske browser-symptomet
        super().__delitem__(key)


def test_reset_survives_poisoned_key_that_raises_on_del():
    # Regresjonstest for exit gate-funn 1 (2026-07-18): _reset()s per-nøkkel
    # del-loop skal ALDRI abortere pga én forgiftet/lekket nøkkel - og skal
    # fortsatt kjøre gjenopprettingsloopet (restaurerer baseline-vars som
    # 'show') selv om én nøkkel ikke lot seg slette.
    orig = br._shared_vars
    try:
        hostile = _HostileDict(orig, poison_key='rad_leaked')
        hostile['rad_leaked'] = 42     # ikke i baseline -> del forsøkes -> kaster
        hostile['other_stray'] = 'x'   # ikke i baseline -> del skal lykkes normalt
        br._shared_vars = hostile
        err = br._reset()
        assert err == ''  # reset lykkes uansett (ikke traceback-kontrakten)
        assert 'other_stray' not in br._shared_vars       # normal opprydning fortsetter
        assert 'rad_leaked' in br._shared_vars             # forgiftet nøkkel overlever (harmløst levn)
        assert br._shared_vars['show'] is br._baseline_vars['show']  # gjenopprettingsloopet KJØRTE
        # sesjonen er brukbar etter reset (ikke korrupt for senere dokumentbytter):
        out = br._execute_code("show('post-reset-ok')")
        assert 'post-reset-ok' in out
    finally:
        br._shared_vars = orig


# ── ui sync_to (fase 3): _sync_var ─────────────────────────────────────────

def test_sync_var_writes_shared_vars():
    err = br._sync_var('n', '7')
    assert err == ''
    assert br._shared_vars['n'] == 7
    err = br._sync_var('s', '"hei"')
    assert err == ''
    assert br._shared_vars['s'] == 'hei'


def test_sync_var_bad_json_returns_error():
    br._shared_vars.pop('x', None)
    err = br._sync_var('x', '{not json')
    assert err != ''
    assert 'x' not in br._shared_vars


# ── ui.html display-krok (Task 3, spec §2): _fmt() sin _openstat_el_id-gren ──

class _FakeEl:
    """Duck-typer et ui.html.* Element-håndtak (kun det _fmt() bryr seg
    om: attributtet _openstat_el_id + en show()-metode)."""
    def __init__(self, raises=False):
        self._openstat_el_id = 'el1'
        self.shown = 0
        self._raises = raises

    def show(self):
        self.shown += 1
        if self._raises:
            raise RuntimeError('boom')


def test_fmt_mounts_element_and_returns_empty():
    el = _FakeEl()
    assert br._fmt(el) == ''
    assert el.shown == 1


def test_fmt_element_raising_show_does_not_crash():
    # Defensiv kontrakt (spec: "exception-safe - a raising show() must not
    # kill the cell"): en show() som kaster fanges HER (ikke bare inni
    # Element.show() sin egen try/except rundt selve elShow-broen), og
    # _fmt returnerer uansett '' - IKKE en feiltekst (samme "aldri en
    # ukontrollert exception, men heller ikke ekstra støy for en display-
    # detalj"-linje som resten av _fmt).
    el = _FakeEl(raises=True)
    assert br._fmt(el) == ''
    assert el.shown == 1


def test_execute_code_element_last_expression_mounts_no_blank_line():
    # Kallstedet (~117-119): shown == '' skal ikke legge til noe (ingen
    # blank linje) - end-to-end via _execute_code, ikke bare _fmt direkte.
    # Ikke-understreket variabelnavn (el_rt) MED VILJE: en _-prefikset
    # elementvariabel er nå suppressed og skal IKKE montere (se twin-testen
    # rett under — pyodide-paritet, fase-3-era ledger Minor 2). Denne testen
    # pinner den rene monterer-uten-blank-linje-stien (ikke-understreket).
    br._shared_vars['el_rt'] = _FakeEl()
    out = br._execute_code('print("før")\nel_rt')
    assert out == 'før' + chr(10)
    assert br._shared_vars['el_rt'].shown == 1


def test_execute_code_underscore_element_last_expression_does_not_mount():
    # Pyodide-paritet (fase-3-era ledger Minor 2): en bar _-prefikset
    # ui.html-ELEMENT skal IKKE montere som trailing-uttrykk — display-
    # policy v2s underscore-demping vinner over element-monteringskroken,
    # så _fmt hoppes helt over (og show() kalles dermed aldri) når halen er
    # suppressed. Før fiksen kalte kallstedet _fmt(result) UANSETT suppressed,
    # så elementet monterte stille selv om det ikke skulle vises.
    br._shared_vars['_el_us'] = _FakeEl()
    out = br._execute_code('print("før")\n_el_us')
    assert out == 'før' + chr(10)
    assert br._shared_vars['_el_us'].shown == 0


def test_show_element_mounts_no_blank_line():
    # _show() (den eksplisitte show(x)-funksjonen, linje ~45-48) manglet
    # samme `if shown:`-vakt som sist-uttrykk-kroken over (linje ~135):
    # show(element) kalte print(_fmt(o)) UBETINGET, og print('') skriver en
    # tom linje selv om elementet alt ble montert av _fmt sin egen
    # obj.show()-gren (samme mekanisme som test_fmt_mounts_element_and_
    # returns_empty over dokumenterer). Reviewer-funn fra samme gjennomgang
    # som data-ui-shown-for-kjøringsrensken i js/cells.js (commit 15ce63c).
    br._shared_vars['_el_arg'] = _FakeEl()
    out = br._execute_code('print("før")\nshow(_el_arg)\nprint("etter")')
    assert out == 'før' + chr(10) + 'etter' + chr(10)
    assert br._shared_vars['_el_arg'].shown == 1


# ---- display policy v2 (spec 2026-07-20 §Phase 1) på trailing-uttrykket ----

def test_underscore_bare_name_trailing_not_displayed():
    br._execute_code('_hemmelig = 123')
    out = br._execute_code('_hemmelig')
    assert '123' not in out
    assert br._get_last_error() == ''

def test_call_on_underscore_name_still_displayed():
    br._execute_code('_tekst = "abc"')
    out = br._execute_code('_tekst.upper()')
    assert 'ABC' in out

def test_trailing_semicolon_mutes_display():
    # ';' i halen kompilerer ikke i eval-modus → kandidaten forkastes og
    # hele koden plain-exec'es uten visning. Pinner den naturlige dempingen.
    out = br._execute_code('sv = 7\nsv;')
    assert '7' not in out
    assert br._get_last_error() == ''

def test_ui_control_call_evaluated_but_not_echoed():
    br._execute_code(
        'class FakeUi:\n'
        '    def __init__(self):\n'
        '        self.calls = []\n'
        '    def slider(self, *a, **k):\n'
        '        self.calls.append(a)\n'
        '        return 42\n'
        'ui = FakeUi()')
    out = br._execute_code('ui.slider(0, 100)')
    assert '42' not in out
    assert br._get_last_error() == ''
    out2 = br._execute_code('len(ui.calls)')
    assert '1' in out2

def test_non_control_ui_call_still_displayed():
    br._execute_code(
        'class FakeUi2:\n'
        '    def value(self, name):\n'
        '        return 99\n'
        'ui = FakeUi2()')
    out = br._execute_code('ui.value("n")')
    assert '99' in out


# ---- demping-hjørner (fase-1 sluttreview + fase-3-era ledger) -------------

def test_underscore_name_with_trailing_comment_not_displayed():
    # Korner 1: `_navn  # kommentar` skal fortsatt dempes — kommentaren må
    # strippes (bare-navn-pluss-kommentar-formen) før understreksjekken.
    br._execute_code('_med_kmt = 456')
    out = br._execute_code('_med_kmt  # en kommentar')
    assert '456' not in out
    assert br._get_last_error() == ''

def test_ui_control_call_with_trailing_arithmetic_not_muted():
    # Korner 2: `ui.slider(0,100) + 1` er IKKE et nakent kontroll-kall —
    # halen fortsetter etter kallets lukke-parentes, så den skal VISES.
    br._execute_code(
        'class FakeUiA:\n'
        '    def slider(self, *a, **k):\n'
        '        return 42\n'
        'ui = FakeUiA()')
    out = br._execute_code('ui.slider(0, 100) + 1')
    assert '43' in out
    assert br._get_last_error() == ''

def test_ui_control_call_dot_attr_tail_not_muted():
    # Korner 2 (variant): `ui.slider(0,100).value` fortsetter etter
    # kallets lukke-parentes — skal VISES, ikke dempes av prefiks-match.
    br._execute_code(
        'class FakeUiB:\n'
        '    def slider(self, *a, **k):\n'
        '        return type("X", (), {"value": 42})()\n'
        'ui = FakeUiB()')
    out = br._execute_code('ui.slider(0, 100).value')
    assert '42' in out
    assert br._get_last_error() == ''

def test_ui_control_call_with_space_before_paren_muted():
    # Korner 3: `ui.slider (0,100)` (mellomrom før parentes) skal nå OGSÅ
    # dempes — evalueringen skjer uansett (calls-lista fylles).
    br._execute_code(
        'class FakeUiC:\n'
        '    def __init__(self):\n'
        '        self.calls = []\n'
        '    def slider(self, *a, **k):\n'
        '        self.calls.append(a)\n'
        '        return 7\n'
        'ui = FakeUiC()')
    out = br._execute_code('ui.slider (0, 100)')
    assert '7' not in out
    assert br._get_last_error() == ''
    out2 = br._execute_code('len(ui.calls)')
    assert '1' in out2

def test_ui_control_call_with_trailing_comment_muted():
    # Kontroll-kall-halen skal tåle en etterfølgende kommentar (samme
    # "bare whitespace/kommentar etter lukke-parentes"-regel som korner 2).
    br._execute_code(
        'class FakeUiD:\n'
        '    def slider(self, *a, **k):\n'
        '        return 9\n'
        'ui = FakeUiD()')
    out = br._execute_code('ui.slider(0, 100)  # juster')
    assert '9' not in out
    assert br._get_last_error() == ''


if __name__ == '__main__':
    # NOTE: iterate in declaration order (not sorted alphabetically) — several
    # tests share state via module globals (e.g. test_figure_embed_marker
    # defines `df`, which test_dataframe_tablehtml_marker and test_show_multiple
    # consume). CPython 3.7+ guarantees globals() preserves definition order.
    for name, fn in list(globals().items()):
        if name.startswith('test_'):
            fn(); print('PASS', name)
