// RS006 chassis — sessionStorage persistence, mid-flow refresh survival
// (RS006 prompt: "browser refresh mid-flow survives (sessionStorage)").
//
// No existing multi-step-form precedent in this repo; mirrors
// lib/analytics-identity.ts's sessionStorage convention instead (the
// closest thing here) — guarded storage access (SSR/privacy-mode-safe),
// try/catch around JSON parse/stringify, drop-and-continue on a malformed
// or version-mismatched entry rather than throwing or misinterpreting it.
// Never throws: a broken save/load must not break the stepper.
import type { CartState, ContactState } from "./types";

// REGISTER_STATE_VERSION bumped 1 -> 2 at RS006 W3 (step 3 — DETAILS):
// CartEntry gained REQUIRED `players`/`answers` fields (types.ts), so a v1
// snapshot's entries lack them entirely — not "empty", ABSENT. Handing that
// to validateDetails/rosterEligibilityForDivision crashes on
// `entry.players.length` (Cannot read properties of undefined), not a
// graceful degrade. Bumping the version makes loadRegisterState's existing
// mismatch check drop it instead (see below) — the mechanism this constant
// exists for. Any future CartEntry/CartState shape change that isn't purely
// additive-optional needs the same bump.
export const REGISTER_STATE_VERSION = 2 as const;

export interface PersistedRegisterState {
  version: typeof REGISTER_STATE_VERSION;
  contact: ContactState;
  imPlaying: boolean;
  cart: CartState;
  /** Index into this session's step order (steps.ts) — NOT re-validated
   *  against today's division set on load; the stepper re-derives step
   *  order fresh from live `open` divisions every render and simply clamps
   *  the restored index into range, so a division that closed between
   *  visits can't strand the restored position past the end. */
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
