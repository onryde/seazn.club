// S2-7 (TN-TS-1, engine 8.0.0) — the public match centre's timeline for `tennis.toss`.
//
// Two facts: the toss is a line of its own that names the side the toss chose (its entrant id rides `serving`, the one
// payload field `SIDE_FIELDS` did not read before), and the derived game rungs ("holds" / "breaks") follow the toss,
// because they are read off the fold's own `serving`. The second is stated as a DIFFERENTIAL: the same four points read
// as a break with no toss and a hold after a toss for away, so a build that ignored the toss could not pass both.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EngineError, type EventEnvelope } from "@seazn/engine/core";
import { registry, resolvePositions } from "@seazn/engine/sport";
import { registerBuiltins } from "@seazn/engine/sports";
import { defaultLineupPair } from "@seazn/engine/testkit";
import type { PersonT, SideT } from "../match-centre-schema";
import { TIMELINE_GAME_BROKEN_KEY, TIMELINE_GAME_HELD_KEY, buildTimeline } from "../timeline";

try {
  registerBuiltins(registry);
} catch (err) {
  if (!EngineError.is(err, "MODULE_DUPLICATE")) throw err;
}

const DICT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../dictionaries");
const SIDES: [SideT, SideT] = [
  { entrantId: "H", name: "Harbour Rovers", short: "HAR", colour: null, badgeUrl: null },
  { entrantId: "A", name: "Avenue Athletic", short: "AVE", colour: null, badgeUrl: null },
];
const personOf = (personId: string): PersonT => ({ personId, name: `Player ${personId}`, masked: false });

function env(seq: number, type: string, payload: unknown): EventEnvelope {
  return {
    id: `e-${seq}`,
    fixtureId: "fx-toss",
    seq,
    type,
    payload,
    recordedAt: `2026-11-12T12:${String(seq).padStart(2, "0")}:00.000Z`,
    recordedBy: null,
  };
}

function lines(types: [string, unknown][]) {
  const mod = registry.latest("tennis");
  const cfg = mod.configSchema.parse({});
  return buildTimeline({
    sportKey: "tennis",
    events: types.map(([type, payload], i) => env(i, type, payload)),
    module: mod,
    cfg,
    lineups: defaultLineupPair(resolvePositions(mod, cfg)),
    sides: SIDES,
    personOf,
  }).lines;
}

const fourPointsTo = (by: string): [string, unknown][] => Array.from({ length: 4 }, () => ["tennis.point", { by }]);

describe("public timeline — tennis.toss", () => {
  it("the toss is its own line, naming the side it chose", () => {
    for (const [serving, index, name] of [["A", 1, "Avenue Athletic"], ["H", 0, "Harbour Rovers"]] as const) {
      const toss = lines([["tennis.toss", { serving }]]).filter((l) => l.text.key === "timeline.tennis.toss");
      expect(toss, serving).toHaveLength(1);
      expect(toss[0]!.text.params).toMatchObject({ side: name });
      expect(toss[0]!.sideIndex).toBe(index);
    }
  });

  it("every locale has the sentence, and it places the side", () => {
    const locales = ["en", "es", "fr", "nl"];
    for (const locale of locales) {
      const dict = JSON.parse(readFileSync(join(DICT_DIR, locale, "public.json"), "utf8")) as Record<string, string>;
      expect(dict["timeline.tennis.toss"], locale).toContain("{side}");
    }
    expect(locales).toHaveLength(4);
  });

  it("the first game's rung follows the toss: away's four points are a BREAK with no toss and a HOLD after a toss for away", () => {
    const rung = (ls: ReturnType<typeof lines>) =>
      ls.filter((l) => l.text.key === TIMELINE_GAME_HELD_KEY || l.text.key === TIMELINE_GAME_BROKEN_KEY);

    const noToss = rung(lines([["core.start", {}], ...fourPointsTo("A")]));
    expect(noToss.map((l) => l.text.key)).toEqual([TIMELINE_GAME_BROKEN_KEY]);

    const tossedAway = rung(lines([["tennis.toss", { serving: "A" }], ["core.start", {}], ...fourPointsTo("A")]));
    expect(tossedAway.map((l) => l.text.key)).toEqual([TIMELINE_GAME_HELD_KEY]);
    expect(tossedAway[0]!.sideIndex).toBe(1);
  });
});
