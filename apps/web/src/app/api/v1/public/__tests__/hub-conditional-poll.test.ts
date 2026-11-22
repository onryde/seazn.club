// W5 follow-ups B4 (perf-measure-report P4 fix B: "poll a small delta or version endpoint and refetch the doc only when its
// version moves"): the hub page re-fetched the WHOLE hub document every 15 s - about 5 MB raw at a cap-sized competition -
// whether or not anything had changed. The route now names each document build with an ETag and answers a poll that already
// holds it with 304 and no body; the page's fetch layer sends the ETag it holds and, on a 304, keeps the very document it has.
//
// The route is driven for real (`GET`, through `v1`); the document comes from `publicCompetitionHub`, replaced at its usecase
// seam by a store the test moves, and the poll rate limit is a no-op (it is not what is under test). The fetch layer is the
// real `fetchCompetitionHub` over a `fetch` that answers from that same route, so the two halves meet on the real headers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompetitionHubDocT } from "@/server/public-site/competition-hub-schema";

const current = vi.hoisted(() => ({ doc: null as unknown, builds: 0 }));
vi.mock("@/server/usecases/public", async (orig) => ({
  ...(await orig<typeof import("@/server/usecases/public")>()),
  publicPollRateLimit: async () => {},
  publicCompetitionHub: async () => {
    current.builds += 1;
    return current.doc;
  },
}));

import { GET } from "../orgs/[orgSlug]/competitions/[slug]/hub/route";
import { fetchCompetitionHub } from "@/components/public-site/competition-hub-data";

const ctx = { params: Promise.resolve({ orgSlug: "riverside", slug: "autumn-cup" }) };
const docAt = (generatedAt: string, score: string) =>
  ({ competitionId: "c1", orgSlug: "riverside", competitionSlug: "autumn-cup", generatedAt, matches: [{ fixtureId: "f1", resultLine: score }] }) as unknown as CompetitionHubDocT;

beforeEach(() => {
  current.doc = docAt("2026-11-22T10:00:00.000Z", "1-0");
  current.builds = 0;
});
afterEach(() => vi.unstubAllGlobals());

describe("B4 the hub poll costs a document only when the document changed", () => {
  it("the route: an ETag on every answer; the same ETag back is a 304 with no body; a new build is a 200 with a new ETag", async () => {
    const first = await GET(new Request("http://x/hub"), ctx);
    expect(first.status).toBe(200);
    const etag = first.headers.get("ETag");
    expect(etag, "the answer names its build").toMatch(/^W\/".+"$/);
    expect(first.headers.get("Cache-Control"), "the CDN header is unchanged").toBeTruthy();

    const again = await GET(new Request("http://x/hub", { headers: { "If-None-Match": etag! } }), ctx);
    expect(again.status, "unchanged: 304").toBe(304);
    expect(await again.text(), "no body").toBe("");
    expect(again.headers.get("ETag")).toBe(etag);

    current.doc = docAt("2026-11-22T10:00:20.000Z", "2-0");
    const moved = await GET(new Request("http://x/hub", { headers: { "If-None-Match": etag! } }), ctx);
    expect(moved.status, "a new build: the document").toBe(200);
    expect(moved.headers.get("ETag")).not.toBe(etag);
    expect(((await moved.json()) as { data: CompetitionHubDocT }).data.generatedAt).toBe("2026-11-22T10:00:20.000Z");
  });

  it("the page's fetch layer: sends the ETag it holds, keeps the SAME document on a 304, and takes the new one on a 200", async () => {
    const sent: (string | null)[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const ifNoneMatch = new Headers(init.headers).get("If-None-Match");
      sent.push(ifNoneMatch);
      return GET(new Request("http://x/hub", { headers: ifNoneMatch ? { "If-None-Match": ifNoneMatch } : {} }), ctx);
    });
    const a = await fetchCompetitionHub("riverside", "autumn-cup");
    const b = await fetchCompetitionHub("riverside", "autumn-cup");
    expect(sent[0], "the first poll holds nothing").toBeNull();
    expect(sent[1], "the second sends the ETag of the first").toMatch(/^W\/".+"$/);
    expect(b, "a 304 hands back the very document already held").toBe(a);
    current.doc = docAt("2026-11-22T10:00:20.000Z", "2-0");
    const c = await fetchCompetitionHub("riverside", "autumn-cup");
    expect(c.generatedAt, "a change arrives").toBe("2026-11-22T10:00:20.000Z");
    expect((c.matches[0] as { resultLine: string }).resultLine).toBe("2-0");
    const d = await fetchCompetitionHub("riverside", "autumn-cup");
    expect(d, "and is then held in its turn").toBe(c);
    expect(sent.length, "anti-vacuity: four polls").toBe(4);
  });

  it("the empty case: a fetch layer that has never seen this competition sends no ETag, even after another competition's", async () => {
    const sent: (string | null)[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sent.push(new Headers(init.headers).get("If-None-Match"));
      return GET(new Request("http://x/hub"), ctx);
    });
    await fetchCompetitionHub("riverside", "spring-cup-never-polled");
    expect(sent).toEqual([null]);
  });
});
