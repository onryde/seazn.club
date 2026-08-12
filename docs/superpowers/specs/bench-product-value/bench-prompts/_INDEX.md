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
B00 → B01 → B02 → B03 → B04 → B05 → B06(pilot) → B07..B16 → B17 → B18
                                        └ B07–B16 parallel-safe (worktrees,
                                          disjoint pack files, schema frozen)
```

B03/B04/B05 are sequential (shared `scripts/bench/lib/`). B17 needs B15
(reuses the hockey org). B18 last, always.

| Session | Prompt file | What | Depends on | Status |
|---|---|---|---|---|
| B00 | `B00-repin-and-refresh.md` | global re-pin, risk answers, env addendum | gate open | TODO |
| B01 | `B01-runner-core.md` | CLI, pre-flight, HTTP client, report writer | B00 | TODO |
| B02 | `B02-pack-lib.md` | PackSchema, stage-0 validator, reconstruction | B01 | TODO |
| B03 | `B03-seeding-layer.md` | org/comp/divisions/persons/officials/plans/claims | B02 | TODO |
| B04 | `B04-scheduling-layer.md` | config apply, auto/validate, checker, certificate, metrics | B03 | TODO |
| B05 | `B05-simulation-layer.md` | event loop, advancement, oracles, people-layer steps | B04 | TODO |
| B06 | `B06-pack-darts-pilot.md` | suite 11 (PDC) — pilot proves the playbook | B05 | TODO |
| B07 | `B07-pack-carrom.md` | suite 10 (ICF) — thin-data resilience | B06 | TODO |
| B08 | `B08-pack-cricket.md` | suite 1 (T20WC24 + CT25) — volume monster | B06 | TODO |
| B09 | `B09-pack-football.md` | suite 2 (Euro24 + Futsal26/WEuro25) | B06 | TODO |
| B10 | `B10-pack-tennis.md` | suite 3 (Wimbledon 2025 ×2) | B06 | TODO |
| B11 | `B11-pack-chess.md` | suite 4 (Candidates 24 + Grand Swiss 23) | B06 | TODO |
| B12 | `B12-pack-badminton.md` | suite 5 (All England 25, MS + XD) | B06 | TODO |
| B13 | `B13-pack-tabletennis.md` | suite 6 (WTTC 25) | B06 | TODO |
| B14 | `B14-pack-volleyball.md` | suite 7 (Paris 24 M+W) | B06 | TODO |
| B15 | `B15-pack-hockey-icehockey.md` | suites 8 (Paris 24) + 9 (IIHF 25) | B06 | TODO |
| B17 | `B17-disruption-suite.md` | suite 12: blackout→reflow, walkover, correction | B15 | TODO |
| B18 | `B18-full-run-closeout.md` | all suites, perf baseline, report, docs, memory | all | TODO |

(No B16 — hockey+icehockey share the period-family playbook sheet and one
session; renumber only if that session splits in practice. Pack sessions
may pair further if research proves thin — record the pairing here.)

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

## Status log

(append as sessions run)

- 2026-08-13 — prompts authored, gated. S9+C0 merged; C1+S10 in flight.
  B-numbering: B16 intentionally absent (B15 covers suites 8+9).
