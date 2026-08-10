# Board view redesign — design

Date: 2026-08-10
Status: approved (owner, this session, via visual companion)
Issue: none filed (standing rule: don't file new issues)

## Why

Owner flagged the board view (`components/v2/board/`) as "UI/UX looks bad"
against a live screenshot. Investigation found one real regression alongside
the aesthetic complaints:

- **Move panel's "When" field renders as a near-empty box.** `DateTimeField`
  with `kind="datetime-local"` delegates to `DateTimeSplitField`
  (`00631754`, shipped today — see the sibling
  `2026-08-10-quarter-hour-time-select-design.md`), whose outer `<div
  className="@container">` carries no width of its own. Every other caller
  (`registration-settings.tsx`, `division-builder.tsx`,
  `constraints-panel.tsx`, `settings-panel.tsx`) wraps the field in a `<div>`,
  a `grid` cell, or a `col-span-*` cell — something that hands it a definite
  width. `move-panel.tsx` and `stages-panel.tsx` instead drop it straight into
  a bare `flex flex-wrap items-end gap-2` row, so the field's percentage-sized
  date/time children resolve against an auto-sized flex item and collapse.
  This is a bug fix, not a style choice, and ships as part of this work since
  the Move panel is being touched anyway.

- **Everything else was a genuine aesthetic/hierarchy pass**, confirmed
  against the app's own `globals.css` design tokens (division-hue accent
  system, `.app-display` condensed headers, purple brand, lucide-react
  already a dependency) rather than a new palette.

Two extra asks came up mid-review and are folded in: the division-filter
legend only exists above the grid (invisible again once you've scrolled a
tall board), and blackout windows (`BoardConfig.blackouts`) have no visual
presence on the grid at all today — an organiser only learns a slot was
blacked out after placing into it and seeing the `warn.blackout` badge.

## Scope

`board-grid.tsx`, `fixture-block.tsx`, `move-panel.tsx`, `board-legend.tsx`,
and the composition in `schedule-board.tsx` that wires them together. Density
modes other than `board` (agenda, lanes), the AI console, settings panel, and
conflicts panel are untouched.

## Direction

Two options were mocked side by side in the visual companion. Owner picked
**B — quiet grid, loud lanes** over A (a lower-risk "same palette, tightened
spacing" pass): division color becomes the card's identity (full tint wash,
not just a hairline), conflict state moves off the card's background onto a
small icon badge so the two stop competing for the same visual channel, and
empty cells go fully silent until hover instead of repeating "Place here" on
every one of them.

One deviation from the mockup: the Move panel mockup's dark toolbar (matching
the app's night-console chrome) was rejected. The app's own convention is
night chrome only at the top nav/gantry — the work surface underneath stays
light (`docs/superpowers/specs/2026-07-12`, the floodlit-console system). A
dark toolbar embedded mid-page would be a one-off exception to that rule and
would also need the lime-button contrast workaround the ticket/auth screens
carry for the same reason. The Move panel keeps a light/purple treatment,
restyled as a slimmer inline toolbar rather than the current boxed
alert-style panel — the rest of B's ideas (icon badges, quiet empty cells,
lane color) apply unchanged.

## Component-by-component

### `fixture-block.tsx`

- Background becomes `divisionTint(fixture.division_id)` (already computed
  today for the division chip; just not used as the card's own background).
  Left rail widens from 3px to 6px, still `divisionAccent(fixture.division_id)`.
- Conflict state drops the `bg-red-50` / `bg-amber-50` background swap
  entirely. Instead: a small circular icon badge, top-right corner —
  `AlertTriangle` (lucide), red fill when `blocking`, amber when not. This is
  the same information the current corner-triangle + background carries, but
  no longer overwrites the division color.
- **Same-code conflicts merge into one badge.** Today two `warn.rest` entries
  (e.g. one per entrant) render as two adjacent "rest" badges with no visible
  difference — reads as a glitch, not as "two people need rest" (the D vs E
  card in the original screenshot). Group `conflicts` by `code` before
  rendering; one badge per code, `title` joins every entry's `detail` with
  `"; "`. Severity of the merged badge is `blocking` if any entry in the
  group is blocking.
- Pin/lock: replace the raw `📌`/`🔒` emoji with lucide `Pin` / `Lock`,
  matching the `AlertTriangle` badge's sizing and stroke width so the block's
  icon language is consistent. Same opacity/hover behavior as today
  (`opacity-30 group-hover:opacity-100` when unlocked, always visible when
  locked).

### `board-grid.tsx`

- Empty "place" cells: drop the dashed `border-dashed border-purple-300` and
  the repeated `board.grid.placeHere` visible text. Default state is fully
  quiet (existing `text-transparent` / invisible-until-focus pattern already
  does most of this — the change is dropping the *visible* text branch when
  `pickedId` is set, which is what currently prints "Place here" dozens of
  times). On hover/focus, a light purple wash (`hover:bg-purple-50`) plus a
  centered lucide `Plus` icon. `aria-label` is unchanged — screen readers
  keep the full instruction regardless of hover state.
- Column headers switch from `font-medium text-slate-600` to the app's
  condensed uppercase display treatment (the `.page-title` / `.app-display`
  pattern already used elsewhere in the console chrome), so the grid's own
  chrome reads as the same product as the rest of the app.
- **Blackout zones** (new): `BoardGrid` takes a `blackouts:
  BoardConfig["blackouts"]` prop. For each row/column cell whose time range
  intersects a blackout window (`blackout.court` matching this column, or
  every column when `blackout.court` is unset), render a hatched
  (`repeating-linear-gradient`) overlay instead of the plain empty cell.
  This is **soft** — the cell stays clickable/droppable exactly as before.
  Nothing about placement is refused client-side; this only makes visible,
  ahead of time, what today only surfaces after the fact as a
  `warn.blackout` badge on the placed card. Rejected the hard-block
  alternative (disable the button, refuse the drop) because the server
  itself treats `warn.blackout` as a warning, not a rejection
  (`ScheduleConflict`'s doc comment: "Blocked writes are rejected; warnings
  persist as badges") — a client that refuses what the server allows is a
  new client/server mismatch, and the existing delta-conflict-gate history in
  this codebase is exactly this class of bug. Highlighting is a strict
  visibility improvement with no behavior change.
- Row height/step logic, drag-drop wiring, ghost-block rendering (AI proposal
  preview) are unchanged.

### `move-panel.tsx`

- Fixes the width-collapse bug: the `DateTimeField` (`kind="datetime-local"`)
  call gets wrapped in an explicit-width container, matching the pattern
  `registration-settings.tsx` already uses, instead of sitting bare in the
  `flex flex-wrap` row.
- Visual restyle: lighter, slimmer inline toolbar instead of the current
  boxed `bg-purple-50 border-purple-200` panel — less "modal-in-the-page",
  same purple accent, same field set (When, Board/venue select, Move,
  Cancel), same keyboard behavior (Escape closes).

### `board-legend.tsx`

- No structural change — chip styling stays as-is (division color dot +
  name/short-code, already reads well).
- `schedule-board.tsx` renders a second `<BoardLegend>` below the board grid
  (same `divisions` / `selected` / `onToggle` / `onClear` props — one shared
  filter state, not a second independent filter), so the division filter
  stays reachable without scrolling back to the top of a tall board.

## Out of scope / explicitly not doing

- Agenda and lanes density modes, AI console, conflicts panel, settings
  panel — untouched.
- No new color palette. Every color used here already exists in
  `globals.css` or `division-hue.ts`.
- No change to how conflicts are computed (`use-board-actions.ts`,
  `use-disruption-signals.ts`) beyond the client-side same-code badge
  grouping in `fixture-block.tsx`, which is a rendering change over data the
  client already has.

## Testing

- Regression test for the Move panel width bug: assert the rendered
  `DateTimeSplitField`'s wrapping element carries a definite-width class
  (mirrors how `registration-settings`/`division-builder` are already
  structured) — fails against today's `move-panel.tsx` before the fix.
- Fixture-block: a test with two `warn.rest` conflicts on one fixture
  asserts a single rendered badge, not two.
- Board-grid: a test with a court-specific blackout and a venue-wide
  (courtless) blackout asserts the hatched cells appear on the right
  cells/columns, and that the place button is still present and enabled
  underneath (soft, not hard-blocked).
- Screenshot verification per project rule: desktop (1280), 320px, 768px, no
  horizontal scroll at any width.
