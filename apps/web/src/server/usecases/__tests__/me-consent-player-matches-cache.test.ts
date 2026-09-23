// Spectator W2, Task 14 — a consent change reaches the player page's POLL
// document at once, not after its 15 s TTL.
//
// `publicPlayerMatches` (usecases/public.ts) caches each person's match lines
// in Redis, and its gate runs only when that cache misses. So without an
// invalidation, a player who revokes `public_name` kept their lines served for
// up to 15 s, and so did a revoked OPPONENT's full name inside everyone else's
// lines. The documents are keyed under their competition's generation token
// (`player-matches-cache-keys.ts`); `setMyConsent` deletes the token of every
// competition in the person's ORG, in one DEL, not awaited, logged on failure.
//
// Driven end to end over real rows: the real `setMyConsent`, and the real
// `publicPlayerMatches` reading the real competition. Redis is an in-memory
// store behind `@/lib/cache`, the gate and the reader are spies — what is under
// test is whether the SECOND read after the write reaches the loader again.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const redis = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  failDel: null as Error | null,
}));
vi.mock("@/lib/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cache")>()),
  cacheGet: async (key: string) => (redis.store.has(key) ? redis.store.get(key) : null),
  cacheSet: async (key: string, value: unknown) => {
    redis.store.set(key, value);
  },
  cacheDel: (...keys: string[]) => {
    if (redis.failDel) return Promise.reject(redis.failDel);
    for (const key of keys) redis.store.delete(key);
    return Promise.resolve();
  },
  cacheDelPattern: async () => {},
}));
// Every export an entrant write fires after commit is stubbed too
// (`refreshEntrantPublicPages`): the seed below creates entrants, and a stub
// missing one of them breaks that seed, not the test.
vi.mock("@/server/public-site/revalidate", () => ({
  fireDivisionRevalidate: vi.fn(),
  firePersonRevalidate: vi.fn(async () => {}),
  fireScoreRevalidate: vi.fn(async () => {}),
  dropNamedPublicDocuments: vi.fn(),
}));
const logMock = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
}));
vi.mock("@/server/logger", () => ({ log: logMock }));
const publicPlayerGate = vi.hoisted(() => vi.fn());
vi.mock("@/server/public-site/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/public-site/data")>()),
  publicPlayerGate,
}));
const readPlayerMatchLines = vi.hoisted(() => vi.fn(async () => []));
vi.mock("@/server/public-site/public-player-matches", () => ({ readPlayerMatchLines }));

import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createPerson } from "../persons";
import { setMyConsent } from "../me";
import { publicPlayerMatches } from "../public";

const HAS_DB = !!process.env.DATABASE_URL;
const CONSENT_DELETE_FAILED = "consent: a public Redis delete failed (the write stands)";

async function makeUser(name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${name}-${randomUUID().slice(0, 8)}@test.local`}, ${name}, true)
    returning id`;
  return id;
}

/** A Pro org with one PUBLIC competition, one division, and one rostered
 *  person claimed by a player account. */
async function scene(tag: string) {
  const suffix = randomUUID().slice(0, 8);
  const ownerId = await makeUser("owner");
  const orgSlug = `mcp-${tag}-${suffix}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${`Consent ${tag} ${suffix}`}, ${orgSlug}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  await setOrgPlan(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json({ resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false })}, true)
    on conflict do nothing`;
  const owner: AuthCtx = { orgId, via: "session", userId: ownerId, role: "owner", keyId: null };
  const competition = await createCompetition(owner, {
    ends_on: "2030-12-31",
    name: "Consent Cup " + suffix,
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(owner, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const person = await createPerson(owner, { full_name: "Ada", consent: { public_name: true }, dob: null } as never);
  await createEntrants(owner, division.id, [
    {
      kind: "individual" as const,
      display_name: "Ada",
      seed: 1,
      members: [{ person_id: person.id, squad_number: null, default_position_key: null, is_captain: false, roles: [] }],
    },
  ]);
  const player = await makeUser("player");
  await sql`update persons set user_id = ${player} where id = ${person.id}`;
  return { orgSlug, competition, person, player };
}

type Scene = Awaited<ReturnType<typeof scene>>;

const read = (s: Scene) => publicPlayerMatches(s.orgSlug, s.competition.slug, s.person.id);

beforeEach(() => {
  redis.store.clear();
  redis.failDel = null;
  vi.clearAllMocks();
  publicPlayerGate.mockImplementation(async (_org: string, _comp: string, personId: string) => ({
    org: { id: "o", slug: "o", name: "O", default_locale: "en" },
    competition: { id: "c", slug: "c", name: "C" },
    player: { id: personId, org_id: "o", name: "Ada", photo: null },
  }));
});

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

/** The DEL is not awaited by the write; let it land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe.skipIf(!HAS_DB)("setMyConsent retires the player page's cached match lines (Task 14)", () => {
  it("a revoke makes the next poll MISS the cache; a consent change in ANOTHER org does not", async () => {
    const mine = await scene("mine");
    const theirs = await scene("theirs");

    await read(mine);
    await read(mine);
    expect(readPlayerMatchLines, "the second read is served from the cache").toHaveBeenCalledTimes(1);

    // Quiet twin: another org's person revokes. Nothing in THIS competition moves.
    await setMyConsent(theirs.player, theirs.person.id, { public_name: false });
    await settle();
    await read(mine);
    expect(readPlayerMatchLines, "another org's consent left this cache alone").toHaveBeenCalledTimes(1);

    await setMyConsent(mine.player, mine.person.id, { public_name: false });
    await settle();
    await read(mine);
    expect(readPlayerMatchLines, "the read after the revoke went back to the gate and the reader").toHaveBeenCalledTimes(2);
    expect(publicPlayerGate).toHaveBeenCalledTimes(2);
    expect(logMock.error).not.toHaveBeenCalledWith(expect.anything(), CONSENT_DELETE_FAILED);
  }, 120_000);

  it("a Redis delete that fails is logged, never left unhandled, and the consent write stands", async () => {
    const mine = await scene("fail");
    const failure = new Error("simulated Redis failure");
    redis.failDel = failure;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const updated = await setMyConsent(mine.player, mine.person.id, { public_name: false });
      await settle();
      expect(updated.consent.public_name).toBe(false);
      expect(logMock.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: failure, person: mine.person.id, keys: expect.arrayContaining([`pub:v1:player-matches-gen:${mine.competition.id}`]) }),
        CONSENT_DELETE_FAILED,
      );
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }, 120_000);
});
