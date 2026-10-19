// Tripwire for the connection-pool self-deadlock.
//
// `withTenant` is `getClient().begin()`, which PINS one pooled connection for
// the whole callback. Any query issued on the pooled `sql` proxy from inside
// that callback asks the SAME pool for a second connection while the first is
// still held. With the production pool (`max: 5`, lib/db.ts) five concurrent
// renders reaching such a line pin all five slots and queue for a sixth that
// can never exist. postgres.js has no queue-wait timeout, so the deadlock is
// PERMANENT: the process sits at ~0% CPU serving static routes 200 while every
// DB-touching route — `/api/health` included — hangs for ever. Observed live
// twice on 2026-08-05 (five connections per process `idle in transaction`,
// `wait_event=ClientRead`, no COMMIT ever sent).
//
// The guard here is a pool of ONE. At `max: 1` the same nesting deadlocks
// deterministically on a single call instead of only under five-way
// concurrency — no race, no load dependence — so a regression fails this test
// on the first run rather than in production one cold cache later.
//
// Adding a case: seed under the normal pool, then run the read path inside
// `withOneSlotPool`. Anything that must NOT nest a pooled query inside
// `withTenant` belongs here.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { clearNestingViolations, connectionOptions, nestingViolations, sql, withTenant } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateEntrant } from "@/server/api-v1/schemas";
import { getCompetition, listCompetitions, createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import {
  createEntrants,
  deleteEntrant,
  divisionRoster,
  getEntrant,
  listEntrants,
  patchEntrant,
  setEntrantBadge,
  syncEntrantRosterFromSquad,
} from "@/server/usecases/entrants";
import { createStages, deleteStage } from "@/server/usecases/stages";
import { putScheduleSettings } from "@/server/usecases/schedule";
import { buildDivisionDocModel } from "@/server/usecases/exports";
import { importEvents } from "@/server/usecases/event-import";
import { seedCourts } from "./_seed";
import { seedOrg, startedDivisionWithFixture, decidingStream } from "./_rig";
import { seedOwner as seedChessOwner, seedPlayer, type SeedPlayer } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;

/** Long enough that a slow local Postgres is never mistaken for a deadlock,
 *  short enough that the failure is a red test and not a hung suite. */
const DEADLOCK_TIMEOUT_MS = 5_000;

/** The pool production runs: the default `connectionOptions` derives with no `DB_POOL_MAX` set. Read, not typed,
 *  so a change to that default moves the concurrency cases with it. */
const PRODUCTION_POOL_MAX = connectionOptions("postgresql://u@localhost:5432/d", {}).max;

/** The bound for a whole concurrent batch: pool-max + 1 creates through a contended pool take a second or so on a
 *  healthy local Postgres; a deadlock never settles, so any bound well above that tells the two apart. */
const CONCURRENT_BOUND_MS = 15_000;

function deadlockMessage(what: string, max: number, timeoutMs: number): string {
  return (
    `${what} did not settle within ${timeoutMs}ms against a ${max === 1 ? "ONE-SLOT" : `${max}-slot`} connection pool. ` +
    `This is the connection-pool self-deadlock, not flakiness: something on this code path ran a ` +
    `query on the pooled \`sql\` proxy (an entitlement/limit helper, a cache-miss lookup, another ` +
    `usecase) while \`withTenant\` still held a pooled connection — a nested pooled query while a ` +
    `transaction was open. In production (max: 5) it hangs the whole server process once five ` +
    `concurrent requests reach it, permanently. Fix the call site the same way \`getCompetition\` ` +
    `and \`autoSchedule\` do: finish and CLOSE the transaction first, then do the pooled work.`
  );
}

/**
 * Run `fn` against a freshly built one-slot pool, failing fast instead of
 * hanging. `lib/db.ts` caches its client on globalThis and sizes it from
 * `DB_POOL_MAX`, so dropping the cached client with the env var set forces the
 * next `getClient()` to build a `max: 1` client; both are restored afterwards
 * so the rest of the suite keeps the normal pool.
 */
type CachedClient = { end?: (o: unknown) => Promise<void> };

async function withOneSlotPool<T>(what: string, fn: () => Promise<T>): Promise<T> {
  return withPoolOf(1, what, fn);
}

/** The same swap for a pool of `max` — for the cases whose claim is about CONCURRENCY ("pool-max + 1 callers all
 *  finish"), which a pool of one cannot express. `timeoutMs` is the bound the whole batch must settle inside. */
async function withPoolOf<T>(
  max: number,
  what: string,
  fn: () => Promise<T>,
  timeoutMs: number = DEADLOCK_TIMEOUT_MS,
): Promise<T> {
  const g = globalThis as unknown as { _sql?: CachedClient };
  const savedClient = g._sql;
  const savedMax = process.env.DB_POOL_MAX;
  process.env.DB_POOL_MAX = String(max);
  delete g._sql;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = fn();
    // The losing side of the race must not surface as an unhandled rejection
    // when the one-slot client is destroyed below.
    void work.catch(() => {});
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(deadlockMessage(what, max, timeoutMs))), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    // Cast: the `delete` above narrows the property to `undefined` for the rest
    // of the function, but `getClient()` has since re-populated it.
    const oneSlot = g._sql as CachedClient | undefined;
    g._sql = savedClient;
    if (savedMax === undefined) delete process.env.DB_POOL_MAX;
    else process.env.DB_POOL_MAX = savedMax;
    if (oneSlot?.end) await oneSlot.end({ timeout: 0 }).catch(() => {});
  }
}

/** Org + competition by raw SQL — seeding must not itself depend on the path
 *  under test, and it runs under the NORMAL pool, before the swap. */
async function seedCompetition(): Promise<{ auth: AuthCtx; compId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Pool " + suffix}, ${"pool-" + suffix}) returning id`;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, status)
    values (${orgId}, ${"Pool Cup " + suffix}, ${"pool-cup-" + suffix}, 'draft')
    returning id`;
  return {
    auth: { orgId, via: "session", userId: null, role: "owner", keyId: null },
    compId,
  };
}

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

/**
 * A competition + division + stage, built through the REAL usecases under the
 * NORMAL pool.
 *
 * Seeding through the usecases is safe here and raw SQL is not worth its
 * brittleness: a single sequential caller against `max: 5` needs at most two
 * slots even where a path still nests, so the seed cannot deadlock. Only the
 * call under test runs against the one-slot pool, and that is where the claim
 * lives.
 */
async function seedDivision(): Promise<{
  auth: AuthCtx;
  compId: string;
  divisionId: string;
  stageId: string;
}> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Pool " + suffix}, ${"pool-" + suffix}) returning id`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(DIVISION_CONFIG)}, true)
    on conflict do nothing`;
  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Pool Cup " + suffix,
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "L",
    config: {},
  });
  return { auth, compId: competition.id, divisionId: division.id, stageId: stage.id };
}

/** Turn a boolean entitlement on for one org, bypassing the plan matrix. */
async function grant(orgId: string, featureKey: string): Promise<void> {
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, bool_value)
    values (${orgId}, ${featureKey}, true)
    on conflict (org_id, feature_key) do update set bool_value = true`;
}

describe.skipIf(!HAS_DB)("connection-pool nesting tripwire", () => {
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("getCompetition completes against a one-slot pool", async () => {
    const { auth, compId } = await seedCompetition();

    const row = await withOneSlotPool("getCompetition", () => getCompetition(auth, compId));

    expect(row.id).toBe(compId);
    // The entitlement read is the query that used to nest — assert the field it
    // produces, so a "fix" that simply stopped computing `frozen` fails too.
    expect(row.frozen).toBe(false);
  });

  // The 404 guard moved OUT of the transaction with the fix; pin that it still
  // fires (and fires as a 404, not as the deadlock timeout).
  it("getCompetition still 404s for an unknown id, outside the transaction", async () => {
    const { auth } = await seedCompetition();

    await expect(
      withOneSlotPool("getCompetition(404)", () => getCompetition(auth, randomUUID())),
    ).rejects.toMatchObject({ status: 404 });
  });

  // The LIST endpoint, which is hotter than the detail one — an org home renders
  // it on every visit — and which carried the identical nesting.
  it("listCompetitions completes against a one-slot pool", async () => {
    const { auth, compId } = await seedCompetition();

    const result = await withOneSlotPool("listCompetitions", () =>
      listCompetitions(auth, { cursor: null, limit: 50 }),
    );

    expect(result.items.map((c) => c.id)).toEqual([compId]);
    // Same reason as the detail case: assert the field the entitlement read
    // produces, so a "fix" that simply dropped the read fails here too.
    expect(result.items[0]?.frozen).toBe(false);
  });

  // Pagination is the half a "close the transaction" refactor is most likely to
  // break: the cursor is minted from the OVER-FETCHED row set, so a fix that
  // trimmed the rows before handing them to `page()` would silently lose
  // `nextCursor` while every deadlock assertion above stayed green.
  it("listCompetitions still paginates, outside the transaction", async () => {
    const { auth } = await seedCompetition();
    // A second and third competition in the same org, so limit 2 over-fetches.
    const suffix = randomUUID().slice(0, 8);
    for (const n of [2, 3]) {
      await sql`
        insert into competitions (org_id, name, slug, status)
        values (${auth.orgId}, ${`Pool Cup ${suffix} ${n}`}, ${`pool-cup-${suffix}-${n}`}, 'draft')`;
    }

    const first = await withOneSlotPool("listCompetitions(page)", () =>
      listCompetitions(auth, { cursor: null, limit: 2 }),
    );

    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    expect(first.items.every((c) => c.frozen === false)).toBe(true);
  });

  // ── The WRITE paths ───────────────────────────────────────────────────────
  //
  // Every one of these used to call `assertCompetitionNotFrozen(orgId, id, tx)`
  // from inside its own `withTenant`. Threading the ambient `tx` LOOKED like it
  // made the nested case safe and did not: `frozenCompetitionIds` opens with
  // `getLimit`, which queries the pooled `sql` proxy, and that happens BEFORE
  // the `tx` branch is ever reached. So all seventeen of those call sites were
  // nesting a pooled query inside an open transaction, on the org's main write
  // paths — creating a division, adding entrants, saving a format, saving
  // scheduling settings, deleting a stage.
  //
  // One case per FILE rather than per call site: they share a single helper, so
  // a regression in it reds several of these at once, and the shape is what is
  // being guarded rather than any individual line.

  it("createDivision completes against a one-slot pool", async () => {
    const { auth, compId } = await seedDivision();

    const row = await withOneSlotPool("createDivision", () =>
      createDivision(auth, compId, {
        name: "Second",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      }),
    );

    expect(row.name).toBe("Second");
  });

  it("createEntrants completes against a one-slot pool", async () => {
    const { auth, divisionId } = await seedDivision();

    const created = await withOneSlotPool("createEntrants", () =>
      createEntrants(auth, divisionId, [
        { kind: "individual", display_name: "A", seed: 1, members: [] },
        { kind: "individual", display_name: "B", seed: 2, members: [] },
      ]),
    );

    expect(created).toHaveLength(2);
  });

  it("createStages completes against a one-slot pool", async () => {
    const { auth, divisionId } = await seedDivision();

    const stages = await withOneSlotPool("createStages", () =>
      createStages(auth, divisionId, { seq: 2, kind: "league", name: "L2", config: {} }),
    );

    expect(stages[0]?.name).toBe("L2");
  });

  it("deleteStage completes against a one-slot pool", async () => {
    const { auth, stageId } = await seedDivision();

    const out = await withOneSlotPool("deleteStage", () => deleteStage(auth, stageId));

    expect(out.deleted).toBe(true);
  });

  it("putScheduleSettings completes against a one-slot pool", async () => {
    const { auth, divisionId } = await seedDivision();
    // Seeded under the NORMAL pool, before the swap — same reasoning as
    // `seedDivision`'s own doc comment: only the call under test runs
    // one-slot.
    const [court] = await seedCourts(auth.orgId, 1);

    const settings = await withOneSlotPool("putScheduleSettings", () =>
      putScheduleSettings(auth, divisionId, {
        config: {
          startAt: "2026-08-01T09:00:00.000Z",
          matchMinutes: 30,
          gapMinutes: 0,
          courts: [court!],
          perEntrantMinRest: 0,
          blackouts: [],
          sessionWindows: [],
        },
        tz: "UTC",
      }),
    );

    expect(settings.config.courts).toEqual([court]);
  });

  // A DIFFERENT nester from the freeze family: `buildDivisionDocModel` awaited
  // `brandingFor` (→ `hasFeature`, a pooled read) inside its transaction, and on
  // the `participants` kind it also called `participantRows`, which opens a
  // SECOND `withTenant` — a nested transaction, which is the same pool checkout
  // by another name. Both are inside one call, so one case covers both.
  it("buildDivisionDocModel completes against a one-slot pool", async () => {
    const { auth, divisionId } = await seedDivision();
    await grant(auth.orgId, "exports");

    const doc = await withOneSlotPool("buildDivisionDocModel", () =>
      buildDivisionDocModel(auth, divisionId, "participants", {
        printedAt: "2026-08-06T10:00:00.000Z",
      }),
    );

    expect(doc.title).toContain("Open");
  });

  // P11 batch import (final review): `importEvents` is the densest shape this
  // suite exists for — a POOLED read (loadDivision), a pooled entitlement
  // resolve (`frozenCompetitionIds` → `getLimit`), then TWO `withTenant`
  // blocks per stream (the dry-run fold and the write), with more pooled reads
  // interleaved between them (the receipt pre-check, the started guard,
  // `requireFeature`, the stage config lookup, the lock refresh). Every one of
  // those pooled reads has to sit OUTSIDE both transactions; one of them
  // sliding inside is a permanent hang, not a slow import.
  it("importEvents completes against a one-slot pool", async () => {
    // Seeded under the NORMAL pool, before the swap — same reasoning as
    // `seedDivision`'s doc comment. Only the import itself runs one-slot.
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);

    const report = await withOneSlotPool("importEvents", () =>
      importEvents(auth, divisionId, {
        import_id: "pool-" + randomUUID().slice(0, 8),
        streams: [{ fixture: { id: fixtureId }, events: decidingStream() }],
      }),
    );

    // Asserting the IMPORT landed, not merely that the call returned: a
    // "fix" that dropped the freeze resolve (or any other pooled read) would
    // stop deadlocking and also stop working, and this is what catches that.
    expect(report.results[0]!.status).toBe("imported");
  });

  // ── The guard still BITES ─────────────────────────────────────────────────
  //
  // Every assertion above is satisfied by simply DELETING the freeze check —
  // a call that no longer runs it cannot deadlock on it either. This is the case
  // that stops that: an org pinned to one active competition freezes the older
  // of two, and the write must still be refused, now from outside the
  // transaction. Ordering matters too: the 402 must beat the transaction's own
  // work, not arrive after a partial write.
  it("still refuses a write to a FROZEN competition, from outside the transaction", async () => {
    const { auth, compId } = await seedDivision();
    // A second, newer competition. `selectFrozen` keeps the most recently
    // active, so the one seeded above is the one that freezes.
    await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Newer " + randomUUID().slice(0, 8),
      visibility: "private",
      branding: {},
    });
    // PIN the quota rather than inheriting the live plan matrix, which moves.
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value)
      values (${auth.orgId}, 'competitions.max_active', 1)
      on conflict (org_id, feature_key) do update set int_value = 1, bool_value = null`;

    await expect(
      withOneSlotPool("createDivision(frozen)", () =>
        createDivision(auth, compId, {
          name: "Blocked",
          sport_key: "generic",
          variant_key: "score",
          config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
        }),
      ),
    ).rejects.toMatchObject({ status: 402, featureKey: "competitions.max_active" });
  });

  // ── An ONLINE division (Lichess) ──────────────────────────────────────────
  //
  // Boardgame only, by the product's own rule: `supportsOnlinePlay` is true for no other sport and
  // `createDivision` refuses `onlinePlay` on any other (ONLINE_PLAY_SPORT), so no other division reaches this branch.
  //
  // The cases above all build a `generic` division, which never reaches the
  // online-play branch of `createEntrants` — the one that demands every
  // rostered person hold a Lichess link. That branch used to ask the link
  // question person by person, through a helper that opened a NESTED `withTenant`
  // and then a pooled `getLichessLink` read WHILE the create's own transaction
  // held its connection: pool-max concurrent creates on an online division
  // pinned every slot and queued for one more, for ever. `user_external_accounts`
  // is sealed from `app_user` (V451: FORCE RLS, no grant), so the answer cannot
  // simply be read through the ambient `tx` either — it is read on the
  // transaction's own connection BEFORE the role drops (`privilegedPrelude`).

  it("createEntrants on an ONLINE division with linked members completes against a one-slot pool", async () => {
    const { auth, divisionId, linked } = await seedOnlineDivision({ linked: 2 });

    const created = await withOneSlotPool("createEntrants(online, linked)", () =>
      createEntrants(auth, divisionId, [entrantOf(linked[0]!, "A"), entrantOf(linked[1]!, "B")]),
    );

    expect(created.map((e) => e.display_name)).toEqual(["A", "B"]);
    // The roster really landed, and the division really is online: a "fix" that
    // dropped the link demand (and with it the nesting) would still pass the
    // line above, so pin the premise that the demand was live for THIS division.
    const members = await sql<{ person_id: string }[]>`
      select em.person_id from entrant_members em join entrants e on e.id = em.entrant_id
       where e.division_id = ${divisionId} order by em.person_id`;
    expect(members.map((m) => m.person_id)).toEqual(linked.map((p) => p.personId).sort());
    const [div] = await sql<{ online: string | null }[]>`
      select config->>'onlinePlay' as online from divisions where id = ${divisionId}`;
    expect(div!.online).toBe("lichess");
  });

  // The positive pair of the case above: the demand is LIVE under the same
  // one-slot pool, and it answers as the 422 it always did — not as the
  // deadlock timeout the nested check produced, and not as a pass.
  it("createEntrants on an ONLINE division still refuses an unlinked player — a 422, not a deadlock", async () => {
    const { auth, divisionId, linked, unlinked } = await seedOnlineDivision({ linked: 1, unlinked: 1 });

    await expect(
      withOneSlotPool("createEntrants(online, unlinked)", () =>
        createEntrants(auth, divisionId, [entrantOf(unlinked[0]!, "Nobody")]),
      ),
    ).rejects.toMatchObject({ status: 422, code: "LICHESS_LINK_REQUIRED" });

    // Atomic: a batch holding one linked and one unlinked player enters NEITHER.
    await expect(
      withOneSlotPool("createEntrants(online, mixed batch)", () =>
        createEntrants(auth, divisionId, [entrantOf(linked[0]!, "Fine"), entrantOf(unlinked[0]!, "Nobody")]),
      ),
    ).rejects.toMatchObject({ status: 422, code: "LICHESS_LINK_REQUIRED" });
    const [count] = await sql<{ n: number }[]>`
      select count(*)::int as n from entrants where division_id = ${divisionId}`;
    expect(count!.n).toBe(0);
  });

  // The roster a create stores is not always the one it was handed: a team's
  // squad seeds it when no members are given. The demand follows the FINAL
  // roster, so it has to see the squad's people too — on the same connection.
  it("createEntrants on an ONLINE division gates a squad-seeded roster under a one-slot pool", async () => {
    const { auth, divisionId, linked, unlinked } = await seedOnlineDivision({ linked: 1, unlinked: 1 });
    const goodTeam = await seedTeamWithSquad(auth.orgId, [linked[0]!]);
    const badTeam = await seedTeamWithSquad(auth.orgId, [unlinked[0]!]);

    await expect(
      withOneSlotPool("createEntrants(online, squad unlinked)", () =>
        createEntrants(auth, divisionId, [{ display_name: "x", kind: "individual", team_id: badTeam, members: [] }]),
      ),
    ).rejects.toMatchObject({ status: 422, code: "LICHESS_LINK_REQUIRED" });

    const created = await withOneSlotPool("createEntrants(online, squad linked)", () =>
      createEntrants(auth, divisionId, [{ display_name: "x", kind: "individual", team_id: goodTeam, members: [] }]),
    );
    expect(created).toHaveLength(1);
  });

  // The demand is on the people a roster NAMES, and only on an online division: an entrant with no roster has nobody
  // to demand a link of, and an over-the-board division demands none of anyone (the prelude still runs for it — it
  // looks at the division — and must come away with nothing to apply).
  it("createEntrants enters a roster-less entrant to an ONLINE division, and an unlinked player to an over-the-board one", async () => {
    const online = await seedOnlineDivision({ linked: 0 });
    const otb = await seedOnlineDivision({ linked: 0, unlinked: 1, online: false });

    const bare = await withOneSlotPool("createEntrants(online, no roster)", () =>
      createEntrants(online.auth, online.divisionId, [{ display_name: "Bare", kind: "individual", members: [] }]),
    );
    const unlinkedOtb = await withOneSlotPool("createEntrants(otb, unlinked)", () =>
      createEntrants(otb.auth, otb.divisionId, [entrantOf(otb.unlinked[0]!, "Walk-in")]),
    );

    expect(bare.map((e) => e.display_name)).toEqual(["Bare"]);
    expect(unlinkedOtb.map((e) => e.display_name)).toEqual(["Walk-in"]);
    const [stored] = await sql<{ online: string | null }[]>`
      select config->>'onlinePlay' as online from divisions where id = ${otb.divisionId}`;
    expect(stored!.online, "premise: that division really is over the board").toBeNull();
  });

  // Two creates, an unlink between them: the answer is read per transaction, never kept — a linked player who
  // unlinks is refused the next time, and the rows of the first create stand.
  it("createEntrants follows an unlink between two creates on an ONLINE division", async () => {
    const { auth, divisionId, linked } = await seedOnlineDivision({ linked: 1 });
    const player = linked[0]!;

    const first = await createEntrants(auth, divisionId, [entrantOf(player, "Before")]);
    await sql`delete from user_external_accounts where user_id = ${player.userId}`;

    await expect(createEntrants(auth, divisionId, [entrantOf(player, "After")])).rejects.toMatchObject({
      status: 422,
      code: "LICHESS_LINK_REQUIRED",
    });
    const names = await sql<{ display_name: string }[]>`
      select display_name from entrants where division_id = ${divisionId}`;
    expect(first).toHaveLength(1);
    expect(names.map((n) => n.display_name)).toEqual(["Before"]);
  });

  // The failure as production meets it: not one caller against a pool of one,
  // but pool-max + 1 callers against the pool it really runs (`max: 5`, read
  // from `connectionOptions` so a change to the default moves the test with
  // it). On the nested check each of the first `max` creates pinned a slot and
  // asked for a second, so the sixth caller never even got in and none ever
  // finished. All of them must settle, inside a bound, with their rows.
  it("pool-max + 1 CONCURRENT createEntrants on an ONLINE division all complete", async () => {
    const callers = PRODUCTION_POOL_MAX + 1;
    const { auth, divisionId, linked } = await seedOnlineDivision({ linked: callers });

    const created = await withPoolOf(
      PRODUCTION_POOL_MAX,
      `${callers} concurrent createEntrants(online)`,
      () => Promise.all(linked.map((p, i) => createEntrants(auth, divisionId, [entrantOf(p, `C${i}`)]))),
      CONCURRENT_BOUND_MS,
    );

    expect(callers, "premise: more callers than the pool has slots").toBeGreaterThan(PRODUCTION_POOL_MAX);
    expect(created.flat().map((e) => e.display_name).sort()).toEqual(linked.map((_, i) => `C${i}`).sort());
    const [rows] = await sql<{ entrants: number; members: number }[]>`
      select count(distinct e.id)::int as entrants, count(em.person_id)::int as members
        from entrants e left join entrant_members em on em.entrant_id = e.id
       where e.division_id = ${divisionId}`;
    expect(rows).toEqual({ entrants: callers, members: callers });
  });

  // A refusal mid-batch must give its connection back: one unlinked caller
  // among pool-max + 1 is refused (422), the rest enter, nothing is left
  // holding a slot, and a FURTHER create afterwards still gets through.
  it("pool-max + 1 CONCURRENT createEntrants with one unlinked player: it is refused, the rest enter, the pool is not left pinned", async () => {
    const callers = PRODUCTION_POOL_MAX + 1;
    // `callers` linked players: the first `callers - 1` race beside the unlinked one, the last is held back for the follow-up.
    const { auth, divisionId, linked, unlinked } = await seedOnlineDivision({ linked: callers, unlinked: 1 });
    const players = [...linked.slice(0, callers - 1), unlinked[0]!];

    const settled = await withPoolOf(
      PRODUCTION_POOL_MAX,
      `${callers} concurrent createEntrants(online, one unlinked)`,
      async () => {
        const first = await Promise.allSettled(
          players.map((p, i) => createEntrants(auth, divisionId, [entrantOf(p, `M${i}`)])),
        );
        // The pool is still usable after a refusal rolled back mid-flight.
        const after = await createEntrants(auth, divisionId, [entrantOf(linked[callers - 1]!, "After")]);
        return { first, after };
      },
      CONCURRENT_BOUND_MS,
    );

    const refused = settled.first.flatMap((r, i) => (r.status === "rejected" ? [{ i, reason: r.reason as unknown }] : []));
    expect(refused).toHaveLength(1);
    expect(refused[0]!.i, "the unlinked player is the one refused").toBe(players.length - 1);
    expect(refused[0]!.reason).toMatchObject({ status: 422, code: "LICHESS_LINK_REQUIRED" });
    expect(settled.first.filter((r) => r.status === "fulfilled")).toHaveLength(callers - 1);
    expect(settled.after.map((e) => e.display_name)).toEqual(["After"]);
  });

  // A one-slot pool proves the create path; this proves the WHOLE entrant
  // surface in one run, by asking the runtime instead of reading call graphs.
  // `record` mode lets every path run to the end and names each site that asked
  // for a second connection while one was held, with the helper chain.
  it("every entrant usecase on an ONLINE division holds one connection at a time (record-mode sweep)", async () => {
    const { auth, divisionId, linked } = await seedOnlineDivision({ linked: 4 });
    const [p1, p2, p3, p4] = linked as [SeedPlayer, SeedPlayer, SeedPlayer, SeedPlayer];
    const teamId = await seedTeamWithSquad(auth.orgId, [p4]);
    const saved = process.env.DB_NESTING_GUARD;
    process.env.DB_NESTING_GUARD = "record";
    clearNestingViolations();
    const ran: string[] = [];
    const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const out = await fn();
      ran.push(name);
      return out;
    };
    let control = 0;
    try {
      // The instrument works in this rig: a deliberate nested pooled read inside
      // a transaction IS recorded. Without this, an empty list below could mean
      // "the guard saw nothing" rather than "there was nothing to see".
      await withTenant(auth.orgId, async () => {
        await sql`select 1`;
      });
      control = nestingViolations().length;
      clearNestingViolations();

      const [a, b] = await step("createEntrants", () =>
        createEntrants(auth, divisionId, [entrantOf(p1, "A"), entrantOf(p2, "B")]),
      );
      const [t] = await step("createEntrants(squad)", () =>
        createEntrants(auth, divisionId, [{ display_name: "Squad", kind: "individual", team_id: teamId, members: [] }]),
      );
      await step("getEntrant", () => getEntrant(auth, a!.id));
      await step("listEntrants", () => listEntrants(auth, divisionId));
      await step("divisionRoster", () => divisionRoster(auth, divisionId));
      await step("patchEntrant(rename)", () => patchEntrant(auth, a!.id, { display_name: "A2" }));
      await step("patchEntrant(roster)", () =>
        patchEntrant(auth, a!.id, { members: [{ person_id: p3.personId, is_captain: false, roles: [] }] }),
      );
      await step("syncEntrantRosterFromSquad", () => syncEntrantRosterFromSquad(auth, t!.id));
      await step("setEntrantBadge(null)", () => setEntrantBadge(auth, a!.id, null));
      await step("deleteEntrant", () => deleteEntrant(auth, b!.id));
    } finally {
      if (saved === undefined) delete process.env.DB_NESTING_GUARD;
      else process.env.DB_NESTING_GUARD = saved;
    }

    expect(control, "premise: the record-mode guard sees a deliberate nesting").toBe(1);
    expect(ran, "anti-vacuity: every path in the sweep ran").toHaveLength(10);
    expect(nestingViolations().map(describeViolation)).toEqual([]);
  });
});

/** One line per recorded nesting: WHAT asked for the second connection and the
 *  first frame outside `lib/db.ts` that did — the part a failure has to name. */
function describeViolation(stack: string): string {
  const what = /nesting: (.+?) was issued/.exec(stack)?.[1] ?? "?";
  const frame = stack.split("\n").find((l) => l.includes("/src/") && !l.includes("/lib/db.ts"));
  return `${what} @ ${frame?.trim().replace(/^at /, "") ?? "?"}`;
}

// ── Online-division seeding for the cases above ─────────────────────────────
// Built through the REAL usecases under the NORMAL pool, before any swap — the
// same reasoning as `seedDivision`. Every player is a person + user; `linked`
// ones also hold a Lichess link (the sealed `user_external_accounts` row).

const ONLINE_CLOCK = { base: 600, increment: 5 };

function entrantOf(p: SeedPlayer, name: string): CreateEntrant {
  return { display_name: name, kind: "individual", members: [{ person_id: p.personId, is_captain: false, roles: [] }] };
}

async function seedOnlineDivision(n: { linked: number; unlinked?: number; online?: boolean }): Promise<{
  auth: AuthCtx;
  divisionId: string;
  linked: SeedPlayer[];
  unlinked: SeedPlayer[];
}> {
  const auth = await seedChessOwner();
  const suffix = randomUUID().slice(0, 8);
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Online Pool " + suffix,
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Online",
    sport_key: "boardgame",
    variant_key: "classical",
    config: { variant: "classical", ...(n.online === false ? {} : { onlinePlay: "lichess" }), clock: ONLINE_CLOCK },
  });
  const make = (isLinked: boolean, i: number): Promise<SeedPlayer> =>
    seedPlayer(auth.orgId, `${isLinked ? "Linked" : "Unlinked"} ${i} ${suffix}`, `p-${randomUUID().replaceAll("-", "").slice(0, 12)}`, isLinked);
  const linked: SeedPlayer[] = [];
  const unlinked: SeedPlayer[] = [];
  for (let i = 0; i < n.linked; i++) linked.push(await make(true, i));
  for (let i = 0; i < (n.unlinked ?? 0); i++) unlinked.push(await make(false, i));
  return { auth, divisionId: division.id, linked, unlinked };
}

/** A team whose persistent squad is `players` (raw SQL: `createTeam` is plan-gated and not under test). */
async function seedTeamWithSquad(orgId: string, players: SeedPlayer[]): Promise<string> {
  const [{ id: teamId }] = await sql<{ id: string }[]>`
    insert into teams (org_id, name) values (${orgId}, ${"Squad " + randomUUID().slice(0, 8)}) returning id`;
  for (const p of players) {
    await sql`insert into team_members (team_id, person_id, org_id) values (${teamId}, ${p.personId}, ${orgId})`;
  }
  return teamId;
}
