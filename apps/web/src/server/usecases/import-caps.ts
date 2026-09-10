/**
 * Ceilings for `POST /event-imports`, in a module that ANY consumer can import.
 *
 * This lives apart from `event-import.ts` for one reason: that file opens with
 * `import "server-only"`, which is a webpack alias with no package behind it.
 * Outside Next's build it does not resolve, so every script, worker and test
 * harness in this repo — `scripts/bench` included — could not import the caps
 * it has to respect. The bench's answer was a hand-written mirror plus a guard
 * that read `event-import.ts` as TEXT and regex-matched the literal out of it,
 * which is a drift check that a reformat of that one line silently breaks.
 *
 * Nothing here may import `server-only`, a `next/*` module, or anything that
 * transitively does. It is plain data on purpose. `event-import.ts` re-exports
 * it, so existing importers are unaffected.
 *
 * R4 — see the design doc §6 "Why the caps are what they are": appendEventInTx
 * re-reads and re-folds the whole prior stream on every append (O(n^2) per
 * fixture), so a single huge stream is a hung request, not a rejection.
 */
export const IMPORT_CAPS = { streams: 50, eventsPerFixture: 1_000, eventsPerCall: 10_000 } as const;
