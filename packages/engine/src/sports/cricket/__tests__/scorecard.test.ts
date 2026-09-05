// Spectator match centre — cricket scorecard fold (Task 1: totals, extras by
// kind, fidelity band). Every expectation is derived from the reducer's own
// state (`cricket.summary`) or the script that built the ledger — never a
// hand-typed constant standing in for one.
import { describe, expect, it } from "vitest";
import { cricket } from "../cricket.ts";
import { deriveCricketScorecard } from "../scorecard.ts";
import { scriptLedger, type Script } from "./scorecard-ledger.ts";

const HOME = ["h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8"];
const AWAY = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"];

export const TWO_INNINGS: Script = {
  // 2 overs a side keeps the fixture readable. `minOversForResult` must be
  // overridden too: the schema's default (5) fails
  // `minOversForResult * ballsPerOver <= ballsPerInnings` (5*6=30 > 12) — a
  // false premise in the brief's illustrative cfg, found by running it.
  cfg: { ballsPerInnings: 12, playersPerSide: 8, minOversForResult: 2 },
  home: HOME,
  away: AWAY,
  tossWonBy: "home",
  elected: "bat",
  innings: [
    {
      batting: "home",
      bowlers: ["a7", "a8"],
      deliveries: [
        { bat: 1 },
        { bat: 4 },
        { extra: "wide", runs: 1 },
        { bat: 0 },
        { out: "caught", fielder: "a3" },
        { bat: 2 },
        { bat: 6 },
        { extra: "noball", runs: 1, bat: 2 },
        { bat: 0 },
        { extra: "bye", runs: 1 },
        { out: "runout", fielder: "a5", assist: "a6", bat: 1 },
        { extra: "legbye", runs: 1 },
        { bat: 3 },
      ],
    },
    {
      batting: "away",
      bowlers: ["h7", "h8"],
      deliveries: [
        { bat: 0 },
        { bat: 0 },
        { bat: 0 },
        { bat: 0 },
        { bat: 0 },
        { bat: 0 }, // a maiden
        { bat: 4 },
        { out: "bowled" },
        { out: "lbw" },
        { out: "stumped", fielder: "h1" },
        { extra: "penalty", runs: 5 },
        { bat: 1 },
      ],
    },
  ],
};

describe("deriveCricketScorecard — totals", () => {
  it("empty ledger → no innings, no live, band 0, result null (EMPTY CASE FIRST)", () => {
    const { cfg, lineups } = scriptLedger({ ...TWO_INNINGS, innings: [] });
    const card = deriveCricketScorecard({ events: [], cfg, lineups });
    expect(card.innings).toEqual([]);
    expect(card.live).toBeNull();
    expect(card.result).toBeNull();
    expect(card.band).toBe(0);
  });

  it("innings totals equal the reducer's own summary on the same ledger (parity)", () => {
    const { events, state, cfg, lineups } = scriptLedger(TWO_INNINGS);
    const card = deriveCricketScorecard({ events, cfg, lineups });
    const summary = cricket.summary(state) as {
      detail: { innings: Array<{ runs: number; wickets: number; legalBalls: number }> };
    };
    expect(card.innings.map((i) => [i.total.runs, i.total.wickets, i.total.legalBalls])).toEqual(
      summary.detail.innings.map((i) => [i.runs, i.wickets, i.legalBalls]),
    );
  });

  it("extras are counted by kind and sum to the innings' extras", () => {
    const { events, cfg, lineups } = scriptLedger(TWO_INNINGS);
    const [inn1] = deriveCricketScorecard({ events, cfg, lineups }).innings;
    expect(inn1?.extras).toEqual({ wides: 1, noBalls: 1, byes: 1, legByes: 1, penalties: 0, total: 4 });
  });

  it("band is the max band present: balls → 3", () => {
    const { events, cfg, lineups } = scriptLedger(TWO_INNINGS);
    expect(deriveCricketScorecard({ events, cfg, lineups }).band).toBe(3);
  });
});
