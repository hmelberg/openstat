// Røyk for JavaScript-modus — lim inn i editoren i javascript-modus og Kjør.
// Forventet: konsollutskrift (rader + p-verdi), deretter HTML-tabell (stats).
# load https://raw.githubusercontent.com/hmelberg/openstat/main/data/iris.csv as iris

console.log("rader:", iris.numRows());
const stats = iris
  .groupby("species")
  .rollup({ n: op.count(), snitt: op.mean("sepal_length") });
const setosa = iris.filter(d => d.species === "setosa").array("sepal_length");
const virginica = iris.filter(d => d.species === "virginica").array("sepal_length");
console.log("t-test setosa vs virginica (sepal_length): p =",
  ss.tTestTwoSample(Array.from(setosa), Array.from(virginica)));
stats
