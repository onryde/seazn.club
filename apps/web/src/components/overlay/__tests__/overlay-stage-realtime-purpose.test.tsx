// RT (lane-close fix, ruled 2026-09-29) — the PRODUCER half of the overlay's realtime seam. The stage no longer declares
// the overlay purpose on its own: its CALLER does, as props. The OBS page passes the purpose and the signed key from the
// URL the organiser copied; the Phone tab's preview passes neither, so it never mints a token (m6/R1) and its
// `realtime={false}` means what it says. The hook's suite proves both values reach the token request, and the route's
// (realtime-token/__tests__/route.test.ts) that the request's query string is the one it reads.
//
// `environment: "node"`: rendered with `renderToStaticMarkup`, as overlay-stage-delay.test.tsx does (the stage's
// `useLayoutEffect` rules out the hook harness). The hook still RUNS during a server render — only its effects do not
// — so wrapping it records exactly what the stage passes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { UseLiveFixtureOptions } from "@/components/public-site/match-centre/use-live-fixture";

const seen = vi.hoisted(() => ({ calls: [] as { realtime: boolean; options: unknown }[] }));
vi.mock("@/components/public-site/match-centre/use-live-fixture", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/public-site/match-centre/use-live-fixture")>();
  return {
    ...real,
    useLiveFixture: (...args: Parameters<typeof real.useLiveFixture>) => {
      seen.calls.push({ realtime: args[2], options: args[3] });
      return real.useLiveFixture(...args);
    },
  };
});

import { OverlayStage, type OverlayStageProps } from "../overlay-stage";
import { OVERLAY_REALTIME_PURPOSE, type OverlayLiveData } from "@/components/public-site/live-score-data";
import { decidedOutcomeTemplates } from "@/lib/scoring-vocab";

function props(realtime: boolean, extra: Partial<OverlayStageProps> = {}): OverlayStageProps {
  const initial: OverlayLiveData = { status: "in_play", summary: null, outcome: null, lastSeq: 1, venueTz: "UTC" };
  return {
    fixtureId: "f1",
    initial,
    realtime,
    sportKey: "football",
    style: "bug",
    sides: [
      { id: "home", name: "Home XI" },
      { id: "away", name: "Away XI" },
    ],
    startLabel: null,
    dict: {},
    decidedTemplates: decidedOutcomeTemplates((k) => k),
    ...extra,
  };
}

beforeEach(() => {
  seen.calls = [];
});

describe("OverlayStage passes its caller's realtime purpose and key through — and declares nothing of its own (RT)", () => {
  it("with the purpose and key as props (the OBS page), the transport call carries BOTH, with and without the org's `realtime`", () => {
    let checked = 0;
    for (const realtime of [false, true]) {
      seen.calls = [];
      renderToStaticMarkup(<OverlayStage {...props(realtime, { realtimePurpose: OVERLAY_REALTIME_PURPOSE, overlayKey: "KEY-f1" })} />);
      expect(seen.calls.length, `realtime=${realtime}: premise — the stage called the hook`).toBeGreaterThan(0);
      for (const call of seen.calls) {
        const options = call.options as UseLiveFixtureOptions<OverlayLiveData>;
        expect(call.realtime, `realtime=${realtime}`).toBe(realtime);
        expect(options.realtimePurpose, `realtime=${realtime}`).toBe(OVERLAY_REALTIME_PURPOSE);
        expect(options.overlayKey, `realtime=${realtime}`).toBe("KEY-f1");
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it("with NEITHER prop (the Phone tab's preview), the transport call declares no purpose and carries no key", () => {
    let checked = 0;
    for (const realtime of [false, true]) {
      seen.calls = [];
      renderToStaticMarkup(<OverlayStage {...props(realtime)} />);
      expect(seen.calls.length, "premise — the stage called the hook").toBeGreaterThan(0);
      for (const call of seen.calls) {
        const options = call.options as UseLiveFixtureOptions<OverlayLiveData>;
        expect(options.realtimePurpose, `realtime=${realtime}`).toBeUndefined();
        expect(options.overlayKey, `realtime=${realtime}`).toBeUndefined();
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(2);
  });
});
