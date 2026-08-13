// S12/#421 W10 — the single home for "does this fixture render the v2 pad".
//
// WHY A WRAPPER RATHER THAN TWO `isServerFeatureEnabled` CALLS: the two entry
// points (`FixtureConsole` and `/score/[token]`) read the same flag, and the
// whole point of this session is that two near-duplicate dispatchers with no
// drift guard are how the v1 pads diverged — `device-score-pad.tsx` is missing
// a `carrom` branch `fixture-console.tsx` has, so carrom has been unscoreable
// over a device link. Two independent flag reads are that same shape one level
// up: a later session changes the fallback, or the distinctId, or the flag
// name in one of them and the entry points silently disagree about which pad a
// scorer gets. One function, two callers.
//
// WHY THE ENV OVERRIDE EXISTS: `isServerFeatureEnabled` returns
// `fallback ?? false` when PostHog is unconfigured (posthog-server.ts:70-71),
// and no local or CI browser run configures PostHog. With the required
// `fallback: false` the flag is therefore OFF in every e2e run — so every
// flag-on acceptance criterion this session owes would have been untestable,
// and a spec written against it would have failed for the environment rather
// than for the code.
//
// `SCOREPAD_V2_FORCE` is read on the SERVER and is deliberately not a
// `NEXT_PUBLIC_*` var, for the same reason S10 gave for `SCOREPAD_V2_HARNESS`:
// a `NEXT_PUBLIC_*` value is baked into the client bundle at build time, so it
// would ship the gate's answer to production. This is read per request, so a
// deploy that never sets it cannot be forced into either state.
//
// WHAT THE OVERRIDE MAKES UNOBSERVABLE — named, per the standing `grant-all`
// rule (S11/#420: any helper that normalises inputs to make one question
// answerable defines a blind spot exactly its own size): no browser run ever
// exercises the PostHog branch. That branch is covered by the unit tests
// beside this file instead, via `read` below — on, off, and
// throws-degrades-to-false.
import { isServerFeatureEnabled } from "./posthog-server";

/** The product flag's name, as S10/#419 declared it via this repo's PostHog
 *  convention. HYPHEN, not underscore — the S12 prompt says `scorepad_v2` in
 *  one place and is wrong there. */
export const SCOREPAD_V2_FLAG = "scorepad-v2";

/** Server-read three-state override. `"1"` forces on, `"0"` forces off,
 *  anything else (including unset) defers to PostHog. */
export const SCOREPAD_V2_FORCE_ENV = "SCOREPAD_V2_FORCE";

/** Injectable flag reader — defaults to the real PostHog call. Mirrors
 *  `transport.ts`'s `TransportInit.fetchFn` precedent: injecting a double
 *  beats `vi.mock` here, because this repo has a recorded bug where a hoisted
 *  `vi.mock` goes inert under `isolate: false` and the suite passes by
 *  lottery. */
export type FlagReader = (
  flag: string,
  distinctId: string,
  opts?: { orgId?: string; fallback?: boolean },
) => Promise<boolean>;

/**
 * Does this org/user get the v2 scoring pad?
 *
 * Fails CLOSED in every uncertain case — an unset override with no PostHog
 * client, a PostHog lookup that throws, a flag PostHog does not know. v1 stays
 * the default until S13's cutover flips it, so "we could not tell" must mean
 * v1, never v2.
 */
export async function scorepadV2Enabled(
  distinctId: string,
  orgId: string,
  read: FlagReader = isServerFeatureEnabled,
): Promise<boolean> {
  const forced = process.env[SCOREPAD_V2_FORCE_ENV];
  if (forced === "1") return true;
  if (forced === "0") return false;
  try {
    return await read(SCOREPAD_V2_FLAG, distinctId, { orgId, fallback: false });
  } catch {
    // The real `isServerFeatureEnabled` already swallows its own failures, so
    // this arm only fires if that contract ever changes. Kept anyway: this
    // function's answer decides which PAD a courtside scorer is handed
    // mid-match, and the safe answer to "we could not tell" is the pad that
    // has been in production all along.
    return false;
  }
}
