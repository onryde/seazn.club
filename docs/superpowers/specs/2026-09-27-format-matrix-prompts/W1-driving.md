# W1-driving — L3 driving breadth

**Goal.** When this wave is done, every one of the 231 cells runs its four scripted scenarios (LIFECYCLE, M1, R4a, F1) over HTTP instead of reading ⏳ W1-driving. At `ebf7ec040`, 177 of 231 LIFECYCLE cells were deferred: 33 on the ladder family, 99 on multi-stage rows and 45 on team sports. The wave adds:
- team rosters and per-fixture lineups;
- multi-stage seed-proposal → confirm;
- ladder challenges;
- americano and mexicano rounds on linked persons;
- a per-format field size;
- the cricket two-innings and tie streams;
- structural champion rules for double elim, stepladder and page playoff;
- in-process parallel workers.

For an organiser, this is the difference between "the harness never tried a league → knockout, a football league or a padel americano" and a measured answer W1d can triage.

## Read first

- `_RULES.md`: R1, R3, R8, R9, R11, R13, R14a, R17, R21–R25.
- `_INDEX.md`:
  - owner rulings 19, 24, 28, 29, 31, 39, 43, **44–49** (with the four items folded in beneath 49) and **50–52** (plan review 1);
  - the W1-driving status row;
  - "Findings routed (W1b)" and "Findings routed (W1c)" for every line naming W1-driving;
  - the "W2 checklist";
  - "W1d first tasks" (item 4 changes under this wave).
- The plan: `docs/superpowers/plans/2026-09-30-format-matrix-w1-driving.md`. Its "False premises found in planning" (1–15, four of them found at plan review 1, and 10 corrected there) and Decisions D1–D14 come first.
- Design §6.1, §6.4, §7.3, §7.3a, §7.5, §8 (the routing table every product red is triaged into).
- `docs/superpowers/TEST-STRATEGY.md`, rules 1–5 and 10 (fast-check sequence tests for multi-stage advance, ladder challenges and mexicano rounds).
- `AGENTS.md` failure classes 1, 3, 5, 7, 9, 13, 14, 19, 20.
- `~/.claude/skills/seazn-local-env/SKILL.md` for every live run.

## Prerequisites

W1a, W1b and W1c merged (W1c: PR #905, `ebf7ec040`). Ruling 28 puts this wave **before W1d**. R1's sequence gains W1-driving in this wave's docs task.

## Scope

- **Routing hygiene.** One routing construct (`routeTo`) that the Q-A guard reads, together with the deferral classes. The guard's anti-vacuity basis moves from "deferral sites" to "routes read". The status row reads "in progress" while deferrals remain. `OVERRIDE_WAVE` → W2 (ruling 47).
- **Per-format field size.** A page playoff seeds 4, and F1 on `page_playoff_only` is dropped as unfit. The catalogue is regenerated as a reviewed diff, and `--accept-lower-floors` is used only for that drop.
- **Rosters.**
  - Full declared size (`resolvePositions`: lineup + bench), synthetic names, members inline on `addEntrants`.
  - A lineup PUT per side before each team fixture's first event.
  - Americano and mexicano individuals get one linked person each.
  - PADPROOF keeps `rosterlessTeams` (D3).
- **Multi-stage.**
  - Every later stage's TBD rows are generated right after Start.
  - Stage N is completed ONCE, and the proposal `/complete` returned is confirmed on N+1.
  - One `ObservedStage` per stage, with later stages `fieldSource: "seeded"`.
  - `group_group_ko` drives all three stages.
- **Ladder**: `POST /stages/{id}/challenges`, adjacent and upward, with the bound derived from the field; `finalRanks = ladder_order`.
- **Americano/mexicano loops**, bounded by `config.rounds`. A stall is named, never ✅. Suspected product reds are recorded, never fixed.
- **Invariants:**
  - I2 structural on double elim, stepladder and page playoff (ruling 45);
  - I9 (ladder) and I10 (americano);
  - each counted, with zero checked a failure.
- **Cricket** (ruling 44): the tie outcome and the two-innings `test` streams. Regenerate; `KNOWN_UNSUPPORTED` is empty; strike both from the W2 checklist.
- **Workers** (ruling 46): `--workers N`, each with its own sign-in, session and jar, and results in plan order. HTTP only in this wave (D10).
- **Planner**: the `w1-driving` set (the four scripts × 231 cells + the 24 cricket `test` cases); `--only` accepts any catalogue cell.
- **Browser** (ruling 47):
  - the setup filler is used by `BrowserDriver`;
  - the L1 proof at 1280 covers one cell per new capability;
  - the two template-only cells are driven through their template cards.
- **Model** (ruling 49): team rosters; a Swiss-biased command generator; multi-stage and ladder-family refusals routed to their family waves (D6).
- **Routed §8 product gaps: none owned.** Every product red is recorded and routed by §8, never fixed here (ruling 19).

## Lifecycle

This is a harness wave: no rulebook step. The expected values come from engine declarations (`resolvePositions`, `validateLineup`, the bracket generators, `supportsDraws`, folds), the committed catalogue, or the product's own text. Where the answer is a rulebook question (seeding ties, bracket-reset semantics, ladder rules, americano scoring), the harness takes the product's own listed order or asserts structure only, says so in a note, and routes the question to its family wave.

## Decisions

The plan's D1–D13 are **ruled (52)**, accepted as written at plan review 1:
- D1: seed advance through two driver methods, not bench `advance.ts`.
- D2: roster size and paths.
- D3: PADPROOF stays rosterless.
- D4: the cricket stream shapes.
- D5: a future generator gap goes to W2.
- D6: model routes by design §8. Ruling 52 amends ruling 49 through it, adding W3 (for `swiss_playoff` and `swiss_knockout`) beside W4, W5 and W7.
- D7: `routeTo`.
- D8: the ladder sweep.
- D9: americano/mexicano loops.
- D10: HTTP-only workers.
- D11: template cells use the template's field.
- D12: hooks on stage 1 only.
- D13: the L1 proof excludes cricket `test`.

Also ruled at plan review 1:
- **Ruling 50:** the `l2-pairs.json` reshuffle from the F1 `page_playoff_only` drop (931 of 1,731 runs renumbered, 949 re-widthed) is accepted once and named in the commit. Committed evidence stays judged by `plans.lock.json`. Task 10's regen may change only `l3Gap` fields.
- **Ruling 51 → D14:** M1 on americano/mexicano targets the first fixture whose pair entrant has seed 1's person as a member; R4 on the ladder withdraws seed 3 after its first challenge; R4 on americano/mexicano (the withdrawn player keeps playing) is a predicted product red → W7, with an explicit triage rule.

Ruled at plan review 2:
- **Ruling 53 → D14:** R4 on the ladder is judged by what a withdrawal actually leaves (plan false premise 13). R4 after seed 3's first challenge leaves nothing pending, so the product's correct policy is `none`. The ladder R4 case asserts that:
  - the policy is derived from the product's pending set;
  - seed 3's decided challenge is unchanged;
  - seed 3 is gone from the live order but stays in the raw `ladder_order`;
  - no later challenge seats seed 3;
  - zero challenges are refused.

  Noted for W7 and never asserted: `finalRanks` is the raw `ladder_order` (`competition.ts:606`), so a withdrawn player keeps their rung.

Nothing in the plan awaits an owner ruling.

An unfit cell the run exposes is put to the owner as a recommendation, never assumed. Americano × team sport is NOT unfit and does not refuse: it generates on one arbitrary roster member per team (plan false premise 10, corrected at review 1), which is a W7 finding.

## Done when

Ruling 48, judged mechanically:
- An HTTP run on workers of LIFECYCLE, M1, R4a and F1 over all 231 cells (913 after the unfit F1 drop), plus the 24 cricket `test` variant cases: **937 planned**, derived from the planner and never typed. It is committed with its `plans.lock.json` entry and a generated `MATRIX.md`.
- **No ⏳ names W1-driving**, counted from `results.json`.
- **No ❌ has a harness cause.** Every ❌ is in `TRIAGE.md` as product (routed by §8, with case id and failing check) or unfit (a recommendation to the owner). The predicted signatures (`r4-withdrawn-player-kept-playing`, `mexicano-stalled-on-non-decided`, `mexicano-pair-entrants-counted-as-players`) classify a ❌ as a predicted product red → W7 only when every failing check on that case is covered by its signature (plan Task 15 Step 3). Anything else is triaged harness first.
- The L1 proof at 1280 is run three times, with per-screen verdicts in a README.
- The HTTP slice smoke matches W1c's committed states.
- The model's `--regressions` replay is exact.
- The Q-A guard is green with the W1-driving status row closed.
- A whole-branch review answered in writing, including the four reviewer questions (TEST-STRATEGY).

## Traps

1. **`/complete` is never repeated.** A repeat re-runs the progression and stales the draft proposal. Confirm exactly the id `/complete` returned. There is no GET on the seed proposal: POST recomputes.
2. **A later stage's generate must come before its source completes**, or the product answers `409 STAGE_COMPLETED_SEEDING_FAILED`. Generate every later stage right after Start.
3. **A ladder's generate creates nothing, and a second americano generate plans again.** Either can read as "drained" or double a round. Drive ladders by challenges, and never re-generate americano.
4. **A roster that fails the engine's lineup rules reds every team fixture.** Whether it reds at the PUT or at the first event is pinned at plan Task 4 Step 0, and either way it reads as a product defect. Prove every lineup with `validateLineup(...) → []` first. Never PUT a lineup for an entrant that is not the division's own: americano/mexicano fixtures seat product-minted pair entrants, which are in no roster.
5. **The Q-A guard dies with the last deferral** if its anti-vacuity stays on deferral sites. Move it to routes read before deleting any deferral, and never "fix" the guard by deleting the check.
6. **The catalogue regen rewrites `l2-pairs.json`.**
   - Task 2's reshuffle is accepted once (ruling 50). What must still hold is checked mechanically (plan Task 2 Step 4):
     - the run count drops by exactly 1;
     - every run that is not F1 × `page_playoff_only` is still present, unchanged apart from `n` and `width`;
     - the `plans.lock.json` tests stay green.
   - Task 10's regen may change only `l3Gap` fields.
   - Anything beyond that is a stop, not a diff to accept quietly.
7. **Workers share one server and DB, never one cookie jar.** An org switch on a shared jar races. `OrgMismatch` still guards every case.
8. **Environment before defect** (class 14). `db:apply` alone is not a fresh schema: run `sync:sports`. A `pg_ctl` "Address already in use" followed by a successful `createdb` is another session's server. Confirm `show data_directory` is yours. A killed background command exits 0: have each run write `EXIT=$?`.
9. **The repo is public** (R14a). Synthetic owners, entrants and roster members only.
10. **Mexicano waits on ANY fixture that is not `decided`**: a forfeited walkover, a void or a finalized row (`stages.ts:769`). An M1 on mexicano stalls every later round. Record the stall with its signature; never "unblock" it. **R4 does not stall mexicano** (plan review 2 I-3): its withdrawal leaves nothing pending, so round 2 is generated. Its signature needs seed 3's person seated in round 2 or later through any entrant.
12. **From round 2, mexicano counts round 1's pair entrants as players** (plan false premise 17). The active-entrant query has no kind filter (`stages.ts:2290-2293`), and pair entrants are inserted `registered` (`:715-721`). So a person can sit twice in one round, once alone and once inside a pair. Record I10's red with the `mexicano-pair-entrants-counted-as-players` signature, naming the earlier pair entrant as evidence. The fake defaults to this product shape; `individualsOnly` is the opt-in for isolating the loop. Never make the harness dedupe it.
13. **The open-format withdrawal abandons, it does not forfeit** (plan false premise 16). On a ladder, americano, mexicano or page playoff, a withdrawal with something pending reports policy `walkover` with walkovers 0 and voided N, and every pending fixture `abandoned`. `r4-cascade-consistent` picks its model by the product's text-pinned `TABLE_KINDS` / `BRACKET_WALKOVER_KINDS`, and the league canary stays byte-identical.
11. **M1 and R4 mean something different on the ladder family** (ruling 51, plan D14). Americano fixtures seat pair entrants, not the individuals, and a ladder's seed 3 has played nothing at step 1. Use the per-kind target and trigger. Never fall back to the entrant-id match.

## Output and handoff

Record the following in `_INDEX.md`:
- flip the W1-driving row to done with its counts and evidence paths;
- write "Findings routed (W1-driving)" from `TRIAGE.md`;
- add the false premises;
- list D1–D13 as ruled (52), D14 with what the owner ruled of it, and rulings 50–51 where they applied;
- adjust "W1d first tasks" (item 4's changed premise, the cricket pad routes for two-innings events, browser workers inside a shard).

R1 in `_RULES.md` gains W1-driving. `W1d-ci-truth-run.md` and `W2-scoring-fidelity.md` gain "W1-driving merged" as a prerequisite, and the cricket lines struck by ruling 44 leave W2's checklist.
