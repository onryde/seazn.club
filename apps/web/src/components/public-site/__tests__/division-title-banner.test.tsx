// W4 B2a (X-CH-1, X-CH-3; R24 pick 3A) — the division page's title banner. Differential: the pre-W4 banner took ONE
// champion id, so a joint or vacant title rendered nothing. Every word is the locale's own dictionary value.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import type { Dict } from "@/lib/i18n-constants";
import type { DivisionTitle } from "@/server/public-site/champion";
import { DivisionTitleBanner } from "../division-title-banner";

const DICTS = { en, es, fr, nl } as unknown as Record<string, Dict>;
const NAMES: Record<string, string> = { a: "Maya Kapoor", b: "Leo Ng" };
const render = (title: DivisionTitle | null, locale = "en") =>
  renderToStaticMarkup(<DivisionTitleBanner title={title} nameOf={(id) => NAMES[id] ?? "—"} dict={DICTS[locale]!} />);
const word = (locale: string, key: string) => (DICTS[locale] as unknown as Record<string, string>)[key]!;
const TROPHY = "🏆";

describe("DivisionTitleBanner", () => {
  it("EMPTY: no title → nothing at all", () => {
    expect(render(null)).toBe("");
  });

  it("champion: the name, the Champion label, one trophy", () => {
    const h = render({ kind: "champion", champion: "a" });
    expect(h).toContain('data-testid="division-title-champion"');
    expect(h).toContain(">Champion<");
    expect(h).toContain(">Maya Kapoor<");
    expect(h.split(TROPHY).length - 1).toBe(1);
  });

  it("joint: both names, the Joint winners label, ONE trophy, wrapping not truncating", () => {
    const h = render({ kind: "joint", winners: ["a", "b"] });
    expect(h).toContain('data-testid="division-title-joint"');
    expect(h).toContain(">Joint winners<");
    expect(h).toContain(">Maya Kapoor and Leo Ng<");
    expect(h).not.toContain(">Champion<");
    expect(h.split(TROPHY).length - 1).toBe(1);
    expect(h).toContain("break-words");
    expect(h).not.toContain("truncate");
  });

  it("vacant: a muted 'Title vacant' with the reason — no trophy, no names", () => {
    const h = render({ kind: "vacant" });
    expect(h).toContain('data-testid="division-title-vacant"');
    expect(h).toContain(">Title vacant<");
    expect(h).toContain(">Both finalists withdrew<");
    expect(h).not.toContain(TROPHY);
    expect(h).not.toContain("Maya Kapoor");
    expect(h).toContain("text-court-muted");
  });

  it("every title in every locale reads that locale's own words", () => {
    let checked = 0;
    for (const locale of Object.keys(DICTS)) {
      const joint = render({ kind: "joint", winners: ["a", "b"] }, locale);
      expect(joint, locale).toContain(`>${word(locale, "title.joint")}<`);
      expect(joint, locale).toContain(`>${word(locale, "title.jointNames").replace("{a}", "Maya Kapoor").replace("{b}", "Leo Ng")}<`);
      const vacant = render({ kind: "vacant" }, locale);
      expect(vacant, locale).toContain(`>${word(locale, "title.vacant")}<`);
      expect(vacant, locale).toContain(`>${word(locale, "title.vacantReason")}<`);
      checked++;
    }
    expect(checked).toBe(4);
    // The four translations are four different strings (a copied English value would pass the loop above).
    expect(new Set(Object.keys(DICTS).map((l) => word(l, "title.vacant"))).size).toBe(4);
  });
});
