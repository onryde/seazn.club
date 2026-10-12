// Capture record upload (spec 2026-10-12 §5): the NDJSON body, read under its limits. Only bytes and line breaks are
// judged here; the lines' JSON is the domain's (`domain/capture-record.ts`). Nothing read here is ever logged.
//
//  - the raw read is capped at 1 MB (a Content-Length over it is refused before a byte is read);
//  - `Content-Encoding: gzip` inflates as a STREAM whose output is counted and stopped one chunk past 1 MB — a zip bomb
//    never inflates whole (§5, the zip-bomb defence); no header (or an empty one) is the identity; anything else is 422;
//  - the limits are the DECOMPRESSED body's: at most 1,048,576 bytes and 1000 non-empty lines.
import { createGunzip } from "node:zlib";
import { CAPTURE_RECORD_MAX_BYTES, CAPTURE_RECORD_MAX_LINES } from "@/server/api-v1/capture-schemas";

export type RecordBody =
  | { ok: true; lines: string[]; bodyBytes: number }
  /** `too_large` is 413, `invalid` is 422. `inflatedBytes` is how far a gzip inflated before it stopped (0 for none). */
  | { ok: false; code: "too_large" | "invalid"; message: string; inflatedBytes: number };

const TOO_LARGE = "the record is over 1000 lines or 1 MB";
const tooLarge = (inflatedBytes = 0): RecordBody => ({ ok: false, code: "too_large", message: TOO_LARGE, inflatedBytes });
const invalid = (message: string, inflatedBytes = 0): RecordBody => ({ ok: false, code: "invalid", message, inflatedBytes });

/** The raw body, or null once it passes `cap` bytes (the rest is never read). */
async function readCapped(body: ReadableStream<Uint8Array> | null, cap: number): Promise<Buffer | null> {
  if (body === null) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Streams `raw` through gunzip, counting the output; past `cap` it destroys the stream (inflation stops there). */
function inflateCapped(raw: Buffer, cap: number): Promise<{ ok: true; body: Buffer } | { ok: false; why: "too_large" | "corrupt"; inflated: number }> {
  return new Promise((resolve) => {
    const gunzip = createGunzip();
    const chunks: Buffer[] = [];
    let inflated = 0;
    let settled = false;
    const settle = (v: Parameters<typeof resolve>[0]) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    gunzip.on("data", (chunk: Buffer) => {
      if (settled) return;
      inflated += chunk.length;
      if (inflated > cap) {
        settle({ ok: false, why: "too_large", inflated });
        gunzip.destroy();
        return;
      }
      chunks.push(chunk);
    });
    gunzip.on("error", () => settle({ ok: false, why: "corrupt", inflated }));
    gunzip.on("end", () => settle({ ok: true, body: Buffer.concat(chunks) }));
    gunzip.end(raw);
  });
}

/** §5's encodings: none (no header, or an empty one) or gzip, matched case-insensitively as HTTP's content codings are. */
function encodingOf(req: Request): "identity" | "gzip" | null {
  const header = req.headers.get("content-encoding");
  const coding = (header ?? "").trim().toLowerCase();
  if (coding === "") return "identity";
  return coding === "gzip" ? "gzip" : null;
}

export async function readRecordBody(req: Request): Promise<RecordBody> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > CAPTURE_RECORD_MAX_BYTES) return tooLarge();
  const encoding = encodingOf(req);
  if (encoding === null) return invalid("the record's Content-Encoding is not supported (gzip or none)");
  const raw = await readCapped(req.body, CAPTURE_RECORD_MAX_BYTES);
  if (raw === null) return tooLarge();
  let body = raw;
  if (encoding === "gzip") {
    const inflated = await inflateCapped(raw, CAPTURE_RECORD_MAX_BYTES);
    if (!inflated.ok) return inflated.why === "too_large" ? tooLarge(inflated.inflated) : invalid("the record's gzip does not decode", inflated.inflated);
    body = inflated.body;
  }
  // The identity body is under the raw cap and the inflated one under the inflate cap: both are within the byte limit.
  if (body.length > CAPTURE_RECORD_MAX_BYTES) throw new RangeError("readRecordBody: a body past both caps");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return invalid("the record is not UTF-8");
  }
  const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l)).filter((l) => l !== "");
  if (lines.length > CAPTURE_RECORD_MAX_LINES) return tooLarge();
  return { ok: true, lines, bodyBytes: body.length };
}
