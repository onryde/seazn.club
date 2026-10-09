// R7 follow-ups item 2 — the fixture-console header card renders
// `summary.headline` verbatim with no `ownsHeadline`-style guard, so a fresh
// cricket fixture (no innings yet) shows the pad's old `— — —` noise: the
// literal em-dash `sideLine` (cricket.ts) produces for a side with no
// innings. Drives the REAL cricket fold, never a hand-shaped state, the same
// discipline `headline-ownership.test.ts` uses for the pad's own predicate.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventEnvelope } from "@seazn/engine/core";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { builtinModules } from "@seazn/engine/sports";
import { FixtureConsole } from "@/components/v2/fixture-console";
import type { LiveState, SideInfo, SportInfo } from "@/components/v2/fixture-console";
import { foldClient } from "@/components/v2/scorepad/module-client";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const cricket = builtinModules.find((m) => m.key === "cricket")!;
const CFG = cricket.configSchema.parse({});

const sport: SportInfo = {
  key: "cricket",
  config: {},
  scorerLabel: "Scorer",
  positionGroups: [],
  roles: [],
  lineupSize: 11,
  benchMax: 0,
};

const side = (id: string, name: string): SideInfo => ({ id, name, members: [], lineup: [] });

const BALL = [
  "cricket.ball",
  { over: 0, ballInOver: 1, striker: "H-p1", nonStriker: "H-p2", bowler: "A-p1", runs: { bat: 1 } },
] as const;

function foldState(stream: readonly (readonly [string, unknown])[]): unknown {
  const lineups = defaultLineupPair(cricket.positions);
  const events: EventEnvelope[] = stream.map(([type, payload], i) =>
    makeEnvelope(i, { type, payload } as never),
  );
  return foldClient(cricket, CFG, lineups, events);
}

function consoleHtml(stream: readonly (readonly [string, unknown])[]): string {
  const state = foldState(stream);
  const summary = cricket.summary(state as never);
  const live: LiveState = { status: "in_play", last_seq: stream.length, summary, state, outcome: null };
  return renderToStaticMarkup(
    <FixtureConsole
      fixture={{ id: "f1", status: "in_play", scheduled_at: null, venue_name: null, court_name: null, round_no: 1 }}
      sport={sport}
      home={side("e-home", "Home XI")}
      away={side("e-away", "Away XI")}
      initialState={live}
      initialEvents={[]}
      canEdit
      canOrganise
      stageKind={null}
      recorderNames={{}}
      audit={null}
      viewerPlan="community"
    />,
  );
}

describe("fixture-console header — cricket pre-innings noise (R7 follow-ups item 2)", () => {
  it("shows nothing where the header would have said `— — —` before a ball is bowled", () => {
    const html = consoleHtml([["core.start", {}]]);
    expect(html, "the state this rule exists for").not.toContain("— — —");
  });

  it("keeps showing the headline once an innings exists", () => {
    const html = consoleHtml([["core.start", {}], BALL]);
    expect(html, "an innings exists, so the header still earns its place").not.toContain("— — —");
    expect(html).toMatch(/font-mono text-2xl/);
  });

  it("never suppresses a non-cricket sport's header, even with no events yet", () => {
    const football = builtinModules.find((m) => m.key === "football")!;
    const footballCfg = football.configSchema.parse(
      (football.variants as Record<string, unknown> | undefined)?.["11-a-side"] ?? {},
    );
    const lineups = defaultLineupPair(football.positions);
    const events: EventEnvelope[] = [makeEnvelope(0, { type: "core.start", payload: {} } as never)];
    const state = foldClient(football, footballCfg, lineups, events);
    const summary = football.summary(state as never);
    const live: LiveState = { status: "scheduled", last_seq: 1, summary, state, outcome: null };
    const html = renderToStaticMarkup(
      <FixtureConsole
        fixture={{ id: "f2", status: "scheduled", scheduled_at: null, venue_name: null, court_name: null, round_no: 1 }}
        sport={{
          key: "football",
          config: {},
          scorerLabel: "Referee",
          positionGroups: [],
          roles: [],
          lineupSize: 11,
          benchMax: 5,
        }}
        home={side("e-home", "Riverside FC")}
        away={side("e-away", "Summit Athletic")}
        initialState={live}
        initialEvents={[]}
        canEdit
        canOrganise
        stageKind={null}
        recorderNames={{}}
        audit={null}
        viewerPlan="community"
      />,
    );
    expect(html).toMatch(/font-mono text-2xl/);
  });
});
