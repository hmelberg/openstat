# `#@title` and `#@markdown` — Colab parity for param forms (design)

**Status:** APPROVED 2026-07-22 (scope settled with Hans 2026-07-21 during
the phase-4 discussion: separate small phase, lives entirely in
param-forms.js; `display-mode:"form"` explicitly deferred to the
`#options.view` family). Roadmap: "Colab-paritet for `#@param`".
DELIVERED 2026-07-22 (plan 2026-07-22-param-colab-parity.md —
browser-verified: Colab-shaped form in python mode incl. rendered
markdown + manual-by-title run-chip + write-back, and `//@` in JS mode).

## Motivation

OpenStat's `#@param` is deliberately Colab-compatible (same line syntax,
same type set, `allow-input`, lenient meta). Colab code pasted into
OpenStat loses two things today: the form title (`#@title`) and the
explanatory prose (`#@markdown`) — both silently become plain comments.
This phase renders them, completing paste-compatibility. (OpenStat's
extensions — run:auto default, placement, R/JS dialects — are already
beyond Colab and unchanged here.)

## Design

All parsing/rendering lives in `js/param-forms.js` (runtime-agnostic:
text-level, like `#@param` itself), so every mode with `#`-comments gets
it, and JS mode via `//@`.

1. **`#@title <text> [{...meta}]`** — a standalone comment line; text
   runs to the optional trailing balanced `{...}` meta object.
   (Implementation note 2026-07-22: `# @title` with whitespace IS
   matched, mirroring the existing `LINE_RE` tolerance for
   `# @param` — internal consistency won over Colab's strictness;
   plan-delegated decision.)
   - Renders as a heading row (`.param-form-title`) at the TOP of the
     cell's default-placement strip.
   - Meta on the title line sets the CELL-WIDE default for params that
     lack their own `run:` meta (Colab semantics: the title's form-meta
     governs the form). OpenStat mapping: `{run:"manual"}` on the title
     → all params in the cell default to manual unless they say
     `run:"auto"` themselves. `display-mode` in the meta is parsed and
     IGNORED with a console.warn pointing to the roadmap (deferred).
   - Multiple `#@title` lines: first wins, later ones warn + ignored.
2. **`#@markdown <text>`** — each such line renders its text as markdown
   via the shared renderer (`Ui.renderPayload({kind:"markdown", ...})` —
   the same vocabulary ui.markdown/on_change results use; graceful
   plain-text fallback when `Ui` is absent, e.g. in node tests).
   - Rendered IN SOURCE ORDER interleaved with the param rows in the
     cell's default-placement strip (Colab renders form items in
     order). Per-line `placement` is NOT supported for title/markdown
     (params keep theirs); they always follow the cell default.
   - Consecutive `#@markdown` lines render as separate rows (Colab
     behavior; keeps line↔row mapping trivial).
3. **JS mode**: `//@title`, `//@markdown` mirror exactly (same regex
   family as `//@param`).
4. **Parse model**: `ParamForms.parse` gains non-param entry kinds
   (`{kind:"title"|"markdown", lineIdx, text, meta?}`; existing param
   entries get `kind:"param"` implicitly/explicitly). Write-back
   (`_commit`/`writeValue`) applies ONLY to param entries — title/
   markdown rows have no inputs and no source mutation. The
   `entries`/`builtEntries` structural-comparison and `syncSource`
   machinery must treat the new kinds as structure (a changed markdown
   TEXT is a structural change → strip rebuild; cheap and correct).
5. **Trust**: markdown renders through the existing markdownit path
   (same trust level as `#%% md` cells and `ui.markdown` — author's own
   document). No new HTML surface.

## Out of scope

- `display-mode:"form"` (view family — `#options.view`), Colab's
  form-column layout, `#@markdown` inline-latex.
- Any change to `#@param` line semantics.

## Testing

- `tests/js/param-forms.test.js`: parse cases (title with/without meta,
  meta run-default inheritance + per-param override, multiple titles,
  markdown ordering, `# @title` non-match, `//@` dialect, `display-mode`
  warn-and-ignore).
- `tests/js/param-forms-dom.test.js`: strip rendering order (title
  first, markdown interleaved by lineIdx), no write-back for the new
  kinds, refresh/syncSource structural behavior on markdown text edits,
  run-chip interplay (manual default from title-meta shows the chip).
- Browser sweep: a Colab-shaped cell (title + markdown + params) in
  python, brython and JS modes; an actual pasted Colab form example.
