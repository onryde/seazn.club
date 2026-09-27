# Format × sport matrix — design of record

- **Date:** 2026-09-27 (amended the same day after an independent spec review)
- **Status:** APPROVED by the owner (rulings 14–21 in `_INDEX.md`)
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
product. Every behavioural gap is a hypothesis until a truth run reproduces it
(`_RULES.md` R5, which also carves out non-behavioural gaps).

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

**Case states** (the legend of `MATRIX.md`):

| State | Meaning |
|---|---|
| ✅ | works as the rulebook says |
| ⛔ | a refusal **mandated by a ruling and observed** (e.g. M11 mid-match rule change) |
| ❌ | red, caused by a gap routed to the current or an earlier wave |
| ⏳ Wn | red, caused by a gap routed to a later wave `Wn` |
| ⬜ | needs ruling — the rulebook is silent |
| 🚫 | no product path — the action has no route or screen yet; needs a ruling to build it or refuse it |
| ░ | not yet run |

- **A wave is done** (ruling 19) when (a) zero ❌ are attributable to its own
  routed gaps, every other red on its rows is tagged ⏳ with its owning wave;
  (b) **no case anywhere that was ✅ or ⛔ before the wave is now red**; (c) its
  gates (§10) pass.
- **The programme is done** when the whole matrix is ✅ or ⛔ — no ❌, ⏳, ⬜, 🚫
  or ░ — and every issue routed into W8–W10 is closed.

## 3. The matrix

**Format rows (21).** Nine stage kinds (`packages/engine/src/core/types.ts:91`):
league, group, swiss, knockout, double_elim, stepladder, americano, ladder,
page_playoff. The builder offers 16 templates (`format-templates.ts:65`):
league, triple_rr, league_ko, groups_ko, group_stepladder, group_playoffs,
swiss, swiss_playoff, swiss_knockout, knockout, ko_plate, qualifying_main,
double_elim, americano, mexicano, ladder. Rows are templates plus API-only
shapes (page_playoff alone, knockout + `thirdPlace`, …) — the authoritative
row list is `offered-matrix.md`; W1a freezes it into the harness.

The server has **no create-from-template-key endpoint**. The harness builds
stages with the builder's own `buildTemplateStages`
(`format-templates.ts:333`) and posts them to `/divisions/:id/stages`, so the
real producer is exercised. **API-only rows** (5 rows, 48 cells, plus 2
template-only cells) are created through `HttpDriver` in L1 and everything
after creation is driven in the browser; the missing organiser UI is itself a
❌ routed to a named wave (W4 owns the third-place control).

**Sports (11).** football, cricket, boardgame (variants are time controls, not
chess/draughts/go), carrom, generic, volleyball, badminton, tabletennis,
tennis, icehockey, hockey (`packages/engine/src/sports/index.ts:23`). There is
no futsal preset.

**A cell** = (format row, sport, that sport's default config).

**Entitlements.** `page_playoff` and `double_elim` need `formats.double_elim`;
americano, mexicano and ladder need `formats.advanced`. Harness organisations
run on the top plan; each gated format also gets **one denied-state case** on a
plan without the key (the owner's 2026-09-14 checklist requires both states).

## 4. The scenario axis

Each scenario is a script of organiser actions (§6.1) plus an **applicability
predicate over (format, sport, variant)** — E3 needs best-of-1, M5/M6 need a
decider switched on, generic `win_loss` behaves differently in americano.

**Applicability is committed, not implicit.** The generated list of dropped
(cell, scenario) pairs is a committed file with **a reason per drop**, reviewed
like the pair file (R11). Each row has an **applicable-case floor**, and each
predicate is mutated once (`return false`) to prove a red — an over-broad
predicate must not reach "zero ❌" by testing nothing (R13).

**Compound scenarios split into atomic cases** in W1b ("A vs B" items such as
R4, M7, M8, X1, X4, C3, F5, Q1, Q4 become `R4a`/`R4b`…), and W1b decides
whether **E (entry path)** multiplies the M and C scenarios or stays a
scenario of its own.

**Outcomes the product chooses are expected values, not inputs.** Withdrawal
expunge-vs-keep is decided by the engine (a 50% threshold; Swiss never
expunges) — the scenario asserts which one the rulebook requires, it does not
pick it.

Catalogue (69 scenario IDs, more atomic cases):

**R — roster**
- R1 late entry before Start · R2 late entry after Start
- R3 withdrawal before Start · R4 withdrawal mid-event after some results (expunge vs keep, incl. already-finalized fixtures) · R5 withdrawal after the entrant has played all their matches · R6 withdrawal of an entrant already drawn into a later bracket/playoff slot
- R7 disqualification (today: status only, no fixture cascade) · R8 entrant deleted · R9 pair/team rename or lineup change mid-event
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
- E1 phone pad · E2 single-event result over the API (there is no separate quick-result endpoint) · E3 Bo1 points editor · E4 device link / printed scorer-sheet scan

**Known 🚫 at design time** (no route or screen today): D1, D2, D4, R13, Q4,
C5 (`carry_deltas` exists only through stage PUT, `FORMAT_LOCKED` once fixtures
exist). X3 is built in W2. Each 🚫 gets a build-or-refuse ruling in its owning
wave per §8 — division-level D1, D2, R13 in W9; D4 in W4; Q4 in W4; C5 in W5.

**Cases that need times** (E4, the printed-sheet surface, X1, D5) are excluded
from L3 by predicate — L3 skips scheduling — and covered in L1/L2.

**Surfaces asserted after every scenario:** desk, public table, embed (HTML —
there is no JSON embed; the public standings route is read), slideshow,
export, printed sheet.

**Operational [O] items are NOT on this axis** (ruling 5) — they are W9:
unpaid-entry removal and refunds, age eligibility disputes, court count drops,
postponed day, cross-division player clash, broken rest time, a late (not
absent) player moved to the end of the queue, two matches on one court / a
wrong pairing played, device dies mid-match, two scorers at once, offline sync
out of order, a stale sheet scanned after a move or rebuild, published-result
edits propagating to embeds/exports/OG images, certificates from final ranks.

## 5. Config variants and customisation levels

**Third axis: config variants.** Every setting a sport module declares is
covered **pair-wise across (format, sport)** — not cartesian. Numeric settings
(overs, points-to-win, legs, rounds) are replaced by **boundary classes**
(minimum, default, maximum, one interior value), so the axis is finite.

**Customisation levels (ruling 12):**

| Level | What may be set | When |
|---|---|---|
| Division | everything (today's behaviour) | any time — but **table points and tiebreakers lock per stage once that stage's first fixture starts** (recommendation; confirmed in W2's rulebook, O8) |
| **Stage** | **every setting**: match format for **every** sport (today only the set sports, #804 — owner D2a scope is superseded by ruling 12), **deciders** (`shootout`, `extraTime`, and the missing `superOver`/overtime/tie-board keys) **with a screen**, table points, tiebreak order | before the stage's first fixture starts |
| **Fixture** | **match format only** — game points, sets, best-of, overs, halves | **only while the fixture has not started** |
| Fixture | table points, tiebreakers | **never** — every result in a table counts the same |
| Mid-match | nothing | **refused** (scenario M11) |

Today the stage deciders are engine-read (`stage-cfg.ts:18`) and API v1
`CreateStage` writes `shootout`/`extraTime`, but **no organiser screen writes
them** (SC-X2).

The fixture override is **not** a one-line change: `resolveFixtureCfg` takes no
fixture input today and has ~11 production callers (`append-event.ts:270`,
`fold.ts:155`, `competition.ts:325/347`, `event-import.ts:281`,
`fixtures.ts:115`, `match-centre-load.ts:304`, `org-posts.ts:761`,
`player-stats.ts:439`, …). W2 must route the override through **every** caller
or it ships as an inert seam (`AGENTS.md` class 1). It is then frozen by the
existing V347 snapshot at the first event, so the "editing config never
re-scores a finished fixture" guarantee is untouched — and becomes an
invariant (§7.3).

## 6. The harness

### 6.1 One scenario catalogue, two drivers

Scenarios are written once against an `OrganiserDriver` interface
(`withdraw(entrant: seed(3), after: round(2))`,
`walkover(fixture: round(1).match(2), absent: "away")`, …). Two adapters:

- **HttpDriver** (L3) — the real prod server over HTTP. It is a **lean runner of
  its own** (ruling 17) that reuses the bench's small helpers only — HTTP client,
  magic-link auth, plan provisioning — and **does not touch `run-suite.ts`**.
- **BrowserDriver** (L1/L2) — organiser page objects plus **one pad adapter per
  sport** (11; the bench ships only a generic tap adapter).

The same script runs through both, so the layers cannot drift.

**Scoring events are generated, not replayed.** The bench replays recorded
pack streams and has no run-time simulation. W1a writes a **stream generator
per sport** producing the minimal legal sequence for a chosen outcome (win,
draw where allowed, walkover/retirement via `core.forfeit {by, reason}`,
abandon), plus richer sequences where a scenario needs them. Filler fixtures use
the minimal sequence to keep per-case cost down.

**Organisations** are auto-provisioned at sign-up and there is no create route,
so the harness seeds organisations and plans directly in the harness DB,
following the bench's `setPlan` SQL precedent, and signs in once per worker.
The harness never touches production data.

**Known API traps the driver handles:** scoring before Start is `422
WRONG_PHASE`; Start needs `{acknowledge_warnings: true}`; a later stage needs its
own `POST /stages/{id}/generate`; `/complete` on an unfinished stage is `200
{completed:false}`, not an error; final ranks are read from stage standings
after `/complete`; americano/mexicano next round and Swiss "pair next" are the
same `POST /stages/:id/generate`.

### 6.2 The three layers (ruling 7, mixed-driver per ruling 15)

| Layer | What | Size (derived in W1b from the committed files) |
|---|---|---|
| **L1** | every cell × full lifecycle **in the browser**, at 1280 and 320 | 231 × 2 = **462** runs |
| **L2** | scenarios in the browser: every applicable (format, scenario) and (sport, scenario) pair at least once, widths rotating across the seven | ≥ number of applicable (format, scenario) pairs — up to 21 × 69 = 1,449 before drops |
| **L3** | **every applicable (cell × scenario) at default config** (full cartesian, ruling 7) **+ config variants pair-covered across (format, sport)**, through the real server, no browser | ≤ 231 × 69 = 15,939 before drops, plus the variant set |

**Mixed-driver lifecycle (ruling 15).** An L1/L2 run drives **every distinct
action type** through the browser at least once — generate, one match on the
sport's real pad, the scenario's own steps, the standings/progression/final-ranks
pages — and scores the remaining filler fixtures through `HttpDriver`.

**Deterministic files.** The L2 run list, the variant set and the applicability
drop list are committed, reviewed files — never random draws (R11).

**`MATRIX.md` is generated** from the harness's JSON results and never
hand-edited (R10).

### 6.3 Expected outcome per case

One of: **works** · **refused-with-guidance** (a ruling, per ruling 6) ·
**needs ruling** (⬜, rulebook silent) · **no product path** (🚫). A missing
decision must not look like a bug, and a bug must not hide as a missing
decision: ⬜ only when the rulebook is silent, 🚫 only when no route or screen
exists.

### 6.4 Isolation and speed

- One organisation per case, seeded in the harness DB.
- L3 skips scheduling (fast path); L1/L2 schedule for real where the lifecycle
  needs times (sheets, board, X1, D5).
- Every full run starts on a fresh DB with `sync:sports` — a long-lived test DB
  (~28k orgs) times out unrelated suites.
- The harness never repeats `POST /stages/{id}/complete`: today a repeat mints a
  new draft seed proposal each call (bench finding, `stages.ts:4140`; fixed in
  W5). Driver calls are idempotent by construction.
- **The repo is public**, so every CI log and uploaded artifact is public. The
  harness uses synthetic organisations and people only and never prints a secret
  or a token.

### 6.5 CI cadence and cost (ruling 20)

- **While the repo is public: $0.** Standard GitHub-hosted runners are free for
  public repositories. The limit is wall clock (concurrent jobs), not money.
- **Weekly scheduled full run of L1 + L2 + L3, plus manual dispatch** (ruling 20).
  Scheduled overnight at the weekend.
- **Per PR:** L3 for the rows the wave touches plus a fixed sample.
- **Visibility guard.** The owner plans to make the repo private later. The
  weekly job reads the repo visibility first and fails loudly if it is private
  and still on GitHub-hosted runners, so the meter can never run silently.
- **Plan for going private (recommendation, not yet a ruling): move the weekly
  matrix to a self-hosted runner** (a VPS or the owner's machine; only `runs-on`
  changes). GitHub postponed its announced self-hosted platform charge
  (changelog 2025-12-16, update), so self-hosted private usage is free today.
  PR CI stays on GitHub-hosted runners. For comparison, GitHub-hosted private
  cost would be ≈ $370/month weekly or ≈ $200/month with L1+L2 every 4 weeks.
  **Rejected:** a separate public "shim" repo pulling a private image — GitHub's
  Actions terms exclude hosted-runner "activity unrelated to the ... testing ...
  of the software project associated with the repository", and every log,
  artifact and red would be public.
- Following the bench's own precedent (`bench.yml`, R84), the schedule is
  enabled only after three consecutive **harness-green** manual dispatches —
  every shard completes, every case reports a state (no ░, no harness error),
  and case states are identical across the three runs. Product reds are
  expected; flakiness is not. (Definition is a recommendation; W1d puts it to
  the owner.)

## 7. Expected values (ruling 10: full reference model)

### 7.1 Rulebooks (ruling 11)

Each wave's first deliverable, **signed off by the owner**: the rules for its
format family (or, for W2, its sport families) per sport — federation default,
settings organisers may change and at which level (§5), deviations recorded as
owner rulings, and the wave's case-by-case rulings on unfit cells, unsupported
scenarios and 🚫 actions (ruling 6), each stated as a recommendation with its
owner value.

Authorities: FIDE (Swiss pairing, Buchholz and byes), BWF, ITTF, FIVB, ITF,
ICC (NRR, DLS), FIFA/UEFA (head-to-head first in groups), FIH, IIHF. Product
rules where no federation governs: americano, mexicano, ladder, generic,
carrom. Where the product deliberately differs (a simpler Swiss than full
FIDE Dutch), the difference is an owner ruling in the rulebook.

**Source of truth order:** the rulebook, then the sport's declared config. Where
a declared default contradicts the federation rule the rulebook adopts (e.g.
hockey walkovers scored 3–0 where FIH awards 5–0), **the rulebook wins** and the case is ❌.

### 7.2 The reference model

- New package **`packages/reference/`**: pure TypeScript, no DB, modelled on
  `packages/engine`'s package layout.
- **Import boundary**, enforced by a gate in the style of
  `scripts/engine-boundary.ts` (run by `ci.yml`): no import of `apps/web`, and of
  `@seazn/engine` **at most `import type`** from its core types — or a leaf
  types package, if W1b finds type-only imports insufficient. W1b decides and
  records which; the pack types (`pack-schema.ts:144-145`) import engine runtime
  values and are not shared.
- A new package also needs its manifest `COPY`'d in the `Dockerfile` before
  `pnpm install --frozen-lockfile`, or the container job breaks.
- Written **from the rulebook, never from engine code**, by a different agent
  than the one fixing the engine in that wave.
- **Exact oracle** where the rules admit one answer: standings, tiebreaks,
  progression, final ranks, NRR, walkover credit.
- **Swiss (and draw placement):** **hard legality plus existence** — no rematch,
  one bye per player, colour limits where the rulebook sets them, and "a legal
  pairing exists" by exhaustive or blossom matching for n ≤ a bound W3 sets. A
  preference order is asserted only where the rulebook fixes it; the reference is
  not a second pairing engine.
- Built **wave by wave**: W1b ships the package skeleton and the boundary; each
  wave adds its families before fixing anything.

### 7.3 Invariants and metamorphic checks (every case, from W1a)

Each invariant carries its **preconditions**, so the scenarios that legitimately
break the plain form (shared 3rd, joint winners, expunge, void, cut short, late
entry) do not read as reds:

- every round-robin pair meets exactly once per leg — *unless* the case withdraws,
  expunges, voids, cuts short or adds a late entry; then the rulebook's rule applies
- every completed bracket has exactly one champion and final ranks are a
  permutation of the entrants — *unless* Q3/Q4 or a rulebook-declared shared place
- table points = Σ results × the rulebook's points
- a walkover credits what the rulebook declares
- Swiss: no rematch; Buchholz = Σ opponents' scores under the rulebook's bye rule
- **nothing ends stuck**: every stage completes or refuses with a named reason;
  an empty generate/pair is a failure, not "up to date" (SW-H1)
- editing config never changes a finished fixture's result (V347 freeze)
- metamorphic: renamed entrants give the same table; shuffled entry order gives
  the same table **only with explicit seeds and no `lots`** (unseeded order is
  `created_at`, FX-G17; residual ties fall to seed then UUID, ST-G13)

**W1's truth run is a floor.** It has invariants only — the reference families
arrive wave by wave, and the Swiss bye rule comes from W3's rulebook — so its ❌
list is where each wave's backlog starts, not its full extent.

### 7.3a Anti-vacuity (ruling 21)

Every invariant and property **reports how many things it checked** (pairs,
brackets, rows, opponents). A check that saw zero items is a **failure**, not a
pass — "no rematch" on an empty round, "covers pairings evenly" over zero
pairs and "undo cleared the round" over zero seats are this week's examples.
The count is written into the case's JSON evidence.

### 7.4 Disagreement triage

Reference ≠ product → **the rulebook decides**. Either side can be wrong. If the
rulebook is silent, the case is ⬜ and goes to the owner as a recommendation.

### 7.5 Finding the holes nobody listed (ruling 21)

The 69 scenarios are the cases someone thought of. Three mechanisms look for the
rest:

1. **Model-based sequence testing (W1b).** A `fast-check` command model
   generates random sequences of organiser actions — add entrant, withdraw,
   walkover, void, correct, Generate, Pair next, Rebuild, complete stage —
   against each cell, checking every §7.3 invariant after **every** step. A
   failure shrinks to the shortest reproducing sequence, which is committed as a
   new named regression case. This is the mechanism that catches transition bugs
   like #879 (add → Generate → duplicate pair). It runs in L3 over HttpDriver;
   seeds are logged so any red replays exactly.
2. **Automated mutation testing (W1d).** Stryker runs weekly on
   `packages/engine` scheduling, competition and tiebreaker modules, with a
   mutation-score floor set from the first measured run and only allowed to
   rise. Surviving mutants are listed in the run report; each is killed by a
   test or recorded as equivalent.
3. **Production shadow invariants (W10 lane, after #878).** The server evaluates
   the §7.3 invariants on real tables, brackets and pairings after each write,
   **logging** a Sentry event on violation — never refusing the action. Real
   events are the final test; a broken table reaches us before an organiser.
   Invariants run with their preconditions and anti-vacuity counts, off the
   request's critical path.

## 8. Waves

Each gap has **exactly one owning wave**; a later wave that depends on it tags
its reds ⏳ until the owner lands. Gaps not listed go to the wave owning their
format/sport; **every audit ID must be closed or ruled by programme end**.

| Wave | Scope | Carries |
|---|---|---|
| **W1a — L3 core** | Lean HTTP runner reusing the bench's helpers; `HttpDriver`; org/plan seeding; **stream generators for all 11 sports**; per-round generation for swiss/mexicano/ladder; invariants **with anti-vacuity counts (§7.3a)**; JSON results; `MATRIX.md` generator | Proven on a vertical slice: league, knockout, swiss × generic, badminton |
| **W1b — catalogues + reference skeleton** | fast-check command model over the organiser actions (§7.5); `forEachSport` test helper (R26); 69 scenarios split into atomic cases; applicability over (format, sport, variant) with the committed drop list and floors; variant set with boundary classes; L2 pair file; `packages/reference/` skeleton, boundary gate, Dockerfile line | Formulas and real counts for §6.2; E-axis decision; reference import mode |
| **W1c — browser layers** | `BrowserDriver`: organiser page objects + **11 pad adapters**; L1/L2 frameworks; width rotation | API-only rows created over HTTP, then driven in the browser |
| **W1d — CI + truth run** | Shards, fresh DB per shard, weekly + dispatch workflow with the visibility guard, per-PR sample, three green dispatches before the schedule, per-case timing, weekly Stryker mutation run with a score floor (§7.5), **the first full truth run** and triage of its reds into waves | The ❌ list (a floor) becomes each wave's starting backlog |
| **W2 — sport scoring fidelity** (a sport-family wave: one rulebook per sport family, reference families for its exact-oracle items) | The input layer every format consumes | SC-X1 (knockout tie/no-result stall), SC-X2 (stage deciders with a screen), SC-X3 (no event to settle an abandoned knockout by lot), SC-X4 (auto-advance blocked by `abandoned`), SC-P1, SC-P2 (level knockout without a decider), SC-P4 (no points fields when hockey shoot-outs are on — FIH 2/1 is Pro League only), SC-P11 (futsal preset — **not a matrix row**; W2 rules build or refuse, and only a built preset adds a column), SC-S* (walkover/retirement set and point credit, tennis impossible sets, tennis Bo1 match tie-break, double walkover SC-S6), SC-C3 (DLS NRR), **SC-O1/SC-O2 (boardgame/generic draws in brackets — the `supportsDraws` root cause, owned here)**, ST-G1, ST-G2, ST-G16, ST-G10 (tiebreak validation against the sport + stage tiebreak UI); **stage-level match format for every sport** (ruling 12, FX-G23, SC-O8); fixture-level format override through every `resolveFixtureCfg` caller (§5); division-level lock of points/tiebreakers per started stage (O8) |
| **W3 — Swiss** (9 live) | swiss, swiss_playoff, swiss_knockout | SW-* (H1 failed pairing reported as success; H2 round guidance; H3 chess colours; H4 Swiss tiebreak families; M1 Buchholz bye; M2 undo Pair next; bye points, snapshot and court booking; byeScore SC-O7/SW-M8 owned here; Swiss handling of double walkover SW-M9, engine outcome from W2); #846; ST-G21 (slideshow Buchholz column); **#840 + FX-G13 (Rebuild wipes the schedule; Rebuild not atomic) — owned here because W3 is the first wave to need Rebuild, W5 consumes**; #838 recorded as answered by ruling 12 (round count per stage) — confirm in the rulebook |
| **W4 — knockout family** (10 live) | knockout, ko_plate, qualifying_main, third place, stepladder, page_playoff | D4 same-club/country separation (owned here; W5 groups consume), FX-G2 (bracket growth on Generate — **owns the shared position-keyed reconcile fix**, which W5 extends to round-robin), FX-G7, FX-G14, FX-G16 (a confirmed proposal keeps a stale qualifier), third-place UI, ST-G7 + ST-G26 (finished knockout as all-zero tables on embed/slideshow/OG) |
| **W5 — round-robin family** | league, triple_rr, group, league_ko, groups_ko, group_stepladder, group_playoffs | #879 (all parts; part 3's hidden wipe is fixed by W3's #840), #850, FX-G1 (round-robin side of the reconcile), FX-G5, ST-G3/G4/G5/G6/G13/G14/G15/G20/G23/G24, the repeated `completeStage` seed-proposal finding (bench), triple_rr possibly created as a single round robin from the builder (hypothesis, `format-templates.ts:341`) |
| **W6 — double elimination** | double_elim | FX-G3, FX-G4 |
| **W7 — americano, mexicano, ladder** | the 20 unfit americano/mexicano cells, ladder | case-by-case rulings; FX-G6, FX-G8–G11; the broken `americano-night` tennis template |
| **W8 — scorer sheets** (lane) | printable sheets | SH-* (SH-G1 unreachable print options = #870; plan re-check when scoring; revoke a day; untimed matches; non-Latin fonts; per-format and per-sport card tests, SH-G7) |
| **W9 — operational [O]** (lane) | schedule, devices, registration, division admin | the [O] list (§4), the division-level 🚫 scenarios **D1 merge, D2 split, R13 move an entrant between divisions** (build-or-refuse rulings), #880, bench findings: cross-competition court double-booking (`schedule.ts:939`), `solver_unavailable`, `start_window` never blocks, inert `crossPersonClash`, no engine request, `lang` until hydration |
| **W10 — sweep** (lane) | unrelated issues + one privacy defect + shadow invariants | **ST-G22 first** (recap/digest bypasses youth-name masking — a privacy defect), #878 browser Sentry, then **production shadow invariants** (§7.5, reusing the harness's invariant functions), #858 admin URL, #853 player card, #843 roster i18n |

**Order.** W1a → W1b → W1c → W1d → W2 → W3 → W4 → W5 → W6 → W7 in sequence —
they share the engine and `stages.ts` (5,794 lines). W8, W9, W10 run in
**parallel lanes** in their own worktrees; each lane proves its file set
disjoint from the wave in flight before it starts.

## 9. Bench integration (rulings 8 and 17)

- The bench is reused as a **library of small helpers** only — HTTP client,
  magic-link auth, plan provisioning. **`run-suite.ts` is not split and not
  imported** (ruling 17), so bench runner work is no longer blocked by W1.
- **B17 (disruption suite) is folded into this programme.** The bench's "no
  synthetic volume suite" non-goal is amended for this programme only.
- **PackSchema stays frozen** (`pack-schema.ts:8-12`, `schemaVersion` at
  `:1566`). This programme does not read or write packs.
- Bench real-history suites become **closing gates** of the matching wave. A
  gate whose suite has no pack yet is **deferred, not blocking** — recorded ⏳ in
  `_INDEX.md` and run when the suite lands.

| After | Bench suite(s) |
|---|---|
| W3 | Grand Swiss (chess Swiss) |
| W4 | All England (badminton knockout), Wimbledon (tennis), WTTC |
| W5 | Candidates (double round robin), Euro 2024 / Women's Euro 2025, T20 World Cup, Paris volleyball and hockey, IIHF 2025, carrom (4 pools → knockout, B07b) |
| any time | pack authoring and bench runner work (no shared files with this programme) |

## 10. Per-wave lifecycle and gates

1. **Rulebook** (§7.1) → owner sign-off.
2. **Reference model** for the wave's families (§7.2), separate agent.
3. **Truth run** on the wave's rows. A behavioural gap enters the backlog only
   when reproduced; a **non-behavioural gap** (test gap, doc/dead code, print or
   credential gap) is verified by reading the code or by a failing test.
4. **Plan** (`writing-plans`) → implement through the implementer → reviewer
   loop. TDD: every fix ships a test that fails without it; **the four test
   types per task** (unit, E2E, smoke, regression — `docs/superpowers/RULES.md`);
   every guard mutated one at a time.
5. **Gates:**
   - the wave's rows: zero ❌ from its own gaps (§2)
   - **no regression**: nothing that was ✅/⛔ before the wave is red anywhere
   - L1 cells on the wave's rows green; **the wave's slice** of the L2 pair file green
   - whole spec files, never `-g` slices; serial files re-run until a full pass
   - flaky-shaped gates re-run three times
   - per-screen visual verdicts at 1280/768/320 for changed UI
   - all 4 locale dictionaries + `gen-keys`; OpenAPI drift
6. **Bench gate** where one lines up (§9).
7. **Drive the product** before claiming; PR (smoke CI); e2e on the push to
   `main`, or `workflow_dispatch --ref <branch>` before merge.

## 11. Decisions

| # | Decision | Status |
|---|---|---|
| O1 | CI cadence | **RULED 20**: weekly L1+L2+L3 + dispatch while public; going private → self-hosted runner is a recommendation (§6.5), ruled when the switch happens |
| O2 | Mixed-driver lifecycle | **RULED 15** |
| O3 | L1 widths per cell | recommended 1280 + 320, L2 rotates all seven — confirm in W1c |
| O4 | Fixture-override UI (§5) | W2, ≥2 options shown first |
| O5 | Stage-level deciders / match format / points / tiebreak UI | W2, ≥2 options shown first |
| O6 | Per-case rulings (unfit cells, unsupported scenarios, 🚫 actions) | each wave's rulebook |
| O7 | #838 Swiss round count per stage or division-wide | recommended answered by ruling 12 (per stage); confirm in W3's rulebook |
| O8 | Division-level points/tiebreak edits after a stage started | recommended: lock per started stage; confirm in W2's rulebook |
| O9 | Entry path E: its own scenarios or a multiplying axis | W1b |
| O10 | Reference import mode (type-only from engine vs leaf types package) | W1b |

## 12. Risks

- **Scale.** Up to ~16k L3 cases and ~1.9k browser runs. The committed
  applicability, pair and variant files are what keep it runnable; W1b publishes
  the real counts and W1d the real times.
- **The reference model is a second engine.** Wave-by-wave construction, the
  import gate and the Swiss legality-only scope keep it bounded; a wave cannot fix
  before its families' model exists (§10 step 2).
- **Inert fixture override.** ~11 `resolveFixtureCfg` callers (§5); W2 proves the
  override through the real pad and the real standings read, not a fixture.
- **Shared files.** `stages.ts` (5,794 lines) is touched by most waves; strict
  sequencing is the only protection.
- **Audit IDs are hypotheses.** Some will not reproduce; record them as false
  premises, not as work done.
- **Public logs.** Everything a CI run prints is public while the repo is
  public (§6.4).
- **Going private.** Costs return (§6.5); the visibility guard makes the switch
  explicit instead of a surprise bill.
