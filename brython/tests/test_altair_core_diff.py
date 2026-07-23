# Differensialtester for altair_core: fasit er EKTE altair (6.2.2) sin
# to_dict(). Hele spec-er sammenlignes etter normalisering (drop
# $schema/config/usermeta, resolér named-dataset-indireksjon, normaliser
# param-navn). Kjøres under CPython:
#   python3 brython/tests/test_altair_core_diff.py
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'shared'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import altair_core as malt
import pandas_brython as bpd

try:
    import altair as ralt
    import pandas as rpd
    HAS_ALTAIR = True
except ImportError:
    HAS_ALTAIR = False

D = {"aar": [2020, 2021, 2022, 2020, 2021, 2022],
     "antall": [1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
     "region": ["A", "A", "A", "B", "B", "B"]}


def norm(spec):
    spec = json.loads(json.dumps(spec, default=str))
    spec.pop('$schema', None)
    spec.pop('config', None)
    spec.pop('usermeta', None)
    ds = spec.pop('datasets', None)

    def walk(node):
        if isinstance(node, dict):
            d = node.get('data')
            if isinstance(d, dict) and 'name' in d and ds and d['name'] in ds:
                node['data'] = {'values': ds[d['name']]}
            for p in node.get('params') or []:
                if isinstance(p, dict) and 'name' in p:
                    p['name'] = 'param'
                if isinstance(p, dict) and 'views' in p:
                    p['views'] = ['view' for _ in p['views']]
            # lag-navn (view-scoping for interval-params): altair hasher,
            # vi teller — normaliser KUN layer-oppføringenes name-nøkkel
            # (aldri encoding/data-felter som tilfeldigvis heter 'name')
            for entry in node.get('layer') or []:
                if isinstance(entry, dict) and isinstance(entry.get('name'), str):
                    entry['name'] = 'view'
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)
    walk(spec)
    return spec


def pair(build_mine, build_real):
    mine = norm(build_mine(malt, bpd.DataFrame(D)).to_dict())
    real = norm(build_real(ralt, rpd.DataFrame(D)).to_dict())
    assert mine == real, '\nMIN:  %s\nEKTE: %s' % (
        json.dumps(mine, sort_keys=True), json.dumps(real, sort_keys=True))


def test_marks_match():
    if not HAS_ALTAIR:
        return
    for m in ("point", "line", "bar", "area", "circle", "tick",
              "rect", "rule", "boxplot"):
        pair(lambda a, df, m=m: getattr(a.Chart(df), "mark_" + m)()
             .encode(x="aar:O", y="antall:Q"),
             lambda a, df, m=m: getattr(a.Chart(df), "mark_" + m)()
             .encode(x="aar:O", y="antall:Q"))


def test_shorthand_and_channel_equivalence():
    if not HAS_ALTAIR:
        return
    pair(lambda a, df: a.Chart(df).mark_point().encode(
            x="aar", y="mean(antall)", color="region"),
         lambda a, df: a.Chart(df).mark_point().encode(
            x="aar", y="mean(antall)", color="region"))
    pair(lambda a, df: a.Chart(df).mark_bar().encode(
            x=a.X("region:N", sort="-y", title="Region"),
            y=a.Y("antall:Q", scale=a.Scale(zero=False), axis=None)),
         lambda a, df: a.Chart(df).mark_bar().encode(
            x=a.X("region:N", sort="-y", title="Region"),
            y=a.Y("antall:Q", scale=a.Scale(zero=False), axis=None)))


def test_bin_count_tooltip():
    if not HAS_ALTAIR:
        return
    pair(lambda a, df: a.Chart(df).mark_bar().encode(
            x=a.X("antall:Q", bin=True), y="count()"),
         lambda a, df: a.Chart(df).mark_bar().encode(
            x=a.X("antall:Q", bin=True), y="count()"))
    pair(lambda a, df: a.Chart(df).mark_point().encode(
            x="aar:Q", y="antall:Q",
            tooltip=[a.Tooltip("antall:Q", format=".1f"), "region:N"]),
         lambda a, df: a.Chart(df).mark_point().encode(
            x="aar:Q", y="antall:Q",
            tooltip=[a.Tooltip("antall:Q", format=".1f"), "region:N"]))


def test_properties_and_interactive():
    if not HAS_ALTAIR:
        return
    pair(lambda a, df: a.Chart(df).mark_point().encode(x="aar:Q")
         .properties(width=400, height=250, title="Tittel"),
         lambda a, df: a.Chart(df).mark_point().encode(x="aar:Q")
         .properties(width=400, height=250, title="Tittel"))
    pair(lambda a, df: a.Chart(df).mark_point()
         .encode(x="aar:Q", y="antall:Q").interactive(),
         lambda a, df: a.Chart(df).mark_point()
         .encode(x="aar:Q", y="antall:Q").interactive())


def test_layer_matches():
    if not HAS_ALTAIR:
        return
    def build(a, df):
        return (a.Chart(df).mark_line().encode(x="aar:O", y="antall:Q")
                + a.Chart(df).mark_point().encode(x="aar:O", y="antall:Q"))
    pair(build, build)


def test_layer_interactive_matches():
    if not HAS_ALTAIR:
        return
    def build(a, df):
        return (a.Chart(df).mark_line().encode(x="aar:O", y="antall:Q")
                + a.Chart(df).mark_point().encode(x="aar:O", y="antall:Q")
                ).interactive()
    pair(build, build)


def test_column_facet_matches():
    if not HAS_ALTAIR:
        return
    pair(lambda a, df: a.Chart(df).mark_point().encode(
            x="aar:O", y="antall:Q", column="region:N"),
         lambda a, df: a.Chart(df).mark_point().encode(
            x="aar:O", y="antall:Q", column="region:N"))


if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_'):
            fn(); print('PASS', name)
    print('ALLE ALTAIR-DIFF-TESTER GRØNNE' + ('' if HAS_ALTAIR else ' (uten altair-fasit)'))
