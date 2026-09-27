// Public hub query perf T4 (2026-09-27): `listMyPlayerStats`' `published`
// flag asked `public_entrants_v` by DIVISION, and since V418 that view asks the
// player-profiles entitlement (`org_has_feature`) once per entrant row it
// builds. Asked by division, the planner may hash the EXISTS — and then it
// builds every public entrant of every division once: measured 63 calls for
// this file's six stat rows on the shared test database, more as it grows.
// The EXISTS now reaches the view through the person's own entrants in the
// division, fenced, so it builds only those (see me.ts on both fences).
//
// PERF ONLY. The flag must not move, so the read is diffed against its pre-T4
// body (frozen below from e5848d2f3) over every shape the flag branches on:
// published in an individual entrant and in a team's roster, a division that
// masks names (published, but no card), public-name consent refused, an org
// without player pages, a private competition, and a stranger's rows beside
// mine.
//
// The brief's premise was "hoist the per-row entitlement lookup to once per
// (org, competition)". There is no such lookup in me.ts: the calls are the
// view's own, and answering the entitlement here would restate V418's
// publish rule a THIRD time (V418's header names exactly one second copy,
// `public-leaders.ts`). Narrowing which entrant rows the view builds keeps the
// rule in the view.
//
// One mutant survives this file ON PURPOSE (M1, T4 review minor 2): deleting
// the EXISTS's outer `offset 0` in me.ts. Postgres never simplifies an EXISTS
// that carries an OFFSET (`simplify_EXISTS_query` gives up), so no hashed
// alternative subplan exists for it. Without the fence, all three
// correlations (`em.person_id`, `mine.division_id`, `m->>'person_id'`) are
// hashable equalities, and the planner may choose the hashed subplan, which
// builds its inner side once for EVERY membership in the database: the
// 63-call shape above, back again. The output is identical either way, and
// with six outer rows the planner keeps the per-row subplan, so neither the
// diff nor the call count can see the fence go. No planner setting forces the
// hashed choice; pinning it would take an EXPLAIN over a scene big enough to
// tip the planner, and that size depends on the whole test database's
// statistics, not on this file. The fence stays, justified by the measured
// hashed plan, not by a test.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Every export an entrant write fires after commit is stubbed (as me.test.ts
// does): the seed creates entrants through the real usecase.
vi.mock("@/server/public-site/revalidate", () => ({
  fireDivisionRevalidate: vi.fn(),
  firePersonRevalidate: vi.fn(async () => {}),
  fireScoreRevalidate: vi.fn(async () => {}),
  dropNamedPublicDocuments: vi.fn(),
}));

/** While `route.tx` is set, the pool `sql` runs its statements on that
 *  transaction instead — so a read that takes no handle can be counted inside
 *  one (`pg_stat_xact_user_functions` is per transaction). */
const route = vi.hoisted(() => ({ tx: null as null | ((...args: unknown[]) => unknown) }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const routed = new Proxy(actual.sql, {
    apply(target, thisArg, args: unknown[]) {
      return Reflect.apply(route.tx ?? target, thisArg, args);
    },
  });
  return { ...actual, sql: routed };
});

import type postgres from "postgres";
import { sql } from "@/lib/db";
import { DEFAULT_LOCALE } from "@/lib/i18n-constants";
import { msgFor } from "@/lib/messages-i18n";
import { playerLinkId } from "@/lib/name-display";
import { resolveLocale } from "@/lib/resolve-locale";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { listMyPlayerStats, type MyStatBlock } from "../me";
import { labelPlayerStats } from "@/server/player-stats";
import { GENERIC_CONFIG, makeUser, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;
type Sql = ReturnType<typeof postgres>;

// ── The pre-T4 read, frozen from e5848d2f3 (usecases/me.ts) ────────────────

async function listMyPlayerStatsBefore(db: Sql, userId: string): Promise<MyStatBlock[]> {
  const rows = await db<
    (Omit<MyStatBlock, "metrics" | "public_card"> & {
      module_version: string;
      stats: Record<string, number>;
      published: boolean;
      youth: boolean;
      player_name_display: string | null;
    })[]
  >`
    select ps.person_id, p.full_name as person_name,
           o.name as org_name, o.slug as org_slug,
           c.name as competition_name, c.slug as competition_slug,
           d.name as division_name, d.slug as division_slug,
           ps.sport_key, d.module_version, ps.stats, d.youth, d.player_name_display,
           exists (select 1 from public_entrants_v en
                   cross join lateral jsonb_array_elements(en.members) m
                   where en.division_id = d.id and m->>'person_id' = ps.person_id::text) as published
    from player_stat_snapshots ps
    join persons p on p.id = ps.person_id and p.user_id = ${userId} and p.merged_into is null
    join divisions d on d.id = ps.division_id and d.archived_at is null
    join competitions c on c.id = d.competition_id
    join organizations o on o.id = c.org_id
    order by o.name, c.name, d.name`;
  const locale = await resolveLocale().catch(() => DEFAULT_LOCALE);
  const m = (k: Parameters<typeof msgFor>[1]) => msgFor(locale, k);
  return rows.flatMap(({ module_version, stats, published, youth, player_name_display, ...row }) => {
    const metrics = labelPlayerStats(row.sport_key, module_version, stats, m);
    if (metrics.length === 0) return [];
    const public_card = playerLinkId(published ? row.person_id : null, { youth, player_name_display }) !== null;
    return [{ ...row, public_card, metrics }];
  });
}

// ── The scene ──────────────────────────────────────────────────────────────

type Consent = { public_name?: boolean };

async function person(orgId: string, fullName: string, consent: Consent, userId: string | null = null) {
  const [row] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, consent, user_id)
    values (${orgId}, ${fullName}, ${sql.json(consent)}, ${userId})
    returning id`;
  return row!.id;
}

const member = (personId: string) => ({
  person_id: personId,
  squad_number: null,
  default_position_key: null,
  is_captain: false,
  roles: [],
});

async function competition(auth: AuthCtx, visibility: "public" | "private") {
  return createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Stats Cup " + randomUUID().slice(0, 6),
    visibility,
    branding: {},
  });
}

async function division(auth: AuthCtx, competitionId: string, slug: string) {
  const d = await createDivision(auth, competitionId, {
    name: slug,
    slug,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  } as never);
  return d.id;
}

/** `me` plus `others` more individual entrants, each backed by a person. */
async function individuals(auth: AuthCtx, divisionId: string, me: string, others: number) {
  const rest = [];
  for (let i = 0; i < others; i += 1) rest.push(await person(auth.orgId, `Other ${i} ${randomUUID().slice(0, 4)}`, { public_name: true }));
  await createEntrants(
    auth,
    divisionId,
    [me, ...rest].map((id, i) => ({ kind: "individual" as const, display_name: `Entrant ${i}`, seed: i + 1, members: [member(id)] })) as never,
  );
  return rest;
}

async function snapshot(divisionId: string, personId: string, goals: number) {
  await sql`
    insert into player_stat_snapshots (division_id, person_id, sport_key, stats, computed_through_seq)
    values (${divisionId}, ${personId}, 'football', ${sql.json({ goals, assists: 1 })}, 1)`;
}

let player: string;
let refuser: string;
let stranger: string;
/** The player's own entrant memberships, per stat row: the most entrant rows
 *  the new read may build for that row, on any plan. */
let ownMembershipBound: number;
let visibleRows: number;

beforeAll(async () => {
  if (!HAS_DB) return;
  player = (await makeUser("statsplayer")).id;
  refuser = (await makeUser("statsrefuser")).id;
  stranger = (await makeUser("statsstranger")).id;

  // A pro org: player pages on.
  const { auth: pro } = await seedOrg("pro");
  const open = await competition(pro, "public");
  const mia = await person(pro.orgId, "Mia Hart", { public_name: true }, player);
  // Published as an individual, among seven others.
  const solo = await division(pro, open.id, "solo");
  const soloOthers = await individuals(pro, solo, mia, 7);
  await snapshot(solo, mia, 3);
  // A stranger's claimed row in the same division — never mine.
  await sql`update persons set user_id = ${stranger} where id = ${soloOthers[0]!}`;
  await snapshot(solo, soloOthers[0]!, 9);
  // Published through a TEAM's roster, the third of four teams.
  const teams = await division(pro, open.id, "teams");
  const mates = [await person(pro.orgId, "Tom Reyes", { public_name: true }), await person(pro.orgId, "Ivy Chen", {})];
  await createEntrants(pro, teams, [
    { kind: "team", display_name: "Alpha", seed: 1, members: [] },
    { kind: "team", display_name: "Bravo", seed: 2, members: [] },
    { kind: "team", display_name: "Charlie", seed: 3, members: [member(mates[0]!), member(mia), member(mates[1]!)] },
    { kind: "team", display_name: "Delta", seed: 4, members: [] },
  ] as never);
  await snapshot(teams, mia, 1);
  // Published, but the division shows first initials: no card.
  const masked = await division(pro, open.id, "masked");
  await sql`update divisions set player_name_display = 'first_initial' where id = ${masked}`;
  await individuals(pro, masked, mia, 3);
  await snapshot(masked, mia, 2);
  // A private competition: the view shows nothing.
  const hidden = await competition(pro, "private");
  const secret = await division(pro, hidden.id, "secret");
  await individuals(pro, secret, mia, 3);
  await snapshot(secret, mia, 4);

  // A community org: consent given, player pages off.
  const { auth: free } = await seedOrg("community");
  const freeComp = await competition(free, "public");
  const mia3 = await person(free.orgId, "Mia Hart", { public_name: true }, player);
  const community = await division(free, freeComp.id, "community");
  await individuals(free, community, mia3, 3);
  await snapshot(community, mia3, 6);

  // Mia is on four entrants in the pro org (solo, teams, masked, secret) and
  // one in the community org; four of her five rows are in a public
  // competition.
  ownMembershipBound = 4 * 4 + 1 * 1;
  visibleRows = 4;

  // Another user, in a twelve-entrant division, who refused public-name
  // consent: the flag's EXISTS finds no row, so a read that builds the
  // division's entrants builds all twelve to be sure of its `false`.
  const { auth: pro2 } = await seedOrg("pro");
  const refusedComp = await competition(pro2, "public");
  const ria = await person(pro2.orgId, "Ria Stone", {}, refuser);
  const refused = await division(pro2, refusedComp.id, "refused");
  await individuals(pro2, refused, ria, 11);
  await snapshot(refused, ria, 5);
}, 180_000);

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

/** `org_has_feature` calls made by `read`, counted inside one transaction on
 *  which every pool statement runs (after `settings`, applied `set local`). A
 *  delta: the view is per transaction but a pooled connection carries earlier
 *  transactions' unflushed calls. */
async function entitlementCalls<T>(
  read: (tx: Sql) => Promise<T>,
  settings: string[] = [],
): Promise<{ result: T; calls: number }> {
  return sql.begin(async (tx) => {
    await tx`set local track_functions = 'all'`;
    for (const s of settings) await tx.unsafe(`set local ${s}`);
    const count = async (): Promise<number> => {
      const [{ n }] = await tx<{ n: number }[]>`
        select coalesce(sum(calls), 0)::int as n
        from pg_stat_xact_user_functions where funcname = 'org_has_feature'`;
      return n;
    };
    const start = await count();
    route.tx = tx as unknown as (...args: unknown[]) => unknown;
    try {
      const result = await read(tx as unknown as Sql);
      return { result, calls: (await count()) - start };
    } finally {
      route.tx = null;
    }
  }) as Promise<{ result: T; calls: number }>;
}

/** Joins in the order written: the view's own FROM runs entrants → divisions →
 *  competitions → the entitlement lateral, so it asks once per ENTRANT row —
 *  the shape V418 documents. A plan the planner may pick on its own; forced
 *  here so the counts below do not depend on the table's statistics. */
const WRITTEN_ORDER = ["join_collapse_limit = 1"];

describe.skipIf(!HAS_DB)("listMyPlayerStats — `published` via the person's own entrants (T4)", () => {
  it("the same blocks as the pre-T4 read, over every shape the flag branches on", async () => {
    const before = await listMyPlayerStatsBefore(sql as unknown as Sql, player);
    // Premise: the scene reaches every branch, so the diff is not vacuous.
    const cards = Object.fromEntries(before.map((b) => [b.division_slug, b.public_card]));
    expect(cards).toEqual({ solo: true, teams: true, masked: false, secret: false, community: false });
    expect(before.every((b) => b.person_name === "Mia Hart")).toBe(true);
    const refusedBefore = await listMyPlayerStatsBefore(sql as unknown as Sql, refuser);
    expect(refusedBefore.map((b) => [b.division_slug, b.public_card])).toEqual([["refused", false]]);

    for (const [user, prior] of [
      [player, before],
      [refuser, refusedBefore],
      [stranger, await listMyPlayerStatsBefore(sql as unknown as Sql, stranger)],
    ] as const) {
      const after = await listMyPlayerStats(user);
      expect(after).toStrictEqual(prior);
      expect(JSON.stringify(after)).toBe(JSON.stringify(prior));
    }
  });

  it("builds at most the person's own entrants, on the planner's own plan and on the written join order", async () => {
    for (const settings of [[], WRITTEN_ORDER]) {
      const { calls } = await entitlementCalls(() => listMyPlayerStats(player), settings);
      // It really asks (every visible row's own entrant) …
      expect(calls, settings.join()).toBeGreaterThanOrEqual(visibleRows);
      // … and never more than the person's memberships — not the division's
      // entrants, not the view's.
      expect(calls, settings.join()).toBeLessThanOrEqual(ownMembershipBound);
    }
  });

  it("a refused consent in a twelve-entrant division: one entitlement call, where the pre-T4 read made one per entrant", async () => {
    const before = await entitlementCalls((tx) => listMyPlayerStatsBefore(tx, refuser), WRITTEN_ORDER);
    const after = await entitlementCalls(() => listMyPlayerStats(refuser), WRITTEN_ORDER);
    expect(after.result).toStrictEqual(before.result);
    // The positive pair: the old read built all twelve entrants to be sure of
    // its `false` — so the count below is the fix, not a counter that never
    // moves.
    expect(before.calls).toBeGreaterThanOrEqual(12);
    expect(after.calls).toBe(1);
    // And on the planner's own plan, the new read's count is the same.
    expect((await entitlementCalls(() => listMyPlayerStats(refuser))).calls).toBe(1);
  });
});
