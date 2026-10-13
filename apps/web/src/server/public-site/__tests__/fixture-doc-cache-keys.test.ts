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
// W2b Task 13 (review M-1): the document gained the forfeit tag and sentence
// (`match_centre.header.forfeit`, the status line's credited result and the set
// sports' credited summary), so an entry built before the deploy would show a
// walkover as "Forfeited" with a played 0 — 0 for its whole window. Both names
// move again: Redis `pub:v1:fixture:v3:{id}`, Next `["pub-fixture-v4", id]`.
//     → `["pub-fixture-v5", id]` (chess T9, 2026-10-09; renumbered over W2b's
//     `-v4` at the 2026-10-13 rebase): `externalPlay` is `{ status }` alone
//     now; a `-v4` entry has no `externalPlay` field at all.
//     → `["pub-fixture-v6", id]` (chess T16, 2026-10-13): `externalPlay` gained
//     `watch` (the view-only board); a `-v5` entry has none, and the page would
//     draw "not started" over a live game for a whole REVALIDATE_FAST window.
//     → `["pub-fixture-v7", id]` (chess T16 fix round 1, 2026-10-13):
//     `externalPlay` gained `decided`, `hold`, `result` and `watch.moves`; a
//     `-v6` entry has none, so a decided fixture's panel would read its hold.
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

describe("the public fixture document's cache names (v3/v4, W2b T13 M-1)", () => {
  it("publicFixture reads Redis under pub:v1:fixture:v3:{id}, never a pre-W2b name", async () => {
    await expect(publicFixture(FIXTURE_ID)).resolves.toEqual({ cached: true });
    expect(probe.gets).toEqual([`pub:v1:fixture:v3:${FIXTURE_ID}`]);
    for (const old of [`pub:v1:fixture:${FIXTURE_ID}`, `pub:v1:fixture:v2:${FIXTURE_ID}`]) expect(probe.gets).not.toContain(old);
  });

  it("getPublicFixture caches the page's document under [pub-fixture-v7, id]", async () => {
    const out = await getPublicFixture("org", "comp", "div", FIXTURE_ID);
    expect(out?.fixture).toEqual({ id: FIXTURE_ID });
    const fixtureEntries = probe.keyParts.filter((parts) => parts[0]?.startsWith("pub-fixture"));
    expect(fixtureEntries).toEqual([["pub-fixture-v7", FIXTURE_ID]]);
  });
});
