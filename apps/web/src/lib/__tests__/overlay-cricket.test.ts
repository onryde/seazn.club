// `cricketDetail` — the overlay bar's second band for cricket (stream overlay
// W2 Task 3). Two lines: who is at the crease with their figures, and the
// bowler's analysis with this over's glyphs.
//
// The input is built by `deriveCricketScorecard` — the ENGINE'S own public
// spectator seam — so every number below comes from a real ledger folded by the
// real module. Nothing here computes an over, a strike rate or a maiden: if
// this file ever starts doing cricket arithmetic, the arithmetic has moved to
// the wrong place.
import { describe, expect, it } from "vitest";
import { cricket, deriveCricketScorecard } from "@seazn/engine/sports/cricket";
import { defaultLineupPair, makeEnvelope, SIM_CONFIGS } from "@seazn/engine/testkit";
import {
  cricketDetail,
  lastClosedOverFromScorecard,
  liveFromScorecard,
  scoringStartedFromScorecard,
  tossFromScorecard,
  type OverlayCricketLive,
} from "../overlay-cricket";

const msg = (key: string) =>
  (({ "overlay.cricket.strikerMark": "*", "overlay.cricket.thisOver": "this over" }) as Record<string, string>)[
    key
  ] ?? key;

const NAMES: Record<string, string> = {
  "H-p1": "Sharma",
  "H-p2": "Kohli",
  "H-p3": "Iyer",
  "A-p11": "Bumrah",
};
const nameOf = (id: string) => NAMES[id];

const cfg = (cricket as unknown as { configSchema: { parse: (r: unknown) => unknown } }).configSchema.parse(
  SIM_CONFIGS["cricket"] ?? {},
);
const lineups = defaultLineupPair(cricket.positions);
const base = { over: 0, ballInOver: 1, striker: "H-p1", nonStriker: "H-p2", bowler: "A-p11" };

/** One over: a single, a four, a wide, then a wicket. */
const OVER = [
  makeEnvelope(1, { type: "cricket.toss", payload: { wonBy: "H", elected: "bat" } } as never),
  makeEnvelope(2, { type: "core.start", payload: {} } as never),
  makeEnvelope(3, { type: "cricket.ball", payload: { ...base, runs: { bat: 1 } } } as never),
  makeEnvelope(4, {
    type: "cricket.ball",
    payload: { ...base, ballInOver: 2, striker: "H-p2", nonStriker: "H-p1", runs: { bat: 4 }, boundary: 4 },
  } as never),
  makeEnvelope(5, {
    type: "cricket.ball",
    payload: {
      ...base,
      ballInOver: 3,
      striker: "H-p2",
      nonStriker: "H-p1",
      runs: { bat: 0, extras: { kind: "wide", runs: 1 } },
    },
  } as never),
  makeEnvelope(6, {
    type: "cricket.ball",
    payload: {
      ...base,
      ballInOver: 3,
      striker: "H-p2",
      nonStriker: "H-p1",
      runs: { bat: 0 },
      wicket: { kind: "bowled", out: "H-p2", bowlerCredited: true, incoming: "H-p3" },
    },
  } as never),
];

const scorecardOf = (events: readonly unknown[]) =>
  deriveCricketScorecard({ events: events as never, cfg: cfg as never, lineups });

const liveOf = (events: readonly unknown[]): OverlayCricketLive | null =>
  liveFromScorecard(scorecardOf(events), nameOf);

describe("cricketDetail, from a real fold through the engine's own scorecard", () => {
  const sc = scorecardOf(OVER);
  const live = liveOf(OVER)!;

  it("the STRIKER comes first and carries the marker; the figures are the engine's", () => {
    // After the wicket the incoming batter is on strike — the engine's answer,
    // asserted here rather than assumed, because "striker first" is meaningless
    // if the two are the same person.
    expect(sc.live!.striker).toBe("H-p3");
    expect(sc.live!.nonStriker).toBe("H-p1");
    const line = sc.innings.at(-1)!.batting.find((b) => b.person === "H-p1")!;
    expect(cricketDetail(live, msg)[0]?.text).toBe(`Iyer* 0 (0) · Sharma ${line.runs} (${line.balls})`);
  });

  it("the bowler's line is O-M-R-W from the engine; this over's glyphs are structured chips", () => {
    const bowl = sc.innings.at(-1)!.bowling.find((b) => b.person === "A-p11")!;
    expect(cricketDetail(live, msg)[1]).toEqual({
      text: `Bumrah ${bowl.overs}-${bowl.maidens}-${bowl.runs}-${bowl.wickets}`,
      glyphs: ["1", "4", "wd", "W"],
    });
  });

  it("a maiden count the ledger cannot state is DROPPED, not printed as null", () => {
    const coarse: OverlayCricketLive = {
      ...live,
      bowler: { ...live.bowler!, maidens: null, overs: "2.3", runs: 14, wickets: 1 },
    };
    expect(cricketDetail(coarse, msg)[1]).toEqual({
      text: "Bumrah 2.3-14-1",
      glyphs: ["1", "4", "wd", "W"],
    });
  });

  it("an empty over drops the this-over segment entirely rather than trailing a label", () => {
    expect(cricketDetail({ ...live, thisOver: [] }, msg)[1]).toEqual({ text: "Bumrah 0.3-0-6-1" });
  });

  it("every glyph the engine can emit renders as notation, and a dot ball is a dot", () => {
    const glyphs = [
      { kind: "runs", runs: 0 },
      { kind: "runs", runs: 3 },
      { kind: "wide", runs: 1 },
      { kind: "wide", runs: 3 },
      { kind: "noball", runs: 1 },
      { kind: "noball", runs: 3 },
      { kind: "bye", runs: 2 },
      { kind: "legbye", runs: 1 },
      { kind: "penalty", runs: 5 },
      { kind: "wicket", dismissal: "caught" },
    ] as never;
    expect(cricketDetail({ ...live, thisOver: glyphs }, msg)[1]).toEqual({
      text: "Bumrah 0.3-0-6-1",
      glyphs: ["·", "3", "wd", "wd+2", "nb", "nb+2", "2b", "1lb", "5p", "W"],
    });
  });

  it("nothing at the crease yields NO band at all — never an empty line", () => {
    expect(cricketDetail(null, msg)).toEqual([]);
    expect(cricketDetail({ ...live, batters: [] }, msg)).toEqual([]);
  });

  it("a batter the line-up never named is dropped from the LINE but stays a fact on the wire", () => {
    const anon = liveFromScorecard(sc, (id) => (id === "H-p1" ? undefined : NAMES[id]));
    expect(anon!.batters.map((b) => b.name)).toEqual(["Iyer", undefined]);
    expect(cricketDetail(anon, msg)[0]?.text).toBe("Iyer* 0 (0)");
  });

  it("the marker follows the STRIKER, not the first name that survives", () => {
    // With the striker unnamed and dropped, marking element zero would put the
    // asterisk on the non-striker — saying the wrong player is facing. The flag
    // is carried, so it cannot.
    const anon = liveFromScorecard(sc, (id) => (id === "H-p3" ? undefined : NAMES[id]));
    expect(anon!.batters[0]!.onStrike).toBe(true);
    expect(anon!.batters[0]!.name).toBeUndefined();
    expect(cricketDetail(anon, msg)[0]?.text).toBe("Sharma 1 (1)");
    expect(cricketDetail(anon, msg)[0]?.text).not.toContain("*");
  });

  it("a bowler with no name loses the BOWLER line but keeps the over — the glyphs are the over, not the person", () => {
    const anon = liveFromScorecard(sc, (id) => (id === "A-p11" ? undefined : NAMES[id]));
    expect(anon!.bowler).toBeUndefined();
    expect(cricketDetail(anon, msg)[1]).toEqual({
      text: "",
      glyphs: ["1", "4", "wd", "W"],
    });
  });

  it("a scorecard with no live block at all (not started, between innings) yields null", () => {
    const notStarted = scorecardOf([OVER[0]!, OVER[1]!]);
    expect(liveFromScorecard(notStarted, nameOf)).toBeNull();
  });
});

describe("tossFromScorecard / lastClosedOverFromScorecard / scoringStartedFromScorecard", () => {
  const sides: [string, string] = [lineups.home.entrantId, lineups.away.entrantId];

  /** Six legal dots — over 1 complete, no ball of over 2 yet. */
  const OVER_COMPLETE = [
    makeEnvelope(1, { type: "cricket.toss", payload: { wonBy: "H", elected: "bat" } } as never),
    makeEnvelope(2, { type: "core.start", payload: {} } as never),
    ...[1, 2, 3, 4, 5, 6].map((ballInOver) =>
      makeEnvelope(2 + ballInOver, {
        type: "cricket.ball",
        payload: { ...base, over: 0, ballInOver, runs: { bat: 0 } },
      } as never),
    ),
  ];

  it("toss maps wonBy entrant to a side index and keeps elected", () => {
    const sc = scorecardOf([OVER_COMPLETE[0]!]);
    expect(tossFromScorecard(sc, sides)).toEqual({ wonBySide: 0, elected: "bat" });
  });

  it("no toss yet yields null", () => {
    expect(tossFromScorecard(scorecardOf([]), sides)).toBeNull();
  });

  it("scoringStarted is false until a ball (or over) has been recorded", () => {
    expect(scoringStartedFromScorecard(scorecardOf([OVER_COMPLETE[0]!, OVER_COMPLETE[1]!]))).toBe(
      false,
    );
    expect(scoringStartedFromScorecard(scorecardOf(OVER_COMPLETE.slice(0, 3)))).toBe(true);
  });

  it("after a completed over with empty thisOver, lastClosedOver is that over", () => {
    const sc = scorecardOf(OVER_COMPLETE);
    const closed = lastClosedOverFromScorecard(sc, nameOf);
    expect(closed).not.toBeNull();
    expect(closed!.over).toBe(1);
    expect(closed!.runs).toBe(0);
    expect(closed!.score).toBe("0/0");
    expect(closed!.glyphs.length).toBe(6);
    expect(closed!.bowler?.name).toBe("Bumrah");
  });

  it("before any over completes, lastClosedOver is null", () => {
    const sc = scorecardOf(OVER);
    expect(lastClosedOverFromScorecard(sc, nameOf)).toBeNull();
  });
});
