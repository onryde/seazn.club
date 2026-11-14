// Polish wave P4 (walkthrough W1, W3) — what the DETAILS step starts with, from what steps 1 and 2 already collected (pure, no DOM).
//
// Before this, a registrant who typed their name on step 1 and ticked "I'm registering myself" met an empty Player 1 and typed the name a
// second time; a partner typed on step 2 ("Add a pair") met an empty Player 2. The rule is ONE-WAY: a row is filled while its name is
// empty, and a second call is a no-op that returns the SAME reference.
//
// Registration redesign B2 T10 widened "blank-only" to "blank, or still what Contact last gave it". Details shows the contact's own row
// read-only as "That's you" while its name matches Contact (roster.ts contactRowIndex), so a registrant who goes Back and renames
// themselves must find Player 1 renamed too, not locked on the old name. What decides it is `CartEntry.seeded_from`: the values this
// module last wrote into the entry's contact row. A row that still holds exactly that follows Contact; a row the registrant typed over
// ("Amelia" over "Mia") differs from it and is never overwritten, by a rename or by anything else. A pair's partner row is not Contact's
// and stays blank-only.
import { resolveSelfPlayerIndex } from "./roster";
import { EMPTY_ROSTER_PLAYER, type CartEntry, type CartState, type ContactState, type DivisionLike, type RosterPlayerState, type SeededFromContact } from "./types";

type SeedDivision = Pick<DivisionLike, "division_id" | "requires_dob" | "requires_gender">;

/** One field of the contact's row on one pass: `value` is what the row holds after it, `basis` what Contact has now given it (undefined =
 *  never given). Five cases, in order:
 *   - Contact has nothing to give (blank): nothing moves.
 *   - the row is blank: it takes Contact's value (the original blank-only seed).
 *   - the row holds what Contact LAST gave it (`basis`): untouched since, so it follows Contact. This is the rename.
 *   - the row already equals Contact's value: indistinguishable from a seed, so it is recorded as one (a draft saved before the record
 *     existed starts following here).
 *   - anything else is the registrant's own: kept, and the record is kept as it was. */
function seedField<T extends string>(row: T | null, basis: T | undefined, contact: T | null): { value: T | null; basis: T | undefined } {
  const has = (v: T | null): v is T => v !== null && v !== "";
  if (!has(contact)) return { value: row, basis };
  if (!has(row)) return { value: contact, basis: contact };
  if (basis !== undefined && row === basis) return { value: contact, basis: contact };
  if (row === contact) return { value: row, basis: contact };
  return { value: row, basis };
}

function packBasis(name: string | undefined, dob: string | undefined, gender: SeededFromContact["gender"]): SeededFromContact | undefined {
  if (name === undefined && dob === undefined && gender === undefined) return undefined;
  return { ...(name !== undefined && { name }), ...(dob !== undefined && { dob }), ...(gender !== undefined && { gender }) };
}

function sameBasis(a: SeededFromContact | undefined, b: SeededFromContact | undefined): boolean {
  return a?.name === b?.name && a?.dob === b?.dob && a?.gender === b?.gender;
}

/** The contact's own row: name always; dob/gender only when the division asks for them (the row shows those inputs only then, and a
 *  visible empty required field beside an answer the registrant already gave is the friction this removes). Each field follows Contact
 *  by `seedField`'s rules. Returns the SAME row object when nothing changed, and the record to keep on the entry. */
function selfRow(
  row: RosterPlayerState,
  contact: ContactState,
  division: SeedDivision | undefined,
  basis: SeededFromContact | undefined,
): { row: RosterPlayerState; basis: SeededFromContact | undefined } {
  const name = seedField(row.full_name.trim(), basis?.name, contact.name.trim());
  const dob = division?.requires_dob ? seedField(row.dob, basis?.dob, contact.dob) : { value: row.dob, basis: basis?.dob };
  const gender = division?.requires_gender ? seedField(row.gender, basis?.gender, contact.gender) : { value: row.gender, basis: basis?.gender };
  // A row's own spacing is kept when its trimmed value is what the pass settled on; only a written value replaces it.
  const full_name = name.value === row.full_name.trim() ? row.full_name : (name.value ?? "");
  const unchanged = full_name === row.full_name && dob.value === row.dob && gender.value === row.gender;
  return {
    row: unchanged ? row : { ...row, full_name, dob: dob.value, gender: gender.value },
    basis: packBasis(name.basis, dob.basis, gender.basis),
  };
}

function seedEntry(entry: CartEntry, contact: ContactState, division: SeedDivision | undefined): CartEntry {
  // Polish wave P5 (H-1): a solo sign-up is the registrant looking for a team - its ONE row is theirs, seeded like any self row
  // (`selfRow`: filled while blank, and following a Contact rename while it still holds what was seeded, never a hand-edited value).
  // A solo saved before the form collected its player has no row: it gets one here.
  if (entry.free_agent) {
    const row = entry.players[0] ?? { ...EMPTY_ROSTER_PLAYER };
    const seeded = selfRow(row, contact, division, entry.seeded_from);
    const same = entry.players.length === 1 && seeded.row === row && sameBasis(seeded.basis, entry.seeded_from);
    return same ? entry : { ...entry, players: [seeded.row], seeded_from: seeded.basis };
  }
  // A TEAM roster starts EMPTY by design (cart.ts's blankPlayers) and the captain builds it with "+ Add player"; a BLANK seeded row
  // would trail behind every captain who then adds their own (a blank row blocks Next). But a captain who is playing is Player 1
  // (polish wave sign-off V1): an empty roster on a self-linked team starts with the contact's own row, named and picked as theirs,
  // so it neither blocks Next nor asks them to type themselves in. A roster that already has rows is the captain's own work and is left
  // alone, with one exception (B2 T10): the row THIS function seeded, while it still holds what it seeded, follows a Contact rename. A
  // roster with no record (the captain built it) never follows, and a seeded row the captain blanked is theirs to retype. A solo
  // (free agent) sign-up is a team-kind entry handled above (P5 H-1: it carries its one row).
  if (entry.entrant_kind === "team") {
    const name = contact.name.trim();
    if (!entry.registering_self || !name) return entry;
    if (entry.players.length === 0) {
      const seeded = selfRow({ ...EMPTY_ROSTER_PLAYER }, contact, division, undefined);
      return { ...entry, players: [seeded.row], self_player_index: 0, seeded_from: seeded.basis };
    }
    const index = resolveSelfPlayerIndex(entry);
    const row = index === null ? undefined : entry.players[index];
    if (entry.seeded_from === undefined || index === null || row === undefined || row.full_name.trim() === "") return entry;
    const seeded = selfRow(row, contact, division, entry.seeded_from);
    if (seeded.row === row && sameBasis(seeded.basis, entry.seeded_from)) return entry;
    return { ...entry, players: entry.players.map((p, i) => (i === index ? seeded.row : p)), seeded_from: seeded.basis };
  }
  const name = contact.name.trim();
  const partner = entry.partner_name?.trim() ?? "";
  let players = entry.players;
  let selfIndex = entry.self_player_index;
  let basis = entry.seeded_from;

  // Which row is the contact, when the contact is on this entry. Individual implies row 0 (cart.ts's toGroupEntry); a pair defaults to
  // Player 1 (the partner field is Player 2 - roster-table.tsx's rowLabel).
  if (entry.registering_self && name) {
    const index = entry.entrant_kind === "pair" ? (selfIndex ?? 0) : resolveSelfPlayerIndex(entry);
    const row = index === null ? undefined : players[index];
    if (index !== null && row) {
      const seeded = selfRow(row, contact, division, entry.seeded_from);
      if (seeded.row !== row) players = players.map((p, i) => (i === index ? seeded.row : p));
      basis = seeded.basis;
      // The pick is only claimed for a row that now IS the contact: a name the registrant typed there themselves, and then left
      // unpicked, is somebody else's and stays unpicked.
      if (entry.entrant_kind === "pair" && seeded.row.full_name.trim() === name) selfIndex = index;
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

  return players === entry.players && selfIndex === entry.self_player_index && sameBasis(basis, entry.seeded_from)
    ? entry
    : { ...entry, players, self_player_index: selfIndex, seeded_from: basis };
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
