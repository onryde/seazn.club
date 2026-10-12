// W2b ruling R115-4 (2026-10-12) — the two surfaces players actually look at, the public player card and /me, read
// `player_stat_snapshots` as they stand and used to ask nothing. A snapshot folded by older fold rules (a record whose
// inputs md5 predates `STATS_FOLD_VERSION`, R115-2) was therefore never refolded by them, which left the version fix
// inert exactly where it matters. Each now asks the existing read-side check (`reconcilePlayerStatsOnRead`) of the
// divisions it shows. It is throttled once a minute per division and capped at a share of the pool, and it runs after
// the response and never folds on the request. So by design:
//   - the first visit serves the rows as they stood, and no fold runs on that request;
//   - the check queued for after the response finds the record owed and refolds the division;
//   - the next visit reads the refold.
// The after-response window is `deferred`; it is captured here and run where `after()` would run it.
//
// Fixture: one player (Pat), a four-entrant league, real `scoreEvent` writes. Pat has a played win and a walkover win.
// Expected values come from X-PS-1 (a walkover is no match and no personal W/L): badminton `matches` 1; generic wins 1,
// losses 0. Two sports, each declaring different keys. Real Postgres required.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { badminton } from "@seazn/engine/sports/setbased";
import { generic } from "@seazn/engine/sports/generic";
import type { AnySportModule } from "@seazn/engine/sport";
import { sql, withTenant } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { getPublicPlayer } from "@/server/public-site/data";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createPerson } from "../persons";
import { createStages, generateStageFixtures } from "../stages";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { divisionPlayerStats, playerStatsCoverage, playerStatsInputsMd5 } from "../player-stats";
import { listMyCareerStats, listMyPlayerStats } from "../me";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";

const HAS_DB = !!process.env.DATABASE_URL;

// The after-response window: every `deferred(fn)` is captured, not run, until the test runs it.
const after = vi.hoisted(() => ({ tasks: [] as Array<() => unknown> }));
vi.mock("@/lib/deferred", () => ({ deferred: (fn: () => unknown) => void after.tasks.push(fn) }));
vi.mock("next/cache", () => ({ unstable_cache: (fn: (...a: unknown[]) => unknown) => fn, revalidateTag: vi.fn(), revalidatePath: vi.fn() }));
// Never a live vendor call from a test: the division push after a refresh is dropped.
vi.mock("@/lib/realtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/realtime")>()),
  publishDivisionUpdate: async () => {},
  publishFixtureUpdate: async () => {},
}));

/** Run the after-response window to completion, including any work it queues. Returns how many tasks ran. */
async function runAfterResponse(): Promise<number> {
  let ran = 0;
  while (after.tasks.length > 0) {
    const batch = after.tasks.splice(0);
    for (const fn of batch) await fn();
    ran += batch.length;
  }
  return ran;
}

beforeEach(() => {
  after.tasks.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

/** The read-side check is once a minute per division: move the wall clock past it (Date only; timers stay real). */
function aMinuteOn(): void {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true, now: Date.now() + 61_000 });
}

type Side = "home" | "away";
interface SportCase {
  module: AnySportModule;
  variant: string;
  win: (mine: Side) => { type: string; payload: unknown }[];
  /** X-PS-1, for Pat (one played win, one walkover win): the rule-derived keys, absent keys reading 0. */
  expected: Record<string, number>;
}
const SPORTS: SportCase[] = [
  {
    module: badminton as AnySportModule,
    variant: "bwf",
    win: (mine) => {
      const game = mine === "home" ? { home: 21, away: 10 } : { home: 10, away: 21 };
      return [
        { type: "badminton.game.summary", payload: game },
        { type: "badminton.game.summary", payload: game },
      ];
    },
    expected: { matches: 1 },
  },
  {
    module: generic as AnySportModule,
    variant: "score",
    win: (mine) => [{ type: "generic.result", payload: mine === "home" ? { p1Score: 3, p2Score: 1 } : { p1Score: 1, p2Score: 3 } }],
    expected: { wins: 1, losses: 0 },
  },
];

interface Scene {
  auth: AuthCtx;
  orgSlug: string;
  compSlug: string;
  divisionId: string;
  personId: string;
  userId: string;
}

async function seed(c: SportCase): Promise<Scene> {
  const key = c.module.key;
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId, slug: orgSlug }] = await sql<{ id: string; slug: string }[]>`
    insert into organizations (name, slug) values (${"R1154 " + suffix}, ${"r1154-" + suffix}) returning id, slug`;
  await setOrgPlan(orgId, "pro"); // the public player card is a player-pages (Pro) key
  await invalidateOrgEntitlements(orgId);
  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: `R1154 ${key} ${suffix}`, visibility: "public", branding: {} });
  const division = await createDivision(auth, comp.id, { name: "Open", slug: `open-${suffix}`, sport_key: key, variant_key: c.variant, config: {} });
  const names = ["Pat Player", "Opp One", "Opp Two", "Opp Three"];
  const people: { id: string }[] = [];
  for (const full_name of names) {
    people.push(await createPerson(auth, { full_name, consent: { public_name: true }, dob: null, gender: null, external_ref: null }));
  }
  const entrants = await createEntrants(
    auth,
    division.id,
    people.map((p, i) => ({
      kind: "individual" as const,
      display_name: names[i]!,
      seed: i + 1,
      members: [{ person_id: p.id, squad_number: null, is_captain: false, roles: [], default_position_key: null }],
    })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "L", config: {} });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  await startDivision(auth, division.id);
  const pat = entrants[0]!.id;
  const mine = fixtures.filter((f) => f.home_entrant_id === pat || f.away_entrant_id === pat);
  expect(mine.length, `${key}: Pat meets three opponents`).toBe(3);
  const seqOf = new Map<string, number>();
  const post = async (fixtureId: string, type: string, payload: unknown) => {
    const expected_seq = seqOf.get(fixtureId) ?? 0;
    await scoreEvent(auth, fixtureId, { expected_seq, type, payload } as never);
    seqOf.set(fixtureId, expected_seq + 1);
  };
  const [played, walkover] = mine;
  await post(played!.id, "core.start", {});
  for (const e of c.win(played!.home_entrant_id === pat ? "home" : "away")) await post(played!.id, e.type, e.payload);
  const woOpp = walkover!.home_entrant_id === pat ? walkover!.away_entrant_id! : walkover!.home_entrant_id!;
  await post(walkover!.id, "core.forfeit", { by: woOpp, reason: "walkover" });

  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified) values (${`pat-${suffix}@test.local`}, 'Pat', true) returning id`;
  await sql`update persons set user_id = ${userId} where id = ${people[0]!.id}`;
  return { auth, orgSlug, compSlug: comp.slug, divisionId: division.id, personId: people[0]!.id, userId };
}

/** A display row's metrics as {key: value} (zero-valued keys are dropped by the labeller). */
const tiles = (metrics: readonly { key: string; value: number }[] | undefined) =>
  Object.fromEntries((metrics ?? []).map((m) => [m.key, m.value]));
const nonZero = (stats: Record<string, number>) => Object.fromEntries(Object.entries(stats).filter(([, v]) => v !== 0));

describe.skipIf(!HAS_DB)("R115-4: the public card and /me ask the read-side check; an old-version snapshot is fresh on the next visit", () => {
  for (const c of SPORTS) {
    it(`${c.module.key}: card, /me stats and /me career — stale on the first visit, no fold on it, refolded after the response, fresh on the next`, async () => {
      const key = c.module.key;
      const s = await seed(c);
      const storedPat = async () =>
        (await sql<{ stats: Record<string, number> }[]>`
          select stats from player_stat_snapshots where division_id = ${s.divisionId} and person_id = ${s.personId}`)[0]!.stats;
      const recordMd5 = async () =>
        (await sql<{ inputs_md5: string }[]>`select inputs_md5 from player_stat_folds where division_id = ${s.divisionId}`)[0]!.inputs_md5;
      const md5 = (version: number | null | undefined) =>
        withTenant(s.auth.orgId, (tx) => (version === undefined ? playerStatsInputsMd5(tx, s.divisionId) : playerStatsInputsMd5(tx, s.divisionId, version)));

      // Fold under the current version (the console read), and let its own after-response work settle.
      await divisionPlayerStats(s.auth, s.divisionId, {});
      await runAfterResponse();
      const right = await storedPat();
      for (const [k, v] of Object.entries(c.expected)) expect(right[k] ?? 0, `${key}: ${k} (X-PS-1)`).toBe(v);
      expect(await recordMd5(), `${key}: folded under the current version`).toBe(await md5(undefined));

      // An old-version snapshot: numbers an older fold could have written (every value off by five), and the record's
      // md5 exactly as pre-R115-2 code computed it.
      const stale = Object.fromEntries(Object.entries(right).map(([k, v]) => [k, v + 5]));
      const old = await md5(null);
      const age = async () => {
        await sql`update player_stat_snapshots set stats = ${sql.json(stale as never)}
          where division_id = ${s.divisionId} and person_id = ${s.personId}`;
        await sql`update player_stat_folds set inputs_md5 = ${old} where division_id = ${s.divisionId}`;
        after.tasks.length = 0;
      };
      const owed = async () => (await withTenant(s.auth.orgId, (tx) => playerStatsCoverage(tx, s.divisionId))).owed;

      // Each loader below is driven on its own, one minute apart, so each one's check is witnessed alone.
      // `omit`: the career card shows the live match count in its meta line, never a `matches` tile (player-stats.ts).
      const loaders: Array<{ name: string; read: () => Promise<Record<string, number>>; omit?: string }> = [
        {
          name: "public player card",
          read: async () => {
            const card = await getPublicPlayer(s.orgSlug, s.compSlug, s.personId);
            expect(card, `${key}: the card is public`).not.toBeNull();
            return tiles(card!.stats.find((x) => x.sport_key === key)?.metrics);
          },
        },
        {
          name: "/me My stats",
          read: async () => tiles((await listMyPlayerStats(s.userId)).find((x) => x.sport_key === key)?.metrics),
        },
        {
          name: "/me Career",
          read: async () => tiles((await listMyCareerStats(s.userId)).find((x) => x.sport_key === key)?.metrics),
          omit: "matches",
        },
      ];
      let driven = 0;
      for (const [i, loader] of loaders.entries()) {
        if (i > 0) aMinuteOn();
        const what = `${key} ${loader.name}`;
        const shown = (stats: Record<string, number>) =>
          Object.fromEntries(Object.entries(nonZero(stats)).filter(([k]) => k !== loader.omit));
        await age();
        expect(await owed(), `${what}: the old-version record is owed`).toBe(true);

        // First visit: the rows as they stood. The check is QUEUED, not run, and nothing was folded on the request.
        expect(await loader.read(), `${what}: first visit`).toEqual(shown(stale));
        expect(after.tasks.length, `${what}: a check queued for after the response`).toBeGreaterThan(0);
        expect([await storedPat(), await recordMd5()], `${what}: no fold on the request`).toEqual([stale, old]);

        // The after-response window: the check finds it owed and refolds the division.
        expect(await runAfterResponse(), `${what}: after-response tasks ran`).toBeGreaterThan(0);
        expect([await storedPat(), await recordMd5()], `${what}: refolded and restamped`).toEqual([right, await md5(undefined)]);
        expect(await owed(), `${what}: no longer owed`).toBe(false);

        // Second visit: fresh.
        expect(await loader.read(), `${what}: second visit`).toEqual(shown(right));

        // The throttle: within the minute, an aged record queues no second check from the same reader.
        await age();
        await loader.read();
        expect(after.tasks.length, `${what}: one check per division per minute`).toBe(0);
        driven++;
      }
      expect(driven, `${key}: loaders driven`).toBe(3);
    });
  }
});
