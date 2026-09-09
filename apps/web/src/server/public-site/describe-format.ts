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
// WHAT IS NOT DESCRIBED, and why it is null rather than wrong: the period
// sports (hockey, icehockey) declare `periods: {count, minutes}` and so have
// exactly the same "total minutes" fact football does — but the only key in
// scope is `format.football.minutes`, and printing a football-named sentence
// for a hockey match is the same defect `SHOOTOUT_IS_SKATED`
// (`lib/scoring-vocab.ts`) exists to undo. They return null here and the
// renderer falls back to `variantKey`. A sport-neutral `format.minutes` key
// would close it; that is dictionary work, which Task 6 owns.
import type { AnySportModule } from "@seazn/engine/sport";
import type { MsgT } from "./match-centre-schema";

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
      const half = c.halfMinutes;
      // `halves` is the PLAY-PERIOD COUNT, 2 or 4 — mini-soccer plays four
      // quarters, so a hardcoded `× 2` prints 20 minutes for a 40-minute
      // match. Read both, always.
      const halves = c.halves;
      if (typeof half !== "number" || typeof halves !== "number") return null;
      const minutes = half * halves;
      if (!(minutes > 0)) return null;
      return { key: "format.football.minutes", params: { minutes } };
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
