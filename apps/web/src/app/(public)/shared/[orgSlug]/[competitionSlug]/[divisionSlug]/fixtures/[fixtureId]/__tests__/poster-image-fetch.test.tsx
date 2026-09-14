import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

// The two PUBLIC match images, driven end to end through their real route
// modules and a real `ImageResponse`. A unit test of the fetcher cannot see
// this seam: satori fetches every `<img src>` it is handed, so the only proof
// that an organiser-typed badge URL is not an outbound request from our server
// is to render the actual route and watch what leaves the process.

const HOSTILE_BADGE = "https://cdn.attacker.example/crest.png";
const INTERNAL_LOGO = "http://169.254.169.254/latest/meta-data/iam/";
const STORAGE_ORIGIN = "https://projectref.supabase.co";
const ALLOWED_BADGE = `${STORAGE_ORIGIN}/storage/v1/object/public/assets/orgs/o1/entrant-badges/a.png`;

vi.mock("@/lib/db", () => ({ sql: vi.fn(async () => []) }));
vi.mock("@/server/public-site/data", () => ({
  getPublicFixture: vi.fn(async () => fixtureData()),
}));

const { getPublicFixture } = await import("@/server/public-site/data");
const OgImage = (await import("../opengraph-image")).default;
const { GET: posterGet } = await import("../poster.png/route");

/** Mutable per test — the badge and logo the loader will be handed. */
let badges: [string | null, string | null] = [HOSTILE_BADGE, null];
let logo: string | null = INTERNAL_LOGO;

function side(name: string, short: string, badgeUrl: string | null) {
  return { entrantId: short, name, short, colour: null, badgeUrl };
}

function fixtureData() {
  return {
    org: {
      id: "o1",
      name: "Southend Cricket Club",
      slug: "scc",
      logo,
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
        sides: [
          side("Southend Blue Blazers", "SBB", badges[0]),
          side("Southend Queens", "SQ", badges[1]),
        ],
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

/** Every URL the process asked for while the image was being produced. */
let requested: string[] = [];

function spyFetch(bytes: Buffer, type = "image/png") {
  const real = globalThis.fetch;
  const spy = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    requested.push(url);
    // satori loads its own default font through fetch; let anything that is
    // not one of the image hosts under test go through to the real one, so a
    // font request cannot be mistaken for a badge request (or break the render).
    if (!/attacker\.example|169\.254|projectref\.supabase\.co/.test(url)) {
      return real(input as RequestInfo, init);
    }
    return new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": type } });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

async function pngBytes(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

beforeEach(() => {
  requested = [];
  badges = [HOSTILE_BADGE, null];
  logo = INTERNAL_LOGO;
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", STORAGE_ORIGIN);
  vi.mocked(getPublicFixture).mockImplementation(async () => fixtureData() as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the fixture share card and the downloadable poster never fetch an organiser's URL", () => {
  it("the OG share image draws the monogram and makes no request to the badge's host", async () => {
    const spy = spyFetch(await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } },
    }).png().toBuffer());

    const res = await OgImage({ params });
    const bytes = await pngBytes(res as Response);

    expect(res.status).toBe(200);
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    expect(requested.filter((u) => u.includes("attacker.example"))).toEqual([]);
    expect(requested.filter((u) => u.includes("169.254"))).toEqual([]);
    expect(spy).toHaveBeenCalled(); // the font — proves the spy was live
  });

  it("the downloadable poster makes no request to the badge's host either", async () => {
    spyFetch(await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } },
    }).png().toBuffer());

    const res = await posterGet(new Request("https://seazn.club/poster.png"), { params });
    const bytes = await pngBytes(res);

    expect(res.status).toBe(200);
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(requested.filter((u) => u.includes("attacker.example"))).toEqual([]);
    expect(requested.filter((u) => u.includes("169.254"))).toEqual([]);
  });

  it("an ALLOW-LISTED badge is still drawn — fetched once, by us, and painted", async () => {
    // The anti-vacuous half: if the guard simply refused everything, the two
    // tests above would pass and the feature would be gone. A badge from the
    // host this app serves its own uploads from must still reach the picture.
    badges = [ALLOWED_BADGE, null];
    logo = null;
    spyFetch(await sharp({
      create: { width: 200, height: 200, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    }).png().toBuffer());
    const withBadge = await pngBytes((await OgImage({ params })) as Response);
    const fetchedBadge = requested.filter((u) => u.startsWith(STORAGE_ORIGIN));

    requested = [];
    badges = [null, null];
    spyFetch(Buffer.alloc(0));
    const withoutBadge = await pngBytes((await OgImage({ params })) as Response);

    expect(fetchedBadge).toEqual([ALLOWED_BADGE]);
    expect(requested.filter((u) => u.startsWith(STORAGE_ORIGIN))).toEqual([]);
    // Same fixture, same layout, one badge: the images must differ, or the
    // badge never landed on the canvas.
    expect(withBadge.equals(withoutBadge)).toBe(false);
  });
});
