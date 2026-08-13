// S12/#421 W10 — DeviceScorePad's flag-gated v2 mount. Same contract as
// fixture-console-v2-flag.test.tsx, device-link entry point: `scorePadV2`
// absent/null renders the v1 chain unchanged; present renders <ScorePad/>
// with `auth: {kind:"device_link", token}`, which is exactly the path that
// fixes carrom's missing v1 branch here (device-score-pad.tsx:274-294 has NO
// carrom arm at all — a live v1 defect recorded in _INDEX.md, deliberately
// NOT fixed on the v1 path since that would breach the byte-identity bar;
// v2 fixes it for free, one registry, both entry points).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DeviceScorePad } from "@/components/v2/device-score-pad";
import { resolveModuleClient } from "@/components/v2/scorepad/module-client";
import type { ScorePadBootstrap } from "@/components/v2/scorepad/registry";

const BASE_PROPS = {
  token: "dl_test",
  deviceLinkId: "link-1",
  fixture: {
    id: "f1",
    round_no: 1,
    venue: null,
    court_label: null,
    competition_name: "Summer League",
    division_name: "Open",
  },
  sport: {
    key: "generic",
    config: {},
    scorerLabel: "Umpire",
    positionGroups: [],
    roles: [],
    lineupSize: 0,
    fidelityTiers: [],
  },
  home: { id: "e1", name: "Home FC", members: [], lineup: [] },
  away: { id: "e2", name: "Away FC", members: [], lineup: [] },
  initialState: { status: "in_play", last_seq: 0, summary: null, state: {}, outcome: null },
  initialEvents: [],
} as const;

const BOOTSTRAP: ScorePadBootstrap = {
  moduleVersion: "1.0.0",
  resolvedConfig: { resultMode: "score", allowDraws: false, points: { w: 3, d: 1, l: 0 }, progressScore: false },
  initialEvents: [],
  entitlements: {},
  band: 3,
  identity: { recordedBy: "issuer-1", deviceLinkId: "link-1" },
};

const V2_MARKER = "All synced";

describe("DeviceScorePad — v2 scoring pad behind the flag (S12/#421)", () => {
  it("flag OFF: scorePadV2 omitted renders the v1 pad, never ScorePad", () => {
    const html = renderToStaticMarkup(<DeviceScorePad {...BASE_PROPS} />);
    expect(html).not.toContain(V2_MARKER);
  });

  it("flag ON: scorePadV2 present renders ScorePad/PadRenderer instead of the v1 pad", () => {
    const html = renderToStaticMarkup(<DeviceScorePad {...BASE_PROPS} scorePadV2={BOOTSTRAP} />);
    expect(html).toContain(V2_MARKER);
  });

  it("flag ON: a carrom fixture renders (the v1 dispatcher here has NO carrom branch at all)", () => {
    const carromCfg = resolveModuleClient("carrom", "1.0.0").configSchema.parse({});
    const html = renderToStaticMarkup(
      <DeviceScorePad
        {...BASE_PROPS}
        sport={{ ...BASE_PROPS.sport, key: "carrom" }}
        scorePadV2={{ ...BOOTSTRAP, resolvedConfig: carromCfg }}
      />,
    );
    expect(html).toContain(V2_MARKER);
    expect(html).not.toContain("Scoring is temporarily unavailable");
  });
});
