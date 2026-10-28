// YouTube Connect T16 (plan R7): the public match page reads a fixture's replay PARTS through its REAL server loader.
// `getPublicFixture` is the function the page calls for everything it renders; this extends it with `parts`, read from
// server/youtube/parts.ts on the privileged client (the parts view is deliberately not granted to app_user), so a test
// role reading the view would prove nothing about the page. Everything here goes through the loader itself.
//
// What the loader owes the page: the parts in order (empty first), nothing for a division still in setup (an unreleased
// division must not leak a replay), a later part visible on the NEXT uncached read (a second call), another fixture's parts
// never mixed in, and a cache entry whose key moved when the document's shape did (a stale `-v8` entry has no `parts`).
//
// unstable_cache is a Next server-runtime API - passthrough under vitest, as in this directory's other loader suites.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { sql } from "@/lib/db";
import { youtubeWatchUrl } from "@/lib/youtube";
import { rigUser } from "@/server/relay/__tests__/_session-rig";
import { connect } from "@/server/youtube/__tests__/_connect-rig";
import { getPublicFixture } from "../data";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);
const vid = () => `t16${randomUUID().replace(/-/g, "").slice(0, 8)}`;
const at = (hhmm: string) => new Date(`2030-06-01T${hhmm}:00Z`);

const GENERIC_DIVISION_CONFIG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };

const savedKek = process.env.YOUTUBE_TOKEN_KEK;
beforeAll(() => { process.env.YOUTUBE_TOKEN_KEK = randomBytes(32).toString("hex"); });
afterAll(() => {
  if (savedKek === undefined) delete process.env.YOUTUBE_TOKEN_KEK;
  else process.env.YOUTUBE_TOKEN_KEK = savedKek;
});

interface Seeded { orgId: string; orgSlug: string; compSlug: string; divSlug: string; divisionId: string; fixtureIds: [string, string]; connectionId: string }

/** A public org / competition / division with TWO fixtures, by direct insert (this directory's seed, minus venues), and a channel
 *  connected through the real save so a broadcast row has a connection to name. */
async function seed(o: { divisionStatus?: "active" | "setup" } = {}): Promise<Seeded> {
  const s = uniq();
  await sql`insert into sports (key, name, module_version, position_catalog) values ('generic', 'Generic', '1.0.0', '{}') on conflict (key) do nothing`;
  const orgSlug = `t16-org-${s}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`insert into organizations (name, slug) values (${`T16 Org ${s}`}, ${orgSlug}) returning id`;
  const compSlug = `t16-comp-${s}`;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, status) values (${orgId}, ${`T16 Comp ${s}`}, ${compSlug}, 'public', 'live') returning id`;
  const divSlug = `open-${s}`;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (org_id, competition_id, name, slug, sport_key, variant_key, status, config, module_version)
    values (${orgId}, ${compId}, 'Open', ${divSlug}, 'generic', 'score', ${o.divisionStatus ?? "active"}, ${sql.json(GENERIC_DIVISION_CONFIG)}, '1.0.0')
    returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`insert into stages (org_id, division_id, kind, name, seq) values (${orgId}, ${divisionId}, 'league', 'League', 1) returning id`;
  const fixtureIds: string[] = [];
  for (const n of [1, 2]) {
    const [{ id }] = await sql<{ id: string }[]>`
      insert into fixtures (org_id, division_id, stage_id, fixture_no, round_no, seq_in_round) values (${orgId}, ${divisionId}, ${stageId}, ${n}, 1, ${n}) returning id`;
    fixtureIds.push(id);
  }
  const userId = await rigUser();
  const c = await connect({ auth: { orgId, via: "session", userId, role: "owner", keyId: null }, orgId, userId });
  return { orgId, orgSlug, compSlug, divSlug, divisionId, fixtureIds: fixtureIds as [string, string], connectionId: c.connectionId };
}

async function completeBroadcast(s: Seeded, fixtureId: string, completedAt: Date, startedAt?: Date): Promise<string> {
  const ytId = vid();
  await sql`
    insert into youtube_broadcasts (org_id, connection_id, fixture_id, yt_broadcast_id, title, privacy, state, completed_at, created_at)
    values (${s.orgId}, ${s.connectionId}, ${fixtureId}, ${ytId}, 'Match', 'unlisted', 'complete', ${completedAt}, ${startedAt ?? sql`now()`})`;
  return ytId;
}

const seeded: string[] = [];
afterAll(async () => {
  for (const orgId of seeded) await sql`delete from organizations where id = ${orgId}`;
});
const load = (s: Seeded, fixtureId: string) => getPublicFixture(s.orgSlug, s.compSlug, s.divSlug, fixtureId);

describe.skipIf(!HAS_DB)("getPublicFixture carries the fixture's replay parts (T16)", () => {
  it("EMPTY CASE FIRST: a fixture with no broadcast loads with parts []; the same loader then carries Part 1 on the next read", async () => {
    const s = await seed();
    seeded.push(s.orgId);
    const [f] = s.fixtureIds;
    const before = await load(s, f);
    expect(before, "the seeded fixture is publicly visible").not.toBeNull();
    expect(before!.parts).toEqual([]);

    const ytId = await completeBroadcast(s, f, at("10:00"));
    expect((await load(s, f))!.parts).toEqual([{ partNo: 1, url: youtubeWatchUrl(ytId) }]);
  });

  it("two parts come back in the order they STARTED (not finished), and the other fixture of the division carries none of them", async () => {
    const s = await seed();
    seeded.push(s.orgId);
    const [f1, f2] = s.fixtureIds;
    // Part 1 started first and finished last; the restart's row is inserted first and finished first: insertion and completion order are wrong.
    const later = await completeBroadcast(s, f1, at("11:30"), at("11:00"));
    const earlier = await completeBroadcast(s, f1, at("12:00"), at("10:00"));
    expect((await load(s, f1))!.parts).toEqual([
      { partNo: 1, url: youtubeWatchUrl(earlier) },
      { partNo: 2, url: youtubeWatchUrl(later) },
    ]);
    expect((await load(s, f2))!.parts, "the neighbour fixture has none").toEqual([]);
    const own = await completeBroadcast(s, f2, at("09:00"));
    expect((await load(s, f2))!.parts, "and numbers from 1 itself").toEqual([{ partNo: 1, url: youtubeWatchUrl(own) }]);
    expect((await load(s, f1))!.parts.map((p) => p.partNo), "f1 is unchanged by f2's part").toEqual([1, 2]);
  });

  it("a division still in setup loads with no parts even when a complete broadcast exists; the same data is listed once it is active", async () => {
    const s = await seed({ divisionStatus: "setup" });
    seeded.push(s.orgId);
    const [f] = s.fixtureIds;
    const ytId = await completeBroadcast(s, f, at("10:00"));
    const hidden = await load(s, f);
    expect(hidden, "premise: the loader still serves the fixture").not.toBeNull();
    expect(hidden!.parts).toEqual([]);
    await sql`update divisions set status = 'active' where id = ${s.divisionId}`;
    expect((await load(s, f))!.parts).toEqual([{ partNo: 1, url: youtubeWatchUrl(ytId) }]);
  });

  it("a failed or still-open broadcast is not a part", async () => {
    const s = await seed();
    seeded.push(s.orgId);
    const [f] = s.fixtureIds;
    await sql`insert into youtube_broadcasts (org_id, connection_id, fixture_id, yt_broadcast_id, title, privacy, state)
              values (${s.orgId}, ${s.connectionId}, ${f}, ${vid()}, 'Match', 'unlisted', 'failed')`;
    await sql`insert into youtube_broadcasts (org_id, connection_id, fixture_id, yt_broadcast_id, title, privacy, state)
              values (${s.orgId}, ${s.connectionId}, ${f}, ${vid()}, 'Match', 'unlisted', 'live')`;
    expect((await load(s, f))!.parts).toEqual([]);
  });
});
