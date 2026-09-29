// Addendum RT (Task 14b fix round 2; owner decision 2026-09-29) — the PRODUCER half of the overlay's realtime seam:
// the real `OverlayStage` hands the real `useLiveFixture` the overlay purpose, whatever the org's `realtime` says, so a
// community org's overlay asks the token route (which decides) instead of never asking. The hook's own suite
// (use-live-fixture.test.ts, "the overlay's declared realtime purpose") proves the purpose reaches the token request,
// and the route's (realtime-token/__tests__/route.test.ts) that the request's query string is the one it reads.
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

function props(realtime: boolean): OverlayStageProps {
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
  };
}

beforeEach(() => {
  seen.calls = [];
});

describe("OverlayStage declares the overlay's realtime purpose (addendum RT)", () => {
  it("with AND without the org's `realtime`, the stage's transport call carries the overlay purpose — and passes `realtime` through unchanged", () => {
    let checked = 0;
    for (const realtime of [false, true]) {
      seen.calls = [];
      renderToStaticMarkup(<OverlayStage {...props(realtime)} />);
      expect(seen.calls.length, `realtime=${realtime}: premise — the stage called the hook`).toBeGreaterThan(0);
      for (const call of seen.calls) {
        expect(call.realtime, `realtime=${realtime}`).toBe(realtime);
        expect((call.options as UseLiveFixtureOptions<OverlayLiveData>).realtimePurpose, `realtime=${realtime}`).toBe(OVERLAY_REALTIME_PURPOSE);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(2);
  });
});
