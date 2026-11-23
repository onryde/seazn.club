// W5 follow-ups fix round 1 (review M3): B5 put the public docs back under Next's 2 MB data-cache item limit by storing them
// gzipped. Past the limit Next refuses the item quietly and the cache is off again, so an entry that grows toward the limit
// logs its size first: a warning at 1.5 MiB, three quarters of the limit (`NEXT_CACHE_ITEM_LIMIT_BYTES`, Next's own figure).
// The entry sizes come from what is stored (the entry's JSON, what Next writes), never from the helper's own arithmetic.
// No database: the subject is the entry, not the loaders.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

const logMock = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("@/server/logger", () => ({ log: logMock }));

import { NEXT_CACHE_ITEM_LIMIT_BYTES, compressEntry, inflateEntry } from "../cache-entry";

const WARN_AT = (NEXT_CACHE_ITEM_LIMIT_BYTES * 3) / 4; // 1.5 MiB

beforeEach(() => logMock.warn.mockClear());

describe("M3 a public cache entry near Next's item limit logs its size", () => {
  it("an entry over 1.5 MiB logs one warning naming the entry and its stored size", () => {
    // Random bytes do not compress: their base64 gzips to about three quarters, then base64 grows it back by a third.
    const doc = { blob: randomBytes(1_300_000).toString("base64") };
    const entry = compressEntry(doc, "pub-hub-v5");
    const bytes = JSON.stringify(entry).length;
    expect(bytes, "premise: the stored entry is over 1.5 MiB").toBeGreaterThan(WARN_AT);
    expect(inflateEntry(entry), "still stored losslessly").toEqual(doc);
    expect(logMock.warn).toHaveBeenCalledTimes(1);
    const [fields] = logMock.warn.mock.calls[0]! as [Record<string, unknown>];
    expect(fields).toMatchObject({ event: "public_cache_entry_large", entry: "pub-hub-v5", bytes, limit: NEXT_CACHE_ITEM_LIMIT_BYTES });
  });

  it("the empty case and an ordinary entry: a small document logs nothing", () => {
    compressEntry({}, "pub-div-v5");
    const ordinary = { fixtures: Array.from({ length: 2_000 }, (_, i) => ({ id: `f${i}`, round_no: 1 + (i % 9) })) };
    const entry = compressEntry(ordinary, "pub-div-v5");
    expect(JSON.stringify(entry).length, "premise: well under 1.5 MiB").toBeLessThan(WARN_AT);
    expect(logMock.warn).not.toHaveBeenCalled();
  });
});
