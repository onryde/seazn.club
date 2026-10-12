// Capture record upload (spec 2026-10-12 §5, §8): reading the NDJSON body. The limits are measured on the DECOMPRESSED
// body — at most 1,048,576 bytes and 1000 non-empty lines (empty lines, the trailing newline included, are skipped and
// not counted) — the raw read is capped at 1 MB too, and gzip inflates as a stream that stops at the cap (the zip-bomb
// defence). Expected figures are §5's own, typed here, never read from the module.
//
// ONE SPORT, on purpose: not applicable — a byte stream reads no sport.
import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { readRecordBody } from "../record-body";

const SPEC_MAX_BYTES = 1_048_576;   // §5: "at most 1,048,576 bytes"
const SPEC_MAX_LINES = 1000;        // §5: "at most 1000 non-empty lines"
const TOO_LARGE = "the record is over 1000 lines or 1 MB";   // the contract's own `valid-too_large` message

const URL_ = "http://localhost/api/v1/capture/codes/x/records";
const post = (body: BodyInit | null, headers: Record<string, string> = {}) => new Request(URL_, { method: "POST", body, headers });
const lines = (n: number, eol = "\n") => Array.from({ length: n }, (_, i) => `{"at":"2026-10-11T21:19:03.123Z","kind":"k${i}"}`).join(eol);
/** One line of exactly `bytes` bytes (ASCII). */
const oneLineOf = (bytes: number) => "x".repeat(bytes);

describe("readRecordBody (§5)", () => {
  it("the empty case first: no body and an empty body read as zero lines (the validator answers 422 for those)", async () => {
    expect(await readRecordBody(post(null))).toEqual({ ok: true, lines: [], bodyBytes: 0 });
    expect(await readRecordBody(post(""))).toEqual({ ok: true, lines: [], bodyBytes: 0 });
    expect(await readRecordBody(post("\n\n\r\n"))).toEqual({ ok: true, lines: [], bodyBytes: 4 });
  });

  it("splits on LF and CRLF; empty lines, the trailing newline included, are skipped and not counted", async () => {
    const r = await readRecordBody(post("{\"a\":1}\r\n\n{\"b\":2}\n\n{\"c\":3}\n"));
    expect(r).toEqual({ ok: true, lines: ["{\"a\":1}", "{\"b\":2}", "{\"c\":3}"], bodyBytes: 27 });
  });

  it(`${SPEC_MAX_LINES} non-empty lines pass (with blank lines between them uncounted); ${SPEC_MAX_LINES + 1} is too_large`, async () => {
    const at = await readRecordBody(post(lines(SPEC_MAX_LINES, "\n\n") + "\n"));
    expect(at.ok && at.lines.length).toBe(SPEC_MAX_LINES);
    expect(await readRecordBody(post(lines(SPEC_MAX_LINES + 1)))).toMatchObject({ ok: false, code: "too_large", message: TOO_LARGE });
  });

  it("identity: exactly 1,048,576 bytes pass; one byte more is too_large (the raw cap)", async () => {
    const at = await readRecordBody(post(oneLineOf(SPEC_MAX_BYTES)));
    expect(at).toMatchObject({ ok: true, bodyBytes: SPEC_MAX_BYTES });
    expect(await readRecordBody(post(oneLineOf(SPEC_MAX_BYTES + 1)))).toMatchObject({ ok: false, code: "too_large", message: TOO_LARGE });
  });

  it("a Content-Length over the cap is too_large WITHOUT reading the body", async () => {
    let pulled = 0;
    // highWaterMark 0: the stream pulls only when someone reads (the default 1 pulls once on construction).
    const stream = new ReadableStream<Uint8Array>({ pull() { pulled++; throw new Error("read"); } }, { highWaterMark: 0 });
    const req = new Request(URL_, { method: "POST", body: stream, headers: { "content-length": String(SPEC_MAX_BYTES + 1) }, duplex: "half" } as RequestInit);
    expect(await readRecordBody(req)).toMatchObject({ ok: false, code: "too_large" });
    expect(pulled).toBe(0);
  });

  it("gzip: inflated, and the limits are the DECOMPRESSED body's — exactly 1 MB passes, one byte more is too_large", async () => {
    const small = await readRecordBody(post(gzipSync(Buffer.from(lines(3) + "\n")), { "content-encoding": "gzip" }));
    expect(small).toMatchObject({ ok: true, bodyBytes: Buffer.byteLength(lines(3) + "\n") });
    expect(small.ok && small.lines).toHaveLength(3);
    const at = await readRecordBody(post(gzipSync(Buffer.from(oneLineOf(SPEC_MAX_BYTES))), { "content-encoding": "gzip" }));
    expect(at).toMatchObject({ ok: true, bodyBytes: SPEC_MAX_BYTES });
    const over = await readRecordBody(post(gzipSync(Buffer.from(oneLineOf(SPEC_MAX_BYTES + 1))), { "content-encoding": "gzip" }));
    expect(over).toMatchObject({ ok: false, code: "too_large", message: TOO_LARGE });
    // 1001 short lines inflate under the byte cap and still answer too_large: the line cap holds after inflation too.
    expect(await readRecordBody(post(gzipSync(Buffer.from(lines(SPEC_MAX_LINES + 1))), { "content-encoding": "gzip" })))
      .toMatchObject({ ok: false, code: "too_large" });
  });

  it("the zip bomb: 10 MB of zeros (a few KB gzipped) is too_large, and inflation STOPPED near the cap — never inflated whole", async () => {
    const bomb = gzipSync(Buffer.alloc(10 * SPEC_MAX_BYTES));
    expect(bomb.length).toBeLessThan(64 * 1024);   // premise: the raw body is far under the raw cap
    const r = await readRecordBody(post(bomb, { "content-encoding": "gzip" }));
    expect(r).toMatchObject({ ok: false, code: "too_large" });
    if (r.ok) return;
    // The stream stops within one zlib chunk past the cap (16 KiB by default; 64 KiB is the generous bound).
    expect(r.inflatedBytes).toBeGreaterThan(SPEC_MAX_BYTES);
    expect(r.inflatedBytes).toBeLessThanOrEqual(SPEC_MAX_BYTES + 64 * 1024);
  });

  it("a raw gzip body over the raw cap is too_large before anything inflates", async () => {
    const noise = Buffer.alloc(SPEC_MAX_BYTES + 1, 7);
    const r = await readRecordBody(post(noise, { "content-encoding": "gzip" }));
    expect(r).toMatchObject({ ok: false, code: "too_large", inflatedBytes: 0 });
  });

  it("an encoding that is not gzip, a gzip that will not decode, and bytes that are not UTF-8 are invalid — counted", async () => {
    const good = Buffer.from(lines(2));
    const gz = gzipSync(good);
    const cases: [string, Request][] = [
      ["br", post(good, { "content-encoding": "br" })],
      ["deflate", post(good, { "content-encoding": "deflate" })],
      ["identity", post(good, { "content-encoding": "identity" })],
      ["gzip, br", post(good, { "content-encoding": "gzip, br" })],
      ["corrupt gzip", post(Buffer.from("not gzip at all"), { "content-encoding": "gzip" })],
      ["truncated gzip", post(gz.subarray(0, gz.length - 6), { "content-encoding": "gzip" })],
      ["empty gzip body", post("", { "content-encoding": "gzip" })],
      ["not UTF-8", post(Buffer.from([0x7b, 0xff, 0xfe, 0x7d]))],
    ];
    let checked = 0;
    for (const [name, req] of cases) {
      expect(await readRecordBody(req), name).toMatchObject({ ok: false, code: "invalid" });
      checked++;
    }
    expect(checked).toBe(8);
  });

  it("the gzip header is matched as HTTP says (case-insensitive, trimmed); an empty header is no header", async () => {
    const gz = gzipSync(Buffer.from(lines(2)));
    expect(await readRecordBody(post(gz, { "content-encoding": " GZip " }))).toMatchObject({ ok: true });
    expect(await readRecordBody(post(lines(2), { "content-encoding": "" }))).toMatchObject({ ok: true });
  });
});
