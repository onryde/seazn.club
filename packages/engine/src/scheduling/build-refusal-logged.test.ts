// The placement service can REFUSE a request — a validation failure in
// `request_to_model_input`, say — and it says exactly why: `error_response`
// (`seazn.club.placement/src/placement/schema.py:817`) puts a `code` and a
// human-readable `message` on the response. That is a RESOLVED response, not a
// rejection, so `solveBuild` returns it normally and `buildSchedule`'s
// `catch` — the one arm on this path that logs — never runs.
//
// Until this suite existed, the resolved-`ERROR` arm read `outcome.error?.code`
// to choose a status name and then dropped the whole object on the floor. The
// service knew why it refused, wrote it down, and both layers discarded it: the
// caller saw `solver_unavailable` with no explanation anywhere, in any log, on
// either side of the wire.
//
// That is not a hypothetical. B06b's suite 11 spent a wave reporting "the
// optimized scheduling path does not survive a real fixture count" on exactly
// this evidence — `solver_unavailable`, budget expired at 0 of 6 tiers — and a
// 30 s control run later falsified it: the build was handing back a board in
// 849 ms against a 30_000 ms wall, so it had never been a timeout at all. The
// refusal's own message would have said so on the first run.
import { describe, expect, it } from "vitest";
import { buildSchedule } from "./build.ts";
import type { SchedulableFixture, SlotConfig } from "./calendar.ts";
import type { PlacementSolver, SolveBuildOutcome } from "./solver-port.ts";
import { recordingLogger, resolvingSolver } from "./__tests__/solver-fakes.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 5, 9, 0, 0);

// Typed, NOT cast. An earlier draft of this file reached for
// `as unknown as Parameters<typeof buildSchedule>[0]["config"]` and invented
// an `entrantIds` field that `SchedulableFixture` has never had (it is
// `home`/`away`). Vitest does not typecheck, so all three tests below passed
// green against a fixture shape the engine cannot read — `tsc` was the only
// thing that caught it. The cast is what bought that: it silenced the one
// check that could tell.
const config: SlotConfig & { courts: string[] } = {
  startAt: T0,
  matchMinutes: 30,
  gapMinutes: 10,
  courts: ["C1"],
  perEntrantMinRest: 30,
  window: { from: T0, to: T0 + 240 * MIN },
  tz: "Europe/London",
};

const fixtures: SchedulableFixture[] = [
  { id: "a", home: "E1", away: "E2", roundNo: 1 },
  { id: "b", home: "E3", away: "E4", roundNo: 1 },
];

/** Resolve — never reject — the way a refusal really arrives.
 *
 *  The outcome is typed as `SolveBuildOutcome` rather than cast, so if the
 *  service's response shape moves this stops compiling instead of quietly
 *  mocking something the caller can no longer receive. That matters more here
 *  than usual: the whole defect under test was a field on this object being
 *  dropped. */
function refusal(code: string, message: string): PlacementSolver {
  const outcome: SolveBuildOutcome = {
    assignments: [],
    status: "ERROR",
    tiersCompleted: 0,
    objectiveValues: [],
    elapsedMs: 4,
    wallExhausted: false,
    error: { code, message },
  };
  return resolvingSolver(outcome);
}

describe("a refused placement request explains itself", () => {
  it("logs the service's own code AND message when it refuses", async () => {
    const { lines, log } = recordingLogger();

    await buildSchedule({
      fixtures,
      config,
      solve: refusal("INVALID_REQUEST", "slots[0].day_index must be >= 0, got -1."),
      log,
    });

    const payloads = lines.filter((l) => l.level === "warn").map((l) => l.fields);
    const refused = payloads.find((p) => p["code"] === "INVALID_REQUEST");
    expect(refused, "no warn carried the refusal code").toBeDefined();
    // The MESSAGE is the half that was being dropped, and the half that
    // actually names the fault. Asserting only the code would pass against a
    // fix that still threw the diagnosis away.
    expect(refused?.["message"]).toBe("slots[0].day_index must be >= 0, got -1.");
  });

  it("still falls back to greedy, and still names the status it always did", async () => {
    const { log } = recordingLogger();

    const built = await buildSchedule({
      fixtures,
      config,
      solve: refusal("INVALID_REQUEST", "fixtures must not be empty"),
      log,
    });

    // Behaviour is UNCHANGED — this wave adds observability, not a new policy.
    // Pinned so a later edit cannot quietly turn a logged refusal into a
    // different caller-visible outcome.
    expect(built.status).toBe("solver_unavailable");
  });

  it("keeps SOLVER_BUSY on its own status, and logs that too", async () => {
    const { lines, log } = recordingLogger();

    const built = await buildSchedule({
      fixtures,
      config,
      solve: refusal("SOLVER_BUSY", "all 1 solve slots are in use."),
      log,
    });

    // The two codes take different branches, so they are mutated separately:
    // a fix that logged only the `solver_unavailable` branch would pass the
    // first test above and fail this one.
    expect(built.status).toBe("solver_busy");
    const codes = lines.filter((l) => l.level === "warn").map((l) => l.fields["code"]);
    expect(codes).toContain("SOLVER_BUSY");
  });
});
