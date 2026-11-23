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
// The builder's own shape for what matters here: it stamps `generatedAt` AND every card's `header.updatedAt` with the
// build instant (competition-hub.ts `updatedAt: generatedAt`), and a LIVE card reads that as "Updated Ns ago". A second
// card carries an instant of its own, which is content.
const docAt = (generatedAt: string, score: string) =>
  ({
    competitionId: "c1", orgSlug: "riverside", competitionSlug: "autumn-cup", generatedAt,
    matches: [
      { fixtureId: "f1", resultLine: score, header: { status: "in_play", updatedAt: generatedAt } },
      { fixtureId: "f2", resultLine: "", header: { status: "decided", updatedAt: "2026-11-21T08:00:00.000Z" } },
    ],
  }) as unknown as CompetitionHubDocT;

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

    // The document is rebuilt whenever its 15 s cache entry lapses (and the page polls every 15 s), so a rebuild that says
    // the same thing must still be a 304: the ETag names the CONTENT, never the time it was built.
    current.doc = docAt("2026-11-22T10:00:15.000Z", "1-0");
    const rebuilt = await GET(new Request("http://x/hub", { headers: { "If-None-Match": etag! } }), ctx);
    expect(rebuilt.status, "rebuilt, same content: 304").toBe(304);
    expect(rebuilt.headers.get("ETag")).toBe(etag);
    expect(rebuilt.headers.get("X-Hub-Generated-At"), "the 304 names the build it confirms").toBe("2026-11-22T10:00:15.000Z");

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
    expect(b, "a 304 for the same build hands back the very document already held").toBe(a);
    // Rebuilt with the same content: still a 304, and the held document is re-stamped with the new build - the live card's
    // "Updated Ns ago" resets as a full answer would have reset it; everything else is what it was.
    current.doc = docAt("2026-11-22T10:00:15.000Z", "1-0");
    const r = await fetchCompetitionHub("riverside", "autumn-cup");
    expect(r.generatedAt).toBe("2026-11-22T10:00:15.000Z");
    expect((r.matches[0] as { header: { updatedAt: string } }).header.updatedAt, "the build-stamped card moves").toBe("2026-11-22T10:00:15.000Z");
    expect((r.matches[1] as { header: { updatedAt: string } }).header.updatedAt, "a card's own instant stays").toBe("2026-11-21T08:00:00.000Z");
    expect(r, "...and that is exactly the document a full answer would have carried").toEqual(current.doc);
    current.doc = docAt("2026-11-22T10:00:20.000Z", "2-0");
    const c = await fetchCompetitionHub("riverside", "autumn-cup");
    expect(c.generatedAt, "a change arrives").toBe("2026-11-22T10:00:20.000Z");
    expect((c.matches[0] as { resultLine: string }).resultLine).toBe("2-0");
    const d = await fetchCompetitionHub("riverside", "autumn-cup");
    expect(d, "and is then held in its turn").toBe(c);
    expect(sent.length, "anti-vacuity: five polls").toBe(5);
    expect(sent.slice(1).every((e) => e !== null), "every poll after the first sends its tag").toBe(true);
  });

  it("a card's OWN instant is content, not the build stamp: when only it moves, the tag moves (review M5)", async () => {
    const first = await GET(new Request("http://x/hub"), ctx);
    const etag = first.headers.get("ETag");
    const doc = docAt("2026-11-22T10:00:00.000Z", "1-0") as unknown as { matches: { header: { updatedAt: string } }[] };
    expect(doc.matches[1]!.header.updatedAt, "the premise: card f2 carries an instant of its own").not.toBe("2026-11-22T10:00:00.000Z");
    doc.matches[1]!.header.updatedAt = "2026-11-21T09:30:00.000Z";
    current.doc = doc;
    const moved = await GET(new Request("http://x/hub", { headers: { "If-None-Match": etag! } }), ctx);
    expect(moved.status, "a card's own instant moved: the document").toBe(200);
    expect(moved.headers.get("ETag")).not.toBe(etag);
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
