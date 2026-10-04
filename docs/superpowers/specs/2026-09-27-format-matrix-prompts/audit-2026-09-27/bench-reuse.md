# Scheduler bench — reuse assessment for the format × sport matrix (L3)

Read-only survey of `main` @ `782628af5`, 2026-09-27. Legend: **[read]** = file opened and the
property checked; **[inferred]** = from docs/grep/commit absence, not proven by running.

Sources: `docs/superpowers/specs/bench-product-value/_MASTER.md` (last updated 2026-09-16),
`bench-prompts/_INDEX.md`, `_RULES.md`, `B17-disruption-suite.md`,
`designs/2026-08-12-scheduler-bench-design.md` §2–§18, `2026-09-02-product-gaps-from-bench-b03-prompt.md`,
`B03-/B05-review-findings`, `scripts/bench/**`, `.github/workflows/{bench,ci}.yml`, `gh pr list`.

---

## 1. Status per B-wave

| Wave | What | Status | Evidence |
|---|---|---|---|
| B00 | re-pin, risk answers | DONE 2026-08-26 | PR #657 |
| B01 | CLI, preflight, HTTP client, report | MERGED | #658 |
| B02 | PackSchema, stage-0 validator, reconstruct | MERGED | #701 `1cdcaf4c6` |
| B03 | seeding (org/comp/divs/persons/officials/plan/claims) | MERGED | #711 `3cfac6332` |
| B03r | registration entry path, Stripe payer, funnel oracle | MERGED | #713 `310eb22ac` |
| B04 | scheduling layer: auto/apply, independent checker, certificate | MERGED | #731 `6e70c7270` |
| B05 | simulation: event folds, advancement, 8 oracles | MERGED | #754 `c28c46752` |
| B06a | suite framework: registry, `run-suite.ts`, comparators, people layer | MERGED | #762 `c1203a373` |
| B06b | suite 11 darts pack (pilot). **PackSchema FROZEN here** | MERGED | #770 `38f5fb3b5` (+#771, #773) |
| B07a | match day by hand: TapAdapter, device-link gate, per-pool standings, all-division advancement | MERGED | #792 `18e64ab6a` |
| CI leg | `bench.yml` manual dispatch (R84), 3/3 green | MERGED | #793 `81e4cf8f9` |
| B07b | suite 10 carrom | TODO | — |
| B08–B15 | suites 1–9 (cricket, football, tennis, chess, badminton, TT, volleyball, hockey+icehockey) | TODO, none started | no branch, no pack |
| B16 | suite 13 "Club Open", UI-first customer journey | TODO | — |
| B17 | suite 12 disruption & repair | TODO (gated on B15) | prompt only |
| B18 | full run + closeout | TODO | — |

**In flight: nothing.** No open bench PRs (`gh pr list --state open --search bench` → `[]`). Local
branches `feat/bench-*` / `fix/bench-findings-*` show commits "ahead" of main only because they were
squash-merged; every one maps to a merged PR. One stale worktree `.claude/worktrees/bench-b06b`
(branch merged). Last code touch to `scripts/bench` was 2026-09-25 (docs line). `_MASTER.md` still
says B07a "not yet merged" — stale; `_INDEX.md` records it merged. The memory file
`project_scheduler_bench_programme.md` is also stale (says B07a executing).

Owner gates still in force: per-session owner green-light (creative-only ruling, 2026-08-13);
STRICT WAIT (S13 + C8) is satisfied since 2026-08-26; **PackSchema FROZEN** — additive change =
owner escalation in a PR, `schemaVersion` bump; `bench.yml` is `workflow_dispatch` only, no cron
(R84 — cron is a separate owner decision).

---

## 2. What exists in code

`scripts/bench/` (~56 test files, all DB-free, run by `ci.yml` "Bench lib unit tests" on every PR):

- `bench.ts` — CLI (`--suite --engine --entry --base --keep/--wipe --name --record-video --trace`),
  `npm run bench:scheduler`. **No `--sport`/`--format`/scenario flag.** Sport lives in the pack.
- `lib/suites/registry.ts` — two rows only: `_tiny`, `suite11`. `run-suite.ts` is the shared
  pipeline (5,936 lines — one monolith).
- Layers: `seed.ts`/`seed-plan.ts` (seeding over REST), `schedule.ts`/`board.ts`/`checker.ts`/
  `certificate.ts`/`believability.ts` (scheduling + independent 8-rule checker), `simulate.ts` (single
  POST, strict `expected_seq`), `import.ts` (batch import), `advance.ts` (propose→confirm→generate→
  complete, `compareQualifiers`, `compareFinalRanks`), `oracle.ts` (standings, tie-order cascade, rank
  crossings, champion, leaderboards, careers, person stats, suspensions, per-match winner/loser/method,
  specials against folded outcome/state/standings), `tap-play.ts` + `drivers/adapters/generic.ts`
  (Playwright pad — **only a `generic` TapAdapter exists**), `register.ts` (registration funnel),
  `people.ts` (claims, news), `validate-pack.ts` (stage-0 offline fold).
- **How it drives the product [read]:** HTTP black box against a real prod build (`next start`
  standalone), real Postgres, real placement gRPC, magic-link auth via dev-exposed `login_url`
  (`AUTH_DEV_LINKS=1`). Plus real Chromium for `play: "tap"` divisions. Not in-process. Stages are
  created directly via `POST /divisions/{id}/stages` with verbatim `config`/`progression` — it does
  NOT go through the format-template picker (`lib/format-templates.ts`, client-side).
  Fixture generation is ONE `POST /stages/{id}/generate` per stage — **no per-round generation**, so
  swiss / mexicano / ladder dynamic rounds are unsupported.
- **Asserts [read]:** per-match outcomes, stage standings incl. exact tie order, qualifier order from
  the progression rule, advancement across every division, `finalRanks` (captured from the `complete`
  response), champion (`rank 1` × `finalRanks[0]`), leaderboards/careers/person stats, suspension
  carry, specials. NO SUBJECT is a third verdict (never PASS). Schedule: app validate + own checker +
  feasibility certificate. Timings report-only.
- **CI [read]:** `ci.yml` (pull_request) runs the lib unit suite only. `bench.yml` = full live run,
  `workflow_dispatch` + `pull_request` scoped to its own path; default `--suite _tiny`, ~3–3.5 min.

### Suite table

| Suite | Sports | Formats / stage kinds | Implemented? | Pack committed? | Asserts standings / progression? |
|---|---|---|---|---|---|
| `_tiny` d-tiny | generic | league (3 legs, 2 entrants) → knockout, `rankRange 1–2`, `timing: setup` (= league_ko) | yes, played by TAP | yes `_tiny.json` (generated) | yes — table, qualifiers, finalRanks, champion, retirement special |
| `_tiny` d-badminton | badminton (bwf) | league | yes (import path) | yes | yes — table (reconstructed rallies) |
| `_tiny` d-registration | generic | knockout | yes (registration entry) | yes | funnel + bracket |
| `_tiny` d-tiebreak | generic | league | yes | yes | yes — tie-order cascade `points,diff,for` |
| suite11 d-worlds | generic (darts) | knockout (96-draw, `config.slotOrder`) | yes (api single-POST) | yes `suite11.json`, 205 streams / 1,425 events | matches, finalRanks, champion, leaderboards |
| suite11 d-womens | generic (darts) | knockout | yes (import) | yes | same |
| 1 T20WC24 + CT25 | cricket | groups → Super 8 → knockout | NO (B08) | no | — |
| 2 Euro24 + WEuro25 | football | groups → knockout (UEFA h2h) | NO (B09) | no | — |
| 3 Wimbledon 25 ×2 | tennis | knockout 128 | NO (B10) | no | — |
| 4 Candidates + Grand Swiss | boardgame | double RR league; swiss (manual rounds) | NO (B11) | no | — |
| 5 All England 25 | badminton | knockout (MS, XD pairs) | NO (B12) | no | — |
| 6 WTTC 25 | tabletennis | knockout | NO (B13) | no | — |
| 7 Paris 24 volleyball | volleyball | pools → knockout | NO (B14) | no | — |
| 8 Paris 24 hockey | hockey | pools → knockout, joint 2-div scheduling | NO (B15) | no | — |
| 9 IIHF 25 | icehockey | groups → knockout; Div I-A RR | NO (B15) | no | — |
| 10 ICF carrom | carrom | 4 pools → knockout | NO (B07b) | no | — |
| 12 disruption | (suite 8 org) | — | NO (B17) | n/a (scripted, not a pack) | — |
| 13 Club Open | UI-first journey | — | NO (B16) | no | — |

**Coverage today: 2 sports (generic, badminton) of 11; 2 stage kinds (league, knockout) of 9; 2
templates-equivalent (league, knockout, league_ko) of 16.** Never exercised: group, swiss,
double_elim, stepladder, americano/mexicano, ladder, page_playoff; sports football, cricket, boardgame,
carrom, volleyball, tabletennis, tennis, icehockey, hockey. Offline validator does know
`TABLE_STAGE_KINDS = league|group|swiss|americano` and per-pool standings (B07a) — code paths without
a live pack.

---

## 3. Disruption scenarios — modelled vs your list

The disruption/repair suite (B17, suite 12) **does not exist** — prompt only; no `disrupt.ts`.
Planned scope: venue blackout → reflow (minimal-move, pins survive, pinned-in-blackout typed refusal
then unpin+repair), withdrawal pre-KO, result void/correction (standings + stats + news + hash
chain), determinism probe.

| Your scenario | Bench today | Bench planned |
|---|---|---|
| single-match walkover | **YES** — `core.forfeit` in stream (`_tiny` rr-r3-c1 retirement special; suite11 `se-r0-i19`); forfeit reason now preserved in all 11 modules | — |
| retirement | YES — same `core.forfeit` special on `_tiny` (generic only) | B10 tennis real retirements |
| withdrawal mid-event | no | B17 §2 (pre-KO only) |
| double walkover | no | no |
| abandon / no-result | no (`core.abandon` / `core.suspend` / `core.resume` exist in engine, unused) | no |
| void / correct result | no (`core.void` exists, unused) | B17 §3 |
| late entry | no | no (registration funnel is pre-start only) |
| rebuild / regenerate | no | no |
| ties to lots | partial — tie-order cascade oracle (`d-tiebreak`); `lots` is a legal tiebreaker key but not driven | B11 chess FIDE tie-order |
| unequal pools | no (per-pool standings code exists, no pooled pack) | B07b carrom (4 pools) |
| cut-short event | no | no |
| protest / replay | no | no |
| points deduction | no (`rank_overrides`/`carry_deltas` folded offline in validator, never driven) | no |
| suspension / discipline carry | YES — `_tiny` 1 suspension, 422 `SUSPENDED_PLAYER` gate asserted live | B09 football |
| blackout → reflow / repair | no | B17 §1 |
| determinism | report-only nondeterminism probe planned | B17 §4 |

---

## 4. Product gaps found by the bench — status on main

**G1–G9 (B03 prompt doc): all 9 resolved** — 8 fixed (#706, #709, #710), G4 withdrawn. **§17 (B05)**
1 not-a-defect, 1 overstated, 2 fixed. **§18 (B06a)**: all 6 fixed (#763–#766).

**Still open (7):**

| # | Finding | Source | Status on main |
|---|---|---|---|
| 1 | Repeat `POST /stages/{id}/complete` re-runs `computeSeedProposal` on the next `setup`-timed stage, minting a new draft proposal (and staling the prior) per call until organiser confirms | B07a (live-proven), owner ruling owed | **OPEN [read]** — `completeStage` (`usecases/stages.ts:4140`) still guards only `!result.completed`; `completeStageIfReady` (`engine-db/competition.ts:575`) returns `{completed:true, events:[]}` for an already-complete stage; `progressCompletedStage` calls `computeSeedProposal` with no repeat check |
| 2 | Court double-booked across two competitions of one org — every occupancy seam is competition-scoped | §15.1 (B04) | **OPEN [read]** — `siblingAssignments` (`schedule.ts:939`) still `where competition_id = …` |
| 3 | Optimized path returns `solver_unavailable` at 0/6 tiers in <1 s on a 30 s wall (suite 11) | B06b | **OPEN [inferred]** — logging fixed (#773) but no recorded re-run to read the reason |
| 4 | `start_window` coded `conflict.` (hard) but `isBlockingConflict` omits it → ships non-blocking | §15.2 | **OPEN [read]** — `calendar.ts:319` lists `window`, not `start_window` |
| 5 | `crossPersonClash` deprecated, read by no server logic; UI control still offered | §15.3 | **OPEN [read]** — still in `ai-apply.ts`, `ai-console.tsx`, schedule page |
| 6 | No way to request/require a scheduling engine (silent greedy fallback) | §15.4 | **OPEN [read]** — `AutoScheduleRequest` has `mode` only |
| 7 | SSR `<html lang>` stays `en` pre-hydration (client-side fix only) | §17.4 residue | **OPEN [read]**, owner trade-off (ISR) — `layout.tsx:61` |

Bench-side (not product) gaps also open: `PackStage.bracket`/`.seeding` are documentation, not wiring
[read, pack-schema header]; `deviceLinksGranted:false` early return trusts a heuristic (accepted
risk); R60 mint pacing + live parallel-play cap unproven; engine delta not yet a measurement (§16.4).

Relevant to your matrix: #1 bites every multi-stage `setup`-timed format (league_ko, groups_ko,
group_stepladder, group_playoffs, swiss_playoff, swiss_knockout, qualifying_main) under client retry;
#2 bites any org running two competitions on shared courts.

---

## 5. Reuse assessment for L3 (server + engine, no browser, full cartesian)

### What transfers well
- **The runner shape is exactly L3's shape**: real prod server + real DB + real placement, HTTP black
  box, no browser needed (`play: "api"`/`"import"` per division). Seeding, scheduling, simulation,
  advancement and oracles are all layered libs with injectable transports and ~56 DB-free test files.
- **Oracles are the most valuable asset**: standings incl. exact tie cascade, qualifier order derived
  from the progression rule, `finalRanks` capture, champion cross-check, specials against folded
  outcome/state/standings, NO-SUBJECT verdict (kills vacuous PASS — a lesson it learned twice).
- **Stage-0 offline validator** = an engine-only oracle that could be L3's fast inner loop.
- **PackSchema can already express every template** without a schema change: `stages[].config` and
  `progression` are opaque pass-throughs, `StageKind` is imported from the engine (all 9 kinds), sport
  is `sportKey`+`variantKey`+`moduleVersion`, provenance allows `"synthetic"`.
- CI leg exists (`bench.yml`) and is proven 3/3 green in ~3.5 min.

### What is missing for L3
1. **Scenario injection** — no mid-run mutation hooks (withdraw, void, correct, abandon, late entry,
   regenerate, deduct, blackout). The pipeline is linear seed→schedule→simulate→advance→oracle inside a
   5,936-line `run-suite.ts`; there is no step list to splice into. B17's `disrupt.ts` was designed as a
   bolt-on for one suite, not a generic scenario engine.
2. **Dynamic-round formats** — generation is one-shot per stage; swiss, swiss_playoff, swiss_knockout,
   mexicano, ladder need per-round generate/pair loops and ext_keys unknown at authoring time.
3. **Sports** — 2/11 have ever run live; only a `generic` TapAdapter (irrelevant for L3, but each sport's
   event vocabulary / stream generator is unproven through the product except generic + badminton).
   `reconstruct.ts` has a set-based generator; cricket/football/period/nested stream generators are not
   built.
4. **Formats** — 3 of 21 rows exercised (league, knockout, league_ko). double_elim, stepladder,
   page_playoff, americano, ladder, group never run live.
5. **Expected values** — the bench's oracle direction is "history is the expected value". A synthetic
   cartesian has no history; expected standings/finalRanks must come from somewhere independent of the
   product (hand-authored per cell, or the offline stage-0 fold — which is the engine checking itself,
   i.e. only catches app-layer divergence, §7C).
6. **Parameterisation** — one suite per registry row, one pack per suite, one run per process; no
   matrix driver, no `--sport/--format/--scenario` flags (the CI file explicitly says per-sport dispatch
   is "CLI work first").
7. **Throughput** — a full run is minutes per suite (build + seed + schedule + solver). 21×11×62
   ≈ 14k cells cannot each pay a scheduling/solver leg; L3 needs `schedule` skippable per cell.

### Conflicts / risks
- **Frozen PackSchema.** Any scenario block (e.g. `disruptions[]`) or synthetic-expected fields is an
  additive schema change → owner escalation + `schemaVersion` bump. Avoid by keeping scenarios OUTSIDE
  the pack (a sibling scenario file, as B17 intended).
- **Bench non-goals** (§12): "No synthetic volume suite", "No CI wiring, no scheduled runs" (the latter
  already relaxed to manual dispatch). A synthetic cartesian contradicts the bench's charter — it should
  be a SEPARATE programme that imports bench libs, not a B-wave, or it needs an owner ruling.
- **Per-session owner green-light** for any bench session; B17 is gated on B15 (suite-8 hockey org).
  Building disruption inside the bench means waiting on B15 or re-ordering with owner consent.
- **Oracle-direction rule** (`_RULES.md` §3): no helper may write an outcome into the DB. Scenario
  injections must go through real organiser routes (withdraw, void, forfeit) — compatible with L3, but
  rules out shortcuts like direct SQL standings edits.
- `run-suite.ts` monolith: extending it in parallel with bench B07b–B15 waves creates merge conflicts;
  B07b–B16 are declared "parallel-safe" only because pack files are disjoint.
- Open product finding #1 (repeat `/complete`) will surface as flake in any L3 harness that retries.

### Recommendation
Reuse the bench **as a library, not as the harness**. Build L3 as its own runner under the new
programme that imports `lib/http.ts`, `seed.ts`, `simulate.ts`/`import.ts`, `advance.ts`, `oracle.ts`
and `validate-pack.ts`, generates PackSchema-valid **synthetic** packs per (format, sport) cell
(stages/progression copied from `format-templates.ts` shapes, streams from per-sport generators, seed
fixed), and keeps scenarios in a separate step-script alongside the pack so the frozen schema is
untouched. Needed new pieces: a step/hook pipeline (or a refactor extracting `run-suite.ts` into
callable phases), per-round generation for swiss/mexicano/ladder, per-sport synthetic stream
generators for 9 sports, an independent expected-value source (hand-authored golden cells for L1/L2,
stage-0 fold for the cartesian with that limitation stated), and a no-schedule fast path. Take this
to the owner as a recommendation: it overlaps B17 (disruption) and the unbuilt B07b–B15 sports, so
either the bench's B17 is folded into the new programme or the two are sequenced explicitly —
not both built. Fix or rule on open finding #1 before L3 runs at volume.
