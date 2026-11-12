// Polish wave P4 (walkthrough W1, W3) — what the DETAILS step starts with, from what steps 1 and 2 already collected (pure, no DOM).
//
// Before this, a registrant who typed their name on step 1 and ticked "I'm registering myself" met an empty Player 1 and typed the name a
// second time; a partner typed on step 2 ("Add a pair") met an empty Player 2. The rule is ONE-WAY and BLANK-ONLY: a row is only ever
// filled while its name is empty, so whatever the registrant typed over a seed (or a name they chose to clear and retype) is never
// replaced when they step back and forward again, and a second call is a no-op that returns the SAME reference.
import { resolveSelfPlayerIndex } from "./roster";
import type { CartEntry, CartState, ContactState, DivisionLike, RosterPlayerState } from "./types";

type SeedDivision = Pick<DivisionLike, "division_id" | "requires_dob" | "requires_gender">;

/** The contact's own row: name always; dob/gender only when the division asks for them (the row shows those inputs only then, and a
 *  visible empty required field beside an answer the registrant already gave is the friction this removes). A row's own value is kept. */
function selfRow(row: RosterPlayerState, contact: ContactState, division: SeedDivision | undefined): RosterPlayerState {
  const name = contact.name.trim();
  return {
    ...row,
    full_name: row.full_name.trim() ? row.full_name : name,
    dob: row.dob ?? (division?.requires_dob ? contact.dob : null),
    gender: row.gender ?? (division?.requires_gender ? contact.gender : null),
  };
}

function seedEntry(entry: CartEntry, contact: ContactState, division: SeedDivision | undefined): CartEntry {
  // A TEAM roster starts EMPTY by design (cart.ts's blankPlayers) and the captain builds it with "+ Add player"; seeding a row there
  // would leave a trailing blank row for every captain who then adds their own (a blank row blocks Next). A solo (free agent) sign-up is
  // a team-kind entry with no roster at all (design §4 step 3: "nothing extra"), so this one guard covers both.
  if (entry.entrant_kind === "team") return entry;
  const name = contact.name.trim();
  const partner = entry.partner_name?.trim() ?? "";
  let players = entry.players;
  let selfIndex = entry.self_player_index;

  // Which row is the contact, when the contact is on this entry. Individual implies row 0 (cart.ts's toGroupEntry); a pair defaults to
  // Player 1 (the partner field is Player 2 - roster-table.tsx's rowLabel).
  if (entry.registering_self && name) {
    const index = entry.entrant_kind === "pair" ? (selfIndex ?? 0) : resolveSelfPlayerIndex(entry);
    const row = index === null ? undefined : players[index];
    if (index !== null && row) {
      const seeded = selfRow(row, contact, division);
      if (seeded.full_name !== row.full_name || seeded.dob !== row.dob || seeded.gender !== row.gender) {
        players = players.map((p, i) => (i === index ? seeded : p));
      }
      // The pick is only claimed for a row that now IS the contact: a name the registrant typed there themselves, and then left
      // unpicked, is somebody else's and stays unpicked.
      if (entry.entrant_kind === "pair" && seeded.full_name.trim() === name) selfIndex = index;
    }
  }

  // The pair's partner: the row that is not the contact's (Player 2 when nobody is registering themselves).
  if (entry.entrant_kind === "pair" && partner) {
    const partnerIndex = entry.registering_self && selfIndex !== null ? (selfIndex === 0 ? 1 : 0) : 1;
    const row = players[partnerIndex];
    if (row && !row.full_name.trim()) {
      players = players.map((p, i) => (i === partnerIndex ? { ...p, full_name: partner } : p));
    }
  }

  return players === entry.players && selfIndex === entry.self_player_index ? entry : { ...entry, players, self_player_index: selfIndex };
}

/**
 * Seeds every entry's roster from the contact (step 1) and the pair partner (step 2). Returns the SAME cart reference when there is
 * nothing to seed, matching every other pure helper in this folder. Called once, when the registrant moves INTO the details step.
 */
export function seedDetailsRows(cart: CartState, contact: ContactState, divisions: readonly SeedDivision[]): CartState {
  const byId = new Map(divisions.map((d) => [d.division_id, d]));
  let changed = false;
  const entries = cart.entries.map((entry) => {
    const next = seedEntry(entry, contact, byId.get(entry.division_id));
    if (next !== entry) changed = true;
    return next;
  });
  return changed ? { ...cart, entries } : cart;
}
