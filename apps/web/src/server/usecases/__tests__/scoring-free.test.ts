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
      await expect(recordTopBand(rig, sportModule, picked!)).resolves.toBeDefined();
    });
  }
});
