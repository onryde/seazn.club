// ProgressionPanel — WIRING (the arguments, not the functions). Drives the
// real component through the shared hook harness (no jsdom in this repo —
// see _hook-harness.tsx) so the tie-pick gate and the edits[] payload are
// proven live, not just as pure functions. Pattern mirrors
// ai-joint-console-wiring.test.tsx: mock @/lib/client-v1's module (keep the
// real ApiV1Error class), record every call, drive selects/clicks, and read
// back exactly what reached the network.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import type { ReactElement } from "react";

const net = vi.hoisted(() => ({
  calls: [] as { url: string; method?: string; json?: unknown }[],
  handler: null as null | ((url: string, options?: { method?: string; json?: unknown }) => Promise<unknown>),
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { method?: string; json?: unknown }) => {
      net.calls.push({ url, method: options?.method, json: options?.json });
      if (!net.handler) return Promise.resolve({});
      return net.handler(url, options);
    },
  };
});

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
}));

import { ProgressionPanel, type ProgressionPanelProps } from "@/components/v2/progression-panel";

const ENTRANT_NAMES = { e1: "Alice", e2: "Bob", e3: "Carol", e4: "Dave" };
const STAGE_NAMES = { grp: "Groups" };
const FIXTURES = [
  {
    id: "f1",
    home_slot_label: { key: "slot.winner_group", params: { g: "A" } },
    away_slot_label: { key: "slot.winner_group", params: { g: "B" } },
  },
];

function baseProps(overrides: Partial<ProgressionPanelProps> = {}): ProgressionPanelProps {
  return {
    stageId: "ko1",
    stageName: "Knockout",
    proposal: null,
    fixtures: FIXTURES,
    entrantNames: ENTRANT_NAMES,
    stageNames: STAGE_NAMES,
    locale: "en",
    canEdit: true,
    ...overrides,
  };
}

function findByLabel(tree: ReactElement[], label: string): ReactElement | undefined {
  return tree.find((el) => propsOf(el)["aria-label"] === label);
}

function findButtonByText(tree: ReactElement[], text: string): ReactElement | undefined {
  return tree.find((el) => el.type === "button" && (propsOf(el).children as string) === text);
}

beforeEach(() => {
  net.calls.length = 0;
  net.handler = null;
  refresh.mockClear();
});

describe("ProgressionPanel — tie-pick gating, live", () => {
  const proposalWithTie = {
    id: "p1",
    stageId: "ko1",
    status: "draft" as const,
    computed: {
      qualifiers: [
        { rank: 1, source: { stageId: "grp", group: "A", rank: 1 }, entrantId: "e1", destinationSlot: "f1:home" },
        { rank: 2, source: { stageId: "grp", group: "B", rank: 1 }, entrantId: "e3", destinationSlot: "f1:away" },
      ],
      ties: [{ slots: ["f1:home"], entrantIds: ["e1", "e2"], reason: "seed" }],
      standingsHash: "h1",
    },
  };

  it("Confirm is disabled at mount — the tie has no edit yet", () => {
    const island = renderIsland(ProgressionPanel, baseProps({ proposal: proposalWithTie }));
    const confirmBtn = findButtonByText(island.tree(), "Confirm proposal");
    expect(confirmBtn).toBeDefined();
    expect(propsOf(confirmBtn!).disabled).toBe(true);
  });

  it("picking the tied row's select ENABLES Confirm — driving real state, not a prop", () => {
    const island = renderIsland(ProgressionPanel, baseProps({ proposal: proposalWithTie }));
    const tiedSelect = findByLabel(island.tree(), "Entrant");
    expect(tiedSelect).toBeDefined();
    (propsOf(tiedSelect!).onChange as (e: { target: { value: string } }) => void)({ target: { value: "e2" } });

    const confirmBtn = findButtonByText(island.tree(), "Confirm proposal");
    expect(propsOf(confirmBtn!).disabled).toBe(false);
  });

  it("confirming after resolving the tie POSTs edits[] naming the CHOSEN entrant, not the engine's provisional one", async () => {
    net.handler = async () => ({ filled: 2 });
    const island = renderIsland(ProgressionPanel, baseProps({ proposal: proposalWithTie }));
    const tiedSelect = findByLabel(island.tree(), "Entrant");
    (propsOf(tiedSelect!).onChange as (e: { target: { value: string } }) => void)({ target: { value: "e2" } });

    const confirmBtn = findButtonByText(island.tree(), "Confirm proposal");
    await (propsOf(confirmBtn!).onClick as () => Promise<void> | void)();
    // Flush the async handler's microtasks (hook-harness gotcha: onClick's
    // `() => void confirm()` hands back undefined, not a promise).
    await new Promise((r) => setTimeout(r, 0));

    const confirmCall = net.calls.find((c) => c.url === "/api/v1/stages/ko1/seed-proposal/confirm");
    expect(confirmCall).toBeDefined();
    expect(confirmCall!.json).toEqual({
      proposalId: "p1",
      edits: [{ destinationSlot: "f1:home", entrantId: "e2" }],
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("re-selecting the SAME tied candidate twice does not duplicate — edits[] still names exactly one override", async () => {
    net.handler = async () => ({ filled: 2 });
    const island = renderIsland(ProgressionPanel, baseProps({ proposal: proposalWithTie }));
    let tiedSelect = findByLabel(island.tree(), "Entrant");
    (propsOf(tiedSelect!).onChange as (e: { target: { value: string } }) => void)({ target: { value: "e2" } });
    tiedSelect = findByLabel(island.tree(), "Entrant");
    (propsOf(tiedSelect!).onChange as (e: { target: { value: string } }) => void)({ target: { value: "e2" } });

    const confirmBtn = findButtonByText(island.tree(), "Confirm proposal");
    await (propsOf(confirmBtn!).onClick as () => Promise<void> | void)();
    await new Promise((r) => setTimeout(r, 0));

    const confirmCall = net.calls.find((c) => c.url === "/api/v1/stages/ko1/seed-proposal/confirm");
    expect((confirmCall!.json as { edits: unknown[] }).edits).toHaveLength(1);
  });
});

describe("ProgressionPanel — edit-in-place on a NON-tied row", () => {
  const proposalNoTies = {
    id: "p2",
    stageId: "ko1",
    status: "draft" as const,
    computed: {
      qualifiers: [{ rank: 1, source: { stageId: "grp", rank: 1 }, entrantId: "e1", destinationSlot: "f1:home" }],
      ties: [],
      standingsHash: "h2",
    },
  };

  it("Confirm is ENABLED at mount when there are no ties — nothing to gate on", () => {
    const island = renderIsland(ProgressionPanel, baseProps({ proposal: proposalNoTies }));
    const confirmBtn = findButtonByText(island.tree(), "Confirm proposal");
    expect(propsOf(confirmBtn!).disabled).toBe(false);
  });

  it("overriding the computed entrant produces exactly one edits[] entry", async () => {
    net.handler = async () => ({ filled: 1 });
    const island = renderIsland(ProgressionPanel, baseProps({ proposal: proposalNoTies }));
    const select = findByLabel(island.tree(), "Entrant");
    (propsOf(select!).onChange as (e: { target: { value: string } }) => void)({ target: { value: "e4" } });

    const confirmBtn = findButtonByText(island.tree(), "Confirm proposal");
    await (propsOf(confirmBtn!).onClick as () => Promise<void> | void)();
    await new Promise((r) => setTimeout(r, 0));

    const confirmCall = net.calls.find((c) => c.url === "/api/v1/stages/ko1/seed-proposal/confirm");
    expect(confirmCall!.json).toEqual({
      proposalId: "p2",
      edits: [{ destinationSlot: "f1:home", entrantId: "e4" }],
    });
  });

  it("reverting the select back to the ORIGINAL computed entrant clears the edit — edits[] is empty, not a phantom no-op override", async () => {
    net.handler = async () => ({ filled: 1 });
    const island = renderIsland(ProgressionPanel, baseProps({ proposal: proposalNoTies }));
    let select = findByLabel(island.tree(), "Entrant");
    (propsOf(select!).onChange as (e: { target: { value: string } }) => void)({ target: { value: "e4" } });
    select = findByLabel(island.tree(), "Entrant");
    (propsOf(select!).onChange as (e: { target: { value: string } }) => void)({ target: { value: "e1" } }); // back to original

    const confirmBtn = findButtonByText(island.tree(), "Confirm proposal");
    await (propsOf(confirmBtn!).onClick as () => Promise<void> | void)();
    await new Promise((r) => setTimeout(r, 0));

    const confirmCall = net.calls.find((c) => c.url === "/api/v1/stages/ko1/seed-proposal/confirm");
    expect((confirmCall!.json as { edits: unknown[] }).edits).toEqual([]);
  });
});

describe("ProgressionPanel — compute/recompute wiring", () => {
  it("no proposal yet: clicking Compute proposal POSTs the recompute route", async () => {
    net.handler = async () => ({ id: "p3", stageId: "ko1", status: "draft", computed: { qualifiers: [], ties: [], standingsHash: "h" } });
    const island = renderIsland(ProgressionPanel, baseProps({ proposal: null }));
    const computeBtn = findButtonByText(island.tree(), "Compute proposal");
    expect(computeBtn).toBeDefined();
    await (propsOf(computeBtn!).onClick as () => Promise<void> | void)();
    await new Promise((r) => setTimeout(r, 0));

    expect(net.calls.some((c) => c.url === "/api/v1/stages/ko1/seed-proposal" && c.method === "POST")).toBe(true);
    expect(refresh).toHaveBeenCalled();
  });

  it("a stale proposal: clicking Recompute POSTs the SAME recompute route (never confirm)", async () => {
    net.handler = async () => ({});
    const staleProposal = {
      id: "p4",
      stageId: "ko1",
      status: "stale" as const,
      computed: { qualifiers: [], ties: [], standingsHash: "h" },
    };
    const island = renderIsland(ProgressionPanel, baseProps({ proposal: staleProposal }));
    const recomputeBtn = findButtonByText(island.tree(), "Recompute");
    expect(recomputeBtn).toBeDefined();
    await (propsOf(recomputeBtn!).onClick as () => Promise<void> | void)();
    await new Promise((r) => setTimeout(r, 0));

    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]!.url).toBe("/api/v1/stages/ko1/seed-proposal");
    expect(net.calls.some((c) => c.url.includes("confirm"))).toBe(false);
  });
});

describe("ProgressionPanel — API errors resolve through seedingErrorMessage, never a raw code", () => {
  it("a SEEDING_TIE_UNRESOLVED confirm failure shows the translated copy, not the wire code", async () => {
    const { ApiV1Error } = await import("@/lib/client-v1");
    net.handler = async () => {
      throw new ApiV1Error("a flagged tie is not resolved", 422, "SEEDING_TIE_UNRESOLVED");
    };
    const proposalNoTies = {
      id: "p5",
      stageId: "ko1",
      status: "draft" as const,
      computed: {
        qualifiers: [{ rank: 1, source: { stageId: "grp", rank: 1 }, entrantId: "e1", destinationSlot: "f1:home" }],
        ties: [],
        standingsHash: "h5",
      },
    };
    const island = renderIsland(ProgressionPanel, baseProps({ proposal: proposalNoTies }));
    const confirmBtn = findButtonByText(island.tree(), "Confirm proposal");
    await (propsOf(confirmBtn!).onClick as () => Promise<void> | void)();
    await new Promise((r) => setTimeout(r, 0));

    const text = island.text();
    expect(text).toContain("Resolve every tied slot before confirming");
    expect(text).not.toContain("SEEDING_TIE_UNRESOLVED");
  });
});
