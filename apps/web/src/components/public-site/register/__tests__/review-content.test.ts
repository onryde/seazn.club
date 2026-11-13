// Registration redesign B2 T10 - what the Review step lists besides money: who is entering, what they answered, what they agreed to.
// (Pure, no DOM.) The expected values below are the form's own: the answers are keyed by the division's declared `form_fields`, the
// consents are the two checkboxes' own state, and the step list is `buildStepOrder`'s - none is derived from `review-content.ts`.
import { describe, expect, it } from "vitest";
import { reviewContent, reviewEditTarget, type ReviewSection } from "../review-content";
import { buildStepOrder } from "../steps";
import {
  EMPTY_CONSENT,
  EMPTY_CONTACT,
  EMPTY_ROSTER_PLAYER,
  type CartEntry,
  type DivisionLike,
  type FormFieldDef,
} from "../types";

const FIELDS: FormFieldDef[] = [
  { key: "shirt", label: "Shirt size", kind: "text", required: false },
  { key: "diet", label: "Dietary needs", kind: "select", options: ["None", "Vegetarian"], required: true },
  { key: "ack", label: "Court rules acknowledged", kind: "checkbox", required: false },
];

const division = (id: string, name: string, form_fields: FormFieldDef[] = []): DivisionLike => ({
  division_id: id,
  name,
  entrant_kind: "individual",
  category: null,
  age_min: null,
  age_max: null,
  requires_dob: false,
  requires_gender: false,
  allow_free_agents: true,
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
  form_fields,
});

const entry = (id: string, division_id: string, patch: Partial<CartEntry> = {}): CartEntry => ({
  id,
  division_id,
  entrant_kind: "individual",
  team_name: null,
  partner_name: null,
  free_agent: false,
  players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "Mia Cole" }],
  answers: {},
  registering_self: false,
  self_player_index: null,
  ...patch,
});

const ASKS = division("d-asks", "Asking Division", FIELDS);
const PLAIN = division("d-plain", "Plain Division");
const contact = { ...EMPTY_CONTACT, name: "  Mia Cole ", email: " mia@example.com " };
const consent = { privacy_consent: true, media_consent: false };

describe("reviewContent: who, what they answered, what they agreed to", () => {
  it("the contact is the trimmed name and email, and the consents are the two checkboxes' own state", () => {
    const out = reviewContent({ entries: [] }, [], contact, consent);
    expect(out.contact).toEqual({ name: "Mia Cole", email: "mia@example.com" });
    expect(out.consents).toEqual({ privacy: true, media: false });
    expect(reviewContent({ entries: [] }, [], contact, { privacy_consent: false, media_consent: true }).consents).toEqual({ privacy: false, media: true });
  });

  it("EMPTY: no entries, or entries whose divisions ask nothing, give no answers at all (Review then omits the section)", () => {
    expect(reviewContent({ entries: [] }, [ASKS], EMPTY_CONTACT, EMPTY_CONSENT).answers).toEqual([]);
    const cart = { entries: [entry("e1", "d-plain"), entry("e2", "d-plain")] };
    expect(reviewContent(cart, [PLAIN], EMPTY_CONTACT, EMPTY_CONSENT).answers).toEqual([]);
  });

  it("one group per entry whose division asks questions, in cart order, each line labelled by the organiser's own question", () => {
    const cart = {
      entries: [
        entry("e1", "d-asks", { answers: { shirt: " M ", diet: "Vegetarian", ack: true } }),
        entry("e2", "d-plain"),
        entry("e3", "d-asks", { answers: { shirt: "L", diet: "None", ack: false } }),
      ],
    };
    const out = reviewContent(cart, [ASKS, PLAIN], contact, consent).answers;
    expect(out.map((g) => g.entryId), "the plain entry has no group").toEqual(["e1", "e3"]);
    expect(out[0]).toEqual({
      entryId: "e1",
      division: "Asking Division",
      lines: [
        { label: "Shirt size", value: "M" },
        { label: "Dietary needs", value: "Vegetarian" },
        { label: "Court rules acknowledged", value: true },
      ],
    });
    expect(out[1]!.lines.map((l) => l.value)).toEqual(["L", "None", false]);
  });

  it("an unanswered question is null, never an empty string, and an unticked checkbox is a definite false", () => {
    const cart = { entries: [entry("e1", "d-asks", { answers: { shirt: "   " } })] };
    const lines = reviewContent(cart, [ASKS], contact, consent).answers[0]!.lines;
    expect(lines.map((l) => l.value)).toEqual([null, null, false]);
  });

  it("a solo sign-up is never asked the organiser's questions (the Details step does not show them), and an unknown division has no group", () => {
    const cart = {
      entries: [entry("solo", "d-asks", { free_agent: true, answers: { shirt: "stale" } }), entry("gone", "d-vanished")],
    };
    expect(reviewContent(cart, [ASKS], contact, consent).answers).toEqual([]);
  });
});

describe("reviewEditTarget: the step each Review section's Edit goes to", () => {
  const FIVE = buildStepOrder(2, "individual"); // who, entries, details, consent, review
  const FOUR = buildStepOrder(1, "individual"); // Entries collapses away
  const WANT: Record<ReviewSection, [string, string]> = {
    you: ["who", "who"],
    entries: ["entries", "details"],
    answers: ["details", "details"],
    consent: ["consent", "consent"],
  };

  it.each([
    ["five steps", FIVE, 0],
    ["four steps (one division, Entries collapsed)", FOUR, 1],
  ] as const)("%s", (_label, order, col) => {
    expect(order.length, "premise: the order under test").toBe(col === 0 ? 5 : 4);
    let checked = 0;
    for (const [section, want] of Object.entries(WANT) as [ReviewSection, [string, string]][]) {
      const index = reviewEditTarget(section, order);
      expect(index, `${section} resolves`).not.toBeNull();
      expect(order[index!], `${section} goes to the step that edits it`).toBe(want[col]);
      checked++;
    }
    expect(checked, "anti-vacuity: all four sections").toBe(4);
  });

  it("a step that is not in the order has no target, never a guessed index", () => {
    expect(reviewEditTarget("answers", ["who", "review"])).toBeNull();
    expect(reviewEditTarget("entries", [])).toBeNull();
  });
});
