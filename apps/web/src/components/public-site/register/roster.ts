// RS006 step 3 (DETAILS) — roster parse/serialize + wire mapping. Pure, no
// DOM (matches cart.ts/steps.ts/validation.ts's convention in this tree).
//
// parseRoster is recovered VERBATIM (token-classification-wise) from git
// history (76ef7987b:apps/web/src/components/public-site/
// register-form.tsx:76-93) — same precedence (ISO date > 1-3 digit squad
// number > first free token is the name), same silent-drop of any token
// past the first name candidate, same post-loop parts[0] fallback quirk for
// a line with no name-shaped token at all. Renamed `Player.name` ->
// `full_name` to match the wire field (`PublicRegisterGroupPlayer.full_name`,
// schemas.ts:2381) rather than inventing a second name for the same thing,
// and returns full RosterPlayerState rows (picking up gender/email/
// is_captain from EMPTY_ROSTER_PLAYER's defaults) instead of the old
// narrower `{name, dob, squad_number}` shape.
//
// serializeRoster is NEW (RS006 W3) — the paste format's own inverse, built
// for the round-trip property test (roster.test.ts). It is NOT a general
// RosterPlayerState serializer: the historical format has no columns for
// gender/email/is_captain, so those never appear in its output and can
// never round-trip through it — see roster.test.ts for exactly which
// roster shapes ARE representable, and why each constraint is real (not a
// narrowing that dodges a bug).
import type { CartEntry, ContactState, Gender, RosterPlayerState } from "./types";
import { EMPTY_ROSTER_PLAYER } from "./types";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseRoster(text: string): RosterPlayerState[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      let name = "";
      let dob = "";
      let squad = "";
      for (const part of parts) {
        if (ISO_DATE.test(part)) dob = part;
        else if (/^\d{1,3}$/.test(part) && !squad) squad = part;
        else if (!name) name = part;
      }
      if (!name) name = parts[0] ?? "";
      return { ...EMPTY_ROSTER_PLAYER, full_name: name, dob: dob || null, squad_number: squad };
    })
    .filter((p) => p.full_name);
}

/** The paste format's own inverse — one line per player, `full_name` first
 *  (then squad_number, then dob, when present; blank fields simply
 *  omitted, matching how `parseRoster` already drops empty comma tokens via
 *  its own `.filter(Boolean)`). Only meaningful for a roster `parseRoster`
 *  can actually re-read — see this file's header and roster.test.ts. */
export function serializeRoster(players: readonly RosterPlayerState[]): string {
  return players
    .map((p) =>
      [p.full_name, p.squad_number || null, p.dob]
        .filter((v): v is string => Boolean(v))
        .join(", "),
    )
    .join("\n");
}

/** One roster row -> `PublicRegisterGroupPlayer`'s wire shape
 *  (schemas.ts:2380-2387). Pure mapping, called by `toGroupPlayers` below —
 *  not wired into an actual submit call this session (step 5 doesn't exist
 *  yet), provided so that seam is proven trivial once it does, the same
 *  reason `cart.ts`'s `toGroupEntry` was built ahead of its own caller. */
export function toGroupPlayer(p: RosterPlayerState): {
  full_name: string;
  dob: string | null;
  gender: Gender | null;
  email: string | null;
  squad_number: number | null;
  is_captain: boolean | undefined;
} {
  return {
    full_name: p.full_name.trim(),
    dob: p.dob,
    gender: p.gender,
    email: p.email.trim() || null,
    squad_number: p.squad_number ? Number(p.squad_number) : null,
    is_captain: p.is_captain || undefined,
  };
}

/** A whole entry's roster -> wire players[]. TEAM kind drops rows with no
 *  name typed (a row the captain never filled in is not submitted as a
 *  blank player) — same behaviour the recovered form had
 *  (`.filter(({p}) => p.name.trim())`, register-form.tsx). Individual/pair
 *  rows are kept AS-IS even blank: those kinds are fixed-size (1/2) by the
 *  roster builder itself, and `validation.ts`'s `validateDetails` — not
 *  this mapper — is what blocks "Next" on a blank required row. */
export function toGroupPlayers(
  players: readonly RosterPlayerState[],
  kind: CartEntry["entrant_kind"],
): ReturnType<typeof toGroupPlayer>[] {
  const effective = kind === "team" ? players.filter((p) => p.full_name.trim()) : players;
  return effective.map(toGroupPlayer);
}

/**
 * Mirrors `registration-submit.ts`'s own self-row fallback (~line 405-411)
 * for PRESENTATION: "The self row's dob/gender fall back to the contact's
 * cart-level values ... when the row itself didn't repeat them" (design §4
 * step 1: "collected once"). Without this, a self-linked player who left
 * their roster row's dob/gender blank (correctly relying on the server's
 * own fallback) would see a false-positive MISSING_DOB/MISSING_GENDER
 * eligibility block in the client pre-check, even though the server would
 * accept the submission. Does NOT mutate `players` — callers pass the
 * result to `rosterEligibilityForDivision` for a live verdict; the roster
 * TABLE itself still renders/edits the raw (unmerged) rows, so an input
 * never shows a value the registrant didn't type.
 *
 * Returns the SAME array reference when there is nothing to merge (no self
 * row, or an index that doesn't resolve to a real row) — matching every
 * other pure helper in this tree's "same reference when it's a no-op"
 * convention.
 */
export function effectiveSelfPlayers(
  players: readonly RosterPlayerState[],
  selfIndex: number | null,
  contact: Pick<ContactState, "dob" | "gender">,
): readonly RosterPlayerState[] {
  if (selfIndex === null || !players[selfIndex]) return players;
  return players.map((p, i) => (i === selfIndex ? { ...p, dob: p.dob ?? contact.dob, gender: p.gender ?? contact.gender } : p));
}

/**
 * The effective dob for the CONTACT'S OWN row on ONE self-linked entry —
 * the same fallback `effectiveSelfPlayers` above applies (`p.dob ??
 * contact.dob`), for exactly the row identified as "self." Used by
 * validation.ts's `guardianRequired` (guardian-consent-bypass fix, HIGH,
 * 2026-08-26): `roster-table.tsx` renders a plain editable
 * `<input type="date">` for EVERY roster row once a division requires_dob,
 * including the row marked "This is me" — no `readOnly`/`disabled`. Before
 * this fix, both `guardianRequired` and `step-consent.tsx`'s guardian-block
 * trigger keyed on `contact.dob` ALONE, so typing a minor's dob directly
 * into the self row (leaving an adult step-1 `contact.dob` untouched)
 * skipped the guardian block entirely on the client — and
 * registration-submit.ts's own gate had the identical `contact.dob`-only
 * blind spot server-side (fixed in the same change).
 *
 * Resolves WHICH row is "self" the same way `registration-submit.ts` does
 * (~line 398-406), including its individual-implies-index-0 fallback:
 * entry-details.tsx's self-row picker never renders for an "individual"
 * entry (`showSelfPicker`), so `self_player_index` stays `null` in client
 * state for that kind forever — the schema still implies row 0 is the
 * contact.
 *
 * Falls back to `contact.dob` (the OLD, pre-fix signal) whenever no row can
 * be resolved at all — e.g. mid-flow before step 3 has built out a roster,
 * or a pair/team entry whose self-row picker hasn't been used yet. This
 * function only WIDENS what can trigger the guardian block; it must never
 * narrow it back to "unknown" just because a roster row isn't there yet.
 * Returns null only when the entry isn't self-linked at all.
 */
export function effectiveSelfDob(
  entry: Pick<CartEntry, "registering_self" | "self_player_index" | "entrant_kind" | "players">,
  contact: Pick<ContactState, "dob">,
): string | null {
  if (!entry.registering_self) return null;
  const idx =
    entry.self_player_index ?? (entry.entrant_kind === "individual" && entry.players.length === 1 ? 0 : null);
  const row = idx !== null ? entry.players[idx] : undefined;
  return (row ? row.dob : null) ?? contact.dob;
}
