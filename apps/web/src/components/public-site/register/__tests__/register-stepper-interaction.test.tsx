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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement, ReactNode } from "react";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import { DivisionCard } from "../division-card";
import { EntryCart } from "../entry-cart";
import { RegisterStepper, type RegisterInfo } from "../register-stepper";
import { StepEntries } from "../step-entries";
import { StepWho } from "../step-who";
import { EMPTY_CONTACT, type CartState, type DivisionLike } from "../types";

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
const OPAQUE: ComponentFn[] = [StepWho, StepEntries, DivisionCard, EntryCart] as unknown as ComponentFn[];

/** Flattens the WHOLE tree in one pass, including everything rendered
 *  inside StepWho/StepEntries/DivisionCard/EntryCart — a growing worklist
 *  re-checks `out.length` every iteration, so an opaque node discovered
 *  INSIDE an already-expanded opaque node (DivisionCard/EntryCart inside
 *  StepEntries) gets expanded too, arbitrary nesting depth, no recursion
 *  needed. All four components here only call the (mocked, non-hook) useT()
 *  internally, so invoking them outside the harness's render window is safe. */
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
beforeEach(() => {
  fakeSessionStorage = new MapStorage();
  (globalThis as { sessionStorage?: unknown }).sessionStorage = fakeSessionStorage;
});
afterEach(() => {
  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
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

function mount(divisions: DivisionLike[]) {
  const info: RegisterInfo = {
    competition: { name: "Test Cup", starts_on: "2026-09-01" },
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
  const clickByText = (text: string) => {
    const btn = island.tree().find((e) => e.type === "button" && textOf(e) === text);
    expect(btn, `no button with text "${text}"`).toBeTruthy();
    expect(propsOf(btn!).disabled, `button "${text}" is disabled`).not.toBe(true);
    (propsOf(btn!).onClick as () => void)();
  };
  const pageText = () => textOf(island.tree());

  return { island, stepWho, divisionCard, selfCheckboxes, clickByText, pageText, entryCartText };
}

// ---------------------------------------------------------------------------
// Finding #2 — un-toggling "I'm playing" must clear the self-link, not just
// hide the checkbox
// ---------------------------------------------------------------------------

describe("finding #2 — un-toggling \"I'm playing\" clears the self-link", () => {
  it("auto-links the sole cart entry when imPlaying flips true; un-toggling both hides the checkbox AND clears the link (not just the UI)", () => {
    const { stepWho, divisionCard, selfCheckboxes, clickByText, pageText } = mount([DIV_OPEN, DIV_WOMENS]);

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
    expect(pageText()).toContain("Only one entry can be linked to your account.");

    clickByText("Back"); // -> WHO
    (propsOf(stepWho()).onImPlayingChange as (v: boolean) => void)(false);
    clickByText("Next"); // -> ENTRIES

    // Both halves of the fix, checked independently: the checkbox is gone
    // (UI gate) AND the cart-level self hint is gone too — the hint is
    // driven by cart.selfEntryId alone, untouched by the checkbox-gating
    // change, so its absence is proof the LINK itself was cleared, not
    // just that the control is hidden.
    expect(selfCheckboxes(), "checkbox hidden once imPlaying is false again").toHaveLength(0);
    expect(pageText()).not.toContain("Only one entry can be linked to your account.");
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
    clickByText("Next"); // now advances past the last step
    expect(pageText()).toContain("More steps on the way");
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
    clickByText("Next");
    expect(pageText()).toContain("More steps on the way");
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
describe("finding #5 — restoring a pristine saved snapshot never shows stale errors", () => {
  it("an empty-but-saved contact renders grey helper text on every field, not red errors", () => {
    const key = `seazn_register_${ORG_SLUG}_${COMPETITION_SLUG}`;
    fakeSessionStorage.setItem(
      key,
      JSON.stringify({
        version: 1,
        contact: { name: "", email: "", dob: null, gender: null },
        imPlaying: false,
        cart: { entries: [], selfEntryId: null, selfPlayerIndex: null },
        stepIndex: 0,
      }),
    );

    // An open division that requires both dob AND gender so both fields
    // render (matching the fix wave's own repro fixture shape), independent
    // of imPlaying.
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
        },
      ],
      selfEntryId: null,
      selfPlayerIndex: null,
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
    expect(text).toContain("This division has closed since you added this entry");
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
        },
      ],
      selfEntryId: null,
      selfPlayerIndex: null,
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
