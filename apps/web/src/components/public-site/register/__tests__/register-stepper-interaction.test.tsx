// RS006 fix wave — interaction test for the register-stepper.tsx <->
// entry-cart.tsx <-> cart.ts coupling. Review round 1's systemic finding:
// this coupling had NO test file at all — cart.test.ts/validation.test.ts
// test the pure reducer/validators in isolation, and
// register-page-{live,closed}.test.tsx only do a single static
// renderToStaticMarkup pass. Nothing in the suite ever simulated a user
// clicking through the flow. This file mounts the REAL RegisterStepper via
// _hook-harness.tsx's renderIsland (no jsdom in this workspace — same
// reasoning as register-page-live.test.tsx's header) and drives it the way
// a browser would: invoking the SAME onClick/onChange callbacks React wires
// to the DOM, never reaching into internal state directly.
//
// useT() throws outside a <DictProvider> under the harness (its
// useContext always returns a context's DEFAULT value, and DictContext's
// default is null) — mocked below to the REAL English runtime translator,
// not an identity/key stub, so assertions read actual copy (matches
// _hook-harness.tsx's own stated preference: "pinning copy" over "pinning
// a lookup").
//
// RegisterStepper -> StepWho/StepEntries -> DivisionCard/EntryCart is TWO
// levels of opaque nesting (renderIsland's walk() never calls a child
// function component) — deepExpand() below is the flat-worklist fix for
// that, expanding every opaque node it finds in one pass regardless of
// nesting depth.
// RS006 step 5 — mocks the submit POST. Hoisted so the factory below can
// reference it (vi.mock is itself hoisted above every import by vitest's
// transform) — same pattern as registration-submit.test.ts's refCodeMock.
// FIX 3 (RS006 fix wave) — the factory now spreads the REAL module
// (`importOriginal`) rather than replacing it outright: register-stepper.tsx
// imports `ApiV1Error` from this same module to classify a failure's HTTP
// status, and a bare `{ apiV1: ... }` replacement would leave `ApiV1Error`
// `undefined` there, making `instanceof ApiV1Error` throw. Only `apiV1`
// itself is overridden.
const apiV1Mock = vi.hoisted(() => ({ impl: vi.fn() }));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return { ...actual, apiV1: (...args: unknown[]) => apiV1Mock.impl(...args) };
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement, ReactNode } from "react";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { ApiV1Error } from "@/lib/client-v1";
import { t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import { DivisionCard } from "../division-card";
import { EntryCart } from "../entry-cart";
import { EntryDetails } from "../entry-details";
import { FormFields } from "../form-fields";
import { RegisterStepper, type RegisterInfo } from "../register-stepper";
import { RosterTable } from "../roster-table";
import { StepConsent } from "../step-consent";
import { StepDetails } from "../step-details";
import { StepEntries } from "../step-entries";
import { StepReview } from "../step-review";
import { StepWho } from "../step-who";
import { REGISTER_STATE_VERSION } from "../storage";
import { EMPTY_CONTACT, type CartState, type DivisionLike, type FormFieldDef } from "../types";

const EN_UI: Dict = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "..", "..", "dictionaries", "en", "ui.json"), "utf8"),
) as Dict;

vi.mock("@/components/i18n/dict-provider", () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) => tRuntime(EN_UI, key, vars),
}));

// ---------------------------------------------------------------------------
// Harness plumbing
// ---------------------------------------------------------------------------

type ComponentFn = (props: Record<string, unknown>) => ReactNode;
const OPAQUE: ComponentFn[] = [
  StepWho,
  StepEntries,
  DivisionCard,
  EntryCart,
  StepDetails,
  EntryDetails,
  RosterTable,
  FormFields,
  StepConsent,
  StepReview,
] as unknown as ComponentFn[];

/** Flattens the WHOLE tree in one pass, including everything rendered
 *  inside every OPAQUE component above — a growing worklist re-checks
 *  `out.length` every iteration, so an opaque node discovered INSIDE an
 *  already-expanded opaque node (DivisionCard/EntryCart inside StepEntries;
 *  EntryDetails/RosterTable/FormFields inside StepDetails) gets expanded
 *  too, arbitrary nesting depth, no recursion needed. Every component here
 *  only calls the (mocked, non-hook) useT() internally, so invoking them
 *  outside the harness's render window is safe — RosterTable in particular
 *  used to own a `useState` for its paste-textarea draft; that was lifted
 *  to RegisterStepper (see roster-table.tsx's header) specifically so it
 *  could join this list. */
function deepExpand(node: ReactNode): ReactElement[] {
  const out = walk(node);
  for (let i = 0; i < out.length; i++) {
    const type = out[i]!.type;
    if (typeof type === "function" && OPAQUE.includes(type as ComponentFn)) {
      out.push(...walk((type as ComponentFn)(propsOf(out[i]!))));
    }
  }
  return out;
}

/** In-memory Storage, same shape storage.ts's own tests use. Assigned to
 *  globalThis.sessionStorage per-test so RegisterStepper's hydration effect
 *  (which calls loadRegisterState with no storage arg, resolving the real
 *  global) has something deterministic — and so one test's saved snapshot
 *  can never leak into the next. */
class MapStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

let fakeSessionStorage: MapStorage;
// RS006 step 5 — this workspace has no jsdom (_hook-harness.tsx's own
// header), so `window` does not exist at all unless stubbed: a submit test
// whose success path reaches `window.location.assign` would otherwise throw
// "window is not defined" INSIDE register-stepper.tsx's real code, not a
// test assertion. Stubbed minimally, same "assign a browser global on
// globalThis for the test's duration" convention as fakeSessionStorage
// below — `assignMock` lets a test also confirm WHICH url was assigned,
// computed independently via resolvePostSubmitNavigation's own (separately
// unit-tested, submit.test.ts) logic rather than re-deriving it here.
let assignMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fakeSessionStorage = new MapStorage();
  (globalThis as { sessionStorage?: unknown }).sessionStorage = fakeSessionStorage;
  assignMock = vi.fn();
  (globalThis as { window?: unknown }).window = { location: { assign: assignMock } };
  apiV1Mock.impl.mockReset();
});
afterEach(() => {
  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  delete (globalThis as { window?: unknown }).window;
});

const ORG_SLUG = "riverside";
const COMPETITION_SLUG = "summer-smash";

const DIV_OPEN: DivisionLike = {
  division_id: "div-open",
  name: "Open Singles",
  entrant_kind: "individual",
  category: null,
  age_min: null,
  age_max: null,
  requires_dob: false,
  requires_gender: false,
  allow_free_agents: false,
  open: true,
  closed_reason: null,
  capacity: null,
  remaining: null,
  taken: 0,
  opens_at: null,
  closes_at: null,
  fee_cents: 0,
  free_agent_fee_cents: null,
  currency: "gbp",
  payment_method: "offline",
  form_fields: [],
};

/** Womens-category, individual — categoryEligibilityIssues rejects a
 *  gender other than "f"/"x". requires_gender intentionally stays false
 *  (inherited) so WHO-step validation doesn't entangle with the
 *  eligibility check under test — the two are independent mechanisms
 *  (whoFieldRequirements vs. categoryEligibilityIssues). */
const DIV_WOMENS: DivisionLike = {
  ...DIV_OPEN,
  division_id: "div-womens",
  name: "Womens 35+",
  category: "womens",
};

/** A second unrestricted individual division — used for the RS006
 *  multi-self-link test below, where two DIFFERENT entries both need to be
 *  freely self-linkable with no eligibility noise from either one. */
const DIV_OPEN_2: DivisionLike = { ...DIV_OPEN, division_id: "div-open-2", name: "Open Doubles" };


function mount(divisions: DivisionLike[]) {
  const info: RegisterInfo = {
    competition: { name: "Test Cup", starts_on: "2026-09-01" },
    org: { name: "Test Org" },
    divisions,
  };
  const island = renderIsland(
    RegisterStepper,
    { orgSlug: ORG_SLUG, competitionSlug: COMPETITION_SLUG, info, locale: "en", joinCode: null },
    deepExpand,
  );

  const stepWho = () => {
    const el = island.tree().find((e) => e.type === StepWho);
    expect(el, "StepWho not in the tree — not on the WHO step?").toBeTruthy();
    return el!;
  };
  const divisionCard = (divisionId: string) => {
    const el = island
      .tree()
      .find((e) => e.type === DivisionCard && (propsOf(e).division as DivisionLike).division_id === divisionId);
    expect(el, `no DivisionCard for ${divisionId}`).toBeTruthy();
    return el!;
  };
  const selfCheckboxes = () =>
    island.tree().filter((e) => e.type === "input" && propsOf(e).type === "checkbox");
  // Scoped to JUST EntryCart's own rendered output — DivisionCard renders
  // its OWN copy of the same ineligibility sentence (design: grey the
  // division with the reason), so a page-wide text search would be
  // satisfied by that unrelated notice even if EntryCart's own verdict
  // block were broken. Re-invokes EntryCart fresh with its last-rendered
  // props (found via the un-expanded element deepExpand also leaves in the
  // tree) rather than trusting the globally-merged text.
  const entryCartText = () => {
    const el = island.tree().find((e) => e.type === EntryCart);
    expect(el, "EntryCart not in the tree — not on the ENTRIES step?").toBeTruthy();
    return textOf(walk((EntryCart as unknown as ComponentFn)(propsOf(el!))));
  };
  // Direct state inspection (not a copy-text proxy): EntryCart's own `cart`
  // prop, found via the un-expanded element deepExpand also leaves in the
  // tree — same technique entryCartText uses. Lets a test assert on
  // `entry.registering_self` itself rather than inferring the underlying
  // state from whether some piece of copy happens to be on the page.
  const entryCartCart = () => {
    const el = island.tree().find((e) => e.type === EntryCart);
    expect(el, "EntryCart not in the tree — not on the ENTRIES step?").toBeTruthy();
    return propsOf(el!).cart as CartState;
  };
  const clickByText = (text: string) => {
    const btn = island.tree().find((e) => e.type === "button" && textOf(e) === text);
    expect(btn, `no button with text "${text}"`).toBeTruthy();
    expect(propsOf(btn!).disabled, `button "${text}" is disabled`).not.toBe(true);
    (propsOf(btn!).onClick as () => void)();
  };
  const pageText = () => textOf(island.tree());

  return { island, stepWho, divisionCard, selfCheckboxes, clickByText, pageText, entryCartText, entryCartCart };
}

// ---------------------------------------------------------------------------
// Finding #2 — un-toggling "I'm playing" must clear the self-link, not just
// hide the checkbox
// ---------------------------------------------------------------------------

describe("finding #2 — un-toggling \"I'm playing\" clears the self-link", () => {
  it("auto-links the sole cart entry when imPlaying flips true; un-toggling both hides the checkbox AND clears the underlying registering_self flag (not just the UI)", () => {
    const { stepWho, divisionCard, selfCheckboxes, entryCartCart, clickByText } = mount([DIV_OPEN, DIV_WOMENS]);

    // WHO: name+email+dob filled once up front — dob becomes required the
    // moment imPlaying flips true (whoFieldRequirements), so filling it
    // early means no navigation is ever blocked by it later in this test.
    (propsOf(stepWho()).onChange as (p: object) => void)({
      name: "Alex Test",
      email: "alex@example.com",
      dob: "1990-01-01",
    });
    clickByText("Next"); // -> ENTRIES

    // Add one entry to the unrestricted division — imPlaying is still
    // false, so the "This is me" checkbox must not render at all yet
    // (fix wave finding #2's checkbox gate).
    (propsOf(divisionCard("div-open")).onAddIndividual as () => void)();
    expect(selfCheckboxes(), "no self checkbox before imPlaying is true").toHaveLength(0);

    clickByText("Back"); // -> WHO
    (propsOf(stepWho()).onImPlayingChange as (v: boolean) => void)(true);
    clickByText("Next"); // -> ENTRIES

    const linked = selfCheckboxes();
    expect(linked, "self checkbox renders once imPlaying is true").toHaveLength(1);
    expect(propsOf(linked[0]!).checked, "the sole entry auto-links").toBe(true);
    // Direct state check (not a copy-text proxy — RS006 removed the
    // cart-wide "only one entry" hint that used to serve this purpose): the
    // entry's OWN registering_self flag, off the cart EntryCart was
    // actually given.
    expect(entryCartCart().entries.map((e) => e.registering_self)).toEqual([true]);

    clickByText("Back"); // -> WHO
    (propsOf(stepWho()).onImPlayingChange as (v: boolean) => void)(false);
    clickByText("Next"); // -> ENTRIES

    // Both halves of the fix, checked independently: the checkbox is gone
    // (UI gate) AND the underlying flag is cleared too — checked directly on
    // the cart state, so this proves the LINK itself was cleared, not just
    // that the (already-hidden) control happens to also be absent.
    expect(selfCheckboxes(), "checkbox hidden once imPlaying is false again").toHaveLength(0);
    expect(
      entryCartCart().entries.map((e) => e.registering_self),
      "the flag itself must be cleared, not just the UI hidden",
    ).toEqual([false]);
  });
});

// ---------------------------------------------------------------------------
// RS006 — the cart-wide "at most one self entry" cap was removed. A
// registrant may link themselves on more than one entry at once (singles +
// doubles at the same tournament is the common racket-sports case).
// ---------------------------------------------------------------------------

describe("RS006 — a registrant may self-link more than one cart entry", () => {
  it('checking "This is me" on a SECOND entry does not uncheck the first — both stay checked, no blocking copy appears', () => {
    const { stepWho, divisionCard, selfCheckboxes, entryCartCart, clickByText, pageText } = mount([
      DIV_OPEN,
      DIV_OPEN_2,
    ]);

    (propsOf(stepWho()).onChange as (p: object) => void)({
      name: "Alex Test",
      email: "alex@example.com",
      dob: "1990-01-01",
    });
    clickByText("Next"); // -> ENTRIES (imPlaying still false)

    (propsOf(divisionCard("div-open")).onAddIndividual as () => void)();
    (propsOf(divisionCard("div-open-2")).onAddIndividual as () => void)();

    clickByText("Back"); // -> WHO
    (propsOf(stepWho()).onImPlayingChange as (v: boolean) => void)(true);
    clickByText("Next"); // -> ENTRIES — 2 entries present, autoLinkObviousSelf is a no-op (ambiguous, the rep must choose)

    const boxes = selfCheckboxes();
    expect(boxes, "two entries, two checkboxes").toHaveLength(2);
    expect(
      boxes.every((b) => propsOf(b).checked === false),
      "neither pre-checked — 2 entries is ambiguous for auto-link",
    ).toBe(true);

    // Check the FIRST box.
    (propsOf(boxes[0]!).onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    expect(entryCartCart().entries.map((e) => e.registering_self)).toEqual([true, false]);

    // Check the SECOND box too — must NOT uncheck the first.
    const boxesAfterFirst = selfCheckboxes();
    (propsOf(boxesAfterFirst[1]!).onChange as (e: { target: { checked: boolean } }) => void)({
      target: { checked: true },
    });
    expect(entryCartCart().entries.map((e) => e.registering_self), "BOTH stay checked").toEqual([true, true]);

    const finalBoxes = selfCheckboxes();
    expect(
      finalBoxes.every((b) => propsOf(b).checked === true),
      "both rendered checkbox elements read checked=true",
    ).toBe(true);

    // The old cart-wide restriction copy no longer exists anywhere on the page.
    expect(pageText()).not.toContain("Only one entry can be linked to your account.");
  });

  // Found by manual browser verification, not by any test: a restored
  // sessionStorage snapshot with TWO self-linked entries lost BOTH links on
  // mount. Root cause is a hydration race in register-stepper.tsx's
  // autoLinkObviousSelf/clearSelfLinkWhenNotPlaying effect (deps
  // `[imPlaying, cart.entries.length]`): on the FIRST render (before the
  // hydration effect's setImPlaying/setCart calls are applied) this effect
  // already fires once, with imPlaying's STALE pre-hydration value (false).
  // Its `setCart(prev => ...)` functional updater still chains onto the
  // hydration effect's newly-queued cart (React applies same-tick updates to
  // a state variable in call order), so `clearSelfLinkWhenNotPlaying` sees
  // "imPlaying is false" and a cart with self-linked entries, and clears
  // every one of them. A SECOND invocation follows once the real (post-
  // hydration) imPlaying/cart values commit — for exactly ONE cart entry,
  // `autoLinkObviousSelf` silently re-links it (its own "exactly one,
  // unambiguous" rule), which is why this was never visible under the OLD
  // cart-wide single-self-link model: there could never be more than one
  // entry to lose. With 2+ self-linked entries the second invocation's
  // auto-link never fires (ambiguous), so the damage from the first
  // invocation stands — RS006's multi-self-link feature is what finally
  // makes this pre-existing race observable.
  it("a restored snapshot with TWO self-linked entries keeps BOTH linked after mount — no click needed to reproduce the hydration race", () => {
    const key = `seazn_register_${ORG_SLUG}_${COMPETITION_SLUG}`;
    fakeSessionStorage.setItem(
      key,
      JSON.stringify({
        version: REGISTER_STATE_VERSION,
        contact: {
          name: "Alex Test",
          email: "alex@example.com",
          dob: "1990-01-01",
          gender: null,
          guardian_name: null,
          guardian_consent: false,
        },
        imPlaying: true,
        cart: {
          entries: [
            {
              id: "e1",
              division_id: "div-open",
              entrant_kind: "individual",
              team_name: null,
              partner_name: null,
              free_agent: false,
              players: [{ full_name: "", dob: null, gender: null, email: "", squad_number: "", is_captain: false }],
              answers: {},
              registering_self: true,
              self_player_index: null,
            },
            {
              id: "e2",
              division_id: "div-open-2",
              entrant_kind: "individual",
              team_name: null,
              partner_name: null,
              free_agent: false,
              players: [{ full_name: "", dob: null, gender: null, email: "", squad_number: "", is_captain: false }],
              answers: {},
              registering_self: true,
              self_player_index: null,
            },
          ],
        },
        consent: { privacy_consent: false, media_consent: false },
        stepIndex: 1,
      }),
    );

    const { entryCartCart, selfCheckboxes } = mount([DIV_OPEN, DIV_OPEN_2]);

    expect(
      entryCartCart().entries.map((e) => e.registering_self),
      "both entries must still be self-linked immediately after mount, with no interaction at all",
    ).toEqual([true, true]);
    const boxes = selfCheckboxes();
    expect(boxes, "two entries, two checkboxes").toHaveLength(2);
    expect(boxes.every((b) => propsOf(b).checked === true), "both checkboxes render checked").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FIX 1 (RS006 fix wave, 2026-08-27) — an EXPLICIT unlink must never be
// silently undone by an UNRELATED cart-shape change. The auto-link effect
// (register-stepper.tsx) is keyed on cart.entries.length: adding a second
// entry then removing it takes the length 1 -> 2 -> 1, re-firing the effect
// a SECOND time with the ORIGINAL entry once again the cart's only one.
// Before this fix, autoLinkObviousSelf could not tell that entry apart from
// one that was simply never linked, and silently re-linked it — resurrecting
// registering_self:true (and the guardian-consent gate that comes with it)
// for an entry the registrant explicitly said was not them. This is a
// SEQUENCE-of-dispatches bug, not any single action's output — a reducer
// test alone is structurally blind to it (cart.test.ts covers the new
// per-action behaviour separately); only a real click sequence through the
// mounted stepper can see it, which is why it shipped in the first place.
// ---------------------------------------------------------------------------

describe('FIX 1 — an explicit "not me" survives an unrelated add-then-remove', () => {
  it('unticking "This is me", then adding and removing a DIFFERENT entry, leaves the original entry unlinked', () => {
    const { stepWho, divisionCard, selfCheckboxes, entryCartCart, clickByText, island } = mount([
      DIV_OPEN,
      DIV_OPEN_2,
    ]);

    (propsOf(stepWho()).onChange as (p: object) => void)({
      name: "Alex Test",
      email: "alex@example.com",
      dob: "1990-01-01",
    });
    (propsOf(stepWho()).onImPlayingChange as (v: boolean) => void)(true);
    clickByText("Next"); // -> ENTRIES

    (propsOf(divisionCard("div-open")).onAddIndividual as () => void)();
    // Exactly one entry, imPlaying true, nothing ambiguous — auto-linked.
    expect(entryCartCart().entries.map((e) => e.registering_self), "auto-linked, the obvious case").toEqual([
      true,
    ]);

    // Explicitly untick "This is me" on that one entry.
    const box = selfCheckboxes()[0]!;
    expect(propsOf(box).checked, "starts checked (auto-linked)").toBe(true);
    (propsOf(box).onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: false } });
    expect(entryCartCart().entries.map((e) => e.registering_self), "explicit uncheck sticks").toEqual([false]);

    // Add a SECOND, unrelated entry — two entries now, so autoLinkObviousSelf
    // is a no-op (ambiguous), same as every other "2 entries" case in this
    // file. The point of this step is purely to re-fire the
    // cart.entries.length-keyed effect via 1 -> 2.
    (propsOf(divisionCard("div-open-2")).onAddIndividual as () => void)();
    expect(
      entryCartCart().entries.map((e) => e.registering_self),
      "still unlinked — the second entry was never linked either",
    ).toEqual([false, false]);

    // Remove that second entry — back to exactly ONE entry: the SAME entry
    // that was explicitly declined above. This re-fires the effect a SECOND
    // time via 2 -> 1, the exact trigger the bug report names.
    const removeButtons = () => island.tree().filter((e) => e.type === "button" && textOf(e) === "Remove");
    expect(removeButtons(), "one Remove control per cart line").toHaveLength(2);
    (propsOf(removeButtons()[1]!).onClick as () => void)();

    // The bug: autoLinkObviousSelf re-observes "exactly one, unlinked,
    // unambiguous" and silently re-links it. The fix: it must not — the
    // registrant's explicit "no" must be remembered, not just the CURRENT
    // registering_self value.
    expect(
      entryCartCart().entries.map((e) => e.registering_self),
      "the explicitly-declined entry must STAY unlinked — an unrelated add-then-remove must not resurrect it",
    ).toEqual([false]);
    expect(selfCheckboxes(), "checkbox reflects the same unlinked state").toHaveLength(1);
    expect(propsOf(selfCheckboxes()[0]!).checked, "checkbox must not silently re-check itself").toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Finding #3 — a self-linked ineligible entry shows a verdict in the cart
// AND blocks progression
// ---------------------------------------------------------------------------

describe("finding #3 — a self-linked ineligible entry blocks progression and shows its verdict in the cart", () => {
  it("blocks Next with the eligibility issue visible on the cart line, and unblocks once the contact qualifies", () => {
    const { stepWho, divisionCard, clickByText, pageText, entryCartText } = mount([DIV_OPEN, DIV_WOMENS]);

    (propsOf(stepWho()).onChange as (p: object) => void)({
      name: "Alex Test",
      email: "alex@example.com",
      dob: "1990-01-01",
    });
    clickByText("Next"); // -> ENTRIES

    (propsOf(divisionCard("div-womens")).onAddIndividual as () => void)();

    clickByText("Back"); // -> WHO
    (propsOf(stepWho()).onImPlayingChange as (v: boolean) => void)(true); // auto-links the sole entry
    (propsOf(stepWho()).onChange as (p: object) => void)({ gender: "m" }); // ineligible for womens
    clickByText("Next"); // -> ENTRIES

    // The cart line itself carries the verdict — same sentence
    // DivisionCard's own grey-with-reason notice uses (INELIGIBLE_MESSAGE_KEY,
    // the one shared presentation mapping). Scoped to EntryCart specifically
    // (entryCartText) — DivisionCard shows the SAME sentence independently,
    // so a page-wide search would pass even if EntryCart's own verdict were
    // never wired up.
    expect(entryCartText()).toContain("Not open to your gender for this category");

    clickByText("Next"); // attempt to advance — must be BLOCKED
    expect(pageText()).toContain("Resolve the eligibility issue on your entry before continuing");
    expect(pageText(), "must NOT have reached the end-cap").not.toContain("More steps on the way");

    // Make the contact eligible and confirm the SAME cart now unblocks.
    clickByText("Back"); // -> WHO
    (propsOf(stepWho()).onChange as (p: object) => void)({ gender: "f" });
    clickByText("Next"); // -> ENTRIES
    expect(entryCartText()).not.toContain("Not open to your gender for this category");
    clickByText("Next"); // now advances past ENTRIES, onto DETAILS (step 3)
    expect(pageText()).toContain("Player details");
  });

  it("an ineligible division does NOT block when it is not the self-linked one (design: stays pickable for team entries)", () => {
    const { stepWho, divisionCard, clickByText, pageText } = mount([DIV_OPEN, DIV_WOMENS]);

    (propsOf(stepWho()).onChange as (p: object) => void)({
      name: "Alex Test",
      email: "alex@example.com",
      dob: "1990-01-01",
      gender: "m",
    });
    clickByText("Next"); // -> ENTRIES

    // Add BOTH — the male contact adds a womens entry (unlinked) plus an
    // open entry, then links themselves to the OPEN one only.
    (propsOf(divisionCard("div-womens")).onAddIndividual as () => void)();
    (propsOf(divisionCard("div-open")).onAddIndividual as () => void)();

    clickByText("Back"); // -> WHO
    (propsOf(stepWho()).onImPlayingChange as (v: boolean) => void)(true);
    clickByText("Next"); // -> ENTRIES

    // autoLinkObviousSelf only fires for exactly ONE cart entry — with two
    // entries present it never auto-links, so no verdict/self checkbox
    // should be pinned to the womens entry, and Next must succeed.
    expect(pageText()).not.toContain("Resolve the eligibility issue on your entry before continuing");
    clickByText("Next"); // -> DETAILS (step 3)
    expect(pageText()).toContain("Player details");
  });
});

// ---------------------------------------------------------------------------
// Finding #5 — a restored-but-never-edited field renders helper text, not
// an error
// ---------------------------------------------------------------------------
//
// Extensive live-browser verification (fresh reload with the exact reported
// blob; also filling nothing, clicking Next to legitimately set
// whoAttempted, navigating away, and back-navigating) could not reproduce
// stale error text on a genuine restore against this commit's code —
// whoAttempted correctly starts false on every mount path exercised, and
// register/page.tsx is `force-dynamic`, which forces a true remount rather
// than reusing a Next.js router-cached instance. This test therefore locks
// in the CORRECT behavior (green without any further fix) and the
// defensive explicit `setWhoAttempted(false)`/`setEntriesAttempted(false)`
// added to the hydration effect is verified by a manual mutation check
// (temporarily seeding a bad initial value with the reset removed, see the
// fix wave report) rather than by a test that can go red against this
// codebase's current, reachable behavior.
// A restored snapshot carrying an EMPTY cart, on a competition whose entries
// step is collapsed, had no surface anywhere to add an entry.
//
// The hydration effect reads `if (saved) { restore } else if (collapseEntries)
// { seed }`, so a restored snapshot skips the auto-seed — and when entries is
// collapsed there is no step on which to add one by hand. The visitor walks
// WHO -> DETAILS -> CONSENT -> REVIEW with an empty cart, sees the "free"
// submit label, and gets a `.min(1)` 422 with nothing to fix. That is the same
// unrecoverable dead end the entrant-kind collapse fix (2d4d7b623) closed from
// the other direction, reached by a different route: reaching REVIEW with a
// cart the flow gives you no way to fill.
//
// It is genuinely reachable: advance past WHO on a two-division competition
// without adding an entry (the snapshot persists at stepIndex 1 with an empty
// cart), then return after one division closes. It is also reachable simply by
// restoring any snapshot saved before an entry was added.
//
// A whole-branch review probed this exact area and reported "no dead path
// found" — it checked that a division whose entrant kind CHANGED between
// visits regains the entries step, which it does, and stopped there.
describe("a restored EMPTY cart on a collapsed competition still gets its entry", () => {
  it("seeds the single open division even when a snapshot was restored, so DETAILS has a roster to fill", () => {
    const key = `seazn_register_${ORG_SLUG}_${COMPETITION_SLUG}`;
    fakeSessionStorage.setItem(
      key,
      JSON.stringify({
        version: REGISTER_STATE_VERSION,
        contact: {
          name: "Returning Visitor",
          email: "returning@example.com",
          dob: "1990-01-01",
          gender: null,
          guardian_name: null,
          guardian_consent: false,
        },
        imPlaying: true,
        // The whole point: a saved cart with nothing in it.
        cart: { entries: [] },
        consent: { privacy_consent: false, media_consent: false },
        stepIndex: 0,
      }),
    );

    const { clickByText, island } = mount([DIV_OPEN]);
    clickByText("Next"); // single open INDIVIDUAL division collapses ENTRIES -> DETAILS

    // The seeded entry is what puts a roster row on DETAILS. With the cart
    // left empty there is no row, no entry, and REVIEW would 422.
    const nameBox = island.tree().find((e) => propsOf(e)["aria-label"] === "Player 1 — Your name");
    expect(
      nameBox,
      "a restored empty cart must still be seeded — otherwise DETAILS renders no entry and REVIEW 422s with no surface to fix it",
    ).toBeDefined();
  });
});

describe("finding #5 — restoring a pristine saved snapshot never shows stale errors", () => {
  it("an empty-but-saved contact renders grey helper text on every field, not red errors", () => {
    const key = `seazn_register_${ORG_SLUG}_${COMPETITION_SLUG}`;
    fakeSessionStorage.setItem(
      key,
      JSON.stringify({
        version: REGISTER_STATE_VERSION,
        contact: { name: "", email: "", dob: null, gender: null, guardian_name: null, guardian_consent: false },
        imPlaying: true,
        cart: { entries: [] },
        consent: { privacy_consent: false, media_consent: false },
        stepIndex: 0,
      }),
    );

    // imPlaying:true is what makes dobRequired true unconditionally
    // (whoFieldRequirements — schemas.ts's superRefine requires contact.dob
    // whenever ANY entry is registering_self, independent of the eventual
    // division's own requires_dob). DIV_NEEDS_BOTH.requires_gender is what
    // additionally makes genderRequired true (review finding 3, 2026-08-27:
    // gender is gated on imPlaying too now — neither field is ever forced
    // on a contact who never plays, since both exist only as the self-row
    // "collected once" fallback).
    const DIV_NEEDS_BOTH: DivisionLike = { ...DIV_OPEN, division_id: "div-both", requires_dob: true, requires_gender: true };
    const { pageText } = mount([DIV_OPEN, DIV_NEEDS_BOTH]);

    const text = pageText();
    expect(text).not.toContain("Enter your name");
    expect(text).not.toContain("Enter a valid email address");
    expect(text).not.toContain("Enter your date of birth");
    expect(text).not.toContain("Select an option");
    expect(text).toContain("We'll send your confirmation and reference here.");
    expect(text).toContain("Needed because you're playing yourself, or a division you might enter has an age limit.");
    expect(text).toContain("Needed because a division you might enter is gender-restricted.");
  });
});

// ---------------------------------------------------------------------------
// Second review round, finding 3 (2026-08-27) — WHO-step dob/gender are
// collected ONLY when the contact is actually self-linking, never merely
// because SOME division requires them. Both fields exist purely as the
// self-row "collected once" fallback (roster.ts); a division's own
// requires_dob/requires_gender is satisfied per-ROSTER-ROW at step 3
// instead, for every entry regardless of who's playing.
// ---------------------------------------------------------------------------

describe("2026-08-27 review finding 3 — a non-playing contact is never forced to give their own dob/gender", () => {
  it("a team captain with 'I'm playing' OFF sees NO dob/gender fields and is never blocked by them, even for a division that requires both", () => {
    const DIV_TEAM_NEEDS_BOTH: DivisionLike = {
      ...DIV_OPEN,
      division_id: "div-team-needs-both",
      entrant_kind: "team",
      requires_dob: true,
      requires_gender: true,
    };
    const { stepWho, clickByText, pageText, island } = mount([DIV_TEAM_NEEDS_BOTH]);

    (propsOf(stepWho()).onChange as (p: object) => void)({ name: "Team Captain", email: "captain@example.com" });
    // imPlaying is deliberately left false — this contact is not one of
    // the players, only entering a team on their behalf.

    expect(
      island.tree().find((e) => propsOf(e).id === "reg-who-dob"),
      "the dob field must not render at all for a non-playing contact",
    ).toBeUndefined();
    expect(
      island.tree().find((e) => propsOf(e).id === "reg-who-gender"),
      "the gender field must not render at all for a non-playing contact",
    ).toBeUndefined();

    clickByText("Next"); // must NOT be blocked by the division's requires_dob/requires_gender
    // Lands on ENTRIES, not DETAILS: a one-division TEAM competition no
    // longer collapses step 2 (RS007 — that step is the only place the team
    // name is typed and the only place "sign up solo" is offered; collapsing
    // it dead-ended the captain at a 422 with no field to answer). What this
    // test actually asserts is unchanged: WHO did not block on the
    // division's requires_dob/requires_gender.
    expect(pageText(), "must have advanced past WHO, not been blocked by requires_dob/requires_gender").toContain(
      "Choose your divisions",
    );
  });
});

// ---------------------------------------------------------------------------
// Finding #6 — the nav row must sit above the cookie banner
// ---------------------------------------------------------------------------
//
// Source contract, same convention as cookie-consent-below-dialogs.test.ts
// (z-index comparisons only mean something as an ACTUAL stacking-context
// pairing — verified once in a real browser via Playwright: the banner's
// `fixed ... z-40` div intercepted the click before this fix, and the click
// landed cleanly after it). Both register-stepper.tsx's nav row and
// cookie-consent.tsx's banner are, transitively, direct children of
// <body> with no position/transform ancestor between them (ConfirmProvider
// is a bare Context.Provider with no wrapping DOM node) — so a plain
// numeric z-index comparison here is a faithful proxy for "wins the paint
// order", not just an isolated number.
function zIndexOf(className: string): number {
  const m = className.match(/\bz-(?:\[)?(\d+)(?:\])?\b/);
  expect(m, `no z-index class in: ${className.slice(0, 120)}`).not.toBeNull();
  return Number(m![1]);
}

describe("the nav row never sits below the cookie banner", () => {
  it("register-stepper's Back/Next row is z-50, strictly above the banner's z-40", () => {
    const stepperSrc = readFileSync(join(__dirname, "..", "register-stepper.tsx"), "utf8");
    const navRowMatch = stepperSrc.match(/className="([^"]*\bjustify-between\b[^"]*)"/);
    expect(navRowMatch, "no Back/Next row class found in register-stepper.tsx").not.toBeNull();
    const navZ = zIndexOf(navRowMatch![1]!);

    const bannerSrc = readFileSync(join(__dirname, "..", "..", "..", "cookie-consent.tsx"), "utf8");
    const bannerMatch = bannerSrc.match(/className="([^"]*\bfixed\b[^"]*)"/);
    expect(bannerMatch, "no fixed banner class found in cookie-consent.tsx").not.toBeNull();
    const bannerZ = zIndexOf(bannerMatch![1]!);

    expect(navZ, `nav row z-${navZ} must be ABOVE the cookie banner z-${bannerZ}`).toBeGreaterThan(bannerZ);
  });
});

// ---------------------------------------------------------------------------
// Review finding #2 (MEDIUM) — focus management across step transitions.
// stepFocusTransition (steps.ts) carries the actual DECISION logic and gets
// real behavioural unit tests in steps.test.ts, no DOM required. This
// workspace has no jsdom, so the DOM-wiring half here (the ref, the effect,
// the `.focus()` call) is pinned at the SOURCE level only — same split
// modal.tsx/modal.test.ts already established for the modal focus trap.
// These are source-level pins, not proof of runtime focus behaviour.
// ---------------------------------------------------------------------------

describe("review finding #2 — step transitions move focus to the new step's heading (source-level pins — no jsdom, see modal.test.ts's own header for the same split)", () => {
  const stepperSrc = readFileSync(join(__dirname, "..", "register-stepper.tsx"), "utf8");

  it("the root element carries the ref the focus effect queries", () => {
    expect(stepperSrc).toMatch(/ref=\{containerRef\}/);
  });

  it("the focus effect is keyed on stepIndex (and hydrated) and calls stepFocusTransition — the pure, unit-tested decision — rather than separate inline logic", () => {
    expect(stepperSrc).toMatch(/stepFocusTransition\(hydrated,\s*stepFocusArmed\.current\)/);
    expect(stepperSrc).toMatch(/\},\s*\[hydrated,\s*stepIndex\]\);/);
  });

  it("only calls .focus() when the decision says to — gated behind decision.focus, never unconditional", () => {
    const effectStart = stepperSrc.indexOf("stepFocusTransition(hydrated");
    expect(effectStart, "stepFocusTransition call not found").toBeGreaterThan(-1);
    const effectBody = stepperSrc.slice(effectStart, effectStart + 400);
    expect(effectBody).toMatch(/if \(decision\.focus\)/);
    expect(effectBody).toMatch(/containerRef\.current\?\.querySelector[\s\S]*\?\.focus\(\)/);
  });

  it.each([
    ["step-who.tsx", "register.section.identity"],
    ["step-entries.tsx", "register.entries.heading"],
    ["step-details.tsx", "register.details.heading"],
    ["step-consent.tsx", "register.section.consent"],
    ["step-review.tsx", "register.review.heading"],
  ])("%s's own step heading is tabIndex={-1} — the actual focus TARGET, not a synthetic wrapper", (file, key) => {
    const src = readFileSync(join(__dirname, "..", file), "utf8");
    const h2Index = src.indexOf("<h2");
    expect(h2Index, `${file} has no <h2>`).toBeGreaterThan(-1);
    const h2TagEnd = src.indexOf(">", h2Index);
    const h2Tag = src.slice(h2Index, h2TagEnd + 1);
    expect(h2Tag, `${file}'s <h2> must carry tabIndex={-1}`).toContain("tabIndex={-1}");
    // Sanity: this IS the step's own heading (the right copy key follows
    // immediately), not some unrelated <h2> earlier in the file.
    expect(src.slice(h2Index, h2Index + 300)).toContain(key);
  });
});

// ---------------------------------------------------------------------------
// FIX 2 (RS006 fix wave, 2026-08-27) — the cart's useState lazy initializer
// used to call crypto.randomUUID() directly (single-open-division auto-
// seed), producing a DIFFERENT entry id on the server pass vs the client's
// first render — the hydration effect's own comment claimed the initial
// state was "deterministic (same on server and first client render)",
// which was false for this one case. No jsdom in this workspace (same
// reason as the focus-transition block above) — pinned at the source
// level: the actual invariant (server and first client render produce
// IDENTICAL state) isn't observable through this harness, only through a
// genuine SSR-vs-CSR comparison — register-page-live.test.tsx's
// renderToStaticMarkup pass and a real browser both already exercise that
// (dispatch verification), and neither's fixture happens to be a
// single-open-division competition, so this source-level pin is the only
// thing in the suite that would have caught this specific defect.
// ---------------------------------------------------------------------------

describe("FIX 2 — the initial cart state is genuinely deterministic (source-level pin — no jsdom, see modal.test.ts's own header for the same split)", () => {
  const stepperSrc = readFileSync(join(__dirname, "..", "register-stepper.tsx"), "utf8");

  it("the cart's useState lazy initializer does not call crypto.randomUUID() — nothing left to differ between the server pass and the client's first render", () => {
    const match = stepperSrc.match(/const \[cart, setCart\] = useState<CartState>\(([\s\S]*?)\);/);
    expect(match, "cart's useState call not found").not.toBeNull();
    expect(match![1], "the initializer itself must not generate an id").not.toMatch(/crypto\.randomUUID/);
  });

  it("the single-open-division auto-seed's crypto.randomUUID() now lives INSIDE the hydration effect (client-only, post-first-paint), not the initializer", () => {
    const effectStart = stepperSrc.indexOf("const saved = loadRegisterState(orgSlug, competitionSlug);");
    expect(effectStart, "hydration effect body not found").toBeGreaterThan(-1);
    const effectEnd = stepperSrc.indexOf("}, []);", effectStart);
    expect(effectEnd, "hydration effect's own closing (empty deps) not found").toBeGreaterThan(-1);
    const effectBody = stepperSrc.slice(effectStart, effectEnd);
    expect(effectBody, "autoSeedSingleDivision's id must be generated inside this effect").toMatch(
      /autoSeedSingleDivision\([^)]*crypto\.randomUUID\(\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// Review finding #3 (LOW) — a long, space-less division name can widen the
// ENTRIES grid track past its share. Tailwind's arbitrary
// `grid-cols-[1fr_320px]` syntax (unlike `grid-cols-N`) does NOT imply
// `minmax(0,1fr)`, so the divisions column's own default `min-width: auto`
// lets a deeply-nested unbreakable string inflate the whole track. No real
// layout engine in this harness (_hook-harness.tsx's own header) — pinned
// at the source level, same technique as the nav-row z-index test above.
// ---------------------------------------------------------------------------

describe("review finding #3 — the divisions column resists a long division name widening the grid track (source-level pins — no layout engine in this harness)", () => {
  it("the grid's divisions-column child (its first child, wrapping register.entries.heading) carries min-w-0", () => {
    const src = readFileSync(join(__dirname, "..", "step-entries.tsx"), "utf8");
    const gridIndex = src.indexOf("lg:grid-cols-[1fr_320px]");
    expect(gridIndex, "grid-cols-[1fr_320px] not found — did the grid column spec change?").toBeGreaterThan(-1);
    const nextClassNameIndex = src.indexOf('className="', gridIndex);
    const nextClassName = src.slice(
      nextClassNameIndex,
      src.indexOf('"', nextClassNameIndex + 'className="'.length),
    );
    expect(nextClassName, "the grid's own divisions-column child must carry min-w-0").toContain("min-w-0");
  });

  it("division-card.tsx's own <h3>{division.name}</h3> can wrap or truncate instead of forcing its row wider", () => {
    const src = readFileSync(join(__dirname, "..", "division-card.tsx"), "utf8");
    const nameIndex = src.indexOf("{division.name}");
    expect(nameIndex, "{division.name} not found in division-card.tsx").toBeGreaterThan(-1);
    const nearby = src.slice(Math.max(0, nameIndex - 300), nameIndex);
    expect(
      /\b(truncate|break-words|break-all)\b/.test(nearby),
      "the division-name heading must wrap or truncate — a long space-less name can otherwise widen its row",
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Finding #4 — a stale-closed division in a restored cart doesn't count
// toward the subtotal
// ---------------------------------------------------------------------------
//
// EntryCart has no hooks of its own besides the mocked (non-hook) useT, so
// it can be called directly as a plain function — no renderIsland needed.

describe("finding #4 — a non-\"full\" closed division in the cart is excluded from the subtotal, with its own note", () => {
  it("a division that closed for a reason OTHER than \"full\" (e.g. its window closed) is excluded from the subtotal and shows a distinct note, not the waitlist one", () => {
    const staleClosed: DivisionLike = {
      division_id: "div-stale",
      name: "Stale Division",
      entrant_kind: "individual",
      category: null,
      age_min: null,
      age_max: null,
      requires_dob: false,
      requires_gender: false,
      allow_free_agents: false,
      open: false,
      closed_reason: "window",
      capacity: null,
      remaining: null,
      taken: 0,
      opens_at: null,
      closes_at: null,
      fee_cents: 1500,
      free_agent_fee_cents: null,
      currency: "gbp",
      payment_method: "offline",
      form_fields: [],
    };
    const cart: CartState = {
      entries: [
        {
          id: "e1",
          division_id: "div-stale",
          entrant_kind: "individual",
          team_name: null,
          partner_name: null,
          free_agent: false,
          players: [],
          answers: {},
          registering_self: false,
          self_player_index: null,
        },
      ],
    };
    const tree = walk(
      EntryCart({
        cart,
        divisions: [staleClosed],
        dispatch: () => {},
        locale: "en",
        contact: EMPTY_CONTACT,
        imPlaying: false,
        seasonStartYear: 2026,
      }),
    );
    const text = textOf(tree);
    // Review finding 2 (2026-08-27): this note now BLOCKS "Next"
    // (validateEntries's staleClosedEntryId), so entry-cart.tsx renders the
    // stronger, action-directed closedBlocking copy here instead of the
    // softer closedNote step-review.tsx's read-only summary still uses.
    expect(text).toContain("This division is no longer open and can't be charged — remove this entry to continue.");
    expect(text).not.toContain("Not charged now — pay only if you're promoted from the waitlist."); // the WAITLIST note — a different case
    expect(text).toContain("Free"); // subtotal excludes the stale fee entirely
    expect(text).not.toMatch(/£15(\.00)?/);
  });
});

// ---------------------------------------------------------------------------
// Finding #8 — a long/UUID division name never overflows the cart line
// ---------------------------------------------------------------------------

describe("finding #8 — an unresolvable division name (raw UUID fallback) never overflows its cart line", () => {
  it("the division-name paragraph truncates rather than wrapping/overflowing", () => {
    const cart: CartState = {
      entries: [
        {
          id: "e1",
          division_id: "00000000-0000-0000-0000-000000000000",
          entrant_kind: "individual",
          team_name: null,
          partner_name: null,
          free_agent: false,
          players: [],
          answers: {},
          registering_self: false,
          self_player_index: null,
        },
      ],
    };
    // No matching division — entryDisplayName falls back to the raw
    // division_id (a 36-char UUID), the exact overflow risk finding #8 flags.
    const tree = walk(
      EntryCart({
        cart,
        divisions: [],
        dispatch: () => {},
        locale: "en",
        contact: EMPTY_CONTACT,
        imPlaying: false,
        seasonStartYear: 2026,
      }),
    );
    const nameP = tree.find((el) => el.type === "p" && textOf(el).includes("00000000-0000"));
    expect(nameP, "division-id fallback paragraph not found").toBeTruthy();
    expect(propsOf(nameP!).className as string).toContain("truncate");
  });
});

// ---------------------------------------------------------------------------
// RS006 §D (known gap) — a free-agent entry has no roster UI to ever
// resolve self_player_index, so the "This is me" checkbox must never render
// for one (cart.ts's SET_ENTRY_SELF/autoLinkObviousSelf refuse the state;
// this is the UI half of the same three-layer defence).
// ---------------------------------------------------------------------------

describe("RS006 §D — a free-agent cart line never offers 'This is me'", () => {
  it("the self checkbox is absent on a free-agent line even while imPlaying is true, and present on an ordinary line in the same cart", () => {
    const cart: CartState = {
      entries: [
        {
          id: "fa1",
          division_id: "div-team",
          entrant_kind: "team",
          team_name: null,
          partner_name: null,
          free_agent: true,
          players: [],
          answers: {},
          registering_self: false,
          self_player_index: null,
        },
        {
          id: "e2",
          division_id: "div-open-2",
          entrant_kind: "individual",
          team_name: null,
          partner_name: null,
          free_agent: false,
          players: [],
          answers: {},
          registering_self: false,
          self_player_index: null,
        },
      ],
    };
    const division: DivisionLike = { ...DIV_OPEN, division_id: "div-team", name: "Open Teams", entrant_kind: "team", allow_free_agents: true };
    const tree = walk(
      EntryCart({
        cart,
        divisions: [division, DIV_OPEN_2],
        dispatch: () => {},
        locale: "en",
        contact: EMPTY_CONTACT,
        imPlaying: true,
        seasonStartYear: 2026,
      }),
    );
    const checkboxes = tree.filter((e) => e.type === "input" && propsOf(e).type === "checkbox");
    expect(checkboxes, "exactly one self checkbox — the free-agent line offers none").toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Item B (coordinator scope expansion) — self-ineligible division cards
// de-emphasize visually, without ever disabling the Add control
// ---------------------------------------------------------------------------
//
// DivisionCard has no hooks of its own besides the mocked (non-hook) useT,
// so — same as EntryCart above — it can be called directly, no renderIsland
// needed.

describe("item B — a self-ineligible division card dims its title/badges but never disables Add", () => {
  const INELIGIBLE_VERDICT = {
    eligible: false,
    issues: [{ code: "CATEGORY_MISMATCH" as const, message: "irrelevant — presentation reads issue.code, not .message" }],
  };

  it("dims the title and the category/age badges, and the card background matches a closed card's", () => {
    const tree = walk(
      DivisionCard({
        division: DIV_WOMENS,
        locale: "en",
        selfEligibility: INELIGIBLE_VERDICT,
        imPlaying: true,
        onAddIndividual: () => {},
      }),
    );

    const title = tree.find((el) => el.type === "h3");
    expect(title, "title not found").toBeTruthy();
    expect(propsOf(title!).className as string).toContain("text-ink-muted");

    const categoryBadge = tree.find((el) => el.type === "span" && textOf(el) === "Women's");
    expect(categoryBadge, "category badge not found").toBeTruthy();
    expect(propsOf(categoryBadge!).className as string).toContain("bg-zinc-100");
    expect(propsOf(categoryBadge!).className as string).not.toContain("bg-accent-soft");

    // Root card div is the first element walk() ever pushes.
    const root = tree[0]!;
    expect(propsOf(root).className as string).toContain("bg-zinc-50");
  });

  it("the Add control is UNCHANGED — no disabled attribute, no pointer-events:none, still calls through", () => {
    let called = false;
    const tree = walk(
      DivisionCard({
        division: DIV_WOMENS,
        locale: "en",
        selfEligibility: INELIGIBLE_VERDICT,
        imPlaying: true,
        onAddIndividual: () => {
          called = true;
        },
      }),
    );
    const addButton = tree.find((el) => el.type === "button" && textOf(el) === "Add an entry");
    expect(addButton, "Add button not found").toBeTruthy();
    expect(propsOf(addButton!).disabled).not.toBe(true);
    expect(propsOf(addButton!).className as string).not.toContain("pointer-events-none");
    (propsOf(addButton!).onClick as () => void)();
    expect(called, "Add control's onClick must still fire").toBe(true);
  });

  it("stays at FULL visual weight when the contact IS eligible (or hasn't said they're playing) — regression guard", () => {
    const eligibleTree = walk(
      DivisionCard({
        division: DIV_WOMENS,
        locale: "en",
        selfEligibility: { eligible: true, issues: [] },
        imPlaying: true,
        onAddIndividual: () => {},
      }),
    );
    expect(propsOf(eligibleTree.find((el) => el.type === "h3")!).className as string).toContain("text-ink");
    expect(propsOf(eligibleTree.find((el) => el.type === "h3")!).className as string).not.toContain("text-ink-muted");

    const notPlayingTree = walk(
      DivisionCard({
        division: DIV_WOMENS,
        locale: "en",
        selfEligibility: null,
        imPlaying: false,
        onAddIndividual: () => {},
      }),
    );
    expect(propsOf(notPlayingTree.find((el) => el.type === "h3")!).className as string).not.toContain("text-ink-muted");
  });
});

// ---------------------------------------------------------------------------
// Step 3 (DETAILS) — roster building, the mixed-composition meter,
// per-row eligibility, pasted rosters. RS006 W3.
// ---------------------------------------------------------------------------

const DIV_MIXED_TEAM: DivisionLike = {
  ...DIV_OPEN,
  division_id: "div-mixed",
  name: "Mixed Doubles",
  entrant_kind: "team",
  category: "mixed",
  requires_gender: true,
};

const DIV_AGE_BANDED_TEAM: DivisionLike = {
  ...DIV_OPEN,
  division_id: "div-age",
  name: "Adults League",
  entrant_kind: "team",
  age_min: 18,
  requires_dob: true,
};

const DIV_TEAM: DivisionLike = {
  ...DIV_OPEN,
  division_id: "div-team",
  name: "Open Teams",
  entrant_kind: "team",
};

/** Fires onChange on the first native input/select whose aria-label
 *  matches — RosterTable's own accessible-name convention
 *  (`${rowLabel} — ${fieldLabel}`) doubles as this locator, so a broken
 *  match here is also a real a11y regression, not just a stale selector. */
function setByAriaLabel(island: ReturnType<typeof mount>["island"], label: string, value: string) {
  const el = island.tree().find((e) => propsOf(e)["aria-label"] === label);
  expect(el, `no field with aria-label "${label}"`).toBeTruthy();
  (propsOf(el!).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
}

/** RosterTable's aria-label ("Player {n} — {field}") is scoped WITHIN one
 *  entry's own roster, not globally unique — a cart with two individual
 *  entries has two "Player 1 — Your name" fields. `.filter()` preserves
 *  tree order (walk() is depth-first, and StepDetails renders one entry's
 *  whole subtree before the next), so index 0/1/… lines up with cart.entries
 *  order. */
function allByAriaLabel(island: ReturnType<typeof mount>["island"], label: string) {
  return island.tree().filter((e) => propsOf(e)["aria-label"] === label);
}

/** Always exactly 10 years old relative to whenever the suite actually
 *  runs — a hardcoded dob would go stale the day it turns 18. Used by the
 *  guardian-block tests below; every OTHER dob fixture in this file is a
 *  fixed adult date (e.g. "1990-01-01"), which never goes stale in the
 *  other direction. */
function minorDob(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 10);
  return d.toISOString().slice(0, 10);
}

/** Finds an <input>/<select> by its `id` — step-consent.tsx/step-who.tsx's
 *  own convention (mirrors WHO step fields, `id="reg-who-name"` etc.),
 *  distinct from RosterTable's per-row aria-label scheme above. */
function byId(island: ReturnType<typeof mount>["island"], id: string) {
  const el = island.tree().find((e) => propsOf(e).id === id);
  expect(el, `no field with id "${id}"`).toBeTruthy();
  return el!;
}

describe("step 3 — the mixed-composition meter blocks an all-male roster and clears once fixed", () => {
  it("shows the unmet sentence, blocks Next; adding a female player clears both and unblocks", () => {
    const { island, stepWho, divisionCard, clickByText, pageText } = mount([DIV_OPEN, DIV_MIXED_TEAM]);

    // gender is supplied defensively even though this contact never
    // self-links (so whoFieldRequirements no longer requires it here —
    // review finding 3, 2026-08-27) — harmless, and keeps this fixture
    // realistic without depending on that gate either way.
    (propsOf(stepWho()).onChange as (p: object) => void)({
      name: "Alex Test",
      email: "alex@example.com",
      gender: "m",
    });
    clickByText("Next"); // -> ENTRIES

    (propsOf(divisionCard("div-mixed")).onAddTeam as () => void)();
    // A team entry must be NAMED to leave this step (RS007): the server
    // 422s a nameless team, and the client now says so here rather than at
    // submit. Not what these tests are about -- name it and move on.
    setByAriaLabel(island, "Team name", "Test Team");
    clickByText("Next"); // -> DETAILS

    clickByText("+ Add player");
    clickByText("+ Add player");

    setByAriaLabel(island, "Player 1 — Your name", "Sam A");
    setByAriaLabel(island, "Player 1 — Gender", "m");
    setByAriaLabel(island, "Player 2 — Your name", "Sam B");
    setByAriaLabel(island, "Player 2 — Gender", "m");

    // The meter is LIVE (not gated behind "attempted") — same precedent as
    // step 2's self-ineligibility notices.
    expect(pageText()).toContain("Needs at least one male and one female player on the roster.");

    clickByText("Next"); // attempt to advance — must be BLOCKED
    expect(pageText()).toContain("Fill in the missing details above before continuing");
    expect(pageText(), "must NOT have reached the end-cap").not.toContain("More steps on the way");

    // Fix the roster: Player 2 becomes female — the SAME cart now unblocks.
    setByAriaLabel(island, "Player 2 — Gender", "f");
    expect(pageText()).toContain("Mixed roster requirement met");
    expect(pageText()).not.toContain("Needs at least one male and one female player on the roster.");
    expect(pageText()).not.toContain("Fill in the missing details above before continuing");

    clickByText("Next"); // now advances onto CONSENT (step 4)
    expect(pageText()).toContain("Consent");
  });
});

describe("step 3 — an underage player is named BY ROW, not just anywhere on the page", () => {
  it("the age-ineligibility notice attaches to the underage row only, never the adult row", () => {
    const { island, stepWho, divisionCard, clickByText, pageText } = mount([DIV_OPEN, DIV_AGE_BANDED_TEAM]);

    // dob is supplied defensively even though this contact never
    // self-links (so whoFieldRequirements no longer requires it here —
    // review finding 3, 2026-08-27) — harmless, and keeps this fixture
    // realistic without depending on that gate either way.
    (propsOf(stepWho()).onChange as (p: object) => void)({
      name: "Alex Test",
      email: "alex@example.com",
      dob: "1985-06-15",
    });
    clickByText("Next"); // -> ENTRIES
    (propsOf(divisionCard("div-age")).onAddTeam as () => void)();
    // A team entry must be NAMED to leave this step (RS007): the server
    // 422s a nameless team, and the client now says so here rather than at
    // submit. Not what these tests are about -- name it and move on.
    setByAriaLabel(island, "Team name", "Test Team");
    clickByText("Next"); // -> DETAILS

    clickByText("+ Add player");
    clickByText("+ Add player");

    setByAriaLabel(island, "Player 1 — Your name", "Adult Player");
    setByAriaLabel(island, "Player 1 — Date of birth", "1990-01-01");
    setByAriaLabel(island, "Player 2 — Your name", "Young Player");
    setByAriaLabel(island, "Player 2 — Date of birth", "2020-01-01");

    // Scoped: slice the flat tree to JUST row 1 (the adult) — walk() is
    // depth-first and contiguous per subtree, so everything between row 1's
    // <li> and row 2's <li> IS row 1's own rendered output, nothing else's
    // (same "scope to the component's own output" discipline entryCartText
    // above uses, for the same reason: a page-wide search would pass even
    // if the issue attached to the WRONG row). row1Slice is TIGHTLY bounded
    // on both ends; row2Slice is bounded only from the front (there is no
    // row 3 to close it against) — that's fine for a POSITIVE check (a
    // false positive there would need the phrase to leak from somewhere
    // downstream that isn't a roster row at all, which the source doesn't
    // do), paired with row1Slice's tight NEGATIVE check above it.
    const tree = island.tree();
    const rows = tree.filter((e) => e.type === "li");
    expect(rows, "expected exactly 2 roster rows").toHaveLength(2);
    const row2Index = tree.indexOf(rows[1]!);
    const row1Slice = tree.slice(tree.indexOf(rows[0]!), row2Index);
    const row2Slice = tree.slice(row2Index);
    expect(
      textOf(row1Slice as unknown as ReactNode),
      "the ADULT row must not carry the age issue",
    ).not.toContain("Outside this division's age range");
    expect(
      textOf(row2Slice as unknown as ReactNode),
      "the YOUNG row must carry the age issue",
    ).toContain("Outside this division's age range");

    clickByText("Next"); // structurally blocked (the young player's age issue)
    expect(pageText()).toContain("Fill in the missing details above before continuing");
  });
});

describe("step 3 — pasting a roster via the textarea parses into named rows (parseRoster)", () => {
  it("parses pasted text into roster rows with the right names/squad numbers, and clears the draft", () => {
    const { island, stepWho, divisionCard, clickByText } = mount([DIV_OPEN, DIV_TEAM]);

    (propsOf(stepWho()).onChange as (p: object) => void)({ name: "Alex Test", email: "alex@example.com" });
    clickByText("Next"); // -> ENTRIES
    (propsOf(divisionCard("div-team")).onAddTeam as () => void)();
    // A team entry must be NAMED to leave this step (RS007): the server
    // 422s a nameless team, and the client now says so here rather than at
    // submit. Not what these tests are about -- name it and move on.
    setByAriaLabel(island, "Team name", "Test Team");
    clickByText("Next"); // -> DETAILS

    const textarea = island.tree().find((e) => e.type === "textarea");
    expect(textarea, "no paste textarea found").toBeTruthy();
    (propsOf(textarea!).onChange as (e: { target: { value: string } }) => void)({
      target: { value: "Jordan Blake, 7\nSam Ortiz, 10, 2004-11-30" },
    });

    const importButtonText = tRuntime(EN_UI, "register.details.roster.import.button", { n: 2 });
    clickByText(importButtonText);

    // Values live on the controlled inputs, not as rendered text (textOf()
    // never sees an <input>'s value — it has no `children`), so assert on
    // the actual input elements, not pageText().
    const row1Name = island.tree().find((e) => propsOf(e)["aria-label"] === "Player 1 — Your name");
    const row2Name = island.tree().find((e) => propsOf(e)["aria-label"] === "Player 2 — Your name");
    expect(propsOf(row1Name!).value).toBe("Jordan Blake");
    expect(propsOf(row2Name!).value).toBe("Sam Ortiz");

    const row1Squad = island.tree().find((e) => propsOf(e)["aria-label"] === "Player 1 — Squad #");
    expect(propsOf(row1Squad!).value).toBe("7");

    // The draft clears after a successful import.
    const clearedTextarea = island.tree().find((e) => e.type === "textarea");
    expect(propsOf(clearedTextarea!).value).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Second review round, finding 1 (2026-08-27) — effectiveSelfPlayers must
// resolve an INDIVIDUAL entry's implied self row: self_player_index stays
// null FOREVER for that kind (entry-details.tsx's self-row picker never
// renders for it — showSelfPicker), so the "collected once" dob/gender
// merge must happen without an explicit index, mirroring effectiveSelfDob's
// own individual-implies-0 fallback (roster.ts).
// ---------------------------------------------------------------------------

describe("2026-08-27 review finding 1 — a self-linked INDIVIDUAL entry's already-collected contact dob must satisfy a requires_dob division", () => {
  // age_min (not just requires_dob) is what actually makes
  // ageBandEligibilityIssues (registration-rules.ts) evaluate a dob at
  // all — same reasoning DIV_AGE_BANDED_TEAM below documents. 18 is
  // comfortably under the "1990-01-01" contact dob this test fills in, so
  // the only way this could fail is the MISSING_DOB false positive itself,
  // never a genuine age rejection.
  const DIV_SOLO_REQUIRES_DOB: DivisionLike = { ...DIV_OPEN, division_id: "div-solo-req-dob", requires_dob: true, age_min: 18 };

  it("ticking 'I'm playing', filling contact dob, then adding an individual entry: no false MISSING_DOB, Next reaches CONSENT", () => {
    const { stepWho, clickByText, pageText, island } = mount([DIV_SOLO_REQUIRES_DOB]);
    (propsOf(stepWho()).onChange as (p: object) => void)({ name: "Self Row", email: "self@example.com", dob: "1990-01-01" });
    (propsOf(stepWho()).onImPlayingChange as (v: boolean) => void)(true); // auto-links the sole entry
    clickByText("Next"); // single open division collapses ENTRIES -> DETAILS
    setByAriaLabel(island, "Player 1 — Your name", "Self Row");
    // Deliberately NOT typing a dob into the roster row itself — the whole
    // point is that the WHO-step contact.dob already collected above must
    // satisfy this individual division's requires_dob via
    // effectiveSelfPlayers' implied-index-0 resolution (roster.ts).
    expect(
      pageText(),
      "no false MISSING_DOB for the self-linked individual row — contact.dob was already collected",
    ).not.toContain("Enter this player's date of birth to check eligibility");

    clickByText("Next"); // must actually ADVANCE to CONSENT, not silently no-op on DETAILS
    expect(pageText(), "Next must not be blocked").toContain("Consent");
  });
});

// ---------------------------------------------------------------------------
// Review finding #1 (MEDIUM) — form_fields DOM ids must be scoped per cart
// entry. Two cart entries on the SAME division is normal and unrestricted
// (e.g. two teams in one "Open" division); form-fields.tsx used to build
// `reg-field-${f.key}` with no per-entry scope, so BOTH entries' identical
// question rendered the SAME id twice. `label[for]` then resolves to
// whichever one is FIRST in the DOM, so clicking the second entry's label
// focuses the FIRST entry's input.
// ---------------------------------------------------------------------------

describe("review finding #1 — form_fields ids are scoped per cart entry", () => {
  it("two entries on the SAME division render DISTINCT field ids for the same question", () => {
    const FIELDS: FormFieldDef[] = [{ key: "shirt_size", label: "Shirt size", kind: "text", required: false }];
    const DIV_FIELDS: DivisionLike = { ...DIV_OPEN, division_id: "div-fields", name: "Fielded Division", form_fields: FIELDS };
    const { stepWho, divisionCard, clickByText, island } = mount([DIV_FIELDS, DIV_OPEN_2]);

    (propsOf(stepWho()).onChange as (p: object) => void)({ name: "Alex Test", email: "alex@example.com" });
    clickByText("Next"); // -> ENTRIES

    // Two SEPARATE entries, same division — the normal, unrestricted case
    // the finding calls out (no per-division cap in cart.ts's canAddEntry).
    (propsOf(divisionCard("div-fields")).onAddIndividual as () => void)();
    (propsOf(divisionCard("div-fields")).onAddIndividual as () => void)();

    clickByText("Next"); // -> DETAILS

    const fieldInputs = island
      .tree()
      .filter(
        (e) =>
          (e.type === "input" || e.type === "select") &&
          typeof propsOf(e).id === "string" &&
          (propsOf(e).id as string).startsWith("reg-field-"),
      );
    expect(fieldInputs, "one text field per entry, two entries").toHaveLength(2);

    const ids = fieldInputs.map((e) => propsOf(e).id as string);
    expect(
      new Set(ids).size,
      "field ids must be DISTINCT across entries — a shared id makes label[for] resolve to the WRONG entry's input",
    ).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// Second review round, finding 2 (2026-08-27) — a STALE-closed division
// (closed_reason set to anything other than "full", since the entry was
// added) must block "Next" at ENTRIES, attributed to the entry that's
// blocking it, with a way to remove it and continue. Mirrors the existing
// "full" (waitlist) DIV_WAITLIST fixture below (step 5) in staying
// `open: true` with only `closed_reason` set — DivisionCard's "Add"
// control is gated on `open`, not on `closed_reason`, so a stale-closed
// division is still addable through the ordinary flow, same as a
// waitlisted one; the difference this finding fixes is entirely in
// whether "Next" then lets you past it.
// ---------------------------------------------------------------------------

describe("2026-08-27 review finding 2 — a stale-closed division blocks Next at ENTRIES, attributed to the entry, with Remove as the way out", () => {
  it("adding an entry to a division that has gone stale-closed blocks Next with a live per-entry note; removing that entry unblocks it", () => {
    const DIV_STALE_CLOSED: DivisionLike = {
      ...DIV_OPEN,
      division_id: "div-stale",
      name: "Recently Closed",
      closed_reason: "window",
    };
    const { stepWho, divisionCard, clickByText, pageText, entryCartText, entryCartCart } = mount([
      DIV_OPEN,
      DIV_STALE_CLOSED,
    ]);
    (propsOf(stepWho()).onChange as (p: object) => void)({ name: "Rep", email: "rep@example.com" });
    clickByText("Next"); // -> ENTRIES (2 open divisions — not collapsed)

    (propsOf(divisionCard("div-stale")).onAddIndividual as () => void)();

    // The note is LIVE (not gated behind "attempted") — same precedent as
    // step 2's self-ineligibility notices — and names the actual blocking
    // reason, distinct from the softer (non-blocking) waitlist note.
    expect(entryCartText()).toContain(
      "This division is no longer open and can't be charged — remove this entry to continue.",
    );

    clickByText("Next"); // must NOT advance — the stale-closed entry blocks the WHOLE cart
    // Still on ENTRIES: entryCartCart() itself asserts EntryCart is in the
    // tree, so a silent advance to DETAILS would fail HERE, not just below.
    const staleEntryId = entryCartCart().entries[0]!.id;

    clickByText("Remove"); // the SAME per-entry control every cart line already has
    expect(entryCartCart().entries.map((e) => e.id), "the stale-closed entry is gone").not.toContain(staleEntryId);

    (propsOf(divisionCard("div-open")).onAddIndividual as () => void)();
    clickByText("Next"); // now unblocked — nothing stale-closed left in the cart
    expect(pageText(), "must have reached DETAILS (single-division-shaped roster UI)").toContain("Player details");
  });
});

// ---------------------------------------------------------------------------
// Step 4 — CONSENT
// ---------------------------------------------------------------------------

/** Individual + requires_dob — needed for the guardian-bypass regression
 *  test below: RosterTable only renders a row's dob <input> at all when
 *  `requiresDob` is true (roster-table.tsx:116), so proving the self row's
 *  OWN dob can override an adult contact.dob needs a division that actually
 *  shows that input. No age band (age_min/age_max stay null, inherited from
 *  DIV_OPEN) — isolates the guardian gate from age-eligibility rejection. */
const DIV_REQUIRES_DOB: DivisionLike = {
  ...DIV_OPEN,
  division_id: "div-req-dob",
  name: "Age-Checked Singles",
  requires_dob: true,
};

describe("step 4 — CONSENT", () => {
  it("privacy consent is required to advance; media consent stays optional", () => {
    const { stepWho, clickByText, pageText, island } = mount([DIV_OPEN]);
    (propsOf(stepWho()).onChange as (p: object) => void)({ name: "Alex Test", email: "alex@example.com" });
    clickByText("Next"); // single open division collapses ENTRIES -> DETAILS
    setByAriaLabel(island, "Player 1 — Your name", "Alex Test");
    clickByText("Next"); // -> CONSENT

    clickByText("Next"); // attempt to advance with no consent given — BLOCKED
    expect(pageText()).toContain("Agree to the Privacy Policy to continue");

    (propsOf(byId(island, "reg-consent-privacy")).onChange as (e: { target: { checked: boolean } }) => void)({
      target: { checked: true },
    });

    clickByText("Next"); // media consent never touched — must NOT block
    expect(pageText()).toContain("Review & pay");
  });

  it("states owner ruling 5 plainly, at the moment of consent", () => {
    const { stepWho, clickByText, pageText, island } = mount([DIV_OPEN]);
    (propsOf(stepWho()).onChange as (p: object) => void)({ name: "Alex Test", email: "alex@example.com" });
    clickByText("Next"); // -> DETAILS
    setByAriaLabel(island, "Player 1 — Your name", "Alex Test");
    clickByText("Next"); // -> CONSENT
    expect(pageText()).toContain(
      "By default, your name appears publicly on this event's pages. You can switch to showing initials any time from your profile.",
    );
  });

  it("the guardian block appears only for a self-registering minor, and blocks Next until both fields are given", () => {
    const { stepWho, clickByText, pageText, island } = mount([DIV_OPEN]);
    (propsOf(stepWho()).onChange as (p: object) => void)({ name: "Young Player", email: "young@example.com", dob: minorDob() });
    (propsOf(stepWho()).onImPlayingChange as (v: boolean) => void)(true); // auto-links the sole entry
    clickByText("Next"); // -> DETAILS
    setByAriaLabel(island, "Player 1 — Your name", "Young Player");
    clickByText("Next"); // -> CONSENT

    expect(pageText()).toContain("Under-18 entry — guardian consent");

    (propsOf(byId(island, "reg-consent-privacy")).onChange as (e: { target: { checked: boolean } }) => void)({
      target: { checked: true },
    });
    clickByText("Next"); // privacy given, guardian info still missing — BLOCKED
    expect(pageText()).toContain("Enter the guardian's name");
    expect(pageText()).toContain("Guardian consent is required");

    (propsOf(byId(island, "reg-guardian-name")).onChange as (e: { target: { value: string } }) => void)({
      target: { value: "Pat Guardian" },
    });
    clickByText("Next"); // name given, consent checkbox still missing — STILL BLOCKED
    expect(pageText()).toContain("Guardian consent is required");
    expect(pageText()).not.toContain("Enter the guardian's name");

    (propsOf(byId(island, "reg-guardian-consent")).onChange as (e: { target: { checked: boolean } }) => void)({
      target: { checked: true },
    });
    clickByText("Next"); // both given — unblocked
    expect(pageText()).toContain("Review & pay");
  });

  it("never shows the guardian block for an adult contact, even when self-registering", () => {
    const { stepWho, clickByText, pageText, island } = mount([DIV_OPEN]);
    (propsOf(stepWho()).onChange as (p: object) => void)({ name: "Adult Player", email: "adult@example.com", dob: "1990-01-01" });
    (propsOf(stepWho()).onImPlayingChange as (v: boolean) => void)(true);
    clickByText("Next"); // -> DETAILS
    setByAriaLabel(island, "Player 1 — Your name", "Adult Player");
    clickByText("Next"); // -> CONSENT
    expect(pageText()).not.toContain("Under-18 entry — guardian consent");
  });

  it("guardian consent bypass fix: the block appears (and blocks Next) when an ADULT contact self-links a roster row carrying a MINOR dob", () => {
    const { stepWho, clickByText, pageText, island } = mount([DIV_REQUIRES_DOB]);
    (propsOf(stepWho()).onChange as (p: object) => void)({ name: "Self Row", email: "self@example.com", dob: "1990-01-01" });
    (propsOf(stepWho()).onImPlayingChange as (v: boolean) => void)(true); // auto-links the sole entry
    clickByText("Next"); // -> DETAILS
    setByAriaLabel(island, "Player 1 — Your name", "Self Row");
    // The roster row's OWN dob — not contact.dob — is what a real registrant
    // types here. No readOnly/disabled on this input (roster-table.tsx),
    // even though this IS the self-linked row.
    setByAriaLabel(island, "Player 1 — Date of birth", minorDob());
    clickByText("Next"); // -> CONSENT (structurally complete; no age band on this division)

    expect(
      pageText(),
      "guardian block must show — the self row is a minor even though contact.dob is an adult",
    ).toContain("Under-18 entry — guardian consent");

    (propsOf(byId(island, "reg-consent-privacy")).onChange as (e: { target: { checked: boolean } }) => void)({
      target: { checked: true },
    });
    clickByText("Next"); // privacy given, guardian info still missing — must stay BLOCKED
    expect(pageText(), "must not advance without guardian consent").not.toContain("Review & pay");
    expect(pageText()).toContain("Guardian consent is required");
  });

  it("the captain-roster notice appears when the cart names other people", () => {
    const { stepWho, divisionCard, clickByText, pageText, island } = mount([DIV_OPEN, DIV_TEAM]);
    (propsOf(stepWho()).onChange as (p: object) => void)({ name: "Rep", email: "rep@example.com" });
    clickByText("Next"); // -> ENTRIES (2 open divisions — not collapsed)
    (propsOf(divisionCard("div-team")).onAddTeam as () => void)();
    // A team entry must be NAMED to leave this step (RS007): the server
    // 422s a nameless team, and the client now says so here rather than at
    // submit. Not what these tests are about -- name it and move on.
    setByAriaLabel(island, "Team name", "Test Team");
    clickByText("Next"); // -> DETAILS
    clickByText("+ Add player");
    clickByText("+ Add player");
    setByAriaLabel(island, "Player 1 — Your name", "Sam");
    setByAriaLabel(island, "Player 2 — Your name", "Jordan");
    clickByText("Next"); // -> CONSENT
    expect(pageText()).toContain(
      "You're entering other people in this registration. We'll ask each of them to confirm their own details and consent when they join or claim their spot.",
    );
  });

  it("the captain-roster notice is ABSENT when the only player is the self-linked contact", () => {
    const { stepWho, clickByText, pageText, island } = mount([DIV_OPEN]);
    // dob is REQUIRED the moment imPlaying flips true (whoFieldRequirements),
    // independent of DIV_OPEN's own requires_dob — omitting it would leave
    // WHO's "Next" silently blocked and every step after it unreachable.
    (propsOf(stepWho()).onChange as (p: object) => void)({ name: "Solo Player", email: "solo@example.com", dob: "1990-01-01" });
    (propsOf(stepWho()).onImPlayingChange as (v: boolean) => void)(true); // auto-links the sole entry
    clickByText("Next"); // -> DETAILS
    setByAriaLabel(island, "Player 1 — Your name", "Solo Player");
    clickByText("Next"); // -> CONSENT
    expect(pageText()).not.toContain("You're entering other people in this registration.");
  });
});

// ---------------------------------------------------------------------------
// Step 5 — REVIEW→PAY
// ---------------------------------------------------------------------------

const DIV_PAID: DivisionLike = {
  ...DIV_OPEN,
  division_id: "div-paid",
  name: "Paid Singles",
  fee_cents: 2500,
  free_agent_fee_cents: null,
  currency: "gbp",
  payment_method: "stripe",
};

const DIV_WAITLIST: DivisionLike = {
  ...DIV_OPEN,
  division_id: "div-wait",
  name: "Full Division",
  closed_reason: "full",
  fee_cents: 1000,
  free_agent_fee_cents: null,
  currency: "gbp",
};

describe("step 5 — REVIEW→PAY line items", () => {
  it("shows the fee per entry; a waitlisted entry is flagged 'not charged now' and excluded from the subtotal", () => {
    const { stepWho, divisionCard, clickByText, pageText, island } = mount([DIV_PAID, DIV_WAITLIST]);
    (propsOf(stepWho()).onChange as (p: object) => void)({ name: "Rep", email: "rep@example.com" });
    clickByText("Next"); // -> ENTRIES
    (propsOf(divisionCard("div-paid")).onAddIndividual as () => void)();
    (propsOf(divisionCard("div-wait")).onAddIndividual as () => void)();
    clickByText("Next"); // -> DETAILS

    const nameInputs = allByAriaLabel(island, "Player 1 — Your name");
    expect(nameInputs, "expected one 'Player 1' row per entry").toHaveLength(2);
    (propsOf(nameInputs[0]!).onChange as (e: { target: { value: string } }) => void)({ target: { value: "Player One" } });
    (propsOf(nameInputs[1]!).onChange as (e: { target: { value: string } }) => void)({ target: { value: "Player Two" } });
    clickByText("Next"); // -> CONSENT
    (propsOf(byId(island, "reg-consent-privacy")).onChange as (e: { target: { checked: boolean } }) => void)({
      target: { checked: true },
    });
    clickByText("Next"); // -> REVIEW

    const text = pageText();
    expect(text).toContain("Review & pay");
    expect(text).toContain("Paid Singles");
    expect(text).toContain("Full Division");
    expect(text).toContain("Not charged now — pay only if you're promoted from the waitlist.");
    // Subtotal is the PAID division's £25 alone — the waitlisted £10 never joins it.
    expect(text).toMatch(/£25(\.00)?/);
    expect(text).not.toMatch(/£35(\.00)?/);
  });
});

describe("step 5 — submit", () => {
  /** Drives a single free (DIV_OPEN) cart from WHO through CONSENT, landing
   *  on REVIEW with privacy consent already given — the shared setup every
   *  submit test below starts from. */
  async function reachReview() {
    const m = mount([DIV_OPEN]);
    (propsOf(m.stepWho()).onChange as (p: object) => void)({ name: "Alex Test", email: "alex@example.com" });
    m.clickByText("Next"); // -> DETAILS
    setByAriaLabel(m.island, "Player 1 — Your name", "Alex Test");
    m.clickByText("Next"); // -> CONSENT
    (propsOf(byId(m.island, "reg-consent-privacy")).onChange as (e: { target: { checked: boolean } }) => void)({
      target: { checked: true },
    });
    m.clickByText("Next"); // -> REVIEW
    return m;
  }

  it("posts the built request body and redirects to the group status page (by rid+token) when checkout_url is null", async () => {
    apiV1Mock.impl.mockResolvedValueOnce({
      group_id: "g1",
      ref_code: "SZ-TEST-01",
      access_token: "tok123",
      currency: "gbp",
      amount_cents: 0,
      checkout_url: null,
      entries: [],
    });
    const { pageText, island } = await reachReview();
    expect(pageText()).toContain("Enter the competition"); // register.submit.free — DIV_OPEN is fee_cents:0

    const btn = island.tree().find((e) => e.type === "button" && textOf(e) === "Enter the competition");
    expect(btn, "submit button not found").toBeTruthy();
    await (propsOf(btn!).onClick as () => Promise<void>)();

    expect(apiV1Mock.impl).toHaveBeenCalledTimes(1);
    const [url, options] = apiV1Mock.impl.mock.calls[0]!;
    expect(url).toBe(`/api/v1/public/orgs/${ORG_SLUG}/competitions/${COMPETITION_SLUG}/register`);
    expect((options as { method: string }).method).toBe("POST");
    expect((options as { json: { privacy_consent: boolean; contact: { name: string } } }).json.privacy_consent).toBe(true);
    expect((options as { json: { contact: { name: string } } }).json.contact.name).toBe("Alex Test");

    expect(assignMock).toHaveBeenCalledWith(
      `/shared/${ORG_SLUG}/${COMPETITION_SLUG}/register/status?rid=g1&token=tok123`,
    );
  });

  it("redirects straight to Stripe checkout when checkout_url is present, never the status page", async () => {
    apiV1Mock.impl.mockResolvedValueOnce({
      group_id: "g1",
      ref_code: "SZ-TEST-02",
      access_token: "tok456",
      currency: "gbp",
      amount_cents: 2500,
      checkout_url: "https://checkout.stripe.com/pay/xyz",
      entries: [],
    });
    const { island } = await reachReview();
    const btn = island.tree().find((e) => e.type === "button" && textOf(e) === "Enter the competition");
    await (propsOf(btn!).onClick as () => Promise<void>)();
    expect(assignMock).toHaveBeenCalledWith("https://checkout.stripe.com/pay/xyz");
    expect(assignMock).not.toHaveBeenCalledWith(expect.stringContaining("/register/status"));
  });

  // FIX 3 (RS006 fix wave) — a failed submit used to render `err.message`
  // verbatim as the ONLY thing the registrant saw (the honeypot's 400, or a
  // 409 from a concurrent checkout-mint race, included) — a bare,
  // English-only server string with no distinction between "retry the
  // exact same click" and "something about THIS submission needs to
  // change." `submitError` is now `{ kind, detail }`: `kind` (classifySubmitFailure,
  // submit.ts) picks which LOCALIZED message is PRIMARY, `detail` is the
  // raw server string, still shown, but only ever as SECONDARY text.
  //
  // `alertBlock()` reads the role="alert" element's own two `<p>` children
  // directly via `.children` (not a page-wide text search) — the ENTRIES/
  // DETAILS steps have their OWN role="alert" blocks, but neither is
  // mounted here (only one step renders at a time, and these tests never
  // leave REVIEW), so this is unambiguous.
  function alertBlock(island: ReturnType<typeof mount>["island"]) {
    const el = island.tree().find((e) => propsOf(e).role === "alert");
    expect(el, "no role=alert error block found").toBeTruthy();
    const children = propsOf(el!).children as ReactElement[];
    expect(children, "expected exactly 2 children — primary + secondary detail").toHaveLength(2);
    return { primary: children[0]!, secondary: children[1]! };
  }

  it("a RETRYABLE failure (no HTTP status — e.g. a dropped connection) shows the retry-bucket message as PRIMARY, the raw detail only as secondary, and re-enables the button rather than leaving it stuck", async () => {
    apiV1Mock.impl.mockRejectedValueOnce(new Error("Registration is not open for this division"));
    const { island } = await reachReview();
    const btn = island.tree().find((e) => e.type === "button" && textOf(e) === "Enter the competition");
    await (propsOf(btn!).onClick as () => Promise<void>)();

    const { primary, secondary } = alertBlock(island);
    expect(textOf(primary), "PRIMARY must be the localized retry copy, never the raw server string").toBe(
      "Something went wrong — please try again.",
    );
    expect(textOf(secondary), "the raw detail is still shown, but only as secondary text").toBe(
      "Registration is not open for this division",
    );

    const btnAfter = island.tree().find((e) => e.type === "button" && textOf(e) === "Enter the competition");
    expect(propsOf(btnAfter!).disabled, "button must not be stuck disabled after a failure").not.toBe(true);
    expect(assignMock, "must never navigate away on a failed submit").not.toHaveBeenCalled();
  });

  it("a REJECTED failure (400, e.g. the honeypot) shows the DIFFERENT rejected-bucket message, not the retry one", async () => {
    apiV1Mock.impl.mockRejectedValueOnce(new ApiV1Error("Registration failed", 400, "UNKNOWN"));
    const { island } = await reachReview();
    const btn = island.tree().find((e) => e.type === "button" && textOf(e) === "Enter the competition");
    await (propsOf(btn!).onClick as () => Promise<void>)();

    const { primary, secondary } = alertBlock(island);
    expect(textOf(primary)).toBe(
      "We couldn't submit your registration — check your details and try again, or contact the organiser.",
    );
    expect(textOf(secondary)).toBe("Registration failed");
  });

  it("a CONFLICT failure (409 — a concurrent checkout-mint race) shows the retry-bucket message, not the rejected one", async () => {
    apiV1Mock.impl.mockRejectedValueOnce(
      new ApiV1Error(
        "Another checkout was just started for this registration — please refresh and try again",
        409,
        "REGISTRATION_CHECKOUT_CONFLICT",
      ),
    );
    const { island } = await reachReview();
    const btn = island.tree().find((e) => e.type === "button" && textOf(e) === "Enter the competition");
    await (propsOf(btn!).onClick as () => Promise<void>)();

    const { primary } = alertBlock(island);
    expect(textOf(primary)).toBe("Something went wrong — please try again.");
  });

  it("retrying after a failure resubmits the SAME contact/cart — nothing typed across all five steps is lost", async () => {
    apiV1Mock.impl.mockRejectedValueOnce(new Error("temporary failure"));
    apiV1Mock.impl.mockResolvedValueOnce({
      group_id: "g2",
      ref_code: "SZ-TEST-03",
      access_token: "tok789",
      currency: "gbp",
      amount_cents: 0,
      checkout_url: null,
      entries: [],
    });
    const { island } = await reachReview();
    const btn = () => island.tree().find((e) => e.type === "button" && textOf(e) === "Enter the competition")!;

    await (propsOf(btn()).onClick as () => Promise<void>)(); // fails
    await (propsOf(btn()).onClick as () => Promise<void>)(); // retry, same button, re-enabled

    expect(apiV1Mock.impl).toHaveBeenCalledTimes(2);
    const firstJson = (apiV1Mock.impl.mock.calls[0]![1] as { json: unknown }).json;
    const secondJson = (apiV1Mock.impl.mock.calls[1]![1] as { json: unknown }).json;
    expect(secondJson, "identical resubmission — the failed attempt cleared nothing").toEqual(firstJson);
    expect(assignMock).toHaveBeenCalledWith(
      `/shared/${ORG_SLUG}/${COMPETITION_SLUG}/register/status?rid=g2&token=tok789`,
    );
  });

  // Bench hook (B03r) — the public stepper has no other selector-free way to
  // find this button (its label is a translated string, "Enter the
  // competition"/"Continue to payment" depending on the fee). Asserted on
  // the PROP value itself, not a truthiness check — propsOf reads the real
  // element props (no renderToStaticMarkup string here), so there is no
  // "$undefined" ambiguity to guard against, but pinning the exact string
  // still catches a testid typo a bare "is present" check would miss.
  it("carries data-testid=\"reg-submit\" on the review step's submit button — the bench's only selector-free hook into it", async () => {
    apiV1Mock.impl.mockResolvedValueOnce({
      group_id: "g3",
      ref_code: "SZ-TEST-04",
      access_token: "tok999",
      currency: "gbp",
      amount_cents: 0,
      checkout_url: null,
      entries: [],
    });
    const { island } = await reachReview();
    const btn = island.tree().find((e) => e.type === "button" && textOf(e) === "Enter the competition");
    expect(btn, "submit button not found").toBeTruthy();
    expect(propsOf(btn!)["data-testid"]).toBe("reg-submit");
  });

  // `reg-next` and `reg-back` exist because the bench's browser driver used to
  // locate this row STRUCTURALLY — `div.relative.z-50.flex button` nth(1) —
  // and the first live run stalled 30s on the consent step because the wizard
  // had never advanced off "who". A CSS-class chain is a real selector right
  // up until someone restyles the row, and nothing here could have told us.
  //
  // The assertions pin WHICH button carries WHICH hook. Asserting only that
  // both testids appear somewhere would pass with the two swapped, and a
  // driver clicking Back to go forward looks exactly like a wizard that will
  // not advance.
  it('carries data-testid="reg-next" on Next and "reg-back" on Back, on the right buttons', async () => {
    const m = mount([DIV_OPEN]);
    const row = m.island.tree().filter((e) => e.type === "button");
    const back = row.find((e) => propsOf(e)["data-testid"] === "reg-back");
    const next = row.find((e) => propsOf(e)["data-testid"] === "reg-next");

    expect(back, "no reg-back button").toBeTruthy();
    expect(next, "no reg-next button").toBeTruthy();

    // Back is the disabled-on-first-step one; Next is not. This is what
    // distinguishes them beyond the label, which is a translated string.
    expect(propsOf(back!).disabled, "reg-back should be disabled on the first step").toBe(true);
    expect(propsOf(next!).disabled).not.toBe(true);
    expect(propsOf(back!).onClick).not.toBe(propsOf(next!).onClick);
  });

  // `reg-who-playing` replaces the bench driver's old
  // `input[type="checkbox"].first()` locator. That locator was not merely
  // fragile — `step-who.tsx:108` renders this control only when
  // `showSelfToggle` is true, so with the toggle absent "the first checkbox on
  // the page" resolves to a DIFFERENT control and checks someone else's box
  // while reporting success.
  //
  // So this pins IDENTITY, not presence: exactly one element carries the hook,
  // it is a checkbox, and toggling it actually drives `imPlaying`. Presence
  // alone would be satisfied by the hook landing on any checkbox in the tree.
  it('carries data-testid="reg-who-playing" on the "I am playing" checkbox, and on nothing else', async () => {
    const m = mount([DIV_OPEN]);
    const hooked = m.island.tree().filter((e) => propsOf(e)["data-testid"] === "reg-who-playing");
    expect(hooked, "expected exactly one reg-who-playing element").toHaveLength(1);
    expect(propsOf(hooked[0]!).type).toBe("checkbox");

    const before = propsOf(hooked[0]!).checked;
    (propsOf(hooked[0]!).onChange as (e: { target: { checked: boolean } }) => void)({
      target: { checked: !before },
    });
    const after = m.island.tree().filter((e) => propsOf(e)["data-testid"] === "reg-who-playing");
    expect(propsOf(after[0]!).checked, "the hooked checkbox does not drive imPlaying").toBe(!before);
  });

  // The details step is NOT a no-op, which is what the bench's browser driver
  // assumed for three live runs: `validateDetails` requires every player row's
  // name, so an unfilled row leaves `goNext` refusing to advance. The wizard
  // then sits on "details" while the driver waits 30s for a consent control
  // that only renders once the step changes — the failure reads as a missing
  // selector and is really a blocked transition.
  //
  // Every field in that row was addressable only by an aria-label built from
  // TRANSLATED strings, so a driver had no non-text way in. `data-player-row`
  // matters as much as the testid: the row REPEATS per player, so a bare
  // `[data-testid="reg-roster-name"]` matches N elements and trips
  // Playwright's strict mode the moment a pack has more than one player.
  it('carries data-testid="reg-roster-name" with a per-row data-player-row index', async () => {
    const m = mount([DIV_OPEN]);
    (propsOf(m.stepWho()).onChange as (p: object) => void)({ name: "Alex Test", email: "alex@example.com" });
    m.clickByText("Next"); // -> DETAILS (individual + one open division collapses ENTRIES, steps.ts:31)

    const names = m.island.tree().filter((e) => propsOf(e)["data-testid"] === "reg-roster-name");
    expect(names, "no reg-roster-name field on the details step").not.toHaveLength(0);

    // This mount renders ONE row, so it can only prove the hook is present and
    // wired. The per-row INDEX property is proven in roster-table-hooks.test.tsx
    // against a two-player roster — asserted here it would be vacuous, and was:
    // stamping data-player-row={0} on every row left this file green.
    expect(propsOf(names[0]!)["data-player-row"]).toBe(0);

    // And the hooked field actually drives that player's name.
    (propsOf(names[0]!).onChange as (e: { target: { value: string } }) => void)({
      target: { value: "Alex Test" },
    });
    const after = m.island.tree().filter((e) => propsOf(e)["data-testid"] === "reg-roster-name");
    expect(propsOf(after[0]!).value).toBe("Alex Test");
  });
});
