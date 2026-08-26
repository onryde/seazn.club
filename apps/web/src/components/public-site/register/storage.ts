// RS006 chassis — sessionStorage persistence, mid-flow refresh survival
// (RS006 prompt: "browser refresh mid-flow survives (sessionStorage)").
//
// No existing multi-step-form precedent in this repo; mirrors
// lib/analytics-identity.ts's sessionStorage convention instead (the
// closest thing here) — guarded storage access (SSR/privacy-mode-safe),
// try/catch around JSON parse/stringify, drop-and-continue on a malformed
// or version-mismatched entry rather than throwing or misinterpreting it.
// Never throws: a broken save/load must not break the stepper.
import type { CartState, ConsentState, ContactState } from "./types";

// REGISTER_STATE_VERSION bumped 1 -> 2 at RS006 W3 (step 3 — DETAILS):
// CartEntry gained REQUIRED `players`/`answers` fields (types.ts), so a v1
// snapshot's entries lack them entirely — not "empty", ABSENT. Handing that
// to validateDetails/rosterEligibilityForDivision crashes on
// `entry.players.length` (Cannot read properties of undefined), not a
// graceful degrade. Bumping the version makes loadRegisterState's existing
// mismatch check drop it instead (see below) — the mechanism this constant
// exists for.
//
// Bumped 2 -> 3 (RS006 fix): self-link state moved from CartState-level
// (`selfEntryId`/`selfPlayerIndex`) onto EACH CartEntry
// (`registering_self`/`self_player_index`) — a v2 snapshot's entries lack
// those fields entirely (ABSENT, not false/null) and its CartState carries
// the now-deleted top-level pair. Any code reading `entry.registering_self`
// against a restored v2 snapshot would silently see `undefined` (falsy, so
// not a crash here, but a silent loss of every restored self-link) rather
// than a clean drop-and-continue — bumping routes it into the same
// mismatch-drop path instead. Any future CartEntry/CartState shape change
// that isn't purely additive-optional needs the same bump.
//
// Bumped 3 -> 4 (RS006 step 4 — CONSENT): `ContactState` gained REQUIRED
// `guardian_name`/`guardian_consent` fields, and `PersistedRegisterState`
// gained a new top-level `consent` field. A v3 snapshot's `contact` object
// lacks the guardian pair entirely (not null/false) and has no `consent`
// sibling at all — reading either against a restored v3 snapshot would
// silently evaluate to `undefined` (falsy: `guardianRequired`/
// `validateConsent` would treat an unset guardian consent as "not granted",
// which happens to be safe, but `consent.privacy_consent` reading as
// `undefined` is indistinguishable from "not yet decided" only by luck, not
// by contract) rather than a clean drop-and-continue.
export const REGISTER_STATE_VERSION = 4 as const;

export interface PersistedRegisterState {
  version: typeof REGISTER_STATE_VERSION;
  contact: ContactState;
  imPlaying: boolean;
  cart: CartState;
  /** Step 4 (CONSENT)'s two cart-wide choices — see `ConsentState`'s own
   *  doc comment (types.ts) for why these are a separate top-level field
   *  rather than folded into `contact`. */
  consent: ConsentState;
  /** Index into this session's step order (steps.ts) — NOT re-validated
   *  against today's division set on load; the stepper re-derives step
   *  order fresh from live `open` divisions every render and simply clamps
   *  the restored index into range, so a division that closed between
   *  visits can't strand the restored position past the end. Clamped to
   *  the LAST real step (`stepOrder.length - 1`), never `stepOrder.length`
   *  itself — unlike earlier waves, "review" (step 5) is a genuine final
   *  step with its own Submit action, not a step before a "more soon"
   *  end-cap, so there is no longer a one-past-the-end position to restore
   *  into. */
  stepIndex: number;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): StorageLike | null {
  try {
    // Guarded: absent during SSR/tests; access can throw in some privacy modes.
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** One key per (org, competition) — a rep with two tabs open on two
 *  different competitions (or two different orgs) must never see one
 *  draft clobber the other. */
function storageKey(orgSlug: string, competitionSlug: string): string {
  return `seazn_register_${orgSlug}_${competitionSlug}`;
}

export function loadRegisterState(
  orgSlug: string,
  competitionSlug: string,
  storage: StorageLike | null = defaultStorage(),
): PersistedRegisterState | null {
  if (!storage) return null;
  const key = storageKey(orgSlug, competitionSlug);
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null; // storage access itself can throw in some privacy modes
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedRegisterState> | null;
    if (!parsed || parsed.version !== REGISTER_STATE_VERSION) {
      // Malformed shape, or a future/older version this code doesn't know
      // how to interpret — drop it rather than guess.
      try {
        storage.removeItem(key);
      } catch {
        /* storage gone mid-flight — nothing to clean */
      }
      return null;
    }
    return parsed as PersistedRegisterState;
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      /* storage gone mid-flight — nothing to clean */
    }
    return null;
  }
}

export function saveRegisterState(
  orgSlug: string,
  competitionSlug: string,
  state: PersistedRegisterState,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(storageKey(orgSlug, competitionSlug), JSON.stringify(state));
  } catch {
    /* quota/privacy-mode write failure — the flow still works, just unsaved */
  }
}

export function clearRegisterState(
  orgSlug: string,
  competitionSlug: string,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(storageKey(orgSlug, competitionSlug));
  } catch {
    /* storage unavailable — nothing saved to clear */
  }
}
