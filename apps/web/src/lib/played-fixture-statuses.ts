// The refusal a history step answers with when its change would touch a
// PLAYED fixture — client-safe (a leaf, no imports), because the panels read
// it to say the refusal in the reader's own language.
//
// What counts as played is not a status list and does not live here: it is
// rebuild's refusal set, `fixtureHasResultSql`
// (`server/usecases/fixture-results-sql.ts`), SQL over the fixture's status
// AND its recorded evidence (score events, a frozen config, match states,
// reports, marks, suspensions). A start taken back walks the status back to
// `scheduled` and leaves its events behind, so no status test can say it.

/** The /api/v1 error code a history step answers with when it would touch a
 *  played fixture (the engine's results-guard, mapped in history.ts's
 *  `toEngineError`). Clients say the refusal in the reader's own language off
 *  this CODE — the server's sentence is English prose. */
export const PLAYED_REFUSAL_CODE = "ALREADY_DECIDED";
