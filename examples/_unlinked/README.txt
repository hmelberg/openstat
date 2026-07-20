Example scripts for Microdata
==============================
Comments in microdata use // (not #).

These .txt files can be loaded into the Microdata script runner (Hamburger menu → Load script, or drag-and-drop examples if available).

01_beskrivende_statistikk.txt
  Create dataset, import variables (gender, income, municipality), summarize with and without gini/iqr and an if condition.

02_tabeller_og_kategorier.txt
  define-labels, assign-labels, list-labels, tabulate (frequency, row percent, top n), aggregate + tabulate with summarize.

03_visualiseringer.txt
  barchart, histogram, boxplot (with over()), scatter, piechart, hexbin. Uses code lists for readable labels.

04_aggregat_og_generate.txt
  generate (new variables), sample, aggregate (mean/count by municipality), collapse (aggregation to a higher level).

05_regresjon.txt
  ci (confidence interval), correlate (with sig), regress (OLS), regress-predict with predicted(pred).

06_avansert_analyse.txt
  normaltest, anova, import-panel, summarize-panel, tabulate-panel, transitions-panel.

Variables used: fd/BEFOLKNING_KJOENN (gender), fd/INNTEKT_WLONN (income), fd/BOSATT_KOMMUNE (municipality).
For panel: time points 2010-01-01, 2011-01-01, 2012-01-01.
