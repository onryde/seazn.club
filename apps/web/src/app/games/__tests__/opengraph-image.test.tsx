// The /games share images, driven through their REAL route modules and a REAL
// next/og ImageResponse (same rail as poster-dimensions.test.tsx): a model or
// tree test cannot see what satori actually produces — a PNG of the right
// size, or a render that throws on an unsupported style.
//
// Every render also records what it fetched. satori loads its resvg wasm as a
// `data:` URI and nothing else — unless the tree holds an emoji or a glyph the
// default font lacks, which it then fetches from a CDN, server-side, on a
// public route. So "nothing but data:" is pinned for every image here.
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { liveGames } from "@/games/registry";
import HubOg, * as HubModule from "../opengraph-image";
import GameOg, * as GameModule from "../[slug]/opengraph-image";

let requested: string[] = [];

beforeEach(() => {
  requested = [];
  const real = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      requested.push(url);
      if (url.startsWith("data:")) return real(input as RequestInfo, init);
      return new Response("not served in tests", { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const remote = () => requested.filter((u) => !u.startsWith("data:"));

async function png(res: Response): Promise<Buffer> {
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("image/png");
  const bytes = Buffer.from(await res.arrayBuffer());
  expect(bytes.subarray(1, 4).toString()).toBe("PNG");
  const meta = await sharp(bytes).metadata();
  expect(meta.width).toBe(1200);
  expect(meta.height).toBe(630);
  return bytes;
}

/**
 * How many pixels of `png` are (within a small tolerance) the colour `hex`.
 * A PNG of the right size proves nothing about what is ON it: an <svg> satori
 * could not rasterise drew an empty panel with every other test here green.
 */
async function pixelsOf(png: Buffer, hex: string): Promise<number> {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  let n = 0;
  for (let i = 0; i + info.channels <= data.length; i += info.channels) {
    if (Math.abs(data[i]! - r!) < 6 && Math.abs(data[i + 1]! - g!) < 6 && Math.abs(data[i + 2]! - b!) < 6) n++;
  }
  return n;
}

/** A colour only each game's own art paints (and no other art, and no frame). */
const SIGNATURE: Record<string, string> = {
  "chess-quest": "#eeeed2", // the light squares
  "daily-word": "#eab308", // the one "near" tile
  "2048": "#bbada0", // the board
};

const hub = async () => png((await HubOg()) as Response);
const game = async (slug: string) =>
  png((await GameOg({ params: Promise.resolve({ slug }) })) as Response);

describe("games share images — route contracts", () => {
  it("both routes declare a 1200×630 PNG with alt text", () => {
    for (const mod of [HubModule, GameModule]) {
      expect(mod.size).toEqual({ width: 1200, height: 630 });
      expect(mod.contentType).toBe("image/png");
      expect(mod.alt.length).toBeGreaterThan(10);
    }
  });
});

describe("/games share image (hub)", () => {
  it("renders a real 1200×630 PNG and fetches nothing but data:", async () => {
    const bytes = await hub();
    expect(bytes.byteLength).toBeGreaterThan(10_000);
    expect(remote()).toEqual([]);
  });

  it("premise: every live game has a signature colour to look for", () => {
    for (const { slug } of liveGames()) expect(SIGNATURE[slug], slug).toBeDefined();
  });

  it("every live game's art is actually painted on the card, not an empty panel", async () => {
    const bytes = await hub();
    for (const { slug } of liveGames()) {
      expect(await pixelsOf(bytes, SIGNATURE[slug]!), slug).toBeGreaterThan(1_500);
    }
  });
});

describe("/games/[slug] share image", () => {
  it("premise: there are live games to render", () => {
    expect(liveGames().length).toBeGreaterThan(0);
  });

  for (const { slug } of liveGames()) {
    it(`${slug}: renders its own real 1200×630 PNG — not the hub's — and fetches nothing but data:`, async () => {
      const bytes = await game(slug);
      expect(remote()).toEqual([]);
      expect(bytes.equals(await hub())).toBe(false);
    });

    it(`${slug}: paints its own art, and no other game's`, async () => {
      const bytes = await game(slug);
      expect(await pixelsOf(bytes, SIGNATURE[slug]!)).toBeGreaterThan(3_000);
      for (const other of liveGames().filter((g) => g.slug !== slug)) {
        expect(await pixelsOf(bytes, SIGNATURE[other.slug]!), other.slug).toBeLessThan(200);
      }
    });
  }

  it("every live game's card is a different picture", async () => {
    const pictures = await Promise.all(liveGames().map((g) => game(g.slug)));
    const distinct = new Set(pictures.map((b) => b.toString("base64")));
    expect(distinct.size).toBe(liveGames().length);
  });

  // A metadata image route has no 404 to give: the page's <meta> points at it
  // before any request is made (same ruling as the fixture OG card beside
  // poster-dimensions.test.tsx). An unknown slug draws the hub card instead.
  it("an unknown slug falls back to the hub picture, byte for byte, still a 200 PNG", async () => {
    const unknown = await game("not-a-real-game");
    expect(unknown.equals(await hub())).toBe(true);
    expect(remote()).toEqual([]);
  });
});
