// `setFixtureStreamUrl` against a real Postgres (the `HAS_DB` skip idiom,
// add-fixture.test.ts:5-17). The point is the SEAM, not the setter: a value
// written here must arrive on `public_fixtures_v`, because `PublicFixture`'s
// column list is hand-maintained in two places and a column read everywhere /
// written nowhere is this repo's most-shipped defect class.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { seedOrg, startedDivisionWithFixture, setupDivisionWithFixture } from "./_rig";
import { setFixtureStreamUrl, setFixtureStreamUrlIfEmpty } from "../fixtures";

/** fireDivisionRevalidate, spied: a pass-through that records each call. */
const revalidated = vi.hoisted(() => ({ calls: [] as { divisionId: string; competitionId: string | undefined }[] }));
vi.mock("@/server/public-site/revalidate", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/public-site/revalidate")>();
  return {
    ...real,
    fireDivisionRevalidate: vi.fn((divisionId: string, competitionId?: string) => {
      revalidated.calls.push({ divisionId, competitionId });
      return real.fireDivisionRevalidate(divisionId, competitionId);
    }),
  };
});
beforeEach(() => { revalidated.calls = []; });

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("setFixtureStreamUrl", () => {
  it("writes the link, returns it, and it arrives on the PUBLIC view", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    const url = "https://www.youtube.com/watch?v=abc123";

    const saved = await setFixtureStreamUrl(auth, fixtureId, url);
    expect(saved).toEqual({ id: fixtureId, stream_url: url });

    const [base] = await sql<{ stream_url: string | null }[]>`
      select stream_url from fixtures where id = ${fixtureId}`;
    expect(base?.stream_url).toBe(url);

    const [view] = await sql<{ stream_url: string | null }[]>`
      select stream_url from public_fixtures_v where id = ${fixtureId}`;
    expect(view?.stream_url, "V401 appended the column to the view — this is the seam").toBe(url);
  });

  it("clears the link with null", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    await setFixtureStreamUrl(auth, fixtureId, "https://twitch.tv/seaznclub");
    const cleared = await setFixtureStreamUrl(auth, fixtureId, null);
    expect(cleared.stream_url).toBeNull();
    const [row] = await sql<{ stream_url: string | null }[]>`
      select stream_url from fixtures where id = ${fixtureId}`;
    expect(row?.stream_url).toBeNull();
  });

  it("404s an id that is not this org's fixture, rather than writing nothing and reporting success", async () => {
    const { auth } = await seedOrg();
    const other = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(other.auth);
    await expect(setFixtureStreamUrl(auth, fixtureId, "https://kick.com/x")).rejects.toBeInstanceOf(HttpError);
  });

  it("refuses a host outside the allowlist at the usecase boundary too, not only at the route", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    await expect(
      setFixtureStreamUrl(auth, fixtureId, "https://evil.example/www.youtube.com"),
    ).rejects.toBeInstanceOf(HttpError);
    const [row] = await sql<{ stream_url: string | null }[]>`
      select stream_url from fixtures where id = ${fixtureId}`;
    expect(row?.stream_url, "a refused link must leave the column untouched").toBeNull();
  });

  // Review finding: V401's own stated purpose ("an unreleased division's
  // stream link must not leak ahead of its schedule") had zero test
  // coverage — both tests above use startedDivisionWithFixture, never a
  // 'setup'-status division, so the view's `case when d.status = 'setup'
  // then null else f.stream_url end` redaction was asserted nowhere.
  it("redacts the link on the PUBLIC view while the division is still in setup, though the base table keeps the real value", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await setupDivisionWithFixture(auth);
    const url = "https://youtu.be/abc123";

    const saved = await setFixtureStreamUrl(auth, fixtureId, url);
    expect(saved).toEqual({ id: fixtureId, stream_url: url });

    const [base] = await sql<{ stream_url: string | null }[]>`
      select stream_url from fixtures where id = ${fixtureId}`;
    expect(base?.stream_url, "the base table always holds the real value").toBe(url);

    const [view] = await sql<{ stream_url: string | null }[]>`
      select stream_url from public_fixtures_v where id = ${fixtureId}`;
    expect(
      view?.stream_url,
      "an unreleased ('setup') division's link must not leak ahead of its schedule",
    ).toBeNull();
  });
});

// The end step's write (YouTube Connect, F-m3): the same path, but the column is only filled while it is EMPTY - decided by the UPDATE
// itself, so a club link saved between the end step's decision and its write is never overwritten.
describe.skipIf(!HAS_DB)("setFixtureStreamUrlIfEmpty", () => {
  const stored = async (fixtureId: string) =>
    (await sql<{ stream_url: string | null }[]>`select stream_url from fixtures where id = ${fixtureId}`)[0]!.stream_url;
  const idsOf = async (fixtureId: string) =>
    (await sql<{ division_id: string; competition_id: string }[]>`
      select f.division_id, d.competition_id from fixtures f join divisions d on d.id = f.division_id where f.id = ${fixtureId}`)[0]!;

  it("an empty link is written, reported written, expires the division's pages once, and arrives on the public view", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    const url = "https://www.youtube.com/watch?v=abc123";
    const ids = await idsOf(fixtureId);
    revalidated.calls = [];   // the rig expired pages of its own

    const out = await setFixtureStreamUrlIfEmpty(auth, fixtureId, url);
    expect(out).toEqual({ id: fixtureId, stream_url: url, written: true });
    expect(await stored(fixtureId)).toBe(url);
    expect((await sql<{ stream_url: string | null }[]>`select stream_url from public_fixtures_v where id = ${fixtureId}`)[0]!.stream_url).toBe(url);
    expect(revalidated.calls, "the same revalidation as the plain write").toEqual([{ divisionId: ids.division_id, competitionId: ids.competition_id }]);
  });

  it("a link already there (a club's own, or Part 1's) is left exactly as it is - reported NOT written - and the pages are still expired (the replay that arrived changes the match page either way)", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    const ids = await idsOf(fixtureId);
    await setFixtureStreamUrl(auth, fixtureId, "https://twitch.tv/seaznclub");
    revalidated.calls = [];

    const out = await setFixtureStreamUrlIfEmpty(auth, fixtureId, "https://www.youtube.com/watch?v=abc123");
    expect(out, "the answer carries what is stored, not what was offered").toEqual({ id: fixtureId, stream_url: "https://twitch.tv/seaznclub", written: false });
    expect(await stored(fixtureId)).toBe("https://twitch.tv/seaznclub");
    expect(revalidated.calls).toEqual([{ divisionId: ids.division_id, competitionId: ids.competition_id }]);
  });

  it("the sequence: written, then cleared by the club (null), then offered again - written again; and once more it is taken", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    const first = "https://www.youtube.com/watch?v=aaa111";
    const second = "https://www.youtube.com/watch?v=bbb222";
    expect((await setFixtureStreamUrlIfEmpty(auth, fixtureId, first)).written).toBe(true);
    expect((await setFixtureStreamUrlIfEmpty(auth, fixtureId, second)).written, "taken").toBe(false);
    await setFixtureStreamUrl(auth, fixtureId, null);
    expect((await setFixtureStreamUrlIfEmpty(auth, fixtureId, second)).written, "empty again").toBe(true);
    expect(await stored(fixtureId)).toBe(second);
    expect((await setFixtureStreamUrlIfEmpty(auth, fixtureId, first)).written, "taken again").toBe(false);
    expect(await stored(fixtureId)).toBe(second);
  });

  it("THE RACE: many writers at once - exactly one is written, and what is stored is that writer's link (an unconditional write would report every one of them written)", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    const urls = Array.from({ length: 12 }, (_, i) => `https://www.youtube.com/watch?v=race${String(i).padStart(4, "0")}`);
    const outs = await Promise.all(urls.map((u) => setFixtureStreamUrlIfEmpty(auth, fixtureId, u)));
    const winners = outs.filter((o) => o.written);
    expect(outs, "anti-vacuity: every writer answered").toHaveLength(urls.length);
    expect(winners, "exactly one writer won").toHaveLength(1);
    expect(await stored(fixtureId)).toBe(winners[0]!.stream_url);
    expect(urls, "and it is one of the offered links").toContain(winners[0]!.stream_url);
    for (const o of outs.filter((x) => !x.written)) expect(o.stream_url, "the others are told what won").toBe(winners[0]!.stream_url);
  });

  it("refuses what the plain write refuses: a fixture that is not this org's is a 404 (never `written: false`), a host outside the allowlist a 422, and neither touches the column or expires anything", async () => {
    const { auth } = await seedOrg();
    const other = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(other.auth);
    const mine = await startedDivisionWithFixture(auth);
    revalidated.calls = [];
    await expect(setFixtureStreamUrlIfEmpty(auth, fixtureId, "https://www.youtube.com/watch?v=abc123")).rejects.toMatchObject({ status: 404 });
    await expect(setFixtureStreamUrlIfEmpty(auth, mine.fixtureId, "https://evil.example/www.youtube.com")).rejects.toMatchObject({ status: 422 });
    expect(await stored(fixtureId)).toBeNull();
    expect(await stored(mine.fixtureId)).toBeNull();
    expect(revalidated.calls).toEqual([]);
  });
});
