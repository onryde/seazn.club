// RS004 W3c — the row-click config panel: fetches the division's full
// registration settings on open, edits every registration_settings field
// plus the division-level eligibility fields, and saves through both
// endpoints. Driven via the repo's hook harness (no jsdom here) — see
// _hook-harness.tsx and topic_scorepad/topic_ui_i18n memory for the
// conventions this file follows.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { Modal } from "@/components/modal";
import { FormBuilder, type FormField } from "@/components/registration-hub-form-builder";
import type { RegistrationSettingsResponse } from "@/components/registration-hub-config-state";

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
import {
  RegistrationHubConfigPanel,
  EligibilitySection,
  OpenCloseSection,
  CapacitySection,
  MoneySection,
} from "@/components/registration-hub-config-panel";

// Every section below is hookless (props in, JSX out — no useState/
// useContext of its own), so it is safe to call directly rather than
// re-enter through the harness dispatcher (_hook-harness.tsx's own
// documented technique for a "small presentational component":
// `walk(MyThing(props))`).
type SectionType = (props: Record<string, unknown>) => ReactNode;
const SECTION_TYPES: SectionType[] = [
  EligibilitySection as SectionType,
  OpenCloseSection as SectionType,
  CapacitySection as SectionType,
  MoneySection as SectionType,
];

const FORM_FIELDS: FormField[] = [
  { key: "shirt_size", label: "Shirt size", kind: "text", required: true },
  { key: "club", label: "Club", kind: "select", options: ["None", "Riverside"], required: false },
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
  form_fields: FORM_FIELDS,
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

// Custom expand: `walk` alone stops at Modal/FormBuilder (unevaluated
// elements), so mount props on the panel's own root are visible, but its
// children never are. Descend the SAME way renderIsland's own effects and
// state updates see the tree — one level into Modal's `children` AND
// `footer` (neither is reachable by the default `.props.children`-only
// walk), and into FormBuilder's rendered output (it is hookless-safe here
// because it is walked, not re-entered through the harness dispatcher —
// its own useMsg() call still runs via React's real hook rules the FIRST
// time the whole tree is produced by the panel's own render).
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

beforeEach(() => {
  net.calls = [];
  net.getResponse = { ...RESPONSE };
  net.patchRejection = null;
  net.putRejection = null;
});

describe("RegistrationHubConfigPanel — loading", () => {
  it("shows a loading state before the GET resolves, then the form after", async () => {
    const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    expect(island.text()).toContain("Loading");
    await flush();
    const tree = island.tree();
    expect(findField(tree, "fee_cents")).toBeTruthy();
  });

  it("fetches the full settings for THIS division on mount", async () => {
    renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    const get = net.calls.find((c) => c.method === "GET");
    expect(get?.url).toBe("/api/v1/divisions/div-1/registration-settings");
  });
});

describe("RegistrationHubConfigPanel — shows current values, including the five new fields", () => {
  it("renders category, age_min, age_max, approval and allow_free_agents from the row + GET response", async () => {
    const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    const tree = island.tree();
    expect(propsOf(findField(tree, "category")!).value).toBe("mixed");
    expect(propsOf(findField(tree, "age_min")!).value).toBe(10);
    expect(propsOf(findField(tree, "age_max")!).value).toBe(18);
    expect(propsOf(findField(tree, "approval")!).value).toBe("manual");
    expect(propsOf(findField(tree, "allow_free_agents")!).checked).toBe(true);
  });

  it("renders the fee, capacity and enabled flag from the GET response", async () => {
    const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    const tree = island.tree();
    expect(propsOf(findField(tree, "capacity")!).value).toBe(32);
    expect(propsOf(findField(tree, "enabled")!).checked).toBe(true);
    // Fee is edited in major units (dollars), not minor (cents).
    expect(propsOf(findField(tree, "fee_cents")!).value).toBe(15);
  });

  it("threads form_fields to the ported FormBuilder unchanged", async () => {
    const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    const builder = island.tree().find((e) => e.type === FormBuilder);
    expect(builder).toBeTruthy();
    expect(propsOf(builder!).fields).toEqual(FORM_FIELDS);
  });
});

describe("RegistrationHubConfigPanel — read-only currency, no currency input anywhere", () => {
  it("shows the org currency code but no editable currency control", async () => {
    const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    const tree = island.tree();
    expect(textOf(tree).toUpperCase()).toContain("USD");
    expect(findField(tree, "currency")).toBeUndefined();
    const currencyInputs = tree.filter(
      (e) => (e.type === "input" || e.type === "select") && propsOf(e)["aria-label"]?.toString().toLowerCase().includes("currency"),
    );
    expect(currencyInputs).toHaveLength(0);
  });
});

describe("RegistrationHubConfigPanel — platform fee percent surfaced", () => {
  it("shows the org's fee_percent entitlement near the fee input", async () => {
    const island = renderIsland(RegistrationHubConfigPanel, { ...BASE_PROPS, feePercentPct: 8 }, expandPanel);
    await flush();
    expect(textOf(island.tree())).toContain("8%");
  });
});

describe("RegistrationHubConfigPanel — card-unsupported currency", () => {
  it("renders the unsupported-currency message and disables the card payment option", async () => {
    const island = renderIsland(
      RegistrationHubConfigPanel,
      { ...BASE_PROPS, cardUnsupportedCurrency: "jpy" },
      expandPanel,
    );
    await flush();
    const tree = island.tree();
    expect(textOf(tree).toUpperCase()).toContain("JPY");
    const stripeRadio = tree.find(
      (e) => e.type === "input" && propsOf(e).type === "radio" && propsOf(e).value === "stripe",
    );
    expect(stripeRadio).toBeTruthy();
    expect(propsOf(stripeRadio!).disabled).toBe(true);
  });
});

describe("RegistrationHubConfigPanel — allow_free_agents is team-only", () => {
  it("is available when entrant_kind is team", async () => {
    const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    expect(findField(island.tree(), "allow_free_agents")).toBeTruthy();
  });

  it("is unavailable for a non-team division", async () => {
    net.getResponse = { ...RESPONSE, entrant_kind: "individual", allow_free_agents: false };
    const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    expect(findField(island.tree(), "allow_free_agents")).toBeUndefined();
  });

  it("switching entrant_kind away from team clears allow_free_agents locally", async () => {
    const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    const entrantKindSelect = findField(island.tree(), "entrant_kind")!;
    (propsOf(entrantKindSelect).onChange as (e: { target: { value: string } }) => void)({
      target: { value: "individual" },
    });
    // allow_free_agents control disappears once entrant_kind is no longer team.
    expect(findField(island.tree(), "allow_free_agents")).toBeUndefined();

    // Switching back to team shows it again, now false (cleared, not stale true).
    (propsOf(findField(island.tree(), "entrant_kind")!).onChange as (e: { target: { value: string } }) => void)({
      target: { value: "team" },
    });
    expect(propsOf(findField(island.tree(), "allow_free_agents")!).checked).toBe(false);
  });
});

describe("RegistrationHubConfigPanel — save: full replace + both endpoints", () => {
  async function openAndSave(edit: (tree: ReturnType<typeof expandPanel>) => void) {
    const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    edit(island.tree());
    const saveBtn = island.tree().find((e) => e.type === "button" && propsOf(e)["data-action"] === "save")!;
    await (propsOf(saveBtn).onClick as () => Promise<void>)();
    return island;
  }

  it("editing only the fee still sends every other registration-settings field unchanged (full-replace hazard)", async () => {
    await openAndSave((tree) => {
      const feeInput = findField(tree, "fee_cents")!;
      (propsOf(feeInput).onChange as (e: { target: { value: string } }) => void)({ target: { value: "25" } });
    });
    const put = net.calls.find((c) => c.method === "PUT")!;
    const body = put.json as Record<string, unknown>;
    expect(body.fee_cents).toBe(2500);
    expect(body.form_fields).toEqual(FORM_FIELDS);
    expect(body.approval).toBe("manual");
    expect(body.allow_free_agents).toBe(true);
    expect(body.entrant_kind).toBe("team");
    expect(body.capacity).toBe(32);
    expect(body.enabled).toBe(true);
    expect(body.opens_at).toBe("2026-01-01T00:00:00Z");
    expect(body.closes_at).toBe("2026-02-01T00:00:00Z");
  });

  it("sends the division PATCH with category/age_min/age_max", async () => {
    await openAndSave(() => {});
    const patch = net.calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toBe("/api/v1/divisions/div-1");
    expect(patch.json).toEqual({ category: "mixed", age_min: 10, age_max: 18 });
  });

  it("calls onSaved when both requests succeed", async () => {
    const onSaved = vi.fn();
    const island = renderIsland(RegistrationHubConfigPanel, { ...BASE_PROPS, onSaved }, expandPanel);
    await flush();
    const saveBtn = island.tree().find((e) => e.type === "button" && propsOf(e)["data-action"] === "save")!;
    await (propsOf(saveBtn).onClick as () => Promise<void>)();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});

describe("RegistrationHubConfigPanel — 422s render against the offending field", () => {
  it("a PUT-side error (fee below Stripe minimum) renders under the fee field, not a generic toast", async () => {
    net.putRejection = new ApiV1Error("Card entry fees must be at least 1.00 (or 0 for free)", 422, "ERROR");
    const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    const saveBtn = island.tree().find((e) => e.type === "button" && propsOf(e)["data-action"] === "save")!;
    await (propsOf(saveBtn).onClick as () => Promise<void>)();
    const tree = island.tree();
    const errorEl = tree.find((e) => propsOf(e)["data-field-error"] === "fee_cents");
    expect(errorEl).toBeTruthy();
    expect(textOf(errorEl!)).toContain("Card entry fees must be at least");
  });

  it("a PATCH-side error (age band, one side only) renders under age_max", async () => {
    net.patchRejection = new ApiV1Error("age_max must be greater than or equal to age_min.", 422, "ERROR");
    const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    const saveBtn = island.tree().find((e) => e.type === "button" && propsOf(e)["data-action"] === "save")!;
    await (propsOf(saveBtn).onClick as () => Promise<void>)();
    const tree = island.tree();
    const errorEl = tree.find((e) => propsOf(e)["data-field-error"] === "age_max");
    expect(errorEl).toBeTruthy();
  });

  it("does NOT call onSaved when a save fails", async () => {
    net.putRejection = new ApiV1Error("closes_at must be after opens_at", 422, "ERROR");
    const onSaved = vi.fn();
    const island = renderIsland(RegistrationHubConfigPanel, { ...BASE_PROPS, onSaved }, expandPanel);
    await flush();
    const saveBtn = island.tree().find((e) => e.type === "button" && propsOf(e)["data-action"] === "save")!;
    await (propsOf(saveBtn).onClick as () => Promise<void>)();
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe("RegistrationHubConfigPanel — cancel", () => {
  it("closes without writing anything", async () => {
    const onClose = vi.fn();
    const island = renderIsland(RegistrationHubConfigPanel, { ...BASE_PROPS, onClose }, expandPanel);
    await flush();
    const cancelBtn = island.tree().find((e) => e.type === "button" && propsOf(e)["data-action"] === "cancel")!;
    (propsOf(cancelBtn).onClick as () => void)();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(net.calls.some((c) => c.method === "PATCH" || c.method === "PUT")).toBe(false);
  });
});
