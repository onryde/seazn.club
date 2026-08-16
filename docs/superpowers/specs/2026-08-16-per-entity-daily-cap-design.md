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
