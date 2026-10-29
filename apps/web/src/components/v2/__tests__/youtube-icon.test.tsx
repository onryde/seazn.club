// The official YouTube icon (YouTube Connect T12, owner 2026-10-28) and the rule that governs where it may appear (owner ruling
// 2026-10-28, from YouTube's branding terms: "any logo used within an application must be clickable and link back to YouTube content").
//
// `apps/web` vitest is `environment: "node"` — no DOM — so this proves what markup CAN prove: the artwork is unaltered (its two
// colours, its bounds), no size is below YouTube's digital minimum, the icon is only ever drawn INSIDE a link to YouTube (a channel's
// own page, or a YouTube replay), and `PlatformMark` — the mark every other row wears — never draws it. Pixels, clear space and the
// real tap area are the shots spec's (e2e/youtube-panel.shots.spec.ts).
//
// The expected values are YouTube's own, typed from developers.google.com/youtube/terms/branding-guidelines (page updated
// 2025-08-20, read 2026-10-28) and the brand site: red #FF0000 + a white play triangle, never recoloured; a 20 px digital minimum
// height. They are never read back from the component.
//
// Sport: not applicable — a platform mark is sport-agnostic.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isYoutubeUrl, youtubeChannelUrl } from "@/lib/youtube";
import { StreamTargetKind } from "@/server/api-v1/schemas";
import { PlatformMark, STREAM_MARK_KINDS } from "../stream-platform-mark";
import { YOUTUBE_ICON_HEIGHT_PX, YoutubeIcon, YoutubeIconLink, type YoutubeIconSize } from "../youtube-icon";

const SIZES = Object.keys(YOUTUBE_ICON_HEIGHT_PX) as YoutubeIconSize[];
const OFFICIAL_RED = "#FF0000";
const OFFICIAL_WHITE = "#FFFFFF";
const MIN_HEIGHT_PX = 20;
const ART_ASPECT = 28.57 / 20;

describe("the official YouTube icon", () => {
  it("is unaltered: exactly the two official colours, the artwork's own bounds, aspect ratio untouched", () => {
    let checked = 0;
    for (const size of SIZES) {
      const html = renderToStaticMarkup(<YoutubeIcon size={size} />);
      expect(html, size).toContain('viewBox="0 0 28.57 20"');
      expect([...html.matchAll(/fill="([^"]+)"/g)].map((x) => x[1]), `${size}: the fills are the official ones, nothing tinted`).toEqual([OFFICIAL_RED, OFFICIAL_WHITE]);
      const w = Number(/\bwidth="([\d.]+)"/.exec(html)?.[1]);
      const h = Number(/\bheight="([\d.]+)"/.exec(html)?.[1]);
      expect(w / h, `${size}: not stretched`).toBeCloseTo(ART_ASPECT, 2);
      // Fully visible, never clipped or covered: no style, filter, mask, clip-path or opacity on the artwork.
      for (const effect of ["filter", "mask", "clip", "opacity", "style=", "transform"]) expect(html, `${size}: ${effect}`).not.toContain(effect);
      checked++;
    }
    expect(checked, "every size was read").toBe(SIZES.length);
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it("no size is below YouTube's 20 px digital minimum, and the small size is exactly it", () => {
    let checked = 0;
    for (const size of SIZES) {
      const h = Number(/\bheight="([\d.]+)"/.exec(renderToStaticMarkup(<YoutubeIcon size={size} />))?.[1]);
      expect(h, size).toBeGreaterThanOrEqual(MIN_HEIGHT_PX);
      checked++;
    }
    expect(checked).toBe(SIZES.length);
    expect(Number(/\bheight="([\d.]+)"/.exec(renderToStaticMarkup(<YoutubeIcon size="sm" />))?.[1])).toBe(MIN_HEIGHT_PX);
    // The size the markup carries is the one asked for: the two sizes differ (a collapsed table could not witness the minimum).
    expect(YOUTUBE_ICON_HEIGHT_PX.md).toBeGreaterThan(YOUTUBE_ICON_HEIGHT_PX.sm);
  });

  it("is decorative for assistive tech: hidden, unfocusable (the platform's name always sits beside it as text)", () => {
    const html = renderToStaticMarkup(<YoutubeIcon size="md" />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('focusable="false"');
    expect(html).not.toContain("<title");
  });
});

describe("PlatformMark: YouTube's mark is a neutral tile — never the logo; every other platform keeps its brand tile", () => {
  it("YouTube's mark, at both sizes, is the neutral tile with its initial: no icon, no red, no svg (the logo is only ever inside a link)", () => {
    let checked = 0;
    for (const size of ["sm", "md"] as const) {
      const html = renderToStaticMarkup(<PlatformMark kind="youtube" size={size} />);
      expect(html, size).toContain('data-platform-mark="youtube"');
      expect(html, `${size}: the logo is not drawn here`).not.toContain("data-youtube-icon");
      expect(html, `${size}: no artwork at all`).not.toContain("<svg");
      expect(html, `${size}: not YouTube's red`).not.toMatch(/#ff0000|#ff0033|rgb\(255, ?0, ?0\)/i);
      expect(html, `${size}: the house neutral tile (slate-200 ground, slate-700 letter)`).toMatch(/background:#e2e8f0;color:#334155/);
      expect(html, `${size}: its initial`).toMatch(/>Y<\/span>$/);
      // The tile is the SAME size as every other platform's, so a YouTube row stays aligned with its neighbours.
      const box = size === "md" ? "h-8 w-8" : "h-5 w-5";
      expect(html, `${size}: the row's own mark size`).toContain(box);
      expect(html, `${size}: the same tile shape as every other platform`).toContain("rounded-md");
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("the other kinds are unchanged tiles with their own letter, and no kind lost its mark (the set equals the schema's)", () => {
    let checked = 0;
    for (const kind of StreamTargetKind.options.filter((k) => k !== "youtube")) {
      const html = renderToStaticMarkup(<PlatformMark kind={kind} size="sm" />);
      expect(html, kind).toContain(`data-platform-mark="${kind}"`);
      expect(html, kind).toContain("rounded-md");
      expect(html, kind).not.toContain("data-youtube-icon");
      checked++;
    }
    expect(checked).toBe(StreamTargetKind.options.length - 1);
    expect(checked).toBeGreaterThan(0);
    expect([...STREAM_MARK_KINDS].sort()).toEqual([...StreamTargetKind.options].sort());
  });

  it("no kind at all draws the icon: the sweep covers every stored kind at both sizes (anti-vacuity: counted)", () => {
    let checked = 0;
    for (const kind of StreamTargetKind.options) {
      for (const size of ["sm", "md"] as const) {
        const html = renderToStaticMarkup(<PlatformMark kind={kind} size={size} />);
        expect(html, `${kind}/${size}`).not.toContain("data-youtube-icon");
        expect(html, `${kind}/${size}`).toContain(`data-platform-mark="${kind}"`);
        checked++;
      }
    }
    expect(checked).toBe(StreamTargetKind.options.length * 2);
    expect(checked).toBeGreaterThanOrEqual(10);
  });
});

// ─── the logo is a link ─────────────────────────────────────────────────────────────────────────────────────────────────
const CHANNEL_ID = "UC7xK2mQ9rVbN4tLpA1sZ0wE";
const NAME = "Riverside FC on YouTube";
const link = (over: Partial<Parameters<typeof YoutubeIconLink>[0]> = {}): string =>
  renderToStaticMarkup(<YoutubeIconLink channelId={CHANNEL_ID} label={NAME} size="md" {...over} />);
const anchorTag = (html: string): string => /^<a\b[^>]*>/.exec(html)?.[0] ?? "";
const tokensOf = (tag: string): string[] => (/\bclass="([^"]*)"/.exec(tag)?.[1] ?? "").split(/\s+/).filter(Boolean);

describe("youtubeChannelUrl: a channel's page on YouTube, from its id", () => {
  it("is https://www.youtube.com/channel/<id> — typed from YouTube's own URL shape, and a YouTube URL by the product's own test", () => {
    expect(youtubeChannelUrl(CHANNEL_ID)).toBe("https://www.youtube.com/channel/UC7xK2mQ9rVbN4tLpA1sZ0wE");
    expect(isYoutubeUrl(youtubeChannelUrl(CHANNEL_ID))).toBe(true);
    // Two ids, two links: the URL is built from the id, never a constant.
    expect(youtubeChannelUrl("UCaaaaaaaaaaaaaaaaaaaaaa")).not.toBe(youtubeChannelUrl(CHANNEL_ID));
  });

  it("an id is one path segment: nothing in it can leave the /channel/ path or change the host", () => {
    for (const hostile of ["a/b", "a?b=1", "a#b", "../../evil", "a b"]) {
      const u = new URL(youtubeChannelUrl(hostile));
      expect(u.hostname, hostile).toBe("www.youtube.com");
      expect(u.search, hostile).toBe("");
      expect(u.hash, hostile).toBe("");
      expect(u.pathname.split("/").filter(Boolean), `${hostile}: the id is one segment`).toHaveLength(2);
    }
  });
});

describe("YoutubeIconLink: the logo, clickable, leading to YouTube (owner 2026-10-28)", () => {
  it("is an <a> whose href is the channel's page, in a new tab with no opener, and the official icon sits INSIDE it", () => {
    const html = link();
    const tag = anchorTag(html);
    expect(tag, "the markup starts with the anchor").not.toBe("");
    expect(tag).toContain('href="https://www.youtube.com/channel/UC7xK2mQ9rVbN4tLpA1sZ0wE"');
    expect(tag).toContain('target="_blank"');
    expect(tag).toContain('rel="noopener noreferrer"');
    expect(tag).toContain('data-testid="youtube-logo-link"');
    expect(html, "the icon is the anchor's own child, and nothing else is").toMatch(/^<a\b[^>]*><svg\b[^>]*data-youtube-icon="md"[^>]*>[\s\S]*<\/svg><\/a>$/);
    expect(html.match(/<a\b/g)).toHaveLength(1);
    expect(html.match(/data-youtube-icon="/g)).toHaveLength(1);
  });

  it("the href follows the channel id (not the label, not a constant)", () => {
    const other = "UCq8Zp3nW2yHcB6vTdR4eXjA";
    expect(anchorTag(link({ channelId: other }))).toContain(`href="https://www.youtube.com/channel/${other}"`);
    expect(anchorTag(link({ channelId: other }))).not.toContain(CHANNEL_ID);
    expect(anchorTag(link({ label: "Somebody else on YouTube" }))).toContain(`href="https://www.youtube.com/channel/${CHANNEL_ID}"`);
  });

  it("is named by the caller's label (the artwork stays aria-hidden), so a screen reader hears '<channel> on YouTube', not 'link'", () => {
    const html = link();
    expect(anchorTag(html)).toContain(`aria-label="${NAME}"`);
    expect(html).toContain('aria-hidden="true"');
    expect(html, "the label is not a title tooltip on the artwork").not.toContain("<title");
  });

  it("keyboard focus is the house accent ring, drawn on the link", () => {
    const t = tokensOf(anchorTag(link()));
    for (const token of ["focus-visible:outline", "focus-visible:outline-2", "focus-visible:outline-offset-2", "focus-visible:outline-accent"]) {
      expect(t, token).toContain(token);
    }
  });

  it("the tap area is 44px by 44px (a pseudo-element, h-11 w-11) while the visible icon stays its own 24px: nothing about the artwork grew", () => {
    const html = link();
    const t = tokensOf(anchorTag(html));
    expect(t, "the pseudo-element is positioned against the link").toContain("relative");
    for (const token of ["before:absolute", "before:left-1/2", "before:top-1/2", "before:h-11", "before:w-11", "before:-translate-x-1/2", "before:-translate-y-1/2"]) {
      expect(t, token).toContain(token);
    }
    // 44px is h-11 / w-11 (2.75rem at the 16px root): the target's floor on a phone.
    expect(t.some((c) => c.startsWith("before:content")), "a ::before needs a content to exist").toBe(true);
    // The link adds no padding or margin that would push the icon's own box, and the artwork is the md size untouched.
    expect(t.filter((c) => /^(p|px|py|pl|pr|pt|pb|m|mx|my)-/.test(c)), "no padding or margin on the link").toEqual([]);
    expect(Number(/\bheight="([\d.]+)"/.exec(html)?.[1])).toBe(YOUTUBE_ICON_HEIGHT_PX.md);
    expect(html).toContain('viewBox="0 0 28.57 20"');
  });

  it("works at the small size too — the same link, the same rules", () => {
    const html = link({ size: "sm" });
    expect(html).toContain('data-youtube-icon="sm"');
    expect(anchorTag(html)).toContain(`href="${youtubeChannelUrl(CHANNEL_ID)}"`);
    expect(tokensOf(anchorTag(html))).toContain("before:h-11");
  });
});

// ─── the registry: where the logo may be drawn ──────────────────────────────────────────────────────────────────────────
// A sweep of the SOURCE, because the rule is "no surface draws the logo outside a link" and a surface added tomorrow is the one a
// rendered test has not met yet. Every JSX use of <YoutubeIcon> in the product is found, and each must (a) sit inside an <a> that
// has an href and (b) be one of the two registered sites. The rendered halves are in youtube-connect-panel.test.tsx (the Streaming
// page), fixture-stream-panel.test.tsx (the replay row) and fixture-destination-picker.test.tsx (the picker draws none).
const SRC_ROOT = join(__dirname, "..", "..", "..");
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "__tests__" || e.name === "node_modules") return [];
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.(tsx|ts)$/.test(e.name) ? [p] : [];
  });
}
const FILES = sourceFiles(SRC_ROOT).map((p) => ({ rel: relative(SRC_ROOT, p).split("\\").join("/"), text: readFileSync(p, "utf8") }));
/** Every `<YoutubeIcon` JSX opening (the negative look-ahead keeps `<YoutubeIconLink` out), as { file, text before it }. */
const ICON_SITES = FILES.flatMap((f) => [...f.text.matchAll(/<YoutubeIcon(?![A-Za-z])/g)].map((m) => ({ file: f.rel, before: f.text.slice(0, m.index), after: f.text.slice(m.index!) })));

describe("the logo is only ever drawn inside a link to YouTube", () => {
  it("the scan reads the whole product, and finds exactly the two registered sites (the channel link, the replay link)", () => {
    expect(FILES.length, "anti-vacuity: the scan read the source tree").toBeGreaterThan(300);
    expect(FILES.some((f) => f.rel === "components/v2/youtube-icon.tsx")).toBe(true);
    expect(ICON_SITES.map((s) => s.file).sort()).toEqual(["components/v2/fixture-stream-panel.tsx", "components/v2/youtube-icon.tsx"]);
  });

  it("every site is inside an <a> that has an href (no </a> between the opening and the icon), and each names where it leads", () => {
    let checked = 0;
    for (const s of ICON_SITES) {
      const open = Math.max(s.before.lastIndexOf("<a\n"), s.before.lastIndexOf("<a "), s.before.lastIndexOf("<a>"));
      expect(open, `${s.file}: an <a> opens before the icon`).toBeGreaterThanOrEqual(0);
      const between = s.before.slice(open);
      expect(between.includes("</a>"), `${s.file}: the anchor is still open at the icon`).toBe(false);
      const openingTag = between.slice(0, between.search(/>\s/) + 1);
      expect(openingTag, `${s.file}: the anchor has an href`).toMatch(/\bhref=/);
      if (s.file.endsWith("youtube-icon.tsx")) expect(openingTag, "the link goes to the channel's page").toContain("href={youtubeChannelUrl(channelId)}");
      if (s.file.endsWith("fixture-stream-panel.tsx")) {
        expect(openingTag, "the replay link").toContain("href={row.url}");
        // The icon follows the LINK: it is drawn only when the link really goes to YouTube.
        expect(between.slice(-200), "gated by isYoutubeUrl").toContain("isYoutubeUrl(row.url)");
      }
      checked++;
    }
    expect(checked, "anti-vacuity: both sites were checked").toBe(2);
  });

  it("nothing else draws YouTube's artwork: PlatformMark does not import the icon, and the one <YoutubeIconLink> user is the channel row", () => {
    const mark = FILES.find((f) => f.rel === "components/v2/stream-platform-mark.tsx")!;
    expect(mark.text, "PlatformMark never draws the logo").not.toMatch(/YoutubeIcon|data-youtube-icon/);
    const users = FILES.filter((f) => /<YoutubeIconLink(?![A-Za-z])/.test(f.text)).map((f) => f.rel);
    expect(users).toEqual(["components/v2/youtube-connect-panel.tsx"]);
    // No raw copy of the artwork either: the path data lives in one file.
    const artwork = FILES.filter((f) => f.text.includes("M27.9727 3.12324")).map((f) => f.rel);
    expect(artwork).toEqual(["components/v2/youtube-icon.tsx"]);
  });
});
