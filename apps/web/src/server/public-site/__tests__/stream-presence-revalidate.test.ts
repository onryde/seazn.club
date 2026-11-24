// Seazn-hosted video T47: the camera appears and clears PROMPTLY. A stream session that goes INTO `live`, or OUT of it (ending), expires the
// fixture's public hub (`fireStreamPresenceRevalidate`: the division's and competition's tags, then the competition's Redis hub document by
// name), after the transaction commits, fire-and-forget. Any other transition changes nothing the card shows and fires nothing.
//
// Two halves, each with its own witness:
//   - the SEAM: the organiser's real Go live, the Machine's playing beat, Stop (the stream-sessions `apply`), counted per transition, so
//     "drop the revalidate on go-live" is a red here and a wired-but-never-fired function is not a green;
//   - the EFFECT: the real function against the real fixture row, with the Next tag call and the Redis delete observed.
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): a session transition reads no sport rule. Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));
const tagCalls = vi.hoisted(() => [] as { tag: string; profile: unknown }[]);
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn((tag: string, profile?: unknown) => {
    tagCalls.push({ tag, profile });
  }),
  revalidatePath: vi.fn(),
}));
const cacheDelSpy = vi.hoisted(() => vi.fn<(...keys: string[]) => Promise<void>>(async () => undefined));
vi.mock("@/lib/cache", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/cache")>()), cacheDel: cacheDelSpy }));
vi.mock("@/server/public-site/revalidate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/public-site/revalidate")>();
  return { ...actual, fireStreamPresenceRevalidate: vi.fn(actual.fireStreamPresenceRevalidate) };
});

import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { fireStreamPresenceRevalidate } from "@/server/public-site/revalidate";
import { competitionTag, divisionTag } from "@/server/public-site/cache-tags";
import { publicHubCacheKey } from "@/server/public-site/hub-doc-cache-keys";
import { stopSession } from "@/server/usecases/stream-sessions";
import { goLive, installSeaznEnv, live, seaznRig, stateOf, stopAndSettle } from "@/server/video/__tests__/_seazn-session-rig";

const HAS_DB = !!process.env.DATABASE_URL;
installSeaznEnv("stream-presence-revalidate");
const spy = vi.mocked(fireStreamPresenceRevalidate);
const orgs: string[] = [];
afterAll(async () => {
  for (const orgId of orgs) await sql`delete from organizations where id = ${orgId}`.catch(() => undefined);
});
/** The fixtures the seam has fired for, in order, after every fire's own work has finished. */
async function fired(): Promise<string[]> {
  await Promise.all(spy.mock.results.map((r) => r.value as Promise<void>));
  return spy.mock.calls.map((c) => c[0]);
}

describe.skipIf(!HAS_DB)("a session going into or out of live expires the public hub (T47)", () => {
  it("EMPTY CASE FIRST: a session that never reaches live, and is stopped, fires nothing", async () => {
    spy.mockClear();
    const r = await seaznRig();
    orgs.push(r.auth.orgId);
    const f = r.fixtureIds[0];
    const sid = await goLive(r, f, r.seazn);
    expect(await stateOf(sid), "PREMISE: the session is waiting for its playing beat").not.toBe("live");
    await stopSession(r.auth, f, sid, r.deps);
    expect(await fired(), "warming -> stopped: nothing the card shows moved").toEqual([]);
  });

  it("go live fires once, Stop (live -> ending) fires once, settling (ending -> completed) fires nothing, a SECOND session's go live fires again", async () => {
    spy.mockClear();
    const r = await seaznRig();
    orgs.push(r.auth.orgId);
    const f = r.fixtureIds[0];
    const sid = await live(r, f, r.seazn);
    expect(await fired(), "the playing beat: warming -> live").toEqual([f]);
    await stopAndSettle(r, f, sid);
    expect(await fired(), "Stop: live -> ending (the settle ending -> completed adds none)").toEqual([f, f]);
    const second = await live(r, f, r.seazn);
    expect(await fired(), "a second session going live on the same fixture").toEqual([f, f, f]);
    await stopAndSettle(r, f, second);
    expect(await fired()).toEqual([f, f, f, f]);
  });

  it("the other fixture of the same org is not named, and a fixture with no session never fires", async () => {
    spy.mockClear();
    const r = await seaznRig();
    orgs.push(r.auth.orgId);
    const [a, b] = r.fixtureIds;
    await live(r, a, r.seazn);
    expect(await fired()).toEqual([a]);
    expect(await fired()).not.toContain(b);
  });
});

describe.skipIf(!HAS_DB)("fireStreamPresenceRevalidate: the effect, on the real fixture row (T47)", () => {
  it("expires the division (now) and competition tags and drops the competition's Redis hub document by name", async () => {
    const r = await seaznRig();
    orgs.push(r.auth.orgId);
    const f = r.fixtureIds[0];
    const [row] = await sql<{ division_id: string; competition_id: string }[]>`
      select f.division_id, d.competition_id from fixtures f join divisions d on d.id = f.division_id where f.id = ${f}`;
    tagCalls.length = 0;
    cacheDelSpy.mockClear();
    await fireStreamPresenceRevalidate(f);
    expect(tagCalls, "the competition tag stale-while-revalidate, then the division expired (the order is load-bearing)").toEqual([
      { tag: competitionTag(row!.competition_id), profile: "max" },
      { tag: divisionTag(row!.division_id), profile: { expire: 0 } },
    ]);
    expect(cacheDelSpy).toHaveBeenCalledTimes(1);
    expect(cacheDelSpy).toHaveBeenCalledWith(publicHubCacheKey(row!.competition_id));
  });

  it("a fixture that does not exist expires nothing and does not throw; a failing Redis delete never rejects (the committed change stands)", async () => {
    tagCalls.length = 0;
    cacheDelSpy.mockClear();
    await expect(fireStreamPresenceRevalidate(randomUUID())).resolves.toBeUndefined();
    expect(tagCalls).toEqual([]);
    expect(cacheDelSpy).not.toHaveBeenCalled();
    const r = await seaznRig();
    orgs.push(r.auth.orgId);
    tagCalls.length = 0;
    cacheDelSpy.mockRejectedValueOnce(new Error("redis down"));
    await expect(fireStreamPresenceRevalidate(r.fixtureIds[0])).resolves.toBeUndefined();
    expect(tagCalls.length, "the tags were still expired before the delete failed").toBe(2);
  });
});
