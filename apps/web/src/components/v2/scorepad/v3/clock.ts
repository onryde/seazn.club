// v3/clock.ts — THE PAD-LOCAL MATCH CLOCK (R6/task A, owner ruling R6-4).
//
// WHAT WAS MISSING. `core/time.ts:6-9` states the engine's side of this
// outright: "The engine owns no clock... `at` is a frozen fact recorded by the
// pad." There is no start/stop/adjust-clock event anywhere in the period
// kernel, and there never will be — a countdown is a pad rendering a duration
// against a known start, not the engine racing real time. The READ side has
// been correct since R3: `skins/football.tsx`'s `readClock` reads `state.asOf`
// and drops the strip item when it is absent or names a phase the match has
// left. The WRITE side had never existed. `state.asOf` is set ONLY by a
// stamped event's `at`, and no v3 tile sent `at` — except the swap, which
// copies an `asOf` that must already exist — so a stream recorded entirely
// through this pad had NO clock, ever, and football's own comment recorded
// that as an open engine-side question. It was neither: it is this file.
//
// It is not only the clock that was inert. `period/suspensions.ts:137-153`
// derives `ActiveSuspension.expiresAt` ONCE, at start, from `startedAt` plus
// the awarded minutes — and `startedAt` comes from the suspension event's own
// `at`. No `at` means no `expiresAt`, so the power-play countdown never ran
// either. One missing stamp, two dead features.
//
// SIX PROPERTIES, each forced rather than chosen:
//
//  1. PAD-LOCAL AND SCORER-CONTROLLED. It starts on a tap, it pauses on a tap,
//     and nothing persists the ticking value. Persisting it would be inventing
//     a second, authoritative clock the engine has deliberately refused to own.
//  2. NEVER DERIVED FROM WALL TIME SINCE THE PERIOD STARTED. Hockey and ice
//     hockey are STOP-CLOCK sports: the game clock does not move during a
//     stoppage (`core/time.ts` §1.2 — "a minor started at 761 expires at 881
//     whether or not an eight-minute injury delay intervened"). So wall-clock
//     delta accrues ONLY between a start and the next pause, and `base` banks
//     what previous runs accumulated. A running-clock sport is the same
//     machine with fewer pauses; a wall-time-since-kickoff clock could not
//     represent either sport correctly.
//  3. IT SEEDS FROM THE FOLD, ONCE PER PERIOD. A reload — or a second device
//     joining a match already in progress — picks up from the last stamped
//     event rather than from zero. But the seed is a BOOTSTRAP, not a leash:
//     re-applying it after every fold advance would snap a running clock back
//     to the last event's time on every single tap. `reseatClock` is where
//     that guard lives, and it is the one function in this file worth
//     mutating to check.
//  4. IT SEATS PAUSED. The pad cannot know whether play is running at the
//     moment it mounts, and `skins/football.tsx`'s `stampOf` already settled
//     what to do about an unknown: "A WRONG stamp silently mis-attributes a
//     stoppage — and, through `applySub`'s window arithmetic, could refuse a
//     legal substitution or admit an illegal one. Do not 'fix' this later by
//     stamping unconditionally." A clock that auto-ran on mount would stamp a
//     match being written up from a paper sheet with the time since the tab
//     opened.
//  5. A PAUSED CLOCK STILL STAMPS. In a stop-clock sport the whistle time IS
//     the game time of everything recorded during the stoppage — a penalty
//     awarded at the whistle happened at the whistle. Refusing to stamp while
//     paused would leave the commonest events in these two sports unstamped,
//     which is the state this file exists to end.
//  6. BUT A CLOCK THAT HAS NEVER BEEN TOLD THE TIME STAMPS NOTHING. Properties
//     4 and 5 together, on their own, said something this file never meant: a
//     pad mounted on a fresh match seats PAUSED at zero and stamps while
//     paused, so every event would carry `{period, 0}` until somebody tapped
//     Start — and property 3 guarantees nothing ever corrects it, because
//     `reseatClock` refuses to follow `spec.seed` once seated. Thirty minutes
//     of scoring, every event claiming minute zero.
//
//     That is WORSE than the emptiness this file replaced, not better. An
//     absent `at` is visibly absent: `skins/football.tsx`'s `readClock` drops
//     the strip item, and `period/suspensions.ts` leaves `expiresAt`
//     underivable. A fabricated zero makes both present and WRONG — a clock
//     frozen at 0:00, and a card awarded at minute 30 whose `expiresAt` is
//     `0 + minutes`, already past, so the lazy sweep can never fire and
//     release-on-goal turns on a `startedAt` that never happened.
//
//     `PadClock.known` is the flag, and it gates the STAMP alone. The bar
//     still renders, still shows 0:00, still offers Start. What it will not do
//     is invent an observation nobody made. It flips true on the first Start
//     tap, or immediately when the FOLD seeds it (`PadClockSpec.seed` present
//     — the reload and second-device path), and it goes false again at a
//     period change, because a new period genuinely has no observation yet.
//
// PURE, and deliberately in its own file rather than inside `pad-host.tsx`:
// apps/web vitest is `environment: "node"` with NO jsdom, so anything needing
// a DOM cannot be unit-tested at all. Every decision lives here as data-in/
// data-out; `pad-host.tsx` keeps only the `useState`/`setInterval` wiring and
// the one button.

/**
 * The `at` a dispatched event carries — structurally the engine's own
 * `GameTime` (`core/time.ts`: `z.strictObject({period, elapsed})`), restated
 * here as a plain interface rather than imported so this module stays a LEAF
 * with no engine import at all. `elapsed` is GAME seconds counted UP from the
 * start of `period`, a non-negative integer (`DurationSeconds`).
 */
export interface GameTimeStamp {
  readonly period: string;
  readonly elapsed: number;
}

/**
 * What a skin declares when it wants a clock — see `SkinDefV3.clock` in
 * types.ts. Two fields, because the chassis knows neither.
 */
export interface PadClockSpec {
  /**
   * The ENGINE phase name every stamp will carry ("H1", "P2", "OT"...). The
   * chassis has no sport vocabulary and `PadHostView.phase` is the three-value
   * UI concept, never an engine phase — so this can only come from the skin.
   */
  readonly period: string;
  /**
   * Seconds already elapsed in THAT period according to the fold — i.e.
   * `state.asOf.elapsed` when the fold's own stamp names this period, and 0
   * (or omitted) otherwise. The skin applies its own staleness guard because
   * only the skin knows its state's shape; `readClock`/`stampOf` in
   * `skins/football.tsx` are that guard, already written.
   */
  readonly seed?: number;
}

/**
 * The pad's clock, as data. Not `{elapsed}` — a stored elapsed would have to
 * be rewritten by a timer, which is what makes a ticking value a persistence
 * hazard. `base` + `runningSince` is derivable at any instant from `Date.now()`
 * and cannot drift with the render rate.
 */
export interface PadClock {
  /** The engine phase this clock counts within. Changing it RESETS the origin. */
  readonly period: string;
  /** Whole seconds banked by every previous run. */
  readonly base: number;
  /** Wall ms when the current run began, or `null` when paused. */
  readonly runningSince: number | null;
  /**
   * PROPERTY 6 — has this clock ever been told what time it is?
   *
   * TRUE once either source of truth has spoken: the FOLD handed it one
   * (`PadClockSpec.seed` present — a reload, or a second device joining a match
   * already stamped), or a SCORER tapped Start at least once. FALSE means the
   * pad is displaying 0:00 because it has nothing better to display, not
   * because the match is at second zero — and `stampOf` refuses to turn that
   * into an observation. See property 6's own note in this file's header.
   */
  readonly known: boolean;
}

/** A paused clock at `seed` seconds into `period`. Non-integer, negative and
 *  non-finite seeds are floored/clamped rather than trusted: `DurationSeconds`
 *  is `int().nonnegative()`, and an `at` the engine rejects would take the
 *  whole event down with it.
 *
 *  `seed` OMITTED and `seed: 0` are DIFFERENT, and the difference is the whole
 *  of property 6: omitted means "the fold has no stamp in this period", while 0
 *  means "the fold has a stamp, and it sits at second 0". `initClock(p)` is
 *  therefore unknown and `initClock(p, 0)` is known — do not "simplify" this
 *  back to a `seed = 0` default parameter. */
export function initClock(period: string, seed?: number): PadClock {
  return { period, base: sanitiseSeconds(seed ?? 0), runningSince: null, known: seed !== undefined };
}

/** Whole game seconds at `nowMs`. Constant while paused — property 2. */
export function elapsedOf(clock: PadClock, nowMs: number): number {
  if (clock.runningSince === null) return clock.base;
  // `Math.max(0, ...)` guards a backwards system clock (an NTP correction, a
  // laptop waking up). Without it a stamp could go negative, which the
  // engine's `DurationSeconds` refuses outright.
  const ran = Math.max(0, Math.floor((nowMs - clock.runningSince) / 1000));
  return clock.base + ran;
}

/** Resume. A clock already running is returned UNCHANGED (by reference), so a
 *  double-tap or a re-render cannot silently re-base the run and lose the
 *  seconds already banked. */
export function startClock(clock: PadClock, nowMs: number): PadClock {
  if (clock.runningSince !== null) return clock;
  // The Start tap IS the observation (property 6): a scorer pressing it is
  // asserting that play is running now, at the displayed time.
  return { ...clock, runningSince: nowMs, known: true };
}

/** Stop, banking what the current run accrued. Already-paused is unchanged.
 *  Spreads rather than rebuilding, so a field added to `PadClock` later cannot
 *  be silently dropped here — `known` was, in the first draft of this file. */
export function pauseClock(clock: PadClock, nowMs: number): PadClock {
  if (clock.runningSince === null) return clock;
  return { ...clock, base: elapsedOf(clock, nowMs), runningSince: null };
}

export function toggleClock(clock: PadClock, nowMs: number): PadClock {
  return clock.runningSince === null ? startClock(clock, nowMs) : pauseClock(clock, nowMs);
}

/**
 * THE GUARD (property 3). Given what the host is holding and what the skin
 * declares right now, the clock the host should hold next.
 *
 *   spec === null                  -> no clock at all (skin declares none, or
 *                                     declares none in this phase: pre-match,
 *                                     full time).
 *   no clock yet, or the PERIOD    -> a fresh, PAUSED clock seeded from the
 *   changed                           fold. This is the "resets its origin at
 *                                     each period" rule and the reload path,
 *                                     in one branch, because they are the same
 *                                     event: this clock has no history for
 *                                     that period.
 *   otherwise                      -> the caller's own clock, BY REFERENCE.
 *
 * That last branch is the whole point, and it is the mutation target for this
 * file. `PadClockSpec.seed` is rebuilt on EVERY render from a fold that
 * advances on every tap, so a `reseatClock` that re-seeded whenever the seed
 * changed would drag a running clock back to the last stamped event's time
 * once per event — a clock that only ever showed the past, ticking forward for
 * a second at a time before snapping back. Returning `prev` by reference (not
 * a clone) also keeps the host's render-phase `!==` check honest.
 */
export function reseatClock(prev: PadClock | null, spec: PadClockSpec | null): PadClock | null {
  if (spec === null) return null;
  // `spec.seed` is forwarded VERBATIM, undefined included — `?? 0` here would
  // erase property 6's whole distinction and make every fresh period claim to
  // know that it is at second zero.
  if (prev === null || prev.period !== spec.period) return initClock(spec.period, spec.seed);
  return prev;
}

/** The `at` for an event dispatched at `nowMs`, or `undefined` when this pad
 *  has no clock, or has one that has never been told the time (property 6).
 *  Stamps while PAUSED too — property 5. */
export function stampOf(clock: PadClock | null, nowMs: number): GameTimeStamp | undefined {
  if (clock === null || !clock.known) return undefined;
  return { period: clock.period, elapsed: elapsedOf(clock, nowMs) };
}

/** M:SS. The same rendering `skins/football.tsx`'s `readClock` produces from
 *  the fold, so the ticking display and the fold's own strip item cannot
 *  disagree about format. Minutes are NOT capped at 60 and not zero-padded:
 *  football's `90+3` is minute 48 of H2, and every one of these sports counts
 *  minutes within a period rather than clock time of day. */
export function formatClock(seconds: number): string {
  const whole = sanitiseSeconds(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** Anything with zod's `safeParse` shape. Structural rather than
 *  `z.ZodTypeAny`, so this module imports neither zod nor the engine — the
 *  same leaf discipline `sport-theme.ts` keeps. */
export interface PayloadSchemaProbe {
  safeParse(value: unknown): { success: boolean };
}

/**
 * The dispatched payload, with `at` attached — WHEN, AND ONLY WHEN, THE
 * ENGINE'S OWN SCHEMA FOR THAT EVENT TYPE ACCEPTS IT.
 *
 * WHY THE SCHEMA AND NOT A LIST. `at` is `GameTime.optional()` on all nine of
 * football's payloads and on the period kernel's seven, and on seven of the
 * fourteen `CORE_EVENT_SCHEMAS` (`core.suspend`, `core.resume` and all five
 * `core.lineup.*`). The other seven — `core.start`, `core.void`,
 * `core.forfeit`, `core.abandon`, `core.finalize`, `core.note`, `core.award` —
 * are `z.strictObject`s WITHOUT it, so an unexpected `at` is a hard parse
 * failure there, not a harmless extra key. A blanket stamp would break the
 * very events it touched, and a hand-kept list would have to know which half
 * each type is in. (This paragraph itself got that wrong first time: it filed
 * the whole `core.lineup.*` family under "no `at`", when all five declare one.
 * The enumeration now lives in `__tests__/clock.test.ts` as an assertion over
 * the engine's own export, so prose cannot drift from the table again.)
 *
 * The obvious fix is for the skin to declare which of its types are
 * stampable. That is a MIRROR of the engine, and this programme has now paid
 * for mirrors twice (`refusedEventTypes`' own doc in types.ts: "A skin that
 * declares this is mirroring its own engine, which is the thing this programme
 * keeps getting wrong"). So the question is put to the engine instead: probe
 * the module's own `eventSchemas[type]` with the stamp applied, and keep it
 * only if it parses. A payload schema that grows or loses `at` is followed
 * automatically, in every sport, with nothing to keep in step.
 *
 * FAILS SAFE IN EVERY DIRECTION. No stamp, no schema registered, a payload
 * that is not a plain object, or a probe that throws — each returns the
 * caller's payload BY REFERENCE, so this can never turn a dispatch that would
 * have worked into one that does not. Note the corollary: if the payload was
 * already invalid for an unrelated reason, the probe fails and the stamp is
 * dropped; the event still goes out and still gets refused, exactly as before.
 *
 * THE SKIN OWNS THE FIELD; THE CHASSIS FILLS A BLANK. If the payload already
 * carries an `at` KEY this function returns it untouched, by reference —
 * whatever the key's value, `undefined` included.
 *
 * The first cut of this file did the opposite, overwriting a skin-supplied
 * `at` on the grounds that "the live clock is strictly closer to now". That
 * deleted a decision `skins/football.tsx` records in its own `stampOf`, whose
 * comment ends "Do not 'fix' this later by stamping unconditionally": a wrong
 * `at` on a substitution feeds `applySub`'s window arithmetic and can refuse a
 * legal sub or admit an illegal one, so football derives it from `state.asOf`
 * with an explicit staleness guard. The chassis cannot see any of that. Nor is
 * the live clock reliably closer to now — before property 6 it read zero on a
 * pad nobody had started, and overwriting a real fold stamp with that zero is
 * the exact failure the skin's guard exists to prevent.
 *
 * THE KEY IS THE SIGNAL, NOT THE VALUE, so a skin that declares a clock for
 * the match can still refuse a stamp on ONE payload by writing `at: undefined`
 * explicitly. `GameTime.optional()` accepts that, so the event dispatches and
 * folds exactly as it would have; it simply carries no time. A skin that
 * OMITS the key entirely has expressed no opinion and gets the clock's stamp —
 * which is what keeps this wave from being inert, since every tile payload in
 * the tree omits `at`.
 */
export function stampPayload(
  payload: unknown,
  stamp: GameTimeStamp | undefined,
  schema: PayloadSchemaProbe | undefined,
): unknown {
  if (stamp === undefined || schema === undefined) return payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
  if ("at" in payload) return payload;
  const stamped = { ...(payload as Record<string, unknown>), at: { period: stamp.period, elapsed: stamp.elapsed } };
  try {
    return schema.safeParse(stamped).success ? stamped : payload;
  } catch {
    return payload;
  }
}

/** Whole, finite, non-negative — the `DurationSeconds` contract, applied at
 *  every boundary where a number enters this module from outside it. */
function sanitiseSeconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}
