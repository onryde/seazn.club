# Swiss Round-1 Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Swiss stage pairs round 1 top-vs-bottom by default, and the organiser can pick the mode for round 1 only, from a split button on Pair next.

**Architecture:** A pure shared module `apps/web/src/lib/swiss-pairing.ts` owns the rule (`effectiveSwissPairing`, the hint builder). `swissGen` in `server/usecases/stages.ts` and the desk (`stages-panel.tsx` → `stage-rail.tsx`) both call it. `POST /stages/{id}/generate` gains an optional `{ pairing }` body; the stored `stages.config.pairing` is never written.

**Tech Stack:** Next.js (repo's own version — read `node_modules/next/dist/docs/` before touching routes), TypeScript, zod, postgres.js, vitest (`environment: "node"`), Playwright, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-22-swiss-round-one-pairing-design.md` — read it first; this plan argues from it.

## Global Constraints

- Worktree: `/Users/ashokhein/github/seazn.club-wt/swiss-round-one-pairing`, branch `feat/swiss-round-one-pairing`. Prefix EVERY shell command with `cd <abs path> &&` — the shell cwd resets to the main checkout between calls. Never `git stash`.
- `pnpm`, not `npm`.
- `stages.config` is never written by this feature.
- `division_events.payload.fixture_ids` of `fixtures_generated` is the UNDO contract (undo DELETEs those ids, `history.ts:203-215,340-352`). It must stay exactly `createdIds` (newly inserted rows). Seated ids go in `seated_fixture_ids`.
- An override that cannot take effect is refused with 422, never swallowed: non-Swiss stage, first Generate (shell mint), nothing left to pair, or the round being paired is not `round_no = 1`.
- "Round 1" is the round NUMBER from `nextUnseatedSwissRound`, never "no decided board" (odd-field byes are `forfeited` at seat time).
- **Sequencing:** Task 1 and Task 3's schema test/schema do not touch Swiss machinery. Task 2, Task 3's route (it calls Task 2's signature), Task 4 and Task 5 start only after PR #831 (swiss-fix session: `latestSwissRoundWithAnySeat`, `clearSwissFixtureSeats`, the `swissRoundHasPlayedResult` bye exemption) has merged and this branch is rebased onto it. Re-pin every line number in Tasks 2 and 4 after that rebase.
- Every new user-facing string in all 4 dictionaries `apps/web/src/dictionaries/{en,fr,es,nl}/ui.json`, then `pnpm i18n:gen-keys` (regenerates `apps/web/src/lib/i18n-keys.ts`).
- UI: one DOM for all widths (`max-md:*`), tap targets ≥44px (`min-h-11`), no horizontal page scroll at 320/768/1280.
- Vitest: run from `apps/web`, JSON reporter, judge only `numPassedTests`/`numTotalTests` and confirm `.testResults[].name` paths are in THIS worktree. DB suites need a fresh local DB (`seazn-local-env` skill: `db:apply` + `sync:sports`, `DB_SCHEMA` set).
- Expected pairings in tests are derived from the engine's `pairRound`, never hand-typed tables, except where an existing test already scripts a named scenario.
- Commit message trailer: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

---

### Task 1: Shared pairing rule module

**Files:**
- Create: `apps/web/src/lib/swiss-pairing.ts`
- Test: `apps/web/src/lib/__tests__/swiss-pairing.test.ts`

**Interfaces:**
- Consumes: `pairRound`, `SwissStanding` from `@seazn/engine/scheduling`; `EntrantId` from `@seazn/engine/core`.
- Produces:
  ```ts
  export type SwissPairingMode = "fold" | "rank_adjacent";
  export const SWISS_PAIRINGS: readonly SwissPairingMode[];
  export const SWISS_PAIRING_ROUND_ONE_ONLY_CODE = "SWISS_PAIRING_ROUND_ONE_ONLY";
  export const SWISS_PAIRING_ROUND_ONE_ONLY_MESSAGE: string;
  export const SWISS_PAIRING_NOT_SWISS_CODE = "SWISS_PAIRING_NOT_SWISS";
  export const SWISS_PAIRING_NOT_SWISS_MESSAGE: string;
  export function storedSwissPairing(config: Record<string, unknown>): SwissPairingMode;
  export function effectiveSwissPairing(i: { override?: SwissPairingMode; stored: SwissPairingMode; round: number }): SwissPairingMode;
  export function roundOnePairs(fieldSize: number, pairing: SwissPairingMode): Array<[number, number]>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/__tests__/swiss-pairing.test.ts
import { describe, expect, it } from "vitest";
import { pairRound, type SwissStanding } from "@seazn/engine/scheduling/swiss";
import type { EntrantId } from "@seazn/engine/core";
import {
  effectiveSwissPairing,
  roundOnePairs,
  storedSwissPairing,
} from "@/lib/swiss-pairing";

describe("effectiveSwissPairing", () => {
  // Empty case FIRST (AGENTS rule: a ladder states its empty case first).
  it("no override, round 1, fold stored ⇒ fold", () => {
    expect(effectiveSwissPairing({ stored: "fold", round: 1 })).toBe("fold");
  });
  it("round 1 of a rank_adjacent stage defaults to fold (ruling C)", () => {
    expect(effectiveSwissPairing({ stored: "rank_adjacent", round: 1 })).toBe("fold");
  });
  it.each([2, 3, 4])("round %i uses the stored mode", (round) => {
    expect(effectiveSwissPairing({ stored: "rank_adjacent", round })).toBe("rank_adjacent");
    expect(effectiveSwissPairing({ stored: "fold", round })).toBe("fold");
  });
  it("an override wins in round 1", () => {
    expect(effectiveSwissPairing({ override: "rank_adjacent", stored: "fold", round: 1 })).toBe("rank_adjacent");
    expect(effectiveSwissPairing({ override: "fold", stored: "rank_adjacent", round: 1 })).toBe("fold");
  });
});

describe("storedSwissPairing", () => {
  it("absent or unknown ⇒ fold; rank_adjacent ⇒ rank_adjacent", () => {
    expect(storedSwissPairing({})).toBe("fold");
    expect(storedSwissPairing({ pairing: "nonsense" })).toBe("fold");
    expect(storedSwissPairing({ pairing: "rank_adjacent" })).toBe("rank_adjacent");
  });
});

describe("roundOnePairs mirrors the engine", () => {
  // Derived from pairRound itself so a change to the engine moves this test.
  function engine(n: number, pairing: "fold" | "rank_adjacent"): Array<[number, number]> {
    const standings: SwissStanding[] = Array.from({ length: n }, (_, i) => ({
      entrantId: String(i + 1) as EntrantId,
      score: 0,
      rank: i + 1,
    }));
    return pairRound(standings, { played: new Set() }, pairing === "rank_adjacent" ? { pairing } : {})
      .pairings.map((p) => [Number(p.home), Number(p.away)].sort((a, b) => a - b) as [number, number])
      .sort((a, b) => a[0] - b[0]);
  }
  it.each([2, 3, 7, 8, 10, 11])("n=%i", (n) => {
    expect(roundOnePairs(n, "fold")).toEqual(engine(n, "fold"));
    expect(roundOnePairs(n, "rank_adjacent")).toEqual(engine(n, "rank_adjacent"));
  });
  it("the two modes differ for 10 (the prod case)", () => {
    expect(roundOnePairs(10, "fold")[0]).toEqual([1, 6]);
    expect(roundOnePairs(10, "rank_adjacent")[0]).toEqual([1, 2]);
  });
  it("fewer than 2 ⇒ no pairs", () => expect(roundOnePairs(1, "fold")).toEqual([]));
});
```

- [ ] **Step 2: Run it — expect FAIL (module missing)**

`cd /Users/ashokhein/github/seazn.club-wt/swiss-round-one-pairing/apps/web && pnpm exec vitest run src/lib/__tests__/swiss-pairing.test.ts --reporter=json --outputFile=/tmp/sp1.json; echo EXIT=$?`

- [ ] **Step 3: Implement**

```ts
// apps/web/src/lib/swiss-pairing.ts
// Which pairing model a Swiss "Pair next" uses — the ONE authority, shared by
// swissGen (server) and the desk's split button (client), the same way
// swiss-shell.ts is. Spec: docs/superpowers/specs/2026-09-22-swiss-round-one-pairing-design.md
//
// Round 1 (the round being paired has round_no 1) defaults to top-vs-bottom:
// rank-adjacent (Hammes) pairs neighbours by STANDINGS, and before any result
// the only rank is the seed, so neighbours would be seed 1 v seed 2.
import { pairRound, type SwissStanding } from "@seazn/engine/scheduling/swiss";
import type { EntrantId } from "@seazn/engine/core";

export type SwissPairingMode = "fold" | "rank_adjacent";
export const SWISS_PAIRINGS: readonly SwissPairingMode[] = ["fold", "rank_adjacent"];

export const SWISS_PAIRING_ROUND_ONE_ONLY_CODE = "SWISS_PAIRING_ROUND_ONE_ONLY";
export const SWISS_PAIRING_ROUND_ONE_ONLY_MESSAGE =
  "pairing mode can only be chosen for round 1, and only when a round is waiting to be paired";
export const SWISS_PAIRING_NOT_SWISS_CODE = "SWISS_PAIRING_NOT_SWISS";
export const SWISS_PAIRING_NOT_SWISS_MESSAGE = "pairing only applies to swiss stages";

export function storedSwissPairing(config: Record<string, unknown>): SwissPairingMode {
  return config.pairing === "rank_adjacent" ? "rank_adjacent" : "fold";
}

export function effectiveSwissPairing(i: {
  override?: SwissPairingMode;
  stored: SwissPairingMode;
  /** The round being paired — `nextUnseatedSwissRound`. Round NUMBER, never
   *  "has a decided board": a bye is minted `forfeited` at seat time, so that
   *  test is already true the moment an odd round 1 is paired. */
  round: number;
}): SwissPairingMode {
  if (i.override !== undefined) return i.override;
  return i.round === 1 ? "fold" : i.stored;
}

/** Round-1 pairs by seed position (1-based), lower seed first, sorted —
 *  computed by the engine's own pairRound so the hint cannot drift from it. */
export function roundOnePairs(fieldSize: number, pairing: SwissPairingMode): Array<[number, number]> {
  if (fieldSize < 2) return [];
  const standings: SwissStanding[] = Array.from({ length: fieldSize }, (_, i) => ({
    entrantId: String(i + 1) as EntrantId,
    score: 0,
    rank: i + 1,
  }));
  const round = pairRound(standings, { played: new Set() }, pairing === "rank_adjacent" ? { pairing } : {});
  return round.pairings
    .map((p) => {
      const a = Number(p.home);
      const b = Number(p.away);
      return (a < b ? [a, b] : [b, a]) as [number, number];
    })
    .sort((x, y) => x[0] - y[0]);
}
```

Note: the test's `engine()` helper and `roundOnePairs` share a shape on purpose — the test pins the module to the engine; the mutation in Step 5 proves the pin bites.

- [ ] **Step 4: Run — expect PASS**, same command; read `numPassedTests === numTotalTests` from `/tmp/sp1.json`.

- [ ] **Step 5: Mutation check** — change `return i.round === 1 ? "fold" : i.stored;` to `return i.stored;` → the "round 1 of a rank_adjacent stage" case must go red. Revert. Replace `rank: i + 1` with `rank: fieldSize - i` in `roundOnePairs` → the n=… cases must go red. Revert.

- [ ] **Step 6: Commit**

```bash
cd /Users/ashokhein/github/seazn.club-wt/swiss-round-one-pairing && git add apps/web/src/lib/swiss-pairing.ts apps/web/src/lib/__tests__/swiss-pairing.test.ts && git commit -m "feat(swiss): one shared rule for which pairing model a round uses

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Server — effective mode, round-1 override, 422s, audit

**Files:**
- Modify: `apps/web/src/server/usecases/stages.ts` — `swissGen` (L970-1190), `generateStageFixtures` (L1860), `generateStageFixturesWrite` (L1991; swiss branch L2163-2168; audit L2498-2508)
- Test: `apps/web/src/server/usecases/__tests__/swiss-playoff-pairing.test.ts` (modify L193-212, L305-328; add cases)

**Interfaces:**
- Consumes (Task 1): `SwissPairingMode`, `storedSwissPairing`, `effectiveSwissPairing`, the four code/message constants.
- Produces:
  ```ts
  export interface GenerateOptions { pairing?: SwissPairingMode }
  export async function generateStageFixtures(auth: AuthCtx, stageId: string, opts?: GenerateOptions): Promise<GenerateOutcome>;
  // SwissGenResult gains: pairing: SwissPairingMode | null; defaultPairing: SwissPairingMode | null; round: number | null; seatedIds: string[]
  // fixtures_generated payload on a Swiss seat: { stage_id, fixture_ids, round, pairing, override, seated_fixture_ids }
  ```

- [ ] **Step 1: Re-pin existing tests to the new default, keep the cascade scenario via the override**

In `swiss-playoff-pairing.test.ts`:
1. Test "pairs round 2 in CASCADE order" (L193): its scripted round 1 (`ROUND_1_SCORES` keyed `E1|E2`…) REQUIRES an adjacent round 1. Change its round-1 call to `await generateStageFixtures(auth, stage!.id, { pairing: "rank_adjacent" });` and add a comment: "round 1 adjacent BY OVERRIDE — the default is now fold (spec 2026-09-22); this scenario needs seed-neighbour round 1 to script the cascade". Leave the round-2 call without opts (must pair by the cascade).
2. Test "ODD rank-adjacent field" (L305): same — round-1 call gets `{ pairing: "rank_adjacent" }`; later calls unchanged.
3. Add, in the same `describe`:

```ts
import { pairRound, type SwissStanding } from "@seazn/engine/scheduling/swiss";
import type { EntrantId } from "@seazn/engine/core";
import { roundOnePairs } from "@/lib/swiss-pairing";
import { undoDivision } from "../history";
import { unpairSwissRound } from "../stages";

/** Expected round-1 pairs as "E<a>|E<b>" names, from the shared engine-backed builder. */
function expectedRoundOne(n: number, pairing: "fold" | "rank_adjacent"): string[] {
  return roundOnePairs(n, pairing).map(([a, b]) => `E${a}|E${b}`).sort();
}

async function newSwiss(count: number, config: Record<string, unknown>) {
  const { auth } = await seedOrg();
  const { divisionId, nameOf } = await seedBadmintonDivision(auth, count);
  const [stage] = await createStages(auth, divisionId, {
    seq: 1, kind: "swiss", name: "Swiss",
    config: { rounds: swissRoundsFor(count), ...config }, progression: null,
  });
  await startDivision(auth, divisionId);
  return { auth, divisionId, nameOf, stageId: stage!.id };
}

it("pairs round 1 top-vs-bottom by default on a rank_adjacent stage (the prod case, 10 seeds)", async () => {
  const { auth, nameOf, stageId } = await newSwiss(10, { pairing: "rank_adjacent" });
  await generateStageFixtures(auth, stageId);
  const got = (await fixturesOfRound(stageId, 1)).map((f) => pairOf(f, nameOf)).sort();
  expect(got).toEqual(expectedRoundOne(10, "fold"));
  expect(got).not.toEqual(expectedRoundOne(10, "rank_adjacent")); // differential
});

it("ODD field: round 1 defaults to fold, and after Unpair a Neighbours pick still works (the bye is 'forfeited' at seat time)", async () => {
  const { auth, nameOf, stageId } = await newSwiss(7, { pairing: "rank_adjacent" });
  await generateStageFixtures(auth, stageId);
  const real = (await fixturesOfRound(stageId, 1)).filter((f) => f.away_entrant_id !== null);
  expect(real.map((f) => pairOf(f, nameOf)).sort()).toEqual(expectedRoundOne(7, "fold"));
  await unpairSwissRound(auth, stageId);
  await generateStageFixtures(auth, stageId, { pairing: "rank_adjacent" }); // must not 422
  const again = (await fixturesOfRound(stageId, 1)).filter((f) => f.away_entrant_id !== null);
  expect(again.map((f) => pairOf(f, nameOf)).sort()).toEqual(expectedRoundOne(7, "rank_adjacent"));
});

it("a round-1 override of rank_adjacent pairs seed neighbours, and leaves config untouched", async () => {
  const { auth, nameOf, stageId } = await newSwiss(8, {});
  const before = JSON.stringify(await configOf(stageId));
  await generateStageFixtures(auth, stageId, { pairing: "rank_adjacent" });
  expect((await fixturesOfRound(stageId, 1)).map((f) => pairOf(f, nameOf)).sort())
    .toEqual(expectedRoundOne(8, "rank_adjacent"));
  expect(JSON.stringify(await configOf(stageId))).toBe(before);
});

it("round 2 after a fold round 1 still pairs by the stored rank_adjacent cascade", async () => {
  const { auth, stageId } = await newSwiss(8, { pairing: "rank_adjacent" });
  await generateStageFixtures(auth, stageId);           // round 1: fold (default)
  await playRoundHomeWins(auth.orgId, stageId, 1);
  await generateStageFixtures(auth, stageId);           // round 2: stored mode
  const [ev] = await sql<{ payload: Record<string, unknown> }[]>`
    select payload from division_events where type = 'fixtures_generated'
      and payload->>'stage_id' = ${stageId} and (payload->>'round')::int = 2`;
  expect(ev!.payload.pairing).toBe("rank_adjacent");
  expect(ev!.payload.override).toBe(false);
});

it.each([["rank_adjacent"], ["fold"]] as const)(
  "refuses an override once a round is decided (stored %s), seating nothing",
  async (stored) => {
    const { auth, stageId } = await newSwiss(8, stored === "fold" ? {} : { pairing: stored });
    await generateStageFixtures(auth, stageId);
    await playRoundHomeWins(auth.orgId, stageId, 1);
    await expect(generateStageFixtures(auth, stageId, { pairing: "fold" }))
      .rejects.toMatchObject({ status: 422, code: "SWISS_PAIRING_ROUND_ONE_ONLY" });
    const r2 = await fixturesOfRound(stageId, 2);
    expect(r2.every((f) => f.home_entrant_id === null && f.away_entrant_id === null)).toBe(true);
  },
);

it("refuses an override on a non-swiss stage", async () => {
  const { auth } = await seedOrg();
  const { divisionId } = await seedBadmintonDivision(auth, 4);
  const [stage] = await createStages(auth, divisionId, {
    seq: 1, kind: "league", name: "League", config: {}, progression: null,
  });
  await expect(generateStageFixtures(auth, stage!.id, { pairing: "fold" }))
    .rejects.toMatchObject({ status: 422, code: "SWISS_PAIRING_NOT_SWISS" });
});

it("refuses an override on the shell-minting first Generate", async () => {
  const { auth } = await seedOrg();
  const { divisionId } = await seedBadmintonDivision(auth, 8);
  const [stage] = await createStages(auth, divisionId, {
    seq: 1, kind: "swiss", name: "Swiss", config: { rounds: swissRoundsFor(8) }, progression: null,
  });
  // no startDivision: no shells exist, so this press would only mint them
  await expect(generateStageFixtures(auth, stage!.id, { pairing: "rank_adjacent" }))
    .rejects.toMatchObject({ status: 422, code: "SWISS_PAIRING_ROUND_ONE_ONLY" });
});

it("records the round, mode, override and seated ids — and Undo deletes no shell", async () => {
  const { auth, divisionId, stageId } = await newSwiss(8, { pairing: "rank_adjacent" });
  const [{ n: shellsBefore }] = await sql<{ n: number }[]>`
    select count(*)::int as n from fixtures where stage_id = ${stageId}`;
  await generateStageFixtures(auth, stageId, { pairing: "rank_adjacent" }); // differs from round-1 default
  const [ev] = await sql<{ payload: Record<string, unknown> }[]>`
    select payload from division_events where type = 'fixtures_generated'
      and payload->>'stage_id' = ${stageId} order by seq desc limit 1`;
  const seatedIds = (await fixturesOfRound(stageId, 1)).map((f) => f.id).sort();
  expect(ev!.payload).toMatchObject({ round: 1, pairing: "rank_adjacent", override: true, fixture_ids: [] });
  expect([...(ev!.payload.seated_fixture_ids as string[])].sort()).toEqual(seatedIds);

  await undoDivision(auth, divisionId);
  const [{ n: shellsAfter }] = await sql<{ n: number }[]>`
    select count(*)::int as n from fixtures where stage_id = ${stageId}`;
  expect(shellsAfter).toBe(shellsBefore);
});

it("records override=false when the body names the default", async () => {
  const { auth, stageId } = await newSwiss(8, { pairing: "rank_adjacent" });
  await generateStageFixtures(auth, stageId, { pairing: "fold" }); // fold IS the round-1 default
  const [ev] = await sql<{ payload: Record<string, unknown> }[]>`
    select payload from division_events where type = 'fixtures_generated'
      and payload->>'stage_id' = ${stageId} order by seq desc limit 1`;
  expect(ev!.payload).toMatchObject({ pairing: "fold", override: false });
});
```

Before relying on `toMatchObject({ status, code })`: open `apps/web/src/lib/errors.ts` and confirm `HttpError` exposes `status` and `code` under those names; if the names differ, use the real ones (do not guess).

- [ ] **Step 2: Run — expect FAIL** (the new cases; `generateStageFixtures` ignores the 3rd arg)

`cd /Users/ashokhein/github/seazn.club-wt/swiss-round-one-pairing/apps/web && pnpm exec vitest run src/server/usecases/__tests__/swiss-playoff-pairing.test.ts --reporter=json --outputFile=/tmp/sp2.json; echo EXIT=$?` — also confirm `numTotalTests` > 0 (a DB-less run skips everything via `runIf(HAS_DB)` and reports green).

- [ ] **Step 3: Implement in `stages.ts`**

1. Imports: add
   ```ts
   import {
     type SwissPairingMode, storedSwissPairing, effectiveSwissPairing,
     SWISS_PAIRING_ROUND_ONE_ONLY_CODE, SWISS_PAIRING_ROUND_ONE_ONLY_MESSAGE,
     SWISS_PAIRING_NOT_SWISS_CODE, SWISS_PAIRING_NOT_SWISS_MESSAGE,
   } from "@/lib/swiss-pairing";
   ```
   Leave `DECIDED` (L941) and the `cascadeRank` condition's decided-board test exactly as they are.
2. `export interface GenerateOptions { pairing?: SwissPairingMode }` above `generateStageFixtures`.
3. `SwissGenResult` → `{ gen; seatedCount; reshaped; pairing: SwissPairingMode | null; defaultPairing: SwissPairingMode | null; round: number | null; seatedIds: string[] }`. Every existing `return` in `swissGen` that seats nothing returns `pairing: null, defaultPairing: null, round: null, seatedIds: []`.
4. `swissGen(..., existing, override?: SwissPairingMode)`:
   - Shell-mint branch (`existing.length === 0`, L983) and `target === null` branch (L997): first line `if (override !== undefined) throw new HttpError(422, SWISS_PAIRING_ROUND_ONE_ONLY_MESSAGE, SWISS_PAIRING_ROUND_ONE_ONLY_CODE);`
   - Directly after the `target === null` return (L997-999), before the `target > 1` readiness check and before any write:
     ```ts
     if (override !== undefined && target !== 1) {
       throw new HttpError(422, SWISS_PAIRING_ROUND_ONE_ONLY_MESSAGE, SWISS_PAIRING_ROUND_ONE_ONLY_CODE);
     }
     ```
     Round NUMBER, never "a decided board exists": on an odd field the bye is minted `forfeited` + award at seat time (swiss-fix review, 2026-09-22), and an ad-hoc fixture can sit at `maxRound + 1` fully seated.
   - Replace `const rankAdjacent = cfg.pairing === "rank_adjacent";` (L1017) with:
     ```ts
     const stored = storedSwissPairing(cfg);
     const defaultPairing = effectiveSwissPairing({ stored, round: target });
     const pairing = effectiveSwissPairing({ override, stored, round: target });
     const rankAdjacent = pairing === "rank_adjacent";
     ```
     The `cascadeRank` fill (L1075) keeps its own condition untouched.
   - In the seat block (L1157-1189) add `returning id` to each `update fixtures` that seats a board or the bye, collect into `const seatedIds: string[]`, and return `{ ..., pairing, defaultPairing, round: target, seatedIds }`.
5. `generateStageFixtures(auth, stageId, opts: GenerateOptions = {})` passes `opts` to `generateStageFixturesWrite(auth, stageId, opts)`. `generateStageFixturesUnpublished` passes `{}`.
6. In `generateStageFixturesWrite`, right after the stage row is read and before any write: `if (opts.pairing !== undefined && stage.kind !== "swiss") throw new HttpError(422, SWISS_PAIRING_NOT_SWISS_MESSAGE, SWISS_PAIRING_NOT_SWISS_CODE);`. Swiss branch (L2165): `swissGen(tx, stageId, stage.division_id, stage.config, entrants, existing, opts.pairing)`; keep the result in `let swissAudit: Record<string, unknown> | undefined` =
   ```ts
   swiss.seatedIds.length > 0
     ? { round: swiss.round, pairing: swiss.pairing, override: opts.pairing !== undefined && opts.pairing !== swiss.defaultPairing, seated_fixture_ids: swiss.seatedIds }
     : undefined;
   ```
7. Audit insert (L2505): payload `{ stage_id: stageId, fixture_ids: createdIds, ...(swissAudit ?? {}) }`. Do NOT change `createdIds`.

- [ ] **Step 4: Run — expect PASS** (same command). Then run the other Swiss suites that share `swissGen`: `pnpm exec vitest run src/server/usecases/__tests__/swiss --reporter=json --outputFile=/tmp/sp2b.json` and list `.testResults[].name` — every `swiss*.test.ts` in the dir must appear (the positional is a literal filename filter). Any red that asserts round-1 adjacency without an override is a test pinning the old default: add `{ pairing: "rank_adjacent" }` to its round-1 call with the same comment as Step 1 — never loosen an assertion.

- [ ] **Step 5: Mutations** (each must go red, then revert): (a) replace `pairing` with `stored` in `rankAdjacent`; (b) delete the `target !== 1` 422; (c) drop `opts.pairing` from the `swissGen` call; (d) put `swiss.seatedIds` into `fixture_ids` (the Undo test must go red); (e) delete the non-swiss 422.

- [ ] **Step 6: Typecheck + commit**

`cd .../apps/web && pnpm exec tsc --noEmit -p . ; echo EXIT=$?` (must be 0), then commit `stages.ts` + test file: `feat(swiss): pair round 1 top-vs-bottom by default; one-round override; audit the mode`.

---

### Task 3: API body, schema, OpenAPI

**Files:**
- Modify: `apps/web/src/server/api-v1/schemas.ts` (near `GenerateResult`, L1584)
- Modify: `apps/web/src/app/api/v1/stages/[id]/generate/route.ts`
- Modify: `apps/web/src/server/api-v1/openapi.ts:130`
- Regenerate: `openapi/v1.json`, `openapi/v1.public.json`
- Test: `apps/web/src/server/api-v1/__tests__/generate-stage-input.test.ts` (create)

**Interfaces:**
- Consumes: `GenerateOptions`, `generateStageFixtures(auth, id, opts)` (Task 2).
- Produces: `export const GenerateStageInput`, `export type GenerateStageInput`.

- [ ] **Step 1: Failing test**

```ts
// apps/web/src/server/api-v1/__tests__/generate-stage-input.test.ts
import { describe, expect, it } from "vitest";
import { GenerateStageInput } from "@/server/api-v1/schemas";

describe("GenerateStageInput", () => {
  it("empty object is valid (the desk sends {})", () => expect(GenerateStageInput.parse({})).toEqual({}));
  it.each(["fold", "rank_adjacent"])("accepts %s", (p) =>
    expect(GenerateStageInput.parse({ pairing: p })).toEqual({ pairing: p }));
  it("rejects an unknown mode", () => expect(() => GenerateStageInput.parse({ pairing: "dutch" })).toThrow());
  it("rejects unknown keys (typo guard)", () => expect(() => GenerateStageInput.parse({ paring: "fold" })).toThrow());
});
```

- [ ] **Step 2: Run — FAIL.** `pnpm exec vitest run src/server/api-v1/__tests__/generate-stage-input.test.ts --reporter=json --outputFile=/tmp/sp3.json`

- [ ] **Step 3: Implement**

schemas.ts (the file may not import `@/` — keep the enum spelled out, as `StageConfig.pairing` at L1018 does):
```ts
/** POST /stages/{id}/generate body. `pairing` = a ROUND-1-ONLY Swiss override
 *  (spec 2026-09-22); never stored. Absent body ≡ {}. */
export const GenerateStageInput = z.object({ pairing: z.enum(["fold", "rank_adjacent"]).optional() }).strict();
export type GenerateStageInput = z.infer<typeof GenerateStageInput>;
```
route.ts — an existing caller may POST with NO body, and `parseBody` 400s on that, so read text:
```ts
import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { GenerateStageInput } from "@/server/api-v1/schemas";
import { HttpError } from "@/lib/errors";
import { generateStageFixtures } from "@/server/usecases/stages";

type Ctx = { params: Promise<{ id: string }> };

/** Generate fixtures for a stage — idempotent, returns the diff (doc 08 §3).
 *  Optional body `{ pairing }`: a round-1-only Swiss pairing override. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "write");
    const text = await req.text();
    let raw: unknown = {};
    if (text.trim() !== "") {
      try {
        raw = JSON.parse(text);
      } catch {
        throw new HttpError(400, "Request body must be valid JSON");
      }
    }
    const body = GenerateStageInput.parse(raw);
    return generateStageFixtures(auth, id, body.pairing ? { pairing: body.pairing } : {});
  });
}
```
openapi.ts L130: add `request: S.GenerateStageInput,` and `errors: [400, 422]`, and append to the summary: "Optional body `{pairing}` — Swiss only, ROUND 1 only (422 SWISS_PAIRING_ROUND_ONE_ONLY / SWISS_PAIRING_NOT_SWISS otherwise); never stored."

- [ ] **Step 4: Run test — PASS.** Then `cd /Users/ashokhein/github/seazn.club-wt/swiss-round-one-pairing && pnpm openapi:gen; echo EXIT=$?` and `git diff --stat openapi/` — both JSON files must change, only around `/stages/{id}/generate`.

- [ ] **Step 5: Commit** schemas, route, openapi.ts, test, both openapi JSONs: `feat(api): generate takes an optional round-1 Swiss pairing override`.

---

### Task 4: Desk split button + i18n

**Files:**
- Modify: `apps/web/src/components/v2/desk/stage-rail.tsx` (props L80-100; buttons L421-479)
- Modify: `apps/web/src/components/v2/stages-panel.tsx` (`act` L558-625; per-stage derivations L893-915; `<StageRail …>` L1325)
- Modify: `apps/web/src/dictionaries/{en,fr,es,nl}/ui.json` (next to `schedule.pairNext`, L1924)
- Regenerate: `apps/web/src/lib/i18n-keys.ts` via `pnpm i18n:gen-keys`

**Interfaces:**
- Consumes: `SwissPairingMode`, `storedSwissPairing`, `effectiveSwissPairing`, `roundOnePairs` (Task 1); POST body `{ pairing }` (Task 3).
- Produces (StageRail props):
  ```ts
  /** Swiss only, and only while a round waits to be paired; null otherwise. */
  swissPairingMenu: {
    round: number;               // nextUnseatedSwissRound
    choosable: boolean;          // round === 1
    defaultPairing: SwissPairingMode;
    stored: SwissPairingMode;
    fieldSize: number;           // activeEntrantIds.length
  } | null;
  onAct: (stageId: string, action: "generate" | "complete" | "delete" | "unpair", opts?: { pairing?: SwissPairingMode }) => void;
  ```

- [ ] **Step 1: Strings.** Add to all four `ui.json` (keys identical, values translated):

| key | en | fr | es | nl |
|---|---|---|---|---|
| `schedule.pairing.toggle` | Pairing options | Options d'appariement | Opciones de emparejamiento | Koppelingsopties |
| `schedule.pairing.groupLabel` | Round {round} pairing | Appariement de la ronde {round} | Emparejamiento de la ronda {round} | Koppeling ronde {round} |
| `schedule.pairing.fold` | Top vs bottom | Haut contre bas | Arriba contra abajo | Boven tegen onder |
| `schedule.pairing.adjacent` | Neighbours | Voisins | Vecinos | Buren |
| `schedule.pairing.default` | default | par défaut | predeterminado | standaard |
| `schedule.pairing.pair` | {a}v{b} | {a}c{b} | {a}v{b} | {a}t{b} |
| `schedule.pairing.laterAdjacent` | Neighbours on the table (1st v 2nd, 3rd v 4th…) | Voisins au classement (1er c 2e, 3e c 4e…) | Vecinos en la tabla (1.º v 2.º, 3.º v 4.º…) | Buren in de stand (1e t 2e, 3e t 4e…) |
| `schedule.pairing.laterFold` | Top vs bottom within each score group | Haut contre bas dans chaque groupe de points | Arriba contra abajo dentro de cada grupo de puntos | Boven tegen onder binnen elke puntengroep |
| `schedule.pairing.roundOneOnly` | Mode is chosen in round 1 only. | Le mode se choisit uniquement à la ronde 1. | El modo solo se elige en la ronda 1. | De modus kies je alleen in ronde 1. |

Then `cd /Users/ashokhein/github/seazn.club-wt/swiss-round-one-pairing && pnpm i18n:gen-keys; echo EXIT=$?`.

- [ ] **Step 2: Panel wiring** (`stages-panel.tsx`)
  - Import `{ type SwissPairingMode, storedSwissPairing, effectiveSwissPairing }` from `@/lib/swiss-pairing`.
  - Beside `swissHasUnseated` (L900):
    ```ts
    const swissPairingMenu = (() => {
      if (stage.kind !== "swiss" || fixtureCount === 0 /* shells not minted */) return null;
      const round = nextUnseatedSwissRound(swissShellFixtures);
      if (round === null) return null;
      const stored = storedSwissPairing(stage.config);
      return { round, choosable: round === 1, stored, fieldSize: activeEntrantIds.length,
               defaultPairing: effectiveSwissPairing({ stored, round }) };
    })();
    ```
    (`fixtureCount` here is `stageFixtures.length`.)
  - `act(stageId, action, opts?: { pairing?: SwissPairingMode })`; generate branch sends `json: opts?.pairing ? { pairing: opts.pairing } : {}`.
  - Pass `swissPairingMenu={swissPairingMenu}` to `<StageRail>`.

- [ ] **Step 3: Split button** (`stage-rail.tsx`). Wrap the existing `stage-generate` button (keep its testid, label logic and the long comment untouched) in `<div className="flex items-stretch">`, give it `rounded-r-none` when `swissPairingMenu` is non-null, and add after it:
  ```tsx
  {swissPairingMenu && (
    <button
      type="button"
      aria-expanded={pairingOpen}
      aria-controls={`pairing-menu-${stage.id}`}
      aria-label={msg("schedule.pairing.toggle")}
      data-testid="stage-pairing-toggle"
      disabled={busy !== null}
      onClick={() => setPairingOpen((o) => !o)}
      className={`btn min-h-11 min-w-11 rounded-l-none border-l px-2 text-xs ${pairingIsNext ? "btn-primary" : "btn-ghost"}`}
    >▾</button>
  )}
  ```
  State: `const [pairingOpen, setPairingOpen] = useState(false); const [pick, setPick] = useState<SwissPairingMode | null>(null);` — reset both to closed/null after every generate press and when `swissPairingMenu?.round` changes (`useEffect` on `[swissPairingMenu?.round]`). Escape closes and returns focus to the toggle.
  Generate click: `onAct(stage.id, "generate", pick && pick !== swissPairingMenu?.defaultPairing ? { pairing: pick } : undefined)`.

  Menu, rendered as a full-width row directly under the button row (inline disclosure — not a floating popover, so nothing can overflow at 320):
  ```tsx
  {swissPairingMenu && pairingOpen && (
    <div id={`pairing-menu-${stage.id}`} role="radiogroup"
         aria-label={msg("schedule.pairing.groupLabel", { round: swissPairingMenu.round })}
         aria-disabled={!swissPairingMenu.choosable || undefined}
         data-testid="stage-pairing-menu"
         className="flex w-full min-w-0 flex-col gap-1 rounded-lg border border-zinc-200 p-2 text-xs md:basis-full">
      {swissPairingMenu.choosable
        ? (["fold", "rank_adjacent"] as const).map((mode) => {
            const checked = (pick ?? swissPairingMenu.defaultPairing) === mode;
            const pairs = roundOnePairs(swissPairingMenu.fieldSize, mode).slice(0, 3)
              .map(([a, b]) => msg("schedule.pairing.pair", { a, b })).join(", ");
            return (
              <button key={mode} type="button" role="radio" aria-checked={checked}
                      data-testid={`stage-pairing-${mode}`} onClick={() => setPick(mode)}
                      className="flex min-h-11 min-w-0 items-center gap-2 rounded px-2 text-left">
                <span aria-hidden="true">{checked ? "●" : "○"}</span>
                <span className="min-w-0 truncate">
                  {msg(mode === "fold" ? "schedule.pairing.fold" : "schedule.pairing.adjacent")}
                  {mode === swissPairingMenu.defaultPairing ? ` (${msg("schedule.pairing.default")})` : ""}
                  {pairs ? ` — ${pairs}…` : ""}
                </span>
              </button>
            );
          })
        : (
          <>
            <p role="radio" aria-checked="true" aria-disabled="true" data-testid="stage-pairing-readonly"
               className="flex min-h-11 items-center gap-2 px-2">
              <span aria-hidden="true">✓</span>
              {msg(swissPairingMenu.stored === "rank_adjacent" ? "schedule.pairing.laterAdjacent" : "schedule.pairing.laterFold")}
            </p>
            <p className="px-2 text-ink-muted" data-testid="stage-pairing-hint">{msg("schedule.pairing.roundOneOnly")}</p>
          </>
        )}
    </div>
  )}
  ```
  Arrow-key movement between the two radios (roving `tabIndex`) is required for a real radiogroup: Up/Left and Down/Right move `pick`.

- [ ] **Step 4: Verify** — `pnpm exec tsc --noEmit -p .` (EXIT=0); `pnpm exec vitest run src/lib/__tests__/i18n --reporter=json --outputFile=/tmp/sp4.json` (the dictionary-parity suites; confirm names), `rtk proxy pnpm run lint` read `✖ N problems` (must not rise).

- [ ] **Step 5: Commit** rail, panel, 4 dictionaries, `i18n-keys.ts`: `feat(desk): Pair next picks the round-1 Swiss pairing from a split button`.

---

### Task 5: E2E, smoke, screenshots

**Files:**
- Create: `apps/web/e2e/swiss-round-one-pairing.spec.ts`
- Modify: `scripts/smoke.ts` (rank_adjacent block ~L8199-8281)
- Modify if red: `apps/web/e2e/mobile.spec.ts` only by opening the new disclosure where a test asserts the rail (AGENTS rule 22 — never weaken)

- [ ] **Step 1: E2E spec.** Copy the division/stage setup of `apps/web/e2e/swiss-shell.spec.ts` (read L1-100: it creates a Swiss stage, starts the division and drives `stage-generate`), with 8 seeded entrants and `config.pairing = "rank_adjacent"`. Three tests:
  1. Default: click `stage-generate` → read round-1 pairs back through `GET /api/v1/divisions/{id}/fixtures` and map to seeds → equals `roundOnePairs(8, "fold")` (import it from `../src/lib/swiss-pairing`).
  2. Unpair (`stage-unpair`), open `stage-pairing-toggle`, click `stage-pairing-rank_adjacent`, click `stage-generate` → round 1 equals `roundOnePairs(8, "rank_adjacent")`.
  3. Score round 1 through the API as `swiss-shell.spec.ts` does, open the toggle for round 2 → `stage-pairing-readonly` visible with the laterAdjacent text, `stage-pairing-hint` visible, and no `[role=radio][aria-checked=false]` inside `stage-pairing-menu`.
  Hit-test the toggle with `elementFromPoint` at its centre (AGENTS rule 2), not `boundingBox`.

- [ ] **Step 2: Run the whole file, three times** (flaky-shaped gate): `cd .../apps/web && PLAYWRIGHT_BASE=http://localhost:<port> pnpm exec playwright test e2e/swiss-round-one-pairing.spec.ts` against a prod build per `seazn-local-env` (BASE must be `localhost`, never 127.0.0.1). Then run the FULL `e2e/mobile.spec.ts` (all width projects, no `-g`) and `e2e/swiss-shell.spec.ts`; a serial-file red is a floor, re-run after each fix.

- [ ] **Step 3: Smoke.** In the rank_adjacent smoke block, after "Pair next seats round 1", assert the seated round-1 pairs equal the fold pairs for that field (same `roundOnePairs` derivation), not only that boards are seated. Run the smoke target locally per the skill.

- [ ] **Step 4: Screenshots** at 320, 768, 1280: (a) closed split button, (b) round-1 menu open, (c) round-2 read-only menu. Crop to the rail. Confirm the images exist and DIFFER, and `document.documentElement.scrollWidth <= innerWidth` at each width. Record a one-line verdict per screen in the PR body.

- [ ] **Step 5: Commit** spec + smoke (+ any mobile.spec opening): `test(swiss): drive the round-1 pairing pick in a browser and in smoke`.

---

### Task 6: Final gate

- [ ] Rerun, from the worktree, and paste raw counts: Task 1-3 vitest files; every `src/server/usecases/__tests__/swiss*` suite; `tsc --noEmit`; lint; `pnpm openapi:gen` leaves `git status` clean.
- [ ] Run `packages/engine` `formats-ext.test.ts` and `swiss.test.ts` (JSON reporter) — the engine is unchanged, so they must stay green untouched; a red there means the change leaked into the engine.
- [ ] `reviewer` agent over `git diff origin/main...HEAD`, then fix findings through the implementer.
- [ ] Push branch, open PR (smoke runs on PRs; e2e only via `workflow_dispatch` with `pr` input — trigger it). PR body: rulings, the undo-contract finding, per-screen verdicts, and the prod rollout note (organiser: Unpair → Pair next).
