import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

/**
 * EVERY public share image, driven through its real route module and a real
 * `ImageResponse`, watching what leaves the process.
 *
 * satori does not merely read an `<img src>` — it FETCHES it, server-side, on
 * a route any anonymous visitor can hit by URL. So the only proof that an
 * organiser-typed logo URL is not an outbound request from our server is to
 * render the actual surface and record every fetch.
 *
 * The invariant this file pins, uniformly, for all of them:
 *
 *   the ONLY non-`data:` URL a share image may request is one WE chose, on the
 *   storage host the app serves its own uploads from.
 *
 * (A satori render with no remote image fetches exactly one thing — its resvg
 * wasm, as a `data:` URI. So "nothing but `data:`" is a real, non-vacuous
 * assertion even for a surface that draws no logo at all: give one a remote
 * `<img>` and the request appears here immediately.)
 *
 * The surface LIST is read off the filesystem, not typed out — every module
 * under `src` that imports `next/og` or constructs an `ImageResponse`. A new
 * share image that skips the fetcher does not quietly go uncovered: it fails
 * `every satori surface is driven here` with its own path in the message.
 */

const SRC_DIR = path.resolve(import.meta.dirname, "../../..");

/** `import { ImageResponse } from "next/og"`, however it is spelled or aliased. */
const NEXT_OG_IMPORT = /from\s+["']next\/og["']/;

/** A miniature `src` tree that holds each escape shape the walk must catch. */
const WALK_FIXTURE = path.resolve(import.meta.dirname, "fixtures/satori-walk");

/**
 * Every module under `root` that can draw a satori image, as paths relative to
 * `root`.
 *
 * Keyed on the `next/og` IMPORT as well as the `new ImageResponse` literal, and
 * run from `src`, not `src/app`. Rooted at `src/app` on the literal alone, a
 * share image whose `ImageResponse` is built in a shared helper under
 * `src/server/og` — the natural tidy-up, since `match-poster-data.ts` already
 * centralises the loader — left its route file with neither, and went
 * uncovered with this suite green. Now the helper itself is derived and has to
 * be driven. Over today's tree both rules give the same nine modules.
 */
function satoriModules(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const source = fs.readFileSync(full, "utf8");
      if (!NEXT_OG_IMPORT.test(source) && !source.includes("new ImageResponse")) continue;
      found.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(root);
  return found.sort();
}

let derived: string[] | null = null;

/** Every live satori surface in the app — walked once per file run. */
function satoriSurfaces(): string[] {
  derived ??= satoriModules(SRC_DIR);
  return derived;
}

const STORAGE_ORIGIN = "https://projectref.supabase.co";
const ALLOWED_LOGO = `${STORAGE_ORIGIN}/storage/v1/object/public/assets/orgs/o1/logo.webp`;
const HOSTILE_LOGO = "https://cdn.attacker.example/logo.png";
const INTERNAL_LOGO = "https://169.254.169.254/latest/meta-data/";

/** The organiser-controlled logo URL every seeded loader hands its surface. */
let seededLogo: string | null = null;
/** Every URL the process asked for while the image was being produced. */
let requested: string[] = [];

function org() {
  return {
    id: "o1",
    name: "Southend Cricket Club",
    slug: "scc",
    logo: seededLogo,
    branding: null,
    branded: false,
    default_locale: "en",
  };
}

const competitionData = () => ({
  org: org(),
  competition: {
    id: "c1",
    name: "Southend Premier League",
    slug: "spl",
    branding: null,
    starts_on: "2026-04-01",
    ends_on: "2026-08-30",
  },
  divisions: [{ id: "d1", entrant_count: 8 }],
  liveNow: [],
});

const divisionData = () => ({
  org: org(),
  competition: { id: "c1", name: "Southend Premier League", slug: "spl", branding: null },
  division: { id: "d1", name: "Men's T8", slug: "mens-t8" },
  standings: [{ rows: [{ rank: 1, entrantId: "e1", played: 3, points: 9 }] }],
  entrants: [{ id: "e1", kind: "team", display_name: "Southend Blue Blazers" }],
});

const fixtureData = () => ({
  org: org(),
  competition: { id: "c1", name: "Southend Premier League", slug: "spl", branding: null },
  division: { id: "d1", name: "Men's T8", slug: "mens-t8" },
  fixture: { id: "f1", stage_id: null, summary: null },
  matchCentre: {
    header: {
      live: false,
      status: "decided",
      sides: [
        { entrantId: "SBB", name: "Southend Blue Blazers", short: "SBB", colour: null, badgeUrl: null },
        { entrantId: "SQ", name: "Southend Queens", short: "SQ", colour: null, badgeUrl: null },
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
});

const ticketView = () => ({
  status: "confirmed",
  ref_code: "SCC-1234",
  display_name: "A. Hein",
  org_name: "Southend Cricket Club",
  competition_name: "Southend Premier League",
  division_name: "Men's T8",
  starts_on: "2026-04-01",
  ends_on: "2026-04-01",
});

vi.mock("@/lib/db", () => ({ sql: vi.fn(async () => []) }));
vi.mock("@/server/public-site/data", () => ({
  getPublicOrg: vi.fn(async () => ({ org: org(), competitions: [] })),
  getPublicCompetition: vi.fn(async () => competitionData()),
  getPublicDivision: vi.fn(async () => divisionData()),
  getPublicFixture: vi.fn(async () => fixtureData()),
}));
vi.mock("@/server/usecases/org-posts", () => ({
  publicPost: vi.fn(async () => ({ kind: "result", title: "Blazers 83–71 Queens" })),
}));
vi.mock("@/server/usecases/registrations", () => ({
  publicRegistrationStatusByRef: vi.fn(async () => ticketView()),
}));

const RootOg = (await import("@/app/opengraph-image")).default;
const JoinOg = (await import("@/app/join/[token]/opengraph-image")).default;
const TicketPng = (await import("@/app/(public)/r/[ref]/ticket.png/route")).GET;
const CompetitionOg = (await import("@/app/(public)/shared/[orgSlug]/[competitionSlug]/opengraph-image"))
  .default;
const DivisionOg = (
  await import("@/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/opengraph-image")
).default;
const FixtureOg = (
  await import(
    "@/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/opengraph-image"
  )
).default;
const PosterPng = (
  await import(
    "@/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/poster.png/route"
  )
).GET;
const NewsOg = (await import("@/app/(public)/shared/[orgSlug]/news/[postSlug]/opengraph-image")).default;
const StoryPng = (await import("@/app/(public)/shared/[orgSlug]/news/[postSlug]/story.png/route")).GET;

const slugs = {
  orgSlug: "scc",
  competitionSlug: "spl",
  divisionSlug: "mens-t8",
  fixtureId: "f1",
  postSlug: "blazers-win",
  token: "tok",
  ref: "SCC-1234",
};
const params = Promise.resolve(slugs);
const req = (url: string) => new Request(`https://seazn.club${url}`);

interface Surface {
  /** How to produce the image. */
  render: () => Promise<Response>;
  /**
   * Whether the surface's own data carries an organiser-controlled image URL.
   * `false` is not an exemption — such a surface is still rendered and still
   * has to request nothing but `data:`, which is exactly what breaks if
   * someone later gives it a remote `<img>`.
   */
  drawsOrgLogo: boolean;
}

/**
 * Keyed by the path `satoriSurfaces()` derives. Adding a share image without
 * adding a driver here fails the first test below.
 */
const DRIVERS: Record<string, Surface> = {
  "app/opengraph-image.tsx": {
    render: async () => RootOg() as Response,
    drawsOrgLogo: false,
  },
  "app/join/[token]/opengraph-image.tsx": {
    render: async () => (await JoinOg({ params })) as Response,
    drawsOrgLogo: false,
  },
  "app/(public)/r/[ref]/ticket.png/route.tsx": {
    render: () => TicketPng(req("/r/SCC-1234/ticket.png"), { params }),
    drawsOrgLogo: false,
  },
  "app/(public)/shared/[orgSlug]/[competitionSlug]/opengraph-image.tsx": {
    render: async () => (await CompetitionOg({ params })) as Response,
    drawsOrgLogo: true,
  },
  "app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/opengraph-image.tsx": {
    render: async () => (await DivisionOg({ params })) as Response,
    drawsOrgLogo: true,
  },
  "app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/opengraph-image.tsx":
    {
      render: async () => (await FixtureOg({ params })) as Response,
      drawsOrgLogo: true,
    },
  "app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/poster.png/route.tsx":
    {
      render: () => PosterPng(req("/poster.png"), { params }),
      drawsOrgLogo: true,
    },
  "app/(public)/shared/[orgSlug]/news/[postSlug]/opengraph-image.tsx": {
    render: async () => (await NewsOg({ params })) as Response,
    drawsOrgLogo: true,
  },
  "app/(public)/shared/[orgSlug]/news/[postSlug]/story.png/route.tsx": {
    render: () => StoryPng(req("/story.png"), { params }),
    drawsOrgLogo: true,
  },
};

/** What the storage host will answer with on this test. */
let storageReply: () => Response = () => new Response("not configured", { status: 500 });

function spyFetch() {
  const real = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      requested.push(url);
      // satori loads its resvg wasm through fetch as a `data:` URI — let that
      // through to the real implementation so a render still works.
      if (url.startsWith("data:")) return real(input as RequestInfo, init);
      if (url.startsWith(STORAGE_ORIGIN)) return storageReply();
      // Every other host answers with a perfectly good picture ON PURPOSE: a
      // surface that hands satori a raw URL then both fetches AND draws it, so
      // the request assertion below is what catches it, not a render error.
      return new Response(new Uint8Array(HOSTILE_PNG), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }),
  );
}

/** Non-`data:` URLs — the ones that actually left our network. */
const remoteRequests = () => requested.filter((u) => !u.startsWith("data:"));

async function bytesOf(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

/**
 * How many pixels of the rendered card are the seeded logo's own colour.
 *
 * The layout assertion alone is not enough: satori draws a remote WEBP as an
 * EMPTY BOX, and an empty box still occupies its 52px and still shifts the org
 * name, so "the bytes changed" is true even when the logo never appeared. This
 * reads the canvas instead — no green pixels, no logo.
 */
async function logoPixels(png: Buffer): Promise<number> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  let n = 0;
  for (let i = 0; i + info.channels <= data.length; i += info.channels) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    if (r < 60 && b < 60 && g > 140 && g < 240) n++;
  }
  return n;
}

const solid = (w: number, r: number, g: number, b: number) =>
  sharp({ create: { width: w, height: w, channels: 4, background: { r, g, b, alpha: 1 } } });

let HOSTILE_PNG: Buffer;
let ALLOWED_WEBP: Buffer;

beforeEach(async () => {
  HOSTILE_PNG ??= await solid(200, 255, 0, 255).png().toBuffer();
  ALLOWED_WEBP ??= await solid(200, 0, 200, 0).webp().toBuffer();
  requested = [];
  seededLogo = null;
  storageReply = () =>
    new Response(new Uint8Array(ALLOWED_WEBP), {
      status: 200,
      headers: { "content-type": "image/webp" },
    });
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", STORAGE_ORIGIN);
  spyFetch();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("every public share image draws its logo through the guarded fetcher", () => {
  it("every satori surface under src is driven here", () => {
    const undriven = satoriSurfaces().filter((f) => !(f in DRIVERS));
    expect(undriven).toEqual([]);
  });

  it("every driver names a surface that still exists", () => {
    const surfaces = new Set(satoriSurfaces());
    expect(Object.keys(DRIVERS).filter((k) => !surfaces.has(k))).toEqual([]);
  });

  it("the derived list is not empty — the walk itself is proved", () => {
    expect(satoriSurfaces().length).toBeGreaterThan(5);
  });

  it("the walk cannot be escaped by a helper, an alias, or a dynamic import", () => {
    // Over today's tree the old rule (`src/app`, literal only) and this one
    // agree, so the live list cannot witness the difference. This fixture can:
    //  - `server/og/escape-frame.tsx` is a shared helper OUTSIDE `app` — only
    //    the `src` root finds it (its route, `app/escape/…`, carries neither
    //    marker and is correctly not listed: the helper is what reds the gate);
    //  - `server/og/aliased-frame.tsx` has no literal — only the import finds it;
    //  - `app/dynamic/route.tsx` has no static import — only the literal does;
    //  - `app/__tests__/ignored.tsx` imports `next/og` and is skipped.
    expect(satoriModules(WALK_FIXTURE)).toEqual([
      "app/dynamic/route.tsx",
      "server/og/aliased-frame.tsx",
      "server/og/escape-frame.tsx",
    ]);
  });
});

const everySurface = Object.entries(DRIVERS);
const logoSurfaces = everySurface.filter(([, s]) => s.drawsOrgLogo);

describe.each(everySurface)("%s", (_name, surface) => {
  it("requests nothing but `data:` when it has no logo to draw", async () => {
    const res = await surface.render();
    const bytes = await bytesOf(res);
    expect(res.status).toBe(200);
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    expect(remoteRequests()).toEqual([]);
  });
});

describe.each(logoSurfaces)("%s", (_name, surface) => {
  it(
    "an organiser's own host is never requested, and the picture is the no-logo one",
    async () => {
      const withoutLogo = await bytesOf(await surface.render());

      requested = [];
      seededLogo = HOSTILE_LOGO;
      const hostile = await bytesOf(await surface.render());
      expect(remoteRequests()).toEqual([]);
      expect(hostile.equals(withoutLogo)).toBe(true);

      requested = [];
      seededLogo = INTERNAL_LOGO;
      const internal = await bytesOf(await surface.render());
      expect(remoteRequests()).toEqual([]);
      expect(internal.equals(withoutLogo)).toBe(true);
    },
  );

  it(
    "an allow-listed WEBP logo is fetched once, by us, and is actually drawn",
    async () => {
      const withoutLogo = await bytesOf(await surface.render());

      requested = [];
      seededLogo = ALLOWED_LOGO;
      const withLogo = await bytesOf(await surface.render());

      // Exactly one request, to the host this app serves its own uploads from.
      expect(remoteRequests()).toEqual([ALLOWED_LOGO]);
      // …and the logo's own colour is ON the canvas. satori draws a remote WEBP
      // as an EMPTY BOX, so this is also what witnesses the fetcher's re-encode:
      // forward the bytes unchanged and the count stays at nothing.
      expect(await logoPixels(withoutLogo)).toBe(0);
      expect(await logoPixels(withLogo)).toBeGreaterThan(400);
    },
  );

  it(
    "an over-cap body falls back to the no-logo picture, not a blank box or a 500",
    async () => {
      const withoutLogo = await bytesOf(await surface.render());

      requested = [];
      seededLogo = ALLOWED_LOGO;
      storageReply = () =>
        new Response(new Uint8Array(Buffer.alloc(64)), {
          status: 200,
          headers: { "content-type": "image/webp", "content-length": String(8 * 1024 * 1024) },
        });
      const res = await surface.render();
      const oversize = await bytesOf(res);

      expect(res.status).toBe(200);
      expect(remoteRequests()).toEqual([ALLOWED_LOGO]);
      expect(oversize.equals(withoutLogo)).toBe(true);
    },
  );
});
