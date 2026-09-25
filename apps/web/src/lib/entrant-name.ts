// R7 / Task C, C5 (D-6) — what to CALL an entrant on a scoring surface.
//
// `entrants.display_name` is a TEAM-sports concept. It is snapshotted from
// the team at registration precisely so a later rename cannot rewrite
// historical standings (`server/usecases/entrants.ts`), and for a team that
// is exactly right. A singles competitor or a doubles pair has no team to
// snapshot, so the column holds whatever text the entry flow happened to put
// there — which is how a console came to say "Entry 3" above a board where
// two named people were playing.
//
// The people are already on the wire. `SideInfo.members` carries them, and
// `SideInfo.kind` is the entrant's OWN declared kind (`entrants.kind`,
// validated at registration against the division's effective entrant model)
// — the authoritative answer to "is this entrant a pair", which
// `lineup-editor.tsx` already reads for exactly this reason instead of
// inferring pair-shapedness from catalog shape and member count.
//
// Isomorphic and dependency-free on purpose: the fixture console, the
// courtside device pad and anything later that renders a scoreline all need
// the same answer, and a second implementation is how two surfaces come to
// disagree about who is playing.

/** The four fields this resolution reads. Structural rather than importing
 *  `SideInfo`: `lib/` must not depend on a component's props type, and a
 *  narrower shape keeps this callable from a server loader too. */
export interface EntrantNameSource {
  /** `entrants.display_name` — the snapshot, and the fallback. */
  readonly name: string;
  /** `entrants.kind`: "team" | "individual" | "pair". Optional on the wire
   *  (fixtures and callers predate the column); absent means "assume the
   *  snapshot is right", which is the safe half of the decision. */
  readonly kind?: string;
  readonly members: readonly { readonly person_id: string; readonly full_name: string }[];
  /** Read ONLY for a pair's order — `pair_order` is the doubles serve order
   *  the engine's own `LineupSlot.pairOrder` carries. Members' array order is
   *  roster order, which is not the pair's order. */
  readonly lineup?: readonly { readonly person_id: string; readonly pair_order?: number | null }[];
}

/** Doubles notation. One separator, one place. */
const PAIR_SEPARATOR = " / ";

/**
 * A pair's members in its saved `pair_order` where the lineup has one, roster
 * order otherwise. Exported for a surface that prints the members one per
 * line (the scorer sheet's card), so its lines follow the name's order.
 */
export function pairOrdered<M extends { readonly person_id: string }>(
  members: readonly M[],
  lineup: EntrantNameSource["lineup"],
): readonly M[] {
  const order = new Map<string, number>();
  for (const slot of lineup ?? []) {
    if (typeof slot.pair_order === "number") order.set(slot.person_id, slot.pair_order);
  }
  if (order.size === 0) return members;
  return [...members].sort(
    (a, b) => (order.get(a.person_id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.person_id) ?? Number.MAX_SAFE_INTEGER),
  );
}

/**
 * The name to render for this entrant on a scoring surface.
 *
 * Falls back to `name` whenever the roster cannot answer — an individual
 * entrant with no member yet, a "pair" holding one person, an unknown kind.
 * Rendering an empty string, or half a pair, is worse than the label the
 * entry flow supplied: the fallback is always a real, human-chosen string.
 */
export function entrantDisplayName(side: EntrantNameSource): string {
  if (side.kind === "individual") {
    return side.members.length === 1 ? side.members[0]!.full_name : side.name;
  }
  if (side.kind === "pair") {
    if (side.members.length !== 2) return side.name;
    return pairOrdered(side.members, side.lineup)
      .map((m) => m.full_name)
      .join(PAIR_SEPARATOR);
  }
  return side.name;
}
