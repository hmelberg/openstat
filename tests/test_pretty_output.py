"""Pretty output (spec 2026-07-30): tester den EKTE _show_one/show-kjeden
hentet ut av index.html sin JS-template-literal (samme utpakkings-idé som
test_display_policy.py). pandas fakes (isinstance-sjekkene treffer
fake-klassene); tabulator stubbes i sys.modules."""
import io
import json
import pathlib
import sys
import types

import pytest

INDEX = pathlib.Path(__file__).resolve().parents[1] / "index.html"


def _load_pretty_src():
    text = INDEX.read_text(encoding="utf-8")
    start = text.index("_PRETTY = [True]")
    end = text.index("def to_microdata(", start)
    return text[start:end].replace("\\\\", "\\")


class FakeSeries:
    def __init__(self, values):
        self.values = values
    def to_frame(self):
        return FakeDF({"v": self.values})
    def __str__(self):
        return "SERIES-TEXT"


class FakeDF:
    def __init__(self, cols):
        self.cols = cols
        self.columns = list(cols)
    def to_html(self, **kw):
        return '<table class="dataframe"><tr><td>x</td></tr></table>'
    def __str__(self):
        return "DF-TEXT"


class FakeTable:
    def __init__(self, df, **kw):
        self.df = df
        self.kw = kw
    def to_tabulator_json_str(self):
        return json.dumps({"kw": sorted(k for k, v in self.kw.items() if v)})


@pytest.fixture
def ns(monkeypatch):
    tabmod = types.ModuleType("tabulator")
    tabmod.calls = []
    def _table(df, **kw):
        t = FakeTable(df, **kw)
        tabmod.calls.append(t)
        return t
    tabmod.table = _table
    monkeypatch.setitem(sys.modules, "tabulator", tabmod)
    pd = types.ModuleType("pd")
    pd.DataFrame = FakeDF
    pd.Series = FakeSeries
    n = {"pd": pd,
         "_EMBED_S": "__micro_transform_start_",
         "_EMBED_E": "__micro_transform_end__"}
    exec(compile(_load_pretty_src(), "<index.html:pretty>", "exec"), n)
    n["_tabmod"] = tabmod
    return n


def _out(capsys):
    return capsys.readouterr().out


def test_pretty_df_gives_tablehtml(ns, capsys):
    ns["_show_one"](FakeDF({"a": [1]}))
    out = _out(capsys)
    assert "tablehtml__" in out and "DF-TEXT" not in out


def test_pretty_off_df_gives_text(ns, capsys):
    ns["_PRETTY"][0] = False
    ns["_show_one"](FakeDF({"a": [1]}))
    out = _out(capsys)
    assert "DF-TEXT" in out and "tablehtml__" not in out


def test_defaults_text_gives_text(ns, capsys):
    ns["show"].defaults["dataframe"] = "text"
    ns["_show_one"](FakeDF({"a": [1]}))
    assert "DF-TEXT" in _out(capsys)


def test_defaults_tabulator_gives_tabulator(ns, capsys):
    ns["show"].defaults["dataframe"] = "tabulator"
    ns["_show_one"](FakeDF({"a": [1]}))
    assert "tabulator__" in _out(capsys)


def test_defaults_unknown_value_falls_back_to_html(ns, capsys):
    ns["show"].defaults["dataframe"] = "excel"
    ns["_show_one"](FakeDF({"a": [1]}))
    assert "tablehtml__" in _out(capsys)


def test_series_via_to_frame(ns, capsys):
    ns["_show_one"](FakeSeries([1, 2]))
    assert "tablehtml__" in _out(capsys)


def test_show_format_tabulator_overrides_defaults(ns, capsys):
    ns["show"](FakeDF({"a": [1]}), format="tabulator")
    assert "tabulator__" in _out(capsys)


def test_show_format_works_even_when_pretty_off(ns, capsys):
    ns["_PRETTY"][0] = False
    ns["show"](FakeDF({"a": [1]}), format="tabulator")
    assert "tabulator__" in _out(capsys)


def test_show_unknown_format_raises(ns):
    with pytest.raises(ValueError) as e:
        ns["show"](FakeDF({"a": [1]}), format="pdf")
    assert "tabulator" in str(e.value)


def test_show_kwargs_forwarded_to_tabulator(ns, capsys):
    ns["show"](FakeDF({"a": [1]}), format="tabulator", title="T", filters=True)
    assert ns["_tabmod"].calls[-1].kw.get("title") == "T"
    assert ns["_tabmod"].calls[-1].kw.get("filters") is True


def test_repr_html_fallback_when_pretty(ns, capsys):
    class Rich:
        def _repr_html_(self):
            return "<b>rik</b>"
    ns["_show_one"](Rich())
    out = _out(capsys)
    assert "html__" in out and "<b>rik</b>" in out


def test_repr_html_skipped_when_pretty_off(ns, capsys):
    class Rich:
        def _repr_html_(self):
            return "<b>rik</b>"
    ns["_PRETTY"][0] = False
    ns["_show_one"](Rich())
    assert "html__" not in _out(capsys)


def test_repr_html_skipped_when_default_not_auto(ns, capsys):
    class Rich:
        def _repr_html_(self):
            return "<b>rik</b>"
    ns["show"].defaults["default"] = "text"
    ns["_show_one"](Rich())
    assert "html__" not in _out(capsys)


def test_ui_element_mounts_never_html_embed(ns, capsys):
    calls = []
    class El:
        _openstat_el_id = "el-1"
        def _repr_html_(self):
            return "<a>lenke</a>"
        def show(self):
            calls.append("mounted")
    ns["_show_one"](El())
    out = _out(capsys)
    assert calls == ["mounted"] and "html__" not in out


def test_plain_objects_still_print(ns, capsys):
    ns["_show_one"](42)
    assert "42" in _out(capsys)
