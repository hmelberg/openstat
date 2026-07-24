# Lifelines-shim (`lifelines_core`) — ren-python overlevelsesanalyse for brython/micropython (design)

**Status:** APPROVED 2026-07-24 (omfang avklart med Hans: KM + logrank +
Nelson-Aalen + CoxPH). Tredje leveranse i shim-workstreamen (altair og
folium levert 2026-07-24; gjenstår: interaktive tabeller/Tabulator).

## Motivasjon

Overlevelsesanalyse er kjernemetodikk for helsedata, og lifelines står
allerede i pyodide-modusens importliste — men brython/micropython-modusene
har ingenting. Ulikt altair/folium er lifelines REN beregning: ingen
JS-tvilling, ingen ny embed-type. Shimet regner alt i python og
gjenbruker eksisterende infrastruktur for visning: plott bygges som
plotly-shim-figurer (`figure__`-embedden), tabeller som
pandas-shim-DataFrames.

## Arkitektur

- **`shared/lifelines_core.py`** — all statistikk. Dialektregler som
  altair_core/folium_core (fellelisten i plotly_express_mpy.py-filhodet).
  Kjernen importerer ALDRI runtime-moduler; plotly- og pandas-shimene
  injiseres via **`configure(pe=..., pd=...)`** (ui_core-presedensen,
  sen binding). Uten konfigurert `pe` kaster plottmetodene en klar
  RuntimeError; uten `pd` returneres resultat-tabeller som dict-er
  (testbart, men fasadene konfigurerer alltid begge).
- **`brython/lifelines_brython.py`** / **`micropython/lifelines_mpy.py`**
  — fasader med eksplisitte rebind-er (aldri stjerneimport — _Mod-fellen)
  som kaller `_core.configure(pe=plotly_express_*, pd=pandas_*)` ved
  import, og definerer et `statistics`-navneromsobjekt (logrank_test,
  multivariate_logrank_test) for `from lifelines.statistics import ...`.
- **Registry** (begge motorene):
  - `lifelines_core: { path: 'shared/lifelines_core.py' }`
  - `lifelines_brython`/`lifelines_mpy`:
    `aliases: ['lifelines', 'lifelines.statistics']` (rekkefølgen
    bindende — forelder før dottet barn, statsmodels-presedensen),
    `deps: ['lifelines_core', 'plotly_express_*', 'pandas_*']`, `js: []`.
- **Ingen endring i runnere, index.html eller CSS.** Pyodide-modusen
  bruker ekte lifelines (matplotlib-plott) som i dag.

## Numerikk (alt ren python i kjernen)

- **`_norm_ppf(p)`** — Acklams inverse normal (for KI-z).
- **`_chi2_sf(x, df)`** — øvre halep-verdi via regularisert ufullstendig
  gamma: serieutvikling for x < df+1, kjedebrøk (Lentz) ellers;
  `math.lgamma` (finnes i CPython/Brython/unix-MicroPython — guardet
  fallback til Lanczos hvis import feiler).
- **Lineæralgebra** — Gauss-eliminasjon med partiell pivotering for
  `solve(A, b)` og invers (p og k er små: kovariater/grupper).

## API-flate (v1)

### KaplanMeierFitter

- `fit(durations, event_observed=None, label=None, alpha=0.05)` —
  lister/tupler eller pandas-shim-Series (duck-typet `.values`
  eller iterasjon). `event_observed=None` → alle events.
  Returnerer self.
- `survival_function_` — pandas-shim-DataFrame, indeks = tidspunkter
  (med 0.0 først, S=1.0 — som lifelines), kolonne = label
  (default 'KM_estimate').
- `confidence_interval_` — DataFrame med kolonnene
  `<label>_lower_0.95` / `<label>_upper_0.95` (alpha-avhengig navn,
  som lifelines). Metode: **eksponentiell Greenwood**
  (lifelines' default): var = Σ d/(n(n−d)),
  c± = S^(exp(±z·√var̂ / ln S)) på log(−log)-skala.
- `median_survival_time_` — første t der S(t) ≤ 0.5, ellers `inf`.
- `event_table` — DataFrame med kolonnene removed/observed/censored/
  entrance/at_risk (lifelines-navnene), rad per unikt tidspunkt
  (inkl. t=0-entrance-raden som lifelines har).
- `plot()` / `plot_survival_function(ci_show=True)` — PlotlyFigure:
  trappetrinn (`line_shape`-ekvivalent: plotly-trace med
  `line: {shape: 'hv'}`), KI som halvtransparent bånd (to traces med
  `fill: 'tonexty'`), label i legend. Farge fra plotly-shimets
  standardsyklus.

### NelsonAalenFitter

- `fit(...)` samme signatur; `cumulative_hazard_` (H(t) = Σ d/n),
  `confidence_interval_` (log-normal: H·exp(±z·√var̂/H),
  var̂ = Σ d/n²), `plot()` (trappetrinn, KI-bånd).

### lifelines.statistics

- `logrank_test(durations_A, durations_B, event_observed_A=None,
  event_observed_B=None)` → `StatisticalResult` med `test_statistic`
  (chi², 1 frihetsgrad), `p_value`, `print_summary()` (tekstlinjer),
  `__repr__` med t-statistikk og p.
- `multivariate_logrank_test(event_durations, groups,
  event_observed=None)` — k grupper: statistikk
  (O−E)′V⁻¹(O−E) over k−1 dimensjoner, p fra `_chi2_sf(x, k−1)`.

### CoxPHFitter

- `fit(df, duration_col, event_col)` — df er pandas-shim-DataFrame
  (eller dict av lister); alle øvrige kolonner er kovariater
  (numeriske; ikke-numerisk kolonne → ValueError som ber brukeren
  dummy-kode). `formula=`, `strata=`, vekter og robuste SE er utenfor
  v1 (NotImplementedError for formula/strata-kwargs).
- Partial likelihood med **Efron-korreksjon for ties** (lifelines'
  default). Newton–Raphson: mean-sentrerte kovariater, step-halving
  når log-likelihood faller, konvergens ‖Δβ‖∞ < 1e-7, maks 50
  iterasjoner (ConvergenceWarning-aktig RuntimeError med råd ved
  ikke-konvergens).
- Resultater: `params_` (dict/Series-aktig: kolonne → β),
  `hazard_ratios_` (exp β), `standard_errors_` (√diag H⁻¹),
  `confidence_intervals_`, `summary` (DataFrame: coef, exp(coef),
  se(coef), z, p, coef lower/upper 95%), `print_summary()`
  (teksttabell + n, antall events, concordance),
  `concordance_index_` (parvis c-indeks, O(n²)),
  `log_likelihood_`.
- Prediksjonsmetodene (`predict_survival_function` m.fl.) →
  NotImplementedError i v1.

## Testing

1. **`brython/tests/test_lifelines_core.py`** — enhetstester: KM på
   håndregnet mini-datasett (med sensurering), event_table-form,
   median (inkl. inf-tilfellet), NA-verdier, logrank på kjent eksempel,
   Cox på 2-kovariat-datasett (konvergens, HR-retning), feilmeldinger
   (ikke-numerisk kovariat, ukonfigurert pe for plot), _chi2_sf mot
   kjente verdier (chi2_sf(3.84, 1) ≈ 0.05), _norm_ppf(0.975) ≈ 1.96.
2. **`brython/tests/test_lifelines_core_diff.py`** — differensielt mot
   ekte lifelines (pip --user, guardet `HAS_LIFELINES`): på minst tre
   datasett (uten ties, med ties, med tung sensurering; n ≈ 20–60,
   deterministisk hardkodede — ingen RNG i test):
   KM survival_function_ EKSAKT (samme aritmetikk), KI og median til
   1e-6, event_table eksakt, NA eksakt, logrank statistic/p til 1e-8,
   multivariat logrank til 1e-8, Cox coef/se/p til 1e-4 og
   concordance til 1e-6.
3. **`micropython/tests/mpy_smoke_lifelines.py`** — fit + spec-tall
   uten pe/pd-konfigurasjon (tabeller som dicts) + med injisert
   plotly_express_mpy/pandas_mpy (full plot-spec bygges).
4. **Browser-verifisering**: brython- og micropython-modus (KM-plot
   med KI-bånd rendres som plotly-figur; Cox print_summary i output),
   pyodide-modus ekte lifelines (KM-plot via matplotlib-stien).

## Eksempler & docs

`examples/brython/bry29_lifelines.txt`,
`examples/micropython/09_lifelines.txt`,
`examples/python/py09_lifelines.txt` (ekte lifelines): KM per gruppe +
logrank + CoxPH på et lite pasientaktig mock-datasett; manifest
regenereres. `PYTHON_DS_IMPORTS` har allerede lifelines-oppføringene —
ingen index.html-endring.
