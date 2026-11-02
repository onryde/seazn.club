// #376 — the end date is mandatory at create and non-removable at edit.
//
// The schema half is pinned in api-v1/__tests__/schemas.test.ts. What no schema
// test can see is the JOIN between a form's state and the body it POSTs: both
// forms used to send `ends_on: <value> || null`, so a blank field shipped an
// explicit null. That null is now a 400, and a 400 here reads to the organiser
// as a bare "Invalid input" naming no field. So the click is the only witness
// for two things — that the body carries the date they typed, and that a
// missing or backwards one is refused in their own language before the round
// trip.
//
// vitest runs `environment: "node"` with no jsdom here, so the stateful islands
// are driven through the shared hook harness (see _hook-harness.tsx).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";
import { DateTimeField, type DateTimeFieldProps } from "../shared/datetime-field";
import { CompetitionWizard } from "../competition-wizard";
import { CompetitionSettings } from "../competition-settings";
import { apiV1 } from "@/lib/client-v1";
import { t } from "@/lib/i18n-runtime";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
}));
vi.mock("@/lib/client-v1", async () => {
  const actual = await vi.importActual<typeof import("@/lib/client-v1")>("@/lib/client-v1");
  return { ...actual, apiV1: vi.fn() };
});

// The REAL English catalog: `t()` returns the KEY on a miss, so an assertion on
// the sentence also fails if the key was never added to en/ui.json.
const enDict = uiEn as unknown as Dict;
const msg = (key: MessageKey) => t(enDict, key);
// Two surfaces, two sentences, ONE per surface: the competition SETTINGS form
// says `endsOn.required`; the New competition form says what the disabled Create
// button beside it already says (`missing.endsOn`, M9 — it used to answer a
// blank End with a second, different sentence on submit).
const REQUIRED = msg("comp.wizard.endsOn.required");
const WIZARD_MISSING_END = msg("comp.wizard.missing.endsOn");
const WIZARD_MISSING_BOTH = msg("comp.wizard.missing.both");
const BACKWARDS = msg("comp.validation.endsBeforeStarts");

const postedBody = () => {
  const call = vi.mocked(apiV1).mock.calls.at(-1);
  return (call?.[1] as { json: Record<string, unknown> }).json;
};

/** [starts, ends] — both forms render the pair in that order. */
const dateInputs = (tree: ReactElement[]) =>
  tree.filter((el) => el.type === "input" && propsOf(el).type === "date");

/**
 * `renderIsland` renders ONE component one level deep, so a date field that now
 * comes from the shared `DateTimeField` (date/time UX prompt 03) is an
 * unexpanded element and its `<input>` is invisible to `dateInputs`. The
 * component is hookless by design, so it is safe to call here — expanded IN
 * PLACE rather than appended, because these tests index the pair positionally
 * and appending would swap [starts, ends].
 */
const expandFields = (node: ReactNode): ReactElement[] =>
  walk(node).flatMap((el) =>
    el.type === DateTimeField
      ? [el, ...walk(DateTimeField(propsOf(el) as unknown as DateTimeFieldProps))]
      : [el],
  );

/** Match Day C8: Create needs a name too (its button is disabled without one, and a
 *  submit that gets past it is refused), so a journey that is about the DATES has
 *  to give the competition one, as an organiser would. */
function typeName(tree: ReactElement[], value: string): void {
  const input = tree.find((el) => el.type === "input" && propsOf(el).maxLength === 200)!;
  (propsOf(input).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
}

function typeDate(tree: ReactElement[], which: 0 | 1, value: string): void {
  const input = dateInputs(tree)[which]!;
  (propsOf(input).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
}

/** Fire the form's onSubmit the way a browser would. */
async function submitForm(tree: ReactElement[]): Promise<void> {
  const form = tree.find((el) => el.type === "form")!;
  await (propsOf(form).onSubmit as (e: { preventDefault: () => void }) => unknown)({
    preventDefault: () => {},
  });
}

beforeEach(() => {
  vi.mocked(apiV1).mockReset();
  vi.mocked(apiV1).mockResolvedValue({ id: "c1", slug: "summer-cup" } as never);
});

const mountWizard = () =>
  renderIsland(
    CompetitionWizard,
    // The public-dashboard upgrade figure is required (see the component)
    // but irrelevant here — these tests never reach the degrade card.
    { orgSlug: "riverside", orgId: "org-1", publicDashboardUpgrade: null, viewerPlan: "community" },
    expandFields,
  );

describe("CompetitionWizard — create requires an end date (#376)", () => {
  const mount = mountWizard;

  it("marks the end date required and leaves the start date optional", () => {
    const [starts, ends] = dateInputs(mount().tree());
    expect(propsOf(ends!)["aria-required"]).toBe("true");
    expect(propsOf(starts!)["aria-required"]).toBeUndefined();
  });

  it("refuses to POST at all when the end date is blank, and says why", async () => {
    const island = mount();
    typeName(island.tree(), "Summer Cup");
    // A start date alone is not enough — and since C8 it no longer FILLS the end
    // date in for you when one is already there; here none is typed after it.
    typeDate(island.tree(), 0, "2026-06-01");
    typeDate(island.tree(), 1, "");
    await submitForm(island.tree());

    expect(vi.mocked(apiV1)).not.toHaveBeenCalled();
    expect(island.text()).toContain(WIZARD_MISSING_END);
    // …and ONLY that sentence: the settings form's wording must not also appear.
    expect(island.text()).not.toContain(REQUIRED);
  });

  it("a blank name AND a blank end date get the one combined sentence, not two", async () => {
    // Enter in a field submits past the disabled button; the answer is the same
    // sentence the button's reason line shows (`both`), never `endsOn.required`.
    const island = mount();
    typeDate(island.tree(), 1, "");
    await submitForm(island.tree());

    expect(vi.mocked(apiV1)).not.toHaveBeenCalled();
    expect(island.text()).toContain(WIZARD_MISSING_BOTH);
    expect(island.text()).not.toContain(REQUIRED);
  });

  it("refuses an end date before the start date, without a round trip", async () => {
    const island = mount();
    typeName(island.tree(), "Summer Cup");
    typeDate(island.tree(), 0, "2026-06-01");
    typeDate(island.tree(), 1, "2026-05-31");
    await submitForm(island.tree());

    expect(vi.mocked(apiV1)).not.toHaveBeenCalled();
    expect(island.text()).toContain(BACKWARDS);
  });

  it("POSTs the typed date itself — never `|| null`", async () => {
    const island = mount();
    typeName(island.tree(), "Summer Cup");
    typeDate(island.tree(), 0, "2026-06-01");
    typeDate(island.tree(), 1, "2026-08-31");
    await submitForm(island.tree());

    expect(vi.mocked(apiV1)).toHaveBeenCalledTimes(1);
    expect(postedBody().ends_on).toBe("2026-08-31");
  });
});

// Date/time UX programme, prompt 03. The wizard hand-rolled both of its date
// controls as `<label className="block"><span className="label">…</span><input
// type="date" className="input" /></label>`; both now go through the shared
// `DateTimeField`, so every date/time control in the app is one component.
//
// The end date's `aria-required="true"` — the accessible stand-in for the
// native `required` attribute this form avoids on purpose (see submit()) —
// survives the swap as DateTimeField's `required` prop, which emits the ARIA
// and never the native attribute. The #376 assertion above is what guards
// that, unchanged; the component's own suite pins the "never native" half.
describe("CompetitionWizard — shared date/time control (date/time UX prompt 03)", () => {
  it("renders BOTH dates through the shared DateTimeField, not hand-rolled inputs", () => {
    const [starts, ends] = dateInputs(mountWizard().tree());
    // The class is the whole fingerprint from here: hand-rolled was `input`,
    // DateTimeField renders `input w-full text-base`. Visually a no-op —
    // `.input` already applies `w-full`, and `text-base` is the size it
    // inherits anyway (see the component for why not `sm:text-sm`).
    expect(propsOf(starts!).className).toBe("input w-full text-base");
    expect(propsOf(ends!).className).toBe("input w-full text-base");
  });

  it("keeps both labels, each still wrapping its own control", () => {
    // Held constant across the swap: same copy, same implicit association via
    // an enclosing <label> (DateTimeField is hookless, so there is no htmlFor).
    const tree = mountWizard().tree();
    const labels = [msg("comp.wizard.startsOn"), msg("comp.wizard.endsOn")];
    const inputs = dateInputs(tree);
    expect(inputs).toHaveLength(2);
    inputs.forEach((input, i) => {
      const index = tree.indexOf(input);
      // The label text span is the nearest `.label` before the input; the mark
      // (Ends) is an element nested inside it, so it can sit between the two in
      // the flattened tree.
      let at = index - 1;
      while (at >= 0 && propsOf(tree[at]!).className !== "label") at -= 1;
      expect(at, "a .label span precedes the input").toBeGreaterThan(0);
      expect(tree[at - 1]!.type).toBe("label");
      const children = propsOf(tree[at]!).children;
      if (i === 0) {
        // Starts is optional: its label is the bare string, no mark.
        expect(children).toBe(labels[0]);
      } else {
        // Ends is required: the mark is an aria-hidden ELEMENT after the label,
        // so it is not part of the control's accessible name (M1) — the label
        // string itself has no asterisk baked in.
        const [text, mark] = propsOf(children as ReactElement).children as [string, ReactElement];
        expect(text).toBe(labels[1]);
        expect(text).not.toContain("*");
        expect(mark.type).toBe("span");
        expect(propsOf(mark)["aria-hidden"]).toBe("true");
        expect(propsOf(mark).children).toContain("*");
      }
    });
  });

  it("still floors the end date at the start date the organiser picked", () => {
    // The one cross-field relationship the hand-rolled markup enforced. It is
    // now a prop, so a dropped `min` would be invisible without this.
    const island = mountWizard();
    expect(propsOf(dateInputs(island.tree())[1]!).min).toBeUndefined();
    typeDate(island.tree(), 0, "2026-06-01");
    expect(propsOf(dateInputs(island.tree())[1]!).min).toBe("2026-06-01");
  });

  it("still POSTs the dates typed into the shared controls", async () => {
    // The join the swap could break invisibly: DateTimeField hands its parent
    // the VALUE, not the event, so a mis-wired onChange would post undefined.
    const island = mountWizard();
    typeName(island.tree(), "Summer Cup");
    typeDate(island.tree(), 0, "2026-06-01");
    typeDate(island.tree(), 1, "2026-08-31");
    await submitForm(island.tree());

    expect(postedBody().starts_on).toBe("2026-06-01");
    expect(postedBody().ends_on).toBe("2026-08-31");
  });
});

describe("CompetitionSettings — the end date is changeable, not removable (#376)", () => {
  const mount = () =>
    renderIsland(CompetitionSettings, {
      competition: {
        id: "c1",
        name: "Summer Cup",
        slug: "summer-cup",
        description: null,
        starts_on: "2026-06-01",
        ends_on: "2026-08-31",
        visibility: "private",
        status: "draft",
        frozen: false,
        discoverable: false,
        discovery: {},
        branding: {},
      },
      orgId: "o1",
      canEdit: true,
      discoveryBranding: false,
      viewerPlan: "community",
    });

  it("still PATCHes a CHANGED end date", async () => {
    const island = mount();
    typeDate(island.tree(), 1, "2027-01-15");
    await submitForm(island.tree());

    expect(vi.mocked(apiV1)).toHaveBeenCalledTimes(1);
    expect(postedBody().ends_on).toBe("2027-01-15");
  });

  it("refuses to PATCH a CLEARED end date — the null that reopened the lock", async () => {
    const island = mount();
    typeDate(island.tree(), 1, "");
    await submitForm(island.tree());

    expect(vi.mocked(apiV1)).not.toHaveBeenCalled();
    expect(island.text()).toContain(REQUIRED);
  });

  it("refuses to PATCH an end date moved before the start date", async () => {
    const island = mount();
    typeDate(island.tree(), 1, "2026-05-31");
    await submitForm(island.tree());

    expect(vi.mocked(apiV1)).not.toHaveBeenCalled();
    expect(island.text()).toContain(BACKWARDS);
  });
});
