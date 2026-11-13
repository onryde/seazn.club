// Registration redesign B2 (review: extract the action bar's label logic out of register-stepper.tsx) — what the bar says: the forward
// button's name ("Continue to {step}"), the phone running total, what the submit button reads in each phase, and the longest label it
// will ever show (its width sizer). Pure; `t` and `plural` are handed in, bound here to the REAL English dictionary.
//
// The expected words are the spec's own literals (spec §3.3 item 5, §7.2), never read back out of the module under test. In particular
// the widest-label expectations are written as the label a person would call widest, NOT recomputed with the module's own `.length`
// rule: that mirror was review finding m8 (a character count is only a proxy for rendered width, and a test that re-derives it with the
// same proxy cannot disagree with it). The rule is pinned by cases where the answer is a known string, including a tie.
// Sport: not applicable (the register form is sport-agnostic).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Dict } from "@/lib/i18n-constants";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import { actionBarLabels, widestLabel, type SubmitPhase } from "../action-bar-labels";
import { summarizeCart } from "../cart";
import type { CartEntry, DivisionLike, StepId } from "../types";
import { EMPTY_ROSTER_PLAYER } from "../types";

const EN_UI: Dict = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "..", "..", "dictionaries", "en", "ui.json"), "utf8"),
) as Dict;
const t = (key: Parameters<typeof tRuntime>[1], vars?: Record<string, string | number>) => tRuntime(EN_UI, key, vars);
const plural = (key: string, count: number, vars?: Record<string, string | number>) => pluralRuntime(EN_UI, key, count, "en", vars);

const division = (patch: Partial<DivisionLike>): DivisionLike => ({
  division_id: "d",
  name: "Division",
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
  ...patch,
});

const entry = (id: string, division_id: string, entrant_kind: CartEntry["entrant_kind"] = "individual"): CartEntry => ({
  id,
  division_id,
  entrant_kind,
  team_name: null,
  partner_name: null,
  free_agent: false,
  players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "Mia Cole" }],
  answers: {},
  registering_self: false,
  self_player_index: null,
});

const FREE = division({ division_id: "free", fee_cents: 0 });
const CARD = division({ division_id: "card", fee_cents: 2500, payment_method: "stripe" });
const OFFLINE = division({ division_id: "offline", fee_cents: 2500, payment_method: "offline" });
const FULL = division({ division_id: "full", entrant_kind: "team", fee_cents: 1000, closed_reason: "full", capacity: 4, remaining: 0, taken: 4 });

/** A cart-and-divisions pair per kind of cart the button can face, with the words the spec gives its idle label. */
const CARTS = [
  { name: "free", divisions: [FREE], entries: [entry("e1", "free")], idle: "Enter the competition", widest: "Enter the competition" },
  { name: "card", divisions: [CARD], entries: [entry("e1", "card")], idle: "Pay £25.00 and enter", widest: "Opening secure payment…" },
  // Offline: no "Opening secure payment…" ever shows, so the longest is "Saving your place…" (18) over the idle "Enter — £25.00" (14).
  { name: "pay the organiser", divisions: [OFFLINE], entries: [entry("e1", "offline")], idle: "Enter — £25.00", widest: "Saving your place…" },
  { name: "every entry waits", divisions: [FULL], entries: [entry("e1", "full", "team")], idle: "Join the waiting list", widest: "Join the waiting list" },
] as const;

const labels = (cart: (typeof CARTS)[number], over: { step?: StepId; stepAfter?: StepId | undefined; phase?: SubmitPhase } = {}) =>
  actionBarLabels({
    t,
    plural,
    locale: "en",
    summary: summarizeCart({ entries: [...cart.entries] }, [...cart.divisions]),
    step: over.step ?? "details",
    stepAfter: "stepAfter" in over ? over.stepAfter : "consent",
    phase: over.phase ?? "idle",
  });

describe("widestLabel — the label the button's width is sized to", () => {
  it.each([
    { name: "the card cart's three phases: the card-only 'Opening' is the widest", labels: ["Pay £25.00 and enter", "Saving your place…", "Opening secure payment…"], want: "Opening secure payment…" },
    { name: "the idle label is the widest when it is long", labels: ["Join the waiting list", "Saving your place…"], want: "Join the waiting list" },
    { name: "the phase label is the widest when the idle one is short", labels: ["Enter — £25.00", "Saving your place…"], want: "Saving your place…" },
    { name: "a tie keeps the FIRST (the idle label), so it does not flip as labels change phase", labels: ["Enter the competition", "Saving your place…!!!"], want: "Enter the competition" },
    { name: "one label is its own widest", labels: ["Enter the competition"], want: "Enter the competition" },
  ] as const)("$name", ({ labels: given, want }) => {
    expect(widestLabel(given as unknown as [string, ...string[]])).toBe(want);
  });

  it("the tie case really is a tie (premise: the two labels are the same length)", () => {
    expect("Enter the competition".length).toBe("Saving your place…!!!".length);
  });
});

describe("actionBarLabels — the forward button", () => {
  it.each([
    { step: "who", stepAfter: "entries", want: "Continue to Entries" },
    { step: "entries", stepAfter: "details", want: "Continue to Details" },
    { step: "who", stepAfter: "details", want: "Continue to Details" },
    { step: "details", stepAfter: "consent", want: "Continue to Consent" },
    { step: "consent", stepAfter: "review", want: "Continue to Review" },
  ] as const)("on $step it leads to $stepAfter: '$want'", ({ step, stepAfter, want }) => {
    expect(labels(CARTS[0], { step, stepAfter }).continueLabel).toBe(want);
  });

  it("EMPTY: with no step after it (Review) there is no forward label at all", () => {
    expect(labels(CARTS[0], { step: "review", stepAfter: undefined }).continueLabel).toBe("");
  });
});

describe("actionBarLabels — the phone running total", () => {
  it("a payable cart shows 'N entries · total' on every step before Review", () => {
    const steps: StepId[] = ["who", "entries", "details", "consent"];
    for (const step of steps) expect(labels(CARTS[1], { step }).total, step).toBe("1 entry · £25.00");
    expect(steps.length, "anti-vacuity: four steps checked").toBe(4);
  });

  it("the singular and the plural count: two entries read 'entries'", () => {
    const two = actionBarLabels({
      t,
      plural,
      locale: "en",
      summary: summarizeCart({ entries: [entry("e1", "card"), entry("e2", "card")] }, [CARD]),
      step: "entries",
      stepAfter: "details",
      phase: "idle",
    });
    expect(two.total).toBe("2 entries · £50.00");
  });

  it("is absent on Review (the Pay label already states the fee)", () => {
    expect(labels(CARTS[1], { step: "review", stepAfter: undefined }).total).toBeNull();
  });

  it("is absent for a cart that costs nothing: free, every entry waiting, and an empty cart", () => {
    expect(labels(CARTS[0]).total, "free").toBeNull();
    expect(labels(CARTS[3]).total, "every entry waits").toBeNull();
    const empty = actionBarLabels({ t, plural, locale: "en", summary: summarizeCart({ entries: [] }, [CARD]), step: "who", stepAfter: "entries", phase: "idle" });
    expect(empty.total, "empty").toBeNull();
  });
});

describe("actionBarLabels — the submit button", () => {
  it.each(CARTS.map((c) => ({ ...c })))("$name: idle reads '$idle', saving and opening payment read the phases", (cart) => {
    expect(labels(cart, { step: "review", stepAfter: undefined, phase: "idle" }).submitLabel).toBe(cart.idle);
    expect(labels(cart, { step: "review", stepAfter: undefined, phase: "saving" }).submitLabel).toBe("Saving your place…");
    expect(labels(cart, { step: "review", stepAfter: undefined, phase: "opening_payment" }).submitLabel).toBe("Opening secure payment…");
  });

  it.each(CARTS.map((c) => ({ ...c })))("$name: the width sizer holds '$widest' and does not change with the phase", (cart) => {
    const seen = (["idle", "saving", "opening_payment"] as const).map((phase) => labels(cart, { step: "review", stepAfter: undefined, phase }).widestSubmitLabel);
    expect(seen, "the same sizer in all three phases, or the button's width would move on click").toEqual([cart.widest, cart.widest, cart.widest]);
  });

  it("'Opening secure payment…' sizes the button only for a card cart: a pay-the-organiser cart never shows it", () => {
    expect(labels(CARTS[2]).widestSubmitLabel).not.toBe("Opening secure payment…");
    expect(labels(CARTS[1]).widestSubmitLabel).toBe("Opening secure payment…");
  });
});
