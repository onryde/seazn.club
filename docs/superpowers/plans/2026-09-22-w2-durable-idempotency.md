# W2 — Durable idempotency for `score_events` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Postgres, not Redis, the arbiter of "this tap was already
recorded", so a retried score event can never double-write the ledger.

**Architecture:** `score_events` gains an `idempotency_key` column and a unique
index on `(fixture_id, idempotency_key)`. The append adapter carries the key
into the insert. A duplicate insert now raises `23505`, which `scoreEvent`
catches OUTSIDE the transaction and translates into "return the original
outcome" — reconstructed by folding the ledger to the original event's `seq`.
Redis stays in front as a fast path and stays load-bearing for rate limiting;
it stops being load-bearing for correctness.

**Tech Stack:** Postgres 16 + Flyway-style numbered migrations
(`db/migration/deltas/`), postgres.js (`sql` / `withTenant`), TypeScript 7,
vitest (`environment: "node"`), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-21-device-link-scoring-gaps-design.md`
§6 ("W2 — durable idempotency") and §7b (wave sequence). Read both. W1 merged as
`df892fac2` (PR #823) and its assumptions are now live in the tree.

## Global Constraints

- **Worktree only.** New branch goes in a worktree; never check out in the main
  repo dir. Stand the environment up with the `seazn-local-env` skill
  (`~/.claude/skills/seazn-local-env/SKILL.md`), `up --label w2idem --all`.
- **Package manager is `pnpm`, not `npm`.** `pnpm install --frozen-lockfile`.
- **Migration number: take the next free one at execution time.** `origin/main`
  ends at **V412** as of 2026-09-22; confirm with
  `git ls-tree -r --name-only origin/main db/migration | grep -oE 'V4[0-9]{2}' | sort -u | tail -3`
  before naming the file. A duplicate Flyway version survives a clean rebase
  with no conflict and is only found when the DB refuses to migrate.
- **Greenfield schema stance** (`docs/superpowers/RULES.md:30-34`): a new column
  and index are cheap and expected. No contortion to avoid the migration.
- **All four test types are owed** (`RULES.md:65`): unit, E2E, smoke,
  regression. Plus a mutation proof on the new guard (Task 6).
- **Judge vitest only from `--reporter=json --outputFile`** — read
  `numPassedTests` / `numTotalTests` and confirm `.testResults[].name` holds the
  files you meant to run. `rtk` summaries print `PASS(0) FAIL(0)` for a suite
  that failed to COLLECT.
- **Always run the specific spec you changed**, against a real prod server,
  before it goes near CI. Collection is not execution.
- **`REDIS_URL` is not set locally** (`cache.ts:35-36` gates everything on it),
  so today neither the limiter nor the idempotency path executes in dev or e2e.
  That is the point of this wave: after it, the DB path is exercised by the
  existing suite for free.
- **No new user-facing strings are expected.** If one appears, it goes in all
  four locale dictionaries (`en`/`es`/`fr`/`nl`) and `gen-keys` is re-run.
- **Do not file issues.** Fix inline unless the blast radius says otherwise.
- **PREMISE CORRECTED 2026-09-22, during Task 1.** The test code drafted in
  Tasks 2-5 below uses `badminton.rally`. **That event type is wrong for this
  rig.** `divisionRig` (`_rig.ts:61-92`) seeds `sport_key: "generic"`,
  `variant_key: "score"`, so the only events `appendEvent` / `scoreEvent` will
  accept on a `startedDivisionWithFixture` are the three in `decidingStream()`
  (`_rig.ts:159-165`):
  `core.start` → `generic.result` (`{ p1Score, p2Score }`, this is the
  DECIDING event) → `core.finalize`. Substitute accordingly:
  - a two-event stream is `core.start` then `generic.result`;
  - the "a LATER event moved the state on" differential in Task 3 is
    `core.finalize` after the keyed `generic.result` — the replay must report
    `decided` while the fixture now reads `finalized`;
  - "two DIFFERENT taps" in Task 4 is `core.start` and `generic.result`, not
    two rallies: `generic.result` decides the fixture and a second one is
    refused by the module.
  A bare `insert into score_events` (Task 1) is unaffected — no engine runs, so
  the `type` text is arbitrary there.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `db/migration/deltas/V413__score_events_idempotency_key.sql` (new) | The column + the unique index. Nothing else. |
| `apps/web/src/server/relay/__tests__/…` — no. **`apps/web/src/server/engine-db/__tests__/score-events-idempotency-migration.test.ts`** (new) | Proves the constraint is REAL: a refusal with its accepted twin, and the hash chain still verifies. |
| `apps/web/src/server/engine-db/append-event.ts` (modify) | `AppendInput.idempotencyKey`, carried into the `insert into score_events`. Exports `nextStatus` so the replay reconstruction cannot drift from the write path. |
| `apps/web/src/server/engine-db/replay.ts` (new) | `replayOutcomeFor()` — the fold-to-seq reconstruction of a past event's `ScoreOutcome`. One responsibility, kept out of `scoring.ts` because it is pure engine work. |
| `apps/web/src/server/usecases/scoring.ts` (modify) | Passes the key down; catches `23505` outside the transaction and answers with the original outcome. |
| `apps/web/src/server/engine-db/__tests__/replay.test.ts` (new) | Unit proof of the reconstruction, including the finalize case. |
| `apps/web/src/server/usecases/__tests__/scoring-durable-idempotency.test.ts` (new) | The money path: duplicate key with **no Redis at all** writes one row and returns the original answer. |
| `apps/web/e2e/device-links.spec.ts` (modify) | E2E: the same idempotency key sent twice through the real API leaves one ledger row. |

---

## Task 1: The migration, and a constraint that is provably real

**Files:**
- Create: `db/migration/deltas/V413__score_events_idempotency_key.sql`
- Create: `apps/web/src/server/engine-db/__tests__/score-events-idempotency-migration.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: column `score_events.idempotency_key text` (nullable) and unique
  index `score_events_idem_key on score_events (fixture_id, idempotency_key)`.
  Later tasks rely on both names exactly as written.

- [ ] **Step 1: Confirm the migration number is free**

```bash
cd <worktree>
git fetch origin main
git ls-tree -r --name-only origin/main db/migration | grep -oE 'V4[0-9]{2}' | sort -u | tail -3
```

Expected: `V410 V411 V412`. If the tail has moved past V412, use the next free
number and use it consistently everywhere below.

- [ ] **Step 2: Write the failing test**

Create `apps/web/src/server/engine-db/__tests__/score-events-idempotency-migration.test.ts`:

```ts
// The constraint of V413 is only real if something tries to violate it
// (AGENTS.md class 3). Each refusal here has its ACCEPTED twin in the same
// `it`, so a test that passes on an empty schema cannot exist: the twin would
// fail with "relation does not exist" first.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { seedOrg, startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";

const HAS_DB = !!process.env.DATABASE_URL;

async function rig() {
  const { auth } = await seedOrg();
  const { fixtureId } = await startedDivisionWithFixture(auth);
  return { orgId: auth.orgId, fixtureId };
}

/** A bare ledger insert. Deliberately NOT through appendEvent: this suite is
 *  about the DDL, and going through the adapter would let an adapter-side
 *  guard answer for the database. */
async function insertEvent(
  r: { orgId: string; fixtureId: string },
  seq: number,
  idempotencyKey: string | null,
) {
  const [row] = await sql<{ id: string }[]>`
    insert into score_events (fixture_id, org_id, seq, type, payload, idempotency_key)
    values (${r.fixtureId}, ${r.orgId}, ${seq}, 'badminton.rally', '{}'::jsonb, ${idempotencyKey})
    returning id`;
  return row!.id;
}

describe.skipIf(!HAS_DB)("V413 — score_events.idempotency_key", () => {
  it("refuses a second row with the same (fixture_id, idempotency_key), and accepts a different key", async () => {
    const r = await rig();
    const key = `idem-${randomUUID()}`;
    await insertEvent(r, 1, key); // the ACCEPTED twin — proves the table and column exist

    await expect(insertEvent(r, 2, key)).rejects.toMatchObject({ code: "23505" });

    // Same fixture, different key: allowed. Without this the test above would
    // also pass against a unique index on (fixture_id) alone.
    await expect(insertEvent(r, 2, `idem-${randomUUID()}`)).resolves.toBeTruthy();
  });

  it("scopes the key to the fixture — the same key on ANOTHER fixture is allowed", async () => {
    const a = await rig();
    const b = await rig();
    const key = `idem-${randomUUID()}`;
    await insertEvent(a, 1, key);
    // A global unique index on idempotency_key would red here. Two scorers on
    // two courts can legitimately mint the same client-side key.
    await expect(insertEvent(b, 1, key)).resolves.toBeTruthy();
  });

  it("allows MANY null keys on one fixture — the column is optional", async () => {
    const r = await rig();
    await insertEvent(r, 1, null);
    // Postgres treats NULLs as distinct in a unique index by default. If the
    // migration ever adds `nulls not distinct`, every un-keyed write after the
    // first would refuse — which is every import and every legacy row.
    await expect(insertEvent(r, 2, null)).resolves.toBeTruthy();
  });

  it("leaves the hash chain verifying — the key is NOT in the canonical", async () => {
    const r = await rig();
    await insertEvent(r, 1, `idem-${randomUUID()}`);
    await insertEvent(r, 2, `idem-${randomUUID()}`);
    // `verify_score_events_chain` (V226:54) returns the id of the FIRST bad
    // row, or null. V226's canonical is id|fixture_id|seq|type|payload|voids|
    // recorded_by|recorded_at — idempotency_key must stay out of it, exactly
    // as device_link_id does, or every existing row's hash becomes wrong.
    const [{ bad }] = await sql<{ bad: string | null }[]>`
      select verify_score_events_chain(${r.fixtureId}::uuid) as bad`;
    expect(bad).toBeNull();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
cd <worktree>/apps/web
DATABASE_URL="$DB" DATABASE_SSL=disable npx vitest run \
  src/server/engine-db/__tests__/score-events-idempotency-migration.test.ts \
  --reporter=json --outputFile=/tmp/w2-t1.json
```

Expected: FAIL — `column "idempotency_key" of relation "score_events" does not
exist`. Read `numFailedTests` from the JSON, not the summary line.

- [ ] **Step 4: Write the migration**

Create `db/migration/deltas/V413__score_events_idempotency_key.sql`:

```sql
-- =============================================================================
-- W2 — durable idempotency (design 2026-09-21 §6).
--
-- Before this, "was this tap already recorded?" was answered by a FAIL-OPEN
-- Redis cache (scoring.ts: IDEM_TTL_SECONDS = 24h, key `idemv1:`). On a cache
-- miss, a Redis outage, an Upstash eviction, or any retry past 24h, the same
-- tap was recorded TWICE with no constraint to catch it — corruption on the
-- money path that an umpire cannot distinguish after the fact.
--
-- The database becomes the arbiter. Redis may stay in front as a fast path.
--
-- NULLABLE on purpose: every existing row has no key, and the batch importer
-- and the fold/rebuild paths legitimately write without one. Postgres treats
-- NULLs as DISTINCT in a unique index by default, so unlimited un-keyed rows
-- per fixture stay legal. Do NOT add `nulls not distinct`.
--
-- NOT in the hash-chain canonical (V226 `score_events_hash_chain`): that
-- function names its columns explicitly, so adding one here changes no
-- existing row's `row_hash`. Same treatment device_link_id gets.
-- =============================================================================
alter table score_events add column if not exists idempotency_key text;

-- The whole point of the wave. Scoped to the FIXTURE, not global: two scorers
-- on two courts can mint the same client-side key, and a global index would
-- refuse the second one's perfectly legitimate write.
create unique index if not exists score_events_idem_key
  on score_events (fixture_id, idempotency_key);
```

- [ ] **Step 5: Apply it and re-run the test**

```bash
cd <worktree>
DATABASE_URL="$DB" DATABASE_SSL=disable pnpm run db:apply
cd apps/web
DATABASE_URL="$DB" DATABASE_SSL=disable npx vitest run \
  src/server/engine-db/__tests__/score-events-idempotency-migration.test.ts \
  --reporter=json --outputFile=/tmp/w2-t1.json
```

Expected: PASS, 4 tests. Confirm `numPassedTests: 4` and that
`.testResults[0].name` ends in `score-events-idempotency-migration.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add db/migration/deltas/V413__score_events_idempotency_key.sql \
        apps/web/src/server/engine-db/__tests__/score-events-idempotency-migration.test.ts
git commit -m "feat(db): score_events carries an idempotency key, uniquely per fixture"
```

---

## Task 2: Carry the key into the insert

**Files:**
- Modify: `apps/web/src/server/engine-db/append-event.ts` — `AppendInput`
  (currently lines 22-32), the insert (currently lines 333-338), and the
  `nextStatus` declaration (currently line 96)
- Test: `apps/web/src/server/engine-db/__tests__/score-events-idempotency-migration.test.ts` (extend)

**Interfaces:**
- Consumes: the column and index from Task 1.
- Produces:
  - `AppendInput.idempotencyKey?: string | null` — optional, defaults to null.
  - `export function nextStatus(candidateType: string, outcome: MatchOutcome | null, active: readonly EventEnvelope[]): string` — promoted from module-private to exported. Task 3's reconstruction calls it.

- [ ] **Step 1: Write the failing test**

Append to `score-events-idempotency-migration.test.ts`:

```ts
describe.skipIf(!HAS_DB)("appendEvent carries the idempotency key", () => {
  it("writes the key it was given, and null when it was given none", async () => {
    const { appendEvent } = await import("@/server/engine-db");
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    const key = `idem-${randomUUID()}`;

    await appendEvent(auth.orgId, fixtureId, 0, {
      type: "core.start",
      payload: {},
      idempotencyKey: key,
    });
    await appendEvent(auth.orgId, fixtureId, 1, {
      type: "badminton.rally",
      payload: { winner: "home" },
    });

    const rows = await sql<{ seq: number; idempotency_key: string | null }[]>`
      select seq, idempotency_key from score_events
      where fixture_id = ${fixtureId} order by seq`;
    // BOTH ends pinned. Asserting only the first would pass with a hardcoded
    // key; asserting only the second would pass with the column never written.
    expect(rows.map((r) => r.idempotency_key)).toEqual([key, null]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd <worktree>/apps/web
DATABASE_URL="$DB" DATABASE_SSL=disable npx vitest run \
  src/server/engine-db/__tests__/score-events-idempotency-migration.test.ts \
  --reporter=json --outputFile=/tmp/w2-t2.json
```

Expected: FAIL — `expected [ null, null ] to deeply equal [ 'idem-…', null ]`.
(It fails on the VALUE, not on a type error: an unknown property on an object
literal would be a tsc error, but vitest does not typecheck test files.)

- [ ] **Step 3: Add the field to `AppendInput`**

In `append-event.ts`, inside `export interface AppendInput` (currently lines
22-32), after the `deviceLinkId` field:

```ts
  /** W2 — durable idempotency (design §6). The client's retry key, written so
   *  the unique index on (fixture_id, idempotency_key) can refuse a second
   *  write of the same tap. Rides OUTSIDE the hash-chain canonical, exactly
   *  like `deviceLinkId`: V226 names its columns explicitly. Null for the
   *  importer, the rebuild paths, and any caller that does not retry. */
  idempotencyKey?: string | null;
```

- [ ] **Step 4: Write it in the insert**

In `appendEventInTx`, change the insert (currently lines 333-338) to:

```ts
    insert into score_events (id, fixture_id, seq, type, payload, recorded_by, recorded_at, voids_event_id, device_link_id, idempotency_key)
    values (${candidate.id}, ${fixtureId}, ${candidate.seq}, ${candidate.type},
            ${tx.json(candidate.payload as never)}, ${candidate.recordedBy},
            ${candidate.recordedAt}, ${candidate.voids ?? null}, ${input.deviceLinkId ?? null},
            ${input.idempotencyKey ?? null})
  `;
```

- [ ] **Step 5: Export `nextStatus`**

In `append-event.ts`, change the declaration at line 96 from
`function nextStatus(` to:

```ts
/** Exported for W2's replay reconstruction (`replay.ts`). A replay must report
 *  the status the ORIGINAL write reported, and deriving that from a second,
 *  hand-written rule is exactly how the read and write paths drift apart —
 *  which is the disagreement `fixture-cfg.ts` exists to prevent. One rule, two
 *  callers. */
export function nextStatus(
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd <worktree>/apps/web
DATABASE_URL="$DB" DATABASE_SSL=disable npx vitest run \
  src/server/engine-db/__tests__/score-events-idempotency-migration.test.ts \
  --reporter=json --outputFile=/tmp/w2-t2.json
npx tsc --noEmit -p tsconfig.json; echo "TSC=$?"
```

Expected: `numPassedTests: 5`, `TSC=0`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/server/engine-db/append-event.ts \
        apps/web/src/server/engine-db/__tests__/score-events-idempotency-migration.test.ts
git commit -m "feat(engine-db): appendEvent writes the caller's idempotency key"
```

---

## Task 3: Reconstruct a past event's outcome

**Files:**
- Create: `apps/web/src/server/engine-db/replay.ts`
- Create: `apps/web/src/server/engine-db/__tests__/replay.test.ts`
- Modify: `apps/web/src/server/engine-db/index.ts` (re-export)

**Interfaces:**
- Consumes: `nextStatus` (Task 2), `loadFoldInputs` / `foldFrom` from
  `@/server/engine-db/fold`, `withTenant` from `@/lib/db`.
- Produces:

```ts
export interface ReplayedOutcome {
  seq: number;
  state_summary: unknown;
  outcome: unknown;
  status: string;
}
export async function replayOutcomeFor(
  orgId: string,
  fixtureId: string,
  idempotencyKey: string,
): Promise<ReplayedOutcome | null>;
```

  The shape is field-for-field `ScoreOutcome` in
  `apps/web/src/server/usecases/scoring.ts:37-42`. Task 4 assigns one to the
  other, so the field names must match exactly.

**Why a fold and not a stored snapshot:** the Redis path returns the answer the
ORIGINAL call produced — the state as of that event, not the state now. A
`match_states` read would return the CURRENT state, which is a different
answer and would regress a pad that is resyncing. Folding the ledger to the
original `seq` reproduces the original answer exactly, and it costs a fold only
on the rare duplicate path.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/server/engine-db/__tests__/replay.test.ts`:

```ts
// The reconstruction must reproduce what the ORIGINAL append returned, not
// what the fixture looks like now. The two differ the moment a later event
// lands, which is the whole reason this is a fold-to-seq and not a
// match_states read.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appendEvent } from "@/server/engine-db";
import { replayOutcomeFor } from "@/server/engine-db/replay";
import { seedOrg, startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("replayOutcomeFor", () => {
  it("returns the answer the original append gave, not the current state", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    const key = `idem-${randomUUID()}`;

    await appendEvent(auth.orgId, fixtureId, 0, { type: "core.start", payload: {} });
    const original = await appendEvent(auth.orgId, fixtureId, 1, {
      type: "badminton.rally",
      payload: { winner: "home" },
      idempotencyKey: key,
    });
    // A LATER event moves the live state away from the original answer. Without
    // this the test would pass against a plain match_states read, which is the
    // implementation this one exists to rule out.
    await appendEvent(auth.orgId, fixtureId, 2, {
      type: "badminton.rally",
      payload: { winner: "away" },
    });

    const replayed = await replayOutcomeFor(auth.orgId, fixtureId, key);
    expect(replayed).not.toBeNull();
    expect(replayed!.seq).toBe(original.seq);
    expect(replayed!.status).toBe(original.status);
    // Derived from the original append's OWN return value, never a table typed
    // into this test: a change to the summary shape moves both together.
    expect(replayed!.state_summary).toEqual(original.summary);
    expect(replayed!.outcome).toEqual(original.outcome);
  });

  it("reports `finalized` for a replayed core.finalize", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    const key = `idem-${randomUUID()}`;
    await appendEvent(auth.orgId, fixtureId, 0, { type: "core.start", payload: {} });
    const original = await appendEvent(auth.orgId, fixtureId, 1, {
      type: "core.finalize",
      payload: {},
      idempotencyKey: key,
    });
    const replayed = await replayOutcomeFor(auth.orgId, fixtureId, key);
    // `fixtureStatusFromFold` alone can never say "finalized" — only
    // `nextStatus` does, and only when it is told the candidate's TYPE. A
    // reconstruction that folds without the type reports "in_play" here.
    expect(original.status).toBe("finalized");
    expect(replayed!.status).toBe("finalized");
  });

  it("returns null for a key this fixture never recorded", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    expect(await replayOutcomeFor(auth.orgId, fixtureId, `idem-${randomUUID()}`)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd <worktree>/apps/web
DATABASE_URL="$DB" DATABASE_SSL=disable npx vitest run \
  src/server/engine-db/__tests__/replay.test.ts \
  --reporter=json --outputFile=/tmp/w2-t3.json
```

Expected: FAIL — `Failed to resolve import "@/server/engine-db/replay"`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/server/engine-db/replay.ts`:

```ts
import "server-only";
// W2 (design §6) — reconstruct the answer a past append gave, from the ledger.
//
// The duplicate-write path needs the ORIGINAL outcome, and the only durable
// record of it is the ledger itself. `match_states` holds the CURRENT state,
// which is a different answer as soon as one more event lands.
import { withTenant } from "@/lib/db";
import { loadFoldInputs, foldFrom } from "./fold";
import { nextStatus } from "./append-event";

export interface ReplayedOutcome {
  seq: number;
  state_summary: unknown;
  outcome: unknown;
  status: string;
}

/**
 * The outcome the append carrying `idempotencyKey` returned, or null when this
 * fixture holds no such event.
 *
 * Folds the ledger UP TO that event's seq — the same fold the original write
 * performed, over the same inputs — and derives the status through
 * `nextStatus`, the write path's own rule, so the two cannot drift.
 */
export async function replayOutcomeFor(
  orgId: string,
  fixtureId: string,
  idempotencyKey: string,
): Promise<ReplayedOutcome | null> {
  return withTenant(orgId, async (tx) => {
    const [row] = await tx<{ seq: number; type: string }[]>`
      select seq, type from score_events
      where fixture_id = ${fixtureId} and idempotency_key = ${idempotencyKey}`;
    if (!row) return null;

    const inputs = await loadFoldInputs(tx, fixtureId);
    if (inputs === null) return null;
    // Everything the original write could see, and nothing it could not.
    const upTo = inputs.envelopes.filter((e) => e.seq <= row.seq);
    if (upTo.length === 0) return null;
    const folded = foldFrom(fixtureId, { ...inputs, envelopes: upTo });

    return {
      seq: row.seq,
      state_summary: folded.summary,
      outcome: folded.outcome,
      // The candidate's own TYPE, not the fold alone: only `nextStatus` can
      // answer "finalized", and it needs the type to do it.
      status: nextStatus(row.type, folded.outcome, folded.active),
    };
  });
}
```

In `apps/web/src/server/engine-db/index.ts`, add alongside the existing
re-exports:

```ts
export { replayOutcomeFor, type ReplayedOutcome } from "./replay";
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd <worktree>/apps/web
DATABASE_URL="$DB" DATABASE_SSL=disable npx vitest run \
  src/server/engine-db/__tests__/replay.test.ts \
  --reporter=json --outputFile=/tmp/w2-t3.json
npx tsc --noEmit -p tsconfig.json; echo "TSC=$?"
```

Expected: `numPassedTests: 3`, `TSC=0`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/engine-db/replay.ts \
        apps/web/src/server/engine-db/index.ts \
        apps/web/src/server/engine-db/__tests__/replay.test.ts
git commit -m "feat(engine-db): reconstruct a past append's outcome from the ledger"
```

---

## Task 4: The database becomes the arbiter

**Files:**
- Modify: `apps/web/src/server/usecases/scoring.ts` — the replay branch
  (currently lines 123-132) and the `appendEvent` call (currently lines 139-157)
- Create: `apps/web/src/server/usecases/__tests__/scoring-durable-idempotency.test.ts`

**Interfaces:**
- Consumes: `replayOutcomeFor` (Task 3), `AppendInput.idempotencyKey` (Task 2),
  the unique index (Task 1).
- Produces: no new exports. `scoreEvent`'s signature and `ScoreOutcome` are
  unchanged — this is the contract that lets W1's client-side replay protocol
  keep working untouched.

**The shape, and why the catch is OUTSIDE the transaction:** a `23505` aborts
the transaction it was raised in. Any query issued on that aborted transaction
fails with `25P02`, and the original error is then masked by the second one. So
the duplicate is caught where `appendEvent`'s own `withTenant` has already
unwound, and the reconstruction opens its own transaction.

**PREMISE CORRECTION (2026-09-22, measured during Task 4).** Everything above
this line stands. What this plan got WRONG is that `23505` is the only shape a
duplicate arrives in. It is not, and it is not even the common one:

`appendEvent`'s optimistic-concurrency check (`append-event.ts:198`) compares
`expected_seq` against the ledger tip and throws `SEQ_CONFLICT` **before the
insert is ever attempted**. So in the ordinary sequential retry — the pad on
flaky Wi-Fi resending a tap whose first write already COMMITTED — the tip has
moved, the seq check fires first, and no unique violation ever happens. A catch
matching only on `23505` never runs, and the retry is answered `409`: exactly
the defect this wave exists to remove. Measured, red, before the fix:
`EngineError: expected seq 1 but ledger is at 2`.

`23505` covers only the genuine RACE — two requests, same key, both carrying a
valid `expected_seq`, both past the seq check, one losing the insert.

So the branch matches **both** error shapes and gates the answer on the ledger
lookup rather than on the error code:

- `SEQ_CONFLICT` **or** a `score_events_idem_key` violation, **and**
- `replayOutcomeFor` finds that key on that fixture → answer it.
- Lookup returns null → the `SEQ_CONFLICT` is genuine (another device got
  ahead) and must still raise `409`.

That last gate needs its own test or nothing kills a mutant that drops it: a
stale write carrying a **new** key. It is in the suite as "still raises
SEQ_CONFLICT when the stale write carries a NEW key", and it is the only test
that reds when the gate is removed.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/server/usecases/__tests__/scoring-durable-idempotency.test.ts`:

```ts
// THE money path. `REDIS_URL` is unset in this suite (cache.ts:35-36 gates
// everything on it), so `cacheGet` misses and `cacheSet` is a no-op — which is
// precisely the state in which the OLD code double-wrote. If this suite passes
// with Redis mocked in, it is proving the wrong thing; do not add a mock.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { scoreEvent } from "@/server/usecases/scoring";
import { seedOrg, startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("scoreEvent — durable idempotency, with no cache at all", () => {
  it("records a retried tap ONCE and answers both calls the same", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    const key = `idem-${randomUUID()}`;

    await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    const first = await scoreEvent(auth, fixtureId, {
      expected_seq: 1,
      type: "badminton.rally",
      payload: { winner: "home" },
      idempotency_key: key,
    });
    // The retry a pad on flaky Wi-Fi sends: SAME expected_seq, SAME key. The
    // ledger has already moved past expected_seq 1, so without the idempotency
    // answer this is a SEQ_CONFLICT — which is exactly what makes the assertion
    // below non-vacuous.
    const second = await scoreEvent(auth, fixtureId, {
      expected_seq: 1,
      type: "badminton.rally",
      payload: { winner: "home" },
      idempotency_key: key,
    });

    expect(second).toEqual(first);

    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events
      where fixture_id = ${fixtureId} and idempotency_key = ${key}`;
    expect(n).toBe(1);

    // And the ledger as a whole did not grow: start + the one rally.
    const [{ total }] = await sql<{ total: number }[]>`
      select count(*)::int as total from score_events where fixture_id = ${fixtureId}`;
    expect(total).toBe(2);
  });

  it("does not make two DIFFERENT taps collide", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    const a = await scoreEvent(auth, fixtureId, {
      expected_seq: 1, type: "badminton.rally", payload: { winner: "home" },
      idempotency_key: `idem-${randomUUID()}`,
    });
    const b = await scoreEvent(auth, fixtureId, {
      expected_seq: 2, type: "badminton.rally", payload: { winner: "away" },
      idempotency_key: `idem-${randomUUID()}`,
    });
    // The positive pair for the refusal above. A guard that answered "replay"
    // for everything would pass the first test and fail here.
    expect(b.seq).toBe(a.seq + 1);
  });

  it("still raises SEQ_CONFLICT for a stale write carrying NO key", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(auth, fixtureId, {
      expected_seq: 1, type: "badminton.rally", payload: { winner: "home" },
    });
    // Un-keyed writes keep the old contract exactly. A change here would break
    // every importer and every client that does not send a key.
    await expect(
      scoreEvent(auth, fixtureId, {
        expected_seq: 1, type: "badminton.rally", payload: { winner: "home" },
      }),
    ).rejects.toMatchObject({ code: "SEQ_CONFLICT" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd <worktree>/apps/web
DATABASE_URL="$DB" DATABASE_SSL=disable npx vitest run \
  src/server/usecases/__tests__/scoring-durable-idempotency.test.ts \
  --reporter=json --outputFile=/tmp/w2-t4.json
```

Expected: FAIL on the first test with `SEQ_CONFLICT` — the retry is refused
because nothing yet answers it from the database.

- [ ] **Step 3: Pass the key down**

In `scoring.ts`, in the `appendEvent(...)` call (currently lines 139-150), add
one property after `deviceLinkId`:

```ts
      deviceLinkId: auth.deviceLinkId ?? null,
      // W2: written so the unique index can refuse a second write of this tap.
      idempotencyKey: input.idempotency_key ?? null,
```

- [ ] **Step 4: Translate the duplicate into the original answer**

In `scoring.ts`, replace the `catch (err)` block around `appendEvent`
(currently lines 151-157) with:

```ts
  } catch (err) {
    // W2 (design §6). The unique index on (fixture_id, idempotency_key) has
    // refused a second write of a tap we already recorded. THIS is the
    // correctness guarantee — the Redis check above is now only a fast path,
    // and it misses whenever Redis is cold, evicted, absent, or the retry is
    // more than IDEM_TTL_SECONDS late.
    //
    // Caught HERE, outside `appendEvent`'s own `withTenant`: a 23505 aborts
    // its transaction, and any query issued on an aborted transaction fails
    // with 25P02 and masks the original error. The reconstruction below opens
    // its own transaction.
    //
    // Matched on the index NAME as well as the code, so an unrelated unique
    // violation (the (fixture_id, seq) constraint, say) is never silently
    // answered as a successful replay.
    const pg = err as { code?: string; constraint_name?: string };
    if (
      pg.code === "23505" &&
      String(pg.constraint_name ?? "").includes("score_events_idem_key") &&
      input.idempotency_key
    ) {
      // The same generous ceiling the Redis replay branch charges — a replay
      // performs no write, but a leaked `dl_` URL makes one known key
      // replayable forever.
      await rateLimit(`scorereplayv1:${fixtureId}`, REPLAY_LIMIT);
      const replay = await replayOutcomeFor(auth.orgId, fixtureId, input.idempotency_key);
      // `null` means the row vanished between the refusal and this read (a
      // concurrent void, a cascade delete). Falling through to the original
      // error is right: inventing an outcome would be worse than a 409.
      if (replay) return replay;
    }
    // SEQ_CONFLICT is the hot recovery path and carries no ids — skip it.
    if (err instanceof EngineError && err.code !== "SEQ_CONFLICT") {
      err.message = await humanizeEngineMessage(auth.orgId, err.message);
    }
    throw err;
  }
```

Add the import at the top of `scoring.ts`, beside the existing engine-db
imports (currently lines 14-15):

```ts
import { replayOutcomeFor } from "@/server/engine-db";
```

- [ ] **Step 5: Demote the Redis cache in its own comment**

In `scoring.ts`, replace the first sentence of the file header comment
(currently line 3, "Redis idempotency (24 h — courtside retries on flaky Wi-Fi
must be safe)") with:

```ts
// DURABLE idempotency (W2: a unique index on score_events
// (fixture_id, idempotency_key) — the database is the arbiter, and Redis in
// front of it is only a fast path),
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd <worktree>/apps/web
DATABASE_URL="$DB" DATABASE_SSL=disable npx vitest run \
  src/server/usecases/__tests__/scoring-durable-idempotency.test.ts \
  src/server/usecases/__tests__/scoring-replay-is-free.test.ts \
  src/server/usecases/__tests__/scoring-undo-codes.test.ts \
  --reporter=json --outputFile=/tmp/w2-t4.json
npx tsc --noEmit -p tsconfig.json; echo "TSC=$?"
```

Expected: all three files pass. `scoring-replay-is-free.test.ts` is W1's and
must stay green — the Redis fast path is unchanged. Confirm
`.testResults.length === 3`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/server/usecases/scoring.ts \
        apps/web/src/server/usecases/__tests__/scoring-durable-idempotency.test.ts
git commit -m "fix(scoring): a duplicate tap is refused by the database, not by a cache"
```

---

## Task 5: E2E and smoke — prove it through the real API

**Files:**
- Modify: `apps/web/e2e/device-links.spec.ts` (add one test at the end)

**Interfaces:**
- Consumes: everything above, through HTTP only. No imports from `src/`.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/e2e/device-links.spec.ts`:

```ts
test("the same idempotency key, sent twice, leaves ONE ledger row", async ({ request }) => {
  // W2 (design §6). The unit suite proves this with no Redis at all; this
  // proves it through the real route, the real auth kernel and the real
  // envelope — the seam a unit test cannot see.
  const { fixtureId } = await seedStartedFixture(request);
  const key = `e2e-idem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const body = {
    expected_seq: 1,
    type: "badminton.rally",
    payload: { winner: "home" },
    idempotency_key: key,
  };
  const first = await request.post(`/api/v1/fixtures/${fixtureId}/events`, { data: body });
  expect(first.status(), "the first write is a create").toBe(201);
  const firstJson = (await first.json()) as { data: { seq: number } };

  // Byte-identical retry, including the now-stale expected_seq. Without the
  // durable guarantee this is a 409 SEQ_CONFLICT, so a 200/201 here cannot be
  // produced by accident.
  const second = await request.post(`/api/v1/fixtures/${fixtureId}/events`, { data: body });
  expect(second.status(), "the retry is answered, not refused").toBeLessThan(400);
  const secondJson = (await second.json()) as { data: { seq: number } };
  expect(secondJson.data.seq).toBe(firstJson.data.seq);

  // The ledger itself, read back through the public list endpoint — the
  // assertion that actually witnesses a double write.
  const events = await request.get(`/api/v1/fixtures/${fixtureId}/events`);
  const list = (await events.json()) as { data: { seq: number; type: string }[] };
  const rallies = list.data.filter((e) => e.type === "badminton.rally");
  expect(rallies.length, `ledger: ${JSON.stringify(list.data.map((e) => e.type))}`).toBe(1);
});
```

`seedStartedFixture` does not exist yet in that file. Write it beside the test,
modelled on the existing competition/division/entrants/stage/generate/start
sequence at `device-links.spec.ts:361-401` — create a competition, a division
(`sport_key: "badminton"`, `variant_key` per the existing rig), four entrants,
a league stage, generate, start the division, then POST `core.start` with
`expected_seq: 0` and return the first fixture's id.

- [ ] **Step 2: Stand up a prod server and run the spec**

```bash
S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh
$S rebuild --label w2idem
# The server needs the ROOT .env.local too, or realtime tokens mint HS256 and
# every private-channel join is refused — see
# reference_local_server_mints_hs256_and_realtime_join_is_refused.
# Confirm the listener's PID is the one you started; health=200 can come from a squatter.
cd <worktree>/apps/web
DATABASE_URL="$DB" DATABASE_SSL=disable E2E_PROD_TARGET=1 \
  PLAYWRIGHT_BASE="http://localhost:<port>" \
  npx playwright test e2e/device-links.spec.ts --project=serial --reporter=line
```

Expected before the implementation: the new test FAILS with
`rallies.length` of 2, or a 409 on the retry. After Tasks 1-4 it passes, and
the other 8 tests in the file stay green.

- [ ] **Step 3: Run the smoke gate**

```bash
cd <worktree>
DATABASE_URL="$DB" DATABASE_SSL=disable pnpm run test:smoke 2>&1 | tail -20
```

Expected: no new failures. If `credits-monthly-cron.test.ts` reds with
`expected N to be less than or equal to 6`, that is an accumulated test DB, not
this change — reproduce on a fresh one before calling it a defect.

- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e/device-links.spec.ts
git commit -m "test(e2e): a retried tap leaves one ledger row, through the real route"
```

---

## Task 6: Mutation proof, regression sweep, and the record

**Files:**
- Modify: `docs/superpowers/specs/2026-09-21-device-link-scoring-gaps-design.md`
  (§7b wave sequence — mark W2 done)
- Create: `docs/superpowers/reviews/2026-09-22-w2-round-1.md`

**Interfaces:** none.

- [ ] **Step 1: Kill the new guard, one mutant at a time**

Read `reference_mutation_sweep_traps_hub` first. Mutate each of these
SEPARATELY, re-running the named suite, and record WHICH tests died — not just
a count. Two guards covering for each other are each untested.

| # | Mutation | Must be killed by |
| --- | --- | --- |
| M1 | Drop `idempotency_key` from the insert column list in `append-event.ts` | `score-events-idempotency-migration.test.ts` |
| M2 | Change the index in V413 to `on score_events (idempotency_key)` (global, not per fixture) | the "scopes the key to the fixture" test |
| M3 | Add `nulls not distinct` to the V413 index | the "allows MANY null keys" test |
| M4 | In `scoring.ts`, change the catch predicate to `pg.code === "23505"` alone (drop the constraint-name check) | needs a test where ANOTHER unique violation occurs — if nothing dies, that is a real gap, write the test |
| M5 | In `replay.ts`, change `e.seq <= row.seq` to no filter (fold the whole ledger) | `replay.test.ts`'s "not the current state" test |
| M6 | In `replay.ts`, replace `nextStatus(row.type, …)` with `fixtureStatusFromFold(…)` | `replay.test.ts`'s finalize test |
| M7 | In `scoring.ts`, delete the `await rateLimit(...)` on the new duplicate branch | needs a counting test — add one modelled on `scoring-replay-is-free.test.ts`'s `recordingCounter` if nothing dies |

A mutant that breaks COMPILATION reads as survived — check that the suite
actually collected before recording a kill. Restore each mutant with
`git checkout -- <file>` only after recording its result; never mid-edit of
your own fix.

- [ ] **Step 2: Run the regression sweep**

```bash
cd <worktree>/apps/web
DATABASE_URL="$DB" DATABASE_SSL=disable npx vitest run src/server \
  --reporter=json --outputFile=/tmp/w2-sweep.json
```

Judge on `numPassedTests` / `numTotalTests` and confirm
`.testResults[].name` are paths inside YOUR worktree — a cwd reset silently
runs `main`.

- [ ] **Step 3: Write the review record**

Create `docs/superpowers/reviews/2026-09-22-w2-round-1.md` with: the mutant
table above and its per-mutant killer LIST, the sweep counts, the e2e result,
and any premise from the design doc that proved false while building. A false
premise is a finding to record, not a blocker.

- [ ] **Step 4: Update the design doc**

In `docs/superpowers/specs/2026-09-21-device-link-scoring-gaps-design.md` §7b,
mark W2 as shipped with its PR number, and note in §6 that the fix landed as
described (or how it differed). Do not delete the reasoning — the ruling is why
the next reader trusts the shape.

- [ ] **Step 5: Commit, PR, and dispatch e2e**

```bash
git add docs/superpowers/
git commit -m "docs(scoring): W2 review record, and the wave sequence updated"
git push -u origin <branch>
gh pr create --title "fix(scoring): the ledger refuses a duplicate tap, not a cache" --body "<summary>"
gh workflow run e2e.yml -f pr=<number>
```

`e2e.yml` triggers on push to `main` only — a feature branch gets zero
automatic e2e signal, so the `workflow_dispatch` above is the only way to see
it before merge. Smoke runs on PRs.

---

## Self-Review

**1. Spec coverage.** §6's ruling has three parts: the column and unique index
(Task 1), the handler translating the violation into the original outcome
(Tasks 3-4), and Redis demoted to a fast path while the limiter stays in Redis
(Task 4, Steps 4-5 — `SCORING_LIMIT` and `REPLAY_LIMIT` are untouched). §6's
"exercised by the existing suite for free" claim is what Task 4's no-mock rule
cashes in. §8's four test types: unit (Tasks 2-4), E2E (Task 5), smoke (Task 5
Step 3), regression (Task 6 Step 2), plus the mutation proof §8 also asks for.

**2. Placeholders.** One deliberate gap remains, and it is named rather than
hidden: `seedStartedFixture` in Task 5 Step 1 is described by pointing at the
existing sequence at `device-links.spec.ts:361-401` rather than transcribed,
because that rig's exact entrant and variant shape must be copied from the file
as it stands at execution time, not from a snapshot taken today. Every other
step carries its actual content.

**3. Type consistency.** `ReplayedOutcome` (Task 3) is field-for-field
`ScoreOutcome` (`scoring.ts:37-42`) — `seq`, `state_summary`, `outcome`,
`status` — so Task 4's `return replay` typechecks. `AppendInput.idempotencyKey`
(camelCase, Task 2) is distinct from the wire field `input.idempotency_key`
(snake_case, `AppendEventRequest`); Task 4 Step 3 is the single place they
meet. `nextStatus` is exported in Task 2 Step 5 and consumed in Task 3 Step 3.
The index name `score_events_idem_key` appears in Task 1 Step 4 and is matched
on in Task 4 Step 4.

**Known risk, flagged not resolved:** M4 and M7 in Task 6 may find no killer.
Both are written as "if nothing dies, that is a real gap, write the test"
rather than assumed covered — a mutant with no killer is the finding, not a
failure of the sweep.
