// Phase 0, YouTube channel safety, Task 2: the per-fixture runaway ceiling. A fixture may create 10 YouTube broadcasts in any 60
// minutes; the 11th is refused `youtube_limit_reached` by Seazn's own guard with NO call to YouTube. A human Stop/Go live cycle is
// never blocked below it. The sequence runs through the REAL prepareYoutubeBroadcast against the fake port on an injected clock.
// The ceiling's refusal is Seazn's, not YouTube's: it must never open the automatic start's backoff (Task 1).
// Sport: not applicable — the ceiling reads youtube_broadcasts rows, never a sport rule.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { YOUTUBE_MAX_BROADCASTS_PER_FIXTURE_PER_HOUR } from "@/lib/youtube";
import type { StartCause } from "@/server/relay/domain/session";
import { divisionRig } from "@/server/usecases/__tests__/_rig";
import { FakeYouTube } from "@/server/youtube/fake";
import { prepareYoutubeBroadcast } from "@/server/youtube/prepare";
import { connect, org } from "./_connect-rig";

const HAS_DB = !!process.env.DATABASE_URL;
const minutesAfter = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

const KEKS = ["YOUTUBE_TOKEN_KEK", "RELAY_KEK"] as const;
const savedKeks = Object.fromEntries(KEKS.map((k) => [k, process.env[k]]));
beforeAll(() => { for (const k of KEKS) process.env[k] = randomBytes(32).toString("hex"); });
afterAll(() => {
  for (const k of KEKS) {
    if (savedKeks[k] === undefined) delete process.env[k];
    else process.env[k] = savedKeks[k];
  }
});

async function world() {
  const o = await org();
  const c = await connect(o);
  const d = await divisionRig(o.auth, { entrants: 3 });
  return { orgId: o.orgId, connectionId: c.connectionId, targetId: c.targetId, fixtures: d.fixtureIds, token: c.token, fake: new FakeYouTube() };
}
type W = Awaited<ReturnType<typeof world>>;
const prep = (w: W, fixtureId: string, now: Date, startCause: StartCause = "organiser") =>
  prepareYoutubeBroadcast({ orgId: w.orgId, fixtureId, targetId: w.targetId, now, startCause }, w.fake);
async function refusal(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error("expected a refusal, got an answer");
}
/** Stop: the fixture's open broadcast leaves the open states (the row stays, and still counts toward the hour). */
const stop = async (w: W, fixtureId: string) => {
  const rows = await sql<{ yt: string | null }[]>`
    update youtube_broadcasts set state = 'failed'
     where org_id = ${w.orgId} and fixture_id = ${fixtureId} and state in ('created', 'bound', 'reserved', 'live')
    returning yt_broadcast_id as yt`;
  // YouTube's side of Stop: the broadcast leaves the key (the fake allows three open on one key). Its own calls are not counted below.
  const at = await w.fake.accessToken(w.token);
  for (const r of rows) if (r.yt) await w.fake.deleteBroadcast(at, r.yt);
};
const insertBroadcasts = (w: W) => w.fake.calls.filter((c) => c.method === "insertBroadcast").length;
const rowCount = async (w: W, fixtureId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from youtube_broadcasts where org_id = ${w.orgId} and fixture_id = ${fixtureId}`)[0]!.n;
const backoffCount = async (w: W) =>
  (await sql<{ n: number }[]>`select auto_backoff_count as n from org_youtube_connections where id = ${w.connectionId}`)[0]!.n;

describe("the ceiling's number", () => {
  it("is 10 per fixture per hour (the plan's literal)", () => {
    expect(YOUTUBE_MAX_BROADCASTS_PER_FIXTURE_PER_HOUR).toBe(10);
  });
});

describe.skipIf(!HAS_DB)("prepareYoutubeBroadcast — the per-fixture runaway ceiling", () => {
  it("SEQUENCE: 10 Stop/Go live cycles succeed → the 11th and 12th refuse with NO insert and no new row → 61 minutes later it succeeds", async () => {
    const w = await world();
    const [f1] = w.fixtures as [string, string, string];
    const t0 = new Date();

    for (let i = 0; i < 10; i++) {
      expect(await prep(w, f1, minutesAfter(t0, i))).not.toBeNull();
      await stop(w, f1);
    }
    expect(insertBroadcasts(w)).toBe(10);
    expect(await rowCount(w, f1)).toBe(10);

    for (let i = 0; i < 2; i++) {
      const refused = await refusal(prep(w, f1, minutesAfter(t0, 11)));
      expect([refused.code, refused.status, refused.extra]).toEqual(["youtube_limit_reached", 429, { connectionId: w.connectionId }]);
      expect(insertBroadcasts(w)).toBe(10);       // no call to YouTube
      expect(await rowCount(w, f1)).toBe(10);     // a refused attempt adds no row, so it never extends the window
    }

    expect(await prep(w, f1, minutesAfter(t0, 61))).not.toBeNull();
    expect(insertBroadcasts(w)).toBe(11);
  });

  it("another fixture of the same channel is unaffected", async () => {
    const w = await world();
    const [f1, f2] = w.fixtures as [string, string, string];
    const t0 = new Date();
    for (let i = 0; i < 10; i++) {
      await prep(w, f1, minutesAfter(t0, i));
      await stop(w, f1);
    }
    expect((await refusal(prep(w, f1, minutesAfter(t0, 11)))).code).toBe("youtube_limit_reached");
    expect(await prep(w, f2, minutesAfter(t0, 11))).not.toBeNull();
  });

  it("an AUTOMATIC start refused by the ceiling opens no backoff window (it is Seazn's own refusal, not YouTube's)", async () => {
    const w = await world();
    const [f1] = w.fixtures as [string, string, string];
    const t0 = new Date();
    for (let i = 0; i < 10; i++) {
      await prep(w, f1, minutesAfter(t0, i));
      await stop(w, f1);
    }
    const refused = await refusal(prep(w, f1, minutesAfter(t0, 11), "automatic"));
    expect(refused.code).toBe("youtube_limit_reached");
    expect(await backoffCount(w)).toBe(0);
  });
});
