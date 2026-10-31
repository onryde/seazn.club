// R4 sponsors on stream, S7 (ruling R6): the client-safe click helpers. S10 adds the server's `recordClick` beside them
// in `server/`; the overlay card (client code) and the redirect route share these.
//
// Where the expected values come from: the click sources from the V483 CHECK on `sponsor_clicks.source` (the
// database's own declaration, read back from the migration), the tag shape from spec 2026-10-27 §3.7
// (`/s/[sponsorId]?f=<fixtureId>&src=match|stream|site`, anything else `unknown`), and the short-code pattern from
// `lib/sponsor-short-code.ts` (owner ruling R7).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLICK_SOURCES,
  SPONSOR_LINK_HOST,
  parseClickTag,
  sponsorShortLinkText,
  streamClickPath,
} from "../sponsor-clicks";
import { SPONSOR_SHORT_CODE_ALPHABET, SPONSOR_SHORT_CODE_MIN_LENGTH } from "../sponsor-short-code";

const SPONSOR = "6f1c2b9e-1d2a-4c3b-9e8f-7a6b5c4d3e2f";
const FIXTURE = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

describe("CLICK_SOURCES", () => {
  it("is exactly the V483 CHECK's set on sponsor_clicks.source", () => {
    const sql = readFileSync(fileURLToPath(new URL("../../../../../db/migration/deltas/V483__sponsor_rotation.sql", import.meta.url)), "utf8");
    const check = /sponsor_clicks_source_check check \(source in \(([^)]*)\)\)/.exec(sql);
    expect(check, "the CHECK is found in the migration").not.toBeNull();
    const declared = [...check![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(declared.length, "anti-vacuity").toBeGreaterThan(0);
    expect([...CLICK_SOURCES].sort()).toEqual([...declared].sort());
  });
});

describe("parseClickTag", () => {
  it("the three tagged sources pass through; a fixture uuid is kept", () => {
    let checked = 0;
    for (const src of ["match", "stream", "site"] as const) {
      expect(parseClickTag(new URLSearchParams({ f: FIXTURE, src }))).toEqual({ fixtureId: FIXTURE, source: src });
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("the empty case: no query at all — no fixture, source unknown", () => {
    expect(parseClickTag(new URLSearchParams())).toEqual({ fixtureId: null, source: "unknown" });
  });

  it("anything else is unknown — never a guess, never an echo of the input", () => {
    for (const src of ["", "STREAM", "Stream", "unknown", "email", "javascript:alert(1)", " stream"]) {
      expect(parseClickTag(new URLSearchParams({ src })).source, JSON.stringify(src)).toBe("unknown");
    }
  });

  it("a fixture that is not a uuid is dropped (the row's fixture_id is a uuid foreign key)", () => {
    for (const f of ["", "42", "not-a-uuid", `${FIXTURE}x`, "'; drop table fixtures; --"]) {
      expect(parseClickTag(new URLSearchParams({ f, src: "stream" })), JSON.stringify(f)).toEqual({ fixtureId: null, source: "stream" });
    }
  });

  it("a repeated parameter reads its first value", () => {
    const q = new URLSearchParams([
      ["src", "site"],
      ["src", "stream"],
      ["f", FIXTURE],
      ["f", SPONSOR],
    ]);
    expect(parseClickTag(q)).toEqual({ fixtureId: FIXTURE, source: "site" });
  });
});

describe("streamClickPath", () => {
  it("is the §3.7 shape, and parses back to the stream tag (round trip)", () => {
    const path = streamClickPath(SPONSOR, FIXTURE);
    expect(path).toBe(`/s/${SPONSOR}?f=${FIXTURE}&src=stream`);
    const url = new URL(path, "https://seazn.club");
    expect(url.pathname).toBe(`/s/${SPONSOR}`);
    expect(parseClickTag(url.searchParams)).toEqual({ fixtureId: FIXTURE, source: "stream" });
  });

  it("encodes its parts: a stray character cannot add a parameter", () => {
    const path = streamClickPath("a&src=site", "b#c");
    const url = new URL(path, "https://seazn.club");
    expect(url.searchParams.getAll("src")).toEqual(["stream"]);
    expect(url.searchParams.get("f")).toBe("b#c");
  });
});

describe("sponsorShortLinkText (R7)", () => {
  it("a valid code reads seazn.club/s/<code>", () => {
    const code = SPONSOR_SHORT_CODE_ALPHABET.slice(-SPONSOR_SHORT_CODE_MIN_LENGTH);
    expect(SPONSOR_LINK_HOST).toBe("seazn.club");
    expect(sponsorShortLinkText(code)).toBe(`seazn.club/s/${code}`);
  });

  it("no code, or one outside the pattern: null (the card prints nothing link-like)", () => {
    for (const code of [undefined, null, "", "abcd", "AB1C", SPONSOR, "ABCD "]) {
      expect(sponsorShortLinkText(code), JSON.stringify(code)).toBeNull();
    }
  });
});
