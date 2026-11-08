// Swiss auto-advance: the settle window (spec docs/superpowers/specs/2026-11-08-swiss-auto-advance-design.md §4.2, G3;
// plan D8). An auto action fires only on facts that have stood this long, and every relevant change restarts it.
//
// 60 s is a constant, not a setting (`AUTO_ADVANCE_SETTLE_MS`, lib/auto-advance.ts). The one exception is CI's e2e,
// which would otherwise wait out a full minute per armed row: there `E2E_AUTO_ADVANCE_SETTLE_MS` may SHORTEN it, and
// only when BOTH hold (AGENTS.md class 20; controller ruling, Task 5):
//   - the explicit e2e flag `E2E_PROD_TARGET=1` is set. e2e.yml sets it at JOB level, so the CI server and its
//     Playwright runner read the same value; nothing that ships sets it (settle.test.ts scans every deploy config). A
//     stray override variable on a deployed machine is therefore inert on its own;
//   - the override is a whole number of milliseconds in [SETTLE_OVERRIDE_MIN_MS, AUTO_ADVANCE_SETTLE_MS]. Its ceiling is
//     the default, so it can never lengthen the window either. Anything else (empty, `1e4`, `5000ms`, out of range)
//     falls back to the default: `Number("")` is 0, the trap a bare `Number()` read walks into.
//
// The value guard pins the DEFAULT, never the live value (settle.test.ts), so the override cannot move what it checks.
//
// Strip-types safe on purpose (relative `.ts` import, no `server-only`, no path alias): the e2e spec and the smoke suite
// import it to derive the window they expect from the same environment the server reads.
import { AUTO_ADVANCE_SETTLE_MS } from "../../lib/auto-advance.ts";

/** The CI-only override of the settle window, in milliseconds. */
export const SETTLE_MS_ENV_VAR = "E2E_AUTO_ADVANCE_SETTLE_MS";
/** The explicit e2e flag without which the override is ignored. */
export const SETTLE_OVERRIDE_FLAG = "E2E_PROD_TARGET";
/** The shortest window the override may set: long enough that a correction made by a test still lands inside it. */
export const SETTLE_OVERRIDE_MIN_MS = 2_000;

/** The settle window this process arms with: the spec's 60 s, unless CI's e2e flag and a usable override are both set. */
export function resolveSettleMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  if (env[SETTLE_OVERRIDE_FLAG] !== "1") return AUTO_ADVANCE_SETTLE_MS;
  const raw = env[SETTLE_MS_ENV_VAR];
  // Digits only, nothing around them: rejects "", " 5000", "5000.5", "1e4", "0x1388", "-3000" and "Infinity" up front.
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return AUTO_ADVANCE_SETTLE_MS;
  const ms = Number(raw);
  if (!Number.isSafeInteger(ms) || ms < SETTLE_OVERRIDE_MIN_MS || ms > AUTO_ADVANCE_SETTLE_MS) return AUTO_ADVANCE_SETTLE_MS;
  return ms;
}
