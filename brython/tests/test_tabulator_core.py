# Enhetstester for shared/tabulator_core.py — kjøres under CPython:
#   python3 brython/tests/test_tabulator_core.py
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'shared'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import tabulator_core as tab


def test_dict_of_lists_basic():
    t = tab.table({'aar': [2020, 2021], 'navn': ['a', 'b']})
    spec = t.to_dict()
    assert [c['field'] for c in spec['columns']] == ['aar', 'navn']
    assert spec['data'] == [{'aar': 2020, 'navn': 'a'}, {'aar': 2021, 'navn': 'b'}]
    aar = spec['columns'][0]
    assert aar['hozAlign'] == 'right' and aar['sorter'] == 'number'
    navn = spec['columns'][1]
    assert 'hozAlign' not in navn and navn['sorter'] == 'string'
    # liten tabell -> ingen paginering
    assert 'pagination' not in spec['options']


def test_list_of_records_and_dataframe_ducktype():
    recs = [{'x': 1, 'y': 'a'}, {'x': 2, 'y': 'b'}]
    t = tab.table(recs)
    assert t.to_dict()['data'] == recs
    import pandas_brython as bpd
    t2 = tab.table(bpd.DataFrame({'x': [1, 2], 'y': ['a', 'b']}))
    assert t2.to_dict()['data'] == recs


def test_real_pandas_nested_to_dict_shape():
    # ekte pandas' to_dict() gir {kol: {idx: verdi}} — kjernen kjører på
    # ekte pandas i pyodide og MÅ håndtere begge formene
    class FakeReal:
        columns = ['x', 'y']
        def to_dict(self):
            return {'x': {0: 1, 1: 2}, 'y': {0: 'a', 1: 'b'}}
    spec = tab.table(FakeReal()).to_dict()
    assert spec['data'] == [{'x': 1, 'y': 'a'}, {'x': 2, 'y': 'b'}]


def test_pagination_auto_threshold():
    big = {'v': list(range(201))}
    spec = tab.table(big).to_dict()
    assert spec['options']['pagination'] == 'local'
    assert spec['options']['paginationSize'] == 20
    small = {'v': list(range(200))}
    assert 'pagination' not in tab.table(small).to_dict()['options']
    explicit = tab.table({'v': [1, 2]}, pagination=50).to_dict()
    assert explicit['options']['paginationSize'] == 50
    off = tab.table(big, pagination=False).to_dict()
    assert 'pagination' not in off['options']


def test_filters_sortable_height_title():
    spec = tab.table({'v': [1]}, filters=True, sortable=False,
                     height=300, title='Tittel').to_dict()
    c = spec['columns'][0]
    assert c['headerFilter'] == 'input' and c['headerSort'] is False
    assert spec['options']['height'] == 300
    assert spec['title'] == 'Tittel'


def test_options_passthrough_wins():
    spec = tab.table({'v': list(range(300))},
                     options={'paginationSize': 5, 'movableColumns': True}).to_dict()
    assert spec['options']['paginationSize'] == 5      # vinner over auto-20
    assert spec['options']['movableColumns'] is True


def test_callable_option_raises():
    try:
        tab.table({'v': [1]}, options={'rowClick': lambda: None})
        assert False
    except TypeError as e:
        assert 'callable' in str(e) or 'funksjon' in str(e)


def test_nan_becomes_none():
    import pandas_brython as bpd
    spec = tab.table(bpd.DataFrame({'v': [1.0, bpd.nan]})).to_dict()
    assert spec['data'][1]['v'] is None
    json.dumps(spec)


def test_runner_protocol_and_repr():
    t = tab.table({'v': [1]})
    assert json.loads(t.to_tabulator_json_str())['data'] == [{'v': 1}]
    assert 'Table' in repr(t)


if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_'):
            fn(); print('PASS', name)
    print('ALLE TABULATOR-CORE-TESTER GRØNNE')
