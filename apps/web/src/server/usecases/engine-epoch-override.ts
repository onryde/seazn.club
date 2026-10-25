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
//   - It is understood or it is OFF, never a guess. A value that is not understood (an unknown sport, an epoch that is not an
//     integer >= 1, a duplicate, an empty pair, a pair with no `=`) is OFF: every sport keeps its declared floor, which is today's
//     behaviour with the lever off. Boot (instrumentation.ts) reads it strictly and, for such a value, logs it as an error,
//     reports the parse error to Sentry (flushed) and CARRIES ON BOOTING with the lever OFF. It must not throw: a typo in an
//     emergency lever must not become a site outage, and a rejected `register()` is cached by Next and fails every route,
//     /api/health included, until a restart.
//     The GATE reads it through `epochFloorOverrideOrOff`, which never throws either: it logs `log.error` (and reports to Sentry
//     when this process initialised it) once per distinct bad value, and nothing here echoes the variable's text into an HTTP body.
//   - It is LOUD. Boot logs one warning per sport, with how many majors behind the floor is, and sends the same to Sentry as a
//     warning (an error when the floor is more than one major behind: a forgotten entry that has widened across a later bump).
//     The gate logs a warning for each request it admitted ONLY because of the override (`ENGINE_EPOCH_FLOOR_OVERRIDDEN`): at
//     most one line per request that passed the gate, so ops can see what the lever is letting through, and for how long. That
//     line says the gate admitted the request, not that a row was written: a keyed retry the cache could not answer passes the
//     gate again and is then replayed, and a stale `expected_seq` can still be refused after admission. Per-request lines are
//     never a Sentry Issue (pino lines still reach Sentry Logs through the pino integration); boot's alerts are.
//   - Production use is the point. This is NOT a `tunable()` (relay/config.ts), which is honoured only on local and ci.
//
// WHAT IT DOES NOT TOUCH. Absent `engine_epoch` is still accepted (D31), ahead is still accepted, a keyed retry still replays before
// any refusal, and authorisation / entitlement / phase refusals still outrank the gate. Nothing here changes the engine.
import * as Sentry from "@sentry/nextjs";
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
 * THE strict accessor: the parsed override, parsed ONCE per distinct value (the variable is read per call, which is a property read,
 * but it is only parsed again if it changed - a test injects a value with the environment, or passes an `env`). A value that
 * throws is not remembered, so it throws on every read. Boot uses this one, so a bad value stops the boot.
 */
export function epochFloorOverride(env: EnvReader = process.env): ReadonlyMap<string, number> {
  const raw = env[ENGINE_EPOCH_FLOOR_OVERRIDE_ENV] ?? "";
  if (memo !== undefined && memo.raw === raw) return memo.parsed;
  const parsed = parseEpochFloorOverride(raw);
  memo = { raw, parsed };
  return parsed;
}

const NO_OVERRIDE: ReadonlyMap<string, number> = new Map();
/** Bad values already reported in this process: one report per distinct raw value, however many reads or reporters. */
const reportedInvalid = new Set<string>();

/** What the log and Sentry say about a value that is not understood. Carries the parse error's message (which quotes the text). */
export const epochFloorOverrideInvalidMessage = (e: unknown): string =>
  `${e instanceof Error ? e.message : String(e)} - the override is OFF for this process: every sport keeps its declared floor`;

/** Claims the report of a bad raw value for this process: true the first time, false after. Boot and the gate share it, so one
 *  typo is one report, not one from boot and another from the first scoring write. */
function claimInvalidReport(raw: string): boolean {
  if (reportedInvalid.has(raw)) return false;
  reportedInvalid.add(raw);
  return true;
}

/**
 * Boot's report of a value the strict parse refused (instrumentation.ts calls it, then CARRIES ON): an error line, the parse error
 * to Sentry as an exception, flushed (the first thing a process with a bad secret does may be to fall over for another reason), and
 * the value marked as reported so the gate does not say it a second time. Resolves; never throws on the value's account.
 */
export async function reportInvalidEpochFloorOverride(e: unknown, env: EnvReader = process.env): Promise<void> {
  claimInvalidReport(env[ENGINE_EPOCH_FLOOR_OVERRIDE_ENV] ?? "");
  log.error({ code: "ENGINE_EPOCH_FLOOR_OVERRIDE_INVALID" }, epochFloorOverrideInvalidMessage(e));
  Sentry.captureException(e);
  await Sentry.flush(2000);
}

/**
 * The accessor THE GATE reads (usecases/scoring.ts `assertEngineEpoch`): the same parse, but a value that is not understood is OFF
 * rather than an exception. Boot has already reported such a value and carried on, so in a booted process this stays quiet; in a
 * process that never ran boot (a hand-staged tree without instrumentation) it reports ONCE per distinct bad value with `log.error`
 * and a Sentry error message (a no-op where Sentry was never initialised). The result is the declared floors for every sport
 * (today's behaviour). The report carries the parse error's message (which quotes the variable's text), and nothing returned to a
 * client does.
 */
export function epochFloorOverrideOrOff(env: EnvReader = process.env): ReadonlyMap<string, number> {
  try {
    return epochFloorOverride(env);
  } catch (e) {
    if (claimInvalidReport(env[ENGINE_EPOCH_FLOOR_OVERRIDE_ENV] ?? "")) {
      const message = epochFloorOverrideInvalidMessage(e);
      log.error({ code: "ENGINE_EPOCH_FLOOR_OVERRIDE_INVALID" }, message);
      Sentry.captureMessage(message, "error");
    }
    return NO_OVERRIDE;
  }
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

/** One sport's entry in the boot report: the override's floor against the sport's own epoch (`declared`). */
export interface EpochOverrideEntry {
  sport: string;
  floor: number;
  declared: number;
}

/** How many majors the floor sits below the sport's own epoch: 1 is the lever doing its job after a bump, 2 or more is an entry that
 *  was forgotten across a later bump and now admits clients further behind than anyone decided. */
export const majorsBehind = (e: EpochOverrideEntry): number => e.declared - e.floor;

/** What boot says about an ACTIVE entry. Also what it sends to Sentry, so the log and the alert read the same. */
export const epochFloorOverrideActiveMessage = (e: EpochOverrideEntry): string =>
  `${ENGINE_EPOCH_FLOOR_OVERRIDE_ENV} ACTIVE: ${e.sport} scoring writes from clients at epoch ${e.floor} or above are ADMITTED although the fold epoch is ${e.declared} (majorsBehind=${majorsBehind(e)}) - an emergency lever; remove ${e.sport} from it once those clients have updated`;

/** The Sentry level of an ACTIVE entry: a warning for one major behind, an error for more than one. The pino line stays a warning. */
export const epochFloorOverrideSentryLevel = (e: EpochOverrideEntry): "warning" | "error" => (majorsBehind(e) > 1 ? "error" : "warning");

/**
 * Called once from instrumentation.ts's register() (nodejs runtime). Parses the override STRICTLY - a value that is not understood
 * THROWS from here, and register() reports it (`reportInvalidEpochFloorOverride`) and carries on with the lever off - and logs one
 * warning per sport: ACTIVE when the floor is below the sport's epoch (the lever is lowering it), INERT when it is not (it does
 * nothing, and is stale or mistaken). Logs nothing when the lever is off. Returns which sports landed in which bucket, so the
 * caller can alert on the ACTIVE ones (instrumentation.ts sends each to Sentry, at `epochFloorOverrideSentryLevel`).
 */
export function reportEpochFloorOverrides(
  env: EnvReader = process.env,
  epochOf: (sport: string) => number = foldEpochOf,
): { active: EpochOverrideEntry[]; inert: EpochOverrideEntry[] } {
  const active: EpochOverrideEntry[] = [];
  const inert: EpochOverrideEntry[] = [];
  for (const [sport, floor] of epochFloorOverride(env)) {
    const entry = { sport, floor, declared: epochOf(sport) };
    if (floor < entry.declared) {
      active.push(entry);
      log.warn({ code: "ENGINE_EPOCH_FLOOR_OVERRIDE_ACTIVE", ...entry, majorsBehind: majorsBehind(entry) }, epochFloorOverrideActiveMessage(entry));
    } else {
      inert.push(entry);
      log.warn(
        { code: "ENGINE_EPOCH_FLOOR_OVERRIDE_INERT", ...entry },
        `${ENGINE_EPOCH_FLOOR_OVERRIDE_ENV}: ${sport}=${floor} has no effect (the fold epoch is ${entry.declared}, which is not above it) - a stale entry; remove it`,
      );
    }
  }
  return { active, inert };
}
