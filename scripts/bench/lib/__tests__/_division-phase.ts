// A fake of D9's division-start phase gate (B05 T2.5), shared by every
// `sql`-passing `tiny-suite-*.test.ts` fake.
//
// NOT a `.test.ts`, so vitest never collects it — the same convention
// `_schedule-routes.ts`/`_board-fixtures.ts` beside it already use.
//
// Why shared: `runTinySuite`'s new division-start step runs whenever
// `input.sql` is present AND the pack declares a streamed division — which
// `_tiny.json` always does — so EVERY `sql`-passing fake now reaches `POST
// /api/v1/divisions/{id}/start` and `GET /api/v1/divisions/{id}`
// unconditionally, not only the two fold-specific test files. Four
// independent hand-rolled versions would risk disagreeing about the phase
// transition itself, the same "one implementation, four callers" reasoning
// `_schedule-routes.ts`'s own header comment gives for the seven scheduling
// endpoints.
//
// And two of the four (`tiny-suite-simulate.test.ts`, `tiny-suite-
// import.test.ts`) need the SAME phase gate applied to their OWN
// `/fixtures/{id}/events` and `/divisions/{id}/events/import` routes to prove
// the wiring actually matters — AGENTS.md failure class 1, "the inert seam":
// a fold that would succeed against an UNSTARTED division proves nothing
// about whether `runDivisionStartLayer` ran first. Wiring this in is what
// turns their existing "clean fold, gate green" assertions into the
// regression D9's own task brief asks for: remove the start step from
// `tiny.ts`'s wiring and those assertions go red, because the fake now
// refuses exactly like the real product does.
import type { RawResult } from "../http.ts";

export interface DivisionPhaseWorld {
  /** `raw()`'s own handler for `POST /api/v1/divisions/{id}/start` —
   *  `undefined` for any other method/path, so a caller chains it before its
   *  own route branches. Mirrors the real route's 200 shape
   *  (`StartDivisionOut`) closely enough for `runDivisionStartLayer`'s own
   *  re-read to be satisfied. */
  handleStart(method: string, path: string): RawResult | undefined;
  /** `request()`'s own handler for `GET /api/v1/divisions/{id}` (D9's
   *  RE-READ) — `undefined` for any other method/path. */
  handleDivisionGet(method: string, path: string): { status: string } | undefined;
  /** Called by a caller's OWN scoring/import route branch FIRST — `undefined`
   *  means proceed, a `RawResult` is the phase refusal to return instead.
   *  Mirrors the real refusals exactly: `usecases/scoring.ts:222` (422
   *  `WRONG_PHASE`) for `"scoring"`, `usecases/event-import.ts:704` (409
   *  `import.division_not_started`) for `"import"`. */
  refuseUnlessStarted(divisionId: string, kind: "scoring" | "import"): RawResult | undefined;
  /** Read-only escape hatch for a test that wants to assert on phase state
   *  directly, without going through either HTTP handler. */
  isStarted(divisionId: string): boolean;
}

export function makeDivisionPhaseWorld(): DivisionPhaseWorld {
  const started = new Set<string>();
  return {
    handleStart(method, path) {
      const m = /^\/api\/v1\/divisions\/([^/]+)\/start$/.exec(path);
      if (method !== "POST" || m === null) return undefined;
      const id = m[1];
      started.add(id);
      return {
        status: 200,
        json: { ok: true, data: { division_id: id, status: "active", started: true, generated: 0 } },
      };
    },
    handleDivisionGet(method, path) {
      const m = /^\/api\/v1\/divisions\/([^/]+)$/.exec(path);
      if (method !== "GET" || m === null) return undefined;
      return { status: started.has(m[1]) ? "active" : "scheduled" };
    },
    refuseUnlessStarted(divisionId, kind) {
      if (started.has(divisionId)) return undefined;
      if (kind === "scoring") {
        return {
          status: 422,
          json: {
            ok: false,
            error: { code: "WRONG_PHASE", message: "division has not started — scoring is closed" },
          },
        } as unknown as RawResult;
      }
      return {
        status: 409,
        json: {
          ok: false,
          error: { code: "import.division_not_started", message: "division has not started — import is closed" },
        },
      } as unknown as RawResult;
    },
    isStarted(divisionId) {
      return started.has(divisionId);
    },
  };
}
