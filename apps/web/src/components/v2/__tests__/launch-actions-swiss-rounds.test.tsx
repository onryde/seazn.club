// W3 Task 11 (X-SW-16) — the console's Start refused because a Swiss has more rounds than its field can pair. The server's
// SWISS_ROUNDS_ABOVE_MAX is English wire text; before this the button painted `err.message` verbatim in every locale. This
// presses production's own Start (then the confirmation) and reads the red line back: the dictionary's refusal sentence,
// then the field's guidance (rulebook §3.2 for a field of 4: 2 rounds recommended, at most 3).
//
// Single-sport by nature: the refusal's details are numbers; no sport field reaches the button.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { SWISS_REFUSALS } from "@/lib/swiss-refusals";
import enUi from "@/dictionaries/en/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/acme/c/champs/d/open",
}));

const net = vi.hoisted(() => ({ answer: null as null | { status: number; code: string; message: string; extra: Record<string, unknown> } }));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: () =>
      net.answer
        ? Promise.reject(new actual.ApiV1Error(net.answer.message, net.answer.status, net.answer.code, net.answer.extra))
        : Promise.resolve({ generated: 0 }),
  };
});

import { LaunchActions } from "../launch-actions";
import { StartConfirmDialog } from "../start-confirm-dialog";

const EN = enUi as unknown as Record<string, string>;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k]));

type LaunchProps = Parameters<typeof LaunchActions>[0];
const props: LaunchProps = {
  divisionId: "d1",
  orgSlug: "acme",
  compSlug: "champs",
  divSlug: "open",
  status: "setup",
  canEdit: true,
  fixtures: [],
  entrantNames: {},
  stages: [{ kind: "swiss", progression: null, config: { rounds: 5 } }],
  competitionStatus: "published",
  competitionVisibility: "public",
  viewerPlan: "pro",
};

const redLines = (tree: ReactElement[]): string[] =>
  tree.filter((el) => el.type === "span" && String(propsOf(el).className ?? "").includes("text-red-600")).map((el) => String(propsOf(el).children));

async function pressStart() {
  const island = renderIsland(LaunchActions, props);
  const button = island.tree().find((el) => propsOf(el)["data-testid"] === "launch-start-division");
  expect(button, "the Start button").toBeDefined();
  (propsOf(button!).onClick as () => void)();
  await flush();
  const confirmation = island.tree().find((el) => el.type === StartConfirmDialog);
  expect(confirmation, "the start confirmation").toBeDefined();
  (propsOf(confirmation!).onConfirm as () => void)();
  await flush();
  await flush();
  return island;
}

describe("LaunchActions — Start refused above a Swiss's hard maximum (X-SW-16)", () => {
  it("says the refusal and the field's guidance in the reader's language, never the server's English alone", async () => {
    net.answer = {
      status: 422,
      code: "SWISS_ROUNDS_ABOVE_MAX",
      message: SWISS_REFUSALS.SWISS_ROUNDS_ABOVE_MAX.message,
      extra: { rounds: 5, field: 4, hardMax: 3, canFinish: false },
    };
    const island = await pressStart();
    expect(redLines(island.tree())).toEqual([
      `${EN["swiss.refusal.SWISS_ROUNDS_ABOVE_MAX"]} ${fill(EN["swiss.rounds.guidance.other"]!, { n: 4, count: 2, hardMax: 3 })}`,
    ]);
  });

  it("the negative pair: a refusal of another code keeps its own message", async () => {
    net.answer = { status: 422, code: "SOMETHING_ELSE", message: "division has no stages to start", extra: {} };
    const island = await pressStart();
    expect(redLines(island.tree())).toEqual(["division has no stages to start"]);
  });
});
