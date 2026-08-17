# F1 — Bracket Round Role Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Name every bracket round by its role in the bracket, from one
implementation, in four locales.

**Architecture:** The engine already computes each generated fixture's role
(`bracket: "WB"|"LB"|"GF"`, `isFinal`, `thirdPlace`) and then throws it away at
persistence, so four separate consumers re-derive it from `round_no` and have
drifted. This plan persists the role, adds **one** pure engine function that maps
a fixture's position to a typed `RoundRole`, and converts all four consumers to
it. The engine returns a role, never a string — i18n stays in `apps/web`, so the
engine boundary is preserved.

**Tech Stack:** TypeScript 7, Node 26, pnpm workspaces, vitest, Flyway
migrations, Next.js (App Router), 4-locale flat-dotted-key dictionaries.

**Spec:** `docs/superpowers/specs/2026-08-17-format-progression-design.md` (§2.3
and session F1).

## Global Constraints

- **Every change ships a test that fails without it.**
- Any new or changed user-facing string goes in **all 4 locale dictionaries**
  (`apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`), never hardcoded English.
  Dictionaries use **flat dotted keys**.
- The engine must not import from `apps/web` and must not contain user-facing
  English. `scripts/engine-boundary.ts` also bans `Date.now(`, `Math.random(`,
  `new Date()` and `node:*` imports in `packages/engine/src`.
- Judge vitest green **only** from `--reporter=json --outputFile`
  (`numTotalTests` / `numPassedTests` / `numFailedTestSuites`). A suite that
  fails to collect reports 0 tests and 0 failures.
- Prefix `cd <abs worktree> &&` in the **same** shell call as every command; cwd
  resets to the main checkout between calls.
- New branch in a worktree, never the main checkout.
- `apps/web` typecheck peaks ~2.8 GB: `NODE_OPTIONS=--max-old-space-size=6144`.
- UI verified at **1280, 768 and 320** with no horizontal page scroll.

---

## Existing state (pinned 2026-08-17, re-pin before starting)

Four independent round namers:

| # | path:line | basis | i18n |
|---|---|---|---|
| 1 | `apps/web/src/server/usecases/stages.ts:746-753` `roundTitle` | **match count** | hardcoded EN |
| 2 | `apps/web/src/components/public-site/bracket.tsx:385-398` | distance from last round | **hardcoded EN** |
| 3 | `apps/web/src/components/v2/stages-panel.tsx:1091-1105` `bracketRoundLabel` | distance from last round | `msg()`, two namespaces |
| 4 | `packages/engine/src/exports/build.ts:237-240` | distance from last round | hardcoded EN, but takes `laneLabels` (`:289`) |

Known disagreements: page playoff (public site names Qualifier 1 and Eliminator
separately via `PP_LABEL` at `bracket.tsx:432`; `stages-panel` merges them into
`bracket.qualifiers`); stepladder (public site returns "Final" at the summit,
`stages-panel` always returns "Rung N").

Engine role fields: `packages/engine/src/scheduling/bracket.ts:17-29`
(`BracketFixtureGen`). Discarded at `apps/web/src/server/usecases/stages.ts:511-531`
(`bracketToGen`), whose output type `GenFixture` is at `:494-504`. Fixture rows
are inserted at `stages.ts:1083` and `stages.ts:1525`. The fixtures table stores
only `round_no` / `seq_in_round` (`db/migration/v2-engine/tables/V214__fixtures.sql:10-11`).

Existing i18n keys: `schedule.bracket.rung|final|semi|quarter`
(`apps/web/src/dictionaries/en/ui.json:1581-1584`) and a separate `bracket.*`
namespace (`apps/web/src/lib/i18n-keys.ts:978-989`, no semi/quarter key).

---

## File structure

- **Create** `packages/engine/src/competition/round-role.ts` — pure role
  derivation. One responsibility: position → role. No strings.
- **Create** `packages/engine/src/competition/round-role.test.ts`.
- **Create** `apps/web/src/lib/round-role-label.ts` — role → i18n key + params.
  One responsibility: the i18n mapping. Lives in `apps/web` because the engine
  must not carry locale strings.
- **Create** `apps/web/src/lib/__tests__/round-role-label.test.ts`.
- **Create** `db/migration/deltas/V<next>__fixture_round_role.sql`.
- **Modify** `apps/web/src/server/usecases/stages.ts` — `GenFixture`,
  `bracketToGen`, both insert column lists, `roundTitle` deleted.
- **Modify** the four consumers listed above.
- **Modify** all four `ui.json` dictionaries.

---

### Task 1: Engine derives a typed round role

**Files:**
- Create: `packages/engine/src/competition/round-role.ts`
- Test: `packages/engine/src/competition/round-role.test.ts`

**Interfaces:**
- Consumes: `BracketFixtureGen` from `packages/engine/src/scheduling/bracket.ts:17`.
- Produces:
  ```ts
  export type RoundRole =
    | { kind: "round_of"; entrants: number }   // 8 -> "Round of 8"
    | { kind: "quarter_final" }
    | { kind: "semi_final" }
    | { kind: "final" }                        // single-lane final
    | { kind: "winners_final" }
    | { kind: "losers_round"; n: number }
    | { kind: "losers_final" }
    | { kind: "grand_final" }
    | { kind: "grand_final_reset" }
    | { kind: "third_place" }
    | { kind: "qualifier1" }
    | { kind: "eliminator" }
    | { kind: "qualifier2" }
    | { kind: "rung"; n: number }
    | { kind: "plain_round"; n: number };

  export function roundRole(input: {
    stageKind: string;
    lane: "WB" | "LB" | "GF" | null;
    roundInLane: number;      // 0-based within the lane
    lastRoundInLane: number;  // 0-based index of the lane's last round
    isFinal: boolean;
    thirdPlace: boolean;
    conditional: boolean;
    extKey: string | null;
  }): RoundRole;
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { roundRole } from "./round-role.ts";

const base = {
  stageKind: "knockout",
  lane: null,
  roundInLane: 0,
  lastRoundInLane: 0,
  isFinal: false,
  thirdPlace: false,
  conditional: false,
  extKey: null,
};

describe("roundRole", () => {
  it("names single-elim rounds by distance from the final", () => {
    expect(roundRole({ ...base, roundInLane: 2, lastRoundInLane: 2 })).toEqual({ kind: "final" });
    expect(roundRole({ ...base, roundInLane: 1, lastRoundInLane: 2 })).toEqual({ kind: "semi_final" });
    expect(roundRole({ ...base, roundInLane: 0, lastRoundInLane: 2 })).toEqual({ kind: "quarter_final" });
    expect(roundRole({ ...base, roundInLane: 0, lastRoundInLane: 3 })).toEqual({
      kind: "round_of",
      entrants: 16,
    });
  });

  it("never calls a losers-bracket round a semi-final (the count-based bug)", () => {
    // A DE losers bracket has repeated 2-match and 1-match rounds; naming by
    // size produced four "Final"s and three "Semi-finals" in one bracket.
    expect(roundRole({ ...base, lane: "LB", roundInLane: 0, lastRoundInLane: 3 })).toEqual({
      kind: "losers_round",
      n: 1,
    });
    expect(roundRole({ ...base, lane: "LB", roundInLane: 3, lastRoundInLane: 3 })).toEqual({
      kind: "losers_final",
    });
  });

  it("distinguishes the winners' final from the grand final", () => {
    expect(roundRole({ ...base, lane: "WB", roundInLane: 2, lastRoundInLane: 2 })).toEqual({
      kind: "winners_final",
    });
    expect(roundRole({ ...base, lane: "GF", roundInLane: 0, lastRoundInLane: 1, isFinal: true })).toEqual({
      kind: "grand_final",
    });
    expect(
      roundRole({ ...base, lane: "GF", roundInLane: 1, lastRoundInLane: 1, isFinal: true, conditional: true }),
    ).toEqual({ kind: "grand_final_reset" });
  });

  it("reads page-playoff roles from ext_key, never from round size", () => {
    const pp = { ...base, stageKind: "page_playoff" };
    expect(roundRole({ ...pp, extKey: "pp-q1" })).toEqual({ kind: "qualifier1" });
    expect(roundRole({ ...pp, extKey: "pp-elim" })).toEqual({ kind: "eliminator" });
    expect(roundRole({ ...pp, extKey: "pp-q2" })).toEqual({ kind: "qualifier2" });
    expect(roundRole({ ...pp, extKey: "pp-final" })).toEqual({ kind: "final" });
  });

  it("names the stepladder summit the final, rungs below it", () => {
    const sl = { ...base, stageKind: "stepladder", lastRoundInLane: 2 };
    expect(roundRole({ ...sl, roundInLane: 0 })).toEqual({ kind: "rung", n: 1 });
    expect(roundRole({ ...sl, roundInLane: 2 })).toEqual({ kind: "final" });
  });

  it("names a third-place playoff regardless of where it sits", () => {
    expect(roundRole({ ...base, roundInLane: 2, lastRoundInLane: 2, thirdPlace: true })).toEqual({
      kind: "third_place",
    });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:
```bash
cd <worktree>/packages/engine && npx vitest run src/competition/round-role.test.ts --reporter=json --outputFile=/tmp/f1-t1.json > /tmp/f1-t1.log 2>&1; echo "EXIT=$?"
```
Expected: FAIL — cannot resolve `./round-role.ts`. Confirm with
`jq '{total:.numTotalTests,failedSuites:.numFailedTestSuites}' /tmp/f1-t1.json`;
a missing module shows as a failed **suite** with 0 tests.

- [ ] **Step 3: Write the implementation**

```ts
// Round names are a property of a round's POSITION in the bracket, never of
// how many matches it contains. A double-elim losers bracket has repeated
// 2-match and 1-match rounds, so a count-based namer produces several
// "Semi-finals" and several "Final"s in one bracket (design §2.3).
export type RoundRole =
  | { kind: "round_of"; entrants: number }
  | { kind: "quarter_final" }
  | { kind: "semi_final" }
  | { kind: "final" }
  | { kind: "winners_final" }
  | { kind: "losers_round"; n: number }
  | { kind: "losers_final" }
  | { kind: "grand_final" }
  | { kind: "grand_final_reset" }
  | { kind: "third_place" }
  | { kind: "qualifier1" }
  | { kind: "eliminator" }
  | { kind: "qualifier2" }
  | { kind: "rung"; n: number }
  | { kind: "plain_round"; n: number };

export interface RoundRoleInput {
  stageKind: string;
  lane: "WB" | "LB" | "GF" | null;
  roundInLane: number;
  lastRoundInLane: number;
  isFinal: boolean;
  thirdPlace: boolean;
  conditional: boolean;
  extKey: string | null;
}

// Page-playoff nodes are identified by the generator's own stable ids, which
// is the only place Qualifier 1 and the Eliminator are distinguishable — they
// share a round and a match count.
const PP_ROLE: Record<string, RoundRole> = {
  "pp-q1": { kind: "qualifier1" },
  "pp-elim": { kind: "eliminator" },
  "pp-q2": { kind: "qualifier2" },
  "pp-final": { kind: "final" },
};

export function roundRole(input: RoundRoleInput): RoundRole {
  const { stageKind, lane, roundInLane, lastRoundInLane, isFinal, thirdPlace, conditional, extKey } = input;

  if (thirdPlace) return { kind: "third_place" };

  if (stageKind === "page_playoff" && extKey) {
    const role = PP_ROLE[extKey];
    if (role) return role;
  }

  if (stageKind === "stepladder") {
    return roundInLane === lastRoundInLane ? { kind: "final" } : { kind: "rung", n: roundInLane + 1 };
  }

  if (lane === "GF") return conditional ? { kind: "grand_final_reset" } : { kind: "grand_final" };
  if (lane === "LB") {
    return roundInLane === lastRoundInLane
      ? { kind: "losers_final" }
      : { kind: "losers_round", n: roundInLane + 1 };
  }

  const fromEnd = lastRoundInLane - roundInLane;
  // In a double-elim the winners' bracket final is NOT the tournament final —
  // the grand final is, and it lives in the GF lane handled above.
  if (fromEnd === 0) return lane === "WB" ? { kind: "winners_final" } : { kind: "final" };
  if (fromEnd === 1) return { kind: "semi_final" };
  if (fromEnd === 2) return { kind: "quarter_final" };
  return { kind: "round_of", entrants: 2 ** (fromEnd + 1) };
}
```

`isFinal` is accepted but not consulted on this path: the lane already decides
it, and the engine sets `isFinal` on both the SE final and every DE grand-final
game. Keep it in the input — Task 4's export consumer reads it — but do not
branch on it here without a test that fails first.

- [ ] **Step 4: Run the test and confirm it passes**

Run the Step 2 command again. Expected: `total: 6, passed: 6, failedSuites: 0`.

- [ ] **Step 5: Run the engine boundary gate**

```bash
cd <worktree> && npx tsx scripts/engine-boundary.ts; echo "EXIT=$?"
```
Expected: EXIT=0 (no banned imports or tokens; the module is pure).

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/competition/round-role.ts packages/engine/src/competition/round-role.test.ts
git commit -m "engine(F1): derive a typed bracket round role from position"
```

---

### Task 2: Persist the role on fixtures

**Files:**
- Create: `db/migration/deltas/V<next>__fixture_round_role.sql` (**verify the
  next free V-number at execution — V366 was the high-water mark on 2026-08-17
  and other sessions may have taken V367**)
- Modify: `apps/web/src/server/usecases/stages.ts:494-504` (`GenFixture`),
  `:511-531` (`bracketToGen`), `:1083` and `:1525` (insert sites)
- Test: `apps/web/src/server/usecases/__tests__/bracket-round-role.test.ts`

**Interfaces:**
- Consumes: `BracketFixtureGen.bracket|isFinal|thirdPlace|conditional`
  (`packages/engine/src/scheduling/bracket.ts:19-23`).
- Produces: `fixtures.lane`, `fixtures.is_final`, `fixtures.third_place`,
  `fixtures.conditional`; `GenFixture` gains `lane`, `isFinal`, `thirdPlace`,
  `conditional`.

- [ ] **Step 1: Write the failing test**

```ts
// Generating a double-elim stage must persist each fixture's lane, because
// the lane is what separates the winners' final from the grand final. Before
// this task bracketToGen dropped it and every consumer re-derived it.
it("persists lane, is_final and third_place for a double-elim bracket", async () => {
  const { divisionId, stageId } = await seedDoubleElimStage(8);
  await generateStageFixtures(auth, stageId);

  const rows = await sql`
    select ext_key, round_no, lane, is_final, third_place, conditional
    from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;

  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((r) => r.lane !== null)).toBe(true);
  expect(new Set(rows.map((r) => r.lane))).toEqual(new Set(["WB", "LB", "GF"]));
  expect(rows.filter((r) => r.is_final).length).toBeGreaterThan(0);
  expect(rows.some((r) => r.conditional)).toBe(true); // the bracket-reset game
});
```

Use the existing DB-test helpers in that directory for `seedDoubleElimStage` /
`auth` — follow the neighbouring suites' setup rather than inventing one.

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd <worktree> && eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label l3)" && npx vitest run apps/web/src/server/usecases/__tests__/bracket-round-role.test.ts --reporter=json --outputFile=/tmp/f1-t2.json > /tmp/f1-t2.log 2>&1; echo "EXIT=$?"
```
Expected: FAIL — `column "lane" does not exist`.

- [ ] **Step 3: Write the migration**

```sql
-- V<next> — persist each bracket fixture's ROLE, which the engine already
-- computes and bracketToGen discarded. Without it four separate consumers
-- re-derive the role from round_no and have drifted (design 2026-08-17 §2.3).
alter table fixtures
  add column lane text,
  add column is_final boolean not null default false,
  add column third_place boolean not null default false,
  add column conditional boolean not null default false;

alter table fixtures
  add constraint fixtures_lane_chk check (lane is null or lane in ('WB', 'LB', 'GF'));

comment on column fixtures.lane is
  'Double-elim lane: WB winners, LB losers, GF grand final. Null for single-lane brackets and non-bracket stages.';
```

Load the `supabase:supabase-postgres-best-practices` skill before writing this,
per standing rules. No backfill: existing rows keep `lane = null`, which the
namer treats as a single-lane bracket — the same answer they render today.

- [ ] **Step 4: Thread the fields through**

In `GenFixture` (`stages.ts:494`) add:
```ts
  lane?: "WB" | "LB" | "GF";
  isFinal?: boolean;
  thirdPlace?: boolean;
  conditional?: boolean;
```

In `bracketToGen` (`stages.ts:520-529`) add to the returned object:
```ts
      ...(f.bracket ? { lane: f.bracket } : {}),
      ...(f.isFinal ? { isFinal: true } : {}),
      ...(f.thirdPlace ? { thirdPlace: true } : {}),
      ...(f.conditional ? { conditional: true } : {}),
```

Then map them into the row objects built for the inserts at `stages.ts:1083` and
`stages.ts:1525`. **Both** sites — `generateStageFixtures` and
`generateSeededStageFixtures` — or seeded (placeholder) brackets persist no role
and the whole point is lost on exactly the day-one path F3 depends on.

- [ ] **Step 5: Run the test and confirm it passes**

Re-run the Step 2 command. Expected: all assertions pass, `numFailedTestSuites: 0`.

- [ ] **Step 6: Verify the migration applies from zero**

```bash
cd <worktree> && ~/.claude/skills/seazn-local-env/scripts/seazn-env.sh up --label f1-fresh && echo "EXIT=$?"
```
Expected: `schema ready` at the new version. Then
`~/.claude/skills/seazn-local-env/scripts/seazn-env.sh down --label f1-fresh`.

- [ ] **Step 7: Commit**

```bash
git add db/migration/deltas apps/web/src/server/usecases/stages.ts apps/web/src/server/usecases/__tests__/bracket-round-role.test.ts
git commit -m "fixtures(F1): persist bracket lane, is_final, third_place, conditional"
```

---

### Task 3: Map roles to locale strings

**Files:**
- Create: `apps/web/src/lib/round-role-label.ts`
- Create: `apps/web/src/lib/__tests__/round-role-label.test.ts`
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`

**Interfaces:**
- Consumes: `RoundRole` and `roundRole` from Task 1.
- Produces: `roundRoleLabel(msg: Msg, role: RoundRole): string`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { roundRoleLabel } from "../round-role-label.ts";

const msg = ((key: string, params?: Record<string, unknown>) =>
  params ? `${key}:${JSON.stringify(params)}` : key) as never;

describe("roundRoleLabel", () => {
  it("maps every role kind to a dictionary key", () => {
    expect(roundRoleLabel(msg, { kind: "final" })).toBe("bracket.round.final");
    expect(roundRoleLabel(msg, { kind: "winners_final" })).toBe("bracket.round.winnersFinal");
    expect(roundRoleLabel(msg, { kind: "losers_final" })).toBe("bracket.round.losersFinal");
    expect(roundRoleLabel(msg, { kind: "grand_final" })).toBe("bracket.round.grandFinal");
    expect(roundRoleLabel(msg, { kind: "grand_final_reset" })).toBe("bracket.round.grandFinalReset");
    expect(roundRoleLabel(msg, { kind: "qualifier1" })).toBe("bracket.round.qualifier1");
    expect(roundRoleLabel(msg, { kind: "eliminator" })).toBe("bracket.round.eliminator");
    expect(roundRoleLabel(msg, { kind: "third_place" })).toBe("bracket.round.thirdPlace");
    expect(roundRoleLabel(msg, { kind: "losers_round", n: 2 })).toBe(
      'bracket.round.losersRound:{"n":2}',
    );
    expect(roundRoleLabel(msg, { kind: "round_of", entrants: 16 })).toBe(
      'bracket.round.roundOf:{"n":16}',
    );
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd <worktree> && npx vitest run apps/web/src/lib/__tests__/round-role-label.test.ts --reporter=json --outputFile=/tmp/f1-t3.json > /tmp/f1-t3.log 2>&1; echo "EXIT=$?"
```
Expected: failed suite, module not found.

- [ ] **Step 3: Implement**

```ts
import type { RoundRole } from "@seazn/engine";
import type { Msg } from "@/lib/i18n";

/** Role -> locale string. The engine returns roles, never English. */
export function roundRoleLabel(msg: Msg, role: RoundRole): string {
  switch (role.kind) {
    case "round_of": return msg("bracket.round.roundOf", { n: role.entrants });
    case "quarter_final": return msg("bracket.round.quarter");
    case "semi_final": return msg("bracket.round.semi");
    case "final": return msg("bracket.round.final");
    case "winners_final": return msg("bracket.round.winnersFinal");
    case "losers_round": return msg("bracket.round.losersRound", { n: role.n });
    case "losers_final": return msg("bracket.round.losersFinal");
    case "grand_final": return msg("bracket.round.grandFinal");
    case "grand_final_reset": return msg("bracket.round.grandFinalReset");
    case "third_place": return msg("bracket.round.thirdPlace");
    case "qualifier1": return msg("bracket.round.qualifier1");
    case "eliminator": return msg("bracket.round.eliminator");
    case "qualifier2": return msg("bracket.round.qualifier2");
    case "rung": return msg("bracket.round.rung", { n: role.n });
    case "plain_round": return msg("bracket.round.plain", { n: role.n });
  }
}
```

Confirm the exact import path and `Msg` type against a neighbouring file in
`apps/web/src/lib/` — do not guess it.

- [ ] **Step 4: Add the keys to all four dictionaries**

English values:
```
"bracket.round.roundOf": "Round of {n}",
"bracket.round.quarter": "Quarter-finals",
"bracket.round.semi": "Semi-finals",
"bracket.round.final": "Final",
"bracket.round.winnersFinal": "Winners' final",
"bracket.round.losersRound": "Losers' round {n}",
"bracket.round.losersFinal": "Losers' final",
"bracket.round.grandFinal": "Grand final",
"bracket.round.grandFinalReset": "Grand final (reset)",
"bracket.round.thirdPlace": "Third place",
"bracket.round.qualifier1": "Qualifier 1",
"bracket.round.eliminator": "Eliminator",
"bracket.round.qualifier2": "Qualifier 2",
"bracket.round.rung": "Rung {n}",
"bracket.round.plain": "Round {n}"
```

Then run the repo's translation and parity tooling:
```bash
cd <worktree> && npm run i18n:gen-keys && npm run i18n:check; echo "EXIT=$?"
```
Expected: EXIT=0, all four locales present. Note `i18n:translate` ignores scope
arguments — check what it touches before trusting it.

- [ ] **Step 5: Run the test and confirm it passes**

Re-run the Step 2 command. Expected: 1 test, passing.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/round-role-label.ts apps/web/src/lib/__tests__/round-role-label.test.ts apps/web/src/dictionaries apps/web/src/lib/i18n-keys.ts
git commit -m "i18n(F1): bracket.round.* keys in four locales"
```

---

### Task 4: Convert all four consumers

**Files:**
- Modify: `apps/web/src/components/public-site/bracket.tsx:385-398` (and
  `PP_LABEL:432`)
- Modify: `apps/web/src/components/v2/stages-panel.tsx:1091-1105`
- Modify: `packages/engine/src/exports/build.ts:237-240`
- Modify: `apps/web/src/server/usecases/stages.ts:746-753` (`roundTitle`)
- Test: `apps/web/src/components/public-site/__tests__/bracket.test.tsx`
  (exists — extend it)

**Interfaces:**
- Consumes: `roundRole` (Task 1), `roundRoleLabel` (Task 3), the persisted
  columns (Task 2).
- Produces: no new exports; four call sites deleted.

- [ ] **Step 1: Write the failing test**

```tsx
// The bug this whole session exists to kill: a double elimination of 8 rendered
// four sections titled "Final" and three titled "Semi-finals".
it("names double-elim rounds by lane, not by match count", () => {
  const html = renderToStaticMarkup(<Bracket {...doubleElimProps(8)} />);
  expect(html.match(/Final</g) ?? []).toHaveLength(1);      // exactly one plain "Final"
  expect(html).toContain("Winners' final");
  expect(html).toContain("Losers' final");
  expect(html).toContain("Grand final");
  expect(html.match(/Semi-finals/g) ?? []).toHaveLength(1); // WB semi only
});

it("names page-playoff rounds distinctly on every surface", () => {
  const html = renderToStaticMarkup(<Bracket {...pagePlayoffProps()} />);
  expect(html).toContain("Qualifier 1");
  expect(html).toContain("Eliminator");
  expect(html).toContain("Qualifier 2");
});
```

Match the file's existing render helper rather than introducing a new one.

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd <worktree> && npx vitest run apps/web/src/components/public-site/__tests__/bracket.test.tsx --reporter=json --outputFile=/tmp/f1-t4.json > /tmp/f1-t4.log 2>&1; echo "EXIT=$?"
```
Expected: FAIL — several "Final" matches, no "Winners' final".

- [ ] **Step 3: Convert each consumer**

For each of the four, delete the local naming logic and call
`roundRoleLabel(msg, roundRole({...}))`, computing `lastRoundInLane` per lane
rather than across the whole stage — the bug returns immediately if the max is
taken globally, because a DE's LB has more rounds than its WB.

`packages/engine/src/exports/build.ts` cannot call `roundRoleLabel` (it is in
`apps/web`). Change its signature to accept resolved strings the way it already
accepts `laneLabels` at `:289`, and have its caller pass
`roundRoleLabel`-produced values.

`roundTitle` in `stages.ts` is deleted outright; `previewDivisionFixtures` calls
the shared path. Its synthetic preview fixtures must supply `lane` /
`lastRoundInLane` from the generator output it already holds.

- [ ] **Step 4: Run the test and confirm it passes**

Re-run Step 2's command. Expected: all assertions pass.

- [ ] **Step 5: Prove there is exactly one namer left**

```bash
cd <worktree> && git grep -n -a "Semi-final\|Quarter-final\|Round of " -- apps/web/src packages/engine/src | grep -av "__tests__" | grep -av dictionaries
```
Expected: **no output** outside the dictionaries and tests. Marketing surfaces
(`config/format-gallery.tsx`, `lib/marketing/draw-graph.ts`) are static
illustrations — if you leave them, say so explicitly in the PR body rather than
letting the grep quietly pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "bracket(F1): one round namer across public site, console, export and preview"
```

---

### Task 5: Byes say Bye, and a catalogue regression

**Files:**
- Modify: whichever slot-label path renders a bye (start at
  `apps/web/src/lib/slot-label.ts`, `resolveSlotLabel`)
- Create: `apps/web/src/server/usecases/__tests__/format-catalogue.test.ts`
- Modify: dictionaries (a `bracket.slot.bye` key, four locales)

**Interfaces:**
- Consumes: everything above.
- Produces: a committed catalogue fixture other sessions diff against.

- [ ] **Step 1: Write the failing test for the bye label**

```ts
// A bye is known at setup and never resolves to anyone. "TBD" tells an
// organiser to wait for something that is not coming.
it("labels an unfilled first-round slot in a bye pairing as Bye, not TBD", () => {
  const phases = previewDivisionFixtures(
    [
      { kind: "league", name: "League", config: {}, qualification: null },
      { kind: "knockout", name: "KO", config: { size: 6 }, qualification: { topN: 6 } },
    ],
    12,
  );
  const first = phases[1].sections[0].matches;
  expect(first.some((m) => m.away === "Bye" || m.home === "Bye")).toBe(true);
  expect(first.some((m) => m.away === "TBD" || m.home === "TBD")).toBe(false);
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd <worktree> && npx vitest run apps/web/src/server/usecases/__tests__/format-catalogue.test.ts --reporter=json --outputFile=/tmp/f1-t5.json > /tmp/f1-t5.log 2>&1; echo "EXIT=$?"
```
Expected: FAIL — the slot reads `TBD`.

- [ ] **Step 3: Implement the bye label**

A slot whose fixture carries an `award` (the auto-advancing entrant, see
`BracketFixtureGen.award`) is a bye: render `msg("bracket.slot.bye")` rather
than the TBD label. Add the key to all four dictionaries (`"Bye"` in English).

- [ ] **Step 4: Add the catalogue regression**

In the same file, snapshot every format's shape so any future change to what a
format produces has to be updated deliberately:

```ts
// The 25-format sweep that found the naming defect. Locks stage graph,
// progression mode, and each phase's first row per format.
it("every shipped format produces its known shape", () => {
  const summary = STAGE_TEMPLATES.map((t) => {
    const stages = t.build(4);
    const phases = previewDivisionFixtures(stages, 8);
    return {
      key: t.key,
      stages: stages.map((s) => `${s.kind}:${s.qualification ? "Q" : "-"}`).join(">"),
      rounds: phases.map((p) => p.sections.map((sec) => sec.title)),
    };
  });
  expect(summary).toMatchSnapshot();
});
```

- [ ] **Step 5: Run both and confirm green**

Re-run Step 2's command. Expected: both tests pass, snapshot written.

- [ ] **Step 6: Full gate**

```bash
cd <worktree> && eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label l3)" && npx vitest run --reporter=json --outputFile=/tmp/f1-all.json > /tmp/f1-all.log 2>&1; echo "EXIT=$?"; jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests,suites:.numFailedTestSuites}' /tmp/f1-all.json
cd <worktree>/apps/web && NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit; echo "EXIT=$?"
cd <worktree> && npm run i18n:check; echo "EXIT=$?"
```

- [ ] **Step 7: Screenshot the three surfaces**

Public bracket, `stages-panel`, `bracket-panel` — at 1280, 768 and 320, with no
horizontal page scroll at any width. Include a double-elim and a page playoff.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "bracket(F1): byes read Bye; lock the format catalogue against drift"
```

---

## Self-review

**Spec coverage.** §2.3's four defects each have a task: count-based namer
(Task 4), three drifted implementations (Task 4), hardcoded-English player
bracket (Tasks 3–4), discarded role at persistence (Task 2). §2.4's bye label is
Task 5. The duplicated `bracket.*` / `schedule.bracket.*` namespaces are
resolved by Task 3 introducing one `bracket.round.*` namespace — **Task 4 must
delete the superseded keys**, and that deletion is called out in its Step 5
grep.

**Known gaps, deliberately left:** `config/format-gallery.tsx` and
`lib/marketing/draw-graph.ts` are static marketing illustrations, not generated
output. Task 4 Step 5 forces an explicit decision rather than silence.

**Type consistency.** `RoundRole` is defined once in Task 1 and consumed
unchanged in Tasks 3 and 4. `roundRole`'s input takes `roundInLane` /
`lastRoundInLane` (per-lane, 0-based) throughout; Task 4 Step 3 calls out the
per-lane maximum explicitly because a global maximum silently reintroduces the
bug.

**Verified, not assumed:** the page-playoff node ids used by `PP_ROLE` are read
from the generator — `bracket.ts:390-393` emits exactly `pp-q1`, `pp-elim`,
`pp-q2`, `pp-final`. Two related id shapes the executor will meet nearby:
third-place fixtures are `` `${idPrefix ?? "se"}-3p` `` (`:222`) and stepladder
games are `` `sl-g${j}` `` (`:414`, `:423`) — neither is parsed by `roundRole`,
which reads `thirdPlace` and `stageKind` instead, but a future contributor
tempted to parse ids should know they exist.
