# B05 — simulation layer: design of record

**Date:** 2026-09-07 · **Branch:** `feat/bench-b05-simulation` ·
**Worktree:** `.claude/worktrees/bench-b05` · **Base:** `main` `fb99bbd4c`

Written for the same reason B04's was: the session prompt
(`bench-prompts/B05-simulation-layer.md`) and bench spec §8/§9 were authored
2026-08-13, and five of their premises are false against today's tree. Every
pin behind this document is in `../B05-repins-2026-09-07.md`; this file records
what the wave DECIDES, not what it found.

Standing rules that are not restated here: `bench-prompts/_RULES.md`
(oracle direction, stage-0-before-HTTP, `expected_seq` discipline, gates vs
measurements, keep-data default), bench spec §6/§7 (verification model,
misalignment protocol), `AGENTS.md` recurring failure classes.

## 1. What this wave closes

The bench today seeds a competition, schedules it, and checks the board. It
never plays a match. `scripts/bench/packs/_tiny.json` already carries four
event `streams` and a populated `expected` block (matches, tables, champions,
leaderboards, specials); `seed.ts:677` (`bindStreamFixtures`) resolves each
stream to a real fixture id **and never reads `.events`**; the suite returns at
`suites/tiny.ts:2305`. The only consumers of `pack.expected` are
`pack-schema.ts:1995-2215` and `validate-pack.ts:1616-1888`, both offline
stage-0 self-consistency checks.

So the pack half and the schema half of this layer already exist and are
INERT — `AGENTS.md` failure class 1, sitting in the bench's own code. B05 is
the wiring that makes them mean something: fold the streams through the real
HTTP scoring path, advance the stages the product's own way, and compare what
the engine derives against what the pack says history did.

## 2. The premises that moved (summary — evidence in the re-pin record)

- **F1.** `finalRanks` crosses the wire exactly once, in the
  `POST /api/v1/stages/{id}/complete` response body, and can never be re-read:
  `GET /divisions/{id}/history` does not select `payload`.
- **F1b.** There is no champion field anywhere in the product.
- **F2.** Advancement lives in `usecases/stages.ts`, not `stage-seeding.ts`;
  all four routes are `/api/v1`-reachable, so B05 §2's bench-as-organizer
  fallback is dead code before it is written.
- **F3.** `import.events` now has `plan_entitlements` rows (V396) on all five
  plans; B00's "no row yet" is stale.
- **F4.** The coach/staff discriminator in player stats is NOT keyed on
  `persons.lane` (zero `lane` hits in `player-stats.ts`/`card-stats.ts`, which
  reads as absent and is not) — it is each fixture's own lineup,
  `player-stats.ts:87-93` → `engine-db/lineups.ts:98`, whose rows carry
  `roles`/`role`.
- **F5.** The `/api/v1` public division stats route masks names via
  `public_person_name(...)`; it does not use `public_players_v`. The opt-IN
  consent view is reachable only from the SSR player page.

## 3. Decisions

**D1 — the final-ranks oracle asserts BOTH crossings, not one.**
The advance step captures the `complete` response and compares its
`events[0].finalRanks` against `expected.finalRanks`; the end-state oracle
independently re-reads `GET /stages/{id}/standings` and compares its `rank`
field (`progression.ts:716-730` sets `rank: i+1` from the same source).
Rationale: the POST response is the only place the engine's own ranking
crosses the wire, and standings is the only place a CUSTOMER sees it. One
without the other either cannot be re-read or cannot witness the engine's
intent. A disagreement between the two is itself a finding.

**D2 — "champion" is defined as `rank: 1` of the final stage's standings**,
cross-checked against `finalRanks[0]` from D1's captured response, and the
absence of any champion concept in the product is recorded as a spec §15
product finding. The bench does not invent a champion endpoint.

**D3 — P2's "claimed profile shows the real stats" is asserted over HTTP**,
as the claimed user, against `GET /api/v1/persons/{id}/stats`. The
consent-gated PUBLIC player card (`public_players_v`, SSR-only) is NOT this
wave's: `_INDEX.md` already schedules a browser-track journey "player stats
verified after the competition has finished" that rides on B03r's driver
after B05 exists. B05 produces the finished competition that journey needs and
records the hand-off; it does not build a second browser harness.

**D4 — both write paths ship, split across `_tiny`'s two divisions.**
Division A folds through the single-event `POST /fixtures/{id}/events`
(`expected_seq` strictly sequential per fixture); division B folds through
`POST /divisions/{id}/events/import`. Rationale: the single-POST path is what
live scoring uses and must never lose coverage (the prompt's darts pin exists
for exactly that), while an import path built now and first exercised in B08
would be an inert seam for three waves — the failure class this wave is
closing. Import caps are asserted from `IMPORT_CAPS`, not typed in.

**D5 — sequentiality is proven by a deliberate 409, surfaced as a finding.**
One regression drives an out-of-order `expected_seq` and asserts HTTP 409 with
code `SEQ_CONFLICT` and a `current_seq` in the body. The runner reports it as
a finding; it never silently retries. (A silent retry would make the whole
ordering discipline unfalsifiable.)

**D6 — the runtime oracle must be provably distinct from stage 0.**
A regression mutates one event AFTER stage-0 validation and asserts the
RUNTIME oracle reds. Without it, every oracle in this layer could be satisfied
by the offline validator that already exists, and the wave would ship a
tautology (spec §7C detection).

**D7 — advancement asserts before it writes.** The expected qualifier list is
compared against the proposal BEFORE `confirm`; a wrong table reds at the
proposal, never after the next stage has been seeded from it. This is the
`propose → assert → confirm → generate → complete` order, and the assertion
sits in the middle of it, not at either end.

**D8 — P3 (coach lanes) is shaped around the real discriminator.** Per F4 the
oracle puts a coach on the entrant's roster and in the fixture lineup with a
coach role, folds a card against them, and asserts no leaderboard row. The
exact predicate in the fold has NOT been read yet: T5 reads it first and, if
the product turns out not to discriminate, records a spec §15 product finding
rather than weakening the assertion to match.

## 4. Shape

New files under `scripts/bench/lib/`:

| file | owns |
|---|---|
| `simulate.ts` | folding a pack's streams through the live API — both write paths (D4), per-fixture sequentiality, throughput measurement (report-only) |
| `advance.ts` | `propose → assert → confirm → generate → complete` per stage, capturing the `complete` response (D1/D7) |
| `oracle.ts` | the comparators: standings + exact tie order, ranks, champion, leaderboards (name AND count), person + career stats, suspension carry, specials. Every mismatch renders engine-derived vs historical side by side |
| `people.ts` | P1 officials (propose via `/officials/auto`, write via `/officials/apply`), P2 claims (legacy `/api/claims/...` paths incl. the `CLAIM_EXPIRED` leg), P3 coach lanes, P6 news |

Wiring: a simulate/advance/oracle stage inside `runTinySuite` between the
board check and the `return` at `tiny.ts:2305`; results land in
`SuiteReport.oracles` (`report.ts:409`, which already exists and is populated
only by structural checks today) plus new report sections for sim timings,
people-layer results and provenance %. New pino events `suite_simulated`
(events, ms, event/s) and `oracle_checked` (kind, pass/fail) — named events,
matching `bench.ts`'s existing convention rather than `tiny.ts`'s ad-hoc
strings.

The tie-order comparator reads the division's CONFIGURED cascade (e.g.
`["points","buchholz","direct","wins","lots"]`) rather than assuming a fixed
field order — per the re-pin, tie order is a cascade array, not a column.

## 5. Tasks

| # | task | gate it must clear |
|---|---|---|
| T0 | bench plan chooser: never provision a non-public plan; least-privileged public plan that satisfies; fixtures off the live catalog | in flight |
| T1 | `simulate.ts` — single-POST path, per-fixture sequentiality, throughput | the 409 regression (D5) |
| T2 | `simulate.ts` — import path, caps asserted from `IMPORT_CAPS` (D4) | both divisions fold; neither path is inert |
| T3 | `advance.ts` — propose/assert/confirm/generate/complete, capture (D1/D7) | wrong expected table reds BEFORE any next-stage write |
| T4 | `oracle.ts` — standings, tie order, ranks, champion, leaderboards, person/career stats | the post-validation mutation reds the RUNTIME oracle (D6) |
| T5 | `oracle.ts` — suspension carry + specials; P3's discriminator read first (D8) | ineligible person 422s on lineup PUT and is absent from the GET |
| T6 | `people.ts` — P1 officials, P2 claims incl. `CLAIM_EXPIRED`, P6 news | a published post is visible on the public page; the rest stay draft |
| T7 | report sections + pino events + provenance % | the report names which oracles had something to check (B04's vacuity lesson) |
| T8 | live `_tiny` run, whole-branch review, PR | run by this thread, never a subagent |

## 6. Gates

```
cd <worktree> && ./packages/engine/node_modules/.bin/vitest run \
  --reporter=json --outputFile=/tmp/b05.json scripts/bench
cd <worktree> && jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/b05.json
cd <worktree> && npm run typecheck:scripts          # tsc is its own gate, every time
cd <worktree> && npx eslint scripts
cd <worktree> && npm run bench:scheduler -- --suite _tiny --wipe
```

`tsconfig.scripts.json` excludes `scripts/**/*.test.ts`, so tsc is structurally
blind to type errors in the tests — B04 shipped 884 green tests on a tree that
did not compile. Judge every run on `numTotalTests`, never the failure count.
There is no root `vitest`. Timings are measured and reported; they never red.

## 7. Risks this wave carries

1. **The vacuity risk B04 hit, one layer up.** `_tiny` is the only pack, and an
   oracle with nothing to compare reports CLEAN. T7 makes the report name which
   oracle kinds had a subject; an oracle that checked nothing is not green.
2. **Two fixtures proving each other.** The pack's expected values and the
   pack's streams come from the same file. The runtime oracle is only worth
   something because it goes through the live server — D6's mutation is what
   proves the loop is not offline.
3. **P3 may be a product finding rather than a bench assertion** (D8/F4).
4. **The claim accept flow is on legacy `/api`**, not `/api/v1` — the bench's
   client needs a raw path, and a v1-shaped helper will 404 silently.
5. **`autoAssignOfficials` writes nothing** — an assignment oracle that calls
   only it asserts a proposal and proves no assignment happened.
