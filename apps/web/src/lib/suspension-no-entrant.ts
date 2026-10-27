// The "no serving entrant" refusal's machine-readable half, said ONCE.
//
// Confirming a suspension stamps the entrant that serves it: the player's
// entrant in the ban's division. A player on no entrant there would go `active`
// with no entrant, and the serving counter (`updateServing`,
// `server/usecases/discipline.ts`) can only count fixtures OF an entrant — so the
// ban could never be served, stayed active for ever, and kept blocking the
// player's lineups. `decideSuspension` therefore refuses that confirm with 422
// and this code, writing nothing.
//
// WHY A LEAF WITH NO IMPORTS, exactly like `schedule-lock.ts` and
// `joint-undo.ts` beside it: the producer is a server usecase (which reaches
// `server-only` through `@/lib/db`) and the consumer is a CLIENT component
// (`components/discipline/discipline-panel.tsx`), which says the refusal from
// its own dictionary instead of painting the server's English sentence. A
// client component that imports from `@/server` breaks the BUILD, so the only
// shape that lets both sides name one constant is a module that imports
// nothing. Adding any import here silently un-shares the constant again.
//
// The SENTENCE deliberately stays server-side, as the fallback for a client
// that does not recognise the code (an API consumer, an older build).

/** `HttpError.code` (422) when a suspension is confirmed for a person who is on
 *  no entrant of the ban's division. */
export const SUSPENSION_NO_ENTRANT_CODE = "SUSPENSION_NO_ENTRANT";
