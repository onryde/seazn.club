// RS004 W3c/W4 — the row-click config panel: accordion sections
// (Eligibility/Open & close/Capacity default open, Money/sign-up form
// default collapsed), built on the shared <Modal> primitive and the
// useRegistrationConfigPanelState hook for fetch/patch/save.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { Modal } from "@/components/modal";
import { DateTimeField } from "@/components/v2/shared/datetime-field";
import { instantToOrgTzInputValue } from "@/components/registration-hub-tz-input";
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
    // "15.00", not the number 15: finding 3 made this a text/decimal draft
    // (feeDisplay), formatted from fee_cents whenever there's no in-progress
    // edit — see the "decimal entry fees (finding 3)" describe block below.
    expect(propsOf(findField(tree, "fee_cents")!).value).toBe("15.00");
  });

  it("threads form_fields to the ported FormBuilder unchanged", async () => {
    const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    const builder = island.tree().find((e) => e.type === FormBuilder);
    expect(builder).toBeTruthy();
    expect(propsOf(builder!).fields).toEqual(FORM_FIELDS);
  });
});

// Finding 3: the fee input was `type="number"`, whose `value` coerces to
// `""` on an intermediate string a real number can't parse yet (e.g.
// "12."), and the old onChange mapped that "" straight to fee_cents: 0 —
// so React wrote 0 back into the box mid-keystroke and a decimal fee was
// effectively unenterable. Ported the pre-deletion component's fix
// (`git show 850cc6308^:apps/web/src/components/v2/registration-settings.tsx`,
// :204-221): a text input with a separate draft string, normalised on
// blur. RESPONSE.fee_cents is 1500 ($15.00), so every test here starts
// from a "15.00" display.
describe("RegistrationHubConfigPanel — decimal entry fees (finding 3)", () => {
  async function openPanel() {
    const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    return island;
  }
  // Typed off `openPanel`, not `ReturnType<typeof renderIsland>`: renderIsland
  // is generic, so ReturnType resolves its props parameter to `unknown` and the
  // concrete island is then not assignable to it (a function parameter is
  // contravariant — `(p: unknown) => void` does not accept `(p: Props) => void`).
  // vitest never typechecks, so this only surfaces in `turbo typecheck`.
  function fire(
    island: Awaited<ReturnType<typeof openPanel>>,
    handler: "onChange" | "onBlur",
    value?: string,
  ) {
    const feeInput = findField(island.tree(), "fee_cents")!;
    if (handler === "onChange") {
      (propsOf(feeInput).onChange as (e: { target: { value: string } }) => void)({ target: { value: value! } });
    } else {
      (propsOf(feeInput).onBlur as () => void)();
    }
  }

  it("typing '12.50' yields fee_cents: 1250", async () => {
    const island = await openPanel();
    fire(island, "onChange", "12.50");
    const saveBtn = island.tree().find((e) => e.type === "button" && propsOf(e)["data-action"] === "save")!;
    await (propsOf(saveBtn).onClick as () => Promise<void>)();
    const put = net.calls.find((c) => c.method === "PUT")!;
    expect((put.json as Record<string, unknown>).fee_cents).toBe(1250);
  });

  it("an intermediate '12.' does not clobber the draft", async () => {
    const island = await openPanel();
    fire(island, "onChange", "12.");
    expect(propsOf(findField(island.tree(), "fee_cents")!).value).toBe("12.");
  });

  it("blur normalises the draft to two decimals", async () => {
    const island = await openPanel();
    fire(island, "onChange", "12.5");
    fire(island, "onBlur");
    expect(propsOf(findField(island.tree(), "fee_cents")!).value).toBe("12.50");
  });

  it("'0' means free", async () => {
    const island = await openPanel();
    fire(island, "onChange", "0");
    const saveBtn = island.tree().find((e) => e.type === "button" && propsOf(e)["data-action"] === "save")!;
    await (propsOf(saveBtn).onClick as () => Promise<void>)();
    const put = net.calls.find((c) => c.method === "PUT")!;
    expect((put.json as Record<string, unknown>).fee_cents).toBe(0);
  });

  it("a non-numeric entry does not produce NaN and leaves fee_cents unchanged", async () => {
    const island = await openPanel();
    fire(island, "onChange", "abc");
    expect(propsOf(findField(island.tree(), "fee_cents")!).value).not.toContain("NaN");
    const saveBtn = island.tree().find((e) => e.type === "button" && propsOf(e)["data-action"] === "save")!;
    await (propsOf(saveBtn).onClick as () => Promise<void>)();
    const put = net.calls.find((c) => c.method === "PUT")!;
    expect((put.json as Record<string, unknown>).fee_cents).toBe(1500);
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
          feeText: null,
          onFeeText: vi.fn(),
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

// "Free agents" is club-sport jargon — a padel club's Tuesday-night organiser
// is not obliged to know that it means an unsigned player. Renamed to "solo
// sign-ups" (owner call, 2026-08-25); `allow_free_agents` stays the column,
// the API field and the data-field hook, so only the words move.
//
// The toggle and the row chip now read differently ("Allow solo sign-ups" vs
// "Solo sign-ups"), which is why the panel stopped borrowing the row's key.
// Pinned at SOURCE level for the same reason as the block above.
describe("RegistrationHubConfigPanel — the solo sign-ups toggle", () => {
  const source = readFileSync(
    new URL("../registration-hub-config-panel.tsx", import.meta.url),
    "utf8",
  );

  it("labels the toggle with its own key, not the row chip's", () => {
    expect(source).toContain('msg("reg.hub.config.allowSolo")');
    expect(source).not.toContain('msg("reg.hub.row.freeAgents")');
  });

  it("reads as an instruction on the toggle and as a state on the chip", () => {
    const toggle = t(uiEn, "reg.hub.config.allowSolo");
    const chip = t(uiEn, "reg.hub.row.freeAgents");
    expect(toggle).not.toBe(chip);
    // Both carry the same phrase, so the chip is recognisable as the thing the
    // toggle switched on.
    expect(toggle.toLowerCase()).toContain(chip.toLowerCase());
    // …and the jargon is gone from both.
    expect(`${toggle} ${chip}`.toLowerCase()).not.toContain("free agent");
  });
});

// Review finding, 2026-08-25: `refund_lock_at`'s field had NO automated
// verification of any kind — the e2e opens the Money section (so the element
// mounts) but never fills or asserts it, and no unit test touched those lines,
// unlike its opens_at/closes_at siblings. A silent wiring slip there — the
// wrong `value`, a missing `dataField`, the cutoff option dropped — would have
// shipped.
//
// Asserted at the PROPS the panel hands DateTimeField, not at rendered markup:
// the harness never invokes function components (it has no jsdom), so the
// element is exactly what this file can see, and it is also the whole contract
// the panel owns. What DateTimeField then does with those props is that
// component's own suite.
describe("RegistrationHubConfigPanel — the three clock fields", () => {
  async function clockFields() {
    const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    // Deduped by hook: `expandPanel` re-scans its own growing output, so a
    // section reached through the Disclosure wrapper is expanded more than
    // once and the same element surfaces repeatedly. What matters here is
    // WHICH fields exist and what they were handed, not how many times the
    // harness walked past them.
    const byField = new Map<string, Record<string, unknown>>();
    for (const el of island.tree()) {
      if (el.type !== DateTimeField) continue;
      const props = propsOf(el);
      byField.set(String(props.dataField), props);
    }
    return [...byField.values()];
  }

  it("routes all three through the shared field, each with its own hook", async () => {
    const fields = await clockFields();
    expect(fields.map((f) => f.dataField)).toEqual([
      "opens_at",
      "closes_at",
      "refund_lock_at",
    ]);
    // Every one is the composite, never a bare date or time half.
    expect(fields.every((f) => f.kind === "datetime-local")).toBe(true);
  });

  it("gives the two CUTOFFS the 23:59 option and the opening none", async () => {
    const fields = await clockFields();
    const byField = Object.fromEntries(fields.map((f) => [f.dataField as string, f]));
    // The quarter-hour grid stops at 23:45. A deadline there shuts the door
    // fifteen minutes early; an OPENING at 23:45 is just an opening.
    expect(byField.closes_at!.extraOptions).toEqual(["23:59"]);
    expect(byField.refund_lock_at!.extraOptions).toEqual(["23:59"]);
    expect(byField.opens_at!.extraOptions).toBeUndefined();
  });

  it("hands each one the value from state, converted into the ORG timezone", async () => {
    const fields = await clockFields();
    const byField = Object.fromEntries(fields.map((f) => [f.dataField as string, f]));
    // RESPONSE holds 2026-01-01T00:00:00Z / 2026-02-01T00:00:00Z and a null
    // refund lock. BASE_PROPS' org timezone is what decides the wall clock —
    // a regression to browser-local would move these by the runner's offset.
    expect(byField.opens_at!.value).toBe(
      instantToOrgTzInputValue(RESPONSE.opens_at, BASE_PROPS.orgTz),
    );
    expect(byField.closes_at!.value).toBe(
      instantToOrgTzInputValue(RESPONSE.closes_at, BASE_PROPS.orgTz),
    );
    // A null instant is an EMPTY field, never the epoch.
    expect(byField.refund_lock_at!.value).toBe("");
  });

  it("labels each one with the zone, so a time is never bare wall-clock", async () => {
    const fields = await clockFields();
    for (const f of fields) expect(String(f.label)).toMatch(/\(.+\)$/);
  });
});
