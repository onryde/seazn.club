import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import offer from "@/lib/quick-match-offer.generated.json";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { REDUCED_MOTION_QUERY } from "@/components/ui/use-prefers-reduced-motion";
import { HERO_SCENES, HERO_SPORT_SELECT_ID, heroScoreText, type HeroSceneKey } from "../hero-scenes";
import { HeroVignette } from "../hero-vignette";
import { QuickMatchCta } from "../quick-match-cta";

// The hero's art follows the hero's Sport select (owner 2026-11-13). The seam is the select ITSELF: the server renders a
// plain <select> (the form must work with no script), and the art reads its value and its `change` events. These tests
// drive the vignette's real subscription against a select-shaped element the stubbed document hands out by the id the
// quick match form really renders (pinned below from QuickMatchCta's own markup); marketing-home.spec.ts drives the same
// seam in a browser. vitest runs `environment: "node"`: there is no layout, no paint and no CSS animation here, so the
// motion itself is judged by the choreography's own declarations in globals.css and by the screenshots.

const SCENES = Object.keys(HERO_SCENES) as HeroSceneKey[];
/** One name per scene, each different, so a label that follows the wrong scene reads as a red. */
const LABELS = Object.fromEntries(SCENES.map((s) => [s, `name of the ${s} scene`])) as Record<HeroSceneKey, string>;
const offeredSports = [...new Set(offer.offered.map((o) => o.sport_key))] as HeroSceneKey[];

/** The choreography's landing, read off globals.css (the fly starts at its delay and lasts its duration), never off the
 *  component. */
const CSS = readFileSync(new URL("../../../app/globals.css", import.meta.url), "utf8");
const fly = CSS.match(/mk-ball-fly\s+([\d.]+)s\s+([\d.]+)s/);
const LANDING_MS = Math.round((Number(fly?.[1]) + Number(fly?.[2])) * 1000);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A select as the browser hands it out: a value, and `change` listeners a choice fires. */
function fakeSelect(value: string) {
  const listeners = new Set<() => void>();
  return {
    value,
    addEventListener(type: string, fn: () => void) {
      if (type === "change") listeners.add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      if (type === "change") listeners.delete(fn);
    },
    /** The visitor picks `next`: the value moves, then the browser fires `change` (a snapshot: a listener may unsubscribe). */
    choose(next: string) {
      this.value = next;
      for (const fn of [...listeners]) fn();
    },
    get listening() {
      return listeners.size;
    },
  };
}

function browser({ select, reduce = false }: { select: ReturnType<typeof fakeSelect> | null; reduce?: boolean }) {
  vi.stubGlobal("document", { getElementById: (id: string) => (id === HERO_SPORT_SELECT_ID ? select : null) });
  vi.stubGlobal("window", {
    matchMedia: (q: string) => ({ matches: reduce && q === REDUCED_MOTION_QUERY, addEventListener() {}, removeEventListener() {} }),
  });
}

const mount = (sport: string | undefined) =>
  renderIsland(HeroVignette, { sport, labels: LABELS }, undefined, { hydrate: true });

type Tree = ReactElement[];
const byTestId = (tree: Tree, id: string) => tree.filter((el) => propsOf(el)["data-testid"] === id);
function read(tree: Tree) {
  const art = tree.filter((el) => propsOf(el)["data-sport"] !== undefined);
  expect(art, "one illustration").toHaveLength(1);
  const runs = byTestId(tree, "vignette-run");
  expect(runs, "one play").toHaveLength(1);
  const svg = tree.filter((el) => el.type === "svg");
  expect(svg).toHaveLength(1);
  const chip = byTestId(tree, "scorebug");
  expect(chip).toHaveLength(1);
  return {
    scene: propsOf(art[0]!)["data-sport"],
    play: runs[0]!.key,
    label: propsOf(svg[0]!)["aria-label"],
    score: textOf(chip[0]!).replace(/\s+/g, " ").replace(/^LIVE /, "").trim(),
  };
}

describe("HeroVignette follows the hero's Sport select", () => {
  it("the id it listens on is the one the quick match form renders on its Sport select", () => {
    const html = renderToStaticMarkup(
      <QuickMatchCta
        lang="en"
        sports={[
          { sport_key: "badminton", name: "Badminton" },
          { sport_key: "tennis", name: "Tennis" },
        ]}
        copy={{ sport: "Sport", start: "Start", hint: "Hint" }}
      />,
    );
    const select = html.match(/<select\b[^>]*>/)?.[0];
    expect(select, "the Sport select").toBeDefined();
    expect(select).toContain(`id="${HERO_SPORT_SELECT_ID}"`);
    expect(select).toContain('name="sport"');
    // Exactly one element carries it: the art must find the select, not a namesake.
    expect(html.split(`id="${HERO_SPORT_SELECT_ID}"`)).toHaveLength(2);
  });

  it("a change swaps the scene at once, names it, replays it, and starts that sport's score from its first frame", () => {
    const select = fakeSelect("badminton");
    browser({ select });
    const island = mount("badminton");
    const before = read(island.tree());
    expect(before.scene).toBe("badminton");
    expect(select.listening, "subscribed once").toBe(1);
    let swept = 0;
    let last = before;
    // Every offered sport, picked in turn (the offer record's order, never a list typed here), then back to the first.
    for (const sport of [...offeredSports.filter((s) => s !== "badminton"), "badminton" as const]) {
      select.choose(sport);
      const now = read(island.tree());
      expect(now.scene, sport).toBe(sport);
      expect(now.label, sport).toBe(LABELS[sport]);
      expect(now.score, sport).toBe(heroScoreText(sport, 0));
      expect(now.play, `${sport}: a new play (the animation restarts)`).not.toBe(last.play);
      last = now;
      swept++;
    }
    expect(swept).toBe(offeredSports.length);
    expect(select.listening, "still one listener after every change").toBe(1);
    island.unmount();
    expect(select.listening, "unsubscribed on unmount").toBe(0);
  });

  it("a second change to the same sport is no new play; an unknown or blank value falls back to badminton", () => {
    const select = fakeSelect("badminton");
    browser({ select });
    const island = mount("badminton");
    select.choose("tennis");
    const tennis = read(island.tree());
    select.choose("tennis");
    expect(read(island.tree()).play, "same sport, same play").toBe(tennis.play);
    select.choose("generic");
    expect(read(island.tree()).scene).toBe("badminton");
    select.choose("");
    expect(read(island.tree()).scene).toBe("badminton");
  });

  it("a sport the browser restored into the select (back navigation) shows once hydrated, though the server drew the prop's", () => {
    const select = fakeSelect("football");
    browser({ select });
    const island = mount("badminton");
    expect(read(island.tree()).scene).toBe("football");
    expect(read(island.tree()).label).toBe(LABELS.football);
  });

  it("the empty offer: no select on the page, so the art keeps the server's scene, subscribes to nothing and does not throw", () => {
    browser({ select: null });
    expect(read(mount("tennis").tree()).scene).toBe("tennis");
    browser({ select: null });
    expect(read(mount(undefined).tree()).scene, "no sport at all: badminton").toBe("badminton");
  });
});

describe("HeroVignette plays: three plays on load, a landing moves the score, the replay plays again", () => {
  it(`the choreography lands at ${LANDING_MS}ms (globals.css) and the score moves only then; three plays, then it rests`, () => {
    expect(LANDING_MS, "read off globals.css").toBeGreaterThan(0);
    vi.useFakeTimers();
    browser({ select: fakeSelect("badminton") });
    const island = mount("badminton");
    const frames = HERO_SCENES.badminton.score.steps.length;
    expect(read(island.tree()).score).toBe(heroScoreText("badminton", 0));
    vi.advanceTimersByTime(LANDING_MS - 1);
    expect(read(island.tree()).score, "not before the landing").toBe(heroScoreText("badminton", 0));
    vi.advanceTimersByTime(1);
    expect(read(island.tree()).score, "the first landing").toBe(heroScoreText("badminton", 1));
    const plays = new Set([read(island.tree()).play]);
    // Run the auto plays out, long past three.
    for (let i = 0; i < 40; i++) {
      vi.advanceTimersByTime(500);
      plays.add(read(island.tree()).play);
    }
    expect(plays.size, "three plays on load").toBe(3);
    expect(read(island.tree()).score, "three landings").toBe(heroScoreText("badminton", 3));
    expect(vi.getTimerCount(), "at rest: nothing scheduled").toBe(0);
    // The replay: a second (and third) call plays again, and the score holds at its last frame past the plays.
    const replay = () => island.tree().find((el) => el.type === "button" && propsOf(el)["aria-label"] === "Replay animation");
    expect(replay()).toBeDefined();
    for (let i = 0; i < 3; i++) {
      const was = read(island.tree()).play;
      (propsOf(replay()!).onClick as () => void)();
      expect(read(island.tree()).play, "replay is a new play").not.toBe(was);
      vi.advanceTimersByTime(LANDING_MS);
    }
    expect(read(island.tree()).score).toBe(heroScoreText("badminton", frames - 1));
  });

  it("a change mid-play replays the NEW sport from its first frame, and only its own landing moves its score", () => {
    vi.useFakeTimers();
    const select = fakeSelect("badminton");
    browser({ select });
    const island = mount("badminton");
    vi.advanceTimersByTime(LANDING_MS + 300);
    expect(read(island.tree()).score).toBe(heroScoreText("badminton", 1));
    select.choose("tennis");
    expect(read(island.tree()).score, "tennis starts at its first frame").toBe(heroScoreText("tennis", 0));
    vi.advanceTimersByTime(LANDING_MS - 1);
    expect(read(island.tree()).score, "no earlier timer lands on tennis").toBe(heroScoreText("tennis", 0));
    vi.advanceTimersByTime(1);
    expect(read(island.tree()).score).toBe(heroScoreText("tennis", 1));
  });
});

describe("HeroVignette under prefers-reduced-motion: the final frame, no motion", () => {
  it("shows each scene's landed frame at once, schedules nothing, and a change shows the new sport's landed frame", () => {
    vi.useFakeTimers();
    const select = fakeSelect("badminton");
    browser({ select, reduce: true });
    const island = mount("badminton");
    expect(read(island.tree()).score).toBe(heroScoreText("badminton", 1));
    expect(vi.getTimerCount(), "no play is scheduled").toBe(0);
    const play = read(island.tree()).play;
    vi.advanceTimersByTime(20_000);
    expect(read(island.tree()).play, "no auto play").toBe(play);
    select.choose("carrom");
    expect(read(island.tree()).scene).toBe("carrom");
    expect(read(island.tree()).score).toBe(heroScoreText("carrom", 1));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the CSS: every part the vignette animates stops under reduced motion, the object rests where it lands, the trail is drawn", () => {
    const vignette = CSS.slice(CSS.indexOf("/* Hero vignette choreography"), CSS.indexOf("/* LIVE ticker marquee"));
    const cut = vignette.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(cut, "the vignette's reduced-motion block").toBeGreaterThan(0);
    const reduced = vignette.slice(cut);
    const animated = new Set(
      [...vignette.slice(0, cut).matchAll(/\.mk-vignette \.(mk-[a-z-]+)\s*\{[^}]*\banimation:/g)].map((m) => m[1]!),
    );
    expect(animated.size, "animated parts found").toBeGreaterThanOrEqual(5);
    let stopped = 0;
    for (const part of animated) {
      const rule = reduced.match(new RegExp(`\\.mk-vignette \\.${part}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
      expect(rule, `${part} under reduced motion`).toMatch(/\banimation:\s*none/);
      stopped++;
    }
    expect(stopped).toBe(animated.size);
    expect(reduced.match(/\.mk-vignette \.mk-ball\s*\{([^}]*)\}/)?.[1]).toMatch(/translate\(var\(--mk-land\)\)/);
    expect(reduced.match(/\.mk-vignette \.mk-trail\s*\{([^}]*)\}/)?.[1]).toMatch(/stroke-dashoffset:\s*0/);
  });
});

describe("HeroVignette's server render (also the no-JS page)", () => {
  it("renders the scorebug, the replay control and LIVE", () => {
    const html = renderToStaticMarkup(<HeroVignette sport="badminton" labels={LABELS} />);
    expect(html).toContain('data-testid="scorebug"');
    expect(html).toContain('aria-label="Replay animation"');
    expect(html).toContain("LIVE");
  });

  it("draws the scene the page names (the select's opening sport), with its name and first score; unknown or none is badminton", () => {
    let checked = 0;
    for (const sport of [...offeredSports, "cricket" as const]) {
      const html = renderToStaticMarkup(<HeroVignette sport={sport} labels={LABELS} />);
      expect(html, sport).toContain(`data-sport="${sport}"`);
      expect(html).toMatch(new RegExp(`<svg\\b[^>]*\\brole="img"[^>]*\\baria-label="${LABELS[sport]}"`));
      expect(html).toContain(heroScoreText(sport, 0));
      checked++;
    }
    expect(checked).toBe(offeredSports.length + 1);
    for (const sport of [undefined, "generic", "constructor"]) {
      expect(renderToStaticMarkup(<HeroVignette sport={sport} labels={LABELS} />), String(sport)).toContain('data-sport="badminton"');
    }
  });

  it("takes every name from the page (dictionary copy): the art's and the replay's are the only two", () => {
    const html = renderToStaticMarkup(<HeroVignette sport="tennis" labels={LABELS} />);
    expect(html.match(/\baria-label="/g)).toHaveLength(2);
  });

  it("keeps a reserved box (fixed heights per width) so the hero cannot shift layout when a scene swaps", () => {
    const html = renderToStaticMarkup(<HeroVignette sport="badminton" labels={LABELS} />);
    const box = html.match(/<div\b[^>]*\bdata-sport="badminton"[^>]*>/)?.[0] ?? "";
    expect(box).toMatch(/\bh-64\b/);
    expect(box).toMatch(/\bsm:h-96\b/);
    expect(box).toMatch(/\blg:h-\[27rem\]/);
  });

  it("every scene sets its whole geometry inline (the choreography's custom properties), so no scene inherits another's flight", () => {
    let checked = 0;
    for (const sport of SCENES) {
      const html = renderToStaticMarkup(<HeroVignette sport={sport} labels={LABELS} />);
      const style = html.match(/<div\b[^>]*\bdata-testid="vignette-run"[^>]*\bstyle="([^"]*)"/)?.[1] ?? "";
      for (const prop of ["--mk-rest", "--mk-toss", "--mk-hit", "--mk-f1", "--mk-f2", "--mk-f3", "--mk-land", "--mk-lift", "--mk-land-scale", "--mk-star-at"]) {
        expect(style, `${sport} ${prop}`).toContain(`${prop}:`);
      }
      checked++;
    }
    expect(checked).toBe(SCENES.length);
  });
});
