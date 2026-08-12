# Scheduler benchmark & smoke programme — design of record

Date: 2026-08-12. Status: **approved, EXECUTION BLOCKED — strict wait**
(owner ruling 2026-08-12): implementation starts only after BOTH
ScoringPad v2 (through S13 cutover) AND release-2 (C0–C8) are complete.
See §13 for the start trigger and what the wait buys. Next step when
unblocked: scout re-pin of every citation in this spec, then
implementation plan via writing-plans.

## 1. Purpose

A local, repeatable benchmark/smoke programme that proves the whole
tournament lifecycle — fixtures, scheduling, scoring, winners — against
**real historical tournaments**, and measures scheduler behaviour while
doing it.

Owner rulings (2026-08-12, this session):

- **Correctness gates red; performance is reported, never gated.** Timing
  tests flake under load on this machine (see memory: load-sensitive timing
  suites); solver wall time, OPTIMAL vs FEASIBLE, quality deltas are report
  fields only.
- **Demo-data factory**: seeded orgs are KEPT after a run (default
  `--keep`) so players/stats/news are browsable in the app afterwards.
- **Full-fat historical depth**: every match simulated at the sport's
  deepest engine-accepted fidelity tier, full real squads. The engine's
  fidelity ceiling bounds this per sport (fidelity ladder is CLOSED at 0–3;
  carrom strike-by-strike is not wired and stays out; boardgame is
  result-level — PGN blob deferred per #430).
- **We simulate; the real verdict is never fed in.** Packs carry raw event
  streams (balls, goals, points, cards). The engine folds them and derives
  winners/tables/stats itself. History is used only as the expected value in
  assertions. Same for scheduling: the scheduler produces its own timetable
  from real-world constraints; the historical timetable is used only as a
  feasibility certificate (§6) and a similarity metric, never copied in.

## 2. Architecture (chosen from three options)

**HTTP black-box + offline pack validator.** Follows the
`scripts/smoke.ts` / `scripts/seed-fifa2026.ts` lineage: everything stateful
goes through the real API (magic-link auth, cookie jar) against a local prod
server + fresh DB + local placement gRPC service. Stage 0 fast-fails each
data pack by folding all streams in-process (seconds, no DB) before the long
HTTP run.

Rejected: in-process usecase harness (bypasses the API layer, vitest wrapper
traps, seeding path ≠ production path); two-layer vitest+HTTP (double build
and maintenance cost for marginal coverage).

Data packs are **committed JSON built offline at authoring time** from
internet research. Bench runtime is fully offline — no network fetches.

## 3. Suite roster — 12 suites

Each real suite: One Org → One Competition → Two Divisions (variant contrast
where the sport has real variants). All 11 engine sport modules exercised.

| # | Suite / Org | Div A | Div B | Signature sim | Signature scheduling |
|---|---|---|---|---|---|
| 1 | Cricket — World Cricket Series | T20 World Cup 2024, all 55 matches, ball-by-ball (groups → Super 8 → KO) | Champions Trophy 2025 (ODI, 15 matches, ball-by-ball) — T20 vs ODI variant pair | USA–PAK super over; real DLS interruptions; concussion-sub cfg knob (S3) | 9 stadiums as courts; afternoon+night `sessionWindows`; `perEntrantMinRest` for travel |
| 2 | Football — UEFA Festival | Euro 2024, all 51 matches (goals/cards/subs with real minutes; 2 shootouts) | Futsal Euro 2026 (small-sided variant; sinbin) — fallback: Women's Euro 2025 if cfg fit poor | Yellow-accumulation suspensions (real banned players); own goals; UEFA h2h group tiebreakers | 10 venues; ≥3-day team rest; simultaneous final-round kickoffs via pins; 4–6 matches/day |
| 3 | Tennis — AELTC Championships | Wimbledon 2025 Gentlemen's, 128 draw, point-by-point where archived | Ladies' 2025 (best-of-3 preset = variant contrast) | Tiebreaks incl. 10-pt final set; retirement/walkover (2025 R1 heat retirements) | 18 courts; 14 days; 23:00 curfew blackout; show-court 13:30 starts; 1 match/player/day |
| 4 | Chess — FIDE Cycle (boardgame) | Candidates 2024 open, double round-robin, 14 rounds | FIDE Grand Swiss 2023 — swiss stage; real pairings seeded as manual rounds; buchholz oracle | Draws/nullable winner; half-point table; official tie-order | 1 round/day; rest days; afternoon-only `sessionWindows`; boards = courts |
| 5 | Badminton — All England 2025 | Men's Singles | Mixed Doubles — `pair` entrants sharing persons with Div A | Rally streams reconstructed to exact real set scores (provenance-flagged) | 4 courts → 1 finals court; morning/evening sessions; `crossPersonClash` |
| 6 | Table tennis — WTTC 2025 Doha | Men's Singles | Women's Singles | Expedite-rule stream; deciding-game deuces | Many tables → few; day caps |
| 7 | Volleyball — Paris 2024 | Men's Olympic tournament | Women's | 5-set tiebreaks; libero roster roles | One arena; 4–6 matches/day cap; pool interleaving |
| 8 | Field hockey — Olympic Hockey | Paris 2024 Men (shootout final) | Women | Green/yellow/red cards; fih-shootout preset | JOINT two-division scheduling on 2 shared pitches (`/competitions/{id}/schedule/ai-plan`) |
| 9 | Ice hockey — IIHF Worlds 2025 | Top division, 16 teams, 64 matches (OT final) | Division I-A (6-team RR) | OT + GWS; 3/2/1/0 points with OT-loss column oracle; penalty minutes; match-penalty ban | 2 arenas; 4–6/day; group parallelism |
| 10 | Carrom — ICF World Cup | Men's event | Women's | Board-level scores; deliberately thin-data suite — provenance % is the point | Few boards; short slots; dense days |
| 11 | Darts — PDC Worlds 2025 (generic module) | Main draw | Women's Series subset | Leg/set scores as generic events | 1 stage (court); 2 sessions/day; 3–4 matches/session — hardest packing test |
| 12 | Disruption & repair (reuses suite 8's org) | — | — | Post-schedule venue blackout → reflow; walkover; result correction → standings+stats recompute | Minimal-move repair assertion; pins survive |

Engines benched: `optimized` (CP-SAT placement service) primary, `greedy`
baseline for quality delta. **z3 excluded** — retirement in flight
(release-2 C4–C8); benching it would test a corpse.

## 4. Data packs

`scripts/bench/packs/<suite>.json`, validated by a zod `PackSchema`:

- org, competition, divisions (`sportKey`, `variantKey`, cfg overrides,
  `tiebreakers`, stages with kinds and real seeding/brackets);
- persons: full real squads (players), officials, coaches/staff — with
  `lane` (`player`/`official`/`coach`/`staff`, V348+V356);
- entrants (team/pair/individual) + rosters (`entrant_members` incl. squad
  numbers, positions, captain, libero role where real);
- per-fixture event streams keyed by fixture `ext_key`, each with
  `provenance: "real" | "reconstructed"` and source URLs in pack meta;
- `historicalAssignment` per fixture where known (real venue + start time)
  — the feasibility certificate input (§6);
- `expected{}` oracles: per-match result, per-stage final tables (points,
  GD/NRR/buchholz, exact tie order), champion, top-scorer/wicket/point
  leaderboards with counts, suspended players + which fixture they miss,
  special outcomes (super-over winner, shootout scores, DLS-revised
  targets);
- `meta.adaptations[]`: every place reality was reshaped to fit the model,
  human-readable (§7A).

**Reconstruction rule** (honesty clause): where a sport's per-rally sequence
was never publicly archived (badminton/volleyball/table-tennis rallies), a
legal sequence folding to the EXACT real set/game scores is generated at
pack-build time and flagged `reconstructed`. For side-level modules this is
semantically lossless — the module attributes rallies to sides, not persons.
Streams whose real per-event data exists (cricket balls, football
goals/cards with minutes, tennis slam PBP, hockey/icehockey goals and
penalties, chess results) are `real`. The report shows provenance % per
suite; suite 10 (carrom) is deliberately the thin-data resilience case.

Builders: `scripts/bench/build-packs/<suite>.ts` — run at authoring time
only, never by the bench. Sources cited in pack meta.

**Entitlement provisioning**: deep tiers are paid bands enforced on the
scoring API path (`usecases/scoring.ts` → `requiredFeatureForEvent`;
`cricket.ball` needs `scoring.ball_by_ball`). Seeding therefore sets each
suite org onto a plan that unlocks its deepest declared tiers, using
smoke.ts's `setPlan`-by-SQL precedent (no Stripe involved). The exact plan
key per feature is verified at plan time against the v17 plan map. Note:
per-ball timeline RENDERING in the match UI is unverified and is NOT a
bench gate — the browsable payoff is stats/leaderboards/player
cards/standings/news, which exist today.

**Stage 0 — pack validator** (runs at the start of every bench run, and as
a CI-safe vitest suite for the bench's own code): zod-parse every pack;
`foldMatch` every stream in-process; folded per-match outcome must equal
the pack's expected result; derived standings must equal expected tables.
Catches authoring errors in seconds and doubles as a pure-engine oracle for
the same data the HTTP run uses.

## 5. Scheduling scenarios

Per-suite `ScheduleConfig` (apps/web `api-v1/schemas.ts:743` vocabulary):
every knob covered by ≥2 suites —

- `sessionWindows` (afternoon-only chess; two-session darts),
- `blackouts` (Wimbledon curfew; suite 12 injection),
- `perEntrantMinRest` (cricket travel; Euro 3-day),
- per-day caps (volleyball, ice hockey — e.g. 4–6/day), encoded as
  `hard[]` day caps,
- courts 1 → 18 (darts single stage; Wimbledon),
- `noBackToBack`, `parallelism`, `crossPersonClash` (badminton doubles
  players in two draws), `fieldFairness`, `startWindows`, weekday/earliest-
  latest `hard[]` rules, pins (simultaneous kickoffs; chess round times;
  suite 12 locked fixtures).

Flow: `POST /stages/{id}/schedule/auto` → inspect → `/apply`; suite 8 uses
the joint competition-level plan; suite 12 exercises the repair path.
Short-window compression falls out naturally where the real events were
compressed — All England's whole draw in ~6 playing days, WTTC in a finals
week; day caps ride suites 7 and 9. (The "5 days, 4–6 per day" figures in
the original brief were examples of constraint variety, not literal
targets — the matrix above is the actual requirement.)

## 6. Verification model

Three independent layers; the solver's own word is never the evidence
(wrapper-parity lesson — a check that trusts the thing it checks is a
tautology):

1. **App validate**: `/divisions/{id}/schedule/validate` must return zero
   `blocking` conflicts (`ScheduleConflict.code` vocabulary).
2. **Independent checker** (bench's own code, no solver imports): fetches
   applied fixtures via API and recomputes every hard constraint — court
   double-booking, blackout/session-window containment, rest minima, day
   caps, pin integrity, official double-booking. Any violation = red.
3. **Feasibility certificate**: where `historicalAssignment` exists, check
   the REAL timetable against our encoded constraints first.
   - Certificate violates encoding → the pack encoded constraints stricter
     than reality: authoring bug; fix the pack, not the solver.
   - Certificate satisfies encoding and solver returns INFEASIBLE → proven
     solver/encoding defect → red.
   - FEASIBLE but ugly → hard violations red via layer 2; aesthetics go to
     believability metrics (report-only).
   - UNKNOWN/timeout leaving fixtures unplaced → red (unplaced fixture
     gate); wall time itself never gates.

Report-only believability metrics: gap dispersion, court utilisation
balance, home/away alternation, prime-slot fairness, greedy-vs-optimized
quality delta, similarity-to-historical-timetable %. **Round-order
violations are a GATE from day one** — the strict-wait ruling (§13) means
release-2 C1 (lexicographic round order) has shipped before the bench
runs; likewise conflict assertions target C3's structured details
(`{kind, ids…}`), never the deprecated legacy `detail` string, and the
repair suite tests the post-C4/C5 CP-SAT path (`none|optimized|llm`).
Nondeterminism probe: schedule twice, diff, report % (never red).

## 7. Misalignment protocol (owner-ratified)

**A. Reality doesn't fit the model — found at authoring time.**
Adaptable without losing test value → adapt + record in
`meta.adaptations[]` (e.g. NHL best-of-7 avoided by choosing IIHF Div I-A;
Euro third-place cross-group R16 seeding done by bench-as-organizer from the
real bracket). Genuine product gap a real customer would hit → escalate to
owner with evidence + effort guess; owner rules build/defer/drop. Out of
product scope (TV slots, prize money) → drop, note in meta. Adaptations
never red a run; gates only test what the system claims to support.

**B. Found by the run** → the product failing on data it claims to handle →
red with evidence (certificate logic above decides solver vs pack).

**C. Oracle mismatch at runtime when stage-0 passed offline** → app-layer
divergence between the API scoring path and the direct fold → red, real
finding (this is the parallel-vocab-paths defect class; the bench exists to
catch it).

**Issue policy** (standing RULES.md rule restated): NO new GitHub issues.
Verify first; real defect small + in blast radius → fix inline in that wave
with a failing-first regression test; blast radius past the task's files →
stop and escalate to owner. Runtime findings likewise: red in report →
fix-inline-vs-escalate fork. Never silently absorbed, never
file-and-walk-away.

## 8. Simulation & oracles

Per fixture, POST the pack stream through the real scoring API in order.
Stage-by-stage: standings assertion (points, GD/NRR/buchholz, EXACT tie
order — UEFA h2h in suite 2, FIDE rules in suite 4, OT-loss column in suite
9). Stage progression via app automation where it exists, else
bench-as-organizer advances the next stage per the real historical bracket
through ordinary admin APIs.

End-state gates per division: engine-derived champion == history;
`divisionPlayerStats` leaderboards == real top scorer / most wickets / most
points (name AND count); `personStats` for ~5 stars per suite == real
aggregates; discipline carry — the real suspended player is ineligible for
exactly the right fixture and absent from its lineup. Because the bench
starts post-S8/S9 (§13), the stat oracles assert against the rebuilt
player-stats and career-rollup pipelines from day one — a player appearing
in two suites (if any) gets a cross-division career-rollup oracle too.

Special mechanics each proven on a real instance: super over (1), DLS
revise (1), shootouts (2, 8), OT+GWS (9), 10-pt final-set tiebreak (3),
expedite (6), retirement/walkover (3), sinbin (2), concussion/mutable-squad
knob (1), draws + half points (4).

## 9. People-layer scenarios

- **P1 Officials**: real referees/umpires (`lane=official`);
  `autoAssignOfficials` + manual; official blackout →
  `warn.official_unavailable`; double-booking blocked
  (`listOfficialBusyElsewhere`); the final's official == the real final's
  official.
- **P2 Player claims**: `pc_` claim invites for ~3 stars/suite; accepted via
  magic-link as fresh users; claimed profile shows the real stats; one
  expired/invalid token path.
- **P3 Coach/staff lanes**: real managers as `role=coach` on rosters; a
  card against a coach never enters playing stats (S3 ruling, proven on
  real data).
- **P4 Repair** (suite 12): blackout injection → reflow; minimal-move
  assertion; pins survive; only affected fixtures move.
- **P5 Determinism probe**: report-only (§6).
- **P6 News**: `draftPostsForDecidedFixture` auto-drafts exist for decided
  fixtures (+ round recaps via `roundRecapDraft`); a few published via API
  → visible on the public org page; the rest stay draft;
  `shouldFirePostPublished` effects observed exactly once.

## 10. Runner, report, repo placement

- `scripts/bench/`: `bench.ts` entry; `packs/`; `build-packs/`; `lib/`
  (thin HTTP client + cookie jar of its own, independent checker, oracle
  differ, pino structured logging — owner logging rule; engine-side family
  is pino). **No smoke.ts refactor** — 13k-line monolith stays untouched.
- `npm run bench:scheduler -- [--suite <key>] [--engine
  optimized|greedy|both] [--keep|--wipe] [--report-dir <path>]` — defaults:
  `--keep`, `--engine optimized` (`both` doubles schedule-phase runtime and
  is the comparison mode, not the daily driver).
- **Pre-flight** (bakes in the known env traps): asserts its own DB
  (`show data_directory`), its own port PID (`lsof`), placement gRPC
  health, sports catalog synced (`sync:sports` witness — the funnel
  `badminton` check), refuses port 3000 and the local dev DB outright.
  Environment brought up per the `seazn-local-env` skill; a placement-
  service section is added to that skill as part of this work.
- Report: `bench-report/<run-id>/report.json` + `report.md` — per suite:
  phase timings (seed/schedule/sim), solver status + wall, conflict counts,
  believability metrics, oracle pass/fail detail, provenance %,
  claims/officials/news outcomes, adaptations list. Exit ≠ 0 on any gate
  red. ~60–80k events total across suites (Wimbledon PBP and cricket
  ball-by-ball dominate); expect a full run approaching an hour;
  `--suite` filters, and per-suite runs are the normal working mode.
- Gates (red): blocking conflicts; independent-checker hard violation;
  unplaced fixture; certificate-proven INFEASIBLE; any oracle mismatch
  (winner/table/stats/suspension/officials/news/claims); API 4xx/5xx on a
  scripted step; stage-0 pack validation failure.
- CI: **none** — local tool by design (smoke CI is PR-only; runtime too
  heavy). The bench's own library code (checker, PackSchema, oracle differ,
  reconstruction generator) ships a DB-free vitest suite that CI does run.
- Four-type test mapping for this task (RULES.md): unit = bench lib vitest;
  regression = pack-validator fixtures pinning each special mechanic; smoke
  = the bench itself (plus a tiny `--suite` run documented as the smoke
  entry); e2e = the bench IS an end-to-end exercise of the product APIs —
  recorded here so implementer sessions don't re-litigate.
- i18n: none owed — dev tool, no app-facing strings (`content/help` rule
  untouched).

## 11. Risk register (verify at plan time; triage per §7 issue policy)

1. Stage-progression automation may not exist → bench-as-organizer
   fallback is the decided default.
2. Swiss pairings are engine-incremental → historical pairings seeded as
   manual fixtures; verify manual fixture creation API supports it.
3. Futsal cfg fit unknown → Women's Euro 2025 is the named fallback for
   suite 2 Div B.
4. API `StageKind` (9 values) ⊃ DB CHECK (6, V210) — suites stick to
   league/group/knockout/swiss; divergence itself goes through §7 triage.
5. Event-POST throughput unknown (~40k events) — measure in suite 1; a
   batch endpoint would be new public API surface → escalate, never
   silently add.
6. Tennis walkover/retirement representation — verify engine path; else
   admin-finalize adaptation recorded in pack meta.
7. Placement service must run locally (Python gRPC,
   `PLACEMENT_SERVICE_HOST`) — pre-flight gate + seazn-local-env addendum.
8. Plan→feature map must cover every deep tier the packs use
   (`scoring.ball_by_ball`, `stats.player`, rally/strike keys if declared)
   — verify which plan key carries each; provisioning via `setPlan` SQL
   precedent. UI timeline rendering of tier-3 streams is explicitly not
   gated.
9. **Staleness by design**: every file:line, schema shape and enum cited
   here predates the strict-wait window (§13) — S8–S13 and C0–C8 all land
   on these surfaces before implementation begins. A scout re-pin of every
   citation is the FIRST task of the implementation plan, not optional
   hygiene (same rule the scoringpad index enforces).

## 12. Non-goals

- No CI wiring, no scheduled runs.
- No z3 benching (fully deleted by C8 before the bench starts).
- No synthetic volume suite (suite 1 at 55 ball-by-ball matches is the
  volume monster; revisit only if a real need appears).
- No smoke.ts refactor or shared-lib extraction.
- No UI work; browsing seeded data uses existing product surfaces.
- No fidelity-ladder extensions — fidelity stays 0–3, closed (#430); the
  bench consumes declared tiers only.

## 13. Prerequisites & start trigger (owner ruling 2026-08-12: STRICT WAIT)

Implementation does not begin — including pack authoring — until BOTH:

1. **ScoringPad v2 complete through S13** (cutover; S8/S9 rebuild the
   stats pipelines this spec's oracles assert against).
2. **Release-2 complete through C8** (C0 division_rules retirement, C1
   round order, C3 structured conflict details, C4/C5 CP-SAT repair, C7
   public contract rewrite, C8 z3 deletion — all touch surfaces this spec
   gates on).

What the wait buys: every churn-adjacent assertion (conflict shape, engine
enum, repair path, round order, stats) is written ONCE against the final
surfaces; round-order is a gate from day one; the bench lands as the
regression net for both freshly-completed programmes.

Start sequence when both indexes show done: (a) scout re-pin of every
citation here (risk 9); (b) writing-plans implementation plan; (c) pack
authoring (the long pole — internet research per suite); (d) runner
waves. Progress tracking lives in the memory file
`project_scheduler_bench_programme` and this spec's status line.

## 14. Appendix — product follow-ups surfaced by this design (no issues filed)

**SUPERSEDED 2026-08-13**: all 7 items now have owner-approved designs
and session prompts — see
`../portfolio-prompts/_INDEX.md` (D1–D7, sessions
P1–P11, build-gated). The list below stays as the origin record. One
sequencing change ratified there: D2/D3 (capacity, health) are now
specced as standalone engine libs built BEFORE the bench, with the bench
consuming the same functions — the "lift from bench" direction below is
reversed for those two.

Original capture (2026-08-12): items 1–3 lift from bench code after
bench v1; items 4–5 follow release-2; items 6–7 independent.

1. **"Start from a famous format" templates** — convert pack skeletons
   (stages, points, tiebreakers, schedule settings; minus real persons)
   into user-pickable templates via the existing #364 template mechanism.
   Biggest onboarding win; low lift once packs exist.
2. **Capacity pre-check + human INFEASIBLE explainer** — the bench
   checker's arithmetic as an instant pre-solve "20 matches × 60min don't
   fit 2 courts × 3 days — add a day, a court, or shorten slots" answer.
3. **Schedule health score** — believability metrics (gap dispersion,
   court balance, alternation, prime-slot fairness) as a post-schedule
   card. Same code as the bench checker.
4. **Stage progression automation** — group winners auto-flow to knockout
   slots per seeding rules; today's manual pain is exactly the
   bench-as-organizer fallback.
5. **Courts/venues as first-class entities** — courts are config strings
   and `tournaments.venue` is free text (V109); no availability
   calendars, per-court blackouts, capacity. Core multi-court-club need.
6. **Batch score-event import** — dual-use: bench throughput AND clubs
   migrating historical seasons from spreadsheets.
7. **Auto-news enrichment** — inject round top-scorer/leaderboard movement
   from `divisionPlayerStats` into `resultDraft`/`roundRecapDraft` drafts.
