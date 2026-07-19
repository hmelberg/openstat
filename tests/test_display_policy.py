"""Display policy v2 (spec 2026-07-20 §Phase 1): tester den EKTE
_exec_pyodide_block hentet ut av index.html sin JS-template-literal.
Utpakkingen reverserer literal-escapingen: '\\n' i filen er '\n' når
Pyodide får koden — derfor .replace('\\\\', '\\') under. _show_one
stubbes med en opptaker (policy-testene bryr seg om HVA som vises,
ikke hvordan); _m2py_flush_pyplot_figs stubbes som no-op."""
import ast
import pathlib

INDEX = pathlib.Path(__file__).resolve().parents[1] / "index.html"


def _load_core_src():
    text = INDEX.read_text(encoding="utf-8")
    start = text.index("def _exec_pyodide_block(")
    end = text.index("def _duck_concise(", start)
    src = text[start:end]
    return src.replace("\\\\", "\\")


def make_exec_block(shown):
    ns = {
        "ast": ast,
        "_show_one": shown.append,
        "_m2py_flush_pyplot_figs": lambda: None,
    }
    exec(compile(_load_core_src(), "<index.html:_exec_pyodide_block>", "exec"), ns)
    return ns["_exec_pyodide_block"]


def run_block(code, only_last=False, show_commands=False, g=None):
    shown = []
    block = make_exec_block(shown)
    block(code, g if g is not None else {}, show_commands, only_last)
    return shown


# ---- karakterisering: dagens oppførsel (må passere FØR endringene) ----

def test_all_mode_shows_every_bare_expression():
    assert run_block("1 + 1\n'to'\n3") == [2, "to", 3]

def test_only_last_shows_only_last_expression():
    assert run_block("1 + 1\n'to'\n3", only_last=True) == [3]

def test_none_is_suppressed():
    assert run_block("None\nprint") == [print]

def test_assignments_not_displayed():
    assert run_block("x = 5\ny = x + 1") == []

def test_statements_execute_in_order_with_state():
    g = {}
    assert run_block("x = 5\nx + 1\nx = 7\nx + 1", g=g) == [6, 8]
    assert g["x"] == 7

def test_echo_mode_prints_commands(capsys):
    run_block("x = 5", show_commands=True)
    assert ">>> x = 5" in capsys.readouterr().out


# ---- display policy v2: nye dempingsregler (spec §Phase 1, regel 2-4) ----

class FakeUi:
    """Minimal ui-fasade: slider registrerer (sideeffekt) og returnerer
    skalar — som pyodide/ui.py sin pull-modell."""
    def __init__(self):
        self.calls = []
    def slider(self, *a, **k):
        self.calls.append(a)
        return 42
    def value(self, name):
        return 99

def test_underscore_bare_name_suppressed():
    assert run_block("_x = 123\n_x") == []

def test_underscore_name_in_only_last_mode_suppressed():
    assert run_block("_x = 123\n_x", only_last=True) == []

def test_call_on_underscore_name_still_shown():
    assert run_block("_s = 'abc'\n_s.upper()") == ["ABC"]

def test_semicolon_after_expression_mutes():
    assert run_block("5 + 5;") == []

def test_semicolon_then_comment_mutes():
    assert run_block("5 + 5 ;  # kommentar") == []

def test_semicolon_only_inside_comment_shows():
    assert run_block("5 + 5  # merknad;") == [10]

def test_semicolon_between_two_expressions_mutes_first_only():
    assert run_block("'a'; 'b'") == ["b"]

def test_multiline_expression_with_trailing_semicolon_mutes():
    assert run_block("(1 +\n 2);") == []

def test_semicolon_after_nonascii_expression_mutes():
    # end_col_offset er BYTE-offset (utf-8) — 'blåbær' har multibyte-tegn.
    assert run_block("'blåbær';") == []

def test_bare_ui_control_call_registers_but_not_echoed():
    ui = FakeUi()
    assert run_block("ui.slider(0, 100)", g={"ui": ui}) == []
    assert ui.calls == [(0, 100)]

def test_assigned_ui_control_value_displays_via_name():
    ui = FakeUi()
    assert run_block("n = ui.slider(0, 100)\nn", g={"ui": ui}) == [42]

def test_non_control_ui_call_still_shown():
    ui = FakeUi()
    assert run_block("ui.value('n')", g={"ui": ui}) == [99]
