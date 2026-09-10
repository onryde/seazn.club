# Scheduler bench — run `9f3924a8e0959e00aa7b038676916161a5e663be`

- Gate: **GREEN**
- Engine: optimized
- Base: http://localhost:3374
- Started: 2026-09-10T19:17:30.333Z
- Finished: 2026-09-10T19:17:44.936Z
- Oracles: 45 total, 43 with a subject (43 PASS, 0 FAIL), 2 NO SUBJECT

## Pre-flight

- Result: PASSED
- Placement: live — placement channel to localhost:50302 reached READY within 3s.

## Suites

### _tiny — GREEN

- Timings: seed 4569ms, schedule 884ms, sim 489ms, import 956ms
- Data left in place: no (--wipe requested)
- Solver: requested=optimized, actual=n/a, status=n/a
- Blocking conflicts: 0
- Provenance: 75% real (6/8 streams; 2 reconstructed)
- Claims: 2/4 invites accepted
- News: 1/15 drafted posts published
- Oracles:
  - PASS entitlement-gate: revise_no_target_community — reached the ENGINE and was refused on shape: 422 INVALID_EVENT — the entitlement door let this call through, which is what "scoring is free" means over HTTP
  - PASS entitlement-gate: revise_with_target_community — not refused for payment (status 201) — the entitlement gate cleared it
  - PASS entitlement-gate: revise_dls_off_community — not refused for payment (status 422) — the entitlement gate cleared it
  - PASS entitlement-gate: other_event_community — not refused for payment (status 422) — the entitlement gate cleared it
  - PASS entitlement-gate: gated_feature_refusal_names_its_key — refused as expected: 402 PAYMENT_REQUIRED, feature_key "officials.auto"
  - PASS entitlement-gate: revise_no_target_after_plan — reached the ENGINE and was refused on shape: 422 INVALID_EVENT — the entitlement door let this call through, which is what "scoring is free" means over HTTP
  - PASS entitlement-gate: cricket.dls is free on the plan a non-paying org resolves to — plan_entitlements grants cricket.dls on "community" — scoring is free, as ruled (V390__scoring_free.sql; V393__entitlements_v18.sql:63-70)
  - PASS officials: claim invite unclaimed (off-eli) — claim 6d1a71c8-027d-443d-b8d7-f8c97946a85c for person 84407ee0-5d1d-44cc-8236-307c2561bfb7 is minted and unclaimed
  - PASS officials: claim invite unclaimed (off-dee) — claim fd474abf-3197-4e15-8610-5b8d29eafd5b for person a23610c7-32c8-4cb6-86f0-a2d1e2ef98e6 is minted and unclaimed
  - PASS officials: auto-assign reaches the auto-needing official(s) after scheduling — 3 proposed, 3 applied across 3 fixture(s)
  - PASS player-stats: baseline — 2 roster read(s), 0 division row(s), 0 public row(s) — empty rows is the correct baseline (B03 folds no score events; see lib/stats.ts's header comment)
  - PASS oracle: d-tiebreak discipline enforced at the team sheet (p-hotel) — naming the ACTIVE-suspended "p-hotel" on "rr-r3-c1" was REFUSED with 422 SUSPENDED_PLAYER, and the ELIGIBLE team-mate "p-foxtrot" alone was ACCEPTED on that same sheet — the gate refuses the banned player, not everybody
  - PASS oracle: d-tiebreak discipline carry (p-hotel) — the ban confirmed through POST /divisions/{id}/suspensions + PATCH {kind:"confirm"} is ACTIVE over 1 match(es), stamped on entrant "e-foxtrot", and "p-hotel" is off the team sheet of rr-r3-c1 while still on 1 fixture(s) the pack does NOT name — and the ELIGIBLE team-mate "p-foxtrot" holds no ban and is on all 2 sheet(s)
  - PASS advance: s-playoff seed proposal qualifiers — proposal qualifiers [ba2cf589-81d3-4094-a11b-fcd24d9f5975, 92e3547b-361b-4baa-8655-c1e4258d9f13] match the pack's expected order
  - PASS advance: s-playoff finalRanks — captured finalRanks [ba2cf589-81d3-4094-a11b-fcd24d9f5975, 92e3547b-361b-4baa-8655-c1e4258d9f13] match the pack's expected order
  - PASS oracle: s-playoff rank crossing (captured vs standings) — captured finalRanks and the re-read standings agree: [ba2cf589-81d3-4094-a11b-fcd24d9f5975, 92e3547b-361b-4baa-8655-c1e4258d9f13]
  - PASS oracle: s-playoff standings rank vs expected.finalRanks — re-read standings [ba2cf589-81d3-4094-a11b-fcd24d9f5975, 92e3547b-361b-4baa-8655-c1e4258d9f13] match the pack's expected order
  - PASS oracle: d-tiny champion — champion ba2cf589-81d3-4094-a11b-fcd24d9f5975 matches the pack's expected champion
  - PASS oracle: d-tiny per-match results — 4 checked, 0 mismatched (r1: 2/2, r2: 1/1, r3: 1/1)
  - PASS oracle: d-badminton per-match results — 1 checked, 0 mismatched (r1: 1/1)
  - PASS oracle: d-tiebreak per-match results — 3 checked, 0 mismatched (r1: 1/1, r2: 1/1, r3: 1/1)
  - PASS oracle: d-tiny/s-league standings table — live standings for "s-league" match the pack's expected.tables row — live rows also carry metric(s) this pack does not declare (not gated): ba2cf589-81d3-4094-a11b-fcd24d9f5975: {"for":5,"diff":2,"against":3}; 92e3547b-361b-4baa-8655-c1e4258d9f13: {"for":3,"diff":-2,"against":5}
  - NO SUBJECT oracle: d-tiny/s-league tie-order cascade — no two rows in "s-league" are tied on points that cascade [points,diff] could decide — this oracle has NO SUBJECT and compared nothing (0 checked, 0 skipped)
  - PASS oracle: d-badminton/s-badminton-league standings table — live standings for "s-badminton-league" match the pack's expected.tables row — live rows also carry metric(s) this pack does not declare (not gated): b62b7608-5e91-483b-9d55-ed80df43e9f6: {"sets_won":2,"sets_lost":0,"points_won":42,"points_lost":33}; 76dc357f-0c65-4bdb-8138-778a47872e66: {"sets_won":0,"sets_lost":2,"points_won":33,"points_lost":42}
  - NO SUBJECT oracle: d-badminton/s-badminton-league tie-order cascade — no two rows in "s-badminton-league" are tied on points that cascade [points,wins,set_ratio,point_ratio,h2h_points] could decide — this oracle has NO SUBJECT and compared nothing (0 checked, 0 skipped)
  - PASS oracle: d-tiebreak/s-tiebreak-league standings table — live standings for "s-tiebreak-league" match the pack's expected.tables row
  - PASS oracle: d-tiebreak/s-tiebreak-league tie-order cascade — live order agrees with cascade [points,diff,for] on every tied pair (1 checked, 0 skipped)
  - PASS oracle: specials — 1 special(s), 5 claim(s) checked, 0 failed, 0 unsupported
  - PASS oracle: d-tiny leaderboard (scores) — live leaderboard "scores" matches the pack's expected.leaderboards row
  - PASS oracle: d-tiny person cards (scores) — each of the 2 person(s) on this board carries the SAME "scores" count on their own /persons/{id}/stats card for "d-tiny"
  - PASS oracle: d-tiny leaderboard (points) — live leaderboard "points" matches the pack's expected.leaderboards row
  - PASS oracle: d-tiny person cards (points) — each of the 2 person(s) on this board carries the SAME "points" count on their own /persons/{id}/stats card for "d-tiny"
  - PASS oracle: d-tiebreak leaderboard (scores) — live leaderboard "scores" matches the pack's expected.leaderboards row
  - PASS oracle: d-tiebreak person cards (scores) — each of the 2 person(s) on this board carries the SAME "scores" count on their own /persons/{id}/stats card for "d-tiebreak"
  - PASS oracle: d-tiebreak leaderboard (points) — live leaderboard "points" matches the pack's expected.leaderboards row
  - PASS oracle: d-tiebreak person cards (points) — each of the 2 person(s) on this board carries the SAME "points" count on their own /persons/{id}/stats card for "d-tiebreak"
  - PASS oracle: p-ana career rollup — the live ?group=sport rollup carries all 2 of this person's expected.careers metric(s), each in exactly one sport
  - PASS people: claim invites accepted — 2/2 invites accepted by the invited address
  - PASS people: an invalid claim token is refused — a same-shape, same-length token that was never minted drew HTTP 401
  - PASS people: an accepted invite is closed — all 2 accepted invites no longer read back as open
  - PASS people: invites past the limit stay unclaimed — 2 invite(s) were never touched and still read back as open
  - PASS people: a claimed profile still reports the same stats — 2 claimed profile(s) report the same divisions and stats as before acceptance
  - PASS news: folding drafted posts — 15 draft(s) exist for this run's competition after the folds
  - PASS news: the named fixtures publish and the rest stay draft — 1/1 named fixture(s) published, 14 post(s) still draft
  - PASS news: a republish does not move published_at — publishing an already-published post left published_at where it was
- Warnings (not gated):
  - leaderboards.not_derived @ expected.leaderboards: 4 declared expected.leaderboards entries are NOT checked offline: the product's player-stats fold needs a PlayerStatsFoldCtx built from entrant-member rows (usecases/player-stats.ts:124-140), and a second, differently-built ctx here would be a parallel implementation rather than a check. Owed to the seeded HTTP run (B05)
  - champions.not_derived @ expected.champions: 1 declared expected.champions entry is NOT checked offline: a champion is the product's stage-completion and progression answer, not the fold's. Owed to the seeded HTTP run (B05)
  - finalRanks.not_derived @ expected.finalRanks: 1 declared expected.finalRanks entry is NOT checked offline: a stage's placement order is the product's progression answer, exactly like a champion — a bracket writes a `placementTable`-wrapped row (usecases/stages.ts:2400) that stage 0 has no fixture rows to reproduce. The REFS and the order's internal consistency are checked at parse (PackSchema), including against a sibling expected.tables row where the stage has one. Owed to the seeded HTTP run (B05)
  - careers.not_derived @ expected.careers: 2 declared expected.careers entries are NOT checked offline: a career rollup spans divisions and rides the same player-stats fold as a leaderboard, which needs a PlayerStatsFoldCtx built from entrant-member rows (usecases/player-stats.ts:124-140). Summing the per-division leaderboards here would compute one expected value out of others. Owed to the seeded HTTP run (B05)
  - suspensions.not_derived @ expected.suspensions: 1 declared expected.suspensions entry is NOT checked offline: a discipline carry-over spans fixtures, and stage 0 folds each fixture on its own. Owed to the seeded HTTP run (B05)
  - _tiny: division "d-tiny" declares 2 stages and only "s-league" is scheduled — B04 drives one stage per division

#### Registration

| Division | Entries | Entrants | Waitlisted | Rejected (eligibility) | Rejected (manual) | Paid cents | Funnel wall-time | Pad wall-time |
|---|---|---|---|---|---|---|---|---|
| d-registration | 2 | 2 | 0 | 0 | 0 | 0 | 5221ms | n/a |

- `d-registration`: organiser-force eligibility gate: UNPROVEN this run — `gateRosterEligibility` ("ELIGIBILITY_VIOLATION") is reachable only from entrant creation / fixture generation (B04 territory), never from this run’s organiser actions. Only the public-submit half of design §5.2’s eligibility gate is proven here.

## Scheduling

| Suite | Division | Requested | Actual | Status | Mode | Blocking | Unplaced (board) | Placed/Total (proposal) | Wall |
|---|---|---|---|---|---|---|---|---|---|
| _tiny | d-tiny | optimized | optimized | ok | build | 0 | 0 | 3/3 | 237ms |
| _tiny | d-badminton | optimized | greedy | already_optimal | build | 0 | 0 | 1/1 | 145ms |
| _tiny | d-tiebreak | optimized | optimized | ok | build | 0 | 0 | 3/3 | 151ms |

## Checker (independent verifier)

### _tiny / d-tiny — CLEAN

- Unchecked constraints (1) — "clean" above does NOT cover these:
  - `gapMinutes`: not modelled by the bench checker — gapMinutes is a spacing preference and not an occupancy claim — court occupancy is judged on [start, start + matchMinutes) and design §3.3's rule list has no gap rule, so the value is carried for the report and never checked
- Unexercised rules (1) — modelled, but nothing on this board exercised them:
  - `Rule 5 — not_before / not_after`: no not_before/not_after hard rule matched a placed fixture's scope

After officials auto-assign — CLEAN (unchanged)
- Unexercised rules (1) — modelled, but nothing on this board exercised them:
  - `Rule 5 — not_before / not_after`: no not_before/not_after hard rule matched a placed fixture's scope

### _tiny / d-badminton — CLEAN

- Unchecked constraints (1) — "clean" above does NOT cover these:
  - `gapMinutes`: not modelled by the bench checker — gapMinutes is a spacing preference and not an occupancy claim — court occupancy is judged on [start, start + matchMinutes) and design §3.3's rule list has no gap rule, so the value is carried for the report and never checked
- Unexercised rules (7) — modelled, but nothing on this board exercised them:
  - `Rule 1 — court double-booking`: no two placed fixtures share a court to compare for overlap
  - `Rule 2b — blackouts`: blackouts is empty, or nothing was placed — no blackout was available to test a placed fixture against
  - `Rule 3 — rest minima`: perEntrantMinRest is 0, or no entrant played two or more placed fixtures to measure a gap between
  - `Rule 5 — not_before / not_after`: no not_before/not_after hard rule matched a placed fixture's scope
  - `Rule 6 — pin integrity`: pins is empty — no pin was declared for this rule to verify
  - `Rule 7 — officials`: the pack did not declare officials for this division, or nothing was placed
  - `Rule 8 — round order`: isRoundRobin is false, or no two placed fixtures had a comparable round number

After officials auto-assign — CLEAN (unchanged)
- Unexercised rules (7) — modelled, but nothing on this board exercised them:
  - `Rule 1 — court double-booking`: no two placed fixtures share a court to compare for overlap
  - `Rule 2b — blackouts`: blackouts is empty, or nothing was placed — no blackout was available to test a placed fixture against
  - `Rule 3 — rest minima`: perEntrantMinRest is 0, or no entrant played two or more placed fixtures to measure a gap between
  - `Rule 5 — not_before / not_after`: no not_before/not_after hard rule matched a placed fixture's scope
  - `Rule 6 — pin integrity`: pins is empty — no pin was declared for this rule to verify
  - `Rule 7 — officials`: the pack did not declare officials for this division, or nothing was placed
  - `Rule 8 — round order`: isRoundRobin is false, or no two placed fixtures had a comparable round number

### _tiny / d-tiebreak — CLEAN

- Unchecked constraints (1) — "clean" above does NOT cover these:
  - `gapMinutes`: not modelled by the bench checker — gapMinutes is a spacing preference and not an occupancy claim — court occupancy is judged on [start, start + matchMinutes) and design §3.3's rule list has no gap rule, so the value is carried for the report and never checked
- Unexercised rules (6) — modelled, but nothing on this board exercised them:
  - `Rule 2b — blackouts`: blackouts is empty, or nothing was placed — no blackout was available to test a placed fixture against
  - `Rule 3 — rest minima`: perEntrantMinRest is 0, or no entrant played two or more placed fixtures to measure a gap between
  - `Rule 4 — day caps`: no max_fixtures_per_day hard rule matched a placed fixture's scope on any day
  - `Rule 5 — not_before / not_after`: no not_before/not_after hard rule matched a placed fixture's scope
  - `Rule 6 — pin integrity`: pins is empty — no pin was declared for this rule to verify
  - `Rule 7 — officials`: the pack did not declare officials for this division, or nothing was placed

After officials auto-assign — CLEAN (unchanged)
- Unexercised rules (6) — modelled, but nothing on this board exercised them:
  - `Rule 2b — blackouts`: blackouts is empty, or nothing was placed — no blackout was available to test a placed fixture against
  - `Rule 3 — rest minima`: perEntrantMinRest is 0, or no entrant played two or more placed fixtures to measure a gap between
  - `Rule 4 — day caps`: no max_fixtures_per_day hard rule matched a placed fixture's scope on any day
  - `Rule 5 — not_before / not_after`: no not_before/not_after hard rule matched a placed fixture's scope
  - `Rule 6 — pin integrity`: pins is empty — no pin was declared for this rule to verify
  - `Rule 7 — officials`: the pack did not declare officials for this division, or nothing was placed

## Cross-division court occupancy (run-level gate)

One court cannot hold two fixtures at once whichever division each belongs to.
Every OTHER layer in this report is division-scoped and blind to this by construction.

- `_tiny`: none — checked across 3 division(s).

## Feasibility certificate

| Suite | Division | Branch | Red? | Reason |
|---|---|---|---|---|
| _tiny | d-tiny | `SKIPPED_NO_HISTORY` | no | the pack declares no historicalAssignment for d-tiny, so there is no real timetable to check our encoding against |
| _tiny | d-badminton | `SKIPPED_NO_HISTORY` | no | the pack declares no historicalAssignment for d-badminton, so there is no real timetable to check our encoding against |
| _tiny | d-tiebreak | `SKIPPED_NO_HISTORY` | no | the pack declares no historicalAssignment for d-tiebreak, so there is no real timetable to check our encoding against |

## Believability

Report-only — nothing here ever reds a run (design §3.5).

- `_tiny/d-tiny`: restSpread=52, courtBalance=92, gapDispersion=100, homeAwayAlternation=100, primeSlotFairness=100
- `_tiny/d-badminton`: restSpread=100, courtBalance=100, gapDispersion=100, homeAwayAlternation=100, primeSlotFairness=100
- `_tiny/d-tiebreak`: restSpread=100, courtBalance=100, gapDispersion=100, homeAwayAlternation=100, primeSlotFairness=100

## Engine delta (greedy − optimized)

- `_tiny`: engine delta omitted: only the optimized leg has an artifact for this run — one leg is not a comparison
