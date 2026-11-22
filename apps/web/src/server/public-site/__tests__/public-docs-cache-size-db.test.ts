// W5 follow-ups B5 (perf-measure-report P3/P4, "Cross-cutting: the Next data cache is silently disabled at the cap"): the
// public division doc (`pub-div-v5`) and the hub doc (`pub-hub-v5`) went to `unstable_cache` as raw objects. At the caps
// their JSON is 2.5-6 MB, over Next's 2 MB item limit, so Next logged a refusal and stored nothing: every ISR regeneration
// rebuilt both from Postgres. Both are now stored compressed (`cache-entry.ts`).
//
// The cache is Next's own seam (`next/cache`), replaced here by a store that keeps what it is handed AS JSON - what Next writes
// - so the test reads the stored value's real size, and serves it back on the second read (a HIT), as Next does. The scene is
// real Postgres (`seedLoadersScene`: a public competition with a played league, a bracket, a draft and an empty division).
// The cap-sized case replicates the scene's own fixtures to a double league 71's 4,970 lines: its raw JSON is over the limit
// (premise), and the stored entry must be under it.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, string>());
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => Promise<unknown>, keyParts: string[]) => async () => {
    const key = JSON.stringify(keyParts);
    const hit = store.get(key);
    if (hit !== undefined) return JSON.parse(hit);
    const value = await fn();
    store.set(key, JSON.stringify(value));
    return value;
  },
  revalidateTag: vi.fn(),
}));

import { sql } from "@/lib/db";
import { getPublicCompetitionHub } from "../competition-hub";
import { getPublicDivision } from "../data";
import { NEXT_CACHE_ITEM_LIMIT_BYTES, compressEntry, inflateEntry } from "../cache-entry";
import { seedLoadersScene } from "./_public-loaders-scene";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

beforeEach(() => store.clear());

/** The stored entry under a key that starts with `prefix`. */
function stored(prefix: string): { key: string; json: string } {
  const hits = [...store.entries()].filter(([k]) => JSON.parse(k)[0] === prefix);
  expect(hits.length, `premise: one ${prefix} entry stored`).toBe(1);
  return { key: hits[0]![0], json: hits[0]![1] };
}

describe.skipIf(!HAS_DB)("B5 both public docs go to the data cache compressed, under Next's 2 MB item limit", () => {
  it("the division doc: stored compressed, and a MISS and a HIT hand back the same document", async () => {
    const s = await seedLoadersScene();
    const miss = await getPublicDivision(s.orgSlug, s.compSlug, s.cup.slug);
    expect(miss?.fixtures.length, "premise: the cup division has fixtures").toBeGreaterThan(0);
    const entry = stored("pub-div-v5");
    expect(Object.keys(JSON.parse(entry.json)), "the stored value is the compressed entry, not the raw document").toEqual(["gz"]);
    const hit = await getPublicDivision(s.orgSlug, s.compSlug, s.cup.slug);
    expect(JSON.parse(JSON.stringify(hit)), "a HIT reads the same document as the MISS").toEqual(JSON.parse(JSON.stringify(miss)));
  }, 240_000);

  it("the hub doc: stored compressed, and a MISS and a HIT hand back the same document", async () => {
    const s = await seedLoadersScene();
    const miss = await getPublicCompetitionHub(s.orgSlug, s.compSlug);
    expect(miss?.matches.length, "premise: the hub carries matches").toBeGreaterThan(0);
    const entry = stored("pub-hub-v5");
    expect(Object.keys(JSON.parse(entry.json))).toEqual(["gz"]);
    const hit = await getPublicCompetitionHub(s.orgSlug, s.compSlug);
    expect(JSON.parse(JSON.stringify(hit))).toEqual(JSON.parse(JSON.stringify(miss)));
  }, 240_000);

  it("at a cap's size (4,970 lines): the raw division doc is over the limit and its stored entry is under it", async () => {
    const s = await seedLoadersScene();
    const doc = (await getPublicDivision(s.orgSlug, s.compSlug, s.cup.slug))!;
    const template = doc.fixtures;
    expect(template.length, "premise: real fixtures to replicate").toBeGreaterThan(0);
    const fixtures = Array.from({ length: 4_970 }, (_, i) => ({
      ...template[i % template.length]!,
      id: crypto.randomUUID(),
      round_no: 1 + Math.floor(i / 35),
      seq_in_round: i % 35,
    }));
    const capped = { ...doc, fixtures };
    const raw = JSON.stringify(capped).length;
    expect(raw, "premise: the raw document is over Next's limit").toBeGreaterThan(NEXT_CACHE_ITEM_LIMIT_BYTES);
    const entry = JSON.stringify(compressEntry(capped)).length;
    expect(entry, `stored entry ${entry} B of a ${raw} B document`).toBeLessThan(NEXT_CACHE_ITEM_LIMIT_BYTES);
    expect(inflateEntry(compressEntry(capped)), "lossless").toEqual(JSON.parse(JSON.stringify(capped)));
  }, 240_000);

  it("an entry stored before B5 (the raw document) still reads as itself", () => {
    const raw = { fixtures: [{ id: "f1" }], standings: [] };
    expect(inflateEntry(raw)).toBe(raw);
    expect(inflateEntry({ gz: "not-a-doc", other: 1 }), "only a one-key { gz } is read as compressed").toEqual({ gz: "not-a-doc", other: 1 });
  });
});
