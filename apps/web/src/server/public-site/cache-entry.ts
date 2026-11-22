import "server-only";
// W5 follow-ups B5 (perf-measure-report P3/P4 "The Next data cache is silently disabled at the cap"): Next's data cache
// refuses an `unstable_cache` value whose JSON is over 2 MB - it logs the refusal and stores NOTHING, so every ISR
// regeneration and every `/present` prefetch rebuilt the document from Postgres (2 s). At the caps the public division doc is
// 2.5-6 MB and the hub doc 5.6-6 MB. Stored gzipped (one base64 string), the same documents are about a tenth of that.
//
// An entry is the document's JSON, compressed; reading it back gives exactly what a cache HIT always gave - the parsed JSON
// of what the loader returned - on a MISS too. A value written before this existed (a raw document, no `gz`) still reads as
// itself, so the key needs no bump.
import { gunzipSync, gzipSync } from "node:zlib";

/** Next's `unstable_cache` item limit (incremental-cache: "items over 2MB can not be cached"). */
export const NEXT_CACHE_ITEM_LIMIT_BYTES = 2 * 1024 * 1024;

/** What is stored: the document's JSON, gzipped, base64. */
export interface CompressedEntry<T> {
  readonly gz: string;
  /** Phantom: never set. */
  readonly __doc?: T;
}

export function compressEntry<T>(doc: T): CompressedEntry<T> {
  return { gz: gzipSync(JSON.stringify(doc)).toString("base64") };
}

function isCompressed(value: unknown): value is CompressedEntry<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { gz?: unknown }).gz === "string" && Object.keys(value).length === 1;
}

/** The document an entry holds. A raw document (an entry stored before B5) is returned as it is. */
export function inflateEntry<T>(entry: CompressedEntry<T> | T): T {
  if (!isCompressed(entry)) return entry as T;
  return JSON.parse(gunzipSync(Buffer.from(entry.gz, "base64")).toString("utf8")) as T;
}
