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
//
// ---------------------------------------------------------------------------
// B02 — THE SEED DATA IS THE PACK'S (session prompt item 4)
// ---------------------------------------------------------------------------
// This suite used to declare its competition, division cfg, entrants and stage
// inline, and `packs/_tiny.json` did not exist. Now both this runner and the
// stage-0 validator read the SAME committed file, which is the point: a shared
// artifact, not a refactor. What the run EXERCISES is unchanged — sign in, one
// venue and court, a competition, a division, two entrants, one league stage,
// generate, schedule/auto, schedule/apply, schedule/validate — only where its
// data comes from has moved.
//
// One consequence of that move is visible in a live run and is deliberate: the
// pack's stage declares `legs: 3`, so the generator now mints THREE fixtures
// where the inline shape minted one, and the suite schedules all three. The
// assertion that used to read `!== 1` is derived from the pack instead (see
// `expectedFixtureCount`), so it moves with the file rather than freezing
// yesterday's shape — which is what it had already done once.
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type pino from "pino";
import { newSession, request, signIn, type Session } from "../http.ts";
import { expectedFixtureCount, formatFinding, loadPackFile } from "../pack-io.ts";
import { entrantsOfDivision, type Pack, type PackJsonValue } from "../pack-schema.ts";
import type { SuiteReport } from "../report.ts";

/** The committed micro-pack, resolved from THIS module rather than from the
 *  process cwd — the bench is run from the repo root by `npm run
 *  bench:scheduler` and from a worktree root by CI, and a cwd-relative path
 *  would silently read a different file (or none) between the two. */
export const TINY_PACK_PATH = fileURLToPath(new URL("../../packs/_tiny.json", import.meta.url));

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
  /** Overridable so a test can drive the pack stage against another file.
   *  Defaults to the committed micro-pack; a live run never passes it. */
  packPath?: string;
}

// ---------------------------------------------------------------------------
// The pack stage — everything this suite decides before it touches the network
// ---------------------------------------------------------------------------

/** The request bodies this suite will POST, all read off the pack. Named
 *  fields rather than a pack handle so the HTTP half below cannot reach past
 *  what the pack stage actually resolved. */
export interface TinySeedPlan {
  readonly competitionName: string;
  readonly endsOn: string;
  readonly divisionName: string;
  readonly sportKey: string;
  readonly variantKey: string;
  readonly divisionConfig: Record<string, PackJsonValue>;
  readonly entrants: readonly { kind: string; display_name: string; seed?: number }[];
  readonly stage: {
    readonly seq: number;
    readonly kind: string;
    readonly name: string;
    readonly config: Record<string, PackJsonValue>;
  };
  /** Derived from the pack's own entrants and legs — never a constant. */
  readonly expectedFixtures: number;
}

/**
 * The pack, as this suite's seed plan.
 *
 * REFUSES anything but the one-division / one-stage shape `_tiny` is: the HTTP
 * flow below creates exactly one of each, and silently seeding the first of
 * several would run a suite nobody declared. B03 owns the general seeding
 * layer; this is the micro-fixture's own reader.
 */
export function tinyPlan(pack: Pack): TinySeedPlan {
  if (pack.divisions.length !== 1) {
    throw new Error(
      `the _tiny suite drives a pack with exactly one division; "${pack.suite}" declares ${pack.divisions.length}`,
    );
  }
  const division = pack.divisions[0] as Pack["divisions"][number];
  if (division.stages.length !== 1) {
    throw new Error(
      `the _tiny suite drives a pack with exactly one stage; division "${division.ref}" declares ${division.stages.length}`,
    );
  }
  const stage = division.stages[0] as (typeof division.stages)[number];
  return {
    competitionName: pack.competition.name,
    endsOn: pack.competition.endsOn,
    divisionName: division.name,
    sportKey: division.sportKey,
    variantKey: division.variantKey,
    divisionConfig: division.cfgOverrides,
    entrants: entrantsOfDivision(pack.entrants, division.ref)
      .map((e) => ({
        kind: e.kind,
        display_name: e.displayName,
        ...(e.seed === undefined ? {} : { seed: e.seed }),
      })),
    stage: { seq: stage.seq, kind: stage.kind, name: stage.name, config: stage.config },
    expectedFixtures: expectedFixtureCount(pack, division.ref, stage.ref),
  };
}

/**
 * ADDENDUM 1's comparison, as a pure function.
 *
 * `null` = the generator minted what the pack implies. A message = what
 * diverged, naming BOTH numbers and the legs that produced the expectation.
 *
 * Extracted from the HTTP path because that is where it was unreachable: the
 * review inverted the operator in situ and the whole suite stayed green. The
 * DERIVATION (`expectedFixtureCount`) was well covered; the line that CONSUMES
 * it was not — and consuming it wrongly is exactly what shipped before, as
 * `!== 1` against a pack declaring three. A silent inversion here reports a
 * GREEN `_tiny` while the product mints the wrong number of fixtures, which is
 * the one failure the addendum exists to prevent.
 */
export function fixtureCountIssue(actual: number, plan: TinySeedPlan): string | null {
  if (actual === plan.expectedFixtures) return null;
  return (
    `expected ${plan.expectedFixtures} fixture(s) from the pack's ${plan.entrants.length}-entrant ` +
    `league over ${plan.stage.config["legs"] ?? 1} leg(s), got ${actual}`
  );
}

export type TinyPackStage =
  | { readonly ok: true; readonly plan: TinySeedPlan; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly errors: readonly string[]; readonly warnings: readonly string[] };

/**
 * Load and gate the pack, BEFORE anything is created over HTTP.
 *
 * The severity split is structural, not a convention: `loadPackFile` hands back
 * a union whose `ok: false` branch carries `errors` and whose `ok: true` branch
 * carries no error field at all, so a warning cannot reach the gate by
 * accident. `_tiny` carries two permanent `*.not_derived` warnings — stage 0
 * SAYS what it does not derive offline rather than staying silent — and those
 * belong in the report, not in the gate. A stage that failed on "any finding"
 * would red `_tiny` forever, and the obvious repair would be to delete the
 * honest warning.
 */
export async function tinyPackStage(packPath: string): Promise<TinyPackStage> {
  const load = await loadPackFile(packPath);
  const warnings = load.warnings.map(formatFinding);
  if (!load.ok) return { ok: false, errors: load.errors.map(formatFinding), warnings };
  try {
    return { ok: true, plan: tinyPlan(load.pack), warnings };
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)], warnings };
  }
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
  const warnings: string[] = [];
  const runTag = randomUUID().slice(0, 8);
  const timings: { seedMs?: number; scheduleMs?: number } = {};
  let conflictCount: number | undefined;
  let solver: AutoScheduleOut["solver"];

  // Stage 0 FIRST, and nothing is created if it refuses: a pack the offline
  // gate rejects would otherwise be seeded over HTTP and report a product
  // defect that is really an authoring one, minutes into a live run.
  const packPath = input.packPath ?? TINY_PACK_PATH;
  const staged = await tinyPackStage(packPath);
  warnings.push(...staged.warnings);
  if (!staged.ok) {
    log.error({ packPath, errors: staged.errors }, "tiny: pack refused by stage 0");
    return {
      suite: "_tiny",
      gate: "red",
      timings,
      keep,
      solver: { requestedEngine: engine },
      errors: staged.errors.map((e) => `pack: ${e}`),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }
  const plan = staged.plan;
  if (warnings.length > 0) log.warn({ packPath, warnings }, "tiny: pack validated with warnings");

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
          // The run tag stays on the NAME (every bench run mints its own org
          // and competition), while `ends_on` is the pack's declared date.
          body: { ends_on: plan.endsOn, name: `${plan.competitionName} ${runTag}` },
        });
        const division = await request<IdOut>(base, s, `/api/v1/competitions/${comp.id}/divisions`, {
          method: "POST",
          body: {
            name: plan.divisionName,
            sport_key: plan.sportKey,
            variant_key: plan.variantKey,
            config: plan.divisionConfig,
          },
        });
        return { comp, division };
      })(),
    ]);

    // Both only need division.id, so these two run concurrently too.
    const [, stage] = await Promise.all([
      request(base, s, `/api/v1/divisions/${division.id}/entrants`, {
        method: "POST",
        body: plan.entrants,
      }),
      request<IdOut>(base, s, `/api/v1/divisions/${division.id}/stages`, {
        method: "POST",
        body: plan.stage,
      }),
    ]);
    const generated = await request<GenerateOut>(base, s, `/api/v1/stages/${stage.id}/generate`, { method: "POST" });
    // DERIVED from the pack (entrants choose two, times its declared legs) —
    // never a constant. This assertion read `!== 1` while the pack declared
    // three, which is a bound asserting yesterday's numbers. The comparison
    // itself lives in `fixtureCountIssue` so it sits on the TESTABLE side of
    // the network boundary; in situ it could be inverted with nothing red.
    const countIssue = fixtureCountIssue(generated.fixtures.length, plan);
    if (countIssue !== null) errors.push(countIssue);
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

  // Warnings are REPORTED, never gated on. Stage 0 names what it does not
  // derive offline; that is a fact the report has to carry, and a gate that
  // read it would red `_tiny` on every run for saying something true.
  const gate = errors.length === 0 ? "green" : "red";
  return {
    suite: "_tiny",
    gate,
    timings,
    keep,
    solver: { engine: solver?.engine, requestedEngine: engine, status: solver?.status },
    conflictCount,
    errors: errors.length > 0 ? errors : undefined,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
