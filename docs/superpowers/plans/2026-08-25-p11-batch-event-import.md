# P11 Batch Score-Event Import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an entitled org admin import finished matches into unstarted fixtures as JSON, appending through the one production score-event writer so imported history is indistinguishable from history that was scored live.

**Architecture:** A new usecase (`event-import.ts`) resolves each stream's fixture, dry-run folds the whole stream with zero writes, then appends seq 0..n inside **one transaction per fixture** by calling `appendEventInTx` — the existing `appendEvent` transaction body, extracted so both callers share it. A `event_imports` receipt row, inserted in that same transaction under a UNIQUE index, is the idempotency guarantee. Decided-fixture side effects fire after commit exactly as live scoring fires them.

**Tech Stack:** Next.js (see `node_modules/next/dist/docs/` — this is not the Next you know), TypeScript 7, postgres.js, zod, vitest, Playwright, pino, Flyway.

**Spec:** `docs/superpowers/specs/2026-08-25-p11-batch-event-import-design.md` — read it before Task 1. It carries the eight owner rulings and the five false premises found at re-pin; this plan argues from it.

## Global Constraints

- **Branch/worktree:** `feat/p11-batch-import` in `.claude/worktrees/p11-batch-import`. Every command runs with that as cwd **in the same invocation** (`cd <abs worktree> && …`) — a verify launched from a worktree otherwise executes against `main` and returns a false green.
- **One PR for the session.** Smoke CI is PR-only. Never enable `.github/workflows/e2e.yml`.
- **Every change ships a test that fails without it.**
- **i18n ×4** — `en`, `es`, `fr`, `nl` under `apps/web/src/dictionaries/<locale>/`, flat dotted keys, then `npm run i18n:gen-keys` (`i18n-keys.ts` is generated; a missed regen reds the drift gate). `content/help/**` is English-only.
- **No server-side i18n.** The server returns typed codes; the client localises them.
- **UI bar:** `/admin`-grade surface — functional only, but still screenshot at 1280 / 320 / 768 with no horizontal page scroll; wide tables scroll in their own container.
- **Structured logging:** pino `log` from `apps/web/src/server/logger.ts` in new server code, never in tests.
- **`withTenant` MUST NOT nest**, and nothing inside its callback may await a query on the pooled `sql` proxy (`apps/web/src/lib/db.ts:179-181`) — that is a pool self-deadlock. All entitlement and feature lookups happen **before** the write transaction opens.
- **Caps (owner ruling R4):** 50 streams / 1 000 events per fixture / 10 000 events per call.
- **Verification traps:** an rtk vitest summary reading `PASS(0) FAIL(0)` means the suite failed to **collect**; judge green only from `--reporter=json --outputFile` + jq. Lint via `rtk proxy npm run lint`, reading `✖ N problems`. Positional args to `npm test` are filename **filters**. DB suites need a fresh test schema — `db:apply` **and** `sync:sports`.

## File Structure

| File | Responsibility |
|---|---|
| `db/migration/deltas/V376__event_imports.sql` | Receipt table, UNIQUE idempotency index, RLS |
| `apps/web/src/lib/db.ts` | Export the existing `Tx` type alias (one line) |
| `apps/web/src/server/engine-db/append-event.ts` | Split: `appendEventInTx` (tx body) + `appendEvent` (wrapper). No behaviour change |
| `apps/web/src/server/usecases/event-import.ts` | The whole import usecase: caps, resolve, dry-run, write loop, receipts, report |
| `apps/web/src/server/api-v1/schemas.ts` | `EventImportRequest`, `EventImportReport` |
| `apps/web/src/server/api-v1/openapi.ts` | One `ROUTES` entry |
| `apps/web/src/app/api/v1/divisions/[id]/events/import/route.ts` | HTTP shell: auth, feature gate, delegate |
| `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/import/page.tsx` | Server page: auth, feature gate, renders the client form |
| `.../import/ImportClient.tsx` | Client: file/paste, local JSON parse, POST, report table |
| `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` | Page copy + rejection-code messages |
| `apps/web/content/help/…/batch-import.md` | English-only format documentation |
| `apps/web/e2e/events-import.spec.ts`, `apps/web/e2e/mobile.spec.ts` | E2E happy path + rejected row; width coverage |
| `scripts/smoke.ts` | Import section |

---

### Task 1: Receipt table (V376) and the entitlement key

**Files:**
- Create: `db/migration/deltas/V376__event_imports.sql`
- Test: `apps/web/src/server/usecases/__tests__/event-imports-table.test.ts`

**Interfaces:**
- Produces: table `event_imports (id, org_id, division_id, import_id, fixture_id, events_appended, imported_by, imported_at)` with `unique (division_id, import_id, fixture_id)`.

**Before writing DDL:** load the `supabase-postgres-best-practices` skill. Then re-verify the next free version number — `ls db/migration/deltas | sort -V | tail -3` in the worktree **and** `git log --oneline --all -- db/migration/deltas | head -20`, because a duplicate Flyway version survives a clean rebase. V375 was highest at plan time.

**No `plan_entitlements` row.** `import.events` is granted per org through `org_entitlement_overrides` only (spec §2.4) — a plan row would hand it to every org on that plan, which is the opposite of the staff-only rollout the owner asked for.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/server/usecases/__tests__/event-imports-table.test.ts
import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("event_imports (V376)", () => {
  it("rejects a duplicate (division_id, import_id, fixture_id) at the DDL level", async () => {
    const suffix = randomUUID().slice(0, 8);
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug)
      values (${"Imports " + suffix}, ${"imports-" + suffix}) returning id`;
    const divisionId = randomUUID();
    const fixtureId = randomUUID();

    // Insert twice with the same key; the second must violate the unique index.
    // Written against the raw table so the guarantee is proven in the DDL, not
    // in whatever the usecase does about it later.
    const insert = () => sql`
      insert into event_imports (org_id, division_id, import_id, fixture_id, events_appended)
      values (${orgId}, ${divisionId}, ${"imp-1"}, ${fixtureId}, 3)`;

    await expect(insert()).rejects.toThrow(); // FK on division/fixture — see step 3
  });

  it("has row level security forced", async () => {
    const [row] = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select relrowsecurity, relforcerowsecurity from pg_class where relname = 'event_imports'`;
    expect(row?.relrowsecurity).toBe(true);
    expect(row?.relforcerowsecurity).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p11-batch-import && \
  npx vitest run --reporter=json --outputFile=/tmp/p11-t1.json \
  apps/web/src/server/usecases/__tests__/event-imports-table.test.ts
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p11-t1.json
```

Expected: FAIL — `relation "event_imports" does not exist`. If it reports 0 total, the suite failed to collect; fix that before reading anything as a pass.

- [ ] **Step 3: Write the migration**

Copy the RLS/grant idiom verbatim from `db/migration/deltas/V367__venues_and_courts.sql:59-63` — same `for all to app_user`, same `using`/`with check`, same grant line.

```sql
-- V376__event_imports.sql
-- P11 (D6): one receipt per imported (division, import_id, fixture). The UNIQUE
-- index below IS the idempotency guarantee — a replay collides here, and the
-- usecase converts the violation into `skipped_duplicate`. Deliberately NOT a
-- report store: re-running the call idempotently is how the report is seen again.
--
-- Cascade rather than V367's `on delete restrict`: a receipt whose fixture is
-- gone is meaningless, and restrict would block an organiser from deleting a
-- fixture they imported.
create table event_imports (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  division_id     uuid not null references divisions(id) on delete cascade,
  import_id       text not null,
  fixture_id      uuid not null references fixtures(id) on delete cascade,
  events_appended int  not null,
  imported_by     uuid references users(id) on delete set null,
  imported_at     timestamptz not null default now()
);

create unique index event_imports_key_idx
  on event_imports (division_id, import_id, fixture_id);
create index event_imports_org_idx      on event_imports (org_id);
create index event_imports_division_idx on event_imports (division_id);
create index event_imports_fixture_idx  on event_imports (fixture_id);

alter table event_imports enable row level security;
alter table event_imports force  row level security;
create policy event_imports_tenant on event_imports for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert on event_imports to app_user;
```

Then fix the test's first case to insert real parent rows (a division and a fixture created through the seeding helpers in `apps/web/src/server/usecases/__tests__/scoring-deferred.test.ts:60-111`) so the second insert fails on `event_imports_key_idx`, not on a foreign key. Assert the error message contains `event_imports_key_idx`.

- [ ] **Step 4: Apply and re-run**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p11-batch-import && \
  npm run db:apply && npm run sync:sports
```

Never point this at the local dev DB. Then re-run Step 2's command; expect 2 passed, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add db/migration/deltas/V376__event_imports.sql \
        apps/web/src/server/usecases/__tests__/event-imports-table.test.ts
git commit -m "feat(import): event_imports receipt table with DDL-level idempotency"
```

---

### Task 2: Extract `appendEventInTx` from `appendEvent`

**Files:**
- Modify: `apps/web/src/lib/db.ts:5` (export the `Tx` alias)
- Modify: `apps/web/src/server/engine-db/append-event.ts:131-354`
- Test: `apps/web/src/server/engine-db/__tests__/append-event-in-tx.test.ts`

**Interfaces:**
- Consumes: `withTenant` (`@/lib/db:183`), `Tx` (`@/lib/db:5`, currently unexported).
- Produces:
  ```ts
  export type FirstResult = { distinctId: string; sportKey: string; status: string };
  export async function appendEventInTx(
    tx: Tx, orgId: string, fixtureId: string, expectedSeq: number, input: AppendInput,
  ): Promise<{ appended: AppendResult; firstResult: FirstResult | null }>;
  ```
  `appendEvent`'s own signature is unchanged.

**This is a move, not a rewrite.** The body of the existing `withTenant` callback becomes the new function verbatim — advisory lock, seq check, prior-event read, `resolveFixtureCfg`, snapshot freeze, `foldMatch` with `strictFromSeq`, draw guard, event insert, `match_states` upsert, `fixtures` write, `pg_notify`. If a line changes meaning, the extraction is wrong.

- [ ] **Step 1: Build the shared test rig**

Every later task's tests import this. Create `apps/web/src/server/usecases/__tests__/_rig.ts`, lifting the idioms from `scoring-deferred.test.ts:60-111` (raw-SQL org seed, then usecase calls to build the tournament):

```ts
// apps/web/src/server/usecases/__tests__/_rig.ts
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { startDivision } from "../schedule";

const VARIANT_CONFIG = {
  resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false,
};

export async function seedOrg(): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Import " + suffix}, ${"import-" + suffix}) returning id`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0',
            ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(VARIANT_CONFIG)}, true)
    on conflict do nothing`;
  return { auth: { orgId, via: "session", userId: null, role: "owner", keyId: null } };
}

/** A division with `entrants` entrants and one league stage. `start: false`
 *  leaves it in setup, which is what the phase-gate test needs. */
export async function divisionRig(
  auth: AuthCtx,
  opts: { start?: boolean; entrants?: number; doubleRound?: boolean } = {},
): Promise<{ divisionId: string; fixtureIds: string[] }> {
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31", name: "Import Cup " + randomUUID().slice(0, 6),
    visibility: "public", branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open", sport_key: "generic", variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false, ...(opts.doubleRound ? { rounds: 2 } : {}) },
    eligibility: [],
  });
  const names = Array.from({ length: opts.entrants ?? 2 }, (_, i) => String.fromCharCode(65 + i));
  await createEntrants(auth, division.id, names.map((n, i) => ({
    kind: "individual" as const, display_name: n, seed: i + 1, members: [],
  })));
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "L", config: {} });
  const { fixtures } = await generateStageFixtures(auth, stage.id);
  if (opts.start !== false) await startDivision(auth, division.id);
  return { divisionId: division.id, fixtureIds: fixtures.map((f) => f.id) };
}

export async function startedDivisionWithFixture(
  auth: AuthCtx, opts: { fixtures?: number } = {},
): Promise<{ divisionId: string; fixtureId: string; fixtureIds: string[] }> {
  const rig = await divisionRig(auth, { entrants: opts.fixtures === 2 ? 3 : 2 });
  return { ...rig, fixtureId: rig.fixtureIds[0]! };
}

export async function setupDivisionWithFixture(
  auth: AuthCtx,
): Promise<{ divisionId: string; fixtureId: string }> {
  const rig = await divisionRig(auth, { start: false });
  return { divisionId: rig.divisionId, fixtureId: rig.fixtureIds[0]! };
}

/** The smallest stream that reaches a decided outcome for the generic module:
 *  start, one score each way, finalize. Verify the exact payload shape against
 *  the generic module before relying on it — `foldMatch` is the arbiter. */
export function decidingStream(): Array<{ type: string; payload: Record<string, unknown> }> {
  return [
    { type: "core.start", payload: {} },
    { type: "core.score", payload: { side: "home", points: 3 } },
    { type: "core.score", payload: { side: "away", points: 1 } },
    { type: "core.finalize", payload: {} },
  ];
}
```

The `ext_key` ambiguity test in Task 3 additionally needs two stages, one fixture each — extend `divisionRig` with a `stages` option when you write that test rather than duplicating the builder.

`append-event-in-tx.test.ts` lives under `engine-db/__tests__/`, so import the rig by relative path (`../../usecases/__tests__/_rig`).

- [ ] **Step 2: Write the failing test**

```ts
// apps/web/src/server/engine-db/__tests__/append-event-in-tx.test.ts
// The point of the extraction: two appends in ONE transaction either both
// land or neither does. Looping the public appendEvent commits each event
// separately, so this test is what makes a half-imported fixture impossible.
import { describe, expect, it } from "vitest";
import { withTenant, sql } from "@/lib/db";
import { appendEventInTx } from "../append-event";
import { seedOrg, startedDivisionWithFixture } from "../../usecases/__tests__/_rig";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("appendEventInTx", () => {
  it("rolls back every event in the transaction when a later one is refused", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);

    await expect(
      withTenant(auth.orgId, async (tx) => {
        await appendEventInTx(tx, auth.orgId, fixtureId, 0, { type: "core.start", payload: {} });
        // seq 1 is now the tip; passing 5 is a SEQ_CONFLICT the writer throws on.
        await appendEventInTx(tx, auth.orgId, fixtureId, 5, { type: "core.start", payload: {} });
      }),
    ).rejects.toThrow(/SEQ_CONFLICT|expected seq/);

    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
    expect(rows[0]!.n).toBe(0); // the FIRST event must be gone too
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p11-batch-import && \
  npx vitest run --reporter=json --outputFile=/tmp/p11-t2.json \
  apps/web/src/server/engine-db/__tests__/append-event-in-tx.test.ts
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p11-t2.json
```

Expected: FAIL — `appendEventInTx` is not exported.

- [ ] **Step 4: Do the extraction**

In `apps/web/src/lib/db.ts:5`, change `type Tx = postgres.TransactionSql;` to `export type Tx = postgres.TransactionSql;`.

In `append-event.ts`, the shape becomes:

```ts
export type FirstResult = { distinctId: string; sportKey: string; status: string };

/** The transactional body of an append (spec 03 §5), callable inside a caller's
 *  transaction. `appendEvent` wraps it in `withTenant`; the P11 importer calls
 *  it in a loop so a whole fixture's stream commits or rolls back together.
 *  There is exactly one append path — do not add a second. */
export async function appendEventInTx(
  tx: Tx,
  orgId: string,
  fixtureId: string,
  expectedSeq: number,
  input: AppendInput,
): Promise<{ appended: AppendResult; firstResult: FirstResult | null }> {
  // ← the existing withTenant callback body, moved verbatim
}

export async function appendEvent(
  orgId: string,
  fixtureId: string,
  expectedSeq: number,
  input: AppendInput,
): Promise<AppendResult> {
  const { appended, firstResult } = await withTenant(orgId, (tx) =>
    appendEventInTx(tx, orgId, fixtureId, expectedSeq, input),
  );
  if (firstResult) {
    await captureServer({
      event: EVENTS.RESULT_ENTERED,
      distinctId: firstResult.distinctId,
      orgId,
      properties: { sport_key: firstResult.sportKey, status: firstResult.status, fixture_id: fixtureId },
    });
  }
  return appended;
}
```

- [ ] **Step 5: Prove the extraction changed nothing**

Run the new test **and** the whole existing scoring surface. Scoring's tests are the police here; anything red means the move was not verbatim.

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p11-batch-import && \
  npx vitest run --reporter=json --outputFile=/tmp/p11-t2b.json \
  apps/web/src/server/engine-db apps/web/src/server/usecases/__tests__/scoring-deferred.test.ts \
  apps/web/src/server/usecases/__tests__/scorers.test.ts
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p11-t2b.json
```

Expected: 0 failed, and a total that matches the same command run on `main` before the change. Record both numbers in the PR body.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/db.ts apps/web/src/server/engine-db/ \
        apps/web/src/server/usecases/__tests__/_rig.ts
git commit -m "refactor(scoring): extract appendEventInTx so a caller can own the transaction"
```

---

### Task 3: Import request schema, caps, resolution and the dry-run gate

**Files:**
- Create: `apps/web/src/server/usecases/event-import.ts`
- Modify: `apps/web/src/server/api-v1/schemas.ts`
- Test: `apps/web/src/server/usecases/__tests__/event-import-dryrun.test.ts`

**Interfaces:**
- Consumes: `appendEventInTx` (Task 2 — not called yet), `resolveModule`, `resolveFixtureCfg`, `foldMatch`, `loadLineupPair` (all `@/server/engine-db/*`), `requiredFeatureForEvent` (`@/server/usecases/fidelity:22`), `requireFeature` (`@/lib/entitlements:666`).
- Produces:
  ```ts
  export const IMPORT_CAPS = { streams: 50, eventsPerFixture: 1_000, eventsPerCall: 10_000 } as const;
  export type ImportStreamResult = {
    fixture: string;                                     // resolved id, or the ext_key as given
    status: "imported" | "skipped_duplicate" | "rejected";
    eventsAppended: number;
    outcome?: unknown;
    error?: { code: string; eventIndex?: number; engineCode?: string; feature?: string; matches?: number };
  };
  export type ImportReport = {
    importId: string;
    totals: { imported: number; skipped: number; rejected: number };
    results: ImportStreamResult[];
  };
  export async function importEvents(
    auth: AuthCtx, divisionId: string, input: EventImportRequest,
  ): Promise<ImportReport>;
  ```

This task delivers everything up to and including the dry run: **no writes exist yet**. Every stream that would import returns `rejected` with code `import.not_implemented` at the end of this task; Task 4 replaces that line.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/src/server/usecases/__tests__/event-import-dryrun.test.ts
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { importEvents, IMPORT_CAPS } from "../event-import";
import { seedOrg, startedDivisionWithFixture, setupDivisionWithFixture } from "./_rig";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("importEvents — guards and dry run", () => {
  it("rejects the whole stream when an event mid-stream is invalid, and writes NOTHING", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);

    const report = await importEvents(auth, divisionId, {
      import_id: "imp-invalid",
      streams: [{
        fixture: { id: fixtureId },
        events: [
          { type: "core.start", payload: {} },
          { type: "core.not_a_real_event", payload: {} },   // ← index 1
          { type: "core.finalize", payload: {} },
        ],
      }],
    });

    expect(report.results[0]!.status).toBe("rejected");
    expect(report.results[0]!.error?.code).toBe("import.fold_rejected");
    expect(report.results[0]!.error?.eventIndex).toBe(1);
    // The assertion that matters: the ledger, not the response.
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
    expect(n).toBe(0);
  });

  it("rejects a fixture that already has events", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    await sql`insert into score_events (fixture_id, org_id, seq, type, payload)
              values (${fixtureId}, ${auth.orgId}, 1, 'core.start', '{}'::jsonb)`;

    const report = await importEvents(auth, divisionId, {
      import_id: "imp-started",
      streams: [{ fixture: { id: fixtureId }, events: [{ type: "core.start", payload: {} }] }],
    });
    expect(report.results[0]!.error?.code).toBe("import.fixture_started");
  });

  it("refuses the whole call when the division has not started", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await setupDivisionWithFixture(auth);
    await expect(
      importEvents(auth, divisionId, {
        import_id: "imp-phase",
        streams: [{ fixture: { id: fixtureId }, events: [{ type: "core.start", payload: {} }] }],
      }),
    ).rejects.toMatchObject({ status: 409, code: "import.division_not_started" });
  });

  it("rejects a stream that never reaches a decided outcome", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    const report = await importEvents(auth, divisionId, {
      import_id: "imp-open",
      streams: [{ fixture: { id: fixtureId }, events: [{ type: "core.start", payload: {} }] }],
    });
    expect(report.results[0]!.error?.code).toBe("import.not_decided");
  });

  it("413s a call over the per-call event cap", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    const events = Array.from({ length: IMPORT_CAPS.eventsPerCall + 1 }, () => ({
      type: "core.start", payload: {},
    }));
    await expect(
      importEvents(auth, divisionId, { import_id: "imp-big", streams: [{ fixture: { id: fixtureId }, events }] }),
    ).rejects.toMatchObject({ status: 413, code: "import.too_large" });
  });

  it("rejects an ext_key that matches two fixtures in the division", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureIds } = await startedDivisionWithFixture(auth, { fixtures: 2 });
    await sql`update fixtures set ext_key = 'M1' where id in ${sql(fixtureIds)}`;
    const report = await importEvents(auth, divisionId, {
      import_id: "imp-ambig",
      streams: [{ fixture: { ext_key: "M1" }, events: [{ type: "core.start", payload: {} }] }],
    });
    expect(report.results[0]!.error).toMatchObject({ code: "import.fixture_unknown", matches: 2 });
  });
});
```

Note the ext_key case needs the two fixtures to sit in **different stages** for the `fixtures_stage_ext_key_idx` unique index to permit the duplicate — build the rig accordingly (two stages, one fixture each).

- [ ] **Step 2: Run and watch them fail**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p11-batch-import && \
  npx vitest run --reporter=json --outputFile=/tmp/p11-t3.json \
  apps/web/src/server/usecases/__tests__/event-import-dryrun.test.ts
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p11-t3.json
```

Expected: FAIL — `../event-import` does not exist.

- [ ] **Step 3: Write the schema**

In `apps/web/src/server/api-v1/schemas.ts`, beside the other request schemas:

```ts
/** P11 (D6) batch score-event import. `seq` is assigned server-side 0..n — a
 *  caller never sends one. `core.void` is refused here rather than downstream:
 *  a void is a live-scoring undo, and a wrong import is re-run under a new
 *  import_id (owner ruling R2). */
export const EventImportRequest = z.object({
  import_id: z.string().min(1).max(200),
  streams: z.array(
    z.object({
      fixture: z.union([
        z.object({ id: z.uuid() }),
        z.object({ ext_key: z.string().min(1).max(200) }),
      ]),
      events: z.array(
        z.object({
          type: z.string().min(1).refine((t) => t !== "core.void", {
            message: "core.void cannot be imported",
          }),
          payload: z.record(z.string(), z.unknown()).default({}),
          at: z.string().optional(),
        }),
      ).min(1),
    }),
  ).min(1),
});
export type EventImportRequest = z.infer<typeof EventImportRequest>;

export const EventImportReport = z.object({
  importId: z.string(),
  totals: z.object({ imported: z.number(), skipped: z.number(), rejected: z.number() }),
  results: z.array(
    z.object({
      fixture: z.string(),
      status: z.enum(["imported", "skipped_duplicate", "rejected"]),
      eventsAppended: z.number(),
      outcome: z.unknown().optional(),
      error: z.object({ code: z.string() }).loose().optional(),
    }),
  ),
});
```

Match the zod idiom of the surrounding file (check whether it uses `z.uuid()` or `z.string().uuid()` on this version and follow it).

- [ ] **Step 4: Write the usecase up to the dry run**

`apps/web/src/server/usecases/event-import.ts`:

```ts
import "server-only";
import { sql, withTenant } from "@/lib/db";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { requireFeature } from "@/lib/entitlements";
import { EngineError } from "@seazn/engine/core";
import { foldMatch } from "@seazn/engine/core";
import { resolveModule } from "@/server/engine-db/modules";
import { resolveFixtureCfg } from "@/server/engine-db/fixture-cfg";
import { loadLineupPair } from "@/server/engine-db/lineups";
import { requiredFeatureForEvent } from "./fidelity";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { EventImportRequest } from "@/server/api-v1/schemas";

export const IMPORT_CAPS = { streams: 50, eventsPerFixture: 1_000, eventsPerCall: 10_000 } as const;

// … types from the Interfaces block above …

export async function importEvents(
  auth: AuthCtx,
  divisionId: string,
  input: EventImportRequest,
): Promise<ImportReport> {
  assertWithinCaps(input);              // 413 import.too_large, names the ceiling
  const division = await loadDivision(auth, divisionId);   // pooled read
  if (division.status === "setup" || division.status === "scheduled") {
    throw new HttpError(409, "division has not started", { code: "import.division_not_started" });
  }
  const results: ImportStreamResult[] = [];
  for (const stream of input.streams) {           // sequential, by design
    results.push(await runStream(auth, division, input.import_id, stream));
  }
  return report(input.import_id, results);
}
```

`runStream` does, in order — and **all pooled reads and entitlement checks happen before any transaction opens**, because a pooled query inside `withTenant` is a pool self-deadlock (`db.ts:179-181`):

1. Resolve the fixture: `{id}` → verify it belongs to `divisionId`; `{ext_key}` → `select id from fixtures where division_id = … and ext_key = …`; `rows.length !== 1` → `import.fixture_unknown` with `matches: rows.length`.
2. `select count(*) from score_events where fixture_id = …` non-zero, or a live/decided status → `import.fixture_started`.
3. Unassigned entrant (`home_entrant_id` or `away_entrant_id` null) → `import.slots_unfilled`.
4. Per event: `requiredFeatureForEvent(module, type)`; for each distinct non-null key, `requireFeature(auth.orgId, key)` inside try/catch — `PaymentRequiredError` → `import.entitlement` with `feature`.
5. Dry run inside its own **read-only** `withTenant`: `loadLineupPair`, `resolveFixtureCfg`, then `foldMatch(module, cfg, lineups, stream, { strictFromSeq: 1 })` over the whole stream built as envelopes with seq 1..n. An `EngineError` → `import.fold_rejected` with `{ eventIndex, engineCode: err.code }`. A final `module.outcome(state) === null` → `import.not_decided`.
6. Return `{ status: "rejected", error: { code: "import.not_implemented" }, eventsAppended: 0 }` — replaced in Task 4.

Build the dry-run envelopes with the same field names `appendEventInTx` uses (`id`, `fixtureId`, `seq`, `type`, `payload`, `recordedAt`, `recordedBy`) so the fold sees exactly what the writer will later hand it.

- [ ] **Step 5: Run the tests to green**

Re-run Step 2's command. Expected: 6 passed, 0 failed. The "writes NOTHING" assertion is the one to check by eye — if it passes only because the code never gets that far, it will keep passing in Task 4, which is the point.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/usecases/event-import.ts \
        apps/web/src/server/api-v1/schemas.ts \
        apps/web/src/server/usecases/__tests__/event-import-dryrun.test.ts
git commit -m "feat(import): request schema, caps, fixture resolution and the dry-run gate"
```

---

### Task 4: The write path — one transaction per fixture, receipts, side effects

**Files:**
- Modify: `apps/web/src/server/usecases/event-import.ts`
- Test: `apps/web/src/server/usecases/__tests__/event-import-write.test.ts`

**Interfaces:**
- Consumes: `appendEventInTx` (Task 2), the receipt table (Task 1), `onDecided` / `refreshDiscipline` / `refreshNews` — currently private in `scoring.ts`; export them there (no behaviour change) rather than reimplementing.
- Produces: `importEvents` returning real `imported` / `skipped_duplicate` results.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/src/server/usecases/__tests__/event-import-write.test.ts
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { importEvents } from "../event-import";
import { seedOrg, startedDivisionWithFixture, decidingStream } from "./_rig";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("importEvents — writes", () => {
  it("appends the stream, decides the fixture and records one receipt", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);

    const report = await importEvents(auth, divisionId, {
      import_id: "imp-ok",
      streams: [{ fixture: { id: fixtureId }, events: decidingStream() }],
    });

    expect(report.results[0]!.status).toBe("imported");
    expect(report.totals).toEqual({ imported: 1, skipped: 0, rejected: 0 });

    const seqs = await sql<{ seq: number }[]>`
      select seq from score_events where fixture_id = ${fixtureId} order by seq`;
    expect(seqs.map((r) => r.seq)).toEqual(seqs.map((_, i) => i + 1)); // gapless
    const [fixture] = await sql<{ status: string; outcome: unknown }[]>`
      select status, outcome from fixtures where id = ${fixtureId}`;
    expect(fixture!.outcome).not.toBeNull();
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from event_imports
      where division_id = ${divisionId} and import_id = ${"imp-ok"}`;
    expect(n).toBe(1);
  });

  it("rolls the whole fixture back when an append fails mid-stream", async () => {
    // A stream that the dry run accepts but the writer refuses: score the
    // fixture's first event through the live path AFTER the dry run has run is
    // not reproducible here, so force it by importing the same fixture twice
    // concurrently is also racy. Instead: import a stream, then import a
    // DIFFERENT import_id into the same (now started) fixture — the guard
    // rejects it before any write, and the ledger is unchanged.
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    await importEvents(auth, divisionId, {
      import_id: "imp-first",
      streams: [{ fixture: { id: fixtureId }, events: decidingStream() }],
    });
    const before = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;

    const second = await importEvents(auth, divisionId, {
      import_id: "imp-second",
      streams: [{ fixture: { id: fixtureId }, events: decidingStream() }],
    });
    expect(second.results[0]!.error?.code).toBe("import.fixture_started");
    const after = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("replays the same import_id as skipped_duplicate without appending", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    const call = () => importEvents(auth, divisionId, {
      import_id: "imp-replay",
      streams: [{ fixture: { id: fixtureId }, events: decidingStream() }],
    });
    await call();
    const [{ n: first }] = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;

    const again = await call();
    expect(again.results[0]!.status).toBe("skipped_duplicate");
    expect(again.results[0]!.eventsAppended).toBe(0);
    const [{ n: second }] = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
    expect(second).toBe(first);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p11-batch-import && \
  npx vitest run --reporter=json --outputFile=/tmp/p11-t4.json \
  apps/web/src/server/usecases/__tests__/event-import-write.test.ts
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p11-t4.json
```

Expected: FAIL — every stream still returns `import.not_implemented`.

- [ ] **Step 3: Implement the write**

Replace Task 3's step 6 placeholder with, per stream:

```ts
// The receipt check runs FIRST, on the pooled proxy: a replay must not even
// open a transaction. The UNIQUE index below is still the real guarantee —
// this read only makes the common case cheap and the message honest.
const [existing] = await sql<{ events_appended: number }[]>`
  select events_appended from event_imports
  where division_id = ${divisionId} and import_id = ${importId} and fixture_id = ${fixtureId}`;
if (existing) return { fixture: fixtureId, status: "skipped_duplicate", eventsAppended: 0 };

let firstResult: FirstResult | null = null;
let last: AppendResult | null = null;
try {
  await withTenant(auth.orgId, async (tx) => {
    for (const [i, ev] of stream.events.entries()) {
      const r = await appendEventInTx(tx, auth.orgId, fixtureId, i, {
        type: ev.type,
        payload: ev.payload,
        recordedBy: auth.userId,
        ...(ev.at ? { recordedAt: ev.at } : {}),
      });
      firstResult ??= r.firstResult;
      last = r.appended;
    }
    // Same transaction as the events it certifies: a crash between the two
    // can never leave an imported fixture with no receipt (or the reverse).
    await tx`
      insert into event_imports (org_id, division_id, import_id, fixture_id, events_appended, imported_by)
      values (${auth.orgId}, ${divisionId}, ${importId}, ${fixtureId},
              ${stream.events.length}, ${auth.userId})`;
  });
} catch (err) {
  if (isUniqueViolation(err, "event_imports_key_idx")) {
    return { fixture: fixtureId, status: "skipped_duplicate", eventsAppended: 0 };
  }
  if (err instanceof EngineError) {
    return { fixture: fixtureId, status: "rejected", eventsAppended: 0,
             error: { code: "import.fold_rejected", engineCode: err.code } };
  }
  throw err;
}
```

After the transaction commits — never inside it — fire the decided side effects in the same order `scoreEvent` uses (`scoring.ts:130-133`): `onDecided(auth, fixtureId, last.outcome)`, `refreshDiscipline(auth, fixtureId)`, `refreshNews(auth, fixtureId)`; then `captureServer` once if `firstResult`. Export those three from `scoring.ts` unchanged; do not copy their bodies.

Then log once per call, after the loop:

```ts
log.info(
  { division: divisionId, import_id: input.import_id, streams: input.streams.length,
    appended, rejected, ms: Math.round(performance.now() - startedAt) },
  "events_imported",
);
```

- [ ] **Step 4: Run to green, then run Task 3's suite too**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p11-batch-import && \
  npx vitest run --reporter=json --outputFile=/tmp/p11-t4b.json \
  apps/web/src/server/usecases/__tests__/event-import-write.test.ts \
  apps/web/src/server/usecases/__tests__/event-import-dryrun.test.ts
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p11-t4b.json
```

Expected: 9 passed, 0 failed. Task 3's "writes NOTHING" test must still pass now that writes exist — that transition is the whole point of ordering the tasks this way.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/usecases/
git commit -m "feat(import): one transaction per fixture, receipts and decided side effects"
```

---

### Task 5: Route, OpenAPI, feature gate, concurrency lock

**Files:**
- Create: `apps/web/src/app/api/v1/divisions/[id]/events/import/route.ts`
- Modify: `apps/web/src/server/api-v1/openapi.ts`
- Test: `apps/web/src/server/usecases/__tests__/event-import-route.test.ts`

**Interfaces:**
- Consumes: `v1`, `parseBody` (`@/server/api-v1/http`), `requireResourceAuth` (`@/server/api-v1/auth:348`), `requireFeature`, `importEvents`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/src/server/usecases/__tests__/event-import-route.test.ts
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { POST } from "@/app/api/v1/divisions/[id]/events/import/route";
import { seedOrg, startedDivisionWithFixture, decidingStream } from "./_rig";

const HAS_DB = !!process.env.DATABASE_URL;

/** Grant one boolean feature to an org out-of-plan — the same row
 *  `setBoolEntitlementOverrideSql` writes (apps/web/e2e/helpers.ts:342) and the
 *  only way `import.events` is held during rollout (spec §2.4). */
async function grant(orgId: string, key: string) {
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, bool_value)
    values (${orgId}, ${key}, true)
    on conflict (org_id, feature_key) do update set bool_value = true`;
}

const call = (divisionId: string, body: unknown, headers: HeadersInit = {}) =>
  POST(
    new Request(`http://localhost/api/v1/divisions/${divisionId}/events/import`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: divisionId }) },
  );

describe.skipIf(!HAS_DB)("POST /divisions/{id}/events/import", () => {
  it("402s an org without the import.events entitlement", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    const res = await call(divisionId, {
      import_id: "imp-402",
      streams: [{ fixture: { id: fixtureId }, events: decidingStream() }],
    });
    expect(res.status).toBe(402);
  });

  it("imports once the entitlement is granted", async () => {
    const { auth } = await seedOrg();
    await grant(auth.orgId, "import.events");
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    const res = await call(divisionId, {
      import_id: "imp-200",
      streams: [{ fixture: { id: fixtureId }, events: decidingStream() }],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.totals).toEqual({ imported: 1, skipped: 0, rejected: 0 });
  });

  it("409s a second call with the same import_id while the first is in flight", async () => {
    const { auth } = await seedOrg();
    await grant(auth.orgId, "import.events");
    const { divisionId, fixtureIds } = await startedDivisionWithFixture(auth, { fixtures: 2 });
    const payload = (fixtureId: string) => ({
      import_id: "imp-concurrent",
      streams: [{ fixture: { id: fixtureId }, events: decidingStream() }],
    });
    const [a, b] = await Promise.all([
      call(divisionId, payload(fixtureIds[0]!)),
      call(divisionId, payload(fixtureIds[1]!)),
    ]);
    // One wins; the loser is refused rather than interleaving with it.
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect((await loser.json()).error.code).toBe("import.concurrent");
  });
});
```

The auth in these tests comes from the session the request carries; if the route test harness in this repo builds `AuthCtx` differently (check a neighbouring route test before writing), follow that instead — do not weaken the assertions to fit a harness mismatch.

The 403-for-non-admin case is covered by `requireResourceAuth`'s own tests; do not re-prove it here.

- [ ] **Step 2: Run and watch fail**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p11-batch-import && \
  npx vitest run --reporter=json --outputFile=/tmp/p11-t5.json \
  apps/web/src/server/usecases/__tests__/event-import-route.test.ts
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p11-t5.json
```

- [ ] **Step 3: Write the route**

```ts
import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { requireFeature } from "@/lib/entitlements";
import { EventImportRequest } from "@/server/api-v1/schemas";
import { importEvents } from "@/server/usecases/event-import";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/v1/divisions/{id}/events/import — P11 (D6). Returns 200 whenever
 *  the CALL executed; per-stream outcomes are data, not transport errors. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "write");
    await requireFeature(auth.orgId, "import.events");   // 402 during rollout
    const body = await parseBody(req, EventImportRequest);
    return reply(200, await importEvents(auth, id, body));
  });
}
```

Check `parseBody`'s real name and signature in `http.ts` before writing this — the entrants route imports it, so it exists, but confirm the argument order.

The concurrency lock goes in the usecase, not the route: wrap the whole call in `select pg_try_advisory_xact_lock(hashtext($1))` over `import:{divisionId}:{importId}`, and throw `HttpError(409, …, { code: "import.concurrent" })` when it is not acquired.

- [ ] **Step 4: Register in OpenAPI and regenerate**

```ts
{ path: "/divisions/{id}/events/import", method: "post",
  summary: "Batch-import score events into unstarted fixtures (D6)",
  tag: "scoring", request: S.EventImportRequest, response: S.EventImportReport,
  errors: [402, 403, 404, 409, 413] },
```

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p11-batch-import && \
  npm run openapi:gen && git status --porcelain
```

The generated file must be committed in the same commit — an uncommitted regen output is the pre-commit drift gate's red.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/api/v1/divisions/ apps/web/src/server/api-v1/openapi.ts openapi/
git commit -m "feat(import): POST /divisions/{id}/events/import behind the import.events entitlement"
```

---

### Task 6: The three regression proofs

**Files:**
- Test: `apps/web/src/server/usecases/__tests__/event-import-regression.test.ts`

This task adds no production code. If a proof cannot be made to pass, that is a defect in Tasks 1-5 — fix it there, do not weaken the assertion.

- [ ] **Step 1: (a) the twin — derived state**

Build a league whose two entrants meet **twice** (double round-robin), so fixtures A and B share entrant identity. Score A event-by-event through `scoreEvent`; import the identical stream into B. Assert equality of `match_states.summary`, `match_states.last_seq`, `fixtures.outcome`, `fixtures.status`, `fixtures.config_snapshot`, and that B's `seq` values are gapless 1..n.

Do **not** assert hash equality: `V226`'s canonical string includes the event id, the fixture id and `recorded_at`, so twin hashes cannot match (spec §2.2). Assert chain *integrity* on B instead:

```ts
const rows = await sql<{ seq: number; prev_hash: string | null; row_hash: string }[]>`
  select seq, prev_hash, row_hash from score_events where fixture_id = ${bId} order by seq`;
rows.forEach((r, i) => {
  expect(r.prev_hash).toBe(i === 0 ? null : rows[i - 1]!.row_hash);
});
```

- [ ] **Step 2: (b) careers day one — read path**

Import a decided fixture, then call `divisionPlayerStats` and `personStats` (`@/server/usecases/player-stats`) and assert the imported appearances/points show up. This is a **read-path** test on purpose: stats are recompute-on-read with no call site in the scoring chain (spec §2.1), so a test that waited for a side effect would pass vacuously forever.

- [ ] **Step 3: (c) replay — byte-identical state**

Snapshot `score_events` (all columns, ordered by seq), `match_states`, the fixture row and `event_imports` into plain objects; replay the same `import_id`; re-read and `toEqual` each snapshot. Additionally assert the news-draft count is unchanged, which is what proves the post-commit side effects did not re-fire.

- [ ] **Step 4: Run all three**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p11-batch-import && \
  npx vitest run --reporter=json --outputFile=/tmp/p11-t6.json \
  apps/web/src/server/usecases/__tests__/event-import-regression.test.ts
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p11-t6.json
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/usecases/__tests__/event-import-regression.test.ts
git commit -m "test(import): twin state parity, careers day one, byte-identical replay"
```

---

### Task 7: The division import page and its four dictionaries

**Files:**
- Create: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/import/page.tsx`
- Create: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/import/ImportClient.tsx`
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`

**Interfaces:**
- Consumes: `requireDivisionPage` (`@/server/page-auth:208`), `hasFeature` (`@/lib/entitlements:454`), the route from Task 5.

- [ ] **Step 1: Server page**

`requireDivisionPage(orgSlug, compSlug, divSlug)` for auth and org scoping, then `hasFeature(orgId, "import.events")` — false → `notFound()`. During rollout the surface is invisible to orgs without the grant, and the console gets **no** link to it.

- [ ] **Step 2: Client form**

A `.json` file picker and a paste textarea feeding one state value; `JSON.parse` locally before submit so a malformed file is a local error naming the position, not a round trip; POST to the Task 5 route; render `results` verbatim as a table — fixture (linked), status, events appended, outcome, error — plus a totals row. Status is a text chip (`imported` / `skipped (duplicate)` / `rejected`); colour reinforces, never carries meaning alone. The textarea keeps its contents after submit: re-running is how the report is seen again.

The table lives in its own `overflow-x: auto` container so the page never scrolls horizontally at 320.

- [ ] **Step 3: Strings ×4**

Add flat dotted keys to all four dictionaries — page title, field labels, submit, empty state, totals, and one message per code: `import.fixture_started`, `import.fixture_unknown`, `import.fold_rejected` (interpolating `eventIndex` and `engineCode`), `import.not_decided`, `import.entitlement`, `import.slots_unfilled`, `import.too_large`, `import.concurrent`, `import.division_not_started`. Then:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p11-batch-import && \
  npm run i18n:gen-keys && git status --porcelain
```

`i18n-keys.ts` is generated — commit its regeneration in this task's commit.

- [ ] **Step 4: Screenshots**

Load the page at 1280, 320 and 768 with a report rendered (submit a two-stream payload, one good and one rejected). Confirm no horizontal page scroll at any width. Attach all three to the PR.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/o/ apps/web/src/dictionaries/ apps/web/src/lib/i18n-keys.ts
git commit -m "feat(import): division import page with per-stream report table"
```

---

### Task 8: E2E — happy path, a rejected row, and width coverage

**Files:**
- Create: `apps/web/e2e/events-import.spec.ts`
- Modify: `apps/web/e2e/mobile.spec.ts`

- [ ] **Step 1: Spec**

Grant `import.events` to the test org with `setBoolEntitlementOverrideSql` (`e2e/helpers.ts:342`), seed a started division with two unstarted fixtures, paste a payload with one deciding stream and one stream naming an unknown `ext_key`, submit, and assert the table shows one `imported` row and one `rejected` row carrying `import.fixture_unknown`.

Anchor every attribute assertion on `="` — React serialises an omitted prop as `"$undefined"`, so a bare `data-*` probe passes in both states. Use `localhost`, never `127.0.0.1` (the session cookie is `Secure` and is dropped on the IP form).

- [ ] **Step 2: Width coverage**

Add the page to `apps/web/e2e/mobile.spec.ts` alongside the other division-console surfaces. A surface absent from that file has **zero** width coverage regardless of how many other specs touch it.

- [ ] **Step 3: Run**

```bash
cd /Users/ashokhein/github/seazn.club/apps/web && \
  PLAYWRIGHT_BASE_URL=http://localhost:3100 npx playwright test events-import.spec.ts
```

Playwright needs `apps/web` as cwd and the base URL set. Assert the server on 3100 is yours (`lsof -t -sTCP:LISTEN -i:3100`) before believing a pass. Never run a long e2e inside a subagent — the 600s watchdog kills it and reports success.

- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e/
git commit -m "test(e2e): import page happy path, rejected stream row, seven widths"
```

---

### Task 9: Smoke section

**Files:**
- Modify: `scripts/smoke.ts`

- [ ] **Step 1: Add `eventImportSuite()`**

Follow the shape of the existing suites (`personMergeSuite` at `scripts/smoke.ts:1197`): open a `Session`, `signIn(s, email)`, grant `import.events` to the org, seed a division with one unstarted fixture, POST a deciding stream, then `check(...)` that the fixture shows an outcome, that division stats show the imported appearance, and that an auto-draft news post exists. Call it from `main()` in sequence with the others.

- [ ] **Step 2: Run**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p11-batch-import && npm run smoke
```

Paste the raw pass/fail counts into the PR body. The AI section is gated off locally — that is expected, not a failure.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke.ts
git commit -m "test(smoke): import a finished match and assert outcome, stats and news draft"
```

---

### Task 10: Help page, gates, and session close

**Files:**
- Create: `apps/web/content/help/…/batch-import.md` (pick the section matching the existing tree; it is filesystem-routed — `help-content.ts:90` — so there is no manifest to edit)
- Modify: `docs/superpowers/specs/bench-product-value/portfolio-prompts/_INDEX.md`

- [ ] **Step 1: Help page (English only)**

Document: the JSON shape with a worked per-sport example; `seq` is server-assigned; `core.void` is not importable; the three caps and how to chunk; the idempotency contract (same `import_id` replays as `skipped_duplicate`, a corrected file needs a new one); and the ordering constraint — **start the division before importing**. No i18n owed on `content/help/**`.

- [ ] **Step 2: Full gates**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p11-batch-import && \
  npx vitest run --reporter=json --outputFile=/tmp/p11.json apps/web/src/server
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p11.json
rtk proxy npm run lint
npm run openapi:gen && git status --porcelain
npm run i18n:gen-keys && git status --porcelain
```

Read `✖ N problems` from the lint output — rtk hides `npm run lint`'s result, and "ESLint output (JSON parse failed)" is the wrapper losing it, not a clean run. Confirm the resolved paths in `.testResults[].name` are inside the worktree before believing any count.

- [ ] **Step 3: Review**

Invoke `superpowers:requesting-code-review` and run `/code-review`. Note that `/code-review` reviews `main`, not the worktree, unless pointed at the branch — target the branch explicitly. The reviewer's first two checks: no reimplemented append (diff the import write path against `scoreEvent`'s), and idempotency enforced at DDL level rather than in app code.

- [ ] **Step 4: Close the index**

Update the P11 row in `_INDEX.md` to DONE with a one-line outcome, and add the false premises from spec §2 to the status log **as discovered**. Write memory at the decision points (`project_product_portfolio_programme` plus the traps as reference files) and run `scripts/agent-memory-snapshot.sh`. Name any deferred test type in both the PR body and the index row.

- [ ] **Step 5: PR**

One PR for the session. Body carries: the four test-type counts (raw), the three screenshots, the `Unplanned fixes` list, and the two spec corrections made during planning (twin hashes impossible; no `plan_entitlements` row during rollout).
