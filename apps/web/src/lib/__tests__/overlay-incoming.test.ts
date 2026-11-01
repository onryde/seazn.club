// The overlay stage's ONE incoming list (R4 S15 fix round 1, m1): its two gates (the delay, the match card) and the
// sponsor cards' mount-tip filter, at their boundaries, plus the key the queue hook dispatches on. The composition over
// REAL loader data is the sponsor seam's (server/sponsors/__tests__/seam.test.ts), which calls this same function.
//
// Sport: `generic` declares no moment rules, so every moment below is one this test put there on purpose (a plan's card
// or the toss) — a cricket ledger is the seam's job.
import { describe, expect, it } from "vitest";
import { incomingKey, stageIncoming, type StageIncomingInput } from "@/lib/overlay-incoming";
import { CLOSED_OVER_BASELINE_NONE } from "@/lib/overlay-end-of-over";
import { sponsorMomentId, SPONSOR_STYLE_BY_SIZE, type SponsorPlan } from "@/lib/sponsor-plan";

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
});
