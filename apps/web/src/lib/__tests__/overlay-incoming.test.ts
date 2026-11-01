// The overlay stage's ONE incoming list (R4 S15 fix round 1, m1): its two gates (the delay, the match card) and the
// sponsor cards' mount-tip filter, at their boundaries, plus the key the queue hook dispatches on. The composition over
// REAL loader data is the sponsor seam's (server/sponsors/__tests__/seam.test.ts), which calls this same function.
//
// Sport: `generic` declares no moment rules, so every moment below is one this test put there on purpose (a plan's card
// or the toss). One cricket case (final review S15 O2), single sport because the end-of-over card is cricket's alone: a
// REAL over whose last ball is a boundary, folded by the engine, so the six's moment, the over's card and the sponsor card
// all sit at the over's last seq and the ONE list's order is what decides which airs first.
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { defaultLineupPair, makeEnvelope, SIM_CONFIGS } from "@seazn/engine/testkit";
import { incomingKey, stageIncoming, type StageIncomingInput } from "@/lib/overlay-incoming";
import { CLOSED_OVER_BASELINE_NONE } from "@/lib/overlay-end-of-over";
import { sponsorMomentId, SPONSOR_STYLE_BY_SIZE, type SponsorPlan } from "@/lib/sponsor-plan";
import { buildOverlayRecent, overlayCricketBundleIds, replayDerived } from "@/server/overlay/recent";

const msg = (key: string) => key;
const look = SPONSOR_STYLE_BY_SIZE.minor;
const CARD = { id: "c1", sponsorId: "c1", name: "Quay Fisheries", logoUrl: null, tier: "gold" as const, onStream: true, shortCode: "QUAY" };
/** A plan airing one break, at ledger seq `seq`. */
const planAt = (seq: number): SponsorPlan => ({
  cards: [CARD],
  airings: [{ momentId: sponsorMomentId(seq, "over_end"), seq, cardId: CARD.id, style: look.style, holdMs: look.holdMs, breakKind: "over_end" }],
});
const base = (over: Partial<StageIncomingInput> = {}): StageIncomingInput => ({
  sportKey: "generic",
  recent: [],
  lastClosedOver: null,
  cricketToss: null,
  scoringStarted: false,
  sponsorPlan: null,
  momentBaseline: 0,
  closedOverBaseline: CLOSED_OVER_BASELINE_NONE,
  msg,
  sideShorts: ["HAR", "RID"],
  sideNames: ["Harbour XI", "Ridge XI"],
  showMatchCard: false,
  awaitingDelay: false,
  ...over,
});
const sponsorIds = (list: readonly { seq: number; kind: string }[]) => list.filter((m) => m.kind.startsWith("sponsor.")).map((m) => `${m.seq}:${m.kind}`);

describe("stageIncoming", () => {
  it("EMPTY FIRST: nothing in, nothing out — and an awaited delay empties a list that has content", () => {
    expect(stageIncoming(base())).toEqual([]);
    const full = base({ sponsorPlan: planAt(6), cricketToss: { wonBySide: 0, elected: "bat" } });
    expect(stageIncoming(full).length, "premise: the input carries a card and a toss").toBe(2);
    expect(stageIncoming({ ...full, awaitingDelay: true })).toEqual([]);
  });

  it("a plan's card airs only BEHIND the mount's tip: seq == baseline is the break the page mounted after, never replayed", () => {
    const seq = 6;
    const checked = [seq - 1, seq, seq + 1].map((baseline) => sponsorIds(stageIncoming(base({ sponsorPlan: planAt(seq), momentBaseline: baseline }))));
    expect(checked).toEqual([[sponsorMomentId(seq, "over_end")], [], []]);
  });

  it("the toss joins only while no match card is up, and goes once scoring has started", () => {
    const toss = { wonBySide: 1 as const, elected: "bowl" as const };
    const graphics = (over: Partial<StageIncomingInput>) => stageIncoming(base({ cricketToss: toss, ...over })).map((m) => m.graphic);
    expect(graphics({})).toEqual(["toss"]);
    expect(graphics({ showMatchCard: true })).toEqual([]);
    expect(graphics({ scoringStarted: true })).toEqual([]);
  });

  it("the cards come LAST, after the toss (the ONE list's order)", () => {
    const list = stageIncoming(base({ sponsorPlan: planAt(6), cricketToss: { wonBySide: 0, elected: "bat" } }));
    expect(list.map((m) => m.graphic)).toEqual(["toss", "sponsor"]);
  });
});

describe("cricket: a boundary on the over's last ball (final review S15 O2)", () => {
  const T0 = Date.parse("2026-10-31T10:00:00.000Z");
  /** The first over, five dots then `last`, folded by the real engine: the stage's own inputs, read as the loader reads them. */
  const over = (last: Record<string, unknown>) => {
    const mod = builtinModules.find((x) => x.key === "cricket")!;
    const cfg = mod.configSchema.parse(SIM_CONFIGS.cricket ?? {});
    const lineups = defaultLineupPair(mod.positions);
    const ball = (ballInOver: number, extra: Record<string, unknown> = { runs: { bat: 0 } }) =>
      ["cricket.ball", { over: 0, ballInOver, striker: "H-p1", nonStriker: "H-p2", bowler: "A-p11", ...extra }] as const;
    const stream = [["cricket.toss", { wonBy: "H", elected: "bat" }], ["core.start", {}], ...[1, 2, 3, 4, 5].map((n) => ball(n)), ball(6, last)] as const;
    const events: EventEnvelope[] = stream.map(([type, payload], i) => ({
      ...makeEnvelope(i + 1, { type, payload } as never),
      recordedAt: new Date(T0 + i * 20_000).toISOString(),
    }));
    foldMatch(mod as never, cfg as never, lineups, events); // every payload is one the engine accepts
    const { bySeq } = replayDerived({ sportKey: "cricket", module: mod as never, cfg: cfg as never, lineups, active: events, window: 40 });
    const recent = buildOverlayRecent({ active: events, sides: [lineups.home.entrantId, lineups.away.entrantId], personOf: () => undefined, window: 40, derived: bySeq });
    const lastClosedOver = overlayCricketBundleIds({ sportKey: "cricket", module: mod as never, cfg, lineups }, events).lastClosedOver;
    return { seq: events.at(-1)!.seq, recent, lastClosedOver };
  };
  const ids = (list: readonly { seq: number; kind: string }[]) => list.map((m) => `${m.seq}:${m.kind}`);

  it("the six's moment, then the over's card, then the sponsor card - all at the last ball's seq - and a dot ball is the control: no six, the same over card", () => {
    const six = over({ runs: { bat: 6 }, boundary: 6 });
    expect(six.lastClosedOver?.over, "premise: the ledger closed over 1").toBe(1);
    const list = stageIncoming(base({ sportKey: "cricket", recent: six.recent, lastClosedOver: six.lastClosedOver, sponsorPlan: planAt(six.seq), scoringStarted: true }));
    const eoo = list.filter((m) => m.kind.startsWith("endOfOver")).map((m) => `${m.seq}:${m.kind}`);
    expect(eoo.length, "premise: the over's card is in the list").toBeGreaterThan(0);
    expect(ids(list)).toEqual([`${six.seq}:six`, `${six.seq}:six.bis`, ...eoo, sponsorMomentId(six.seq, "over_end")]);

    // The control: the same over ending on a dot. The over's card and the sponsor card stay; there is no six to precede them.
    const dot = over({ runs: { bat: 0 } });
    expect(dot.lastClosedOver?.over, "premise: the dot ball closes the same over").toBe(1);
    const quiet = stageIncoming(base({ sportKey: "cricket", recent: dot.recent, lastClosedOver: dot.lastClosedOver, sponsorPlan: planAt(dot.seq), scoringStarted: true }));
    expect(ids(quiet)).toEqual([...eoo, sponsorMomentId(dot.seq, "over_end")]);
  });
});

describe("incomingKey — what the queue hook dispatches on", () => {
  it("a fresh array of the same moments is the same key (no dispatch); a new id, a dropped id or an empty list is a new one", () => {
    const one = stageIncoming(base({ sponsorPlan: planAt(6) }));
    const again = stageIncoming(base({ sponsorPlan: planAt(6) }));
    expect(again, "premise: a fresh array").not.toBe(one);
    expect(incomingKey(again)).toBe(incomingKey(one));
    expect(incomingKey(stageIncoming(base({ sponsorPlan: planAt(12) })))).not.toBe(incomingKey(one));
    expect(incomingKey([])).toBe("");
    expect(incomingKey(one)).not.toBe("");
  });

  // Final review S15: the hook (`use-moment-queue.ts`) keys its effect on `incomingKey`, so a key that drops part of the
  // identity is a lost dispatch. Two lists of ONE length and ONE seq differing only in kind (a six and its sponsor card
  // share the over's last seq), and two of one kind and one length differing in seq: a count-only key misses both, a
  // seq-only key the first, a kind-only key the second.
  it("the key is the seq AND the kind of every moment: same length + same seq, or same length + same kind, are new keys", () => {
    const card = stageIncoming(base({ sponsorPlan: planAt(6) }));
    const six = [{ ...card[0]!, kind: "six", graphic: "six" as never }];
    expect(card.length, "premise").toBe(1);
    expect(six[0]!.seq, "premise: one seq").toBe(card[0]!.seq);
    expect(incomingKey(six), "same seq, another kind").not.toBe(incomingKey(card));
    const later = stageIncoming(base({ sponsorPlan: planAt(7) }));
    expect(later[0]!.kind, "premise: one kind").toBe(card[0]!.kind);
    expect(incomingKey(later), "same kind, another seq").not.toBe(incomingKey(card));
  });
});
