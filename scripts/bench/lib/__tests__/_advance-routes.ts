// A fake of B05 T3's stage-advancement routes (`propose -> assert -> confirm
// -> generate -> complete`), shared by every `sql`-passing
// `tiny-suite-*.test.ts` fake.
//
// NOT a `.test.ts`, so vitest never collects it — the same convention
// `_schedule-routes.ts`/`_division-phase.ts` beside it already use.
//
// Why shared: `runTinySuite`'s advance step (`lib/suites/tiny.ts`) runs
// whenever `input.sql` is present AND `division0`'s second stage declares a
// `progression` — which `_tiny.json`'s own `s-playoff` always does — so
// EVERY `sql`-passing fake now reaches `POST /stages/{id}/seed-proposal`,
// `.../seed-proposal/confirm`, `.../generate` (a SECOND time — `advance.ts`'s
// own flow calls it via `raw()`, never the `request()` call `seedSuite`'s
// initial per-stage generate loop already uses) and `.../complete`, not only
// this task's own `advance.test.ts`. Four independent hand-rolled versions
// would risk disagreeing about what a stage's own qualifiers/finalRanks are,
// the same "one implementation, four callers" reasoning `_schedule-routes.ts`'s
// header comment gives for the seven scheduling endpoints.
//
// This fake answers every proposal/completion the SAME way: a division's own
// entrant ids, IN CREATION ORDER (`FakeScheduleWorld.entrantsOfDivision`) —
// which for `_tiny.json` is `[alpha, bravo]`, matching that pack's own
// `expected.tables`/`expected.finalRanks` order exactly (both name Ana/Alpha
// first). These four test files are not ABOUT proving that order is correct
// (T3's own `advance.test.ts` unit-tests `advanceStageSeeding`/
// `completeStageCapture`/`compareFinalRanks` directly against a fake); they
// exist so DLS-gate/officials/registration/stats assertions stay green
// rather than reddening on an unmodeled route.
import type { RawResult } from "../http.ts";

export interface AdvanceRoutesWorld {
  /** `raw()`'s own handler for the four advancement routes — `undefined` for
   *  any other method/path, so a caller chains it before its own branches. */
  handle(method: string, path: string, body: unknown): RawResult | undefined;
}

export function makeAdvanceRoutesWorld(input: {
  /** The stage's own division's entrant ids, in creation order — rank 1
   *  first. `undefined`/empty for a stage this world knows nothing about
   *  (the fake still answers something rather than throwing, since the
   *  SOURCE stage's own `complete` call — always made, per `tiny.ts`'s own
   *  wiring — has no qualifiers of its own to report and none are read from
   *  it). */
  getQualifiers(stageId: string): readonly string[] | undefined;
}): AdvanceRoutesWorld {
  let proposalCounter = 0;
  return {
    handle(method, path, body) {
      if (method !== "POST") return undefined;

      const proposeMatch = /^\/api\/v1\/stages\/([^/]+)\/seed-proposal$/.exec(path);
      if (proposeMatch !== null) {
        const stageId = proposeMatch[1]!;
        const qualifiers = input.getQualifiers(stageId) ?? [];
        return {
          status: 201,
          json: {
            ok: true,
            data: {
              id: `proposal-${++proposalCounter}`,
              stageId,
              status: "draft",
              computed: {
                qualifiers: qualifiers.map((entrantId, i) => ({
                  rank: i + 1,
                  source: { stageId: "source", rank: i + 1 },
                  entrantId,
                  destinationSlot: `${stageId}:slot${i + 1}`,
                })),
                ties: [],
                standingsHash: `hash-${stageId}`,
              },
            },
          } as never,
        };
      }

      if (/^\/api\/v1\/stages\/[^/]+\/seed-proposal\/confirm$/.test(path)) {
        const b = body as { proposalId?: string } | undefined;
        return {
          status: 200,
          json: { ok: true, data: { proposalId: b?.proposalId ?? "proposal", filled: 1 } } as never,
        };
      }

      // `advance.ts`'s OWN `/generate` call, via `raw()` — a SECOND call
      // against a stage `seedSuite`'s initial per-stage `/generate` loop
      // (via `request()`) already created fixtures for, so this is always
      // idempotent (`existing: 1`) in every scenario these four files drive.
      if (/^\/api\/v1\/stages\/[^/]+\/generate$/.test(path)) {
        return { status: 200, json: { ok: true, data: { created: 0, existing: 1, fixtures: [] } } as never };
      }

      const completeMatch = /^\/api\/v1\/stages\/([^/]+)\/complete$/.exec(path);
      if (completeMatch !== null) {
        const stageId = completeMatch[1]!;
        const finalRanks = input.getQualifiers(stageId) ?? [];
        return {
          status: 200,
          json: {
            ok: true,
            data: { completed: true, events: [{ type: "stage_completed", stageId, finalRanks }] },
          } as never,
        };
      }

      return undefined;
    },
  };
}
