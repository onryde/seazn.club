import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// GamePage is an async server component whose slim header nests
// GamePlayer -> next/dynamic({ssr:false}) -> the real chess-quest chunk —
// not renderable with react-dom/server outside a real Next.js runtime.
// Reading the source directly (same pattern as chess-quest-css.test.ts)
// keeps this a real regression guard without fighting that limitation.
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
