"""Bygg static_data/{kommuner,fylker}_2024.geojson fra
robhop/fylker-og-kommuner (Kartverket-avledet, CC BY 4.0).

Kjøres manuelt fra repo-roten når grensene skal oppdateres:
    python3 tools/build_norge_geojson.py
Forenkler med Douglas-Peucker + koordinatavrunding til målstørrelsene
(kommuner < 2 MB, fylker < 500 kB) og normaliserer egenskapene til
{nummer, navn}."""
import json
import urllib.request
import os

SRC = {
    'kommuner': ('https://raw.githubusercontent.com/robhop/'
                 'fylker-og-kommuner/main/Kommuner-M.geojson',
                 'kommunenummer', 'kommunenavn', 4, 0.0015),
    'fylker':   ('https://raw.githubusercontent.com/robhop/'
                 'fylker-og-kommuner/main/Fylker-M.geojson',
                 'fylkesnummer', 'fylkesnavn', 2, 0.004),
}
ATTRIB = ('Grenser: Kartverket (CC BY 4.0) via '
          'github.com/robhop/fylker-og-kommuner')
OUT = os.path.join(os.path.dirname(__file__), '..', 'static_data')


def dp(points, tol):
    """Iterativ Douglas-Peucker (rekursjonstrygg) på [[lon, lat], ...]."""
    n = len(points)
    if n < 3:
        return points
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        ax, ay = points[a]
        bx, by = points[b]
        dx, dy = bx - ax, by - ay
        norm = (dx * dx + dy * dy) ** 0.5 or 1e-12
        maxd, idx = -1.0, -1
        for i in range(a + 1, b):
            px, py = points[i]
            d = abs(dy * (px - ax) - dx * (py - ay)) / norm
            if d > maxd:
                maxd, idx = d, i
        if maxd > tol:
            keep[idx] = True
            stack.append((a, idx))
            stack.append((idx, b))
    return [p for p, k in zip(points, keep) if k]


def dp_ring(ring, tol):
    """DP på LUKKET ring: første==siste punkt gjør ankerlinjen degenerert
    (alle avstander 0 -> alt kollapser til 2 punkter). Split ved punktet
    lengst fra start og kjør DP på hver halvdel."""
    if len(ring) > 3 and ring[0] == ring[-1]:
        x0, y0 = ring[0]
        far, fd = 1, -1.0
        for i in range(1, len(ring) - 1):
            x, y = ring[i]
            d = (x - x0) * (x - x0) + (y - y0) * (y - y0)
            if d > fd:
                fd, far = d, i
        first = dp(ring[:far + 1], tol)
        second = dp(ring[far:], tol)
        return first[:-1] + second
    return dp(ring, tol)


def signed_area(ring):
    """Shoelace i (lon, lat)-planet: positiv = mot klokka (CCW)."""
    a = 0.0
    for i in range(len(ring) - 1):
        x1, y1 = ring[i]
        x2, y2 = ring[i + 1]
        a += x1 * y2 - x2 * y1
    return a / 2.0


def enforce_winding(ring, exterior):
    """d3-geo (plotly.js' geo-traces) tolker ringretning sfærisk: en
    feil-vunnet ytterring rendres som «hele kloden minus polygonet»
    (browser-funn 2026-07-24 — lilla verdensrektangel). Leaflet/folium
    bryr seg ikke, så filene kan trygt normaliseres: ytterringer MED
    klokka (negativ shoelace), hull MOT klokka."""
    a = signed_area(ring)
    if exterior and a > 0:
        return ring[::-1]
    if not exterior and a < 0:
        return ring[::-1]
    return ring


def simplify_ring(ring, tol, exterior):
    out = dp_ring(ring, tol)
    out = [[round(x, 4), round(y, 4)] for x, y in out]
    if len(out) >= 4:
        if out[0] != out[-1]:
            out.append(list(out[0]))
        return enforce_winding(out, exterior)
    return None


def simplify_geom(geom, tol):
    t = geom['type']
    if t == 'Polygon':
        rings = [r for r in (simplify_ring(r, tol, i == 0)
                             for i, r in enumerate(geom['coordinates'])) if r]
        return {'type': 'Polygon', 'coordinates': rings} if rings else None
    if t == 'MultiPolygon':
        polys = []
        for poly in geom['coordinates']:
            rings = [r for r in (simplify_ring(r, tol, i == 0)
                                 for i, r in enumerate(poly)) if r]
            if rings:
                polys.append(rings)
        return {'type': 'MultiPolygon', 'coordinates': polys} if polys else None
    return geom


def build(kind):
    url, numkey, navnkey, width, tol = SRC[kind]
    with urllib.request.urlopen(url) as r:
        src = json.load(r)
    feats = []
    for f in src['features']:
        g = simplify_geom(f['geometry'], tol)
        if g is None:
            # aldri mist en kommune pga forenkling — behold uforenklet
            g = f['geometry']
        p = f['properties']
        nummer = str(p[numkey])
        while len(nummer) < width:
            nummer = '0' + nummer
        feats.append({'type': 'Feature',
                      'properties': {'nummer': nummer, 'navn': p[navnkey]},
                      'geometry': g})
    out = {'type': 'FeatureCollection', 'attribution': ATTRIB,
           'features': feats}
    path = os.path.join(OUT, '%s_2024.geojson' % kind)
    with open(path, 'w') as fh:
        json.dump(out, fh, separators=(',', ':'), ensure_ascii=False)
    print(kind, len(feats), 'features,', os.path.getsize(path), 'bytes')


if __name__ == '__main__':
    build('kommuner')
    build('fylker')
