// RS004 W3c/W4 — a division's registration settings page: accordion sections
// (Eligibility/Open & close/Capacity default open, Money/sign-up form
// default collapsed) over the useRegistrationConfigPanelState hook for
// fetch/patch/save. A dialog until B7 T24 made it the hub's division tab.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { Modal } from "@/components/modal";
import { DateTimeField } from "@/components/v2/shared/datetime-field";
import { orgTzDateTimeHalves, orgTzInputValueToInstant } from "@/components/registration-hub-tz-input";
import { FormBuilder, type FormField } from "@/components/registration-hub-form-builder";
import type { RegistrationConfigState, RegistrationSettingsResponse } from "@/components/registration-hub-config-state";
import { ROUTABLE_FIELDS, type ConfigFieldKey } from "@/components/registration-hub-save-error";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import {
  RegistrationHubConfigPanel,
  EligibilitySection,
  OpenCloseSection,
  CapacitySection,
  MoneySection,
  FormSection,
  OrgTzDateTimePair,
  type ConfigSaveHandle,
} from "@/components/registration-hub-config-panel";
import { Disclosure, sectionTitle } from "@/components/registration-hub-config-section";

const net = vi.hoisted(() => ({
  calls: [] as { url: string; method: string; json?: unknown }[],
  getResponse: null as unknown,
  patchRejection: null as unknown,
  putRejection: null as unknown,
  /** B7 T23: holds the PUT open until released, so a test can type while a save is in flight. */
  putGate: null as Promise<void> | null,
}));

// B7 T23: the page layout opens every section from md up, read through `useMdUp` (null = the server snapshot, "not known yet",
// which is what the real hook hands this harness too). Mocked to a value a test sets, the way the sponsor sheet's tests do.
const mdUp = vi.hoisted(() => ({ value: null as boolean | null }));
vi.mock("@/components/ui/use-md-up", () => ({ useMdUp: () => mdUp.value }));

// B7 T23 review m5: every reveal the panel asks for, in order (the real one still runs, and finds no document here).
const revealed = vi.hoisted(() => ({ anchors: [] as string[] }));
vi.mock("@/components/registration-hub-config-page-chrome", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/registration-hub-config-page-chrome")>();
  return {
    ...actual,
    revealSection: (anchor: string) => {
      revealed.anchors.push(anchor);
      return actual.revealSection(anchor);
    },
  };
});

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
        return net.putGate ? net.putGate.then(() => ({})) : Promise.resolve({});
      }
      return Promise.resolve({});
    },
  };
});

import { ApiV1Error } from "@/lib/client-v1";
import { plural, t } from "@/lib/i18n-runtime";
import { SECTION_IDS, type SectionId } from "@/components/registration-hub-config-panel-sections";
import { configDirty, type ConfigDirty } from "@/components/use-config-dirty";
import { toDivisionPatchBody, toRegistrationSettingsPutBody } from "@/components/registration-hub-config-state";
import { ConfigSaveBar, ConfigSectionIndex, revealSection, sectionAnchor } from "@/components/registration-hub-config-page-chrome";
import { compileClasses, compileCss } from "@/components/v2/__tests__/_compiled-css";
import postcss from "postcss";
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
  // B7 T23 — the page layout's section index and Save bar (hookless, like the sections).
  ConfigSectionIndex as unknown as SectionType,
  ConfigSaveBar as unknown as SectionType,
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
  place_by_at: null,
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

// FU1 — every kind the engine knows (a sport with no entrant model takes them all), so the fixture's stored "team"
// is offered. Derived from the engine, never typed here.
const ALL_KINDS = effectiveEntrantModel(null).kinds;

const DIVISION = {
  division_id: "div-1",
  name: "Open Singles",
  allowed_kinds: ALL_KINDS,
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
  place_by_at: null,
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

// walk() doesn't invoke opaque child components (the exported Section
// functions, the Save bar and the section index), so they're expanded manually. <details>/
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

/** The panel's tree with every section, the section index and the Save bar expanded (B7 T24: it was a Modal's children and
 *  footer until the dialog was retired). */
function expandPanel(node: ReactNode) {
  return deepExpand(node);
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

/** True when an element nested anywhere in `el`'s children matches. */
function holds(el: ReactElement, match: (x: ReactElement) => boolean): boolean {
  const walkKids = (kids: unknown): boolean => {
    if (Array.isArray(kids)) return kids.some(walkKids);
    if (typeof kids !== "object" || kids === null || !("props" in kids)) return false;
    const child = kids as ReactElement;
    return match(child) || walkKids(propsOf(child).children);
  };
  return walkKids(propsOf(el).children);
}

function accordionSection(tree: ReturnType<typeof expandPanel>, id: string) {
  return tree.find((e) => propsOf(e)["data-accordion-section"] === id);
}

beforeEach(() => {
  net.calls = [];
  net.getResponse = { ...RESPONSE };
  net.patchRejection = null;
  net.putRejection = null;
  net.putGate = null;
  mdUp.value = null;
  revealed.anchors = [];
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
      ...walk(EligibilitySection({ ...commonProps, orgTz: "UTC", ...dtProps })),
      ...walk(OpenCloseSection({ ...commonProps, orgTz: "UTC", allowedKinds: ALL_KINDS, kindHintId: "hint", ...dtProps })),
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
        allowedKinds: ALL_KINDS,
        kindHintId: "hint",
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
  it("writes nothing and puts the edited field back (the page stays: there is nothing to close since T24)", async () => {
    const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    (propsOf(findField(island.tree(), "capacity")!).onChange as (e: { target: { value: string } }) => void)({
      target: { value: "40" },
    });
    expect(propsOf(findField(island.tree(), "capacity")!).value).toBe(40);
    const cancelBtn = island.tree().find((e) => e.type === "button" && propsOf(e)["data-action"] === "cancel")!;
    (propsOf(cancelBtn).onClick as () => void)();
    expect(propsOf(findField(island.tree(), "capacity")!).value).toBe(RESPONSE.capacity);
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
  // B7 T23: `sectionTitle` and the section box (Disclosure) moved to registration-hub-config-section.tsx; both files are read.
  const source = ["../registration-hub-config-panel.tsx", "../registration-hub-config-section.tsx"]
    .map((f) => readFileSync(new URL(f, import.meta.url), "utf8"))
    .join("\n");
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
describe("RegistrationHubConfigPanel — the four clock fields", () => {
  async function clockFields() {
    // A CARD division: the refund lock is card-only now (the auto-refund it
    // governs gates on payment_intent_id, which an offline entry never has),
    // so the default offline fixture renders three clock fields, not four.
    // Switching the fixture keeps this suite asserting what it was written to
    // assert — that all four route through the shared field — rather than
    // quietly dropping one from its expectations. RESPONSE already carries
    // allow_free_agents:true, so place_by_at (RS012/V389) renders here too.
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

  it("routes all four through the shared pair, each as a date half and a time half", async () => {
    const fields = await clockFields();
    expect([...fields.keys()].sort()).toEqual(
      [
        "opens_at_date",
        "opens_at_time",
        "closes_at_date",
        "closes_at_time",
        "refund_lock_at_date",
        "refund_lock_at_time",
        "place_by_at_date",
        "place_by_at_time",
      ].sort(),
    );
    expect(fields.get("opens_at_date")!.kind).toBe("date");
    expect(fields.get("opens_at_time")!.kind).toBe("time");
    // Never the old bare composite — that's the exact opacity this task
    // fixed (DateTimeSplitField's own joinValue hid incompleteness).
    expect([...fields.values()].every((f) => f.kind !== "datetime-local")).toBe(true);
  });

  it("gives the three CUTOFFS' time halves the 23:59 option, and the opening none", async () => {
    const fields = await clockFields();
    // The quarter-hour grid stops at 23:45. A deadline there shuts the door
    // fifteen minutes early; an OPENING at 23:45 is just an opening.
    expect(fields.get("closes_at_time")!.extraOptions).toEqual(["23:59"]);
    expect(fields.get("refund_lock_at_time")!.extraOptions).toEqual(["23:59"]);
    // RS012/V389 — place_by_at is a deadline too, same reasoning.
    expect(fields.get("place_by_at_time")!.extraOptions).toEqual(["23:59"]);
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
    // RESPONSE's place_by_at is also null — same "two empty halves" rule.
    expect(fields.get("place_by_at_date")!.value).toBe("");
    expect(fields.get("place_by_at_time")!.value).toBe("");
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
// promoteWaitlistedRow (usecases/registrations/waitlist.ts) reads the LIVE fee at
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

// Owner ruling 2026-10-26: chess divisions are individual-only. Driven through the REAL panel (the hook's GET, the
// state it seeds, the PUT body a save sends) so a prop that is declared and never read cannot pass: the seam is
// division.individual_only -> the hook's seed -> the select, the checkbox and the wire body.
describe("RegistrationHubConfigPanel — individual-only (chess)", () => {
  const CHESS_DIVISION = { ...DIVISION, individual_only: true };
  /** The entrant-type select's option values, read off its own children. */
  const optionValues = (tree: ReturnType<typeof expandPanel>): string[] => {
    const kids = propsOf(findField(tree, "entrant_kind")!).children;
    return (Array.isArray(kids) ? kids.flat() : [kids])
      .filter((k): k is { props: { value: string } } => typeof k === "object" && k !== null && "props" in k)
      .map((k) => k.props.value);
  };
  const testId = (tree: ReturnType<typeof expandPanel>, id: string) => tree.find((e) => propsOf(e)["data-testid"] === id);
  const saveButton = (island: { tree: () => ReactElement[] }) =>
    island.tree().find((e) => e.type === "button" && propsOf(e)["data-action"] === "save")!;

  it("offers only Individual, locked, with the reason beside it - and no solo sign-up checkbox", async () => {
    // The stored row is the worst legacy case: team, solo pool on, a solo price.
    net.getResponse = { ...RESPONSE, entrant_kind: "team", allow_free_agents: true, free_agent_fee_cents: 500 };
    const island = renderIsland(RegistrationHubConfigPanel, { ...BASE_PROPS, division: CHESS_DIVISION }, expandPanel);
    await flush();
    const tree = island.tree();
    expect(optionValues(tree)).toEqual(["individual"]);
    const select = findField(tree, "entrant_kind")!;
    expect(propsOf(select).value).toBe("individual");
    expect(propsOf(select).disabled).toBe(true);
    expect(expandedText(tree)).toContain(t(uiEn, "reg.settings.entrant.chessOnly"));
    expect(findField(tree, "allow_free_agents")).toBeUndefined();
    expect(findField(tree, "free_agent_fee_cents")).toBeUndefined();
  });

  it("says that saving moves a legacy team row to individual entry - and only then", async () => {
    net.getResponse = { ...RESPONSE, entrant_kind: "team", allow_free_agents: true };
    const legacy = renderIsland(RegistrationHubConfigPanel, { ...BASE_PROPS, division: CHESS_DIVISION }, expandPanel);
    await flush();
    expect(testId(legacy.tree(), "entrant-kind-legacy")).toBeTruthy();
    expect(expandedText(legacy.tree())).toContain(t(uiEn, "reg.settings.entrant.chessLegacy"));

    net.getResponse = { ...RESPONSE, entrant_kind: "individual", allow_free_agents: false, free_agent_fee_cents: null };
    const clean = renderIsland(RegistrationHubConfigPanel, { ...BASE_PROPS, division: CHESS_DIVISION }, expandPanel);
    await flush();
    expect(testId(clean.tree(), "entrant-kind-individual-only")).toBeTruthy();
    expect(testId(clean.tree(), "entrant-kind-legacy")).toBeUndefined();
  });

  it("a save sends individual / no solo pool / no solo price, never the stored legacy shape", async () => {
    net.getResponse = { ...RESPONSE, entrant_kind: "team", allow_free_agents: true, free_agent_fee_cents: 500 };
    const island = renderIsland(RegistrationHubConfigPanel, { ...BASE_PROPS, division: CHESS_DIVISION }, expandPanel);
    await flush();
    await (propsOf(saveButton(island)).onClick as () => Promise<void>)();
    const put = net.calls.find((c) => c.method === "PUT")!;
    expect(put.json).toMatchObject({ entrant_kind: "individual", allow_free_agents: false, free_agent_fee_cents: null });
    // Everything else rides along unchanged (the full-replace contract).
    expect(put.json).toMatchObject({ capacity: 32, fee_cents: 1500, approval: "manual" });
  });

  it("positive pair: the same stored team row on a division that is NOT individual-only offers all three, unlocked, and saves team", async () => {
    net.getResponse = { ...RESPONSE, entrant_kind: "team", allow_free_agents: true, free_agent_fee_cents: 500 };
    const island = renderIsland(RegistrationHubConfigPanel, { ...BASE_PROPS, division: { ...DIVISION, individual_only: false } }, expandPanel);
    await flush();
    const tree = island.tree();
    expect(optionValues(tree)).toEqual(["individual", "team", "pair"]);
    expect(propsOf(findField(tree, "entrant_kind")!).disabled).toBeFalsy();
    expect(propsOf(findField(tree, "entrant_kind")!).value).toBe("team");
    expect(findField(tree, "allow_free_agents")).toBeTruthy();
    expect(testId(tree, "entrant-kind-individual-only")).toBeUndefined();
    await (propsOf(saveButton(island)).onClick as () => Promise<void>)();
    expect(net.calls.find((c) => c.method === "PUT")!.json).toMatchObject({
      entrant_kind: "team",
      allow_free_agents: true,
      free_agent_fee_cents: 500,
    });
  });

  it("a division row that predates the flag (no individual_only) is not restricted", async () => {
    const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    expect(optionValues(island.tree())).toEqual(["individual", "team", "pair"]);
  });

  it("a refusal from a stale page lands on the entrant type, in the dictionary's words (not the server's English)", async () => {
    net.getResponse = { ...RESPONSE, entrant_kind: "individual", allow_free_agents: false };
    net.putRejection = new ApiV1Error("Chess divisions take individual players only (server English)", 422, "CHESS_INDIVIDUAL_ONLY");
    const island = renderIsland(RegistrationHubConfigPanel, { ...BASE_PROPS, division: CHESS_DIVISION }, expandPanel);
    await flush();
    await (propsOf(saveButton(island)).onClick as () => Promise<void>)();
    const shown = island.tree().find((e) => propsOf(e)["data-field-error"] === "entrant_kind");
    expect(shown).toBeTruthy();
    expect(expandedText([shown!])).toBe(t(uiEn, "divset.err.chessIndividualOnly"));
  });

  it("EligibilitySection hides the solo sign-up checkbox for individual-only even when handed a team state", () => {
    const props = { state: FULL_STATE, errors: {}, patch: vi.fn(), msg: testMsg, locale: "en", orgTz: "UTC", dtDrafts: {}, onDateTimeHalfChange: vi.fn() };
    expect(walk(EligibilitySection({ ...props, individualOnly: false })).some((e) => propsOf(e)["data-field"] === "allow_free_agents")).toBe(true);
    expect(walk(EligibilitySection({ ...props, individualOnly: true })).some((e) => propsOf(e)["data-field"] === "allow_free_agents")).toBe(false);
  });
});

// FU1 (controller rulings 2-3): the entrant-type select offers ONLY the kinds the division takes, and a stored kind the
// division no longer takes is shown as not allowed (with the way out), never silently swapped. Driven through the REAL
// panel - the hook's GET, the select, the client gate and the PUT - so the seam division.allowed_kinds -> select ->
// save is proven end to end, not by a fixture on both sides. Allowed kinds come from the engine.
describe("RegistrationHubConfigPanel — only the division's allowed entrant kinds (FU1)", () => {
  const kindsOf = (kinds: ("team" | "individual" | "pair")[]) => effectiveEntrantModel(null, { entrants: { kinds } }).kinds;
  const TEAMS_ONLY = kindsOf(["team"]);
  const PAIRS_OR_INDIVIDUAL = kindsOf(["individual", "pair"]);
  const optionsOf = (tree: ReturnType<typeof expandPanel>) => {
    const kids = propsOf(findField(tree, "entrant_kind")!).children;
    return (Array.isArray(kids) ? kids.flat() : [kids])
      .filter((k): k is { props: { value: string; disabled?: boolean } } => typeof k === "object" && k !== null && "props" in k)
      .map((k) => ({ value: k.props.value, disabled: k.props.disabled === true }));
  };
  const testId = (tree: ReturnType<typeof expandPanel>, id: string) => tree.find((e) => propsOf(e)["data-testid"] === id);
  const saveButton = (island: { tree: () => ReactElement[] }) =>
    island.tree().find((e) => e.type === "button" && propsOf(e)["data-action"] === "save")!;

  it("offers exactly the division's kinds, in the house order, for every one-kind division and a two-kind one", async () => {
    // The house order of the select (individual, team, pair - the order this panel has always listed them, and the chess
    // tests pin). Typed here as the design states it; NOT the engine's order, which leads with team (review m8).
    const HOUSE_ORDER = ["individual", "team", "pair"] as const;
    let checked = 0;
    let reordered = 0;
    let individualChecked = 0;
    for (const allowed of [...ALL_KINDS.map((k) => kindsOf([k])), PAIRS_OR_INDIVIDUAL, ALL_KINDS]) {
      // The stored kind is one the division takes, so nothing is flagged.
      net.getResponse = { ...RESPONSE, entrant_kind: allowed[0]!, allow_free_agents: false };
      const island = renderIsland(RegistrationHubConfigPanel, { ...BASE_PROPS, division: { ...DIVISION, allowed_kinds: allowed } }, expandPanel);
      await flush();
      const offered = optionsOf(island.tree());
      expect(offered.every((o) => !o.disabled), allowed.join(",")).toBe(true);
      const want = HOUSE_ORDER.filter((k) => allowed.includes(k));
      expect(want, `premise: ${allowed.join(",")} is all of the division's kinds`).toHaveLength(allowed.length);
      expect(offered.map((o) => o.value), allowed.join(",")).toEqual(want);
      if (want.join() !== allowed.join()) reordered++;
      expect(testId(island.tree(), "entrant-kind-not-allowed")).toBeUndefined();
      const select = propsOf(findField(island.tree(), "entrant_kind")!);
      expect(String(select.className), "no amber ring").not.toContain("border-amber");
      // Fix round 2: the positive pair of the refused case - a valid kind is not invalid and is described by nothing.
      expect(select["aria-invalid"], allowed.join(",")).toBeUndefined();
      expect(select["aria-describedby"], allowed.join(",")).toBeUndefined();
      // The individual option shows the kind's word (it must fit at 320); "creates a player" is its accessible name.
      const individual = ((select.children as unknown[]).flat() as ReactElement[]).find(
        (k) => typeof k === "object" && k !== null && propsOf(k).value === "individual",
      );
      if (allowed.includes("individual")) {
        expect(expandedText([individual!])).toBe(t(uiEn, "reg.settings.entrant.individual"));
        expect(propsOf(individual!)["aria-label"]).toBe(t(uiEn, "reg.settings.entrant.individualAria"));
        individualChecked++;
      }
      checked++;
    }
    expect(checked).toBe(ALL_KINDS.length + 2);
    // The case that tells house order from engine order: without it the array assertion is as order-blind as a Set.
    expect(reordered).toBeGreaterThan(0);
    expect(individualChecked).toBeGreaterThan(0);
  });

  it("a stored kind the division refuses stays selected, marked not allowed, with the fix-it hint - and is never offered as a choice", async () => {
    net.getResponse = { ...RESPONSE, entrant_kind: "individual", allow_free_agents: false };
    const island = renderIsland(RegistrationHubConfigPanel, { ...BASE_PROPS, division: { ...DIVISION, allowed_kinds: TEAMS_ONLY } }, expandPanel);
    await flush();
    const tree = island.tree();
    expect(propsOf(findField(tree, "entrant_kind")!).value).toBe("individual");
    expect(optionsOf(tree)).toEqual([
      { value: "individual", disabled: true },
      { value: "team", disabled: false },
    ]);
    const kindName = t(uiEn, "divset.entrants.kind.individual");
    // Fix round 1 (m6): the option reads the kind's own word (the "(not allowed)" suffix did not fit at 320); the full
    // sentence is its accessible name, and the hint below carries the reason.
    const refusedOption = (propsOf(findField(tree, "entrant_kind")!).children as unknown[])
      .flat()
      .find((k): k is ReactElement => typeof k === "object" && k !== null && "props" in k && propsOf(k as ReactElement).disabled === true);
    expect(refusedOption, "premise: the refused option is drawn").toBeDefined();
    expect(expandedText([refusedOption!])).toBe(kindName);
    expect(propsOf(refusedOption!)["aria-label"]).toBe(t(uiEn, "reg.settings.entrant.notAllowedOption", { kind: kindName }));
    expect(String(propsOf(findField(tree, "entrant_kind")!).className)).toContain("border-amber-400");
    expect(expandedText([testId(tree, "entrant-kind-not-allowed")!])).toBe(
      t(uiEn, "reg.settings.entrant.notAllowedHint", { kind: kindName }),
    );
    // Fix round 2: the hint DESCRIBES the select (aria-describedby) and marks it invalid, rather than sitting inside its
    // label - so the select's name stays "Entrant type".
    const select = propsOf(findField(tree, "entrant_kind")!);
    const hint = propsOf(testId(tree, "entrant-kind-not-allowed")!);
    expect(typeof hint.id === "string" && hint.id.length > 0, "premise: the hint has an id").toBe(true);
    expect(select["aria-describedby"]).toBe(hint.id);
    expect(select["aria-invalid"]).toBe(true);
    const label = tree.find((e) => e.type === "label" && holds(e, (x) => propsOf(x)["data-field"] === "entrant_kind"));
    expect(label, "premise: the select sits in its label").toBeDefined();
    expect(holds(label!, (x) => propsOf(x)["data-testid"] === "entrant-kind-not-allowed"), "the hint is outside the label").toBe(false);
  });

  it("the refused-kind hint's id is the page's own, so two open division tabs never share one (B7 T24)", () => {
    // The hub mounts a page per open division tab, and two can show this hint at once: each select must describe ITS hint.
    const hintFor = (kindHintId: string) => {
      const tree = walk(
        OpenCloseSection({
          state: { ...FULL_STATE, entrant_kind: "individual" },
          errors: {},
          patch: vi.fn(),
          msg: testMsg,
          orgTz: "UTC",
          allowedKinds: TEAMS_ONLY,
          kindHintId,
          dtDrafts: {},
          onDateTimeHalfChange: vi.fn(),
        }),
      );
      return {
        describedBy: propsOf(findField(tree, "entrant_kind")!)["aria-describedby"],
        hintId: propsOf(testId(tree, "entrant-kind-not-allowed")!).id,
      };
    };
    const first = hintFor("«a»");
    const second = hintFor("«b»");
    expect(first).toEqual({ describedBy: "«a»", hintId: "«a»" });
    expect(second).toEqual({ describedBy: "«b»", hintId: "«b»" });
  });

  it("a save of the refused kind is stopped on the page (no PUT) with the error on the entrant type; picking an offered kind clears it and saves that kind", async () => {
    net.getResponse = { ...RESPONSE, entrant_kind: "individual", allow_free_agents: false };
    const island = renderIsland(RegistrationHubConfigPanel, { ...BASE_PROPS, division: { ...DIVISION, allowed_kinds: TEAMS_ONLY } }, expandPanel);
    await flush();
    await (propsOf(saveButton(island)).onClick as () => Promise<void>)();
    expect(net.calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    const shown = island.tree().find((e) => propsOf(e)["data-field-error"] === "entrant_kind");
    expect(expandedText([shown!])).toBe(t(uiEn, "reg.settings.entrant.notAllowedError"));

    (propsOf(findField(island.tree(), "entrant_kind")!).onChange as (e: { target: { value: string } }) => void)({ target: { value: "team" } });
    await flush();
    expect(testId(island.tree(), "entrant-kind-not-allowed")).toBeUndefined();
    await (propsOf(saveButton(island)).onClick as () => Promise<void>)();
    expect(net.calls.find((c) => c.method === "PUT")!.json).toMatchObject({ entrant_kind: "team" });
  });

  it("positive pair: the same stored kind on a division that takes it saves untouched, with no flag", async () => {
    net.getResponse = { ...RESPONSE, entrant_kind: "individual", allow_free_agents: false };
    const island = renderIsland(RegistrationHubConfigPanel, { ...BASE_PROPS, division: { ...DIVISION, allowed_kinds: PAIRS_OR_INDIVIDUAL } }, expandPanel);
    await flush();
    expect(testId(island.tree(), "entrant-kind-not-allowed")).toBeUndefined();
    await (propsOf(saveButton(island)).onClick as () => Promise<void>)();
    expect(net.calls.find((c) => c.method === "PUT")!.json).toMatchObject({ entrant_kind: "individual" });
  });

  it("a refusal from a stale page (the division narrowed since it loaded) lands on the entrant type, in the dictionary's words", async () => {
    net.getResponse = { ...RESPONSE, entrant_kind: "team", allow_free_agents: false };
    net.putRejection = new ApiV1Error("this division doesn't take 'team' entrants (server English)", 422, "ENTRANT_KIND_NOT_ALLOWED");
    const island = renderIsland(RegistrationHubConfigPanel, BASE_PROPS, expandPanel);
    await flush();
    await (propsOf(saveButton(island)).onClick as () => Promise<void>)();
    const shown = island.tree().find((e) => propsOf(e)["data-field-error"] === "entrant_kind");
    expect(shown).toBeTruthy();
    expect(expandedText([shown!])).toBe(t(uiEn, "reg.settings.entrant.notAllowedError"));
  });
});

// ---------------------------------------------------------------------------
// B7 T23 (spec §9.3) — the panel as a PAGE (a division's own hub tab), with dirty tracking.
// ---------------------------------------------------------------------------
//
// The sections sit in the page (no Modal), a Save bar is pinned to the bottom, and from md up every
// section is open with a section index beside them. Dirty means "differs from what the server holds as far as this editor
// knows" — the values it loaded, moved forward by each request that landed — never "differs from the props it mounted with".
// Every copy expectation comes from the English dictionary; the counts from what the test itself typed.
describe("RegistrationHubConfigPanel — page layout (B7 T23)", () => {
  const SHARED = BASE_PROPS;
  type Change = (e: { target: { value?: string; checked?: boolean } }) => void;

  async function openPage(extra: Record<string, unknown> = {}) {
    const reports: ConfigDirty[] = [];
    const onSaved = vi.fn();
    const island = renderIsland(
      RegistrationHubConfigPanel,
      { ...SHARED, onSaved, onDirtyChange: (d: ConfigDirty) => void reports.push(d), ...extra },
      deepExpand,
    );
    await flush();
    const tree = () => island.tree();
    const field = (name: string) => findField(tree(), name)!;
    const type = (name: string, value: string) => (propsOf(field(name)).onChange as Change)({ target: { value } });
    const button = (action: "save" | "cancel") =>
      tree().find((e) => e.type === "button" && propsOf(e)["data-action"] === action)!;
    const click = (action: "save" | "cancel") => (propsOf(button(action)).onClick as () => Promise<void> | void)();
    const status = () => tree().find((e) => propsOf(e)["data-config-dirty"] !== undefined)!;
    const changedSections = () =>
      SECTION_IDS.filter((id) =>
        holds(accordionSection(tree(), id)!, (x) => propsOf(x)["data-section-changed"] !== undefined),
      );
    const root = () => tree().find((e) => propsOf(e)["data-registration-hub-config-panel"] !== undefined)!;
    return { island, tree, field, type, button, click, status, changedSections, root, reports, onSaved };
  }

  const CLEAN: ConfigDirty = { dirty: false, count: 0, sections: [] };
  /** The Save bar's tallest measured height (px): Chromium, 320 wide, the failed save's line wrapped (fr/nl/es), B7 T23 review. */
  const BAR_TALLEST_PX = 129;
  const allSaved = t(uiEn, "reg.config.allSaved");
  const unsaved = (n: number) => plural(uiEn, "reg.config.unsaved", n, "en");

  it("page layout renders no role=dialog", async () => {
    const page = await openPage();
    const tree = page.tree();
    expect(tree.some((e) => e.type === Modal)).toBe(false);
    expect(tree.some((e) => propsOf(e).role === "dialog" || propsOf(e)["aria-modal"] !== undefined)).toBe(false);
    expect(propsOf(page.root())["data-layout"]).toBe("page");
    expect(propsOf(page.root())["data-division-id"]).toBe("div-1");
    // One Save and one Cancel, the e2e's `data-action` hooks, in the pinned bar.
    expect(tree.filter((e) => e.type === "button" && propsOf(e)["data-action"] === "save")).toHaveLength(1);
    expect(tree.filter((e) => e.type === "button" && propsOf(e)["data-action"] === "cancel")).toHaveLength(1);
    const bar = tree.find((e) => propsOf(e)["data-config-save-bar"] !== undefined)!;
    expect(holds(bar, (x) => propsOf(x)["data-action"] === "save")).toBe(true);
    expect(String(propsOf(bar).className)).toMatch(/(^|\s)sticky(\s|$)/);
    expect(String(propsOf(bar).className)).toMatch(/(^|\s)bottom-0(\s|$)/);
  });

  it("page layout at md renders every section as an open <section> under its own h3, with a section index linking each one", async () => {
    mdUp.value = true;
    const page = await openPage();
    const tree = page.tree();
    let checked = 0;
    const nav = tree.find((e) => e.type === "nav")!;
    expect(propsOf(nav)["aria-label"]).toBe(t(uiEn, "reg.config.sectionIndex"));
    const links = tree.filter((e) => e.type === "a" && propsOf(e)["data-section-link"] !== undefined);
    expect(links.map((a) => propsOf(a)["data-section-link"])).toEqual([...SECTION_IDS]);
    // Review m4: every section is open here, so nothing on it is a disclosure — no <details>, and no <summary> (which a screen
    // reader announces as a button) that a click or a key would not fold.
    expect(tree.some((e) => e.type === "details")).toBe(false);
    expect(tree.some((e) => e.type === "summary")).toBe(false);
    for (const id of SECTION_IDS) {
      const section = accordionSection(tree, id)!;
      expect(section.type, id).toBe("section");
      const anchor = propsOf(section).id as string;
      expect(anchor, id).toBe(sectionAnchor(id, "div-1"));
      // Two division tabs can be mounted at once (T24 hides the inactive one), so each anchor names its division too.
      expect(anchor).toContain("div-1");
      const link = links.find((a) => propsOf(a)["data-section-link"] === id)!;
      expect(propsOf(link).href).toBe(`#${anchor}`);
      // Named by its heading: an h3 (under the page's h2), the index's focus target, never a Tab stop.
      const heading = tree.find((e) => e.type === "h3" && holds(section, (x) => x === e))!;
      expect(propsOf(section)["aria-labelledby"], id).toBe(propsOf(heading).id);
      expect(textOf(heading), id).toBe(sectionTitle(id, testMsg, FORM_FIELDS.length));
      expect(propsOf(heading).tabIndex, id).toBe(-1);
      expect(propsOf(heading)["data-section-heading"], id).toBe(true);
      checked += 1;
    }
    expect(checked).toBe(SECTION_IDS.length);
    expect(new Set(tree.filter((e) => propsOf(e)["data-accordion-section"]).map((e) => propsOf(e).id)).size).toBe(5);
    // The page's own heading is the h2 (the division), so the sections sit one level under it.
    const h2 = tree.find((e) => e.type === "h2")!;
    expect(textOf(h2)).toBe("Open Singles");
  });

  it("below md, and before the viewport is known, the sections stay accordions with their usual defaults, each summary holding its h3", async () => {
    for (const value of [false, null]) {
      mdUp.value = value;
      const page = await openPage();
      const tree = page.tree();
      expect(propsOf(accordionSection(tree, "eligibility")!).open, String(value)).toBe(true);
      expect(propsOf(accordionSection(tree, "money")!).open, String(value)).toBe(false);
      expect(propsOf(accordionSection(tree, "form")!).open, String(value)).toBe(false);
      let checked = 0;
      for (const id of SECTION_IDS) {
        const details = accordionSection(tree, id)!;
        expect(details.type, `${value} ${id}`).toBe("details");
        const summary = tree.find((e) => e.type === "summary" && holds(details, (x) => x === e))!;
        expect(propsOf(summary).tabIndex, `${value} ${id}`).toBeUndefined();
        const heading = tree.find((e) => e.type === "h3" && holds(summary, (x) => x === e))!;
        expect(textOf(heading), `${value} ${id}`).toBe(sectionTitle(id, testMsg, FORM_FIELDS.length));
        // The summary is the control here; the heading inside it is not a second Tab stop.
        expect(propsOf(heading).tabIndex, `${value} ${id}`).toBeUndefined();
        checked += 1;
      }
      expect(checked).toBe(SECTION_IDS.length);
      // The index is CSS-hidden below md (one DOM): never a second phone tree.
      expect(String(propsOf(tree.find((e) => e.type === "nav")!).className)).toMatch(/(^|\s)max-md:hidden(\s|$)/);
    }
  });

  it("a toggle below md opens and closes the accordion it belongs to", async () => {
    mdUp.value = false;
    const page = await openPage();
    const toggle = (open: boolean) =>
      (propsOf(accordionSection(page.tree(), "money")!).onToggle as (e: { target: { open: boolean } }) => void)({
        target: { open },
      });
    toggle(true);
    expect(propsOf(accordionSection(page.tree(), "money")!).open).toBe(true);
    toggle(false);
    expect(propsOf(accordionSection(page.tree(), "money")!).open).toBe(false);
  });

  it("the bar reads All changes saved, then 1 unsaved change, then 2 unsaved changes; Changed marks only the edited sections", async () => {
    // Real copy, not keys echoed back: a missing key would make both sides of every comparison below the same string.
    for (const key of ["reg.config.allSaved", "reg.config.changed", "reg.config.sectionIndex"]) {
      expect(t(uiEn, key)).not.toBe(key);
    }
    expect(unsaved(1)).not.toBe("reg.config.unsaved");
    const page = await openPage();
    expect(textOf(page.status())).toBe(allSaved);
    expect(propsOf(page.status())["data-config-dirty"]).toBe("clean");
    expect(page.changedSections()).toEqual([]);
    page.type("capacity", "40");
    expect(textOf(page.status())).toBe(unsaved(1));
    expect(page.changedSections()).toEqual(["capacity"]);
    page.type("fee_cents", "18");
    expect(textOf(page.status())).toBe(unsaved(2));
    expect(unsaved(2)).not.toBe(unsaved(1));
    expect(propsOf(page.status())["data-config-dirty"]).toBe("dirty");
    expect(page.changedSections()).toEqual(["capacity", "money"]);
    const tag = page.tree().find((e) => propsOf(e)["data-section-changed"] !== undefined)!;
    expect(textOf(tag)).toBe(t(uiEn, "reg.config.changed"));
  });

  it("editing capacity then restoring it is clean", async () => {
    const page = await openPage();
    page.type("capacity", "40");
    expect(page.reports.at(-1)).toEqual({ dirty: true, count: 1, sections: ["capacity"] });
    page.type("capacity", "32");
    expect(page.reports.at(-1)).toEqual(CLEAN);
    expect(textOf(page.status())).toBe(allSaved);
    expect(page.changedSections()).toEqual([]);
  });

  it("editing capacity and fee gives count 2, sections [capacity, money]", async () => {
    const page = await openPage();
    page.type("capacity", "40");
    page.type("fee_cents", "18");
    expect(page.reports.at(-1)).toEqual({ dirty: true, count: 2, sections: ["capacity", "money"] });
  });

  it("reports a change only when the answer moves: the mount's clean, then each new count, never a repeat", async () => {
    const page = await openPage();
    expect(page.reports).toEqual([CLEAN]);
    page.type("capacity", "40");
    page.type("capacity", "41");
    page.type("capacity", "42");
    expect(page.reports).toEqual([CLEAN, { dirty: true, count: 1, sections: ["capacity"] }]);
    page.type("fee_cents", "18");
    expect(page.reports).toHaveLength(3);
  });

  it("reports to the LATEST onDirtyChange, and a parent re-rendering with a fresh callback is not a change", async () => {
    const page = await openPage();
    const later: ConfigDirty[] = [];
    // A parent passing an inline arrow hands down a new function every render; that alone must not report (a parent that
    // stores the report in state would otherwise re-render, pass a new arrow, and loop).
    page.island.rerender({ ...SHARED, onSaved: page.onSaved, onDirtyChange: (d) => void later.push(d) });
    expect(later).toEqual([]);
    page.type("capacity", "40");
    expect(later).toEqual([{ dirty: true, count: 1, sections: ["capacity"] }]);
    expect(page.reports).toEqual([CLEAN]);
  });

  it("Cancel resets to the last saved values and reports clean", async () => {
    const page = await openPage();
    page.type("capacity", "40");
    page.type("fee_cents", "18.5");
    // A half-typed clock (date cleared, time kept) is a draft the state never sees: Cancel drops it too.
    (propsOf(findHalf(page.tree(), "opens_at", "date")).onChange as (v: string) => void)("");
    expect(propsOf(findHalf(page.tree(), "opens_at", "date")).value).toBe("");
    expect(page.reports.at(-1)!.dirty).toBe(true);
    await page.click("cancel");
    expect(propsOf(page.field("capacity")).value).toBe(32);
    expect(propsOf(page.field("fee_cents")).value).toBe("15.00");
    expect(propsOf(findHalf(page.tree(), "opens_at", "date")).value).toBe(orgTzDateTimeHalves(RESPONSE.opens_at, "UTC").date);
    expect(page.reports.at(-1)).toEqual(CLEAN);
    expect(textOf(page.status())).toBe(allSaved);
    expect(page.changedSections()).toEqual([]);
    // Cancel neither writes nor leaves: the tab stays open on the saved values.
    expect(net.calls.some((c) => c.method === "PATCH" || c.method === "PUT")).toBe(false);
    expect(page.onSaved).not.toHaveBeenCalled();
    expect(page.root()).toBeTruthy();
  });

  it("Cancel with nothing changed is a no-op that stays clean (the empty case)", async () => {
    const page = await openPage();
    await page.click("cancel");
    expect(page.reports).toEqual([CLEAN]);
    expect(propsOf(page.field("capacity")).value).toBe(32);
  });

  it("after a successful save the dirty state clears", async () => {
    const page = await openPage();
    page.type("capacity", "40");
    await page.click("save");
    expect(propsOf(page.root())["data-save-outcome"]).toBe("success");
    expect(page.onSaved).toHaveBeenCalledTimes(1);
    expect(page.reports.at(-1)).toEqual(CLEAN);
    expect(textOf(page.status())).toBe(allSaved);
    // The page stays (a tab, not a dialog that closes on save), still holding what was saved.
    expect(propsOf(page.field("capacity")).value).toBe(40);
  });

  it("the saved values move with each save: back to the MOUNT value is now a change, Cancel returns to the SAVED one, a second save sends the new value", async () => {
    const page = await openPage();
    page.type("capacity", "40");
    await page.click("save");
    page.type("capacity", "32");
    expect(page.reports.at(-1)).toEqual({ dirty: true, count: 1, sections: ["capacity"] });
    await page.click("cancel");
    expect(propsOf(page.field("capacity")).value).toBe(40);
    expect(page.reports.at(-1)).toEqual(CLEAN);
    page.type("capacity", "50");
    await page.click("save");
    const puts = net.calls.filter((c) => c.method === "PUT");
    expect(puts.map((c) => (c.json as { capacity: number }).capacity)).toEqual([40, 50]);
    expect(page.onSaved).toHaveBeenCalledTimes(2);
    expect(page.reports.at(-1)).toEqual(CLEAN);
  });

  it("after put-failed the tab stays dirty", async () => {
    const page = await openPage();
    page.type("capacity", "40");
    page.type("category", "open");
    expect(page.reports.at(-1)).toEqual({ dirty: true, count: 2, sections: ["eligibility", "capacity"] });
    net.putRejection = new ApiV1Error("capacity is out of range", 422, "ERROR");
    await page.click("save");
    expect(propsOf(page.root())["data-save-outcome"]).toBe("put-failed");
    // The PATCH landed (category), the PUT did not (capacity): only what is still unsaved stays dirty.
    expect(page.reports.at(-1)).toEqual({ dirty: true, count: 1, sections: ["capacity"] });
    expect(page.changedSections()).toEqual(["capacity"]);
    expect(page.onSaved).not.toHaveBeenCalled();
    // Cancel returns capacity to the stored 32 and keeps the category the server now holds — reverting it to "mixed" here
    // would make the next save quietly undo the half that landed.
    await page.click("cancel");
    expect(propsOf(page.field("capacity")).value).toBe(32);
    expect(propsOf(page.field("category")).value).toBe("open");
    expect(page.reports.at(-1)).toEqual(CLEAN);
    expect(page.tree().some((e) => e.type === "p" && propsOf(e)["data-save-outcome"] === "put-failed")).toBe(false);
  });

  it("after patch-failed the tab stays dirty on the eligibility half, and the settings half is saved", async () => {
    const page = await openPage();
    page.type("capacity", "40");
    page.type("category", "open");
    net.patchRejection = new ApiV1Error("age_max must be greater than or equal to age_min.", 422, "ERROR");
    await page.click("save");
    expect(propsOf(page.root())["data-save-outcome"]).toBe("patch-failed");
    expect(page.reports.at(-1)).toEqual({ dirty: true, count: 1, sections: ["eligibility"] });
    // A retry sends both bodies again and, once they land, the page is clean.
    await page.click("save");
    expect(propsOf(page.root())["data-save-outcome"]).toBe("success");
    expect(page.reports.at(-1)).toEqual(CLEAN);
  });

  it("after both failed every edit stays dirty", async () => {
    const page = await openPage();
    page.type("capacity", "40");
    page.type("category", "open");
    net.patchRejection = new ApiV1Error("age_max must be greater than or equal to age_min.", 422, "ERROR");
    net.putRejection = new ApiV1Error("capacity is out of range", 422, "ERROR");
    await page.click("save");
    expect(propsOf(page.root())["data-save-outcome"]).toBe("both-failed");
    expect(page.reports.at(-1)).toEqual({ dirty: true, count: 2, sections: ["eligibility", "capacity"] });
  });

  it("an edit typed while the save is in flight stays dirty once the save lands (the save moves the saved values to what it SENT)", async () => {
    let release!: () => void;
    net.putGate = new Promise<void>((r) => (release = r));
    const page = await openPage();
    page.type("capacity", "40");
    const saving = page.click("save");
    // While it is in flight both buttons are disabled: a Cancel now would show the old values over a save still landing.
    expect(propsOf(page.button("save")).disabled).toBe(true);
    expect(propsOf(page.button("cancel")).disabled).toBe(true);
    page.type("capacity", "50");
    release();
    await saving;
    expect(propsOf(page.root())["data-save-outcome"]).toBe("success");
    expect(propsOf(page.field("capacity")).value).toBe(50);
    expect(page.reports.at(-1)).toEqual({ dirty: true, count: 1, sections: ["capacity"] });
    expect(propsOf(page.button("cancel")).disabled).toBe(false);
  });

  it("a save the page refuses before the round trip (capacity over 10,000) sends nothing and stays dirty", async () => {
    const page = await openPage();
    page.type("capacity", "20000");
    await page.click("save");
    expect(net.calls.some((c) => c.method === "PATCH" || c.method === "PUT")).toBe(false);
    expect(page.reports.at(-1)).toEqual({ dirty: true, count: 1, sections: ["capacity"] });
    expect(page.tree().some((e) => propsOf(e)["data-field-error"] === "capacity")).toBe(true);
  });

  // --- B7 T23 review fixes -------------------------------------------------------------------------------------------------

  const findHalfChange = (page: Awaited<ReturnType<typeof openPage>>, field: string, half: "date" | "time", value: string) =>
    (propsOf(findHalf(page.tree(), field, half)).onChange as (v: string) => void)(value);
  const fieldErrorShown = (page: Awaited<ReturnType<typeof openPage>>, field: string) =>
    page.tree().some((e) => propsOf(e)["data-field-error"] === field);
  /** A refusal the server routes to one field: a validation issue with that field as its path. */
  const refusedOn = (field: string) =>
    new ApiV1Error("Invalid input", 400, "VALIDATION", { issues: [{ path: [field], message: `${field} refused by the server` }] });

  it("a clock with its date picked and its time still blank is 1 unsaved change, in its section, and reported; Cancel is clean (review I-1)", async () => {
    // No opening time stored, so picking a date leaves the time blank: a half the state never holds and Save refuses.
    net.getResponse = { ...RESPONSE, opens_at: null };
    const page = await openPage();
    expect(page.reports).toEqual([CLEAN]);
    findHalfChange(page, "opens_at", "date", "2026-03-01");
    expect(propsOf(findHalf(page.tree(), "opens_at", "time")).value).toBe("");
    expect(textOf(page.status())).toBe(unsaved(1));
    // The Open & close section is where the page shows the opening time.
    expect(page.changedSections()).toEqual(["schedule"]);
    expect(page.reports.at(-1)).toEqual({ dirty: true, count: 1, sections: ["schedule"] });
    await page.click("cancel");
    expect(propsOf(findHalf(page.tree(), "opens_at", "date")).value).toBe("");
    expect(page.reports.at(-1)).toEqual(CLEAN);
    expect(textOf(page.status())).toBe(allSaved);
  });

  it("a clock moved and then half-cleared counts once, not twice; completing it back to the saved instant is clean (review I-1)", async () => {
    const page = await openPage();
    const saved = orgTzDateTimeHalves(RESPONSE.opens_at, "UTC");
    findHalfChange(page, "opens_at", "date", "2026-03-01");
    expect(page.reports.at(-1)).toEqual({ dirty: true, count: 1, sections: ["schedule"] });
    // The state still holds the moved instant AND the pair is half-typed: one field, one change.
    findHalfChange(page, "opens_at", "time", "");
    expect(page.reports.at(-1)).toEqual({ dirty: true, count: 1, sections: ["schedule"] });
    expect(textOf(page.status())).toBe(unsaved(1));
    findHalfChange(page, "opens_at", "time", saved.time);
    findHalfChange(page, "opens_at", "date", saved.date);
    expect(page.reports.at(-1)).toEqual(CLEAN);
  });

  it("a half-typed clock beside another edit: 2 unsaved changes in two sections", async () => {
    net.getResponse = { ...RESPONSE, opens_at: null };
    const page = await openPage();
    page.type("capacity", "40");
    findHalfChange(page, "opens_at", "date", "2026-03-01");
    expect(page.reports.at(-1)).toEqual({ dirty: true, count: 2, sections: ["schedule", "capacity"] });
  });

  it("Cancel after a save the SERVER refused clears its field error and its banner (review m1)", async () => {
    const page = await openPage();
    page.type("capacity", "40");
    page.type("category", "open");
    net.putRejection = refusedOn("capacity");
    net.patchRejection = new ApiV1Error("The server is busy", 503, "ERROR");
    await page.click("save");
    const banners = () =>
      page.tree().filter((e) => e.type === "p" && propsOf(e).role === "alert" && textOf(e) === "The server is busy");
    expect(fieldErrorShown(page, "capacity")).toBe(true);
    expect(banners()).toHaveLength(1);
    await page.click("cancel");
    expect(fieldErrorShown(page, "capacity")).toBe(false);
    expect(banners()).toHaveLength(0);
    expect(page.reports.at(-1)).toEqual(CLEAN);
  });

  it("Cancel after a save the PAGE refused clears the refusal (review m1)", async () => {
    const page = await openPage();
    page.type("capacity", "20000");
    await page.click("save");
    expect(fieldErrorShown(page, "capacity")).toBe(true);
    await page.click("cancel");
    expect(fieldErrorShown(page, "capacity")).toBe(false);
    expect(propsOf(page.field("capacity")).value).toBe(32);
  });

  it("Cancel drops a typed solo price too, back to the stored empty (no separate price) (review m1)", async () => {
    const page = await openPage();
    page.type("free_agent_fee_cents", "7");
    expect(propsOf(page.field("free_agent_fee_cents")).value).toBe("7");
    expect(page.reports.at(-1)).toEqual({ dirty: true, count: 1, sections: ["money"] });
    await page.click("cancel");
    expect(propsOf(page.field("free_agent_fee_cents")).value).toBe("");
    expect(page.reports.at(-1)).toEqual(CLEAN);
  });

  it("the index marks exactly the changed sections, with a dot and a Changed a screen reader hears (review m1/m4)", async () => {
    mdUp.value = true;
    const page = await openPage();
    const links = () => page.tree().filter((e) => e.type === "a" && propsOf(e)["data-section-link"] !== undefined);
    const marked = () =>
      links()
        .filter((a) => holds(a, (x) => propsOf(x)["data-section-link-changed"] !== undefined))
        .map((a) => propsOf(a)["data-section-link"]);
    expect(marked()).toEqual([]);
    page.type("capacity", "40");
    page.type("fee_cents", "18");
    expect(marked()).toEqual(["capacity", "money"]);
    let checked = 0;
    for (const link of links().filter((a) => ["capacity", "money"].includes(propsOf(a)["data-section-link"] as string))) {
      const dot = (x: ReactElement) => propsOf(x)["aria-hidden"] === true && /(^|\s)rounded-full(\s|$)/.test(String(propsOf(x).className));
      expect(holds(link, dot)).toBe(true);
      const said: ReactElement[] = [];
      holds(link, (x) => (propsOf(x)["data-section-link-changed"] !== undefined ? (said.push(x), true) : false));
      expect(String(propsOf(said[0]!).className)).toMatch(/(^|\s)sr-only(\s|$)/);
      expect(textOf(said[0]!)).toContain(t(uiEn, "reg.config.changed"));
      // Inside the title's own box, so the link's name reads "Capacity (Changed)" with no stray space before it.
      expect(textOf(said[0]!).replace(/\s+/g, "")).toBe(`(${t(uiEn, "reg.config.changed")})`);
      checked += 1;
    }
    expect(checked).toBe(2);
    await page.click("cancel");
    expect(marked()).toEqual([]);
  });

  it("a legacy chess row (stored as a team with a solo pool) reads as unsaved on load, Cancel keeps the one shape chess takes, and Save moves it (review m2)", async () => {
    net.getResponse = { ...RESPONSE, entrant_kind: "team", allow_free_agents: true, free_agent_fee_cents: 500 };
    const page = await openPage({ division: { ...DIVISION, individual_only: true } });
    // The page shows individual / no solo pool / no solo price; the row still holds team / solo pool / 5.00 — three fields that
    // a save would change.
    // Clean while the GET is in flight, then three fields a save would change.
    expect(page.reports).toEqual([CLEAN, { dirty: true, count: 3, sections: ["eligibility", "schedule", "money"] }]);
    expect(textOf(page.status())).toBe(unsaved(3));
    // Save is never disabled for being clean or dirty: it is how this row moves.
    expect(propsOf(page.button("save")).disabled).toBe(false);
    // Cancel returns to what the page can show — never to the stored team shape, which the server refuses for chess.
    await page.click("cancel");
    expect(propsOf(page.field("entrant_kind")).value).toBe("individual");
    expect(page.reports.at(-1)!.count).toBe(3);
    await page.click("save");
    expect(net.calls.find((c) => c.method === "PUT")!.json).toMatchObject({
      entrant_kind: "individual",
      allow_free_agents: false,
      free_agent_fee_cents: null,
    });
    expect(page.reports.at(-1)).toEqual(CLEAN);
    expect(textOf(page.status())).toBe(allSaved);
  });

  it("positive pair: a chess row already stored as individual entry is clean on load, with Save still enabled", async () => {
    net.getResponse = { ...RESPONSE, entrant_kind: "individual", allow_free_agents: false, free_agent_fee_cents: null };
    const page = await openPage({ division: { ...DIVISION, individual_only: true } });
    expect(page.reports).toEqual([CLEAN]);
    expect(propsOf(page.button("save")).disabled).toBe(false);
  });

  it("every field the save sends is rendered inside exactly one section, and a change to it is counted in THAT section (review m3: the oracle is the rendered page)", async () => {
    mdUp.value = true;
    const sent = Object.keys({ ...toDivisionPatchBody(FULL_STATE), ...toRegistrationSettingsPutBody(FULL_STATE) }) as (keyof RegistrationConfigState)[];
    expect(new Set(sent)).toEqual(new Set(Object.keys(FULL_STATE)));
    /** A different value of the same shape — what an edit produces, without knowing which field it is. */
    const perturb = (v: unknown): unknown =>
      v === null ? 1 : typeof v === "number" ? v + 1 : typeof v === "boolean" ? !v : Array.isArray(v) ? [...v, { key: "x", label: "X", kind: "text", required: false }] : `${String(v)}!`;
    // Some fields render only where they apply — payment instructions for an offline division, the refund cutoff for a card
    // one — so the page is read twice and the sightings pooled.
    const shownIn = new Map<string, Set<SectionId>>();
    let renders = 0;
    for (const payment_method of ["offline", "stripe"] as const) {
      net.getResponse = { ...RESPONSE, payment_method };
      const page = await openPage();
      for (const id of SECTION_IDS) {
        for (const e of deepExpand(accordionSection(page.tree(), id)!)) {
          const name = propsOf(e)["data-field"];
          for (const field of sent) {
            // The sign-up form's questions are edited by its FormBuilder; every other field carries its name as data-field
            // (a clock's two halves and the payment method's two radios as `<field>_<part>`).
            const here =
              field === "form_fields"
                ? e.type === FormBuilder
                : name === field || (typeof name === "string" && name.startsWith(`${field}_`));
            if (here) {
              if (!shownIn.has(field)) shownIn.set(field, new Set());
              shownIn.get(field)!.add(id);
            }
          }
        }
      }
      renders += 1;
    }
    expect(renders).toBe(2);
    let checked = 0;
    for (const field of sent) {
      const sections = [...(shownIn.get(field) ?? [])];
      expect(sections, `${field} is rendered in exactly one section`).toHaveLength(1);
      const draft = { ...FULL_STATE, [field]: perturb(FULL_STATE[field]) } as RegistrationConfigState;
      expect(configDirty(FULL_STATE, draft), field).toEqual({ dirty: true, count: 1, sections });
      checked += 1;
    }
    expect(checked).toBe(sent.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("a save the server refuses on a field says so in the bar and reveals that field's section; a retry that lands reads saved (review m5)", async () => {
    const page = await openPage();
    page.type("capacity", "40");
    net.putRejection = refusedOn("capacity");
    await page.click("save");
    expect(t(uiEn, "reg.config.saveFailed")).not.toBe("reg.config.saveFailed");
    expect(textOf(page.status())).toBe(t(uiEn, "reg.config.saveFailed"));
    expect(propsOf(page.status())["data-config-status"]).toBe("failed");
    expect(propsOf(page.status())["data-config-dirty"]).toBe("dirty");
    expect(revealed.anchors).toEqual([sectionAnchor("capacity", "div-1")]);
    await page.click("save");
    expect(textOf(page.status())).toBe(allSaved);
    expect(propsOf(page.status())["data-config-status"]).toBe("clean");
    expect(revealed.anchors).toHaveLength(1);
  });

  it("a refusal with no field (a banner) reveals the page heading, where the banners sit (review m5)", async () => {
    const page = await openPage();
    page.type("capacity", "40");
    net.putRejection = new ApiV1Error("capacity is out of range", 422, "ERROR");
    await page.click("save");
    const h2 = page.tree().find((e) => e.type === "h2")!;
    expect(revealed.anchors).toEqual([propsOf(h2).id]);
    expect(propsOf(h2).tabIndex).toBe(-1);
    expect(textOf(page.status())).toBe(t(uiEn, "reg.config.saveFailed"));
  });

  it("a save the page refuses says so in the bar and reveals its section; Cancel clears the failure (review m5)", async () => {
    const page = await openPage();
    page.type("capacity", "20000");
    await page.click("save");
    // Nothing was sent, and the line says so (re-review m8: not the server failure's "not everything was saved").
    expect(textOf(page.status())).toBe(t(uiEn, "reg.config.saveRefused"));
    expect(revealed.anchors).toEqual([sectionAnchor("capacity", "div-1")]);
    // Fixing the value does not by itself say "saved": it is still unsaved until a save lands.
    page.type("capacity", "40");
    expect(textOf(page.status())).toBe(t(uiEn, "reg.config.saveRefused"));
    await page.click("cancel");
    expect(textOf(page.status())).toBe(allSaved);
    expect(propsOf(page.status())["data-config-status"]).toBe("clean");
  });

  it("once nothing is unsaved the bar says so, even right after a failed save (review m5)", async () => {
    const page = await openPage();
    page.type("capacity", "40");
    net.putRejection = refusedOn("capacity");
    await page.click("save");
    expect(propsOf(page.status())["data-config-status"]).toBe("failed");
    page.type("capacity", "32");
    expect(textOf(page.status())).toBe(allSaved);
    expect(propsOf(page.status())["data-config-status"]).toBe("clean");
  });

  it("while the page is mounted the viewport keeps a bottom scroll padding taller than the Save bar at its tallest (review m6)", async () => {
    const page = await openPage();
    const cls = String(propsOf(page.root()).className);
    // Scroll padding on the ROOT scroller, scoped by :has() to while this page is in the document. Not a margin on each control:
    // Chromium reveals a focused textarea by its caret, which ignores the control's scroll margin (measured, scratchpad
    // harness: the textarea stayed under the bar with a per-control margin and cleared it with the root padding).
    // Plus the home-indicator inset the bar pads itself by below md, so the headroom holds on a notched phone too (re-review m6).
    const rule = cls.match(
      /(?:^|\s)\[html:has\(&[^\s]*\)\]:scroll-pb-\[calc\((\d+(?:\.\d+)?)rem\+env\(safe-area-inset-bottom\)\)\](?:\s|$)/,
    );
    expect(rule, `no root scroll-padding rule (with the safe-area inset) on the page: ${cls}`).not.toBeNull();
    // 1rem = 16px at the root; the bar's tallest measured height is BAR_TALLEST_PX.
    expect(Number(rule![1]) * 16).toBeGreaterThanOrEqual(BAR_TALLEST_PX);
    expect(BAR_TALLEST_PX).toBeGreaterThan(0);
  });

  it("that scroll padding holds only while the page is ON SCREEN: a page in a hidden hub tab adds none (B7 T24)", async () => {
    // The hub keeps an open division's page mounted behind the tab on screen; Settings and Registrants have no Save bar.
    const page = await openPage();
    const cls = String(propsOf(page.root()).className)
      .split(/\s+/)
      .find((c) => c.includes(":scroll-pb-"))!;
    expect(cls, "premise: the page carries its scroll-padding class").toBeDefined();
    const css = await compileCss([cls]);
    const rules: string[] = [];
    postcss.parse(css).walkRules((rule) => {
      if (rule.nodes.some((n) => n.type === "decl" && n.prop === "scroll-padding-bottom")) rules.push(rule.selector);
    });
    // One rule, on the root, for a page that is not inside anything hidden.
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatch(/^html:has\(.+:not\(\[hidden\] \*\)\)$/);
  });

  it("the save handle answers what each save did — refused, success, put-failed, patch-failed, both-failed — and empties on unmount (G1)", async () => {
    const handle: { current: ConfigSaveHandle | null } = { current: null };
    const page = await openPage({ saveHandleRef: handle });
    expect(handle.current).not.toBeNull();
    page.type("capacity", "20000");
    expect(await handle.current!.save()).toBe("refused");
    expect(net.calls.some((c) => c.method === "PUT" || c.method === "PATCH")).toBe(false);
    page.type("capacity", "40");
    expect(await handle.current!.save()).toBe("success");
    expect(page.onSaved).toHaveBeenCalledTimes(1);
    // The handle sends only what changed (re-review m3), so each save below edits the half it is about.
    page.type("capacity", "41");
    net.putRejection = refusedOn("capacity");
    expect(await handle.current!.save()).toBe("put-failed");
    page.type("age_max", "17");
    net.patchRejection = refusedOn("age_max");
    expect(await handle.current!.save()).toBe("patch-failed");
    page.type("capacity", "42");
    net.putRejection = refusedOn("capacity");
    net.patchRejection = refusedOn("age_max");
    expect(await handle.current!.save()).toBe("both-failed");
    // The same save as the bar's: it reveals what refused it.
    expect(revealed.anchors.at(-1)).toBe(sectionAnchor("eligibility", "div-1"));
    page.island.unmount();
    expect(handle.current).toBeNull();
  });

  it("the handle's reveal shows the last refusal again — its section, else the page heading — for a host whose save ran out of sight (T24 fix round 1 m1)", async () => {
    const handle: { current: ConfigSaveHandle | null } = { current: null };
    const page = await openPage({ saveHandleRef: handle });
    // Empty case: nothing refused yet, so there is no section to point at — the page's own heading.
    revealed.anchors.length = 0;
    handle.current!.reveal();
    expect(revealed.anchors).toHaveLength(1);
    const heading = page.tree().find((e) => propsOf(e).id === revealed.anchors[0]);
    expect(heading?.type, "the anchor is the page's heading").toMatch(/^h[1-3]$/);
    // A refusal on the page: the reveal goes to that refusal's section, every time it is asked.
    page.type("capacity", "20000");
    expect(await handle.current!.save()).toBe("refused");
    revealed.anchors.length = 0;
    handle.current!.reveal();
    handle.current!.reveal();
    expect(revealed.anchors).toEqual([sectionAnchor("capacity", "div-1"), sectionAnchor("capacity", "div-1")]);
    // A server refusal in another section moves it there.
    page.type("capacity", "40");
    page.type("age_max", "17");
    net.patchRejection = refusedOn("age_max");
    expect(await handle.current!.save()).toBe("patch-failed");
    revealed.anchors.length = 0;
    handle.current!.reveal();
    expect(revealed.anchors).toEqual([sectionAnchor("eligibility", "div-1")]);
  });

  it("each page's refused-kind hint id is its own useId, never a constant two open division tabs would share (T24 fix round 1 m4)", async () => {
    const page = await openPage();
    const section = page.tree().find((e) => e.type === OpenCloseSection);
    expect(section, "premise: the schedule section is on the page").toBeDefined();
    // The harness's useId answers «h<n>»: the id handed down came from the hook, which React makes unique per mounted page.
    expect(propsOf(section!).kindHintId).toMatch(/^«h\d+»$/);
  });

  // ---- B7 T23 re-review (review-t23fix-report.md), folded into T24 ----

  it("a save that moves a legacy chess row retires the 'saving moves it' notice; a PUT that fails keeps it (re-review m1)", async () => {
    net.getResponse = { ...RESPONSE, entrant_kind: "team", allow_free_agents: true, free_agent_fee_cents: 500 };
    const page = await openPage({ division: { ...DIVISION, individual_only: true } });
    const notice = () => page.tree().some((e) => propsOf(e)["data-testid"] === "entrant-kind-legacy");
    expect(notice()).toBe(true);
    net.putRejection = refusedOn("capacity");
    await page.click("save");
    expect(notice(), "the row it describes is still stored").toBe(true);
    await page.click("save");
    expect(net.calls.filter((c) => c.method === "PUT")).toHaveLength(2);
    expect(notice(), "the PUT landed: the row is individual now").toBe(false);
  });

  it("a second save while one is in flight is the SAME save: one request and onSaved once; the next save sends again (re-review m2)", async () => {
    const handle: { current: ConfigSaveHandle | null } = { current: null };
    const page = await openPage({ saveHandleRef: handle });
    page.type("capacity", "40");
    let release!: () => void;
    net.putGate = new Promise<void>((resolve) => (release = resolve));
    const first = handle.current!.save();
    const second = handle.current!.save();
    const fromBar = page.click("save");
    expect(second).toBe(first);
    expect(fromBar).toBe(first);
    release();
    expect(await first).toBe("success");
    expect(net.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    expect(page.onSaved).toHaveBeenCalledTimes(1);
    // The guard is per flight, not for ever.
    net.putGate = null;
    page.type("capacity", "41");
    expect(await handle.current!.save()).toBe("success");
    expect(net.calls.filter((c) => c.method === "PUT")).toHaveLength(2);
    expect(page.onSaved).toHaveBeenCalledTimes(2);
  });

  it("the handle's save sends only the half that changed: a legacy chess row's PATCH carries nothing, so a PATCH that would 503 cannot fail the close (re-review m3)", async () => {
    net.getResponse = { ...RESPONSE, entrant_kind: "team", allow_free_agents: true, free_agent_fee_cents: 500 };
    const handle: { current: ConfigSaveHandle | null } = { current: null };
    const page = await openPage({ division: { ...DIVISION, individual_only: true }, saveHandleRef: handle });
    net.patchRejection = new ApiV1Error("Service unavailable", 503, "UNAVAILABLE");
    expect(await handle.current!.save()).toBe("success");
    expect(net.calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
    expect(net.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    expect(page.reports.at(-1)).toEqual(CLEAN);
    // The bar's Save is unchanged: both halves, every time — so here the PATCH refusal still lands.
    await page.click("save");
    expect(net.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
    expect(propsOf(page.root())["data-save-outcome"]).toBe("patch-failed");
  });

  it("nothing changed: the handle's save sends nothing, answers success and does not report a save (re-review m3, empty case)", async () => {
    const handle: { current: ConfigSaveHandle | null } = { current: null };
    const page = await openPage({ saveHandleRef: handle });
    expect(page.reports).toEqual([CLEAN]);
    expect(await handle.current!.save()).toBe("success");
    expect(net.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    expect(page.onSaved).not.toHaveBeenCalled();
  });

  it("a save asked for before the settings have loaded is refused, and sends nothing (re-review m5)", async () => {
    let answer!: (value: unknown) => void;
    net.getResponse = new Promise((resolve) => (answer = resolve));
    const handle: { current: ConfigSaveHandle | null } = { current: null };
    const island = renderIsland(RegistrationHubConfigPanel, { ...SHARED, saveHandleRef: handle }, deepExpand);
    await flush();
    expect(handle.current).not.toBeNull();
    expect(await handle.current!.save()).toBe("refused");
    expect(net.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    answer({ ...RESPONSE });
    await flush();
    expect(island.tree().some((e) => propsOf(e)["data-config-save-bar"] !== undefined)).toBe(true);
  });

  it("a clock refused for being half-typed loses its error the moment both halves are in (re-review m4)", async () => {
    net.getResponse = { ...RESPONSE, opens_at: null };
    const page = await openPage();
    findHalfChange(page, "opens_at", "date", "2026-03-01");
    await page.click("save");
    expect(fieldErrorShown(page, "opens_at")).toBe(true);
    expect(textOf(page.status())).toBe(t(uiEn, "reg.config.saveRefused"));
    findHalfChange(page, "opens_at", "time", "09:00");
    expect(fieldErrorShown(page, "opens_at")).toBe(false);
    // Still unsaved (the clock moved), and no longer a refused save.
    expect(propsOf(page.status())["data-config-status"]).toBe("dirty");
  });

  it("edited back to the saved values after a failed save: the banner and the field error go with the edits (re-review m4)", async () => {
    const page = await openPage();
    page.type("capacity", "40");
    net.putRejection = refusedOn("capacity");
    net.patchRejection = new ApiV1Error("Division unavailable", 500, "INTERNAL");
    await page.click("save");
    const alerts = () => page.tree().filter((e) => propsOf(e).role === "alert");
    expect(alerts().length).toBeGreaterThanOrEqual(2);
    expect(fieldErrorShown(page, "capacity")).toBe(true);
    expect(propsOf(page.root())["data-save-outcome"]).toBe("both-failed");
    page.type("capacity", "32");
    expect(textOf(page.status())).toBe(allSaved);
    expect(alerts()).toHaveLength(0);
    expect(fieldErrorShown(page, "capacity")).toBe(false);
    expect(propsOf(page.root())["data-save-outcome"]).toBeUndefined();
  });

  it("positive pair: a successful save keeps its outcome when the page turns clean — only a failure is cleared (re-review m4)", async () => {
    const page = await openPage();
    page.type("capacity", "40");
    await page.click("save");
    expect(textOf(page.status())).toBe(allSaved);
    expect(propsOf(page.root())["data-save-outcome"]).toBe("success");
  });

  it("the bar tells a refusal on the page (nothing sent) from a server failure (something may have saved) (re-review m8)", async () => {
    expect(t(uiEn, "reg.config.saveRefused")).not.toBe(t(uiEn, "reg.config.saveFailed"));
    const page = await openPage();
    page.type("capacity", "20000");
    await page.click("save");
    expect(net.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    expect(textOf(page.status())).toBe(t(uiEn, "reg.config.saveRefused"));
    page.type("capacity", "40");
    net.putRejection = refusedOn("capacity");
    await page.click("save");
    expect(textOf(page.status())).toBe(t(uiEn, "reg.config.saveFailed"));
  });

  it("revealing an element with no summary or section heading inside (the page's own h2) focuses the element itself (re-review m5)", () => {
    const target = { scrollIntoView: vi.fn(), querySelector: vi.fn(() => null), focus: vi.fn() };
    vi.stubGlobal("document", { getElementById: vi.fn(() => target) });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    try {
      expect(revealSection("the-page-heading")).toBe(true);
      expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
      expect(target.focus).toHaveBeenCalledWith({ preventScroll: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("no <div> sits inside a section's <summary>: its heading and spans only (re-review m7)", async () => {
    const page = await openPage();
    let summaries = 0;
    for (const id of SECTION_IDS) {
      for (const summary of deepExpand(accordionSection(page.tree(), id)!).filter((e) => e.type === "summary")) {
        summaries += 1;
        expect(holds(summary, (x) => x.type === "div"), id).toBe(false);
        expect(holds(summary, (x) => x.type === "h3"), id).toBe(true);
      }
    }
    expect(summaries).toBe(SECTION_IDS.length);
  });

  it("every heading focus is moved to shows a ring to a keyboard user, never a bare outline-none (re-review m7)", async () => {
    mdUp.value = true;
    const page = await openPage();
    const headings = page
      .tree()
      .filter((e) => e.type === "h2" || (e.type === "h3" && propsOf(e)["data-section-heading"] !== undefined));
    expect(headings).toHaveLength(SECTION_IDS.length + 1);
    const ring = (await compileClasses(["focus-visible:ring-2"])).get("focus-visible:ring-2")!;
    expect(Object.keys(ring).length, "the ring utility compiles to a rule").toBeGreaterThan(0);
    for (const h of headings) {
      expect(propsOf(h).tabIndex).toBe(-1);
      expect(String(propsOf(h).className).split(/\s+/)).toContain("focus-visible:ring-2");
    }
  });

  it("the section index reveals its section: scrolls to it, focuses its heading, and adds no #hash to history (review m4/m5)", () => {
    const heading = { focus: vi.fn() };
    const target = { scrollIntoView: vi.fn(), querySelector: vi.fn(() => heading), focus: vi.fn() };
    const getElementById = vi.fn((id: string) => (id === sectionAnchor("money", "div-1") ? target : null));
    vi.stubGlobal("document", { getElementById });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    try {
      const titles = Object.fromEntries(SECTION_IDS.map((id) => [id, id])) as Record<SectionId, string>;
      const nav = walk(ConfigSectionIndex({ divisionId: "div-1", label: "Sections", titles, changed: [], changedLabel: "Changed" }));
      const link = nav.find((e) => e.type === "a" && propsOf(e)["data-section-link"] === "money")!;
      const preventDefault = vi.fn();
      (propsOf(link).onClick as (e: { preventDefault: () => void }) => void)({ preventDefault });
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
      expect(target.querySelector).toHaveBeenCalledWith("summary, [data-section-heading]");
      expect(heading.focus).toHaveBeenCalledWith({ preventScroll: true });
      // No such element (the tab is not mounted): the link falls back to its plain href.
      const other = nav.find((e) => e.type === "a" && propsOf(e)["data-section-link"] === "capacity")!;
      const fallback = vi.fn();
      (propsOf(other).onClick as (e: { preventDefault: () => void }) => void)({ preventDefault: fallback });
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
