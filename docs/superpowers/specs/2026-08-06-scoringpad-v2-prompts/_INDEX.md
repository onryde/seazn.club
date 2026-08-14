# ScoringPad v2 / #407 — session index

**One wave per session.** Read `_RULES.md`, then this file, then the session's
prompt file. This file is the compaction anchor: every ruling, every false
premise, every status change gets written here **as it happens**.

Programme index issue: #411. Design: `../2026-08-03-scoringpad-v2-design.md`.

## Order

Main chain is sequential. The `L` lane is a disjoint file set — run it whenever,
interleaved or in parallel, but `L2` waits on `L1` (shared `schemas.ts`).

| Session | Issue | Prompt file | Depends on | Status |
|---|---|---|---|---|
| S1 | #429 | `S01-429-golden-corpus-policy.md` | — | **DONE** |
| S2 | #430 | `S02-430-fidelity-tier-4-decision.md` | — | **DONE** — no code. Fidelity ladder closed at 0–3; tier 4 will never exist |
| S3 | #426 | `S03-426-w4b-mutable-squads.md` | S1 | **DONE** — all 9 deferred rows closed; 4 owner rulings; e2e+smoke deferred to S12/S13 |
| S4 | #428 | `S04-428-offence-taxonomies.md` | S3 (person-role decision) | **DONE, post-review** — 3 enums adopted (football `PenaltyOffence`, hockey/icehockey `PeriodSuspensionReason`), 6 rows deferred with reasons recorded, person-role discriminator closed END TO END (`lineups.role`, V357, wired into both stats call sites — round-1 review caught the first pass shipping it engine-only/unreachable), `persons.lane` extended (V356) |
| S5 | #431 | `S05-431-decisions-register.md` | S3, S4 | **DONE** — register closed, all 8 rulings accounted for; items 2 (tennis game-award) and 4 (football quarters) BUILT this session on owner instruction rather than re-homed, cricket `pairs-6-a-side` dropped with a DB prune fix |
| S6 | #416 | `S06-416-w5-padspec.md` | S2, S3, S5 | **DONE** — `PadSpec` contract + bidirectional conformance shipped for all 11 modules; fidelity model redesigned per the S2 ruling; 3 named variant-gating regressions fixed; e2e/smoke deferred to S12/S13 |
| S7 | #427 | `S07-427-pad-vocabulary-i18n.md` | S3, S4, S6 | **DONE** — prompt's own "owed by sport" list was stale (S3/S4/S5 shipped most of it early); real gap was S6's 164-key `PadLabel` namespace never reaching apps/web, a missing per-field label slot, and 3 review-caught rendering bugs. Real e2e shipped, independently verified twice |
| S8 | #417 | `S08-417-w6-player-stats.md` | S6 | **DONE, e2e+smoke discharged** — 3 prompt premises false (all 11 modules already declared `playerStats`, dot-paths already shipped, no kernel default existed to copy); the real defect was models declared against OPTIONAL person fields on entrant-attributed payloads, i.e. inert. Owner ruled to widen into `apps/web` so the entrant→person fallback is reachable. Goalkeeper stats shipped INCLUDING shots-on-goal/saves (owner amended the S2/#430 parking — table row above is stale on this point, kept for history per the decision log below). W6 review closed 6+3+1 gaps across three rounds. E2E (`apps/web/e2e/stats.spec.ts`) + smoke (`scripts/smoke.ts` `playerStatsSuite`) landed in the S8b follow-up session — real HTTP, real numbers, mutation-proved. S9 still owes its OWN e2e once the `/me` page exists; that is not this row |
| S9 | #418 | `S09-418-w7-career-rollup.md` | S3, S8 | **DONE** — scope 1 (the `personsOf`/`cfg` plumbing) was ALREADY SHIPPED by S8/#417, so the prompt's central "Why" premise is false; the real work was the rollup, the route, the two surfaces and the e2e S8 owed forward. First session in the programme with a real user-facing surface, so all four test types landed here with no deferrals. Three defects found by RENDERING it that no unit test could see (see the decision log) |
| S10 | #419 | `S10-419-w8-chassis-renderer.md` | S6 | **DONE, MERGED `cc907a0b` (PR #542)** — 4 prompt premises false (server idempotency is a fail-open Redis cache with NO ledger column, no pad subscribes to realtime, the client cannot import the engine as the brief assumed, the 409 already carries `current_seq`); the replay ruling was rewritten around ledger-slot inspection because blind `expected_seq` renegotiation — which the brief calls "the correctness heart" — IS the duplicate bug given that. Chassis + renderer + picker + timeline shipped; **the picker was found INERT by the e2e** (written, tested, wired to nothing — fifth instance of this programme's signature defect) and is now the pad's default. E2E covers tab death / offline / 409-mid-drain against the real API and RUNS IN CI (`SCOREPAD_V2_HARNESS=1` in the three e2e jobs). Smoke deferred to S13 (verified: `scripts/smoke.ts` has zero references). Contract S11 consumes: `PadRenderer` props + the `renderAttribution` / `timelineSlot` override seams. Flag `scorepad-v2` (PostHog) declared, wired to nothing, flipped in S12 |
| S11 | #420 | `S11-420-w9-skins.md` | S7, S10 | **DONE** — **five** skins, not three: the prompt's two sport groupings were disproved by building the real specs (tennis is a different kernel from the setbased three; football cannot share with the period pair, but hockey/icehockey are byte-identical to each other). Coverage gate landed RED first and is mutation-proved. Renderer now consults the registry by default — owner ruling, taken because a registry nothing calls is S10's inert-picker defect again. Review caught 5 gaps, 2 of them real: `racquet`/`period` rendered PAID-GATED actions as live controls for 5 of 8 sports (the sweeps could not see it — `grantAllEntitlements` means `locked` never occurs in the suite), and cricket's batter/bowler pickers never resynced to the fold, so a scorer could score against the wrong end. Cricket has NO browser coverage: the harness's lineups are synthetic and every `cricket.ball` needs real roster members — S12 owes it, along with football's goal-with-assist |
| S12 | #421 | `S12-421-w10-integration-flag.md` | S11 | **DONE** — v2 reaches both real entry points behind `scorepad-v2`, and driving it in a browser against real rosters found **nine** product defects plus two layout defects, none of which `tsc`, ~6000 unit tests, lint or a green production build could see. The chain was sequential — each fix uncovered the next — which is the signature of a path nothing had ever executed: a `"use client"` mapper called from both server loaders (invisible because `[].map(fn)` never invokes `fn`, so it is unreachable until the ledger has one row); the fold throwing on a foreign `core.start`; `ballInOver: 0` making the first ball of every over schema-invalid; the fold not advancing on its own ack, so exactly ONE event was ever scoreable on ANY sport; a duplicate-seq double-count on the ack path; undo swallowed for a just-scored event, and again for one queued across a reload; raw UUIDs in three skins' person pickers; a coach able to open the batting; and the lineup editor silently dropping `role`, which made that last fix unreachable from the product's own UI. The flag needed its own reader (`lib/scorepad-flag.ts`, three-state `SCOREPAD_V2_FORCE`) because `isServerFeatureEnabled` returns `fallback ?? false` with no PostHog client — so the v2 pad was unreachable from EVERY e2e run. Flag-off byte-identity proved two ways and **counted, not asserted**: exactly three non-additive lines across the three files on that path, all inert with the flag off; plus v1's own e2e green against a second server off the SAME build with `SCOREPAD_V2_FORCE=0`. Deferred e2e debt discharged per session with a verdict each (S6 by construction, S3 partially, S4 and S1 re-deferred with cause). Note for S13: the lineup-editor half is NOT flag-gated and ships live |
| S13 | #422 | `S13-422-w11-cutover.md` | S12 | **DONE** — v1 deleted outright (8 pads, 3 pad tests, both dispatch chains, the `scorepad-v2` flag, the `/score/harness` route, 160 dead dictionary keys across 4 locales); v2 is the only path. Deleting it surfaced FIVE behaviours v1 had that v2 did not: the suspension countdown, the DLS revised-target surface, hockey's escalation hint (whose v1 key `pad.pp.escalation` had never been translated in ANY locale — v1 rendered the raw key to users), person attribution on period suspensions (rendered as a raw UUID textbox because the skin read only `state.squads`, which is populated ONLY after a `core.lineup.*` folds — so every hockey/icehockey card in production asked the scorer to type a UUID), and `ActionForm.handleTap` auto-firing an incomplete payload for any action with no fields but a required attribution (7 declarations across tennis/carrom/generic/setbased). All five implemented on v2 before v1 was removed. An axe scan made reachable for the first time by the re-anchor then found **24 WCAG AA contrast failures** across the whole scorepad tree, worst 1.48:1 — all fixed, ratios computed from the oklch palette, and axe now runs per skin so the gap cannot silently reopen |
| L1 | #412 | `L1-412-w1-eligibility.md` | — | TODO |
| L2 | #413 | `L2-413-w2-date-hardening.md` | L1 | TODO |
| L3 | #414 | `L3-414-w3-formats.md` | — | TODO |

Deferred e2e/smoke debt from the engine-only sessions (S1, S3–S8) is discharged
in **S12** (both entry points, offline) and **S13** (smoke through v2, help tree).
Any session that defers a test type must say so in its PR body.

### The T lane — PARKED, after S13

Fidelity band 3 for the sports that never got one. Ruled shelf-ready in S2/#430:
specced and committed, **nothing runs until a real customer ask**. Design:
`../2026-08-06-fidelity-tier3-extension-design.md`.

| | scope | entitlement | status |
|---|---|---|---|
| T1 | shared machinery — coverage primitive, `derive` returning absent, declared-band state | — | PARKED |
| T2 | period family — hockey, icehockey (shots, saves, save %, faceoffs, circle penetrations) | new key, unnamed | PARKED |
| T3 | setbased + nested — additive fields on the existing `*.rally` / `tennis.point` | `scoring.rally_by_rally` | PARKED |
| T4 | carrom — wire the already-typed `CarromStrike` in | `scoring.strike_by_strike` | PARKED |

T1 first; T2–T4 are independent of each other and pull in any order. Seven of
#430's rows; the excluded set (plus/minus, boardgame PGN, hockey possession)
stays on #430 under a structural rule — *not an independently voidable discrete
fact*. **The fidelity model redesign this lane assumes lands in S6, not here.**

## Done before this index existed

- **W4 #415** merged 2026-08-03, PR #434, squash `fd452457` — 11 `DOMAIN.md`
  dossiers (8 in `sports/<key>/`, 3 as `setbased/DOMAIN.<sport>.md`), 11 frozen
  golden corpora (`sports/**/**.golden.json`), additive schema extensions,
  person-attribution fields. **No version bumps** — modules stay `1.0.0`.
- **W4a #425** (core time model — durations, elapsed-at-event, expiring
  penalties) merged, PRs #454 + #460, 2026-08-04.

## State of the world, verified against `main` 2026-08-06

Facts the 2026-08-03 prompt file gets wrong. Trust these, not that file.

| Old claim | Truth today |
|---|---|
| W4 #415, W4a #425 open | both closed/merged |
| W2 blocked on #398/#399/#400 | all closed — **W2 unblocked** |
| W1 blocked on #402/#404 | both closed — **W1 unblocked** |
| W2 migration is `V345` | last applied is `V355`; next free is **V356** (re-verify at execution) |
| "`ScheduleConfig.endAt` is never read server-side" | **false** — `applyWindow` (`schedule.ts:608-623`) + derived `horizonMinutes` (`:425-428`) landed with #399. W2 shrinks accordingly |
| minor version bump per touched module | **no bumps** — owner ruling, no prod data, extend at `1.0.0` |
| `padSpec` exists somewhere | absent from `packages/` — W5 is untouched greenfield |
| 11 `DOMAIN.md` files | 8 + 3 `DOMAIN.<sport>.md` inside `setbased/` |
| corpus is "2.2 MB" (#429 body, S1 brief) | **4,507,821 bytes** across 11 files at `6846af19` — roughly double, grown by `EXTEND_GOLDEN` passes since W4. Cricket alone is 1,865,370 (41%) |
| only `UPDATE_GOLDEN=1` and `EXTEND_GOLDEN=1` exist | **false** — `REBASELINE_GOLDEN=1` already existed before S1 (same events, recomputed fold) and already cited #429. S1 enforces it; it did not invent it |
| a re-baseline "is reviewed as a state diff" | not possible by inspection — corpora are **single-line minified JSON**, so `git diff` renders any re-baseline as one replaced line. The harness-emitted summary is the only reviewable artifact |
| the never-re-baseline rule held | **false** — `1f56bd5e` (#468, DLS) shipped `cricket.golden.json` mixed into 7 functional files including `apps/web/e2e` and `scripts/smoke.ts` |

Every line number in any prompt file predates 54 W4 commits. **Scout re-pins
before the implementer touches anything.**

## Rulings carried in (do not re-litigate)

- Pad is rebuilt **greenfield**; supersedes #407 WS2 step 6.
- Programme covers all of #407, "not only the UI layer".
- Stat models **prefer explicit PersonId payload fields**, fall back to
  `personsOf(entrantId)` — hence order W4 → W5 → W6 on the same module files.
- Substrate is complete, do NOT rebuild: hash-chained `score_events`,
  `match_states`, realtime tokens, device links. Legacy V014 `matches` = dead.
- Golden corpora are the only tripwire for schema narrowing — conformance
  generates its own streams and can only ever test the present.
- All 8 #431 singletons were ruled 2026-08-03; S5 executes, it does not re-decide.

## Decision log

Append one line per ruling: date, session, decision, reason. Never delete.

- 2026-08-03 — W4 — no module version bumps; no prod data, extend in place at `1.0.0`.
- 2026-08-03 — W4 — frozen golden corpus lands before any schema work (`55b77714`).
- 2026-08-06 — planning — session order fixed as above; #429 first because five
  correctness rows are deadlocked on the never-re-baseline rule.
- 2026-08-06 — S1 — **"never re-baseline" is replaced by "never re-baseline
  silently."** A re-baseline is legitimate only when deliberate, isolated in its
  own commit, and reviewed as a state diff. Reason: the freeze rule protected
  divisions pinned to a module version, and there is no production data — the
  same ground on which W4 skipped version bumps. Enforced, not documented:
  `UPDATE_GOLDEN=1` and `REBASELINE_GOLDEN=1` both refuse to run unless every
  dirty path is a corpus file the run is about to rewrite, and a re-baseline
  prints a per-stream state-diff summary. Policy home:
  `packages/engine/src/testkit/GOLDEN-POLICY.md` (`6846af19`).
- 2026-08-06 — S1 — the config-subset tolerance in `stateMismatch` is
  **permanent and may not be narrowed**: a zod `.default()` on an additive knob
  shifts the resolved config in every frozen state while changing no fold.
  Recorded so a later session does not "tighten" it as a gap.
- 2026-08-06 — S1 — the brief's premise that a **nested** key named `cfg` was a
  live defect is **false**; the status quo was already green there. It ships as a
  regression guard, mutation-proved. The live defect was the sibling write path
  `keepRecordedConfig`, which was untested and carried both weaknesses.
- 2026-08-06 — S1 — **three of the five "deferred correctness rows" in #429 had
  false premises.** (a) Auto early-release of a minor on a powerplay goal is
  **already implemented** — `period/kernel.ts:745-773` `releaseForGoal`, shipped
  in W4a §3.4, documented at `icehockey/DOMAIN.md:50`; `double_minor` is
  deliberately excluded (`:54`). Nothing to do. (b) `Cfg.overtime.skaters` is
  genuinely dead (zero readers) but lives in the **shared** `sports/period/`
  kernel, not in icehockey — blast radius is the whole period family, so the fix
  must stay cfg-driven. (c) The corpus holds **35** OT-with-penalty states across
  3 icehockey streams (3, 4, 13), not the "two states" the issue body claims.
- 2026-08-06 — S1 — **GWS +1 goal: implement, derived at the score layer.**
  IIHF Rule 87 and NHL Rule 84.4 agree — the shoot-out winner is credited one
  additional goal in the FINAL SCORE (3-3 won on shoot-out is recorded 4-3), so
  winner GF +1, loser GA +1, and it flows into goal difference. The same rules
  say shoot-out attempts produce **no** player goals or goals-against; only the
  deciding scorer gets the game-winning goal. So the +1 is awarded in the
  official-score / `sideMetrics` layer (`period/kernel.ts:1302-1306`) and
  **never** by mutating `state.goals` or minting a goal event — a phantom goal
  with no scorer would corrupt the per-person attribution that S8 and S9 read.
  `icehockey/DOMAIN.md:70` called this a product deferral; no rulebook supports
  the current output, so it was a deferral, not a different semantic.
- 2026-08-06 — S1 — **conversion rate stays unemitted; `metricOf` is fixed.**
  No federation ranks on conversion rate — FIH ranks points → GD → GF →
  head-to-head, IIHF points → head-to-head → GD → GF; PC-conversion and
  penalty-shot conversion are display statistics. Emitting them would move
  eleven corpora and every standings delta for no behavioural gain. The live
  defect underneath is `competition/tiebreakers.ts:239-245` `metricOf`, which
  returns **0 silently** for an absent metric key, so a row predating any metric
  scores a genuine zero rather than "no data" — that blocks every future metric,
  including S8's, and is fixed here. Conversion rate itself is deferred: a later
  session emits it cheaply once a consumer exists.
- 2026-08-06 — S1 — **a deliberate fold change ships as a RED code commit
  followed by its re-baseline commit.** The policy requires the re-baseline to
  be isolated in its own commit, so the commit that changes the fold necessarily
  reds the corpora until the next one lands. That transient red is the designed
  cost of isolation, not an accident: the alternative — one commit carrying both
  — is exactly the mixing the policy exists to prevent, and is what `1f56bd5e`
  did. Reviewers should read the pair, and `git bisect` over an engine fold
  change should expect it.
- 2026-08-06 — S1 — **slimming needed THREE commits, and the order is forced.**
  The equivalence suites compare a slim corpus against a full one and read the
  full one from disk; once the committed corpora are slim, that reads the slim
  corpus twice, compares it with itself and asserts nothing **while staying
  green**. `unslimCorpus` derives the full form by re-folding the stored ledger
  — an identity on a corpus that is already full, so the harness lands and is
  green BEFORE the corpora move; the strict "the committed file IS the canonical
  slim form" assertion is false until they have moved, so it trails them.
  Harness (`ffe1260c`) → corpora (`7beff7d4`) → assertion (`b182dd6d`), each
  green standing alone. Recorded because the obvious two-commit split is
  circular and the discovery cost a full re-baseline cycle.
- 2026-08-06 — S1 — corpus slimming shipped: **4,507,821 → 1,746,013 bytes
  (−61.3%)**, `changedStates=0` and `eventsIdentical=true` on all eleven, and
  `schema:snapshot` reports 0 written / 11 already current — the shape-growth
  anchor clause held, so no committed snapshot moved.
- 2026-08-06 — S1 — **`EXTEND_GOLDEN=1` stays OUTSIDE the clean-tree guard, and
  that is deliberate.** Review flagged it as the one corpus-write path the guard
  does not cover. Not changing it: an extension is run precisely BECAUSE a new
  event type or optional field was just added, so the working tree legitimately
  holds that code change. Requiring a clean tree would make the sanctioned
  additive path unusable, and the pressure would go straight back to
  `UPDATE_GOLDEN=1`, which is the thing being prevented. The guard covers the
  two modes that REWRITE recorded states; extension only appends, and
  `golden.test.ts` asserts every pre-existing stream survives byte for byte.
  Recorded so a later session does not "close the hole" and break coverage work.
- 2026-08-06 — S1 — **`Cfg.overtime.skaters` is DROPPED, not implemented — the
  FOURTH false premise in #429.** The row reads "dead config, wire it up". The
  config is indeed dead, but `strength.{base,min}` has exactly one production
  reader — `strengthChip` at `kernel.ts:1481`, inside `summary()` — so it is a
  display projection, not the fold, and would have redded no corpus in either
  direction. Worse, the obvious fix is actively destructive: icehockey is
  `strength: {base: 5, min: 3}` against `overtime.skaters: 3`, and `strengthOf`
  floors at `min`, so swapping the OT base makes base === min, both sides sit at
  base, and `strengthChip` returns **null** — the powerplay chip disappears.
  Measured on both sports (icehockey 5v4/5v3 → null/null; hockey `fih-detail`
  11v10/11v9 → null/null). `icehockey/DOMAIN.md:64` already said all of this and
  was correct; the brief told an agent to update it as stale.
  The correct shape is side-relative per NHL 84.4 — the NON-offending team gains
  a skater — as `strength(X) = overtime.skaters + max(0, short(opponent) −
  short(X))`, which is the only form that also gets coincidental penalties right
  (one each cancels to 3-on-3; a flat "gain per opponent penalty" gives 4-on-4).
  It must be gated per sport: FIH cards REDUCE the offender and nobody gains, so
  the shared period kernel cannot apply it unconditionally. NOT implemented —
  the owner has not ruled on it, and no corpus can witness it either way (all 36
  period streams end `phase: "done"` and the corpus stores only the final
  state's summary), so it would ship on unit tests alone.
- 2026-08-06 — S1 — **the "35 OT-with-penalty states" figure recorded above is
  WRONG.** Measured over the restored full corpus it is **3**, on streams 3, 4
  and 13. Related readings, so the next reader stops re-deriving them: states
  with an OT phase at all = 6 (streams 3, 4, 12, 13); `asOf` in OT = 3. The
  earlier "two states" in `DOMAIN.md:64` was also wrong. The stream list was
  always right; only the counts were invented. Both wrong numbers are now named
  in the DOMAIN row itself.
- 2026-08-06 — S1 — **the GWS +1 is ice-hockey-only, by design.** Awarding it in
  the shared period kernel would double-count against FIH, which already pays
  for a shoot-out win in points (`hockey.ts:103`, `fih-shootout`
  `shootoutWin: 2` = draw 1 + 1) — the credit would then land in goal
  difference, the FIH cascade's second key. Football records the same convention
  (`4 — 4 (5–3 pens)` at `gd 0`). Gated on `PeriodPreset.shootoutWinnerGoal`,
  omitted meaning off. `hockey/DOMAIN.md:67` records the divergence as
  deliberate so a later session does not "fix" it.
- 2026-08-06 — S2 — **powerplay conversion is DEFERRED for want of a
  DENOMINATOR, not for want of a consumer.** Penalty-shot (IIHF) and
  penalty-corner / stroke (FIH) conversion both ship this session, because
  `State.setPieces[side][kind]` already records numerator and denominator.
  Powerplay does not: the numerator is `kindCounts[side].pp`, but the
  denominator is man-advantage OPPORTUNITIES, which is not a count of penalties.
  Coincidental penalties cancel and overlapping ones collapse into a single
  opportunity, so deriving it needs interval arithmetic over
  `startedAt`/`expiresAt` — i.e. STAMPED penalties. Only **3 of 21** hockey
  streams and **2 of 15** icehockey streams carry a stamped `suspension.start`,
  so for the overwhelming majority of recorded fixtures the intervals do not
  exist and any figure would be synthesised. Do NOT approximate it with a raw
  penalty count: that reports 4-on-4 coincidentals as two powerplays and reads
  as data rather than as a guess. Revisit when stamped penalties are the norm.
- 2026-08-06 — S2 — **an optional field folded into a two-counter tally was a
  silent-0 defect one level BELOW the one #429 fixed.** `PeriodSetPiece.outcome`
  is optional, and an attempt the scorer never resolved folded to exactly the
  numbers a recorded MISS folds to — 1 of 9 hockey and 1 of 6 icehockey recorded
  set pieces hit it. So `scored / awarded` was dragged toward zero by missing
  data, invisibly. Fixed ADDITIVELY with a third counter, `resolved`: `outcome`
  stays optional (requiring it is a schema narrowing that would stop every
  already-recorded event without one from parsing), `awarded − resolved` is the
  visible unknown, and a rate is `scored / resolved`. The general lesson is
  worth more than the fix: #429 taught the RANKING layer to tell "no data" from
  a recorded zero, and that is only ever as good as the tallies feeding it.
  Check the fold before trusting the comparator.
- 2026-08-06 — S2 — **`unslimCorpus` must NEVER be used to compare two versions
  of the engine.** It re-folds the stored ledger with CURRENT code, so
  `corpusStateDiff(unslimCorpus(before), unslimCorpus(after))` compares a thing
  with itself: it reported `changedStates: 0` for a change whose real footprint
  was 39 full states and 51 digests across 7 streams. Same failure class as the
  slimming defect it was written to recover from, and unguardable — a wrong `0`
  looks exactly like a right one. Compare the RECORDED BYTES: loop
  `verifyStream` over `readCorpus(key).streams`. Now in the docstring and in
  `GOLDEN-POLICY.md` §2.
- 2026-08-06 — S2 — **`rtk` swallows the `corpusStateDiff` printout, which IS
  clause 2 of the re-baseline policy.** A `REBASELINE_GOLDEN=1` run reports
  `11 passed` and nothing else, so the state diff a reviewer is required to read
  never appears — and the re-baseline looks clean because it looks like nothing
  at all. Reconstruct from the bytes: diff each written corpus against
  `git show HEAD:<path>` per stream, checking `events` / `lineups` / `configs`
  identical and which of `states` / `summary` / `outcome` / `deltas` moved. A
  policy defeated by a wrapper printing a reassuring number is the same failure
  class as the two entries above.
- 2026-08-06 — **label note** — the six entries above stamped `S2` are S1 pass-4
  work (powerplay conversion, the `resolved` set-piece counter, `unslimCorpus`),
  not S2/#430. S2/#430 is the fidelity-tier-4 decision and its entries are
  stamped `S2/#430`. Recorded rather than rewritten so shas keep matching.
- 2026-08-06 — S2/#430 — **the tier fidelity ladder already exists, is already four
  values, and its entitlement seam is already open. Three of the brief's
  premises are false.** Measured against `main`:
  (a) `FidelityTier` at `sport/module.ts:63-67` is `{tier, eventTypes,
  entitlement?}` and `tier` is `z.union([z.literal(0..3)])` — a **numeric 0–3
  fidelity ladder**, comment `:61` "the four-tier granularity ladder". Not the
  `quick|standard|full` triple S6's brief §1 names. `fidelityTiers` is already
  an **array**, ordered by that number — the brief's "is the ordering a list
  rather than a triple" is already answered yes.
  (b) the entitlement hook already exists and is already generic:
  `FidelityTier.entitlement` (`:66`) is an optional FeatureKey, and
  `apps/web/src/server/usecases/fidelity.ts:17-29` `requiredFeatureForEvent`
  derives the gate from the module's own declaration by numeric compare
  (`t.tier < lowest.tier`, free floor `tier <= 1`). A row declaring `tier: 4`
  flows through it **unchanged**.
  (c) #430's "`CarromStrike` … with `apply()` rejecting it" is false in detail,
  and so is the code comment asserting it (`carrom.ts:114-116`). There is **no
  rejecting arm**: `CarromStrike` (`:117-123`) is simply absent from `CarromEv`
  (`:125`), so `eventSchema` 422s `carrom.strike` structurally. Consequence that
  matters: it is not an `eventSchema` union branch, so S6 acceptance (a) "every
  branch reachable from some action" never sees it — the pattern costs
  conformance nothing and needs no exemption list.
- 2026-08-06 — S2/#430 — **cost of the open seam, quantified.** Adding a fifth
  band today is **one line in one file**: `z.literal(4)` at `module.ts:64`.
  Nothing else is code — `fidelity.ts` is numeric, `entitlement-domains.ts:29-37`
  is a data row owed whenever the feature ships, per-sport `fidelityTiers` are
  data rows. Further: **not every deferred row needs a fifth band.** The fidelity ladder's
  cross-sport meaning is the paywall boundary (0/1 free, 2/3 paid), granularity
  is per-sport, and `carrom.ts:707-712` declares only tiers 0/1 with **2/3
  already reserved for strike-by-strike**. Only sports whose tier 3 is already
  spent on attributed timeline (icehockey, football) would need a 4.
  The expensive path is created by S6, not by today's code: if S6 mints a second
  `quick|standard|full` string vocabulary alongside the numeric fidelity ladder, tier 4
  then costs the new member **plus** the mapping between two fidelity ladders, 11
  `padSpec` declarations, S6's hardcoded two-pair nesting assertion, S10's
  renderer and S11's skins. **Ruling asked for: S6 reuses `FidelityTier.tier`
  (0–3) and mints no second vocabulary.** Cost now 0 files; cost of not doing it
  is paid three sessions later.
  Also asked: **leave the union sealed.** An open enum would let a module
  declare tier 7 and silently create a paid band nothing gates — the sealed
  union is the only check that a tier number means something to the paywall.
- 2026-08-06 — S2/#430 — **the plus/minus trap is a fold rule, and it is the
  same defect class this programme has now hit twice**: `metricOf` returning a
  silent 0 at the ranking layer (S1), and optional `PeriodSetPiece.outcome`
  folding to exactly what a recorded miss folds to (S1 pass 4). Plus/minus is
  worse than both — a half-entered on-ice set can flip the **sign**, not just
  shrink the magnitude. Proposed standing invariant, independent of the tier
  verdict: *a derived statistic whose denominator depends on data the scorer may
  omit carries its own coverage counter, and is not emitted at all for a match
  whose coverage is partial.* Enforced at **match** granularity, because S9's
  career rollup summing complete and incomplete matches together is silently
  wrong in a way no per-event check can see.
- 2026-08-06 — S2/#430 — **OWNER RULING (verbatim): "Keep the one, replicate for
  none."** `CarromStrike` stays. It costs conformance nothing — it is not an
  `eventSchema` union branch, so S6 acceptance (a) never sees it and no
  exemption list is needed. The other nine deferred rows get **no typed
  placeholder and no reserved entitlement key**; their reasoning already lives
  in the `DOMAIN.md` dossiers in the sports' own words. S6 corrects the stale
  comment at `carrom.ts:114-116`, which claims `apply()` rejects `carrom.strike`
  — it does not; the type is simply absent from `CarromEv` (`:125`). That stale
  comment is itself the argument against nine more of them.
- 2026-08-06 — S2/#430 — **OWNER RULING (verbatim): "Yes, standing invariant,
  match granularity."** Standing engine invariant, in force now and not
  contingent on any tier-4 verdict: *a derived statistic whose denominator
  depends on data the scorer may omit carries its own coverage counter, and is
  **not emitted at all** for a match whose coverage is partial.* Enforced at
  **match** granularity, because S9's career rollup summing complete and
  incomplete matches together is wrong in a way no per-event check can see.
  Third instance of this defect class in the programme — `metricOf` silent-0 at
  the ranking layer, optional `PeriodSetPiece.outcome` folding to exactly what a
  recorded miss folds to, and now plus/minus, which is worse than both because a
  half-entered on-ice set can flip the **sign**. S6 carries it as a constraint;
  S8 and S9 inherit it.
- 2026-08-06 — S2/#430 — **S6 reuses the numeric fidelity ladder; no second vocabulary.**
  Taken in-session as a routine call, not escalated — the owner's answer was
  that the question was not clear, and it is not a tier-4 question at all. The
  engine already names granularity `0..3` (`module.ts:64`) and the paywall reads
  that number (`fidelity.ts:17-29`). S6's brief §1 would have minted
  `quick|standard|full` as a second name for the same idea, requiring a
  permanent translation table whose drift means a free org pressing a paid
  button or a paying org locked out of one. `padSpec` tiers ARE
  `FidelityTier.tier`; the nesting assertion iterates adjacent members of the
  declared array rather than asserting two hardcoded pairs. Reversible in S6's
  diff if the owner disagrees on sight.
- 2026-08-06 — S2/#430 — **THE FIFTH FALSE PREMISE, and it dissolves the whole
  question: tier 3 is not spent, it is an EMPTY DUPLICATE of tier 2 in 7 of 8
  module files.** Measured on `main` @ `6eaea4fa`:
  `football.ts:2372…` declares tier 2 and tier 3 with byte-identical
  `eventTypes` and the same `scoring.match_timeline`; `setbased/kernel.ts:912`,
  `nested/kernel.ts:1202` and `period/kernel.ts:1310` each declare 2 and 3 as
  the same array with the same entitlement; `carrom.ts:709`, `generic.ts:362`
  and `boardgame.ts:503` stop at tier 1 entirely. **Cricket alone is a real
  four-band fidelity ladder** — `cricket.ts:2392-2401`, tier 2 `cricket.player.line` →
  `stats.player`, tier 3 `cricket.ball`/`cricket.retire` →
  `scoring.ball_by_ball`. So #430's "tier 3 tops out at attributed timeline
  scoring" is true only because tier 3 was left as a copy; tier 3 is not full,
  it is unoccupied.
  Consequence: **we already shipped the "statistician terminal" — for cricket.**
  Ball-by-ball is ~250 deliveries a match with runs, extras, wicket type and
  fielder attribution, entered by a dedicated scorer sitting through the
  innings. Same operator profile, same data volume and the same paid band as an
  ice-hockey shot stream. `apps/web/src/components/v2/pads/cricket-pad.tsx` is
  23.8K, the largest pad in the repo, and the hash-chained `score_events`
  substrate carries that volume today. Tier 4 was never a second product; it was
  an unbuilt tier 3 in every sport but the one that built it.
- 2026-08-06 — S2/#430 — **RULING (delegated to the session by the owner: "for
  fidelity ladder close you can decide"): the fidelity ladder CLOSES at 0–3. There will be no
  `z.literal(4)`.** `sport/module.ts:64` stays sealed exactly as it stands —
  **zero lines change, now or later.** The deferred rows are re-classified, not
  deferred to a fifth band:
  - **8 of 10 are tier-3 work**, landed by SPLITTING each kernel's duplicated
    2/3 — tier 2 keeps the attributed timeline, tier 3 becomes the per-event
    stream. That is exactly cricket's shape, so it is a proven pattern rather
    than a new one. Rows: shots/saves/faceoffs (icehockey), circle penetrations
    (hockey), attack-block-dig (volleyball), 1st-vs-2nd serve + rally length
    (tennis/badminton/tabletennis), strike-by-strike (carrom/generic).
    Effort, **after S10 ships**, per kernel FAMILY not per sport (`period`
    covers hockey+icehockey, `setbased` covers volleyball+badminton+tabletennis):
    new event type = 5 edits (envelope, payload union, `apply`, `eventSchema`,
    generator) + fold counters + the tier split + `DOMAIN.md` +
    `EXTEND_GOLDEN=1`; one entitlement key across `entitlement-domains.ts` and
    `feature-copy.ts` + plan map (data rows); a `padSpec` block — which is the
    entire point of S6/S10/S11, after which a fidelity band is a DECLARATION,
    not a hand-written pad; 4 locales. **≈4 sessions covers all eight**, each
    about the size of a W4 dossier.
  - **2 of 10 are genuinely different** and are NOT tiers. (i) plus/minus + the
    on-ice set is a continuous LINEUP-STATE problem, not an event problem — you
    cannot type 12 ids per goal, you track every line change (~60–80 more events
    a match) and reconstruct the on-ice set at each goal. New state machine in
    the period kernel plus an undesigned pad affordance; the coverage invariant
    ruled above bites hardest here. Own wave if ever. (ii) boardgame PGN needs
    the blob decision — `score_events` is hash-chained per event and movetext is
    one growing opaque string — and validating SAN is writing a chess engine.
  #430 stays open as the record for those two rows; **no new issue**.
- 2026-08-06 — S2/#430 — **the duplicate 2/3 is NOT a billing bug** — checked
  before asserting it. `requiredFeatureForEvent` (`fidelity.ts:22-28`) takes the
  LOWEST tier accepting a type, so a duplicated pair gates identically either
  way. Whether the fidelity picker presents a dead choice to the user is
  UNVERIFIED; S6 checks it when it declares `padSpec`.
- 2026-08-06 — S2/#430 — **there is NO spec and NO prompt for the tier-3
  extension, and the fidelity ladder itself has no written spec at all.** Three findings:
  (a) no prompt file exists for it — `carrom/DOMAIN.md:48` says "The fine tier is
  its own prompt", and that prompt was never written. The S1–S13 / L1–L3
  programme does not contain it: S6 is the contract, S8 is player stats, S10/S11
  are renderer and skins — **none of them add an event type**, which is what
  every tier-3 row needs.
  (b) **"doc 14" does not exist.** The engine cites it as the fidelity ladder's
  specification in three places — `sport/module.ts:61-62` ("doc 14 §1–2"),
  `fidelity.ts:1` ("doc 14 §4, doc 10 §2 rule 2"), `carrom.ts:113-116` ("doc
  10") — and there is no such file anywhere under `docs/`. The fidelity ladder's only
  specification is the code. That is precisely how "tier 3 tops out at
  attributed timeline scoring" went unchallenged into eight DOMAIN dossiers.
  (c) the **design of record was the SOURCE of the `quick|standard|full` error**,
  not S6's brief — `2026-08-03-scoringpad-v2-design.md:195-197`, and its
  conformance clause (d) at `:203`. Fixing S6's prompt alone was insufficient
  because S6 is instructed to read that design. Both corrected in place this
  session, marked SUPERSEDED with a pointer here rather than deleted.
  What DOES exist as the record: the ten refusal rows in the sports' own
  `DOMAIN.md` dossiers (the real content), #430's body, and this log.
- 2026-08-06 — S2/#430 — **terminology: never write a bare "ladder" in this
  programme.** The word carries FIVE unrelated meanings in this repo and one of
  them is an exact enum value: (1) `ladder` is a literal `StageKind` — a
  competition format (`design.md:47-48`, `americano`/`ladder`/`page_playoff`,
  and `api/v1/stages/[id]/challenges/route.ts`); (2) `stepladder` is a bracket
  kind (`BRACKET_KINDS`, `.../[divisionSlug]/page.tsx:51`); (3) the Stripe
  **pricing** ladder — graduated price *tiers*, ~26 uses across
  `stripe-sync.test.ts` and `pricing/page.tsx`, and it says "tier" too, so "tier
  ladder" in this repo usually means BILLING; (4) the IIHF discipline
  escalation ladder (`S06-416-w5-padspec.md:98`); (5) the fidelity tier scale,
  which is the only one this programme means. Always write **"fidelity ladder"**
  or just **"fidelity tiers (0–3)"**. Every occurrence S2 authored across
  `_INDEX.md`, `S06-416-w5-padspec.md` and `2026-08-03-scoringpad-v2-design.md`
  was qualified this session; the bare ones that remain in those files are
  pre-existing and mean (1) or (4).
- 2026-08-06 — S2/#430 — **SIXTH false premise, and it lands ON S6: the tier
  model is internally inconsistent, and S6's conformance criterion (d) "tiers
  nest" WOULD FAIL on cricket today.** `fidelityTiers[].eventTypes` carries two
  incompatible mental models. Football and all three kernels treat it as
  **cumulative bands** — football t2 repeats every t1 type and adds card/sub/
  penalty/sinbin. Cricket treats it as a **per-event lookup** — t1 is the
  innings context, t2 is `["cricket.player.line"]` ALONE, t3 is
  `["cricket.ball","cricket.superover.ball","cricket.retire"]`. So cricket's
  tiers **do not nest**: t1 ⊄ t2. It works only because `requiredFeatureForEvent`
  takes lowest-tier-wins. The one sport that got the ladder right is the one an
  "assert the tiers nest" gate would red.
  Root cause is the same absence that produced the duplicate 2/3: **what a tier
  MEANS is declared nowhere.** "doc 14" is cited three times in engine comments
  and does not exist in the repo, so each sport author invented a reading.
- 2026-08-06 — S2/#430 — **OWNER RULING: redesign the fidelity model, in S6.**
  Declared semantics cross-sport + one band per event type, replacing the
  cumulative `eventTypes` lists:
  ```ts
  export const FIDELITY = { 0:"result", 1:"card", 2:"timeline", 3:"detail" } as const;
  // per module: one band per event type, no repetition
  fidelity: { "cricket.innings.summary":0, "cricket.toss":1,
              "cricket.player.line":2, "cricket.ball":3 },
  fidelityEntitlements: { 2:"stats.player", 3:"scoring.ball_by_ball" },
  ```
  What it buys: (a) **nesting becomes structural** — a tier-N scorer emits every
  band ≤ N by construction, so criterion (d) stops being a test that can fail
  and becomes a property that cannot; (b) **"no tier 3" is the absence of a
  band-3 event**, not a duplicate row — the bug that started S2 becomes
  unrepresentable; (c) the hardcoded free floor `tier <= 1` (`fidelity.ts:27`)
  becomes "bands 0 and 1 declare no entitlement"; (d) the ladder's meaning is
  written down in the one place that cannot drift from the code — the missing
  doc 14, as code.
  **Lands in S6** because S6 seals the tier model into `PadSpec`; doing it later
  means S6/S8/S10/S11 build on the broken model and get rewritten. Blast radius
  is 11 modules + `SportInfo` (`fixture-console.tsx:140`) +
  `requiredFeatureForEvent` + `testkit/golden.ts:282` +
  `conformance/discipline.test.ts:28`. Mechanical; no prod data; modules stay
  `1.0.0`. Grows S6 by roughly a third.
- 2026-08-09 — S3/#426 — **scout re-pin: four of the brief's structural
  assumptions are wrong, and they make scope 2 bigger, not smaller.** Measured on
  `main` @ `0c8eb752`:
  (a) `squadFromLineup` is **football-private** (`football.ts:1347`), not a shared
  helper. `positionKey` is dropped one line later at `:1351`
  (`.map((slot) => slot.personId)`), and the return at `:1356` keeps person-id
  arrays only.
  (b) `maxSubs` is **football-private too** — `Cfg.maxSubs` at `football.ts:83`,
  exactly one reader at `:918-921` comparing against `offUsed.length`. There is
  no shared substitution concept anywhere in the engine to hang an exemption on.
  (c) **No family kernel State holds a squad at all.** `setbased/kernel.ts:280-299`
  and `nested/kernel.ts:345-369` carry `entrants:{home,away}` as entrant ids only;
  `period/kernel.ts:386-410` has no entrant/squad/roster field whatsoever. So
  "positions survive `init` into `State`" is **new state in three kernels**, not a
  plumbing fix in one module.
  (d) hockey has **no `positionsFor` hook** — `hockey.ts:15` hardcodes
  `{key:"GK",min:1,max:1}` and grep for a relaxation hook returns zero hits. The
  brief's "check whether `positionsFor(cfg)` already relaxes it" is answered: it
  does not exist for hockey. `positionsFor` is declared at `sport/module.ts:91`
  (optional hook), implemented at `football.ts:1338` and `period/kernel.ts:1545`,
  reached via `sport/catalog.ts:55` `resolvePositions`.
  (e) no pair/partner/declared-order field exists in any Lineup or State; the
  racquet dossiers mark it `deferred` (`DOMAIN.tabletennis.md:39,77`).
  Pattern to copy for a new core event (the 5 edits): shape at
  `core/events.ts:62`/`:66`, `CORE_EVENT_SCHEMAS` keys `:76-77`, dispatch `:113`,
  fold branches `:518`/`:531`, generator `testkit/stoppages.ts:97`.
- 2026-08-09 — S3/#426 — **OWNER RULING 1 — a squad MAY grow mid-fixture, gated
  per variant in cfg.** Growth is structurally representable: a `core.lineup.*`
  event carries a full `LineupSlot` for a person not named at start, and the
  squad entry records provenance (`named` | `added`) so S9 can tell an original
  team-sheet member from a mid-fixture addition. Whether growth is *permitted* is
  a cfg knob per sport/variant, **default off**. Reason: only cricket's
  concussion/COVID replacement genuinely comes from outside the team sheet —
  football, both hockey codes and volleyball all substitute from pre-named
  benches, so those variants keep it off and lose nothing, while a schema that
  forbids growth outright leaves the cricket row permanently unclosable and
  pushes club scorers to fabricate placeholder persons (which corrupts S9 worse
  than growth does). Engine records; the competition layer still owns
  registration eligibility.
- 2026-08-09 — S3/#426 — **OWNER RULING 2 — re-entry is a cfg knob:
  `none | once | unlimited`, per sport, per variant.** No global answer is
  correct: football Law 3.3 is no-return (with grassroots / small-sided
  dispensations that ARE rolling), FIH hockey and ice hockey are unlimited
  rolling substitution, FIVB volleyball 15.6 is **once and only back to the
  position left** (so volleyball is `once` + a position lock), cricket lets a
  retired-hurt batter resume while a concussion replacement is permanent. A
  single global rule breaks at least four of the nine deferred rows. A violating
  re-entry **returns a rejection, never throws** — a cfg-derived throw inside a
  fold permanently bricks recorded fixtures (found 6× in W4a).
- 2026-08-09 — S3/#426 — **OWNER RULING 3 — a coach/team official is a `role` on
  the lineup slot, and stat projections filter on it.** `LineupSlot.role:
  'player' | 'coach' | 'staff'`, default `'player'`; squad and stat projections
  keep only `role === 'player'`, so a card to a coach records against the person
  but never enters a playing record. Additive, one optional field, engine-only.
  **Input to S4** (#428, offence taxonomies) — S4 must not re-decide this.
  Carried caveat, NOT fixed here: `persons.lane` is
  `check (lane in ('player','official'))` (`V348__persons_lane_and_registration_user.sql:9`)
  where `'official'` means a **match** official (referee/umpire) per that
  migration's own comment. A team coach has no value there, so a DB lane
  extension is owed — out of scope for an engine-only session, flagged for S4.
- 2026-08-09 — S3/#426 — **pass-B pin table (scout, `main` @ `0c8eb752`), plus two
  findings that change what "closed" means for two of the nine rows.**
  `init(cfg, lineups)` implementations: football `football.ts:1422`, cricket
  `cricket.ts:2035`, carrom `carrom.ts:537`, boardgame `boardgame.ts:351`,
  generic `generic.ts:222` own theirs; the other six delegate to a kernel —
  hockey + icehockey via `period/kernel.ts:1557`, volleyball + badminton +
  tabletennis via `setbased/kernel.ts:950`, tennis via `nested/kernel.ts:1238`.
  So six of eleven sports are covered by three kernel edits.
  Football substitution: fold case `:1373`, second fold pass `:1985`, `offUsed`
  built `:971`, cap check `:918` (`!rolling && offUsed.length >= maxSubs`).
  Position catalogs: hockey `hockey.ts:15`, icehockey `icehockey.ts:13` (GK
  `:15`), football `football.ts:1314` (GK `:1316`). Cricket retire fold
  `cricket.ts:2744`. Pair entrant kinds: tennis `tennis.ts:46`, badminton
  `setbased/badminton.ts:43`, tabletennis `setbased/tabletennis.ts:44`; serve
  decisions `nested/kernel.ts:594` (TB first server) and `setbased/kernel.ts:101`
  (a `server` scorebook field with **no rotation logic**).
  Deferred rows: cricket concussion `cricket/DOMAIN.md:112`; football keeper
  `football/DOMAIN.md:129` (a numbered finding, not a table row) and concussion
  sub `:69`; hockey no-keeper `hockey/DOMAIN.md:69`; icehockey pulled goalie
  `icehockey/DOMAIN.md:58`; volleyball libero `setbased/DOMAIN.volleyball.md:42`;
  tennis doubles order `tennis/DOMAIN.md:64`; tabletennis `setbased/DOMAIN.tabletennis.md:39`.
  **FINDING A — football folds `football.sub` in TWO places** (`:1373` init-time
  validation and `:1985` the replay fold). That is this repo's recurring
  placer/verifier fork, hit 3× in one earlier session. The substitution cap and
  the re-entry rule must be ONE shared function called from both sides, and a
  test must assert both sides return the same number, or the two will diverge.
  **FINDING B — `emptyNet` already exists and does NOT close the pulled-goalie
  row.** `period/kernel.ts:217` declares the zod field and `icehockey.ts:75`
  reads it (`agg:"count", when: p.emptyNet === true`). It is a property of a
  GOAL, not a statement about on-ice personnel, which is exactly what the
  deferred row asks for. A pass that points at `emptyNet` and calls the row
  closed has closed nothing.
  Also: volleyball's **libero is already a role catalog entry**
  (`setbased/volleyball.ts:24`), so a lineup can already name one — only the
  replacement EVENT is missing. And cricket has **no substitute-fielder or
  12th-man concept at all** (zero grep hits), so its concussion replacement is
  net-new, not an extension.
- 2026-08-09 — S3/#426 — **pass A (core lineup model) landed: `8f6987f4` + `b02e0215`.**
  Gate `{total:2917, passed:2916, failed:0, failedSuites:0, pending:1}`,
  `tsc -p packages/engine` EXIT=0, `schema:snapshot` 11/11 unchanged / 0 written,
  zero goldens touched. New: `core/lineup.ts`, `core/lineup.test.ts` (39),
  `core/lineup.events.test.ts` (29); touched `core/events.ts`, `core/types.ts`,
  `core/index.ts`, `sport/module.ts`.
  **Design ruling — FIVE SIBLING EVENT TYPES, not one type with a discriminated
  `kind`.** Every consumer in this engine keys on the exact envelope type string
  (`CORE_EVENT_SCHEMAS`, `DURING_STOPPAGE`, `postDecisionTypes`,
  `fidelityTiers[].eventTypes`, and the entitlement gate), so a nested `kind`
  would be invisible to all of them — and a sport could not tier substitutions
  separately from position changes, which S6's fidelity model requires. Sibling
  `strictObject`s also carry no `z.union` first-match hazard; proved anyway with
  a full 5×5 cross-parse matrix, which is the swallowed-sibling test this
  session owed.
  Three design deviations from the brief, all correct and all kept: (i) a
  `lineupPolicy?(cfg)` module hook was added — the brief named only `onLineup`,
  but ruling 2 makes the policy cfg-derived and cfg belongs to the module;
  (ii) `onLineup` is called once at `init` too, so a module's `State` and the
  kernel's `SquadState` are never two constructions of one fact; (iii) the
  strict/replay seam is a single `REPLAY_LINEUP_POLICY` constant (every knob
  maximally permissive) rather than per-check `if (strict)`, so **no cfg-derived
  condition can refuse on replay at all** — structurally, not by discipline.
  That is the strongest available answer to the W4a brick-the-fixture defect.
- 2026-08-09 — S3/#426 — **pass A review: 7 of 9 clean, 2 live.** Confirmed by
  the reviewer against the diff: no `throw` on any cfg-derived condition (every
  refusal is a returned value; `reduceLineupEvent` contains no `throw` at all);
  the refusal tests DO run through `foldMatchWithStoppage`, not the bare reducer
  (`lineup.events.test.ts:303-352`), so `REPLAY_LINEUP_POLICY` has not made the
  strict path vacuous; the keeper test asserts IDENTITY at init
  (`lineup.test.ts:124`, `personsAtPosition → ["h-gk"]`) and after a keeper
  change (`lineup.events.test.ts:239`, `["h-gk","h-sub-gk"]`); ruling 3 is
  genuinely enforced, not merely carried — `playingSquad`/`onFieldPersons`/
  `personsAtPosition` (`lineup.ts:312-336`) filter `role === "player"` and no
  other reader bypasses them; schemas are purely additive (`role`/`pairOrder`
  optional, no `.default()`); all five types present at every required site.
  Open: (a) HIGH — the model is wired in the kernel but **unreachable from any
  real match** until a sport declares `lineupPolicy`/`onLineup`; that is pass B.
  (b) MED — `provenance:"added"` is proven only through the bare reducer, never
  through a full fold; assigned to pass B lane 1.
- 2026-08-09 — S3/#426 — **`football.sub` MUST NOT be deleted, and that bounds
  the football cutover.** Recorded golden corpora contain `football.sub` events,
  so removing or narrowing the type stops them parsing and fails golden replay —
  which this session's acceptance forbids. The cutover is therefore: the event
  type and payload stay exactly as they are, and only what its FOLD calls
  changes, to the shared `reduceLineupEvent`. Recorded because "retire the
  private implementation" reads as "delete the event" and would have cost a
  re-baseline the policy does not sanction here.
- 2026-08-09 — S3/#426 — **OWNER RULING 4 — fix the vacuous i18n gate and add
  the copy now, widening this session into `apps/web` + the 4 dictionaries.**
  `apps/web` `event-copy.test.ts` seeds its core event types from `EVENT_KEY`
  itself, so adding a `core.*` event type can never red it — the five new
  `core.lineup.*` types would have shipped with no copy and nothing to catch it.
  This is the FOURTH "a test that cannot fail" defect in this programme
  (`metricOf` silent-0 at the ranking layer, optional `PeriodSetPiece.outcome`
  folding to exactly what a recorded miss folds to, `unslimCorpus` comparing a
  thing with itself). Unlike the copy, the hole affects every FUTURE core event
  type — S4 (#428) lands before S7 (#427) and would add its own types through
  the same blind gate. Fix: seed the test from the engine's authoritative type
  list, then add 5 keys × 4 locales (`en`,`es`,`fr`,`nl`, flat dotted keys).
- 2026-08-09 — S3/#426 — **engine lint was 18 errors on `main` before this
  branch**, all in `packages/engine/scripts/repair-placement-harness.ts`, all
  downstream of two untyped `JSON.parse` calls (`no-unsafe-assignment` /
  `no-unsafe-member-access` / `no-unsafe-argument`). Measured with
  `cd packages/engine && npx eslint` — the root lint task does NOT cover
  `packages/engine`, and running eslint from the repo root against that path
  exits 2 with "Oops! Something went wrong!", which reads as a broken config
  rather than as the wrong invocation. Fixed inline as an unplanned fix
  (`99d47c37`) because the ship checklist requires `✖ 0 problems`: the payloads
  are now named via indexed access on `RepairInput`, so the harness cannot drift
  from the production shapes it exists to compare Placement against. Engine lint on
  the branch is now EXIT=0 with zero output.
- 2026-08-09 — S3/#426 — **pass B landed as three directory-disjoint lanes
  (football / three kernels + six sports / cricket), and ALL THREE died to the
  600s subagent watchdog.** Nothing was lost — every lane had committed before
  it stalled, `git status --porcelain` was empty and no golden was dirty — but
  the cause is worth naming: three opus implementers plus a full gate on one
  machine starves the streams. Third occurrence in this repo. The recovery is to
  verify the tree yourself (`git log`, `git status`, then the gate) rather than
  to re-dispatch; a re-dispatch would have redone committed work.
- 2026-08-09 — S3/#426 — **an unpinned config knob is a gate that cannot fail,
  and the obvious fix is INERT.** The new cfg knobs (football `concussionSubs`;
  cricket `lineupChanges.{maxSubs,concussionReplacements,reentry}`) redded
  `golden.test.ts`'s coverage clause: "no recorded config sets them and no
  frozen state carries them, so narrowing, renaming or reshaping those knobs
  would not red anything". Correct gate, and the same defect class this
  programme keeps finding.
  **The trap:** adding the knobs to the EXISTING coverage config entries
  (football `lawful`, cricket `reviewed`) pins nothing. `coverageCandidates`
  (`testkit/golden.ts:938`) does `if (known.has(name)) continue;` — a config
  NAME already present in `corpus.configs` is skipped outright, so the scan
  never reaches the edited object. Measured: `EXTEND_GOLDEN=1` reported
  `[extend] cricket: +0 streams [] gained [] stillMissing ["cfg:lineupChanges",…]`
  and the coverage clause stayed red with byte-identical wording. A NEW name is
  required. Shipped as `football.concussed` and `cricket.mutable`, both with
  `maxSubs` deliberately LOW against a non-zero exemption so the cap and the
  exemption disagree inside the recorded stream instead of agreeing trivially.
  Second trap, cheap: cricket's extend takes ~11.6s against vitest's 5000ms
  default, so an `EXTEND_GOLDEN=1` run needs `--testTimeout`. The timeout reads
  as a corpus failure.
- 2026-08-09 — S3/#426 — **the corpus extension, verified against RECORDED BYTES
  (`e3d2b1cf`).** Append-only, not a re-baseline: cricket 27 → 28 streams,
  football 25 → 26, **every pre-existing stream byte-identical**, pre-existing
  configs unchanged, exactly one new config each. Checked by diffing
  `.streams[0:n]` against `git show HEAD:<path>` per S2's ruling — the harness's
  own summary is not evidence, and `rtk` swallows the printout anyway.
  Nine other corpora untouched. `schema:snapshot`: 11 snapshots, 0 written,
  11 already current.
- 2026-08-09 — S3/#426 — **the adoption layer, and why `State.squads` is
  deliberately ABSENT on most fixtures.** `sports/squad-state.ts` is a shared
  adopter, not a second reducer — it re-derives no membership, no substitution
  count, no re-entry. Its rule: PERSIST ONLY WHEN THE SNAPSHOT SAYS SOMETHING
  THE TEAM SHEET DOES NOT, i.e. a `core.lineup.*` event has been folded, or the
  sheet declares `pairOrder` or a non-`player` `role`. A declared POSITION is
  deliberately excluded, because every corpus lineup already carries it and
  treating it as new would re-baseline six sports to store what
  `initSquads(lineups)` reproduces exactly. The init handshake is a `WeakSet`
  on the object `init` returned, NOT a shape test — a shape test is wrong for
  exactly one event, and it is one both hockey codes need:
  `core.lineup.position` moves a player who never left the field and bumps no
  counter, so a "nothing has happened yet" heuristic reads it as pristine and
  the module goes on reporting the wrong keeper. Football is the exception and
  persists at `init` unconditionally, because its State already had a private
  squad field; that is why the keeper-identity criterion is met there.
- 2026-08-09 — S3/#426 — **`Cfg.goalkeeper === "optional"` already existed and
  the period kernel already honoured it — hockey just never declared the hook.**
  `period/kernel.ts:1547` on `main` reads `if (cfg.goalkeeper !== "optional" ||
  keeper === undefined) return preset.positions;`, and `testkit/golden.ts`
  already pinned `goalkeeper: "optional"` for both period sports in
  `COVERAGE_CONFIG_KNOBS` (that file is unchanged by this branch). So the
  hockey dossier's "the catalog REQUIRES exactly one GK, so a side playing
  without a keeper cannot be expressed in a lineup at all" was true of
  **hockey's own catalog** (`hockey.ts:15`, `{key:"GK",min:1,max:1}`) while the
  relaxation sat one layer up, unreached. Not a false premise — a correctly
  described symptom with the cause one level higher than the dossier looked.
  Worth recording because the same shape (live mechanism, undeclared hook) is
  how `Cfg.overtime.skaters` read as dead config in S1.
- 2026-08-09 — S3/#426 — **all nine deferred rows CLOSED; a tenth found and
  correctly left open.** Each dossier row moved `deferred` → `extended` with its
  mechanism named: cricket concussion/COVID (`Cfg.lineupChanges.concussionReplacements`
  → `lineupPolicy` → `core.lineup.replacement{exemption:"concussion"}`);
  football keeper identity (`Lineup.slots[].positionKey="GK"` → `initSquads` →
  `personsAtPosition`), football keeper change without a substitution
  (`core.lineup.position{positionKey:"GK"}`), football concussion sub
  (`Cfg.concussionSubs` → `lineupPolicy().exemptions.concussion`); hockey
  no-keeper (`positionsFor(cfg)`, GK `min` → 0 when `Cfg.goalkeeper ===
  "optional"`); icehockey pulled goalie (`core.lineup.retirement`/`.substitution`/
  `.entry` → `personsAtPosition(side,"G")`); volleyball libero
  (`core.lineup.replacement{exemption:"libero"}`, `exemptUsed.libero`);
  tennis + tabletennis doubles order (`LineupSlot.pairOrder` →
  `State.squads.<side>.members[].pairOrder`, read by `expectedDoublesServer`).
  The tenth is cricket's **substitute fielder**, left `deferred` with a real
  reason rather than closed for symmetry: a substitute may field but not bat,
  bowl or keep (Law 24), so nothing on a scorecard changes — no fold-visible
  fact. The channel now exists if that ever changes.
- 2026-08-09 — S3/#426 — **acceptance evidence: ONE reducer.**
  `git grep -c "export function reduceLineupEvent"` = 1 (`core/lineup.ts`).
  Non-test callers: `core/events.ts`, `core/lineup.ts`, `football.ts`,
  `cricket.ts` — the three family kernels reach it through the core fold, so six
  sports need no call site at all. `git grep -E "subsUsed\s*(\+\+|\+ 1|>=)|offUsed\.length\s*>="`
  outside tests: **zero hits** — no sport counts substitutions privately any
  more. `football.sub` is retained deliberately (recorded goldens contain it);
  only its FOLD changed, and the dossier records both it and
  `core.lineup.substitution` routing to `reduceLineupEvent`.
- 2026-08-11 — S4/#428 — **per-sport decision table, final (copy verbatim into
  the PR body too).**

  | Sport | Field | Decision | Why |
  |---|---|---|---|
  | Football | new `offence` on `FootballPenalty` | **ADOPT** | IFAB Law 12 direct-free-kick/penalty offences: 8 closed types — `kicking`, `tripping`, `jumping_at`, `charging`, `pushing`, `striking`, `tackling`, `handball`. Short, closed, primary-source (theifab.com Law 12). Named `PenaltyOffence`, distinct from `CardReason` — different fields, different questions (not every penalty carries a card). |
  | Football | card `reason` (`CardReason`) | **Already shipped, no action** | 13-member closed enum, wired end to end since before this session. Not re-touched. |
  | Icehockey | suspension `reason` | **ADOPT** | `PeriodSuspensionReason` (shared kernel union, 23 members): IIHF's 18 named infractions + `other`. `ICEHOCKEY_SUSPENSION_REASONS` (icehockey.ts) declares the subset. Secondary IIHF rule summaries, not the primary Situation Handbook PDF. |
  | Hockey (FIH) | suspension `reason` | **ADOPT, shared kernel, gated by variant** | Same `PeriodSuspensionReason` union as icehockey (kernel schema stays ONE permissive shape — the discriminator is the envelope's event type, mirroring how `SetBasedSanctionLevel` is a shared union with per-sport mapping). `HOCKEY_SUSPENSION_REASONS` (hockey.ts) declares FIH's own smaller subset: physical-infraction core (`tripping`/`hooking`/`obstruction`/`dangerous_play`) + FIH-specific (`dissent`/`time_wasting`) + `other` — 7 of 23, deliberately smaller than and excluding every icehockey-only member (proven by a regression test, not just asserted). |
  | Tennis | code-violation `reason` | **DEFER, free text kept** | Reaffirmed. ITF/ATP/WTA top-level categories (~12-14: audible/visible obscenity, verbal/physical/ball/racket abuse, coaching, unsportsmanlike conduct, time violation, best efforts, leaving court…) vary by tour/division in exact codification and fine schedule. Researched list recorded below for a future session with a real product ask. |
  | Carrom | umpire-adjustment `reason` | **DEFER, free text kept, no code change** | Reaffirmed. Already `z.string().min(1)` (required), tied to "Laws 51/55". No well-documented closed taxonomy found for the arbiter conduct-penalty case specifically. `carrom.ts` untouched. |
  | Boardgame | — | **DEFER, no-op** | Reaffirmed. No misconduct/conduct-penalty concept exists in `boardgame.ts` at all. Consistent with #430's PARKED stance. |
  | Volleyball / Badminton / Tabletennis | `SetBasedSanction.reason` | **DEFER, free text kept — new finding** | Not named in the S04 prompt's "Why" section; identical gap shape to the others (severity closed via `SetBasedSanctionLevel`, reason open). Recorded as a new row in each of the three dossiers per the "record it anyway" instruction. |
  | Cricket | — | **Not in scope** | No dossier flagged this; untouched. |

  **Tennis's researched ITF/ATP/WTA code-violation category list** (starting
  point only, not implemented): audible obscenity, visible obscenity, verbal
  abuse, physical abuse, ball abuse, racket/equipment abuse, coaching (illegal),
  unsportsmanlike conduct, time violations, failure to follow reasonable
  instructions, best-efforts violation, leaving the court without permission,
  return-to-play lateness. Fine schedules and exact codification differ by tour
  (ATP/WTA/ITF/Grand Slam) and by singles vs. doubles — a real product ask
  should pin which tour(s) before any enum lands.

  **Label keys declared this session (input to S7, #427):** `ENUM_VOCAB.offence`
  (new field, 8 members) and 21 new `ENUM_VOCAB.reason` members (hockey/
  icehockey's `PeriodSuspensionReason`, 2 of 23 — `dissent`/`other` — already
  had a key from football/cricket). All in `apps/web/src/lib/scoring-vocab.ts`,
  translated in all 4 dictionaries. Nothing else declared: every DEFERRED row
  above stays free text, so no pad picker owes it a closed vocabulary yet.

  **Person-role model, as finally shipped — CLOSED end to end (review round
  1, finding 1).** S3 (#426) shipped the DATA model (`LineupSlot.role:
  'player'|'coach'|'staff'`, default `player`) and the READ selectors
  (`core/lineup.ts`'s `playingSquad`/`onFieldPersons`/`personsAtPosition`,
  already filtered). S4's first pass closed the bug at the engine boundary
  only — `aggregatePlayerStats` (`stats/stats.ts`) gained an optional
  `lineups?: LineupPair` argument checked against the set of person ids the
  team sheet marks anything other than `player` — but shipped it
  UNREACHABLE: neither `apps/web` caller passed `lineups`, and the `lineups`
  DB table had no `role` column to source one from at all (only
  `persons.lane`, a different axis: registration, not a per-fixture team
  sheet). A coach's card scored through the real API still earned a
  leaderboard row. Both review agents caught this independently before this
  index was updated to say otherwise, which is worth recording: **a
  correct, well-tested engine fix is not the same claim as "the acceptance
  criterion is met" when nothing calls it with real data.**
  Closed in the same review round: V357 adds `lineups.role`; `putLineup`/
  `getLineup` (`fixtures.ts`) and their zod schemas
  (`api-v1/schemas.ts`'s `LineupSlotInput.role`, `.optional()` not
  `.default()` — a `.default()` makes it a REQUIRED key on the inferred TS
  type and breaks every direct `putLineup()` caller that builds a slots
  array without it) read/write it; `engine-db/lineups.ts` threads it into
  `LineupSlot` and gained a new batched `loadLineupPairsForDivision`; both
  `player-stats.ts` and `org-posts.ts` now load and pass `lineups`. A second,
  independent bug surfaced building the real end-to-end test: football's
  `applyCard` rejected a card to ANY non-player outright (`state.squads`'s
  `onPitch`/`bench` are correctly PLAYERS-ONLY, so a coach was never in
  them) — fixed additively with `FootballSquad.nonPlayers`. Proven by a
  DB-backed regression test through the real usecases
  (`player-stats.test.ts`), mutation-verified twice.

  **DisciplineCard.minutes**, S4/#428: additive `minutes?: number` on
  `core/types.ts`'s `DisciplineCard`, threaded through football's
  (`FootballSinBinStart.minutes`) and the period kernel's
  (`PeriodSuspensionStart.minutes`) `extractCards()`. Plumbing only — both
  producers already read the value into their own fold
  (`suspensions.ts`'s `SuspensionDetail.minutes`, football's sin-bin expiry);
  grepping `minutes` across `src/core` and `src/sports` before and after
  shows the same set of distinct duration-COMPUTATION call sites, only the
  discipline PROJECTION gained a new copy site. No accumulation rule keyed on
  minutes was implemented this session (the S04 prompt's own "any 10-minute
  yellow counts double" example was suggested, not mandated); the adjudication
  acceptance criterion is met instead by a `reason`-scoped accumulation rule
  (`DisciplineRules.accumulation[].reason`, apps/web) — "three cards for the
  same offence" fires, DB-backed test.

  **DB migration V356** (`persons_lane_coach_staff.sql`) extends
  `persons.lane`'s check constraint to `'coach'`/`'staff'`, mirroring
  `LineupSlot.role` exactly. Schema-only, closes S3's carried caveat; the
  partial unique index `persons_org_user_lane_uq` (V348) still excludes the
  new lanes automatically — verified live (two `coach` rows, same org+user, no
  collision) and by a new DB-backed regression test.

  **Unplanned fix** (RULES.md §1 — found, fixed inline, not deferred): the
  api-v1 `AccumulationRule` zod schema (`schemas.ts`) is a plain `z.object`,
  which STRIPS an unrecognized key rather than rejecting it — without adding
  `reason` there too, a real PUT to the discipline-rules endpoint would have
  silently dropped it before reaching the usecase, leaving the new capability
  unreachable from the actual product surface. `openapi:gen` regenerated
  `openapi/v1.json` to match.

- 2026-08-11 — S4/#428 review round 1 — **three findings, resolved.**
  (1) CRITICAL, closed: the person-role discriminator was engine-tested but
  unreachable from real app code — see the "Person-role model, as finally
  shipped" entry above for the full mechanism (V357, `lineups.role`, both
  usecases wired, plus a second bug found along the way: football's
  `applyCard` structurally could not accept a card to a non-player at all).
  (2) IMPORTANT, closed: `PeriodSuspensionStart.reason` had been hard-narrowed
  to the closed `PeriodSuspensionReason` enum, which would 500 on read for
  any already-recorded suspension whose reason predates the enum (free text
  since W4/#407) — widened to `z.union([PeriodSuspensionReason,
  z.string().min(1)])`; canonical members and any legacy free text both still
  parse. (3) IMPORTANT, deferred with a documented reason, not fixed: nothing
  at parse or fold time stops a `hockey.suspension.start` event from carrying
  an icehockey-only reason (e.g. `fighting`) — gating stays prose (now in both
  hockey/icehockey `DOMAIN.md`, next to the rows it caveats) plus the
  regression test, matching the pre-existing `SetBasedSanctionLevel`
  precedent exactly (same shape, same absence of runtime enforcement, checked
  before citing it). Enforcing it would mean making `PeriodEv`/
  `PeriodSuspensionStart` preset-specific instead of the one shared top-level
  schema every period test imports directly — a restructuring under time
  pressure right after finding 2's fix, which the coordinator's brief for
  this round explicitly said to avoid forcing.
  Minor: V356's citation of `persons_org_user_lane_uq`'s definition fixed
  from V348 to V349 (the migration that last redefined it, adding
  `and merged_into is null`); required a `flyway repair` on the local
  scratch DB since the file's checksum changed after V356 had already
  applied. Two more minor items (a hockey/icehockey-specific DB-backed
  adjudication case; `DismissalRule` growing a `reason` field) left
  as-is per the coordinator's own "no action needed unless cheap"/
  "no action needed" framing.
- 2026-08-11 — S4/#428 review round 2 — **one finding, resolved.** Round 1's
  re-review flagged that finding 1's own standard ("must hold through the
  real API path, not just a bare engine unit test") was only proven at
  `player-stats.ts`; `org-posts.ts`'s wiring was type-correct and traced but
  had zero test proving a non-player is actually excluded. Closed:
  `org-posts.test.ts` gained a DB-backed regression
  ("a coach's goal-shaped stat never appears in the auto-drafted result
  post's scorers"). The implementer caught its own near-miss before
  shipping it: a football-based version of this test would have been
  VACUOUS, because football's `applyGoal` already independently rejects a
  non-player scorer structurally (`state.squads`), so the test would pass
  whether or not the new `lineups`/role wiring worked at all. Used
  icehockey instead, whose `applyGoal` has no such check, so the
  assertion's pass/fail genuinely depends on the fix. Both the report's
  claim and the underlying structural reason were independently verified
  by the re-reviewer (read `period/kernel.ts`'s `applyGoal` directly,
  confirmed `state.squads` is never read there; reproduced the mutation
  kill itself rather than trusting the report — neutering the wiring
  reproduced exactly one failure, this test). With this, the person-role
  discriminator is closed end to end at both real call sites named in the
  original review, each with its own DB-backed, mutation-verified test.

- 2026-08-11 — S5/#431 — **deferred, recorded not re-decided: cricket penalty runs
  to the fielding side (register item 1).** Law 41 adds penalty runs to the
  fielding side's OWN score — i.e. to a *different* innings that may not exist
  yet — so it would change `aggregate()`, the innings-victory test and the NRR
  ledger. It reaches net run rate, so a half-done version corrupts standings
  silently; over-rate penalties ride along with it. Needs a decision on how a
  penalty bank scores for net run rate before any schema lands. Not touched this
  session — `_RULES.md` forbids "improving" a deferred item while in the file.
- 2026-08-11 — S5/#431 — **deferred, recorded not re-decided: carrom fresh toss
  for an extra board (register item 6b).** A mid-match toss would have to
  override the deterministic break alternation. No mechanism proposed; stays
  deferred pending a real product ask.
- 2026-08-11 — S5/#431 — **refusal reaffirmed, not re-litigated: football
  disallowed goal / VAR (register item 7).** Standing answer is "not a scorebook
  entry: a disallowed goal is not a goal." No code change.
- 2026-08-11 — S5/#431 — **items 2 and 4 were BUILT this session, not re-homed.**
  Scout confirmed both were ruled `build` on 2026-08-03 but never landed: the
  register mapped item 2 (tennis — the game a game penalty concedes) to S4/#428
  and item 4 (football — quarters/mini-soccer) to S3/#426, both already
  merged, and neither session's prompt file, decision log, or shipped code ever
  mentions either mechanic — both sports' own `DOMAIN.md` still read `deferred`.
  Flagged to the owner rather than silently re-homed or silently built (three
  options given: keep #431 open scoped to just these two per the #430
  precedent; re-home into S6/S7; build now). **Owner chose: build now.**
  Shipped: `tennis.game.award` (nested/kernel.ts — reuses the existing
  `winGame` cascade, refuses loudly mid-tie-break, sanction event at
  `level:"game_penalty"` stays an untouched no-op so no golden re-baseline is
  forced) and football `mini-soccer` (Q1 reuses `H1`, three new `PlayPhase`
  members, two new period markers `QT`/`3QT`, every `applyPeriod` arm gated on
  `cfg.halves` so a marker legal in one mode is refused, not silently
  reinterpreted, from the other mode's matching phase). Both additive, both
  golden-safe (tennis: append-only `EXTEND_GOLDEN`, byte-prefix-identical;
  football: `git diff` on the corpus is empty). `S03-426-w4b-mutable-squads.md`
  and `S04-428-offence-taxonomies.md` carry a pointer addendum each rather than
  a rewrite, since both sessions are already merged history.
- 2026-08-11 — S5/#431 — **register CLOSED.** All 8 rulings accounted for:
  3 (cricket `pairs-6-a-side`) dropped this session; 2 and 4 built this session
  (above); 5 and 6a confirmed already present in `S06-416-w5-padspec.md`; 8
  confirmed already present in `S07-427-pad-vocabulary-i18n.md`; 1, 6b deferred
  and 7's refusal reaffirmed (above, with reasons carried forward so nobody
  re-derives them). #431 closed with a comment pointing at the PR and this
  entry.

- 2026-08-11 — S6/#416 — **`PadSpec` contract + bidirectional conformance
  shipped for all 11 modules, branch `feat/s6-w5-padspec`, 21 commits.**
  Executed as one foundation dispatch (shared types + conformance harness +
  cricket as the reference module) followed by four parallel family
  dispatches on provably disjoint files (football; setbased+nested —
  volleyball/badminton/tabletennis/tennis; period — hockey/icehockey;
  boardgame+carrom+generic), then a holistic reviewer pass over the combined
  diff, then three gap fixes. Full engine suite **3489/3489**, `tsc EXIT=0`,
  engine lint `EXIT=0`, `git diff --stat` engine-only (no `apps/web`),
  rebased clean onto `origin/main` (9 unrelated commits in between, all
  CI/workflow/placement-side). **E2E + smoke deferred to S12/S13** per this
  session's own engine-only convention — the renderer that consumes
  `PadSpec` does not exist until S10.
- 2026-08-11 — S6/#416 — **the design problem the brief didn't anticipate:
  `eventSchema` is a bare `z.union` with no per-branch type discriminant.**
  Payload schemas (e.g. `CricketBall`) carry no literal `type` field — the
  type string lives only on the envelope, and the only place that ever
  paired a type string to its schema was each module's hand-written `apply()`
  dispatch switch, imperative code, not introspectable data. Solved
  additively, touching no fold logic: a new per-module `eventSchemas: Record
  <string, ZodTypeAny>` registry, reusing the SAME schema object references
  already in the union and the switch; `testkit/conformance-pad.ts` proves
  it's a true bijection onto `eventSchema`'s branches by REFERENCE (closes
  the set both directions, not a one-way subset check — this repo has hit
  the one-way-subset false-green shape before) plus a behavioral proof that
  every registered type really dispatches through the module's real
  `apply()`. `SportModule.eventSchemas`/`.padSpec` both landed OPTIONAL so
  the 10 not-yet-wired modules kept typechecking mid-wave.
- 2026-08-11 — S6/#416 — **the fidelity model redesign (ruled by S2/#430) is
  live.** `FIDELITY = {0:"result",1:"card",2:"timeline",3:"detail"}` +
  `PadSpec.fidelity: Record<eventType, 0|1|2|3>`, one band per event type, no
  repetition — nesting is now structural (`eventsAtOrBelowBand` grows
  monotonically by construction) rather than a hand-maintained claim. The
  SEALED `FidelityTier.tier` union this replaces-in-spirit is untouched
  (`sport/module.ts`, confirmed zero diff on that declaration) — the new
  per-event map is additive, reuses the same closed 0-3 scale, mints no
  second vocabulary (`git grep` for `quick`/`standard`/`full` as tier names:
  zero new hits across the whole diff).
- 2026-08-11 — S6/#416 — **`PadAttribution` redesigned from the brief's
  `none|side|person(role?)|persons(n)` one-of-four to a LIST**, found while
  wiring cricket's real `cricket.review` action: it needs a side (`by`) AND,
  independently, up to two optional persons (`person`, `against`) on the
  same action — a shape the one-of-four choice cannot express without
  dropping a field or splitting one action into several for no product
  reason. A list composes all four original cases as "zero or more items";
  cricket's wicket action needs four items at once (`out`, `fielder`,
  `fielderAssist`, `incoming`).
- 2026-08-11 — S6/#416 — **`checkActionCoverage` (acceptance criterion (a),
  "every branch reachable from some action") is a MODULE-LEVEL property, not
  a per-`padSpec(cfg)` one, and is not auto-run inside
  `padSpecConformanceSuite`.** Found wiring cricket: `cricket.superOver`
  requires `inningsPerSide===1`, `cricket.followon`/`.declare` require
  `inningsPerSide===2` — no single legal cfg ever reaches both, so "every
  branch reachable" only holds across the module's variant space, unioning
  specs. Each module's own test file calls `checkActionCoverage` explicitly
  over whichever variants it tests. (A gap in this — badminton/tabletennis
  skipping the call entirely, reasoning "records never varies across our
  variants so there's nothing to union" — was true but missed that the
  check is still valuable with a SINGLE spec, to catch a flipped
  `records.X` gate that would be wrong identically across every variant;
  closed in review, see below.)
- 2026-08-11 — S6/#416 — **three named variant-gating regressions fixed**
  (S06 prompt acceptance criteria): (1) beach volleyball wrongly accepted
  `volleyball.sub` — root cause was worse than "beach forgot to override a
  default": `records` was a whole-module CLOSURE CONSTANT, structurally
  incapable of varying by variant at all; moved into `SetBasedCfg.records`
  as a real per-cfg field, `beach` now overrides `substitutions:false`.
  Consequence found along the way: 4 (not the expected fewer)
  cfg-derived refusals in `apply()`/`applyRally` were ungated on `strict` —
  this repo's own named recurring defect ("a cfg-derived throw inside a fold
  permanently bricks recorded fixtures", hit 6x in W4a) — all gated, plus 2
  pre-existing tests that were silently asserting nothing given explicit
  strict opt-in. (2) hockey `youth` and (3) icehockey `recreational` both
  inherited adult/full-ladder discipline config — fixed via `Cfg.strength`
  (NOT roster/`lineup.size`, which variants cannot structurally override at
  all — `Cfg.strength.base:7` is what actually drives the "wrong strength
  chip" bug named in `AGENTS.md`) and a narrowed `ICEHOCKEY_RECREATIONAL_
  SUSPENSIONS` (minor/bench_minor only) respectively. Golden-corpus risk
  (editing a named variant preset can shift a frozen stream's recorded cfg)
  was checked mechanically before either edit — `verifyStream` reads the
  corpus's OWN frozen `configs`, never live `module.variants`, confirmed
  both mechanically and empirically (24/24 green, corpora byte-untouched) —
  both fixes landed as plain in-place edits, no re-baseline needed. (4) the
  hockey shoot-out retake overcount, a fourth fix bundled in: added an
  additive `void` field to the kick payload, gated the attempt counter on
  it, used the sanctioned `EXTEND_GOLDEN=1` path (new field, so allow-listing
  would have been dishonest), verified against recorded bytes. Closed a
  SECOND placer/verifier fork along the way (`shootoutDecision`/
  `expectedKicker` also needed the same gate). DOMAIN.md rows for hockey
  (`:65`, `:71`) and icehockey (`:74`) updated from `deferred` to `extended`
  with the shipped mechanism, mirroring S3's own closure pattern.
- 2026-08-11 — S6/#416 — **the carrom stale-comment carry-in (S2/#430) was
  itself imprecise, corrected rather than copied.** S2 said `apply()` has
  "no rejecting arm" for `carrom.strike` and the union simply omits
  `CarromStrike` structurally (a schema-level 422). True in outcome, wrong
  in mechanism: `apply()`'s switch DOES have a live `case "carrom.strike":
  return invalid(...)` — an explicit runtime rejection, not an absence.
  Traced further: `eventSchema` (the union) has **zero production readers**
  in `apps/web` — the real write-path gate is entirely each module's own
  `apply()` switch, not the union. Doesn't change the ruling (`CarromStrike`
  stays out of `CarromEv` and the registry, "keep the one, replicate for
  none") — only the comment's claimed mechanism was fixed. Worth remembering
  for any future session reasoning about what `eventSchema` actually gates.
- 2026-08-11 — S6/#416 — **holistic reviewer pass over the combined 20-commit
  diff found 3 real gaps, all fixed same-session (commit `de7ee5d3`), none
  were production bugs:** (a) `checkActionCoverage` never called for
  badminton/tabletennis (only volleyball) — added, and it immediately caught
  a real mistake in the fix itself (badminton/tabletennis's set-score type
  is `<sport>.game.summary`, `coarseEventType`, not `<sport>.set.summary`
  like volleyball — different terminology per sport sharing one kernel).
  (b) generic's gated settle-panel test only checked gate SHAPE
  (`toEqual`), never proved reachability against real folded state via
  `evalPadGate`, unlike every other gated panel this session — added the
  missing integration test. (c) icehockey `recreational`'s suspension
  `reason` enum stays the full IIHF list while `class` was narrowed —
  reviewed and DELIBERATELY left as-is, documented in `period/kernel.ts`:
  `reason` (the infraction) and `class` (the referee's severity call) are
  independent facts in real hockey discipline, a narrowed `class` list does
  not imply a narrowed `reason` vocabulary, and no `reason`→`class` mapping
  exists in this codebase to narrow by even if that were the intent —
  inventing one would assert a rules fact this session has no source for.
- 2026-08-11 — S6/#416 — **environment note for any session, not specific to
  this one:** a Claude Code hook in this environment (the `rtk` proxy)
  silently rewrites bare `tsc`/`vitest`/`eslint` invocations and can return
  FABRICATED output unrelated to the flags given — `npx tsc --version`
  returned the string `"TypeScript: No errors found"`, `npx vitest
  --version` returned a fake `"PASS (3139) FAIL (0)"`-shaped summary.
  Prefix `rtk proxy` on any such command to get real output. One line
  already added to `_RULES.md` §6; full detail in the global memory
  `reference_rtk_masks_suite_failures.md`.

- 2026-08-11 — S6/#416 — **PR #529's first CI run caught a real regression
  local verification missed: "engine-only diff" does NOT mean `apps/web`'s
  own tests still pass.** `apps/web/src/server/engine-db/__tests__/
  config-snapshot.test.ts` broke — `generic.ts`'s new implicit-draw
  inference (`declaredDraw = isDraw===true || winnerId===undefined`) treated
  ANY payload missing `winnerId` as a draw, including a score-shaped payload
  carrying no draw signal at all, silently swallowing the pre-existing
  "win_loss mode requires winnerId or isDraw" validation that test pins.
  `tsc`/lint/the full engine suite were all green and `git diff --stat` was
  genuinely engine-only — none of that caught it, because `apps/web` calls
  the engine's real fold logic at RUNTIME (`appendEvent`→`foldMatch`→
  `apply()`), and this was a pure behavior change no type check sees. Fixed
  in `a5795482`: requires the `isDraw` KEY to be present (even as `false`)
  before inferring a draw — distinguishes "a Draw action fired with a
  bivalent false toggle" (the real problem being solved) from "no draw
  signal was sent at all" (the case that broke). Second CI run: 7/8 green,
  the one remaining failure (`Playwright e2e — mobile/tablet, 7 widths`) is
  a confirmed pre-existing, already-tracked `EntityCard` overflow bug (#528,
  unrelated CI/Stage/Prod-split session), not this session's diff. Recorded
  as a standing lesson for future engine-only sessions in this programme:
  `reference_engine_only_diff_can_still_break_apps_web_tests` (global
  memory) — either run `apps/web`'s relevant suites locally before opening
  the PR, or budget time for exactly this fix-forward round-trip.

- 2026-08-11 — S7/#427 — **the prompt's "owed by sport" list was stale before
  the session started, and re-verifying it first changed the whole shape of
  the work.** Written 2026-08-06, before S3/S4/S5/S6 executed; those sessions
  shipped most of the named items opportunistically while doing their own
  apps/web wiring — `core.lineup.*` labels, `PenaltyOffence`/
  `PeriodSuspensionReason`, `tennis.game.award`, football `QT`/`3QT`, all of
  cricket's new event types, `SetBasedSanctionLevel`'s 4 members — confirmed
  present by grep before any implementer work started. Re-scouting first (two
  parallel passes: apps/web vocab gap, engine `PadSpec` coverage) turned a
  40-item stale checklist into the real remaining gap.
- 2026-08-11 — S7/#427 — **the real gap: S6's `PadSpec` declared 164
  `PadLabel` keys (`pad.<sport>.action.*`/`.panel.*`) that had never reached
  apps/web at all.** S6 was engine-only by its own convention, so these keys
  existed only as `{key, label}` pairs baked into `packages/engine`'s
  `padSpec()` functions with zero dictionary entries — confirmed by exact-set
  diff, zero overlap. `declaredPadLabels()` (`apps/web/src/lib/__tests__/
  scoring-vocab.test.ts`) enumerates them by walking each module's live cfg
  space (not just presets — a partial cfg override undercounted badminton
  3/27 vs 27/27 until fixed to merge onto the parsed default), and is a
  RUNTIME completeness test, not compiler-forced — `PadLabel.key` is a plain
  `string` on a cfg-driven function's return, not a TS-level closed union.
- 2026-08-11 — S7/#427 — **`PadField`/`PadAttributionItem` had no label slot
  at all, and the original brief named fields that need one.** Added optional
  `labelKey?: PadLabel` to `PadFieldEnum`/`Number`/`Toggle` and
  `PadAttributionItem`'s `person`/`side` variants (`packages/engine/src/
  sport/module.ts`), wired at cricket's `wicket.fielderAssist`/`.incoming`,
  the period kernel's goal `emptyNet`/suspension `minutes`/`servedBy`/
  shoot-out `goalkeeper`, the setbased kernel's `rally.server`/`.scorer`, and
  carrom's `breaker`/`queenBy`. `clockRef` deliberately skipped (deprecated/
  display-only per `icehockey/DOMAIN.md`, never a pad input) — noted there,
  not silently dropped.
- 2026-08-11 — S7/#427 — **a real, previously-ungated asymmetry: the
  brief's "ITTF yellow/red only, BWF adds black" pointed at the wrong field
  (`SetBasedSanctionLevel` is severity, not colour) but the underlying gap was
  real.** No card-colour field existed at all; fixed via a new required
  `SetBasedPreset.sanctionLevels` (badminton/volleyball get all 4 severity
  levels, tabletennis gets `["warning","penalty"]` only) rather than inventing
  the colour axis the brief assumed. `git grep` confirmed no second gating
  mechanism exists in apps/web.
- 2026-08-11 — S7/#427 — **three real, pre-existing, unrelated bugs found
  while writing the session's own e2e proof — all fixed, not deferred.**
  Writing e2e for "a labelled dismissal and sanction render as words" (the
  acceptance criterion, not optional) surfaced that the two target strings
  were correct in the dictionaries but **unreachable** for reasons that had
  nothing to do with S7's own diff:
  1. `cricket-pad.tsx`'s hardcoded `WICKET_KINDS` picker offered 9 of the
     engine's 10 `CricketWicket.kind` members — Law 34's `hitballtwice` was
     never selectable. Fixed (`e55e10b7`).
  2. `event-copy.ts`'s activity-feed renderer had no case for `*.sanction`
     events (tennis/volleyball/badminton/tabletennis all share it) — fell
     through to a raw payload dump, `"level: default"`, for every sanction
     level on every one of those sports, not just the one S7 added. Fixed
     with a shared regex case mirroring the file's own `football.card`
     precedent (`e55e10b7`).
  3. **Found in review, not by the implementer**: fixing (1) made the option
     selectable but not correctly labelled — `wicketLabel()` checks only a
     separate, hand-maintained `WICKET_KEY` map and never falls through to
     `KIND_KEY` the way `enumLabel("kind", …)` does, so it rendered
     "Hitballtwice" (naive capitalize) in every locale even though the
     correct string already existed and was reachable from every OTHER
     lookup path. Fixed by reusing the existing `kind.hitballtwice` key
     (`366ef5a7`). The reviewer also caught that the shipped regression test
     was tautological — it derived "expected" by calling `wicketLabel()`,
     the same function under test — so a second, literal-string test was
     added; the original was kept as an honest existence-only check.
  All three are the same defect class this programme keeps finding: a
  correct value that never reaches the real render path is indistinguishable
  from a missing one until something actually looks at a screen.
- 2026-08-11 — S7/#427 — **real e2e shipped and independently verified
  twice** (`716ffeee`, `apps/web/e2e/scoring-vocab-labels.spec.ts`): cricket
  drives a real `cricket.ball` carrying the `hitballtwice` dismissal through
  the real API/fold/fixture-console and asserts the picker reads "Hit the
  ball twice"; tennis drives a real `tennis.sanction{level:"default"}` and
  asserts the activity feed badges it "Default", scoped to that event's own
  ledger row (`title="tennis.sanction …"`) since "Default" is a common word.
  Both mutation-proved via `cp` backup/revert, both independently re-run by
  the calling session against a second, fresh dev server with byte-identical
  results (4 expected / 0 unexpected / 0 flaky, both times). Local prod
  build (`next build`) was confirmed broken for unrelated reasons before
  falling back to `next dev` — see the environment note below.
- 2026-08-11 — S7/#427 — **environment note: local `next build` (Next
  16.2.9) is currently broken, for reasons unrelated to any session's own
  diff.** `InvariantError: Expected workUnitAsyncStorage to have a store`
  during static-page prerendering, hitting a shifting subset of unrelated
  routes (`/help/*`, `/clubs`, `/[lang]/(marketing)/*`, `/_not-found`,
  `/_global-error`) across repeated attempts — reproduced identically under
  Turbopack, `--webpack`, and `rtk proxy` (ruling out the bundler and the
  wrapper), confirmed as a known, already-tracked upstream Next.js bug
  (vercel/next.js#85251, #86978, #87719), not a code regression. No
  `experimental.ppr`/`dynamicIO` flag exists in this repo's `next.config.js`
  to toggle as a workaround. `next dev` was used instead for e2e — same
  routes, same assertions, just not the static-export path — and worked
  cleanly both times. A `next dev`-specific Turbopack quirk recurred twice:
  the fixture-console's `[no]` dynamic route silently fails to register at
  server start (curl returns 404 for a route that should 307 to `/login`);
  `touch`ing the page file after the server is up flips it to registering
  correctly. Not S7's to fix — flagged here since it blocks local e2e for
  every future session in this programme until someone looks at it, and
  `.github/workflows/e2e.yml` stays deliberately disabled per standing
  project rule, so CI does not cover this either.
- 2026-08-11 — S7/#427 — **deferred, recorded not re-decided: `Cfg.reviews.
  perInnings` has no consumer anywhere in apps/web** (`git grep -a` hits only
  `packages/engine` and the S7 prompt itself) — no label invented, matching
  how the rest of the programme treats a declared-but-unwired field. `Cfg.
  points` (the generic win/draw/loss points-table config) already had a
  label (`divset.standingsPoints`, reused rather than duplicated) distinct
  from `generic.score.points`'s own `stat.generic.points` — the brief's
  "disambiguate" ask turned out to already be half-done. `generic.result{}`
  has no client-side (or api-v1) schema to relax — `AppendEventRequest.
  payload` is `z.unknown()`, pads post raw payloads unvalidated client-side —
  a tripwire test was added instead of validation nothing calls.

- 2026-08-12 — S8/#417 — **THREE of the prompt's premises are false, verified by
  grep on `main` @ `989e0ba8` before any code was written.** Same shape as S7's
  stale owed-list: W4 (#415) shipped much of W6's nominal scope opportunistically.
  (a) "`playerStats` exists only for football, hockey and icehockey; cricket,
  tennis, setbased, carrom, boardgame and generic show `requires_detailed_scoring`
  instead" — **false, all 11 modules already declare `playerStats`**:
  `football.ts:2361`, `hockey.ts:42`(→`:195`), `icehockey.ts:54`(→`:232`),
  `cricket.ts:2105`(`CRICKET_PLAYER_STATS`, declared `:3024`), `tennis.ts:64`,
  `setbased/badminton.ts:67`, `setbased/tabletennis.ts:74`,
  `setbased/volleyball.ts:112`, `boardgame.ts:665`, `carrom.ts:908`,
  `generic.ts:554`. The acceptance criterion "all 11 modules declare
  `playerStats`" was already met on arrival.
  (b) scope 1's "dot-path support in `field`/`sumField`" — **already shipped**:
  `resolvePayloadPath` (`stats/stats.ts:28`) with its own docstring rules, and
  `cricket/DOMAIN.md:164` already records the cricket model being declared
  straight off `cricket.ball` via dotted paths.
  (c) scope 2's "the period kernel is the precedent" for a kernel-built default
  `playerStats` — **no kernel builds one**. All three factories only spread the
  preset's model if present (`period/kernel.ts:2174`, `setbased/kernel.ts:1363`,
  `nested/kernel.ts:1751`); each sport preset declares its own. There is no
  precedent to copy — a kernel-level default is a NEW pattern here, not an
  existing one.
  What IS genuinely absent (grep returns zero hits repo-wide): `personsOf`,
  `PlayerStatsFoldCtx`, `fromEntrant`, `folded`, `value?:(payload)=>number`,
  any goalkeeper metric (clean sheet / goals conceded / non-shoot-out save), and
  any `playerStats` block inside `testkit/conformance.ts`. That is the real S8.
- 2026-08-12 — S8/#417 — **OWNER RULING: widen S8 into `apps/web` and wire
  `personsOf` for real, overriding the prompt's own "no `apps/web` diff"
  acceptance line.** The engine has no entrant→person membership anywhere:
  `sport/entrant-model.ts` carries entrant KINDS only, and the member list lives
  in apps/web's `entrant_members` table. So `PlayerStatsFoldCtx.personsOf` can
  only be supplied by the caller, and an engine-only S8 would ship the entire
  entrant→person fallback — the central deliverable of #417 and of the
  prefer-person-fields ruling — as unreachable code. That is precisely the defect
  class this programme has now paid for twice (S4/#428's person-role
  discriminator shipped engine-only and a coach still earned a leaderboard row;
  S6/#416's "engine-only diff" still broke `apps/web` at runtime). Asked before
  widening per `_RULES.md` §1; answered "widen". Acceptance is therefore
  amended: an `apps/web` diff IS expected, and the fallback must be proved by a
  DB-backed regression driving a v1-era entrant-attributed stream through the
  real usecase to person rows.

- 2026-08-12 — S8/#417 — **`folded.fold(events, ctx)` cannot see the team sheet,
  and that blocks the goalkeeper metrics until the signature grows.** Found while
  briefing the keeper pass, not while debugging it. Clean sheets and goals
  conceded must attribute to whoever was in goal AT THE TIME of each goal, which
  S3/#426 made derivable for the first time — but the derivation needs the
  STARTING keeper, and a starting keeper is a `LineupSlot` on the team sheet, not
  an event. `aggregatePlayerStats` receives `lineups` and uses it only for the
  S4 non-player exclusion; it does not forward it to `folded.fold`, whose
  signature is `(events, ctx)`. So a keeper fold can see every `core.lineup.*`
  CHANGE and none of the initial state. Resolution: `folded.fold` takes
  `lineups` as a third argument, landed in `stats.ts` as its own step, ordered
  AFTER the diagnostics pass because both edit that one file and this programme
  does not run two agents at one file. Recorded because the shape is
  instructive: the core API was specced from the metric path (payload in, person
  out) and the first genuinely STATE-dependent statistic did not fit it.

- 2026-08-12 — S8/#417 — **cricket's mixed-fidelity rule: fine wins, coarse fills
  only a person+aspect the fine stream never mentions.** Cricket is the one sport
  with a real four-band ladder (band 2 `cricket.player.line`, band 3
  `cricket.ball`), so a stream can carry both and a naive mirror double-counts
  every run. Shipped rule: `cricket.ball` always wins; the `folded` path fills
  the SAME keys (`runs`, `balls_faced`, `balls_bowled`, `runs_conceded`,
  `wickets`, `dismissals`) only for a (person, aspect) pair — batting or bowling
  — with zero fine deliveries anywhere in the stream. A real v1-migration fixture
  is fine-or-coarse for its whole length, which the gate handles exactly; and
  `applyPlayerLine` already requires a line coexisting with a fine innings to
  carry the same numbers the ball fold produced, so even a gate failing open
  would double a CORRECT figure rather than patch in a wrong one. Dismissal MODE
  stays fine-only — `cricket.player.line` has no mode field — so no
  `dismissals_<kind>` key is ever folded-derived.
- 2026-08-12 — S8/#417 — **`folded.keys` is declared EMPTY for cricket, and that
  is a deliberate opt-out of the collision checker, not an oversight.** Every key
  cricket's fold writes already has an owning `metrics[]` entry, by design — the
  coarse contribution is meant to land in the same column as the fine one.
  `playerStatsKeyCollisions` exists to catch an ACCIDENTAL clash between two
  uncoordinated sources, so declaring the six would relabel an intentional,
  gated, tested merge as exactly that accident. Recorded because the cost is
  real and a later session should not "fix" it blindly: `keys` stops meaning
  "what this fold may emit" for cricket, so nothing static describes that set.
  The cleaner long-term shape is an explicit `sharesMetricKeys` flag so intent
  is declared rather than encoded as an empty list; not built here because it is
  a core-API change landing after four sport passes were already written
  against the current shape.

- 2026-08-12 — S8/#417 — **the kernel-default `playerStats` pattern, established
  (it did not previously exist).** `makeSetBasedModule` and `makeNestedModule`
  now build a default model — `points_won` as a metric (`field: "scorer"` +
  `entrantField: "wonBy"`/`"by"` + `fromEntrant`), and `matches`/`sets_won`/
  `sets_lost`(/`games_won`) as a `folded` hook — merged with the preset's own via
  `mergePlayerStats`, **preset key wins on collision**. That covers volleyball,
  badminton, tabletennis and tennis from two files, which is the whole point:
  four sports cannot drift from each other if there is one declaration.
- 2026-08-12 — S8/#417 — **the folded models REPLAY the kernel's own scoring
  cascade rather than reimplementing it, and that makes `ctx.cfg` load-bearing.**
  `folded.fold` runs the real `applyRally`/`applySummary`/`bankSet` (setbased) or
  `applyStandardPoint`/`applyTbPoint`/`applySetSummary`/`applyGameAward` (nested)
  over a synthetic throwaway two-entrant state, reading `bestOf`/`setTo` from
  `ctx.cfg`. This is deliberately NOT a second implementation of the set/game
  cascade — this repo's single most-repeated defect is a placer/verifier fork,
  two code paths computing one number until they diverge. **Consequence the
  wiring pass MUST honour: `ctx.cfg` is no longer "reserved for future use" as
  `stats.ts`'s docstring calls it — a caller that omits the division's cfg
  silently degrades these sports to `matches`-only.** That degradation is a
  swallowed `try/catch` inside the fold (chosen over a throw, correctly — a
  cfg-derived throw inside a fold bricks recorded fixtures), so it fails QUIETLY
  and is exactly the shape this programme has been burned by; flagged to review.

- 2026-08-12 — S8/#417 — **two-lens review of the engine diff (correctness lens +
  silent-failure lens, run independently). Most of the diff verified clean with
  evidence; six real gaps.** Clean, each confirmed by reading code rather than
  trusting a test name: the keeper is replayed forward through `core.lineup.*` in
  BOTH implementations (football's own and the shared period kernel) and never
  read from a kickoff snapshot; the explicit-person path genuinely short-circuits
  the entrant path (pinned by a deliberately conflicting fixture); zero `throw`
  statements in any added fold; empty-net charges nobody, shoot-out attempts
  never concede, and an own goal charges the keeper of the side the goal counts
  AGAINST — each pinned by a test that would fail under the naive
  `opponent(by)` reading; `core.void` un-counts structurally because one
  `resolveVoids` result feeds both the metric loop and `folded.fold`; row order
  is sorted by `personId` everywhere, so recompute-on-read cannot drift.
  **The swallowed `try/catch` in the replay-based folds is NOT the coverage
  violation it looked like** — `state` degrades monotonically to `undefined` and
  every cfg-gated key is written in one atomic block gated on it, so a partial
  cfg yields `matches` only (a key with no omittable denominator) and never a
  half-filled row. It honours the S2/#430 invariant. Recorded because the shape
  reads exactly like the defect this programme keeps finding, and the next
  reviewer will flag it again otherwise.
  Gaps found, all fixed in the follow-up pass: (1) cricket's
  `playerStatsKeyCollisions` assertion is VACUOUS — with `folded.keys: []` the
  checker filters an empty list and can never return non-empty, so the test
  cannot fail; (2) the diagnostics counters observe only the metric loop while 8
  of 11 modules now carry stats through `folded`, i.e. the feature built to
  surface silent drops is blind to the path most likely to drop; (3) cricket's
  fine/coarse gate is scoped per (person, aspect) over the WHOLE stream rather
  than per innings, so a player scored ball-by-ball in innings 1 with a coarse
  line in innings 2 silently loses innings 2 — under-count, not double-count;
  (4) `mergePlayerStats` in both kernels declares its merged fold `(events, ctx)`
  and silently drops the `lineups` third argument, which TS's bivariant
  parameter check will not flag — dead today, and precisely the pattern this same
  session shipped for the keeper folds; (5) "a team entrant credits nobody" is
  duplicated SIX times (core + 5 sport folds), byte-identical today, the
  placer/verifier fork shape this repo has hit 5+ times; (6) `value()`'s only
  guard is `typeof === "number"`, which admits `NaN`/`Infinity`, and
  `sumPlayerStats` adds blindly — the first ratio-shaped metric with a zero
  denominator would permanently poison a division leaderboard.

- 2026-08-12 — S8/#417 — **the entrant fallback is now REACHABLE from real data,
  which was the owner's whole reason for widening the session.** New loader
  `apps/web/src/server/engine-db/entrant-members.ts` builds a real
  `PlayerStatsFoldCtx` from `entrant_members`; both call sites are wired —
  `recomputePlayerStats` (batched division-wide) and `org-posts.ts`'s
  `extractScorers` (single fixture) — because S4's review already established
  that wiring one of the two and not the other is exactly how this class of bug
  ships. `ctx.cfg` is resolved per fixture through the SAME
  `resolveFixtureCfg(config_snapshot, division.config, stage.config)` the fold
  path itself uses (V347 snapshot semantics), so the stat fold and the score
  fold can never disagree about which config a fixture was played under.
- 2026-08-12 — S8/#417 — **`ctx.entrants` must be exactly ONE fixture's
  `[home, away]`, never the division's full roster — and passing the roster
  fails SILENTLY.** The replay-based folded models (setbased, nested, carrom,
  generic) reconstruct a synthetic two-entrant state to replay the module's own
  cascade; handed a wider entrant list they bail to `[]` rather than throwing, so
  a division-scoped ctx yields an empty stat table that looks exactly like a
  fixture nobody scored. Found while wiring, not while debugging. Recorded here
  because the ctx is built one layer away from the fold that constrains it, and
  nothing in the type system says "two".

- 2026-08-12 — S8/#417 — **round-2 review, aimed at the half round 1 never saw.**
  The first two reviewers read the engine diff only; the `apps/web` wiring — the
  part touching SQL, tenancy and production logging — had never been reviewed at
  all, which is worth noticing as a process failure and not just a scheduling
  one: the reviewers were dispatched while that pass was still in flight, so its
  absence from their scope was invisible unless someone checked. Verified clean:
  tenancy is safe (`entrants`/`entrant_members` both carry `org_id` under
  `V227__v2_rls.sql`'s blanket `org_id = current_org_id()` policy, the same
  unstated protection `loadLineupPairsForDivision` already relies on, so a
  foreign `divisionId` returns zero rows rather than leaking); the `#404`
  person-merge relabel still runs BEFORE `sumPlayerStats`; the per-fixture ctx
  scope holds (`entrantFoldCtx` builds `entrants` from `[home, away]` only, and
  the division-wide `personsOf` is consulted only after `ctx.entrants.find()`
  has already matched); no log line carries PII; `personsForEntrant` is
  byte-identical at all five replaced call sites; cricket's schema-derived
  dismissal list matches the removed hand-written array exactly in membership
  AND order; the conformance block genuinely runs for 11 of 11.
  Three gaps, all fixed: (1) **a warning that fires on the happy path** — the
  disagreement warn also triggered on `teamEntrantsSkipped`, which is the
  engine's DESIGNED skip for a team-kind entrant and volleyball's routine state,
  so every healthy recompute of a team-entrant division warned, burying the real
  `unknownEntrants` signal; invisible until now because the logging test only
  ever seeded badminton, an individual-kind sport. (2) `org-posts.ts`'s
  single-fixture `extractScorers` called the DIVISION-wide roster loader for two
  entrants on every match result, where `lineups.ts`'s scoped/batched pair was
  the model to copy — and its scoped counterpart was already in use one line
  above. (3) `foldedEntrantsOutOfScope` was `length !== 2`, so it fired below 2
  as well and would have reported the wrong diagnosis for a bye-shaped ctx,
  contradicting both its own docstring and the operator-facing warn text.

- 2026-08-12 — S8/#417 — **OWNER RULING: build the four remaining gaps in S8,
  including goalkeeper saves — which AMENDS S2/#430's parking of that row.**
  Asked explicitly before proceeding, because S2/#430 recorded shots/saves/
  faceoffs as PARKED tier-3 work for a later wave and `icehockey/DOMAIN.md:60`
  carries saves as deferred pending a shots-on-goal event; the owner overrode
  that for this row. The other three were open by my own admission at PR time.
  In scope now: (1) real shots-on-goal / saves as a NEW event type for football
  and both hockey codes — which is exactly the tier-3 shape S2/#430 described,
  so it lands as a per-event stream with its own fidelity band rather than as a
  stat-model change; (2) cricket's fine/coarse gate scoped per INNINGS, which
  needs an innings discriminator on `CricketBall`; (3) `sharesMetricKeys`
  verified against what a fold ACTUALLY emits at runtime instead of trusting the
  declaration — closing the self-declared escape hatch the round-2 reviewer
  flagged as inherently unclosable by the checker alone; (4) the E2E and smoke
  coverage this session had deferred to S9/S12/S13, discharged here.
  Note on (4): S9 (#418) is what puts these stats on `/me`, so there is no
  stats-rendering surface in a browser yet — the e2e drives the real API and
  asserts through the surfaces that DO exist today, and S9 still owes the
  `/me` e2e when its page lands. Note on (1): saves derive from a SHOT event
  with an outcome, not a bare `save` counter, because save percentage needs the
  shots-faced denominator — and the standing coverage invariant (S2/#430, match
  granularity) means a rate is not emitted at all for a match whose shot
  coverage is partial.

- 2026-08-12 — S8/#417 — **CI on #538 caught a class my local gate could not:
  a stat row can be computed, persisted, and structurally unrenderable.**
  Two failures in `apps/web/src/lib/__tests__/player-stat-vocab.test.ts` (S7's
  gate), both jobs. Why local was green: I ran the apps/web suite FILTERED to
  the player-stats specs, and `npm test --workspace apps/web -- run <path>`
  treats positionals as filename filters — the vocab spec never executed. The
  documented trap, paid for again.
  - **(A) 18 newly declared rows carry no message key and no copy in any of the
    four locales** — `cricket.fours`, `cricket.sixes`, `cricket.dismissals` plus
    its ten mode splits, `carrom.boards_won`, and `points_won` on all four
    set-based sports. That is what reds CI, and it is ordinary i18n debt.
  - **(B) the more interesting one: no `folded.keys` row can EVER render.**
    `labelPlayerStats` (`apps/web/src/server/player-stats.ts:30-34`) builds its
    display list from `metrics`/`derived`/`awards` only, so all 29 folded-only
    keys are aggregated, merged, written to `player_stat_snapshots` — and then
    dropped on the way to a label. None has a `PLAYER_STAT_KEY` entry either.
    Among them are **this session's headline keeper metrics**: `goals_conceded`
    and `clean_sheets` on football, hockey and icehockey; also every set-based
    `matches`/`sets_won`/`sets_lost`, `tennis.games_won`, `carrom.matches`/
    `wins`, boardgame's `draws`/`losses`/`white`/`black`, and generic's
    `wins`/`draws`/`losses`/`points_for`.
  - **The gate is blind to the whole class by construction**: its local
    `StatsModule` type reads `metrics`/`derived`/`awards` and nothing else, so
    folded rows sit outside every assertion it makes. A test that cannot see a
    category cannot fail on it — the same shape as the declared-but-inert
    models this session opened with, mirrored: there, a row was declared and
    never computed; here, a row is computed and never displayable.
  - Fix (task #13, sequenced AFTER the shots/saves and cricket passes, since
    the shape change touches both their lanes): `folded.keys` gains a declared
    English label so the "every displayable row ships an engine label"
    invariant the vocab file rests on covers it; `labelPlayerStats` includes
    folded rows deduped by key (cricket shares keys with its metrics
    deliberately, so first declaration wins); `declaredStatRows()` extends to
    folded keys so the blindness closes permanently; then message keys and
    en/es/fr/nl copy for every row.

- 2026-08-12 — S8/#417 — **the four owner-ruled gaps: three landed, CI green
  on the whole wave** (commits 5f482272, 6e49148a, 540c647c, c0e80ce7).
  - **Shots and saves** ship as a shot WITH AN OUTCOME
    (`scored|saved|missed|blocked`), never a bare save counter, so save
    percentage has its shots-faced denominator. Coverage follows S2/#430's
    invariant by a per-side checksum: logged `outcome:"scored"` shots must
    reconcile against `goals_conceded` (always complete, it comes from the
    existing goal event), and when they disagree `save_percentage` is ABSENT,
    not zero. Honest documented limit: a side that conceded nothing has no
    goal to reconcile against, so under-logged saves there cannot be detected
    — inherent to any ledger-only signal. The period kernel gates the event
    per preset (`shotTracking`), football takes it unconditionally.
  - **Cricket's gate is now per innings.** `CricketBall.innings?` mirrors
    `CricketPlayerLine.innings`'s existing recorded-not-derived precedent;
    `apply()` deliberately never reads it, so a stale stamp can only
    mis-scope a leaderboard number and can never brick a replay. Untagged
    balls keep the old whole-stream behaviour exactly.
  - **A new defect found by the CI red, not by review**: no `folded.keys` row
    could ever reach a label — 44 rows aggregated, persisted and dropped on
    the way to the screen, including every goalkeeper metric this session had
    just added. The mirror of the defect S8 opened with (declared but never
    computed; here computed but never displayable). `folded.keys` now carries
    `{key, label}`, `labelPlayerStats` appends folded rows last so cricket's
    deliberate overlap keeps the metric's label, and `declaredStatRows()`
    reads folded keys so the gate is no longer blind to the class.
  - Set-based `sets_won`/`sets_lost` now follow each preset's `unitLabel`
    ("Games won" for badminton and table tennis, "Sets won" for volleyball
    and tennis) — a real new cross-sport collision, pinned by name and by
    both English forms.
  - **Process note worth keeping**: local runs were green while CI was red
    because the apps/web suite had been run FILTERED to the player-stats
    specs, and vitest treats positionals as filename filters. Judge a wave
    only on the unfiltered suite. Separately, an agent reported `failed: 0`
    where my own rerun found 1 (`repair-scale`, a wall-clock budget test that
    reds under load) — the wave-boundary rerun is why that was caught, and it
    is also why a second agent's claim to have written two memory files was
    checked and found false.
  - Still open: the `sharesMetricKeys` runtime check (in flight) and the
    e2e/smoke pass. S9 still owes the `/me` e2e when its page lands, and
    should carry forward that `labelPlayerStats` drops zero-valued rows — so
    a genuinely 0% `save_percentage` renders as no row, same as an absent
    one. Correct for absent-vs-zero, lossy for a keeper who saved nothing.

- 2026-08-12 — S8b (worktree `s8-w6-player-stats`, PR #538) — **the e2e/smoke
  gap owed by the "four owner-ruled gaps" entry above, closed.** No
  rendering page exists yet (S9/#418 builds `/me`), so both suites drive
  `/api/v1` over real HTTP and assert real per-person numbers, per owner
  instruction to not defer this further. Two cases, matching the two
  attribution paths #417 exists for: (a) an explicit person field —
  football, two team entrants with inline `members`, real lineups (the
  engine's `applyGoal` 400s an explicit scorer absent from `state.squads`,
  so both sides need one), `core.start` + `football.goal{by,scorer}`,
  asserted against `GET .../stats/players` (`goals:1, points:1`) and — the
  one real rendering surface that predates S9 — the division console's
  existing `?tab=stats` `stats-board` (PROMPT-27). (b) the entrant
  fallback — badminton (`bwf`), two `individual` entrants with inline
  `members` and deliberately no lineup anywhere in this half (the
  fallback is keyed on `entrant_members`, not on-pitch state — setting one
  would have proved the wrong mechanism), `badminton.rally{wonBy}` alone
  (no `scorer`/`server`, the exact v1-era shape), asserted `points_won:1`
  on the roster person resolved off the fixture's own `home_entrant_id`
  (never assumed from creation order).
  Falsifiability, proved by mutation, not assumed: `recomputePlayerStats`
  (`apps/web/src/server/usecases/player-stats.ts`) was temporarily forced to
  `return { rows: [], throughSeq: 0, hasModel: true }` right after the
  existing `model === undefined` early return — i.e. exactly "the fold
  returned `[]`" — backed up with `cp`, never `git checkout` on
  uncommitted work. Both new Playwright specs failed at the SAME line,
  `expect(row).toBeDefined()` -> `Received: undefined`, then the file was
  restored from the backup and `diff`-confirmed byte-identical, `git
  status` clean. This is the assertion that would break in production too.
  Files: `apps/web/e2e/stats.spec.ts` (extended, not a new file — the
  requires-detailed-notice test already lived there), `scripts/smoke.ts`
  (`playerStatsSuite`, called from `main()` right after `disciplineSuite`
  on the same already-Pro `org2`). The smoke addition was verified two
  ways without running the full 13k-line `main()`: `typecheck:scripts`
  (the real project compiler, not bare `npx tsc`) on the whole file, and a
  throwaway standalone script (never committed) running an exact copy of
  the new function's body against the live server plus a freshly
  Pro-flipped org — 11/11 passed. Real counts, all real HTTP against
  `postgresql://...@127.0.0.1:54357/seazn_test`, confirmed by querying
  that exact database directly for the TAG-stamped competition rows
  afterward, not inferred from a green exit code alone. Verified with
  `next dev` on port 3211 (`localhost`, not `127.0.0.1` — the session
  cookie is `Secure`+host-scoped) — `next build` is a separate,
  unrelated, pre-existing local break on this Next version (upstream
  `InvariantError`), not this branch's problem, so dev was the sanctioned
  target per owner instruction.

- 2026-08-12 — S9/#418 — **the prompt's central premise is FALSE: scope 1 was
  already shipped by S8.** The "Why" section says `recomputePlayerStats` "does
  not build the `personsOf` context S8's models require, so the new models
  never see entrant members." Verified in the code before any work started, not
  taken from a scout summary: `loadEntrantMembersForDivision` +
  `entrantFoldCtx(home, away, members, cfg)` and a per-fixture
  `resolveFixtureCfg(config_snapshot, division.config, stage.config)` all sit in
  `player-stats.ts` on `main`. S8's own owner-ruled widening into `apps/web` put
  them there. Same shape as S7's and S8's stale owed-lists — **a prompt written
  before its dependency executed describes the world before that dependency
  executed.** Re-verify scope 1 of every remaining prompt against `main` before
  briefing anyone.
- 2026-08-12 — S9/#418 — **the career surfaces are SNAPSHOT-ONLY, and that is a
  deliberate divergence from the sibling endpoint one function above them.**
  `personStats` loops `recomputePlayerStats` over every division a person
  appears in before reading. A career spans every division in every sport a
  person has ever played, so paying that cost per card view multiplies an
  already-expensive read across a whole history. `personCareerStats` and
  `listMyCareerStats` therefore read `player_stat_snapshots` exactly as they
  stand; a stale division catches up the next time IT is read (its own
  leaderboard, its per-division card, or the public card). Pinned by a
  regression in each path that fails if a recompute is reintroduced.
- 2026-08-12 — S9/#418 — **the `matches` count under-reported, in three copies,
  and the duplication is why.** All three counters filtered `f.status =
  'finalized'`, but `recomputePlayerStats` puts NO status filter on its
  `score_events` read — so a `decided` fixture contributed stats while
  contributing zero matches, and a card could read "5 goals · 0 matches". The
  repo's own completed set is `('decided','finalized','forfeited')`
  (`divisions.ts:373`, `americano.ts:96`, `org-posts.ts:488`), and this very
  file's sibling query already used `'decided'`. Found independently by the
  coordinator and the reviewer, which is the useful part: three byte-identical
  helpers meant one wrong predicate was three wrong predicates. Now one
  exported `countMatchesByDivision(db, owner, divisionIds)` with a single
  `COMPLETED_FIXTURE_STATUSES`. The recurring placer/verifier fork, again.
- 2026-08-12 — S9/#418 — **`resolveLatestModule` is the deliberate choice for a
  career card, and it has a named cost.** Divisions in one sport can pin
  different `module_version`s and a division never changes version once
  created, so a whole-career card has no single "the" version to resolve. The
  newest module's declarations win the label AND the derive formula for every
  key. When two versions genuinely disagree about what a key MEANS, an older
  division's numbers get labelled under the newer meaning. Accepted rather than
  carrying N label sets on one card; recorded so it is not rediscovered as a
  bug. `personCareerStats` was also aligned to filter `d.archived_at is null`,
  matching `listMyCareerStats`/`listMyPlayerStats`; `personStats` still has no
  such filter — a pre-existing gap, deliberately left, flagged not fixed.
- 2026-08-12 — S9/#418 — **THREE defects that only a rendered page could show,
  and the class is worth more than the fixes.** S8 closed with the mirror pair
  "declared but never computed" / "computed but never displayable". S9 adds a
  third: **displayed, but contradicting itself.**
  (a) A career card stated its match count twice, differently — the meta line
  counts COMPLETED fixtures (all eleven sports), while carrom and the
  setbased/nested kernels also declare a folded `matches` metric counting a
  fixture with ANY recorded play. Badminton rendered "1 division · 1 variant ·
  0 matches" directly above a tile reading "MATCHES 1". Both numbers are
  defensible; one word cannot mean both. The TILE gives way — the meta count is
  the one every sport has. The per-division "My stats" block keeps its tile: it
  has no meta line, so nothing there contradicts.
  (b) On a public player card the rollup restated the Stats block below it
  byte for byte whenever the player had one division in that competition —
  same label, same numbers, twice. It now renders only where it aggregates
  something (`career.some((c) => c.divisions > 1)`). `/me` always renders,
  because summing across clubs is that view's entire purpose.
  (c) `/me` overflowed **41px at 320px** — NOT from the new section: measured at
  41px with Career empty, against 0px on `/dashboard`, isolating it to `/me`'s
  own header being one non-wrapping flex row (logo + eyebrow + name + sign
  out). The eyebrow and display name now step aside below `sm`; nothing moves
  at 640px and up. Unplanned fix, inside this session's own file set.
  None of the three is reachable by a unit test: each is a property of two
  correct values sitting next to each other on a screen.
- 2026-08-12 — S9/#418 — **"variant" is the product's own word — do not
  "improve" it to "format".** The career meta line reads "N divisions · N
  variants · N matches", and "variant" looked like jargon for a player-facing
  card. It is not: `divset.variant`/`wizard.variant` are "Variant" in the
  dictionaries, and `divset.format` is "Format" for a DIFFERENT concept (the
  competition format — americano, league). Renaming would have collided two
  distinct product nouns. Checked before changing; recorded so the next reader
  does not re-propose it.
- 2026-08-12 — S9/#418 — **an e2e helper that reported success while linking
  nobody, and how it was caught.** `linkPersonToUserBySql` resolved its account
  with `update persons set user_id = (select id from users where email = …)`.
  `TAG` is evaluated per PROCESS, so `proEmail()` called from a spec worker
  names an account `auth.setup.ts` (a different worker) never created — the
  subquery returned NULL, the helper set `user_id = NULL`, updated one row, and
  reported success. The spec then asserted against a `/me` belonging to nobody.
  Caught only because the assertion downstream was specific enough to fail. It
  now takes a user ID from `GET /api/users/me` and both lookups throw. Same
  defect class as everything above: a write that cannot fail is not a write
  that worked.
- 2026-08-12 — S9/#418 — **the acceptance criteria are NUMBERS, not elements,
  and that is what makes them falsifiable.** One person gets football goals in
  two divisions of competition A (2 + 1), three more in competition B, a
  goalkeeper appearance in a third competition, and a badminton point. `/me`
  must read 6 goals; competition A's public card must read 3. A scope leak is
  then a WRONG NUMBER, not a missing element — an "a career section exists"
  assertion passes in both the correct and the broken state. Mutation-proved
  both ways, restored from `cp` backups and diffed byte-identical: forcing
  `listMyCareerStats` to return `[]` failed the `/me` assertion, and dropping
  the competition predicate from `getPublicPlayer`'s snapshot read failed with
  `Received ["6","6","1","1"]` against an expected `"3"` — exactly the leak the
  criterion exists to catch. The keeper's `goals_conceded` lands on the SAME
  football card as the outfield goals, which is the "one card, correct splits"
  criterion proved on the surface rather than in a stat blob.
- 2026-08-12 — S9/#418 — **the reviewer's premise check beat the implementer's
  scope cut.** The implementer proved the keeper split with a pure unit test
  over fabricated rows, reasoning that nothing in `apps/web` emits
  `core.lineup.position`. The reviewer checked that premise and it is false: a
  `putLineup` starting slot with `position_key: "GK"` alone reaches
  `footballKeeperStatsFold` (`fixtures.ts:133-135` → `football.ts:1893-1921`),
  no lineup EVENT required. A DB-backed proof landed, mutation-verified by
  breaking `lineups.ts`'s `position_key` pass-through. Worth recording as
  method: **a stated reason for a scope cut is a factual claim, and checking it
  is cheap.**

- 2026-08-12 — S9/#418 — **the fix for the duplicated public rollup was itself
  wrong for a MIXED competition, and final review caught it.** Gating the whole
  `<section>` on `career.some((c) => c.divisions > 1)` still mapped over every
  sport inside it, so a competition with one multi-division sport plus one
  single-division sport rendered the second sport's card as a verbatim
  restatement of its own Stats row — exactly the defect the gate was added to
  remove, reintroduced for the only case with more than one sport. The drop
  belongs per SPORT, in `getPublicPlayer`, before the payload exists; the page
  then reads `career.length > 0` and holds no rule. Consequence worth keeping:
  **a visibility rule written at the render site is a rule about the PAGE, and
  a page can hold several of the things the rule is about.**
  Both pre-existing scoping tests had seeded ONE division per competition, so
  under the new rule they would have asserted an empty payload and passed while
  proving nothing — a vacuous green that only appeared because the rule
  changed underneath them. Each now seeds two.
- 2026-08-12 — S9/#418 — **a review finding REFUSED, with the reason recorded.**
  Final review proposed dropping a career card whose metrics all resolve away
  (every total zero, or a `sport_key` retired from the registry while its
  snapshot rows survive), to match `labelPlayerStats`'s callers
  (`me.ts`, `if (metrics.length === 0) return []`). Implemented, and it
  immediately redded the unit test *"an unknown/retired sport_key degrades to
  empty metrics, never throws — counts stay correct"* — which states the
  opposite contract deliberately. Reverted. The two views answer different
  questions: a per-division row with no numbers is noise, while a career card
  is also the record that you PLAYED the sport, carried by its division and
  match counts alone. Changing that is a product call, not a consistency
  cleanup. Recorded because the next reviewer will propose it again.

- 2026-08-12 — S10/#419 — **scout re-pin, and it moves four of the prompt's
  premises.** Measured on `main` @ `ae22e299`:
  (a) **Server-side idempotency is a Redis cache, fail-open, 24h TTL — there is
  NO `idempotency_key` column on `score_events` and no unique index.**
  `scoring.ts:88-92` reads `cacheGet(idemKey(fixtureId, key))` and replays the
  cached `ScoreOutcome`; `cache.ts:1-10` documents the whole module as
  "fail-open … Redis is a latency optimisation, never a correctness
  dependency"; `V216__score_events.sql` has `unique (fixture_id, seq)` and
  nothing else. So the acceptance criterion "queued events replay in order,
  none duplicated (idempotency proven)" **cannot rest on the server's
  idempotency key**: with `REDIS_URL` unset (every local run, and the e2e
  target) a replayed event is appended AGAIN.
  (b) neither pad subscribes to Supabase realtime today —
  `fixture-console.tsx` and `device-score-pad.tsx` are POST-then-`resync()`
  only (`device-score-pad.tsx:99-160`, 3 in-memory retries + 800ms backoff).
  The realtime precedent to copy is `public-site/live-score.tsx:72-85` +
  `api/v1/public/fixtures/[id]/realtime-token/route.ts:18-44`, which already
  carries the device-link bypass the prompt's gotcha names.
  (c) **`apps/web` imports the engine NOWHERE on the client, and there is no
  root `.` export to import** — `packages/engine/package.json` exposes subpaths
  only (`./core`, `./sport`, `./sports/*`, `./stats`, …); `index.ts` does not
  exist. `resolveModule` (`server/engine-db/registry.ts:1`) opens with
  `import "server-only"`, so the browser fold needs its OWN client-safe
  resolver — new code, not a reuse.
  (d) the 409 body already carries what renegotiation needs:
  `{ok:false, error:{code:"SEQ_CONFLICT", message, current_seq}}`
  (`api-v1/http.ts:140-145`), and `listEvents` (`fixtures.ts:182-192`) returns
  `seq, type, payload, recorded_at, recorded_by, voids_event_id,
  device_link_id` — i.e. the ledger is inspectable per slot, with provenance.
- 2026-08-12 — S10/#419 — **RULING: replay sends the ORIGINAL `expected_seq`,
  never a renegotiated one, and renegotiation happens only AFTER the ledger
  proves the event did not land.** The prompt calls blind renegotiation "the
  correctness heart"; taken literally it is the DUPLICATE BUG, given (a) above.
  The protocol that is correct without any ledger/API change:
  1. Replay each pending event with the `expected_seq` and `idempotency_key`
     it was first minted with. Both outcomes are safe: a Redis hit replays the
     recorded `ScoreOutcome` with no second write; a miss hits the exact-match
     seq check and returns **409, which is a refusal, not a write**.
  2. On 409, read `GET /events?since_seq=<expected_seq - 1>` and inspect the
     row AT `expected_seq`. `appendEvent` accepts only at exactly
     `expected_seq`, so that one slot is a COMPLETE test of whether our event
     landed — it cannot have landed anywhere else. Same `type` + deep-equal
     `payload` + same `recorded_by`/`device_link_id` ⇒ it is ours, already
     applied: drop it from the queue, do not resend.
  3. Only when the slot holds a FOREIGN event does the client renegotiate
     (`expected_seq := current_seq`) and resend — at which point the event
     provably has not been written.
  This makes dedupe rest on the hash-chained ledger (durable, no TTL) instead
  of on a fail-open cache, which is also what `cache.ts` says its own
  contract is. Recorded because a later session reading only the prompt would
  re-introduce the blind renegotiation.
  **Open question for the owner (not filed as an issue):** the durable fix one
  layer down is `score_events.idempotency_key` + `unique (fixture_id,
  idempotency_key)`, which would make the server idempotent regardless of
  Redis. NOT taken this session — it is a ledger/append-API change, which the
  design's own non-goals forbid and which is outside this session's stated
  file set (`scorepad/` + dictionaries), so it needs an owner ruling first.
- 2026-08-12 — S10/#419 — **the test topology is forced by the workspace, not
  chosen.** `apps/web/vitest.config.ts:71` is `environment: "node"` with no
  jsdom, no happy-dom and no `@testing-library` in `apps/web/package.json`, so
  a DOM-rendered component test is not available without adding a permanent
  dependency to every suite in the workspace. Consequence, and it shapes the
  renderer's architecture: the PadSpec walk ships as a **pure view-model**
  (`spec + folded state + tier + entitlements → panels/actions/fields, with
  `evalPadGate` called from the engine, never re-implemented`), unit-tested
  exhaustively over S6's conformance fixtures with no React at all; the React
  layer on top stays thin and is driven, where it holds state, through the
  repo's existing `components/__tests__/_hook-harness` (renders ONE function
  component one level deep — so no `useId`, which that harness does not
  supply). Real DOM behaviour — tab death, offline, queue drain — is proved in
  a real browser via Playwright against a harness route, which is what the
  prompt already requires.
- 2026-08-12 — S10/#419 — **flag names chosen.** Product flag is `scorepad-v2`,
  read through the repo's existing PostHog convention (`isServerFeatureEnabled`
  `posthog-server.ts:65-79` server-side, `posthog.isFeatureEnabled` client-side,
  as `ai-scheduling` does) — declared this session, wired to nothing, flipped in
  S12. The browser-verification harness route is gated separately on a
  **server-read, non-public** env var `SCOREPAD_V2_HARNESS=1` (read in the
  server component, so it is NOT baked at build time the way a `NEXT_PUBLIC_*`
  var is, and is therefore absent from every real deploy) — no dev-only page
  precedent existed in `apps/web/src/app` to copy, so this is the new one.
- 2026-08-12 — S10/#419 — **CORRECTION to the replay ruling above: the slot to
  inspect is `expected_seq + 1`, not `expected_seq`.** `expected_seq` is the
  LAST seq the client saw; `appendEvent` refuses unless `lastSeq ===
  expectedSeq` and then writes the new row at `expectedSeq + 1`
  (`server/engine-db/append-event.ts:189,215`). The ruling's mechanism is
  unchanged and still complete — a write can only ever land at exactly one
  seq, so one row is a total test — but the arithmetic as first recorded was
  off by one, and an implementation following it literally would inspect the
  PREVIOUS event and read every own-event replay as foreign, i.e. duplicate
  exactly what the ruling exists to prevent. Found by the implementer against
  the append path rather than by review; shipped as `targetSeqFor(expectedSeq)
  = expectedSeq + 1` in `pipeline.ts`. Recorded rather than edited in place so
  the earlier entry's shas keep matching.
- 2026-08-12 — S10/#419 — **S7's reason for leaving `PadField.labelKey`
  optional does not survive contact with the universal renderer, and the
  screenshots are how it surfaced.** S7/#427 ruled: "an action always needs a
  name — it is a button. A field frequently does not: cricket's `runs.bat` sits
  inside a labelled 'Ball' action whose whole layout names it." That reasoning
  assumes a hand-built SKIN (S11). The universal renderer has no such layout,
  so on the real page cricket's `cricket.player.line` action draws **seven
  inputs whose only accessible name is `Scorecard line #1 … #7`** — the action's
  own label plus an ordinal — and no visible label at all. Confirmed in the
  browser, not inferred: every `<input>` carried `aria-label="Scorecard line
  #N"`, no `<label for>`, no placeholder. A scorer cannot tell runs from
  wickets from overs. (What DOES work: the bounds are genuinely spec-derived
  and differ per field — `1-2`, `0-2000`, `0-120`, `0-10` — so the cfg-derived
  bound requirement is met.)
  Fix belongs in the RENDERER, not the engine: humanise the field's own dotted
  path as the last resort (`runs.bat` → "Runs (bat)"), visibly, with the
  accessible name kept in sync. Declaring 100+ new engine label keys instead
  would mint exactly the copy S7 deliberately refused to translate, in four
  locales, for surfaces a skin may relabel anyway. Recorded so S11 does not
  "fix" it a second time in each skin.
- 2026-08-12 — S10/#419 — **harness route shipped as
  `apps/web/src/app/score/harness/`, gated on a SERVER-read
  `SCOREPAD_V2_HARNESS=1`.** Two modes on purpose: `?fixture=<uuid>` drives the
  real API with the session cookie (the mode the offline/drain/tab-death e2e
  must use), and with no `fixture` an in-page ledger stands in — real
  IndexedDB, real queue, real fold, real renderer, no seeded division — so the
  pad can be screenshotted and hand-driven. The second mode is explicitly NOT
  evidence about the server contract and the file says so. Deleted at S13's
  cutover at the latest; S12 owns the real entry points.
  Screenshots taken at 1280 / 768 / 375 / 320 (cricket `t20` and football
  `eleven`): no horizontal page scroll at any width, measured
  (`scrollWidth === clientWidth === 320`, and no element overflowing with
  `overflow-x: visible`), touch-sized targets, and the pad draws through the
  app's own `btn btn-primary` design-system classes rather than inventing a
  palette. Open design debt, deliberately NOT fixed blind this session:
  `layout: "grid"` panels leave a half-width button in a full-width card
  (Cards / Substitutions / Shots at 768 and 1280), and the pad has no score
  header of its own — a scorer sees actions but not the state they are
  scoring. Both are S11 skin-shaped questions; raised for the owner rather
  than restyled unilaterally (restyles need sign-off).
- 2026-08-12 — S10/#419 — **football's `State.squads` is a PRIVATE
  `FootballSquad`, not the kernel's `SquadState`, so the attribution picker's
  live-squad tier lights up for every family kernel EXCEPT football.** Found
  while wiring the picker, not while debugging it. The kernels (period,
  setbased, nested) and cricket adopt the shared `SquadCarrier` shape, so
  `personsAtPosition` reads live folded state there; football keeps the squad
  field it already had before S3/#426 (which is exactly why S3 recorded
  football as the one module that persists squads at `init`
  unconditionally). Handled structurally rather than by sport name — the
  picker shape-checks with `isSquadState` before trusting `state.squads` and
  otherwise degrades to the team sheet, so a module that adopts the kernel
  shape later starts working with no picker change. Consequence a reader
  should not have to rediscover: football's keeper-after-a-mid-match-change is
  named from the team sheet, so a post-kickoff keeper swap is not reflected in
  football's picker candidates until football adopts `SquadState`. Tested and
  documented in `attribution-picker.tsx`'s header.
- 2026-08-12 — S10/#419 — **the attribution picker shipped REACHABLE ONLY IF A
  CALLER REMEMBERED TO PASS IT, and the e2e is what exposed that.** The picker
  pass reported (correctly) that `PadRenderer`'s existing `renderAttribution`
  seam was sufficient and needed no renderer edit — but nothing ever passed
  that seam, so the default pad drew no picker at all, and every action whose
  zod schema requires attribution (cricket's toss `wonBy`) was unsubmittable.
  It surfaced only when the e2e drove a REAL fixture and the server 422'd.
  Fifth instance of this programme's signature defect: S4's person-role
  discriminator (engine-tested, unreachable from real code), S8's stat models
  (declared against optional fields, inert), S8's folded rows (computed,
  persisted, unrenderable), S7's `hitballtwice` (correct copy, unreachable
  picker), and now this. The pattern is always the same shape — a component or
  value that is written, tested, and connected to nothing — and a test at the
  unit level cannot see it by construction.
  Fixed by making the picker the DEFAULT (`PadRenderer` renders it itself, fed
  the LIVE folded state so the keeper comes from `core.lineup.*` rather than
  the kickoff sheet); `renderAttribution` survives as an OVERRIDE for S11's
  skins. Mutation-verified: removing the default reds the reachability test.
  **Lesson for S11/S12, worth restating in their briefs:** a seam left for a
  later pass must ship with a working default, or the later pass inherits an
  inert component and nobody notices until something drives the real API.
- 2026-08-12 — S10/#419 — **browser evidence, and what it cost to get.** The
  e2e (`apps/web/e2e/scorepad-offline.spec.ts`) proves the three claims no
  unit test can reach, against the real API through the harness: queued events
  survive a real reload and drain **in order**; airplane-mode scoring
  continues with visible queue depth and drains on reconnect; a 409 raised
  mid-drain by an out-of-band append resyncs and completes with BOTH that
  event and every queued one present **exactly once** — asserted against the
  ledger as exact `{type, payload}` sequences, never as counts. Falsifiability
  proved, not claimed: forcing `indexedDbQueueStore()` to return the
  non-durable memory store fails the tab-death test at the pre-reload
  durability poll (`Expected 3, Received 0`), restored from a `cp` backup and
  byte-verified. Node has no `indexedDB`, so this is the only coverage
  `queue-store.ts`'s open/cursor/transaction paths have anywhere.
- 2026-08-12 — S10/#419 — **CI flake worth naming, in S8's code not this
  session's: `entrant-members.test.ts`'s "same kind/personIds as the
  division-wide loader" assertion is ORDER-SENSITIVE.** Seen once on
  `d0a4e6a2` (`Smoke — DB + Redis suites`), green on the previous CI run of
  the same branch and green in every local full-suite run. The reported diff
  shows the SAME uuid on both sides, so the two loaders agree on membership
  and disagree on ORDER — i.e. `loadEntrantMembersForFixture` and
  `loadEntrantMembersForDivision` do not both impose a deterministic
  `order by`, and Postgres is free to return rows in whatever order a given
  plan produces. Not fixed here (S8's files, outside this session's set, and
  the standing rule is not to chase an unrelated red), but recorded because
  the failure mode is a real latent defect rather than infrastructure noise:
  it will keep reappearing at random until one of the two loaders sorts, and
  the person-level stats built on top of them compare by position.
  **FIXED after all, because it blocked the merge**: it recurred on a
  docs-only commit (2 of 3 runs), which is not a rate anyone should merge
  past, and the fix is two lines — `order by e.id, em.person_id` on BOTH
  queries, so the two loaders agree by construction rather than by luck of
  the plan. Recorded as an unplanned fix (RULES.md §1) in S8's file, with
  the 85 tests across its consumers (`player-stats`, `org-posts`, the whole
  `engine-db` tree) rerun green.
- 2026-08-13 — S11/#420 — **the prompt's sport-to-skin groupings are FALSE in
  two places, and the correction is five skins, not three.** Measured by
  building the real `PadSpec` for every sport x every declared variant (probe
  script, run and deleted; worktree left clean), not by reading module source:
  (a) **"One skin serving tennis + volleyball + badminton + tabletennis"** does
  not hold. Volleyball, badminton and tabletennis are all generated by
  `setbased/kernel.ts:998` and share one action family
  (`{key}.rally/.timeout/.sanction/.sub`). Tennis comes from a DIFFERENT
  kernel, `nested/kernel.ts:1337`, with its own vocabulary (`tennis.point`,
  `tennis.game.award`, `tennis.interruption`), an extra gated `gameAward`
  panel, and `meta.kind`/`meta.receiverSide` enum fields the other three have
  no equivalent of — plus no timeouts/subs concept at all. Note the prompt's
  own words for the racquet layout, "points-within-games-within-sets": that
  describes tennis's nested model, not the setbased rally model, so the brief
  was internally inconsistent as well as wrong about the grouping.
  (b) **football / hockey / icehockey.** Football cannot share with the period
  pair: football has `subs` and `penalties` panels they do not have at all;
  they have `setPiece` and a gated `shootout` football lacks; discipline
  diverges structurally (football `card` with color/reason + separate
  `sinbin.start/end`, versus a single discipline panel with
  `suspension.start/end` carrying class/reason/minutes AND an extra `servedBy`
  person attribution). BUT hockey and icehockey are byte-identical to each
  other — same `period/kernel.ts:1888`, differing only by key prefix.
  **Ruling (owner, 2026-08-13):** cricket-skin (cricket), racquet-skin
  (volleyball + badminton + tabletennis), tennis-skin (tennis), football-skin
  (football), period-skin (hockey + icehockey). The prompt's fallback — "the
  period pair stays on the universal renderer" — was declined by the owner on
  the evidence that the pair's reuse is real and near-free. Everything else
  (generic, carrom, boardgame, …) stays universal deliberately.
- 2026-08-13 — S11/#420 — **RULING (owner): `PadRenderer` consults the skin
  registry itself, accepting a small edit outside the prompt's stated file
  set.** The prompt confines the diff to `scorepad/skins/` + registry +
  dictionaries and leaves wiring to S12. Taken literally that ships a registry
  nothing calls — the exact shape of this programme's signature defect, whose
  fifth instance S10 recorded when its attribution picker turned out to be
  "REACHABLE ONLY IF A CALLER REMEMBERED TO PASS IT" and only an e2e against
  the real API exposed it. So `skinFor(sportKey)` is consulted by the renderer,
  which falls back to the universal panel walk for every unskinned sport. The
  product flag is still off, so nothing user-visible changes. Recorded in the
  PR body under `Unplanned fixes`.
- 2026-08-13 — S11/#420 — **RULING (owner): both design-debt items S10 handed
  forward are fixed here.** (a) Every skin ships its own score header, and the
  coverage gate FAILS a skin whose `layout().header` is null or empty for any
  variant — S10's "a scorer sees actions but not the state they are scoring"
  is closed structurally, not by inspection.
  (b) **The `layout:"grid"` half-width-button item needed no work: S10 had
  already fixed it, and its own index entry calling it open debt was stale.**
  `panel.tsx:51-55` (`actionsClassName`, `md:grid-cols-1` when a grid panel has
  exactly one action) plus its test at `pad-renderer.test.tsx:391-407` are in
  the SAME merged commit `cc907a0b` that the "deliberately NOT fixed blind this
  session" entry sits in — the fix landed later in that session than the note
  did. Recorded because the stale note cost this session an owner question, and
  a future session reading the 2026-08-12 entry alone would re-fix it. **Rule
  this suggests: an entry that defers work must be edited or superseded when
  the same session then does the work.**
- 2026-08-13 — S11/#420 — **cricket's variants do NOT differ where the prompt
  implies they do.** t20, odi and hundred produce byte-identical `PadSpec`
  skeletons; `test` alone adds `innings.declare`, `followon` and `match.close`.
  In particular **the hundred's 5-ball over is CFG-ONLY (`ballsPerOver`) and
  never surfaces in `PadSpec`** — the ball/extra/wicket actions keep the same
  `over`/`ballInOver` fields at every variant. A skin that reads only the spec
  draws the hundred's over rhythm wrong and no spec-driven test can see it,
  which is why `SkinLayoutCtx` carries `cfg` and the brief names this
  explicitly.
- 2026-08-13 — S11/#420 — **the gate's design, and why a skin is split into a
  pure layout plus a thin component.** `apps/web`'s vitest is
  `environment: "node"` with no jsdom and no @testing-library (S10's own
  ruling, unchanged), so "does this skin render every action" cannot be asked
  of the DOM here. `SkinDef.layout(view, ctx)` therefore returns DATA, swept
  across every sport x every cfg by `skin-coverage.test.ts`: no dropped action,
  no invented action, no double placement, header present, headline action at
  `primary` prominence. Two supporting decisions worth not re-deriving:
  (a) **`createSkinDispatch` makes "a skin invents an event type" structurally
  impossible** rather than a thing review must catch — a skin never receives
  the chassis `submit`, only a dispatch that throws on any type the current
  view does not declare.
  (b) **S10's cfg-space walk was EXTRACTED to `__tests__/_cfg-space.ts`, not
  copied.** Both coverage suites must sweep the same space or the skin gate
  silently checks a smaller world than the universal renderer was held to; this
  repo already has a recorded bug where two parallel lookup paths drifted. The
  walk's own trap still applies: default + named variants alone undercounts,
  because several actions exist only behind a cfg leaf no shipped variant sets.
- 2026-08-13 — S11/#420 — **i18n is owned by the main thread, not the
  implementers.** Five parallel agents cannot share four locale dictionaries
  plus a generated `i18n-keys.ts`. The 49-key `scorepad.skin.*` vocabulary was
  seeded across `en`/`es`/`fr`/`nl` BEFORE any skin code was written (parity
  checked, `i18n:gen-keys` rerun), and every dispatch brief forbids touching a
  dictionary and requires unmet copy needs to be reported back instead. A
  general rule for any future parallel UI wave in this programme.
- 2026-08-13 — S11/#420 — **THREE of the five skin implementers independently
  reported the same missing channel, which is what made it a contract bug
  rather than five style complaints.** `SkinProps`/`SkinLayoutCtx` carried no
  `personNames`/`lineups`, so every person picker in every skin drew a RAW
  PERSON ID — a scorer crediting a fielder, an assist or a `servedBy` would
  pick between UUIDs. `PadRenderer` already held both (it feeds
  `AttributionPicker`), so nothing needed fetching; the contract simply did not
  pass them on. Fixed centrally on `SkinLayoutCtx` (optional, because the pure
  coverage sweep has no roster to hand in and a skin must stay total without
  one). Worth naming as a pattern: when parallel agents working from disjoint
  briefs report the SAME gap, it is a defect in the shared contract they were
  handed, and fixing it in one place beats five workarounds.
- 2026-08-13 — S11/#420 — **two chassis controls failed the 44px touch bar on
  every skin, and no unit test could ever have seen it.** Measured in a real
  browser at 320/375/768/1280: S10's phase tabs draw at **28px** high and its
  fidelity switcher at **34px**. Both are chassis, both appear on all five skin
  screens, so five correct skins each inherited a failing screen. Fixed with
  `min-h-11` on both (horizontal padding already cleared). This is the same
  family as S9's three rendering-only defects and S10's inert picker: a
  computed box is invisible to a node-environment test by construction, so the
  screenshot pass is not decoration, it is the only instrument that reads it.
  Numbers after the fix, all 20 shots: `OVERFLOWING=0 SMALL_TAP=0 minTap=44px`.
  The only sub-44px control left on the page is the GLOBAL cookie banner
  (34px), which is not this programme's component — recorded so the next
  session's screenshot pass does not re-open it as a skin defect.
- 2026-08-13 — S11/#420 — **tap counts, counted rather than estimated** (the
  brief made this an acceptance criterion; each is traced through the committed
  code against the v1 pad's own flow):
  cricket full over incl. one extra **7 vs 9**; cricket dismissal credited to a
  fielder **3 vs 5**; football goal with assist **3 vs 6**; football card
  **3 vs 4**; football substitution **3 vs 6**. Every headline flow sits at or
  under the v1 pad, which was the bar.
- 2026-08-13 — S11/#420 — **`PadRenderer.skin` has THREE states, and the
  distinction is load-bearing.** `undefined` consults the registry (every real
  caller), `null` forces the universal path, a `SkinDef` draws that one. `null`
  exists because cricket is the ONLY module declaring pre/live/post and it is
  now skinned — without an opt-out, S10's phase/band tests would have had to
  assert panel structure against a hand-crafted layout that deliberately draws
  no `Panel`s. Note the default is the REGISTRY, never "no skin": a seam whose
  default is off is how S10's picker shipped inert.
- 2026-08-13 — S11/#420 — **small brief correction for future sessions:** the
  kernels live at `packages/engine/src/sports/{setbased,nested,period}/kernel.ts`
  (`sports`, plural), not `src/sport/…`. Two implementers reported it
  independently; the S11 prompt and this session's dispatch briefs both had it
  wrong, harmlessly.
- 2026-08-13 — S11/#420 — **`grantAllEntitlements` makes the ENTIRE scorepad
  suite blind to the `locked` availability state, and that blindness hid a real
  defect in 5 of 8 skinned sports.** Both coverage sweeps grant every
  entitlement before measuring (`_cfg-space.ts`), which is correct for their
  own question — "does the skin reach every action the sport DECLARES" must not
  depend on what an org happens to have bought. The cost is that
  `availability.kind` is never `"locked"` anywhere in the suite, so nothing
  tested what a skin does with a gated action. Review found `racquet-skin` and
  `period-skin` had no `availability` check at all: volleyball, badminton,
  tabletennis, hockey and icehockey rendered a paid-gated action as a working,
  tappable control that the server would refuse. cricket/tennis/football
  happened to handle it, which is exactly why a sweep-style gate cannot be the
  only coverage — three correct implementations made the class look covered.
  Closed by a dedicated `skin-locked.test.tsx` that drives every skin's
  Component with a locked action through the node-only hook harness, with the
  three already-correct skins as the control group. **General rule this
  suggests: any test helper that normalises inputs to make one question
  answerable (grant-all, seed-all, stub-all) defines a blind spot exactly the
  size of what it normalised — name it, and cover it somewhere else.**
- 2026-08-13 — S11/#420 — **two more "the gate checks a document nobody reads"
  gaps, both found by reading rather than running.** (a) `football-skin`'s
  Component gated primary/secondary rendering on five HARDCODED action-id
  literals while only its drawer mapped `layout.groups` generically — a new
  group at those prominences would satisfy the coverage gate's flattened-set
  check and render nothing. (b) `tennis-skin` paired layout groups to view
  panels BY INDEX and then rendered from `view.panels[i]`, not
  `layout.groups[i]` — correct only by the accident that its layout maps 1:1
  and unfiltered, with nothing asserting it. Both break the same contract the
  pure-layout split exists to buy: the gate can only assert on `layout()`'s
  data, so a Component that draws from anything else voids the guarantee. Worth
  restating in S12's brief: when a skin's render source and its layout diverge,
  every green number in this suite is measuring the wrong artifact.
- 2026-08-13 — S11/#420 — **the harness cannot drive any action that needs a
  REAL roster member, which is why cricket has no browser coverage this
  session.** Every `cricket.ball` carries striker/nonStriker/bowler, and
  football's goal carries scorer/assist; the harness route's client lineups are
  permanently SYNTHETIC, so those payloads 422 against the real API in either
  harness mode. Consequences, recorded rather than papered over: cricket's
  headline flow (an over with an extra, a fielder-credited dismissal) is proved
  at unit level and by tap-count trace but NOT in a browser, and football's e2e
  drives a side-only goal rather than the goal-with-assist the brief names. Both
  dissolve in S12, where the real entry points supply real rosters — so S12's
  prompt should carry these two flows explicitly rather than assume S11 covered
  them. A second harness limit found the same way: with no `?fixture=`, every
  sport except `generic` is stuck in the `pre` phase forever, because nothing
  emits `core.start` — so the skin e2e uses `?fixture=` mode, unlike S10's.
- 2026-08-13 — S11/#420 — **`next build` WORKS on this tree; a session-local
  report that it still fails on `/help/*` was wrong.** Measured on the S11
  worktree at the close of the session: `✓ Compiled successfully in 103s`,
  237/237 static pages, `BUILD_EXIT=0`, standalone emitted. This matters beyond
  bookkeeping: a prod build is the only gate that catches a client-bundle leak
  (tsc and unit tests both pass while broken), so the skin e2e was re-verified
  against the standalone server rather than `next dev`. Anyone reading an older
  note that says "use `next dev`, the build is broken" should re-measure before
  believing it.
- 2026-08-13 — S11/#420 — **DONE. Final verification, all run inline by the main
  thread, never taken from an agent's report:**
  unit/component `397 tests, 395 passed, 0 failed, success:true` (JSON
  reporter); skin e2e against a **prod standalone build** on a fresh DB proved
  to be this session's own (`show data_directory`) — `6 passed, 0 failed, 1
  skipped (cricket), 0 flaky`; S10's own pad e2e re-run as a regression on the
  same server — `5 passed, 0 failed`, confirming the universal path still works
  for unskinned sports; `tsc --noEmit EXIT=0`; lint `0 errors` and zero problems
  under `skins/`; drift gates (`openapi:gen`, `i18n:gen-keys`, `i18n:check`)
  run locally with `git status --porcelain` empty. Screenshots: 20 captures, 5
  skins × 320/375/768/1280, `OVERFLOWING=0 SMALL_TAP=0`.
  Smoke remains **deferred to S13**, as the prompt directs.
- 2026-08-13 — S12/#421 — **the deferred-e2e debt, resolved to a concrete list.**
  `_INDEX.md`'s summary line says "S1, S3–S8", which over-counts by two. Read
  from each prompt's own `Test types` block (the authoritative per-session
  mapping `_RULES.md` §5 requires): **S1/#429** (`:92`), **S3/#426** (`:123`),
  **S4/#428** (`:99`), **S5/#431** (`:91`) and **S6/#416** (`:159`) each say
  "E2E + smoke deferred to S12/S13" and are genuinely outstanding. **S7/#427
  and S8/#417 are NOT** — S7 shipped a real e2e and verified it twice, and
  S8's own deferral was to "S9 and S12/S13", discharged in the S8b follow-up
  (`apps/web/e2e/stats.spec.ts` + `scripts/smoke.ts` `playerStatsSuite`).
  Recorded because chasing the summary line rather than the prompts would have
  spent this session re-covering two sessions that already paid.
- 2026-08-13 — S12/#421 — **a live v1 defect: carrom is unscoreable over a
  device link, and has been.** `fixture-console.tsx:473-477` has a `carrom`
  branch whose own comment states the reason — "the generic 1-result pad would
  send `generic.result`, which the module rejects as an unknown event type" —
  and `device-score-pad.tsx:277-291` **has no carrom branch at all**, so a
  carrom fixture on `/score/[token]` falls through to `GenericPad` and 422s on
  every submit. The two dispatchers were described in this programme's design
  as "near-duplicate"; they are not duplicates, they are a duplicate with one
  arm missing, which is exactly the drift the S12 registry exists to make
  impossible. NOT fixed on the v1 path: flag-off byte-identity is this
  session's review bar and a v1 fix would breach it. Flag-on it is fixed for
  free — one registry, both entry points — and the drift guard prevents the
  next one. S13's cutover closes it permanently.
- 2026-08-13 — S12/#421 — **`divisions.config` IS the resolved, schema-parsed
  variant cfg — with one field that is not.** `usecases/divisions.ts:568-570`
  merges `{...variant.config, ...patch.config}` and runs
  `sportModule.configSchema.safeParse(merged)`, storing the parsed output
  (`:580-606`), so every `.default()` is already materialised and a client
  `configSchema.parse(sport.config)` is safe. The exception: `config.entrants`
  is re-added AFTER the parse and is not declared in any `configSchema`, so a
  naive client re-parse silently STRIPS it. Harmless for the pad specifically —
  a module cannot read a key its own schema does not declare — but it means
  `divisions.config` is not a fixpoint of `configSchema.parse`, which is the
  kind of thing a later session will assume. The cfg is therefore resolved
  **server-side inside the flag-on branch only**, never on the v1 path, so a
  parse failure on some future malformed row cannot red a flag-off page.
- 2026-08-13 — S12/#421 — **RULING (owner): `timeline.tsx` is wired in here,
  accepting an edit to two S10 files outside the prompt's stated set
  (`pad-renderer.tsx`, `use-pad-pipeline.ts`).** SIXTH instance of this
  programme's signature defect, and the worst-formed one yet: `timeline.tsx`
  is imported by **nothing** in `apps/web/src` outside its own test, and it
  could not be wired by any caller even in principle — `PadRenderer.timelineSlot`
  is a bare `ReactNode` while `Timeline` needs `onVoid` → `submit`, and
  `UsePadPipelineResult` exposes neither `submit` upward nor its event list.
  A seam that no caller can reach is not "left for later", it is unreachable.
  Fixed on the file's own established pattern: `PadRenderer` renders `Timeline`
  BY DEFAULT from the pipeline's events with `onVoid` →
  `submit("core.void", {event_id})`, exactly as it already renders
  `AttributionPicker` by default, and `timelineSlot` is demoted to the
  override seam `renderAttribution` already is. `usePadPipeline` exposes the
  events it already tracks.
  Why it was not deferred to S13 despite not blocking S12's acceptance: the v1
  chrome's own "Undo last" button sits OUTSIDE the pad section in both
  dispatchers, so flag-on it still fires `core.void` over the synchronous v1
  `apiV1` path — which means **undo fails offline**, on the one entry point
  whose headline acceptance criterion is scoring offline. And S13 deletes that
  chrome, so deferring would hand the cutover a pad with no undo at all.
  Recorded in the PR body under `Unplanned fixes`.
- 2026-08-13 — S12/#421 — **the flag as S10 declared it is UNDRIVABLE by any
  e2e, which would have made every flag-on acceptance criterion untestable.**
  `posthog-server.ts:70-71`: `isServerFeatureEnabled` calls `getClient()` and
  returns `opts.fallback ?? false` when PostHog is unconfigured. No e2e run
  configures PostHog, so with the required `fallback: false` the flag is
  **always off** in a local or CI browser run — the v2 pad could never be
  reached, and a spec written against it would have failed for the environment
  rather than the code. Not a defect in S10's choice (a product flag SHOULD
  default off with no provider); a gap in what S12 needs to test it.
  Fix: one server-read wrapper owning the whole flag decision, with
  `SCOREPAD_V2_FORCE` as a three-state override — `"1"` on, `"0"` off, unset
  ⇒ ask PostHog. Server-read and NOT `NEXT_PUBLIC_*`, so it is absent from
  every real deploy for the same reason S10 gave for `SCOREPAD_V2_HARNESS`
  (a `NEXT_PUBLIC_*` value is baked into the client bundle at build time and
  would ship the gate's answer to production). One home for the decision means
  the two entry points cannot drift on it — which is the same failure this
  session's registry exists to prevent, one level up.
  **What the override makes unobservable, named per the `grant-all` rule:** the
  PostHog branch itself. No browser run ever exercises `c.isFeatureEnabled`,
  so that path is covered by unit tests with an injected client instead —
  on, off, and throw-degrades-to-fallback.
- 2026-08-13 — S12/#421 — **flag-off and flag-on need TWO servers in one e2e
  phase, and that is a feature.** A process-wide override cannot be both states
  at once, so the run is structured as two `node server.js` processes off the
  SAME prod build: `:3100` with the flag off (v1's own specs re-run as the
  regression half of the byte-identity bar) and `:3101` with it on (this
  session's v2 specs). Two Playwright invocations, one per base URL. Worth
  keeping rather than working around: it means the v1 regression genuinely runs
  against a server configured the way production is, instead of against a
  server that merely has not been asked to turn v2 on.
- 2026-08-13 — S12/#421 — **SEVENTH instance of the signature defect, and the
  first where the contract fix itself is what shipped inert: three skins render
  a person as a RAW UUID, and `SkinLayoutCtx.personNames` — added centrally by
  S11 to prevent exactly this — is consumed by NONE of them.** Found on the
  very first real-browser render of the v2 console against a real roster, which
  is the coverage S11 recorded that it could not obtain. Measured:
  `cricket-skin.tsx:345-347` is literally `function displayPerson(id: string):
  string { return id; }`, used at four call sites (`:428`, `:618`, `:705`,
  `:719`) — so the striker, non-striker and bowler selects, the attribution
  selects and the wicket/fielder picker all draw
  `<option value="123fb88b-…">123fb88b-7682-4008-93fb-f607fd7a9570</option>`.
  `football-skin.tsx:249` is `ids.map((id) => ({ value: id, label: id }))`, on
  the scorer/assist picker. `period-skin.tsx:274` falls back to
  `personId.slice(0, 6)` whenever a lineup carries no squad number.
  Why it survived S11's own review: five skins still carry COMMENTS asserting
  "SkinProps carries no lineup/personNames channel" (`cricket-skin.tsx:26,343`,
  `football-skin.tsx:25`, `period-skin.tsx:280`, `racquet-skin.tsx:201`,
  `tennis-skin.tsx:248`). They were true when written and were not revisited
  when the channel landed on `SkinLayoutCtx` mid-session — and `SkinProps.ctx`
  IS a `SkinLayoutCtx`, so every skin has had the names all along. A stale
  comment denying a channel is as good as not having one.
  **The general rule this earns:** when parallel agents report a shared-contract
  gap and it is fixed centrally, the fix is not done until every reporting
  consumer is re-dispatched to CONSUME it. S11 added the channel and closed the
  loop on the contract, not on the callers; the coverage sweep could not see the
  difference because `layout()` returns data and option TEXT is drawn by the
  Component. **OWNER RULING: fix all three skins** — cricket and football to
  `ctx.personNames?.[id] ?? id`, period keeping `#squadNumber` first (a
  deliberate scorer-vocabulary choice) but preferring the name over an id
  fragment as its fallback.
- 2026-08-13 — S12/#421 — **two review gaps worth recording beyond their fixes.**
  (a) `getLineup`'s wire shape carries neither `role` nor `pairOrder`, so
  `registry.tsx`'s `toLineupSlot` cannot set them and `core/lineup.ts:350`
  defaults EVERY roster member to `role: "player"`. Authoritative stats are
  unaffected — `player-stats.ts`/`org-posts.ts` read `loadLineupPair`
  (`server/engine-db/lineups.ts:27-40`), a separate DB read that does carry the
  real column — but the PAD's own picker pools are built from the client fold,
  so S3/#426's OWNER RULING 3 ("a card to a coach records against the person
  but never enters a playing record") is enforced on the stats path and not on
  the entry path. (b) `fidelity.ts:91,117` falls back to `EMPTY_SPEC` when
  `padSpec?.(cfg)` is absent — and `padSpec` is an OPTIONAL module hook
  (`sport/module.ts:388`) — so a module without one declares no
  `fidelityEntitlements`, gates nothing, and lands on band 3 with the full v2
  UI unlocked. Dead today (all 11 implement it) and not a billing bypass (the
  append path still refuses via `requiredFeatureForEvent`), but it is misleading
  UI with no drift guard. Closed structurally by extending the registry drift
  guard to assert every `builtinModules` entry implements `padSpec`, rather than
  by a comment.
- 2026-08-13 — S12/#421 — **new wrapper trap: the `rtk` hook silently TRUNCATES
  `git diff`.** A reviewer's `git diff main...HEAD` came back missing 9 of 23
  changed files — including the flag wrapper the review was partly about — with
  no error and no truncation marker, so the diff looked complete and simply did
  not contain the work. Same family as `rtk`'s `PASS(0) FAIL(0)` for a suite
  that failed to collect: a wrapper returning a plausible smaller answer rather
  than an error. Use `rtk proxy git diff`, and sanity-check the file count
  against `git diff --stat` before drawing any conclusion from a diff's
  ABSENCE. A related, subtler misread from the same run: `rtk`'s diff shows
  COMMITTED state while the working tree may be newer, so a reviewer reading
  both can conclude a file was fabricated when it was merely stale — check
  `git status` before calling content invented.
- 2026-08-13 — S12/#421 — **the v2 console 500s on the SECOND page load, and an
  EMPTY ARRAY is why nothing caught it.** Driving the real flag-on console in a
  real browser: the fixture page renders correctly, "Start match" appends
  `core.start` (verified on the ledger — `last_seq: 1`, `status: in_play`,
  `phase: "live"`), and the `router.refresh()` that follows renders
  `Try again`. Server log:
  `Error: Attempted to call eventOutToEnvelope() from the server but
  eventOutToEnvelope is on the client.`
  `eventOutToEnvelope` is defined in `scorepad/registry.tsx`, which is
  `"use client"`, and both server loaders call it as
  `events.map((e) => eventOutToEnvelope(fixture.id, e))`. **On a fixture with
  no events yet, `[].map(fn)` never invokes `fn`**, so the boundary violation
  is unreachable until the ledger has its first row — which is exactly one tap
  after the page a screenshot would be taken of.
  What did NOT catch it, each checked rather than assumed: `tsc --noEmit`
  EXIT=0; 3251 unit tests green; `next build` green with 237/237 static pages;
  `apps/web` lint 0 errors. A client/server boundary violation is invisible to
  every one of those — the index's own note that "a prod build is the only gate
  that catches a client-bundle leak" is half right, because the build compiled
  this happily too. **The only instrument that reads it is a prod server with
  REAL DATA in it.** That is the whole argument for this session's e2e debt
  being the weight rather than the flag, restated as evidence.
  Recorded before the fix so the shape survives: when a server component maps a
  collection through a helper, the helper's module boundary is only tested by a
  NON-EMPTY collection, and every one of this repo's cheap gates runs against
  the empty case.
- 2026-08-13 — S12/#421 — **no sport is scoreable through the v2 console after
  the match starts, because a FOREIGN write never enters the pad's fold base.**
  Measured in a real browser, flag on, immediately after the client/server
  boundary fix above: "Start match" (the v1 chrome's own button, which sits
  OUTSIDE the pad section in both dispatchers) appends `core.start`; the server
  is then `phase: "live"`; the first run tap throws
  `EngineError: ball in phase "pre"` out of the client fold.
  Mechanism, traced rather than guessed. `use-pad-pipeline.ts:323-329`
  `onStreamEvents` receives the polled batch and calls
  `reconcileAfterAck(ledgerEventsRef.current)` — it **discards the fetched
  events** and reconciles against the list the pad already had. That comparison
  diverges, so `setServerOverride(server.state)` fires and `foldedState`
  (`:279-283`) returns the server's state, which makes the DISPLAY correct. But
  `submit()` folds optimistically from `[...ledgerEvents, ...pending]`, which
  `serverOverride` does not touch — so the fold BASE is still empty and every
  subsequent action validates against `phase: "pre"` and throws.
  Root cause is a type, not an oversight: `LedgerSlotEvent` carries
  `seq/type/payload/recorded_by/device_link_id` and no `id`/`recorded_at`, so
  it cannot be widened to an `EventEnvelope` and folded — the file's own
  comment says exactly that ("deliberately narrow … cannot be folded directly,
  so an inbound signal is treated as 'go verify the true state' rather than
  data to fold ourselves"). That was a sound call for S10's harness, where the
  pad was the only writer. It stops being sound the moment the pad shares a
  fixture with the console chrome, which is what S12 mounts.
  Note this is the MIRROR of the hazard S11 recorded ("once `serverOverride` is
  set, `foldedState` returns it verbatim and ignores every later local submit")
  — same root, opposite symptom: display and fold base are two states that only
  agree by luck. Fixing it is not scope widening; acceptance criterion 2 is
  "both entry points fully scoreable via v2 for all 11 sports", and without it
  none are.
- 2026-08-13 — S12/#421 — **wiring `role` closes the coach hole for football and
  NOT for cricket, and the reason is one level below the wire shape.** Pass B
  carried `role` through `LineupSlotIn` → `toLineupSlot` (the DB column and
  `readLineup`'s SQL always had it; only the client wire shape dropped it, so
  the fold defaulted every slot to `"player"`). Football is genuinely closed —
  its scorer/assist pool filters through the kernel's `playingSquad`, proved
  end to end against the real engine. **Cricket is not**:
  `orderFromLineup` (`packages/engine/src/sports/cricket/cricket.ts`) builds
  `state.orders.batting`/`bowling` from `lineup.slots` filtered ONLY on
  `slot === "starting"`, never on `role` — measured live, a `role: "coach"`
  starting slot still lands in the batting order with `role` wired correctly.
  So S3/#426 OWNER RULING 3 ("squad and stat projections keep only
  `role === 'player'`") is enforced on the STATS path and not on cricket's
  ORDER path, which is what the pad's pickers read. Not fixed in pass B —
  `packages/engine` was outside its stated file set and it flagged rather than
  expanded, correctly. Recorded here so it is not re-derived: the fix is a
  `role` filter in `orderFromLineup`, and it cannot move a golden corpus,
  because no recorded lineup carries a non-`player` role at all (the field
  never reached the wire until today).
- 2026-08-13 — S12/#421 — **`pairOrder` has NO database column, so the brief
  that told pass B to "carry it through, the DB already has it" was wrong.**
  Verified: no `pair_order` column exists anywhere, no caller writes one, and
  `lineup-editor.tsx` has no UI for it. S3/#426 added `pairOrder` to the
  engine's `LineupSlot` type and nothing downstream ever grew a way to set it,
  so threading it through the wire shape would have added a permanently
  `undefined` field and called it a fix — the same declared-but-inert shape
  this programme keeps finding, introduced deliberately this time. Left
  unwired. Related pre-existing gap found alongside it: `lineup-editor.tsx`
  DROPS `role` on save, so the column the fix above now reads correctly can
  only ever be populated by something other than the product's own lineup UI.
  Both are S13 or later work, named here rather than filed.
- 2026-08-13 — S12/#421 — **the deferred-e2e debt, discharged per session with a
  verdict each rather than a blanket claim.** The acceptance criterion allows
  "covered here OR explicitly re-deferred to S13 with a reason", and the honest
  answer differs by session:
  - **S6/#416 (`PadSpec`) — DISCHARGED BY CONSTRUCTION, and this is the
    strongest of the five.** The v2 pad renders entirely FROM `PadSpec`: every
    panel, action, field and bound in the cricket, football and generic flows
    driven this session came out of a module's own `padSpec(cfg)`. There is no
    separate thing left to test — a spec-driven renderer working in a browser
    IS the e2e S6 deferred. Recorded explicitly because "covered by
    construction" is exactly the claim that deserves suspicion, and the
    evidence is that the flows fail if the spec is wrong, which is what the
    session's own defects demonstrated.
  - **S3/#426 (mutable squads) — PARTIALLY covered, remainder to S13.** The
    lineup/`role` half is now driven end to end (the coach-in-batting-order fix
    above was found this way). `core.lineup.*` substitution through the pad is
    NOT driven: no skin declares a substitution action reachable in the flows
    covered here, so driving it needs football's `subs` panel, which is S13's
    surface work.
  - **S4/#428 (offence taxonomies) — RE-DEFERRED to S13, with cause.** The
    person-role discriminator IS now proved in a browser (it is the same
    `role` path). The offence ENUMS (`PenaltyOffence`,
    `PeriodSuspensionReason`) need a card/suspension driven with a reason
    selected, and the sports that declare them are football and the period
    pair — reachable, but not in any flow this session's acceptance names.
  - **S1/#429 — RE-DEFERRED to S13, with cause.** Its fold fixes (icehockey
    GWS +1, `metricOf` no-data vs recorded zero, the `resolved` set-piece
    counter) surface on STANDINGS and summary projections, not on the pad. The
    pad is now a reachable surface for the events that feed them, but the
    assertions belong on a standings page, which this session does not touch.
  - **S5/#431 — RE-DEFERRED to S13, with cause.** Tennis's game-award panel is
    entitlement-gated and football's quarters are a cfg variant; both need a
    seeded division on a non-default variant, which is setup this session's
    flows do not build.
  Recorded here rather than only in the PR body, because a PR body does not
  survive compaction and S13's brief needs this list to be exact.
- 2026-08-13 — S12/#421 — **FOURTH defect, and the decisive trace: the client
  fold never advances after its OWN successful ack, so exactly one ball can
  ever be scored.** Captured from the browser's real network traffic (POST
  bodies and response bodies, not inferred):
  ```
  core.start  expected_seq 0            -> 201 seq 1
  ball 1      expected_seq 0, ballInOver 1 -> 409 SEQ_CONFLICT (ledger at 1)
              retry expected_seq 1         -> 201 seq 2, summary "1/0 (0.1)"
  ball 2      expected_seq 1, ballInOver 1 -> 409, then
                                             422 INVALID_EVENT
                                             "over/ballInOver do not match the ledger"
  ball 3      expected_seq 1, ballInOver 1 -> same 409 then same 422
  ```
  Two facts fall out of it that no amount of reading would have settled:
  (a) `expected_seq` starts at 0 for the pad's FIRST write even though
  `core.start` is already on the ledger — the pad's `ledgerEvents` is empty at
  mount and never adopts the event the console chrome wrote. The 409-retry
  protocol rescues the write, so this looks harmless and is not.
  (b) `ballInOver` is 1 on every subsequent ball, so the fold the skin reads
  is frozen at the pre-first-ball state. The server's own ack carries
  `state_summary: "1/0 (0.1)"`, i.e. the server knew; the pad did not.
  Note this is NOT the same fix as the poll-path merge (pass C): that path
  fires on `POLL_MS` = 15s and covers a FOREIGN write. This is the pad failing
  to advance on its OWN acked write, which is the ack path. The two share a
  root — `serverOverride` corrects the DISPLAY while the fold BASE is a
  separate, un-updated list — and fixing one leaves the other.
  Worth recording as a general lesson: `expected_seq` renegotiation on 409 is
  a REPAIR mechanism, and a repair mechanism that always succeeds hides the
  fault it repairs. The first ball landing made the pad look functional; only
  the second ball's 422 named the real state.
- 2026-08-13 — S12/#421 — **the v1 deletion inventory S13 executes.** Measured
  on the rebased branch, not copied from the earlier prompt. Full list here
  rather than a pointer to the PR body, because a PR body does not survive
  compaction.
  **8 pad components** (`apps/web/src/components/v2/pads/`): `boardgame-pad`
  2.4K, `carrom-pad` 9.6K, `cricket-pad` 23.9K, `football-pad` 10.1K,
  `generic-pad` 2.7K, `period-pad` 17.2K, `setbased-pad` 6.5K, `tennis-pad`
  9.2K — 81.6K total.
  **3 pad test files** (`pads/__tests__/`): `cricket-pad-i18n.test.tsx`,
  `cricket-pad-revised-target.test.tsx`, `period-pad-countdown.test.tsx`. Each
  pins behaviour that must be re-pinned against the v2 skin BEFORE deletion,
  not simply dropped — the revised-target and countdown cases especially.
  **19 import sites**: 8 in `fixture-console.tsx`, 7 in `device-score-pad.tsx`
  (it has no `carrom` import — that asymmetry IS the carrom device-link defect
  recorded above), 1 in `__tests__/device-score-pad.test.tsx`, 3 self-imports
  inside `pads/__tests__/`.
  **2 dispatch chains** to delete whole: `fixture-console.tsx`'s ternary over
  `sport.key` and `device-score-pad.tsx`'s near-copy. Plus the three
  now-unused key sets each file declares (`SETBASED`/`NESTED`/`PERIOD`).
  **The harness route**: `apps/web/src/app/score/harness/page.tsx` +
  `harness-client.tsx` (11K), and `SCOREPAD_V2_HARNESS: "1"` at
  `.github/workflows/e2e.yml:151`, `:384`, `:560` — three lines, and the line
  numbers moved when #559 sharded the parallel project, so re-pin them.
  **One reference that is NOT a deletion**: `server/api-v1/__tests__/
  schemas.test.ts:256` names `generic-pad.tsx` in a COMMENT explaining why the
  engine is the only source of truth for a payload shape. Deleting the file
  does not break that test, but the comment goes stale — update it.
  Sequencing note for S13: `scoring-vocab.ts`'s hardcoded `SportKey` union
  (11 keys) is NOT part of this deletion. It is a separate hardcoded list the
  registry does not replace, and the drift guard added this session does not
  cover it.
- 2026-08-13 — S12/#421 — **the pad's own undo silently does nothing for an
  event you just scored — only a reload makes it work.** Found by probing the
  seam this session wired under owner ruling, which is the point: the fix
  itself needed browser proof, not just the flows it enabled.
  Measured, no reload, football goal scored through the pad then its OWN
  timeline row's Undo clicked:
  ```
  VP_ROW_0 {id:"89a9fa93…", txt:"#2 Goal Home (Scorer) … Undo"}   <- pad-submitted
  VP_ROW_1 {id:"100ccb9a…", txt:"#1 Match started (Scorer) … Undo"} <- server-sourced
  clicked row 0 -> ledger stays ["core.start","football.goal"], and NO third
  POST is made at all.
  ```
  Cause: the timeline MIXES two id namespaces. A row the pad learned from the
  server (via `initialEvents` or a poll) carries the server's row id and voids
  fine — that is why the e2e passes after a `page.reload()`. A row the pad
  submitted itself carries the CLIENT-FABRICATED id (the idempotency key,
  `use-pad-pipeline.ts`'s `newId()`), because `appendEvent`'s ack returns
  `{seq, state_summary, outcome, status}` and no row id, and pass F's
  `incomingWins` deliberately keeps the local copy on the seq collision. So
  `handleVoid` submits `core.void {event_id: <a client id the server has never
  seen>}`, and it is swallowed before the network.
  Why it is worse than it looks: "I just tapped the wrong thing" IS the undo
  case. The one that works — undoing something from a previous page load — is
  the rare one. And it is silent: no error, no rejection, no queued event.
  Note also that voiding `core.start` after scoring produces a confusing
  cascade (the later goal replays and 422s `WRONG_PHASE`), which is coherent
  behaviour for an incoherent request but is how the first probe mis-read this
  defect. The timeline renders NEWEST FIRST, so `.last()` is the oldest row.
- 2026-08-13 — S12/#421 pass D — **the shared-worktree sweep hazard fired
  TWICE, live, during this pass — no data lost, but every file-ownership
  split in this session's dispatch depends on knowing it happens.** Pass D's
  own dirty files (V361, `fixtures.ts`, `schemas.ts`, `fixture-console.tsx`'s
  `LineupSlotIn`, `registry.tsx`'s `toLineupSlot`, both files' tests) went
  missing from `git status` mid-session; they were not lost — `git diff HEAD`
  against each was byte-**zero**, because two OTHER concurrent agents'
  commits (`29039497` "test(scorepad): all seven v2 e2e green…", then
  `804031ce` "docs(scoringpad): record the undo-before-reload defect…", the
  second nominally docs-only) had each already absorbed whatever was dirty on
  disk at commit time via a broad `git add`. `804031ce`'s stat is the
  clearest evidence: 28 lines of intended `_INDEX.md` prose plus 429 lines of
  this pass's brand-new test files it never mentions. Confirm-before-panic
  recipe that resolved it without any destructive command: `git log --oneline
  -3 -- <path>` to find who last touched a "missing" file, then `git diff
  HEAD -- <path>` — zero lines means it is safely upstream, not gone. Ending
  state was still correct (this pass's own final commit, `1fc4fb50`, holds
  only what neither sweep had caught) — but a session that assumed "not in
  git status" meant "lost, redo it" would have duplicated committed work.
  Lesson for every session sharing this worktree: prefer staging exact paths
  (`git add <files>`, this pass's own recovery) over `git add -A` / `git
  commit -am`, which is what both sweeps used.
- 2026-08-13 — S12/#421 — **Two UI defects that every gate this session runs
  passed, in both states.** Both found by taking the screenshots the standing
  rule asks for and then MEASURING what looked wrong, not by any assertion.
  (a) An expanded `ActionForm` kept the single grid cell its collapsed button
  occupied, and two of the four panel layouts (`grid`, `perSide`) are
  `grid grid-cols-2` at every width — so on the device-link entry point at 320
  the form was **110px inside a 228px panel**, with a number input under 90px.
  `expectNoHorizontalScroll` passes in both states, because the squeezed form's
  own children scroll INSIDE it; the page never scrolls. Fixed with
  `col-span-2 sm:col-span-1` (inert on a flex child, so the other two layouts
  are untouched; 768 and 1280 unchanged). (b) Cricket's three "This over"
  pickers measured **33px** at 320 and 375 against the repo's 44px bar:
  `.select` is a components-layer class, Tailwind's utilities layer wins, and
  the `px-2 py-1 text-xs` density recipe beside it silently overrode the sizing
  the class existed to provide. `min-h-11` is a different property, so it
  survives the same override. Worth more than an incidental control: those
  three are required entry before EVERY over.
  **The general lesson, which is the reusable part:** a no-horizontal-scroll
  assertion is not a layout assertion. It cannot see a control that is half the
  width it should be, or a third of the height, because both stay inside the
  viewport. Width and height have to be measured, and the cheapest way to know
  WHICH one to measure is to look at a screenshot first.
- 2026-08-13 — S12/#421 — **The same Tailwind override is repo-wide: 19 files
  under `apps/web/src/components` carry a `.select`/`.input` + `px-2 py-1
  text-xs` pair.** Deliberately NOT swept in this session, for two separate
  reasons. Ten of the hits are in `src/components/v2/pads/**` — the v1 pads,
  which this session must keep byte-identical (the flag-off half of the
  integration bar) and which S13 deletes outright, so touching them would break
  a bar to improve code that is about to be removed. The rest
  (`americano-panel`, `entrants-panel`, `division-builder`, `club-hub/*`,
  `history-panel`, `board/move-panel`) are pre-existing debt this session did
  not create or make reachable. S12 fixed the recipe only where it fixed a
  surface S12 makes reachable: `scorepad/**` (verified clean by
  `git grep` afterwards — one hit, the fixed one) and the lineup editor's own
  new controls. **If someone sweeps the rest, `min-h-11` is the fix and the
  44px assertion pattern already exists in `e2e/mobile.spec.ts`.**
- 2026-08-13 — S12/#421 — **a shape check stood in for a declared fact, and it
  was wrong in both directions.** `lineup-editor.tsx`'s `isPairShaped` inferred
  "this is a pair" from *empty position catalog + exactly 2 members*. Neither
  half holds: `generic` declares no `entrantModel` at all, so its defaults
  include `"team"` with `maxTeamMembers: null`, and `assertRosterFits` only
  enforces an upper bound — a generic TEAM of two got the pair/serve-order
  control. And volleyball declares a genuine `pair` kind (beach 2v2) but has a
  five-group position catalog, so real beach pairs never got it. Fixed by
  reading the entrant's own declared `kind`, threaded onto `SideInfo.kind` by
  the fixture page loader, rather than guessing from two proxies — so the next
  sport to declare `pair` works with no edit here. Second-order: `toPutSlot`
  carried `pair_order` unconditionally, so an entrant that hit the false
  positive kept re-sending a stale value forever after losing the control; it
  now nulls it whenever the side is not pair-shaped.
- 2026-08-13 — S12/#421 — **a touch-target fix that would have failed its own
  test at two of the seven widths it runs at.** The first shape of the
  lineup-editor fix was `min-h-11 sm:min-h-0` — 44px on phones, back to ~26px
  from 640px up. But `e2e/mobile.spec.ts` runs under ALL SEVEN width projects,
  `tablet-768` and `tablet-834` included, and the new assertion is an
  unconditional `toBeGreaterThanOrEqual(44)`. The fix and its own regression
  test contradicted each other at exactly two widths. It read green because the
  verification run exercised `mobile-se` only.
  **Two rules, both cheap:** a `sm:`/`md:` escape hatch on an accessibility
  floor needs a reason that survives "is a tablet a touch device?" — usually it
  does not. And when a spec file is wired into a project MATRIX, verifying one
  project is not verifying the test; check which projects the file runs under
  before believing a green.
- 2026-08-13 — S12/#421 — **a post-reload click that passes every actionability
  check and is still swallowed.** `e2e/scorepad-v2.spec.ts`'s after-reload undo
  went red once in six runs of the file — on a warm server and on a
  deliberately cold one, so not a cold-start artefact. Cause is
  pre-hydration: after `page.reload()` the void button is visible, stable and
  enabled — everything Playwright's actionability checks cover — but React has
  not attached its handler, so the click lands on nothing and the test times
  out waiting for a `core.void` that was never requested. It reads as a broken
  undo.
  **Diagnosis discipline worth repeating:** the first two theories were both
  wrong and both plausible. "Shared fixture race" — no, both undo tests seed
  their own. "Regression from the pass that just landed on that exact path" —
  no, and the implementer disproved it from the code rather than by rerunning:
  the click fires strictly after the reload and addresses the row by the
  SERVER id, so no client-fabricated id enters play and neither new branch
  runs. A flake on the same seam as your last change is not evidence that your
  change caused it.
  Fixed with the repo's existing idiom (`v6-sports.spec.ts`'s Release retry,
  `scoring.spec.ts`'s re-fill loops): `expect(async () => {…}).toPass()`,
  **guarded on the ledger** so a click that did register is never issued twice
  — voiding an already-voided event is a real state change, and a blind retry
  trades a flake for a silent second void. Not waited on the pad's own stream
  instead: `useFixtureStream` arms `setInterval` at `POLL_MS` (15s) with no
  immediate fetch, so that would cost 15s a run and still prove only that the
  stream mounted.
- 2026-08-13 — S12/#421 — **CLOSING GATE, all numbers measured on the final
  build.** apps/web unit **7344 total / 7285 passed / 0 failed / 59 pending**,
  2391 of 2391 suites, all 767 suite files resolved inside the worktree — run
  against a FRESH Postgres, because the session's own e2e had been writing
  TAG rows into the working DB all day and the sweep suites walk every row.
  Engine `test:coverage` **3922 passed / 0 failed**, thresholds met. `tsc`
  EXIT=0 in both trees. `cd apps/web && rtk proxy pnpm run lint` →
  **`✖ 78 problems (0 errors, 78 warnings)`** — the two warnings that fall in
  files this branch touches are the repo-wide pre-existing
  `exhaustive-deps`/missing-`msg` pattern at lines outside the diff hunks (the
  same warning fires in `division-builder` and `import-wizard`, untouched).
  E2E: v2 spec 9/9 flag-on, v1 regression 10 passed + 1 by-design skip
  + 4 serial flag-off, lineup 44px green at `mobile-se`/`tablet-768`/
  `tablet-834`. `openapi:gen` + `i18n:gen-keys` leave `git status --porcelain`
  empty.
- 2026-08-13 — S12/#421 — **the near-miss worth recording: a sequential
  comparison nearly produced "my branch broke the solver".**
  `src/scheduling/repair-scale.test.ts` failed on this branch three runs in a
  row, INCLUDING in isolation, while `origin/main` in a fresh baseline worktree
  passed twice. Every instinct says regression. It was not: the assertion is a
  wall clock against a computed budget, and the same test measured 19618,
  13072, 11934, 10234 and 10018 ms on identical code — a 2x spread. The branch
  runs happened while two peer Claude sessions were busy; the baseline runs
  happened after they went quiet. **Interleaving the two trees A/B/A/B gave
  4/4 pass on BOTH** — and a full engine gate on the quiet machine then went
  3922/0.
  **Rule:** for any load-sensitive assertion, a branch-then-main comparison is
  worthless — machine load drifts between the two halves and the drift is
  indistinguishable from the effect you are testing. Interleave, or measure
  nothing. The same run also showed three OTHER engine suites
  (`repair-decompose`, `roundrobin`, and `simulation`'s cricket case) failing
  only under full-suite parallelism and passing alone, which is how a
  four-failure run and a two-failure run of the same code both happened.
- 2026-08-14 — S13/#422 — **the four items S12 re-deferred, closed with a
  verdict each. Three DISCHARGED with real e2e (`apps/web/e2e/
  scorepad-skins.spec.ts`, four new tests), one ACCEPTED with cause — and two
  of S12's own recorded REASONS turn out wrong on inspection, corrected here
  rather than silently carried forward.**
  - **S3/#426 (mutable squads, `core.lineup.*` substitution) — DISCHARGED.**
    Test: "football skin: a substitution, through the SAME reducer
    core.lineup.substitution goes through". S12's reason ("no skin declares a
    substitution action reachable") was already stale by this session:
    football's `padSpec` DOES declare `football.sub` (a "Substitutions"
    secondary panel) and the skin DOES render it — what was actually missing
    was test-side, not product-side: `seedRosteredFixture` seeds every roster
    member `slot:"starting"`, so there was never a bench member for the "on"
    chip to offer. Fixed with a minimal additive `slot?: "starting"|"bench"`
    on `RosterSlotSpec` (`apps/web/e2e/helpers.ts`) — every existing caller
    omits it and is byte-unaffected. Confirmed (not assumed) that this
    exercises the S3 mechanism itself: `football.ts`'s `applySub` calls
    `reduceLineupEvent(liftSquads(state), { type:
    "core.lineup.substitution", ... }, ...)` internally (`football.ts:1165`)
    — `football.sub` is not a parallel vocabulary, it IS the reachable
    surface for the shared lineup reducer S3 built.
  - **S4/#428 (offence taxonomies) — DISCHARGED, both halves.** Tests:
    "football skin: a penalty with an offence selected (PenaltyOffence)" and
    "period skin (icehockey): a suspension with a reason selected
    (PeriodSuspensionReason)". Football's `PenaltyOffence` lives on
    `football.penalty` (the "Penalties" drawer, generic `ActionForm` path —
    outcome/offence/at.period/at.elapsed all gate Confirm, since
    `checkActionValidity` requires every declared FIELD regardless of the
    payload schema's own optionality). Icehockey's `PeriodSuspensionReason`
    lives on `{key}.suspension.start` (labelled "Card", always-visible
    "discipline" group) — confirmed band 1, so unlike football's card/sub/
    penalty (band 2, `scoring.match_timeline`) it needs no entitlement grant
    at all. Both entitlements needed for this session's tests turn out
    already granted anyway: `db/migration/deltas/V112__entitlements_v2.sql`
    seeds `('pro','scoring.match_timeline',true,null)` and the
    `scoring.rally_by_rally`/`scoring.ball_by_ball` twins alongside it, and
    every e2e project's default storage state is the shared Pro org
    (`playwright.config.ts`'s `AUTH_STATE = "e2e/.auth/pro.json"`) — so no
    test in this session needed a bespoke entitlement grant.
  - **S1/#429 — ACCEPTED, re-deferral stands, cause now precise rather than
    generic.** Its three fold fixes (icehockey GWS +1, `metricOf` no-data-vs-
    recorded-zero, the `resolved` set-piece counter) are real but each blocked
    for a DIFFERENT, specific reason, not "expensive": (a) GWS +1 is only
    observable after a full period match reaches a shoot-out — three period
    advances, overtime, then a shoot-out kick sequence — and no existing e2e
    helper reaches that state (`v6-sports.spec.ts`'s own standings test reaches
    only "FT", never a shoot-out). (b) `metricOf`'s fix (`competition/
    tiebreakers.ts:252`) is externally observable only when a tiebreaker
    cascade compares a row with a metric genuinely RECORDED (e.g. a decided
    0-0 draw's GD) against a row where it is ABSENT (an entrant who has not
    yet played, or is missing from an h2h mini-table) — proving it needs
    multiple fixtures engineered so two rows tie on every cascade level ABOVE
    the metric being tested, which standings' own points-first ordering makes
    fiddly to force deliberately. (c) the `resolved` set-piece counter
    (`PeriodSetPiece.resolved`) has **zero product consumers** — verified by
    `grep -rn "\.resolved\b" apps/web/src` returning no hit outside unrelated
    AI-schedule-parsing code — so there is no page or API response anywhere
    to assert against; its correctness is proven entirely by the engine's own
    golden/mutation suites, which already cover it.
  - **S5/#431 — PARTIALLY discharged, and the tennis half's reason is NOT
    what S12 recorded.** Football's quarters half is DISCHARGED for real:
    test "football skin: mini-soccer quarters — a QT period marker under the
    non-default variant" drives `football.period {phase:"QT"}` under
    `variantKey:"mini-soccer"` (`halves:4`). **Tennis's `gameAward` panel is
    NOT entitlement-gated** — `nested/kernel.ts`'s own test
    (`tennis-skin.test.ts:262`) shows it placed at a fresh, ordinary,
    DEFAULT-variant match state; its only gate is `state.points.kind` (not
    mid-tie-break), open from move zero. **A real defect found instead, and
    this is why the panel could not be discharged**: `tennis.game.award`
    declares `fields: []` and one REQUIRED attribution item (`winner:
    EntrantId`, `nested/kernel.ts:345`). `ActionForm.handleTap`
    (`apps/web/src/components/v2/scorepad/action-form.tsx:169-176`) decides
    "auto-submit vs expand-for-input" by checking `action.fields.length`
    alone — it never looks at `action.attribution` — so tapping "Award game"
    fires `onSubmit({})` immediately, before any attribution picker ever
    renders. The payload is missing the one required key and the event
    cannot be recorded. This is not tennis-skin-specific: the universal
    `Panel` component (`panel.tsx:93-99`) wires `ActionForm` the same way, so
    the device-link entry point has the identical gap. Unit coverage never
    caught it: `pad-renderer.test.tsx`'s own "zero-field action submits on a
    single tap" test uses `cricket.newball`, whose `attribution` is ALSO
    empty, so the one case that would expose the bug (zero fields, non-empty
    attribution) is untested. **Not fixed here** — the do-not-touch list for
    this session excludes `apps/web/src/components/**` without asking first,
    and the correct fix point is the SHARED chassis
    (`action-form.tsx`/`panel.tsx`), not a tennis-only workaround, so its
    blast radius (every skin plus the universal renderer) is a call for the
    owner, not a unilateral one-file patch. Flagged prominently rather than
    routed around, per this session's own brief.
  - **Verification**: `NODE_OPTIONS=--max-old-space-size=6144 rtk proxy npx
    tsc --noEmit -p apps/web` → EXIT=0. `rtk proxy npx eslint e2e` → `✖ 3
    problems (0 errors, 3 warnings)`, all three pre-existing and in files
    this session did not touch (`journey-pro.spec.ts`,
    `official-marks-reports.spec.ts`, `round-order.spec.ts`) — zero in
    `helpers.ts`/`scorepad-skins.spec.ts`. **The four new tests are UNRUN**:
    this session's brief forbids starting Playwright (a production build was
    compiling for the main thread's own e2e gate at the time), so every
    locator/selector above is verified by reading the component source and
    dictionary values precisely, not by watching it pass.
- _(append below)_

## Open questions for the owner

- **Volleyball ships player stats that credit nobody in its default setup.**
  Surfaced 2026-08-12 by the `folded` runtime check (S8b): volleyball's
  `entrantModel.defaultKind` is `"team"`, and person-level credit for
  `matches`/`sets_won`/`sets_lost` goes through `personsForEntrant`, which
  returns `[]` for a team entrant BY DESIGN (the same guard the whole stats
  file applies). So the rows are declared, computed and empty unless a
  volleyball division uses individual/pair entrants. Badminton and table
  tennis, on the same kernel, default to `"individual"` and are unaffected.
  This is the declared-but-inert shape again — but by design this time, not
  by mistake, which is why it is a question rather than a defect. Options:
  accept it (volleyball player stats need a real team sheet, i.e. lineups,
  which the folded path does not read for credit); route credit through
  `lineups` for team entrants; or stop declaring the rows for volleyball.
  Not actionable without a product call.

- _(append as they arise; ask in-session, never file an issue)_

## PROGRAMME CLOSED — 2026-08-14

ScoringPad v2 (#407, index #411, final wave #422) is **CLOSED**. The v1 pad no
longer exists; the spec-driven v2 pad is the only scoring path at both entry
points (`/f/[no]` and `/score/[token]`).

**Correction to the S5/#431 sub-entry above, which now misdescribes HEAD.** That
entry records the tennis `game.award` auto-submit defect as "not fixed here — a
call for the owner". It WAS fixed, later in the same session, once it turned out
not to be tennis-specific: `action-form.tsx`'s `handleTap` gated auto-submit on
`action.fields.length === 0` alone, ignoring attribution, so **seven**
declarations across tennis, carrom, generic and the setbased kernel fired an
incomplete payload on first tap. The condition is now
`action.fields.length === 0 && action.attribution.length === 0`, regression-test
"zero-field action with a REQUIRED attribution must NOT auto-submit" in
`pad-renderer.test.tsx`. Recorded rather than rewritten, per this log's rule.

**The architecture as built, not as designed.** The pad renders entirely from
each module's own `padSpec(cfg)`: five skins (cricket, football, period,
racquet, tennis) plus a universal renderer for the sports with none — carrom,
boardgame and generic go through the universal path, which is why carrom, which
was UNSCOREABLE over a device link on v1, works now for free. Attribution,
fidelity bands, the timeline and the offline queue live in the shared chassis,
not in the skins.

**The lesson the programme paid for nine times, and once more here.** Its
signature defect is a seam that is declared, plumbed, and inert — reachable in
the UI and unable to do its job. S13 found two more of them (the person picker
that was a UUID textbox; `handleTap`'s missing attribution check) plus three
behaviours that would have been silently lost in the deletion. **None of them
were visible to `tsc`, ~7,300 unit tests, lint, or a green production build.**
Every one surfaced by driving the real surface in a browser, or by a test that
had never actually run. A test that has never executed is not coverage: the axe
scan that found 24 contrast failures had been sitting in the suite for two
sessions, dying on a stale locator before it ever reached the scan.

**Deferred work that survives the programme**, recorded so it is not re-derived:
the `resolved` set-piece counter has no product consumer (engine-only); the
icehockey GWS +1 and `metricOf` fixes surface on standings, not on the pad;
tennis's tie-break-carrying "Set score (tie-break)" tile is unreachable because
`tennis-skin.tsx` type-dedup renders only the first of two same-typed actions;
the "5v4" strength chip renders on the public scorebug but never the organiser
console. #430 stays open for its two non-tier rows (plus/minus with the on-ice
set, boardgame PGN). The T lane (fidelity band 3 for the sports that never got
one) remains PARKED and is unblocked by this close.
