// `deriveCricketScorecard` over the events the KERNEL folds itself —
// `core.suspend`, `core.resume` and the five `core.lineup.*` types, plus
// `core.void`.
//
// THE DEFECT. The scorecard replayed the ledger through `cricket.apply`
// directly, and `cricket.apply` has never heard of any of those types: the
// kernel (`foldMatchWithStoppage`, core/events.ts) consumes them and never
// forwards them. So the first `core.suspend` or concussion replacement in a
// cricket ledger threw `unknown event type`, and every public consumer —
// the match centre's Scorecard and Commentary tabs, the overlay's crease band
// — silently dropped the whole scorecard for the rest of the match.
//
// THE DECISION THESE TESTS PIN. Skipping those events is NOT enough. A
// lineup event reaches cricket through `onLineup`, which appends a
// replacement to `state.orders` — the list `applyDelivery` checks a bowler
// against and `resolveIncoming` checks a batter against, on the READ path as
// much as the write path (neither check is gated on `strictFold`). A
// concussion replacement who then bowls is therefore refused by a fold that
// skipped his arrival. The scorecard now rides the kernel's own fold
// (`FoldOptions.onFolded`), so there is one implementation of which events a
// module sees and how, and the replacement's figures are credited.
//
// And `didNotBat` is the ONE place the squad shows on a card: an innings'
// did-not-bat list is the batting side's order as it stood when that innings
// CLOSED, less anyone SWAPPED off the field (a substitution or a replacement
// brought someone on for them). A replacement who has not batted is listed;
// the player he replaced is not; and neither leaks into an innings that closed
// before the change. A player RETIRED from the field with nobody on for him
// (`core.lineup.retirement`) STAYS listed — owner ruling 2026-09-16, option A;
// an "absent hurt" line is later work. (`cricket.retire` is a different
// path and is not what these tests pin: it retires a batter AT THE CREASE.
// One who has faced a ball has a batting line and is not listed; one who
// walked in after a wicket and retired before facing has NO batting line —
// the card's batting order is built from ball payloads and the current
// crease — so he is still listed here. That gap predates this file.)
//
// Every ledger below is proven LEGAL first — folded through the kernel with
// the whole stream strict (`strictFromSeq: 0`, the pad's write path) — so no
// expectation rests on a ledger the product could never have recorded.
import { describe, expect, it } from "vitest";
import { foldMatch, foldMatchWithStoppage, type EventEnvelope } from "../../../core/events.ts";
import { LINEUP_EVENT_SCHEMAS, memberOf } from "../../../core/lineup.ts";
import { makeEnvelope } from "../../../testkit/helpers.ts";
import { cricket } from "../cricket.ts";
import { deriveCricketScorecard } from "../scorecard.ts";
import type { CricketScorecard } from "../scorecard-types.ts";
import { AWAY, HOME, scriptLedger, type Script, type ScriptLedger } from "./scorecard-ledger.ts";

const STRICT_ALL = { strictFromSeq: 0 } as const;

// T20-shaped (one concussion replacement a side, and one ordinary
// substitution so `core.lineup.substitution` is legal on the write path too),
// cut to three overs so every figure is small enough to read.
const SCRIPT: Script = {
  cfg: {
    ballsPerInnings: 18,
    playersPerSide: 8,
    minOversForResult: 1,
    superOver: false,
    lineupChanges: { concussionReplacements: 1, maxSubs: 1 },
  },
  home: HOME,
  away: AWAY,
  tossWonBy: "home",
  elected: "bat",
  innings: [
    {
      // h1, h2, then h3 and h4 in after the two wickets; h5-h8 do not bat.
      // Closes itself on the 18th legal ball.
      batting: "home",
      bowlers: ["a6", "a7", "a8"],
      deliveries: [
        { bat: 1 }, { bat: 0 }, { bat: 4 }, { bat: 0 }, { bat: 1 }, { bat: 0 },
        { bat: 2 }, { bat: 0 }, { bat: 0 }, { out: "bowled" }, { bat: 1 }, { bat: 0 },
        // Over 2 is a8's — the over a replacement takes over below.
        { bat: 0 }, { bat: 6 }, { out: "caught", fielder: "a4" }, { bat: 1 }, { bat: 0 }, { bat: 0 },
      ],
    },
    {
      // a1, a2, then a3 after the lbw; a4-a8 do not bat. Left OPEN, so the
      // live block exists and is compared too.
      batting: "away",
      bowlers: ["h7", "h8"],
      deliveries: [
        { bat: 1 }, { bat: 1 }, { bat: 0 }, { bat: 4 }, { bat: 0 }, { bat: 0 },
        { bat: 0 }, { out: "lbw" }, { bat: 2 }, { bat: 0 }, { bat: 0 }, { bat: 1 },
        { bat: 1 }, { bat: 0 }, { bat: 0 },
      ],
      leaveOpen: true,
    },
  ],
};

/** Position in `events` of the n-th `cricket.ball` (0-based). */
function ballAt(events: readonly EventEnvelope[], n: number): number {
  let seen = -1;
  const index = events.findIndex((ev) => ev.type === "cricket.ball" && ++seen === n);
  if (index < 0) throw new Error(`no ball #${n} in this ledger`);
  return index;
}

/** The ledger with `inserted` placed before position `at`, re-sequenced. */
function withInserted(
  events: readonly EventEnvelope[],
  at: number,
  ...inserted: ReadonlyArray<readonly [type: string, payload: unknown]>
): EventEnvelope[] {
  const specs = [
    ...events.slice(0, at).map((ev) => ({ type: ev.type, payload: ev.payload })),
    ...inserted.map(([type, payload]) => ({ type, payload })),
    ...events.slice(at).map((ev) => ({ type: ev.type, payload: ev.payload })),
  ];
  return specs.map((spec, seq) => makeEnvelope(seq, spec));
}

/** Folds `events` with the WHOLE stream strict — throws if the pad could not
 *  have recorded this ledger. Returns the kernel's own result. */
function provenLegal(ledger: ScriptLedger, events: readonly EventEnvelope[]) {
  return foldMatchWithStoppage(cricket, ledger.cfg, ledger.lineups, events, STRICT_ALL);
}

function scorecard(ledger: ScriptLedger, events: readonly EventEnvelope[]): CricketScorecard {
  return deriveCricketScorecard({ events, cfg: ledger.cfg, lineups: ledger.lineups });
}

/** Runs, balls and wickets per batter and per bowler, innings by innings. */
function figures(card: CricketScorecard) {
  return card.innings.map((innings) => ({
    batting: innings.batting.map((b) => [b.person, b.runs, b.balls, b.dismissal.kind]),
    bowling: innings.bowling.map((b) => [b.person, b.legalBalls, b.runs, b.wickets]),
  }));
}

/** The whole card except the one field a squad change is allowed to move. */
function exceptDidNotBat(card: CricketScorecard) {
  return { ...card, innings: card.innings.map(({ didNotBat: _, ...rest }) => rest) };
}

const replacement = (side: string, off: string, on: string, orderNo: number) =>
  [
    "core.lineup.replacement",
    { side, off, on: { personId: on, slot: "bench", orderNo }, exemption: "concussion", reason: "concussion" },
  ] as const;

const ledger = scriptLedger(SCRIPT);

/** The same match under a variant that lets a player come back once — the
 *  only way to record "off, back on, off again" legally. */
const returning = scriptLedger({
  ...SCRIPT,
  cfg: { ...SCRIPT.cfg, lineupChanges: { concussionReplacements: 1, maxSubs: 2, reentry: "once" } },
});
const sub = (off: string, on: string) =>
  ["core.lineup.substitution", { side: "home", off, on: { personId: on, slot: "bench", orderNo: 9 } }] as const;
const retirement = (personId: string) =>
  ["core.lineup.retirement", { side: "home", personId, reason: "injured" }] as const;
const entry = (personId: string) =>
  ["core.lineup.entry", { side: "home", on: { personId, slot: "bench", orderNo: 9 } }] as const;

/** `events` plus a `core.void` of `target` appended at the end — an undo. */
function withVoidOf(events: readonly EventEnvelope[], target: EventEnvelope | undefined): EventEnvelope[] {
  if (target === undefined) throw new Error("nothing to void");
  return [...events, makeEnvelope(events.length, { type: "core.void", payload: {} }, target.id)];
}

/** Folds `events` the way the append path does: history replayed, only the
 *  LAST event (the candidate) strict. Throws if that append would be refused. */
function appendLegal(ledger: ScriptLedger, events: readonly EventEnvelope[]) {
  const candidate = events.at(-1);
  if (candidate === undefined) throw new Error("empty ledger");
  return foldMatchWithStoppage(cricket, ledger.cfg, ledger.lineups, events, { strictFromSeq: candidate.seq });
}
const plain = scorecard(ledger, ledger.events);
// Start of innings 1's third over (a8's), and of innings 2's second over.
const INNINGS_1_OVER_2 = ballAt(ledger.events, 12);
const INNINGS_2_OVER_1 = ballAt(ledger.events, 18 + 6);

describe("the baseline these tests compare against is not vacuous", () => {
  it("both innings have batting and bowling lines, a live block and a did-not-bat list", () => {
    expect(figures(plain).map((i) => [i.batting.length, i.bowling.length])).toEqual([
      [4, 3],
      [3, 2],
    ]);
    expect(plain.innings[0]?.didNotBat).toEqual(["h5", "h6", "h7", "h8"]);
    expect(plain.innings[1]?.didNotBat).toEqual(["a4", "a5", "a6", "a7", "a8"]);
    expect(plain.live).not.toBeNull();
    // And the plain ledger is itself one the kernel accepts.
    expect(() => provenLegal(ledger, ledger.events)).not.toThrow();
  });
});

describe("deriveCricketScorecard — core.suspend / core.resume", () => {
  it("a stoppage between overs is legal, and the scorecard is IDENTICAL to the one without it", () => {
    const events = withInserted(
      ledger.events,
      INNINGS_1_OVER_2,
      ["core.suspend", { reason: "bad light" }],
      ["core.resume", {}],
    );
    // Kernel-owned: legal, and the module's state never moved.
    expect(provenLegal(ledger, events).state).toEqual(provenLegal(ledger, ledger.events).state);

    const card = scorecard(ledger, events);
    expect(figures(card)).toEqual(figures(plain));
    expect(card).toEqual(plain);
  });

  it("a match suspended RIGHT NOW (no resume yet) keeps its scorecard and live block — the rain-delay read", () => {
    const events = withInserted(ledger.events, ledger.events.length, ["core.suspend", { reason: "rain" }]);
    expect(provenLegal(ledger, events).stoppage).toMatchObject({ reason: "rain" });

    const card = scorecard(ledger, events);
    expect(card.live).not.toBeNull();
    expect(card).toEqual(plain);
  });
});

describe("deriveCricketScorecard — core.lineup.replacement (concussion)", () => {
  // a5 (away, fielding) is replaced by a9 during innings 1; h6 (home,
  // fielding) by h9 during innings 2 — AFTER home's own innings closed.
  // Neither replacement bats or bowls.
  const events = withInserted(
    withInserted(ledger.events, INNINGS_2_OVER_1, replacement("home", "h6", "h9", 9)),
    INNINGS_1_OVER_2,
    replacement("away", "a5", "a9", 9),
  );

  it("is a legal ledger, and the kernel really did change both squads", () => {
    const { squads } = provenLegal(ledger, events);
    expect(memberOf(squads.away, "a9")?.onField).toBe(true);
    expect(memberOf(squads.away, "a5")?.onField).toBe(false);
    expect(memberOf(squads.home, "h9")?.onField).toBe(true);
    expect(memberOf(squads.home, "h6")?.onField).toBe(false);
  });

  it("keeps the scorecard, with every run, ball and wicket exactly as the ledger without it", () => {
    const card = scorecard(ledger, events);
    expect(figures(card)).toEqual(figures(plain));
    expect(exceptDidNotBat(card)).toEqual(exceptDidNotBat(plain));
  });

  it("did-not-bat: the replacement is listed and the player he replaced is not, in the innings AFTER the change", () => {
    const card = scorecard(ledger, events);
    expect(card.innings[1]?.didNotBat).toEqual(["a4", "a6", "a7", "a8", "a9"]);
  });

  it("did-not-bat: an innings that CLOSED before the change is untouched — h6 is still listed, h9 never was", () => {
    const card = scorecard(ledger, events);
    expect(card.innings[0]?.didNotBat).toEqual(plain.innings[0]?.didNotBat);
    expect(card.innings[0]?.didNotBat).toEqual(["h5", "h6", "h7", "h8"]);
  });

  // The other half of the freeze: an innings still OPEN keeps taking squad
  // changes. h7 (home, BATTING, not yet in) is concussed and replaced by h9
  // midway through home's own innings — so innings 1's list has seen the
  // innings from its first ball, and a freeze taken too early would still
  // name h7 and never h9.
  it("did-not-bat: a change DURING the batting side's own open innings reaches that innings", () => {
    const during = withInserted(ledger.events, INNINGS_1_OVER_2, replacement("home", "h7", "h9", 9));
    const { squads } = provenLegal(ledger, during);
    const before = plain.innings[0]?.didNotBat ?? [];
    // Who left the field is the KERNEL's answer, not a name typed here.
    const leftTheField = before.filter((person) => memberOf(squads.home, person)?.onField === false);
    expect(leftTheField).toHaveLength(1);
    expect(memberOf(squads.home, "h9")?.onField).toBe(true);

    const card = scorecard(ledger, during);
    expect(card.innings[0]?.didNotBat).toEqual([...before.filter((p) => !leftTheField.includes(p)), "h9"]);
    expect(exceptDidNotBat(card)).toEqual(exceptDidNotBat(plain));
  });

  // OWNER RULING 2026-09-16, option A — the pair of the case above. The SAME
  // player (h7, batting side, not yet in) leaves the field at the SAME point,
  // but retired with nobody on for him: he stays in "Did not bat". Both
  // departures look identical in the squad (`onField: false`,
  // `timesOff: 1`), so this is the case that proves the card reads WHY he
  // left, not merely THAT he left.
  it("did-not-bat: a player RETIRED from the field with no replacement stays listed; a REPLACED one does not", () => {
    const retired = withInserted(ledger.events, INNINGS_1_OVER_2, [
      "core.lineup.retirement",
      { side: "home", personId: "h7", reason: "injured" },
    ]);
    const replaced = withInserted(ledger.events, INNINGS_1_OVER_2, replacement("home", "h7", "h9", 9));
    // Both legal, and in both the kernel really has taken h7 off the field.
    expect(memberOf(provenLegal(ledger, retired).squads.home, "h7")?.onField).toBe(false);
    expect(memberOf(provenLegal(ledger, replaced).squads.home, "h7")?.onField).toBe(false);

    const retiredCard = scorecard(ledger, retired);
    expect(retiredCard.innings[0]?.didNotBat).toContain("h7");
    expect(retiredCard.innings[0]?.didNotBat).toEqual(plain.innings[0]?.didNotBat);
    expect(exceptDidNotBat(retiredCard)).toEqual(exceptDidNotBat(plain));

    const replacedCard = scorecard(ledger, replaced);
    expect(replacedCard.innings[0]?.didNotBat).not.toContain("h7");
    expect(replacedCard.innings[0]?.didNotBat).toContain("h9");
  });

  // What counts is how a player LAST left. h7 is substituted off, comes back
  // on (a variant permitting one return), and is then retired: the earlier
  // swap must not keep him off the card. h9, swapped off and never back, is
  // still dropped.
  it("did-not-bat: the LAST departure decides — swapped off, back on (listed), then retired (still listed)", () => {
    const events = withInserted(
      returning.events,
      ballAt(returning.events, 12),
      sub("h7", "h9"),
      sub("h9", "h7"),
      retirement("h7"),
    );
    const { squads } = provenLegal(returning, events);
    expect(memberOf(squads.home, "h7")?.onField).toBe(false);
    expect(memberOf(squads.home, "h9")?.onField).toBe(false);

    const card = scorecard(returning, events);
    expect(card.innings[0]?.didNotBat).toEqual(["h5", "h6", "h7", "h8"]);

    // And with no retirement at all: h7 swapped off and BACK ON is listed —
    // a swap only drops a player who is still off the field.
    const backOn = withInserted(returning.events, ballAt(returning.events, 12), sub("h7", "h9"), sub("h9", "h7"));
    expect(memberOf(provenLegal(returning, backOn).squads.home, "h7")?.onField).toBe(true);
    expect(scorecard(returning, backOn).innings[0]?.didNotBat).toEqual(["h5", "h6", "h7", "h8"]);
  });

  // An UNDO can leave a later lineup event pointing at a player who is no
  // longer on the field. On replay the kernel IGNORES it (a structural
  // `not-on-field` refusal, core/events.ts) — so it is not a departure, and it
  // must not overwrite how that player really last left. Both ledgers are
  // recorded legally, event by event, and the undo is a legal APPEND.
  it("did-not-bat: an undo that leaves a RETIREMENT ignored does not bring a replaced player back (V1)", () => {
    const at = ballAt(returning.events, 12);
    const recorded = withInserted(returning.events, at, sub("h7", "h9"), sub("h9", "h7"), retirement("h7"));
    provenLegal(returning, recorded);
    const undone = withVoidOf(recorded, recorded[at + 1]); // void h7's return
    const { squads } = appendLegal(returning, undone);
    // The kernel's own reading: h9 is on for h7, and the retirement named a
    // player already off, so it moved nobody.
    expect(memberOf(squads.home, "h7")).toMatchObject({ onField: false, timesOff: 1 });
    expect(memberOf(squads.home, "h9")?.onField).toBe(true);

    const onlySwapped = withInserted(returning.events, at, sub("h7", "h9"));
    expect(scorecard(returning, undone).innings[0]?.didNotBat).toEqual(["h5", "h6", "h8", "h9"]);
    expect(scorecard(returning, undone).innings[0]?.didNotBat).toEqual(
      scorecard(returning, onlySwapped).innings[0]?.didNotBat,
    );
  });

  it("did-not-bat: an undo that leaves a SWAP ignored does not drop a retired player (V2, option A)", () => {
    const at = ballAt(returning.events, 12);
    const recorded = withInserted(returning.events, at, retirement("h7"), entry("h7"), sub("h7", "h9"));
    provenLegal(returning, recorded);
    const undone = withVoidOf(recorded, recorded[at + 1]); // void h7's return
    const { squads } = appendLegal(returning, undone);
    // The kernel's own reading: h7 retired and stayed off; the swap named a
    // player already off, so h9 never came on.
    expect(memberOf(squads.home, "h7")).toMatchObject({ onField: false, timesOff: 1 });
    expect(memberOf(squads.home, "h9")?.onField).not.toBe(true);

    const onlyRetired = withInserted(returning.events, at, retirement("h7"));
    expect(scorecard(returning, undone).innings[0]?.didNotBat).toEqual(["h5", "h6", "h7", "h8"]);
    expect(scorecard(returning, undone).innings[0]?.didNotBat).toEqual(
      scorecard(returning, onlyRetired).innings[0]?.didNotBat,
    );
  });

  // Why a player left is recorded PER SIDE. Two team sheets that name the
  // same person id must not share a record: here home's h7 is REPLACED and
  // then away's h7 RETIRES — home's h7 is still the one who was swapped off.
  it("did-not-bat: a departure is recorded against its own SIDE, even when both sides name the same person", () => {
    const shared = scriptLedger({
      ...SCRIPT,
      away: HOME,
      innings: [
        { ...SCRIPT.innings[0]!, bowlers: ["h6", "h7", "h8"], deliveries: SCRIPT.innings[0]!.deliveries.map((d) =>
          "fielder" in d ? { ...d, fielder: "h4" } : d) },
        SCRIPT.innings[1]!,
      ],
    });
    const events = withInserted(shared.events, ballAt(shared.events, 12), replacement("home", "h7", "h9", 9), [
      "core.lineup.retirement",
      { side: "away", personId: "h7", reason: "injured" },
    ]);
    const { squads } = provenLegal(shared, events);
    expect(memberOf(squads.home, "h7")?.onField).toBe(false);
    expect(memberOf(squads.away, "h7")?.onField).toBe(false);

    const card = scorecard(shared, events);
    expect(card.innings[0]?.didNotBat).toEqual(["h5", "h6", "h8", "h9"]);
    expect(card.innings[1]?.didNotBat).toContain("h7");
  });
});

describe("deriveCricketScorecard — a replacement who then BOWLS", () => {
  // a8 is replaced by a9 before over 2 of innings 1, and a9 bowls that over
  // — the same deliveries a8 bowled in the plain ledger, including the catch.
  // This is the ledger a fold that merely SKIPPED lineup events cannot read:
  // `applyDelivery` refuses a bowler who is not in `state.orders`, strict or
  // not, and only `onLineup` puts a9 there.
  const base = withInserted(ledger.events, INNINGS_1_OVER_2, replacement("away", "a8", "a9", 9));
  const events = base.map((ev, i) => {
    const payload = ev.payload as { bowler?: string };
    return ev.type === "cricket.ball" && i > INNINGS_1_OVER_2 && payload.bowler === "a8"
      ? makeEnvelope(ev.seq, { type: ev.type, payload: { ...payload, bowler: "a9" } })
      : ev;
  });
  const renamed = <T>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll('"a8"', '"a9"')) as T;

  it("is a legal ledger on the write path", () => {
    expect(() => provenLegal(ledger, events)).not.toThrow();
  });

  it("credits the replacement with the over he bowled — figures read off the kernel's own fold", () => {
    const kernel = provenLegal(ledger, events).state;
    const fine = kernel.innings[0]?.fine;
    const card = scorecard(ledger, events);
    const line = card.innings[0]?.bowling.find((b) => b.person === "a9");
    expect(line).toBeDefined();
    expect([line?.legalBalls, line?.runs, line?.wickets]).toEqual([
      fine?.bowlerBalls.a9,
      fine?.bowlerRuns.a9,
      fine?.bowlerWickets.a9,
    ]);
    // Not a trivially-empty line: a full over with a wicket in it.
    expect([line?.legalBalls, line?.wickets]).toEqual([6, 1]);
    expect(card.innings[0]?.bowling.map((b) => b.person)).toEqual(["a6", "a7", "a9"]);
  });

  it("innings 1 is the plain innings 1 with a8's over and catch credited to a9 — nothing else moves", () => {
    const card = scorecard(ledger, events);
    expect(card.innings[0]).toEqual(renamed(plain.innings[0]));
  });

  it("did-not-bat in away's innings lists a9 and no longer lists a8", () => {
    const card = scorecard(ledger, events);
    expect(card.innings[1]?.didNotBat).toEqual(["a4", "a5", "a6", "a7", "a9"]);
    expect(exceptDidNotBat(card).innings[1]).toEqual(exceptDidNotBat(plain).innings[1]);
  });
});

// EVERY lineup type, enumerated from the kernel's own registry — so a type
// added there without a case here fails loudly rather than going untested,
// and a fold that handled four of the five cannot pass.
describe("deriveCricketScorecard — every core.lineup.* type the kernel registers", () => {
  const CASES: Record<string, { payload: unknown; didNotBat: readonly string[] }> = {
    "core.lineup.substitution": {
      payload: { side: "away", off: "a5", on: { personId: "a9", slot: "bench", orderNo: 9 } },
      didNotBat: ["a4", "a6", "a7", "a8", "a9"],
    },
    "core.lineup.replacement": {
      payload: replacement("away", "a5", "a9", 9)[1],
      didNotBat: ["a4", "a6", "a7", "a8", "a9"],
    },
    "core.lineup.position": {
      payload: { side: "away", personId: "a4", positionKey: "WK" },
      didNotBat: ["a4", "a5", "a6", "a7", "a8"],
    },
    "core.lineup.retirement": {
      // Owner ruling 2026-09-16 (option A): retired with no replacement STAYS.
      payload: { side: "away", personId: "a5", reason: "injured" },
      didNotBat: ["a4", "a5", "a6", "a7", "a8"],
    },
    "core.lineup.entry": {
      payload: { side: "away", on: { personId: "a9", slot: "bench", orderNo: 9 } },
      didNotBat: ["a4", "a5", "a6", "a7", "a8", "a9"],
    },
  };

  it("has a case for exactly the types the kernel registers", () => {
    expect(Object.keys(CASES).sort()).toEqual(Object.keys(LINEUP_EVENT_SCHEMAS).sort());
  });

  it.each(Object.keys(LINEUP_EVENT_SCHEMAS))("%s mid-innings: legal, and every figure is unchanged", (type) => {
    const spec = CASES[type];
    if (spec === undefined) throw new Error(`no case for ${type}`);
    const events = withInserted(ledger.events, INNINGS_1_OVER_2, [type, spec.payload]);
    expect(() => provenLegal(ledger, events)).not.toThrow();

    const card = scorecard(ledger, events);
    expect(figures(card)).toEqual(figures(plain));
    expect(exceptDidNotBat(card)).toEqual(exceptDidNotBat(plain));
    expect(card.innings[0]?.didNotBat).toEqual(plain.innings[0]?.didNotBat);
    expect(card.innings[1]?.didNotBat).toEqual(spec.didNotBat);
  });
});

describe("deriveCricketScorecard — core.void", () => {
  it("a voided ball is struck: the card equals the ledger that never had it", () => {
    const last = ledger.events.at(-1);
    if (last === undefined) throw new Error("empty ledger");
    const events = [...ledger.events, makeEnvelope(ledger.events.length, { type: "core.void", payload: {} }, last.id)];
    expect(() => provenLegal(ledger, events)).not.toThrow();
    expect(scorecard(ledger, events)).toEqual(scorecard(ledger, ledger.events.slice(0, -1)));
    // …and that is a different card from the unvoided one, so the equality
    // above is not two views of an unchanged ledger.
    expect(scorecard(ledger, events)).not.toEqual(plain);
  });

  it("a core.forfeit, which the kernel DOES forward, still reaches cricket and decides the match", () => {
    const events = [
      ...ledger.events,
      makeEnvelope(ledger.events.length, { type: "core.forfeit", payload: { by: "away", reason: "walked off" } }),
    ];
    const kernel = foldMatch(cricket, ledger.cfg, ledger.lineups, events, STRICT_ALL);
    expect(kernel.outcome).not.toBeNull();
    const card = scorecard(ledger, events);
    expect(card.result).not.toBeNull();
    expect(card.result?.winner).toBe("home");
  });
});
