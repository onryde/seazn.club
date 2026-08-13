// S12/#421 W10 — FixtureConsole's flag-gated v2 mount. `scorePadV2` is a
// NEW, optional, default-null prop: absent/null must render the v1 ternary
// chain exactly as before (this is the "flag off is byte-identical" review
// bar's BEHAVIOURAL half — the byte-diff half is a `git diff` review, not
// something a unit test can see), and present must render <ScorePad/>
// instead, never both.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FixtureConsole } from "@/components/v2/fixture-console";
import type { ScorePadBootstrap } from "@/components/v2/scorepad/registry";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const BASE_PROPS = {
  fixture: {
    id: "f1",
    status: "in_play",
    scheduled_at: null,
    venue: null,
    court_label: null,
    round_no: 1,
  },
  sport: {
    key: "generic",
    config: {},
    scorerLabel: "Referee",
    positionGroups: [],
    roles: [],
    lineupSize: 0,
    fidelityTiers: [],
  },
  home: { id: "e1", name: "Home FC", members: [], lineup: [] },
  away: { id: "e2", name: "Away FC", members: [], lineup: [] },
  initialState: { status: "in_play", last_seq: 0, summary: null, state: {}, outcome: null },
  initialEvents: [],
  canEdit: true,
} as const;

const BOOTSTRAP: ScorePadBootstrap = {
  moduleVersion: "1.0.0",
  resolvedConfig: { resultMode: "score", allowDraws: false, points: { w: 3, d: 1, l: 0 }, progressScore: false },
  initialEvents: [],
  entitlements: {},
  band: 3,
  identity: { recordedBy: "user-1", deviceLinkId: null },
};

// "All synced" (scorepad.queue.synced, en/ui.json) is PadRenderer's own
// status-strip text — the v1 GenericPad renders no such phrase, so its
// presence/absence is an honest signal for "which pad actually drew",
// stronger than a snapshot (which would pass even if BOTH somehow rendered).
const V2_MARKER = "All synced";

describe("FixtureConsole — v2 scoring pad behind the flag (S12/#421)", () => {
  it("flag OFF: scorePadV2 omitted renders the v1 pad, never ScorePad", () => {
    const html = renderToStaticMarkup(<FixtureConsole {...BASE_PROPS} />);
    expect(html).toContain('data-testid="score-pad"');
    expect(html).not.toContain(V2_MARKER);
  });

  it("flag OFF: scorePadV2 explicitly null behaves identically to omitted (the loader's own degrade-on-error path)", () => {
    const html = renderToStaticMarkup(<FixtureConsole {...BASE_PROPS} scorePadV2={null} />);
    expect(html).not.toContain(V2_MARKER);
  });

  it("flag ON: scorePadV2 present renders ScorePad/PadRenderer instead of the v1 pad", () => {
    const html = renderToStaticMarkup(<FixtureConsole {...BASE_PROPS} scorePadV2={BOOTSTRAP} />);
    expect(html).toContain('data-testid="score-pad"');
    expect(html).toContain(V2_MARKER);
  });

  it("flag ON with an unresolvable module version renders ScorePad's own readable fallback, never a blank section or a crash", () => {
    const html = renderToStaticMarkup(
      <FixtureConsole {...BASE_PROPS} scorePadV2={{ ...BOOTSTRAP, moduleVersion: "9.9.9" }} />,
    );
    expect(html).toContain("Scoring is temporarily unavailable");
  });
});
