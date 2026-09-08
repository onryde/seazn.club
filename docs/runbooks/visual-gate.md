# Visual gate — running and extending the capture harness

The harness is `apps/web/e2e/visual/capture.spec.ts`, driven by
`apps/web/e2e/visual/manifest.json`. It runs in CI on every push to `main`
inside the parallel project's "rest" leg (no config names it — the default
`testMatch` selects it, and `src/lib/__tests__/visual-manifest.test.ts`
proves that on every vitest run). It has NO env-var skip: a run that
photographs nothing fails (recurring failure class 10).

## Run it locally

    S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh
    $S up --label <label> --server        # from the worktree; rebuild after a code change
    $S env --label <label>                # read PLAYWRIGHT_BASE (= SMOKE_BASE)
    cd apps/web && VISUAL_DIR=/path/you/keep PLAYWRIGHT_BASE=<base> E2E_PROD_TARGET=1 \
      npx playwright test e2e/visual/capture.spec.ts --project=parallel --reporter=line

Pictures land in `VISUAL_DIR` (default `apps/web/test-results/visual/<TAG>`,
gitignored) as `<group>--<row>.png` + `.sha256`, plus `<group>.report.json`
(seed params, hashes, the control set per row, the reachable rails). The
`[control-set …]` block in the log is the 320-vs-1280 diff a reviewer reads,
and each row's `[visual …] seen={…}` line prints what every check INSPECTED —
`inspected: 0` means the check ran over nothing, which is a finding about the
row, not a pass.

## What a row asserts

`checks` per row: `no-horizontal-scroll` (page-level, `expectNoHorizontalScroll`),
`no-clip` (real clips under `controlRoot`, split on computed `overflow-x`),
`hit-targets` (≥ 44 px AND `elementFromPoint` reaches the control),
`truncate-chain` (`min-width: 0` on every flex/grid ancestor of a truncate),
`rails-a11y` (every overflowing rail keyboard-reachable; `tabindex="0"` rails
carry a role and a name). Group-level: `mustDiffer` (hashes differ),
`controlSetEqual` (membership, order, repeats — never box size).

`zoom: 1.25` reproduces the browser's 125 %: CSS viewport ÷ 1.25, DPR × 1.25,
own context per row. The PNG's IHDR width is asserted against the row's
declared window width, which is the only thing that proves the DPR applied —
a 1.25 row whose picture comes back 256 px wide never zoomed. `backdrop:
"light" | "dark"` paints a gradient under a transparent page (the overlay) —
an opaque page is unaffected.

### Three exemptions the checks make, and what earns each

None of these is a blanket excuse: each is decided by a predicate evaluated on
the live DOM, and every exempted element is printed by name in `seen.sample`.

- **`no-clip` — a bleeding rail's ancestors.** `overflowingIn` (`e2e/helpers.ts`,
  this suite's one authority for the three-way overflow split) calls both
  `overflow-x: hidden|clip` and `overflow-x: visible` a clip, which is right
  for the scorebug it was written against. Over a page root it is not: a rail
  that bleeds through the page gutter (`max-md:-mx-4`) makes every `visible`
  ancestor report `scrollWidth > clientWidth` while the content stays reachable
  inside the rail. A `visible` box is exempt ONLY when it contains a rail that
  is both `auto|scroll` and actually overflowing; a `hidden|clip` box never is.
  The split is reconciled against `overflowingIn`'s own count, so a change to
  that function reds here instead of widening the exemption.
- **`hit-targets` — a link in running text.** WCAG 2.5.8's own "Inline"
  exception. Drawn at computed `display: inline` and nowhere else, so a link
  laid out as `flex`, `inline-flex`, `inline-block` or `block` is a control and
  stays held to the full 44 px.
- **`hit-targets` — a control parked off-viewport inside a rail.**
  `document.elementFromPoint` is viewport-relative and answers `null` outside
  it, so a tab further along a scrolling rail reads as "hits nothing". Exempt
  only when an ancestor is a reachable, overflowing rail; a control off-viewport
  with no way to bring it into view is still a defect.

## Add rows for your wave (W1-E, R2 …)

1. Append a group to `manifest.json`. Use an existing `seed` kind if its
   placeholders suffice.
2. Need new state? Add ONE seed kind to `e2e/visual/seeds.ts` (`SEED_KINDS`,
   `SEED_PARAMS`, `seedFor`). That file is the only harness file a wave edits.
3. `npx vitest run src/lib/__tests__/visual-manifest.test.ts` — a dangling
   reference or an unresolved placeholder fails here, in seconds.
4. Run the harness, OPEN the pictures, write one verdict line per picture in
   the PR. A green run is not a sign-off; the pictures are.

A red `truncate-chain` / `rails-a11y` / `hit-targets` row on a page your wave
did not touch is a finding about that page — record it in the programme
`_INDEX.md`, attributed; never loosen the check.

## Known `main` findings the rows do not assert yet

A check absent from a row is invisible unless it is written down. These are the
only two, both raised BY this harness on 2026-09-08 and both owed to the wave
that owns the file — not to whoever next touches the manifest.

- **`embed-standings/standings-320` carries no `rails-a11y`.**
  `components/public-site/standings-table.tsx:58` wraps the table in
  `overflow-x-auto` with no `tabindex="0"`, no `role` and no accessible name,
  and the embed renders no links inside it, so the rail has no focusable child
  either: `div 364px in 294px: not keyboard-reachable`. That is AGENTS.md
  recurring class 23 and axe's `scrollable-region-focusable` at SERIOUS impact.
  It is not fixed here because `StandingsTable` renders on the public site, the
  embed and the console alike, and an accessible name for it is a new
  user-facing string owed in all four locales — a change with its own visual
  sign-off, not a line in a test wave. `expectRailsA11y` still RUNS on that row
  with `assert: false`, so the offending rail is listed in
  `embed-standings.report.json` on every run. Restore the check to the row in
  the same commit that fixes the component.
- **`live-score.tsx:245` still has the `truncate` without `min-w-0`** that this
  gate found and that was fixed at `match-centre/court-card.tsx:172`. Identical
  span, identical row-flex parent. Left alone because `<LiveScore>` is the
  retired scorebug (`court-card.tsx` replaced it in spectator W1) and no
  photographed route renders it — so the gate cannot see it, and this bullet is
  the only record that it is there.
