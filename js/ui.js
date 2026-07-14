/* ui.js — ui-widgetar (spec: docs/superpowers/specs/2026-07-15-notebook-widgets-design.md)
   Ren halvdel (øverst): kontroll-spec normalisering, nøkkelerutvikling.
   Node-testet, ingen DOM.
   DOM-halvdel (nederst): kontrollstripe, verdilager, endring-debounce→rerun. Kun browser.
   Adaptere (pyodide/ui.py) kaller det globale `Ui`-API-et; all data
   krysser grensen som JSON-strenger. */
(function (global) {
  'use strict';
  var Ui = {};

  // ---------- ren halvdel ----------

  // Gyldig kontrolltyper
  var VALID_TYPES = {
    slider: 1,
    dropdown: 1,
    checkbox: 1,
    switch: 1,
    number: 1,
    text: 1,
    button: 1
  };

  // Gyldige nøkler i kontrollspec
  var VALID_KEYS = {
    type: 1,
    name: 1,
    label: 1,
    value: 1,
    min: 1,
    max: 1,
    step: 1,
    options: 1,
    rerun: 1
  };

  /**
   * Ui.normalizeSpec(raw) → {spec, warnings}
   * Normaliser og valider én kontrollspec {type, name?, label?, value?, min?, max?, step?, options?, rerun?}
   * Returner {spec: normalized_spec_or_null, warnings: [strings]}
   */
  Ui.normalizeSpec = function (raw) {
    var spec = {};
    var warnings = [];

    if (!raw || typeof raw !== 'object') {
      warnings.push('kontrollspec er ikke objekt');
      return { spec: null, warnings: warnings };
    }

    // Sjekk for ukjente nøkler
    for (var key in raw) {
      if (raw.hasOwnProperty(key) && !VALID_KEYS[key]) {
        warnings.push('ukjent nøkkel: ' + key);
      }
    }

    // Hvis det finnes ukjente nøkler, returner null
    if (warnings.length > 0) {
      return { spec: null, warnings: warnings };
    }

    var type = raw.type;
    if (!type || !VALID_TYPES[type]) {
      var typeName = type ? String(type) : 'mangler';
      warnings.push('ukjent kontrolltype: ' + typeName);
      return { spec: null, warnings: warnings };
    }

    spec.type = type;

    // Kopier navn og label hvis de finnes
    if (raw.name !== undefined) spec.name = raw.name;
    if (raw.label !== undefined) spec.label = raw.label;

    // Håndter rerun
    if (raw.rerun !== undefined) {
      spec.rerun = raw.rerun;
    } else {
      spec.rerun = 'self';
    }

    // Type-spesifikk normalisering
    if (type === 'slider') {
      var min = raw.min !== undefined ? +raw.min : 0;
      var max = raw.max !== undefined ? +raw.max : 100;
      var step = raw.step !== undefined ? +raw.step : 1;
      var value = raw.value !== undefined ? +raw.value : min;

      // Klamp verdi til intervall
      if (value < min) value = min;
      if (value > max) value = max;

      spec.min = min;
      spec.max = max;
      spec.step = step;
      spec.value = value;
    } else if (type === 'dropdown') {
      if (!raw.options || !Array.isArray(raw.options) || raw.options.length === 0) {
        warnings.push('dropdown krever non-tomt options array');
        return { spec: null, warnings: warnings };
      }

      // Konverter options til strenger
      spec.options = raw.options.map(function (opt) {
        return String(opt);
      });

      // Sett verdi — hvis eksplisitt gitt, konverter til string; ellers bruk første option
      if (raw.value !== undefined) {
        spec.value = String(raw.value);
      } else {
        spec.value = spec.options[0];
      }
    } else if (type === 'checkbox' || type === 'switch') {
      // Konverter til boolean
      spec.value = Boolean(raw.value);
    } else if (type === 'number') {
      var numVal = raw.value !== undefined ? +raw.value : 0;
      spec.value = numVal;
    } else if (type === 'text') {
      var strVal = raw.value !== undefined ? String(raw.value) : '';
      spec.value = strVal;
    } else if (type === 'button') {
      // Button har bare label, ingen value
      // label allerede kopiert ovenfor
    }

    return { spec: spec, warnings: warnings };
  };

  /**
   * Ui.controlKey(cellIdx, spec, ordinal) → string
   * Returner identiteten for denne kontrollen: cellIdx + '::' + (spec.name || 'w' + ordinal)
   */
  Ui.controlKey = function (cellIdx, spec, ordinal) {
    var name = spec.name || ('w' + ordinal);
    return cellIdx + '::' + name;
  };

  // Eksporter til global og CommonJS
  global.Ui = Ui;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Ui;
  }

  // ---------- DOM-halvdel (kun browser) ----------
  if (typeof document !== 'undefined') {
    // Placeholder for DOM-halvdel, implementert i Task 3
  }
})(typeof window !== 'undefined' ? window : global);
