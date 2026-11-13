// Registration redesign B2 T10 (spec 7.3, Review) - what the Review step lists beside the money: who is entering, what they answered
// and what they agreed to, plus where each section's "Edit" goes (pure, no DOM).
//
// Deliberately NOT part of `summarizeCart` (cart.ts): that function is the ONE subtotal/waitlist computation, shared with the Entries
// step's cart, and takes the cart and the divisions only. The contact and the consents are not in the cart, and the Entries step has no
// use for them, so widening it would hand the Entries step a signature it cannot fill. The money still comes from `summarizeCart`; this
// is the rest, built from the same three states the submit reads (cart, contact, consent), so the page cannot list something the
// request does not carry.
import type { CartState, ConsentState, ContactState, DivisionLike, StepId } from "./types";
import { guardianRequired } from "./validation";

/** One question an entry's division asked, with what was answered. `null` = not answered (a skipped optional question). A checkbox is
 *  never `null`: unticked is a definite `false`. */
export interface ReviewAnswerLine {
  label: string;
  value: string | boolean | null;
}

/** The questions one entry's division asked. One group per ENTRY, not per division: two teams in one division answer separately. */
export interface ReviewAnswerGroup {
  entryId: string;
  /** The division's name, so a group can be told apart when there are several. */
  division: string;
  lines: ReviewAnswerLine[];
}

export interface ReviewContent {
  contact: { name: string; email: string };
  /** Empty when no entry's division asks anything: Review then has no Answers section at all. */
  answers: ReviewAnswerGroup[];
  consents: { privacy: boolean; media: boolean };
  /** The guardian the submit carries (`guardian_name`, `guardian_consent`), present exactly when the Consent step asked for one
   *  (`guardianRequired`, validation.ts: a self-registering player under 18). null otherwise, even if values are still held from
   *  before the registrant changed a date of birth: the step does not show them then, so Review does not either. */
  guardian: { name: string; consent: boolean } | null;
}

export function reviewContent(
  cart: CartState,
  divisions: readonly DivisionLike[],
  contact: Pick<ContactState, "name" | "email" | "dob" | "guardian_name" | "guardian_consent">,
  consent: ConsentState,
  now: Date,
): ReviewContent {
  const byId = new Map(divisions.map((d) => [d.division_id, d]));
  const answers: ReviewAnswerGroup[] = [];
  for (const entry of cart.entries) {
    const division = byId.get(entry.division_id);
    // A solo sign-up is not shown the organiser's questions (entry-details.tsx renders the roster only), so it has none to list.
    if (!division || entry.free_agent || division.form_fields.length === 0) continue;
    answers.push({
      entryId: entry.id,
      division: division.name,
      lines: division.form_fields.map((field) => {
        const raw = entry.answers[field.key];
        if (field.kind === "checkbox") return { label: field.label, value: raw === true };
        const text = typeof raw === "string" ? raw.trim() : "";
        return { label: field.label, value: text === "" ? null : text };
      }),
    });
  }
  return {
    contact: { name: contact.name.trim(), email: contact.email.trim() },
    answers,
    consents: { privacy: consent.privacy_consent, media: consent.media_consent },
    guardian: guardianRequired(cart, contact, now)
      ? { name: (contact.guardian_name ?? "").trim(), consent: contact.guardian_consent }
      : null,
  };
}

export type ReviewSection = "you" | "entries" | "answers" | "consent";

/** The step each section is edited on. Entries are added on `entries` but their players are named on `details`, so a one-division
 *  competition, which has no Entries step, sends that section's Edit to Details. Returns the INDEX into `order` (what the stepper
 *  jumps by), or null when the step is not in the order: the caller shows no Edit rather than a button that goes somewhere else. */
export function reviewEditTarget(section: ReviewSection, order: readonly StepId[]): number | null {
  const step: StepId =
    section === "you" ? "who" : section === "entries" ? (order.includes("entries") ? "entries" : "details") : section === "answers" ? "details" : "consent";
  const index = order.indexOf(step);
  return index === -1 ? null : index;
}
