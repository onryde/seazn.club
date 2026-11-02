// W3 T11 review I1 — the schedule board's Start (`schedule-board.tsx` → `actions.act(".../start")` → `fail()`) refused
// because a Swiss has more rounds than its field can pair. The server's SWISS_ROUNDS_ABOVE_MAX sentence is English wire
// text; before this `fail()`'s generic branch painted it verbatim in every locale. The board now says the dictionary's
// refusal and the field's guidance (rulebook §3.2 for a field of 4: 2 rounds recommended, at most 3) in the org's locale.
//
// Asserted in Spanish: the English dictionary sentence equals the server's message, so only a non-English locale tells
// the localised path from the raw one (review m6). The hook harness's `useContext` reads the default value, so the
// locale is bound by replacing `useMsg()`/`useMsgPlural()` — the technique use-board-actions-locale.test.tsx uses.
//
// Single-sport by nature: the refusal's details are numbers; no sport field reaches the board.
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
import { SWISS_REFUSALS } from "@/lib/swiss-refusals";
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

describe("useBoardActions — the board's Start refused above a Swiss's hard maximum (X-SW-16)", () => {
  it("says the refusal and the field's guidance in the org's language, never the server's English", async () => {
    const english = SWISS_REFUSALS.SWISS_ROUNDS_ABOVE_MAX.message;
    net.reject = () =>
      Promise.reject(new ApiV1Error(english, 422, "SWISS_ROUNDS_ABOVE_MAX", { rounds: 5, field: 4, hardMax: 3, canFinish: false }));

    const actions = driveHook();
    const refused = await actions().act("/api/v1/divisions/d1/start", "started");

    expect(refused, "a Swiss refusal is not a gate question").toBeNull();
    expect(actions().error).toBe(
      `${ES["swiss.refusal.SWISS_ROUNDS_ABOVE_MAX"]} ${fill(ES["swiss.rounds.guidance.other"]!, { n: 4, count: 2, hardMax: 3 })}`,
    );
    expect(actions().error).not.toContain(english);
  });

  it("the negative pair: a refusal of another code keeps the generic branch (its own friendly message)", async () => {
    net.reject = () => Promise.reject(new ApiV1Error("division has no stages to start", 422, "SOMETHING_ELSE"));
    const actions = driveHook();
    await actions().act("/api/v1/divisions/d1/start", "started");
    expect(actions().error).toBe("division has no stages to start");
  });
});
