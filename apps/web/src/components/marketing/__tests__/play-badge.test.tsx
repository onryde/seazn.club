// The Google Play badge (spec 2026-11-25 §4): Google's own art, self-hosted and unaltered, in the marketing footer.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import sharp from "sharp";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MarketingFooter } from "@/components/marketing-footer";
import { PlayBadge, playBadgeSrc } from "@/components/marketing/play-badge";
import { PLAY_STORE_URL } from "@/lib/app-store";
import { LOCALES, type Locale } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/marketing.json";
import es from "@/dictionaries/es/marketing.json";
import fr from "@/dictionaries/fr/marketing.json";
import nl from "@/dictionaries/nl/marketing.json";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";

// The footer mounts the LocaleSwitcher, a client component using navigation hooks.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/en/start",
}));

const SRC_DIR = join(__dirname, "../../..");
const PUBLIC_DIR = join(SRC_DIR, "../public");
const DICTS: Record<Locale, Record<string, string>> = { en, es, fr, nl };

// SHA-256 of each file as downloaded on 2026-11-25 from
// https://play.google.com/intl/en_us/badges/static/images/badges/<locale>_badge_web_generic.png
// "Unaltered" is Google's condition: a re-export, a crop or an optimiser pass changes the bytes.
const GOOGLE_SHA256: Record<Locale, string> = {
  en: "f72611e2df8e88204009fd896d05d5e8e83c77009c63943bbffa169559934849",
  es: "de3f8a494fd6d672e53a700d081e5a2fe37bb480d6848610a1e6c8beb5ba4724",
  fr: "57d0e69e021d5d08f1fcacfc44e6dd3c79f5d74627bfbc0f696a88f03fb06c4a",
  nl: "eee155542a2ce35619a7941837d72844beaa8ece34dbf90e958b057004c7e4de",
};

/** The badge a person sees inside Google's file: the box around its opaque pixels, read from the file. */
async function visibleArt(file: string) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let left = info.width, top = info.height, right = -1, bottom = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3]! > 127) {
        left = Math.min(left, x); right = Math.max(right, x);
        top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    }
  }
  expect(right, `${file} has no opaque pixel`).toBeGreaterThanOrEqual(0);
  return { canvasW: info.width, canvasH: info.height, w: right - left + 1, h: bottom - top + 1, left, top, right: info.width - 1 - right, bottom: info.height - 1 - bottom };
}

const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

/** The badge's link and image as rendered. */
function badgeParts(html: string) {
  const link = /<a [^>]*data-testid="play-badge"[^>]*>.*?<\/a>/.exec(html)?.[0] ?? "";
  const a = /<a [^>]*>/.exec(link)?.[0] ?? "";
  const img = /<img [^>]*>/.exec(link)?.[0] ?? "";
  const boxPx = (side: "width" | "height") => Number(new RegExp(`(?:^|;)${side}:(\\d+)px`).exec(attr(a, "style") ?? "")?.[1]);
  return { a, img, alt: attr(img, "alt"), src: attr(img, "src"), width: Number(attr(img, "width")), height: Number(attr(img, "height")), box: { width: boxPx("width"), height: boxPx("height") } };
}

describe("playBadgeSrc", () => {
  it.each(LOCALES.map((l) => [l]))("%s has its own art, and the file exists", (l) => {
    expect(playBadgeSrc(l)).toBe(`/badges/google-play-${l}.png`);
    expect(existsSync(join(PUBLIC_DIR, playBadgeSrc(l)))).toBe(true);
  });

  it("an unknown or empty locale falls back to English art", () => {
    for (const lang of ["de", "", "EN-gb", "../fr"]) expect(playBadgeSrc(lang), JSON.stringify(lang)).toBe("/badges/google-play-en.png");
  });

  it("each file is Google's, byte for byte", () => {
    let checked = 0;
    for (const l of LOCALES) {
      const bytes = readFileSync(join(PUBLIC_DIR, playBadgeSrc(l)));
      expect(createHash("sha256").update(bytes).digest("hex"), l).toBe(GOOGLE_SHA256[l]);
      checked++;
    }
    expect(checked).toBe(4);
  });
});

describe("the store URL", () => {
  it("is written in exactly one source file", () => {
    const scanned: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== "__tests__") walk(path);
        } else if (/\.(ts|tsx|js|mjs|cjs|json|css|md|mdx)$/.test(name) && !/\.test\.tsx?$/.test(name)) scanned.push(path);
      }
    };
    walk(SRC_DIR);
    expect(scanned.length).toBeGreaterThan(500);
    const holders = scanned.filter((p) => readFileSync(p, "utf8").includes("play.google.com/store")).map((p) => relative(SRC_DIR, p));
    expect(holders).toEqual(["lib/app-store.ts"]);
  });
});

describe("PlayBadge", () => {
  it.each(LOCALES.map((l) => [l]))("%s: links the store with that locale's art and alt, at a stated size", async (lang) => {
    const html = renderToStaticMarkup(await PlayBadge({ lang }));
    const { a, img, alt, src, width, height } = badgeParts(html);
    expect(attr(a, "href")).toBe(PLAY_STORE_URL);
    // Served as shipped: the Next image optimiser would re-encode the art.
    expect(src).toBe(`/badges/google-play-${lang}.png`);
    expect(img).not.toContain("srcSet");
    expect(img).not.toContain("srcset");
    expect(alt).toBe(DICTS[lang]!["app.playBadge.alt"]);
    expect(alt).toContain("Google Play");
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });

  it("the four alt texts are four different strings", () => {
    expect(new Set(LOCALES.map((l) => DICTS[l]!["app.playBadge.alt"])).size).toBe(4);
  });

  it("an unknown locale renders the English badge whole", async () => {
    const parts = badgeParts(renderToStaticMarkup(await PlayBadge({ lang: "de" })));
    expect(parts.src).toBe("/badges/google-play-en.png");
    expect(parts.alt).toBe("Get it on Google Play");
  });

  // Google's four canvases do not hold the badge at one scale, so the same file width would draw English about an
  // eighth smaller than the rest. Heights are the badge's own pixels in each file, scaled by the rendered width.
  it.each([["sm", 40], ["md", 48]] as const)("%s: the badge a person sees is %ipx tall in every locale, with Google's clear space inside the link", async (size, px) => {
    const boxes = new Set<string>();
    let checked = 0;
    for (const lang of LOCALES) {
      const { width, height, box } = badgeParts(renderToStaticMarkup(await PlayBadge({ lang, size })));
      const art = await visibleArt(join(PUBLIC_DIR, playBadgeSrc(lang)));
      const scale = width / art.canvasW;
      expect(Math.abs(art.h * scale - px), `${lang} visible height ${art.h * scale}`).toBeLessThanOrEqual(0.5);
      // The stated height keeps the file's own proportions (nothing is stretched), to the pixel both sides round to.
      expect(Math.abs(art.canvasH * scale - height), `${lang} height`).toBeLessThan(1);
      // Clear space: a quarter of the badge's height on every side, counting the file's own transparent margin and the
      // link box around the image, which centres it.
      const clear = {
        x: (box.width - width) / 2 + Math.min(art.left, art.right) * scale,
        y: (box.height - height) / 2 + Math.min(art.top, art.bottom) * scale,
      };
      expect(clear.x, `${lang} clear space across`).toBeGreaterThanOrEqual(px / 4 - 0.5);
      expect(clear.y, `${lang} clear space above and below`).toBeGreaterThanOrEqual(px / 4 - 0.5);
      boxes.add(`${box.width}x${box.height}`);
      checked++;
    }
    expect(checked).toBe(4);
    // One reserved box for all four, so the layout does not move with the language, or when the image is blocked.
    expect([...boxes]).toHaveLength(1);
  });
});

describe("the marketing footer", () => {
  it.each(LOCALES.map((l) => [l]))("%s: one badge, in that language, above the bottom bar, with the trademark line", async (lang) => {
    const html = renderToStaticMarkup(await MarketingFooter({ lang }));
    expect(html.split('data-testid="play-badge"')).toHaveLength(2);
    const { a, src, alt } = badgeParts(html);
    expect(attr(a, "href")).toBe(PLAY_STORE_URL);
    expect(src).toBe(`/badges/google-play-${lang}.png`);
    expect(alt).toBe(DICTS[lang]!["app.playBadge.alt"]);
    const line = DICTS[lang]!["app.playBadge.trademark"]!;
    expect(line).toContain("Seazn Club Mobile App");
    expect(line).toContain("Android");
    expect(line).toContain("Google LLC");
    expect(html).toContain(`>${line.replace(/'/g, "&#x27;")}<`);
    expect(html.indexOf('data-testid="play-badge"')).toBeLessThan(html.indexOf("border-t"));
    expect(html).not.toContain("app.playBadge.");
  });

  it("the English line is the owner's approved copy", () => {
    expect(en["app.playBadge.trademark"]).toBe(
      "Seazn Club Mobile App for Android. Google Play and the Google Play logo are trademarks of Google LLC.",
    );
  });

  it("with no language given (the legal pages), the badge is English", async () => {
    const html = renderToStaticMarkup(await MarketingFooter({}));
    expect(html.split('data-testid="play-badge"')).toHaveLength(2);
    expect(badgeParts(html).src).toBe("/badges/google-play-en.png");
  });
});

describe("the app's name in the stream panel", () => {
  it("is Seazn Club Mobile App beside the pairing code, in every locale", () => {
    let checked = 0;
    for (const d of [uiEn, uiEs, uiFr, uiNl] as Record<string, string>[]) {
      expect(d["stream.code.scan"]).toContain("Seazn Club Mobile App");
      checked++;
    }
    expect(checked).toBe(4);
  });
});
