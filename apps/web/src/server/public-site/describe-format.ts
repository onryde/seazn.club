// Spectator surface W2, Task 4 — the division's FORMAT sentence.
//
// PURE: takes the already-resolved module and the raw `divisions.config` blob,
// returns a `Msg` (a dictionary key plus params) or null. No `sql`, no
// `server-only`, no dictionary — the hub document carries `formatLine` as a
// Msg precisely so the sentence stays translatable, and the renderer resolves
// it. A string built here would be English by construction.
//
// ---------------------------------------------------------------------------
// THE MODULE IS PASSED IN, not resolved here, and that is a deliberate
// deviation from the task brief (which called `resolveLatestModule(sportKey)`
// inside this function).
//
// A division PINS its `module_version` at creation and every other read path
// in this tree honours that pin — `match-centre-load.ts` parses the fixture
// config through `resolveModule(sportKey, moduleVersion).configSchema`, and
// `leaders.ts` says so in as many words ("never `resolveLatestModule`, so a
// running division always labels under the build it started with"). Resolving
// the LATEST module here would parse a running division's config under a
// schema it was never written against, which is exactly the drift those two
// files avoid. Taking the module also keeps this file free of
// `@/server/engine-db/registry` (which is `server-only`) and trivially
// unit-testable.
// ---------------------------------------------------------------------------
//
// THE MINUTES SENTENCE IS SPORT-NEUTRAL (owner ruling, 2026-09-09).
//
// Football declares `halfMinutes × halves`; the period sports (hockey,
// icehockey) declare `periods: {count, minutes}`. Those are the same fact —
// how long the match runs — so all three emit ONE key, `format.minutes`
// ("{minutes} min"), rather than a football-named sentence printed over a
// hockey match. That last shape is the defect `SHOOTOUT_IS_SKATED`
// (`lib/scoring-vocab.ts`) exists to undo, and the first draft of this file
// shipped hockey a NULL rather than commit it. Task 6 authors the four locale
// strings; nothing here creates a dictionary key.
import type { AnySportModule } from "@seazn/engine/sport";
import type { MsgT } from "./match-centre-schema";

/**
 * The product of the declared factors, as a minutes sentence — or NOTHING.
 *
 * ONE guard, applied per FACTOR, deliberately: an earlier shape coerced each
 * factor to a sentinel and then range-checked the product, which made the
 * choice of sentinel (NaN vs 0) unobservable — the two guards covered for each
 * other and a mutant swapping them survived the whole suite. Checking each
 * factor where it is read leaves nothing that can be changed without a test
 * noticing.
 *
 * NEVER ZERO. `Number("")` is `0` in this codebase and a chip reading "0 min"
 * is a confident lie — strictly worse than the blank chip that ships when there
 * is nothing to say, because a reader cannot tell it from a real answer. A
 * config that does not declare a total (a division pinned to a module version
 * that predates the field, or a schema that stops declaring it) yields `null`
 * and the renderer falls back to `variantKey`.
 *
 * No SHIPPED module can produce `0` today — football's `halfMinutes` is
 * `positive()` and the period kernel's `periods.count` is `min(1)` — so this is
 * a rule about what may EVER reach a spectator rather than a filter on current
 * data, and the suite pins it with a permissive module double.
 */
function minutesFrom(...factors: readonly unknown[]): MsgT | null {
  let minutes = 1;
  for (const factor of factors) {
    // `typeof` is here for tsc's narrowing (`minutes *= factor` needs a
    // number); at RUNTIME it is implied by `Number.isFinite`, which does not
    // coerce and so already answers false for `undefined`, `""` and every
    // other non-number. `Number.isFinite` is the clause that earns its place:
    // `NaN` and `Infinity` are both `typeof "number"` and both pass `<= 0`.
    if (typeof factor !== "number" || !Number.isFinite(factor) || factor <= 0) return null;
    minutes *= factor;
  }
  return { key: "format.minutes", params: { minutes } };
}

/**
 * A one-line description of what shape of match this division plays.
 *
 * `cfg` is the raw `divisions.config` jsonb — parsed through the module's own
 * `configSchema` with `safeParse`, never `parse`: `fixture-cfg.ts` records
 * that "`{}` is a legitimate config for several modules" and that throwing on
 * the read path took down a whole public response once. A config the schema
 * refuses yields no sentence, not an exception.
 *
 * Returns null wherever the format cannot be described honestly — an
 * unresolved module, a refused config, a timeless innings, or a sport whose
 * configuration says nothing a spectator would call a format.
 */
export function describeFormat(
  sportKey: string,
  module_: AnySportModule | null | undefined,
  cfg: unknown,
): MsgT | null {
  if (!module_) return null;
  const parsed = module_.configSchema.safeParse(cfg);
  if (!parsed.success) return null;
  const c = parsed.data as Record<string, unknown>;

  switch (sportKey) {
    case "cricket": {
      const balls = c.ballsPerInnings;
      const perOver = c.ballsPerOver;
      // `ballsPerInnings` is nullable in the schema — a timeless/declaration
      // match has no over count to state.
      if (typeof balls !== "number" || typeof perOver !== "number" || perOver <= 0) return null;
      const overs = balls / perOver;
      // A ball count that does not divide into whole overs is a real config
      // (the schema permits it); "8.333 overs" is not a format anybody
      // recognises, so it goes unstated rather than rendered.
      if (!Number.isInteger(overs) || overs <= 0) return null;
      return { key: "format.cricket.overs", params: { overs } };
    }
    case "football": {
      // `halves` is the PLAY-PERIOD COUNT, 2 or 4 — mini-soccer plays four
      // quarters, so a hardcoded `× 2` prints 20 minutes for a 40-minute
      // match. Read both, always.
      return minutesFrom(c.halfMinutes, c.halves);
    }
    case "hockey":
    case "icehockey": {
      // The period kernel's own declaration (`sports/period/kernel.ts`):
      // `periods: {count, minutes}`. Same fact as football's, same key.
      // Named sports rather than sniffed by shape: `periods` is also the name
      // of a per-phase SCORE breakdown on `ScoreSummary.detail`, and a
      // shape-sniffing branch here would be one rename away from reading the
      // wrong one.
      // No `typeof === "object"` guard: reading a property off a primitive
      // auto-boxes and yields `undefined`, which `minutesFrom` refuses, so a
      // `periods: 60` config answers null either way. The guard that used to
      // sit here was unobservable — a mutant removing it survived the whole
      // suite, which is the definition of decoration.
      const p = (c.periods ?? {}) as Record<string, unknown>;
      return minutesFrom(p.count, p.minutes);
    }
    default: {
      // BY SHAPE, not by a list of sport keys: `bestOf` is declared by the
      // set-based kernel (badminton, table tennis, volleyball), the nested
      // kernel (tennis) and carrom, and a sixth sport arriving on any of them
      // gets the sentence with no edit here. A sport that declares no
      // `bestOf` — generic, boardgame, the period sports — says nothing.
      const bestOf = c.bestOf;
      if (typeof bestOf !== "number" || bestOf <= 0) return null;
      return { key: "format.sets.bestOf", params: { n: bestOf } };
    }
  }
}
