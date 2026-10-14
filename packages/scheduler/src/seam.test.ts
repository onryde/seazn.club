// The in-process seam test (engine-split 1a-4 Step 6, review R1): the REAL `buildSchedule` -> the REAL `placementSolver`
// -> the REAL gRPC client -> a fake SERVICE speaking the wire, and back.
//
// WHAT THIS PROVES THAT NO OTHER TEST HERE DOES. Each half has its own suite: the engine's with a fake SOLVER, the
// client's with an injected call seam, `placement-integration.test.ts` with a real service (skipped without one). None of
// them runs the engine's real output through the adapter, the client and a socket. A seam is proven by driving it through
// its REAL producer and consumer (AGENTS.md class 1): an adapter that dropped the secret, a client that decoded
// `fixtureIndex` through the wrong table, or an engine that stopped reading the board it was handed would each leave every
// other suite green, and the organiser with a greedy board and no log line.
//
// The fake service answers on a real loopback socket (`127.0.0.1:0`), so the client's real channel, metadata and decoder
// run. It is deliberately NOT a solver: it replays a known-good board. The wire carries no fixture ids (position IS
// identity), so the fake names a fixture by its position in `request.fixtures` and a court by its position in
// `request.courtNames`, and states the order it expects as a precondition it enforces (a violated precondition answers
// INTERNAL, which `buildSchedule` turns into a greedy board, which the assertions below then fail on).
import * as grpc from "@grpc/grpc-js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  TIER_COUNT,
  TIER_NAMES,
  buildSchedule,
  silentLogger,
  validateAssignments,
  type EngineLogger,
  type SchedulableFixture,
  type SchedulingConstraints,
  type SlotConfig,
} from "@seazn/engine/scheduling";
import { placementSolver } from "./index.ts";
import {
  SchedulerServiceService,
  SolveStatus,
  type SolveBuildRequest,
  type SolveBuildResponse,
} from "./generated/scheduler.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 8, 9, 0);
const SECRET = "seam-secret";

// ---- The corner case, copied from packages/engine/src/scheduling/build.test.ts (~:110-133). Two slots, two fixtures, and
// a start window that only `b` is bound by: greedy places `a` first and strands `b`; the only perfect matching is
// [b@C1+0, a@C1+30]. Copied rather than imported: no relative import across the package boundary.
type Cfg = SlotConfig & { courts: string[] };
const cons = (over: Partial<SchedulingConstraints>): SchedulingConstraints => ({
  noBackToBack: false,
  startWindows: [],
  fieldFairness: "off",
  parallelism: "mixed",
  crossPersonClash: "warn",
  ...over,
});
const cornerConfig: Cfg = {
  startAt: T0,
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["C1"],
  perEntrantMinRest: 0,
  tz: "Europe/London",
  window: { from: T0, to: T0 + 180 * MIN },
  sessionWindows: [{ from: T0, to: T0 + 60 * MIN }],
  constraints: cons({ startWindows: [{ target: { kind: "entrant", id: "E3" }, notAfter: T0 }] }),
};
const cornerFixtures: SchedulableFixture[] = [
  { id: "a", home: "E1", away: "E2", roundNo: 1 },
  { id: "b", home: "E3", away: "E4", roundNo: 1 },
];
/** The known-good board for that case, by fixture id (the file's own MEASURED shape in build.test.ts). */
const KNOWN_GOOD = [
  { fixtureId: "b", court: "C1", startAtMs: T0 },
  { fixtureId: "a", court: "C1", startAtMs: T0 + 30 * MIN },
] as const;

// ---- A SECOND scenario, because the corner case has ONE court and so cannot tell a court decoded by index from a court
// hard-wired to "C1". Copied from build.test.ts "returns a board the verifier accepts" (~:277): every pair of these three
// fixtures shares an entrant, so with a 45-minute rest the starts are forced 75 minutes apart and only the middle card's
// COURT is free — greedy stacks all three on C1 (imbalance 90), the known-good board puts `b` on C2 (imbalance 30), so the
// solver's board is strictly better only if the court index decodes to the right name.
const restConfig: Cfg = {
  startAt: T0,
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["C1", "C2"],
  perEntrantMinRest: 45,
  tz: "Europe/London",
  window: { from: T0, to: T0 + 180 * MIN },
};
const restFixtures: SchedulableFixture[] = [
  { id: "a", home: "E1", away: "E2", roundNo: 1 },
  { id: "b", home: "E1", away: "E3", roundNo: 1 },
  { id: "c", home: "E2", away: "E3", roundNo: 1 },
];
const REST_KNOWN_GOOD = [
  { fixtureId: "a", court: "C1", startAtMs: T0 },
  { fixtureId: "b", court: "C2", startAtMs: T0 + 75 * MIN },
  { fixtureId: "c", court: "C1", startAtMs: T0 + 150 * MIN },
] as const;

/** What the fake needs to know about a request to name its fixtures: the ids in the order `buildSchedule` sends them, and
 *  the entrant tuple each carries on the wire (entrants are numbered by first sighting over that order). A violated
 *  precondition answers INTERNAL, so a wrong assumption turns the case red instead of mis-naming a card. */
interface Scenario {
  fixtures: readonly SchedulableFixture[];
  config: Cfg;
  wireEntrants: string;
  good: readonly { fixtureId: string; court: string; startAtMs: number }[];
}
const CORNER: Scenario = { fixtures: cornerFixtures, config: cornerConfig, wireEntrants: "0,1|2,3", good: KNOWN_GOOD };
const REST: Scenario = { fixtures: restFixtures, config: restConfig, wireEntrants: "0,1|0,2|1,2", good: REST_KNOWN_GOOD };
/** Two fixtures on ONE court at ONE slot: the verifier must refuse it whatever the service claims. */
const OVERLAPPING = [
  { fixtureId: "a", court: "C1", startAtMs: T0 },
  { fixtureId: "b", court: "C1", startAtMs: T0 },
] as const;

/** The six tier rows of a FULLY PROVED reply, named from the engine's own ladder (`TIER_NAMES`), never typed here. */
const provedTiers = () => TIER_NAMES.map((name, value) => ({ name, value }));

// ---- The fake service.
interface Answer {
  scenario: Scenario;
  board: readonly { fixtureId: string; court: string; startAtMs: number }[];
}
let answer: Answer = { scenario: CORNER, board: KNOWN_GOOD };
const seen: { request: SolveBuildRequest; secret: string | undefined }[] = [];
let server: grpc.Server;
let host = "";

/** Wire index of a fixture id: the scenario's fixture order IS the order `buildSchedule` sends them in (the free fixtures
 *  in input order), pinned by the precondition below rather than assumed. */
function responseFor(request: SolveBuildRequest): SolveBuildResponse {
  const { scenario } = answer;
  const sentIn = request.fixtures.map((f) => f.entrantIndices.join(","));
  if (sentIn.join("|") !== scenario.wireEntrants) {
    throw new Error(`unexpected fixture order on the wire: ${sentIn.join("|")} (wanted ${scenario.wireEntrants})`);
  }
  const fixtureIds = scenario.fixtures.map((f) => f.id);
  return {
    assignments: answer.board.map(({ fixtureId, court, startAtMs }) => {
      const fixtureIndex = fixtureIds.indexOf(fixtureId);
      const courtIndex = request.courtNames.indexOf(court);
      if (fixtureIndex < 0 || courtIndex < 0) throw new Error(`cannot place ${fixtureId} on ${court}`);
      return { fixtureIndex, courtIndex, startAtMs };
    }),
    status: SolveStatus.SOLVE_STATUS_OPTIMAL,
    tiersCompleted: TIER_COUNT,
    objectiveValues: provedTiers(),
    elapsedMs: 5,
    wallExhausted: false,
    error: undefined,
  };
}

beforeAll(async () => {
  server = new grpc.Server();
  server.addService(SchedulerServiceService, {
    solveBuild(call: grpc.ServerUnaryCall<SolveBuildRequest, SolveBuildResponse>, callback: grpc.sendUnaryData<SolveBuildResponse>) {
      const secret = call.metadata.get("x-internal-secret")[0];
      seen.push({ request: call.request, secret: typeof secret === "string" ? secret : undefined });
      if (secret !== SECRET) {
        callback({ code: grpc.status.UNAUTHENTICATED, details: "bad secret" });
        return;
      }
      try {
        callback(null, responseFor(call.request));
      } catch (e) {
        callback({ code: grpc.status.INTERNAL, details: e instanceof Error ? e.message : String(e) });
      }
    },
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (err, bound) =>
      err ? reject(err) : resolve(bound),
    );
  });
  host = `127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
});

afterEach(() => {
  vi.unstubAllEnvs();
  seen.length = 0;
  answer = { scenario: CORNER, board: KNOWN_GOOD };
});

function recordingLogger() {
  const lines: { level: keyof EngineLogger; fields: Record<string, unknown>; message: string }[] = [];
  const at = (level: keyof EngineLogger) => (fields: Record<string, unknown>, message: string) => {
    lines.push({ level, fields, message });
  };
  return { lines, log: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") } satisfies EngineLogger };
}

describe("the engine's real output through the real adapter, client and a socket", () => {
  for (const [label, scenario] of [
    ["one court (the corner case greedy cannot solve)", CORNER],
    ["two courts (a court decoded by index, not hard-wired)", REST],
  ] as const) {
    it(`accepted, ${label}: a known-good board comes back by id, as an optimised result`, async () => {
      vi.stubEnv("PLACEMENT_SERVICE_HOST", host);
      vi.stubEnv("PLACEMENT_SERVICE_SECRET", SECRET);
      answer = { scenario, board: scenario.good };

      const built = await buildSchedule({ fixtures: scenario.fixtures, config: scenario.config, solve: placementSolver, log: silentLogger });

      // The service was really reached, once, with the secret the ADAPTER read from the environment (the engine reads none).
      expect(seen).toHaveLength(1);
      expect(seen[0]!.secret).toBe(SECRET);
      // The premise, from the request itself: every fixture of the scenario was sent.
      expect(seen[0]!.request.fixtures).toHaveLength(scenario.fixtures.length);
      expect(built.engine).toBe("optimized");
      expect(built.status).toBe("ok");
      // Decoded through the client's own index tables: the board by id equals the known-good board, not merely "has N rows".
      const byId = Object.fromEntries(built.assignments.map((a) => [a.fixtureId, { court: a.court, startAtMs: a.startAt }]));
      expect(byId).toEqual(Object.fromEntries(scenario.good.map((a) => [a.fixtureId, { court: a.court, startAtMs: a.startAtMs }])));
      expect(validateAssignments(built.assignments, scenario.config)).toEqual([]);
    }, 60_000);
  }

  it("rejected: an overlapping board from the service is refused by the verifier, and nothing is invented from it", async () => {
    vi.stubEnv("PLACEMENT_SERVICE_HOST", host);
    vi.stubEnv("PLACEMENT_SERVICE_SECRET", SECRET);
    answer = { scenario: CORNER, board: OVERLAPPING };
    const { lines, log } = recordingLogger();

    const built = await buildSchedule({ fixtures: cornerFixtures, config: cornerConfig, solve: placementSolver, log });

    expect(seen).toHaveLength(1); // the service really answered; this is not the unavailable arm
    expect(built.status).toBe("verifier_rejected");
    expect(built.engine).toBe("greedy");
    // The board is greedy's own (one card, `a` first), not the service's two overlapping rows: no card shares a court+slot.
    expect(built.assignments.map((a) => a.fixtureId)).toEqual(["a"]);
    const slots = built.assignments.map((a) => `${a.court}@${a.startAt}`);
    expect(new Set(slots).size).toBe(slots.length);
    // Loudly: the refusal is logged at error level through the injected logger.
    const errors = lines.filter((l) => l.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("verifier rejected");
  }, 60_000);

  it("a wrong secret is an unavailable service, not an accepted board (the pair of the accepted case)", async () => {
    vi.stubEnv("PLACEMENT_SERVICE_HOST", host);
    vi.stubEnv("PLACEMENT_SERVICE_SECRET", "not-the-secret");

    const built = await buildSchedule({ fixtures: cornerFixtures, config: cornerConfig, solve: placementSolver, log: silentLogger });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.secret).toBe("not-the-secret");
    expect(built.status).toBe("solver_unavailable");
    expect(built.engine).toBe("greedy");
  }, 60_000);
});
