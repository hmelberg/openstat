# micropython micropython/tests/mpy_smoke_tabulator.py   (fra repo-roten)
import sys, json
sys.path.insert(0, 'shared')
sys.path.insert(0, 'micropython')
import tabulator_mpy as tab

t = tab.table({'aar': [2020, 2021], 'antall': [3, None]},
              filters=True, title='Røyk')
spec = json.loads(t.to_tabulator_json_str())
assert spec['title'] == 'Røyk'
assert spec['data'][1]['antall'] is None
assert spec['columns'][0]['headerFilter'] == 'input'
print('MPY-TABULATOR-RØYK OK')
