// W4 T12 follow-up — the AI console's one-tap Undo says a refused restore IN FULL, at the call site.
//
// `aiUndoErrorText` (ai-console-state.test.ts) pins the sentence from the pieces; nothing there can see whether the console's
// `undo` hands it the envelope's FIELDS. A call site that went back to `msg(aiUndoErrorKey(...))` prints a literal "{min}" for
// QUALIFYING_MAIN_TOO_FEW and leaves every pure suite green — the inert seam. So this drives the real console through the
// shared hook harness: a plan lands, Apply writes the checkpoint, the Undo's restore is refused with a knockout code, and the
// message the apply step is handed is read back.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import type { AiPlanResponse } from "@/server/api-v1/schemas";
import en from "@/dictionaries/en/ui.json";

/** Every api call the console made, in order, and the answer it gets next. */
const net = vi.hoisted(() => ({
  calls: [] as { url: string; method?: string; json?: unknown }[],
  handler: null as null | ((url: string, options?: { method?: string; json?: unknown }) => Promise<unknown>),
}));

// The module is mocked rather than an `api` prop injected, so the production call sites ship exactly as they are.
// `ApiV1Error` stays the REAL class: the console reads its `extra` through `instanceof`.
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { method?: string; json?: unknown }) => {
      net.calls.push({ url, method: options?.method, json: options?.json });
      if (!net.handler) return Promise.reject(new Error(`no handler for ${url}`));
      return net.handler(url, options);
    },
  };
});

// The hookless harness has no provider tree: the rung config is replaced with the server-resolved defaults, and `usePlural`
// (which throws outside a DictProvider) with the real runtime over the real English catalogue — as ai-console-gate-wiring does.
vi.mock("../rung-config-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../rung-config-provider")>();
  const { resolveRungConfig } = await import("@/lib/ai-rung");
  const config = resolveRungConfig();
  return { ...actual, useRungConfig: () => config };
});
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  const { plural } = await import("@/lib/i18n-runtime");
  const { messages } = await import("@/lib/messages");
  return {
    ...actual,
    usePlural: () => (key: string, count: number, vars?: Record<string, string | number>) => plural(messages, key, count, "en", vars),
  };
});
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => "/o/riverside/divisions/d1",
}));

import { AiConsole } from "../ai-console";
const { ApiV1Error } = await import("@/lib/client-v1");

const DIVISION = "00000000-0000-4000-8000-000000000001";
const EN = en as unknown as Record<string, string>;

/** A plan with nothing to move: Apply still writes its checkpoint (the anchor the Undo restores) and answers "applied". */
const PLAN: AiPlanResponse = {
  proposal: [],
  unschedulable: [],
  warnings: [],
  blocking: [],
  diff: { moved: [], placed: [], unscheduled: [], unchanged: [] },
  explanations: [],
  summary: "Placed everything.",
  assumptions: [],
  usage: { input_tokens: 10, output_tokens: 20, repair_rounds: 0 },
  repair: { engine: "none" as const, solver_ran: false },
  officials_coverage: null,
};

const props: Parameters<typeof AiConsole>[0] = {
  divisionId: DIVISION,
  expectedSeq: 1,
  aiAllowed: true,
  currency: "usd",
  brief: {
    courts: ["Court 1", "Court 2"],
    windows: 1,
    blackouts: 0,
    constraintsSet: false,
    movableFixtures: [],
    pinned: 0,
    entrants: [
      { id: "e1", name: "Team A" },
      { id: "e2", name: "Team B" },
    ],
    activeEntrants: 2,
    officialsWithBlackout: 0,
  },
  fixtures: [],
  scheduleFrozen: false,
  onClose: () => {},
  viewerPlan: "community",
};

type Dispatch = (action: Record<string, unknown>) => void;

const briefStep = (tree: ReactElement[]): ReactElement => {
  const el = tree.find((e) => typeof propsOf(e).run === "function" && typeof propsOf(e).preview === "function");
  if (!el) throw new Error("brief step not rendered — the console did not mount");
  return el;
};
const applyStep = (tree: ReactElement[]): ReactElement => {
  const el = tree.find((e) => typeof propsOf(e).onApply === "function" && typeof propsOf(e).onUndo === "function");
  if (!el) throw new Error("apply step not rendered");
  return el;
};

/** The console, applied, with its Undo's restore refused as `refusal` says. Returns what the apply step then shows. */
async function undoRefused(refusal: unknown): Promise<{ message: string; key: string | undefined; restores: number }> {
  net.calls = [];
  net.handler = (url, options) => {
    if (options?.method === "POST" && url.endsWith("/checkpoints")) return Promise.resolve({ id: "cp-1" });
    if (options?.method === "POST" && url.endsWith("/restore")) return Promise.reject(refusal);
    if (url === "/api/v1/officials") return Promise.resolve([]);
    return Promise.reject(new Error(`unanswered ${options?.method ?? "GET"} ${url}`));
  };
  const island = renderIsland(AiConsole, props);
  const dispatch = propsOf(briefStep(island.tree())).dispatch as Dispatch;
  dispatch({ type: "RUN_DONE", plan: PLAN });
  dispatch({ type: "GOTO_STEP", step: "apply" });
  await (propsOf(applyStep(island.tree())).onApply as (officials: boolean, ticked: string[]) => Promise<void>)(false, []);
  expect(propsOf(applyStep(island.tree())).applyResult, "premise: the apply landed and wrote the anchor").toMatchObject({
    schedule: "applied",
    checkpointId: "cp-1",
  });
  await (propsOf(applyStep(island.tree())).onUndo as () => Promise<void>)();
  const error = (propsOf(applyStep(island.tree())).state as { error: { message: string; key?: string } | null }).error;
  expect(error, "the refused Undo left an error on the apply step").not.toBeNull();
  const restores = net.calls.filter((c) => c.method === "POST" && c.url === `/api/v1/divisions/${DIVISION}/restore`);
  expect(restores.map((c) => c.json), "premise: the Undo restored the checkpoint the apply wrote").toEqual([{ checkpoint_id: "cp-1", confirm: true }]);
  return { message: error!.message, key: error!.key, restores: restores.length };
}

describe("AiConsole — a refused one-tap Undo says the refusal in full (W4 T12 follow-up)", () => {
  beforeEach(() => {
    net.calls = [];
    net.handler = null;
  });

  it("fills QUALIFYING_MAIN_TOO_FEW's {min} from the envelope the restore was refused with", async () => {
    expect(EN["knockout.refusal.QUALIFYING_MAIN_TOO_FEW"], "premise: the dictionary's sentence has a hole").toContain("{min}");
    let checked = 0;
    // Two bounds: the sentence follows the envelope's field, not a constant.
    for (const min of [4, 8]) {
      const out = await undoRefused(new ApiV1Error("server: too few", 422, "QUALIFYING_MAIN_TOO_FEW", { min }));
      expect(out.message).toBe(`Qualifying + Main draw needs at least ${min} entrants.`);
      expect(out.message).not.toContain("{");
      expect(out.key, "the state's key stays the refusal's own").toBe("knockout.refusal.QUALIFYING_MAIN_TOO_FEW");
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("says a refusal that names nothing as the dictionary does, and anything else as before (positive pair)", async () => {
    const barrier = await undoRefused(new ApiV1Error("server: draw confirmed", 409, "SEED_CONFIRM_NOT_UNDOABLE"));
    expect(barrier.message).toBe(EN["knockout.refusal.SEED_CONFIRM_NOT_UNDOABLE"]);
    const other = await undoRefused(new ApiV1Error("server: boom", 500, "SOMETHING_ELSE"));
    expect(other.message).toBe(EN["board.ai.errorGeneric"]);
    expect(other.key).toBe("board.ai.errorGeneric");
  });
});
