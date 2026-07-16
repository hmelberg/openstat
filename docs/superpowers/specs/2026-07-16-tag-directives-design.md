# `#tag.` cell directives, content sniffing, preamble defaults (design)

Phase 1 of the unified document model
(`2026-07-16-unified-document-model-notes.md` §2 and §6.1). Companion to
spec 1 (`2026-07-13-notebook-cells-design.md`). All directional decisions
were made by Hans in the 2026-07-16 brainstorm rounds; this spec pins the
mechanics, the `"""` disambiguation rule (delegated to this spec), and the
seams.

## Summary

Three parser-level capabilities for `#%%` documents:

1. **`#tag.key = value` cell directives** — comment-line metadata at the
   top of a cell body, merged into the cell's attrs at parse time.
   Motivation: Colab/Jupytext regenerate/own the `#%%` marker lines, so
   attributes on the marker do not survive round-trips; comment lines in
   the body always survive. Pattern-completes the family `#options.*`
   (document) / `#tag.*` (cell) / `#@param` (line).
2. **Content-sniffed cell types** for unmarked cells: a cell that is a
   single `"""…"""` string alone renders as **md** (delimiters hidden); a
   cell whose first line starts with `<` renders as **html**.
3. **Preamble tag defaults**: `#tag.*` lines at the top of the preamble
   (before the first `#%%`) act as document-wide defaults for every cell
   that does not override them — e.g. `#tag.type = r` so not every cell
   must carry a type.

Everything lands in the parse result (`C.parseCells`), so every existing
consumer (`resolveType`, `executableSource`, `segmentPlan`, `alignPlan`,
rendering, forklar, param forms) picks the semantics up through the
existing choke points.

## Global constraints

- **Paramount invariant (spec 1): documents without `#%%` behave
  byte-identically to today.** `#tag.` has meaning only inside `#%%`
  documents; in a plain script it is an ordinary comment and no machinery
  touches it (`executableSource` already returns non-marker documents
  unchanged).
- **Round-trip guarantee unchanged:** `serializeCells(parseCells(t).cells)
  === t`. Tags live in `cell.source`; merging into attrs never rewrites
  text.
- Line-count preservation in all execution transforms (blank, never
  delete — the `executableSource` convention).
- The hybrid segment machinery (`parseHybridScripts`, `matchHybridMarker`,
  flush) in index.html is **not modified**.
- ES5 var-style JS, Norwegian comments, user-facing strings through `t()`.

## 1. Tag lines

**Recognition.** A tag line matches
`/^\s*#\s*tag\.([A-Za-z_][\w-]*)\s*=\s*(.*?)\s*$/` (key group 1, value
group 2). `#` only — no `//` form (tags live in cell bodies, which are
comment-`#` languages or md/html where the line is stripped before
render anyway).

**Value coercion.** Surrounding quotes (`"…"` or `'…'`) are stripped;
unquoted `true`/`false` coerce to boolean (so `#tag.hide-code = true`
produces the same `attrs['hide-code'] === true` a header flag produces);
everything else stays a string (header attrs are strings — `slide=3` is
`"3"` there and here). Keys are lowercased; values are not.

**The tag block.** Per the decision: at the very beginning of the cell
body, before anything else. Precisely:

- Leading blank lines are skipped (a blank line after `#%%` is common).
- Then consecutive tag lines form the block. A line matching the
  `^\s*#\s*tag\.` prefix but not the full pattern is consumed into the
  block with a warning (`ugyldig #tag-linje`), so one typo does not
  silently demote the rest of the block.
- The first other line ends the block. Blank lines do not continue it.
- A tag-looking line later in the body is inert (an ordinary comment) and
  gets a warning (`#tag utenfor tagg-blokken — ignorert`). Known caveat:
  such a line inside a string literal triggers a false-positive warning;
  warnings are non-fatal, accepted.

**Validation** mirrors `parseHeader`: keys checked against
`KNOWN_KEYS ∪ KNOWN_FLAGS ∪ {type}` (unknown → warning, still stored,
same leniency as header attrs); `style`/`widgets` value checks and the
`id` `ID_RE` check are reused. `#tag.type` values go through `ALIASES`
and must be in `TYPES`, else warning and the tag is ignored. Duplicate
key within one block: last wins, warning. All warnings carry the absolute
line number (`linje N:` prefix, the `parseCells` convention) and flow
through the existing warnings channel.

**Merge precedence** (per decision: the `#%%`-line attribute wins, with a
warning):

```
header attr  >  cell tag  >  (type only: content sniff)  >  preamble default
```

- A key present both on the header and in the tag block → header value
  kept, warning (`#tag.key overstyrt av #%%-attributt`).
- `#tag.type` when the header already has an explicit type → header wins,
  warning.
- The merge is baked into the parse result: after `parseCells`,
  `cell.attrs` IS the effective attr set and `cell.type` IS the effective
  explicit type (header > tag > sniff > preamble default, else `null`).
  `C.resolveType` keeps its signature and its `docMode || 'python'`
  fallback — a preamble default simply means `cell.type` is already
  non-null. No consumer changes needed for typing to work end-to-end
  (segmentPlan/executableSource emit `## r` for a `#tag.type = r` cell
  automatically).

## 2. Preamble defaults

- The preamble (cell with `headerRaw === null`) collects its tag lines
  from the **leading run of blank and `#`-comment lines** (i.e. before the
  first code line) rather than the strict cell rule: real preambles start
  with `# label:`, `#options.*` and `# load` directives, and requiring
  tags before those would fight every existing document convention. Only
  lines matching the tag pattern are consumed; the surrounding comment/
  directive lines are untouched. The first non-blank, non-`#` line ends
  the scan.
- Every known key in the preamble block becomes a document default,
  applied to each cell that has neither a header attr nor an own tag for
  that key. Exception: `id` cannot be defaulted (would duplicate) —
  warning, ignored.
- `#tag.type` in the preamble is the default **cell** type. It does not
  retype the preamble itself (the preamble is runtime code and keeps
  docMode semantics), and it does not touch `#options.mode`: options.mode
  = document runtime, preamble `#tag.type` = default cell type where the
  two could differ (decision doc §2).
- Defaults are baked into each cell's `attrs`/`type` at parse time (see
  merge above), so consumers never consult the preamble.

## 3. Content sniffing (unmarked cells only)

Runs in `parseCells`, only when the cell has no header type AND no
`#tag.type` (preamble default does NOT count as marked — sniffing exists
precisely to beat the document default for prose cells). Never runs on
the preamble. Sniffing inspects the body **after** the tag block.

- **html:** the first non-blank line, after leading whitespace, starts
  with `<` → `type = 'html'`. (`<` can never start a valid python/r/sql
  line, so this is safe.)
- **md — the pinned `"""` rule:** the cell must consist of one
  triple-quoted string **alone**:
  1. the first non-blank line starts with `"""` at column 0;
  2. scanning forward from the opening delimiter, the **next** occurrence
     of `"""` closes the string, and everything after it is whitespace
     only.
  Then `type = 'md'` and the render content is the text between the
  delimiters (one leading and one trailing newline trimmed). This kills
  the docstring false-positive from the decision doc: `"""doc"""` followed
  by code fails rule 2 (non-whitespace after the closer) and stays a code
  cell — a legitimate docstring-opening python cell is never sniffed.
  `'''` is not sniffed. `\"""` escape sequences inside the prose are not
  handled (documented limitation; the cell then stays code).

Precedent: this matches `notebook_prose.py` semantics ("bare string alone
= prose") one level up, at the cell-typing layer instead of the AST layer.
Explicit type always wins over sniffing.

## 4. Hiding tags (and delimiters) outside the editor

The editor is raw text — tags stay visible there (decision). Everywhere
else:

- **Render content helper** — a single pure-half accessor
  `C.renderContent(source, type, sniffed)` returns the body minus the tag
  lines, and for sniffed-md cells the text inside the delimiters
  (re-derived from the text; falls back to the tag-stripped body if the
  pattern no longer holds after an edit). Source-level (not cell-level)
  so the blur-preview path in `cellNode`, which renders the live textarea
  value, can use it too. Consumers: `renderNonCode` (md/html output, both
  call sites), forklar md-steps (which also feeds `mdNarrationText`/TTS).
- **Execution paths blank tag-block lines in place** (empty line per tag
  line, line count preserved — the `#options.*` stripping precedent at
  the cell level):
  - `executableSource`: blank the tag block in code-cell bodies AND in
    the preamble before emitting. Required, not cosmetic: `#` is not a
    comment in duckdb SQL, and `#`-lines are live directives in
    microdata — tag lines must never reach those engines.
  - the per-cell run payload (`C.runCell` → `mdRunNotebookCell`): same
    blanking for the same reason.
  - the engine-notebook preamble run (`runNotebookEngineCell` in
    index.html, the `_pre.source` call) — the one execution path that
    reads a cell body directly instead of going through `C.runCell` or
    `executableSource`.
  - Blanking helper: `C.execCellSource(cell)` — cell-level (the parse
    already knows the consumed tag lines), returns `cell.source` with
    those lines emptied.
- Code echo paths flow from the executable text and are covered by the
  blanking. `#@param` scanning (`ParamForms.parse`) does not match tag
  lines (its `LINE_RE` requires an assignment) — no interaction.
- Known benign edge: a code cell whose body is ONLY a tag block becomes
  an effectively empty cell at runtime — identical to today's empty-cell
  plan/runtime asymmetry (ledger Task 9: alignPlan falls back, whole-run
  output to trailing slot). Pin with a test, do not fix.

## 5. Parse-result shape (additions)

`parseCells` cells gain:

- `attrs` / `type` — now effective (merged), see §1.
- `tags` — the raw parsed tag object for the cell's own block (empty
  object when none); used by tests/debugging and the conflict warnings.
- `tagLines` — body-relative indices of the consumed tag lines (empty
  array when none), the seam `renderContent` (removes them) and
  `execCellSource` (blanks them) share. An array, not a start/end pair,
  because the preamble's tag lines may be interspersed among other
  comment lines (§2).
- `sniffed` — `'md' | 'html' | null`; lets `renderContent` know to
  extract the inner text (the delimiters' positions are not stored; the
  source of truth stays the raw text).
- The scanner itself is exposed as `C.scanTagBlock(source, isPreamble)`
  → `{ tags, entries, tagLines, warnings }` (pure, body-relative line
  numbers; `parseCells` absolutizes warnings to `linje N:`).

The parse result keeps `{ cells, warnings }`. `hasBody`, `headerRaw`,
line indices, and serialization are untouched.

## Error handling

- All new diagnostics are non-fatal parse warnings through the existing
  channel (`linje N: …`), Norwegian, matching the current tone
  (`ukjent attributt`, `ugyldig id`).
- Malformed tag lines never abort parsing; worst case the line is an
  ordinary comment plus a warning.
- Sniffing never produces warnings (it either matches its strict rule or
  silently leaves the cell as code).

## Testing

- **node (`tests/js/cells.test.js` idiom):** tag-line recognition and
  coercion (quotes, true/false, lowercased keys); block boundaries
  (leading blanks, typo-line consumed with warning, stray late tag
  warning); merge precedence incl. both conflict warnings; preamble
  defaults (type + non-type keys, id rejected, cell override); sniffing
  matrix — `"""` alone-string (single- and multi-line) → md with correct
  inner content, docstring+code NOT sniffed, `"""x""" trailing code` NOT
  sniffed, `<`-first-line → html, explicit/tag type beats sniff, sniff
  beats preamble default; `executableSource` blanks tag block with exact
  line-count preservation (python, duckdb, microdata, preamble);
  `segmentPlan`/`alignPlan` with tag-typed cells (`#tag.type = r` in a
  python doc yields an r segment); tag-only cell ≙ empty cell behavior
  pin; round-trip `serializeCells(parseCells(t)) === t` for documents
  with tags/sniffed cells.
- **pytest:** none (JS-only feature; no facade changes).
- **Exit gate (browser):** Colab-interop scenario (a doc typed entirely
  via `#tag.type`, run end-to-end); duckdb + microdata cells with tags
  execute cleanly; sniffed md and html cells render with tags/delimiters
  hidden and stay visible in the editor; per-cell ▶ and Kjør alle;
  forklar over a tagged document; `#@param` in a tagged cell; share-link
  reload; plain-script regression sweep (no `#%%` → byte-identical);
  both themes.

## Out of scope (documented)

- Consuming `slide`/`speak`/`rerun`/`sync` semantics (spec 3 /
  presentation reads them later; tags just carry them now).
- `'''`-quoted and escape-containing prose sniffing.
- Any editor UI (gutter, views) — phase 4.
- Writing tags back from any structural edit UI (raw text is the editor).

## Phasing

Single plan, expected 3 tasks: (1) pure half — tag block, merge,
defaults, sniffing, `cellContent`, `executableSource` blanking, node
tests; (2) consumer wiring — renderNonCode/forklar/narration via
`cellContent`, per-cell run blanking, warning surfacing check; (3)
example + docs + browser exit gate.
