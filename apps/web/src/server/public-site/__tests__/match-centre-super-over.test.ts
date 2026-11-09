// The deciding super over, driven through the REAL cricket fold (never a
// hand-built state): a main innings tie, then super overs the engine repeats
// while they stay tied. Every expected string is typed here, not computed by
// the code under test.
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope, type LineupPair } from "@seazn/engine/core";
import { makeEnvelope } from "@seazn/engine/testkit";
import { cricket, deriveCricketScorecard, type CricketCfg } from "@seazn/engine/sports/cricket";
import { superOverLineOf } from "../match-centre";
import { t } from "@/lib/i18n-runtime";
import enPublic from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";

const cfg: CricketCfg = cricket.configSchema.parse({
  superOver: true, ballsPerInnings: 6, ballsPerOver: 6, minOversForResult: 1,
});
const lineups = (): LineupPair => {
  const side = (p: string) => ({
    entrantId: p,
    slots: Array.from({ length: 11 }, (_, i) => ({
      personId: `${p}-${i + 1}`, slot: "starting" as const, orderNo: i + 1,
      ...(i === 0 ? { roles: ["captain"] } : i === 1 ? { roles: ["wicketkeeper"] } : {}),
    })),
  });
  return { home: side("H"), away: side("A") } as never as LineupPair;
};
type Spec = [type: string, payload?: unknown];
const ball = (type: string, n: number, striker: string, bowler: string, bat: number): Spec => [
  type, { over: 0, ballInOver: n, striker, nonStriker: striker.replace(/-1$/, "-2"), bowler, runs: { bat } },
];
/** One over (6 balls) by `side` batting, of `runsPerBall` each. */
const over = (type: string, side: "H" | "A", bowler: string, runsPerBall: number): Spec[] =>
  [1, 2, 3, 4, 5, 6].map((n) => ball(type, n, `${side}-1`, bowler, runsPerBall));
const MAIN: Spec[] = [
  ["core.start"],
  ...over("cricket.ball", "H", "A-11", 2), // H 12
  ...over("cricket.ball", "A", "H-11", 2), // A 12
];
/** One super-over over by `side`, ball by ball. */
const so = (side: "H" | "A", runs: number[]): Spec[] =>
  runs.map((bat, i) => ball("cricket.superover.ball", i + 1, `${side}-1`, side === "H" ? "A-10" : "H-10", bat));

function fold(specs: Spec[]) {
  const events: EventEnvelope[] = specs.map(([type, payload], i) => makeEnvelope(i, { type, payload: payload ?? {} }));
  return { events, state: foldMatch(cricket, cfg, lineups(), events) };
}
const sides = [
  { entrantId: "H", name: "Home", short: "HOM", colour: null, badgeUrl: null },
  { entrantId: "A", name: "Away", short: "AWA", colour: null, badgeUrl: null },
] as const;
const en = enPublic as unknown as Dict;
const lineFor = (specs: Spec[]) => {
  const { events } = fold(specs);
  const card = deriveCricketScorecard({ events, cfg, lineups: lineups() });
  const msg = superOverLineOf(card, sides as never);
  return msg === null ? null : t(en, msg.key, msg.params);
};

describe("superOverLineOf against a real fold", () => {
  it("no super over: null", () => {
    expect(lineFor(MAIN.slice(0, 7))).toBeNull();
  });
  it("one super over decided: unnumbered, in batting order", () => {
    expect(lineFor([...MAIN, ...so("A", [1, 1, 1, 1, 1, 1]), ...so("H", [1, 1, 1, 1, 1, 2])])).toBe("Super over: AWA 6/0 · HOM 7/0");
  });
  it("a super over in progress shows its first half only", () => {
    expect(lineFor([...MAIN, ...so("A", [1, 1, 1, 1, 1, 1])])).toBe("Super over: AWA 6/0");
  });
});

const ONE_TIED = [...so("A", [1, 1, 1, 1, 1, 1]), ...so("H", [1, 1, 1, 1, 1, 1])]; // 6–6, the engine repeats it

describe("a repeated tie: only the last super over decides", () => {
  it("the line names it and prints its two scores, not a sum", () => {
    const line = lineFor([...MAIN, ...ONE_TIED, ...so("H", [4, 4, 4, 4, 4, 4]), ...so("A", [1, 1, 1, 1, 1, 2])]);
    expect(line).toBe("Super over 2: HOM 24/0 · AWA 7/0");
  });
});
