// What a caught error may put in a log line: its NAME, its SQLSTATE-style CODE and a capped MESSAGE, nothing else.
//
// Never log the error object itself. The app's Postgres client (lib/db.ts) attaches the failed statement to the error it throws,
// as enumerable `query`, `parameters`, `args` and `types`, so a raw `{ err }` writes the recipient's address, the subject and the
// sealed body bytes of an outbox insert into the logs (and the log forwarder carries them on). Picking three fields out by name
// drops all of those by construction.
//
// A LEAF: it imports nothing, so any module near the outbox (the dispatcher, the worker, the chess invite's open and resend) can
// use it without closing an import loop.
export type ErrFields = { errName: string; errCode?: unknown; errMessage: string };

export const errFields = (err: unknown): ErrFields => ({
  errName: err instanceof Error ? err.name : typeof err,
  errCode: (err as { code?: unknown } | null)?.code,
  errMessage: (err instanceof Error ? err.message : String(err)).slice(0, 200),
});
