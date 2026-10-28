// The SAME resolver `RestFloorNote` (apps/web) and the solver/verifier
// (`effectiveRestMinutes`, calendar.ts) both call — a real package import,
// not a re-derivation. This module is a dependency-free leaf (see its own
// header), so it loads under this script's plain `node
// --experimental-strip-types` runner the same way `@/…` aliases and JSON
// imports do NOT (see the PASS_RUNGS comment in smoke/harness.ts) — proven
// before relying on it here, not assumed.
import { restFloor } from "@seazn/engine/scheduling/rest-floor";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, check, signIn, tag, v1, v1data } from "../harness.ts";

/**
 * Date/time UX programme, Prompt 09 follow-up — the minimum-rest FLOOR
 * (`restFloor`, #459): `perEntrantMinRest` (Settings tab) and
 * `constraints.restMin` (Constraints tab) are two of the four controls that
 * raise it, and the floor is the MAX of whichever disagree, never
 * precedence (a division rule reading "restMin always wins" would be as
 * wrong as one reading "perEntrantMinRest always wins" — #459's own
 * regression was exactly this shape, just for a different pair of
 * sources — see schedulingConstraintsSuite above).
 *
 * `restFloor` itself is unit-tested and mutation-proven already (engine
 * 14/14). What only smoke can prove is the WIRING: a real PUT stores both
 * numbers, a real GET reads them back unchanged over HTTP, and feeding
 * EXACTLY what came back over the wire — not a literal that only ever lived
 * in this script — into the same resolver the app's `RestFloorNote` and the
 * solver/verifier's `effectiveRestMinutes` (calendar.ts) both call resolves
 * to the larger number.
 *
 * Both directions in ONE run — the twin idiom this file uses throughout
 * (see schedulingConstraintsSuite's pool case): if the resolver secretly
 * preferred one field over the other instead of actually comparing values,
 * asserting only one direction would not catch it.
 *
 * NOT an entitlement gate (V353/#382 opened scheduling.constraints to every
 * plan — schedule-datetime-ux.spec.ts confirms the same on the console side)
 * — own fresh free session, no setPlan.
 */
export async function scheduleRestFloorSuite(): Promise<void> {
  const free = newSession();
  await signIn(free, `delivered+dtx_restfloor_${tag}@resend.dev`);
  const comp = v1data<{ id: string }>(
    await v1(free, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `DTX Rest Floor ${tag}`,
    }),
  );
  const div = v1data<{ id: string }>(
    await v1(free, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Rest Floor",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );

  interface RestFloorConfigWire {
    config: {
      perEntrantMinRest: number;
      gapMinutes: number;
      constraints?: { restMin?: number; noBackToBack?: boolean; restByGroup?: Record<string, number> };
    };
  }
  const putRest = (perEntrantMinRest: number, restMin: number) =>
    v1(free, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
      config: { perEntrantMinRest, constraints: { restMin } },
    });
  const getSettings = async (): Promise<RestFloorConfigWire> =>
    v1data<RestFloorConfigWire>(await v1(free, `/api/v1/divisions/${div.id}/schedule-settings`));

  // ---- Direction 1: the Constraints-tab number (30) is stricter ----
  const put1 = await putRest(10, 30);
  check("rest floor: PUT with perEntrantMinRest/constraints.restMin disagreeing is accepted (200)", put1.status === 200);
  const got1 = await getSettings();
  const floor1 = restFloor({
    perEntrantMinRest: got1.config.perEntrantMinRest,
    gapMinutes: got1.config.gapMinutes,
    constraints: got1.config.constraints,
  });
  check(
    "rest floor: GET round-trips perEntrantMinRest=10/restMin=30 unchanged, and restFloor resolves 30 via restMin — not the Settings-tab field",
    got1.config.perEntrantMinRest === 10 &&
      got1.config.constraints?.restMin === 30 &&
      floor1.minutes === 30 &&
      floor1.source === "restMin",
  );

  // ---- Direction 2 (the twin): the Settings-tab number (45) is stricter ----
  const put2 = await putRest(45, 10);
  check("rest floor: ...and the reverse PUT is accepted too (200)", put2.status === 200);
  const got2 = await getSettings();
  const floor2 = restFloor({
    perEntrantMinRest: got2.config.perEntrantMinRest,
    gapMinutes: got2.config.gapMinutes,
    constraints: got2.config.constraints,
  });
  check(
    "rest floor: ...GET round-trips perEntrantMinRest=45/restMin=10, and restFloor now resolves 45 via perEntrantMinRest — proves MAX, not 'restMin always wins'",
    got2.config.perEntrantMinRest === 45 &&
      got2.config.constraints?.restMin === 10 &&
      floor2.minutes === 45 &&
      floor2.source === "perEntrantMinRest",
  );
}
