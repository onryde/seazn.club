// The shared product-page parts (parts.tsx): server-rendered, complete without script. This suite has no DOM, so it
// proves markup and the picture ledger; layout and taps are marketing-product.spec.ts's job.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { PRODUCT_IMAGES, type ProductImageKey } from "@/lib/marketing/product-images";
import { Closing, DemoClub, PageHero, PhoneRow, Questions, Road, SplitBand, Ticket } from "../parts";

const PUBLIC = path.resolve(__dirname, "../../../../../public");

/** Width and height straight from a WebP's VP8/VP8X header, a PNG's IHDR or a JPEG's SOF marker. */
function measure(file: string): { width: number; height: number } {
  const b = fs.readFileSync(file);
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const kind = b.toString("ascii", 12, 16);
    if (kind === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8X") return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
    throw new Error(`unsupported WebP kind ${kind} in ${file}`);
  }
  if (b.toString("ascii", 1, 4) === "PNG") return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  for (let i = 2; i < b.length; ) {
    const marker = b[i + 1]!;
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
    i += 2 + len;
  }
  throw new Error(`unreadable image ${file}`);
}

const KEYS = Object.keys(PRODUCT_IMAGES) as ProductImageKey[];
const phone = KEYS.find((k) => PRODUCT_IMAGES[k].kind === "phone")!;
const web = KEYS.find((k) => PRODUCT_IMAGES[k].kind === "web")!;

describe("product images", () => {
  it("every product image file exists and its recorded size matches the file", () => {
    let checked = 0;
    for (const k of KEYS) {
      const im = PRODUCT_IMAGES[k];
      expect(im.src.startsWith("/marketing/product/"), k).toBe(true);
      // Pictures ship as WebP: the PNG captures were about three times the bytes (owner's Lighthouse bar, 2026-11-16).
      expect(im.src.endsWith(".webp"), k).toBe(true);
      expect(fs.statSync(path.join(PUBLIC, im.src)).size, `${k} is under 120 KB`).toBeLessThan(120 * 1024);
      expect(measure(path.join(PUBLIC, im.src)), k).toEqual({ width: im.width, height: im.height });
      checked++;
    }
    expect(checked).toBe(KEYS.length);
    expect(checked).toBeGreaterThanOrEqual(14);
  });

  it("no PNG capture is left beside its WebP", () => {
    const left = fs.readdirSync(path.join(PUBLIC, "marketing/product")).filter((f) => !f.endsWith(".webp"));
    expect(left).toEqual([]);
  });

  it("premise: the ledger holds both phone and web pictures", () => {
    expect(phone).toBeDefined();
    expect(web).toBeDefined();
  });
});

describe("product page parts", () => {
  const road = (
    <Road
      title="Three steps"
      lede="Each on a real screen"
      steps={[
        { heading: "First", who: "Organiser", body: "a", image: phone, caption: "cap one" },
        { heading: "Second", who: "Scorer", body: "b", image: phone, caption: "cap two" },
        { heading: "Third", who: "Crowd", body: "c", image: phone, caption: "cap three" },
      ]}
    />
  );

  it("every img carries width, height and a real alt", () => {
    const html = renderToStaticMarkup(
      <>
        {road}
        <PhoneRow title="t" lede="l" items={[{ image: phone, heading: "h", body: "b" }]} />
        <SplitBand title="t" lede="l" steps={[{ heading: "h", body: "b" }]} figures={[{ image: phone, caption: "fig" }]} />
        <DemoClub title="t" text="x" image={web} imageAlt="the hub" />
      </>,
    );
    const imgs = html.match(/<img [^>]*>/g) ?? [];
    expect(imgs.length).toBe(6);
    for (const tag of imgs) {
      expect(tag).toMatch(/ width="\d+"/);
      expect(tag).toMatch(/ height="\d+"/);
      expect(tag).toMatch(/ alt="[^"$][^"]*"/);
    }
  });

  it("Road renders its steps in order, numbered from 1", () => {
    const html = renderToStaticMarkup(road);
    const at = ["First", "Second", "Third"].map((h) => html.indexOf(`>${h}</h3>`));
    expect(at.every((n) => n > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(html.match(/class="mkp-n"[^>]*>(\d)</g)?.map((m) => m.slice(-2, -1))).toEqual(["1", "2", "3"]);
  });

  it("DemoClub without href renders no anchor; with href renders exactly one", () => {
    const none = renderToStaticMarkup(<DemoClub title="t" text="x" image={web} imageAlt="a" />);
    expect(none).not.toContain("<a ");
    const one = renderToStaticMarkup(<DemoClub title="t" text="x" image={web} imageAlt="a" href="/live/demo" linkLabel="Open" />);
    expect(one.split("<a ")).toHaveLength(2);
    expect(one).toContain('href="/live/demo"');
  });

  it("Questions renders one details per item with the answer inside it", () => {
    const items = [{ q: "Q1?", a: "A1." }, { q: "Q2?", a: "A2." }, { q: "Q3?", a: "A3." }];
    const html = renderToStaticMarkup(<Questions title="Questions" items={items} />);
    const blocks = html.split("<details").slice(1);
    expect(blocks).toHaveLength(items.length);
    items.forEach((it, i) => {
      expect(blocks[i]).toContain(`${it.q}</summary>`);
      expect(blocks[i]!.split("</details>")[0]).toContain(it.a);
    });
  });

  it("phone pictures sit in the phone frame, web pictures do not", () => {
    const html = renderToStaticMarkup(
      <>
        <PhoneRow title="t" lede="l" items={[{ image: phone, heading: "h", body: "b" }]} />
        <DemoClub title="t" text="x" image={web} imageAlt="a" />
      </>,
    );
    const frames = html.match(/class="mkp-shot[^"]*"/g) ?? [];
    expect(frames).toEqual(['class="mkp-shot mkp-ph"', 'class="mkp-shot"']);
  });

  it("hero, ticket and closing carry their copy and one h1", () => {
    const html = renderToStaticMarkup(
      <>
        <PageHero crumb="Product / X" title="Big line" lede="lede" primary={{ label: "Try", href: "#try" }} secondary={{ label: "Start", href: "/login?tab=signup" }} />
        <Ticket title="T" body="B" kicker="K" heading="H" rows={[{ label: "Length", value: "Up to 5 hours" }]} stub={{ top: "Packs of", big: "1 · 5 · 20", bottom: "x" }} />
        <Closing line="Go" sub="Free" cta={{ label: "Start free", href: "/login?tab=signup" }} pricing={{ label: "See pricing", href: "/pricing" }} />
      </>,
    );
    expect(html.split("<h1")).toHaveLength(2);
    expect(html).toContain("Up to 5 hours");
    // The page ends on its call to action: the nav and the footer already list the other pages, so no third list here.
    const closing = html.slice(html.indexOf('data-section="closing"'));
    expect(closing.match(/<a /g)).toHaveLength(2);
    expect(html).not.toContain("<nav");
  });
});
