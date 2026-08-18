// R2/task C — cricket SkinDefV3. Pure-data assertions only (environment:
// "node", no jsdom — apps/web vitest convention every v3 primitive follows);
// the wicket sheet's `when`-skip logic is proved by driving the REAL
// guided-sheet.tsx step machine against this file's own `buildSheets`
// output, not a re-implemented stand-in.
import { describe, expect, it } from "vitest";
import type { EventEnvelope, SquadState } from "@seazn/engine/core";
import { initSquads } from "@seazn/engine/core";
import { answerStep, backStep, currentStep, initialSheetState } from "../../guided-sheet";
import type { GuidedSheetSpec, PadHostView, SkinDefV3 } from "../../types";
import {
  EXTRA_KINDS,
  FIELDER_ELIGIBLE_KINDS,
  VARIABLE_OUT_KINDS,
  WICKET_KINDS,
  ballEventType,
  ballsPerOverOf,
  bowlerBlockReason,
  buildContext,
  buildDock,
  buildScorebug,
  buildSheets,
  buildTiles,
  chaseTarget,
  cricketBallDetail,
  cricketSkinV3,
  currentInnings,
  dueBattingSide,
  freeHitPending,
  inningsFidelity,
  nextOverNumber,
  oversText,
  overDots,
  resolvePeople,
  resolvePhase,
  runRate,
  variantCode,
} from "../cricket";
import type { TFn } from "../cricket";
import type { Dict } from "@/lib/i18n-constants";
import { t as realT } from "@/lib/i18n-runtime";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const t = (key: string, vars?: Record<string, string | number>): string =>
  vars ? `${key}(${JSON.stringify(vars)})` : key;

function squads(): SquadState {
  return initSquads({
    home: {
      entrantId: "home-1",
      slots: [
        { personId: "h1", slot: "starting", orderNo: 1 },
        { personId: "h2", slot: "starting", orderNo: 2 },
        { personId: "h3", slot: "starting", orderNo: 3 },
      ],
    },
    away: {
      entrantId: "away-1",
      slots: [
        { personId: "a1", slot: "starting", orderNo: 1 },
        { personId: "a2", slot: "starting", orderNo: 2 },
        { personId: "a3", slot: "starting", orderNo: 3 },
      ],
    },
  });
}

function innings(over: Record<string, unknown> = {}) {
  return {
    battingSide: "home" as const,
    runs: 12,
    wickets: 1,
    legalBalls: 5,
    closed: false,
    fine: { striker: "h1", nonStriker: "h2", currentBowler: "a1", freeHitPending: false },
    ...over,
  };
}

function state(over: Record<string, unknown> = {}) {
  return {
    phase: "live" as const,
    innings: [innings()],
    orders: { home: ["h1", "h2", "h3"], away: ["a1", "a2", "a3"] },
    ...over,
  };
}

function cfg(over: Record<string, unknown> = {}) {
  // `inningsPerSide` is `1 | 2` on the skin's CricketCfgShape, not `number`.
  // Without the annotation the literal widens to `number` and every call site
  // below fails to typecheck while still passing under vitest, which does not
  // typecheck at all.
  return {
    ballsPerOver: 6,
    inningsPerSide: 1 as 1 | 2,
    ballsPerInnings: 120,
    dls: { enabled: false },
    superOver: false,
    ...over,
  };
}

function view(over: Partial<PadHostView> = {}): PadHostView {
  return {
    cfg: cfg(),
    state: state(),
    summary: {},
    phase: "live",
    band: 3,
    entitlements: {},
    personNames: { h1: "Home One", h2: "Home Two", h3: "Home Three", a1: "Away One", a2: "Away Two", a3: "Away Three" },
    squads: squads(),
    events: [],
    contextOverrides: {},
    ...over,
  };
}

function ballEvent(id: string, payload: Record<string, unknown>, type = "cricket.ball"): EventEnvelope {
  return { id, fixtureId: "fx-1", seq: 0, type, payload, recordedAt: "2026-01-01T00:00:00.000Z", recordedBy: null };
}

// ---------------------------------------------------------------------------
// ballsPerOverOf / oversText
// ---------------------------------------------------------------------------

describe("ballsPerOverOf", () => {
  it("defaults to 6 when cfg carries none", () => {
    expect(ballsPerOverOf({})).toBe(6);
    expect(ballsPerOverOf(null)).toBe(6);
    expect(ballsPerOverOf(undefined)).toBe(6);
  });
  it("reads the hundred's 5-ball over from cfg — never assumes 6", () => {
    expect(ballsPerOverOf({ ballsPerOver: 5 })).toBe(5);
  });
  it("ignores a non-positive value and falls back to 6", () => {
    expect(ballsPerOverOf({ ballsPerOver: 0 })).toBe(6);
    expect(ballsPerOverOf({ ballsPerOver: -1 })).toBe(6);
  });
});

describe("oversText", () => {
  it("formats legal balls as overs.balls for a 6-ball over", () => {
    expect(oversText(0, 6)).toBe("0.0");
    expect(oversText(5, 6)).toBe("0.5");
    expect(oversText(6, 6)).toBe("1.0");
    expect(oversText(13, 6)).toBe("2.1");
  });
  it("formats against a 5-ball (hundred) over — a different quotient/remainder than 6 would give", () => {
    expect(oversText(5, 5)).toBe("1.0"); // vs "0.5" at bpo=6
    expect(oversText(11, 5)).toBe("2.1");
  });
});

// ---------------------------------------------------------------------------
// currentInnings / resolvePeople / ballEventType
// ---------------------------------------------------------------------------

describe("currentInnings", () => {
  it("is null with no innings recorded yet", () => {
    expect(currentInnings({})).toBeNull();
  });
  it("picks the open (not closed) innings over a closed earlier one", () => {
    const s = { innings: [innings({ closed: true, runs: 200 }), innings({ closed: false, runs: 12 })] };
    expect(currentInnings(s)?.runs).toBe(12);
  });
  it("falls back to the last innings once every innings is closed", () => {
    const s = { innings: [innings({ closed: true, runs: 200 }), innings({ closed: true, runs: 180 })] };
    expect(currentInnings(s)?.runs).toBe(180);
  });
});

// ---------------------------------------------------------------------------
// inningsFidelity / nextOverNumber — R2b
// ---------------------------------------------------------------------------

describe("inningsFidelity", () => {
  it("is 'unopened' with no innings recorded yet", () => {
    expect(inningsFidelity(null)).toBe("unopened");
  });
  it("is 'coarse' once an over-summary opened it (fine === null)", () => {
    expect(inningsFidelity(innings({ fine: null }))).toBe("coarse");
  });
  it("is 'fine' once a ball opened it", () => {
    expect(inningsFidelity(innings())).toBe("fine"); // fixture default carries a real `fine` object
  });
});

describe("nextOverNumber", () => {
  it("starts at over 1 for an unopened innings", () => {
    expect(nextOverNumber(null, 6)).toBe(1);
  });
  it("advances by whole overs off legalBalls", () => {
    expect(nextOverNumber(innings({ legalBalls: 30 }), 6)).toBe(6);
  });
  it("uses the given bpo, not a hardcoded 6 (hundred: 5-ball overs)", () => {
    expect(nextOverNumber(innings({ legalBalls: 20 }), 5)).toBe(5);
  });
});

describe("resolvePeople", () => {
  it("reads striker/non-striker/bowler from the fold's own fine state", () => {
    const p = resolvePeople(state());
    expect(p).toEqual({ battingSide: "home", bowlingSide: "away", striker: "h1", nonStriker: "h2", bowler: "a1" });
  });
  it("defaults to the batting/bowling order's first entrants before any fold value exists — v2's own default, stateless here", () => {
    const s = state({ innings: [innings({ fine: { striker: null, nonStriker: null, currentBowler: null } })] });
    const p = resolvePeople(s);
    expect(p).toEqual({ battingSide: "home", bowlingSide: "away", striker: "h1", nonStriker: "h2", bowler: "a1" });
  });
  it("empty string, never a crash, when even the order is unset", () => {
    const p = resolvePeople({ innings: [innings({ fine: null })], orders: {} });
    expect(p.striker).toBe("");
    expect(p.nonStriker).toBe("");
    expect(p.bowler).toBe("");
  });
  it("swaps batting/bowling side for an away-batting innings", () => {
    const p = resolvePeople(state({ innings: [innings({ battingSide: "away", fine: { striker: "a1", nonStriker: "a2", currentBowler: "h1" } })] }));
    expect(p.battingSide).toBe("away");
    expect(p.bowlingSide).toBe("home");
  });
});

describe("ballEventType", () => {
  it("is cricket.ball outside a super over", () => {
    expect(ballEventType({ phase: "live" })).toBe("cricket.ball");
    expect(ballEventType({ phase: "pre" })).toBe("cricket.ball");
  });
  it("switches to cricket.superover.ball while the engine is actually in one", () => {
    expect(ballEventType({ phase: "super_over" })).toBe("cricket.superover.ball");
  });
});

// ---------------------------------------------------------------------------
// overDots — C-gaps §G1, mutation target #2 (ballsPerOver load-bearing)
// ---------------------------------------------------------------------------

describe("overDots", () => {
  it("reads real per-ball outcomes — dot, runs, boundary, wicket — not a bare filled count", () => {
    const events = [
      ballEvent("e1", { ballInOver: 1, runs: { bat: 0 } }),
      ballEvent("e2", { ballInOver: 2, runs: { bat: 2 } }),
      ballEvent("e3", { ballInOver: 3, runs: { bat: 4 }, boundary: 4 }),
      ballEvent("e4", { ballInOver: 4, runs: { bat: 0 }, wicket: { kind: "bowled", out: "h1", bowlerCredited: true } }),
    ];
    expect(overDots(events, 6)).toEqual(["•", "2", "4", "W"]);
  });

  it("renders extras with their own short notation", () => {
    const events = [
      ballEvent("e1", { ballInOver: 1, runs: { bat: 0, extras: { kind: "wide", runs: 1 } } }),
      ballEvent("e2", { ballInOver: 1, runs: { bat: 0, extras: { kind: "noball", runs: 1 } } }),
      ballEvent("e3", { ballInOver: 1, runs: { bat: 0, extras: { kind: "bye", runs: 2 } } }),
      ballEvent("e4", { ballInOver: 1, runs: { bat: 0, extras: { kind: "legbye", runs: 1 } } }),
    ];
    // Each event's own ballInOver===1 makes it its own "fresh over" boundary
    // for this isolated per-symbol check (each windowed call takes just the
    // one event under test).
    expect(overDots([events[0]!], 6)).toEqual(["wd"]);
    expect(overDots([events[1]!], 6)).toEqual(["nb"]);
    expect(overDots([events[2]!], 6)).toEqual(["b2"]);
    expect(overDots([events[3]!], 6)).toEqual(["lb1"]);
  });

  it("ignores non-ball event types entirely", () => {
    const events = [
      ballEvent("e0", {}, "cricket.toss"),
      ballEvent("e1", { ballInOver: 1, runs: { bat: 1 } }),
    ];
    expect(overDots(events, 6)).toEqual(["1"]);
  });

  it("a hundred fixture (bpo=5) yields exactly 5 dots for a full over — sized by cfg ballsPerOver, not a hardcoded window", () => {
    // 1 stale ball from the over before, then a fresh 5-ball over
    // (ballInOver 1..5). The ballInOver===1 boundary trim means an
    // OVERSIZED window (bpo wrongly read as 6) is harmless here — it still
    // finds and drops the stale ball. Where bpo is genuinely load-bearing is
    // the other direction: an UNDERSIZED window (bpo wrongly read too
    // small) truncates real balls off the FRONT of the current over, since
    // the slice never reaches far enough back to see this over's own first
    // ball at all.
    const events = [
      ballEvent("stale", { ballInOver: 5, runs: { bat: 1 } }),
      ballEvent("f1", { ballInOver: 1, runs: { bat: 0 } }),
      ballEvent("f2", { ballInOver: 2, runs: { bat: 1 } }),
      ballEvent("f3", { ballInOver: 3, runs: { bat: 0 } }),
      ballEvent("f4", { ballInOver: 4, runs: { bat: 4 }, boundary: 4 }),
      ballEvent("f5", { ballInOver: 5, runs: { bat: 0 }, wicket: { kind: "bowled", out: "h1", bowlerCredited: true } }),
    ];
    expect(overDots(events, 5)).toEqual(["•", "1", "•", "4", "W"]);
    // A too-small bpo (3) truncates: the window can't see back to f1/f2, and
    // none of what remains in it is a fresh ballInOver===1 boundary, so the
    // whole (already-too-short) window is returned as-is — 3 dots, missing
    // this over's own first two real balls. A too-large bpo (6) stays
    // correct (the trim still finds and drops the stale ball) — proving the
    // window size is genuinely read from bpo either way, not ignored.
    expect(overDots(events, 3)).toEqual(["•", "4", "W"]);
    expect(overDots(events, 6)).toEqual(["•", "1", "•", "4", "W"]);
  });
});

// R2b (owner ruling, live-tile audit — freeHit chip removal): the ONE shared
// derivation the read-only indicator (buildScorebug) and the activity label
// (cricketBallDetail) both fold through, so the two can never answer "was/is
// this delivery a free hit" two different ways. Mirrors the engine's own
// transition rule verbatim (cricket.ts finishDelivery, ~line 1363): a
// white-ball no-ball ARMS it; any LEGAL delivery (not wide, not no-ball)
// CONSUMES it; a wide (or a non-white-ball no-ball) carries the existing
// state forward unchanged. The correctness trap this whole feature exists to
// avoid: "was the previous row a no-ball?" gets no-ball -> wide -> legal
// wrong (the legal ball IS still a free hit, because a wide never consumes
// it) — this function instead FOLDS FORWARD over the whole sequence, which
// gets that right by construction rather than by a special case.
//
// Innings-boundary reset: a `FineInnings` always starts `freeHitPending:
// false` (cricket.ts:650, `createInnings`) — a dangling pending flag at one
// innings' close must never leak into the next. There is no reliable
// explicit boundary EVENT to key off (an innings can auto-close, e.g. all
// out/overs complete, with no dedicated event in the ledger at all), so this
// detects the boundary the same way `overDots` implicitly tolerates one:
// each ball's own `(over, ballInOver)` is monotonically non-decreasing
// WITHIN one innings (illegal balls hold it steady, a legal one advances
// it) — a ball whose pair is LOWER than the one immediately before it can
// only mean a fresh innings (or super over) just started, so the fold resets
// to `false` right there before applying that ball's own transition.
describe("freeHitPending", () => {
  it("is false with no ball history at all", () => {
    expect(freeHitPending([], true)).toBe(false);
  });

  it("a no-ball arms it for the NEXT ball — the no-ball's own row is not itself pending-before", () => {
    const events = [ballEvent("e1", { over: 0, ballInOver: 1, runs: { bat: 0, extras: { kind: "noball", runs: 1 } } })];
    expect(freeHitPending(events, true)).toBe(true);
  });

  it("no-ball -> wide -> legal ball: still pending after the wide — a wide never consumes it (the correctness trap)", () => {
    const events = [
      ballEvent("e1", { over: 0, ballInOver: 1, runs: { bat: 0, extras: { kind: "noball", runs: 1 } } }),
      ballEvent("e2", { over: 0, ballInOver: 1, runs: { bat: 0, extras: { kind: "wide", runs: 1 } } }),
    ];
    expect(freeHitPending(events, true)).toBe(true);
  });

  it("consecutive no-balls: still pending — each re-arms it", () => {
    const events = [
      ballEvent("e1", { over: 0, ballInOver: 1, runs: { bat: 0, extras: { kind: "noball", runs: 1 } } }),
      ballEvent("e2", { over: 0, ballInOver: 1, runs: { bat: 0, extras: { kind: "noball", runs: 1 } } }),
    ];
    expect(freeHitPending(events, true)).toBe(true);
  });

  it("a legal delivery consumes it — the ball after is not pending", () => {
    const events = [
      ballEvent("e1", { over: 0, ballInOver: 1, runs: { bat: 0, extras: { kind: "noball", runs: 1 } } }),
      ballEvent("e2", { over: 0, ballInOver: 1, runs: { bat: 1 } }), // the free-hit ball itself, legal
    ];
    expect(freeHitPending(events, true)).toBe(false);
  });

  it("cfg.ballsPerInnings === null (whiteBall false, a real unlimited-overs/test cfg): a no-ball arms nothing", () => {
    const events = [ballEvent("e1", { over: 0, ballInOver: 1, runs: { bat: 0, extras: { kind: "noball", runs: 1 } } })];
    expect(freeHitPending(events, false)).toBe(false);
  });

  it("a wide with nothing before it never arms anything on its own", () => {
    const events = [ballEvent("e1", { over: 0, ballInOver: 1, runs: { bat: 0, extras: { kind: "wide", runs: 1 } } })];
    expect(freeHitPending(events, true)).toBe(false);
  });

  it("does not leak across an innings boundary — a no-ball pending at the tail of one innings never carries into the next", () => {
    const events = [
      // innings 1's last recorded ball: a no-ball, pending afterward.
      ballEvent("e1", { over: 4, ballInOver: 3, runs: { bat: 0, extras: { kind: "noball", runs: 1 } } }),
      // innings 2's first ball: a WIDE — chosen deliberately over a legal
      // ball, which would mask the bug under test (a legal ball clears
      // pending regardless of whether the boundary reset fired). Its
      // (over, ballInOver) REGRESSES versus e1's, which is what must trip
      // the reset.
      ballEvent("e2", { over: 0, ballInOver: 1, runs: { bat: 0, extras: { kind: "wide", runs: 1 } } }),
    ];
    expect(freeHitPending(events, true)).toBe(false);
  });

  it("ignores non-ball event types entirely, same convention as overDots", () => {
    const events = [
      ballEvent("e0", {}, "cricket.toss"),
      ballEvent("e1", { over: 0, ballInOver: 1, runs: { bat: 0, extras: { kind: "noball", runs: 1 } } }),
    ];
    expect(freeHitPending(events, true)).toBe(true);
  });
});

// D2 fix (Activity panel sign-off review, 2026-08-17): three `cricket.ball`
// rows in a real screenshot all read identically "Ball recorded" — the
// chassis ribbon builder resolves a caption per event TYPE and cannot know
// cricket's payload shape. `cricketBallDetail` is the skin-owned function
// `ActivityPanel`'s `resolveDetail` prop calls to fill that gap; mirrors
// `ballOutcomeSymbol`'s own decision order (wicket, then extras-by-kind,
// then plain runs) but returns WORDS via `t`, not compact symbols.
//
// R2b-cricket-over review fix (item 1): `cricketBallDetail` now takes a
// single `ActivityDetailContext` object (../../types.ts) instead of seven
// positional parameters — every call site below passes `{ t, eventType,
// payload, ... }` rather than positional args. Assertions are byte-
// identical to before this rewrite; only the call shape changed.
describe("cricketBallDetail", () => {
  it("returns undefined for a non-ball event type — the generic resolveDetail hook must not touch toss/review/retire/etc.", () => {
    expect(cricketBallDetail({ t, eventType: "cricket.toss", payload: {} })).toBeUndefined();
    expect(cricketBallDetail({ t, eventType: "cricket.review", payload: {} })).toBeUndefined();
  });

  it("a dot ball", () => {
    expect(cricketBallDetail({ t, eventType: "cricket.ball", payload: { runs: { bat: 0 } } })).toBe(
      "pad.cricket.ribbon.ball.dot",
    );
  });

  it("a single run uses the singular copy, not '1 runs'", () => {
    expect(cricketBallDetail({ t, eventType: "cricket.ball", payload: { runs: { bat: 1 } } })).toBe(
      "pad.cricket.ribbon.ball.run",
    );
  });

  it("plural runs interpolate the count", () => {
    expect(cricketBallDetail({ t, eventType: "cricket.ball", payload: { runs: { bat: 4 } } })).toBe(
      'pad.cricket.ribbon.ball.runs({"runs":4})',
    );
  });

  it("a wicket reuses the ALREADY-TRANSLATED wicket-kind vocab (ENUM_VOCAB.kind) — no new dictionary key needed", () => {
    expect(
      cricketBallDetail({ t, eventType: "cricket.ball", payload: { wicket: { kind: "bowled" }, runs: { bat: 0 } } }),
    ).toBe("wicket.bowled");
  });

  it("an extra reuses the ALREADY-TRANSLATED extra-kind vocab", () => {
    expect(
      cricketBallDetail({
        t,
        eventType: "cricket.ball",
        payload: { runs: { bat: 0, extras: { kind: "wide", runs: 1 } } },
      }),
    ).toBe("extra.wide");
  });

  it("wicket takes priority over extras when a dismissal happens to carry one (e.g. a run-out off a no-ball)", () => {
    expect(
      cricketBallDetail({
        t,
        eventType: "cricket.ball",
        payload: {
          wicket: { kind: "runout" },
          runs: { bat: 0, extras: { kind: "noball", runs: 1 } },
        },
      }),
    ).toBe("wicket.runout");
  });

  it("works identically for a super-over ball", () => {
    expect(cricketBallDetail({ t, eventType: "cricket.superover.ball", payload: { runs: { bat: 6 } } })).toBe(
      'pad.cricket.ribbon.ball.runs({"runs":6})',
    );
  });

  it("three different outcomes produce THREE different detail strings — the actual D2 differentiation this exists for", () => {
    const dot = cricketBallDetail({ t, eventType: "cricket.ball", payload: { runs: { bat: 0 } } });
    const four = cricketBallDetail({ t, eventType: "cricket.ball", payload: { runs: { bat: 4 } } });
    const wide = cricketBallDetail({
      t,
      eventType: "cricket.ball",
      payload: { runs: { bat: 0, extras: { kind: "wide", runs: 1 } } },
    });
    expect(new Set([dot, four, wide]).size).toBe(3);
  });
});

// R2b (owner request — "show when the bowler changed"): the data already
// exists on every `cricket.ball` payload (`bowler`), so this is a
// rendering change — `cricketBallDetail` compares the CURRENT ball's
// bowler against the PREVIOUS one's and APPENDS a note when they differ,
// rather than replacing the existing dot/run/wicket/extra detail.
//
// R2b-cricket-over review fix (item 2): there is no separate `prev`
// parameter any more — review PROVED `prev` was always exactly
// `history`'s own last element (`activity.tsx`'s `priorActivityEvents`;
// see `ActivityDetailContext`'s own doc, ../../types.ts). Every "previous
// ball" fixture below is threaded in as a one-element (or last-element)
// `history` array instead of a bare `prev` argument — `cricketBallDetail`
// derives the comparison event itself from `history`'s last element
// before calling `bowlerChanged`. Assertions are unchanged from before
// this rewrite.
//
// R2b follow-up (owner ruling, live-tile audit wave — "name the bowler, not
// just 'New bowler'"): the note now carries the RESOLVED display name via
// the optional/additive `personNames` field — mirrors `cfg`'s own shape
// exactly (a static, closure-captured data bag `pad-host.tsx` forwards
// verbatim). Falls back to `t("eventCopy.unknownPerson")` on a
// missing/absent name — the SAME fallback `bowlerBlockMessage`
// (cricket.tsx) already uses for the bowler context slot — NEVER the raw
// personId, proved below by asserting the output does not contain the id
// string at all, not merely that it takes some other branch.
describe("cricketBallDetail — bowler-changed note (R2b)", () => {
  const ball = (bowler: string, extra: Record<string, unknown> = {}) => ({
    type: "cricket.ball",
    payload: { bowler, runs: { bat: 0 }, ...extra },
  });
  // R2b (owner ruling, live-tile audit defect 4 wave — "name the bowler"):
  // the optional/additive `personNames` field — see this describe block's
  // own new tests below for the id-genuinely-unknown fallback.
  const names = { b1: "Ravi Bowler", b2: "Sam Spinner" };

  it("the same bowler across consecutive balls — no note appended", () => {
    const prev = ball("b1");
    expect(
      cricketBallDetail({ t, eventType: "cricket.ball", payload: { bowler: "b1", runs: { bat: 1 } }, history: [prev] }),
    ).toBe("pad.cricket.ribbon.ball.run");
  });

  it("a different bowler — the note is appended onto the existing base detail, carrying the RESOLVED name", () => {
    const prev = ball("b1");
    expect(
      cricketBallDetail({
        t,
        eventType: "cricket.ball",
        payload: { bowler: "b2", runs: { bat: 1 } },
        history: [prev],
        personNames: names,
      }),
    ).toBe('pad.cricket.ribbon.ball.bowlerChanged({"detail":"pad.cricket.ribbon.ball.run","name":"Sam Spinner"})');
  });

  it("a wicket off the first ball of a new spell still reads as a wicket — the note APPENDS, never replaces", () => {
    const prev = ball("b1");
    const result = cricketBallDetail({
      t,
      eventType: "cricket.ball",
      payload: { bowler: "b2", wicket: { kind: "bowled" }, runs: { bat: 0 } },
      history: [prev],
      personNames: names,
    });
    expect(result).toBe('pad.cricket.ribbon.ball.bowlerChanged({"detail":"wicket.bowled","name":"Sam Spinner"})');
  });

  it("no personNames given at all — falls back to the unknown-person copy, never the raw id", () => {
    const prev = ball("b1");
    const result = cricketBallDetail({
      t,
      eventType: "cricket.ball",
      payload: { bowler: "b2", runs: { bat: 1 } },
      history: [prev],
    });
    expect(result).toBe(
      'pad.cricket.ribbon.ball.bowlerChanged({"detail":"pad.cricket.ribbon.ball.run","name":"eventCopy.unknownPerson"})',
    );
    expect(result).not.toContain("b2"); // never a raw personId
  });

  it("a personNames map that does not cover the new bowler — same fallback, never the raw id", () => {
    const prev = ball("b1");
    const result = cricketBallDetail({
      t,
      eventType: "cricket.ball",
      payload: { bowler: "b2", runs: { bat: 1 } },
      history: [prev],
      personNames: { b1: "Ravi Bowler" }, // has b1, not the new bowler b2
    });
    expect(result).toBe(
      'pad.cricket.ribbon.ball.bowlerChanged({"detail":"pad.cricket.ribbon.ball.run","name":"eventCopy.unknownPerson"})',
    );
    expect(result).not.toContain("b2");
  });

  it("no prev at all (first ball of an innings) does not crash and does not claim a change", () => {
    expect(() =>
      cricketBallDetail({ t, eventType: "cricket.ball", payload: { bowler: "b1", runs: { bat: 0 } } }),
    ).not.toThrow();
    expect(cricketBallDetail({ t, eventType: "cricket.ball", payload: { bowler: "b1", runs: { bat: 0 } } })).toBe(
      "pad.cricket.ribbon.ball.dot",
    );
    expect(
      cricketBallDetail({
        t,
        eventType: "cricket.ball",
        payload: { bowler: "b1", runs: { bat: 0 } },
        history: undefined,
      }),
    ).toBe("pad.cricket.ribbon.ball.dot");
  });

  it("a structural prev (core.start) is never treated as 'the previous ball' — no note, even though its own payload happens to carry a same-named field", () => {
    const prev = { type: "core.start", payload: { bowler: "b1" } };
    expect(
      cricketBallDetail({ t, eventType: "cricket.ball", payload: { bowler: "b2", runs: { bat: 0 } }, history: [prev] }),
    ).toBe("pad.cricket.ribbon.ball.dot");
  });

  it("a cricket.innings.summary prev (structural, not a ball) is likewise never treated as the previous ball", () => {
    const prev = { type: "cricket.innings.summary", payload: { bowler: "b1" } };
    expect(
      cricketBallDetail({ t, eventType: "cricket.ball", payload: { bowler: "b2", runs: { bat: 0 } }, history: [prev] }),
    ).toBe("pad.cricket.ribbon.ball.dot");
  });

  it("cricket.ball and cricket.superover.ball both count as BALL_EVENT_TYPES for this comparison", () => {
    const prev = ball("b1");
    expect(
      cricketBallDetail({
        t,
        eventType: "cricket.superover.ball",
        payload: { bowler: "b2", runs: { bat: 0 } },
        history: [prev],
        personNames: names,
      }),
    ).toBe('pad.cricket.ribbon.ball.bowlerChanged({"detail":"pad.cricket.ribbon.ball.dot","name":"Sam Spinner"})');
  });

  it("an empty-string bowler on either side never counts as a change — the bowling order not populated yet", () => {
    const prevEmpty = { type: "cricket.ball", payload: { bowler: "", runs: { bat: 0 } } };
    expect(
      cricketBallDetail({
        t,
        eventType: "cricket.ball",
        payload: { bowler: "b1", runs: { bat: 0 } },
        history: [prevEmpty],
      }),
    ).toBe("pad.cricket.ribbon.ball.dot");

    const prevReal = ball("b1");
    expect(
      cricketBallDetail({
        t,
        eventType: "cricket.ball",
        payload: { bowler: "", runs: { bat: 0 } },
        history: [prevReal],
      }),
    ).toBe("pad.cricket.ribbon.ball.dot");
  });
});

// R2b (owner ruling, live-tile audit — freeHit chip removal): the activity
// log's own free-hit label, via the SAME `freeHitPending` fold the indicator
// uses (see that describe block's own header for the correctness trap and
// the innings-boundary reset). `history` (optional/additive) is every
// STRICTLY OLDER, non-voided event, OLDEST FIRST — `ActivityPanel`'s own
// `priorActivityEvents` (activity.tsx), which can require walking back past
// more than just the immediate neighbour to find the last LEGAL delivery.
// `cfg` (also optional/additive) is `PadHostView.cfg` verbatim, re-derived
// the same `asCfg()` way every other builder in this file already does —
// needed only for `ballsPerInnings !== null` (whiteBall), a fact no ball
// payload carries on its own. Both undefined (the pre-existing call shape)
// means "cannot determine" — never claims a free hit on a guess, same
// "omitting is always safe" posture the owner's ruling on `payload.freeHit`
// itself already established.
//
// R2b-cricket-over review fix (item 1): call sites below pass a single
// `ActivityDetailContext` object rather than positional arguments; item 2
// folds the standalone `prev` argument the last test used to also pass
// into `history` (its own last element) — see this file's "bowler-changed
// note" describe block above for the full item-2 rationale. Assertions are
// unchanged from before this rewrite.
describe("cricketBallDetail — free hit note (R2b)", () => {
  const whiteBallCfg = cfg(); // ballsPerInnings: 120
  const testCfg = cfg({ inningsPerSide: 2, ballsPerInnings: null }); // the engine's own shipped "test" variant shape

  it("no-ball -> wide -> legal ball: the legal ball's OWN row is labelled a free hit", () => {
    const history = [
      { type: "cricket.ball", payload: { over: 0, ballInOver: 5, runs: { bat: 0, extras: { kind: "noball", runs: 1 } } } },
      { type: "cricket.ball", payload: { over: 0, ballInOver: 5, runs: { bat: 0, extras: { kind: "wide", runs: 1 } } } },
    ];
    const result = cricketBallDetail({
      t,
      eventType: "cricket.ball",
      payload: { over: 0, ballInOver: 5, runs: { bat: 1 } },
      history,
      cfg: whiteBallCfg,
    });
    expect(result).toBe('pad.cricket.ribbon.ball.freeHit({"detail":"pad.cricket.ribbon.ball.run"})');
  });

  it("consecutive no-balls: the second no-ball's own row is ALSO labelled — it is bowled while still pending", () => {
    const history = [
      { type: "cricket.ball", payload: { over: 0, ballInOver: 5, runs: { bat: 0, extras: { kind: "noball", runs: 1 } } } },
    ];
    const result = cricketBallDetail({
      t,
      eventType: "cricket.ball",
      payload: { over: 0, ballInOver: 5, runs: { bat: 0, extras: { kind: "noball", runs: 1 } } },
      history,
      cfg: whiteBallCfg,
    });
    expect(result).toBe('pad.cricket.ribbon.ball.freeHit({"detail":"extra.noball"})');
  });

  it("a legal delivery's own row is not labelled when no free hit was pending before it", () => {
    const result = cricketBallDetail({
      t,
      eventType: "cricket.ball",
      payload: { over: 0, ballInOver: 1, runs: { bat: 1 } },
      history: [],
      cfg: whiteBallCfg,
    });
    expect(result).toBe("pad.cricket.ribbon.ball.run");
  });

  it("the ball AFTER the free-hit ball is not labelled — consumed", () => {
    const history = [
      { type: "cricket.ball", payload: { over: 0, ballInOver: 5, runs: { bat: 0, extras: { kind: "noball", runs: 1 } } } },
      { type: "cricket.ball", payload: { over: 0, ballInOver: 5, runs: { bat: 1 } } }, // the free hit itself
    ];
    const result = cricketBallDetail({
      t,
      eventType: "cricket.ball",
      payload: { over: 0, ballInOver: 6, runs: { bat: 0 } },
      history,
      cfg: whiteBallCfg,
    });
    expect(result).toBe("pad.cricket.ribbon.ball.dot");
  });

  it("cfg.ballsPerInnings === null: never labelled, even right after a no-ball", () => {
    const history = [
      { type: "cricket.ball", payload: { over: 0, ballInOver: 1, runs: { bat: 0, extras: { kind: "noball", runs: 1 } } } },
    ];
    const result = cricketBallDetail({
      t,
      eventType: "cricket.ball",
      payload: { over: 0, ballInOver: 1, runs: { bat: 1 } },
      history,
      cfg: testCfg,
    });
    expect(result).toBe("pad.cricket.ribbon.ball.run");
  });

  it("omitting history and cfg (every pre-existing call site) never claims a free hit — undefined means 'cannot determine', not 'guess'", () => {
    expect(
      cricketBallDetail({ t, eventType: "cricket.ball", payload: { over: 0, ballInOver: 5, runs: { bat: 1 } } }),
    ).toBe("pad.cricket.ribbon.ball.run");
  });

  it("composes with the bowler-changed note — free hit wraps whatever detail already includes", () => {
    const prev = {
      type: "cricket.ball",
      payload: { bowler: "b1", over: 0, ballInOver: 5, runs: { bat: 0, extras: { kind: "noball", runs: 1 } } },
    };
    const history = [prev];
    const result = cricketBallDetail({
      t,
      eventType: "cricket.ball",
      payload: { bowler: "b2", over: 0, ballInOver: 5, runs: { bat: 1 } },
      history,
      cfg: whiteBallCfg,
    })!;
    expect(result.startsWith("pad.cricket.ribbon.ball.freeHit(")).toBe(true);
    expect(result).toContain("pad.cricket.ribbon.ball.bowlerChanged");
  });
});

describe("runRate", () => {
  it("is null before any legal ball", () => {
    expect(runRate(0, 0, 6)).toBeNull();
  });
  it("scales by ballsPerOver, not a hardcoded 6", () => {
    expect(runRate(30, 30, 6)).toBe(6); // 30 runs off 5 overs of 6 = 6 RPO
    expect(runRate(30, 30, 5)).toBe(5); // 30 runs off 6 overs of 5 = 5 RPO
  });
});

describe("variantCode", () => {
  it("reads TEST for a two-innings cfg regardless of other fields", () => {
    expect(variantCode({ inningsPerSide: 2, ballsPerOver: 6 })).toBe("TEST");
  });
  it("reads HUNDRED from the 5-ball over", () => {
    expect(variantCode({ ballsPerOver: 5 })).toBe("HUNDRED");
  });
  it("reads T20/ODI from ballsPerInnings", () => {
    expect(variantCode({ ballsPerOver: 6, ballsPerInnings: 120 })).toBe("T20");
    expect(variantCode({ ballsPerOver: 6, ballsPerInnings: 300 })).toBe("ODI");
  });
  it("is null for a cfg matching none of the four shipped presets — never fabricates a label", () => {
    expect(variantCode({ ballsPerOver: 6, ballsPerInnings: 40 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolvePhase — G3, mutation target #3
// ---------------------------------------------------------------------------

describe("resolvePhase", () => {
  it("maps every engine phase to its PadPhase", () => {
    expect(resolvePhase({ state: { phase: "pre" } })).toBe("pre");
    expect(resolvePhase({ state: { phase: "live" } })).toBe("live");
    expect(resolvePhase({ state: { phase: "super_over" } })).toBe("live");
    expect(resolvePhase({ state: { phase: "done" } })).toBe("post");
    expect(resolvePhase({ state: { phase: "final" } })).toBe("post");
  });
});

// ---------------------------------------------------------------------------
// buildScorebug
// ---------------------------------------------------------------------------

describe("buildScorebug", () => {
  it("renders the batting score and overs halves, both passive", () => {
    const spec = buildScorebug(view(), t);
    expect(spec.halves[0]!.big).toBe("12/1");
    expect(spec.halves[1]!.big).toBe("0.5");
    expect(spec.halves[0]!.tappable).toBeUndefined();
    expect(spec.halves[1]!.tappable).toBeUndefined();
  });

  it("context is variant · over · run rate, joined with the chassis separator", () => {
    const spec = buildScorebug(view(), t);
    expect(spec.context).toBe("T20 · scorepad.skin.cricket.context.over 0.5 · scorepad.skin.cricket.context.runRate 14.4");
  });

  it("omits the variant segment for a cfg matching no shipped preset", () => {
    const spec = buildScorebug(view({ cfg: cfg({ ballsPerInnings: 40 }) }), t);
    expect(spec.context.startsWith("T20")).toBe(false);
    expect(spec.context).toContain("scorepad.skin.cricket.context.over");
  });

  it("strip shows striker (accented, on-strike marker), non-striker, dots, bowler", () => {
    const spec = buildScorebug(view({ state: state({ innings: [innings()] }) }), t);
    expect(spec.strip[0]).toEqual({ value: "▸Home One", accent: true });
    expect(spec.strip[1]).toEqual({ value: "Home Two" });
    expect(spec.strip[3]).toEqual({ value: "⚾Away One" });
  });

  // Regression: v2's chaseValue/`ck-revised-target` (cricket-skin.tsx) showed
  // the chasing side's target the moment one existed; the v3 rewrite never
  // read `revisedTarget`/`targetSource` at all — this wave's own blast
  // radius, not a deferred gap.
  describe("revised target (regression: v2's ck-revised-target had no v3 equivalent)", () => {
    it("appends nothing to the strip when there is no revised target", () => {
      const spec = buildScorebug(view(), t);
      expect(spec.strip).toHaveLength(4);
    });

    // Major 3 (this wave's own Blocker/Major review): these four fixtures
    // now open a SECOND innings before asserting on the target, matching
    // `chaseTarget`'s ported-from-v2 guard (a single-innings cfg shows no
    // target at all — explicit or arithmetic — before a second innings
    // exists; see `chaseTarget`'s own doc). The pre-Major-3 version of this
    // suite set `revisedTarget` against a ONE-innings fixture, which only
    // passed because the OLD implementation had no innings-length gate at
    // all — an artificial state the real engine's own UI never shows a
    // target for. `innings()` (the second, open element) keeps the SAME
    // striker/nonStriker/bowler `fine` block the pre-existing strip[0..3]
    // assertions already depend on, so only the target-shaped assertions
    // below actually changed meaning.
    it("appends the target after bowler, without disturbing the existing four items", () => {
      const spec = buildScorebug(
        view({
          state: state({
            innings: [innings({ closed: true }), innings()],
            revisedTarget: 165,
            targetSource: "manual",
          }),
        }),
        t,
      );
      expect(spec.strip).toHaveLength(5);
      expect(spec.strip[0]).toEqual({ value: "▸Home One", accent: true });
      expect(spec.strip[1]).toEqual({ value: "Home Two" });
      expect(spec.strip[3]).toEqual({ value: "⚾Away One" });
      expect(spec.strip[4]).toEqual({
        label: "scorepad.skin.cricket.header.target",
        value: "165",
        accent: true,
      });
    });

    it("captions it DLS par only when cfg.dls is enabled AND the fold sourced it from dls", () => {
      const spec = buildScorebug(
        view({
          cfg: cfg({ dls: { enabled: true } }),
          state: state({ innings: [innings({ closed: true }), innings()], revisedTarget: 142, targetSource: "dls" }),
        }),
        t,
      );
      expect(spec.strip[4]).toEqual({
        label: "scorepad.skin.cricket.header.dlsPar",
        value: "142",
        accent: true,
      });
    });

    it("falls back to the plain target caption when cfg.dls is currently disabled, even if the fold says dls (mirrors v2's own isDls guard)", () => {
      const spec = buildScorebug(
        view({
          cfg: cfg({ dls: { enabled: false } }),
          state: state({ innings: [innings({ closed: true }), innings()], revisedTarget: 142, targetSource: "dls" }),
        }),
        t,
      );
      expect(spec.strip[4]).toEqual({
        label: "scorepad.skin.cricket.header.target",
        value: "142",
        accent: true,
      });
    });

    it("is available from fidelity band 1, not gated to band 3", () => {
      const spec = buildScorebug(
        view({
          band: 1,
          state: state({ innings: [innings({ closed: true }), innings()], revisedTarget: 99, targetSource: "manual" }),
        }),
        t,
      );
      expect(spec.strip[4]).toEqual({
        label: "scorepad.skin.cricket.header.target",
        value: "99",
        accent: true,
      });
    });
  });

  it("dots read from view.events, sized by cfg ballsPerOver — a hundred cfg's strip differs from a 6-ball one", () => {
    const events = [
      ballEvent("f1", { ballInOver: 1, runs: { bat: 0 } }),
      ballEvent("f2", { ballInOver: 2, runs: { bat: 1 } }),
      ballEvent("f3", { ballInOver: 3, runs: { bat: 0 } }),
      ballEvent("f4", { ballInOver: 4, runs: { bat: 4 }, boundary: 4 }),
      ballEvent("f5", { ballInOver: 5, runs: { bat: 1 } }),
    ];
    const hundred = buildScorebug(view({ cfg: cfg({ ballsPerOver: 5, ballsPerInnings: 100 }), events }), t);
    expect(hundred.strip[2]).toEqual({ value: "• 1 • 4 1" });
    // The overs figure ALSO goes through ballsPerOverOf(view.cfg): at bpo=5,
    // 5 legal balls is a completed over ("1.0"); at a wrongly-assumed 6 it
    // would read "0.5" instead — a real, integration-level dependency on
    // reading cfg's own ballsPerOver, not just the standalone helper.
    expect(hundred.context).toContain("HUNDRED · scorepad.skin.cricket.context.over 1.0");
  });

  it("phase mirrors resolvePhase", () => {
    expect(buildScorebug(view({ state: state({ phase: "done" }) }), t).phase).toBe("post");
  });
});

// R2b (owner ruling, live-tile audit — freeHit chip removal): the READ-ONLY
// indicator that replaces the chip. Appended to `strip` — the SAME "ambient,
// always-on delivery status" surface the over dots/bowler/target already
// use — rather than `ContextSlot.message` (a PERSON slot's own "why is this
// chip's affordance blocked" explanation; a free hit is a property of the
// DELIVERY, not of any one person, so reusing it would be a misfit, not
// reuse — see this task's own report for the fuller reasoning) or a new
// chassis surface. `StripItem.id` (types.ts, optional/additive) exists
// SOLELY so this item has a stable, localisation-independent `data-*` hook
// (`scorebug.tsx`'s `data-strip-item-id`) a Playwright spec can target —
// `strip` had no per-item identity before this, and text-matching a
// translated string is not a stable hook. Driven by the SAME
// `freeHitPending` fold `cricketBallDetail`'s own note uses (that describe
// block's header has the full correctness-trap/innings-boundary reasoning).
describe("buildScorebug — free hit indicator (R2b)", () => {
  it("appends an accented, identifiable strip item when a free hit is pending", () => {
    const events = [ballEvent("e1", { over: 0, ballInOver: 5, runs: { bat: 0, extras: { kind: "noball", runs: 1 } } })];
    const spec = buildScorebug(view({ events }), t);
    expect(spec.strip.find((s) => s.id === "freeHit")).toEqual({
      id: "freeHit",
      value: "scorepad.skin.cricket.header.freeHit",
      accent: true,
    });
  });

  it("is absent when nothing is pending — the base 4-item strip is untouched", () => {
    const spec = buildScorebug(view(), t);
    expect(spec.strip.find((s) => s.id === "freeHit")).toBeUndefined();
    expect(spec.strip).toHaveLength(4);
  });

  it("a legal ball after the no-ball clears it — the indicator disappears again", () => {
    const events = [
      ballEvent("e1", { over: 0, ballInOver: 5, runs: { bat: 0, extras: { kind: "noball", runs: 1 } } }),
      ballEvent("e2", { over: 0, ballInOver: 5, runs: { bat: 1 } }),
    ];
    const spec = buildScorebug(view({ events }), t);
    expect(spec.strip.find((s) => s.id === "freeHit")).toBeUndefined();
  });

  it("respects cfg.ballsPerInnings === null (a real unlimited-overs/test cfg) — no indicator even right after a no-ball", () => {
    const events = [ballEvent("e1", { over: 0, ballInOver: 1, runs: { bat: 0, extras: { kind: "noball", runs: 1 } } })];
    const spec = buildScorebug(
      view({ cfg: cfg({ inningsPerSide: 2, ballsPerInnings: null }), events }),
      t,
    );
    expect(spec.strip.find((s) => s.id === "freeHit")).toBeUndefined();
  });

  it("never shown outside live/super-over phase, even if a stale pending state were somehow computed", () => {
    const events = [ballEvent("e1", { over: 0, ballInOver: 5, runs: { bat: 0, extras: { kind: "noball", runs: 1 } } })];
    const spec = buildScorebug(view({ state: state({ phase: "done" }), events }), t);
    expect(spec.strip.find((s) => s.id === "freeHit")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// chaseTarget — Major 3 (R2 review finding). buildScorebug's ORIGINAL fix
// only read an explicit `revisedTarget`; v2's own `chaseValue`
// (../../skins/cricket-skin.tsx) ALSO derived a plain "first innings + 1"
// target for an ordinary chase with no DLS revise at all — the COMMON case
// (most matches never see a `cricket.revise`). This ports that arithmetic
// fallback, matching v2 exactly.
// ---------------------------------------------------------------------------

describe("chaseTarget", () => {
  it("is null before a second innings exists — nothing to chase yet", () => {
    expect(chaseTarget(cfg(), state({ innings: [innings({ closed: true })] }))).toBeNull();
  });

  it("single innings, second innings started, no revise at all: first innings runs + 1 — the common case Major 3 restores", () => {
    const first = innings({ runs: 150, closed: true });
    const second = innings({ runs: 40, closed: false });
    expect(chaseTarget(cfg(), state({ innings: [first, second] }))).toEqual({ value: 151, isDls: false });
  });

  it("an explicit revisedTarget wins over the arithmetic fallback", () => {
    const first = innings({ runs: 150, closed: true });
    const second = innings({ runs: 40, closed: false });
    expect(
      chaseTarget(cfg(), state({ innings: [first, second], revisedTarget: 130, targetSource: "manual" })),
    ).toEqual({ value: 130, isDls: false });
  });

  it("isDls true only when cfg.dls is enabled AND the fold sourced the value from dls", () => {
    const first = innings({ runs: 150, closed: true });
    const second = innings({ runs: 40, closed: false });
    expect(
      chaseTarget(
        cfg({ dls: { enabled: true } }),
        state({ innings: [first, second], revisedTarget: 130, targetSource: "dls" }),
      ),
    ).toEqual({ value: 130, isDls: true });
  });

  it("two-innings (test) cfg NEVER gets the arithmetic fallback — only an explicit revise, matching v2 exactly", () => {
    const first = innings({ runs: 300, closed: true });
    const second = innings({ runs: 40, closed: false });
    expect(chaseTarget(cfg({ inningsPerSide: 2 }), state({ innings: [first, second] }))).toBeNull();
  });

  it("two-innings cfg DOES read an explicit revise", () => {
    const first = innings({ runs: 300, closed: true });
    const second = innings({ runs: 40, closed: false });
    expect(
      chaseTarget(cfg({ inningsPerSide: 2 }), state({ innings: [first, second], revisedTarget: 210, targetSource: "manual" })),
    ).toEqual({ value: 210, isDls: false });
  });
});

describe("buildScorebug — ordinary chase target (Major 3, integration)", () => {
  it("shows the plain arithmetic target on the strip once a second innings starts, even with no revise at all", () => {
    const first = innings({ runs: 150, closed: true });
    const second = innings({
      runs: 40,
      wickets: 2,
      legalBalls: 18,
      closed: false,
      fine: { striker: "h1", nonStriker: "h2", currentBowler: "a1", freeHitPending: false },
    });
    const spec = buildScorebug(view({ state: state({ innings: [first, second] }) }), t);
    expect(spec.strip[4]).toEqual({ label: "scorepad.skin.cricket.header.target", value: "151", accent: true });
  });
});

// ---------------------------------------------------------------------------
// buildTiles
// ---------------------------------------------------------------------------

describe("buildTiles", () => {
  it("declares at most two primary tiles for the live phase", () => {
    const tiles = buildTiles(view());
    const livePrimary = tiles.filter((tl) => tl.kind === "primary" && tl.phases.includes("live"));
    expect(livePrimary).toHaveLength(2);
    expect(livePrimary.map((tl) => tl.id).sort()).toEqual(["run0", "run1"]);
  });

  it("run keypad covers 0,1,2,3,4,6 — never 5", () => {
    const ids = buildTiles(view())
      .filter((tl) => tl.id.startsWith("run"))
      .map((tl) => tl.id);
    expect(ids.sort()).toEqual(["run0", "run1", "run2", "run3", "run4", "run6"]);
  });

  it("wicket is the one destructive tile, full width", () => {
    const wicket = buildTiles(view()).find((tl) => tl.id === "wicket")!;
    expect(wicket.kind).toBe("destructive");
    expect(wicket.span).toBe(4);
    expect(wicket.action).toEqual({ sheet: "wicket" });
  });

  it("wide gets its own tile, separate from the four minor extras", () => {
    const tiles = buildTiles(view());
    expect(tiles.some((tl) => tl.id === "wide" && tl.kind === "standard")).toBe(true);
    const minor = tiles.filter((tl) => tl.id.startsWith("extra-"));
    expect(minor.map((tl) => tl.id).sort()).toEqual(["extra-bye", "extra-legbye", "extra-noball", "extra-penalty"]);
    expect(minor.every((tl) => tl.kind === "minor")).toBe(true);
  });

  it("toss is the sole pre-phase tile", () => {
    const tiles = buildTiles(view());
    const pre = tiles.filter((tl) => tl.phases.includes("pre"));
    expect(pre.map((tl) => tl.id)).toEqual(["toss"]);
  });

  it("declare only appears for a two-innings (test) cfg", () => {
    expect(buildTiles(view()).some((tl) => tl.id === "declare")).toBe(false);
    expect(buildTiles(view({ cfg: cfg({ inningsPerSide: 2 }) })).some((tl) => tl.id === "declare")).toBe(true);
  });

  it("the run keypad dispatches cricket.superover.ball while the engine is in a super over", () => {
    const tiles = buildTiles(view({ state: state({ phase: "super_over" }) }));
    const run0 = tiles.find((tl) => tl.id === "run0")!;
    expect(run0.action).toMatchObject({ event: { type: "cricket.superover.ball" } });
  });

  it("a run tile's payload carries over/ballInOver/striker/nonStriker/bowler and the tapped run count", () => {
    const tiles = buildTiles(view());
    const run4 = tiles.find((tl) => tl.id === "run4")!;
    expect(run4.action).toEqual({
      event: {
        type: "cricket.ball",
        payload: { over: 0, ballInOver: 6, striker: "h1", nonStriker: "h2", bowler: "a1", runs: { bat: 4 }, boundary: 4 },
      },
    });
  });

  it("More is a minor, full-width catch-all visible in live and post, never pre", () => {
    const more = buildTiles(view()).find((tl) => tl.id === "more")!;
    expect(more.kind).toBe("minor");
    expect(more.phases.sort()).toEqual(["live", "post"]);
  });

  // R2b (Q1 owner ruling, `_INDEX.md`) — over-by-over entry point, gated by
  // the fold's own fidelity, never a band/config check.
  it("the over-summary tile is hidden once the innings is ball-level (fine)", () => {
    // Default `view()` fixture carries a real `fine` innings already.
    expect(buildTiles(view()).some((tl) => tl.id === "overSummary")).toBe(false);
  });

  it("the over-summary tile is shown, alongside the run tiles, when no innings is open yet", () => {
    const tiles = buildTiles(view({ state: state({ innings: [] }) }));
    const over = tiles.find((tl) => tl.id === "overSummary");
    expect(over).toMatchObject({ kind: "primary", span: 2, phases: ["live"], action: { sheet: "overSummary" } });
    expect(tiles.some((tl) => tl.id === "run0")).toBe(true); // Q1: both lanes available pre-commitment
  });

  it("the over-summary tile is shown, and every ball-derived tile is hidden, once the innings is coarse", () => {
    const tiles = buildTiles(view({ state: state({ innings: [innings({ fine: null })] }) }));
    expect(tiles.some((tl) => tl.id === "overSummary")).toBe(true);
    const ballDerived = [
      "run0", "run1", "run2", "run3", "run4", "run6",
      "wide", "wicket", "extra-noball", "extra-bye", "extra-legbye", "extra-penalty",
    ];
    for (const id of ballDerived) {
      expect(tiles.some((tl) => tl.id === id)).toBe(false);
    }
  });

  it("non-ball tiles (review/inningsClose) stay visible regardless of fidelity", () => {
    const tiles = buildTiles(view({ state: state({ innings: [innings({ fine: null })] }) }));
    for (const id of ["review", "inningsClose"]) {
      expect(tiles.some((tl) => tl.id === id)).toBe(true);
    }
  });

  // R2b follow-up (owner sign-off, single-line label fix): the owner
  // rejected the two-line render this test used to pin (`sublabelText`
  // beneath a bare "End of over" label) — the over number now rides INSIDE
  // the label sentence itself ("End of over 2"), via `TileSpec.labelText`
  // (types.ts), which wins over `label`'s own key at render time
  // (tile-grid.tsx). Building that string needs a REAL `t`, so `buildTiles`
  // now takes one (defaulted, see its own header comment) — this test
  // passes this file's own module-level `t` fixture explicitly. Asserting
  // `sublabelText`/`sublabel` are both undefined is the load-bearing other
  // half: it proves the number no longer takes the old two-line path at
  // all, and `label` staying the real key is what tile-grid.tsx falls back
  // to for every OTHER tile that doesn't set labelText.
  it("the over-summary tile's labelText carries the 1-indexed over this entry would complete, INSIDE the label — never a separate sublabelText", () => {
    const tiles = buildTiles(view({ state: state({ innings: [innings({ fine: null, legalBalls: 30 })] }) }), t);
    const over = tiles.find((tl) => tl.id === "overSummary")!;
    expect(over.label).toBe("pad.cricket.action.endOfOver");
    expect(over.labelText).toBe(t("pad.cricket.action.endOfOver", { over: 6 }));
    expect(over.sublabelText).toBeUndefined();
    expect(over.sublabel).toBeUndefined();
  });

  // This file's own `t` fixture (above) ignores its `vars` argument (just
  // serialises it), which proves the CALL was made with the right key+vars
  // but not that a real dictionary would actually interpolate it into a
  // single readable sentence — repeats the same call with the REAL t()
  // from lib/i18n-runtime.ts against a seeded dict, same pattern
  // guided-sheet.test.ts's stepper aria-label fix (c3779d9b) and
  // tiles.test.ts's own sublabelText/labelText blocks already establish
  // for the identical problem (a stub that can't distinguish "resolved"
  // from "echoed verbatim").
  it("review fix, interpolation: labelText genuinely threads {over} through the REAL t(), not just the bare key", () => {
    const dict: Dict = { "pad.cricket.action.endOfOver": "End of over {over}" };
    const realTStub: TFn = (k, vars) => realT(dict, k, vars);
    const tiles = buildTiles(
      view({ state: state({ innings: [innings({ fine: null, legalBalls: 30 })] }) }),
      realTStub,
    );
    const over = tiles.find((tl) => tl.id === "overSummary")!;
    expect(over.labelText).toBe("End of over 6");
  });

  it("the over-summary tile sits before More in tile order", () => {
    const tiles = buildTiles(view({ state: state({ innings: [] }) }));
    const overIdx = tiles.findIndex((tl) => tl.id === "overSummary");
    const moreIdx = tiles.findIndex((tl) => tl.id === "more");
    expect(overIdx).toBeGreaterThanOrEqual(0);
    expect(overIdx).toBeLessThan(moreIdx);
  });
});

// ---------------------------------------------------------------------------
// buildTiles — minor extras defaults (R2b task 4, `_INDEX.md`, owner ruling).
// The extras TILES keep firing instantly at a sensible default; the DOCK
// (below) is where the variable runs get entered. This block only proves
// the TILE-tap defaults; the dock's own chip behaviour is proved further
// down.
// ---------------------------------------------------------------------------

describe("buildTiles — minor extras defaults (R2b task 4)", () => {
  it("penalty defaults to 5 runs (Law 41), not the ordinary single every other minor extra gets", () => {
    const tiles = buildTiles(view());
    const penalty = tiles.find((tl) => tl.id === "extra-penalty")!;
    expect(penalty.action).toEqual({
      event: {
        type: "cricket.ball",
        payload: {
          over: 0, ballInOver: 6, striker: "h1", nonStriker: "h2", bowler: "a1",
          runs: { bat: 0, extras: { kind: "penalty", runs: 5 } },
        },
      },
    });
  });

  it("ignoring the dock leaves the plain no-ball extra unchanged — 1 run, bat 0 — the common path is untouched", () => {
    const tiles = buildTiles(view());
    const noball = tiles.find((tl) => tl.id === "extra-noball")!;
    expect(noball.action).toEqual({
      event: {
        type: "cricket.ball",
        payload: {
          over: 0, ballInOver: 6, striker: "h1", nonStriker: "h2", bowler: "a1",
          runs: { bat: 0, extras: { kind: "noball", runs: 1 } },
        },
      },
    });
  });

  it("bye and leg bye tiles still default to the ordinary single — the penalty fix does not touch them", () => {
    const tiles = buildTiles(view());
    for (const kind of ["bye", "legbye"] as const) {
      const tile = tiles.find((tl) => tl.id === `extra-${kind}`)!;
      const action = tile.action as unknown as { event: { payload: { runs: unknown } } };
      expect(action.event.payload.runs).toEqual({ bat: 0, extras: { kind, runs: 1 } });
    }
  });
});

// ---------------------------------------------------------------------------
// buildDock
// ---------------------------------------------------------------------------

// R2b (owner ruling, live-tile audit): the freeHit chip is GONE — it was
// offered unconditionally (never gated on whether a free hit was actually
// pending) and the engine refused it outright the moment it wasn't,
// surfacing as a generic rejection the owner hit live (cricket.ts:1224,
// "freeHit flagged but no free hit is pending"). Replaced by a READ-ONLY
// indicator (buildScorebug, below) — the scorer no longer declares what the
// fold already knows. `buildDock` itself stays non-null for every ball event
// type (never `null` merely because `chips` ends up empty):
// `e2e/scorepad-v3-cricket.spec.ts`'s undo tests tap a PLAIN run and assert
// `[data-role="v3-dock"]` becomes visible, using dock presence as a generic
// "this tap is still in the hold window" proxy — unrelated to free hit
// specifically. Returning `null` for an empty-chips spec would silently
// break that already-passing coverage; keeping the spec (title + dismiss +
// countdown, zero chips) preserves it.
describe("buildDock", () => {
  it("offers no chips for a plain ball event — freeHit is gone — but the spec itself stays non-null", () => {
    const dock = buildDock("cricket.ball", t)!;
    expect(dock).not.toBeNull();
    expect(dock.title).toBe("pad.cricket.dock.title");
    expect(dock.chips).toEqual([]);
  });
  it("also stays non-null (with no chips) for a super-over ball", () => {
    const dock = buildDock("cricket.superover.ball", t)!;
    expect(dock).not.toBeNull();
    expect(dock.chips).toEqual([]);
  });
  it("is null for every non-ball event type — never a stray dock on an admin action", () => {
    expect(buildDock("cricket.toss", t)).toBeNull();
    expect(buildDock("cricket.retire", t)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildDock — payload-aware chips (R2b task 4, `_INDEX.md`, owner ruling).
// The chassis now threads the held tap's own payload through as an
// OPTIONAL 3rd argument (pad-host.tsx's widened HeldTap/resolveDockSpec) —
// this is what lets the dock tell a no-ball apart from a plain single, both
// of which dispatch the identical `cricket.ball` event TYPE.
// ---------------------------------------------------------------------------

describe("buildDock — payload-aware chips (R2b task 4)", () => {
  it("omitting payload entirely (every pre-existing 2-arg call site): no chips, freeHit is gone", () => {
    const dock = buildDock("cricket.ball", t)!;
    expect(dock.chips.map((c) => c.id)).toEqual([]);
  });

  it("a plain run tap's dock has no chips — no extras field at all", () => {
    const dock = buildDock("cricket.ball", t, { runs: { bat: 4 }, boundary: 4 })!;
    expect(dock.chips.map((c) => c.id)).toEqual([]);
  });

  it("a no-ball's dock offers bat-run chips +1/+2/+3/+4/+6 — freeHit no longer among them", () => {
    const payload = { runs: { bat: 0, extras: { kind: "noball", runs: 1 } } };
    const dock = buildDock("cricket.ball", t, payload)!;
    expect(dock.chips.map((c) => c.id)).toEqual(["batRun1", "batRun2", "batRun3", "batRun4", "batRun6"]);
  });

  it("tapping a no-ball's +3 chip sets bat:3, preserving the noball extra verbatim — the WHOLE payload, not just bat", () => {
    const payload = { runs: { bat: 0, extras: { kind: "noball", runs: 1 } } };
    const dock = buildDock("cricket.ball", t, payload)!;
    const chip = dock.chips.find((c) => c.id === "batRun3")!;
    expect(chip.mutate(payload)).toEqual({ runs: { bat: 3, extras: { kind: "noball", runs: 1 } } });
  });

  it("a no-ball's +4/+6 bat-run chip also stamps boundary, matching the plain run4/run6 tile's own convention", () => {
    const payload = { runs: { bat: 0, extras: { kind: "noball", runs: 1 } } };
    const dock = buildDock("cricket.ball", t, payload)!;
    const chip4 = dock.chips.find((c) => c.id === "batRun4")!;
    expect(chip4.mutate(payload)).toEqual({ runs: { bat: 4, extras: { kind: "noball", runs: 1 } }, boundary: 4 });
    const chip6 = dock.chips.find((c) => c.id === "batRun6")!;
    expect(chip6.mutate(payload)).toEqual({ runs: { bat: 6, extras: { kind: "noball", runs: 1 } }, boundary: 6 });
  });

  it("bye and leg bye docks offer extra-run chips 2/3/4 that raise the EXTRA's own runs, bat stays 0 — freeHit no longer among them", () => {
    for (const kind of ["bye", "legbye"] as const) {
      const payload = { runs: { bat: 0, extras: { kind, runs: 1 } } };
      const dock = buildDock("cricket.ball", t, payload)!;
      expect(dock.chips.map((c) => c.id)).toEqual(["extraRun2", "extraRun3", "extraRun4"]);
      const chip = dock.chips.find((c) => c.id === "extraRun3")!;
      expect(chip.mutate(payload)).toEqual({ runs: { bat: 0, extras: { kind, runs: 3 } } });
    }
  });

  it("a wide's dock offers NO bat-run chips — the engine refuses bat runs off a wide (cricket.ts:1229) — and no freeHit chip either", () => {
    const payload = { runs: { bat: 0, extras: { kind: "wide", runs: 1 } } };
    const dock = buildDock("cricket.ball", t, payload)!;
    expect(dock.chips.map((c) => c.id)).toEqual([]);
  });

  it("a penalty's dock has no chips — only the TILE default changed (5); freeHit is gone here too", () => {
    const payload = { runs: { bat: 0, extras: { kind: "penalty", runs: 5 } } };
    const dock = buildDock("cricket.ball", t, payload)!;
    expect(dock.chips.map((c) => c.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildContext
// ---------------------------------------------------------------------------

describe("buildContext", () => {
  it("is null before the match goes live", () => {
    expect(buildContext(view({ state: state({ phase: "pre", innings: [] }) }))).toBeNull();
  });
  it("is null with no innings open yet", () => {
    expect(buildContext(view({ state: state({ innings: [] }) }))).toBeNull();
  });
  it("three required slots, personId from the fold", () => {
    const spec = buildContext(view())!;
    expect(spec.slots.map((s) => s.id)).toEqual(["striker", "nonStriker", "bowler"]);
    expect(spec.slots.every((s) => s.required)).toBe(true);
    expect(spec.slots.find((s) => s.id === "striker")!.personId).toBe("h1");
  });
  it("stays available during a super over", () => {
    expect(buildContext(view({ state: state({ phase: "super_over" }) }))).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// G5 (controller ruling 2026-08-16) — the context strip was INERT: cricket
// has no event to persist a striker/bowler pick, so the HOST holds a pending
// per-slot override (PadHostView.contextOverrides) and every resolvePeople()
// call site reads `override ?? fold value`. Proves BOTH halves of the
// acceptance criteria: (a) the strip (buildContext) shows the override, (b)
// the NEXT ball's payload (buildTiles) carries it too — the same
// resolvePeople() call backs both, so they can never disagree.
// ---------------------------------------------------------------------------

describe("G5 — context overrides supersede the fold", () => {
  it("buildContext shows the override, not the fold's own striker", () => {
    const v = view({ contextOverrides: { striker: "h3" } });
    const spec = buildContext(v)!;
    expect(spec.slots.find((s) => s.id === "striker")!.personId).toBe("h3");
  });

  it("the next ball's payload carries the override too — the strip and the tap can never disagree", () => {
    const v = view({ contextOverrides: { striker: "h3", bowler: "a2" } });
    const tiles = buildTiles(v);
    const run1 = tiles.find((tl) => tl.id === "run1")!;
    expect(run1.action).toMatchObject({ event: { payload: { striker: "h3", bowler: "a2", nonStriker: "h2" } } });
  });

  it("an unset slot's override leaves that slot on the fold's own value — overrides are per-slot, not all-or-nothing", () => {
    const v = view({ contextOverrides: { bowler: "a3" } });
    const spec = buildContext(v)!;
    expect(spec.slots.find((s) => s.id === "striker")!.personId).toBe("h1"); // fold, unchanged
    expect(spec.slots.find((s) => s.id === "bowler")!.personId).toBe("a3"); // overridden
  });

  it("mutation proof: a resolvePeople that ignored contextOverrides entirely would disagree with the real one here", () => {
    const withOverride = resolvePeople(state(), { striker: "h3" });
    const withoutOverride = resolvePeople(state());
    expect(withOverride.striker).not.toBe(withoutOverride.striker);
    expect(withOverride.striker).toBe("h3");
  });
});

// ---------------------------------------------------------------------------
// Blocker 2 (R2 review finding) — striker/non-striker are NOT genuine edits:
// the engine's strictOrder fold (cricket.ts:1183-1200) refuses any submitted
// ball whose striker/nonStriker disagrees with its OWN derived pair on the
// live submit path (isStrictFold defaults true — only reconciliation/replay
// ever passes strict:false). Only bowler is a real edit, and only at an over
// boundary. buildContext must mark the two fake slots readOnly so the strip
// stops pretending they can be reassigned.
// ---------------------------------------------------------------------------

describe("buildContext — striker/non-striker are read-only (blocker 2)", () => {
  it("marks striker readOnly", () => {
    expect(buildContext(view())!.slots.find((s) => s.id === "striker")!.readOnly).toBe(true);
  });

  it("marks nonStriker readOnly", () => {
    expect(buildContext(view())!.slots.find((s) => s.id === "nonStriker")!.readOnly).toBe(true);
  });

  it("all three slots stay required — readOnly is orthogonal to required, informational vs editable", () => {
    expect(buildContext(view())!.slots.every((s) => s.required)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Defect 3 (R2 review finding, docs/superpowers/plans/2026-08-16-scorepad-
// v3-r2-cricket.md): blocker 2 above made striker/non-striker readOnly but
// left bowler unconditionally tappable. Bowler IS a genuine edit — but ONLY
// at an over boundary (cricket.ts:1152-1172, `fine.currentBowler === null`
// accepts any eligible bowler with no fold-match check). Mid-over, the SAME
// strict fold refuses any other pick (cricket.ts:1173-1178, "over in
// progress belongs to X") — identical shape to the striker/non-striker
// refusal blocker 2 already closed. `view()`'s default fixture
// (`innings()`'s `fine.currentBowler: "a1"`) is itself mid-over, which is
// why the pre-fix suite's "leaves bowler editable" assertion above was
// itself wrong (asserted `undefined` — i.e. editable — against a mid-over
// fixture where the fold would refuse a different pick) and has been
// replaced by the two states below.
// ---------------------------------------------------------------------------

describe("buildContext — bowler read-only tracks the fold's own over boundary (defect 3)", () => {
  it("mid-over (fine.currentBowler already set): the fold refuses any other pick — readOnly", () => {
    const v = view({ state: state({ innings: [innings({ fine: { striker: "h1", nonStriker: "h2", currentBowler: "a1" } })] }) });
    expect(buildContext(v)!.slots.find((s) => s.id === "bowler")!.readOnly).toBe(true);
  });

  it("over boundary (fine.currentBowler is null): the fold accepts any eligible bowler — editable, not read-only", () => {
    const v = view({ state: state({ innings: [innings({ fine: { striker: "h1", nonStriker: "h2", currentBowler: null } })] }) });
    expect(buildContext(v)!.slots.find((s) => s.id === "bowler")!.readOnly).toBeUndefined();
  });

  it("a coarse-fidelity innings (fine entirely absent) defaults to read-only — no ball event is even accepted at that fidelity (cricket.ts:1130), so there is nothing to prove a boundary from", () => {
    const v = view({ state: state({ innings: [innings({ fine: null })] }) });
    expect(buildContext(v)!.slots.find((s) => s.id === "bowler")!.readOnly).toBe(true);
  });

  it("striker/nonStriker stay readOnly regardless of the bowler boundary state — the two concerns are independent", () => {
    const v = view({ state: state({ innings: [innings({ fine: { striker: "h1", nonStriker: "h2", currentBowler: null } })] }) });
    const spec = buildContext(v)!;
    expect(spec.slots.find((s) => s.id === "striker")!.readOnly).toBe(true);
    expect(spec.slots.find((s) => s.id === "nonStriker")!.readOnly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Live bug fix (owner-reported, reproduced against real data, 2026-08-17):
// on a T20 fixture with 10 overs bowled, the owner could not start over 11 —
// the pad showed "That entry isn't valid for this match." Root cause:
// `resolvePeople`'s bowler default read `bowlingOrder[0]` at an over
// boundary with NO eligibility check, so when bowlingOrder[0] had just
// bowled the previous over and/or exhausted his quota, the engine refused
// the submission on up to two independent grounds (cricket.ts:1160-1171,
// `applyDelivery`'s "consecutive overs"/"exhausted quota" checks — the third
// ground, "not in the fielding lineup" (cricket.ts:1163), can never fire
// here since every candidate below is drawn FROM bowlingOrder itself).
//
// Fixed by mirroring the engine's own eligibility filter (its private
// `eligibleBowlers`, cricket.ts:1784-1795, used internally by the random
// generator — not exported, so mirrored rather than imported, matching
// packages/engine being read-only from this file) directly inside
// `resolvePeople`. One default computed in one place means scorebug's shown
// name, the context chip's personId, AND the submitted payload can never
// disagree — the same reasoning G5's own header already gives for why
// `resolvePeople` is the single source every consumer reads.
// ---------------------------------------------------------------------------

describe("resolvePeople / buildTiles / buildContext — bowler default is ELIGIBLE at an over boundary (R2b live bug fix)", () => {
  it("skips bowlingOrder[0] when he bowled the PREVIOUS over — proposes the first eligible name instead", () => {
    const s = state({
      innings: [innings({ fine: { striker: "h1", nonStriker: "h2", currentBowler: null, prevOverBowler: "a1", bowlerBalls: {} } })],
    });
    expect(resolvePeople(s).bowler).toBe("a2");
  });

  it("skips bowlingOrder[0] when he has already bowled cfg.maxOversPerBowler overs — proposes the first eligible name instead", () => {
    // t20: maxOversPerBowler 4, ballsPerOver 6 (cfg()'s own default) -> 24
    // balls is exactly 4 overs bowled, at quota (cricket.ts:1167-1169's own
    // floor(bowlerBalls/bpo) >= max arithmetic, mirrored here).
    const s = state({
      innings: [innings({ fine: { striker: "h1", nonStriker: "h2", currentBowler: null, prevOverBowler: null, bowlerBalls: { a1: 24 } } })],
    });
    const p = resolvePeople(s, {}, cfg({ maxOversPerBowler: 4 }));
    expect(p.bowler).toBe("a2");
  });

  it("computes overs bowled against the REAL cfg.ballsPerOver, not a hardcoded 6 — the Hundred's 5-ball over changes who is at quota", () => {
    // 20 balls / 5-ball over = exactly 4 overs bowled -> exhausted at a
    // 4-over quota. A hardcoded 6 would compute floor(20/6)=3 < 4 and
    // wrongly call bowlingOrder[0] still eligible.
    const s = state({
      innings: [innings({ fine: { striker: "h1", nonStriker: "h2", currentBowler: null, prevOverBowler: null, bowlerBalls: { a1: 20 } } })],
    });
    const p = resolvePeople(s, {}, cfg({ ballsPerOver: 5, maxOversPerBowler: 4 }));
    expect(p.bowler).toBe("a2");
  });

  it("mid-over (currentBowler already set) is UNCHANGED by this fix — the fold refuses a mid-over swap regardless of eligibility data", () => {
    // a1 is simultaneously this-over's bowler, the PREVIOUS over's bowler,
    // AND wildly over quota — proves the currentBowler branch short-circuits
    // before eligibility is ever consulted, exactly like the brief requires.
    const s = state({
      innings: [innings({ fine: { striker: "h1", nonStriker: "h2", currentBowler: "a1", prevOverBowler: "a1", bowlerBalls: { a1: 999 } } })],
    });
    const p = resolvePeople(s, {}, cfg({ maxOversPerBowler: 4 }));
    expect(p.bowler).toBe("a1");
  });

  it("empty string, never an illegal name, when literally nobody in the bowling order is eligible", () => {
    const s = state({
      orders: { home: ["h1", "h2", "h3"], away: ["a1", "a2"] },
      innings: [innings({ fine: { striker: "h1", nonStriker: "h2", currentBowler: null, prevOverBowler: null, bowlerBalls: { a1: 24, a2: 24 } } })],
    });
    const p = resolvePeople(s, {}, cfg({ maxOversPerBowler: 4 }));
    expect(p.bowler).toBe("");
  });

  it("a manual context-strip override still wins outright — this fix does not second-guess the scorer's own explicit pick", () => {
    const s = state({
      innings: [innings({ fine: { striker: "h1", nonStriker: "h2", currentBowler: null, prevOverBowler: "a1", bowlerBalls: {} } })],
    });
    const p = resolvePeople(s, { bowler: "a1" }, cfg());
    expect(p.bowler).toBe("a1");
  });

  it("the SUBMITTED ball payload (buildTiles) carries the eligible default too — the strip and the tap can never disagree", () => {
    const v = view({
      state: state({ innings: [innings({ fine: { striker: "h1", nonStriker: "h2", currentBowler: null, prevOverBowler: "a1", bowlerBalls: {} } })] }),
    });
    const run1 = buildTiles(v).find((tl) => tl.id === "run1")!;
    expect(run1.action).toMatchObject({ event: { payload: { bowler: "a2" } } });
  });

  it("the context chip's shown personId is the eligible default too, never the illegal bowlingOrder[0]", () => {
    const v = view({
      state: state({ innings: [innings({ fine: { striker: "h1", nonStriker: "h2", currentBowler: null, prevOverBowler: "a1", bowlerBalls: {} } })] }),
    });
    const spec = buildContext(v)!;
    expect(spec.slots.find((s) => s.id === "bowler")!.personId).toBe("a2");
  });

  // R2b-cricket-over follow-up (test-naming pass, 2026-08-17): a test
  // named "mutation proof: a version blind to prevOverBowler (quota-only)
  // would disagree with the real one here" previously lived here. It did
  // not mutate anything — its "mutant" was a standalone `() => "a1"`
  // literal that ignored its argument entirely, never a broken variant of
  // resolvePeople — so its only real claim was `resolvePeople(s).bowler
  // !== "a1"` against this exact fixture. The "skips bowlingOrder[0] when
  // he bowled the PREVIOUS over" test at the top of this block already
  // proves that more strongly, against the identical fixture (`.toBe("a2")`
  // implies `.not.toBe("a1")` outright). Removed as a near-duplicate rather
  // than kept under a corrected name, per review.
});

// ---------------------------------------------------------------------------
// bowlerBlockReason / buildTiles / buildContext — R2b live bug PART 2
// (owner-reported, 2026-08-17): the fix above stops resolvePeople's own
// DEFAULT from proposing an ineligible bowler, but a scorer who MANUALLY
// overrides the bowler chip at an over boundary (context-strip's own
// candidate-list gap — the picker offers no eligibility narrowing at all,
// see buildContext's own CANDIDATE-LIST GAP note below) could still tap a
// run/wicket tile with an ineligible bowler resolved. The client's
// optimistic fold is deliberately NON-STRICT and never refuses it — the tap
// looks recorded, then the server refuses it moments later as a generic
// rejection with the exact cause lost (every bowler violation shares one
// engine code, INVALID_EVENT). These tests prove the TAP itself is now
// blocked at the tile-building path, never the fold.
// ---------------------------------------------------------------------------

describe("bowlerBlockReason", () => {
  it("mid-over (currentBowler already set): never blocked, regardless of eligibility data", () => {
    const s = state({
      innings: [innings({ fine: { striker: "h1", nonStriker: "h2", currentBowler: "a1", prevOverBowler: "a1", bowlerBalls: { a1: 999 } } })],
    });
    const cfgWithQuota = cfg({ maxOversPerBowler: 4 });
    const people = resolvePeople(s, {}, cfgWithQuota);
    expect(bowlerBlockReason(s, people, cfgWithQuota)).toBeNull();
  });

  it("the auto-picked eligible default at an over boundary: never blocked", () => {
    const s = state({
      innings: [innings({ fine: { striker: "h1", nonStriker: "h2", currentBowler: null, prevOverBowler: "a1", bowlerBalls: {} } })],
    });
    const people = resolvePeople(s); // auto-picks a2, already filtered eligible
    expect(bowlerBlockReason(s, people, cfg())).toBeNull();
  });

  it("a manual override naming the PREVIOUS over's bowler: blocked, reason prevOver", () => {
    const s = state({
      innings: [innings({ fine: { striker: "h1", nonStriker: "h2", currentBowler: null, prevOverBowler: "a1", bowlerBalls: {} } })],
    });
    const people = resolvePeople(s, { bowler: "a1" });
    expect(bowlerBlockReason(s, people, cfg())).toBe("prevOver");
  });

  it("a manual override at quota: blocked, reason quota", () => {
    const s = state({
      innings: [innings({ fine: { striker: "h1", nonStriker: "h2", currentBowler: null, prevOverBowler: null, bowlerBalls: { a1: 24 } } })],
    });
    const cfgWithQuota = cfg({ maxOversPerBowler: 4 });
    const people = resolvePeople(s, { bowler: "a1" }, cfgWithQuota);
    expect(bowlerBlockReason(s, people, cfgWithQuota)).toBe("quota");
  });

  it("maxOversPerBowler ABSENT: no quota block even against a heavily-bowled override — absent means unrestricted, never zero", () => {
    const s = state({
      innings: [innings({ fine: { striker: "h1", nonStriker: "h2", currentBowler: null, prevOverBowler: null, bowlerBalls: { a1: 999 } } })],
    });
    const people = resolvePeople(s, { bowler: "a1" }, cfg()); // cfg() carries no maxOversPerBowler
    expect(bowlerBlockReason(s, people, cfg())).toBeNull();
  });

  it("a manual override naming someone from the BATTING side (not in the fielding lineup at all): blocked, reason notInLineup", () => {
    const s = state({
      innings: [innings({ fine: { striker: "h1", nonStriker: "h2", currentBowler: null, prevOverBowler: null, bowlerBalls: {} } })],
    });
    const people = resolvePeople(s, { bowler: "h1" }); // h1 bats for home; away is fielding
    expect(bowlerBlockReason(s, people, cfg())).toBe("notInLineup");
  });

  it("no eligible bowler at all (everyone in a 2-strong bowling side is at quota): noEligible", () => {
    const s = state({
      orders: { home: ["h1", "h2", "h3"], away: ["a1", "a2"] },
      innings: [innings({ fine: { striker: "h1", nonStriker: "h2", currentBowler: null, prevOverBowler: null, bowlerBalls: { a1: 24, a2: 24 } } })],
    });
    const cfgWithQuota = cfg({ maxOversPerBowler: 4 });
    const people = resolvePeople(s, {}, cfgWithQuota);
    expect(bowlerBlockReason(s, people, cfgWithQuota)).toBe("noEligible");
  });
});

describe("buildTiles — bowler-block disables every ball-emitting tile (R2b live bug part 2)", () => {
  function boundaryWithPrevOverA1() {
    return state({
      innings: [innings({ fine: { striker: "h1", nonStriker: "h2", currentBowler: null, prevOverBowler: "a1", bowlerBalls: {} } })],
    });
  }

  const BALL_TILE_IDS = [
    "run0", "run1", "run2", "run3", "run4", "run6",
    "wide", "wicket", "extra-noball", "extra-bye", "extra-legbye", "extra-penalty",
  ];

  it("an ineligible manual override disables every ball-emitting tile, but leaves them in place", () => {
    const v = view({ state: boundaryWithPrevOverA1(), contextOverrides: { bowler: "a1" } });
    const tiles = buildTiles(v);
    for (const id of BALL_TILE_IDS) {
      const tile = tiles.find((tl) => tl.id === id)!;
      expect(tile).toBeDefined(); // still visible — not removed
      expect(tile.disabled).toBe(true);
    }
  });

  it("non-ball tiles (review/inningsClose/more) stay tappable even while bowler-blocked", () => {
    const v = view({ state: boundaryWithPrevOverA1(), contextOverrides: { bowler: "a1" } });
    const tiles = buildTiles(v);
    for (const id of ["review", "inningsClose", "more"]) {
      expect(tiles.find((tl) => tl.id === id)!.disabled).toBeUndefined();
    }
  });

  it("an eligible bowler (no override, the auto-picked default): no tile is disabled", () => {
    const tiles = buildTiles(view({ state: boundaryWithPrevOverA1() }));
    expect(tiles.some((tl) => tl.disabled)).toBe(false);
  });

  it("mid-over (currentBowler already set) is unaffected, even against an ineligible-on-paper currentBowler", () => {
    const v = view({
      state: state({ innings: [innings({ fine: { striker: "h1", nonStriker: "h2", currentBowler: "a1", prevOverBowler: "a1", bowlerBalls: { a1: 999 } } })] }),
    });
    expect(buildTiles(v).some((tl) => tl.disabled)).toBe(false);
  });

  it("the dead-end case (no eligible bowler at all) also disables every ball tile", () => {
    const v = view({
      state: state({
        orders: { home: ["h1", "h2", "h3"], away: ["a1", "a2"] },
        innings: [innings({ fine: { striker: "h1", nonStriker: "h2", currentBowler: null, prevOverBowler: null, bowlerBalls: { a1: 24, a2: 24 } } })],
      }),
      cfg: cfg({ maxOversPerBowler: 4 }),
    });
    const tiles = buildTiles(v);
    for (const id of BALL_TILE_IDS) {
      expect(tiles.find((tl) => tl.id === id)!.disabled).toBe(true);
    }
  });
});

describe("buildContext — bowler-block message, distinguishable per engine condition (R2b live bug part 2)", () => {
  it("consecutive-over: names the bowler, no quota number involved", () => {
    const v = view({
      state: state({ innings: [innings({ fine: { striker: "h1", nonStriker: "h2", currentBowler: null, prevOverBowler: "a1", bowlerBalls: {} } })] }),
      contextOverrides: { bowler: "a1" },
    });
    const bowlerSlot = buildContext(v, t)!.slots.find((s) => s.id === "bowler")!;
    expect(bowlerSlot.message).toBe(t("pad.cricket.context.bowler.blocked.prevOver", { name: "Away One" }));
  });

  it("quota: message carries the REAL cfg quota, not a hardcoded number — proved against the Hundred's ballsPerOver 5", () => {
    const v = view({
      cfg: cfg({ ballsPerOver: 5, maxOversPerBowler: 4 }),
      // 20 balls / 5-ball over = exactly 4 overs bowled -> at a 4-over quota.
      // A hardcoded 6 would compute floor(20/6)=3 < 4 and wrongly call this eligible.
      state: state({ innings: [innings({ fine: { striker: "h1", nonStriker: "h2", currentBowler: null, prevOverBowler: null, bowlerBalls: { a1: 20 } } })] }),
      contextOverrides: { bowler: "a1" },
    });
    const bowlerSlot = buildContext(v, t)!.slots.find((s) => s.id === "bowler")!;
    expect(bowlerSlot.message).toBe(t("pad.cricket.context.bowler.blocked.quota", { name: "Away One", quota: 4 }));
  });

  it("not in the fielding lineup: names the batting-side player picked by mistake", () => {
    const v = view({
      state: state({ innings: [innings({ fine: { striker: "h1", nonStriker: "h2", currentBowler: null, prevOverBowler: null, bowlerBalls: {} } })] }),
      contextOverrides: { bowler: "h1" },
    });
    const bowlerSlot = buildContext(v, t)!.slots.find((s) => s.id === "bowler")!;
    expect(bowlerSlot.message).toBe(t("pad.cricket.context.bowler.blocked.notInLineup", { name: "Home One" }));
  });

  it("no eligible bowler at all: a distinct, unattributed message — nobody is named because nobody is at fault", () => {
    const v = view({
      state: state({
        orders: { home: ["h1", "h2", "h3"], away: ["a1", "a2"] },
        innings: [innings({ fine: { striker: "h1", nonStriker: "h2", currentBowler: null, prevOverBowler: null, bowlerBalls: { a1: 24, a2: 24 } } })],
      }),
      cfg: cfg({ maxOversPerBowler: 4 }),
    });
    const bowlerSlot = buildContext(v, t)!.slots.find((s) => s.id === "bowler")!;
    expect(bowlerSlot.message).toBe(t("pad.cricket.context.bowler.blocked.noEligible"));
  });

  it("maxOversPerBowler ABSENT: no message even against a heavily-bowled override", () => {
    const v = view({
      state: state({ innings: [innings({ fine: { striker: "h1", nonStriker: "h2", currentBowler: null, prevOverBowler: null, bowlerBalls: { a1: 999 } } })] }),
      contextOverrides: { bowler: "a1" },
    });
    expect(buildContext(v, t)!.slots.find((s) => s.id === "bowler")!.message).toBeUndefined();
  });

  it("an eligible bowler: no message", () => {
    const v = view({
      state: state({ innings: [innings({ fine: { striker: "h1", nonStriker: "h2", currentBowler: null, prevOverBowler: "a1", bowlerBalls: {} } })] }),
    });
    expect(buildContext(v, t)!.slots.find((s) => s.id === "bowler")!.message).toBeUndefined();
  });

  it("mid-over: no message", () => {
    expect(buildContext(view(), t)!.slots.find((s) => s.id === "bowler")!.message).toBeUndefined();
  });

  it("with no explicit t (default), a blocked message still resolves via the echo-key default rather than crashing — proves existing 1-arg buildContext(view()) call sites elsewhere in this file keep compiling and running", () => {
    const v = view({
      state: state({ innings: [innings({ fine: { striker: "h1", nonStriker: "h2", currentBowler: null, prevOverBowler: "a1", bowlerBalls: {} } })] }),
      contextOverrides: { bowler: "a1" },
    });
    expect(() => buildContext(v)).not.toThrow();
    expect(buildContext(v)!.slots.find((s) => s.id === "bowler")!.message).toBe("pad.cricket.context.bowler.blocked.prevOver");
  });
});

// ---------------------------------------------------------------------------
// buildTiles / buildContext — innings closed (R2b live-tile audit defect 2,
// `_INDEX.md`, HIGH): `currentInnings()` falls back to the JUST-CLOSED
// innings once none is open — load-bearing for `buildScorebug`'s own READ
// path (proved again below, unchanged) — but `buildTiles`/`buildContext`
// never checked `.closed`, so every delivery-capable tile stayed tappable
// and every tap 422d with "over/ballInOver do not match the ledger", which
// names ball sequencing, never the real cause. Reuses the bowler-eligibility
// block's own mechanism verbatim (`TileSpec.disabled` + `ContextSlot.
// message`) rather than a second one — see `closedTile`'s own doc comment,
// cricket.tsx.
// ---------------------------------------------------------------------------

describe("buildTiles — innings closed disables the delivery-capable surface (R2b defect 2)", () => {
  const BALL_TILE_IDS = [
    "run0", "run1", "run2", "run3", "run4", "run6",
    "wide", "wicket", "extra-noball", "extra-bye", "extra-legbye", "extra-penalty",
  ];

  // R2b-next (2026-08-17): these fixtures now carry TWO closed innings —
  // under the default single-innings-per-side cfg (`cfg()`'s own
  // `inningsPerSide: 1`, so `maxInningsCount` is 2), ONE closed innings
  // means a second is still DUE, which is exactly the state the R2b-next fix
  // below now RE-ENABLES the delivery-capable surface for. A genuinely
  // terminal fixture — nothing further due — needs both match innings
  // recorded closed, matching `currentInnings`'s own "falls back to the last
  // innings once every innings is closed" fixture shape (above).
  it("a fine-fidelity closed innings disables every ball tile, wicket, review, and inningsClose — still visible, not removed", () => {
    const tiles = buildTiles(view({ state: state({ innings: [innings({ closed: true }), innings({ closed: true })] }) }));
    for (const id of [...BALL_TILE_IDS, "review", "inningsClose"]) {
      const tile = tiles.find((tl) => tl.id === id)!;
      expect(tile).toBeDefined();
      expect(tile.disabled).toBe(true);
    }
  });

  it("declare is disabled too, for a two-innings cfg — regardless of due-ness (declare never targets a not-yet-created innings)", () => {
    const tiles = buildTiles(view({
      state: state({ innings: [innings({ closed: true })] }), // a 2nd innings IS due under this cfg — declare stays disabled anyway
      cfg: cfg({ inningsPerSide: 2 }),
    }));
    expect(tiles.find((tl) => tl.id === "declare")!.disabled).toBe(true);
  });

  it("a coarse-fidelity closed innings disables overSummary instead, once nothing further is due — the ball tiles are already hidden by fidelity, not by this fix", () => {
    const tiles = buildTiles(view({ state: state({ innings: [innings({ closed: true }), innings({ closed: true, fine: null })] }) }));
    expect(tiles.some((tl) => tl.id === "run0")).toBe(false);
    expect(tiles.find((tl) => tl.id === "overSummary")!.disabled).toBe(true);
  });

  it("More stays tappable — genuine between-innings actions (revise, follow-on, match close) are reachable only through it", () => {
    const tiles = buildTiles(view({ state: state({ innings: [innings({ closed: true }), innings({ closed: true })] }) }));
    expect(tiles.find((tl) => tl.id === "more")!.disabled).toBeUndefined();
  });

  it("blocks when nothing further is due even under a two-innings cfg (all 4 match innings recorded closed)", () => {
    const tiles = buildTiles(view({
      state: state({
        innings: [
          innings({ closed: true }), innings({ closed: true }),
          innings({ closed: true }), innings({ closed: true }),
        ],
      }),
      cfg: cfg({ inningsPerSide: 2 }),
    }));
    for (const id of BALL_TILE_IDS) {
      expect(tiles.find((tl) => tl.id === id)!.disabled).toBe(true);
    }
  });

  it("an OPEN innings is unaffected — no tile is disabled (mutation-check control: a fix that disabled everything unconditionally would also pass every test above)", () => {
    const tiles = buildTiles(view());
    expect(tiles.some((tl) => tl.disabled)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildTiles / buildContext / basePayload — closed innings, ANOTHER due
// (R2b-next, owner-confirmed live blocker, 2026-08-17): after the fix above
// shipped, the owner could still not start scoring innings 2 from this pad —
// `currentInnings()` falls back to the just-closed innings, so `basePayload`
// built a payload for it (e.g. over 20.0, the wrong side batting) and R2b's
// own closure gate then disabled the tiles outright, so NEITHER the stale
// payload NOR the disabled tiles let anyone score the next innings. Opening
// an innings is IMPLICIT in the fold (`createInnings`, cricket.ts:2935-2944/
// :1401-1413, the same mechanism that opens innings ONE on its own first
// delivery) — there is no dedicated "start innings" event, and this fix does
// not invent one. `dueBattingSide` (cricket.tsx) is the engine's own
// `nextBattingSide` (cricket.ts), so this is provably the same rule, not a
// forked copy.
// ---------------------------------------------------------------------------

describe("dueBattingSide", () => {
  it("null with no innings recorded yet", () => {
    expect(dueBattingSide({}, cfg())).toBeNull();
  });

  it("null while the current innings is still open", () => {
    expect(dueBattingSide(state(), cfg())).toBeNull();
  });

  it("null once every match innings is closed (terminal — single-innings cfg)", () => {
    const s = state({ innings: [innings({ closed: true }), innings({ closed: true })] });
    expect(dueBattingSide(s, cfg())).toBeNull();
  });

  it("the OTHER side once the first (of two match) innings is closed", () => {
    const s = state({ battingFirst: "home", innings: [innings({ closed: true, battingSide: "home" })] });
    expect(dueBattingSide(s, cfg())).toBe("away");
  });

  it("reads battingFirst, not a hardcoded home — an away-first match still returns the OTHER side (home)", () => {
    const s = state({ battingFirst: "away", innings: [innings({ closed: true, battingSide: "away" })] });
    expect(dueBattingSide(s, cfg())).toBe("home");
  });

  it("honours the F,S,S,F follow-on order — diverges from plain alternation, a two-innings-per-side cfg with 2 innings recorded", () => {
    const twoInnings = cfg({ inningsPerSide: 2 });
    const twoClosed = { innings: [innings({ closed: true }), innings({ closed: true })] };
    // Plain alternation would say "home" (the 3rd innings, index 2, is even)
    // for BOTH of these — only follow-on's F,S,S,F pattern tells them apart.
    expect(dueBattingSide(state({ battingFirst: "home", followOnEnforced: false, ...twoClosed }), twoInnings)).toBe("home");
    expect(dueBattingSide(state({ battingFirst: "home", followOnEnforced: true, ...twoClosed }), twoInnings)).toBe("away");
  });
});

describe("buildContext — innings closed names the real cause (R2b defect 2)", () => {
  // R2b-next (2026-08-17): both fixtures below now carry TWO closed innings
  // — same reason as `buildTiles`'s own defect-2 block above: under the
  // default single-innings-per-side cfg, ONE closed innings leaves a second
  // one DUE, and `buildContext` now returns `null` for that state (see the
  // new describe block below) rather than a closure-message spec.
  it("all three slots carry the closure message and are read-only", () => {
    const v = view({ state: state({ innings: [innings({ closed: true }), innings({ closed: true })] }) });
    const spec = buildContext(v, t)!;
    for (const id of ["striker", "nonStriker", "bowler"]) {
      const slot = spec.slots.find((s) => s.id === id)!;
      expect(slot.message).toBe(t("pad.cricket.context.innings.closed"));
      expect(slot.readOnly).toBe(true);
    }
  });

  it("closure wins over a bowler-eligibility message when both could apply off the same stale fold data", () => {
    const v = view({
      state: state({
        innings: [
          innings({ closed: true }),
          innings({
            closed: true,
            fine: { striker: "h1", nonStriker: "h2", currentBowler: null, prevOverBowler: "a1", bowlerBalls: {} },
          }),
        ],
      }),
      contextOverrides: { bowler: "a1" }, // would read "prevOver" if eligibility were still checked — see next test
    });
    const bowlerSlot = buildContext(v, t)!.slots.find((s) => s.id === "bowler")!;
    expect(bowlerSlot.message).toBe(t("pad.cricket.context.innings.closed"));
  });

  it("counterfactual: the SAME fixture without closed:true really would read prevOver — proves the above is a genuine override, not a vacuous check", () => {
    const v = view({
      state: state({
        innings: [innings({
          fine: { striker: "h1", nonStriker: "h2", currentBowler: null, prevOverBowler: "a1", bowlerBalls: {} },
        })],
      }),
      contextOverrides: { bowler: "a1" },
    });
    const bowlerSlot = buildContext(v, t)!.slots.find((s) => s.id === "bowler")!;
    expect(bowlerSlot.message).toBe(t("pad.cricket.context.bowler.blocked.prevOver", { name: "Away One" }));
  });

  it("an open innings carries no closure message on any slot", () => {
    const spec = buildContext(view(), t)!;
    for (const id of ["striker", "nonStriker", "bowler"]) {
      expect(spec.slots.find((s) => s.id === id)!.message).toBeUndefined();
    }
  });
});

describe("buildTiles / buildContext / basePayload — closed innings, ANOTHER due (R2b-next)", () => {
  // battingFirst "home" batted innings 0 (now closed) -> innings 1 is due,
  // "away" bats it. orders (state()'s own default) give the new sides'
  // openers/first-fielder unambiguously: away h1/h2 swap to a1/a2, bowler
  // defaults to home's order[0] since a fresh innings has no fine at all.
  function closedFirstInningsDue(over: Record<string, unknown> = {}) {
    return state({
      battingFirst: "home",
      innings: [innings({ closed: true, battingSide: "home", runs: 187, wickets: 6, legalBalls: 118 })],
      ...over,
    });
  }

  it("re-enables every ball-emitting tile and the over-summary tile — the fold can open the next innings on either", () => {
    const tiles = buildTiles(view({ state: closedFirstInningsDue() }));
    const ballIds = [
      "run0", "run1", "run2", "run3", "run4", "run6",
      "wide", "wicket", "extra-noball", "extra-bye", "extra-legbye", "extra-penalty",
    ];
    for (const id of [...ballIds, "overSummary"]) {
      expect(tiles.find((tl) => tl.id === id)!.disabled).toBeUndefined();
    }
  });

  it("review, inningsClose and declare stay disabled — nothing is open yet to review/close/declare", () => {
    const tiles = buildTiles(view({ state: closedFirstInningsDue(), cfg: cfg({ inningsPerSide: 2 }) }));
    for (const id of ["review", "inningsClose", "declare"]) {
      expect(tiles.find((tl) => tl.id === id)!.disabled).toBe(true);
    }
  });

  it("basePayload targets the NEXT innings: first-delivery over/ball numbers, the OTHER side's openers, the OTHER side's bowler", () => {
    const tiles = buildTiles(view({ state: closedFirstInningsDue() }));
    const run1 = tiles.find((tl) => tl.id === "run1")!;
    expect(run1.action).toEqual({
      event: {
        type: "cricket.ball",
        payload: {
          over: 0, ballInOver: 1, // matches createInnings/applyDelivery's own first-delivery numbering
          striker: "a1", nonStriker: "a2", // away's order[0]/[1] — away is the OTHER side
          bowler: "h1", // home's order[0] — a fresh innings has no prevOverBowler/quota to exclude anyone
          runs: { bat: 1 },
        },
      },
    });
  });

  it("the over-summary tile's own labelText reads over 1 too, not a number derived from the closed innings' 118 legal balls", () => {
    const tiles = buildTiles(view({ state: closedFirstInningsDue() }), t);
    const over = tiles.find((tl) => tl.id === "overSummary")!;
    expect(over.labelText).toBe(t("pad.cricket.action.endOfOver", { over: 1 }));
  });

  it("buildContext returns null — same as before ANY innings exists (no fold-backed state to show/edit yet, matching how innings 1 shows no strip before its own first ball)", () => {
    expect(buildContext(view({ state: closedFirstInningsDue() }), t)).toBeNull();
  });

  it("the follow-on order is honoured, not plain alternation: 2 innings recorded + followOnEnforced -> the SAME side bats again", () => {
    const s = state({
      battingFirst: "home",
      followOnEnforced: true,
      innings: [innings({ closed: true, battingSide: "home" }), innings({ closed: true, battingSide: "away" })],
    });
    const tiles = buildTiles(view({ state: s, cfg: cfg({ inningsPerSide: 2 }) }));
    const run1 = tiles.find((tl) => tl.id === "run1")!;
    // Plain alternation would put "home" back in — follow-on keeps "away"
    // batting (striker/nonStriker still a1/a2, bowler still h1).
    expect(run1.action).toMatchObject({ event: { payload: { striker: "a1", nonStriker: "a2", bowler: "h1" } } });
  });

  it("the genuinely terminal case (nothing further due) is unaffected by this block — tiles stay disabled, buildContext still shows the closure message (regression pin against the tests above)", () => {
    const terminal = state({ innings: [innings({ closed: true }), innings({ closed: true })] });
    expect(buildTiles(view({ state: terminal })).find((tl) => tl.id === "run1")!.disabled).toBe(true);
    expect(buildContext(view({ state: terminal }), t)!.slots[0]!.message).toBe(t("pad.cricket.context.innings.closed"));
  });
});

describe("buildScorebug — closed innings with nothing else open still shows the final score (regression: the defect-2 tile/context gate must not touch the read path)", () => {
  it("shows the closed innings' final runs/wickets/overs, not a blank or zeroed line (this fixture is ALSO the 'another innings due' state — see the R2b-next test alongside it below)", () => {
    const spec = buildScorebug(
      view({ state: state({ innings: [innings({ closed: true, runs: 187, wickets: 6, legalBalls: 118 })] }) }),
      t,
    );
    expect(spec.halves[0]!.big).toBe("187/6");
    expect(spec.halves[1]!.big).toBe("19.4");
  });

  it("R2b-next: shows the SAME closed final score in the genuinely terminal state too — the read path must not care either way", () => {
    const spec = buildScorebug(
      view({
        state: state({
          innings: [
            innings({ closed: true, runs: 300, wickets: 4, legalBalls: 300 }),
            innings({ closed: true, runs: 187, wickets: 6, legalBalls: 118 }),
          ],
        }),
      }),
      t,
    );
    expect(spec.halves[0]!.big).toBe("187/6"); // currentInnings() falls back to the LAST (most recent) closed innings
    expect(spec.halves[1]!.big).toBe("19.4");
  });
});

// ---------------------------------------------------------------------------
// buildSheets — wicket sheet `when`-skip logic driven through the REAL
// guided-sheet.tsx step machine (mutation target #1).
// ---------------------------------------------------------------------------

describe("buildSheets — wicket flow (D-15)", () => {
  function wicketSpec() {
    return buildSheets(view()).wicket;
  }

  it("bowled skips BOTH who-out and fielder — straight from kind to a built event", () => {
    const spec = wicketSpec();
    const s = initialSheetState();
    expect(currentStep(spec, s)!.id).toBe("kind");
    const outcome = answerStep(spec, s, "bowled");
    expect(outcome.done).toBe(true);
    if (!outcome.done) throw new Error("expected done");
    expect(outcome.event.payload).toMatchObject({
      wicket: { kind: "bowled", out: "h1", bowlerCredited: true },
    });
    expect((outcome.event.payload as { wicket: { fielder?: string } }).wicket.fielder).toBeUndefined();
  });

  it("caught skips who-out (striker implied) but asks for fielder", () => {
    const spec = wicketSpec();
    const s = initialSheetState();
    const afterKind = answerStep(spec, s, "caught");
    expect(afterKind.done).toBe(false);
    if (afterKind.done) throw new Error("expected not done");
    expect(currentStep(spec, afterKind.state)!.id).toBe("fielder");
    const final = answerStep(spec, afterKind.state, "a2");
    expect(final.done).toBe(true);
    if (!final.done) throw new Error("expected done");
    expect(final.event.payload).toMatchObject({ wicket: { kind: "caught", out: "h1", fielder: "a2", bowlerCredited: true } });
  });

  it("runout asks BOTH who-out and fielder, in order", () => {
    const spec = wicketSpec();
    const s = initialSheetState();
    const afterKind = answerStep(spec, s, "runout");
    expect(afterKind.done).toBe(false);
    if (afterKind.done) throw new Error("expected not done");
    expect(currentStep(spec, afterKind.state)!.id).toBe("out");
    const afterOut = answerStep(spec, afterKind.state, "h2"); // non-striker run out
    expect(afterOut.done).toBe(false);
    if (afterOut.done) throw new Error("expected not done");
    expect(currentStep(spec, afterOut.state)!.id).toBe("fielder");
    const final = answerStep(spec, afterOut.state, "a3");
    expect(final.done).toBe(true);
    if (!final.done) throw new Error("expected done");
    expect(final.event.payload).toMatchObject({ wicket: { kind: "runout", out: "h2", fielder: "a3", bowlerCredited: false } });
  });

  it("stumped skips who-out but asks for fielder, and bowlerCredited is true", () => {
    const spec = wicketSpec();
    const afterKind = answerStep(spec, initialSheetState(), "stumped");
    if (afterKind.done) throw new Error("expected not done");
    const final = answerStep(spec, afterKind.state, "a1");
    if (!final.done) throw new Error("expected done");
    expect(final.event.payload).toMatchObject({ wicket: { kind: "stumped", out: "h1", fielder: "a1", bowlerCredited: true } });
  });

  it("back from fielder returns to kind for a non-runout dismissal — skips over the gated-off who-out step, never gets stuck on it", () => {
    const spec = wicketSpec();
    const afterKind = answerStep(spec, initialSheetState(), "caught");
    if (afterKind.done) throw new Error("expected not done");
    expect(currentStep(spec, afterKind.state)!.id).toBe("fielder");
    const backed = backStep(spec, afterKind.state);
    expect(currentStep(spec, backed)!.id).toBe("kind");
  });

  it("dispatches cricket.superover.ball while the engine is in a super over", () => {
    const spec = buildSheets(view({ state: state({ phase: "super_over" }) })).wicket;
    expect(spec.event).toBe("cricket.superover.ball");
  });

  it("every WICKET_KINDS member is offered as a kind option, each with a real label", () => {
    const spec = wicketSpec();
    const options = spec.steps[0]!.kind === "choice" ? spec.steps[0]!.options : [];
    expect(options.map((o) => o.id).sort()).toEqual([...WICKET_KINDS].sort());
    expect(options.every((o) => typeof o.label === "string" && o.label.length > 0)).toBe(true);
  });

  // G6 (controller ruling 2026-08-16): the "out" step declares exactly the
  // two batters at the crease as `candidates`, never the whole batting-side
  // on-field roster — SquadMember.onField is never cleared by a dismissal,
  // so `pool:"onfield"` alone would still list every already-out player.
  it("the 'out' step's candidates are exactly the two batters at the crease, not the whole on-field roster", () => {
    const spec = wicketSpec();
    const out = spec.steps.find((s) => s.id === "out")!;
    if (out.kind !== "person") throw new Error("expected a person step");
    expect(out.candidates).toEqual(["h1", "h2"]); // striker, non-striker — h3 (on-field but not batting) excluded
    expect(out.pool).toBe("onfield"); // kept as a fallback/doc value even though candidates supersedes it (G6, types.ts)
  });

  it("the 'out' step's candidates track a context override — reads the SAME resolvePeople(state, overrides) the payload does", () => {
    const spec = buildSheets(view({ contextOverrides: { striker: "h3" } })).wicket;
    const out = spec.steps.find((s) => s.id === "out")!;
    if (out.kind !== "person") throw new Error("expected a person step");
    expect(out.candidates).toEqual(["h3", "h2"]);
  });

  it("the 'fielder' step declares NO candidates override — still the whole fielding-side pool, unlike 'out'", () => {
    const spec = wicketSpec();
    const fielder = spec.steps.find((s) => s.id === "fielder")!;
    if (fielder.kind !== "person") throw new Error("expected a person step");
    expect(fielder.candidates).toBeUndefined();
    expect(fielder.pool).toBe("onfield");
  });
});

// ---------------------------------------------------------------------------
// buildSheets — wicket "kind" step gated by a pending free hit (R2b-over
// review finding: the fourth instance of "the pad must never offer what the
// engine will refuse", `docs/superpowers/specs/2026-08-15-scoringpad-v3-
// prompts/_INDEX.md`). The engine refuses every wicket kind except
// runout/obstructed while `fine.freeHitPending` is true
// (packages/engine/src/sports/cricket/cricket.ts:1275-1276) — before this,
// the "kind" step offered all ten regardless, and a scorer picking e.g.
// "bowled" on a free hit got a bare server rejection (the same generic-
// rejection experience this whole branch exists to remove).
//
// Driven by the SAME `freeHitPending` fold `buildScorebug`'s own indicator
// and `cricketBallDetail`'s own activity note already use (that function's
// own header, above) — reused here rather than a second derivation, which is
// what stops this gate from ever disagreeing with what the scorer is already
// shown on the scorebug strip. `FREE_HIT_WICKET_KINDS` (cricket.tsx, beside
// WICKET_KINDS/FIELDER_ELIGIBLE_KINDS/VARIABLE_OUT_KINDS) is the closed set.
// ---------------------------------------------------------------------------

describe("buildSheets — wicket kind gated by free hit (R2b-over)", () => {
  // Mirrors the exact fixture shape `describe("buildScorebug — free hit
  // indicator (R2b)")` (above) already uses for "a free hit is pending" —
  // one white-ball no-ball, nothing after it.
  const freeHitEvents = [
    ballEvent("e1", { over: 0, ballInOver: 5, runs: { bat: 0, extras: { kind: "noball", runs: 1 } } }),
  ];

  function kindStepOf(spec: GuidedSheetSpec) {
    const step = spec.steps[0]!;
    if (step.kind !== "choice") throw new Error("expected a choice step");
    return step;
  }

  it("free hit pending: the kind step offers EXACTLY runout and obstructed, nothing else, and carries a reason hint", () => {
    const spec = buildSheets(view({ events: freeHitEvents })).wicket;
    const kind = kindStepOf(spec);
    expect(kind.options.map((o) => o.id).sort()).toEqual(["obstructed", "runout"]);
    expect(kind.hintKey).toBe("pad.cricket.sheet.wicket.kind.freeHitHint");
  });

  it("no free hit pending: all ten kinds still offered and no hint — without this, the fix could over-restrict permanently and still pass", () => {
    const spec = buildSheets(view()).wicket; // view()'s default events: [] — nothing pending
    const kind = kindStepOf(spec);
    expect(kind.options.map((o) => o.id).sort()).toEqual([...WICKET_KINDS].sort());
    expect(kind.hintKey).toBeUndefined();
  });

  it("no-ball -> wide -> legal ball still counts as pending here too — a wide must not un-gate the kind step (same fold as the indicator, never a second, driftable rule)", () => {
    const events = [
      ...freeHitEvents,
      ballEvent("e2", { over: 0, ballInOver: 5, runs: { bat: 0, extras: { kind: "wide", runs: 1 } } }),
    ];
    const spec = buildSheets(view({ events })).wicket;
    expect(kindStepOf(spec).options.map((o) => o.id).sort()).toEqual(["obstructed", "runout"]);
  });

  it("buildPayload still emits a valid payload for both allowed kinds during a free hit", () => {
    const spec = buildSheets(view({ events: freeHitEvents })).wicket;

    const afterKind = answerStep(spec, initialSheetState(), "runout");
    if (afterKind.done) throw new Error("expected not done");
    expect(currentStep(spec, afterKind.state)!.id).toBe("out");
    const afterOut = answerStep(spec, afterKind.state, "h2"); // non-striker run out
    if (afterOut.done) throw new Error("expected not done");
    expect(currentStep(spec, afterOut.state)!.id).toBe("fielder");
    const runoutFinal = answerStep(spec, afterOut.state, "a3");
    if (!runoutFinal.done) throw new Error("expected done");
    expect(runoutFinal.event.payload).toMatchObject({
      wicket: { kind: "runout", out: "h2", fielder: "a3", bowlerCredited: false },
    });

    const obstructedFinal = answerStep(spec, initialSheetState(), "obstructed");
    if (!obstructedFinal.done) throw new Error("expected done"); // no `when`-gated step applies to obstructed
    expect(obstructedFinal.event.payload).toMatchObject({
      wicket: { kind: "obstructed", out: "h1", bowlerCredited: false },
    });
    expect((obstructedFinal.event.payload as { wicket: { fielder?: string } }).wicket.fielder).toBeUndefined();
  });
});

describe("buildSheets — toss/review/inningsClose", () => {
  it("toss: who won -> elected, both required, in that order", () => {
    const spec = buildSheets(view()).toss;
    expect(spec.event).toBe("cricket.toss");
    const s = initialSheetState();
    expect(currentStep(spec, s)!.id).toBe("wonBy");
    const afterWon = answerStep(spec, s, "home-1");
    if (afterWon.done) throw new Error("expected not done");
    expect(currentStep(spec, afterWon.state)!.id).toBe("elected");
    const done = answerStep(spec, afterWon.state, "bat");
    if (!done.done) throw new Error("expected done");
    expect(done.event).toEqual({ type: "cricket.toss", payload: { wonBy: "home-1", elected: "bat" } });
  });

  it("review: kind -> outcome -> by, never asks the two optional persons", () => {
    const spec = buildSheets(view()).review;
    const s = initialSheetState();
    const afterKind = answerStep(spec, s, "player");
    if (afterKind.done) throw new Error("expected not done");
    const afterOutcome = answerStep(spec, afterKind.state, "upheld");
    if (afterOutcome.done) throw new Error("expected not done");
    expect(currentStep(spec, afterOutcome.state)!.id).toBe("by");
    const done = answerStep(spec, afterOutcome.state, "away-1");
    if (!done.done) throw new Error("expected done");
    expect(done.event).toEqual({ type: "cricket.review", payload: { kind: "player", outcome: "upheld", by: "away-1" } });
  });

  it("inningsClose: one reason step, covering every CricketClose.reason member", () => {
    const spec = buildSheets(view()).inningsClose;
    const step = spec.steps[0]!;
    const options = step.kind === "choice" ? step.options.map((o) => o.id) : [];
    expect(options.sort()).toEqual(
      ["all_out", "forfeited", "other", "overs_complete", "target_reached", "time", "weather"].sort(),
    );
    const done = answerStep(spec, initialSheetState(), "weather");
    if (!done.done) throw new Error("expected done");
    expect(done.event).toEqual({ type: "cricket.innings.close", payload: { reason: "weather" } });
  });
});

// ---------------------------------------------------------------------------
// buildSheets — over summary (R2b): the pad's over-by-over entry point.
// ---------------------------------------------------------------------------

describe("buildSheets — over summary (R2b)", () => {
  function numberStep(spec: GuidedSheetSpec, id: string) {
    const step = spec.steps.find((s) => s.id === id)!;
    if (step.kind !== "number") throw new Error(`expected a number step for "${id}"`);
    return step;
  }
  function overSummaryView() {
    return view({ state: state({ innings: [innings({ fine: null, runs: 24, wickets: 1, legalBalls: 30 })] }) });
  }
  function overSpec() {
    return buildSheets(overSummaryView()).overSummary;
  }

  it("dispatches cricket.innings.summary", () => {
    expect(overSpec().event).toBe("cricket.innings.summary");
  });

  it("prefills 0/0/bpo for THIS OVER, never the fold's current total (Q2 reversed 2026-08-17)", () => {
    // fold is 24/1 off 30 balls — non-zero, so a 0 prefill here is actually
    // distinguishable from the old "prefill from the fold" behaviour; testing
    // this against an empty/zero fold would be vacuous.
    const spec = overSpec();
    expect(numberStep(spec, "runs").initial).toBe(0);
    expect(numberStep(spec, "wickets").initial).toBe(0);
    expect(numberStep(spec, "balls").initial).toBe(6); // bpo, not legalBalls + bpo
  });

  it("prefills 0/0/bpo when no innings is open yet", () => {
    const spec = buildSheets(view({ state: state({ innings: [] }) })).overSummary;
    expect(numberStep(spec, "runs").initial).toBe(0);
    expect(numberStep(spec, "wickets").initial).toBe(0);
    expect(numberStep(spec, "balls").initial).toBe(6);
  });

  it("uses ballsPerOverOf for balls' initial/max, never a hardcoded 6 — hundred variant", () => {
    const spec = buildSheets(
      view({ cfg: cfg({ ballsPerOver: 5 }), state: state({ innings: [innings({ fine: null, legalBalls: 30 })] }) }),
    ).overSummary;
    const balls = numberStep(spec, "balls");
    expect(balls.initial).toBe(5); // bpo(5), not the fold's legalBalls + bpo
    expect(balls.min).toBe(0);
    expect(balls.max).toBe(5); // a hardcoded 6 would fail this on the Hundred
  });

  it("runs/wickets carry no max; balls' max is bpo — a completed over is always exactly bpo legal deliveries", () => {
    const spec = overSpec();
    expect(numberStep(spec, "runs").max).toBeUndefined();
    expect(numberStep(spec, "wickets").max).toBeUndefined();
    expect(numberStep(spec, "balls").max).toBe(6); // bpo, default cfg
  });

  it("each step's min is 0 — the monotone guard is unreachable via buildPayload's additive sum onto the fold, not a min floor", () => {
    const spec = overSpec();
    expect(numberStep(spec, "runs").min).toBe(0);
    expect(numberStep(spec, "wickets").min).toBe(0);
    expect(numberStep(spec, "balls").min).toBe(0);
  });

  it("hint carries the fold's current score, locale-invariant (no t() needed) — the only place the scorer sees what the delta is added to", () => {
    const spec = overSpec();
    expect(numberStep(spec, "runs").hintText).toBe("24/1");
    expect(numberStep(spec, "wickets").hintText).toBe("24/1");
  });

  it("buildPayload sums the fold's current totals with this over's entered runs/wickets/balls — absolute, not the delta", () => {
    const payload = overSpec().buildPayload({ runs: "7", wickets: "1", balls: "6" });
    expect(payload).toEqual({ runs: 31, wickets: 2, legalBalls: 36, partial: true });
  });

  it("a 0-run, 0-wicket maiden over still appends the unchanged totals plus 6 balls — the append is not conditional on non-zero input", () => {
    const payload = overSpec().buildPayload({ runs: "0", wickets: "0", balls: "6" });
    expect(payload).toEqual({ runs: 24, wickets: 1, legalBalls: 36, partial: true });
  });

  it("driven end to end through the real wizard: runs -> wickets -> balls -> a cricket.innings.summary event", () => {
    const spec = overSpec();
    const s0 = initialSheetState();
    expect(currentStep(spec, s0)!.id).toBe("runs");
    const afterRuns = answerStep(spec, s0, "7");
    if (afterRuns.done) throw new Error("expected not done");
    expect(currentStep(spec, afterRuns.state)!.id).toBe("wickets");
    const afterWickets = answerStep(spec, afterRuns.state, "1");
    if (afterWickets.done) throw new Error("expected not done");
    expect(currentStep(spec, afterWickets.state)!.id).toBe("balls");
    const done = answerStep(spec, afterWickets.state, "6");
    if (!done.done) throw new Error("expected done");
    expect(done.event).toEqual({
      type: "cricket.innings.summary",
      payload: { runs: 31, wickets: 2, legalBalls: 36, partial: true },
    });
  });

  it("a sequence of partial summaries, each entered as THIS OVER's runs/wickets/balls, folds to the totals a scorer expects, never tripping the monotone guard", () => {
    // Over 1: innings unopened, scorer enters this over's 6 runs, 0 wickets, a
    // full over. Base is 0 here, so the absolute payload equals the delta.
    const spec1 = buildSheets(view({ state: state({ innings: [] }) })).overSummary;
    const payload1 = spec1.buildPayload({ runs: "6", wickets: "0", balls: "6" });
    expect(payload1).toEqual({ runs: 6, wickets: 0, legalBalls: 6, partial: true });

    // The engine's own monotone update (cricket.ts:1445-1451) would fold this
    // verbatim into the innings — hand-construct that next state, matching
    // this file's own fixture-composition convention (no real fold invoked;
    // packages/engine is out of this wave's file grant).
    const foldedAfterOver1 = innings({ fine: null, runs: 6, wickets: 0, legalBalls: 6 });
    const spec2 = buildSheets(view({ state: state({ innings: [foldedAfterOver1] }) })).overSummary;
    expect(numberStep(spec2, "runs")).toMatchObject({ initial: 0, min: 0 });
    expect(numberStep(spec2, "wickets")).toMatchObject({ initial: 0, min: 0 });
    expect(numberStep(spec2, "balls")).toMatchObject({ initial: 6, min: 0, max: 6 }); // bpo, not legalBalls + bpo

    // Over 2: scorer enters this over's 8 runs, 1 wicket, a full over (6 balls).
    const payload2 = spec2.buildPayload({ runs: "8", wickets: "1", balls: "6" });
    expect(payload2).toEqual({ runs: 14, wickets: 1, legalBalls: 12, partial: true });
    // payload2's totals (14/1/12) are each >= payload1's (6/0/6) — a rising
    // sequence a scorer would actually produce over-by-over; every answer is
    // floored at min:0 and buildPayload only ever ADDS it onto the fold's own
    // reads, which is what makes a DECREASING total structurally unreachable
    // through this sheet.
  });

  // R2b-next (2026-08-17): before this fix, a closed innings with another
  // due would prefill/hint off the CLOSED innings' own stale totals (e.g.
  // 187/6) and buildPayload would ADD the scorer's entered over onto them —
  // producing a wildly wrong cricket.innings.summary for the brand new
  // innings. Must reset to 0/0/bpo, the identical treatment "no innings open
  // yet" already gets (the test right above this block).
  it("closed innings with another due: hint/prefill reset to 0/0/bpo, never the closed innings' stale totals", () => {
    const spec = buildSheets(
      view({ state: state({ innings: [innings({ closed: true, runs: 187, wickets: 6, legalBalls: 118 })] }) }),
    ).overSummary;
    expect(numberStep(spec, "runs")).toMatchObject({ initial: 0, hintText: "0/0" });
    expect(numberStep(spec, "wickets")).toMatchObject({ initial: 0, hintText: "0/0" });
    expect(numberStep(spec, "balls")).toMatchObject({ initial: 6, max: 6 });
    const payload = spec.buildPayload({ runs: "7", wickets: "1", balls: "6" });
    expect(payload).toEqual({ runs: 7, wickets: 1, legalBalls: 6, partial: true }); // NOT 194/7/124
  });
});

// ---------------------------------------------------------------------------
// retire — dedicated tile + SwapSheet flow DROPPED (owner ruling, live-tile
// audit defect 4, 2026-08-17): the tile's own SwapSheet scoped "off" to the
// WHOLE batting side (never just the crease, engine backstops it at
// cricket.ts:1676) and hardcoded reason:"other", while the generic
// More-sheet's `cricket.retire` action was ALSO reachable, with a real
// reason enum. Two divergent entry points for the same event was the
// defect; the ruling keeps the generic path and drops the dedicated one.
// `buildSwap` is gone — its only caller was the removed tile — and
// `cricketSkinV3` now declares no `swap` member at all, so cricket has no
// SwapSheet surface (SwapSheet stays chassis code, ready for R3-R7 — see
// this describe block's own two tests below).
// ---------------------------------------------------------------------------

describe("retire — dedicated tile dropped, generic More sheet is the only path (owner ruling)", () => {
  it("no tile in any lineup/fidelity state declares id 'retire' or a swap action", () => {
    const states = [
      state({ innings: [] }), // pre-lineup
      state({ innings: [innings({ fine: null })] }), // coarse
      state(), // fine, default fixture — someone is genuinely at the crease
    ];
    for (const st of states) {
      const tiles = buildTiles(view({ state: st }));
      expect(tiles.some((tl) => tl.id === "retire")).toBe(false);
      expect(tiles.some((tl) => "swap" in tl.action)).toBe(false);
    }
  });

  it("cricketSkinV3 declares no swap method — same 'absent means never applicable' shape as contextSelect", () => {
    expect(cricketSkinV3(t).swap).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// cricketSkinV3 — factory assembly
// ---------------------------------------------------------------------------

describe("cricketSkinV3", () => {
  it("assembles a full SkinDefV3, key/tapModel correct, scorebug/dock close over the given t", () => {
    const skin = cricketSkinV3(t);
    expect(skin.key).toBe("cricket");
    expect(skin.tapModel).toBe("T");
    expect(skin.scorebug(view()).context).toContain("scorepad.skin.cricket.context.over");
    expect(skin.dock("cricket.ball", view())?.title).toBe("pad.cricket.dock.title");
    expect(skin.tiles(view()).length).toBeGreaterThan(0);
    expect(skin.phase!(view())).toBe("live");
    expect(skin.context!(view())).not.toBeNull();
    expect(skin.sheets!(view()).wicket).toBeDefined();
    // No swap — the dedicated Retire tile (and its SwapSheet flow) was
    // dropped, owner ruling (live-tile audit defect 4): see the "retire"
    // describe block above.
    expect(skin.swap).toBeUndefined();
    // No contextSelect — cricket has no event to persist a selection with
    // (this file's own header).
    expect(skin.contextSelect).toBeUndefined();
  });

  it("two different t functions produce two independently-localised scorebugs — proves the closure, not a shared cache", () => {
    const skinA = cricketSkinV3((k) => `A:${k}`);
    const skinB = cricketSkinV3((k) => `B:${k}`);
    expect(skinA.scorebug(view()).halves[0]!.who[0]!.name).toBe("A:scorepad.skin.cricket.scorebug.batting");
    expect(skinB.scorebug(view()).halves[0]!.who[0]!.name).toBe("B:scorepad.skin.cricket.scorebug.batting");
  });

  // R2b (bowler-block, 2026-08-17): context() now ALSO needs a real `t` —
  // ContextSlot.message is a pre-resolved string, same "closes over t" shape
  // scorebug/dock already had, extended by this task. Proved through the
  // FACTORY (buildContext's own default t is exercised by the direct-call
  // tests above; this is the line that would actually regress if the
  // factory wiring below dropped back to a bare `context: buildContext`).
  it("context() closes over the given t too — the bowler-block message needs a real t, not buildContext's own bare default", () => {
    const v = view({
      state: state({ innings: [innings({ fine: { striker: "h1", nonStriker: "h2", currentBowler: null, prevOverBowler: "a1", bowlerBalls: {} } })] }),
      contextOverrides: { bowler: "a1" },
    });
    const skinA = cricketSkinV3((k, vars) => `A:${k}:${vars?.name ?? ""}`);
    const bowlerSlot = skinA.context!(v)!.slots.find((s) => s.id === "bowler")!;
    expect(bowlerSlot.message).toBe("A:pad.cricket.context.bowler.blocked.prevOver:Away One");
  });

  // Review finding (bbcb12554): `buildTiles(view, t = (key) => key)` carries a
  // DEFAULT t for ~17 call sites in this file, so dropping the 2nd arg at the
  // `tiles:` wiring below type-checks, lints, and ships the raw i18n key as the
  // tile's visible label. Every labelText test above calls buildTiles directly
  // with an explicit t, so none of them can see that. This one goes through the
  // FACTORY, which is the line that would actually regress.
  it("tiles() closes over the given t — the factory wiring, not buildTiles' default, is what localises labelText", () => {
    const coarse = view({ state: state({ innings: [innings({ fine: null, legalBalls: 30 })] }) });
    const skinA = cricketSkinV3((k, vars) => `A:${k}:${vars?.over}`);
    const skinB = cricketSkinV3((k, vars) => `B:${k}:${vars?.over}`);
    const overOf = (s: SkinDefV3) => s.tiles(coarse).find((tl) => tl.id === "overSummary")!;
    expect(overOf(skinA).labelText).toBe("A:pad.cricket.action.endOfOver:6");
    expect(overOf(skinB).labelText).toBe("B:pad.cricket.action.endOfOver:6");
  });
});

// Sanity: EXTRA_KINDS/WICKET_KINDS/FIELDER_ELIGIBLE_KINDS/VARIABLE_OUT_KINDS
// exports match the scouted facts the brief pinned (do-not-re-derive list).
describe("closed vocabularies", () => {
  it("WICKET_KINDS has all 10 members", () => {
    expect(WICKET_KINDS).toHaveLength(10);
  });
  it("EXTRA_KINDS has all 5 members", () => {
    expect(EXTRA_KINDS).toHaveLength(5);
  });
  it("FIELDER_ELIGIBLE_KINDS is exactly caught/runout/stumped", () => {
    expect([...FIELDER_ELIGIBLE_KINDS].sort()).toEqual(["caught", "runout", "stumped"]);
  });
  it("VARIABLE_OUT_KINDS is exactly runout", () => {
    expect([...VARIABLE_OUT_KINDS]).toEqual(["runout"]);
  });
});

// ---------------------------------------------------------------------------
// R2c / C1 — the bowler chip's own candidate list.
//
// R2b moved the REFUSAL in front of the tap (the delivery tiles go disabled
// and the slot states why), but left the PICKER itself untouched: it still
// offered both squads' whole on-field roster, so a scorer could pick a
// batting-side player, or a bowler at quota, and only then meet the block.
// buildContext's own CANDIDATE-LIST GAP note recorded that as out of R2b's
// reach because ContextSlot had no candidates/side field. It has one now.
//
// SCOPE removes the batting side; ELIGIBILITY keeps the fielding side's own
// ineligible bowlers visible WITH their reason, which is the same ruling that
// governs the tiles. No new i18n: the four blocked.* keys R2b shipped are
// reused verbatim, so the picker and the slot message can never word the same
// fact two different ways.
// ---------------------------------------------------------------------------

describe("buildContext — R2c: the bowler picker's candidates and per-candidate blocks", () => {
  const overBoundary = (fine: Record<string, unknown> = {}) =>
    innings({ fine: { striker: "h1", nonStriker: "h2", currentBowler: null, prevOverBowler: null, bowlerBalls: {}, ...fine } });

  const bowlerSlot = (v: PadHostView) => buildContext(v, t)!.slots.find((s) => s.id === "bowler")!;

  it("offers the FIELDING side only — no batting-side player is a candidate at all", () => {
    const slot = bowlerSlot(view({ state: state({ innings: [overBoundary()] }) }));
    expect(slot.candidates).toEqual(["a1", "a2", "a3"]);
    for (const id of ["h1", "h2", "h3"]) expect(slot.candidates).not.toContain(id);
  });

  it("blocks the previous over's bowler IN PLACE, with the same wording the slot message uses", () => {
    const slot = bowlerSlot(view({ state: state({ innings: [overBoundary({ prevOverBowler: "a1" })] }) }));
    // Still offered — visible, blocked and reasoned, never silently dropped.
    expect(slot.candidates).toContain("a1");
    expect(slot.blocked?.a1).toBe(t("pad.cricket.context.bowler.blocked.prevOver", { name: "Away One" }));
  });

  it("blocks a bowler at quota, carrying the REAL cfg quota — proved against the Hundred's 5-ball over", () => {
    // 20 balls / 5 per over = exactly 4 overs. A hardcoded 6 computes 3 and
    // would wrongly leave this bowler selectable.
    const slot = bowlerSlot(
      view({
        cfg: cfg({ ballsPerOver: 5, maxOversPerBowler: 4 }),
        state: state({ innings: [overBoundary({ bowlerBalls: { a1: 20 } })] }),
      }),
    );
    expect(slot.blocked?.a1).toBe(t("pad.cricket.context.bowler.blocked.quota", { name: "Away One", quota: 4 }));
  });

  it("leaves an eligible bowler unblocked — the map is never exhaustive", () => {
    const slot = bowlerSlot(
      view({ cfg: cfg({ maxOversPerBowler: 4 }), state: state({ innings: [overBoundary({ prevOverBowler: "a1" })] }) }),
    );
    expect(slot.blocked?.a2).toBeUndefined();
    expect(slot.blocked?.a3).toBeUndefined();
  });

  it("an ABSENT maxOversPerBowler blocks nobody on quota grounds — absent is uncapped, not zero", () => {
    const slot = bowlerSlot(view({ state: state({ innings: [overBoundary({ bowlerBalls: { a1: 600 } })] }) }));
    expect(slot.blocked?.a1).toBeUndefined();
  });

  it("blocks EVERY candidate when nobody can legally open the over — the dead-end state stays visible and explained", () => {
    const slot = bowlerSlot(
      view({
        cfg: cfg({ maxOversPerBowler: 1 }),
        state: state({ innings: [overBoundary({ prevOverBowler: "a1", bowlerBalls: { a2: 6, a3: 6 } })] }),
      }),
    );
    expect(slot.candidates).toEqual(["a1", "a2", "a3"]);
    for (const id of ["a1", "a2", "a3"]) expect(slot.blocked?.[id]).toBeTruthy();
  });

  it("mid-over the slot is read-only and blocks nobody — the fold has already locked that bowler in", () => {
    const slot = bowlerSlot(
      view({
        cfg: cfg({ maxOversPerBowler: 4 }),
        state: state({ innings: [innings({ fine: { striker: "h1", nonStriker: "h2", currentBowler: "a1", prevOverBowler: "a2", bowlerBalls: { a1: 30 } } })] }),
      }),
    );
    expect(slot.readOnly).toBe(true);
    expect(slot.blocked ?? {}).toEqual({});
  });
});
