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

## W2 session handoff — 2026-09-04

Branch `feat/competition-desk-w2-run-sheet`, worktree
`.claude/worktrees/desk-w2`, env label `deskw2`. Working tree CLEAN; every commit
is a new commit — no amends, no rebases, no history rewrites.

**Full ledger, rulings and resume block:**
`.superpowers/sdd/2026-09-03-competition-desk-w2/progress.md` (git-ignored, in
this worktree). It ends with a `RESUME STATE` block — trust that and `git log`
over any recollection. Briefs, supplements, reports and review packages sit
beside it. `STANDING-POLICY.md` there is the owner's standing policy quoted
verbatim; every dispatch points at it rather than paraphrasing, because a brief
that CITES a ruling is not a brief that QUOTES it.

**Status.** Tasks 1-3 complete and reviewed. Task 4 (the run sheet renders) has
been through five fix rounds — the process cap — with its final re-review
outstanding. Tasks 5-10 not started; Task 5's supplement is written and waiting.

**What Task 4 cost, recorded because it is this wave's main lesson.** Four review
rounds, ~6,500 green unit tests, a 949-check smoke suite and a seven-width mobile
sweep did not notice that the run sheet's "When" field was **0 pixels wide at
every width**, with the time picker's centre hit-testing to the Save button. A
reviewer found it by opening the page. Every gate was structurally blind:
`.fill()` and `.selectOption()` work perfectly on a zero-width control. Two more
defects were found the same way — a blank match-day screen when the default
filter matched nothing, and a "vs" separator failing AA contrast.

**Owner rulings taken during W2** (theirs, not recommendations): W2 is
desktop-only and the W2/W3 split holds · A2, bracket stages keep round sections ·
day groups merge across non-bracket stages, each bracket stage is its own block,
one unscheduled group closes the sheet · B1, the auto-schedule CTA lives on the
stage rail · all stage chrome moves to the rail · the set-time write resolves in
`orgTz`, obeying #448, accepting that a `tz`-overriding division redisplays a
typed 15:00 as 17:00 · "correct a time already set" is a REGRESSION and was
restored.

**Two decisions that are the CONTROLLER'S, not the owner's, both flagged for the
walkthrough and cheaply reversible:** block order is chronological (day groups
and bracket blocks interleaved by earliest instant); and settled fixtures with no
recorded time get their own terminal block rather than joining "Not yet
scheduled".

**Open items carried forward.** Nine orphaned `schedule.*` dictionary keys —
delete by EXACT key, never by prefix, because `schedule.unscheduled.*` and
`schedule.fstatus.*` are live neighbours · `RunSheetRow` renders raw server error
messages (`err.message`) rather than branching on `err.code`; inherited, not
introduced, assigned to the copy/e2e sweep · the peer wave
`feat/scheduling-walkthrough` owes a `SCHEDULE_LOCKED` code and dictionary key to
point that branch at · the dictionary merge with that wave is a CERTAIN four-hunk
conflict, one per locale, all the same trailing-comma shape — anything beyond
those four is a real conflict and must be read. `i18n-keys.ts` is
regenerate-do-not-merge.

### Correction to the handoff above (2026-09-04, measured)

The paragraph above calls the dictionary collision with
`feat/scheduling-walkthrough` "a CERTAIN four-hunk conflict, one per locale". That
was a PREDICTION stated as a measurement, and it is wrong. Corrected in place
rather than deleted, per this programme's convention, because the wrong version is
what a later session would otherwise re-derive.

Measured: **three** hunks per locale, twelve total — a 1-line hunk near `:96`, a
2-line hunk near `:3333` (`board.ai.joint.undoneWhy` / `.undoneReason`), and a
tail hunk near `:4940` (+33/-1). Only the TAIL hunk is certain to collide; the
other two collide only if both waves' inserts land near the same anchors, which
cannot be known until W2 is pushed. The `-1` is still not a deleted key —
`reg.hub.registrants.table.soloAssigned` gains a trailing comma, and both waves
produce that churn independently, so it reads as delete-and-re-add on both sides
when nothing was deleted.

**W2 merges clean against `origin/main`**: `git merge-tree --write-tree
origin/main HEAD` after an explicit fetch reports zero conflicts, with
`origin/main` 84 commits ahead of this branch's point. That command checks
mergeability without touching the working tree or index, so it is safe to run
mid-wave with agents live — worth knowing generally.

### W2 status update — 2026-09-05, second handoff

Supersedes the status paragraph above. 29 commits, zero amends, tree clean.

**All 15 max-review findings are RESOLVED** — 14 closed, 1 parked as latent (the
verbatim `@container` copy in `registration-hub-config-panel.tsx`, whose four call
sites are currently safe). Separately, the run-sheet editor no longer renders raw
server errors: it branches on `ApiV1Error.code` and falls back to translated copy,
so an organiser who double-books a court reads their own language instead of
`"schedule change hits a blocking conflict"`.

**Task 4 is functionally complete and still NOT signed off.** The walkthrough gate
is the last thing between it and a completion line, and it deliberately has none
until that returns.

**Three defects in this wave were introduced by the wave itself** and found only
by driving the product or by mutation — a 0-pixel-wide "When" field whose tap
point resolved to the Save button, a blank match-day screen when the default
filter matched nothing, and a commit of the controller's own that was INERT (a
pure rename) while its message asserted the behaviour in the past tense. None was
visible to ~6,500 green unit tests, a 949-check smoke suite, or a seven-width
mobile sweep.

**Owed next, in order:** rebase onto `origin/main` for PR #716 — **re-measure
first**, the recorded zero-conflict `merge-tree` reading is stale by 130+ commits —
then repair the commit shas that rebase invalidates in the ledger, in this file,
and in the max review's provenance section, which pins the exact HEAD it reviewed
and states it was unchanged throughout. Then Tasks 5-10.

**Task 5's supplement carries a correction that overturns a controller ruling:**
the "Now playing" strip must NOT be retired as duplication. It is the only surface
that floats a live BRACKET fixture or a live UNTIMED fixture, neither of which
reaches the run sheet's day spine. Retiring it would hide a live match on finals
day.

## W2 walkthrough gate 1 — findings DEFERRED to the next wave (owner ruling 2026-09-05)

Owner was shown F2 and F3 with the explicit note that **CI goes green with both
of them in**, and ruled: **merge W2 now, fix next wave.** That is the owner's
call, recorded here so the next session does not re-open it as an oversight.
Full evidence, screenshots and per-screen verdicts:
`.superpowers/sdd/2026-09-03-competition-desk-w2/walkthrough-gate-1-report.md`
(the SDD workspace is gitignored — copy anything you need before it is cleaned).

**None of these are visible to CI.** Every one is a rendering or hit-test defect
with correct underlying row data. A green suite is not evidence against any of
them (AGENTS.md class 15).

### F2 — HIGH. Bracket round headers are one round too advanced.

`lib/run-sheet-groups.ts`: `buildRunSheet` routes an untimed fixture to the
unscheduled pile on `OPEN.has(status)` **before** it tests whether the stage is a
bracket. A cup's untimed QFs and its untimed final therefore leave the bracket
block. `RunSheet` then calls `bracketRoundLabel(msg, kind, r.round,
allStageFixtures)` with `allStageFixtures = block.rounds.flatMap(r => r.fixtures)`
— only the SURVIVING rows — so `laneRoundRank` (`lib/round-role-label.ts`)
computes `lastRoundInLane` from a truncated lane and every header shifts up one.

Observed: a 3-round Cup printed `Cup — Final · Sat, Sep 26` over its **two**
semi-finals, while the real final sat anonymous 15 rows down in the flat
unscheduled list. The R34 round-date span rides the same wrong header, so the tab
asserts the wrong DATE for the final too.

Fix direction: decide bracket membership before the untimed routing, and pass
the stage's FULL fixture list to `bracketRoundLabel`, never the block's surviving
subset. A label derived from a filtered list is the bug — the derivation must see
the whole lane.

Test that would have caught it: seed a bracket stage with more rounds than have
times, and assert the header VALUE (not its presence) against the stage's own
round count. Reachability assertions pass on this defect (class 19).

### F3 — HIGH. The unscheduled and settled groups drop the stage name.

Bracket blocks carry their stage; day blocks carry a date; the unscheduled and
settled groups carry neither — and they are the two that merge every stage. With
20 of 31 rows in the unscheduled queue, `Round 1 · Bravo vs Echo` appeared twice,
two rows apart, one live and one never scheduled, with nothing on screen
resolving them.

Fix: `RunSheet` already holds `stageById` and the row meta line is already
`{court · } Round {n}` — pass `stageName` through and render it in those two
blocks. Counter-argument worth honouring: show it only when the division has more
than one stage, which the panel already knows, so single-stage divisions gain no
noise.

### F4 — MEDIUM by label, FUNCTIONAL in effect. Cheapest high-value fix here.

`nav.tsx:96` is `sticky top-0 z-20` over an `h-14` (56px) bar; `run-sheet.tsx:180`
and `:231` are `sticky top-0 z-10`. Same offset, lower stacking order. Measured by
hit-test, not by box: with the day header at viewport top, all four filter chips
report `hitsSelf: false` and resolve to `img.h-7.w-auto` — **the chips cannot be
clicked** at a scroll position an organiser reaches naturally, and the sticky day
header is never visible while it is doing its job.

Looks like `top-0` → `top-14` at two call sites. **Deliberately NOT done in W2**:
it is a visual change across seven width projects, `apps/web` vitest is
`environment: "node"` and blind to it, and this repo's class-22 failures are
precisely "obvious CSS fix reddens five width projects". It needs the width
matrix, which is why it did not ride a merge-day commit.

### F1 — CRITICAL, but NOT this programme's. See ledger R39.

Generated byes store `outcome` double-encoded (`JSON.stringify` into a jsonb
column at `server/usecases/stages.ts:1293`), so `o?.kind` is `undefined` on every
generated bye and all three R7 bye rulings are **inert in production**. Verified:
no reader anywhere `JSON.parse`s the column and all six readers assume an object,
so the WRITE is the single wrong thing. Blast radius includes public surfaces —
`public-site/bracket.tsx:73` and `schedule.tsx:90` leave the advancing entrant
unmarked on the PUBLIC bracket. Needs a one-line write fix plus a migration over
existing rows. **Owner decision still open: own wave, or ride W3.**

### F5 / F6 / F7 — see the report.

F5 (MEDIUM): a row can read "Awaiting draw" and offer "Score" simultaneously.
F6: R7(c)'s "accepted information loss" describes a state the walkthrough could
not produce through the product — the ruling may be defending nothing.
F7 (LOW/MED): 12-hour clock times rendered into a 56px cell.

### Standing warning for whoever picks these up

Every W2 bye test hand-builds `outcome: { kind: "award", … }` — the object shape
the product does not produce. The bye suite is green and has never once executed
against a real bye. Do not read that green as coverage.

### F8 — MEDIUM. `ClientTime` renders the BROWSER locale, so fr/es/nl show 12-hour "PM".

Driven in all four locales. This is a re-occurrence of the exact defect the day
header beside it was already fixed for — the fix was applied to one of the two
time renderers on the same row. When you fix it, fix it as ONE authority for
"how this product prints a clock", or the third renderer repeats it.

### F9 — MEDIUM. The time label wraps to two lines on EVERY row, at EVERY width.

Measured with `Range.getClientRects()` returning two rects per label — not with a
box or a clipping scan, both of which are structurally blind to a wrap (the box
is the wrapped height; nothing overflows). The 56px time column costs 17.5% of a
320px viewport to print a value that wraps anyway. Any fix is a column-width or
format change, so it needs the seven-width matrix.

### Recorded for W3 — the 320 observation, uncontaminated

Driven in a fresh context per width, as required. 320 is a **groomed shrink**:
control set byte-identical to 1280 and 768 (71 controls, `diff` empty), no
horizontal scroll open or closed, every control hit-tests to itself, rows reflow
to three lines with the action as a ~100px pill on its own line, a 43-character
name ellipsises at 186px. Sheet height 3,805px (6.7 screens) versus 2,271px at
1280. This is EXPECTED — W2 is desktop-only by owner ruling and W3 owns the
phone composition — so it is recorded as W3's starting observation, not as a W2
failure. Note the equal control set is the shrink signature the standing policy
warns about; W3's job is to make it differ.

### Two judgement calls the gate answered

**Block order — keep chronological.** Days-first read correctly; brackets-last
would push a single-day cup below the league. But the bracket's SORT KEY is
wrong: it sorts by earliest TIMED fixture computed over a subset, so a block
moves as you schedule it. Fix F2 first — the key change may be a no-op afterwards.

**Settled terminal block — keep it, RETITLE it.** It does not read as a second
unscheduled pile (rows carry results and a `Result` action, never `Set time`).
But "Played, not scheduled" is false for the cancelled/abandoned/forfeited rows
it exists to hold; a cancelled one was photographed under that heading.
