# W9 — operational [O] (lane)

**Goal.** When this wave is done the things that go wrong on the day — a court
lost, a day postponed, a player on two courts at once, a late (not absent)
player, a phone that dies mid-match, two scorers on one match, an offline sync
arriving out of order, a stale sheet scanned after a move — each have a
handled path, and the schedule never books one court twice across
competitions. An organiser can run the day without phoning support.

## Read first

- `_RULES.md` (R2, R5, R12, R13, R20, R24) and `_INDEX.md` (ruling 5 — [O] items
  are this separate wave, not the scenario axis; ruling 1 folds in #880).
- Design §4 (the [O] list at its end; "cases that need times"), §6.4, §8 (W9
  row and the lanes paragraph), §10, §11 (O6).
- Audits: `audit-2026-09-27/bench-reuse.md` §3–§4 (disruption scenarios and
  bench findings on `main`), `SW-swiss.md` (M13), `SH-sheets.md` (G12, G18),
  `plan-facts-repo.md` §5 (`bench.yml` placement-service setup).
- Issue #880 (parked follow-ups: Shift day seq race, undo watermark, held
  marker, AA contrast, flakes) and the device-link programme memory.

## Prerequisites

A parallel lane (R2). **Before starting, list this lane's file set and prove it
disjoint from the wave in flight**, and record the proof in `_INDEX.md`.
Known collision risk: `apps/web/src/server/usecases/schedule.ts` is touched by
W3 (SW-M13 bye shell on a court; #840 Rebuild NULLs the schedule);
`stages.ts` by every format wave. Overlap → stop and sequence.

## Scope

**Division-level 🚫 scenarios owned here** (design §4, §8): D1 merge two
divisions, D2 split a division, R13 move an entrant to another division after
the draw — each gets a build-or-refuse recommendation for the owner.

Routed gaps, copied from design §8:

the [O] list (§4), #880, bench findings: cross-competition court double-booking
(`schedule.ts:939`), `solver_unavailable`, `start_window` never blocks, inert
`crossPersonClash`, no engine request, `lang` until hydration.

## Lifecycle (design §10)

1. Rulebook `rulebook-W9-operational.md` (drafted when the lane starts: the
   intended behaviour per [O] item, and which refuse) → **sign-off**.
2. Reference: no format family — record in the rulebook which harness
   invariants each [O] case asserts. 3. Truth run: reproduce each [O] item and
   bench finding on a clean environment first (R5, class 14). 4. Plan →
   implementer → reviewer; TDD; four test types; mutate every guard. 5. Gates.
6. No bench gate. 7. Drive, PR, e2e.

## Decisions owed (put to the owner as recommendations)

- **O6** — per [O] item: build or refuse-with-guidance (e.g. refunds on removal
  of unpaid entries, age-eligibility disputes, who wins when two scorers write).
- New screens — ≥2 options shown first (R24).

## Done when

Ruling 19 on the [O] cases: zero ❌ from the items above; others ⏳ with their
owner; nothing previously ✅/⛔ red anywhere; §10.5 gates.

## Traps

1. **`crossPersonClash` is inert** — declared, never enforced (class 1). Prove
   the fix through the real scheduler and a real clash, not a unit fixture.
2. **`SEQ_CONFLICT` fires before the insert**, so a `23505` catch behind it is
   dead code. Two scorers and out-of-order sync must be driven, not reasoned.
3. **`solver_unavailable` may be the environment**: the placement service is
   a separate container (`bench.yml`). Start it before calling a red a defect.
4. **Shared with W8**: "stale sheet scanned after a move or rebuild" overlaps
   SH-G12 / SH-G18. Agree the owner of the shared code before either lane edits it.
5. **#880's "Shift day seq race" was a flaky-shaped red** at the 09-25 release
   smoke — re-run three times before believing a result either way (class 8).

## Output and handoff

Update the W9 row, the disjointness proof, decision log and "False premises
found" in `_INDEX.md` as they happen (R22).
