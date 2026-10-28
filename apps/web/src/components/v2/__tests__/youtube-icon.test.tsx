// The official YouTube icon (YouTube Connect T12, owner 2026-10-28) and the one place that wears it, `PlatformMark`.
//
// `apps/web` vitest is `environment: "node"` — no DOM — so this proves what markup CAN prove: the artwork is unaltered (its two
// colours, its bounds), no size is below YouTube's digital minimum, and every YouTube row's mark IS the icon, with no tile of our
// own drawing left anywhere. Pixels and clear space around it are the shots spec's (e2e/youtube-panel.shots.spec.ts).
//
// The expected values are YouTube's own, typed from developers.google.com/youtube/terms/branding-guidelines (page updated
// 2025-08-20, read 2026-10-28) and the brand site: red #FF0000 + a white play triangle, never recoloured; a 20 px digital minimum
// height. They are never read back from the component.
//
// Sport: not applicable — a platform mark is sport-agnostic.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StreamTargetKind } from "@/server/api-v1/schemas";
import { PlatformMark, STREAM_MARK_KINDS } from "../stream-platform-mark";
import { YOUTUBE_ICON_HEIGHT_PX, YoutubeIcon, type YoutubeIconSize } from "../youtube-icon";

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

describe("PlatformMark: YouTube wears the icon everywhere, every other platform keeps its tile", () => {
  it("every YouTube mark, at both sizes, is the official icon — and the old red Y tile is nowhere", () => {
    let checked = 0;
    for (const size of ["sm", "md"] as const) {
      const html = renderToStaticMarkup(<PlatformMark kind="youtube" size={size} />);
      expect(html, size).toContain('data-platform-mark="youtube"');
      expect(html, `${size}: the icon is the size the row asked for`).toContain(`data-youtube-icon="${size}"`);
      expect(Number(/\bheight="([\d.]+)"/.exec(html)?.[1]), `${size}: its height is that size's own`).toBe(YOUTUBE_ICON_HEIGHT_PX[size]);
      expect(html, `${size}: no tile of our own drawing`).not.toMatch(/#ff0033|rounded-md|>Y</i);
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
});
