# Visual gate — running and extending the capture harness

The harness is `apps/web/e2e/visual/capture.spec.ts`, driven by
`apps/web/e2e/visual/manifest.json`. It runs in CI on every push to `main`
inside the parallel project's "rest" leg (no config names it — the default
`testMatch` selects it, and `src/lib/__tests__/e2e-ci-wiring.test.ts` proves
that against the real config on every vitest run). It has NO env-var skip: a
run that photographs nothing fails (recurring failure class 10).

## Run it locally

    S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh
    $S up --label <label> --server        # from the worktree; rebuild after a code change
    $S env --label <label>                # read PLAYWRIGHT_BASE (= SMOKE_BASE)
    cd apps/web && VISUAL_DIR=/path/you/keep PLAYWRIGHT_BASE=<base> E2E_PROD_TARGET=1 \
      npx playwright test e2e/visual/capture.spec.ts --project=parallel --reporter=line

Pictures land in `VISUAL_DIR` (default `apps/web/test-results/visual/<TAG>`)
as `<group>--<row>.png` + `.sha256`, plus `<group>.report.json` (seed params,
hashes, the control set per row, the reachable rails, the exemptions). The
`[control-set …]` block in the log is the 320-vs-1280 diff a reviewer reads,
and each row's `[visual …] seen={…}` line prints what every check INSPECTED.

**`inspected: 0` is a finding about the row, not a pass.** It means the check
ran over nothing. `rails-a11y` legitimately reports 0 on a page with no
overflowing rail; a `truncate-chain` or `no-clip` reporting 0 means the row
should not be listing that check. (`truncate-chain` was briefly on the embed
rows and inspected zero truncates there; it was removed for exactly this
reason, and the fixture rows where it inspects 5 are its real coverage.)

## What a row asserts

`checks` per row: `no-horizontal-scroll` (page-level,
`expectNoHorizontalScroll`), `no-clip` (real clips under `controlRoot`, split
on computed `overflow-x`), `hit-targets` (≥ 44 px AND `elementFromPoint`
reaches the control), `truncate-chain` (`min-width: 0` on every flex/grid
ancestor of a truncate), `rails-a11y` (every overflowing rail
keyboard-reachable; `tabindex="0"` rails carry a role and a name).
Group-level: `mustDiffer` (hashes differ), `controlSetEqual` (membership,
order, repeats — never box size).

Two checks are deliberately WIDER than the row's `controlRoot`:
`expectTruncateChain` and `expectRailsA11y` scan the whole document. A broken
truncate chain or an unreachable rail in the header breaks the page just as
thoroughly as one in `main`.

`awaitSelector` must be something ONLY the intended page renders. `main h1`
is not: `shared/[orgSlug]/not-found.tsx` renders an `<h1>` inside the same
`<main>` the fixture page's layout provides, and on a 404 every check passes
and both cross-row comparisons still hold — the whole group would sign off on
the wrong page. `visual-manifest.test.ts` refuses a bare-heading
`awaitSelector` for this reason. The fixture rows await
`[data-testid=mc-score-0]`.

`zoom: 1.25` reproduces the browser's 125 %: CSS viewport ÷ 1.25, DPR × 1.25,
own context per row. The PNG's IHDR width is asserted against the row's
declared window width (within a pixel — `round(w / zoom) * zoom` is not
integral for every zoom), which is the only thing that proves the DPR applied.

`backdrop: "light" | "dark"` paints a gradient under a transparent page (the
overlay); an opaque page is unaffected, so `fixture-768` carries one purely to
keep the path live — `applyBackdrop` asserts the computed `html`
`background-image` really is a gradient afterwards, because a backdrop that
silently failed to paint would make every future overlay row photograph the
wrong thing while still passing.

### Five narrowings the checks make, and what earns each

None is a blanket excuse: each is decided by a predicate evaluated on the live
DOM, and every element a check EXCUSES is returned in full and asserted
against the row's declared `exempt` list in `manifest.json`. A NEW exemption
fails the row until someone writes it down — which is AGENTS.md class 23
("assert that every box you excused is the reachable kind, or the next
overflow hides behind it") applied literally.

1. **`no-clip` — a bleeding rail's ancestors.** `overflowingIn`
   (`e2e/helpers.ts`, this suite's one authority for the three-way overflow
   split) calls both `overflow-x: hidden|clip` and `overflow-x: visible` a
   clip, which is right for the scorebug it was written against. Over a page
   root it is not: a rail that bleeds through the page gutter (`max-md:-mx-4`)
   makes every `visible` ancestor report `scrollWidth > clientWidth` while the
   content stays reachable inside the rail. The exemption is ACCOUNTED FOR,
   not merely explained: the rail's box must reach far enough past the
   parent's own content edge to cover the parent's WHOLE overhang. "Contains
   some overflowing rail" is not enough — `main` satisfies that on every
   fixture row forever, so a genuinely too-wide fixed child would have been
   waved through on the one box that could have reported it (a too-wide fixed
   child never enters the suspect list itself: its own `scrollWidth` equals
   its `clientWidth`). A `hidden|clip` box is never exempt. The split is
   reconciled against `overflowingIn`'s own count, so a change there reds here
   instead of widening the exemption.
2. **`hit-targets` — a link in running text.** WCAG 2.5.8's own "Inline"
   exception. Drawn at computed `display: inline` and nowhere else, so a link
   laid out as `flex`, `inline-flex`, `inline-block` or `block` is a control
   and stays held to the full 44 px.
3. **`hit-targets` — a control parked off-viewport.**
   `document.elementFromPoint` is viewport-relative and answers `null` outside
   it. Split PER AXIS: a control off to the right needs a horizontally
   scrollable ancestor (or a scrollable document); one below the fold needs a
   vertically scrollable one. A control off-viewport with nothing to scroll on
   that axis is still a defect. (Testing only `overflow-x` would have reddened
   the first below-the-fold button any wave added — a false red whose obvious
   repair is to loosen the check, which is how a gate dies.)
4. **`truncate-chain` — only a ROW flex parent bites.** `min-width: auto`
   resolves to the automatic minimum size on the MAIN axis only
   (css-flexbox-1 §4.5), so in the root layout's `flex-col` a child's
   `min-width` is already 0 and demanding `min-w-0` on `<header>`/`<main>` is
   demanding a no-op. Grid items are still checked: there the automatic
   minimum applies in the inline axis whatever the flow.
5. **`truncate-chain` — the walk stops at the first ancestor that BOUNDS the
   width**: one that scrolls or clips horizontally, or that carries a
   max-width in LENGTH units. Nothing above such a box can widen the
   truncate's line. **A PERCENTAGE max-width does not count** — `max-w-full`
   resolves against a containing block an unshrinkable ancestor can widen, and
   `min-width` overrides `max-width` (CSS 2.1 §10.4), so a `max-w-full
   truncate` span in a row flex with no `min-w-0` does not engage. Treating
   any `max-width` as a bound skipped exactly the defect this gate found in
   `court-card.tsx`, and `max-w-full` is live in this repo
   (`components/public-site/tabs.tsx`).

## Add rows for your wave (W1-E, R2 …)

1. Append a group to `manifest.json`. Use an existing `seed` kind if its
   placeholders suffice. Give the row an `awaitSelector` only that page draws.
2. Need new state? Add ONE seed kind to `e2e/visual/seeds.ts` (`SEED_KINDS`,
   `SEED_PARAMS`, `seedFor`). That file is the only harness file a wave edits.
3. `npx vitest run src/lib/__tests__/visual-manifest.test.ts` — a dangling
   reference, an unresolved placeholder, an unknown check name or a
   bare-heading `awaitSelector` fails here, in seconds.
4. Run the harness. It will tell you every box its checks excused; put those
   in the row's `exempt` and read each one before you do.
5. OPEN the pictures and write one verdict line per picture in the PR. A green
   run is not a sign-off; the pictures are.

A red `truncate-chain` / `rails-a11y` / `hit-targets` row on a page your wave
did not touch is a finding about that page — record it in the programme
`_INDEX.md`, attributed; never loosen the check.

## Recording a defect you are not fixing

A check you cannot assert because the page has a defect owed to another wave
goes in the row's `knownDefects`, never silently out of `checks`:

```json
"knownDefects": [{
  "check": "rails-a11y",
  "offenders": ["div"],
  "reason": "<file>, why not fixed here, what lands first"
}]
```

The harness still RUNS the check and compares its offenders against
`offenders` **as a set**. So the row reds in both directions: when the recorded
defect disappears (someone fixed the page — the message says to delete the
entry and restore the check), and when a *different* offender joins it. Prose
in a runbook cannot do either — nothing failed when the fix landed, so nobody
was told.

Two things to be precise about, because the earlier wording over-claimed:

- **`expectRailsA11y` scans the whole document**, so the comparison is over
  every rail on the page, not the one the reason names. It says "these exact
  rails still offend", not "this rail still offends". A page with two
  unreachable rails must declare both.
- **`check` is restricted to `KNOWN_DEFECT_CHECKS`** — today just
  `rails-a11y`, the only check with a non-asserting mode
  (`expectRailsA11y(page, label, { assert: false })`). Every other check throws
  on its first offender and hands nothing back, so the harness cannot verify
  the recorded defect is still there. Recording one used to be accepted by the
  schema and then fail unconditionally with "the page was FIXED" — false, and
  aimed at a wave doing exactly what this harness invites. `parseManifest` now
  refuses it and tells you what to build first.

`parseManifest` also refuses a check listed in both `checks` and
`knownDefects`, an entry with no `offenders`, and a reason shorter than 40
characters.

## Known `main` findings

- **`standings-320` records `rails-a11y` as a known defect.**
  `components/public-site/standings-table.tsx:58` wraps the table in
  `overflow-x-auto` with no `tabindex="0"`, no `role` and no accessible name,
  and the embed renders no links inside it, so the rail has no focusable child
  either: `div 364px in 294px: not keyboard-reachable`. That is AGENTS.md
  class 23 and axe's `scrollable-region-focusable` at SERIOUS impact. Not
  fixed in streaming T1b because `StandingsTable` renders on the public site,
  the embed and the console alike, and an accessible name for it is a new
  user-facing string owed in all four locales. The manifest entry declares
  `offenders: ["div"]` and is what will tell the fixing wave to restore the
  check — the row reds the moment that set changes in either direction.
- **`live-score.tsx:245` still has the `truncate` without `min-w-0`** that this
  gate found and that was fixed at `match-centre/court-card.tsx:172`.
  Identical span, identical row-flex parent. Left alone because `<LiveScore>`
  is the retired scorebug (`court-card.tsx` replaced it in spectator W1) and no
  photographed route renders it — so the gate cannot see it, and this bullet is
  the only record that it is there.
