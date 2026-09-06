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

**B00 re-pin (2026-08-26).** All nine answered with evidence; none open.

1. **RESOLVED — automation exists, bench-as-organizer fallback not
   needed.** `completeStage` (`apps/web/src/server/usecases/stages.ts:2248`)
   auto-advances on its `on_complete` timing branch
   (`stages.ts:2336-2338`); the `setup`-timing branch computes a seed
   proposal automatically too (`stages.ts:2269-2298`). All three P5/P6
   engine entry points are plain REST routes, no UI dependency:
   `POST /api/v1/stages/{id}/complete`
   (`app/api/v1/stages/[id]/complete/route.ts:8`),
   `POST /api/v1/stages/{id}/generate` → `generateStageFixtures`
   (`.../generate/route.ts:8`), `POST .../seed-proposal/confirm` →
   `confirmSeedProposal`. A bench caller drives full advancement with one
   `POST .../complete` call (on_complete timing) or a two-step
   complete→confirm (setup timing), guarded only by
   `requireResourceAuth`.
2. **RESOLVED — manual fixture creation API supports swiss directly.**
   `POST /api/v1/stages/{id}/fixtures` → `addFixture`
   (`app/api/v1/stages/[id]/fixtures/route.ts:11`,
   `usecases/stages.ts:3219`). `ADHOC_STAGE_KINDS = new
   Set(["league","group","swiss"])` (`stages.ts:3217`) explicitly
   includes swiss (ladder/americano explicitly rejected at
   `stages.ts:3238-3242`, brackets rejected generically at
   `:3244-3245`). Request shape `AddFixture`
   (`server/api-v1/schemas.ts:753`, `.strict()`): `home_entrant_id`,
   `away_entrant_id`, optional `round_no`, `scheduled_at`, `venue_id`,
   `court_id`. Body does round/seq bookkeeping (`stages.ts:3291-3296`)
   then a plain `insert into fixtures (...) returning id`
   (`stages.ts:3310-3318`) — no scheduler/solver call. Arbitrary
   entrant pairing + explicit `round_no` for a swiss stage is directly
   supported.
3. **DECIDED — futsal does not fit; use Women's Euro 2025.** Football's
   cfg (`packages/engine/src/sports/football/football.ts`) is
   futsal-aware on roster shape (`teamSize: 2-11` at `:158`, comment:
   "FA Mini-Soccer and the small-sided/futsal codes run 5, 7 or 9 a
   side"; `rollingSubs` at `:126`) but has **zero** offside-replacement
   or kick-in-vs-throw-in representation anywhere in the event
   vocabulary (grep for `offside`/`throw.in`/`kick.in` under
   `sports/football/`: zero typed events, prose only), and **zero**
   fixture/golden-corpus/domain-test evidence the module has ever
   scored a futsal-shaped match (`football.domain.test.ts:421` mentions
   futsal only in a comment). Suite 2 Div B uses Women's Euro 2025.
4. **RESOLVED — the divergence itself is closed, not merely triaged.**
   `StageKind` (`packages/engine/src/core/types.ts:91-101`, 9 values:
   league, group, swiss, knockout, double_elim, stepladder, americano,
   ladder, page_playoff) and the DB `stages_kind_check` are equal today.
   Two migrations widened the original 6-value V210 constraint, not
   one: `V249__format_extensions.sql` took it 6→8 (americano, ladder),
   then `V298__page_playoff_stage_kind.sql:12-15` took it 8→9
   (page_playoff), matching the API enum exactly. No migration since
   V298 touches it (confirmed by grepping every delta for `kind in`).
   league/group/knockout/swiss were never actually at risk — only the
   3 extra values were the gap, and V298 closed it, pre-dating B00.
5. **MEASURED — a batch endpoint already exists; it is not new public
   surface.** Single-event path: `POST
   /api/v1/fixtures/{id}/events` (`app/api/v1/fixtures/[id]/events/
   route.ts:11`) → `scoreEvent` (`usecases/scoring.ts:82`), one event
   per request. Batch path: `POST /api/v1/divisions/{id}/events/import`
   (`app/api/v1/divisions/[id]/events/import/route.ts:24-32`), shipped
   by P11 (D6, merged `ee5aa1a01` #653) — `EventImportRequest`
   (`server/api-v1/schemas.ts:962-990`) takes `streams[]`, each a
   fixture + its events; server assigns `seq`, `core.void` refused.
   Hard caps in `usecases/event-import.ts:40` (`IMPORT_CAPS`): `streams:
   50`, `eventsPerFixture: 1_000`, `eventsPerCall: 10_000` (413 on
   breach; `assertWithinCaps` checks streams/per-fixture at `:90-108`,
   `eventsPerCall` at `:109-116`). No per-request-count or
   bandwidth rate limit exists on either route — `MUTATION_LIMIT`
   (`lib/rate-limit.ts:74`) is defined but has zero callers. For suite
   1's ~40k events / 55 fixtures: fits the batch route only split across
   ≥4 calls (`eventsPerCall` cap) and ≥2 calls (`streams` cap, 55 > 50).
   **Open for B05 to decide, not re-opened here**: the import route is
   built for historical bulk load, not necessarily the live
   simulate-never-feed-verdicts model (§8) — whether suite 1 uses batch
   import for pack loading vs per-event `scoreEvent` POSTs during
   simulation is a modeling call, made with full facts now on the
   table. Either way, `import.events` is feature-gated with **no
   `plan_entitlements` row yet** (dark until an org gets an override) —
   using the batch route needs the `setPlan`-style SQL override
   precedent (risk 8).
6. **RESOLVED — real engine path exists, no pack-meta adaptation
   needed.** `core.forfeit` folds in all three sport-family kernels —
   `sports/nested/kernel.ts:2126`, `sports/period/kernel.ts:2402`,
   `sports/setbased/kernel.ts:1713`. Tennis runs the nested-kernel
   preset (`sports/tennis/tennis.ts:7`, `makeNestedModule`), so
   `sports/nested/kernel.ts:2126` is the one that fires. Tennis's
   `padSpec` declares no Retire tile by design (R4 ruling R4-2,
   `2026-08-15-scoringpad-v3-prompts/_INDEX.md:1825`) because
   `fixture-console.tsx:700-728` already ships a Forfeit control with a
   reason prompt at the fixture-console level — a second Retire entry
   point in the pad would duplicate it. R4 also added an Interruption
   tile (medical/heat/toilet) that precedes a real retirement. The
   bench drives walkover/retirement through the console-level forfeit
   endpoint, not a pad tile.
7. **RESOLVED — recipe already exists**; addendum below adds the one
   missing piece. `~/.claude/skills/seazn-local-env/SKILL.md` §3b
   already covers env vars (`PLACEMENT_SERVICE_HOST`,
   `PLACEMENT_SERVICE_SECRET`), native and container bring-up, and the
   health probe (`{"event": "service_listening", "port": 50051}` log
   line, 180s readiness budget). What it did NOT carry: the bench's
   own run-both-ways rule (`_RULES.md` §2) — added to §3b as an
   addendum in this B00 pass.
8. **RESOLVED.** Registry: `db/migration/deltas/V112__entitlements_v2.sql`
   — `scoring.ball_by_ball` (:48-50), `stats.player` (:60-62), and a
   third deep-tier key not named in the original risk,
   `scoring.rally_by_rally` (:51-53); all three also granted on
   `pro_plus` (`V290__pro_plus_plan.sql:28` ball_by_ball, `:30`
   rally_by_rally, `:32` stats.player). No "strike"-keyed
   entitlement exists anywhere (searched `apps/web/src`,
   `packages/engine/src`) — packs must not declare one. Both original
   keys are still literal and live at
   `apps/web/src/lib/entitlement-domains.ts:30-31`. `setPlan`
   (`scripts/smoke.ts:15529-15566`) flips `subscriptions.plan_key` via
   raw SQL then calls `bustOrgEntitlements`; call pattern `await
   setPlan(orgId, "pro", owner)`, 30+ precedent call sites in
   `smoke.ts`. `sync:sports` = `package.json:36` →
   `scripts/sync-sports.ts`.
9. **Staleness — closed by this pass.** Every citation above and every
   B-prompt referencing them is re-pinned as of 2026-08-26 (B00). Later
   sessions re-pin locally per `_RULES.md` §1, as before.

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

## 15. Appendix — product findings surfaced by the B04 BUILD (no issues filed)

§14 records what the design surfaced. These four were surfaced by building
B04's scheduling layer — before it had run against a live server once. Same
policy: no GitHub issues (`RULES.md:98`, `_RULES.md:11`, §7). Owner ruled
2026-09-05 that finding 1 is recorded here and fixed in a SEPARATE change,
not inside B04.

1. **A court can be double-booked across two competitions of one org, and
   nothing notices.** CONFIRMED across all six enforcement seams.

   `courts` are **org**-scoped (`V367__venues_and_courts.sql:48` —
   `org_id not null references organizations(id)`), but every occupancy
   consumer derives its board from `siblingAssignments`, whose one scoping
   clause is `where division_id in (select id from divisions where
   competition_id = ${competitionId} …)` (`usecases/schedule.ts:857-861`).

   | Seam | Verdict |
   |---|---|
   | placer obstacle input (`autoSchedule`, `schedule.ts:1575`) | BLIND — `divisionFixtures` + competition-scoped siblings |
   | `candidate-courts.ts:80` | N/A — pure tag/archived filter, no occupancy input of any scope |
   | publish / start (`schedule.ts:3573`, `:3685`) | BLIND — both call the same competition-scoped validator |
   | `moveFixture` (`schedule.ts:3040`) | BLIND — the drag gate's whole world is one competition |
   | DB constraints | BLIND — no `exclude using` / `btree_gist` / `tstzrange` anywhere in `db/` |
   | `services/placement/` | BLIND — no DB; sees only the caller's already-scoped board |

   Cleared as non-substitutes: `resolveCourtCalendars`
   (`court-candidates.ts:171`) reads only `court_hours`/`court_exceptions`, so
   opening hours cannot stand in for a booking; `capacity-guard.ts:233`
   assesses only `body.fixtures`.

   **Customer:** a club runs a Saturday junior league and an adult ladder as
   two competitions on the same six courts. Each organiser auto-schedules,
   sees a green board, and publishes. Both send players to Court 3 at 10:00.
   It surfaces when two pairs walk onto the same court.

   Fixing it means widening sibling occupancy from competition to org scope
   across five consumers (auto-schedule, drag-move, validate, publish, start),
   plus a decision on whether a cross-competition clash blocks or warns —
   blocking would refuse boards organisers can publish today.

2. **`start_window` is coded as a hard refusal and never blocks.**
   `ConflictReason`'s own comment calls it `(hard)` and `REASON_CODE`
   (`apps/web/src/lib/schedule-board.ts:25-40`) gives it the `conflict.`
   prefix reserved for hard refusals — but `isBlockingConflict`
   (`calendar.ts:319-341`) omits it, so it ships `blocking: false`. That
   function's three deliberate carve-outs each state their reasoning; this one
   is unmentioned, which is what makes it look unintended rather than decided.
   Either the prefix or the predicate is wrong.

3. **`crossPersonClash` is deprecated and read by nothing**, so bench spec §5's
   requirement that ≥2 suites cover that knob cannot be met. `#399` made an
   introduced person double-booking refuse absolutely (`isBlockingConflict`
   lists `person_overlap` unconditionally) and the placer avoids one for the
   same reason, so neither side consults the setting: `"hard"` and `"warn"`
   produce identical behaviour. **Affects B12's acceptance** — a pack setting
   it proves nothing. The organiser-facing control it backs should be retired
   with its UI and dictionaries, in its own change.

4. **No one can request or require a scheduling engine.** `AutoScheduleRequest`
   (`schemas.ts:1643-1688`) has no engine field, and no env var, flag, setting
   or column selects one: `build.ts:1165-1204` always attempts the solver and
   falls back to greedy only on `MAX_SOLVER_QUEUE`, `canSolveWithin`, or an
   unreachable placement service. A customer cannot ask for a fast greedy
   board, nor insist a board be solved rather than silently fall back.
   `AutoScheduleResult.solver.engine` reports which ran, so the information
   exists and nothing lets anyone act on it. This is why B04's `--engine`
   became an assertion rather than a selector.

## 16. Appendix — B04's first live run: what it measured, and what it could not

§15 records what BUILDING B04 surfaced, expressly "before it had run against a
live server once". This section is the opposite: the one empirical result the
bench has produced, and why it does not yet answer the question the bench
exists to ask. Same policy — no GitHub issues.

Run `f1e38f5b420689a58c5f9c0a741faa0494f52c27`, three legs at one SHA on
2026-09-06: `--engine optimized --wipe` with placement live, `--engine greedy
--wipe` with it torn down, then `--engine both --wipe` for the delta. All three
green, all three artifacts written, delta rendered.

### 16.1 The numbers, read out of the artifacts

`_tiny`'s two divisions, verbatim from `engine-optimized.json` and
`engine-greedy.json`:

| Division | Leg | `actualEngine` | `solverStatus` | tiers | makespan | worst idle gap | court imbalance |
|---|---|---|---|---|---|---|---|
| `d-tiny` | optimized | optimized | `ok` | 6/6 | **1470** | **1350** | 30 |
| `d-tiny` | greedy | greedy | `solver_unavailable` | 0/6 | **1410** | **1305** | 30 |
| `d-badminton` | optimized | greedy | `already_optimal` | 6/6 | 30 | 0 | 30 |
| `d-badminton` | greedy | greedy | `solver_unavailable` | 0/6 | 30 | 0 | 30 |

The legs genuinely ran different engines — which is what `--engine`'s assertion
exists to establish, with `tiersCompleted` 6 against 0 as the corroboration.

The rendered delta reads `makespan -60min, court imbalance 0min` under the
report's own convention that positive means optimizing bought it. So on the
only division where CP-SAT actually ran, the optimized board scored 60 minutes
WORSE on makespan.

### 16.2 That reading is weaker than it looks — neither metric discriminates here

PR #731's body called this result surprising, "the optimizer losing to greedy
on the ladder's first rung". Reading the metric definitions rather than the
numbers alone gives a sharper and much less alarming answer, and that is the
version to carry forward.

Both are defined in `build-objectives.ts`'s metrics block:

- `makespanMinutes` is `(hi - lo)` — last end minus first start across the
  whole board, so it spans nights, not just playing time.
- `worstIdleGapMinutes` is computed over `byParticipant`: the worst wait ONE
  participant has between two consecutive fixtures of theirs.

On `d-tiny` the optimized board's worst participant gap is 1350 of its 1470
minutes. Someone plays on day 1 and again on day 2, and 22.5 hours of that
"makespan" is the night in between. Greedy's is 1305 of 1410 — same shape.
Net the overnight hole out and the two boards span 120 and 105 minutes.

So the 60-minute difference is where a fixture sits AROUND a forced multi-day
gap, not evidence that CP-SAT packed worse. And the delta's other reported
metric, court imbalance, is 30 in both legs — identical.

**The finding is therefore about the bench, not the product: on `_tiny` the
rendered delta carries no engine-discriminating information at all.** One of
its two metrics is dominated by the inter-day span; the other does not move.
Telling the engines apart needs a pack with enough fixtures inside ONE day for
packing quality to reach the span.

### 16.3 The capability gap that would make even a good pack unattributable

Grant a discriminating pack and the current protocol still could not attribute
a difference to the engine, because the two legs are not the same input. Both
must pass `--wipe` (`B04-handoff-2026-09-05.md`), so each seeds its own org,
competition, entrants and fixtures with fresh row identities. Whether greedy's
placement order is sensitive to those identities is UNVERIFIED — which is
precisely the problem: a confound cannot be dismissed without being eliminated.

`--wipe` is forced because the alternative does not schedule. `--keep` (the
CLI's default) short-circuits on an unchanged pack hash and skips seeding AND
scheduling. Since T7e it reports `gate: "skipped"` rather than a bare green, so
the mistake is now loud — but it still measures nothing.

Making `--keep` re-schedule an existing seed is not a branch edit.
`findExistingSeed` returns `{ kind: "reuse", orgId, competitionId }` — two IDs.
Scheduling consumes the whole `SeededSuite`: seven ref→ID maps (`venueIdByRef`,
`courtIdByRef`, `divisionIdByRef`, `stageIdByRef`, `personIdByRef`,
`entrantIdByRef`, `fixtureIdByKey`). Closing the gap means a re-hydrator that
fetches all seven back from the API — an inverse of the seeder, carrying its
own failure mode worth stating before anyone starts: **a ref→ID map rebuilt
wrongly schedules against the wrong court and every checker rule still
passes**, because the checker judges the board it is handed, not the board that
was intended.

### 16.4 What a later wave owes

1. A pack whose fixtures sit within one day densely enough that makespan
   measures packing rather than nights. `_tiny` cannot, by construction.
2. Either the re-hydrator above, or a pinned-identity seed so two `--wipe` legs
   produce identical input. The second is cheaper and unexamined: `runTag` is
   already threaded through `SeedSuiteInput` and merely minted per run at
   `suites/tiny.ts`, but whether DB-generated identities reach the placer's
   ordering has not been established either way.
3. Re-run the comparison and settle 16.1 as a result rather than a candidate.

Until then the engine delta is a proven PIPELINE — it computes, it renders, and
it survives a leg whose divisions resolve different engines — carrying a number
that is not yet a measurement.
