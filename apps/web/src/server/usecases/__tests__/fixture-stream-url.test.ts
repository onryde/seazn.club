// `setFixtureStreamUrl` against a real Postgres (the `HAS_DB` skip idiom,
// add-fixture.test.ts:5-17). The point is the SEAM, not the setter: a value
// written here must arrive on `public_fixtures_v`, because `PublicFixture`'s
// column list is hand-maintained in two places and a column read everywhere /
// written nowhere is this repo's most-shipped defect class.
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { seedOrg, startedDivisionWithFixture } from "./_rig";
import { setFixtureStreamUrl } from "../fixtures";

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
});
