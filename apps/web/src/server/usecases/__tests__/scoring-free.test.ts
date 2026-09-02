// W1 (entitlements v18): scoring detail is never paywalled. Formerly
// entitlements-v2.test.ts asserted 402 + feature_key "scoring.match_timeline"
// for football.card on a community org; that refusal no longer exists, for
// ANY module, at ANY fidelity band. Real Postgres required (RLS, triggers,
// engine-db) — skipped without DATABASE_URL, same convention as
// entitlements-v2.test.ts and event-import-dryrun.test.ts.
//
// One event per sport at its highest REACHABLE band, driven through the real
// `scoreEvent` (the exact function `POST /api/v1/fixtures/[id]/events`
// calls) — never a unit assertion on `requiredFeatureForEvent` in isolation,
// which is exactly the function this wave deletes.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { EngineError } from "@seazn/engine/core";
import { buildPathObject } from "@seazn/engine/sport";
import type { AnySportModule, PadAction, PadField, PadFieldValue, PadPhase } from "@seazn/engine/sport";
import { scoreEvent } from "@/server/usecases/scoring";
import { makeCommunityRig } from "./_rig";

const HAS_DB = !!process.env.DATABASE_URL;

function minimalFieldValue(field: PadField): PadFieldValue {
  switch (field.kind) {
    case "enum":
      return field.values[0]!;
    case "number":
      return field.min;
    case "toggle":
      return false;
  }
}

/** Whether `eventSchema`'s TOP-LEVEL field at `path` is `.optional()` — the
 *  same question `FootballShot`'s own `taker`/`goalkeeper` answer "yes" to
 *  (module.ts's `buildPathObject` doc: an unset optional stays genuinely
 *  absent). A dotted path (cricket's `wicket.out`) is not resolvable this
 *  way and reads as "cannot tell" — `false`, the safe default, since guessing
 *  a WRONG value for a field that turns out to be required is recoverable
 *  (the retry loop below), but silently dropping a genuinely required field
 *  is not (zod rejects the whole payload with no field name to flip). */
function isOptionalTopLevelField(eventSchema: unknown, path: string): boolean {
  if (path.includes(".")) return false;
  const shape = (eventSchema as { shape?: Record<string, { isOptional?: () => boolean }> } | undefined)?.shape;
  const field = shape?.[path];
  return typeof field?.isOptional === "function" ? field.isOptional() : false;
}

interface Picked {
  action: PadAction;
  band: number;
  phase: PadPhase;
}

/**
 * The highest-banded event type actually REACHABLE under `cfg` — never just
 * the highest key in `spec.fidelity`. `spec.fidelity` names a band for every
 * canonical event type a kernel registers at SCHEMA level, which is not the
 * same as what THIS cfg's write path accepts: the setbased kernel declares a
 * band for `expedite.start` on volleyball/badminton even when the cfg's
 * `records.expedite` is false, and `scoreEvent` then throws `INVALID_EVENT`
 * ("has no expedite system") for it — a failure with nothing to do with
 * entitlements. `spec.panels` is config-gated (the same source
 * `setbased/attribution.test.ts` reads for reachability), so cross-
 * referencing panel actions against `spec.fidelity` is the honest picture.
 *
 * "post"-phase panels (valid only once the match is already decided) are
 * excluded outright: this rig's stream is at most `core.start` + one event,
 * which can never reach "post". Skipping them, rather than forcing one, can
 * only ever LOWER the band picked — never invent a false positive.
 */
function pickTopBandReachable(sportModule: AnySportModule, cfg: unknown): Picked | null {
  const spec = sportModule.padSpec!(cfg);
  const candidates: Picked[] = [];
  for (const panel of spec.panels) {
    if (panel.phase === "post") continue;
    for (const action of panel.actions) {
      const band = spec.fidelity[action.type];
      if (band === undefined) continue;
      candidates.push({ action, band, phase: panel.phase });
    }
  }
  if (candidates.length === 0) return null;
  const maxBand = Math.max(...candidates.map((c) => c.band));
  return candidates.find((c) => c.band === maxBand)!;
}

/**
 * Builds the smallest payload `eventSchema` accepts for `action`, via the
 * SAME `buildPathObject` the engine's own conformance property test and the
 * future pad renderer use (module.ts's own doc) — never a hand-typed shape
 * per sport, so this rig moves with the engine rather than a table
 * maintained here.
 *
 * A `"side"` attribution item always resolves to the home entrant. A
 * `"person"` item resolves to a real person from `personSideByPath`'s
 * assigned side (0 = home, 1 = away, initially all 0 — `recordTopBand`'s
 * retry loop below flips one at a time when the engine names it as wrong
 * side), skipped ENTIRELY when the schema says the field is optional
 * (football's `taker`/`goalkeeper`: guessing a value the engine then
 * refuses — "goalkeeper … is not on the pitch for the defending side" — is
 * worse than the pad simply not offering it, which is the real UX these
 * fields exist for). Two same-side person items in one action (cricket's
 * `striker`/`nonStriker`, BOTH required, BOTH batting-side) get DISTINCT
 * people via `usedPerSide`, never the same id twice.
 */
function buildPayload(
  action: PadAction,
  entrantIds: readonly [string, string],
  personIdsBySide: readonly [readonly string[], readonly string[]],
  personSideByPath: ReadonlyMap<string, 0 | 1>,
  eventSchema: unknown,
): Record<string, unknown> {
  const fieldEntries = action.fields.map((f) => [f.path, minimalFieldValue(f)] as const);
  const usedPerSide: [number, number] = [0, 0];
  const attrEntries: Array<readonly [string, unknown]> = [];
  for (const item of action.attribution) {
    if (item.kind === "side") {
      attrEntries.push([item.path, entrantIds[0]]);
      continue;
    }
    if (isOptionalTopLevelField(eventSchema, item.path)) continue;
    const side = personSideByPath.get(item.path) ?? 0;
    const pool = personIdsBySide[side];
    const id = pool.length > 0 ? pool[usedPerSide[side] % pool.length]! : entrantIds[side];
    usedPerSide[side] += 1;
    attrEntries.push([item.path, id]);
  }
  return buildPathObject([...fieldEntries, ...attrEntries]);
}

interface Rig {
  auth: Awaited<ReturnType<typeof makeCommunityRig>>["auth"];
  fixtureId: string;
  entrantIds: [string, string];
  personIdsBySide: [string[], string[]];
}

/**
 * Records `picked` on `rig`'s fixture, prepending `core.start` when the
 * owning panel is `"live"`-phase (a `"pre"`-phase action, e.g. a toss, is
 * valid before the match starts). Required-person attribution starts
 * assigned to the home side; on an `INVALID_EVENT` refusal that NAMES one of
 * those paths in its message (the engine's own wording — "bowler … is not
 * in the fielding lineup", "goalkeeper … is not on the pitch"), that ONE
 * path flips to the away side and the append is retried at the SAME
 * `expected_seq` — safe because a refused append validates the whole
 * candidate stream and persists nothing (append-event.ts), so no seq was
 * ever consumed. Bounded to one flip per required path (never an infinite
 * loop): if a refusal names nothing flippable, or every path has already
 * been tried both ways, the rejection propagates and the test fails —
 * exactly the honest outcome when this generic rig cannot resolve a
 * module's real domain rule automatically.
 */
async function recordTopBand(rig: Rig, sportModule: AnySportModule, picked: Picked): Promise<unknown> {
  const eventSchema = sportModule.eventSchemas?.[picked.action.type];
  const requiredPersonPaths = picked.action.attribution
    .filter((item) => item.kind === "person" && !isOptionalTopLevelField(eventSchema, item.path))
    .map((item) => item.path);
  const personSideByPath = new Map<string, 0 | 1>(requiredPersonPaths.map((p) => [p, 0 as const]));

  let seq = 0;
  if (picked.phase === "live") {
    await scoreEvent(rig.auth, rig.fixtureId, { expected_seq: seq, type: "core.start", payload: {} });
    seq += 1;
  }

  const maxAttempts = requiredPersonPaths.length + 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const payload = buildPayload(
      picked.action,
      rig.entrantIds,
      rig.personIdsBySide,
      personSideByPath,
      eventSchema,
    );
    try {
      return await scoreEvent(rig.auth, rig.fixtureId, {
        expected_seq: seq,
        type: picked.action.type,
        payload,
      });
    } catch (err) {
      const isLastAttempt = attempt === maxAttempts - 1;
      if (isLastAttempt || !(err instanceof EngineError) || err.code !== "INVALID_EVENT") throw err;
      const named = requiredPersonPaths.find(
        (p) => err.message.includes(p) || err.message.includes(p.split(".").pop()!),
      );
      if (!named) throw err;
      personSideByPath.set(named, personSideByPath.get(named) === 1 ? 0 : 1);
    }
  }
  /* istanbul ignore next -- loop always returns or throws */
  throw new Error("unreachable");
}

describe.skipIf(!HAS_DB)("scoring is free on every plan (R9)", () => {
  for (const sportModule of builtinModules) {
    it(`${sportModule.key}: a community org records its highest reachable-band event`, async () => {
      const rig = await makeCommunityRig(sportModule.key);
      const cfg = sportModule.configSchema.parse(rig.cfg);
      const picked = pickTopBandReachable(sportModule, cfg);
      // Established fact (see this file's header): a module with nothing
      // reachable above band 0 has nothing this wave's ruling could free —
      // recorded via the assertion message rather than silently skipped, so
      // a future module that regresses to band-0-only is still visible here.
      expect(picked, `${sportModule.key}: no fidelity-banded event is reachable under its default cfg`).not.toBeNull();
      // Fix round 1, I-2: a reachability test is satisfied by ANY value
      // (house rule 19) — pin the BAND too, derived from the module's own
      // declaration, never a table typed here. A module whose declared
      // ceiling is >= 2 (a real paid-shaped band under the old model) must
      // have picked an event AT that ceiling; boardgame/carrom/generic
      // legitimately top out at band 1 (their real ceiling, confirmed via
      // `module.padSpec(cfg).fidelity`), so they are correctly exempt, not
      // silently passing.
      const declaredMax = Math.max(...Object.values(sportModule.padSpec!(cfg).fidelity), 0);
      if (declaredMax >= 2) {
        expect(
          picked!.band,
          `${sportModule.key}: picked event should reach the module's declared ceiling (band ${declaredMax})`,
        ).toBeGreaterThanOrEqual(2);
      }
      await expect(recordTopBand(rig, sportModule, picked!)).resolves.toBeDefined();
    });
  }

  // Fix round 1, I-1 (owner ruling, sanctioned): deleting
  // `requiredFeatureForEvent` also deleted the write-side gate on
  // `stats.player` — cricket.ts's own `{tier: 2, eventTypes:
  // ["cricket.player.line"], entitlement: "stats.player"}`, a FOURTH key the
  // old model gated, not three. The owner has ruled the new boundary is
  // correct: scoring is free to WRITE, player-stats ANALYSIS stays paid to
  // READ — `player-stats.ts`'s `divisionPlayerStats`/`personStats`/
  // `personCareerStats` still gate `stats.player` on read, untouched by this
  // task, and V390 does not drop its `plan_entitlements` rows (verified:
  // still 3 rows, one per plan). This pins the new WRITE-side boundary.
  //
  // `cricket.player.line` is POST-decision only (`postDecisionTypes`, and its
  // own padSpec panel is literally commented "Post-match") — `pickTopBand
  // Reachable` above deliberately never reaches it (it excludes `"post"`-
  // phase panels on purpose), so this is hand-built rather than routed
  // through the generic per-module loop. It needs only ONE closed innings,
  // not a fully decided match: `applyPlayerLine` only requires
  // `state.innings[n].closed`.
  it("cricket.player.line (Tier-2 scorecard, stats.player) is free to WRITE for a community org", async () => {
    const rig = await makeCommunityRig("cricket");
    await scoreEvent(rig.auth, rig.fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    // One real ball — striker/nonStriker from the batting (home) side,
    // bowler from the fielding (away) side, the same convention
    // `recordTopBand`'s retry loop discovers empirically for `cricket.ball`
    // in the loop above. `over`/`ballInOver` are never read by `apply()`
    // (`CricketBall`'s own doc comment) — any value is fine.
    const striker = rig.personIdsBySide[0][0]!;
    const nonStriker = rig.personIdsBySide[0][1]!;
    const bowler = rig.personIdsBySide[1][0]!;
    const ball = await scoreEvent(rig.auth, rig.fixtureId, {
      expected_seq: 1,
      type: "cricket.ball",
      payload: { over: 0, ballInOver: 1, striker, nonStriker, bowler, runs: { bat: 0 } },
    });
    const close = await scoreEvent(rig.auth, rig.fixtureId, {
      expected_seq: ball.seq,
      type: "cricket.innings.close",
      payload: {},
    });
    // The line must match the ball's own outcome exactly: fine-grained
    // per-ball tracking is populated for ANY recorded ball now (scoring
    // detail is free to write for every org), and `applyPlayerLine` checks
    // the submitted line against that tracked innings ledger, not against
    // any entitlement.
    const line = await scoreEvent(rig.auth, rig.fixtureId, {
      expected_seq: close.seq,
      type: "cricket.player.line",
      payload: { innings: 1, person: striker, batting: { runs: 0, balls: 1 } },
    });
    expect(line.seq).toBe(close.seq + 1);
  });
});
