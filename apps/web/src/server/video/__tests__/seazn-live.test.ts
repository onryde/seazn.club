// Seazn-hosted video, Phase 1 Task 17: which of a set of matches are ON AIR to Seazn right now (`liveSeaznFixtureIds`, the one
// predicate Match Day's board and the phone's day read both ask), and the public match page's address for each of them
// (`seaznWatchUrls`, the phone's "Watch live" link).
//
// The rule, from the plan: a match is on air to Seazn exactly when its LATEST session (by creation) is a Seazn session in state
// `live`. That is the same fact `seaznFixtureVideoForOrg` reads for its `live` (server/video/seazn-video.ts), so a board that says
// "live on Seazn" always has a live to play. Warming, ending, ended, an external destination, a later external session and another
// organisation's match are all NOT on air. The phone's address adds two conditions: the public page is readable (public_fixtures_v,
// division past setup) and the origin is https, so a private competition or a local dev server gives no link.
//
// Every session comes from a REAL producer (the organiser's Go live, the Machine's playing beat, Stop: _seazn-session-rig.ts). The
// expected address is built from the plan's pattern and the slugs read back from the rows, never from `routes`.
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): the read never reads a sport rule; every rig rides `generic`.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { heartbeat } from "@/server/usecases/stream-sessions";
import { liveSeaznFixtureIds, seaznWatchUrls } from "../seazn-live";
import { installSeaznEnv, kindOf, live, goLive, seaznRig as rig, stopAndSettle } from "./_seazn-session-rig";

const HAS_DB = !!process.env.DATABASE_URL;
installSeaznEnv("seazn-live-test");

const slugsOf = async (fixtureId: string) => {
  const [r] = await sql<{ org: string; comp: string; div: string }[]>`
    select o.slug as org, c.slug as comp, d.slug as div
      from fixtures f join divisions d on d.id = f.division_id join competitions c on c.id = d.competition_id join organizations o on o.id = c.org_id
     where f.id = ${fixtureId}`;
  return r!;
};
const watchUrl = (origin: string, s: { org: string; comp: string; div: string }, id: string) =>
  `${origin}/live/${s.org}/${s.comp}/${s.div}/fixtures/${id}`;

describe.skipIf(!HAS_DB)("liveSeaznFixtureIds: on air to Seazn right now", () => {
  it("EMPTY CASE FIRST: no ids, an id that names nothing and a fixture with no session are all absent", async () => {
    const r = await rig();
    expect([...(await liveSeaznFixtureIds(r.auth.orgId, []))]).toEqual([]);
    expect([...(await liveSeaznFixtureIds(r.auth.orgId, [randomUUID()]))]).toEqual([]);
    expect([...(await liveSeaznFixtureIds(r.auth.orgId, [...r.fixtureIds]))], "two started fixtures, no session yet").toEqual([]);
  });

  it("the state sequence of one match: warming no, live YES, ended no — and a second ask after the stop is still no", async () => {
    const r = await rig();
    const [f] = r.fixtureIds;
    const ids = (): Promise<string[]> => liveSeaznFixtureIds(r.auth.orgId, [f]).then((s) => [...s]);
    const sid = await goLive(r, f, r.seazn);
    expect(await kindOf(sid), "PREMISE: the producer wrote the destination kind").toBe("seazn");
    expect(await ids(), "warming: the Machine has not played yet").toEqual([]);
    // The Machine's playing beat, through the producer the rig names.
    const spec = r.runner.created.find((c) => c.sessionId === sid)!;
    await heartbeat(sid, spec.jobToken, { state: "playing" }, r.deps);
    expect(await ids(), "live").toEqual([f]);
    expect(await ids(), "a second ask answers the same").toEqual([f]);
    await stopAndSettle(r, f, sid);
    expect(await ids(), "ended").toEqual([]);
    expect(await ids(), "and again").toEqual([]);
  });

  it("only the Seazn live of the asked set: a live pasted-key session on the other match is absent, and both are asked at once", async () => {
    const r = await rig();
    const [seazn, pasted] = r.fixtureIds;
    const a = await live(r, seazn, r.seazn);
    const b = await live(r, pasted, r.pasted);
    expect(await kindOf(a)).toBe("seazn");
    expect(await kindOf(b), "PREMISE: the other session is an external one").not.toBe("seazn");
    expect([...(await liveSeaznFixtureIds(r.auth.orgId, [seazn, pasted]))]).toEqual([seazn]);
    expect([...(await liveSeaznFixtureIds(r.auth.orgId, [pasted]))], "asked alone").toEqual([]);
  });

  it("the LATEST session decides: a Seazn live that was stopped, then a live pasted-key session, is not on air to Seazn; and back", async () => {
    const r = await rig();
    const [f] = r.fixtureIds;
    const first = await live(r, f, r.seazn);
    await stopAndSettle(r, f, first);
    const second = await live(r, f, r.pasted);
    expect([...(await liveSeaznFixtureIds(r.auth.orgId, [f]))], "the later session is external").toEqual([]);
    await stopAndSettle(r, f, second);
    await live(r, f, r.seazn);
    expect([...(await liveSeaznFixtureIds(r.auth.orgId, [f]))], "a later Seazn session is on air again").toEqual([f]);
  });

  it("org scope: another organisation asking about this match gets nothing, while this one's own ask answers it", async () => {
    const r = await rig();
    const other = await rig();
    const [f] = r.fixtureIds;
    await live(r, f, r.seazn);
    expect([...(await liveSeaznFixtureIds(other.auth.orgId, [f]))], "the stranger's ask").toEqual([]);
    expect([...(await liveSeaznFixtureIds(r.auth.orgId, [f]))], "the owner's ask (the positive pair)").toEqual([f]);
  });
});

describe.skipIf(!HAS_DB)("seaznWatchUrls: the phone's Watch live link", () => {
  const ORIGIN = "https://seazn.club";

  it("EMPTY CASE FIRST: nothing on air, no ids → no link", async () => {
    const r = await rig();
    expect([...(await seaznWatchUrls(r.auth.orgId, [], ORIGIN))]).toEqual([]);
    expect([...(await seaznWatchUrls(r.auth.orgId, [...r.fixtureIds], ORIGIN))], "two matches, none on air").toEqual([]);
  });

  it("an on-air match of a public competition: the public match page on the origin, no query and no fragment; the match that is not on air has none", async () => {
    const r = await rig();
    const [f, idle] = r.fixtureIds;
    await live(r, f, r.seazn);
    const urls = await seaznWatchUrls(r.auth.orgId, [f, idle], ORIGIN);
    expect([...urls.keys()]).toEqual([f]);
    expect(urls.get(f)).toBe(watchUrl(ORIGIN, await slugsOf(f), f));
    expect(urls.get(f)).not.toMatch(/[?#]/);
  });

  it("an UNLISTED competition's page is readable (it is in public_fixtures_v), a PRIVATE one's is not: no link, though the match is on air", async () => {
    const r = await rig();
    const [f] = r.fixtureIds;
    await live(r, f, r.seazn);
    const [comp] = await sql<{ id: string }[]>`select d.competition_id as id from fixtures x join divisions d on d.id = x.division_id where x.id = ${f}`;
    await sql`update competitions set visibility = 'unlisted' where id = ${comp!.id}`;
    expect(await seaznWatchUrls(r.auth.orgId, [f], ORIGIN), "unlisted").toEqual(new Map([[f, watchUrl(ORIGIN, await slugsOf(f), f)]]));
    await sql`update competitions set visibility = 'private' where id = ${comp!.id}`;
    expect([...(await seaznWatchUrls(r.auth.orgId, [f], ORIGIN))], "private").toEqual([]);
    expect([...(await liveSeaznFixtureIds(r.auth.orgId, [f]))], "PREMISE: the board still calls it on air").toEqual([f]);
  });

  it("a division back in setup has no public page: no link", async () => {
    const r = await rig();
    const [f] = r.fixtureIds;
    await live(r, f, r.seazn);
    await sql`update divisions set status = 'setup' where id = (select division_id from fixtures where id = ${f})`;
    expect([...(await seaznWatchUrls(r.auth.orgId, [f], ORIGIN))]).toEqual([]);
  });

  it("only an https origin gives a link: http://localhost gives none, and so does an origin that is not a URL at all", async () => {
    const r = await rig();
    const [f] = r.fixtureIds;
    await live(r, f, r.seazn);
    for (const origin of ["http://localhost:3000", "http://seazn.club", "seazn.club", ""]) {
      expect([...(await seaznWatchUrls(r.auth.orgId, [f], origin))], `origin ${JSON.stringify(origin)}`).toEqual([]);
    }
    expect([...(await seaznWatchUrls(r.auth.orgId, [f], "https://stg.seazn.club")).keys()], "the positive pair: staging's own host").toEqual([f]);
  });

  it("a link the phone's contract would refuse is left out and logged by match id: an upper-case host, a path in the origin and userinfo give none; a lower-case host with a port still does", async () => {
    // The phone parses the whole day read strictly: ONE refused link would refuse every row, so the producer never emits one.
    const r = await rig();
    const [f] = r.fixtureIds;
    await live(r, f, r.seazn);
    const slugs = await slugsOf(f);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      let refused = 0;
      for (const origin of ["https://Seazn.club", "https://seazn.club/app", "https://user:pw@seazn.club", "https://seazn.club/app/"]) {
        expect([...(await seaznWatchUrls(r.auth.orgId, [f], origin))], `origin ${origin}: no link, though the match is on air`).toEqual([]);
        refused++;
      }
      expect(refused, "anti-vacuity: four refused origins were asked").toBe(4);
      expect(warn, "one warning per dropped link").toHaveBeenCalledTimes(4);
      for (const call of warn.mock.calls) expect(call[0], "the warning names the match").toEqual({ fixtureId: f });
      const logged = JSON.stringify(warn.mock.calls);
      for (const leak of ["Seazn.club", "seazn.club", "/live/", slugs.org, slugs.comp]) expect(logged, `the log carries no part of the address (${leak})`).not.toContain(leak);
      // The positive pair: the same match on an origin the contract admits (a lower-case host with a port) gives its link, and no warning.
      warn.mockClear();
      expect([...(await seaznWatchUrls(r.auth.orgId, [f], "https://seazn.club:8443"))]).toEqual([[f, watchUrl("https://seazn.club:8443", slugs, f)]]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("org scope: another organisation's ask for this match gets no link", async () => {
    const r = await rig();
    const other = await rig();
    const [f] = r.fixtureIds;
    await live(r, f, r.seazn);
    expect([...(await seaznWatchUrls(other.auth.orgId, [f], ORIGIN))]).toEqual([]);
  });
});
