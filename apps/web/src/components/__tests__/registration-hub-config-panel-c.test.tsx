// TEMP(RS004 variants) — Panel design C: "Segmented sections" (tabs, one
// section visible at a time). See registration-hub-config-panel-c.tsx's
// header for the design rationale. Leaner than panel B's suite (16 tests):
// the shared useRegistrationConfigPanelState hook (fetch/patch/save/error-
// mapping) is already proven there and in variant A's own suite — this
// file proves the Modal/focus-trap reuse plus this variant's own defining
// claim: exactly ONE section's fields are ever in the tree at a time, and
// a failed save switches to whichever tab holds the error.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";
import { Modal } from "@/components/modal";
import type { RegistrationSettingsResponse } from "@/components/registration-hub-config-state";
import {
  EligibilitySection,
  OpenCloseSection,
  CapacitySection,
  MoneySection,
} from "@/components/registration-hub-config-panel";

const net = vi.hoisted(() => ({
  calls: [] as { url: string; method: string; json?: unknown }[],
  getResponse: null as unknown,
  patchRejection: null as unknown,
  putRejection: null as unknown,
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { method?: string; json?: unknown }) => {
      const method = options?.method ?? "GET";
      net.calls.push({ url, method, json: options?.json });
      if (method === "GET") return Promise.resolve(net.getResponse);
      if (method === "PATCH") {
        if (net.patchRejection) {
          const e = net.patchRejection;
          net.patchRejection = null;
          return Promise.reject(e);
        }
        return Promise.resolve({});
      }
      if (method === "PUT") {
        if (net.putRejection) {
          const e = net.putRejection;
          net.putRejection = null;
          return Promise.reject(e);
        }
        return Promise.resolve({});
      }
      return Promise.resolve({});
    },
  };
});

import { ApiV1Error } from "@/lib/client-v1";
import { t } from "@/lib/i18n-runtime";
import uiEn from "@/dictionaries/en/ui.json";
import { RegistrationHubConfigPanelC } from "@/components/registration-hub-config-panel-c";

type SectionType = (props: Record<string, unknown>) => ReactNode;
const SECTION_TYPES: SectionType[] = [
  EligibilitySection as SectionType,
  OpenCloseSection as SectionType,
  CapacitySection as SectionType,
  MoneySection as SectionType,
];

const RESPONSE: RegistrationSettingsResponse = {
  division_id: "div-1",
  enabled: true,
  entrant_kind: "team",
  opens_at: "2026-01-01T00:00:00Z",
  closes_at: "2026-02-01T00:00:00Z",
  capacity: 32,
  fee_cents: 1500,
  currency: "usd",
  refund_lock_at: null,
  form_fields: [],
  payment_method: "offline",
  payment_instructions: null,
  approval: "manual",
  allow_free_agents: true,
  org_payment_instructions: null,
  org_default_payment_method: "offline",
  charges_enabled: true,
  updated_at: "2026-01-05T00:00:00Z",
};

const DIVISION = { division_id: "div-1", name: "Open Singles", category: "mixed" as const, age_min: 10, age_max: 18 };

const BASE_PROPS = {
  division: DIVISION,
  orgTz: "UTC",
  orgSlug: "riverside",
  currency: "usd" as const,
  feePercentPct: 8,
  cardUnsupportedCurrency: null,
  onClose: vi.fn(),
  onSaved: vi.fn(),
};

function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

function expandChildren(node: ReactNode): ReturnType<typeof walk> {
  const out = walk(node);
  for (const el of [...out]) {
    if (SECTION_TYPES.includes(el.type as SectionType)) {
      out.push(...walk((el.type as SectionType)(propsOf(el))));
    }
  }
  return out;
}

function expandPanel(node: ReactNode) {
  const out = walk(node);
  const modal = out.find((e) => e.type === Modal);
  if (modal) {
    const p = propsOf(modal);
    out.push(...expandChildren(p.children as ReactNode));
    if (p.footer) out.push(...walk(p.footer as ReactNode));
  }
  return out;
}

function findField(tree: ReturnType<typeof expandPanel>, field: string) {
  return tree.find((e) => propsOf(e)["data-field"] === field);
}

function tabButton(tree: ReturnType<typeof expandPanel>, id: string) {
  return tree.find((e) => propsOf(e)["data-config-tab"] === id);
}

beforeEach(() => {
  net.calls = [];
  net.getResponse = { ...RESPONSE };
  net.patchRejection = null;
  net.putRejection = null;
});

describe("RegistrationHubConfigPanelC — built on Modal (keeps the focus trap)", () => {
  it("renders through the shared <Modal> primitive, same title contract as variant A", async () => {
    const island = renderIsland(RegistrationHubConfigPanelC, BASE_PROPS, expandPanel);
    await flush();
    const modal = island.tree().find((e) => e.type === Modal)!;
    expect(propsOf(modal).title).toBe(t(uiEn, "reg.hub.config.title", { name: "Open Singles" }));
  });
});

describe("RegistrationHubConfigPanelC — loading and data wiring", () => {
  it("shows a loading state before the GET resolves, then the form after", async () => {
    const island = renderIsland(RegistrationHubConfigPanelC, BASE_PROPS, expandPanel);
    expect(island.text()).toContain("Loading");
    await flush();
    expect(findField(island.tree(), "category")).toBeTruthy();
  });

  it("fetches the full settings for THIS division on mount", async () => {
    renderIsland(RegistrationHubConfigPanelC, BASE_PROPS, expandPanel);
    await flush();
    expect(net.calls.find((c) => c.method === "GET")?.url).toBe("/api/v1/divisions/div-1/registration-settings");
  });
});

describe("RegistrationHubConfigPanelC — exactly ONE section's fields at a time (the design claim)", () => {
  it("defaults to the Eligibility tab: its fields are present, Money's are not", async () => {
    const island = renderIsland(RegistrationHubConfigPanelC, BASE_PROPS, expandPanel);
    await flush();
    const tree = island.tree();
    expect(findField(tree, "category")).toBeTruthy();
    expect(findField(tree, "age_max")).toBeTruthy();
    expect(findField(tree, "fee_cents")).toBeUndefined();
    expect(findField(tree, "capacity")).toBeUndefined();
  });

  it("switching to the Money tab shows fee_cents and hides Eligibility's fields", async () => {
    const island = renderIsland(RegistrationHubConfigPanelC, BASE_PROPS, expandPanel);
    await flush();
    const moneyTab = tabButton(island.tree(), "money")!;
    (propsOf(moneyTab).onClick as () => void)();
    const tree = island.tree();
    expect(findField(tree, "fee_cents")).toBeTruthy();
    expect(findField(tree, "category")).toBeUndefined();
  });

  it("the active tab has aria-selected=true and the others false", async () => {
    const island = renderIsland(RegistrationHubConfigPanelC, BASE_PROPS, expandPanel);
    await flush();
    let tree = island.tree();
    expect(propsOf(tabButton(tree, "eligibility")!)["aria-selected"]).toBe(true);
    expect(propsOf(tabButton(tree, "money")!)["aria-selected"]).toBe(false);

    (propsOf(tabButton(tree, "capacity")!).onClick as () => void)();
    tree = island.tree();
    expect(propsOf(tabButton(tree, "capacity")!)["aria-selected"]).toBe(true);
    expect(propsOf(tabButton(tree, "eligibility")!)["aria-selected"]).toBe(false);
  });
});

describe("RegistrationHubConfigPanelC — save: full replace + both endpoints", () => {
  it("editing the fee (after switching to Money) still sends every other field unchanged", async () => {
    const island = renderIsland(RegistrationHubConfigPanelC, BASE_PROPS, expandPanel);
    await flush();
    (propsOf(tabButton(island.tree(), "money")!).onClick as () => void)();
    const feeInput = findField(island.tree(), "fee_cents")!;
    (propsOf(feeInput).onChange as (e: { target: { value: string } }) => void)({ target: { value: "25" } });
    const saveBtn = island.tree().find((e) => e.type === "button" && propsOf(e)["data-action"] === "save")!;
    await (propsOf(saveBtn).onClick as () => Promise<void>)();
    const put = net.calls.find((c) => c.method === "PUT")!;
    const body = put.json as Record<string, unknown>;
    expect(body.fee_cents).toBe(2500);
    expect(body.approval).toBe("manual");
    expect(body.capacity).toBe(32);
  });

  it("sends the division PATCH with category/age_min/age_max regardless of the active tab", async () => {
    const island = renderIsland(RegistrationHubConfigPanelC, BASE_PROPS, expandPanel);
    await flush();
    const saveBtn = island.tree().find((e) => e.type === "button" && propsOf(e)["data-action"] === "save")!;
    await (propsOf(saveBtn).onClick as () => Promise<void>)();
    const patch = net.calls.find((c) => c.method === "PATCH")!;
    expect(patch.json).toEqual({ category: "mixed", age_min: 10, age_max: 18 });
  });

  it("calls onSaved when both requests succeed", async () => {
    const onSaved = vi.fn();
    const island = renderIsland(RegistrationHubConfigPanelC, { ...BASE_PROPS, onSaved }, expandPanel);
    await flush();
    const saveBtn = island.tree().find((e) => e.type === "button" && propsOf(e)["data-action"] === "save")!;
    await (propsOf(saveBtn).onClick as () => Promise<void>)();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});

describe("RegistrationHubConfigPanelC — a failed save switches to the erroring tab", () => {
  it("a PUT-side fee error switches the active tab from Eligibility to Money", async () => {
    net.putRejection = new ApiV1Error("Card entry fees must be at least 1.00 (or 0 for free)", 422, "ERROR");
    const island = renderIsland(RegistrationHubConfigPanelC, BASE_PROPS, expandPanel);
    await flush();
    // Confirm the premise: still on Eligibility, Money's fields not present.
    expect(findField(island.tree(), "fee_cents")).toBeUndefined();

    const saveBtn = island.tree().find((e) => e.type === "button" && propsOf(e)["data-action"] === "save")!;
    await (propsOf(saveBtn).onClick as () => Promise<void>)();

    const tree = island.tree();
    expect(propsOf(tabButton(tree, "money")!)["aria-selected"]).toBe(true);
    const errorEl = tree.find((e) => propsOf(e)["data-field-error"] === "fee_cents");
    expect(errorEl).toBeTruthy();
  });

  it("a PATCH-side age-band error keeps/returns to the Eligibility tab", async () => {
    net.patchRejection = new ApiV1Error("age_max must be greater than or equal to age_min.", 422, "ERROR");
    const island = renderIsland(RegistrationHubConfigPanelC, BASE_PROPS, expandPanel);
    await flush();
    (propsOf(tabButton(island.tree(), "capacity")!).onClick as () => void)(); // wander off first
    const saveBtn = island.tree().find((e) => e.type === "button" && propsOf(e)["data-action"] === "save")!;
    await (propsOf(saveBtn).onClick as () => Promise<void>)();
    const tree = island.tree();
    expect(propsOf(tabButton(tree, "eligibility")!)["aria-selected"]).toBe(true);
    expect(tree.find((e) => propsOf(e)["data-field-error"] === "age_max")).toBeTruthy();
  });
});

describe("RegistrationHubConfigPanelC — save outcome, same contract as variant A/B", () => {
  it("both endpoints succeed: outcome is 'success' on the panel root", async () => {
    const island = renderIsland(RegistrationHubConfigPanelC, BASE_PROPS, expandPanel);
    await flush();
    const saveBtn = island.tree().find((e) => e.type === "button" && propsOf(e)["data-action"] === "save")!;
    await (propsOf(saveBtn).onClick as () => Promise<void>)();
    const root = island.tree().find((e) => propsOf(e)["data-registration-hub-config-panel"] !== undefined)!;
    expect(propsOf(root)["data-save-outcome"]).toBe("success");
  });
});

describe("RegistrationHubConfigPanelC — cancel", () => {
  it("closes without writing anything", async () => {
    const onClose = vi.fn();
    const island = renderIsland(RegistrationHubConfigPanelC, { ...BASE_PROPS, onClose }, expandPanel);
    await flush();
    const cancelBtn = island.tree().find((e) => e.type === "button" && propsOf(e)["data-action"] === "cancel")!;
    (propsOf(cancelBtn).onClick as () => void)();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(net.calls.some((c) => c.method === "PATCH" || c.method === "PUT")).toBe(false);
  });
});
