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
import { orgTzDateTimeHalves, orgTzInputValueToInstant } from "@/components/registration-hub-tz-input";
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
  OrgTzDateTimePair,
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
  // RS005 R4 task 2 — OrgTzDateTimePair renders TWO DateTimeField elements
  // (kind="date"/"time") as its children; without expanding it here,
  // deepExpand never sees them (same opacity every other Section-shaped
  // helper in this file has).
  OrgTzDateTimePair as unknown as SectionType,
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
  free_agent_fee_cents: null,
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

const DIVISION = {
  division_id: "div-1",
  name: "Open Singles",
  category: "mixed" as const,
  age_min: 10,
  age_max: 18,
  // RS007/V380 — non-null on purpose (not the vacuous null default every
  // OTHER field here already avoids): a fixture where these read back as
  // null would pass even if the render/patch wiring silently dropped them.
  age_cutoff_month: 9,
  age_cutoff_day: 1,
  eligibility_note: "School-registered students only",
};

const BASE_PROPS = {
  division: DIVISION,
  orgTz: "UTC",
  orgSlug: "riverside",
  currency: "usd" as const,
  feePercentPct: 8,
  cardUnsupportedCurrency: null,
  // RS005 F4 — baseline "no one waiting" case, matching every OTHER fixture
  // in this file that predates the re-price warning and asserts nothing
  // about it.
  waitlistedCount: 0,
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
  age_cutoff_month: 9,
  age_cutoff_day: 1,
  eligibility_note: "School-registered students only",
  enabled: true,
  entrant_kind: "team",
  opens_at: "2026-01-01T00:00:00Z",
  closes_at: "2026-02-01T00:00:00Z",
  capacity: 32,
  fee_cents: 1500,
  free_agent_fee_cents: null,
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

/** Text of the DEEPLY expanded panel. `island.text()` only sees what the
 *  shallow render produced, and both the fee copy and the solo-signups toggle
 *  live inside sections the design collapses by default — the same place
 *  RS004's "Bench takes 2%" copy for a nonexistent product hid until someone
 *  screenshotted an opened section. */
function expandedText(tree: ReturnType<typeof expandPanel>): string {
  const parts: string[] = [];
  for (const el of tree) {
    const kids = propsOf(el).children;
    for (const k of Array.isArray(kids) ? kids : [kids]) {
      if (typeof k === "string" || typeof k === "number") parts.push(String(k));
    }
  }
  return parts.join(" ");
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

  // RS007/V380 — the cutoff + note fields the config panel gained alongside
  // its pre-existing category/age_min/age_max. Sourced from the DIVISION row
  // (not the GET response — same "GET has no such columns" reasoning
  // registration-hub-config-state.ts's own DivisionEligibility documents).
  it("renders age_cutoff_month/age_cutoff_day/eligibility_note from the row", async () => {
    const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    const tree = island.tree();
    expect(propsOf(findField(tree, "age_cutoff_month")!).value).toBe(9);
    expect(propsOf(findField(tree, "age_cutoff_day")!).value).toBe(1);
    expect(propsOf(findField(tree, "eligibility_note")!).value).toBe("School-registered students only");
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

  it("sends the division PATCH with category/age_min/age_max/age_cutoff_month/age_cutoff_day/eligibility_note", async () => {
    await openAndSave(() => {});
    const patch = net.calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toBe("/api/v1/divisions/div-1");
    expect(patch.json).toEqual({
      category: "mixed",
      age_min: 10,
      age_max: 18,
      age_cutoff_month: 9,
      age_cutoff_day: 1,
      eligibility_note: "School-registered students only",
    });
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
    const commonProps = { state: FULL_STATE, errors: ALL_ROUTED_ERRORS, patch: vi.fn(), msg: testMsg, locale: "en" };
    // RS005 R4 task 2 — OpenCloseSection/MoneySection now also take dtDrafts/
    // onDateTimeHalfChange (the lifted date/time-halves state). Empty here:
    // this test only proves every data-field-error PARAGRAPH has a render
    // site, which OrgTzDateTimePair's own presence doesn't affect (the
    // paragraphs are its SIBLINGS, not its children).
    const dtProps = { dtDrafts: {}, onDateTimeHalfChange: vi.fn() };
    const rendered = [
      ...walk(EligibilitySection(commonProps)),
      ...walk(OpenCloseSection({ ...commonProps, orgTz: "UTC", ...dtProps })),
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
          soloFeeText: null,
          onSoloFeeText: () => {},
          waitlistedCount: 0,
          ...dtProps,
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

// RS005 R5 task 1 put a "this toggle does not open registration to anyone
// yet" notice beside the open-for-public toggle, because the public sign-up
// page was hardcoded closed. RS006 (`ec5cc6e3a`) shipped that page, and the
// notice's own comment said to remove it — and its dictionary key — at
// exactly that point. Flipping this toggle now does open registration.
//
// INVERTED rather than deleted: as written these asserted the presence of
// copy that tells an organiser the toggle they just flipped does nothing.
// Probed by the `data-registration-hub-link-not-live` marker, which outlives
// the wording — the dictionary key it rendered no longer exists.
//
// Open & close defaults OPEN (this file's own header comment), so this needs
// no deepExpand — a direct OpenCloseSection call, matching the "every
// routable field" test above, is enough.
describe("RegistrationHubConfigPanel — the open-for-public toggle's not-live notice is gone (RS006 follow-up)", () => {
  const openCloseTree = (enabled: boolean) =>
    walk(
      OpenCloseSection({
        state: { ...FULL_STATE, enabled },
        errors: {},
        patch: vi.fn(),
        msg: testMsg,
        orgTz: "UTC",
        dtDrafts: {},
        onDateTimeHalfChange: vi.fn(),
      }),
    );

  it("renders no not-live notice beside the toggle when registration is ON", () => {
    const tree = openCloseTree(true);
    expect(tree.filter((e) => propsOf(e)["data-registration-hub-link-not-live"] !== undefined)).toHaveLength(0);
  });

  it("renders no not-live notice when the toggle is OFF either", () => {
    const tree = openCloseTree(false);
    expect(tree.filter((e) => propsOf(e)["data-registration-hub-link-not-live"] !== undefined)).toHaveLength(0);
  });

  it("still renders the open-for-public toggle itself — the notice went, the control stayed", () => {
    const tree = openCloseTree(true);
    expect(tree.some((e) => propsOf(e)["data-field"] === "enabled")).toBe(true);
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
// RS005 R4 task 2 rewrote this block's own accessor: OrgTzDateTimePair
// replaced the single `kind="datetime-local"` DateTimeField with TWO
// DateTimeFields (kind="date"/"time", dataField suffixed `_date`/`_time`)
// so the panel can see a half-filled pair (registration-hub-tz-input.ts's
// header comment explains why DateTimeSplitField's own `joinValue` hides
// that from every caller). Same "assert the PROPS the panel hands
// DateTimeField, not rendered markup" contract as before — DateTimeField's
// OWN suite covers what it does with them.
describe("RegistrationHubConfigPanel — the three clock fields", () => {
  async function clockFields() {
    // A CARD division: the refund lock is card-only now (the auto-refund it
    // governs gates on payment_intent_id, which an offline entry never has),
    // so the default offline fixture renders two clock fields, not three.
    // Switching the fixture keeps this suite asserting what it was written to
    // assert — that all three route through the shared field — rather than
    // quietly dropping the third from its expectations.
    net.getResponse = { ...RESPONSE, fee_cents: 1500, payment_method: "stripe" };
    const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    // Deduped by hook: `expandPanel` re-scans its own growing output, so a
    // section reached through the Disclosure wrapper is expanded more than
    // once and the same element surfaces repeatedly. Keyed by the SUFFIXED
    // dataField ("opens_at_date", "opens_at_time", …) — what matters is
    // which halves exist and what they were handed, not how many times the
    // harness walked past them.
    const byField = new Map<string, Record<string, unknown>>();
    for (const el of island.tree()) {
      if (el.type !== DateTimeField) continue;
      const props = propsOf(el);
      byField.set(String(props.dataField), props);
    }
    return byField;
  }

  it("routes all three through the shared pair, each as a date half and a time half", async () => {
    const fields = await clockFields();
    expect([...fields.keys()].sort()).toEqual(
      [
        "opens_at_date",
        "opens_at_time",
        "closes_at_date",
        "closes_at_time",
        "refund_lock_at_date",
        "refund_lock_at_time",
      ].sort(),
    );
    expect(fields.get("opens_at_date")!.kind).toBe("date");
    expect(fields.get("opens_at_time")!.kind).toBe("time");
    // Never the old bare composite — that's the exact opacity this task
    // fixed (DateTimeSplitField's own joinValue hid incompleteness).
    expect([...fields.values()].every((f) => f.kind !== "datetime-local")).toBe(true);
  });

  it("gives the two CUTOFFS' time halves the 23:59 option, and the opening none", async () => {
    const fields = await clockFields();
    // The quarter-hour grid stops at 23:45. A deadline there shuts the door
    // fifteen minutes early; an OPENING at 23:45 is just an opening.
    expect(fields.get("closes_at_time")!.extraOptions).toEqual(["23:59"]);
    expect(fields.get("refund_lock_at_time")!.extraOptions).toEqual(["23:59"]);
    expect(fields.get("opens_at_time")!.extraOptions).toBeUndefined();
    // extraOptions is a TIME-half concept only — never on the date input.
    expect(fields.get("closes_at_date")!.extraOptions).toBeUndefined();
  });

  it("hands each half the value from state, split in the ORG timezone", async () => {
    const fields = await clockFields();
    // RESPONSE holds 2026-01-01T00:00:00Z / 2026-02-01T00:00:00Z and a null
    // refund lock. BASE_PROPS' org timezone is what decides the wall clock —
    // a regression to browser-local would move these by the runner's offset.
    const opens = orgTzDateTimeHalves(RESPONSE.opens_at, BASE_PROPS.orgTz);
    const closes = orgTzDateTimeHalves(RESPONSE.closes_at, BASE_PROPS.orgTz);
    expect(fields.get("opens_at_date")!.value).toBe(opens.date);
    expect(fields.get("opens_at_time")!.value).toBe(opens.time);
    expect(fields.get("closes_at_date")!.value).toBe(closes.date);
    expect(fields.get("closes_at_time")!.value).toBe(closes.time);
    // A null instant is TWO empty halves, never an epoch date with a blank
    // time (which would itself be the half-filled bug this task fixes).
    expect(fields.get("refund_lock_at_date")!.value).toBe("");
    expect(fields.get("refund_lock_at_time")!.value).toBe("");
  });

  it("labels each pair with the zone, so a time is never bare wall-clock", async () => {
    const fields = await clockFields();
    for (const key of ["opens_at_date", "opens_at_time", "closes_at_date", "closes_at_time"]) {
      expect(String(fields.get(key)!.label)).toMatch(/\(.+\)$/);
    }
  });

  it("hides the time half's label visually and gives it its own distinct accessible name", async () => {
    const fields = await clockFields();
    expect(fields.get("opens_at_time")!.labelHidden).toBe(true);
    expect(fields.get("opens_at_date")!.labelHidden).toBeFalsy();
    expect(fields.get("opens_at_time")!.selectAriaLabel).toBe(t(uiEn, "datetime.timeLabel"));
  });
});

describe("RegistrationHubConfigPanel — the panel does not make claims that are false for this division", () => {
  // The platform cut is Stripe's application fee, taken as money passes
  // through. On "pay the organiser" nothing passes through us and we take
  // NOTHING — so rendering the cut unconditionally told an organiser
  // collecting cash at the door that we were taking 8% of it. A false claim
  // about someone's money is a worse defect than a missing sentence.
  it("shows the platform cut for card entries and NOT for pay-the-organiser", async () => {
    net.getResponse = { ...RESPONSE, payment_method: "stripe" };
    const onCard = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    expect(expandedText(onCard.tree())).toContain(t(uiEn, "reg.hub.config.feeCut", { keep: 92, pct: 8 }));

    net.getResponse = { ...RESPONSE, payment_method: "offline" };
    const onOffline = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    expect(
      expandedText(onOffline.tree()),
      "we take nothing when the organiser collects the money themselves",
    ).not.toContain(t(uiEn, "reg.hub.config.feeCut", { keep: 92, pct: 8 }));
  });

  // The solo-signups setting belongs to team divisions. It used to render an
  // explanation of its own absence to everyone else; a setting that is not
  // yours to make needs no apology, and the sentence answered a question a
  // Pair-division organiser never asked.
  // The auto-refund the lock governs only fires on a card entry — withdrawCore
  // gates on `locked.payment_intent_id`, which an offline entry never has. So
  // for pay-the-organiser the field asks an organiser to configure a policy
  // that cannot run.
  it("offers the refund lock for card entries and not for pay-the-organiser", async () => {
    // OrgTzDateTimePair carries `dataField` as a PROP, unsuffixed — its own
    // wrapping element is enough to prove the field exists at all (it is
    // ALSO in the tree once expanded — deepExpand pushes the opaque
    // element itself as well as what it expands to — so this doesn't even
    // need expansion). findField() (which reads the DOM `data-field`
    // attribute) never sees a component-type element like this one, same
    // reason DateTimeField itself is opaque to it.
    const hasRefundLock = (tree: ReturnType<typeof expandPanel>) =>
      tree.some((el) => el.type === OrgTzDateTimePair && propsOf(el).dataField === "refund_lock_at");

    net.getResponse = { ...RESPONSE, fee_cents: 1500, payment_method: "stripe" };
    const onCard = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    expect(hasRefundLock(onCard.tree())).toBe(true);

    net.getResponse = { ...RESPONSE, fee_cents: 1500, payment_method: "offline" };
    const onOffline = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    expect(hasRefundLock(onOffline.tree())).toBe(false);

    // And still absent on a FREE card division — the pre-existing fee gate is
    // untouched by this change.
    net.getResponse = { ...RESPONSE, fee_cents: 0, payment_method: "stripe" };
    const free = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    expect(hasRefundLock(free.tree())).toBe(false);
  });

  it("offers solo sign-ups on a team division and says nothing at all on a pair one", async () => {
    net.getResponse = { ...RESPONSE, entrant_kind: "team" };
    const team = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    expect(findField(team.tree(), "allow_free_agents")).toBeTruthy();
    expect(expandedText(team.tree())).toContain(t(uiEn, "reg.hub.config.allowSolo"));

    net.getResponse = { ...RESPONSE, entrant_kind: "pair", allow_free_agents: false };
    const pair = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    expect(findField(pair.tree(), "allow_free_agents")).toBeFalsy();
    const pairText = expandedText(pair.tree());
    expect(pairText).not.toContain(t(uiEn, "reg.hub.config.freeAgentsHint"));
    expect(pairText).not.toContain(t(uiEn, "reg.hub.config.allowSolo"));
  });
});

// ---------------------------------------------------------------------------
// RS005 F4 — editing a fee re-prices everyone still on the waitlist:
// promoteWaitlistedRow (registrations.ts, ~:875) reads the LIVE fee at
// promotion time, never what a waitlisted entrant saw when they joined
// (they hold amount_cents = 0, so there is no earlier quote to honour). The
// panel has no way to tell the organiser that except this warning, so it is
// the whole fix.
// ---------------------------------------------------------------------------
describe("RegistrationHubConfigPanel — MoneySection warns about the waitlist re-price (RS005 F4)", () => {
  // Every prop MoneySection needs BESIDES waitlistedCount — same shape the
  // "every routable field" describe block above already builds by hand for
  // the identical reason (MoneySection is invoked directly here, outside
  // React, so there is no panel/hook wiring to lean on).
  const moneyProps = {
    state: FULL_STATE,
    errors: {},
    patch: vi.fn(),
    msg: testMsg,
    orgTz: "UTC",
    orgSlug: "riverside",
    currency: "usd" as const,
    feePercentPct: 8,
    cardUnsupportedCurrency: null,
    chargesEnabled: true,
    orgPaymentInstructions: null,
    feeText: null,
    onFeeText: vi.fn(),
    soloFeeText: null,
    onSoloFeeText: () => {},
    waitlistedCount: 0,
    dtDrafts: {},
    onDateTimeHalfChange: vi.fn(),
  };

  function warningEl(tree: ReturnType<typeof walk>) {
    return tree.find((e) => propsOf(e)["data-registration-hub-waitlist-warning"] !== undefined);
  }

  it("says nothing at all when the division's waitlist is empty", () => {
    const tree = walk(MoneySection({ ...moneyProps, waitlistedCount: 0 }));
    expect(warningEl(tree)).toBeUndefined();
  });

  it("warns, in the singular, for exactly one waitlisted entry", () => {
    const tree = walk(MoneySection({ ...moneyProps, waitlistedCount: 1 }));
    const el = warningEl(tree);
    expect(el).toBeTruthy();
    expect(textOf(el!)).toBe(t(uiEn, "reg.hub.config.waitlistRepriceWarning.one", { count: 1 }));
    // The two forms must actually read differently — a shared key here would
    // pass the assertion above by coincidence.
    expect(textOf(el!)).not.toBe(t(uiEn, "reg.hub.config.waitlistRepriceWarning.other", { count: 1 }));
  });

  it("warns, in the plural, for more than one waitlisted entry", () => {
    const tree = walk(MoneySection({ ...moneyProps, waitlistedCount: 3 }));
    const el = warningEl(tree);
    expect(el).toBeTruthy();
    expect(textOf(el!)).toBe(t(uiEn, "reg.hub.config.waitlistRepriceWarning.other", { count: 3 }));
  });

  // Money defaults COLLAPSED (this file's own header comment) — proves the
  // warning actually reaches the organiser through the real panel, not just
  // through a direct MoneySection call, via the deepExpand/expandedText
  // route the panel's other collapsed-section tests already use.
  it("is present, through the real panel, once Money is expanded", async () => {
    const island = renderIsland(RegistrationHubConfigPanel, { ...BASE_PROPS, waitlistedCount: 3 }, expandPanel);
    await flush();
    const el = warningEl(island.tree());
    expect(el).toBeTruthy();
    expect(textOf(el!)).toBe(t(uiEn, "reg.hub.config.waitlistRepriceWarning.other", { count: 3 }));
  });

  it("is absent through the real panel when the division's waitlist is empty", async () => {
    const island = renderIsland(RegistrationHubConfigPanel, { ...BASE_PROPS, waitlistedCount: 0 }, expandPanel);
    await flush();
    expect(warningEl(island.tree())).toBeUndefined();
  });

  // The panel owns wiring, not copy: this pins that RegistrationHubConfigPanel
  // forwards its OWN waitlistedCount prop to MoneySection UNCHANGED, rather
  // than e.g. always passing 0 (which the two tests above could not catch —
  // BASE_PROPS's own baseline is 0).
  it("forwards its own waitlistedCount prop to MoneySection, unchanged", async () => {
    const island = renderIsland(RegistrationHubConfigPanel, { ...BASE_PROPS, waitlistedCount: 5 }, expandPanel);
    await flush();
    const money = island.tree().find((e) => e.type === MoneySection)!;
    expect(propsOf(money).waitlistedCount).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// RS005 R4 task 2 — the known defect and its fix: a date typed with no time
// (or vice versa) must be REFUSED, not silently saved as unset.
// ---------------------------------------------------------------------------

function findHalf(tree: ReturnType<typeof expandPanel>, field: string, half: "date" | "time") {
  return tree.find((e) => e.type === DateTimeField && propsOf(e).dataField === `${field}_${half}`)!;
}

async function openPanel() {
  const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
  await flush();
  return island;
}

async function clickSave(island: Awaited<ReturnType<typeof openPanel>>) {
  const saveBtn = island.tree().find((e) => e.type === "button" && propsOf(e)["data-action"] === "save")!;
  await (propsOf(saveBtn).onClick as () => Promise<void>)();
}

describe("RegistrationHubConfigPanel — an incomplete date/time is refused, never silently saved", () => {
  // opens_at/closes_at start FULLY SET in RESPONSE (both halves already
  // filled) — editing only ONE half there keeps the pair complete (the
  // OTHER half still carries its existing value), which isn't the scenario
  // this task fixes at all. Worse, it's a trap: pushing opens_at past the
  // still-unedited closes_at trips the (correct, separate) dates-order rule
  // instead, and a test that doesn't force a null starting point can pass
  // for that wrong reason — looking like it proves incompleteness-blocks-
  // save while actually proving something else. Force the field to null
  // first so editing one half is a genuine empty -> half-filled transition,
  // same as an organiser configuring the window for the first time.
  it("a date typed with the time left blank blocks the save outright — no PATCH or PUT is issued", async () => {
    net.getResponse = { ...RESPONSE, opens_at: null };
    const island = await openPanel();
    (propsOf(findHalf(island.tree(), "opens_at", "date")).onChange as (v: string) => void)("2026-08-24");
    net.calls = []; // isolate: only the save ATTEMPT itself matters from here
    await clickSave(island);
    expect(net.calls).toHaveLength(0);
  });

  it("shows a field-level error under opens_at — not a banner, not silence", async () => {
    net.getResponse = { ...RESPONSE, opens_at: null };
    const island = await openPanel();
    (propsOf(findHalf(island.tree(), "opens_at", "date")).onChange as (v: string) => void)("2026-08-24");
    await clickSave(island);
    const errorEl = island.tree().find((e) => propsOf(e)["data-field-error"] === "opens_at");
    expect(errorEl).toBeTruthy();
    expect(textOf(errorEl!)).toBe(t(uiEn, "reg.hub.config.incompleteDateTime"));
  });

  it("the SAME bug the other direction — a time picked with the date left blank ALSO blocks the save", async () => {
    net.getResponse = { ...RESPONSE, closes_at: null };
    const island = await openPanel();
    (propsOf(findHalf(island.tree(), "closes_at", "time")).onChange as (v: string) => void)("18:00");
    net.calls = [];
    await clickSave(island);
    expect(net.calls).toHaveLength(0);
    const errorEl = island.tree().find((e) => propsOf(e)["data-field-error"] === "closes_at");
    expect(errorEl).toBeTruthy();
  });

  it("applies to refund_lock_at too, and reveals the default-collapsed Money section it lives in", async () => {
    net.getResponse = { ...RESPONSE, fee_cents: 1500, payment_method: "stripe" };
    const island = await openPanel();
    expect(propsOf(accordionSection(island.tree(), "money")!).open).toBe(false);
    (propsOf(findHalf(island.tree(), "refund_lock_at", "date")).onChange as (v: string) => void)("2026-08-24");
    net.calls = [];
    await clickSave(island);
    expect(net.calls).toHaveLength(0);
    expect(propsOf(accordionSection(island.tree(), "money")!).open).toBe(true);
    expect(island.tree().find((e) => propsOf(e)["data-field-error"] === "refund_lock_at")).toBeTruthy();
  });

  it("does NOT block a save when the field is genuinely, deliberately cleared (both halves blank)", async () => {
    // refund_lock_at starts null in RESPONSE — "clearing" an already-empty
    // pair by touching then un-touching a half must stay a no-op, not a
    // phantom incompleteness.
    net.getResponse = { ...RESPONSE, fee_cents: 1500, payment_method: "stripe" };
    const island = await openPanel();
    const dateHalf = findHalf(island.tree(), "refund_lock_at", "date");
    (propsOf(dateHalf).onChange as (v: string) => void)("2026-08-24");
    (propsOf(findHalf(island.tree(), "refund_lock_at", "date")).onChange as (v: string) => void)("");
    net.calls = [];
    await clickSave(island);
    const put = net.calls.find((c) => c.method === "PUT");
    expect(put).toBeTruthy();
    expect((put!.json as Record<string, unknown>).refund_lock_at).toBeNull();
  });

  it("completing the missing half clears the error and lets the save proceed, with the right instant", async () => {
    net.getResponse = { ...RESPONSE, opens_at: null };
    const island = await openPanel();
    // Before closes_at (2026-02-01, from RESPONSE, untouched here) — a date
    // AFTER it would trip the separate dates-order rule once completed,
    // which is not what this test is about.
    (propsOf(findHalf(island.tree(), "opens_at", "date")).onChange as (v: string) => void)("2025-12-01");
    await clickSave(island); // blocked
    expect(island.tree().find((e) => propsOf(e)["data-field-error"] === "opens_at")).toBeTruthy();

    (propsOf(findHalf(island.tree(), "opens_at", "time")).onChange as (v: string) => void)("09:00");
    net.calls = [];
    await clickSave(island); // now proceeds
    const put = net.calls.find((c) => c.method === "PUT")!;
    expect(put).toBeTruthy();
    expect((put.json as Record<string, unknown>).opens_at).toBe(
      orgTzInputValueToInstant("2025-12-01T09:00", BASE_PROPS.orgTz),
    );
    expect(island.tree().find((e) => propsOf(e)["data-field-error"] === "opens_at")).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// RS005 R4 task 2 — client-side prevention of the server-enforced rules the
// dispatch names. The rule LOGIC itself (accept/reject boundaries) is
// covered exhaustively in registration-hub-config-state.test.ts
// (validateConfigState); this file proves the INTEGRATION — that the panel
// actually wires that function into saveAndReveal, blocks the network
// round trip, and shows the right field-level message.
// ---------------------------------------------------------------------------
describe("RegistrationHubConfigPanel — client-side validation blocks save before the round trip", () => {
  it("capacity over 10,000 blocks the save and errors on capacity", async () => {
    const island = await openPanel();
    const capacityInput = findField(island.tree(), "capacity")!;
    (propsOf(capacityInput).onChange as (e: { target: { value: string } }) => void)({
      target: { value: "10001" },
    });
    net.calls = [];
    await clickSave(island);
    expect(net.calls).toHaveLength(0);
    const errorEl = island.tree().find((e) => propsOf(e)["data-field-error"] === "capacity");
    expect(errorEl).toBeTruthy();
    expect(textOf(errorEl!)).toBe(t(uiEn, "reg.hub.config.capacityRangeError"));
  });

  it("capacity within range does NOT block the save", async () => {
    const island = await openPanel();
    const capacityInput = findField(island.tree(), "capacity")!;
    (propsOf(capacityInput).onChange as (e: { target: { value: string } }) => void)({
      target: { value: "500" },
    });
    net.calls = [];
    await clickSave(island);
    expect(net.calls.some((c) => c.method === "PUT")).toBe(true);
  });

  it("a fee over the 10,000,000-cent cap blocks the save and errors on fee_cents", async () => {
    const island = await openPanel();
    const feeInput = findField(island.tree(), "fee_cents")!;
    (propsOf(feeInput).onChange as (e: { target: { value: string } }) => void)({
      target: { value: "999999.99" },
    });
    net.calls = [];
    await clickSave(island);
    expect(net.calls).toHaveLength(0);
    const errorEl = island.tree().find((e) => propsOf(e)["data-field-error"] === "fee_cents");
    expect(errorEl).toBeTruthy();
    expect(textOf(errorEl!)).toBe(t(uiEn, "reg.hub.config.feeCentsRangeError"));
  });

  it("a card fee under 1.00 blocks the save and errors on fee_cents with the CARD-specific message", async () => {
    net.getResponse = { ...RESPONSE, payment_method: "offline" };
    const island = await openPanel();
    const stripeRadio = findField(island.tree(), "payment_method_stripe")!;
    (propsOf(stripeRadio).onChange as () => void)();
    const feeInput = findField(island.tree(), "fee_cents")!;
    (propsOf(feeInput).onChange as (e: { target: { value: string } }) => void)({ target: { value: "0.50" } });
    net.calls = [];
    await clickSave(island);
    expect(net.calls).toHaveLength(0);
    const errorEl = island.tree().find((e) => propsOf(e)["data-field-error"] === "fee_cents");
    expect(errorEl).toBeTruthy();
    expect(textOf(errorEl!)).toBe(t(uiEn, "reg.hub.config.cardFeeMinimumError"));
  });

  it("the SAME sub-1.00 fee is fine paying the organiser offline — the minimum is card-only", async () => {
    const island = await openPanel(); // RESPONSE defaults to payment_method: "offline"
    const feeInput = findField(island.tree(), "fee_cents")!;
    (propsOf(feeInput).onChange as (e: { target: { value: string } }) => void)({ target: { value: "0.50" } });
    net.calls = [];
    await clickSave(island);
    expect(net.calls.some((c) => c.method === "PUT")).toBe(true);
  });

  it("closes_at on or before opens_at blocks the save and errors on closes_at", async () => {
    const island = await openPanel();
    // opens_at defaults to 2026-01-01T00:00:00Z (RESPONSE); move closes_at
    // to a fully-specified instant BEFORE it.
    (propsOf(findHalf(island.tree(), "closes_at", "date")).onChange as (v: string) => void)("2025-12-01");
    (propsOf(findHalf(island.tree(), "closes_at", "time")).onChange as (v: string) => void)("00:00");
    net.calls = [];
    await clickSave(island);
    expect(net.calls).toHaveLength(0);
    const errorEl = island.tree().find((e) => propsOf(e)["data-field-error"] === "closes_at");
    expect(errorEl).toBeTruthy();
    expect(textOf(errorEl!)).toBe(t(uiEn, "reg.settings.datesError"));
  });

  it("two sign-up questions sharing a key block the save and error on form_fields", async () => {
    const island = await openPanel();
    const builder = island.tree().find((e) => e.type === FormBuilder)!;
    const duplicated: FormField[] = [
      { key: "shirt_size", label: "Shirt size", kind: "text", required: true },
      { key: "shirt_size", label: "T-shirt size", kind: "text", required: false },
    ];
    (propsOf(builder).onChange as (fields: FormField[]) => void)(duplicated);
    net.calls = [];
    await clickSave(island);
    expect(net.calls).toHaveLength(0);
    const errorEl = island.tree().find((e) => propsOf(e)["data-field-error"] === "form_fields");
    expect(errorEl).toBeTruthy();
    expect(textOf(errorEl!)).toBe(t(uiEn, "reg.hub.config.duplicateFormFieldKeysError"));
  });

  it("a choice question with no options blocks the save and errors on form_fields", async () => {
    const island = await openPanel();
    const builder = island.tree().find((e) => e.type === FormBuilder)!;
    const noOptions: FormField[] = [{ key: "size", label: "Size", kind: "select", options: [], required: false }];
    (propsOf(builder).onChange as (fields: FormField[]) => void)(noOptions);
    net.calls = [];
    await clickSave(island);
    expect(net.calls).toHaveLength(0);
    const errorEl = island.tree().find((e) => propsOf(e)["data-field-error"] === "form_fields");
    expect(errorEl).toBeTruthy();
    expect(textOf(errorEl!)).toBe(t(uiEn, "reg.hub.config.selectNeedsOptionsError"));
  });

  it("a well-formed edit across several fields is not blocked by any of the above", async () => {
    const island = await openPanel();
    const capacityInput = findField(island.tree(), "capacity")!;
    (propsOf(capacityInput).onChange as (e: { target: { value: string } }) => void)({ target: { value: "500" } });
    const builder = island.tree().find((e) => e.type === FormBuilder)!;
    (propsOf(builder).onChange as (fields: FormField[]) => void)([
      { key: "size", label: "Size", kind: "select", options: ["S", "M", "L"], required: false },
    ]);
    net.calls = [];
    await clickSave(island);
    expect(net.calls.some((c) => c.method === "PUT")).toBe(true);
    expect(island.tree().find((e) => propsOf(e)["data-field-error"])).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// RS005 R4 task 2 — "save it properly": does every field the panel shows
// actually round-trip through the two save endpoints? toRegistrationSettingsPutBody
// / toDivisionPatchBody are already proven exhaustive in
// registration-hub-config-state.test.ts; what's proven HERE is the other
// half — that each field's own onChange handler updates state with the
// value the organiser actually picked, not something else.
// ---------------------------------------------------------------------------
describe("RegistrationHubConfigPanel — every field round-trips through save", () => {
  it("eligibility + schedule + capacity + approval fields all reach their bodies with the NEW values", async () => {
    const island = await openPanel();
    const tree = () => island.tree();

    (propsOf(findField(tree(), "category")!).onChange as (e: { target: { value: string } }) => void)({
      target: { value: "mens" },
    });
    (propsOf(findField(tree(), "age_min")!).onChange as (e: { target: { value: string } }) => void)({
      target: { value: "12" },
    });
    (propsOf(findField(tree(), "age_max")!).onChange as (e: { target: { value: string } }) => void)({
      target: { value: "20" },
    });
    (propsOf(findField(tree(), "approval")!).onChange as (e: { target: { value: string } }) => void)({
      target: { value: "auto" },
    });
    (propsOf(findField(tree(), "enabled")!).onChange as (e: { target: { checked: boolean } }) => void)({
      target: { checked: false },
    });
    (propsOf(findField(tree(), "capacity")!).onChange as (e: { target: { value: string } }) => void)({
      target: { value: "64" },
    });
    (propsOf(findHalf(tree(), "opens_at", "date")).onChange as (v: string) => void)("2026-03-01");
    (propsOf(findHalf(tree(), "opens_at", "time")).onChange as (v: string) => void)("08:00");
    (propsOf(findHalf(tree(), "closes_at", "date")).onChange as (v: string) => void)("2026-04-01");
    (propsOf(findHalf(tree(), "closes_at", "time")).onChange as (v: string) => void)("20:00");

    net.calls = [];
    await clickSave(island);
    const patch = net.calls.find((c) => c.method === "PATCH")!;
    const put = net.calls.find((c) => c.method === "PUT")!;
    // age_cutoff_month/age_cutoff_day/eligibility_note are untouched by this
    // test, so they round-trip at their SEEDED (DIVISION fixture) values —
    // toDivisionPatchBody sends all six every save (RS007/V380 widened it
    // from three), never only the ones this test happened to edit.
    expect(patch.json).toEqual({
      category: "mens",
      age_min: 12,
      age_max: 20,
      age_cutoff_month: 9,
      age_cutoff_day: 1,
      eligibility_note: "School-registered students only",
    });
    const body = put.json as Record<string, unknown>;
    expect(body.approval).toBe("auto");
    expect(body.enabled).toBe(false);
    expect(body.capacity).toBe(64);
    expect(body.opens_at).toBe(orgTzInputValueToInstant("2026-03-01T08:00", BASE_PROPS.orgTz));
    expect(body.closes_at).toBe(orgTzInputValueToInstant("2026-04-01T20:00", BASE_PROPS.orgTz));
  });

  it("category='open' round-trips as null, not the literal string", async () => {
    const island = await openPanel();
    (propsOf(findField(island.tree(), "category")!).onChange as (e: { target: { value: string } }) => void)({
      target: { value: "open" },
    });
    net.calls = [];
    await clickSave(island);
    const patch = net.calls.find((c) => c.method === "PATCH")!;
    expect((patch.json as Record<string, unknown>).category).toBeNull();
  });

  it("unchecking allow_solo (allow_free_agents) on a team division round-trips false", async () => {
    const island = await openPanel(); // RESPONSE: entrant_kind team, allow_free_agents true
    const toggle = findField(island.tree(), "allow_free_agents")!;
    (propsOf(toggle).onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: false } });
    net.calls = [];
    await clickSave(island);
    const put = net.calls.find((c) => c.method === "PUT")!;
    expect((put.json as Record<string, unknown>).allow_free_agents).toBe(false);
  });

  it("switching entrant_kind round-trips the new kind AND force-clears allow_free_agents together", async () => {
    const island = await openPanel(); // starts team / allow_free_agents true
    const select = findField(island.tree(), "entrant_kind")!;
    (propsOf(select).onChange as (e: { target: { value: string } }) => void)({ target: { value: "individual" } });
    net.calls = [];
    await clickSave(island);
    const put = net.calls.find((c) => c.method === "PUT")!;
    const body = put.json as Record<string, unknown>;
    expect(body.entrant_kind).toBe("individual");
    expect(body.allow_free_agents).toBe(false);
  });

  it("payment_instructions round-trips on an offline division", async () => {
    const island = await openPanel(); // RESPONSE defaults to payment_method: offline
    const textarea = findField(island.tree(), "payment_instructions")!;
    (propsOf(textarea).onChange as (e: { target: { value: string } }) => void)({
      target: { value: "Bank transfer to club account, ref your name." },
    });
    net.calls = [];
    await clickSave(island);
    const put = net.calls.find((c) => c.method === "PUT")!;
    expect((put.json as Record<string, unknown>).payment_instructions).toBe(
      "Bank transfer to club account, ref your name.",
    );
  });

  it("switching payment_method to stripe round-trips", async () => {
    const island = await openPanel();
    const stripeRadio = findField(island.tree(), "payment_method_stripe")!;
    (propsOf(stripeRadio).onChange as () => void)();
    net.calls = [];
    await clickSave(island);
    const put = net.calls.find((c) => c.method === "PUT")!;
    expect((put.json as Record<string, unknown>).payment_method).toBe("stripe");
  });

  it("refund_lock_at round-trips once completed, on a paid card division", async () => {
    net.getResponse = { ...RESPONSE, fee_cents: 1500, payment_method: "stripe" };
    const island = await openPanel();
    (propsOf(findHalf(island.tree(), "refund_lock_at", "date")).onChange as (v: string) => void)("2026-01-25");
    (propsOf(findHalf(island.tree(), "refund_lock_at", "time")).onChange as (v: string) => void)("23:59");
    net.calls = [];
    await clickSave(island);
    const put = net.calls.find((c) => c.method === "PUT")!;
    expect((put.json as Record<string, unknown>).refund_lock_at).toBe(
      orgTzInputValueToInstant("2026-01-25T23:59", BASE_PROPS.orgTz),
    );
  });

  it("form_fields round-trips a changed question set", async () => {
    const island = await openPanel();
    const builder = island.tree().find((e) => e.type === FormBuilder)!;
    const next: FormField[] = [
      { key: "shirt_size", label: "Shirt size", kind: "select", options: ["S", "M", "L"], required: true },
      { key: "notes", label: "Notes", kind: "text", required: false },
    ];
    (propsOf(builder).onChange as (fields: FormField[]) => void)(next);
    net.calls = [];
    await clickSave(island);
    const put = net.calls.find((c) => c.method === "PUT")!;
    expect((put.json as Record<string, unknown>).form_fields).toEqual(next);
  });
});

// Review fix (RS007): the age-band cutoff (age_cutoff_month/age_cutoff_day)
// used to survive clearing the age band untouched. `hasAgeBand` only
// DISABLES the cutoff controls once the band is gone — it never cleared
// their STORED state — and toDivisionPatchBody sends all six eligibility
// keys together on every save (see that function's own doc comment), so the
// stale cutoff rode along in the PATCH body even though the band meant to
// anchor it had just been removed. Not a DB rejection:
// divisions_age_cutoff_check (V380) only enforces cutoff month/day
// BOTH-OR-NEITHER and says nothing about the age band, so the pair 9/1 with
// no band passes that constraint fine — this was a silently confusing,
// stranded value, not a save-time 500/422. And once the band is gone the
// cutoff controls are `disabled`, so the organiser had no way left in the
// UI to clear the stray value either — hence "uncleanable".
describe("RegistrationHubConfigPanel — clearing the age band clears a stranded cutoff (FIX 3)", () => {
  it("clearing age_min then age_max also clears the cutoff in STATE, not just on save", async () => {
    const island = await openPanel(); // DIVISION: age_min 10, age_max 18, cutoff month 9 / day 1
    (propsOf(findField(island.tree(), "age_min")!).onChange as (e: { target: { value: string } }) => void)({
      target: { value: "" },
    });
    (propsOf(findField(island.tree(), "age_max")!).onChange as (e: { target: { value: string } }) => void)({
      target: { value: "" },
    });
    // Fails pre-fix: the cutoff select/input still show the stale 9 / 1,
    // now behind `disabled` with no UI path left to clear them.
    expect(propsOf(findField(island.tree(), "age_cutoff_month")!).value).toBe("");
    expect(propsOf(findField(island.tree(), "age_cutoff_day")!).value).toBe("");

    net.calls = [];
    await clickSave(island);
    const patch = net.calls.find((c) => c.method === "PATCH")!;
    expect(patch.json).toEqual({
      category: "mixed",
      age_min: null,
      age_max: null,
      age_cutoff_month: null,
      age_cutoff_day: null,
      eligibility_note: "School-registered students only",
    });
  });

  it("clearing age_max first, then age_min, clears the cutoff too — order-independent", async () => {
    const island = await openPanel();
    (propsOf(findField(island.tree(), "age_max")!).onChange as (e: { target: { value: string } }) => void)({
      target: { value: "" },
    });
    (propsOf(findField(island.tree(), "age_min")!).onChange as (e: { target: { value: string } }) => void)({
      target: { value: "" },
    });
    expect(propsOf(findField(island.tree(), "age_cutoff_month")!).value).toBe("");
    expect(propsOf(findField(island.tree(), "age_cutoff_day")!).value).toBe("");
  });

  it("clearing only age_min while age_max stays set leaves the cutoff untouched — band still anchored", async () => {
    const island = await openPanel();
    (propsOf(findField(island.tree(), "age_min")!).onChange as (e: { target: { value: string } }) => void)({
      target: { value: "" },
    });
    expect(propsOf(findField(island.tree(), "age_cutoff_month")!).value).toBe(9);
    expect(propsOf(findField(island.tree(), "age_cutoff_day")!).value).toBe(1);
    // Still enabled: hasAgeBand is true (age_max is still 18).
    expect(propsOf(findField(island.tree(), "age_cutoff_month")!).disabled).toBe(false);
  });
});
