// R4 sponsors on stream, S6: sponsor moments in the ONE moment queue, behind score moments (spec 2026-10-27 §3.4;
// scenario 2026-09-29 rule 1 — "a sponsor card is just another moment kind ... never covering a score change").
//
// Where the expected values come from — never from the reducer:
//   - the stale cut: `SPONSOR_STALE_MS` (spec §3.4 "a sponsor moment waiting > 20 s is dropped");
//   - the holds: `SPONSOR_STYLE_BY_SIZE` (spec §3.2), `END_OF_OVER_HOLD_MS`, `OVERLAY_MOMENT_HOLD_MS` / `_FOLD_MS`;
//   - the air order: spec §3.4 — score first, whatever the arrival order; the stage's own order among score moments
//     ("moments first, then end-of-over", `overlay-stage.tsx`).
// Sponsor moments are built by the real `sponsorMoments` from a plan (its own suite: `lib/__tests__/overlay-moments-
// sponsor.test.ts`). The two real-ledger cases use the real engine fold and the real server projection.
//
// What the end-to-end owes (S15, CI dispatch): the stage concatenating `sponsorMoments` into the one `incoming` list,
// "cooldown honoured" and "score cuts a sponsor card" on the OBS page.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { defaultLineupPair, makeEnvelope, SIM_CONFIGS } from "@seazn/engine/testkit";
import { buildOverlayRecent, overlayCricketBundleIds, replayDerived } from "@/server/overlay/recent";
import { CLOSED_OVER_BASELINE_NONE, END_OF_OVER_HOLD_MS, endOfOverMoment } from "@/lib/overlay-end-of-over";
import { isSponsorMomentId, momentsFor, sponsorMoments, type OverlayMoment } from "@/lib/overlay-moments";
import {
  SPONSOR_STALE_MS,
  SPONSOR_STYLE_BY_SIZE,
  planSponsors,
  sponsorMomentId,
  type BreakDecl,
  type BreakOpened,
  type SponsorCard,
} from "@/lib/sponsor-plan";
import { INITIAL, momentIdOf, momentQueueReducer as reduce, type MomentQueueState, type QueueAction } from "../moment-queue";
import { OVERLAY_MOMENT_FOLD_MS, OVERLAY_MOMENT_HOLD_MS } from "../moment-timing";

const F = OVERLAY_MOMENT_FOLD_MS;
const H = OVERLAY_MOMENT_HOLD_MS;
const T = { foldMs: F, holdMs: H };

const m = (seq: number, kind = "goal", holdMs?: number): OverlayMoment => ({
  seq,
  kind,
  headline: kind.toUpperCase(),
  tone: "led",
  ...(holdMs === undefined ? {} : { holdMs }),
});

const TITLE: SponsorCard = { id: "card-title", sponsorId: "sponsor-title", name: "Title sponsor", logoUrl: null, tier: "title", onStream: true };
const OVER_END: BreakDecl = { kind: "over_end", size: "minor" }; // engine 1.1.0 cricket.ts:4697
const INNINGS_BREAK: BreakDecl = { kind: "innings_break", size: "major" }; // engine 1.1.0 cricket.ts:4698

/** One sponsor moment, through the real `sponsorMoments` (a hand-built plan with one airing of the declared look). */
function sp(seq: number, d: BreakDecl = OVER_END): OverlayMoment {
  const look = SPONSOR_STYLE_BY_SIZE[d.size];
  const [moment] = sponsorMoments({
    cards: [TITLE],
    airings: [
      { momentId: sponsorMomentId(seq, d.kind), seq, cardId: TITLE.id, style: look.style, holdMs: look.holdMs, breakKind: d.kind },
    ],
  });
  if (moment === undefined) throw new Error("premise: sponsorMoments built no moment");
  return moment;
}

const enqueue = (s: MomentQueueState, moments: readonly OverlayMoment[], now: number, foldMs = F) =>
  reduce(s, { type: "enqueue", moments, now, foldMs, holdMs: H });
const tick = (s: MomentQueueState, now: number, foldMs = F) => reduce(s, { type: "tick", now, foldMs, holdMs: H });
const skip = (s: MomentQueueState, momentId: string, now: number, foldMs = F) =>
  reduce(s, { type: "skip", momentId, now, foldMs });
const ids = (list: readonly OverlayMoment[]) => list.map(momentIdOf);

interface Airing {
  id: string;
  inAt: number;
  holdAt?: number;
  outAt?: number;
  endAt?: number;
}

/** Drive the queue deadline by deadline until idle, and write down every airing. */
function airTimeline(start: MomentQueueState, startAt: number, foldMs = F): { airings: Airing[]; state: MomentQueueState } {
  let s = start;
  let now = startAt;
  const airings: Airing[] = [];
  const observe = () => {
    const last = airings.at(-1);
    if (s.current === null) {
      if (last !== undefined && last.endAt === undefined) last.endAt = now;
      return;
    }
    const id = momentIdOf(s.current);
    if (last === undefined || last.endAt !== undefined || last.id !== id || (s.phase === "in" && last.outAt !== undefined)) {
      if (last !== undefined && last.endAt === undefined) last.endAt = now;
      airings.push({ id, inAt: now });
    }
    const a = airings.at(-1)!;
    if (s.phase === "hold" && a.holdAt === undefined) a.holdAt = now;
    if (s.phase === "out" && a.outAt === undefined) a.outAt = now;
  };
  observe();
  for (let i = 0; i < 500 && s.deadline !== null; i++) {
    now = s.deadline;
    s = tick(s, now, foldMs);
    observe();
  }
  expect(s.current, "the queue drained").toBeNull();
  return { airings, state: s };
}

describe("priority — the empty case first: no sponsor moment, no change", () => {
  it("a queue of score moments only stays FIFO across batches (the partition is the identity)", () => {
    let s = enqueue(INITIAL, [m(1, "goal"), m(2, "six")], 0);
    s = enqueue(s, [m(3, "four")], 1_000);
    expect(ids(s.queue)).toEqual(["2:six", "3:four"]);
    expect(s.cutShort).toEqual([]);
    expect(s.queuedAt).toEqual({});
  });

  it("INITIAL carries no cut-short id and no sponsor wait", () => {
    expect(INITIAL.cutShort).toEqual([]);
    expect(INITIAL.queuedAt).toEqual({});
  });
});

describe("priority — score moments always outrank sponsor moments", () => {
  it("a score moment enqueued behind a queued sponsor card airs first", () => {
    let s = enqueue(INITIAL, [m(1, "goal")], 0); // on air
    s = enqueue(s, [sp(8)], 500); // the card waits behind it
    s = enqueue(s, [m(9, "six")], 1_000); // a later score moment
    expect(ids(s.queue), "the score moment jumped the card").toEqual(["9:six", momentIdOf(sp(8))]);
    const { airings } = airTimeline(s, 1_000);
    expect(airings.map((a) => a.id)).toEqual(["1:goal", "9:six", momentIdOf(sp(8))]);
  });

  it("in ONE batch a score moment at the same seq precedes the card, whatever the array order", () => {
    const s = enqueue(INITIAL, [sp(8), m(8, "six"), m(8, "six.bis")], 0);
    expect(momentIdOf(s.current!)).toBe("8:six");
    expect(ids(s.queue)).toEqual(["8:six.bis", momentIdOf(sp(8))]);
  });

  it("two sponsor cards keep their own order behind every score moment", () => {
    let s = enqueue(INITIAL, [m(1)], 0);
    s = enqueue(s, [sp(8), m(9, "four"), sp(20, INNINGS_BREAK), m(21, "six")], 100);
    expect(ids(s.queue)).toEqual(["9:four", "21:six", momentIdOf(sp(8)), momentIdOf(sp(20, INNINGS_BREAK))]);
  });

  it("a score moment while a sponsor card HOLDS sends it to out, and cutShort contains its id", () => {
    let s = enqueue(INITIAL, [sp(8)], 0);
    s = tick(s, F); // in → hold
    expect(s.phase, "premise: the card is holding").toBe("hold");
    s = enqueue(s, [m(9, "six")], 3_000);
    expect(momentIdOf(s.current!)).toBe(momentIdOf(sp(8)));
    expect(s.phase, "cut: folding off now").toBe("out");
    expect(s.deadline).toBe(3_000 + F);
    expect(s.cutShort).toEqual([momentIdOf(sp(8))]);
    expect(ids(s.queue)).toEqual(["9:six"]);
    s = tick(s, 3_000 + F);
    expect(s).toMatchObject({ current: m(9, "six"), phase: "in" });
    expect(s.cutShort, "kept after the card left air: S7's end line reads it").toEqual([momentIdOf(sp(8))]);
  });

  it("a score moment while a sponsor card is still folding IN cuts it too", () => {
    let s = enqueue(INITIAL, [sp(8)], 0);
    expect(s.phase).toBe("in");
    s = enqueue(s, [m(9, "six")], 100);
    expect(s.phase).toBe("out");
    expect(s.deadline).toBe(100 + F);
    expect(s.cutShort).toEqual([momentIdOf(sp(8))]);
  });

  it("a card already folding out on its own is not cut short, and its fold is not restarted", () => {
    let s = enqueue(INITIAL, [sp(8)], 0);
    s = tick(s, F);
    const holdEnd = s.deadline!;
    s = tick(s, holdEnd); // hold → out, naturally
    const outDeadline = s.deadline;
    s = enqueue(s, [m(9, "six")], holdEnd + 100);
    expect(s.phase).toBe("out");
    expect(s.deadline).toBe(outDeadline);
    expect(s.cutShort).toEqual([]);
  });

  it("a card that runs its whole hold is never in cutShort", () => {
    const { state } = airTimeline(enqueue(INITIAL, [sp(8)], 0), 0);
    expect(state.cutShort).toEqual([]);
  });

  it("only a FRESH score moment cuts: a re-sent window does not, and a second card queues behind the first", () => {
    let s = enqueue(INITIAL, [m(1, "goal")], 0);
    for (const now of [F, F + H, F + H + F]) s = tick(s, now); // the goal has had its turn
    s = enqueue(s, [m(1, "goal"), sp(8)], 3_000);
    s = tick(s, 3_000 + F); // the card holds
    const holding = s;
    s = enqueue(s, [m(1, "goal"), sp(8)], 4_000); // the poll re-sends the window
    expect(s, "nothing new: the same state").toBe(holding);
    s = enqueue(s, [sp(20, INNINGS_BREAK)], 4_500);
    expect(s.phase, "a sponsor never cuts a sponsor").toBe("hold");
    expect(s.cutShort).toEqual([]);
    expect(ids(s.queue)).toEqual([momentIdOf(sp(20, INNINGS_BREAK))]);
  });

  it("a sponsor card never interrupts a score moment on air", () => {
    let s = enqueue(INITIAL, [m(1, "wicket")], 0);
    s = tick(s, F);
    const before = { current: s.current, phase: s.phase, deadline: s.deadline };
    s = enqueue(s, [sp(8)], 500);
    expect({ current: s.current, phase: s.phase, deadline: s.deadline }).toEqual(before);
    expect(ids(s.queue)).toEqual([momentIdOf(sp(8))]);
  });
});

describe("the stale cut — a card that missed its break is dropped, not shown late", () => {
  /** A score moment whose run ends exactly `waitMs` after t = 0: fold in, hold, fold out. */
  const blocker = (waitMs: number) => m(1, "goal", waitMs - 2 * F);

  it(`a sponsor moment queued > SPONSOR_STALE_MS is dropped and seen; at exactly ${SPONSOR_STALE_MS} ms it still airs`, () => {
    // At exactly the limit: the card airs.
    let s = enqueue(INITIAL, [blocker(SPONSOR_STALE_MS), sp(8)], 0);
    for (const now of [F, SPONSOR_STALE_MS - F, SPONSOR_STALE_MS]) s = tick(s, now);
    expect(s.current && momentIdOf(s.current), "waited exactly the limit: airs").toBe(momentIdOf(sp(8)));
    expect(s.phase).toBe("in");

    // One millisecond past: dropped, seen, and the queue idles.
    s = enqueue(INITIAL, [blocker(SPONSOR_STALE_MS + 1), sp(8)], 0);
    for (const now of [F, SPONSOR_STALE_MS + 1 - F, SPONSOR_STALE_MS + 1]) s = tick(s, now);
    expect(s.current, "waited 1 ms too long: never airs").toBeNull();
    expect(s.queue).toEqual([]);
    expect(s.queuedAt).toEqual({});
    expect(s.seen).toContain(momentIdOf(sp(8)));
    // The poll re-sends the window: the dropped card cannot queue again.
    const after = enqueue(s, [blocker(SPONSOR_STALE_MS + 1), sp(8)], SPONSOR_STALE_MS + 2_000);
    expect(after).toBe(s);
  });

  it("the wait is counted from when THIS card was queued: a stale card is dropped and a fresher one behind it airs", () => {
    let s = enqueue(INITIAL, [blocker(SPONSOR_STALE_MS + 1), sp(8)], 0);
    s = enqueue(s, [sp(20, INNINGS_BREAK)], 15_000);
    expect(s.queuedAt).toEqual({ [momentIdOf(sp(8))]: 0, [momentIdOf(sp(20, INNINGS_BREAK))]: 15_000 });
    for (const now of [F, SPONSOR_STALE_MS + 1 - F, SPONSOR_STALE_MS + 1]) s = tick(s, now);
    expect(momentIdOf(s.current!)).toBe(momentIdOf(sp(20, INNINGS_BREAK)));
    expect(s.queuedAt, "nothing queued, nothing timed").toEqual({});
  });

  it("score moments are never dropped for waiting, however long", () => {
    let s = enqueue(INITIAL, [blocker(SPONSOR_STALE_MS * 3), m(2, "six")], 0);
    for (const now of [F, SPONSOR_STALE_MS * 3 - F, SPONSOR_STALE_MS * 3]) s = tick(s, now);
    expect(s.current).toMatchObject({ seq: 2, kind: "six" });
  });

  it("a queued sponsor moment with no recorded wait is treated as stale: a card of unknown age never airs", () => {
    // Unreachable through the reducer's own actions (enqueue always times a card). The guard stands anyway.
    const s0 = enqueue(INITIAL, [m(1, "goal"), sp(8)], 0);
    const corrupt: MomentQueueState = { ...s0, queuedAt: {} };
    let s = corrupt;
    for (const now of [F, F + H, F + H + F]) s = tick(s, now);
    expect(s.current).toBeNull();
  });
});

describe("holds — a sponsor moment holds its own size's declared hold, not the action's", () => {
  it("a sponsor moment holds SPONSOR_STYLE_BY_SIZE[size].holdMs, not the action holdMs (both sizes)", () => {
    let checked = 0;
    for (const d of [OVER_END, INNINGS_BREAK]) {
      const { airings } = airTimeline(enqueue(INITIAL, [sp(8, d)], 0), 0);
      expect(airings).toHaveLength(1);
      const a = airings[0]!;
      expect(a.outAt! - a.holdAt!, d.kind).toBe(SPONSOR_STYLE_BY_SIZE[d.size].holdMs);
      expect(a.outAt! - a.holdAt!).not.toBe(H);
      checked++;
    }
    console.log(`sponsor holds checked: ${checked}`);
    expect(checked).toBe(2);
  });
});

describe("Final, reduced motion, sync — sponsor moments are moments like any other", () => {
  it("Final discard marks sponsor moments seen and queues none; a later poll cannot air them", () => {
    const s = reduce(INITIAL, { type: "discard", moments: [sp(8), m(9, "six")] });
    expect(s.queue).toEqual([]);
    expect(s.current).toBeNull();
    expect(s.seen).toEqual(expect.arrayContaining([momentIdOf(sp(8)), "9:six"]));
    expect(enqueue(s, [sp(8)], 1_000).current).toBeNull();
  });

  it("flush drops a queued card (it stays seen, and its wait is forgotten)", () => {
    let s = enqueue(INITIAL, [m(1), sp(8)], 0);
    s = reduce(s, { type: "flush" });
    expect(s.queue).toEqual([]);
    expect(s.queuedAt).toEqual({});
    expect(s.seen).toContain(momentIdOf(sp(8)));
  });

  it("reduced motion (foldMs 0): a cut card leaves at once and the next tick promotes the score moment", () => {
    let s = enqueue(INITIAL, [sp(8)], 0, 0);
    s = tick(s, 0, 0); // in → hold
    s = enqueue(s, [m(9, "six")], 2_000, 0);
    expect(s).toMatchObject({ phase: "out", deadline: 2_000 });
    const revision = s.revision;
    s = tick(s, 2_000, 0);
    expect(s).toMatchObject({ current: m(9, "six"), phase: "in", deadline: 2_000 });
    expect(s.revision, "the repeated deadline still re-arms the timer").toBeGreaterThan(revision);
  });

  it("an undo of its break while the card is on air folds it off AND records it in cutShort (controller ruling 2026-10-31)", () => {
    // The sponsor report must not claim a full showing for a card that ran short.
    let s = enqueue(INITIAL, [sp(8)], 0);
    s = tick(s, F); // holding
    s = reduce(s, { type: "sync", live: [], now: 2_000, ...T });
    expect(s).toMatchObject({ phase: "out", deadline: 2_000 + F });
    expect(s.cutShort).toEqual([momentIdOf(sp(8))]);
    // Folding in counts too.
    s = enqueue(INITIAL, [sp(8)], 0);
    s = reduce(s, { type: "sync", live: [], now: 100, ...T });
    expect(s.cutShort).toEqual([momentIdOf(sp(8))]);
  });

  it("an undo records nothing for a score slab, nor for a card already folding out on its own", () => {
    let s = enqueue(INITIAL, [m(1, "six")], 0);
    s = tick(s, F);
    s = reduce(s, { type: "sync", live: [], now: 1_000, ...T });
    expect(s.phase, "premise: the slab is struck off").toBe("out");
    expect(s.cutShort, "cutShort is the sponsor report's flag; a score slab has no airing").toEqual([]);

    s = enqueue(INITIAL, [sp(8)], 0);
    s = tick(s, F);
    s = tick(s, s.deadline!); // hold ran its course: folding out
    s = reduce(s, { type: "sync", live: [], now: s.deadline! - 1, ...T });
    expect(s.cutShort, "it held its full time").toEqual([]);
  });

  it("fix round 1: a card that aired is never forgotten — sync without it, then the same card again, changes nothing", () => {
    const { state } = airTimeline(enqueue(INITIAL, [sp(8)], 0), 0);
    let s = reduce(state, { type: "sync", live: [], now: 60_000, ...T });
    expect(s.seen).toContain(momentIdOf(sp(8)));
    const before = s;
    s = enqueue(s, [sp(8)], 245_000);
    expect(s).toBe(before);
  });

  it("fix round 1: a score moment is still forgotten by sync, so an end-of-over re-airs after undo + recomplete", () => {
    const eoo: OverlayMoment = { seq: 1001, kind: "endOfOver", graphic: "endOfOver", headline: "End of over 1", tone: "led" };
    const { state } = airTimeline(enqueue(INITIAL, [eoo, sp(8)], 0), 0);
    let s = reduce(state, { type: "sync", live: [], now: 60_000, ...T });
    expect(s.seen).toEqual([momentIdOf(sp(8))]);
    s = enqueue(s, [eoo, sp(8)], 61_000);
    expect(momentIdOf(s.current!), "the over card airs again; the sponsor card does not").toBe("1001:endOfOver");
    expect(s.queue).toEqual([]);
  });

  it("sync drops a struck card from the queue and from the waits", () => {
    let s = enqueue(INITIAL, [m(1), sp(8), sp(20, INNINGS_BREAK)], 0);
    s = reduce(s, { type: "sync", live: [m(1), sp(20, INNINGS_BREAK)], now: 100, ...T });
    expect(ids(s.queue)).toEqual([momentIdOf(sp(20, INNINGS_BREAK))]);
    expect(Object.keys(s.queuedAt)).toEqual([momentIdOf(sp(20, INNINGS_BREAK))]);
  });
});

describe("skip — the console's Skip this card (C4 dispatches it; inert until then)", () => {
  it("skip folds only the named moment (on air → out + cutShort; queued → removed + seen)", () => {
    // On air.
    let s = enqueue(INITIAL, [sp(8), sp(20, INNINGS_BREAK)], 0);
    s = tick(s, F);
    s = skip(s, momentIdOf(sp(8)), 2_000);
    expect(s).toMatchObject({ phase: "out", deadline: 2_000 + F });
    expect(s.cutShort).toEqual([momentIdOf(sp(8))]);
    expect(ids(s.queue), "the other card is untouched").toEqual([momentIdOf(sp(20, INNINGS_BREAK))]);

    // Queued.
    s = enqueue(INITIAL, [m(1, "goal"), sp(8), sp(20, INNINGS_BREAK)], 0);
    s = skip(s, momentIdOf(sp(8)), 500);
    expect(ids(s.queue)).toEqual([momentIdOf(sp(20, INNINGS_BREAK))]);
    expect(Object.keys(s.queuedAt)).toEqual([momentIdOf(sp(20, INNINGS_BREAK))]);
    expect(s.seen, "seen: a re-sent window cannot queue it again").toContain(momentIdOf(sp(8)));
    expect(s.cutShort, "never aired, so never cut short").toEqual([]);
    expect(enqueue(s, [sp(8)], 600)).toBe(s);
    const { airings } = airTimeline(s, 600);
    expect(airings.map((a) => a.id)).toEqual(["1:goal", momentIdOf(sp(20, INNINGS_BREAK))]);
  });

  it("a card folding in is skipped to out as well", () => {
    let s = enqueue(INITIAL, [sp(8)], 0);
    s = skip(s, momentIdOf(sp(8)), 100);
    expect(s).toMatchObject({ phase: "out", deadline: 100 + F });
    expect(s.cutShort).toEqual([momentIdOf(sp(8))]);
  });

  it("the only card, skipped: once it has folded off and the queue idles, cutShort still names it (S7 reads it then)", () => {
    let s = enqueue(INITIAL, [sp(8)], 0);
    s = tick(s, F);
    s = skip(s, momentIdOf(sp(8)), 1_000);
    s = tick(s, 1_000 + F); // folded off; nothing queued
    expect(s.current).toBeNull();
    expect(s.cutShort).toEqual([momentIdOf(sp(8))]);
  });

  it("refusals: a score moment is never skipped; an unknown id, a card already leaving, a second skip change nothing", () => {
    let s = enqueue(INITIAL, [m(1, "goal"), m(2, "six"), sp(8)], 0);
    expect(skip(s, "1:goal", 100), "the slab on air").toBe(s);
    expect(skip(s, "2:six", 100), "a queued slab").toBe(s);
    expect(skip(s, "99:sponsor.over_end", 100), "never enqueued").toBe(s);

    s = enqueue(INITIAL, [sp(8)], 0);
    s = skip(s, momentIdOf(sp(8)), 100);
    expect(skip(s, momentIdOf(sp(8)), 150), "a second skip").toBe(s);

    s = enqueue(INITIAL, [sp(8)], 0);
    s = tick(s, F);
    s = tick(s, s.deadline!); // folding out on its own
    expect(skip(s, momentIdOf(sp(8)), s.deadline! - 1)).toBe(s);
  });
});

// ── the two real-ledger cases ─────────────────────────────────────────────────────────────────────────────────────

const T0 = Date.parse("2026-10-31T10:00:00.000Z");
const msg = ((key: string, vars?: Record<string, string | number>) => `${key}${vars ? JSON.stringify(vars) : ""}`) as never;
const SIDES: [string, string] = ["HOM", "AWY"];

function realLedger(key: string, stream: readonly (readonly [string, unknown])[]) {
  const mod = builtinModules.find((x) => x.key === key);
  if (mod === undefined) throw new Error(`no builtin module ${key}`);
  const cfg = mod.configSchema.parse(SIM_CONFIGS[key] ?? {});
  const lineups = defaultLineupPair(mod.positions);
  const events: EventEnvelope[] = stream.map(([type, payload], i) => ({
    ...makeEnvelope(i + 1, { type, payload } as never),
    recordedAt: new Date(T0 + i * 20_000).toISOString(),
  }));
  // Folding is the assertion that every payload is a shape the engine accepts.
  foldMatch(mod as never, cfg as never, lineups, events);
  const { bySeq } = replayDerived({ sportKey: key, module: mod as never, cfg: cfg as never, lineups, active: events, window: 40 });
  const recent = buildOverlayRecent({
    active: events,
    sides: [lineups.home.entrantId, lineups.away.entrantId],
    personOf: () => undefined,
    window: 40,
    derived: bySeq,
  });
  return { mod, cfg, lineups, events, recent };
}

/** The real planner's plan for one break opened by the ledger's LAST event (the engine's `opensAt` is S5's). */
function planForLastEvent(events: readonly EventEnvelope[], recentSeqs: readonly number[], d: BreakDecl) {
  const last = events.at(-1)!;
  const brk: BreakOpened = { seq: last.seq, at: last.recordedAt, ...d };
  return planSponsors({
    breaks: [brk],
    windowSeqs: recentSeqs,
    settings: { enabled: true, frequency: "busy" },
    cards: [TITLE],
    assignedCards: [],
    assigned: [],
    operatorLog: [],
    nextPosition: 0,
    now: Date.parse(last.recordedAt) + 2_000,
    complete: true,
  }).plan;
}

describe("cricket over end (single sport: the end-of-over card is cricket's alone)", () => {
  it("the real endOfOver moment (built from a real over's events) airs before the over_end sponsor card, and their hold windows never overlap", () => {
    const dot = (ballInOver: number) =>
      ["cricket.ball", { over: 0, ballInOver, striker: "H-p1", nonStriker: "H-p2", bowler: "A-p11", runs: { bat: 0 } }] as const;
    const { mod, cfg, lineups, events, recent } = realLedger("cricket", [
      ["cricket.toss", { wonBy: "H", elected: "bat" }],
      ["core.start", {}],
      ...[1, 2, 3, 4, 5].map(dot),
      ["cricket.ball", { over: 0, ballInOver: 6, striker: "H-p1", nonStriker: "H-p2", bowler: "A-p11", runs: { bat: 6 }, boundary: 6 }],
    ]);
    const last = events.at(-1)!;
    const closed = overlayCricketBundleIds({ sportKey: "cricket", module: mod as never, cfg, lineups }, events).lastClosedOver;
    expect(closed?.over, "premise: the ledger closed over 1").toBe(1);
    const eoo = endOfOverMoment({ closed, since: CLOSED_OVER_BASELINE_NONE, msg });
    expect(eoo, "premise: an end-of-over card").not.toBeNull();
    const slabs = momentsFor("cricket", recent, 0, msg, SIDES);
    expect(slabs.map((x) => `${x.seq}:${x.kind}`), "premise: the six on the over's last ball").toEqual([
      `${last.seq}:six`,
      `${last.seq}:six.bis`,
    ]);
    const card = sponsorMoments(planForLastEvent(events, recent.map((e) => e.seq), OVER_END));
    expect(card.map(momentIdOf)).toEqual([sponsorMomentId(last.seq, OVER_END.kind)]);

    // The stage's own order among score moments: moments first, then end-of-over (`overlay-stage.tsx`).
    const score = [...slabs, ...eoo!];
    // The queue keeps sponsor ids through `sync` by their id's shape: no real score moment may share it.
    for (const x of score) expect(isSponsorMomentId(momentIdOf(x)), momentIdOf(x)).toBe(false);
    let checked = 0;
    for (const [label, batch] of [
      ["the stage's order", [...score, ...card]],
      ["the card first", [...card, ...score]],
    ] as const) {
      const { airings } = airTimeline(enqueue(INITIAL, batch, 0), 0);
      expect(airings.map((a) => a.id), label).toEqual([...ids(score), momentIdOf(card[0]!)]);
      const overCards = airings.filter((a) => a.id.endsWith(":endOfOver") || a.id.endsWith(":endOfOver.bis"));
      expect(overCards, `${label}: both end-of-over beats`).toHaveLength(2);
      for (const a of overCards) expect(a.outAt! - a.holdAt!, `${label} ${a.id}`).toBe(END_OF_OVER_HOLD_MS);
      const sponsor = airings.at(-1)!;
      expect(sponsor.outAt! - sponsor.holdAt!).toBe(SPONSOR_STYLE_BY_SIZE.minor.holdMs);
      // Never overlapping: the card's first frame comes after the last over card's last frame.
      for (const a of airings.slice(0, -1)) expect(sponsor.inAt, `${label}: after ${a.id}`).toBeGreaterThanOrEqual(a.endAt!);
      expect(sponsor.inAt, `${label}: inside the stale cut, so it aired`).toBeLessThanOrEqual(SPONSOR_STALE_MS);
      checked++;
    }
    expect(checked).toBe(2);
  });
});

describe("badminton game end (another sport: a set-won slab before the game_end banner)", () => {
  it("the real setWon slab airs before the game_end sponsor banner, which holds the major hold", () => {
    const { events, recent } = realLedger("badminton", [
      ["core.start", {}],
      ...Array.from({ length: 21 }, () => ["badminton.rally", { wonBy: "H" }] as const),
    ]);
    const last = events.at(-1)!;
    const slabs = momentsFor("badminton", recent, 0, msg, SIDES).filter((x) => x.seq === last.seq);
    expect(slabs.map((x) => x.kind), "premise: the game-winning rally raises setWon").toContain("setWon");
    const GAME_END: BreakDecl = { kind: "game_end", size: "major" }; // engine 1.1.0 setbased/badminton.ts:113-114
    const card = sponsorMoments(planForLastEvent(events, recent.map((e) => e.seq), GAME_END));
    expect(card).toHaveLength(1);
    const { airings } = airTimeline(enqueue(INITIAL, [...card, ...slabs], 0), 0);
    expect(airings.map((a) => a.id)).toEqual([...ids(slabs), momentIdOf(card[0]!)]);
    const banner = airings.at(-1)!;
    expect(banner.outAt! - banner.holdAt!).toBe(SPONSOR_STYLE_BY_SIZE.major.holdMs);
  });
});

// ── the model: invariants after EVERY step of random action sequences (TEST-STRATEGY rule 10) ────────────────────────

describe("model — a sponsor never delays, covers or eats a score moment", () => {
  it("holds over random sequences of enqueue / tick / sync / skip / flush / discard (seeded)", () => {
    const score = [m(1, "goal"), m(2, "six"), m(3, "four"), m(4, "wicket")];
    const cards = [sp(5, OVER_END), sp(6, INNINGS_BREAK), sp(7, OVER_END)];
    const pool = [...score, ...cards];
    const isSponsor = (x: OverlayMoment) => x.priority === "sponsor";
    const cardIds = new Set(ids(cards));
    const counts = { steps: 0, cuts: 0, skipCuts: 0, undoCuts: 0, staleDrops: 0, sponsorAired: 0, scoreAired: 0, reoffered: 0 };

    type Step =
      | { op: "enqueue"; dt: number; moments: OverlayMoment[] }
      | { op: "tick"; dt: number }
      | { op: "due" }
      | { op: "sync"; dt: number; live: OverlayMoment[] }
      /** `target === pool.length`: whatever is on air (the console skips the card it sees). */
      | { op: "skip"; dt: number; target: number }
      | { op: "flush" }
      | { op: "discard"; moments: OverlayMoment[] };
    const dt = fc.integer({ min: 0, max: 12_000 });
    // Score-only, card-only and mixed polls, so a card on air is often met by a score moment AND often left alone.
    const batch = fc.oneof(
      fc.shuffledSubarray(score, { minLength: 1 }),
      fc.shuffledSubarray(cards, { minLength: 1 }),
      fc.shuffledSubarray(pool, { minLength: 1 }),
    );
    const step: fc.Arbitrary<Step> = fc.oneof(
      { weight: 4, arbitrary: fc.record({ op: fc.constant("enqueue" as const), dt, moments: batch }) },
      { weight: 3, arbitrary: fc.record({ op: fc.constant("tick" as const), dt }) },
      { weight: 4, arbitrary: fc.constant({ op: "due" as const }) },
      { weight: 1, arbitrary: fc.record({ op: fc.constant("sync" as const), dt, live: fc.subarray(pool) }) },
      { weight: 2, arbitrary: fc.record({ op: fc.constant("skip" as const), dt, target: fc.nat({ max: pool.length }) }) },
      { weight: 1, arbitrary: fc.constant({ op: "flush" as const }) },
      { weight: 1, arbitrary: fc.record({ op: fc.constant("discard" as const), moments: fc.subarray(pool, { minLength: 1 }) }) },
    );

    fc.assert(
      fc.property(fc.constantFrom(F, 0), fc.array(step, { minLength: 10, maxLength: 60, size: "max" }), (foldMs, steps) => {
        let s = INITIAL;
        let now = 0;
        // A card's wait is measured from its FIRST acceptance, never reset: a card is one showing of one break.
        const acceptedAt = new Map<string, number>();
        const airedCards = new Set<string>();
        /** Cards that aired and that a later poll's `live` no longer carried — the fix round 1 re-air path. */
        const leftLiveAfterAir = new Set<string>();
        for (const st of steps) {
          if ("dt" in st) now += st.dt;
          if (st.op === "due" && s.deadline !== null) now = Math.max(now, s.deadline);
          const action: QueueAction =
            st.op === "enqueue"
              ? { type: "enqueue", moments: st.moments, now, foldMs, holdMs: H }
              : st.op === "tick" || st.op === "due"
                ? { type: "tick", now, foldMs, holdMs: H }
                : st.op === "sync"
                  ? { type: "sync", live: st.live, now, foldMs, holdMs: H }
                  : st.op === "skip"
                    ? { type: "skip", momentId: st.target === pool.length ? (s.current === null ? "none" : momentIdOf(s.current)) : momentIdOf(pool[st.target]!), now, foldMs }
                    : st.op === "flush"
                      ? { type: "flush" }
                      : { type: "discard", moments: st.moments };
          const prev = s;
          s = reduce(prev, action);
          counts.steps++;
          if (action.type === "enqueue") {
            for (const id of s.seen) if (!prev.seen.includes(id) && !(cardIds.has(id) && acceptedAt.has(id))) acceptedAt.set(id, now);
            if (action.moments.some((x) => leftLiveAfterAir.has(momentIdOf(x)))) counts.reoffered++;
          }
          if (action.type === "sync") {
            const live = new Set(ids(action.live));
            for (const id of airedCards) if (!live.has(id)) leftLiveAfterAir.add(id);
          }

          // I1 — the queue is partitioned: no score moment waits behind a sponsor moment.
          const firstCard = s.queue.findIndex(isSponsor);
          if (firstCard !== -1) expect(s.queue.slice(firstCard).every(isSponsor), "partition").toBe(true);
          // I2 — never covering a score change: a card on air (in/hold) has no score moment waiting.
          if (s.current !== null && isSponsor(s.current) && s.phase !== "out") {
            expect(s.queue.some((x) => !isSponsor(x)), "a card covers a waiting score moment").toBe(false);
          }
          // I3 — no non-undo action disturbs a score moment on air before its own deadline.
          if (prev.current !== null && !isSponsor(prev.current) && prev.phase !== "out" && action.type !== "sync") {
            if (action.type !== "tick" || now < prev.deadline!) {
              expect(s.current).toBe(prev.current);
              expect(s.phase).toBe(prev.phase);
              expect(s.deadline).toBe(prev.deadline);
            }
          }
          // I4 — no score moment is eaten: outside undo and Final's flush, every queued one is still queued or on air.
          if (action.type !== "sync" && action.type !== "flush") {
            for (const x of prev.queue) if (!isSponsor(x)) expect(s.queue.includes(x) || s.current === x, "eaten").toBe(true);
          }
          // I5 — a card reaching air waited no longer than the stale cut since it was accepted.
          const promoted = s.current !== null && s.phase === "in" && !(prev.current === s.current && prev.phase === "in");
          if (promoted) {
            const id = momentIdOf(s.current!);
            if (isSponsor(s.current!)) {
              counts.sponsorAired++;
              expect(now - acceptedAt.get(id)!, `${id} aired stale`).toBeLessThanOrEqual(SPONSOR_STALE_MS);
              // I8 (fix round 1) — no card ever reaches air twice: proof of play counts each showing once.
              expect(airedCards.has(id), `${id} aired twice`).toBe(false);
              airedCards.add(id);
            } else counts.scoreAired++;
          }
          // I6 — the waits are exactly the queued cards'.
          expect(Object.keys(s.queuedAt).sort()).toEqual(ids(s.queue.filter(isSponsor)).sort());
          // I9 — each card is cut short at most once (it airs at most once).
          expect(new Set(s.cutShort).size, "a card cut twice").toBe(s.cutShort.length);
          // I7 — cutShort only ever gains the card that was on air (in/hold): by a score moment, a skip, or an undo.
          const gained = s.cutShort.slice(prev.cutShort.length);
          if (gained.length > 0) {
            expect(gained).toEqual([momentIdOf(prev.current!)]);
            expect(isSponsor(prev.current!) && prev.phase !== "out").toBe(true);
            expect(["enqueue", "skip", "sync"]).toContain(action.type);
            if (action.type === "enqueue") counts.cuts++;
            else if (action.type === "skip") counts.skipCuts++;
            else counts.undoCuts++;
          }
          if (action.type === "tick") {
            for (const x of prev.queue) {
              if (isSponsor(x) && !s.queue.includes(x) && s.current !== x) counts.staleDrops++;
            }
          }
        }
      }),
      { numRuns: 300, seed: 20261031 },
    );
    console.log(`model: ${JSON.stringify(counts)}`);
    // Anti-vacuity: every rule the invariants guard was actually exercised.
    for (const [k, v] of Object.entries(counts)) expect(v, `model reached no ${k}`).toBeGreaterThan(0);
  });
});
