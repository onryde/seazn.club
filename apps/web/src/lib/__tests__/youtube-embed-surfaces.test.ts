// A made-for-kids replay is never embedded (owner 2026-10-29; Google YouTube API Services Developer Policies III.E.4.j). The rule lives
// in ONE predicate (`mayEmbedReplay`, lib/youtube.ts) and ONE component that builds an iframe and a thumbnail request from it
// (components/public-site/match-centre/replay-embed.tsx), mounted on ONE page (the public match page). The organiser's panel
// (components/v2/fixture-stream-panel.tsx) draws links only - controller ruling R6, verified here rather than asserted.
//
// A SWEEP OF THE SOURCE, because the failure it guards is a surface added tomorrow that embeds a YouTube video without going through the
// rule: a rendered test has not met that surface yet. Every non-test source file that can make a browser load YouTube's player or a
// video's thumbnail (the embed builders, the embed host, the thumbnail host) is found, and each must be one of the registered files.
// The component that builds the iframe must ask the predicate; the page that mounts it must be the registered one.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = join(__dirname, "..", "..");
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "__tests__" || e.name === "node_modules") return [];
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.(tsx|ts)$/.test(e.name) && !/\.test\.(tsx|ts)$/.test(e.name) ? [p] : [];
  });
}
// Built lazily: nothing is read at collection.
const files = () => sourceFiles(SRC_ROOT).map((p) => ({ rel: relative(SRC_ROOT, p).split("\\").join("/"), text: readFileSync(p, "utf8") }));

/** What makes a browser load YouTube's player or a video's thumbnail: calling the embed or thumbnail builder, or naming any host that
 *  serves either (the privacy-enhanced embed host, the plain embed path, and both thumbnail hosts - i.ytimg.com and img.youtube.com). */
const LOADS_YOUTUBE_MEDIA = /youtubeEmbedUrl\(|youtubeThumbnailUrl\(|youtube-nocookie\.com|youtube\.com\/embed|i\.ytimg\.com|img\.youtube\.com/;
/** The registered files. lib/youtube.ts DEFINES the builders and hosts; proxy.ts names the hosts in the CSP; replay-embed.tsx is the one
 *  component that uses them; the cookie policy page describes them in prose. */
const REGISTERED = new Set([
  "lib/youtube.ts",
  "proxy.ts",
  "components/public-site/match-centre/replay-embed.tsx",
  "app/legal/cookie-policy/page.tsx",
]);

describe("the YouTube player and thumbnail are built in one place, and that place asks the made-for-kids rule", () => {
  it("EMPTY CASE FIRST: the sweep sees the source tree; then every file that loads YouTube media is a registered one", () => {
    const all = files();
    expect(all.length, "anti-vacuity: the tree was read").toBeGreaterThan(500);
    const hits = all.filter((f) => LOADS_YOUTUBE_MEDIA.test(f.text)).map((f) => f.rel).sort();
    expect(hits.length, "anti-vacuity: the probe finds the registered files").toBeGreaterThanOrEqual(3);
    expect(hits.filter((h) => !REGISTERED.has(h)), "a file outside the registry loads YouTube media").toEqual([]);
    // Every registered file really is found by the probe, so the registry cannot go stale unnoticed.
    expect(hits.filter((h) => REGISTERED.has(h)).sort()).toEqual([...REGISTERED].sort());
  });

  it("the probe recognises every way to load YouTube media, and passes a plain link to YouTube (anti-vacuity: each alternative is witnessed)", () => {
    const loads = [
      "youtubeEmbedUrl(id)", "youtubeThumbnailUrl(id)", "https://www.youtube-nocookie.com/embed/abc", "https://i.ytimg.com/vi/abc/hqdefault.jpg",
      "https://www.youtube.com/embed/abc", "https://img.youtube.com/vi/abc/0.jpg",
    ];
    for (const text of loads) expect(LOADS_YOUTUBE_MEDIA.test(text), `the probe must flag: ${text}`).toBe(true);
    expect(loads.length, "anti-vacuity: six forms were put to it").toBe(6);
    // The positive pair's other half: what a made-for-kids part IS (a link out) loads nothing, so it must not be flagged.
    for (const text of ["https://www.youtube.com/watch?v=abc", "https://youtu.be/abc", "https://www.youtube.com/t/terms", "https://www.youtube.com/"]) {
      expect(LOADS_YOUTUBE_MEDIA.test(text), `the probe must pass: ${text}`).toBe(false);
    }
  });

  it("the component that builds the iframe and the thumbnail decides with mayEmbedReplay - and so does nothing else need to: it is the ONLY caller of the builders", () => {
    const all = files();
    const callers = all.filter((f) => /youtubeEmbedUrl\(|youtubeThumbnailUrl\(/.test(f.text) && f.rel !== "lib/youtube.ts").map((f) => f.rel);
    expect(callers, "exactly one component builds a player or a thumbnail request").toEqual(["components/public-site/match-centre/replay-embed.tsx"]);
    const embed = all.find((f) => f.rel === callers[0])!;
    expect(embed.text, "and it asks the rule").toMatch(/\bmayEmbedReplay\(/);
  });

  it("the component is mounted by the public match page only; the organiser's panel imports neither it nor the builders", () => {
    const all = files();
    const mounts = all.filter((f) => /<ReplayEmbed\b/.test(f.text)).map((f) => f.rel);
    expect(mounts).toEqual(["app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/page.tsx"]);
    const panel = all.find((f) => f.rel === "components/v2/fixture-stream-panel.tsx");
    expect(panel, "premise: the organiser's panel was found").toBeDefined();
    expect(panel!.text).not.toMatch(/replay-embed|youtubeEmbedUrl|youtubeThumbnailUrl|<iframe/);
    // The positive pair: the probe does see a mount and an import where there is one.
    expect(all.find((f) => f.rel === mounts[0])!.text).toMatch(/replay-embed/);
  });
});
