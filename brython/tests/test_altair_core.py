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


if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_'):
            fn(); print('PASS', name)
    print('ALLE ALTAIR-CORE-TESTER (task 1) GRØNNE')
