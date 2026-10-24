// What a caught error may put in a log line: its NAME, its SQLSTATE-style CODE and a capped MESSAGE, nothing else.
//
// Never log the error object itself. Where the app's Postgres client (lib/db.ts) runs with `debug` (under vitest only), it attaches
// the failed statement to the error it throws as enumerable `query`, `parameters`, `args` and `types`, and Postgres' own `detail`
// can echo the row in every environment; the logger's serializer strips those (lib/strip-db-echo.ts). Picking three fields out by
// name stays as defence in depth: it drops all of them by construction, whatever the client or the serializer does.
//
// A LEAF: it imports nothing, so any module near the outbox (the dispatcher, the worker, the chess invite's open and resend) can
// use it without closing an import loop.
export type ErrFields = { errName: string; errCode?: unknown; errMessage: string };

export const errFields = (err: unknown): ErrFields => ({
  errName: err instanceof Error ? err.name : typeof err,
  errCode: (err as { code?: unknown } | null)?.code,
  errMessage: (err instanceof Error ? err.message : String(err)).slice(0, 200),
});
