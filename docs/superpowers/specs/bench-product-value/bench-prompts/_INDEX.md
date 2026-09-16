# Scheduler bench programme — session index

**One session per row.** Read `_RULES.md`, then this file, then the
session's prompt. Compaction anchor: every ruling, false premise, and
status change is appended here **as it happens**.

Spec of record: `../designs/2026-08-12-scheduler-bench-design.md` (§13 strict
wait). Sibling programme: `../portfolio-prompts/`
(D1–D7) — shared pure libs (`capacity.ts`, `health.ts`,
`court-windows.ts`) and the D6↔stage-0 fold-validate contract.

**Master gate (owner ruling 2026-08-12, STRICT WAIT): nothing here runs
until ScoringPad v2 is DONE through S13 AND release-2 is DONE through
C8.** Check both programme indexes. B00 is the first motion after the
gate opens. Prompts were authored 2026-08-13 (C1+S10 in flight) — every
citation is stale by design; that is what B00 exists for.

## Order

```
B00 → B01 → B02 → B03 → B03r → B04 → B05 → B06a → B06b → B07..B16 → B17 → B18
                          ▲                     (fw)  (pack) └ B07–B16 parallel-safe
                   RS010 merged                                 (worktrees, disjoint
                                                                pack files, schema
                                                                frozen at B06b)
```

B03/B04/B05 are sequential (shared `scripts/bench/lib/`). B17 needs B15
(reuses the hockey org). B18 last, always.

| Session | Prompt file | What | Depends on | Status |
|---|---|---|---|---|
| B00 | `B00-repin-and-refresh.md` | global re-pin, risk answers, env addendum | gate open | **DONE 2026-08-26** |
| B01 | `B01-runner-core.md` | CLI, pre-flight, HTTP client, report writer | B00 | **MERGED #658 2026-08-26** |
| B02 | `B02-pack-lib.md` | PackSchema, stage-0 validator, reconstruction | B01 | **MERGED #701 `1cdcaf4c6`** |
| B03 | `B03-seeding-layer.md` | org/comp/divisions/persons/officials/plans/claims | B02 | **MERGED #711 `3cfac6332` 2026-09-03** |
| B03r | `B03r-registration-layer.md` | registration entry path: `--entry` flag, http+browser drivers, PackSchema `registration` block, Stripe test-mode payer, funnel oracle | B03 + **RS007–RS011, RS010 merged** | **MERGED #713 `310eb22ac` 2026-09-04** — paid path proven live (2 × 100 USD destination charges, webhook accepted); bench 721/721 |
| B04 | `B04-scheduling-layer.md` | config apply, auto/validate, checker, certificate, metrics | B03 | **MERGED #731 `6e70c7270` 2026-09-06** — 1187/1187, tsc 0, eslint 0; three live legs at one SHA, all green. Four defects found by RUNNING it, each past a green suite (see the status log). Design: `../designs/2026-09-05-b04-scheduling-layer-design.md`. Product findings: bench design **§15**. Run results and the engine delta's limits: bench design **§16**. `../B04-handoff-2026-09-05.md` is HISTORICAL — it describes a mid-wave state, do not follow it. |
| B05 | `B05-simulation-layer.md` | event loop, advancement, oracles, people-layer steps | B04 | **MERGED #754 `c28c46752` 2026-09-08** — 1397/1397, `typecheck:scripts` 0, eslint 0; three live runs, both `_RULES.md` §2 legs green, 33 oracles / 31 with a subject / 0 FAIL. **T6 (people layer) and T7 (report sections + provenance %) NOT built** — deferred by name, plumbing in place; see the status log. Design: `../designs/2026-09-07-b05-simulation-layer-design.md`. Findings: `../B05-review-findings-2026-09-08.md`. Product findings: bench design **§17**. |
| B06a | `B06a-suite-framework.md` (built from the plan, no prompt sheet) | the FRAMEWORK the pilot needs: suite registry, extracted runner, per-match + specials comparators, provenance writer, claim ACCEPTANCE, news drafting/publication | B05 | **MERGED #762 `c1203a373` 2026-09-10** — all 9 tasks; 1474/1474 green, 11/11 CI checks. The T9 live run moved the advancement block above the outcome oracles (a suite-level echo helper cannot see ordering — only the live run could). Closes B05's T6 gap: the people layer that accepts `pc_` claims and drives news drafts is BUILT, and B05's T7 (report sections + provenance %) is discharged too. Six product findings recorded as design §18. |
| B06b | `B06-pack-darts-pilot.md` | suite 11 (PDC) — the pack, and the pilot that proves the playbook | B06a | **MERGED — PR #770 `38f5fb3b5` 2026-09-11** (branch `feat/bench-b06b-darts-pack`; two same-day follow-ups also merged into `main` — **#771 `873efb725`**, the solver-finding correction below plus the Resend test-email fix, and **#773 `9f30577d1`**, the placement-refusal logging fix noted at finding (2)). The pack: 2 generic divisions, 205 persons, 207 entrants, 205 streams, 1,426 events, 205 timetable rows, 13 adaptations, **provenance 100% real**. Stage 0 green offline; **both placement legs GATE GREEN with identical verdicts — 23 oracles with a subject, 23 PASS, 0 FAIL, 2 NO SUBJECT** (evidence: `evidence/b06b-suite11/`). `d-worlds` certifies FEASIBLE; `d-womens` certifies the new `HISTORY_SELF_CONFLICT` on the real board-2 overlap the pack declares per row. **Seven bench gaps found and fixed** — the fold raced itself on a bracket, the certificate had never rendered a history board, occupancy and `matchMinutes` were two numbers instead of one, two guards could not see a bye, the pin probe pinned against history, a knockout-only pack was redded for having no league count, and the certificate had no branch for a self-contradicting source. **TWO OPEN PRODUCT FINDINGS on the optimized path** (a 30 s control run on 2026-09-11 split what this row previously recorded as one, and falsified its "does not survive a real fixture count" framing). **(1) TUNABLE, working as designed:** `d-womens` never reached the solver at the default wall — `canSolveWithin` (`build.ts:318-340`) admits a board only when `fixtures x slots <= 20_000 * (wall/8_000)`, so a 10 s wall buys 25_000 against this division's ~44_000 and it returns `not_searched`/`too_big`. At 30 s the budget is 75_000 and it walks through. Re-runs must raise BOTH `PLACEMENT_WALL_SECONDS` (web — the gate) and `PLACEMENT_WALL_SECONDS_MAX` (service — the solve); `main.py:167` clamps silently. **(2) A REAL DEFECT, open:** both divisions still return `solver_unavailable` at 0 of 6 tiers under a wall three times larger, and the build returns in **849 ms / 496 ms against a 30_000 ms wall** — it never spends the budget, so this is an ERROR RESPONSE, not a timeout and not volume. Narrowed to `build.ts:2176` (the resolved-`ERROR` arm, the one `solver_unavailable` return that logs nothing; the catch at `:2154` would have written a warn and did not). **The silent half is now FIXED (#773 `9f30577d1`, 2026-09-11): both the engine's resolved-`ERROR` arm and the placement service's own wire-refusal path now log the rejection's `code` and `message`.** That closes the "logs nothing" gap this row itself found — it does not close the finding: nobody has re-run suite 11 to read what the now-logged reason actually says. Still needs its own wave, but a re-run and a log read, not a fresh investigation. One product gap also recorded — `PackStage.bracket`/`.seeding` are documentation rather than wiring. **A SECOND "gap" this wave recorded was WITHDRAWN on 2026-09-11: "a walkover cannot be recorded on an existing fixture" is false.** `core.forfeit` is postable on any fixture through the ordinary scoring door (`usecases/scoring.ts` applies no event-type allowlist) and folds to an `award` carrying NO score; `append-event.ts:127` derives the `forfeited` status from it, which is how `withdrawal.ts:102` already records one. Suite 11's administrative 1-0 was a pack-authoring mistake, not the product's only option — see `_PACK-PLAYBOOK.md`. The real defect underneath was narrower and is now FIXED: every sport module discarded `core.forfeit`'s required `reason`, so a walkover and a disqualification folded identically (`core/forfeit-reason.test.ts` now sweeps all eleven). **PackSchema freezes when THIS wave merges, not B06a.** |
| B07a | `2026-09-11-bench-b07a-match-day.md` (plan, 13 tasks) | **Match day, played by hand.** The tap driver + generic `TapAdapter` (real Playwright, real pad, no HTTP bypass), the device-link entitlement gate (mint refused pre-plan / cleared post-plan / revoked), `compareMatches` loser+method, per-pool stage-0 standings, qualifier order from the progression rule, advancement for every division (not just the first), a suite's own `play` declaration (`{"d-tiny":"tap"}`), news narrowed to D6's semis+final subset, and the report's `adaptations` writer | B06b | **DONE, this session on `feat/bench-b07a-match-day` — not yet merged.** 1871/1871 (55 files), `typecheck:scripts` 0, `apps/web` tsc 0, `lint:scripts` 0. **Two live tap legs, both real server/DB/Chromium:** Leg A (single run) — gate GREEN, `tapPlay`: 4 matches/24 taps, every tapped fixture (`rr-r1-c1`, `rr-r2-c1`, `rr-r3-c1`, the playoff `se-r0-i0`) read `finalized`, standings/bracket/one fixture's console all confirmed BY LOOKING (evidence: `evidence/b07a-tiny-tap/`). Leg B (two bench processes tapping concurrently against the same server) — GREEN on both, `tapPlay` 4/24 each, 0 findings, 0 unread-after-finalize; the R71 "lost point" live trigger was **NOT reproduced** (absence, not proof — the bench cannot yet put two scorers on the SAME fixture at the same instant, only two fixtures in two orgs at the same wall-clock time). The QR + copy-link device hand-over, unproven since R44/T11, is now proven IN A REAL BROWSER: the rendered QR decodes (Chromium's own `BarcodeDetector`) to the exact minted secret URL, and the copy button's clipboard content matches it byte for byte — both against a real mint, both revoked after. **Confirmed PRODUCT FINDING, live-proven against a real session and a real fixture (`apps/web` untouched, needs an owner ruling):** a repeat `POST /stages/{id}/complete` is idempotent in STORAGE (`completeStageIfReady` returns `{completed:true, events:[]}` on a stage already `status:'complete'` — `competition.ts:456`) but `completeStage`'s only guard (the `if (!result.completed) return result` line at the top of `completeStage`, currently `stages.ts:2582` — line numbers here drift with every rebase, the function name is the stable anchor) never fires for a repeat call, because `result.completed` reads `true` both times. Execution falls through to `computeSeedProposal` on the next `setup`-timed stage every time — proven live on `_tiny`'s own `s-league`→`s-playoff` pair (org owner session, real HTTP): two back-to-back `POST /complete` calls while the downstream proposal was still unconfirmed each returned `ok:true` with a **DIFFERENT** `seed_proposal.id`, and `stage_seed_proposals` grew by one new `draft` row per call (marking the prior draft `stale` each time) — `0aa6c2a4…` then `9213fad7…`, from a starting 2 rows to 4. **The window closes at organiser confirm, not before**: once a proposal reaches `confirmed`, `computeSeedProposal`'s own pre-check (the `SEEDING_ALREADY_CONFIRMED` throw near the top of `computeSeedProposal`, currently `stages.ts:3184-3192`) refuses every further repeat cleanly and writes nothing — proven live the same way (two repeat calls on an already-fully-advanced stage, both `ok:false STAGE_COMPLETED_SEEDING_FAILED`, zero new rows). So the real exposure is narrower than "every repeat call forever": it is the gap between a stage completing and its downstream proposal being confirmed — a slow organiser or a client retry in that window accumulates stale draft rows and can hand back a proposal ID from a LATER call than the one the organiser is looking at. `on_complete` timing has no such window (it seeds synchronously, no draft step). R60 + the tolerated-extra-key blind spot — 2 of 4 sub-items CLOSED, 2 still OPEN, do not read this as "R60 done": **Closed** — the QR/copy device hand-over (above) and, separately, the tolerated-extra-key NAME (`GENERIC_TOLERATED_EXTRA_KEYS`) now pinned against `generic.tsx`'s own stamp site, not just the tolerated value (regression test, mutation-killed); and the device-link revoke policy for tap-minted links, owner-accepted as unrevoked-by-design (2026-09-14 — throwaway org, day-scoped secrets, no blast radius), which counts as closed because a decision was made, not because revoking was built. **Still OPEN, work owed** — mint pacing (10/60s per IP is inert locally without a Redis-backed limiter; nothing in this bench throttles its own mints; not implemented, not testable until the limiter itself has one); and the parallel-play cap (`playTapRounds`, unit-proven M5/M6 only — confirmed **live-unprovable on `_tiny`**, since `d-tiny`'s 2-entrant rounds never exceed one fixture regardless of declared court count; a wider-round pack, e.g. B07b or suite 11, is what would actually exercise it live). **Option B (the idempotency-key hardening, R71) stays DEFERRED to the scoring-pad programme** — ~4-6h sized, never this branch. **Pre-B07b prerequisites, landed and tested — recorded here because the ledger below is gitignored and dies with this worktree:** P1 — `stageKey(divisionRef, stageRef)` (`seed.ts:179-198`) keys every `stageIdByRef`/`fixtureIdByKey` lookup by the (division, stage) PAIR, not the bare stage ref, closing the R26 collision: stage refs are unique only WITHIN one division (`pack-schema.ts`'s `checkRefsUnique` scopes its `seenStage` set per-division), so two divisions legally sharing a stage ref (both calling it `s-knockout`, say) used to resolve to whichever one's id landed last in the map. P2 — `completedStageIds` (`run-suite.ts:3978`, a `Set<string>` of real, globally-unique stage ids) stops a division whose progression has boundaries at BOTH stage index 1 and 2 from completing its own middle stage twice: once as the idx-2 boundary's SOURCE and once already as the idx-1 boundary's TARGET (`:4081-4088` skips the redundant source-side `/complete` when the id is already in the set; `:4245` always records the target-side completion, since only it captures `finalRanks`). Both are bench-side fixes only — `completeStage`/`completeStageIfReady`'s own idempotent-in-storage product behaviour (the PRODUCT FINDING above) is unchanged; P1/P2 just stop the BENCH from mis-resolving a stage id or double-completing one. **R20 Minors sweep, final disposition** (`minors-triage.md`): 36 findings triaged, 26 fixed across batches A–F (`minors-A/B/EF-report.md`). The remaining 10 were deliberately left as-is — recorded here, one line each: `tsconfig.scripts.json` excludes `scripts/**/*.test.ts` from typechecking (pre-existing, cross-cutting, no action inside this task); `oracle.ts:1368`'s unreachable `expectedLoser` guard (reviewer-ruled KEEP, symmetric with the equally-unreachable winner guard); `oracle.ts:1291-1294`'s latent `CARRIES_ITS_OWN_METHOD={boardgame}` branch (RECORD-only, no boardgame pack exists to exercise it); `report.ts:687`'s `SuiteReport.adaptations` staying `string[]` rather than a structured type (design decision — a bigger schema refactor than a minor fix, every producer/consumer would need updating); the renderer's "0 adaptations" branch being test-only (frozen/owner decision — no shipped pack declares an empty `adaptations` array); `validate-pack.ts`'s named-pool `underivable` branch and its verbatim-prefix `poolKey` assumption, plus `qualifiers.ts:94`'s `localeCompare` pool ordering where the product orders `by key`/Postgres collation — three RECORD-only latent branches under Ruling R20 (`progress.md` R20/155); `validate-pack.test.ts`'s `expectedOf` double cast (RECORD-only, same ruling); and `run-suite.ts:3694`'s `plan.divisions`/`pack.divisions` swap at the first-stage loop, currently unkillable (SWAP1) — recorded, no action, per the reviewer's own ruling that `PackDivision` has everything the loop reads. **Accepted open risk, distinct from R60's four items above:** the `deviceLinksGranted: false` early-return in `playDivisionByTaps` (`run-suite.ts:3428-3436`) trusts the DLS-gate probe's plan-selection heuristic rather than re-attempting a real mint — the weaker of two shapes Task 11's review considered (its Minor m3: re-attempt the organiser mint and classify a 402 naming the key as no-subject vs a 201 as a red, so a future product change that frees device links a different way than the probe's heuristic expects still gets caught). Produces no false verdict TODAY — the branch always warns and lists the unplayed fixtures by name, never counts them in `tapPlay` — but a future product change to how device links are granted could silently lose tap coverage if the probe's heuristic diverges from the mint's real behaviour. Open, owner-visible, not scheduled. Full record: `../../../../.superpowers/sdd/2026-09-11-bench-b07a-match-day/` (progress log + all 13 task reports/reviews; gitignored, not in this PR). |
| B07b | `B07-pack-carrom.md` | suite 10 (ICF) — thin-data resilience | B06b, **B07a** | TODO — was plain B07 before this row split. Needs B07a for two reasons, not one: `TapAdapter`/`TapStep` (the generic adapter's contract, `B07a` T9) is what a carrom adapter implements rather than inventing its own tap-driving shape, and B07a's Task 4 per-pool stage-0 standings (`deriveStandings(..., poolKey?)`) is what suite 10's four-pools-per-division tables need offline-checked at all — B06b's own darts pack never had a pooled stage to exercise it. **Two more B07a fixes already landed and tested, not owed by this wave — see the B07a row's "Pre-B07b prerequisites" for the full detail:** P1, the `stageKey` accessor closing the R26 stage-ref collision across divisions, and P2, `completedStageIds` closing the double-completion of a two-boundary division's middle stage. Carrom's pooled, multi-boundary shape is exactly what would have hit both. |
| B08 | `B08-pack-cricket.md` | suite 1 (T20WC24 + CT25) — volume monster | B06b | TODO — B07a's device-link/DLS-gate probe (`lib/dls-gate.ts`, T11) already stands up a minimal cricket division (empty-payload shape refusals only, no toss/innings/ball-by-ball) to prove the entitlement door; B08 owns the REAL cricket scoring walk and will need its own `TapAdapter` on the T9 contract — cricket's pad flow (toss, innings, overs, DLS revision) is materially richer than generic's and the DLS probe deliberately does not build it (see `lib/dls-gate.ts`'s own header comment). |
| B09 | `B09-pack-football.md` | suite 2 (Euro24 + WEuro25, decided B00) | B06b | TODO — **B07a's UI-setup ruling (R62) applies here too:** a lineup is SETUP and setup stays API — for any pad-tapped or player-attributed fixture, save each side's lineup through the real lineups API with the organiser session BEFORE match day, built from seeded roster members, never a pack edit and never an invented person. If football pad scoring ever attributes a goal to a player, that lineup save is owed the same way B07a owed it for `_tiny`'s d-tiny. |
| B10 | `B10-pack-tennis.md` | suite 3 (Wimbledon 2025 ×2) | B06b | TODO |
| B11 | `B11-pack-chess.md` | suite 4 (Candidates 24 + Grand Swiss 23) | B06b | TODO |
| B12 | `B12-pack-badminton.md` | suite 5 (All England 25, MS + XD) | B06b | TODO |
| B13 | `B13-pack-tabletennis.md` | suite 6 (WTTC 25) | B06b | TODO |
| B14 | `B14-pack-volleyball.md` | suite 7 (Paris 24 M+W) | B06b | TODO |
| B15 | `B15-pack-hockey-icehockey.md` | suites 8 (Paris 24) + 9 (IIHF 25) | B06b | TODO |
| B16 | `B16-pack-club-open.md` | suite 13 "Club Open" — customer journey, UI-first: signup → comp → restricted divisions → register/pay/join/consent → approve/promote → fixtures → **pad-tapped play** → results | B03r, B05, B06b, **B07a** | TODO — **B03r and B05 both merged; B06b (the darts pack) is the only gate left.** B06a is framework only and does not gate this row — but B16 inherits its people layer, so a claim/news step that reds here is B06a's contract, not this wave's. **New dependency, added this wave:** the "pad-tapped play" leg is now B07a's `TapAdapter`/`TapStep` machinery (real Playwright pad, real device-link mint) — B16 drives it, does not reinvent it. **B16 inherits R60 with two sub-items still OPEN, not "all closed" — read B07a's row above before assuming nothing is owed:** mint pacing (no client-side throttle, and the product's own limiter is inert locally) and the live parallel-play cap (unit-proven only; `_tiny` never exercised it live, and B16's own suite 13 — customer-journey volume, multiple courts — may be the first pack that actually can). The revoke policy and the tolerated-extra-key NAME are the two R60-adjacent items genuinely closed; B16 inherits those as-is. |
| B17 | `B17-disruption-suite.md` | suite 12: blackout→reflow, walkover, correction | B15 | TODO |
| B18 | `B18-full-run-closeout.md` (amend) | all suites, perf baseline, report, docs, memory; + one `--entry registration` pass ("Registration at volume" baseline, report-only) | all | TODO |

(B16 was vacant — hockey+icehockey share one session, B15 — and is now
the customer-journey suite. Pack sessions may pair further if research
proves thin — record the pairing here.)

## Decisions already made (do not re-open)

- All bench-spec rulings: simulate-never-feed-verdicts; correctness
  gates red / timings report-only; full-fat historical depth bounded by
  the sealed fidelity ladder (0–3); HTTP black-box + stage-0 validator;
  `--keep` default; feasibility-certificate protocol §6; misalignment
  protocol §7; no CI wiring; no z3 anywhere (C8 deleted it).
- Round-order and structured-conflict assertions are **day-one gates**
  (post-C1/C3 world — spec §6).
- Repair suite targets the post-C4/C5 CP-SAT path (`none|optimized|llm`).
- Stat oracles assert against post-S8/S9 pipelines incl.
  `personCareerStats`; a player in two suites gets a career-rollup
  oracle.
- Entitlement provisioning via smoke's `setPlan` SQL precedent.
- Engines benched: `optimized` primary, `greedy` baseline; `--engine
  both` is the comparison mode, not the daily driver.
- If portfolio sessions shipped first, the bench CONSUMES their libs
  (capacity/health/court-windows, D4 propose+confirm for advancement,
  D6 import for seeding speed on all-but-one suite) — B00 records which
  exist; prompts name the fallback when absent.
- Suite roster + per-suite constraints/specials: bench spec §3/§5/§8
  tables are the contract; deviations go through §7A adaptations.
- **Registration + customer journey (owner, 2026-08-27)** — spec
  `../designs/2026-08-27-bench-customer-journey-design.md`, decisions D1–D10
  closed there. Headlines: suite 13 is **UI-first** (Playwright taps every
  customer surface incl. Stripe test-mode Checkout and the scoring pad);
  suites 1–12 stay API-first; `--entry registration` runs suites 1–12
  through the API registration path free/open/auto, report-only; "no
  Stripe" now scoped to entitlements only; bench never *builds* UI, suite
  13 *drives* it; free-agent assignment report-only in v1; whole leg
  waits for RS010.

## Portfolio inventory (B00, 2026-08-26)

All P1–P11 shipped. Every shared lib the bench was written to consume, or
fall back from, is live — no B-prompt needs its fallback path.

| Lib / flow | Portfolio session | Status | Where |
|---|---|---|---|
| `capacity.ts` (D2) | P1 | MERGED `78c8618f` #544 | — |
| `health.ts` (D3) | P2 | MERGED `651c56c3` #547 | — |
| D4 propose+confirm (advancement) | P5, P6 | MERGED `776ba389`/`cdcc3bef` #554/#568 | `completeStage`/`generateStageFixtures`/`confirmSeedProposal`, all plain REST — see spec §11 risk 1 |
| `court-windows.ts` (D5b.5) | P9.5 | MERGED `203395b6a` #638 | `usableWindows`, 14 edge-matrix rows |
| Calendar compiler (D5c) | P10 | MERGED #644 (`027fd535a`) | — |
| D6 batch import (seeding speed) | P11 | MERGED `ee5aa1a01` #653 | `POST /api/v1/divisions/{id}/events/import` — **feature-gated, no `plan_entitlements` row yet**; bench needs a `setPlan`-style override to use it (spec §11 risk 5/8) |
| Venues/courts schema+API (D5a) | P8 | DONE 2026-08-17 | V367, 4 tables, RLS forced |
| Scheduler integration (D5b) | P9 | MERGED #621+#623+#633 | `ScheduleConfig.courts` = court UUIDs (`schemas.ts:1155`) |
| Templates (D1a/D1b) | P4, P7 | MERGED `e35efff1`/`98e95c9e` #548/#582 | 2 known open defects (`uniqueSlug` race, modal 320 fold) — not bench-relevant |
| News enrichment (D7) | P3 | MERGED `51601495` #545 | `generateWeeklyDigest` (`org-posts.ts:1506`), `draftPostsForDecidedFixture` (`:449`) — for B03 seeding if news items get seeded |

## Status log

(append as sessions run)

- 2026-09-10 — **B06a IN FLIGHT**, branch `feat/bench-b06a-framework`, not
  pushed. B06 split: B06a is the FRAMEWORK, B06b is the darts pack, and
  **PackSchema freezes at B06b's merge, not this one.** Tasks 1–7 committed,
  `scripts/bench` 1474/1474 with 0 failed suites, tsc 0, lint 0. Shipped: a
  suite registry (a pack is an entry, not a branch); the pipeline extracted
  out of `tiny.ts` into `run-suite.ts`; `compareMatches` and `compareSpecials`
  (both `expected.matches` and `expected.specials` had been declared and
  compared by NOTHING); writers for `provenancePct`, `claims` and `news`, all
  three of which had been fields with no writer since B01; claim ACCEPTANCE
  through the real invitee flow; and news drafting, publication and the
  fire-once proxy. **B05's deferred T6 and T7 are discharged.**

  What this wave is really a record of: **every route fact the plan pinned for
  tasks 6 and 7 was wrong** — 4 of 4, then 5 of 5. The one that matters most is
  that the claim accept flow was not merely unbuilt but UNREACHABLE (the
  one-time secret is returned once, on the mint response, and the read-back
  omits it), which is how B03 §5's "seeding only mints invites" survived three
  waves unchallenged. Six product findings are recorded in design §18,
  including a conditional authentication bypass in the magic-link route that
  the owner has approved for its own PR.

  Also learned twice, and now written down: a `no_subject` oracle carrying
  `passed: false` does not fail an assertion — it throws inside `writeReport`
  and the run ends with NO report on disk, invisible to all 42 test files
  because every one calls the runner and none calls the writer. And four
  mutants across T6/T7 SURVIVED their first sweep because their tests drove
  fakes that satisfied the very guard under test.

- 2026-09-08 — **B05 MERGED, PR #754 `c28c46752`.** Simulation layer: the
  bench now plays the matches. `simulate.ts` (single-event fold, strictly
  sequential `expected_seq`), `import.ts` (chunked against the product's own
  `IMPORT_CAPS`), `advance.ts` (`propose → assert → confirm → generate →
  complete`), `oracle.ts` (eight comparators), plus division START and a
  rebuilt `plan.ts` chooser, wired through `suites/tiny.ts` and `report.ts`.
  Both write paths are split across divisions so neither can go inert. Gates
  at merge: **1397/1397**, 0 failed suites, `typecheck:scripts` 0, eslint 0
  bytes. Three green live runs (the last on the rebased tree against a v400
  DB) and both `_RULES.md` §2 legs — placement up/`optimized` and placement
  down/`greedy` (`solver_unavailable`) — same verdicts either way, which is
  what CI will see since smoke has no placement container. Oracles: 33 total,
  31 with a subject, 31 PASS, 0 FAIL, 2 NO SUBJECT. Throughput on `_tiny`:
  single-POST 9 events @ **28/s**, import 84 events in 2 chunks @ **112/s**
  (not the B06 baseline — that is measured on a real pack).

  **Five briefed premises were false**, each recorded rather than worked
  around (`../B05-repins-2026-09-07.md`): `finalRanks` crosses the wire ONCE
  in the `complete` response and can never be re-read (`GET /history` does not
  select `payload`) and is emitted for every stage kind, not just
  ladder/bracket; there is no champion field anywhere; advancement lives in
  `usecases/stages.ts`, not `stage-seeding.ts`, and all four routes are
  `/api/v1`-reachable, so the bench-as-organizer fallback is dead;
  `import.events` HAS `plan_entitlements` rows since V396 (B00's "no row yet"
  was stale); and **nothing had ever started the division** — both write paths
  refuse `setup`/`scheduled`, so every fold this wave built would have 409'd
  on contact with a real server, invisible to a fake with no phase gate
  (ruling D9 covers the start and its refusal policy).

  **T0 caught the bench measuring nothing a customer can buy.** After V393
  deleted `pro_plus`, `chooseGrantingPlanForCapabilities` was landing the
  bench org on `enterprise` — `is_public = false`, unlimited caps — and the
  unit fixtures injected a catalog still naming `pro_plus`, so they could not
  witness it. Candidates are now filtered to `is_public = true` and ranked
  least-privileged-first off the live matrix, with the fixtures derived from
  the migration deltas. This closes the item `_MASTER.md` routed in from
  entitlements v18 W2.

  **Two defects the live run found that 1,397 passing unit tests could not:**
  the standings comparator failed on metrics the pack never DECLARED (any pack
  omitting an optional metrics map could never pass — fixed in the comparator,
  not by making `_tiny` declare everything, which would have hidden it); and a
  **PASS over zero comparisons** — `tie-order cascade … (0 checked, 0 skipped)`
  printed green on two divisions. NO SUBJECT is now a third verdict, counted
  separately, never reading as PASS and never reddening a run.

  **Deferred by name, not omitted: T6 (people layer** — officials assign,
  claim accept via magic link, news drafts) **and T7 (report sections,
  provenance %)**. The pack subjects and oracle plumbing they need are in
  place. Whoever picks them up should re-read this row first — they are owed
  before B18's closeout. **They are not free of B06, either**: B06's suite
  sheet asks for a "claims for 3 stars" oracle and "news drafts on finals",
  and both belong to T6 — the pilot must either land T6 first or drop the two
  as §7A adaptations and record the drop. Nothing else in B06 needs T6/T7.

  Shipped alongside, in its own PR: **#753 `088c5436f`, the team-sheet
  suspension gate** (`gateLineupSuspensions`, 422 `SUSPENDED_PLAYER`,
  overridable with a reason against a `suspension.overridden` ledger row,
  behind the paid `discipline.enforced` flag). The bench's suspension-carry
  oracle asserts that 422 on a LIVE run; the unit suite does not depend on it.
  A decided fixture refuses earlier ("lineup is locked once a fixture is
  decided"), so the gate has to be driven on a SCHEDULED fixture — worth
  knowing before someone concludes it does not fire. Three product findings
  went to bench design **§17**; one a11y finding (the page renders French
  while `document.documentElement.lang` stays `"en"` — the static root layout
  never calls `resolve-locale.ts`) is recorded there too, unowned by any
  bench wave.

- 2026-09-06 — **B04 MERGED, PR #731 `6e70c7270`.** Scheduling layer:
  `board.ts`, `schedule.ts`, `checker.ts` (eight rules recomputed
  independently of the product), `certificate.ts`, `believability.ts`, wired
  through `tiny.ts`/`bench.ts`/`report.ts`. Gates at merge: 1187/1187, tsc 0,
  eslint 0. Three live legs at one SHA, all green.

  **Four defects were found by RUNNING it, each after a fully green unit
  suite, a clean tsc, and multiple reviewer passes.** They are the wave's real
  output and the reason `_RULES.md` §2's "green is not run" line stands:

  - **The bench could not start.** A TS parameter property in `schedule.ts`,
    which `node --experimental-strip-types` refuses outright. Survived T1–T7
    behind 1150 passing tests because vitest transpiles and tsc only
    typechecks. Now gated by `strip-types-loadable.test.ts`, which spawns node
    against every shipped module. `--experimental-strip-types --check` was
    tried first and REJECTED: it exits 0 on the broken file.
  - **A leg that measured nothing reported GREEN.** `--keep` is the CLI's
    default, so the documented second leg always short-circuited before
    seeding OR scheduling and returned a hard-coded `green` with `actual=n/a`.
    A suite gate can now be `"skipped"`, folded into the run-level red. Every
    leg of the engine protocol needs `--wipe`.
  - **The engine assertion redded a leg where the optimizer DID run.**
    `already_optimal` is the product's proof that the tiers ran and could not
    improve the greedy seed — not a fallback. Now satisfies an `optimized`
    request; `solver_unavailable` still errors.
  - **The engine artifact was keyed by a value that is absent exactly when it
    matters.** One leg's divisions can resolve different actual engines. Re-keyed
    to the REQUESTED engine, which is always singular.

  Run results, and why the engine delta is not yet a measurement, are recorded
  in the design of record **§16** — not here, and not only in the PR body. The
  short version: on `_tiny`, 1350 of the optimized board's 1470-minute makespan
  is ONE participant's overnight gap, so neither reported metric discriminates
  between engines at this pack size. §16.4 says what a later wave owes.

  `../B04-handoff-2026-09-05.md` is now HISTORICAL — it describes a mid-wave
  state that no longer exists. Read §16 and the design, not the handoff.

- 2026-08-27 — **Registration + customer-journey amendment approved in
  brainstorm** (owner). New sessions B03r + B16, B18 amended, gate
  RS010 → B03r added to `_MASTER.md`. Prompts authored the same day:
  `B03r-registration-layer.md` (PR 0 = app test hooks — hub panels and
  stepper have zero `data-testid`s today; PR 1 = bench), `B16-pack-club-open.md`,
  B18 amended with the `--entry registration` volume pass. Both prompts
  cite 2026-08-27 state and re-pin at run time (B00 pattern).

- 2026-09-02 — **B03 in progress.** Seeding layer. Four rulings and two false
  premises, all verified against the tree rather than inherited:

  - **The entitlement refusal is HTTP 402 `PAYMENT_REQUIRED`, not a "typed
    422".** B03's prompt says 422; `api-v1/http.ts:214-226` returns 402 with
    `code: "PAYMENT_REQUIRED"` plus `feature`/`feature_key`/`reason`. It reaches
    that branch only because `PaymentRequiredError extends HttpError` and its
    branch sits ABOVE the generic `HttpError` one (:231) — order is the
    contract, and nothing tests it by name. Recorded as G5 in
    `../../2026-09-02-product-gaps-from-bench-b03-prompt.md`.
  - **The probe moved off the fidelity gate onto the DLS gate.**
    **[W1 CLOSED — re-verified 2026-09-03 against merged `ae0751682`; the pins
    below are the merged ones, the pre-merge pins this entry first carried were
    off by one and three lines respectively.]** W1 deleted
    `requiredFeatureForEvent` outright — no non-test definition survives
    anywhere in `apps/web/src` or `packages/` — along with the
    `scoring.ball_by_ball` / `scoring.rally_by_rally` / `scoring.match_timeline`
    plan rows (`V390__scoring_free.sql`, which also drops their
    `org_entitlement_overrides`). The surviving gate is
    `scoring.ts:269-271` → `requiresDlsEntitlement(type, divisionConfig,
    payload)` (defined `:298-307`) → `requireFeature(orgId, "cricket.dls")`,
    shared verbatim with the batch importer at `event-import.ts:253`. Its own
    docstring (`:281-283`) states the invariant the probe depends on: "this is
    now the ONLY entitlement gate left at the scoring door".

    The predicate is three conjuncts — `eventType === "cricket.revise"`,
    `payload.target === undefined`, `divisionConfig.dls.enabled === true` — so
    the 2×2 (dls on/off × manual target present/absent) has exactly ONE
    refusing cell and three that must PASS on a free plan. Live grants at v389:
    `community` **false**, `pro`/`pro_plus` **true**, and `event_pass`/
    `event_pass_l` carry NO `cricket.dls` row at all — so the community/pro pair
    is the differential to drive, not the pass tiers. W2's plan
    (`docs/superpowers/plans/2026-09-03-entitlements-w2-matrix-and-plumbing.md`)
    does not mention DLS, so the probe target should survive W2 as well; the
    run-time plan derivation below is what makes that not need checking again.
  - **Plan keys are DERIVED from `plan_entitlements` at run time, never named.**
    Grepping the migrations gives the union of every plan that ever existed. A
    live DB at v389 holds `pro_plus`/`pro`/`event_pass`/`event_pass_l`/
    `community` — **`business`, which `V112` seeds, is not there at all**.
    W2 then deletes `pro_plus`. A derivation survives all of it; a constant does
    not. Recorded as G7.
  - **`persons.lane` can never be `'coach'` or `'staff'`. ~~CLOSED 2026-09-03
    by PR #706 — do NOT implement the workaround below.~~** Kept, struck
    through rather than deleted, because a session that reads only the
    conclusion will otherwise rebuild the workaround for a gap that no longer
    exists.

    What was true: V356 widened the CHECK for the S3/#426 ruling; all six
    `insert into persons` sites in non-test `apps/web/src` wrote
    `'player'`/`'official'` or omitted the column, and `CreatePerson` had no
    `lane` field. The handling was to map the lane onto
    `entrant_members.roles` and `LineupSlotInput.role` and never fabricate the
    column. Raised as G1.

    **What is true now:** `PersonLane` is `z.enum(["player","coach","staff"])`,
    `CreatePerson.lane` is optional, and `createPerson` writes
    `${input.lane ?? "player"}` — producer and consumer both verified, not a
    schema-only field. `seed-plan.ts` sends the lane EXPLICITLY for every
    person including `"player"` (same reasoning as `consent`: a bench that
    leans on a server default cannot tell a correct default from a forgotten
    field), and a roster member's `roles` are the pack's declared roles
    verbatim. `"official"` is still absent from the plan's persons by
    construction — `PersonLane` has no such value and an official's row is
    minted by `inviteOfficial`.

  Two more that cost nothing now and would have cost B05 a false defect:

  - **Seeded persons must carry `consent: { public_name: true }`.** The two
    consent gates have OPPOSITE polarity — entrant name display is opt-OUT
    (`anyOptedOut`), but `public_players_v` is opt-IN
    (`where coalesce((p.consent->>'public_name')::boolean, false)`, unchanged
    across V237 → V307 → V350). `CreatePerson.consent` defaults to `{}`, so an
    omitted consent yields a visible entrant name and NO player card. B05's
    player-card oracle would have read an empty view and blamed the product for
    a state the bench created. Matches what registration's own insert branch
    writes (`usecases/registrations.ts:670`, ruling 5).
  - **Idempotence hangs off the COMPETITION, not the org.** There is no
    `POST /api/v1/orgs` and no `PATCH` either — the org is whatever first
    sign-in provisions, so its slug is not ours to set. The marker is the pack
    hash in `competitions.branding` (jsonb, inserted ungated at
    `usecases/competitions.ts:204-207`), read back via `GET /api/v1/competitions`
    and keyed on the pack's own competition slug. NOT the `description`:
    `--keep` leaves orgs browsable by design, and a hash in a markdown field
    rendered on public surfaces is customer-visible litter.

  **T5 (2026-09-03) — `_tiny.json` is now a GENERATED artefact with two
  divisions.** `scripts/bench/packs/build-packs/_tiny.ts` emits the whole file
  (`npm run bench:build-packs`); the hand-authored `generic` streams are
  carried through as a literal and `d-badminton`'s are generated by
  `reconstructSetBasedStream` under a stable seed. Determinism is a test, and
  was re-checked independently here: byte-identical across regeneration, and
  from a different cwd. Modelled on `openapi:gen`, deliberately WITHOUT a CI
  step — CI is outside B03's charter, so the determinism test is the only gate
  and a `_tiny.json` edited by hand will not be caught by CI. Worth a
  workflow line when someone is next in `ci.yml` for another reason.

  Two consequences a later session will otherwise trip on:

  - **`fixtureCountIssue` had a latent bug that only a second division could
    expose.** Its `actual` is `seeded.fixtureIdByKey.size` — POOL-wide, every
    division — but it compared that against `expectedFixtureCounts[0]` alone.
    Correct for every pack that ever existed before T5, wrong the moment one
    declares two league stages. It now sums every entry. This is the shape of
    bug that survives any number of green runs because no fixture ever had a
    second division to disagree about.
  - **`runTinySuite` schedules `divisions[0]`/`stages[0]` ONLY**
    (`suites/tiny.ts:463-464`). `d-badminton` is seeded, its entrants created
    and its stream bound to a real fixture — and then never scheduled or
    validated. That is a deliberate scope line, not an oversight: T5 exists to
    exercise N-division SEEDING, and scheduling is B04's layer. But it means
    the second division proves the seeding path and nothing downstream of it,
    so do not read a green `_tiny` run as evidence that anything schedules
    two divisions. B04 owns closing this.

  **Officials end-to-end and player stats are BENCH scope (owner, 2026-09-03).**
  An earlier version of this entry sent both to the walkthrough leg on the
  reasoning that they are UI journeys. That was wrong: both are fully reachable
  over the API, so the bench can drive and assert them itself, and a bench that
  hands its own subject matter to a browser suite has given up the thing it is
  for.

  What the API actually offers, checked rather than assumed:

  - `POST /api/v1/officials/{id}/invite` — body `CreateClaimInvite` (`{ email }`),
    returns the claim row plus `claim_url` and `email_sent`. It runs the SAME
    shared person-claim rail as a player `pc_` invite, pointed at the official's
    person (created on demand by that route — which is the only writer of a
    `lane:"official"` persons row, and therefore the answer to why
    `PackOfficial.person` cannot be honoured at `POST /officials`).
  - `GET /api/v1/persons/{id}/stats` — one person's record.
  - `GET /api/v1/divisions/{id}/stats/players` — the division's player table.
  - `GET /api/v1/public/orgs/{orgSlug}/competitions/{slug}/divisions/{divisionSlug}/stats`
    — the public projection, which is the one gated on opt-IN consent
    (`public_players_v`), so it is where a seed that omitted
    `consent.public_name` shows up as an empty table rather than an error.

  **Where each half lands.** Minting the official's invite is B03 §5's own
  sentence ("seeding only mints invites; the accept flow is B05's"), so it
  belongs in THIS wave alongside T6's create/blackout/assign. Asserting real
  player stats needs a folded match, which B05 produces — so B03 can pin the
  BASELINE (the endpoints answer, the seeded roster is present, the public
  projection reflects the consent the seed actually wrote) and B05 pins the
  values once there are events behind them. Design §9 P2 — "claimed profile
  shows the real stats" — is the B05 oracle.

  A UI walkthrough of the same ground may still be worth having later, but it
  is a COMPLEMENT and not where this work lives; `apps/web/e2e/walkthrough/`'s
  README carries it as optional.

  **The BROWSER track owes two more journeys (owner, 2026-09-03).** Distinct
  from the API coverage above, and both belong on the browser driver B03r
  builds (`lib/drivers/browser.ts`, plain `playwright`, one `BrowserContext`
  per person, magic-link session, its own `assert()` because `expect` is a
  `@playwright/test` export that plain playwright does not have):

  - **The officials journey through the screens** — create, invite, assign to a
    fixture. The bench asserts the same ground over the API (T6 + T6b); this is
    the half the API cannot see, which is whether a person can actually get
    through it.
  - **Player stats verified AFTER the competition has finished.** The timing is
    the requirement, not an aside: a stats page mid-competition proves almost
    nothing, and the interesting assertion is that a completed suite's final
    record is what the player sees on their own profile. That sequences this
    **after B05** (which folds the events and accepts the `pc_` claims) —
    there is no finished competition to read before then.

  Sequencing, not a new number: B03r builds the driver, B05 produces a finished
  competition, and these two ride on both. Do not schedule them earlier and
  substitute a half-played suite — "after the competition finished" is the
  condition being tested.

  Note the driver split B03r already forces: on the http driver `pay()` throws
  `PaidEntryNeedsBrowser`, so paid registration is structurally browser-only.
  That is the precedent for putting these two there rather than inventing a
  second browser harness.

  Forward note for B06+ pack authoring. **[Corrected 2026-09-03 — the number
  this entry first carried was wrong, and the correction is the more useful
  fact.]** This originally read "**63 recordable against 68 registered**",
  attributed to the entitlements/R9 session and marked "verified here". The
  direction was verified; **the number was not**, and it does not reproduce.

  Derived by enumerating `builtinModules` (`packages/engine/src/sports/
  index.ts`), taking `Object.keys(module.eventSchemas)` as REGISTERED and
  walking `module.padSpec(cfg)` for every parseable variant cfg — collecting
  every nested `{ type }` — as PAD-REACHABLE:

  | | count |
  |---|---|
  | registered (`eventSchemas` across all 11 modules) | **68** |
  | pad-reachable across every shipped variant | **60** |
  | registered but exposed by no preset's pad | **8** |

  The eight: `badminton.expedite.start`, `badminton.sub`, `badminton.timeout`,
  `cricket.revise`, `cricket.superover.ball`, `football.shootout.kick`,
  `tabletennis.sub`, `volleyball.expedite.start`. Per module the
  registered/pad-reachable split is football 9/8, cricket 15/13, badminton 6/3,
  tabletennis 6/5, volleyball 6/5, and boardgame, carrom, generic, tennis,
  icehockey and hockey at parity.

  **68 is the same at `313af3818` and at `6f04875e5`** — I ran the identical
  script against a `git archive` of the older engine to be sure the W1/phone
  waves had not moved it. So "63" was never this measurement. It may well be a
  correct count of something else (types a preset's `apply()` ACCEPTS is a
  broader set than types its pad EXPOSES — `cricket.revise` is accepted, and is
  exactly the event the surviving `cricket.dls` gate fires on), which is why
  this now states its definition rather than a bare number.

  **What still holds, and is the point:** `reconstruct.ts`'s
  `assertDeclaresEventType` (`:172-180`) gates on `sportModule.eventSchemas` —
  the REGISTERED set of 68 — so it waves through a type no pad exposes, and any
  refusal then surfaces from the reducer deep inside the fold rather than at the
  generator's front door. A pack author enumerating event types from the
  module's declarations gets a stream that validates and that no scorer could
  have produced by hand.

  **And a scope correction that follows from it:** these eight are not
  "unrecordable". They are not PAD-reachable. The bench drives the HTTP API, so
  it can post all 68; the gap bites a pad-driven walkthrough, not B03's or
  B04's seeding. `cricket.revise` being on the list is the proof — B03's own
  entitlement probe posts it deliberately.

  Also: **there is no REST route that lists fixtures. ~~CLOSED 2026-09-03 by
  PR #706~~** — `GET /api/v1/divisions/{id}/fixtures` now exists. What was
  true: `POST /stages/{id}/generate` returning `{created, existing, fixtures}`
  with `ext_key` was the ONLY fixture-identity source over HTTP, so it had to
  serve as both the binding source and the idempotent re-read. Recorded as G3.

  The seeder still binds from `generate`'s own response and should keep doing
  so — it needs the ids of the fixtures THIS call created, and a separate list
  request would be a second round trip plus a race. The new route matters to
  B04/B05, which read fixtures they did not just create.

- 2026-08-13 — prompts authored, gated. S9+C0 merged; C1+S10 in flight.
  B-numbering: B16 intentionally absent (B15 covers suites 8+9).
- 2026-08-26 — **B00 DONE.** Gate confirmed open: ScoringPad v2 S13
  MERGED (v1 pad deleted, confirmed — no non-v2 scorepad path exists
  anywhere in `apps/web/src`), release-2 C8 MERGED `e9a7c54a` #591 (its
  three coverage losses also CLOSED, `0ccd2665` #594). ScoringPad v3
  (R1–R4, R2b, R2c) is a separate, non-gating programme — bench talks
  HTTP black-box, not pad UI, so v3 skin work does not touch anything
  the bench pins. Full scout re-pin done; spec §11 risks 1–9 all
  answered with evidence, none left open (see spec doc). Portfolio
  inventory above. `seazn-local-env` §3b got the run-both-ways
  addendum. B09's prompt (Div B suite 2) carried an open futsal-vs-WEuro25
  choice — decided WEuro25 (spec §11 risk 3) and the prompt + this
  index's B09 row are corrected. No other B-prompt cites a stale
  file:line (only the design spec does; the B0*-B18 prompts cite none
  directly, confirmed by grep).
- 2026-09-02 — **B02 in review, PR #701.** Pack library: `pack-schema.ts`
  (the committed `PackSchema`), `pack-template.ts`, `validate-pack.ts`
  (stage 0 — pure offline fold gate, DB/HTTP/env-free), `reconstruct.ts`
  (seeded generators), `pack-io.ts`, and `packs/_tiny.json`. `_tiny` now
  READS its pack from disk, so runner and validator share one fixture.
  366/366 unit+regression green (JSON reporter, 9 files, all in-worktree);
  tsc clean; 82 mutants / 76 killed / 6 equivalent, each equivalent
  declared with evidence at the code. Live `_tiny` run x3 by the
  orchestrating session — with placement, with the env merely unset (a
  FALSE no-placement test, recorded as a trap), and with placement
  genuinely stopped (`solver_unavailable`, greedy fallback); all green,
  `conflictCount: 0`, satisfying `_RULES.md` §2 via runs 1 and 3.
  **Three fields added pre-freeze**, each cited to a named later session:
  `streams[].stageRef` (an unbindable cfg overlay is stage 0's only
  FALSE-RED path), `expected.finalRanks` (B05 §3; B06 is a 96-player
  knockout), `expected.careers` (B12's cross-division oracle).
  **Two owner decisions open:** `provenance` gained a third value
  `"synthetic"` on the session's own ruling, spec §4 declares two; and
  nothing lints `scripts/**` (no repo-root eslint config — confirmed from
  four directions, escalated not fixed). Carried to B03: `reconstruct.ts`
  has no production caller yet, so **B03 must drive a pack through it, not
  merely import it**. Eight briefed premises proved false; thirteen
  location-not-property defects fixed, four of them fixture-level.
- 2026-08-26 — **B01 MERGED, PR #658** (merged 2026-08-26 17:19Z; this line said "in review" until B02 corrected it). Runner core: bench.ts CLI,
  lib/env.ts pre-flight (pure `runPreflight(base, probes)` over an
  injected `PreflightProbes`), lib/http.ts (hand-copied smoke.ts session
  shapes + a typed `request()` that fails the run on unallowed 4xx/5xx),
  lib/report.ts (zod `BenchReport` schema + composable markdown
  renderer), lib/log.ts (pino, matching the repo's flat-singleton
  convention), lib/suites/tiny.ts (the `_tiny` proof suite). 27/27
  DB-free unit/regression tests green; typecheck and lint clean. `pino`
  added as a root dependency (same class of fact as `@grpc/grpc-js`
  under pnpm's strict isolation — see PR body). Live `_tiny` run (and the
  both-with/without-placement pass per `_RULES.md` §2) deliberately
  deferred to the orchestrating session, per this task's own brief.
