# Per-entity daily cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "no player plays more than 2 matches a day" a rule the engine
enforces, by adding universal `every_entrant` / `every_person` scopes to
`ConstraintScope` and re-shaping both `max_fixtures_per_day` tallies from
one-counter-per-rule-per-day to one-counter-per-entity-per-day.

**Architecture:** Approach A from the spec — a new `ConstraintScope` member
rather than N expanded per-id constraints. The change is a TALLY-SHAPE change,
not a scope change: `scopeCoversFixture` returning `true` is necessary and
nowhere near sufficient. The same read/write pair exists twice
(`calendar.ts` for the greedy placer and verifier, `build-encode.ts` for
CP-SAT), and a placer/verifier fork is this repo's recurring defect class.
Both parity suites are therefore given discriminating power BEFORE either
tally is touched, and the greedy read is routed through the existing shared
resolver BEFORE the union is widened.

**Tech Stack:** TypeScript 7, Node 26, pnpm, vitest, zod (`z.discriminatedUnion`),
z3-solver / CP-SAT via `build-encode.ts`, Playwright for e2e.

**Spec:** `docs/superpowers/specs/2026-08-16-per-entity-daily-cap-design.md`
— read it in full, including the "Pinned at implementation start 2026-08-16"
section, which corrects three claims made earlier in the same document.

## Global Constraints

- Worktree: `/Users/ashokhein/github/seazn.club/.claude/worktrees/daily-cap`,
  branch `feat/per-entity-daily-cap`, based on `main` at `a0cfb708`.
  **Prefix `cd <abs worktree> &&` in the SAME call as every command you
  judge** — the shell cwd resets to the main checkout between tool calls and
  a verify run then silently executes on `main`.
- **Never `git stash` in this worktree** — the stash stack is shared with the
  main checkout.
- Judge vitest ONLY from `--reporter=json --outputFile`, reading
  `numPassedTests` / `numTotalTests` / `numFailedTestSuites`, and confirm
  `.testResults[].name` entries resolve under the worktree path. `rtk` prints
  `PASS(0) FAIL(0)` for a suite that failed to COLLECT and swallows exit codes.
- Capture exit codes with a redirect, never a pipe:
  `cmd > out.txt 2>&1; echo "EXIT=$?"; tail -3 out.txt`.
- `grep` reports source files here as `Binary file … matches`. Always `-a`.
- Every change ships a test that fails without it.
- All four test types are owed per RULES.md: unit, E2E (Playwright), smoke
  (`scripts/smoke.ts`), regression. A backend change still owes an E2E — trace
  forward to the real user-facing flow.
- Any new or changed user-facing string → all 4 locale dictionaries, never
  hardcoded English. `content/help/**` is the exception (one English tree).
  Note `NO server-side i18n` — every `HttpError` message is English by design.
- Do NOT add a line to `packages/engine/src/scheduling/index.ts`. It re-exports
  via `export * from "./constraints.ts"` (`:46`), so a new union member needs
  no barrel change — and that file is the only one this work would otherwise
  share with open PR #583.
- Do NOT touch `repair-decompose.ts`, `repair-decompose-cpsat.ts`, or
  `scheduling/index.ts` — all three are owned by open PR #583.
- Do NOT run `UPDATE_GOLDEN=1`. There is no scheduling golden corpus; the
  golden machinery drives the sport-module scoring corpus only.
- Before every commit: `npm run openapi:gen && git status --porcelain` must be
  empty after.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/engine/src/scheduling/calendar.ts` | greedy placer + verifier tally; `ConstraintScope` predicate | 1, 3, 5 |
| `packages/engine/src/scheduling/calendar-placer-verifier-parity.test.ts` | proves placer output satisfies verifier, per rule family | 2, 3 |
| `packages/engine/src/scheduling/constraints.ts` | `ConstraintScope` zod union (`:30-37`) | 3 |
| `packages/engine/src/scheduling/build-encode.ts` | CP-SAT/Z3 encoding of the cap (`:484-513`) | 4 |
| `packages/engine/src/scheduling/build-encode-parity.test.ts` | proves every encodable rule IS encoded | 2, 4 |
| `apps/web/src/server/usecases/schedule-ai-parse.ts` | `PARSER_PROMPT` (`:156`), rule 8 (`:232-237`) | 6 |
| `apps/web/src/server/usecases/__tests__/fixtures/parse-corpus.json` | parse corpus, rows `t01` (`:294`) / `t02` (`:301`) | 6 |
| `apps/web/e2e/` | Playwright coverage of the organiser flow | 7 |

---

### Task 1: Route the placement-time tally read through the shared resolver

The WRITE (`countDay`, `calendar.ts:566`) calls `dayCapRulesFor`. The READ
(`nextAcceptableStart`, `:593-597`) does not — it walks `placementHard` with
its own inline `scopeCoversFixture` call. The helper's own comment
(`:516-518`) claims it is the single resolution shared by both. Make that
true before widening anything, so there is ONE resolver to widen instead of
two. Pure refactor: no behaviour change, no union change.

**Files:**
- Modify: `packages/engine/src/scheduling/calendar.ts:585-598`
- Test: `packages/engine/src/scheduling/calendar-placer-verifier-parity.test.ts`

**Interfaces:**
- Consumes: `dayCapRulesFor(row: ScopeRow, rf: RuleFixture | undefined): number[]`
  (`calendar.ts:519`), already in scope inside `slotFixtures`.
- Produces: nothing new. Task 3 relies on `dayCapRulesFor` being the ONLY
  place a `max_fixtures_per_day` scope walk happens on the greedy side.

- [ ] **Step 1: Write the failing test**

Append to `calendar-placer-verifier-parity.test.ts`. This case has two
`max_fixtures_per_day` rules whose scopes differ, so a read that resolves
scope on its own index can bind the wrong counter:

```ts
describe("the day-cap read and write resolve the same rules (#585 follow-up)", () => {
  it("honours two differently-scoped day caps at once", () => {
    // e1 is on every card; e2 only on f1 and f2. A cap of 1 on e2 and a cap
    // of 3 on e1 must BOTH hold. A read that walks placementHard with its own
    // scope test still works here; a read that indexes the wrong counter does
    // not, which is what this pins before the resolver is widened.
    const fixtures: SchedulableFixture[] = [
      { id: "f1", home: "e1", away: "e2", divisionId: "d1" },
      { id: "f2", home: "e1", away: "e2", divisionId: "d1" },
      { id: "f3", home: "e1", away: "e3", divisionId: "d1" },
      { id: "f4", home: "e1", away: "e4", divisionId: "d1" },
    ];
    const config = {
      startAt: SAT_1000_LOCAL,
      matchMinutes: 30,
      gapMinutes: 0,
      perEntrantMinRest: 0,
      courts: ["C1", "C2"],
      blackouts: [],
      sessionWindows: [],
      tz: TZ,
      horizonMinutes: 60 * 24 * 21,
      ruleFixtures: fixtures.map((f) => ({
        id: f.id,
        extKey: f.id,
        divisionId: "d1",
        winnerTo: null,
      })),
      constraints: SchedulingConstraints.parse({
        hard: [
          { type: "max_fixtures_per_day", count: 1, scope: { kind: "entrant", entrantId: "e2" } },
          { type: "max_fixtures_per_day", count: 3, scope: { kind: "entrant", entrantId: "e1" } },
        ],
      }),
    };

    const { assignments, conflicts } = slotFixtures({ fixtures, config });
    expect(assignments).toHaveLength(4);
    expect(conflicts.filter((c) => c.reason === "no_slot")).toEqual([]);
    expect(
      validateAssignments(assignments, config)
        .filter((c) => c.reason === "instruction")
        .map((c) => c.details),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it passes BEFORE the refactor**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/daily-cap && \
  npx vitest run packages/engine/src/scheduling/calendar-placer-verifier-parity.test.ts \
  --reporter=json --outputFile=/tmp/t1a.json > /tmp/t1a.log 2>&1; echo "EXIT=$?"
```

Expected: PASS. This is a **characterisation** test, not a red-first test —
it pins behaviour that must survive a refactor. Record
`numPassedTests` / `numTotalTests` from `/tmp/t1a.json`; the same numbers must
hold in Step 4.

- [ ] **Step 3: Make the read call the shared resolver**

In `calendar.ts`, replace the day-cap branch inside `nextAcceptableStart`
(`:593-598`). The loop still walks `placementHard` for the wall-clock and
selector families; only the day-cap arm moves to the resolver:

```ts
    let bound = start;
    // ONE resolution, shared with the commit-time write in `countDay` — the
    // invariant `dayCapRulesFor` was introduced for. The wall-clock and
    // selector families keep their own walk below because they are not
    // tallied; only the cap has a counter that can be indexed wrongly.
    for (const i of dayCapRulesFor(row, rf)) {
      const h = placementHard[i] as Extract<HardConstraint, { type: "max_fixtures_per_day" }>;
      if ((dayCounts[i]!.get(day) ?? 0) >= h.count) {
        bound = Math.max(bound, dayStart(ymdAddDays(day, 1)));
      }
    }
    for (let i = 0; i < placementHard.length; i++) {
      const h = placementHard[i]!;
      if (!scopeCoversFixture(h.scope, rf, row)) continue;
```

and DELETE the now-duplicated arm from that second loop:

```ts
      if (h.type === "max_fixtures_per_day") {
        if ((dayCounts[i]!.get(day) ?? 0) >= h.count) bound = Math.max(bound, dayStart(ymdAddDays(day, 1)));
      }
```

- [ ] **Step 4: Run the full scheduling suite and confirm no behaviour moved**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/daily-cap && \
  npx vitest run packages/engine/src/scheduling \
  --reporter=json --outputFile=/tmp/t1b.json > /tmp/t1b.log 2>&1; echo "EXIT=$?"
```

Expected: `numFailedTests: 0`, `numFailedTestSuites: 0`, and
`numTotalTests` **unchanged** from a pre-refactor baseline run of the same
command. A DROP in `numTotalTests` means a suite failed to collect — that is
not green.

- [ ] **Step 5: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/daily-cap && \
  git add packages/engine/src/scheduling/calendar.ts \
          packages/engine/src/scheduling/calendar-placer-verifier-parity.test.ts && \
  git commit -m "refactor(scheduling): resolve the day-cap read through dayCapRulesFor

The helper's comment says it is the single resolution shared by the
placement-time read and the commit-time write. The write called it; the
read walked placementHard itself. They agreed only because the scope
predicate is symmetric, which stops being true under a universal scope."
```

---

### Task 2: Give both parity suites discriminating power, using existing scopes only

The user's instruction is to extend both parity suites before touching either
tally. Neither suite can NAME a universal scope before Task 3 creates it, so
what is extended here is the suites' ability to TELL SCOPES APART — proven
with the scopes that exist today. Without this, Task 3's rows pass vacuously:

- `calendar-placer-verifier-parity.test.ts`'s `cards(n)` helper (`:33-39`)
  gives every card `home: "e1"`, and its existing cap row is already scoped to
  `e1`. On that fixture set a universal cap and a named-`e1` cap are the same
  assertion. It also sets no `people` at all, so any person-scoped row is
  vacuous.
- `build-encode-parity.test.ts` guards on `ENCODED_RULE_TYPES` (`:40-46`), a
  whitelist keyed on `HardConstraint["type"]`. This work adds no type, so that
  guard is structurally blind to it.

**Files:**
- Modify: `packages/engine/src/scheduling/calendar-placer-verifier-parity.test.ts:33-44`
- Modify: `packages/engine/src/scheduling/build-encode-parity.test.ts:40-46`

**Interfaces:**
- Produces, for Task 3 and Task 4:
  - `disjointCards(n: number): SchedulableFixture[]` — n cards, no shared
    entrant, each carrying `people`.
  - `ENCODED_SCOPE_KINDS: ReadonlySet<ConstraintScope["kind"]>` — the scope
    axis the encoder states, mirroring `ENCODED_RULE_TYPES`.

- [ ] **Step 1: Add the disjoint fixture helper**

In `calendar-placer-verifier-parity.test.ts`, beside `cards`:

```ts
// `cards()` deliberately shares one entrant so the rule under test is the
// only thing that can move a card. That makes it USELESS for telling a
// universal scope from a named one: with every card on `e1`, a cap scoped to
// `e1` and a cap scoped to "every entrant" are the same assertion. These
// cards share nothing, so a named-entrant cap binds exactly one of them and
// only a universal cap binds them all.
const disjointCards = (n: number): SchedulableFixture[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `g${i + 1}`,
    home: `h${i + 1}`,
    away: `a${i + 1}`,
    divisionId: "d1",
    // `SchedulableFixture.people` is OPTIONAL (calendar.ts:82) and
    // `scopeRowOf` fills `people: [...(f.people ?? [])]`. Omitting it makes
    // every person-scoped rule silently bind nothing, so a person case built
    // on a helper that forgets this passes while asserting nothing.
    people: [`p-h${i + 1}`, `p-a${i + 1}`],
  }));

const disjointRuleFixtures = (n: number): RuleFixture[] =>
  disjointCards(n).map((f) => ({ id: f.id, extKey: f.id, divisionId: "d1", winnerTo: null }));
```

- [ ] **Step 2: Add the discrimination test that proves the helper bites**

```ts
describe("the parity harness can tell scopes apart", () => {
  // Guards Task 3's rows. If this ever fails, a universal-scope row added
  // later is measuring the shared-entrant helper, not the new scope.
  it("a named-entrant cap on disjoint cards binds one card, not the set", () => {
    const n = 6;
    const fixtures = disjointCards(n);
    const config = {
      startAt: SAT_1000_LOCAL,
      matchMinutes: 30,
      gapMinutes: 0,
      perEntrantMinRest: 0,
      courts: ["C1", "C2"],
      blackouts: [],
      sessionWindows: [],
      tz: TZ,
      horizonMinutes: 60 * 24 * 21,
      ruleFixtures: disjointRuleFixtures(n),
      constraints: SchedulingConstraints.parse({
        hard: [{ type: "max_fixtures_per_day", count: 1, scope: { kind: "entrant", entrantId: "h1" } }],
      }),
    };

    const { assignments, conflicts } = slotFixtures({ fixtures, config });
    expect(assignments).toHaveLength(n);
    expect(conflicts.filter((c) => c.reason === "no_slot")).toEqual([]);

    // THE DISCRIMINATING ASSERTION. `h1` appears on one card, so a cap of 1
    // scoped to `h1` costs nothing and all six cards fit on day one. If this
    // ever reads as more than one day, the scope is being ignored and every
    // universal-scope assertion built on this helper is worthless.
    const days = new Set(assignments.map((a) => dayKeyInTz(a.startAt, TZ)));
    expect(days.size).toBe(1);

    expect(
      validateAssignments(assignments, config)
        .filter((c) => c.reason === "instruction")
        .map((c) => c.details),
    ).toEqual([]);
  });
});
```

Import `dayKeyInTz` from wherever `calendar.ts` sources it — check the
existing import list in `calendar.ts` and re-use the same module specifier.

- [ ] **Step 3: Add the scope axis to the CP-SAT parity guard**

In `build-encode-parity.test.ts`, beside `ENCODED_RULE_TYPES`:

```ts
/** The scope kinds `encodeBuild` states. A WHITELIST for the same reason as
 *  `ENCODED_RULE_TYPES`, and added because that Set could not see this class
 *  of change at all: it keys on `HardConstraint["type"]`, so widening the
 *  SCOPE of a type already on the list passes it unnoticed. The encoder
 *  resolves a scope to a FIXTURE SET (`scopedFixtures`, build-encode.ts:419),
 *  which is the wrong shape for a per-entity cap — a universal scope resolves
 *  to every fixture and silently encodes a competition-wide cap. This Set is
 *  what makes the NEXT unencoded scope fail here. */
const ENCODED_SCOPE_KINDS: ReadonlySet<ConstraintScope["kind"]> = new Set([
  "competition",
  "division",
  "entrant",
  "person",
  "pool",
]);
```

Add the import: `import type { ConstraintScope } from "./constraints.ts";`
(the file already imports `HardConstraint` / `SchedulingConstraints` from
there — extend that import rather than adding a second line).

- [ ] **Step 4: Add the exhaustiveness test for the new axis**

Mirror whatever shape the existing `ENCODED_RULE_TYPES` exhaustiveness check
uses in this file — read it first and match it. If none exists, add:

```ts
it("every ConstraintScope member is either encoded or explicitly unencoded", () => {
  // `ConstraintScope` is a z.discriminatedUnion (constraints.ts:30-37); its
  // options are enumerable, so this cannot drift the way a hand-written list
  // does. A member added without a decision fails HERE rather than being
  // encoded as whatever `scopedFixtures` happens to return for it.
  const declared = ConstraintScope.options.map((o) => o.shape.kind.value as ConstraintScope["kind"]);
  expect([...declared].sort()).toEqual([...ENCODED_SCOPE_KINDS].sort());
});
```

Import the VALUE `ConstraintScope` (not just the type) for `.options`.

- [ ] **Step 5: Run both suites**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/daily-cap && \
  npx vitest run \
    packages/engine/src/scheduling/calendar-placer-verifier-parity.test.ts \
    packages/engine/src/scheduling/build-encode-parity.test.ts \
  --reporter=json --outputFile=/tmp/t2.json > /tmp/t2.log 2>&1; echo "EXIT=$?"
```

Expected: all PASS. `numTotalTests` must have GONE UP by exactly the number
of cases added — if it did not move, the new `describe` is not being
collected.

- [ ] **Step 6: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/daily-cap && \
  git add packages/engine/src/scheduling/calendar-placer-verifier-parity.test.ts \
          packages/engine/src/scheduling/build-encode-parity.test.ts && \
  git commit -m "test(scheduling): give both parity suites a scope axis

Neither suite could see a scope widening. The calendar suite's card helper
puts every card on one entrant, so a universal cap and a named cap are the
same assertion; the CP-SAT suite whitelists rule TYPES, and this change adds
none. Both now discriminate, proven against the scopes that exist today."
```

---

### Task 3: Add `every_entrant` / `every_person` and re-shape the greedy tally

**Files:**
- Modify: `packages/engine/src/scheduling/constraints.ts:30-37`
- Modify: `packages/engine/src/scheduling/calendar.ts` — `scopeCoversFixture` (`:941`), `dayCounts` (`:512`), `dayCapRulesFor` (`:519`), `countDay` (`:563`), the read from Task 1
- Test: `packages/engine/src/scheduling/calendar-placer-verifier-parity.test.ts`

**Interfaces:**
- Consumes: `disjointCards` / `disjointRuleFixtures` from Task 2.
- Produces: `ConstraintScope` members `{kind:"every_entrant"}` and
  `{kind:"every_person"}`; a `dayCounts` keyed `${entityKey}|${ymd}`.

- [ ] **Step 1: Write the failing test**

First add one config helper beside `configFor` (`:46-58`), so the three cases
below share it instead of repeating a twelve-field literal. `configFor` binds
its fixtures via `ruleFixturesFor(n)`, which assumes the shared-entrant
`cards` set; this one takes the fixtures it is given:

```ts
// `configFor` derives its ruleFixtures from `cards(n)`. These cases supply
// their own boards — disjoint entrants, or two divisions — so the rule
// fixtures have to be derived from THOSE, or every selector-resolved rule
// silently names nothing.
const configOver = (rule: HardConstraint, fixtures: SchedulableFixture[], startAt: number) => ({
  startAt,
  matchMinutes: 30,
  gapMinutes: 0,
  perEntrantMinRest: 0,
  courts: ["C1", "C2"],
  blackouts: [],
  sessionWindows: [],
  tz: TZ,
  horizonMinutes: 60 * 24 * 21,
  ruleFixtures: fixtures.map((f) => ({
    id: f.id,
    extKey: f.id,
    divisionId: f.divisionId,
    winnerTo: null,
  })),
  constraints: SchedulingConstraints.parse({ hard: [rule] }),
});
```

Use it in Task 2 Step 2's case as well, replacing the inline literal there.

```ts
describe("universal daily caps (per-entity tally)", () => {
  it("every_entrant caps each entrant's own day, not the day's total", () => {
    // Six cards, no shared entrant, cap of 2 per entrant. Every entrant is on
    // exactly ONE card, so a correct per-entity cap costs nothing and all six
    // fit on day one. A tally that keeps counting per RULE per DAY reads this
    // as "at most 2 fixtures a day" and spreads them over three days — the
    // 60-player-event bug PARSER_PROMPT rule 8 exists to prevent.
    const n = 6;
    const fixtures = disjointCards(n);
    const config = configOver(
      { type: "max_fixtures_per_day", count: 2, scope: { kind: "every_entrant" } },
      fixtures,
      SAT_1000_LOCAL,
    );

    const { assignments, conflicts } = slotFixtures({ fixtures, config });
    expect(assignments).toHaveLength(n);
    expect(conflicts.filter((c) => c.reason === "no_slot")).toEqual([]);
    expect(new Set(assignments.map((a) => dayKeyInTz(a.startAt, TZ))).size).toBe(1);
    expect(
      validateAssignments(assignments, config)
        .filter((c) => c.reason === "instruction")
        .map((c) => c.details),
    ).toEqual([]);
  });

  it("every_entrant does bite the entrant who is over", () => {
    // Six cards all on `e1` (the SHARED helper, deliberately) capped at 2:
    // three days. This is the direction the old tally already got right, and
    // it must not regress while making the previous case pass.
    const n = 6;
    const config = configFor(
      { type: "max_fixtures_per_day", count: 2, scope: { kind: "every_entrant" } },
      n,
      SAT_1000_LOCAL,
    );
    const { assignments } = slotFixtures({ fixtures: cards(n), config });
    expect(assignments).toHaveLength(n);
    expect(new Set(assignments.map((a) => dayKeyInTz(a.startAt, TZ))).size).toBe(3);
    expect(
      validateAssignments(assignments, config).filter((c) => c.reason === "instruction"),
    ).toEqual([]);
  });

  it("every_person catches the player entered in two divisions", () => {
    // THE case an entrant-scoped cap misses, and the spec's stated reason for
    // having a person scope at all. `pX` plays for entrant `s1` in d1 and for
    // entrant `m1` in d2 — two entrants, one human. A cap of 2 per PERSON must
    // spread four cards over two days; a cap of 2 per ENTRANT would not.
    const fixtures: SchedulableFixture[] = [
      { id: "x1", home: "s1", away: "s9", divisionId: "d1", people: ["pX", "p9"] },
      { id: "x2", home: "s1", away: "s8", divisionId: "d1", people: ["pX", "p8"] },
      { id: "x3", home: "m1", away: "m9", divisionId: "d2", people: ["pX", "q9"] },
      { id: "x4", home: "m1", away: "m8", divisionId: "d2", people: ["pX", "q8"] },
    ];
    const config = configOver(
      { type: "max_fixtures_per_day", count: 2, scope: { kind: "every_person" } },
      fixtures,
      SAT_1000_LOCAL,
    );

    const { assignments, conflicts } = slotFixtures({ fixtures, config });
    expect(assignments).toHaveLength(4);
    expect(conflicts.filter((c) => c.reason === "no_slot")).toEqual([]);
    expect(new Set(assignments.map((a) => dayKeyInTz(a.startAt, TZ))).size).toBe(2);
    expect(
      validateAssignments(assignments, config).filter((c) => c.reason === "instruction"),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and confirm it fails for the RIGHT reason**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/daily-cap && \
  npx vitest run packages/engine/src/scheduling/calendar-placer-verifier-parity.test.ts \
  --reporter=json --outputFile=/tmp/t3a.json > /tmp/t3a.log 2>&1; echo "EXIT=$?"
```

Expected: FAIL, and specifically a **zod parse error** from
`SchedulingConstraints.parse` — `every_entrant` is not yet a union member. A
failure anywhere else means the test is wrong, not the code.

- [ ] **Step 3: Widen the union**

`constraints.ts:30-37`:

```ts
export const ConstraintScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("competition") }),
  z.object({ kind: z.literal("division"), divisionId: z.string().min(1) }),
  z.object({ kind: z.literal("entrant"), entrantId: z.string().min(1) }),
  z.object({ kind: z.literal("person"), personKey: z.string().min(1) }),
  z.object({ kind: z.literal("pool"), divisionId: z.string().min(1), pool: z.string().min(1) }),
  // UNIVERSAL scopes. These carry no id, which is the point: they say "every
  // one of these, each counted separately", not "all of them together". A
  // rule wearing one is NOT a competition-scoped rule with a wider net — see
  // the tally in calendar.ts, which keys per ENTITY per day for these and per
  // day alone for the rest. Reading them as competition-scoped is the
  // 60-player-event bug PARSER_PROMPT rule 8 was written to prevent.
  z.object({ kind: z.literal("every_entrant") }),
  z.object({ kind: z.literal("every_person") }),
]);
```

- [ ] **Step 4: Re-run and confirm the failure MOVED**

Same command as Step 2. Expected: the zod error is gone; the
`every_entrant`-on-disjoint-cards case now fails on
`expect(days.size).toBe(1)` receiving `3`. That is the tally bug, and it is
the failure this task exists to fix. Paste the actual received value.

- [ ] **Step 5: Make `scopeCoversFixture` total**

`calendar.ts:941` — add the two arms. The function stays a pure predicate;
all the shape work is in the tally:

```ts
    case "every_entrant":
    case "every_person":
      // Universal scopes bind every fixture. The PER-ENTITY distinction is
      // made by the tally key, not here — see `entityKeysFor`. A caller that
      // treats this `true` as sufficient has written a competition-wide cap.
      return true;
```

- [ ] **Step 6: Re-key the tally per entity**

In `slotFixtures`, replace the `dayCounts` declaration (`:509-512`) and add an
entity-key resolver:

```ts
  /** Per-RULE tallies for `max_fixtures_per_day`, index-aligned with
   *  `placementHard`. The KEY is `${entityKey}|${ymd}`, not `${ymd}`: a
   *  universal scope needs one counter per entity per day, and a single
   *  fixture increments several of them (both entrants, or every person on
   *  both sides). Non-universal scopes use the sentinel entity key `*`, which
   *  restores the old one-counter-per-day behaviour exactly. */
  const dayCounts = placementHard.map(() => new Map<string, number>());
```

and add `entityKeysFor` at **module scope**, beside `scopeCoversFixture`
(`:941`) — NOT inside `slotFixtures`. It is consumed by the verifier
(Step 7) and by `build-encode.ts` (Task 4), and a second copy is precisely
the fork this task is arranged to prevent:

```ts
/** The entities a `max_fixtures_per_day` rule counts a row against. One
 *  element — the sentinel `*` — for every scope that NAMES its subject, which
 *  reproduces the old one-counter-per-day behaviour exactly; N elements for a
 *  universal scope, because there the cap is a statement about each entity
 *  separately and one fixture increments several counters.
 *
 *  Exported, and the only implementation, because the greedy placer, the
 *  verifier and the CP-SAT encoder must key their tallies identically. Two
 *  copies of this function is how a placer and a verifier fork. */
export function entityKeysFor(scope: ConstraintScope, row: ScopeRow): readonly string[] {
  switch (scope.kind) {
    case "every_entrant":
      return row.entrants;
    case "every_person":
      return row.people;
    default:
      return ["*"];
  }
}
```

Take `scope` rather than the whole `HardConstraint`: `build-encode.ts` calls
it against `existing` rows where only the scope is to hand, and a narrower
parameter is one fewer way for the two call sites to drift. Update the calls
below to pass `placementHard[i]!.scope`.

Then the WRITE (`countDay`, `:563-567`):

```ts
  const countDay = (row: ScopeRow, rf: RuleFixture | undefined, startAt: number): void => {
    if (tz === undefined) return;
    const day = dayKeyInTz(startAt, tz);
    for (const i of dayCapRulesFor(row, rf)) {
      for (const key of entityKeysFor(placementHard[i]!.scope, row)) {
        const k = `${key}|${day}`;
        dayCounts[i]!.set(k, (dayCounts[i]!.get(k) ?? 0) + 1);
      }
    }
  };
```

And the READ, which Task 1 routed through `dayCapRulesFor` — it must now ask
whether ANY covered entity is at its limit:

```ts
    for (const i of dayCapRulesFor(row, rf)) {
      const h = placementHard[i] as Extract<HardConstraint, { type: "max_fixtures_per_day" }>;
      // ANY entity at its limit pushes the card, because the cap is a
      // statement about each of them separately.
      const full = entityKeysFor(h.scope, row).some((key) => (dayCounts[i]!.get(`${key}|${day}`) ?? 0) >= h.count);
      if (full) bound = Math.max(bound, dayStart(ymdAddDays(day, 1)));
    }
```

- [ ] **Step 7: Mirror the shape in the verifier**

`validateInstructionRules` (`calendar.ts` around `:1047-1063`) has its OWN
tally for the same rule — read it, and apply the identical
`entityKeysFor` / `${key}|${ymd}` treatment. **Call the module-scope
`entityKeysFor` from Step 6 — do not write a second one here.** Two
implementations of this resolver IS the placer/verifier fork this whole task
is arranged around, and it would be invisible: both copies would be correct
on the day they were written and drift on the day one of them was edited.
The Task 2 parity suite is the only thing that would ever catch it.

- [ ] **Step 8: Run the parity suite, then the whole scheduling tree**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/daily-cap && \
  npx vitest run packages/engine/src/scheduling \
  --reporter=json --outputFile=/tmp/t3b.json > /tmp/t3b.log 2>&1; echo "EXIT=$?"
```

Expected: `numFailedTests: 0`. Confirm `numTotalTests` is the Task 2 figure
plus the three new cases.

- [ ] **Step 9: Run the engine's own gate**

`vitest run` is NOT the engine CI gate — the engine has a coverage threshold
(core 100%) and its own lint task that root lint skips:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/daily-cap/packages/engine && \
  npm run test > /tmp/t3c.log 2>&1; echo "TEST_EXIT=$?" && \
  npm run lint > /tmp/t3d.log 2>&1; echo "LINT_EXIT=$?"; \
  grep -E "✖|problems|Coverage|threshold" /tmp/t3c.log /tmp/t3d.log | head -20
```

Both must exit 0. Read lint from the `✖ N problems` line — `rtk` hides this
output entirely and "ESLint output (JSON parse failed)" is the wrapper losing
the result, not a clean run.

- [ ] **Step 10: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/daily-cap && \
  git add packages/engine/src/scheduling/constraints.ts \
          packages/engine/src/scheduling/calendar.ts \
          packages/engine/src/scheduling/calendar-placer-verifier-parity.test.ts && \
  git commit -m "feat(scheduling): every_entrant and every_person daily caps

The engine could say 'entrant X plays at most 2 a day' and could not say
'every entrant plays at most 2 a day'. Adds both universal scopes and
re-keys the greedy tally from one counter per rule per day to one per
entity per day, so a single fixture increments every entity it contains."
```

---

### Task 4: Encode the per-entity cap in CP-SAT

`build-encode.ts:484-513` encodes the cap as a FIXTURE-SET problem:
`scopedFixtures(h)` resolves the scope to fixture indices, slots group by
`dayKeyInTz`, and each day gets one clause capping how many of that day's
slots the scoped fixtures occupy. A universal scope makes `scopedFixtures`
return every fixture, so the clause becomes "at most `count` fixtures run on
this day", competition-wide — the exact bug rule 8 exists to prevent, reached
through the encoder, on a board the solver then reports OPTIMAL. The greedy
placer (Task 3) would spread the cards correctly and CP-SAT would refuse
them: a placer/verifier fork with the sign flipped.

**Files:**
- Modify: `packages/engine/src/scheduling/build-encode.ts:484-513`
- Test: `packages/engine/src/scheduling/build-encode-parity.test.ts`

**Interfaces:**
- Consumes: `ENCODED_SCOPE_KINDS` (Task 2), `entityKeysFor` exported from
  `calendar.ts` (Task 3 Step 7) — reuse it; do not write a second resolver.

- [ ] **Step 1: Write the failing test**

This file's cases do NOT hand-count days. They call `assertParity({cfg,
fixtures, existing})`, which enumerates every placement the lattice can
express (`placements`, `:85-100`) and asserts the encoder accepts one **iff**
`validateAssignments` does. That is exactly the fork this task risks, so use
it — a hand-rolled day count would assert less and could pass while the two
sides disagree on a placement the count never visits.

Use the file's own helpers: `fx(id, home, away, people = [], over = {})`
(`:76-82`), `config(over)` (`:~50-62`), `constraints(over)` (`:67-74`). Note
`fx` defaults `people` to `[]`, so a person-scoped case MUST pass them
explicitly — finding 2 of the spec, arriving in the fixtures. Keep the
`180_000` timeout the other cases use.

```ts
it("accepts a placement iff validateAssignments does, under an every_entrant cap", async () => {
  // Two cards, no shared entrant, cap 1 per entrant. Each entrant is on one
  // card, so a correct per-entity cap forbids NOTHING and the encoder must
  // accept every placement the verifier accepts. The fixture-set encoding
  // resolves `every_entrant` to both fixtures and caps the DAY at one, so it
  // refuses placements the verifier passes — a fork, in the direction that
  // makes the solver report a spurious infeasible.
  const cfg = config({
    window: { from: T0, to: T0 + 150 * MIN },
    constraints: constraints({
      hard: [{ type: "max_fixtures_per_day", count: 1, scope: { kind: "every_entrant" } }],
    }),
  });
  const fixtures = [fx("f1", "E1", "E2"), fx("f2", "E3", "E4")];
  await assertParity({ cfg, fixtures });
}, 180_000);

it("accepts a placement iff validateAssignments does, under an every_person cap", async () => {
  // `pX` is on BOTH cards through two different entrants — the doubles player
  // entered in singles and mixed. `people` passed explicitly because `fx`
  // defaults it to [], and an every_person rule over empty people binds
  // nothing and asserts nothing.
  const cfg = config({
    window: { from: T0, to: T0 + 150 * MIN },
    constraints: constraints({
      hard: [{ type: "max_fixtures_per_day", count: 1, scope: { kind: "every_person" } }],
    }),
  });
  const fixtures = [fx("f1", "E1", "E2", ["pX", "p2"]), fx("f2", "E3", "E4", ["pX", "p4"])];
  await assertParity({ cfg, fixtures });
}, 180_000);
```

Check `config`'s signature before writing these: if it does not already accept
a `constraints` key, pass the constraints the way the file's other rule-bearing
cases do and follow that shape instead.

Also extend `ENCODED_SCOPE_KINDS` (Task 2 Step 3) with `"every_entrant"` and
`"every_person"` — the exhaustiveness test from Task 2 Step 4 will already be
RED after Task 3 widened the union, and this is the deliberate decision it was
built to demand.

- [ ] **Step 2: Run and confirm both fail**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/daily-cap && \
  npx vitest run packages/engine/src/scheduling/build-encode-parity.test.ts \
  --reporter=json --outputFile=/tmp/t4a.json > /tmp/t4a.log 2>&1; echo "EXIT=$?"
```

Expected: FAIL on `days.size` (received `3`), not on a solver error. If it
reports `infeasible`, that is the same defect — record which it was.

- [ ] **Step 3: Encode per (entity, day)**

Replace the single-clause-per-day construction at `:487-513`. For a universal
scope, loop entities on the outside and days on the inside; for every other
scope the existing path is exactly right and must be left alone:

```ts
      if (h.type !== "max_fixtures_per_day") continue;
      const scoped = scopedFixtures(h);
      if (scoped.length === 0) continue;
      const byDay = new Map<string, number[]>();
      slots.forEach((sl, s) => pushTo(byDay, dayKeyInTz(sl.startAt, tz), s));

      // A universal scope is a DIFFERENT SHAPE of problem, not a wider net.
      // `scopedFixtures` returns every fixture for it, so the whole-day clause
      // below would cap the competition rather than each entity — the very
      // misreading PARSER_PROMPT rule 8 documents. One clause per (entity,
      // day) instead, over only the fixtures that contain that entity.
      const universal = h.scope.kind === "every_entrant" || h.scope.kind === "every_person";
      if (universal) {
        const fixturesByEntity = new Map<string, number[]>();
        for (const i of scoped) {
          for (const key of entityKeysFor(h.scope, rows[i]!)) pushTo(fixturesByEntity, key, i);
        }
        for (const [key, entityFixtures] of fixturesByEntity) {
          // An entity that cannot reach the cap cannot breach it.
          if (entityFixtures.length <= h.count) continue;
          for (const [ymd, daySlots] of byDay) {
            const immovable = existing.filter(
              (e) =>
                ruleFixtureById.has(e.fixtureId) &&
                entityKeysFor(h.scope, e).includes(key) &&
                dayKeyInTz(e.startAt, tz) === ymd,
            ).length;
            const room = Math.max(0, h.count - immovable);
            if (room >= Math.min(daySlots.length, entityFixtures.length)) continue;
            // Occupancy over THIS ENTITY's fixtures only — the same
            // one-literal-per-slot construction the whole-day path uses
            // (`occupancyOf`, :520), just over a narrower fixture set, so the
            // clause still costs |slots in day| rather than |fixtures| x |slots|.
            const occEntity = occupancyOf(entityFixtures);
            if (room === 0) {
              for (const s of daySlots) solver.add(Z3.Not(occEntity[s]!));
              continue;
            }
            const lits = daySlots.map((s) => occEntity[s]!);
            solver.add(Z3.AtMost([lits[0]!, ...lits.slice(1)], room));
          }
        }
        continue;
      }
      // …existing whole-day path unchanged from here…
```

`occupancyOf`, `solver`, `Z3` and `pushTo` are all already in scope at this
point in the function — this reuses the exact construction at `:520-528`
rather than introducing a second one.

**Cost check before you write it:** the whole-day path builds `occupancyOf`
once per rule; this builds it once per (entity, day). Confirm on a realistic
board that encode time has not blown up — `occupancyOf(entityFixtures)` is
cheap per call but the loop nest is now |entities| x |days|. If it does blow
up, hoist `occupancyOf` per entity out of the day loop, which is a pure move
and changes no clause.

- [ ] **Step 4: Run and confirm green**

Same command as Step 2. Expected: PASS, and the Task 2 exhaustiveness test
green now that both kinds are on the whitelist.

- [ ] **Step 5: Prove the two solvers agree**

The point of the whole task. Run the full scheduling tree plus the engine gate:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/daily-cap && \
  npx vitest run packages/engine/src/scheduling \
  --reporter=json --outputFile=/tmp/t4b.json > /tmp/t4b.log 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/daily-cap/packages/engine && \
  npm run test > /tmp/t4c.log 2>&1; echo "EXIT=$?"
```

If `z3-solver` is missing (`Cannot find package 'z3-solver'`, ~46 engine tests
red) that is the known environmental red — `npm install` at the MAIN root, per
the env skill §5. It is not a defect in this diff.

- [ ] **Step 6: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/daily-cap && \
  git add packages/engine/src/scheduling/build-encode.ts \
          packages/engine/src/scheduling/build-encode-parity.test.ts && \
  git commit -m "feat(scheduling): encode universal day caps per entity in CP-SAT

The encoder resolved a scope to a fixture set and capped the day's slots.
A universal scope resolves to every fixture, so that clause capped the
competition instead of each entity. Universal scopes now emit one clause
per (entity, day) over that entity's own fixtures."
```

---

### Task 5: Decide and test what an empty `people` list means

`SchedulableFixture.people` is optional (`calendar.ts:82`) and `scopeRowOf`
fills `people: [...(f.people ?? [])]`. On a board whose caller omits `people`,
`entityKeysFor` returns `[]` for `every_person`, no counter is ever
incremented, and the cap binds nothing — a rule that reads back to the
organiser as enforced and enforces nothing. This is the repo's "seam left for
later ships inert" class and it must not ship undecided.

**Files:**
- Modify: `packages/engine/src/scheduling/calendar.ts`
- Test: `packages/engine/src/scheduling/calendar-placer-verifier-parity.test.ts`

- [ ] **Step 1: Establish which callers populate `people`**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/daily-cap && \
  grep -ran "people:" packages/engine/src apps/web/src --include='*.ts' --include='*.tsx' \
  | grep -v node_modules | grep -v "\.test\." | head -40
```

Record the answer in the plan's status log before choosing. If the real
scheduling entry points do NOT populate `people`, `every_person` is inert in
production and that is a blocker to be raised, not worked around.

- [ ] **Step 2: Write the failing test for the chosen behaviour**

Recommended behaviour — an `every_person` cap on a board with no person data
is a REFUSAL, not a silent pass, because silently ignoring the organiser's
headline constraint is the worse failure:

```ts
it("refuses an every_person cap on a board carrying no person data", () => {
  // `people` omitted on every card — the default for any caller that has not
  // been taught to populate it. The cap must not silently bind nothing.
  const fixtures = cards(4); // `cards` sets no `people` — deliberate here
  const config = configFor(
    { type: "max_fixtures_per_day", count: 2, scope: { kind: "every_person" } },
    4,
    SAT_1000_LOCAL,
  );
  const { conflicts } = slotFixtures({ fixtures, config });
  expect(conflicts.some((c) => c.reason === "instruction")).toBe(true);
});
```

- [ ] **Step 3: Run, confirm it fails**

Expected: FAIL — currently zero conflicts, because the cap is inert.

- [ ] **Step 4: Implement the guard, and run the suite**

Emit the conflict where the other instruction-rule conflicts are emitted, so
it travels the same path to the organiser. Then re-run Task 3 Step 8's command
and confirm nothing else moved.

- [ ] **Step 5: Commit**

---

### Task 6: Invert `PARSER_PROMPT` rule 8, re-baseline `t01`/`t02`, add a new trap

**Files:**
- Modify: `apps/web/src/server/usecases/schedule-ai-parse.ts:232-237`
- Modify: `apps/web/src/server/usecases/__tests__/fixtures/parse-corpus.json:294-307`

**Blocked on an owner decision** — see "Open questions" below. Do not start
this task until the corpus re-baseline is approved.

- [ ] **Step 1: Rewrite rule 8**

Replace `:232-237` verbatim text:

```
8. A per-player or per-team daily cap has its OWN scope and is NOT a whole-run
   cap. "no player plays more than 2 matches a day" is max_fixtures_per_day
   with scope {"kind":"every_person"}; "each pair plays twice a day at most"
   is scope {"kind":"every_entrant"}. Use every_person when the organiser
   names a HUMAN ("player", "person", "she"), every_entrant when they name an
   ENTRY ("team", "pair", "doubles"); a player entered in two events is two
   entrants and one person. Scope {"kind":"competition"} still means how many
   fixtures RUN in a day in total — a different rule. Never emit competition
   scope for per-player wording: on a 60-player event that caps the whole day
   at two matches.
```

- [ ] **Step 2: Re-baseline `t01` and `t02` IN THEIR OWN `trap` FIELDS**

Per the standing rule, a re-baseline is announced where the label lives:

```json
    {
      "id": "t01",
      "tier": 4,
      "text": "no player plays more than 2 matches a day",
      "trap": "RE-BASELINED 2026-08-16 (3rd): was defer-all under rule 8. every_person now exists, so the right answer is a compiled per-person cap. Emitting competition scope here is still the 60-player bug.",
      "expect": {
        "hard": [{ "type": "max_fixtures_per_day", "count": 2, "scope": { "kind": "every_person" } }],
        "unparsed": false
      }
    },
    {
      "id": "t02",
      "tier": 4,
      "text": "each team plays twice a day at most",
      "trap": "RE-BASELINED 2026-08-16 (3rd): per-TEAM, so every_entrant, not every_person - a team is an entry, not a human.",
      "expect": {
        "hard": [{ "type": "max_fixtures_per_day", "count": 2, "scope": { "kind": "every_entrant" } }],
        "unparsed": false
      }
    },
```

- [ ] **Step 3: Add a replacement trap row so the deferral cohort does not shrink**

The invented-rule metric needs rows that still must defer:

```json
    {
      "id": "t14",
      "tier": 4,
      "text": "no player plays twice in a row",
      "trap": "Still a per-entity concept and still out of vocabulary: consecutiveness is not expressible - min_rest_minutes is a clock, not a position in the order. Replaces t01/t02 in the deferral cohort after their 2026-08-16 re-baseline.",
      "expect": { "hard": [], "unparsed": true }
    }
```

Check the highest existing `id` first and take the next one — `t14` is a
guess pending that check.

- [ ] **Step 3b: Add the rule-8 regression (spec test-plan item 4)**

The old rule 8 protected against per-player wording compiling to
`competition` scope. Inverting it removes that guard, so the protection has
to become an assertion rather than a prompt sentence. Add a corpus row that
keeps a WHOLE-RUN cap compiling to `competition`, so the inversion cannot
drag every day cap onto a universal scope:

```json
    {
      "id": "t15",
      "tier": 2,
      "text": "we can only run 8 matches a day across the whole event",
      "trap": "The rule-8 guard AFTER its 2026-08-16 inversion: this really is a whole-run cap, so competition scope is correct here and every_person would be wrong. Pairs with t01/t02, which move the other way.",
      "expect": {
        "hard": [{ "type": "max_fixtures_per_day", "count": 8, "scope": { "kind": "competition" } }],
        "unparsed": false
      }
    }
```

Then assert directly, in the parser unit suite rather than the corpus, that
per-player wording never yields `competition` — the corpus checks what the
model DID emit on one run, and this checks the property that must hold:

```ts
it("never compiles per-player wording to a competition-scoped cap", async () => {
  // The old rule 8's entire purpose, kept as an assertion now that the prompt
  // sentence is gone. A competition-scoped cap here caps a 60-player event at
  // two matches a day.
  for (const text of [
    "no player plays more than 2 matches a day",
    "each team plays twice a day at most",
    "nobody should have more than three games in one day",
  ]) {
    const parsed = await parseInstructions(text /* match the suite's call shape */);
    const caps = parsed.hard.filter((h) => h.type === "max_fixtures_per_day");
    expect(caps.every((c) => c.scope.kind !== "competition")).toBe(true);
  }
});
```

Read the parser suite's existing call shape and stub/model handling before
writing this — if the suite mocks the model, drive it from a recorded
response rather than a live call, and confirm which by reading a neighbouring
case first.

- [ ] **Step 4: Run the parser suite and the bench**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/daily-cap && \
  npx vitest run apps/web/src/server/usecases/__tests__ \
  --reporter=json --outputFile=/tmp/t6.json > /tmp/t6.log 2>&1; echo "EXIT=$?"
```

Then re-run the 35-case instruction-parse bench. **The bench scores RAW parser
output, so resolve-time guards are invisible to it** — a green bench does not
mean the cap resolves correctly, only that the model emitted the right shape.

- [ ] **Step 5: Commit**

---

### Task 7: E2E, smoke, and the organiser-facing string

RULES.md owes all four test types. Tasks 1-6 cover unit and regression; this
task covers E2E and smoke, and handles the i18n obligation.

**Files:**
- Modify: `apps/web/e2e/` — the AI-instruction / schedule-build spec
- Modify: `scripts/smoke.ts`
- Modify: all 4 locale dictionaries, if Task 5 added an organiser-visible string

- [ ] **Step 1: Grep the UI text before touching it**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/daily-cap && \
  grep -ran "max_fixtures_per_day" apps/web/src/components apps/web/src/lib | grep -v node_modules
```

`apps/web/src/components/v2/board/ai-instruction-describe.ts` renders rules
back to the organiser — a new scope needs a phrasing there, in 4 locales, or
it renders as a fallback.

- [ ] **Step 1b: The feasibility assumption line (spec Risks)**

A per-person daily cap is a real tightening: a 60-player one-day event capped
at 2 may simply become infeasible, and today that surfaces as unschedulable
fixtures rather than an explanation. The spec asks for an assumption line
stating the cap was applied, shown BEFORE the organiser meets the failure.

Add it where the other build assumptions are rendered — find them first:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/daily-cap && \
  grep -ran "assumption" apps/web/src --include='*.ts' --include='*.tsx' \
  | grep -v node_modules | grep -v "\.test\." | head -20
```

The string is organiser-facing, so it owes all 4 locale dictionaries with
FLAT dotted keys. It is a UI string, not an `HttpError` — server-side errors
here are English by design and are NOT the right home for this.

- [ ] **Step 2: E2E** — organiser types "no player plays more than 2 matches a
      day", the rule compiles, the built board honours it. Assertions on a Next
      HTML body must anchor on `="` — React serialises an omitted prop as
      `"$undefined"`, so a bare `data-*` probe passes in both states.

      A new surface has ZERO width coverage until it is inside
      `mobile.spec.ts`. If Step 1 or 1b adds any visible element, add it to
      that spec's projects or the seven-width matrix never sees it.

- [ ] **Step 3: Smoke** — extend `scripts/smoke.ts`. Note the AI section is
      GATED OFF locally without `SCHEDULING_AI_BASE_URL` (836 local vs 891 CI),
      so a local green may not have run it. Say so explicitly in the report.

- [ ] **Step 4: Full gate at the wave boundary**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/daily-cap && \
  git status --porcelain && \
  npm run openapi:gen && git status --porcelain
```

Second `git status` must be empty. Then root `turbo run lint` / `typecheck` —
that is CI's actual gate, and root lint SKIPS `packages/engine`, which has its
own lint task (already run in Task 3 Step 9). `apps/web` typecheck peaks
~2.8 GB.

- [ ] **Step 5: PR**

Smoke CI is PR-only and `e2e.yml` is LIVE on PRs (six Playwright jobs
including the seven-width matrix). Open the PR; do not merge locally.

---

## Open questions for the owner

1. **Approval.** The spec says "NOT yet owner-approved beyond 'spec it'".
   Tasks 1-5 are engine-internal and reversible. Task 6 changes model-facing
   prompt behaviour and re-baselines a bench corpus.
2. **The corpus re-baseline is the third for this corpus.** Deliberate per the
   spec, announced per row per the standing rule — but it moves two rows from
   "must defer" to "must compile", which changes what the bench measures.
3. **Task 5's ruling.** Refuse an `every_person` cap on a board with no person
   data, or let it bind nothing? Recommendation: refuse. If Task 5 Step 1 finds
   that no production caller populates `people`, `every_person` is inert in
   production and that is a blocker rather than a test-shaped problem.
4. **Test-plan item 2 of the spec has no target** — there is no scheduling
   golden corpus. This plan meets its intent with the parity suites instead.
   Creating a scheduling golden corpus deliberately is separate work.
