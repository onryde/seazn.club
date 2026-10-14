// The assign sheet's targets read (ESLint L3). It used to be `if (open) void
// load()` in an effect watching `open`; opening is a click, so the click now
// starts the read. The sequence a user walks, with the request counted at each
// step: mounted (no read), open (one read, loading shown, then the teams),
// close, open again (a fresh read — fill numbers move between opens), and a
// refused assign (re-reads, list stays). Expected names are the fixtures'.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const h = vi.hoisted(() => ({ reads: 0, refuse: false }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  apiV1: vi.fn(async (url: string, options?: { method?: string }) => {
    if (url.endsWith("/assign-targets") && options === undefined) {
      h.reads += 1;
      return {
        division_id: "d1",
        division_category: null,
        targets: [
          {
            registration_id: "t1",
            display_name: "ZqTeamOne",
            roster_count: 1,
            roster_cap: 4,
            is_full: false,
            genders: [null],
          },
        ],
      };
    }
    if (url.endsWith("/assign") && options?.method === "POST") {
      if (h.refuse) throw new Error("ZqRefused: that team just filled up");
      return {};
    }
    throw new Error(`no double for ${options?.method ?? "GET"} ${url}`);
  }),
}));

import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { RegistrationHubAssignPicker } from "../registration-hub-assign-picker";

async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const PROPS = {
  registrationId: "r1",
  registrantName: "Zq Person",
  registrantGender: null,
  currentTeamId: null,
  currentTeamName: null,
  divisionName: "Open",
};

beforeEach(() => {
  h.reads = 0;
  h.refuse = false;
  // The open sheet's Esc listener lives on `document`.
  vi.stubGlobal("document", { addEventListener: () => {}, removeEventListener: () => {} });
});

const byAction = (tree: ReactElement[], action: string) =>
  tree.find((el) => propsOf(el)["data-registration-hub-assign-action"] === action);
const target = (tree: ReactElement[], id: string) =>
  tree.find((el) => propsOf(el)["data-registration-hub-assign-target"] === id);
const tap = (el: ReactElement | undefined, what: string) => {
  expect(el, `${what} rendered`).toBeDefined();
  (propsOf(el!).onClick as (e?: unknown) => void)({ stopPropagation: () => {} });
};
const backdrop = (tree: ReactElement[]) =>
  tree.find((el) => typeof propsOf(el).className === "string" && (propsOf(el).className as string).includes("fixed inset-x-0"));

describe("assign sheet — the targets are read when it is opened", () => {
  it("no read while closed; open reads once and lists the teams; close + reopen reads again", async () => {
    const island = renderIsland(RegistrationHubAssignPicker, PROPS);
    await flush();
    expect(h.reads, "mounted closed — nothing read").toBe(0);

    tap(byAction(island.tree(), "open"), "the open button");
    expect(island.text(), "loading shown at once").toMatch(/load/i);
    await flush();
    expect(h.reads).toBe(1);
    expect(target(island.tree(), "t1")).toBeDefined();
    expect(island.text()).toContain("ZqTeamOne");

    tap(backdrop(island.tree()), "the backdrop");
    expect(target(island.tree(), "t1"), "closed").toBeUndefined();
    await flush();
    expect(h.reads, "closing reads nothing").toBe(1);

    tap(byAction(island.tree(), "open"), "the open button");
    await flush();
    expect(h.reads, "a second open re-reads").toBe(2);
    expect(island.text()).toContain("ZqTeamOne");
  });

  it("a refused assign re-reads and keeps the list on screen", async () => {
    h.refuse = true;
    const island = renderIsland(RegistrationHubAssignPicker, PROPS);
    tap(byAction(island.tree(), "open"), "the open button");
    await flush();
    tap(target(island.tree(), "t1"), "the team row");
    await flush();
    expect(h.reads).toBe(2);
    expect(island.text()).toContain("ZqRefused");
    expect(target(island.tree(), "t1")).toBeDefined();
  });
});
