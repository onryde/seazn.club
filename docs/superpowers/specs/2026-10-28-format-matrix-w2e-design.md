# Format matrix W2e — sport fidelity and the W2 close (design)

- **Date:** 2026-10-28 · **Programme:** format × sport matrix, wave W2, sub-wave **W2e**, the last one ("sport-specific
  fidelity and the rest", plus the binding W2 checklist). W2 closes with this sub-wave.
- **Status:** the owner answered Q1–Q11 in session f-w2e on 2026-10-28, and Q12 from the builder check the same day.
  They are recorded below as D1–D12. This written
  spec was **approved by the owner on 2026-10-28** ("approve", covering the decisions and the author's calls as
  stated in §16). **Amended at plan phase, 2026-10-28:** the plan's code read disproved several premises (E14–E26). The
  owner answered Q13–Q15 ("a" each) and told the author to apply the recommendations to Q16–Q17 ("apply rec for
  remaining questions"). They are recorded as D13–D17, and the sections they touch are rewritten in place. On reading
  the plan the owner reversed D14 and set a standing rule for data changes (D18, same day). No product
  code until the owner approves the plan. Items marked **author's
  call** are this spec's own choices where the decisions are silent (`_RULES.md` R4, AGENTS.md class 17). §16 lists
  them for the owner to check.
- **Started from scratch.** The 10-25 handover went to the cloud session "W2E writing", which never pushed a draft. The
  owner said "start from scratch if not available" (2026-10-28).
- **Worktree / branch:** spec on `/Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2e-spec`, branch
  `docs/format-matrix-w2e`, from `origin/main` `655138c4c7`. The build branch is a fresh `feat/format-matrix-w2e` off
  main when the plan starts. The plan is written against merged main only (W2d learning 2).
- **Read with:** `AGENTS.md`, `docs/superpowers/RULES.md`, `docs/superpowers/TEST-STRATEGY.md`,
  `docs/superpowers/specs/2026-09-27-format-matrix-prompts/_RULES.md` and `_INDEX.md` (the W2e bullet is at IDX:4222,
  the MD-1 table at IDX:4427-4470, "Owed before the W2 release" at IDX:4272), and the W2d design
  `2026-10-20-format-matrix-w2d-design.md`.
- **Code read at:** main `655138c4c7`. Citations are pins for the plan, not promises. The plan re-pins them.
- **Input ledgers (gitignored):** `.superpowers/handoff/2026-10-28-w2e/`: `decisions.md` (Q1–Q11 and the owner's
  answers, verbatim) and `inventory.md` (every owed item, verified against the tree, with path:line evidence). Also
  `.superpowers/handoff/2026-10-28-w2d-learnings-for-w2e.md` (W2d's seams and process learnings).

Path legend. **RBG** = `docs/superpowers/specs/2026-09-27-format-matrix-prompts/rulebook-W2-goals-boards.md`. **RBS** =
`…/rulebook-W2-sets-cricket.md`. **IDX** = `…/_INDEX.md`. **INV** = the inventory above. Engine paths are relative to
`packages/engine/src/`. Web paths are relative to `apps/web/src/`.

## 1. Why, and what done means

Prod (v1.0.7-beta) is held until all of W2 ships, and a new team is on it (rulings 213/214). W2e is the release gate.
After W2a–W2d, five classes of defect remain where the product records something the federation rulebook does not
allow, or offers a control that does nothing:

- **A disqualification does not end the match.** Every sanction is a note. A badminton black card, a tennis `default`
  or a volleyball disqualification is recorded, and scoring carries on (`sports/setbased/kernel.ts:767-775`,
  `sports/nested/kernel.ts:1097-1105`). The organiser has to remember to record the ending separately, or the table is
  wrong.
- **Scores that cannot happen are accepted.** A tennis set of 8–6 is accepted when the tie-break is at 6-all
  (`nested/kernel.ts:1370-1375`, SC-S1). A coarse cricket chase total is accepted past the target with no bound
  (`cricket.ts:1663-1723`, SC-C4). Volleyball and table tennis accept a set target of 1 (ruling 31's floor of 5 was
  never applied). A best-of-1 tennis match with a match tie-break turns into one tie-break (SC-S2).
- **A rule that changes on 2027-01-04 is missing.** BWF badminton moves to 3×15 (RB2A-1). The engine can hold the
  numbers, but no variant offers them.
- **Settings that exist and cannot be reached, or are reached and do nothing.** Five stage keys the engine reads have
  no editor field (ruling 157). `superOverStillTied` decides whether a knockout super over can end level and cannot be
  set at all. `shootout.suddenDeath` and generic `progressScore` are saved and never read, and the Advanced box
  suggests `progressScore` as its example (`components/v2/division-settings.tsx:1365`).
- **Nothing proves the cup-final paths.** The matrix generator never produces extra time, a shoot-out, overtime, a
  super over, DLS, a deciding set beyond best of 1, a set cap, a tie-break set or a sanction (INV §5 G1–G8, G12). No
  truth run has happened since W2b.

**Owner value:** a new team's results and tables match the umpire's sheet in every sport we offer, including the moments
that decide a cup, and every setting the organiser sees does what it says. We prove it with a truth run before prod
ships, not after.

**Done means:**

1. Every item in §2.1 is built with its tests (§12), or carries an owner verdict "not built, because…".
2. Every rule row in §8 is in `packages/engine/rules/`, signed at plan start, and proved by a test whose title carries
   its id (record-only dispositions excepted, D7).
3. The W2 truth run (§10) is green against the committed baseline, or each red carries an owner verdict.
4. MD-1, as amended by D10 (§11): every Survived or NoCoverage mutant on a line W2e changes, and on the result-deciding
   paths listed there, is killed or classified.
5. The web changes pass a 1280 sign-off per screen on an Artifact page, plus 320 and 768 for the non-`/admin` surfaces.
   Their e2e specs are green at all seven widths, run by CI dispatch.
6. `_INDEX.md` is folded: D1–D17 become rulings, the false premises of §4 are recorded, PR #1061's five rows are closed
   or carry an owner verdict (D17), and the W2 status row reads closed.

## 2. Scope

### 2.1 In W2e

| # | Item | Source | Decision |
|---|---|---|---|
| 1 | Badminton `bwf-3x15` variant (15, win by 2, cap 21, best of 3), made the badminton default; `bwf` 3×21 stays selectable | RB2A-1, #1004 | D1, D2 |
| 2 | A disqualifying sanction ends the match with X-RT-1's credit: badminton black card or disqualification, tennis `default`. Volleyball: a disqualification or expulsion never ends the match by itself; the pad asks whether the team can still field six, and "no" records the existing incomplete-team ending (VB-RT-1). The scorer may send that ending right after the matching sanction (narrow exception to organiser-only) | A1, A3, A4 | D3 (1), D12, D13 |
| 3 | Penalty points and penalty games stay entered as a rally or game; the rows say so | A1, A2, A4, A5 | D3 (2) |
| 4 | Hockey and ice hockey: no automatic ending and **no warning** (D15); the organiser ends a match a team cannot continue with the existing abandon or award. The "player leaves for good, team plays short" event (`core.lineup.retirement`) gets a pad control in football, volleyball, hockey and ice hockey; cricket and generic get disposition rows | A13, M12b (21 L2 cases) | D3 (3) as amended by D15 |
| 5 | Delete `shootout.suddenDeath`; repeat sudden-death overtime is "not offered" | SC-P3, SC-P7, RB2B-38 | D4 |
| 6 | Editor fields for `carrom:pointsPerCoin`, `cricket:minOversForResult`, `cricket:superOverStillTied`, `football:concussionSubs`, `football:rollingSubs` | ruling 157, R157-1..5, M13, P1 | D5 |
| 7 | Delete generic `progressScore` | A14 | D6 |
| 8 | Rule rows for about 35 behaviours the engine already has | INV §2–§4 | D7 |
| 9 | Refuse a coarse chase total past the target (RB2A-22); DLS NRR credit, ICC 16.10.7 (RB2A-20), for every cricket match (no cricket in prod) | SC-C4, SC-C3, SC-C5 | D8, D18 |
| 10 | Tennis: refuse 8–6/9–7 at TB 6-all and 5–3 at Fast4 (SC-S1); refuse best-of-1 with a match tie-break (RB2A-13); short sets with a TB at 4-all and Fast4 at 3-all, a per-tie-break `winBy`, refuse 5–3 in the 3-all form (RB2A-12) | SC-S1, SC-S2, RB2A-12/13 | D8 |
| 11 | Ruling 31's set-target floor of 5 for volleyball and table tennis | ruling 31 | D8 |
| 12 | Chess: the result method must agree with the winner (a decisive stalemate or a drawn checkmate is refused) | RB2B-20, SC-O10 | D8 |
| 13 | Shoot-out series order (IIHF 84.4, FIH App 12): verify; fix only if the pad refuses a legal order | RB2B-10 | D8 |
| 14 | Engine bound for a limit the pad alone enforces today: carrom `game.adjust` delta. (SC-O11, the generic 500 cap, is dropped: it is a test sentinel, not a rule, E16) | SC-O9 | author's call (D8's rule: a fix to something already offered that can record a wrong result) |
| 15 | Generator breadth G1–G8 and G12, plus W2e's new paths (sanction endings, 3×15, tennis short sets) | INV §5, checklist §4 | D9 |
| 16 | The W2 truth run: the CI dispatch for the base scenarios plus W2e's new scenario keys run locally, judged against the committed baseline by a judge that counts and refuses unexpected skips | TR-W2, design §8 | D9 as amended by D16 |
| 17 | MD-1, scoped (§11) | IDX:4427-4470 | D10 |
| 18 | Hockey "3 / 2 / 1 / 0 (shoot-out)" preset hidden where it equals the stage's effective default: **already shipped** by W2d m5 (E12); W2e adds no work, only a pin test if a W2e change moves what hockey's default pays | Q-W2d-1, IDX:4283 | D11 (a) |
| 19 | Both standings endpoints serve `rank: null` while the table is level, at serialisation only; OpenAPI updated | Q-W2d-2, IDX:4285 | D11 (b) |
| 20 | Checklist leftovers: `core.suspend`/`resume` row for goal sports (X6a); tennis TB guard driven from cfg in the harness (CL7-3); timeless-innings NRR row (A10) | INV §2, §5 | author's call (checklist is binding) |

### 2.2 Non-goals, each with its owner

| Item | Owner |
|---|---|
| Result-only final-score entry for football, hockey, ice hockey (RB2B-39, SC-P12) | a post-W2 wave (D8) |
| Carrom game-level result entry (RB2B-26, SC-O6) | a post-W2 wave (D8). The engine bound on `game.adjust` (SC-O9) stays in W2e, #14 |
| Futsal variant (RB2B-32, SC-P11) | a post-W2 wave (D8) |
| 5-ball overs beyond The Hundred's shipped preset (RB2A-26) | not built (D8). The shipped `hundred` preset itself is fixed in W2e (D19) |
| Coarse super-over entry (SC-C8) | not built (D8); super overs stay ball-by-ball |
| Badminton team ties (RB2A-32); draws on a ladder (SC-P13) | not built: a "refuse / by design" row (D8) |
| Repeat sudden-death overtime | not offered (D4); a `deviation` row |
| Older mutation survivors outside §11's scope, including `competition/stage.ts`, `progression.ts` and the other `sport/*` files (MD-X1, MD-X2) | the mutation session, as its own wave, not a prod gate (D10) |
| Points deduction (RB2A-28, RB2B-35) | W5 (already routed) |
| Two-leg aggregate and away goals (X6b) | W4 (already routed) |
| The FIH overtime cfg; the player-stat games tie-break | the rules backfill wave (rulings 203, 214 (2)) |
| Release steps the owner runs: the staging check, `data-audit.sql`, the es/fr/nl translator pass, `post-deploy-pin.ts --check` | the owner, at release (IDX:4272-4280). W2e adds its own audit counts to `data-audit.sql` (§9) |
| `scripts/smoke.ts` | the smoke split has landed (`scripts/smoke/suites/<x>.ts`, a `suite()` call in `main.ts`, the cleanup list in `harness.ts`, `SELECTABLE_SUITES`). W2e adds steps there and never edits `scripts/smoke.ts` |
| The five export "Owed" rows PR #1061 adds to `_INDEX` (cricket NRR absent from the export, "—" vs 0, `formatMetric`, no e2e, the doc-render grid) | the #1061 export stream (session f-w2d), before W2 closes (D17). W2e's fold checks they are closed or carry an owner verdict. When the export gains NRR, it reads the same standings NRR as the public table |
| A player-tracking count for hockey and ice hockey (injuries and exits against the roster) | not built (D15). A team that cannot continue is ended by the organiser's existing abandon or award |
| The M12b retirement control in cricket and generic | not built: a cricket retirement does not lower the all-out count, and generic refuses lineup events (`LINEUP_NOT_SUPPORTED`). Disposition rows say so |
| Generic score cap of 500 in the engine (SC-O11) | dropped: it is a test sentinel, not a rule (E16) |

### 2.3 Anti-goals (each is a test, §12)

1. **A finished match whose result moves.** No W2e rule may refold an existing ledger to a different outcome. Every new
   refusal is a WRITE-path refusal, and replay stays lenient, in the shape W2d used for `GOAL_KIND_REQUIRED`. A
   disqualification ending is a recorded event, not a new reading of an old sanction (§5.2).
2. **An existing division that changes format.** Making 3×15 the default must not change any badminton division or stage
   that exists when W2e ships, including prod's one competition, a Swiss badminton one (W2d B1). See §5.1. Where a fix
   must change stored data, it does so by a migration announced loudly (D18), never by a silent default change.
3. **A visible control that does nothing.** No setting, option or preset W2e ships or keeps is inert. This covers the
   five ruling-157 fields, the `boundary_count` option (§6.1), the hockey preset (D11 a) and the deleted keys.
4. **A penalty point counted twice.** No sanction awards a point, a game or a set by itself (D3 (2)).

## 3. Decisions (owner, 2026-10-28, session f-w2e)

Verbatim answers are in `decisions.md`. Each gets a ruling number at the fold.

| D | Q | Owner's choice |
|---|---|---|
| D1 | Q1 | BWF 3×15 ships **inside W2e**, not as a standalone PR ("inside") |
| D2 | Q2 | 3×15 is the badminton **default from the day W2e ships, with no date check** ("we don't want to check and just show by default now") |
| D3 | Q3 | Approved package: (1) a disqualifying sanction (badminton black card or disqualification, tennis `default`, volleyball disqualification or an expulsion that leaves the team incomplete — volleyball amended by D12) ENDS the match; the sanctioned side loses, credited through W2b's retirement path X-RT-1. (2) Penalty points and games stay entered as a rally or game, never auto-awarded. (3) Hockey and ice hockey below `strength.min`: no automatic ending; a pad warning; the existing abandon or award ends it; M12b's 21 "team plays short" cases get their screen path. (3) amended by D15: no warning |
| D4 | Q4 | Repeat sudden-death overtime is **not offered**. Delete the dead `shootout.suddenDeath`. A rule row records it (RB2B-38) |
| D5 | Q5 | All five ruling-157 keys become plain fields in the existing stage-rules editor (W2c pattern), 1280 sign-off, 4 locales, and the ratchet brought to zero. The `boundary_count` option of `superOverStillTied` is hidden unless boundaries can be derived from ball-by-ball scoring (SC-C6) |
| D6 | Q6 | Delete generic `progressScore`: the key, the v1 import's write, and the Advanced-box placeholder. Old saved configs read without error (the key is stripped) |
| D7 | Q7 | About 35 row-only items: a signed rule row plus a proving test for every rule that changes a result and every mechanic that changes the score or who is on the field. Record-only mechanics get a "record-only: no effect on the result, owned by the scoring-pad programme" disposition with no test. Batched one task per sport |
| D8 | Q8 | Leftover rulebook items IN: RB2A-22, RB2A-20, RB2A-13, RB2A-12, RB2B-20, RB2B-10 (verify first). OUT to a post-W2 wave: RB2B-39, RB2B-26, RB2B-32. OUT: RB2A-26, SC-C8. Rule row "refuse / by design": RB2A-32, SC-P13. Plus the two bugs (tennis SC-S1, ruling 31's floor). The rule behind it: W2e takes fixes to things the product already offers that can record a wrong result; new entry paths and variants wait |
| D9 | Q9 | Generator breadth (G1–G8, G12, plus W2e's new paths), batched by stream, then ONE W2 truth run by CI dispatch, judged against the committed baseline, gates the merge. Every red is fixed in W2e or gets an owner "not built, because…" |
| D10 | Q10 | **MD-1 amended:** one CI Stryker sizing dispatch at W2e's start; W2e kills or classifies the survivors on every line it changes, plus the result-deciding paths (§11); the remainder, including MD-X1 and MD-X2, goes to the mutation session as its own wave, NOT a prod gate |
| D11 | Q11 | (a) The hockey "3 / 2 / 1 / 0 (shoot-out)" preset is hidden wherever it equals the stage's effective default, and kept where it differs (the `presetOffered` rule). (b) The public level table serves `rank: null` while the table is level, and the OpenAPI spec says so |
| D12 | Q12 (builder check) | **Volleyball amends D3 (1):** a disqualification or expulsion never ends a volleyball match by itself (FIVB: the team plays on while it can field six). Right after one, the pad asks "Can <team> still field six players?". "No" records the existing incomplete-team ending (VB-RT-1, FIVB 6.4.3); "yes" plays on. Badminton's black card and tennis's `default` still end the match automatically. No court-strength count is built (ordinary indoor fixtures have no lineup, `setbased/kernel.ts:960-975`) |
| D13 | Q13 (plan) | **A narrow scorer exception to organiser-only endings.** A scorer (device link or official scorer) may send `core.forfeit{reason:"disqualified"}` only as the event right after an ending-level sanction (badminton black card, tennis `default`) against the same side, and `core.forfeit{reason:"retired"}` only right after a volleyball disqualification or expulsion against the same side. Every other `core.forfeit` stays organiser-only (403) |
| D14 | Q14 (plan) | **DLS NRR is frozen per match.** New divisions save the ICC 16.10.7 method explicitly in their cricket config; the parse default stays today's method, so existing divisions and their fixtures keep it. No finished table moves, now or later. A division running across the release keeps the old method to its end. **Superseded by D18** |
| D15 | Q15 (plan) | **Amends D3 (3):** no "below strength minimum" warning (`strength.min` is a penalty floor, and nothing feeds injuries into strength). The M12b retirement path stays; the organiser's existing abandon or award ends a match a team cannot continue |
| D16 | Q16 (plan; owner: "apply rec") | **Amends D9's wording:** the truth run is the CI full-scope dispatch for the base scenarios plus W2e's new scenario keys run locally with `--scenario` (the W2a/W2b precedent), both attached to the PR. The judge prints compared and skipped counts and fails on any skip not listed as expected |
| D17 | Q17 (plan; owner: "apply rec") | PR #1061's five export "Owed" rows are owned by the #1061 export stream, not W2e; W2e's fold checks their state before W2 is called closed |
| D18 | owner, on the plan ("no crickets are in prod data so no need to write some workaround, always louad when data changes and need migration before deploying") | **Reverses D14:** there is no cricket in prod, so ICC 16.10.7 NRR applies to every cricket match, with no method key and no freeze. **Standing rule:** a change that moves stored data is announced loudly (this spec, the PR body's "Data changes" section, the release notes) and ships a migration that runs before deploy, never a code workaround that keeps old rows on old behaviour (§9) |
| D19 | Q19 (build; T0 review finding E31) | **The Hundred is fixed in W2e** ("a", after first choosing "b" and then a sizing of ~1 task). D8's "5-ball overs not built" rested on a false premise: cricket ships a selectable `hundred` variant (100 balls, 5-ball overs). The overs editor (`lib/match-rules/cricket.ts:14,18`) and the NRR display (`competition/display.ts:98`) assume 6-ball overs; both use the variant's `ballsPerOver` instead. The NRR scale follows the ECB's stated convention for The Hundred (quoted by the task) |

**Rulings implemented, not changed:** 12 (never per-fixture points or tie-breaks); 31 (set-target floor, now applied);
42 (every possibility owned, §2.2); 75 (rules reference rows); 108 as amended by W2d D6; X-RT-1 with rulings 113, 115 and
118; 157 (closed by D5); 213/214 (no prod release until all of W2 is done); W2a-R4 (3×15 in W2e), now taken.

## 4. False premises found (for `_INDEX` at fold)

| # | Premise | Truth | Evidence |
|---|---|---|---|
| E1 | The W2e bullet is at IDX ~:3856 and the MD-1 table at ~:1966 (10-25 handover) | IDX:4222 and IDX:4427-4470 | INV FP1 |
| E2 | `w2-start-prompt.md` exists only on the owner's machine | It is in the main checkout, `.superpowers/handoff/2026-10-08-w1d-close/` | INV FP2 |
| E3 | `apps/web/src/lib/match-rules.ts` holds the editor rules | It is now the directory `lib/match-rules/` (index plus one file per sport). Every `match-rules.ts:NNN` pin in IDX, RBS BD-3, the AUDIT-LEDGER and `wave-fix-location.md` is stale | INV FP3 |
| E4 | The 14 "absent" checklist rules need engine builds | For 8 of them the engine already implements the rule; only the row and a test are missing. All 19 in-match mechanics exist too. Only the sanction endings, `strength.min`, timeless NRR (partly) and `progressScore` need engine behaviour | INV FP4 |
| E5 | `tennis.game.award` is absent (AUD row 20) | It ships, with its pad action (S5 #431) | `nested/kernel.ts:336-352,1598,1665-1701` |
| E6 | Ice hockey has `releaseOnGoal` | The behaviour is `releaseForGoal` | `period/kernel.ts:1184-1186` |
| E7 | Football shoot-out attempts are fixed at 5 (SC-P7) | Configurable since W2c (FB-SO-1). Only the dead `suddenDeath` half stands | `football.ts:120,2541` |
| E8 | `competition/display.ts:72` hard-codes 6 balls (SC-C7) | Still true, now at `:98` | INV FP8 |
| E9 | Cricket `points.draw` is absent (checklist §1) | Closed by W2d (CK-PT-2, ruling 197) | `cricket.ts:68` |
| E10 | The older `competition/stage.ts` and `progression.ts` survivors are W2c's | W2c held 0 on that row. Nobody owned them, so D10 routes them to the mutation session | IDX:2133-2140 |
| E12 | The hockey "3 / 2 / 1 / 0 (shoot-out)" preset is still offered where it changes nothing (IDX:4283, the basis of Q11 (a)) | Already resolved by W2d final-review m5 (#1053): `presetOffered` hides a chip that pays what the stage plays on every reachable outcome (`splitsLost` over the engine's `reachableOutcomes`); a chip the draft already is stays, pressed. IDX:4283's "Need an owner ruling" is stale | `components/v2/stage-rules/stage-points-model.ts:618-629` (checked by f-w2d at `b07f358d8d`, re-read here at `655138c4c7`) |
| E13 | A level table's API rows say nothing about being level (the basis of Q11 (b)) | Every row already carries `level: true` (`rankStandings`; `isLevelTable` at `competition/display.ts:183`), documented at `server/api-v1/openapi.ts:154`. Only `rank: 1..n` misleads | f-w2d, verified at `openapi.ts:154` |
| E11 | 3×15 needs new engine fields | The set kernel already has `setTo`, `finalSetTo`, `winBy` and `cap`, and the pad's interval at 8 is already right. Only a variant, the default and a migration check are owed | `setbased/badminton.ts:20-43`; INV §1 |

Found at plan phase (2026-10-28; scouts' code-facts files in the handoff folder, f-w2d's seam check):

| # | Premise | Truth | Evidence |
|---|---|---|---|
| E14 | 3×15 as the default may need a migration if stored configs rely on module defaults (§5.1 as approved) | Divisions store the fully parsed config, and fixtures freeze their config at the first event: no migration. But the `bwf` variant is `{}` (the defaults), so changing `defaults` would silently turn the variant labelled 3×21 into 3×15. 3×15 becomes a new explicit variant, made the preferred pick | `divisions.ts:312-318,376`; `templates.ts:251-281`; `fidelity.ts:34-37`; `append-event.ts:457,649`; `division-builder.tsx:57-69` |
| E15 | Config refusals (ruling 31, SC-S2) are `configSchema` refines | A refine makes every read of a stored config that breaks it throw | `competition.ts:116`; `points.ts:278,447`; `fidelity.ts:57` |
| E16 | Generic's 500 cap is a rule the engine should enforce (SC-O11) | It is a test sentinel | code-facts-2 |
| E17 | W2d's table-rules pin protects finished tables from an NRR change (§5.6 as approved) | NRR is computed at standings time from match states, and `table_rules_pinned` holds only points, tie-breakers and cross-group | `cricket.ts:3917`; `competition.ts:469`; V475:58 |
| E18 | Hockey and ice hockey can tell when a team is below its minimum (D3 (3)) | `strength.min` is a penalty floor in `strengthOf`; injuries never reach strength; the strength chip clamps at it | `period/kernel.ts:2480`; `period/suspensions.ts:196-197` |
| E19 | The pad can send X-RT-1's disqualification ending after a sanction | The ending is `core.forfeit{reason:"disqualified"}` (volleyball's incomplete team is `"retired"`), and it is organiser-only: a scorer's append gets 403 | `lib/organiser-only-events.ts:10`; `scoring.ts:578` |
| E20 | "One truth run by CI dispatch" covers W2e's new scenarios (D9) | `matrix-truth.yml` full scope plans only the base scenarios; W2a/W2b's ran locally with `--scenario`. And `judge regression` silently skips a baseline case missing from `--expect` | `tools/matrix/lib/judge.ts:131` |
| E21 | The rulebook is silent on RB2A-12's short-set tie-break targets | RBS gives both forms: first to 4 games, tie-break first to 5, deciding point at 4–4 | RBS:76, :82-84, :347 |
| E22 | A new tennis variant gets a golden stream automatically | `MAX_CONFIGS = 4`, and tennis is already at 4: a fifth config is silently unrecorded | `testkit/golden.ts:98,250` |
| E23 | An old config carrying `shootout.suddenDeath` reads without error once the key is deleted | `shootout` is a `z.strictObject`: an unknown key throws unless explicitly stripped | `period/kernel.ts:218-225` |
| E24 | `rank: null` belongs in `getStandings` | `getStandings` also feeds the division page and the slideshow; the null belongs in the two route handlers. The public route is SWR-cached for 300 s | `stages.ts:5254`; `stages/[id]/standings/route.ts:12`; `public.ts:76` |
| E25 | The scoring route is the only strict write path | Event import is a second (`event-import.ts:310`). The pad's own local fold is non-strict (`pad-host.tsx:1011`), so the pad must block scoring itself after an ending sanction | f-w2d seam check |
| E26 | New API error codes are documented in the OpenAPI spec (§7 as approved) | They are documented in `docs/api-v1-breaking-changes.md` and the developers changelog | code-facts-4 |
| E27 | Rule rows are signed `signed W2e-D<n> 2026-10-28` (plan Task 0 and Global Constraints) | The status check (`RULE_STATUS`) accepts only a numeric ruling, so the first such row reds "every status is signed <ruling> <date>"; W2e has no ruling numbers until the fold. A0 widened the token to `W2e-D<n>` (commit `b3b1c8b6eb`, test-first, mutated once); the fold rewrites the statuses to real ruling numbers and drops the alternation | `testkit/rules-reference.ts:19`; `test/rules-reference.test.ts:95` |
| E28 | The net-run-rate rows are `CK-NRR-1` and `CK-NRR-2` (plan Tasks 8 and 14) | A rule id is `<1-3 letters>-<exactly 2 letters>-<n>`: the checker refuses a 3-letter area, and W2a's mutant files pin the regex text, so widening it is the costlier fix. The rows are `CK-RR-1` (ICC 16.10.7 operands) and `CK-RR-2` (timeless innings). Plan Tasks 8 and 14 and every test title must say `CK-RR-*` | `testkit/rules-reference.ts:22,24`; `mutants/w2a/t2.json:155,935` |
| E29 | The old app, still serving between the Flyway migrate and the deploy, reads a migrated config without error because "the deleted keys have zod defaults" (plan Task 0 (d)) | True for generic `progressScore` (`.default(false)`) and for tennis `set` (a non-strict object, the added `tiebreakWinBy` is stripped). False for `shootout.suddenDeath`: it is a required `z.boolean()` in a strict object, with no default. Driven on a local server with the key removed from an ice-hockey division, its frozen config and its match state: the event route and the state read still work (no engine code reads the key), but `PATCH /divisions/{id}` with the stored config answers 422 `CONFIG_INVALID` "invalid icehockey config" at `shootout`. Prod's own tag (v1.0.7-beta) has the same required key. Affected for the window: any hockey or ice-hockey division with a shoot-out configured (stg: 6 ice-hockey divisions, 0 hockey) | `period/kernel.ts:218-225`; live drive in A0.5 (d) |
| E30 | The ITF Rules of Tennis 2026 PDF can be fetched for the Appendix VI quote (plan Task 0 Step 3) | `itftennis.com` answers every non-browser fetch with an Incapsula bot challenge (a 212-byte HTML stub). The Appendix VI text in A0.2 is verbatim from Tennis Canada's "Rules of the Court 2026", which reproduces the ITF text; the ITF PDF itself was not read | A0.2 |

The plan adds any premise it disproves, in the same table.

## 5. Engine design

### 5.1 BWF 3×15 (D1, D2)

- A `bwf-3x15` variant in `sports/setbased/badminton.ts`: `bestOf 3, setTo 15, finalSetTo 15, winBy 2, cap 21`. The
  interval follows the kernel's existing mid-game rule (8 at 15, INV).
- **The default becomes 3×15** (D2), with **no migration** (E14): divisions store the fully parsed config and fixtures
  freeze theirs at the first event, so no existing badminton division moves.
  - The module `defaults` do NOT change: the `bwf` variant is `{}`, so changing them would turn the variant labelled
    3×21 into 3×15. **Author's call:** `bwf` also gets its values written explicitly (`setTo 21, finalSetTo 21, cap 30`),
    so no later default change can move it either.
  - New divisions get 3×15 through the creation pick: `PREFERRED_VARIANT` / `pickVariant`
    (`components/v2/division-builder.tsx:57-69`) and the funnel's pick (`funnel.ts:84-90`).
  - Badminton's goldens are folded under the defaults, so 3×15 needs no re-record and no epoch bump of its own.
  - The plan verifies that switching variant in Settings applies the variant's fields (the inferred risk: the switch
    keeps `setTo 21`).
- `bwf` (3×21) and `short` stay selectable. Variant pickers print the raw `sport_variants` name
  (`scripts/sync-sports.ts:74`), so the variants W2e touches get labels through `lib/variant-label-keys.ts`, in all 4
  locales, with the raw name as fallback.
- **A consequence the owner accepted with D2:** between W2e shipping and 2027-01-04, new divisions default to 3×15 while
  3×21 is still the BWF law. The editor's variant hint names both, with the date.
- **Author's call (the deadline):** at the mid-November checkpoint, if the plan shows W2e cannot merge by 2026-12-01,
  this item is split out as the standalone PR W2a-R4 describes, and the owner is told. D1 keeps it inside W2e
  otherwise.

### 5.2 Disqualifying sanctions end the match (D3 (1))

Which sanction levels end a match, per sport (from the module declarations; the plan re-reads them):

| Sport | Ending level(s) | Today |
|---|---|---|
| Badminton | `disqualification` (black card) | record only (`badminton.ts:69`, `setbased/kernel.ts:767-775`) |
| Volleyball | none automatically (D12). After a `disqualification` or `expulsion`, the pad asks whether the team can still field six; "no" sends the existing VB-RT-1 incomplete-team ending | record only (`volleyball.ts:119`); VB-RT-1 covers the incomplete-team retirement entered by hand |
| Tennis | `default` | record only (`nested/kernel.ts:264-269,1097-1105`) |
| Table tennis | none: ITTF levels are warning and penalty only (`tabletennis.ts:76`) | unchanged |

**Author's call (how, so no old match moves; anti-goal 1):** the ending is a recorded event, not a new meaning of the
sanction event.

- Core declares, per module, which sanction levels end a match (a module declaration read by core and the pad), so
  no sport's list is typed twice.
- The pad records an ending sanction as TWO appends in sequence through the existing scoring route
  (`POST /fixtures/{id}/events`, one event per request, each with its own `expected_seq`): first the `sanction` (for the
  record and the sheet), then X-RT-1's ending, `core.forfeit{reason:"disqualified"}` (E19), against the sanctioned
  side. **Author's call:** no new batch route; `runAmend` (`pad-host.tsx:1587`) is the two-event precedent. This reuses
  the retirement credit and the player-stats rules of rulings 113, 115 and 118 unchanged.
- **D13:** `core.forfeit` is organiser-only (`lib/organiser-only-events.ts:10`). The organiser-only check gains one
  exception: a scorer may append `forfeit{disqualified}` when the ledger's last live event is an ending-level sanction
  against the same side, and `forfeit{retired}` when it is a volleyball disqualification or expulsion against the same
  side. Any other scorer forfeit still gets 403.
- **Undo (author's call):** `core.void` of the ending re-opens the pad's ending prompt, and the refusal below applies
  again. The scorer either confirms the ending again or voids the sanction too, which lifts the refusal and lets play
  continue. Voiding the sanction while its ending stands leaves the ending in place (an ending is undone only by voiding
  it). The tests cover all three sequences, plus a failed second append (the sanction is recorded, the ending is not,
  and the pad offers the ending again on reload).
- The write path refuses any further scoring event after an ending-level sanction that has no ending (a new 4xx code,
  named in the plan, in the `GOAL_KIND_REQUIRED` shape). Both strict write paths enforce it: the scoring route and event
  import (E25). The pad's local fold is non-strict, so the pad itself stops offering scoring while the ending is
  pending. Replay stays lenient, so a ledger written before W2e that holds a black card followed by more rallies still
  folds exactly as it does today.
- The set and nested `arbitraryEvent` generators follow an ending sanction with its forfeit, so property tests never
  build a ledger the write path would refuse. The one badminton and two tennis golden streams that carry an ending
  sanction are re-recorded.
- Volleyball (D12) needs no new engine ending and no write-path refusal: the sanction stays a record, and the
  incomplete-team ending is the existing VB-RT-1 event, sent by the pad's question. The rule row cites the FIVB
  articles for disqualification, expulsion and the incomplete team (6.4.3).
- Each affected sport (badminton, tennis) raises its `FOLD_EPOCH` MAJOR (`sport/fold-epoch.ts`) because the write path refuses something it
  used to accept, and its golden streams are re-recorded as needed. The comment block there gets W2e's line.

### 5.3 Penalty points stay rallies (D3 (2)); teams that play short (D3 (3), D15)

- No engine change for penalty points and penalty games. Rows record the rule (A2, A5), with a test that a penalty
  sanction alone changes no score.
- Hockey and ice hockey: no ending, no warning, no engine change (D15, E18). The rule row records that `strength.min` is
  a penalty floor and that the organiser's abandon or award ends a match a team cannot continue.
- M12b: `core.lineup.retirement` already exists in the engine; no pad sends it. The pad control is §6.2's.

### 5.4 Deletions (D4, D6)

- `shootout.suddenDeath`: removed from `period/kernel.ts:100,222`, `hockey.ts:145`, `icehockey.ts:166`, the web match
  rules (`lib/match-rules/hockey.ts:30`, `icehockey.ts:68`), the testkit (`testkit/golden.ts:1010,1123`,
  `simulation.ts:100`) and the matrix catalogue (regenerated). It has no reader (INV, git grep), so no fold changes.
  `shootout` is a strict object (E23), so the schema strips the key explicitly before the strict parse; an old saved
  config that carries it then reads without error. A test proves that with a recorded config. Stored configs are
  cleaned by §9's migration (D18); the strip stays for incoming writes from older clients.
- Generic `progressScore`: removed from `sports/generic/generic.ts:51-53` and the defaults at `:611,617`; the v1 import
  (`server/migration/v1-map.ts:84,108`) no longer writes it; the Advanced-box placeholder
  (`components/v2/division-settings.tsx:1365`) shows a key that works; `funnel.test.ts` and `forfeit-tag.test.ts`
  fixtures are updated. Old configs strip on read, with a test.
- **Author's call:** each module whose cfg schema loses a key raises its `FOLD_EPOCH` MAJOR only if the epoch guard's own
  rule (a phone that still sends the key has it stripped) requires it. W2c and W2d raised the epoch for the same kind of
  change, so the plan applies the guard's rule rather than deciding afresh.
- **Epochs owed, as the plan-phase read found them** (each re-checked by its task):

  | Sport | Epoch | Why | Goldens |
  |---|---|---|---|
  | cricket | 1 → 2 | SC-C4 refusal | goldens 24 and 29 re-recorded (Task 6) |
  | hockey | 4 → 5 | `suddenDeath` deleted; RB2B-10 if fixed | — |
  | ice hockey | 2 → 3 | `suddenDeath` deleted; RB2B-10 if fixed | — |
  | tennis | MAJOR | `default` ending, SC-S1, RB2A-12 | goldens 23 and 29, plus the 2 carrying an ending sanction |
  | badminton | MAJOR | black-card ending | the 1 carrying an ending sanction (3×15 itself re-records nothing, §5.1) |
  | generic | MAJOR | `progressScore` deleted | 106 golden states |
  | volleyball, table tennis | as the guard's rule says | ruling 31 is a write-path validator, not a fold change | — |
  | boardgame, carrom | as the guard's rule says | RB2B-20, SC-O9 are strict-only | no re-record |

### 5.5 Refusals for impossible scores (D8, #14)

Each is a write-path refusal with a named error and a locale string. Replay stays lenient (anti-goal 1). Event
refusals sit behind the strict flag in `apply`, in the `GOAL_KIND_REQUIRED` shape, because payload schemas are
re-parsed on replay. Config refusals are **write-path validators** on the division and stage write routes, never
`configSchema` refines (E15).

| Item | Rule | Where |
|---|---|---|
| SC-S1 | A tennis set summary is refused unless the score before its last game is a reachable live score under the set's tie-break, walking back to 0–0 (so 8–6 or 9–7 with the TB at 6-all, and 5–3 in a Fast4 3-all set, are refused) | `nested/kernel.ts:1370-1375` |
| SC-S2 / RB2A-13 | Best of 1 with a match tie-break as the final set is refused when a config is written | `nested/kernel.ts:202-205,859-869` |
| RB2A-12 | Short sets: a "TB at 4-all" variant beside the existing Fast4 3-all one; a per-tie-break `winBy`, separate from the MTB's; 5–3 refused in the 3-all form. The Fast4 tie-break default becomes margin 1 (the deciding point at 4–4); existing Fast4 configs are pinned to margin 2 by §9's migration. Targets from RBS:76, :82-84, :347 (E21): sets first to 4 games, the tie-break first to 5, the deciding point at 4–4. **Author's call:** the 4-all form uses ad scoring unless ITF Appendix VI says no-ad; the plan quotes the Appendix VI text. Golden `MAX_CONFIGS` is raised so the new variant is recorded (E22) | `tennis/tennis.ts:27-45`, `nested/kernel.ts:160`, `testkit/golden.ts:98,250` |
| ruling 31 | Volleyball and table tennis refuse a set target below 5 when a config is written | a write-path validator |
| SC-C4 / RB2A-22 | A coarse chase total above `target − 1 + 7` is refused (the bound RB2A-22 gives) | `cricket.ts:1663-1723` |
| SC-O10 / RB2B-20 | A chess result whose method contradicts its winner is refused | `boardgame/boardgame.ts:197-205` |
| SC-O9 | `carrom.game.adjust` is bounded in the engine by the bound the pad already uses | `carrom.ts:135-140` (pad `:741,754`) |

A config refusal (SC-S2, ruling 31) applies only when a config is written. An existing config that breaks it still
loads, and the data audit (§9) counts any such config.

### 5.6 Cricket NRR under DLS (RB2A-20)

NRR for a match decided by DLS or with revised overs follows ICC 16.10.7. The plan quotes the article and derives the
operands from it, not from today's `quota` fold (`cricket.ts:560,900-906,1127`). SC-C5's missing operand tests come
with it.

**D18, one method for every match.** NRR is computed at standings time from each match's state, and W2d's pin does
not cover it (E17), so the change reaches every cricket table. There is no cricket in prod (owner fact), so no table a
customer has seen moves: the method changes outright, with no config key and no freeze (D14 reversed). The change is
still announced in the PR's "Data changes" section (§9). Tests: a DLS match folds to ICC 16.10.7's operands, from the
rulebook's own numbers. W2d's X-PT-2/3 sweeps cannot see NRR, so these tests are W2e's own.

### 5.7 Shoot-out order (RB2B-10)

Verify first: drive a legal IIHF 84.4 and FIH Appendix 12 series order (the other team starts the next series) through
the real pad and engine. The code read suggests the engine refuses it today (`period/shootout.ts:83`,
`period/kernel.ts:1380-1385`), so the plan expects a write-path fix. If both are accepted after all, W2e adds only a
rule row and its test.

## 6. Web design

UI follows the existing patterns, correctness-first. **Author's call:** no mockup round, because every change sits in a
control pattern that already exists (W2d D11 set the precedent). Each changed screen is shown on an Artifact page for
the owner's per-screen sign-off. The frontend-design skill is used in every UI task.

### 6.1 Ruling-157 fields (D5)

- Five fields in the stage-rules editor (`components/v2/stage-rules/`), each with its sport's match-rules entry in
  `lib/match-rules/<sport>.ts`. Types follow the engine's declarations: number fields for `pointsPerCoin` and
  `minOversForResult`, a choice for `superOverStillTied`, toggles for the two football ones.
- The ratchet `stage-row-model.test.ts:91-105` goes to an empty list, and so do the three per-sport contract-test
  unfielded-key lists. A test fails if a declared stage key has no field. `concussionSubs` is a count field.
- `boundary_count` (D5): the plan checks whether ball-by-ball scoring produces the `boundaries` total that
  `superOverStillTied: boundary_count` reads (`cricket.ts:239-245`, SC-C6). If it does, the option shows. If it does
  not, the option is hidden in the editor, and the API refuses it with a named error, so no path saves an inert choice
  (anti-goal 3).
- Labels and help in all 4 locales. The existing W2c lock rules apply unchanged.

### 6.2 Sanction endings and short teams on the pad (D3)

- Badminton and tennis: an ending-level sanction asks for confirmation ("This ends the match: <side> loses"), then
  sends the two appends (§5.2). The finished-match state appears just as it does for a retirement. The sanction sheets
  are `badminton.tsx:1082` and `tennis.tsx:926`. If the second append fails, the pad blocks scoring and offers the ending
  again, including after a reload.
- Volleyball (D12): the question "Can <team> still field six players?" is a step in the sanction sheet
  (`volleyball.tsx:1250`), asked before the write, because the pad cannot ask after sending. "No" sends the sanction and
  then the existing incomplete-team ending (D13 lets the scorer send it); "yes" sends the sanction only, and play
  continues.
- Hockey and ice hockey: no warning (D15).
- M12b: the scoring screen gets the control that sends `core.lineup.retirement` ("player injured, no replacement: the
  team plays short"), which today only HTTP reaches. Only where it changes something: football, volleyball, hockey and
  ice hockey (cricket and generic get disposition rows, §2.2). Copied from the period pad's swap slot
  (`period-shared.ts:1464`), in one DOM for phone and desktop (the phone composition design of record).

### 6.3 Other web items

- Badminton variant picker shows `bwf-3x15` (default), `bwf` 3×21, `short`, with the date hint (§5.1).
- Tennis short-set variants appear in the variant picker. The editor refuses best of 1 with a match tie-break, using the
  engine's error.
- D11 (a): already shipped (E12). No change. If a W2e change moves what hockey's default variant pays, a test pins that
  the chip is still hidden there.
- D11 (b): `rank: null` on every row while the table is level (`level: true`), with these constraints (from f-w2d,
  verified):
  1. Null it at the API SERIALISATION only, never in the stored snapshot (`public_standings_v`). The PDF export,
     slideshow, OG card and digest print "–" through `rankText(row, level)`; nulling storage breaks them and reds the
     level-table sweeps.
  2. Change BOTH endpoints: the public division standings (`publicStandings`, `server/usecases/public.ts:563`) and
     `GET /stages/{id}/standings`. The public route's summary promises it serves rows "as `GET /stages/{id}/standings`
     serves it".
  3. `S.PublicDivisionStandings` and `S.StandingsSnapshot` take `rank: number | null`, with a dated breaking-change entry
     in the OpenAPI notes as W2d's m6 did. Owner fact (given to f-w2d): no client outside the web app uses the API, so no
     backward-compatibility shim.
  4. The public route is cached (`publicDivisionStandingsCacheKey`). The test reads through the cache, and the cache
     key changes or the entry is invalidated, so the old shape is never served after deploy. The HTTP layer adds
     `stale-while-revalidate` 300 (`public.ts:76`): about 330 s of the old shape after deploy is accepted and noted in
     the breaking-change entry.
  5. The null goes in the two route handlers (`stages/[id]/standings/route.ts` and the public route), not in
     `getStandings`, which also feeds the division page and the slideshow (E24). `tables-producer-consumer.test.ts`
     changes with it.

## 7. API v1 and OpenAPI

- New error codes for each refusal in §5.2 and §5.5, documented where the house documents error codes
  (`docs/api-v1-breaking-changes.md` and the developers changelog, E26), with a test that each is reachable through the
  HTTP route.
- D13's exception: a scorer's `forfeit` that matches the sanction before it is accepted; any other scorer `forfeit` is
  still 403.
- `rank` nullable on both standings endpoints, at serialisation only (D11 b, §6.3).
- Removed cfg keys (`suddenDeath`, `progressScore`) are stripped, not refused, on write. **Author's call:** refusing them
  would break any client that still sends defaults, and W2d stripped `shootoutWin`/`shootoutLoss` the same way.

## 8. Rule rows (D7)

All rows go in `packages/engine/rules/<sport>.md` and `cross-sport.md`, in the README's row format, and are signed at plan
start (ruling 75).

| Group | Ids (INV) | Row content | Test |
|---|---|---|---|
| Result-changing rules | A7 innings victory, A8 follow-on, A9 innings forfeiture, A10 timeless-innings NRR, A11 penalty runs, A12 football own goal, P1–P9 (ODI minimum overs, super-over abandon, manual revised target, two-innings abandon, football and hockey youth, boardgame abandon, carrom club-29, carrom drawn games) | the rule as the engine applies it, with its federation source | a proving test named for the id |
| Mechanics that change the score or who is on the field | M5 retire hurt/out, M7 max overs per bowler, M8 free hit (only that part of M8), M9 wicket modes, M10 concussion replacements, M11 sin bin, M13 subs, M15 hockey suspension classes, M16 goalkeeper and set pieces, M17 ice hockey suspensions and power-play release, M18 strength 5/3, X6a `core.suspend`/`resume` | as above | a proving test named for the id |
| Record-only mechanics | M1 serve order, M2 TT time-outs, M3 VB technical time-outs, subs and libero (record side), M4 tennis interruptions, M6 DRS, M8 powerplay, new ball and toss, M12 in-play penalty-kick record, M14 period length and added time, M19 carrom toss and first break | "record-only: no effect on the result, owned by the scoring-pad programme" | none (D7) |
| W2e's own rules | 3×15, the sanction endings with D13's scorer exception, penalty points as rallies, `strength.min` as a penalty floor (D15), every §5.5 refusal, DLS NRR under ICC 16.10.7 (D18), shoot-out order | the new rule | per §12 |
| Dispositions | repeat sudden-death OT (not offered), 5-ball overs, coarse super over, badminton team ties, ladder draws, the M12b retirement in cricket and generic | `deviation` or "refuse / by design" | none, beyond a refusal test where the product refuses |

**Author's call:** which group a mechanic falls in is this table's reading of INV §4. The plan re-reads each one, and
moves it to a tested group if it can change a score, never the other way without telling the owner.

## 9. Migrations and data audit

- **D18's rule:** a change that moves stored data ships a migration that runs before deploy, and is listed loudly in the
  PR body's "Data changes" section and the release notes. No legacy parse default keeps old rows on old behaviour.
- **One migration** (main's max + 1 at rebase; whoever lands second renumbers), applied to every stored config (division,
  stage, fixture override and each fixture's frozen config):
  - removes `shootout.suddenDeath` and generic `progressScore` (§5.4);
  - writes `tiebreakWinBy: 2` explicitly into every existing `fast4` tennis config, so the corrected Fast4 default
    (margin 1, §5.5) reaches new divisions only and anti-goal 2 holds by data, not by a legacy default.
  The plan confirms that the prod deploy applies migrations before the app starts serving, and stops and asks if not.
- 3×15 and the `bwf` variant move no stored data (§5.1, E14), so they need no migration.
- "Data changes" in PR A's body, at least: the migration above; DLS NRR changes for every cricket match (none in prod);
  the new write refusals (§5.2, §5.5), which change no stored row; `rank: null` on level tables (an API shape change).
- `data-audit.sql` (W2d's, run by the owner at release) gains W2e's counts, all expected to be 0 or explained: configs breaking ruling 31's floor;
  tennis best of 1 with a match tie-break; `superOverStillTied: boundary_count` where §6.1 hid it; ledgers with an
  ending-level sanction followed by scoring. That last one is reported, not repaired: anti-goal 1 keeps those results
  as recorded.

## 10. Generator breadth and the W2 truth run (D9)

- Streams in `tools/matrix/lib/streams/`: football extra time and shoot-out (G1, G2), period overtime, the
  shoot-out/GWS (G2, G3), cricket super over and DLS (G4, G5), set sports' deciding set beyond best of 1 and the
  badminton cap at 3×21 and 3×15 (G6, G7), tennis tie-break sets and the short-set variants (G8), and a sanction token
  for the five sanction sports, including the D3 endings (G12). `streams/known-unsupported.ts` stays empty, or names the
  owner's verdict for each entry.
- Every new stream states how many cases it generated per sport and refuses to run on zero (TEST-STRATEGY
  anti-vacuity).
- The generator lanes share `types.ts`, `outcomeLabel`, `matchesRequest`, the pad adapters and `streams.test.ts`, so
  they run in sequence (or in worktrees merged in order). `ALL_OUTCOMES` is frozen (`w2a-streams.test.ts:460`); a new
  outcome extends it on purpose, with the test updated in the same commit. "The five sanction sports" is defined
  nowhere in code: G12's stream derives its sport list from the modules that declare sanction levels, and reports the
  count.
- **The truth run (D16):** after both PRs' content is on the W2e branch, (1) one CI full-scope dispatch
  (`matrix-truth.yml`, `scope=full`) for the base scenarios, and (2) W2e's new scenario keys (G1–G8, G12, the D3
  endings, 3×15, the tennis short sets) run locally with `--scenario`, as W2a and W2b did. Both are judged with
  `judge regression` against the committed baseline. The judge is changed first to print compared and skipped counts
  and to fail on any skip not listed in a committed expected-skips list, because 3×15 renames badminton cases and the
  judge silently skips a case missing from `--expect` today (E20). The README, verdicts and both runs' outputs are
  committed under `truth-runs/w2e-final/`, in the shape of `w2b-final`. Each red is fixed in W2e, or listed with the
  owner's "not built, because…". The merge waits on it.

## 11. MD-1 scope (D10)

- **Sizing:** at W2e's start, one CI Stryker dispatch (or per-leg `mutation.yml` dispatches) over the sport modules,
  `core/*`, `stats/stats.ts` and `sport/module.ts`. Its per-file counts go into the plan.
- **W2e owns:** every Survived or NoCoverage mutant (a) on a line W2e changes, and (b) on these result-deciding paths,
  whether W2e changes them or not: match end and the outcome fold in each kernel; overtime and the shoot-out in the
  period kernel and football; the super over and DLS in cricket; set end and the cap in the set and nested kernels; and
  the abandon and award credit. The plan names the functions after sizing.
- **Killed or classified:** killed by a test, or classified in `stryker-equivalent.json` (line-keyed rows, re-keyed when
  lines shift). `stryker-measured.json` and `stryker-timeouts.json` are not touched; they belong to the mutation session.
- **Routed:** everything else, including MD-X1 and MD-X2, goes to the mutation session as a wave of its own. IDX's
  MD-1 table is amended at the fold to say so. It is not a prod gate.

## 12. Testing

House rules bind (TEST-STRATEGY.md): every expected value comes from the rulebook or the engine's own declarations, never
from the code under test; every sweep reports its count and fails on zero; each new guard is mutated once before it is
called green; sequences, not just the feature (a second call, an empty input, after a void or withdrawal, another sport).
Scoped tests only, never the full suite locally. vitest from `apps/web` or `packages/engine` with the JSON reporter, with
`.testResults[].name` checked and `EXIT=0` required.

| Type | What W2e owes |
|---|---|
| Unit (engine) | Each §5 rule, with the rulebook article in the title; anti-goal 1 as a replay test per new refusal (a pre-W2e ledger that breaks the new rule folds to its recorded result); anti-goal 4 (a penalty sanction alone moves no score); deleted keys strip on read with a recorded config; every sport the engine declares, enumerated, for each cross-sport rule (the sanction endings, epoch bumps, strip-on-read) |
| Unit (web) | The ratchet at zero; the field model per sport; `rank: null` exactly when `level` is true, on both endpoints and through the public cache, with its positive pair, and the stored snapshot still holding `rank 1..n` (so `rankText` consumers are unchanged); every new string in all 4 locales (the generated key list regenerated) |
| Parity | W2d's X-PT-2/3 table-points sweeps stay green. A red from a W2e fidelity change is examined and either is the intended change (with a row) or is a defect |
| Integration (server) | The write paths for each refusal through the real route (HTTP status and code) and through event import; the two-event disqualification write by a scorer, and a scorer forfeit without the matching sanction still 403 (D13); the M12b route from the screen's real payload |
| E2E | The stage editor's five fields; the sanction confirmation and ending on the badminton and tennis pads, sent by a scorer (D13), and the volleyball "still field six?" question both ways; the M12b control; the badminton variant default. Each spec runs whole (no `-g`), at all seven widths, by CI dispatch (`gh workflow run e2e.yml --ref <branch> -f pr=N`); a push cancels it |
| Smoke | One step per new refusal code and for `rank: null`, in the smoke session's split layout |
| Regression | The W2 truth run (§10) against the committed baseline |
| Mutation | §11, per engine task, right after its review |
| Visual | The changed screens at 1280, 320 and 768 on an Artifact page, with per-screen verdicts from the owner |

Seams are proven through their real producer and consumer (AGENTS.md class 1): the sanction ending is driven from the
pad's own action, through the route, the engine and standings, not from a fixture on both ends.

## 13. Delivery: batches and PRs

**Author's call:** two PRs, as W2d did (learning 8): PR A carries the engine, rules and harness, with any migration
frozen at its merge; PR B carries the web. The truth run waits for both, on the PR B branch after PR A merges.
Batches inside a PR run in parallel only where their file sets are provably disjoint; otherwise they run in sequence or
each in its own worktree (AGENTS.md).

### PR A — engine, rules, harness

| Batch | Tasks (parallel lanes are disjoint by file) | Depends on |
|---|---|---|
| A0 Setup | Re-pin every citation in this spec on fresh main; the MD-1 sizing dispatch (§11); the §5.1 creation-seam check (which pick reaches every badminton and cricket division the product creates; the Settings variant switch); the §6.1 `boundaries` check; the §5.7 shoot-out order check; the ITF Appendix VI quote (RB2A-12); record new false premises | — |
| A1 Engine fidelity | **A1a set kernel** (`sports/setbased/*`): the 3×15 variant, `bwf` made explicit, the badminton ending level. **A1b nested** (`sports/nested/*`, `sports/tennis/*`, `testkit/golden.ts` `MAX_CONFIGS`): tennis `default` ending level, SC-S1, RB2A-12. **A1c cricket** (`sports/cricket/*`): SC-C4, RB2A-20 with SC-C5 (D18: no method key). **A1d period** (`sports/period/*`, `hockey.ts`, `icehockey.ts`, testkit): delete `suddenDeath` with its explicit strip, any RB2B-10 fix. **A1e others** (`sports/boardgame/*`, `sports/carrom/*`, `sports/generic/*`): RB2B-20, SC-O9, delete `progressScore`. Each lane: its `FOLD_EPOCH` bump (§5.4's table), its golden streams, its own rule rows, and MD-1 on its lines | A0, A1f |
| A1f Core | The ending-sanction module declaration; the "no scoring after an ending sanction" strict refusal in `core/events.ts`, on both strict write paths (route and event import); the set and nested `arbitraryEvent` generators following an ending sanction with its forfeit; D13's exception in `lib/organiser-only-events.ts`. Runs FIRST, because A1a and A1b declare into it | A0 |
| A1g Config validators | The write-path validators for ruling 31 and SC-S2 on the division and stage write routes (E15); their error codes | A1a, A1b |
| A2 Rule rows | One lane per rules file (`cricket.md`, `football.md`, `hockey.md` + `icehockey.md`, the set sports, `carrom.md` + `boardgame.md` + `generic.md`, `cross-sport.md`): the §8 rows and their proving tests | A1 (rules files are shared with A1's lanes) |
| A3 Generator | The judge's compared/skipped counts first (D16), then one stream at a time in `tools/matrix/lib/streams/` (football, period, cricket, set-based, tennis, the sanction token), in sequence because they share files (§10); the catalogue regenerated once at the end | A1 |
| A4 MD-1 close | The result-deciding paths (§11 (b)) not already covered by A1's lanes | A1, A2 |
| A5 Review and PR | Whole-branch review (Opus), the `Matrix rows:` line (R27), main's newly merged tests after each rebase | A1–A4 |

### PR B — web, then the truth run

| Batch | Tasks | Depends on |
|---|---|---|
| B1 Editor | The five ruling-157 fields and the ratchet (§6.1); the badminton and tennis variant pickers and the best-of-1 refusal (§6.3) | PR A merged |
| B2 Pad | Sanction confirmation and ending, the volleyball question in the sheet, the pad blocking scoring while an ending is pending; the M12b control (§6.2) | PR A merged |
| B3 API and cleanup | `rank: null` and OpenAPI (D11 b); the v1 import and the Advanced placeholder (D6); the error codes' locale strings | PR A merged |
| B4 Visual and e2e | The Artifact sign-off page; the e2e specs dispatched on CI | B1–B3 |
| B5 Truth run and close | The W2 truth run (§10), triage and fixes; the `data-audit.sql` counts (§9); the `_INDEX` fold (rulings, false premises, the MD-1 amendment, #1061's rows checked (D17), W2 closed); whole-branch review | B4 |

B1, B2 and B3 touch different files, apart from the locale dictionaries and the generated key list. **Author's call:**
those shared files are edited by one batch at a time, in the order B3, B1, B2, or each batch works in its own worktree
and merges in that order.

## 14. Risks

| Risk | Mitigation |
|---|---|
| 3×15 as a default silently converts existing badminton divisions, including prod's only competition | `defaults` do not change (§5.1); anti-goal 2's test runs against a recorded pre-W2e config |
| The DLS NRR change reorders a finished cricket table | No cricket in prod (owner fact, D18); listed in "Data changes" |
| A scorer's forfeit exception widens who can end a match | D13's check is exact (last live event, same side, ending level); a test proves every other scorer forfeit is still 403, and the guard is mutated once |
| A sanction ending refolds old matches | The ending is a recorded event; replay is lenient; anti-goal 1's replay test per refusal |
| The truth run finds more than W2e can fix before 2026-12-01 | Each red is fixed or gets an owner verdict; the mid-November checkpoint (§5.1) decides 3×15's path independently |
| MD-1 sizing is far larger on the result-deciding paths than expected | The plan sizes it at A0 and puts the number to the owner before A4 starts |
| W2d's parity sweeps red on a fidelity change | Intended. Examine each one; a row records the change |
| `scripts/smoke.ts` is mid-split | Smoke steps land in the split layout, coordinated with the smoke session |
| Locale and generated-key collisions between web batches | One editor at a time, or worktrees merged in order (§13) |

## 15. Boundaries

- The engine stays in this monorepo. The engine split resumes after W2e (ruling 131).
- No change to W2d's table-rules resolver, pin or cascade validator (D18 changes the NRR operands in cricket, not the
  pin).
- All scoring and all stages are free: no gate, no upsell.
- `/admin` is untouched.
- No edit to `stryker-measured.json`, `stryker-timeouts.json` or `scripts/smoke.ts` outside the split layout.

## 16. Author's calls for the owner to check

1. §5.1 (amended): 3×15 is a new explicit variant made the preferred pick; `defaults` are untouched, `bwf` gets explicit
   3×21 values, and no migration is written.
2. §5.1: at the mid-November checkpoint, 3×15 is split out as a standalone PR if W2e cannot merge by 2026-12-01.
3. §5.1: 3×21 stays selectable, and existing divisions keep their format (D2 was silent on both).
4. §5.2: a badminton or tennis disqualifying sanction is recorded as a sanction plus the existing disqualification ending; the
   write path refuses further scoring after an ending sanction without its ending; replay stays lenient.
5. §5.3: withdrawn by D15 (no warning, no function).
6. §5.4 and §7: removed keys are stripped on write and read, not refused; `FOLD_EPOCH` bumps follow the guard's own rule.
7. §5.6: replaced by D14, then D18 (one method for every match; no cricket in prod).
8. §2.1 #14: the carrom adjust bound moves into the engine, under D8's rule; the generic 500 cap is dropped (E16).
9. §2.1 #20: the checklist leftovers X6a, CL7-3 and A10 are in W2e.
10. §6: no mockup round; per-screen sign-off on an Artifact page.
11. §8: which mechanics are record-only follows the inventory's reading, and can only move toward tested.
12. §9 (amended): no migration.
13. §13: two PRs (engine/rules/harness, then web), with the truth run on the web PR before it merges.
14. §5.2: an ending sanction is two appends in sequence on the existing route, not a new batch route; the undo
    sequences as stated there.
15. §5.5 RB2A-12 (amended): the targets come from the rulebook (E21); the 4-all form uses ad scoring unless Appendix VI
    says no-ad.

Added at plan phase (2026-10-28):

16. §5.1: `bwf`'s 3×21 values are written explicitly, so no future default change can move the variant.
17. §5.5: config refusals are write-path validators, event refusals sit behind the strict flag (E15).
18. §6.2 / §2.2: the M12b control goes only where a retirement changes something (football, volleyball, hockey, ice
    hockey); cricket and generic get disposition rows.
19. §5.6: withdrawn (D18: no method key).
21. §9: the migration's contents (deleted keys removed; existing Fast4 configs pinned to margin 2), under D18's rule.
20. §10: the generator lanes run in sequence; the sanction stream derives its sport list from the module declarations.
