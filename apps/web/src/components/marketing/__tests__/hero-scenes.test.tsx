import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { builtinModules } from "@seazn/engine/sports";
import { boardgame } from "@seazn/engine/sports/boardgame";
import { carromPadRules, tennisPadRules } from "@seazn/engine/pad";
import offer from "@/lib/quick-match-offer.generated.json";
import { LOCALES } from "@/lib/i18n-constants";
import { pickVariant } from "@/lib/preferred-variant";
import en from "@/dictionaries/en/marketing.json";
import es from "@/dictionaries/es/marketing.json";
import fr from "@/dictionaries/fr/marketing.json";
import nl from "@/dictionaries/nl/marketing.json";
import {
  HERO_DEFAULT_SCENE,
  HERO_SCENES,
  heroSceneKey,
  heroSceneLabelKey,
  heroScoreText,
  type HeroSceneKey,
} from "../hero-scenes";
import { HeroSceneArt } from "../hero-scene-art";

// The hero's art follows its Sport select (owner 2026-11-13: "when user choose the sport can we show relevant one?"). One
// scene per sport the quick match OFFERS, read off the probe's own record (lib/quick-match-offer.generated.json), never a
// list typed here; cricket stays in code for the day the quick match offers it. Every scorebug speaks its sport's score
// language, judged against the ENGINE's declarations (its default rules for the variant the setup screen opens on, its
// point calls, its chess score shape, its carrom board values), never against hero-scenes.ts itself.

const offeredSports = [...new Set(offer.offered.map((o) => o.sport_key))];
const excludedSports = [...new Set(offer.excluded.map((o) => o.sport_key))];
const DICTS: Record<string, Record<string, string>> = { en, es, fr, nl };

describe("hero scenes: which scene a key opens", () => {
  it("the empty case first: no key, a blank, an unknown or excluded-but-sceneless sport and prototype names all open badminton", () => {
    expect(HERO_DEFAULT_SCENE).toBe("badminton");
    const keys = [undefined, null, "", "   ", "generic", "Badminton", "constructor", "__proto__", "toString", "hasOwnProperty"];
    let checked = 0;
    for (const key of keys) {
      expect(heroSceneKey(key), String(key)).toBe("badminton");
      checked++;
    }
    expect(checked).toBe(keys.length);
  });

  it("every sport the quick match offers opens its OWN scene (swept from the offer record)", () => {
    expect(offeredSports.length, "offered sports in the probe's record").toBeGreaterThan(0);
    const markups = new Map<string, string>();
    for (const sport of offeredSports) {
      expect(heroSceneKey(sport), sport).toBe(sport);
      expect(Object.hasOwn(HERO_SCENES, sport), sport).toBe(true);
      const art = renderToStaticMarkup(
        <svg>
          <HeroSceneArt scene={sport as HeroSceneKey} />
        </svg>,
      );
      // The moving object, the trail it draws and the impact star: the choreography's three parts every scene owes.
      expect(art, `${sport}: the object in flight`).toMatch(/class="mk-ball"/);
      expect(art, `${sport}: its flight trail`).toMatch(/class="mk-trail"/);
      expect(art, `${sport}: the impact`).toMatch(/class="mk-star"/);
      markups.set(sport, art);
    }
    expect(markups.size, "scenes drawn").toBe(offeredSports.length);
    // A scene that is another sport's art under a new key is no scene: every drawing differs from every other.
    expect(new Set(markups.values()).size, "distinct drawings").toBe(offeredSports.length);
  });

  it("cricket stays in code (its scene and label) while the quick match excludes it", () => {
    expect(excludedSports).toContain("cricket");
    expect(heroSceneKey("cricket")).toBe("cricket");
    expect(heroScoreText("cricket", 0)).toBe("Falcons CC 142/3");
    expect(en[heroSceneLabelKey("cricket") as keyof typeof en]).toMatch(/cricket/i);
  });

  it("every scene has an accessible name in each of the four locales, and no two scenes share one", () => {
    const scenes = Object.keys(HERO_SCENES) as HeroSceneKey[];
    expect(Object.keys(DICTS).sort()).toEqual([...LOCALES].sort());
    let checked = 0;
    for (const locale of LOCALES) {
      const dict = DICTS[locale]!;
      const names = scenes.map((scene) => dict[heroSceneLabelKey(scene)]);
      for (const [i, name] of names.entries()) {
        expect(typeof name === "string" && name.trim().length > 0, `${locale} ${scenes[i]}`).toBe(true);
        checked++;
      }
      expect(new Set(names).size, `${locale}: distinct names`).toBe(scenes.length);
    }
    expect(checked).toBe(LOCALES.length * scenes.length);
    expect(checked).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Score language, per sport, against the engine.
// ---------------------------------------------------------------------------------------------------------------------

type Mod = { key: string; configSchema: { parse(v: unknown): unknown }; variants: Record<string, unknown> };
const moduleOf = (sport: string): Mod => {
  const mod = (builtinModules as unknown as Mod[]).find((m) => m.key === sport);
  if (!mod) throw new Error(`no engine module for ${sport}`);
  return mod;
};
/** The rules the setup screen opens on for `sport`: the engine's resolved config of `pickVariant` over the offered
 *  variants, in the order the setup screen lists them (catalog key order, which the record keeps). */
function defaultRules<T>(sport: string): T {
  const variants = offer.offered.filter((o) => o.sport_key === sport).map((o) => ({ key: o.variant_key }));
  const variant = pickVariant(sport, variants);
  expect(variant, `${sport}: a default variant`).not.toBe("");
  const mod = moduleOf(sport);
  return mod.configSchema.parse(mod.variants[variant] ?? {}) as T;
}

const stepsOf = (sport: HeroSceneKey) => HERO_SCENES[sport].score.steps;

/** One rally, one point, to one side: the step after differs by exactly 1 on exactly one side. */
function onePointApart(before: readonly [number, number], after: readonly [number, number]): boolean {
  const dh = after[0] - before[0];
  const da = after[1] - before[1];
  return (dh === 1 && da === 0) || (dh === 0 && da === 1);
}

/** A rally-scored game (BWF 7.3, ITTF 2.11.1, FIVB 6.1.2): won at `setTo` with `winBy` clear, or at the cap. */
function gameOver(score: readonly [number, number], rules: { setTo: number; winBy: number; cap: number | null }): boolean {
  const top = Math.max(...score);
  return (top >= rules.setTo && Math.abs(score[0] - score[1]) >= rules.winBy) || (rules.cap !== null && top >= rules.cap);
}

const checkers: Record<string, (sport: HeroSceneKey) => number> = {
  rally(sport) {
    const rules = defaultRules<{ setTo: number; winBy: number; cap: number | null }>(sport);
    const steps = stepsOf(sport);
    steps.forEach((s, i) => {
      // Every score before the last is a game still being played; the last may be the game point won.
      if (i < steps.length - 1) expect(gameOver(s, rules), `${sport} ${s} is live under ${JSON.stringify(rules)}`).toBe(false);
      if (i > 0) expect(onePointApart(steps[i - 1]!, s), `${sport} step ${i}`).toBe(true);
      expect(heroScoreText(sport, i)).toBe(`${HERO_SCENES[sport].score.names[0]} ${s[0]}–${s[1]} ${HERO_SCENES[sport].score.names[1]}`);
    });
    return steps.length;
  },
  tennis(sport) {
    const calls = tennisPadRules.pointCalls;
    expect(calls.length).toBeGreaterThan(0);
    const steps = stepsOf(sport);
    steps.forEach((s, i) => {
      // A standard game's points are called 0, 15, 30, 40 (ITF Rule 5(a)); four won with two clear ends the game.
      for (const p of s) expect(p >= 0 && p < calls.length, `${sport} ${s}`).toBe(true);
      if (i > 0) expect(onePointApart(steps[i - 1]!, s), `${sport} step ${i}`).toBe(true);
      expect(heroScoreText(sport, i)).toBe(`${HERO_SCENES[sport].score.names[0]} ${calls[s[0]]}–${calls[s[1]]} ${HERO_SCENES[sport].score.names[1]}`);
    });
    return steps.length;
  },
  goals(sport) {
    const steps = stepsOf(sport);
    steps.forEach((s, i) => {
      for (const g of s) expect(Number.isInteger(g) && g >= 0, `${sport} ${s}`).toBe(true);
      // Each play is one goal.
      if (i > 0) expect(onePointApart(steps[i - 1]!, s), `${sport} step ${i}`).toBe(true);
      expect(heroScoreText(sport, i)).toBe(`${HERO_SCENES[sport].score.names[0]} ${s[0]}–${s[1]} ${HERO_SCENES[sport].score.names[1]}`);
    });
    return steps.length;
  },
  chess(sport) {
    // The engine's own chess score shape (CHESS_SCORE, via the tie-break event's schema) and its points per game.
    const tiebreak = (boardgame.eventSchemas as Record<string, { safeParse(v: unknown): { success: boolean } }>)["boardgame.tiebreak"]!;
    const { scoring } = defaultRules<{ scoring: { win: number; draw: number; loss: number } }>(sport);
    const games = [
      [scoring.win, scoring.loss],
      [scoring.draw, scoring.draw],
      [scoring.loss, scoring.win],
    ].map(([h, a]) => `${h},${a}`);
    const steps = stepsOf(sport);
    steps.forEach((s, i) => {
      const text = heroScoreText(sport, i);
      const [home, away = ""] = HERO_SCENES[sport].score.names;
      const score = text.slice(home.length + 1, -(away.length + 1));
      expect(tiebreak.safeParse({ rung: "rapid", winner: "H", score }).success, `${sport} "${score}"`).toBe(true);
      if (i > 0) expect(games, `${sport} step ${i}: one game's points`).toContain(`${s[0] - steps[i - 1]![0]},${s[1] - steps[i - 1]![1]}`);
    });
    return steps.length;
  },
  carrom(sport) {
    const rules = defaultRules<{ gameTo: number; queenPoints: number; queenCapAt: number; pointsPerCoin: number }>(sport);
    const coins = carromPadRules.opponentCoinsMax;
    const steps = stepsOf(sport);
    steps.forEach((s, i) => {
      if (i < steps.length - 1) expect(Math.max(...s), `${sport} ${s}: game still on`).toBeLessThan(rules.gameTo);
      if (i > 0) {
        const prev = steps[i - 1]!;
        const side = s[0] !== prev[0] ? 0 : 1;
        expect(s[1 - side], `${sport} step ${i}: one board, one winner`).toBe(prev[1 - side]);
        // A board scores the opponent's coins left, plus the queen while the winner is below the cap (ICF 52(b), 54).
        const board = s[side]! - prev[side]!;
        const most = coins * rules.pointsPerCoin + (prev[side]! < rules.queenCapAt ? rules.queenPoints : 0);
        expect(board >= 1 && board <= most, `${sport} step ${i}: a board of ${board} (at most ${most})`).toBe(true);
      }
      expect(heroScoreText(sport, i)).toBe(`${HERO_SCENES[sport].score.names[0]} ${s[0]}–${s[1]} ${HERO_SCENES[sport].score.names[1]}`);
    });
    return steps.length;
  },
};

describe("hero scenes: each scorebug speaks its sport's score language (the engine's declarations)", () => {
  it("every offered sport's scorebug is checked against its engine rules, and each advances on a landing", () => {
    let sports = 0;
    let steps = 0;
    for (const sport of offeredSports as HeroSceneKey[]) {
      const kind = HERO_SCENES[sport].score.kind;
      const check = checkers[kind];
      expect(check, `${sport}: a checker for "${kind}"`).toBeDefined();
      const n = check!(sport);
      // Three plays on load, each landing moves the score: four frames at least.
      expect(n, `${sport} steps`).toBeGreaterThanOrEqual(4);
      steps += n;
      sports++;
    }
    expect(sports, "sports checked").toBe(offeredSports.length);
    expect(steps).toBeGreaterThan(0);
  });

  it("the score holds at its last frame past the plays (a replay past it adds nothing), and never reads a negative frame", () => {
    let checked = 0;
    for (const sport of Object.keys(HERO_SCENES) as HeroSceneKey[]) {
      const last = stepsOf(sport).length - 1;
      expect(heroScoreText(sport, last + 5), sport).toBe(heroScoreText(sport, last));
      expect(heroScoreText(sport, -1), sport).toBe(heroScoreText(sport, 0));
      expect(heroScoreText(sport, 1), `${sport}: the first landing moves it`).not.toBe(heroScoreText(sport, 0));
      checked++;
    }
    expect(checked).toBe(Object.keys(HERO_SCENES).length);
  });

});
