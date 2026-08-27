// RS006 step 5 — REVIEW→PAY. Pure request-body construction
// (`buildSubmitBody`) + the post-submit redirect decision
// (`resolvePostSubmitNavigation`). No DOM, no fetch — matches this tree's
// convention (cart.ts/steps.ts/validation.ts/roster.ts) of keeping every
// non-trivial computation pure and testable, with register-stepper.tsx's
// actual apiV1() call and window.location.assign/router.push staying thin,
// by-inspection wrappers around these two functions.
import { toGroupEntry } from "./cart";
import { toGroupPlayers } from "./roster";
import type { CartState, ConsentState, ContactState } from "./types";

/** Mirrors `PublicRegisterGroupRequest`'s wire shape (schemas.ts:2430)
 *  field-for-field. `locale` is deliberately absent: the route resolves it
 *  server-side from the `seazn_locale` cookie (route.ts's own
 *  `explicitLocale`) and never reads a client-supplied one, so there is
 *  nothing correct for this shape to send. */
export interface SubmitRequestBody {
  contact: {
    name: string;
    email: string;
    dob: string | null;
    gender: string | null;
    guardian_name: string | null;
    guardian_consent: boolean;
  };
  privacy_consent: boolean;
  media_consent: boolean;
  entries: Array<
    ReturnType<typeof toGroupEntry> & {
      players: ReturnType<typeof toGroupPlayers>;
      answers: Record<string, string | boolean>;
    }
  >;
  /** Honeypot (design §4 step 5 / RS003's route.ts) — carried through
   *  verbatim; the route decides what a filled value means, not this. */
  website: string;
}

/**
 * Composes the WHOLE submit body from the chassis's three pieces of state
 * (contact, consent, cart) — cart.ts's `toGroupEntry` doc comment
 * anticipated exactly this: "a caller building the full request object
 * spreads this together with those [players/answers] once they exist."
 * Name/email are trimmed here (the ONE place that matters — every other
 * mapper in this tree leaves strings as typed); every other field maps
 * straight through.
 */
export function buildSubmitBody(
  contact: ContactState,
  consent: ConsentState,
  cart: CartState,
  website: string,
): SubmitRequestBody {
  return {
    contact: {
      name: contact.name.trim(),
      email: contact.email.trim(),
      dob: contact.dob,
      gender: contact.gender,
      guardian_name: contact.guardian_name,
      guardian_consent: contact.guardian_consent,
    },
    privacy_consent: consent.privacy_consent,
    media_consent: consent.media_consent,
    entries: cart.entries.map((entry) => ({
      ...toGroupEntry(entry),
      players: toGroupPlayers(entry.players, entry.entrant_kind),
      answers: entry.answers,
    })),
    website,
  };
}

/** The subset of `PublicRegisterGroupResponse` (schemas.ts:2499) the
 *  post-submit redirect decision needs. */
export interface SubmitResultShape {
  group_id: string;
  access_token: string;
  checkout_url: string | null;
}

export type PostSubmitNavigation = { kind: "checkout"; url: string } | { kind: "status"; url: string };

/**
 * Design §4 step 5: "checkout_url non-null → redirect... checkout_url null
 * (free / offline) → straight to the status ref." The status URL uses
 * `?rid=<group_id>&token=<access_token>`, NOT `?ref=` — the same convention
 * `buildCartMail`'s statusUrl and `createRegistrationCheckout`'s Stripe
 * success/cancel URLs already mint (registrations.ts), and the one
 * `status/page.tsx` actually reads (via `groupById`): `ref_code` is
 * nullable on the schema, `group_id` never is.
 */
export function resolvePostSubmitNavigation(
  result: SubmitResultShape,
  orgSlug: string,
  competitionSlug: string,
): PostSubmitNavigation {
  if (result.checkout_url) return { kind: "checkout", url: result.checkout_url };
  return {
    kind: "status",
    url: `/shared/${orgSlug}/${competitionSlug}/register/status?rid=${result.group_id}&token=${encodeURIComponent(result.access_token)}`,
  };
}

/**
 * FIX 3 (RS006 fix wave) — step 5's submit/pay failure path used to render
 * `err.message` verbatim as the ONLY thing the registrant saw: a bare
 * server string (English-only, no server-side i18n — see `lib/errors.ts`)
 * with no distinction between "retry the exact same click" and "something
 * about THIS submission needs to change first." This classifies an HTTP
 * status into which of register-stepper.tsx's two localized recovery
 * messages applies.
 *
 * `"retry"` — a 409 (a concurrent checkout-mint race losing the
 * compare-and-swap in `createRegistrationCheckout`,
 * `REGISTRATION_CHECKOUT_CONFLICT`, `registrations.ts`) or any 5xx: the
 * failure is about TIMING/availability, not about what was submitted, so
 * the exact same request is expected to succeed on retry. Absent status
 * (no response reached the client at all — a dropped connection) is also
 * bucketed here: the more optimistic assumption, and the one "please try
 * again" is honest advice for.
 *
 * `"rejected"` — a 400 or 422: the SERVER refused this submission's own
 * content. The honeypot's 400 is deliberately included here even though it
 * is usually a false positive (a password manager filling the hidden
 * field, not a real bot) — the response is indistinguishable, from this
 * function's only input, from any other 400, and clicking Submit again
 * with the EXACT same body would fail the exact same way either way, so
 * "try again" would be dishonest advice.
 *
 * Any OTHER status (401/403/404/429/…) also falls to `"rejected"` — a
 * narrower "at minimum 409/5xx vs 400/422" was the brief; nothing about
 * this endpoint makes those specific codes reachable today, and "ask for
 * something to change, or contact the organiser" degrades more safely than
 * an unconditional "try again" would for an unanticipated code.
 */
export type SubmitFailureKind = "retry" | "rejected";

export function classifySubmitFailure(status: number | undefined): SubmitFailureKind {
  if (status === undefined) return "retry";
  if (status === 409 || status >= 500) return "retry";
  return "rejected";
}
