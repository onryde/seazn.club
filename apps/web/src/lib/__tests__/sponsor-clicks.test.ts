// R4 sponsors on stream, S7 (ruling R6) and S10: the client-safe click helpers. The server's `recordClick` lives in
// `server/sponsors/clicks.ts`; the overlay card (client code), the boards and the redirect route share these.
//
// Where the expected values come from: the click sources from the V483 CHECK on `sponsor_clicks.source` (the
// database's own declaration, read back from the migration), the tag shape from spec 2026-10-27 §3.7
// (`/s/<sponsorId>?f=<fixtureId>&src=match|site`, anything else `unknown`; a `stream` claim on a link is `unknown` too —
// owner ruling R7 "a", 2026-10-31: stream clicks come only through `/s/<code>`), and the short-code pattern from
// `lib/sponsor-short-code.ts` (owner ruling R7).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLICK_SOURCES,
  SPONSOR_LINK_HOST,
  classifySponsorLink,
  parseClickTag,
  redirectTarget,
  sponsorClickPath,
  sponsorShortLinkText,
} from "../sponsor-clicks";
import {
  SPONSOR_SHORT_CODE_ALPHABET,
  SPONSOR_SHORT_CODE_MAX_LENGTH,
  SPONSOR_SHORT_CODE_MIN_LENGTH,
} from "../sponsor-short-code";

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
  it("the two sources a LINK may claim pass through; a fixture uuid is kept", () => {
    let checked = 0;
    for (const src of ["match", "site"] as const) {
      expect(parseClickTag(new URLSearchParams({ f: FIXTURE, src }))).toEqual({ fixtureId: FIXTURE, source: src });
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("R7 \"a\": a link claiming `stream` reads `unknown` (fixture kept) — only a short code is a stream click", () => {
    expect(CLICK_SOURCES, "premise: `stream` is a stored source").toContain("stream");
    expect(parseClickTag(new URLSearchParams({ f: FIXTURE, src: "stream" }))).toEqual({ fixtureId: FIXTURE, source: "unknown" });
    expect(parseClickTag(new URLSearchParams({ src: "stream" }))).toEqual({ fixtureId: null, source: "unknown" });
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
      expect(parseClickTag(new URLSearchParams({ f, src: "match" })), JSON.stringify(f)).toEqual({ fixtureId: null, source: "match" });
    }
  });

  it("a repeated parameter reads its first value", () => {
    const q = new URLSearchParams([
      ["src", "site"],
      ["src", "match"],
      ["f", FIXTURE],
      ["f", SPONSOR],
    ]);
    expect(parseClickTag(q)).toEqual({ fixtureId: FIXTURE, source: "site" });
  });
});

// S10: the boards' tagged links. `streamClickPath` (S7) is gone: owner ruling R7 put a SHORT CODE on the stream, so no
// caller ever printed a uuid stream link (controller addendum 2026-10-31: superseded, an inert seam if kept).
describe("sponsorClickPath — the boards' tagged links (S10, D15)", () => {
  it("the competition page's tag: `?src=site`, no fixture — and it parses back to itself (round trip)", () => {
    const path = sponsorClickPath(SPONSOR, { source: "site" });
    expect(path).toBe(`/s/${SPONSOR}?src=site`);
    const url = new URL(path, "https://seazn.club");
    expect(classifySponsorLink(url.pathname.slice("/s/".length))).toEqual({ kind: "sponsor", sponsorId: SPONSOR });
    expect(parseClickTag(url.searchParams)).toEqual({ fixtureId: null, source: "site" });
  });

  it("the match page's tag: `?f=<fixture>&src=match` — and it parses back to that fixture (round trip)", () => {
    const path = sponsorClickPath(SPONSOR, { source: "match", fixtureId: FIXTURE });
    expect(path).toBe(`/s/${SPONSOR}?f=${FIXTURE}&src=match`);
    const url = new URL(path, "https://seazn.club");
    expect(parseClickTag(url.searchParams)).toEqual({ fixtureId: FIXTURE, source: "match" });
  });

  it("encodes its parts: a stray character cannot add a parameter or a path segment", () => {
    const url = new URL(sponsorClickPath("a/b?src=site", { source: "match", fixtureId: "b&src=site#c" }), "https://seazn.club");
    expect(url.pathname).toBe("/s/a%2Fb%3Fsrc%3Dsite");
    expect(url.searchParams.getAll("src")).toEqual(["match"]);
    expect(url.searchParams.get("f")).toBe("b&src=site#c");
  });
});

// The controller addendum (2026-10-31): ONE route serves both shapes, told apart by SHAPE, never by trying both lookups.
// Expected values come from lib/sponsor-short-code.ts's declarations (alphabet, lengths, uppercase only) and the uuid
// grammar, never from the classifier.
describe("classifySponsorLink — the /s/ key's shape (S10)", () => {
  const UPPER = "6F1C2B9E-1D2A-4C3B-9E8F-7A6B5C4D3E2F";
  /** Codes of every allowed length, cycling through the WHOLE alphabet so every character is used at least once. */
  const codesOfEveryLength = (): string[] => {
    const out: string[] = [];
    let i = 0;
    for (let len = SPONSOR_SHORT_CODE_MIN_LENGTH; len <= SPONSOR_SHORT_CODE_MAX_LENGTH; len++) {
      for (let k = 0; k < Math.ceil(SPONSOR_SHORT_CODE_ALPHABET.length / len); k++) {
        out.push(Array.from({ length: len }, () => SPONSOR_SHORT_CODE_ALPHABET[i++ % SPONSOR_SHORT_CODE_ALPHABET.length]).join(""));
      }
    }
    return out;
  };

  it("a sponsor uuid, either case, is the sponsor-id path", () => {
    expect(classifySponsorLink(SPONSOR)).toEqual({ kind: "sponsor", sponsorId: SPONSOR });
    expect(classifySponsorLink(UPPER)).toEqual({ kind: "sponsor", sponsorId: UPPER });
  });

  it("every allowed length and every alphabet character is the code path (counts reported)", () => {
    const codes = codesOfEveryLength();
    const lengths = new Set<number>();
    const chars = new Set<string>();
    for (const code of codes) {
      expect(classifySponsorLink(code), code).toEqual({ kind: "code", code });
      lengths.add(code.length);
      for (const c of code) chars.add(c);
    }
    expect(codes.length, "codes checked").toBeGreaterThan(0);
    expect(lengths.size, "lengths covered").toBe(SPONSOR_SHORT_CODE_MAX_LENGTH - SPONSOR_SHORT_CODE_MIN_LENGTH + 1);
    expect(chars.size, "alphabet characters covered").toBe(SPONSOR_SHORT_CODE_ALPHABET.length);
  });

  it("one character short or long of the declared lengths is neither shape: no lookup", () => {
    const c = SPONSOR_SHORT_CODE_ALPHABET[SPONSOR_SHORT_CODE_ALPHABET.length - 1]!;
    expect(classifySponsorLink(c.repeat(SPONSOR_SHORT_CODE_MIN_LENGTH - 1))).toBeNull();
    expect(classifySponsorLink(c.repeat(SPONSOR_SHORT_CODE_MAX_LENGTH + 1))).toBeNull();
  });

  it("a character outside the alphabet — the misread ones, in either case — is neither shape (counts reported)", () => {
    const base = SPONSOR_SHORT_CODE_ALPHABET.slice(-SPONSOR_SHORT_CODE_MIN_LENGTH);
    const outside = [..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"].filter((c) => !SPONSOR_SHORT_CODE_ALPHABET.includes(c));
    let checked = 0;
    for (const c of outside) {
      expect(classifySponsorLink(c + base.slice(1)), c).toBeNull();
      // Folding never lets a misread character in: lowercase `o`/`i`/`l` fold to O/I/L, which the alphabet excludes.
      expect(classifySponsorLink(c.toLowerCase() + base.slice(1)), c.toLowerCase()).toBeNull();
      checked++;
    }
    expect(checked, "characters outside the alphabet checked").toBe(outside.length);
    expect(outside.length).toBeGreaterThan(0);
  });

  it("I2: a code typed in lowercase (or mixed case) folds to the code — every length, every letter (counts reported)", () => {
    const codes = codesOfEveryLength();
    let folded = 0;
    for (const code of codes) {
      const lower = code.toLowerCase();
      const mixed = [...code].map((c, i) => (i % 2 ? c.toLowerCase() : c)).join("");
      expect(classifySponsorLink(lower), lower).toEqual({ kind: "code", code });
      expect(classifySponsorLink(mixed), mixed).toEqual({ kind: "code", code });
      if (lower !== code) folded++;
    }
    expect(folded, "codes with a letter to fold").toBeGreaterThan(0);
  });

  it("I2: only ASCII folds — a key that UPPERCASES into a code but is not ASCII is neither shape", () => {
    // Each of these becomes alphabet characters under String.prototype.toUpperCase (or under a /u case fold): the
    // ligature "ﬀ" (U+FB00) → "FF", "ﬆ" (U+FB06) → "ST", the long s "ſ" (U+017F) → "S", the Kelvin sign (U+212A) ~ "K".
    const traps = ["\uFB00\uFB00", "\uFB06\uFB06", "\u017Fabc", "\u212AABC", "ABC\u212A", "\uFB00AB"];
    let checked = 0;
    for (const key of traps) {
      expect(key.toUpperCase() !== key || /\u212A/.test(key), `premise: ${JSON.stringify(key)} is a case trap`).toBe(true);
      expect(classifySponsorLink(key), JSON.stringify(key)).toBeNull();
      checked++;
    }
    expect(checked).toBe(traps.length);
    expect("\uFB00\uFB00".toUpperCase(), "premise: the ligature uppercases into a valid code").toBe("FFFF");
    expect(classifySponsorLink("FFFF"), "positive pair: the ASCII spelling is a code").toEqual({ kind: "code", code: "FFFF" });
  });

  it("anything else is neither shape (the route answers 404 without a query)", () => {
    for (const key of ["", "s", "not-a-uuid", `${SPONSOR}x`, `{${SPONSOR}}`, SPONSOR.replace(/-/g, ""), " ABCD", "AB CD", "../ABCD", "abcd!"]) {
      expect(classifySponsorLink(key), JSON.stringify(key)).toBeNull();
    }
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

// m1 (fix round 1): the one rule for a sponsor url that may be LINKED or REDIRECTED to — the redirect route, the boards'
// blob-shim hrefs and the three write schemas all read it.
describe("redirectTarget — an absolute http(s) url, or null", () => {
  it("http and https pass, normalised by the URL parser", () => {
    expect(redirectTarget("https://halston.example")).toBe("https://halston.example/");
    expect(redirectTarget("http://halston.example/a?b=1")).toBe("http://halston.example/a?b=1");
    expect(redirectTarget("HTTPS://Halston.Example/X")).toBe("https://halston.example/X");
  });

  it("every other scheme, a relative or protocol-relative url, and no url at all are refused (count reported)", () => {
    const refused = [
      "javascript:alert(document.cookie)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "ftp://files.example/x",
      "mailto:a@b.example",
      "file:///etc/passwd",
      "/relative/path",
      "//evil.example/x",
      "halston.example",
      "",
    ];
    for (const url of refused) expect(redirectTarget(url), url).toBeNull();
    expect(redirectTarget(null)).toBeNull();
    expect(redirectTarget(undefined)).toBeNull();
    expect(refused.length).toBe(11);
  });
});
