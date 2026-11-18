// The corner brand badge (owner, 2026-11-17): the Seazn Club logo and "Powered by" in the canvas's bottom-right
// corner, with a small match timer — on every template and every scene.
//
// `environment: "node"`: this proves the declared geometry, the wiring through the REAL stage, and the copy in four
// locales. The paint is the browser pass's to sign off.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { OverlayStage, type OverlayStageProps } from "../overlay-stage";
import { BRAND_BADGE_BOX, CARD_CLEARANCE_PX, CARD_INSET, OVERLAY_TEMPLATES, cardRegionFor, type CanvasBox } from "../template-registry";
import { OVERLAY_SCENES } from "../overlay-scenes";
import { CLOCK_SPORT_KEYS } from "../use-match-elapsed";
import { builtinModules } from "@seazn/engine/sports";
import { decidedOutcomeTemplates } from "@/lib/scoring-vocab";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";

const HERE = dirname(fileURLToPath(import.meta.url));
const DICT = join(HERE, "../../../dictionaries");
const LOCALES = ["en", "fr", "es", "nl"] as const;
const dictOf = (locale: string): Record<string, string> => JSON.parse(readFileSync(join(DICT, locale, "public.json"), "utf8"));

const START = Date.parse("2026-11-17T10:00:00.000Z");
const NOW = START + (12 * 60 + 34) * 1000;

const live = (over: Partial<OverlayLiveData> = {}): OverlayLiveData => ({
  status: "in_play",
  summary: null,
  outcome: null,
  lastSeq: 3,
  venueTz: "Europe/London",
  matchStartedAtMs: START,
  ...over,
});

function props(over: Partial<OverlayStageProps>): OverlayStageProps {
  return {
    fixtureId: "f1",
    initial: live(),
    realtime: false,
    sportKey: "badminton",
    style: "bug",
    sides: [
      { id: "home", name: "Dev Patel" },
      { id: "away", name: "Arjun Mehta" },
    ],
    startLabel: "Sat 14:30 BST",
    dict: dictOf("en"),
    decidedTemplates: decidedOutcomeTemplates((k) => k),
    ...over,
  };
}

const badgeOf = (html: string): string => {
  const at = html.indexOf('data-testid="ovl-badge"');
  if (at < 0) throw new Error(`no brand badge in:\n${html.slice(0, 600)}`);
  // The badge is one flat element: its markup ends at the first closing div after it.
  return html.slice(at, html.indexOf("</div>", at));
};
const timerOf = (html: string): string | null => badgeOf(html).match(/data-testid="ovl-badge-timer"[^>]*>([^<]*)</)?.[1] ?? null;

const right = (b: CanvasBox) => b.x + b.width;
const bottom = (b: CanvasBox) => b.y + b.height;
/** The gap between two boxes: 0 or less means they touch or overlap. */
const gap = (a: CanvasBox, b: CanvasBox): number =>
  Math.max(b.x - right(a), a.x - right(b), b.y - bottom(a), a.y - bottom(b));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("BRAND_BADGE_BOX — declared geometry", () => {
  it("sits inside the canvas, in the bottom-right corner", () => {
    expect(BRAND_BADGE_BOX.x).toBeGreaterThanOrEqual(0);
    expect(right(BRAND_BADGE_BOX)).toBe(1920 - CARD_INSET.right);
    expect(bottom(BRAND_BADGE_BOX)).toBeLessThanOrEqual(1080);
    expect(BRAND_BADGE_BOX.x).toBeGreaterThan(1920 / 2);
    expect(BRAND_BADGE_BOX.y).toBeGreaterThan(1080 / 2);
  });

  it("lies wholly in the canvas's bottom inset, which no card region reaches — for every template", () => {
    let checked = 0;
    for (const def of Object.values(OVERLAY_TEMPLATES)) {
      const region = cardRegionFor(def.sceneCardSafeArea);
      expect(region, `${def.id} has a card region`).not.toBeNull();
      expect(gap(BRAND_BADGE_BOX, region!), `${def.id} card region`).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBe(Object.keys(OVERLAY_TEMPLATES).length);
    expect(checked).toBeGreaterThan(0);
    expect(BRAND_BADGE_BOX.y).toBeGreaterThan(1080 - CARD_INSET.bottom);
  });

  it("keeps the card clearance from every template's scorebug box and both of its sponsor slots", () => {
    let checked = 0;
    for (const def of Object.values(OVERLAY_TEMPLATES)) {
      for (const [name, box] of [
        ["scorebug", def.sceneCardSafeArea],
        ["lower third", def.sponsorSlots.lower_third],
        ["banner", def.sponsorSlots.banner],
      ] as const) {
        expect(gap(BRAND_BADGE_BOX, box), `${def.id} ${name}`).toBeGreaterThanOrEqual(CARD_CLEARANCE_PX);
        checked++;
      }
    }
    expect(checked).toBe(Object.keys(OVERLAY_TEMPLATES).length * 3);
  });
});

describe("the stage mounts the badge", () => {
  it("on both templates, at the declared box, with the logo and the Powered-by line", () => {
    for (const style of ["bar", "bug"] as const) {
      const badge = badgeOf(renderToStaticMarkup(<OverlayStage {...props({ style })} />));
      expect(badge, style).toContain(`left:${BRAND_BADGE_BOX.x}px`);
      expect(badge, style).toContain(`top:${BRAND_BADGE_BOX.y}px`);
      expect(badge, style).toContain(`width:${BRAND_BADGE_BOX.width}px`);
      expect(badge, style).toContain(`height:${BRAND_BADGE_BOX.height}px`);
      expect(badge, style).toContain('alt="Seazn Club"');
      expect(badge, style).toContain(dictOf("en")["overlay.poweredBy"]);
    }
  });

  it("on every scene the compositor can put up", () => {
    let checked = 0;
    for (const scene of OVERLAY_SCENES) {
      const html = renderToStaticMarkup(<OverlayStage {...props({ sceneOverride: scene.id })} />);
      expect(html, scene.id).toContain('data-testid="ovl-badge"');
      checked++;
    }
    expect(checked).toBe(OVERLAY_SCENES.length);
    expect(checked).toBeGreaterThan(0);
  });

  it.each(LOCALES)("%s: the Powered-by line is that locale's own", (locale) => {
    const words = dictOf(locale)["overlay.poweredBy"];
    expect(words, "declared").toBeTruthy();
    expect(badgeOf(renderToStaticMarkup(<OverlayStage {...props({ dict: dictOf(locale) })} />))).toContain(words!);
  });

  it("the locales do not all share the English words", () => {
    const all = new Set(LOCALES.map((l) => dictOf(l)["overlay.poweredBy"]));
    expect(all.size).toBeGreaterThan(1);
  });
});

describe("the badge's match timer", () => {
  it("reads the time since the match started — 12:34 here, off matchStartedAtMs and nothing else", () => {
    expect(timerOf(renderToStaticMarkup(<OverlayStage {...props({})} />))).toBe("12:34");
    // A different start gives a different reading: the timer is not a constant.
    const later = renderToStaticMarkup(<OverlayStage {...props({ initial: live({ matchStartedAtMs: START + 60_000 }) })} />);
    expect(timerOf(later)).toBe("11:34");
  });

  it("shows no timer before the match starts, once it is over, or without a start — the badge itself stays", () => {
    for (const initial of [
      live({ status: "scheduled", matchStartedAtMs: undefined }),
      live({ status: "decided" }),
      live({ status: "finalized" }),
      live({ matchStartedAtMs: undefined }),
    ]) {
      const html = renderToStaticMarkup(<OverlayStage {...props({ initial })} />);
      expect(html, initial.status).toContain('data-testid="ovl-badge"');
      expect(timerOf(html), initial.status).toBeNull();
    }
  });

  it("a sport whose scorebug carries its own clock gets no second timer", () => {
    const football = live({
      clock: { phase: "H1", anchorSeconds: 300, anchorAtWallMs: NOW - 5000, nominalSeconds: 2700, running: true },
    });
    const html = renderToStaticMarkup(<OverlayStage {...props({ sportKey: "football", initial: football })} />);
    expect(html).toContain('data-testid="ovl-badge"');
    expect(timerOf(html)).toBeNull();
  });

  // Owner, 2026-11-17: before the scorer starts the match clock a football scorebug has no clock yet — and a badge
  // timer shown then would vanish the moment the clock starts. A clock sport never gets the badge timer.
  it.each([...CLOCK_SPORT_KEYS])("%s: no badge timer even while its own clock is not on air yet", (sportKey) => {
    const html = renderToStaticMarkup(<OverlayStage {...props({ sportKey, initial: live() })} />);
    expect(html).toContain('data-testid="ovl-badge"');
    expect(timerOf(html)).toBeNull();
  });

  it("CLOCK_SPORT_KEYS is exactly the engine's modules that declare a clock event", () => {
    const declared = builtinModules
      .filter((m) => (m.eventSchemas as Record<string, unknown> | undefined)?.[`${m.key}.clock`] !== undefined)
      .map((m) => m.key)
      .sort();
    expect(declared.length).toBeGreaterThan(0);
    expect([...CLOCK_SPORT_KEYS].sort()).toEqual(declared);
  });
});

describe("the badge's plates are a proven contrast pair", () => {
  // The badge sits over arbitrary video. Its text is ink 75 %; `overlay-tokens.ts` proves that on the sport's board
  // (`ink75-on-board`) for every sport — which holds only while the plate IS the board, opaque.
  const css = readFileSync(join(HERE, "../../../app/globals.css"), "utf8");
  const rule = (selector: string): string => {
    const at = css.indexOf(`\n${selector} {`);
    if (at < 0) throw new Error(`globals.css declares no ${selector} rule`);
    return css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  };
  it.each([".ovl-badge-plate", ".ovl-badge-timer"])("%s is the solid board", (selector) => {
    const body = rule(selector);
    expect(body).toContain("background: var(--sport-board);");
    expect(body).not.toMatch(/background:[^;]*(transparent|rgba|color-mix)/);
  });
  it.each([".ovl-badge-by", ".ovl-badge-timer"])("%s is ink at 75 %%", (selector) => {
    expect(rule(selector)).toContain("color: color-mix(in srgb, var(--sport-ink) 75%, transparent)");
  });
});
