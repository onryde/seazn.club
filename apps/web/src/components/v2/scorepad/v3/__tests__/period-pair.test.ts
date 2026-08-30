// v3/__tests__/period-pair.test.ts — R6/task C, and the wave's own evidence.
//
// EVERY assertion here that could be made against a hand-written fixture is
// made against the REAL kernel instead: states come out of `foldMatch(hockey |
// icehockey, ...)`, payloads go back into `apply(..., {strict: true})`, and the
// two lists this skin family restates from the engine (fidelity bands, offence
// vocabularies) are compared to the module's own `padSpec`. `apps/web` vitest is
// `environment: "node"` with no DOM, so a builder test that stopped there would
// prove the builder and nothing else — which is exactly how this programme has
// shipped a declared-but-inert seam six times.
//
// The headline is section 1: BOTH SKINS DECLARE `clock()`, which is the single
// switch that mounts `PadClockBar` and turns on `at` stamping. Before this wave
// nothing in the product declared it.

import { describe, it, expect } from "vitest";
import { AttemptOutcome } from "@seazn/engine/core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AnySportModule, PadSpec } from "@seazn/engine/sport";
import { initSquads } from "@seazn/engine/core";
import { CLOCK_NUDGE_SECONDS, adjustClock, initClock, startClock, reseatClock, elapsedOf, stampOf } from "../clock";
import { stampFor } from "../pad-host";
import type { GuidedSheetSpec, PadHostView, SwapSlot, TileSpec } from "../types";
import { SPORT_PALETTES, SPORT_TONES } from "../sport-theme";
import { hockeySkinV3, hockeySpec, HOCKEY_REASONS } from "../skins/hockey";
import { icehockeySkinV3, icehockeySpec, ICEHOCKEY_REASONS } from "../skins/icehockey";
import {
  bandsOf,
  buildClock,
  eventTypesOf,
  isPlayPhaseToken,
  boxOf,
  releasableBox,
  SWAP_TYPE,
  type PeriodSkinSpec,
} from "../skins/period-shared";
import {
  PERIOD_MODULES,
  appendVerdict,
  decidedShootout,
  foldPeriod,
  foldedPhases,
  hockey,
  icehockey,
  lineupsFor,
  nextAdvanceOf,
  periodCfg,
  phaseVerdict,
  probePayload,
  shippedVariantCfgs,
  shootoutCfgOf,
  summaryOf,
  type PeriodStateLike,
  type Spec,
} from "./_period-fold";

const T = (key: string, vars?: Record<string, string | number>): string =>
  vars === undefined ? key : `${key}(${Object.keys(vars).sort().join(",")})`;

type SkinFactory = (t: typeof T) => ReturnType<typeof hockeySkinV3>;

interface Sport {
  readonly key: "hockey" | "icehockey";
  readonly module: AnySportModule;
  readonly factory: SkinFactory;
  readonly spec: PeriodSkinSpec;
  readonly reasons: readonly string[];
}

const SPORTS: readonly Sport[] = [
  { key: "hockey", module: hockey as AnySportModule, factory: hockeySkinV3, spec: hockeySpec, reasons: HOCKEY_REASONS },
  {
    key: "icehockey",
    module: icehockey as AnySportModule,
    factory: icehockeySkinV3,
    spec: icehockeySpec,
    reasons: ICEHOCKEY_REASONS,
  },
];

/** A view exactly as `pad-host.tsx` builds it: the fold's own state and the
 *  module's own summary, never a hand-shaped stand-in for either. */
function viewFor(sport: Sport, cfg: unknown, state: PeriodStateLike, band = 3): PadHostView {
  const lineups = lineupsFor(sport.module, cfg);
  // EXACTLY the host's own fallback: `state.squads` when the fold populates it,
  // `initSquads(lineups)` otherwise — never a hand-shaped squad.
  const squads = (state.squads ?? initSquads(lineups)) as PadHostView["squads"];
  const names: Record<string, string> = {};
  for (const side of ["home", "away"] as const) {
    for (const member of squads[side].members) names[member.personId] = `Name ${member.personId}`;
  }
  return {
    cfg,
    state,
    summary: summaryOf(sport.module, state),
    phase: state.phase === "pre" ? "pre" : "live",
    band: band as PadHostView["band"],
    entitlements: {},
    personNames: names,
    squads,
    events: [],
    contextOverrides: {},
  };
}

/** Walk the period ladder to a live phase, so every builder is exercised in the
 *  phase a scorer actually uses. */
function livePhaseState(sport: Sport, cfg: unknown, extra: Spec[] = []): PeriodStateLike {
  return foldPeriod(sport.module, cfg, [["core.start"], ...extra]);
}

function tileEvent(tiles: readonly TileSpec[], id: string): { type: string; payload: Record<string, unknown> } {
  const tile = tiles.find((t2) => t2.id === id);
  expect(tile, `no tile "${id}"`).toBeDefined();
  const action = tile!.action;
  expect("event" in action, `tile "${id}" is not a direct-event tile`).toBe(true);
  return (action as { event: { type: string; payload: Record<string, unknown> } }).event;
}

// ---------------------------------------------------------------------------
// 1. THE HEADLINE — `clock()` is declared, so `PadClockBar` is reachable
// ---------------------------------------------------------------------------

describe("R6 headline: both skins declare clock(), which is what makes PadClockBar reachable at all", () => {
  for (const sport of SPORTS) {
    describe(sport.key, () => {
      const cfg = periodCfg(sport.module);

      it("declares the method — the ONE switch that mounts the bar and turns on `at` stamping", () => {
        const skin = sport.factory(T);
        expect(typeof skin.clock).toBe("function");
      });

      it("returns a spec naming the ENGINE phase once play has started, and the host seats a clock from it", () => {
        const state = livePhaseState(sport, cfg);
        const view = viewFor(sport, cfg, state);
        const spec = sport.factory(T).clock!(view);
        expect(spec, "a live pad with no clock spec leaves PadClockBar unmounted").not.toBeNull();
        expect(spec!.period).toBe(state.phase);
        // The chassis's own reconciliation: a non-null spec IS a mounted bar.
        expect(reseatClock(null, spec)).not.toBeNull();
      });

      it("returns null before the first whistle and after the last, so the bar is absent where a clock would be a lie", () => {
        const pre = foldPeriod(sport.module, cfg, []);
        expect(sport.factory(T).clock!(viewFor(sport, cfg, pre))).toBeNull();
        expect(reseatClock(initClock("P1"), null)).toBeNull();

        const decided = foldedPhases(sport.module).find((row) => row.phase === "done");
        expect(decided, "no folded recipe reaches a decided match").toBeDefined();
        expect(sport.factory(T).clock!(viewFor(sport, cfg, decided!.state))).toBeNull();
      });

      it("re-seats on the WHISTLE — a new period resets the origin, the same one does not", () => {
        const first = livePhaseState(sport, cfg);
        const firstSpec = buildClock(viewFor(sport, cfg, first))!;
        const seated = startClock(initClock(firstSpec.period, firstSpec.seed ?? 0), 1_000);
        // Same period, later render: the host keeps the RUNNING clock by
        // reference. Re-seeding here would drag it back to the last event.
        expect(reseatClock(seated, firstSpec)).toBe(seated);

        const next = nextAdvanceOf(sport.module, first);
        if (next !== null && next !== "FT") {
          const after = livePhaseState(sport, cfg, [[`${sport.key}.period.advance`, { to: next }]]);
          const nextSpec = buildClock(viewFor(sport, cfg, after))!;
          expect(nextSpec.period).toBe(next);
          const reseated = reseatClock(seated, nextSpec)!;
          expect(reseated).not.toBe(seated);
          expect(reseated.runningSince, "a fresh period must seat PAUSED").toBeNull();
        }
      });

      it("seeds from the fold's own last stamp, and IGNORES one left over from a phase the match has left", () => {
        const stamped = livePhaseState(sport, cfg, [
          [`${sport.key}.goal`, { by: "H", at: { period: firstPlayPhase(sport, cfg), elapsed: 421 } }],
        ]);
        expect(buildClock(viewFor(sport, cfg, stamped))).toEqual({
          period: firstPlayPhase(sport, cfg),
          seed: 421,
        });

        const next = nextAdvanceOf(sport.module, stamped);
        if (next !== null && next !== "FT") {
          const afterWhistle = foldPeriod(sport.module, cfg, [
            ["core.start"],
            [`${sport.key}.goal`, { by: "H", at: { period: firstPlayPhase(sport, cfg), elapsed: 421 } }],
            [`${sport.key}.period.advance`, { to: next }],
          ]);
          // `state.asOf` still names the PREVIOUS period here; seeding from it
          // would start the new period 421 seconds in.
          expect(buildClock(viewFor(sport, cfg, afterWhistle))).toEqual({ period: next });
        }
      });

      it("END TO END: the goal tile, stamped by the host's own gateway, folds and sets state.asOf", () => {
        const state = livePhaseState(sport, cfg);
        const view = viewFor(sport, cfg, state);
        const skin = sport.factory(T);
        const spec = skin.clock!(view)!;
        const clock = startClock(initClock(spec.period, spec.seed ?? 0), 1_000);

        const goal = tileEvent(skin.tiles(view), "goal-home");
        const stamped = stampFor(sport.module, goal.type, goal.payload, clock, 1_000 + 761_000) as Record<string, unknown>;
        expect(stamped.at).toEqual({ period: state.phase, elapsed: 761 });

        const folded = foldPeriod(sport.module, cfg, [["core.start"], [goal.type, stamped]]);
        expect(folded.asOf).toEqual({ period: state.phase, elapsed: 761 });
        // …and the pad then reads its own stamp back as the next seed.
        expect(buildClock(viewFor(sport, cfg, folded))).toEqual({ period: state.phase, seed: 761 });
      });

      it("A PAUSED clock still stamps — in a stop-clock sport the whistle time IS the game time", () => {
        const state = livePhaseState(sport, cfg);
        const paused = initClock(String(state.phase), 300);
        expect(elapsedOf(paused, 9_999_999)).toBe(300);
        const goal = tileEvent(sport.factory(T).tiles(viewFor(sport, cfg, state)), "goal-away");
        const stamped = stampFor(sport.module, goal.type, goal.payload, paused, 9_999_999) as Record<string, unknown>;
        expect(stamped.at).toEqual({ period: state.phase, elapsed: 300 });
      });

      it("THE POWER-PLAY COUNTDOWN, dead before this wave: a stamped card gets an expiresAt the strip can read", () => {
        const phase = firstPlayPhase(sport, cfg);
        const classKey = Object.keys(
          (periodCfg(sport.module) as { suspensions: { classes: Record<string, unknown> } }).suspensions.classes,
        )[0]!;
        const timed = foldPeriod(sport.module, cfg, [
          ["core.start"],
          [
            `${sport.key}.suspension.start`,
            { by: "H", person: "H-p2", class: classKey, at: { period: phase, elapsed: 60 } },
          ],
        ]);
        const suspensions = timed.suspensions as { expiresAt?: unknown }[];
        expect(suspensions).toHaveLength(1);
        // `expiresAt` derives from the event's OWN `at`. No stamp, no expiry —
        // which is exactly why this was inert until a skin declared a clock.
        expect(suspensions[0]!.expiresAt).toBeDefined();

        const strip = sport.factory(T).scorebug(viewFor(sport, cfg, timed)).strip;
        const box = strip.find((item) => item.id === "box");
        expect(box, "a running suspension must reach the strip").toBeDefined();
        expect(box!.value).toMatch(/^\d+:\d{2}$/);

        const unstamped = foldPeriod(sport.module, cfg, [
          ["core.start"],
          [`${sport.key}.suspension.start`, { by: "H", person: "H-p2", class: classKey }],
        ]);
        expect((unstamped.suspensions as { expiresAt?: unknown }[])[0]!.expiresAt).toBeUndefined();
        // CORRECTED, R6 fix pass 2 gap 3. This used to assert the box item was
        // ABSENT — "an UNSTAMPED card must not invent a countdown" — and read
        // the absence of the whole row as proof of the absence of a number.
        // Those are different claims: the player was still off, the strength
        // chip beside it still said so, and the band said nothing about who.
        // The invariant this test was written to protect is the one asserted
        // now: no NUMBER without an expiry. The row itself is owed either way.
        const unstampedBox = sport
          .factory(T)
          .scorebug(viewFor(sport, cfg, unstamped))
          .strip.find((item) => item.id === "box");
        expect(unstampedBox, "an unstamped card left the band silent").toBeDefined();
        expect(unstampedBox!.value, "an UNSTAMPED card must not invent a countdown").not.toMatch(/\d+:\d{2}/);
        expect(unstampedBox!.value).toBe(`pad.${sport.key}.class.${classKey}`);
      });
    });
  }
});

/** The first phase the kernel enters after `core.start`, read back off a real
 *  fold rather than assumed to be "P1" or "Q1". */
function firstPlayPhase(sport: Sport, cfg: unknown): string {
  return String(foldPeriod(sport.module, cfg, [["core.start"]]).phase);
}

/** The cfg's own first declared suspension class — never hardcoded, since
 *  hockey (green/yellow/red) and ice hockey (minor/bench_minor/…) share no
 *  class name at all. */
function firstClassOf(cfg: unknown): string {
  return Object.keys((cfg as { suspensions: { classes: Record<string, unknown> } }).suspensions.classes)[0]!;
}

const APPEND_T0 = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// 1b. R6 fix pass 4, finding 2 — the SERVER's own monotonic-time guard
// (`core/events.ts`'s NON_MONOTONIC_TIME, enforced through `strictFromSeq`
// exactly as `append-event.ts` enforces it), and proof that a floored
// `adjustClock` correction can never produce a stamp it refuses.
// ---------------------------------------------------------------------------

describe("the real fold's NON_MONOTONIC_TIME guard is exactly what a clock correction must respect", () => {
  for (const sport of SPORTS) {
    it(`${sport.key}: a stamp BELOW the accepted high-water mark is refused; AT or ABOVE it is not`, () => {
      const cfg = periodCfg(sport.module);
      const phase = firstPlayPhase(sport, cfg);
      const classKey = firstClassOf(cfg);
      const prior: Spec[] = [
        ["core.start"],
        [`${sport.key}.goal`, { by: "H", at: { period: phase, elapsed: 360 } }],
      ];
      const cardAt = (elapsed: number): Spec => [
        `${sport.key}.suspension.start`,
        { by: "H", class: classKey, at: { period: phase, elapsed } },
      ];
      // BELOW the mark — finding 2's exact shape: a goal recorded at 6:00,
      // then a correction that let the display (and so the next stamp) drift
      // to 5:00.
      expect(appendVerdict(sport.module, cfg, prior, cardAt(300)), "below the high-water mark").toBe("non-monotonic");
      // AT the mark — equal stamps are legal (`core/events.ts`'s own doc:
      // "Equal stamps are legal").
      expect(appendVerdict(sport.module, cfg, prior, cardAt(360)), "at the high-water mark").toBe("accepted");
      // ABOVE it — ordinary forward play.
      expect(appendVerdict(sport.module, cfg, prior, cardAt(420)), "above the high-water mark").toBe("accepted");
    });

    it(`${sport.key}: adjustClock's own floor produces exactly the boundary the fold accepts, never the one it refuses`, () => {
      // Ties clock.ts's pure arithmetic to the REAL engine: a correction
      // floored at the fold's own high-water mark can never itself go on to
      // produce a refused stamp, because the floor IS the boundary the fold
      // enforces — proved here rather than assumed from the two files
      // agreeing about a number in the abstract.
      const cfg = periodCfg(sport.module);
      const phase = firstPlayPhase(sport, cfg);
      const classKey = firstClassOf(cfg);
      const prior: Spec[] = [
        ["core.start"],
        [`${sport.key}.goal`, { by: "H", at: { period: phase, elapsed: 360 } }],
      ];
      const running = startClock(reseatClock(null, { period: phase, seed: 360 })!, APPEND_T0);
      const nowMs = APPEND_T0 + 10_000; // ten seconds of play since the goal
      const floor = { period: phase, elapsed: 360 };
      // Without the floor this WOULD go backward — the exact pre-fix defect.
      expect(elapsedOf(adjustClock(running, -CLOCK_NUDGE_SECONDS, nowMs), nowMs), "sanity: unfloored, it goes below 360").toBeLessThan(360);
      const corrected = adjustClock(running, -CLOCK_NUDGE_SECONDS, nowMs, floor);
      const stamp = stampOf(corrected, nowMs)!;
      expect(
        appendVerdict(sport.module, cfg, prior, [`${sport.key}.suspension.start`, { by: "H", class: classKey, at: stamp }]),
        `${sport.key}: the floored correction's own stamp was refused`,
      ).toBe("accepted");
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Every builder's own output, folded through the real reducer
// ---------------------------------------------------------------------------

describe("what the pad emits is what the fold accepts", () => {
  for (const sport of SPORTS) {
    describe(sport.key, () => {
      const cfg = periodCfg(sport.module);
      const e = eventTypesOf(sport.spec);

      it("both goal tiles fold, on the real entrants", () => {
        const state = livePhaseState(sport, cfg);
        const view = viewFor(sport, cfg, state);
        const tiles = sport.factory(T).tiles(view);
        for (const side of ["home", "away"] as const) {
          const goal = tileEvent(tiles, `goal-${side}`);
          expect(phaseVerdict(sport.module, state, goal.type, goal.payload)).toBe("accepted");
        }
        const after = foldPeriod(sport.module, cfg, [["core.start"], [e.goal, tileEvent(tiles, "goal-home").payload]]);
        expect((after.goals as { home: number }).home).toBe(1);
      });

      it("the whistle tile carries the marker the KERNEL expects, not one the pad chose", () => {
        const state = livePhaseState(sport, cfg);
        const view = viewFor(sport, cfg, state);
        const advance = tileEvent(sport.factory(T).tiles(view), "advance");
        expect(advance.payload.to).toBe(nextAdvanceOf(sport.module, state));
        expect(phaseVerdict(sport.module, state, advance.type, advance.payload)).toBe("accepted");
      });

      it("the suspension sheet's payload folds, for every class the cfg declares", () => {
        const state = livePhaseState(sport, cfg);
        const view = viewFor(sport, cfg, state);
        const sheets = sport.factory(T).sheets!(view);
        const sheet = sheets["suspension-home"] as GuidedSheetSpec;
        const classes = Object.keys(
          (cfg as { suspensions: { classes: Record<string, unknown> } }).suspensions.classes,
        );
        expect(sheet.steps[0]!.id).toBe("class");
        expect((sheet.steps[0] as { options: { id: string }[] }).options.map((o) => o.id)).toEqual(classes);
        for (const classKey of classes) {
          const payload = sheet.buildPayload({ class: classKey, reason: sport.reasons[0]! });
          expect(phaseVerdict(sport.module, state, sheet.event, payload), classKey).toBe("accepted");
        }
      });

      it("the release sheet names a suspension the fold can actually end, and ending it empties the box", () => {
        const phase = firstPlayPhase(sport, cfg);
        const classKey = Object.keys(
          (cfg as { suspensions: { classes: Record<string, unknown> } }).suspensions.classes,
        )[0]!;
        const carded: Spec[] = [
          ["core.start"],
          [e.suspStart, { by: "H", person: "H-p2", class: classKey, at: { period: phase, elapsed: 30 } }],
        ];
        const state = foldPeriod(sport.module, cfg, carded);
        const view = viewFor(sport, cfg, state);
        expect(releasableBox(view)).toHaveLength(1);

        const sheet = sport.factory(T).sheets!(view)[SHEET_RELEASE] as GuidedSheetSpec;
        const option = (sheet.steps[0] as { options: { id: string }[] }).options[0]!;
        const payload = sheet.buildPayload({ target: option.id });
        expect(phaseVerdict(sport.module, state, sheet.event, payload)).toBe("accepted");
        const released = foldPeriod(sport.module, cfg, [...carded, [sheet.event, payload]]);
        expect(released.suspensions).toHaveLength(0);
      });

      it("the set-piece sheet folds for every kind the cfg declares, and every outcome", () => {
        const state = livePhaseState(sport, cfg);
        const view = viewFor(sport, cfg, state);
        const sheet = sport.factory(T).sheets!(view)[SHEET_SET_PIECE] as GuidedSheetSpec;
        const kinds = (cfg as { setPieceKinds: string[] }).setPieceKinds;
        expect(kinds.length).toBeGreaterThan(0);
        for (const kind of kinds) {
          // The ENGINE's enum, never a second copy of it (R6 fix pass 2, gap 4).
        for (const outcome of AttemptOutcome.options) {
            const payload = sheet.buildPayload({ by: "H", kind, outcome });
            expect(phaseVerdict(sport.module, state, sheet.event, payload), `${kind}/${outcome}`).toBe("accepted");
          }
        }
        // …and with the kind step SKIPPED (one declared kind), the payload still
        // carries a legal kind rather than `undefined`.
        expect(sheet.buildPayload({ by: "H", outcome: "scored" }).kind).toBe(kinds[0]);
      });

      it("the swap slot's own buildEvent folds as a real core.lineup.substitution", () => {
        const state = livePhaseState(sport, cfg);
        const view = viewFor(sport, cfg, state);
        const slots = sport.factory(T).swap!(view) as SwapSlot[];
        expect(slots.map((s) => s.id)).toEqual(["sub-home", "sub-away"]);
        const slot = slots[0]!;
        expect(slot.eventType).toBe(SWAP_TYPE);
        const off = slot.offCandidates![0]!;
        const on = slot.candidates![0]!;
        const event = slot.buildEvent(off, on);
        const folded = foldPeriod(sport.module, cfg, [["core.start"], [event.type, event.payload]]);
        const members = (folded.squads as { home: { members: { personId: string; onField: boolean }[] } }).home.members;
        expect(members.find((m) => m.personId === on)?.onField, "the incoming player is not on").toBe(true);
        expect(members.find((m) => m.personId === off)?.onField, "the outgoing player is still on").toBe(false);
      });

      it("the shoot-out sheet folds — when the cfg has a shoot-out to reach", () => {
        const withShootout = shippedVariantCfgs(sport.module).find(
          ({ cfg: c }) => (c as { shootout: unknown }).shootout !== null,
        );
        if (withShootout === undefined) return; // hockey's default FIH outdoor has none
        const soCfg = withShootout.cfg;
        const specs: Spec[] = [["core.start"]];
        for (let i = 0; i < 8; i += 1) {
          const s = foldPeriod(sport.module, soCfg, specs);
          if (s.phase === "SHOOTOUT") break;
          const next = nextAdvanceOf(sport.module, s);
          if (next === null) break;
          specs.push([e.advance, { to: next }]);
        }
        const state = foldPeriod(sport.module, soCfg, specs);
        expect(state.phase, `${withShootout.variant} never reached a shoot-out`).toBe("SHOOTOUT");
        const view = viewFor(sport, soCfg, state);
        const sheet = sport.factory(T).sheets!(view)["attempt-home"] as GuidedSheetSpec;
        for (const outcome of ["scored", "missed"]) {
          const payload = sheet.buildPayload({ outcome });
          expect(phaseVerdict(sport.module, state, sheet.event, payload), outcome).toBe("accepted");
        }
      });
    });
  }
});

const SHEET_RELEASE = "release";
const SHEET_SET_PIECE = "set-piece";

// ---------------------------------------------------------------------------
// 3. refusedEventTypes — the mirror, refereed by the fold
// ---------------------------------------------------------------------------

describe("refusedEventTypes agrees with the real reducer in every phase both kernels can reach", () => {
  for (const sport of SPORTS) {
    it(`${sport.key}: nothing the skin leaves unrefused is WRONG_PHASE, and nothing it refuses is accepted`, () => {
      const rows = foldedPhases(sport.module);
      expect(rows.length).toBeGreaterThan(4);
      const seen = new Set<string>();
      for (const row of rows) {
        seen.add(row.phase);
        const view = viewFor(sport, row.cfg, row.state);
        const refused = new Set(sport.factory(T).refusedEventTypes!(view));
        for (const type of Object.keys(bandsOf(sport.spec))) {
          const verdict = phaseVerdict(sport.module, row.state, type, probePayload(sport.module, type, row.state));
          if (!refused.has(type)) {
            expect(verdict, `${row.label}: ${type} offered but refused by the fold`).not.toBe("wrong-phase");
          } else {
            expect(verdict, `${row.label}: ${type} refused by the skin but ACCEPTED by the fold`).not.toBe("accepted");
          }
        }
      }
      // The sweep is worth something only if it actually visited several phases.
      expect(seen.size, `only reached ${[...seen].join(", ")}`).toBeGreaterThan(2);
    });

    it(`${sport.key}: the phase mapping is total — every reachable phase lands in pre/live/post`, () => {
      const mapped = new Map<string, string>();
      for (const row of foldedPhases(sport.module)) {
        const padPhase = sport.factory(T).phase!(viewFor(sport, row.cfg, row.state));
        expect(["pre", "live", "post"]).toContain(padPhase);
        mapped.set(row.phase, padPhase);
      }
      expect(mapped.get("pre")).toBe("pre");
      expect(mapped.get("done")).toBe("post");
      // R6 fix pass 2, gap 5. These two used to be skipped BY NAME in the loop
      // below and produced by nothing above it, so `POST_PHASES` could lose
      // either member and the whole suite stayed green. They are terminal
      // phases the kernel really reaches — `core.finalize` on a decided
      // fixture (kernel.ts:2408) and a `replay` abandonment (kernel.ts:1416).
      expect(mapped.get("final"), "the fold table produced no finalized fixture").toBe("post");
      expect(mapped.get("abandoned"), "the fold table produced no abandoned fixture").toBe("post");
      for (const [phase, padPhase] of mapped) {
        if (phase === "pre" || phase === "done" || phase === "final" || phase === "abandoned") continue;
        expect(padPhase, `${phase} is not live`).toBe("live");
        expect(isPlayPhaseToken(phase) || phase === "SHOOTOUT", `${phase} classified wrongly`).toBe(true);
      }
    });

    it(`${sport.key}: a finalized or abandoned fixture declares NO clock — the failure the missing rows hid`, () => {
      // Not a cosmetic mapping detail. Drop either token from `POST_PHASES` and
      // `isPlayPhaseToken` starts calling it a play phase, so `buildClock`
      // returns `{period: "abandoned"}`: `PadClockBar` mounts, ticks, offers
      // Start — and every `at` it stamps is refused by `isPlayPhase`
      // (kernel.ts:2490), because "abandoned" is not in `playPhases(cfg)`. A
      // scorer would watch a running clock record nothing.
      for (const terminal of ["final", "abandoned"]) {
        const row = foldedPhases(sport.module).find((r) => r.phase === terminal);
        expect(row, `no folded recipe reaches "${terminal}"`).toBeDefined();
        const view = viewFor(sport, row!.cfg, row!.state);
        expect(isPlayPhaseToken(terminal), `${terminal} reads as a play phase`).toBe(false);
        expect(buildClock(view), `${terminal} declared a clock`).toBeNull();
        // …and the fold agrees: every one of the pad's own event types is
        // refused there, so a stamp would have had nothing to attach to.
        const refused = new Set(sport.factory(T).refusedEventTypes!(view));
        for (const type of Object.keys(bandsOf(sport.spec))) {
          expect(refused.has(type), `${terminal}: ${type} still offered`).toBe(true);
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 4. The two restatements, pinned to the engine that owns them
// ---------------------------------------------------------------------------

describe("the skin's restatements of engine data are pinned to the engine", () => {
  for (const sport of SPORTS) {
    const cfg = periodCfg(sport.module);
    const spec = (sport.module.padSpec as (c: unknown) => PadSpec)(cfg);

    it(`${sport.key}: every fidelity band matches padSpec(cfg).fidelity`, () => {
      const declared = bandsOf(sport.spec);
      for (const [type, band] of Object.entries(declared)) {
        expect(spec.fidelity[type], `${type}`).toBe(band);
      }
      // …and the pad knows about every type the engine can record, so a new
      // event type in the kernel fails here instead of appearing only in More.
      expect(Object.keys(spec.fidelity).sort()).toEqual(Object.keys(declared).sort());
    });

    it(`${sport.key}: the offence list matches the preset's own suspensionReasons enum`, () => {
      const values = reasonEnumOf(spec);
      expect(values, "padSpec no longer publishes a reason enum").not.toBeNull();
      expect(sport.reasons).toEqual(values);
    });

    it(`${sport.key}: the set-piece sheet offers exactly the outcomes padSpec declares, in every shipped variant`, () => {
      // R6 fix pass 2, gap 4. The sheet's four result options were a literal in
      // `period-shared.ts` restating `AttemptOutcome` (core/types.ts:29), and
      // this file restated the SAME four strings — so a fifth engine member
      // would have left skin and test in perfect agreement while the scorer was
      // offered one result fewer than the fold accepts. The skin now reads
      // `AttemptOutcome.options`; this is the referee, per sport and per
      // variant, the way the fidelity and offence mirrors above are refereed.
      for (const { variant, cfg: variantCfg } of shippedVariantCfgs(sport.module)) {
        const declared = enumValuesOf((sport.module.padSpec as (c: unknown) => PadSpec)(variantCfg), "outcome");
        expect(declared, `${variant}: padSpec no longer publishes an outcome enum`).not.toBeNull();
        const state = livePhaseState(sport, variantCfg);
        const sheet = sport.factory(T).sheets!(viewFor(sport, variantCfg, state))[SHEET_SET_PIECE] as GuidedSheetSpec;
        const step = sheet.steps.find((s) => s.id === "outcome") as { options: { id: string }[] };
        expect(step.options.map((o) => o.id), variant).toEqual(declared);
        // …and the fold takes every one of them, so the pin is not merely
        // list-to-list agreement between two mirrors of the same wrong thing.
        for (const outcome of declared!) {
          const payload = sheet.buildPayload({ by: "H", kind: (variantCfg as { setPieceKinds: string[] }).setPieceKinds[0]!, outcome });
          expect(phaseVerdict(sport.module, state, sheet.event, payload), `${variant}/${outcome}`).toBe("accepted");
        }
      }
    });
  }
});

function reasonEnumOf(spec: PadSpec): readonly string[] | null {
  return enumValuesOf(spec, "reason");
}

/** The values `padSpec` publishes for one enum field, wherever it declares it —
 *  the same walk `reasonEnumOf` has always done, generalised so the set-piece
 *  outcome enum can be refereed by the engine too. */
function enumValuesOf(spec: PadSpec, path: string): readonly string[] | null {
  for (const panel of spec.panels) {
    for (const action of panel.actions) {
      for (const field of action.fields ?? []) {
        if (field.kind === "enum" && field.path === path) return field.values;
      }
    }
  }
  return null;
}

/** Every `PadAction` padSpec(cfg) declares for `type`, across every panel —
 *  the referee for the sweep below. */
function padActionFor(spec: PadSpec, type: string): PadSpec["panels"][number]["actions"][number] | undefined {
  return spec.panels.flatMap((panel) => panel.actions).find((action) => action.type === type);
}

// ---------------------------------------------------------------------------
// 4b. R6 fix pass 4, finding 4 — a CLAIMED action's sheet + dock must reach
// EVERY field/attribution path padSpec(cfg) declares for it, or the pad
// silently ships a control that can never record what the engine's own form
// would have collected. Regression measured 2026-08-30: the suspension sheet
// claimed `<sport>.suspension.start` (removing it from More) but collected
// only `class`/`reason`, so `minutes` and `servedBy` — both on padSpec since
// S7/#427, both with four-locale copy already shipped — were reachable
// through NOTHING. The same claiming dropped `void` and `goalkeeper` from the
// shoot-out attempt and `goalkeeper` from the set piece.
//
// Engine-driven rather than a hardcoded field list, per that finding's own
// instruction: this walks the REAL `padSpec(cfg)` action for each claimed
// type and asserts every path it declares is settable by SOME combination of
// the sheet's own `buildPayload` and the dock's own chips — not that a
// hand-picked set of names appears. A future field padSpec grows on any of
// these three actions fails here instead of shipping silently unreachable,
// which is the whole reason this lives beside the fidelity/reason/outcome
// mirrors above rather than as a one-off regression test.
//
// `answers` deliberately ignores every step's `when` — it answers ALL of a
// sheet's steps regardless of gating, because this test asks "CAN this path
// ever be set", not "does one particular wizard walk set it". The `minutes`
// step's own gating (permanent classes don't ask) has its own dedicated
// behavioural test, in section 4c below.
// ---------------------------------------------------------------------------

/** A shootout-CAPABLE variant, walked to the SHOOTOUT phase itself — never
 *  decided. Hockey's own default (`fih-outdoor`) has no shoot-out at all
 *  (`shippedVariantCfgs`'s `fih-shootout` is where FIH's lives), so the
 *  attempt claim below cannot share `livePhaseState(sport, cfg)` the way
 *  suspension/set-piece do. Same walk `"the shoot-out sheet folds"` (above)
 *  already uses. */
function reachShootout(sport: Sport): { cfg: unknown; state: PeriodStateLike } {
  const withShootout = shippedVariantCfgs(sport.module).find(({ cfg: c }) => (c as { shootout: unknown }).shootout !== null);
  expect(withShootout, `${sport.key} ships no shoot-out-capable variant`).toBeDefined();
  const cfg = withShootout!.cfg;
  const specs: Spec[] = [["core.start"]];
  for (let i = 0; i < 8; i += 1) {
    const s = foldPeriod(sport.module, cfg, specs);
    if (s.phase === "SHOOTOUT") break;
    const next = nextAdvanceOf(sport.module, s);
    if (next === null) break;
    specs.push([`${sport.key}.period.advance`, { to: next }]);
  }
  const state = foldPeriod(sport.module, cfg, specs);
  expect(state.phase, `${withShootout!.variant} never reached a shoot-out`).toBe("SHOOTOUT");
  return { cfg, state };
}

describe("a claimed action's sheet + dock reach every padSpec-declared field", () => {
  for (const sport of SPORTS) {
    const e = eventTypesOf(sport.spec);
    // Each claim resolves its OWN cfg/state — the shoot-out attempt is only
    // ever legal IN the SHOOTOUT phase, which needs a different cfg (and a
    // walk to reach) than the suspension/set-piece claims, which are legal
    // in any ordinary play phase and share the default cfg.
    const claims: readonly (readonly [label: string, sheetKey: string, type: string, resolve: () => { cfg: unknown; state: PeriodStateLike }])[] = [
      ["suspension start", "suspension-home", e.suspStart, () => ({ cfg: periodCfg(sport.module), state: livePhaseState(sport, periodCfg(sport.module)) })],
      ["shoot-out attempt", "attempt-home", e.attempt, () => reachShootout(sport)],
      ["set piece", SHEET_SET_PIECE, e.setPiece, () => ({ cfg: periodCfg(sport.module), state: livePhaseState(sport, periodCfg(sport.module)) })],
    ];

    for (const [label, sheetKey, type, resolve] of claims) {
      it(`${sport.key}: ${label} (${type})`, () => {
        const { cfg, state } = resolve();
        const view = viewFor(sport, cfg, state);
        const spec = (sport.module.padSpec as (c: unknown) => PadSpec)(cfg);
        const action = padActionFor(spec, type);
        expect(action, `padSpec declares no action for "${type}"`).toBeDefined();
        const declared = [...action!.fields.map((f) => f.path), ...action!.attribution.map((a) => a.path)];
        expect(declared.length, `${type}: padSpec declares nothing to check`).toBeGreaterThan(0);

        const sheet = sport.factory(T).sheets!(view)[sheetKey] as GuidedSheetSpec;
        expect(sheet, `no sheet at "${sheetKey}"`).toBeDefined();
        const answers: Record<string, string> = {};
        for (const step of sheet.steps) {
          if (step.kind === "choice") answers[step.id] = step.options[0]!.id;
          else if (step.kind === "person") answers[step.id] = (step.candidates ?? [])[0] ?? "";
          else answers[step.id] = String(step.initial);
        }
        const payload = sheet.buildPayload(answers);
        const dock = sport.factory(T).dock(type, view, payload);
        const reached = new Set(Object.keys(payload));
        for (const chip of dock?.chips ?? []) {
          for (const key of Object.keys(chip.mutate(payload))) reached.add(key);
        }
        for (const path of declared) {
          expect(
            reached.has(path),
            `${type}: padSpec declares "${path}"; neither the sheet nor the dock can set it`,
          ).toBe(true);
        }
        // …and the fold actually takes the fully-refined payload, so this is
        // not two mirrors agreeing about a shape the reducer would reject.
        let refined = payload;
        for (const chip of dock?.chips ?? []) refined = chip.mutate(refined);
        expect(phaseVerdict(sport.module, state, type, refined), `${sport.key}/${label}`).toBe("accepted");
      });
    }
  }
});

// ---------------------------------------------------------------------------
// 4c. The minutes step's own gating — a class with no numeric duration (the
// rest-of-the-match classes: hockey's red, ice hockey's game misconduct)
// does not ask, because `suspensions.ts`'s own derivation never reads
// `SuspensionDetail.minutes` for one (`minutes: null` on the class table IS
// the "for the rest of the match" signal — kernel/suspensions.ts's own doc).
// Every OTHER class asks, unconditionally: nothing in this codebase
// distinguishes a federation's fixed-by-rule duration (ice hockey's minor is
// always 2) from a discretionary one (an FIH yellow's own doc: "a MINIMUM of
// 5 minutes... the umpire may give 10"), so gating on anything narrower than
// "has this class got a number at all" would be inventing a rules fact this
// session has no source for — the same posture kernel.ts's own
// `suspensionReasons` doc takes.
// ---------------------------------------------------------------------------

describe("the minutes step asks for every class with a numeric duration, and none without one", () => {
  for (const sport of SPORTS) {
    it(`${sport.key}: skips the permanent class, asks every other one`, () => {
      const cfg = periodCfg(sport.module);
      const state = livePhaseState(sport, cfg);
      const view = viewFor(sport, cfg, state);
      const sheet = sport.factory(T).sheets!(view)["suspension-home"] as GuidedSheetSpec;
      const minutesStep = sheet.steps.find((s) => s.id === "minutes");
      expect(minutesStep, "no minutes step on the suspension sheet").toBeDefined();
      expect(minutesStep!.when, "the minutes step must gate on the chosen class").toBeDefined();

      const classes = (cfg as { suspensions: { classes: Record<string, { minutes: number | null }> } }).suspensions
        .classes;
      let sawPermanent = false;
      for (const [classKey, cls] of Object.entries(classes)) {
        const asks = minutesStep!.when!({ class: classKey });
        if (cls.minutes === null) {
          sawPermanent = true;
          expect(asks, `${classKey}: permanent, must not ask`).toBe(false);
        } else {
          expect(asks, `${classKey}: has a numeric duration, must ask`).toBe(true);
        }
      }
      expect(sawPermanent, `${sport.key}'s default cfg declares no permanent class to prove the gate with`).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 4d. R6 fix pass 4, finding 4 — the goalkeeper is the DEFENDING side, never
// the acting side's own roster. `dock()` does not gate on phase, so the
// ordinary live-phase view is enough to exercise both the attempt's and the
// set piece's goalkeeper chip; a shoot-out-phase view would test nothing this
// one does not.
// ---------------------------------------------------------------------------

describe("the goalkeeper chip pool is the OPPOSING side, never the acting side's own roster", () => {
  for (const sport of SPORTS) {
    it(`${sport.key}: attempt + set piece goalkeeper candidates never include a HOME-side player when HOME is acting`, () => {
      const cfg = periodCfg(sport.module);
      const state = livePhaseState(sport, cfg);
      const view = viewFor(sport, cfg, state);
      const homeIds = new Set(view.squads.home.members.map((m) => m.personId));
      const awayIds = new Set(view.squads.away.members.map((m) => m.personId));
      expect(homeIds.size, "fixture has no home roster to test with").toBeGreaterThan(0);
      expect(awayIds.size, "fixture has no away roster to test with").toBeGreaterThan(0);

      const e = eventTypesOf(sport.spec);
      const attemptDock = sport.factory(T).dock(e.attempt, view, { by: "H" })!;
      const attemptGoalkeepers = attemptDock.chips.filter((c) => c.id.startsWith("goalkeeper:"));
      expect(attemptGoalkeepers.length, "attempt dock offered no goalkeeper chips").toBeGreaterThan(0);
      for (const chip of attemptGoalkeepers) {
        const id = chip.id.slice("goalkeeper:".length);
        expect(homeIds.has(id), `${id}: attempt's goalkeeper drawn from the SHOOTING side`).toBe(false);
        expect(awayIds.has(id), `${id}: attempt's goalkeeper not on the defending roster at all`).toBe(true);
      }

      const setPieceDock = sport.factory(T).dock(e.setPiece, view, { by: "H" })!;
      const setPieceGoalkeepers = setPieceDock.chips.filter((c) => c.id.startsWith("goalkeeper:"));
      expect(setPieceGoalkeepers.length, "set piece dock offered no goalkeeper chips").toBeGreaterThan(0);
      for (const chip of setPieceGoalkeepers) {
        const id = chip.id.slice("goalkeeper:".length);
        expect(homeIds.has(id), `${id}: set piece's goalkeeper drawn from the AWARDED side`).toBe(false);
        expect(awayIds.has(id), `${id}: set piece's goalkeeper not on the defending roster at all`).toBe(true);
      }
    });
  }
});

describe("the minutes step and its own dedicated behavioural checks", () => {
  for (const sport of SPORTS) {
    it(`${sport.key}: a non-permanent minutes answer reaches the fold`, () => {
      const cfg = periodCfg(sport.module);
      const state = livePhaseState(sport, cfg);
      const view = viewFor(sport, cfg, state);
      const sheet = sport.factory(T).sheets!(view)["suspension-home"] as GuidedSheetSpec;
      const classes = (cfg as { suspensions: { classes: Record<string, { minutes: number | null }> } }).suspensions
        .classes;
      const [timedClass] = Object.entries(classes).find(([, cls]) => cls.minutes !== null)!;
      const payload = sheet.buildPayload({ class: timedClass, minutes: "7" });
      expect((payload as { minutes?: number }).minutes).toBe(7);
      expect(phaseVerdict(sport.module, state, sheet.event, payload), sport.key).toBe("accepted");
    });
  }
});

// ---------------------------------------------------------------------------
// 5. The card ladder — the wave's one real design divergence
// ---------------------------------------------------------------------------

describe("the discipline ladder", () => {
  it("hockey colours all THREE cards, green through the seventh sport token", () => {
    expect(hockeySpec.classes).toEqual({
      green: ["advisory"],
      yellow: ["caution"],
      red: ["dismissal"],
    });
    expect(SPORT_TONES).toContain("advisory");
    expect(SPORT_PALETTES.hockey?.advisory, "hockey's palette must paint the green card").toBeDefined();
  });

  it("ice hockey colours the ENDS only — the five middle classes are declared and uncoloured", () => {
    const coloured = Object.entries(icehockeySpec.classes).filter(([, tone]) => tone.length > 0);
    expect(coloured.map(([key]) => key)).toEqual(["minor", "match"]);
    expect(Object.keys(icehockeySpec.classes)).toHaveLength(7);
    // The IIHF has no green card, so this sport must never reach for `advisory`
    // — its palette does not declare one and would fall back to a colour it
    // never chose.
    expect(SPORT_PALETTES.icehockey?.advisory).toBeUndefined();
    for (const tone of Object.values(icehockeySpec.classes)) expect(tone).not.toContain("advisory");
  });

  it("every class the engine declares has a skin entry — both sports, every shipped variant", () => {
    for (const sport of SPORTS) {
      for (const { variant, cfg } of shippedVariantCfgs(sport.module)) {
        const classes = Object.keys((cfg as { suspensions: { classes: Record<string, unknown> } }).suspensions.classes);
        for (const classKey of classes) {
          expect(Object.keys(sport.spec.classes), `${sport.key}/${variant}: ${classKey}`).toContain(classKey);
        }
      }
    }
  });

  it("the class sheet carries a tone for a coloured class and NONE for a worded one", () => {
    const sport = SPORTS[1]!; // ice hockey — the only one with worded classes
    const cfg = periodCfg(sport.module);
    const state = livePhaseState(sport, cfg);
    const sheet = sport.factory(T).sheets!(viewFor(sport, cfg, state))["suspension-home"] as GuidedSheetSpec;
    const options = (sheet.steps[0] as { options: { id: string; tone?: readonly string[] }[] }).options;
    expect(options.find((o) => o.id === "minor")?.tone).toEqual(["caution"]);
    expect(options.find((o) => o.id === "match")?.tone).toEqual(["dismissal"]);
    expect(options.find((o) => o.id === "major")).toBeDefined();
    expect(options.find((o) => o.id === "major")?.tone).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Assists, the escalation hint, and the strip's committed facts
// ---------------------------------------------------------------------------

describe("what each sport's goal dock offers", () => {
  it("ice hockey offers assist chips once a scorer is named, capped at the engine's own two", () => {
    const sport = SPORTS[1]!;
    const cfg = periodCfg(sport.module);
    const state = livePhaseState(sport, cfg);
    const view = viewFor(sport, cfg, state);
    const scorer = view.squads.home.members.find((m) => m.onField)!.personId;
    const dock = sport.factory(T).dock(`${sport.key}.goal`, view, { by: "H", person: scorer })!;
    const assists = dock.chips.filter((c) => c.id.startsWith("assist:"));
    expect(assists.length).toBeGreaterThan(2);
    let payload: Record<string, unknown> = { by: "H", person: scorer };
    for (const chip of assists) payload = chip.mutate(payload);
    expect((payload.assists as string[]).length, "the dock must not exceed PeriodGoal.assists.max(2)").toBe(2);
    expect(phaseVerdict(sport.module, state, `${sport.key}.goal`, payload)).toBe("accepted");
  });

  it("hockey offers NONE — `assists: false`, and the fold refuses a non-empty array", () => {
    const sport = SPORTS[0]!;
    const cfg = periodCfg(sport.module);
    expect((cfg as { assists: boolean }).assists).toBe(false);
    const state = livePhaseState(sport, cfg);
    const view = viewFor(sport, cfg, state);
    const scorer = view.squads.home.members.find((m) => m.onField)!.personId;
    const dock = sport.factory(T).dock(`${sport.key}.goal`, view, { by: "H", person: scorer })!;
    expect(dock.chips.filter((c) => c.id.startsWith("assist:"))).toHaveLength(0);
    // …because the fold would refuse them.
    expect(phaseVerdict(sport.module, state, `${sport.key}.goal`, { by: "H", person: scorer, assists: [scorer] })).toBe(
      "other",
    );
  });

  it("every goal-dock chip's own mutate output still folds — kinds, own goal and empty net", () => {
    for (const sport of SPORTS) {
      const cfg = periodCfg(sport.module);
      const state = livePhaseState(sport, cfg);
      const view = viewFor(sport, cfg, state);
      const dock = sport.factory(T).dock(`${sport.key}.goal`, view, { by: "H" })!;
      for (const chip of dock.chips) {
        const payload = chip.mutate({ by: "H" });
        expect(phaseVerdict(sport.module, state, `${sport.key}.goal`, payload), `${sport.key}/${chip.id}`).toBe(
          "accepted",
        );
      }
      // The kind chips are the cfg's own list, minus the two the dock words
      // differently (`fg` is the default, `og` is the own-goal flag).
      const kinds = (cfg as { goalKinds: string[] }).goalKinds.filter((k) => k !== "fg" && k !== "og");
      expect(dock.chips.filter((c) => c.id.startsWith("kind:")).map((c) => c.id.slice(5))).toEqual(kinds);
    }
  });
});

describe("the FIH escalation hint — hockey's alone, and the S13 sentence reused", () => {
  const sport = SPORTS[0]!;
  const cfg = periodCfg(sport.module);
  const phase = () => firstPlayPhase(sport, cfg);

  function afterGreen(personId: string): PeriodStateLike {
    return foldPeriod(sport.module, cfg, [
      ["core.start"],
      ["hockey.suspension.start", { by: "H", person: personId, class: "green", at: { period: phase(), elapsed: 10 } }],
      ["hockey.suspension.end", { by: "H", person: personId, class: "green" }],
    ]);
  }

  it("the kernel publishes `escalate` for hockey and the dock swaps its title once that player is named", () => {
    const state = afterGreen("H-p2");
    const view = viewFor(sport, cfg, state);
    expect((summaryOf(sport.module, state) as { detail: { escalate: string[] } }).detail.escalate).toContain("H-p2");

    const plain = sport.factory(T).dock("hockey.suspension.start", view, { by: "H" })!;
    expect(plain.title).toBe("pad.hockey.dock.suspension.title");
    const escalating = sport.factory(T).dock("hockey.suspension.start", view, { by: "H", person: "H-p2" })!;
    expect(escalating.title, "the S13 sentence must be reused, never reminted").toBe("pad.pp.escalation");
    // A different player on the same side is NOT escalating.
    const other = sport.factory(T).dock("hockey.suspension.start", view, { by: "H", person: "H-p3" })!;
    expect(other.title).toBe("pad.hockey.dock.suspension.title");
  });

  it("ice hockey's summary carries no `escalate` at all, so its dock can never show the hint", () => {
    const ice = SPORTS[1]!;
    const iceCfg = periodCfg(ice.module);
    const state = foldPeriod(ice.module, iceCfg, [
      ["core.start"],
      ["icehockey.suspension.start", { by: "H", person: "H-p2", class: "minor" }],
    ]);
    expect((summaryOf(ice.module, state) as { detail: Record<string, unknown> }).detail.escalate).toBeUndefined();
    const dock = ice.factory(T).dock("icehockey.suspension.start", viewFor(ice, iceCfg, state), {
      by: "H",
      person: "H-p2",
    })!;
    expect(dock.title).toBe("pad.icehockey.dock.suspension.title");
  });
});

describe("the strip owns the two facts the chassis headline is the only surface for", () => {
  it("the shoot-out tally, per side AND named by its federation's own label", () => {
    const sport = SPORTS[1]!; // ice hockey — GWS
    const cfg = periodCfg(sport.module);
    const specs: Spec[] = [["core.start"]];
    for (let i = 0; i < 8; i += 1) {
      const s = foldPeriod(sport.module, cfg, specs);
      if (s.phase === "SHOOTOUT") break;
      const next = nextAdvanceOf(sport.module, s);
      if (next === null) break;
      specs.push(["icehockey.period.advance", { to: next }]);
    }
    specs.push(["icehockey.shootout.attempt", { by: "H", scored: true }]);
    specs.push(["icehockey.shootout.attempt", { by: "A", scored: false }]);
    const state = foldPeriod(sport.module, cfg, specs);
    const bug = sport.factory(T).scorebug(viewFor(sport, cfg, state));
    expect(bug.strip.find((i) => i.id === "shootout")?.value).toBe("1–0");
    expect(bug.strip.find((i) => i.id === "shootout")?.label).toBe("pad.icehockey.strip.shootout");
    expect(bug.halves[0].sub).toBe("(1)");
    expect(bug.halves[1].sub).toBe("(0)");
    expect(bug.strip.find((i) => i.id === "nextTaker")).toBeDefined();
  });

  it("the overtime decision, which otherwise exists only as `(OT)` in the chassis headline", () => {
    const sport = SPORTS[1]!;
    const cfg = periodCfg(sport.module);
    const specs: Spec[] = [["core.start"]];
    for (let i = 0; i < 8; i += 1) {
      const s = foldPeriod(sport.module, cfg, specs);
      if (String(s.phase).startsWith("OT")) break;
      const next = nextAdvanceOf(sport.module, s);
      if (next === null) break;
      specs.push(["icehockey.period.advance", { to: next }]);
    }
    const inOt = foldPeriod(sport.module, cfg, specs);
    expect(String(inOt.phase)).toMatch(/^OT/);
    // The phase item alone carries the LIVE overtime state…
    expect(sport.factory(T).scorebug(viewFor(sport, cfg, inOt)).strip[0]!.value).toBe(inOt.phase);
    // …and once it decides the match, a dedicated item carries the fact the
    // headline spells `(OT)`.
    const decided = foldPeriod(sport.module, cfg, [...specs, ["icehockey.goal", { by: "H" }]]);
    expect((decided.outcome as { method: string }).method).toBe("extra_time");
    expect(sport.factory(T).scorebug(viewFor(sport, cfg, decided)).strip.find((i) => i.id === "ot")).toBeDefined();
    expect(sport.factory(T).scorebug(viewFor(sport, cfg, inOt)).strip.find((i) => i.id === "ot")).toBeUndefined();
  });

  it("period, strength and box are ONE lit readout — the band's three machine values", () => {
    // A 320px read of the real board: the box countdown rendered as cream prose
    // beside two lit pills made the most urgent value on the band the quietest.
    // All three are machine readouts of the same state and are lit together.
    for (const sport of SPORTS) {
      const cfg = periodCfg(sport.module);
      const classKey = Object.keys(
        (cfg as { suspensions: { classes: Record<string, unknown> } }).suspensions.classes,
      )[0]!;
      const phase = firstPlayPhase(sport, cfg);
      const state = foldPeriod(sport.module, cfg, [
        ["core.start"],
        [
          `${sport.key}.suspension.start`,
          { by: "H", person: "H-p2", class: classKey, at: { period: phase, elapsed: 30 } },
        ],
      ]);
      const strip = sport.factory(T).scorebug(viewFor(sport, cfg, state)).strip;
      expect(strip.map((i) => i.id)).toEqual(["period", "strength", "box"]);
      for (const item of strip) expect(item.tone, `${sport.key}/${item.id}`).toBe("led");
    }
  });

  it("the set-piece tile is FULL WIDTH, so the optional release tile cannot strand it on half a row", () => {
    for (const sport of SPORTS) {
      const cfg = periodCfg(sport.module);
      const tiles = sport.factory(T).tiles(viewFor(sport, cfg, livePhaseState(sport, cfg)));
      expect(tiles.find((t2) => t2.id === SHEET_SET_PIECE)?.span).toBe(4);
      // Every other tile on the board is a half — the grid is two lanes of 2.
      for (const tile of tiles) {
        expect([2, 4], `${sport.key}/${tile.id}`).toContain(tile.span);
      }
    }
  });

  it("the strength chip is the KERNEL's, including ice hockey's inverted overtime advantage", () => {
    const sport = SPORTS[1]!;
    const cfg = periodCfg(sport.module);
    const state = foldPeriod(sport.module, cfg, [
      ["core.start"],
      ["icehockey.suspension.start", { by: "H", person: "H-p2", class: "minor" }],
    ]);
    const chip = sport.factory(T).scorebug(viewFor(sport, cfg, state)).strip.find((i) => i.id === "strength");
    // Regulation: the OFFENDER is short. 5 skaters becomes 4.
    expect(chip?.value).toBe("4v5");
    expect(chip?.value).toBe(
      (summaryOf(sport.module, state) as { detail: { strength: string } }).detail.strength,
    );
  });
});

// ---------------------------------------------------------------------------
// 6a. THE NUMBER ON THE PAD IS THE ENGINE'S OFFICIAL SCORE
//
// R6 fix pass 2, gap 1. The scorebug read `state.goals`, which is NOT the
// official score wherever `preset.shootoutWinnerGoal` is set: ice hockey
// credits the shoot-out winner a goal in the record (IIHF Rule 87 / NHL Rule
// 84.4), so a 2-2 match won on the shoot-out is RECORDED 3-2 while the fold's
// `goals` stay 2-2. `kernel.ts:2526` derives it ONCE (`officialScore`) and
// publishes it on both `headline` and `perSide`, precisely so the headline and
// the standings ledger cannot fork — and the pad had forked from both.
//
// Every fixture below folds the shoot-out THROUGH to a decided result, which is
// what the wave's original shoot-out tests never did: they stopped mid-attempt,
// where `officialScore` credits nothing and the two numbers agree by accident.
// ---------------------------------------------------------------------------

describe("the pad shows the ENGINE's official score, not the goals it happened to fold", () => {
  for (const sport of SPORTS) {
    it(`${sport.key}: a shoot-out folded to a DECIDED result puts the headline's own numbers on the pad`, () => {
      const { variant, cfg } = shootoutCfgOf(sport.module);
      const e = eventTypesOf(sport.spec);
      // A level match in PLAY, so the shoot-out is the only thing that can move
      // the record — and so a pad reading `state.goals` shows a DRAW.
      const { state } = decidedShootout(sport.module, cfg, [
        [e.goal, { by: "H" }],
        [e.goal, { by: "A" }],
      ]);
      expect(String(state.phase), variant).toBe("done");
      expect((state.outcome as { kind: string; method: string }).method).toBe("shootout");
      const goals = state.goals as { home: number; away: number };
      expect(goals.home, "the fixture is not level in play").toBe(goals.away);

      const summary = summaryOf(sport.module, state) as { headline: string };
      const headline = /^(\d+) — (\d+)/.exec(summary.headline);
      expect(headline, `unparseable headline "${summary.headline}"`).not.toBeNull();

      const bug = sport.factory(T).scorebug(viewFor(sport, cfg, state));
      expect(bug.halves[0]!.big, summary.headline).toBe(headline![1]);
      expect(bug.halves[1]!.big, summary.headline).toBe(headline![2]);
    });
  }

  it("both ends of `shootoutWinnerGoal` — ice hockey CREDITS the winner, field hockey deliberately does not", () => {
    // The fixture that proves the fixture. If the pad were still reading
    // `state.goals`, the field-hockey row below would pass unchanged — the two
    // presets share ONE kernel and differ only in this flag, so a test that ran
    // on field hockey alone could never see the defect at all.
    const rows = SPORTS.map((sport) => {
      const { cfg } = shootoutCfgOf(sport.module);
      const e = eventTypesOf(sport.spec);
      const { state } = decidedShootout(sport.module, cfg, [
        [e.goal, { by: "H" }],
        [e.goal, { by: "A" }],
      ]);
      const goals = state.goals as { home: number; away: number };
      const bug = sport.factory(T).scorebug(viewFor(sport, cfg, state));
      return { key: sport.key, goals, big: [bug.halves[0]!.big, bug.halves[1]!.big] as const };
    });

    const ice = rows.find((r) => r.key === "icehockey")!;
    // The WINNER's number is one ahead of the goals actually scored…
    expect(ice.big[0]).toBe(String(ice.goals.home + 1));
    expect(ice.big[0]).not.toBe(String(ice.goals.home));
    // …and the loser's is untouched.
    expect(ice.big[1]).toBe(String(ice.goals.away));

    const field = rows.find((r) => r.key === "hockey")!;
    // FIH has already paid for the shoot-out win in points, so moving GF/GD
    // would charge the same result twice (hockey/DOMAIN.md:67). The recorded
    // score stays the drawn one, and so does the pad's.
    expect(field.big[0]).toBe(String(field.goals.home));
    expect(field.big[1]).toBe(String(field.goals.away));
  });

  it("the pad's whole half — number AND shoot-out tally — reproduces `perSide.line` exactly", () => {
    // The kernel renders one string per side, `${official}${tally ? ` (${n})` : ""}`
    // (kernel.ts:2541). The pad splits it across `big` and `sub` and reads the
    // tally from `detail.shootout`; if those two ever came from different
    // places, this is where it would show.
    for (const sport of SPORTS) {
      const { cfg } = shootoutCfgOf(sport.module);
      const e = eventTypesOf(sport.spec);
      const { state } = decidedShootout(sport.module, cfg, [[e.goal, { by: "H" }], [e.goal, { by: "A" }]]);
      const summary = summaryOf(sport.module, state) as { perSide: { entrantId: string; line: string }[] };
      const bug = sport.factory(T).scorebug(viewFor(sport, cfg, state));
      const entrants = state.entrants as { home: string; away: string };
      for (const [index, side] of (["home", "away"] as const).entries()) {
        const line = summary.perSide.find((r) => r.entrantId === entrants[side])!.line;
        const half = bug.halves[index]!;
        expect(`${half.big}${half.sub === undefined ? "" : ` ${half.sub}`}`, `${sport.key}/${side}`).toBe(line);
      }
    }
  });

  it("falls back to the folded goals when the summary carries no side rows at all", () => {
    // `PadHostView.summary` is `unknown` — the host hands `pipeline.summary`
    // through without a schema. A summary with no `perSide` must not render a
    // blank or a zero: the pre-fix reading is the honest failure, right
    // everywhere except a credited shoot-out. (Mutation target: without this,
    // the fallback arm is unreachable and any value would survive.)
    const sport = SPORTS[1]!;
    const cfg = periodCfg(sport.module);
    const state = livePhaseState(sport, cfg, [["icehockey.goal", { by: "H" }], ["icehockey.goal", { by: "H" }]]);
    const bug = sport.factory(T).scorebug({ ...viewFor(sport, cfg, state), summary: {} });
    expect(bug.halves[0]!.big).toBe("2");
    expect(bug.halves[1]!.big).toBe("0");
  });

  it("an UNDECIDED shoot-out credits nothing — the pad and the fold still agree mid-attempt", () => {
    // `officialScore` is gated on the DECIDED outcome, so the pad must not run
    // ahead of it. This is the case the wave's original test covered, kept so
    // the fix cannot overshoot into crediting a goal the engine has not.
    const sport = SPORTS[1]!; // ice hockey — the sport that credits at all
    const { cfg } = shootoutCfgOf(sport.module);
    const { specs } = decidedShootout(sport.module, cfg);
    const midway = foldPeriod(sport.module, cfg, specs.slice(0, -1));
    expect(String(midway.phase), "the fixture is no longer mid-shoot-out").toBe("SHOOTOUT");
    const goals = midway.goals as { home: number; away: number };
    const bug = sport.factory(T).scorebug(viewFor(sport, cfg, midway));
    expect(bug.halves[0]!.big).toBe(String(goals.home));
    expect(bug.halves[1]!.big).toBe(String(goals.away));
  });
});

// ---------------------------------------------------------------------------
// 6b. The penalty box, and the four guards a mutation sweep found untested
// ---------------------------------------------------------------------------

describe("the box's countdown says only what it can honestly say", () => {
  const sport = SPORTS[0]!; // hockey — the only sport with a PERMANENT class
  const cfg = periodCfg(sport.module);

  it("a PERMANENT card shows the rest-of-match word, even when the umpire awarded minutes", () => {
    // `expiryOf` derives an expiry from `payload.minutes ?? cls.minutes`, so a
    // red card carrying the umpire's own five minutes DOES get an `expiresAt`
    // — the team is back to full strength then. The PLAYER never returns, so a
    // countdown beside their name would be a lie about the person even while
    // it is true about the side.
    const phase = firstPlayPhase(sport, cfg);
    const state = foldPeriod(sport.module, cfg, [
      ["core.start"],
      ["hockey.suspension.start", { by: "H", person: "H-p2", class: "red", minutes: 5, at: { period: phase, elapsed: 60 } }],
    ]);
    const susp = (state.suspensions as { permanent: boolean; expiresAt?: unknown }[])[0]!;
    expect(susp.permanent, "the fixture is not a permanent card").toBe(true);
    expect(susp.expiresAt, "the fixture has no expiry to be tempted by").toBeDefined();

    const view = viewFor(sport, cfg, state);
    expect(boxOf(view)[0]!.remaining).toBeNull();
    const item = sport.factory(T).scorebug(view).strip.find((i) => i.id === "box");
    expect(item?.value).toBe("pad.hockey.strip.permanent");
    expect(item?.value).not.toMatch(/\d:\d{2}/);
  });

  it("a card whose time runs into the NEXT period counts down only once the fold is in that period", () => {
    // 14:00 of a fifteen-minute quarter plus a two-minute green: `expiryOf`
    // carries the remainder into the next period rather than clipping it.
    const first = firstPlayPhase(sport, cfg);
    const carded: Spec[] = [
      ["core.start"],
      ["hockey.suspension.start", { by: "H", person: "H-p2", class: "green", at: { period: first, elapsed: 840 } }],
    ];
    const beforeWhistle = foldPeriod(sport.module, cfg, carded);
    const expiry = (beforeWhistle.suspensions as { expiresAt: { period: string; elapsed: number } }[])[0]!.expiresAt;
    expect(expiry.period, "the fixture no longer straddles a whistle").not.toBe(first);

    const next = nextAdvanceOf(sport.module, beforeWhistle)!;
    const afterWhistle = foldPeriod(sport.module, cfg, [...carded, ["hockey.period.advance", { to: next }]]);
    expect(afterWhistle.suspensions, "the whistle swept a card that had not run out").toHaveLength(1);
    // `state.asOf` still names the CLOSED period. Subtracting across the
    // whistle would print a number that is arithmetic on two different clocks.
    expect(boxOf(viewFor(sport, cfg, afterWhistle))[0]!.remaining).toBeNull();
    // CORRECTED, R6 fix pass 2 gap 3. This line used to assert the box item was
    // absent altogether, which pinned the defect rather than the rule: carrying
    // over is the NORMAL case for a card late in a period, and the pad went
    // quiet about a player who was still serving until something was stamped in
    // the new period. "No countdown" was right; "no row" was not.
    const carriedOver = sport.factory(T).scorebug(viewFor(sport, cfg, afterWhistle)).strip.find((i) => i.id === "box");
    expect(carriedOver, "the carried-over card vanished from the band").toBeDefined();
    expect(carriedOver!.value).toBe("pad.hockey.class.green");
    expect(carriedOver!.value).not.toMatch(/\d+:\d{2}/);

    // Once a STAMPED event lands in the new period, the two agree again.
    const inNext = foldPeriod(sport.module, cfg, [
      ...carded,
      ["hockey.period.advance", { to: next }],
      ["hockey.goal", { by: "A", at: { period: expiry.period, elapsed: expiry.elapsed - 20 } }],
    ]);
    expect(boxOf(viewFor(sport, cfg, inNext))[0]!.remaining).toBe(20);
    expect(sport.factory(T).scorebug(viewFor(sport, cfg, inNext)).strip.find((i) => i.id === "box")?.value).toBe("0:20");
  });
});

describe("the box countdown counts DOWN — against the host's live clock, not the last thing recorded", () => {
  // R6 fix pass 2, gap 2. `state.asOf` moves only when an event is STAMPED, so
  // a countdown measured against it stands still through every second of play
  // in which nothing happened — which is most of them, and all of the ones a
  // scorer is watching the box for. Commit 0909063bf lit this as the band's
  // "most urgent number" and it never changed.
  //
  // Every `clockAt` below comes out of the REAL host derivation — `stampOf` on
  // a clock built by `initClock`/`startClock` — never a hand-written literal,
  // because it is the same function `pad-host.tsx`'s `send` gateway stamps
  // with and a literal would prove only this test's own arithmetic.
  const sport = SPORTS[0]!; // hockey
  const cfg = periodCfg(sport.module);
  const T0 = 1_700_000_000_000;

  /** The view the host would build `secondsIn` seconds into the period, with a
   *  clock a scorer started at the whistle. */
  function viewAt(state: PeriodStateLike, period: string, secondsIn: number): PadHostView {
    const running = startClock(initClock(period, 0), T0);
    return { ...viewFor(sport, cfg, state), clockAt: stampOf(running, T0 + secondsIn * 1000) };
  }

  function boxValue(view: PadHostView): string | undefined {
    return sport.factory(T).scorebug(view).strip.find((i) => i.id === "box")?.value;
  }

  it("the SAME state, with no event stamped, shows a smaller number as the host clock advances", () => {
    const phase = firstPlayPhase(sport, cfg);
    const state = foldPeriod(sport.module, cfg, [
      ["core.start"],
      ["hockey.suspension.start", { by: "H", person: "H-p2", class: "green", at: { period: phase, elapsed: 60 } }],
    ]);
    const expiry = (state.suspensions as { expiresAt: { period: string; elapsed: number } }[])[0]!.expiresAt;
    expect(expiry.period, "the fixture straddles a whistle").toBe(phase);

    // One state object, three readings. Nothing is folded in between: this is
    // exactly the two minutes of play in which a scorer records nothing.
    expect(boxOf(viewAt(state, phase, 60))[0]!.remaining).toBe(expiry.elapsed - 60);
    expect(boxOf(viewAt(state, phase, 100))[0]!.remaining).toBe(expiry.elapsed - 100);
    expect(boxOf(viewAt(state, phase, 140))[0]!.remaining).toBe(expiry.elapsed - 140);

    const readings = [60, 100, 140].map((s) => boxValue(viewAt(state, phase, s)));
    expect(new Set(readings).size, `the band never moved: ${readings.join(" / ")}`).toBe(3);
    for (const reading of readings) expect(reading).toMatch(/^\d+:\d{2}$/);
    // …and it is strictly decreasing, not merely different.
    expect(boxOf(viewAt(state, phase, 100))[0]!.remaining!).toBeLessThan(boxOf(viewAt(state, phase, 60))[0]!.remaining!);
  });

  it("reaches 0:00 while the ENGINE still holds the suspension — the lazy sweep is not to be `fixed` from here", () => {
    const phase = firstPlayPhase(sport, cfg);
    const state = foldPeriod(sport.module, cfg, [
      ["core.start"],
      ["hockey.suspension.start", { by: "H", person: "H-p2", class: "green", at: { period: phase, elapsed: 60 } }],
    ]);
    const expiry = (state.suspensions as { expiresAt: { elapsed: number } }[])[0]!.expiresAt;
    const past = viewAt(state, phase, expiry.elapsed + 45);
    expect(boxOf(past)[0]!.remaining, "the countdown went negative").toBe(0);
    expect(boxValue(past)).toBe("0:00");
    // The fold has NOT released them — release is swept at the next stamped
    // event (kernel.ts:842-843). The display and the state disagreeing here is
    // the documented behaviour, not a bug to close by writing back.
    expect(state.suspensions).toHaveLength(1);
  });

  it("a live clock in ANOTHER period is not subtracted across the whistle", () => {
    const first = firstPlayPhase(sport, cfg);
    const carded: Spec[] = [
      ["core.start"],
      ["hockey.suspension.start", { by: "H", person: "H-p2", class: "green", at: { period: first, elapsed: 840 } }],
    ];
    const beforeWhistle = foldPeriod(sport.module, cfg, carded);
    const next = nextAdvanceOf(sport.module, beforeWhistle)!;
    const afterWhistle = foldPeriod(sport.module, cfg, [...carded, ["hockey.period.advance", { to: next }]]);
    const expiry = (afterWhistle.suspensions as { expiresAt: { period: string } }[])[0]!.expiresAt;

    // The scorer has restarted the clock in the CLOSED period's successor…
    const inFirstAgain = viewAt(afterWhistle, first, 30);
    expect(expiry.period, "the fixture no longer straddles a whistle").not.toBe(first);
    expect(boxOf(inFirstAgain)[0]!.remaining, "subtracted two different clocks").toBeNull();
    // …and once the live clock IS in the expiry's own period, the number is back.
    expect(boxOf(viewAt(afterWhistle, expiry.period, 10))[0]!.remaining).not.toBeNull();
  });

  it("falls back to the fold's own stamp when the host offers no live clock", () => {
    // A pad nobody has started and whose fold left no stamp in this period is a
    // clock that has never been told the time (`PadClock.known`), and the host
    // says nothing rather than offering its placeholder zero.
    const phase = firstPlayPhase(sport, cfg);
    const state = foldPeriod(sport.module, cfg, [
      ["core.start"],
      ["hockey.suspension.start", { by: "H", person: "H-p2", class: "green", at: { period: phase, elapsed: 60 } }],
    ]);
    expect(stampOf(initClock(phase), T0 + 90_000), "an unknown clock spoke").toBeUndefined();
    const view = { ...viewFor(sport, cfg, state), clockAt: stampOf(initClock(phase), T0 + 90_000) };
    const expiry = (state.suspensions as { expiresAt: { elapsed: number } }[])[0]!.expiresAt;
    // `state.asOf` is the card's own stamp, 60s in — the pre-fix reading.
    expect(boxOf(view)[0]!.remaining).toBe(expiry.elapsed - 60);
  });
});

describe("R6 fix pass 4, finding 3 — a PAUSED clock must not out-rank a LATER fold stamp", () => {
  // `view.clockAt ?? state.asOf` used to prefer the pad clock even while
  // PAUSED, and `reseatClock` only re-seeds on a period change — so a pad
  // mounted mid-period, paused, never started, could sit on a stale reading
  // forever while ANOTHER device kept recording. The fix (`laterAsOf`,
  // ../skins/period-shared.ts) takes whichever of the two is LATER within
  // the same period, so a stale paused reading can only ever be corrected
  // UP, never trusted past what the fold already knows happened.
  const sport = SPORTS[0]!; // hockey
  const cfg = periodCfg(sport.module);
  const T0 = 1_700_000_555_000;

  it("takes the LATER fold stamp over a stale PAUSED clock — the reported scenario, verbatim", () => {
    // Mount mid-period paused, never start it — a yellow card (5-minute
    // nominal) started at 0:10 expires at 5:10 (310s), so both readings
    // below stay inside its active window and the lazy sweep does not
    // release it out from under the assertion.
    const phase = firstPlayPhase(sport, cfg);
    const paused = initClock(phase, 100);
    const staleClockAt = stampOf(paused, T0)!;
    expect(staleClockAt).toEqual({ period: phase, elapsed: 100 });

    // …let ANOTHER device push `state.asOf` forward, past the stale clock's
    // own reading, by recording a goal — hockey's yellow class carries no
    // `releaseOnGoal`, so the goal cannot itself change the suspension's
    // `expiresAt`; only `asOf` moves.
    const state = foldPeriod(sport.module, cfg, [
      ["core.start"],
      ["hockey.suspension.start", { by: "H", person: "H-p2", class: "yellow", at: { period: phase, elapsed: 10 } }],
      ["hockey.goal", { by: "A", at: { period: phase, elapsed: 250 } }],
    ]);
    expect((state.asOf as { elapsed: number }).elapsed, "the fold's own stamp must be the later one").toBe(250);
    expect(state.suspensions, "the sweep released it before the assertion could run").toHaveLength(1);

    const view = { ...viewFor(sport, cfg, state), clockAt: staleClockAt };
    const expiry = (state.suspensions as { expiresAt: { elapsed: number } }[])[0]!.expiresAt;
    // Measured against the FRESHER stamp (250s), not the stale paused clock
    // (100s): the pre-fix reading would have been `expiry.elapsed - 100`,
    // 150s MORE box time than the kernel will actually serve.
    const wrongPreFixReading = expiry.elapsed - 100;
    const remaining = boxOf(view)[0]!.remaining;
    expect(remaining, "reported MORE box time than the kernel will serve").toBe(Math.max(0, expiry.elapsed - 250));
    expect(remaining, "regressed to the stale pre-fix reading").not.toBe(wrongPreFixReading);
  });

  it("still prefers the LIVE clock while it is genuinely ahead of the fold — the running case is unchanged", () => {
    const phase = firstPlayPhase(sport, cfg);
    const state = foldPeriod(sport.module, cfg, [
      ["core.start"],
      ["hockey.suspension.start", { by: "H", person: "H-p2", class: "green", at: { period: phase, elapsed: 60 } }],
    ]);
    const running = startClock(initClock(phase, 60), T0);
    const clockAt = stampOf(running, T0 + 40_000)!; // 100s — ahead of the fold's own 60s stamp
    expect(clockAt.elapsed).toBe(100);
    const view = { ...viewFor(sport, cfg, state), clockAt };
    const expiry = (state.suspensions as { expiresAt: { elapsed: number } }[])[0]!.expiresAt;
    expect(boxOf(view)[0]!.remaining).toBe(expiry.elapsed - 100);
  });

  it("a cross-period mismatch still prefers clockAt, unchanged from before this fix", () => {
    // laterAsOf only compares WITHIN a period; a different period is not
    // "earlier or later", it is incomparable, and boxOf's own
    // `expires.period !== asOf.period` guard already turns that into `null`.
    const phase = firstPlayPhase(sport, cfg);
    const state = foldPeriod(sport.module, cfg, [
      ["core.start"],
      ["hockey.suspension.start", { by: "H", person: "H-p2", class: "green", at: { period: phase, elapsed: 60 } }],
    ]);
    const clockAt = { period: "SOME-OTHER-PHASE", elapsed: 5 };
    const view = { ...viewFor(sport, cfg, state), clockAt };
    // Neither reading names the suspension's own period, so there is no
    // countdown either way — the assertion is that this does not throw and
    // resolves to the same `null` the pre-fix code already gave it.
    expect(boxOf(view)[0]!.remaining).toBeNull();
  });
});

describe("nobody serving a suspension is ever missing from the strip", () => {
  // R6 fix pass 2, gap 3. A box occupant the pad cannot count down for used to
  // be dropped from the band ENTIRELY, so a scorer read `Q2 · 5v4` with nothing
  // to say who was off — while somebody was actually serving. Carrying over is
  // the NORMAL case for a card late in a period, and an unstamped card never
  // gets an expiry at all, so both are ordinary rather than exotic.
  //
  // The item carries the class WORD, never a number: minutes across a whistle
  // are arithmetic on two clocks (`sweepThroughPhase` is the kernel's), and a
  // card with no expiry has no arithmetic to do at all.
  const sport = SPORTS[0]!; // hockey — the green card carries over cleanly
  const cfg = periodCfg(sport.module);

  it("a card whose time runs into the NEXT period still names itself, with no number", () => {
    const first = firstPlayPhase(sport, cfg);
    const carded: Spec[] = [
      ["core.start"],
      ["hockey.suspension.start", { by: "H", person: "H-p2", class: "green", at: { period: first, elapsed: 840 } }],
    ];
    const beforeWhistle = foldPeriod(sport.module, cfg, carded);
    const expiry = (beforeWhistle.suspensions as { expiresAt: { period: string } }[])[0]!.expiresAt;
    expect(expiry.period, "the fixture no longer straddles a whistle").not.toBe(first);

    const next = nextAdvanceOf(sport.module, beforeWhistle)!;
    const afterWhistle = foldPeriod(sport.module, cfg, [...carded, ["hockey.period.advance", { to: next }]]);
    expect(afterWhistle.suspensions, "the whistle swept a card that had not run out").toHaveLength(1);

    const strip = sport.factory(T).scorebug(viewFor(sport, cfg, afterWhistle)).strip;
    // The strength chip says a side is short…
    expect(strip.find((i) => i.id === "strength")?.value).toBe("10v11");
    // …so the box row must say who, and must not invent a countdown.
    const box = strip.find((i) => i.id === "box");
    expect(box, "somebody is serving and the band says nothing about it").toBeDefined();
    expect(box!.value).toBe("pad.hockey.class.green");
    expect(box!.value).not.toMatch(/\d+:\d{2}/);
    expect(box!.tone).toBe("led");
  });

  it("an UNSTAMPED card names itself too — it has no expiry, so it never gets a number at all", () => {
    const unstamped = foldPeriod(sport.module, cfg, [
      ["core.start"],
      ["hockey.suspension.start", { by: "H", person: "H-p2", class: "yellow" }],
    ]);
    expect((unstamped.suspensions as { expiresAt?: unknown }[])[0]!.expiresAt).toBeUndefined();
    const box = sport.factory(T).scorebug(viewFor(sport, cfg, unstamped)).strip.find((i) => i.id === "box");
    expect(box, "an unstamped card left the band silent").toBeDefined();
    expect(box!.value).toBe("pad.hockey.class.yellow");
    expect(box!.value).not.toMatch(/\d+:\d{2}/);
  });

  it("a countdown, where one exists, still wins over the word", () => {
    // The three arms in priority order: a real countdown beats the rest-of-match
    // word, which beats the bare class word.
    const phase = firstPlayPhase(sport, cfg);
    const state = foldPeriod(sport.module, cfg, [
      ["core.start"],
      ["hockey.suspension.start", { by: "H", person: "H-p2", class: "green", at: { period: phase, elapsed: 30 } }],
      ["hockey.suspension.start", { by: "A", person: "A-p2", class: "yellow" }],
    ]);
    expect(boxOf(viewFor(sport, cfg, state))).toHaveLength(2);
    const box = sport.factory(T).scorebug(viewFor(sport, cfg, state)).strip.find((i) => i.id === "box");
    expect(box!.value).toMatch(/^\d+:\d{2}$/);
  });
});

describe("the release sheet ends the suspension the scorer actually picked", () => {
  it("names the CARDED side, not a default — the fold refuses an end event aimed at the wrong entrant", () => {
    const sport = SPORTS[1]!;
    const cfg = periodCfg(sport.module);
    // AWAY only, deliberately: a payload that fell back to the home entrant
    // would fold on a home-carded fixture and hide itself.
    const carded: Spec[] = [
      ["core.start"],
      ["icehockey.suspension.start", { by: "A", person: "A-p2", class: "minor" }],
    ];
    const state = foldPeriod(sport.module, cfg, carded);
    const view = viewFor(sport, cfg, state);
    const sheet = sport.factory(T).sheets!(view)[SHEET_RELEASE] as GuidedSheetSpec;
    const option = (sheet.steps[0] as { options: { id: string }[] }).options[0]!;
    const payload = sheet.buildPayload({ target: option.id });
    expect(payload.by).toBe((state.entrants as { away: string }).away);
    expect(payload.person).toBe("A-p2");
    expect(payload.class).toBe("minor");
    expect(phaseVerdict(sport.module, state, sheet.event, payload)).toBe("accepted");
    // …and the wrong side really is refused, which is what makes the line above
    // an assertion rather than a coincidence.
    expect(
      phaseVerdict(sport.module, state, sheet.event, { by: (state.entrants as { home: string }).home }),
    ).not.toBe("accepted");
  });
});

describe("the shoot-out tile disables the side whose turn it is not", () => {
  it("follows the kernel's own alternation, which refuses an out-of-turn attempt outright", () => {
    const sport = SPORTS[1]!;
    const cfg = periodCfg(sport.module);
    const specs: Spec[] = [["core.start"]];
    for (let i = 0; i < 8; i += 1) {
      const s = foldPeriod(sport.module, cfg, specs);
      if (s.phase === "SHOOTOUT") break;
      const next = nextAdvanceOf(sport.module, s);
      if (next === null) break;
      specs.push(["icehockey.period.advance", { to: next }]);
    }
    const check = (state: PeriodStateLike, expected: "home" | "away") => {
      const view = viewFor(sport, cfg, state);
      const tiles = sport.factory(T).tiles(view);
      const other = expected === "home" ? "away" : "home";
      expect(tiles.find((t2) => t2.id === `attempt-${expected}`)?.disabled).toBeUndefined();
      expect(tiles.find((t2) => t2.id === `attempt-${other}`)?.disabled, `${other} should be disabled`).toBe(true);
      // The disabled side is not merely greyed: the fold would refuse it.
      const sheet = sport.factory(T).sheets!(view)[`attempt-${other}`] as GuidedSheetSpec;
      expect(phaseVerdict(sport.module, state, sheet.event, sheet.buildPayload({ outcome: "scored" }))).toBe("other");
    };
    // AT THE START, NEITHER IS DISABLED — and that is the engine's rule, not a
    // gap. `expectedKicker([])` returns null ("either side may start",
    // `period/shootout.ts:80-81`) and `applyShootoutAttempt` only refuses once
    // an order exists, so a pad that greyed one side here would be inventing an
    // alternation the kernel does not have.
    const opening = foldPeriod(sport.module, cfg, specs);
    const openingView = viewFor(sport, cfg, opening);
    for (const side of ["home", "away"] as const) {
      expect(sport.factory(T).tiles(openingView).find((t2) => t2.id === `attempt-${side}`)?.disabled).toBeUndefined();
      const sheet = sport.factory(T).sheets!(openingView)[`attempt-${side}`] as GuidedSheetSpec;
      expect(phaseVerdict(sport.module, opening, sheet.event, sheet.buildPayload({ outcome: "scored" })), side).toBe(
        "accepted",
      );
    }
    // Once the first attempt fixes the order, the pad follows it — both ways.
    check(foldPeriod(sport.module, cfg, [...specs, ["icehockey.shootout.attempt", { by: "H", scored: true }]]), "away");
    check(
      foldPeriod(sport.module, cfg, [
        ...specs,
        ["icehockey.shootout.attempt", { by: "A", scored: true }],
      ]),
      "home",
    );
  });
});

describe("the swap slot is offered only where a line change is recordable", () => {
  for (const sport of SPORTS) {
    it(`${sport.key}: band 2 and a play phase, and nothing else`, () => {
      const cfg = periodCfg(sport.module);
      const live = livePhaseState(sport, cfg);

      for (const band of [0, 1] as const) {
        const view = viewFor(sport, cfg, live, band);
        expect(sport.factory(T).swap!(view), `band ${band} offers a slot`).toEqual([]);
        expect(sport.factory(T).tiles(view).map((t2) => t2.id)).not.toContain("sub-home");
      }
      const ok = viewFor(sport, cfg, live, 2);
      expect(sport.factory(T).swap!(ok)).toHaveLength(2);
      expect(sport.factory(T).tiles(ok).map((t2) => t2.id)).toContain("sub-home");

      // Before the first whistle, and after the last, there is no line to change.
      const pre = viewFor(sport, cfg, foldPeriod(sport.module, cfg, []), 3);
      expect(sport.factory(T).swap!(pre)).toEqual([]);
      const done = foldedPhases(sport.module).find((row) => row.phase === "done")!;
      expect(sport.factory(T).swap!(viewFor(sport, done.cfg, done.state, 3))).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// 7. Tiles offer nothing the fold refuses, at every band
// ---------------------------------------------------------------------------

describe("no tile is ever drawn for something the fold would refuse", () => {
  for (const sport of SPORTS) {
    it(`${sport.key}: every band, every reachable phase`, () => {
      for (const row of foldedPhases(sport.module)) {
        for (const band of [0, 1, 2, 3] as const) {
          const view = viewFor(sport, row.cfg, row.state, band);
          const skin = sport.factory(T);
          const bands = bandsOf(sport.spec);
          for (const tile of skin.tiles(view)) {
            if (tile.disabled === true) continue;
            if (!("event" in tile.action)) continue;
            const type = tile.action.event.type;
            expect(bands[type], `${row.label}/b${band}: ${type} above band`).toBeLessThanOrEqual(band);
            expect(
              phaseVerdict(sport.module, row.state, type, tile.action.event.payload),
              `${row.label}/b${band}: tile ${tile.id}`,
            ).toBe("accepted");
          }
        }
      }
    });

    it(`${sport.key}: the release tile appears only while somebody is releasable`, () => {
      const cfg = periodCfg(sport.module);
      const state = livePhaseState(sport, cfg);
      const empty = sport.factory(T).tiles(viewFor(sport, cfg, state));
      expect(empty.map((t2) => t2.id)).not.toContain("release");

      const classKey = Object.keys(
        (cfg as { suspensions: { classes: Record<string, SuspensionClassLike> } }).suspensions.classes,
      ).find(
        (k) =>
          (cfg as { suspensions: { classes: Record<string, SuspensionClassLike> } }).suspensions.classes[k]!
            .permanent !== true,
      )!;
      const carded = foldPeriod(sport.module, cfg, [
        ["core.start"],
        [`${sport.key}.suspension.start`, { by: "H", person: "H-p2", class: classKey }],
      ]);
      expect(sport.factory(T).tiles(viewFor(sport, cfg, carded)).map((t2) => t2.id)).toContain("release");

      // A PERMANENT card is not releasable — `applySuspensionEnd` skips it — so
      // the tile must stay away.
      const permanentKey = Object.keys(
        (cfg as { suspensions: { classes: Record<string, SuspensionClassLike> } }).suspensions.classes,
      ).find(
        (k) =>
          (cfg as { suspensions: { classes: Record<string, SuspensionClassLike> } }).suspensions.classes[k]!
            .permanent === true,
      );
      if (permanentKey !== undefined) {
        const sentOff = foldPeriod(sport.module, cfg, [
          ["core.start"],
          [`${sport.key}.suspension.start`, { by: "H", person: "H-p3", class: permanentKey }],
        ]);
        const view = viewFor(sport, cfg, sentOff);
        expect(releasableBox(view)).toHaveLength(0);
        expect(sport.factory(T).tiles(view).map((t2) => t2.id)).not.toContain("release");
      }
    });
  }
});

interface SuspensionClassLike {
  permanent?: boolean;
}

// ---------------------------------------------------------------------------
// 8. Copy — every key these skins emit ships in all four locales
// ---------------------------------------------------------------------------

describe("every dictionary key the two skins can emit exists in all four locales", () => {
  const LOCALES = ["en", "es", "fr", "nl"] as const;
  const dicts = Object.fromEntries(
    LOCALES.map((locale) => [
      locale,
      JSON.parse(readFileSync(join(process.cwd(), `src/dictionaries/${locale}/ui.json`), "utf8")) as Record<
        string,
        string
      >,
    ]),
  ) as Record<(typeof LOCALES)[number], Record<string, string>>;

  /** Collect every key the skin actually passes to `t`, by handing it a
   *  recording translator and driving every builder over every folded phase. */
  function keysEmittedBy(sport: Sport): Set<string> {
    const keys = new Set<string>();
    const rec = (key: string, vars?: Record<string, string | number>): string => {
      keys.add(key);
      return vars === undefined ? key : `${key}!`;
    };
    for (const row of foldedPhases(sport.module)) {
      for (const band of [0, 2, 3] as const) {
        const view = viewFor(sport, row.cfg, row.state, band);
        const skin = sport.factory(rec as typeof T);
        skin.scorebug(view);
        const tiles = skin.tiles(view);
        for (const tile of tiles) {
          keys.add(tile.label);
          if (tile.sublabel !== undefined) keys.add(tile.sublabel);
        }
        const sheets = skin.sheets!(view);
        for (const sheet of Object.values(sheets)) {
          for (const step of sheet.steps) {
            keys.add(step.title);
            if (step.kind === "choice") for (const option of step.options) keys.add(option.label);
          }
        }
        for (const slot of skin.swap!(view)) {
          keys.add(slot.offLabel);
          keys.add(slot.onLabel);
        }
        for (const type of Object.keys(bandsOf(sport.spec))) {
          const dock = skin.dock(type, view, { by: (row.state.entrants as { home: string }).home });
          for (const chip of dock?.chips ?? []) keys.add(chip.label);
          const named = skin.dock(type, view, {
            by: (row.state.entrants as { home: string }).home,
            person: view.squads.home.members[0]?.personId,
          });
          for (const chip of named?.chips ?? []) keys.add(chip.label);
        }
      }
    }
    return keys;
  }

  for (const sport of SPORTS) {
    it(`${sport.key}: no key is missing, in any locale`, () => {
      const keys = [...keysEmittedBy(sport)].filter((k) => !k.includes("!"));
      expect(keys.length, "the collector visited nothing").toBeGreaterThan(20);
      for (const locale of LOCALES) {
        const missing = keys.filter((key) => dicts[locale][key] === undefined);
        expect(missing, `${locale} is missing ${missing.length} key(s)`).toEqual([]);
      }
    });

    it(`${sport.key}: its ribbon keys are registered in PAD_LABEL_KEYS, or the ribbon stays on the generic fallback`, async () => {
      const { PAD_LABEL_KEYS } = await import("@/lib/scoring-vocab");
      const { ribbonKeyFor } = await import("../ribbon");
      for (const type of Object.keys(bandsOf(sport.spec))) {
        const key = ribbonKeyFor(type);
        expect(PAD_LABEL_KEYS as readonly string[], `${type} -> ${key}`).toContain(key);
        for (const locale of LOCALES) expect(dicts[locale][key], `${locale}: ${key}`).toBeDefined();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 9. Registry — both sports flip to the v3 lane in the same change
// ---------------------------------------------------------------------------

describe("the registry flip", () => {
  it("both keys resolve to a v3 skin, from a FACTORY the registry never calls itself", async () => {
    const { V3_SKINS, LEGACY_SPORTS, resolvePad } = await import("../registry");
    for (const sport of SPORTS) {
      expect(typeof V3_SKINS[sport.key], `${sport.key} is not a factory`).toBe("function");
      expect(LEGACY_SPORTS.has(sport.key), `${sport.key} is double-owned`).toBe(false);
      const resolved = resolvePad(sport.key, T);
      expect(resolved.lane).toBe("v3");
      expect(resolved.lane === "v3" && resolved.skin.key).toBe(sport.key);
    }
  });

  it("both modules still exist in the engine under those exact keys", () => {
    expect(PERIOD_MODULES.map((m) => m.module.key)).toEqual(["hockey", "icehockey"]);
  });
});
