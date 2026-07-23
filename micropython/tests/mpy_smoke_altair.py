# micropython micropython/tests/mpy_smoke_altair.py   (fra repo-roten)
import sys, json
sys.path.insert(0, 'shared')
sys.path.insert(0, 'micropython')
import altair_mpy as alt

chart = (alt.Chart({"x": [1, 2, 3], "g": ["a", "b", "a"]})
         .mark_bar()
         .encode(x="g:N", y="mean(x):Q", tooltip=["g:N", "x:Q"])
         .properties(width=300, title="Røyk")
         .interactive())
spec = json.loads(chart.to_vegalite_json_str())
assert spec["mark"] == {"type": "bar"}, spec
assert spec["encoding"]["y"]["aggregate"] == "mean"
assert spec["title"] == "Røyk"
layered = (alt.Chart({"x": [1]}).mark_line().encode(x="x:Q")
           + alt.Chart({"x": [1]}).mark_point().encode(x="x:Q"))
assert "layer" in layered.to_dict()
print("MPY-ALTAIR-RØYK OK")
