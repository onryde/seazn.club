// Owner decision 2026-09-16, review m3 — both caches of the public fixture
// document retire their pre-change names.
//
// A decided cricket match's `matchCentre.header.statusLine` changed shape (the
// margin is its own key now, not a `{margin}` word), and both caches hold the
// BUILT document: an entry written before the deploy would render "X won" with
// its margin silently dropped for its whole window. So:
//
//   * Redis `pub:v1:fixture:{id}` (usecases/public.ts, 30 s) → `pub:v1:fixture:v2:{id}`
//   * Next `["pub-fixture", id]`  (public-site/data.ts, REVALIDATE_FAST) → `["pub-fixture-v2", id]`
//     → `["pub-fixture-v3", id]`: the privacy hotfix ALSO moved the unversioned
//     key to `-v2`, for its own change (the lineup `masked` flag). Each branch's
//     `-v2` entry holds only its own change, so the merge of the two retires
//     both under `-v3`.
//
// The Redis READER's key is pinned here as a literal — the same literal the
// invalidator suites (`hub-cache-invalidation`, `score-revalidate-in-request`,
// `schedule-*-cache-keys`) expect a write to DEL — so the reader and the
// writers cannot drift apart without one side going red.
import { beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({
  gets: [] as string[],
  keyParts: [] as string[][],
}));

vi.mock("@/lib/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cache")>()),
  cacheGet: vi.fn(async (key: string) => {
    probe.gets.push(key);
    return { cached: true };
  }),
}));

// `unstable_cache` has no incremental cache outside the Next runtime; this stub
// records each entry's key parts and answers from canned values instead.
vi.mock("next/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/cache")>()),
  unstable_cache: (_fn: unknown, keyParts: string[]) => {
    probe.keyParts.push(keyParts);
    return async () => {
      if (keyParts[0] === "pub-comp") {
        return {
          org: { id: "org-1", slug: "org" },
          competition: { id: "comp-1", slug: "comp" },
          divisions: [{ id: "div-1", slug: "div" }],
          liveNow: [],
        };
      }
      return { fixture: { id: keyParts[keyParts.length - 1] } };
    };
  },
}));

import { publicFixture } from "@/server/usecases/public";
import { getPublicFixture } from "../data";

const FIXTURE_ID = "0b6c9a52-7a1d-4a5e-9d7e-2f1c3b4a5d6e";

beforeEach(() => {
  probe.gets.length = 0;
  probe.keyParts.length = 0;
});

describe("the public fixture document's cache names (v2, 2026-09-16)", () => {
  it("publicFixture reads Redis under pub:v1:fixture:v2:{id}, never the pre-change name", async () => {
    await expect(publicFixture(FIXTURE_ID)).resolves.toEqual({ cached: true });
    expect(probe.gets).toEqual([`pub:v1:fixture:v2:${FIXTURE_ID}`]);
    expect(probe.gets).not.toContain(`pub:v1:fixture:${FIXTURE_ID}`);
  });

  it("getPublicFixture caches the page's document under [pub-fixture-v3, id]", async () => {
    const out = await getPublicFixture("org", "comp", "div", FIXTURE_ID);
    expect(out?.fixture).toEqual({ id: FIXTURE_ID });
    const fixtureEntries = probe.keyParts.filter((parts) => parts[0]?.startsWith("pub-fixture"));
    expect(fixtureEntries).toEqual([["pub-fixture-v3", FIXTURE_ID]]);
  });
});
