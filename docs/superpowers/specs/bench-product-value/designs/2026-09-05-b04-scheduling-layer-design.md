# B04 — scheduling layer: design of record

Amends `2026-08-12-scheduler-bench-design.md` §5/§6 for the session that
builds them. The parent spec makes every semantic decision; this document
records only what B04 had to decide because the parent spec's premises about
the product turned out to be wrong, plus the module boundaries that follow.

Owner-approved 2026-09-04 (three decisions, §2). Session prompt:
`../bench-prompts/B04-scheduling-layer.md`. Kickoff:
`../B04-kickoff-2026-09-05.md`.

---

## 1. What the brief assumed, and what is actually there

Five premises checked against `main` at `3065c50da` before any code. Three
were false, one was weaker than stated, one held. Every line below is pinned;
re-pin before trusting it (`_RULES.md` §1 — and these pins are BRANCH-RELATIVE,
which is how `tiny.ts`'s own `schemas.ts:1496-1542` went stale).

### 1.1 `--engine` cannot select an engine. It never could.

`AutoScheduleRequest` (`apps/web/src/server/api-v1/schemas.ts:1653-1687`)
carries `only_unlocked`, `mode` (derived from it) and `ignore_locks`. There is
no engine field, no env var, no feature flag, no org or competition setting,
and no column that selects greedy over the solver.

`packages/engine/src/scheduling/build.ts:1165-1204` attempts the solver on
every eligible request. It falls back to greedy in exactly three
circumstances, none of them a caller's choice:

| Fallback | Trigger | Pin |
|---|---|---|
| `solver_busy` | `queued >= MAX_SOLVER_QUEUE` | `build.ts:1165` |
| `not_searched` | `!canSolveWithin(...)` — board too big for the lattice | `build.ts:1175-1176` |
| `solver_unavailable` | any `solveBuild` rejection: deadline, transport, auth, unreachable | `build.ts:2062-2094` |

The only lever a bench has is the third: `PLACEMENT_SERVICE_HOST`
(`placement-client.ts:748`, defaulting to `placement.flycast:50051`). That is
read in the **server** process. A bench that talks HTTP black-box — which is
the architecture, §2 of the parent spec — cannot flip it per request.

**But the result says which engine ran.** `AutoScheduleResult.solver.engine`
is `z.enum(["greedy","optimized"])` on the wire (`schemas.ts:1713`), forwarded
verbatim from `BuildResult.engine` and never re-derived.

So: **cannot choose, can identify.** §2.1 is what B04 does with that.

### 1.2 Layer 1 gates far less than "zero blocking" suggests

`isBlockingConflict` (`packages/engine/src/scheduling/calendar.ts:319-341`) is
the sole authority for the `blocking` flag `/validate` returns
(`usecases/schedule.ts` `mapConflicts`, `:1170-1183`). It returns true for
only four of the nine `ConflictReason` members (`calendar.ts:202-215`):

| Reason | Blocking? | Note |
|---|---|---|
| `court` | **yes** | minus `court_tag_mismatch`, `outside_court_hours`, `stranded_fixture`, each carved out with stated reasoning |
| `person_overlap` | **yes** | unconditionally |
| `window` | **yes** | outside the competition's resolved calendar window |
| `order` | **yes, if `direct`** | a fixture scheduled before the one that feeds it |
| `rest` | no | an entrant below `perEntrantMinRest` |
| `blackout` | no | inside a blackout, or outside every session window |
| `instruction` | no | day caps, weekday, date, earliest/latest |
| `no_slot` | no | |
| `start_window` | no | **see §5, F1 — this one looks unintended** |

Five of the seven rules B04's checker must recompute — rest minima,
blackout/session-window containment, day caps, round order, and the
start-window family — are gated by **nothing** in the product today.

The independent checker is therefore not a second opinion on a decided
question. For most of its surface it is the only gate that exists. That
raises the stakes on its own tests: a checker rule that never fires is not
redundant coverage, it is zero coverage (failure class 3).

### 1.3 `crossPersonClash` is a dead knob

Parent spec §5 names `crossPersonClash` as a scheduling knob to be covered by
≥2 suites (badminton doubles players entered in two draws — B12). The field
is `@deprecated` in the engine: *"Accepted and stored, read by nothing"*
(`SchedulingConstraints`, `packages/engine/src/scheduling`). `#399` made an
introduced person double-booking refuse absolutely — `isBlockingConflict`
lists `person_overlap` unconditionally — and the placer avoids one for the
same reason, so neither side consults the setting.

A pack that sets `crossPersonClash: "hard"` proves nothing about the product,
because setting it `"warn"` produces identical behaviour. Recorded as F6; it
is B12's problem, not B04's, but it is a §5 knob that cannot be covered as
specced and the roster should learn it now rather than at B12's acceptance
gate.

### 1.4 `hard[]` carries six constraint kinds, not one

The prompt's checker list says "day caps". `HardConstraint` is a
six-member discriminated union: `min_rest_minutes` (with
`rest_scope: per_person | feeder_to_dependent | both`),
`max_fixtures_per_day`, `fixture_on_weekday`, `fixture_on_date`,
`not_before`, `not_after` — each with a `ConstraintScope`, and the two
`fixture_on_*` members with a `FixtureSelector`.

**Consequence for the checker: an unmodelled hard constraint must be
REPORTED, never silently ignored.** A checker that skips what it cannot model
and then says "clean" is stating something it did not check. §3.3.

### 1.5 What held

All three pure libs shipped, in `packages/engine/src/scheduling/`:
`assessCapacity` (`capacity.ts:491`), `assessHealth` (`health.ts:442`),
`usableWindows` (`court-windows.ts:187`). And two read paths the checker needs
exist: `GET /api/v1/divisions/{id}/fixtures` (#706) returning `Fixture[]` with
`scheduled_at`/`court_id`/`venue_id`/`officials`, and
`GET /api/v1/orgs/{id}/venues` returning courts with their `court_hours` and
`court_exceptions` — the only read path for a court calendar
(`usecases/venues.ts:257-291`).

---

## 2. Decisions (owner-approved 2026-09-04)

### 2.1 `--engine` is an assertion, not a selector

`--engine` keeps its three existing values (`bench.ts:66,78-81`) and gains
meaning:

| Value | Behaviour |
|---|---|
| `optimized` (default) | Every scheduled division must report `solver.engine === "optimized"`. Mismatch **reds**, and the error names `solver.status` and `not_searched_reason` so a capacity fallback is distinguishable from an environment fault. |
| `greedy` | Same, asserting `"greedy"`. This is the leg run with placement torn down. |
| `both` | Asserts nothing about which engine ran. Records this leg's artifact, then emits the delta if the sibling leg's artifact exists. |

`both` relaxes only the engine assertion. Layer 1, the checker and the
certificate gate identically under all three values — a run is never made
greener by asking for the comparison.

Every value writes `<reportDir>/<runId>/engine-<actualEngine>.json` carrying
each division's `ScheduleMetrics` plus its checker verdict. `runId` is the git
SHA (`report.ts:180-182`), so the two legs of one commit land side by side
instead of overwriting — which is the kickoff's trap 1, closed by putting the
engine in the filename rather than the directory.

**Why an assertion and not a passive record.** `_RULES.md` §2 already names
the failure this catches: set the placement vars on the test process instead
of the server and *"every board quietly comes back greedy while your suite
reports on it. That is the false green, and it looks exactly like a pass."*
A bench leg that believes it measured the solver and measured the fallback
has measured nothing, and today nothing would say so.

**What this does NOT do.** It does not run both engines in one invocation,
because nothing in the product permits that. The delta comes from the
both-ways gate `_RULES.md` §2 already mandates — the two runs were always
required; B04 makes them produce a comparison instead of two unrelated
reports. The prompt's acceptance line reads "greedy-vs-optimized delta present
when both ran", and "when both ran" is now literal.

### 2.2 Layer 1 stays as specced; the checker carries the rest

`/validate` must return zero `blocking` conflicts — no more, no less. The
bench does **not** widen that assertion to warn-level rows.

Widening it would make layers 1 and 2 test the same rules through the same
server-side computation, and a shared bug would pass both — the
wrapper-parity tautology parent spec §6 exists to prevent. Keeping them
separate means a disagreement between them is a §7B finding with evidence,
which is worth more than a stricter single gate.

Warn-level rows are tallied per division by `details.kind` and reported. The
tally is report-only.

### 2.3 The checker recomputes; it shares metrics only

`_RULES.md` permits the checker to share `capacity.ts`, `health.ts` and
`court-windows.ts` as *"arithmetic, not the system under test"*. B04 narrows
that permission — it does not contradict it:

- **`assessHealth` — used, report-only.** Believability metrics never gate
  (`_RULES.md` §1, timings-and-measurements rule). Sharing the metric
  arithmetic with the product is the point: a later swap is a no-op.
- **`usableWindows` — NOT imported.** The solver consumes it to decide legal
  windows. A checker that verified containment with the same function would
  make that one rule a tautology, which is exactly what §6's independence
  clause forbids. The checker recomputes containment from the raw
  `court_hours` / `court_exceptions` rows it fetched.
- **`assessCapacity` — not imported.** It is a pre-flight feasibility
  estimate, not a verification of a produced board.
- **Type-only imports are allowed**, `ConflictDetailKind` in particular, so a
  bench finding and a product conflict cite one token and cannot drift. No
  value import from `@seazn/engine` appears in `checker.ts`.

---

## 3. Modules

Five files under `scripts/bench/lib/`. The existing house style holds
throughout: one responsibility per file, DI seams on every I/O boundary so
the unit suite drives them with fakes and never needs live Postgres or a live
server (`PlanSql`, `SeedTransport`, `resolveOrgSlug` are the precedents).

### 3.1 `board.ts` — the seam

Pure types, zero I/O, zero imports from the rest of the bench. Two shapes:

```ts
/** One fixture as the PRODUCT reports it after apply. */
export interface BoardFixture {
  fixtureId: string;
  extKey?: string;
  divisionId: string;
  divisionRef: string;
  roundNo?: number;
  poolId?: string;
  /** epoch ms; undefined means UNPLACED. */
  start?: number;
  /** epoch ms. DERIVED — see §4.2. */
  end?: number;
  courtId?: string;
  courtName?: string;
  venueId?: string;
  entrantIds: readonly string[];
  personIds: readonly string[];
  officialIds: readonly string[];
  locked: boolean;
}

export interface BoardCourt {
  courtId: string;
  name: string;
  venueId: string;
  /** Raw rows as fetched. NOT folded through usableWindows — §2.3. The two
   *  row TYPES are imported `import type` from `court-windows.ts` so the
   *  shapes cannot drift; that is a type-only import, and §2.3's ban is on
   *  the FUNCTION. */
  hours: readonly CourtHoursRow[];
  exceptions: readonly CourtExceptionRow[];
}

export interface Board {
  divisionId: string;
  divisionRef: string;
  tz: string;
  fixtures: readonly BoardFixture[];
  courts: readonly BoardCourt[];
}

/** What the PACK declared, normalised to epoch ms — the checker's oracle. */
export interface EncodedConstraints {
  divisionRef: string;
  matchMinutes: number;
  gapMinutes: number;
  startAt?: number;
  endAt?: number;
  courtIds: readonly string[];
  perEntrantMinRest: number;
  blackouts: readonly { courtId?: string; from: number; to: number }[];
  sessionWindows: readonly { from: number; to: number }[];
  /** Mapped from `constraints.hard[]`. §3.3 governs the unmapped ones. */
  hard: readonly EncodedHardRule[];
  pins: readonly { fixtureId: string; start: number; courtId: string }[];
  isRoundRobin: boolean;
  /** `HardConstraint` members this bench build cannot model, carried so the
   *  checker can report them as UNCHECKED rather than imply it checked them.
   *  `CheckerReport.unchecked` is this list, forwarded — one authority, and
   *  the checker never composes a second one. */
  unmodelled: readonly { type: string; reason: string }[];
}
```

Why this file exists at all: the acceptance criteria require each checker rule
proved on a hand-built violating board, and require the certificate to run the
REAL timetable through the SAME encoded constraints. Both need a board that no
HTTP call produced. Making that the checker's only input is what makes it
testable, and it is also what keeps `checker.ts` free of any temptation to
call back into the product.

### 3.2 `schedule.ts` — the driver

`runScheduleLayer(input): Promise<ScheduleLayerResult>`, one pass per
division. Per division, in order:

1. Resolve `@`-sigil court refs in the division's `scheduleConfig` against
   `seeded.courtIdByRef` (B03 already seeds `pack.venues`, `seed.ts:332-378`).
2. `PUT /api/v1/divisions/{id}/schedule-settings` with the resolved config.
3. Apply the pack's declared locks (§4.4), then
   `GET /api/v1/divisions/{id}/fixtures` — snapshot which fixtures are
   `schedule_locked`, before anything moves. These become
   `EncodedConstraints.pins`. Snapshotting AFTER locking and BEFORE `auto` is
   what makes the pin rule assert against the product's own state rather than
   against the bench's intention.
4. `POST /api/v1/stages/{id}/schedule/auto`.
5. `POST /api/v1/stages/{id}/schedule/apply`.
6. `POST /api/v1/divisions/{id}/schedule/validate` — layer 1.
7. `GET /api/v1/divisions/{id}/fixtures` again, and
   `GET /api/v1/orgs/{id}/venues` — this is what builds the `Board`.

Returns per division a `ScheduleOutcome`: `requestedEngine`, `actualEngine`,
`solverStatus`, `notSearchedReason`, `mode`, `budgetExpired`,
`tiersCompleted`/`tiersTotal`, the five `ScheduleMetrics` fields, both
conflict lists, `blockingCount`, `warnKindTally`, `unplacedCount`, `wallMs`.

Also widens the bench's `AutoScheduleOut` (`tiny.ts:717-726`) from the
three-field hand-copy it is today to the fields B04 reads — see F4.

### 3.3 `checker.ts` — the independent verifier

`checkBoard(board: Board, constraints: EncodedConstraints): CheckerReport`.
No I/O, no clock, no value import from `@seazn/engine`. Seven rules:

| Rule | What it recomputes |
|---|---|
| court double-booking | two placed fixtures overlapping on one `courtId` |
| window / blackout containment | every placed fixture inside a session window, outside every blackout, and inside its court's own `court_hours` minus `court_exceptions` — recomputed from raw rows |
| per-entrant rest minima | gap between an entrant's consecutive fixtures ≥ `perEntrantMinRest`; also `min_rest_minutes` by `rest_scope` |
| day caps | `max_fixtures_per_day` per its `ConstraintScope` |
| pin integrity | every fixture in `pins` holds the same `start` and `courtId` after apply |
| official double-booking | one official on two overlapping fixtures |
| round order | round-robin only: for rounds r < r', day(r) ≤ day(r') and, same day, start(r) ≤ start(r') — reported with **both** fixture ids named |

`CheckerReport` carries `findings: CheckerFinding[]` and
`unchecked: {type, reason}[]`. **A non-empty `unchecked` is rendered in the
report beside the verdict**, so "checker clean" can never be read as "every
declared constraint was verified" when it was not (§1.4).

### 3.4 `certificate.ts` — §6.3, in the specced order

`certify(input): CertificateVerdict`. History first, attribution second — the
order is the whole protocol, because reading a solver `INFEASIBLE` as a
product defect before checking our own encoding is how a pack-authoring bug
gets filed against the solver.

| Branch | Condition | Red? |
|---|---|---|
| `SKIPPED_NO_HISTORY` | pack declares no `historicalAssignment` | no |
| `PACK_AUTHORING_BUG` | the real timetable, run through `checkBoard` against our `EncodedConstraints`, violates them | **yes** — fix the pack |
| `PRODUCT_DEFECT` | history satisfies the encoding **and** the solver returned `infeasible` | **yes** |
| `UNPLACED` | `metrics.placed < metrics.total` | **yes** (parent spec §6.3's unplaced-fixture gate) |
| `FEASIBLE` | history satisfies the encoding and a board was produced | no |

The certificate reuses `checkBoard` verbatim rather than a parallel
implementation: the claim it makes is precisely "the same rules that judged
the product's board also judge history", and two implementations could not
make it.

### 3.5 `believability.ts` — report-only

`assessHealth` over the fetched board for the five metrics
(`restSpread`, `courtBalance`, `gapDispersion`, `homeAwayAlternation`,
`primeSlotFairness`); `homeAwayAlternation` is omitted by the lib itself for
non-round-robin stages and is not scored zero. Plus the engine delta (§2.1)
and similarity-to-historical %, where history exists. Nothing here ever reds.

---

## 4. Decisions inside the modules

### 4.1 The board is FETCHED, never assembled from `auto`'s response

`schedule.ts` builds the `Board` from step 7's `GET /fixtures`, not from the
`assignments` array it POSTed at step 5. Reading back our own request body
would prove the bench can echo itself. This is the exact shape the kickoff
names — *"a fixture that pre-seeds the end state cannot witness the code that
should have produced it"* — pointed at B04's own core claim, and it is worth
the second round trip.

### 4.2 End times are derived, and the derivation is cross-checked

`Fixture` carries `scheduled_at` and no `ends_at`
(`schemas.ts:1000-1055`), while `auto.assignments[]` carries an optional
`ends_at`. So `BoardFixture.end` is derived as `start + matchMinutes`.

Where `auto` supplied an `ends_at`, `schedule.ts` compares it against the
derivation and records a **finding** on disagreement rather than preferring
either. A silent preference here would let the checker measure overlaps
against a duration the product does not agree with, and every overlap rule
depends on it.

### 4.3 The officials rule must be able to fail

`Fixture.officials` is `z.array(z.unknown())` on the wire. The rule
shape-guards each element at runtime, and **reds when a division whose pack
declared officials fetches zero of them** — because otherwise an empty array
makes the rule vacuous and permanently green, which is failure class 3 with a
type annotation for cover.

### 4.4 Pin integrity needs a pin, so `_tiny` locks a fixture

The rule is decoration on a pack with no locked fixtures. `_tiny` locks one
fixture before step 4, so a live run exercises it. If no lock route is
reachable over the API, the deferral is named in the report and the PR body —
not left as a rule that passes because it never ran.

### 4.5 The nondeterminism probe is deferred, with its reason

Parent spec §6 asks for "schedule twice, diff, report %". Re-running `auto`
after `apply` is not a repeat of the same experiment: `only_unlocked`
preprocesses into `mode`, so the second call derives `reflow` or `polish`
against a board that is now placed. A meaningful probe needs a reset between
runs. Deferred to B17, which owns the repair/reflow path and needs that reset
anyway.

---

## 5. Findings recorded, no product code touched

B04's stated non-scope is product code and the placement service. All six are
recorded here and in the PR body; none is fixed in this session.

- **F1 — `start_window` never blocks.** `ConflictReason`'s own comment calls
  it `(hard)` and `REASON_CODE` gives it the `conflict.` prefix reserved for
  hard refusals (`apps/web/src/lib/schedule-board.ts:25-40`), but
  `isBlockingConflict` omits it, so it ships `blocking: false`. Either the
  prefix or the predicate is wrong. The three deliberate carve-outs in that
  function each state their reasoning; this one is not mentioned, which is
  what makes it look unintended rather than decided.
- **F2 — `ScheduleConflict.blocking`'s doc comment contradicts its
  producer.** The comment (`schemas.ts:1548-1554`) says `blocking` is
  "DELTA-based … a court clash … blocks when THIS change introduced or
  worsened it". `mapConflicts` sets it from `isBlockingConflict`, which is
  absolute; the delta is a separate function applied at the move gate. A
  reader modelling the wire contract from the comment gets it wrong — which
  is how this design nearly concluded that layer 1 was delta-scoped.
- **F3 — no organiser can request or require an engine.** §1.1. A customer
  cannot ask for a fast greedy board, and cannot insist a board be solved
  rather than fall back. The result reports which ran, so the information
  exists; nothing lets anyone act on it.
- **F4 — the bench's `AutoScheduleOut` is a tsc-blind hand-copy.**
  `tiny.ts:717-726` declares three fields of a much larger wire schema. A
  field added or renamed server-side is invisible to `tsc` here. B04 widens
  it to what it reads; the copy remains hand-maintained (same class as the
  known pad-shim trap).
- **F5 — `tiny.ts`'s `schemas.ts:1496-1542` pin is stale**; the type is now
  at `1653-1687`. Fixed inline — a bench file, inside the stated file set.
- **F6 — `crossPersonClash` is deprecated and read by nothing.** §1.3.
  Parent spec §5 requires ≥2 suites to cover it; that coverage cannot exist.
  B12's problem, surfaced now.

---

## 6. Testing

All four types, per `RULES.md`.

- **Unit.** Each checker rule on a hand-built violating board carrying exactly
  one violation, with asymmetric sizes so a transposed index cannot pass.
  Certificate's three live branches plus `SKIPPED_NO_HISTORY`. The `--engine`
  assertion in both directions. Round order gets an order-differential case:
  a board whose fixtures are individually legal and wrong only in sequence,
  so the rule cannot pass by accident.
- **Regression — the independence proof.** A board that satisfies `/validate`
  (trivial, given §1.2 — a blackout violation is not blocking) and violates a
  checker rule must red the run. Run as a mutation, literally as the prompt
  asks: bypass the checker, the run goes green; restore it, the run reds. A
  test that only asserts the red half cannot distinguish a working checker
  from a gate that reds on everything.
- **Smoke.** `_tiny` gate run, both legs — placement up (`--engine
  optimized`) and torn down (`--engine greedy`).
- **E2E.** The bench run itself, per `_RULES.md` §1.

Guard against the vacuous modes this repo has paid for: mutate each checker
rule one at a time (two rules covering for each other are each untested);
compare `numTotalTests`, not the failure count, because a collection-breaking
mutant reports zero failures; and derive expected values from the pack and
the engine's own declarations rather than constants typed into the test.

## 7. Scope changes to `_tiny`

- `venues[]` gains one venue with **two** courts, so `scheduleConfig.courts`
  has something to sigil-reference and court double-booking has somewhere to
  happen. `tiny.ts`'s ad-hoc venue/court creation (`:974-993`) is deleted; the
  pack is the one source.
- **Both** divisions get a `scheduleConfig` and both are scheduled. `_INDEX.md`
  records that `runTinySuite` schedules `divisions[0]`/`stages[0]` only and
  that "B04 owns closing this"; this is where it closes.
- No `historicalAssignment` — `_tiny` has no real-world timetable, so the
  certificate reports `SKIPPED_NO_HISTORY` with its reason, which is what the
  acceptance criteria ask for.
