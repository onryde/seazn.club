// ProgressionPanel — WIRING (the arguments, not the functions). Drives the
// real component through the shared hook harness (no jsdom in this repo —
// see _hook-harness.tsx) so the tie-pick gate and the edits[] payload are
// proven live, not just as pure functions. Pattern mirrors
// ai-joint-console-wiring.test.tsx: mock @/lib/client-v1's module (keep the
// real ApiV1Error class), record every call, drive selects/clicks, and read
// back exactly what reached the network.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";
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
    sourceReady: true,
    fixtures: FIXTURES,
    entrantNames: ENTRANT_NAMES,
    stageNames: STAGE_NAMES,
    departedEntrantIds: [],
    locale: "en",
    canEdit: true,
    ...overrides,
  };
}

function findByLabel(tree: ReactElement[], label: string): ReactElement | undefined {
  return tree.find((el) => propsOf(el)["aria-label"] === label);
}

function findAllByLabel(tree: ReactElement[], label: string): ReactElement[] {
  return tree.filter((el) => propsOf(el)["aria-label"] === label);
}

/** The `value` of every rendered `<option>` inside a `<select>` element —
 *  what a real user could actually click, as opposed to what the component's
 *  state merely allows via a direct onChange call. `walk` (not a manual
 *  `.props.children` read) because the select's children here are a MIXED
 *  array — a conditional `{tied && <option/>}` alongside a separately
 *  `.map()`-produced nested array — exactly the shape `walk` already
 *  flattens for the top-level tree. */
function optionValues(select: ReactElement): string[] {
  return walk(select)
    .filter((el) => el.type === "option")
    .map((el) => propsOf(el).value as string);
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

describe("ProgressionPanel — duplicate-pick prevention across tied rows sharing a pool (review finding 1, fix round 1)", () => {
  // The shape mobile.spec.ts's real e2e drives: ONE tie spans both
  // destination slots, all 4 candidates eligible for either — never a
  // third, non-tied row in this scenario.
  const proposalSharedPool = {
    id: "p6",
    stageId: "ko1",
    status: "draft" as const,
    computed: {
      qualifiers: [
        { rank: 1, source: { stageId: "grp", rank: 1 }, entrantId: "e1", destinationSlot: "f1:home" },
        { rank: 2, source: { stageId: "grp", rank: 2 }, entrantId: "e2", destinationSlot: "f1:away" },
      ],
      ties: [{ slots: ["f1:home", "f1:away"], entrantIds: ["e1", "e2", "e3", "e4"], reason: "seed" }],
      standingsHash: "h6",
    },
  };

  it("picking an entrant in one tied row removes it from a SIBLING tied row's own rendered options — a duplicate is not reachable through the real <select>", () => {
    const island = renderIsland(ProgressionPanel, baseProps({ proposal: proposalSharedPool }));
    let selects = findAllByLabel(island.tree(), "Entrant");
    expect(selects).toHaveLength(2);
    // Before any pick, f1:away's own dropdown still offers "e3".
    expect(optionValues(selects[1]!)).toContain("e3");

    // Pick e3 for the FIRST row (f1:home) — a real user can only choose
    // among rendered <option>s, so driving onChange with a still-offered
    // value is the realistic action (unlike setting arbitrary state).
    expect(optionValues(selects[0]!)).toContain("e3");
    (propsOf(selects[0]!).onChange as (e: { target: { value: string } }) => void)({ target: { value: "e3" } });

    selects = findAllByLabel(island.tree(), "Entrant");
    // f1:home keeps offering e3 — it's that row's OWN current pick, never
    // excluded from itself.
    expect(optionValues(selects[0]!)).toContain("e3");
    // f1:away, drawing from the SAME pool, no longer offers it — before the
    // fix this option stayed present, a user could pick e3 there too,
    // allTiesResolved would still enable Confirm (slot coverage only, not
    // uniqueness), and the POST would 422 SEEDING_SLOT_DOUBLE_ASSIGNED.
    expect(optionValues(selects[1]!)).not.toContain("e3");
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

describe("ProgressionPanel — confirmedNotice pluralisation (fix round 3, Minor 6)", () => {
  // Reuses the NON-tied proposal shape — Confirm is enabled at mount, so no
  // edit is needed before clicking it.
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

  it("filled: 1 renders the SINGULAR form, not the plural", async () => {
    net.handler = async () => ({ filled: 1 });
    const island = renderIsland(ProgressionPanel, baseProps({ proposal: proposalNoTies }));
    const confirmBtn = findButtonByText(island.tree(), "Confirm proposal");
    await (propsOf(confirmBtn!).onClick as () => Promise<void> | void)();
    await new Promise((r) => setTimeout(r, 0));

    expect(island.text()).toContain("Confirmed — 1 slot filled.");
    expect(island.text()).not.toContain("1 slots filled");
  });

  it("filled: 2 renders the PLURAL form — real pluralisation, not string interpolation alone", async () => {
    net.handler = async () => ({ filled: 2 });
    const island = renderIsland(ProgressionPanel, baseProps({ proposal: proposalNoTies }));
    const confirmBtn = findButtonByText(island.tree(), "Confirm proposal");
    await (propsOf(confirmBtn!).onClick as () => Promise<void> | void)();
    await new Promise((r) => setTimeout(r, 0));

    expect(island.text()).toContain("Confirmed — 2 slots filled.");
    expect(island.text()).not.toContain("2 slot filled.");
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

describe("ProgressionPanel — a confirm failure meaning 'someone else already acted' re-syncs instead of wedging (review finding 2, fix round 1)", () => {
  const proposalNoTies = {
    id: "p7",
    stageId: "ko1",
    status: "draft" as const,
    computed: {
      qualifiers: [{ rank: 1, source: { stageId: "grp", rank: 1 }, entrantId: "e1", destinationSlot: "f1:home" }],
      ties: [],
      standingsHash: "h7",
    },
  };

  // Two organisers, or two tabs, on the same stage: the SECOND confirm 409s
  // one of these. Before the fix, the catch block only rendered the
  // translated error and left the panel rendered as "draft" holding stale
  // editsBySlot state — there's no recompute affordance on the draft branch
  // (that only appears once `proposal.status` flips), so the user was stuck
  // until a manual reload.
  for (const code of ["SEEDING_ALREADY_CONFIRMED", "SEEDING_PROPOSAL_STALE"] as const) {
    it(`a ${code} confirm failure calls router.refresh() so the page re-fetches and the panel leaves the dead "draft" branch`, async () => {
      const { ApiV1Error } = await import("@/lib/client-v1");
      net.handler = async () => {
        throw new ApiV1Error("already handled elsewhere", 409, code);
      };
      const island = renderIsland(ProgressionPanel, baseProps({ proposal: proposalNoTies }));
      const confirmBtn = findButtonByText(island.tree(), "Confirm proposal");
      await (propsOf(confirmBtn!).onClick as () => Promise<void> | void)();
      await new Promise((r) => setTimeout(r, 0));

      expect(refresh).toHaveBeenCalled();
    });
  }

  it("a SEEDING_TIE_UNRESOLVED failure (the organiser's OWN fixable mistake) does NOT refresh — refreshing would just discard their in-progress edits for no reason", async () => {
    const { ApiV1Error } = await import("@/lib/client-v1");
    net.handler = async () => {
      throw new ApiV1Error("a flagged tie is not resolved", 422, "SEEDING_TIE_UNRESOLVED");
    };
    const island = renderIsland(ProgressionPanel, baseProps({ proposal: proposalNoTies }));
    const confirmBtn = findButtonByText(island.tree(), "Confirm proposal");
    await (propsOf(confirmBtn!).onClick as () => Promise<void> | void)();
    await new Promise((r) => setTimeout(r, 0));

    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("ProgressionPanel — recompute clears stale local edits (review finding, fix round 2)", () => {
  // Fix round 1 (block above) closed a DUPLICATE pick within one proposal's
  // own tied rows. This is a different failure: `recompute()` never cleared
  // `editsBySlot` at all, so an edit survived ACROSS proposals — carried
  // from the draft the organiser was editing, through the moment it went
  // stale, into the brand-new proposal recompute produces. `.rerender()` is
  // the only tool that can red this: it hands down fresh props while hook
  // state (editsBySlot) carries over, exactly the shape a
  // `router.refresh()`-driven RSC refetch takes in production (see
  // reference_hook_harness_render_phase_setstate memory) — mount-then-assert
  // at the second state alone renders correctly and would miss this.
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

  it("a fresh proposal reusing the SAME destination slot renders ITS OWN computed value, not the dead pick from before the recompute", async () => {
    const island = renderIsland(ProgressionPanel, baseProps({ proposal: proposalWithTie }));

    // Organiser resolves the tie.
    const tiedSelect = findByLabel(island.tree(), "Entrant");
    (propsOf(tiedSelect!).onChange as (e: { target: { value: string } }) => void)({ target: { value: "e2" } });

    // The proposal goes stale (standings corrected elsewhere) — a fresh
    // server fetch hands THIS SAME component instance a new `proposal` prop.
    island.rerender(baseProps({ proposal: { ...proposalWithTie, status: "stale" } }));

    // Organiser clicks Recompute.
    const recomputeBtn = findButtonByText(island.tree(), "Recompute");
    expect(recomputeBtn).toBeDefined();
    await (propsOf(recomputeBtn!).onClick as () => Promise<void> | void)();
    await new Promise((r) => setTimeout(r, 0));
    expect(refresh).toHaveBeenCalled();

    // The server hands down a genuinely new proposal: same "f1:home" slot
    // key, but no longer tied and a different computed entrant (the
    // standings correction changed who qualifies).
    const freshProposal = {
      id: "p9",
      stageId: "ko1",
      status: "draft" as const,
      computed: {
        qualifiers: [
          { rank: 1, source: { stageId: "grp", group: "A", rank: 1 }, entrantId: "e5", destinationSlot: "f1:home" },
          { rank: 2, source: { stageId: "grp", group: "B", rank: 1 }, entrantId: "e3", destinationSlot: "f1:away" },
        ],
        ties: [],
        standingsHash: "h9",
      },
    };
    island.rerender(baseProps({ proposal: freshProposal, entrantNames: { ...ENTRANT_NAMES, e5: "Eve" } }));

    // Anchored on the real `value` prop (not a bare probe): before the fix
    // this read "e2" — the pre-recompute pick, still sitting in
    // editsBySlot — instead of the new proposal's own qualifier "e5".
    const select = findByLabel(island.tree(), "Entrant");
    expect(propsOf(select!).value).toBe("e5");
  });

  it("an edit whose slot does not exist in the recomputed proposal never reaches buildEditsPayload's edits[]", async () => {
    net.handler = async () => ({ filled: 1 });
    const island = renderIsland(ProgressionPanel, baseProps({ proposal: proposalWithTie }));

    const tiedSelect = findByLabel(island.tree(), "Entrant");
    (propsOf(tiedSelect!).onChange as (e: { target: { value: string } }) => void)({ target: { value: "e2" } });

    island.rerender(baseProps({ proposal: { ...proposalWithTie, status: "stale" } }));

    const recomputeBtn = findButtonByText(island.tree(), "Recompute");
    await (propsOf(recomputeBtn!).onClick as () => Promise<void> | void)();
    await new Promise((r) => setTimeout(r, 0));

    // The recomputed bracket has no "f1:*" fixture at all — a structurally
    // different proposal (the finding's "possibly a different slot set").
    const freshProposal = {
      id: "p10",
      stageId: "ko1",
      status: "draft" as const,
      computed: {
        qualifiers: [
          { rank: 1, source: { stageId: "grp", group: "A", rank: 1 }, entrantId: "e4", destinationSlot: "f9:home" },
          { rank: 2, source: { stageId: "grp", group: "B", rank: 1 }, entrantId: "e3", destinationSlot: "f9:away" },
        ],
        ties: [],
        standingsHash: "h10",
      },
    };
    island.rerender(baseProps({ proposal: freshProposal }));

    const confirmBtn = findButtonByText(island.tree(), "Confirm proposal");
    expect(propsOf(confirmBtn!).disabled).toBe(false); // zero ties on the fresh proposal — nothing to gate on
    await (propsOf(confirmBtn!).onClick as () => Promise<void> | void)();
    await new Promise((r) => setTimeout(r, 0));

    const confirmCall = net.calls.find((c) => c.url === "/api/v1/stages/ko1/seed-proposal/confirm");
    expect(confirmCall).toBeDefined();
    // The orphaned "f1:home" -> "e2" pick from before the recompute must not
    // survive into the payload — before the fix it did, and the server
    // would reject it (SEEDING_EDIT_UNKNOWN_SLOT / SEEDING_SLOT_FOREIGN_FIXTURE).
    expect((confirmCall!.json as { edits: unknown[] }).edits).toEqual([]);
  });
});
