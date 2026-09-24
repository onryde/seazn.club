// What the /games share images DRAW — the element tree handed to next/og's
// ImageResponse, captured and rendered to markup (the technique of the /shared
// opengraph-image-locale tests). The sibling opengraph-image.test.tsx proves
// the real PNGs; this file proves their content: the copy of the approved
// mockups (games-canvas gen.py og_hub / og_game) and that the game tiles come
// from the registry, in its order, not from a hardcoded list.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { GameMeta } from "@/games/registry";

const captured: { tree: ReactElement | null; size: unknown } = { tree: null, size: null };
vi.mock("next/og", () => ({
  ImageResponse: class {
    constructor(tree: unknown, size: unknown) {
      captured.tree = tree as ReactElement;
      captured.size = size;
    }
  },
}));

// The REAL registry's games in ONE array that GAMES, getGame and liveGames all
// read — so a test can append a game and every accessor sees it (a route that
// read GAMES where it should read liveGames() must not slip past).
const registry = vi.hoisted(() => ({ games: [] as GameMeta[] }));
vi.mock("@/games/registry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/games/registry")>();
  registry.games.push(...real.GAMES);
  return {
    ...real,
    GAMES: registry.games,
    getGame: (slug: string) => registry.games.find((g) => g.slug === slug),
    liveGames: () => registry.games.filter((g) => g.status === "live"),
  };
});

/** Run `body` with `extra` appended to the registry, then restore it. */
async function withGames(extra: GameMeta[], body: () => Promise<void>) {
  registry.games.push(...extra);
  try {
    await body();
  } finally {
    registry.games.splice(registry.games.length - extra.length, extra.length);
  }
}

import HubOg from "../opengraph-image";
import GameOg, { generateStaticParams } from "../[slug]/opengraph-image";
import { GAMES, liveGames } from "@/games/registry";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

async function draw(render: () => unknown): Promise<string> {
  captured.tree = null;
  await render();
  if (!captured.tree) throw new Error("ImageResponse was never constructed");
  return renderToStaticMarkup(captured.tree);
}

const arts = (html: string) => [...html.matchAll(/data-game-art="([^"]+)"/g)].map((m) => m[1]);

describe("/games share image (hub) — content", () => {
  it("draws the wordmark, the address and the two headline lines", async () => {
    const html = await draw(() => HubOg());
    expect(html).toContain(">SEAZN<");
    expect(html).toContain(">GAMES<");
    expect(html).toContain(">seazn.club/games<");
    expect(html).toContain(">FREE GAMES IN YOUR BROWSER.<");
    expect(html).toContain(">NO INSTALL. NO SIGN-UP. NO ADS.<");
    expect(captured.size).toEqual({ width: 1200, height: 630 });
  });

  // satori applies a transform to a clip path twice for the clipped children,
  // and misplaces a clipped art edge even unrotated by a pixel at the curve —
  // so neither card clips anything: each art draws its own rounded panel.
  it("clips nothing (no overflow:hidden anywhere in the tree)", async () => {
    expect(await draw(() => HubOg())).not.toContain("overflow:hidden");
  });

  it("draws one tile per LIVE game, in registry order, each with its own art", async () => {
    const html = await draw(() => HubOg());
    expect(liveGames().length).toBeGreaterThan(0);
    expect(arts(html)).toEqual(liveGames().map((g) => g.slug));
    expect(html).not.toContain("data-game-art-fallback=");
  });

  it("a coming-soon game gets no tile (liveGames, not GAMES)", async () => {
    const soon: GameMeta = {
      slug: "soon-probe",
      title: "Soon",
      tagline: "t",
      description: "d",
      thumbnail: "🧩",
      status: "coming-soon",
    };
    await withGames([soon], async () => {
      expect(GAMES.map((g) => g.slug)).toContain("soon-probe");
      const html = await draw(() => HubOg());
      expect(arts(html)).not.toContain("soon-probe");
      expect(arts(html)).toEqual(liveGames().map((g) => g.slug));
    });
  });

  it("a fourth live game still fits the row: tiles shrink, never spill past the 1072px content box", async () => {
    await withGames([{ ...GAMES[0]!, slug: "fourth-probe", status: "live" }], async () => {
      const html = await draw(() => HubOg());
      expect(arts(html)).toHaveLength(liveGames().length);
      expect(liveGames().length).toBe(4);
      const widths = [...html.matchAll(/data-game-art="[^"]+"[^>]*style="[^"]*?(?:^|;)\s*width:\s*(\d+(?:\.\d+)?)px/g)].map(
        (m) => Number(m[1]),
      );
      expect(widths).toHaveLength(4);
      // tile + 2×3px border each, 28px gaps between.
      const row = widths.reduce((a, w) => a + w + 6, 0) + 28 * (widths.length - 1);
      expect(row).toBeLessThanOrEqual(1200 - 2 * 64);
    });
  });
});

describe("/games/[slug] share image — content", () => {
  for (const g of GAMES.filter((x) => x.status === "live")) {
    it(`${g.slug}: its uppercase title, tagline, the Play-free pill and its own art only`, async () => {
      const html = await draw(() => GameOg({ params: Promise.resolve({ slug: g.slug }) }));
      expect(html).toContain(`>${esc(g.title.toUpperCase())}<`);
      expect(html).toContain(`>${esc(g.tagline)}<`);
      expect(html).toContain(">Play free<");
      expect(html).toContain(">No sign-up. No ads.<");
      expect(html).toContain(">SEAZN<");
      expect(arts(html)).toEqual([g.slug]);
      expect(html).not.toContain("data-game-art-fallback=");
      // The art is tilted like the mockup's box — and nothing under the tilt
      // clips: satori rotates a clip path twice for its children.
      expect(html).toContain("rotate(-5deg)");
      expect(html).not.toContain("overflow:hidden");
      expect(captured.size).toEqual({ width: 1200, height: 630 });
    });
  }

  it("an unknown slug is not found: no card is drawn at all", async () => {
    captured.tree = null;
    await expect(GameOg({ params: Promise.resolve({ slug: "not-a-real-game" }) })).rejects.toThrow(
      /NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/,
    );
    expect(captured.tree).toBeNull();
  });

  it("a coming-soon game draws the hub card too — it has no art, and 'Play free' would be untrue", async () => {
    const soon: GameMeta = {
      slug: "soon-probe",
      title: "Soon Game",
      tagline: "t",
      description: "d",
      thumbnail: "🧩",
      status: "coming-soon",
    };
    await withGames([soon], async () => {
      const html = await draw(() => GameOg({ params: Promise.resolve({ slug: "soon-probe" }) }));
      expect(html).toContain(">FREE GAMES IN YOUR BROWSER.<");
      expect(arts(html)).toEqual(liveGames().map((g) => g.slug));
      expect(html).not.toContain("SOON GAME");
      expect(html).not.toContain("🧩");
    });
  });

  it("prerenders a card per LIVE game only — a coming-soon game is not prerendered (liveGames, not GAMES)", async () => {
    const soon: GameMeta = {
      slug: "soon-probe",
      title: "Soon Game",
      tagline: "t",
      description: "d",
      thumbnail: "🧩",
      status: "coming-soon",
    };
    await withGames([soon], async () => {
      expect(GAMES.map((g) => g.slug)).toContain("soon-probe");
      const params = await generateStaticParams();
      expect(params).toEqual(liveGames().map(({ slug }) => ({ slug })));
      expect(params.length).toBeGreaterThan(0);
    });
  });
});
