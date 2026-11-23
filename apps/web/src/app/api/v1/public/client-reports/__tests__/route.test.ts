// Seazn-hosted Task 25b: POST /api/v1/public/client-reports, the thin door in front of the client-report pipeline. What is the route's
// own, pinned here with the pipeline's receive step a spy (its DB suite is server/client-reports/__tests__/receive.test.ts, and the
// browser-to-log seam is route-seam.test.ts):
//   - the body is read whatever its Content-Type (sendBeacon sends a string as text/plain) and handed over parsed, with the client IP;
//   - a body that is not exactly one registered kind, closed, is a 400: an unknown kind, an unknown key, a field of the wrong type, and
//     ANY string shaped like an address, a query, a path or a credential's name. The 400 never echoes what it refused;
//   - a body over the cap is a 413: by its Content-Length before a byte is read, and by its bytes when it declares none;
//   - every outcome of the pipeline answers the same empty 204, so the answer never says which one a report met.
// Sport: not applicable. A client's failure report is sport-agnostic.
import { beforeEach, describe, expect, it, vi } from "vitest";

const receive = vi.hoisted(() => ({ fn: vi.fn<(report: unknown, ip: string) => Promise<string>>(async () => "sent") }));
vi.mock("@/server/client-reports", async (orig) => ({
  ...(await orig<typeof import("@/server/client-reports")>()),
  receiveClientReport: receive.fn,
}));

import { CLIENT_REPORTS_PATH } from "@/lib/client-reports";
import { CLIENT_REPORT_MAX_BYTES } from "@/server/client-reports";
import { POST } from "../route";

const FIXTURE = "8c4f7a52-1f3e-4b9a-9d2c-3e5f6a7b8c9d";
const IP = "203.0.113.77";
const report = (over: Record<string, unknown> = {}) => ({
  kind: "video", fixtureId: FIXTURE, stage: "player", source: "replay", partNo: 2, player: "hls", reason: "hls",
  hlsType: "networkError", hlsDetails: "manifestLoadError", httpStatus: 403, mediaCode: null, ...over,
});
const post = (body: BodyInit | null, headers: Record<string, string> = { "content-type": "text/plain;charset=UTF-8" }) =>
  POST(new Request(`http://app.test${CLIENT_REPORTS_PATH}`, { method: "POST", body, headers: { "x-forwarded-for": IP, ...headers }, duplex: "half" } as RequestInit));
const json = (v: unknown) => JSON.stringify(v);

beforeEach(() => {
  receive.fn.mockReset();
  receive.fn.mockResolvedValue("sent");
});

describe("POST /api/v1/public/client-reports: a valid report", () => {
  it("as sendBeacon sends it (text/plain): 204 with no body, and the pipeline gets the parsed report and the client's IP", async () => {
    const res = await post(json(report()));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(receive.fn).toHaveBeenCalledTimes(1);
    expect(receive.fn.mock.calls[0]).toEqual([report(), IP]);
  });

  it("as the keepalive fetch sends it (application/json), and as a read of the route (its player fields null): the same", async () => {
    const route = report({ stage: "route", source: null, partNo: null, player: null, reason: "http", hlsType: null, hlsDetails: null, httpStatus: 503 });
    expect((await post(json(route), { "content-type": "application/json" })).status).toBe(204);
    expect(receive.fn.mock.calls[0]![0]).toEqual(route);
  });

  it("every outcome the pipeline can meet answers the same empty 204: the answer never says which (nor whether the fixture exists)", async () => {
    const outcomes = ["capped", "unknown", "logged", "sent"] as const;
    let checked = 0;
    for (const outcome of outcomes) {
      receive.fn.mockResolvedValueOnce(outcome);
      const res = await post(json(report()));
      expect([outcome, res.status, await res.text()]).toEqual([outcome, 204, ""]);
      checked++;
    }
    expect(checked).toBe(outcomes.length);
  });
});

describe("POST /api/v1/public/client-reports: a body that is not exactly one closed kind is a 400, and reaches nothing", () => {
  it("EMPTY CASE FIRST: no body, an empty one, and one that is not JSON", async () => {
    for (const body of [null, "", "{not json"]) {
      const res = await post(body);
      expect([body, res.status]).toEqual([body, 400]);
    }
    expect(receive.fn).not.toHaveBeenCalled();
  });

  it("an unknown kind, no kind, an unknown key, a missing field, and a field of the wrong type", async () => {
    const without = (key: string) => Object.fromEntries(Object.entries(report()).filter(([k]) => k !== key));
    const noKind = without("kind");
    const noReason = without("reason");
    const cases: [string, unknown][] = [
      ["unknown kind", report({ kind: "chess" })],
      ["no kind", noKind],
      ["unknown key", report({ note: "x" })],
      ["missing field", noReason],
      ["partNo a string", report({ partNo: "2" })],
      ["httpStatus out of range", report({ httpStatus: 99 })],
      ["mediaCode out of range", report({ mediaCode: 5 })],
      ["reason off the list", report({ reason: "crashed" })],
      ["an array", [report()]],
    ];
    for (const [name, body] of cases) {
      const res = await post(json(body));
      expect([name, res.status]).toEqual([name, 400]);
    }
    expect(receive.fn).not.toHaveBeenCalled();
  });

  it("ANY string shaped like an address, a query, a path or a credential's name, in every string field, is refused, and never echoed", async () => {
    const SIGNED = "https://customer-q7x2k9m4.cloudflarestream.com/eyJhbGciOiJSUzI1NiJ9.c2ln/manifest/video.m3u8";
    const EMBED = "https://iframe.mediadelivery.net/embed/424242/3f1c2a9e?token=abab&expires=1795000000";
    const shapes = [SIGNED, EMBED, "manifestLoadError?x=1", "a/b", "iframe.mediadelivery.net", "token", "accessToken", "linkExpires", "EXPIRES", "a b", "x=1&y=2", "%2F"];
    const fields = ["hlsType", "hlsDetails", "reason", "stage", "source", "player", "fixtureId", "kind"];
    let checked = 0;
    for (const field of fields) {
      for (const shape of shapes) {
        const res = await post(json(report({ [field]: shape })));
        const text = await res.text();
        expect([field, shape, res.status]).toEqual([field, shape, 400]);
        expect(text.includes(shape), `${field}=${shape} echoed in the 400`).toBe(false);
        checked++;
      }
    }
    expect(checked).toBe(fields.length * shapes.length);
    expect(receive.fn).not.toHaveBeenCalled();
  });

  it("the positive pair: a bare hls.js word in the code fields is taken", async () => {
    expect((await post(json(report({ hlsType: "mediaError", hlsDetails: "bufferStalledError" })))).status).toBe(204);
    expect(receive.fn).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/v1/public/client-reports: the size cap", () => {
  /** A body stream that records whether any of it was read. */
  const watched = (bytes: Uint8Array) => {
    const seen = { pulled: false };
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        seen.pulled = true;
        c.enqueue(bytes);
        c.close();
      },
    });
    return { stream, seen };
  };
  const padded = (n: number): string => {
    const base = json(report());
    expect(base.length, "premise: the report fits under the cap").toBeLessThan(n);
    return base + " ".repeat(n - base.length);
  };

  it("exactly the cap is read and taken; one byte over, sent with no Content-Length, is a 413 that reaches nothing", async () => {
    const atCap = new TextEncoder().encode(padded(CLIENT_REPORT_MAX_BYTES));
    expect(atCap.byteLength).toBe(CLIENT_REPORT_MAX_BYTES);
    expect((await post(watched(atCap).stream)).status).toBe(204);
    const over = new TextEncoder().encode(padded(CLIENT_REPORT_MAX_BYTES + 1));
    const res = await post(watched(over).stream);
    expect(res.status).toBe(413);
    expect(receive.fn).toHaveBeenCalledTimes(1);
  });

  it("a Content-Length over the cap is a 413 before a byte of the body is read", async () => {
    // A body that fails if anyone reads it (pulled only on a read: highWaterMark 0): a read would make the answer the unreadable 400.
    const seen = { pulled: false };
    const stream = new ReadableStream<Uint8Array>({ pull(c) { seen.pulled = true; c.error(new Error("the body was read")); } }, { highWaterMark: 0 });
    const res = await post(stream, { "content-type": "text/plain", "content-length": String(CLIENT_REPORT_MAX_BYTES + 1) });
    expect(res.status).toBe(413);
    expect(seen.pulled, "the body was never read").toBe(false);
    // The positive pair: the same body under a Content-Length within the cap IS read, and its failure is the unreadable 400.
    const read = { pulled: false };
    const readable = new ReadableStream<Uint8Array>({ pull(c) { read.pulled = true; c.error(new Error("the body was read")); } }, { highWaterMark: 0 });
    const within = await post(readable, { "content-type": "text/plain", "content-length": String(CLIENT_REPORT_MAX_BYTES) });
    expect([within.status, read.pulled]).toEqual([400, true]);
    expect(receive.fn).not.toHaveBeenCalled();
  });
});
