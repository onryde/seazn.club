// Owner ruling 2026-11-26: a playback address is never stored. A Cloudflare Stream address holds its credential as the
// first PATH segment (a signed JWT, or an unsigned input's uid), so it can ride under `url` or `overlayUrl`, or inside
// `message` / `problems`, and pass the record line's allow-list. The value rule (record-playback-scrub.ts) is pinned here.
//
// The fixtures are built from the SHAPE the telemetry scrub declares (`STREAM_PLAYBACK_PATH`, scrub-score-url.ts) and the
// two credential kinds cf-playback.ts mints — a three-segment JWT and a hex uid — and every one is first proved to be a
// line the DOMAIN SCREEN keeps as ok (the premise of the finding), then run through the value rule.
// ONE SPORT, on purpose: not applicable — the capture surface reads no sport (spec §13.2 "Another sport").
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ENCODED_STREAM_PLAYBACK_PATH, STREAM_PLAYBACK_PATH } from "@/lib/scrub-score-url";
import { screenRecordLine } from "../domain/capture-record";
import { holdsPlaybackAddress, RECORD_TEXT_FIELDS, RECORD_URL_FIELDS, scrubPlaybackValues } from "../record-playback-scrub";

const AT = "2026-10-11T21:19:03.123Z";
const TOK = "Zq9rT4mW2xK7pL1vN8cB3d";
const HOST = "customer-k7q2.cloudflarestream.com";
/** The two credential kinds: cf-playback.ts's signed token (header.payload.signature, base64url) and the unsigned uid. */
const SIGNED = "eyJhbGciOiJSUzI1NiIsImtpZCI6ImsxIn0.eyJzdWIiOiJ1aWQxMjMiLCJleHAiOjE3OTk5OTk5OTl9.c2lnbmF0dXJlX2J5dGVzX2hlcmU";
const UNSIGNED = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const SEGMENTS = { signed: SIGNED, unsigned: UNSIGNED } as const;
const addressOf = (seg: string) => `https://${HOST}/${seg}/manifest/video.m3u8`;
const shapeSource = (re: RegExp) => new RegExp(re.source);

const lineOf = (extra: Record<string, unknown>): Record<string, unknown> => ({ at: AT, kind: "armed", stalledMs: 12000, ...extra });
/** The line as the use case holds it at the point the rule runs: the domain screen's own stored text, which must be ok. */
const screened = (line: Record<string, unknown>): string => {
  const v = screenRecordLine(JSON.stringify(line), TOK);
  if (!v.ok) throw new Error("premise: the domain screen must KEEP this line (that is the finding)");
  return v.text;
};
const without = (o: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

describe("the fixtures come from the scrub's own path definition", () => {
  it("every address built here matches STREAM_PLAYBACK_PATH, and the negative twins do not — counted", () => {
    let positives = 0, negatives = 0;
    for (const seg of Object.values(SEGMENTS)) {
      expect(shapeSource(STREAM_PLAYBACK_PATH).test(addressOf(seg))).toBe(true);
      positives++;
    }
    for (const miss of [`https://${HOST}`, `https://${HOST}/`, `https://example.test/${UNSIGNED}/manifest/video.m3u8`, `https://${HOST}.other.example/${UNSIGNED}/x`]) {
      expect(shapeSource(STREAM_PLAYBACK_PATH).test(miss), miss).toBe(false);
      negatives++;
    }
    // The encoded form (a playback address carried inside another URL) is the scrub's too.
    expect(shapeSource(ENCODED_STREAM_PLAYBACK_PATH).test(encodeURIComponent(addressOf(UNSIGNED)))).toBe(true);
    expect([positives, negatives]).toEqual([2, 4]);
  });
});

describe("the key lists are the published contract's own classes", () => {
  it("RECORD_URL_FIELDS / RECORD_TEXT_FIELDS equal the properties capture-record.v1.json describes as `publicUrl:` and `text:` — counted", () => {
    const contract = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../../../../docs/contracts/capture-record.v1.json"), "utf8")) as {
      properties: Record<string, { description?: string }>;
    };
    const named = (cls: string) => Object.entries(contract.properties).filter(([, v]) => v.description?.startsWith(`${cls}:`)).map(([k]) => k).sort();
    expect(named("publicUrl").length, "publicUrl properties in the contract").toBeGreaterThan(0);
    expect(named("text").length, "text properties in the contract").toBeGreaterThan(0);
    expect([...RECORD_URL_FIELDS].sort()).toEqual(named("publicUrl"));
    expect([...RECORD_TEXT_FIELDS].sort()).toEqual(named("text"));
  });
});

describe("scrubPlaybackValues: a Cloudflare playback address is never stored (owner ruling 2026-11-26)", () => {
  it("a signed and an unsigned address under `url` and under `overlayUrl`: the line passes the screen, and the field is dropped from the stored text while every other field is unchanged — counted", () => {
    let checked = 0;
    for (const key of ["url", "overlayUrl"] as const) {
      for (const [kind, seg] of Object.entries(SEGMENTS)) {
        const line = lineOf({ [key]: addressOf(seg), ms: 7, sid: null });
        const stored = scrubPlaybackValues(screened(line));
        expect(stored, `${key} ${kind}`).toBe(JSON.stringify(without(line, key)));
        expect(stored.includes(seg), `${key} ${kind}: the credential segment is gone`).toBe(false);
        expect(Object.keys(JSON.parse(stored) as object), `${key} ${kind}`).toEqual(["at", "kind", "stalledMs", "ms", "sid"]);
        checked++;
      }
    }
    expect(checked).toBe(4);
  });

  it("inside `message` and `problems`: the credential segment becomes the mask `***`, the text around it is kept, the other fields are unchanged — signed, unsigned and URL-encoded, counted", () => {
    let checked = 0;
    for (const key of ["message", "problems"] as const) {
      for (const [kind, seg] of Object.entries(SEGMENTS)) {
        const line = lineOf({ [key]: `stalled on ${addressOf(seg)} after 12s`, ms: 7 });
        const stored = scrubPlaybackValues(screened(line));
        expect(stored, `${key} ${kind}`).toBe(JSON.stringify({ ...line, [key]: `stalled on https://${HOST}/***/manifest/video.m3u8 after 12s` }));
        expect(stored.includes(seg)).toBe(false);
        checked++;
      }
      const encoded = lineOf({ [key]: `next=${encodeURIComponent(addressOf(UNSIGNED))}` });
      const stored = scrubPlaybackValues(screened(encoded));
      expect(stored.includes(UNSIGNED), `${key} encoded: the uid is gone`).toBe(false);
      expect(stored.includes("***"), `${key} encoded: masked`).toBe(true);
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("a normal public URL under `url` (and the mask, and a non-Cloudflare host with the same path shape, and the customer host with no path) is stored BYTE FOR BYTE — the rule is the address, not the field", () => {
    let checked = 0;
    for (const value of ["https://example.test/a/b", "***", `https://example.test/${UNSIGNED}/manifest/video.m3u8`, `https://${HOST}`, `https://${HOST}/`]) {
      for (const key of ["url", "overlayUrl"]) {
        const text = screened(lineOf({ [key]: value }));
        expect(scrubPlaybackValues(text), `${key} ${value}`).toBe(text);
        checked++;
      }
    }
    // Free text with no address is untouched too, and a line with no URL fields at all.
    for (const line of [lineOf({ message: "thermal throttling at 41C" }), lineOf({}), lineOf({ message: null })]) {
      const text = screened(line);
      expect(scrubPlaybackValues(text)).toBe(text);
      checked++;
    }
    expect(checked).toBe(13);
  });

  it("a plain word or a scalar field never holds an address (the allow-list's class forbids a `/`), and the sequence is a fixed point: a second pass over a scrubbed line, and a mixed set, change nothing more", () => {
    const lines = [
      lineOf({ url: addressOf(SIGNED), message: `a ${addressOf(UNSIGNED)} b` }),
      lineOf({ overlayUrl: addressOf(UNSIGNED) }),
      lineOf({ url: "https://example.test/x" }),
    ];
    const once = lines.map((l) => scrubPlaybackValues(screened(l)));
    expect(once).toEqual([
      JSON.stringify({ at: AT, kind: "armed", stalledMs: 12000, message: `a https://${HOST}/***/manifest/video.m3u8 b` }),
      JSON.stringify(without(lines[1]!, "overlayUrl")),
      JSON.stringify(lines[2]),
    ]);
    // The scrubbed text is itself a line the screen keeps, and the rule changes nothing on it.
    const again = once.map((t) => scrubPlaybackValues(screened(JSON.parse(t) as Record<string, unknown>)));
    expect(again).toEqual(once);
    expect(once.filter((t) => t.includes(SIGNED) || t.includes(UNSIGNED))).toHaveLength(0);
    expect(holdsPlaybackAddress(once[0]!), "the masked segment still reads as an address shape, and stays a fixed point").toBe(true);
  });

  it("a text that is not an object is a named refusal, never a guess", () => {
    for (const bad of ["[]", "null", "3"]) expect(() => scrubPlaybackValues(bad), bad).toThrow(RangeError);
  });
});
