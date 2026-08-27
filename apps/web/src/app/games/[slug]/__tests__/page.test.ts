import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateMetadata } from "../page";

// GamePage ITSELF (the default export) is an async server component whose
// slim header nests GamePlayer -> next/dynamic({ssr:false}) -> the real
// chess-quest chunk — not renderable with react-dom/server outside a real
// Next.js runtime. generateMetadata has no such dependency (it only reads
// the registry), so it's called directly below rather than source-scanned.
const source = fs.readFileSync(path.resolve(__dirname, "../page.tsx"), "utf8");

// Review 2026-08-27: on the games.* subdomain, proxy.ts's gamesHostRewrite
// sends a relative href="/" straight back to /games — a dead loop, never
// reaching the marketing home. The "Powered by Seazn Club" link must be
// absolute (siteOrigin()), never a bare "/".
describe("games/[slug] page — Powered by link escapes the games.* subdomain", () => {
  it("imports siteOrigin", () => {
    expect(source).toMatch(/import\s*\{\s*siteOrigin\s*\}\s*from\s*"@\/lib\/site-origin"/);
  });

  it("the Powered by link's href uses siteOrigin(), not a bare relative \"/\"", () => {
    const linkBlock = source.slice(source.indexOf("Powered by") - 200, source.indexOf("Powered by"));
    expect(linkBlock).toContain("siteOrigin()");
    expect(linkBlock).not.toMatch(/href="\/"/);
  });
});

// Review 2026-08-27: Metadata merges shallowly per segment — since this
// page defines its own openGraph key, the root layout's openGraph
// (type/siteName only) is REPLACED here, not merged. Without an explicit
// openGraph.title/description, sharing a game link showed no page-specific
// preview card at all.
describe("games/[slug] page metadata — Open Graph", () => {
  it("sets openGraph title/description matching the page's own title/description for a real game", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "chess-quest" }),
    });
    expect(metadata.openGraph?.title).toBe(metadata.title);
    expect(metadata.openGraph?.description).toBe(metadata.description);
    expect(metadata.openGraph?.url).toBe("https://seazn.club/games/chess-quest");
  });

  it("returns empty metadata for an unknown slug (no crash, matches the existing notFound() path)", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "not-a-real-game" }),
    });
    expect(metadata).toEqual({});
  });
});
