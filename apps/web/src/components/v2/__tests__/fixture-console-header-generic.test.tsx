// R7 follow-ups item 2, code-review finding — the fixture-console header
// card's `— — —` fix was scoped to cricket only, but generic's `sideLine`
// (generic.ts) produces the identical literal `— — —` for a fresh fixture
// (score/outcome/running all still at their `init()` shape). Same discipline
// as `fixture-console-header-cricket.test.tsx`: drives the REAL fold, never
// a hand-shaped state.
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

const generic = builtinModules.find((m) => m.key === "generic")!;
const CFG = generic.configSchema.parse({ resultMode: "score", allowDraws: false });

const sport: SportInfo = {
  key: "generic",
  config: {},
  scorerLabel: "Scorer",
  positionGroups: [],
  roles: [],
  lineupSize: 1,
  benchMax: 0,
  fidelityTiers: generic.fidelityTiers as SportInfo["fidelityTiers"],
};

const side = (id: string, name: string): SideInfo => ({ id, name, members: [], lineup: [] });

function foldState(stream: readonly (readonly [string, unknown])[]): unknown {
  const lineups = defaultLineupPair(generic.positions);
  const events: EventEnvelope[] = stream.map(([type, payload], i) =>
    makeEnvelope(i, { type, payload } as never),
  );
  return foldClient(generic, CFG, lineups, events);
}

function consoleHtml(stream: readonly (readonly [string, unknown])[]): string {
  const state = foldState(stream);
  const summary = generic.summary(state as never);
  const live: LiveState = { status: "in_play", last_seq: stream.length, summary, state, outcome: null };
  return renderToStaticMarkup(
    <FixtureConsole
      fixture={{ id: "f1", status: "in_play", scheduled_at: null, venue_name: null, court_name: null, round_no: 1 }}
      sport={sport}
      home={side("e-home", "Home Side")}
      away={side("e-away", "Away Side")}
      initialState={live}
      initialEvents={[]}
      canEdit
      recorderNames={{}}
      audit={null}
    />,
  );
}

describe("fixture-console header — generic pre-result noise (R7 follow-ups item 2, code-review finding)", () => {
  it("shows nothing where the header would have said `— — —` before any score is recorded", () => {
    const html = consoleHtml([["core.start", {}]]);
    expect(html, "the state this rule exists for").not.toContain("— — —");
  });

  it("keeps showing the headline once a score exists", () => {
    const html = consoleHtml([["core.start", {}], ["generic.score", { by: "H", points: 1 }]]);
    expect(html, "a score exists, so the header still earns its place").not.toContain("— — —");
    expect(html).toMatch(/font-mono text-2xl/);
  });
});
