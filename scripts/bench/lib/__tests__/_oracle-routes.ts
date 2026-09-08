// B05 T4 — a fake of the ONE route this task wires into `runTinySuite`:
// `GET /stages/{id}/standings`, for division0's own FINAL stage (the target
// `advanceStageSeeding`/`completeStageCapture` already resolve —
// `_advance-routes.ts`'s own world tracks the exact same stage id). Shared
// for the same reason `_advance-routes.ts` is: every `sql`-passing fake now
// reaches this route unconditionally once `_tiny.json`'s `s-playoff`
// completes, and four independent hand-rolled versions would risk
// disagreeing about what that placement table looks like.
//
// NOT a `.test.ts`, so vitest never collects it — the same convention
// `_advance-routes.ts`/`_division-phase.ts` beside it already use.
//
// A completed bracket/ladder stage's standings snapshot is a PLACEMENT
// TABLE, not a real table: every counting field is zero and only `rank` is
// meaningful (`B05-repins-2026-09-07.md`'s "Verified pins — where B05
// attaches" table, `progression/ts:716-730`). This fake mirrors that shape
// exactly, reusing the SAME `getQualifiers`-shaped callback
// `_advance-routes.ts` already requires from every caller — the target
// stage's own final order IS that qualifier order once it has completed
// (`_tiny.json`'s `s-playoff` never reorders its own two entrants).
//
// These four test files are not ABOUT proving the oracle comparators are
// correct (`oracle.test.ts` does that, directly, against deliberately
// mismatched fixtures); they exist so the DLS-gate/officials/registration/
// stats assertions each ALREADY covers stay green rather than reddening on
// an unmodeled route.
import type { RawResult } from "../http.ts";

export interface OracleRoutesWorld {
  /** `raw()`'s own handler for the standings route — `undefined` for any
   *  other method/path, so a caller chains it before its own branches. */
  handle(method: string, path: string): RawResult | undefined;
}

export function makeOracleRoutesWorld(input: {
  /** The SAME callback `_advance-routes.ts`'s own `getQualifiers` takes —
   *  rank-1-first entrant ids for a given stage id, or `undefined` for a
   *  stage this world knows nothing about. */
  getRankedEntrantIds(stageId: string): readonly string[] | undefined;
}): OracleRoutesWorld {
  return {
    handle(method, path) {
      if (method !== "GET") return undefined;
      const match = /^\/api\/v1\/stages\/([^/]+)\/standings/.exec(path);
      if (match === null) return undefined;
      const stageId = match[1];
      const ranked = input.getRankedEntrantIds(stageId) ?? [];
      return {
        status: 200,
        json: {
          ok: true,
          data: {
            stage_id: stageId,
            pool_id: null,
            rows: ranked.map((entrantId, i) => ({
              entrantId,
              played: 0,
              won: 0,
              drawn: 0,
              lost: 0,
              points: 0,
              metrics: {},
              rank: i + 1,
            })),
            computed_through_seq: 0,
            updated_at: null,
          },
        },
      };
    },
  };
}
