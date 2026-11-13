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

// Turnstile's widget needs a browser; its controller is stood in for by a fake with the controller's own surface (token/reset), so
// the stepper's side of the seam is driven for real: the REAL `withTurnstile` hands the (mocked-network) `apiV1` call the header,
// and resets the widget after. `turnstileFake.token` is what the "widget" holds; null = no widget / no token (no site key, dev, e2e).
const turnstileFake = vi.hoisted(() => ({
  token: null as string | null,
  resets: 0,
  controller: null as unknown as { token(): Promise<string | null>; reset(): void },
  actions: [] as string[],
}));
vi.mock("@/components/turnstile-widget", () => {
  turnstileFake.controller = {
    token: () => Promise.resolve(turnstileFake.token),
    reset: () => { turnstileFake.resets++; },
  };
  return {
    useTurnstile: (action: string) => { turnstileFake.actions.push(action); return turnstileFake.controller; },
    TurnstileWidget: function TurnstileWidgetStub() { return null; },
  };
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement, ReactNode } from "react";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { ApiV1Error } from "@/lib/client-v1";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import { summarizeCart } from "../cart";
import { DivisionCard } from "../division-card";
import { EntryCart } from "../entry-cart";
import { EntryDetails } from "../entry-details";
import { FormFields } from "../form-fields";
import { JoinCodeEntry } from "../join-code-entry";
import { RegisterStepper, type RegisterInfo } from "../register-stepper";
import { RosterTable } from "../roster-table";
import { StepConsent } from "../step-consent";
import type { RegisterLichessState } from "../register-lichess-card";
import { StepDetails } from "../step-details";
import { StepEntries } from "../step-entries";
import { StepReview } from "../step-review";
import { StepNav } from "../step-nav";
import { buildStepOrder } from "../steps";
import { StepWho } from "../step-who";
import { FIELD, TAG_NEUTRAL } from "../styles";
import { REGISTER_STATE_VERSION } from "../storage";
import { reviewContent } from "../review-content";
import { EMPTY_CONSENT, EMPTY_CONTACT, type CartState, type DivisionLike, type FormFieldDef } from "../types";
import { EntrantKind } from "@/server/api-v1/schemas/common";

const EN_UI: Dict = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "..", "..", "dictionaries", "en", "ui.json"), "utf8"),
) as Dict;

vi.mock("@/components/i18n/dict-provider", () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) => tRuntime(EN_UI, key, vars),
  usePlural: () => (key: string, count: number, vars?: Record<string, string | number>) =>
    pluralRuntime(EN_UI, key, count, "en", vars),
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
 *  globalThis.sessionStorage per-test so RegisterStepper's post-hydration restore
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
// B1 fix round 1 (M5): `location.replace` and the window's event listeners too, so the stepper's `pageshow` handler (back from Stripe
// out of the back-forward cache) can be fired by a test the way invoice-pay-form.test.tsx fires its own.
let replaceMock: ReturnType<typeof vi.fn>;
type PageShowListener = (e: { persisted: boolean }) => void;
let windowListeners: Record<string, PageShowListener[]>;
beforeEach(() => {
  fakeSessionStorage = new MapStorage();
  (globalThis as { sessionStorage?: unknown }).sessionStorage = fakeSessionStorage;
  assignMock = vi.fn();
  replaceMock = vi.fn();
  windowListeners = {};
  (globalThis as { window?: unknown }).window = {
    location: { assign: assignMock, replace: replaceMock },
    addEventListener: (type: string, fn: PageShowListener) => {
      (windowListeners[type] ??= []).push(fn);
    },
    removeEventListener: (type: string, fn: PageShowListener) => {
      windowListeners[type] = (windowListeners[type] ?? []).filter((f) => f !== fn);
    },
  };
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


function mount(
  divisions: DivisionLike[],
  harnessOptions: { hydrate?: boolean; clientMount?: boolean } = { hydrate: true },
  extra: { lichess?: RegisterLichessState | null } = {},
) {
  const info: RegisterInfo = {
    competition: { name: "Test Cup", starts_on: "2026-09-01" },
    org: { name: "Test Org" },
    divisions,
  };
  const island = renderIsland(
    RegisterStepper,
    { orgSlug: ORG_SLUG, competitionSlug: COMPETITION_SLUG, info, locale: "en", joinCode: null, ...extra },
    deepExpand,
    // The restore from sessionStorage and `hydrated` itself are read through a
    // store (server snapshot: not hydrated), so the harness must model React's
    // after-hydration re-read — the render the old mount effect used to run in.
    harnessOptions,
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
  // "Next" here is the forward button's ROLE, not a label: its words are "Continue to {step}" (B2 T8) and move with the step, so it is
  // found by its testid, the same hook the e2e suite uses. Every other button is still found by its visible text.
  const clickByText = (text: string) => {
    const btn = island
      .tree()
      .find((e) => e.type === "button" && (text === "Next" ? propsOf(e)["data-testid"] === "reg-next" : textOf(e) === text));
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
// ESLint L4 — the self-link convenience used to be an effect over (imPlaying,
// cart size), applied AFTER an event's updates had all landed. Solo signup is
// one event with TWO dispatches (ADD_ENTRY a team, then UPDATE_ENTRY
// free_agent:true): a free agent has no roster, so linking it as the contact
// would submit registering_self:true with an unresolvable index. Whatever
// replaces the effect has to look at the settled cart, not at each dispatch.
// ---------------------------------------------------------------------------

describe("ESLint L4 — the self-link follows the SETTLED cart, not each dispatch", () => {
  const DIV_TEAM_FA: DivisionLike = {
    ...DIV_OPEN,
    division_id: "div-team-fa",
    name: "Team Cup",
    entrant_kind: "team",
    allow_free_agents: true,
  };

  /** WHO filled in and "I'm playing" on, then on to ENTRIES — the state both cases below start from. */
  function playingOnEntries() {
    const m = mount([DIV_TEAM_FA]);
    (propsOf(m.stepWho()).onChange as (p: object) => void)({
      name: "Alex Test",
      email: "alex@example.com",
      dob: "1990-01-01",
    });
    (propsOf(m.stepWho()).onImPlayingChange as (v: boolean) => void)(true);
    m.clickByText("Next"); // -> ENTRIES
    return m;
  }

  it("solo signup while 'I'm playing' is on never self-links the free-agent entry (ADD_ENTRY then UPDATE_ENTRY in one event)", () => {
    const { island, divisionCard, entryCartCart } = playingOnEntries();
    // ONE event, two dispatches — React renders once, with both applied.
    island.batch(() => (propsOf(divisionCard("div-team-fa")).onAddSoloSignup as () => void)());
    const entries = entryCartCart().entries;
    expect(entries, "PREMISE: one entry was added").toHaveLength(1);
    expect(entries[0]!.free_agent, "PREMISE: it is the solo (free-agent) signup").toBe(true);
    expect(entries[0]!.registering_self, "a free agent is never the contact's own row").toBe(false);
  });

  it("the positive pair: an ordinary lone team entry, same state, IS auto-linked — so `false` above is the free-agent rule, not auto-link being off", () => {
    const { divisionCard, entryCartCart } = playingOnEntries();
    (propsOf(divisionCard("div-team-fa")).onAddTeam as () => void)();
    expect(entryCartCart().entries.map((e) => e.registering_self)).toEqual([true]);
  });
});

// ---------------------------------------------------------------------------
// ESLint L4 — the sessionStorage restore moved from a mount effect to the first
// render after hydration. What that owes, in sequence: the server/hydration pass
// touches no storage at all, the restore is applied before anything is saved
// (the first write must carry the RESTORED snapshot — an empty one would
// clobber the visitor's draft), and nothing is written by a visit with nothing
// to save until the visitor edits.
// ---------------------------------------------------------------------------

describe("ESLint L4 — restore from sessionStorage happens after hydration, before the first save", () => {
  const KEY = `seazn_register_${ORG_SLUG}_${COMPETITION_SLUG}`;
  const DRAFT = JSON.stringify({
    version: REGISTER_STATE_VERSION,
    contact: { ...EMPTY_CONTACT, name: "Drafted Dee", email: "dee@example.com" },
    imPlaying: false,
    cart: { entries: [] },
    consent: { privacy_consent: false, media_consent: false },
    stepIndex: 0,
  });
  const spyStorage = () => {
    const reads: string[] = [];
    const writes: string[] = [];
    const real = fakeSessionStorage;
    (globalThis as { sessionStorage?: unknown }).sessionStorage = {
      getItem: (k: string) => {
        reads.push(k);
        return real.getItem(k);
      },
      setItem: (k: string, v: string) => {
        writes.push(v);
        real.setItem(k, v);
      },
      removeItem: (k: string) => real.removeItem(k),
    };
    return { reads, writes };
  };

  it("the first thing written is the RESTORED draft — never an empty snapshot over it", () => {
    fakeSessionStorage.setItem(KEY, DRAFT);
    const { reads, writes } = spyStorage();
    const { stepWho } = mount([DIV_OPEN]);
    expect(reads, "PREMISE: the draft was read").toContain(KEY);
    expect(writes.length, "PREMISE: a save happened (an empty list would pass vacuously)").toBeGreaterThan(0);
    expect(
      writes.map((w) => (JSON.parse(w) as { contact: { name: string } }).contact.name),
      "every write carries the restored name — none is the empty contact",
    ).toEqual(writes.map(() => "Drafted Dee"));
    expect(propsOf(stepWho()).contact as { name: string }).toMatchObject({ name: "Drafted Dee" });
  });

  it("a CLIENT-SIDE mount (hydrated on the very first render) restores too — and the self-link look waits for it: two restored self-links both survive", () => {
    const entry = (id: string, division_id: string) => ({
      id,
      division_id,
      entrant_kind: "individual",
      team_name: null,
      partner_name: null,
      free_agent: false,
      players: [{ full_name: "", dob: null, gender: null, email: "", squad_number: "", is_captain: false }],
      answers: {},
      registering_self: true,
      self_player_index: null,
    });
    fakeSessionStorage.setItem(
      KEY,
      JSON.stringify({
        version: REGISTER_STATE_VERSION,
        contact: { ...EMPTY_CONTACT, name: "Drafted Dee", email: "dee@example.com", dob: "1990-01-01" },
        imPlaying: true,
        cart: { entries: [entry("e1", "div-open"), entry("e2", "div-open-2")] },
        consent: { privacy_consent: false, media_consent: false },
        stepIndex: 1,
      }),
    );
    const { entryCartCart, selfCheckboxes } = mount([DIV_OPEN, DIV_OPEN_2], { clientMount: true });
    expect(
      entryCartCart().entries.map((e) => e.registering_self),
      "the restored cart reached the page, links intact",
    ).toEqual([true, true]);
    expect(selfCheckboxes()).toHaveLength(2);
  });

  it("the server / hydration pass touches storage not at all: no read, no write, no restored contact", () => {
    fakeSessionStorage.setItem(KEY, DRAFT);
    const { reads, writes } = spyStorage();
    // No `hydrate: true`: the harness stays on the server snapshot (hydrated = false).
    const island = renderIsland(
      RegisterStepper,
      {
        orgSlug: ORG_SLUG,
        competitionSlug: COMPETITION_SLUG,
        info: { competition: { name: "Test Cup", starts_on: "2026-09-01" }, org: { name: "Test Org" }, divisions: [DIV_OPEN] },
        locale: "en",
        joinCode: null,
      },
      deepExpand,
    );
    const who = island.tree().find((e) => e.type === StepWho);
    expect(who, "PREMISE: the WHO step rendered").toBeTruthy();
    expect(propsOf(who!).contact as { name: string }, "not restored before hydration").toMatchObject({ name: "" });
    expect(reads).toEqual([]);
    expect(writes).toEqual([]);
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
    clickByText("Next"); // -> ENTRIES — polish wave V1: a playing registrant is linked to EVERY entry, one per division

    const boxes = selfCheckboxes();
    expect(boxes, "two entries, two checkboxes").toHaveLength(2);
    expect(
      boxes.every((b) => propsOf(b).checked === true),
      "both pre-checked — a playing registrant is the player on every entry until they say otherwise (V1)",
    ).toBe(true);

    // Untick both ("not me" on each), then tick them back one at a time: the second tick must not undo the first.
    for (let i = 0; i < 2; i++) {
      (propsOf(selfCheckboxes()[i]!).onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: false } });
    }
    expect(entryCartCart().entries.map((e) => e.registering_self), "both unticked by hand").toEqual([false, false]);

    // Check the FIRST box.
    (propsOf(selfCheckboxes()[0]!).onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: true } });
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
  // mount. Root cause was a hydration race between the post-hydration
  // restore and register-stepper.tsx's autoLinkObviousSelf /
  // clearSelfLinkWhenNotPlaying self-link pass (re-run when `imPlaying` or
  // `cart.entries.length` changes). Both used to be effects: on the FIRST
  // render (before the restore's setImPlaying/setCart calls were applied)
  // the self-link effect already fired once, with imPlaying's STALE
  // pre-restore value (false). Its `setCart(prev => ...)` functional updater
  // still chained onto the restore's newly-queued cart (React applies
  // same-tick updates to a state variable in call order), so
  // `clearSelfLinkWhenNotPlaying` saw "imPlaying is false" and a cart with
  // self-linked entries, and cleared every one of them. A SECOND invocation
  // followed once the real (post-restore) imPlaying/cart values committed —
  // for exactly ONE cart entry,
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

    // Add a SECOND, unrelated entry: it re-fires the cart.entries.length-keyed
    // pass via 1 -> 2. Since polish wave V1 a playing registrant is linked to
    // every NEW entry, so the second one is linked — and the declined first
    // one must not be, in the same pass.
    (propsOf(divisionCard("div-open-2")).onAddIndividual as () => void)();
    expect(
      entryCartCart().entries.map((e) => e.registering_self),
      "the declined entry stays unlinked; the new one is linked (V1)",
    ).toEqual([false, true]);

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
    const { stepWho, divisionCard, clickByText, pageText, selfCheckboxes, entryCartCart } = mount([DIV_OPEN, DIV_WOMENS]);

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

    // Polish wave V1: a playing registrant is linked to EVERY entry, the
    // womens one included, so the cart's own eligibility gate asks first —
    // the registrant answers it by saying that entry is not them.
    clickByText("Next");
    expect(pageText(), "the auto-linked womens entry is gated like any self entry").toContain(
      "Resolve the eligibility issue on your entry before continuing",
    );
    (propsOf(selfCheckboxes()[0]!).onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: false } });
    expect(entryCartCart().entries.map((e) => e.registering_self), "womens entry unlinked, open entry kept").toEqual([false, true]);

    // No longer the self-linked one: no verdict pins it, and Next must succeed.
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
// added to the post-hydration restore is verified by a manual mutation check
// (temporarily seeding a bad initial value with the reset removed, see the
// fix wave report) rather than by a test that can go red against this
// codebase's current, reachable behavior.
// A restored snapshot carrying an EMPTY cart, on a competition whose entries
// step is collapsed, had no surface anywhere to add an entry.
//
// The post-hydration restore reads `if (saved) { restore } else if (collapseEntries)
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
    // (whoFieldRequirements — api-v1/schemas/ folder's superRefine requires contact.dob
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
    expect(text).not.toContain("Enter an email address, like name@example.com");
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
// Finding #6 — the nav row must sit above the cookie banner (from `md`; B2 T8: below `md` the pinned bar sits BELOW it, see the
// describe below — measured in a browser, a z-50 bar pinned to the banner's own edge buried its Accept/Reject)
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

/** The action bar's own element (B2 T8): the one row Back and the forward button live in, read off the mounted stepper. */
function actionBarClass(): string {
  const m = mount([DIV_OPEN]);
  const bar = m.island.tree().find((e) => propsOf(e)["data-testid"] === "reg-bar");
  expect(bar, "the stepper renders no [data-testid=reg-bar] action bar").toBeTruthy();
  return String(propsOf(bar!).className);
}

describe("the action bar and the cookie banner (z-order, per breakpoint)", () => {
  const bannerZ = (): number => {
    const bannerSrc = readFileSync(join(__dirname, "..", "..", "..", "cookie-consent.tsx"), "utf8");
    const bannerMatch = bannerSrc.match(/className="([^"]*\bfixed\b[^"]*)"/);
    expect(bannerMatch, "no fixed banner class found in cookie-consent.tsx").not.toBeNull();
    return zIndexOf(bannerMatch![1]!);
  };
  /** The bar's z-index at one breakpoint, read off its own class: `md:z-N` from md up, `max-md:z-N` below it. */
  const barZ = (prefix: "md" | "max-md"): number => {
    const m = actionBarClass().match(new RegExp(`(?:^|\\s)${prefix}:z-(\\d+)(?:\\s|$)`));
    expect(m, `no ${prefix}:z-N on the action bar`).not.toBeNull();
    return Number(m![1]);
  };

  it("from md the row is z-50, strictly above the banner's z-40 (finding #6: the banner never swallows a click on Back/Next)", () => {
    expect(barZ("md"), `md row z-${barZ("md")} must be ABOVE the cookie banner z-${bannerZ()}`).toBeGreaterThan(bannerZ());
  });

  it("below md the pinned bar is strictly BELOW the banner: the banner's Accept/Reject are never buried under it (but still under dialogs, z-50)", () => {
    expect(barZ("max-md"), `phone bar z-${barZ("max-md")} must be BELOW the cookie banner z-${bannerZ()}`).toBeLessThan(bannerZ());
    expect(barZ("max-md"), "a dialog (z-50) still covers the bar").toBeLessThan(50);
    expect(actionBarClass(), "no un-prefixed z-N that would apply at both breakpoints").not.toMatch(/(?:^|\s)z-\d+(?:\s|$)/);
  });
});

// B1 fix round 1, D2: at 320 the forward button's label wraps to two lines in nl and fr ("Beveiligde betaling wordt geopend…",
// "Enregistrement de votre place…"), the button grows to fill the row and a row with no gap left it flush against Back
// (measured 0px in a real browser, the Playwright captures for this round). A row gap is the one thing that keeps them apart
// whatever a translation's length, and this pins it on the bar's own class (B2 T8: the bar is a wrapping flex row, so the gap is `gap-x-N`).
describe("the nav row keeps Back and the forward button apart", () => {
  it("register-stepper's action bar carries a horizontal gap of at least 0.5rem", () => {
    const cls = actionBarClass();
    const gap = cls.match(/(?:^|\s)gap(?:-x)?-(\d+(?:\.\d+)?)(?:\s|$)/);
    expect(gap, `no gap-N / gap-x-N on the action bar: ${cls}`).not.toBeNull();
    // Tailwind's spacing scale: gap-N is N × 0.25rem, so gap-2 is the 0.5rem floor.
    expect(Number(gap![1]), `action bar gap ${gap![1]}`).toBeGreaterThanOrEqual(2);
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
    ["step-review.tsx", "reviewHeadingKey"],
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
// first render — the post-hydration restore's own comment claimed the initial
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

  it("the single-open-division auto-seed's crypto.randomUUID() lives INSIDE the post-hydration restore (client-only, after the hydration render), not the initializer", () => {
    const blockStart = stepperSrc.indexOf("if (hydrated && !restored) {");
    expect(blockStart, "post-hydration restore block not found").toBeGreaterThan(-1);
    const blockEnd = stepperSrc.indexOf("setConsentAttempted(false);", blockStart);
    expect(blockEnd, "post-hydration restore block's own end not found").toBeGreaterThan(-1);
    const blockBody = stepperSrc.slice(blockStart, blockEnd);
    expect(blockBody, "autoSeedSingleDivision's id must be generated inside this block").toMatch(
      /autoSeedSingleDivision\([^)]*crypto\.randomUUID\(\)/,
    );
    // ...both call sites: the restored-but-empty cart and the fresh visit.
    expect(blockBody.match(/autoSeedSingleDivision\([^)]*crypto\.randomUUID\(\)/g)).toHaveLength(2);
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
    expect(text).not.toContain("Waiting list — not charged now"); // the WAITLIST line — a different case
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

/** True when the stepper is ON the Review step. Asserted by the step's own component, never by page text: "Review" is also the rail's
 *  name for the step, so the word alone would be on screen before the step is reached. */
function onReviewStep(island: ReturnType<typeof mount>["island"]): boolean {
  return island.tree().some((e) => e.type === StepReview);
}

/** The current step's own heading (its focus target, the one `h2` a step renders). */
function stepHeading(island: ReturnType<typeof mount>["island"]): string {
  const headings = island.tree().filter((e) => e.type === "h2");
  expect(headings, "exactly one step heading").toHaveLength(1);
  return textOf(headings[0]!);
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
    expect(onReviewStep(island), "it advanced to Review").toBe(true);
    expect(stepHeading(island), "a free cart has nothing to pay, so the heading does not say so").toBe("Review");
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
    expect(onReviewStep(island), "unblocked: on Review").toBe(true);
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
    expect(onReviewStep(island), "must not advance without guardian consent").toBe(false);
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
  // `closed_reason "full"` IS "open and 0 places left" on the wire (settings.ts): the cart reads the places, so the fixture states them.
  capacity: 4,
  remaining: 0,
  taken: 4,
  fee_cents: 1000,
  free_agent_fee_cents: null,
  currency: "gbp",
  // The same method as DIV_PAID's: the server's uniform-method rule counts a waitlisted division too (it runs before waitlisting), so a
  // card cart with an OFFLINE waitlisted division is a cart it refuses - and, since P4, one the ENTRIES step refuses as well.
  payment_method: "stripe",
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
    expect(text).toContain("Review and pay");
    expect(text).toContain("Paid Singles");
    expect(text).toContain("Full Division");
    expect(text).toContain("Waiting list — not charged now");
    // Subtotal is the PAID division's £25 alone — the waitlisted £10 never joins it.
    expect(text).toMatch(/£25(\.00)?/);
    expect(text).not.toMatch(/£35(\.00)?/);
  });
});

// I5 (T16 fix round 1): the consent step offers the Lichess link for the SELECTED online divisions, starting back to
// this registration — driven through the real stepper, from WHO to CONSENT, so the wiring (not just the card) is proven.
describe("step 4 — the Lichess link on CONSENT (I5)", () => {
  const UNLINKED: RegisterLichessState = { configured: true, linkedUsername: null, needsReconsent: false, flash: null };
  async function reachConsent(division: DivisionLike, lichess: RegisterLichessState | null) {
    const m = mount([division], undefined, { lichess });
    (propsOf(m.stepWho()).onChange as (p: object) => void)({ name: "Alex Test", email: "alex@example.com" });
    m.clickByText("Next"); // -> DETAILS
    setByAriaLabel(m.island, "Player 1 — Your name", "Alex Test");
    m.clickByText("Next"); // -> CONSENT
    const el = m.island.tree().find((e) => e.type === StepConsent);
    expect(el, "on the CONSENT step").toBeTruthy();
    return propsOf(el!).lichess as unknown;
  }

  // One mount per test: the draft (step included) persists in sessionStorage, which beforeEach resets.
  it("the empty case first: no online division selected — no card", async () => {
    expect(await reachConsent(DIV_OPEN, UNLINKED), "over the board").toBeNull();
  });

  it("an online division, but the page read no link state — no card", async () => {
    expect(await reachConsent({ ...DIV_OPEN, online_play: true }, null)).toBeNull();
  });

  it("an online division selected: the card names it, starts at this club, and comes back here", async () => {
    expect(await reachConsent({ ...DIV_OPEN, online_play: true }, UNLINKED)).toEqual({
      divisions: ["Open Singles"],
      orgSlug: ORG_SLUG,
      next: `/live/${ORG_SLUG}/${COMPETITION_SLUG}/register`,
      state: UNLINKED,
    });
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
      `/live/${ORG_SLUG}/${COMPETITION_SLUG}/register/status?rid=g1&token=tok123`,
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

  // Turnstile (bot check). The register POST carries the widget's token in the `cf-turnstile-response` header (typed from the wire
  // contract, not read from lib/turnstile.ts), the widget sits on the review step that submits, and it is reset after the request
  // whatever came back: a token is single-use.
  describe("Turnstile bot check", () => {
    beforeEach(() => {
      turnstileFake.token = null;
      turnstileFake.resets = 0;
      turnstileFake.actions = [];
    });
    const FREE_RESULT = { group_id: "g1", ref_code: "SZ-TEST-01", access_token: "tok123", currency: "gbp", amount_cents: 0, checkout_url: null, entries: [] };
    const submitBtn = (island: ReturnType<typeof mount>["island"]) =>
      island.tree().find((e) => e.type === "button" && textOf(e) === "Enter the competition")!;

    it("the review step mounts exactly one widget, for the `register` action, wired to the controller that sends the request", async () => {
      const { island } = await reachReview();
      expect(turnstileFake.actions.length, "anti-vacuity: the hook ran").toBeGreaterThan(0);
      expect(turnstileFake.actions.every((a) => a === "register")).toBe(true);
      const widgets = island.tree().filter((e) => typeof e.type === "function" && e.type.name === "TurnstileWidgetStub");
      expect(widgets, "one widget on the review step").toHaveLength(1);
      expect(propsOf(widgets[0]!).controller).toBe(turnstileFake.controller);
    });

    // Registration redesign B1 (spec §3.3 item 1): the invisible check starts when the form OPENS, not when Review does, so a
    // typical Review dwell finds a token already waiting. One widget, a direct child of the stepper root (outside the step switch),
    // in the SAME slot of the root's children on every step: React matches key-less children by slot, so the same slot is the
    // same mounted widget, never torn down and re-rendered (which would restart the challenge) when the step changes.
    // Not hidden and not aria-hidden: the widget is `interaction-only`, so when Cloudflare does need the visitor it shows a
    // checkbox there, which must be seen and reachable.
    it("the widget mounts on the first step and stays the same single root-level widget on every step through review", async () => {
      const slots: string[] = [];
      const checkStep = (island: ReturnType<typeof mount>["island"], step: string) => {
        const tree = island.tree();
        const widgets = tree.filter((e) => typeof e.type === "function" && e.type.name === "TurnstileWidgetStub");
        expect(widgets, `${step}: exactly one widget`).toHaveLength(1);
        expect(propsOf(widgets[0]!).controller, `${step}: wired to the controller that sends the request`).toBe(turnstileFake.controller);
        const rootChildren = propsOf(tree[0]!).children as unknown[];
        const slot = rootChildren.indexOf(widgets[0]);
        expect(slot, `${step}: a direct child of the stepper root, outside the step switch`).toBeGreaterThanOrEqual(0);
        const p = propsOf(widgets[0]!);
        expect(p.hidden, `${step}: never hidden`).toBeUndefined();
        expect(p["aria-hidden"], `${step}: never aria-hidden`).toBeUndefined();
        slots.push(`${step}@${slot}`);
      };

      // A two-division competition: the Entries step is in the order too.
      const two = mount([DIV_OPEN, DIV_OPEN_2]);
      checkStep(two.island, "who");
      (propsOf(two.stepWho()).onChange as (p: object) => void)({ name: "Alex Test", email: "alex@example.com" });
      two.clickByText("Next");
      checkStep(two.island, "entries");

      // One division: Who, Details, Consent, Review. A fresh draft store: the first stepper saved its step there.
      (globalThis as { sessionStorage?: unknown }).sessionStorage = new MapStorage();
      const m = mount([DIV_OPEN]);
      checkStep(m.island, "who");
      (propsOf(m.stepWho()).onChange as (p: object) => void)({ name: "Alex Test", email: "alex@example.com" });
      m.clickByText("Next");
      checkStep(m.island, "details");
      setByAriaLabel(m.island, "Player 1 — Your name", "Alex Test");
      m.clickByText("Next");
      checkStep(m.island, "consent");
      (propsOf(byId(m.island, "reg-consent-privacy")).onChange as (e: { target: { checked: boolean } }) => void)({
        target: { checked: true },
      });
      m.clickByText("Next");
      checkStep(m.island, "review");

      const steps = slots.map((s) => s.split("@")[0]);
      expect(steps, "anti-vacuity: every step of both orders was checked").toEqual(["who", "entries", "who", "details", "consent", "review"]);
      expect(new Set(slots.map((s) => s.split("@")[1])).size, `one slot on every step: ${slots.join(", ")}`).toBe(1);
    });

    it("a held token travels in the header on the register POST (never in the body), and the widget is reset afterwards", async () => {
      turnstileFake.token = "tok-from-widget";
      apiV1Mock.impl.mockResolvedValueOnce(FREE_RESULT);
      const { island } = await reachReview();
      await (propsOf(submitBtn(island)).onClick as () => Promise<void>)();
      expect(apiV1Mock.impl).toHaveBeenCalledTimes(1);
      const options = apiV1Mock.impl.mock.calls[0]![1] as { headers?: Record<string, string>; json: unknown };
      expect(options.headers).toEqual({ "cf-turnstile-response": "tok-from-widget" });
      expect(JSON.stringify(options.json)).not.toContain("tok-from-widget");
      expect(turnstileFake.resets).toBe(1);
    });

    it("no token (no site key, dev, e2e): the POST goes with NO header at all, and the widget is still reset", async () => {
      apiV1Mock.impl.mockResolvedValueOnce(FREE_RESULT);
      const { island } = await reachReview();
      await (propsOf(submitBtn(island)).onClick as () => Promise<void>)();
      const options = apiV1Mock.impl.mock.calls[0]![1] as { headers?: Record<string, string> };
      expect(options.headers).toEqual({});
      expect(turnstileFake.resets).toBe(1);
    });

    it("403 TURNSTILE_FAILED says 'please try again' with the bot-check sentence beneath: never 'check your details', never the server's English", async () => {
      turnstileFake.token = "tok-refused";
      apiV1Mock.impl.mockRejectedValueOnce(new ApiV1Error("Verification failed. Reload the page and try again.", 403, "TURNSTILE_FAILED"));
      const { island } = await reachReview();
      await (propsOf(submitBtn(island)).onClick as () => Promise<void>)();
      const alert = island.tree().find((e) => propsOf(e).role === "alert");
      expect(alert, "an alert block").toBeTruthy();
      const children = propsOf(alert!).children as ReactElement[];
      expect(textOf(children[0]!), "primary: the retry bucket's words").toBe("Something went wrong — please try again.");
      expect(textOf(children[1]!), "secondary: the dictionary's bot-check sentence").toBe(String(EN_UI["turnstile.error"]));
      expect(textOf(island.tree())).not.toContain("check your details");
      expect(textOf(island.tree())).not.toContain("Verification failed. Reload the page");
      expect(turnstileFake.resets, "a refused token is spent too").toBe(1);
    });

    it("a 403 with another code keeps the 'rejected' bucket and its own detail (the pair)", async () => {
      apiV1Mock.impl.mockRejectedValueOnce(new ApiV1Error("Forbidden", 403, "FORBIDDEN"));
      const { island } = await reachReview();
      await (propsOf(submitBtn(island)).onClick as () => Promise<void>)();
      const alert = island.tree().find((e) => propsOf(e).role === "alert");
      const children = propsOf(alert!).children as ReactElement[];
      expect(textOf(children[0]!)).toContain("check your details");
      expect(textOf(children[1]!)).toBe("Forbidden");
    });
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

  // T20: the server answers LICHESS_LINK_REQUIRED only while the club is offered online chess (the PostHog flag
  // `online-chess`), so the stepper needs no flag of its own — but its link must NAME the club, because the start
  // route refuses a start that names none (onto `/me?lichess=unavailable`, fix round 1 m5). The URL is typed here from the route's contract
  // (`/api/auth/lichess?org=<slug>`), not built with the helper under test.
  it("LICHESS_LINK_REQUIRED: the link to Lichess names THIS club, so the start route can ask the club's flag", async () => {
    apiV1Mock.impl.mockRejectedValueOnce(
      new ApiV1Error("Sign in and link your Lichess account to register for online play", 422, "LICHESS_LINK_REQUIRED"),
    );
    const { island } = await reachReview();
    const btn = island.tree().find((e) => e.type === "button" && textOf(e) === "Enter the competition");
    await (propsOf(btn!).onClick as () => Promise<void>)();

    const links = island.tree().filter((e) => propsOf(e)["data-testid"] === "register-lichess-link");
    expect(links, "exactly one link to Lichess").toHaveLength(1);
    // I5 (T16 fix round 1): and it comes BACK to this registration (a same-origin path the route re-validates) — it
    // used to land the player on /me, out of the form.
    expect(propsOf(links[0]!).href).toBe(
      `/api/auth/lichess?org=${ORG_SLUG}&next=${encodeURIComponent(`/live/${ORG_SLUG}/${COMPETITION_SLUG}/register`)}`,
    );
  });

  // A Lichess reason stands ALONE (fix round 1 addendum): the generic "check your details and try again" line, shown
  // above it, sent a player with correct details hunting for a mistake they had not made. So the refusal block holds the
  // reason's own sentence and its action, and neither generic line appears anywhere on the page.
  const GENERIC_LINES = () => [String(EN_UI["register.submit.errorRejected"]), String(EN_UI["register.submit.error"])];
  async function submitRefused(error: ApiV1Error) {
    apiV1Mock.impl.mockRejectedValueOnce(error);
    const { island } = await reachReview();
    const btn = island.tree().find((e) => e.type === "button" && textOf(e) === "Enter the competition");
    await (propsOf(btn!).onClick as () => Promise<void>)();
    return island;
  }
  const refusalBlock = (island: Awaited<ReturnType<typeof submitRefused>>) => {
    const blocks = island.tree().filter((e) => propsOf(e)["data-testid"] === "reg-lichess-refusal");
    expect(blocks, "exactly one Lichess refusal block").toHaveLength(1);
    expect(propsOf(blocks[0]!).role, "announced as an alert").toBe("alert");
    return blocks[0]!;
  };
  const alerts = (island: Awaited<ReturnType<typeof submitRefused>>) => island.tree().filter((e) => propsOf(e).role === "alert");

  // Owner ruling 2026-10-25: a link the seat gate refuses is refused at registration too, as LICHESS_RECONSENT_REQUIRED.
  // The review step must say RECONNECT (its own localized sentence, from the dictionary) and offer the same start - back
  // to this registration - under the reconnect label; and it must not say "link".
  it("LICHESS_RECONSENT_REQUIRED: says to RECONNECT, alone, in the dictionary's words, and offers the start back to this registration", async () => {
    const island = await submitRefused(
      new ApiV1Error("Reconnect your Lichess account so Seazn can submit your moves before registering for online play", 422, "LICHESS_RECONSENT_REQUIRED"),
    );

    const block = refusalBlock(island);
    expect(textOf(block)).toContain(String(EN_UI["register.lichessReconnectRequired"]));
    expect(textOf(block)).not.toContain(String(EN_UI["register.lichessLinkRequired"]));
    const links = island.tree().filter((e) => propsOf(e)["data-testid"] === "register-lichess-reconnect-link");
    expect(links, "exactly one reconnect link").toHaveLength(1);
    expect(propsOf(links[0]!).href).toBe(
      `/api/auth/lichess?org=${ORG_SLUG}&next=${encodeURIComponent(`/live/${ORG_SLUG}/${COMPETITION_SLUG}/register`)}`,
    );
    expect(textOf(links[0]!)).toBe(String(EN_UI["register.lichess.reconnect.cta"]));
    // The pair: the "link" affordance is not offered for this reason.
    expect(island.tree().filter((e) => propsOf(e)["data-testid"] === "register-lichess-link")).toHaveLength(0);
    // Alone: no generic line anywhere, and the refusal is the page's only alert.
    let checked = 0;
    for (const line of GENERIC_LINES()) {
      expect(island.tree().filter((e) => textOf(e).includes(line)), `the generic line "${line}" is not on the page`).toHaveLength(0);
      checked++;
    }
    expect(checked, "anti-vacuity: both generic lines were looked for").toBe(2);
    expect(alerts(island), "the refusal is the only alert").toHaveLength(1);
  });

  it("LICHESS_LINK_REQUIRED keeps its own copy, alone, and offers no reconnect (negative pair of the above)", async () => {
    const island = await submitRefused(
      new ApiV1Error("Link your Lichess account in Settings before registering for online play", 422, "LICHESS_LINK_REQUIRED"),
    );

    expect(textOf(refusalBlock(island))).toContain(String(EN_UI["register.lichessLinkRequired"]));
    expect(textOf(refusalBlock(island))).not.toContain(String(EN_UI["register.lichessReconnectRequired"]));
    expect(island.tree().filter((e) => propsOf(e)["data-testid"] === "register-lichess-reconnect-link")).toHaveLength(0);
    expect(island.tree().filter((e) => propsOf(e)["data-testid"] === "register-lichess-link")).toHaveLength(1);
    let checked = 0;
    for (const line of GENERIC_LINES()) {
      expect(island.tree().filter((e) => textOf(e).includes(line)), `the generic line "${line}" is not on the page`).toHaveLength(0);
      checked++;
    }
    expect(checked).toBe(2);
    expect(alerts(island)).toHaveLength(1);
  });

  // The other direction: any OTHER refusal keeps the generic line (and no Lichess block). A 422 with a different code is
  // the near miss - same status as the Lichess reasons.
  it("a 422 that is NOT a Lichess reason keeps the generic line and its detail, and shows no Lichess block", async () => {
    const island = await submitRefused(new ApiV1Error("This division is full", 422, "DIVISION_FULL"));

    const { primary, secondary } = alertBlock(island);
    expect(textOf(primary)).toBe(String(EN_UI["register.submit.errorRejected"]));
    expect(textOf(secondary)).toBe("This division is full");
    expect(island.tree().filter((e) => propsOf(e)["data-testid"] === "reg-lichess-refusal")).toHaveLength(0);
  });

  // The code alone is not the refusal: the join page keys on (422, code) (classifyJoinFailure) and the register page must
  // too, or a 409/5xx/403 that happens to carry the string is shown as an instruction to go and reconnect.
  const NOT_422_CASES = ["LICHESS_LINK_REQUIRED", "LICHESS_RECONSENT_REQUIRED"].flatMap((code) =>
    [400, 403, 409, 500].map((status) => ({ code, status })),
  );
  it("anti-vacuity: the status x code table below has its 2 codes x 4 statuses", () => {
    expect(NOT_422_CASES).toHaveLength(8);
  });
  it.each(NOT_422_CASES)("a Lichess code on a $status is not shown as a Lichess refusal: $code keeps the generic line", async ({ code, status }) => {
    const island = await submitRefused(new ApiV1Error("some server text", status, code));
    const { primary } = alertBlock(island);
    expect(textOf(primary)).toBe(String(EN_UI[status === 409 || status >= 500 ? "register.submit.error" : "register.submit.errorRejected"]));
    expect(island.tree().filter((e) => propsOf(e)["data-testid"] === "reg-lichess-refusal"), "no Lichess block").toHaveLength(0);
    expect(island.tree().filter((e) => String(propsOf(e)["data-testid"] ?? "").startsWith("register-lichess-")), "no Lichess action").toHaveLength(0);
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
      `/live/${ORG_SLUG}/${COMPETITION_SLUG}/register/status?rid=g2&token=tok789`,
    );
  });

  // Bench hook (B03r) — the public stepper has no other selector-free way to
  // find this button (its label is a translated string, "Enter the
  // competition"/"Pay {fee} and enter" depending on the fee). Asserted on
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
    // Back does not exist on the first step (B2 T8), so the pair is read from the second.
    const m = mount([DIV_OPEN, DIV_OPEN_2]);
    (propsOf(m.stepWho()).onChange as (p: object) => void)({ name: "Alex Test", email: "alex@example.com" });
    m.clickByText("Next"); // -> ENTRIES
    const row = m.island.tree().filter((e) => e.type === "button");
    const back = row.find((e) => propsOf(e)["data-testid"] === "reg-back");
    const next = row.find((e) => propsOf(e)["data-testid"] === "reg-next");

    expect(back, "no reg-back button").toBeTruthy();
    expect(next, "no reg-next button").toBeTruthy();

    // Neither is disabled here; what distinguishes them beyond the label (a translated string) is the handler each one carries.
    expect(propsOf(back!).disabled).not.toBe(true);
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

// ---------------------------------------------------------------------------
// Registration redesign B1 T6 (spec §3.3 item 5) — the submit button says what is happening: `idle` -> "Saving your place…" while the POST is
// in flight -> "Opening secure payment…" ONLY once the response carries a `checkout_url`, then navigation. A free or pay-the-organiser cart
// goes `saving` -> navigation and never shows the payment label. An error returns the ready text and re-enables the button.
//
// Driven through the real stepper (the producer is the click, the consumer is the label the button renders): the POST is held open with a
// deferred promise so the in-flight label is read while it is in flight, and `location.assign` is stubbed to read the button AT the call.
// Expected copy is the brief's own literals, never read back out of the dictionary the code under test reads.
// ---------------------------------------------------------------------------

describe("step 5 — staged submit button text (registration redesign B1 T6)", () => {
  const SAVING = "Saving your place…";
  const OPENING = "Opening secure payment…";
  // The three review-step carts (design §4 step 5): free, pay by card now, pay the organiser later. fee_cents 2500 on both paid shapes.
  const DIV_PAY_LATER: DivisionLike = { ...DIV_PAID, division_id: "div-pay-later", name: "Pay Later Singles", payment_method: "offline" };
  const CARTS = [
    { name: "free", division: DIV_OPEN, ready: "Enter the competition" },
    { name: "card", division: DIV_PAID, ready: "Pay £25.00 and enter" },
    { name: "pay-the-organiser-later", division: DIV_PAY_LATER, ready: "Enter — £25.00" },
  ] as const;
  const BASE_RESULT = { group_id: "g1", ref_code: "SZ-T6-01", access_token: "tok1", currency: "gbp", entries: [] };
  const NO_CHECKOUT = { ...BASE_RESULT, amount_cents: 0, checkout_url: null };
  const WITH_CHECKOUT = { ...BASE_RESULT, amount_cents: 2500, checkout_url: "https://checkout.stripe.com/pay/xyz" };

  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  async function reachReviewFor(division: DivisionLike) {
    const m = mount([division]);
    (propsOf(m.stepWho()).onChange as (p: object) => void)({ name: "Alex Test", email: "alex@example.com" });
    m.clickByText("Next"); // -> DETAILS (one division: ENTRIES is collapsed away)
    setByAriaLabel(m.island, "Player 1 — Your name", "Alex Test");
    m.clickByText("Next"); // -> CONSENT
    (propsOf(byId(m.island, "reg-consent-privacy")).onChange as (e: { target: { checked: boolean } }) => void)({
      target: { checked: true },
    });
    m.clickByText("Next"); // -> REVIEW
    return m;
  }

  type Island = ReturnType<typeof mount>["island"];
  const submitBtn = (island: Island) => {
    const el = island.tree().find((e) => e.type === "button" && propsOf(e)["data-testid"] === "reg-submit");
    expect(el, "the review step's submit button").toBeTruthy();
    return el!;
  };
  const labelOf = (island: Island) => textOf(submitBtn(island));
  const disabledOf = (island: Island) => propsOf(submitBtn(island)).disabled === true;
  const clickSubmit = (island: Island) => (propsOf(submitBtn(island)).onClick as () => Promise<void>)();

  /** Starts a submit whose POST stays open until the returned deferred settles; resolves once the request is actually in flight. */
  async function startSubmit(island: Island) {
    const post = deferred<unknown>();
    apiV1Mock.impl.mockReturnValueOnce(post.promise);
    const done = clickSubmit(island);
    await vi.waitFor(() => expect(apiV1Mock.impl, "the POST is in flight").toHaveBeenCalledTimes(1));
    return { post, done };
  }

  /** What the button read, and whether it was disabled, at the instant `location.assign` was called (the page leaves right after). */
  function watchAssign(island: Island) {
    const seen: { label: string; disabled: boolean }[] = [];
    assignMock.mockImplementation(() => {
      seen.push({ label: labelOf(island), disabled: disabledOf(island) });
    });
    return seen;
  }

  it.each(CARTS)("$name cart: the button reads its ready text first, then \"Saving your place…\" and stays disabled while the POST is in flight", async ({ division, ready }) => {
    const { island } = await reachReviewFor(division);
    expect(labelOf(island), "ready text before the click").toBe(ready);
    expect(disabledOf(island), "enabled before the click").toBe(false);

    const { post, done } = await startSubmit(island);
    expect(labelOf(island), "in flight").toBe(SAVING);
    expect(disabledOf(island), "disabled in flight — a second click must not double-submit").toBe(true);

    post.resolve(NO_CHECKOUT);
    await done;
  });

  it("card cart: \"Opening secure payment…\" appears after the response carries a checkout_url, and is what the button reads AT location.assign", async () => {
    const { island } = await reachReviewFor(DIV_PAID);
    const atAssign = watchAssign(island);
    const { post, done } = await startSubmit(island);
    expect(labelOf(island), "still the saving phase until the response arrives").toBe(SAVING);

    post.resolve(WITH_CHECKOUT);
    await done;

    expect(atAssign, "anti-vacuity: location.assign was reached exactly once").toHaveLength(1);
    expect(atAssign[0]!.label).toBe(OPENING);
    expect(assignMock).toHaveBeenCalledWith("https://checkout.stripe.com/pay/xyz");
    // The page is leaving: the button must not come back to life behind the navigation.
    expect(labelOf(island), "after the navigation call").toBe(OPENING);
    expect(disabledOf(island)).toBe(true);
  });

  it("the button stays disabled across BOTH phases (saving, then opening payment)", async () => {
    const { island } = await reachReviewFor(DIV_PAID);
    const atAssign = watchAssign(island);
    const { post, done } = await startSubmit(island);
    const inFlight = { label: labelOf(island), disabled: disabledOf(island) };

    post.resolve(WITH_CHECKOUT);
    await done;

    expect([inFlight.label, atAssign[0]?.label], "two distinct phases were observed").toEqual([SAVING, OPENING]);
    expect([inFlight.disabled, atAssign[0]?.disabled]).toEqual([true, true]);
  });

  it.each([CARTS[0], CARTS[2]])("$name cart: never shows \"Opening secure payment…\" - no checkout_url, so saving runs straight to navigation", async ({ division }) => {
    const { island } = await reachReviewFor(division);
    const atAssign = watchAssign(island);
    const { post, done } = await startSubmit(island);
    const inFlight = labelOf(island);

    post.resolve(NO_CHECKOUT);
    await done;

    expect(atAssign, "anti-vacuity: location.assign was reached exactly once").toHaveLength(1);
    expect([inFlight, atAssign[0]!.label, labelOf(island)]).toEqual([SAVING, SAVING, SAVING]);
    expect(atAssign[0]!.disabled).toBe(true);
    expect(assignMock).toHaveBeenCalledWith(`/live/${ORG_SLUG}/${COMPETITION_SLUG}/register/status?rid=g1&token=tok1`);
  });

  it.each(CARTS)("$name cart: an error returns the button to its ready text and re-enables it", async ({ division, ready }) => {
    const { island } = await reachReviewFor(division);
    const { post, done } = await startSubmit(island);
    expect(labelOf(island)).toBe(SAVING);

    post.reject(new ApiV1Error("Boom", 500, "INTERNAL"));
    await done;

    expect(labelOf(island), "ready text again").toBe(ready);
    expect(disabledOf(island), "re-enabled so the registrant can retry").toBe(false);
    expect(assignMock, "a failed submit never navigates").not.toHaveBeenCalled();
  });

  it("a retry after an error runs the whole sequence again: saving, then opening payment", async () => {
    const { island } = await reachReviewFor(DIV_PAID);
    const atAssign = watchAssign(island);

    const first = await startSubmit(island);
    first.post.reject(new ApiV1Error("Boom", 500, "INTERNAL"));
    await first.done;
    expect(labelOf(island)).toBe("Pay £25.00 and enter");

    apiV1Mock.impl.mockReset();
    const second = await startSubmit(island);
    expect(labelOf(island), "second attempt starts from saving, not from a stale phase").toBe(SAVING);
    second.post.resolve(WITH_CHECKOUT);
    await second.done;

    expect(atAssign.map((s) => s.label)).toEqual([OPENING]);
  });
});

// ---------------------------------------------------------------------------
// B1 fix round 1 (review D1, D3, M5): the staged button is a STATUS the registrant reads while they wait, not a dead control.
// D1: it says it is busy (aria-busy) through both phases, and the shared primary style keeps a busy button at full strength (its
//     disabled dimming is for a button that is unavailable). The style is a class contract here; the computed opacity is witnessed
//     in the B1 sign-off screenshots (no CSS engine in this node environment).
// D3: the phase is announced through a polite status region that is mounted (empty) before the click: Chrome drops focus from the
//     button the moment it is disabled, so its own label change is not read out.
// M5: back from Stripe (or the status page), a browser may restore this page from its back-forward cache with the button frozen
//     mid-phase. The cart is already committed, so the button must NOT come back to life (a second click is a second cart): the page
//     goes to the cart's own status page instead, by `replace`, so Back from there does not land on the frozen form again.
// Sport: not applicable (the register form is sport-agnostic).
// ---------------------------------------------------------------------------

describe("B1 fix round 1 — the staged button is a readable status (D1, D3) and survives Back from Stripe (M5)", () => {
  const SAVING = "Saving your place…";
  const OPENING = "Opening secure payment…";
  const DIV_PAY_LATER: DivisionLike = { ...DIV_PAID, division_id: "div-pay-later-b1f", name: "Pay Later Singles", payment_method: "offline" };
  const BASE_RESULT = { group_id: "g1", ref_code: "SZ-B1F-01", access_token: "tok1", currency: "gbp", entries: [] };
  const NO_CHECKOUT = { ...BASE_RESULT, amount_cents: 0, checkout_url: null };
  const WITH_CHECKOUT = { ...BASE_RESULT, amount_cents: 2500, checkout_url: "https://checkout.stripe.com/pay/xyz" };
  // The cart's status page: the `?rid=&token=` convention (submit.ts, resolvePostSubmitNavigation), typed from it, not computed.
  const STATUS_URL = `/live/${ORG_SLUG}/${COMPETITION_SLUG}/register/status?rid=g1&token=tok1`;

  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  async function reachReviewFor(division: DivisionLike) {
    const m = mount([division]);
    (propsOf(m.stepWho()).onChange as (p: object) => void)({ name: "Alex Test", email: "alex@example.com" });
    m.clickByText("Next");
    setByAriaLabel(m.island, "Player 1 — Your name", "Alex Test");
    m.clickByText("Next");
    (propsOf(byId(m.island, "reg-consent-privacy")).onChange as (e: { target: { checked: boolean } }) => void)({
      target: { checked: true },
    });
    m.clickByText("Next");
    return m;
  }

  type Island = ReturnType<typeof mount>["island"];
  const byTestId = (island: Island, id: string) => {
    const el = island.tree().find((e) => propsOf(e)["data-testid"] === id);
    expect(el, `[data-testid=${id}]`).toBeTruthy();
    return el!;
  };
  const submitBtn = (island: Island) => byTestId(island, "reg-submit");
  const busyOf = (island: Island) => propsOf(submitBtn(island))["aria-busy"] === true;
  const spoken = (island: Island) => textOf(byTestId(island, "reg-submit-status"));
  const clickSubmit = (island: Island) => (propsOf(submitBtn(island)).onClick as () => Promise<void>)();
  const pageshow = (persisted: boolean) => {
    for (const fn of [...(windowListeners.pageshow ?? [])]) fn({ persisted });
  };

  async function startSubmit(island: Island) {
    const post = deferred<unknown>();
    apiV1Mock.impl.mockReturnValueOnce(post.promise);
    const done = clickSubmit(island);
    await vi.waitFor(() => expect(apiV1Mock.impl, "the POST is in flight").toHaveBeenCalledTimes(1));
    return { post, done };
  }

  it("D1: aria-busy is set through BOTH phases and cleared by an error; before the click it is not busy", async () => {
    const { island } = await reachReviewFor(DIV_PAID);
    expect(busyOf(island), "ready: not busy").toBe(false);
    const seenAtAssign: boolean[] = [];
    assignMock.mockImplementation(() => void seenAtAssign.push(busyOf(island)));

    const first = await startSubmit(island);
    expect(busyOf(island), "saving: busy").toBe(true);
    first.post.reject(new ApiV1Error("Boom", 500, "INTERNAL"));
    await first.done;
    expect(busyOf(island), "after an error: not busy, so it reads as a button again").toBe(false);

    apiV1Mock.impl.mockReset();
    const second = await startSubmit(island);
    second.post.resolve(WITH_CHECKOUT);
    await second.done;
    expect(seenAtAssign, "anti-vacuity: the navigation was reached once, in the opening-payment phase").toEqual([true]);
  });

  it("D1: the submit button's primary style restores full strength and a progress cursor for a busy button, and still dims a merely disabled one", async () => {
    const { island } = await reachReviewFor(DIV_PAID);
    const classes = String(propsOf(submitBtn(island)).className).split(/\s+/);
    expect(classes, "an unavailable (disabled, not busy) button still dims").toContain("disabled:opacity-40");
    // Stacked on `disabled:` so it outranks `disabled:opacity-40` by specificity, whatever order the CSS is emitted in.
    expect(classes).toContain("disabled:aria-busy:opacity-100");
    expect(classes).toContain("disabled:aria-busy:cursor-progress");
  });

  it("D3: one polite status region, mounted empty before the click, speaks each phase and empties again on an error", async () => {
    const { island } = await reachReviewFor(DIV_PAID);
    const region = byTestId(island, "reg-submit-status");
    expect(propsOf(region).role).toBe("status");
    expect(propsOf(region)["aria-live"]).toBe("polite");
    expect(String(propsOf(region).className).split(/\s+/), "visually hidden: the button already shows the words").toContain("sr-only");
    expect(island.tree().filter((e) => propsOf(e)["data-testid"] === "reg-submit-status"), "exactly one region").toHaveLength(1);
    expect(spoken(island), "mounted, and empty, before anything happens").toBe("");

    const heard: string[] = [];
    assignMock.mockImplementation(() => void heard.push(spoken(island)));
    const failed = await startSubmit(island);
    expect(spoken(island)).toBe(SAVING);
    failed.post.reject(new ApiV1Error("Boom", 500, "INTERNAL"));
    await failed.done;
    expect(spoken(island), "the error has its own alert; the status region goes quiet").toBe("");

    apiV1Mock.impl.mockReset();
    const ok = await startSubmit(island);
    ok.post.resolve(WITH_CHECKOUT);
    await ok.done;
    expect(heard, "anti-vacuity: one navigation, announced as opening payment").toEqual([OPENING]);
  });

  it("D3: a free cart's region says it is saving, and never claims to be opening payment", async () => {
    const { island } = await reachReviewFor(DIV_OPEN);
    const heard: string[] = [];
    assignMock.mockImplementation(() => void heard.push(spoken(island)));
    const { post, done } = await startSubmit(island);
    expect(spoken(island)).toBe(SAVING);
    post.resolve(NO_CHECKOUT);
    await done;
    expect(heard).toEqual([SAVING]);
  });

  it.each([
    { name: "card cart (back from Stripe)", division: DIV_PAID, result: WITH_CHECKOUT, left: "https://checkout.stripe.com/pay/xyz" },
    { name: "pay-the-organiser-later cart (back from the status page)", division: DIV_PAY_LATER, result: NO_CHECKOUT, left: STATUS_URL },
    { name: "free cart (back from the status page)", division: DIV_OPEN, result: NO_CHECKOUT, left: STATUS_URL },
  ])("M5, $name: a restore from the back-forward cache goes to the cart's status page by replace, and never re-arms the button", async ({ division, result, left }) => {
    const { island } = await reachReviewFor(division);
    expect((windowListeners.pageshow ?? []).length, "one pageshow listener while the form is mounted").toBe(1);
    const { post, done } = await startSubmit(island);
    post.resolve(result);
    await done;
    expect(assignMock, "premise: the submit committed and the page left").toHaveBeenCalledWith(left);

    pageshow(false); // a fresh load is not a restore
    expect(replaceMock, "not persisted: nothing").not.toHaveBeenCalled();
    pageshow(true);
    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(replaceMock).toHaveBeenCalledWith(STATUS_URL);
    expect(propsOf(submitBtn(island)).disabled, "the committed cart's button stays dead: a second click would be a second cart").toBe(true);
    expect(apiV1Mock.impl, "and nothing was posted again").toHaveBeenCalledTimes(1);
  });

  it("M5: a restore with no committed cart (before any submit, or after a failed one) changes nothing; the listener goes with the form", async () => {
    const { island } = await reachReviewFor(DIV_PAID);
    expect((windowListeners.pageshow ?? []).length, "premise: the form listens while mounted").toBe(1);
    pageshow(true);
    expect(replaceMock, "nothing submitted yet").not.toHaveBeenCalled();

    const { post, done } = await startSubmit(island);
    post.reject(new ApiV1Error("Boom", 500, "INTERNAL"));
    await done;
    pageshow(true);
    expect(replaceMock, "a failed submit committed nothing").not.toHaveBeenCalled();
    expect(propsOf(submitBtn(island)).disabled, "and the button is the retry it should be").toBe(false);

    island.unmount();
    expect((windowListeners.pageshow ?? []).length, "the listener goes with the form").toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Polish wave P4 (walkthrough W1, W3) — Details starts from what steps 1 and 2 already collected. Driven through the REAL stepper:
// the producer is the WHO/ENTRIES inputs, the consumer is the RosterTable the registrant sees on step 3; details-seed.test.ts owns the
// rules, this owns that the stepper actually applies them on the way in (a pure rule nothing calls is the inert seam).
// ---------------------------------------------------------------------------

describe("P4 — the Details step is seeded from the contact (W1) and the pair partner (W3)", () => {
  const rosterNames = (island: ReturnType<typeof mount>["island"]) =>
    island
      .tree()
      .filter((e) => propsOf(e)["data-testid"] === "reg-roster-name")
      .sort((a, b) => Number(propsOf(a)["data-player-row"]) - Number(propsOf(b)["data-player-row"]))
      .map((e) => propsOf(e).value as string);

  const DIV_SINGLES: DivisionLike = { ...DIV_OPEN, fee_cents: 1500, payment_method: "stripe" };
  const DIV_PAIR: DivisionLike = { ...DIV_OPEN, division_id: "div-pair", name: "Mixed Doubles", entrant_kind: "pair" };

  it("W1: 'I'm registering myself' puts the contact's own name on Player 1 (the registrant no longer types it twice)", () => {
    const m = mount([DIV_SINGLES]);
    (propsOf(m.stepWho()).onChange as (p: object) => void)({ name: "Mia Cole", email: "mia@example.com", dob: "1990-04-02" });
    (propsOf(m.stepWho()).onImPlayingChange as (v: boolean) => void)(true);
    m.clickByText("Next"); // -> DETAILS (one individual division collapses ENTRIES)
    expect(rosterNames(m.island)).toEqual(["Mia Cole"]);
  });

  it("the pair of W1: the same flow WITHOUT 'I'm registering myself' leaves Player 1 blank (someone else is being entered)", () => {
    const m = mount([DIV_SINGLES]);
    (propsOf(m.stepWho()).onChange as (p: object) => void)({ name: "Mia Cole", email: "mia@example.com" });
    m.clickByText("Next");
    expect(rosterNames(m.island)).toEqual([""]);
  });

  it("W3: the partner typed on Entries is already on Player 2 when Details opens, and the registrant's own edit survives going Back and Next", () => {
    const m = mount([DIV_PAIR]);
    (propsOf(m.stepWho()).onChange as (p: object) => void)({ name: "Mia Cole", email: "mia@example.com" });
    m.clickByText("Next"); // -> ENTRIES
    (propsOf(m.divisionCard("div-pair")).onAddPair as () => void)();
    setByAriaLabel(m.island, "Partner's name (optional for now)", "Sam Reid");
    m.clickByText("Next"); // -> DETAILS
    expect(rosterNames(m.island), "the partner typed on step 2 arrives on Player 2").toEqual(["", "Sam Reid"]);

    // The registrant corrects Player 2 and goes back and forward: the correction must not be put back to the step-2 spelling.
    const row2 = m.island.tree().find((e) => propsOf(e)["data-testid"] === "reg-roster-name" && propsOf(e)["data-player-row"] === 1);
    (propsOf(row2!).onChange as (e: { target: { value: string } }) => void)({ target: { value: "Samuel Reid" } });
    m.clickByText("Back"); // -> ENTRIES
    m.clickByText("Next"); // -> DETAILS again
    expect(rosterNames(m.island)).toEqual(["", "Samuel Reid"]);
  });

  it("a pair where the contact plays: Player 1 is the contact AND already picked as 'which player are you', so Next is not blocked by the picker", () => {
    const m = mount([DIV_PAIR]);
    (propsOf(m.stepWho()).onChange as (p: object) => void)({ name: "Mia Cole", email: "mia@example.com", dob: "1990-04-02" });
    (propsOf(m.stepWho()).onImPlayingChange as (v: boolean) => void)(true);
    m.clickByText("Next"); // -> ENTRIES
    (propsOf(m.divisionCard("div-pair")).onAddPair as () => void)();
    setByAriaLabel(m.island, "Partner's name (optional for now)", "Sam Reid");
    m.clickByText("Next"); // -> DETAILS
    expect(rosterNames(m.island)).toEqual(["Mia Cole", "Sam Reid"]);
    m.clickByText("Next"); // -> CONSENT: only reachable when validateDetails accepted the seeded roster and pick
    expect(m.pageText(), "reached the consent step").toContain("Privacy");
  });

  // Polish wave sign-off V1 (2026-11-12): a playing registrant who adds entries in several divisions is the player on EVERY one -
  // individual entries are the registrant, a pair or team has them as Player 1. Before, only a ONE-entry cart was linked: the second
  // division's Player 1 was typed again and stored with consent pending, showing the registrant "Consent pending" on her own entry.
  it("V1: a playing registrant's individual, pair and team entries all start with the contact as Player 1, and Next reaches consent", () => {
    const m = mount([DIV_SINGLES, DIV_PAIR, DIV_TEAM]);
    (propsOf(m.stepWho()).onChange as (p: object) => void)({ name: "Mia Cole", email: "mia@example.com", dob: "1990-04-02" });
    (propsOf(m.stepWho()).onImPlayingChange as (v: boolean) => void)(true);
    m.clickByText("Next"); // -> ENTRIES
    (propsOf(m.divisionCard("div-open")).onAddIndividual as () => void)();
    (propsOf(m.divisionCard("div-pair")).onAddPair as () => void)();
    (propsOf(m.divisionCard("div-team")).onAddTeam as () => void)();
    expect(m.entryCartCart().entries.map((e) => [e.division_id, e.registering_self])).toEqual([
      ["div-open", true],
      ["div-pair", true],
      ["div-team", true],
    ]);
    setByAriaLabel(m.island, "Team name", "Riverside"); // a team must be named to leave ENTRIES (RS007)
    setByAriaLabel(m.island, "Partner's name (optional for now)", "Sam Reid");
    m.clickByText("Next"); // -> DETAILS
    // rosterNames orders by row index (stable across entries): the three Player 1 rows in cart order, then the pair's Player 2.
    expect(rosterNames(m.island), "the contact on each entry's Player 1; the partner on the pair's Player 2").toEqual([
      "Mia Cole",
      "Mia Cole",
      "Mia Cole",
      "Sam Reid",
    ]);
    // Next reaches CONSENT on the seeded rows and picks alone: nothing typed on Details itself.
    m.clickByText("Next");
    expect(m.pageText(), "reached the consent step").toContain("Privacy");
    m.clickByText("Back"); // -> DETAILS
    m.clickByText("Back"); // -> ENTRIES, where the cart is inspectable
    expect(
      m.entryCartCart().entries.map((e) => [e.registering_self, e.self_player_index]),
      "every entry still the registrant's; the pair's and team's pick is the contact's row (an individual's is implied row 0)",
    ).toEqual([
      [true, null],
      [true, 0],
      [true, 0],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Polish wave P5 (H-1) — a solo sign-up's Details step collects the player Assign later places. Driven through the REAL stepper:
// ENTRIES "sign up solo" -> DETAILS shows the solo's one row, started from the contact; Next goes on only once it is named.
// ---------------------------------------------------------------------------

describe("P5 H-1 — the solo sign-up's Details step carries the player", () => {
  const DIV_TEAM_SOLO: DivisionLike = { ...DIV_OPEN, division_id: "div-team-solo", name: "Team Cup", entrant_kind: "team", allow_free_agents: true };
  const rosterNames = (island: ReturnType<typeof mount>["island"]) =>
    island
      .tree()
      .filter((e) => propsOf(e)["data-testid"] === "reg-roster-name")
      .map((e) => propsOf(e).value as string);

  function soloOnDetails() {
    const m = mount([DIV_TEAM_SOLO]);
    (propsOf(m.stepWho()).onChange as (p: object) => void)({ name: "Jordan Lee", email: "jordan@example.com" });
    m.clickByText("Next"); // -> ENTRIES
    m.island.batch(() => (propsOf(m.divisionCard("div-team-solo")).onAddSoloSignup as () => void)());
    m.clickByText("Next"); // -> DETAILS
    return m;
  }

  it("the solo's one row is on the Details step, started from the contact, and Next reaches consent", () => {
    const m = soloOnDetails();
    expect(rosterNames(m.island), "one row, the contact's name").toEqual(["Jordan Lee"]);
    m.clickByText("Next"); // -> CONSENT
    expect(m.pageText(), "reached the consent step").toContain("Privacy");
  });

  it("a cleared name blocks Next on the Details step (the row is the player Assign places)", () => {
    const m = soloOnDetails();
    const row = m.island.tree().find((e) => propsOf(e)["data-testid"] === "reg-roster-name");
    (propsOf(row!).onChange as (e: { target: { value: string } }) => void)({ target: { value: "" } });
    m.clickByText("Next");
    expect(m.pageText(), "still on Details").not.toContain("Privacy");
    expect(rosterNames(m.island)).toEqual([""]);
  });
});

// ---------------------------------------------------------------------------
// Polish wave P4 (walkthrough W9) — the mixed card + offline cart is refused on the ENTRIES step, the moment the second division is added,
// with the specific reason; it used to be refused only at submit under "check your details". Validation rules: validation.test.ts.
// ---------------------------------------------------------------------------

describe("P4 — a card + offline cart is refused on the ENTRIES step (W9)", () => {
  const DIV_CARD: DivisionLike = { ...DIV_OPEN, division_id: "div-card", name: "Open Singles", fee_cents: 1500, payment_method: "stripe" };
  const DIV_OFFLINE: DivisionLike = { ...DIV_OPEN, division_id: "div-offline", name: "Social Singles", fee_cents: 800, payment_method: "offline" };

  function onEntries(divisions: DivisionLike[]) {
    const m = mount(divisions);
    (propsOf(m.stepWho()).onChange as (p: object) => void)({ name: "Mia Cole", email: "mia@example.com" });
    m.clickByText("Next"); // -> ENTRIES
    return m;
  }

  it("says why, naming both divisions, as soon as the second one is added - and Next stays on the step", () => {
    const m = onEntries([DIV_CARD, DIV_OFFLINE]);
    (propsOf(m.divisionCard("div-card")).onAddIndividual as () => void)();
    expect(m.entryCartText(), "one division: no refusal yet").not.toContain("can't mix payment methods");

    (propsOf(m.divisionCard("div-offline")).onAddIndividual as () => void)();
    expect(m.entryCartText()).toContain(
      "One registration can't mix payment methods: Open Singles is paid by card at sign-up and Social Singles is paid to the organiser.",
    );

    m.clickByText("Next");
    expect(m.island.tree().some((e) => e.type === StepDetails), "Next is refused: still on ENTRIES").toBe(false);
    expect(m.island.tree().some((e) => e.type === EntryCart), "still on ENTRIES").toBe(true);
  });

  it("removing one side clears the refusal and Next goes on (the sequence, not just the state)", () => {
    const m = onEntries([DIV_CARD, DIV_OFFLINE]);
    (propsOf(m.divisionCard("div-card")).onAddIndividual as () => void)();
    (propsOf(m.divisionCard("div-offline")).onAddIndividual as () => void)();
    expect(m.entryCartText()).toContain("can't mix payment methods");

    const offlineId = m.entryCartCart().entries.find((e) => e.division_id === "div-offline")!.id;
    (propsOf(m.island.tree().find((e) => e.type === EntryCart)!).dispatch as (a: object) => void)({ type: "REMOVE_ENTRY", id: offlineId });
    expect(m.entryCartText()).not.toContain("can't mix payment methods");

    m.clickByText("Next");
    expect(m.island.tree().some((e) => e.type === StepDetails), "no longer refused: on DETAILS").toBe(true);
  });

  // One island per test (the harness's hook state is global), so each pairing is its own case.
  const FREE_OFFLINE: DivisionLike = { ...DIV_OFFLINE, division_id: "div-free", name: "Free Roll", fee_cents: 0 };
  const DIV_CARD_2: DivisionLike = { ...DIV_CARD, division_id: "div-card-2", name: "Masters Singles" };
  it.each([
    ["two card divisions", DIV_CARD_2],
    ["a card division beside a free offline one", FREE_OFFLINE],
  ] as const)("%s are never refused: Next goes on", (_label, other) => {
    const m = onEntries([DIV_CARD, other]);
    (propsOf(m.divisionCard("div-card")).onAddIndividual as () => void)();
    (propsOf(m.divisionCard(other.division_id)).onAddIndividual as () => void)();
    expect(m.entryCartCart().entries, "premise: both were added").toHaveLength(2);
    expect(m.entryCartText()).not.toContain("can't mix payment methods");
    m.clickByText("Next");
    expect(m.island.tree().some((e) => e.type === StepDetails)).toBe(true);
  });
});

// Polish wave P4 (walkthrough W9) - the review step labels EACH entry with its own payment method, not the cart with one.
describe("P4 - the REVIEW step labels each entry with its own payment method (W9)", () => {
  const CARD: DivisionLike = { ...DIV_OPEN, division_id: "div-card", name: "Open Singles", fee_cents: 1500, payment_method: "stripe" };
  const OFFLINE: DivisionLike = { ...DIV_OPEN, division_id: "div-offline", name: "Social Singles", fee_cents: 800, payment_method: "offline" };
  const lines = (node: ReactNode) => walk(node).filter((e) => e.type === "li").map((e) => textOf(e));

  it("a cart that mixes the two (only reachable from a restored draft now) never labels one entry with the other's method", () => {
    const cart: CartState = {
      entries: ["div-card", "div-offline"].map((division_id, i) => ({
        id: `e${i}`,
        division_id,
        entrant_kind: "individual" as const,
        team_name: null,
        partner_name: null,
        free_agent: false,
        players: [],
        answers: {},
        registering_self: false,
        self_player_index: null,
      })),
    };
    const out = (StepReview as unknown as ComponentFn)({
      summary: summarizeCart(cart, [CARD, OFFLINE]),
      content: reviewContent(cart, [CARD, OFFLINE], EMPTY_CONTACT, EMPTY_CONSENT, new Date()),
      locale: "en",
      order: buildStepOrder(2, "individual"),
      onEdit: vi.fn(),
    });
    const rows = lines(out);
    expect(rows).toHaveLength(2);
    const card = rows.find((r) => r.includes("Open Singles"))!;
    const offline = rows.find((r) => r.includes("Social Singles"))!;
    expect(card).toContain("pay by card at sign-up");
    expect(card).not.toContain("pay the organiser");
    expect(offline).toContain("pay the organiser");
    expect(offline).not.toContain("pay by card at sign-up");
    // The old cart-wide note under the subtotal is what mislabelled the walkthrough's 23-pound cart.
    expect((textOf(out).match(/pay by card at sign-up/g) ?? []).length, "once, on its own line").toBe(1);
  });

  it("a stale-closed entry's row (unreachable through Next, which blocks it, but rendered if it ever arrives) keeps 'Free' and its closed note, and is not called a waiting-list entry", () => {
    const STALE: DivisionLike = { ...CARD, division_id: "div-stale-r", name: "Closed Meanwhile", open: false, closed_reason: "window" };
    const cart: CartState = {
      entries: [{ id: "s1", division_id: "div-stale-r", entrant_kind: "individual" as const, team_name: null, partner_name: null, free_agent: false, players: [], answers: {}, registering_self: false, self_player_index: null }],
    };
    const out = (StepReview as unknown as ComponentFn)({
      summary: summarizeCart(cart, [STALE]),
      content: reviewContent(cart, [STALE], EMPTY_CONTACT, EMPTY_CONSENT, new Date()),
      locale: "en",
      order: buildStepOrder(2, "individual"),
      onEdit: vi.fn(),
    });
    const rows = lines(out);
    expect(rows, "premise: one row").toHaveLength(1);
    expect(rows[0]).toContain("Closed Meanwhile");
    expect(rows[0], "its price slot says Free: the entry is not charged").toContain("Free");
    expect(rows[0], "and the closed note under it").toContain("has closed since you added this entry");
    expect(rows[0], "a closed division is not a waiting list").not.toContain("Waiting list");
  });

  it("through the real stepper: the charged entry is labelled, the waitlisted one is not", () => {
    const WAIT: DivisionLike = { ...CARD, division_id: "div-wait", name: "Full Division", closed_reason: "full", capacity: 4, remaining: 0, taken: 4 };
    const m = mount([CARD, WAIT]);
    (propsOf(m.stepWho()).onChange as (p: object) => void)({ name: "Rep", email: "rep@example.com" });
    m.clickByText("Next"); // -> ENTRIES
    (propsOf(m.divisionCard("div-card")).onAddIndividual as () => void)();
    (propsOf(m.divisionCard("div-wait")).onAddIndividual as () => void)();
    m.clickByText("Next"); // -> DETAILS
    const names = allByAriaLabel(m.island, "Player 1 — Your name");
    (propsOf(names[0]!).onChange as (e: { target: { value: string } }) => void)({ target: { value: "One" } });
    (propsOf(names[1]!).onChange as (e: { target: { value: string } }) => void)({ target: { value: "Two" } });
    m.clickByText("Next"); // -> CONSENT
    (propsOf(byId(m.island, "reg-consent-privacy")).onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    m.clickByText("Next"); // -> REVIEW
    const rows = lines(m.island.tree());
    const charged = rows.find((r) => r.includes("Open Singles"))!;
    const waitlisted = rows.find((r) => r.includes("Full Division"))!;
    expect(charged).toContain("pay by card at sign-up");
    expect(waitlisted).not.toContain("pay by card at sign-up");
    expect(waitlisted).not.toContain("pay the organiser");
  });
});

// ---------------------------------------------------------------------------
// Polish wave H — the "Have a join code?" door. It used to sit above the stepper on EVERY step (~220px at 320 wide), and on
// competitions where no entry has a code to hand out. Owner ruling: first step only, collapsed, and only when at least one OPEN
// division is a team or pair (the kinds whose entries carry a join code a captain hands to teammates).
// ---------------------------------------------------------------------------

/** The owner's rule, stated as the set it names — not read back from the code under test. */
const KINDS_WITH_A_JOIN_CODE = new Set(["team", "pair"]);
const joinDoors = (island: ReturnType<typeof mount>["island"]) => island.tree().filter((e) => e.type === JoinCodeEntry);

describe("H — the join-code door shows on the first step only, and only where a join code can lead somewhere", () => {
  it("an individual-only competition never offers it", () => {
    const m = mount([DIV_OPEN, DIV_WOMENS]);
    m.stepWho(); // on the first step
    expect(joinDoors(m.island)).toHaveLength(0);
  });

  it("every entrant kind, one open division each: offered exactly for the kinds whose entries hand out a code", () => {
    let checked = 0;
    let offered = 0;
    for (const kind of EntrantKind.options) {
      const m = mount([{ ...DIV_OPEN, division_id: `div-${kind}`, entrant_kind: kind }]);
      m.stepWho();
      const doors = joinDoors(m.island);
      expect(doors, kind).toHaveLength(KINDS_WITH_A_JOIN_CODE.has(kind) ? 1 : 0);
      if (doors.length) {
        offered += 1;
        expect(propsOf(doors[0]!), `${kind}: the door names this competition`).toMatchObject({
          orgSlug: ORG_SLUG,
          competitionSlug: COMPETITION_SLUG,
        });
      }
      checked += 1;
    }
    expect(checked, "anti-vacuity: every entrant kind").toBe(EntrantKind.options.length);
    expect(offered, "anti-vacuity: some kind offers it").toBe(KINDS_WITH_A_JOIN_CODE.size);
  });

  it("a CLOSED team or pair division does not count — an individual comp with a closed team division stays without it", () => {
    let checked = 0;
    for (const kind of ["team", "pair"] as const) {
      const m = mount([DIV_OPEN, { ...DIV_TEAM, entrant_kind: kind, open: false, closed_reason: "window" }]);
      m.stepWho();
      expect(joinDoors(m.island), kind).toHaveLength(0);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("with an open pair division: on step 1, gone on every later step, and back when the person returns to step 1", () => {
    const PAIR: DivisionLike = { ...DIV_TEAM, division_id: "div-pair", name: "Open Pairs", entrant_kind: "pair" };
    const m = mount([DIV_OPEN, PAIR]);
    m.stepWho();
    expect(joinDoors(m.island), "WHO").toHaveLength(1);
    (propsOf(m.stepWho()).onChange as (p: object) => void)({ name: "Rep", email: "rep@example.com" });
    m.clickByText("Next"); // -> ENTRIES
    expect(m.island.tree().some((e) => e.type === StepWho), "left the first step").toBe(false);
    const later: string[] = [];
    expect(joinDoors(m.island), "ENTRIES").toHaveLength(0);
    later.push("entries");
    (propsOf(m.divisionCard("div-open")).onAddIndividual as () => void)();
    m.clickByText("Next"); // -> DETAILS
    expect(joinDoors(m.island), "DETAILS").toHaveLength(0);
    later.push("details");
    const names = allByAriaLabel(m.island, "Player 1 — Your name");
    (propsOf(names[0]!).onChange as (e: { target: { value: string } }) => void)({ target: { value: "One" } });
    m.clickByText("Next"); // -> CONSENT
    expect(joinDoors(m.island), "CONSENT").toHaveLength(0);
    later.push("consent");
    (propsOf(byId(m.island, "reg-consent-privacy")).onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    m.clickByText("Next"); // -> REVIEW
    expect(m.island.tree().some((e) => e.type === StepReview), "reached REVIEW").toBe(true);
    expect(joinDoors(m.island), "REVIEW").toHaveLength(0);
    later.push("review");
    expect(later, "anti-vacuity: every later step was visited").toEqual(["entries", "details", "consent", "review"]);
    for (let i = 0; i < 4; i++) m.clickByText("Back");
    m.stepWho();
    expect(joinDoors(m.island), "back on WHO").toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Registration redesign B2 T7 — the S1 rail is mounted with the stepper's REAL step order and a REAL jump. A rail whose tests
// all hand it its own props proves the rail; the seam is the stepper handing it the order it actually walks and an `onJump` that
// actually moves — without them every finished step is plain text and the desktop jump ships inert (AGENTS.md, recurring class 1).
// ---------------------------------------------------------------------------

describe("B2 T7 — the stepper mounts StepNav with its real order and a working onJump", () => {
  const stepNav = (m: ReturnType<typeof mount>) => {
    const el = m.island.tree().find((e) => e.type === StepNav);
    expect(el, "StepNav is not in the stepper's tree").toBeTruthy();
    return propsOf(el!) as { order: string[]; currentIndex: number; onJump?: (i: number) => void };
  };
  const fillWho = (m: ReturnType<typeof mount>) =>
    (propsOf(m.stepWho()).onChange as (p: object) => void)({ name: "Alex Test", email: "alex@example.com" });

  it("two open divisions: the 5-step order the builder returns, on step 1 — and the rail follows each Next", () => {
    const m = mount([DIV_OPEN, DIV_OPEN_2]);
    const expected = buildStepOrder(2, "individual");
    expect(expected, "premise: Entries is a step here").toHaveLength(5);
    expect(stepNav(m).order).toEqual(expected);
    expect(stepNav(m).currentIndex).toBe(0);
    fillWho(m);
    m.clickByText("Next"); // -> ENTRIES
    expect(stepNav(m).currentIndex).toBe(1);
  });

  it("one open individual division (Entries collapses): the 4-step order — the total the rail shows is the walked list, not 5", () => {
    const m = mount([DIV_OPEN]);
    const expected = buildStepOrder(1, "individual");
    expect(expected, "premise: Entries is gone here").toHaveLength(4);
    expect(stepNav(m).order).toEqual(expected);
  });

  it("onJump is wired (not left undefined): jumping back from Entries re-opens Contact with what was typed still there", () => {
    const m = mount([DIV_OPEN, DIV_OPEN_2]);
    fillWho(m);
    m.clickByText("Next"); // -> ENTRIES
    expect(typeof stepNav(m).onJump, "onJump must be a function, or no finished step is ever a button").toBe("function");
    stepNav(m).onJump!(0);
    expect(stepNav(m).currentIndex).toBe(0);
    const contact = propsOf(m.stepWho()).contact as { name: string; email: string };
    expect(contact.name).toBe("Alex Test");
    expect(contact.email).toBe("alex@example.com");
  });

  it("jumping lands on the step asked for, not just 'the one before': Details -> Entries, then -> Contact, and Next still walks forward from there", () => {
    const m = mount([DIV_OPEN, DIV_OPEN_2]);
    fillWho(m);
    m.clickByText("Next"); // -> ENTRIES
    (propsOf(m.divisionCard("div-open")).onAddIndividual as () => void)();
    m.clickByText("Next"); // -> DETAILS
    expect(stepNav(m).currentIndex).toBe(2);
    stepNav(m).onJump!(1);
    expect(stepNav(m).currentIndex, "one step back").toBe(1);
    expect(m.island.tree().some((e) => e.type === EntryCart), "that is the ENTRIES step").toBe(true);
    stepNav(m).onJump!(0);
    expect(stepNav(m).currentIndex, "two steps back").toBe(0);
    m.stepWho();
    m.clickByText("Next"); // forward again: still ENTRIES, with the cart intact
    expect(stepNav(m).currentIndex).toBe(1);
    expect(m.entryCartCart().entries, "the entry added before jumping is still there").toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Registration redesign B2 T8 (spec §7.2) — the action bar. One DOM: a single `reg-bar` holds Back, the running total and the one forward
// button, sticky on a phone and a plain row from `md`. Driven through the real stepper, read off the element tree it mounts: the pure
// pieces (labels, count, total) come from the stepper's own state, so a test that hands the bar its props would prove the bar and miss
// the seam (AGENTS.md recurring class 1). Expected words are the spec's own literals, never read back out of the dictionary the code reads.
// Sport: not applicable (the register form is sport-agnostic).
// ---------------------------------------------------------------------------

describe("B2 T8 — action bar: Back, named Continue, running total, one forward button", () => {
  type M = ReturnType<typeof mount>;
  type Island = M["island"];
  const DIV_PAID_2: DivisionLike = { ...DIV_PAID, division_id: "div-paid-2", name: "Paid Doubles" };
  const DIV_PAY_LATER_T8: DivisionLike = { ...DIV_PAID, division_id: "div-later-t8", name: "Pay Later T8", payment_method: "offline" };

  const all = (island: Island, id: string) => island.tree().filter((e) => propsOf(e)["data-testid"] === id);
  const one = (island: Island, id: string) => {
    const hits = all(island, id);
    expect(hits, `exactly one [data-testid=${id}]`).toHaveLength(1);
    return hits[0]!;
  };
  const nextLabel = (island: Island) => textOf(one(island, "reg-next"));
  const fillWho = (m: M) => (propsOf(m.stepWho()).onChange as (p: object) => void)({ name: "Alex Test", email: "alex@example.com" });
  const consent = (m: M) =>
    (propsOf(byId(m.island, "reg-consent-privacy")).onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: true } });
  const addEntry = (m: M, divisionId: string) => (propsOf(m.divisionCard(divisionId)).onAddIndividual as () => void)();

  /** Walks the 4-step form (one open division collapses Entries away) to Review. */
  function reachReview(division: DivisionLike): M {
    const m = mount([division]);
    fillWho(m);
    m.clickByText("Next"); // -> DETAILS
    setByAriaLabel(m.island, "Player 1 — Your name", "Alex Test");
    m.clickByText("Next"); // -> CONSENT
    consent(m);
    m.clickByText("Next"); // -> REVIEW
    return m;
  }

  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
  async function startSubmit(island: Island) {
    const post = deferred<unknown>();
    apiV1Mock.impl.mockReturnValueOnce(post.promise);
    const done = (propsOf(one(island, "reg-submit")).onClick as () => Promise<void>)();
    await vi.waitFor(() => expect(apiV1Mock.impl, "the POST is in flight").toHaveBeenCalledTimes(1));
    return { post, done };
  }
  const WITH_CHECKOUT = {
    group_id: "g1", ref_code: "SZ-T8-01", access_token: "tok1", currency: "gbp", entries: [],
    amount_cents: 2500, checkout_url: "https://checkout.stripe.com/pay/xyz",
  };

  it("Back is absent on the first step, present and enabled from the second, absent again after going back to the first", () => {
    const m = mount([DIV_OPEN, DIV_OPEN_2]);
    expect(all(m.island, "reg-back"), "step 1: no Back at all (absent, not disabled)").toHaveLength(0);
    fillWho(m);
    m.clickByText("Next"); // -> ENTRIES
    const back = one(m.island, "reg-back");
    expect(propsOf(back).disabled, "step 2: an enabled Back").not.toBe(true);
    expect(textOf(back)).toBe("Back");
    m.clickByText("Back"); // -> WHO
    expect(all(m.island, "reg-back"), "back on step 1: absent again").toHaveLength(0);
  });

  it("the forward button names the NEXT step on every step of the 5-step form, and Review has no forward button but the submit", () => {
    const m = mount([DIV_OPEN, DIV_OPEN_2]);
    const seen: string[] = [];
    seen.push(nextLabel(m.island)); // WHO
    fillWho(m);
    m.clickByText("Next"); // -> ENTRIES
    seen.push(nextLabel(m.island));
    addEntry(m, "div-open");
    m.clickByText("Next"); // -> DETAILS
    seen.push(nextLabel(m.island));
    setByAriaLabel(m.island, "Player 1 — Your name", "Alex Test");
    m.clickByText("Next"); // -> CONSENT
    seen.push(nextLabel(m.island));
    consent(m);
    m.clickByText("Next"); // -> REVIEW
    expect(seen, "anti-vacuity: four labels read, one per non-final step").toEqual([
      "Continue to Entries",
      "Continue to Details",
      "Continue to Consent",
      "Continue to Review",
    ]);
    expect(all(m.island, "reg-next"), "Review: no reg-next").toHaveLength(0);
    expect(textOf(one(m.island, "reg-submit"))).toBe("Enter the competition");
  });

  it("the 4-step form (one open division, Entries collapsed) skips Entries in the words too: Contact says Details", () => {
    const m = mount([DIV_OPEN]);
    const seen = [nextLabel(m.island)]; // WHO
    fillWho(m);
    m.clickByText("Next");
    seen.push(nextLabel(m.island)); // DETAILS
    setByAriaLabel(m.island, "Player 1 — Your name", "Alex Test");
    m.clickByText("Next");
    seen.push(nextLabel(m.island)); // CONSENT
    expect(seen).toEqual(["Continue to Details", "Continue to Consent", "Continue to Review"]);
  });

  it("exactly one reg-next on each non-final step and exactly one reg-submit on Review: one DOM, no phone twin", () => {
    const m = mount([DIV_OPEN, DIV_OPEN_2]);
    let checked = 0;
    const expectCounts = (next: number, submit: number, back: number, where: string) => {
      expect(all(m.island, "reg-next"), `${where}: reg-next`).toHaveLength(next);
      expect(all(m.island, "reg-submit"), `${where}: reg-submit`).toHaveLength(submit);
      expect(all(m.island, "reg-back"), `${where}: reg-back`).toHaveLength(back);
      expect(all(m.island, "reg-bar"), `${where}: reg-bar`).toHaveLength(1);
      checked++;
    };
    expectCounts(1, 0, 0, "WHO");
    fillWho(m);
    m.clickByText("Next");
    expectCounts(1, 0, 1, "ENTRIES");
    addEntry(m, "div-open");
    m.clickByText("Next");
    expectCounts(1, 0, 1, "DETAILS");
    setByAriaLabel(m.island, "Player 1 — Your name", "Alex Test");
    m.clickByText("Next");
    expectCounts(1, 0, 1, "CONSENT");
    consent(m);
    m.clickByText("Next");
    expectCounts(0, 1, 1, "REVIEW");
    expect(checked, "anti-vacuity: all five steps were counted").toBe(5);
    // The bar carries the three controls: they are inside `reg-bar`, not siblings of it.
    const inBar = walk(one(m.island, "reg-bar"));
    expect(inBar.some((e) => propsOf(e)["data-testid"] === "reg-submit")).toBe(true);
    expect(inBar.some((e) => propsOf(e)["data-testid"] === "reg-back")).toBe(true);
  });

  // One mount per test: the stepper restores its draft from sessionStorage, so a second mount in the same test would start on Review.
  it.each([
    { name: "card cart", division: DIV_PAID, words: "Pay £25.00 and enter" },
    { name: "free cart", division: DIV_OPEN, words: "Enter the competition" },
    { name: "offline fee", division: DIV_PAY_LATER_T8, words: "Enter — £25.00" },
  ])("Review's button, $name: $words", ({ division, words }) => {
    expect(textOf(one(reachReview(division).island, "reg-submit"))).toBe(words);
  });

  it("the running total: absent for an empty cart and a free cart, then 1 entry · £25.00, 2 entries · £50.00, and back down when one is removed", () => {
    const m = mount([DIV_PAID, DIV_PAID_2, DIV_OPEN]);
    fillWho(m);
    m.clickByText("Next"); // -> ENTRIES
    expect(all(m.island, "reg-bar-summary"), "empty cart: no summary").toHaveLength(0);

    addEntry(m, "div-open");
    expect(m.entryCartCart().entries, "premise: one free entry in the cart").toHaveLength(1);
    expect(all(m.island, "reg-bar-summary"), "a free cart: no summary").toHaveLength(0);

    addEntry(m, "div-paid");
    expect(textOf(one(m.island, "reg-bar-summary")), "one paid entry, one free: the entries count includes both").toBe("2 entries · £25.00");
    addEntry(m, "div-paid-2");
    expect(textOf(one(m.island, "reg-bar-summary"))).toBe("3 entries · £50.00");

    const cartEl = m.island.tree().find((e) => e.type === EntryCart)!;
    const ids = m.entryCartCart().entries.map((e) => e.id);
    (propsOf(cartEl).dispatch as (a: object) => void)({ type: "REMOVE_ENTRY", id: ids[0] });
    (propsOf(m.island.tree().find((e) => e.type === EntryCart)!).dispatch as (a: object) => void)({ type: "REMOVE_ENTRY", id: ids[1] });
    expect(textOf(one(m.island, "reg-bar-summary")), "singular for one entry").toBe("1 entry · £25.00");
  });

  // B3 T12 (spec §4.1; plan Review Focus 2) — the seam from the cart to what the person SEES. The card, the cart row, the Review row,
  // the total and the Pay button are five readers of one verdict; this drives the real stepper from the first Add to Review and
  // reads each of them, because a verdict nobody renders is the inert seam the wave exists to avoid.
  it("a division with ONE place left, two entries: the second reads 'Waiting list — not charged now' on the cart and on Review, and the total and Pay button carry ONE fee", () => {
    const ONE_LEFT: DivisionLike = { ...DIV_PAID, division_id: "div-one-left", name: "Last Place", capacity: 8, remaining: 1, taken: 7, waitlisted: 0 };
    const m = mount([ONE_LEFT, DIV_OPEN]);
    fillWho(m);
    m.clickByText("Next"); // -> ENTRIES
    const cardText = () => textOf(walk((DivisionCard as unknown as ComponentFn)(propsOf(m.divisionCard("div-one-left")))));
    expect(cardText(), "before any entry: one place left, an ordinary Add").toContain("1 place left");
    expect(cardText()).toContain("Add an entry");

    addEntry(m, "div-one-left");
    expect(propsOf(m.divisionCard("div-one-left")).inCart, "the card is told what the cart holds").toBe(1);
    expect(cardText(), "the cart took the last place: the card now says so").toContain("Join waiting list");
    expect(m.entryCartText(), "one entry: it holds the place").not.toContain("Waiting list — not charged now");

    addEntry(m, "div-one-left");
    // Counted as ELEMENTS (the line's own testid), not as text matches: `textOf` over a flat `walk` repeats every nested element's text.
    const waitingLines = walk((EntryCart as unknown as ComponentFn)(propsOf(m.island.tree().find((e) => e.type === EntryCart)!))).filter((e) => propsOf(e)["data-testid"] === "reg-cart-waitlist");
    expect(waitingLines.map((e) => textOf(e)), "the cart labels exactly one entry, with the copy").toEqual(["Waiting list — not charged now"]);
    expect(textOf(one(m.island, "reg-bar-summary")), "two entries, ONE fee").toBe("2 entries · £25.00");

    m.clickByText("Next"); // -> DETAILS
    const names = allByAriaLabel(m.island, "Player 1 — Your name");
    expect(names, "premise: a row per entry").toHaveLength(2);
    names.forEach((n, i) => (propsOf(n).onChange as (e: { target: { value: string } }) => void)({ target: { value: `Player ${i + 1}` } }));
    m.clickByText("Next"); // -> CONSENT
    consent(m);
    m.clickByText("Next"); // -> REVIEW

    const rows = walk(one(m.island, "reg-review-entries")).filter((e) => e.type === "li").map((e) => textOf(e));
    expect(rows, "premise: both entries are on Review").toHaveLength(2);
    expect(rows[0], "the first entry holds the place").not.toContain("Waiting list — not charged now");
    expect(rows[0]).toContain("pay by card at sign-up");
    expect(rows[1], "the second is on the waiting list").toContain("Waiting list — not charged now");
    expect(rows[1], "and has no payment method to name").not.toContain("pay by card at sign-up");
    expect(textOf(one(m.island, "reg-review-total")), "the total is one fee").toBe("£25.00");
    expect(textOf(one(m.island, "reg-submit")), "and the button names that same fee").toBe("Pay £25.00 and enter");
  });

  it("with the first entry removed the second takes the place: no waiting label, and still one fee", () => {
    const ONE_LEFT: DivisionLike = { ...DIV_PAID, division_id: "div-one-left", name: "Last Place", capacity: 8, remaining: 1, taken: 7, waitlisted: 0 };
    const m = mount([ONE_LEFT, DIV_OPEN]);
    fillWho(m);
    m.clickByText("Next"); // -> ENTRIES
    addEntry(m, "div-one-left");
    addEntry(m, "div-one-left");
    expect(m.entryCartText()).toContain("Waiting list — not charged now");
    const first = m.entryCartCart().entries[0]!.id;
    (propsOf(m.island.tree().find((e) => e.type === EntryCart)!).dispatch as (a: object) => void)({ type: "REMOVE_ENTRY", id: first });
    expect(m.entryCartCart().entries, "premise: one entry left").toHaveLength(1);
    expect(m.entryCartText(), "no stale 'waiting' label on the one that moved up").not.toContain("Waiting list — not charged now");
    expect(textOf(one(m.island, "reg-bar-summary"))).toBe("1 entry · £25.00");
  });

  // B3 T12 (B2 review m3) - the forward button says what submit will DO. Driven through the real stepper to Review; the producer is the
  // cart's own verdict (summarizeCart), the consumer is the words on the button.
  it("a cart whose every entry waits: the Review button says 'Join the waiting list', not the free label", () => {
    const m = reachReview(DIV_WAITLIST);
    const rows = walk(one(m.island, "reg-review-entries")).filter((e) => e.type === "li").map((e) => textOf(e));
    expect(rows.length, "premise: Review lists an entry").toBeGreaterThan(0);
    expect(rows.every((r) => r.includes("Waiting list — not charged now")), "premise: every listed entry waits").toBe(true);
    expect(textOf(one(m.island, "reg-submit"))).toBe("Join the waiting list");
    expect(textOf(one(m.island, "reg-review-total")), "and nothing is charged now").not.toContain("£10");
  });

  it("a cart with one charged entry and one waiting entry still says Pay, and quotes the CHARGED total only", () => {
    const m = mount([DIV_PAID, DIV_WAITLIST]);
    fillWho(m);
    m.clickByText("Next"); // -> ENTRIES
    addEntry(m, "div-paid");
    addEntry(m, "div-wait");
    m.clickByText("Next"); // -> DETAILS
    allByAriaLabel(m.island, "Player 1 — Your name").forEach((n, i) =>
      (propsOf(n).onChange as (e: { target: { value: string } }) => void)({ target: { value: `Player ${i + 1}` } }),
    );
    m.clickByText("Next"); // -> CONSENT
    consent(m);
    m.clickByText("Next"); // -> REVIEW
    const rows = walk(one(m.island, "reg-review-entries")).filter((e) => e.type === "li").map((e) => textOf(e));
    expect(rows, "premise: one charged entry and one waiting entry").toHaveLength(2);
    expect(rows.filter((r) => r.includes("Waiting list — not charged now")), "premise: exactly one waits").toHaveLength(1);
    // £25 charged + £10 waiting: the label carries the first only (a label that summed both would read £35.00).
    expect(textOf(one(m.island, "reg-submit"))).toBe("Pay £25.00 and enter");
  });

  it("the waiting-list button is sized to its own label (the width sizer reads the same label the button shows)", () => {
    const m = reachReview(DIV_WAITLIST);
    const btn = one(m.island, "reg-submit");
    const sizer = walk(btn).find((e) => propsOf(e)["data-widest"] !== undefined);
    expect(sizer, "the label sits in a sizer span that carries data-widest").toBeTruthy();
    const widest = String(propsOf(sizer!)["data-widest"]);
    expect("Join the waiting list".length, "premise: the idle label is the longer of the two phases").toBeGreaterThan("Saving your place…".length);
    expect(widest, "the sizer holds the longest label this cart will show, which is the idle one").toBe("Join the waiting list");
  });

  // Owner ruling 2026-11-13: Review's heading says "and pay" only when something is charged now. The expected words are the ruling's.
  it.each([
    { name: "a card cart", division: DIV_PAID, want: "Review and pay" },
    { name: "a pay-the-organiser cart", division: DIV_PAY_LATER_T8, want: "Review and pay" },
    { name: "a free cart", division: DIV_OPEN, want: "Review" },
    { name: "a cart whose every entry waits (the full division has a price of its own)", division: DIV_WAITLIST, want: "Review" },
  ])("Review's heading for $name reads '$want'", ({ division, want }) => {
    const m = reachReview(division);
    expect(onReviewStep(m.island), "premise: on Review").toBe(true);
    expect(stepHeading(m.island)).toBe(want);
  });

  it("a mixed cart (one charged entry, one waiting) is still 'Review and pay'", () => {
    const m = mount([DIV_PAID, DIV_WAITLIST]);
    fillWho(m);
    m.clickByText("Next"); // -> ENTRIES
    addEntry(m, "div-paid");
    addEntry(m, "div-wait");
    m.clickByText("Next"); // -> DETAILS
    allByAriaLabel(m.island, "Player 1 — Your name").forEach((n, i) =>
      (propsOf(n).onChange as (e: { target: { value: string } }) => void)({ target: { value: `Player ${i + 1}` } }),
    );
    m.clickByText("Next"); // -> CONSENT
    consent(m);
    m.clickByText("Next"); // -> REVIEW
    expect(onReviewStep(m.island), "premise: on Review").toBe(true);
    expect(stepHeading(m.island)).toBe("Review and pay");
    // The waiting entry's row says it waits INSTEAD of "Free": it is not free, it is not charged yet (owner ruling 2026-11-13).
    const rows = walk(one(m.island, "reg-review-entries")).filter((e) => e.type === "li").map((e) => textOf(e));
    expect(rows, "premise: two entries").toHaveLength(2);
    const waiting = rows.filter((r) => r.includes("Waiting list — not charged now"));
    expect(waiting, "premise: exactly one waits").toHaveLength(1);
    expect(waiting[0], "the waiting row is not labelled Free").not.toContain("Free");
    expect(waiting[0], "nor does it show a price (the division's £10.00 is not charged)").not.toMatch(/£\d/);
    const charged = rows.filter((r) => !r.includes("Waiting list — not charged now"));
    expect(charged[0], "its pair: the charged row carries its fee").toContain("£25.00");
  });

  it("a cart whose every entry waits lists no 'Free' anywhere on its Review rows", () => {
    const m = reachReview(DIV_WAITLIST);
    const rows = walk(one(m.island, "reg-review-entries")).filter((e) => e.type === "li").map((e) => textOf(e));
    expect(rows.length, "premise: Review lists an entry").toBeGreaterThan(0);
    for (const r of rows) {
      expect(r).toContain("Waiting list — not charged now");
      expect(r).not.toContain("Free");
      expect(r, "no price either: the full division's own fee is not charged").not.toMatch(/£\d/);
    }
  });

  it("a free entry's row still says Free (the waiting-row rule did not swallow it)", () => {
    const m = reachReview(DIV_OPEN);
    const rows = walk(one(m.island, "reg-review-entries")).filter((e) => e.type === "li").map((e) => textOf(e));
    expect(rows, "premise: one entry").toHaveLength(1);
    expect(rows[0]).toContain("Free");
  });

  it("every locale words the plain heading, and differently from 'Review and pay'", () => {
    let checked = 0;
    for (const loc of ["en", "es", "fr", "nl"]) {
      const d = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "dictionaries", loc, "ui.json"), "utf8")) as Record<string, string>;
      expect(d["register.review.headingPlain"], `${loc}: the plain heading`).toBeTruthy();
      expect(d["register.review.headingPlain"], `${loc}: it is not the 'and pay' heading`).not.toBe(d["register.review.heading"]);
      checked++;
    }
    expect(checked, "anti-vacuity: all four locales").toBe(4);
  });

  it("the running total shows on every step once the cart is payable, not only on Entries (the seeded single division on Contact)", () => {
    const m = mount([DIV_PAID]);
    expect(textOf(one(m.island, "reg-bar-summary"))).toBe("1 entry · £25.00");
    fillWho(m);
    m.clickByText("Next"); // -> DETAILS
    expect(textOf(one(m.island, "reg-bar-summary"))).toBe("1 entry · £25.00");
  });

  it("a free single-division cart shows no running total on any step", () => {
    const m = mount([DIV_OPEN]);
    expect(all(m.island, "reg-bar-summary")).toHaveLength(0);
    fillWho(m);
    m.clickByText("Next");
    expect(all(m.island, "reg-bar-summary")).toHaveLength(0);
  });

  it("in flight, Back and the stepper's jump are both disabled (saving AND opening payment) and come back after a failure", async () => {
    const { island } = reachReview(DIV_PAID);
    // Premise: before the click both are live, so the in-flight assertions below are a CHANGE, not a constant.
    expect(propsOf(one(island, "reg-back")).disabled, "idle: Back is live").not.toBe(true);
    expect(typeof stepNavFor(island).onJump, "idle: the rail's jump is wired").toBe("function");

    const first = await startSubmit(island);
    expect(propsOf(one(island, "reg-back")).disabled, "saving: Back is disabled").toBe(true);
    expect(stepNavFor(island).onJump, "saving: no finished step is a button").toBeUndefined();
    first.post.reject(new ApiV1Error("Boom", 500, "INTERNAL"));
    await first.done;
    expect(propsOf(one(island, "reg-back")).disabled, "after a failure: Back is live again").not.toBe(true);
    expect(typeof stepNavFor(island).onJump, "after a failure: the jump is live again").toBe("function");

    apiV1Mock.impl.mockReset();
    const seen: { backDisabled: boolean; jump: unknown }[] = [];
    assignMock.mockImplementation(() => {
      seen.push({ backDisabled: propsOf(one(island, "reg-back")).disabled === true, jump: stepNavFor(island).onJump });
    });
    const second = await startSubmit(island);
    second.post.resolve(WITH_CHECKOUT);
    await second.done;
    expect(seen, "anti-vacuity: the navigation happened once").toHaveLength(1);
    expect(seen[0]!.backDisabled, "opening payment: Back is disabled").toBe(true);
    expect(seen[0]!.jump, "opening payment: no finished step is a button").toBeUndefined();
  });

  function stepNavFor(island: Island) {
    const el = island.tree().find((e) => e.type === StepNav);
    expect(el, "StepNav is not in the stepper's tree").toBeTruthy();
    return propsOf(el!) as { onJump?: (i: number) => void };
  }

  it("the submit button keeps one width through idle, saving and opening payment: same box classes, same width-sizing label", async () => {
    const { island } = reachReview(DIV_PAID);
    const read = () => {
      const btn = one(island, "reg-submit");
      const sizer = walk(btn).find((e) => propsOf(e)["data-widest"] !== undefined);
      expect(sizer, "the label sits in a sizer span that carries data-widest").toBeTruthy();
      const text = walk(sizer!).find((e) => e !== sizer && textOf(e) === textOf(btn));
      expect(text, "the visible label is its own span inside the sizer, in the ghost's cell").toBeTruthy();
      return {
        cls: String(propsOf(btn).className),
        sizerCls: String(propsOf(sizer!).className),
        textCls: String(propsOf(text!).className),
        widest: String(propsOf(sizer!)["data-widest"]),
        label: textOf(btn),
      };
    };
    const idle = read();
    const seen: ReturnType<typeof read>[] = [];
    assignMock.mockImplementation(() => void seen.push(read()));
    const run = await startSubmit(island);
    const saving = read();
    run.post.resolve(WITH_CHECKOUT);
    await run.done;
    const opening = seen[0]!;
    expect(seen, "anti-vacuity: the navigation happened once").toHaveLength(1);

    expect([idle.label, saving.label, opening.label], "premise: the three phases do read three different labels").toEqual([
      "Pay £25.00 and enter",
      "Saving your place…",
      "Opening secure payment…",
    ]);
    expect(saving.cls).toBe(idle.cls);
    expect(opening.cls).toBe(idle.cls);
    expect(saving.widest).toBe(idle.widest);
    expect(opening.widest).toBe(idle.widest);
    // The sizer holds the LONGEST label of the three, which is not the idle one — so a sizer that tracked the current label would differ.
    const longest = [idle.label, saving.label, opening.label].reduce((a, b) => (b.length > a.length ? b : a));
    expect(idle.widest).toBe(longest);
    expect(idle.widest, "premise: the longest label is not the idle one").not.toBe(idle.label);
    // The ghost: the span's ::after draws data-widest, invisibly, in the SAME grid cell as the visible label — so the cell is as wide
    // and as tall as the longest label (the cell: after:col-start-1 / after:row-start-1, and the label's own col-start-1 / row-start-1).
    expect(idle.sizerCls).toMatch(/(?:^|\s)grid(?:\s|$)/);
    expect(idle.sizerCls).toMatch(/after:content-\[attr\(data-widest\)\]/);
    expect(idle.sizerCls).toMatch(/after:invisible/);
    expect(idle.sizerCls).toMatch(/after:col-start-1/);
    expect(idle.sizerCls).toMatch(/after:row-start-1/);
    expect(idle.sizerCls, "a zero-height ghost would size the width only; a wrapped label at 320 would still grow the bar").not.toMatch(/after:h-0/);
    expect(idle.textCls).toMatch(/(?:^|\s)col-start-1(?:\s|$)/);
    expect(idle.textCls).toMatch(/(?:^|\s)row-start-1(?:\s|$)/);
  });

  it("the bar is sticky and safe-area padded on a phone, a plain row from md, and the forward button fills the phone row", () => {
    const m = mount([DIV_PAID]); // a payable cart, so the running total is on screen too
    const cls = String(propsOf(one(m.island, "reg-bar")).className);
    expect(cls).toMatch(/(?:^|\s)max-md:sticky(?:\s|$)/);
    expect(cls).toMatch(/(?:^|\s)max-md:bottom-0(?:\s|$)/);
    expect(cls).toContain("env(safe-area-inset-bottom)");
    expect(cls, "no bare `sticky` that would stay sticky from md").not.toMatch(/(?:^|\s)sticky(?:\s|$)/);
    // B2 review (shadow): the bar wears the step cards' own shadow token, not a one-off arbitrary value (`shadow-[...]`).
    expect(cls, "the bar's shadow is the cards' token").toMatch(/(?:^|\s)max-md:shadow-sm(?:\s|$)/);
    expect(cls, "and no arbitrary shadow value").not.toMatch(/shadow-\[/);
    expect(String(propsOf(one(m.island, "reg-next")).className)).toMatch(/(?:^|\s)max-md:flex-1(?:\s|$)/);
    // The running total is for a phone: from md the page itself carries the totals.
    expect(String(propsOf(one(m.island, "reg-bar-summary")).className)).toMatch(/(?:^|\s)md:hidden(?:\s|$)/);
  });

  // Review Focus 5 (the sticky bar must not cover the focused field). A browser counts a control sitting behind the bar as already
  // visible, so a focus leaves it there; a scroll margin on the controls is what moves it clear. Measured in Chromium against the bar's
  // real classes: focusing a field hidden behind it left it hidden without the margin and 31px clear of the bar with it. The tallest the
  // bar gets is 109px (320 to 430, a two-line label plus the total line), so the margin must reach at least that.
  it("the controls under the stepper root keep a scroll margin at least as tall as the bar (109px at its worst), below md only", () => {
    const m = mount([DIV_OPEN]);
    const root = m.island.tree().find((e) => propsOf(e)["data-register-flow"] !== undefined)!;
    const cls = String(propsOf(root).className);
    const rule = cls.match(/(?:^|\s)max-md:\[&_:is\(([^)]*)\)\]:scroll-mb-(\d+)(?:\s|$)/);
    expect(rule, `no max-md scroll-mb rule on the root: ${cls}`).not.toBeNull();
    const controls = rule![1]!.split(",");
    for (const tag of ["input", "select", "textarea", "button"]) expect(controls, `${tag} keeps the margin`).toContain(tag);
    expect(Number(rule![2]) * 4, "the margin (Tailwind spacing N = N x 4px)").toBeGreaterThanOrEqual(109);
  });

  it("the stepper root carries data-register-flow (the marker the org header's phone scroll-away keys on)", () => {
    const m = mount([DIV_OPEN]);
    const root = m.island.tree()[0]!;
    expect(propsOf(root)["data-register-flow"], "the root element is the marker's carrier").not.toBeUndefined();
    expect(m.island.tree().filter((e) => propsOf(e)["data-register-flow"] !== undefined), "exactly one marker").toHaveLength(1);
  });

  it("every locale carries the new keys with their placeholders, and none still carries the two retired labels", () => {
    const locales = ["en", "es", "fr", "nl"];
    let checked = 0;
    for (const loc of locales) {
      const d = JSON.parse(
        readFileSync(join(__dirname, "..", "..", "..", "..", "dictionaries", loc, "ui.json"), "utf8"),
      ) as Record<string, string>;
      expect(d["register.nav.continueTo"], `${loc}: continueTo`).toContain("{step}");
      expect(d["register.submit.pay"], `${loc}: pay`).toContain("{fee}");
      expect(d["register.submit.waitlist"], `${loc}: the waiting-list button is worded`).toBeTruthy();
      expect(d["register.submit.waitlist"], `${loc}: it quotes no fee (nothing is charged now)`).not.toContain("{fee}");
      expect(d["register.submit.waitlist"], `${loc}: it is not the free label`).not.toBe(d["register.submit.free"]);
      expect(d["register.bar.summary.one"], `${loc}: summary.one`).toMatch(/\{count\}.*\{total\}/);
      expect(d["register.bar.summary.other"], `${loc}: summary.other`).toMatch(/\{count\}.*\{total\}/);
      expect(d["register.submit.card"], `${loc}: the retired card label is gone`).toBeUndefined();
      expect(d["register.nav.next"], `${loc}: the retired Next label is gone`).toBeUndefined();
      checked++;
    }
    expect(checked, "anti-vacuity: all four locales").toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Registration redesign B2 T9 — Contact and Details polish. Driven through the REAL stepper: the producers are the Contact inputs and
// the Continue click, the consumers are what the registrant reads (the summary, the field state, the Details row, the questions).
// ---------------------------------------------------------------------------

describe("B2 T9 — Contact: error summary, invalid fields, the playing card", () => {
  type M = ReturnType<typeof mount>;
  const DIV_BOTH: DivisionLike = { ...DIV_OPEN, division_id: "div-both-t9", name: "Open Masters", requires_dob: true, requires_gender: true };

  const setWho = (m: M, patch: object) => (propsOf(m.stepWho()).onChange as (p: object) => void)(patch);
  const setPlaying = (m: M, v: boolean) => (propsOf(m.stepWho()).onImPlayingChange as (v: boolean) => void)(v);
  const summaries = (m: M) => m.island.tree().filter((e) => propsOf(e)["data-testid"] === "reg-who-error-summary");
  const alerts = (m: M) => m.island.tree().filter((e) => propsOf(e).role === "alert");
  /** The stepper's own ref, as StepWho receives it, holding a stand-in for the element React attaches: the harness has no DOM, so
   *  nothing else would ever put an element there. A `focus` call on it is the stepper asking for focus. */
  function armFocus(m: M) {
    const ref = propsOf(m.stepWho()).summaryRef as { current: unknown } | undefined;
    expect(ref, "StepWho is handed the stepper's focus ref").toBeTruthy();
    const focus = vi.fn();
    ref!.current = { focus };
    return { ref: ref!, focus };
  }

  it("a failed Continue on Contact focuses a summary naming both missing fields (focus announces it, a live region would not be needed)", () => {
    const m = mount([DIV_OPEN]);
    expect(summaries(m), "pristine: nothing is wrong yet, so no alert").toHaveLength(0);
    const { ref, focus } = armFocus(m);

    m.clickByText("Next");

    expect(summaries(m), "exactly one summary").toHaveLength(1);
    const summary = summaries(m)[0]!;
    // Announced by FOCUS, once, and by nothing else: a live region (`role="alert"`, `aria-live`) would announce it a second time when it
    // appears and again every time its recomputed text changes while the person types the fix (B2 review m2).
    expect(propsOf(summary).role, "not an assertive live region").toBeUndefined();
    expect(propsOf(summary)["aria-live"], "not a polite one either").toBeUndefined();
    expect(alerts(m), "no live region on the card at all").toHaveLength(0);
    expect(textOf(summary)).toBe("2 things to fix before you continue: Your name, Email");
    expect(propsOf(summary).tabIndex, "focusable by script, out of the Tab order").toBe(-1);
    expect(propsOf(summary).ref, "the element the stepper's ref attaches to").toBe(ref);
    expect(focus, "and Continue asked for focus on it").toHaveBeenCalledTimes(1);
  });

  it("typing the fix updates the summary's text but moves no focus and adds no announcement (it stays readable, and quiet)", () => {
    const m = mount([DIV_OPEN]);
    const { focus } = armFocus(m);
    m.clickByText("Next");
    expect(focus, "premise: the failed Continue focused it once").toHaveBeenCalledTimes(1);
    expect(textOf(summaries(m)[0]!), "premise: two things are wrong").toBe("2 things to fix before you continue: Your name, Email");

    setWho(m, { name: "Alex Test" }); // typing, no Continue
    expect(textOf(summaries(m)[0]!), "the text follows the typing, so what is on screen is never stale").toBe("1 thing to fix before you continue: Email");
    expect(focus, "typing never asks for focus again").toHaveBeenCalledTimes(1);
    expect(alerts(m), "and nothing on the card is a live region that would read the new text aloud mid-typing").toHaveLength(0);
    expect(propsOf(summaries(m)[0]!)["aria-live"]).toBeUndefined();
  });

  it("every failed Continue focuses it again, a fixed field drops out of it, and a Continue that passes does not", () => {
    const m = mount([DIV_OPEN]);
    const { focus } = armFocus(m);
    m.clickByText("Next");
    expect(focus).toHaveBeenCalledTimes(1);

    setWho(m, { name: "Alex Test" });
    m.clickByText("Next");
    expect(textOf(summaries(m)[0]!), "one left, and the sentence says so in the singular").toBe("1 thing to fix before you continue: Email");
    expect(focus, "a SECOND failed Continue focuses it again (a first-time-only effect would stay silent here)").toHaveBeenCalledTimes(2);

    setWho(m, { email: "alex@example.com" });
    m.clickByText("Next"); // valid -> leaves Contact
    expect(summaries(m), "Contact is gone, and its summary with it").toHaveLength(0);
    expect(focus, "a Continue that passes asks for no summary focus").toHaveBeenCalledTimes(2);
  });

  it("with a date of birth and a gender asked for, all four fields are named, in the order they sit on the page", () => {
    const m = mount([DIV_BOTH]);
    setPlaying(m, true);
    m.clickByText("Next");
    expect(textOf(summaries(m)[0]!)).toBe("4 things to fix before you continue: Your name, Email, Date of birth, Gender");
  });

  it("invalid fields carry aria-invalid and are described by their own error text; valid ones carry neither", () => {
    const m = mount([DIV_BOTH]);
    setPlaying(m, true);
    m.clickByText("Next");
    const expected = {
      name: "Enter your name",
      email: "Enter an email address, like name@example.com",
      dob: "Enter your date of birth",
      gender: "Select an option",
    };
    let checked = 0;
    for (const [key, copy] of Object.entries(expected)) {
      const field = byId(m.island, `reg-who-${key}`);
      expect(propsOf(field)["aria-invalid"], `${key} is invalid`).toBe(true);
      expect(propsOf(field)["aria-describedby"], `${key} points at its error`).toBe(`reg-who-${key}-error`);
      expect(textOf(byId(m.island, `reg-who-${key}-error`)), `${key}'s error text`).toBe(copy);
      checked++;
    }
    expect(checked, "anti-vacuity: all four fields checked").toBe(4);
    expect(alerts(m), "no field announces itself, and neither does the summary (focus does): four announcements of the same four problems is noise").toHaveLength(0);

    setWho(m, { name: "Alex Test", email: "alex@example.com", dob: "1990-04-02", gender: "f" });
    for (const key of Object.keys(expected)) {
      const field = byId(m.island, `reg-who-${key}`);
      expect(propsOf(field)["aria-invalid"], `${key} is valid now`).toBeUndefined();
      expect(propsOf(field)["aria-describedby"], `${key} is described by its hint again`).toBe(`reg-who-${key}-hint`);
      expect(byId(m.island, `reg-who-${key}-hint`), `${key}'s hint exists, so the reference is not dangling`).toBeTruthy();
    }
    expect(summaries(m), "and nothing is left to summarise").toHaveLength(0);
    expect(alerts(m)).toHaveLength(0);
  });

  it("the danger border an invalid field gets is part of the shared field token, and every Contact field wears that token", () => {
    expect(FIELD).toMatch(/(?:^|\s)aria-invalid:border-red-600(?:\s|$)/);
    const m = mount([DIV_BOTH]);
    setPlaying(m, true);
    for (const key of ["name", "email", "dob", "gender"]) {
      expect(propsOf(byId(m.island, `reg-who-${key}`)).className, `${key} uses FIELD`).toBe(FIELD);
    }
  });

  it.each([
    ["nothing typed", ""],
    ["not an address", "not-an-email"],
    ["missing the domain", "alex@"],
  ])("the email error shows the example address (%s)", (_label, email) => {
    const m = mount([DIV_OPEN]);
    setWho(m, { name: "Alex Test", email });
    m.clickByText("Next");
    expect(textOf(byId(m.island, "reg-who-email-error"))).toBe("Enter an email address, like name@example.com");
    expect(m.pageText(), "the old wording is gone").not.toContain("Enter a valid email address");
  });

  it("the playing card's label wraps the reg-who-playing input, so a tap on its text toggles it", () => {
    const m = mount([DIV_BOTH]);
    const tree = m.island.tree(); // one expansion: element identity is only stable within it
    const boxes = tree.filter((e) => propsOf(e)["data-testid"] === "reg-who-playing");
    expect(boxes, "one playing checkbox").toHaveLength(1);
    const wrapping = tree.filter((e) => e.type === "label" && walk(e).includes(boxes[0]!));
    expect(wrapping, "exactly one label wraps it").toHaveLength(1);
    const title = "I'm one of the players";
    const body = "We'll put you in as player 1 on every entry, so your results stay together.";
    expect(textOf(wrapping[0]!)).toContain(title);
    expect(textOf(wrapping[0]!)).toContain(body);
    const titleEls = tree.filter((e) => propsOf(e).children === title);
    expect(titleEls, "the title is rendered once").toHaveLength(1);
    expect(walk(wrapping[0]!).includes(titleEls[0]!), "and it is inside that label, not beside it").toBe(true);
    expect(m.pageText(), "the old wording is gone").not.toContain("I'm registering myself");
    // Its pair: the card does something. Ticking it asks for the date of birth the contact's own row will need.
    expect(m.island.tree().some((e) => propsOf(e).id === "reg-who-dob")).toBe(false);
    (propsOf(boxes[0]!).onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    expect(m.island.tree().some((e) => propsOf(e).id === "reg-who-dob"), "ticked: the dob field appears").toBe(true);
  });
});

describe("B2 T9 — Details: one card per entry, the contact's own row, the organiser's questions", () => {
  type M = ReturnType<typeof mount>;
  const setWho = (m: M, patch: object) => (propsOf(m.stepWho()).onChange as (p: object) => void)(patch);
  const setPlaying = (m: M, v: boolean) => (propsOf(m.stepWho()).onImPlayingChange as (v: boolean) => void)(v);
  const NOTE = "That's you. Change it on the Contact step.";
  const rosterNameInputs = (m: M) =>
    m.island
      .tree()
      .filter((e) => propsOf(e)["data-testid"] === "reg-roster-name")
      .sort((a, b) => Number(propsOf(a)["data-player-row"]) - Number(propsOf(b)["data-player-row"]));
  /** Contact filled, optionally playing, then on to Details (one open individual division collapses Entries away). */
  function toDetails(playing: boolean, name = "Mia Cole"): M {
    const m = mount([DIV_OPEN]);
    setWho(m, { name, email: "mia@example.com", dob: "1990-04-02" });
    if (playing) setPlaying(m, true);
    m.clickByText("Next");
    return m;
  }

  it("with imPlaying, Details shows Player 1 read-only as the contact name, with the note", () => {
    const m = toDetails(true);
    const inputs = rosterNameInputs(m);
    expect(inputs, "one row").toHaveLength(1);
    expect(propsOf(inputs[0]!).value).toBe("Mia Cole");
    expect(propsOf(inputs[0]!).readOnly, "the contact's own row cannot be typed over").toBe(true);
    expect(m.pageText()).toContain(NOTE);
  });

  it("without imPlaying, Player 1 is an editable input and there is no note", () => {
    const m = toDetails(false);
    const inputs = rosterNameInputs(m);
    expect(inputs, "one row").toHaveLength(1);
    expect(propsOf(inputs[0]!).readOnly, "someone else is being entered: the row is the registrant's to fill").not.toBe(true);
    expect(propsOf(inputs[0]!).value).toBe("");
    expect(m.pageText()).not.toContain(NOTE);
  });

  it("untick imPlaying after seeing it locked: the row keeps its name but is editable again, and the note goes", () => {
    const m = toDetails(true);
    expect(propsOf(rosterNameInputs(m)[0]!).readOnly, "premise: locked first").toBe(true);
    m.clickByText("Back");
    setPlaying(m, false);
    m.clickByText("Next");
    const inputs = rosterNameInputs(m);
    expect(inputs).toHaveLength(1);
    expect(propsOf(inputs[0]!).readOnly).not.toBe(true);
    expect(propsOf(inputs[0]!).value, "the seeded name is the registrant's to keep or change").toBe("Mia Cole");
    expect(m.pageText()).not.toContain(NOTE);
  });

  // B2 T10 (supersedes T9's "the seed fills blanks only"): a row the seed filled and the registrant never touched follows a Contact
  // rename, so "That's you" stays true after it; a row the registrant typed over is theirs and is never overwritten. Both directions,
  // through the real stepper: the producer is the Contact input, the consumer is the Details row the registrant reads.
  it("a contact renamed after the row was seeded: the untouched row follows, stays locked and still says 'That's you'", () => {
    const m = toDetails(true);
    expect(propsOf(rosterNameInputs(m)[0]!).readOnly, "premise: locked first").toBe(true);
    m.clickByText("Back");
    setWho(m, { name: "Mia Colette" });
    m.clickByText("Next");
    const inputs = rosterNameInputs(m);
    expect(inputs, "one row").toHaveLength(1);
    expect(propsOf(inputs[0]!).value, "the seeded row followed the rename").toBe("Mia Colette");
    expect(propsOf(inputs[0]!).readOnly, "and is the contact's own row again: locked").toBe(true);
    expect(m.pageText()).toContain(NOTE);
  });

  it("a row the registrant typed over the seed is never overwritten by a later rename: it stays, editable, with no note", () => {
    const m = toDetails(true);
    m.clickByText("Back");
    setPlaying(m, false); // the row is theirs to edit once it no longer claims to be the contact
    m.clickByText("Next");
    (propsOf(rosterNameInputs(m)[0]!).onChange as (e: { target: { value: string } }) => void)({ target: { value: "Amelia Cole" } });
    m.clickByText("Back");
    setPlaying(m, true);
    setWho(m, { name: "Mia Colette" });
    m.clickByText("Next");
    const inputs = rosterNameInputs(m);
    expect(inputs).toHaveLength(1);
    expect(propsOf(inputs[0]!).value, "the typed name survives the rename").toBe("Amelia Cole");
    expect(propsOf(inputs[0]!).readOnly, "it is not the contact's name, so it is not locked").not.toBe(true);
    expect(m.pageText()).not.toContain(NOTE);
  });

  const FIELDS: FormFieldDef[] = [
    { key: "shirt", label: "Shirt size", kind: "text", required: false },
    { key: "emergency", label: "Emergency contact", kind: "text", required: true },
    { key: "ack", label: "Court rules acknowledged", kind: "checkbox", required: false },
    { key: "diet", label: "Dietary needs", kind: "select", options: ["None", "Vegetarian"], required: true },
  ];
  const DIV_ASKS: DivisionLike = { ...DIV_OPEN, division_id: "div-asks", name: "Asking Division", form_fields: FIELDS };

  /** Two entries, so each card's own subtree is its own. */
  function twoEntries(divisions: DivisionLike[]): M {
    const m = mount(divisions);
    setWho(m, { name: "Alex Test", email: "alex@example.com" });
    m.clickByText("Next"); // -> ENTRIES
    (propsOf(m.divisionCard(divisions[0]!.division_id)).onAddIndividual as () => void)();
    (propsOf(m.divisionCard(divisions[0]!.division_id)).onAddIndividual as () => void)();
    m.clickByText("Next"); // -> DETAILS
    return m;
  }
  const isCard = (e: ReactElement) => /(?:^|\s)bg-surface(?:\s|$)/.test(String(propsOf(e).className ?? ""));

  it("one card per entry: the step's heading and subtitle are not a card of their own", () => {
    const m = twoEntries([DIV_OPEN, DIV_OPEN_2]);
    const stepEl = m.island.tree().find((e) => e.type === StepDetails)!;
    const sub = deepExpand((StepDetails as ComponentFn)(propsOf(stepEl)));
    const cards = sub.filter(isCard);
    expect(cards, "two entries, two cards (an intro card would make three)").toHaveLength(2);
    const headings = sub.filter((e) => e.type === "h2");
    expect(headings, "the step still has its one focus-target heading").toHaveLength(1);
    expect(textOf(headings[0]!)).toBe("Player details");
    for (const card of cards) expect(walk(card).includes(headings[0]!), "the heading is not inside an entry's card").toBe(false);

    // The empty case: no entries is no cards, and the heading is still the step's heading.
    const empty = deepExpand((StepDetails as ComponentFn)({ ...propsOf(stepEl), cart: { entries: [] } }));
    expect(empty.filter(isCard)).toHaveLength(0);
    expect(empty.filter((e) => e.type === "h2")).toHaveLength(1);
  });

  it("the organiser's questions sit under 'Questions from {org}', optional ones tagged and required ones not", () => {
    const m = twoEntries([DIV_ASKS, DIV_OPEN_2]);
    const tree = m.island.tree();
    const headings = tree.filter((e) => e.type === "h4");
    expect(headings, "one questions block per entry").toHaveLength(2);
    for (const h of headings) expect(textOf(h)).toBe("Questions from Test Org");
    expect(tree.some((e) => textOf(e) === "Event questions"), "the generic heading is gone").toBe(false);

    const labels = tree.filter((e) => e.type === "label");
    let tagged = 0;
    let untagged = 0;
    for (const f of FIELDS) {
      const mine = labels.filter((l) => textOf(l).includes(f.label));
      expect(mine, `${f.key}: one label per entry`).toHaveLength(2);
      for (const l of mine) {
        const hasTag = textOf(l).includes("Optional");
        expect(hasTag, `${f.key} (required=${f.required})`).toBe(!f.required);
        if (hasTag) tagged++;
        else untagged++;
      }
    }
    expect(tagged, "anti-vacuity: optional questions seen, per entry").toBe(FIELDS.filter((f) => !f.required).length * 2);
    expect(untagged, "and required ones").toBe(FIELDS.filter((f) => f.required).length * 2);
  });

  it("a division that asks nothing gets no Questions heading (the empty case, through the stepper)", () => {
    const m = twoEntries([DIV_OPEN, DIV_OPEN_2]);
    expect(m.island.tree().filter((e) => e.type === "h4")).toHaveLength(0);
    expect(m.pageText()).not.toContain("Questions from");
  });
});

describe("B2 T9 — the new copy is in every locale", () => {
  it("each locale carries the new keys with their placeholders, and none still carries the retired ones", () => {
    const read = (loc: string) =>
      JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "dictionaries", loc, "ui.json"), "utf8")) as Record<string, string>;
    let checked = 0;
    for (const loc of ["en", "es", "fr", "nl"]) {
      const d = read(loc);
      for (const k of ["register.errors.summary.one", "register.errors.summary.other"]) {
        expect(d[k], `${loc}: ${k}`).toMatch(/\{count\}.*\{list\}/);
      }
      expect(d["register.details.questionsFrom"], `${loc}: questionsFrom`).toContain("{org}");
      for (const k of [
        "register.who.email.invalid",
        "register.who.playing.title",
        "register.who.playing.body",
        "register.details.you",
        "register.field.optional",
      ]) {
        expect(typeof d[k], `${loc}: ${k}`).toBe("string");
        expect(d[k]!.trim().length, `${loc}: ${k} is not empty`).toBeGreaterThan(0);
      }
      for (const k of ["register.self.label", "register.self.hint", "register.errors.email", "register.section.questions"]) {
        expect(d[k], `${loc}: the retired ${k} is gone`).toBeUndefined();
      }
      checked++;
    }
    expect(checked, "anti-vacuity: all four locales").toBe(4);
    const en = read("en");
    expect(en["register.who.email.invalid"]).toBe("Enter an email address, like name@example.com");
    expect(en["register.who.playing.title"]).toBe("I'm one of the players");
    expect(en["register.details.you"]).toBe("That's you. Change it on the Contact step.");
    expect(en["register.field.optional"]).toBe("Optional");
  });
});

// ---------------------------------------------------------------------------
// Registration redesign B2 T10 (spec 7.3) - Consent and Review. Driven through the REAL stepper: the producers are the form's own
// inputs and Edit buttons, the consumers are what the registrant reads on Consent and Review. Literals are the spec's own words and the
// values the test types; none is read back out of the code under test. Sport: not applicable (the register form is sport-agnostic).
// ---------------------------------------------------------------------------

/** A second mount in ONE test would restore the first one's draft from sessionStorage (and start on its last step): wipe it between mounts. */
function freshStorage() {
  fakeSessionStorage = new MapStorage();
  (globalThis as { sessionStorage?: unknown }).sessionStorage = fakeSessionStorage;
}

describe("B2 T10 - Consent: Required and Optional tags, small print, one info line", () => {
  type M = ReturnType<typeof mount>;
  type Island = M["island"];
  const DIV_TEAM_T10C: DivisionLike = { ...DIV_OPEN, division_id: "div-team-t10c", name: "Club Teams", entrant_kind: "team" };
  const setWho = (m: M) => (propsOf(m.stepWho()).onChange as (p: object) => void)({ name: "Mia Cole", email: "mia@example.com" });
  const consentBox = (island: Island, id: string, checked: boolean) =>
    (propsOf(byId(island, id)).onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked } });
  const byTestId = (island: Island, id: string) => island.tree().filter((e) => propsOf(e)["data-testid"] === id);

  /** One individual division: Contact -> Details -> Consent. `playing`: the contact is the one player (their row is theirs, nobody else is named). */
  function onConsent(playing = false): M {
    const m = mount([DIV_OPEN]);
    setWho(m);
    if (playing) {
      (propsOf(m.stepWho()).onChange as (p: object) => void)({ dob: "1990-04-02" });
      (propsOf(m.stepWho()).onImPlayingChange as (v: boolean) => void)(true);
    }
    m.clickByText("Next"); // -> DETAILS
    if (!playing) setByAriaLabel(m.island, "Player 1 \u2014 Your name", "Alex Other");
    m.clickByText("Next"); // -> CONSENT
    expect(m.island.tree().some((e) => e.type === StepConsent), "premise: on the Consent step").toBe(true);
    return m;
  }
  /** The label that wraps an input, found within ONE expansion of the tree (element identity holds only inside one island.tree() call). */
  function labelAround(island: Island, inputId: string) {
    const tree = island.tree();
    const input = tree.find((e) => propsOf(e).id === inputId)!;
    const labels = tree.filter((e) => e.type === "label" && walk(e).includes(input));
    expect(labels, `exactly one label wraps #${inputId}`).toHaveLength(1);
    return labels[0]!;
  }
  const tagsIn = (label: ReactElement) => walk(label).filter((e) => propsOf(e).className === TAG_NEUTRAL);

  it("each consent shows Required or Optional: privacy leads with Required, media with Optional, never the other way round", () => {
    const m = onConsent();
    const privacy = labelAround(m.island, "reg-consent-privacy");
    const media = labelAround(m.island, "reg-consent-media");
    const privacyTags = tagsIn(privacy);
    const mediaTags = tagsIn(media);
    expect(privacyTags.map((e) => textOf(e)), "privacy: one tag, Required").toEqual(["Required"]);
    expect(mediaTags.map((e) => textOf(e)), "media: one tag, Optional").toEqual(["Optional"]);
    // The tag LEADS: it is the first thing in the label's text, before the consent's own words.
    expect(textOf(privacy).startsWith("Required"), "privacy: tag first").toBe(true);
    expect(textOf(media).startsWith("Optional"), "media: tag first").toBe(true);
    expect(textOf(privacy), "the pair: privacy is not marked Optional").not.toContain("Optional");
    expect(textOf(media), "the pair: media is not marked Required").not.toContain("Required");
  });

  it("the legal sentence is small print UNDER the plain title, inside the same label, with the Privacy Policy link; the old long label is gone", () => {
    const m = onConsent();
    const label = labelAround(m.island, "reg-consent-privacy");
    const nodes = walk(label);
    const titleEl = nodes.find((e) => propsOf(e).children === "Store and use my details to run this competition");
    expect(titleEl, "the plain title").toBeTruthy();
    const legal = nodes.find((e) => typeof propsOf(e).children !== "string" && textOf(e).startsWith("I agree that Test Org and Seazn Club will store and process the details on this form"));
    expect(legal, "the legal sentence is in the label").toBeTruthy();
    expect(nodes.indexOf(titleEl!), "title comes before the legal sentence").toBeLessThan(nodes.indexOf(legal!));
    expect(String(propsOf(titleEl!).className), "title is the label's main line").toContain("font-medium");
    expect(String(propsOf(legal!).className), "the legal sentence is small print").toContain("text-xs");
    const link = nodes.find((e) => e.type === "a");
    expect(propsOf(link!).href).toBe("/legal/privacy");
    expect(textOf(link!)).toBe("Privacy Policy");
  });

  it("the checkbox testids are kept: reg-consent-privacy is the input's id, reg-consent-grant its data-testid", () => {
    const m = onConsent();
    expect(propsOf(byId(m.island, "reg-consent-privacy"))["data-testid"]).toBe("reg-consent-grant");
    expect(byTestId(m.island, "reg-consent-grant")).toHaveLength(1);
  });

  it("the required box turns red after a failed Continue, and only then; the optional box never does", () => {
    const m = onConsent();
    const box = (id: string) => String(propsOf(byTestId(m.island, id)[0]!).className);
    expect(box("reg-consent-privacy-box"), "pristine").not.toContain("border-red-600");
    m.clickByText("Next"); // privacy not ticked: refused
    expect(m.island.tree().some((e) => e.type === StepConsent), "premise: still on Consent").toBe(true);
    expect(box("reg-consent-privacy-box"), "refused: danger border").toContain("border-red-600");
    expect(box("reg-consent-media-box"), "the optional consent is never an error").not.toContain("border-red-600");
    consentBox(m.island, "reg-consent-privacy", true);
    expect(box("reg-consent-privacy-box"), "ticked: the danger border is gone").not.toContain("border-red-600");
  });

  it("the other-players notice is ONE info line (icon + text), not a third box; and it only shows when the cart names other people", () => {
    const m = mount([DIV_OPEN, DIV_TEAM_T10C]);
    setWho(m);
    m.clickByText("Next"); // -> ENTRIES
    (propsOf(m.divisionCard("div-team-t10c")).onAddTeam as () => void)();
    setByAriaLabel(m.island, "Team name", "Riverside");
    m.clickByText("Next"); // -> DETAILS
    const textarea = m.island.tree().find((e) => e.type === "textarea")!;
    (propsOf(textarea).onChange as (e: { target: { value: string } }) => void)({ target: { value: "Jordan Blake\nSam Ortiz" } });
    m.clickByText("Add 2 players from list");
    m.clickByText("Next"); // -> CONSENT
    const notices = byTestId(m.island, "reg-consent-roster-notice");
    expect(notices, "the captain names other people: the notice shows").toHaveLength(1);
    expect(textOf(notices[0]!)).toContain("You're entering other people in this registration.");
    const classes = String(propsOf(notices[0]!).className).split(/\s+/);
    expect(classes.filter((c) => c.startsWith("border") || c.startsWith("bg-")), "no box: no border, no fill").toEqual([]);
    expect(walk(notices[0]!).some((e) => e.type === "svg"), "it leads with an icon").toBe(true);
    // Its pair: the two real consents are still boxes, so the line above is the odd one out on purpose.
    expect(String(propsOf(byTestId(m.island, "reg-consent-privacy-box")[0]!).className)).toContain("border");
    // And the empty case: a registrant who IS the one player names nobody else, so there is nobody to notify.
    freshStorage();
    const solo = onConsent(true);
    expect(byTestId(solo.island, "reg-consent-roster-notice"), "nobody else: no notice").toHaveLength(0);
    // Its pair: the same one-player cart, entered on behalf of someone else, does name another person.
    freshStorage();
    expect(byTestId(onConsent(false).island, "reg-consent-roster-notice"), "someone else is named: the notice shows").toHaveLength(1);
  });
});

describe("B2 T10 - Review: you, entries with players, answers, consent; Edit goes back and loses nothing", () => {
  type M = ReturnType<typeof mount>;
  type Island = M["island"];
  const DIV_TEAM_T10: DivisionLike = {
    ...DIV_OPEN, division_id: "div-team-t10", name: "Club Teams", entrant_kind: "team", fee_cents: 1500, payment_method: "stripe",
  };
  const DIV_ASKS_T10: DivisionLike = {
    ...DIV_OPEN, division_id: "div-asks-t10", name: "Masters Singles", fee_cents: 1000, payment_method: "stripe",
    form_fields: [
      { key: "shirt", label: "Shirt size", kind: "text", required: false },
      { key: "diet", label: "Dietary needs", kind: "select", options: ["None", "Vegetarian"], required: true },
      { key: "ack", label: "Court rules acknowledged", kind: "checkbox", required: false },
    ],
  };
  const all = (island: Island, id: string) => island.tree().filter((e) => propsOf(e)["data-testid"] === id);
  const one = (island: Island, id: string) => {
    const hits = all(island, id);
    expect(hits, `exactly one [data-testid=${id}]`).toHaveLength(1);
    return hits[0]!;
  };
  const setField = (island: Island, id: (x: string) => boolean, value: string) => {
    const el = island.tree().find((e) => typeof propsOf(e).id === "string" && id(propsOf(e).id as string));
    expect(el, "field").toBeTruthy();
    (propsOf(el!).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
  };
  const tick = (island: Island, id: string) =>
    (propsOf(byId(island, id)).onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: true } });
  const onStep = (island: Island, component: unknown) => island.tree().some((e) => e.type === component);
  const stepNavIndex = (island: Island) => (propsOf(island.tree().find((e) => e.type === StepNav)!) as { currentIndex: number }).currentIndex;

  /** Five steps, a card cart of a named team (two players) and a Masters single who answers all three organiser questions. */
  function reachFullReview(opts: { media?: boolean } = {}): M {
    const m = mount([DIV_TEAM_T10, DIV_ASKS_T10]);
    (propsOf(m.stepWho()).onChange as (p: object) => void)({ name: "  Mia Cole ", email: "mia@example.com" });
    m.clickByText("Next"); // -> ENTRIES
    (propsOf(m.divisionCard("div-team-t10")).onAddTeam as () => void)();
    (propsOf(m.divisionCard("div-asks-t10")).onAddIndividual as () => void)();
    setByAriaLabel(m.island, "Team name", "Riverside");
    m.clickByText("Next"); // -> DETAILS
    const textarea = m.island.tree().find((e) => e.type === "textarea")!;
    (propsOf(textarea).onChange as (e: { target: { value: string } }) => void)({ target: { value: "Jordan Blake\nSam Ortiz" } });
    m.clickByText("Add 2 players from list");
    (propsOf(allByAriaLabel(m.island, "Player 1 \u2014 Your name")[1]!).onChange as (e: { target: { value: string } }) => void)({ target: { value: "Priya Raman" } });
    setField(m.island, (id) => id.endsWith("-shirt"), "M");
    setField(m.island, (id) => id.endsWith("-diet"), "Vegetarian");
    const ack = m.island.tree().filter((e) => e.type === "input" && propsOf(e).type === "checkbox");
    expect(ack, "premise: the one organiser checkbox").toHaveLength(1);
    (propsOf(ack[0]!).onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    m.clickByText("Next"); // -> CONSENT
    tick(m.island, "reg-consent-privacy");
    if (opts.media) tick(m.island, "reg-consent-media");
    m.clickByText("Next"); // -> REVIEW
    expect(onStep(m.island, StepReview), "premise: on Review").toBe(true);
    return m;
  }

  it("review lists contact, every entry with its players, the answers and the consent", () => {
    const m = reachFullReview();
    const you = textOf(one(m.island, "reg-review-you"));
    expect(you).toContain("Mia Cole");
    expect(you).toContain("mia@example.com");
    const entries = m.island.tree().filter((e) => e.type === "li");
    expect(entries, "two entries, two lines").toHaveLength(2);
    const team = textOf(entries[0]!);
    expect(team).toContain("Club Teams");
    expect(team).toContain("Riverside");
    expect(team, "the team's players, by name").toContain("Jordan Blake, Sam Ortiz");
    const single = textOf(entries[1]!);
    expect(single).toContain("Masters Singles");
    expect(single, "the individual's one player").toContain("Priya Raman");
    const answers = textOf(one(m.island, "reg-review-answers"));
    expect(answers, "each question beside its own answer, in the order the organiser asked them; a ticked checkbox reads Yes").toMatch(
      /Shirt size\s*M\s*Dietary needs\s*Vegetarian\s*Court rules acknowledged\s*Yes/,
    );
    const consent = textOf(one(m.island, "reg-review-consent"));
    expect(consent, "privacy was ticked").toMatch(/Store and use my details to run this competition\s*Yes/);
    expect(consent, "media was not").toMatch(/Photos and video of me from this event\s*No/);
  });

  it("two entries that were asked questions: each group names whose answers it is, and each answer stays with its own entry", () => {
    const DIV_ASKS_2: DivisionLike = { ...DIV_ASKS_T10, division_id: "div-asks-t10-b", name: "Juniors Singles" };
    const m = mount([DIV_ASKS_T10, DIV_ASKS_2]);
    (propsOf(m.stepWho()).onChange as (p: object) => void)({ name: "Mia Cole", email: "mia@example.com" });
    m.clickByText("Next"); // -> ENTRIES
    (propsOf(m.divisionCard("div-asks-t10")).onAddIndividual as () => void)();
    (propsOf(m.divisionCard("div-asks-t10-b")).onAddIndividual as () => void)();
    m.clickByText("Next"); // -> DETAILS
    const names = allByAriaLabel(m.island, "Player 1 \u2014 Your name");
    expect(names, "premise: one row per entry").toHaveLength(2);
    (propsOf(names[0]!).onChange as (e: { target: { value: string } }) => void)({ target: { value: "Priya Raman" } });
    (propsOf(names[1]!).onChange as (e: { target: { value: string } }) => void)({ target: { value: "Sam Ortiz" } });
    const shirts = m.island.tree().filter((e) => typeof propsOf(e).id === "string" && (propsOf(e).id as string).endsWith("-shirt"));
    const diets = m.island.tree().filter((e) => typeof propsOf(e).id === "string" && (propsOf(e).id as string).endsWith("-diet"));
    expect([shirts.length, diets.length], "premise: both entries show both questions").toEqual([2, 2]);
    const set = (el: ReactElement, value: string) => (propsOf(el).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
    set(shirts[0]!, "M");
    set(diets[0]!, "Vegetarian");
    set(shirts[1]!, "S");
    set(diets[1]!, "None");
    m.clickByText("Next"); // -> CONSENT
    tick(m.island, "reg-consent-privacy");
    m.clickByText("Next"); // -> REVIEW
    expect(onStep(m.island, StepReview), "premise: on Review").toBe(true);
    const answers = textOf(one(m.island, "reg-review-answers")).replace(/\s+/g, " ");
    expect(answers, "each entry's heading, then its own answers, in cart order").toMatch(
      /Masters Singles \u00b7 Priya Raman Shirt size M Dietary needs Vegetarian Court rules acknowledged No Juniors Singles \u00b7 Sam Ortiz Shirt size S Dietary needs None Court rules acknowledged No/,
    );
  });

  it("a skipped optional question reads Not answered, in muted type, beside the answered one that reads its value", () => {
    const m = mount([DIV_ASKS_T10]); // one division: four steps, no Entries
    (propsOf(m.stepWho()).onChange as (p: object) => void)({ name: "Mia Cole", email: "mia@example.com" });
    m.clickByText("Next"); // -> DETAILS
    setByAriaLabel(m.island, "Player 1 \u2014 Your name", "Priya Raman");
    setField(m.island, (id) => id.endsWith("-diet"), "None"); // the one REQUIRED question; the shirt size is left blank
    m.clickByText("Next"); // -> CONSENT
    tick(m.island, "reg-consent-privacy");
    m.clickByText("Next"); // -> REVIEW
    expect(onStep(m.island, StepReview), "premise: on Review").toBe(true);
    const section = one(m.island, "reg-review-answers");
    expect(textOf(section).replace(/\s+/g, " ")).toMatch(/Shirt size Not answered Dietary needs None Court rules acknowledged No/);
    const dds = walk(section).filter((e) => e.type === "dd");
    expect(dds.map((e) => textOf(e)), "premise: one value cell per question").toEqual(["Not answered", "None", "No"]);
    expect(String(propsOf(dds[0]!).className), "a missing answer is quieter than a given one").toContain("text-ink-muted");
    expect(String(propsOf(dds[1]!).className), "...and the given one is not muted").not.toContain("text-ink-muted");
  });

  it("media consent ticked reads Yes (the pair of the No above)", () => {
    const m = reachFullReview({ media: true });
    expect(textOf(one(m.island, "reg-review-consent"))).toMatch(/Photos and video of me from this event\s*Yes/);
  });

  it("the consent rows state what was actually agreed: a privacy consent that is not given reads No, never an assumed Yes", () => {
    // Not reachable through the form (Continue refuses without it), so it is driven directly: the row must read the state, not assume it.
    const cart: CartState = { entries: [] };
    const out = (StepReview as unknown as ComponentFn)({
      summary: summarizeCart(cart, [DIV_OPEN]),
      content: reviewContent(cart, [DIV_OPEN], EMPTY_CONTACT, { privacy_consent: false, media_consent: true }, new Date()),
      locale: "en",
      order: buildStepOrder(2, "individual"),
      onEdit: vi.fn(),
    });
    const section = walk(out).find((e) => propsOf(e)["data-testid"] === "reg-review-consent")!;
    expect(textOf(section).replace(/\s+/g, " ")).toContain(
      "Store and use my details to run this competition No Photos and video of me from this event Yes",
    );
  });

  it("the four sections are headed You, Entries, Answers and Consent, each with one Edit", () => {
    const m = reachFullReview();
    const seen: string[] = [];
    for (const [id, title] of [["you", "You"], ["entries", "Entries"], ["answers", "Answers"], ["consent", "Consent"]] as const) {
      const section = one(m.island, `reg-review-${id}`);
      const heading = walk(section).filter((e) => e.type === "h3");
      expect(heading.map((h) => textOf(h)), `${id}: one heading`).toEqual([title]);
      const edits = walk(section).filter((e) => propsOf(e)["data-testid"] === `reg-review-edit-${id}`);
      expect(edits, `${id}: one Edit`).toHaveLength(1);
      expect(textOf(edits[0]!).replace(/\s+/g, " ").trim(), `${id}: the Edit's name says which section`).toBe(`Edit ${title}`);
      seen.push(id);
    }
    expect(seen, "anti-vacuity: all four sections").toHaveLength(4);
  });

  it("review with no organiser questions omits Answers (empty case), and its pair has them", () => {
    const bare = mount([DIV_OPEN]);
    (propsOf(bare.stepWho()).onChange as (p: object) => void)({ name: "Alex Test", email: "alex@example.com" });
    bare.clickByText("Next"); // -> DETAILS (Entries collapsed)
    setByAriaLabel(bare.island, "Player 1 \u2014 Your name", "Alex Test");
    bare.clickByText("Next"); // -> CONSENT
    tick(bare.island, "reg-consent-privacy");
    bare.clickByText("Next"); // -> REVIEW
    expect(onStep(bare.island, StepReview), "premise: on Review").toBe(true);
    expect(all(bare.island, "reg-review-answers"), "nothing was asked: no Answers section").toHaveLength(0);
    expect(all(bare.island, "reg-review-edit-answers"), "and no Edit for it").toHaveLength(0);
    expect(all(bare.island, "reg-review-you"), "the other sections are still there").toHaveLength(1);
    expect(all(bare.island, "reg-review-consent")).toHaveLength(1);
    freshStorage();
    expect(all(reachFullReview().island, "reg-review-answers"), "pair: questions asked, section shown").toHaveLength(1);
  });

  it.each([
    { section: "you", step: StepWho, index: 0, where: "Contact" },
    { section: "entries", step: StepEntries, index: 1, where: "Entries" },
    { section: "answers", step: StepDetails, index: 2, where: "Details" },
    { section: "consent", step: StepConsent, index: 3, where: "Consent" },
  ])("each Edit jumps to its step and every value survives the round trip: Edit $section -> $where -> back to Review unchanged", ({ section, step, index }) => {
    const m = reachFullReview({ media: true });
    const before = ["you", "entries", "answers", "consent"].map((id) => textOf(one(m.island, `reg-review-${id}`)));
    const submitBefore = textOf(one(m.island, "reg-submit"));
    const edit = one(m.island, `reg-review-edit-${section}`);
    expect(propsOf(edit).disabled, "idle: the Edit is live").not.toBe(true);
    (propsOf(edit).onClick as () => void)();
    expect(onStep(m.island, step), `Edit ${section} lands on ${index === 0 ? "Contact" : "its own step"}`).toBe(true);
    expect(stepNavIndex(m.island), "and the rail agrees").toBe(index);
    expect(onStep(m.island, StepReview), "Review is gone while editing").toBe(false);
    // Forward again, unedited. A bounded walk: five steps at most, and it must take at least one Continue to get back.
    let continues = 0;
    while (!onStep(m.island, StepReview) && continues < 6) {
      m.clickByText("Next");
      continues++;
    }
    expect(onStep(m.island, StepReview), "back on Review").toBe(true);
    expect(continues, "anti-vacuity: the walk went somewhere").toBe(4 - index);
    const after = ["you", "entries", "answers", "consent"].map((id) => textOf(one(m.island, `reg-review-${id}`)));
    expect(after, "every section reads exactly as it did").toEqual(before);
    expect(textOf(one(m.island, "reg-submit")), "and so does the Pay label").toBe(submitBefore);
  });

  it("Edit Contact then changing the name: the Review shows the new name, and the Details row that followed it", () => {
    const m = reachFullReview();
    (propsOf(one(m.island, "reg-review-edit-you")).onClick as () => void)();
    (propsOf(m.stepWho()).onChange as (p: object) => void)({ name: "Maya Cole" });
    let guard = 0;
    while (!onStep(m.island, StepReview) && guard++ < 6) m.clickByText("Next");
    expect(textOf(one(m.island, "reg-review-you"))).toContain("Maya Cole");
    expect(textOf(one(m.island, "reg-review-you")), "the old name is gone").not.toContain("Mia Cole");
  });

  it("a one-division competition (Entries collapsed): Edit Entries goes to Details, where the players are, and Contact is still step 1", () => {
    const m = mount([DIV_ASKS_T10]);
    (propsOf(m.stepWho()).onChange as (p: object) => void)({ name: "Alex Test", email: "alex@example.com" });
    m.clickByText("Next"); // -> DETAILS
    setByAriaLabel(m.island, "Player 1 \u2014 Your name", "Alex Test");
    setField(m.island, (id) => id.endsWith("-diet"), "None");
    m.clickByText("Next"); // -> CONSENT
    tick(m.island, "reg-consent-privacy");
    m.clickByText("Next"); // -> REVIEW
    expect(onStep(m.island, StepReview), "premise: on Review").toBe(true);
    (propsOf(one(m.island, "reg-review-edit-entries")).onClick as () => void)();
    expect(onStep(m.island, StepDetails), "no Entries step to go to: Details").toBe(true);
    expect(stepNavIndex(m.island)).toBe(1);
    m.clickByText("Back"); // -> CONTACT
    m.stepWho();
    m.clickByText("Next");
    m.clickByText("Next");
    m.clickByText("Next");
    (propsOf(one(m.island, "reg-review-edit-you")).onClick as () => void)();
    expect(stepNavIndex(m.island), "Edit Contact is index 0 here too").toBe(0);
  });

  it("while a submit is in flight no Edit is live; after a failure they all are again", async () => {
    const m = reachFullReview();
    const ids = ["you", "entries", "answers", "consent"];
    expect(ids.map((id) => propsOf(one(m.island, `reg-review-edit-${id}`)).disabled === true), "idle: none disabled").toEqual([false, false, false, false]);
    let reject!: (e: unknown) => void;
    apiV1Mock.impl.mockReturnValueOnce(new Promise((_, rej) => { reject = rej; }));
    const done = (propsOf(one(m.island, "reg-submit")).onClick as () => Promise<void>)();
    await vi.waitFor(() => expect(apiV1Mock.impl, "the POST is in flight").toHaveBeenCalledTimes(1));
    expect(ids.map((id) => propsOf(one(m.island, `reg-review-edit-${id}`)).disabled === true), "in flight: all disabled").toEqual([true, true, true, true]);
    reject(new ApiV1Error("Boom", 500, "INTERNAL"));
    await done;
    expect(ids.map((id) => propsOf(one(m.island, `reg-review-edit-${id}`)).disabled === true), "after a failure: live again").toEqual([false, false, false, false]);
  });

  it("the card cart says how it is paid, once, and the total is the sum; an offline or free cart says nothing about Stripe", () => {
    const m = reachFullReview();
    expect(textOf(one(m.island, "reg-review-card-note"))).toBe("You'll pay by card on a secure Stripe page, then come straight back here.");
    expect(textOf(one(m.island, "reg-review-total"))).toBe("\u00a325.00");
    for (const division of [{ ...DIV_OPEN, payment_method: "offline" as const, fee_cents: 1500 }, DIV_OPEN]) {
      freshStorage();
      const other = mount([division]);
      (propsOf(other.stepWho()).onChange as (p: object) => void)({ name: "Alex Test", email: "alex@example.com" });
      other.clickByText("Next");
      setByAriaLabel(other.island, "Player 1 \u2014 Your name", "Alex Test");
      other.clickByText("Next");
      tick(other.island, "reg-consent-privacy");
      other.clickByText("Next");
      expect(onStep(other.island, StepReview), "premise: on Review").toBe(true);
      expect(all(other.island, "reg-review-card-note"), `${division.payment_method} fee ${division.fee_cents}: no Stripe note`).toHaveLength(0);
    }
  });

  it("the running total is dropped on Review (the Pay label already says the fee), still there on the steps before it, and Review adds 'Confirmation goes to {email}' for md and up", () => {
    const m = mount([DIV_TEAM_T10, DIV_ASKS_T10]);
    (propsOf(m.stepWho()).onChange as (p: object) => void)({ name: "Mia Cole", email: "mia@example.com" });
    m.clickByText("Next"); // -> ENTRIES
    (propsOf(m.divisionCard("div-team-t10")).onAddTeam as () => void)();
    (propsOf(m.divisionCard("div-asks-t10")).onAddIndividual as () => void)();
    setByAriaLabel(m.island, "Team name", "Riverside");
    expect(textOf(one(m.island, "reg-bar-summary")), "premise: Entries shows it").toBe("2 entries \u00b7 \u00a325.00");
    expect(all(m.island, "reg-bar-sent-to"), "the note is a Review thing").toHaveLength(0);
    m.clickByText("Next"); // -> DETAILS
    expect(all(m.island, "reg-bar-summary"), "premise: Details shows it too").toHaveLength(1);
    const textarea = m.island.tree().find((e) => e.type === "textarea")!;
    (propsOf(textarea).onChange as (e: { target: { value: string } }) => void)({ target: { value: "Jordan Blake" } });
    m.clickByText("Add 1 players from list");
    (propsOf(allByAriaLabel(m.island, "Player 1 \u2014 Your name")[1]!).onChange as (e: { target: { value: string } }) => void)({ target: { value: "Priya Raman" } });
    setField(m.island, (id) => id.endsWith("-diet"), "None");
    m.clickByText("Next"); // -> CONSENT
    tick(m.island, "reg-consent-privacy");
    m.clickByText("Next"); // -> REVIEW
    expect(onStep(m.island, StepReview), "premise: on Review").toBe(true);
    expect(textOf(one(m.island, "reg-submit")), "premise: the Pay label carries the fee").toBe("Pay \u00a325.00 and enter");
    expect(all(m.island, "reg-bar-summary"), "Review: no total line").toHaveLength(0);
    const note = one(m.island, "reg-bar-sent-to");
    expect(textOf(note)).toBe("Confirmation goes to mia@example.com");
    expect(String(propsOf(note).className), "md and up only").toMatch(/(?:^|\s)max-md:hidden(?:\s|$)/);
    // B2 review m6: an address has no break points and may be 200 characters, in a flex row at md. `min-w-0` lets the note shrink below
    // its text's width and `break-words` lets the address wrap there; without both a long one pushes the row past the page at 768.
    const noteCls = String(propsOf(note).className);
    expect(noteCls, "the note may shrink below its text").toMatch(/(?:^|\s)min-w-0(?:\s|$)/);
    expect(noteCls, "and wrap an address that has no break points").toMatch(/(?:^|\s)break-words(?:\s|$)/);
    expect(String(propsOf(one(m.island, "reg-submit")).className), "with the note beside it, the button's own ml-auto is cancelled at md").toMatch(/(?:^|\s)md:ml-0(?:\s|$)/);
    m.clickByText("Back");
    expect(all(m.island, "reg-bar-summary"), "back on Consent: the total returns").toHaveLength(1);
    expect(all(m.island, "reg-bar-sent-to"), "and the note leaves").toHaveLength(0);
  });

  // B2 review m4: the submit sends the guardian's name and consent, so Review (which shows everything that will be sent) lists them
  // exactly when the Consent step asked for them. Driven through the real stepper from a minor registering themselves.
  describe("the guardian rows (B2 review m4)", () => {
    function reachConsent(dob: string): M {
      const m = mount([DIV_OPEN]);
      (propsOf(m.stepWho()).onChange as (p: object) => void)({ name: "Young Player", email: "young@example.com", dob });
      (propsOf(m.stepWho()).onImPlayingChange as (v: boolean) => void)(true); // auto-links the sole entry
      m.clickByText("Next"); // -> DETAILS
      setByAriaLabel(m.island, "Player 1 \u2014 Your name", "Young Player");
      m.clickByText("Next"); // -> CONSENT
      tick(m.island, "reg-consent-privacy");
      return m;
    }
    const consentText = (m: M) => textOf(one(m.island, "reg-review-consent"));

    it("a self-registering minor's Review lists the guardian's name and consent beside the two checkboxes", () => {
      const m = reachConsent(minorDob());
      expect(onStep(m.island, StepConsent), "premise: the guardian block is up").toBe(true);
      (propsOf(byId(m.island, "reg-guardian-name")).onChange as (e: { target: { value: string } }) => void)({ target: { value: "Pat Guardian" } });
      tick(m.island, "reg-guardian-consent");
      m.clickByText("Next"); // -> REVIEW
      expect(onStep(m.island, StepReview), "premise: on Review").toBe(true);
      const text = consentText(m);
      expect(text).toContain("Guardian's name");
      expect(text).toContain("Pat Guardian");
      expect(text).toContain("Guardian's consent");
      expect(text, "the guardian's consent row says Yes (it was ticked)").toMatch(/Guardian's consent\s*Yes/);
      expect(text, "and the guardian's name row carries the typed name").toMatch(/Guardian's name\s*Pat Guardian/);
      expect(text, "the two checkboxes are still listed").toContain("Photos and video of me from this event");
    });

    it("its pair: an adult registering themselves has a Review with no guardian rows at all", () => {
      const m = reachConsent("1990-01-01");
      expect(onStep(m.island, StepConsent), "premise: on Consent").toBe(true);
      m.clickByText("Next"); // -> REVIEW
      expect(onStep(m.island, StepReview), "premise: on Review").toBe(true);
      const text = consentText(m);
      expect(text, "premise: the section lists the checkboxes").toContain("Photos and video of me from this event");
      expect(text).not.toContain("Guardian");
    });

    it("every locale words the new row", () => {
      let checked = 0;
      for (const loc of ["en", "es", "fr", "nl"]) {
        const d = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "dictionaries", loc, "ui.json"), "utf8")) as Record<string, string>;
        expect(d["register.review.consent.guardian"], `${loc}: the guardian consent row's label`).toBeTruthy();
        checked++;
      }
      expect(checked, "anti-vacuity: all four locales").toBe(4);
    });
  });
});
