# Competition Desk — competition dashboard, division dashboard, fixtures tab — design

Date: 2026-09-02. Branch `feat/fixture-console-redesign`, worktree `seazn.club-fxc`.
Proposal artifact (options A/B, current-state screenshots, recommended hybrid C1–C3):
https://claude.ai/code/artifact/b9a5511a-0ba5-496d-b8d1-6b1ca9a865c8

## Goal

The organiser's three working screens — competition page, division page, and its
fixtures tab — are today organised the way the database is (competition → division
→ stage → round → fixture). Reorganise them around the organiser's own question:
**what is on now, what is next, what is blocking me** — on a phone at the venue and
at a desk the week before — without touching the scorepad or the schedule board.

Customer: the club organiser (usually a volunteer, often on a phone at the venue)
and, second, the scorer they hand a fixture to.

## Decisions locked during brainstorm (owner, 2026-09-02)

1. Surface = the DIVISION page `?tab=fixtures` (stages-panel), the division page
   shell, and the competition page. NOT `components/v2/fixture-console.tsx` (the
   single-fixture scoring console; R7 owns it).
2. One surface serves both pre-event setup and match day ("Both, one surface").
3. Direction: **Option A (run sheet, time axis) + Option B's in-play scoreboard
   band on the competition page only** ("ship A, borrow B's" — approved).
4. Scorepad skins, the `/schedule` board, slideshow: out of scope, unchanged.
5. Every recommendation and finding is stated as product value to the organiser.

## Current state (verified on a fresh prod build, 2026-09-02)

Screens captured at 1280 and 375 from a seeded six-team football league (15
played) and a U16 cup (league complete, finals pending). Findings, each with the
organiser cost:

| # | What the screen shows | File | Organiser cost |
|---|---|---|---|
| 1 | Division card reads "Live" + "Nothing scheduled yet" + "15 of 15 played" at once | `components/ui/entity-card.tsx:117-147`, chip from `components/ui/status-chip.tsx:60-68`, fed by `app/o/[orgSlug]/c/[compSlug]/page.tsx:299-329` via `usecases/card-stats.ts` | Status cannot be trusted; "Live" means "division started", not "playing now" |
| 2 | Competition page has no to-do list; pending finals proposal, unscheduled fixtures, awaiting registrations invisible | `c/[compSlug]/page.tsx` (toolbar 152-230, cards 299-329) | Organiser drills into each division's tabs to discover work |
| 3 | Every fixture row: "Unscheduled" + "Decided" + "View" chips; no time or pitch | `components/v2/stages-panel.tsx:1701-1724` (`FixtureLine`, 1562-1587) | "Unscheduled" on a decided match is noise; the two venue facts (when, where) are absent; 15 fixtures = 2,025 px at 375 |
| 4 | "Starting locks the setup" tip persists on a complete stage | `stages-panel.tsx:718` `<TipCallout id="division.start-locks">`, copy `config/tips.ts:19-23`, condition = `canEdit` only | Teaches the organiser to ignore banners |
| 5 | Stage 2 renders above Stage 1; empty "Required court tags" footer on every stage | ordering `stages-panel.tsx:806-812` (complete sinks last); footer `:1123`, `:2018` | Order and chrome carry no information |
| 6 | Actions in six places: Schedule (`d/[divSlug]/page.tsx:372-378` `LaunchActions`), Generate / Add match / Complete stage (stage header), Compute proposal (progression panel), Documents (`stages-panel.tsx:755`), tz caption (`:752`, key `schedule.tz.caption`), Add stage | — | No one place to move the division forward |

Nothing in `apps/web/e2e/**` asserts on the division-card progress text or on the
fixture-row chips (grep on 2026-09-02), so the row rewrite breaks no existing e2e
assertion by text; nine specs drive the panel by behaviour and will be re-anchored
(`division-schedule`, `schedule-datetime-ux`, `scoring`, `capacity-precheck`,
`stage-roster-drift`, `knockout`, `journey-pro`, `f3-day-one-shots`, `mobile`).

### False premises found on the way (recorded, not blockers)

- "Fixture Console" in owner vocabulary ≠ `FixtureConsole` component. A grep on the
  literal name lands on the wrong surface with total confidence.
- Scout reported `schedule.tz.caption` ("Times shown in {tz}") and the Schedule
  Board button as absent from the tree; both exist (`ui.json:371`, `:559`). A grep
  that misses a dictionary key is not evidence of absence.
- `npm run seed:demo:setup` fails against a prod build (`verify_token` is dev-only)
  and the seed phase aborts with `STAGE_COMPLETED_SEEDING_FAILED` (script completes
  a stage before generating the next stage's TBD fixtures). Seed-script drift; not
  fixed in this programme.

## The shared model (W1, everything else keys off it)

### `DivisionPhase` — derived, never stored

`apps/web/src/lib/division-phase.ts`, pure, no DB, no engine import. Input is one
plain object so the resolver is table-testable and the same on server and client:

```ts
type PhaseInput = {
  divisionStatus: "setup" | "scheduled" | "active" | "completed"; // divisions.status (V209 check constraint, zod DivisionStatus)
  stages: { seq: number; status: "pending" | "active" | "complete" | string; hasFixtures: boolean; needsProposal: boolean }[];
  fixtures: { status: string; scheduledAt: string | null }[]; // API status set: scheduled|in_play|decided|finalized|abandoned|forfeited|cancelled
  now: string;            // ISO
  tz: string;             // the GOVERNING clock: ScheduleSettingsOut.orgTz, never settings.tz (display lane) — memory reference_settings_tz_vs_orgtz_trap
};
type DivisionPhase = "setting_up" | "scheduled" | "match_day" | "finished";
```

Rules, first match wins:

1. `setting_up` — `divisionStatus` is `setup` (a division that has not been started
   cannot be scored, even with fixtures dated today). **Amended 2026-09-02 during
   W1 Task 3:** this rule was originally second, behind `finished`, and a brand-new
   division with zero stages and zero fixtures satisfied `finished` VACUOUSLY —
   "no stage is pending/active" and "no fixture is live" are both trivially true of
   an empty division, so the first division an organiser ever creates read
   "Finished" before it had begun. `divisionStatus` is checked first.
   `scheduled`/`active`/`completed` fall through to the rules below.
2. `finished` — every stage is `complete`, or no stage is `pending`/`active` and
   no fixture is `scheduled`/`in_play`.
3. `match_day` — any fixture `in_play`, OR any `scheduled` fixture whose
   `scheduledAt` falls on today's date in `tz`.
4. `setting_up` — the lowest-seq non-complete stage has `hasFixtures === false`
   or `needsProposal === true` (U16 Cup on 2026-09-02: league complete, finals
   pending proposal → `setting_up` + `needs_draw`).
5. `scheduled` — otherwise (fixtures exist, none today, none in play).

Pill precedence: a division's pill shows its highest-severity attention when one
is red (`needs_draw`, `no_scorer`), else the phase. So U16 reads "Needs draw",
not "Setting up"; a match-day division with a scorerless fixture reads "No
scorer" until it is assigned.

Attention flags are orthogonal to phase and returned alongside it:

```ts
type Attention =
  | { kind: "needs_draw"; stageId: string }
  | { kind: "unscheduled"; count: number }
  | { kind: "no_scorer"; fixtureId: string; minutesSinceKickoff: number }   // in_play, zero score events
  | { kind: "result_missing"; fixtureId: string }                          // scheduled, scheduledAt + settings.config.matchMinutes < now
  | { kind: "registrations_waiting"; count: number };
```

Severity is fixed per kind (`no_scorer`, `needs_draw` = red; `unscheduled`,
`result_missing` = amber; `registrations_waiting` = slate) so the list orders
itself and the colour is never chosen at the call site.

### Status line

`statusLine(phase, stats, msg)` in the same file returns ONE string per division,
e.g. "Round 4 of 5 · 10 of 15 played · 3 unscheduled", "League complete · Finals not
drawn", "Next Sat 12 Sep 10:00 · 3 fixtures". Replaces the three-chip stack in the
card. Keys `desk.status.*` in all four dictionaries.

### `getCompetitionDesk` use case

`apps/web/src/server/usecases/competition-desk.ts`, one call per competition page
render. Composes the existing `listDivisionCardStats` (`card-stats.ts:158`, already
returns `played`, `total`, `next`, `awaiting_confirmation`, `stage_kinds`,
`registration_open`) with `listStages` (`stages.ts:215`) and a single fixtures
query per competition (status, scheduled_at, division_id, score-event count for
in_play rows). Returns per division: `phase`, `attention[]`, `statusLine` inputs,
`inPlay[]` (for the band: fixture no, entrant names, headline via
`listFixtureHeadlines` `fixtures.ts:352`, court label, scorer display name, minutes
since kickoff). Logged with pino at debug on entry/exit with counts (new code =
logging rule).

The score-event count for `no_scorer` is one grouped query over `score_events` for
the in_play fixture ids — not N+1.

## W1 — competition page (`c/[compSlug]/page.tsx`)

Layout (C1/C2 in the artifact):

```
masthead   title · phase pill (competition-level: "2 in play" | "Match day" | "Next Sat 12 Sep" | "Finished") · sport · divisions · dates · venue
           tools row: Slideshow ↗ · Schedule Board · Registration (count) · Event pass · Settings   (same routes as today; Event pass moves out of the hero slot into the tools row)
[band]     W3 — absent in W1
Needs you  list, severity-ordered; each row = dot · message · sub-line · one action button
Divisions  ledger rows: avatar · name + format line · progress bar + status line · phase pill · next/blocker · action
```

- Competition-level pill = max over divisions (any `in_play` → "N in play"; any
  `match_day` → "Match day"; else earliest next fixture date; all `finished` →
  "Finished").
- "Needs you" hides entirely when empty (no "all clear" box).
- **Identity glyphs (owner ruling 2026-09-02):** every division row carries its
  SPORT icon in the avatar slot — the uploaded division logo when one exists
  (`resolveLogoUrl`, as `EntityCard` tile media does today), otherwise the sport
  glyph from `sportEmoji(sport_key)` (`components/discovery-cards.tsx:21`,
  already used by the org page), never a letter monogram. The competition
  masthead carries NO sport icon: a competition can span sports, so its sub-line
  names the sport(s) as text ("Football · 2 divisions") and the icon lives on the
  rows. W1 reuses the emoji map; replacing it with a monochrome SVG set is a
  follow-up, not this programme.
- Division ledger replaces the `EntityCard` grid for divisions on this page only;
  `EntityCard` stays for orgs/competitions elsewhere. New
  `components/v2/desk/division-ledger.tsx`, `needs-you.tsx`, `phase-pill.tsx`.
- Tip `division.start-locks` (`stages-panel.tsx:718`) gated to
  `phase === "setting_up"` — one-line change once the phase exists, ships in W1.
- Stage ordering fix: render by `seq` ascending always (`stages-panel.tsx:806-812`
  drops the complete-sinks-last term); ships in W1 because it is a one-line fix
  the owner has already seen.

Tests (W1):
- Unit: `division-phase.test.ts` table-driven over the full matrix — 3 division
  statuses × stage shapes (none / pending-no-fixtures / pending-needs-proposal /
  active / complete) × fixture sets (none / all decided / one in_play / one today
  / one future / one unscheduled) × tz boundary (23:30 vs 00:30 local). Assert
  phase AND attention list. Mutation gate: delete rule 2 → the "today" cases must
  fail; delete `needsProposal` → the U16 case must fail.
- Unit: `competition-desk.test.ts` against the DB test harness (`:54329` pattern)
  seeding the exact 2026-09-02 shape (Premier 15/15 decided, U16 league complete +
  finals pending) → asserts `finished` + `needs_draw`, and NO `nothing scheduled`
  text anywhere in the rendered card (regression for finding 1).
- E2E: `competition-desk.spec.ts` — seeds via API, asserts "Needs you" rows by
  `data-attention="needs_draw"` etc. anchored with `="` (never a bare `data-*`),
  clicks "Compute proposal" and lands on the U16 fixtures tab.
- Smoke: `scripts/smoke.ts` step: competition page 200 and contains
  `data-phase="…"` for every division.
- Regression: the 3-chip contradiction pinned (above); tip hidden on a complete
  stage (mutate the gate: `return true` must fail).

## W2 — fixtures tab as a run sheet (`stages-panel.tsx`)

Layout (A2 in the artifact), desktop `lg:` two columns `1fr 280px`; below `lg`
the rail becomes a bottom sheet opened by a floating "Stage tools" button.

Left — the sheet:
- Filter segment: Today · Needs result (n) · Unscheduled (n) · All. Default = Today
  when phase is `match_day`, else All. URL param `?tab=fixtures&filter=…` so it is
  linkable from "Needs you".
- Groups by calendar day in the org clock (`settings.orgTz`, the governing zone; `settings.tz` is display-only and formats the HH:mm), ascending; header
  "Saturday 5 September · venue · n fixtures". A final group "Not yet scheduled"
  lists rows with `scheduled_at` null, ordered by stage seq, round, seq_in_round.
  Round is shown INSIDE the row (small label under the court), never as a bar.
- Time spine: left column = `HH:mm` mono; a NOW rule (lime, label "NOW") inserted
  once, between the last row whose time ≤ now and the first > now, only on a day
  group whose date is today. Rows whose status is `in_play` get the amber dot
  regardless of time.
- Row anatomy: `court + round` · `home v away` · `score/result + sub-line` · ONE
  action. Action by state: `in_play` → "Open pad"; `scheduled` & today & no
  officials → "Assign scorer"; `scheduled` → "Score"; decided/finalized → "Result";
  unscheduled → "Set time" (opens the existing datetime field
  `shared/datetime-field.tsx` inline). Chips removed: no "Unscheduled", no "Decided",
  no "View". Status is carried by the dot colour + sub-line copy
  (`fixtureStatusLabel` stays as the sub-line source).
- Existing mutation endpoints unchanged: PATCH `/api/v1/fixtures/{id}` (time/court),
  `/stages/{id}/fixtures` (generate), `/divisions/{id}/undo`.

Right — the stage rail (`components/v2/desk/stage-rail.tsx`):
- One card per stage in `seq` order; active stage expanded. Steps list derived,
  not typed: entrants confirmed → fixtures generated → n of m scheduled → n of m
  played → complete. Each step's tick state comes from the same numbers the
  status line uses (`card-stats`), so the two cannot disagree.
- Buttons: Add match, Schedule board, More ▾ (Generate, Complete stage, Delete
  stage, Court tags). "Compute proposal" appears as the primary button on a stage
  whose `needsProposal` is true (moves in from `progression-panel.tsx`'s top card;
  the panel's confirm flow is reused unchanged).
- "Up next" card, "Documents" card (`DocumentsMenu` moves here from `:755`),
  tz caption `schedule.tz.caption` moves under the filter segment.
- "Required court tags" editor (`StageCourtTagsEditor`) moves under More ▾ and is
  hidden when the stage has no tags.

Masthead (`d/[divSlug]/page.tsx:298-378`): one row = title + phase pill + status
line; tools right = Slideshow ↗ · Registration · one primary CTA by phase
(`setting_up`: the `LaunchActions` primary as today; `match_day`: "Score next:
A v B" → routes.fixture of the next scheduled/in_play row; `scheduled`: "Schedule
board"; `finished`: none). Tab strip gains counts (fixtures, entrants, discipline)
from data already loaded by the page.

Bracket / americano / ladder panels: unchanged inside the tab; they render ABOVE
the run sheet for their stage, as today.

Tests (W2):
- Unit: `run-sheet-groups.test.ts` (grouping, NOW placement, tz boundary, an
  unscheduled group ordering) — pure builder over `FixtureRow[]`. This builder is
  fed by the page from `listDivisionFixtures` and the e2e below asserts the
  rendered order, so the seam is driven end to end, not fixture-to-fixture.
- Unit: `fixture-row-action.test.ts` — the state → action table, enumerated.
- E2E: `run-sheet.spec.ts` with `page.clock.setFixedTime` — NOW rule between the
  right rows; "Set time" on an unscheduled row moves it into the day group; "Open
  pad" opens the fixture console; filter param round-trips. Re-anchor the nine
  existing specs on `data-fixture-no="…"` rows instead of chip text.
- Smoke: fixtures tab 200 and contains `data-run-sheet-day` for a seeded day.
- Regression: a decided fixture renders no "Unscheduled" chip (finding 3); stage 1
  renders above stage 2 (finding 5); tip absent on `finished` (finding 4).
- Mobile: rows added to `mobile.spec.ts` at all seven widths, no horizontal scroll,
  tap targets ≥ 44 px measured with `elementFromPoint`, not `boundingBox`.

## W3 — phone layouts and the in-play band

- Band component `components/v2/desk/in-play-band.tsx`: night ground, lime LED
  numerals (existing `--sport-led` token), one card per `in_play` fixture across
  divisions, plus one dashed "Up next" card; "NO SCORE" in red when the fixture
  has zero events. Rendered only when `inPlay.length > 0`; no empty state.
- Polling: client refetches `/api/v1/competitions/{id}/desk` every 20 s while the
  competition pill says in play, stops otherwise. Endpoint is new, read-only,
  documented in OpenAPI (`npm run openapi:gen` drift check before commit).
- Phone: masthead tools collapse to icons; ledger rows become stacked cards (C3);
  run sheet rows become two-line (A3); stage rail → bottom sheet.

Tests (W3): unit (band renders nothing at zero in-play — mutate the guard); e2e
(band appears when a fixture is set in_play via API, disappears on decide; polling
verified with `page.clock`); smoke (endpoint 200, schema-validated); regression
(band absent off match day). Screenshots at 1280 / 768 / 320 for both pages in all
four phases, images confirmed to exist and DIFFER.

## Copy and i18n

All new strings in `dictionaries/{en,es,fr,nl}/ui.json` under `desk.*`, then
`npm run i18n:gen-keys` (generated `i18n-keys.ts`). Register: active verbs on
buttons ("Assign scorer", "Set time", "Open pad"), sub-lines say the fact ("No
scorer yet", "Kicked off 12 min ago"). Help pages under `content/help/**`
(English only) updated for the competition page and fixtures tab in the wave that
changes each; smoke demo script updated in W2.

## Error and empty states

- Desk use case failure → page still renders masthead + ledger from `card-stats`;
  "Needs you" and band omitted; error logged with competition id. Never a blank
  page for a summary failure.
- Division with no stages → ledger row phase `setting_up`, action "Add stage".
- **Competition with no divisions → masthead phase `setting_up`, never
  `finished`** (amendment 3, 2026-09-02). `competitionPhase` derives from the
  division phases, and an EMPTY set satisfies none of the `includes` tests, so
  it fell through to the `finished` default: a competition created seconds
  earlier rendered "Finished · 0 divisions" above its own "No divisions yet"
  empty state. Confirmed on a live prod build before the fix. Same vacuous
  truth as amendment 2 one level up — a derived phase whose rules are all
  "does the set contain X" needs an explicit empty case, because the empty set
  answers no to every question and lands on whatever the default is. Binding
  for W2/W3: any further aggregate phase (org, season) states its empty case
  first.
- Fixtures tab with no fixtures → the stage rail alone, steps showing what is
  missing; no run sheet header.
- Unknown `filter` param → treated as All.

## W1 sign-off — per-screen verdicts (2026-09-03, RE-DRIVEN)

RE-DRIVEN in fix round I. The previous table was driven at `6adb4d3b5`, which
is **not an ancestor of this branch** (a pre-rebase twin of `12c669518`), with
seven rendering commits since, and its needs-draw row recorded a masthead
reading "Setting up" that the product no longer produces. Anything driven at a
commit that is not an ancestor is a picture of a branch nobody is shipping.

Driven at `a8e30bdb8` — a real ancestor, and the build actually being served —
against the running production server at **12:40:02–12:41:28Z on 2026-09-03**,
five screens x three widths. All fifteen images exist and have **fifteen
DISTINCT sha256 hashes**; the capture harness in this repo has previously
errored before taking a single screenshot, and shared states have come out
pixel-identical because nothing opened, so "the images differ" is part of the
verdict, not an assumption. Every screen's masthead text, ledger row text and
Needs-you text were printed BESIDE its picture and are quoted below — a green
width gate cannot tell you it measured the wrong page STATE.

| Screen | 1280 | 768 | 320 | Verdict |
| --- | --- | --- | --- | --- |
| Empty competition (no divisions) | masthead "Setting up", empty state, no ledger rows | same | same | PASS — amendment 3; read "Finished · 0 divisions" before the fix |
| Setup-timing finals, bracket never generated (U16, 6 of 6 played, league complete) | masthead "Scheduled"; row red "Needs draw" over "6 of 6 played · Finals not drawn"; action "Compute proposal" | same | card: name + pill, bar, status line, one full-width "Compute proposal" — the card's only action | **FAIL — instance TWELVE, photographed.** The landing `?tab=fixtures` has no working compute door in this state (`computeSeedProposal` 422s until the TBD bracket exists). Fixed on this branch: the row becomes "Needs fixtures". Owes a re-drive after a rebuild. |
| Unseeded next stage, nothing generated (Cup, 6 of 6 played, league still active) | masthead "Scheduled"; row red "Needs fixtures" over "6 of 6 played"; action "Open fixtures" | same | card restacked, one full-width "Open fixtures" | PASS — the state the row above becomes on this branch. Needs-you reads "Cup · no fixtures yet in Finals / Seed it from the stage before, or generate its fixtures." and both named doors are on the landing page. |
| Scheduled, nothing dated (Premier, 1 of 6 played) | masthead "Scheduled"; row "Scheduled" / "1 of 6 played · 5 unscheduled" | same | same, restacked | PASS — read "Setting up" (round C) and before that "nothing scheduled" (F1) |
| Match day, one live and nobody recording (Premier) | masthead "1 in play"; row red "No scorer" / "0 of 6 played · 1 in play" / "Now: Seed1 v Seed4" | same | card omits the "Now:" line | PASS with two notes, below |

No horizontal scroll at any of the fifteen (`scrollWidth > clientWidth + 1`
measured at each width, false everywhere). Masthead and rows agree on every
screen. The row's control set at 320 versus 1280 — the "designed, not shrunk"
ruling, which a screenshot cannot express — is pinned in `e2e/mobile.spec.ts`
rather than here.

**Owed after the controller's next rebuild.** The server on :3365 was
`a8e30bdb8`'s bundle throughout, so three of this round's changes are not in
these pictures and their rows must be re-driven: the needs-draw screen (row 2,
which becomes "Needs fixtures"), the no-scorer action label ("Assign scorer" ->
"Open scoring"), and the registrations action's landing tab.
`e2e/competition-desk-actions.spec.ts` is red on exactly those three rows
against this bundle and green on the other four, which is the same evidence in
executable form.

Three OBSERVATIONS, recorded rather than fixed:

1. **The masthead still ignores attention while the rows honour it.** On the
   needs-draw and needs-fixtures screens the pill reads "Scheduled" directly
   above a row whose pill reads "Needs draw" / "Needs fixtures". Not a
   contradiction of fact — round G's K2 fix made the masthead stop saying
   "Setting up" over a played-out row — but the summary at the top of the page
   is still less informative than the row beneath it, and the ladder in this
   spec has no attention step. (This is the same recommendation the 2026-09-02
   table made; it is unactioned, not resolved. The word it prints has changed
   from "Setting up" to "Scheduled", which is why the old table read stale.)
2. **The phone drops the live match name.** At 320 the card omits the "Now:
   home v away" line the desktop row carries, so the width most likely to be
   held at the venue is the one that does not name the match in play.
3. **`needs_fixtures` does not name its stage in the status line.** The row
   reads "6 of 6 played" where its needs-draw sibling reads "6 of 6 played ·
   Finals not drawn"; the stage name is in the Needs-you row above but not on
   the ledger row itself. `StatusLineInput` carries only
   `needsDrawStageName`. A one-field symmetry question for W2, not a defect.

A fourth note, on the previous table: its row 4 was "Match day, one live
(**assigned scorer**)". That state cannot be built through the product at all —
`createAssignment` has no production caller and `scorer_assignments` is written
only by accepting a scoped invite, which no UI creates (fix round I, M2). It
is reachable by SQL alone, so the row has been re-driven in the state an
organiser can actually reach: live, and nobody recording.

## Out of scope

Scorepad skins and `fixture-console.tsx`; `/schedule` board and its toolbar
(#650); slideshow; entrants / standings / stats / discipline tabs' content;
registration hub; org dashboard; dark mode (no toggle exists — memory).

## Wave order and parallelism

W1 → W2 → W3, sequential: W2 imports the phase resolver and status line from W1;
W3 adds the band to W1's page and the phone layouts to W2's rows. Within a wave,
implementers are parallel only where file sets are disjoint (W1: resolver+usecase
vs. dictionaries+help; W2: run sheet vs. stage rail is NOT disjoint — both edit
`stages-panel.tsx` — so sequential or worktree isolation). Reviewer pass after
every implementer; gate rerun by the orchestrator with the JSON reporter and
`.testResults[].name` confirmed under the worktree path. Merge sign-off is
per-screen verdicts from screenshots, not "CI green".
