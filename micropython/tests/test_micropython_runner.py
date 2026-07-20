import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import micropython_runner as mr

ES = '__micro_transform_start_'
EE = '__micro_transform_end__'


def run(capsys, code):
    ret = mr._execute_code(code)
    assert ret == ''          # kontrakt: all output via print, motoren samler
    return capsys.readouterr().out


def test_stdout_and_last_expression(capsys):
    out = run(capsys, 'print("hei")\n1 + 1')
    assert 'hei' in out and '2' in out
    assert mr._get_last_error() == ''


def test_state_persists_between_runs(capsys):
    run(capsys, 'xx = 41')
    out = run(capsys, 'xx + 1')
    assert '42' in out


def test_error_returns_traceback(capsys):
    run(capsys, '1/0')
    assert 'ZeroDivisionError' in mr._get_last_error()


def test_show_string(capsys):
    out = run(capsys, 'show("tekst")')
    assert 'tekst' in out


def test_register_and_alias_module(capsys):
    err = mr._register_module('minmod', 'verdi = 7\ndef dobbel(x):\n    return 2 * x')
    assert err == ''
    err = mr._alias_module('mm', 'minmod')
    assert err == ''
    out = run(capsys, 'import mm\nmm.dobbel(mm.verdi)')
    assert '14' in out


def test_register_module_syntax_error_returns_traceback():
    err = mr._register_module('broken', 'def f(:')
    assert 'SyntaxError' in err
    assert 'broken' not in sys.modules


def test_snapshot_rollback(capsys):
    run(capsys, 'a = 1')
    mr._snapshot()
    run(capsys, 'a = 2\nb = 3')
    mr._rollback()
    out = run(capsys, 'print(a, "b" in dir())')
    assert '1' in out and 'False' in out


def test_bind_datasets_columns(capsys):
    # 'columns'-varianten trenger pandas_mpy, som først finnes i Task 4.
    # Registrer en mini-pandas som _bind_datasets importerer — testen låser
    # KONTRAKTEN (None -> nan, kolonnedict -> frame). VIKTIG: rydd
    # sys.modules før OG etter — pytest deler prosess på tvers av testfiler,
    # og en gjenglemt mini ville skygget den ekte pandas_mpy i senere filer.
    mini = (
        'nan = float("nan")\n'
        'class DataFrame:\n'
        '    def __init__(self, cols):\n'
        '        self.cols = cols\n'
        '    def __len__(self):\n'
        '        return len(next(iter(self.cols.values()), []))\n'
        'def read_csv(f):\n'
        '    rows = [l.split(",") for l in f.getvalue().strip().split(chr(10))]\n'
        '    return DataFrame({h: [r[i] for r in rows[1:]]'
        ' for i, h in enumerate(rows[0])})\n'
    )
    sys.modules.pop('pandas_mpy', None)
    try:
        assert mr._register_module('pandas_mpy', mini) == ''
        spec = {'iris': {'kind': 'csv', 'payload': 'a,b\n1,x\n2,y\n'},
                'tall': {'kind': 'columns', 'payload': {'v': [1, None, 3]}}}
        assert mr._bind_datasets(json.dumps(spec)) == ''
        out = run(capsys, 'print(len(iris), len(tall))')
        assert '2 3' in out
    finally:
        sys.modules.pop('pandas_mpy', None)


def test_pending_signal(capsys):
    run(capsys, 'class _P(BaseException):\n'
                '    __brython_pending__ = True\n'
                'def _kast():\n'
                '    raise _P()')
    run(capsys, '_kast()')
    assert mr._get_last_error() == '__BRYTHON_PENDING__'


def test_indented_last_line_not_evaled_out_of_context(capsys):
    out = run(capsys, 'if True:\n    y = 5\n    y')
    assert mr._get_last_error() == ''


def test_reset_clears_user_vars(capsys):
    run(capsys, 'zz_fasec = 99')
    assert mr._reset() == ''
    out = run(capsys, "print('zz_fasec' in globals())")
    assert 'False' in out


def test_reset_keeps_baseline_show(capsys):
    mr._reset()
    out = run(capsys, "show('fasec-baseline')")
    assert 'fasec-baseline' in out


def test_reset_clears_last_error(capsys):
    run(capsys, '1/0')
    assert mr._get_last_error() != ''
    assert mr._reset() == ''
    assert mr._get_last_error() == ''


def test_reset_twice_is_safe(capsys):
    assert mr._reset() == ''
    assert mr._reset() == ''


def test_reset_keeps_registered_modules(capsys):
    assert mr._register_module('fasec_dummy_mpy', 'V = 7') == ''
    mr._reset()
    out = run(capsys, 'import fasec_dummy_mpy\nprint(fasec_dummy_mpy.V)')
    assert '7' in out


class _HostileDict(dict):
    """Dict-subklasse hvis __delitem__ kaster for én navngitt "forgiftet"
    nøkkel - speiler brython_runner.py sin tvilling-test (samme exit gate-
    funn 2026-07-18, paritetsherding: MicroPython har ikke selve Brython
    3.12-scoping-bugen, men robusthetsprinsippet - én kastende nøkkel skal
    aldri abortere hele per-nøkkel del-loopet - gjelder likt her)."""
    def __init__(self, *a, poison_key=None, **kw):
        super().__init__(*a, **kw)
        self._poison_key = poison_key

    def __delitem__(self, key):
        if key == self._poison_key:
            raise KeyError(key)
        super().__delitem__(key)


def test_reset_survives_poisoned_key_that_raises_on_del(capsys):
    # Regresjonstest for exit gate-funn 1s paritetsherding (2026-07-18):
    # _reset()s per-nøkkel del-loop skal aldri abortere pga én forgiftet
    # nøkkel, og gjenopprettingsloopet (restaurerer 'show' m.fl.) skal
    # alltid kjøre uansett.
    orig = mr._shared_vars
    try:
        hostile = _HostileDict(orig, poison_key='rad_leaked_mpy')
        hostile['rad_leaked_mpy'] = 42
        hostile['other_stray_mpy'] = 'x'
        mr._shared_vars = hostile
        err = mr._reset()
        assert err == ''
        assert 'other_stray_mpy' not in mr._shared_vars
        assert 'rad_leaked_mpy' in mr._shared_vars
        assert mr._shared_vars['show'] is mr._baseline_vars['show']
        out = run(capsys, "show('post-reset-ok-mpy')")
        assert 'post-reset-ok-mpy' in out
    finally:
        mr._shared_vars = orig


# ── ui sync_to (fase 3): _sync_var ─────────────────────────────────────────

def test_sync_var_writes_shared_vars():
    err = mr._sync_var('n', '7')
    assert err == ''
    assert mr._shared_vars['n'] == 7
    err = mr._sync_var('s', '"hei"')
    assert err == ''
    assert mr._shared_vars['s'] == 'hei'


def test_sync_var_bad_json_returns_error():
    mr._shared_vars.pop('x', None)
    err = mr._sync_var('x', '{not json')
    assert err != ''
    assert 'x' not in mr._shared_vars


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
    assert mr._fmt(el) == ''
    assert el.shown == 1


def test_fmt_element_raising_show_does_not_crash():
    # Defensiv kontrakt (spec: "exception-safe - a raising show() must not
    # kill the cell"): en show() som kaster fanges HER (ikke bare inni
    # Element.show() sin egen try/except rundt selve elShow-broen), og
    # _fmt returnerer uansett '' - IKKE en feiltekst (samme forsiktige
    # linje som resten av _fmt/brython-tvillingen).
    el = _FakeEl(raises=True)
    assert mr._fmt(el) == ''
    assert el.shown == 1


def test_execute_code_element_last_expression_mounts_no_blank_line(capsys):
    # Kallstedet (~134-136): shown == '' skal ikke printes (ingen blank
    # linje) - end-to-end via _execute_code, ikke bare _fmt direkte.
    mr._shared_vars['_el_rt'] = _FakeEl()
    ret = mr._execute_code('print("før")\n_el_rt')
    assert ret == ''
    out = capsys.readouterr().out
    assert out == 'før' + chr(10)
    assert mr._shared_vars['_el_rt'].shown == 1


def test_show_element_mounts_no_blank_line(capsys):
    # _show() (den eksplisitte show(x)-funksjonen, linje ~63-65) manglet
    # samme `if shown:`-vakt som sist-uttrykk-kroken over (linje ~150-152):
    # show(element) kalte print(_fmt(o)) UBETINGET, og print('') skriver en
    # tom linje selv om elementet alt ble montert av _fmt sin egen
    # obj.show()-gren (samme mekanisme som test_fmt_mounts_element_and_
    # returns_empty over dokumenterer). Reviewer-funn fra samme gjennomgang
    # som data-ui-shown-for-kjøringsrensken i js/cells.js (commit 15ce63c) —
    # port av Brython-tvillingens test.
    mr._shared_vars['_el_arg'] = _FakeEl()
    ret = mr._execute_code('print("før")\nshow(_el_arg)\nprint("etter")')
    assert ret == ''
    out = capsys.readouterr().out
    assert out == 'før' + chr(10) + 'etter' + chr(10)
    assert mr._shared_vars['_el_arg'].shown == 1


# ---- display policy v2 (spec 2026-07-20 §Phase 1) på trailing-uttrykket ----

def test_underscore_bare_name_trailing_not_displayed(capsys):
    run(capsys, '_hemmelig = 123')
    out = run(capsys, '_hemmelig')
    assert '123' not in out
    assert mr._get_last_error() == ''


def test_call_on_underscore_name_still_displayed(capsys):
    run(capsys, '_tekst = "abc"')
    out = run(capsys, '_tekst.upper()')
    assert 'ABC' in out


def test_trailing_semicolon_mutes_display(capsys):
    out = run(capsys, 'sv = 7\nsv;')
    assert '7' not in out
    assert mr._get_last_error() == ''


def test_ui_control_call_evaluated_but_not_echoed(capsys):
    run(capsys,
        'class FakeUi:\n'
        '    def __init__(self):\n'
        '        self.calls = []\n'
        '    def slider(self, *a, **k):\n'
        '        self.calls.append(a)\n'
        '        return 42\n'
        'ui = FakeUi()')
    out = run(capsys, 'ui.slider(0, 100)')
    assert '42' not in out
    assert mr._get_last_error() == ''
    out2 = run(capsys, 'len(ui.calls)')
    assert '1' in out2


def test_non_control_ui_call_still_displayed(capsys):
    run(capsys,
        'class FakeUi2:\n'
        '    def value(self, name):\n'
        '        return 99\n'
        'ui = FakeUi2()')
    out = run(capsys, 'ui.value("n")')
    assert '99' in out
