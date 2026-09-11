# W2 — reviewer pass over the branch diff

**Scope.** `10c7f94cd..feat/stream-w2-moments`, the whole diff since the W1
merge base: 52 files, +6456 / −845. Dispatched at the end of Task 6 as the
plan requires, *after* every per-task review had already come back clean and
after the branch was green on units, e2e, smoke and the committed visual gate.

**Verdict: Needs fixes.** Three findings would have gone to air. Two more were
smaller. Every one was re-confirmed against the code here before being fixed —
none was taken on the reviewer's word — and all five are fixed in `cbba5f28c`.

That a clean-per-task, fully green branch still carried three live defects is
the point of AGENTS.md class 12 ("never skip the review loop") and class 8
("green and pushed is not done"), and this wave is now a second instance of
both.

---

## R-1 — the clip window was not flush with the slab · CONFIRMED · fixed

`.ovl-moment-slot--bar` clipped at `x = 0` while `.ovl-slab--bar` sat at
`left: 72px`. The entry and exit animations translate the slab by `-100%` of
its OWN width, so a 185px-wide slab moved to `-185px` — leaving its rightmost
**72px inside the clip window**: a solid 72 × 216 block of `--sport-led` parked
against the canvas edge, through both fold phases, twice per moment, on
cricket's default theme.

The `--bug` placement already carried its inset on the SLOT. Only `--bar` split
it across the two, and nothing in the type system can see the difference.
Fixed by moving the inset to the slot (`.ovl-moment-slot--bar { left: 72px }`,
`.ovl-slab--bar { left: 0 }`), matching `--bug`.

**Why five screenshots and a passing visual gate missed it:** every capture
measured the slab SETTLED. The defect exists only during the 250 ms in and the
250 ms out. This was arithmetic available to me without a browser at all — slot
origin vs slab origin vs translate basis — and I did not do it.

## R-2 — the moment queue froze permanently under reduced motion · CONFIRMED · fixed

With `prefers-reduced-motion`, `foldMs` is 0. The `out → promote` transition
computes its next deadline as `now + foldMs` — i.e. `now`. Whenever a tick
lands exactly on the deadline that just fired, the new deadline **equals the
old one**. The hook's effect keys on `deadline`, sees no change, and arms no
timer; `enqueue` never touches `deadline` while `current` is set. The slab
freezes mid-fold and **no further moment airs for the rest of the match**.

Fixed with a monotonic `revision` on `MomentQueueState`, bumped on every state
change and included in the hook's effect deps. Tested against the
repeated-deadline case specifically, not merely against reduced motion.

This is a reduced-motion-ONLY failure, which is why no capture and no e2e run
reached it: both run with motion enabled.

## R-3 — the cricket band bypassed its own cache · CONFIRMED · fixed

`cricketLiveOrNull` re-ran `loadFoldInputs` *and* a full
`deriveCricketScorecard` on **every poll for every viewer** — directly
contradicting the comment sitting above it, and making `load.ts`'s stated
promise ("N polls at one ledger position cost one fold") false for exactly the
sport whose derivation is the most expensive.

Fixed by moving the scorecard inside the cached pass
(`overlayCricketLiveIds` / `cricketPersonIdsIn`), leaving only the name lookup
— at most three people — outside it, which is what the comment always claimed.

A correctness-invisible finding: no test could have caught it, because nothing
about the OUTPUT was wrong. It was found by reading the file against its own
comment. Cross-reference the standing rule that a comment is a hypothesis —
here the comment was right and the code had drifted out from under it.

## R-4 — the fold easings were inverted against `_THEMES` §6 · CONFIRMED · fixed

§6 specifies ease-out on arrival and ease-in on exit. The implementation used
CSS transitions with one shared easing, and the `in` phase painted nothing
while the slide consumed 250 ms **of** the 4000 ms hold rather than preceding
it. Replaced with keyframes — `ovl-slab-in` (250 ease-out), 4000 still,
`ovl-slab-out` (250 ease-in) — so the hold is a full four seconds as specified.

## R-5 — an unknown dismissal kind left a trailing separator · CONFIRMED · fixed

`kind ?? ""` in the wicket line rendered `"R. Player 41 (28) · "` for a
dismissal mode the `WICKET_KEYS` table does not yet name — which is precisely
the case the surrounding fallback exists to survive gracefully. Now the full
line is emitted only when BOTH halves exist. Two tests added.

Also corrected in the same pass, not a defect: `RecentEvent.side`'s doc claimed
"the side the event credits". On an own goal `by` is the side whose player
STRUCK it and the goal counts for the opponent (`football.ts:213`,
`period/kernel.ts:224`). The comment is corrected rather than the value —
nothing captions a side from it, and the raw fact is what a consumer wants.

---

## Raised to the owner, and since ruled

**A penalty goal never showed the scorer's name.** The first build read
`payload.penalty` as a REPLACEMENT for the name, putting the bare word
"Penalty" on the line. That was the brief's own spec, so the reviewer pass
recorded it rather than changing it — but it made the one goal a crowd most
wants a name against the only goal that never carried one.

**Owner ruling, 2026-09-11: show both.** The line is now
`overlay.moment.penaltyLine` — `"{name} · Penalty"` — in all four locales, with
the two single-fact forms surviving as fallbacks for the halves that can
genuinely be missing: a scorer the visibility rules masked away, or a penalty
the pad recorded with no person (`scorer` is optional in
`FOOTBALL_EVENT_SCHEMAS`). Pinned as a VALUE in the test, because the bare
`overlay.moment.penalty` also "mentions a penalty" and would satisfy a weaker
assertion while dropping the name — which was the defect.

### Found while fixing it, recorded rather than built

**The penalty line can only ever fire for FOOTBALL.** `PeriodGoal`
(`sports/period/kernel.ts:223`) is a `z.strictObject` with no `penalty` field at
all — hockey and ice hockey express a penalty stroke or a penalty corner through
`kind`, validated against `cfg.goalKinds` (`hockey.ts:132`:
`["fg", "pc", "stroke", "og"]`), and the moment rules do not read `kind`. So a
hockey stroke goal puts the scorer's name on the line and says nothing about
where it came from.

That is not a defect against the brief, which says nothing about goal kinds. It
is a narrow asymmetry worth an owner's eye before R2: the same broadcast moment
is annotated for one sport and not for the other two that have it. Cost if
wanted: one entry mapping `kind` → a dictionary key, in the same shape as
`WICKET_KEYS`.

---

## Gate after the fixes

| | |
|---|---|
| Web unit, touched surfaces | 2993 green |
| Engine, run alone | 4362 / 0 |
| `stream-overlay.spec.ts` | 19 / 19, whole file, no `-g` slice |
| `mobile.spec.ts` | 298 / 298, seven widths |
| Smoke, clean environment | **1034 / 0**, twelve overlay checks |
| Visual gate | 3 scenes re-shot, every assertion |
| tsc · lint · i18n · openapi | clean · 0 errors · 4-locale parity · no drift |

The one smoke failure seen before this was on a dirty database — the teardown's
audit-chain check, whose own comment names the cause (a parallel e2e run
writing after the smoke rows). Re-run on a clean environment it is 1034 / 0.
Recorded so the next session does not chase it.
