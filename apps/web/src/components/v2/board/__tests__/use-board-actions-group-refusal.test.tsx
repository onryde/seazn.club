// C38 review I1 - the board's Start / Publish all draws the first stage. A pooled group stage whose field strands an entrant
// in a pool of one (7 into 4 pools) is refused STAGE_NOT_READY / group_too_few_entrants; the board says it in the org's
// language (asserted in Spanish: the English dictionary sentence tracks the server's), never the server's English.
import { describe, expect, it, vi } from "vitest";

const net = vi.hoisted(() => ({
  reject: null as null | (() => Promise<never>),
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: () => (net.reject ? net.reject() : Promise.resolve({})),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  const { plural, t } = await import("@/lib/i18n-runtime");
  const es = (await import("@/dictionaries/es/ui.json")).default as unknown as Parameters<typeof t>[0];
  const msg = (key: string, vars?: Record<string, string | number>) => t(es, key, vars);
  const msgPlural = (key: string, count: number, vars?: Record<string, string | number>) => plural(es, key, count, "es", vars);
  return { ...actual, useMsg: () => msg, useMsgPlural: () => msgPlural };
});

import { renderIsland } from "@/components/__tests__/_hook-harness";
import { ApiV1Error } from "@/lib/client-v1";
import esUi from "@/dictionaries/es/ui.json";
import { useBoardActions, type BoardActions } from "../use-board-actions";
import type { BoardDivision, BoardFixture } from "../types";

const ES = esUi as unknown as Record<string, string>;
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k]));

// Stable, module-level references: the hook resets its overrides on a new `fixtures` reference.
const DIVISIONS = [{ id: "d1", name: "Open", seq: 1 } as unknown as BoardDivision];
const FIXTURES: BoardFixture[] = [];

function driveHook() {
  let latest: BoardActions | null = null;
  renderIsland(() => {
    latest = useBoardActions(DIVISIONS, FIXTURES, {}, {}, true);
    return null;
  }, {});
  return () => latest as BoardActions;
}

describe("useBoardActions - Start refused: a group stage that would strand an entrant (C38)", () => {
  it("says the dictionary's group-size copy in the org's language, with the wire numbers, never the server's English", async () => {
    const english = "not enough entrants to fill 4 groups - each group needs at least 2 (have 7, need 8); 1 would stand in no group";
    net.reject = () => Promise.reject(new ApiV1Error(english, 422, "STAGE_NOT_READY", { reason: "group_too_few_entrants", groups: 4, entrants: 7, required: 8 }));
    const actions = driveHook();
    expect(await actions().act("/api/v1/divisions/d1/start", "started")).toBeNull();
    expect(actions().error).toBe(fill(ES["schedule.error.tooFewGroupEntrants"]!, { groups: 4, required: 8, have: 7 }));
    expect(actions().error).not.toContain(english);
  });

  it("the negative pair: another STAGE_NOT_READY reason keeps the generic branch", async () => {
    net.reject = () => Promise.reject(new ApiV1Error("division has no stages to start", 422, "STAGE_NOT_READY", { reason: "other" }));
    const actions = driveHook();
    await actions().act("/api/v1/divisions/d1/start", "started");
    expect(actions().error).toBe("division has no stages to start");
  });
});
