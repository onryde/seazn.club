// R4 sponsors on stream, S6: `sponsorMoments` — the served sponsor plan → moments for the ONE moment queue (spec
// 2026-10-27 §3.4; scenario rule 1, "a sponsor card is just another moment kind").
//
// Where the expected values come from — never from `sponsorMoments` itself:
//   - the identity: S4's `sponsorMomentId` (spec §3.2 "Moment id `${seq}:sponsor.${breakKind}`") and the airing's own
//     `momentId`, read through the queue's own `momentIdOf`;
//   - the style and hold: `SPONSOR_STYLE_BY_SIZE` (spec §3.2 "minor → lower third, 8 s; major → banner, 15 s");
//   - the card: the plan's own `cards`.
// Every plan below is the REAL planner's output (`planSponsors`) over hand-built breaks. S5 (the server producer) is
// not built yet, and engine 1.1.0 — which declares the real `naturalBreaks.kinds` — is not installable in web yet; the
// kinds and sizes below are copied from that release's declarations (engine repo, feat/natural-breaks:
// `sports/cricket/cricket.ts:4697-4698`, `sports/setbased/badminton.ts:113-114`). S15 drives the served plan end to end.
import { describe, expect, it } from "vitest";
import { INITIAL, momentIdOf, momentQueueReducer as reduce, type MomentQueueState } from "@/components/overlay/moment-queue";
import { OVERLAY_MOMENT_FOLD_MS, OVERLAY_MOMENT_HOLD_MS } from "@/components/overlay/moment-timing";
import { isSponsorMomentId, sponsorMoments, type OverlayMoment } from "../overlay-moments";
import {
  SPONSOR_STYLE_BY_SIZE,
  planSponsors,
  sponsorMomentId,
  type BreakDecl,
  type BreakOpened,
  type PlanInput,
  type SponsorAssignment,
  type SponsorCard,
  type SponsorPlan,
} from "../sponsor-plan";

const T0 = Date.parse("2026-10-31T10:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

const card = (key: string, tier: SponsorCard["tier"]): SponsorCard => ({
  id: `card-${key}`,
  sponsorId: `sponsor-${key}`,
  name: `${key} sponsor`,
  logoUrl: null,
  tier,
});
const TITLE = card("title", "title");
const GOLD = card("gold", "gold");

/** Two sports' declared breaks (engine 1.1.0, see the header): a minor and a major each. */
const SPORTS: Readonly<Record<string, { minor: BreakDecl; major: BreakDecl }>> = {
  cricket: { minor: { kind: "over_end", size: "minor" }, major: { kind: "innings_break", size: "major" } },
  badminton: { minor: { kind: "interval", size: "minor" }, major: { kind: "game_end", size: "major" } },
};

/** A minor at seq 8 and a major at seq 20, 10 s apart — both fresh at `now` (R2), the major never thinned (R4). */
function breaksOf(sport: string): BreakOpened[] {
  const d = SPORTS[sport]!;
  return [
    { seq: 8, at: iso(T0), ...d.minor },
    { seq: 20, at: iso(T0 + 10_000), ...d.major },
  ];
}

function input(breaks: readonly BreakOpened[], over: Partial<PlanInput> = {}): PlanInput {
  return {
    breaks,
    windowSeqs: breaks.map((b) => b.seq),
    settings: { enabled: true, frequency: "busy" },
    cards: [TITLE, GOLD],
    assignedCards: [],
    assigned: [],
    operatorLog: [],
    nextPosition: 0,
    now: T0 + 15_000,
    complete: true,
    ...over,
  };
}

const F = OVERLAY_MOMENT_FOLD_MS;
const T = { foldMs: F, holdMs: OVERLAY_MOMENT_HOLD_MS };
const enqueue = (s: MomentQueueState, moments: readonly OverlayMoment[], now: number) =>
  reduce(s, { type: "enqueue", moments, now, ...T });

describe("sponsorMoments — the empty cases first", () => {
  it("sponsorMoments(null) is [] (rotation off, or no card at all)", () => {
    expect(sponsorMoments(null)).toEqual([]);
  });

  it("a plan with cards but no airings yields no moment", () => {
    expect(sponsorMoments({ cards: [TITLE], airings: [] })).toEqual([]);
  });

  it("the real planner's null plan (settings off) is [] too — no seam can invent a card", () => {
    const { plan } = planSponsors(input(breaksOf("cricket"), { settings: { enabled: false, frequency: "busy" } }));
    expect(plan, "premise: the planner returns null").toBeNull();
    expect(sponsorMoments(plan)).toEqual([]);
  });
});

describe("sponsorMoments — one moment per airing, for two sports' break kinds", () => {
  it("each airing → a sponsor moment whose queue id IS the airing's moment id, held by its size's declared hold", () => {
    let checked = 0;
    for (const sport of Object.keys(SPORTS)) {
      const breaks = breaksOf(sport);
      const { plan } = planSponsors(input(breaks));
      expect(plan?.airings.length, `${sport}: premise: both breaks air`).toBe(2);
      const moments = sponsorMoments(plan);
      expect(moments).toHaveLength(plan!.airings.length);
      for (const [k, b] of breaks.entries()) {
        const airing = plan!.airings[k]!;
        const m = moments[k]!;
        const look = SPONSOR_STYLE_BY_SIZE[b.size];
        // Identity: the queue's `${seq}:${kind}` must equal S4's id and the served airing's id — S7's end line and
        // S8's join both carry it.
        expect(m.kind, `${sport} ${b.kind}`).toBe(`sponsor.${b.kind}`);
        expect(momentIdOf(m)).toBe(sponsorMomentId(b.seq, b.kind));
        expect(momentIdOf(m)).toBe(airing.momentId);
        expect(m.seq).toBe(b.seq);
        // What the queue reads: the priority, and the per-item hold that overrides the action's.
        expect(m.priority).toBe("sponsor");
        expect(m.graphic).toBe("sponsor");
        expect(m.holdMs, `${sport} ${b.kind}: the ${b.size} hold`).toBe(look.holdMs);
        expect(m.sponsor).toEqual({ cardId: airing.cardId, style: look.style, breakKind: b.kind });
        const shown = plan!.cards.find((c) => c.id === airing.cardId)!;
        expect(m.headline, "the card's own name").toBe(shown.name);
        checked++;
      }
    }
    console.log(`sponsor moments checked: ${checked}`);
    expect(checked, "anti-vacuity: 2 sports × 2 breaks").toBe(4);
  });

  it("the two hold lengths really differ, so a single constant could not pass the sweep above", () => {
    expect(SPONSOR_STYLE_BY_SIZE.minor.holdMs).not.toBe(SPONSOR_STYLE_BY_SIZE.major.holdMs);
    expect(SPONSOR_STYLE_BY_SIZE.minor.holdMs).not.toBe(OVERLAY_MOMENT_HOLD_MS);
  });

  it("an unticked-but-assigned card still airs as itself (plan.cards carries it; S4 untick ruling)", () => {
    const breaks = breaksOf("cricket");
    const first = planSponsors(input(breaks));
    const assigned = first.newAssignments;
    const goldAirs = assigned.filter((a) => a.sponsorId === GOLD.sponsorId);
    expect(goldAirs.length, "premise: the rotation handed gold a break").toBeGreaterThan(0);
    // Gold is unticked; its frozen break still airs through `assignedCards`.
    const { plan } = planSponsors(input(breaks, { cards: [TITLE], assignedCards: [GOLD], assigned, now: T0 + 60_000 }));
    const moments = sponsorMoments(plan);
    const gold = moments.filter((m) => m.sponsor?.cardId === GOLD.id);
    expect(gold.map(momentIdOf)).toEqual(goldAirs.map((a) => a.momentId));
    expect(gold.every((m) => m.headline === GOLD.name)).toBe(true);
  });
});

describe("sponsorMoments — refusals (a malformed plan costs a card, never the overlay)", () => {
  const good = (): NonNullable<SponsorPlan> => planSponsors(input(breaksOf("cricket"))).plan!;

  it("an airing whose card the plan does not carry yields no moment; the others still do", () => {
    const plan = good();
    const [first, second] = plan.airings;
    const broken: SponsorPlan = { cards: plan.cards, airings: [{ ...first!, cardId: "card-nobody" }, second!] };
    expect(sponsorMoments(broken).map(momentIdOf)).toEqual([second!.momentId]);
  });

  it("an airing whose momentId is not `${seq}:sponsor.${breakKind}` yields no moment (the queue id would not join)", () => {
    const plan = good();
    const [first, second] = plan.airings;
    const broken: SponsorPlan = { cards: plan.cards, airings: [first!, { ...second!, momentId: `${second!.seq}:sponsor.other` }] };
    expect(sponsorMoments(broken).map(momentIdOf)).toEqual([first!.momentId]);
  });
});

describe("sponsorMoments — the sequence through the real queue", () => {
  it("a second poll's plan (assignments now frozen) yields the same moments, and the queue airs each ONCE", () => {
    const breaks = breaksOf("cricket");
    const poll1 = planSponsors(input(breaks));
    // S5's flow: poll 1's new assignments are persisted; poll 2 reads them back as the frozen set.
    const assigned: SponsorAssignment[] = poll1.newAssignments;
    const poll2 = planSponsors(input(breaks, { assigned, now: T0 + 18_000 }));
    expect(poll2.newAssignments, "premise: nothing new on the re-poll").toEqual([]);
    const m1 = sponsorMoments(poll1.plan);
    const m2 = sponsorMoments(poll2.plan);
    expect(m2).toEqual(m1);

    let s = enqueue(INITIAL, m1, 0);
    const accepted = s.seen.length;
    s = enqueue(s, m2, 1_000);
    expect(s.seen.length, "the re-poll accepted nothing new").toBe(accepted);
    const queuedIds = [s.current, ...s.queue].filter((m) => m !== null).map((m) => momentIdOf(m!));
    expect(queuedIds).toEqual(m1.map(momentIdOf));
  });

  describe("after an undone break (the plan drops its airing)", () => {
    const breaks = breaksOf("badminton");
    const poll1 = planSponsors(input(breaks));
    const before = sponsorMoments(poll1.plan);
    const [minor, major] = before;
    /** The re-poll after the scorer undid one break's event: the complete replay no longer opens it. */
    const afterUndoOf = (kept: BreakOpened) =>
      planSponsors(input([kept], { assigned: poll1.newAssignments, now: T0 + 18_000 }));

    it("the card ON AIR folds off, and the other card stays queued", () => {
      expect(before, "premise: two cards").toHaveLength(2);
      const poll2 = afterUndoOf(breaks[1]!);
      const after = sponsorMoments(poll2.plan);
      expect(after.map(momentIdOf)).toEqual([momentIdOf(major!)]);
      expect(poll2.undone.map((a) => a.momentId), "S5 is handed the undone assignment").toEqual([momentIdOf(minor!)]);

      let s = enqueue(INITIAL, before, 0);
      s = reduce(s, { type: "tick", now: F, ...T }); // the minor's card: in → hold
      s = reduce(s, { type: "sync", live: after, now: 1_000, ...T });
      expect(momentIdOf(s.current!)).toBe(momentIdOf(minor!));
      expect(s.phase, "struck: folding off, not holding a break that never happened").toBe("out");
      expect(s.cutShort, "and it ran short: the report must not claim a full showing").toEqual([momentIdOf(minor!)]);
      expect(s.queue.map(momentIdOf)).toEqual([momentIdOf(major!)]);
      expect(s.seen, "a sponsor id is never forgotten (fix round 1)").toContain(momentIdOf(minor!));
    });

    it("the card still QUEUED never reaches air", () => {
      const after = sponsorMoments(afterUndoOf(breaks[0]!).plan);
      expect(after.map(momentIdOf)).toEqual([momentIdOf(minor!)]);
      let s = enqueue(INITIAL, before, 0);
      s = reduce(s, { type: "sync", live: after, now: 500, ...T });
      expect(s.queue).toEqual([]);
      const aired = new Set<string>();
      for (let now = 1_000; now <= 60_000; now += 250) {
        s = reduce(s, { type: "tick", now, ...T });
        if (s.current !== null) aired.add(momentIdOf(s.current));
      }
      expect([...aired], "only the minor's card ran out").toEqual([momentIdOf(minor!)]);
      expect(s.seen, "a sponsor id is never forgotten (fix round 1)").toContain(momentIdOf(major!));
      expect(s.current).toBeNull();
    });
  });

  // Fix round 1 (reviewer I1): a card that already aired must never air again because its airing left `live` and came
  // back. Two real paths, each driven the way the hook drives every poll: `sync` against the poll's moments, then
  // `enqueue` them.
  describe("a card that aired never airs again (fix round 1)", () => {
    const poll = (s: MomentQueueState, moments: readonly OverlayMoment[], now: number) => {
      const synced = reduce(s, { type: "sync", live: moments, now, ...T });
      return moments.length === 0 ? synced : enqueue(synced, moments, now);
    };
    /** Poll 1 hands the over_end break at seq 8 its card; the card runs its whole showing. */
    function airedOnce() {
      const brk: BreakOpened = { seq: 8, at: iso(T0), ...SPORTS.cricket!.minor };
      const poll1 = planSponsors(input([brk], { windowSeqs: [1, 2, 3, 4, 5, 6, 7, 8], now: T0 + 2_000 }));
      const card = sponsorMoments(poll1.plan);
      expect(card, "premise: one card").toHaveLength(1);
      let s = poll(INITIAL, card, 0);
      for (let now = F; s.current !== null; now = s.deadline!) s = reduce(s, { type: "tick", now, ...T });
      return { brk, card: card[0]!, assigned: poll1.newAssignments, state: s };
    }

    it("the window scrolls past the break, the scorer undoes a ball, the window shifts back: the card stays off air", () => {
      const { brk, card, assigned, state } = airedOnce();
      let s = state;
      expect(s.seen).toContain(momentIdOf(card));
      // Eight more balls: the window is seqs 9..16, so the frozen break is outside it and the plan airs nothing.
      const scrolled = planSponsors(input([brk], { assigned, windowSeqs: [9, 10, 11, 12, 13, 14, 15, 16], now: T0 + 240_000 }));
      expect(scrolled.plan?.airings, "premise: the plan dropped the airing").toEqual([]);
      s = poll(s, sponsorMoments(scrolled.plan), 240_000);
      // The scorer undoes ball 16: the window is 8..15 again, and the frozen break's airing is back in the plan.
      const back = planSponsors(input([brk], { assigned, windowSeqs: [8, 9, 10, 11, 12, 13, 14, 15], now: T0 + 245_000 }));
      expect(sponsorMoments(back.plan).map(momentIdOf), "premise: the airing returned").toEqual([momentIdOf(card)]);
      const before = s;
      s = poll(s, sponsorMoments(back.plan), 245_000);
      expect(s, "nothing new: the same state").toBe(before);
      expect(s.current).toBeNull();
    });

    it("a poll carrying a null plan, then the plan again: the card stays off air", () => {
      const { brk, card, assigned, state } = airedOnce();
      let s = poll(state, sponsorMoments(null), 30_000);
      const again = planSponsors(input([brk], { assigned, windowSeqs: [1, 2, 3, 4, 5, 6, 7, 8], now: T0 + 35_000 }));
      expect(sponsorMoments(again.plan).map(momentIdOf), "premise: the airing returned").toEqual([momentIdOf(card)]);
      const before = s;
      s = poll(s, sponsorMoments(again.plan), 35_000);
      expect(s).toBe(before);
      expect(s.current).toBeNull();
    });
  });

  it("isSponsorMomentId: true for every sponsor moment's id, false for score kinds sharing its seq", () => {
    let checked = 0;
    for (const sport of Object.keys(SPORTS)) {
      for (const m of sponsorMoments(planSponsors(input(breaksOf(sport))).plan)) {
        expect(isSponsorMomentId(momentIdOf(m)), momentIdOf(m)).toBe(true);
        expect(isSponsorMomentId(`${m.seq}:six`)).toBe(false);
        checked++;
      }
    }
    expect(checked).toBe(4);
  });

  it("an empty plan after a full plan: sync folds the card on air away (the plan no longer carries it)", () => {
    const { plan } = planSponsors(input(breaksOf("cricket")));
    let s = enqueue(INITIAL, sponsorMoments(plan), 0);
    s = reduce(s, { type: "tick", now: F, ...T }); // in → hold
    s = reduce(s, { type: "sync", live: sponsorMoments(null), now: 1_000, ...T });
    expect(s.phase).toBe("out");
    expect(s.queue).toEqual([]);
  });
});
