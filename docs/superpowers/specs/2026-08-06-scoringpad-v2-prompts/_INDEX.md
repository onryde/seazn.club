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
| S8 | #417 | `S08-417-w6-player-stats.md` | S6 | TODO |
| S9 | #418 | `S09-418-w7-career-rollup.md` | S3, S8 | TODO |
| S10 | #419 | `S10-419-w8-chassis-renderer.md` | S6 | TODO |
| S11 | #420 | `S11-420-w9-skins.md` | S7, S10 | TODO |
| S12 | #421 | `S12-421-w10-integration-flag.md` | S11 | TODO |
| S13 | #422 | `S13-422-w11-cutover.md` | S12 | TODO |
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

- _(append below)_

## Open questions for the owner

- _(none — append as they arise; ask in-session, never file an issue)_
