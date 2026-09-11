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

---

# Round two — the FINAL branch review (2026-09-11, after the rebase)

Dispatched over `origin/main...HEAD` at 873efb725, 28 commits, the whole wave.
**Verdict: Needs fixes again.** Seven findings, every one confirmed here against
the code before being touched. One would have gone on air; one had a whole wave
task resting on a harness CI never runs.

That a branch which had already had a per-task review, a first full review, a
green gate and an owner-accepted set of screenshots still carried this is the
third instance in this wave of AGENTS.md class 8.

## F2-1 — the bar's height is NOT a constant, and §5's arithmetic froze it · MAJOR

`.ovl-moment-slot--bar { bottom: 231px }` was derived from a bar of 177 —
`.ovl-bar-main` 126 plus `.ovl-detail-band` 51. But §3 rules that "an empty
detail band is not rendered", and `overlay-bar.tsx` renders it only when
`model.detail.length > 0 || chase || result`. A football fixture before its
first card, a cricket fixture before its first ball, and any fixture at
`no_result` therefore has a **126 px** bar whose top edge is at y=900 — while
the slab's underside stayed pinned at y=849. **A 51 px gap, with the
deliberately-square bottom corners exposed**, which is the exact inverse of the
owner's "tucked behind" ruling.

`--bug` is immune: it anchors off a fixed 48 px header, which is why
`slabPlacementFor` and its tests cannot see the asymmetry.

**The error was in `_THEMES` §5, written in this wave to record the owner's
placement ruling** — it stated 177 flat. The document has been corrected to give
both heights, and the fix removes the duplicated fact rather than patching the
number: `hasDetailBand(model)` (`lib/overlay-model.ts`) is one authority read by
the bar's own render AND by the stage's `data-band`, and the stylesheet derives
both offsets from `--ovl-bar-main-h` / `--ovl-bar-band-h` / `--ovl-bar-bottom`.
`overlay-slab-placement.test.tsx` asserts the two readers agree **in the same
render** — the biconditional, because either one alone is satisfied by a
constant. Deleting `data-band` kills two of its five assertions (run, not
asserted).

**W2's own `football-bar-penalty` capture was shot on this defect**, and signed
off by me as correct.

## F2-2 — a GREEN capture of a STALE bundle · the gate's third vacuous mode

Confirming the fix, the harness passed 4/4 and the picture still showed the
51 px gap. `seazn-env rebuild` reused Turbopack's FS cache: the built chunk
still carried `bottom:231px` while `globals.css` on disk had the variables, and
the content-hashed filename never changed. `seazn-env up --server` then warned
it was "serving whatever was built when it started" and did **not** restart.

Only `rm -rf .next` + `turbo run build --force` + an explicit `kill` of the
server pid put the fix on the wire. Measured after: slot `bottom` 180px,
`--ovl-bar-main-h` 126px, slab bottom 900, bar top 900 — flush.

**A capture asserts the DOM state it photographs. It cannot assert that the CSS
it photographed is the CSS in the repo.** This wave has now seen three ways for
a visual gate to pass on nothing: a harness that errors before shooting, a
motion frame read as a layout bug, and a green shot of a stale bundle.

## F2-3 — a tick BELOW the deadline froze the queue · minor, live

R-2 gave the reducer a `revision` for an EQUAL deadline. A tick that lands
*below* one still returned `state` itself, so `useReducer` bailed out, nothing
re-rendered, no timer was armed — and the timer that produced the tick is
already spent. Slab frozen until an unrelated moment arrives. Reachable when the
wall clock steps backwards between arming and firing (an NTP correction on a
machine that has been running OBS for hours). Now bumps the revision; the
re-arm cannot loop, because the effect schedules `max(0, deadline - now)`, which
is positive exactly while that branch is taken.

The existing test asserted a tick no-op must NOT churn the revision, which is
the defect stated as a requirement. It now asserts the ENQUEUE no-op only, and
says why the two differ: an enqueue that changes nothing leaves its armed timer
pending; a tick means the timer is spent. Both look like "nothing happened".

## F2-4 — the mount assertion had no teeth · minor

`toHaveCount(0)` immediately after `goto` resolves before hydration can mount
anything, and three replayed suspensions would be gone inside the follow-up's
30 s window — so the test passed with `momentBaseline` deleted. It now samples
every 250 ms across three full cycles: a 4.5 s slab cannot hide between samples.
Its budget moved with it, derived from the same constant.

## F2-5 — four queries per cricket poll, under a comment claiming one · minor

`loadRecentPersonOf` issues TWO queries (the division's display policy, then the
line-ups) and was called once from `recentOrEmpty` and again from
`cricketLiveOrNull`, reading the same line-up twice per poll per viewer — while
the comment above it said "one query for at most three names". Same class as
R-3, and invisible to every test because nothing about the OUTPUT was wrong.
Now one `overlayPersonOf` over the union of both id sets, degrading on its own:
an unreadable line-up costs the overlay its NAMES, never its moments.

## F2-6 — `DerivedReplay.complete` has no production reader · minor

`load.ts` destructures `{ bySeq }`. The doc read as though the field were the
production signal; the `log.warn` is. Doc corrected rather than a reader
invented — the field earns its place holding the tests.

## F2-7 — Task 3 had NO automated gate · minor, and the most surprising

`cricketLive` was proven end-to-end only by `overlay-moments.capture.ts`, which
is `test.skip` without `GALLERY_DIR` and whose `gallery` project appears in no
workflow. `stream-overlay.spec.ts` had no cricket case and `scripts/smoke.ts`
checks `recent[]` against the hockey rig alone. **A whole wave task rested on a
harness CI never runs.** Closed with a cricket describe in the spec that does:
the band's figures, the bowler's analysis as a SHAPE, and a name reaching air.

One correction made to that new test before it shipped: it first asserted the
crease names are MASKED. They are not — this rig's division sets no youth flag
and no display policy, so the consent resolver's correct answer is the full
name, and asserting initials would have pinned a policy the fixture does not
have.

## Found by DRIVING the product, not by the review — raised, not built

**The bar does not cap entrant names, and §1's ladder was never built.** §1
rules: "Team names never wrap and never truncate… a name longer than the cell
can hold at 45 px falls to the entrant's short name, then to the three-letter
code." `overlay-bar.tsx:54` renders `side.name` unconditionally; `side.short` is
computed and used only as a React key and by the bug. `.ovl-team-name` is
`white-space: nowrap` with no overflow handling, and the team cells are
`overflow-x: visible`, so a long name simply paints over its neighbours.

Measured on a live fixture at 1920×1080, 38-character names:

| box | left | right | note |
|---|---|---|---|
| home cell | 297 | 1063 | `scrollWidth` **940** vs `clientWidth` 766 |
| home score | **1046** | 1156 | paints inside the AWAY cell |
| away name | 1105 | **1781** | paints over the brand mark |
| away cell | 1063 | 1708 | |

Threshold ≈ **34 characters** at 45 px (23.2 px/char, measured). W1's surface,
not W2's, and §1 forbids an ellipsis — so the fix is the measuring ladder, which
is a real piece of work and an owner's call on where it lands. Recorded here
with the numbers so it is not re-derived.
