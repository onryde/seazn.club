// P1 batch review m2 — the device chrome's own correction read (`followCorrection`) reads the reloaded cfg through the sport's
// schema, as the mount's cfg is (`resolveScorePadBootstrap`) and as the pad's own reload is (`use-pad-pipeline.ts`, P1.1 m2). GET
// /fixtures/{id}/rules answers the RAW stored cfg; the chrome hands it to the inner pad as `resolvedConfig`, whose skins read it
// through the engine's pad records, which parse it and throw on a cfg the schema refuses.
//
// Driven through the real chrome: its "Void last entry" write is refused FIXTURE_RULES_CHANGED, the chrome reads the rules, and the
// assertion is what it hands the inner <ScorePad/>. Expected cfgs are the engine's own (`configSchema.parse`), never typed tables.
//
// single-sport: badminton — the correction path is sport-agnostic (one schema read through the pinned module); badminton is the
// rules-version suite's own sport (rules-version-transport.test.ts) and has a cfg its schema refuses (bestOf 4).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { builtinModules } from "@seazn/engine/sports";
import { DeviceScorePad, type PadEventIn } from "@/components/v2/device-score-pad";
import type { SideInfo, SportInfo } from "@/components/v2/fixture-console";
import { ScorePad } from "@/components/v2/scorepad/registry";
import type { FixtureRulesResult } from "@/components/v2/scorepad/transport";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";

const api = vi.hoisted(() => ({
  calls: [] as { url: string; options?: { method?: string; json?: unknown } }[],
  /** POST answers in call order: "refuse" rejects FIXTURE_RULES_CHANGED, "ok" resolves. */
  posts: [] as ("refuse" | "ok")[],
  rules: [] as unknown[],
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: vi.fn((url: string, options?: { method?: string; json?: unknown }) => {
      api.calls.push({ url, options });
      if (options?.method === "POST") {
        const next = api.posts.shift() ?? "ok";
        return next === "refuse"
          ? Promise.reject(new actual.ApiV1Error("rules changed", 409, "FIXTURE_RULES_CHANGED", { rules_version: 1 }))
          : Promise.resolve({});
      }
      if (url.endsWith("/rules")) {
        const read = api.rules.shift();
        return read === undefined ? Promise.reject(new Error("no GET /rules answer left")) : Promise.resolve(read);
      }
      if (url.includes("/events")) return Promise.resolve([SEEDED]);
      return Promise.resolve({ status: "in_play", last_seq: 1, summary: null, state: {}, outcome: null });
    }),
  };
});

const BADMINTON = builtinModules.find((m) => m.key === "badminton")!;
const CFG3 = BADMINTON.configSchema.parse(BADMINTON.variants.short) as Record<string, unknown>;
const CFG5 = BADMINTON.configSchema.parse({ ...BADMINTON.variants.short, bestOf: 5 }) as Record<string, unknown>;
const DEVICE_LINK_ID = "link-1";

const SEEDED: PadEventIn = {
  id: "ev-seed",
  seq: 1,
  type: "badminton.rally",
  payload: {},
  recorded_at: "2026-08-14T10:00:00.000Z",
  voids_event_id: null,
  device_link_id: DEVICE_LINK_ID,
};

const sport: SportInfo = { key: "badminton", config: {}, scorerLabel: "Umpire", positionGroups: [], roles: [], lineupSize: 2, benchMax: 1 };
const side = (id: string, name: string): SideInfo => ({ id, name, members: [], lineup: [] });

function baseProps(withPad = true) {
  return {
    token: "dl_test",
    deviceLinkId: DEVICE_LINK_ID,
    fixture: { id: "f1", round_no: 2, venue: null, court_label: "Court 2", competition_name: "Summer League", division_name: "Doubles" },
    sport,
    home: side("h", "Nia & Marco"),
    away: side("a", "Mira & Josh"),
    initialState: { status: "in_play", last_seq: 1, summary: null, state: {}, outcome: null },
    initialEvents: [SEEDED],
    rulesVersion: 0,
    scorePadV2: withPad
      ? {
          moduleVersion: BADMINTON.version,
          resolvedConfig: CFG3,
          initialEvents: [],
          entitlements: {},
          stageKind: null,
          band: 0 as const,
          identity: { recordedBy: null, deviceLinkId: DEVICE_LINK_ID },
          rulesVersion: 0,
        }
      : null,
  };
}

/** "Void last entry" is the only <button> this chrome renders with a `title` prop (device-score-pad-undo-pad-events.test.tsx). */
const voidButton = (tree: ReactElement[]): ReactElement => {
  const el = tree.find((e) => e.type === "button" && propsOf(e).title !== undefined);
  if (!el) throw new Error("Void last entry button not found");
  return el;
};
const scorePadProps = (tree: ReactElement[]) => {
  const el = tree.find((e) => e.type === ScorePad);
  if (!el) throw new Error("<ScorePad/> not found");
  return propsOf(el);
};
const rulesReads = () => api.calls.filter((c) => c.url.endsWith("/rules")).length;
const postBodies = () => api.calls.filter((c) => c.options?.method === "POST").map((c) => c.options!.json as Record<string, unknown>);

async function tapVoid(island: ReturnType<typeof renderIsland<ReturnType<typeof baseProps>>>) {
  (propsOf(voidButton(island.tree())).onClick as () => void)();
  await vi.advanceTimersByTimeAsync(1000);
}

beforeEach(() => {
  vi.useFakeTimers();
  api.calls.length = 0;
  api.posts.length = 0;
  api.rules.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("P1 batch m2: the device chrome's correction read hands the pad a cfg its sport's schema read", () => {
  it("a partial stored cfg reaches the pad with the schema's defaults in, at the corrected version", async () => {
    const raw = { bestOf: 5 };
    api.posts.push("refuse");
    api.rules.push({ cfg: raw, rules_version: 1, format_line: "Best of 5" } satisfies FixtureRulesResult);
    const island = renderIsland(DeviceScorePad, baseProps());
    expect(scorePadProps(island.tree()).resolvedConfig, "premise: the pad mounts on the loaded cfg").toEqual(CFG3);

    await tapVoid(island);
    expect(rulesReads()).toBe(1);
    const pad = scorePadProps(island.tree());
    expect(pad.resolvedConfig, "the schema's reading of the raw cfg").toEqual(BADMINTON.configSchema.parse(raw));
    expect(pad.resolvedConfig, "premise: the raw read lacks the defaults").not.toEqual(raw);
    expect(pad.rulesVersion).toBe(1);
  });

  it("a stored cfg the schema refuses is a failed read: the pad keeps its rules and version, and the next refusal reads again", async () => {
    const refusedCfg = { ...BADMINTON.variants.short, bestOf: 4 };
    expect(BADMINTON.configSchema.safeParse(refusedCfg).success, "premise: the schema refuses it").toBe(false);
    api.posts.push("refuse", "refuse");
    api.rules.push(
      { cfg: refusedCfg, rules_version: 1, format_line: "Best of 4" } satisfies FixtureRulesResult,
      { cfg: CFG5, rules_version: 1, format_line: "Best of 5" } satisfies FixtureRulesResult,
    );
    const island = renderIsland(DeviceScorePad, baseProps());

    await tapVoid(island);
    expect(rulesReads(), "the read was made").toBe(1);
    expect(scorePadProps(island.tree()).resolvedConfig, "kept: the refused cfg never reached the pad").toEqual(CFG3);
    expect(scorePadProps(island.tree()).rulesVersion, "kept").toBe(0);

    // The second call: the chrome still writes at the version it folds under, is refused again, and asks again.
    await tapVoid(island);
    expect(postBodies().map((b) => b.rules_version), "neither write was stamped with the refused read's version").toEqual([0, 0]);
    expect(rulesReads(), "asked again").toBe(2);
    expect(scorePadProps(island.tree()).resolvedConfig).toEqual(CFG5);
    expect(scorePadProps(island.tree()).rulesVersion).toBe(1);
  });

  it("the empty case, no pad mounted (no bootstrap, so no module pin): the chrome still follows the correction, so its next write carries the new version", async () => {
    api.posts.push("refuse", "ok");
    api.rules.push({ cfg: { bestOf: 5 }, rules_version: 1, format_line: null } satisfies FixtureRulesResult);
    const island = renderIsland(DeviceScorePad, baseProps(false));
    expect(island.tree().some((e) => e.type === ScorePad), "premise: no pad").toBe(false);

    await tapVoid(island);
    expect(rulesReads()).toBe(1);
    await tapVoid(island);
    expect(postBodies().map((b) => b.rules_version)).toEqual([0, 1]);
  });
});
