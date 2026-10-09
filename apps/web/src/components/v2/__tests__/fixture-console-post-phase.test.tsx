// Task 19 — owner ruling 17 (2026-09-06, "Decision 1 - fix"). Task 18 proved
// a band-2 organiser cannot post `cricket.player.line` through the product:
// its only panel is `phase: "post"` (cricket.ts:3090-3096), the cricket
// skin's `resolvePhase` (skins/cricket.tsx:1163-1167) reaches that PadPhase
// ONLY once the fixture's own `state.phase` is "done"/"final", and BOTH real
// consumers of the pad — this console (`fixture-console.tsx:484,801`) and
// the device-link route (`device-score-pad.tsx:207,318`) — unmounted the pad
// the INSTANT the fixture became `decided`. Same instant, no window.
//
// `shouldMountPad` is the one predicate both files now share (exported from
// `fixture-console.tsx`, imported by `device-score-pad.tsx` — that file
// already imports plain types from here, e.g. `SportInfo`/`LiveState`, so
// this follows the same cross-file convention rather than inventing a new
// one). This suite has two layers:
//
//   1. The predicate itself, in isolation (Step 1 of the brief) — specs
//      derived from the REAL engine modules' own `padSpec(cfg)`, never a
//      hand-typed table (memory rule #19 — a value typed into a test drifts
//      from the source of truth the moment the schema changes under it).
//   2. A real render of BOTH consumers with a REAL decided cricket fold
//      (via `foldClient`, the same discipline
//      `fixture-console-header-cricket.test.tsx` uses) proving the OUTER
//      mount gate actually opens — a green predicate test alone cannot see
//      whether it is wired into the JSX at all (memory rule #1, "the inert
//      seam": code declared, typed and unit-green, but nothing in
//      production ever reads it). Football (no post-phase panel) proves the
//      unchanged path in the SAME two consumers.
//
// The browser-level proof — the pad actually SHOWING the Scorecard action
// and a scorer completing it — is `apps/web/e2e/scorepad-v3-cricket-lines.spec.ts`,
// un-fixme'd by this same task; this file only proves the React-level mount
// decision, not the DOM inside the pad (pad-host.tsx's own header: "this
// file's own suite proves every DECISION, not the DOM").
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventEnvelope } from "@seazn/engine/core";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { builtinModules } from "@seazn/engine/sports";
import { FixtureConsole, shouldMountPad } from "@/components/v2/fixture-console";
import type { LiveState, SideInfo, SportInfo } from "@/components/v2/fixture-console";
import { DeviceScorePad } from "@/components/v2/device-score-pad";
import { foldClient } from "@/components/v2/scorepad/module-client";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const cricket = builtinModules.find((m) => m.key === "cricket")!;
const football = builtinModules.find((m) => m.key === "football")!;
const CRICKET_CFG = cricket.configSchema.parse({});
const FOOTBALL_CFG = football.configSchema.parse(
  (football.variants as Record<string, unknown> | undefined)?.["11-a-side"] ?? {},
);

// Derived from the modules' own declarations, per the header note above —
// never retyped as a literal `{panels: [...]}` object.
const cricketPadSpec = cricket.padSpec!(CRICKET_CFG);
const footballPadSpec = football.padSpec!(FOOTBALL_CFG);

describe("shouldMountPad (owner ruling 17)", () => {
  it("mounts while the fixture is live regardless of the spec", () => {
    expect(shouldMountPad({ decided: false, padSpec: footballPadSpec })).toBe(true);
  });

  it("unmounts a decided fixture whose module declares no post-phase actions (unchanged)", () => {
    // Pin the premise first: football really has no post-phase panel, so a
    // false here would be witnessing a stale engine fact, not the predicate.
    expect(footballPadSpec.panels.some((p) => p.phase === "post")).toBe(false);
    expect(shouldMountPad({ decided: true, padSpec: footballPadSpec })).toBe(false);
  });

  it("keeps a decided fixture mounted when the module declares a post-phase panel", () => {
    expect(cricketPadSpec.panels.some((p) => p.phase === "post")).toBe(true);
    expect(shouldMountPad({ decided: true, padSpec: cricketPadSpec })).toBe(true);
  });
});

const side = (id: string, name: string): SideInfo => ({ id, name, members: [], lineup: [] });

const cricketSport: SportInfo = {
  key: "cricket",
  config: {},
  scorerLabel: "Scorer",
  positionGroups: [],
  roles: [],
  lineupSize: 11,
  benchMax: 0,
};

const footballSport: SportInfo = {
  key: "football",
  config: {},
  scorerLabel: "Referee",
  positionGroups: [],
  roles: [],
  lineupSize: 11,
  benchMax: 5,
};

/** The SAME force-closed-innings sequence `scorepad-v3-cricket-lines.spec.ts`
 *  uses to reach "post" phase fast: `core.start` plus two FORCE-CLOSED
 *  (`partial` omitted) `cricket.innings.summary` totals decide a win under
 *  the default `inningsPerSide: 1` cfg (`decideAfterClose`, cricket.ts). */
function decidedCricketFold(): { state: unknown; envelopes: EventEnvelope[] } {
  const lineups = defaultLineupPair(cricket.positions);
  const stream: (readonly [string, unknown])[] = [
    ["core.start", {}],
    ["cricket.innings.summary", { runs: 150, wickets: 1, legalBalls: 120 }],
    ["cricket.innings.summary", { runs: 151, wickets: 1, legalBalls: 100 }],
  ];
  const envelopes: EventEnvelope[] = stream.map(([type, payload], i) =>
    makeEnvelope(i, { type, payload } as never),
  );
  const state = foldClient(cricket, CRICKET_CFG, lineups, envelopes);
  return { state, envelopes };
}

/** `core.start`, a home goal, then HT/FT — `resolveFullTime` (football.ts)
 *  decides a 1-0 win the instant "FT" posts (default `extraTime.enabled:
 *  false`), no shoot-out needed. */
function decidedFootballFold(): { state: unknown; envelopes: EventEnvelope[] } {
  const lineups = defaultLineupPair(football.positions);
  const stream: (readonly [string, unknown])[] = [
    ["core.start", {}],
    ["football.goal", { by: "H" }],
    ["football.period", { phase: "HT" }],
    ["football.period", { phase: "FT" }],
  ];
  const envelopes: EventEnvelope[] = stream.map(([type, payload], i) =>
    makeEnvelope(i, { type, payload } as never),
  );
  const state = foldClient(football, FOOTBALL_CFG, lineups, envelopes);
  return { state, envelopes };
}

function decidedLiveState(module: typeof cricket | typeof football, state: unknown): LiveState {
  const summary = module.summary(state as never);
  const outcome = module.outcome(state as never);
  expect(outcome, "the fold above must actually decide the match, or this proof is vacuous").not.toBeNull();
  return { status: "decided", last_seq: 4, summary, state, outcome };
}

describe("fixture-console: the pad's actual mount site (owner ruling 17)", () => {
  it("keeps the cricket pad mounted on a decided fixture (post-phase Scorecard panel exists)", () => {
    const { state, envelopes } = decidedCricketFold();
    const live = decidedLiveState(cricket, state);
    const html = renderToStaticMarkup(
      <FixtureConsole
        fixture={{ id: "f-cricket-decided", status: "decided", scheduled_at: null, venue_name: null, court_name: null, round_no: 1 }}
        sport={cricketSport}
        viewerPlan="community"
        home={side("e-home", "Home XI")}
        away={side("e-away", "Away XI")}
        initialState={live}
        initialEvents={[]}
        canEdit
        canOrganise
        stageKind={null}
        recorderNames={{}}
        audit={null}
        scorePadV2={{
          moduleVersion: cricket.version,
          resolvedConfig: CRICKET_CFG,
          initialEvents: envelopes,
          entitlements: {},
          identity: { recordedBy: "user-1", deviceLinkId: null },
        }}
      />,
    );
    expect(html, "the pad's own mount div must still render").toContain('data-testid="score-pad"');
  });

  it("still unmounts the football pad on a decided fixture (no post-phase panel — unchanged)", () => {
    const { state, envelopes } = decidedFootballFold();
    const live = decidedLiveState(football, state);
    const html = renderToStaticMarkup(
      <FixtureConsole
        fixture={{ id: "f-football-decided", status: "decided", scheduled_at: null, venue_name: null, court_name: null, round_no: 1 }}
        sport={footballSport}
        viewerPlan="community"
        home={side("e-home", "Riverside FC")}
        away={side("e-away", "Summit Athletic")}
        initialState={live}
        initialEvents={[]}
        canEdit
        canOrganise
        stageKind={null}
        recorderNames={{}}
        audit={null}
        scorePadV2={{
          moduleVersion: football.version,
          resolvedConfig: FOOTBALL_CFG,
          initialEvents: envelopes,
          entitlements: {},
          identity: { recordedBy: "user-1", deviceLinkId: null },
        }}
      />,
    );
    expect(html, "unchanged behaviour: football has no post-phase panel").not.toContain('data-testid="score-pad"');
  });
});

describe("device-score-pad: the SAME predicate at the device-link mount site (owner ruling 17)", () => {
  it("keeps the cricket pad mounted on a decided fixture", () => {
    const { state, envelopes } = decidedCricketFold();
    const live = decidedLiveState(cricket, state);
    const html = renderToStaticMarkup(
      <DeviceScorePad
        token="dl_test"
        deviceLinkId="link-1"
        fixture={{
          id: "f-cricket-decided",
          round_no: 1,
          venue: null,
          court_label: null,
          competition_name: "Summer League",
          division_name: "Cricket A",
        }}
        sport={cricketSport}
        home={side("e-home", "Home XI")}
        away={side("e-away", "Away XI")}
        initialState={live}
        initialEvents={[]}
        scorePadV2={{
          moduleVersion: cricket.version,
          resolvedConfig: CRICKET_CFG,
          initialEvents: envelopes,
          entitlements: {},
          identity: { recordedBy: null, deviceLinkId: "link-1" },
        }}
      />,
    );
    expect(html, "the device-link mount must open the same window").toContain('<section class="card p-4">');
  });

  it("still unmounts the football pad on a decided fixture (unchanged)", () => {
    const { state, envelopes } = decidedFootballFold();
    const live = decidedLiveState(football, state);
    const html = renderToStaticMarkup(
      <DeviceScorePad
        token="dl_test"
        deviceLinkId="link-1"
        fixture={{
          id: "f-football-decided",
          round_no: 1,
          venue: null,
          court_label: null,
          competition_name: "Summer League",
          division_name: "Football A",
        }}
        sport={footballSport}
        home={side("e-home", "Riverside FC")}
        away={side("e-away", "Summit Athletic")}
        initialState={live}
        initialEvents={[]}
        scorePadV2={{
          moduleVersion: football.version,
          resolvedConfig: FOOTBALL_CFG,
          initialEvents: envelopes,
          entitlements: {},
          identity: { recordedBy: null, deviceLinkId: "link-1" },
        }}
      />,
    );
    expect(html, "unchanged behaviour: football has no post-phase panel").not.toContain('<section class="card p-4">');
    expect(html, "the device pad's own decided notice still shows").toContain("Result recorded");
  });
});
