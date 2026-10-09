import { describe, expect, it } from "vitest";
import { parseFixtureLink } from "../fixture-link";

const WANT = { orgSlug: "acme", compSlug: "summer-cup", divSlug: "open-1", fixtureNo: 12 };

describe("parseFixtureLink (#858)", () => {
  it("reads a relative console path", () => {
    expect(parseFixtureLink("/o/acme/c/summer-cup/d/open-1/f/12")).toEqual(WANT);
  });

  it("reads an absolute URL on any host", () => {
    expect(parseFixtureLink("https://seazn.club/o/acme/c/summer-cup/d/open-1/f/12")).toEqual(WANT);
    expect(parseFixtureLink("http://localhost:3000/o/acme/c/summer-cup/d/open-1/f/12")).toEqual(WANT);
  });

  it("tolerates a trailing slash and surrounding whitespace", () => {
    expect(parseFixtureLink("  /o/acme/c/summer-cup/d/open-1/f/12/  ")).toEqual(WANT);
    expect(parseFixtureLink("https://seazn.club/o/acme/c/summer-cup/d/open-1/f/12/")).toEqual(WANT);
  });

  it("ignores a query string and hash", () => {
    expect(parseFixtureLink("/o/acme/c/summer-cup/d/open-1/f/12?tab=pad#x")).toEqual(WANT);
    expect(
      parseFixtureLink("https://seazn.club/o/acme/c/summer-cup/d/open-1/f/12/?tab=pad"),
    ).toEqual(WANT);
  });

  it("refuses a bad slug", () => {
    expect(parseFixtureLink("/o/Acme Org/c/summer-cup/d/open-1/f/12")).toBeNull();
    expect(parseFixtureLink("/o/acme/c/-cup/d/open-1/f/12")).toBeNull();
    expect(parseFixtureLink("/o/acme/c/summer-cup/d/OPEN/f/12")).toBeNull();
    expect(parseFixtureLink("/o/acme/c/summer%20cup/d/open-1/f/12")).toBeNull();
  });

  it("refuses a non-positive or non-integer match number", () => {
    for (const no of ["0", "-1", "1.5", "abc", "012", "99999999999"]) {
      expect(parseFixtureLink(`/o/acme/c/summer-cup/d/open-1/f/${no}`)).toBeNull();
    }
  });

  it("stops at the int4 ceiling of fixtures.fixture_no, so Postgres never sees an out-of-range number", () => {
    expect(parseFixtureLink("/o/acme/c/summer-cup/d/open-1/f/2147483647")?.fixtureNo).toBe(
      2147483647,
    );
    expect(parseFixtureLink("/o/acme/c/summer-cup/d/open-1/f/2147483648")).toBeNull();
  });

  it("refuses anything that is not the match address", () => {
    expect(parseFixtureLink("")).toBeNull();
    expect(parseFixtureLink("acme/summer-cup")).toBeNull();
    expect(parseFixtureLink("/o/acme/c/summer-cup/d/open-1")).toBeNull();
    expect(parseFixtureLink("/o/acme/c/summer-cup/d/open-1/f/12/extra")).toBeNull();
    expect(parseFixtureLink("/shared/acme/summer-cup/open-1/f/12")).toBeNull();
    expect(parseFixtureLink("ftp://seazn.club/o/acme/c/summer-cup/d/open-1/f/12")).toBeNull();
    expect(parseFixtureLink("https://")).toBeNull();
    expect(parseFixtureLink("3f2a1c9e-0000-4000-8000-000000000000")).toBeNull();
  });
});
