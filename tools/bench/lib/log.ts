// Structured JSON-lines logging for the scheduler bench.
//
// Follows the repo's established pino convention exactly:
// `packages/engine/src/scheduling/logger.ts` and `apps/web/src/server/
// logger.ts` are both a flat module-scope `pino({...})` singleton reading
// `LOG_LEVEL`, deliberately NOT `pino({ transport: {...} })` — a transport
// spawns a worker thread that does a dynamic `require()` of the transport
// target, which a bundler cannot statically trace (see either file's header
// for the full Next/Turbopack reasoning). This script runs under plain
// `node --experimental-strip-types` with no bundler at all, so that specific
// failure mode does not apply here — but there is no reason to depart from
// the convention anyway, so this mirrors it verbatim.
//
// `.child({ suite, phase })` layers per-suite/per-phase context onto every
// line from one singleton. The B01 spec calls for this explicitly even
// though no other logger.ts in the repo happens to use `.child()` yet — it
// is a plain, standard pino API, not a new convention being introduced.
import pino from "pino";

export const log = pino({ name: "bench", level: process.env.LOG_LEVEL ?? "info" });

/** A logger scoped to one suite (and optionally one phase within it). Every
 *  line it emits carries `{ suite }` or `{ suite, phase }` alongside the
 *  bench-wide fields, via pino's own `.child()`. */
export function suiteLogger(suite: string, phase?: string): pino.Logger {
  return phase ? log.child({ suite, phase }) : log.child({ suite });
}
