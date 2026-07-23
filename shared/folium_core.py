"""folium_core — delt Leaflet-kart-bygger (folium-API-subset) for
brython/micropython/CPython (spec 2026-07-24-folium-shim-design.md).
Samme dialektregler som altair_core.py (se dens filhode +
micropython/plotly_express_mpy.py-fellelisten). Python-siden bygger en
liten deklarativ spec ({center, zoom, tiles, layers}); JS-siden
(mdRenderLeafletMap i index.html) oversetter til Leaflet-kall. ALL
choropleth-farge-/bin-logikk ligger HER (testbar uten browser)."""

import json

TILES = {
    'OpenStreetMap': {
        'url': 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        'attribution': '&copy; OpenStreetMap contributors'},
    'CartoDB positron': {
        'url': 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
        'attribution': '&copy; OpenStreetMap contributors &copy; CARTO'},
}

# 9-klasse ColorBrewer-ankre; n-klasse-skalaer interpoleres lineært
# mellom ankrene (samme idé som branca.LinearColormap i ekte folium).
PALETTES = {
    'YlOrRd': ['#ffffcc', '#ffeda0', '#fed976', '#feb24c', '#fd8d3c',
               '#fc4e2a', '#e31a1c', '#bd0026', '#800026'],
    'YlGnBu': ['#ffffd9', '#edf8b1', '#c7e9b4', '#7fcdbb', '#41b6c4',
               '#1d91c0', '#225ea8', '#253494', '#081d58'],
    'Blues':  ['#f7fbff', '#deebf7', '#c6dbef', '#9ecae1', '#6baed6',
               '#4292c6', '#2171b5', '#08519c', '#08306b'],
    'Greens': ['#f7fcf5', '#e5f5e0', '#c7e9c0', '#a1d99b', '#74c476',
               '#41ab5d', '#238b45', '#006d2c', '#00441b'],
    'Reds':   ['#fff5f0', '#fee0d2', '#fcbba1', '#fc9272', '#fb6a4a',
               '#ef3b2c', '#cb181d', '#a50f15', '#67000d'],
    'Purples': ['#fcfbfd', '#efedf5', '#dadaeb', '#bcbddc', '#9e9ac8',
                '#807dba', '#6a51a3', '#54278f', '#3f007d'],
}


def _is_nan(v):
    if v is None:
        return True
    if type(v).__name__ == 'NaN':
        return True
    return isinstance(v, float) and v != v


def _zpad(s, n):
    """Zero-padding uten str.zfill (MicroPython-byggavhengig)."""
    s = str(s)
    while len(s) < n:
        s = '0' + s
    return s


def _hex_to_rgb(h):
    h = h.lstrip('#')
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def _rgb_to_hex(rgb):
    return '#%02x%02x%02x' % rgb


def _interp_palette(name, n):
    """n farger jevnt fordelt langs palettens ankerpunkter."""
    if name not in PALETTES:
        raise ValueError('Ukjent palett: ' + str(name) + ' (tilgjengelig: '
                         + ', '.join(sorted(PALETTES.keys())) + ')')
    anchors = [_hex_to_rgb(c) for c in PALETTES[name]]
    if n <= 1:
        return [_rgb_to_hex(anchors[-1])]
    out = []
    m = len(anchors) - 1
    for i in range(n):
        pos = i * m / (n - 1)
        lo = int(pos)
        if lo >= m:
            out.append(_rgb_to_hex(anchors[m]))
            continue
        frac = pos - lo
        a, b = anchors[lo], anchors[lo + 1]
        rgb = (int(round(a[0] + (b[0] - a[0]) * frac)),
               int(round(a[1] + (b[1] - a[1]) * frac)),
               int(round(a[2] + (b[2] - a[2]) * frac)))
        out.append(_rgb_to_hex(rgb))
    return out


def _linear_bins(vmin, vmax, n):
    if vmax <= vmin:
        vmax = vmin + 1.0
    step = (vmax - vmin) / n
    return [vmin + step * i for i in range(n)] + [vmax]


def _clean(d):
    """Fjern None-verdier (grunn — lagdicts er flate)."""
    out = {}
    for k in d:
        if d[k] is not None:
            out[k] = d[k]
    return out


class _Layer:
    """Basisklasse: folium-mønsteret obj.add_to(m)."""

    def add_to(self, m):
        m.add_child(self)
        return self


class Map:
    def __init__(self, location=None, zoom_start=None,
                 tiles='OpenStreetMap', width=None, height=None):
        if tiles not in TILES:
            raise ValueError('Ukjente tiles: ' + str(tiles)
                             + ' (tilgjengelig: '
                             + ', '.join(sorted(TILES.keys())) + ')')
        self._center = list(location) if location is not None else None
        self._zoom = zoom_start
        self._tiles = tiles
        self._width = width
        self._height = height
        self._layers = []

    def add_child(self, child):
        self._layers.append(child._layer_dict())
        return self

    def to_dict(self):
        spec = {'center': self._center, 'zoom': self._zoom,
                'tiles': self._tiles, 'layers': list(self._layers)}
        if self._width is not None:
            spec['width'] = self._width
        if self._height is not None:
            spec['height'] = self._height
        return spec

    def to_leaflet_json_str(self):
        """Runner-protokollen (_fmt): hele spec-en som JSON-streng."""
        return json.dumps(self.to_dict())

    def show(self):
        return str(self)

    def __str__(self):
        return '<FoliumMap: use show() or leave as last expression>'

    def __repr__(self):
        return str(self)

    def _repr_html_(self):
        return str(self)


class Marker(_Layer):
    def __init__(self, location, popup=None, tooltip=None):
        self._d = _clean({'type': 'marker', 'location': list(location),
                          'popup': popup, 'tooltip': tooltip})

    def _layer_dict(self):
        return dict(self._d)


class CircleMarker(_Layer):
    _TYPE = 'circle_marker'

    def __init__(self, location, radius=10, color=None, fill=None,
                 fill_color=None, fill_opacity=None, weight=None,
                 opacity=None, popup=None, tooltip=None):
        self._d = _clean({'type': self._TYPE, 'location': list(location),
                          'radius': radius, 'color': color, 'fill': fill,
                          'fill_color': fill_color,
                          'fill_opacity': fill_opacity, 'weight': weight,
                          'opacity': opacity, 'popup': popup,
                          'tooltip': tooltip})

    def _layer_dict(self):
        return dict(self._d)


class Circle(CircleMarker):
    # radius i METER (Leaflet L.circle) — CircleMarker er piksler
    _TYPE = 'circle'


class PolyLine(_Layer):
    _TYPE = 'polyline'

    def __init__(self, locations, color=None, weight=None, opacity=None,
                 popup=None, tooltip=None):
        self._d = _clean({'type': self._TYPE,
                          'locations': [list(p) for p in locations],
                          'color': color, 'weight': weight,
                          'opacity': opacity, 'popup': popup,
                          'tooltip': tooltip})

    def _layer_dict(self):
        return dict(self._d)


class Polygon(PolyLine):
    _TYPE = 'polygon'

    def __init__(self, locations, color=None, weight=None, opacity=None,
                 fill=None, fill_color=None, fill_opacity=None,
                 popup=None, tooltip=None):
        PolyLine.__init__(self, locations, color=color, weight=weight,
                          opacity=opacity, popup=popup, tooltip=tooltip)
        extra = _clean({'fill': fill, 'fill_color': fill_color,
                        'fill_opacity': fill_opacity})
        for k in extra:
            self._d[k] = extra[k]


class GeoJson(_Layer):
    def __init__(self, data, name=None, style=None, tooltip_fields=None):
        if callable(style):
            raise TypeError('style som funksjon er utenfor v1 — bruk en '
                            'stil-dict ({"color": ..., "weight": ...})')
        d = {'type': 'geojson', 'name': name, 'style': style,
             'tooltip_fields': tooltip_fields}
        if isinstance(data, str):
            d['url'] = data
        elif isinstance(data, dict):
            d['data'] = data
        else:
            raise ValueError('GeoJson: forventer dict eller url-streng')
        self._d = _clean(d)

    def _layer_dict(self):
        return dict(self._d)


class FeatureGroup(_Layer):
    def __init__(self, name=None):
        self._name = name
        self._children = []

    def add_child(self, child):
        self._children.append(child._layer_dict())
        return self

    def _layer_dict(self):
        return _clean({'type': 'feature_group', 'name': self._name,
                       'layers': list(self._children)})


class LayerControl(_Layer):
    def _layer_dict(self):
        return {'type': 'layer_control'}


def _data_to_pairs(data, columns):
    """Choropleth-data -> [(nøkkel, verdi)]: dict {kode: verdi} eller
    DataFrame + columns=[nøkkelkolonne, verdikolonne] (duck-typet som
    altair_core._records_from_data)."""
    if hasattr(data, 'columns') and hasattr(data, 'to_dict'):
        if not columns or len(columns) != 2:
            raise ValueError('Choropleth med DataFrame krever '
                             "columns=['nøkkelkolonne', 'verdikolonne']")
        cols = data.to_dict()
        keys = list(cols[columns[0]])
        vals = list(cols[columns[1]])
        return list(zip(keys, vals))
    if isinstance(data, dict):
        return [(k, data[k]) for k in data]
    raise ValueError('Choropleth: data må være dict {kode: verdi} '
                     'eller DataFrame med columns=[...]')


class Choropleth(_Layer):
    def __init__(self, geo_data, data=None, columns=None, key_on='nummer',
                 fill_color='YlOrRd', bins=6, nan_fill_color='#d9d9d9',
                 fill_opacity=0.7, line_opacity=0.4, legend_name=None,
                 name=None):
        d = {'type': 'choropleth', 'key_on': key_on,
             'nan_fill_color': nan_fill_color, 'fill_opacity': fill_opacity,
             'line_opacity': line_opacity, 'name': name}
        pad = 0
        if geo_data == 'norge:kommuner':
            d['geo'] = geo_data
            pad = 4
        elif geo_data == 'norge:fylker':
            d['geo'] = geo_data
            pad = 2
        elif isinstance(geo_data, str) and (
                geo_data.startswith('http://')
                or geo_data.startswith('https://')):
            d['url'] = geo_data
        elif isinstance(geo_data, dict):
            d['data'] = geo_data
        else:
            raise ValueError("Choropleth: geo_data må være 'norge:kommuner',"
                             " 'norge:fylker', en url eller en geojson-dict")
        pairs = _data_to_pairs(data, columns) if data is not None else []
        clean_pairs = []
        for k, v in pairs:
            if _is_nan(v):
                continue
            key = _zpad(k, pad) if pad else str(k)
            clean_pairs.append((key, float(v)))
        if clean_pairs:
            vals = [v for _, v in clean_pairs]
            if isinstance(bins, (list, tuple)):
                edges = [float(b) for b in bins]
                nb = len(edges) - 1
            else:
                nb = int(bins)
                edges = _linear_bins(min(vals), max(vals), nb)
            colors = _interp_palette(fill_color, nb)
            code_colors = {}
            for key, v in clean_pairs:
                idx = nb - 1
                for i in range(nb):
                    if v <= edges[i + 1]:
                        idx = i
                        break
                code_colors[key] = colors[idx]
            d['colors'] = code_colors
            d['legend'] = _clean({'title': legend_name, 'bins': edges,
                                  'colors': colors})
        else:
            d['colors'] = {}
        self._d = _clean(d)

    def _layer_dict(self):
        return dict(self._d)
