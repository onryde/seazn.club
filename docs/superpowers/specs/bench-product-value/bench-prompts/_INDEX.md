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
B00 → B01 → B02 → B03 → B03r → B04 → B05 → B06(pilot) → B07..B16 → B17 → B18
                          ▲                    └ B07–B16 parallel-safe (worktrees,
                   RS010 merged                  disjoint pack files, schema frozen)
```

B03/B04/B05 are sequential (shared `scripts/bench/lib/`). B17 needs B15
(reuses the hockey org). B18 last, always.

| Session | Prompt file | What | Depends on | Status |
|---|---|---|---|---|
| B00 | `B00-repin-and-refresh.md` | global re-pin, risk answers, env addendum | gate open | **DONE 2026-08-26** |
| B01 | `B01-runner-core.md` | CLI, pre-flight, HTTP client, report writer | B00 | **MERGED #658 2026-08-26** |
| B02 | `B02-pack-lib.md` | PackSchema, stage-0 validator, reconstruction | B01 | **in review (#701)** |
| B03 | `B03-seeding-layer.md` | org/comp/divisions/persons/officials/plans/claims | B02 | TODO |
| B03r | `B03r-registration-layer.md` | registration entry path: `--entry` flag, http+browser drivers, PackSchema `registration` block, Stripe test-mode payer, funnel oracle | B03 + **RS007–RS011, RS010 merged** | TODO (gated) |
| B04 | `B04-scheduling-layer.md` | config apply, auto/validate, checker, certificate, metrics | B03 | TODO |
| B05 | `B05-simulation-layer.md` | event loop, advancement, oracles, people-layer steps | B04 | TODO |
| B06 | `B06-pack-darts-pilot.md` | suite 11 (PDC) — pilot proves the playbook | B05 | TODO |
| B07 | `B07-pack-carrom.md` | suite 10 (ICF) — thin-data resilience | B06 | TODO |
| B08 | `B08-pack-cricket.md` | suite 1 (T20WC24 + CT25) — volume monster | B06 | TODO |
| B09 | `B09-pack-football.md` | suite 2 (Euro24 + WEuro25, decided B00) | B06 | TODO |
| B10 | `B10-pack-tennis.md` | suite 3 (Wimbledon 2025 ×2) | B06 | TODO |
| B11 | `B11-pack-chess.md` | suite 4 (Candidates 24 + Grand Swiss 23) | B06 | TODO |
| B12 | `B12-pack-badminton.md` | suite 5 (All England 25, MS + XD) | B06 | TODO |
| B13 | `B13-pack-tabletennis.md` | suite 6 (WTTC 25) | B06 | TODO |
| B14 | `B14-pack-volleyball.md` | suite 7 (Paris 24 M+W) | B06 | TODO |
| B15 | `B15-pack-hockey-icehockey.md` | suites 8 (Paris 24) + 9 (IIHF 25) | B06 | TODO |
| B16 | `B16-pack-club-open.md` | suite 13 "Club Open" — customer journey, UI-first: signup → comp → restricted divisions → register/pay/join/consent → approve/promote → fixtures → **pad-tapped play** → results | B03r, B05, B06 | TODO (gated) |
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

- 2026-08-27 — **Registration + customer-journey amendment approved in
  brainstorm** (owner). New sessions B03r + B16, B18 amended, gate
  RS010 → B03r added to `_MASTER.md`. Prompts authored the same day:
  `B03r-registration-layer.md` (PR 0 = app test hooks — hub panels and
  stepper have zero `data-testid`s today; PR 1 = bench), `B16-pack-club-open.md`,
  B18 amended with the `--entry registration` volume pass. Both prompts
  cite 2026-08-27 state and re-pin at run time (B00 pattern).

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
