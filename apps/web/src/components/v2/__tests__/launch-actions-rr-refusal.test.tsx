// W5 stress fix F7: Start answered a stage of more pools than A-Z holds with the server's English sentence (launch-actions fell
// through to `err.message` for every round-robin refusal). It now says a round-robin refusal in the reader's language, from the
// one table (`ROUND_ROBIN_REFUSALS`), the way it already says the Swiss and knockout ones. Expected copy is the dictionary's own
// entry with the refusal's numbers put in, read here, never the component's output.
import { describe, expect, it, vi } from "vitest";
import en from "@/dictionaries/en/ui.json";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import type { ReactElement } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/acme/c/champs/d/u12",
}));

const refusal = vi.hoisted(() => ({ code: "RR_TOO_MANY_POOLS", extra: { max: 26, pools: 27 } as Record<string, unknown>, message: "SERVER ENGLISH" }));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: () => Promise.reject(new actual.ApiV1Error(refusal.message, 422, refusal.code, refusal.extra)),
  };
});

import { LaunchActions } from "../launch-actions";
import { StartConfirmDialog } from "../start-confirm-dialog";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const props = (): Parameters<typeof LaunchActions>[0] => ({
  divisionId: "d1",
  orgSlug: "acme",
  compSlug: "champs",
  divSlug: "u12",
  status: "scheduled",
  canEdit: true,
  fixtures: [],
  entrantNames: {},
  stages: [{ kind: "group", progression: null, config: {} }],
  competitionStatus: "published",
  competitionVisibility: "public",
  viewerPlan: "community",
  activeEntrants: 2,
} as never);

async function startAndRead(): Promise<string> {
  const island = renderIsland(LaunchActions, props());
  const button = island.tree().find((n) => propsOf(n)["data-testid"] === "launch-start-division") as ReactElement;
  await (propsOf(button).onClick as () => void)();
  await flush();
  const dialog = island.tree().find((n) => n.type === StartConfirmDialog) as ReactElement;
  (propsOf(dialog) as { onConfirm: () => void }).onConfirm();
  await flush();
  await flush();
  return island.tree().map((n) => textOf(n)).join(" ");
}

describe("F7: Start says a round-robin refusal in the reader's language", () => {
  it("RR_TOO_MANY_POOLS renders the table's copy with its ceiling, never the server's English", async () => {
    const want = (en as Record<string, string>)["roundrobin.refusal.RR_TOO_MANY_POOLS"]!.replace("{max}", "26");
    expect(want, "premise: the copy exists").toBeTruthy();
    const text = await startAndRead();
    expect(text).toContain(want);
    expect(text).not.toContain("SERVER ENGLISH");
  });

  it("a code outside every refusal table still falls through to the server's sentence (the branch is the table's alone)", async () => {
    refusal.code = "SOMETHING_ELSE";
    refusal.extra = {};
    const text = await startAndRead();
    expect(text).toContain("SERVER ENGLISH");
  });
});
