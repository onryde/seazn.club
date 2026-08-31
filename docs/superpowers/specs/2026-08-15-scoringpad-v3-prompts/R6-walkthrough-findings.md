# R6 — visual walkthrough findings (2026-08-31, orchestrator, by hand)

Driven against the prod-build server on `:3356`, rebuilt from this worktree
AFTER fix pass 4 (`seazn-env rebuild --label r6`, assets verified). Both
sports, real matches, real HTTP, widths 320 / 768 / 1280. Screens in
`<scratchpad>/r6-walk2/`.

**Method note:** the previous walkthrough's driver script was LOST — only its
65 PNGs and JSON survived, so nothing was repeatable. That is why W-1 below is
about the durable spec, and why this file exists rather than a chat summary.

---

## W-1 — **HIGH, and a REGRESSION introduced by fix pass 4.** The minutes
## stepper seeds the shortest class in the sport, so an FIH yellow is recorded
## as a 2-minute suspension against a declared 5.

**Proven end to end, in real recorded data**, not inferred. Driving a yellow
card through the pad on the hockey fixture wrote this row:

```
seq 4 | hockey.suspension.start |
  {"at": {"period":"Q1","elapsed":15}, "class":"yellow", "minutes": 2, "person": "..."}
```

`HOCKEY_SUSPENSIONS` (`period/suspensions.ts:73-77`) declares **yellow = 5**.
The engine honours the awarded value over the class nominal —
`kernel.ts:1185`, `expiryOf(..., payload.minutes ?? cls.minutes, ...)` — so
that row expires three minutes early, the side returns to full strength early,
and the `BACK ON` chip counts to the wrong moment.

**Why it is a regression and not a pre-existing gap.** Before fix pass 4 the
sheet did not collect `minutes` at all, so `payload.minutes` was `undefined`
and the engine fell through to `cls.minutes` = 5 — **correct**. Fix pass 4
made the field collectable and seeded it wrong, so the pad now overrides a
correct default with an incorrect one. Closing finding 4 turned a missing
field into an actively wrong recorded value.

**Ice hockey is worse.** Its classes are 2/2/4/5/10/5, so the seed is 2 for
every one of them. A **misconduct is declared 10** and seeds **2** — an 8-minute
error, one tap from the umpire's most likely action (accept the default).
Verified on screen at 320px.

**Root cause, and it is documented rather than accidental.**
`defaultMinutesOf` (`v3/skins/period-shared.ts:983-986`) returns
`Math.min(...finiteClassMinutes(view))`. Its own doc (`:977-982`) explains
why: `SheetNumberStep.initial` is `number`, fixed when the sheet is BUILT,
before any answer exists, so it cannot read `answers.class`. The seam, not the
skin, is the constraint.

**Recommendation (mine, as product owner — not an owner ruling).** Fix the
seam, do not paper over it in the skin. Widen
`SheetNumberStep.initial` (`v3/types.ts:653`) to
`number | ((answers: Record<string,string>) => number)` and resolve it in
`guided-sheet.tsx:548`, which already has `state.answers` in hand at exactly
the moment it seeds. Backward compatible: all 15 existing number steps across
6 skins pass literals and keep working; only `period-shared` changes
behaviour. Then seed from the chosen class's own declared `minutes`.

**The test that would have caught it, and why 12 mutants did not.** Every new
test asserted the field was *reachable* and that the payload *carried* it.
None asserted the seeded VALUE against the class the scorer picked. A
reachability sweep cannot see a wrong default — it is satisfied by any value.

## W-2 — MEDIUM. `suspensionMinutesMaxOf` claims a test that does not exist.

`period-shared.ts:992-993` states `__tests__/period-pair.test.ts` "pins this
against the real `module.padSpec(cfg)` field so the two cannot drift apart".
No such test exists — the symbol appears nowhere outside its own definition.
The pad's `Math.max(...finite) * 2 : 20` matches `kernel.ts`'s
`suspensionMinutesMax` only by inspection. Found by the branch reviewer,
confirmed by me. Fix by writing the claimed test, not by deleting the claim.

## W-3 — MEDIUM, product. The clock corrects in whole minutes only.

`CLOCK_NUDGE_SECONDS = 60` (`v3/clock.ts:221`) is the only step; the UI offers
`−1 min` / `+1 min`. Both codes are stop-clock sports and the correction a
match official actually needs is the whistle-to-restart drift — **5 to 20
seconds**. A minute-only control cannot express the common case: the umpire
either leaves the clock wrong or overshoots by 40 seconds.

Recommendation: add a ±10s pair beside the minute pair. The caption already
present — *"Only this pad's clock. Recorded times don't move."* — is honest
and well judged; keep it, and make it more prominent than 11px right-aligned
grey, because it is the single sentence that stops a scorer thinking they have
edited the record.

## W-4 — LOW, product. The attribution dock clears in 4 seconds.

After a card is recorded the pad asks *"Who was carded?"* over a chip row and
prints **"clears in 4s"**. Four seconds is short for picking one of eleven
names on a phone, and the cost of missing it is a permanently unattributed
card. Recommend either a longer window or no auto-dismiss — the dock is not
blocking anything, so there is little reason to take it away.

## W-5 — LOW, design. The clock sits outside the board.

The scorebug is the sport-themed dark board (hockey teal `#06323c`, ice hockey
navy `#040a22`) carrying `PERIOD` / `ON PITCH` / `BACK ON` as LED chips. The
clock — the most-watched number in both sports — renders below it as a white
page-coloured card. The sport theme stops at the board edge, and the one
element a spectator's eye goes to is the one that is not on the board.

Not a defect and not blocking; noted for the owner's design verdict.

---

## What the walkthrough CONFIRMED working

- **Change E proven through the real HTTP door**, which fix pass 4 could only
  prove at the usecase: with the org's subscription flipped to `community`, a
  hockey card POST to `/api/v1/fixtures/{id}/events` returned **201**, and the
  row is in `score_events`. Plan restored to `pro` afterwards.
- **No inert seam.** `MINUTES` and `SERVED BY` are both real, reachable steps
  in the shipped build; the values reach the database.
- **Fix pass 4 findings 1 and 2 are genuinely fixed on screen**: `−1 min` is
  live, and the clock corrects without bricking scoring.
- **The class picker reads in ascending severity** — `Green / Yellow / Red`,
  and ice hockey `Minor … Match penalty`. The old `Red, Green, Yellow` order
  is gone.
- **Bands still work as a UX control after change E**: the free org's sheet
  drops the `reason` and `servedBy` steps and the chip reads "Cards & key
  moments" instead of "Every detail" — fewer questions, not a locked feature.
- **No horizontal scroll at 320 / 768 / 1280** in any state captured.
- `ON PITCH` tracked 11v11 → 10v11 → 9v11 as cards landed; `BACK ON` counted
  2:00 → 1:54 with the clock running.
