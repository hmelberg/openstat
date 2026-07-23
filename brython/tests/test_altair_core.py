# Enhetstester for shared/altair_core.py — kjøres under CPython:
#   python3 brython/tests/test_altair_core.py
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'shared'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import altair_core as alt


def test_records_from_dict_of_lists():
    recs = alt._records_from_data({"a": [1, 2], "b": ["x", "y"]})
    assert recs == [{"a": 1, "b": "x"}, {"a": 2, "b": "y"}]


def test_records_from_list_of_dicts():
    src = [{"a": 1}, {"a": 2}]
    recs = alt._records_from_data(src)
    assert recs == src and recs is not src


def test_records_from_dataframe_ducktype():
    import pandas_brython as bpd
    recs = alt._records_from_data(bpd.DataFrame({"a": [1, 2], "b": ["x", "y"]}))
    assert recs == [{"a": 1, "b": "x"}, {"a": 2, "b": "y"}]


def test_shorthand_plain_field_infers_type():
    recs = [{"n": 1, "s": "a", "m": None}]
    assert alt._parse_shorthand("n", recs) == {"field": "n", "type": "quantitative"}
    assert alt._parse_shorthand("s", recs) == {"field": "s", "type": "nominal"}
    # bare None-verdier -> nominal (samme fallback som altair for object-kolonner)
    assert alt._parse_shorthand("m", recs)["type"] == "nominal"


def test_shorthand_explicit_typecodes():
    for code, full in [("Q", "quantitative"), ("O", "ordinal"),
                       ("N", "nominal"), ("T", "temporal")]:
        assert alt._parse_shorthand("kol:" + code, []) == {"field": "kol", "type": full}


def test_shorthand_aggregates():
    assert alt._parse_shorthand("mean(v)", [{"v": 1}]) == {
        "aggregate": "mean", "field": "v", "type": "quantitative"}
    assert alt._parse_shorthand("count()", []) == {
        "aggregate": "count", "type": "quantitative"}
    assert alt._parse_shorthand("median(v):O", [])["type"] == "ordinal"


def test_shorthand_unknown_aggregate_raises():
    try:
        alt._parse_shorthand("foo(v)", [])
        assert False, "skulle kastet"
    except ValueError as e:
        assert "foo" in str(e)


def test_infer_bool_is_nominal():
    assert alt._infer_type("b", [{"b": True}]) == "nominal"


def test_channel_class_options():
    ch = alt.X("region:N", sort="-y", title="Region")._channel_dict([])
    assert ch == {"field": "region", "type": "nominal", "sort": "-y", "title": "Region"}


def test_channel_axis_none_disables():
    ch = alt.Y("v:Q", axis=None)._channel_dict([])
    assert ch["axis"] is None


def test_channel_scale_and_bin():
    ch = alt.Y("v:Q", scale=alt.Scale(zero=False))._channel_dict([])
    assert ch["scale"] == {"zero": False}
    b = alt.X("v:Q", bin=alt.Bin(maxbins=10))._channel_dict([])
    assert b["bin"] == {"maxbins": 10}
    b2 = alt.X("v:Q", bin=True)._channel_dict([])
    assert b2["bin"] is True


def test_channel_field_kwarg_infers():
    ch = alt.Color(field="g")._channel_dict([{"g": "a"}])
    assert ch == {"field": "g", "type": "nominal"}


def test_json_safe_nan_and_tuple():
    import pandas_brython as bpd
    assert alt._json_safe({"a": (1, bpd.nan)}) == {"a": [1, None]}
    assert alt._json_safe(float("nan")) is None


def test_value_helper():
    assert alt.value("red") == {"value": "red"}


def test_chart_minimal_spec():
    spec = alt.Chart({"a": [1, 2]}).mark_point().encode(x="a:Q").to_dict()
    assert spec["$schema"] == alt.VEGALITE_SCHEMA
    assert spec["mark"] == {"type": "point"}
    assert spec["data"] == {"values": [{"a": 1}, {"a": 2}]}
    assert spec["encoding"] == {"x": {"field": "a", "type": "quantitative"}}


def test_all_marks():
    c = alt.Chart({"a": [1]})
    for m in ("point", "line", "bar", "area", "circle", "tick",
              "rect", "rule", "text", "boxplot"):
        spec = getattr(c, "mark_" + m)().to_dict()
        assert spec["mark"] == {"type": m}, m


def test_mark_kwargs():
    spec = alt.Chart({"a": [1]}).mark_line(point=True, strokeDash=[4, 2]).to_dict()
    assert spec["mark"] == {"type": "line", "point": True, "strokeDash": [4, 2]}


def test_encode_channel_objects_and_lists():
    spec = (alt.Chart({"g": ["a"], "v": [1]}).mark_bar()
            .encode(x=alt.X("g:N", sort="-y"),
                    y="mean(v):Q",
                    tooltip=["g:N", alt.Tooltip("v:Q", format=".1f")]).to_dict())
    assert spec["encoding"]["x"] == {"field": "g", "type": "nominal", "sort": "-y"}
    assert spec["encoding"]["y"] == {"aggregate": "mean", "field": "v",
                                     "type": "quantitative"}
    assert spec["encoding"]["tooltip"] == [
        {"field": "g", "type": "nominal"},
        {"field": "v", "type": "quantitative", "format": ".1f"}]


def test_encode_unknown_channel_raises():
    try:
        alt.Chart({"a": [1]}).mark_point().encode(theta="a:Q")
        assert False, "skulle kastet"
    except NotImplementedError as e:
        assert "theta" in str(e)


def test_properties_and_defaults():
    spec = (alt.Chart({"a": [1]}).mark_point()
            .properties(width=400, height=250, title="Tittel").to_dict())
    assert spec["width"] == 400 and spec["height"] == 250 and spec["title"] == "Tittel"
    alt.defaults.height = 300
    try:
        spec2 = alt.Chart({"a": [1]}).mark_point().to_dict()
        assert spec2["height"] == 300 and "width" not in spec2
    finally:
        alt.defaults.height = None


def test_interactive_param():
    spec = alt.Chart({"a": [1]}).mark_point().encode(x="a:Q").interactive().to_dict()
    assert len(spec["params"]) == 1
    p = spec["params"][0]
    assert p["name"].startswith("param_")
    assert p["select"] == {"type": "interval", "encodings": ["x", "y"]}
    assert p["bind"] == "scales"


def test_facet_channels():
    spec = (alt.Chart({"a": [1], "g": ["x"]}).mark_point()
            .encode(x="a:Q", column="g:N", row="g:N").to_dict())
    assert spec["encoding"]["column"] == {"field": "g", "type": "nominal"}
    assert spec["encoding"]["row"] == {"field": "g", "type": "nominal"}


def test_nan_becomes_null_in_values():
    import pandas_brython as bpd
    df = bpd.DataFrame({"x": [1, 2], "y": [1.0, bpd.nan]})
    spec = alt.Chart(df).mark_point().encode(x="x:Q", y="y:Q").to_dict()
    assert spec["data"]["values"][1]["y"] is None
    json.dumps(spec)   # må ikke kaste


def test_runner_protocol_and_repr():
    c = alt.Chart({"a": [1]}).mark_point()
    s = c.to_vegalite_json_str()
    assert json.loads(s)["mark"] == {"type": "point"}
    assert "AltairChart" in repr(c)
    assert c.to_json(indent=2).startswith("{")


def test_out_of_scope_raises():
    c = alt.Chart({"a": [1]}).mark_point()
    for attempt in (lambda: c | c, lambda: c & c, lambda: c.facet("a"),
                    lambda: c.transform_filter("x"),
                    lambda: c.transform_calculate(y="x"),
                    lambda: alt.hconcat(c, c), lambda: alt.vconcat(c, c),
                    lambda: alt.selection_point(), lambda: alt.selection_interval(),
                    lambda: alt.condition(None, None, None)):
        try:
            attempt()
            assert False, "skulle kastet NotImplementedError"
        except NotImplementedError:
            pass


def test_layer_shared_data_hoisted():
    df = {"x": [1, 2], "y": [3, 4]}
    # NB: mark_* muterer og returnerer self (dokumentert v1-avvik fra
    # altairs immutabilitet) — bruk derfor to SEPARATE Chart-objekter:
    a = alt.Chart(df).mark_line().encode(x="x:Q", y="y:Q")
    b = alt.Chart(df).mark_point().encode(x="x:Q", y="y:Q")
    spec = (a + b).to_dict()
    assert spec["data"] == {"values": [{"x": 1, "y": 3}, {"x": 2, "y": 4}]}
    assert [sorted(l.keys()) for l in spec["layer"]] == [
        ["encoding", "mark"], ["encoding", "mark"]]
    assert spec["layer"][0]["mark"] == {"type": "line"}
    assert spec["layer"][1]["mark"] == {"type": "point"}


def test_layer_flattens_and_props():
    a = alt.Chart({"x": [1]}).mark_line().encode(x="x:Q")
    b = alt.Chart({"x": [1]}).mark_point().encode(x="x:Q")
    c = alt.Chart({"x": [1]}).mark_rule().encode(x="x:Q")
    spec = ((a + b) + c).properties(title="Lagdelt").to_dict()
    assert len(spec["layer"]) == 3
    assert spec["title"] == "Lagdelt"
    assert spec["$schema"] == alt.VEGALITE_SCHEMA


def test_layer_differing_data_stays_per_layer():
    a = alt.Chart({"x": [1]}).mark_line().encode(x="x:Q")
    b = alt.Chart({"x": [9]}).mark_point().encode(x="x:Q")
    spec = (a + b).to_dict()
    assert "data" not in spec
    assert spec["layer"][0]["data"] == {"values": [{"x": 1}]}
    assert spec["layer"][1]["data"] == {"values": [{"x": 9}]}


def test_layer_interactive_on_top():
    a = alt.Chart({"x": [1]}).mark_line().encode(x="x:Q")
    b = alt.Chart({"x": [1]}).mark_point().encode(x="x:Q")
    spec = (a + b).interactive().to_dict()
    assert spec["params"][0]["bind"] == "scales"


if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_'):
            fn(); print('PASS', name)
    print('ALLE ALTAIR-CORE-TESTER GRØNNE')
