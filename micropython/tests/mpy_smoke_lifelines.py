# micropython micropython/tests/mpy_smoke_lifelines.py   (fra repo-roten)
import sys, json
sys.path.insert(0, 'shared')
sys.path.insert(0, 'micropython')
import lifelines_mpy as ll

T = [5, 6, 6, 2, 4, 4, 6, 7, 3, 9]
E = [1, 0, 1, 1, 1, 0, 1, 1, 1, 0]
kmf = ll.KaplanMeierFitter().fit(T, E)
assert abs(kmf._sf[5] - 0.35) < 1e-9
assert kmf.median_survival_time_ == 6.0
fig = kmf.plot_survival_function()
spec = json.loads(fig.to_plotly_json_str())
assert any(t.get('line', {}).get('shape') == 'hv' for t in spec['data'])
r = ll.statistics.logrank_test(T, [1, 4, 4, 5, 8, 9], E, [1, 1, 0, 1, 1, 1])
assert abs(r.p_value - 0.8709343067602499) < 1e-8
cph = ll.CoxPHFitter().fit({'T': T, 'E': E,
                            'x': [1, 0, 1, 0, 1, 0, 1, 0, 1, 0]}, 'T', 'E')
assert 'x' in cph.params_
print('MPY-LIFELINES-RØYK OK')
