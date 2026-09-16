# Hub Knockout Tab Implementation Plan

> **For agentic workers:** execute task by task. Each task ends with its own
> verification and commit. Tasks are SEQUENTIAL — they share files.

**Goal:** the public competition hub (`/shared/{org}/{comp}`) gets a **Knockout**
tab: a round rail with match cards at every width, and an optional one-sided
**Draw** tree on screens ≥1024px, hidden by default.

**Why:** the division page is the only public home of a knockout bracket, and it
is being deprecated into the hub (`docs/superpowers/specs/2026-09-04-spectator-prompts/_INDEX.md`,
"The public division page — deprecate, but NOT YET"). Today's bracket is a
1872px two-sided tree: 81% off-screen on a phone, still scrolling at 1280.

**Owner decisions (2026-09-13), binding:**
- "B" — knockouts get their OWN hub tab.
- Option A (round rail + cards) at every width — mock:
  https://claude.ai/code/artifact/bd05d9de-88b3-49d6-9be9-93cddfdc7ed5
- "I still want to draw along with A … show draw only for Desk or Tablet?" and
  "hide by default?" — the Draw tree exists only ≥1024px, behind a switch that
  defaults to Rounds.
- "What happens if we don't have knockout?" — no Knockout tab (tabs by presence).

**Mock source (read it for the look):**
`/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/6262000e-0d12-4731-97e2-7a60369846eb/scratchpad/knockout-options.html`
— the build REUSES the hub's `MatchCard` rather than the mock's per-game tie card
(see R9).

## Global Constraints

- Worktree `/Users/ashokhein/github/seazn.club/.claude/worktrees/spectator`, branch
  `feat/spectator-poster-division`. Prefix EVERY command with
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/spectator &&`. Never touch
  the main checkout.
- Git: `/usr/bin/git` only. Commit with `git commit -o <explicit paths>`; new files
  need `git add <explicit paths>` first. NEVER `git add -A`, NEVER `git stash`,
  never `--amend`. Commit trailer:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- Node is on PATH only after `source ~/.zshrc`. Shell guards refuse compound
  commands they cannot prove stay in the worktree: write a script to the
  scratchpad and run it as one plain command.
- Unit tests: `cd apps/web && DATABASE_URL= ./node_modules/.bin/vitest run <files>
  --reporter=json --outputFile=<file>` and judge ONLY from the JSON
  (`numPassedTests/numTotalTests`, and confirm `.testResults[].name`). rtk
  summaries lie. The vitest config REFUSES a `DATABASE_URL` on :5432.
- DB-backed suites: `eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label spectw2)"`
  (Postgres :54842, server :3319). Do not start or stop that environment.
- Typecheck: `cd apps/web && node ../../node_modules/typescript-native/bin/tsc --noEmit`.
- i18n: every new user-facing string in ALL FOUR `apps/web/src/dictionaries/{en,es,fr,nl}/public.json`;
  then regenerate the generated `apps/web/src/lib/i18n-keys.ts` (find the script in
  `package.json`; never hand-edit). No hardcoded English.
- OpenAPI: the hub route's response IS `CompetitionHubDoc`, so any schema change
  needs `npm run openapi:gen` at the repo root and `openapi/v1.json` +
  `openapi/v1.public.json` committed with it (CI drift gate).
- Owner rules (`docs/superpowers/RULES.md`): every task owes unit + e2e + smoke +
  regression coverage across the plan; screenshots at 320, 768, 1024, 1280 with no
  horizontal PAGE scroll; 44px tap targets; mutate every guard you add and paste
  the killer.
- AGENTS.md failure classes apply, especially 1 (inert seam — prove through the
  real producer and consumer), 3 (a guard nothing kills), 22 (visibility folds
  and e2e), 23 (a scroll region needs tabindex=0 + role + name).
- DO NOT TOUCH: the division page and its tests, `components/public-site/bracket.tsx`,
  the match centre, the poster code, `e2e.yml`. No `UPDATE_GOLDEN=1`.

## Design rulings

**R1 — tab id.** `knockout`, inserted directly after `table` in BOTH
`HUB_TAB_IDS` (`apps/web/src/lib/matches-hub.ts`) and `CompetitionHubTabId`
(`apps/web/src/server/public-site/competition-hub-schema.ts`); a test pins the two
equal. Label `landing.tab.knockout`: en "Knockout", es "Eliminatorias",
fr "Phase finale", nl "Knock-out".

**R2 — presence.** `HubTabCounts` gains `knockouts: number`; `deriveHubTabs` emits
`knockout` iff `knockouts > 0`, after `table`. The schema refinement passes
`knockouts: doc.knockouts.length`.

**R3 — document.** `CompetitionHubDoc` gains `knockouts: z.array(KnockoutView)`:

```ts
KnockoutRound = z.object({
  key: z.string(),                 // `${lane ?? "main"}-${roundNo}`, or "third-place"
  label: z.string(),               // pre-resolved, org locale — the SAME label the round's matches carry
  lane: z.enum(["WB", "LB", "GF"]).nullable(),
  fixtureIds: z.array(z.string()).min(1),   // seq_in_round order
});
KnockoutView = z.object({
  id: z.string(),                  // `${divisionSlug}-${stageId}`
  divisionId: z.string(), divisionSlug: z.string(), divisionName: z.string(),
  stageId: z.string(), stageName: z.string(),
  kind: z.enum(["knockout", "double_elim", "stepladder", "page_playoff"]),
  rounds: z.array(KnockoutRound).min(1),
  drawable: z.boolean(),
  championFixtureId: z.string().nullable(),
});
```

- One view per stage whose kind is in `BRACKET_KINDS` (`server/public-site/champion.ts`)
  and that has ≥1 fixture. Division order, then stage `seq`.
- Rounds: grouped by `(lane, round_no)`; ordered lane `null`/WB first, then LB,
  then GF; `round_no` ascending within a lane. Fixtures with `third_place === true`
  form their own round (key `third-place`) placed immediately BEFORE the final round.
- `label`: the round's first fixture's `roundLabel` exactly as `doc.matches` carries
  it (`competition-hub.ts` resolves it with `roundRoleLabel(ui, roundRoleFor(laneByStage…))`).
  Reuse that value — never a second resolution.
- `drawable`: `kind === "knockout"` AND
  `twoSidedBracket(stageFixtures.map(f => ({ id, round_no, seq_in_round })))` from
  `@seazn/engine/scheduling` returns `ok: true`. That function is the repo's one
  authority on "is this a regular single-elimination shape".
- `championFixtureId`: the stage's final (`is_final === true`, else the single
  non-third-place fixture of the last round) iff its status is decided AND
  `outcome.winner` is non-null; else `null`.
- Refinement: every id in every `rounds[].fixtureIds` and every non-null
  `championFixtureId` must exist in `doc.matches`.

**R4 — cache.** Bump the `unstable_cache` key `"pub-hub-v1"` → `"pub-hub-v2"` in
`competition-hub.ts`: the page renders that cached document without re-parsing,
and an old-shaped hit has no `knockouts`.

**R5 — the tab.** `apps/web/src/components/public-site/matches-hub/knockout-tab.tsx`:
- **Which division (owner, 2026-09-13: "which knockout for division?").** When views
  from more than one division exist, a division chip rail sits above everything —
  the SAME chips and the SAME `?division=` parameter the Matches tab uses
  (`mh-knockout-division-all`, `mh-knockout-division-{slug}`; seeded from
  `initialDivision`, a tap writes `?division=` back through `writeDivisionParam`,
  an unknown slug or `""` falls back to All, as `matches-tab.tsx` reconciles). All =
  every division's views, grouped. One division = no rail. This is what lets the
  future division-page redirect land a knockout division on
  `?tab=knockout&division={slug}` and see only its own bracket.
- Root `data-testid="mh-knockout"`, `min-w-0`. Groups views by division under an
  `<h2 data-testid="mh-knockout-division-{slug}">`, same classes as `table-tab.tsx`'s
  division heading; each view under its stage name (`<h3>`).
- Champion banner `mh-knockout-champion-{viewId}` when `championFixtureId`: court
  slab (`bg-court text-court-ink`), a crown, `knockout.champion` ("Champion"), the
  winner's name and crest (`EntityLogo`, as `MatchCard` draws it), and
  `knockout.championLine` ("Beat {name} in the {round}").
- Round rail: `role="group"`, `tabIndex={0}`, `aria-label` `knockout.roundsLabel`;
  one chip per round, `data-testid="mh-knockout-round-{viewId}-{roundKey}"`,
  `aria-pressed`. The chip is the Matches tab's chip — EXTRACT it from
  `matches-tab.tsx` into `matches-hub/hub-chip.tsx` and use it from both (no second
  copy). Badge: a live dot when any fixture in the round has `bucket === "live"`,
  else `{done}/{total}` (`bucket === "completed"`).
- Default round: the first round (in order) holding a fixture whose bucket is not
  `completed`; if none, the LAST round. Reconcile a chosen round that stops existing
  on a later poll, as `matches-tab.tsx` does for its chips.
- The pressed chip is scrolled into view inside the rail on mount and on change
  (set the rail's `scrollLeft`; never `scrollIntoView`, which scrolls the page).
  The mock found this: opened on the Final, the pressed chip was off-screen.
- Round list: `MatchCard` per fixture (`showDivision={false}`), then — for
  `drawable` views and every round before the final — a "next" line:
  `knockout.next.through` "{name} goes through to the {round}" (decided);
  `knockout.next.meets` "Winner meets {name} in the {round}" (partner decided);
  `knockout.next.meetsWinnerOf` "Winner meets the winner of {a} v {b} in the {round}"
  (partner undecided, both sides known); `knockout.next.advances`
  "Winner goes through to the {round}" (otherwise). Partner = fixture `i ^ 1` in the
  same round; `{round}` = the next round's label.
- View switch, only when `drawable`: two chips `mh-knockout-view-rounds` /
  `mh-knockout-view-draw` (`knockout.view.rounds` "Rounds", `knockout.view.draw`
  "Draw"), in a container with `max-lg:hidden`. State from `?view=` (R6); a tap
  writes `view=draw` or deletes the parameter. Default Rounds.
- When the view is Draw and `drawable`: the rounds block gets `lg:hidden`, the draw
  block is `hidden lg:block`. Below `lg` a `?view=draw` link therefore shows Rounds.
- Draw: one-sided tree, left to right, one column per non-third-place round;
  column 188px, gap 12px, round-0 cell 64px and round k `64·2^k`; node = two rows
  (name truncated, `scoreLines[i]`), a link to the match's `href`, winner bold,
  emerald border when live; CSS connectors as in the mock; round labels above the
  columns; the third-place node under the final. The tree sits in an
  `overflow-x-auto` wrapper with `tabIndex={0}`, `role="region"` and
  `aria-label` `knockout.drawLabel` (a 64-draw is wider than 992px).

**R6 — URL params.** In `components/public-site/use-tab-param.ts` add a generic
`readSearchParam(name)`, `writeSearchParam(name, value | null)` and
`useSearchParam(name)` (same `popstate` subscription, null server snapshot). Keep
every existing export as a thin wrapper; the existing `use-tab-param.test.tsx`
stays green unchanged.

**R7 — landing.** `panelFor` gets a `knockout` arm rendering
`<KnockoutTab doc dict locale now initialDivision />` (the same `initialDivision`
the Matches arm already receives); `competition-landing.test.tsx`'s per-arm prop
table gains the row.

**R8 — dictionary slice.** Add `"knockout."` to `HUB_DICT_PREFIXES`
(`lib/hub-dict.ts`) and keep its differential test honest.

**R9 — not in this plan.** Per-game scores (the hub document carries
`scoreLines`, not set rows), squads, suspensions, division descriptions, results
grid, a Draw for double-elim/stepladder/page-playoff, and the division-page
redirect.

## Task 1 — the document

Files: `competition-hub-schema.ts`, `competition-hub.ts`, `lib/matches-hub.ts`,
the four `public.json` (`landing.tab.knockout` only), `lib/i18n-keys.ts` (regen),
`openapi/v1.json`, `openapi/v1.public.json`, and the tests/fixtures that construct
documents or tab counts: `lib/__tests__/matches-hub.test.ts`,
`server/public-site/__tests__/competition-hub.test.ts`,
`server/public-site/__tests__/competition-hub-schema.test.ts`,
`server/public-site/__tests__/_hub-doc.ts`,
`server/public-site/__tests__/competition-hub-db.test.ts`,
`components/public-site/__tests__/hub-fixtures.tsx`, plus any other constructor a
`grep -rna "tables:" apps/web/src --include=*.ts*` in `__tests__` finds.

Acceptance:
1. R1–R4 implemented exactly.
2. Unit: `deriveHubTabs` with/without knockouts (and order after `table`); schema
   refuses a doc whose tabs omit `knockout` while `knockouts` is non-empty, and a
   round naming a fixture not in `matches`; builder: a league-then-knockout
   division yields tables for the league and ONE view for the knockout, rounds in
   order with the matches' labels, third place before the final, `drawable` true
   for an 8-draw and false for a 3-fixture round-0, champion only when decided.
3. DB (`competition-hub-db.test.ts`): a real knockout stage persisted and read back
   into `knockouts`.
4. Mutants, each killed, killer test named: drop the `knockout` push in
   `deriveHubTabs`; `drawable: true` always; champion without the decided check;
   third-place round placed after the final.
5. tsc clean; OpenAPI regenerated and committed; counts pasted from JSON.

## Task 2 — the tab

Files: `matches-hub/knockout-tab.tsx` (new), `matches-hub/hub-chip.tsx` (new),
`matches-hub/matches-tab.tsx` (chip extraction only), `matches-hub/competition-landing.tsx`,
`use-tab-param.ts`, `lib/hub-dict.ts`, four `public.json` (`knockout.*`),
`lib/i18n-keys.ts`, tests: new `components/public-site/__tests__/knockout-tab.test.tsx`,
`competition-landing.test.tsx`, `use-tab-param.test.tsx`, `matches-tab.test.tsx`
(must stay green), hub-dict's test.

Acceptance:
1. R5–R8 implemented exactly.
2. Unit (static markup): default round (a mid-event fixture set opens on the first
   unfinished round; all-decided opens on the last); chip `aria-pressed` agrees;
   champion banner present iff `championFixtureId`; every next-line branch;
   switch present iff `drawable`, and its container carries `max-lg:hidden`
   (anchor the class regex on `\s…"` per AGENTS.md); `?view=draw` seed renders the
   tree inside `hidden lg:block` and the rounds with `lg:hidden`; a non-drawable
   view ignores `view=draw`; the draw region has `tabindex="0"`, `role="region"`,
   an `aria-label`.
3. Mutants killed and named: the default-round rule returning round 0; the switch
   rendered for a non-drawable view; the `lg:hidden` on rounds removed.
4. All four locales carry every `knockout.*` key; i18n-keys regenerated; tsc clean.

## Task 3 — e2e, smoke, and the look

Files: new `apps/web/e2e/hub-knockout.spec.ts`; `scripts/smoke.ts` (one hub check).

Acceptance:
1. E2E (API-seeded public 8-draw, some results): `/shared/{org}/{comp}?tab=knockout`
   shows the rail opened on the first unfinished round and its cards; at 1280 the
   Draw switch is visible, tapping it writes `view=draw` and shows the tree with the
   final's column; reload keeps Draw; at 390 and 768 the switch is not visible, the
   Rounds list is, and there is no horizontal page scroll; a league-only competition
   has no `mh-tab-knockout`.
2. Smoke: the hub JSON for a seeded knockout competition carries `knockout` in
   `tabs` and a `knockouts[0].rounds` with fixture ids that exist in `matches`.
3. Run the whole new spec file (never `-g`), paste the counts.

## Visual verification and owner sign-off (owner, 2026-09-13: "Make sure that follow visual verification and sign off")

Binding on Tasks 2 and 3. A green suite is not a sign-off (AGENTS.md classes 10, 11, 15).

1. **Real renders, rebuilt bundle.** `seazn-env rebuild --label spectw2` after the last code
   commit; confirm the build is newer than the last edited file before capturing anything.
2. **The matrix, every cell captured and looked at:**
   | State | 320 | 390 | 768 | 1024 | 1280 |
   |---|---|---|---|---|---|
   | Knockout tab, mid-event (live round opens) | ✓ | ✓ | ✓ | ✓ | ✓ |
   | Draw complete (opens on Final, champion banner, pressed chip visible) | ✓ | | ✓ | | ✓ |
   | Draw switch tapped (`?view=draw`) | — | — | switch absent, Rounds shown | ✓ tree | ✓ tree |
   | Multi-division: All, then one division chip | ✓ | | | | ✓ |
   | Non-drawable bracket (double elim or odd field) | ✓ | | | | ✓ |
   | League-only competition: no Knockout tab | ✓ | | | | ✓ |
   | 32-draw tree at 1024 — fits, no sideways scroll inside or out | | | | ✓ | |
3. **Every capture proves it is different and current:** images exist, differ from each other,
   and each is taken after the state it claims (the chip pressed, the URL written) — assert that
   in the script and print what it saw, then take the picture.
4. **Per-screen verdicts, written down:** one line per cell — pass, or the defect seen (clipped
   text, overlap, misalignment, colour, tap area, horizontal page scroll). A cosmetic defect is a
   defect; fix and recapture before moving on.
5. **Owner sign-off:** publish the contact sheet with the verdicts as an artifact and put it in
   front of the owner. No PR, no merge, and no division-page redirect until the owner signs it off.

## Review rulings — Task 2, round 1 (2026-09-13)

- **Default round order** replaces R5's two-rung rule: the first round with a LIVE fixture; else,
  when there is a champion, the round holding the champion's fixture; else the first round with a
  non-completed fixture; else the last round. Found by review: a finished double-elim whose unowed
  reset is still `scheduled` opened on that empty reset round under the champion banner, and a live
  losers' round could sit behind an upcoming winners' round.
- **An unowed reset leaves the rail.** When the champion was crowned off GF1 (no reset owed), a round
  made only of unsettled `conditional` fixtures is omitted from `rounds`. The fixture stays in
  `matches`. The engine defect that leaves it `scheduled` is recorded in `_INDEX.md`.
- **Draw column 184px** (was 188): a 32-draw is 968px, which fits the 977px column a 1024px window
  leaves beside a classic 15px scrollbar. Headless capture hides scrollbars, so this is set by
  arithmetic, not by a screenshot.
- **Walkover banner.** A final won by forfeit reads `knockout.championLineWalkover` ("Won the {round}
  by walkover against {name}"), not "Beat {name}".
- **Accepted deviations:** division heading testid `mh-knockout-heading-{slug}` (the plan's id
  collided with the chip's); ONE Rounds|Draw switch for the tab, shown when a bracket ON SCREEN is
  drawable, non-drawable brackets keep Rounds in Draw mode; es/fr sentences lead with the round name.
