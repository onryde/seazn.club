// The name an ad-hoc entrant is BORN with, and how that name follows its roster.
//
// `entrants.display_name` is free text, derived once at create from the people
// picked — "Sankar & Ritwik". Two create sites derive it: the organiser's add
// form (`NewEntrantFields`, components/v2/entrants-panel.tsx) and the public
// registration submit (`entryDisplayName`, server/usecases/registration-submit.ts).
// Nothing re-derived it afterwards, so a pair that swapped Ritwik for Venkatesh
// kept printing "Sankar & Ritwik" everywhere (reported from production,
// 2026-09-22). `patchEntrant` (server/usecases/entrants.ts) now rebuilds the name
// on a roster edit — but only while it is still the one the roster derived, and
// it can only recognise that if it joins EXACTLY the way the create sites did.
// Hence one join, here, imported by all three.
//
// Not the same question as `entrantDisplayName` (lib/entrant-name.ts), which
// decides what a SCORING surface prints and uses doubles notation (" / ") at
// render time without writing anything. This file is about the stored column.
//
// Isomorphic and dependency-free: the client add form imports it.

/** The create-time separator. One place: the recogniser below depends on it. */
export const ROSTER_NAME_SEPARATOR = " & ";

/** The longest `entrants.display_name` the API accepts — `CreateEntrant` and
 *  `PatchEntrant` (server/api-v1/schemas.ts) read it from here, and so does the
 *  console's Name field, so the input cannot offer a name the PATCH refuses. */
export const ENTRANT_NAME_MAX = 200;

/** The create-time derivation: the people's full names, in the order given,
 *  joined. A missing name is skipped rather than leaving a dangling separator —
 *  the registration submit relies on that for an absent partner. One name is
 *  just that name (an individual); nobody is the empty string. */
export function rosterDerivedName(names: readonly (string | null | undefined)[]): string {
  return names.filter((n): n is string => Boolean(n)).join(ROSTER_NAME_SEPARATOR);
}

/** A rostered person, as far as naming is concerned. */
export interface RosterNamePerson {
  readonly person_id: string;
  readonly full_name: string;
}

/**
 * The name an entrant should carry after its roster changed from `prior` to
 * `next`, or `null` to leave `currentName` exactly as it is.
 *
 * Only a name the prior roster DERIVED is followed: `currentName` must be
 * `rosterDerivedName` of the prior people in SOME order (entrant_members has no
 * order column, so the roster is matched as a multiset), with every name token
 * claimed by a distinct person, matched exactly. Anything else — "Smash Bros", a
 * hand-corrected spelling, a name naming only some of the roster, a name given
 * before anyone was rostered — is the organiser's, and is never touched.
 *
 * A derived name is rebuilt by POSITION: a person still on the roster keeps
 * their place in the name, a person who left is replaced in place by the next
 * newcomer (in submitted order), and the rest are appended or, with no newcomer
 * left, dropped. So "Sankar & Ritwik" − Ritwik + Venkatesh is
 * "Sankar & Venkatesh", whatever order the roster arrived in.
 *
 * A person on both rosters takes the name they have in `next`. For a roster
 * edit that is the name they already had. For a PLAYER's rename
 * (`followRosterNames`, usecases/entrants.ts), `prior` carries the old name
 * the entrant's was derived from and `next` the new one. So "Sankar & Ritwik"
 * becomes "Sankar Krishnan & Ritwik" when Sankar is renamed, and Sankar keeps
 * his seat.
 *
 * Returns `null`, too, when the rebuild would change nothing, or would leave no
 * name at all (a roster cleared to nobody keeps the last name it had — the
 * column cannot be empty, and an empty roster has nothing to name it after).
 */
export function followRosterEdit(
  currentName: string,
  prior: readonly RosterNamePerson[],
  next: readonly RosterNamePerson[],
): string | null {
  // One token per person. `split` always yields at least one token, so this
  // also refuses an empty prior roster — which derives "", and no stored name
  // is empty.
  const tokens = currentName.split(ROSTER_NAME_SEPARATOR);
  if (tokens.length !== prior.length) return null;

  // Claim each token for a distinct prior person of exactly that name. Once
  // every token is claimed, joining the claimants' names IS `currentName` —
  // the split and the join are the same separator — so the name is exactly
  // `rosterDerivedName` of the prior people in this order.
  const unclaimed = [...prior];
  const seats: RosterNamePerson[] = [];
  for (const token of tokens) {
    const i = unclaimed.findIndex((p) => p.full_name === token);
    if (i < 0) return null;
    seats.push(unclaimed.splice(i, 1)[0]!);
  }

  const staying = new Map(next.map((p) => [p.person_id, p.full_name]));
  const before = new Set(prior.map((p) => p.person_id));
  const newcomers = next.filter((p) => !before.has(p.person_id));
  let n = 0;
  const names: string[] = [];
  for (const seat of seats) {
    const stays = staying.get(seat.person_id);
    if (stays !== undefined) names.push(stays);
    else if (n < newcomers.length) names.push(newcomers[n++]!.full_name);
    // else: left, and nobody to take the place — the seat goes.
  }
  while (n < newcomers.length) names.push(newcomers[n++]!.full_name);

  const rebuilt = rosterDerivedName(names);
  if (rebuilt === "" || rebuilt === currentName) return null;
  return rebuilt;
}
