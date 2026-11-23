// Task 27: the Bunny Stream webhook's pure half (server/video/bunny-webhook.ts): the signature, the body, and the webhook's own
// status list. No network, no database.
//
// Expected values come from Bunny's published webhook contract (B6 in docs/superpowers/specs/2026-11-20-seazn-hosted-probes.md,
// re-read against Bunny's "Stream webhook" docs page on 2026-11-23), never from the code under test:
//   - the signature is the lowercase hex HMAC-SHA256 of the RAW body, keyed with the library's Read-Only API key, under
//     `X-BunnyStream-Signature-Version: v1` and `X-BunnyStream-Signature-Algorithm: hmac-sha256`. The vectors below are literals
//     computed OUTSIDE this repo (`printf '%s' <body> | openssl dgst -sha256 -hmac <key>`, 2026-11-23);
//   - the body is `VideoLibraryId` (number), `VideoGuid`, `Status`, `EventId` (kept on redelivery) and `Timestamp` (ISO, seven
//     fractional digits), plus fields this webhook does not read (`IsLiveStreamWebhook`, `Reason`);
//   - the webhook statuses: 3 Finished, 4 Resolution finished (the first one means playable), 5 Failed; 0-2, 6-13, 32 and 33 are
//     other events. NOT the video API's list (Task 21), where 3 is still transcoding.
import { describe, expect, it, vi } from "vitest";

// Every comparison must be the constant-time one: the real `timingSafeEqual`, counted.
const compared = vi.hoisted(() => ({ calls: 0 }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      compared.calls++;
      return actual.timingSafeEqual(a, b);
    },
  };
});

import { parseBunnyEvent, verifyBunnySignature, webhookOutcome } from "../bunny-webhook";

const KEY = "ZZ-read-only-webhook-test";
const BODY_3 = '{"VideoLibraryId":133,"VideoGuid":"657bb740-a71b-4529-a012-528021c31a92","Status":3,"EventId":"0f8e2c52-6a3e-4c1f-9d55-2b8c4f6c2a10","Timestamp":"2026-10-01T12:30:15.1234567Z"}';
/** openssl, above: HMAC-SHA256(KEY, BODY_3), lowercase hex. */
const SIG_3 = "9f4ae2968561d162ef7f70284efa6108d29130513d59e423f6b4ffadfa895d39";
/** BODY_3 with ONE byte changed (Status 3 -> 4), and its own openssl vector: the two signatures differ. */
const BODY_4 = BODY_3.replace('"Status":3', '"Status":4');
const SIG_4 = "4e603773aee60d60e66b667f6cb0ef45a093646de259ef97b4d18ef367601ae3";
/** The same event pretty-printed (two-space indent, \n): the bytes Bunny signed are these, not a re-serialisation. */
const PRETTY = '{\n  "VideoLibraryId": 133,\n  "VideoGuid": "657bb740-a71b-4529-a012-528021c31a92",\n  "Status": 3,\n  "EventId": "0f8e2c52-6a3e-4c1f-9d55-2b8c4f6c2a10",\n  "Timestamp": "2026-10-01T12:30:15.1234567Z"\n}';
const SIG_PRETTY = "c1b958892dba69cfbc595c27d75992d6b8e122a2f65f740350cf99a42e7eeb01";
const V1 = { version: "v1", algorithm: "hmac-sha256" } as const;

describe("verifyBunnySignature — the lowercase hex HMAC-SHA256 of the raw body, keyed with the Read-Only key (B6)", () => {
  it("EMPTY CASE FIRST: no signature, no version, no algorithm, or no key is never a pass", () => {
    expect(verifyBunnySignature(BODY_3, { signature: null, ...V1 }, KEY)).toBe(false);
    expect(verifyBunnySignature(BODY_3, { signature: SIG_3, version: null, algorithm: "hmac-sha256" }, KEY)).toBe(false);
    expect(verifyBunnySignature(BODY_3, { signature: SIG_3, version: "v1", algorithm: null }, KEY)).toBe(false);
    expect(verifyBunnySignature(BODY_3, { signature: "", ...V1 }, KEY)).toBe(false);
    // An empty key would make every body forgeable by anyone: refused, even with the very signature an empty key gives (openssl,
    // `-hmac ''`, 2026-11-23).
    expect(verifyBunnySignature(BODY_3, { signature: "bb274d7b21ac156f6594ced77b28c6c068bd0c38f2c6c73936472e93bad5a260", ...V1 }, "")).toBe(false);
  });

  it("the hand-computed vectors pass, each only for its own body; ONE changed byte of the body fails", () => {
    expect(verifyBunnySignature(BODY_3, { signature: SIG_3, ...V1 }, KEY)).toBe(true);
    expect(verifyBunnySignature(BODY_4, { signature: SIG_4, ...V1 }, KEY)).toBe(true);
    expect(SIG_3, "PREMISE: the one-byte change moves the signature").not.toBe(SIG_4);
    expect(verifyBunnySignature(BODY_4, { signature: SIG_3, ...V1 }, KEY), "one byte of the body changed").toBe(false);
    expect(verifyBunnySignature(BODY_3, { signature: SIG_3, ...V1 }, `${KEY}x`), "another key").toBe(false);
  });

  it("it runs on the RAW body: the pretty-printed bytes pass with their own vector, and their signature does not cover the compact re-serialisation", () => {
    expect(verifyBunnySignature(PRETTY, { signature: SIG_PRETTY, ...V1 }, KEY)).toBe(true);
    const reserialised = JSON.stringify(JSON.parse(PRETTY));
    expect(reserialised, "PREMISE: re-serialising changes the bytes").not.toBe(PRETTY);
    expect(verifyBunnySignature(reserialised, { signature: SIG_PRETTY, ...V1 }, KEY)).toBe(false);
  });

  it("only version v1 and algorithm hmac-sha256: v2, another algorithm, or another spelling fails with the right signature", () => {
    const wrong: [string, string][] = [["v2", "hmac-sha256"], ["V1", "hmac-sha256"], ["v1", "hmac-sha512"], ["v1", "HMAC-SHA256"], ["v1", "sha256"], ["", "hmac-sha256"]];
    let checked = 0;
    for (const [version, algorithm] of wrong) {
      expect(verifyBunnySignature(BODY_3, { signature: SIG_3, version, algorithm }, KEY), `${version} / ${algorithm}`).toBe(false);
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("a signature of another length, or not lowercase hex, answers false and never throws", () => {
    const shapes = [SIG_3.slice(0, 63), `${SIG_3}0`, SIG_3.slice(0, 32), `${SIG_3}${SIG_3}`, SIG_3.toUpperCase(), `${SIG_3.slice(0, 63)}é`, " ".repeat(64)];
    let checked = 0;
    for (const signature of shapes) {
      expect(() => verifyBunnySignature(BODY_3, { signature, ...V1 }, KEY), JSON.stringify(signature)).not.toThrow();
      expect(verifyBunnySignature(BODY_3, { signature, ...V1 }, KEY), JSON.stringify(signature)).toBe(false);
      checked++;
    }
    expect(checked).toBe(7);
  });

  it("an equal-length signature is compared with crypto.timingSafeEqual, never with ===", () => {
    compared.calls = 0;
    expect(verifyBunnySignature(BODY_3, { signature: SIG_3, ...V1 }, KEY)).toBe(true);
    expect(verifyBunnySignature(BODY_3, { signature: SIG_4, ...V1 }, KEY)).toBe(false);
    expect(compared.calls, "both equal-length comparisons went through timingSafeEqual").toBe(2);
  });
});

describe("parseBunnyEvent — the five fields the webhook reads (B6)", () => {
  const docs = () => ({
    IsLiveStreamWebhook: false, VideoLibraryId: 133, VideoGuid: "657bb740-a71b-4529-a012-528021c31a92", Status: 3,
    EventId: "0f8e2c52-6a3e-4c1f-9d55-2b8c4f6c2a10", Timestamp: "2026-10-01T12:30:15.1234567Z",
  });

  it("EMPTY CASE FIRST: nothing, a non-object, an array, an empty object are null", () => {
    let checked = 0;
    for (const v of [null, undefined, "x", 3, true, [], [docs()], {}]) {
      expect(parseBunnyEvent(v), JSON.stringify(v)).toBeNull();
      checked++;
    }
    expect(checked).toBe(8);
  });

  it("Bunny's own example body: the library as text, the guid, the status, the event id and the event's time (fields it does not read are ignored)", () => {
    expect(parseBunnyEvent(docs())).toEqual({
      libraryId: "133", videoId: "657bb740-a71b-4529-a012-528021c31a92", status: 3, eventId: "0f8e2c52-6a3e-4c1f-9d55-2b8c4f6c2a10",
      at: new Date("2026-10-01T12:30:15.123Z"),
    });
    expect(parseBunnyEvent({ ...docs(), Status: 33, Reason: "Title" })?.status).toBe(33);
  });

  it("any of the five missing, or the wrong shape, is null — never a guess", () => {
    const broken: [string, Record<string, unknown>][] = [
      ["no library", { VideoLibraryId: undefined }], ["library a float", { VideoLibraryId: 1.5 }], ["library negative", { VideoLibraryId: -1 }],
      ["library an object", { VideoLibraryId: {} }], ["library blank text", { VideoLibraryId: " " }],
      ["no guid", { VideoGuid: undefined }], ["blank guid", { VideoGuid: "" }], ["guid a number", { VideoGuid: 7 }], ["guid too long", { VideoGuid: "g".repeat(201) }],
      ["no status", { Status: undefined }], ["status as text", { Status: "3" }], ["status a float", { Status: 3.5 }], ["status negative", { Status: -1 }],
      ["no event id", { EventId: undefined }], ["blank event id", { EventId: "" }], ["event id a number", { EventId: 9 }], ["event id too long", { EventId: "e".repeat(201) }],
      ["no time", { Timestamp: undefined }], ["time not a date", { Timestamp: "yesterday" }], ["time a number", { Timestamp: 1_700_000_000 }],
    ];
    let checked = 0;
    for (const [label, patch] of broken) {
      const body: Record<string, unknown> = { ...docs(), ...patch };
      for (const [k, v] of Object.entries(patch)) if (v === undefined) delete body[k];
      expect(parseBunnyEvent(body), label).toBeNull();
      checked++;
    }
    expect(checked).toBe(20);
    expect(parseBunnyEvent({ ...docs(), VideoLibraryId: "133" })?.libraryId, "a library id sent as digits reads the same").toBe("133");
  });
});

describe("webhookOutcome — the WEBHOOK's statuses (B6), never the video API's (Task 21)", () => {
  /** Bunny's webhook status list, typed from its docs: 3 and 4 mean playable, 5 failed, every other one is not ours to act on. */
  const B6: [number, "playable" | "failed" | "ignore"][] = [
    [0, "ignore"], [1, "ignore"], [2, "ignore"], [3, "playable"], [4, "playable"], [5, "failed"], [6, "ignore"], [7, "ignore"], [8, "ignore"],
    [9, "ignore"], [10, "ignore"], [11, "ignore"], [12, "ignore"], [13, "ignore"], [32, "ignore"], [33, "ignore"], [99, "ignore"],
  ];
  it("every listed status, and one Bunny has not listed: 3 and 4 playable, 5 failed, the rest ignored", () => {
    let checked = 0;
    for (const [status, outcome] of B6) {
      expect([status, webhookOutcome(status)]).toEqual([status, outcome]);
      checked++;
    }
    expect(checked).toBe(17);
  });
  it("3 is Finished here (playable), where the video API's 3 is still transcoding; 6 is a pre-signed upload here, where the API's 6 is a failure", () => {
    expect(webhookOutcome(3)).toBe("playable");
    expect(webhookOutcome(6)).toBe("ignore");
  });
});
