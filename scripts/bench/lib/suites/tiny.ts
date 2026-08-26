// The bench's own proof loop. Seeds one org + one 2-entrant division through
// the real HTTP API, schedules it, and asserts zero blocking conflicts via
// /divisions/{id}/schedule/validate. This is the bench's smoke AND e2e entry
// point from here on (_RULES.md §1, B01 brief) — no separate e2e test
// exists at this layer because this run IS the exercise.
//
// Endpoint shapes are hand-copied from scripts/smoke.ts's own precedent
// (never imported — see lib/http.ts's header): the minimal competition ->
// division -> entrants -> stage -> generate flow at smoke.ts:1040-1062, and
// the venue/court + schedule-settings -> schedule/auto -> schedule/apply ->
// schedule/validate flow at smoke.ts:8800-9026.
import { randomUUID } from "node:crypto";
import type pino from "pino";
import { newSession, request, signIn, type Session } from "../http.ts";
import type { SuiteReport } from "../report.ts";

export interface TinySuiteInput {
  base: string;
  /** The CLI's `--engine` value. Recorded in the report as `requestedEngine`
   *  so a reader can see what was ASKED for — it is not, and cannot be,
   *  honoured (see the comment at the `schedule/auto` call below: the real
   *  API has no per-request engine field at all). */
  engine: "optimized" | "greedy" | "both";
  /**
   * Recorded for the report; NOT enforced by this suite. `_tiny`'s own
   * footprint (one org/competition/division/2 entrants) is left in place
   * either way — B03 (seeding layer) is the session chartered to own real
   * seed/teardown primitives shared across every real suite, and a
   * bespoke one-off deletion path here would risk duplicating or
   * conflicting with that design. Deliberate B01 scope decision, recorded
   * in the PR body.
   */
  keep: boolean;
  log: pino.Logger;
}

interface IdOut {
  id: string;
}
interface GenerateOut {
  fixtures: { id: string }[];
}
interface AutoScheduleOut {
  assignments: { fixture_id: string; scheduled_at: string; ends_at?: string; court_id: string }[];
  conflicts: { fixture_id: string; code: string; blocking: boolean }[];
  solver?: { engine?: "optimized" | "greedy"; status?: string; mode?: string };
}
interface ValidateOut {
  conflicts: { fixture_id: string; code: string; blocking: boolean }[];
}

export async function runTinySuite(input: TinySuiteInput): Promise<SuiteReport> {
  const { base, engine, keep, log } = input;
  const errors: string[] = [];
  const runTag = randomUUID().slice(0, 8);
  const timings: { seedMs?: number; scheduleMs?: number } = {};
  let conflictCount: number | undefined;
  let solver: AutoScheduleOut["solver"];

  try {
    const s: Session = newSession();
    const seedStart = performance.now();

    const email = `bench-tiny-${runTag}@example.com`;
    log.info({ email }, "tiny: signing in");
    const { org_id: orgId } = await signIn(base, s, email);

    // Two independent chains (venue->court needs only orgId; competition->
    // division needs neither venue nor court) run concurrently on the same
    // session — safe here because nothing past sign-in issues a fresh
    // Set-Cookie, so there is no cookie-jar write race to worry about, only
    // ordinary concurrent reads of `s`.
    const [{ court }, { division }] = await Promise.all([
      (async () => {
        const venue = await request<IdOut>(base, s, `/api/v1/orgs/${orgId}/venues`, {
          method: "POST",
          body: { name: `Bench Tiny Venue ${runTag}` },
        });
        const court = await request<IdOut>(base, s, `/api/v1/orgs/${orgId}/venues/${venue.id}/courts`, {
          method: "POST",
          body: { name: "Court 1" },
        });
        return { venue, court };
      })(),
      (async () => {
        const comp = await request<IdOut>(base, s, "/api/v1/competitions", {
          method: "POST",
          body: { ends_on: "2099-12-31", name: `Bench Tiny ${runTag}` },
        });
        const division = await request<IdOut>(base, s, `/api/v1/competitions/${comp.id}/divisions`, {
          method: "POST",
          body: {
            name: "Tiny",
            sport_key: "generic",
            variant_key: "score",
            config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
          },
        });
        return { comp, division };
      })(),
    ]);

    // Both only need division.id, so these two run concurrently too.
    const [, stage] = await Promise.all([
      request(base, s, `/api/v1/divisions/${division.id}/entrants`, {
        method: "POST",
        body: [
          { kind: "individual", display_name: "Bench A", seed: 1 },
          { kind: "individual", display_name: "Bench B", seed: 2 },
        ],
      }),
      request<IdOut>(base, s, `/api/v1/divisions/${division.id}/stages`, {
        method: "POST",
        body: { seq: 1, kind: "league", name: "League" },
      }),
    ]);
    const generated = await request<GenerateOut>(base, s, `/api/v1/stages/${stage.id}/generate`, { method: "POST" });
    if (generated.fixtures.length !== 1) {
      errors.push(`expected exactly 1 fixture from a 2-entrant league, got ${generated.fixtures.length}`);
    }
    timings.seedMs = Math.round(performance.now() - seedStart);

    const scheduleStart = performance.now();
    // A day out from "now" — real wall-clock time, not a determinism
    // concern (contrast report.ts's run-id, which must never use
    // Date.now(); this is a real future calendar slot the schedule
    // settings need, and there is no other sanctioned source of "now" for
    // a script outside packages/engine/src's boundary).
    const startAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await request(base, s, `/api/v1/divisions/${division.id}/schedule-settings`, {
      method: "PUT",
      body: {
        config: {
          startAt,
          matchMinutes: 30,
          gapMinutes: 0,
          courts: [court.id],
          perEntrantMinRest: 0,
          blackouts: [],
          sessionWindows: [],
        },
        tz: "UTC",
      },
    });

    // There is no request-level "engine" field on AutoScheduleRequest
    // (schemas.ts:1496-1542) — engine selection is entirely
    // server-environment-determined by whether the placement service
    // answers (`_RULES.md` §2's "run gates both with and without a live
    // placement container" is exactly this fact, from the operator's
    // side). So `--engine` cannot be honoured by this call regardless of
    // what the operator asked for; `requestedEngine` in the report below
    // still records the CLI's actual value (`input.engine`), and the
    // ACTUAL engine the response reports is recorded honestly alongside it
    // rather than either one overwriting the other. Flagged in the PR body
    // as a brief/API-shape finding.
    log.info({ requestedEngine: engine }, "tiny: --engine is not honoured — AutoScheduleRequest has no per-request engine field");
    const auto = await request<AutoScheduleOut>(base, s, `/api/v1/stages/${stage.id}/schedule/auto`, {
      method: "POST",
      body: {},
    });
    solver = auto.solver;

    await request(base, s, `/api/v1/stages/${stage.id}/schedule/apply`, {
      method: "POST",
      body: {
        assignments: auto.assignments.map((a) => ({
          fixture_id: a.fixture_id,
          scheduled_at: a.scheduled_at,
          court_id: a.court_id,
        })),
      },
    });

    const validated = await request<ValidateOut>(base, s, `/api/v1/divisions/${division.id}/schedule/validate`, {
      method: "POST",
    });
    const blocking = validated.conflicts.filter((c) => c.blocking);
    conflictCount = blocking.length;
    if (blocking.length > 0) {
      errors.push(`${blocking.length} blocking conflict(s) after schedule/apply: ${blocking.map((c) => c.code).join(", ")}`);
    }
    timings.scheduleMs = Math.round(performance.now() - scheduleStart);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  const gate = errors.length === 0 ? "green" : "red";
  return {
    suite: "_tiny",
    gate,
    timings,
    keep,
    solver: { engine: solver?.engine, requestedEngine: engine, status: solver?.status },
    conflictCount,
    errors: errors.length > 0 ? errors : undefined,
  };
}
