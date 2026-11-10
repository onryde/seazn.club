// A cricket wicket is voidable only while it is the latest active ball; "Void back to here" is the way back to an older
// one (owner, 2026-11-10; docs/specs/2026-11-10-cricket-wicket-void-latest-only.md). The pure half: which rows, in which
// order, and what the engine's fold says once the sequence has run.
import { describe, expect, it } from "vitest";
import { resolveVoids, type CoreEv, type EventEnvelope, type FoldContext } from "@seazn/engine/core";
import { makeEnvelope } from "@seazn/engine/testkit";
import { cricket, type CricketEv, type CricketState } from "@seazn/engine/sports/cricket";
import { AWAY, HOME, scriptLedger, type Script } from "@/server/public-site/__tests__/cricket-ledger";
import {
  carriesWicket,
  isWicketBehindLaterBall,
  runVoidBack,
  voidBackIds,
  type WicketLedgerRow,
} from "../cricket-wicket-void";

const CFG = { ballsPerInnings: 12, playersPerSide: 8, minOversForResult: 2 };
const script = (deliveries: Script["innings"][number]["deliveries"]): Script => ({
  cfg: CFG,
  home: HOME,
  away: AWAY,
  tossWonBy: "home",
  elected: "bat",
  innings: [{ batting: "home", bowlers: ["a7"], deliveries, leaveOpen: true }],
});

// e-0 toss, e-1 start, e-2 a single, e-3 two, e-4 a WICKET (bowled), e-5 a four.
const LONG = scriptLedger(script([{ bat: 1 }, { bat: 2 }, { out: "bowled" }, { bat: 4 }]));
const rowsOf = (events: readonly EventEnvelope[]): WicketLedgerRow[] =>
  events.map((e) => ({ id: e.id, type: e.type, seq: e.seq, payload: e.payload, voids: e.voids ?? null }));
const ROWS = rowsOf(LONG.events);
const row = (id: string) => ROWS.find((r) => r.id === id)!;

const foldActive = (events: readonly EventEnvelope[], lineupsOf: typeof LONG): CricketState => {
  let state = cricket.init(lineupsOf.cfg, lineupsOf.lineups);
  const ctx: FoldContext = { strict: false };
  for (const e of resolveVoids(events)) state = cricket.apply(state, e as EventEnvelope<CricketEv | CoreEv>, ctx);
  return state;
};
const voidEnv = (seq: number, target: string) => makeEnvelope(seq, { type: "core.void", payload: { event_id: target } }, target);

describe("the wicket rule's predicates", () => {
  it("the ledger under test is what it claims: one wicket (e-4) with a ball after it (e-5)", () => {
    expect(ROWS.filter(carriesWicket).map((r) => r.id)).toEqual(["e-4"]);
    expect(ROWS.map((r) => r.type).slice(-2)).toEqual(["cricket.ball", "cricket.ball"]);
  });

  it("an older wicket is behind a later ball; the latest wicket is not; a plain older ball is not a wicket at all", () => {
    expect(isWicketBehindLaterBall(row("e-4"), ROWS)).toBe(true);
    expect(isWicketBehindLaterBall(row("e-4"), ROWS.slice(0, 5))).toBe(false);
    expect(isWicketBehindLaterBall(row("e-3"), ROWS)).toBe(false);
  });

  it("a wicket followed only by non-ball entries is still the latest (decided by a later ACTIVE BALL)", () => {
    const withChange: WicketLedgerRow[] = [
      ...ROWS.slice(0, 5),
      { id: "e-5x", type: "cricket.bowler.change", seq: 5, payload: {}, voids: null },
    ];
    expect(isWicketBehindLaterBall(row("e-4"), withChange)).toBe(false);
  });

  it("a later ball that is itself voided does not count; a voided wicket is no wicket", () => {
    const voidedLater = [...ROWS, { id: "v-6", type: "core.void", seq: 6, payload: {}, voids: "e-5" }];
    expect(isWicketBehindLaterBall(row("e-4"), voidedLater)).toBe(false);
    const voidedWicket = [...ROWS, { id: "v-6", type: "core.void", seq: 6, payload: {}, voids: "e-4" }];
    expect(isWicketBehindLaterBall(row("e-4"), voidedWicket)).toBe(false);
  });

  it("a super-over wicket is a wicket, and a later super-over ball is a later ball", () => {
    const so = (id: string, seq: number, wicket: boolean): WicketLedgerRow => ({
      id, type: "cricket.superover.ball", seq, voids: null, payload: wicket ? { wicket: { kind: "bowled", out: "h1" } } : { runs: { bat: 1 } },
    });
    expect(isWicketBehindLaterBall(so("s1", 1, true), [so("s1", 1, true), so("s2", 2, false)])).toBe(true);
  });

  it("another sport's wicket-shaped payload is not a cricket wicket; a null wicket is not a wicket", () => {
    expect(carriesWicket({ type: "football.goal", payload: { wicket: { out: "x" } } })).toBe(false);
    expect(carriesWicket({ type: "cricket.ball", payload: { wicket: null } })).toBe(false);
    expect(carriesWicket({ type: "cricket.ball", payload: null })).toBe(false);
  });
});

describe("voidBackIds", () => {
  it("names every active entry newer than the wicket, newest first, then the wicket", () => {
    expect(voidBackIds(row("e-4"), ROWS)).toEqual(["e-5", "e-4"]);
  });

  it("skips voids and rows already voided, and counts non-ball entries too", () => {
    const rows: WicketLedgerRow[] = [
      ...ROWS,
      { id: "pc", type: "cricket.bowler.change", seq: 6, payload: {}, voids: null },
      { id: "v-7", type: "core.void", seq: 7, payload: {}, voids: "e-5" },
    ];
    expect(voidBackIds(row("e-4"), rows)).toEqual(["pc", "e-4"]);
  });
});

describe("runVoidBack", () => {
  it("sends the ids in order, each on the next seq, and reports all done", async () => {
    const seen: [string, number][] = [];
    const r = await runVoidBack(["c", "b", "a"], 10, async (id, seq) => {
      seen.push([id, seq]);
      return { ok: true };
    });
    expect(seen).toEqual([["c", 10], ["b", 11], ["a", 12]]);
    expect(r).toEqual({ done: 3, total: 3, refusal: null });
  });

  it("stops at the first refusal: nothing after it is sent, and it says how many were voided", async () => {
    const seen: string[] = [];
    const r = await runVoidBack(["c", "b", "a"], 10, async (id) => {
      seen.push(id);
      return id === "b" ? { ok: false, message: "conflict" } : { ok: true };
    });
    expect(seen).toEqual(["c", "b"]);
    expect(r).toEqual({ done: 1, total: 3, refusal: { message: "conflict" } });
  });

  it("an empty list sends nothing and is not a refusal", async () => {
    const r = await runVoidBack([], 3, async () => ({ ok: true }));
    expect(r).toEqual({ done: 0, total: 0, refusal: null });
  });
});

describe("the fold after a void back", () => {
  it("voiding the ids newest first leaves the pre-wicket card: 3 runs, no wicket (and the long card was 7 for 1)", () => {
    expect(LONG.state.innings[0]).toMatchObject({ runs: 7, wickets: 1, legalBalls: 4 });
    const ids = voidBackIds(row("e-4"), ROWS);
    let seq = LONG.events.length;
    const voids = ids.map((id) => voidEnv(seq++, id));
    const folded = foldActive([...LONG.events, ...voids], LONG);
    const before = scriptLedger(script([{ bat: 1 }, { bat: 2 }]));
    expect(folded.innings[0]).toMatchObject({ runs: 3, wickets: 0, legalBalls: 2 });
    expect(folded).toEqual(before.state);
  });

  it("the shape the rule forbids does what the owner feared: voiding only the older wicket keeps the later ball and the new batter", () => {
    const folded = foldActive([...LONG.events, voidEnv(LONG.events.length, "e-4")], LONG);
    // The four is still scored by h3, who came in because of the wicket that no longer happened.
    expect(folded.innings[0]).toMatchObject({ runs: 7, wickets: 0 });
    expect(folded.innings[0]!.fine?.batterRuns["h3"]).toBe(4);
  });
});
