// apps/web/src/lib/__tests__/next-cache-tag-state.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import FileSystemCache from "next/dist/server/lib/incremental-cache/file-system-cache";
import { tagsManifest } from "next/dist/server/lib/incremental-cache/tags-manifest.external";
import { defaultConfig } from "next/dist/server/config-shared";
import {
  nextTagEntry, writeState, encodeField, decodeField, newest,
} from "../../../cache-handler/tag-state.mjs";

const MAX = { expire: defaultConfig.cacheLife.max.expire };
const CASES: Array<[string, { expire?: number } | undefined]> = [
  ["max", MAX], ["expire0", { expire: 0 }], ["stats-comp", { expire: 31_536_000 }],
  ["no-durations", undefined], ["durations-without-expire", {}],
];

describe("nextTagEntry mirrors Next's FileSystemCache.revalidateTag", () => {
  beforeEach(() => tagsManifest.clear());
  for (const [name, durations] of CASES) {
    for (const existing of [{}, { stale: 1, expired: 9e15 }]) {
      it(`${name} over ${JSON.stringify(existing)}`, async () => {
        const fs = new FileSystemCache({} as ConstructorParameters<typeof FileSystemCache>[0]);
        tagsManifest.set("t", { ...existing });
        const before = Date.now();
        await fs.revalidateTag("t", durations);
        const fromNext = tagsManifest.get("t")!;
        // Next stamped `now` itself: with durations it lands in `stale`,
        // without them only `expired` is rewritten.
        const now = (durations ? fromNext.stale : fromNext.expired)!;
        expect(now).toBeGreaterThanOrEqual(before);
        expect(nextTagEntry(existing, durations, now)).toEqual(fromNext);
        // writeState is what reaches Redis: minus its `at`, it must be Next's entry too.
        const { at, ...wire } = writeState(existing, durations, now);
        expect(at).toBe(now);
        expect(wire).toEqual(fromNext);
      });
    }
  }
});

describe("newest write wins", () => {
  it("a later {expire:0} beats an earlier 'max' even though its expired is smaller", () => {
    const max = writeState({}, MAX, 1_000);
    const exp = writeState({}, { expire: 0 }, 1_001);
    expect(max.expired!).toBeGreaterThan(exp.expired!); // the per-field-max trap
    expect(newest(max, exp)).toBe(exp);
    expect(newest(exp, max)).toBe(exp);
  });
  it("orders by write time alone, not by stale, and a tie goes to the second argument", () => {
    // A durations-less revalidateTag rewrites only `expired`, so its state
    // carries no fresh `stale`: ordering on `stale` would keep the older write.
    const withDurations = writeState({}, { expire: 0 }, 1_000);
    const bare = writeState({}, undefined, 2_000);
    expect(bare.stale).toBeUndefined();
    expect(newest(withDurations, bare)).toBe(bare);
    expect(newest(bare, withDurations)).toBe(bare);
    const tieA = writeState({}, MAX, 3_000);
    const tieB = writeState({}, { expire: 0 }, 3_000);
    expect(newest(tieA, tieB)).toBe(tieB);
    expect(newest(tieB, tieA)).toBe(tieA);
  });
  it("round-trips through the hash encoding and rejects garbage", () => {
    const s = writeState({}, { expire: 0 }, 42);
    expect(decodeField(encodeField(s))).toEqual(s);
    expect(decodeField("nope")).toBeNull();
    expect(decodeField("12|{bad")).toBeNull();
    expect(decodeField(null)).toBeNull();
  });
  it("accepts only a digits-only `at`, the same fields Lua's ^(%d+)| reads", () => {
    // HSET_IF_NEWER reads `at` with ^(%d+)|, so these never order a write in
    // Redis. The handler must not order by them either.
    for (const at of ["1e3", " 12", "-3", "1.5", "0x10", "12 "]) {
      expect(decodeField(`${at}|{}`), at).toBeNull();
    }
    expect(decodeField("12|{}")).toEqual({ at: 12 });
    expect(decodeField("0|{}")).toEqual({ at: 0 });
  });
});
