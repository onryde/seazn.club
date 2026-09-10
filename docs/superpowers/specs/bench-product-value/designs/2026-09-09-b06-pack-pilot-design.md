# B06 — the pack pilot: a suite framework, then the first real pack

Design of record for B06, owner-approved 2026-09-09. Supersedes
`bench-prompts/B06-pack-darts-pilot.md` where the two disagree — the prompt was
authored 2026-08-13 and four of its premises are false against the tree.

Programme: `bench-prompts/_INDEX.md` (session rows, status log) →
`bench-prompts/_RULES.md` (standing rules) → `_PACK-PLAYBOOK.md` (the recipe
this wave exists to make trustworthy). Spec of record:
`2026-08-12-scheduler-bench-design.md`. Prior waves' designs:
`2026-09-05-b04-scheduling-layer-design.md`,
`2026-09-07-b05-simulation-layer-design.md`.

Every `file:line` below was re-pinned against `main` `8f3e3d655` on 2026-09-09.

## 1. What B06 closes, and why it is two waves

B06 is the pilot: the first real suite through the whole pipeline, the session
that freezes `PackSchema`, and — per `_PACK-PLAYBOOK.md` — the session whose
**real deliverable is a playbook the next nine pack sessions can trust**.

It splits into two waves because the pilot has two unrelated jobs and mixing
them gives a branch two reasons to be red:

- **B06a — the framework.** There is no way to add a second suite today.
  `bench.ts:29` is `KNOWN_SUITES = ["_tiny"] as const`, dispatch is
  `if (key === "_tiny")` at `:176` falling through to a `throw` at `:207`, and
  the runner is `runTinySuite` (`lib/suites/tiny.ts:1317`), a ~3,500-line
  function with a bespoke `TinySuiteInput` (`:453`). Proved entirely against
  `_tiny`; no new data.
- **B06b — the darts pack.** Suite 11, authored against a framework that
  already works. **`PackSchema` freezes when B06b merges**, not B06a.

A third change ships independently of both: a small product PR typing the
knockout stage config (§6).

## 2. The premises that moved

Five, each verified before any of this was designed. Recording them is the
point (`_RULES.md` §1, AGENTS.md failure class 5).

### 2.1 The generic module cannot express sets of legs

The prompt asks for "sets-based scoring at generic fidelity ceiling". Generic
declares exactly two event types — `"generic.result"` and `"generic.score"`
(`packages/engine/src/sports/generic/generic.ts:242-245`) — and its state is a
flat `score[2]` plus a running tally
(`packages/engine/src/sports/generic/generic.schema.json:110-150`). `GenericCfg`
is `resultMode`/`allowDraws`/`points`/`progressScore` and nothing else
(`generic.ts:30-46`). Set-and-leg nesting exists only in
`packages/engine/src/sports/setbased/kernel.ts:1561` and
`nested/kernel.ts:1447`, neither reachable from generic.

Fidelity is `generic.result` 0 and `generic.score` 1 (`generic.ts:390-393`);
both are pad-reachable, so generic has no registered-but-unreachable type.

**Consequence:** a darts match is one flat quantity, not two. Decision D1.

### 2.2 Byes are native, and the field that carries them is untyped

`nextPowerOfTwo` (`packages/engine/src/scheduling/bracket.ts:40`) takes 96 to
128, so a 96-player draw wants exactly 32 byes — which is exactly the real PDC
format, 32 seeds entering round two. A bye is created at `bracket.ts:186` as a
round-0 fixture with the other side null and an auto-decided `award`.
Organiser-chosen byes must be exactly `nextPowerOfTwo(n) − n` long or the stage
is refused `CONFIG_INVALID` (`:104-118`, refusal at `:110`); `slotOrder`
(`:126-146`) pins the round-0 map verbatim with `null` in bye slots, refuses
being combined with `byeEntrants` (`:131`), and refuses a two-bye pairing
(`:145`). `usecases/stages.ts:800-810` reads `cfg.byes` and `cfg.slotOrder`.

There is **no staggered entry within a stage** — grep for
`entryRound|entry_round|staggered` over `bracket.ts` and `stages.ts` returns
nothing. Entrants join at round 0 or hold a bye; entering later is a
cross-stage `ProgressionSchema` matter (`api-v1/schemas.ts:901-935`).

But both keys ride `CreateStage.config: z.record(z.string(), z.unknown())`
(`api-v1/schemas.ts:980`) inside an otherwise `.strict()` envelope (`:983`).
**A misspelled `slotOrder` is dropped in silence** and the product seeds its
own draw. Decisions D4 and D8.

### 2.3 `expected.matches` and `expected.specials` have no comparator

`PackExpected` (`scripts/bench/lib/pack-schema.ts:1313`) declares `matches`,
`tables`, `champions`, `finalRanks`, `leaderboards`, `careers`, `suspensions`,
`specials`. B05 wired eight comparators; the set of `pack.expected.*` reads in
`lib/suites/tiny.ts` is exactly careers, champions, finalRanks, leaderboards,
suspensions, tables. `matches` and `specials` are touched only by offline
static validation (`lib/validate-pack.ts:1616`, `:1888`).

So **no per-match result is compared against the live HTTP run** — stage 0
folds them offline and the seeded run never asks. The prompt's "per-round
results" oracle does not exist. Decision D3, and it must land before the freeze.

### 2.4 The entitlement acceptance item is dead

`_RULES.md` §3 and the playbook both require a 422 proving the deep-tier gate
exists before provisioning clears it, citing `requiredFeatureForEvent` and
`cricket.ball` → `scoring.ball_by_ball`. Entitlements v18 W1 (owner ruling
2026-08-30) deleted the whole fidelity-band gate and its three keys —
`apps/web/src/server/usecases/fidelity.ts:1-9` records the deletion, and
`usecases/scoring.ts:277-289` states that DLS is now **the only entitlement
gate left at the scoring door** (`requiresDlsEntitlement`).

Scoring detail is free on every plan. For suite 11, at generic tier 1, there is
no gate to prove at all. Decision D7.

### 2.5 The people layer is one-third built, not wired-as-briefed

The playbook's per-pack acceptance says the run reaches "people-layer steps
(officials, claims, coach lanes, news) — as wired in B03–B05". Pinned:

| §9 scenario | state |
|---|---|
| P1 officials | **EXISTS** — `lib/seed-plan.ts:488`, `lib/seed.ts:689`, auto-assign oracle `lib/suites/tiny.ts:2102`, double-booking Rule 7 `lib/checker.ts:743`,`:884`,`:944` |
| P2 claims | **HALF** — invites created (`lib/seed-plan.ts:313-334`, `:387`), `tiny.ts:1669` asserts they stay UNCLAIMED. No acceptance path; the magic-link helpers that exist serve sign-in (`lib/http.ts:80-94`, `lib/drivers/browser.ts:81`) |
| P6 news | **ABSENT** — `lib/report.ts:658` declares `news: {drafted, published}`; nothing writes or reads it |

Also absent: a `provenancePct` writer. The field is declared at
`lib/report.ts:655` and nothing in `scripts/bench` assigns it. Throughput, by
contrast, already exists — `computeEventsPerSecond` (`lib/simulate.ts:128`),
used at `lib/simulate.ts:260`, `lib/import.ts:483`, `tiny.ts:2766`/`:2855`.

Decisions D5 and D6.

## 3. Decisions (owner, 2026-09-09 — do not re-open)

- **D1 — darts stays the pilot and is encoded flat, at two granularities.**
  Div A carries one `generic.score` per **set**; Div B (a Women's Series event,
  which is a leg race) carries one per **leg**. Same module, a real granularity
  contrast, and leg detail inside Div A is a recorded §7A drop. Rejected:
  encoding legs while carrying sets in the `generic.result` payload (two
  quantities in one match, with standings reading the other one), and moving
  the pilot to a natively-modelled sport.
- **D2 — B06 splits into B06a (framework) and B06b (pack).** `PackSchema`
  freezes at B06b's merge.
- **D3 — `compareMatches` and `compareSpecials` are built in B06a**, against
  `_tiny`'s existing subjects (8 matches, 1 special), before the freeze.
- **D4 — the bench asserts its own draw.** Round-0 fixtures are read back and
  compared to the pack's declared draw, so a dropped `slotOrder` reds as a draw
  mismatch rather than as ninety-five wrong results.
- **D5 — T6 (claim accept, news) lands in B06a**, not in a pack session and not
  at B18. They are per-suite reusable steps and belong in the extracted runner.
- **D6 — news is drafted AND published**, a small fixed set per suite (the two
  semis and the final); the rest are asserted still draft and
  `shouldFirePostPublished` is observed exactly once. With `--keep` this leaves
  real news on a browsable org, which is the intended payoff.
- **D7 — the playbook's entitlement item is rewritten in B06a** against the
  post-v18 world: no fidelity gate, DLS the only scoring-door gate, and suites
  with no paid gate satisfy the item by recording that rather than faking a 422.
- **D8 — the untyped stage config gets a small separate product PR** (§6), not
  a fix inside a bench wave and not merely a recorded finding.

## 4. B06a — the framework wave

Scope, all provable against `_tiny` alone:

1. **Suite registry.** Replace `KNOWN_SUITES` and the `if`-chain with a keyed
   registry; `--suite` validation and its error text derive from the registry,
   so a new pack is an entry, not a branch (`bench.ts:29`, `:105`, `:112`,
   `:161-207`).
2. **Extract the runner.** `runTinySuite` becomes a shared pack-driven runner —
   preflight → seed → schedule → check → certificate → start → fold → advance →
   oracles → people → report — with `_tiny` as a thin caller. Suite differences
   become inputs. `SuiteReport` (`lib/report.ts:641`) stays the return type.
3. **The two missing comparators** (D3), each with a `_tiny` subject and each
   emitting `oracle_checked`, with NO SUBJECT available as a verdict (B05's
   third verdict, not a PASS).
4. **`provenancePct` writer** + its report line, computed from
   `streams[].provenance`.
5. **T6 (D5, D6):** claim accept via magic link for three invites per suite
   (bench spec §9 P2's "~3 stars/suite"), asserting the
   claimed profile then shows the real stats and covering one expired/invalid
   token path (§9 P2); news drafts on decided fixtures, semis + final published,
   the rest asserted draft, effect observed once (§9 P6).
6. **Doc corrections shipped with the code:** `_RULES.md` §3's entitlement
   bullet, the playbook's entitlement and people-layer acceptance items, a
   note that B06b's throughput figure is a floor with B08 owning the real
   number, `_INDEX.md` rows split into B06a/B06b, and §2.2's untyped-config
   finding written into the bench design's product-findings appendix.

**Testing.** Unit + regression per new comparator and step against the existing
fakes; a mutation sweep on the new comparators specifically — a comparator with
no killer is the exact shape B05 shipped twice, and the killer LIST is recorded,
not just a count. `_tiny` live on both placement legs is the smoke/e2e proof.

**The risk this wave carries** is the inert seam: an extracted runner that
compiles, passes and is driven by nothing real. `_tiny` is its only caller and
the live run is mandatory in-wave, never deferred to B06b.

## 5. B06b — the darts pack (suite 11)

**Structure.** Org "PDC Worlds" → one competition → two divisions, both
`generic`, per §3 of the bench spec (One Org → One Comp → Two Divisions).

- **Div A — PDC World Championship 2025 main draw.** `knockout`, 128 slots,
  32 byes = the 32 seeds entering round two. The draw is pinned with
  `slotOrder` and asserted back (D4). Streams: one `generic.score` per set plus
  the settling `generic.result` carrying `winnerId` and `p1Score`/`p2Score`;
  the final folds to 7–3, Littler over van Gerwen.
- **Div B — one PDC Women's Series 2024 event**, best-documented chosen at
  research time and the choice recorded in `meta.adaptations[]`. Leg races, so
  one `generic.score` per leg.

**Constraint scenario — the reason suite 11 exists.** One court, the Ally Pally
stage. Two sessions a day is **not** `sessionWindows`: that field is venue-wide
with no court key (`api-v1/schemas.ts:1542-1545`). It is two `PackCourtHours`
rows per weekday on the one court (`lib/pack-schema.ts:753`), which the product
allows (`db/migration/deltas/V367__venues_and_courts.sql:114-120`, PK
`(court_id, weekday, open_min)`; `usecases/venues.ts:192-197` states multiple
ranges per weekday are allowed and 422s only on overlap). The Christmas break is
`PackCourtException` closed dates (`lib/pack-schema.ts:780`). Day caps ride
`constraints.hard[]` `max_fixtures_per_day` at 3–4
(`packages/engine/src/scheduling/constraints.ts:94-98`, admitted at
`api-v1/schemas.ts:1577`). The final session's pins are per-fixture
`schedule_locked` (`api-v1/schemas.ts:1136`, honoured by `AutoScheduleRequest`
at `:1878-1899`) — a fixture field, not a config field. 16 playing days, one
court, ~95 matches: the hardest packing case in the roster.

**Certificate: full.** The real session-by-session timetable is published, so
`historicalAssignment` (`lib/pack-schema.ts:993`) is complete and §6.3's
pack-bug-vs-solver-bug fork is available for any INFEASIBLE.

**Oracles, with subjects named honestly:**

| oracle | subject |
|---|---|
| champion | both divisions' winners |
| per-round results | every match, via B06a's `compareMatches` |
| leaderboard | most sets won. Averages, 180s and checkouts are not engine-representable at any tier — recorded as a §7A drop |
| careers | **research target**: a Women's Series player who also appears in the Worlds field. If none, reports NO SUBJECT rather than inventing one |
| suspensions | none exist in darts → NO SUBJECT, deliberately |
| specials | none — the pilot stays mechanically plain on purpose (bench spec §8 assigns darts no special) |
| claims | 3 stars accept via magic link |
| news | drafts on decided fixtures; semis + final published |

**Provenance: `real` throughout** — published set scores are primary-source, so
nothing here is reconstructed and no darts generator is added to
`lib/reconstruct.ts` (whose generators are set-based and sport-agnostic:
`:342`, `:654`, `:815`). Suite 10 (carrom) remains the thin-data case.

**Entitlement: none applies** (D7, §2.4).

**Size:** ~95 + ~20 matches, ~1,100 events, ~112 persons. Light by design. The
throughput number it records is a floor; `_RULES.md` §3 already assigns the
real volume measurement to B08.

## 6. The separate product PR — typing the knockout stage config

`CreateStage.config` is one untyped record shared by every stage kind —
league, group, swiss, knockout, double_elim, stepladder, page_playoff,
americano, ladder (`api-v1/schemas.ts:61`). Typing `byes`/`slotOrder` therefore
**cannot** be a blanket strict schema, or every other kind's config keys begin
400ing. It has to be a per-kind shape that types knockout and passes the rest
through unchanged.

Ships with a regression test proving both directions: a misspelled `slotOrder`
now 400s, **and** a league config still round-trips. Touches `schemas.ts`,
`usecases/stages.ts:800-810`, the CI OpenAPI drift step, and tests. No
user-facing strings, so no locale work. Independent of B06a and B06b; can land
at any point.

## 7. Gates

Per wave, with raw counts pasted from the JSON reporter (never an rtk summary —
`_RULES.md` §3): vitest green, `typecheck:scripts` 0, eslint 0, and a live run.
B06a: `_tiny` on both placement legs (`_RULES.md` §2). B06b: stage 0 offline,
then the full suite 11 on both engine legs, checker clean, certificate per
§6.3, report (json + md) committed to the PR.

Timings are recorded and never asserted. A 95-match single-court board may make
the solver work hard; that must not red anything (`_RULES.md` §1).

## 8. Explicitly out of scope

No CI wiring for the bench; no change to `.github/workflows/e2e.yml`; no darts
reconstruction generator; no new UI; no changes to the other eleven suite
sheets; no browser path — suite 11 is API-first like suites 1–12.

## 9. Named unknowns, carried rather than assumed

1. Whether a Women's Series player also appears in the Worlds field — decides
   whether the careers oracle has a subject.
2. Which Women's Series 2024 event is best documented.
3. Whether any 2025 walkover or withdrawal exists to encode as an adaptation.

Each is a research-time finding to record in `meta.adaptations[]` or the
`_INDEX.md` status log, not a blocker.
