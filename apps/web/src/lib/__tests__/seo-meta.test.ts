import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { alt as rootOgAlt } from "../../app/opengraph-image";
import { OG_ALT, marketingMeta, ogTitle, pageTitle } from "../seo-meta";
import { LOCALES } from "../i18n-constants";
import { breadcrumbLd, serializeJsonLd } from "../../components/seo/json-ld";

// Real dictionary titles that already carry the brand (the root template would double them).
const BRANDED = [
  "Seazn Club — Run multi-sport community tournaments",
  "Scheduling — Seazn Club",
  "Tournament formats — round robin, knockout | Seazn Club",
];

describe("pageTitle / ogTitle", () => {
  it.each(BRANDED)("a branded title is absolute, so the template cannot double it: %s", (t) => {
    expect(pageTitle(t)).toEqual({ absolute: t });
  });
  it("an unbranded title is left for the template to suffix", () => {
    expect(pageTitle("Pricing")).toBe("Pricing");
  });
  it.each([
    [BRANDED[0]!, "Run multi-sport community tournaments"],
    [BRANDED[1]!, "Scheduling"],
    [BRANDED[2]!, "Tournament formats — round robin, knockout"],
    ["Pricing", "Pricing"],
    ["Seazn Club", "Seazn Club"],
  ])("og title of %j drops the brand", (input, want) => {
    expect(ogTitle(input)).toBe(want);
  });
});

describe("marketingMeta", () => {
  const m = marketingMeta({ lang: "fr", path: "/pricing", title: "Pricing", description: "d" });
  it("canonical is the page's own /{lang} URL, with every locale + x-default", () => {
    expect(m.alternates?.canonical).toBe("/fr/pricing");
    const langs = m.alternates?.languages as Record<string, string>;
    expect(Object.keys(langs).sort()).toEqual([...LOCALES, "x-default"].sort());
    expect(langs["x-default"]).toBe("/en/pricing");
  });
  it("carries its own og title, url and image (a page-level openGraph replaces the root one)", () => {
    expect(m.openGraph).toMatchObject({ title: "Pricing", url: "/fr/pricing", siteName: "Seazn Club" });
    expect((m.openGraph as { images?: unknown[] }).images?.length).toBe(1);
  });
  it("home path is the bare /{lang}", () => {
    expect(marketingMeta({ lang: "en", path: "", title: "T", description: "d" }).alternates?.canonical).toBe("/en");
  });
});

describe("json-ld", () => {
  it("a string value cannot close the script element", () => {
    const out = serializeJsonLd({ name: "</script><script>alert(1)</script>" });
    expect(out).not.toContain("</script>");
    expect(JSON.parse(out).name).toBe("</script><script>alert(1)</script>");
  });
  it("breadcrumb positions run 1..n with absolute urls", () => {
    const b = breadcrumbLd([{ name: "A", path: "/en" }, { name: "B", path: "/en/x" }]) as {
      itemListElement: { position: number; item: string }[];
    };
    expect(b.itemListElement.map((i) => i.position)).toEqual([1, 2]);
    expect(b.itemListElement.every((i) => i.item.startsWith("http"))).toBe(true);
  });
});

describe("every real marketing meta title, in all four locales", () => {
  const titles: [string, string][] = [];
  for (const l of LOCALES) {
    const dict = JSON.parse(readFileSync(join(process.cwd(), `src/dictionaries/${l}/marketing.json`), "utf8")) as Record<string, string>;
    for (const [k, v] of Object.entries(dict)) if (/(\.meta\.title|\.metaTitle)$/.test(k) && !v.includes("{")) titles.push([`${l}:${k}`, v]);
  }
  it("premise: the sweep found titles in every locale", () => {
    expect(titles.length).toBeGreaterThan(LOCALES.length * 5);
  });
  it.each(titles)("%s: absolute iff branded, and the share title never repeats the brand", (_k, title) => {
    const branded = title.includes("Seazn Club");
    expect(typeof pageTitle(title) === "object").toBe(branded);
    if (ogTitle(title) !== title) expect(ogTitle(title)).not.toMatch(/Seazn Club\s*$/);
  });
});

describe("share image", () => {
  it("OG_ALT equals the root opengraph-image alt it stands in for", () => {
    expect(OG_ALT).toBe(rootOgAlt);
    const img = (marketingMeta({ lang: "en", path: "", title: "T", description: "d" }).openGraph as { images: { alt?: string }[] }).images[0]!;
    expect(img.alt).toBe(rootOgAlt);
  });
});

describe("hreflang targets", () => {
  it.each(LOCALES.map((l) => [l]))("the %s alternate points at that locale's own URL", (l) => {
    const langs = marketingMeta({ lang: "en", path: "/sports/cricket", title: "T", description: "d" }).alternates!.languages as Record<string, string>;
    expect(langs[l]).toBe(`/${l}/sports/cricket`);
  });
});
