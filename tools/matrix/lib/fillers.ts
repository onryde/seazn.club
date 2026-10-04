// The setup-filler names (ruling 47), a leaf: results.ts reads them for its
// strict `fillers` schema, and the driver's ledger (driver/mixed.ts) counts
// against them. They live here because driver/mixed.ts imports results.ts (the
// CheckResult type), so results.ts importing mixed.ts would close a cycle;
// mixed.ts re-exports both names, so no other importer changes.

/** Ruling 47: setup filler — HTTP by design in every layer, never an organiser
 *  action type (no browser turn is owed), recorded so a report shows it ran. */
export const FILLER = ["setMembers", "putLineup", "entrantMembers", "confirmSeedProposal", "recomputeSeedProposal", "challenge", "americanoView"] as const;
export type FillerName = (typeof FILLER)[number];
