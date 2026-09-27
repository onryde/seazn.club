# Format × sport matrix — design of record

- **Date:** 2026-09-27
- **Status:** design approved in conversation (Sections 1–3); written spec awaiting owner review
- **Programme index:** `2026-09-27-format-matrix-prompts/_INDEX.md` (owner rulings, decision log, status)
- **Standing rules:** `2026-09-27-format-matrix-prompts/_RULES.md`
- **Inputs:** `2026-09-27-format-matrix-prompts/audit-2026-09-27/` (five read-only audits, the offered-cell map, the bench reuse assessment)

## 1. Why

A week of heavy change (Swiss hardening, fixture generation, round codes,
standings qualification, per-stage match rules, printable QR scorer sheets —
~40 PRs, 2026-09-20 → 09-27) was followed by five read-only audits on
2026-09-27. They found **~150 gaps**:

| Area | High | Med | Low | File (prefix) |
|---|---|---|---|---|
| Swiss | 4 | 13 | 12 | `SW-swiss.md` (SW-) |
| Fixture generation, other formats | 5 | 10 | 9 | `FX-fixtures.md` (FX-) |
| Standings tables | 4 | 19 | 10 | `ST-standings.md` (ST-) |
| Scoring: points / NRR / shoot-outs | 5 | 17 | 22 | `SC-scoring.md` (SC-) |
| QR scorer sheets | 1 | 8 | 11 | `SH-sheets.md` (SH-) |

Gap IDs collide across files (`G1` exists in three), so **every gap is cited
with its file prefix**: `FX-G1`, `ST-G1`, `SH-G1`.

The audits read code and ran the engine in places; they did **not** drive the
product. Every gap is a hypothesis until a wave's truth run reproduces it
(`_RULES.md` R5).

Two structural facts drive the design:

1. **No door restricts sport × format.** The builder, templates, stage API and
   DB accept every one of 21 format rows × 11 sports = **231 cells**. The engine
   only decides whether a draw is allowed (`module.ts:830`, enforced at
   `append-event.ts:335`). **37 cells cannot work** and are offered anyway —
   americano/mexicano for every sport but generic (the console writes
   `generic.result`, which every other sport rejects; the shipped
   `americano-night` template is tennis and cannot record a result), boardgame
   on every bracket kind, generic-score on page playoff (`offered-matrix.md`).
2. **Production uses one sport.** 2026-09-27, `seazn-prod`, non-archived:
   badminton knockout 10 divisions / 31 played fixtures, Swiss 9 / 73, league
   1 / 3. Nothing else. The owner nonetheless ruled the **whole matrix** the
   frame (ruling 3), with no events booked.

## 2. Goal and definition of done

**Every cell of the format × sport matrix, under every applicable scenario and
config variant, either works end to end or refuses with plain guidance by an
owner ruling.** Nothing stalls silently, nothing reports success on a failure,
no table lies.

- **A wave is done** when its rows in `MATRIX.md` are all ✅ (works) or ⛔
  (refused by ruling) — **zero ❌, zero ⬜** — and its gates (§10) pass.
- **The programme is done** when the whole matrix meets that bar and every
  issue routed into W8–W10 is closed.

## 3. The matrix

**Format rows (21).** Nine stage kinds (`packages/engine/src/core/types.ts:91`):
league, group, swiss, knockout, double_elim, stepladder, americano, ladder,
page_playoff. The builder offers 16 templates (`format-templates.ts:65`):
league, triple_rr, league_ko, groups_ko, group_stepladder, group_playoffs,
swiss, swiss_playoff, swiss_knockout, knockout, ko_plate, qualifying_main,
double_elim, americano, mexicano, ladder. Rows are templates plus API-only
shapes (page_playoff alone, knockout + `thirdPlace`, …) — the authoritative
row list is `offered-matrix.md`; W1 freezes it into the harness.

**Sports (11).** football, cricket, boardgame (variants are time controls, not
chess/draughts/go), carrom, generic, volleyball, badminton, tabletennis,
tennis, icehockey, hockey (`packages/engine/src/sports/index.ts:23`). There is
no futsal preset.

**A cell** = (format row, sport, that sport's default config).

## 4. The scenario axis

Each scenario is a script of organiser actions (§6.1) plus an
**applicability predicate** over (format, sport). Inapplicable pairs are
dropped mechanically. Catalogue (69):

**R — roster**
- R1 late entry before Start · R2 late entry after Start
- R3 withdrawal before Start · R4 withdrawal mid-event after some results (expunge vs keep, incl. already-finalized fixtures) · R5 withdrawal after the entrant has played all their matches · R6 withdrawal of an entrant already drawn into a later bracket/playoff slot
- R7 disqualification · R8 entrant deleted · R9 pair/team rename or lineup change mid-event
- R10 waitlist promotion after the draw · R11 duplicate entrant (same person twice, or in two partnerships in one division) · R12 doubles partner withdraws → substitute or pair dissolved · R13 entrant moved to another division after the draw
- R14 retires from one match, continues in the next · R15 entrant leaves after their last match and is still paired next round · R16 substitute / different lineup in a team match (stats attribution)

**M — single match**
- M1 walkover in only one match · M2 double walkover · M3 retirement mid-match (partial score) · M4 abandoned / no-result
- M5 draw in a stage that cannot end level · M6 tie after regulation → decider (shoot-out, super over, extra time, chess tiebreak)
- M7 void a decided result, before and after the next match started · M8 correct a finalized score (winner stays / winner flips) · M9 forfeit/award by the organiser
- M10 disqualification mid-match · M11 a rules change attempted mid-match — **must refuse** (ruling 12)

**F — field shape**
- F1 odd field (byes) · F2 field below the format's minimum · F3 non-power-of-two bracket · F4 unequal pools
- F5 two-way and 3+-way ties · F6 everyone level · F7 tie falling through to lots · F8 protected seeds

**D — draw and structure**
- D1 two divisions merged · D2 one division split · D3 seeding changed after the draw is published · D4 same-club / same-country separation
- D5 re-draw after fixtures are published or timed · D6 format changed after entries close · D7 stage rules changed after Start

**P — progression**
- P1 complete a stage with a fixture pending · P2 group → knockout with a qualifying tie unresolved · P3 Generate after a roster change · P4 Rebuild after results exist
- P5 undo Generate / Pair next round · P6 per-stage rule override (a best-of-3 final) · P7 rank override

**Q — qualification and placing**
- Q1 qualifier decided by lots/organiser, then a correction changes it after the knockout draw · Q2 group winner withdraws after qualifying → promote next or bye
- Q3 third-place match skipped → shared 3rd · Q4 final not played → joint winners or decided by table · Q5 plate entrant withdraws / a main-draw loser declines the plate

**X — disruption**
- X1 weather stops play mid-round; resumed next day or cancelled · X2 event cut short: remaining rounds cancelled, standings and winner from an incomplete table
- X3 a round shortened on the fly (fixture-level format override before start) · X4 a match resumed from its saved score vs replayed from scratch; replayed after a protest

**C — corrections**
- C1 scores swapped home/away · C2 result entered on the wrong match · C3 protest upheld: overturn or replay a day later
- C4 ineligible player → retroactive forfeits across the table · C5 points deduction (conduct) applied to the table
- C6 late correction after the stage or event is complete (reopen, recompute ranks) · C7 result annulled weeks later

**E — entry path** (how results reach the ledger)
- E1 phone pad · E2 quick result · E3 Bo1 points editor · E4 device link / printed scorer-sheet scan

**Surfaces asserted after every scenario:** desk, public table, embed,
slideshow, export, printed sheet.

**Operational [O] items are NOT on this axis** (ruling 5) — they are W9:
unpaid-entry removal and refunds, age eligibility disputes, court count drops,
postponed day, cross-division player clash, broken rest time, a late (not
absent) player moved to the end of the queue, two matches on one court / a
wrong pairing played, device dies mid-match, two scorers at once, offline sync
out of order, a stale sheet scanned after a move or rebuild, published-result
edits propagating to embeds/exports/OG images, certificates from final ranks.

## 5. Config variants and customisation levels

**Third axis: config variants.** Every setting a sport module declares gets
each of its values run at least once per format, pair-covered like L2.

**Customisation levels (ruling 12):**

| Level | What may be set | When |
|---|---|---|
| Division | everything (today's behaviour) | any time; frozen per fixture at its first event |
| **Stage** | **every setting**: match format for every sport (today only the set sports, #804), **deciders with a screen** (today engine-read at `stage-cfg.ts:18` but nothing writes them — SC-X2), table points, tiebreak order | before the stage's first fixture starts |
| **Fixture** | **match format only** — game points, sets, best-of, overs, halves | **only while the fixture has not started** |
| Fixture | table points, tiebreakers | **never** — every result in a table counts the same |
| Mid-match | nothing | **refused** (scenario M11) |

The fixture override lands in the same resolver
(`fixture-cfg.ts` → `stageScopedCfg`) and is frozen by the existing V347
snapshot at the first event, so the "editing config never re-scores a finished
fixture" guarantee is untouched. That guarantee becomes an **invariant** (§7.3).

## 6. The harness

### 6.1 One scenario catalogue, two drivers

Scenarios are written once against an `OrganiserDriver` interface
(`withdraw(entrant: seed(3), after: round(2), mode: "expunge")`,
`walkover(fixture: round(1).match(2), absent: "away")`, …). Two adapters:

- **HttpDriver** (L3) — the real prod server over HTTP, reusing the bench's
  client, seeding, simulation and advancement code (§9).
- **BrowserDriver** (L1/L2) — taps the same action in the real UI (page
  objects).

The same script runs through both, so the layers cannot drift.

### 6.2 The three layers (ruling 7)

| Layer | What | Scale |
|---|---|---|
| **L1** | every cell × full lifecycle **in the browser**: generate → score with that sport's real pad → standings → progression → final ranks → public table | 231 runs |
| **L2** | scenarios in the browser: every (format, scenario) pair and every (sport, scenario) pair at least once | ~600–900 runs |
| **L3** | the full cartesian cell × scenario × variant **through the real server, no browser** | ~7k+ cases |

**Mixed-driver lifecycle (design decision, flagged for owner review).** An
L1/L2 run drives **every distinct action type** through the browser at least
once — generate, one match on the sport's real pad, one quick result, the
scenario's own steps, the standings/progression/final-ranks pages — and scores
the remaining filler fixtures through `HttpDriver`. Tapping all 28 matches of
an 8-player league in the browser proves nothing the first one did not and
makes L1 unrunnable.

**Deterministic pair covering.** L2's run list and the variant axis are a
committed, reviewed file generated once — never random — so every run
executes the same set.

**`MATRIX.md` is generated** from the harness's JSON results and never
hand-edited (one authority per fact). Cells: ✅ works · ❌ red · ⛔ refused by
ruling · ⬜ needs ruling / not yet run.

### 6.3 Expected outcome per (cell, scenario)

One of: **works** · **refused-with-guidance** (an owner ruling, per ruling 6)
· **unruled** → ⬜ *needs ruling*, never ❌. A missing decision must not look
like a bug, and a bug must not hide as a missing decision: a case moves to ⬜
only when its rulebook (§7.1) is silent.

### 6.4 Isolation and speed

- One organisation per case.
- L3 skips scheduling (fast path); L1/L2 schedule for real where the lifecycle
  needs times (sheets, board).
- Every full run starts on a fresh DB — a long-lived test DB (~28k orgs) times
  out unrelated suites.
- The harness never repeats `POST /stages/{id}/complete`: today a repeat mints
  a new draft seed proposal each call (bench finding, `stages.ts:4140`; fixed
  in W5). Driver calls are idempotent by construction.

### 6.5 CI and cost (decision owed in W1's spec)

Honest arithmetic, estimates to be measured in W1:

- **L3 full:** ~7k cases × ~10 s ≈ 19 CPU-hours → ~1 h wall over 20 shards.
- **L1 + L2:** ~830–1,130 browser runs × 3–4 min ≈ 45–75 runner-hours → ~1.5 h
  wall over 40 shards. At GitHub's Linux 2-core rate that is roughly
  **$20–35 per full run** (Actions metering is on).
- **Per PR:** L3 for the rows the wave touches plus a fixed sample (~10 min).
  The existing e2e trigger (push to `main` + `workflow_dispatch`) is unchanged.
- **Full L1+L2+L3:** manual dispatch + a schedule the owner picks in W1
  (weekly ≈ $100/month, nightly ≈ $700/month at the estimate above).

L1 runs at 1280 and 320 per cell (recommendation); L2 rotates the seven
widths across its runs so the whole width matrix is covered.

## 7. Expected values (ruling 10: full reference model)

### 7.1 Rulebooks (ruling 11)

Each format wave's first deliverable, **signed off by the owner**: the format
family's rules per sport — federation default, settings organisers may change
and at which level (§5), deviations recorded as owner rulings, and the wave's
case-by-case rulings on unfit cells and unsupported scenarios (ruling 6), each
stated as a recommendation with its owner value.

Authorities: FIDE (Swiss pairing, Buchholz and byes), BWF, ITTF, FIVB, ITF,
ICC (NRR, DLS), FIFA/UEFA (head-to-head first in groups), FIH, IIHF. Product
rules where no federation governs: americano, mexicano, ladder, generic,
carrom. Where the product deliberately differs (a simpler Swiss than full
FIDE Dutch), the difference is an owner ruling in the rulebook.

### 7.2 The reference model

- New package **`packages/reference/`**: pure TypeScript, no DB.
- A **lint/dependency boundary** forbids importing `packages/engine` or
  `apps/web`; it shares only wire and pack types.
- Written **from the rulebook, never from engine code**, by a different agent
  than the one fixing the engine in that wave.
- **Exact oracle** where the rules admit one answer: standings, tiebreaks,
  progression, final ranks, NRR, walkover credit.
- **Legality checker plus declared preference order** where the rules admit
  several: Swiss pairing among equal scores, draw placement, bye placement.
- Built **wave by wave**: W1 ships the package skeleton and the boundary; each
  format wave adds its family before fixing anything.

### 7.3 Invariants and metamorphic checks (every case, from W1)

- every round-robin pair meets exactly once per leg
- every completed bracket has exactly one champion; final ranks are a
  permutation of the entrants
- table points = Σ results × the sport's *declared* points (rule 19: derive
  from declarations, never from output)
- a walkover credits what the sport declares
- Swiss: no rematch; Buchholz = Σ opponents' scores under the rulebook's bye rule
- **nothing ends stuck**: every stage completes or refuses with a named reason;
  an empty generate/pair is a failure, not "up to date" (SW-H1)
- editing config never changes a finished fixture's result (V347 freeze)
- metamorphic: shuffled entry order and renamed entrants give the same table

### 7.4 Disagreement triage

Reference ≠ product → **the rulebook decides**. Either side can be wrong. If
the rulebook is silent, the case is ⬜ *needs ruling* and goes to the owner as
a recommendation.

## 8. Waves

Waves are grouped by format family — the organiser's journey — and each closes
its rows across all 11 sports. Audit gaps are routed below; a gap not listed
goes to the wave owning its format/sport, and **every audit ID must be closed
or ruled by programme end**.

| Wave | Scope | Carries |
|---|---|---|
| **W1 — harness + truth run** | Drivers, L1/L2/L3 frameworks, scenario and variant catalogues, pair-covering file, `MATRIX.md` generator, `packages/reference/` skeleton and boundary, invariants and metamorphic checks, split of the bench's `run-suite.ts` into callable phases, round-by-round generation for swiss/mexicano/ladder in the runner. **One truth run over every cell. No product code changes.** | CI cadence and budget ruling (§6.5); the observed ❌ list becomes every later wave's backlog |
| **W2 — sport scoring fidelity** | The input layer every format consumes | SC-X1–X4 (knockout tie/no-result stall; per-stage deciders with a screen; level knockout without a decider), SC-S* (walkover/retirement set and point credit; tennis impossible sets; tennis Bo1 match tie-break), SC-C* (DLS NRR), SC-P* (hockey shoot-out points), SC-O* (chess knockout draw), ST-G1 (abandoned → table), ST-G2 (chess Pts doubled), ST-G16 (ice hockey OT columns); fixture-level format override (§5) |
| **W3 — Swiss** (9 live) | swiss, swiss_playoff, swiss_knockout | SW-* (H1 failed pairing reported as success; H2 round guidance; H3 chess colours; H4 per-sport Swiss tiebreaks; M1 Buchholz bye; M2 undo Pair next; bye points, snapshot and court booking; double walkover); #846 |
| **W4 — knockout family** (10 live) | knockout, ko_plate, qualifying_main, third place, stepladder, page_playoff | FX-G2 (bracket growth on Generate), FX-G7 (page playoff withdrawal), FX-G14 (plate seeding), third-place UI, ST-G7 (finished knockout as all-zero tables on embed/slideshow/OG), boardgame/generic bracket cells |
| **W5 — round-robin family** | league, triple_rr, group, league_ko, groups_ko, group_stepladder, group_playoffs | #879 (all three parts), #850, FX-G1, FX-G5 (3-group crossover), FX-G13 (non-atomic Rebuild), ST-G3/G4 (best runner-up across pools), ST-G5 (group tables miss unplayed members), ST-G10/G13/G14/G15/G20/G23/G24, the repeated `completeStage` seed-proposal finding (bench) |
| **W6 — double elimination** | double_elim | FX-G3 (reset game never cancelled; champion ranked last), FX-G4 (no crossing → immediate rematches) |
| **W7 — americano, mexicano, ladder** | the 20 unfit americano/mexicano cells, ladder | case-by-case rulings; FX-G6 (ladder late joiners), FX-G8–G11; the broken `americano-night` tennis template |
| **W8 — scorer sheets** | printable sheets | SH-* (H1 unreachable print options = #870; plan re-check when scoring; revoke a day; untimed matches; non-Latin fonts; per-format and per-sport card tests) |
| **W9 — operational [O]** | schedule, devices, registration | the [O] list (§4), #880, bench findings: cross-competition court double-booking (`schedule.ts:939`), `solver_unavailable`, `start_window` never blocks, inert `crossPersonClash`, no engine request, `lang` until hydration |
| **W10 — sweep** | unrelated issues | #878 browser Sentry, #858 admin URL, #853 player card, #843 roster i18n |

**Order.** W1 → W2 → W3 → W4 → W5 → W6 → W7 strictly in sequence — they share
the engine and `stages.ts`. W8, W9, W10 run in **parallel lanes** in their own
worktrees whenever capacity allows; each lane must prove its file set disjoint
from the wave in flight before it starts.

## 9. Bench integration (ruling 8)

- The bench is reused as a **library**, not as the harness: HTTP client,
  seeding, simulation, advancement, oracle and offline validator code.
- **B17 (disruption suite) is folded into this programme** — the scenario axis
  supersedes it. The bench's "no synthetic volume suite" non-goal is amended
  for this programme only.
- **PackSchema stays frozen.** Synthetic per-cell packs are generated; scenarios
  live in a separate step file.
- W1 splits `run-suite.ts` into phases; **no bench runner work runs in parallel
  with W1**.
- Bench real-history suites become **closing gates** of the matching wave:

| After | Bench suite(s) |
|---|---|
| W3 | Candidates / Grand Swiss (chess Swiss) |
| W4 | All England (badminton knockout), Wimbledon (tennis) |
| W5 | Euro 2024 / Women's Euro 2025, T20 World Cup, Paris volleyball and hockey, IIHF 2025, WTTC |
| W6/W7 | carrom (B07b), remaining suites |
| any time | pack authoring (offline research; pack files only) |

## 10. Per-wave lifecycle and gates

1. **Rulebook** (§7.1) → owner sign-off.
2. **Reference model** for the family (§7.2), separate agent.
3. **Truth run** on the wave's rows; each red re-verified before it enters the
   backlog.
4. **Plan** (`writing-plans`) → implement through the implementer → reviewer
   loop. TDD: every fix ships a test that fails without it. Every guard is
   mutated one at a time.
5. **Gates:** L3 rows green · L1 cells green · L2 pair file green · whole spec
   files, never `-g` slices; serial files re-run until a full pass · flaky-shaped
   gates re-run three times · per-screen visual verdicts at 1280/768/320 for
   changed UI · all 4 locale dictionaries + `gen-keys` · OpenAPI drift.
6. **Bench gate** where one lines up (§9).
7. **Drive the product** before claiming; PR (smoke CI); e2e on the push to
   `main`, or `workflow_dispatch --ref <branch>` before merge.

## 11. Decisions still owed

| # | Decision | Where it is decided | Recommendation |
|---|---|---|---|
| O1 | CI cadence and monthly budget for full runs | W1 spec | weekly scheduled + manual dispatch |
| O2 | Mixed-driver lifecycle for L1/L2 (§6.2) | review of this spec | accept |
| O3 | L1 widths per cell | W1 spec | 1280 + 320; L2 rotates all seven |
| O4 | Fixture-override UI (§5) | W2 spec, ≥2 options shown first | — |
| O5 | Stage-level deciders/points/tiebreak UI | W2 spec, ≥2 options shown first | — |
| O6 | Per-cell rulings (unfit cells, unsupported scenarios) | each wave's rulebook | stated per case |

## 12. Risks

- **Scale.** 231 cells × 69 scenarios × variants is large; the applicability
  predicates and pair covering are what keep it runnable. W1 measures the real
  counts before promising a cadence.
- **The reference model is a second engine.** Wave-by-wave construction and
  the import boundary keep it independent; the risk is it lags the fixes.
  Mitigation: a wave cannot fix before its family's model exists (§10 step 2).
- **Shared files.** `stages.ts` (~5.7k lines) and `run-suite.ts` (~5.9k lines)
  are touched by most waves; strict sequencing is the only protection.
- **Audit IDs are hypotheses.** Some will not reproduce; record them as false
  premises, not as work done.
- **Actions cost.** §6.5; the owner sets the budget in W1.
