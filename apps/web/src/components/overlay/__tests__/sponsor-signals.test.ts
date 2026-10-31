// R4 sponsors on stream, S7 — the proof-of-play lines (spec 2026-10-27 §3.6) and the scene carousel's rules (§3.4).
//
// Where the expected values come from — never from the code under test:
//   - the line forms and key sets: spec §3.6, verbatim ("`seazn:sponsor:start {"momentId","cardId","style","source",
//     "breakKind","at"}`", "`seazn:sponsor:end {"momentId","at","cutShort"}`"), and the compositor's bound ("bounded
//     JSON ≤ 512 bytes"); the byte count is measured here with the platform's own UTF-8 encoder;
//   - when a line fires: spec §3.6 ("a sponsor moment entering `hold` logs start; leaving `out` logs end") and the S6
//     addendum ("a card cut while folding in has no start line, so no end line; an undone-on-air card ends with
//     cutShort=true");
//   - the carousel: spec §3.4 ("ticked sponsors, title and gold first, 10 s each, logged source = scene"), the tier
//     order `SPONSOR_TIERS`, the showing length `SCENE_CAROUSEL_MS`, and P5's id form `scene:<sceneId>:<floor(ms/10000)>`.
// The queue states the tracker reads are the REAL reducer's (`momentQueueReducer`), fed sponsor moments the REAL
// planner (`planSponsors`) planned and the REAL `sponsorMoments` built — the hook's own inputs, in the hook's order.
// The stage-level seam (the hook emitting through the real stage) is `overlay-stage-sponsor.test.tsx`.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sponsorMoments, type OverlayMoment } from "@/lib/overlay-moments";
import {
  SIGNAL_SPONSOR_END,
  SIGNAL_SPONSOR_START,
  SPONSOR_LINE_MAX_BYTES,
  SponsorLineError,
  sponsorLine,
  sponsorQueueLines,
  type SponsorQueueView,
} from "@/lib/overlay-compositor";
import {
  SCENE_CAROUSEL_MS,
  SPONSOR_STYLE_BY_SIZE,
  planSponsors,
  sponsorMomentId,
  type BreakDecl,
  type SponsorCard,
} from "@/lib/sponsor-plan";
import { SPONSOR_TIERS, type SponsorTier } from "@/lib/sponsor-tiers";
import { INITIAL, momentIdOf, momentQueueReducer as reduce, type MomentQueueState } from "../moment-queue";
import { OVERLAY_MOMENT_FOLD_MS, OVERLAY_MOMENT_HOLD_MS } from "../moment-timing";
import {
  CAROUSEL_INITIAL,
  carouselDeadline,
  carouselLines,
  carouselMomentId,
  carouselOrder,
  carouselStep,
  type CarouselState,
} from "../sponsor-card";

const START_KEYS = ["momentId", "cardId", "style", "source", "breakKind", "at"];
const END_KEYS = ["momentId", "at", "cutShort"];
const bytes = (s: string) => new TextEncoder().encode(s).length;
const AT = "2026-10-31T10:00:00.000Z";
const T0 = Date.parse(AT);

const card = (key: string, tier: SponsorTier, over: Partial<SponsorCard> = {}): SponsorCard => ({
  id: `card-${key}`,
  sponsorId: `sponsor-${key}`,
  name: `${key} sponsor`,
  logoUrl: null,
  tier,
  onStream: true,
  ...over,
});

/** Parse a line back into its prefix and its JSON body. */
function parse(line: string): { prefix: string; body: Record<string, unknown> } {
  const at = line.indexOf(" ");
  return { prefix: line.slice(0, at), body: JSON.parse(line.slice(at + 1)) as Record<string, unknown> };
}

describe("the signal names (spec §3.6, verbatim)", () => {
  it("start and end are the spec's strings, on the ready line's channel", () => {
    expect(SIGNAL_SPONSOR_START).toBe("seazn:sponsor:start");
    expect(SIGNAL_SPONSOR_END).toBe("seazn:sponsor:end");
    expect(SPONSOR_LINE_MAX_BYTES).toBe(512);
  });
});

describe("sponsorLine", () => {
  const start = { momentId: "41:sponsor.over_end", cardId: "card-a", style: "lower_third", source: "rotation", breakKind: "over_end", at: AT };
  const end = { momentId: "41:sponsor.over_end", at: AT, cutShort: false };

  it("a start line: the prefix, one space, a JSON body whose keys are exactly the spec's, in the spec's order", () => {
    const line = sponsorLine("start", start);
    const { prefix, body } = parse(line);
    expect(prefix).toBe("seazn:sponsor:start");
    expect(Object.keys(body)).toEqual(START_KEYS);
    expect(body).toEqual(start);
  });

  it("an end line: the same, with the end's three keys", () => {
    const { prefix, body } = parse(sponsorLine("end", end));
    expect(prefix).toBe("seazn:sponsor:end");
    expect(Object.keys(body)).toEqual(END_KEYS);
    expect(body).toEqual(end);
  });

  it("keys handed in any order come out in the spec's order", () => {
    const shuffled = { at: AT, breakKind: null, source: "scene", style: "banner", cardId: "c", momentId: "scene:starting:1" };
    expect(Object.keys(parse(sponsorLine("start", shuffled)).body)).toEqual(START_KEYS);
  });

  it("a missing key, an extra key, or the other kind's keys is refused by name (SponsorLineError)", () => {
    const missing = Object.fromEntries(Object.entries(start).filter(([k]) => k !== "at"));
    expect(() => sponsorLine("start", missing)).toThrow(SponsorLineError);
    expect(() => sponsorLine("start", { ...start, extra: 1 })).toThrow(SponsorLineError);
    expect(() => sponsorLine("end", start)).toThrow(SponsorLineError);
    expect(() => sponsorLine("start", end)).toThrow(SponsorLineError);
    expect(() => sponsorLine("end", { ...end, cardId: "c" })).toThrow(SponsorLineError);
  });

  it("sponsorLine: a 513-byte body throws; a 512-byte body passes; keys are exactly the spec's", () => {
    const sized = (n: number) => {
      const base = { ...end, momentId: "" };
      const pad = n - bytes(JSON.stringify(base));
      return { ...base, momentId: "x".repeat(pad) };
    };
    const at512 = sized(SPONSOR_LINE_MAX_BYTES);
    const at513 = sized(SPONSOR_LINE_MAX_BYTES + 1);
    expect(bytes(JSON.stringify(at512)), "premise: the body measures 512").toBe(512);
    expect(bytes(JSON.stringify(at513)), "premise: the body measures 513").toBe(513);
    expect(Object.keys(parse(sponsorLine("end", at512)).body)).toEqual(END_KEYS);
    expect(() => sponsorLine("end", at513)).toThrow(SponsorLineError);
  });

  it("the bound counts BYTES, not characters: 300 two-byte characters (600 bytes) throw", () => {
    const wide = { ...end, momentId: "é".repeat(300) };
    expect(JSON.stringify(wide).length, "premise: under 512 characters").toBeLessThan(512);
    expect(() => sponsorLine("end", wide)).toThrow(SponsorLineError);
  });
});

// ── the queue tracker, over the real reducer ─────────────────────────────────────────────────────────────────────

const F = OVERLAY_MOMENT_FOLD_MS;
const H = OVERLAY_MOMENT_HOLD_MS;
const OVER_END: BreakDecl = { kind: "over_end", size: "minor" }; // engine 1.1.0 cricket.ts:4697
const GAME_END: BreakDecl = { kind: "game_end", size: "major" }; // engine 1.1.0 badminton (S4's SPORTS table)
const TITLE = card("title", "title");

/** The real planner's plan for one break at `seq`, then the real sponsor moments of it. */
function sponsorMomentAt(seq: number, d: BreakDecl): OverlayMoment {
  const { plan } = planSponsors({
    breaks: [{ seq, at: new Date(T0).toISOString(), ...d }],
    windowSeqs: [seq],
    settings: { enabled: true, frequency: "busy" },
    cards: [TITLE],
    assignedCards: [],
    assigned: [],
    operatorLog: [],
    nextPosition: 0,
    now: T0 + 1_000,
    complete: true,
  });
  const [m] = sponsorMoments(plan);
  if (m === undefined) throw new Error("premise: the planner planned no airing");
  return m;
}
const goal = (seq: number): OverlayMoment => ({ seq, kind: "goal", headline: "GOAL", tone: "led" });

const view = (s: MomentQueueState): SponsorQueueView => ({ current: s.current, phase: s.phase, cutShort: s.cutShort });

/** Feed every state to the tracker in turn (the hook's effect runs once per committed state); collect the lines. */
function track(states: readonly MomentQueueState[]): { lines: string[]; onAir: string | null } {
  let onAir: string | null = null;
  const lines: string[] = [];
  for (const s of states) {
    const step = sponsorQueueLines(onAir, view(s), AT);
    onAir = step.onAir;
    lines.push(...step.lines);
  }
  return { lines, onAir };
}

/** Run the queue from `s` deadline by deadline until idle, recording every state. */
function runOut(s: MomentQueueState, states: MomentQueueState[]): MomentQueueState {
  for (let i = 0; i < 100 && s.deadline !== null; i++) {
    s = reduce(s, { type: "tick", now: s.deadline, foldMs: F, holdMs: H });
    states.push(s);
  }
  expect(s.current, "the queue drained").toBeNull();
  return s;
}

describe("sponsorQueueLines — when a line fires", () => {
  it("the empty case: an idle queue, and a queue airing only score moments, log nothing", () => {
    expect(track([INITIAL])).toEqual({ lines: [], onAir: null });
    const states: MomentQueueState[] = [];
    const s = reduce(INITIAL, { type: "enqueue", moments: [goal(3), goal(4)], now: 0, foldMs: F, holdMs: H });
    states.push(s);
    runOut(s, states);
    expect(states.length, "anti-vacuity: the goals aired").toBeGreaterThan(4);
    expect(track(states).lines).toEqual([]);
  });

  for (const [sport, d] of [["cricket", OVER_END], ["badminton", GAME_END]] as const) {
    it(`${sport} (${d.kind}): in → nothing; hold → ONE start; the next poll's re-render → nothing; out → nothing; gone → ONE end, cutShort false`, () => {
      const m = sponsorMomentAt(12, d);
      const id = momentIdOf(m);
      expect(id, "premise: the queue id is S4's sponsorMomentId").toBe(sponsorMomentId(12, d.kind));
      const look = SPONSOR_STYLE_BY_SIZE[d.size];
      const states: MomentQueueState[] = [];
      let s = reduce(INITIAL, { type: "enqueue", moments: [m], now: 0, foldMs: F, holdMs: H });
      states.push(s);
      expect(s.phase, "premise: folding in").toBe("in");
      expect(track(states).lines, "in: no line").toEqual([]);
      s = reduce(s, { type: "tick", now: s.deadline!, foldMs: F, holdMs: H });
      states.push(s, s); // a second poll re-renders the same state
      expect(s.phase, "premise: hold").toBe("hold");
      const held = track(states).lines;
      expect(held, "hold: one start, never two").toHaveLength(1);
      expect(parse(held[0]!)).toEqual({
        prefix: "seazn:sponsor:start",
        body: { momentId: id, cardId: TITLE.id, style: look.style, source: "rotation", breakKind: d.kind, at: AT },
      });
      // The second poll re-sends the window: enqueue of the same moment is no state change.
      expect(reduce(s, { type: "enqueue", moments: [m], now: 1_000, foldMs: F, holdMs: H })).toBe(s);
      runOut(s, states);
      const { lines, onAir } = track(states);
      expect(lines, "one start, one end").toHaveLength(2);
      expect(parse(lines[1]!)).toEqual({ prefix: "seazn:sponsor:end", body: { momentId: id, at: AT, cutShort: false } });
      expect(onAir).toBeNull();
    });
  }

  it("a card cut while folding IN never entered hold: no start line, so no end line", () => {
    const m = sponsorMomentAt(12, OVER_END);
    const states: MomentQueueState[] = [];
    let s = reduce(INITIAL, { type: "enqueue", moments: [m], now: 0, foldMs: F, holdMs: H });
    states.push(s);
    s = reduce(s, { type: "enqueue", moments: [goal(13)], now: 100, foldMs: F, holdMs: H });
    states.push(s);
    expect(s.phase, "premise: the score cut the card mid-fold").toBe("out");
    expect(s.cutShort, "premise: recorded cut short").toContain(momentIdOf(m));
    runOut(s, states);
    expect(track(states).lines).toEqual([]);
  });

  it("a score moment cuts the card on air: one start, then one end with cutShort true (from the queue's cutShort)", () => {
    const m = sponsorMomentAt(12, OVER_END);
    const states: MomentQueueState[] = [];
    let s = reduce(INITIAL, { type: "enqueue", moments: [m], now: 0, foldMs: F, holdMs: H });
    states.push(s);
    s = reduce(s, { type: "tick", now: s.deadline!, foldMs: F, holdMs: H });
    states.push(s);
    s = reduce(s, { type: "enqueue", moments: [goal(13)], now: F + 1_000, foldMs: F, holdMs: H });
    states.push(s);
    runOut(s, states);
    const lines = track(states).lines;
    expect(lines.map((l) => parse(l).prefix)).toEqual(["seazn:sponsor:start", "seazn:sponsor:end"]);
    expect(parse(lines[1]!).body.cutShort).toBe(true);
  });

  it("an undo strikes the card on air: one end with cutShort true", () => {
    const m = sponsorMomentAt(12, OVER_END);
    const states: MomentQueueState[] = [];
    let s = reduce(INITIAL, { type: "enqueue", moments: [m], now: 0, foldMs: F, holdMs: H });
    states.push(s);
    s = reduce(s, { type: "tick", now: s.deadline!, foldMs: F, holdMs: H });
    states.push(s);
    s = reduce(s, { type: "sync", live: [], now: F + 500, foldMs: F, holdMs: H });
    states.push(s);
    runOut(s, states);
    const lines = track(states).lines;
    expect(lines).toHaveLength(2);
    expect(parse(lines[1]!).body).toEqual({ momentId: momentIdOf(m), at: AT, cutShort: true });
  });

  it("two cards back to back (a second break queued behind the first): start A, end A, start B, end B — in that order", () => {
    const a = sponsorMomentAt(12, OVER_END);
    const b = sponsorMomentAt(20, OVER_END);
    const states: MomentQueueState[] = [];
    const s = reduce(INITIAL, { type: "enqueue", moments: [a, b], now: 0, foldMs: F, holdMs: H });
    states.push(s);
    runOut(s, states);
    const lines = track(states).lines.map((l) => {
      const { prefix, body } = parse(l);
      return `${prefix} ${String(body.momentId)}`;
    });
    expect(lines).toEqual([
      `seazn:sponsor:start ${momentIdOf(a)}`,
      `seazn:sponsor:end ${momentIdOf(a)}`,
      `seazn:sponsor:start ${momentIdOf(b)}`,
      `seazn:sponsor:end ${momentIdOf(b)}`,
    ]);
  });
});

// ── the carousel ──────────────────────────────────────────────────────────────────────────────────────────────────

describe("carouselOrder", () => {
  it("premise: SPONSOR_TIERS opens on title, then gold (spec §3.4 names both)", () => {
    expect(SPONSOR_TIERS.slice(0, 2)).toEqual(["title", "gold"]);
  });

  it("carouselOrder puts title then gold first (derived from SPONSOR_TIERS order), the rest after, resolve order kept within each", () => {
    const [first, second] = SPONSOR_TIERS;
    let checked = 0;
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...SPONSOR_TIERS), { maxLength: 9 }), (tiers) => {
        const cards = tiers.map((tier, i) => card(`c${i}`, tier));
        const want = [
          ...cards.filter((c) => c.tier === first),
          ...cards.filter((c) => c.tier === second),
          ...cards.filter((c) => c.tier !== first && c.tier !== second),
        ];
        expect(carouselOrder(cards).map((c) => c.id)).toEqual(want.map((c) => c.id));
        checked++;
      }),
      { seed: 7, numRuns: 200 },
    );
    console.log(`carousel orders checked: ${checked}`);
    expect(checked, "anti-vacuity").toBe(200);
  });

  it("silver and partner keep their resolve order between themselves (the rest is not re-ranked)", () => {
    const cards = [card("p", "partner"), card("s", "silver"), card("g", "gold"), card("t", "title")];
    expect(carouselOrder(cards).map((c) => c.id)).toEqual(["card-t", "card-g", "card-p", "card-s"]);
  });

  it("the empty case: no cards, no order; the input is never mutated", () => {
    expect(carouselOrder([])).toEqual([]);
    const cards = [card("p", "partner"), card("t", "title")];
    const copy = [...cards];
    carouselOrder(cards);
    expect(cards).toEqual(copy);
  });
});

describe("carouselMomentId (P5: scene:<sceneId>:<floor(startedAtMs/10000)>)", () => {
  it("the P5 form", () => {
    expect(carouselMomentId("starting", 1_730_000_012_345)).toBe(`scene:starting:${Math.floor(1_730_000_012_345 / 10_000)}`);
  });

  it("carouselMomentId differs for two showings 10 s apart and is equal within one", () => {
    const t = 1_730_000_010_000;
    expect(carouselMomentId("starting", t)).toBe(carouselMomentId("starting", t + 9_999));
    expect(carouselMomentId("starting", t)).not.toBe(carouselMomentId("starting", t + SCENE_CAROUSEL_MS));
    expect(carouselMomentId("starting", t + 9_999)).not.toBe(carouselMomentId("starting", t + 10_000));
  });

  it("two scenes at the same instant are two ids", () => {
    expect(carouselMomentId("starting", T0)).not.toBe(carouselMomentId("reconnecting", T0));
  });
});

describe("carouselStep — 10 s each, one at a time, yielding to the moment on air", () => {
  const ORDER = ["card-t", "card-g", "card-s"];
  const step = (s: CarouselState, now: number, yielding = false, order: readonly string[] = ORDER) =>
    carouselStep(s, { now, order, yielding, scene: "starting" });

  /** Walk the carousel deadline by deadline for `span` ms from `t0`; collect every state. */
  function walk(start: CarouselState, t0: number, span: number, yielding = false) {
    let s = step(start, t0, yielding);
    const states = [s];
    for (let i = 0; i < 1_000; i++) {
      const d = carouselDeadline(s);
      if (d === null || d > t0 + span) break;
      s = step(s, d, yielding);
      states.push(s);
    }
    return states;
  }
  const linesOf = (states: readonly CarouselState[]) => {
    let onAir: string | null = null;
    const out: string[] = [];
    for (const s of states) {
      const r = carouselLines(onAir, s, AT);
      onAir = r.onAir;
      out.push(...r.lines);
    }
    return out;
  };

  it("the empty case: no ticked card, no showing, no deadline, no line", () => {
    const s = step(CAROUSEL_INITIAL, T0, false, []);
    expect(s.showing).toBeNull();
    expect(carouselDeadline(s)).toBeNull();
    expect(linesOf([s])).toEqual([]);
  });

  it("the first card shows at once, for SCENE_CAROUSEL_MS, then the next — in carousel order, wrapping", () => {
    const states = walk(CAROUSEL_INITIAL, T0, 4 * SCENE_CAROUSEL_MS);
    const shown = states.flatMap((s) => (s.showing ? [`${s.showing.cardId}@${s.showing.startedAt - T0}`] : []));
    expect([...new Set(shown)]).toEqual([
      "card-t@0",
      `card-g@${SCENE_CAROUSEL_MS}`,
      `card-s@${2 * SCENE_CAROUSEL_MS}`,
      `card-t@${3 * SCENE_CAROUSEL_MS}`,
      `card-g@${4 * SCENE_CAROUSEL_MS}`,
    ]);
  });

  it("each showing logs one start (source scene, the banner, no break) and one end (cutShort false); every id distinct", () => {
    const states = walk(CAROUSEL_INITIAL, T0, 6 * SCENE_CAROUSEL_MS - 1);
    const lines = linesOf(states).map(parse);
    const starts = lines.filter((l) => l.prefix === "seazn:sponsor:start");
    const ends = lines.filter((l) => l.prefix === "seazn:sponsor:end");
    console.log(`carousel showings walked: ${starts.length}`);
    expect(starts.length, "anti-vacuity: six showings in a minute").toBe(6);
    expect(ends).toHaveLength(5); // the sixth is still on air
    for (const s of starts) {
      expect(Object.keys(s.body)).toEqual(START_KEYS);
      expect(s.body).toMatchObject({ source: "scene", style: "banner", breakKind: null });
    }
    for (const e of ends) expect(e.body.cutShort).toBe(false);
    expect(new Set(starts.map((s) => s.body.momentId)).size, "ids never repeat").toBe(6);
  });

  it("yielding cuts the showing short (cutShort true) and starts nothing; un-yielding starts the NEXT card no sooner than 10 s after the cut one began", () => {
    let s = step(CAROUSEL_INITIAL, T0);
    const states = [s];
    s = step(s, T0 + 3_000, true);
    states.push(s);
    expect(s.showing, "nothing on air while yielding").toBeNull();
    s = step(s, T0 + 5_000, true);
    states.push(s);
    expect(s.showing).toBeNull();
    s = step(s, T0 + 6_000, false); // the moment left at 6 s: too soon for a new id
    states.push(s);
    expect(s.showing, "waits out the cut showing's 10 s").toBeNull();
    expect(carouselDeadline(s)).toBe(T0 + SCENE_CAROUSEL_MS);
    s = step(s, T0 + SCENE_CAROUSEL_MS, false);
    states.push(s);
    expect(s.showing?.cardId, "the next card, not the cut one again").toBe("card-g");
    const lines = linesOf(states).map(parse);
    expect(lines.map((l) => `${l.prefix} ${String(l.body.cardId ?? l.body.cutShort)}`)).toEqual([
      "seazn:sponsor:start card-t",
      "seazn:sponsor:end true",
      "seazn:sponsor:start card-g",
    ]);
    expect(lines[0]!.body.momentId).not.toBe(lines[2]!.body.momentId);
  });

  it("a card unticked mid-showing (gone from the order) ends cut short; the carousel goes on with the rest", () => {
    let s = step(CAROUSEL_INITIAL, T0);
    expect(s.showing?.cardId).toBe("card-t");
    s = step(s, T0 + 2_000, false, ["card-g", "card-s"]);
    expect(s.showing).toBeNull();
    expect(s.ended).toEqual({ momentId: carouselMomentId("starting", T0), cutShort: true });
    s = step(s, T0 + SCENE_CAROUSEL_MS, false, ["card-g", "card-s"]);
    expect(["card-g", "card-s"], "one of the cards still ticked").toContain(s.showing?.cardId);
  });

  it("a step before any deadline changes nothing (a re-render under the same props is not a showing)", () => {
    const s = step(CAROUSEL_INITIAL, T0);
    expect(step(s, T0 + 1_000)).toBe(s);
  });

  it("over a long run, the ids of consecutive showings never collide, whatever the yields (property)", () => {
    let runs = 0;
    fc.assert(
      fc.property(
        fc.array(fc.record({ gap: fc.integer({ min: 0, max: 25_000 }), yielding: fc.boolean() }), { minLength: 1, maxLength: 40 }),
        (events) => {
          let s = step(CAROUSEL_INITIAL, T0);
          let now = T0;
          const ids: string[] = s.showing ? [s.showing.momentId] : [];
          for (const e of events) {
            // Every deadline that passes before the next event is stepped, as the hook's one timer would.
            for (let d = carouselDeadline(s); d !== null && d <= now + e.gap; d = carouselDeadline(s)) {
              s = step(s, d, false);
              if (s.showing && ids.at(-1) !== s.showing.momentId) ids.push(s.showing.momentId);
            }
            now += e.gap;
            s = step(s, now, e.yielding);
            if (s.showing && ids.at(-1) !== s.showing.momentId) ids.push(s.showing.momentId);
          }
          expect(new Set(ids).size).toBe(ids.length);
          runs++;
        },
      ),
      { seed: 11, numRuns: 150 },
    );
    expect(runs, "anti-vacuity").toBe(150);
  });
});
