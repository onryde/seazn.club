# Review: T4, commit afe7f02da (parent e5848d2f3), 2026-09-27

**Verdict: Approved.** Output identity holds everywhere I traced it. The
fan-out stays within the pool budget, and no `Promise.all` runs on a
transaction. The three Minors below do not block the merge. I did not run
the new suites because I had no database of my own.

## 1. Spec compliance

The change does what the brief says:

- The four division lanes, the getPublicFixture lanes, the publicFixture
  context and the loadMatchCentre reads now run in parallel.
- The lateral probe replaces the scalar subselects in data.ts, embed-data.ts
  and the match-centre feeder read.
- The poster uses `stageName` from getPublicFixture.
- me.ts reads `published` through the person's own entrants.
- The comment nit in competition-hub is fixed.

One deviation, which I rate harmless: the brief's "hoist the per-row
entitlement" premise was false. The calls were the view's own. The
implementer recorded this in the header of
`me-player-stats-published-identity.test.ts` rather than building on it.

## 2. Identity

**Lateral probes** (`data.ts:966-978`, `embed-data.ts:125-132`,
`match-centre-load.ts:370-380`):

- Each probe is `fixtures x where x.id = v.id`, where `id` is the primary
  key. It can return at most one row, so the old scalar subselect could
  never have raised, and `limit 1` is not needed.
- A `left join … on true` with zero rows gives NULL, the same as a scalar
  subselect with no row.
- Column names and object key order are unchanged in all three reads. The
  JSON-string identity checks would catch a key-order change.
- The feeder read has no ORDER BY, either before or after. The round namer
  keys by `round_no:seq_in_round` (`feeder-slot-label.ts:108`), so its
  output does not depend on row order.

**Config rows:**

- `readConfigRows` (`match-centre-load.ts:265-298`): each join from the
  one-row seed is on a primary key. A NULL `stage_id` matches nothing, which
  is `undefined`, the same as before.
- The prefetched rows in `public.ts:732-783` read the same `divisions.config`
  and `stages.config/kind` base columns that the loader read before, so the
  config resolver receives identical arguments. The fixture test pins this at
  `:595`.

**getPublicFixture:** the stage read now uses `fixtureRow.stage_id`. The
court-name step only adds names to the row, so this is the same value as the
old `fixture.stage_id`.

**me.ts** (`:337-364`): V418's `members[].person_id` is `p.id`, where `p`
comes from `entrant_members em join persons p on p.id = em.person_id` with
`merged_into is null`. So any entrant whose members carry the person must
have an `entrant_members` row for that person. The new EXISTS reads the
same view rows, with the same consent and profile-entitlement arms and the
same visibility filter. The private output is unchanged: the outer query is
untouched. The test's frozen copy matches e5848d2f3 exactly.

**Tie order:**

- The ORDER BY `(round_no, seq_in_round)` is identical before and after, and
  it never had a tiebreak.
- The claim that the old statement's tie order depends on the plan is
  well-founded:
  - An index walk returns equal keys in ctid order; the test pins this at
    `public-division-loaders-identity.test.ts:300`.
  - A sort returns them in the sort's permutation.
- Comparing ties as a set is therefore justified. See Minor 3 for what the UI
  does with that order.

## 3. Concurrency

No `Promise.all` runs on a transaction or a `withTenant` handle:

- Both `loadMatchCentre` callers (`data.ts:1194`, `public.ts:837`) pass the
  pooled `sql`.
- Every helper inside the loader uses the handle it is given.
- None of these loaders is reached from inside `sql.begin`.

Peak connections held per request:

| Path | Peak |
|---|---|
| Division read | 4 (1 with `sequential`) |
| getPublicFixture | 4, then 5 |
| publicFixture | 2, then 5 |
| Hub rebuild and page path | N divisions + 1 |
| poster.pdf, present | N |

A page whose `generateMetadata` and body both miss the data cache doubles
its peak. That double call existed before T4.

No lane holds a connection while it waits for another, so a saturated pool
of 12 queues requests rather than deadlocking. Every caller that fans out
per division passes `sequential`. I grepped every `getPublicDivision` caller
to confirm this. The division page, calendar and OG image each read a single
division.

## 4. Scope

- **present/page.tsx:** the change is necessary. It runs `Promise.all` over
  every division (`:66-74`), so without `sequential` the peak is 4N.
- **me.ts fences:** both are needed. Details under Minor 2.

## 5. Poster stage name

This is a non-issue:

- No write path changes `stages.name`. Every `update stages` in `server/`
  and `app/` sets only `config`, `status` or `required_court_tags`.
- Replacing the stage graph is refused once any stage owns fixtures.
- Every other line on the poster already came from the same `pub-fixture-v3`
  entry.
- The poster.png and OG routes already cache for 60 s.
- The poster now agrees with the match page.

## 6. Tests

- Every identity suite diffs the new code against frozen pre-T4 copies:
  - `readPublicDivisionDetailBefore`
  - `embedDivisionDataBefore`
  - `loadMatchCentreBefore`
  - `getPublicFixtureBodyBefore`
  - `publicFixtureBefore`
  - `loadMatchPosterModelBefore`
  - `listMyPlayerStatsBefore`
- I checked the frozen division and me.ts SQL against e5848d2f3.
- Premises guard every suite against a vacuous pass.
- **The scene contains the edge rows:**
  - winner and loser edges;
  - a final and a bronze match with no next fixture;
  - byes played as forfeits;
  - a withdrawn entrant;
  - a one-sided waiting seat;
  - a match in play and a finished match;
  - setup, youth and empty divisions;
  - cross-stage ties.
- The scene has no void events. That path is not changed, because the
  events query and `resolveVoids` are untouched.
- The fan-out bounds have teeth:
  - Removing `sequential` from the hub makes 4 divisions x 4 lanes = 16,
    well above the bound of 5.
  - The poster.pdf route test pins `{ sequential: true }`.
- `data-standings-timestamp.test.ts` now answers each query by the relation
  it reads, and throws on an unrecognised statement.
- The feeder-read regex normalises whitespace and keeps its positive pair
  (`:148`, `:167`).

## Minor issues

1. **present/page.tsx:68:** nothing tests `{ sequential: true }` here. It is
   the only per-division fan-out without a test, so deleting it stays green
   and the peak becomes 4N.
   - **Fix:** add a test for it, or give the hub, poster.pdf and present one
     shared "read every division" helper so the rule has a single home.

2. **usecases/me.ts:363 (the outer `offset 0`, mutant M1):** the fence is
   needed.
   - **Why:** Postgres will not simplify an EXISTS that has OFFSET
     (`simplify_EXISTS_query`), so no hashed alternative subplan can be
     built. Without the fence, the three correlations are all hashable
     equalities (`em.person_id`, `mine.division_id`, `m->>'person_id'`), so
     the hashed arm is available. That arm would build the view for every
     membership in the database.
   - **Why M1 survived:** the output is identical either way. With only six
     outer rows, the planner picks the per-row subplan, so the call-count
     test cannot see the difference.
   - **Fix:** record M1 in the test header as an equivalent-output survivor,
     citing that Postgres rule. Alternatively, pin it with an EXPLAIN on a
     scene big enough that the unfenced plan shows `hashed SubPlan`.

3. **lib/matches-hub.ts:188 with data.ts:978 and embed-data.ts:132:** this
   was already true before T4. `sortHubMatches` is stable, so for undated or
   same-time matches the hub list shows the database's tie order. That order
   depends on the plan. The test header records that the old and new
   statements already disagreed on a fuller database, so after deploy a
   league R1M1 and a knockout R1M1 could swap places in the list.
   - **Fix (follow-up, owner call, since it defines an order that never
     existed):** add a stage-sequence tiebreak to the three fixture reads.

---

# Re-review: fix commit 268615f5c (on afe7f02da), 2026-09-27

**Verdict: Approved.** All three T4 minors are closed. No new issue.

## Minor 1: the shared every-division read

- `read-every-division.ts:33-46` is now the only way to read more than one
  division. It always passes `{ sequential: true }`, on both the cached and
  the uncached arm.
- Its three callers are:
  - the hub (`competition-hub.ts:630`, which passes `{ uncached }`, so both
    the Redis rebuild and the ISR page path go through it);
  - poster.pdf;
  - present.
- It sits in its own module on purpose, so the existing poster.pdf route
  test, which mocks `getPublicDivision`, still sees
  `{ sequential: true }`.
- The concurrency test (`public-division-loaders-identity.test.ts:404-424`)
  has a positive pair:
  - `peak > 1` fails if the helper serialises the divisions;
  - `peak <= N+1` fails if `sequential` is dropped (16) or dropped for just
    one division (7 against a bound of 5);
  - `toStrictEqual(oneByOne)` pins that each division's result is the same
    as reading it on its own.

## Minor 3: the fixture tiebreak

`data.ts:979-981` and `embed-data.ts:133-135` now add
`left join stages st on st.id = v.stage_id` and order by
`round_no, seq_in_round, st.seq, v.id`.

- **A null stage cannot happen.** `fixtures.stage_id` is `uuid not null`
  (`V214__fixtures.sql:6`), and `stages.id` is the primary key, so the join
  always matches exactly one row. It never adds rows and never drops one. A
  plain `join` would behave identically.
- **The order is stable.** `v.id` is unique, so the order is total no matter
  which plan runs.
- **Two pools' round 1 match 1 in one stage.** These sort by id, which is
  stable but arbitrary. Pool key would read more naturally, but determinism
  is what this fix is for. Cosmetic.
- **Test teeth:** `public-division-fixture-order.test.ts` has a premise
  (`:127-148`, run on three plans) that the old two-key ORDER BY leaves the
  scene out of order. It then checks each key:
  - Dropping `st.seq` puts the knockout fixture with the lowest id first.
  - Dropping `v.id` puts the six pools, inserted in descending id order, out
    of order.
- **Surfaces covered:** the order is checked through
  `readPublicDivisionDetail` (concurrent and sequential), `getPublicDivision`,
  the embed, and the hub list on both the rebuild and the page path.
- **Identity suites:** they now compare exact order against the frozen
  pre-T4 rows, sorted by the full key.

## Minor 2: the M1 note

`me-player-stats-published-identity.test.ts:24-37` records why the outer
`offset 0` stays and why no test can witness it: Postgres will not simplify
an EXISTS that has an OFFSET, and with six outer rows the planner picks the
per-row plan anyway. This is accurate.
