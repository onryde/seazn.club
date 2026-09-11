# Scheduler bench — run `5f26de5513e7e3b5ca623672424bf210da4b523d`

- Gate: **RED**
- Engine: both
- Base: http://localhost:3384
- Started: 2026-09-11T09:22:59.891Z
- Finished: 2026-09-11T09:24:20.583Z
- Oracles: 25 total, 23 with a subject (23 PASS, 0 FAIL), 2 NO SUBJECT

## Pre-flight

- Result: PASSED
- Placement: absent — placement channel to localhost:50484 did not reach READY within 3s (Failed to connect before the deadline).

## Suites

### suite11 — RED

- Timings: seed 5705ms, schedule 726ms, sim 15496ms, import 26949ms
- Data left in place: no (--wipe requested)
- Solver: requested=both, actual=greedy, status=n/a
- Blocking conflicts: 0
- Provenance: 100% real (205/205 streams)
- Claims: 3/3 invites accepted
- News: 95/205 drafted posts published
- Oracles:
  - PASS entitlement-gate: revise_no_target_community — reached the ENGINE and was refused on shape: 422 INVALID_EVENT — the entitlement door let this call through, which is what "scoring is free" means over HTTP
  - PASS entitlement-gate: revise_with_target_community — not refused for payment (status 201) — the entitlement gate cleared it
  - PASS entitlement-gate: revise_dls_off_community — not refused for payment (status 422) — the entitlement gate cleared it
  - PASS entitlement-gate: other_event_community — not refused for payment (status 422) — the entitlement gate cleared it
  - PASS entitlement-gate: gated_feature_refusal_names_its_key — refused as expected: 402 PAYMENT_REQUIRED, feature_key "officials.auto"
  - PASS entitlement-gate: revise_no_target_after_plan — reached the ENGINE and was refused on shape: 422 INVALID_EVENT — the entitlement door let this call through, which is what "scoring is free" means over HTTP
  - PASS entitlement-gate: cricket.dls is free on the plan a non-paying org resolves to — plan_entitlements grants cricket.dls on "community" — scoring is free, as ruled (V390__scoring_free.sql; V393__entitlements_v18.sql:63-70)
  - PASS player-stats: baseline — 96 roster read(s), 0 division row(s), 0 public row(s) — empty rows is the correct baseline (B03 folds no score events; see lib/stats.ts's header comment)
  - NO SUBJECT oracle: discipline carry — the pack declares no expected.suspensions rows — the discipline-carry oracle (compareSuspensions) has NO SUBJECT and compared nothing
  - PASS oracle: d-worlds per-match results — 95 checked, 0 mismatched (r1: 32/32, r2: 32/32, r3: 16/16, r4: 8/8, r5: 4/4, r6: 2/2, r7: 1/1)
  - PASS oracle: d-womens per-match results — 110 checked, 0 mismatched (r1: 47/47, r2: 32/32, r3: 16/16, r4: 8/8, r5: 4/4, r6: 2/2, r7: 1/1)
  - PASS oracle: d-worlds leaderboard (scores) — live leaderboard "scores" matches the pack's expected.leaderboards row
  - PASS oracle: d-worlds person cards (scores) — each of the 10 person(s) on this board carries the SAME "scores" count on their own /persons/{id}/stats card for "d-worlds"
  - PASS oracle: d-womens leaderboard (scores) — live leaderboard "scores" matches the pack's expected.leaderboards row
  - PASS oracle: d-womens person cards (scores) — each of the 10 person(s) on this board carries the SAME "scores" count on their own /persons/{id}/stats card for "d-womens"
  - PASS oracle: p-fallon-sherrock career rollup — the live ?group=sport rollup carries all 1 of this person's expected.careers metric(s), each in exactly one sport
  - PASS oracle: p-noa-lynn-van-leuven career rollup — the live ?group=sport rollup carries all 1 of this person's expected.careers metric(s), each in exactly one sport
  - PASS people: claim invites accepted — 3/3 invites accepted by the invited address
  - PASS people: an invalid claim token is refused — a same-shape, same-length token that was never minted drew HTTP 401
  - PASS people: an accepted invite is closed — all 3 accepted invites no longer read back as open
  - NO SUBJECT people: invites past the limit stay unclaimed — this run accepted every invite the pack declares, so nothing proves an UNCLAIMED one survives
  - PASS people: a claimed profile still reports the same stats — 3 claimed profile(s) report the same divisions and stats as before acceptance
  - PASS news: folding drafted posts — 205 draft(s) exist for this run's competition after the folds
  - PASS news: the named fixtures publish and the rest stay draft — 95/95 named fixture(s) published, 110 post(s) still draft
  - PASS news: a republish does not move published_at — publishing an already-published post left published_at where it was
- Errors:
  - d-womens: certificate PACK_AUTHORING_BUG — the real timetable breaches our own encoding (1 findings: court_double_booking) — the pack encoded constraints stricter than reality, so fix the pack, not the solver
- Warnings (not gated):
  - leaderboards.not_derived @ expected.leaderboards: 2 declared expected.leaderboards entries are NOT checked offline: the product's player-stats fold needs a PlayerStatsFoldCtx built from entrant-member rows (usecases/player-stats.ts:124-140), and a second, differently-built ctx here would be a parallel implementation rather than a check. Owed to the seeded HTTP run (B05)
  - champions.not_derived @ expected.champions: 2 declared expected.champions entries are NOT checked offline: a champion is the product's stage-completion and progression answer, not the fold's. Owed to the seeded HTTP run (B05)
  - finalRanks.not_derived @ expected.finalRanks: 2 declared expected.finalRanks entries are NOT checked offline: a stage's placement order is the product's progression answer, exactly like a champion — a bracket writes a `placementTable`-wrapped row (usecases/stages.ts:2400) that stage 0 has no fixture rows to reproduce. The REFS and the order's internal consistency are checked at parse (PackSchema), including against a sibling expected.tables row where the stage has one. Owed to the seeded HTTP run (B05)
  - careers.not_derived @ expected.careers: 2 declared expected.careers entries are NOT checked offline: a career rollup spans divisions and rides the same player-stats fold as a leaderboard, which needs a PlayerStatsFoldCtx built from entrant-member rows (usecases/player-stats.ts:124-140). Summing the per-division leaderboards here would compute one expected value out of others. Owed to the seeded HTTP run (B05)
  - pack declares no league-stage fixture-count expectation to check the 0 generated fixture(s) against — this pack declares no league stage, so there is nothing to check
  - suite11: pinned "se-r0-i1" at its OWN historical start 2024-12-15T19:00:00.000Z rather than the division's startAt — a pin that contradicts history checks nothing
  - oracle: pack declares no expected.suspensions rows — the discipline-carry oracle (compareSuspensions) has no subject and was NOT run

## Scheduling

| Suite | Division | Requested | Actual | Status | Mode | Blocking | Unplaced (board) | Placed/Total (proposal) | Wall |
|---|---|---|---|---|---|---|---|---|---|
| suite11 | d-worlds | both | greedy | solver_unavailable | build | 0 | 0 | 95/95 | 292ms |
| suite11 | d-womens | both | greedy | not_searched | build | 0 | 0 | 110/110 | 337ms |

- `d-worlds`: solver budget expired (tiers 0/6)
- `d-womens`: solver did not search — too_big
- `d-womens`: solver budget expired (tiers 0/6)

## Checker (independent verifier)

### suite11 / d-worlds — CLEAN

- Unchecked constraints (1) — "clean" above does NOT cover these:
  - `gapMinutes`: not modelled by the bench checker — gapMinutes is a spacing preference and not an occupancy claim — court occupancy is judged on [start, start + matchMinutes) and design §3.3's rule list has no gap rule, so the value is carried for the report and never checked
- Unexercised rules (6) — modelled, but nothing on this board exercised them:
  - `Rule 2a — session windows`: sessionWindows is empty, or nothing was placed — no window was available to contain a fixture within
  - `Rule 2b — blackouts`: blackouts is empty, or nothing was placed — no blackout was available to test a placed fixture against
  - `Rule 3 — rest minima`: perEntrantMinRest is 0, or no entrant played two or more placed fixtures to measure a gap between
  - `Rule 5 — not_before / not_after`: no not_before/not_after hard rule matched a placed fixture's scope
  - `Rule 7 — officials`: the pack did not declare officials for this division, or nothing was placed
  - `Rule 8 — round order`: isRoundRobin is false, or no two placed fixtures had a comparable round number

### suite11 / d-womens — CLEAN

- Unchecked constraints (1) — "clean" above does NOT cover these:
  - `gapMinutes`: not modelled by the bench checker — gapMinutes is a spacing preference and not an occupancy claim — court occupancy is judged on [start, start + matchMinutes) and design §3.3's rule list has no gap rule, so the value is carried for the report and never checked
- Unexercised rules (8) — modelled, but nothing on this board exercised them:
  - `Rule 2a — session windows`: sessionWindows is empty, or nothing was placed — no window was available to contain a fixture within
  - `Rule 2b — blackouts`: blackouts is empty, or nothing was placed — no blackout was available to test a placed fixture against
  - `Rule 3 — rest minima`: perEntrantMinRest is 0, or no entrant played two or more placed fixtures to measure a gap between
  - `Rule 4 — day caps`: no max_fixtures_per_day hard rule matched a placed fixture's scope on any day
  - `Rule 5 — not_before / not_after`: no not_before/not_after hard rule matched a placed fixture's scope
  - `Rule 6 — pin integrity`: pins is empty — no pin was declared for this rule to verify
  - `Rule 7 — officials`: the pack did not declare officials for this division, or nothing was placed
  - `Rule 8 — round order`: isRoundRobin is false, or no two placed fixtures had a comparable round number

## Cross-division court occupancy (run-level gate)

One court cannot hold two fixtures at once whichever division each belongs to.
Every OTHER layer in this report is division-scoped and blind to this by construction.

- `suite11`: none — checked across 2 division(s).

## Feasibility certificate

| Suite | Division | Branch | Red? | Reason |
|---|---|---|---|---|
| suite11 | d-worlds | `FEASIBLE` | no | the real timetable satisfies our encoding and the product placed all 95 fixtures (solver status solver_unavailable) |
| suite11 | d-womens | `PACK_AUTHORING_BUG` | yes | the real timetable breaches our own encoding (1 findings: court_double_booking) — the pack encoded constraints stricter than reality, so fix the pack, not the solver |

History's own violations of this pack's encoding:
- `d-womens` `court_double_booking` [184faa0d-2087-4def-8959-c88a67dc8ab2, bb7d295d-6a53-46ee-a12c-e049edfadc7b]: court 440278f4-f78c-4125-a924-7a6b10be083e is occupied by 184faa0d-2087-4def-8959-c88a67dc8ab2 (2024-03-23T12:23) and bb7d295d-6a53-46ee-a12c-e049edfadc7b (2024-03-23T12:32) at the same time, for 12 minutes each

## Believability

Report-only — nothing here ever reds a run (design §3.5).

- `suite11/d-worlds`: restSpread=100, courtBalance=100, gapDispersion=9, primeSlotFairness=63
  - similarity to historical: 8% same day, 2% same instant over 95 compared fixture(s) of 95 declared row(s)
- `suite11/d-womens`: restSpread=100, courtBalance=100, gapDispersion=100, primeSlotFairness=69
  - similarity to historical: 100% same day, 0% same instant over 110 compared fixture(s) of 110 declared row(s)

## Engine delta (greedy − optimized)

- `suite11`: engine delta omitted: no engine artifact was read for this run, so there is nothing to compare
