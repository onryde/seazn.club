import { describe, expect, it } from "vitest";
import { foldMatch } from "@seazn/engine/core";
import { makeEnvelope } from "@seazn/engine/testkit";
import { icehockey, lineupsFor, periodCfg, foldPeriod, summaryOf } from "./_period-fold";
import { whistleAt } from "../skins/period-shared";
import type { PadHostView } from "../types";

describe("whistleAt — consecutive FT advances must not share a payload", () => {
  const cfg = periodCfg(icehockey);
  const lineups = lineupsFor(icehockey, cfg);

  function viewAt(specs: [string, unknown?][]): PadHostView {
    const state = foldPeriod(icehockey, cfg, specs);
    return {
      cfg,
      state,
      summary: summaryOf(icehockey, state),
      lineups,
      band: 3,
      phase: "live",
    } as unknown as PadHostView;
  }

  it("names the phase being closed, even with no live clockAt", () => {
    const p3 = viewAt([
      ["core.start"],
      ["icehockey.period.advance", { to: "P2" }],
      ["icehockey.period.advance", { to: "P3" }],
    ]);
    expect(whistleAt(p3)).toEqual({ period: "P3", elapsed: 0 });

    const ot = viewAt([
      ["core.start"],
      ["icehockey.goal", { by: "H" }],
      ["icehockey.goal", { by: "A" }],
      ["icehockey.period.advance", { to: "P2" }],
      ["icehockey.period.advance", { to: "P3" }],
      ["icehockey.period.advance", { to: "FT" }],
    ]);
    expect((ot.state as { phase: string }).phase).toBe("OT");
    expect(whistleAt(ot)).toEqual({ period: "OT", elapsed: 0 });
    expect(whistleAt(p3)).not.toEqual(whistleAt(ot));
  });

  it("prefers clockAt when it names the same phase", () => {
    const view = viewAt([["core.start"], ["icehockey.period.advance", { to: "P2" }]]);
    const withClock = { ...view, clockAt: { period: "P2", elapsed: 61 } };
    expect(whistleAt(withClock)).toEqual({ period: "P2", elapsed: 61 });
  });

  it("P3→FT and OT→FT both fold under strict when each carries its own whistle stamp", () => {
    const toOt = [
      makeEnvelope(0, { type: "core.start", payload: {} } as never),
      makeEnvelope(1, { type: "icehockey.goal", payload: { by: "H" } } as never),
      makeEnvelope(2, { type: "icehockey.goal", payload: { by: "A" } } as never),
      makeEnvelope(3, {
        type: "icehockey.period.advance",
        payload: { to: "P2", at: { period: "P1", elapsed: 0 } },
      } as never),
      makeEnvelope(4, {
        type: "icehockey.period.advance",
        payload: { to: "P3", at: { period: "P2", elapsed: 0 } },
      } as never),
      makeEnvelope(5, {
        type: "icehockey.period.advance",
        payload: { to: "FT", at: { period: "P3", elapsed: 0 } },
      } as never),
    ];
    const ot = foldMatch(icehockey, cfg, lineups, toOt, { strictFromSeq: 0 }) as { phase: string };
    expect(ot.phase).toBe("OT");
    const shootout = foldMatch(
      icehockey,
      cfg,
      lineups,
      [
        ...toOt,
        makeEnvelope(6, {
          type: "icehockey.period.advance",
          payload: { to: "FT", at: { period: "OT", elapsed: 0 } },
        } as never),
      ],
      { strictFromSeq: 6 },
    ) as { phase: string };
    expect(shootout.phase).toBe("SHOOTOUT");
  });
});
