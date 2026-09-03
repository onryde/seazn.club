# Competition desk — programme index

Decision log and session status. Read `_RULES.md` beside this file first.

- **Design of record:** `../2026-09-02-competition-desk-design.md`
- **W1 plan:** `../../plans/2026-09-02-competition-desk-w1.md`
- **Waves:** W1 competition page (in flight) · W2 fixtures tab as a run sheet ·
  W3 phone layouts and the in-play band

## Status

| Wave | Scope | State |
| --- | --- | --- |
| W1 | Competition page: derived phase, Needs you, division ledger, tip gating, stage order | In flight — fix round A after a Needs-fixes final review |
| W2 | Fixtures tab as a run sheet (`stages-panel.tsx`), desktop two-column | In flight |
| W3 | Two-line run-sheet rows, bottom-sheet stage rail, in-play band | Not started |

## Owner rulings

Rulings BY THE OWNER. Anything below this line came from the owner directly;
recommendations I made are recorded in the next section and are **not**
interchangeable with these. Never carry either to a peer session as the other.

1. **The surface is the DIVISION page's fixtures tab** (`?tab=fixtures`,
   `components/v2/stages-panel.tsx`), NOT `components/v2/fixture-console.tsx`.
   "Fixture Console" in owner vocabulary means the former. The component of
   that name belongs to the R7 programme.
2. **One surface serves both modes** — pre-event planning and live match day.
3. **Sport icon on division rows only**, never the competition masthead
   (reasoning in `_RULES.md`).
4. **Mobile is designed, not shrunk** — given verbally in this wave, later
   repo-wide policy (`1a0c948b9`).
5. **Cosmetic alignment defects are defects, not polish.** The premise of the
   desk is that it reads truthfully at a glance; an unaligned row with
   duplicated numbers defeats that.
6. **W2 and W3 stay split exactly as the spec writes them** (2026-09-02). I
   recommended folding W3's run-sheet mobile composition into W2 so the run
   sheet is designed at both widths once rather than built at desktop and
   reflowed later; the owner declined. Do not re-open this.
7. **W2 is desktop-only.** The W2/W3 split holds (re-affirming ruling 6). The
   run sheet's phone composition — two-line rows, the rail as a bottom sheet —
   stays in W3. W2 must still pass the seven-width gate with no horizontal
   scroll; it simply will not be *designed* below `lg` until W3.
8. **A2 — bracket stages keep their round sections.** Every other stage kind
   is day-grouped. The owner accepted the stated cost ("two organising
   principles visible in one tab on mixed divisions") in exchange for
   knockout comprehension on a finals day.
9. **Sheet skeleton — day groups are MERGED across all non-bracket stages**
   into one division-wide day spine (a Saturday shows every
   league/americano/ladder fixture under one header), each bracket stage is
   its own round-sectioned block, and ONE division-wide "Not yet scheduled"
   group closes the sheet.
10. **B1 — the auto-schedule CTA and its capacity-blocked reason live on the
    stage rail.** The sheet's unscheduled group is display-only with a
    "Set time" per row.
11. **All stage chrome moves to the rail** — Add match, Generate/Pair next,
    Complete stage, Delete stage, Required court tags, auto-schedule and
    Compute proposal. The left column becomes purely the sheet. This closes
    current-state finding 6 ("actions in six places").

## Decisions made by this plan, not the owner (W2)

Distinguished from the section above because these are NOT owner directives —
they are calls this wave's plan made itself. Never carry either section to a
peer session as the other (same rule as the Owner rulings heading states).

- **Block order is chronological.** Day groups and bracket blocks alike are
  ordered by their earliest scheduled instant, unscheduled always last.
  Flagged for the W2 walkthrough — cheap to reverse to "brackets first, in
  stage seq order" if the owner reads it differently.
- **`page.clock` is not used.** `grep -a -rn "page.clock" apps/web/e2e`
  returns zero hits — it would be a new technique in this repo, and it
  interacts badly with a server-rendered `now`. The NOW rule is instead
  driven by seeding fixture times relative to `Date.now()` through the
  existing `setFixtureScheduledAtSql`.

## Spec amendments (binding, in the design doc)

1. Sport icon on division rows, none on the competition masthead.
2. **Rule order: `setting_up` before `finished`.** With zero stages and zero
   fixtures, `everyStageComplete || (noOpenStage && noLiveFixture)` is TRUE, so
   the first division an organiser created read "Finished" before it began.
3. **An aggregate phase states its empty case first.** `competitionPhase`
   derived from the division phases, and an empty set satisfied none of its
   `includes` tests, so a competition created seconds earlier rendered
   "Finished · 0 divisions" above its own "No divisions yet" empty state.
   Confirmed on a live prod build before the fix.
4. **The run sheet buckets and prints in the VENUE zone**
   (`scheduleSettings.tz`), not the org zone. W1's H1 fix (final review round
   3, Critical) had already corrected the division page — its `resolvePhase`
   call passes `tz: scheduleSettings.tz` with the comment "this used to be
   the bare org zone … the same bucket-vs-print split competition-desk.ts
   had, one level up" — but §W2 still carried the retired wording. One zone
   per fixture, for both bucketing and printing; the org zone is a fallback,
   never a second authority.

## False premises found (my own, unless noted)

Recorded because each was believed, acted on, and wrong.

- **The wrong surface was scouted first** — `fixture-console.tsx` instead of
  the division fixtures tab. Cost a full scout pass. See owner ruling 1.
- **`DEFAULT_MATCH_MINUTES = 60`** contradicted the codebase's 30 (zod default,
  `schemas.ts:1266`). Ruling: DERIVE such constants from the schema, never
  retype them, so they cannot drift from the source of truth again.
- **My V2/V3 fix instruction was wrong.** I said "un-hide the pill, stop
  truncating", which preserves the desktop DNA at 320. The owner caught it:
  that is shrinking, not designing. Superseded by the mobile card composition.
- **`fixtures.status` has no `live` value** — it is `in_play`.
- **Three vacuous-truth phase defects**, all three shipped past green suites
  and were found by looking at a screen. See `_RULES.md`.

### W2 (found while planning, 2026-09-03)

Every one of these was in the spec, believed, and checked against the tree
on 2026-09-03.

- **The masthead line pin was stale.** Spec cited `page.tsx:298-378`; the
  masthead is actually at `:389-396`.
- **The `DocumentsMenu` line pin was stale.** Spec cited
  `stages-panel.tsx:755`; it is actually at `:774`.
- **Bracket/americano/ladder panels are not nested inside the tab "for their
  stage."** They are **sibling mounts** on the page (`page.tsx:549`, `:564`,
  `:571`), never nested in `StagesPanel` — they render above the whole sheet
  in stage order, not interleaved per stage.
- **"Re-anchor the nine existing specs on `data-fixture-no`" undercounted the
  specs and presupposed attributes that don't exist.** **11** specs touch
  `?tab=fixtures`, and neither `data-fixture-no` nor `data-run-sheet-day`
  exists anywhere in `apps/web` — W2 *introduces* both. Only two testids
  actually die with the round bars: `round-dates` and `stage-auto-schedule*`.
- **Rail steps do not come from `card-stats`.** The spec's "same numbers the
  status line uses (`card-stats`)" is wrong: `listDivisionCardStats`
  (`card-stats.ts:158`) is competition-scoped and per-division, while the
  rail's steps are per-stage. The per-stage counts get ONE derivation,
  `stageProgress`, shared by every consumer — hand-copying it is the exact
  K3/M1 defect W1 paid for twice.
- **A bucketing helper already exists and is already imported (unstated in
  the spec).** `dayKeyInTz` already exists
  (`packages/engine/src/scheduling/tz.ts:72`) and `stages-panel.tsx:54`
  already imports it. The builder reuses it; a second bucketing helper would
  be a defect.

## Review lessons (W1)

- A task review returned **Approved** with all three product mutations killing
  tests, live e2e green, and nine screenshots opened — and still missed both
  the Critical and three unreachable assertions. The final whole-branch review
  found them by driving the product. **Run the final review even when every
  task review is clean.**
- The two reviews contradicted each other on assertion quality; the final one
  was right. Checking that an assertion is well-formed is not checking that it
  is reachable.
- A subagent that BACKGROUNDS a build ends its own turn, losing uncommitted
  work. Environment work (build, serve) is the controller's for the whole wave.

## Environment (label `fxc`)

`seazn-env up --label fxc` in a worktree, never the main checkout. The server
port MOVES on every rebuild — re-`eval` the env script rather than reusing a
remembered port. Without an exported `DATABASE_URL` vitest refuses to start
because it detects `.env.local`'s dev DB; that refusal is the guard working.
A source edit does not reach the running server until a rebuild, so a copy
assertion run against a stale bundle fails for a reason unrelated to the test.
