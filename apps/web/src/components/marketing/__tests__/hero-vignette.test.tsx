import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import offer from "@/lib/quick-match-offer.generated.json";
import { HERO_VIGNETTE_SPORT, HeroVignette } from "../hero-vignette";

const LABEL = "An accessible name the page passes in";

// Node-env render contract; the replay interaction is covered by e2e.
describe("HeroVignette", () => {
  it("renders the scorebug end-state and a replay control", () => {
    const html = renderToStaticMarkup(<HeroVignette label={LABEL} />);
    expect(html).toContain('data-testid="scorebug"');
    expect(html).toContain('aria-label="Replay animation"');
    expect(html).toContain("LIVE");
  });

  // Owner 2026-11-13 (review m6): the hero's one primary is "pick a sport, Start", so its art may only show a sport the
  // quick match offers. Expected values: the probe's own record of what it offers and excludes
  // (lib/quick-match-offer.generated.json), never this component.
  it("draws a sport the quick match offers, and never one it excludes (cricket: the lineup sports)", () => {
    const offered = new Set(offer.offered.map((o) => o.sport_key));
    const excluded = new Set(offer.excluded.map((o) => o.sport_key));
    // Anti-vacuity: an empty record would let any sport through.
    expect(offered.size, "offered sports in the probe's record").toBeGreaterThan(0);
    expect(excluded.size, "excluded sports in the probe's record").toBeGreaterThan(0);
    expect(offered.has(HERO_VIGNETTE_SPORT), HERO_VIGNETTE_SPORT).toBe(true);
    expect(excluded.has(HERO_VIGNETTE_SPORT), HERO_VIGNETTE_SPORT).toBe(false);
    const html = renderToStaticMarkup(<HeroVignette label={LABEL} />);
    expect(html).toContain(`data-sport="${HERO_VIGNETTE_SPORT}"`);
    let swept = 0;
    for (const sport of excluded) {
      expect(html.toLowerCase(), `the art names ${sport}`).not.toContain(sport);
      swept++;
    }
    expect(swept).toBe(excluded.size);
    expect(html).not.toContain("Falcons CC");
  });

  it("scorebug reads as badminton — two players and rally points", () => {
    // 18–16 is the SSR state; the +1 rally point on the shuttle's landing is client behaviour (covered visually), so the
    // static markup pins the base score.
    const html = renderToStaticMarkup(<HeroVignette label={LABEL} />);
    expect(html).toContain("Kim 18–16 Park");
  });

  it("takes its accessible name from the page (dictionary copy), never a hardcoded English one", () => {
    const html = renderToStaticMarkup(<HeroVignette label={LABEL} />);
    expect(html).toMatch(new RegExp(`<svg\\b[^>]*\\brole="img"[^>]*\\baria-label="${LABEL}"`));
    expect(html.match(/\baria-label="/g), "the art's name and the replay's").toHaveLength(2);
  });

  it("keeps a fixed-height box so the hero cannot shift layout", () => {
    const html = renderToStaticMarkup(<HeroVignette label={LABEL} />);
    expect(html).toMatch(/h-64|h-72/);
  });
});
