import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

// W3-poster spec §Acceptance (docs/superpowers/specs/2026-09-04-spectator-prompts/W3-poster.md):
//
//   - Unit: "... `describeFormat` per sport." — this file covers the sibling
//     item the spec's own false-premises table flagged as untested: "no unit
//     test decodes an `ImageResponse` PNG."
//   - Regression: "the route still answers 200 image/png at exactly 1200×630
//     with `revalidate = 60`; a private competition's card still 404s".
//
// Driven through the REAL route modules and a REAL `ImageResponse` — same
// rail as `poster-image-fetch.test.tsx` beside this file — because a pure
// model test cannot see satori's own output shape (rule 1, "the inert seam":
// a model can be perfectly correct and the picture it produces can still be
// the wrong size).

vi.mock("@/lib/db", () => ({ sql: vi.fn(async () => []) }));
vi.mock("@/server/public-site/data", () => ({
  getPublicFixture: vi.fn(async () => fixtureData()),
}));

const { getPublicFixture } = await import("@/server/public-site/data");
const OgImageModule = await import("../opengraph-image");
const PosterRouteModule = await import("../poster.png/route");
const OgImage = OgImageModule.default;
const { GET: posterGet } = PosterRouteModule;

function side(name: string, short: string) {
  return { entrantId: short, name, short, colour: null, badgeUrl: null };
}

function fixtureData() {
  return {
    org: {
      id: "o1",
      name: "Southend Cricket Club",
      slug: "scc",
      logo: null,
      branding: null,
      default_locale: "en",
    },
    competition: { id: "c1", name: "Southend Premier League", slug: "spl", branding: null },
    division: { id: "d1", name: "Men's T8", slug: "mens-t8" },
    fixture: { id: "f1", stage_id: null, summary: null },
    matchCentre: {
      header: {
        live: false,
        status: "decided",
        sides: [side("Southend Blue Blazers", "SBB"), side("Southend Queens", "SQ")],
        scoreLines: ["83/6", "71/7"],
        subLines: ["8.0 ov", "8.0 ov"],
        battingIndex: null,
        statusLine: null,
        rateLine: null,
        phase: null,
        strength: null,
        pillNote: null,
        metaLine: "8-over match · Round 1",
        updatedAt: "2026-09-05T13:00:00.000Z",
      },
      sets: null,
      cricket: null,
    },
  };
}

const params = Promise.resolve({
  orgSlug: "scc",
  competitionSlug: "spl",
  divisionSlug: "mens-t8",
  fixtureId: "f1",
});

async function pngBytes(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

beforeAll(() => {
  // Same knob `doc-theme.ts` reads; the real fonts must load for this to be
  // a real proof rather than a render against satori's fallback face.
  process.env.DOC_FONT_DIR = path.join(process.cwd(), "assets/fonts");
});

beforeEach(() => {
  vi.mocked(getPublicFixture).mockImplementation(async () => fixtureData() as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the poster and the OG card decode to the sizes the route contracts promise", () => {
  it("poster.png decodes to exactly 1080×1350 (POSTER_SIZE) and is a real, non-trivial PNG", async () => {
    const res = await posterGet(new Request("https://seazn.club/poster.png"), { params });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
    const bytes = await pngBytes(res);
    expect(bytes.byteLength).toBeGreaterThan(5_000);
    const meta = await sharp(bytes).metadata();
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1350);
  });

  it("the fixture OG card decodes to exactly 1200×630 (OG_SIZE)", async () => {
    const res = (await OgImage({ params })) as Response;
    const bytes = await pngBytes(res);
    const meta = await sharp(bytes).metadata();
    expect(meta.width).toBe(1200);
    expect(meta.height).toBe(630);
  });

  it("the OG route contract is pinned: revalidate = 60 (ruling 16 supersedes byte-identity, not this)", () => {
    expect(OgImageModule.revalidate).toBe(60);
    expect(OgImageModule.contentType).toBe("image/png");
    expect(OgImageModule.size).toEqual({ width: 1200, height: 630 });
  });

  it("the poster route also revalidates at 60", () => {
    expect(PosterRouteModule.revalidate).toBe(60);
  });
});

describe("a private competition's poster 404s like its page — the OG card degrades instead", () => {
  it("poster.png: an unresolvable fixture is a 404, not a picture of nothing", async () => {
    vi.mocked(getPublicFixture).mockImplementation(async () => null as never);
    const res = await posterGet(new Request("https://seazn.club/poster.png"), { params });
    expect(res.status).toBe(404);
  });

  it("the metadata OG image route has no 404 to give — it falls back to the plain wordmark slab, still a real PNG", async () => {
    // A `next/og` metadata image is referenced from a page's own <meta>
    // before the request that would 404 is even made, so this route cannot
    // 404 without breaking the tag that points at it — the fallback picture
    // is the deliberate, spec-named alternative ("A metadata image route has
    // no 404" — see this route's own comment).
    vi.mocked(getPublicFixture).mockImplementation(async () => null as never);
    const res = (await OgImage({ params })) as Response;
    expect(res.status).toBe(200);
    const bytes = await pngBytes(res);
    const meta = await sharp(bytes).metadata();
    expect(meta.width).toBe(1200);
    expect(meta.height).toBe(630);
  });
});
