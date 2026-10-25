import "server-only";
// The per-sport engine-epoch FLOOR OVERRIDE: a default-off emergency lever on the scoring door's 426 gate (engine-split spec §5.6,
// review 1f lens 3; owner ruling 2026-10-15).
//
// WHY. `assertEngineEpoch` (usecases/scoring.ts) refuses a write whose `engine_epoch` is BELOW `foldEpochOf(sport)` with a 426. Once
// a bump reaches prod every capture app still on the old epoch is locked out of that sport until it updates, and the only way
// back used to be a Fly rollback. `ENGINE_EPOCH_FLOOR_OVERRIDE` lowers the floor for the named sports, on the server, with no
// deploy of code: `ENGINE_EPOCH_FLOOR_OVERRIDE=football=2,hockey=1` (a Fly secret; a restart picks it up).
//
// THE RULES.
//   - Default OFF. Unset or blank is "no override" and changes nothing.
//   - It can only LOWER a floor, never raise it: the floor for a sport is `min(foldEpochOf(sport), override)`. An override at or
//     above a sport's own epoch is INERT (the boot report says so), and it does not crash the boot: a stale entry left behind by
//     a later bump must not take prod down.
//   - It FAILS CLOSED. A value that is not understood (an unknown sport, an epoch that is not an integer >= 1, a duplicate, an
//     empty pair, a pair with no `=`) THROWS, at boot (instrumentation.ts) and at the gate. A typo can never silently become "no
//     override", and never a wrong floor.
//   - It is LOUD. The boot report logs one warning per sport, and the gate logs one warning per write it admitted ONLY because of
//     the override (`ENGINE_EPOCH_FLOOR_OVERRIDDEN`), so ops can see what the lever is letting through, and for how long.
//   - Production use is the point. This is NOT a `tunable()` (relay/config.ts), which is honoured only on local and ci.
//
// WHAT IT DOES NOT TOUCH. Absent `engine_epoch` is still accepted (D31), ahead is still accepted, a keyed retry still replays before
// any refusal, and authorisation / entitlement / phase refusals still outrank the gate. Nothing here changes the engine.
import { FOLD_EPOCH, foldEpochOf } from "@seazn/engine/sport";
import { log } from "@/server/logger";

export const ENGINE_EPOCH_FLOOR_OVERRIDE_ENV = "ENGINE_EPOCH_FLOOR_OVERRIDE";

type EnvReader = Record<string, string | undefined>;

/** An epoch is a positive decimal integer with no sign, no leading zero, no exponent, no fraction: nothing a typo can turn into a different number. */
const EPOCH = /^[1-9][0-9]*$/;

function bad(pair: string, why: string): never {
  throw new Error(
    `${ENGINE_EPOCH_FLOOR_OVERRIDE_ENV} is not understood: ${why}, in ${JSON.stringify(pair)}. ` +
      `Expected comma-separated sport=epoch pairs (an integer >= 1), e.g. "football=2,hockey=1"; sports: ${Object.keys(FOLD_EPOCH).join(", ")}`,
  );
}

/**
 * `ENGINE_EPOCH_FLOOR_OVERRIDE`'s value as a map of sport -> floor. Unset, empty or whitespace-only is OFF (an empty map).
 * Anything else must be fully understood or it THROWS, naming the pair at fault: this never returns a partial map.
 * The sport is checked against the engine's own `FOLD_EPOCH` keys with `Object.hasOwn` (a plain lookup would take `constructor`).
 */
export function parseEpochFloorOverride(raw: string | undefined): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  if (raw === undefined || raw.trim() === "") return out;
  for (const piece of raw.split(",")) {
    const pair = piece.trim();
    if (pair === "") bad(pair, "an empty pair (a stray comma)");
    const eq = pair.indexOf("=");
    if (eq === -1) bad(pair, 'a pair with no "="');
    const sport = pair.slice(0, eq).trim();
    const epoch = pair.slice(eq + 1).trim();
    if (!Object.hasOwn(FOLD_EPOCH, sport)) bad(pair, `unknown sport ${JSON.stringify(sport)}`);
    if (!EPOCH.test(epoch) || !Number.isSafeInteger(Number(epoch))) bad(pair, `the epoch ${JSON.stringify(epoch)} is not an integer >= 1`);
    if (out.has(sport)) bad(pair, `a duplicate sport ${JSON.stringify(sport)}`);
    out.set(sport, Number(epoch));
  }
  return out;
}

let memo: { raw: string; parsed: ReadonlyMap<string, number> } | undefined;

/**
 * THE accessor the gate and the boot report both read: the parsed override, parsed ONCE per distinct value (the variable is read
 * per call, which is a property read, but it is only parsed again if it changed - a test injects a value with the environment, or
 * passes an `env`). A value that throws is not remembered, so it throws on every read rather than becoming "no override".
 */
export function epochFloorOverride(env: EnvReader = process.env): ReadonlyMap<string, number> {
  const raw = env[ENGINE_EPOCH_FLOOR_OVERRIDE_ENV] ?? "";
  if (memo !== undefined && memo.raw === raw) return memo.parsed;
  const parsed = parseEpochFloorOverride(raw);
  memo = { raw, parsed };
  return parsed;
}

export interface EpochJudgement {
  /** The sport's own epoch (`foldEpochOf`). */
  declared: number;
  /** The EFFECTIVE floor: `min(declared, override)`, which is `declared` when there is no override or it is not lower. */
  floor: number;
  /** The write may proceed: the client is at or above the effective floor. */
  admitted: boolean;
  /** Admitted ONLY because of the override: the client is below the sport's own epoch but at or above the lowered floor. */
  viaOverride: boolean;
}

/** The gate's verdict for a client at `got`, for a sport whose own epoch is `declared`, with an optional override floor. Pure. */
export function judgeEngineEpoch(got: number, declared: number, override: number | undefined): EpochJudgement {
  const floor = override === undefined ? declared : Math.min(declared, override);
  const admitted = got >= floor;
  return { declared, floor, admitted, viaOverride: admitted && got < declared };
}

/**
 * Called once from instrumentation.ts's register() (nodejs runtime). Parses the override - a value that is not understood THROWS,
 * so the process does not boot on a typo, exactly as `relayDriverMode()` does for a faking deployment - and logs one warning per
 * sport: ACTIVE when the floor is below the sport's epoch (the lever is lowering it), INERT when it is not (it does nothing, and is
 * stale or mistaken). Logs nothing when the lever is off. Returns which sports landed in which bucket.
 */
export function reportEpochFloorOverrides(
  env: EnvReader = process.env,
  epochOf: (sport: string) => number = foldEpochOf,
): { active: string[]; inert: string[] } {
  const active: string[] = [];
  const inert: string[] = [];
  for (const [sport, floor] of epochFloorOverride(env)) {
    const required = epochOf(sport);
    if (floor < required) {
      active.push(sport);
      log.warn(
        { code: "ENGINE_EPOCH_FLOOR_OVERRIDE_ACTIVE", sport, floor, required },
        `${ENGINE_EPOCH_FLOOR_OVERRIDE_ENV} ACTIVE: ${sport} scoring writes from clients at epoch ${floor} or above are ADMITTED although the fold epoch is ${required} - an emergency lever; remove ${sport} from it once those clients have updated`,
      );
    } else {
      inert.push(sport);
      log.warn(
        { code: "ENGINE_EPOCH_FLOOR_OVERRIDE_INERT", sport, floor, required },
        `${ENGINE_EPOCH_FLOOR_OVERRIDE_ENV}: ${sport}=${floor} has no effect (the fold epoch is ${required}, which is not above it) - a stale entry; remove it`,
      );
    }
  }
  return { active, inert };
}
