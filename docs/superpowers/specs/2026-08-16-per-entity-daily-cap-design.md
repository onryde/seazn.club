# Per-entity daily cap: the sentence every organiser writes and nothing understands

Proposed 2026-08-16, after the instruction-parse bench (#584). NOT yet
owner-approved beyond "spec it".

## Why this one

> "no player plays more than 2 matches a day"

This is the defining constraint of a one-day individual tournament —
badminton, table tennis, chess, carrom, darts, all of which the platform
supports. It is the first thing an organiser of such an event says about
their schedule.

Today it compiles to **nothing**, on every model, in every bench run.
Corpus rows `t01` ("no player plays more than 2 matches a day") and
`t02` ("each team plays twice a day at most") exist precisely because
this phrasing is the one organisers reach for, and both are labelled
"must defer". Every arm defers them correctly — which is the right
behaviour and a total product failure at the same time.

Worse, it is an active trap. `PARSER_PROMPT` rule 8 exists ONLY to stop
the model compiling this as `max_fixtures_per_day`, because that counts
the whole scope's fixtures on a day, not one player's. Before that rule
existed, a model reading "no player plays more than 2 a day" as
"the competition plays at most 2 a day" would cap a 60-player event at
two matches daily. The rule is a guard around a hole; this spec fills
the hole.

## Why it is NOT the blackout situation

The lunch break turned out to be a word the engine already knew. This
one is not. Checked 2026-08-16:

`ConstraintScope` (`packages/engine/src/scheduling/constraints.ts:30`)
is `competition | division | entrant | pool | person` — and **every
non-global member carries an id**:

```ts
z.object({ kind: z.literal("entrant"), entrantId: z.string().min(1) }),
z.object({ kind: z.literal("person"),  personKey: z.string().min(1) }),
```

So the engine can say "entrant X plays at most 2 a day". It cannot say
"EVERY entrant plays at most 2 a day". That is the missing concept, and
it is missing in the engine, not just the parser.

Precedent that the engine is comfortable with the shape, though:
`SlotConfig.perEntrantMinRest` is exactly a rule that applies to every
entrant without naming one. This spec adds the daily-count sibling of
that idea.

## Two approaches

### A. A universal scope (recommended)

Add to `ConstraintScope`:

```ts
z.object({ kind: z.literal("every_entrant") }),
z.object({ kind: z.literal("every_person")  }),
```

The verifier groups assignments by entrant (or person) per day and
checks each group's count against `max_fixtures_per_day`.

- **For**: one constraint regardless of field size; reads back to the
  organiser as the sentence they wrote; no id invention possible, so
  the parser can emit it from a competition-level context with nothing
  added to `ParserContext`.
- **Against**: a new `ConstraintScope` member is a wire-format change
  touching the golden corpus, `verifyConfig`, the CP-SAT encoder and
  `conflict-detail`.

### B. Expansion into per-id constraints

The pack builder expands one stated rule into N `max_fixtures_per_day`
constraints, one per entrant, using ids it already holds.

- **For**: no engine union change; the verifier works unmodified.
- **Against**: N constraints for a 200-entrant event, every one of them
  in the pack the model reads and in every conflict message; a schedule
  with 200 near-identical rules is unreadable, and the AI pack's token
  budget is a live constraint. It also loses the organiser's sentence:
  what comes back is 200 rules, not "no player plays twice a day".

**Recommendation: A.** B is cheaper this week and worse forever. The
readability cost lands on the surface organisers actually see.

## Entrant vs person

These are different rules and the difference is not cosmetic.

- **entrant** — a doubles PAIR is one entrant. "Each pair plays at most
  2 a day."
- **person** — the individual. A player entered in both singles and
  mixed doubles is TWO entrants and ONE person; only a person-scoped cap
  protects them from four matches in a day.

`min_rest_minutes` already draws exactly this distinction with
`rest_scope: per_person`, and the parse bench shows models handle that
split correctly when the prompt states it plainly (corpus `c07`). So
both scopes are worth having, and the prompt should say which is which
using the same language rule 3 already uses for rest.

Default when the organiser says "player": **person**. They are talking
about a human being, not an entry.

## Parser surface

```ts
{ type: "max_fixtures_per_day",
  count: int,
  scope: {kind:"every_person"} | {kind:"every_entrant"} | …existing }
```

No new rule type — this is a scope widening of a rule that already
exists, which keeps the vocabulary small and means `refuseContradictions`
covers it for free (two different per-player caps at the same scope
still conflict).

`PARSER_PROMPT` rule 8 inverts: it currently says a per-player cap goes
to `unparsed` VERBATIM. It becomes a rule about which scope to choose,
and keeps its warning that a whole-run cap and a per-player cap are
different rules.

## Corpus re-baseline

`t01` and `t02` move from defer-all to compiled — announced in each
row's own `trap` field, per the standing rule. This is the third
re-baseline of this corpus; the pattern is deliberate and each one is
recorded where the label lives, not only in a commit message.

A NEW trap row should replace them: something that is still genuinely a
per-entity concept but out of vocabulary, e.g. "no player plays twice in
a row", so the deferral cohort does not shrink to the point where the
invented-rule metric stops biting.

## Test plan

1. **Engine unit** — a board with one entrant playing 3 times in a day
   fails an `every_entrant` cap of 2; 2 passes. Same for `every_person`
   across two divisions, which is the case an entrant-scoped cap misses.
2. **Engine golden** — additive corpus entry; per the standing rule the
   golden set is never re-baselined silently.
3. **Parser unit** — "no player plays more than 2 matches a day" →
   `every_person`; "each pair twice a day" → `every_entrant`; a whole-run
   cap still compiles to `competition`.
4. **Regression** — the rule-8 guard: a competition-scoped cap must NOT
   be produced for per-player wording, which is what the old prompt rule
   was protecting and is now protected by having a right answer instead.
5. **Bench** — re-run the 35-case corpus; `t01`/`t02` move from deferred
   to compiled without new inventions elsewhere.

## Implementation finding 2026-08-16 — it is a TALLY change, not a scope change

Investigated before starting, and it is bigger than approach A's
description implies.

Every existing `ConstraintScope` member answers one boolean question —
"does this rule bind this fixture?" — via `scopeCoversFixture`
(`calendar.ts:941`). A universal scope answers `true` for everything,
which looks trivial. It is not, because of what sits behind it:

```ts
// calendar.ts — one counter per RULE per DAY
const dayCounts = placementHard.map(() => new Map<string, number>());
```

A competition-scoped cap needs one counter per day. A per-person cap
needs one counter **per person per day**, and a single fixture
increments SEVERAL of them (both entrants, or every person on both
sides). So:

- the key becomes `${personKey}|${ymd}`, not `${ymd}`;
- the placement-time READ must ask "would any person in this fixture
  exceed their own count", not "would the day exceed its count";
- the commit-time WRITE must increment every covered entity, not one
  bucket.

`scopeCoversFixture` returning `true` is necessary and nowhere near
sufficient.

**The hazard this creates is the repo's known worst one.** The same
read/write pair exists twice — `calendar.ts` for the greedy placer and
verifier, `build-encode.ts` for CP-SAT — and a placer/verifier fork is
the recurring defect class here, which is why
`calendar-placer-verifier-parity.test.ts` and
`build-encode-parity.test.ts` both exist. Any implementation MUST
extend those parity suites first, before either tally is touched.

**Sequencing checked 2026-08-16, and it is clear:** open PR #576 (C5,
z3-ai-repair → CP-SAT) touches ZERO files under
`packages/engine/src/scheduling/`. `constraints.ts`, `calendar.ts` and
`build-encode.ts` are uncontested. C7 is the z3 public contract, not the
constraint enum, so the "engine enum" gate noted in the bench programme
does not apply to `ConstraintScope`.

**Correction, re-checked at implementation start 2026-08-16:** that
sequencing paragraph checked #576 only, and there are TWO open PRs. #583
(C9, decomposed repair on CP-SAT) *does* touch
`packages/engine/src/scheduling/` — five files:
`index.ts`, `repair-decompose.ts`, `repair-decompose-cpsat.ts` and their
two suites. The conclusion survives but for a narrower reason than
stated: the three files this spec rewrites — `constraints.ts`,
`calendar.ts`, `build-encode.ts` — are still uncontested by BOTH PRs. The
one shared file is the barrel `index.ts`, which C9 edits and which this
work touches only if the new scope needs a new export. Prefer widening
the existing `ConstraintScope` export over adding a barrel line, and if a
new export is unavoidable, expect a one-line rebase conflict against
whichever of the two lands first.

**Estimate:** this is a session of its own — engine union, two tally
implementations, two parity suites, golden corpus, then parser, prompt
and corpus re-baseline. Starting it inside a session that has already
shipped four other things is how a placer/verifier fork gets written.

## Pinned at implementation start 2026-08-16 — five findings, three of which correct this spec

Citations re-pinned against `main` at `a0cfb708`. The tally analysis above
holds exactly. Five things it did not know:

**1. The READ does not use the shared resolver, and the code comment says
it does.** `calendar.ts:516-518` introduces `dayCapRulesFor` as "One
resolution for the tally READ at placement time and the tally WRITE at
commit time — two scope walks is how a placer and a verifier fork in the
first place." The WRITE (`countDay`, :566) does call it. The READ
(`nextAcceptableStart`, :593-597) does **not** — it walks `placementHard`
with its own inline `scopeCoversFixture` call, because that loop also
serves `not_before` / `not_after` / the selector families. The two agree
today only because both happen to call the same predicate with the same
arguments. That is precisely the fork the comment claims was designed
away, sitting dormant behind a boolean that is currently symmetric.

It stops being dormant here. Under a universal scope the read and write
diverge in SHAPE, not just in predicate: the write increments N buckets
(one per person on the card), the read must test N buckets. An inline
walk that keeps returning one index will fork the moment the write
returns many. **So the first engine change is not the union — it is
routing the read through `dayCapRulesFor`, with a test pinning current
behaviour, so the widening has one resolver to widen instead of two.**

**2. `every_person` is inert unless callers populate `people`.**
`SchedulableFixture.people` is **optional** (`calendar.ts:82`), and
`scopeRowOf` (:486-488) fills `people: [...(f.people ?? [])]`. A fixture
whose caller omits `people` yields an empty list, `scopeCoversFixture`'s
`person` branch returns false, and a person-scoped cap silently binds
nothing. A universal `every_person` cap inherits that exactly: on a board
built without `people` it is a rule that reads back to the organiser as
enforced and enforces nothing. This is the repo's known "seam left for
later ships inert" class. The cap must not be shipped without either a
populated-`people` precondition asserted at build time or an explicit,
tested decision about what an empty `people` list means.

**3. `build-encode-parity.test.ts` is structurally blind to this
change.** Its guard is `ENCODED_RULE_TYPES` (:40-46), a whitelist keyed on
`HardConstraint["type"]`, and its own comment states its purpose: to make
"the NEXT unencoded **type** fail here rather than pass unnoticed". This
work adds no rule type — it widens `scope` on an existing one. The suite
will therefore stay green whether or not CP-SAT encodes `every_person`.
Extending it means adding a **scope axis**, not another row; a row is the
change that looks like coverage and is not.

The sibling suite has its own version of the same trap.
`calendar-placer-verifier-parity.test.ts` is table-driven (`FAMILIES`,
:60-75; `it.each` at :78) and takes a new row easily — but its `cards(n)`
helper (:33-39) gives **every** card `home: "e1"`, one shared entrant, and
its existing `max_fixtures_per_day` row is already scoped
`{kind:"entrant", entrantId:"e1"}`. On that fixture set a universal cap
and a named-`e1` cap are the same assertion, so an `every_entrant` row
added naively passes without ever distinguishing the new scope from the
old one. A universal-scope row needs a card set with **disjoint**
entrants, where a named-entrant cap does not bite and only a universal one
does. `cards()` also sets no `people` at all, which is finding 2 arriving
in the test fixtures: an `every_person` row against it is vacuous.

**4. There is no scheduling golden corpus, so test-plan item 2 has no
target.** All golden machinery under `packages/engine/src/testkit/` drives
the **sport-module scoring** corpus — eleven `*.golden.json` under
`src/sports/**`. Nothing under `scheduling/` participates, and no JSON
under `scheduling/` exists at all. Running `EXTEND_GOLDEN=1` here would
append to the scoring corpus and go green while saying nothing about a
constraint scope. Item 2 should be struck and its intent — a durable,
reviewable record of the new scope's behaviour — met by the parity suites
plus a checked-in scheduling fixture, or a scheduling golden corpus
should be created deliberately as its own piece of work.

**5. Blast radius is smaller than Risks states: `conflict-detail.ts` does
not read `scope`.** Its only `scope` occurrence is a comment on line 9.
The "reaches ... conflict details (25 kinds as of C3)" risk does not hold
as written; conflict detail is reached only if this work chooses to name
the offending person in a message, which is a separate, optional
improvement rather than forced fallout.

**6. The CP-SAT encoder does not merely need widening — a universal scope
compiles it into the exact bug rule 8 exists to prevent.**
`build-encode.ts:484-513` encodes the cap as a FIXTURE-SET problem, not an
entity problem: `scopedFixtures(h)` resolves the scope to a set of fixture
indices, the slots are grouped by `dayKeyInTz`, and each day gets one
clause capping how many of THAT DAY's slots the scoped fixtures may
occupy (`room = count - immovable`).

Point a universal scope at that and `scopedFixtures` returns **every**
fixture, so the clause becomes "at most `count` fixtures run on this day",
competition-wide. That is precisely the misreading `PARSER_PROMPT` rule 8
was written to stop — "a 60-player event capped at two matches daily" —
except reached through the encoder instead of the parser, on a board the
solver will then call OPTIMAL. The greedy placer would spread the cards
correctly and CP-SAT would refuse them, which is a placer/verifier fork
with the sign flipped.

The fix is not a wider `scopedFixtures`. The encoder needs one clause per
**(entity, day)** — for each person (or entrant) appearing on the board,
cap the slots of the fixtures that contain that entity on that day — which
is a different clause count and a different loop nest from what is there.
The comment at :477-483 anticipates a new rule TYPE being silently
mis-encoded and says the parity whitelist catches it; a new SCOPE is the
same hazard with no guard at all. Finding 3 is why this ships green.

**Unchanged and confirmed:** `ConstraintScope` is a
`z.discriminatedUnion("kind", …)` at `constraints.ts:30-37` with the five
members the spec lists, re-exported by `scheduling/index.ts:46` via
`export * from "./constraints.ts"` — so a new union member needs **no new
barrel line**, which removes the only file this work shared with PR #583.

## Risks

- **Widest blast radius of anything proposed this session.** A
  `ConstraintScope` member reaches the verifier, the CP-SAT encoder,
  conflict details (25 kinds as of C3), and the golden corpus.
- **Feasibility.** A per-person daily cap is a real tightening: a
  60-player one-day event with a cap of 2 may become infeasible, and
  that will surface as unschedulable fixtures rather than a friendly
  message. An assumption line should state the cap was applied before
  the organiser meets the failure.
- **Sequencing.** Release-2 C-work touches the conflict shape and the
  engine enum. This should follow, not race, whatever is in flight —
  check `docs/superpowers/specs/bench-product-value/_MASTER.md` before
  starting.
