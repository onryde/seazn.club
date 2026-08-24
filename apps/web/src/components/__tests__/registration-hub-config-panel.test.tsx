// RS004 W3c/W4 — the row-click config panel: accordion sections
// (Eligibility/Open & close/Capacity default open, Money/sign-up form
// default collapsed), built on the shared <Modal> primitive and the
// useRegistrationConfigPanelState hook for fetch/patch/save.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { Modal } from "@/components/modal";
import { FormBuilder, type FormField } from "@/components/registration-hub-form-builder";
import type { RegistrationConfigState, RegistrationSettingsResponse } from "@/components/registration-hub-config-state";
import { ROUTABLE_FIELDS, type ConfigFieldKey } from "@/components/registration-hub-save-error";
import {
  RegistrationHubConfigPanel,
  Disclosure,
  EligibilitySection,
  OpenCloseSection,
  CapacitySection,
  MoneySection,
  FormSection,
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

type SectionType = (props: Record<string, unknown>) => ReactNode;
// Disclosure wraps a Section (EligibilitySection etc.) as ITS OWN children
// prop — walk() finds the Disclosure element (opaque, un-invoked) and, one
// level down inside it, the Section element (also opaque, un-invoked) as
// the value of Disclosure's OWN `children`. Both need manual invocation,
// and the loop below (deepExpand) re-scans its own growing output so
// expanding a Disclosure surfaces its nested Section, which then also gets
// expanded in the same pass.
const OPAQUE_TYPES: SectionType[] = [
  Disclosure as unknown as SectionType,
  EligibilitySection as SectionType,
  OpenCloseSection as SectionType,
  CapacitySection as SectionType,
  MoneySection as SectionType,
  FormSection as SectionType,
];

const FORM_FIELDS: FormField[] = [
  { key: "shirt_size", label: "Shirt size", kind: "text", required: true },
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

// Finding 1 fixtures — a real dictionary lookup (never a stub returning the
// key back) so a section that forgot to route `msg` through at all still
// reads as a real render, not a false pass.
const testMsg = (key: string, vars?: Record<string, string | number>) => t(uiEn, key, vars);

const FULL_STATE: RegistrationConfigState = {
  category: "mixed",
  age_min: 10,
  age_max: 18,
  enabled: true,
  entrant_kind: "team",
  opens_at: "2026-01-01T00:00:00Z",
  closes_at: "2026-02-01T00:00:00Z",
  capacity: 32,
  fee_cents: 1500,
  refund_lock_at: null,
  form_fields: FORM_FIELDS,
  payment_method: "offline",
  payment_instructions: null,
  approval: "manual",
  allow_free_agents: true,
};

/** Every field mapSaveError can name, each carrying a distinct message —
 *  built from ROUTABLE_FIELDS (not hand-copied) so a future field added to
 *  that array is exercised here automatically. */
const ALL_ROUTED_ERRORS: Partial<Record<ConfigFieldKey, string>> = Object.fromEntries(
  ROUTABLE_FIELDS.map((f) => [f, `boom: ${f}`]),
);

function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

// walk() doesn't invoke opaque child components (Modal's children/footer,
// the exported Section functions), so they're expanded manually. <details>/
// <summary> need NO special handling — they're plain host element types
// walk() already descends into.
function deepExpand(node: ReactNode): ReturnType<typeof walk> {
  const out = walk(node);
  // A plain `for` loop, not `for...of` over a snapshot: `out.length` is
  // re-read every iteration, so an element pushed by expanding a
  // Disclosure (its nested Section) is itself visited later in the SAME
  // pass and expanded too — no recursion needed for two levels of opaque
  // nesting.
  for (let i = 0; i < out.length; i++) {
    const el = out[i]!;
    if (OPAQUE_TYPES.includes(el.type as SectionType)) {
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
    out.push(...deepExpand(p.children as ReactNode));
    if (p.footer) out.push(...walk(p.footer as ReactNode));
  }
  return out;
}

function findField(tree: ReturnType<typeof expandPanel>, field: string) {
  return tree.find((e) => propsOf(e)["data-field"] === field);
}

function accordionSection(tree: ReturnType<typeof expandPanel>, id: string) {
  return tree.find((e) => propsOf(e)["data-accordion-section"] === id);
}

beforeEach(() => {
  net.calls = [];
  net.getResponse = { ...RESPONSE };
  net.patchRejection = null;
  net.putRejection = null;
});

describe("RegistrationHubConfigPanel — built on Modal (keeps the focus trap)", () => {
  it("renders through the shared <Modal> primitive with the right title/footer contract", async () => {
    const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    const modal = island.tree().find((e) => e.type === Modal)!;
    expect(modal).toBeTruthy();
    expect(propsOf(modal).title).toBe(t(uiEn, "reg.hub.config.title", { name: "Open Singles" }));
  });
});

describe("RegistrationHubConfigPanel — loading and data wiring", () => {
  it("shows a loading state before the GET resolves, then the form after", async () => {
    const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    expect(island.text()).toContain("Loading");
    await flush();
    expect(findField(island.tree(), "fee_cents")).toBeTruthy();
  });

  it("fetches the full settings for THIS division on mount", async () => {
    renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    const get = net.calls.find((c) => c.method === "GET");
    expect(get?.url).toBe("/api/v1/divisions/div-1/registration-settings");
  });

  it("renders category/age/approval/allow_free_agents and fee/capacity from the row + GET response", async () => {
    const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    const tree = island.tree();
    expect(propsOf(findField(tree, "category")!).value).toBe("mixed");
    expect(propsOf(findField(tree, "approval")!).value).toBe("manual");
    expect(propsOf(findField(tree, "capacity")!).value).toBe(32);
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

describe("RegistrationHubConfigPanel — accordion: which sections default open vs collapsed", () => {
  it("Eligibility, Open & close and Capacity are open by default", async () => {
    const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    const tree = island.tree();
    expect(propsOf(accordionSection(tree, "eligibility")!).open).toBe(true);
    expect(propsOf(accordionSection(tree, "schedule")!).open).toBe(true);
    expect(propsOf(accordionSection(tree, "capacity")!).open).toBe(true);
  });

  it("Money and the sign-up form are COLLAPSED by default — the progressive-disclosure claim", async () => {
    const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    const tree = island.tree();
    expect(propsOf(accordionSection(tree, "money")!).open).toBe(false);
    expect(propsOf(accordionSection(tree, "form")!).open).toBe(false);
  });

  // The event this hands the handler carries `target`, like the native
  // `toggle` event does — NOT `currentTarget`. A hand-rolled
  // `{ currentTarget: { open } }` shape once let a real crash through: the
  // native `toggle` event fires synchronously while React is still
  // committing the sections that mount open, and `currentTarget` is only
  // bound during dispatch, so a handler reading it off `currentTarget` read
  // `.open` off null on the FIRST open of every division.
  it("clicking a collapsed section's summary opens it", async () => {
    const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    const money = accordionSection(island.tree(), "money")!;
    (propsOf(money).onToggle as (e: { target: { open: boolean } }) => void)({
      target: { open: true },
    });
    expect(propsOf(accordionSection(island.tree(), "money")!).open).toBe(true);
  });

  // Guards the crash itself: a `toggle` whose currentTarget has already been
  // unbound (null) must still resolve the section's state from `target`.
  it("survives a toggle event whose currentTarget is already null", async () => {
    const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    const money = accordionSection(island.tree(), "money")!;
    const fire = propsOf(money).onToggle as (e: unknown) => void;
    expect(() => fire({ target: { open: true }, currentTarget: null })).not.toThrow();
    expect(propsOf(accordionSection(island.tree(), "money")!).open).toBe(true);
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

  it("editing only the fee still sends every other field unchanged (full-replace hazard)", async () => {
    await openAndSave((tree) => {
      const feeInput = findField(tree, "fee_cents")!;
      (propsOf(feeInput).onChange as (e: { target: { value: string } }) => void)({ target: { value: "25" } });
    });
    const put = net.calls.find((c) => c.method === "PUT")!;
    const body = put.json as Record<string, unknown>;
    expect(body.fee_cents).toBe(2500);
    expect(body.approval).toBe("manual");
    expect(body.entrant_kind).toBe("team");
    expect(body.capacity).toBe(32);
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

// Finding 1: mapSaveError can name any of ROUTABLE_FIELDS, but four of them
// — form_fields, opens_at, enabled, entrant_kind — had no data-field-error
// render site anywhere in the panel. saveAndReveal still opened the right
// accordion section (SECTION_FIELDS covers all 15), so the organiser saw a
// section quietly expand with nothing inside — the save's error message
// routed into a void. This walks every section directly (bypassing the
// network-driven save flow, which never produces more than two field
// errors at once) with EVERY routable field carrying an error simultaneously,
// and asserts each one lands SOMEWHERE with a `data-field-error` — so a
// future field added to ROUTABLE_FIELDS without a render site reds here
// immediately, rather than shipping a silent repeat of this gap.
describe("RegistrationHubConfigPanel — every routable field has a render site (finding 1)", () => {
  it("mapSaveError's full set of routable fields is rendered, never routed into a void", () => {
    const commonProps = { state: FULL_STATE, errors: ALL_ROUTED_ERRORS, patch: vi.fn(), msg: testMsg };
    const rendered = [
      ...walk(EligibilitySection(commonProps)),
      ...walk(OpenCloseSection({ ...commonProps, orgTz: "UTC" })),
      ...walk(CapacitySection(commonProps)),
      ...walk(
        MoneySection({
          ...commonProps,
          orgTz: "UTC",
          orgSlug: "riverside",
          currency: "usd" as const,
          feePercentPct: 8,
          cardUnsupportedCurrency: null,
          chargesEnabled: true,
          orgPaymentInstructions: null,
        }),
      ),
      ...walk(FormSection(commonProps)),
    ];
    for (const field of ROUTABLE_FIELDS) {
      const el = rendered.find((e) => propsOf(e)["data-field-error"] === field);
      expect(el, `expected a data-field-error render site for "${field}"`).toBeTruthy();
    }
  });
});

describe("RegistrationHubConfigPanel — a field error inside a COLLAPSED section reveals itself", () => {
  it("a PUT-side error (fee) auto-opens the collapsed Money section instead of hiding invisibly", async () => {
    net.putRejection = new ApiV1Error("Card entry fees must be at least 1.00 (or 0 for free)", 422, "ERROR");
    const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    // Confirm the premise: Money starts collapsed.
    expect(propsOf(accordionSection(island.tree(), "money")!).open).toBe(false);

    const saveBtn = island.tree().find((e) => e.type === "button" && propsOf(e)["data-action"] === "save")!;
    await (propsOf(saveBtn).onClick as () => Promise<void>)();

    const tree = island.tree();
    const errorEl = tree.find((e) => propsOf(e)["data-field-error"] === "fee_cents");
    expect(errorEl).toBeTruthy();
    // The claim under test: Money is no longer collapsed once it holds a
    // live error — without this, the error above is real markup but sits
    // inside a closed <details>, invisible to the organiser.
    expect(propsOf(accordionSection(tree, "money")!).open).toBe(true);
  });

  it("does NOT force-open a section that has no error (Eligibility error only touches Eligibility)", async () => {
    net.patchRejection = new ApiV1Error("age_max must be greater than or equal to age_min.", 422, "ERROR");
    const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    const saveBtn = island.tree().find((e) => e.type === "button" && propsOf(e)["data-action"] === "save")!;
    await (propsOf(saveBtn).onClick as () => Promise<void>)();
    const tree = island.tree();
    expect(tree.find((e) => propsOf(e)["data-field-error"] === "age_max")).toBeTruthy();
    expect(propsOf(accordionSection(tree, "money")!).open).toBe(false);
    expect(propsOf(accordionSection(tree, "form")!).open).toBe(false);
  });
});

describe("RegistrationHubConfigPanel — save outcome (finding 1)", () => {
  it("both endpoints succeed: outcome is 'success', onSaved fires", async () => {
    const onSaved = vi.fn();
    const island = renderIsland(RegistrationHubConfigPanel, { ...BASE_PROPS, onSaved }, expandPanel);
    await flush();
    const saveBtn = island.tree().find((e) => e.type === "button" && propsOf(e)["data-action"] === "save")!;
    await (propsOf(saveBtn).onClick as () => Promise<void>)();
    const tree = island.tree();
    const root = tree.find((e) => propsOf(e)["data-registration-hub-config-panel"] !== undefined)!;
    expect(propsOf(root)["data-save-outcome"]).toBe("success");
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("PATCH ok, PUT fails: outcome is 'put-failed', a banner says category/age landed", async () => {
    net.putRejection = new ApiV1Error("closes_at must be after opens_at", 422, "ERROR");
    const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    const saveBtn = island.tree().find((e) => e.type === "button" && propsOf(e)["data-action"] === "save")!;
    await (propsOf(saveBtn).onClick as () => Promise<void>)();
    const tree = island.tree();
    const root = tree.find((e) => propsOf(e)["data-registration-hub-config-panel"] !== undefined)!;
    expect(propsOf(root)["data-save-outcome"]).toBe("put-failed");
    const banner = tree.find((e) => e.type === "p" && propsOf(e)["data-save-outcome"] === "put-failed");
    expect(banner).toBeTruthy();
    expect(textOf(banner!)).toContain(t(uiEn, "reg.hub.config.partialSavePatchOk"));
  });

  it("PATCH fails, PUT ok: outcome is 'patch-failed', a banner says settings landed", async () => {
    net.patchRejection = new ApiV1Error("age_max must be greater than or equal to age_min.", 422, "ERROR");
    const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    const saveBtn = island.tree().find((e) => e.type === "button" && propsOf(e)["data-action"] === "save")!;
    await (propsOf(saveBtn).onClick as () => Promise<void>)();
    const tree = island.tree();
    const root = tree.find((e) => propsOf(e)["data-registration-hub-config-panel"] !== undefined)!;
    expect(propsOf(root)["data-save-outcome"]).toBe("patch-failed");
    const banner = tree.find((e) => e.type === "p" && propsOf(e)["data-save-outcome"] === "patch-failed");
    expect(banner).toBeTruthy();
    expect(textOf(banner!)).toContain(t(uiEn, "reg.hub.config.partialSavePutOk"));
  });

  it("both fail: outcome is 'both-failed'", async () => {
    net.patchRejection = new ApiV1Error("age_max must be greater than or equal to age_min.", 422, "ERROR");
    net.putRejection = new ApiV1Error("closes_at must be after opens_at", 422, "ERROR");
    const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    const saveBtn = island.tree().find((e) => e.type === "button" && propsOf(e)["data-action"] === "save")!;
    await (propsOf(saveBtn).onClick as () => Promise<void>)();
    const tree = island.tree();
    const root = tree.find((e) => propsOf(e)["data-registration-hub-config-panel"] !== undefined)!;
    expect(propsOf(root)["data-save-outcome"]).toBe("both-failed");
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

// A section is named by its disclosure summary and nowhere else. Each section
// component used to repeat that name as its own <h3>, so the panel printed e.g.
// "Eligibility" twice, one line apart — visible in the RS004 sign-off
// screenshots and asserted by nothing, which is why it survived to a screenshot.
//
// Pinned at SOURCE level, like modal.test.ts does: this workspace has no jsdom,
// and the rendered-tree route cannot count this — walk() returns nested
// elements, so an ancestor and its descendant both carry the same text and a
// naive occurrence count measures nesting depth, not duplication.
describe("RegistrationHubConfigPanel — a section is named once", () => {
  const source = readFileSync(
    new URL("../registration-hub-config-panel.tsx", import.meta.url),
    "utf8",
  );
  const SECTION_KEYS = [
    "reg.hub.config.eligibility",
    "reg.settings.openClose",
    "reg.settings.capacity",
    "reg.settings.money",
  ];

  it.each(SECTION_KEYS)("does not re-print %s as a section heading", (key) => {
    // `sectionTitle` is the one place a section is named; a heading element
    // rendering the same key is the duplication this guards.
    expect(source).not.toMatch(new RegExp(`<h[1-6][^>]*>\\{msg\\("${key.replace(/\./g, "\\.")}"\\)\\}</h[1-6]>`));
  });

  it("names every section through sectionTitle", () => {
    for (const key of SECTION_KEYS) {
      expect(source).toContain(`msg("${key}")`);
    }
  });
});
