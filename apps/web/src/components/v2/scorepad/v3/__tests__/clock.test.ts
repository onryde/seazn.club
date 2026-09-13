// R6/task A — the pad-local match clock (owner ruling R6-4).
//
// TWO HALVES, and the second is the one that matters.
//
// The first half is `../clock`'s own arithmetic: pure data in, pure data out,
// mutation-checked. That half can only ever prove the module agrees with
// itself.
//
// The second half drives the stamp END TO END through the REAL football
// module — the real skin's real tile, the real `eventSchemas` entry, the real
// `foldMatch` — and then reads the result back out through the real skin's
// own scorebug. That is deliberate and it is the whole point of this file.
// `AGENTS.md`'s recurring-failure list opens with THE INERT SEAM: "code
// declared, typed and unit-green, but nothing in production ever sends or
// reads it. Recurred 6x... A seam is proven only by driving it through its
// REAL producer and consumer. A fixture on both ends proves the fixture."
// A clock whose stamp never reaches an engine would be the seventh.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { CORE_EVENT_SCHEMAS } from "@seazn/engine/core";
import {
  CLOCK_NUDGE_SECONDS,
  CLOCK_NUDGE_FINE_SECONDS,
  adjustClock,
  elapsedOf,
  formatClock,
  initClock,
  pauseClock,
  reseatClock,
  stampOf,
  stampPayload,
  startClock,
  toggleClock,
  type PadClock,
} from "../clock";
import { buildScorebug, footballSkinV3, readClock } from "../skins/football";
import { PadClockBar, stampFor } from "../pad-host";
import type { PadHostView } from "../types";
import { foldFootball, footballCfg } from "./_football-fold";

const T0 = 1_700_000_000_000; // a fixed wall-clock origin; nothing reads Date.now()

// ---------------------------------------------------------------------------
// 1. The arithmetic
// ---------------------------------------------------------------------------

describe("a pad clock counts GAME seconds, and only while it runs", () => {
  it("seats PAUSED at its seed — the pad cannot know whether play is running when it mounts", () => {
    const clock = initClock("H1", 761);
    expect(clock.runningSince).toBeNull();
    expect(elapsedOf(clock, T0)).toBe(761);
    // Ten minutes of wall time pass with nobody tapping Start. The clock has
    // not moved, which is the assertion that says this is not a
    // "wall time since the period began" clock.
    expect(elapsedOf(clock, T0 + 600_000)).toBe(761);
  });

  it("advances with wall time while running, and STOPS DEAD on pause — the stop-clock rule", () => {
    const running = startClock(initClock("P1"), T0);
    expect(elapsedOf(running, T0 + 30_000)).toBe(30);
    const paused = pauseClock(running, T0 + 30_000);
    // Eight minutes of injury delay. `core/time.ts` §1.2: a minor started at
    // 761 expires at 881 whether or not that delay intervened, because penalty
    // time only runs while play runs.
    expect(elapsedOf(paused, T0 + 30_000 + 480_000)).toBe(30);
    // ...and resuming banks what came before rather than restarting.
    const resumed = startClock(paused, T0 + 510_000);
    expect(elapsedOf(resumed, T0 + 510_000 + 15_000)).toBe(45);
  });

  it("floors to whole seconds and never goes negative, even when the system clock jumps backwards", () => {
    const running = startClock(initClock("H1"), T0);
    expect(elapsedOf(running, T0 + 1999)).toBe(1); // floor, not round
    // An NTP correction mid-period. `DurationSeconds` is int().nonnegative();
    // a negative elapsed would take the whole event down at the fold.
    expect(elapsedOf(running, T0 - 60_000)).toBe(0);
    expect(initClock("H1", -5).base).toBe(0);
    expect(initClock("H1", 12.9).base).toBe(12);
    expect(initClock("H1", Number.NaN).base).toBe(0);
  });

  it("ignores a second Start and a second Pause, so a double tap cannot lose banked seconds", () => {
    const running = startClock(initClock("H1"), T0);
    expect(startClock(running, T0 + 20_000)).toBe(running); // by reference
    const paused = pauseClock(running, T0 + 20_000);
    expect(pauseClock(paused, T0 + 90_000)).toBe(paused);
    expect(elapsedOf(paused, T0 + 90_000)).toBe(20);
  });

  it("toggles both ways", () => {
    const a = toggleClock(initClock("H1"), T0);
    expect(a.runningSince).toBe(T0);
    const b = toggleClock(a, T0 + 5_000);
    expect(b.runningSince).toBeNull();
    expect(elapsedOf(b, T0 + 999_000)).toBe(5);
  });

  it("renders M:SS, uncapped at 60 minutes — football's 90+3 is minute 48 of H2", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65)).toBe("1:05");
    expect(formatClock(2880)).toBe("48:00");
    expect(formatClock(-4)).toBe("0:00");
  });
});

describe("reseatClock — the seed is a bootstrap, not a leash", () => {
  it("seats a fresh clock from the fold when there is none yet", () => {
    const seated = reseatClock(null, { period: "P2", seed: 240 });
    expect(seated).toEqual({ period: "P2", base: 240, runningSince: null, known: true });
  });

  it("RESETS THE ORIGIN when the period changes, seeding from the new period's own stamp", () => {
    const first = startClock(initClock("P1"), T0);
    const second = reseatClock(first, { period: "P2", seed: 0 });
    expect(second).not.toBe(first);
    expect(second!.period).toBe("P2");
    // Paused again: a whistle just blew, and the pad has no idea when the next
    // face-off is. Seating it running would stamp the interval as play.
    expect(second!.runningSince).toBeNull();
    expect(elapsedOf(second!, T0 + 600_000)).toBe(0);
  });

  it("REFUSES to re-seed a clock already seated for this period, however the seed moves", () => {
    // THE GUARD. `PadClockSpec.seed` is rebuilt every render from a fold that
    // advances on every tap, so a reseat that followed the seed would drag the
    // running clock back to the last stamped event once per event — a clock
    // that only ever showed the past. Mutation-checked: dropping the
    // `prev.period !== spec.period` condition reds this test and the next.
    const running = startClock(initClock("P1"), T0);
    expect(reseatClock(running, { period: "P1", seed: 0 })).toBe(running);
    expect(reseatClock(running, { period: "P1", seed: 999 })).toBe(running);
    expect(reseatClock(running, { period: "P1" })).toBe(running);
  });

  it("so a running clock keeps ticking forward across a fold advance instead of snapping back", () => {
    // The same guard stated as the behaviour a scorer would see. Written
    // separately because the identity check above passes for a reseat that
    // happens to reproduce an equal object; this one cannot.
    let clock: PadClock | null = reseatClock(null, { period: "P1", seed: 0 });
    clock = startClock(clock!, T0);
    for (const seed of [12, 30, 47]) clock = reseatClock(clock, { period: "P1", seed });
    expect(elapsedOf(clock!, T0 + 61_000)).toBe(61);
  });

  it("drops the clock entirely when the skin declares none — a sport with no clock, or a phase with none", () => {
    expect(reseatClock(startClock(initClock("H1"), T0), null)).toBeNull();
    expect(reseatClock(null, null)).toBeNull();
  });

  it("and a spec with a BLANK period is the same as no clock, rather than one that ticks and stamps nothing", () => {
    // R6 review, gap 11. `PadClockSpec.period` was never checked, and the
    // engine's `GameTime.period` is `z.string().min(1)` — so a skin returning
    // `{period: ""}` used to mount a bar that displayed, ticked and offered
    // Start while EVERY stamp it produced was refused by the schema probe and
    // silently dropped. Fail-safe, but invisibly so: the scorer watches a
    // running clock record nothing. Absent is better than lying.
    expect(reseatClock(null, { period: "", seed: 30 })).toBeNull();
    expect(reseatClock(startClock(initClock("H1", 0), T0), { period: "" })).toBeNull();
    // A period made only of whitespace is the same claim, and `min(1)` would
    // accept it — so the check is on content, not length.
    expect(reseatClock(null, { period: "  " })).toBeNull();
  });

  it("DISCARDS the clock on a null spec, banked seconds and all — a skin must not toggle clock() off within one period", () => {
    // R6 review, gap 9, pinned rather than worked around. There is no history
    // here: a `clock()` that returned null and then non-null inside ONE period
    // would come back seeded from the fold, silently losing whatever the run
    // had banked past the last stamped event. No shipped skin can do it —
    // `skins/period-shared.ts`'s `buildClock` returns null only for a non-play
    // phase, and every return to play is a DIFFERENT period, which re-seeds by
    // design — but nothing recorded the obligation, so this test is the record.
    // If a later skin needs a within-period gap, it wants `clock()` to keep
    // returning its spec and the SCORER to pause, not a null.
    const banked = pauseClock(startClock(reseatClock(null, { period: "P1", seed: 0 })!, T0), T0 + 240_000);
    expect(elapsedOf(banked, T0)).toBe(240);
    expect(reseatClock(banked, null)).toBeNull();
    expect(elapsedOf(reseatClock(reseatClock(banked, null), { period: "P1", seed: 0 })!, T0)).toBe(0);
  });

  it("stamps while PAUSED as well as while running — in a stop-clock sport the whistle time IS the game time", () => {
    const paused = pauseClock(startClock(initClock("P1", 0), T0), T0 + 45_000);
    expect(stampOf(paused, T0 + 900_000)).toEqual({ period: "P1", elapsed: 45 });
    expect(stampOf(null, T0)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 1b. THE CLOCK THAT HAS NEVER BEEN TOLD THE TIME
// ---------------------------------------------------------------------------
//
// R6 review — the regression this half exists to close. A clock seats PAUSED at
// zero (property 4) and stamps while paused (property 5), so before `known` the
// two properties together said: a pad mounted on a fresh match stamps
// `{period, 0}` on EVERY event until somebody taps Start. Nothing corrects it
// later — `reseatClock` refuses to follow `spec.seed` once seated (property 3),
// by design — so a scorer writing up thirty minutes from a paper sheet would
// have banked thirty minutes of events all claiming minute zero.
//
// That is strictly WORSE than the "no clock at all" state this wave replaced.
// An absent `at` makes `skins/football.tsx`'s `readClock` DROP the strip item
// and leaves `period/suspensions.ts`'s `expiresAt` underivable — visibly
// missing. A fabricated zero makes both of them present and wrong: a clock
// frozen at 0:00, and a card awarded at minute 30 whose `expiresAt` is
// `0 + minutes`, already in the past, so the lazy sweep can never fire and
// release-on-goal eligibility turns on a `startedAt` that never happened.
//
// So `PadClock.known` gates the STAMP and nothing else. The bar still shows
// 0:00 and still offers Start; what it will not do is invent an observation.
describe("PadClock.known — a clock with no observation stamps nothing at all", () => {
  it("refuses to stamp a clock the scorer has not started and the fold could not seed", () => {
    // `skins/period-shared.ts`'s `buildClock` returns `{period}` with NO seed
    // until a stamped event exists in this phase — which, on a fresh match, is
    // never, because the stamp is the thing that would create it.
    const fresh = reseatClock(null, { period: "P1" });
    expect(fresh).not.toBeNull();
    expect(fresh!.known).toBe(false);
    // Half an hour of scoring later it STILL has nothing to say, and it still
    // displays 0:00 — the display was never the problem.
    expect(elapsedOf(fresh!, T0 + 1_800_000)).toBe(0);
    expect(stampOf(fresh!, T0 + 1_800_000)).toBeUndefined();
  });

  it("starts stamping on the first Start tap, and keeps stamping through every later pause", () => {
    const started = startClock(reseatClock(null, { period: "P1" })!, T0);
    expect(started.known).toBe(true);
    expect(stampOf(started, T0 + 30_000)).toEqual({ period: "P1", elapsed: 30 });
    // `pauseClock` rebuilds the object rather than spreading it, so this is
    // also the assertion that it does not DROP the flag on the way through.
    const paused = pauseClock(started, T0 + 30_000);
    expect(paused.known).toBe(true);
    expect(stampOf(paused, T0 + 900_000)).toEqual({ period: "P1", elapsed: 30 });
  });

  it("but a clock SEEDED from the fold stamps at once — a reload already knows the time, with no tap", () => {
    // The property-3 bootstrap: a second device joining a match in progress,
    // or the same device after a refresh. `seed: 0` is a real observation (the
    // fold says a stamped event sits at elapsed 0), which is why the flag
    // tracks the PRESENCE of `PadClockSpec.seed` and not its value.
    expect(stampOf(reseatClock(null, { period: "P1", seed: 0 })!, T0)).toEqual({ period: "P1", elapsed: 0 });
    expect(stampOf(reseatClock(null, { period: "P1", seed: 761 })!, T0)).toEqual({ period: "P1", elapsed: 761 });
  });

  it("and goes back to unknown at a period change, until the new period is started", () => {
    // `buildClock` deliberately drops the seed when `state.asOf` names the
    // period the match has just left, so P2 opens with no observation — and an
    // event recorded between the whistle and the face-off goes unstamped
    // rather than claiming second 0 of P2.
    const running = startClock(reseatClock(null, { period: "P1", seed: 12 })!, T0);
    const next = reseatClock(running, { period: "P2" });
    expect(next!.known).toBe(false);
    expect(stampOf(next, T0 + 600_000)).toBeUndefined();
    expect(stampOf(startClock(next!, T0 + 600_000), T0 + 630_000)).toEqual({ period: "P2", elapsed: 30 });
  });
});

// ---------------------------------------------------------------------------
// 2. The stamp, through the REAL engine
// ---------------------------------------------------------------------------

const footballModule = (builtinModules as readonly AnySportModule[]).find((m) => m.key === "football");
if (!footballModule?.eventSchemas) {
  throw new Error("football module (with eventSchemas) not found in builtinModules — engine export moved?");
}
const footballSchemas = footballModule.eventSchemas;

describe("stampPayload asks the ENGINE whether a stamp is legal, and never mirrors it", () => {
  const stamp = { period: "H1", elapsed: 761 };

  it("attaches `at` to a payload whose real schema declares it", () => {
    const out = stampPayload({ by: "H" }, stamp, footballSchemas["football.goal"]) as Record<string, unknown>;
    expect(out).toEqual({ by: "H", at: { period: "H1", elapsed: 761 } });
    // and the engine really does accept the result, rather than this file
    // deciding that it would
    expect(footballSchemas["football.goal"]!.safeParse(out).success).toBe(true);
  });

  it("leaves a payload alone when the real schema is a strictObject with no `at` — the case a blanket stamp would break", () => {
    // R6 review, gap 4. This test used to hand `stampPayload` a HAND-WRITTEN
    // `noteSchema` fake while claiming to be "proven against the engine's own
    // schema" — a fixture proving a fixture, and the only cover the FALSE arm
    // had. `CORE_EVENT_SCHEMAS` is exported; there was never a reason to
    // invent one.
    const payload = { text: "floodlight failure" };
    expect(stampPayload(payload, stamp, CORE_EVENT_SCHEMAS["core.note"])).toBe(payload); // by reference
    // …and the engine really would have refused the stamped form, rather than
    // this file asserting that it would.
    expect(CORE_EVENT_SCHEMAS["core.note"].safeParse({ ...payload, at: stamp }).success).toBe(false);
  });

  it("is a no-op with no clock, no registered schema, or a payload that is not a plain object", () => {
    const payload = { by: "H" };
    expect(stampPayload(payload, undefined, footballSchemas["football.goal"])).toBe(payload);
    expect(stampPayload(payload, stamp, undefined)).toBe(payload);
    expect(stampPayload("nope", stamp, footballSchemas["football.goal"])).toBe("nope");
    expect(stampPayload([1], stamp, footballSchemas["football.goal"])).toEqual([1]);
  });

  it("keeps the event dispatchable when the probe throws, rather than taking the tap down with it", () => {
    const payload = { by: "H" };
    const boom = { safeParse: () => { throw new Error("boom"); } };
    expect(stampPayload(payload, stamp, boom)).toBe(payload);
  });

  it("DEFERS to an `at` the skin already put on the payload — the skin owns the field, the chassis fills a blank", () => {
    // R6 review, gap 2. The first cut of this file overwrote a skin-supplied
    // `at` unconditionally, on the grounds that "the live clock is strictly
    // closer to now". That destroyed a decision `skins/football.tsx`'s own
    // `stampOf` records in a comment ending "Do not 'fix' this later by
    // stamping unconditionally" — a skin knows things about its own `at` that
    // the chassis cannot see, and its refusals are load-bearing (football's
    // `applySub` window arithmetic can admit an illegal substitution or refuse
    // a legal one off a wrong stamp).
    const skinStamped = { by: "H", at: { period: "H1", elapsed: 3 } };
    expect(stampPayload(skinStamped, stamp, footballSchemas["football.goal"])).toBe(skinStamped); // by reference
  });

  // R6 review, gap 3. The whole `CORE_EVENT_SCHEMAS` table, both arms, from the
  // engine's own export — the claim `stampPayload`'s doc makes is the claim
  // under test, and it was wrong about the lineup family until this ran.
  // Enumerated rather than sampled (AGENTS.md failure class 7).
  const CORE_TAKES_AT = ["core.suspend", "core.resume", "core.lineup.substitution", "core.lineup.replacement", "core.lineup.position", "core.lineup.retirement", "core.lineup.entry"] as const;
  const CORE_REFUSES_AT = ["core.start", "core.void", "core.forfeit", "core.abandon", "core.finalize", "core.note", "core.award"] as const;

  it("covers every core type — the two arms partition CORE_EVENT_SCHEMAS with nothing left over", () => {
    expect([...CORE_TAKES_AT, ...CORE_REFUSES_AT].sort()).toEqual(Object.keys(CORE_EVENT_SCHEMAS).sort());
  });

  it.each(CORE_TAKES_AT)("%s declares `at`, so the probe keeps the stamp", (type) => {
    const onSlot = { personId: "p2", slot: "bench" as const, orderNo: 12 };
    const body: Record<string, unknown> = {
      "core.suspend": {},
      "core.resume": {},
      "core.lineup.substitution": { side: "H", off: "p1", on: onSlot },
      "core.lineup.replacement": { side: "H", off: "p1", on: onSlot, exemption: "concussion" },
      "core.lineup.position": { side: "H", personId: "p1", positionKey: "GK" },
      "core.lineup.retirement": { side: "H", personId: "p1" },
      "core.lineup.entry": { side: "H", on: onSlot },
    }[type] as Record<string, unknown>;
    // The body must be VALID before the stamp, or `stampPayload`'s documented
    // "already invalid for an unrelated reason" arm would mask the answer.
    expect(CORE_EVENT_SCHEMAS[type].safeParse(body).success, `${type}: unstamped body is not valid`).toBe(true);
    const out = stampPayload(body, stamp, CORE_EVENT_SCHEMAS[type]);
    expect(out).toMatchObject({ at: { period: "H1", elapsed: 761 } });
    expect(CORE_EVENT_SCHEMAS[type].safeParse(out).success, `${type} rejected its own stamped payload`).toBe(true);
  });

  it.each(CORE_REFUSES_AT)("%s is a strictObject with no `at`, so the probe's FALSE arm drops the stamp", (type) => {
    const body: Record<string, unknown> = {
      "core.start": {},
      "core.void": {},
      "core.forfeit": { by: "H", reason: "walkover" },
      "core.abandon": { reason: "floodlight failure" },
      "core.finalize": {},
      "core.note": { text: "n" },
      "core.award": { person: "p1", key: "motm" },
    }[type] as Record<string, unknown>;
    expect(stampPayload(body, stamp, CORE_EVENT_SCHEMAS[type])).toBe(body); // by reference
    expect(CORE_EVENT_SCHEMAS[type].safeParse({ ...body, at: stamp }).success).toBe(false);
  });

  it("and treats an EXPLICIT `at: undefined` as a deliberate refusal, not as a blank to fill", () => {
    // The channel a skin uses to say "this event has no game time" for ONE
    // payload while still declaring a clock for the match. The KEY is the
    // signal, not the value: `GameTime.optional()` accepts `undefined`, so the
    // event still dispatches and still folds — it simply carries no stamp.
    const refused = { by: "H", at: undefined };
    expect(stampPayload(refused, stamp, footballSchemas["football.goal"])).toBe(refused);
    expect(footballSchemas["football.goal"]!.safeParse(refused).success).toBe(true);
  });
});

describe("END TO END: a tile tapped on a clocked pad reaches the fold WITH its `at`", () => {
  const cfg = footballCfg();

  /** The host's own stamping step (`stampFor`, pad-host.tsx), applied to the
   *  event the REAL football skin's own tile carries. Nothing here is
   *  hand-written except the clock the scorer would have started. */
  function tapThroughHost(clock: PadClock | null, nowMs: number): { type: string; payload: unknown } {
    const state = foldFootball(cfg, [["core.start"]]);
    const view: PadHostView = {
      cfg,
      state,
      summary: {},
      phase: "live",
      band: 3,
      entitlements: {},
      personNames: {},
      squads: { home: { entrantId: "H", members: [], subsUsed: 0, exemptUsed: {} }, away: { entrantId: "A", members: [], subsUsed: 0, exemptUsed: {} } },
      events: [],
      contextOverrides: {},
    };
    const skin = footballSkinV3((key: string) => key);
    const goalTile = skin.tiles(view).find((tile) => "event" in tile.action && tile.action.event.type === "football.goal");
    expect(goalTile, "the real football skin no longer offers a goal tile at live/band 3").toBeDefined();
    const action = goalTile!.action as { event: { type: string; payload: Record<string, unknown> } };
    return {
      type: action.event.type,
      payload: stampFor(footballModule!, action.event.type, action.event.payload, clock, nowMs),
    };
  }

  /** The REAL football skin's own header strip, built from a folded state — the
   *  read side, unchanged by this wave, used here as the consumer end of the
   *  seam rather than a hand-written mirror of it. */
  const stripOf = (state: unknown) =>
    buildScorebug(
      {
        cfg,
        state,
        summary: {},
        phase: "live",
        band: 3,
        entitlements: {},
        personNames: {},
        squads: { home: { entrantId: "H", members: [], subsUsed: 0, exemptUsed: {} }, away: { entrantId: "A", members: [], subsUsed: 0, exemptUsed: {} } },
        events: [],
        contextOverrides: {},
      },
      (key: string) => key,
    ).strip ?? [];

  it("the real engine folds the stamped tap and REMEMBERS the time — state.asOf, which nothing could set before", () => {
    const clock = startClock(initClock("H1"), T0);
    const tap = tapThroughHost(clock, T0 + 761_000);
    expect(tap.payload).toMatchObject({ at: { period: "H1", elapsed: 761 } });

    const folded = foldFootball(cfg, [["core.start"], [tap.type, tap.payload]]) as { asOf?: unknown };
    // THE assertion this whole wave exists for. Before it, `state.asOf` was
    // unreachable from the pad and football's own comment recorded the clock
    // as an open engine-side question.
    expect(folded.asOf).toEqual({ period: "H1", elapsed: 761 });
  });

  it("and football's own skin then RENDERS a clock, from the same fold, with no skin change at all", () => {
    const clock = startClock(initClock("H1"), T0);
    const tap = tapThroughHost(clock, T0 + 761_000);
    const before = foldFootball(cfg, [["core.start"]]);
    const after = foldFootball(cfg, [["core.start"], [tap.type, tap.payload]]);

    // The read side was already correct and stayed untouched by this wave —
    // what changed is that there is now something for it to read.
    expect(readClock(before, "H1")).toBeUndefined();
    expect(readClock(after, "H1")).toBe("12:41");

    expect(stripOf(before).map((item) => item.id)).not.toContain("clock");
    const item = stripOf(after).find((s) => s.id === "clock");
    expect(item?.value).toBe("12:41");
  });

  it("an UNCLOCKED pad is byte-identical to today — the payload is the tile's own object, untouched", () => {
    // Football does not declare `clock()` (R6's skin task gave one to hockey
    // and ice hockey only), and most v3 skins never will. `reseatClock(null,
    // null)` is what the host holds for all of them, and this asserts that
    // costs them nothing.
    const state = foldFootball(cfg, [["core.start"]]);
    const original = { by: "H" };
    expect(stampFor(footballModule!, "football.goal", original, null, T0)).toBe(original);
    expect((foldFootball(cfg, [["core.start"], ["football.goal", original]]) as { asOf?: unknown }).asOf).toBeUndefined();
    expect((state as { asOf?: unknown }).asOf).toBeUndefined();
  });

  it("stamps a KERNEL-owned event too — no module registers `core.*`, so the host falls back to CORE_EVENT_SCHEMAS", () => {
    // R6 review, gap 3. `stampFor` used to consult `module.eventSchemas` and
    // nothing else, and NO module registers a `core.*` key — so every
    // kernel-owned event the pad can send fell through the `schema ===
    // undefined` arm and went out unstamped, whatever the clock said. That is
    // not a detail: `skins/period-shared.ts`'s SWAP_TYPE is
    // `core.lineup.substitution`, so a hockey line change — the event whose
    // `at` a window calculation would read — was the one event a clocked pad
    // could never stamp.
    const live = startClock(reseatClock(null, { period: "H1" })!, T0);
    expect(footballModule!.eventSchemas!["core.lineup.substitution"]).toBeUndefined();
    const sub = { side: "H", off: "p1", on: { personId: "p2", slot: "bench" as const, orderNo: 12 } };
    const swap = stampFor(footballModule!, "core.lineup.substitution", sub, live, T0 + 761_000);
    expect(swap).toMatchObject({ at: { period: "H1", elapsed: 761 } });
    expect(CORE_EVENT_SCHEMAS["core.lineup.substitution"].safeParse(swap).success).toBe(true);

    // …and the FALSE arm is live in the same path, which is the half that had
    // no proof at all: `core.note` is a strictObject and comes back untouched.
    const note = { text: "floodlight failure" };
    expect(stampFor(footballModule!, "core.note", note, live, T0 + 761_000)).toBe(note);
  });

  it("prefers the MODULE's own schema when it has one, so a sport can never be overruled by the core table", () => {
    const live = startClock(reseatClock(null, { period: "H1" })!, T0);
    // The reachable half: a module type the core table knows nothing about.
    expect(stampFor(footballModule!, "football.goal", { by: "H" }, live, T0 + 761_000)).toEqual({
      by: "H",
      at: { period: "H1", elapsed: 761 },
    });
    // A type NEITHER side declares stays unstamped rather than guessing.
    const unknown = { by: "H" };
    expect(stampFor(footballModule!, "football.nonesuch", unknown, live, T0)).toBe(unknown);

    // THE ORDERING ITSELF, which nothing above can see: no shipped module
    // registers a `core.*` key, so module-first and core-first agree on every
    // real input and a mutation swapping them survives. Driven here with a
    // module that DOES claim one — and with real engine schemas at both ends,
    // never a hand-written probe: `core.suspend`'s schema (which takes `at`)
    // filed under the key `core.note` (whose own schema refuses it). Stamped
    // ⇒ the module answered; untouched ⇒ the core table overruled it.
    const overriding = {
      key: "fake",
      eventSchemas: { "core.note": CORE_EVENT_SCHEMAS["core.suspend"] },
    } as unknown as AnySportModule;
    expect(stampFor(overriding, "core.note", {}, live, T0 + 761_000)).toEqual({ at: { period: "H1", elapsed: 761 } });
  });

  it("the REAL swap slot's own `at` survives the chassis — the producer the deleted decision was written for", () => {
    // Gap 2, driven end to end rather than argued. `buildSwap` stamps from
    // `state.asOf` through football's `stampOf`, which is a DIFFERENT source
    // from the pad clock and deliberately so. Here the fold says 761 and the
    // live clock says 1200; the payload that reaches the engine must say 761,
    // because football chose it.
    const stampedState = foldFootball(cfg, [
      ["core.start"],
      ["football.goal", { by: "H", at: { period: "H1", elapsed: 761 } }],
    ]);
    const slots = footballSkinV3((key: string) => key).swap!({
      cfg,
      state: stampedState,
      summary: {},
      phase: "live",
      band: 3,
      entitlements: {},
      personNames: {},
      squads: { home: { entrantId: "H", members: [], subsUsed: 0, exemptUsed: {} }, away: { entrantId: "A", members: [], subsUsed: 0, exemptUsed: {} } },
      events: [],
      contextOverrides: {},
    });
    const built = slots[0]!.buildEvent("p-off", "p-on");
    expect(built.payload).toMatchObject({ at: { period: "H1", elapsed: 761 } });

    const live = startClock(reseatClock(null, { period: "H1" })!, T0);
    const out = stampFor(footballModule!, built.type, built.payload, live, T0 + 1_200_000);
    expect(out).toBe(built.payload); // by reference — the chassis did not touch it
    expect(footballSchemas[built.type]!.safeParse(out).success).toBe(true);
  });

  it("and so is a pad whose clock was never started — thirty minutes of taps, and the strip STILL renders no clock", () => {
    // THE REGRESSION GATE (R6 review, gap 1). This is the same assertion as the
    // test above, driven through a clock that EXISTS: seated, mounted, showing
    // 0:00, and never started. Before `known` this path stamped `{H1, 0}` on
    // every tap, `state.asOf` became `{H1,0}`, and football's strip rendered a
    // clock frozen at "0:00" where it correctly drops the item today. The
    // by-reference identity is the strong form — not merely "no `at` key", but
    // the tile's own object arriving at `dispatch` untouched.
    const never = reseatClock(null, { period: "H1" })!;
    const tap = tapThroughHost(never, T0 + 1_800_000);
    const untouched = footballSkinV3((key: string) => key)
      .tiles({
        cfg,
        state: foldFootball(cfg, [["core.start"]]),
        summary: {},
        phase: "live",
        band: 3,
        entitlements: {},
        personNames: {},
        squads: { home: { entrantId: "H", members: [], subsUsed: 0, exemptUsed: {} }, away: { entrantId: "A", members: [], subsUsed: 0, exemptUsed: {} } },
        events: [],
        contextOverrides: {},
      })
      .find((tile) => "event" in tile.action && tile.action.event.type === "football.goal")!;
    expect(tap.payload).toEqual((untouched.action as { event: { payload: unknown } }).event.payload);
    expect(tap.payload).not.toHaveProperty("at");

    const folded = foldFootball(cfg, [["core.start"], [tap.type, tap.payload]]);
    expect((folded as { asOf?: unknown }).asOf).toBeUndefined();
    expect(readClock(folded, "H1")).toBeUndefined();
    expect(stripOf(folded).map((item) => item.id)).not.toContain("clock");
  });
});

// ---------------------------------------------------------------------------
// 3. The one control, and the four dictionaries behind it
// ---------------------------------------------------------------------------

describe("PadClockBar renders the time that would be stamped, plus its controls", () => {
  const t = (key: string) => key;
  const html = (elapsed: number, running: boolean, adjusting = false, fixtureId = "fx-1") =>
    renderToStaticMarkup(
      PadClockBar({
        elapsed,
        running,
        adjusting,
        onToggle: () => {},
        onToggleAdjust: () => {},
        onAdjust: () => {},
        fixtureId,
        t,
      }) as never,
    );

  it("shows M:SS and offers Start while paused", () => {
    const out = html(761, false);
    expect(out).toContain("12:41");
    expect(out).toContain("scorepad.clock.start");
    expect(out).not.toContain("scorepad.clock.pause");
    // `="` anchored: React serialises an omitted prop as `"$undefined"`, so a
    // bare `data-running` probe would pass in both states (AGENTS.md).
    expect(out).toContain('data-running="no"');
  });

  it("offers Pause while running, and says so in the DOM the e2e will assert on", () => {
    const out = html(5, true);
    expect(out).toContain("scorepad.clock.pause");
    expect(out).not.toContain("scorepad.clock.start");
    expect(out).toContain('data-running="yes"');
    expect(out).toContain('data-role="v3-clock-toggle"');
  });

  it("keeps the control at the 44px tap floor", () => {
    expect(html(0, false)).toContain("min-height:44px");
  });

  it("every key it renders exists in ALL FOUR dictionaries — nothing here has a gate but this", () => {
    // A v3 chassis string has no automatic i18n gate (the skins' own keys have
    // none either), so the check is direct: read the dictionaries. The list is
    // SCRAPED from the two rendered states rather than typed out, so a key added
    // to the bar and forgotten in a locale fails here instead of shipping.
    const rendered = `${html(0, false, false)}${html(0, false, true)}`;
    const keys = [...new Set(rendered.match(/scorepad\.clock\.[a-zA-Z.]+/g) ?? [])];
    expect(keys.length, "the bar rendered no dictionary keys at all").toBeGreaterThanOrEqual(7);
    for (const locale of ["en", "es", "fr", "nl"]) {
      const dict = JSON.parse(
        readFileSync(join(process.cwd(), `src/dictionaries/${locale}/ui.json`), "utf8"),
      ) as Record<string, string>;
      for (const key of keys) {
        expect(dict[key], `${locale} is missing ${key}`).toBeTruthy();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3b. The correction (R6 fix pass 2, gap 7)
// ---------------------------------------------------------------------------

describe("adjustClock puts time on and takes it off, and touches nothing that was recorded", () => {
  it("moves `base` by whole minutes, in both directions", () => {
    const seated = reseatClock(null, { period: "P1", seed: 0 })!;
    const up = adjustClock(seated, CLOCK_NUDGE_SECONDS, T0);
    expect(elapsedOf(up, T0)).toBe(60);
    expect(elapsedOf(adjustClock(up, CLOCK_NUDGE_SECONDS, T0), T0)).toBe(120);
    expect(elapsedOf(adjustClock(up, -CLOCK_NUDGE_SECONDS, T0), T0)).toBe(0);
  });

  it("corrects a RUNNING clock without stopping it — the correction is the shift, not a reset", () => {
    const running = startClock(reseatClock(null, { period: "P1", seed: 0 })!, T0);
    expect(elapsedOf(running, T0 + 30_000)).toBe(30);
    const corrected = adjustClock(running, 5 * CLOCK_NUDGE_SECONDS, T0 + 30_000);
    expect(corrected.runningSince, "the correction stopped the clock").not.toBeNull();
    expect(elapsedOf(corrected, T0 + 30_000)).toBe(330);
    // …and it keeps counting from there.
    expect(elapsedOf(corrected, T0 + 90_000)).toBe(390);
  });

  it("clamps at 0:00 and returns the clock BY REFERENCE when the nudge changes nothing", () => {
    // The reference identity is the load-bearing half: the host's render-phase
    // `!==` checks and this file's own property-3 discipline both read it.
    const seated = reseatClock(null, { period: "P1", seed: 0 })!;
    expect(adjustClock(seated, -CLOCK_NUDGE_SECONDS, T0)).toBe(seated);
    expect(adjustClock(seated, 0, T0)).toBe(seated);
    expect(adjustClock(seated, Number.NaN, T0)).toBe(seated);
    expect(adjustClock(seated, Number.POSITIVE_INFINITY, T0)).toBe(seated);
    // A partial take-off lands on 0 rather than going negative — `at` is
    // `DurationSeconds`, which refuses a negative outright.
    const thirty = adjustClock(initClock("P1", 30), -CLOCK_NUDGE_SECONDS, T0);
    expect(elapsedOf(thirty, T0)).toBe(0);
  });

  it("a correction that MOVES the clock makes it known; one that does not, does not", () => {
    // Property 6. Setting the time is an observation exactly as tapping Start
    // is — a scorer who arrives five minutes in and nudges to 5:00 has told the
    // pad what time it is, and its stamps become real. But a `-1` at 0:00 that
    // changes nothing must NOT turn a pad displaying its placeholder zero into
    // one claiming to know the time, which is the failure property 6 exists for.
    const fresh = initClock("P1"); // no seed — nobody has told it anything
    expect(fresh.known).toBe(false);
    expect(stampOf(fresh, T0)).toBeUndefined();
    expect(adjustClock(fresh, -CLOCK_NUDGE_SECONDS, T0).known, "a no-op nudge claimed the time").toBe(false);
    const told = adjustClock(fresh, 5 * CLOCK_NUDGE_SECONDS, T0);
    expect(told.known).toBe(true);
    expect(stampOf(told, T0)).toEqual({ period: "P1", elapsed: 300 });
  });

  it("changes only the pad's own clock — no dispatch, no re-fold, no recorded `at` moves", () => {
    // A recorded `at` is a frozen fact (core/time.ts:6-9). `adjustClock` is a
    // pure function of a `PadClock`, so the strongest statement this tree can
    // make is the structural one: nothing but `base` and `known` differs, and
    // the period the stamps will name is untouched.
    const seated = startClock(reseatClock(null, { period: "P2", seed: 240 })!, T0);
    const corrected = adjustClock(seated, CLOCK_NUDGE_SECONDS, T0);
    expect(Object.keys(corrected).sort()).toEqual(Object.keys(seated).sort());
    expect(corrected.period).toBe(seated.period);
    expect(corrected.runningSince).toBe(seated.runningSince);
    expect({ ...corrected, base: seated.base, known: seated.known }).toEqual(seated);
  });

  // -------------------------------------------------------------------------
  // R6 fix pass 4, finding 1 (HIGH) — `-1 min` was a dead button on a running
  // clock that had never been paused.
  // -------------------------------------------------------------------------

  it("moves the DISPLAY on a RUNNING clock that has never been paused — finding 1, verbatim", () => {
    // The reported scenario exactly: start fresh (`base` stays 0 — nothing has
    // ever been banked), play 3:00, tap -1 min. The OLD code clamped against
    // `clock.base` alone (`Math.max(0, base + delta)`): `Math.max(0, 0 - 60)`
    // is 0, which IS `base`, so the function returned the clock BY REFERENCE —
    // a dead button. The fix clamps against the LIVE total instead.
    const running = startClock(reseatClock(null, { period: "Q1", seed: 0 })!, T0);
    const threeMinutes = T0 + 180_000;
    expect(elapsedOf(running, threeMinutes)).toBe(180);
    const corrected = adjustClock(running, -CLOCK_NUDGE_SECONDS, threeMinutes);
    expect(corrected, "adjustClock returned the clock BY REFERENCE — the dead-button bug").not.toBe(running);
    expect(elapsedOf(corrected, threeMinutes)).toBe(120);
    // …and it keeps ticking FORWARD from the corrected time, not from 0 — the
    // correction shifted the run, it did not stop or reset it.
    expect(elapsedOf(corrected, threeMinutes + 10_000)).toBe(130);
    expect(corrected.runningSince, "the correction must not stop the clock").not.toBeNull();
  });

  it("repeated taps on the same running, never-paused clock compose", () => {
    // "Repeated taps compose, so a five-minute correction is five taps of one
    // control that cannot go anywhere unexpected" — this file's own doc on
    // CLOCK_NUDGE_SECONDS. Two taps here stand in for five.
    const running = startClock(reseatClock(null, { period: "Q1", seed: 0 })!, T0);
    const fiveMinutes = T0 + 300_000;
    const once = adjustClock(running, -CLOCK_NUDGE_SECONDS, fiveMinutes);
    const twice = adjustClock(once, -CLOCK_NUDGE_SECONDS, fiveMinutes);
    expect(elapsedOf(twice, fiveMinutes)).toBe(180);
  });

  it("still refuses to move the display below 0:00, even mid-run", () => {
    const running = startClock(reseatClock(null, { period: "Q1", seed: 0 })!, T0);
    const thirtySeconds = T0 + 30_000;
    const corrected = adjustClock(running, -CLOCK_NUDGE_SECONDS, thirtySeconds);
    expect(elapsedOf(corrected, thirtySeconds)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // R6 fix pass 4, finding 2 (HIGH) — the correction must never produce a
  // stamp the server will refuse. THE RULE CHOSEN: clamp the CORRECTION
  // (both the display and the eventual stamp) at the high-water mark;
  // `pad-host.tsx`'s `adjustClockNow` sources that floor from the freshly
  // rebuilt clock spec's own `seed`, which IS `state.asOf` for the CURRENT
  // period on every render (`skins/period-shared.ts`'s `buildClock`). The
  // alternative the review offered — clamp only the stamp, let the display
  // lie below it — was rejected: this file's whole design is that the
  // display IS what will be stamped (`stampOf` reads the same `elapsedOf`
  // `PadClockBar` renders), and a display that no longer matches its own
  // stamp is a second, silent disagreement of exactly the kind R6/task A's
  // own header opens by naming.
  // -------------------------------------------------------------------------

  describe("the correction cannot produce a stamp the server would refuse", () => {
    it("clamps at the high-water floor within the SAME period, even on a running clock", () => {
      // Seeded at 6:00 (`state.asOf` — the fold's own high-water mark after a
      // goal), the scorer plays on a little and then corrects. A `-1 min`
      // that would take the display BELOW 6:00 must land exactly ON the
      // floor instead: `core/events.ts`'s NON_MONOTONIC_TIME guard refuses
      // anything earlier than the newest ACCEPTED stamp.
      const running = startClock(reseatClock(null, { period: "Q1", seed: 360 })!, T0);
      const tenSecondsIn = T0 + 10_000;
      expect(elapsedOf(running, tenSecondsIn)).toBe(370);
      const floor = { period: "Q1", elapsed: 360 };
      const corrected = adjustClock(running, -CLOCK_NUDGE_SECONDS, tenSecondsIn, floor);
      expect(elapsedOf(corrected, tenSecondsIn), "the correction went below the high-water mark").toBe(360);
      // …and it is STILL a real correction, not a no-op: the clock moved from
      // 370 to 360, which the next stamp will carry.
      expect(corrected).not.toBe(running);
    });

    it("does not clamp against a DIFFERENT period's floor — the two are incomparable", () => {
      // A stale floor left over from the period this clock just left must not
      // leak into the new one: Q1's 900 would otherwise refuse everything in
      // a freshly-started Q2.
      const running = startClock(reseatClock(null, { period: "Q2", seed: 30 })!, T0);
      const nowMs = T0 + 5_000;
      const floor = { period: "Q1", elapsed: 900 };
      const corrected = adjustClock(running, -CLOCK_NUDGE_SECONDS, nowMs, floor);
      expect(elapsedOf(corrected, nowMs)).toBe(0);
    });

    it("a floored no-op still returns the clock BY REFERENCE — property 6 holds under the floor too", () => {
      const seated = reseatClock(null, { period: "Q1", seed: 360 })!;
      const floor = { period: "Q1", elapsed: 360 };
      expect(adjustClock(seated, -CLOCK_NUDGE_SECONDS, T0, floor)).toBe(seated);
    });

    it("with no floor at all, behaves exactly as the pre-fix arithmetic did (floor 0)", () => {
      const seated = reseatClock(null, { period: "Q1", seed: 30 })!;
      expect(elapsedOf(adjustClock(seated, -CLOCK_NUDGE_SECONDS, T0), T0)).toBe(0);
    });
  });
});

describe("the correction row is a disclosure, and stays out of the way until it is asked for", () => {
  const t = (key: string) => key;
  const html = (adjusting: boolean, fixtureId = "fx-1") =>
    renderToStaticMarkup(
      PadClockBar({
        elapsed: 761,
        running: false,
        adjusting,
        onToggle: () => {},
        onToggleAdjust: () => {},
        onAdjust: () => {},
        fixtureId,
        t,
      }) as never,
    );

  it("is absent at rest, so the resting bar is the one that already carries a width sign-off", () => {
    const closed = html(false);
    expect(closed).not.toContain('data-role="v3-clock-adjust"');
    expect(closed).not.toContain('data-role="v3-clock-minus"');
    expect(closed).not.toContain('data-role="v3-clock-plus"');
    // `="` anchored — React serialises an omitted prop as `"$undefined"`.
    expect(closed).toContain('data-adjusting="no"');
  });

  it("opens from the READOUT, which is the control — not a gear, a modal or a typed time", () => {
    const closed = html(false);
    expect(closed).toContain('data-role="v3-clock-value"');
    expect(closed).toContain("<button");
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toContain('aria-controls="v3-clock-adjust-fx-1"');
    expect(closed).toContain("scorepad.clock.adjust");
    expect(html(true)).toContain('aria-expanded="true"');
    // No text entry anywhere: a typed time on a phone, in the rain, during play.
    expect(html(true)).not.toContain("<input");
  });

  it("offers exactly two minute nudges, and says what they cannot reach", () => {
    const open = html(true);
    expect(open).toContain('data-adjusting="yes"');
    expect(open).toContain('id="v3-clock-adjust-fx-1"');
    expect(open).toContain('data-role="v3-clock-minus"');
    expect(open).toContain('data-role="v3-clock-plus"');
    expect(open).toContain("scorepad.clock.minute.off");
    expect(open).toContain("scorepad.clock.minute.on");
    // The caption is the trust statement: a correction is not a retro-edit.
    expect(open).toContain("scorepad.clock.adjust.scope");
  });

  it("keeps every control at the 44px tap floor, open and closed", () => {
    for (const out of [html(false), html(true)]) {
      const targets = out.split("<button").length - 1;
      expect(targets).toBeGreaterThan(1);
      expect(out.split("min-height:44px").length - 1, "a control is under the tap floor").toBe(targets);
    }
  });

  it("hangs off the readout — right-aligned and content-sized, never spanning the board like a tile", () => {
    // Measured in Chromium at 320/768/1280 before this was written: made
    // full-width, the tray behind the time became a 1096px grey band at 1280
    // and the two nudges became 625px slabs, which is the opposite of quiet.
    // Content-sized and right-aligned, the group reads as a drawer pulled from
    // the number it corrects, identical at every width.
    const open = html(true);
    const row = open.slice(open.indexOf('id="v3-clock-adjust-fx-1"'));
    expect(row).toContain("justify-end");
    // R6 W-3: four buttons, not two, so the per-button floor came down from
    // 88px to a 44px tap target — the row still has to be content-sized and
    // fit 320 without scrolling it sideways, which is the point of the floor
    // in the first place. 44 is the tap-target minimum, not a design choice.
    expect(row).toContain("min-w-[44px]");
    expect(row).toContain("min-height:44px");
    expect(row, "a nudge stretched to fill the row").not.toContain("flex-1");
    // The readout's tray hugs its digits; the LABEL takes the row's slack.
    const bar = open.slice(0, open.indexOf('id="v3-clock-adjust-fx-1"'));
    expect(bar).toContain("min-w-0 flex-1 truncate text-xs");
    expect(bar).toContain("shrink-0 rounded-lg bg-slate-50");
  });

  // -------------------------------------------------------------------------
  // R6 W-3, owner-ruled 2026-08-31. A minute-only correction cannot express
  // the error a stop-clock official actually makes (whistle-to-restart lag,
  // 5-20s), so the row carries a fine pair too. These pin the DELTAS and the
  // ORDER, because a row of four buttons whose signs or magnitudes are
  // transposed is worse than the two it replaced.
  // -------------------------------------------------------------------------

  it("the correction row offers a fine pair as well as a coarse one, read as a number line", () => {
    const row = (() => {
      const open = html(true);
      return open.slice(open.indexOf('id="v3-clock-adjust-fx-1"'));
    })();
    for (const role of ["v3-clock-minus", "v3-clock-minus-fine", "v3-clock-plus-fine", "v3-clock-plus"]) {
      expect(row, `no button with data-role="${role}"`).toContain(`data-role="${role}"`);
    }
    // Left-to-right: -1 min, -10s, +10s, +1 min. Asserted by POSITION, so a
    // transposition that still renders all four buttons cannot pass.
    const order = ["v3-clock-minus", "v3-clock-minus-fine", "v3-clock-plus-fine", "v3-clock-plus"].map((r) =>
      row.indexOf(`data-role="${r}"`),
    );
    expect(order, "the four nudges are not in number-line order").toEqual([...order].sort((a, b) => a - b));
  });

  // -------------------------------------------------------------------------
  // Branch review, findings 2 and 3. Both are ways the pad can emit a stamp
  // the server will refuse, and neither is visible on screen — formatClock
  // sanitises the display, so the pad looks right while every write dies.
  // -------------------------------------------------------------------------

  it("a backwards system clock cannot make a nudged-down clock emit a negative stamp", () => {
    // adjustClock parks a NEGATIVE base on a running clock by design:
    // running 180s, -1 min => base = -60, ran = 180, elapsed = 120.
    const running = startClock(initClock("Q1", 0), T0);
    const after180 = T0 + 180_000;
    expect(elapsedOf(running, after180)).toBe(180);
    const nudged = adjustClock(running, -CLOCK_NUDGE_SECONDS, after180);
    expect(nudged.base, "this test is pointless unless base really goes negative").toBeLessThan(0);
    expect(elapsedOf(nudged, after180)).toBe(120);

    // Now the wall clock jumps BACKWARDS (NTP correction, laptop wake) — the
    // exact case elapsedOf's Math.max guard exists for. `ran` clamps to 0 and
    // the sum must not go with it.
    const jumped = T0 - 5_000;
    expect(elapsedOf(nudged, jumped)).toBeGreaterThanOrEqual(0);
    const stamp = stampOf(nudged, jumped);
    expect(stamp, "a known clock must still produce a stamp").toBeDefined();
    expect(stamp!.elapsed, "DurationSeconds is int().nonnegative() — a negative elapsed loses the event").
      toBeGreaterThanOrEqual(0);
  });

  it("an unknown clock follows a seed that arrives later in the same period", () => {
    // Mounted into a period with nothing stamped there yet: unknown, parked
    // at the placeholder zero.
    const unseeded = reseatClock(null, { period: "Q1", seed: undefined });
    expect(unseeded!.known).toBe(false);
    expect(unseeded!.base).toBe(0);

    // Another source stamps the same period forward (a second device, the
    // console, an import). The pad must take it, or Start will stamp below
    // the fold's high-water mark and every write is refused NON_MONOTONIC_TIME.
    const followed = reseatClock(unseeded, { period: "Q1", seed: 640 });
    expect(followed!.base, "the unknown clock ignored a seed it had no reason to refuse").toBe(640);
    expect(followed!.known).toBe(true);
    expect(stampOf(startClock(followed!, T0), T0)!.elapsed).toBe(640);

    // …and the refusal that protects a clock which DOES know its time still
    // holds: a known clock is never dragged back by a later seed.
    const known = startClock(reseatClock(null, { period: "Q1", seed: 900 })!, T0);
    expect(reseatClock(known, { period: "Q1", seed: 300 })).toBe(known);
  });

  it("the fine nudge is ten seconds, and both nudges drive the same adjustClock", () => {
    expect(CLOCK_NUDGE_FINE_SECONDS).toBe(10);
    expect(CLOCK_NUDGE_SECONDS).toBe(60);
    // Not two mechanisms: the fine delta goes through the SAME function, so
    // the high-water floor and the known-only-when-it-moves rule apply to it
    // unchanged. A running clock nudged +10s reads exactly ten seconds later.
    const started = startClock(initClock("Q1"), 1_000_000);
    const nudged = adjustClock(started, CLOCK_NUDGE_FINE_SECONDS, 1_000_000);
    expect(elapsedOf(nudged, 1_000_000)).toBe(elapsedOf(started, 1_000_000) + 10);
    // …and it obeys the floor exactly as the coarse one does: -10s at the
    // seed floor moves nothing and returns the clock BY REFERENCE, so it
    // cannot turn a placeholder zero into a clock claiming to know the time.
    const atFloor = initClock("Q1");
    expect(adjustClock(atFloor, -CLOCK_NUDGE_FINE_SECONDS, 1_000_000)).toBe(atFloor);
  });


  it("stays monochrome — the correction row must not read as a second scoring surface", () => {
    // The board's recording controls are large and coloured; this group is
    // slate on slate with mono numerals. A restyle that reaches for an accent
    // here fails deliberately.
    const open = html(true).slice(html(true).indexOf('id="v3-clock-adjust-fx-1"'));
    for (const accent of ["violet", "lime-400 bg", "emerald", "amber", "rose", "sport-"]) {
      expect(open.includes(`bg-${accent}`), `the correction row painted itself ${accent}`).toBe(false);
    }
    expect(open).toContain("text-slate-700");
  });

  // ---------------------------------------------------------------------------
  // R6 fix pass 4, finding 6 (LOW) — the id must be document-unique per pad.
  // ---------------------------------------------------------------------------

  it("derives its id from fixtureId, so two clocked pads on one page never collide", () => {
    // The regression: a hardcoded "v3-clock-adjust" `id` paired with an
    // `aria-controls` of the same literal is unique only as long as ONE pad
    // is mounted. This repo's own harnesses render side-by-side surfaces —
    // two hockey pads, or a hockey and an ice-hockey pad, on one screen — and
    // a duplicate `id` there cross-wires which disclosure a screen reader
    // reports as controlled by which button.
    const first = html(true, "fixture-alpha");
    const second = html(true, "fixture-beta");
    expect(first).toContain('id="v3-clock-adjust-fixture-alpha"');
    expect(first).toContain('aria-controls="v3-clock-adjust-fixture-alpha"');
    expect(second).toContain('id="v3-clock-adjust-fixture-beta"');
    expect(second).toContain('aria-controls="v3-clock-adjust-fixture-beta"');
    // Neither pad's markup contains the OTHER pad's id anywhere — not merely
    // that the two differ, but that nothing here still emits the bare,
    // document-unique-only literal the bug shipped.
    expect(first).not.toContain('"v3-clock-adjust-fixture-beta"');
    expect(second).not.toContain('"v3-clock-adjust-fixture-alpha"');
    // The bare, pre-fix literal must be gone from the two id-bearing
    // attributes specifically — `data-role="v3-clock-adjust"` is a SEPARATE,
    // deliberately unchanged marker other tests in this file query by, not
    // the collision this finding is about.
    expect(first, "id must carry the suffix").not.toContain('id="v3-clock-adjust"');
    expect(first, "aria-controls must carry the suffix").not.toContain('aria-controls="v3-clock-adjust"');
  });
});

// ---------------------------------------------------------------------------
// 4. The React shell, which nothing above can execute
// ---------------------------------------------------------------------------
//
// READ THIS BEFORE TRUSTING IT. These four assertions are a SOURCE AUDIT, and
// a source audit is a mirror: it proves the wiring is written, never that it
// runs. They are here because the alternative is nothing at all. `PadHostV3`
// renders seven independently-stateful nested primitives and apps/web vitest is
// `environment: "node"` with no jsdom, so a `send` that quietly stopped calling
// `stampFor` would leave every test above green (the exact "inert seam" shape
// this file's header quotes). Mutation-checked like everything else: deleting
// the `stampFor` call from `send` reds the first of these.
//
// R6/task C DISCHARGED THE FIRST HALF OF THE OBLIGATION THIS USED TO CARRY.
// `skins/hockey.tsx` and `skins/icehockey.tsx` declare `clock()`, so the bar is
// now reachable in the running product and `__tests__/period-pair.test.ts`
// drives the whole loop — the skin's own clock spec, `reseatClock`, `stampFor`,
// and the real kernel folding the stamp into `state.asOf` — with no
// hand-written fixture at either end. What these four still cannot see is the
// React shell around it, and the BROWSER e2e for that is R6/task E's.
describe("the host's own wiring, audited at the source (a mirror — see the note above)", () => {
  const src = readFileSync(join(process.cwd(), "src/components/v2/scorepad/v3/pad-host.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  it("routes THE send through stampFor, so there is exactly one place `at` enters an event", () => {
    expect(src).toContain("const stamped = stampFor(props.module, type, payload, clock, Date.now());");
    expect(src).toContain("void dispatch(type, stamped)");
    // The old, unstamped call must be gone — not merely joined by a new one.
    expect(src).not.toContain("void dispatch(type, payload)");
  });

  it("consults the SKIN for the clock spec and reconciles it through reseatClock", () => {
    expect(src).toContain("props.skin.clock?.(view)");
    expect(src).toContain("reseatClock(clock, clockSpec)");
  });

  it("mounts the bar only when a clock exists, so every pre-R6 skin's DOM is unchanged", () => {
    expect(/\{clock && \(\s*<PadClockBar/.test(src)).toBe(true);
  });

  it("wears the RIBBON's own container and button classes, so it inherits a width sign-off instead of claiming a new one", () => {
    // Kept as a STRUCTURAL lock now that R6's two skins mount this row for
    // real: it is the SAME row as the ribbon directly below it — same flex
    // container, same pill, same 44px control — so a later restyle of one that
    // forgets the other fails here rather than at a screenshot nobody retakes.
    // The live 320/768/1280 measurement is R6/task C's own, taken against the
    // real hockey and ice-hockey boards.
    const RIBBON_ROW = "flex items-center justify-between gap-2 rounded-full border border-slate-200 bg-white px-4 py-2";
    const RIBBON_BUTTON =
      "shrink-0 rounded-full px-3 text-sm font-semibold text-violet-700 transition-colors hover:bg-violet-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400";
    expect(src.split(RIBBON_ROW).length - 1, "the clock row and the ribbon row no longer share a container").toBe(2);
    expect(src.split(RIBBON_BUTTON).length - 1, "the clock toggle and the undo button no longer share a control").toBe(2);
    // Both rows are direct children of the pad root's `space-y-3` stack, so
    // neither introduces its own horizontal scroll container.
    expect(src).toContain('data-role="pad-v3"');
  });

  it("takes a FRESH Date.now() at tap time rather than the render-throttled tick", () => {
    // `nowMs` drives the display and moves at most twice a second; a stamp
    // taken from it could be up to a tick behind the tap it is stamping.
    expect(src).not.toContain("stampFor(props.module, type, payload, clock, nowMs)");
    expect(src).toContain("elapsedOf(clock, nowMs)");
  });

  it("hands the SKINS the same live stamp `send` records with, and lets the view follow it", () => {
    // R6 fix pass 2, gap 2. `PadHostView.clockAt` is what lets a skin render a
    // number that changes between events — the penalty countdown was measured
    // against `state.asOf`, which moves only when something is stamped, so it
    // never moved. Two things have to be written for that to work, and neither
    // is visible to any behavioural test in this tree:
    //   1. the value is `stampOf(clock, nowMs)` — the SAME derivation the send
    //      gateway stamps with, so watch-and-record cannot disagree; and
    //   2. `clockAt` is in the view memo's dependency list, without which the
    //      view is built once and the countdown freezes at its first reading
    //      while `PadClockBar` above it keeps ticking.
    expect(src).toContain("const liveStamp = stampOf(clock, nowMs);");
    expect(src).toContain("contextOverrides, clockAt]");
    // Split into primitives before the memo, so a 2 Hz tick does not rebuild
    // every tile, sheet, dock and swap slot in the pad twice a second.
    expect(src).toContain("[livePeriod, liveElapsed]");
  });

  it("does NOT read the wall clock on every pad mount — eight of the eleven skins have no clock at all", () => {
    // R6 review, gap 7. The lazy initialiser ran `Date.now()` for every pad in
    // the product to produce a value only a clocked skin ever reads. The two
    // properties that make 0 unreachable rather than merely unread are pinned
    // as BEHAVIOUR in the block below this one, not here. Inventory of who
    // declares `clock()` lives in pad-host.test.ts ("clock sports inventory").
    expect(src).not.toContain("useState(() => Date.now())");
    expect(src).toContain("const [nowMs, setNowMs] = useState(0);");
  });

  it("sources the correction's FLOOR from the freshly-rebuilt clock spec, not from the held clock's own stale seed", () => {
    // R6 fix pass 4, findings 1+2. `clockSpec` is rebuilt from `view` on
    // EVERY render (`props.skin.clock?.(view)`, just above `reseatClock` in
    // this same file) — its `seed`, when present, IS `state.asOf.elapsed`
    // for the current period. Reading it here rather than `clock.base` is
    // what keeps the floor from going stale the instant another device (or
    // this session's own prior dispatch) moves the fold's high-water mark.
    expect(src).toContain("clockSpec !== null && clockSpec.seed !== undefined");
    expect(src).toContain("{ period: clockSpec.period, elapsed: clockSpec.seed }");
    // Rapid Correct taps read `clockRef.current`, not the render-closed `clock`.
    // Ref advances in mutators + reseat only (never mirrored from render state).
    expect(src).toContain("const current = clockRef.current");
    expect(src).toContain("adjustClock(current, deltaSeconds, now, floor)");
    expect(src).toContain("clockRef.current = nextClock");
    expect(src).toContain("[clockSpec, publishClock]");
    expect(src).not.toContain("clockRef.current = clock;");
  });

  it("publishes *.clock on toggle and correct — overlay pause must not wait on soft-commit", () => {
    // 2026-09-13. Pad Pause used to be host-local only; the OBS clock kept
    // ticking. Both sites must call publishClock → pipeline.submit (immediate,
    // no HOLD_MS). Deleting either call reds here before the e2e can miss it.
    expect(src).toContain("const type = `${props.module.key}.clock`");
    expect(src).toContain("await pipeline.submit(type,");
    expect(src).toContain("void publishClock(next, now)");
    expect(src.split("void publishClock(next, now)").length - 1).toBe(2);
  });

  it("hands PadClockBar the pad's OWN fixtureId, not a placeholder", () => {
    // R6 fix pass 4, finding 6. The disclosure's id collides across two
    // clocked pads on one page unless it is derived from something
    // per-pad-unique; `props.fixtureId` is that value; PadClockBar.test's own
    // suite proves what it does with it once handed one.
    expect(src).toContain("fixtureId={props.fixtureId}");
  });
});

describe("the two properties that let the host seed its tick at 0 instead of Date.now()", () => {
  it("elapsedOf ignores nowMs entirely while the clock is paused, 0 included", () => {
    const paused = reseatClock(null, { period: "P1", seed: 240 })!;
    expect(elapsedOf(paused, 0)).toBe(240);
    expect(elapsedOf(pauseClock(startClock(paused, T0), T0 + 61_000), 0)).toBe(301);
  });

  it("and reseatClock never HANDS BACK a running clock it did not already hold", () => {
    // So the only way `nowMs` can become load-bearing is `toggleClockNow`,
    // which writes a real `Date.now()` in the same update that starts the run.
    for (const spec of [{ period: "P1" }, { period: "P1", seed: 0 }, { period: "P2", seed: 900 }]) {
      expect(reseatClock(null, spec)!.runningSince).toBeNull();
      expect(reseatClock(startClock(initClock("P0", 0), T0), spec)!.runningSince).toBeNull();
    }
    // The one clock it returns running is the caller's own, by reference —
    // which the caller had already given a real `nowMs`.
    const running = startClock(initClock("P1", 0), T0);
    expect(reseatClock(running, { period: "P1", seed: 5 })).toBe(running);
  });
});
